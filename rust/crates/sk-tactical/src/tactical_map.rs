//! Перенос `server/tactical-map.mjs`: контракт тактической карты. Клетки
//! хранятся типизированными слоями (битсеты и байтовые слои), стены живут на
//! рёбрах, предметы отвязаны от клетки (`docs/tactical-map-plan.md`, 4 и 5).
//!
//! Модуль не знает ни о состоянии кампании, ни о событиях, ни о генераторе:
//! он описывает данные, умеет обходить карту, проверять её и превращать в
//! старый разреженный массив клеток и обратно без потерь.
//!
//! Внутри — типизированная [`TacticalMap`]; на границе — тот же JSON, что у
//! JS: [`serialize_tactical_map`] даёт объект, совпадающий с
//! `serializeTacticalMap` байт в байт через `js::stringify` (по нему считается
//! адрес карты в хранилище), [`deserialize_tactical_map`] читает любой
//! сохранённый вид. Входы, которые в JS приходят рыхлыми объектами (предмет,
//! дверь, зона, точка появления), принимаются как `serde_json::Value` той же
//! формы; частые правки клетки и ребра — типизированными заплатками
//! [`CellPatch`] и [`EdgePatch`] (для рыхлого входа — `*_json`).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::hash::{BuildHasherDefault, Hasher};

use serde_json::{Map, Value};
use sk_core::indexmap::IndexSet;
use sk_core::{hash, js, text, Point};
use sk_scene_base::asset_registry::asset_by_id;
use sk_scene_base::environment_catalog_revision::{current_environment_catalog_revision, is_safe_catalog_revision_str};

use crate::scene_interactions::{interaction_metadata_for_prop, scene_interaction_metadata_for_refs, PropRef};

pub const TACTICAL_MAP_VERSION: &str = "skazanie:tactical-map-v1";

/// Порядок значений — часть формата хранения: код равен индексу.
pub const SURFACES: [&str; 6] = ["none", "water", "ice", "oil", "mud", "rubble"];
pub const MATERIALS: [&str; 8] = ["stone", "wood", "earth", "grass", "sand", "marble", "metal", "ice"];
pub const EDGE_KINDS: [&str; 8] = ["none", "wall", "door", "window", "rail", "ledge", "loophole", "grate"];
pub const COVER_LEVELS: [&str; 3] = ["none", "half", "three_quarters"];
pub const DOOR_STATES: [&str; 4] = ["open", "closed", "locked", "broken"];
pub const ZONE_KINDS: [&str; 2] = ["interior", "exterior"];
pub const FLOOR_DIRECTIONS: [&str; 2] = ["horizontal", "vertical"];
pub const SPAWN_ROLES: [&str; 3] = ["party", "enemy", "neutral"];
/// Рисунок пола помещения (`zone.floor`) — только фактура отрисовки.
pub const FLOOR_STYLES: [&str; 14] =
    ["planks-dark", "parquet", "flagstone", "checker", "dungeon", "mosaic", "cobble", "straw", "dock", "gravel", "cave", "snow", "river", "shallows"];
/// Вид кладки стен помещения (`zone.wall`) — только для отрисовки.
pub const WALL_STYLES: [&str; 5] = ["brick", "fachwerk", "fortress", "palisade", "embankment"];
/// Биомы окрестностей 3D-доски за краем карты.
pub const SURROUNDINGS_BIOMES: [&str; 6] = ["forest", "deadwood", "meadow", "mountain", "rock", "sea"];
/// Насколько далеко от этажа входа может уводить переход.
pub const MAX_LEVEL_OFFSET: i64 = 3;
/// Сколько вариантов пола раскидывается по карте.
pub const FLOOR_VARIANTS: u32 = 4;
/// Стороны, с которых отряд входит на карту.
pub const ENTRY_SIDES: [&str; 4] = ["west", "east", "north", "south"];

/// Класс размера карты (`SIZE_CLASSES`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SizeClass {
    pub max_width: i64,
    pub max_height: i64,
    pub max_cells: i64,
    pub max_props: i64,
    pub max_wall_edges: i64,
}

/// Классы размеров в порядке объекта JS (`arena`, `area`, `region`).
pub const SIZE_CLASSES: [(&str, SizeClass); 3] = [
    ("arena", SizeClass { max_width: 30, max_height: 30, max_cells: 900, max_props: 250, max_wall_edges: 900 }),
    ("area", SizeClass { max_width: 60, max_height: 60, max_cells: 3_600, max_props: 800, max_wall_edges: 3_600 }),
    ("region", SizeClass { max_width: 100, max_height: 100, max_cells: 10_000, max_props: 2_000, max_wall_edges: 10_000 }),
];

const REGION: SizeClass = SIZE_CLASSES[2].1;

/// Класс размера по имени.
pub fn size_class(name: &str) -> Option<SizeClass> {
    SIZE_CLASSES.iter().find(|(key, _)| *key == name).map(|(_, limits)| *limits)
}

/// `ownEntry(SIZE_CLASSES, key)` истинно: известный класс.
fn size_class_key_truthy(key: &str) -> bool {
    size_class(key).is_some()
}

/// Паттерны старого генератора — для обратного преобразования.
const LEGACY_PATTERNS: [&str; 9] = ["small-room", "great-hall", "keep", "courtyard", "crypt", "cave-cluster", "village", "bridge", "natural"];

/// Необязательные поля старой клетки.
const LEGACY_OPTIONAL_FIELDS: [&str; 4] = ["material", "variant", "pattern", "edge_mask"];

const TRANSITION_ASSETS: [&str; 3] = ["stairs_up", "stairs_down", "trapdoor"];
const TRANSITION_ASSETS_UP: [&str; 1] = ["stairs_up"];
const TRANSITION_ASSETS_DOWN: [&str; 2] = ["stairs_down", "trapdoor"];
const LEGACY_WALKABLE: [&str; 2] = ["floor", "door"];

// --- ошибка ---------------------------------------------------------------

/// Отказ карты (`TacticalMapError`). Сбой чтения рыхлого входа, на котором
/// JS бросил бы `TypeError` (`null` вместо объекта), — тот же тип с именем
/// `TypeError` и кодом `TYPE_ERROR`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TacticalMapError {
    pub name: &'static str,
    pub code: String,
    pub message: String,
}

impl TacticalMapError {
    pub const NAME: &'static str = "TacticalMapError";

    pub fn new(message: impl Into<String>, code: impl Into<String>) -> Self {
        Self { name: Self::NAME, code: code.into(), message: message.into() }
    }

    fn type_error(message: impl Into<String>) -> Self {
        Self { name: "TypeError", code: "TYPE_ERROR".into(), message: message.into() }
    }
}

impl fmt::Display for TacticalMapError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for TacticalMapError {}

pub type MapResult<T> = Result<T, TacticalMapError>;

// --- перечисления ---------------------------------------------------------

/// Направление ребра: восток или юг клетки-владельца.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum EdgeDir {
    E,
    S,
}

impl EdgeDir {
    pub fn as_str(self) -> &'static str {
        match self {
            EdgeDir::E => "e",
            EdgeDir::S => "s",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "e" => Some(EdgeDir::E),
            "s" => Some(EdgeDir::S),
            _ => None,
        }
    }
}

/// Вид ребра (`EDGE_KINDS`); код — индекс.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum EdgeKind {
    None,
    Wall,
    Door,
    Window,
    Rail,
    Ledge,
    Loophole,
    Grate,
}

impl EdgeKind {
    const ALL: [EdgeKind; 8] =
        [EdgeKind::None, EdgeKind::Wall, EdgeKind::Door, EdgeKind::Window, EdgeKind::Rail, EdgeKind::Ledge, EdgeKind::Loophole, EdgeKind::Grate];

    pub fn as_str(self) -> &'static str {
        EDGE_KINDS[self.code() as usize]
    }

    pub fn code(self) -> u8 {
        self as u8
    }

    pub fn from_code(code: u8) -> Option<Self> {
        Self::ALL.get(code as usize).copied()
    }

    pub fn parse(value: &str) -> Option<Self> {
        EDGE_KINDS.iter().position(|kind| *kind == value).and_then(|code| Self::from_code(code as u8))
    }
}

/// Укрытие (`COVER_LEVELS`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default)]
pub enum Cover {
    #[default]
    None,
    Half,
    ThreeQuarters,
}

impl Cover {
    pub fn as_str(self) -> &'static str {
        COVER_LEVELS[self.code() as usize]
    }

    pub fn code(self) -> u8 {
        self as u8
    }

    pub fn from_code(code: u8) -> Option<Self> {
        [Cover::None, Cover::Half, Cover::ThreeQuarters].get(code as usize).copied()
    }

    pub fn parse(value: &str) -> Option<Self> {
        COVER_LEVELS.iter().position(|cover| *cover == value).and_then(|code| Self::from_code(code as u8))
    }
}

// --- записи карты ---------------------------------------------------------

/// Логическая клетка (`cellAt`). Строки заимствуются у карты.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TacticalCell<'a> {
    pub x: i64,
    pub y: i64,
    pub passable: bool,
    /// 1 или 2; 2 — труднопроходимая местность.
    pub move_cost: u8,
    pub surface: &'static str,
    pub hazard_id: Option<&'a str>,
    pub material: &'static str,
    /// Высота клетки в футах, знаковая.
    pub elevation: i64,
    /// Id зоны; пустая строка — зоны нет.
    pub zone: &'a str,
    pub variant: u8,
    pub revealed: bool,
}

impl TacticalCell<'_> {
    /// Форма JS: `{ x, y, passable, moveCost, surface, hazardId, material, elevation, zone, variant, revealed }`.
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("x".into(), Value::from(self.x));
        object.insert("y".into(), Value::from(self.y));
        object.insert("passable".into(), Value::Bool(self.passable));
        object.insert("moveCost".into(), Value::from(self.move_cost));
        object.insert("surface".into(), Value::String(self.surface.into()));
        object.insert("hazardId".into(), self.hazard_id.map_or(Value::Null, |id| Value::String(id.into())));
        object.insert("material".into(), Value::String(self.material.into()));
        object.insert("elevation".into(), Value::from(self.elevation));
        object.insert("zone".into(), Value::String(self.zone.into()));
        object.insert("variant".into(), Value::from(self.variant));
        object.insert("revealed".into(), Value::Bool(self.revealed));
        Value::Object(object)
    }
}

/// Слои карты (`TacticalLayers`): битсеты `present`, `passable`, `revealed`
/// и по байту на клетку для остальных; `zone_id` — индекс в `zones` со
/// сдвигом на единицу (0 — зоны нет).
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct TacticalLayers {
    pub present: Vec<u8>,
    pub passable: Vec<u8>,
    pub revealed: Vec<u8>,
    pub move_cost: Vec<u8>,
    pub surface: Vec<u8>,
    pub material: Vec<u8>,
    pub variant: Vec<u8>,
    pub elevation: Vec<i8>,
    pub zone_id: Vec<u8>,
}

/// Ребро (`TacticalEdge`); в хранилище никогда не `none`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TacticalEdge {
    pub x: i64,
    pub y: i64,
    pub dir: EdgeDir,
    pub kind: EdgeKind,
    pub blocks_move: bool,
    pub blocks_sight: bool,
    pub cover: Cover,
    pub door_id: Option<String>,
}

impl TacticalEdge {
    /// Форма JS: `{ x, y, dir, kind, blocksMove, blocksSight, cover, doorId }`.
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("x".into(), Value::from(self.x));
        object.insert("y".into(), Value::from(self.y));
        object.insert("dir".into(), Value::String(self.dir.as_str().into()));
        object.insert("kind".into(), Value::String(self.kind.as_str().into()));
        object.insert("blocksMove".into(), Value::Bool(self.blocks_move));
        object.insert("blocksSight".into(), Value::Bool(self.blocks_sight));
        object.insert("cover".into(), Value::String(self.cover.as_str().into()));
        object.insert("doorId".into(), self.door_id.as_ref().map_or(Value::Null, |id| Value::String(id.clone())));
        Value::Object(object)
    }
}

/// Баррикада двери.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Barricade {
    pub material_item_id: String,
    pub actor_id: String,
    pub previous_state: String,
    pub side_x: i64,
    pub side_y: i64,
}

impl Barricade {
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("material_item_id".into(), Value::String(self.material_item_id.clone()));
        object.insert("actor_id".into(), Value::String(self.actor_id.clone()));
        object.insert("previous_state".into(), Value::String(self.previous_state.clone()));
        object.insert("side_x".into(), Value::from(self.side_x));
        object.insert("side_y".into(), Value::from(self.side_y));
        Value::Object(object)
    }
}

/// Дверь (`TacticalDoor`); `state` — начальное состояние.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TacticalDoor {
    pub id: String,
    pub x: i64,
    pub y: i64,
    pub dir: EdgeDir,
    pub state: String,
    pub lock_dc: i64,
    pub key_item_id: Option<String>,
    /// `None` — ключа `barricade` нет вовсе; `Some(None)` — `barricade: null`.
    pub barricade: Option<Option<Barricade>>,
}

impl TacticalDoor {
    /// Баррикада, если она стоит.
    pub fn barricade(&self) -> Option<&Barricade> {
        self.barricade.as_ref().and_then(Option::as_ref)
    }

    /// Форма JS (`{ ...door }`): `{ id, x, y, dir, state, lockDc, keyItemId, barricade? }`.
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("id".into(), Value::String(self.id.clone()));
        object.insert("x".into(), Value::from(self.x));
        object.insert("y".into(), Value::from(self.y));
        object.insert("dir".into(), Value::String(self.dir.as_str().into()));
        object.insert("state".into(), Value::String(self.state.clone()));
        object.insert("lockDc".into(), Value::from(self.lock_dc));
        object.insert("keyItemId".into(), self.key_item_id.as_ref().map_or(Value::Null, |id| Value::String(id.clone())));
        if let Some(barricade) = &self.barricade {
            object.insert("barricade".into(), barricade.as_ref().map_or(Value::Null, Barricade::to_json));
        }
        Value::Object(object)
    }
}

/// Визуальная опора предмета, без изменения проходимости.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PropMount {
    Surface { prop_id: String },
    /// Сторона стены: `n`, `e`, `s` или `w`.
    Wall { side: &'static str },
}

impl PropMount {
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        match self {
            PropMount::Surface { prop_id } => {
                object.insert("kind".into(), Value::String("surface".into()));
                object.insert("propId".into(), Value::String(prop_id.clone()));
            }
            PropMount::Wall { side } => {
                object.insert("kind".into(), Value::String("wall".into()));
                object.insert("side".into(), Value::String((*side).into()));
            }
        }
        Value::Object(object)
    }
}

/// Взаимодействие предмета. `detail_key`/`reward_key` — `None`, когда их
/// убрала проекция для игрока (в JS — `undefined`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PropInteraction {
    pub kind: String,
    pub verbs: Vec<String>,
    pub point_of_interest: bool,
    pub detail_key: Option<String>,
    pub reward_key: Option<String>,
}

impl PropInteraction {
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("kind".into(), Value::String(self.kind.clone()));
        object.insert("verbs".into(), js::strings_value(self.verbs.iter().cloned()));
        object.insert("pointOfInterest".into(), Value::Bool(self.point_of_interest));
        if let Some(key) = &self.detail_key {
            object.insert("detailKey".into(), Value::String(key.clone()));
        }
        if let Some(key) = &self.reward_key {
            object.insert("rewardKey".into(), Value::String(key.clone()));
        }
        Value::Object(object)
    }
}

/// Переход на другой этаж.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PropTransition {
    pub to_level: i64,
    pub label: String,
}

impl PropTransition {
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("toLevel".into(), Value::from(self.to_level));
        object.insert("label".into(), Value::String(self.label.clone()));
        Value::Object(object)
    }
}

/// Предмет (`TacticalProp`); координаты дробные, в клетках.
#[derive(Clone, Debug, PartialEq)]
pub struct TacticalProp {
    pub id: String,
    pub asset_id: String,
    pub x: f64,
    pub y: f64,
    /// Градусы.
    pub rotation: f64,
    pub scale: f64,
    /// Занимаемые клетки, может быть пустым.
    pub footprint: Vec<Point>,
    pub z_order: i64,
    pub mount: Option<PropMount>,
    pub blocks_move: bool,
    pub blocks_sight: bool,
    pub cover: Cover,
    pub destructible: bool,
    pub hp: i64,
    pub interactive: bool,
    pub state: String,
    pub interaction: Option<PropInteraction>,
    pub transition: Option<PropTransition>,
}

impl TacticalProp {
    /// Полная запись в форме JS (как `JSON.stringify(prop)`).
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("id".into(), Value::String(self.id.clone()));
        object.insert("assetId".into(), Value::String(self.asset_id.clone()));
        object.insert("x".into(), js::num(self.x));
        object.insert("y".into(), js::num(self.y));
        object.insert("rotation".into(), js::num(self.rotation));
        object.insert("scale".into(), js::num(self.scale));
        object.insert("footprint".into(), points_json(&self.footprint));
        object.insert("zOrder".into(), Value::from(self.z_order));
        if let Some(mount) = &self.mount {
            object.insert("mount".into(), mount.to_json());
        }
        object.insert("blocksMove".into(), Value::Bool(self.blocks_move));
        object.insert("blocksSight".into(), Value::Bool(self.blocks_sight));
        object.insert("cover".into(), Value::String(self.cover.as_str().into()));
        object.insert("destructible".into(), Value::Bool(self.destructible));
        object.insert("hp".into(), Value::from(self.hp));
        object.insert("interactive".into(), Value::Bool(self.interactive));
        object.insert("state".into(), Value::String(self.state.clone()));
        object.insert("interaction".into(), self.interaction.as_ref().map_or(Value::Null, PropInteraction::to_json));
        object.insert("transition".into(), self.transition.as_ref().map_or(Value::Null, PropTransition::to_json));
        Value::Object(object)
    }
}

fn point_json(point: Point) -> Value {
    let mut object = Map::new();
    object.insert("x".into(), Value::from(point.x));
    object.insert("y".into(), Value::from(point.y));
    Value::Object(object)
}

fn points_json(points: &[Point]) -> Value {
    Value::Array(points.iter().map(|point| point_json(*point)).collect())
}

/// Зона (`TacticalZone`). Необязательные `floor` и `wall` хранятся в порядке
/// появления ключей: генератор ставит кладку раньше пола, и объект JS пишет
/// их именно в этом порядке.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TacticalZone {
    pub id: String,
    pub kind: String,
    pub material: String,
    pub light_level: String,
    pub floor_direction: String,
    pub label: String,
    pub styles: Vec<(&'static str, String)>,
}

impl TacticalZone {
    fn style(&self, key: &str) -> Option<&str> {
        self.styles.iter().find(|(name, _)| *name == key).map(|(_, value)| value.as_str())
    }

    fn set_style(&mut self, key: &'static str, value: Option<String>) {
        match value {
            Some(value) => match self.styles.iter_mut().find(|(name, _)| *name == key) {
                Some(entry) => entry.1 = value,
                None => self.styles.push((key, value)),
            },
            None => self.styles.retain(|(name, _)| *name != key),
        }
    }

    /// Рисунок пола (`zone.floor`).
    pub fn floor(&self) -> Option<&str> {
        self.style("floor")
    }

    /// Вид кладки (`zone.wall`).
    pub fn wall(&self) -> Option<&str> {
        self.style("wall")
    }

    /// `zone.floor = value` (новый ключ встаёт в конец) или `delete zone.floor`.
    pub fn set_floor(&mut self, value: Option<String>) {
        self.set_style("floor", value);
    }

    /// `zone.wall = value` или `delete zone.wall`.
    pub fn set_wall(&mut self, value: Option<String>) {
        self.set_style("wall", value);
    }

    /// Форма JS (`{ ...zone }`).
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("id".into(), Value::String(self.id.clone()));
        object.insert("kind".into(), Value::String(self.kind.clone()));
        object.insert("material".into(), Value::String(self.material.clone()));
        object.insert("lightLevel".into(), Value::String(self.light_level.clone()));
        object.insert("floorDirection".into(), Value::String(self.floor_direction.clone()));
        object.insert("label".into(), Value::String(self.label.clone()));
        for (key, value) in &self.styles {
            object.insert((*key).into(), Value::String(value.clone()));
        }
        Value::Object(object)
    }
}

/// Точка появления.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TacticalSpawnPoint {
    pub id: String,
    pub x: i64,
    pub y: i64,
    pub role: String,
}

impl TacticalSpawnPoint {
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("id".into(), Value::String(self.id.clone()));
        object.insert("x".into(), Value::from(self.x));
        object.insert("y".into(), Value::from(self.y));
        object.insert("role".into(), Value::String(self.role.clone()));
        Value::Object(object)
    }
}

/// Прямоугольник клеток (`TacticalBounds`), включительно.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bounds {
    pub min_x: i64,
    pub min_y: i64,
    pub max_x: i64,
    pub max_y: i64,
}

impl Bounds {
    /// Пустой охват `{ minX: 0, minY: 0, maxX: -1, maxY: -1 }`.
    pub const EMPTY: Bounds = Bounds { min_x: 0, min_y: 0, max_x: -1, max_y: -1 };

    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("minX".into(), Value::from(self.min_x));
        object.insert("minY".into(), Value::from(self.min_y));
        object.insert("maxX".into(), Value::from(self.max_x));
        object.insert("maxY".into(), Value::from(self.max_y));
        Value::Object(object)
    }
}

/// Генератор, построивший карту.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Generator {
    pub id: String,
    pub version: String,
}

/// Подпись помещения на карте.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoomLabel {
    pub zone_id: String,
    pub label: String,
}

/// Наложения отрисовки.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Overlays {
    pub compass: bool,
    pub scale_bar: bool,
    pub room_labels: Vec<RoomLabel>,
}

impl Overlays {
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("compass".into(), Value::Bool(self.compass));
        object.insert("scaleBar".into(), Value::Bool(self.scale_bar));
        let labels = self
            .room_labels
            .iter()
            .map(|label| {
                let mut entry = Map::new();
                entry.insert("zoneId".into(), Value::String(label.zone_id.clone()));
                entry.insert("label".into(), Value::String(label.label.clone()));
                Value::Object(entry)
            })
            .collect();
        object.insert("roomLabels".into(), Value::Array(labels));
        Value::Object(object)
    }
}

/// Окрестности карты — какой край мира виден за её границей (только 3D).
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Surroundings {
    pub biome: Option<String>,
    /// По сторонам света в порядке ключей объекта; `None` — ключа нет.
    pub sides: Option<Vec<(String, String)>>,
}

impl Surroundings {
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        if let Some(biome) = &self.biome {
            object.insert("biome".into(), Value::String(biome.clone()));
        }
        if let Some(sides) = &self.sides {
            object.insert("sides".into(), Value::Object(sides.iter().map(|(side, biome)| (side.clone(), Value::String(biome.clone()))).collect()));
        }
        Value::Object(object)
    }
}

/// Опасности клеток: индекс клетки → id опасности. Ключи-индексы хранятся
/// числом (поиск клетки без строки), прочие ключи старой записи — в порядке
/// вставки; в JSON — порядок объекта JS (индексы первыми, по возрастанию).
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Hazards {
    cells: BTreeMap<u32, String>,
    named: Vec<(String, String)>,
}

fn index_key(key: &str) -> Option<u32> {
    js::is_array_index_key(key).then(|| key.parse::<u32>().ok()).flatten()
}

impl Hazards {
    /// Опасность клетки с индексом `index`.
    pub fn get_cell(&self, index: usize) -> Option<&str> {
        if self.cells.is_empty() {
            return None;
        }
        u32::try_from(index).ok().and_then(|index| self.cells.get(&index)).map(String::as_str)
    }

    /// Опасность по ключу объекта (`map.hazards[key]`).
    pub fn get(&self, key: &str) -> Option<&str> {
        match index_key(key) {
            Some(index) => self.cells.get(&index).map(String::as_str),
            None => self.named.iter().find(|(name, _)| name == key).map(|(_, value)| value.as_str()),
        }
    }

    /// `map.hazards[key] = value`. Ключ `__proto__` со строкой JS молча
    /// пропускает (это сеттер прототипа), здесь — так же.
    pub fn insert(&mut self, key: &str, value: String) {
        if key == "__proto__" {
            return;
        }
        match index_key(key) {
            Some(index) => {
                self.cells.insert(index, value);
            }
            None => match self.named.iter_mut().find(|(name, _)| name == key) {
                Some(entry) => entry.1 = value,
                None => self.named.push((key.to_string(), value)),
            },
        }
    }

    /// `delete map.hazards[key]`.
    pub fn remove(&mut self, key: &str) {
        match index_key(key) {
            Some(index) => {
                self.cells.remove(&index);
            }
            None => self.named.retain(|(name, _)| name != key),
        }
    }

    pub fn len(&self) -> usize {
        self.cells.len() + self.named.len()
    }

    pub fn is_empty(&self) -> bool {
        self.cells.is_empty() && self.named.is_empty()
    }

    /// Пары в порядке `Object.entries`.
    pub fn entries(&self) -> Vec<(String, &str)> {
        self.cells.iter().map(|(index, value)| (index.to_string(), value.as_str())).chain(self.named.iter().map(|(key, value)| (key.clone(), value.as_str()))).collect()
    }

    /// Оставить только опасности, для которых `keep(ключ, значение)` истинно.
    pub fn retain(&mut self, mut keep: impl FnMut(&str, &str) -> bool) {
        self.cells.retain(|index, value| keep(&index.to_string(), value));
        self.named.retain(|(key, value)| keep(key, value));
    }

    /// Форма JS (`{ ...map.hazards }`).
    pub fn to_json(&self) -> Value {
        Value::Object(self.entries().into_iter().map(|(key, value)| (key, Value::String(value.to_string()))).collect())
    }
}

// --- хранилище рёбер --------------------------------------------------------

/// Перемешиватель FxHash: ключи рёбер — три маленьких числа, SipHash на них
/// стоит дороже самого поиска.
#[derive(Default)]
struct FxHasher {
    hash: u64,
}

impl FxHasher {
    fn add(&mut self, word: u64) {
        self.hash = (self.hash.rotate_left(5) ^ word).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
}

impl Hasher for FxHasher {
    fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.add(u64::from(*byte));
        }
    }

    fn write_u8(&mut self, value: u8) {
        self.add(u64::from(value));
    }

    fn write_u32(&mut self, value: u32) {
        self.add(u64::from(value));
    }

    fn write_u64(&mut self, value: u64) {
        self.add(value);
    }

    fn write_i64(&mut self, value: i64) {
        self.add(value as u64);
    }

    fn write_usize(&mut self, value: usize) {
        self.add(value as u64);
    }

    fn write_isize(&mut self, value: isize) {
        self.add(value as u64);
    }

    fn finish(&self) -> u64 {
        self.hash
    }
}

type EdgeKey = (i64, i64, EdgeDir);
type EdgeMap = HashMap<EdgeKey, TacticalEdge, BuildHasherDefault<FxHasher>>;

// --- карта ----------------------------------------------------------------

/// Тактическая карта (`TacticalMap`).
#[derive(Clone, Debug, PartialEq)]
pub struct TacticalMap {
    pub version: String,
    pub location_id: String,
    /// Выпуск каталога окружения; `None` — поля нет (legacy-конверсия).
    pub catalog_revision: Option<String>,
    /// Этаж карты: 0 — вход, +1 вверх, −1 подвал.
    pub level_index: i64,
    pub level_label: String,
    pub seed: String,
    pub generator: Generator,
    pub width: i64,
    pub height: i64,
    /// Охват существующих клеток.
    pub bounds: Bounds,
    pub layers: TacticalLayers,
    pub hazards: Hazards,
    edges: EdgeMap,
    pub doors: Vec<TacticalDoor>,
    pub props: Vec<TacticalProp>,
    pub zones: Vec<TacticalZone>,
    pub spawn_points: Vec<TacticalSpawnPoint>,
    pub combat_bounds: Option<Bounds>,
    pub theme: String,
    pub tileset_id: String,
    pub overlays: Overlays,
    /// Окрестности за краем карты; `None` — поля нет.
    pub surroundings: Option<Surroundings>,
    /// Ключ `SIZE_CLASSES`.
    pub size_class: String,
    /// Какие необязательные поля несли исходные клетки.
    pub legacy_shape: Vec<String>,
}

impl TacticalMap {
    /// Ребро по каноническому ключу (`map.edges['x,y,dir']`).
    pub fn edge(&self, x: i64, y: i64, dir: EdgeDir) -> Option<&TacticalEdge> {
        self.edges.get(&(x, y, dir))
    }

    /// Изменяемое ребро по ключу.
    pub fn edge_mut(&mut self, x: i64, y: i64, dir: EdgeDir) -> Option<&mut TacticalEdge> {
        self.edges.get_mut(&(x, y, dir))
    }

    /// `delete map.edges['x,y,dir']`.
    pub fn remove_edge(&mut self, x: i64, y: i64, dir: EdgeDir) -> Option<TacticalEdge> {
        self.edges.remove(&(x, y, dir))
    }

    /// `map.edges[key] = edge` под ключом самого ребра, без проверок.
    pub fn insert_edge(&mut self, edge: TacticalEdge) {
        self.edges.insert((edge.x, edge.y, edge.dir), edge);
    }

    /// Все рёбра в произвольном порядке; упорядоченные — [`edge_list`].
    pub fn edges(&self) -> impl Iterator<Item = &TacticalEdge> {
        self.edges.values()
    }

    /// Оставить только рёбра, для которых `keep` истинно.
    pub fn retain_edges(&mut self, mut keep: impl FnMut(&TacticalEdge) -> bool) {
        self.edges.retain(|_, edge| keep(edge));
    }

    pub fn edge_count(&self) -> usize {
        self.edges.len()
    }

    /// `map.doors.find((door) => door.id === id)`.
    pub fn door(&self, id: &str) -> Option<&TacticalDoor> {
        self.doors.iter().find(|door| door.id == id)
    }

    pub fn door_mut(&mut self, id: &str) -> Option<&mut TacticalDoor> {
        self.doors.iter_mut().find(|door| door.id == id)
    }

    /// `map.props.find((prop) => prop.id === id)`.
    pub fn prop(&self, id: &str) -> Option<&TacticalProp> {
        self.props.iter().find(|prop| prop.id == id)
    }

    pub fn prop_mut(&mut self, id: &str) -> Option<&mut TacticalProp> {
        self.props.iter_mut().find(|prop| prop.id == id)
    }
}

// --- битсеты и приведения -------------------------------------------------

fn bit_at(bits: &[u8], index: usize) -> bool {
    bits.get(index >> 3).is_some_and(|byte| byte & (1 << (index & 7)) != 0)
}

fn set_bit_at(bits: &mut [u8], index: usize, value: bool) {
    if let Some(byte) = bits.get_mut(index >> 3) {
        if value {
            *byte |= 1 << (index & 7);
        } else {
            *byte &= !(1u8 << (index & 7));
        }
    }
}

fn bitset_length(length: usize) -> usize {
    length.div_ceil(8)
}

/// `Number.isSafeInteger(number)`.
fn is_safe_integer(number: f64) -> bool {
    number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0
}

/// `boundedInteger(value, fallback, minimum, maximum)` для рыхлого значения.
fn bounded_integer(value: Option<&Value>, fallback: i64, minimum: i64, maximum: i64) -> i64 {
    let number = js::number(value);
    if is_safe_integer(number) {
        (number as i64).clamp(minimum, maximum)
    } else {
        fallback
    }
}

/// `boundedText(value, maximum, fallback)` для рыхлого значения: только строки.
fn bounded_text_value(value: Option<&Value>, maximum: usize, fallback: &str) -> String {
    match value {
        Some(Value::String(text)) => bounded_text(text, maximum, fallback),
        _ => fallback.to_string(),
    }
}

/// `boundedText` для строки.
fn bounded_text(value: &str, maximum: usize, fallback: &str) -> String {
    let result = text::head(text::trim(value), maximum);
    if result.is_empty() {
        fallback.to_string()
    } else {
        result
    }
}

/// `value?.[key]`: поле есть только у объекта.
fn field<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(Value::as_object).and_then(|object| object.get(key))
}

/// Чтение поля объекта, на котором JS бросил бы `TypeError` для `null`.
fn require_object<'a>(value: Option<&'a Value>, key: &str) -> MapResult<Option<&'a Value>> {
    match value {
        None => Err(TacticalMapError::type_error(format!("Cannot read properties of undefined (reading '{key}')"))),
        Some(Value::Null) => Err(TacticalMapError::type_error(format!("Cannot read properties of null (reading '{key}')"))),
        _ => Ok(value),
    }
}

/// Запись числа JS в строке шаблона: `${value}`.
fn number_text(value: f64) -> String {
    js::f64_string(value)
}

fn require_catalog_revision(value: Option<&Value>) -> MapResult<String> {
    match value {
        Some(Value::String(text)) if is_safe_catalog_revision_str(text) => Ok(text.clone()),
        _ => Err(TacticalMapError::new("catalogRevision должен быть безопасным идентификатором", "CATALOG_REVISION_INVALID")),
    }
}

fn require_catalog_revision_str(value: &str) -> MapResult<String> {
    if is_safe_catalog_revision_str(value) {
        Ok(value.to_string())
    } else {
        Err(TacticalMapError::new("catalogRevision должен быть безопасным идентификатором", "CATALOG_REVISION_INVALID"))
    }
}

// --- создание -------------------------------------------------------------

/// Наименьший класс размера, в который помещается карта (`sizeClassFor`).
pub fn size_class_for(width: i64, height: i64) -> &'static str {
    let cells = width * height;
    SIZE_CLASSES
        .iter()
        .find(|(_, limits)| width <= limits.max_width && height <= limits.max_height && cells <= limits.max_cells)
        .map_or("region", |(name, _)| name)
}

/// Выпуск каталога для новой карты.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CatalogRevision<'a> {
    /// `undefined`: активный выпуск каталога окружения.
    #[default]
    Current,
    /// `null`: карта без поля (реконструкция legacy-сцены).
    Omit,
    /// Явный выпуск; небезопасный — отказ `CATALOG_REVISION_INVALID`.
    Value(&'a str),
}

/// Параметры `createTacticalMap`.
#[derive(Clone, Debug)]
pub struct TacticalMapOptions<'a> {
    pub width: i64,
    pub height: i64,
    pub location_id: &'a str,
    pub level_index: i64,
    pub level_label: &'a str,
    pub seed: &'a str,
    /// `(id, version)`; `None` — `{ id: 'manual', version: '1' }`.
    pub generator: Option<(&'a str, &'a str)>,
    pub theme: &'a str,
    pub tileset_id: &'a str,
    pub size_class: &'a str,
    pub catalog_revision: CatalogRevision<'a>,
    /// Если задано, все координаты становятся существующими клетками.
    pub fill: Option<CellPatch<'a>>,
}

impl Default for TacticalMapOptions<'_> {
    fn default() -> Self {
        Self {
            width: 1,
            height: 1,
            location_id: "",
            level_index: 0,
            level_label: "",
            seed: "",
            generator: None,
            theme: "",
            tileset_id: "",
            size_class: "",
            catalog_revision: CatalogRevision::Current,
            fill: None,
        }
    }
}

fn empty_layers(length: usize) -> TacticalLayers {
    TacticalLayers {
        present: vec![0; bitset_length(length)],
        passable: vec![0; bitset_length(length)],
        revealed: vec![0; bitset_length(length)],
        move_cost: vec![1; length],
        surface: vec![0; length],
        material: vec![0; length],
        variant: vec![0; length],
        elevation: vec![0; length],
        zone_id: vec![0; length],
    }
}

/// `createTacticalMap(options)`: пустая карта; форма набирается вызовами
/// [`set_cell`], поэтому непрямоугольный контур выражается сам собой.
pub fn create_tactical_map(options: &TacticalMapOptions<'_>) -> MapResult<TacticalMap> {
    let width = options.width.clamp(1, REGION.max_width);
    let height = options.height.clamp(1, REGION.max_height);
    let length = (width * height) as usize;
    let catalog_revision = match options.catalog_revision {
        CatalogRevision::Omit => None,
        CatalogRevision::Current => Some(current_environment_catalog_revision()),
        CatalogRevision::Value(value) => Some(require_catalog_revision_str(value)?),
    };
    let (generator_id, generator_version) = options.generator.unwrap_or(("manual", "1"));
    let mut map = TacticalMap {
        version: TACTICAL_MAP_VERSION.into(),
        location_id: bounded_text(options.location_id, 120, ""),
        catalog_revision,
        level_index: options.level_index.clamp(-MAX_LEVEL_OFFSET, MAX_LEVEL_OFFSET),
        level_label: bounded_text(options.level_label, 120, ""),
        seed: bounded_text(options.seed, 200, ""),
        generator: Generator { id: bounded_text(generator_id, 60, "manual"), version: bounded_text(generator_version, 20, "1") },
        width,
        height,
        bounds: Bounds::EMPTY,
        layers: empty_layers(length),
        hazards: Hazards::default(),
        edges: EdgeMap::default(),
        doors: Vec::new(),
        props: Vec::new(),
        zones: Vec::new(),
        spawn_points: Vec::new(),
        combat_bounds: None,
        theme: bounded_text(options.theme, 60, ""),
        tileset_id: bounded_text(options.tileset_id, 60, ""),
        overlays: Overlays::default(),
        surroundings: None,
        size_class: if size_class_key_truthy(options.size_class) { options.size_class.to_string() } else { size_class_for(width, height).to_string() },
        legacy_shape: LEGACY_OPTIONAL_FIELDS.iter().map(|field| field.to_string()).collect(),
    };
    if let Some(fill) = &options.fill {
        for y in 0..height {
            for x in 0..width {
                set_cell(&mut map, x, y, fill)?;
            }
        }
    }
    Ok(map)
}

// --- вариант тайла --------------------------------------------------------

thread_local! {
    /// Кэш базы шума: строка сида одна на всю генерацию, а клеток десять тысяч.
    static SEED_NOISE_BASES: std::cell::RefCell<HashMap<String, u32>> = std::cell::RefCell::new(HashMap::new());
}

fn seed_noise_base(seed: &str) -> u32 {
    SEED_NOISE_BASES.with(|cache| {
        if let Some(base) = cache.borrow().get(seed) {
            return *base;
        }
        let digest = hash::sha256(seed);
        let base = u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]]);
        let mut cache = cache.borrow_mut();
        if cache.len() > 512 {
            cache.clear();
        }
        cache.insert(seed.to_string(), base);
        base
    })
}

/// `floorVariantAt(seed, x, y, variants)`: детерминированный шум от сида и
/// координат (перемешиватель по образцу splitmix32), целое `0…variants−1`.
/// Сид-число приводится вызывающим (`String(seed)`).
pub fn floor_variant_at(seed: &str, x: i64, y: i64, variants: u32) -> u32 {
    let span = variants.max(1);
    let mut hash = seed_noise_base(seed);
    hash ^= js::imul(f64::from(js::to_int32(x as f64)), f64::from(0x27d4_eb2d_u32)) as u32;
    hash ^= js::imul(f64::from(js::to_int32(y as f64)), f64::from(0x1656_67b1_u32)) as u32;
    hash = js::imul(f64::from(hash ^ (hash >> 15)), f64::from(0x2c1b_3c6d_u32)) as u32;
    hash = js::imul(f64::from(hash ^ (hash >> 12)), f64::from(0x297a_2d39_u32)) as u32;
    hash ^= hash >> 15;
    hash % span
}

// --- клетки ---------------------------------------------------------------

/// `cellIndex(map, x, y)`: `None` для координат вне сетки.
pub fn cell_index(map: &TacticalMap, x: i64, y: i64) -> Option<usize> {
    if x < 0 || y < 0 || x >= map.width || y >= map.height {
        return None;
    }
    Some((y * map.width + x) as usize)
}

/// `cellExists(map, x, y)`.
pub fn cell_exists(map: &TacticalMap, x: i64, y: i64) -> bool {
    cell_index(map, x, y).is_some_and(|index| bit_at(&map.layers.present, index))
}

/// Проходима ли существующая клетка (`cellAt(map, x, y)?.passable === true`).
pub fn cell_passable(map: &TacticalMap, x: i64, y: i64) -> bool {
    cell_index(map, x, y).is_some_and(|index| bit_at(&map.layers.present, index) && bit_at(&map.layers.passable, index))
}

/// `cellAt(map, x, y)`: `None`, если клетки нет — единственный способ
/// отличить «клетки нет» от «клетка есть, но она стена».
pub fn cell_at(map: &TacticalMap, x: i64, y: i64) -> Option<TacticalCell<'_>> {
    let index = cell_index(map, x, y)?;
    if !bit_at(&map.layers.present, index) {
        return None;
    }
    let layers = &map.layers;
    let zone_code = layers.zone_id.get(index).copied().unwrap_or(0);
    let move_cost = layers.move_cost.get(index).copied().unwrap_or(0);
    Some(TacticalCell {
        x,
        y,
        passable: bit_at(&layers.passable, index),
        move_cost: if move_cost == 0 { 1 } else { move_cost },
        surface: layers.surface.get(index).and_then(|code| SURFACES.get(*code as usize)).copied().unwrap_or("none"),
        hazard_id: map.hazards.get_cell(index),
        material: layers.material.get(index).and_then(|code| MATERIALS.get(*code as usize)).copied().unwrap_or("stone"),
        elevation: i64::from(layers.elevation.get(index).copied().unwrap_or(0)),
        zone: if zone_code > 0 { map.zones.get(zone_code as usize - 1).map_or("", |zone| zone.id.as_str()) } else { "" },
        variant: layers.variant.get(index).copied().unwrap_or(0),
        revealed: bit_at(&layers.revealed, index),
    })
}

/// Частичное обновление клетки (`Partial<TacticalCell>`); поле `None` — не
/// трогать.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CellPatch<'a> {
    pub passable: Option<bool>,
    pub revealed: Option<bool>,
    /// Только 1 или 2, иначе отказ `MOVE_COST_NOT_ALLOWED`.
    pub move_cost: Option<f64>,
    pub surface: Option<&'a str>,
    pub material: Option<&'a str>,
    pub variant: Option<i64>,
    pub elevation: Option<i64>,
    /// Id зоны; пустая строка — снять зону.
    pub zone: Option<&'a str>,
    /// `Some(None)` — снять опасность (`hazardId: null`).
    pub hazard_id: Option<Option<&'a str>>,
}

/// Заплатка клетки из рыхлого JSON: значения уже приведены, как их привёл
/// бы `setCell` (`passable === true`, `String(surface)`, `boundedInteger`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CellPatchJson {
    passable: Option<bool>,
    revealed: Option<bool>,
    move_cost: Option<f64>,
    surface: Option<String>,
    material: Option<String>,
    variant: Option<i64>,
    elevation: Option<i64>,
    zone: Option<String>,
    hazard_id: Option<Option<String>>,
}

impl CellPatchJson {
    /// Разбор `Partial<TacticalCell>`: поле отсутствует — `undefined`.
    pub fn from_json(patch: &Value) -> Self {
        let get = |key: &str| field(Some(patch), key);
        Self {
            passable: get("passable").map(|value| value == &Value::Bool(true)),
            revealed: get("revealed").map(|value| value == &Value::Bool(true)),
            move_cost: get("moveCost").map(|value| js::number(Some(value))),
            surface: get("surface").map(|value| js::string(Some(value))),
            material: get("material").map(|value| js::string(Some(value))),
            variant: get("variant").map(|value| bounded_integer(Some(value), 0, 0, 255)),
            elevation: get("elevation").map(|value| bounded_integer(Some(value), 0, -128, 127)),
            zone: get("zone").map(|value| js::s(Some(value))),
            hazard_id: get("hazardId").map(|value| if value.is_null() { None } else { Some(js::s(Some(value))) }),
        }
    }

    pub fn patch(&self) -> CellPatch<'_> {
        CellPatch {
            passable: self.passable,
            revealed: self.revealed,
            move_cost: self.move_cost,
            surface: self.surface.as_deref(),
            material: self.material.as_deref(),
            variant: self.variant,
            elevation: self.elevation,
            zone: self.zone.as_deref(),
            hazard_id: self.hazard_id.as_ref().map(Option::as_deref),
        }
    }
}

fn enum_code(table: &[&str], value: &str, label: &str) -> MapResult<u8> {
    table
        .iter()
        .position(|entry| *entry == value)
        .map(|code| code as u8)
        .ok_or_else(|| TacticalMapError::new(format!("Недопустимое значение {label}: {value}"), "ENUM_VALUE_NOT_ALLOWED"))
}

fn expand_bounds(map: &mut TacticalMap, x: i64, y: i64) {
    let bounds = &mut map.bounds;
    if bounds.max_x < bounds.min_x {
        *bounds = Bounds { min_x: x, min_y: y, max_x: x, max_y: y };
        return;
    }
    bounds.min_x = bounds.min_x.min(x);
    bounds.min_y = bounds.min_y.min(y);
    bounds.max_x = bounds.max_x.max(x);
    bounds.max_y = bounds.max_y.max(y);
}

/// `setCell(map, x, y, patch)`: клетка становится существующей. Как в JS,
/// отказ посреди заплатки оставляет уже сделанные правки.
pub fn set_cell(map: &mut TacticalMap, x: i64, y: i64, patch: &CellPatch<'_>) -> MapResult<()> {
    let Some(index) = cell_index(map, x, y) else {
        return Err(TacticalMapError::new(format!("Клетка {x},{y} вне границ карты"), "CELL_OUT_OF_BOUNDS"));
    };
    let fresh = !bit_at(&map.layers.present, index);
    set_bit_at(&mut map.layers.present, index, true);
    if fresh {
        if let Some(cost) = map.layers.move_cost.get_mut(index) {
            *cost = 1;
        }
    }
    if let Some(passable) = patch.passable {
        set_bit_at(&mut map.layers.passable, index, passable);
    }
    if let Some(revealed) = patch.revealed {
        set_bit_at(&mut map.layers.revealed, index, revealed);
    }
    if let Some(cost) = patch.move_cost {
        if cost != 1.0 && cost != 2.0 {
            return Err(TacticalMapError::new("moveCost допускает только 1 или 2", "MOVE_COST_NOT_ALLOWED"));
        }
        if let Some(slot) = map.layers.move_cost.get_mut(index) {
            *slot = cost as u8;
        }
    }
    if let Some(surface) = patch.surface {
        let code = enum_code(&SURFACES, surface, "surface")?;
        if let Some(slot) = map.layers.surface.get_mut(index) {
            *slot = code;
        }
    }
    if let Some(material) = patch.material {
        let code = enum_code(&MATERIALS, material, "material")?;
        if let Some(slot) = map.layers.material.get_mut(index) {
            *slot = code;
        }
    }
    if let Some(variant) = patch.variant {
        if let Some(slot) = map.layers.variant.get_mut(index) {
            *slot = variant.clamp(0, 255) as u8;
        }
    }
    if let Some(elevation) = patch.elevation {
        if let Some(slot) = map.layers.elevation.get_mut(index) {
            *slot = elevation.clamp(-128, 127) as i8;
        }
    }
    if let Some(zone) = patch.zone {
        let code = if zone.is_empty() {
            0
        } else {
            match map.zones.iter().position(|entry| entry.id == zone) {
                // Запись в Uint8Array JS — по модулю 256.
                Some(position) => ((position + 1) & 0xff) as u8,
                None => return Err(TacticalMapError::new(format!("Зона {zone} не объявлена в карте"), "ZONE_NOT_FOUND")),
            }
        };
        if let Some(slot) = map.layers.zone_id.get_mut(index) {
            *slot = code;
        }
    }
    if let Some(hazard) = patch.hazard_id {
        match hazard {
            Some(hazard) if !hazard.is_empty() => map.hazards.insert(&index.to_string(), hazard.to_string()),
            _ => map.hazards.remove(&index.to_string()),
        }
    }
    if fresh {
        expand_bounds(map, x, y);
    }
    Ok(())
}

/// `setCell` с рыхлой заплаткой (`Partial<TacticalCell>` из JSON).
pub fn set_cell_json(map: &mut TacticalMap, x: i64, y: i64, patch: &Value) -> MapResult<()> {
    let parsed = CellPatchJson::from_json(patch);
    set_cell(map, x, y, &parsed.patch())
}

/// `recomputeBounds(map)`: охват существующих клеток заново.
pub fn recompute_bounds(map: &mut TacticalMap) -> Bounds {
    map.bounds = computed_bounds(map);
    map.bounds
}

fn computed_bounds(map: &TacticalMap) -> Bounds {
    let mut result: Option<Bounds> = None;
    for y in 0..map.height {
        for x in 0..map.width {
            if !bit_at(&map.layers.present, (y * map.width + x) as usize) {
                continue;
            }
            let bounds = result.get_or_insert(Bounds { min_x: x, min_y: y, max_x: x, max_y: y });
            bounds.min_x = bounds.min_x.min(x);
            bounds.min_y = bounds.min_y.min(y);
            bounds.max_x = bounds.max_x.max(x);
            bounds.max_y = bounds.max_y.max(y);
        }
    }
    result.unwrap_or(Bounds::EMPTY)
}

/// `forEachCell(map, visit)`: существующие клетки в порядке y, затем x.
pub fn for_each_cell<'a>(map: &'a TacticalMap, mut visit: impl FnMut(TacticalCell<'a>)) {
    for y in 0..map.height {
        for x in 0..map.width {
            if let Some(cell) = cell_at(map, x, y) {
                visit(cell);
            }
        }
    }
}

/// Существующие клетки в порядке y, затем x.
pub fn cells(map: &TacticalMap) -> impl Iterator<Item = TacticalCell<'_>> {
    (0..map.height).flat_map(move |y| (0..map.width).filter_map(move |x| cell_at(map, x, y)))
}

/// `cellCount(map)`.
pub fn cell_count(map: &TacticalMap) -> usize {
    let length = (map.width * map.height) as usize;
    (0..length).filter(|index| bit_at(&map.layers.present, *index)).count()
}

// --- рёбра ----------------------------------------------------------------

/// `canonicalEdge(ax, ay, bx, by)`: ребро принадлежит верхней или левой
/// клетке и смотрит на восток или на юг.
pub fn canonical_edge(ax: i64, ay: i64, bx: i64, by: i64) -> MapResult<(i64, i64, EdgeDir)> {
    if ay == by && bx == ax + 1 {
        return Ok((ax, ay, EdgeDir::E));
    }
    if ay == by && bx == ax - 1 {
        return Ok((bx, by, EdgeDir::E));
    }
    if ax == bx && by == ay + 1 {
        return Ok((ax, ay, EdgeDir::S));
    }
    if ax == bx && by == ay - 1 {
        return Ok((bx, by, EdgeDir::S));
    }
    Err(not_adjacent(&ax.to_string(), &ay.to_string(), &bx.to_string(), &by.to_string()))
}

fn not_adjacent(ax: &str, ay: &str, bx: &str, by: &str) -> TacticalMapError {
    TacticalMapError::new(format!("Клетки {ax},{ay} и {bx},{by} не соседние — ребра между ними не существует"), "EDGE_CELLS_NOT_ADJACENT")
}

/// `edgeNeighbor(edge)`: вторая клетка ребра.
pub fn edge_neighbor(x: i64, y: i64, dir: EdgeDir) -> (i64, i64) {
    match dir {
        EdgeDir::E => (x + 1, y),
        EdgeDir::S => (x, y + 1),
    }
}

/// `edgeBetween(map, ax, ay, bx, by)`.
pub fn edge_between(map: &TacticalMap, ax: i64, ay: i64, bx: i64, by: i64) -> MapResult<Option<&TacticalEdge>> {
    let (x, y, dir) = canonical_edge(ax, ay, bx, by)?;
    Ok(map.edge(x, y, dir))
}

/// Частичное ребро (`Partial<TacticalEdge>`); `None` — значение по умолчанию.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EdgePatch<'a> {
    /// По умолчанию `wall`; `none` удаляет запись.
    pub kind: Option<&'a str>,
    pub blocks_move: Option<bool>,
    pub blocks_sight: Option<bool>,
    pub cover: Option<&'a str>,
    pub door_id: Option<&'a str>,
}

/// Ребро из рыхлого JSON (`edge.kind ?? 'wall'`, `edge.blocksMove !== undefined`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EdgePatchJson {
    kind: Option<String>,
    blocks_move: Option<bool>,
    blocks_sight: Option<bool>,
    cover: Option<String>,
    door_id: Option<String>,
}

impl EdgePatchJson {
    pub fn from_json(edge: &Value) -> Self {
        let get = |key: &str| field(Some(edge), key);
        let present = |value: Option<&Value>| value.filter(|value| !value.is_null()).map(|value| js::s(Some(value)));
        Self {
            kind: present(get("kind")),
            blocks_move: get("blocksMove").map(|value| value == &Value::Bool(true)),
            blocks_sight: get("blocksSight").map(|value| value == &Value::Bool(true)),
            cover: present(get("cover")),
            door_id: present(get("doorId")),
        }
    }

    pub fn patch(&self) -> EdgePatch<'_> {
        EdgePatch {
            kind: self.kind.as_deref(),
            blocks_move: self.blocks_move,
            blocks_sight: self.blocks_sight,
            cover: self.cover.as_deref(),
            door_id: self.door_id.as_deref(),
        }
    }
}

/// `setEdge(map, ax, ay, bx, by, edge)`: `kind: 'none'` удаляет запись.
pub fn set_edge<'m>(map: &'m mut TacticalMap, ax: i64, ay: i64, bx: i64, by: i64, edge: &EdgePatch<'_>) -> MapResult<Option<&'m TacticalEdge>> {
    let (x, y, dir) = canonical_edge(ax, ay, bx, by)?;
    let kind_text = edge.kind.unwrap_or("wall");
    let Some(kind) = EdgeKind::parse(kind_text) else {
        return Err(TacticalMapError::new(format!("Недопустимый тип ребра: {kind_text}"), "EDGE_KIND_NOT_ALLOWED"));
    };
    if kind == EdgeKind::None {
        map.edges.remove(&(x, y, dir));
        return Ok(None);
    }
    let default_cover = match kind {
        EdgeKind::Loophole => "three_quarters",
        EdgeKind::Grate => "half",
        _ => "none",
    };
    let cover_text = edge.cover.unwrap_or(default_cover);
    let Some(cover) = Cover::parse(cover_text) else {
        return Err(TacticalMapError::new(format!("Недопустимое укрытие: {cover_text}"), "COVER_NOT_ALLOWED"));
    };
    let record = TacticalEdge {
        x,
        y,
        dir,
        kind,
        blocks_move: edge.blocks_move.unwrap_or(matches!(kind, EdgeKind::Wall | EdgeKind::Loophole | EdgeKind::Grate)),
        blocks_sight: edge.blocks_sight.unwrap_or(kind == EdgeKind::Wall),
        cover,
        door_id: edge.door_id.map(str::to_string),
    };
    map.edges.insert((x, y, dir), record);
    Ok(map.edges.get(&(x, y, dir)))
}

/// `setEdge` с рыхлым ребром.
pub fn set_edge_json<'m>(map: &'m mut TacticalMap, ax: i64, ay: i64, bx: i64, by: i64, edge: &Value) -> MapResult<Option<&'m TacticalEdge>> {
    let parsed = EdgePatchJson::from_json(edge);
    set_edge(map, ax, ay, bx, by, &parsed.patch())
}

/// `edgeList(map)`: рёбра в порядке y, затем x, затем направление (`e` раньше `s`).
pub fn edge_list(map: &TacticalMap) -> Vec<&TacticalEdge> {
    let mut list: Vec<&TacticalEdge> = map.edges.values().collect();
    list.sort_unstable_by_key(|edge| (edge.y, edge.x, edge.dir));
    list
}

// --- двери, предметы, зоны ------------------------------------------------

/// Целое число JSON (координата двери). JS берёт `door.x` как есть; здесь
/// нецелое значение — отказ, как отказал бы JS на `undefined`.
fn integer_coordinate(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Number(number)) => number.as_f64().filter(|number| is_safe_integer(*number)).map(|number| number as i64),
        _ => None,
    }
}

/// `${value}` и `${value + 1}` для координаты, на которой JS не нашёл ребра.
fn coordinate_texts(value: Option<&Value>) -> (String, String) {
    match value {
        None => ("undefined".into(), "NaN".into()),
        Some(Value::Null) => ("null".into(), "1".into()),
        Some(Value::Bool(flag)) => (flag.to_string(), if *flag { "2" } else { "1" }.into()),
        Some(Value::Number(number)) => {
            let number = number.as_f64().unwrap_or(f64::NAN);
            (number_text(number), number_text(number + 1.0))
        }
        Some(other) => {
            let text = js::s(Some(other));
            (text.clone(), format!("{text}1"))
        }
    }
}

/// Отказ `canonicalEdge` для ребра с нецелыми координатами: в JS сосед
/// считается `x + 1` или `y + 1` и не сходится с клеткой.
fn loose_edge_error(x: Option<&Value>, y: Option<&Value>, dir: EdgeDir) -> TacticalMapError {
    let (ax, ax_next) = coordinate_texts(x);
    let (ay, ay_next) = coordinate_texts(y);
    match dir {
        EdgeDir::E => not_adjacent(&ax, &ay, &ax_next, &ay),
        EdgeDir::S => not_adjacent(&ax, &ay, &ax, &ay_next),
    }
}

/// `setDoor(map, door)`: ставит дверь и приводит ребро под ней в
/// согласованный вид. `door` — объект JS `{ id, x, y, dir, state, lockDc,
/// keyItemId, barricade, blocksMove, blocksSight }`.
pub fn set_door<'m>(map: &'m mut TacticalMap, door: &Value) -> MapResult<&'m TacticalDoor> {
    let door = require_object(Some(door), "state")?;
    let state = match field(door, "state") {
        None | Some(Value::Null) => "closed".to_string(),
        Some(value) => js::s(Some(value)),
    };
    if !DOOR_STATES.contains(&state.as_str()) {
        return Err(TacticalMapError::new(format!("Недопустимое состояние двери: {state}"), "DOOR_STATE_NOT_ALLOWED"));
    }
    let id = bounded_text_value(field(door, "id"), 120, "");
    if id.is_empty() {
        return Err(TacticalMapError::new("У двери должен быть идентификатор", "DOOR_ID_REQUIRED"));
    }
    let dir = if field(door, "dir").and_then(Value::as_str) == Some("e") { EdgeDir::E } else { EdgeDir::S };
    let (Some(x), Some(y)) = (integer_coordinate(field(door, "x")), integer_coordinate(field(door, "y"))) else {
        return Err(loose_edge_error(field(door, "x"), field(door, "y"), dir));
    };
    let barricade = match field(door, "barricade") {
        None => None,
        Some(value) if js::truthy(Some(value)) && (value.is_object() || value.is_array()) => {
            let get = |key: &str| field(Some(value), key);
            let previous = js::string(get("previous_state"));
            let side = |key: &str| {
                let number = js::number(get(key));
                if is_safe_integer(number) {
                    number as i64
                } else {
                    0
                }
            };
            Some(Some(Barricade {
                material_item_id: bounded_text_value(get("material_item_id"), 120, ""),
                actor_id: bounded_text_value(get("actor_id"), 120, ""),
                previous_state: if DOOR_STATES.contains(&previous.as_str()) { previous } else { "open".into() },
                side_x: side("side_x"),
                side_y: side("side_y"),
            }))
        }
        Some(_) => Some(None),
    };
    let record = TacticalDoor {
        id: id.clone(),
        x,
        y,
        dir,
        state,
        lock_dc: bounded_integer(field(door, "lockDc"), 0, 0, 40),
        key_item_id: match field(door, "keyItemId") {
            None | Some(Value::Null) => None,
            Some(value) => Some(js::s(Some(value))),
        },
        barricade,
    };
    let barricaded = record.barricade().is_some();
    let position = match map.doors.iter().position(|entry| entry.id == id) {
        Some(existing) => {
            map.doors[existing] = record;
            existing
        }
        None => {
            map.doors.push(record);
            map.doors.len() - 1
        }
    };
    let (nx, ny) = edge_neighbor(x, y, dir);
    let patch = EdgePatch {
        kind: Some("door"),
        blocks_move: Some(js::is_true(field(door, "blocksMove")) || barricaded),
        blocks_sight: Some(js::is_true(field(door, "blocksSight")) || barricaded),
        cover: Some("none"),
        door_id: Some(&id),
    };
    set_edge(map, x, y, nx, ny, &patch)?;
    Ok(&map.doors[position])
}

/// `normalizeTransition(map, assetId, value)`.
fn normalize_transition(map: &TacticalMap, asset_id: &str, value: Option<&Value>) -> MapResult<Option<PropTransition>> {
    let raw = match value {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Object(raw)) => raw,
        Some(_) => return Err(TacticalMapError::new("transition должен быть объектом", "TRANSITION_NOT_OBJECT")),
    };
    let to_level = js::number(raw.get("toLevel"));
    if !is_safe_integer(to_level) {
        return Err(TacticalMapError::new(
            format!("transition.toLevel должен быть целым: {}", js::string(raw.get("toLevel"))),
            "TRANSITION_LEVEL_NOT_INTEGER",
        ));
    }
    let to_level = to_level as i64;
    if to_level.abs() > MAX_LEVEL_OFFSET {
        return Err(TacticalMapError::new(
            format!("transition.toLevel={to_level} выходит за предел ±{MAX_LEVEL_OFFSET}"),
            "TRANSITION_LEVEL_OUT_OF_RANGE",
        ));
    }
    if to_level == map.level_index {
        return Err(TacticalMapError::new(format!("transition.toLevel={to_level} совпадает с этажом карты"), "TRANSITION_LEVEL_SAME"));
    }
    if !TRANSITION_ASSETS.contains(&asset_id) || asset_by_id(asset_id).is_none() {
        let named = if asset_id.is_empty() { "<без ассета>" } else { asset_id };
        return Err(TacticalMapError::new(
            format!("Переход нельзя повесить на {named}: нужен ассет перехода ({})", TRANSITION_ASSETS.join(", ")),
            "TRANSITION_ASSET_NOT_INTERACTIVE",
        ));
    }
    Ok(Some(PropTransition { to_level, label: bounded_text_value(raw.get("label"), 120, "") }))
}

/// `normalizePropMount(value)`.
fn normalize_prop_mount(value: Option<&Value>) -> Option<PropMount> {
    let mount = match value {
        Some(Value::Object(mount)) => mount,
        _ => return None,
    };
    match mount.get("kind").and_then(Value::as_str) {
        Some("surface") => match mount.get("propId") {
            Some(Value::String(prop_id)) if !text::trim(prop_id).is_empty() && text::len(prop_id) <= 120 => Some(PropMount::Surface { prop_id: prop_id.clone() }),
            _ => None,
        },
        Some("wall") => {
            let side = js::string(mount.get("side"));
            ["n", "e", "s", "w"].into_iter().find(|candidate| *candidate == side).map(|side| PropMount::Wall { side })
        }
        _ => None,
    }
}

/// Ключ взаимодействия из сохранённой записи: только непустая строка.
fn stored_key(stored: &Map<String, Value>, key: &str) -> Option<String> {
    let value = stored.get(key);
    (!bounded_text_value(value, 120, "").is_empty()).then(|| js::s(value))
}

/// `addProp(map, prop)`: `prop` — объект JS `Partial<TacticalProp>`.
pub fn add_prop<'m>(map: &'m mut TacticalMap, prop: &Value) -> MapResult<&'m mut TacticalProp> {
    let prop = require_object(Some(prop), "cover")?;
    let get = |key: &str| field(prop, key);
    let cover_text = match get("cover") {
        None | Some(Value::Null) => "none".to_string(),
        Some(value) => js::s(Some(value)),
    };
    let Some(cover) = Cover::parse(&cover_text) else {
        return Err(TacticalMapError::new(format!("Недопустимое укрытие предмета: {cover_text}"), "COVER_NOT_ALLOWED"));
    };
    let stored = match get("interaction") {
        Some(Value::Object(stored)) => Some(stored),
        _ => None,
    };
    let point_of_interest = stored.is_some_and(|stored| js::is_true(stored.get("pointOfInterest")));
    let generated = interaction_metadata_for_prop(&map.seed, prop, point_of_interest);
    let interaction = generated.map(|generated| {
        let detail = stored.and_then(|stored| stored_key(stored, "detailKey")).unwrap_or(generated.detail_key);
        let reward = stored.and_then(|stored| stored_key(stored, "rewardKey")).unwrap_or(generated.reward_key);
        let mut verbs: Vec<String> = Vec::new();
        for verb in generated.verbs {
            let verb = bounded_text(verb, 40, "");
            if !verb.is_empty() && !verbs.contains(&verb) {
                verbs.push(verb);
            }
        }
        verbs.truncate(8);
        PropInteraction {
            kind: bounded_text(generated.kind, 40, ""),
            verbs,
            point_of_interest: generated.point_of_interest,
            detail_key: Some(bounded_text(&detail, 120, "")),
            reward_key: Some(bounded_text(&reward, 120, "")),
        }
    });
    let asset_id = bounded_text_value(get("assetId"), 120, "");
    let transition = normalize_transition(map, &asset_id, get("transition"))?;
    let mount = normalize_prop_mount(get("mount"));
    let rotation = js::number(get("rotation"));
    let scale = js::number(get("scale"));
    let footprint = match get("footprint") {
        Some(Value::Array(cells)) => cells
            .iter()
            .map(|cell| Point::new(bounded_integer(field(Some(cell), "x"), 0, -1_000, 1_000), bounded_integer(field(Some(cell), "y"), 0, -1_000, 1_000)))
            .collect(),
        _ => Vec::new(),
    };
    let record = TacticalProp {
        id: bounded_text_value(get("id"), 120, ""),
        asset_id,
        x: js::number(get("x")),
        y: js::number(get("y")),
        rotation: if rotation.is_finite() { rotation } else { 0.0 },
        scale: if scale.is_finite() && scale > 0.0 { scale } else { 1.0 },
        footprint,
        z_order: bounded_integer(get("zOrder"), 0, -1_000, 1_000),
        mount,
        blocks_move: js::is_true(get("blocksMove")),
        blocks_sight: js::is_true(get("blocksSight")),
        cover,
        destructible: js::is_true(get("destructible")),
        hp: bounded_integer(get("hp"), 0, 0, 1_000),
        interactive: js::is_true(get("interactive")) || interaction.is_some() || transition.is_some(),
        state: bounded_text_value(get("state"), 40, ""),
        interaction,
        transition,
    };
    if record.id.is_empty() {
        return Err(TacticalMapError::new("У предмета должен быть идентификатор", "PROP_ID_REQUIRED"));
    }
    map.props.push(record);
    Ok(map.props.last_mut().expect("предмет только что добавлен"))
}

/// `attachLevelTransitions(map, levels)`: уже расставленные лестницы и люки
/// становятся переходами на объявленные этажи. Возвращает индексы предметов
/// в `map.props`, ставших переходами.
pub fn attach_level_transitions(map: &mut TacticalMap, levels: Option<&Value>) -> Vec<usize> {
    let mut attached = Vec::new();
    let mut taken: HashSet<String> = map.props.iter().filter(|prop| prop.transition.is_some()).map(|prop| prop.id.clone()).collect();
    let levels: &[Value] = match levels {
        Some(Value::Array(levels)) => levels,
        _ => &[],
    };
    for level in levels {
        let to_level = js::number(field(Some(level), "offset"));
        if !is_safe_integer(to_level) {
            continue;
        }
        let to_level = to_level as i64;
        if to_level == map.level_index || to_level.abs() > MAX_LEVEL_OFFSET {
            continue;
        }
        let wanted: &[&str] = if to_level > map.level_index { &TRANSITION_ASSETS_UP } else { &TRANSITION_ASSETS_DOWN };
        let Some(position) = map.props.iter().position(|candidate| !taken.contains(&candidate.id) && wanted.contains(&candidate.asset_id.as_str())) else {
            continue;
        };
        let prop = &mut map.props[position];
        prop.transition = Some(PropTransition { to_level, label: bounded_text_value(field(Some(level), "label"), 120, "") });
        prop.interactive = true;
        taken.insert(prop.id.clone());
        attached.push(position);
    }
    attached
}

/// `addZone(map, zone)`: `zone` — объект JS `Partial<TacticalZone>`.
pub fn add_zone<'m>(map: &'m mut TacticalMap, zone: &Value) -> MapResult<&'m TacticalZone> {
    let zone = require_object(Some(zone), "kind")?;
    let get = |key: &str| field(zone, key);
    let kind = match get("kind") {
        None | Some(Value::Null) => "interior".to_string(),
        Some(value) => js::s(Some(value)),
    };
    if !ZONE_KINDS.contains(&kind.as_str()) {
        return Err(TacticalMapError::new(format!("Недопустимый вид зоны: {kind}"), "ZONE_KIND_NOT_ALLOWED"));
    }
    if map.zones.len() >= 254 {
        return Err(TacticalMapError::new("Слой зон вмещает не больше 254 зон", "ZONE_BUDGET_EXCEEDED"));
    }
    let material = js::string(get("material"));
    let floor_direction = js::string(get("floorDirection"));
    let mut record = TacticalZone {
        id: bounded_text_value(get("id"), 120, ""),
        kind,
        material: if MATERIALS.contains(&material.as_str()) { material } else { "stone".into() },
        light_level: bounded_text_value(get("lightLevel"), 40, "bright"),
        floor_direction: if FLOOR_DIRECTIONS.contains(&floor_direction.as_str()) { floor_direction } else { "horizontal".into() },
        label: bounded_text_value(get("label"), 120, ""),
        styles: Vec::new(),
    };
    let floor = js::string(get("floor"));
    if FLOOR_STYLES.contains(&floor.as_str()) {
        record.set_floor(Some(floor));
    }
    let wall = js::string(get("wall"));
    if WALL_STYLES.contains(&wall.as_str()) {
        record.set_wall(Some(wall));
    }
    if record.id.is_empty() {
        return Err(TacticalMapError::new("У зоны должен быть идентификатор", "ZONE_ID_REQUIRED"));
    }
    map.zones.push(record);
    Ok(map.zones.last().expect("зона только что добавлена"))
}

/// `addSpawnPoint(map, point)`: `point` — объект JS `{ id, x, y, role }`.
pub fn add_spawn_point<'m>(map: &'m mut TacticalMap, point: &Value) -> MapResult<&'m TacticalSpawnPoint> {
    let point = require_object(Some(point), "role")?;
    let get = |key: &str| field(point, key);
    let role = match get("role") {
        None | Some(Value::Null) => "party".to_string(),
        Some(value) => js::s(Some(value)),
    };
    if !SPAWN_ROLES.contains(&role.as_str()) {
        return Err(TacticalMapError::new(format!("Недопустимая роль точки появления: {role}"), "SPAWN_ROLE_NOT_ALLOWED"));
    }
    let record = TacticalSpawnPoint {
        id: bounded_text_value(get("id"), 120, ""),
        x: bounded_integer(get("x"), 0, 0, REGION.max_width),
        y: bounded_integer(get("y"), 0, 0, REGION.max_height),
        role,
    };
    if record.id.is_empty() {
        return Err(TacticalMapError::new("У точки появления должен быть идентификатор", "SPAWN_ID_REQUIRED"));
    }
    map.spawn_points.push(record);
    Ok(map.spawn_points.last().expect("точка только что добавлена"))
}

// --- обход ----------------------------------------------------------------

/// Ключ клетки `"x,y"` — так JS хранит клетки во множествах.
pub fn position_key(x: i64, y: i64) -> String {
    format!("{x},{y}")
}

/// `reachableCells(map, fromX, fromY, { throughDoors, blockedCells })`:
/// ортогональный обход по проходимым клеткам с учётом рёбер. Открытая и
/// выбитая дверь не мешает; закрытая и запертая — по `blocksMove` своего
/// ребра. Порядок — порядок обхода в ширину, как у `Set` JS.
pub fn reachable_cells(map: &TacticalMap, from_x: i64, from_y: i64, through_doors: bool, blocked_cells: Option<&HashSet<(i64, i64)>>) -> IndexSet<(i64, i64)> {
    let mut reached = IndexSet::new();
    let blocked = |x: i64, y: i64| blocked_cells.is_some_and(|cells| cells.contains(&(x, y)));
    if !cell_passable(map, from_x, from_y) || blocked(from_x, from_y) {
        return reached;
    }
    let door_state: HashMap<&str, &str> = map.doors.iter().map(|door| (door.id.as_str(), door.state.as_str())).collect();
    let length = (map.width * map.height).max(0) as usize;
    let mut visited = vec![false; length];
    let mark = |visited: &mut Vec<bool>, x: i64, y: i64| {
        if let Some(index) = cell_index(map, x, y) {
            visited[index] = true;
        }
    };
    mark(&mut visited, from_x, from_y);
    reached.insert((from_x, from_y));
    let mut queue = vec![(from_x, from_y)];
    let mut head = 0;
    while head < queue.len() {
        let (x, y) = queue[head];
        head += 1;
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            let (nx, ny) = (x + dx, y + dy);
            let Some(index) = cell_index(map, nx, ny) else { continue };
            if visited[index] || blocked(nx, ny) {
                continue;
            }
            if !bit_at(&map.layers.present, index) || !bit_at(&map.layers.passable, index) {
                continue;
            }
            if edge_blocks_move(map, x, y, nx, ny, &door_state, through_doors) {
                continue;
            }
            visited[index] = true;
            reached.insert((nx, ny));
            queue.push((nx, ny));
        }
    }
    reached
}

fn edge_blocks_move(map: &TacticalMap, ax: i64, ay: i64, bx: i64, by: i64, door_state: &HashMap<&str, &str>, through_doors: bool) -> bool {
    let Ok(Some(edge)) = edge_between(map, ax, ay, bx, by) else { return false };
    if edge.kind == EdgeKind::Door {
        if !through_doors {
            return true;
        }
        let state = edge.door_id.as_deref().filter(|id| !id.is_empty()).and_then(|id| door_state.get(id)).copied();
        if matches!(state, Some("open" | "broken")) {
            return false;
        }
    }
    edge.blocks_move
}

/// `doorBlocksStep(map, ax, ay, bx, by)`: мешает ли полотно двери шагнуть
/// прямо сейчас — `closed`, `locked` или `None`.
pub fn door_blocks_step(map: &TacticalMap, ax: i64, ay: i64, bx: i64, by: i64) -> MapResult<Option<&'static str>> {
    let Some(edge) = edge_between(map, ax, ay, bx, by)? else { return Ok(None) };
    if edge.kind != EdgeKind::Door {
        return Ok(None);
    }
    let door = edge.door_id.as_deref().filter(|id| !id.is_empty()).and_then(|id| map.door(id));
    let state = door.map_or("closed", |door| door.state.as_str());
    if matches!(state, "open" | "broken") && door.and_then(TacticalDoor::barricade).is_none() {
        return Ok(None);
    }
    Ok(Some(if state == "locked" { "locked" } else { "closed" }))
}

/// `movementStepBlocked(map, ax, ay, bx, by)`: дверь либо стена между двумя
/// участками пола. Стена вокруг непроходимой клетки не запирает существо.
pub fn movement_step_blocked(map: &TacticalMap, ax: i64, ay: i64, bx: i64, by: i64) -> MapResult<bool> {
    let Some(edge) = edge_between(map, ax, ay, bx, by)? else { return Ok(false) };
    if edge.kind == EdgeKind::Door {
        return Ok(door_blocks_step(map, ax, ay, bx, by)?.is_some());
    }
    Ok(edge.blocks_move && cell_passable(map, ax, ay) && cell_passable(map, bx, by))
}

/// `doorById(map, doorId)`.
pub fn door_by_id<'m>(map: &'m TacticalMap, door_id: &str) -> Option<&'m TacticalDoor> {
    map.door(door_id)
}

/// `doorwayEdgeAt(map, x, y)`: ребро, на которое вешать дверь в проёме, —
/// поперёк прохода.
pub fn doorway_edge_at(map: &TacticalMap, x: i64, y: i64) -> Option<(i64, i64, EdgeDir)> {
    let passable = |cx: i64, cy: i64| cell_passable(map, cx, cy);
    if passable(x - 1, y) && passable(x + 1, y) {
        return Some((x, y, EdgeDir::E));
    }
    if passable(x, y - 1) && passable(x, y + 1) {
        return Some((x, y, EdgeDir::S));
    }
    if passable(x + 1, y) {
        return Some((x, y, EdgeDir::E));
    }
    if passable(x - 1, y) {
        return Some((x - 1, y, EdgeDir::E));
    }
    if passable(x, y + 1) {
        return Some((x, y, EdgeDir::S));
    }
    if passable(x, y - 1) {
        return Some((x, y - 1, EdgeDir::S));
    }
    None
}

/// `doorsReachableFrom(map, x, y)`: двери на любом из четырёх рёбер клетки.
pub fn doors_reachable_from(map: &TacticalMap, x: i64, y: i64) -> Vec<&TacticalDoor> {
    map.doors
        .iter()
        .filter(|door| {
            let (nx, ny) = edge_neighbor(door.x, door.y, door.dir);
            (door.x == x && door.y == y) || (nx == x && ny == y)
        })
        .collect()
}

// --- base64 как у Buffer Node ---------------------------------------------

const BASE64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// `Buffer.from(bytes).toString('base64')`: стандартный алфавит с `=`.
fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let triple = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(BASE64_ALPHABET[(triple >> 18) as usize & 63] as char);
        out.push(BASE64_ALPHABET[(triple >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { BASE64_ALPHABET[(triple >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { BASE64_ALPHABET[triple as usize & 63] as char } else { '=' });
    }
    out
}


/// `Buffer.from(text, 'base64')`: снисходительный разбор Node — строка
/// читается по младшему байту каждой единицы UTF-16 (`н` U+043D — это `=`),
/// посторонние символы пропускаются, `=` заканчивает данные, принимается и
/// URL-алфавит. Проверено на Node 24: `'не base64 !!'` → пусто, `'жAAAA'` →
/// `[232, 0, 0]`.
fn base64_decode(text: &str) -> Vec<u8> {
    js::buffer_from_base64(text)
}

// --- сериализация ---------------------------------------------------------

/// `encodeLayer(array)`: однородный слой — одно число, иначе base64.
fn encode_layer(bytes: &[u8]) -> Value {
    match bytes.first() {
        None => Value::from(0),
        Some(first) if bytes.iter().all(|byte| byte == first) => Value::from(*first),
        Some(_) => Value::String(base64_encode(bytes)),
    }
}

fn encode_signed_layer(bytes: &[i8]) -> Value {
    match bytes.first() {
        None => Value::from(0),
        Some(first) if bytes.iter().all(|byte| byte == first) => Value::from(*first),
        Some(_) => Value::String(base64_encode(&bytes.iter().map(|byte| *byte as u8).collect::<Vec<u8>>())),
    }
}

/// `Number.isInteger(value)` для числа JSON.
fn json_integer(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) => number.as_f64().filter(|number| number.is_finite() && number.fract() == 0.0),
        _ => None,
    }
}

fn decode_unsigned_layer(value: Option<&Value>, expected: usize, label: &str) -> MapResult<Vec<u8>> {
    if let Some(number) = json_integer(value) {
        return Ok(vec![(js::to_int32(number) & 0xff) as u8; expected]);
    }
    let Some(Value::String(text)) = value else {
        return Err(TacticalMapError::new(format!("Слой {label} должен быть строкой base64 или числом"), "LAYER_NOT_ENCODED"));
    };
    let bytes = base64_decode(text);
    if bytes.len() != expected {
        return Err(TacticalMapError::new(format!("Длина слоя {label} равна {}, ожидалось {expected}", bytes.len()), "LAYER_LENGTH_MISMATCH"));
    }
    Ok(bytes)
}

fn decode_signed_layer(value: Option<&Value>, expected: usize, label: &str) -> MapResult<Vec<i8>> {
    if let Some(number) = json_integer(value) {
        return Ok(vec![js::to_int32(number) as u8 as i8; expected]);
    }
    Ok(decode_unsigned_layer(value, expected, label)?.into_iter().map(|byte| byte as i8).collect())
}

/// `encodeEdges(map)`: рёбра двумя массивами байтов. Байт признаков: тип 0–2,
/// blocksMove 3, blocksSight 4, укрытие 5–6, направление 7.
fn encode_edges(map: &TacticalMap) -> Value {
    let list = edge_list(map);
    let mut cells = Vec::with_capacity(list.len() * 2);
    let mut attrs = Vec::with_capacity(list.len());
    let mut doors = Map::new();
    for (index, edge) in list.iter().enumerate() {
        let owner = js::to_int32((edge.y * map.width + edge.x) as f64);
        cells.push((owner & 0xff) as u8);
        cells.push(((owner >> 8) & 0xff) as u8);
        attrs.push(
            (edge.kind.code() & 0b111)
                | if edge.blocks_move { 1 << 3 } else { 0 }
                | if edge.blocks_sight { 1 << 4 } else { 0 }
                | ((edge.cover.code() & 0b11) << 5)
                | if edge.dir == EdgeDir::S { 1 << 7 } else { 0 },
        );
        if let Some(door_id) = edge.door_id.as_deref().filter(|id| !id.is_empty()) {
            doors.insert(index.to_string(), Value::String(door_id.to_string()));
        }
    }
    let mut object = Map::new();
    object.insert("cells".into(), Value::String(base64_encode(&cells)));
    object.insert("attrs".into(), Value::String(base64_encode(&attrs)));
    object.insert("doors".into(), Value::Object(doors));
    Value::Object(object)
}

/// `edgeNeighbor(edge)` над рыхлым ребром первой редакции.
fn legacy_edge(map: &mut TacticalMap, edge: &Value) -> MapResult<()> {
    let edge = require_object(Some(edge), "dir")?;
    let dir = if field(edge, "dir").and_then(Value::as_str) == Some("e") { EdgeDir::E } else { EdgeDir::S };
    let (Some(x), Some(y)) = (integer_coordinate(field(edge, "x")), integer_coordinate(field(edge, "y"))) else {
        return Err(loose_edge_error(field(edge, "x"), field(edge, "y"), dir));
    };
    let (nx, ny) = edge_neighbor(x, y, dir);
    set_edge_json(map, x, y, nx, ny, edge.unwrap_or(&Value::Null))?;
    Ok(())
}

/// `decodeEdges(map, value)`.
fn decode_edges(map: &mut TacticalMap, value: Option<&Value>) -> MapResult<()> {
    let packed = match value {
        Some(Value::Object(packed)) => packed,
        Some(Value::Array(edges)) => {
            for edge in edges {
                legacy_edge(map, edge)?;
            }
            return Ok(());
        }
        _ => return Ok(()),
    };
    let cells = base64_decode(&js::s(packed.get("cells")));
    let attrs = base64_decode(&js::s(packed.get("attrs")));
    if cells.len() != attrs.len() * 2 {
        return Err(TacticalMapError::new("Упакованные рёбра повреждены: длины массивов не согласованы", "EDGE_LAYER_LENGTH_MISMATCH"));
    }
    let doors = packed.get("doors").filter(|doors| doors.is_object() || doors.is_array());
    for (index, attribute) in attrs.iter().copied().enumerate() {
        let owner = i64::from(cells[index * 2]) | (i64::from(cells[index * 2 + 1]) << 8);
        let dir = if attribute & (1 << 7) != 0 { EdgeDir::S } else { EdgeDir::E };
        if map.width == 0 {
            // `owner % 0` — NaN, `owner / 0` — Infinity (или NaN для нуля).
            let y = if owner == 0 { "NaN" } else { "Infinity" };
            return Err(not_adjacent("NaN", y, "NaN", y));
        }
        let (x, y) = (owner % map.width, owner / map.width);
        let (nx, ny) = edge_neighbor(x, y, dir);
        let door_id = match doors {
            Some(Value::Object(doors)) => doors.get(&index.to_string()),
            Some(Value::Array(doors)) => doors.get(index),
            _ => None,
        }
        .and_then(Value::as_str);
        let kind = EdgeKind::from_code(attribute & 0b111).unwrap_or(EdgeKind::Wall);
        let cover = Cover::from_code((attribute >> 5) & 0b11).unwrap_or(Cover::None);
        let patch = EdgePatch {
            kind: Some(kind.as_str()),
            blocks_move: Some(attribute & (1 << 3) != 0),
            blocks_sight: Some(attribute & (1 << 4) != 0),
            cover: Some(cover.as_str()),
            door_id,
        };
        set_edge(map, x, y, nx, ny, &patch)?;
    }
    Ok(())
}

/// `compactProp(prop)`: предмет без полей, равных значению по умолчанию.
fn compact_prop(prop: &TacticalProp) -> Value {
    let mut result = Map::new();
    result.insert("id".into(), Value::String(prop.id.clone()));
    result.insert("assetId".into(), Value::String(prop.asset_id.clone()));
    result.insert("x".into(), js::num(prop.x));
    result.insert("y".into(), js::num(prop.y));
    if prop.rotation != 0.0 {
        result.insert("rotation".into(), js::num(prop.rotation));
    }
    if prop.scale != 1.0 {
        result.insert("scale".into(), js::num(prop.scale));
    }
    if !prop.footprint.is_empty() {
        result.insert("footprint".into(), points_json(&prop.footprint));
    }
    if prop.z_order != 0 {
        result.insert("zOrder".into(), Value::from(prop.z_order));
    }
    if let Some(mount) = &prop.mount {
        result.insert("mount".into(), mount.to_json());
    }
    if prop.blocks_move {
        result.insert("blocksMove".into(), Value::Bool(true));
    }
    if prop.blocks_sight {
        result.insert("blocksSight".into(), Value::Bool(true));
    }
    if prop.cover != Cover::None {
        result.insert("cover".into(), Value::String(prop.cover.as_str().into()));
    }
    if prop.destructible {
        result.insert("destructible".into(), Value::Bool(true));
    }
    if prop.hp != 0 {
        result.insert("hp".into(), Value::from(prop.hp));
    }
    if prop.interactive && prop.interaction.is_none() && prop.transition.is_none() {
        result.insert("interactive".into(), Value::Bool(true));
    }
    if !prop.state.is_empty() {
        result.insert("state".into(), Value::String(prop.state.clone()));
    }
    if let Some(transition) = &prop.transition {
        let mut entry = Map::new();
        entry.insert("toLevel".into(), Value::from(transition.to_level));
        if !transition.label.is_empty() {
            entry.insert("label".into(), Value::String(transition.label.clone()));
        }
        result.insert("transition".into(), Value::Object(entry));
    }
    if let Some(interaction) = prop.interaction.as_ref().filter(|interaction| interaction.point_of_interest) {
        let mut entry = Map::new();
        entry.insert("pointOfInterest".into(), Value::Bool(true));
        if let Some(key) = &interaction.detail_key {
            entry.insert("detailKey".into(), Value::String(key.clone()));
        }
        if let Some(key) = &interaction.reward_key {
            entry.insert("rewardKey".into(), Value::String(key.clone()));
        }
        result.insert("interaction".into(), Value::Object(entry));
    }
    Value::Object(result)
}

/// `serializeTacticalMap(map)`: простой объект для JSON и снимка состояния.
pub fn serialize_tactical_map(map: &TacticalMap) -> MapResult<Value> {
    let catalog_revision = match &map.catalog_revision {
        None => None,
        Some(value) => Some(require_catalog_revision_str(value)?),
    };
    let mut object = Map::new();
    object.insert("version".into(), Value::String(map.version.clone()));
    object.insert("locationId".into(), Value::String(map.location_id.clone()));
    if let Some(revision) = catalog_revision {
        object.insert("catalogRevision".into(), Value::String(revision));
    }
    if map.level_index != 0 {
        object.insert("levelIndex".into(), Value::from(map.level_index));
    }
    if !map.level_label.is_empty() {
        object.insert("levelLabel".into(), Value::String(map.level_label.clone()));
    }
    object.insert("seed".into(), Value::String(map.seed.clone()));
    let mut generator = Map::new();
    generator.insert("id".into(), Value::String(map.generator.id.clone()));
    generator.insert("version".into(), Value::String(map.generator.version.clone()));
    object.insert("generator".into(), Value::Object(generator));
    object.insert("width".into(), Value::from(map.width));
    object.insert("height".into(), Value::from(map.height));
    object.insert("bounds".into(), map.bounds.to_json());
    let layers = &map.layers;
    let mut encoded = Map::new();
    encoded.insert("present".into(), encode_layer(&layers.present));
    encoded.insert("passable".into(), encode_layer(&layers.passable));
    encoded.insert("revealed".into(), encode_layer(&layers.revealed));
    encoded.insert("moveCost".into(), encode_layer(&layers.move_cost));
    encoded.insert("surface".into(), encode_layer(&layers.surface));
    encoded.insert("material".into(), encode_layer(&layers.material));
    encoded.insert("variant".into(), encode_layer(&layers.variant));
    encoded.insert("elevation".into(), encode_signed_layer(&layers.elevation));
    encoded.insert("zoneId".into(), encode_layer(&layers.zone_id));
    object.insert("layers".into(), Value::Object(encoded));
    object.insert("hazards".into(), map.hazards.to_json());
    object.insert("edges".into(), encode_edges(map));
    object.insert("doors".into(), Value::Array(map.doors.iter().map(TacticalDoor::to_json).collect()));
    object.insert("props".into(), Value::Array(map.props.iter().map(compact_prop).collect()));
    object.insert("zones".into(), Value::Array(map.zones.iter().map(TacticalZone::to_json).collect()));
    object.insert("spawnPoints".into(), Value::Array(map.spawn_points.iter().map(TacticalSpawnPoint::to_json).collect()));
    object.insert("combatBounds".into(), map.combat_bounds.as_ref().map_or(Value::Null, Bounds::to_json));
    object.insert("theme".into(), Value::String(map.theme.clone()));
    object.insert("tilesetId".into(), Value::String(map.tileset_id.clone()));
    if let Some(surroundings) = &map.surroundings {
        object.insert("surroundings".into(), surroundings.to_json());
    }
    object.insert("overlays".into(), map.overlays.to_json());
    object.insert("sizeClass".into(), Value::String(map.size_class.clone()));
    object.insert("legacyShape".into(), js::strings_value(map.legacy_shape.iter().cloned()));
    Ok(Value::Object(object))
}

/// `normalizeMapSurroundings(value)`: окрестности карты; неизвестные значения
/// отбрасываются, пустое — `None`.
pub fn normalize_map_surroundings(value: Option<&Value>) -> Option<Surroundings> {
    let raw = match value {
        Some(Value::Object(raw)) => raw,
        _ => return None,
    };
    let mut result = Surroundings::default();
    let biome = js::string(raw.get("biome"));
    if SURROUNDINGS_BIOMES.contains(&biome.as_str()) {
        result.biome = Some(biome);
    }
    let sides = raw.get("sides").and_then(Value::as_object);
    let mut kept = Vec::new();
    for side in ["n", "e", "s", "w"] {
        let biome = js::string(sides.and_then(|sides| sides.get(side)));
        if SURROUNDINGS_BIOMES.contains(&biome.as_str()) {
            kept.push((side.to_string(), biome));
        }
    }
    if !kept.is_empty() {
        result.sides = Some(kept);
    }
    (result.biome.is_some() || result.sides.is_some()).then_some(result)
}

/// Пары `Object.entries(value)` для рыхлого значения: объект, массив или строка.
fn loose_entries(value: Option<&Value>) -> Vec<(String, Value)> {
    match value {
        Some(Value::Object(object)) => js::entries(object).into_iter().map(|(key, item)| (key.clone(), item.clone())).collect(),
        Some(Value::Array(items)) => items.iter().enumerate().map(|(index, item)| (index.to_string(), item.clone())).collect(),
        Some(Value::String(text)) => text.chars().enumerate().map(|(index, ch)| (index.to_string(), Value::String(ch.to_string()))).collect(),
        _ => Vec::new(),
    }
}

/// `deserializeTacticalMap(value)`: карта из сериализованного вида любой
/// редакции; повреждённый слой — отказ, а не молчаливое дополнение.
pub fn deserialize_tactical_map(value: &Value) -> MapResult<TacticalMap> {
    let Value::Object(raw) = value else {
        return Err(TacticalMapError::new("Карта должна быть объектом", "MAP_NOT_OBJECT"));
    };
    let get = |key: &str| raw.get(key);
    let width = bounded_integer(get("width"), 0, 1, REGION.max_width);
    let height = bounded_integer(get("height"), 0, 1, REGION.max_height);
    let length = (width * height) as usize;
    let bits = bitset_length(length);
    let layers = get("layers").filter(|layers| !layers.is_null());
    let catalog_revision = if raw.contains_key("catalogRevision") { Some(require_catalog_revision(get("catalogRevision"))?) } else { None };
    let layer = |key: &str| field(layers, key);
    let decoded = TacticalLayers {
        present: decode_unsigned_layer(layer("present"), bits, "present")?,
        passable: decode_unsigned_layer(layer("passable"), bits, "passable")?,
        revealed: decode_unsigned_layer(layer("revealed"), bits, "revealed")?,
        move_cost: decode_unsigned_layer(layer("moveCost"), length, "moveCost")?,
        surface: decode_unsigned_layer(layer("surface"), length, "surface")?,
        material: decode_unsigned_layer(layer("material"), length, "material")?,
        variant: decode_unsigned_layer(layer("variant"), length, "variant")?,
        elevation: decode_signed_layer(layer("elevation"), length, "elevation")?,
        zone_id: decode_unsigned_layer(layer("zoneId"), length, "zoneId")?,
    };
    let generator = get("generator");
    let overlays = get("overlays");
    let size_class_key = js::string(get("sizeClass"));
    let mut map = TacticalMap {
        version: bounded_text_value(get("version"), 60, TACTICAL_MAP_VERSION),
        location_id: bounded_text_value(get("locationId"), 120, ""),
        catalog_revision,
        level_index: bounded_integer(get("levelIndex"), 0, -MAX_LEVEL_OFFSET, MAX_LEVEL_OFFSET),
        level_label: bounded_text_value(get("levelLabel"), 120, ""),
        seed: bounded_text_value(get("seed"), 200, ""),
        generator: Generator { id: bounded_text_value(field(generator, "id"), 60, "manual"), version: bounded_text_value(field(generator, "version"), 20, "1") },
        width,
        height,
        bounds: Bounds::EMPTY,
        layers: decoded,
        hazards: Hazards::default(),
        edges: EdgeMap::default(),
        doors: Vec::new(),
        props: Vec::new(),
        zones: Vec::new(),
        spawn_points: Vec::new(),
        combat_bounds: None,
        theme: bounded_text_value(get("theme"), 60, ""),
        tileset_id: bounded_text_value(get("tilesetId"), 60, ""),
        overlays: Overlays { compass: js::is_true(field(overlays, "compass")), scale_bar: js::is_true(field(overlays, "scaleBar")), room_labels: Vec::new() },
        surroundings: normalize_map_surroundings(get("surroundings")),
        size_class: if size_class_key_truthy(&size_class_key) { size_class_key } else { size_class_for(width, height).to_string() },
        legacy_shape: match get("legacyShape") {
            Some(Value::Array(shape)) => {
                LEGACY_OPTIONAL_FIELDS.iter().filter(|field| shape.iter().any(|item| item.as_str() == Some(field))).map(|field| field.to_string()).collect()
            }
            _ => LEGACY_OPTIONAL_FIELDS.iter().map(|field| field.to_string()).collect(),
        },
    };
    for (index, hazard) in loose_entries(get("hazards").filter(|hazards| !hazards.is_null())) {
        if let Value::String(hazard) = hazard {
            if !hazard.is_empty() {
                map.hazards.insert(&index, hazard);
            }
        }
    }
    if let Some(Value::Array(zones)) = get("zones") {
        for zone in zones {
            add_zone(&mut map, zone)?;
        }
    }
    decode_edges(&mut map, get("edges"))?;
    if let Some(Value::Array(doors)) = get("doors") {
        for door in doors {
            require_object(Some(door), "x")?;
            let edge = match (integer_coordinate(field(Some(door), "x")), integer_coordinate(field(Some(door), "y")), field(Some(door), "dir").and_then(Value::as_str).and_then(EdgeDir::parse)) {
                (Some(x), Some(y), Some(dir)) => map.edge(x, y, dir),
                _ => None,
            };
            let blocks_move = edge.is_some_and(|edge| edge.blocks_move);
            let blocks_sight = edge.is_some_and(|edge| edge.blocks_sight);
            let mut spread = match door {
                Value::Object(door) => door.clone(),
                _ => Map::new(),
            };
            spread.insert("blocksMove".into(), Value::Bool(blocks_move));
            spread.insert("blocksSight".into(), Value::Bool(blocks_sight));
            set_door(&mut map, &Value::Object(spread))?;
        }
    }
    if let Some(Value::Array(props)) = get("props") {
        for prop in props {
            add_prop(&mut map, prop)?;
        }
    }
    if let Some(Value::Array(points)) = get("spawnPoints") {
        for point in points {
            add_spawn_point(&mut map, point)?;
        }
    }
    if let Some(Value::Array(labels)) = field(overlays, "roomLabels") {
        for label in labels {
            map.overlays.room_labels.push(RoomLabel {
                zone_id: bounded_text_value(field(Some(label), "zoneId"), 120, ""),
                label: bounded_text_value(field(Some(label), "label"), 120, ""),
            });
        }
    }
    if js::truthy(get("combatBounds")) {
        let combat = get("combatBounds");
        let side = |key: &str| bounded_integer(field(combat, key), 0, -1_000, 1_000);
        map.combat_bounds = Some(Bounds { min_x: side("minX"), min_y: side("minY"), max_x: side("maxX"), max_y: side("maxY") });
    }
    recompute_bounds(&mut map);
    Ok(map)
}

/// Сравнение строк, как `<` в JS: по единицам UTF-16.
fn utf16_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn stable_stringify_into(value: &Value, out: &mut String) {
    match value {
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                stable_stringify_into(item, out);
            }
            out.push(']');
        }
        Value::Object(object) => {
            let mut entries: Vec<(&String, &Value)> = object.iter().collect();
            entries.sort_by(|(left, _), (right, _)| utf16_cmp(left, right));
            out.push('{');
            for (index, (key, item)) in entries.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&js::stringify(&Value::String(key.clone())));
                out.push(':');
                stable_stringify_into(item, out);
            }
            out.push('}');
        }
        primitive => out.push_str(&js::stringify(primitive)),
    }
}

/// Детерминированная сериализация для хеша: ключи отсортированы.
pub fn stable_stringify(value: &Value) -> String {
    let mut out = String::new();
    stable_stringify_into(value, &mut out);
    out
}

/// `serializedTacticalMapHash(value)`: хеш уже сериализованной карты.
pub fn serialized_tactical_map_hash(value: &Value) -> String {
    hash::sha256_hex(stable_stringify(value))
}

/// `tacticalMapHash(map)`: ключ кэша рендера и адрес карты.
pub fn tactical_map_hash(map: &TacticalMap) -> MapResult<String> {
    Ok(serialized_tactical_map_hash(&serialize_tactical_map(map)?))
}

// --- валидация ------------------------------------------------------------

/// Замечание проверки карты.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidationIssue {
    pub code: String,
    pub message: String,
    pub at: Option<String>,
}

/// Итог `validateTacticalMap`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidationReport {
    pub ok: bool,
    pub errors: Vec<ValidationIssue>,
}

impl ValidationReport {
    /// Форма JS: `{ ok, errors: [{ code, message, at? }] }`.
    pub fn to_json(&self) -> Value {
        let errors = self
            .errors
            .iter()
            .map(|issue| {
                let mut entry = Map::new();
                entry.insert("code".into(), Value::String(issue.code.clone()));
                entry.insert("message".into(), Value::String(issue.message.clone()));
                if let Some(at) = &issue.at {
                    entry.insert("at".into(), Value::String(at.clone()));
                }
                Value::Object(entry)
            })
            .collect();
        let mut object = Map::new();
        object.insert("ok".into(), Value::Bool(self.ok));
        object.insert("errors".into(), Value::Array(errors));
        Value::Object(object)
    }
}

/// `validateTacticalMap(map)`: структурные замечания списком, без отказа.
pub fn validate_tactical_map(map: &TacticalMap) -> ValidationReport {
    let mut errors = Vec::new();
    let mut fail = |code: &str, message: String, at: Option<&str>| {
        errors.push(ValidationIssue { code: code.into(), message, at: at.filter(|at| !at.is_empty()).map(str::to_string) });
    };
    if map.catalog_revision.as_deref().is_some_and(|revision| !is_safe_catalog_revision_str(revision)) {
        fail("CATALOG_REVISION_INVALID", "catalogRevision должен быть безопасным идентификатором".into(), Some("catalogRevision"));
    }
    let length = (map.width * map.height).max(0) as usize;
    let bits = bitset_length(length);
    let layers = &map.layers;
    let expected: [(&str, usize, usize); 9] = [
        ("present", layers.present.len(), bits),
        ("passable", layers.passable.len(), bits),
        ("revealed", layers.revealed.len(), bits),
        ("moveCost", layers.move_cost.len(), length),
        ("surface", layers.surface.len(), length),
        ("material", layers.material.len(), length),
        ("variant", layers.variant.len(), length),
        ("elevation", layers.elevation.len(), length),
        ("zoneId", layers.zone_id.len(), length),
    ];
    for (name, actual, size) in expected {
        if actual != size {
            fail("LAYER_LENGTH_MISMATCH", format!("Слой {name}: длина {actual}, ожидалось {size}"), Some(name));
        }
    }
    for index in 0..length {
        if !bit_at(&layers.present, index) {
            continue;
        }
        let at = index.to_string();
        if layers.surface.get(index).is_some_and(|code| *code as usize >= SURFACES.len()) {
            fail("ENUM_CODE_OUT_OF_RANGE", format!("surface вне перечисления в клетке {index}"), Some(&at));
        }
        if layers.material.get(index).is_some_and(|code| *code as usize >= MATERIALS.len()) {
            fail("ENUM_CODE_OUT_OF_RANGE", format!("material вне перечисления в клетке {index}"), Some(&at));
        }
        if layers.zone_id.get(index).is_some_and(|code| *code as usize > map.zones.len()) {
            fail("ENUM_CODE_OUT_OF_RANGE", format!("zoneId вне перечисления в клетке {index}"), Some(&at));
        }
        match layers.move_cost.get(index) {
            Some(1 | 2) => {}
            Some(cost) => fail("MOVE_COST_NOT_ALLOWED", format!("moveCost={cost} в клетке {index}"), Some(&at)),
            None => fail("MOVE_COST_NOT_ALLOWED", format!("moveCost=undefined в клетке {index}"), Some(&at)),
        }
    }
    if computed_bounds(map) != map.bounds {
        fail("BOUNDS_MISMATCH", "bounds не совпадает с фактическим охватом слоя present".into(), None);
    }
    let mut door_ids: HashSet<&str> = HashSet::new();
    for door in &map.doors {
        if door_ids.contains(door.id.as_str()) {
            fail("DOOR_ID_NOT_UNIQUE", format!("Дверь {} объявлена дважды", door.id), Some(&door.id));
        }
        door_ids.insert(&door.id);
        match map.edge(door.x, door.y, door.dir) {
            None => fail("DOOR_EDGE_MISSING", format!("Дверь {} стоит на ребре, которого нет", door.id), Some(&door.id)),
            Some(edge) if edge.kind != EdgeKind::Door => {
                fail("DOOR_EDGE_KIND_MISMATCH", format!("Ребро под дверью {} имеет тип {}", door.id, edge.kind.as_str()), Some(&door.id))
            }
            Some(_) => {}
        }
    }
    for edge in edge_list(map) {
        if let Some(door_id) = edge.door_id.as_deref().filter(|id| !id.is_empty()) {
            if !door_ids.contains(door_id) {
                let key = format!("{},{},{}", edge.x, edge.y, edge.dir.as_str());
                fail("EDGE_DOOR_ID_DANGLING", format!("Ребро ссылается на дверь {door_id}, которой нет"), Some(&key));
            }
        }
    }
    let mut occupied: HashMap<(i64, i64), &str> = HashMap::new();
    let mut prop_ids: HashSet<&str> = HashSet::new();
    for prop in &map.props {
        if prop_ids.contains(prop.id.as_str()) {
            fail("PROP_ID_NOT_UNIQUE", format!("Предмет {} объявлен дважды", prop.id), Some(&prop.id));
        }
        prop_ids.insert(&prop.id);
        if prop.transition.as_ref().is_some_and(|transition| transition.to_level == map.level_index) {
            fail("TRANSITION_LEVEL_SAME", format!("Переход {} ведёт на собственный этаж {}", prop.id, map.level_index), Some(&prop.id));
        }
        for cell in &prop.footprint {
            let key = format!("{},{}", cell.x, cell.y);
            match cell_at(map, cell.x, cell.y) {
                None => fail("PROP_FOOTPRINT_ON_MISSING_CELL", format!("Предмет {} занимает несуществующую клетку {key}", prop.id), Some(&prop.id)),
                Some(target) if !target.passable => {
                    fail("PROP_FOOTPRINT_ON_IMPASSABLE", format!("Предмет {} занимает непроходимую клетку {key}", prop.id), Some(&prop.id))
                }
                Some(_) => {}
            }
            match occupied.get(&(cell.x, cell.y)).copied().filter(|previous| !previous.is_empty()) {
                Some(previous) => fail("PROP_FOOTPRINT_OVERLAP", format!("Предметы {previous} и {} занимают клетку {key}", prop.id), Some(&prop.id)),
                None => {
                    occupied.insert((cell.x, cell.y), &prop.id);
                }
            }
        }
    }
    let mut zone_ids: HashSet<&str> = HashSet::new();
    for zone in &map.zones {
        if zone_ids.contains(zone.id.as_str()) {
            fail("ZONE_ID_NOT_UNIQUE", format!("Зона {} объявлена дважды", zone.id), Some(&zone.id));
        }
        zone_ids.insert(&zone.id);
    }
    for point in &map.spawn_points {
        if !cell_passable(map, point.x, point.y) {
            fail("SPAWN_POINT_IMPASSABLE", format!("Точка появления {} стоит на непроходимой клетке", point.id), Some(&point.id));
        }
    }
    // Незнакомый класс (и ключ прототипа) — пределы области.
    let limits = Some(size_class(&map.size_class).unwrap_or(REGION));
    if let Some(limits) = limits {
        if length as i64 > limits.max_cells {
            fail("CELL_BUDGET_EXCEEDED", format!("Клеток {length}, бюджет класса {} — {}", map.size_class, limits.max_cells), None);
        }
        if map.props.len() as i64 > limits.max_props {
            fail("PROP_BUDGET_EXCEEDED", format!("Предметов {}, бюджет — {}", map.props.len(), limits.max_props), None);
        }
        let wall_edges = map.edges.values().filter(|edge| edge.kind == EdgeKind::Wall).count();
        if wall_edges as i64 > limits.max_wall_edges {
            fail("WALL_EDGE_BUDGET_EXCEEDED", format!("Рёбер со стенами {wall_edges}, бюджет — {}", limits.max_wall_edges), None);
        }
    }
    ValidationReport { ok: errors.is_empty(), errors }
}

// --- преобразование из старой формы и обратно -----------------------------

/// Параметры `tacticalMapFromLegacyCells`.
#[derive(Clone, Copy, Debug, Default)]
pub struct LegacyMapOptions<'a> {
    pub location_id: &'a str,
    pub seed: &'a str,
    /// `None` — `{ id: 'dynamic-map', version: '1' }`.
    pub generator: Option<(&'a str, &'a str)>,
    pub tileset_id: &'a str,
}

fn legacy_door_guess(map: &TacticalMap, x: i64, y: i64) -> EdgeDir {
    let east = cell_at(map, x + 1, y);
    let south = cell_at(map, x, y + 1);
    if east.is_none_or(|cell| cell.passable) && south.is_none_or(|cell| !cell.passable) {
        EdgeDir::S
    } else {
        EdgeDir::E
    }
}

fn thin_edge_sides(map: &TacticalMap, x: i64, y: i64, kind: EdgeKind) -> String {
    if !cell_passable(map, x, y) {
        return String::new();
    }
    let mut sides = String::new();
    for (label, nx, ny) in [("e", x + 1, y), ("s", x, y + 1)] {
        if !cell_passable(map, nx, ny) {
            continue;
        }
        if edge_between(map, x, y, nx, ny).ok().flatten().is_some_and(|edge| edge.kind == kind) {
            sides.push_str(label);
        }
    }
    sides
}

/// Целая координата клетки старой формы (`Number.isSafeInteger(Number(cell.x))`).
fn legacy_coordinate(cell: &Map<String, Value>, key: &str) -> Option<i64> {
    let number = js::number(cell.get(key));
    is_safe_integer(number).then_some(number as i64)
}

/// `tacticalMapFromLegacyCells(cells, options)`: старый разреженный массив
/// клеток в карту (`docs/tactical-map-plan.md`, 9). Вода остаётся
/// непроходимой и получает поверхность.
pub fn tactical_map_from_legacy_cells(cells: &[Value], options: &LegacyMapOptions<'_>) -> MapResult<TacticalMap> {
    let source: Vec<(&Map<String, Value>, i64, i64)> = cells
        .iter()
        .filter_map(|cell| {
            let cell = cell.as_object()?;
            let x = legacy_coordinate(cell, "x")?;
            let y = legacy_coordinate(cell, "y")?;
            (x >= 0 && y >= 0).then_some((cell, x, y))
        })
        .collect();
    let width = source.iter().map(|(_, x, _)| x + 1).max().unwrap_or(0);
    let height = source.iter().map(|(_, _, y)| y + 1).max().unwrap_or(0);
    let mut patterns: IndexSet<&str> = IndexSet::new();
    for (cell, ..) in &source {
        if let Some(Value::String(pattern)) = cell.get("pattern") {
            if !pattern.is_empty() {
                patterns.insert(pattern);
            }
        }
    }
    let theme = if patterns.len() == 1 { patterns[0] } else { "" };
    let mut map = create_tactical_map(&TacticalMapOptions {
        width: width.max(1),
        height: height.max(1),
        location_id: options.location_id,
        seed: options.seed,
        generator: Some(options.generator.unwrap_or(("dynamic-map", "1"))),
        theme,
        tileset_id: options.tileset_id,
        catalog_revision: CatalogRevision::Omit,
        ..TacticalMapOptions::default()
    })?;
    map.legacy_shape = LEGACY_OPTIONAL_FIELDS
        .iter()
        .filter(|field| source.iter().any(|(cell, ..)| cell.get(**field).is_some_and(|value| !value.is_null())))
        .map(|field| field.to_string())
        .collect();
    for (cell, x, y) in &source {
        let kind = match cell.get("type") {
            None | Some(Value::Null) => "floor".to_string(),
            Some(value) => js::s(Some(value)),
        };
        let material = js::string(cell.get("material"));
        let patch = CellPatch {
            passable: Some(LEGACY_WALKABLE.contains(&kind.as_str())),
            surface: Some(if kind == "water" { "water" } else { "none" }),
            material: Some(if MATERIALS.contains(&material.as_str()) { &material } else { "stone" }),
            variant: Some(bounded_integer(cell.get("variant"), 0, 0, 255)),
            revealed: Some(js::is_true(cell.get("revealed"))),
            move_cost: Some(1.0),
            elevation: Some(bounded_integer(cell.get("elevation"), 0, -100, 100)),
            ..CellPatch::default()
        };
        set_cell(&mut map, *x, *y, &patch)?;
    }
    for (_, x, y) in &source {
        let (x, y) = (*x, *y);
        if cell_at(&map, x, y).is_none_or(|own| own.passable) {
            continue;
        }
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            if !cell_passable(&map, x + dx, y + dy) {
                continue;
            }
            let patch = EdgePatch { kind: Some("wall"), blocks_move: Some(true), blocks_sight: Some(true), cover: Some("three_quarters"), door_id: None };
            set_edge(&mut map, x, y, x + dx, y + dy, &patch)?;
        }
    }
    for (cell, x, y) in &source {
        let (x, y) = (*x, *y);
        for (key, kind) in [("walls", "wall"), ("windows", "window")] {
            let Some(Value::String(sides)) = cell.get(key) else { continue };
            for side in sides.chars() {
                let (nx, ny) = match side {
                    'e' => (x + 1, y),
                    's' => (x, y + 1),
                    _ => continue,
                };
                if cell_at(&map, nx, ny).is_none() {
                    continue;
                }
                let patch = EdgePatch { kind: Some(kind), blocks_move: Some(true), blocks_sight: Some(kind == "wall"), cover: Some("three_quarters"), door_id: None };
                set_edge(&mut map, x, y, nx, ny, &patch)?;
            }
        }
    }
    for (cell, x, y) in &source {
        if js::string(cell.get("type")) != "door" {
            continue;
        }
        let (x, y) = (*x, *y);
        let east = cell_at(&map, x + 1, y).map(|cell| cell.passable);
        let south = cell_at(&map, x, y + 1).map(|cell| cell.passable);
        let mut dir = EdgeDir::E;
        match cell.get("door_dir").and_then(Value::as_str).and_then(EdgeDir::parse) {
            Some(hint) => dir = hint,
            None => {
                if east.is_none_or(|passable| passable) && south.is_none_or(|passable| !passable) {
                    dir = EdgeDir::S;
                }
            }
        }
        let neighbor = if dir == EdgeDir::E { east } else { south };
        let blocks = neighbor.is_none_or(|passable| !passable);
        let door = serde_json::json!({
            "id": format!("door-{x}-{y}"), "x": x, "y": y, "dir": dir.as_str(), "state": "closed", "blocksMove": blocks, "blocksSight": blocks,
        });
        set_door(&mut map, &door)?;
    }
    for (cell, x, y) in &source {
        let feature = match cell.get("feature") {
            Some(Value::String(feature)) => text::trim(feature),
            _ => "",
        };
        if feature.is_empty() || feature == "enemy" {
            continue;
        }
        let prop = serde_json::json!({
            "id": format!("prop-{x}-{y}"), "assetId": feature, "x": *x as f64 + 0.5, "y": *y as f64 + 0.5, "rotation": 0, "scale": 1,
            "footprint": [{ "x": x, "y": y }], "zOrder": 0,
        });
        add_prop(&mut map, &prop)?;
    }
    let refs: Vec<PropRef> = map.props.iter().map(|prop| PropRef::new(prop.id.clone(), prop.asset_id.clone())).collect();
    let generated = scene_interaction_metadata_for_refs(&map.seed, &refs);
    for prop in &mut map.props {
        let Some(interaction) = generated.get(&prop.id) else { continue };
        prop.interactive = true;
        let mut verbs: Vec<String> = Vec::new();
        for verb in &interaction.verbs {
            let verb = bounded_text(verb, 40, "");
            if !verb.is_empty() && !verbs.contains(&verb) {
                verbs.push(verb);
            }
        }
        verbs.truncate(8);
        prop.interaction = Some(PropInteraction {
            kind: bounded_text(interaction.kind, 40, ""),
            verbs,
            point_of_interest: interaction.point_of_interest,
            detail_key: Some(bounded_text(&interaction.detail_key, 120, "")),
            reward_key: Some(bounded_text(&interaction.reward_key, 120, "")),
        });
    }
    recompute_bounds(&mut map);
    Ok(map)
}

/// `legacyCellsFromTacticalMap(map)`: обратное преобразование; порядок
/// ключей и клеток повторяет выход `generateDynamicSceneMap`.
pub fn legacy_cells_from_tactical_map(map: &TacticalMap) -> Vec<Value> {
    let door_cells: HashSet<(i64, i64)> = map.doors.iter().map(|door| (door.x, door.y)).collect();
    let mut prop_by_cell: HashMap<(i64, i64), &TacticalProp> = HashMap::new();
    for prop in &map.props {
        if prop.footprint.len() != 1 && prop.transition.is_none() {
            continue;
        }
        let (ax, ay) = (prop.x.floor(), prop.y.floor());
        let marker = prop
            .footprint
            .iter()
            .find(|cell| cell.x as f64 == ax && cell.y as f64 == ay)
            .or_else(|| prop.footprint.first())
            .map(|cell| (cell.x, cell.y))
            .or_else(|| (is_safe_integer(ax) && is_safe_integer(ay)).then_some((ax as i64, ay as i64)));
        let Some(key) = marker else { continue };
        let replace = match prop_by_cell.get(&key) {
            None => true,
            Some(previous) => prop.z_order < previous.z_order || (prop.z_order == previous.z_order && utf16_cmp(&prop.id, &previous.id).is_lt()),
        };
        if replace {
            prop_by_cell.insert(key, prop);
        }
    }
    let pattern = if LEGACY_PATTERNS.contains(&map.theme.as_str()) { map.theme.as_str() } else { "" };
    let shape = |field: &str| map.legacy_shape.iter().any(|entry| entry == field);
    let (with_material, with_variant, with_pattern, with_mask) = (shape("material"), shape("variant"), shape("pattern"), shape("edge_mask"));
    let mut result = Vec::new();
    for y in 0..map.height {
        for x in 0..map.width {
            let Some(cell) = cell_at(map, x, y) else { continue };
            let is_door = door_cells.contains(&(x, y));
            let kind = if !cell.passable {
                if cell.surface == "water" {
                    "water"
                } else {
                    "wall"
                }
            } else if is_door {
                "door"
            } else {
                "floor"
            };
            let mut legacy = Map::with_capacity(12);
            legacy.insert("x".into(), Value::from(x));
            legacy.insert("y".into(), Value::from(y));
            legacy.insert("type".into(), Value::String(kind.into()));
            legacy.insert("revealed".into(), Value::Bool(cell.revealed));
            if with_material {
                legacy.insert("material".into(), Value::String(cell.material.into()));
            }
            if with_variant {
                legacy.insert("variant".into(), Value::from(cell.variant));
            }
            if with_pattern && !pattern.is_empty() {
                legacy.insert("pattern".into(), Value::String(pattern.into()));
            }
            if cell.elevation != 0 {
                legacy.insert("elevation".into(), Value::from(cell.elevation));
            }
            if let Some(prop) = prop_by_cell.get(&(x, y)) {
                legacy.insert("feature".into(), Value::String(prop.asset_id.clone()));
            }
            if with_mask {
                legacy.insert("edge_mask".into(), Value::String(legacy_edge_mask(map, x, y)));
            }
            let walls = thin_edge_sides(map, x, y, EdgeKind::Wall);
            if !walls.is_empty() {
                legacy.insert("walls".into(), Value::String(walls));
            }
            let windows = thin_edge_sides(map, x, y, EdgeKind::Window);
            if !windows.is_empty() {
                legacy.insert("windows".into(), Value::String(windows));
            }
            if is_door {
                if let Some(door) = map.doors.iter().find(|door| door.x == x && door.y == y) {
                    if door.dir != legacy_door_guess(map, x, y) {
                        legacy.insert("door_dir".into(), Value::String(door.dir.as_str().into()));
                    }
                }
            }
            result.push(Value::Object(legacy));
        }
    }
    result
}

/// `legacyEdgeMask(map, x, y)`: буква стороны, если соседа нет или клетка
/// проходима, а сосед — нет.
pub fn legacy_edge_mask(map: &TacticalMap, x: i64, y: i64) -> String {
    let Some(own) = cell_at(map, x, y) else { return String::new() };
    let mut edges = String::new();
    for (label, nx, ny) in [("n", x, y - 1), ("e", x + 1, y), ("s", x, y + 1), ("w", x - 1, y)] {
        match cell_at(map, nx, ny) {
            None => edges.push_str(label),
            Some(neighbor) if own.passable && !neighbor.passable => edges.push_str(label),
            Some(_) => {}
        }
    }
    edges
}

// --- поворот карты к дороге -----------------------------------------------

/// `orientTacticalMap(map, side)`: карта, повёрнутая так, чтобы вход у
/// западного края оказался со стороны `side`. Для `west` и неизвестной
/// стороны возвращается та же карта.
pub fn orient_tactical_map(map: TacticalMap, side: &str) -> MapResult<TacticalMap> {
    if !ENTRY_SIDES.contains(&side) || side == "west" {
        return Ok(map);
    }
    let (width, height) = (map.width, map.height);
    let transpose = side == "north" || side == "south";
    let cell = |x: i64, y: i64| match side {
        "east" => (width - 1 - x, y),
        "north" => (y, x),
        _ => (y, width - 1 - x),
    };
    let point = |x: f64, y: f64| match side {
        "east" => (width as f64 - x, y),
        "north" => (y, x),
        _ => (y, width as f64 - x),
    };
    // Поворот предмета: 0° смотрит на юг (+y), 90° — на запад, 180° — на
    // север, 270° — на восток. Зеркало по горизонтали — −θ, транспонирование —
    // 270° − θ, транспонирование с зеркалом по вертикали — 270° + θ (#184;
    // прежде восток и север давали 180° − θ и 90° − θ — на 180° мимо).
    let turn = |degrees: f64| {
        let angle = if degrees.is_nan() { 0.0 } else { degrees };
        let mirrored = match side {
            "east" => -angle,
            "north" => 270.0 - angle,
            _ => 270.0 + angle,
        };
        ((js::round(mirrored) % 360.0) + 360.0) % 360.0
    };
    let rotate_side = |wall: &str| -> &'static str {
        let mapped = match (side, wall) {
            ("east", "n") => "n",
            ("east", "s") => "s",
            ("east", "e") => "w",
            ("east", "w") => "e",
            ("north", "n") => "w",
            ("north", "w") => "n",
            ("north", "s") => "e",
            ("north", "e") => "s",
            (_, "n") => "w",
            (_, "w") => "s",
            (_, "s") => "e",
            (_, "e") => "n",
            _ => "",
        };
        mapped
    };
    let catalog = map.catalog_revision.clone();
    let mut next = create_tactical_map(&TacticalMapOptions {
        width: if transpose { height } else { width },
        height: if transpose { width } else { height },
        location_id: &map.location_id,
        level_index: map.level_index,
        level_label: &map.level_label,
        seed: &map.seed,
        generator: Some((&map.generator.id, &map.generator.version)),
        theme: &map.theme,
        tileset_id: &map.tileset_id,
        size_class: &map.size_class,
        catalog_revision: catalog.as_deref().map_or(CatalogRevision::Omit, CatalogRevision::Value),
        fill: None,
    })?;
    next.zones = map.zones.clone();
    for y in 0..height {
        for x in 0..width {
            let Some(source) = cell_at(&map, x, y) else { continue };
            let (tx, ty) = cell(x, y);
            let patch = CellPatch {
                passable: Some(source.passable),
                move_cost: Some(f64::from(source.move_cost)),
                surface: Some(source.surface),
                hazard_id: Some(source.hazard_id),
                material: Some(source.material),
                elevation: Some(source.elevation),
                zone: Some(source.zone),
                variant: Some(i64::from(source.variant)),
                revealed: Some(source.revealed),
            };
            set_cell(&mut next, tx, ty, &patch)?;
        }
    }
    for edge in edge_list(&map) {
        if edge.kind == EdgeKind::Door {
            continue;
        }
        let (ax, ay) = cell(edge.x, edge.y);
        let (nx, ny) = edge_neighbor(edge.x, edge.y, edge.dir);
        let (bx, by) = cell(nx, ny);
        let patch = EdgePatch {
            kind: Some(edge.kind.as_str()),
            blocks_move: Some(edge.blocks_move),
            blocks_sight: Some(edge.blocks_sight),
            cover: Some(edge.cover.as_str()),
            door_id: None,
        };
        set_edge(&mut next, ax, ay, bx, by, &patch)?;
    }
    for door in &map.doors {
        let (ax, ay) = cell(door.x, door.y);
        let (nx, ny) = edge_neighbor(door.x, door.y, door.dir);
        let (bx, by) = cell(nx, ny);
        let edge = edge_between(&map, door.x, door.y, nx, ny)?;
        let (cx, cy, dir) = canonical_edge(ax, ay, bx, by)?;
        let Value::Object(mut spread) = door.to_json() else { continue };
        spread.insert("x".into(), Value::from(cx));
        spread.insert("y".into(), Value::from(cy));
        spread.insert("dir".into(), Value::String(dir.as_str().into()));
        spread.insert("blocksMove".into(), Value::Bool(edge.is_some_and(|edge| edge.blocks_move)));
        spread.insert("blocksSight".into(), Value::Bool(edge.is_some_and(|edge| edge.blocks_sight)));
        if let Some(barricade) = door.barricade() {
            let (sx, sy) = cell(barricade.side_x, barricade.side_y);
            let Value::Object(mut moved) = barricade.to_json() else { continue };
            moved.insert("side_x".into(), Value::from(sx));
            moved.insert("side_y".into(), Value::from(sy));
            spread.insert("barricade".into(), Value::Object(moved));
        }
        set_door(&mut next, &Value::Object(spread))?;
    }
    next.props = map
        .props
        .iter()
        .map(|prop| {
            let (x, y) = point(prop.x, prop.y);
            let mut moved = prop.clone();
            moved.x = x;
            moved.y = y;
            moved.rotation = turn(prop.rotation);
            moved.footprint = prop.footprint.iter().map(|spot| {
                let (fx, fy) = cell(spot.x, spot.y);
                Point::new(fx, fy)
            }).collect();
            if let Some(PropMount::Wall { side: wall }) = &prop.mount {
                let mapped = rotate_side(wall);
                moved.mount = Some(PropMount::Wall { side: if mapped.is_empty() { wall } else { mapped } });
            }
            moved
        })
        .collect();
    next.spawn_points = map
        .spawn_points
        .iter()
        .map(|spawn| {
            let (x, y) = cell(spawn.x, spawn.y);
            TacticalSpawnPoint { x, y, ..spawn.clone() }
        })
        .collect();
    next.overlays = map.overlays.clone();
    if let Some(surroundings) = &map.surroundings {
        next.surroundings = Some(Surroundings {
            biome: surroundings.biome.clone().filter(|biome| !biome.is_empty()),
            sides: surroundings.sides.as_ref().map(|sides| {
                let mut mapped: Vec<(String, String)> = Vec::new();
                for (key, biome) in sides {
                    let rotated = rotate_side(key);
                    let key = if rotated.is_empty() { key.clone() } else { rotated.to_string() };
                    match mapped.iter_mut().find(|(existing, _)| *existing == key) {
                        Some(entry) => entry.1 = biome.clone(),
                        None => mapped.push((key, biome.clone())),
                    }
                }
                mapped
            }),
        });
    }
    next.legacy_shape = map.legacy_shape.clone();
    Ok(next)
}

// --- клетки сцены для хранилища -------------------------------------------

/// Клетки сцены из карты для хранилища (`sk_store::MapCells`): то же
/// преобразование, что `internalizeMaps` в `server/map-store.mjs` —
/// `legacyCellsFromTacticalMap(deserializeTacticalMap(map))`; отказ разбора —
/// `None` (хранилище кладёт пустой массив, как JS в `catch`).
#[derive(Clone, Copy, Debug, Default)]
pub struct TacticalMapCells;

impl sk_store::MapCells for TacticalMapCells {
    fn cells_from_map(&self, map: &Value) -> Option<Value> {
        let map = deserialize_tactical_map(map).ok()?;
        Some(Value::Array(legacy_cells_from_tactical_map(&map)))
    }
}

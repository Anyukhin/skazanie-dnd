//! Перенос `server/room-floors.mjs`: пол комнаты по её назначению.
//!
//! Генератор строит дом из одного материала, и кухня, горница и кладовая
//! выходили одинаковым настилом. Здесь назначение комнаты превращается в
//! материал клетки (правила его знают: земля, камень, дерево) и в рисунок пола
//! (`zone.floor`), который знает только отрисовка. Стена от пола не зависит:
//! кладка тонкой стены берётся из материала зоны (`zone.material`), а он
//! остаётся материалом постройки.
//!
//! Порядок необязательных ключей зоны повторяет JS: проход ставит `wall`
//! раньше `floor` (новый ключ встаёт в конец объекта), а чтение карты
//! (`addZone`) — наоборот; от порядка зависит адрес карты в хранилище.
//! Модуль детерминирован, модели здесь нет.

use std::sync::LazyLock;

use serde_json::{Map, Value};
use sk_core::fancy_regex::Regex;
use sk_core::indexmap::IndexMap;
use sk_core::text;
use sk_tactical::tactical_map::{self as tm, CellPatch, MapResult, TacticalMap, TacticalZone, FLOOR_STYLES, WALL_STYLES};

pub const ROOM_FLOORS_VERSION: &str = "room-floors/v1";

/// Постройки из экзотического материала держат его и на полу: ледяной дворец не мостят.
const KEEP_ARCHITECTURE: [&str; 3] = ["ice", "metal", "sand"];

/// Правило назначения: первое совпавшее решает. `material` — что увидят
/// правила, `floor` — рисунок поверх (из `FLOOR_STYLES`).
struct Rule {
    test: Regex,
    material: &'static str,
    floor: Option<&'static str>,
    uses: Option<&'static [&'static str]>,
}

fn rule(pattern: &str, material: &'static str, floor: Option<&'static str>, uses: Option<&'static [&'static str]>) -> Rule {
    Rule { test: text::js_regex(pattern, "u").expect("регулярное выражение правила пола"), material, floor, uses }
}

static RULES: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    vec![
        // Камера и темница: голая земля с подстилкой.
        rule(r"камер|темниц|узилищ|карцер|prison|(?<![a-z])cells?(?![a-z])", "earth", Some("straw"), None),
        // Склеп и подземелье: истёртая кладка пола целиком — кроме камер выше.
        rule(r".", "stone", Some("dungeon"), Some(&["crypt", "dungeon"])),
        // Конюшня, хлев, сеновал: утоптанная земля и солома.
        rule(r"конюш|хлев|скотн|сеновал|stable|barn", "earth", Some("straw"), None),
        // Кухня и кузня: камень у огня, дерево горит.
        rule(r"кухн|kitchen|кузн|горн|smithy|forge", "stone", Some("flagstone"), None),
        // Кладовая, склад, оружейная, амбар: земляной пол.
        rule(r"кладов|склад|амбар|сарай|оружейн|store|armory|storehouse", "earth", None, None),
        // Мастерская: каменные плиты под верстаком.
        rule(r"мастерск|столярн|красильн|гончарн|workshop", "stone", Some("flagstone"), None),
        // Салон и приёмная усадьбы: мраморная шашка.
        rule(r"салон|salon|приёмн|гостин|бальный", "marble", Some("checker"), None),
        // Зал усадьбы и кабинет: паркет.
        rule(r"кабинет|study|библиотек", "wood", Some("parquet"), None),
        rule(r"зал|hall|горниц|усадьб|резиденц", "wood", Some("parquet"), Some(&["manor"])),
        // Общий зал трактира и казарма: тёмные затёртые доски.
        rule(r"зал|hall|таверн|постоял|питейн|гостев|казарм|караульн|barracks", "wood", Some("planks-dark"), Some(&["tavern", "barracks"])),
        // Спальня и жильё: обычный настил.
        rule(r"спальн|bedroom|горниц|жиль|дом|living", "wood", None, None),
        // Погреб и подвал: тёсаные плиты.
        rule(r"погреб|подвал|cellar", "stone", Some("flagstone"), None),
        // Храм: неф и алтарная выложены мозаикой.
        rule(r"неф|алтар|святил|часовн|молельн|nave|altar|chapel|sanctum", "marble", Some("mosaic"), Some(&["temple"])),
    ]
});

/// Пол помещения: материал клетки и рисунок (`None` — без рисунка).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoomFloor {
    pub material: String,
    pub floor: Option<String>,
}

impl RoomFloor {
    pub fn new(material: &str, floor: Option<&str>) -> Self {
        Self { material: material.to_string(), floor: floor.map(str::to_string) }
    }

    /// Форма JS: `{ material, floor }`, `floor` — строка или `null`.
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("material".into(), Value::String(self.material.clone()));
        object.insert("floor".into(), self.floor.as_ref().map_or(Value::Null, |floor| Value::String(floor.clone())));
        Value::Object(object)
    }
}

/// Назначение и материал постройки (`{ use = '', architecture = 'wood' }`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RoomContext<'a> {
    /// Назначение постройки (`use`): `tavern`, `manor`, `temple`, …
    pub use_: &'a str,
    pub architecture: &'a str,
}

impl Default for RoomContext<'_> {
    fn default() -> Self {
        Self { use_: "", architecture: "wood" }
    }
}

/// `roomFloorFor(zone, context)`: пол помещения по назначению; `None` —
/// оставить как есть. `label` — подпись зоны (`zone.label ?? ''`).
pub fn room_floor_for(zone_id: &str, label: &str, context: &RoomContext<'_>) -> Option<RoomFloor> {
    if KEEP_ARCHITECTURE.contains(&context.architecture) {
        return None;
    }
    let source = text::lower(&format!("{zone_id} {label}"));
    for rule in RULES.iter() {
        if rule.uses.is_some_and(|uses| !uses.contains(&context.use_)) {
            continue;
        }
        if !text::test(&rule.test, &source) {
            continue;
        }
        // В каменном и мраморном доме земляной пол кладовой — тёсаный камень:
        // глинобитный пол бывает у сруба, а не у палат.
        if rule.material == "earth" && rule.floor.is_none() && context.architecture != "wood" {
            return Some(RoomFloor::new("stone", Some("flagstone")));
        }
        return Some(RoomFloor::new(rule.material, rule.floor));
    }
    None
}

/// `buildingWallStyleFor({ use, architecture, urban })`: вид кладки постройки
/// (`zone.wall`). Сруб в городе — фахверк, каменная кузня и мастерская —
/// кирпич; остальные стены рисуются по материалу.
pub fn building_wall_style_for(context: &RoomContext<'_>, urban: bool) -> Option<&'static str> {
    if context.architecture == "wood" && urban && ["tavern", "manor", "shop"].contains(&context.use_) {
        return Some("fachwerk");
    }
    if context.architecture == "stone" && ["smithy", "workshop"].contains(&context.use_) {
        return Some("brick");
    }
    None
}

/// Параметры `applyRoomFloors(map, options)`.
#[derive(Clone, Copy, Default)]
pub struct RoomFloorsOptions<'a> {
    pub context: RoomContext<'a>,
    /// Вид кладки всех помещений постройки (`WALL_STYLES`); незнакомый не ставится.
    pub wall: Option<&'a str>,
    /// Пол помещения, для которого правила назначения молчат.
    pub default_floor: Option<&'a RoomFloor>,
    /// Какие зоны красить; `None` — все.
    pub zones: Option<&'a dyn Fn(&TacticalZone) -> bool>,
}

/// `applyRoomFloors(map, options)`: красит пол помещений карты по назначению.
/// Вызывается после тонких стен; непроходимые клетки не трогаются. Возвращает,
/// сколько помещений получили свой пол. Незнакомый материал запасного пола —
/// отказ `setCell`, как в JS (рисунки зон к этому времени уже правлены).
pub fn apply_room_floors(map: &mut TacticalMap, options: &RoomFloorsOptions<'_>) -> MapResult<usize> {
    let mut chosen: IndexMap<String, RoomFloor> = IndexMap::new();
    for zone in map.zones.iter_mut() {
        if zone.kind != "interior" || zone.id == "walls" || options.zones.is_some_and(|accept| !accept(zone)) {
            continue;
        }
        if let Some(wall) = options.wall.filter(|wall| WALL_STYLES.contains(wall)) {
            zone.set_wall(Some(wall.to_string()));
        }
        let floor = room_floor_for(&zone.id, &zone.label, &options.context).or_else(|| options.default_floor.cloned());
        let Some(floor) = floor else { continue };
        match floor.floor.as_deref().filter(|style| FLOOR_STYLES.contains(style)) {
            Some(style) => zone.set_floor(Some(style.to_string())),
            None => zone.set_floor(None),
        }
        chosen.insert(zone.id.clone(), floor);
    }
    if chosen.is_empty() {
        return Ok(0);
    }
    for y in 0..map.height {
        for x in 0..map.width {
            let Some(cell) = tm::cell_at(map, x, y) else { continue };
            if !cell.passable {
                continue;
            }
            let Some(floor) = chosen.get(cell.zone) else { continue };
            if cell.material != floor.material {
                tm::set_cell(map, x, y, &CellPatch { material: Some(&floor.material), ..CellPatch::default() })?;
            }
        }
    }
    Ok(chosen.len())
}

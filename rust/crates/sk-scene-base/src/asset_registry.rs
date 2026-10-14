//! Перенос `server/asset-registry.mjs`: реестр ассетов — единственное место,
//! которое знает, чем рисуется предмет (`docs/tactical-map-plan.md`, Р3).
//!
//! Карта хранит только `assetId`. Рендер спрашивает реестр и получает
//! векторный рисунок, растровый спрайт или ничего. Растр (`raster`,
//! `rightsId`) доклеивается из манифеста атласа: единственный источник растра —
//! сам атлас. Атласы предметов и набора детализации и реестр прав
//! (`data/asset-rights.json`) встроены в сборку (`include_str!`); функции
//! чтения по пути читают файл с диска, как JS.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::detail_props::{ScaleRange, DETAIL_PROPS};
use crate::util::{js_index_truthy, number_or_zero, repo_root, str_of};

pub const ASSET_KINDS: [&str; 5] = ["prop", "floor_tile", "wall_segment", "door_leaf", "decal"];

/// Якорь влияет на расстановку: `wall` тянет предмет к стене и разворачивает
/// лицом внутрь помещения, `corner` — в угол, `center` — свободно.
pub const ASSET_ANCHORS: [&str; 3] = ["center", "wall", "corner"];

pub const ASSET_COVER_LEVELS: [&str; 3] = ["none", "half", "three_quarters"];

/// Ошибка реестра с кодом (`AssetRegistryError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetRegistryError {
    pub code: String,
    pub message: String,
}

impl AssetRegistryError {
    pub fn new(message: impl Into<String>, code: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

impl fmt::Display for AssetRegistryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AssetRegistryError {}

/// Сколько клеток предмет занимает по умолчанию (числа JS).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct AssetFootprint {
    #[serde(serialize_with = "crate::util::ser_js_number")]
    pub w: f64,
    #[serde(serialize_with = "crate::util::ser_js_number")]
    pub h: f64,
}

/// Запись реестра. Порядок полей — порядок ключей объекта JS.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetEntry {
    pub id: String,
    /// Значение из `ASSET_KINDS`.
    pub kind: String,
    /// В каких темах допустим.
    pub themes: Vec<String>,
    /// Сколько клеток занимает по умолчанию.
    pub base_footprint: AssetFootprint,
    /// Значение из `ASSET_ANCHORS`.
    pub anchor: String,
    /// Идентификатор векторного рисунка.
    pub vector: String,
    /// Путь к спрайту в атласе.
    #[serde(default)]
    pub raster: Option<String>,
    /// Запись в `data/asset-rights.json`, обязательна для растра.
    #[serde(default)]
    pub rights_id: Option<String>,
    pub blocks_move: bool,
    pub blocks_sight: bool,
    /// Значение из `ASSET_COVER_LEVELS`.
    pub cover: String,
    pub destructible: bool,
    #[serde(serialize_with = "crate::util::ser_js_number")]
    pub hp: f64,
    pub interactive: bool,
    /// Допустимый разброс масштаба.
    pub scale_range: ScaleRange,
}

impl AssetEntry {
    /// Форма JSON, которую пишет JS.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }

    fn kind(mut self, kind: &str) -> Self {
        self.kind = kind.into();
        self
    }

    fn themes(mut self, parts: &[&[&str]]) -> Self {
        self.themes = parts.iter().flat_map(|part| part.iter().map(|theme| theme.to_string())).collect();
        self
    }

    fn fp(mut self, w: i32, h: i32) -> Self {
        self.base_footprint = AssetFootprint { w: f64::from(w), h: f64::from(h) };
        self
    }

    fn anchor(mut self, anchor: &str) -> Self {
        self.anchor = anchor.into();
        self
    }

    fn blocks_move(mut self) -> Self {
        self.blocks_move = true;
        self
    }

    fn blocks_sight(mut self) -> Self {
        self.blocks_sight = true;
        self
    }

    fn cover(mut self, cover: &str) -> Self {
        self.cover = cover.into();
        self
    }

    fn destructible(mut self) -> Self {
        self.destructible = true;
        self
    }

    fn hp(mut self, hp: f64) -> Self {
        self.hp = hp;
        self
    }

    fn interactive(mut self) -> Self {
        self.interactive = true;
        self
    }

    fn scale(mut self, min: f64, max: f64) -> Self {
        self.scale_range = ScaleRange { min, max };
        self
    }
}

const BUILDING: &[&str] = &["building", "tavern", "house", "interior"];
const YARD: &[&str] = &["building", "tavern", "house", "yard", "exterior"];
/// Темы этапа M6. Метка `interior` принадлежит теме здания и общим видом
/// помещения не является; у храма, склепа и пещеры метка своя.
/// Растительность двора переиспользуется лесом и дорогой осознанно.
const TEMPLE: &[&str] = &["temple"];
// Подземелье и кладбище берут склеповые предметы (кости, надгробия,
// жаровни), а кладбище — ещё и уличную растительность.
const CRYPT: &[&str] = &["crypt", "dungeon", "graveyard"];
const CAVE: &[&str] = &["cave"];
const WILD: &[&str] = &["forest", "road", "settlement", "exterior", "graveyard"];

/// Короткая запись: всё, что не указано, берёт значения по умолчанию.
fn entry(id: &str) -> AssetEntry {
    AssetEntry {
        id: id.into(),
        kind: "prop".into(),
        themes: BUILDING.iter().map(|theme| theme.to_string()).collect(),
        base_footprint: AssetFootprint { w: 1.0, h: 1.0 },
        anchor: "center".into(),
        vector: id.into(),
        raster: None,
        rights_id: None,
        blocks_move: false,
        blocks_sight: false,
        cover: "none".into(),
        destructible: false,
        hp: 0.0,
        interactive: false,
        scale_range: ScaleRange { min: 0.9, max: 1.1 },
    }
}

/// Тема проёмов. Рендер выбирает запись по виду ребра и состоянию двери, а не
/// по теме сцены: отдельная тема — способ **не** попасть в каталог расстановки.
pub const OPENINGS_THEME: &str = "openings";

fn opening(id: &str, kind: &str) -> AssetEntry {
    entry(id).kind(kind).themes(&[&[OPENINGS_THEME]]).fp(0, 0).anchor("wall")
}

/// Проёмы на рёбрах.
#[rustfmt::skip]
fn openings() -> Vec<AssetEntry> {
    vec![
        opening("door_closed", "door_leaf").interactive().destructible().hp(15.0),
        opening("door_open", "door_leaf").interactive().destructible().hp(15.0),
        opening("door_iron", "door_leaf").interactive().destructible().hp(30.0),
        opening("door_broken", "door_leaf"),
        opening("window_glazed", "wall_segment").destructible().hp(4.0),
        opening("arrow_slit", "wall_segment"),
        opening("rail_fence", "wall_segment").destructible().hp(8.0),
        opening("ledge_step", "wall_segment"),
        opening("portcullis_gate", "wall_segment").interactive().destructible().hp(40.0),
    ]
}

/// Набор под тему «здание с участком» и остальные темы. Записи объявлены
/// **без растра**: поле `raster` доклеивается из манифеста атласа.
#[rustfmt::skip]
fn declared() -> Vec<AssetEntry> {
    let mut entries = vec![
        // --- Мебель общего зала ---------------------------------------------
        // `interactive` у мебели и убранства — это не «здесь спрятана награда», а
        // «с этим предметом сервер умеет работать»: справочник опасностей
        // (`scene-hazards.mjs`) объявил его тяжёлым или горючим, а каталог
        // взаимодействий (`scene-interactions.mjs`) знает его вид. Флаг и каталог
        // обязаны совпадать — сторож `test/scene-hazards.test.mjs`.
        // Масштаб рисунка сохраняется в новой карте отдельно от игровой площади.
        // Размеры мебели согласованы с человеческой фигуркой высотой около 1.2 клетки.
        entry("table_round").fp(2, 2).blocks_move().cover("half").destructible().hp(12.0).interactive().scale(0.65, 0.75),
        entry("table_long").fp(3, 1).blocks_move().cover("half").destructible().hp(15.0).interactive().scale(0.90, 1.0),
        entry("table_royal").themes(&[&["royal"]]).fp(5, 2).blocks_move().cover("half").destructible().hp(30.0).interactive(),
        entry("royal_throne").themes(&[&["royal"]]).fp(2, 2).blocks_move().cover("half").destructible().hp(25.0).interactive(),
        entry("table_small").blocks_move().cover("half").destructible().hp(8.0).interactive().scale(0.75, 0.85),
        entry("bench").fp(2, 1).anchor("wall").destructible().hp(8.0).interactive(),
        entry("chair").destructible().hp(5.0).scale(0.42, 0.50),
        entry("stool").destructible().hp(4.0).scale(0.33, 0.42),
        entry("bar_counter").fp(4, 1).anchor("wall").blocks_move().cover("three_quarters").destructible().hp(25.0).interactive(),
        entry("bar_shelf").fp(3, 1).anchor("wall").blocks_move().blocks_sight().cover("three_quarters").interactive(),
        entry("fireplace").fp(2, 1).anchor("wall").blocks_move().blocks_sight().cover("three_quarters").interactive(),
        entry("hearth_fire").anchor("wall").interactive().scale(0.8, 1.2),
        entry("cauldron").anchor("wall").interactive().destructible().hp(10.0),
        entry("firewood_stack").anchor("wall").blocks_move().cover("half").destructible().hp(8.0).interactive(),

        // --- Хранение и утварь ----------------------------------------------
        entry("barrel").anchor("wall").blocks_move().cover("half").destructible().hp(10.0).interactive().scale(0.85, 1.15),
        entry("barrel_stack").fp(2, 1).anchor("wall").blocks_move().blocks_sight().cover("three_quarters").destructible().hp(18.0).interactive(),
        entry("keg").anchor("wall").blocks_move().cover("half").destructible().hp(8.0).interactive(),
        entry("crate").anchor("wall").blocks_move().cover("half").destructible().hp(10.0).interactive().scale(0.85, 1.15),
        entry("crate_stack").fp(2, 1).anchor("corner").blocks_move().blocks_sight().cover("three_quarters").destructible().hp(16.0).interactive(),
        entry("sack").anchor("wall").destructible().hp(4.0).scale(0.8, 1.2),
        entry("basket").anchor("wall").destructible().hp(3.0).interactive().scale(0.8, 1.2),
        entry("bucket").scale(0.8, 1.1),
        entry("chest").anchor("wall").blocks_move().cover("half").destructible().hp(14.0).interactive(),
        entry("cupboard").anchor("wall").blocks_move().blocks_sight().cover("three_quarters").interactive(),
        entry("wardrobe").fp(2, 1).anchor("wall").blocks_move().blocks_sight().cover("three_quarters").interactive(),
        entry("bookshelf").fp(2, 1).anchor("wall").blocks_move().blocks_sight().cover("three_quarters").interactive(),
        entry("shelf_wall").fp(2, 1).anchor("wall").interactive(),
        entry("broom").anchor("corner").interactive().scale(0.9, 1.05),

        // --- Мелочь на столах: футпринт пуст, предмет ничего не занимает -----
        entry("mug").fp(0, 0).scale(0.35, 0.48),
        entry("plate").fp(0, 0).scale(0.65, 0.85),
        entry("bowl_stew").fp(0, 0).scale(0.8, 1.1),
        entry("bottle").fp(0, 0).scale(0.24, 0.34),
        entry("jug").fp(0, 0).scale(0.8, 1.15),
        entry("bread_loaf").fp(0, 0).scale(0.8, 1.2),
        entry("cheese_wheel").fp(0, 0).scale(0.8, 1.15),
        entry("candle").fp(0, 0).scale(0.8, 1.1),
        entry("dice_cup").fp(0, 0).scale(0.85, 1.05),
        entry("coin_pile").fp(0, 0).interactive().scale(0.8, 1.2),
        entry("lute").fp(0, 0).interactive(),
        entry("cutting_board").fp(0, 0),
        entry("pot").fp(0, 0).scale(0.8, 1.15),

        // --- Спальные помещения ---------------------------------------------
        entry("bed").fp(2, 1).anchor("wall").blocks_move().cover("half").destructible().hp(10.0).interactive(),
        entry("bunk_bed").fp(2, 1).anchor("wall").blocks_move().blocks_sight().cover("three_quarters").interactive(),
        entry("night_table").anchor("wall").destructible().hp(5.0),
        entry("washbasin").anchor("wall"),

        // --- Освещение и убранство ------------------------------------------
        entry("torch_wall").kind("decal").fp(0, 0).anchor("wall").interactive(),
        entry("lantern_wall").kind("decal").fp(0, 0).anchor("wall").interactive(),
        entry("candelabra").destructible().hp(4.0),
        // Подвешенный реквизит имеет отдельный server-owned профиль swing в
        // `scene-hazards.mjs`; сам asset остаётся обычным декоративным prop.
        entry("chandelier").fp(0, 0).interactive().scale(0.9, 1.15),
        entry("banner").kind("decal").fp(0, 0).anchor("wall").interactive(),
        entry("sign_board").kind("decal").fp(0, 0).anchor("wall"),
        entry("rug").kind("decal").fp(0, 0).interactive().scale(0.9, 1.3),
        entry("floor_stain").kind("decal").fp(0, 0).scale(0.7, 1.4),

        // --- Переходы --------------------------------------------------------
        entry("stairs_up").fp(2, 1).anchor("wall").interactive(),
        entry("stairs_down").fp(2, 1).anchor("wall").interactive(),
        entry("trapdoor").kind("decal").fp(0, 0).interactive(),

        // --- Внешняя территория ---------------------------------------------
        entry("tree_oak").themes(&[YARD, WILD]).fp(2, 2).blocks_move().blocks_sight().cover("three_quarters").destructible().hp(40.0).scale(0.8, 1.4),
        entry("tree_pine").themes(&[YARD, WILD]).fp(2, 2).blocks_move().blocks_sight().cover("three_quarters").destructible().hp(30.0).scale(0.8, 1.5),
        entry("tree_birch").themes(&[YARD, WILD]).blocks_move().blocks_sight().cover("half").destructible().hp(22.0).scale(0.85, 1.35),
        entry("tree_dead").themes(&[YARD, WILD]).blocks_move().cover("half").destructible().hp(18.0).scale(0.8, 1.3),
        entry("tree_stump").themes(&[YARD, WILD]).cover("half").scale(0.8, 1.2),
        entry("bush").themes(&[YARD, WILD]).blocks_sight().cover("half").scale(0.75, 1.35),
        entry("shrub").themes(&[YARD, WILD]).cover("half").scale(0.75, 1.3),
        entry("grass_tuft").themes(&[YARD, WILD]).kind("decal").fp(0, 0).scale(0.7, 1.4),
        entry("flowers").themes(&[YARD, WILD]).kind("decal").fp(0, 0).scale(0.7, 1.3),
        entry("rock_small").themes(&[YARD, WILD]).cover("half").scale(0.7, 1.3),
        entry("boulder").themes(&[YARD, WILD]).blocks_move().blocks_sight().cover("three_quarters").scale(0.85, 1.4),
        entry("woodpile").themes(&[YARD, WILD]).anchor("wall").fp(2, 1).blocks_move().cover("half").destructible().hp(12.0).interactive(),
        entry("cart").themes(&[YARD, WILD]).fp(2, 1).blocks_move().cover("half").destructible().hp(20.0).interactive(),
        entry("wagon_wheel").themes(&[YARD, WILD]).anchor("wall").cover("half").destructible().hp(6.0),
        entry("hitching_post").themes(&[YARD, WILD]).interactive(),
        entry("water_trough").themes(&[YARD, WILD]).fp(2, 1).blocks_move().cover("half"),
        entry("well").themes(&[YARD, WILD]).fp(2, 2).blocks_move().cover("half").interactive(),
        entry("lamp_post").themes(&[YARD, WILD]).interactive(),
        entry("signpost").themes(&[YARD, WILD]).interactive(),
        entry("haystack").themes(&[YARD, WILD]).fp(2, 2).blocks_move().blocks_sight().cover("three_quarters").destructible().hp(10.0).interactive().scale(0.85, 1.25),
        entry("path_stone").themes(&[YARD, WILD]).kind("decal").fp(0, 0).scale(0.7, 1.3),
        entry("campfire").themes(&[YARD, WILD]).interactive(),

        // --- Храм --------------------------------------------------------------
        entry("pillar").themes(&[TEMPLE]).blocks_move().blocks_sight().cover("three_quarters").interactive(),
        entry("altar").themes(&[TEMPLE, CRYPT]).fp(2, 1).anchor("wall").blocks_move().cover("half").interactive(),
        entry("statue").themes(&[TEMPLE, CRYPT]).blocks_move().blocks_sight().cover("three_quarters").interactive(),
        entry("brazier").themes(&[TEMPLE, CRYPT]).interactive().destructible().hp(6.0),
        entry("offering_bowl").themes(&[TEMPLE]).fp(0, 0).scale(0.8, 1.1),
        entry("prayer_bench").themes(&[TEMPLE]).fp(2, 1).anchor("wall").destructible().hp(8.0).interactive(),
        entry("temple_banner").themes(&[TEMPLE]).kind("decal").fp(0, 0).anchor("wall").interactive(),
        entry("reliquary").themes(&[TEMPLE]).anchor("wall").blocks_move().cover("half").interactive(),
        entry("mosaic").themes(&[TEMPLE]).kind("decal").fp(0, 0).scale(0.9, 1.4),

        // --- Склеп -------------------------------------------------------------
        entry("sarcophagus").themes(&[CRYPT]).fp(2, 1).blocks_move().cover("half").interactive().destructible().hp(25.0),
        entry("grave").themes(&[CRYPT]).fp(2, 1).anchor("wall").cover("half"),
        entry("bone_pile").themes(&[CRYPT, CAVE]).fp(0, 0).scale(0.7, 1.3),
        entry("urn").themes(&[CRYPT]).anchor("wall").destructible().hp(4.0),
        entry("crypt_niche").themes(&[CRYPT]).anchor("wall").blocks_move().blocks_sight().cover("three_quarters"),
        entry("cobweb").themes(&[CRYPT, CAVE]).kind("decal").fp(0, 0).anchor("corner").interactive(),

        // --- Пещера ------------------------------------------------------------
        entry("stalagmite").themes(&[CAVE]).blocks_move().cover("half").scale(0.7, 1.5),
        entry("cave_pool").themes(&[CAVE]).fp(2, 2).blocks_move().cover("none"),
        entry("mushroom_cluster").themes(&[CAVE]).fp(0, 0).scale(0.7, 1.4),
        entry("ore_vein").themes(&[CAVE]).kind("decal").fp(0, 0).anchor("wall").interactive(),
        entry("rubble_heap").themes(&[CAVE]).cover("half").scale(0.8, 1.3),

        // --- Лес, дорога, поселение --------------------------------------------
        entry("tree_spruce").themes(&[WILD]).fp(2, 2).blocks_move().blocks_sight().cover("three_quarters").destructible().hp(35.0).scale(0.8, 1.4),
        entry("fallen_log").themes(&[WILD]).fp(2, 1).cover("half"),
        entry("fern").themes(&[WILD]).kind("decal").fp(0, 0).scale(0.7, 1.3),
        entry("milestone").themes(&[WILD]).anchor("wall").cover("half"),
        entry("roadside_shrine").themes(&[WILD]).anchor("wall").blocks_move().cover("half").interactive(),
        entry("market_stall").themes(&[&["settlement"], &["exterior"]]).fp(2, 2).blocks_move().cover("half").interactive(),
        entry("village_fence").themes(&[&["settlement"], &["exterior"]]).fp(2, 1).anchor("wall").cover("half"),

        // --- Проёмы на рёбрах ----------------------------------------------------
        // Ребро — не клетка (решение Р2): эти записи ничего не занимают, никого не
        // держат и укрытия не дают. Проходимость, обзор и укрытие задаёт само ребро,
        // а запись отвечает только за рисунок.
        //
        // Тема у них своя — `openings`. В темы помещений они не входят намеренно:
        // расстановка предметов берёт каталог по теме (`prop-placement.mjs`), и
        // дверь, попавшая в этот каталог, встала бы посреди зала как мебель.
    ];
    entries.extend(openings());
    entries
}

/// Манифест растрового атласа предметов (`tools/build-prop-atlas.mjs`).
/// Отсутствие атласа — не ошибка: реестр остаётся векторным (решение Р6).
pub static PROP_ATLAS_FILE: LazyLock<PathBuf> = LazyLock::new(|| repo_root().join("public/assets/maps/props/prop-atlas.json"));

/// Атлас набора детализации (`public/assets/maps/detail-v1`).
pub static DETAIL_ATLAS_FILE: LazyLock<PathBuf> = LazyLock::new(|| repo_root().join("public/assets/maps/detail-v1/prop-atlas.json"));
const DETAIL_ATLAS_DIR: &str = "maps/detail-v1/";

/// Реестр прав на ассеты (путь по умолчанию у `registeredRightsIds`).
pub static ASSET_RIGHTS_FILE: LazyLock<PathBuf> = LazyLock::new(|| repo_root().join("data/asset-rights.json"));

const PROP_ATLAS_JSON: &str = include_str!("../../../../public/assets/maps/props/prop-atlas.json");
const DETAIL_ATLAS_JSON: &str = include_str!("../../../../public/assets/maps/detail-v1/prop-atlas.json");
const ASSET_RIGHTS_JSON: &str = include_str!("../../../../data/asset-rights.json");

/// Манифест атласа: путь картинки внутри `public/assets` (он же `rightsId`),
/// размер клетки и кадры по идентификатору предмета.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PropAtlas {
    pub image: String,
    #[serde(serialize_with = "crate::util::ser_js_number")]
    pub cell_pixels: f64,
    /// Кадры, как в манифесте.
    pub frames: Value,
}

impl PropAtlas {
    fn empty() -> Self {
        Self { image: String::new(), cell_pixels: 0.0, frames: Value::Object(Map::new()) }
    }

    /// Форма JSON, которую пишет JS.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

/// Разбор текста манифеста атласа — терпимо: битый JSON и пустой набор кадров
/// дают пустой атлас.
pub fn parse_prop_atlas(text: &str) -> PropAtlas {
    let Ok(raw) = serde_json::from_str::<Value>(text) else { return PropAtlas::empty() };
    let image = str_of(raw.get("image"));
    // `raw.frames && typeof raw.frames === 'object'`: массив — тоже объект.
    let frames = match raw.get("frames") {
        Some(frames @ (Value::Object(_) | Value::Array(_))) => frames.clone(),
        _ => Value::Object(Map::new()),
    };
    let frame_count = match &frames {
        Value::Object(map) => map.len(),
        Value::Array(items) => items.len(),
        _ => 0,
    };
    if image.is_empty() || frame_count == 0 {
        return PropAtlas::empty();
    }
    PropAtlas { image, cell_pixels: number_or_zero(raw.get("cellPixels")), frames }
}

fn read_text(file: &Path) -> Option<String> {
    std::fs::read(file).ok().map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

/// `readPropAtlas(file)`: `None` — встроенный атлас предметов (копия
/// `PROP_ATLAS_FILE` на момент сборки), путь — чтение файла. Нет файла —
/// пустой атлас.
pub fn read_prop_atlas(file: Option<&Path>) -> PropAtlas {
    match file {
        None => parse_prop_atlas(PROP_ATLAS_JSON),
        Some(path) => read_text(path).map(|text| parse_prop_atlas(&text)).unwrap_or_else(PropAtlas::empty),
    }
}

/// Манифест набора детализации называет картинку по имени файла рядом с
/// собой; путь доводится до пути внутри `public/assets`.
fn detail_atlas_from(atlas: PropAtlas) -> PropAtlas {
    if atlas.image.is_empty() || atlas.image.contains('/') {
        return atlas;
    }
    PropAtlas { image: format!("{DETAIL_ATLAS_DIR}{}", atlas.image), ..atlas }
}

/// `readDetailAtlas(file)`: `None` — встроенный атлас набора детализации.
pub fn read_detail_atlas(file: Option<&Path>) -> PropAtlas {
    match file {
        None => detail_atlas_from(parse_prop_atlas(DETAIL_ATLAS_JSON)),
        Some(path) => detail_atlas_from(read_prop_atlas(Some(path))),
    }
}

/// Растр приклеивается к записи по идентификатору кадра; запись без кадра
/// теряет `raster` и `rightsId`, даже если они у неё были.
pub fn with_atlas_art(entries: &[AssetEntry], atlas: &PropAtlas) -> Vec<AssetEntry> {
    entries
        .iter()
        .map(|record| {
            let mut record = record.clone();
            if !atlas.image.is_empty() && js_index_truthy(&atlas.frames, &record.id) {
                record.raster = Some(format!("{}#{}", atlas.image, record.id));
                record.rights_id = Some(atlas.image.clone());
            } else {
                record.raster = None;
                record.rights_id = None;
            }
            record
        })
        .collect()
}

/// Предметы набора детализации: векторное имя — их прежний двойник.
fn detail_declared() -> Vec<AssetEntry> {
    DETAIL_PROPS
        .iter()
        .map(|record| {
            let mut asset = entry(record.id);
            asset.kind = record.kind.into();
            asset.themes = record.themes.iter().map(|theme| theme.to_string()).collect();
            asset.base_footprint = AssetFootprint { w: record.footprint.w as f64, h: record.footprint.h as f64 };
            asset.anchor = record.anchor.into();
            asset.vector = record.alias.into();
            asset.blocks_move = record.blocks_move;
            asset.blocks_sight = record.blocks_sight;
            asset.cover = record.cover.into();
            asset.scale_range = record.scale_range;
            asset
        })
        .collect()
}

static ENTRIES: LazyLock<Vec<AssetEntry>> = LazyLock::new(|| {
    let mut entries = with_atlas_art(&declared(), &read_prop_atlas(None));
    entries.extend(with_atlas_art(&detail_declared(), &read_detail_atlas(None)));
    entries
});

/// `new Map(ENTRIES.map(...))`: при повторе id побеждает последняя запись.
static BY_ID: LazyLock<HashMap<&'static str, usize>> =
    LazyLock::new(|| ENTRIES.iter().enumerate().map(|(index, record)| (record.id.as_str(), index)).collect());

/// `assetById(id)`.
pub fn asset_by_id(id: &str) -> Option<&'static AssetEntry> {
    BY_ID.get(id).map(|index| &ENTRIES[*index])
}

/// `assetsForTheme(theme)`.
pub fn assets_for_theme(theme: &str) -> Vec<&'static AssetEntry> {
    ENTRIES.iter().filter(|record| record.themes.iter().any(|value| value == theme)).collect()
}

/// `listAssets()`: все записи в порядке объявления.
pub fn list_assets() -> &'static [AssetEntry] {
    &ENTRIES
}

fn rights_from(text: &str) -> HashSet<String> {
    let Ok(raw) = serde_json::from_str::<Value>(text) else { return HashSet::new() };
    let Some(Value::Array(assets)) = raw.get("assets") else { return HashSet::new() };
    assets
        .iter()
        .map(|record| match record {
            // `String(record?.[0] ?? '')`.
            Value::Array(items) => str_of(items.first()),
            Value::Object(map) => str_of(map.get("0")),
            Value::String(text) => text.chars().next().map(String::from).unwrap_or_default(),
            _ => String::new(),
        })
        .collect()
}

/// Пути, зарегистрированные в `data/asset-rights.json`: `None` — встроенная
/// копия реестра прав, путь — чтение файла. Нет файла — пустое множество.
pub fn registered_rights_ids(rights_file: Option<&Path>) -> HashSet<String> {
    static EMBEDDED: LazyLock<HashSet<String>> = LazyLock::new(|| rights_from(ASSET_RIGHTS_JSON));
    match rights_file {
        None => EMBEDDED.clone(),
        Some(path) => read_text(path).map(|text| rights_from(&text)).unwrap_or_default(),
    }
}

/// Замечание проверки реестра.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RegistryIssue {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

/// Итог проверки реестра.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RegistryReport {
    pub ok: bool,
    pub errors: Vec<RegistryIssue>,
}

/// Проверка реестра: список замечаний, а не исключение — одна плохая запись
/// не должна ронять сервер.
pub fn validate_asset_registry(entries: &[AssetEntry], rights_ids: &HashSet<String>) -> RegistryReport {
    let mut errors: Vec<RegistryIssue> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    let mut push = |code: &str, message: String, at: Option<&str>| {
        errors.push(RegistryIssue { code: code.into(), message, at: at.map(String::from) });
    };
    for record in entries {
        let id = record.id.as_str();
        if id.is_empty() {
            push("ASSET_ID_REQUIRED", "У записи реестра нет идентификатора".into(), None);
        }
        if seen.contains(id) {
            push("ASSET_ID_NOT_UNIQUE", format!("Ассет {id} объявлен дважды"), Some(id));
        }
        seen.insert(id);
        if !ASSET_KINDS.contains(&record.kind.as_str()) {
            push("ASSET_KIND_NOT_ALLOWED", format!("Недопустимый вид ассета: {}", record.kind), Some(id));
        }
        if !ASSET_ANCHORS.contains(&record.anchor.as_str()) {
            push("ASSET_ANCHOR_NOT_ALLOWED", format!("Недопустимый якорь: {}", record.anchor), Some(id));
        }
        if !ASSET_COVER_LEVELS.contains(&record.cover.as_str()) {
            push("ASSET_COVER_NOT_ALLOWED", format!("Недопустимое укрытие: {}", record.cover), Some(id));
        }
        let raster = record.raster.as_deref().filter(|raster| !raster.is_empty());
        let rights_id = record.rights_id.as_deref().filter(|rights| !rights.is_empty());
        if record.vector.is_empty() && raster.is_none() {
            push("ASSET_HAS_NO_DRAWING", format!("У ассета {id} нет ни вектора, ни растра"), Some(id));
        }
        if raster.is_some() && rights_id.is_none() {
            push("ASSET_RASTER_WITHOUT_RIGHTS", format!("Растровый ассет {id} не ссылается на права"), Some(id));
        }
        if let Some(rights) = rights_id {
            if !rights_ids.contains(rights) {
                push("ASSET_RIGHTS_NOT_REGISTERED", format!("Права {rights} не зарегистрированы в data/asset-rights.json"), Some(id));
            }
        }
        let footprint = record.base_footprint;
        if footprint.w < 0.0 || footprint.h < 0.0 || (footprint.w == 0.0) != (footprint.h == 0.0) {
            push("ASSET_FOOTPRINT_INVALID", format!("Футпринт {id} задан неверно"), Some(id));
        }
        let scale = record.scale_range;
        if !(scale.min > 0.0) || scale.max < scale.min {
            push("ASSET_SCALE_RANGE_INVALID", format!("Разброс масштаба {id} задан неверно"), Some(id));
        }
        // Предмет с футпринтом больше клетки обязан её занимать: иначе укрытие
        // и проходимость расходятся с тем, что видно на карте.
        if record.blocks_move && footprint.w == 0.0 {
            push("ASSET_BLOCKS_WITHOUT_FOOTPRINT", format!("Ассет {id} перекрывает движение, но не занимает клеток"), Some(id));
        }
    }
    RegistryReport { ok: errors.is_empty(), errors }
}

/// `validateAssetRegistry()` без аргументов: весь реестр и встроенный реестр прав.
pub fn validate_default_asset_registry() -> RegistryReport {
    validate_asset_registry(list_assets(), &registered_rights_ids(None))
}

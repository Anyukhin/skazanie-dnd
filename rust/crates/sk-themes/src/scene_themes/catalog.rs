//! Каталог тем и опознание темы сцены (`SCENE_THEMES`, `matchTheme`,
//! `resolveSceneTheme` и соседи из `server/scene-themes.mjs`).
//!
//! Тема в JS — рыхлый объект: сборка читает из него поля, раскрывает его в
//! новый (`{ ...definition, chasm }`) и отдаёт целиком генератору поселения.
//! Здесь тема хранит тот же объект JSON ([`SceneTheme::json`]) — без поля
//! `match`, регулярного выражения, которое `JSON.stringify` всё равно пишет
//! пустым объектом. Опознание по словам — [`SceneTheme::match_source`] и
//! скомпилированное выражение с флагами `iu`.

use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::fancy_regex::Regex;
use sk_core::indexmap::IndexSet;
use sk_core::{js, text};

/// Тема сцены: объект JS и выражение опознания по названию.
#[derive(Debug)]
pub struct SceneTheme {
    pub id: &'static str,
    pub label: &'static str,
    /// `building`, `graph`, `open`, `settlement` или `fortress`.
    pub kind: &'static str,
    /// Отдаётся ли тема живой игре.
    pub live: bool,
    /// Исходник `match` (флаги `iu`); `None` — авторская тема без опознания.
    pub match_source: Option<&'static str>,
    matcher: Option<Regex>,
    json: Value,
}

impl SceneTheme {
    fn new(json: Value, match_source: Option<&'static str>) -> Self {
        let text_of = |key: &str| -> &'static str {
            let value = json.get(key).and_then(Value::as_str).unwrap_or("");
            Box::leak(value.to_string().into_boxed_str())
        };
        let id = text_of("id");
        let label = text_of("label");
        let kind = text_of("kind");
        let live = js::is_true(json.get("live"));
        // Исходники выражений — константы этого модуля, проверенные тестом;
        // негодное выражение оставляет тему без опознания по словам.
        let matcher = match_source.and_then(|source| text::js_regex(source, "iu"));
        Self { id, label, kind, live, match_source, matcher, json }
    }

    /// Объект темы в форме JS (без `match`).
    pub fn json(&self) -> &Value {
        &self.json
    }

    /// Поле объекта темы (`theme[key]`).
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.json.get(key)
    }

    /// `theme.assetTheme`.
    pub fn asset_theme(&self) -> Option<&str> {
        self.get("assetTheme").and_then(Value::as_str)
    }

    /// `theme.material`.
    pub fn material(&self) -> Option<&str> {
        self.get("material").and_then(Value::as_str)
    }

    /// Начало первого совпадения `theme.match.exec(haystack)` в байтах.
    fn match_at(&self, haystack: &str) -> Option<usize> {
        self.matcher.as_ref()?.find(haystack).ok().flatten().map(|found| found.start())
    }
}

/// `{ ...a, ...b, … }` для объектов: повтор ключа оставляет его на прежнем
/// месте с новым значением, как раскрытие объекта в JS.
fn merge(parts: &[&Value]) -> Value {
    let mut result = Map::new();
    for part in parts {
        if let Value::Object(map) = part {
            for (key, value) in map {
                result.insert(key.clone(), value.clone());
            }
        }
    }
    Value::Object(result)
}

/// Все ключи — нули (`{ bed: 0, … }`).
fn zeros(keys: &[&str]) -> Value {
    Value::Object(keys.iter().map(|key| ((*key).to_string(), Value::from(0))).collect())
}

/// Склеп и храм берут подсвечники, сундуки и ковры из интерьера, но не мебель
/// жилья: ни кроватей, ни стойки, ни бочек в нефе.
static DWELLING_FURNITURE_OFF: LazyLock<Value> = LazyLock::new(|| {
    zeros(&[
        "bed", "bunk_bed", "bar_counter", "bar_shelf", "table_round", "table_long", "table_small", "chair", "stool", "bench", "barrel", "barrel_stack", "keg", "crate",
        "crate_stack", "sack", "basket", "bucket", "cupboard", "wardrobe", "broom", "fireplace", "hearth_fire", "cauldron", "firewood_stack", "mug", "plate", "bowl_stew",
        "bottle", "jug", "bread_loaf", "cheese_wheel", "dice_cup", "lute", "cutting_board", "pot", "night_table", "washbasin", "sign_board", "floor_stain", "stairs_up",
        "stairs_down", "trapdoor", "lantern_wall", "bookshelf", "shelf_wall",
    ])
});

/// Декор храма на одно помещение: мозаика одна, хоругвей две.
static TEMPLE_DECOR_CAPS: LazyLock<Value> = LazyLock::new(|| json!({ "mosaic": 1, "temple_banner": 2, "statue_plinth": 1, "kneeling_cushions": 2 }));

/// Подземелью мебель нужна по делу: стол стражи, нары, бочки — не кровать и не люстра.
static DUNGEON_INTERIOR_CAPS: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "bed": 0, "bar_counter": 0, "bar_shelf": 0, "table_round": 0, "table_royal": 0, "royal_throne": 0, "chandelier": 0, "candelabra": 0, "rug": 0, "cupboard": 0, "wardrobe": 0,
        "night_table": 0, "washbasin": 0, "lute": 0, "dice_cup": 1, "mug": 2, "plate": 1, "bowl_stew": 1, "bread_loaf": 1, "cheese_wheel": 0, "bottle": 1, "jug": 1, "cutting_board": 0,
        "fireplace": 0, "hearth_fire": 0, "firewood_stack": 0, "broom": 0, "stairs_up": 0, "stairs_down": 0, "trapdoor": 0, "sign_board": 0, "lantern_wall": 0, "bookshelf": 0, "shelf_wall": 0,
        "banner": 0, "floor_stain": 1, "basket": 0, "keg": 0, "pot": 0,
    })
});

static CRYPT_INTERIOR_CAPS: LazyLock<Value> = LazyLock::new(|| merge(&[&DWELLING_FURNITURE_OFF, &json!({ "chandelier": 0, "rug": 0 })]));

/// Лагерь берёт из интерьера ящики, мешки и сундук, но не мебель дома.
pub(crate) static CAMP_INTERIOR_OFF: LazyLock<Value> = LazyLock::new(|| {
    merge(&[
        &DWELLING_FURNITURE_OFF,
        &json!({ "crate": 3, "sack": 3, "barrel": 2, "chandelier": 0, "candelabra": 0, "rug": 0, "chest": 1, "torch_wall": 0, "banner": 0, "candle": 0, "coin_pile": 1 }),
    ])
});

/// Из пещерной темы склеп берёт только завалы, кости и паутину.
static CRYPT_CAVE_CAPS: LazyLock<Value> = LazyLock::new(|| json!({ "stalagmite": 0, "cave_pool": 0, "mushroom_cluster": 0, "ore_vein": 0 }));

const BUILDING_MATCH: &str = r"таверн|трактир|постоял|корчм|харчевн|гостиниц|караван-сара|подворь|ночлежк|особняк|терем|(?<![а-яё])дом(?![а-яё])|(?<![а-яё])изб[аеуы](?![а-яё])|хижин|усадьб|поместь|лавк|кузн|кузниц|мельниц|(?<![а-яё])башн|(?<![а-яё])маяк(?:а|у|ом|е|и|ов|ам|ами|ах)?(?![а-яё])|казарм|караульн|(?<![а-яё])склад|амбар|конюшн|сторожк|библиотек|лаборатори|мастерск|пекарн|аптек|ратуш|кабак";
const TEMPLE_MATCH: &str = r"храм|святилищ|капищ|алтар|собор|монастыр";
const CRYPT_MATCH: &str = r"склеп|крипт|гробниц|усыпальниц|катакомб|мавзоле";
const DUNGEON_MATCH: &str = r"подземель|темниц|тюрьм|каземат|застенк|узилищ";
const CAVE_MATCH: &str = r"пещер|грот|каверн|штольн|шахт|рудник|логов|(?<![а-яё])нор[аеуы](?![а-яё])";
const FOREST_MATCH: &str = r"(?<![а-яё])(?:лес(?:а|у|ом|е|ов|ами|ах)?|чащ[аиуеё]\p{L}*|рощ[аиуеё]\p{L}*|бор(?:а|у|ом|е|ы)?|дубрав\p{L}*|пущ[аиуеё]\p{L}*|тайг\p{L}*|опушк\p{L}*|оазис\p{L}*|поляна|поляне|поляну|лагер\p{L}*|стоянк\p{L}*|бивак\p{L}*)(?![а-яё])";
const ROAD_MATCH: &str = r"дорог|тракт|путь|перекрёст|перекрест|мост|брод|перевал";
const GRAVEYARD_MATCH: &str = r"кладбищ|погост|могильник|некропол";
const SETTLEMENT_MATCH: &str = r"деревн|поселен|(?<![а-яё])сел[оаеу](?![а-яё])|посад|хутор|(?<![а-яё])город(?:а|у|ом|е|ов)?(?![а-яё])|столиц|слобод|рынок|площад";

fn temple() -> Value {
    let decor = &*TEMPLE_DECOR_CAPS;
    let interior = &*DWELLING_FURNITURE_OFF;
    json!({
        "id": "temple", "label": "Храм", "kind": "graph", "live": true, "material": "marble",
        "zones": ["Притвор", "Неф", "Алтарная", "Ризница"],
        "density": 14,
        "require": ["altar", "pillar", "statue", "brazier"],
        "prefer": ["pillar", "statue", "brazier", "prayer_bench", "reliquary", "mosaic", "temple_banner"],
        "propPlans": [
            { "density": 8, "colonnade": false, "extraThemes": ["interior"], "require": ["statue", "brazier", "font_basin"],
              "prefer": ["mosaic", "temple_banner", "offering_bowl", "candelabra", "rug", "bell_frame", "statue_plinth"],
              "caps": merge(&[&json!({ "altar": 0, "statue": 2, "pillar": 2, "prayer_bench": 0, "reliquary": 0, "candelabra": 2, "rug": 1, "brazier": 2, "offering_bowl": 2, "font_basin": 1, "bell_frame": 1, "idol": 0, "holy_pool": 0 }), decor, &json!({ "kneeling_cushions": 0 }), interior]) },
            { "density": 10, "colonnade": true, "purpose": "nave", "extraThemes": ["interior"], "require": ["prayer_bench", "prayer_bench", "brazier"],
              "prefer": ["prayer_bench", "temple_banner", "mosaic", "brazier", "chandelier", "candelabra"],
              "caps": merge(&[&json!({ "altar": 0, "statue": 1, "pillar": 0, "reliquary": 0, "brazier": 2, "chandelier": 2, "candelabra": 2, "offering_bowl": 2, "idol": 0, "holy_pool": 0 }), decor, interior]) },
            { "density": 14, "colonnade": false, "purpose": "altar", "require": ["altar", "reliquary", "brazier", "statue"],
              "prefer": ["offering_bowl", "temple_banner", "mosaic", "statue", "reliquary"],
              "caps": merge(&[&json!({ "altar": 1, "reliquary": 2, "statue": 2, "pillar": 2, "prayer_bench": 2, "brazier": 2, "offering_bowl": 3 }), decor]) },
            { "density": 18, "colonnade": "never", "theme": "interior", "purpose": "store", "require": ["chest", "wardrobe", "shelf_wall"],
              "prefer": ["chest", "shelf_wall", "candle", "table_small", "bookshelf"],
              "caps": merge(&[&json!({ "bed": 0, "bunk_bed": 0, "barrel_stack": 0, "crate_stack": 1 }), decor]) },
        ],
    })
}

fn crypt() -> Value {
    let interior = &*CRYPT_INTERIOR_CAPS;
    let cave = &*CRYPT_CAVE_CAPS;
    json!({
        "id": "crypt", "label": "Склеп", "kind": "graph", "live": true, "material": "stone",
        "zones": ["Вход", "Галерея", "Погребальная", "Тайник"],
        "density": 16,
        "require": ["sarcophagus", "grave", "urn", "brazier"],
        "prefer": ["grave", "urn", "crypt_niche", "bone_pile", "cobweb", "statue"],
        "propPlans": [
            { "density": 8, "extraThemes": ["interior"], "require": ["statue", "brazier"],
              "prefer": ["cobweb", "urn", "statue", "candelabra", "banner", "incense_burner", "statue_plinth", "wall_ivy"],
              "caps": merge(&[&json!({ "sarcophagus": 0, "grave": 0, "statue": 2, "candelabra": 1, "urn": 2, "cobweb": 3, "candle": 2, "incense_burner": 1, "statue_plinth": 1, "wall_ivy": 2 }), interior]) },
            { "density": 14, "extraThemes": ["interior", "cave"], "require": ["crypt_niche", "crypt_niche", "urn"],
              "prefer": ["crypt_niche", "urn", "cobweb", "bone_pile", "rubble_heap", "candle", "torch_wall", "candle_rack", "bone_heap", "wall_ivy_corner"],
              "caps": merge(&[&json!({ "crypt_niche": 10, "sarcophagus": 0, "statue": 0, "rubble_heap": 2, "urn": 4, "cobweb": 3, "candle": 2, "candle_rack": 2, "bone_heap": 1, "wall_ivy_corner": 2 }), interior, cave]) },
            { "density": 16, "extraThemes": ["interior"], "require": ["sarcophagus", "brazier", "brazier"],
              "prefer": ["grave", "urn", "crypt_niche", "cobweb", "candelabra", "offering_bowl", "offering_table", "incense_burner", "obsidian_monolith", "candle_rack"],
              "caps": merge(&[&json!({ "sarcophagus": 2, "statue": 2, "candelabra": 2, "urn": 3, "grave": 4, "cobweb": 3, "candle": 2, "offering_table": 1, "incense_burner": 1, "obsidian_monolith": 1, "candle_rack": 1 }), interior]) },
            { "density": 20, "colonnade": false, "extraThemes": ["interior", "cave"], "require": ["urn", "bone_pile", "chest"],
              "prefer": ["urn", "bone_pile", "cobweb", "crypt_niche", "chest", "coin_pile", "rubble_heap", "chain_coil", "strongbox", "bone_heap"],
              "caps": merge(&[&json!({ "sarcophagus": 1, "chest": 2, "coin_pile": 2, "urn": 6, "cobweb": 3, "candle": 2, "chain_coil": 1, "strongbox": 1, "bone_heap": 1 }), interior, cave]) },
        ],
        "locked": true,
    })
}

fn dungeon() -> Value {
    let base = &*DUNGEON_INTERIOR_CAPS;
    json!({
        "id": "dungeon", "label": "Подземелье", "kind": "graph", "live": true, "material": "stone",
        "assetTheme": "crypt",
        "zones": ["Караульная", "Коридор", "Камеры", "Пыточная", "Склад"],
        "density": 14,
        "locked": true,
        "require": ["brazier", "bone_pile", "cobweb"],
        "prefer": ["bone_pile", "cobweb", "brazier", "urn", "statue"],
        "propPlans": [
            { "density": 14, "purpose": "guardroom", "extraThemes": ["interior"], "require": ["chair", "chest", "torch_wall"],
              "prefer": ["barrel", "crate", "bench", "chair", "torch_wall"],
              "caps": merge(&[base, &json!({ "torch_wall": 2, "table_small": 1, "chest": 1, "barrel": 2, "crate": 2, "bench": 1, "chair": 2, "sarcophagus": 0, "crypt_niche": 0, "grave": 0, "urn": 0, "altar": 0 })]) },
            { "density": 8, "extraThemes": ["interior", "cave"], "require": ["torch_wall", "cobweb"],
              "prefer": ["torch_wall", "cobweb", "rubble_heap", "bone_pile"],
              "caps": merge(&[base, &json!({ "torch_wall": 4, "rubble_heap": 2, "bone_pile": 2, "stalagmite": 0, "cave_pool": 0, "mushroom_cluster": 0, "ore_vein": 0, "sarcophagus": 0, "crypt_niche": 0, "grave": 0, "urn": 0, "altar": 0, "statue": 0 })]) },
            { "density": 16, "purpose": "cells", "extraThemes": ["interior"], "require": ["bone_pile", "cobweb"],
              "prefer": ["bone_pile", "cobweb", "sack"],
              "caps": merge(&[base, &json!({ "torch_wall": 1, "bunk_bed": 0, "bucket": 0, "sack": 2, "sarcophagus": 0, "crypt_niche": 0, "grave": 0, "urn": 0, "altar": 0, "statue": 0 })]) },
            { "density": 14, "purpose": "torture", "extraThemes": ["interior"], "require": ["brazier", "chest"],
              "prefer": ["cauldron", "bone_pile", "brazier", "chest", "cobweb"],
              "caps": merge(&[base, &json!({ "torch_wall": 2, "table_long": 0, "cauldron": 1, "chest": 1, "brazier": 2, "sarcophagus": 0, "crypt_niche": 0, "grave": 0, "urn": 0, "altar": 0, "statue": 0 })]) },
            { "density": 22, "theme": "interior", "purpose": "store", "require": ["crate_stack", "chest"],
              "prefer": ["crate", "barrel", "sack", "chest", "crate_stack"],
              "caps": { "bed": 0, "bunk_bed": 0, "table_long": 0, "table_round": 0, "bar_counter": 0, "chandelier": 0, "rug": 0, "fireplace": 0 } },
        ],
    })
}

fn cave() -> Value {
    json!({
        "id": "cave", "label": "Пещера", "kind": "graph", "live": true, "material": "earth",
        "zones": ["Устье", "Штрек", "Зал", "Тупик"],
        "density": 18,
        "require": ["stalagmite", "cave_pool", "rubble_heap"],
        "prefer": ["stalagmite", "rubble_heap", "mushroom_cluster", "bone_pile", "ore_vein", "cobweb"],
        "propPlans": [
            { "density": 12, "extraThemes": ["forest"], "require": ["boulder", "rubble_heap"],
              "prefer": ["boulder", "rock_small", "fern", "bush", "stalagmite", "rubble_heap"],
              "caps": { "tree_oak": 0, "tree_pine": 0, "tree_birch": 0, "tree_spruce": 0, "tree_dead": 0, "cart": 0, "well": 0, "haystack": 0, "signpost": 0, "milestone": 0, "lamp_post": 0, "roadside_shrine": 0, "hitching_post": 0, "water_trough": 0, "wagon_wheel": 0, "flowers": 0, "woodpile": 0, "path_stone": 0, "campfire": 0, "grass_tuft": 1 } },
            { "density": 16, "extraThemes": ["forest"], "require": ["stalagmite", "ore_vein"],
              "prefer": ["stalagmite", "ore_vein", "rubble_heap", "mushroom_cluster", "rock_small", "boulder", "cobweb", "timber_shoring", "mine_rail", "mine_cart", "crystal_cluster"],
              "caps": { "timber_shoring": 2, "mine_rail": 2, "mine_cart": 1, "crystal_cluster": 2, "tree_oak": 0, "tree_pine": 0, "tree_birch": 0, "tree_spruce": 0, "tree_dead": 0, "cart": 0, "well": 0, "haystack": 0, "signpost": 0, "milestone": 0, "lamp_post": 0, "roadside_shrine": 0, "hitching_post": 0, "water_trough": 0, "wagon_wheel": 0, "flowers": 0, "woodpile": 0, "path_stone": 0, "campfire": 0, "grass_tuft": 0, "fern": 0, "bush": 0, "shrub": 0, "fallen_log": 0, "tree_stump": 0 } },
            { "density": 16, "extraThemes": ["interior", "forest"], "require": ["cave_pool", "bone_pile", "campfire", "chest"],
              "prefer": ["bone_pile", "mushroom_cluster", "stalagmite", "sack", "crate", "barrel", "cobweb", "rubble_heap", "giant_fungus", "crystal_cluster", "obsidian_monolith"],
              "caps": { "giant_fungus": 2, "crystal_cluster": 2, "obsidian_monolith": 1, "tree_oak": 0, "tree_pine": 0, "tree_birch": 0, "tree_spruce": 0, "tree_dead": 0, "cart": 0, "well": 0, "haystack": 0, "signpost": 0, "milestone": 0, "lamp_post": 0, "roadside_shrine": 0, "hitching_post": 0, "water_trough": 0, "wagon_wheel": 0, "flowers": 0, "woodpile": 0, "path_stone": 0, "campfire": 1, "chest": 1, "crate": 2, "barrel": 1, "sack": 2, "grass_tuft": 0, "fern": 0, "bush": 0, "shrub": 0, "fallen_log": 0, "tree_stump": 0 } },
        ],
    })
}

/// `SCENE_THEMES`: темы, которые опознаются по словам. Первая — тема по
/// умолчанию (`FALLBACK_THEME`).
pub static SCENE_THEMES: LazyLock<Vec<SceneTheme>> = LazyLock::new(|| {
    vec![
        SceneTheme::new(json!({ "id": "building", "label": "Здание с участком", "kind": "building", "live": true, "material": "wood" }), Some(BUILDING_MATCH)),
        SceneTheme::new(temple(), Some(TEMPLE_MATCH)),
        SceneTheme::new(crypt(), Some(CRYPT_MATCH)),
        SceneTheme::new(dungeon(), Some(DUNGEON_MATCH)),
        SceneTheme::new(cave(), Some(CAVE_MATCH)),
        SceneTheme::new(
            json!({
                "id": "forest", "label": "Лес", "kind": "open", "live": true, "material": "grass",
                "density": 24,
                "require": ["tree_oak", "tree_spruce", "tree_birch", "fallen_log", "campfire"],
                "prefer": ["tree_oak", "tree_spruce", "tree_birch", "tree_pine", "tree_dead", "tree_stump", "bush", "shrub", "boulder", "fern", "campfire", "mossy_rock", "dead_bramble", "root_tangle", "leaf_litter"],
            }),
            Some(FOREST_MATCH),
        ),
        SceneTheme::new(
            json!({
                "id": "road", "label": "Дорога", "kind": "open", "live": true, "material": "grass",
                "density": 12,
                "require": ["milestone", "tree_birch", "cart", "roadside_shrine"],
                "prefer": ["tree_birch", "tree_dead", "bush", "boulder", "fern", "path_stone", "milestone", "signpost", "tree_stump", "fallen_log", "flowers", "shrub", "rock_small", "tree_oak", "grass_tuft", "woodpile"],
                "road": true,
            }),
            Some(ROAD_MATCH),
        ),
        SceneTheme::new(
            json!({
                "id": "graveyard", "label": "Кладбище", "kind": "open", "live": true, "material": "grass", "assetTheme": "forest",
                "density": 10,
                "require": ["tree_dead", "roadside_shrine", "statue"],
                "prefer": ["tree_dead", "bush", "statue", "rock_small", "flowers", "tree_oak", "urn"],
                "graves": true,
                "flat": true,
            }),
            Some(GRAVEYARD_MATCH),
        ),
        SceneTheme::new(
            json!({
                "id": "settlement", "label": "Поселение", "kind": "settlement", "live": true, "material": "earth",
                "density": 14,
                "require": ["market_stall", "well", "cart", "village_fence"],
                "prefer": ["market_stall", "village_fence", "cart", "haystack", "woodpile", "tree_birch", "campfire"],
                "road": true,
            }),
            Some(SETTLEMENT_MATCH),
        ),
    ]
});

/// Варианты карт стартовых авторских миров: выбираются только явным
/// `scene.map.theme_id`.
static AUTHORED_SCENE_THEMES: LazyLock<Vec<SceneTheme>> = LazyLock::new(|| {
    vec![
        SceneTheme::new(
            json!({
                "id": "authored-harbor", "label": "Каменная гавань", "kind": "settlement", "live": true,
                "assetTheme": "settlement", "surfaceMaterial": "stone", "streetMaterial": "earth", "houseMaterial": "stone", "waterBand": "right",
                "density": 14, "require": ["market_stall", "well", "cart", "village_fence"],
                "prefer": ["market_stall", "cart", "lamp_post", "woodpile", "campfire"],
            }),
            None,
        ),
        SceneTheme::new(
            json!({
                "id": "authored-oasis", "label": "Оазисная площадь", "kind": "settlement", "live": true,
                "assetTheme": "settlement", "surfaceMaterial": "sand", "streetMaterial": "earth", "houseMaterial": "sand", "waterBand": "top",
                "density": 14, "require": ["market_stall", "well", "cart", "village_fence"],
                "prefer": ["market_stall", "well", "water_trough", "cart", "campfire"],
            }),
            None,
        ),
        SceneTheme::new(
            json!({
                "id": "authored-caldera-port", "label": "Пепельная гавань", "kind": "settlement", "live": true,
                "assetTheme": "settlement", "surfaceMaterial": "stone", "streetMaterial": "earth", "houseMaterial": "stone", "waterBand": "left",
                "density": 14, "require": ["market_stall", "well", "cart", "village_fence"],
                "prefer": ["market_stall", "cart", "campfire", "woodpile", "lamp_post"],
            }),
            None,
        ),
        SceneTheme::new(
            json!({
                "id": "authored-palace", "label": "Военная галерея", "kind": "fortress", "live": true, "material": "stone", "assetTheme": "building",
                "zones": ["Большой внутренний двор", "Военная галерея", "Казарма", "Конюшня", "Военный склад", "Мастерская"],
            }),
            None,
        ),
    ]
});

/// Старые и короткие имена авторской крепости (`SCENE_THEME_ALIASES`).
pub const SCENE_THEME_ALIASES: [(&str, &str); 2] = [("ares-fortress", "authored-palace"), ("authored-ares-fortress", "authored-palace")];

fn alias_of(id: &str) -> Option<&'static str> {
    SCENE_THEME_ALIASES.iter().find(|(alias, _)| *alias == id).map(|(_, target)| *target)
}

/// Все темы: опознаваемые, затем авторские (`ALL_SCENE_THEMES`).
pub fn all_scene_themes() -> impl Iterator<Item = &'static SceneTheme> {
    SCENE_THEMES.iter().chain(AUTHORED_SCENE_THEMES.iter())
}

/// `SCENE_THEME_IDS`: идентификаторы тем и псевдонимов в порядке `Set` JS.
pub static SCENE_THEME_IDS: LazyLock<IndexSet<&'static str>> =
    LazyLock::new(|| all_scene_themes().map(|theme| theme.id).chain(SCENE_THEME_ALIASES.iter().map(|(alias, _)| *alias)).collect());

/// `FALLBACK_THEME`: тема по умолчанию, когда ничто не опознано.
pub fn fallback_theme() -> &'static SceneTheme {
    &SCENE_THEMES[0]
}

/// Тема каталога `SCENE_THEMES` по id.
pub(crate) fn scene_theme(id: &str) -> Option<&'static SceneTheme> {
    SCENE_THEMES.iter().find(|theme| theme.id == id)
}

/// `themeById(id)`: тема по id или псевдониму, иначе тема по умолчанию.
pub fn theme_by_id(id: &str) -> &'static SceneTheme {
    let canonical = alias_of(id).unwrap_or(id);
    all_scene_themes().find(|theme| theme.id == canonical).unwrap_or_else(fallback_theme)
}

/// Наименьший размер карты места по виду (`{ width, height }`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ThemeMinSize {
    pub width: i64,
    pub height: i64,
}

/// `THEME_MIN_SIZE`: наименьшая карта места по его виду, в порядке ключей JS.
pub const THEME_MIN_SIZE: [(&str, ThemeMinSize); 5] = [
    ("crypt", ThemeMinSize { width: 26, height: 26 }),
    ("dungeon", ThemeMinSize { width: 26, height: 26 }),
    ("temple", ThemeMinSize { width: 26, height: 26 }),
    ("cave", ThemeMinSize { width: 22, height: 20 }),
    ("building", ThemeMinSize { width: 22, height: 20 }),
];

/// `THEME_MIN_SIZE[id]`.
pub fn theme_min_size(id: &str) -> Option<ThemeMinSize> {
    THEME_MIN_SIZE.iter().find(|(key, _)| *key == id).map(|(_, size)| *size)
}

// --- опознание -------------------------------------------------------------------

/// Ключи `Object.prototype`: `table[key]` в JS находит их у любого объекта.
const OBJECT_PROTOTYPE_KEYS: [&str; 12] = [
    "constructor", "__defineGetter__", "__defineSetter__", "hasOwnProperty", "__lookupGetter__", "__lookupSetter__", "isPrototypeOf",
    "propertyIsEnumerable", "toString", "valueOf", "__proto__", "toLocaleString",
];

/// Поиск в таблице-объекте JS: `Some(None)` — ключ прототипа (значение
/// истинно, но темой не является), `None` — ключа нет.
fn lookup(table: &[(&str, &'static str)], key: &str) -> Option<Option<&'static str>> {
    if let Some((_, value)) = table.iter().find(|(name, _)| *name == key) {
        return Some(Some(value));
    }
    OBJECT_PROTOTYPE_KEYS.contains(&key).then_some(None)
}

/// Поле рыхлого входа.
fn field<'a>(input: &'a Value, key: &str) -> Option<&'a Value> {
    input.as_object().and_then(|object| object.get(key))
}

/// Значение параметра с умолчанием `''` в шаблонной строке: отсутствие —
/// пустая строка, `null` — `"null"`.
fn template(value: Option<&Value>) -> String {
    match value {
        None => String::new(),
        other => js::string(other),
    }
}

/// `String(value).toLocaleLowerCase('en')` для параметра с умолчанием `''`.
fn lower_param(value: Option<&Value>) -> String {
    text::lower(&template(value))
}

/// `String(value ?? '').toLocaleLowerCase('en')`.
fn lower_nullish(value: Option<&Value>) -> String {
    text::lower(&js::s(value))
}

/// `themeFor(input)`: опознание с темой по умолчанию. Неопознанная дикая
/// местность — лес. Вход — объект JS `{ location, theme, sceneKind }`; не
/// объект читается как пустой (в JS `null` бросил бы `TypeError`).
pub fn theme_for(input: &Value) -> &'static SceneTheme {
    if let Some(matched) = match_theme(input) {
        return matched;
    }
    if js::string(field(input, "sceneKind")) == "wilderness" {
        return scene_theme("forest").unwrap_or_else(fallback_theme);
    }
    fallback_theme()
}

/// `matchTheme({ location, theme, sceneKind })`: тема, чьё слово встретилось
/// в названии раньше прочих (при равенстве — порядок списка); дикая местность
/// зданием не становится. `None` — не узнал.
pub fn match_theme(input: &Value) -> Option<&'static SceneTheme> {
    let haystack = format!("{} {}", template(field(input, "location")), template(field(input, "theme")));
    let wilderness = template(field(input, "sceneKind")) == "wilderness";
    let mut best: Option<(&'static SceneTheme, usize)> = None;
    for candidate in SCENE_THEMES.iter() {
        if wilderness && candidate.kind == "building" {
            continue;
        }
        if let Some(index) = candidate.match_at(&haystack) {
            if best.is_none_or(|(_, best_index)| index < best_index) {
                best = Some((candidate, index));
            }
        }
    }
    best.map(|(theme, _)| theme)
}

const BY_PATTERN: [(&str, &str); 4] = [("crypt", "crypt"), ("cave-cluster", "cave"), ("village", "settlement"), ("bridge", "road")];
const BY_LAYOUT: [(&str, &str); 3] = [("cavern", "cave"), ("streets", "settlement"), ("winding", "road")];

/// `themeFromMapRequest({ pattern, layout })`: тема, которую заявка картографа
/// называет однозначно. Ключ прототипа в узоре или планировке — `None`, как в
/// JS (функция прототипа истинна, но темой не является).
pub fn theme_from_map_request(request: &Value) -> Option<&'static SceneTheme> {
    let pattern = lower_param(field(request, "pattern"));
    let layout = lower_param(field(request, "layout"));
    let id = match lookup(&BY_PATTERN, &pattern) {
        Some(found) => found,
        None => match lookup(&BY_LAYOUT, &layout) {
            Some(found) => found,
            None => return None,
        },
    };
    id.and_then(scene_theme)
}

/// `fallbackThemeFor({ sceneKind, request })`: безопасная тема для
/// неопознанной локации — по виду сцены и заявленной топологии.
pub fn fallback_theme_for(input: &Value) -> &'static SceneTheme {
    let empty = Value::Object(Map::new());
    let request = field(input, "request").unwrap_or(&empty);
    if let Some(requested) = theme_from_map_request(request) {
        return requested;
    }
    let kind = lower_param(field(input, "sceneKind"));
    let layout = lower_nullish(field(request, "layout"));
    let pattern = lower_nullish(field(request, "pattern"));
    let material = lower_nullish(field(request, "material"));
    let id = if kind == "settlement" {
        "settlement"
    } else if kind == "road" {
        "road"
    } else if kind == "wilderness" {
        if layout == "winding" || pattern == "bridge" {
            "road"
        } else {
            "forest"
        }
    } else if kind == "dungeon" {
        if layout == "cavern" {
            "cave"
        } else {
            "crypt"
        }
    } else if layout == "open" || pattern == "natural" {
        "forest"
    } else if layout == "rooms" || layout == "ruins" || layout == "radial" || ["small-room", "great-hall", "keep", "courtyard"].contains(&pattern.as_str()) {
        let masonry = ["stone", "marble", "earth"].contains(&material.as_str()) || ["keep", "great-hall"].contains(&pattern.as_str()) || ["ruins", "radial"].contains(&layout.as_str());
        if masonry {
            "crypt"
        } else {
            "building"
        }
    } else {
        "road"
    };
    scene_theme(id).unwrap_or_else(fallback_theme)
}

/// `isLiveTheme(theme)`.
pub fn is_live_theme(theme: Option<&SceneTheme>) -> bool {
    theme.is_some_and(|theme| theme.live)
}

/// Темы, которые называют постройку или подземелье.
const STRUCTURE_THEMES: [&str; 5] = ["building", "temple", "crypt", "cave", "dungeon"];

/// Виды точек карты мира, которые означают поселение.
const SETTLEMENT_WORLD_KINDS: [&str; 5] = ["capital", "city", "town", "village", "port"];

/// Тема по виду точки карты мира, когда название сцены о местности молчит.
const WORLD_KIND_THEMES: [(&str, &str); 4] = [("wilds", "forest"), ("dungeon", "cave"), ("ruin", "crypt"), ("fortress", "building")];

/// `resolveSceneTheme(input)`: выбор темы живой сцены по всем признакам —
/// явная тема заявки, постройка в названии, признак поселения, название
/// местности, вид точки карты мира, заявка картографа и безопасный fallback.
/// Вход — объект JS `{ location, theme, sceneKind, settlementType, worldKind, request }`.
pub fn resolve_scene_theme(input: &Value) -> &'static SceneTheme {
    let empty = Value::Object(Map::new());
    let location = field(input, "location");
    let theme = field(input, "theme");
    let kind = lower_nullish(field(input, "sceneKind"));
    let request = field(input, "request").unwrap_or(&empty);
    let request_field = |key: &str| field(request, key).filter(|value| !value.is_null());
    let explicit_id = text::trim(&js::s(request_field("theme_id").or_else(|| request_field("themeId")))).to_string();
    if !explicit_id.is_empty() {
        let canonical = alias_of(&explicit_id).unwrap_or(&explicit_id);
        if let Some(explicit) = all_scene_themes().find(|candidate| candidate.id == canonical) {
            return explicit;
        }
    }
    let by_name = match_theme(&json!({ "location": location.cloned().unwrap_or(Value::String(String::new())), "theme": theme.cloned().unwrap_or(Value::String(String::new())), "sceneKind": kind }));
    if let Some(by_name) = by_name {
        if STRUCTURE_THEMES.contains(&by_name.id) {
            return by_name;
        }
    }
    let explicitly_not_settlement = kind == "wilderness" || kind == "road" || kind == "dungeon";
    let requested_layout = lower_nullish(field(request, "layout"));
    let requested_pattern = lower_nullish(field(request, "pattern"));
    let scene_text = text::lower(&format!("{} {}", template(location), template(theme)));
    let outdoor_structure = text::test(
        sk_core::re!(r"(?:^|[\s«])двор(?:\s|$|ом(?:\s|$)|е(?:\s|$)|у(?:\s|$)|а(?:\s|$))|площад|улиц|пристан|гаван|порт|набережн|рынок|сад|переул|внешн|за ворот|перед ворот", "iu"),
        &scene_text,
    );
    let interior_structure = text::test(sk_core::re!(r"галере|дворец|замок|крепост|цитадел|трон|кабинет|поко[ия]|военн(?:ая|ый).*(?:зал|галере)|архив|библиотек|зал", "iu"), &scene_text);
    let interior_layout = requested_layout == "rooms" || ["small-room", "great-hall", "keep", "crypt", "temple"].contains(&requested_pattern.as_str());
    let world_kind_text = js::s(field(input, "worldKind"));
    let castle = sk_core::re!(r"крепост|замок|цитадел", "iu");
    // `worldKind === 'fortress'` — строгое сравнение без приведения.
    let world_fortress = field(input, "worldKind").and_then(Value::as_str) == Some("fortress");
    if outdoor_structure && (world_fortress || text::test(castle, &scene_text)) {
        return theme_by_id("settlement");
    }
    if !explicitly_not_settlement && kind != "settlement" && !outdoor_structure && (interior_structure || interior_layout) {
        if text::test(castle, &scene_text) {
            return theme_by_id("building");
        }
        if text::test(sk_core::re!(r"храм|святилищ|алтар|собор|монастыр", "iu"), &scene_text) || requested_pattern == "temple" {
            return theme_by_id("temple");
        }
        return theme_by_id("building");
    }
    let world_kind = text::lower(&world_kind_text);
    let settlement_signal = kind == "settlement"
        || !text::trim(&js::s(field(input, "settlementType"))).is_empty()
        || requested_layout == "streets"
        || requested_pattern == "village"
        || (!explicitly_not_settlement && SETTLEMENT_WORLD_KINDS.contains(&world_kind.as_str()));
    if settlement_signal && by_name.is_none_or(|theme| theme.id == "road") {
        return theme_by_id("settlement");
    }
    if let Some(by_name) = by_name {
        return by_name;
    }
    // `WORLD_KIND_THEMES[kind] ?? ''`: ключ прототипа даёт истинную функцию,
    // и `themeById` не находит её среди тем — тема по умолчанию.
    let by_world = lookup(&WORLD_KIND_THEMES, &world_kind);
    if kind == "dungeon" && (world_kind == "fortress" || text::test(sk_core::re!(r"крепост|замок|замк|цитадел|бастион", "iu"), &scene_text)) {
        return theme_by_id("dungeon");
    }
    if let Some(by_world) = by_world {
        let named = by_world.unwrap_or("");
        let fits = kind.is_empty()
            || kind == "other"
            || kind == "settlement"
            || (kind == "wilderness" && named == "forest")
            || (kind == "dungeon" && (named == "cave" || named == "crypt"));
        if fits {
            return match by_world {
                Some(id) => theme_by_id(id),
                None => fallback_theme(),
            };
        }
    }
    let request_value = match field(input, "request") {
        None | Some(Value::Null) => empty.clone(),
        Some(value) => value.clone(),
    };
    theme_from_map_request(&request_value).unwrap_or_else(|| fallback_theme_for(&json!({ "sceneKind": kind, "request": request_value })))
}

/// `isLiveTheme(theme)` для рыхлого объекта темы: `Boolean(theme?.live)`.
pub fn is_live_theme_value(theme: Option<&Value>) -> bool {
    js::truthy(theme.and_then(|theme| field(theme, "live")))
}

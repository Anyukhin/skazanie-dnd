//! Перенос `server/scene-hazards.mjs`: среда как оружие — «опрокинуть
//! стеллаж, поджечь сено». Только справочник: какой проп тяжёлый, какой
//! горючий, какой сам источник огня, и с какими числами это разрешается.
//! Механику исполняет Rules Engine, зону огня ведёт та же машинерия площадных
//! эффектов, что и у заклинаний.
//!
//! Теги выводятся из `assetId` детерминированно и целиком на сервере;
//! присланный клиентом `prop.interaction` не читается. Подвешенные объекты —
//! отдельный закрытый профиль с фиксированной высотой, опорой и СЛ: игрок
//! может использовать только реально существующий проп карты.

use serde_json::{json, Value};
use sk_core::{js, re, text};
use sk_geometry::actor_footprint::footprint_distance_feet;

use crate::jsv::{self, array, num, prop};

/// Политика раскачивания на подвешенном предмете.
pub const SCENE_SWING_POLICY_ID: &str = "skazanie:scene-swing-v1";

/// Опрокидываемая мебель: `(ключ, СЛ Атлетики, урон падения, подпись массы)`.
const HEAVY_PROPS: [(&str, i64, &str, &str); 19] = [
    ("bookshelf", 13, "2d6", "высокий стеллаж"),
    ("bar_shelf", 13, "2d6", "полка за стойкой"),
    ("shelf_wall", 13, "2d6", "стеллаж"),
    ("wardrobe", 15, "2d8", "платяной шкаф"),
    ("cupboard", 14, "2d6", "буфет"),
    ("crate_stack", 13, "2d6", "штабель ящиков"),
    ("barrel_stack", 14, "2d6", "штабель бочек"),
    ("table_long", 12, "1d6", "длинный стол"),
    ("table_royal", 12, "1d6", "королевский стол совета"),
    ("table_round", 11, "1d6", "круглый стол"),
    ("table_small", 10, "1d6", "столик"),
    ("bar_counter", 15, "2d6", "барная стойка"),
    ("barrel", 11, "1d6", "бочка"),
    ("keg", 11, "1d6", "бочонок"),
    ("crate", 10, "1d6", "ящик"),
    ("cart", 14, "2d6", "телега"),
    ("market_stall", 13, "2d6", "торговый лоток"),
    ("statue", 16, "2d8", "каменная статуя"),
    ("pillar", 17, "2d8", "колонна"),
];

/// Горючее: `(ключ, урон зоны, сколько раундов держится, подпись)`.
const FLAMMABLE_PROPS: [(&str, &str, i64, &str); 29] = [
    ("haystack", "1d6", 3, "стог сена"),
    ("woodpile", "1d6", 3, "поленница"),
    ("firewood_stack", "1d6", 3, "дрова"),
    ("bookshelf", "1d6", 3, "стеллаж с книгами"),
    ("bar_shelf", "1d4", 2, "полка за стойкой"),
    ("shelf_wall", "1d4", 2, "стеллаж"),
    ("wardrobe", "1d4", 2, "платяной шкаф"),
    ("cupboard", "1d4", 2, "буфет"),
    ("table_long", "1d4", 2, "длинный стол"),
    ("table_royal", "1d4", 2, "королевский стол совета"),
    ("table_round", "1d4", 2, "круглый стол"),
    ("table_small", "1d4", 2, "столик"),
    ("crate", "1d4", 2, "ящик"),
    ("crate_stack", "1d6", 3, "штабель ящиков"),
    ("barrel", "1d4", 2, "бочка"),
    ("barrel_stack", "1d6", 3, "штабель бочек"),
    ("keg", "1d4", 2, "бочонок"),
    ("basket", "1d4", 2, "корзина"),
    ("broom", "1d4", 2, "метла"),
    ("cobweb", "1d4", 2, "паутина"),
    ("banner", "1d4", 2, "полотнище"),
    ("temple_banner", "1d4", 2, "храмовое полотнище"),
    ("rug", "1d4", 2, "ковёр"),
    ("market_stall", "1d6", 3, "торговый лоток"),
    ("cart", "1d6", 3, "телега"),
    ("bed", "1d4", 2, "постель"),
    ("bunk_bed", "1d6", 3, "двухъярусная койка"),
    ("prayer_bench", "1d4", 2, "скамья"),
    ("bench", "1d4", 2, "скамья"),
];

/// Открытый огонь на карте: от него поджигают, если он рядом.
const FIRE_SOURCE_PROPS: [&str; 10] = ["campfire", "brazier", "hearth_fire", "fireplace", "torch_wall", "lantern_wall", "candelabra", "candle", "lamp_post", "cauldron"];

/// Предметы героя, которыми можно поджечь.
const FIRE_SOURCE_ITEMS: [&str; 5] = ["torch", "tinderbox", "lantern", "candle", "flint"];

fn heavy(key: &str) -> Option<&'static (&'static str, i64, &'static str, &'static str)> {
    HEAVY_PROPS.iter().find(|entry| !key.is_empty() && entry.0 == key)
}

fn flammable(key: &str) -> Option<&'static (&'static str, &'static str, i64, &'static str)> {
    FLAMMABLE_PROPS.iter().find(|entry| !key.is_empty() && entry.0 == key)
}

/// `clean(value, maximum)`: `String(value ?? '').trim().slice(0, maximum)`.
fn clean(value: Option<&Value>, maximum: usize) -> String {
    text::head(text::trim(&js::s(value)), maximum)
}

/// Ключ справочника из `assetId`: последний сегмент пути без расширения.
pub fn hazard_asset_key(asset_id: Option<&Value>) -> String {
    let value = text::lower(&clean(asset_id, 120));
    if value.is_empty() {
        return String::new();
    }
    let tail = value.split(['\\', '/']).next_back().unwrap_or(&value).to_string();
    text::replace_first(re!(r"\.[a-z0-9]+$", "u"), &tail, "")
}

/// Профиль подвешенного предмета (люстра) или `None`.
pub fn swing_prop_profile_for(asset_id: Option<&Value>) -> Option<Value> {
    (hazard_asset_key(asset_id) == "chandelier").then(|| {
        json!({
            "anchor": "ceiling",
            "height_feet": 10,
            "reach_feet": 5,
            "check": { "ability": "str", "skill": "athletics", "difficulty": 12 },
            "failure_condition": "prone",
        })
    })
}

/// Предметы, на которых можно раскачиваться.
pub fn swing_prop_asset_ids() -> Vec<String> {
    vec!["chandelier".into()]
}

/// Теги пропа. Ничего не хранится в состоянии — вывод детерминирован.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SceneHazardTags {
    pub heavy: bool,
    pub flammable: bool,
    pub fire_source: bool,
}

impl SceneHazardTags {
    /// Форма JS: `{ heavy, flammable, fireSource }`.
    pub fn to_value(self) -> Value {
        json!({ "heavy": self.heavy, "flammable": self.flammable, "fireSource": self.fire_source })
    }
}

/// Теги пропа по `assetId`.
pub fn scene_hazard_tags_for(asset_id: Option<&Value>) -> SceneHazardTags {
    let key = hazard_asset_key(asset_id);
    SceneHazardTags { heavy: heavy(&key).is_some(), flammable: flammable(&key).is_some(), fire_source: FIRE_SOURCE_PROPS.contains(&key.as_str()) }
}

/// Все пропы, которым справочник даёт хотя бы один глагол обстановки, по алфавиту.
pub fn scene_hazard_asset_ids() -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for key in HEAVY_PROPS.iter().map(|entry| entry.0).chain(FLAMMABLE_PROPS.iter().map(|entry| entry.0)) {
        if !ids.iter().any(|id| id == key) {
            ids.push(key.to_string());
        }
    }
    ids.sort();
    ids
}

/// Открытый огонь карты: без такого пропа или предмета поджечь нечем.
pub fn fire_source_asset_ids() -> Vec<String> {
    FIRE_SOURCE_PROPS.iter().map(|id| id.to_string()).collect()
}

/// Глаголы, которые справочник добавляет к обычным операциям пропа.
pub fn scene_hazard_verbs_for(asset_id: Option<&Value>) -> Vec<&'static str> {
    let tags = scene_hazard_tags_for(asset_id);
    let mut verbs = Vec::new();
    if tags.heavy {
        verbs.push("topple");
    }
    if tags.flammable {
        verbs.push("ignite");
    }
    verbs
}

/// Как опрокинуть проп: проверка Атлетики, урон и спасбросок падения.
pub fn topple_definition_for(asset_id: Option<&Value>) -> Option<Value> {
    let (_, dc, damage, mass) = heavy(&hazard_asset_key(asset_id))?;
    Some(json!({
        "ability": "str",
        "skill": "athletics",
        "dc": dc,
        "purpose": "scene-object:topple",
        "damage": damage,
        "damage_type": "bludgeoning",
        "save_ability": "dex",
        "save_dc": dc,
        "mass": mass,
    }))
}

/// Как поджечь проп: урон зоны огня и её срок.
pub fn ignite_definition_for(asset_id: Option<&Value>) -> Option<Value> {
    let (_, damage, rounds, what) = flammable(&hazard_asset_key(asset_id))?;
    Some(json!({ "damage": damage, "damage_type": "fire", "rounds": rounds, "what": what, "save_ability": "dex" }))
}

/// Клетки пропа `[{ x, y }]` — та же форма, что читает `sceneObjectDistance`.
pub fn hazard_prop_cells(prop_value: Option<&Value>) -> Vec<Value> {
    let footprint = array(prop(prop_value, "footprint"));
    let cell_of = |x: f64, y: f64| (x.is_finite() && y.is_finite()).then(|| json!({ "x": num(x), "y": num(y) }));
    if !footprint.is_empty() {
        return footprint
            .iter()
            .filter_map(|cell| cell_of(js::number(prop(Some(cell), "x")).floor(), js::number(prop(Some(cell), "y")).floor()))
            .collect();
    }
    cell_of(js::number(prop(prop_value, "x")).floor(), js::number(prop(prop_value, "y")).floor()).into_iter().collect()
}

/// Есть ли чем поджечь: открытый огонь на соседней клетке или подходящий
/// предмет в руках — `{ kind: 'prop' | 'item', id }`. Проверка серверная.
pub fn fire_source_near(props: Option<&Value>, actor_position: Option<&Value>, actor: Option<&Value>) -> Option<Value> {
    let x = js::number(prop(actor_position, "x")).floor();
    let y = js::number(prop(actor_position, "y")).floor();
    if x.is_finite() && y.is_finite() {
        let at = json!({ "x": num(x), "y": num(y) });
        for candidate in array(props) {
            let candidate = Some(candidate);
            if !scene_hazard_tags_for(prop(candidate, "assetId")).fire_source {
                continue;
            }
            let near = hazard_prop_cells(candidate).into_iter().any(|cell| {
                let distance = footprint_distance_feet(actor, Some(&Value::Array(vec![cell])), Some(&at), None).unwrap_or(f64::INFINITY);
                distance <= 5.0
            });
            if near {
                return Some(json!({ "kind": "prop", "id": clean(prop(candidate, "id"), 120) }));
            }
        }
    }
    for item in array(prop(actor, "inventory")) {
        let item = Some(item);
        let haystack = text::lower(&format!("{} {} {}", clean(prop(item, "id"), 120), clean(prop(item, "catalog_id"), 120), clean(prop(item, "name"), 120)));
        if let Some(needle) = FIRE_SOURCE_ITEMS.iter().find(|needle| haystack.contains(*needle)) {
            let id = clean(prop(item, "id"), 120);
            return Some(json!({ "kind": "item", "id": if id.is_empty() { needle.to_string() } else { id } }));
        }
    }
    None
}

/// Входные данные горящей зоны (`burningPropEffect({ ... })`).
#[derive(Clone, Copy, Debug)]
pub struct BurningPropInput<'a> {
    pub prop_id: Option<&'a Value>,
    pub command_id: Option<&'a Value>,
    /// Клетки пропа `[{ x, y }]`.
    pub cells: &'a [Value],
    /// Определение поджога ([`ignite_definition_for`]).
    pub definition: &'a Value,
    pub source_actor_id: Option<&'a Value>,
    pub round: Option<&'a Value>,
}

/// Запись горящей зоны для `SpellAreaCreated` — той же формы, что строит
/// `CastSpell` для площадных заклинаний; `id` и `effect_id` заполнены оба:
/// снятие зоны ищет по `effect_id ?? id`.
pub fn burning_prop_effect(input: BurningPropInput<'_>) -> Value {
    let identifier = format!("hazard:burning-prop:{}:{}", clean(input.prop_id, 120), clean(input.command_id, 160));
    let definition = Some(input.definition);
    let cells: Vec<Value> = input
        .cells
        .iter()
        .map(|cell| {
            let mut copy = serde_json::Map::new();
            for key in ["x", "y"] {
                if let Some(value) = prop(Some(cell), key) {
                    copy.insert(key.into(), value.clone());
                }
            }
            Value::Object(copy)
        })
        .collect();
    let mut effect = serde_json::Map::new();
    effect.insert("id".into(), Value::from(identifier.clone()));
    effect.insert("effect_id".into(), Value::from(identifier));
    effect.insert("spell_id".into(), Value::from("hazard:burning-prop"));
    effect.insert("source_actor".into(), Value::from(clean(input.source_actor_id, 120)));
    effect.insert("center".into(), input.cells.first().filter(|cell| js::present(Some(cell))).cloned().unwrap_or_else(|| json!({ "x": 0, "y": 0 })));
    effect.insert("cells".into(), Value::Array(cells));
    effect.insert("area_shape".into(), Value::from("line"));
    effect.insert("radius_feet".into(), Value::from(5));
    effect.insert("difficult_terrain".into(), Value::Bool(false));
    effect.insert("trigger_on_enter".into(), Value::Bool(true));
    effect.insert("trigger_on_turn_end".into(), Value::Bool(true));
    for (target, key) in [("save_ability", "save_ability")] {
        if let Some(value) = prop(definition, key) {
            effect.insert(target.into(), value.clone());
        }
    }
    effect.insert("save_dc".into(), Value::from(12));
    effect.insert("condition".into(), Value::Null);
    for key in ["damage", "damage_type"] {
        if let Some(value) = prop(definition, key) {
            effect.insert(key.into(), value.clone());
        }
    }
    effect.insert("half_on_save".into(), Value::Bool(true));
    effect.insert("follows_source".into(), Value::Bool(false));
    effect.insert("open_flame".into(), Value::Bool(true));
    effect.insert("concentration".into(), Value::Bool(false));
    let expires = jsv::max2(1.0, jsv::number_or(input.round, 1.0)) + jsv::max2(1.0, jsv::number_or(prop(definition, "rounds"), 2.0));
    effect.insert("expires_round".into(), num(expires));
    Value::Object(effect)
}

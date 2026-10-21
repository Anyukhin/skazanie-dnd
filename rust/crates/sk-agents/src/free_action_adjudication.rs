//! Перенос `server/free-action-adjudication.mjs`: серверное судейство
//! свободного действия — то, что живой ведущий решает в уме.
//!
//! Разделение обязанностей жёсткое: модель может предложить только смысл
//! действия и категорию из перечисления, а режим разрешения, число СЛ и
//! последствие выбирает сервер. Модуль детерминированный и без вызовов модели.
//!
//! Прочтение действия, ответы и команды — `serde_json::Value` той же формы,
//! что в JS (ключи в том же порядке). Текст игрока — `&str`, идентификатор
//! героя — уже приведённое `String(actorId)`.

use std::collections::HashSet;
use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_attention::improvised_effects::{environment_hazard, ENVIRONMENT_HAZARD_IDS};
use sk_combat_content::combat_actions::combat_actions_for;
use sk_combat_content::combat_spells::{canonical_combat_spell_for, combat_spells_for};
use sk_combat_content::scene_hazards::{hazard_prop_cells, scene_hazard_tags_for};
use sk_core::fancy_regex::Regex;
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::{hash, js, re, text};
use sk_director::loot_containers::{loot_container_list, loot_container_reach_for, loot_containers_in_scene, loot_item_for_viewer, LootContainerError};
use sk_geometry::actor_footprint::footprint_distance_feet;
use sk_geometry::Point as GeoPoint;
use sk_npc_world::npc_positioning::{npc_placement_for, present_scene_npcs};
use sk_projection::viewer_projection::{campaign_state_for_viewer, ProjectionError};
use sk_rules::checks::skills::skill_proficiency_for_actor;
use sk_rules::tactical_geometry::{shortest_tactical_path, PathOptions};
use sk_ruleset::character_progression::{feature_choice_groups_for, normalized_selected_feature_ids};
use sk_ruleset::rules_actors::{actor_position, find_actor};
use sk_social::npc_social::npc_social_for_viewer;
use sk_tactical::tactical_map::{cell_at, deserialize_tactical_map, doors_reachable_from, edge_between, EdgeDir, EdgeKind, TacticalCell, TacticalMap};
use sk_tactics::adjudicator::DIFFICULTY_CLASSES;

// --- ошибка ------------------------------------------------------------------------

/// Исключение JS, которое модуль пропускает наружу: отказ проекции зрителя,
/// контейнера добычи или проверки согласованной заявки.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FreeActionError {
    pub name: String,
    pub code: Option<String>,
    pub message: String,
}

impl FreeActionError {
    /// `new Error(message)` с полем `code`.
    pub fn coded(code: &str, message: &str) -> Self {
        Self { name: "Error".into(), code: Some(code.into()), message: message.into() }
    }

    /// Форма записи эталона: `{ name, code, message }`.
    pub fn to_json(&self) -> Value {
        json!({ "name": self.name, "code": self.code, "message": self.message })
    }
}

impl From<ProjectionError> for FreeActionError {
    fn from(error: ProjectionError) -> Self {
        Self { name: error.name, code: error.code, message: error.message }
    }
}

impl From<LootContainerError> for FreeActionError {
    fn from(error: LootContainerError) -> Self {
        Self { name: error.name.to_string(), code: error.code, message: error.message }
    }
}

pub type FreeActionResult<T> = Result<T, FreeActionError>;

// --- приведения JS -----------------------------------------------------------------

/// Поле объекта (у не-объекта полей нет).
pub(crate) fn prop<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(Value::as_object).and_then(|map| map.get(key))
}

/// Цепочка `a?.b?.c`.
pub(crate) fn at<'a>(value: Option<&'a Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().fold(value, |current, key| prop(current, key))
}

/// `Array.isArray(value) ? value : []`.
pub(crate) fn arr(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

/// `a ?? b`.
pub(crate) fn nullish<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    match first {
        None | Some(Value::Null) => second,
        some => some,
    }
}

/// Строгое равенство поля строке.
pub(crate) fn is_str(value: Option<&Value>, expected: &str) -> bool {
    value.and_then(Value::as_str) == Some(expected)
}

/// `clean(value, maximum)` модуля: NFKC, пробелы схлопнуты, края обрезаны.
pub(crate) fn clean(value: &str, maximum: usize) -> String {
    text::head(&text::squash_spaces(&text::nfkc(value)), maximum)
}

/// `clean(value, maximum)` для значения JS (`String(value ?? '')`).
pub(crate) fn clean_v(value: Option<&Value>, maximum: usize) -> String {
    clean(&js::s(value), maximum)
}

/// `toLocaleLowerCase('ru').replace(/ё/gu, 'е')`.
pub(crate) fn fold(value: &str) -> String {
    text::lower(value).replace('ё', "е")
}

/// `inEnum(values, value, fallback)`: `values.includes(String(value))`.
fn in_enum(values: &[&str], value: Option<&Value>, fallback: &str) -> String {
    let candidate = js::string(value);
    if values.contains(&candidate.as_str()) {
        candidate
    } else {
        fallback.to_string()
    }
}

/// `digest(value)`: первые двадцать знаков SHA-256 от `JSON.stringify`.
fn digest(value: &Value) -> String {
    text::head(&hash::sha256_hex(js::stringify(value).as_bytes()), 20)
}

/// `.length` массива или строки (иное — `undefined`, сравнения ложны).
fn js_length(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Array(items)) => items.len() as f64,
        Some(Value::String(chars)) => chars.encode_utf16().count() as f64,
        _ => f64::NAN,
    }
}

/// Число, которое JS видит в `Number.isFinite(value)` без приведения.
fn finite(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|number| number.is_finite())
}

/// `cellAt(map, x, y)` для чисел JS: не целое — клетки нет.
fn cell_at_f(map: &TacticalMap, x: f64, y: f64) -> Option<TacticalCell<'_>> {
    if !x.is_finite() || !y.is_finite() || x.fract() != 0.0 || y.fract() != 0.0 || x.abs() > 9e15 || y.abs() > 9e15 {
        return None;
    }
    cell_at(map, x as i64, y as i64)
}

fn revealed_at(map: &TacticalMap, x: f64, y: f64) -> bool {
    cell_at_f(map, x, y).is_some_and(|cell| cell.revealed)
}

/// `positionKey({ x, y })`.
fn position_key(x: f64, y: f64) -> String {
    format!("{},{}", js::f64_string(x), js::f64_string(y))
}

/// Точка `{ x, y }` в JSON.
fn point_json(x: f64, y: f64) -> Value {
    json!({ "x": js::num(x), "y": js::num(y) })
}

fn xy(value: &Value) -> (f64, f64) {
    (js::number(value.get("x")), js::number(value.get("y")))
}

/// `shortestTacticalPath(state, actorId, to)` без опций.
fn path_to(state: &Value, actor_id: &str, x: f64, y: f64) -> Option<Vec<GeoPoint>> {
    shortest_tactical_path(state, actor_id, GeoPoint::new(x, y), PathOptions::default())
}

fn path_revealed(map: &TacticalMap, path: &[GeoPoint]) -> bool {
    path.iter().all(|step| revealed_at(map, step.x, step.y))
}

fn path_json(path: &[GeoPoint]) -> Value {
    Value::Array(path.iter().map(|step| point_json(step.x, step.y)).collect())
}

fn actor_point(state: &Value, actor_id: &str) -> Option<(f64, f64)> {
    actor_position(Some(state), actor_id).map(|point| (point.x as f64, point.y as f64))
}

fn find_hero<'a>(state: &'a Value, actor_id: &str) -> Option<&'a Value> {
    find_actor(Some(state), actor_id)
}

fn combat_active(state: &Value) -> bool {
    js::truthy(at(Some(state), &["mechanics", "combat", "active"]))
}

fn combat_active_strict(state: &Value) -> bool {
    js::is_true(at(Some(state), &["mechanics", "combat", "active"]))
}

fn deserialize_scene_map(state: &Value) -> Option<TacticalMap> {
    let serialized = at(Some(state), &["scene", "map"])?;
    if !serialized.is_object() && !serialized.is_array() {
        return None;
    }
    deserialize_tactical_map(serialized).ok()
}

fn scene_map_truthy(state: &Value) -> bool {
    js::truthy(at(Some(state), &["scene", "map"]))
}

fn object(entries: Vec<(&str, Value)>) -> Value {
    Value::Object(entries.into_iter().map(|(key, value)| (key.to_string(), value)).collect())
}

fn clarification(narration: impl Into<String>) -> Value {
    json!({ "status": "clarification", "narration": narration.into() })
}

// --- перечисления ------------------------------------------------------------------

pub const PLAUSIBILITY_LEVELS: [&str; 4] = ["trivial", "plausible", "strenuous", "impossible_without_means"];
pub const RISK_LEVELS: [&str; 4] = ["none", "minor", "serious", "deadly"];
pub const RESOLUTION_MODES: [&str; 3] = ["auto_success", "check", "counter_offer"];
pub const FREE_ACTION_SKILLS: [&str; 18] = [
    "acrobatics", "animal-handling", "arcana", "athletics", "deception",
    "history", "insight", "intimidation", "investigation", "medicine", "nature",
    "perception", "performance", "persuasion", "religion", "sleight-of-hand",
    "stealth", "survival",
];
pub const FREE_ACTION_PROFICIENCY_LEVELS: [&str; 3] = ["none", "proficient", "expertise"];
pub const FREE_ACTION_CONSEQUENCE_TYPES: [&str; 5] = ["time", "noise", "exposure", "lost_opportunity", "injury"];
pub const FREE_ACTION_ACTIVITY_KINDS: [&str; 6] = ["routine", "stunt", "environmental", "stealth", "social", "knowledge"];
pub const FREE_ACTION_DURATION_CLASSES: [&str; 5] = ["instant", "brief", "minutes", "extended", "prolonged"];
const LEGACY_RESOLUTION_POLICY_VERSION: &str = "free-action-resolution/v1";
const RESOLUTION_POLICY_VERSION: &str = "free-action-resolution/v2";
pub const FREE_ACTION_RESOLUTION_POLICY_VERSION: &str = RESOLUTION_POLICY_VERSION;

fn policy_known(value: Option<&Value>) -> bool {
    is_str(value, RESOLUTION_POLICY_VERSION) || is_str(value, LEGACY_RESOLUTION_POLICY_VERSION)
}

fn difficulty_class(category: &str) -> Value {
    DIFFICULTY_CLASSES.iter().find(|(id, _)| *id == category).map_or(Value::Null, |(_, dc)| Value::from(*dc))
}

// --- опасности ---------------------------------------------------------------------

/// `HAZARD_ALIASES` (порядок ключей — как в JS).
const HAZARD_ALIASES: [(&str, &[&str]); 6] = [
    ("fire", &["fire", "hazard-fire", "lava", "hazard-lava", "magma", "огонь", "огня", "огнем", "огнём", "пламя", "пламени", "костер", "костёр", "костра", "жаровня", "жаровни", "горящий"]),
    ("scalding", &["scalding", "hazard-scalding", "кипяток", "кипятка", "паром", "паре", "ошпар"]),
    ("caustic", &["acid", "caustic", "hazard-acid", "hazard-caustic", "кислота", "кислоты", "кислотой", "едкое", "едкой", "щелочь", "щелочи"]),
    ("fall", &["fall", "hazard-fall", "падение", "падения", "падаю", "падать", "обрыв", "обрыва", "пропасть", "пропасти"]),
    ("crush", &["crush", "hazard-crush", "обвал", "обвала", "обрушение", "обрушения", "придав", "раздав", "столкнов", "вреза"]),
    ("shards", &["shards", "hazard-shards", "осколок", "осколки", "стекло", "стекла", "обломок", "обломки", "шип"]),
];

fn hazard_fire_word() -> &'static Regex {
    re!(r"(?<![\p{L}\p{M}])(?:лав(?:а|ы|е|у|ой|ою|овый|ового|овому|овым|овом|овая|овой|овую|овое|овые|овых|овыми)|магм(?:а|ы|е|у|ой|ою))(?![\p{L}\p{M}])", "iu")
}

/// Упоминает ли текст опасность `id`: подстрокой из каталога или словом.
fn mentions_hazard(id: &str, value: &str) -> bool {
    let aliases = HAZARD_ALIASES.iter().find(|(key, _)| *key == id).map_or(&[][..], |(_, aliases)| *aliases);
    aliases.iter().any(|alias| value.contains(alias)) || (id == "fire" && text::test(hazard_fire_word(), value))
}

fn hazard_contact_verbs() -> &'static Regex {
    re!(r"(?:сажусь|садя|сесть|сяду|сижу|ложусь|ложа|наступа|трога|каса|прикаса|лезу|лезть|вхожу|войти|ступа|прыга|прыгнуть|броса|обжига|облокачива|наклоняюсь)", "iu")
}
fn unknown_hazard_words() -> &'static Regex {
    re!(r"(?:опасност|ловуш|метеор|(?<![\p{L}\p{M}])лав[аы]|яд|токсич|скольз|пропаст|обрыв|обвал|шип|оскол|стекл)", "iu")
}
fn hazard_avoidance() -> &'static Regex {
    re!(r"(?:перепрыг|перешаг|обход|обхожу|обойти|мимо|держусь +подальше|(?:прыга|прыгну|перепрыг)[^.!?]{0,40} +(?:через|мимо))", "iu")
}
fn hazard_near_or_none() -> &'static Regex {
    re!(r"(?:рядом +с|возле|около|не +(?:каса|трога|наступ|вхож|пада|прыга|лез))", "iu")
}
fn wall_collision_action() -> &'static Regex {
    re!(r"(?<![\p{L}\p{M}])врезаюсь(?![\p{L}\p{M}])[^.!?]{0,64}(?<![\p{L}\p{M}])стен(?:а|ы|е|у|ой|ами|ах)(?![\p{L}\p{M}])", "iu")
}
fn wall_collision_negation() -> &'static Regex {
    re!(r"(?<![\p{L}\p{M}])не\s+врезаю\p{L}*", "iu")
}
fn wall_break_action() -> &'static Regex {
    re!(r"(?:пролом|пробива|пробить|пробью|лома\p{L}*|выламыва\p{L}*|разруш\p{L}*|разбива\p{L}*)", "iu")
}
fn wall_collision_non_action() -> &'static Regex {
    re!(r"(?:\?|(?<![\p{L}\p{M}])(?:если|хочу|могу|можно)(?![\p{L}\p{M}]))", "iu")
}
fn self_hazard_contact_verbs() -> &'static Regex {
    re!(r"(?<![\p{L}\p{M}])(?:сажусь|сяду|сижу|ложусь|лягу|вхожу|наступаю|трогаю|касаюсь|прикасаюсь|лезу|прыгаю)(?![\p{L}\p{M}])", "iu")
}
fn self_hazard_contact_negation() -> &'static Regex {
    re!(r"(?<![\p{L}\p{M}])не\s+(?:сажусь|сяду|сижу|ложусь|лягу|вхожу|наступаю|трогаю|касаюсь|прикасаюсь|лезу|прыгаю)(?![\p{L}\p{M}])", "iu")
}

/// `canonicalEnvironmentHazardId(value)`: название опасности по закрытому
/// серверному каталогу; пустая строка — не опасность.
pub fn canonical_environment_hazard_id(value: Option<&Value>) -> String {
    let normalized = fold(&clean_v(value, 80));
    if ENVIRONMENT_HAZARD_IDS.contains(&normalized.as_str()) {
        return normalized;
    }
    ENVIRONMENT_HAZARD_IDS.iter().find(|id| mentions_hazard(id, &normalized)).map_or(String::new(), |id| id.to_string())
}

fn canonical_hazard_str(value: &str) -> String {
    canonical_environment_hazard_id(Some(&Value::String(value.to_string())))
}

fn hazard_id_mentioned_in(value: &str) -> String {
    let value = fold(&clean(value, 1_000));
    HAZARD_ALIASES.iter().map(|(id, _)| *id).find(|id| mentions_hazard(id, &value)).map_or(String::new(), str::to_string)
}

fn hazard_intent_for(value: &str, reading: &Value) -> Option<String> {
    let mut hazard = canonical_environment_hazard_id(reading.get("hazard"));
    if hazard.is_empty() {
        hazard = hazard_id_mentioned_in(value);
    }
    if hazard.is_empty() {
        let cleaned = clean(value, 1_000);
        if text::test(hazard_contact_verbs(), &cleaned) && text::test(unknown_hazard_words(), &cleaned) {
            hazard = "unknown".into();
        }
    }
    (!hazard.is_empty()).then_some(hazard)
}

/// `hazardRelationFor(text, reading)`: `(hazard_id, relation)`.
fn hazard_relation_for(value: &str, reading: &Value) -> Option<(String, &'static str)> {
    let value = clean(value, 1_000);
    let hazard = hazard_intent_for(&value, reading)?;
    if text::test(self_hazard_contact_negation(), &value) || text::test(wall_collision_non_action(), &value) {
        return Some((hazard, "none"));
    }
    if text::test(hazard_near_or_none(), &value) {
        return Some((hazard, "none"));
    }
    if text::test(hazard_avoidance(), &value) {
        return Some((hazard, "avoid"));
    }
    if !text::test(hazard_contact_verbs(), &value) {
        return None;
    }
    // Контакт с опасностью — самоурон. Подстановка другого существа под огонь
    // идёт отдельным эффектом hazard_damage и сюда не попадает.
    if is_str(reading.get("effect"), "hazard_damage") {
        return None;
    }
    if js::truthy(reading.get("target_id")) || js::truthy(reading.get("effect_target")) {
        return Some((hazard, "invalid_target"));
    }
    Some((hazard, "contact"))
}

fn wall_collision_intent(value: &str) -> bool {
    let value = clean(value, 1_000);
    text::test(wall_collision_action(), &value)
        && !text::test(wall_collision_negation(), &value)
        && !text::test(wall_break_action(), &value)
        && !text::test(wall_collision_non_action(), &value)
}

fn self_hazard_contact_id(state: &Value, value: &str, reading: &Value, actor_id: &str) -> String {
    let value = clean(value, 1_000);
    if !text::test(self_hazard_contact_verbs(), &value)
        || text::test(self_hazard_contact_negation(), &value)
        || text::test(hazard_near_or_none(), &value)
        || text::test(hazard_avoidance(), &value)
    {
        return String::new();
    }
    let targets: Vec<String> = [reading.get("target_id"), reading.get("effect_target")]
        .into_iter()
        .map(|target| text::trim(&js::s(target)).to_string())
        .filter(|target| !target.is_empty())
        .collect();
    let hazard = hazard_id_mentioned_in(&value);
    let source_ids: Vec<String> = if targets.is_empty() {
        Vec::new()
    } else {
        nearest_hazard_at(state, actor_id)
            .into_iter()
            .filter(|candidate| candidate.hazard_id == hazard)
            .map(|candidate| js::s(candidate.source.get("id")))
            .filter(|id| !id.is_empty())
            .collect()
    };
    if targets.iter().any(|target| target != actor_id && !source_ids.contains(target)) {
        return String::new();
    }
    // Предмет-источник может быть целью прочтения, но урон от явного контакта
    // получает сам герой. Название опасности берём из его исходного действия.
    hazard
}

/// Кандидат `nearestHazardAt`: опасность, источник и расстояние в клетках.
#[derive(Debug, Clone)]
struct HazardCandidate {
    hazard_id: String,
    source: Value,
    distance: f64,
}

fn nearest_hazard_at(state: &Value, actor_id: &str) -> Vec<HazardCandidate> {
    let Some((ax, ay)) = actor_point(state, actor_id) else { return Vec::new() };
    let anchor = point_json(ax, ay);
    let actor = find_hero(state, actor_id);
    let distance_to_cell = |x: f64, y: f64| -> f64 {
        let cells = json!([point_json(x, y)]);
        footprint_distance_feet(actor, Some(&cells), Some(&anchor), None).map_or(f64::INFINITY, |feet| feet / 5.0)
    };
    let mut candidates = Vec::new();
    if let Some(map) = deserialize_scene_map(state) {
        for (index, raw_hazard) in map.hazards.entries() {
            let cell_index = js::parse_number(&index);
            if !(cell_index.is_finite() && cell_index.fract() == 0.0 && cell_index.abs() <= 9_007_199_254_740_991.0) || cell_index < 0.0 {
                continue;
            }
            let width = map.width as f64;
            let x = cell_index % width;
            let y = (cell_index / width).floor();
            let revealed = cell_at_f(&map, x, y).is_some_and(|cell| cell.revealed);
            let hazard = canonical_hazard_str(raw_hazard);
            if !revealed || hazard.is_empty() {
                continue;
            }
            let source = json!({ "kind": "cell", "x": js::num(x), "y": js::num(y), "cells": [point_json(x, y)], "hazard_id": raw_hazard });
            candidates.push(HazardCandidate { hazard_id: hazard, source, distance: distance_to_cell(x, y) });
        }
        for tactical_prop in &map.props {
            // Разобранная карта не несёт `visibility` и `revealed` предмета:
            // отбор по ним в JS здесь всегда пропускает предмет.
            let prop_value = tactical_prop.to_json();
            let tags = scene_hazard_tags_for(prop_value.get("assetId"));
            let interaction_state = at(Some(state), &["mechanics", "scene_interactions"]).and_then(|all| prop(Some(all), &tactical_prop.id)).and_then(|entry| prop(Some(entry), "state"));
            let state_id = text::lower(&js::s(nullish(interaction_state, prop_value.get("state"))));
            let cells = hazard_prop_cells(Some(&prop_value));
            let visible = cells.iter().any(|cell| {
                let (x, y) = xy(cell);
                revealed_at(&map, x, y)
            });
            let inactive_fire = ["extinguished", "unlit", "cold", "out", "burned", "off", "disabled"].contains(&state_id.as_str());
            if !visible || inactive_fire || (!tags.fire_source && !(tags.flammable && state_id == "burning")) {
                continue;
            }
            let distance = cells.iter().map(|cell| {
                let (x, y) = xy(cell);
                distance_to_cell(x, y)
            }).fold(f64::INFINITY, f64::min);
            let source = json!({ "kind": "prop", "id": tactical_prop.id, "asset_id": tactical_prop.asset_id, "cells": cells });
            candidates.push(HazardCandidate { hazard_id: "fire".into(), source, distance });
        }
    }
    // Старые снимки могут хранить открытые опасные клетки без tactical map.
    for cell in arr(at(Some(state), &["scene", "cells"])) {
        let raw = nullish(prop(Some(cell), "hazardId"), prop(Some(cell), "hazard_id"));
        let hazard = canonical_environment_hazard_id(raw);
        let x = js::number(prop(Some(cell), "x")).floor();
        let y = js::number(prop(Some(cell), "y")).floor();
        let safe = |value: f64| value.is_finite() && value.abs() <= 9_007_199_254_740_991.0;
        if hazard.is_empty() || !js::is_true(prop(Some(cell), "revealed")) || !safe(x) || !safe(y) {
            continue;
        }
        let source = json!({ "kind": "cell", "x": js::num(x), "y": js::num(y), "cells": [point_json(x, y)], "hazard_id": js::string(raw) });
        candidates.push(HazardCandidate { hazard_id: hazard, source, distance: distance_to_cell(x, y) });
    }
    let active = at(Some(state), &["mechanics", "hazards"]).and_then(|all| prop(Some(all), actor_id));
    for hazard in arr(active) {
        let raw = nullish(nullish(prop(Some(hazard), "id"), prop(Some(hazard), "hazard_id")), prop(Some(hazard), "type"));
        let hazard_id = canonical_environment_hazard_id(raw);
        if !hazard_id.is_empty() {
            let own_id = match prop(Some(hazard), "id") {
                None | Some(Value::Null) => hazard_id.clone(),
                some => js::string(some),
            };
            candidates.push(HazardCandidate { hazard_id, source: json!({ "kind": "active-hazard", "id": own_id }), distance: 0.0 });
        }
    }
    candidates.sort_by(|left, right| {
        left.distance
            .partial_cmp(&right.distance)
            .filter(|order| order.is_ne())
            .unwrap_or_else(|| text::locale_compare(&left.hazard_id, &right.hazard_id))
    });
    candidates
}

fn hazard_candidate_reachable(state: &Value, actor_id: &str, candidate: &HazardCandidate) -> bool {
    if is_str(candidate.source.get("kind"), "active-hazard") {
        return true;
    }
    if deserialize_scene_map(state).is_none() {
        return candidate.distance <= 1.0;
    }
    arr(candidate.source.get("cells")).iter().any(|cell| {
        let (x, y) = xy(cell);
        shortest_tactical_path(state, actor_id, GeoPoint::new(x, y), PathOptions { allow_occupied_destination: true, ..PathOptions::default() }).is_some_and(|path| path.len() <= 1)
    })
}

fn wall_contact_source(state: &Value, actor_id: &str) -> Option<Value> {
    let (ax, ay) = actor_position(Some(state), actor_id).map(|point| (point.x, point.y))?;
    let neighbors = [(1, 0), (-1, 0), (0, 1), (0, -1)];
    let mut native_edges = HashSet::new();
    let cells_json = |x: i64, y: i64| json!([{ "x": ax, "y": ay }, { "x": x, "y": y }]);
    if let Some(map) = deserialize_scene_map(state) {
        if !cell_at(&map, ax, ay).is_some_and(|cell| cell.revealed) {
            return None;
        }
        for (dx, dy) in neighbors {
            let (x, y) = (ax + dx, ay + dy);
            let Some(edge) = edge_between(&map, ax, ay, x, y).ok().flatten() else { continue };
            native_edges.insert((x, y));
            if edge.kind == EdgeKind::Wall && edge.blocks_move {
                return Some(json!({ "kind": "wall-edge", "x": edge.x, "y": edge.y, "dir": edge.dir.as_str(), "cells": cells_json(x, y) }));
            }
        }
    }
    let legacy = arr(at(Some(state), &["scene", "cells"]));
    let current = legacy.iter().find(|cell| js::number(prop(Some(cell), "x")) == ax as f64 && js::number(prop(Some(cell), "y")) == ay as f64);
    if !js::is_true(current.and_then(|cell| cell.get("revealed"))) {
        return None;
    }
    for (dx, dy) in neighbors {
        if native_edges.contains(&(ax + dx, ay + dy)) {
            continue;
        }
        let wall = legacy.iter().find(|cell| {
            js::number(prop(Some(cell), "x")) == (ax + dx) as f64
                && js::number(prop(Some(cell), "y")) == (ay + dy) as f64
                && js::s(prop(Some(cell), "type")) == "wall"
                && js::is_true(prop(Some(cell), "revealed"))
        });
        if let Some(wall) = wall {
            let (wx, wy) = (js::number(wall.get("x")), js::number(wall.get("y")));
            return Some(json!({ "kind": "wall-cell", "x": js::num(wx), "y": js::num(wy), "cells": [{ "x": ax, "y": ay }, point_json(wx, wy)] }));
        }
    }
    None
}

fn hazard_profile(id: &str) -> Value {
    environment_hazard(id).cloned().unwrap_or(Value::Null)
}

fn hazard_expression(profile: &Value, risk: &str) -> Value {
    let expressions = profile.get("expressions");
    nullish(prop(expressions, risk), prop(expressions, "minor")).cloned().unwrap_or(Value::Null)
}

/// `resolveHazardContact(state, actorId, text, reading)`: только намеренный
/// контакт с реально видимой ближайшей опасностью. `None` — фраза не о контакте.
pub fn resolve_hazard_contact(state: &Value, actor_id: &str, value: &str, reading: &Value) -> Option<Value> {
    let mut reading = if reading.is_object() { reading.clone() } else { json!({}) };
    let self_hazard = self_hazard_contact_id(state, value, &reading, actor_id);
    if !self_hazard.is_empty() {
        if let Some(map) = reading.as_object_mut() {
            map.insert("hazard".into(), Value::String(self_hazard));
            map.insert("effect".into(), json!("none"));
            map.insert("target_id".into(), json!(""));
            map.insert("effect_target".into(), json!(""));
        }
    }
    if wall_collision_intent(value) && !is_str(reading.get("effect"), "hazard_damage") && !js::truthy(reading.get("target_id")) && !js::truthy(reading.get("effect_target")) {
        let Some(source) = wall_contact_source(state, actor_id) else {
            return Some(json!({ "status": "unavailable", "relation": "contact", "hazard_id": "crush", "reason": "Рядом с героем нет доступной стены для такого удара." }));
        };
        let profile = hazard_profile("crush");
        let risk = in_enum(&RISK_LEVELS, reading.get("risk"), "minor");
        return Some(json!({
            "status": "contact", "relation": "contact", "hazard_id": "crush",
            "expression": hazard_expression(&profile, &risk),
            "damage_type": profile.get("damage_type"),
            "label": "удар о стену",
            "source": source,
            "distance": 1,
        }));
    }
    let (requested, relation) = hazard_relation_for(value, &reading)?;
    if relation == "none" {
        return None;
    }
    if relation == "invalid_target" {
        return Some(json!({ "status": "unavailable", "relation": relation, "hazard_id": requested, "reason": "Намеренный контакт с опасностью разрешён только самому герою." }));
    }
    let nearby = nearest_hazard_at(state, actor_id)
        .into_iter()
        .find(|candidate| candidate.distance <= 1.0 && candidate.hazard_id == requested && hazard_candidate_reachable(state, actor_id, candidate));
    let Some(nearby) = nearby else {
        return Some(json!({ "status": "unavailable", "relation": relation, "hazard_id": requested, "reason": "Рядом с героем нет доступного источника этой опасности." }));
    };
    if relation == "avoid" {
        return Some(json!({ "status": "avoid", "relation": "avoid", "hazard_id": requested, "source": nearby.source, "distance": js::num(nearby.distance) }));
    }
    let profile = hazard_profile(&nearby.hazard_id);
    let risk = in_enum(&RISK_LEVELS, reading.get("risk"), "minor");
    Some(json!({
        "status": "contact", "relation": "contact", "hazard_id": nearby.hazard_id,
        "expression": hazard_expression(&profile, &risk),
        "damage_type": profile.get("damage_type"),
        "label": profile.get("label"),
        "source": nearby.source,
        "distance": js::num(nearby.distance),
    }))
}

/// `confirmedHazardNear(state, actorId, hazardId)`: есть ли у героя рядом
/// подтверждённая видимая и достижимая опасность.
pub fn confirmed_hazard_near(state: &Value, actor_id: &str, hazard_id: Option<&Value>) -> bool {
    let expected = canonical_environment_hazard_id(hazard_id);
    !expected.is_empty()
        && nearest_hazard_at(state, actor_id)
            .iter()
            .any(|candidate| candidate.distance <= 1.0 && candidate.hazard_id == expected && hazard_candidate_reachable(state, actor_id, candidate))
}

fn canonical_skill(value: Option<&Value>) -> String {
    let normalized = text::lower(&clean_v(value, 60)).replace('_', "-");
    in_enum(&FREE_ACTION_SKILLS, Some(&Value::String(normalized)), "perception")
}

/// `resolutionModeFor({ plausibility, risk })`: ведущий не требует броска,
/// когда на кону ничего нет.
pub fn resolution_mode_for(reading: &Value) -> Value {
    let level = in_enum(&PLAUSIBILITY_LEVELS, reading.get("plausibility"), "plausible");
    let stake = in_enum(&RISK_LEVELS, reading.get("risk"), "minor");
    if level == "impossible_without_means" {
        return json!({ "mode": "counter_offer", "difficulty_category": null, "difficulty": null });
    }
    if stake == "none" && (level == "trivial" || level == "plausible") {
        return json!({ "mode": "auto_success", "difficulty_category": null, "difficulty": null });
    }
    let category = if level == "trivial" {
        "easy"
    } else if level == "strenuous" || stake == "deadly" {
        "hard"
    } else {
        "medium"
    };
    json!({ "mode": "check", "difficulty_category": category, "difficulty": difficulty_class(category) })
}

// --- детерминированное прочтение ----------------------------------------------------

struct ApproachPattern {
    test: &'static Regex,
    ability: &'static str,
    skill: &'static str,
    plausibility: &'static str,
    risk: &'static str,
    obstacle: &'static str,
}

static APPROACH_PATTERNS: LazyLock<Vec<ApproachPattern>> = LazyLock::new(|| {
    let entry = |test, ability, skill, plausibility, risk, obstacle| ApproachPattern { test, ability, skill, plausibility, risk, obstacle };
    vec![
        entry(re!(r"(?:протис\p{L}*|протолк\p{L}*|пробир\p{L}*|проскальз\p{L}*|войд\p{L}*|вхож\p{L}*|проник\p{L}*)[^.!?]{0,100}внутр\p{L}*", "iu"), "dex", "acrobatics", "plausible", "minor", "проход"),
        entry(re!(r"(?<![\p{L}\p{M}])(?:сальто|кувырк\p{L}*|кувырок|кульбит\p{L}*|фляк\p{L}*|рондат\p{L}*|балансир\p{L}*|пируэт\p{L}*|акробатическ\p{L}*\s+(?:трюк|переворот))(?![\p{L}\p{M}])", "iu"), "dex", "acrobatics", "strenuous", "minor", "равновесие и точность движения"),
        entry(re!(r"(?:отвле[кч]|переключ\p{L}*\s+внимани|шум\p{L}*\s+приманк)", "iu"), "cha", "performance", "plausible", "minor", "внимание собеседника"),
        entry(re!(r"(подпира|баррикад|завал|подпер|держ\w+\s+двер)", "iu"), "str", "athletics", "plausible", "minor", "дверь"),
        entry(re!(r"(взлам|выбива|выломать|ломаю)", "iu"), "str", "athletics", "strenuous", "serious", "преграда"),
        entry(re!(r"(опрокид|сбива|толка|рывк|поднож|жаровн|спотык|оступить)", "iu"), "str", "athletics", "strenuous", "serious", "противник"),
        entry(re!(r"(поджиг|зажиг|подпал|факел\w*\s+к)", "iu"), "dex", "sleight-of-hand", "plausible", "serious", "огонь"),
        // «Скрыва» — с начала слова: «раскрывает тетрадь» и «вскрывает замок» не
        // прятки; «тихо» — только с движением: «тихо говорит Борину» — реплика.
        entry(re!(r"(?:крад|незамет|бесшумн|прячусь|затаи|пригиба\p{L}*\s+(?:за|у|в)\s|укрыва\p{L}*\s+(?:за|у|в)\s|залега\p{L}*|(?<![\p{L}\p{M}])скрыва|(?<![\p{L}\p{M}])тих\p{L}*\s+(?:\p{L}+\s+)?(?:пробир|проскаль|проход|прокрад|ступа|двига|обход|ид[уеёт]))", "iu"), "dex", "stealth", "plausible", "minor", "наблюдатели"),
        entry(re!(r"(запуг|угрож|пригрож)", "iu"), "cha", "intimidation", "plausible", "minor", "собеседник"),
        entry(re!(r"(убежда|уговар|догова|прош\w+\s+помощ)", "iu"), "cha", "persuasion", "plausible", "minor", "собеседник"),
        entry(re!(r"(обман|вру|соврать|притвор)", "iu"), "cha", "deception", "plausible", "minor", "собеседник"),
        // «окликa» — с латинской «a», как в JS.
        entry(re!(r"(крич|зову|окликa|подзыва)", "iu"), "cha", "persuasion", "plausible", "minor", "окружающие"),
        // Поиск тайника руками: «простукивает бочки — нет ли тайника».
        entry(re!(r"(?<![\p{L}\p{M}])(?:простук\p{L}*|ощупыва\p{L}*|обшари\p{L}*|тайник\p{L}*|тайничок\p{L}*)", "iu"), "int", "investigation", "plausible", "none", "тайник"),
        entry(re!(r"(осматр|разгляд|изуча|ищу\s+след|обыск)", "iu"), "wis", "perception", "trivial", "none", "обстановка"),
        // Наблюдение за чем-то, что может случиться: «смотрим на маяк — загорится ли огонь?».
        entry(re!(r"(?<![\p{L}\p{M}])(?:наблюда\p{L}*|след(?:им|ит|ю|ят)\s+за|слежу\s+за|смотр\p{L}*\s+(?:на|в|за)\s|вгляд\p{L}*|высматр\p{L}*|караул\p{L}*|не\s+свод\p{L}*\s+(?:глаз|взгляд\p{L}*))", "iu"), "wis", "perception", "plausible", "none", "то, что происходит вокруг"),
        entry(re!(r"(вспомина|припомин|знаю\s+ли|что\s+известно)", "iu"), "int", "history", "trivial", "none", "память"),
        entry(re!(r"(залез|взбира|караб|подтягива)", "iu"), "str", "athletics", "strenuous", "serious", "высота"),
        entry(re!(r"(?<![\p{L}\p{M}])(?:вс|с|за|пере|под|вы|при|от)?прыг|(?<![\p{L}\p{M}])(?:прыж|соскоч|перескоч)", "iu"), "dex", "acrobatics", "strenuous", "serious", "разрыв"),
    ]
});

fn str_field<'a>(input: &'a Value, key: &str) -> Option<&'a Value> {
    prop(Some(input), key)
}

/// `normalizeFreeActionReading(input, fallbackText)`: прочтение по контракту;
/// незнакомое значение молча заменяется безопасным.
pub fn normalize_free_action_reading(input: &Value, fallback_text: &str) -> Value {
    let value = clean(fallback_text, 1_000);
    let or_fallback = |cleaned: String, limit: usize| if cleaned.is_empty() { text::head(&value, limit) } else { cleaned };
    let mut means: IndexSet<String> = IndexSet::new();
    for entry in arr(str_field(input, "required_means")) {
        let cleaned = clean_v(Some(entry), 160);
        if !cleaned.is_empty() {
            means.insert(cleaned);
        }
    }
    let effect = clean_v(str_field(input, "effect"), 40);
    let source = clean_v(str_field(input, "source"), 60);
    object(vec![
        ("goal_summary", Value::String(or_fallback(clean_v(str_field(input, "goal_summary"), 200), 200))),
        ("approach_summary", Value::String(or_fallback(clean_v(str_field(input, "approach_summary"), 200), 200))),
        ("ability", Value::String(in_enum(&["str", "dex", "con", "int", "wis", "cha"], str_field(input, "ability"), "wis"))),
        ("skill", Value::String(canonical_skill(str_field(input, "skill")))),
        ("plausibility", Value::String(in_enum(&PLAUSIBILITY_LEVELS, str_field(input, "plausibility"), "plausible"))),
        ("risk", Value::String(in_enum(&RISK_LEVELS, str_field(input, "risk"), "minor"))),
        ("obstacle", Value::String(or_fallback(clean_v(str_field(input, "obstacle"), 120), 120))),
        ("required_means", js::strings_value(means.into_iter().take(4))),
        ("action_cost", Value::String(in_enum(&["action", "bonus_action", "free"], str_field(input, "action_cost"), "action"))),
        ("effect", Value::String(if effect.is_empty() { "none".into() } else { effect })),
        ("effect_target", Value::String(clean_v(str_field(input, "effect_target"), 120))),
        ("hazard", Value::String(canonical_environment_hazard_id(str_field(input, "hazard")))),
        ("prop_id", Value::String(clean_v(str_field(input, "prop_id"), 120))),
        ("target_id", Value::String(clean_v(str_field(input, "target_id"), 120))),
        ("item_id", Value::String(clean_v(str_field(input, "item_id"), 120))),
        ("proficiency", Value::String(in_enum(&FREE_ACTION_PROFICIENCY_LEVELS, str_field(input, "proficiency"), "none"))),
        ("consequence_type", Value::String(in_enum(&FREE_ACTION_CONSEQUENCE_TYPES, str_field(input, "consequence_type"), "time"))),
        ("activity_kind", Value::String(in_enum(&FREE_ACTION_ACTIVITY_KINDS, str_field(input, "activity_kind"), ""))),
        ("duration_class", Value::String(in_enum(&FREE_ACTION_DURATION_CLASSES, str_field(input, "duration_class"), ""))),
        ("source", Value::String(if source.is_empty() { "deterministic-default".into() } else { source })),
    ])
}

fn trivial_reading(value: &str, ability: &str, skill: &str, extra: Vec<(&str, Value)>) -> Value {
    let mut input = Map::new();
    input.insert("goal_summary".into(), Value::String(clean(value, 200)));
    input.insert("approach_summary".into(), Value::String(clean(value, 200)));
    input.insert("plausibility".into(), json!("trivial"));
    input.insert("risk".into(), json!("none"));
    input.insert("effect".into(), json!("none"));
    input.insert("action_cost".into(), json!("free"));
    input.insert("ability".into(), json!(ability));
    input.insert("skill".into(), json!(skill));
    for (key, entry) in extra {
        input.insert(key.into(), entry);
    }
    input.insert("source".into(), json!("deterministic-trivial"));
    normalize_free_action_reading(&Value::Object(input), value)
}

fn players(state: &Value) -> &[Value] {
    arr(prop(Some(state), "players"))
}

fn player_by_id<'a>(state: &'a Value, actor_id: &str) -> Option<&'a Value> {
    players(state).iter().find(|entry| js::string(prop(Some(entry), "id")) == actor_id)
}

/// `Object.values(value).some((amount) => Number(amount) > 0)`.
fn any_positive_value(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Object(map)) => map.values().any(|amount| js::number(Some(amount)) > 0.0),
        Some(Value::Array(items)) => items.iter().any(|amount| js::number(Some(amount)) > 0.0),
        Some(Value::String(chars)) => chars.chars().any(|ch| js::parse_number(&ch.to_string()) > 0.0),
        _ => false,
    }
}

/// `harmlessFreeActionReading(state, actorId, text)`: бытовой жест со своей
/// вещью вне боя — без противодействия и без броска.
pub fn harmless_free_action_reading(state: &Value, actor_id: &str, value_text: &str) -> Option<Value> {
    if combat_active(state) {
        return None;
    }
    let value = fold(&clean(value_text, 1_000));
    if text::test(re!(r"[;]|\b(?:if|then)\b|(?:затем|потом|чтобы|противник|страж|двер|обрыв|пропаст|огонь|подж|связать\s+его)", "iu"), &value) {
        return None;
    }
    let actor = player_by_id(state, actor_id)?;
    // Запись в свою тетрадь — жест героя, а не испытание.
    if !text::test(re!(r#"[«»"]"#, "u"), &value)
        && text::test(re!(r"(?<![\p{L}\p{M}])(?:записыва\p{L}*|запис(?:ал|ала|ываю)|занос\p{L}*|занош\p{L}*|вписыва\p{L}*|отмеча\p{L}*|помеча\p{L}*|дела(?:ю|ет)\s+(?:по)?метк\p{L}*|набрасыва\p{L}*)(?![\p{L}\p{M}])[^.!?]{0,200}?(?<![\p{L}\p{M}])в\s+(?:сво\p{L}*\s+)?(?:тетрад\p{L}*|дневник\p{L}*|блокнот\p{L}*|записн\p{L}*\s+книжк\p{L}*)", "iu"), &value)
        && !text::test(re!(r"(?:прыга|лез|бега|броса|атак|бь[её]т|удар|толка|лома|вскрыва)", "iu"), &value)
    {
        return Some(trivial_reading(value_text, "int", "investigation", vec![("required_means", json!([]))]));
    }
    let rope_gesture = text::test(re!(r"^(?:я\s+)?(?:развязываю\s+и\s+заново\s+завязываю|завязываю|перевязываю|сматываю|распутываю)\s+(?:(?:свою|имеющуюся)\s+)?веревку(?:,?\s+проверяя\s+прочность\s+узлов(?:\s+перед\s+использованием)?)?[.!]?$", "u"), &value);
    let rope = if rope_gesture {
        arr(actor.get("inventory")).iter().find(|item| text::test(re!(r"веревк|rope", "iu"), &js::string(prop(Some(item), "name")).replace('ё', "е")))
    } else {
        None
    };
    let coin_gesture = text::test(re!(r"^(?:я\s+)?подбрасываю\s+(?:свою\s+)?монету\s+и\s+ловлю\s+(?:ее\s+)?(?:(?:другой|левой|правой)\s+)?рукой[.!]?$", "u"), &value);
    let coin = coin_gesture && any_positive_value(actor.get("currency"));
    if (coin_gesture && !coin) || (rope_gesture && rope.is_none()) {
        let mut input = Map::new();
        input.insert("goal_summary".into(), Value::String(clean(value_text, 200)));
        input.insert("approach_summary".into(), Value::String(clean(value_text, 200)));
        input.insert("plausibility".into(), json!("impossible_without_means"));
        input.insert("risk".into(), json!("none"));
        input.insert("effect".into(), json!("none"));
        input.insert("required_means".into(), json!([if coin_gesture { "монета" } else { "верёвка" }]));
        input.insert("source".into(), json!("deterministic-trivial"));
        return Some(normalize_free_action_reading(&Value::Object(input), value_text));
    }
    if rope.is_none() && !coin {
        return None;
    }
    let item_id = rope.and_then(|rope| nullish(rope.get("id"), None)).cloned().unwrap_or_else(|| json!(""));
    let means = match rope {
        Some(rope) => json!([js::string(rope.get("id"))]),
        None => json!([]),
    };
    Some(trivial_reading(value_text, "dex", "sleight_of_hand", vec![("item_id", item_id), ("required_means", means)]))
}

/// `roleplaySpeechReading(state, text)`: реплика своему отряду — отыгрыш без
/// механики. В бою — `None`.
pub fn roleplay_speech_reading(state: &Value, value: &str) -> Option<Value> {
    if combat_active(state) {
        return None;
    }
    Some(trivial_reading(value, "cha", "performance", vec![("required_means", json!([]))]))
}

/// `interpretFreeAction(text)`: детерминированная половина прочтения.
pub fn interpret_free_action(value_text: &str) -> Value {
    let value = clean(value_text, 1_000);
    let found = APPROACH_PATTERNS.iter().find(|pattern| text::test(pattern.test, &value));
    let skill = found.map(|pattern| pattern.skill);
    let consequence = if matches!(skill, Some("stealth" | "deception")) {
        "exposure"
    } else if matches!(skill, Some("persuasion" | "intimidation")) {
        "lost_opportunity"
    } else if text::test(re!(r"(крич|лома|выбива|поджиг|зажиг)", "iu"), &value) {
        "noise"
    } else {
        "time"
    };
    let mut input = Map::new();
    if let Some(pattern) = found {
        input.insert("ability".into(), json!(pattern.ability));
        input.insert("skill".into(), json!(pattern.skill));
        input.insert("plausibility".into(), json!(pattern.plausibility));
        input.insert("risk".into(), json!(pattern.risk));
        input.insert("obstacle".into(), json!(pattern.obstacle));
    }
    input.insert("effect".into(), json!("none"));
    input.insert("consequence_type".into(), json!(consequence));
    input.insert("source".into(), json!(if found.is_some() { "deterministic-pattern" } else { "deterministic-default" }));
    normalize_free_action_reading(&Value::Object(input), &value)
}

/// `hasRecognizedFreeActionApproach(text)`.
pub fn has_recognized_free_action_approach(value: &str) -> bool {
    let value = clean(value, 1_000);
    APPROACH_PATTERNS.iter().any(|pattern| text::test(pattern.test, &value))
}

fn impossible_feat() -> &'static Regex {
    re!(r"(?<![\p{L}])(?:(?:весь|всю|целый|целую|целиком)\s+(?:замок|город|гору|дом|крепость|башню|корабль|лес|мост|стену)|(?:поднимаю|поднять|поднимает|переворачиваю|сдвигаю)\s+(?:замок|гору|крепость|башню|город)|взлетаю|улетаю|лечу\s+(?:над|по\s+небу|в\s+небо))(?![\p{L}])", "iu")
}

/// Контекст [`mundane_action_outcome`].
#[derive(Debug, Clone, Default)]
pub struct MundaneContext {
    pub hero_name: String,
    pub in_combat: bool,
    pub npc_names: Vec<String>,
    pub onward: String,
}

/// `mundaneActionOutcome(text, { heroName, inCombat, npcNames, onward })`:
/// уточнение с конкретными способами вместо тупика; в бою — `None`.
pub fn mundane_action_outcome(value: &str, context: &MundaneContext) -> Option<Value> {
    let value = clean(value, 1_000);
    if value.is_empty() || context.in_combat {
        return None;
    }
    let hero = clean(&context.hero_name, 80);
    let hero = if hero.is_empty() { "Герой".to_string() } else { hero };
    let quote = text::replace_first(re!(r"[.!?…]+$", "u"), &value, "");
    if text::test(impossible_feat(), &value) {
        return Some(json!({ "kind": "impossible", "narration": format!("{hero} примеривается — «{quote}», — но это не по силам ни одному смертному. Какой способ мир позволит: рычаг, заклинание, помощь отряда? Попытка ничего не расходует.") }));
    }
    let mut options = vec!["осмотреть место внимательнее".to_string()];
    if !context.npc_names.is_empty() {
        let names: Vec<String> = context.npc_names.iter().take(3).map(|name| clean(name, 60)).collect();
        options.push(format!("расспросить кого-то из здешних ({})", names.join(", ")));
    }
    if !context.onward.is_empty() {
        options.push(format!("отправиться дальше — в «{}»", clean(&context.onward, 80)));
    }
    Some(json!({
        "kind": "flavor",
        "narration": format!("Чего {hero} хочет добиться: «{quote}»? Можно, например, {}. Если это жест для атмосферы — он случается сам, броска не нужно. Попытка ничего не расходует.", options.join(", ")),
    }))
}

/// Отпечаток заявки, который хранит согласованная проверка.
pub fn free_action_fingerprint(value: &str) -> String {
    digest(&Value::String(clean(value, 1_000)))
}

/// `assertFreeActionConfirmation(context, text, stateVersion)`: проверка
/// согласованной заявки до расходования зарегистрированной кости.
pub fn assert_free_action_confirmation(context: Option<&Value>, value: &str, state_version: Option<&Value>) -> FreeActionResult<()> {
    if !is_str(prop(context, "kind"), "free_action") || !is_str(prop(context, "action_fingerprint"), &free_action_fingerprint(value)) || !js::truthy(prop(context, "reading")) {
        return Err(FreeActionError::coded("ROLL_CONTEXT_MISMATCH", "Бросок не относится к согласованной заявке. Отправьте действие ещё раз, чтобы согласовать проверку."));
    }
    let recorded = prop(context, "state_version").and_then(Value::as_f64).filter(|number| number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0);
    let expected = state_version.and_then(Value::as_f64);
    if recorded.is_none() || recorded != expected {
        return Err(FreeActionError::coded("STATE_VERSION_CONFLICT", "Обстановка изменилась после предложения. Отправьте действие ещё раз: ведущий заново проверит цену и последствия."));
    }
    Ok(())
}

// --- ссылки на людей и вещи ---------------------------------------------------------

fn normalized_words(value: &str) -> Vec<String> {
    text::find_all(re!(r"\p{L}[\p{L}\p{M}0-9-]*", "gu"), &fold(&clean(value, 1_000)))
}

fn word_stem(value: &str) -> String {
    let word = fold(value);
    if !text::test(re!(r"^[а-я]{3,}$", "u"), &word) {
        return word;
    }
    let length = text::len(&word);
    for suffix in ["иями", "ями", "ами", "ого", "ему", "ому", "ыми", "ими", "ах", "ях", "ой", "ей", "ом", "ем", "а", "я", "у", "ю", "е", "ы", "и"] {
        let suffix_length = text::len(suffix);
        if word.ends_with(suffix) && length - suffix_length >= 3 {
            return text::head(&word, length - suffix_length);
        }
    }
    word
}

fn mentions_reference(value: &str, values: &[String]) -> bool {
    let message = normalized_words(value);
    let stems: Vec<String> = message.iter().map(|word| word_stem(word)).collect();
    values.iter().any(|candidate| {
        let words = normalized_words(candidate);
        !words.is_empty()
            && words.iter().all(|word| {
                let stem = word_stem(word);
                message.iter().zip(&stems).any(|(other, other_stem)| other == word || *other_stem == stem)
            })
    })
}

fn current_social_actors_from(state: &Value, social: Option<&Value>) -> Vec<Value> {
    let location = text::lower(&clean_v(at(Some(state), &["scene", "location"]), 180));
    arr(prop(social, "npcs"))
        .iter()
        .filter(|npc| {
            let npc_location = text::lower(&clean_v(prop(Some(npc), "location"), 180));
            !js::is_false(prop(Some(npc), "available")) && (location.is_empty() || npc_location.is_empty() || location == npc_location)
        })
        .cloned()
        .collect()
}

fn current_social_actors(state: &Value) -> Vec<Value> {
    current_social_actors_from(state, prop(Some(state), "social"))
}

fn reference_names(actor: &Value) -> Vec<String> {
    let actor = Some(actor);
    let mut values: Vec<Option<&Value>> = ["id", "name", "character", "label", "role"].iter().map(|key| prop(actor, key)).collect();
    values.extend(arr(prop(actor, "aliases")).iter().map(Some));
    values.extend(arr(prop(actor, "tags")).iter().filter(|tag| !js::string(Some(tag)).contains(':')).map(Some));
    values.into_iter().map(|value| clean_v(value, 160)).filter(|value| !value.is_empty()).collect()
}

fn item_reference_names(item: &Value) -> Vec<String> {
    ["id", "catalog_id", "name", "label"].iter().map(|key| clean_v(prop(Some(item), key), 160)).filter(|value| !value.is_empty()).collect()
}

fn named_actors(candidates: &[Value], value: &str) -> Vec<Value> {
    let ranked: Vec<(&Value, u8)> = candidates
        .iter()
        .map(|actor| {
            let score = if mentions_reference(value, &reference_names(actor)) {
                2
            } else if ["name", "character", "label"].iter().any(|key| {
                let words = normalized_words(&js::s(prop(Some(actor), key)));
                words.len() > 1 && mentions_reference(value, &[words[0].clone()])
            }) {
                1
            } else {
                0
            };
            (actor, score)
        })
        .filter(|(_, score)| *score > 0)
        .collect();
    let best = ranked.iter().map(|(_, score)| *score).max().unwrap_or(0);
    ranked.into_iter().filter(|(_, score)| *score == best).map(|(actor, _)| actor.clone()).collect()
}

fn social_for_viewer(state: &Value, actor_id: &str) -> Value {
    let viewer = json!({ "state": state, "playerId": actor_id, "isPartyMember": true });
    npc_social_for_viewer(prop(Some(state), "social").unwrap_or(&Value::Null), &viewer)
}

fn player_view(state: &Value, actor_id: &str) -> FreeActionResult<Option<Value>> {
    Ok(campaign_state_for_viewer(Some(state), Some(&json!({ "role": "player" })), Some(&Value::String(actor_id.to_string())))?)
}

fn action_targets(state: &Value, actor_id: &str) -> FreeActionResult<Vec<Value>> {
    let visible = player_view(state, actor_id)?.unwrap_or_else(|| json!({}));
    let social = social_for_viewer(state, actor_id);
    let mut by_id: IndexMap<String, Value> = IndexMap::new();
    let social_actors = current_social_actors_from(state, Some(&social));
    let all = players(state).iter().chain(arr(visible.get("actors"))).chain(arr(visible.get("enemies"))).chain(social_actors.iter());
    for actor in all {
        let id = js::s(prop(Some(actor), "id"));
        if !id.is_empty() {
            by_id.insert(id, actor.clone());
        }
    }
    Ok(by_id.into_values().collect())
}

fn observation_purpose() -> &'static Regex {
    re!(r"(?<![\p{L}\p{M}])(?:смотр\p{L}*|высматрива\p{L}*|наблюда\p{L}*|присматрива\p{L}*|разглядыва\p{L}*|замеча\p{L}*|заметить|увидеть|прислушива\p{L}*)(?![\p{L}\p{M}])", "iu")
}
fn mundane_approach() -> &'static Regex {
    re!(r"(?<![\p{L}\p{M}])(?:протискива\p{L}*|проталкива\p{L}*|пробира\p{L}*|подбира\p{L}*|подхож\p{L}*|подойти|иду|идём|прохож\p{L}*|пройти|проход\p{L}*|приближа\p{L}*|пробегаю|добира\p{L}*)(?![\p{L}\p{M}])", "iu")
}
fn stunt_word() -> &'static Regex {
    re!(r"(?<![\p{L}\p{M}])(?:прыг\p{L}*|перепрыг\p{L}*|перелез\p{L}*|карабка\p{L}*|лезу|взбира\p{L}*|цепля\p{L}*|балансир\p{L}*|кувыр\p{L}*|сальто|скольз\p{L}*|по\s+(?:канату|перилам|крыше|карнизу|балке)|обрыв\p{L}*|пропаст\p{L}*|ныря\p{L}*)(?![\p{L}\p{M}])", "iu")
}
fn affection_gesture() -> &'static Regex {
    re!(r"(?<![\p{L}\p{M}])(?:целу\p{L}*|поцел\p{L}*|чмока\p{L}*|обнима\p{L}*|обним\p{L}*|пожима\p{L}*\s+(?:\p{L}+\s+)?рук\p{L}*|глажу|глади\p{L}*|похлопыва\p{L}*|кланя\p{L}*|подмигива\p{L}*)(?![\p{L}\p{M}])", "iu")
}
fn social_aim() -> &'static Regex {
    re!(r"(?<![\p{L}\p{M}])(?:чтобы|убеди|уговор|обман|отвлеч|выкра|стащ|незамет)", "iu")
}

fn get_str(reading: &Map<String, Value>, key: &str) -> String {
    js::s(reading.get(key))
}

fn set(reading: &mut Map<String, Value>, key: &str, value: &str) {
    reading.insert(key.into(), Value::String(value.into()));
}

/// `bindFreeActionReadingToState(state, actorId, text, input, { preserveActionProfile })`:
/// прочтение, привязанное к состоянию — цели, вещи и владение навыком решает сервер.
pub fn bind_free_action_reading_to_state(state: &Value, actor_id: &str, value: &str, input: &Value, preserve_action_profile: bool) -> FreeActionResult<Value> {
    let normalized = normalize_free_action_reading(input, value);
    let mut reading = match normalized {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    if !preserve_action_profile {
        let relation = hazard_relation_for(value, &Value::Object(reading.clone()));
        if relation.as_ref().is_some_and(|(_, relation)| *relation == "none") {
            set(&mut reading, "hazard", "");
            set(&mut reading, "activity_kind", "routine");
            set(&mut reading, "plausibility", "trivial");
            set(&mut reading, "risk", "none");
            set(&mut reading, "consequence_type", "time");
            set(&mut reading, "duration_class", "instant");
        } else if !get_str(&reading, "hazard").is_empty() && relation.is_none() && get_str(&reading, "effect") != "hazard_damage" {
            // Поле hazard от модели не создаёт опасность без причинной связи в тексте.
            set(&mut reading, "hazard", "");
        }
        let skill = get_str(&reading, "skill");
        let quiet = get_str(&reading, "hazard").is_empty() && get_str(&reading, "effect") == "none";
        // Поцелуй, объятие, рукопожатие — жест, а не трюк.
        if text::test(affection_gesture(), value) && !text::test(social_aim(), value) && (skill == "acrobatics" || skill == "athletics") && quiet {
            set(&mut reading, "activity_kind", "routine");
            set(&mut reading, "plausibility", "trivial");
            set(&mut reading, "risk", "none");
            set(&mut reading, "consequence_type", "time");
            set(&mut reading, "duration_class", "instant");
            set(&mut reading, "skill", "performance");
            set(&mut reading, "ability", "cha");
        }
        // Цель важнее способа: наблюдение сквозь толпу — Восприятие.
        let skill = get_str(&reading, "skill");
        if text::test(observation_purpose(), value)
            && text::test(mundane_approach(), value)
            && !text::test(stunt_word(), value)
            && (skill == "acrobatics" || skill == "athletics")
            && get_str(&reading, "hazard").is_empty()
            && get_str(&reading, "effect") == "none"
            && get_str(&reading, "target_id").is_empty()
            && get_str(&reading, "effect_target").is_empty()
        {
            set(&mut reading, "skill", "perception");
            set(&mut reading, "ability", "wis");
            set(&mut reading, "activity_kind", "knowledge");
            if get_str(&reading, "risk") != "none" {
                set(&mut reading, "risk", "minor");
            }
            set(&mut reading, "consequence_type", "time");
        }
        let skill = get_str(&reading, "skill");
        let social = ["animal-handling", "deception", "intimidation", "performance", "persuasion"].contains(&skill.as_str());
        let physical = skill == "acrobatics" || skill == "athletics";
        let kind = get_str(&reading, "activity_kind");
        let routine = (kind == "routine" || get_str(&reading, "source").starts_with("deterministic-trivial") || (kind.is_empty() && !physical))
            && get_str(&reading, "risk") == "none"
            && get_str(&reading, "plausibility") == "trivial"
            && get_str(&reading, "effect") == "none"
            && get_str(&reading, "hazard").is_empty()
            && get_str(&reading, "target_id").is_empty()
            && get_str(&reading, "effect_target").is_empty();
        // Механика зависит от семейства действия, а не от наличия слова из примера.
        let family = if routine {
            "routine"
        } else if skill == "acrobatics" || (kind == "stunt" && physical) {
            "stunt"
        } else if skill == "stealth" {
            "stealth"
        } else if social {
            "social"
        } else if ["athletics", "sleight-of-hand", "medicine"].contains(&skill.as_str()) {
            "environmental"
        } else {
            "knowledge"
        };
        set(&mut reading, "activity_kind", family);
        if family == "stunt" {
            // Трюк не бывает рутиной: ошибочное trivial поднимается до strenuous.
            if get_str(&reading, "plausibility") == "trivial" {
                set(&mut reading, "plausibility", "strenuous");
            }
            if get_str(&reading, "risk") == "none" {
                set(&mut reading, "risk", "minor");
            }
            set(&mut reading, "consequence_type", "injury");
            set(&mut reading, "duration_class", "instant");
        } else {
            // Огонь, обвал и ловушки исполняются своими командами реального объекта.
            if get_str(&reading, "consequence_type") == "injury" {
                set(&mut reading, "consequence_type", if social { "lost_opportunity" } else { "time" });
            }
            if get_str(&reading, "duration_class").is_empty() {
                let instant = routine
                    || (get_str(&reading, "risk") == "none" && get_str(&reading, "plausibility") == "trivial")
                    || ["history", "arcana", "nature", "religion"].contains(&skill.as_str());
                set(&mut reading, "duration_class", if instant { "instant" } else if social || skill == "stealth" { "brief" } else { "minutes" });
            }
        }
    }
    // Предмет обстановки живёт в авторитетной карте сцены.
    let prop_id = get_str(&reading, "prop_id");
    let bound_prop = if arr(at(Some(state), &["scene", "map", "props"])).iter().any(|entry| js::s(prop(Some(entry), "id")) == prop_id) { prop_id } else { String::new() };
    let targets: Vec<Value> = action_targets(state, actor_id)?.into_iter().filter(|actor| js::string(prop(Some(actor), "id")) != actor_id).collect();
    let target_id = get_str(&reading, "target_id");
    let allowed_target = targets.iter().find(|actor| js::string(prop(Some(actor), "id")) == target_id);
    let mentioned_targets = match allowed_target {
        Some(target) => vec![target.clone()],
        None => named_actors(&targets, value),
    };
    let actor = find_hero(state, actor_id);
    let inventory = arr(prop(actor, "inventory"));
    let item_id = get_str(&reading, "item_id");
    let allowed_item = inventory.iter().find(|item| js::string(prop(Some(item), "id")) == item_id);
    let mentioned_items: Vec<&Value> = match allowed_item {
        Some(item) => vec![item],
        None => inventory.iter().filter(|item| mentions_reference(value, &item_reference_names(item))).collect(),
    };
    let skill_value = reading.get("skill").cloned();
    let proficiency = skill_proficiency_for_actor(actor, skill_value.as_ref(), Some(state));
    let mut ambiguities = Vec::new();
    if mentioned_targets.len() > 1 {
        ambiguities.push("target_id");
    }
    if mentioned_items.len() > 1 {
        ambiguities.push("item_id");
    }
    reading.insert("prop_id".into(), Value::String(bound_prop));
    reading.insert("target_id".into(), Value::String(if mentioned_targets.len() == 1 { js::string(mentioned_targets[0].get("id")) } else { String::new() }));
    reading.insert("item_id".into(), Value::String(if mentioned_items.len() == 1 { js::string(mentioned_items[0].get("id")) } else { String::new() }));
    let level = if js::truthy(proficiency.get("expertise")) {
        "expertise"
    } else if js::truthy(proficiency.get("proficient")) {
        "proficient"
    } else {
        "none"
    };
    set(&mut reading, "proficiency", level);
    if let Some(bonus) = proficiency.get("bonus") {
        reading.insert("proficiency_bonus".into(), bonus.clone());
    }
    reading.insert("reference_ambiguities".into(), json!(ambiguities));
    // Старые согласованные проверки сохраняют прежнюю цену при подтверждении.
    let policy = if preserve_action_profile {
        let own = prop(Some(input), "policy_version");
        if policy_known(own) { own.cloned().unwrap_or(Value::Null) } else { Value::Null }
    } else {
        json!(RESOLUTION_POLICY_VERSION)
    };
    reading.insert("policy_version".into(), policy);
    Ok(Value::Object(reading))
}

const DIFFICULTY_ORDER: [&str; 3] = ["easy", "medium", "hard"];

/// `contextualResolutionFor(state, actorId, reading, text)`: СЛ остаётся
/// серверной; контекст сдвигает категорию на ступень за подтверждённую причину.
pub fn contextual_resolution_for(state: &Value, actor_id: &str, reading: &Value, value: &str) -> Value {
    let base = resolution_mode_for(reading);
    if !is_str(base.get("mode"), "check") {
        return js::spread(&base, json!({ "difficulty_factors": [] }));
    }
    let category = js::s(base.get("difficulty_category"));
    let mut index = DIFFICULTY_ORDER.iter().position(|entry| *entry == category).map_or(-1, |index| index as i64);
    let mut factors = Vec::new();
    let actor = find_hero(state, actor_id);
    let requested = js::s(prop(Some(reading), "item_id"));
    if arr(prop(actor, "inventory")).iter().any(|entry| js::string(prop(Some(entry), "id")) == requested) {
        index -= 1;
        factors.push("confirmed_item");
    }
    let has_cover = is_str(prop(Some(reading), "skill"), "stealth")
        && text::test(re!(r"(телег|бочк|укрыт|занавес|тень|колонн|ящик)", "iu"), value)
        && (js_length(at(Some(state), &["scene", "map", "props"])) > 0.0 || js_length(at(Some(state), &["scene", "cells"])) > 0.0);
    if has_cover {
        index -= 1;
        factors.push("scene_cover");
    }
    if combat_active(state) {
        index += 1;
        factors.push("combat_pressure");
    }
    // Прямая речь героя — не обстановка: слова в кавычках из текста убираются.
    let narrated = text::replace_all(re!(r#"«[^»]*»|"[^"]*"|“[^”]*”|„[^“”]*[“”]"#, "gu"), value, " ");
    let pressure = format!("{narrated} {}", js::s(at(Some(state), &["scene", "mood"])));
    if text::test(re!(r"(шторм|бур[яе]|пожар|обвал|скольз|темнот|дым|хаос|движущ)", "iu"), &pressure) {
        index += 1;
        factors.push("environmental_pressure");
    }
    if text::test(re!(r"(незаперт|прост\w+\s+задач|без\s+спешк|много\s+времен)", "iu"), value) {
        index -= 1;
        factors.push("favorable_conditions");
    }
    let category = DIFFICULTY_ORDER[index.clamp(0, DIFFICULTY_ORDER.len() as i64 - 1) as usize];
    js::spread(&base, json!({ "difficulty_category": category, "difficulty": difficulty_class(category), "difficulty_factors": factors }))
}

// --- передача вещей -------------------------------------------------------------------

fn transfer_give() -> &'static Regex {
    re!(r"(?<![\p{L}\p{M}])(переда\p{L}*|отда\p{L}*|даю|дам|вруча\p{L}*|give|hand)(?![\p{L}\p{M}])", "iu")
}
fn transfer_take() -> &'static Regex {
    re!(r"(?<![\p{L}\p{M}])(беру|возьму|забира\p{L}*|получа\p{L}*|take|get)(?![\p{L}\p{M}])", "iu")
}
fn inventory_noun() -> &'static Regex {
    re!(r"(предмет|вещ|вер[её]в|меч|кинжал|лук|факел|зель|ключ|карта|свиток|па[её]к|ration|rope|item)", "iu")
}

fn party_actors(state: &Value, actor_id: &str) -> Vec<Value> {
    let social = social_for_viewer(state, actor_id);
    let visible: HashSet<String> = arr(social.get("npcs")).iter().map(|npc| js::string(prop(Some(npc), "id"))).collect();
    players(state)
        .iter()
        .chain(arr(at(Some(state), &["social", "npcs"])).iter().filter(|npc| visible.contains(&js::string(prop(Some(npc), "id")))))
        .filter(|actor| js::string(prop(Some(actor), "id")) != actor_id)
        .cloned()
        .collect()
}

fn mentioned_party_actors(state: &Value, actor_id: &str, value: &str, requested: Option<&Value>) -> Vec<Value> {
    let candidates = party_actors(state, actor_id);
    let requested = js::s(requested);
    if let Some(found) = candidates.iter().find(|actor| js::string(prop(Some(actor), "id")) == requested) {
        return vec![found.clone()];
    }
    let mentioned = named_actors(&candidates, value);
    if !mentioned.is_empty() {
        return mentioned;
    }
    if text::test(re!(r"(?:товарищ|союзник|другому\s+герою|напарник)", "iu"), value) && candidates.len() == 1 {
        candidates
    } else {
        Vec::new()
    }
}

fn mentioned_inventory_items<'a>(inventory: &'a [Value], value: &str, requested: Option<&Value>) -> Vec<&'a Value> {
    let requested = js::s(requested);
    if let Some(found) = inventory.iter().find(|item| js::string(prop(Some(item), "id")) == requested) {
        return vec![found];
    }
    inventory.iter().filter(|item| mentions_reference(value, &item_reference_names(item))).collect()
}

/// `target.character ?? target.name ?? target.id` как значение.
fn display_name(actor: &Value) -> Option<&Value> {
    nullish(nullish(actor.get("character"), actor.get("name")), actor.get("id"))
}

/// `resolveInventoryTransfer(state, actorId, text, reading)`: существующая
/// команда `TransferItem` либо уточнение; `None` — фраза не о передаче.
pub fn resolve_inventory_transfer(state: &Value, actor_id: &str, value: &str, reading: &Value) -> Option<Value> {
    let give = text::test(transfer_give(), value);
    let take = text::test(transfer_take(), value);
    if !give && !take {
        return None;
    }
    let Some(actor) = find_hero(state, actor_id) else {
        return Some(clarification("Герой для передачи предмета не найден."));
    };
    let targets = mentioned_party_actors(state, actor_id, value, prop(Some(reading), "target_id"));
    let inventory = arr(actor.get("inventory"));
    let own_items = mentioned_inventory_items(inventory, value, prop(Some(reading), "item_id"));
    if own_items.is_empty() && !text::test(inventory_noun(), value) {
        return None;
    }
    if targets.len() != 1 {
        return Some(clarification(if targets.len() > 1 {
            format!("Уточните получателя: подходят {}.", targets.iter().map(|target| js::s(display_name(target))).collect::<Vec<_>>().join(", "))
        } else {
            "Уточните, кому нужно передать предмет: назовите героя или присутствующего собеседника.".into()
        }));
    }
    let target = &targets[0];
    let target_name = js::string(display_name(target));
    if take && !give {
        let source_items = mentioned_inventory_items(arr(target.get("inventory")), value, None);
        return Some(clarification(match source_items.len() {
            1 => format!("Эта вещь принадлежит герою {target_name}. Передачу должен подтвердить её владелец своим действием."),
            0 => "У указанного героя нет однозначно названного предмета для передачи.".into(),
            _ => "У владельца найдено несколько подходящих вещей. Пусть он явно укажет, что передаёт.".into(),
        }));
    }
    if own_items.len() != 1 {
        return Some(clarification(if own_items.len() > 1 {
            format!("Уточните предмет: подходят {}.", own_items.iter().map(|item| js::s(nullish(item.get("name"), item.get("id")))).collect::<Vec<_>>().join(", "))
        } else {
            "У героя нет однозначно названного предмета для передачи.".into()
        }));
    }
    if combat_active(state) {
        return Some(clarification("Передавать предметы между инвентарями во время боя нельзя."));
    }
    let item = own_items[0];
    if js::truthy(item.get("equipped")) {
        return Some(clarification("Сначала снимите передаваемый предмет."));
    }
    if js::truthy(item.get("attuned_to")) {
        return Some(clarification("Сначала разорвите настройку с передаваемым предметом."));
    }
    let quantity = text::capture(re!(r"(?:^|\s)(\d{1,3})(?=\s|$)", "u"), value, 1).map_or(1.0, |digits| js::parse_number(&digits));
    let stored = js::number(item.get("quantity"));
    let available = if stored.is_nan() || stored == 0.0 { 1.0 } else { stored }.max(1.0);
    if quantity < 1.0 || quantity > available {
        return Some(clarification(format!("Доступное количество предмета: {}.", js::f64_string(available))));
    }
    let item_name = match nullish(item.get("name"), None) {
        Some(name) => js::string(Some(name)),
        None => "предмет".into(),
    };
    Some(json!({
        "status": "command",
        "command": {
            "command_type": "TransferItem",
            "actor_id": actor_id,
            "recipient_id": js::string(target.get("id")),
            "item_id": js::string(item.get("id")),
            "quantity": js::num(quantity),
        },
        "narration": format!("{} передаёт {item_name}: получатель — {target_name}.", js::string(display_name(actor))),
    }))
}

// --- лестницы ---------------------------------------------------------------------------

fn level_up_phrase() -> &'static Regex {
    re!(r"(?<!\p{L})(?:подним\p{L}*|поднял\p{L}*|подняться|взбира\p{L}*|взбер\p{L}*|взобра\p{L}*|карабка\p{L}*)[^.!?]{0,80}(?:лестниц\p{L}*|ступен\p{L}*|этаж\p{L}*|чердак\p{L}*)|(?<!\p{L})(?:на\s+(?:второй|третий|верхний|следующий)\s+этаж|на\s+чердак)(?!\p{L})", "iu")
}
fn level_down_phrase() -> &'static Regex {
    re!(r"(?<!\p{L})(?:спуска\p{L}*|спущ\p{L}*|спуст\p{L}*|сойти|сходим|слеза\p{L}*|слез\p{L}*)[^.!?]{0,80}(?:лестниц\p{L}*|ступен\p{L}*|этаж\p{L}*|подвал\p{L}*|погреб\p{L}*|люк\p{L}*)|(?<!\p{L})(?:вниз\s+по\s+лестниц\p{L}*|в\s+подвал|в\s+погреб|на\s+(?:первый|нижний)\s+этаж)(?!\p{L})", "iu")
}

fn transition_cells(prop: &sk_tactical::tactical_map::TacticalProp) -> Vec<(f64, f64)> {
    if prop.footprint.is_empty() {
        vec![(prop.x.floor(), prop.y.floor())]
    } else {
        prop.footprint.iter().map(|cell| (cell.x as f64, cell.y as f64)).collect()
    }
}

fn move_command(actor_id: &str, x: f64, y: f64) -> Value {
    json!({ "command_type": "MoveActor", "actor_id": actor_id, "to": point_json(x, y), "server_authoritative": true })
}

fn resolve_level_transition_phrase(state: &Value, actor_id: &str, value: &str, map: &TacticalMap, actor_at: (f64, f64)) -> Option<Value> {
    let up = text::test(level_up_phrase(), value);
    let down = !up && text::test(level_down_phrase(), value);
    if !up && !down {
        return None;
    }
    let here = map.level_index;
    let visible: Vec<&sk_tactical::tactical_map::TacticalProp> = map
        .props
        .iter()
        .filter(|prop| {
            prop.transition.as_ref().is_some_and(|transition| if up { transition.to_level > here } else { transition.to_level < here })
                && transition_cells(prop).iter().any(|(x, y)| revealed_at(map, *x, *y))
        })
        .collect();
    if visible.is_empty() {
        return Some(clarification(format!(
            "{} отсюда не видно. Осмотритесь или пройдите дальше — переход на другой этаж появится на карте, когда отряд его найдёт. Заявка ничего не расходует.",
            if up { "Лестницы наверх" } else { "Спуска вниз" }
        )));
    }
    let near = |prop: &sk_tactical::tactical_map::TacticalProp, at: (f64, f64)| transition_cells(prop).iter().any(|(x, y)| (x - at.0).abs().max((y - at.1).abs()) <= 1.0);
    let label = |prop: &sk_tactical::tactical_map::TacticalProp| {
        let label = clean(prop.transition.as_ref().map_or("", |transition| transition.label.as_str()), 120);
        if label.is_empty() { (if up { "верхний этаж" } else { "нижний этаж" }).to_string() } else { label }
    };
    let use_command = |prop: &sk_tactical::tactical_map::TacticalProp| json!({ "command_type": "UseLevelTransition", "actor_id": actor_id, "prop_id": prop.id });
    let verb = if up { "поднимается" } else { "спускается" };
    if let Some(adjacent) = visible.iter().find(|prop| near(prop, actor_at)) {
        return Some(json!({ "status": "command", "command": use_command(adjacent), "narration": format!("Отряд {verb}: {}.", label(adjacent)) }));
    }
    if combat_active(state) {
        return Some(clarification("Сначала завершите бой: между этажами в бою не ходят. Заявка ничего не расходует."));
    }
    // Подход: ближайшая раскрытая проходимая клетка рядом с лестницей.
    let mut routes = Vec::new();
    for prop in &visible {
        for (cx, cy) in transition_cells(prop) {
            for dx in [-1.0, 0.0, 1.0] {
                for dy in [-1.0, 0.0, 1.0] {
                    if dx == 0.0 && dy == 0.0 {
                        continue;
                    }
                    let (tx, ty) = (cx + dx, cy + dy);
                    let Some(target) = cell_at_f(map, tx, ty) else { continue };
                    if !target.revealed || !target.passable {
                        continue;
                    }
                    if let Some(path) = path_to(state, actor_id, tx, ty).filter(|path| !path.is_empty()) {
                        routes.push((*prop, (tx, ty), path.len()));
                    }
                }
            }
        }
    }
    routes.sort_by(|left, right| left.2.cmp(&right.2).then(left.1 .1.total_cmp(&right.1 .1)).then(left.1 .0.total_cmp(&right.1 .0)));
    let Some((prop, (tx, ty), _)) = routes.first() else {
        return Some(clarification(format!("До перехода «{}» нет свободного пути по раскрытой карте. Выберите маршрут на карте или откройте дверь. Заявка ничего не расходует.", label(visible[0]))));
    };
    Some(json!({
        "status": "command",
        "commands": [move_command(actor_id, *tx, *ty), use_command(prop)],
        "command": use_command(prop),
        "narration": format!("Отряд подходит к лестнице и {verb}: {}.", label(prop)),
    }))
}

// --- подход к названному ------------------------------------------------------------------

fn approach_verb() -> &'static Regex {
    re!(r"(?<![\p{L}\p{M}])(?:подхож\p{L}*|подход(?:ит|им|ят)|подойд\p{L}*|подош[её]л\p{L}*|приближа\p{L}*|приблиз\p{L}*|иду|ид[её]т|ид[её]м|идут|направля\p{L}*|выхож\p{L}*|выход(?:ит|им|ят)|выйд\p{L}*|вышл\p{L}*|выш[её]л|отхож\p{L}*|отход(?:ит|им|ят)|отойд\p{L}*|возвраща\p{L}*|пробира\p{L}*|бреду|бред[её]т|спуска\p{L}*|шагаю|шага(?:ет|ем|ют))(?![\p{L}\p{M}])", "giu")
}
fn approach_target() -> &'static Regex {
    re!(r#"(?:^|\s)(?:к|ко)\s+([^,.;:!?«»"()]{2,60})"#, "iu")
}
fn approach_remainder() -> &'static Regex {
    re!(r"(?:,|\s+и\s+|\s+чтобы\s+|\s+—\s+)", "u")
}

struct ApproachPropTarget {
    stems: &'static [&'static str],
    asset: &'static Regex,
}

static APPROACH_PROP_TARGETS: LazyLock<Vec<ApproachPropTarget>> = LazyLock::new(|| {
    let entry = |stems, asset| ApproachPropTarget { stems, asset };
    vec![
        entry(&["баркас", "лодк", "шлюпк", "ялик", "челн"][..], re!(r"(?:rowboat|boat|skiff|canoe)", "u")),
        entry(&["бочк", "бочонк", "бочек"][..], re!(r"(?:barrel|keg)", "u")),
        entry(&["ящик"][..], re!(r"crate", "u")),
        entry(&["сундук", "ларц", "ларец"][..], re!(r"chest", "u")),
        entry(&["стойк", "прилавк", "стойке"][..], re!(r"(?:bar_counter|shop_counter|counter)", "u")),
        entry(&["очаг", "камин"][..], re!(r"(?:fireplace|hearth|campfire)", "u")),
        entry(&["костр", "костёр", "костер"][..], re!(r"campfire", "u")),
        entry(&["колодц", "колодец"][..], re!(r"well", "u")),
        entry(&["фонтан"][..], re!(r"fountain", "u")),
        entry(&["доске объявлен", "доска объявлен", "объявлен"][..], re!(r"notice_board", "u")),
        entry(&["сетям", "сетей", "сети", "снаст"][..], re!(r"(?:fishing_nets|cargo_net)", "u")),
        entry(&["тумб", "кнехт", "швартов", "причал", "пристан", "пирс"][..], re!(r"mooring", "u")),
        entry(&["лотк", "лоток", "прилавок"][..], re!(r"market_stall", "u")),
        entry(&["алтар"][..], re!(r"altar", "u")),
        entry(&["стату", "изваян"][..], re!(r"statue", "u")),
        entry(&["телег", "повозк"][..], re!(r"cart", "u")),
        entry(&["столб", "фонар"][..], re!(r"(?:lamp_post|signpost)", "u")),
        entry(&["стол"][..], re!(r"(?:table|desk)", "u")),
        entry(&["скамь", "лавк"][..], re!(r"bench", "u")),
        entry(&["кроват", "постел", "койк"][..], re!(r"(?:bed|bunk)", "u")),
        entry(&["дров", "поленниц"][..], re!(r"(?:woodpile|firewood)", "u")),
    ]
});

fn approach_words(phrase: &str) -> Vec<String> {
    fold(&clean(phrase, 120)).split(text::is_js_space).filter(|word| !word.is_empty()).map(str::to_string).collect()
}

/// Индекс символа по байтовому смещению.
fn char_index(value: &str, byte: usize) -> usize {
    value[..byte].chars().count()
}

/// Фраза подхода: что названо после «к …» и что идёт после.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApproachRequest {
    pub phrase: String,
    pub remainder: String,
}

impl ApproachRequest {
    pub fn to_json(&self) -> Value {
        json!({ "phrase": self.phrase, "remainder": self.remainder })
    }
}

/// `approachRequestFrom(text)`: глагол движения, «к …» и то, что идёт после.
/// Берётся последнее «к …».
pub fn approach_request_from(value: &str) -> Option<ApproachRequest> {
    let value = clean(value, 1_000);
    let chars: Vec<char> = value.chars().collect();
    let mut found = None;
    for verb in approach_verb().find_iter(&value).filter_map(Result::ok) {
        let start = char_index(&value, verb.start()) + verb.as_str().chars().count();
        let after: String = chars.iter().skip(start).take(90).collect();
        let Ok(Some(target)) = approach_target().captures(&after) else { continue };
        let (Some(whole), Some(raw)) = (target.get(0), target.get(1)) else { continue };
        let raw = raw.as_str();
        let cut = approach_remainder().find(raw).ok().flatten().map(|found| char_index(raw, found.start()));
        let head = match cut {
            Some(cut) => text::head(raw, cut),
            None => raw.to_string(),
        };
        let phrase = text::trim(&head).split(text::is_js_space).filter(|word| !word.is_empty()).collect::<Vec<_>>();
        let phrase = phrase.into_iter().take(4).collect::<Vec<_>>().join(" ");
        if phrase.is_empty() || text::test(re!(r"^(?:себе|нему|ней|ним|вам|нам|тебе|делу|концу)$", "iu"), &phrase) {
            continue;
        }
        let raw_length = raw.chars().count();
        let end = start + char_index(&after, whole.start()) + whole.as_str().chars().count() - cut.map_or(0, |cut| raw_length - cut);
        let rest: String = chars.iter().skip(end).collect();
        let remainder = text::trim(&text::replace_first(re!(r"^[\s,;—-]*(?:и\s+)?", "u"), &rest, "")).to_string();
        found = Some(ApproachRequest { phrase, remainder });
    }
    found
}

fn approach_cells_around(map: &TacticalMap, cells: &[(f64, f64)], occupied: &HashSet<String>) -> Vec<(f64, f64)> {
    let own: HashSet<String> = cells.iter().map(|(x, y)| position_key(*x, *y)).collect();
    let mut result: IndexMap<String, (f64, f64)> = IndexMap::new();
    for (cx, cy) in cells {
        for dx in [-1.0, 0.0, 1.0] {
            for dy in [-1.0, 0.0, 1.0] {
                if dx == 0.0 && dy == 0.0 {
                    continue;
                }
                let to = (cx + dx, cy + dy);
                let key = position_key(to.0, to.1);
                if own.contains(&key) || occupied.contains(&key) {
                    continue;
                }
                let Some(cell) = cell_at_f(map, to.0, to.1) else { continue };
                if !cell.passable || !cell.revealed {
                    continue;
                }
                result.insert(key, to);
            }
        }
    }
    result.into_values().collect()
}

/// Занятые клетки подхода: другие герои и присутствующие NPC.
fn approach_occupied(state: &Value, actor_id: &str) -> HashSet<String> {
    let mut occupied = HashSet::new();
    for actor in players(state).iter().filter(|actor| js::string(prop(Some(actor), "id")) != actor_id) {
        if let Some((x, y)) = actor_point(state, &js::s(prop(Some(actor), "id"))) {
            occupied.insert(position_key(x, y));
        }
    }
    for npc in present_scene_npcs(state) {
        let placement = npc_placement_for(state, npc.get("id").unwrap_or(&Value::Null), None);
        if let (Some(x), Some(y)) = (finite(prop(placement.as_ref(), "x")), finite(prop(placement.as_ref(), "y"))) {
            occupied.insert(position_key(x, y));
        }
    }
    occupied
}

/// `lootApproachDestination(state, actorId, container)`: куда встать, чтобы
/// обыскать тело вне боя. `None` — подойти нельзя или контейнера нет на карте.
pub fn loot_approach_destination(state: &Value, actor_id: &str, container: &Value) -> Option<Value> {
    let (cx, cy) = (js::number(prop(Some(container), "x")), js::number(prop(Some(container), "y")));
    if !cx.is_finite() || !cy.is_finite() || !scene_map_truthy(state) {
        return None;
    }
    let map = deserialize_scene_map(state)?;
    let occupied = approach_occupied(state, actor_id);
    actor_point(state, actor_id)?;
    let mut routes: Vec<((f64, f64), usize)> = approach_cells_around(&map, &[(cx, cy)], &occupied)
        .into_iter()
        .filter_map(|to| path_to(state, actor_id, to.0, to.1).filter(|path| !path.is_empty() && path_revealed(&map, path)).map(|path| (to, path.len())))
        .collect();
    routes.sort_by(|left, right| left.1.cmp(&right.1).then(left.0 .1.total_cmp(&right.0 .1)).then(left.0 .0.total_cmp(&right.0 .0)));
    routes.first().map(|((x, y), _)| point_json(*x, *y))
}

fn chebyshev(a: (f64, f64), b: (f64, f64)) -> f64 {
    (a.0 - b.0).abs().max((a.1 - b.1).abs())
}

/// `freeActionApproachPlan(state, actorId, text)`: куда встать, чтобы оказаться
/// рядом с названным — человеком, вещью на карте или местом.
pub fn free_action_approach_plan(state: &Value, actor_id: &str, value: &str) -> Value {
    let Some(request) = approach_request_from(value) else { return json!({ "status": "not_applicable" }) };
    if text::test(re!(r"не\s+(?:покида|выход|двига|подход)|без\s+перемещ", "iu"), &clean(value, 1_000)) {
        return json!({ "status": "not_applicable" });
    }
    let unresolved = || json!({ "status": "unresolved", "phrase": request.phrase });
    let Some(from) = actor_point(state, actor_id).filter(|_| scene_map_truthy(state)) else { return unresolved() };
    let Some(map) = deserialize_scene_map(state) else { return unresolved() };
    let words = approach_words(&request.phrase);
    let occupied = approach_occupied(state, actor_id);
    let ready = |kind: &str, label: String, target_cells: &[(f64, f64)], mut cells: Vec<(f64, f64)>| -> Value {
        if target_cells.iter().any(|cell| chebyshev(*cell, from) <= 1.0) {
            return json!({ "status": "already_there", "phrase": request.phrase, "label": label });
        }
        cells.sort_by(|left, right| chebyshev(*left, from).total_cmp(&chebyshev(*right, from)).then(left.1.total_cmp(&right.1)).then(left.0.total_cmp(&right.0)));
        let mut routes: Vec<((f64, f64), Vec<GeoPoint>)> = cells
            .into_iter()
            .take(8)
            .filter_map(|to| path_to(state, actor_id, to.0, to.1).filter(|path| !path.is_empty() && path_revealed(&map, path)).map(|path| (to, path)))
            .collect();
        routes.sort_by(|left, right| left.1.len().cmp(&right.1.len()).then(left.0 .1.total_cmp(&right.0 .1)).then(left.0 .0.total_cmp(&right.0 .0)));
        match routes.first() {
            Some((to, path)) => json!({
                "status": "ready", "kind": kind, "label": label, "phrase": request.phrase, "remainder": request.remainder,
                "destination": { "to": point_json(to.0, to.1), "path": path_json(path) },
            }),
            None => unresolved(),
        }
    };
    // Человек: герой отряда или NPC этой сцены.
    let people = named_actors(&party_actors(state, actor_id), &request.phrase);
    if people.len() == 1 {
        let target = &people[0];
        let placement = npc_placement_for(state, target.get("id").unwrap_or(&Value::Null), None);
        let position = match &placement {
            Some(placement) => (finite(placement.get("x")), finite(placement.get("y"))),
            None => match actor_point(state, &js::s(target.get("id"))) {
                Some((x, y)) => (Some(x), Some(y)),
                None => (None, None),
            },
        };
        if let (Some(x), Some(y)) = position {
            let label = clean_v(nullish(target.get("character"), target.get("name")), 80);
            return ready("actor", label, &[(x, y)], approach_cells_around(&map, &[(x, y)], &occupied));
        }
    }
    // Вещь на карте: ближайшая из подходящих по виду и уже раскрытых.
    let prop_target = APPROACH_PROP_TARGETS.iter().find(|entry| entry.stems.iter().any(|stem| words.iter().any(|word| word.starts_with(stem))));
    if let Some(prop_target) = prop_target {
        let mut props: Vec<(&Value, Vec<(f64, f64)>, f64)> = arr(at(Some(state), &["scene", "map", "props"]))
            .iter()
            .filter(|entry| text::test(prop_target.asset, &text::lower(&clean_v(nullish(prop(Some(entry), "assetId"), prop(Some(entry), "id")), 120))))
            .filter(|entry| {
                let visibility = text::lower(&js::s(prop(Some(entry), "visibility")));
                visibility != "gm_only" && visibility != "npc_private" && !js::is_false(prop(Some(entry), "revealed"))
            })
            .map(|entry| {
                let cells: Vec<(f64, f64)> = hazard_prop_cells(Some(entry)).iter().map(xy).filter(|(x, y)| revealed_at(&map, *x, *y)).collect();
                (entry, cells)
            })
            .filter(|(_, cells)| !cells.is_empty())
            .map(|(entry, cells)| {
                let distance = cells.iter().map(|cell| chebyshev(*cell, from)).fold(f64::INFINITY, f64::min);
                (entry, cells, distance)
            })
            .collect();
        props.sort_by(|left, right| left.2.total_cmp(&right.2).then_with(|| text::locale_compare(&clean_v(left.0.get("id"), 300), &clean_v(right.0.get("id"), 300))));
        for (_, cells, _) in props.iter().take(3) {
            let plan = ready("prop", request.phrase.clone(), cells, approach_cells_around(&map, cells, &occupied));
            if !is_str(plan.get("status"), "unresolved") {
                return plan;
            }
        }
    }
    // Место: зона карты, чьё название начинается так же, как слово игрока.
    let zone = map.zones.iter().find(|candidate| {
        let label = approach_words(&candidate.label);
        !label.is_empty()
            && words.iter().any(|word| {
                text::len(word) >= 4 && label.iter().any(|part| text::len(part) >= 4 && text::head(part, 5) == text::head(word, 5))
            })
    });
    if let Some(zone) = zone {
        let mut cells = Vec::new();
        for y in 0..map.height {
            for x in 0..map.width {
                let Some(cell) = cell_at(&map, x, y) else { continue };
                if cell.zone == zone.id && cell.passable && cell.revealed && !occupied.contains(&position_key(x as f64, y as f64)) {
                    cells.push((x as f64, y as f64));
                }
            }
        }
        let label = clean(&zone.label, 80);
        if cells.iter().any(|cell| *cell == from) {
            return json!({ "status": "already_there", "phrase": request.phrase, "label": label });
        }
        if !cells.is_empty() {
            return ready("zone", label, &[], cells);
        }
    }
    unresolved()
}

/// `resolveExplorationCommand(state, actorId, text)`: свободная фраза выбирает
/// только существующую команду (двери, лестницы, подход); путь и замок считает
/// движок. `None` — фраза не об этом.
pub fn resolve_exploration_command(state: &Value, actor_id: &str, value_text: &str) -> Option<Value> {
    let value = clean(value_text, 2_000);
    let actor_at = actor_point(state, actor_id)?;
    if !scene_map_truthy(state) {
        return None;
    }
    let map = deserialize_scene_map(state)?;
    let make_barricade = text::test(re!(r"^(?:я\s+)?(?:подпираю|баррикадирую|забаррикадирую|ставлю\s+баррикаду)", "iu"), &value);
    let clear_barricade = text::test(re!(r"^(?:я\s+)?(?:снимаю|убираю|разбираю|выбиваю|разрушаю)\s+баррикаду", "iu"), &value);
    let door_operation = make_barricade
        || clear_barricade
        || (text::test(re!(r"^(?:я\s+)?(?:открыва|закрыва|отпира|взламыва|выламыва|выбива)", "iu"), &value) && text::test(re!(r"двер", "iu"), &value));
    if door_operation {
        let visible: Vec<_> = map.doors.iter().filter(|door| cell_at(&map, door.x, door.y).is_some_and(|cell| cell.revealed)).collect();
        let named: Vec<_> = visible.iter().filter(|door| value.contains(door.id.as_str())).copied().collect();
        let nearby: Vec<_> = doors_reachable_from(&map, actor_at.0 as i64, actor_at.1 as i64).into_iter().filter(|door| visible.iter().any(|entry| entry.id == door.id)).collect();
        let candidates = if named.is_empty() { nearby } else { named };
        if candidates.len() != 1 {
            return Some(clarification(if candidates.len() > 1 {
                "Здесь несколько дверей. Выберите нужную на карте, чтобы я не открыл другую."
            } else {
                "До двери нужно дотянуться. Подойдите вплотную к нужной двери на карте; сама попытка открыть её пока ничего не расходует."
            }));
        }
        let door = candidates[0];
        if make_barricade {
            let actor = find_hero(state, actor_id);
            let items = mentioned_inventory_items(arr(prop(actor, "inventory")), &value, None);
            if items.len() != 1 {
                return Some(clarification("Назовите один материал из своего инвентаря: доску, верёвку или подходящую скамью. Предмет будет израсходован на баррикаду."));
            }
            let name = js::string(items[0].get("name"));
            return Some(json!({
                "status": "command",
                "command": { "command_type": "BarricadeDoor", "actor_id": actor_id, "door_id": door.id, "material_item_id": items[0].get("id") },
                "requires_confirmation": true,
                "confirmation": format!("Материал баррикады: «{name}» — он будет израсходован. В бою потребуется действие. Подтвердите шаг или выберите другой материал."),
                "narration": format!("Дверь забаррикадирована. Материал «{name}» израсходован."),
            }));
        }
        if clear_barricade || (door.barricade().is_some() && text::test(re!(r"^(?:я\s+)?(?:выламываю|выбиваю)", "iu"), &value)) {
            let force = text::test(re!(r"выбиваю|разрушаю|выламываю", "iu"), &value);
            return Some(json!({
                "status": "command",
                "command": { "command_type": "ClearDoorBarricade", "actor_id": actor_id, "door_id": door.id, "force": force },
                "requires_confirmation": force,
                "confirmation": "Выбивание баррикады: Атлетика от Силы, СЛ 15. Успех уберёт препятствие, при провале оно останется. В бою действие расходуется в любом случае. Подтвердите шаг или выберите другой способ.",
                "narration": "Баррикада снята. Дверью снова можно пользоваться.",
            }));
        }
        let force = text::test(re!(r"^(?:я\s+)?(?:выламыва|выбива)", "iu"), &value);
        if force && text::test(re!(r"не\s+лом|не\s+повреж|без\s+повреж", "iu"), &value) {
            return Some(clarification("Выламывание повредит дверь. Для целого замка выберите взлом отмычками или другой проход."));
        }
        let intent = if force {
            "force"
        } else if text::test(re!(r"взламыва|отмыч", "iu"), &value) {
            "lockpick"
        } else if text::test(re!(r"закрыва", "iu"), &value) {
            "close"
        } else {
            "open"
        };
        if intent == "open" && door.state == "locked" {
            return Some(clarification("Дверь заперта. Открыть её обычным движением нельзя: можно взломать замок отмычками, выломать дверь с риском шума или поискать другой проход."));
        }
        return Some(json!({
            "status": "command",
            "command": { "command_type": "OperateDoor", "actor_id": actor_id, "door_id": door.id, "intent": intent },
            "narration": "Действие с дверью разрешено по её состоянию.",
        }));
    }
    if let Some(stairs) = resolve_level_transition_phrase(state, actor_id, &value, &map, actor_at) {
        return Some(stairs);
    }
    let approach = approach_request_from(&value)?;
    if !approach.remainder.is_empty() || text::test(re!(r"(?:затем|потом|и\s+(?:прошу|спрашиваю|атакую|открываю))", "iu"), &value) {
        return None;
    }
    if text::test(re!(r"не\s+(?:покида|выход|двига)|без\s+перемещ", "iu"), &value) {
        return Some(clarification("Подход означает перемещение, а вы просите оставаться на месте или под укрытием. Можно обратиться к собеседнику с места; либо уточните, какое перемещение допустимо."));
    }
    let hero_name = || {
        let actor = find_hero(state, actor_id);
        let name = clean_v(nullish(prop(actor, "character"), prop(actor, "name")), 80);
        if name.is_empty() { "Герой".to_string() } else { name }
    };
    let candidates = named_actors(&party_actors(state, actor_id), &approach.phrase);
    if candidates.len() != 1 {
        // Не человек — может быть, вещь или место на карте.
        let plan = free_action_approach_plan(state, actor_id, &value);
        let hero = hero_name();
        if is_str(plan.get("status"), "already_there") {
            return Some(clarification(format!("{hero} уже стоит рядом — можно действовать.")));
        }
        if !is_str(plan.get("status"), "ready") {
            return None;
        }
        let (x, y) = xy(&plan["destination"]["to"]);
        return Some(json!({ "status": "command", "command": move_command(actor_id, x, y), "narration": format!("{hero} подходит к {}.", js::s(plan.get("phrase"))) }));
    }
    let target = &candidates[0];
    let placement = npc_placement_for(state, target.get("id").unwrap_or(&Value::Null), None);
    let at_value = match &placement {
        Some(placement) => placement.clone(),
        None => actor_point(state, &js::s(target.get("id"))).map_or(Value::Null, |(x, y)| point_json(x, y)),
    };
    let (Some(tx), Some(ty)) = (finite(at_value.get("x")), finite(at_value.get("y"))) else {
        return Some(clarification("Положение собеседника на карте пока не определено. Можно обратиться к нему словами, не объявляя перемещение."));
    };
    let geometry = match &placement {
        Some(placement) => match placement.get("footprint") {
            Some(footprint) => json!({ "footprint": footprint }),
            None => json!({}),
        },
        None => target.clone(),
    };
    let distance = footprint_distance_feet(find_hero(state, actor_id), Some(&geometry), Some(&point_json(actor_at.0, actor_at.1)), Some(&at_value));
    if distance.is_some_and(|feet| feet <= 5.0) {
        return Some(clarification("Вы уже рядом с собеседником. Можно заговорить или выбрать другое действие."));
    }
    let mut routes = Vec::new();
    for dx in [-1.0, 0.0, 1.0] {
        for dy in [-1.0, 0.0, 1.0] {
            if dx == 0.0 && dy == 0.0 {
                continue;
            }
            let (x, y) = (tx + dx, ty + dy);
            if !revealed_at(&map, x, y) {
                continue;
            }
            if let Some(path) = path_to(state, actor_id, x, y).filter(|path| !path.is_empty()) {
                routes.push(((x, y), path.len()));
            }
        }
    }
    routes.sort_by(|left, right| left.1.cmp(&right.1).then(left.0 .1.total_cmp(&right.0 .1)).then(left.0 .0.total_cmp(&right.0 .0)));
    let Some(((x, y), _)) = routes.first() else {
        return Some(clarification("Свободного раскрытого пути к собеседнику нет. Можно выбрать другой маршрут на карте или обратиться с места."));
    };
    Some(json!({
        "status": "command",
        "command": move_command(actor_id, *x, *y),
        "narration": format!("{} подходит ближе — {} теперь рядом.", hero_name(), js::string(nullish(target.get("character"), target.get("name")))),
    }))
}

// --- карманы ---------------------------------------------------------------------------------

fn pickpocket_phrase() -> &'static Regex {
    re!(r"(?:обчищ\p{L}*|обчист\p{L}*|очищ\p{L}*|шар\p{L}*|лез\p{L}*|залез\p{L}*|тян\p{L}*|крад\p{L}*|ворую|своро\p{L}*|срез\p{L}*|стащ\p{L}*|стян\p{L}*|подрез\p{L}*)[^.!?]{0,80}(?:карман\p{L}*|кошел\p{L}*|мошн\p{L}*|кошель)|(?:карман\p{L}*|кошел\p{L}*|мошн\p{L}*)[^.!?]{0,80}(?:обчищ\p{L}*|обчист\p{L}*|срез\p{L}*|стащ\p{L}*|стян\p{L}*|подрез\p{L}*)", "iu")
}

/// `resolvePickpocket(state, actorId, text, reading)`: карманная кража
/// свободной фразой — команда `PickpocketNpc` или уточнение.
pub fn resolve_pickpocket(state: &Value, actor_id: &str, value: &str, reading: &Value) -> Option<Value> {
    let looks_like_theft = text::test(pickpocket_phrase(), value) || js::s(prop(Some(reading), "skill")) == "sleight-of-hand";
    if !looks_like_theft {
        return None;
    }
    let requested = clean_v(prop(Some(reading), "target_id"), 120);
    let named: Vec<Value> = current_social_actors(state)
        .into_iter()
        .filter(|npc| js::string(npc.get("id")) == requested || mentions_reference(value, &reference_names(npc)))
        .collect();
    // Кража у своих не разбирается вовсе.
    let party = players(state).iter().any(|hero| mentions_reference(value, &reference_names(hero)));
    if named.is_empty() && party {
        return Some(clarification("У своих не крадут: обчистить можно только чужой карман."));
    }
    if !text::test(pickpocket_phrase(), value) {
        return None;
    }
    if named.len() != 1 {
        return Some(clarification(if named.len() > 1 {
            format!("Уточните, чей карман: подходят {}.", named.iter().map(|npc| js::s(nullish(npc.get("name"), npc.get("id")))).collect::<Vec<_>>().join(", "))
        } else {
            "Уточните, у кого именно вы хотите обчистить карман.".into()
        }));
    }
    if combat_active_strict(state) {
        return Some(clarification("Посреди боя карманов не чистят."));
    }
    let npc = &named[0];
    Some(json!({
        "status": "command",
        "command": { "command_type": "PickpocketNpc", "actor_id": actor_id, "npc_id": js::string(npc.get("id")) },
        "narration": format!("Рука тянется к чужому кошельку: {}.", js::string(nullish(npc.get("name"), npc.get("id")))),
    }))
}

// --- обыск тел --------------------------------------------------------------------------------

const CORPSE_WORD: &str = r"(?:труп|тел[оаеу]|(?<![\p{L}\p{M}])тел(?![\p{L}\p{M}])|останки|карман|(?<![\p{L}\p{M}])(?:поверженн|павш|убит|мертвец|мёртв|мертв))";
const SEARCH_VERB: &str = r"(?:обыск\p{L}*|провер\p{L}*|осматр\p{L}*|ищ\p{L}*)";

static CORPSE_SEARCH: LazyLock<Regex> = LazyLock::new(|| {
    text::js_regex(&format!("{SEARCH_VERB}[^.!?]{{0,80}}{CORPSE_WORD}|{CORPSE_WORD}[^.!?]{{0,80}}{SEARCH_VERB}"), "iu").expect("CORPSE_SEARCH")
});

/// `freeActionIsCorpseSearch(text)`: заявка — обыск тела или тел.
pub fn free_action_is_corpse_search(value: &str) -> bool {
    text::test(&CORPSE_SEARCH, &clean(value, 2_000))
}

fn plural_loot_search() -> &'static Regex {
    re!(r"(?<![\p{L}\p{M}])(?:поверженн(?:ых|ые)|павш(?:их|ие)|убит(?:ых|ые)|мертвец(?:ов|ы)|мёртв(?:ых|ые)|мертв(?:ых|ые)|тела(?![\p{L}\p{M}])|тел|трупы|трупов|всех)(?![\p{L}\p{M}])", "iu")
}

fn loot_kind_words() -> [(&'static str, &'static Regex); 4] {
    [
        ("corpse", re!(r"(?:труп\p{L}*|тел[оаеу](?![\p{L}\p{M}])|телами|останк\p{L}*|павш\p{L}*|мертвец\p{L}*|убит\p{L}*|поверженн\p{L}*|мёртв\p{L}*|мертв\p{L}*)", "iu")),
        ("captive", re!(r"(?:пленн\p{L}*|сдавш\p{L}*|связанн\p{L}*)", "iu")),
        ("abandoned", re!(r"(?:брошенн\p{L}*|оставленн\p{L}*|откуп\p{L}*)", "iu")),
        ("cache", re!(r"(?:схрон\p{L}*|тайник\p{L}*|заначк\p{L}*)", "iu")),
    ]
}

const MAX_SPOKEN_LOOT_ITEMS: usize = 8;

fn container_sources(container: &Value) -> Vec<String> {
    std::iter::once(container.get("source_enemy_id"))
        .chain(arr(container.get("source_enemy_ids")).iter().map(Some))
        .filter(|value| js::truthy(*value))
        .map(js::string)
        .collect()
}

fn loot_container_reference_names(state: &Value, container: &Value) -> Vec<String> {
    let sources: HashSet<String> = container_sources(container).into_iter().collect();
    let enemy_names: Vec<String> = arr(prop(Some(state), "enemies"))
        .iter()
        .filter(|enemy| sources.contains(&js::s(prop(Some(enemy), "id"))))
        .flat_map(reference_names)
        .collect();
    let name = clean_v(container.get("name"), 160);
    let subject = name.find(": ").map_or(String::new(), |index| name[index + 2..].to_string());
    [name, subject].into_iter().chain(enemy_names).filter(|value| !value.is_empty()).collect()
}

fn source_ids_include(container: &Value, id: &str) -> bool {
    arr(container.get("source_enemy_ids")).iter().any(|entry| entry.as_str() == Some(id))
}

fn loot_containers_named_by(state: &Value, value: &str, reading: &Value, containers: &[Value]) -> Vec<Value> {
    let requested = clean_v(prop(Some(reading), "target_id"), 120);
    if !requested.is_empty() {
        return containers.iter().filter(|container| is_str(container.get("source_enemy_id"), &requested) || source_ids_include(container, &requested)).cloned().collect();
    }
    let named: Vec<Value> = containers.iter().filter(|container| mentions_reference(value, &loot_container_reference_names(state, container))).cloned().collect();
    if !named.is_empty() {
        return named;
    }
    let kinds: Vec<&str> = loot_kind_words().into_iter().filter(|(_, pattern)| text::test(pattern, value)).map(|(kind, _)| kind).collect();
    if kinds.is_empty() {
        containers.to_vec()
    } else {
        containers.iter().filter(|container| kinds.contains(&js::s(container.get("kind")).as_str())).cloned().collect()
    }
}

fn reach_distance(reach: &Value) -> f64 {
    reach.get("distance_feet").and_then(Value::as_f64).unwrap_or(f64::INFINITY)
}

fn container_id(container: &Value) -> String {
    js::s(container.get("id"))
}

fn nearest_loot_container(state: &Value, hero: Option<&Value>, containers: &[Value]) -> FreeActionResult<Option<Value>> {
    let mut measured = Vec::new();
    for container in containers {
        measured.push((container, loot_container_reach_for(state, hero, container)?));
    }
    let within: Vec<_> = measured.iter().filter(|(_, reach)| js::truthy(reach.get("reachable"))).cloned().collect();
    let mut pool = if within.is_empty() { measured } else { within };
    pool.sort_by(|left, right| {
        reach_distance(&left.1)
            .partial_cmp(&reach_distance(&right.1))
            .filter(|order| order.is_ne())
            .unwrap_or_else(|| text::locale_compare(&container_id(left.0), &container_id(right.0)))
    });
    let Some(first) = pool.first() else { return Ok(None) };
    if pool.get(1).is_some_and(|second| reach_distance(&second.1) == reach_distance(&first.1)) {
        return Ok(None);
    }
    Ok(Some(first.0.clone()))
}

fn spoken_loot_contents(container: &Value) -> FreeActionResult<(Vec<Value>, String)> {
    let mut items = Vec::new();
    for item in arr(container.get("items")) {
        items.push(loot_item_for_viewer(item)?);
    }
    let spoken = items
        .iter()
        .take(MAX_SPOKEN_LOOT_ITEMS)
        .map(|item| {
            let name = js::string(item.get("name"));
            if js::number(item.get("quantity")) > 1.0 {
                format!("{name} ({})", js::string(item.get("quantity")))
            } else {
                name
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    let rest = items.len() - items.len().min(MAX_SPOKEN_LOOT_ITEMS);
    let summary = if rest > 0 { format!("{spoken} и ещё {rest}") } else { spoken };
    Ok((items, summary))
}

fn strip_body_prefix(name: &str) -> String {
    text::replace_first(re!(r"^Тело:\s*", "u"), name, "")
}

fn loot_container_answer(state: &Value, hero: Option<&Value>, container: &Value) -> FreeActionResult<Value> {
    let reach = loot_container_reach_for(state, hero, container)?;
    let within = js::truthy(reach.get("reachable"));
    let distance = nullish(reach.get("distance_feet"), None);
    let name = js::string(container.get("name"));
    let first_source = arr(container.get("source_enemy_ids")).first();
    let corpse_id = if js::truthy(container.get("source_enemy_id")) {
        js::s(container.get("source_enemy_id"))
    } else if js::truthy(first_source) {
        js::s(first_source)
    } else {
        String::new()
    };
    let mut answer = Map::new();
    answer.insert("status".into(), json!("clarification"));
    answer.insert("server_owned_contents".into(), json!(is_str(container.get("status"), "available")));
    answer.insert("corpse_id".into(), json!(corpse_id));
    answer.insert("loot_container_id".into(), container.get("id").cloned().unwrap_or(Value::Null));
    answer.insert("loot_container_kind".into(), container.get("kind").cloned().unwrap_or(Value::Null));
    answer.insert("loot_container_name".into(), container.get("name").cloned().unwrap_or(Value::Null));
    if let Some(distance) = distance {
        answer.insert("distance_feet".into(), distance.clone());
    }
    if !is_str(container.get("status"), "available") {
        answer.insert("narration".into(), json!(format!("{name}: здесь уже всё сняли, контейнер добычи пуст.")));
        return Ok(Value::Object(answer));
    }
    if !within {
        let far = distance.map_or(String::new(), |distance| format!(" (ещё {} фт)", js::string(Some(distance))));
        answer.insert("narration".into(), json!(format!("{name}: отсюда не дотянуться{far} — подойдите вплотную, и станет видно, что там.")));
        return Ok(Value::Object(answer));
    }
    let (items, summary) = spoken_loot_contents(container)?;
    let combat = combat_active_strict(state);
    let owner = strip_body_prefix(&name);
    let crowded = loot_containers_in_scene(state, false)?.iter().filter(|entry| is_str(entry.get("kind"), "corpse")).count() > 1;
    let found = if !is_str(container.get("kind"), "corpse") {
        format!("{name}: {summary}")
    } else if crowded {
        format!("{owner}: под одеждой и в карманах — {summary}")
    } else {
        format!("Под одеждой и в карманах — {summary}")
    };
    let tail = if combat { " В бою снять что-то стоит действия; посмотреть — нет." } else { "" };
    answer.insert("narration".into(), json!(format!("{found}. Бери, что приглянется.{tail}")));
    answer.insert("loot_items".into(), Value::Array(items));
    answer.insert("loot_action_cost".into(), if combat { json!("action") } else { Value::Null });
    Ok(Value::Object(answer))
}

fn loot_containers_answer(state: &Value, hero: Option<&Value>, containers: &[Value]) -> FreeActionResult<Option<Value>> {
    let mut reached = Vec::new();
    for container in containers {
        if is_str(container.get("status"), "available") && js::truthy(loot_container_reach_for(state, hero, container)?.get("reachable")) {
            reached.push(container);
        }
    }
    if reached.len() < 2 {
        return Ok(None);
    }
    let combat = combat_active_strict(state);
    let mut lines = Vec::new();
    for container in reached.iter().take(4) {
        let name = js::string(container.get("name"));
        let shown = if is_str(container.get("kind"), "corpse") { strip_body_prefix(&name) } else { name };
        lines.push(format!("{shown} —{}", spoken_loot_contents(container)?.1));
    }
    let mut items = Vec::new();
    for container in &reached {
        items.extend(spoken_loot_contents(container)?.0);
    }
    let bodies = if reached.iter().all(|container| is_str(container.get("kind"), "corpse")) { "При телах: " } else { "" };
    let tail = if combat { " В бою снять что-то стоит действия; посмотреть — нет." } else { "" };
    Ok(Some(json!({
        "status": "clarification",
        "server_owned_contents": true,
        "loot_container_ids": reached.iter().map(|container| container.get("id").cloned().unwrap_or(Value::Null)).collect::<Vec<_>>(),
        "loot_items": items,
        "narration": format!("{bodies}{}. Бери, что приглянется.{tail}", lines.join("; ")),
        "loot_action_cost": if combat { json!("action") } else { Value::Null },
    })))
}

fn resolve_loot_container_search(state: &Value, hero: Option<&Value>, value: &str, reading: &Value) -> FreeActionResult<Option<Value>> {
    let in_scene = loot_containers_in_scene(state, true)?;
    if in_scene.is_empty() {
        return Ok(None);
    }
    let candidates = loot_containers_named_by(state, value, reading, &in_scene);
    if candidates.is_empty() {
        return Ok(None);
    }
    let available: Vec<Value> = candidates.iter().filter(|container| is_str(container.get("status"), "available")).cloned().collect();
    let pool = if available.is_empty() { candidates } else { available };
    if text::test(plural_loot_search(), value) {
        if let Some(all) = loot_containers_answer(state, hero, &pool)? {
            return Ok(Some(all));
        }
    }
    let chosen = nearest_loot_container(state, hero, &pool)?;
    if chosen.is_none() {
        if let Some(together) = loot_containers_answer(state, hero, &pool)? {
            return Ok(Some(together));
        }
    }
    match chosen {
        Some(container) => Ok(Some(loot_container_answer(state, hero, &container)?)),
        None => {
            let mut sorted = pool.clone();
            sorted.sort_by(|left, right| text::locale_compare(&container_id(left), &container_id(right)));
            match sorted.first() {
                Some(first) => Ok(Some(loot_container_answer(state, hero, first)?)),
                None => Ok(Some(json!({ "status": "clarification", "narration": "Обыскивать здесь нечего.", "server_owned_contents": false }))),
            }
        }
    }
}

/// `resolveCorpseSearch(state, actorId, text, reading)`: обыск тела словами
/// — ответ контейнера добычи, честный отказ или уточнение. Событий не рождает.
/// `None` — фраза не об обыске тела.
pub fn resolve_corpse_search(state: &Value, actor_id: &str, value: &str, reading: &Value) -> FreeActionResult<Option<Value>> {
    if !text::test(&CORPSE_SEARCH, value) {
        return Ok(None);
    }
    let hero = players(state).iter().find(|player| js::s(prop(Some(player), "id")) == actor_id);
    if let Some(answer) = resolve_loot_container_search(state, hero, value, reading)? {
        return Ok(Some(answer));
    }
    let corpses: Vec<&Value> = arr(prop(Some(state), "enemies"))
        .iter()
        .filter(|actor| js::is_false(prop(Some(actor), "alive")) || js::number(Some(nullish(prop(Some(actor), "hp"), None).unwrap_or(&json!(1)))) <= 0.0)
        .chain(arr(prop(Some(state), "entities")).iter().filter(|entity| ["corpse", "body", "remains"].contains(&js::s(prop(Some(entity), "kind")).as_str())))
        .collect();
    let requested_id = js::s(prop(Some(reading), "target_id"));
    let requested = corpses.iter().find(|corpse| js::string(prop(Some(corpse), "id")) == requested_id);
    let mentioned: Vec<&Value> = match requested {
        Some(found) => vec![*found],
        None => corpses.iter().filter(|corpse| mentions_reference(value, &reference_names(corpse))).copied().collect(),
    };
    let candidates: Vec<&Value> = if !mentioned.is_empty() {
        mentioned
    } else if corpses.len() == 1 {
        corpses.clone()
    } else {
        Vec::new()
    };
    let pool = if candidates.is_empty() { corpses.clone() } else { candidates.clone() };
    let empty_handed = |corpse: &Value| {
        let loadout = corpse.get("loadout");
        arr(prop(loadout, "items")).is_empty()
            && js::number(prop(loadout, "purse_cp")).partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater)
            && arr(corpse.get("search_contents")).is_empty()
            && arr(corpse.get("corpse_contents")).is_empty()
    };
    if candidates.len() != 1 && !pool.is_empty() && pool.iter().all(|corpse| empty_handed(corpse)) {
        return Ok(Some(json!({
            "status": "bodies_searched",
            "narration": if pool.len() > 1 { "Карманы и пояса пусты: ничего ценного при телах нет." } else { "Карманы и пояс пусты: ничего ценного при теле нет." },
            "server_owned_contents": true,
            "corpse_ids": pool.iter().map(|corpse| js::s(corpse.get("id"))).collect::<Vec<_>>(),
        })));
    }
    if candidates.len() != 1 {
        return Ok(Some(json!({
            "status": "clarification",
            "narration": if candidates.len() > 1 {
                format!("Уточните, чьё тело обыскивает герой: {}.", candidates.iter().map(|corpse| js::s(nullish(corpse.get("name"), corpse.get("id")))).collect::<Vec<_>>().join(", "))
            } else {
                "Укажите конкретное тело, которое герой хочет обыскать.".into()
            },
            "server_owned_contents": false,
        })));
    }
    let corpse = candidates[0];
    let corpse_id = js::s(corpse.get("id"));
    let loadout = corpse.get("loadout").filter(|loadout| loadout.is_object());
    let carried = !arr(prop(loadout, "items")).is_empty() || js::number(prop(loadout, "purse_cp")) > 0.0;
    let contents = match (corpse.get("search_contents"), corpse.get("corpse_contents")) {
        (Some(Value::Array(_)), _) => true,
        (_, Some(Value::Array(_))) => true,
        _ => false,
    };
    let container = loot_container_list(state).into_iter().find(|entry| is_str(entry.get("source_enemy_id"), &corpse_id) || source_ids_include(entry, &corpse_id));
    if let Some(container) = container {
        let here = loot_containers_in_scene(state, true)?.iter().any(|entry| entry.get("id") == container.get("id"));
        if here {
            let mut answer = loot_container_answer(state, hero, &container)?;
            if let Some(map) = answer.as_object_mut() {
                map.insert("corpse_id".into(), json!(corpse_id));
            }
            return Ok(Some(answer));
        }
        return Ok(Some(json!({
            "status": "clarification",
            "narration": format!("Добыча с этого тела осталась на другом ярусе ({}): обыскать её можно, вернувшись туда.", js::string(container.get("name"))),
            "server_owned_contents": is_str(container.get("status"), "available"),
            "corpse_id": corpse_id,
            "loot_container_id": container.get("id"),
        })));
    }
    Ok(Some(json!({
        "status": "clarification",
        "narration": if carried {
            "На теле действительно есть снаряжение, но контейнера добычи у него не заведено: взять его сейчас нельзя. Я не буду ни выдумывать находку, ни бросать проверку вместо неё."
        } else if contents {
            "У тела есть описанное содержимое, но оно ещё не оформлено как авторитетный контейнер. Нужна отдельная серверная команда извлечения."
        } else {
            "У этого тела нет заданного сервером содержимого. Я не буду выдумывать находку или бросать проверку вместо неё."
        },
        "server_owned_contents": carried || contents,
        "corpse_id": corpse_id,
    })))
}

// --- средства --------------------------------------------------------------------------------

fn means_key(value: Option<&Value>) -> String {
    let folded = fold(&clean_v(value, 160));
    text::trim(&text::replace_all(re!(r"[^\p{L}\p{N}]+", "gu"), &folded, " ")).to_string()
}

fn means_key_str(value: &str) -> String {
    means_key(Some(&Value::String(value.to_string())))
}

fn means_kind_prefix() -> &'static Regex {
    re!(r"^(?:заклинани[еяю]|заговора?|чары|умени[еяю]|способност[ьи]|(?:классов\S*\s+)?особенност[ьи]|черт[аыу]|боев\S*\s+стил[ьяю]|прием|навык|предмет|вещь|инструмент|spell|cantrip|feature|item)\s+", "u")
}

fn means_keys(value: &str) -> IndexSet<String> {
    let mut keys = IndexSet::new();
    keys.insert(means_key_str(value));
    let quoted = re!(r#"[«"“„]([^«»"“”„]+)[»"”“]"#, "gu");
    for captures in quoted.captures_iter(value).filter_map(Result::ok) {
        if let Some(inner) = captures.get(1) {
            keys.insert(means_key_str(inner.as_str()));
        }
    }
    for key in keys.clone() {
        keys.insert(text::replace_first(means_kind_prefix(), &key, ""));
    }
    keys.shift_remove("");
    keys
}

fn actor_means(state: &Value, actor_id: &str) -> IndexSet<String> {
    let mut keys = IndexSet::new();
    let Some(actor) = player_by_id(state, actor_id) else { return keys };
    let mut add = |value: Option<&Value>| {
        if js::truthy(value) {
            keys.insert(means_key(value));
        }
    };
    for item in arr(actor.get("inventory")) {
        for key in ["id", "catalog_id", "name"] {
            add(prop(Some(item), key));
        }
    }
    for key in ["knownSpellIds", "preparedSpellIds", "selectedFeatureIds", "classSkillProficiencies"] {
        for value in arr(actor.get(key)) {
            add(Some(value));
        }
    }
    let options = match state.get("ruleset_id") {
        Some(ruleset) => json!({ "rulesetId": ruleset }),
        None => json!({}),
    };
    let mut spells: Vec<Option<Value>> = combat_spells_for(Some(actor), Some(&options)).into_iter().filter(|spell| !js::is_false(spell.get("prepared"))).map(Some).collect();
    for id in arr(actor.get("knownSpellIds")).iter().chain(arr(actor.get("preparedSpellIds"))) {
        spells.push(canonical_combat_spell_for(Some(id), Some(&options)));
    }
    for spell in spells.iter().flatten() {
        for key in ["id", "name", "englishName"] {
            add(spell.get(key));
        }
    }
    let selected: HashSet<String> = normalized_selected_feature_ids(Some(actor)).into_iter().collect();
    for group in feature_choice_groups_for(Some(actor)) {
        let chosen: Vec<&Value> = arr(group.get("options")).iter().filter(|option| option.get("id").and_then(Value::as_str).is_some_and(|id| selected.contains(id))).collect();
        if !chosen.is_empty() {
            add(group.get("name"));
        }
        for option in chosen {
            add(option.get("name"));
        }
    }
    for action in combat_actions_for(Some(actor)) {
        if !is_str(action.get("category"), "common") {
            add(action.get("id"));
            add(action.get("name"));
        }
    }
    keys.shift_remove("");
    keys
}

/// `verifyMeans(state, actorId, requiredMeans)`: сверка заявленных средств с
/// миром — `{ satisfied, required, missing }`.
pub fn verify_means(state: &Value, actor_id: &str, required_means: Option<&Value>) -> Value {
    let available = actor_means(state, actor_id);
    let mut required: IndexSet<String> = IndexSet::new();
    for value in arr(required_means) {
        let cleaned = clean_v(Some(value), 160);
        if !cleaned.is_empty() {
            required.insert(cleaned);
        }
    }
    let missing: Vec<&String> = required.iter().filter(|value| !means_keys(value).iter().any(|key| available.contains(key))).collect();
    json!({ "satisfied": missing.is_empty(), "required": required.iter().collect::<Vec<_>>(), "missing": missing })
}

/// `explainActionCheck({ ability, skill })`: причина проверки словами.
pub fn explain_action_check(check: &Value) -> String {
    let skill = match prop(Some(check), "skill") {
        None => String::new(),
        some => js::string(some),
    };
    let reason = match skill.replace('-', "_").as_str() {
        "athletics" => Some("Атлетика нужна, когда исход зависит от усилия: удержаться, взобраться или преодолеть сопротивление."),
        "acrobatics" => Some("Акробатика проверяет равновесие и точность движения, когда можно сорваться или потерять опору."),
        "sleight_of_hand" => Some("Ловкость рук нужна для точного обращения с предметом под риском или чужим наблюдением."),
        "stealth" => Some("Скрытность определяет, заметят ли героя. Отвлечение может помочь, но само по себе не делает героя незаметным."),
        "performance" => Some("Выступление подходит для отвлечения: нужно убедительно переключить чужое внимание. Осмотр или проход после этого будет отдельным шагом."),
        "persuasion" => Some("Убеждение нужно, когда вы добиваетесь добровольного согласия собеседника. Обычный вопрос сам по себе броска не требует."),
        "intimidation" => Some("Запугивание применяется к настоящей угрозе. Если вы не угрожаете, измените способ: мирное объяснение не должно проверяться как запугивание."),
        "deception" => Some("Обман проверяет, поверит ли собеседник сознательно ложному утверждению."),
        "perception" => Some("Восприятие помогает заметить доступную наблюдению деталь. Оно не выполняет отвлечение, открывание двери или перемещение."),
        "investigation" => Some("Расследование связывает доступные улики и проверяет выводы из них."),
        "insight" => Some("Проницательность помогает оценить поведение собеседника, но не читает его мысли и не раскрывает неизвестные герою факты."),
        "history" => Some("История позволяет вспомнить сведения, которые герой мог знать."),
        "arcana" => Some("Магия помогает разобраться в доступных магических признаках, но сама не создаёт заклинание."),
        "survival" => Some("Выживание помогает идти по следу и ориентироваться с учётом местности и погоды."),
        "animal_handling" => Some("Уход за животными нужен для взаимодействия с поведением зверя, а не для гарантированного подчинения."),
        _ => None,
    };
    if let Some(reason) = reason {
        return reason.to_string();
    }
    let ability = match prop(Some(check), "ability") {
        None => String::new(),
        some => js::string(some),
    };
    format!(
        "{} должна соответствовать способу действия. Для безопасного бытового жеста проверка не нужна; для риска сначала уточним препятствие и цену неудачи.",
        ability_label_ru(&ability).unwrap_or("Характеристика")
    )
}

// --- цена провала -------------------------------------------------------------------------

fn fail_forward(stake: &str) -> Value {
    match stake {
        "none" => json!({ "minutes": 5, "advances_quest_clock": false, "summary": "Попытка отняла немного времени и ничего не изменила в обстановке." }),
        "serious" => json!({ "minutes": 20, "advances_quest_clock": true, "summary": "Неудача дорого обошлась: положение осложнилось, и события пошли своим ходом." }),
        "deadly" => json!({ "minutes": 30, "advances_quest_clock": true, "escalates": true, "summary": "Риск оправдался худшим образом: опасность стала явной и близкой." }),
        _ => json!({ "minutes": 10, "advances_quest_clock": false, "summary": "Попытка сорвалась и наделала шума: место перестало быть спокойным." }),
    }
}

fn consequence_summary(kind: &str) -> &'static str {
    match kind {
        "noise" => "Попытка выдала героя шумом и привлекла нежелательное внимание.",
        "exposure" => "Герой раскрыл своё положение и потерял безопасную возможность.",
        "lost_opportunity" => "Собеседник или обстоятельства больше не дают прежней возможности.",
        _ => "Попытка отняла время, а ситуация успела измениться.",
    }
}

/// `failForwardFor(risk, consequenceType)`: провал не означает «ничего не
/// произошло» (таблица для старых согласованных проверок).
pub fn fail_forward_for(risk: Option<&Value>, consequence_type: Option<&Value>) -> Value {
    let stake = in_enum(&RISK_LEVELS, risk, "minor");
    let kind = if is_str(consequence_type, "injury") { "time".to_string() } else { in_enum(&FREE_ACTION_CONSEQUENCE_TYPES, consequence_type, "time") };
    let profile = fail_forward(&stake);
    let mut result = Map::new();
    result.insert("risk".into(), json!(stake));
    result.insert("consequence_type".into(), json!(kind));
    if let Value::Object(entries) = &profile {
        for (key, value) in entries {
            result.insert(key.clone(), value.clone());
        }
    }
    result.insert("summary".into(), json!(format!("{} {}", consequence_summary(&kind), js::s(profile.get("summary")))));
    Value::Object(result)
}

fn attempt_minutes(duration: &str) -> i64 {
    match duration {
        "instant" => 0,
        "brief" => 1,
        "extended" => 10,
        "prolonged" => 60,
        _ => 5,
    }
}

fn injury_expression(risk: &str) -> Option<&'static str> {
    match risk {
        "minor" => Some("1d4"),
        "serious" => Some("1d6"),
        "deadly" => Some("2d6"),
        _ => None,
    }
}

/// `damageTypeLabelRu(value)`: тип урона в родительном падеже.
pub fn damage_type_label_ru(value: Option<&Value>) -> &'static str {
    match text::lower(&js::s(value)).as_str() {
        "bludgeoning" => "дробящего",
        "fire" => "огненного",
        "acid" => "кислотного",
        "piercing" => "колющего",
        "slashing" => "рубящего",
        "cold" => "холодом",
        "lightning" => "электрического",
        "thunder" => "громового",
        "poison" => "ядовитого",
        "force" => "силового",
        "necrotic" => "некротического",
        "radiant" => "сияющего",
        "psychic" => "психического",
        _ => "неуточнённого",
    }
}

fn causal_failure_summary(kind: &str) -> Option<&'static str> {
    match kind {
        "time" => Some("Не выйдет — только время потратите."),
        "noise" => Some("Не выйдет, и поднимется шум."),
        "exposure" => Some("Не выйдет, и это заметят."),
        "lost_opportunity" => Some("Не выйдет, и второй раз этот способ уже не сработает."),
        _ => None,
    }
}

const DISCOVERY_STYLE_SKILLS: [&str; 9] = ["investigation", "perception", "insight", "history", "arcana", "nature", "religion", "survival", "medicine"];

// --- проход внутрь ---------------------------------------------------------------------------

static PASSAGE_GOAL_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    let forms = [
        "войти|войду|войдём|войдем|вхожу|входим|входит|входят",
        "зайти|зайду|зайдём|зайдем|захожу|заходим|заходит|заходят",
        "проникнуть|проникну|проникнем|проникаю|проникаем|проникает",
        "пробраться|проберусь|проберёмся|проберемся|пробираюсь|пробираемся|пробирается",
        "перебраться|переберусь|переберёмся|переберемся|перебираюсь|перебираемся",
        "перелезть|перелезу|перелезем|перелезаю|перелезаем",
        "забраться|заберусь|заберёмся|заберемся|забираюсь|забираемся",
        "взобраться|взберусь|взберёмся|взберемся|взбираюсь|взбираемся",
        "выбраться|выберусь|выберемся|выбираюсь|выбираемся",
        "вылезти|вылезу|вылезем|вылезаю|вылезаем",
        "выйти|выйду|выйдем|выхожу|выходим",
        "спуститься|спущусь|спустимся|спускаюсь|спускаемся",
        "подняться|поднимусь|поднимемся|поднимаюсь|поднимаемся",
        "добраться|доберусь|доберёмся|доберемся|добираюсь|добираемся",
        "дойти|дойду|дойдём|дойдем",
        "подойти|подойду|подойдём|подойдем|подхожу|подходим",
        "приблизиться|приближусь|приблизимся|приближаюсь|приближаемся",
        "переправиться|переправлюсь|переправимся|переправляюсь|переправляемся",
        "переплыть|переплыву|переплывём|переплывем|переплываю|переплываем",
        r"протис\p{L}*",
        "проскользнуть|проскользну|проскальзываю|проскальзываем",
        "прорваться|прорвусь|прорвёмся|прорвемся|прорываюсь|прорываемся",
        "уйти|уйду|уйдём|уйдем|ухожу|уходим",
        "покинуть|покину|покинем|покидаю|покидаем",
        "вернуться|вернусь|вернёмся|вернемся|возвращаюсь|возвращаемся",
        "отправиться|отправлюсь|отправимся|отправляюсь|отправляемся",
        r"(?:пройти|пройду|пройдём|пройдем|прохожу|проходим)(?=\s+(?:внутрь|наружу|наверх|вниз|дальше|через|мимо|сквозь|в|во|на|к|ко|по|за|под|до)(?![\p{L}\p{M}]))",
        // «Попасть в гоблина» — это удар, поэтому после «в/на» нужен знакомый вид места.
        r"(?:попасть|попаду|попадём|попадем|попадаю|попадаем)(?=\s+(?:внутрь|наружу|наверх|вниз|(?:в|во|на)\s+(?:\p{L}+\s+)?(?:башн|дом|здани|зал|комнат|подвал|погреб|склеп|пещер|храм|крепост|замок|замк|маяк|город|лагер|двор|сад|подземел|туннел|тоннел|грот|шахт|чердак|этаж|крыш|трюм|палуб|деревн|порт|гаван)))",
    ];
    text::js_regex(&format!(r"(?<![\p{{L}}\p{{M}}])(?:{})(?![\p{{L}}\p{{M}}])", forms.join("|")), "iu").expect("PASSAGE_GOAL_PATTERN")
});

/// `freeActionGoalIsPassage(goal)`: цель свободного действия — перемещение.
pub fn free_action_goal_is_passage(goal: &str) -> bool {
    text::test(&PASSAGE_GOAL_PATTERN, &clean(goal, 500))
}

const ENTRY_VERB: &str = r"(?:войд\p{L}*|войти|вош(?:ёл|ел|ла|ли)|вхож\p{L}*|вход(?:я|ит|им|ят|ить)|захож\p{L}*|заход(?:я|ит|им|ят|ить)|зайд\p{L}*|зайти|проник\p{L}*|протис\p{L}*|протолк\p{L}*|пробир\p{L}*|проскальз\p{L}*)";

static INWARD_PASSAGE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    text::js_regex(&format!(r"(?<![\p{{L}}\p{{M}}]){ENTRY_VERB}(?![\p{{L}}\p{{M}}])[^.!?]{{0,100}}(?:внутр\p{{L}}*|(?<![\p{{L}}\p{{M}}])(?:в|во)\s+(?:монастыр\p{{L}}*|здани\p{{L}}*|храм\p{{L}}*|башн\p{{L}}*|крепост\p{{L}}*|замк\p{{L}}*|дом\p{{L}}*|маяк\p{{L}}*))(?![\p{{L}}\p{{M}}])"), "iu").expect("INWARD_PASSAGE_PATTERN")
});
static ENTRY_VERB_PATTERN: LazyLock<Regex> = LazyLock::new(|| text::js_regex(&format!(r"(?<![\p{{L}}\p{{M}}]){ENTRY_VERB}(?![\p{{L}}\p{{M}}])"), "iu").expect("ENTRY_VERB"));

fn door_push_entry() -> &'static Regex {
    re!(r"(?<![\p{L}\p{M}])двер\p{L}*[^.!?]{0,80}(?<![\p{L}\p{M}])(?:входя|входит|входим|входят|вхожу|войти|войдя|вошёл|вошел|вошла|вошли|захожу|заходя|заходит|заходим|заходят|зайти|зайдя|войду|войдёт|войдет|войдем|войдём)(?![\p{L}\p{M}])", "iu")
}

const PASSAGE_MAX_STEPS: usize = 6;
const BUILDING_DESTINATION_STEMS: [&str; 8] = ["монастыр", "здани", "храм", "башн", "крепост", "замк", "дом", "маяк"];

fn passage_alternate_route() -> &'static Regex {
    re!(r"(?:через|сквозь)\s+(?:окн\p{L}*|щел\p{L}*|стен\p{L}*|пролом\p{L}*|про[её]м\p{L}*|люк\p{L}*|реш[её]тк\p{L}*|ворот\p{L}*)", "iu")
}

fn map_zone<'a>(map: &'a TacticalMap, cell: &TacticalCell<'_>) -> Option<&'a str> {
    let zone = map.zones.iter().find(|candidate| candidate.id == cell.zone)?;
    (zone.kind == "interior" || zone.kind == "exterior").then_some(zone.kind.as_str())
}

fn exterior_approach_cells(map: &TacticalMap) -> HashSet<(i64, i64)> {
    let mut reached = HashSet::new();
    let mut queue = Vec::new();
    for y in 0..map.height {
        for x in 0..map.width {
            let Some(cell) = cell_at(map, x, y) else { continue };
            if !cell.passable || map_zone(map, &cell) != Some("exterior") {
                continue;
            }
            reached.insert((x, y));
            queue.push((x, y));
        }
    }
    let mut index = 0;
    while index < queue.len() {
        let (cx, cy) = queue[index];
        index += 1;
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            let next = (cx + dx, cy + dy);
            if reached.contains(&next) {
                continue;
            }
            if !cell_at(map, next.0, next.1).is_some_and(|cell| cell.passable) {
                continue;
            }
            let edge = edge_between(map, cx, cy, next.0, next.1).ok().flatten();
            if edge.is_some_and(|edge| edge.kind == EdgeKind::Door || edge.blocks_move) {
                continue;
            }
            reached.insert(next);
            queue.push(next);
        }
    }
    reached
}

fn int_key(x: f64, y: f64) -> Option<(i64, i64)> {
    (x.fract() == 0.0 && y.fract() == 0.0 && x.is_finite() && y.is_finite()).then_some((x as i64, y as i64))
}

fn outside_has(outside: &HashSet<(i64, i64)>, x: f64, y: f64) -> bool {
    int_key(x, y).is_some_and(|key| outside.contains(&key))
}

fn path_crosses_inward_door(map: &TacticalMap, outside: &HashSet<(i64, i64)>, from: (f64, f64), path: &[GeoPoint]) -> String {
    let mut previous = from;
    for next in path {
        let edge = match (int_key(previous.0, previous.1), int_key(next.x, next.y)) {
            (Some(a), Some(b)) => edge_between(map, a.0, a.1, b.0, b.1).ok().flatten(),
            _ => None,
        };
        if let Some(edge) = edge {
            if edge.kind == EdgeKind::Door && outside_has(outside, previous.0, previous.1) && !outside_has(outside, next.x, next.y) {
                return edge.door_id.clone().unwrap_or_default();
            }
        }
        previous = (next.x, next.y);
    }
    String::new()
}

fn inward_passage_action(raw: &str) -> bool {
    // Слова героя в кавычках — не сам вход, но и не запрет на него.
    let value = text::replace_all(re!(r#"[«"“„][^«»"“”„]*[»"”]"#, "gu"), raw, " ");
    if text::test(re!(r#"[«»"“”„?]"#, "u"), &value) {
        return false;
    }
    if !text::test(&INWARD_PASSAGE_PATTERN, &value) && !text::test(door_push_entry(), &value) {
        return false;
    }
    if text::test(re!(r"(?:можно\s+ли|могу\s+ли|если|что\s+если)", "iu"), &value) {
        return false;
    }
    let verb_at = ENTRY_VERB_PATTERN.find(&value).ok().flatten().map_or(0, |found| found.start());
    !text::test(re!(r"(?<![\p{L}\p{M}])не\s+", "iu"), &value[..verb_at])
}

const DOOR_ENTRY_MAX_STEPS: usize = 40;

fn door_sides(door: &sk_tactical::tactical_map::TacticalDoor) -> [(i64, i64); 2] {
    let first = (door.x, door.y);
    let second = if door.dir == EdgeDir::E { (door.x + 1, door.y) } else { (door.x, door.y + 1) };
    [first, second]
}

fn closed_door_entry(state: &Value, actor_id: &str, map: &TacticalMap, outside: &HashSet<(i64, i64)>) -> Option<Value> {
    let from = actor_position(Some(state), actor_id).map(|point| (point.x, point.y));
    // Клетка у двери, где уже стоит другой, — не подход.
    let occupied: HashSet<(i64, i64)> = players(state)
        .iter()
        .chain(arr(prop(Some(state), "enemies")))
        .chain(arr(prop(Some(state), "scene_npcs")))
        .filter(|actor| js::truthy(prop(Some(actor), "id")) && js::string(prop(Some(actor), "id")) != actor_id && !js::is_false(prop(Some(actor), "alive")))
        .filter_map(|actor| actor_position(Some(state), &js::string(prop(Some(actor), "id"))).map(|point| (point.x, point.y)))
        .collect();
    let mut options: Vec<(String, (i64, i64), (i64, i64), usize)> = Vec::new();
    for door in &map.doors {
        if door.state != "closed" || door.barricade().is_some() {
            continue;
        }
        let sides = door_sides(door);
        let cells: Vec<_> = sides.iter().map(|(x, y)| cell_at(map, *x, *y)).collect();
        if cells.iter().any(|cell| !cell.as_ref().is_some_and(|cell| cell.passable)) {
            continue;
        }
        let out = (0..2).find(|index| outside.contains(&sides[*index]));
        let inside = (0..2).find(|index| !outside.contains(&sides[*index]));
        let (Some(out), Some(inside)) = (out, inside) else { continue };
        if !cells[out].as_ref().is_some_and(|cell| cell.revealed) {
            continue;
        }
        let (approach, inner) = (sides[out], sides[inside]);
        if occupied.contains(&approach) || occupied.contains(&inner) {
            continue;
        }
        let at_door = from == Some(approach);
        let path = if at_door { Some(Vec::new()) } else { path_to(state, actor_id, approach.0 as f64, approach.1 as f64) };
        let Some(path) = path else { continue };
        if !at_door && (path.is_empty() || path.len() > DOOR_ENTRY_MAX_STEPS) {
            continue;
        }
        if !path_revealed(map, &path) {
            continue;
        }
        options.push((door.id.clone(), approach, inner, path.len()));
    }
    options.sort_by(|left, right| left.3.cmp(&right.3).then_with(|| text::locale_compare(&left.0, &right.0)));
    let (door_id, approach, inner, steps) = options.into_iter().next()?;
    let mut plan = Map::new();
    plan.insert("status".into(), json!("ready"));
    plan.insert("door_id".into(), json!(door_id));
    plan.insert("open_door".into(), json!(true));
    plan.insert("approach".into(), json!({ "x": approach.0, "y": approach.1 }));
    if steps == 0 {
        plan.insert("at_door".into(), json!(true));
    }
    plan.insert("destination".into(), json!({ "to": { "x": inner.0, "y": inner.1 }, "path": [{ "x": inner.0, "y": inner.1 }] }));
    Some(Value::Object(plan))
}

fn passage_destination_matches_scene(state: &Value, action: &str) -> bool {
    let folded = fold(action);
    let mentioned: Vec<&str> = BUILDING_DESTINATION_STEMS.iter().copied().filter(|stem| folded.contains(stem)).collect();
    if mentioned.is_empty() {
        return true;
    }
    let scene = fold(&format!("{} {}", js::s(at(Some(state), &["scene", "location"])), js::s(at(Some(state), &["scene", "title"]))));
    mentioned.iter().any(|stem| scene.contains(stem))
}

/// `passageDestinationPlace(state, text)`: известное место карты мира, которое
/// называет постройка из заявки входа; пустая строка — такого нет или их несколько.
pub fn passage_destination_place(state: &Value, value: &str) -> String {
    let action = fold(&clean(value, 1_500));
    let mut stems: Vec<(&str, usize)> = BUILDING_DESTINATION_STEMS.iter().filter_map(|candidate| action.rfind(candidate).map(|index| (*candidate, index))).collect();
    stems.sort_by(|left, right| right.1.cmp(&left.1));
    let Some((stem, _)) = stems.first() else { return String::new() };
    let here = text::lower(&clean_v(at(Some(state), &["scene", "location"]), 160));
    let places: Vec<&Value> = arr(at(Some(state), &["worldMap", "locations"]))
        .iter()
        .filter(|location| !js::is_false(prop(Some(location), "known")) && !clean_v(prop(Some(location), "name"), 160).is_empty())
        .filter(|location| text::lower(&clean_v(prop(Some(location), "name"), 160)) != here)
        .filter(|location| fold(&clean_v(prop(Some(location), "name"), 160)).contains(stem))
        .collect();
    if places.len() == 1 { clean_v(places[0].get("name"), 80) } else { String::new() }
}

/// `freeActionPassageDestination(state, actorId, text)`: клетка входа, если
/// план готов.
pub fn free_action_passage_destination(state: &Value, actor_id: &str, value: &str) -> Option<Value> {
    let plan = free_action_passage_plan(state, actor_id, value);
    if is_str(plan.get("status"), "ready") { plan.get("destination").cloned() } else { None }
}

/// `freeActionPassagePlan(state, actorId, text)`: допустимость входа внутрь по
/// исходному тексту игрока.
pub fn free_action_passage_plan(state: &Value, actor_id: &str, value: &str) -> Value {
    let action = clean(value, 1_500);
    if !inward_passage_action(&action) {
        return json!({ "status": "not_applicable" });
    }
    if text::test(passage_alternate_route(), &action) {
        return json!({ "status": "blocked", "reason": "alternate_route" });
    }
    if !passage_destination_matches_scene(state, &action) {
        return json!({ "status": "blocked", "reason": "destination_mismatch" });
    }
    let unavailable = json!({ "status": "blocked", "reason": "map_unavailable" });
    let Some(from) = actor_position(Some(state), actor_id).map(|point| (point.x, point.y)) else { return unavailable };
    if !scene_map_truthy(state) {
        return unavailable;
    }
    let Some(map) = deserialize_scene_map(state) else { return unavailable };
    let outside = exterior_approach_cells(&map);
    if cell_at(&map, from.0, from.1).is_none() || !outside.contains(&from) {
        return json!({ "status": "already_inside" });
    }
    let mut doors: Vec<_> = map.doors.iter().collect();
    doors.sort_by(|left, right| left.y.cmp(&right.y).then(left.x.cmp(&right.x)).then_with(|| text::locale_compare(&left.id, &right.id)));
    let mut candidates: Vec<(String, (i64, i64), Vec<GeoPoint>)> = Vec::new();
    for door in doors {
        let sides = door_sides(door);
        let cells: Vec<_> = sides.iter().map(|(x, y)| cell_at(&map, *x, *y)).collect();
        let entry = (0..2).find(|index| {
            cells[*index].as_ref().is_some_and(|cell| cell.revealed && cell.passable)
                && !outside.contains(&sides[*index])
                && (0..2).any(|other| cells[other].as_ref().is_some_and(|cell| cell.passable) && outside.contains(&sides[other]))
        });
        let Some(entry) = entry else { continue };
        let to = sides[entry];
        let Some(path) = path_to(state, actor_id, to.0 as f64, to.1 as f64) else { continue };
        if path.is_empty() || path.len() > PASSAGE_MAX_STEPS || !path_revealed(&map, &path) {
            continue;
        }
        if path_crosses_inward_door(&map, &outside, (from.0 as f64, from.1 as f64), &path) != door.id {
            continue;
        }
        candidates.push((door.id.clone(), to, path));
    }
    candidates.sort_by(|left, right| left.2.len().cmp(&right.2.len()).then(left.1 .1.cmp(&right.1 .1)).then(left.1 .0.cmp(&right.1 .0)).then_with(|| text::locale_compare(&left.0, &right.0)));
    let Some(first) = candidates.first() else {
        // Открытого прохода нет, но есть закрытая (не запертая) дверь внутрь.
        return closed_door_entry(state, actor_id, &map, &outside).unwrap_or_else(|| json!({ "status": "blocked", "reason": "no_open_path" }));
    };
    let shortest = first.2.len();
    let tied: Vec<&String> = candidates.iter().filter(|candidate| candidate.2.len() == shortest).map(|candidate| &candidate.0).collect();
    if tied.len() > 1 {
        return json!({ "status": "ambiguous", "door_ids": tied });
    }
    json!({ "status": "ready", "door_id": first.0, "destination": { "to": { "x": first.1 .0, "y": first.1 .1 }, "path": path_json(&first.2) } })
}

fn copy_request() -> &'static Regex {
    re!(r"(?<![\p{L}\p{M}])(?:(?:с|пере)?копир\p{L}*|копи(?:ю|я|и|ей|ям|ями|ях)|перепис(?:ать|ал|ала|али|ываю|ываем|ывает|ывать)|перепиш(?:у|ем|ет)|(?:за|с|пере)рисов(?:ать|ал|ала|али|ываю|ываем|ывает|ывать)|(?:за|с|пере)рису(?:ю|ем|ет))(?![\p{L}\p{M}])", "iu")
}

/// `freeActionIsCopyRequest(text)`: заявка просит снять копию, переписать или зарисовать.
pub fn free_action_is_copy_request(value: &str) -> bool {
    text::test(copy_request(), &clean(value, 2_000))
}

/// `freeActionSuccessPromise(reading, { passageAvailable })`: что обещает успех вне боя.
pub fn free_action_success_promise(reading: &Value, passage_available: bool) -> String {
    let goal = text::replace_first(re!(r"[.!?…]+$", "u"), &clean_v(prop(Some(reading), "goal_summary"), 160), "");
    let lowered = {
        let mut chars = goal.chars();
        match chars.next() {
            Some(first) => format!("{}{}", text::lower(&first.to_string()), chars.as_str()),
            None => String::new(),
        }
    };
    let skill = js::s(prop(Some(reading), "skill")).replace('-', "_");
    if is_str(prop(Some(reading), "activity_kind"), "knowledge") || DISCOVERY_STYLE_SKILLS.contains(&skill.as_str()) {
        return "Выйдет — герой заметит или вспомнит то, что здесь можно узнать.".into();
    }
    if free_action_goal_is_passage(&goal) {
        return if passage_available {
            "Выйдет — герой протиснется внутрь по ближайшему открытому проходу.".into()
        } else {
            "Выйдет — станет ясно, как пройти, но без подтверждённого открытого прохода герой не переместится: сначала откройте дверь или выберите путь на карте.".into()
        };
    }
    if lowered.is_empty() { "Выйдет — задуманное получится.".into() } else { format!("Выйдет — {lowered}.") }
}

/// `minutesLabelRu(value)`: «1 минута», «2 минуты», «5 минут».
pub fn minutes_label_ru(value: Option<&Value>) -> String {
    let number = js::number(value);
    let count = if number.is_nan() || number == 0.0 { 0.0 } else { number.trunc().abs() };
    let last_two = count % 100.0;
    let last = count % 10.0;
    let word = if (11.0..=14.0).contains(&last_two) {
        "минут"
    } else if last == 1.0 {
        "минута"
    } else if (2.0..=4.0).contains(&last) {
        "минуты"
    } else {
        "минут"
    };
    format!("{} {word}", js::f64_string(count))
}

/// `freeActionResolutionPolicy(reading)`: версионированная серверная цена
/// одной попытки, общая для предпросмотра и фиксации.
pub fn free_action_resolution_policy(reading: &Value) -> Value {
    let field = |key: &str| prop(Some(reading), key);
    if !policy_known(field("policy_version")) {
        return json!({
            "version": "legacy", "success_minutes": 5, "cost": "5 минут при успехе",
            "failure": fail_forward_for(field("risk"), field("consequence_type")),
        });
    }
    let duration = if is_str(field("activity_kind"), "stunt") { "instant".to_string() } else { in_enum(&FREE_ACTION_DURATION_CLASSES, field("duration_class"), "minutes") };
    let minutes = attempt_minutes(&duration);
    let skill = js::s(field("skill"));
    let physical = is_str(field("activity_kind"), "stunt") && field("skill").is_some_and(Value::is_string) && (skill == "acrobatics" || skill == "athletics");
    let raw_hazard = if is_str(field("policy_version"), LEGACY_RESOLUTION_POLICY_VERSION) { String::new() } else { clean_v(field("hazard"), 80) };
    let hazard_id = canonical_hazard_str(&raw_hazard);
    let hazard = if hazard_id.is_empty() { None } else { environment_hazard(&hazard_id) };
    let invalid_hazard = !raw_hazard.is_empty() && hazard_id.is_empty();
    let risk = in_enum(&RISK_LEVELS, field("risk"), "minor");
    let expression: Option<Value> = if is_str(field("consequence_type"), "injury") && !invalid_hazard && (physical || hazard.is_some()) {
        let expressions = hazard.and_then(|hazard| hazard.get("expressions"));
        nullish(prop(expressions, &risk), prop(expressions, "minor")).cloned().or_else(|| injury_expression(&risk).map(|expression| json!(expression)))
    } else {
        None
    };
    let expression = expression.filter(|value| js::truthy(Some(value)));
    let damage_type = hazard.and_then(|hazard| nullish(hazard.get("damage_type"), None)).cloned().unwrap_or_else(|| json!("bludgeoning"));
    let kind = if expression.is_some() {
        "injury".to_string()
    } else if is_str(field("consequence_type"), "injury") {
        "time".to_string()
    } else {
        in_enum(&FREE_ACTION_CONSEQUENCE_TYPES, field("consequence_type"), "time")
    };
    let mut failure = Map::new();
    if let Some(risk) = field("risk") {
        failure.insert("risk".into(), risk.clone());
    }
    failure.insert("consequence_type".into(), json!(kind));
    failure.insert("minutes".into(), json!(minutes));
    failure.insert("advances_quest_clock".into(), json!(false));
    if let Some(expression) = &expression {
        failure.insert("damage_expression".into(), expression.clone());
        failure.insert("damage_type".into(), damage_type.clone());
    }
    let summary = match &expression {
        Some(expression) => json!(format!("Не выйдет — герой пострадает: {} {} урона.", js::string(Some(expression)), damage_type_label_ru(Some(&damage_type)))),
        None => causal_failure_summary(&kind).map_or(Value::Null, |summary| json!(summary)),
    };
    if !summary.is_null() {
        failure.insert("summary".into(), summary);
    }
    let mut policy = Map::new();
    if let Some(version) = field("policy_version") {
        policy.insert("version".into(), version.clone());
    }
    policy.insert("success_minutes".into(), json!(minutes));
    policy.insert("cost".into(), json!(if minutes != 0 { format!("займёт {}", minutes_label_ru(Some(&json!(minutes)))) } else { "несколько секунд".into() }));
    policy.insert("failure".into(), Value::Object(failure));
    Value::Object(policy)
}

/// `stakesFor({ ability, skill, resolution, risk, proficiency, consequence_type, outcome_policy })`:
/// ставки объявляются до броска; без проверки — `None`.
pub fn stakes_for(input: &Value) -> Option<Value> {
    let field = |key: &str| prop(Some(input), key);
    let resolution = field("resolution");
    if !is_str(prop(resolution, "mode"), "check") {
        return None;
    }
    let consequence = match nullish(prop(field("outcome_policy"), "failure"), None) {
        Some(failure) => failure.clone(),
        None => fail_forward_for(field("risk"), field("consequence_type")),
    };
    let mut factors: IndexSet<String> = IndexSet::new();
    for factor in arr(prop(resolution, "difficulty_factors")) {
        let cleaned = clean_v(Some(factor), 60);
        if !cleaned.is_empty() {
            factors.insert(cleaned);
        }
    }
    let mut stakes = Map::new();
    stakes.insert("ability".into(), json!(clean_v(field("ability"), 20)));
    stakes.insert("skill".into(), json!(canonical_skill(field("skill"))));
    stakes.insert("proficiency".into(), json!(in_enum(&FREE_ACTION_PROFICIENCY_LEVELS, field("proficiency"), "none")));
    for key in ["difficulty", "difficulty_category"] {
        if let Some(value) = prop(resolution, key) {
            stakes.insert(key.into(), value.clone());
        }
    }
    stakes.insert("difficulty_factors".into(), js::strings_value(factors.into_iter().take(8)));
    for (target, source) in [("consequence_type", "consequence_type"), ("on_failure", "summary")] {
        if let Some(value) = consequence.get(source) {
            stakes.insert(target.into(), value.clone());
        }
    }
    let version = prop(field("outcome_policy"), "version");
    stakes.insert("policy".into(), json!(if policy_known(version) { "free-action-stakes-v3" } else { "free-action-stakes-v2" }));
    Some(Value::Object(stakes))
}

// Русские подписи d20-проверок для карточки броска и журнала.

/// `ABILITY_LABELS_RU` (порядок ключей — как в JS).
pub const ABILITY_LABELS_RU: [(&str, &str); 6] = [
    ("str", "Сила"),
    ("dex", "Ловкость"),
    ("con", "Телосложение"),
    ("int", "Интеллект"),
    ("wis", "Мудрость"),
    ("cha", "Харизма"),
];

/// `SKILL_LABELS_RU` (порядок ключей — как в JS).
pub const SKILL_LABELS_RU: [(&str, &str); 18] = [
    ("acrobatics", "Акробатика"),
    ("animal-handling", "Уход за животными"),
    ("arcana", "Магия"),
    ("athletics", "Атлетика"),
    ("deception", "Обман"),
    ("history", "История"),
    ("insight", "Проницательность"),
    ("intimidation", "Запугивание"),
    ("investigation", "Расследование"),
    ("medicine", "Медицина"),
    ("nature", "Природа"),
    ("perception", "Восприятие"),
    ("performance", "Выступление"),
    ("persuasion", "Убеждение"),
    ("religion", "Религия"),
    ("sleight-of-hand", "Ловкость рук"),
    ("stealth", "Скрытность"),
    ("survival", "Выживание"),
];

/// `ABILITY_LABELS_RU[key]` — поиск по ключу таблицы.
pub fn ability_label_ru(key: &str) -> Option<&'static str> {
    ABILITY_LABELS_RU.iter().find(|(id, _)| *id == key).map(|(_, label)| *label)
}

/// `SKILL_LABELS_RU[key]` — поиск по ключу таблицы.
pub fn skill_label_ru(key: &str) -> Option<&'static str> {
    SKILL_LABELS_RU.iter().find(|(id, _)| *id == key).map(|(_, label)| *label)
}

/// `d20CheckLabel({ kind, ability, skill })`: подпись d20-проверки.
pub fn d20_check_label(input: &Value) -> String {
    let field = |key: &str| prop(Some(input), key);
    let kind = match field("kind") {
        None => "check".to_string(),
        some => js::string(some),
    };
    let ability = ability_label_ru(&text::lower(&js::s(field("ability"))));
    if kind == "save" {
        return ability.map_or_else(|| "Спасбросок".to_string(), |name| format!("Спасбросок: {name}"));
    }
    let skill = skill_label_ru(&text::lower(&js::s(field("skill"))).replace('_', "-"));
    match (skill, ability) {
        (Some(skill), Some(ability)) => format!("{ability} ({skill})"),
        (Some(skill), None) => skill.to_string(),
        (None, Some(ability)) => format!("Проверка: {ability}"),
        (None, None) => "Проверка".into(),
    }
}

/// `attemptFingerprint({ actorId, approach, obstacle })`: отпечаток попытки.
pub fn attempt_fingerprint(actor_id: &str, approach: &str, obstacle: &str) -> String {
    digest(&json!({
        "actor": clean(actor_id, 120),
        "approach": text::lower(&clean(approach, 300)),
        "obstacle": text::lower(&clean(obstacle, 300)),
    }))
}

fn number_or_zero(value: Option<&Value>) -> Value {
    let number = js::number(value);
    js::num(if number.is_nan() { 0.0 } else { number })
}

/// `situationFingerprint(state)`: отпечаток обстановки.
pub fn situation_fingerprint(state: &Value) -> String {
    let revealed = arr(at(Some(state), &["scene", "cells"])).iter().filter(|cell| js::is_true(prop(Some(cell), "revealed"))).count();
    digest(&json!({
        "location": clean_v(at(Some(state), &["scene", "location"]), 180),
        "objective": clean_v(at(Some(state), &["scene", "objective"]), 300),
        "revealed": revealed,
        "combat": combat_active(state),
        "round": number_or_zero(at(Some(state), &["mechanics", "combat", "round"])),
        "elapsed": number_or_zero(at(Some(state), &["mechanics", "world_time", "elapsed_minutes"])),
    }))
}

/// `previousFailedAttempt(state, fingerprint)`: уже проваленная попытка с тем
/// же подходом в неизменившейся обстановке.
pub fn previous_failed_attempt(state: &Value, fingerprint: &str) -> Option<Value> {
    let situation = situation_fingerprint(state);
    arr(prop(Some(state), "rulings"))
        .iter()
        .find(|ruling| {
            let provenance = prop(Some(ruling), "provenance");
            is_str(prop(provenance, "attempt_fingerprint"), fingerprint) && is_str(prop(provenance, "situation_fingerprint"), &situation) && is_str(prop(Some(ruling), "outcome"), "failure")
        })
        .cloned()
}

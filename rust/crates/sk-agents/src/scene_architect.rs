//! Перенос `server/scene-architect.mjs`: Архитектор сцены — новая область
//! после подтверждённого ухода отряда (`prompts/map_architect/v8.txt`).
//!
//! Сервер сначала строит канонический запасной план ([`fallback_plan`]):
//! куда ведёт карта мира, вид места, цель, заготовка карты (`map.design` с
//! якорями `landmarks`). Модель дополняет его творческими полями, а
//! [`normalize_plan`] оставляет из ответа только допустимое (в том числе
//! заготовки ведущего `secrets` без хранителя). Известная точка карты мира —
//! инвариант сервера: модель, подменившая её, теряет весь творческий план.
//!
//! Клиент модели внедряется ([`RoleClient`]).

use std::cmp::Ordering;

use serde_json::{json, Map, Value};
use sk_core::{js, re, text};

use crate::director_agent::RoleClient;

/// `SCENE_ARCHITECT_AGENT_ID`.
pub const SCENE_ARCHITECT_AGENT_ID: &str = "scene_architect";
/// `LEGACY_SCENE_ARCHITECT_AGENT_ID`: имя роли в сохранённых трассах.
pub const LEGACY_SCENE_ARCHITECT_AGENT_ID: &str = "AgentCartographer";

const PROMPT: &str = include_str!("../../../../prompts/map_architect/v8.txt");

const MAP_SCALES: [&str; 4] = ["room", "site", "stronghold", "region"];
const MAP_PATTERNS: [&str; 9] = ["small-room", "great-hall", "keep", "courtyard", "crypt", "cave-cluster", "village", "bridge", "natural"];
const MAP_MATERIALS: [&str; 8] = ["stone", "wood", "earth", "grass", "sand", "metal", "marble", "ice"];
const LAYOUTS: [&str; 7] = ["rooms", "streets", "open", "winding", "cavern", "ruins", "radial"];
const DANGERS: [&str; 3] = ["низкая", "средняя", "высокая"];
const SETTLEMENT_KINDS: [&str; 5] = ["capital", "city", "town", "village", "port"];
const BUILDING_SCENE_THEMES: [&str; 5] = ["tavern", "inn", "building", "temple", "shop"];

// ---------------------------------------------------------------------------
// Приведения JS
// ---------------------------------------------------------------------------

fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value?.as_object()?.get(key)
}

fn path<'a>(value: Option<&'a Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().try_fold(value?, |current, key| get(Some(current), key))
}

fn array(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

fn coalesce<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    match first {
        Some(value) if !value.is_null() => Some(value),
        _ => second,
    }
}

fn or<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    if js::truthy(first) {
        first
    } else {
        second
    }
}

fn is_str(value: Option<&Value>, expected: &str) -> bool {
    matches!(value, Some(Value::String(text)) if text == expected)
}

fn one_of(value: Option<&Value>, allowed: &[&str]) -> Option<String> {
    match value {
        Some(Value::String(text)) if allowed.contains(&text.as_str()) => Some(text.clone()),
        _ => None,
    }
}

fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (None, None) | (Some(Value::Null), Some(Value::Null)) => true,
        _ => false,
    }
}

fn head_utf16(source: &str, max: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for ch in source.chars() {
        let width = ch.len_utf16();
        if units + width > max {
            break;
        }
        units += width;
        out.push(ch);
    }
    out
}

fn len16(source: &str) -> usize {
    source.encode_utf16().count()
}

/// `String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maximum)`.
fn clean(value: Option<&Value>, maximum: usize) -> String {
    clean_str(&js::s(value), maximum)
}

fn clean_str(value: &str, maximum: usize) -> String {
    head_utf16(&text::squash_spaces(value), maximum)
}

fn string_value(text: &str) -> Value {
    Value::String(text.to_string())
}

/// `clean(value, 120).normalize('NFKC').toLocaleLowerCase('ru')`.
fn location_key(value: Option<&Value>) -> String {
    text::lower(&text::nfkc(&clean(value, 120)))
}

fn location_key_str(value: &str) -> String {
    location_key(Some(&string_value(value)))
}

fn test(regex: &sk_core::fancy_regex::Regex, value: &str) -> bool {
    text::test(regex, value)
}

/// Обрезка по границе слова с многоточием.
fn clip_words(value: &str, maximum: usize) -> String {
    let text_value = text::squash_spaces(value);
    if len16(&text_value) <= maximum {
        return text_value;
    }
    let cut = head_utf16(&text_value, maximum.saturating_sub(1));
    let units: Vec<u16> = cut.encode_utf16().collect();
    let space = units.iter().rposition(|unit| *unit == u16::from(b' '));
    let kept = match space {
        Some(index) if index as f64 > maximum as f64 / 2.0 => String::from_utf16_lossy(&units[..index]),
        _ => cut,
    };
    format!("{}…", text::replace_first(re!(r"[\s,;:—-]+$", "u"), &kept, ""))
}

/// `Number.isSafeInteger(Number(value)) ? clamp : fallback`.
fn clamp_integer(value: Option<&Value>, fallback: f64, minimum: f64, maximum: f64) -> Value {
    if js::is_safe_integer_number(value) {
        js::num(js::number(value).clamp(minimum, maximum))
    } else {
        js::num(fallback)
    }
}

/// `value == null || !Number.isFinite(Number(value)) ? fallback : clamp`.
fn clamp_decimal(value: Option<&Value>, fallback: Option<&Value>, minimum: f64, maximum: f64) -> Value {
    let number = js::number(value);
    if !js::present(value) || !number.is_finite() {
        fallback.cloned().unwrap_or(Value::Null)
    } else {
        js::num(number.clamp(minimum, maximum))
    }
}

struct Dimensions {
    width: f64,
    height: f64,
    minimum_width: f64,
    minimum_height: f64,
    maximum_width: f64,
    maximum_height: f64,
}

fn scale_dimensions(scale: &str) -> Dimensions {
    let (width, height, minimum_width, minimum_height, maximum_width, maximum_height) = match scale {
        "room" => (16.0, 12.0, 7.0, 7.0, 26.0, 26.0),
        "stronghold" => (36.0, 28.0, 19.0, 13.0, 48.0, 40.0),
        "region" => (40.0, 30.0, 21.0, 15.0, 48.0, 40.0),
        _ => (26.0, 18.0, 11.0, 9.0, 40.0, 32.0),
    };
    Dimensions { width, height, minimum_width, minimum_height, maximum_width, maximum_height }
}

// ---------------------------------------------------------------------------
// Бриф
// ---------------------------------------------------------------------------

/// `buildDirectorPlanningBrief(state)`: публичный контекст Архитектора —
/// только данные.
pub fn build_director_planning_brief(state: &Value) -> Value {
    let empty = json!({});
    let source = if state.is_object() { state } else { &empty };
    let scene = match get(Some(source), "scene") {
        Some(scene @ Value::Object(_)) => scene,
        _ => &empty,
    };
    let scene = Some(scene);
    let mut current = Map::new();
    current.insert("title".into(), Value::String(clean(get(scene, "title"), 80)));
    current.insert("location".into(), Value::String(clean(get(scene, "location"), 120)));
    current.insert("mood".into(), Value::String(clean(get(scene, "mood"), 160)));
    current.insert("objective".into(), Value::String(clean(get(scene, "objective"), 160)));
    current.insert("turn".into(), clamp_integer(get(scene, "turn"), 0.0, 0.0, 1_000_000.0));
    if let Some(Value::String(theme)) = get(scene, "theme") {
        current.insert("theme".into(), Value::String(clean_str(theme, 80)));
    }
    if let Some(danger) = one_of(get(scene, "danger"), &DANGERS) {
        current.insert("danger".into(), Value::String(danger));
    }
    if let Some(kind) = one_of(get(scene, "scene_kind"), &["settlement", "wilderness", "dungeon", "road", "other"]) {
        current.insert("scene_kind".into(), Value::String(kind));
    }
    if let Some(kind) = one_of(get(scene, "settlement_type"), &["village", "town", "city", "outpost", "traveling"]) {
        current.insert("settlement_type".into(), Value::String(kind));
    }
    let heroes: Vec<Value> = array(get(Some(source), "players"))
        .iter()
        .map(|hero| {
            let hero = Some(hero);
            json!({
                "id": clean(get(hero, "id"), 40),
                "name": clean(coalesce(get(hero, "character"), get(hero, "name")), 80),
                "role": clean(get(hero, "role"), 100),
                "species": clean(get(hero, "species"), 80),
                "background": clean(get(hero, "background"), 100),
                "backstory": clean(get(hero, "backstory"), 400),
                "traits": clean(get(hero, "traits"), 200),
            })
        })
        .take(12)
        .collect();
    let enemies: Vec<Value> = array(get(Some(source), "enemies"))
        .iter()
        .filter(|enemy| !js::is_false(get(Some(enemy), "alive")))
        .map(|enemy| {
            let enemy = Some(enemy);
            json!({ "id": clean(get(enemy, "id"), 40), "name": clean(get(enemy, "name"), 80), "kind": clean(coalesce(get(enemy, "kind"), get(enemy, "type")), 80) })
        })
        .take(16)
        .collect();
    let destinations: Vec<Value> = known_destinations_from(source)
        .iter()
        .map(|entry| {
            let entry = Some(entry);
            let mut result = Map::new();
            for key in ["name", "kind", "days", "danger", "visited"] {
                if let Some(value) = get(entry, key) {
                    result.insert(key.into(), value.clone());
                }
            }
            for (key, limit) in [("summary", 320), ("history", 500), ("biome", 40)] {
                if js::truthy(get(entry, key)) {
                    result.insert(key.into(), Value::String(clean(get(entry, key), limit)));
                }
            }
            Value::Object(result)
        })
        .collect();
    json!({
        "current_scene": Value::Object(current),
        "adventure_memory": Value::Object(sk_director::adventure_director::public_adventure_memory(get(Some(source), "adventure"))),
        "campaign_premise": sk_encounters::agent_context::campaign_concept_for_agent(source, None),
        "heroes": heroes,
        "visible_enemies": enemies,
        "known_destinations": destinations,
    })
}

fn selected_decision(action: &str, state: &Value) -> String {
    let interaction = get(Some(state), "agentInteraction");
    let option = match get(interaction, "options") {
        Some(Value::Array(options)) => options.iter().find(|candidate| strict_eq(get(Some(candidate), "id"), get(interaction, "resolvedOptionId"))),
        _ => None,
    };
    let label = get(option, "label");
    if js::truthy(label) {
        clean(label, 500)
    } else {
        clean_str(action, 500)
    }
}

/// `interpretResolvedPartyDecision(action, state)`: разбор подтверждённого
/// решения группы (`{ kind, decision, destinationHint?, abandonsQuest,
/// destinationLocationId? }`); `None` — это не решение группы.
pub fn interpret_resolved_party_decision(action: Option<&Value>, state: &Value) -> Option<Value> {
    let text_value = text::nfkc(&clean(action, 2000));
    if !test(re!(r"^\[РЕШЕНИЕ ГРУППЫ\]", "iu"), &text_value) {
        return None;
    }
    let decision = selected_decision(&text_value, state);
    let classified = sk_scenario::party_exit_intent::classify_party_decision(&decision);
    if classified.kind == "move" {
        let interaction = get(Some(state), "agentInteraction");
        let destination_location_id = clean(coalesce(get(interaction, "destinationLocationId"), get(interaction, "destination_location_id")), 120);
        let mut result = json!({ "kind": "move", "decision": decision, "destinationHint": classified.destination_hint, "abandonsQuest": classified.abandons_quest });
        if !destination_location_id.is_empty() {
            result["destinationLocationId"] = Value::String(destination_location_id);
        }
        return Some(result);
    }
    Some(json!({ "kind": classified.kind, "decision": decision, "abandonsQuest": classified.abandons_quest }))
}

// ---------------------------------------------------------------------------
// Вид места
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)] // строка таблицы JS: одиннадцать полей заявки картографа
fn theme(theme: &str, layout: &str, scale: &str, pattern: &str, material: &str, width: i64, height: i64, openness: f64, water: f64, feature_count: i64, danger: &str) -> Map<String, Value> {
    let value = json!({
        "theme": theme, "layout": layout, "scale": scale, "pattern": pattern, "material": material, "width": width, "height": height,
        "openness": js::num(openness), "water": js::num(water), "featureCount": feature_count, "danger": danger,
    });
    value.as_object().cloned().unwrap_or_default()
}

fn theme_for(destination: &str, action: &str) -> Map<String, Value> {
    let destination_value = text::lower(destination);
    let explicit = test(
        re!(r"крепост|замок|цитадел|дом|хижин|комнат|кабинет|зал|камор|спальн|таверн|город|деревн|порт|рынок|улиц|лес|чащ|болот|роща|мост|тракт|дорог|путь|перевал|руин|развал|храм|пещер|подзем|склеп|архив|шахт|арен|круг|кольц|башн|маяк", "u"),
        &destination_value,
    );
    let value = if explicit { destination_value } else { format!("{destination_value} {}", text::lower(action)) };
    let v = value.as_str();
    if test(re!(r"крепост|замок|цитадел", "u"), v) {
        return theme("крепость", "rooms", "stronghold", "keep", "stone", 36, 28, 0.62, 0.02, 10, "высокая");
    }
    if test(re!(r"дом|хижин|комнат|кабинет|небольш.*зал|камор|спальн|таверн", "u"), v) {
        let name = if test(re!(r"таверн", "u"), v) { "уютная таверна" } else { "жилой дом" };
        return theme(name, "rooms", "room", "small-room", "wood", 9, 7, 0.82, 0.0, 9, "низкая");
    }
    if test(re!(r"(?<!\p{L})маяк(?:а|у|ом|е|и|ов|ам|ами|ах)?(?!\p{L})", "u"), v) {
        if let Some(found) = theme_for_structure_name(v) {
            return found;
        }
    }
    if test(re!(r"город|деревн|порт|рынок|таверн|улиц", "u"), v) {
        let name = if test(re!(r"порт|гаван|пристан", "u"), v) { "портовые улицы" } else { "городские улицы" };
        let water = if test(re!(r"порт|канал|гаван|пристан", "u"), v) { 0.22 } else { 0.02 };
        return theme(name, "streets", "site", "village", "stone", 32, 24, 0.68, water, 8, "низкая");
    }
    if test(re!(r"лес|чащ|болот|роща", "u"), v) {
        let water = if test(re!(r"болот", "u"), v) { 0.22 } else { 0.06 };
        return theme("дикая местность", "winding", "site", "natural", "grass", 26, 18, 0.62, water, 10, "средняя");
    }
    if test(re!(r"мост", "u"), v) {
        return theme("мост и подступы", "winding", "site", "bridge", "wood", 28, 16, 0.7, 0.2, 5, "средняя");
    }
    if test(re!(r"тракт|дорог|путь|перевал", "u"), v) {
        return theme("дорога", "winding", "site", "natural", "earth", 26, 16, 0.58, 0.03, 5, "средняя");
    }
    if test(re!(r"руин|развал|храм", "u"), v) {
        let material = if test(re!(r"храм", "u"), v) { "marble" } else { "stone" };
        return theme("древние руины", "ruins", "site", "courtyard", material, 26, 18, 0.58, 0.05, 6, "средняя");
    }
    if test(re!(r"пещер|подзем|склеп|архив|шахт", "u"), v) {
        let name = if test(re!(r"склеп", "u"), v) { "древний склеп" } else { "подземные пещеры" };
        let pattern = if test(re!(r"склеп|архив", "u"), v) { "crypt" } else { "cave-cluster" };
        return theme(name, "cavern", "site", pattern, "earth", 26, 18, 0.62, 0.08, 10, "средняя");
    }
    if test(re!(r"арен|круг|кольц|башн", "u"), v) {
        return theme("радиальная локация", "radial", "site", "great-hall", "stone", 26, 26, 0.58, 0.02, 6, "средняя");
    }
    theme("новая местность", "open", "site", "natural", "earth", 26, 18, 0.64, 0.05, 5, "средняя")
}

fn theme_for_world_kind(kind: &str) -> Option<Map<String, Value>> {
    Some(match kind {
        "capital" | "city" => theme("городские улицы", "streets", "site", "village", "stone", 36, 28, 0.68, 0.02, 8, "низкая"),
        "port" => theme("портовые улицы", "streets", "site", "village", "stone", 36, 28, 0.68, 0.22, 8, "низкая"),
        "town" => theme("городские улицы", "streets", "site", "village", "stone", 30, 22, 0.68, 0.02, 8, "низкая"),
        "village" => theme("деревенские улицы", "streets", "site", "village", "stone", 24, 18, 0.68, 0.02, 7, "низкая"),
        "wilds" => theme("дикая местность", "winding", "site", "natural", "grass", 26, 18, 0.62, 0.06, 10, "средняя"),
        "fortress" => theme("крепость", "rooms", "stronghold", "keep", "stone", 36, 28, 0.62, 0.02, 10, "высокая"),
        "ruin" => theme("древние руины", "ruins", "site", "courtyard", "stone", 26, 18, 0.58, 0.05, 6, "средняя"),
        "dungeon" => theme("подземные пещеры", "cavern", "site", "cave-cluster", "earth", 26, 18, 0.62, 0.08, 10, "средняя"),
        _ => return None,
    })
}

/// Постройка, которую называет само имя места: «Старый маяк», «Храм Луны».
fn theme_for_structure_name(name: &str) -> Option<Map<String, Value>> {
    let value = text::lower(name);
    let v = value.as_str();
    if test(re!(r"(?<!\p{L})(?:маяк(?:а|у|ом|е|и|ов|ам|ами|ах)?(?!\p{L})|башн)", "u"), v) {
        let name = if test(re!(r"маяк", "u"), v) { "башня маяка" } else { "каменная башня" };
        return Some(theme(name, "rooms", "site", "great-hall", "stone", 24, 24, 0.6, 0.02, 7, "средняя"));
    }
    if test(re!(r"крепост|(?<!\p{L})зам(?:ок|ка|ке|ку|ком)(?!\p{L})|цитадел|твердын", "u"), v) {
        return Some(theme("каменная крепость", "rooms", "stronghold", "keep", "stone", 36, 28, 0.62, 0.02, 10, "высокая"));
    }
    if test(re!(r"храм|святилищ|монастыр|собор|часовн", "u"), v) {
        return Some(theme("храм", "rooms", "site", "great-hall", "stone", 26, 20, 0.6, 0.02, 8, "средняя"));
    }
    None
}

fn template(value: Option<&Value>) -> String {
    js::s(value)
}

fn theme_for_world_description(destination: Option<&Value>) -> Option<Map<String, Value>> {
    let destination = destination?;
    let destination = Some(destination);
    if let Some(found) = theme_for_structure_name(&template(get(destination, "name"))) {
        return Some(found);
    }
    let value = text::lower(&format!(
        "{} {} {} {}",
        template(get(destination, "name")),
        template(get(destination, "summary")),
        template(get(destination, "history")),
        template(get(destination, "biome"))
    ));
    let v = value.as_str();
    if test(re!(r"озер|водо[её]м|пруд|залив", "iu"), v) {
        return Some(theme("озеро и отмели", "open", "site", "natural", "grass", 32, 24, 0.55, 0.72, 8, "средняя"));
    }
    if test(re!(r"(?<!\p{L})рек(?:а|и|е|у|ой)(?!\p{L})|речн|слияни[ея]\s+рек|переправ", "iu"), v) {
        return Some(theme("берег реки", "winding", "site", "bridge", "earth", 32, 22, 0.62, 0.42, 7, "средняя"));
    }
    if test(re!(r"берег|отмел|пристан|гаван|побереж|причал|бухт", "iu"), v) {
        return Some(theme("морской берег", "open", "site", "natural", "sand", 32, 22, 0.6, 0.4, 7, "средняя"));
    }
    if test(re!(r"горн|кряж|пик|скал|перевал|ущел", "iu"), v) || is_str(get(destination, "biome"), "mountains") {
        return Some(theme("горный рубеж", "winding", "site", "bridge", "earth", 28, 22, 0.55, 0.02, 7, "высокая"));
    }
    if test(re!(r"лес|чащ|рощ|дубрав|пущ|wild", "iu"), v) || is_str(get(destination, "biome"), "forest") {
        return Some(theme("лесная окраина", "open", "site", "natural", "grass", 26, 18, 0.62, 0.04, 9, "средняя"));
    }
    if test(re!(r"крепост|замок|цитадел|твердын|fortress", "iu"), v) || is_str(get(destination, "kind"), "fortress") {
        return Some(theme("каменная крепость", "rooms", "stronghold", "keep", "stone", 36, 28, 0.62, 0.02, 10, "высокая"));
    }
    None
}

fn map_design_for(state: &Value, location: &str, theme_name: &Value, known_destination: Option<&Value>, known_kind: &str, requested_map: &Value) -> Value {
    let description: Vec<String> = [get(known_destination, "summary"), get(known_destination, "history")].into_iter().filter(|value| js::truthy(*value)).map(js::s).collect();
    let concept = get(Some(state), "campaignConcept");
    let world: Vec<String> = ["worldSummary", "premise", "setting", "description"]
        .into_iter()
        .filter_map(|key| match get(concept, key) {
            Some(Value::String(text)) => Some(text.clone()),
            _ => None,
        })
        .collect();
    let mut input = Map::new();
    input.insert("location".into(), string_value(location));
    input.insert("theme".into(), theme_name.clone());
    input.insert("description".into(), Value::String(description.join(" ")));
    input.insert("worldDescription".into(), Value::String(head_utf16(&world.join(" "), 2400)));
    input.insert("worldKind".into(), string_value(known_kind));
    input.insert("settlementType".into(), string_value(if SETTLEMENT_KINDS.contains(&known_kind) { known_kind } else { "" }));
    if let Some(biome) = get(known_destination, "biome") {
        input.insert("biome".into(), biome.clone());
    }
    input.insert("request".into(), requested_map.clone());
    input.insert("seed".into(), Value::String(format!("{location}:{}:{}", template(Some(theme_name)), template(coalesce(get(known_destination, "id"), None)))));
    sk_scene_base::scene_map_design::normalize_scene_map_design(&sk_scene_base::scene_map_design::scene_map_design_for(&Value::Object(input)))
}

// ---------------------------------------------------------------------------
// Карта мира
// ---------------------------------------------------------------------------

/// `knownDestinationsFrom(state)`: известные места, куда из текущей точки
/// ведёт открытый путь — сначала непосещённые, затем ближние, не больше восьми.
pub fn known_destinations_from(state: &Value) -> Vec<Value> {
    let map = get(Some(state), "worldMap");
    let Some(Value::Array(locations)) = get(map, "locations") else { return Vec::new() };
    let mut by_id: sk_core::indexmap::IndexMap<String, &Value> = sk_core::indexmap::IndexMap::new();
    for location in locations.iter().filter(|location| js::truthy(get(Some(location), "id"))) {
        by_id.insert(js::string(get(Some(location), "id")), location);
    }
    let mut regions: sk_core::indexmap::IndexMap<String, &Value> = sk_core::indexmap::IndexMap::new();
    for region in array(get(map, "regions")).iter().filter(|region| js::truthy(get(Some(region), "id"))) {
        regions.insert(js::string(get(Some(region), "id")), region);
    }
    let scene_location = text::lower(&clean(path(Some(state), &["scene", "location"]), 120));
    let current = by_id
        .get(&js::s(get(map, "currentLocationId")))
        .copied()
        .or_else(|| locations.iter().find(|location| text::lower(&clean(get(Some(location), "name"), 120)) == scene_location));
    let Some(current) = current else { return Vec::new() };
    let current_id = js::string(get(Some(current), "id"));
    let mut reachable: Vec<Value> = Vec::new();
    for route in array(get(map, "routes")) {
        if !js::truthy(Some(route)) || js::is_false(get(Some(route), "discovered")) {
            continue;
        }
        let from = js::string(get(Some(route), "from"));
        let to = js::string(get(Some(route), "to"));
        let other_id = if from == current_id {
            to
        } else if to == current_id {
            from
        } else {
            String::new()
        };
        let other = if other_id.is_empty() { None } else { by_id.get(&other_id).copied() };
        let Some(other) = other else { continue };
        let other_value = Some(other);
        if js::is_false(get(other_value, "known"))
            || js::is_true(get(other_value, "hidden"))
            || is_str(get(other_value, "visibility"), "gm_only")
            || reachable.iter().any(|entry| strict_eq(entry.get("id"), get(other_value, "id")))
        {
            continue;
        }
        let region = regions.get(&js::s(coalesce(get(other_value, "regionId"), get(other_value, "region_id")))).copied();
        let kind = clean(get(other_value, "kind"), 40);
        let distance = js::number(get(Some(route), "distance"));
        let mut entry = Map::new();
        entry.insert("id".into(), Value::String(js::string(get(other_value, "id"))));
        entry.insert("name".into(), Value::String(clean(get(other_value, "name"), 120)));
        entry.insert("kind".into(), Value::String(if kind.is_empty() { "landmark".into() } else { kind }));
        entry.insert("days".into(), js::num(if distance == 0.0 || distance.is_nan() { 1.0 } else { distance }.max(1.0)));
        entry.insert("danger".into(), Value::String(one_of(get(Some(route), "danger"), &DANGERS).unwrap_or_else(|| "средняя".into())));
        entry.insert("visited".into(), Value::Bool(js::is_true(get(other_value, "visited"))));
        for (key, limit) in [("summary", 320), ("history", 500)] {
            let value = clean(get(other_value, key), limit);
            if !value.is_empty() {
                entry.insert(key.into(), Value::String(value));
            }
        }
        let biome = clean(coalesce(get(other_value, "biome"), get(region, "biome")), 40);
        if !biome.is_empty() {
            entry.insert("biome".into(), Value::String(biome));
        }
        reachable.push(Value::Object(entry));
    }
    let mut reachable: Vec<Value> = reachable.into_iter().filter(|entry| js::truthy(entry.get("name"))).collect();
    reachable.sort_by(|left, right| {
        let visited = |entry: &Value| if js::is_true(entry.get("visited")) { 1.0 } else { 0.0 };
        let order = visited(left) - visited(right);
        if order != 0.0 {
            return order.partial_cmp(&0.0).unwrap_or(Ordering::Equal);
        }
        let days = js::number(left.get("days")) - js::number(right.get("days"));
        if days != 0.0 && !days.is_nan() {
            return days.partial_cmp(&0.0).unwrap_or(Ordering::Equal);
        }
        sk_story::campaign_loop_policy::locale_compare_ru(&js::s(left.get("name")), &js::s(right.get("name")))
    });
    reachable.truncate(8);
    reachable
}

fn destination_entry(location: &Value, region: Option<&Value>) -> Value {
    let location = Some(location);
    let kind = clean(get(location, "kind"), 40);
    json!({
        "id": js::string(get(location, "id")),
        "name": clean(get(location, "name"), 120),
        "kind": if kind.is_empty() { "landmark".to_string() } else { kind },
        "summary": clean(get(location, "summary"), 500),
        "history": clean(get(location, "history"), 700),
        "biome": clean(coalesce(get(location, "biome"), get(region, "biome")), 40),
    })
}

fn region_of<'a>(state: &'a Value, location: &Value) -> Option<&'a Value> {
    let expected = js::s(coalesce(get(Some(location), "regionId"), get(Some(location), "region_id")));
    array(path(Some(state), &["worldMap", "regions"])).iter().find(|candidate| js::s(get(Some(candidate), "id")) == expected)
}

/// Известная точка карты по каноническому имени, включая дальний маршрут.
fn known_world_destination_by_name(state: &Value, name: &str) -> Option<Value> {
    let key = location_key_str(name);
    let Some(Value::Array(locations)) = path(Some(state), &["worldMap", "locations"]) else { return None };
    if key.is_empty() {
        return None;
    }
    let visible: Vec<&Value> = locations
        .iter()
        .filter(|entry| {
            js::truthy(get(Some(entry), "id")) && !js::is_false(get(Some(entry), "known")) && !js::is_true(get(Some(entry), "hidden")) && !is_str(get(Some(entry), "visibility"), "gm_only")
        })
        .collect();
    let location = visible.iter().copied().find(|entry| location_key(get(Some(entry), "name")) == key).or_else(|| inflected_location_match(&visible, name))?;
    Some(destination_entry(location, region_of(state, location)))
}

/// Известная точка карты по авторитетному идентификатору.
fn known_world_destination_by_id(state: &Value, location_id: Option<&Value>) -> Option<Value> {
    let location = sk_geometry::world_map::world_location_by_id(get(Some(state), "worldMap"), &clean(location_id, 120))?;
    let value = Some(location);
    if !js::truthy(get(value, "id")) || js::is_false(get(value, "known")) || js::is_true(get(value, "hidden")) || is_str(get(value, "visibility"), "gm_only") {
        return None;
    }
    Some(destination_entry(location, region_of(state, location)))
}

fn building_place_name(value: &str) -> bool {
    test(re!(r"(?<![\p{L}])(?:таверн|трактир|постоял|харчевн|корчм|кабак|гостиниц|лавк|храм|часовн)\p{L}*", "iu"), value)
}

/// Кратчайший по числу открытых сегментов путь до известной точки.
fn known_world_route_to(state: &Value, target: &Value) -> Vec<Value> {
    let map = get(Some(state), "worldMap");
    let (Some(Value::Array(locations)), Some(Value::Array(routes))) = (get(map, "locations"), get(map, "routes")) else { return Vec::new() };
    if !js::truthy(target.get("id")) {
        return Vec::new();
    }
    let mut by_id: sk_core::indexmap::IndexMap<String, &Value> = sk_core::indexmap::IndexMap::new();
    for entry in locations.iter().filter(|entry| js::truthy(get(Some(entry), "id"))) {
        by_id.insert(js::string(get(Some(entry), "id")), entry);
    }
    let scene_location = location_key(path(Some(state), &["scene", "location"]));
    let current = by_id.get(&js::s(get(map, "currentLocationId"))).copied().or_else(|| locations.iter().find(|entry| location_key(get(Some(entry), "name")) == scene_location));
    let Some(current) = current.filter(|current| js::truthy(current.get("id"))) else { return Vec::new() };
    let start_id = js::string(current.get("id"));
    let target_id = js::string(target.get("id"));
    let mut queue = vec![start_id.clone()];
    let mut previous: sk_core::indexmap::IndexMap<String, Option<String>> = sk_core::indexmap::IndexMap::new();
    previous.insert(start_id.clone(), None);
    let mut cursor = 0;
    while cursor < queue.len() && !previous.contains_key(&target_id) {
        let current_id = queue[cursor].clone();
        for route in routes {
            if !js::truthy(Some(route)) || js::is_false(get(Some(route), "discovered")) {
                continue;
            }
            let from = js::string(get(Some(route), "from"));
            let to = js::string(get(Some(route), "to"));
            let next_id = if from == current_id {
                to
            } else if to == current_id {
                from
            } else {
                String::new()
            };
            let next = if next_id.is_empty() { None } else { by_id.get(&next_id).copied() };
            let Some(next) = next else { continue };
            if js::is_false(next.get("known")) || previous.contains_key(&next_id) {
                continue;
            }
            previous.insert(next_id.clone(), Some(current_id.clone()));
            queue.push(next_id);
        }
        cursor += 1;
    }
    if !previous.contains_key(&target_id) {
        return Vec::new();
    }
    let mut ids = vec![target_id.clone()];
    let mut current_id = target_id;
    while current_id != start_id {
        let Some(Some(parent)) = previous.get(&current_id).cloned() else { return Vec::new() };
        if parent.is_empty() {
            return Vec::new();
        }
        ids.insert(0, parent.clone());
        current_id = parent;
    }
    // Заведение внутри поселения: выйти из таверны значит оказаться в городе.
    if ids.len() > 2 {
        let start = by_id.get(&ids[0]).copied();
        let next = by_id.get(&ids[1]).copied();
        let scene_theme = coalesce(path(Some(state), &["scene", "theme"]), path(Some(state), &["scene", "map", "theme"]));
        let building = building_place_name(&js::s(get(start, "name")))
            || building_place_name(&js::s(path(Some(state), &["scene", "title"])))
            || BUILDING_SCENE_THEMES.contains(&js::s(scene_theme).as_str());
        if building && SETTLEMENT_KINDS.contains(&js::s(get(next, "kind")).as_str()) {
            ids.remove(0);
        }
    }
    ids.iter()
        .map(|id| {
            let entry = by_id.get(id).copied();
            let kind = clean(get(entry, "kind"), 40);
            let region_id = get(entry, "regionId");
            let biome = if js::truthy(region_id) {
                let expected = js::string(region_id);
                array(get(map, "regions")).iter().find(|region| js::s(get(Some(region), "id")) == expected).and_then(|region| region.get("biome")).cloned()
            } else {
                Some(Value::from(""))
            };
            json!({
                "id": id,
                "name": clean(get(entry, "name"), 120),
                "kind": if kind.is_empty() { "landmark".to_string() } else { kind },
                "summary": clean(get(entry, "summary"), 500),
                "history": clean(get(entry, "history"), 700),
                "biome": clean(biome.as_ref(), 40),
            })
        })
        .collect()
}

/// Куда идёт отряд, когда места не назвал никто.
fn fallback_destination(state: &Value, from: &str) -> (String, String) {
    if let Some(known) = known_destinations_from(state).first() {
        return (js::s(known.get("name")), js::s(known.get("kind")));
    }
    let stripped = text::replace_first(re!(r"^(?:окрестности|тракт за|дальние земли за)\s+", "iu"), from, "");
    let base = text::trim(&stripped);
    let base = if base.is_empty() { from } else { base };
    if test(re!(r"^окрестности\s", "iu"), from) {
        return (format!("Тракт за {base}"), "landmark".into());
    }
    if test(re!(r"^тракт за\s", "iu"), from) {
        return (format!("Дальние земли за {base}"), "landmark".into());
    }
    (format!("Окрестности {from}"), "landmark".into())
}

/// Параметры [`fallback_plan`] (`{ action, state, decision, destinationHint,
/// destinationLocationId, abandonsQuest }`).
#[derive(Clone, Debug, Default)]
pub struct PlanRequest {
    pub action: String,
    pub decision: String,
    pub destination_hint: String,
    pub destination_location_id: String,
    pub abandons_quest: bool,
}

/// `fallbackPlan(...)`: канонический план новой сцены без модели.
pub fn fallback_plan(state: &Value, request: &PlanRequest) -> Value {
    use sk_scenario::party_exit_intent::{nominative_place_phrase, objective_remainder, onward_route_objective, onward_route_target};
    let from = {
        let from = clean(or(path(Some(state), &["scene", "location"]), path(Some(state), &["scene", "title"])), 120);
        if from.is_empty() {
            "прежняя локация".to_string()
        } else {
            from
        }
    };
    let hint = clean_str(&request.destination_hint, 120);
    let hinted = if hint.is_empty() { String::new() } else { nominative_place_phrase(&hint) };
    let destination_by_id = known_world_destination_by_id(state, Some(&string_value(&request.destination_location_id)));
    let chosen = if !hinted.is_empty() || destination_by_id.is_some() { None } else { Some(fallback_destination(state, &from)) };
    let intended = destination_by_id.or_else(|| if hinted.is_empty() { None } else { known_world_destination_by_name(state, &hinted) });
    let route = intended.as_ref().map(|intended| known_world_route_to(state, intended)).unwrap_or_default();
    let routed = match route.len() {
        0 => None,
        1 => route.first().cloned(),
        _ => route.get(1).cloned(),
    };
    let unreachable = intended.is_some() && route.is_empty();
    let routed_name = routed.as_ref().map(|entry| js::s(entry.get("name"))).unwrap_or_default();
    let destination = if !routed_name.is_empty() {
        routed_name
    } else if unreachable {
        format!("Тракт к {}", js::s(intended.as_ref().and_then(|entry| entry.get("name"))))
    } else {
        let intended_name = intended.as_ref().map(|entry| js::s(entry.get("name"))).unwrap_or_default();
        if !intended_name.is_empty() {
            intended_name
        } else if !hinted.is_empty() {
            hinted.clone()
        } else {
            chosen.as_ref().map(|(name, _)| name.clone()).unwrap_or_default()
        }
    };
    let known_destination = routed.or_else(|| known_world_destination_by_name(state, &destination));
    let known_id = known_destination.as_ref().and_then(|entry| entry.get("id")).cloned();
    let onward_destination = match &intended {
        Some(intended) if !strict_eq(intended.get("id"), known_id.as_ref()) => js::s(intended.get("name")),
        _ => String::new(),
    };
    let known_kind = match known_destination.as_ref().and_then(|entry| coalesce(entry.get("kind"), None)) {
        Some(kind) => js::s(Some(kind)),
        None => chosen.as_ref().map(|(_, kind)| kind.clone()).unwrap_or_default(),
    };
    let location = text::capitalize(&destination);
    let objective_value = path(Some(state), &["scene", "objective"]);
    let onward_target = onward_route_target(&js::s(objective_value));
    let onward_point = if onward_target.is_empty() { None } else { known_world_destination_by_name(state, &onward_target) };
    let arrived_at_route_end = !onward_target.is_empty()
        && match (&onward_point, known_id.as_ref().filter(|id| js::truthy(Some(id)))) {
            (Some(point), Some(id)) => strict_eq(point.get("id"), Some(id)),
            _ => location_key_str(&onward_target) == location_key_str(&location),
        };
    let remainder: Option<String> = if request.abandons_quest || !onward_destination.is_empty() {
        None
    } else if arrived_at_route_end {
        Some(String::new())
    } else {
        objective_remainder(&js::s(objective_value), &location)
    };
    let continues = remainder.as_ref().is_some_and(|text| !text.is_empty());
    let reached = remainder.as_deref() == Some("");
    let chapter = {
        let chapter = js::number(path(Some(state), &["adventure", "chapter"]));
        let chapter = if chapter == 0.0 || chapter.is_nan() { 1.0 } else { chapter };
        chapter.max(1.0) + if continues { 0.0 } else { 1.0 }
    };
    let old_hook = clean(path(Some(state), &["adventure", "currentHook"]), 240);
    let old_objective = clean(objective_value, 160);
    let requested_hook = if test(re!(r"печат[ьи]\s+архивариуса", "iu"), &request.action) { "Печать архивариуса остаётся незавершённой нитью и может открыть другой путь." } else { "" };
    let hook = if request.abandons_quest {
        format!("В {location} найдётся дело, не связанное с оставленным заданием.")
    } else if !requested_hook.is_empty() {
        requested_hook.to_string()
    } else if !old_hook.is_empty() {
        old_hook.clone()
    } else if !old_objective.is_empty() {
        old_objective
    } else {
        format!("В {location} обнаружится связь с оставленным позади путём.")
    };
    let by_world_kind = if known_destination.is_some() { theme_for_world_kind(&known_kind) } else { None };
    let by_world_description = if known_destination.is_some() && ["landmark", "fortress"].contains(&known_kind.as_str()) { theme_for_world_description(known_destination.as_ref()) } else { None };
    let fallback_map = theme_for(&location, if !hinted.is_empty() && known_destination.is_none() { &request.action } else { "" });
    let authored = if js::truthy(known_id.as_ref()) { sk_map_core::authored_location_maps::authored_location_map_meta_for(known_id.as_ref()) } else { None };
    let mut planned = by_world_description.or(by_world_kind).unwrap_or(fallback_map);
    let base_theme = planned.get("theme").cloned().unwrap_or(Value::Null);
    let design = map_design_for(state, &location, &base_theme, known_destination.as_ref(), &known_kind, &Value::Object(planned.clone()));
    planned.insert("design".into(), design);
    if let Some(authored) = &authored {
        planned.insert("theme_id".into(), Value::String(authored.theme_id.clone()));
    }
    let planned_value = Some(&Value::Object(planned.clone())).cloned();
    let planned_ref = planned_value.as_ref();
    let streets = is_str(get(planned_ref, "layout"), "streets");
    let objective = if continues {
        remainder.clone().unwrap_or_default()
    } else if !onward_destination.is_empty() {
        onward_route_objective(&location, &onward_destination)
    } else if request.abandons_quest {
        format!("Осмотреться в «{location}» и найти новую цель")
    } else if !old_hook.is_empty() {
        clip_words(&format!("Найти в «{location}» другой путь к разгадке: {old_hook}"), 160)
    } else {
        format!("Осмотреться в «{location}» и найти другой путь")
    };
    let mut result = Map::new();
    result.insert("title".into(), Value::String(format!("Глава {} · {location}", js::f64_string(chapter))));
    result.insert("location".into(), Value::String(location.clone()));
    if let Some(id) = known_id.as_ref().filter(|id| js::truthy(Some(id))) {
        result.insert("location_id".into(), id.clone());
    }
    result.insert(
        "mood".into(),
        string_value(if streets { "Шумная передышка за городскими стенами, где опасность прячется среди людей" } else { "Неизведанное место, в котором путь ещё предстоит найти" }),
    );
    result.insert("objective".into(), Value::String(objective));
    result.insert(
        "transition".into(),
        Value::String(if continues || reached {
            format!("Отряд идёт из «{from}» туда, куда звала цель, — к «{location}».")
        } else {
            format!("Отряд оставляет «{from}» позади и пускается в путь — к «{location}».")
        }),
    );
    result.insert(
        "arrival".into(),
        Value::String(if streets {
            format!("Дорога выводит героев к воротам. За ними открываются улицы локации «{location}» — с площадями, переулками и местами, где можно искать сведения.")
        } else {
            format!("Дорога кончается: впереди — «{location}».")
        }),
    );
    result.insert("hook".into(), Value::String(hook));
    result.insert("theme".into(), get(planned_ref, "theme").cloned().unwrap_or(Value::Null));
    result.insert("danger".into(), get(planned_ref, "danger").cloned().unwrap_or(Value::Null));
    result.insert(
        "outcome".into(),
        Value::String(if request.abandons_quest {
            format!("Отряд покинул «{from}», отказавшись от прежнего задания.")
        } else if continues {
            format!("Отряд добрался до «{location}»; дело продолжается здесь.")
        } else if reached {
            format!("Отряд добрался до «{location}» — цель достигнута.")
        } else {
            format!("Отряд покинул «{from}», не закрыв прежнюю сюжетную нить.")
        }),
    );
    result.insert(
        "objective_status".into(),
        string_value(if request.abandons_quest {
            "abandoned"
        } else if continues {
            "continued"
        } else if reached {
            "completed"
        } else {
            "unresolved"
        }),
    );
    result.insert("carry_unresolved".into(), Value::Bool(!request.abandons_quest && !continues && !reached));
    let mut map = Map::new();
    for key in ["layout", "scale", "pattern", "material", "width", "height", "openness", "water", "featureCount", "design"] {
        if let Some(value) = planned.get(key) {
            map.insert(key.into(), value.clone());
        }
    }
    if let Some(authored) = &authored {
        if sk_themes::scene_themes::SCENE_THEME_IDS.contains(authored.theme_id.as_str()) {
            map.insert("theme_id".into(), Value::String(authored.theme_id.clone()));
        }
    }
    result.insert("map".into(), Value::Object(map));
    Value::Object(result)
}

/// «Прежняя цель остаётся незавершённой» — то, что модель писала при приходе
/// туда, куда звала сама цель.
fn unfinished_goal(value: &str) -> bool {
    test(re!(r"незаверш|не\s+закры|брошен|оставлен[а-яё]*\s+(?:цел|задан|нит)", "iu"), value)
}

fn invented_duration(value: &str) -> bool {
    test(re!(r"(?:после|спустя|через|прошл[а-яё]*)[^.!?]{0,70}(?:минут[а-яё]*|час[а-яё]*|дней|дня|день|недел[а-яё]*|суток|сутки)", "iu"), value)
}

/// `normalizePlan(value, fallback)`: из ответа модели — только допустимое;
/// следствия решения группы (`objective_status`, `carry_unresolved`) — от
/// сервера.
pub fn normalize_plan(value: Option<&Value>, fallback: &Value) -> Value {
    use sk_scene_base::scene_map_design::normalize_scene_map_design;
    use sk_scenario::party_exit_intent::onward_route_target;
    let empty = json!({});
    let source = match value {
        Some(value @ Value::Object(_)) => value,
        _ => &empty,
    };
    let map_source = match source.get("map") {
        Some(map @ Value::Object(_)) => map,
        _ => &empty,
    };
    let source_ref = Some(source);
    let map_ref = Some(map_source);
    let fallback_ref = Some(fallback);
    let fallback_map = get(fallback_ref, "map");
    let scale = one_of(get(map_ref, "scale"), &MAP_SCALES).map(Value::String).or_else(|| get(fallback_map, "scale").cloned()).unwrap_or(Value::Null);
    let dimensions = scale_dimensions(scale.as_str().unwrap_or(""));
    let mut design = normalize_scene_map_design(get(fallback_map, "design").unwrap_or(&Value::Null)).as_object().cloned().unwrap_or_default();
    if let Value::Object(model) = normalize_scene_map_design(get(map_ref, "design").unwrap_or(&Value::Null)) {
        for (key, value) in model {
            design.insert(key, value);
        }
    }
    let levels = sk_world_time::level_generator::normalize_declared_levels(get(source_ref, "levels"));
    let fallback_location = js::s(get(fallback_ref, "location"));
    let location = {
        let location = clean(get(source_ref, "location"), 120);
        if location.is_empty() {
            fallback_location.clone()
        } else {
            location
        }
    };
    let arrival = clean(get(source_ref, "arrival"), 500);
    let transition = clean(get(source_ref, "transition"), 500);
    let outcome = clean(get(source_ref, "outcome"), 240);
    let continued = is_str(get(fallback_ref, "objective_status"), "continued");
    let onward_leg = !onward_route_target(&js::s(get(fallback_ref, "objective"))).is_empty();
    let model_route_target = location_key_str(&onward_route_target(&js::s(get(source_ref, "objective"))));
    let route_to_here = !model_route_target.is_empty() && [location.as_str(), fallback_location.as_str()].iter().any(|place| location_key_str(place) == model_route_target);
    let pick = |own: String, key: &str| if own.is_empty() { get(fallback_ref, key).cloned().unwrap_or(Value::Null) } else { Value::String(own) };
    let title = clean(get(source_ref, "title"), 80);
    let mut result = Map::new();
    result.insert(
        "title".into(),
        if continued && test(re!(r"глава\s+\d", "iu"), &title) { get(fallback_ref, "title").cloned().unwrap_or(Value::Null) } else { pick(title, "title") },
    );
    result.insert("location".into(), Value::String(location.clone()));
    result.insert("mood".into(), pick(clean(get(source_ref, "mood"), 160), "mood"));
    result.insert(
        "objective".into(),
        if continued || onward_leg || route_to_here { get(fallback_ref, "objective").cloned().unwrap_or(Value::Null) } else { pick(clean(get(source_ref, "objective"), 160), "objective") },
    );
    result.insert(
        "transition".into(),
        if invented_duration(&transition) {
            string_value("Отряд следует подтверждённому маршруту.")
        } else if continued && unfinished_goal(&transition) {
            get(fallback_ref, "transition").cloned().unwrap_or(Value::Null)
        } else {
            pick(transition, "transition")
        },
    );
    result.insert("arrival".into(), if invented_duration(&arrival) { Value::String(format!("Отряд прибывает в локацию «{location}».")) } else { pick(arrival, "arrival") });
    result.insert("hook".into(), pick(clean(get(source_ref, "hook"), 240), "hook"));
    result.insert("theme".into(), pick(clean(get(source_ref, "theme"), 80), "theme"));
    result.insert("danger".into(), one_of(get(source_ref, "danger"), &DANGERS).map(Value::String).or_else(|| get(fallback_ref, "danger").cloned()).unwrap_or(Value::Null));
    result.insert(
        "outcome".into(),
        if invented_duration(&outcome) || (continued && unfinished_goal(&outcome)) { get(fallback_ref, "outcome").cloned().unwrap_or(Value::Null) } else { pick(outcome, "outcome") },
    );
    result.insert("objective_status".into(), get(fallback_ref, "objective_status").cloned().unwrap_or(Value::Null));
    result.insert("carry_unresolved".into(), get(fallback_ref, "carry_unresolved").cloned().unwrap_or(Value::Null));
    if !levels.is_empty() {
        result.insert("levels".into(), Value::Array(levels.iter().map(|level| level.to_json()).collect()));
    }
    // Заготовки ведущего новой области: хранителя у них нет — жителей сцены
    // расставляет сервер.
    let secrets: Vec<Value> = sk_memory::world_memory::normalize_gm_secrets(get(source_ref, "secrets"), 3)
        .into_iter()
        .map(|mut secret| {
            secret["holder"] = Value::from("");
            secret
        })
        .collect();
    if !secrets.is_empty() {
        result.insert("secrets".into(), Value::Array(secrets));
    }
    let mut map = Map::new();
    let theme_ids = &*sk_themes::scene_themes::SCENE_THEME_IDS;
    match (get(map_ref, "theme_id"), get(fallback_map, "theme_id")) {
        (Some(Value::String(id)), _) if theme_ids.contains(id.as_str()) => {
            map.insert("theme_id".into(), Value::String(id.clone()));
        }
        (_, Some(Value::String(id))) if theme_ids.contains(id.as_str()) => {
            map.insert("theme_id".into(), Value::String(id.clone()));
        }
        _ => {}
    }
    map.insert("layout".into(), one_of(get(map_ref, "layout"), &LAYOUTS).map(Value::String).or_else(|| get(fallback_map, "layout").cloned()).unwrap_or(Value::Null));
    map.insert("scale".into(), scale);
    map.insert("pattern".into(), one_of(get(map_ref, "pattern"), &MAP_PATTERNS).map(Value::String).or_else(|| get(fallback_map, "pattern").cloned()).unwrap_or(Value::Null));
    map.insert("material".into(), one_of(get(map_ref, "material"), &MAP_MATERIALS).map(Value::String).or_else(|| get(fallback_map, "material").cloned()).unwrap_or(Value::Null));
    map.insert("width".into(), clamp_integer(get(map_ref, "width"), dimensions.width, dimensions.minimum_width, dimensions.maximum_width));
    map.insert("height".into(), clamp_integer(get(map_ref, "height"), dimensions.height, dimensions.minimum_height, dimensions.maximum_height));
    map.insert("openness".into(), clamp_decimal(get(map_ref, "openness"), get(fallback_map, "openness"), 0.35, 0.85));
    map.insert("water".into(), clamp_decimal(get(map_ref, "water"), get(fallback_map, "water"), 0.0, 0.3));
    let feature_fallback = js::number(get(fallback_map, "featureCount"));
    map.insert(
        "featureCount".into(),
        if js::is_safe_integer_number(get(map_ref, "featureCount")) {
            js::num(js::number(get(map_ref, "featureCount")).clamp(2.0, 12.0))
        } else {
            get(fallback_map, "featureCount").cloned().unwrap_or_else(|| js::num(feature_fallback))
        },
    );
    if !design.is_empty() {
        map.insert("design".into(), Value::Object(design));
    }
    result.insert("map".into(), Value::Object(map));
    Value::Object(result)
}

// ---------------------------------------------------------------------------
// Названия мест
// ---------------------------------------------------------------------------

fn name_words(value: &str) -> Vec<String> {
    let key = text::replace_all(re!(r#"["'«»„“”`]"#, "gu"), &location_key_str(value), " ");
    text::find_all(re!(r"[\p{L}\p{N}]+", "gu"), &key).into_iter().filter(|word| len16(word) >= 3).collect()
}

fn distinctive_words(value: &str) -> Vec<String> {
    name_words(value).into_iter().filter(|word| !generic_destination_hint(word)).collect()
}

fn generic_words(value: &str) -> Vec<String> {
    name_words(value).into_iter().filter(|word| generic_destination_hint(word)).collect()
}

/// Одно и то же слово в разных падежах: общая основа и короткие падежные хвосты.
fn same_word_inflected(left: &str, right: &str) -> bool {
    if left == right {
        return true;
    }
    let left: Vec<u16> = left.encode_utf16().collect();
    let right: Vec<u16> = right.encode_utf16().collect();
    let mut common = 0;
    while common < left.len() && common < right.len() && left[common] == right[common] {
        common += 1;
    }
    if common < 3 || (common as i64) < left.len().max(right.len()) as i64 - 3 {
        return false;
    }
    let ending = |units: &[u16]| test(re!(r"^[аеёиоуыэюяйьмхвг]{0,3}$", "u"), &String::from_utf16_lossy(units));
    ending(&left[common..]) && ending(&right[common..])
}

fn inflected_location_match<'a>(locations: &[&'a Value], phrase: &str) -> Option<&'a Value> {
    let spoken = distinctive_words(phrase);
    let spoken_kinds = generic_words(phrase);
    if spoken.is_empty() && spoken_kinds.is_empty() {
        return None;
    }
    let mut best: Option<&Value> = None;
    let mut best_size = 0.0;
    let mut tie = false;
    for entry in locations {
        let name = js::s(entry.get("name"));
        let own_stems = distinctive_words(&name);
        let stems = if own_stems.is_empty() { generic_words(&name) } else { own_stems.clone() };
        let pool = if own_stems.is_empty() { &spoken_kinds } else { &spoken };
        if stems.is_empty() || pool.len() > stems.len() + 2 {
            continue;
        }
        if !stems.iter().all(|stem| pool.iter().any(|word| same_word_inflected(word, stem))) {
            continue;
        }
        let kinds = generic_words(&name);
        if !spoken_kinds.is_empty() && !kinds.is_empty() && !kinds.iter().any(|kind| spoken_kinds.iter().any(|word| same_word_inflected(word, kind))) {
            continue;
        }
        let size = if own_stems.is_empty() { 0.5 } else { own_stems.len() as f64 };
        if size > best_size {
            best = Some(entry);
            best_size = size;
            tie = false;
        } else if size == best_size {
            tie = true;
        }
    }
    if tie {
        None
    } else {
        best
    }
}

fn generic_destination_hint(value: &str) -> bool {
    test(
        re!(
            r"^(?:подземель|локац|мест|город|деревн|сел|пос[её]л|лес|чащ|рощ|болот|пустош|пустын|порт|гаван|пристан|зам|крепост|цитадел|форт|застав|лагер|храм|святилищ|монастыр|пещер|руин|архив|склеп|катакомб|шахт|башн|маяк(?=(?:а|у|ом|е|и|ов|ам|ами|ах)?$)|таверн|трактир|корчм|усадьб|поместь|особняк|здани|район|улиц|площад|рынок|тракт|дорог|перевал|ущель|долин|остров|берег|станци|пол)[а-яё]*$",
            "iu"
        ),
        &location_key_str(value),
    )
}

struct Constraint {
    destination: Option<Value>,
    exact_location: String,
    rejected: bool,
}

fn known_destination_constraint(
    state: &Value,
    destination_hint: &str,
    destination_location_id: &str,
    model_location: Option<&Value>,
    fallback_location: &str,
    fallback_location_id: Option<&Value>,
) -> Constraint {
    let known = known_destinations_from(state);
    let hinted = location_key_str(destination_hint);
    let modeled = location_key(model_location);
    let canonical = |destination: Option<Value>| {
        let exact_location = if destination.is_some() { String::new() } else { clean_str(fallback_location, 120) };
        let target = match &destination {
            Some(destination) => location_key(destination.get("name")),
            None => location_key_str(&exact_location),
        };
        let rejected = !modeled.is_empty() && modeled != target;
        Constraint { destination, exact_location, rejected }
    };
    if known_world_destination_by_id(state, Some(&string_value(destination_location_id))).is_some() {
        // Имя не является идентификатором: первый сегмент закрепляется по ID.
        return canonical(known_world_destination_by_id(state, fallback_location_id));
    }
    if !hinted.is_empty() {
        let intended = known_world_destination_by_name(state, destination_hint);
        if intended.is_none() && generic_destination_hint(destination_hint) {
            return Constraint { destination: None, exact_location: String::new(), rejected: false };
        }
        return canonical(known_world_destination_by_name(state, fallback_location));
    }
    if known.is_empty() {
        return Constraint { destination: None, exact_location: String::new(), rejected: false };
    }
    if !modeled.is_empty() {
        let destination = known.iter().find(|entry| location_key(entry.get("name")) == modeled).cloned();
        let rejected = destination.is_none();
        return Constraint { destination, exact_location: String::new(), rejected };
    }
    let fallback_key = location_key_str(fallback_location);
    Constraint { destination: known.iter().find(|entry| location_key(entry.get("name")) == fallback_key).cloned().or_else(|| known.first().cloned()), exact_location: String::new(), rejected: false }
}

/// `SceneArchitectAgent`: новая область после решения группы.
#[derive(Clone, Debug, Default)]
pub struct SceneArchitectAgent {
    llm_client: Option<RoleClient>,
}

impl SceneArchitectAgent {
    /// `new SceneArchitectAgent({ llmClient })`.
    pub fn new(llm_client: Option<RoleClient>) -> Self {
        SceneArchitectAgent { llm_client }
    }

    /// `plan({ action, state, decision, destinationHint, destinationLocationId,
    /// abandonsQuest })`: `{ sceneArgs, shopIntent, trace }`.
    pub async fn plan(&self, state: &Value, request: &PlanRequest) -> Value {
        // ID приходит от клиента и доверенным становится только по точному
        // совпадению с известным узлом карты мира.
        let authoritative = known_world_destination_by_id(state, Some(&string_value(&request.destination_location_id)));
        let authoritative_name = authoritative.as_ref().map(|entry| js::s(entry.get("name"))).unwrap_or_default();
        let resolved_hint = if authoritative_name.is_empty() { clean_str(&request.destination_hint, 120) } else { authoritative_name };
        let authoritative_id = authoritative.as_ref().map(|entry| js::s(entry.get("id"))).unwrap_or_default();
        let action = clean_str(&request.action, 2000);
        let decision = clean_str(&request.decision, 500);
        let plan_request = |hint: String, id: String| PlanRequest { action: action.clone(), decision: decision.clone(), destination_hint: hint, destination_location_id: id, abandons_quest: request.abandons_quest };
        let fallback = fallback_plan(state, &plan_request(resolved_hint.clone(), authoritative_id.clone()));
        let fallback_shop = sk_economy::scene_commerce::default_scene_shop_intent(Some(&fallback));
        let authored_id = match coalesce(fallback.get("location_id"), None) {
            Some(id) => js::s(Some(id)),
            None => authoritative_id.clone(),
        };
        let authored = if authored_id.is_empty() { None } else { sk_map_core::authored_location_maps::authored_location_map_meta_for(Some(&Value::String(authored_id))) };
        if let Some(authored) = authored {
            return json!({
                "sceneArgs": fallback,
                "shopIntent": fallback_shop,
                "trace": { "agent": SCENE_ARCHITECT_AGENT_ID, "mode": "authored-catalog", "location_id": authored.location_id, "map_seed": authored.seed },
            });
        }
        let Some(client) = self.llm_client.as_ref() else {
            return json!({
                "sceneArgs": fallback,
                "shopIntent": fallback_shop,
                "trace": { "agent": SCENE_ARCHITECT_AGENT_ID, "mode": "deterministic-fallback", "reason": "LLM is not configured" },
            });
        };
        let input = Self::model_request(state, request, &resolved_hint, authoritative.as_ref(), &fallback);
        let result = match client.client().complete_json(&input, &json!({ "timeoutMs": 20_000 })).await {
            Ok(result) => result,
            Err(error) => {
                return json!({
                    "sceneArgs": fallback,
                    "shopIntent": fallback_shop,
                    "trace": { "agent": SCENE_ARCHITECT_AGENT_ID, "mode": "deterministic-fallback", "reason": error.message },
                });
            }
        };
        let fallback_location = js::s(fallback.get("location"));
        let constraint = known_destination_constraint(state, &resolved_hint, &authoritative_id, get(Some(&result), "location"), &fallback_location, fallback.get("location_id"));
        let constrained_fallback = match &constraint.destination {
            Some(destination) if strict_eq(destination.get("id"), fallback.get("location_id")) => fallback.clone(),
            Some(destination) => fallback_plan(state, &plan_request(js::s(destination.get("name")), js::s(destination.get("id")))),
            None => fallback.clone(),
        };
        let mut scene_args = if constraint.rejected { fallback.clone() } else { normalize_plan(Some(&result), &constrained_fallback) };
        if let (Some(destination), false) = (&constraint.destination, constraint.rejected) {
            let canonical_map = constrained_fallback.get("map").and_then(Value::as_object).cloned().unwrap_or_default();
            let model_map = scene_args.get("map").cloned().unwrap_or(Value::Null);
            scene_args["location"] = destination.get("name").cloned().unwrap_or(Value::Null);
            scene_args["location_id"] = destination.get("id").cloned().unwrap_or(Value::Null);
            scene_args["theme"] = constrained_fallback.get("theme").cloned().unwrap_or(Value::Null);
            scene_args["danger"] = constrained_fallback.get("danger").cloned().unwrap_or(Value::Null);
            let mut map = canonical_map;
            for key in ["width", "height", "openness", "water", "featureCount"] {
                match model_map.get(key) {
                    Some(value) => {
                        map.insert(key.into(), value.clone());
                    }
                    None => {
                        map.insert(key.into(), Value::Null);
                    }
                }
            }
            let theme_name = constrained_fallback.get("theme").cloned().unwrap_or(Value::Null);
            let destination_name = js::s(destination.get("name"));
            let kind = js::s(destination.get("kind"));
            map.insert("design".into(), map_design_for(state, &destination_name, &theme_name, Some(destination), &kind, &model_map));
            scene_args["map"] = Value::Object(map);
        }
        if !constraint.exact_location.is_empty() && !constraint.rejected {
            scene_args["location"] = Value::String(constraint.exact_location.clone());
        }
        let shop = if constraint.rejected { fallback_shop } else { sk_economy::scene_commerce::normalize_scene_shop_intent(get(Some(&result), "shop_intent"), Some(&scene_args)) };
        let mut trace = json!({ "agent": SCENE_ARCHITECT_AGENT_ID, "mode": "model", "model": client.model_value() });
        if constraint.rejected {
            trace["constraint"] = Value::from("known_destination_fallback");
        }
        json!({ "sceneArgs": scene_args, "shopIntent": shop, "trace": trace })
    }

    /// Запрос к модели, который отправил бы [`Self::plan`].
    fn model_request(state: &Value, request: &PlanRequest, resolved_hint: &str, authoritative: Option<&Value>, fallback: &Value) -> Value {
        let mut planning = Map::new();
        planning.insert("selected_party_decision".into(), Value::String(clean_str(&request.decision, 500)));
        planning.insert("destination_hint".into(), string_value(resolved_hint));
        planning.insert("destination_location_id".into(), authoritative.and_then(|entry| entry.get("id")).cloned().unwrap_or(Value::Null));
        planning.insert("quest_abandoned".into(), Value::Bool(request.abandons_quest));
        if is_str(fallback.get("objective_status"), "continued") {
            planning.insert("objective_continues".into(), Value::Bool(true));
            planning.insert("objective_after_arrival".into(), fallback.get("objective").cloned().unwrap_or(Value::Null));
        }
        if let Value::Object(brief) = build_director_planning_brief(state) {
            for (key, value) in brief {
                planning.insert(key, value);
            }
        }
        planning.insert("full_resolution_context".into(), Value::String(clean_str(&request.action, 2000)));
        json!({
            "messages": [
                { "role": "system", "content": PROMPT },
                { "role": "user", "content": sk_tactics::security::build_data_only_context(Some(&json!({ "scene_planning": Value::Object(planning) }))) },
            ],
            "temperature": 0.45,
            "maxTokens": 1000,
        })
    }
}

/// Системный промпт роли (`prompts/map_architect/v8.txt`).
pub fn scene_architect_prompt() -> &'static str {
    PROMPT
}

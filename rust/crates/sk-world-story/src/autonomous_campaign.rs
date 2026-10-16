//! Перенос `server/autonomous-campaign.mjs`: контракт намерения Режиссёра и
//! состояние автономного цикла.
//!
//! Режиссёр (модель) предлагает только повествовательное намерение из
//! закрытого списка [`DIRECTOR_INTENT_TYPES`]; механические поля (хиты, СЛ,
//! броски, цены, координаты, урон…) контракт отклоняет на любой глубине.
//! Исполняет намерение `autonomous-orchestrator`, а здесь — проверка,
//! редьюсер `state.autonomy` ([`apply_autonomy_event`]) и запасная зацепка.
//!
//! JS переэкспортирует `serverEncounterLoot` (`loot-tables`) и
//! `freezeEncounterOutcomePlan`, `serverRewardForEncounter`
//! (`encounter-rewards`); здесь — те же функции из их крейтов.

use std::collections::HashSet;

use serde_json::{json, Map, Value};
use sk_core::{hash, js, text as jstext};
use sk_encounters::encounter_assembler::ENCOUNTER_THEMES;

pub use sk_character::encounter_rewards::{freeze_encounter_outcome_plan, server_reward_for_encounter};
pub use sk_items::loot_tables::server_encounter_loot;

pub const DIRECTOR_INTENT_VERSION: &str = "skazanie:director-intent-v1";
pub const SCENE_RESOLUTION_EVENT_SCHEMA_VERSION: i64 = 1;
pub const DIRECTOR_INTENT_TYPES: [&str; 7] = [
    "continue_exploration",
    "open_social_scene",
    "advance_quest_clock",
    "request_encounter",
    "resolve_scene",
    "end_scene",
    "offer_next_hook",
];

const DIFFICULTIES: [&str; 4] = ["easy", "medium", "hard", "deadly"];
const SCENE_RESOLUTIONS: [&str; 3] = ["negotiation", "objective", "decision"];
const TOP_LEVEL_FIELDS: [&str; 10] = ["version", "type", "theme", "difficulty", "quest_id", "npc_id", "hook", "destination", "resolution", "reason"];
const PACING_PHASES: [&str; 4] = ["breather", "development", "escalation", "climax"];

/// Механические поля, уже приведённые [`mechanical_key`] (`max_hp` → `maxhp`).
const FORBIDDEN_MECHANICAL_FIELDS: [&str; 19] = [
    "hp", "maxhp", "dc", "difficultyclass", "roll", "dice", "price", "quantity", "xp", "xpbudget", "loot", "coordinates", "x", "y", "damage", "armor", "initiative",
    "reputationdelta", "amount",
];

/// Свойства `Object.prototype`, которые `obj[key]` находит у любого объекта.
const OBJECT_PROTOTYPE_KEYS: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

/// Отказ контракта Режиссёра (`DirectorIntentError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectorIntentError {
    pub code: String,
    pub message: String,
}

impl DirectorIntentError {
    pub const NAME: &'static str = "DirectorIntentError";
    pub const DEFAULT_CODE: &'static str = "DIRECTOR_INTENT_INVALID";

    fn new(message: impl Into<String>, code: &str) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

impl std::fmt::Display for DirectorIntentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for DirectorIntentError {}

/// `String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)`.
fn clean(value: Option<&Value>, maximum: usize) -> String {
    jstext::head(&jstext::squash_spaces(&jstext::nfkc(&js::s(value))), maximum)
}

fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match value {
        Some(Value::Object(map)) => map.get(key),
        _ => None,
    }
}

fn is_nullish(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null))
}

fn safe_id(value: Option<&Value>, label: &str) -> Result<String, DirectorIntentError> {
    let result = clean(value, 120);
    let mut chars = result.chars();
    let first_ok = chars.next().is_some_and(|ch| ch.is_ascii_alphanumeric());
    let rest_ok = chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-'));
    if !(first_ok && rest_ok) {
        return Err(DirectorIntentError::new(format!("{label} должен быть безопасным идентификатором"), "DIRECTOR_INTENT_INVALID_ID"));
    }
    Ok(result)
}

/// `String(value).toLowerCase().replace(/[_-]/g, '')`.
fn mechanical_key(key: &str) -> String {
    jstext::lower(key).chars().filter(|ch| *ch != '_' && *ch != '-').collect()
}

fn assert_no_mechanics(value: &Value, path: &str) -> Result<(), DirectorIntentError> {
    let entries: Vec<(String, &Value)> = match value {
        Value::Object(map) => js::entries(map).into_iter().map(|(key, child)| (key.clone(), child)).collect(),
        Value::Array(items) => items.iter().enumerate().map(|(index, child)| (index.to_string(), child)).collect(),
        _ => return Ok(()),
    };
    for (key, child) in entries {
        if FORBIDDEN_MECHANICAL_FIELDS.contains(&mechanical_key(&key).as_str()) {
            return Err(DirectorIntentError::new(format!("Director не может задавать механическое поле {path}.{key}"), "DIRECTOR_MECHANICS_FORBIDDEN"));
        }
        assert_no_mechanics(child, &format!("{path}.{key}"))?;
    }
    Ok(())
}

/// `set.has(value)` со строгим сравнением: только строка из списка.
fn exact<'a>(value: Option<&Value>, allowed: &[&'a str]) -> Option<&'a str> {
    match value {
        Some(Value::String(text)) => allowed.iter().find(|entry| **entry == text).copied(),
        _ => None,
    }
}

/// `normalizeDirectorIntent(input)`: проверенное намерение Режиссёра или отказ.
pub fn normalize_director_intent(input: Option<&Value>) -> Result<Value, DirectorIntentError> {
    let empty = json!({});
    let input = input.unwrap_or(&empty);
    let Value::Object(map) = input else {
        return Err(DirectorIntentError::new("Director intent должен быть объектом", DirectorIntentError::DEFAULT_CODE));
    };
    assert_no_mechanics(input, "$")?;
    let unexpected: Vec<&String> = js::keys(map).into_iter().filter(|key| !TOP_LEVEL_FIELDS.contains(&key.as_str())).collect();
    if !unexpected.is_empty() {
        let list: Vec<&str> = unexpected.iter().map(|key| key.as_str()).collect();
        return Err(DirectorIntentError::new(format!("Director intent содержит неизвестные поля: {}", list.join(", ")), "DIRECTOR_INTENT_UNKNOWN_FIELD"));
    }
    let field = |key: &str| map.get(key);
    if !is_nullish(field("version")) && field("version").and_then(Value::as_str) != Some(DIRECTOR_INTENT_VERSION) {
        return Err(DirectorIntentError::new("Director intent использует неподдерживаемую версию контракта", "DIRECTOR_INTENT_VERSION_UNSUPPORTED"));
    }
    let kind = clean(field("type"), 40);
    if !DIRECTOR_INTENT_TYPES.contains(&kind.as_str()) {
        return Err(DirectorIntentError::new("Director предложил неизвестное намерение", "DIRECTOR_INTENT_NOT_ALLOWED"));
    }
    let mut intent = Map::new();
    intent.insert("version".into(), json!(DIRECTOR_INTENT_VERSION));
    intent.insert("type".into(), json!(kind));
    if kind == "request_encounter" {
        let Some(theme) = exact(field("theme"), &ENCOUNTER_THEMES) else {
            return Err(DirectorIntentError::new("Тема встречи не входит в server allowlist", "DIRECTOR_ENCOUNTER_THEME_NOT_ALLOWED"));
        };
        let Some(difficulty) = exact(field("difficulty"), &DIFFICULTIES) else {
            return Err(DirectorIntentError::new("Сложность встречи не входит в server allowlist", "DIRECTOR_ENCOUNTER_DIFFICULTY_NOT_ALLOWED"));
        };
        intent.insert("theme".into(), json!(theme));
        intent.insert("difficulty".into(), json!(difficulty));
        if !is_nullish(field("npc_id")) {
            intent.insert("npc_id".into(), json!(safe_id(field("npc_id"), "npc_id")?));
        }
    }
    if kind == "advance_quest_clock" {
        intent.insert("quest_id".into(), json!(safe_id(field("quest_id"), "quest_id")?));
    }
    if kind == "open_social_scene" && !is_nullish(field("npc_id")) {
        intent.insert("npc_id".into(), json!(safe_id(field("npc_id"), "npc_id")?));
    }
    if kind == "offer_next_hook" {
        intent.insert("hook".into(), json!(clean(field("hook"), 300)));
    }
    if kind == "end_scene" {
        intent.insert("destination".into(), json!(clean(field("destination"), 160)));
    }
    if kind == "resolve_scene" {
        let Some(resolution) = exact(field("resolution"), &SCENE_RESOLUTIONS) else {
            return Err(DirectorIntentError::new("Способ завершения сцены не входит в server allowlist", "DIRECTOR_SCENE_RESOLUTION_NOT_ALLOWED"));
        };
        intent.insert("resolution".into(), json!(resolution));
    }
    if !is_nullish(field("reason")) {
        intent.insert("reason".into(), json!(clean(field("reason"), 240)));
    }
    Ok(Value::Object(intent))
}

fn digest(value: &Value) -> String {
    hash::sha256_hex(js::stringify(value))[..20].to_string()
}

/// `Number(value) || 0`.
fn number_or_zero(value: Option<&Value>) -> f64 {
    let number = js::number(value);
    if number.is_nan() || number == 0.0 {
        0.0
    } else {
        number
    }
}

/// `Math.max(lo, Math.min(hi, x))` с заразным `NaN`.
fn clamp(value: f64, low: f64, high: f64) -> f64 {
    if value.is_nan() {
        f64::NAN
    } else {
        value.min(high).max(low)
    }
}

/// Число JS в JSON; нечисло — строкой `NaN`: `Number()` даёт из неё то же.
fn number_value(value: f64) -> Value {
    if value.is_finite() {
        js::num(value)
    } else {
        Value::String(js::f64_string(value))
    }
}

fn safe_int_or_zero(value: Option<&Value>) -> f64 {
    if js::is_safe_integer_number(value) {
        js::number(value)
    } else {
        0.0
    }
}

/// `Object.entries(value ?? {})`: у строки — её символы по индексам.
fn object_entries(value: Option<&Value>) -> Vec<(String, Value)> {
    match value {
        Some(Value::Object(map)) => js::entries(map).into_iter().map(|(key, value)| (key.clone(), value.clone())).collect(),
        Some(Value::Array(items)) => items.iter().enumerate().map(|(index, item)| (index.to_string(), item.clone())).collect(),
        Some(Value::String(text)) => text.chars().enumerate().map(|(index, ch)| (index.to_string(), Value::String(ch.to_string()))).collect(),
        _ => Vec::new(),
    }
}

fn tail(value: Option<&Value>, keep: usize) -> Value {
    match value {
        Some(Value::Array(items)) => Value::Array(items[items.len().saturating_sub(keep)..].to_vec()),
        _ => json!([]),
    }
}

/// `normalizeAutonomyState(input)`: состояние автономного цикла, схема 3.
pub fn normalize_autonomy_state(input: Option<&Value>) -> Value {
    normalize_with(input, false)
}

/// Нормализация; `keep_infinite` — бесконечный `beat` остаётся строкой
/// `Infinity` для следующего шага редьюсера (в JS это число, а в JSON — `null`).
fn normalize_with(input: Option<&Value>, keep_infinite: bool) -> Value {
    let finite = |value: f64| if keep_infinite { number_value(value) } else { js::num(value) };
    let source = input.filter(|value| js::is_plain(Some(value)));
    let s = |key: &str| get(source, key);
    let mut reputations = Map::new();
    for (key, value) in object_entries(s("reputations")).into_iter().take(200) {
        let id = clean(Some(&Value::String(key)), 120);
        if id.is_empty() {
            continue;
        }
        let value = clamp(safe_int_or_zero(Some(&value)), -100.0, 100.0);
        reputations.insert(id, js::num(value));
    }
    let pacing = match s("pacing") {
        Some(Value::Object(pacing)) => json!({
            "beat": finite(number_or_zero(pacing.get("beat")).max(0.0)),
            "phase": exact(pacing.get("phase"), &PACING_PHASES).unwrap_or("breather"),
            "tension": number_value(clamp(number_or_zero(pacing.get("tension")), 0.0, 100.0)),
            "last_intent_type": clean(pacing.get("last_intent_type"), 40),
        }),
        _ => json!({ "beat": 0, "phase": "breather", "tension": 0, "last_intent_type": "" }),
    };
    let mut seen: HashSet<String> = HashSet::new();
    let consequences: Vec<String> = match s("applied_consequences") {
        Some(Value::Array(items)) => items.iter().map(|item| clean(Some(item), 160)).filter(|item| !item.is_empty() && seen.insert(item.clone())).collect(),
        _ => Vec::new(),
    };
    let consequences = consequences[consequences.len().saturating_sub(2_000)..].to_vec();
    json!({
        "schema_version": 3,
        "director_history": tail(s("director_history"), 500),
        "director_outcomes": tail(s("director_outcomes"), 500),
        "hooks": tail(s("hooks"), 100),
        "transitions": tail(s("transitions"), 100),
        "encounter_outcomes": tail(s("encounter_outcomes"), 200),
        "scene_resolutions": tail(s("scene_resolutions"), 100),
        "reputations": Value::Object(reputations),
        "witness_graph": tail(s("witness_graph"), 500),
        "pacing": pacing,
        "travel_history": tail(s("travel_history"), 200),
        "downtime_history": tail(s("downtime_history"), 200),
        "random_encounters": tail(s("random_encounters"), 200),
        "applied_consequences": consequences,
        "admin_interventions": js::num(safe_int_or_zero(s("admin_interventions")).max(0.0)),
    })
}

/// `serverReputationDelta({ severity, outcome })`: поправка репутации по
/// исходу и тяжести. Пропущенное поле — значение по умолчанию JS (`minor`,
/// `neutral`).
///
/// Ключ `Object.prototype` в тяжести (`constructor`, `toString`, …) в JS
/// находит унаследованную функцию и возвращает её; здесь — пустой объект
/// (так функция выглядит в эталоне). Собственные свойства функций (`length`,
/// `name`, `call` при исходе — ключе прототипа) не повторяются.
pub fn server_reputation_delta(options: &Value) -> Value {
    let key = |name: &str, fallback: &str| match get(Some(options), name) {
        None => fallback.to_string(),
        some => js::string(some),
    };
    let severity = key("severity", "minor");
    let outcome = key("outcome", "neutral");
    let row: Option<[i64; 2]> = match outcome.as_str() {
        "helpful" => Some([2, 5]),
        "harmful" => Some([-2, -5]),
        "neutral" => Some([0, 0]),
        _ => None,
    };
    let inherited = OBJECT_PROTOTYPE_KEYS.contains(&severity.as_str());
    match row {
        Some(row) => match severity.as_str() {
            "minor" => json!(row[0]),
            "major" => json!(row[1]),
            _ if inherited => json!({}),
            _ => json!(0),
        },
        // Исход — ключ прототипа: у найденной функции (или самого прототипа)
        // тяжесть-ключ прототипа снова находит функцию; `__proto__.__proto__` — `null`.
        None if OBJECT_PROTOTYPE_KEYS.contains(&outcome.as_str()) && inherited => {
            if outcome == "__proto__" && severity == "__proto__" {
                json!(0)
            } else {
                json!({})
            }
        }
        None => json!(0),
    }
}

fn first_open_quest(state: &Value) -> Option<&Value> {
    match js::path(state, &["worldMemory", "quests"]) {
        Some(Value::Array(quests)) => quests.iter().find(|quest| {
            let quest = Some(*quest);
            matches!(get(quest, "status"), Some(Value::String(status)) if status == "active") && !js::truthy(get(get(quest, "clock"), "triggered"))
        }),
        _ => None,
    }
}

/// `ensureAvailableHook(state, source)`: запасная зацепка, если открытой нет.
/// `source` — `None` для значения по умолчанию `fail-safe`.
pub fn ensure_available_hook(state: &Value, source: Option<&Value>) -> Option<Value> {
    let default_source = json!("fail-safe");
    let source = source.unwrap_or(&default_source);
    if let Some(Value::Array(hooks)) = js::path(state, &["autonomy", "hooks"]) {
        if hooks.iter().any(|hook| matches!(get(Some(hook), "status"), Some(Value::String(status)) if status == "available")) {
            return None;
        }
    }
    let text = match first_open_quest(state) {
        Some(quest) => format!("Продолжить: {}", js::string(get(Some(quest), "title"))),
        None => {
            let location = clean(js::path(state, &["scene", "location"]), 120);
            format!("Исследовать {}", if location.is_empty() { "окрестности" } else { &location })
        }
    };
    let mut key = Map::new();
    key.insert("source".into(), source.clone());
    key.insert("text".into(), json!(text));
    if let Some(version) = get(Some(state), "state_version") {
        key.insert("version".into(), version.clone());
    }
    Some(json!({
        "id": format!("hook-{}", digest(&Value::Object(key))),
        "text": text,
        "status": "available",
        "source": source,
    }))
}

/// `a !== b` для значений JSON: объекты и массивы — разные ссылки.
fn strictly_differs(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) => false,
        (Some(Value::Null), Some(Value::Null)) => false,
        (Some(Value::Bool(a)), Some(Value::Bool(b))) => a != b,
        (Some(Value::String(a)), Some(Value::String(b))) => a != b,
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() != b.as_f64(),
        _ => true,
    }
}

fn push(autonomy: &mut Value, key: &str, value: Value) {
    if let Some(Value::Array(items)) = autonomy.get_mut(key) {
        items.push(value);
    }
}

/// `applyAutonomyEvent(input, event)`: редьюсер `state.autonomy`.
pub fn apply_autonomy_event(input: Option<&Value>, event: &Value) -> Value {
    let mut autonomy = normalize_with(input, true);
    let event_type = get(Some(event), "event_type").and_then(Value::as_str).unwrap_or_default();
    let empty = json!({});
    let payload = match get(Some(event), "payload") {
        None | Some(Value::Null) => &empty,
        Some(payload) => payload,
    };
    let p = |key: &str| get(Some(payload), key);
    match event_type {
        "DirectorIntentRecorded" => push(&mut autonomy, "director_history", payload.clone()),
        "DirectorIntentOutcomeRecorded" => push(&mut autonomy, "director_outcomes", payload.clone()),
        "CampaignPacingAdvanced" => {
            let previous_beat = js::number(autonomy["pacing"].get("beat"));
            let previous_phase = autonomy["pacing"]["phase"].clone();
            let beat = {
                let next = js::number(p("beat"));
                if next.is_nan() || next == 0.0 {
                    previous_beat
                } else {
                    next
                }
            };
            autonomy["pacing"] = json!({
                "beat": number_value(if beat.is_nan() { f64::NAN } else { beat.max(0.0) }),
                "phase": exact(p("phase"), &PACING_PHASES).map_or(previous_phase, |phase| json!(phase)),
                "tension": number_value(clamp(number_or_zero(p("tension_after")), 0.0, 100.0)),
                "last_intent_type": clean(p("intent_type"), 40),
            });
        }
        "TravelResolved" => push(&mut autonomy, "travel_history", payload.clone()),
        "DowntimeResolved" => push(&mut autonomy, "downtime_history", payload.clone()),
        "RandomEncounterTriggered" => push(&mut autonomy, "random_encounters", payload.clone()),
        "NextHookOffered" => {
            let hook = p("hook");
            let hook_id = get(hook, "id");
            if let Some(Value::Array(hooks)) = autonomy.get_mut("hooks") {
                hooks.retain(|entry| strictly_differs(get(Some(entry), "id"), hook_id));
                hooks.push(hook.cloned().unwrap_or(Value::Null));
            }
        }
        "TransitionUnlocked" => push(&mut autonomy, "transitions", p("transition").cloned().unwrap_or(Value::Null)),
        "EncounterOutcomeRecorded" => push(&mut autonomy, "encounter_outcomes", payload.clone()),
        "SceneResolutionRecorded" => push(&mut autonomy, "scene_resolutions", payload.clone()),
        "FactionReputationAdjusted" => {
            let id = clean(p("faction_id"), 120);
            let delta = if js::truthy(p("delta")) { js::number(p("delta")) } else { 0.0 };
            if let Some(Value::Object(reputations)) = autonomy.get_mut("reputations") {
                let own = reputations.get(&id).cloned();
                let next = match &own {
                    // Собственное значение — число из нормализации.
                    Some(value) => clamp(js::number(Some(value)) + delta, -100.0, 100.0),
                    // Унаследованная функция складывается строкой: `NaN`.
                    None if OBJECT_PROTOTYPE_KEYS.contains(&id.as_str()) => f64::NAN,
                    None => clamp(delta, -100.0, 100.0),
                };
                // Присваивание `obj.__proto__ = NaN` без своего поля игнорируется.
                if !(own.is_none() && id == "__proto__") {
                    reputations.insert(id, number_value(next));
                }
            }
        }
        "WitnessConsequencePropagated" => push(&mut autonomy, "witness_graph", payload.clone()),
        _ => {}
    }
    if js::truthy(p("consequence_key")) {
        let key = clean(p("consequence_key"), 160);
        if let Some(Value::Array(items)) = autonomy.get_mut("applied_consequences") {
            if !items.iter().any(|item| item.as_str() == Some(key.as_str())) {
                items.push(Value::String(key));
            }
        }
    }
    normalize_autonomy_state(Some(&autonomy))
}

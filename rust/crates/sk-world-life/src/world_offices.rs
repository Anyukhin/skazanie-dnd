//! Перенос `server/world-offices.mjs`: небольшой событийный реестр должностей
//! мира.
//!
//! Конфигурация приходит из authored/bootstrap и описывает известную
//! должность и одного заранее названного преемника. Смерть держателя
//! освобождает должность ([`plan_office_vacancy_drafts`]), мировой час один
//! раз проверяет преемника ([`plan_office_succession_drafts`]); редьюсер
//! ([`apply_world_office_event`]) не перепроверяет живость — replay хранит
//! подтверждённый исход. Граница осведомлённости (`knowledge_gate`) прячет
//! от стола смену держателя, о которой отряд ещё не знает.

use std::fmt;

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexSet;
use sk_core::{hash, js};
use sk_npc_world::npc_positioning::npc_vital_for;
use sk_social::npc_social::npc_profile_at_world_time;
use sk_society::quest_consequences::{knowledge_gate_for_event, knowledge_gate_visible};
use sk_society::reputation_policy::faction_ids_for_npc;

use crate::common::{array, coalesce, f64_value, get, is_safe_id, is_str, js_max, safe_integer, spread, string, text};

pub const WORLD_OFFICES_SCHEMA_VERSION: i64 = 1;
pub const WORLD_OFFICES_POLICY_ID: &str = "skazanie:world-offices-v2";
pub const WORLD_OFFICES_LEGACY_POLICY_ID: &str = "skazanie:world-offices-v1";
pub const OFFICE_EVENT_SCHEMA_VERSION: i64 = 2;
pub const OFFICE_EVENT_LEGACY_SCHEMA_VERSION: i64 = 1;

pub const WORLD_OFFICE_EVENT_TYPES: [&str; 3] = ["OfficeVacated", "OfficeHolderInstalled", "OfficeSuccessionSkipped"];

const OFFICE_STATUSES: [&str; 2] = ["held", "vacant"];
const SUCCESSION_OUTCOMES: [&str; 2] = ["installed", "skipped"];
const SKIP_REASONS: [&str; 7] = [
    "no_successor_configured",
    "candidate_missing",
    "candidate_dead",
    "candidate_unavailable",
    "candidate_wrong_faction",
    "candidate_missing_tag",
    "office_occupied",
];

const MAX_OFFICES: usize = 100;
const MAX_SUCCESSION_HISTORY: usize = 32;
const MAX_REQUIRED_TAGS: usize = 12;
const MAX_DEFENDERS: usize = 24;
const MAX_DELAY_MINUTES: i64 = 525_600;
const KNOWLEDGE_VISIBILITIES: [&str; 4] = ["public", "party", "specific_player", "gm_only"];

/// Отказ проверки конфигурации (`WorldOfficeValidationError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorldOfficeValidationError {
    pub code: String,
    pub message: String,
}

impl WorldOfficeValidationError {
    pub const NAME: &'static str = "WorldOfficeValidationError";

    fn new(message: impl Into<String>, code: &str) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

impl fmt::Display for WorldOfficeValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for WorldOfficeValidationError {}

type Checked<T> = Result<T, WorldOfficeValidationError>;

/// `text(value, 180)` — значение по умолчанию копии `text` этого модуля.
fn text180(value: Option<&Value>) -> String {
    text(value, 180)
}

fn valid_id(value: &str) -> bool {
    is_safe_id(value, 119)
}

/// `optionalId(value)`: безопасный id или пустая строка.
fn optional_id(value: Option<&Value>) -> String {
    let result = text(value, 120);
    if valid_id(&result) {
        result
    } else {
        String::new()
    }
}

fn id_or_null(id: String) -> Value {
    if id.is_empty() {
        Value::Null
    } else {
        string(id)
    }
}

/// `nonNegativeInteger(value, fallback)`: при небезопасном значении — сырой
/// запас через `Math.max(0, fallback)`.
fn non_negative(value: Option<&Value>, fallback: Option<&Value>) -> Value {
    match safe_integer(value) {
        Some(number) => json!(number.max(0)),
        None => f64_value(js_max(0.0, js::number(fallback))),
    }
}

fn non_negative0(value: Option<&Value>) -> Value {
    non_negative(value, Some(&json!(0)))
}

fn safe_knowledge_gate(value: Option<&Value>) -> Option<Value> {
    let gate = value.filter(|value| value.is_object())?;
    KNOWLEDGE_VISIBILITIES.contains(&text(get(Some(gate), "visibility"), 20).as_str()).then(|| gate.clone())
}

fn id_list(value: Option<&Value>, maximum: usize, label: &str, strict: bool) -> Checked<Vec<String>> {
    let items = match value {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(items)) => items,
        Some(_) => {
            if strict {
                return Err(WorldOfficeValidationError::new(format!("{label} должен быть массивом"), "WORLD_OFFICE_INVALID_SHAPE"));
            }
            return Ok(Vec::new());
        }
    };
    if strict && items.len() > maximum {
        return Err(WorldOfficeValidationError::new(format!("{label} должен содержать не более {maximum} записей"), "WORLD_OFFICE_LIMIT_EXCEEDED"));
    }
    let mut result: Vec<String> = Vec::new();
    let mut seen: IndexSet<String> = IndexSet::new();
    for raw in items.iter().take(maximum) {
        let candidate = text(Some(raw), 120);
        if candidate.is_empty() || !valid_id(&candidate) || seen.contains(&candidate) {
            if strict && !candidate.is_empty() && !valid_id(&candidate) {
                return Err(WorldOfficeValidationError::new(format!("{label} содержит некорректный id"), "WORLD_OFFICE_INVALID_ID"));
            }
            continue;
        }
        seen.insert(candidate.clone());
        result.push(candidate);
    }
    Ok(result)
}

fn assert_object<'a>(value: Option<&'a Value>, label: &str) -> Checked<&'a Map<String, Value>> {
    match value {
        Some(Value::Object(map)) => Ok(map),
        _ => Err(WorldOfficeValidationError::new(format!("{label} должен быть объектом"), "WORLD_OFFICE_INVALID_SHAPE")),
    }
}

fn assert_fields(map: &Map<String, Value>, allowed: &[&str], label: &str) -> Checked<()> {
    let unexpected: Vec<&str> = js::keys(map).into_iter().map(String::as_str).filter(|key| !allowed.contains(key)).collect();
    if unexpected.is_empty() {
        Ok(())
    } else {
        Err(WorldOfficeValidationError::new(format!("{label} содержит запрещённые поля: {}", unexpected.join(", ")), "WORLD_OFFICE_UNKNOWN_FIELD"))
    }
}

/// `knownIdSet(value)`: `null`/`undefined` — проверки нет; массив — набор;
/// прочее — пустой набор (всё неизвестно).
fn known_id_set(value: Option<&Value>) -> Option<IndexSet<String>> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::Array(items)) => Some(items.iter().map(|entry| text(Some(entry), 120)).filter(|entry| !entry.is_empty()).collect()),
        Some(_) => Some(IndexSet::new()),
    }
}

fn assert_known(id: &str, known: &Option<IndexSet<String>>, label: &str) -> Checked<()> {
    match known {
        Some(known) if !id.is_empty() && !known.contains(id) => Err(WorldOfficeValidationError::new(format!("{label} не найден"), "WORLD_OFFICE_REFERENCE_NOT_FOUND")),
        _ => Ok(()),
    }
}

/// Проверка authored/bootstrap-конфигурации одной должности
/// (`validateOfficeConfiguration`). `context` — `{ knownNpcIds,
/// knownFactionIds, allowCurrentSuccessor }`.
pub fn validate_office_configuration(input: Option<&Value>, context: &Value) -> Checked<Value> {
    let value = assert_object(input, "office")?;
    assert_fields(value, &["id", "title", "faction_id", "holder_npc_id", "visibility", "successor", "defender_npc_ids"], "office")?;
    let field = |key: &str| value.get(key);
    let office_id = text(field("id"), 120);
    if !valid_id(&office_id) {
        return Err(WorldOfficeValidationError::new("office.id должен быть безопасным идентификатором", "WORLD_OFFICE_INVALID_ID"));
    }
    let title = text180(field("title"));
    if title.is_empty() {
        return Err(WorldOfficeValidationError::new("У должности должно быть название", "WORLD_OFFICE_TITLE_REQUIRED"));
    }
    let faction_id = text(field("faction_id"), 120);
    if !valid_id(&faction_id) {
        return Err(WorldOfficeValidationError::new("office.faction_id должен быть безопасным идентификатором", "WORLD_OFFICE_INVALID_ID"));
    }
    let holder = if js::present(field("holder_npc_id")) { text(field("holder_npc_id"), 120) } else { String::new() };
    if !holder.is_empty() && !valid_id(&holder) {
        return Err(WorldOfficeValidationError::new("office.holder_npc_id должен быть безопасным идентификатором", "WORLD_OFFICE_INVALID_ID"));
    }
    let visibility = if js::present(field("visibility")) { text(field("visibility"), 20) } else { "party".into() };
    if visibility != "party" && visibility != "gm_only" {
        return Err(WorldOfficeValidationError::new("Видимость должности должна быть party или gm_only", "WORLD_OFFICE_VISIBILITY_INVALID"));
    }
    let context = Some(context);
    let known_npc_ids = known_id_set(get(context, "knownNpcIds"));
    let known_faction_ids = known_id_set(get(context, "knownFactionIds"));
    assert_known(&holder, &known_npc_ids, "office.holder_npc_id")?;
    assert_known(&faction_id, &known_faction_ids, "office.faction_id")?;

    let mut successor: Option<Value> = None;
    if js::present(field("successor")) {
        let raw = assert_object(field("successor"), "office.successor")?;
        assert_fields(raw, &["npc_id", "delay_minutes", "required_tags"], "office.successor")?;
        let successor_id = text(raw.get("npc_id"), 120);
        if !valid_id(&successor_id) {
            return Err(WorldOfficeValidationError::new("office.successor.npc_id должен быть безопасным идентификатором", "WORLD_OFFICE_INVALID_ID"));
        }
        if successor_id == holder && !js::is_true(get(context, "allowCurrentSuccessor")) {
            return Err(WorldOfficeValidationError::new("Преемник должности не может совпадать с её держателем", "WORLD_OFFICE_SUCCESSOR_INVALID"));
        }
        let delay = safe_integer(raw.get("delay_minutes")).filter(|delay| (1..=MAX_DELAY_MINUTES).contains(delay));
        let Some(delay) = delay else {
            return Err(WorldOfficeValidationError::new(format!("office.successor.delay_minutes должен быть от 1 до {MAX_DELAY_MINUTES}"), "WORLD_OFFICE_DELAY_INVALID"));
        };
        let required_tags = id_list(raw.get("required_tags"), MAX_REQUIRED_TAGS, "office.successor.required_tags", true)?;
        if known_npc_ids.as_ref().is_some_and(|known| !known.contains(&successor_id)) {
            return Err(WorldOfficeValidationError::new("office.successor.npc_id не найден", "WORLD_OFFICE_REFERENCE_NOT_FOUND"));
        }
        successor = Some(json!({ "npc_id": successor_id, "delay_minutes": delay, "required_tags": required_tags }));
    }
    let mut office = Map::new();
    office.insert("id".into(), string(office_id));
    office.insert("title".into(), string(title));
    office.insert("faction_id".into(), string(faction_id));
    office.insert("holder_npc_id".into(), id_or_null(holder));
    office.insert("visibility".into(), string(visibility));
    if let Some(successor) = successor {
        office.insert("successor".into(), successor);
    }
    office.insert("defender_npc_ids".into(), json!(id_list(field("defender_npc_ids"), MAX_DEFENDERS, "office.defender_npc_ids", true)?));
    Ok(Value::Object(office))
}

fn configuration_source<'a>(input: Option<&'a Value>, options: &'a Value) -> &'a [Value] {
    if let Some(Value::Array(items)) = get(Some(options), "offices") {
        return items;
    }
    if let Some(Value::Array(items)) = get(Some(options), "configuration") {
        return items;
    }
    array(get(input, "offices"))
}

/// Хвост записи с границей осведомлённости: прежний статус, прежний держатель
/// (если поле было) и сама граница.
fn knowledge_tail(map: &mut Map<String, Value>, raw: &Map<String, Value>) {
    let previous_status = text(raw.get("previous_status"), 20);
    if OFFICE_STATUSES.contains(&previous_status.as_str()) {
        map.insert("previous_status".into(), string(previous_status));
    }
    if raw.contains_key("previous_holder_npc_id") {
        map.insert("previous_holder_npc_id".into(), id_or_null(optional_id(raw.get("previous_holder_npc_id"))));
    }
    if let Some(gate) = safe_knowledge_gate(raw.get("knowledge_gate")) {
        map.insert("knowledge_gate".into(), gate);
    }
}

fn safe_pending(value: Option<&Value>) -> Value {
    let Some(Value::Object(raw)) = value else { return Value::Null };
    let succession_id = optional_id(raw.get("succession_id"));
    let candidate_id = optional_id(raw.get("candidate_npc_id"));
    if succession_id.is_empty() || !js::is_safe_integer_number(raw.get("due_at_minutes")) {
        return Value::Null;
    }
    let mut map = Map::new();
    map.insert("succession_id".into(), string(succession_id));
    map.insert("candidate_npc_id".into(), id_or_null(candidate_id));
    map.insert("due_at_minutes".into(), non_negative0(raw.get("due_at_minutes")));
    map.insert("vacated_at_minutes".into(), non_negative(raw.get("vacated_at_minutes"), raw.get("due_at_minutes")));
    map.insert("source_event_id".into(), string(optional_id(raw.get("source_event_id"))));
    knowledge_tail(&mut map, raw);
    Value::Object(map)
}

fn safe_history(value: Option<&Value>) -> Vec<Value> {
    let mut history: Vec<Value> = Vec::new();
    let mut seen: IndexSet<String> = IndexSet::new();
    for raw in array(value) {
        let Value::Object(raw) = raw else { continue };
        let succession_id = optional_id(raw.get("succession_id"));
        let outcome = text(raw.get("outcome"), 20);
        if succession_id.is_empty() || seen.contains(&succession_id) || !SUCCESSION_OUTCOMES.contains(&outcome.as_str()) {
            continue;
        }
        seen.insert(succession_id.clone());
        let mut map = Map::new();
        map.insert("succession_id".into(), string(succession_id));
        map.insert("outcome".into(), string(outcome));
        map.insert("reason".into(), string(text(raw.get("reason"), 60)));
        map.insert("candidate_npc_id".into(), id_or_null(optional_id(raw.get("candidate_npc_id"))));
        map.insert("at_minutes".into(), non_negative0(raw.get("at_minutes")));
        map.insert("source_event_id".into(), string(optional_id(raw.get("source_event_id"))));
        knowledge_tail(&mut map, raw);
        history.push(Value::Object(map));
    }
    let start = history.len().saturating_sub(MAX_SUCCESSION_HISTORY);
    history.split_off(start)
}

fn safe_office_state(raw: &Value, context: &Value) -> Option<Value> {
    let Value::Object(source) = raw else { return None };
    let mut config_source = spread(Some(raw));
    for key in ["status", "pending", "succession_history", "history", "vacated_at_minutes", "last_succession"] {
        config_source.shift_remove(key);
    }
    let mut validation_context = spread(Some(context));
    validation_context.insert("allowCurrentSuccessor".into(), Value::Bool(true));
    let config = validate_office_configuration(Some(&Value::Object(config_source)), &Value::Object(validation_context)).ok()?;
    let config_holder = js::s(config.get("holder_npc_id"));
    let status = text(source.get("status"), 20);
    let status = if OFFICE_STATUSES.contains(&status.as_str()) {
        status
    } else if !config_holder.is_empty() {
        "held".into()
    } else {
        "vacant".into()
    };
    let holder = if status == "vacant" {
        String::new()
    } else {
        let own = optional_id(source.get("holder_npc_id"));
        if own.is_empty() {
            config_holder
        } else {
            own
        }
    };
    let mut office = match config {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    office.insert("status".into(), string(if holder.is_empty() { "vacant" } else { "held" }));
    office.insert("holder_npc_id".into(), id_or_null(holder));
    office.insert("pending".into(), safe_pending(source.get("pending")));
    office.insert("succession_history".into(), Value::Array(safe_history(coalesce(source.get("succession_history"), source.get("history")))));
    Some(Value::Object(office))
}

/// Нормализованный реестр должностей (`normalizeWorldOfficesState`).
/// `options` — `{ offices, configuration, knownNpcIds, knownFactionIds }`.
pub fn normalize_world_offices_state(input: Option<&Value>, options: &Value) -> Value {
    let source = input.filter(|value| value.is_object());
    let mut context = Map::new();
    for key in ["knownNpcIds", "knownFactionIds"] {
        if let Some(value) = get(Some(options), key) {
            context.insert(key.into(), value.clone());
        }
    }
    let context = Value::Object(context);
    let mut offices: Vec<Value> = Vec::new();
    let mut seen: IndexSet<String> = IndexSet::new();
    for raw in configuration_source(source, options) {
        let Some(office) = safe_office_state(raw, &context) else { continue };
        if !seen.insert(js::s(office.get("id"))) {
            continue;
        }
        offices.push(office);
        if offices.len() >= MAX_OFFICES {
            break;
        }
    }
    json!({ "schema_version": WORLD_OFFICES_SCHEMA_VERSION, "offices": offices })
}

fn office_state_from(value: Option<&Value>, options: &Value) -> Value {
    match get(value, "world_offices") {
        Some(inner) if js::truthy(Some(inner)) && (inner.is_object() || inner.is_array()) => normalize_world_offices_state(Some(inner), options),
        _ => normalize_world_offices_state(value, options),
    }
}

fn offices_of(registry: &Value) -> &[Value] {
    array(registry.get("offices"))
}

fn world_minutes(state: &Value, options: &Value) -> i64 {
    let options = Some(options);
    let explicit = coalesce(coalesce(coalesce(get(options, "worldMinute"), get(options, "world_minute")), get(options, "atMinutes")), get(options, "at_minutes"));
    if js::present(explicit) {
        if let Some(minute) = safe_integer(explicit) {
            return minute.max(0);
        }
    }
    let current = js::safe_int(get(get(get(Some(state), "mechanics"), "world_time"), "elapsed_minutes"), 0).max(0);
    let elapsed = coalesce(get(options, "elapsedMinutes"), get(options, "elapsed_minutes"));
    if js::present(get(options, "elapsedMinutes")) || js::present(get(options, "elapsed_minutes")) {
        return current + js::safe_int(elapsed, 0).max(0);
    }
    current
}

fn event_identity(event: &Value) -> String {
    let event_id = optional_id(get(Some(event), "event_id"));
    if !event_id.is_empty() {
        return event_id;
    }
    optional_id(get(Some(event), "command_id"))
}

fn succession_id(office_id: &str, cause_event_id: &str, at_minutes: i64) -> String {
    format!("succession:{}", &hash::sha256_hex(format!("{office_id}\0{cause_event_id}\0{at_minutes}"))[..24])
}

fn office_knowledge_gate(state: &Value, event: &Value) -> Option<Value> {
    if !js::truthy(get(Some(state), "worldMemory")) && !js::truthy(get(get(Some(event), "payload"), "knowledge_gate")) && !js::truthy(get(Some(event), "visibility")) {
        return None;
    }
    safe_knowledge_gate(Some(&knowledge_gate_for_event(state, event)))
}

fn event_draft(office: &Value, event_type: &str, payload: Map<String, Value>) -> Value {
    let gate = safe_knowledge_gate(payload.get("knowledge_gate"));
    let mut event_payload = Map::new();
    event_payload.insert("schema_version".into(), json!(OFFICE_EVENT_SCHEMA_VERSION));
    event_payload.insert("policy_id".into(), string(WORLD_OFFICES_POLICY_ID));
    event_payload.insert("office_id".into(), office["id"].clone());
    event_payload.insert("title".into(), office["title"].clone());
    for (key, value) in payload {
        event_payload.insert(key, value);
    }
    match gate {
        Some(gate) => {
            event_payload.insert("knowledge_gate".into(), gate);
        }
        None => {
            event_payload.shift_remove("knowledge_gate");
        }
    }
    let visibility = if event_type == "OfficeSuccessionSkipped" { string("gm_only") } else { office["visibility"].clone() };
    json!({ "event_type": event_type, "payload": event_payload, "target_ids": [], "visibility": visibility })
}

fn death_ids(events: &[Value]) -> Vec<(String, &Value)> {
    let mut result = Vec::new();
    let mut seen: IndexSet<String> = IndexSet::new();
    for event in events {
        if !is_str(get(Some(event), "event_type"), "NpcDied") {
            continue;
        }
        let npc_id = optional_id(get(get(Some(event), "payload"), "npc_id"));
        if npc_id.is_empty() || !seen.insert(npc_id.clone()) {
            continue;
        }
        result.push((npc_id, event));
    }
    result
}

/// Освобождения должностей по подтверждённым `NpcDied` текущего коммита
/// (`planOfficeVacancyDrafts`). `options` — как у нормализации плюс минута
/// (`worldMinute`, `atMinutes`, `elapsedMinutes`).
pub fn plan_office_vacancy_drafts(state: &Value, events: &[Value], options: &Value) -> Vec<Value> {
    let registry = office_state_from(Some(state), options);
    let at_minutes = world_minutes(state, options);
    let mut drafts = Vec::new();
    let mut occupied: IndexSet<String> = IndexSet::new();
    for (npc_id, event) in death_ids(events) {
        for office in offices_of(&registry) {
            let office_id = js::s(office.get("id"));
            if !is_str(office.get("holder_npc_id"), &npc_id) || !is_str(office.get("status"), "held") || occupied.contains(&office_id) {
                continue;
            }
            occupied.insert(office_id.clone());
            let cause = event_identity(event);
            let id = succession_id(&office_id, &cause, at_minutes);
            let delay = js::safe_int(get(office.get("successor"), "delay_minutes"), 0);
            let mut payload = Map::new();
            payload.insert("status".into(), string("vacant"));
            payload.insert("holder_npc_id".into(), Value::Null);
            payload.insert("previous_holder_npc_id".into(), string(npc_id.clone()));
            payload.insert("succession_id".into(), string(id));
            payload.insert("vacated_at_minutes".into(), json!(at_minutes));
            payload.insert("due_at_minutes".into(), json!(at_minutes + delay));
            payload.insert("source_event_id".into(), string(cause));
            if let Some(gate) = office_knowledge_gate(state, event) {
                payload.insert("knowledge_gate".into(), gate);
            }
            drafts.push(event_draft(office, "OfficeVacated", payload));
        }
    }
    drafts
}

fn candidate_reason(state: &Value, candidate_id: &str, at_minutes: i64) -> (Option<Value>, &'static str) {
    let Some(profile) = array(get(get(Some(state), "social"), "npcs")).iter().find(|npc| js::s(get(Some(npc), "id")) == candidate_id) else {
        return (None, "candidate_missing");
    };
    if !js::truthy(npc_vital_for(state, &string(candidate_id)).get("alive")) {
        return (Some(profile.clone()), "candidate_dead");
    }
    let captive_held = array(coalesce(get(get(Some(state), "captives"), "captives"), None)).iter().any(|captive| {
        is_str(get(Some(captive), "status"), "held") && (is_str(get(Some(captive), "npc_id"), candidate_id) || is_str(get(Some(captive), "actor_id"), candidate_id))
    });
    if captive_held {
        return (Some(profile.clone()), "candidate_unavailable");
    }
    let mut state_at_time = spread(Some(state));
    fn object_like(value: Option<&Value>) -> Option<&Value> {
        value.filter(|value| value.is_object() || value.is_array())
    }
    let mechanics_source = object_like(get(Some(state), "mechanics"));
    let mut mechanics = spread(mechanics_source);
    let mut world_time = spread(object_like(get(mechanics_source, "world_time")));
    world_time.insert("elapsed_minutes".into(), json!(at_minutes));
    mechanics.insert("world_time".into(), Value::Object(world_time));
    state_at_time.insert("mechanics".into(), Value::Object(mechanics));
    let at_time = npc_profile_at_world_time(profile, &Value::Object(state_at_time));
    if js::is_false(at_time.get("available")) {
        return (Some(at_time), "candidate_unavailable");
    }
    (Some(at_time), "")
}

fn candidate_eligibility(state: &Value, office: &Value, at_minutes: i64) -> &'static str {
    let successor = office.get("successor");
    let candidate_id = js::s(get(successor, "npc_id"));
    if candidate_id.is_empty() {
        return "no_successor_configured";
    }
    let (profile, reason) = candidate_reason(state, &candidate_id, at_minutes);
    if !reason.is_empty() {
        return reason;
    }
    let profile = profile.unwrap_or(Value::Null);
    let faction_id = js::s(office.get("faction_id"));
    if !faction_ids_for_npc(Some(&profile)).contains(&faction_id) {
        return "candidate_wrong_faction";
    }
    let tags = array(profile.get("tags"));
    if array(get(successor, "required_tags")).iter().any(|tag| !tags.contains(tag)) {
        return "candidate_missing_tag";
    }
    ""
}

/// Ровно одна попытка преемства после срока (`planOfficeSuccessionDrafts`).
pub fn plan_office_succession_drafts(state: &Value, options: &Value) -> Vec<Value> {
    let registry = office_state_from(Some(state), options);
    let at_minutes = world_minutes(state, options);
    let mut drafts = Vec::new();
    for office in offices_of(&registry) {
        let Some(pending) = office.get("pending").filter(|pending| pending.is_object()) else { continue };
        if js::number(pending.get("due_at_minutes")) > at_minutes as f64 {
            continue;
        }
        let tail = |payload: &mut Map<String, Value>| {
            payload.insert("source_event_id".into(), pending["source_event_id"].clone());
            if let Some(gate) = pending.get("knowledge_gate").filter(|gate| js::truthy(Some(gate))) {
                payload.insert("knowledge_gate".into(), gate.clone());
            }
        };
        if !is_str(office.get("status"), "vacant") || js::truthy(office.get("holder_npc_id")) {
            let mut payload = Map::new();
            payload.insert("status".into(), office["status"].clone());
            payload.insert("holder_npc_id".into(), office["holder_npc_id"].clone());
            payload.insert("succession_id".into(), pending["succession_id"].clone());
            payload.insert("skipped_at_minutes".into(), json!(at_minutes));
            payload.insert("reason".into(), string("office_occupied"));
            tail(&mut payload);
            drafts.push(event_draft(office, "OfficeSuccessionSkipped", payload));
            continue;
        }
        let reason = candidate_eligibility(state, office, at_minutes);
        if !reason.is_empty() {
            let mut payload = Map::new();
            payload.insert("status".into(), string("vacant"));
            payload.insert("holder_npc_id".into(), Value::Null);
            payload.insert("succession_id".into(), pending["succession_id"].clone());
            payload.insert("skipped_at_minutes".into(), json!(at_minutes));
            payload.insert("reason".into(), string(if SKIP_REASONS.contains(&reason) { reason } else { "candidate_missing" }));
            tail(&mut payload);
            drafts.push(event_draft(office, "OfficeSuccessionSkipped", payload));
            continue;
        }
        let mut payload = Map::new();
        payload.insert("status".into(), string("held"));
        payload.insert("holder_npc_id".into(), office["successor"]["npc_id"].clone());
        payload.insert("previous_holder_npc_id".into(), Value::Null);
        payload.insert("succession_id".into(), pending["succession_id"].clone());
        payload.insert("installed_at_minutes".into(), json!(at_minutes));
        tail(&mut payload);
        drafts.push(event_draft(office, "OfficeHolderInstalled", payload));
    }
    drafts
}

fn history_has(office: &Value, succession: &str) -> bool {
    array(office.get("succession_history")).iter().any(|entry| is_str(entry.get("succession_id"), succession))
}

fn with_history(office: &Value, entry: Map<String, Value>) -> Value {
    let succession = js::s(entry.get("succession_id"));
    let history = array(office.get("succession_history")).to_vec();
    if succession.is_empty() || history_has(office, &succession) {
        return Value::Array(history);
    }
    let mut history = history;
    history.push(Value::Object(entry));
    let start = history.len().saturating_sub(MAX_SUCCESSION_HISTORY);
    Value::Array(history.split_off(start))
}

fn schema_number(event: &Value) -> f64 {
    js::number(get(get(Some(event), "payload"), "schema_version"))
}

fn event_schema_is_supported(event: &Value) -> bool {
    let event_type = js::s(get(Some(event), "event_type"));
    let schema = schema_number(event);
    WORLD_OFFICE_EVENT_TYPES.contains(&event_type.as_str()) && (schema == OFFICE_EVENT_LEGACY_SCHEMA_VERSION as f64 || schema == OFFICE_EVENT_SCHEMA_VERSION as f64)
}

fn event_uses_knowledge(event: &Value) -> bool {
    schema_number(event) == OFFICE_EVENT_SCHEMA_VERSION as f64 && safe_knowledge_gate(get(get(Some(event), "payload"), "knowledge_gate")).is_some()
}

fn pending_knowledge_gate(event: &Value, pending: Option<&Value>) -> Option<Value> {
    if schema_number(event) != OFFICE_EVENT_SCHEMA_VERSION as f64 {
        return None;
    }
    match coalesce(get(pending, "knowledge_gate"), None) {
        Some(gate) => Some(gate.clone()),
        None => safe_knowledge_gate(get(get(Some(event), "payload"), "knowledge_gate")),
    }
}

/// Хвост записи истории с границей осведомлённости из отложенной попытки.
fn history_knowledge(entry: &mut Map<String, Value>, pending: Option<&Value>, gate: Option<Value>) {
    let Some(gate) = gate.filter(|gate| js::truthy(Some(gate))) else { return };
    let previous_status = get(pending, "previous_status").filter(|status| js::truthy(Some(status))).cloned().unwrap_or_else(|| string("held"));
    entry.insert("previous_status".into(), previous_status);
    let previous_holder = match pending {
        Some(Value::Object(map)) if map.contains_key("previous_holder_npc_id") => map["previous_holder_npc_id"].clone(),
        _ => Value::Null,
    };
    entry.insert("previous_holder_npc_id".into(), previous_holder);
    entry.insert("knowledge_gate".into(), gate);
}

/// Редьюсер должностей (`applyWorldOfficeEvent`): применяет только валидные
/// события и всегда возвращает новый реестр.
pub fn apply_world_office_event(input: Option<&Value>, event: &Value, options: &Value) -> Value {
    let current = office_state_from(input, options);
    if !event_schema_is_supported(event) {
        return current;
    }
    let empty = json!({});
    let payload = Some(coalesce(get(Some(event), "payload"), None).unwrap_or(&empty));
    let office_id = optional_id(get(payload, "office_id"));
    if office_id.is_empty() {
        return current;
    }
    let offices = offices_of(&current);
    let Some(index) = offices.iter().position(|office| is_str(office.get("id"), &office_id)) else { return current };
    let office = &offices[index];
    let succession = optional_id(get(payload, "succession_id"));
    if succession.is_empty() {
        return current;
    }
    let pending = office.get("pending").filter(|pending| pending.is_object());
    let pending_is = |id: &str| is_str(get(pending, "succession_id"), id);
    let held_with_holder = is_str(office.get("status"), "held") && js::truthy(office.get("holder_npc_id"));
    let mut next = spread(Some(office));
    match js::s(get(Some(event), "event_type")).as_str() {
        "OfficeVacated" => {
            let previous_holder = optional_id(get(payload, "previous_holder_npc_id"));
            if !held_with_holder || !is_str(office.get("holder_npc_id"), &previous_holder) {
                return current;
            }
            if pending_is(&succession) || history_has(office, &succession) {
                return current;
            }
            let due = non_negative(get(payload, "due_at_minutes"), Some(&non_negative0(get(payload, "vacated_at_minutes"))));
            let gate = safe_knowledge_gate(get(payload, "knowledge_gate"));
            let mut new_pending = Map::new();
            new_pending.insert("succession_id".into(), string(succession));
            new_pending.insert("candidate_npc_id".into(), coalesce(get(office.get("successor"), "npc_id"), None).cloned().unwrap_or(Value::Null));
            new_pending.insert("due_at_minutes".into(), due.clone());
            new_pending.insert("vacated_at_minutes".into(), non_negative(get(payload, "vacated_at_minutes"), Some(&due)));
            new_pending.insert("source_event_id".into(), string(optional_id(get(payload, "source_event_id"))));
            if let Some(gate) = gate.filter(|_| event_uses_knowledge(event)) {
                new_pending.insert("previous_status".into(), office["status"].clone());
                new_pending.insert("previous_holder_npc_id".into(), office["holder_npc_id"].clone());
                new_pending.insert("knowledge_gate".into(), gate);
            }
            next.insert("status".into(), string("vacant"));
            next.insert("holder_npc_id".into(), Value::Null);
            next.insert("pending".into(), Value::Object(new_pending));
        }
        "OfficeHolderInstalled" => {
            let holder = optional_id(get(payload, "holder_npc_id"));
            if holder.is_empty() || !is_str(get(office.get("successor"), "npc_id"), &holder) || !pending_is(&succession) {
                return current;
            }
            if !is_str(office.get("status"), "vacant") || js::truthy(office.get("holder_npc_id")) {
                return current;
            }
            let gate = pending_knowledge_gate(event, pending);
            let mut entry = Map::new();
            entry.insert("succession_id".into(), string(succession));
            entry.insert("outcome".into(), string("installed"));
            entry.insert("reason".into(), string("successor_installed"));
            entry.insert("candidate_npc_id".into(), string(holder.clone()));
            entry.insert("at_minutes".into(), non_negative0(get(payload, "installed_at_minutes")));
            entry.insert("source_event_id".into(), string(optional_id(get(payload, "source_event_id"))));
            history_knowledge(&mut entry, pending, gate);
            next.insert("status".into(), string("held"));
            next.insert("holder_npc_id".into(), string(holder));
            next.insert("pending".into(), Value::Null);
            next.insert("succession_history".into(), with_history(office, entry));
        }
        "OfficeSuccessionSkipped" => {
            if !pending_is(&succession) {
                return current;
            }
            let reason = text(get(payload, "reason"), 60);
            let reason = if SKIP_REASONS.contains(&reason.as_str()) { reason } else { "candidate_missing".into() };
            let gate = pending_knowledge_gate(event, pending);
            let mut entry = Map::new();
            entry.insert("succession_id".into(), string(succession));
            entry.insert("outcome".into(), string("skipped"));
            entry.insert("reason".into(), string(reason));
            entry.insert("candidate_npc_id".into(), coalesce(get(office.get("successor"), "npc_id"), None).cloned().unwrap_or(Value::Null));
            entry.insert("at_minutes".into(), non_negative0(get(payload, "skipped_at_minutes")));
            entry.insert("source_event_id".into(), string(optional_id(get(payload, "source_event_id"))));
            history_knowledge(&mut entry, pending, gate);
            next.insert("status".into(), string(if held_with_holder { "held" } else { "vacant" }));
            next.insert("holder_npc_id".into(), if held_with_holder { office["holder_npc_id"].clone() } else { Value::Null });
            next.insert("pending".into(), Value::Null);
            next.insert("succession_history".into(), with_history(office, entry));
        }
        _ => return current,
    }
    let mut result = offices.to_vec();
    result[index] = Value::Object(next);
    json!({ "schema_version": WORLD_OFFICES_SCHEMA_VERSION, "offices": result })
}

fn office_viewer(input: Option<&Value>, options: &Value) -> Value {
    let state = match get(input, "world_offices") {
        Some(inner) if js::truthy(Some(inner)) && (inner.is_object() || inner.is_array()) => input.cloned().unwrap_or_else(|| json!({})),
        _ => json!({}),
    };
    let options_ref = Some(options);
    let memory = coalesce(coalesce(get(options_ref, "memory"), get(Some(&state), "worldMemory")), None).cloned().unwrap_or_else(|| json!({}));
    let is_admin = js::is_true(get(options_ref, "isAdmin")) || is_str(get(options_ref, "role"), "admin");
    let mut viewer = spread(options_ref);
    let role = get(options_ref, "role").filter(|role| js::truthy(Some(role))).cloned().unwrap_or_else(|| string(if js::is_true(get(options_ref, "isAdmin")) { "admin" } else { "player" }));
    viewer.insert("role".into(), role);
    viewer.insert("playerId".into(), string(js::s(get(options_ref, "playerId"))));
    viewer.insert("isPartyMember".into(), Value::Bool(!js::is_false(get(options_ref, "isPartyMember"))));
    viewer.insert("isAdmin".into(), Value::Bool(is_admin));
    viewer.insert("memory".into(), memory);
    Value::Object(viewer)
}

fn gate_visible(gate: &Value, viewer: &Value) -> bool {
    knowledge_gate_visible(Some(gate), viewer.get("memory").unwrap_or(&Value::Null), viewer)
}

fn previous_holder(entry: &Value) -> Value {
    match entry {
        Value::Object(map) if map.contains_key("previous_holder_npc_id") => map["previous_holder_npc_id"].clone(),
        _ => Value::Null,
    }
}

fn projected_office_status(office: &Value, viewer: &Value) -> (Value, Value) {
    let mut status = office["status"].clone();
    let mut holder = office["holder_npc_id"].clone();
    let pending = office.get("pending").filter(|pending| js::truthy(Some(pending)));
    let pending_gate = pending.and_then(|pending| pending.get("knowledge_gate")).filter(|gate| js::truthy(Some(gate)));
    match (pending, pending_gate) {
        (Some(pending), Some(gate)) if !gate_visible(gate, viewer) => {
            if js::truthy(pending.get("previous_status")) {
                status = pending["previous_status"].clone();
                holder = previous_holder(pending);
            }
        }
        (Some(_), _) => return (status, holder),
        _ => {}
    }
    for entry in array(office.get("succession_history")).iter().rev() {
        let gate = entry.get("knowledge_gate").filter(|gate| js::truthy(Some(gate)));
        match gate {
            None => break,
            Some(gate) if gate_visible(gate, viewer) => break,
            Some(_) => {}
        }
        if !js::truthy(entry.get("previous_status")) {
            continue;
        }
        status = entry["previous_status"].clone();
        holder = previous_holder(entry);
    }
    (status, holder)
}

/// Игровая проекция должностей (`officesForViewer`): без преемника,
/// защитников, отложенных попыток, истории и причин пропуска.
pub fn offices_for_viewer(input: Option<&Value>, options: &Value) -> Vec<Value> {
    let registry = office_state_from(input, options);
    let viewer = office_viewer(input, options);
    let is_admin = js::is_true(viewer.get("isAdmin"));
    let is_party_member = js::is_true(viewer.get("isPartyMember"));
    offices_of(&registry)
        .iter()
        .filter(|office| is_admin || (is_str(office.get("visibility"), "party") && is_party_member))
        .map(|office| {
            // Замечено в JS: ведущему отдаётся сама запись (`projected = office`),
            // а читается `projected.holder` — у записи такого поля нет, и
            // `holder_npc_id` ведущему не приходит вовсе. Перенесено как есть.
            if is_admin {
                return json!({ "office_id": office["id"], "title": office["title"], "status": office["status"] });
            }
            let (status, holder) = projected_office_status(office, &viewer);
            json!({ "office_id": office["id"], "title": office["title"], "status": status, "holder_npc_id": holder })
        })
        .collect()
}

/// Короткая строка журнала (`officeChronicleEntry`) без имён кандидатов,
/// причин и задержек.
pub fn office_chronicle_entry(event: &Value, options: &Value) -> Option<Value> {
    let event_type = js::s(get(Some(event), "event_type"));
    if !WORLD_OFFICE_EVENT_TYPES.contains(&event_type.as_str()) {
        return None;
    }
    if is_str(get(Some(event), "visibility"), "gm_only") && !js::is_true(get(Some(options), "isAdmin")) {
        return None;
    }
    let empty = json!({});
    let payload = Some(coalesce(get(Some(event), "payload"), None).unwrap_or(&empty));
    let office_id = optional_id(get(payload, "office_id"));
    let title = text180(get(payload, "title"));
    if office_id.is_empty() {
        return None;
    }
    let status = match event_type.as_str() {
        "OfficeHolderInstalled" => "held".to_string(),
        "OfficeVacated" => "vacant".to_string(),
        _ => {
            let status = text(get(payload, "status"), 20);
            if status.is_empty() {
                "vacant".into()
            } else {
                status
            }
        }
    };
    let name = if title.is_empty() { office_id.clone() } else { title };
    let line = if status == "held" { format!("Должность «{name}» получила нового держателя.") } else { format!("Должность «{name}» остаётся вакантной.") };
    let event_ref = Some(event);
    let suffix = [get(event_ref, "event_id"), get(event_ref, "command_id")]
        .into_iter()
        .find(|value| js::truthy(*value))
        .map_or_else(|| office_id.clone(), |value| js::s(value));
    let mut entry = Map::new();
    entry.insert("id".into(), string(format!("office:{event_type}:{suffix}")));
    entry.insert("speaker".into(), string("narrator"));
    entry.insert("author".into(), string("Летопись мира"));
    entry.insert("text".into(), string(line));
    entry.insert("turnConsumed".into(), Value::Bool(false));
    if let Some(gate) = safe_knowledge_gate(get(payload, "knowledge_gate")) {
        entry.insert("knowledge_gate".into(), gate);
    }
    Some(Value::Object(entry))
}

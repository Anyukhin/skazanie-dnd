//! Аргументы и метаданные перехода сцены, план торговли сцены, ссылка на
//! решение группы и поля жизненного цикла торговцев. Задача Р4б.
//!
//! JS: `server/rules-engine.mjs`, 84, 979–1010, 1217–1379
//! (`normalizeSceneAdvanceArgs`, `privateAdventureBuckets`,
//! `canonicalSceneMetadata`, `normalizeSceneCommerce`,
//! `normalizePartyDecisionReference`, `lifecycleObject`,
//! `assertLifecycleKeys`, `lifecycleId`, `lifecycleText`, `lifecycleInteger`,
//! `lifecyclePurseCp`). Читают их проверка и разбор `AdvanceScene` (Р6) и
//! жизненный цикл торговцев; отказ — `RulesValidationError` с кодом JS.
//!
//! Расстановка отряда на входе сцены (12206–12283) — `scene/placement.rs`.

use serde_json::{Map, Value};
use sk_core::js;
use sk_core::re;
use sk_core::text as jstext;
use sk_core::RuleError;

use crate::core::{len_utf16, slice_utf16};

/// `DOOR_BARRICADE_EVENT_SCHEMA_VERSION` (84).
pub const DOOR_BARRICADE_EVENT_SCHEMA_VERSION: i64 = 1;

/// `SCENE_ADVANCE_FIELDS` (979).
pub const SCENE_ADVANCE_FIELDS: [&str; 21] = [
    "title", "location", "location_id", "mood", "objective", "transition", "arrival", "hook", "theme", "danger", "seed",
    "completed_objective", "objective_status", "outcome", "carry_unresolved", "map", "levels", "scene_kind", "settlement_type",
    "scene_summary", "secrets",
];

fn scene_advance_field(key: &str) -> bool {
    SCENE_ADVANCE_FIELDS.contains(&key)
}

/// `SCENE_MAP_FIELDS`.
pub const SCENE_MAP_FIELDS: [&str; 9] = ["layout", "scale", "pattern", "material", "width", "height", "openness", "water", "featureCount"];
/// `SCENE_MAP_LAYOUTS`.
pub const SCENE_MAP_LAYOUTS: [&str; 7] = ["rooms", "streets", "open", "winding", "cavern", "ruins", "radial"];
/// `SCENE_MAP_SCALES`.
pub const SCENE_MAP_SCALES: [&str; 4] = ["room", "site", "stronghold", "region"];
/// `SCENE_MAP_PATTERNS`.
pub const SCENE_MAP_PATTERNS: [&str; 9] = ["small-room", "great-hall", "keep", "courtyard", "crypt", "cave-cluster", "village", "bridge", "natural"];
/// `SCENE_MAP_MATERIALS`.
pub const SCENE_MAP_MATERIALS: [&str; 8] = ["stone", "wood", "earth", "grass", "sand", "metal", "marble", "ice"];
/// `SCENE_KINDS`.
pub const SCENE_KINDS: [&str; 5] = ["settlement", "wilderness", "dungeon", "road", "other"];
/// `SCENE_SETTLEMENT_TYPES`.
pub const SCENE_SETTLEMENT_TYPES: [&str; 5] = ["village", "town", "city", "outpost", "traveling"];
/// `SCENE_DANGER_LEVELS`.
pub const SCENE_DANGER_LEVELS: [&str; 3] = ["низкая", "средняя", "высокая"];
/// `SCENE_COMMERCE_FIELDS`.
pub const SCENE_COMMERCE_FIELDS: [&str; 8] = ["version", "action", "settlement_type", "theme", "budget_cp", "reason", "outcome", "merchant_id"];
/// `SCENE_COMMERCE_ACTIONS`.
pub const SCENE_COMMERCE_ACTIONS: [&str; 2] = ["create", "none"];
/// `SCENE_COMMERCE_THEMES`.
pub const SCENE_COMMERCE_THEMES: [&str; 4] = ["general", "provisions", "arms", "healing"];
/// `SCENE_COMMERCE_OUTCOMES`.
pub const SCENE_COMMERCE_OUTCOMES: [&str; 3] = ["created", "reused", "not-requested"];
/// `SCENE_COMMERCE_PLAN_VERSION`.
pub const SCENE_COMMERCE_PLAN_VERSION: &str = "skazanie:scene-commerce-plan-v1";
/// `PARTY_DECISION_REFERENCE_FIELDS`.
pub const PARTY_DECISION_REFERENCE_FIELDS: [&str; 2] = ["interaction_id", "resolved_option_id"];

/// Скрытые поля приключения (`privateAdventureBuckets`).
pub const PRIVATE_ADVENTURE_FIELDS: [&str; 18] = [
    "hidden_information", "hiddenInformation", "gm_only", "gmOnly", "gm_notes", "gmNotes", "npc_private", "npcPrivate", "private_notes", "privateNotes",
    "specific_player", "specificPlayer", "party", "secret", "secrets", "unrevealed", "true_state", "trueState",
];

fn reject(message: impl Into<String>, code: &str) -> RuleError {
    RuleError::new(code, message)
}

/// `SET.has(value)` для строкового множества: не строка — нет.
fn in_set(set: &[&str], value: Option<&Value>) -> bool {
    matches!(value, Some(Value::String(text)) if set.contains(&text.as_str()))
}

/// `normalizeSceneAdvanceArgs(value)` (1217): белый список полей перехода
/// сцены и проверка карты, темы, места, опасности и вида сцены.
pub fn normalize_scene_advance_args(value: Option<&Value>) -> Result<Value, RuleError> {
    let Some(Value::Object(source)) = value else {
        return Err(reject("Параметры перехода сцены должны быть объектом", "INVALID_SCENE_ADVANCE_ARGS"));
    };
    let mut args: Map<String, Value> = js::entries(source).into_iter().filter(|(key, _)| scene_advance_field(key)).map(|(key, item)| (key.clone(), item.clone())).collect();
    if let Some(map) = args.get("map") {
        let Value::Object(map) = map else {
            return Err(reject("Параметры карты новой сцены должны быть объектом", "INVALID_SCENE_MAP_ARGS"));
        };
        let filtered: Map<String, Value> = js::entries(map).into_iter().filter(|(key, _)| SCENE_MAP_FIELDS.contains(&key.as_str())).map(|(key, item)| (key.clone(), item.clone())).collect();
        for (field, set, message, code) in [
            ("layout", &SCENE_MAP_LAYOUTS[..], "Неизвестная планировка карты", "INVALID_SCENE_MAP_LAYOUT"),
            ("scale", &SCENE_MAP_SCALES[..], "Неизвестный масштаб карты", "INVALID_SCENE_MAP_SCALE"),
            ("pattern", &SCENE_MAP_PATTERNS[..], "Неизвестный формат карты", "INVALID_SCENE_MAP_PATTERN"),
            ("material", &SCENE_MAP_MATERIALS[..], "Неизвестный материал карты", "INVALID_SCENE_MAP_MATERIAL"),
        ] {
            if js::present(filtered.get(field)) && !in_set(set, filtered.get(field)) {
                return Err(reject(message, code));
            }
        }
        args.insert("map".into(), Value::Object(filtered));
    }
    if args.get("theme").is_some_and(|theme| !theme.is_string()) {
        return Err(reject("Тема новой сцены должна быть строкой", "INVALID_SCENE_THEME"));
    }
    if let Some(location) = args.get("location_id") {
        let valid = matches!(location, Value::String(text) if !jstext::trim(text).is_empty() && len_utf16(text) <= 120);
        if !valid {
            return Err(reject("location_id новой сцены должен быть непустой строкой длиной до 120 символов", "INVALID_SCENE_LOCATION_ID"));
        }
    }
    if args.contains_key("danger") && !in_set(&SCENE_DANGER_LEVELS, args.get("danger")) {
        return Err(reject("Неизвестный уровень опасности новой сцены", "INVALID_SCENE_DANGER"));
    }
    if args.contains_key("scene_kind") && !in_set(&SCENE_KINDS, args.get("scene_kind")) {
        return Err(reject("Неизвестный тип новой сцены", "INVALID_SCENE_KIND"));
    }
    if js::present(args.get("settlement_type")) && !in_set(&SCENE_SETTLEMENT_TYPES, args.get("settlement_type")) {
        return Err(reject("Неизвестный тип поселения новой сцены", "INVALID_SCENE_SETTLEMENT_TYPE"));
    }
    let settlement = js::truthy(args.get("settlement_type"));
    let scene_kind = match args.get("scene_kind").filter(|kind| !kind.is_null()) {
        Some(kind) => kind.clone(),
        None => Value::String(if settlement { "settlement" } else { "other" }.into()),
    };
    if settlement && scene_kind.as_str() != Some("settlement") {
        return Err(reject("Тип поселения допустим только для сцены-поселения", "INVALID_SCENE_SETTLEMENT_TYPE"));
    }
    args.insert("scene_kind".into(), scene_kind);
    let settlement_type = args.get("settlement_type").filter(|kind| !kind.is_null()).cloned().unwrap_or(Value::Null);
    args.insert("settlement_type".into(), settlement_type);
    Ok(Value::Object(args))
}

/// `privateAdventureBuckets(value)` (1256): скрытые поля приключения как есть.
pub fn private_adventure_buckets(value: Option<&Value>) -> Map<String, Value> {
    let Some(Value::Object(source)) = value else { return Map::new() };
    let mut buckets = Map::new();
    for key in PRIVATE_ADVENTURE_FIELDS.iter() {
        if let Some(field) = source.get(*key) {
            buckets.insert((*key).into(), field.clone());
        }
    }
    buckets
}

/// `a || b || c` по истинности JS.
fn first_truthy<'a>(values: &[Option<&'a Value>]) -> Option<&'a Value> {
    values.iter().copied().find(|value| js::truthy(*value)).flatten()
}

/// `canonicalSceneMetadata(args, transition)` (1270).
pub fn canonical_scene_metadata(args: &Value, transition: Option<&Value>) -> Value {
    let scene = transition.and_then(|transition| transition.get("scene"));
    let fallback = match first_truthy(&[scene.and_then(|scene| scene.get("location")), scene.and_then(|scene| scene.get("title"))]) {
        Some(value) => js::s(Some(value)),
        None => "новая сцена".to_string(),
    };
    let raw = match first_truthy(&[args.get("theme")]) {
        Some(theme) => js::s(Some(theme)),
        None => fallback.clone(),
    };
    let squashed = slice_utf16(&jstext::squash_spaces(&raw), 80);
    let theme = if squashed.is_empty() { slice_utf16(&fallback, 80) } else { squashed };
    let mut metadata = Map::new();
    metadata.insert("theme".into(), Value::String(theme));
    let danger = if in_set(&SCENE_DANGER_LEVELS, args.get("danger")) { args.get("danger").cloned().unwrap_or(Value::Null) } else { Value::String("средняя".into()) };
    metadata.insert("danger".into(), danger);
    for key in ["scene_kind", "settlement_type"] {
        if let Some(value) = args.get(key) {
            metadata.insert(key.into(), value.clone());
        }
    }
    Value::Object(metadata)
}

/// `normalizeSceneCommerce(value)` (1281): план торговли новой сцены по
/// серверному контракту; `null` — плана нет.
pub fn normalize_scene_commerce(value: Option<&Value>) -> Result<Value, RuleError> {
    let invalid = |message: &str| reject(message, "INVALID_SCENE_COMMERCE");
    let Some(value) = value.filter(|value| !value.is_null()) else { return Ok(Value::Null) };
    let Value::Object(fields) = value else { return Err(invalid("План торговли новой сцены содержит недопустимые поля")) };
    if fields.keys().any(|key| !SCENE_COMMERCE_FIELDS.contains(&key.as_str())) {
        return Err(invalid("План торговли новой сцены содержит недопустимые поля"));
    }
    if fields.get("version").and_then(Value::as_str) != Some(SCENE_COMMERCE_PLAN_VERSION)
        || !in_set(&SCENE_COMMERCE_ACTIONS, fields.get("action"))
        || !in_set(&SCENE_SETTLEMENT_TYPES, fields.get("settlement_type"))
        || !in_set(&SCENE_COMMERCE_THEMES, fields.get("theme"))
        || !in_set(&SCENE_COMMERCE_OUTCOMES, fields.get("outcome"))
    {
        return Err(invalid("План торговли новой сцены не соответствует серверному контракту"));
    }
    let budget = fields.get("budget_cp");
    if !js::is_safe_integer(budget) || js::number(budget) < 100.0 || js::number(budget) > 1_000_000.0 {
        return Err(invalid("Бюджет торговли новой сцены выходит за разрешённые границы"));
    }
    let reason = match fields.get("reason") {
        Some(Value::String(text)) => slice_utf16(&jstext::squash_spaces(&jstext::nfkc(text)), 240),
        _ => String::new(),
    };
    if reason.is_empty() {
        return Err(invalid("План торговли новой сцены должен содержать причину"));
    }
    let merchant_id = match fields.get("merchant_id") {
        None | Some(Value::Null) => None,
        some => Some(lifecycle_id(some, "INVALID_SCENE_COMMERCE", "merchant_id")?),
    };
    let reused = fields.get("outcome").and_then(Value::as_str) == Some("reused");
    if reused && merchant_id.is_none() {
        return Err(invalid("Повторно используемый торговец должен иметь merchant_id"));
    }
    if !reused && merchant_id.is_some() {
        return Err(invalid("merchant_id допустим только при повторном использовании торговца"));
    }
    let mut plan = Map::new();
    plan.insert("version".into(), Value::String(SCENE_COMMERCE_PLAN_VERSION.into()));
    for key in ["action", "settlement_type", "theme", "budget_cp"] {
        plan.insert(key.into(), fields.get(key).cloned().unwrap_or(Value::Null));
    }
    plan.insert("reason".into(), Value::String(reason));
    plan.insert("outcome".into(), fields.get("outcome").cloned().unwrap_or(Value::Null));
    plan.insert("merchant_id".into(), merchant_id.map(Value::String).unwrap_or(Value::Null));
    Ok(Value::Object(plan))
}

/// `normalizePartyDecisionReference(value, { required })` (1320).
pub fn normalize_party_decision_reference(value: Option<&Value>, required: bool) -> Result<Value, RuleError> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        if required {
            return Err(reject("Director должен связать переход с решением группы", "PARTY_DECISION_REQUIRED"));
        }
        return Ok(Value::Null);
    };
    let code = "INVALID_PARTY_DECISION_REFERENCE";
    let Value::Object(fields) = value else { return Err(reject("Ссылка на решение группы содержит недопустимые поля", code)) };
    if fields.keys().any(|key| !PARTY_DECISION_REFERENCE_FIELDS.contains(&key.as_str())) {
        return Err(reject("Ссылка на решение группы содержит недопустимые поля", code));
    }
    let interaction = lifecycle_id(fields.get("interaction_id"), code, "interaction_id")?;
    let option = lifecycle_id(fields.get("resolved_option_id"), code, "resolved_option_id")?;
    let mut reference = Map::new();
    reference.insert("interaction_id".into(), Value::String(interaction));
    reference.insert("resolved_option_id".into(), Value::String(option));
    Ok(Value::Object(reference))
}

/// `lifecycleObject(value, code, label)` (1334).
pub fn lifecycle_object<'a>(value: Option<&'a Value>, code: &str, label: &str) -> Result<&'a Map<String, Value>, RuleError> {
    match value {
        Some(Value::Object(fields)) => Ok(fields),
        _ => Err(reject(format!("{label} должен быть объектом"), code)),
    }
}

/// `assertLifecycleKeys(source, allowed, code, label)` (1341).
pub fn assert_lifecycle_keys(source: &Map<String, Value>, allowed: &[&str], code: &str, label: &str) -> Result<(), RuleError> {
    let unexpected: Vec<&str> = js::keys(source).into_iter().map(String::as_str).filter(|key| !allowed.contains(key)).collect();
    if unexpected.is_empty() {
        Ok(())
    } else {
        Err(reject(format!("{label}: недопустимые поля {}", unexpected.join(", ")), code))
    }
}

/// `lifecycleId(value, code, label)` (1346): безопасный идентификатор.
pub fn lifecycle_id(value: Option<&Value>, code: &str, label: &str) -> Result<String, RuleError> {
    let result = match value {
        Some(Value::String(text)) => jstext::trim(text).to_string(),
        _ => String::new(),
    };
    if !jstext::test(re!(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$", "u"), &result) {
        return Err(reject(format!("{label} должен быть безопасным идентификатором"), code));
    }
    Ok(result)
}

/// `lifecycleText(value, maximum, { required, fallback, code, label })` (1354).
pub fn lifecycle_text(value: Option<&Value>, maximum: usize, required: bool, fallback: &str, code: &str, label: &str) -> Result<String, RuleError> {
    let value = match value {
        None | Some(Value::Null) => {
            if required {
                return Err(reject(format!("{label} обязательно"), code));
            }
            return Ok(fallback.to_string());
        }
        Some(value) => value,
    };
    let Value::String(text) = value else { return Err(reject(format!("{label} должно быть строкой"), code)) };
    let result = slice_utf16(jstext::trim(text), maximum);
    if required && result.is_empty() {
        return Err(reject(format!("{label} обязательно"), code));
    }
    Ok(result)
}

/// `lifecycleInteger(value, minimum, maximum, fallback, code, label)` (1365).
pub fn lifecycle_integer(value: Option<&Value>, minimum: i64, maximum: i64, fallback: Value, code: &str, label: &str) -> Result<Value, RuleError> {
    if !js::present(value) {
        return Ok(fallback);
    }
    if !js::is_safe_integer_number(value) {
        return Err(reject(format!("{label} должно быть целым числом"), code));
    }
    Ok(js::num(js::number(value).min(maximum as f64).max(minimum as f64)))
}

/// `lifecyclePurseCp(value, fallback = DEFAULT_MERCHANT_PURSE_CP)` (1372).
pub fn lifecycle_purse_cp(value: Option<&Value>, fallback: Option<Value>) -> Result<Value, RuleError> {
    if !js::present(value) {
        return Ok(fallback.unwrap_or_else(|| Value::from(sk_economy::merchant_economy::DEFAULT_MERCHANT_PURSE_CP)));
    }
    let number = js::number(value);
    if !matches!(value, Some(Value::Number(_))) || !js::is_safe_integer(value) || number < 0.0 || number > sk_economy::merchant_economy::MAX_CURRENCY_CP as f64 {
        return Err(reject("Кошелёк торговца должен быть целым числом CP в допустимых пределах", "INVALID_MERCHANT_PURSE"));
    }
    Ok(value.cloned().unwrap_or(Value::Null))
}

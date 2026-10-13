//! Перенос `server/campaign-ruleset.mjs`: смена редакции кампании до первого
//! игрового события и переключение домашних правил идущей кампании — оба
//! только событиями (`CampaignRulesetChanged`, `CampaignHouseRuleChanged`),
//! чтобы replay прошлого не менялся.

use std::fmt;

use serde_json::{json, Map, Value};
use sk_core::js;

use crate::ruleset_config::{
    public_ruleset_profiles, ruleset_lock, ruleset_profile, ProfileOptions, RulesetSelectionError, TOGGLEABLE_HOUSE_RULES,
};
use crate::support::{array, defined, path, prop, spread_items, str_array, string_of, unique_strings};

const RULESET_EVENT_TYPE: &str = "CampaignRulesetChanged";
const HOUSE_RULE_EVENT_TYPE: &str = "CampaignHouseRuleChanged";

/// Отказ смены редакции или домашнего правила (`CampaignRulesetError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CampaignRulesetError {
    pub code: String,
    pub message: String,
}

impl CampaignRulesetError {
    pub fn new(message: impl Into<String>, code: &str) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

impl fmt::Display for CampaignRulesetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CampaignRulesetError {}

/// Что бросает смена редакции: неизвестная или закрытая редакция
/// (`RulesetSelectionError`) либо запрет смены (`CampaignRulesetError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CampaignRulesetFailure {
    Selection(RulesetSelectionError),
    Campaign(CampaignRulesetError),
}

impl CampaignRulesetFailure {
    pub fn code(&self) -> &str {
        match self {
            Self::Selection(error) => &error.code,
            Self::Campaign(error) => &error.code,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::Selection(error) => &error.message,
            Self::Campaign(error) => &error.message,
        }
    }
}

impl fmt::Display for CampaignRulesetFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code(), self.message())
    }
}

impl std::error::Error for CampaignRulesetFailure {}

impl From<RulesetSelectionError> for CampaignRulesetFailure {
    fn from(error: RulesetSelectionError) -> Self {
        Self::Selection(error)
    }
}

impl From<CampaignRulesetError> for CampaignRulesetFailure {
    fn from(error: CampaignRulesetError) -> Self {
        Self::Campaign(error)
    }
}

/// Поле `actorId` и время `now` создаваемого события; `now` по умолчанию —
/// текущее время (`new Date().toISOString()`), `actor_id` — `null`.
#[derive(Debug, Clone, Default)]
pub struct EventOptions {
    pub actor_id: Option<Value>,
    pub now: Option<String>,
}

impl EventOptions {
    fn actor(&self) -> Value {
        self.actor_id.clone().unwrap_or(Value::Null)
    }

    fn now(&self) -> String {
        self.now.clone().unwrap_or_else(sk_core::clock::now_iso)
    }
}

fn combat_active(state: Option<&Value>) -> bool {
    js::is_true(path(state, &["mechanics", "combat", "active"]))
}

/// `(Array.isArray(state?.enabled_house_rules) ? … : []).map(String)`.
fn enabled_house_rules(state: Option<&Value>) -> Vec<String> {
    array(prop(state, "enabled_house_rules")).iter().map(|entry| string_of(Some(entry))).collect()
}

/// `campaignRulesetCanChange(events, state)`: редакцию можно менять, пока в
/// журнале нет ничего, кроме прежних смен редакции.
pub fn campaign_ruleset_can_change(events: Option<&Value>, state: Option<&Value>) -> Value {
    if js::is_true(prop(state, "ruleset_selection_locked")) {
        return json!({
            "allowed": false,
            "reason": "Редакция зафиксирована при импорте состояния без журнала событий",
            "blocking_event_type": "ImportedCampaignState",
        });
    }
    let blocking = array(events).iter().find(|event| js::s(defined(prop(Some(event), "event_type"))) != RULESET_EVENT_TYPE);
    // `find` вернул запись; запрет даёт только истинная запись — `null` в
    // журнале его не включает (как в JS).
    match blocking.filter(|event| js::truthy(Some(event))) {
        Some(event) => {
            let event_type = string_of(prop(Some(event), "event_type"));
            json!({
                "allowed": false,
                "reason": format!("Редакция зафиксирована событием {event_type}"),
                "blocking_event_type": event_type,
            })
        }
        None => json!({ "allowed": true, "reason": null, "blocking_event_type": null }),
    }
}

/// `campaignRulesetSettings(state, events, { canManage })`: текущая редакция,
/// доступные редакции и домашние правила для настроек ведущего.
pub fn campaign_ruleset_settings(state: Option<&Value>, events: Option<&Value>, can_manage: bool) -> Result<Value, RulesetSelectionError> {
    let profile = ruleset_profile(&js::s(prop(state, "ruleset_id")), ProfileOptions::fallback("srd_5_2_1"))?;
    let change = campaign_ruleset_can_change(events, state);
    let allowed = js::is_true(change.get("allowed"));
    let version = prop(state, "ruleset_version").filter(|value| js::truthy(Some(value)));
    Ok(json!({
        "current": {
            "id": profile.id,
            "version": version.map_or_else(|| profile.version.to_string(), |value| js::s(Some(value))),
            "label": profile.label,
            "mechanicsStatus": profile.mechanics_status,
            "availability": profile.availability,
        },
        "available": public_ruleset_profiles(),
        "canChange": can_manage && allowed,
        "locked": !allowed,
        "lockReason": change.get("reason").cloned().unwrap_or(Value::Null),
        "houseRules": campaign_house_rule_settings(state),
    }))
}

/// `campaignHouseRuleSettings(state)`: переключаемые домашние правила и их
/// состояние. Источник истины — `enabled_house_rules` состояния.
pub fn campaign_house_rule_settings(state: Option<&Value>) -> Value {
    let enabled = enabled_house_rules(state);
    Value::Array(
        TOGGLEABLE_HOUSE_RULES
            .iter()
            .map(|rule| {
                json!({
                    "id": rule.id,
                    "label": rule.label,
                    "description": rule.description,
                    "enabled": enabled.iter().any(|entry| entry == rule.id),
                })
            })
            .collect(),
    )
}

/// `campaignHouseRuleChangeEvent(houseRuleId, enabled, state, options)`:
/// событие включения или выключения домашнего правила; без изменения —
/// `None`. `house_rule_id` — уже приведённое `String(x ?? '')`, `enabled` —
/// значение как пришло (нужен именно `boolean`).
pub fn campaign_house_rule_change_event(
    house_rule_id: &str,
    enabled: Option<&Value>,
    state: Option<&Value>,
    options: &EventOptions,
) -> Result<Option<Value>, CampaignRulesetError> {
    let id = house_rule_id.to_string();
    if !TOGGLEABLE_HOUSE_RULES.iter().any(|rule| rule.id == id) {
        return Err(CampaignRulesetError::new("Это домашнее правило нельзя переключить в идущей кампании", "HOUSE_RULE_NOT_TOGGLEABLE"));
    }
    let Some(Value::Bool(enabled)) = enabled else {
        return Err(CampaignRulesetError::new("Нужно явное включено или выключено", "HOUSE_RULE_VALUE_INVALID"));
    };
    let enabled = *enabled;
    if combat_active(state) {
        return Err(CampaignRulesetError::new("Домашние правила боя не меняют посреди боя", "HOUSE_RULE_DURING_COMBAT"));
    }
    let before = enabled_house_rules(state);
    if before.contains(&id) == enabled {
        return Ok(None);
    }
    let after: Vec<String> = if enabled {
        unique_strings(before.iter().cloned().chain(std::iter::once(id.clone())))
    } else {
        before.iter().filter(|entry| **entry != id).cloned().collect()
    };
    let actor = options.actor();
    Ok(Some(json!({
        "event_schema_version": 1,
        "event_type": HOUSE_RULE_EVENT_TYPE,
        "actor_id": actor,
        "target_ids": [],
        "visibility": "party",
        "source_rule_ids": [],
        "house_rule_id": id,
        "ruling_id": null,
        "payload": {
            "schema_version": 1,
            "house_rule_id": id,
            "enabled": enabled,
            "enabled_house_rules_before": str_array(&before),
            "enabled_house_rules_after": str_array(&after),
            "changed_by": actor,
            "changed_at": options.now(),
        },
    })))
}

/// `defaultHouseRuleEvent(houseRuleId, state, history, { now })`: включение
/// правила «по умолчанию» в идущей кампании. `None`, если правило уже
/// включено, ведущий уже переключал его сам или идёт бой.
pub fn default_house_rule_event(
    house_rule_id: &str,
    state: Option<&Value>,
    history: Option<&Value>,
    now: Option<String>,
) -> Result<Option<Value>, CampaignRulesetError> {
    if combat_active(state) {
        return Ok(None);
    }
    let toggled_before = array(history).iter().any(|event| {
        prop(Some(event), "event_type").and_then(Value::as_str) == Some(HOUSE_RULE_EVENT_TYPE)
            && js::s(defined(path(Some(event), &["payload", "house_rule_id"]))) == house_rule_id
    });
    if toggled_before {
        return Ok(None);
    }
    let options = EventOptions { actor_id: None, now };
    let event = campaign_house_rule_change_event(house_rule_id, Some(&Value::Bool(true)), state, &options)?;
    Ok(event.map(|mut event| {
        if let Some(Value::Object(payload)) = event.get_mut("payload") {
            payload.insert("reason".into(), Value::String("default-on".into()));
        }
        event
    }))
}

/// `[...value]` для поля события: массив или строка; прочее в JS бросает
/// `TypeError` — здесь `Err` с тем же смыслом.
fn spread_field(event: Option<&Value>, keys: &[&str]) -> Result<Value, String> {
    let payload = prop(event, "payload");
    if !matches!(payload, Some(Value::Object(_)) | Some(Value::Array(_)) | Some(Value::String(_)) | Some(Value::Number(_)) | Some(Value::Bool(_))) {
        return Err(format!("Cannot read properties of {} (reading '{}')", string_of(payload), keys[0]));
    }
    let value = keys.iter().fold(payload, |current, key| prop(current, key));
    match value {
        Some(Value::Array(_)) | Some(Value::String(_)) => Ok(Value::Array(spread_items(value))),
        _ => Err(format!("{} is not iterable", string_of(value))),
    }
}

/// `campaignHouseRuleMetadata(event)`: поля состояния, которые меняет событие
/// домашнего правила; для прочих событий — `{}`.
pub fn campaign_house_rule_metadata(event: Option<&Value>) -> Result<Value, String> {
    if prop(event, "event_type").and_then(Value::as_str) != Some(HOUSE_RULE_EVENT_TYPE) {
        return Ok(Value::Object(Map::new()));
    }
    Ok(json!({ "enabled_house_rules": spread_field(event, &["enabled_house_rules_after"])? }))
}

/// `campaignRulesetChangeEvent(requestedRulesetId, state, events, options)`:
/// событие смены редакции до первого игрового события; та же редакция —
/// `None`. `requested_ruleset_id` — уже приведённое `String(x ?? '')`.
pub fn campaign_ruleset_change_event(
    requested_ruleset_id: &str,
    state: Option<&Value>,
    events: Option<&Value>,
    options: &EventOptions,
) -> Result<Option<Value>, CampaignRulesetFailure> {
    let before = ruleset_profile(&js::s(prop(state, "ruleset_id")), ProfileOptions::fallback("srd_5_2_1"))?;
    let after = ruleset_profile(requested_ruleset_id, ProfileOptions { fallback: None, require_creation: true })?;
    if before.id == after.id {
        return Ok(None);
    }
    let change = campaign_ruleset_can_change(events, state);
    if !js::is_true(change.get("allowed")) {
        return Err(CampaignRulesetError::new(
            "Редакцию можно менять только до первого игрового события; создайте новую кампанию для другой редакции",
            "CAMPAIGN_RULESET_LOCKED",
        )
        .into());
    }
    let lock = ruleset_lock(after.id, ProfileOptions::default())?;
    let ruleset_house_rules = ruleset_house_rule_ids();
    let preserved: Vec<String> = enabled_house_rules(state).into_iter().filter(|id| !ruleset_house_rules.contains(id)).collect();
    let lock_house_rules: Vec<String> = array(lock.get("enabled_house_rules")).iter().map(|entry| js::s(Some(entry))).collect();
    let enabled_house_rules_after = unique_strings(preserved.into_iter().chain(lock_house_rules));
    let version = prop(state, "ruleset_version").filter(|value| js::truthy(Some(value)));
    let packs_before = match prop(state, "enabled_rule_packs") {
        Some(Value::Array(items)) => Value::Array(items.clone()),
        _ => str_array(before.enabled_rule_packs),
    };
    let house_rules_before = match prop(state, "enabled_house_rules") {
        Some(Value::Array(items)) => Value::Array(items.clone()),
        _ => Value::Array(Vec::new()),
    };
    let actor = options.actor();
    Ok(Some(json!({
        "event_schema_version": 1,
        "event_type": RULESET_EVENT_TYPE,
        "actor_id": actor,
        "target_ids": [],
        "visibility": "party",
        "source_rule_ids": [],
        "ruling_id": null,
        "payload": {
            "schema_version": 1,
            "ruleset_id_before": before.id,
            "ruleset_version_before": version.map_or_else(|| before.version.to_string(), |value| js::s(Some(value))),
            "enabled_rule_packs_before": packs_before,
            "enabled_house_rules_before": house_rules_before,
            "ruleset_id_after": lock.get("ruleset_id").cloned().unwrap_or(Value::Null),
            "ruleset_version_after": lock.get("ruleset_version").cloned().unwrap_or(Value::Null),
            "enabled_rule_packs_after": lock.get("enabled_rule_packs").cloned().unwrap_or(Value::Null),
            "enabled_house_rules_after": str_array(&enabled_house_rules_after),
            "changed_by": actor,
            "changed_at": options.now(),
        },
    })))
}

/// `campaignRulesetMetadata(event)`: поля состояния, которые меняет событие
/// смены редакции; для прочих событий — `{}`.
pub fn campaign_ruleset_metadata(event: Option<&Value>) -> Result<Value, String> {
    if prop(event, "event_type").and_then(Value::as_str) != Some(RULESET_EVENT_TYPE) {
        return Ok(Value::Object(Map::new()));
    }
    let payload = prop(event, "payload");
    if !js::present(payload) {
        return Err(format!("Cannot read properties of {} (reading 'ruleset_id_after')", string_of(payload)));
    }
    // Отсутствующее поле в JS — `undefined`, и в JSON его нет.
    let mut metadata = Map::new();
    if let Some(value) = prop(payload, "ruleset_id_after") {
        metadata.insert("ruleset_id".into(), value.clone());
    }
    if let Some(value) = prop(payload, "ruleset_version_after") {
        metadata.insert("ruleset_version".into(), value.clone());
    }
    metadata.insert("enabled_rule_packs".into(), spread_field(event, &["enabled_rule_packs_after"])?);
    metadata.insert("enabled_house_rules".into(), spread_field(event, &["enabled_house_rules_after"])?);
    Ok(Value::Object(metadata))
}

fn ruleset_house_rule_ids() -> Vec<String> {
    let public = public_ruleset_profiles();
    array(Some(&public))
        .iter()
        .filter_map(|profile| ruleset_profile(&js::s(profile.get("id")), ProfileOptions::default()).ok())
        .flat_map(|profile| profile.default_house_rules.iter().map(|id| id.to_string()))
        .collect()
}

//! Перенос `server/campaign-stories.mjs`: истории постоянного мира.
//!
//! Кампания бывает «Приключением» или «Постоянным миром». В постоянном мире
//! основная история — уже принятая задача отряда; её исход закрывает историю
//! тем же атомарным пакетом событий (`CampaignStoryCompleted`), а мир остаётся
//! открытым. Граница осведомлённости у истории та же, что у её задачи.

use serde_json::{json, Map, Value};
use sk_core::{js, text, RuleError};

use crate::common::{array, get, is_str, number_or_zero, s, strict_eq, tpl};
use crate::quest_consequences::{knowledge_gate_for_event, scene_view};

pub const CAMPAIGN_MODES: [&str; 2] = ["adventure", "persistent"];
pub const PERSISTENT_WORLD_OBJECTIVE: &str = "Исследовать мир или выбрать собственную цель";

/// Проверка режима кампании (`validateCampaignMode`). `None` — `undefined`,
/// то есть «Приключение» по умолчанию.
pub fn validate_campaign_mode(value: Option<&Value>) -> Result<Value, RuleError> {
    let value = value.cloned().unwrap_or_else(|| json!("adventure"));
    if CAMPAIGN_MODES.iter().any(|mode| value.as_str() == Some(mode)) {
        return Ok(value);
    }
    Err(RuleError::new("INVALID_CAMPAIGN_MODE", "Выберите режим «Приключение» или «Постоянный мир»"))
}

/// Режим кампании (`campaignModeFor`): отсутствующее поле — политика старых кампаний.
pub fn campaign_mode_for(state: &Value) -> &'static str {
    if is_str(get(get(Some(state), "campaignConcept"), "campaign_mode"), "persistent") {
        "persistent"
    } else {
        "adventure"
    }
}

/// Задача основной истории (`persistentStoryQuest`): только из уже принятых.
pub fn persistent_story_quest(state: &Value) -> Option<&Value> {
    let quests = array(get(get(Some(state), "worldMemory"), "quests"));
    let mut active = quests.iter().filter(|quest| {
        let visibility = get(Some(quest), "visibility");
        is_str(get(Some(quest), "status"), "active")
            && (is_str(visibility, "public") || is_str(visibility, "party"))
            && !tpl(get(Some(quest), "id")).starts_with("quest:chapter:")
    });
    // Отсутствующее поле инициализируется один раз при нормализации; `null`
    // означает, что отряд ещё не принял задачу для следующей истории.
    match get(get(Some(state), "campaignConcept"), "story_quest_id") {
        None => active.next(),
        selected => active.find(|quest| strict_eq(get(Some(quest), "id"), selected)),
    }
}

/// Завершение истории в том же пакете, что исход её задачи
/// (`campaignStoryCompletionDraft`).
pub fn campaign_story_completion_draft(state: &Value, events: &[Value]) -> Result<Option<Value>, RuleError> {
    if campaign_mode_for(state) != "persistent" {
        return Ok(None);
    }
    let Some(quest) = persistent_story_quest(state) else {
        return Ok(None);
    };
    let resolution = events.iter().find(|event| {
        let kind = get(Some(event), "event_type");
        let payload = get(Some(event), "payload");
        let outcome = get(payload, "outcome");
        (is_str(kind, "QuestResolved") || is_str(kind, "QuestInvalidated"))
            && strict_eq(get(payload, "quest_id"), get(Some(quest), "id"))
            && (is_str(outcome, "success") || is_str(outcome, "failure") || is_str(outcome, "abandoned"))
    });
    let Some(resolution) = resolution else {
        return Ok(None);
    };
    let previous = match get(get(Some(state), "campaignConcept"), "story_sequence") {
        None | Some(Value::Null) => json!(0),
        Some(value) => value.clone(),
    };
    let previous_number = previous.as_f64().unwrap_or(f64::NAN);
    if !js::is_safe_integer(Some(&previous)) || previous_number < 0.0 || previous_number >= 9_007_199_254_740_991.0 {
        return Err(RuleError::new("CAMPAIGN_STORY_SEQUENCE_INVALID", "Номер истории нельзя безопасно увеличить"));
    }
    let sequence = previous_number as i64 + 1;
    let campaign = text::head(&sk_core::hash::sha256_hex(tpl(get(Some(state), "sessionCode"))), 16);
    let payload = get(Some(resolution), "payload");
    let gate = get(payload, "knowledge_gate");
    let has_gate = js::truthy(gate);
    let scene = get(Some(state), "scene");
    let mut out = Map::new();
    out.insert("schema_version".into(), json!(if has_gate { 2 } else { 1 }));
    if has_gate {
        out.insert("knowledge_gate".into(), knowledge_gate_for_event(state, resolution));
        let sources: Vec<Value> = get(Some(resolution), "event_id").filter(|id| js::truthy(Some(id))).cloned().into_iter().collect();
        out.insert("source_event_ids".into(), Value::Array(sources));
        if let Some(dependency) = get(payload, "dependency_id") {
            out.insert("dependency_id".into(), dependency.clone());
        }
        if let Some(policy) = get(payload, "policy_id") {
            out.insert("policy_id".into(), policy.clone());
        }
        let view = scene_view(state);
        let mut previous_view = Map::new();
        if let Some(id) = get(Some(quest), "id") {
            previous_view.insert("story_quest_id".into(), id.clone());
        }
        previous_view.insert("location_id".into(), view.location_id);
        previous_view.insert("objective".into(), view.objective);
        previous_view.insert("current_hook".into(), view.current_hook);
        previous_view.insert("replaced_objective".into(), json!(PERSISTENT_WORLD_OBJECTIVE));
        previous_view.insert("suggestions".into(), view.suggestions);
        out.insert("previous_view".into(), Value::Object(previous_view));
    }
    out.insert("story_id".into(), Value::String(format!("story:{campaign}:{sequence}")));
    out.insert("story_number".into(), json!(sequence));
    if let Some(id) = get(Some(quest), "id") {
        out.insert("quest_id".into(), id.clone());
    }
    out.insert("title".into(), Value::String(text::head(&tpl(get(Some(quest), "title")), 180)));
    if let Some(outcome) = get(payload, "outcome") {
        out.insert("outcome".into(), outcome.clone());
    }
    let summary = get(payload, "summary").filter(|value| js::truthy(Some(value)));
    out.insert("summary".into(), Value::String(text::head(&s(summary), 1_000)));
    out.insert("location_id".into(), Value::String(s(get(scene, "location_id").filter(|value| js::truthy(Some(value))))));
    out.insert("location".into(), Value::String(text::head(&s(get(scene, "location").filter(|value| js::truthy(Some(value)))), 180)));
    let elapsed = get(get(get(Some(state), "mechanics"), "world_time"), "elapsed_minutes");
    out.insert("elapsed_minutes".into(), js::num(js::max_of([0.0, number_or_zero(elapsed)])));
    let mut event = Map::new();
    event.insert("event_type".into(), json!("CampaignStoryCompleted"));
    event.insert("visibility".into(), json!("party"));
    event.insert("target_ids".into(), json!([]));
    event.insert("payload".into(), Value::Object(out));
    Ok(Some(Value::Object(event)))
}

/// Запись летописи о завершённой истории (`campaignStoryChronicleEntry`).
pub fn campaign_story_chronicle_entry(event: &Value) -> Option<Value> {
    let payload = get(Some(event), "payload");
    let schema = get(payload, "schema_version");
    if !is_str(get(Some(event), "event_type"), "CampaignStoryCompleted") || !(strict_eq(schema, Some(&json!(1))) || strict_eq(schema, Some(&json!(2)))) {
        return None;
    }
    let mut entry = Map::new();
    entry.insert("id".into(), Value::String(format!("story-completed:{}", tpl(get(payload, "story_id")))));
    entry.insert("speaker".into(), json!("narrator"));
    entry.insert("author".into(), json!("Рассказчик"));
    entry.insert(
        "text".into(),
        Value::String(format!(
            "История «{}» завершена. {} Мир остаётся открытым для ваших действий.",
            tpl(get(payload, "title")),
            tpl(get(payload, "summary"))
        )),
    );
    entry.insert("turnConsumed".into(), Value::Bool(false));
    if js::truthy(get(payload, "knowledge_gate")) {
        entry.insert("knowledge_gate".into(), get(payload, "knowledge_gate").cloned().unwrap_or(Value::Null));
    }
    Some(Value::Object(entry))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::empty;

    #[test]
    fn mode_validation_follows_js() {
        assert_eq!(validate_campaign_mode(None), Ok(json!("adventure")));
        assert_eq!(validate_campaign_mode(Some(&json!("persistent"))), Ok(json!("persistent")));
        let error = validate_campaign_mode(Some(&json!("chaos"))).expect_err("неизвестный режим");
        assert_eq!(error.code, "INVALID_CAMPAIGN_MODE");
        assert_eq!(campaign_mode_for(empty()), "adventure");
        assert_eq!(campaign_mode_for(&json!({ "campaignConcept": { "campaign_mode": "persistent" } })), "persistent");
    }

    #[test]
    fn story_quest_respects_explicit_null() {
        let quests = json!([
            { "id": "quest:chapter:1", "status": "active", "visibility": "party" },
            { "id": "q1", "status": "active", "visibility": "party" },
            { "id": "q2", "status": "active", "visibility": "public" },
        ]);
        let state = json!({ "worldMemory": { "quests": quests } });
        assert_eq!(persistent_story_quest(&state).and_then(|quest| quest.get("id")), Some(&json!("q1")));
        let none = json!({ "worldMemory": { "quests": quests }, "campaignConcept": { "story_quest_id": null } });
        assert_eq!(persistent_story_quest(&none), None);
        let chosen = json!({ "worldMemory": { "quests": quests }, "campaignConcept": { "story_quest_id": "q2" } });
        assert_eq!(persistent_story_quest(&chosen).and_then(|quest| quest.get("id")), Some(&json!("q2")));
    }

    #[test]
    fn broken_sequence_is_refused() {
        let state = json!({
            "sessionCode": "S",
            "campaignConcept": { "campaign_mode": "persistent", "story_sequence": "3" },
            "worldMemory": { "quests": [{ "id": "q1", "status": "active", "visibility": "party", "title": "Т" }] },
        });
        let events = [json!({ "event_type": "QuestResolved", "payload": { "quest_id": "q1", "outcome": "success" } })];
        let error = campaign_story_completion_draft(&state, &events).expect_err("строка — не номер");
        assert_eq!(error.code, "CAMPAIGN_STORY_SEQUENCE_INVALID");
    }
}

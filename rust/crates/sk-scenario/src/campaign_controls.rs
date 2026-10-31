//! Перенос `server/campaign-controls.mjs`: откат хода и переигрывание сцены.
//!
//! Ведущий может отменить последнюю команду (`rewind_turn`) или вернуть сцену
//! к её началу (`replay_scene`). Журнал при этом остаётся append-only: откат
//! записывается событием `CampaignRewound` с целевым состоянием, а действующая
//! ветвь истории выводится из цепочки таких событий. Граница арки и финал
//! кампании откатом не пересекаются.

use std::fmt;

use serde::Serialize;
use serde_json::{json, Map, Value};
use sk_core::js;

use crate::util::{array, spread_copy, string_of};

const CONTROL_ACTIONS: [&str; 2] = ["rewind_turn", "replay_scene"];
const REWIND_EVENT: &str = "CampaignRewound";
const HARD_BOUNDARY_TYPES: [&str; 5] = [
    "LegacyStateImported",
    "CampaignArcCompleted",
    "CampaignCompleted",
    "CampaignFailed",
    "CampaignArchived",
];
const SCENE_BOUNDARY_TYPES: [&str; 3] = ["LegacyStateImported", "CampaignArcCompleted", "SceneAdvanced"];
const NON_GAMEPLAY_TYPES: [&str; 6] = [
    REWIND_EVENT,
    "CampaignPaused",
    "CampaignResumed",
    "CampaignArcChainSet",
    "NarrativeSummaryRecorded",
    "PublicDieRolled",
];

/// Отказ управления кампанией (`CampaignControlError`): код и текст как в JS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CampaignControlError {
    pub code: String,
    pub message: String,
}

impl CampaignControlError {
    fn new(message: impl Into<String>, code: &str) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

impl fmt::Display for CampaignControlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CampaignControlError {}

/// План отката: куда вернуть кампанию и какие события этим отменяются.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlPlan {
    pub action: String,
    pub target_version: i64,
    pub semantic_version: i64,
    /// Команда, к которой относится граница; `null`, если её нет.
    pub command_id: Option<String>,
    /// `event_type` отменяемых событий как есть (отсутствующий — `null`).
    pub reverted_event_types: Vec<Value>,
}

fn safe_version(value: Option<&Value>, label: &str) -> Result<i64, CampaignControlError> {
    if !js::is_safe_integer_number(value) || js::number(value) < 0.0 {
        return Err(CampaignControlError::new(
            format!("{label} должен быть целой неотрицательной версией"),
            "INVALID_CONTROL_VERSION",
        ));
    }
    Ok(js::number(value) as i64)
}

/// Событие журнала с уже проверенными версиями.
#[derive(Debug, Clone)]
struct ControlEvent {
    raw: Map<String, Value>,
    before: i64,
    after: i64,
}

impl ControlEvent {
    fn event_type(&self) -> Option<&Value> {
        self.raw.get("event_type")
    }

    fn type_is(&self, types: &[&str]) -> bool {
        self.event_type().and_then(Value::as_str).is_some_and(|kind| types.contains(&kind))
    }

    fn is_gameplay(&self) -> bool {
        let kind = js::s(self.event_type());
        !NON_GAMEPLAY_TYPES.contains(&kind.as_str())
    }

    fn event_type_value(&self) -> Value {
        self.event_type().cloned().unwrap_or(Value::Null)
    }
}

fn ordered_events(events: Option<&Value>, current_version: Option<&Value>) -> Result<Vec<ControlEvent>, CampaignControlError> {
    let mut normalized = Vec::new();
    for event in array(events) {
        let raw = event.as_object();
        let before = safe_version(raw.and_then(|map| map.get("state_version_before")), "state_version_before")?;
        let after = safe_version(raw.and_then(|map| map.get("state_version_after")), "state_version_after")?;
        let mut copy = spread_copy(Some(event));
        copy.insert("state_version_before".into(), Value::from(before));
        copy.insert("state_version_after".into(), Value::from(after));
        normalized.push(ControlEvent { raw: copy, before, after });
    }
    normalized.sort_by_key(|event| event.after);
    if normalized.iter().any(|event| event.after != event.before + 1) {
        return Err(CampaignControlError::new("Журнал содержит событие с разрывом версии", "INVALID_CONTROL_HISTORY"));
    }
    let current = safe_version(current_version, "currentVersion")?;
    if normalized.last().map_or(0, |event| event.after) > current {
        return Err(CampaignControlError::new("Журнал новее текущего состояния кампании", "INVALID_CONTROL_HISTORY"));
    }
    Ok(normalized)
}

/// После отката журнал остаётся append-only. Здесь цепочка `CampaignRewound`
/// проходится назад и отделяет действующую ветвь от уже отменённых событий.
fn semantic_events(events: Vec<ControlEvent>) -> Result<Vec<ControlEvent>, CampaignControlError> {
    let limit = events.len();
    let mut visible = events;
    for _ in 0..=limit {
        let Some(rewind_index) = visible.iter().rposition(|event| event.event_type().and_then(Value::as_str) == Some(REWIND_EVENT)) else {
            return Ok(visible);
        };
        if visible[rewind_index + 1..].iter().any(ControlEvent::is_gameplay) {
            return Ok(visible);
        }
        let rewind = &visible[rewind_index];
        let target = rewind.raw.get("payload").and_then(|payload| payload.get("target_version"));
        let target_version = safe_version(target, "CampaignRewound.target_version")?;
        if target_version >= rewind.before {
            return Err(CampaignControlError::new("CampaignRewound ссылается не на прошлую версию", "INVALID_CONTROL_HISTORY"));
        }
        visible.retain(|event| event.after <= target_version);
    }
    Err(CampaignControlError::new("Цепочка откатов зациклена", "INVALID_CONTROL_HISTORY"))
}

struct CommandGroup {
    command_id: String,
    start_version: i64,
    end_version: i64,
    events: Vec<ControlEvent>,
}

fn command_id_of(event: &ControlEvent) -> String {
    let pick = ["command_id", "idempotency_key", "event_id"]
        .iter()
        .find_map(|key| event.raw.get(*key).filter(|value| !value.is_null()));
    match pick {
        Some(value) => string_of(Some(value)),
        None => format!("version-{}", event.after),
    }
}

fn command_groups(events: &[ControlEvent]) -> Vec<CommandGroup> {
    let mut groups: Vec<CommandGroup> = Vec::new();
    for event in events {
        let command_id = command_id_of(event);
        if let Some(previous) = groups.last_mut() {
            if previous.command_id == command_id && previous.end_version == event.before {
                previous.events.push(event.clone());
                previous.end_version = event.after;
                continue;
            }
        }
        groups.push(CommandGroup { command_id, start_version: event.before, end_version: event.after, events: vec![event.clone()] });
    }
    groups
}

fn last_group_with<'a>(groups: &'a [CommandGroup], predicate: impl Fn(&ControlEvent) -> bool) -> Option<&'a CommandGroup> {
    groups.iter().rev().find(|group| group.events.iter().any(&predicate))
}

fn normalized_action(action: Option<&Value>) -> Result<String, CampaignControlError> {
    let normalized = js::s(action).trim().to_string();
    if !CONTROL_ACTIONS.contains(&normalized.as_str()) {
        let shown = if normalized.is_empty() { "<пусто>" } else { normalized.as_str() };
        return Err(CampaignControlError::new(format!("Неизвестное действие ведущего: {shown}"), "INVALID_CAMPAIGN_CONTROL"));
    }
    Ok(normalized)
}

/// `planCampaignControl({ action, events, currentVersion })`: до какой версии
/// откатить кампанию. Значения приводятся, как в JS (`String(action ?? '')`,
/// `Number(currentVersion)`), поэтому принимаются как JSON.
pub fn plan_campaign_control(
    action: Option<&Value>,
    events: Option<&Value>,
    current_version: Option<&Value>,
) -> Result<ControlPlan, CampaignControlError> {
    let action = normalized_action(action)?;
    let history = semantic_events(ordered_events(events, current_version)?)?;
    let groups = command_groups(&history);
    let semantic_version = history.last().map_or(0, |event| event.after);
    let hard_boundary = last_group_with(&groups, |event| event.type_is(&HARD_BOUNDARY_TYPES));
    let boundary_version = hard_boundary.map_or(0, |group| group.end_version);

    if action == "replay_scene" {
        let scene_boundary = last_group_with(&groups, |event| event.type_is(&SCENE_BOUNDARY_TYPES));
        let target_version = boundary_version.max(scene_boundary.map_or(0, |group| group.end_version));
        if semantic_version <= target_version {
            return Err(CampaignControlError::new("Текущая сцена ещё не содержит действий для переигрывания", "NOTHING_TO_REPLAY"));
        }
        return Ok(ControlPlan {
            action,
            target_version,
            semantic_version,
            command_id: scene_boundary.map(|group| group.command_id.clone()),
            reverted_event_types: history.iter().filter(|event| event.after > target_version).map(ControlEvent::event_type_value).collect(),
        });
    }

    let candidate = groups.iter().rev().find(|group| {
        group.start_version >= boundary_version
            && !group.events.iter().any(|event| event.type_is(&HARD_BOUNDARY_TYPES))
            && group.events.iter().any(ControlEvent::is_gameplay)
    });
    let Some(candidate) = candidate else {
        return Err(CampaignControlError::new("В текущей арке нет хода, который можно откатить", "NOTHING_TO_REWIND"));
    };
    Ok(ControlPlan {
        action,
        target_version: candidate.start_version,
        semantic_version,
        command_id: Some(candidate.command_id.clone()),
        reverted_event_types: candidate.events.iter().map(ControlEvent::event_type_value).collect(),
    })
}

/// `campaignRewindEvent({ action, targetState, currentState, targetVersion,
/// actorId, occurredAt })`: черновик события `CampaignRewound`. Пауза
/// кампании и настройка цепочки арок берутся из текущего состояния — откат
/// хода их не отменяет. `occurred_at: None` — сейчас (`new Date().toISOString()`).
pub fn campaign_rewind_event(
    action: Option<&Value>,
    target_state: Option<&Value>,
    current_state: Option<&Value>,
    target_version: Option<&Value>,
    actor_id: Option<&Value>,
    occurred_at: Option<&Value>,
) -> Result<Value, CampaignControlError> {
    let action = normalized_action(action)?;
    let Some(Value::Object(target)) = target_state else {
        return Err(CampaignControlError::new("Не найдено состояние для отката", "INVALID_REWIND_STATE"));
    };
    let mut state = target.clone();
    let current_lifecycle = current_state.and_then(|state| state.get("mechanics")).and_then(|mechanics| mechanics.get("campaign_lifecycle"));
    if let Some(lifecycle @ Value::Object(_)) = current_lifecycle {
        let mechanics = state.get("mechanics").filter(|value| !value.is_null());
        let mut merged = spread_copy(mechanics);
        merged.insert("campaign_lifecycle".into(), lifecycle.clone());
        state.insert("mechanics".into(), Value::Object(merged));
    }
    let current_concept = current_state.and_then(|state| state.get("campaignConcept"));
    if js::truthy(current_concept) {
        if let Some(Value::Object(concept)) = current_concept {
            if concept.contains_key("arc_chain") {
                let base = state.get("campaignConcept").filter(|value| !value.is_null());
                let mut merged = spread_copy(base);
                merged.insert("arc_chain".into(), Value::Bool(js::is_true(concept.get("arc_chain"))));
                state.insert("campaignConcept".into(), Value::Object(merged));
            }
        }
    }
    state.insert("isNarrating".into(), Value::Bool(false));
    let target_version = safe_version(target_version, "targetVersion")?;
    let current_version = current_state.and_then(|state| state.get("state_version")).filter(|value| !value.is_null());
    let rewound_from = safe_version(Some(current_version.unwrap_or(&Value::from(0))), "currentState.state_version")?;
    let occurred_at = match occurred_at {
        None => sk_core::clock::now_iso(),
        Some(value) => string_of(Some(value)),
    };
    Ok(json!({
        "event_type": REWIND_EVENT,
        "actor_id": js::s(actor_id),
        "target_ids": [],
        "visibility": "party",
        "source_rule_ids": ["campaign.control.rewind.v1"],
        "payload": {
            "action": action,
            "target_version": target_version,
            "rewound_from_version": rewound_from,
            "occurred_at": occurred_at,
            "state": Value::Object(state),
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(version: i64, event_type: &str, command_id: &str, payload: Value) -> Value {
        json!({
            "event_id": format!("{command_id}:{version}"),
            "command_id": command_id,
            "idempotency_key": command_id,
            "event_type": event_type,
            "state_version_before": version - 1,
            "state_version_after": version,
            "payload": payload,
        })
    }

    fn plan(action: &str, current: i64, events: Vec<Value>) -> Result<ControlPlan, CampaignControlError> {
        plan_campaign_control(Some(&json!(action)), Some(&Value::Array(events)), Some(&json!(current)))
    }

    #[test]
    fn rewind_returns_to_start_of_last_command() {
        let plan = plan("rewind_turn", 6, vec![
            event(1, "LegacyStateImported", "bootstrap", json!({})),
            event(2, "SceneAdvanced", "scene-2", json!({})),
            event(3, "NarrativeSummaryRecorded", "scene-2", json!({})),
            event(4, "AttackResolved", "turn-1", json!({})),
            event(5, "DamageApplied", "turn-1", json!({})),
            event(6, "MovementResolved", "turn-2", json!({})),
        ])
        .expect("план");
        assert_eq!(plan.target_version, 5);
        assert_eq!(plan.command_id.as_deref(), Some("turn-2"));
        assert_eq!(plan.reverted_event_types, vec![json!("MovementResolved")]);
    }

    #[test]
    fn replay_keeps_scene_transition() {
        let plan = plan("replay_scene", 7, vec![
            event(1, "LegacyStateImported", "bootstrap", json!({})),
            event(2, "SceneAdvanced", "scene-2", json!({})),
            event(3, "NarrativeSummaryRecorded", "scene-2", json!({})),
            event(4, "MerchantCreated", "scene-2", json!({})),
            event(5, "MovementResolved", "turn-1", json!({})),
            event(6, "AttackResolved", "turn-2", json!({})),
            event(7, "DamageApplied", "turn-2", json!({})),
        ])
        .expect("план");
        assert_eq!(plan.target_version, 4);
        assert_eq!(plan.reverted_event_types, vec![json!("MovementResolved"), json!("AttackResolved"), json!("DamageApplied")]);
    }

    #[test]
    fn rewind_does_not_cross_arc_or_finale() {
        let error = plan("rewind_turn", 3, vec![
            event(1, "LegacyStateImported", "bootstrap", json!({})),
            event(2, "AttackResolved", "old-arc-turn", json!({})),
            event(3, "CampaignArcCompleted", "arc-transition", json!({})),
        ])
        .expect_err("отказ");
        assert_eq!(error.code, "NOTHING_TO_REWIND");
        let error = plan("replay_scene", 2, vec![
            event(1, "LegacyStateImported", "bootstrap", json!({})),
            event(2, "CampaignCompleted", "finale", json!({})),
        ])
        .expect_err("отказ");
        assert_eq!(error.code, "NOTHING_TO_REPLAY");
    }

    #[test]
    fn rewind_chain_hides_cancelled_branch() {
        let plan = plan("rewind_turn", 5, vec![
            event(1, "LegacyStateImported", "bootstrap", json!({})),
            event(2, "SceneAdvanced", "scene", json!({})),
            event(3, "MovementResolved", "turn-1", json!({})),
            event(4, "AttackResolved", "turn-2", json!({})),
            event(5, "CampaignRewound", "rewind-1", json!({ "target_version": 3 })),
        ])
        .expect("план");
        assert_eq!(plan.target_version, 2);
        assert_eq!(plan.command_id.as_deref(), Some("turn-1"));
    }

    #[test]
    fn rewind_event_keeps_pause_and_arc_chain() {
        let rewind = campaign_rewind_event(
            Some(&json!("rewind_turn")),
            Some(&json!({
                "state_version": 12,
                "isNarrating": true,
                "mechanics": { "campaign_lifecycle": { "status": "active" }, "combat": { "active": false } },
                "campaignConcept": { "arc_chain": false, "title": "Старая арка" },
            })),
            Some(&json!({
                "state_version": 20,
                "mechanics": { "campaign_lifecycle": { "status": "paused", "reason": "manual" } },
                "campaignConcept": { "arc_chain": true },
            })),
            Some(&json!(12)),
            Some(&json!("owner")),
            Some(&json!("2026-07-31T00:00:00.000Z")),
        )
        .expect("событие");
        assert_eq!(rewind["event_type"], "CampaignRewound");
        assert_eq!(rewind["payload"]["target_version"], 12);
        assert_eq!(rewind["payload"]["rewound_from_version"], 20);
        assert_eq!(rewind["payload"]["state"]["isNarrating"], false);
        assert_eq!(rewind["payload"]["state"]["mechanics"]["campaign_lifecycle"]["status"], "paused");
        assert_eq!(rewind["payload"]["state"]["campaignConcept"]["arc_chain"], true);
    }
}

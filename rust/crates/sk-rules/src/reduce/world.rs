//! Ветки редьюсера `applyGameEventCurrent`: Кампания и мир: замена состояния (`LegacyStateImported`, `CampaignRewound` до `switch`), история и дуги кампании, решения отряда, должности. Задача Р4.
//!
//! JS: `server/rules-engine.mjs`, 24285–24301, 24302–24304, 24305–24347, 24357–24359, 24360–24378, 24379–24397, 24398–24415, 24416–24432, 24433–24438, 27037–27039. Таблица меток — `reduce/table.rs`
//! (Р0). Перенося ветку, уберите её метки из [`UNPORTED`] этого файла.
//!
//! Не перенесены: замена состояния (нужна нормализация `normalizeCampaignState`
//! — задача Р4б). Должности — `applyWorldOfficeEvent` (`world-offices`,
//! крейт `sk-world-life`).

use serde_json::{json, Map, Value};
use sk_core::js::{self, is_safe_integer, is_true, present, s, safe_int, truthy};
use sk_core::text::head;
use sk_core::{Event, RuleError};

use super::Reduced;
use crate::core::{plain_object, spread_value};
use crate::pause::unported;

/// Метки событий этого файла, чьи ветки ещё не перенесены.
pub(super) const UNPORTED: &[&str] = &[
    "LegacyStateImported",
    "CampaignRewound",
];

/// `MAX_CAMPAIGN_ARCS` (`campaign-loop-policy.mjs`): сколько закрытых арок
/// помнит концепт кампании.
pub const MAX_CAMPAIGN_ARCS: usize = 12;

/// Поле конверта события (`event.created_at` и т. п.); `None` — поля нет.
pub(super) fn extra<'a>(event: &'a Event, key: &str) -> Option<&'a Value> {
    event.extra.get(key)
}

/// `a ?? b ?? null` по полям конверта.
pub(super) fn extra_coalesce(event: &Event, keys: &[&str]) -> Value {
    keys.iter().filter_map(|key| extra(event, key)).find(|value| present(Some(value))).cloned().unwrap_or(Value::Null)
}

/// `[...value]` для поля, где JS ждёт массив: строка раскладывается на
/// символы, прочее не итерируется (`TypeError`).
pub(super) fn spread_list(value: Option<&Value>, label: &str) -> Result<Vec<Value>, RuleError> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => Ok(items.clone()),
        Some(Value::String(text)) => Ok(text.chars().map(|ch| Value::String(ch.to_string())).collect()),
        Some(_) => Err(type_error(&format!("{label} is not iterable"))),
    }
}

/// Отказ редьюсера там, где JS бросает `TypeError`: событие не применяется
/// дальше этой точки, как и в JS.
pub(super) fn type_error(message: &str) -> RuleError {
    RuleError::new("REDUCER_TYPE_ERROR", message)
}

/// `state[key].field = value`: у объекта поле ставится, у массива — тоже
/// (в JSON не видно), у `null`/примитива JS бросает `TypeError`.
pub(super) fn set_nested(state: &mut Value, key: &str, field: &str, value: Value) -> Result<(), RuleError> {
    match state.get_mut(key) {
        Some(Value::Object(map)) => {
            map.insert(field.into(), value);
            Ok(())
        }
        Some(Value::Array(_)) => Ok(()),
        _ => Err(type_error(&format!("Cannot set properties of {key} (setting '{field}')"))),
    }
}

/// `{ ...value }` для поля состояния (`undefined`/`null`/примитив — пусто).
fn spread_field(state: &Value, key: &str) -> Map<String, Value> {
    spread_value(state.get(key))
}

/// `String(x).slice(0, n)`; поле есть всегда.
fn string_head(value: Option<&Value>, maximum: usize) -> String {
    head(&js::s(value), maximum)
}

/// `CampaignStoryCompleted` (24285–24301).
pub(super) fn campaign_story_completed(state: &mut Value, event: &Event) -> Reduced {
    let payload = &event.payload;
    let schema = payload.get("schema_version");
    let schema_ok = matches!(schema, Some(Value::Number(number)) if number.as_f64() == Some(1.0) || number.as_f64() == Some(2.0));
    let story_number = payload.get("story_number");
    let concept = state.get("campaignConcept");
    let sequence = concept.and_then(|concept| concept.get("story_sequence")).filter(|value| !value.is_null());
    let expected = js::number(Some(sequence.unwrap_or(&json!(0)))) + 1.0;
    if sk_society::campaign_stories::campaign_mode_for(state) != "persistent"
        || !schema_ok
        || !is_safe_integer(story_number)
        || js::number(story_number) != expected
    {
        return Ok(());
    }
    let history = spread_list(concept.and_then(|concept| concept.get("story_history")), "story_history")?;
    let mut entry = spread_value(Some(payload));
    entry.insert("concluded_at".into(), extra_coalesce(event, &["created_at", "occurred_at"]));
    let mut next = spread_field(state, "campaignConcept");
    next.insert("story_sequence".into(), story_number.cloned().unwrap_or(Value::Null));
    next.insert("story_quest_id".into(), Value::Null);
    let mut history = history;
    history.push(Value::Object(entry));
    next.insert("story_history".into(), Value::Array(history));
    state["campaignConcept"] = Value::Object(next);
    let objective = Value::from(sk_society::campaign_stories::PERSISTENT_WORLD_OBJECTIVE);
    set_nested(state, "scene", "objective", objective.clone())?;
    set_nested(state, "adventure", "currentHook", objective)?;
    state["suggestions"] = json!([]);
    Ok(())
}

/// `CampaignArcChainSet` (24302–24304).
pub(super) fn campaign_arc_chain_set(state: &mut Value, event: &Event) -> Reduced {
    let mut concept = spread_field(state, "campaignConcept");
    concept.insert("arc_chain".into(), Value::Bool(is_true(event.payload.get("enabled"))));
    state["campaignConcept"] = Value::Object(concept);
    Ok(())
}

/// `x && typeof x === 'object'` — объект или массив.
fn object_like(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Object(_) | Value::Array(_)))
}

/// `CampaignArcCompleted` (24305–24347).
pub(super) fn campaign_arc_completed(state: &mut Value, event: &Event) -> Reduced {
    let payload = event.payload.clone();
    let next_arc = payload.get("next_arc").filter(|value| object_like(Some(value))).cloned();
    if let Some(next_arc) = next_arc {
        let history = match state.get("campaignConcept").and_then(|concept| concept.get("arc_history")) {
            Some(Value::Array(items)) => items.clone(),
            _ => Vec::new(),
        };
        let closed = payload.get("closed_arc").filter(|value| object_like(Some(value)));
        let mut entry = spread_value(closed);
        entry.insert("epilogue".into(), Value::from(head(&s(payload.get("epilogue")), 8_000)));
        if truthy(payload.get("chronicle")) {
            entry.insert("chronicle".into(), Value::from(string_head(payload.get("chronicle"), 12_000)));
        }
        let concluded = [payload.get("occurred_at"), extra(event, "occurred_at"), extra(event, "created_at")].into_iter().flatten().find(|value| !value.is_null()).cloned().unwrap_or(Value::Null);
        entry.insert("concluded_at".into(), concluded);
        let mut history = history;
        history.push(Value::Object(entry));
        let keep = history.len().saturating_sub(MAX_CAMPAIGN_ARCS);
        let history: Vec<Value> = history.into_iter().skip(keep).collect();
        let mut concept = spread_field(state, "campaignConcept");
        concept.insert("arc".into(), next_arc);
        concept.insert("arc_history".into(), Value::Array(history));
        state["campaignConcept"] = Value::Object(concept);
    }
    let mut history = match state.get("adventure").and_then(|adventure| adventure.get("history")) {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    };
    let final_chapter = safe_int(payload.get("closed_arc").and_then(|arc| arc.get("final_chapter")), 1).max(1);
    history.push(json!({ "chapter": final_chapter, "summary": head(&s(payload.get("epilogue")), 600) }));
    let keep = history.len().saturating_sub(24);
    let mut adventure = spread_field(state, "adventure");
    adventure.insert("chapter".into(), json!(1));
    adventure.insert("history".into(), Value::Array(history.into_iter().skip(keep).collect()));
    state["adventure"] = Value::Object(adventure);
    // `if (state.worldMemory?.quests) state.worldMemory.quests = …filter(…)`.
    if let Some(memory) = state.get_mut("worldMemory").filter(|memory| memory.is_object()) {
        match memory.get("quests") {
            Some(Value::Array(quests)) => {
                let kept: Vec<Value> = quests.iter().filter(|quest| !s(quest.get("id")).starts_with("quest:chapter:")).cloned().collect();
                memory["quests"] = Value::Array(kept);
            }
            Some(quests) if truthy(Some(quests)) => return Err(type_error("state.worldMemory.quests.filter is not a function")),
            _ => {}
        }
    }
    sk_core::game::mechanics_mut(state).insert("encounter".into(), Value::Null);
    let mut autonomy = spread_field(state, "autonomy");
    autonomy.insert("pacing".into(), json!({ "beat": 0, "phase": "breather", "tension": 0, "policy": "campaign-pacing-one-evening-v1" }));
    autonomy.insert("director_history".into(), json!([]));
    autonomy.insert("director_outcomes".into(), json!([]));
    autonomy.insert("encounter_outcomes".into(), json!([]));
    state["autonomy"] = Value::Object(autonomy);
    let current = state.get("scene").and_then(|scene| scene.get("objective")).filter(|value| !value.is_null());
    let hook = payload.get("hook").filter(|value| !value.is_null()).or(current);
    let mut scene = spread_field(state, "scene");
    scene.insert("objective".into(), Value::from(head(&s(hook), 300)));
    state["scene"] = Value::Object(scene);
    Ok(())
}

/// `state.agentInteraction` как объект, если он есть.
fn interaction(state: &Value) -> Option<&Map<String, Value>> {
    state.get("agentInteraction").and_then(Value::as_object)
}

/// `state.agentInteraction?.id !== String(payload.interaction_id)`.
fn interaction_matches(state: &Value, event: &Event) -> bool {
    let expected = js::string(event.payload.get("interaction_id"));
    interaction(state).and_then(|interaction| interaction.get("id")).and_then(Value::as_str) == Some(expected.as_str())
}

fn is_open(state: &Value) -> bool {
    interaction(state).and_then(|interaction| interaction.get("status")).and_then(Value::as_str) == Some("open")
}

/// `state.agentInteraction.options.map((option) => String(option.id))`.
fn option_ids(state: &Value) -> Result<Vec<String>, RuleError> {
    match interaction(state).and_then(|interaction| interaction.get("options")) {
        Some(Value::Array(options)) => Ok(options.iter().map(|option| js::string(option.get("id"))).collect()),
        _ => Err(type_error("state.agentInteraction.options is not iterable")),
    }
}

/// `list.map(String)`.
fn strings(list: &[Value]) -> Value {
    Value::Array(list.iter().map(|item| Value::String(js::string(Some(item)))).collect())
}

/// Необязательные поля голосования: участники, кворум.
fn voter_fields(next: &mut Map<String, Value>, payload: &Value, abstained: bool) {
    if let Some(Value::Array(list)) = payload.get("active_voter_ids") {
        next.insert("activeVoterIds".into(), strings(list));
    }
    if let Some(Value::Array(list)) = payload.get("eligible_voter_ids") {
        next.insert("eligibleVoterIds".into(), strings(list));
    }
    if abstained {
        if let Some(Value::Array(list)) = payload.get("abstained_voter_ids") {
            next.insert("abstainedVoterIds".into(), strings(list));
        }
    }
}

fn required_votes(next: &mut Map<String, Value>, payload: &Value) {
    if is_safe_integer(payload.get("required_votes")) {
        next.insert("requiredVotes".into(), payload.get("required_votes").cloned().unwrap_or(Value::Null));
    }
}

/// `PartyDecisionOpened` (24357–24359).
pub(super) fn party_decision_opened(state: &mut Value, event: &Event) -> Reduced {
    let policy = state.get("partyDecisionPolicy").cloned();
    let interaction = event.payload.get("interaction").cloned().unwrap_or(Value::Null);
    let decision = sk_memory::party_decision::normalize_party_decision(&interaction, policy.as_ref())?;
    state["agentInteraction"] = decision;
    Ok(())
}

/// `PartyVoteCast` (24360–24378).
pub(super) fn party_vote_cast(state: &mut Value, event: &Event) -> Reduced {
    if !interaction_matches(state, event) || !is_open(state) {
        return Ok(());
    }
    let option_ids = option_ids(state)?;
    let payload = &event.payload;
    let hero_id = s(payload.get("hero_id"));
    let option_id = s(payload.get("option_id"));
    if hero_id.is_empty() || !option_ids.contains(&option_id) {
        return Ok(());
    }
    let current = interaction(state).cloned().unwrap_or_default();
    let votes = if plain_object(payload.get("votes")) {
        payload.get("votes").cloned().unwrap_or(Value::Null)
    } else {
        let mut votes = spread_value(current.get("votes"));
        votes.insert(hero_id, Value::String(option_id));
        Value::Object(votes)
    };
    let mut next = spread_value(Some(&Value::Object(current)));
    next.insert("votes".into(), votes);
    voter_fields(&mut next, payload, false);
    required_votes(&mut next, payload);
    state["agentInteraction"] = Value::Object(next);
    Ok(())
}

/// `PartyDecisionAbstained` (24379–24397).
pub(super) fn party_decision_abstained(state: &mut Value, event: &Event) -> Reduced {
    if !interaction_matches(state, event) || !is_open(state) {
        return Ok(());
    }
    let payload = &event.payload;
    let current = interaction(state).cloned().unwrap_or_default();
    let abstained = match payload.get("abstained_voter_ids") {
        Some(Value::Array(list)) => {
            let mut seen: Vec<String> = Vec::new();
            for item in list {
                let id = js::string(Some(item));
                if !seen.contains(&id) {
                    seen.push(id);
                }
            }
            Some(js::strings_value(seen))
        }
        _ => current.get("abstainedVoterIds").cloned(),
    };
    let abstentions = if plain_object(payload.get("abstentions")) {
        let mut merged = spread_value(current.get("abstentions"));
        for (key, value) in spread_value(payload.get("abstentions")) {
            merged.insert(key, value);
        }
        Some(Value::Object(merged))
    } else {
        current.get("abstentions").cloned()
    };
    let votes = if plain_object(payload.get("votes")) { payload.get("votes").cloned() } else { current.get("votes").cloned() };
    let mut next = spread_value(Some(&Value::Object(current)));
    insert_or_undefined(&mut next, "votes", votes);
    voter_fields(&mut next, payload, false);
    insert_or_undefined(&mut next, "abstainedVoterIds", abstained);
    insert_or_undefined(&mut next, "abstentions", abstentions);
    required_votes(&mut next, payload);
    state["agentInteraction"] = Value::Object(next);
    Ok(())
}

/// `{ ...x, key: value }`, где `value` может быть `undefined`: ключ остаётся
/// на месте, но в JSON его нет.
fn insert_or_undefined(next: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    match value {
        Some(value) => {
            next.insert(key.into(), value);
        }
        None => {
            next.shift_remove(key);
        }
    }
}

/// Общая часть `PartyDecisionResolved` и `PartyDecisionExpired`.
fn resolve_decision(state: &mut Value, event: &Event, expired: bool) -> Reduced {
    if !interaction_matches(state, event) || (expired && !is_open(state)) {
        return Ok(());
    }
    let payload = &event.payload;
    let option_id = s(payload.get("resolved_option_id"));
    if !option_ids(state)?.contains(&option_id) {
        return Ok(());
    }
    let current = interaction(state).cloned().unwrap_or_default();
    let votes = if plain_object(payload.get("votes")) { payload.get("votes").cloned() } else { current.get("votes").cloned() };
    let mut next = spread_value(Some(&Value::Object(current)));
    insert_or_undefined(&mut next, "votes", votes);
    next.insert("status".into(), json!("resolved"));
    next.insert("resolvedOptionId".into(), Value::String(option_id));
    voter_fields(&mut next, payload, true);
    required_votes(&mut next, payload);
    if expired {
        next.insert("resolutionReason".into(), json!("expired"));
    } else {
        if truthy(payload.get("resolution_reason")) {
            next.insert("resolutionReason".into(), Value::from(string_head(payload.get("resolution_reason"), 80)));
        }
        if plain_object(payload.get("roll")) {
            next.insert("roll".into(), payload.get("roll").cloned().unwrap_or(Value::Null));
        }
    }
    state["agentInteraction"] = Value::Object(next);
    Ok(())
}

/// `PartyDecisionResolved` (24398–24415).
pub(super) fn party_decision_resolved(state: &mut Value, event: &Event) -> Reduced {
    resolve_decision(state, event, false)
}

/// `PartyDecisionExpired` (24416–24432).
pub(super) fn party_decision_expired(state: &mut Value, event: &Event) -> Reduced {
    resolve_decision(state, event, true)
}

/// `PartyDecisionConsumed` (24433–24438).
pub(super) fn party_decision_consumed(state: &mut Value, event: &Event) -> Reduced {
    let resolved = js::string(event.payload.get("resolved_option_id"));
    let consumed = interaction_matches(state, event)
        && interaction(state).and_then(|interaction| interaction.get("resolvedOptionId")).and_then(Value::as_str) == Some(resolved.as_str());
    if consumed {
        state["agentInteraction"] = Value::Null;
    }
    Ok(())
}

/// `OfficeVacated`, `OfficeHolderInstalled`, `OfficeSuccessionSkipped` (27037–27039).
pub(super) fn world_office_event(state: &mut Value, event: &Event) -> Reduced {
    let event_json = super::social::event_value(event);
    state["world_offices"] = sk_world_life::world_offices::apply_world_office_event(state.get("world_offices"), &event_json, &js::obj());
    Ok(())
}

/// Замена состояния до `switch` (24201–24211): `LegacyStateImported` и
/// `CampaignRewound` с объектом `payload.state` возвращают нормализованную
/// копию этого состояния, без общих шагов после `switch`. `None` — событие
/// идёт обычным путём.
pub(super) fn replace_state(_state: &mut Value, event: &Event) -> Option<Reduced> {
    if !matches!(event.event_type.as_str(), "LegacyStateImported" | "CampaignRewound") {
        return None;
    }
    let replacement = event.payload.get("state");
    if !(sk_core::js::truthy(replacement) && matches!(replacement, Some(Value::Object(_) | Value::Array(_)))) {
        return None;
    }
    Some(Err(unported(&format!("reduce:{}", event.event_type))))
}

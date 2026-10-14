//! Перенос `server/party-decision.mjs`: решения отряда.
//!
//! Голосование (`vote`), выбор (`choice`) и общий бросок (`roll`) живут в
//! `state.agentInteraction`. Модуль нормализует решение и политику, строит
//! событие открытия, принимает голос, воздержание и уход участника, решает
//! кворум, истечение срока и общий бросок, а исполнимый исход решения по
//! поручению (`ResolveQuestDecision`) превращает в события `QuestAccepted`,
//! `QuestResolved` и `PartyDecisionConsumed`. Редьюсер этих событий — в Rules
//! Engine; здесь только чистые функции над JSON той же формы, что в JS.

use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::{clock, js, text as jstext};
use sk_society::campaign_stories::{campaign_mode_for, persistent_story_quest};
use sk_society::quest_consequences::quest_is_impossible;

use crate::jsv::{array, at, coalesce, entries, get, is_num, is_str, js_order, keys, lower, or, put, s, safe_id, spread, spread_object, strict_eq, string, strings_value, tpl, unique};
use crate::world_memory::{validate_world_memory_command, world_memory_event, WorldMemoryValidationError, QUEST_ABANDONMENT_NEXT_OBJECTIVE};

const TYPES: [&str; 3] = ["vote", "roll", "choice"];

/// Версия политики решений отряда (`PARTY_DECISION_POLICY_VERSION`).
pub const PARTY_DECISION_POLICY_VERSION: &str = "skazanie:party-decision-policy:v1";

/// Политика по умолчанию (`DEFAULT_PARTY_DECISION_POLICY`).
pub static DEFAULT_PARTY_DECISION_POLICY: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "schemaVersion": 1,
        "policyVersion": PARTY_DECISION_POLICY_VERSION,
        "voterScope": "account",
        "decisionTtlMs": 120_000,
        "quorumMode": "majority_of_active_voters",
        "disconnectAction": "abstain",
        "expiryResolution": "plurality_first_option",
        "visibility": "party",
    })
});

const DEFAULT_TTL_MS: i64 = 120_000;

/// Отказ решения отряда (`PartyDecisionError`): код и текст.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct PartyDecisionError {
    pub code: String,
    pub message: String,
}

impl PartyDecisionError {
    /// Отказ с кодом по умолчанию `INVALID_PARTY_DECISION`.
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(message, "INVALID_PARTY_DECISION")
    }

    pub fn new(message: impl Into<String>, code: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

impl From<PartyDecisionError> for sk_core::RuleError {
    fn from(error: PartyDecisionError) -> Self {
        sk_core::RuleError::new(error.code, error.message)
    }
}

/// Отказ исполнения решения по поручению: своё правило решения или проверка
/// команды памяти мира, которую `questDecisionEvents` вызывает внутри.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum QuestDecisionError {
    #[error(transparent)]
    Party(#[from] PartyDecisionError),
    #[error(transparent)]
    WorldMemory(#[from] WorldMemoryValidationError),
}

impl QuestDecisionError {
    pub fn code(&self) -> &str {
        match self {
            Self::Party(error) => &error.code,
            Self::WorldMemory(error) => &error.code,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::Party(error) => &error.message,
            Self::WorldMemory(error) => &error.message,
        }
    }
}

type Decided<T> = Result<T, PartyDecisionError>;

fn id(value: Option<&Value>, label: &str) -> Decided<String> {
    let normalized = jstext::trim(&s(value)).to_string();
    if !safe_id(&normalized) {
        return Err(PartyDecisionError::invalid(format!("{label} содержит недопустимый идентификатор")));
    }
    Ok(normalized)
}

/// `String(value ?? fallback).normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)`.
fn text(value: Option<&Value>, maximum: usize, fallback: &str) -> String {
    let source = match value {
        None | Some(Value::Null) => fallback.to_string(),
        some => s(some),
    };
    jstext::head(&jstext::squash_spaces(&jstext::nfkc(&source)), maximum)
}

/// `[...new Set(list.map(String).filter(SAFE_ID.test))].slice(0, maximum)`.
fn unique_ids(value: Option<&Value>, maximum: usize) -> Vec<String> {
    unique(array(value).iter().map(|item| string(Some(item))).filter(|candidate| safe_id(candidate))).into_iter().take(maximum).collect()
}

fn ids(value: Option<&Value>) -> Vec<String> {
    unique_ids(value, 20)
}

fn safe_number(value: Option<&Value>, fallback: i64) -> i64 {
    js::safe_int(value, fallback)
}

/// Целое как JSON-число так, как его печатает JS (сумма может выйти за 2^53).
fn integer_value(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9.2e18 {
        Value::from(value as i64)
    } else {
        js::num(value)
    }
}

/// Нормализованная политика решений (`normalizePartyDecisionPolicy`).
pub fn normalize_party_decision_policy(value: Option<&Value>) -> Value {
    let source = match value {
        Some(Value::Object(_)) => value,
        _ => None,
    };
    let raw_ttl = coalesce(get(source, "decisionTtlMs"), coalesce(get(source, "decision_ttl_ms"), get(source, "ttlMs")));
    let hero = is_str(get(source, "voterScope"), "hero") || is_str(get(source, "voter_scope"), "hero");
    json!({
        "schemaVersion": 1,
        "policyVersion": PARTY_DECISION_POLICY_VERSION,
        "voterScope": if hero { "hero" } else { "account" },
        "decisionTtlMs": safe_number(raw_ttl, DEFAULT_TTL_MS).clamp(1_000, 30 * 60 * 1_000),
        "quorumMode": "majority_of_active_voters",
        "disconnectAction": "abstain",
        "expiryResolution": "plurality_first_option",
        "visibility": "party",
    })
}

fn required_votes_for(kind: Option<&Value>, voter_count: usize) -> i64 {
    if is_str(kind, "choice") {
        return i64::from(voter_count > 0);
    }
    if voter_count > 0 {
        (voter_count / 2) as i64 + 1
    } else {
        0
    }
}

/// Кто голосует за героя: аккаунт (`hero:<id>` по умолчанию) или сам герой.
fn normalized_voter_map(value: Option<&Value>, eligible_actor_ids: &[String], voter_scope: &str) -> Map<String, Value> {
    let source = match value {
        Some(Value::Object(map)) => Some(map),
        _ => None,
    };
    let mut result = Map::new();
    for actor_id in eligible_actor_ids {
        let candidate = jstext::trim(&s(source.and_then(|map| map.get(actor_id)))).to_string();
        let voter = if safe_id(&candidate) {
            candidate
        } else if voter_scope == "account" {
            format!("hero:{actor_id}")
        } else {
            actor_id.clone()
        };
        result.insert(actor_id.clone(), Value::String(voter));
    }
    js_order(result)
}

fn normalized_abstentions(value: Option<&Value>, eligible_voter_ids: &[String]) -> Map<String, Value> {
    let source = match value {
        Some(Value::Object(_)) => value,
        _ => None,
    };
    let result: Map<String, Value> = entries(source)
        .into_iter()
        .map(|(voter_id, reason)| (voter_id, Value::String(text(Some(&reason), 80, "abstain"))))
        .filter(|(voter_id, _)| safe_id(voter_id) && (eligible_voter_ids.is_empty() || eligible_voter_ids.contains(voter_id)))
        .take(20)
        .collect();
    js_order(result)
}

fn voter_of(map: &Map<String, Value>, actor_id: &str) -> String {
    match map.get(actor_id) {
        Some(Value::Null) | None => actor_id.to_string(),
        Some(value) => s(Some(value)),
    }
}

fn quest_reference(value: Option<&Value>) -> Decided<Option<Value>> {
    if !is_num(get(value, "schemaVersion"), 1.0) {
        return Ok(None);
    }
    Ok(Some(json!({ "schemaVersion": 1, "questId": id(get(value, "questId"), "Задание")? })))
}

/// Нормализованное решение отряда (`normalizePartyDecision`): допустимые
/// варианты, участники и голосующие, воздержавшиеся, голоса без подделок,
/// кворум, срок и политика. `policy` — `None`, как `{ policy: null }`.
pub fn normalize_party_decision(value: &Value, policy: Option<&Value>) -> Decided<Value> {
    let Value::Object(map) = value else {
        return Err(PartyDecisionError::invalid("Групповое решение должно быть объектом"));
    };
    let field = |key: &str| map.get(key);
    let decision_id = id(field("id"), "Решение")?;
    let kind = match field("type").and_then(Value::as_str) {
        Some(kind) if TYPES.contains(&kind) => kind.to_string(),
        _ => "vote".to_string(),
    };
    let kind_value = Value::String(kind.clone());
    let decision_policy = normalize_party_decision_policy(coalesce(policy, field("policy")));
    let voter_scope = s(decision_policy.get("voterScope"));
    let mut options: Vec<(String, String)> = Vec::new();
    for option in array(field("options")).iter().take(6) {
        options.push((id(get(Some(option), "id"), "Вариант решения")?, text(get(Some(option), "label"), 180, "")));
    }
    if options.is_empty() || options.iter().any(|(_, label)| label.is_empty()) {
        return Err(PartyDecisionError::invalid("Групповое решение не содержит допустимых вариантов"));
    }
    let option_ids: Vec<String> = options.iter().map(|(option_id, _)| option_id.clone()).collect();
    if unique(option_ids.iter().cloned()).len() != option_ids.len() {
        return Err(PartyDecisionError::invalid("Идентификаторы вариантов решения должны быть уникальны"));
    }
    let eligible_actor_ids = ids(coalesce(field("eligibleActorIds"), field("eligible_actor_ids")));
    let voter_by_actor_id = normalized_voter_map(coalesce(field("voterByActorId"), field("voter_by_actor_id")), &eligible_actor_ids, &voter_scope);
    let derived = strings_value(&eligible_actor_ids.iter().map(|actor| voter_of(&voter_by_actor_id, actor)).filter(|voter| !voter.is_empty()).collect::<Vec<_>>());
    let eligible_voter_ids = ids(coalesce(field("eligibleVoterIds"), coalesce(field("eligible_voter_ids"), Some(&derived))));
    let empty = json!({});
    let abstention_input = coalesce(field("abstentions"), coalesce(field("abstentionReasons"), Some(&empty)));
    let abstentions = normalized_abstentions(abstention_input, &eligible_voter_ids);
    let abstention_keys = strings_value(&keys(&abstentions));
    let abstained_voter_ids: Vec<String> = ids(coalesce(field("abstainedVoterIds"), coalesce(field("abstained_voter_ids"), Some(&abstention_keys))))
        .into_iter()
        .filter(|voter| eligible_voter_ids.is_empty() || eligible_voter_ids.contains(voter))
        .collect();
    let default_active = strings_value(&eligible_voter_ids.iter().filter(|voter| !abstained_voter_ids.contains(voter)).cloned().collect::<Vec<_>>());
    let active_voter_ids: Vec<String> = ids(coalesce(field("activeVoterIds"), coalesce(field("active_voter_ids"), Some(&default_active))))
        .into_iter()
        .filter(|voter| eligible_voter_ids.is_empty() || eligible_voter_ids.contains(voter))
        .filter(|voter| !abstained_voter_ids.contains(voter))
        .collect();
    let mut votes = Map::new();
    for (actor_id, option_id) in entries(coalesce(field("votes"), Some(&empty))) {
        let option_id = string(Some(&option_id));
        if !safe_id(&actor_id) || !option_ids.contains(&option_id) {
            continue;
        }
        if !eligible_actor_ids.is_empty() && !eligible_actor_ids.contains(&actor_id) {
            continue;
        }
        let voter_id = voter_of(&voter_by_actor_id, &actor_id);
        if abstained_voter_ids.contains(&voter_id) || (!active_voter_ids.is_empty() && !active_voter_ids.contains(&voter_id)) {
            continue;
        }
        for previous in keys(&votes) {
            if voter_of(&voter_by_actor_id, &previous) == voter_id {
                votes.shift_remove(&previous);
            }
        }
        votes.insert(actor_id, Value::String(option_id));
    }
    let resolved_option_id = match field("resolvedOptionId") {
        None | Some(Value::Null) => None,
        some => Some(string(some)),
    };
    let resolved = is_str(field("status"), "resolved") && resolved_option_id.as_ref().is_some_and(|option| option_ids.contains(option));
    let created_at = safe_number(coalesce(field("createdAt"), field("created_at")), 0).max(0);
    let raw_expires_at = safe_number(coalesce(field("expiresAt"), field("expires_at")), 0);
    let ttl = decision_policy["decisionTtlMs"].as_i64().unwrap_or(DEFAULT_TTL_MS);
    let expires_at = if raw_expires_at > 0 {
        json!(created_at.max(raw_expires_at))
    } else if created_at > 0 {
        integer_value(created_at as f64 + ttl as f64)
    } else {
        json!(0)
    };
    let counted = if active_voter_ids.is_empty() { eligible_voter_ids.len() } else { active_voter_ids.len() };
    let calculated_required = required_votes_for(Some(&kind_value), counted);
    let raw_required = safe_number(coalesce(field("requiredVotes"), field("required_votes")), calculated_required);
    let required_votes = raw_required.min(counted as i64).max(0);
    let destination = text(coalesce(field("destinationLocationId"), field("destination_location_id")), 120, "");
    let mut result = Map::new();
    result.insert("id".into(), Value::String(decision_id));
    result.insert("type".into(), kind_value);
    result.insert("title".into(), Value::String(text(field("title"), 100, "Решение отряда")));
    result.insert("description".into(), Value::String(text(field("description"), 360, "")));
    result.insert("options".into(), Value::Array(options.iter().map(|(option_id, label)| json!({ "id": option_id, "label": label })).collect()));
    result.insert("votes".into(), Value::Object(js_order(votes)));
    result.insert("status".into(), json!(if resolved { "resolved" } else { "open" }));
    if resolved {
        result.insert("resolvedOptionId".into(), Value::String(resolved_option_id.unwrap_or_default()));
    }
    result.insert("eligibleActorIds".into(), strings_value(&eligible_actor_ids));
    result.insert("eligibleVoterIds".into(), strings_value(&eligible_voter_ids));
    result.insert("voterByActorId".into(), Value::Object(voter_by_actor_id));
    result.insert("activeVoterIds".into(), strings_value(&active_voter_ids));
    result.insert("abstainedVoterIds".into(), strings_value(&abstained_voter_ids));
    result.insert("abstentions".into(), Value::Object(abstentions));
    result.insert("requiredVotes".into(), json!(required_votes));
    result.insert("voterScope".into(), Value::String(voter_scope));
    result.insert("policy".into(), decision_policy);
    result.insert("policyVersion".into(), json!(PARTY_DECISION_POLICY_VERSION));
    if kind == "roll" {
        result.insert("difficulty".into(), json!(safe_number(field("difficulty"), 12).clamp(5, 25)));
    }
    if js::truthy(field("roll")) && matches!(field("roll"), Some(Value::Object(_) | Value::Array(_))) {
        result.insert("roll".into(), field("roll").cloned().unwrap_or(Value::Null));
    }
    if !destination.is_empty() {
        result.insert("destinationLocationId".into(), Value::String(destination));
    }
    if let Some(reference) = quest_reference(field("questAbandonment"))? {
        result.insert("questAbandonment".into(), reference);
    }
    if let Some(reference) = quest_reference(field("questAcceptance"))? {
        result.insert("questAcceptance".into(), reference);
    }
    result.insert("resolutionPrompt".into(), Value::String(text(field("resolutionPrompt"), 360, "")));
    result.insert("createdAt".into(), json!(created_at));
    result.insert("expiresAt".into(), expires_at);
    if js::truthy(field("resolutionReason")) {
        result.insert("resolutionReason".into(), Value::String(text(field("resolutionReason"), 80, "")));
    }
    Ok(Value::Object(result))
}

/// Объект события с полями в порядке JS.
fn draft(pairs: Vec<(&str, Value)>) -> Value {
    Value::Object(pairs.into_iter().map(|(key, value)| (key.to_string(), value)).collect())
}

/// Исполнимый исход сохранённого решения по поручению
/// (`questDecisionEvents`): подпись кнопки не задаёт механику. Принять,
/// отложить, оставить или отказаться — и затем `PartyDecisionConsumed`.
pub fn quest_decision_events(command: &Value, state: &Value, context: &Value) -> Result<Vec<Value>, QuestDecisionError> {
    if !js::is_true(get(Some(context), "isDirector")) {
        return Err(PartyDecisionError::new("Решение исполняет только сервер", "QUEST_DECISION_FORBIDDEN").into());
    }
    let interaction = get(Some(state), "agentInteraction");
    let acceptance = get(interaction, "questAcceptance");
    let abandonment = get(interaction, "questAbandonment");
    if (!js::truthy(abandonment) && !js::truthy(acceptance))
        || !is_str(get(interaction, "status"), "resolved")
        || !strict_eq(get(interaction, "id"), get(Some(command), "interaction_id"))
    {
        return Err(PartyDecisionError::new("Нет завершённого решения по этому заданию", "PARTY_DECISION_REQUIRED").into());
    }
    let resolved_option = get(interaction, "resolvedOptionId");
    let allowed: [&str; 2] = if js::truthy(acceptance) { ["later", "accept"] } else { ["keep", "abandon"] };
    if !allowed.iter().any(|option| is_str(resolved_option, option)) {
        return Err(PartyDecisionError::new("Неизвестный исход решения", "PARTY_DECISION_CONFLICT").into());
    }
    let quest_id_value = get(coalesce(acceptance, abandonment), "questId").cloned();
    let quest_id = s(quest_id_value.as_ref());
    let quests = array(get(get(Some(state), "worldMemory"), "quests"));
    let quest = quests.iter().find(|entry| strict_eq(get(Some(entry), "id"), quest_id_value.as_ref()));
    let quest_field = |key: &str| get(quest, key);
    let mut party_decision = Map::new();
    put(&mut party_decision, "interaction_id", get(interaction, "id"));
    put(&mut party_decision, "resolved_option_id", resolved_option);
    let party_decision = Value::Object(party_decision);
    let shared = |visibility: Option<&Value>| is_str(visibility, "public") || is_str(visibility, "party");
    let mut events = Vec::new();
    if js::truthy(acceptance)
        && is_str(resolved_option, "accept")
        && !quest_is_impossible(state, quest)
        && (is_str(quest_field("status"), "offered") || is_str(quest_field("status"), "active"))
        && shared(quest_field("visibility"))
        && !quest_id.starts_with("quest:chapter:")
    {
        let active = is_str(quest_field("status"), "active");
        let title = tpl(quest_field("title"));
        let objective = at(quest_field("objectives"), 0);
        let mut event = Map::new();
        event.insert("event_type".into(), json!("QuestAccepted"));
        if let Some(visibility) = quest_field("visibility") {
            event.insert("visibility".into(), visibility.clone());
        }
        event.insert("target_ids".into(), json!([]));
        let mut payload = Map::new();
        payload.insert("schema_version".into(), json!(1));
        put(&mut payload, "quest_id", quest_id_value.as_ref());
        payload.insert("selection_only".into(), json!(active));
        payload.insert("selected_as_story".into(), json!(campaign_mode_for(state) == "persistent" && persistent_story_quest(state).is_none()));
        payload.insert("objective".into(), Value::String(text(or(objective.as_ref(), quest_field("title")), 300, "")));
        payload.insert(
            "summary".into(),
            Value::String(if active { format!("Отряд выбрал основной историей задание «{title}».") } else { format!("Отряд принял задание «{title}».") }),
        );
        payload.insert("party_decision".into(), party_decision.clone());
        event.insert("payload".into(), Value::Object(payload));
        events.push(Value::Object(event));
    }
    if is_str(resolved_option, "abandon") && is_str(quest_field("status"), "active") && shared(quest_field("visibility")) {
        let next_objective = QUEST_ABANDONMENT_NEXT_OBJECTIVE;
        let mut texts: Vec<Value> = vec![quest_field("title").cloned().unwrap_or(Value::Null), quest_field("summary").cloned().unwrap_or(Value::Null)];
        texts.extend(spread(coalesce(quest_field("objectives"), None)));
        let quest_texts: Vec<String> = texts.iter().map(|entry| lower(&text(Some(entry), 1_000, ""))).filter(|entry| !entry.is_empty()).collect();
        let replaces_objective = [get(get(Some(state), "scene"), "objective"), get(get(Some(state), "adventure"), "currentHook")]
            .iter()
            .any(|entry| quest_texts.contains(&lower(&text(*entry, 1_000, ""))));
        let mut resolve = spread_object(Some(command));
        resolve.insert("command_type".into(), json!("ResolveQuest"));
        resolve.insert("quest_id".into(), quest_id_value.clone().unwrap_or(Value::Null));
        resolve.insert("outcome".into(), json!("abandoned"));
        resolve.insert("summary".into(), Value::String(format!("Отряд отказался от задания «{}» и остался в текущей локации.", tpl(quest_field("title")))));
        resolve.insert("next_objective".into(), json!(next_objective));
        let resolved = validate_world_memory_command(&Value::Object(js_order(resolve)), state, context)?;
        let world_event = world_memory_event(&resolved).unwrap_or_else(|| json!({}));
        let mut event = spread_object(Some(&world_event));
        match quest_field("visibility") {
            Some(visibility) => {
                event.insert("visibility".into(), visibility.clone());
            }
            None => {
                event.shift_remove("visibility");
            }
        }
        let mut payload = spread_object(world_event.get("payload"));
        payload.insert("event_schema_version".into(), json!(2));
        payload.insert("stay_in_location".into(), json!(true));
        payload.insert("updates_scene_objective".into(), json!(replaces_objective));
        payload.insert("party_decision".into(), party_decision.clone());
        event.insert("payload".into(), Value::Object(payload));
        events.push(Value::Object(event));
        // Служебный квест зеркалит цель сцены; он не должен возвращать
        // оставленное поручение в brief и в журнал под видом активного.
        let chapter = format!("quest:chapter:{}", tpl(get(get(Some(state), "adventure"), "chapter")));
        let scene_quest = quests.iter().find(|entry| is_str(get(Some(entry), "id"), &chapter));
        if replaces_objective && is_str(get(scene_quest, "status"), "active") && !strict_eq(get(scene_quest, "id"), quest_id_value.as_ref()) {
            let mut upserted = spread_object(scene_quest);
            upserted.insert("title".into(), json!(next_objective));
            upserted.insert("summary".into(), json!(next_objective));
            upserted.insert("objectives".into(), json!([next_objective]));
            let mut event = Map::new();
            event.insert("event_type".into(), json!("QuestUpserted"));
            if let Some(visibility) = get(scene_quest, "visibility") {
                event.insert("visibility".into(), visibility.clone());
            }
            event.insert("target_ids".into(), json!([]));
            event.insert("payload".into(), json!({ "quest": Value::Object(js_order(upserted)) }));
            events.push(Value::Object(event));
        }
    }
    let mut consumed = Map::new();
    put(&mut consumed, "interaction_id", get(interaction, "id"));
    put(&mut consumed, "resolved_option_id", resolved_option);
    put(&mut consumed, "quest_id", quest_id_value.as_ref());
    events.push(draft(vec![
        ("event_type", json!("PartyDecisionConsumed")),
        ("visibility", json!("party")),
        ("target_ids", json!([])),
        ("payload", Value::Object(consumed)),
    ]));
    Ok(events)
}

/// Герои отряда: `partyMemberIds`, иначе id игроков (`String(undefined)` у
/// игрока без id — как в JS).
fn party_ids(state: &Value) -> Vec<String> {
    match get(Some(state), "partyMemberIds") {
        Some(Value::Array(items)) if !items.is_empty() => unique(items.iter().map(|item| string(Some(item)))),
        _ => unique(array(get(Some(state), "players")).iter().map(|player| string(get(Some(player), "id")))),
    }
}

/// Участники решения (`participantContext`).
#[derive(Clone)]
struct Participants {
    eligible_actors: Vec<String>,
    voter_by_actor_id: Map<String, Value>,
    eligible_voters: Vec<String>,
    abstained_voters: Vec<String>,
    active_voters: Vec<String>,
    required: i64,
}

impl Participants {
    fn voter_for(&self, actor_id: &str) -> String {
        voter_of(&self.voter_by_actor_id, actor_id)
    }
}

/// `value?.length` истинно: непустой массив или строка, объект с полем `length`.
fn non_empty_list(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Object(map)) => js::truthy(map.get("length")),
        _ => false,
    }
}

fn participant_context(interaction: &Value, eligible_hero_ids: &[String]) -> Participants {
    let field = |key: &str| get(Some(interaction), key);
    let snapshotted = ids(field("eligibleActorIds"));
    let eligible_actors = if snapshotted.is_empty() { unique_ids(Some(&strings_value(eligible_hero_ids)), 20) } else { snapshotted };
    let voter_by_actor_id = normalized_voter_map(field("voterByActorId"), &eligible_actors, &s(field("voterScope")));
    let derived = strings_value(&eligible_actors.iter().map(|actor| voter_of(&voter_by_actor_id, actor)).collect::<Vec<_>>());
    let eligible_voters = ids(if non_empty_list(field("eligibleVoterIds")) { field("eligibleVoterIds") } else { Some(&derived) });
    let abstained_voters = ids(field("abstainedVoterIds"));
    let default_active = strings_value(&eligible_voters.iter().filter(|voter| !abstained_voters.contains(voter)).cloned().collect::<Vec<_>>());
    let active_voters: Vec<String> = ids(if non_empty_list(field("activeVoterIds")) { field("activeVoterIds") } else { Some(&default_active) })
        .into_iter()
        .filter(|voter| !abstained_voters.contains(voter))
        .collect();
    let required = if non_empty_list(field("eligibleActorIds")) || non_empty_list(field("eligibleVoterIds")) {
        js::safe_int(field("requiredVotes"), 0)
    } else {
        let counted = if active_voters.is_empty() { eligible_voters.len() } else { active_voters.len() };
        required_votes_for(field("type"), counted)
    };
    Participants { eligible_actors, voter_by_actor_id, eligible_voters, abstained_voters, active_voters, required }
}

fn options_of(interaction: &Value) -> Vec<String> {
    array(get(Some(interaction), "options")).iter().map(|option| s(get(Some(option), "id"))).collect()
}

/// Голоса без посторонних, воздержавшихся и повторов одного голосующего
/// (`cleanVotes`).
fn clean_votes(interaction: &Value, context: &Participants, include_inactive: bool) -> Map<String, Value> {
    let options = options_of(interaction);
    let empty = json!({});
    let mut votes = Map::new();
    for (actor_id, option_id) in entries(coalesce(get(Some(interaction), "votes"), Some(&empty))) {
        if !context.eligible_actors.contains(&actor_id) {
            continue;
        }
        let voter_id = context.voter_for(&actor_id);
        if !include_inactive && !context.active_voters.is_empty() && !context.active_voters.contains(&voter_id) {
            continue;
        }
        if context.abstained_voters.contains(&voter_id) {
            continue;
        }
        let option_id = string(Some(&option_id));
        if !options.contains(&option_id) {
            continue;
        }
        for previous in keys(&votes) {
            if context.voter_for(&previous) == voter_id {
                votes.shift_remove(&previous);
            }
        }
        votes.insert(actor_id, Value::String(option_id));
    }
    votes
}

/// Победивший вариант (`winnerFor`): по кворуму или, без кворума, по
/// большинству с первым вариантом при равенстве.
fn winner_for(interaction: &Value, context: &Participants, votes: &Map<String, Value>, require_quorum: bool) -> Option<String> {
    let options = options_of(interaction);
    let mut counts: Vec<(String, i64)> = Vec::new();
    for option in &options {
        if !counts.iter().any(|(id, _)| id == option) {
            counts.push((option.clone(), 0));
        }
    }
    for (actor_id, option_id) in js::entries(votes) {
        let voter_id = context.voter_for(actor_id);
        if !context.active_voters.is_empty() && !context.active_voters.contains(&voter_id) {
            continue;
        }
        let option_id = s(Some(option_id));
        if let Some((_, count)) = counts.iter_mut().find(|(id, _)| *id == option_id) {
            *count += 1;
        }
    }
    let count_of = |option: &str| counts.iter().find(|(id, _)| id == option).map(|(_, count)| *count).unwrap_or(0);
    if !require_quorum {
        let highest = counts.iter().map(|(_, count)| *count).fold(0, i64::max);
        return options.iter().find(|option| count_of(option) == highest).or(options.first()).cloned();
    }
    options.iter().find(|option| count_of(option) >= context.required).cloned()
}

fn party_decision_event(event_type: &str, actor_id: Option<&str>, context: &Participants, payload: Vec<(&str, Value)>) -> Value {
    let mut body = Map::new();
    body.insert("eligible_hero_ids".into(), strings_value(&context.eligible_actors));
    body.insert("eligible_voter_ids".into(), strings_value(&context.eligible_voters));
    body.insert("active_voter_ids".into(), strings_value(&context.active_voters));
    body.insert("required_votes".into(), json!(context.required));
    for (key, value) in payload {
        body.insert(key.to_string(), value);
    }
    draft(vec![
        ("event_type", json!(event_type)),
        ("actor_id", actor_id.map(|actor| json!(actor)).unwrap_or(Value::Null)),
        ("visibility", json!("party")),
        ("target_ids", strings_value(&context.eligible_actors)),
        ("source_rule_ids", json!([])),
        ("payload", Value::Object(body)),
    ])
}

fn votes_value(votes: &Map<String, Value>) -> Value {
    Value::Object(js_order(votes.clone()))
}

/// Событие открытия решения (`partyDecisionOpenedEvent`): поддельные голоса
/// и исход отбрасываются, участники и голосующие снимаются на момент
/// открытия. `actor_id` — инициатор (`None` или ложное значение — без него);
/// `options` — `{ eligibleHeroIds, eligibleVoterIds, voterByHeroId, policy }`.
/// Без `createdAt` у решения время открытия — текущее.
pub fn party_decision_opened_event(interaction: &Value, actor_id: Option<&Value>, options: &Value) -> Decided<Value> {
    let option = |key: &str| get(Some(options), key);
    let decision_policy = normalize_party_decision_policy(coalesce(option("policy"), get(Some(interaction), "policy")));
    let eligible_actor_ids = ids(option("eligibleHeroIds"));
    let mapped_voters = normalized_voter_map(option("voterByHeroId"), &eligible_actor_ids, &s(decision_policy.get("voterScope")));
    let derived = strings_value(&eligible_actor_ids.iter().map(|hero| voter_of(&mapped_voters, hero)).collect::<Vec<_>>());
    let voters = ids(if non_empty_list(option("eligibleVoterIds")) { option("eligibleVoterIds") } else { Some(&derived) });
    let created_at = safe_number(coalesce(get(Some(interaction), "createdAt"), get(Some(interaction), "created_at")), clock::now_ms()).max(0);
    let kind = get(Some(interaction), "type");
    let required_votes = if is_str(kind, "choice") { 1 } else { required_votes_for(kind, voters.len()) };
    let ttl = decision_policy["decisionTtlMs"].as_i64().unwrap_or(DEFAULT_TTL_MS);
    let mut source = spread_object(Some(interaction));
    source.insert("votes".into(), json!({}));
    source.insert("status".into(), json!("open"));
    source.shift_remove("roll");
    source.insert("eligibleActorIds".into(), strings_value(&eligible_actor_ids));
    source.insert("eligibleVoterIds".into(), strings_value(&voters));
    source.insert("voterByActorId".into(), Value::Object(mapped_voters));
    source.insert("activeVoterIds".into(), strings_value(&voters));
    source.insert("abstainedVoterIds".into(), json!([]));
    source.insert("abstentions".into(), json!({}));
    source.insert("requiredVotes".into(), json!(required_votes));
    source.insert("policy".into(), decision_policy.clone());
    source.insert("createdAt".into(), json!(created_at));
    source.insert("expiresAt".into(), integer_value(created_at as f64 + ttl as f64));
    // Литерал события JS вычисляет `actor_id` раньше `payload`: при двух
    // ошибках отказ — об инициаторе.
    let actor = if js::truthy(actor_id) { Value::String(id(actor_id, "Инициатор")?) } else { Value::Null };
    let normalized = normalize_party_decision(&Value::Object(js_order(source)), Some(&decision_policy))?;
    Ok(draft(vec![
        ("event_type", json!("PartyDecisionOpened")),
        ("actor_id", actor),
        ("visibility", json!("party")),
        ("target_ids", json!([])),
        ("source_rule_ids", json!([])),
        ("payload", json!({ "interaction": normalized })),
    ]))
}

fn validate_party_vote_state(state: &Value, interaction_id: Option<&Value>, kind: Option<&str>) -> Decided<Value> {
    let interaction = normalize_party_decision(get(Some(state), "agentInteraction").unwrap_or(&Value::Null), None)?;
    if s(interaction.get("id")) != id(interaction_id, "Решение")? {
        return Err(PartyDecisionError::new("Групповое решение устарело", "PARTY_DECISION_CONFLICT"));
    }
    if !is_str(interaction.get("status"), "open") || kind.is_some_and(|kind| !is_str(interaction.get("type"), kind)) {
        let message = if kind == Some("roll") { "Общий бросок уже завершён или сейчас не требуется" } else { "Голосование уже завершено или не принимает голоса" };
        return Err(PartyDecisionError::new(message, "PARTY_DECISION_CLOSED"));
    }
    Ok(interaction)
}

fn assert_hero_in_party(state: &Value, hero_id: Option<&Value>) -> Decided<String> {
    let actor = id(hero_id, "Герой")?;
    if !party_ids(state).contains(&actor) {
        return Err(PartyDecisionError::new("Герой не входит в отряд", "ACTOR_FORBIDDEN"));
    }
    Ok(actor)
}

fn assert_participant(context: &Participants, actor: &str, message: &str) -> Decided<String> {
    if !context.eligible_actors.is_empty() && !context.eligible_actors.iter().any(|candidate| candidate == actor) {
        return Err(PartyDecisionError::new(message, "ACTOR_FORBIDDEN"));
    }
    let voter_id = context.voter_for(actor);
    if !context.active_voters.is_empty() && !context.active_voters.contains(&voter_id) {
        return Err(PartyDecisionError::new("Этот участник уже воздержался", "PARTY_DECISION_ABSTAINED"));
    }
    Ok(voter_id)
}

/// Общий бросок (`resolvePartyRoll`): один серверный d20 решает исход —
/// первый вариант при успехе, второй при провале. `input` —
/// `{ interactionId, heroId, roll }`; ответ — `{ resolvedOptionId, roll, events }`.
pub fn resolve_party_roll(state: &Value, input: &Value) -> Decided<Value> {
    let field = |key: &str| get(Some(input), key);
    let interaction = validate_party_vote_state(state, field("interactionId"), Some("roll"))?;
    let actor = assert_hero_in_party(state, field("heroId"))?;
    let context = participant_context(&interaction, &party_ids(state));
    assert_participant(&context, &actor, "Герой не участвовал при открытии общего броска")?;
    let roll = field("roll");
    let total = js::number(get(roll, "total"));
    let die = match coalesce(at(get(roll, "dice"), 0).as_ref(), None) {
        Some(value) => js::number(Some(value)),
        None => total,
    };
    let safe = |value: f64| value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0;
    if !safe(total) || !(1.0..=20.0).contains(&total) || !safe(die) || !(1.0..=20.0).contains(&die) {
        return Err(PartyDecisionError::new("Серверный результат общего броска недопустим", "INVALID_PARTY_ROLL"));
    }
    let difficulty = js::number(interaction.get("difficulty"));
    let success = total >= difficulty;
    let options = options_of(&interaction);
    let winner = options.get(if success { 0 } else { 1 }).or(options.first()).cloned().unwrap_or_default();
    let player = array(get(Some(state), "players")).iter().find(|candidate| s(get(Some(candidate), "id")) == actor);
    let rolled_at = clock::parse_iso(&s(get(roll, "created_at"))).unwrap_or(0);
    let roll_id = s(coalesce(get(roll, "roll_id"), get(roll, "id")));
    let resolved_roll = json!({
        "id": roll_id,
        "roll_id": roll_id,
        "kind": "party",
        "expression": "1d20",
        "sides": 20,
        "value": js::num(die),
        "total": js::num(total),
        "playerId": actor,
        "playerName": text(coalesce(get(player, "character"), get(player, "name")), 120, "Герой"),
        "rolledAt": rolled_at,
        "purpose": "party_decision",
    });
    let die_rolled = draft(vec![
        ("event_type", json!("DieRolled")),
        ("actor_id", json!(actor)),
        ("visibility", json!("party")),
        ("target_ids", strings_value(&context.eligible_actors)),
        ("source_rule_ids", json!([])),
        ("payload", json!({ "roll_id": roll_id, "expression": "1d20", "dice": [js::num(die)], "modifier": 0, "total": js::num(total), "purpose": "party_decision" })),
    ]);
    let resolved = party_decision_event(
        "PartyDecisionResolved",
        Some(&actor),
        &context,
        vec![
            ("interaction_id", interaction["id"].clone()),
            ("resolved_option_id", json!(winner)),
            ("votes", json!({})),
            ("abstained_voter_ids", strings_value(&context.abstained_voters)),
            ("resolution_reason", json!("roll")),
            ("required_votes", json!(1)),
            ("difficulty", interaction.get("difficulty").cloned().unwrap_or(Value::Null)),
            ("success", json!(success)),
            ("roll", resolved_roll.clone()),
        ],
    );
    Ok(json!({ "resolvedOptionId": winner, "roll": resolved_roll, "events": [die_rolled, resolved] }))
}

/// Голос героя (`resolvePartyVote`): прежний голос того же голосующего
/// заменяется; кворум завершает решение в том же пакете. `input` —
/// `{ interactionId, heroId, optionId, eligibleHeroIds }`; ответ —
/// `{ events, votes, required, resolvedOptionId }`.
pub fn resolve_party_vote(state: &Value, input: &Value) -> Decided<Value> {
    let field = |key: &str| get(Some(input), key);
    let interaction = validate_party_vote_state(state, field("interactionId"), None)?;
    if is_str(interaction.get("type"), "roll") {
        return Err(PartyDecisionError::new("Общий бросок не принимает голоса", "PARTY_DECISION_CLOSED"));
    }
    let voter = assert_hero_in_party(state, field("heroId"))?;
    let selected = id(field("optionId"), "Вариант")?;
    if !options_of(&interaction).contains(&selected) {
        return Err(PartyDecisionError::new("Вариант решения не найден", "PARTY_OPTION_NOT_FOUND"));
    }
    let eligible = match coalesce(field("eligibleHeroIds"), None) {
        Some(list) => array(Some(list)).iter().map(|item| string(Some(item))).collect(),
        None => party_ids(state),
    };
    let context = participant_context(&interaction, &eligible);
    let voter_id = assert_participant(&context, &voter, "Герой не участвовал при открытии голосования")?;
    let mut votes = clean_votes(&interaction, &context, false);
    let mut replaced: Option<String> = None;
    for actor_id in keys(&votes) {
        if context.voter_for(&actor_id) == voter_id {
            replaced = Some(actor_id.clone());
            votes.shift_remove(&actor_id);
        }
    }
    votes.insert(voter.clone(), Value::String(selected.clone()));
    let winner = winner_for(&interaction, &context, &votes, true);
    let mut cast = vec![
        ("interaction_id", interaction["id"].clone()),
        ("hero_id", json!(voter)),
        ("voter_id", json!(voter_id)),
        ("option_id", json!(selected)),
    ];
    if let Some(replaced) = replaced.filter(|actor| !actor.is_empty()) {
        cast.push(("replaced_hero_id", json!(replaced)));
    }
    cast.push(("votes", votes_value(&votes)));
    let mut events = vec![party_decision_event("PartyVoteCast", Some(&voter), &context, cast)];
    if let Some(winner) = &winner {
        events.push(party_decision_event(
            "PartyDecisionResolved",
            Some(&voter),
            &context,
            vec![
                ("interaction_id", interaction["id"].clone()),
                ("resolved_option_id", json!(winner)),
                ("votes", votes_value(&votes)),
                ("abstained_voter_ids", strings_value(&context.abstained_voters)),
                ("resolution_reason", json!("quorum")),
            ],
        ));
    }
    Ok(json!({ "events": events, "votes": votes_value(&votes), "required": context.required, "resolvedOptionId": winner }))
}

/// Явное воздержание (`resolvePartyAbstain`): кворум пересчитывается по
/// оставшимся; если воздержались все — первый вариант. `input` —
/// `{ interactionId, heroId }`.
pub fn resolve_party_abstain(state: &Value, input: &Value) -> Decided<Value> {
    let field = |key: &str| get(Some(input), key);
    let interaction = validate_party_vote_state(state, field("interactionId"), None)?;
    if is_str(interaction.get("type"), "roll") {
        return Err(PartyDecisionError::new("Общий бросок не принимает abstain", "PARTY_DECISION_CLOSED"));
    }
    let actor = assert_hero_in_party(state, field("heroId"))?;
    let context = participant_context(&interaction, &party_ids(state));
    let voter_id = assert_participant(&context, &actor, "Герой не участвовал при открытии голосования")?;
    let active: Vec<String> = context.active_voters.iter().filter(|candidate| **candidate != voter_id).cloned().collect();
    let abstained = unique(context.abstained_voters.iter().cloned().chain([voter_id.clone()]));
    let mut votes = clean_votes(&interaction, &context, false);
    for actor_id in keys(&votes) {
        if context.voter_for(&actor_id) == voter_id {
            votes.shift_remove(&actor_id);
        }
    }
    let next = Participants { active_voters: active.clone(), abstained_voters: abstained.clone(), required: required_votes_for(interaction.get("type"), active.len()), ..context };
    let mut abstentions = spread_object(interaction.get("abstentions"));
    abstentions.insert(voter_id.clone(), json!("explicit"));
    let mut events = vec![party_decision_event(
        "PartyDecisionAbstained",
        Some(&actor),
        &next,
        vec![
            ("interaction_id", interaction["id"].clone()),
            ("hero_id", json!(actor)),
            ("voter_id", json!(voter_id)),
            ("reason", json!("explicit")),
            ("abstained_voter_ids", strings_value(&abstained)),
            ("abstentions", Value::Object(js_order(abstentions))),
            ("votes", votes_value(&votes)),
        ],
    )];
    let winner = if active.is_empty() { options_of(&interaction).first().cloned() } else { winner_for(&interaction, &next, &votes, true) };
    if let Some(winner) = &winner {
        events.push(party_decision_event(
            "PartyDecisionResolved",
            Some(&actor),
            &next,
            vec![
                ("interaction_id", interaction["id"].clone()),
                ("resolved_option_id", json!(winner)),
                ("votes", votes_value(&votes)),
                ("abstained_voter_ids", strings_value(&abstained)),
                ("resolution_reason", json!(if active.is_empty() { "all_voters_abstained" } else { "quorum_after_abstain" })),
            ],
        ));
    }
    Ok(json!({ "events": events, "votes": votes_value(&votes), "required": next.required, "resolvedOptionId": winner }))
}

/// Голосующие среди подключённых героев (`partyDecisionActiveVoterIds`).
pub fn party_decision_active_voter_ids(interaction: &Value, connected_hero_ids: Option<&Value>) -> Decided<Vec<String>> {
    let interaction = normalize_party_decision(interaction, None)?;
    let connected = unique(array(connected_hero_ids).iter().map(|item| string(Some(item))));
    let context = participant_context(&interaction, &connected);
    Ok(unique(context.eligible_actors.iter().filter(|actor| connected.contains(actor)).map(|actor| context.voter_for(actor))))
}

/// Уход участников (`partyDecisionPresenceEvents`): отключившиеся
/// голосующие воздерживаются, кворум пересчитывается, решение может
/// завершиться. `input` — `{ activeVoterIds }`; ответ — `{ events,
/// activeVoterIds, abstainedVoterIds }`.
pub fn party_decision_presence_events(state: &Value, input: &Value) -> Decided<Value> {
    let interaction = validate_party_vote_state(state, get(get(Some(state), "agentInteraction"), "id"), None)?;
    let context = participant_context(&interaction, &[]);
    let empty = json!([]);
    let active_now = ids(Some(coalesce(get(Some(input), "activeVoterIds"), None).unwrap_or(&empty)));
    let active: Vec<String> = context.active_voters.iter().filter(|voter| active_now.contains(voter)).cloned().collect();
    let departed: Vec<String> = context.active_voters.iter().filter(|voter| !active_now.contains(voter)).cloned().collect();
    if departed.is_empty() {
        return Ok(json!({ "events": [], "activeVoterIds": context.active_voters, "abstainedVoterIds": context.abstained_voters }));
    }
    let abstained = unique(context.abstained_voters.iter().cloned().chain(departed.iter().cloned()));
    let next = Participants { active_voters: active.clone(), abstained_voters: abstained.clone(), required: required_votes_for(interaction.get("type"), active.len()), ..context.clone() };
    let mut votes = clean_votes(&interaction, &context, false);
    for actor_id in keys(&votes) {
        if departed.contains(&context.voter_for(&actor_id)) {
            votes.shift_remove(&actor_id);
        }
    }
    let abstentions: Map<String, Value> = departed.iter().map(|voter| (voter.clone(), json!("disconnected"))).collect();
    let mut events = vec![party_decision_event(
        "PartyDecisionAbstained",
        None,
        &next,
        vec![
            ("interaction_id", interaction["id"].clone()),
            ("voter_id", json!(departed[0])),
            ("reason", json!("disconnected")),
            ("abstained_voter_ids", strings_value(&abstained)),
            ("abstentions", Value::Object(js_order(abstentions))),
            ("votes", votes_value(&votes)),
        ],
    )];
    let winner = if active.is_empty() { options_of(&interaction).first().cloned() } else { winner_for(&interaction, &next, &votes, true) };
    if let Some(winner) = &winner {
        events.push(party_decision_event(
            "PartyDecisionResolved",
            None,
            &next,
            vec![
                ("interaction_id", interaction["id"].clone()),
                ("resolved_option_id", json!(winner)),
                ("votes", votes_value(&votes)),
                ("abstained_voter_ids", strings_value(&abstained)),
                ("resolution_reason", json!(if active.is_empty() { "all_voters_absent" } else { "quorum_after_disconnect" })),
            ],
        ));
    }
    Ok(json!({ "events": events, "activeVoterIds": active, "abstainedVoterIds": abstained }))
}

/// Истечение срока (`partyDecisionExpiryEvents`): по большинству голосов,
/// при равенстве — первый вариант. `now` — `Number(now)` в миллисекундах,
/// `None` — текущее время. Ответ — `{ events }`.
pub fn party_decision_expiry_events(state: &Value, now: Option<f64>) -> Decided<Value> {
    let raw = get(Some(state), "agentInteraction");
    if !js::truthy(raw) {
        return Ok(json!({ "events": [] }));
    }
    let interaction = normalize_party_decision(raw.unwrap_or(&Value::Null), None)?;
    let now = now.unwrap_or_else(|| clock::now_ms() as f64);
    let expires_at = js::number(interaction.get("expiresAt"));
    if !is_str(interaction.get("status"), "open") || !js::truthy(interaction.get("expiresAt")) || now < expires_at {
        return Ok(json!({ "events": [] }));
    }
    let context = participant_context(&interaction, &[]);
    let votes = clean_votes(&interaction, &context, false);
    let winner = winner_for(&interaction, &context, &votes, false).unwrap_or_default();
    Ok(json!({
        "events": [party_decision_event(
            "PartyDecisionExpired",
            None,
            &context,
            vec![
                ("interaction_id", interaction["id"].clone()),
                ("resolved_option_id", json!(winner)),
                ("votes", votes_value(&votes)),
                ("abstained_voter_ids", strings_value(&context.abstained_voters)),
                ("resolution_reason", json!("expired")),
                ("expired_at", interaction.get("expiresAt").cloned().unwrap_or(Value::Null)),
            ],
        )],
    }))
}

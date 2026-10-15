//! Перенос `server/quest-decisions.mjs`: решение отряда по поручению —
//! отказаться от задания или принять его (выбрать основной историей).
//!
//! HTTP передаёт только намерение и снимок участников; допустимость решения
//! проверяется здесь против свежего состояния на каждой попытке коммита
//! (`commit_derived` с `derive_events`), а исполнение принятого решения идёт
//! командой `ResolveQuestDecision` через Rules Engine.

use serde_json::{json, Map, Value};
use sk_core::{hash, js, RuleError};
use sk_memory::party_decision::{party_decision_opened_event, PartyDecisionError};
use sk_society::campaign_stories::{campaign_mode_for, persistent_story_quest};
use sk_society::quest_consequences::{quest_for_knowledge, quest_is_impossible};
use sk_store::executor::{AuthoritativeExecutor, DerivedRequest, Executed, ExecutorError, Producer, ResolvePlan};
use sk_store::{CommitResult, StoreError};

/// Отказ решения по поручению: своё правило (`PartyDecisionError`) или
/// исполнителя коммитов. Правило, сработавшее внутри сборщика событий,
/// приходит как `Executor(Rule(..))` с тем же кодом.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum QuestDecisionRequestError {
    #[error(transparent)]
    Party(#[from] PartyDecisionError),
    #[error(transparent)]
    Executor(#[from] ExecutorError),
}

impl From<StoreError> for QuestDecisionRequestError {
    fn from(error: StoreError) -> Self {
        Self::Executor(ExecutorError::Store(error))
    }
}

impl QuestDecisionRequestError {
    pub fn code(&self) -> &str {
        match self {
            Self::Party(error) => &error.code,
            Self::Executor(error) => error.code(),
        }
    }

    /// Текст отказа без кода — то, что HTTP кладёт в `error`.
    pub fn message(&self) -> &str {
        match self {
            Self::Party(error) => &error.message,
            Self::Executor(ExecutorError::Executor { message, .. }) => message,
            Self::Executor(ExecutorError::Store(error)) => &error.message,
            Self::Executor(ExecutorError::Rule(error)) => &error.message,
        }
    }
}

pub type QuestDecisionResult<T> = Result<T, QuestDecisionRequestError>;

fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|value| value.get(key))
}

fn is_str(value: Option<&Value>, expected: &str) -> bool {
    value.and_then(Value::as_str) == Some(expected)
}

fn is_number(value: Option<&Value>, expected: f64) -> bool {
    value.and_then(Value::as_f64) == Some(expected)
}

fn array(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// `String(x || '')`.
fn text_or_empty(value: Option<&Value>) -> String {
    if js::truthy(value) {
        js::string(value)
    } else {
        String::new()
    }
}

/// Запись хроники о последствии поручения (`questDecisionChronicleEntry`).
pub fn quest_decision_chronicle_entry(event: &Value) -> Option<Value> {
    let event_type = get(Some(event), "event_type");
    let payload = get(Some(event), "payload");
    let schema = get(payload, "schema_version");
    let visibility = get(Some(event), "visibility");
    let entry = |prefix: &str| {
        json!({
            "id": format!("{prefix}:{}", js::string(get(Some(event), "event_id"))),
            "speaker": "narrator",
            "author": "Рассказчик",
            "text": text_or_empty(get(payload, "summary")),
            "turnConsumed": false,
        })
    };
    if (is_str(event_type, "QuestInvalidated") || is_str(event_type, "QuestAssignmentChanged"))
        && (is_number(schema, 1.0) || is_number(schema, 2.0))
        && (is_str(visibility, "public") || is_str(visibility, "party"))
    {
        let mut result = entry("quest-consequence");
        if let Some(gate) = get(payload, "knowledge_gate").filter(|gate| js::truthy(Some(gate))) {
            result["knowledge_gate"] = gate.clone();
        }
        return Some(result);
    }
    if is_str(event_type, "QuestAccepted") && is_number(schema, 1.0) {
        return Some(entry("quest-accepted"));
    }
    if !is_str(event_type, "QuestResolved") || !js::is_true(get(payload, "stay_in_location")) {
        return None;
    }
    Some(entry("quest-resolution"))
}

/// `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u`.
fn safe_id(text: &str) -> bool {
    let bytes = text.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 120
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..].iter().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn assert_request(actor_id: Option<&Value>, quest_id: Option<&Value>, idempotency_key: Option<&Value>) -> Result<(), PartyDecisionError> {
    let valid_id = |value: Option<&Value>| value.and_then(Value::as_str).is_some_and(safe_id);
    let key_ok = idempotency_key
        .and_then(Value::as_str)
        .is_some_and(|key| !sk_core::text::trim(key).is_empty() && key.encode_utf16().count() <= 160);
    if !valid_id(actor_id) || !valid_id(quest_id) || !key_ok {
        return Err(PartyDecisionError::new("Нужны герой, задание и ключ запроса", "INVALID_QUEST_REQUEST"));
    }
    Ok(())
}

fn opened_with_fingerprint(events: &[Value], fingerprint: &str) -> bool {
    events
        .iter()
        .any(|event| is_str(event.get("event_type"), "PartyDecisionOpened") && is_str(get(event.get("payload"), "request_fingerprint"), fingerprint))
}

fn assert_same_request(committed: Option<Executed>, fingerprint: &str) -> QuestDecisionResult<Executed> {
    match committed {
        Some(executed) if opened_with_fingerprint(&executed.commit.events, fingerprint) => Ok(executed),
        _ => Err(PartyDecisionError::new("Ключ уже использован для другого запроса", "IDEMPOTENCY_CONFLICT").into()),
    }
}

/// Запрос решения (`requestQuestDecision`). Поля запроса — сырые значения
/// тела HTTP (`actor_id`, `quest_id`, ключ). `voter_snapshot` по свежему
/// состоянию даёт `{ eligibleHeroIds, eligibleVoterIds, voterByHeroId }`.
/// `action` — `abandon` (по умолчанию) или `accept`.
///
/// Повтор с тем же ключом возвращает прежний коммит с `replayed: true` (JS
/// возвращает его без флага — значение флага никто не читает).
pub struct QuestDecisionRequest<'a> {
    pub campaign_id: &'a str,
    pub actor_id: Option<&'a Value>,
    pub quest_id: Option<&'a Value>,
    pub idempotency_key: Option<&'a Value>,
    pub voter_snapshot: &'a dyn Fn(&Value) -> Value,
    pub now: i64,
    pub action: Option<&'a str>,
}

pub fn request_quest_decision(executor: &AuthoritativeExecutor<'_>, request: QuestDecisionRequest<'_>) -> QuestDecisionResult<Executed> {
    assert_request(request.actor_id, request.quest_id, request.idempotency_key)?;
    let action = request.action.unwrap_or("abandon");
    if action != "abandon" && action != "accept" {
        return Err(PartyDecisionError::new("Неизвестное решение по заданию", "INVALID_QUEST_REQUEST").into());
    }
    let acceptance = action == "accept";
    let campaign_id = request.campaign_id;
    let actor_id = js::s(request.actor_id);
    let quest_id = js::s(request.quest_id);
    let idempotency_key = js::s(request.idempotency_key);
    let tag = if acceptance { "quest-acceptance/v1" } else { "quest-abandonment/v1" };
    let fingerprint = hash::sha256_hex(js::stringify(&json!([tag, campaign_id, actor_id, quest_id])).as_bytes());
    if let Some(previous) = executor.journal().get_by_idempotency_key(campaign_id, &idempotency_key)? {
        return assert_same_request(Some(Executed { commit: previous, replayed: true, resolved: None }), &fingerprint);
    }
    let interaction_hash = hash::sha256_hex(format!("{campaign_id}\0{idempotency_key}").as_bytes());
    let interaction_id = format!("quest-{}", &interaction_hash[..24]);
    let derive = |state: &Value, _loaded: &sk_store::Loaded| -> Result<Vec<Value>, RuleError> {
        derive_quest_decision(state, &DecisionDraft { acceptance, actor_id: &actor_id, quest_id: &quest_id, interaction_id: &interaction_id, fingerprint: &fingerprint, now: request.now, voter_snapshot: request.voter_snapshot })
            .map_err(RuleError::from)
    };
    let committed = executor.commit_derived(DerivedRequest {
        campaign_id,
        idempotency_key: &idempotency_key,
        events: None,
        derive_events: Some(&derive),
        producer: Some(Producer::PartyDecision),
        derived_from: Vec::new(),
        metadata: Value::Null,
        derive_metadata: None,
    })?;
    // Проверяем и результат гонки: исполнитель может вернуть чужой коммит с тем же ключом.
    assert_same_request(committed, &fingerprint)
}

struct DecisionDraft<'a> {
    acceptance: bool,
    actor_id: &'a str,
    quest_id: &'a str,
    interaction_id: &'a str,
    fingerprint: &'a str,
    now: i64,
    voter_snapshot: &'a dyn Fn(&Value) -> Value,
}

fn derive_quest_decision(state: &Value, draft: &DecisionDraft<'_>) -> Result<Vec<Value>, PartyDecisionError> {
    let refuse = |message: &str, code: &str| Err(PartyDecisionError::new(message, code));
    let mechanics = state.get("mechanics");
    if !is_str(get(get(mechanics, "campaign_lifecycle"), "status"), "active") {
        return refuse("Кампания сейчас недоступна для действий", "CAMPAIGN_NOT_ACTIVE");
    }
    if js::truthy(get(get(mechanics, "combat"), "active")) {
        return refuse("Дождитесь окончания боя", "QUEST_DECISION_DURING_COMBAT");
    }
    let players = array(state.get("players"));
    let party = array(state.get("partyMemberIds"));
    let members: Vec<Option<&Value>> = if party.is_empty() { players.iter().map(|hero| hero.get("id")).collect() } else { party.iter().map(Some).collect() };
    let actor = players.iter().find(|hero| is_str(hero.get("id"), draft.actor_id));
    let in_party = members.iter().any(|member| is_str(*member, draft.actor_id));
    let Some(actor) = actor.filter(|_| in_party) else {
        return refuse("Герой не входит в отряд", "ACTOR_FORBIDDEN");
    };
    let dead = is_str(get(get(get(get(mechanics, "death"), "heroes"), draft.actor_id), "status"), "dead");
    if js::truthy(actor.get("characterSetupRequired")) || dead {
        return refuse("Этот герой пока не может действовать", "ACTOR_UNAVAILABLE");
    }
    let memory = state.get("worldMemory");
    let quest = array(get(memory, "quests")).iter().find(|entry| {
        let visibility = entry.get("visibility");
        is_str(entry.get("id"), draft.quest_id) && !is_str(entry.get("status"), "hidden") && (is_str(visibility, "public") || is_str(visibility, "party"))
    });
    let Some(quest) = quest else {
        return refuse("Задание недоступно отряду", "WORLD_QUEST_NOT_FOUND");
    };
    let known = quest_for_knowledge(quest, memory.unwrap_or(&Value::Null), &json!({ "playerId": draft.actor_id, "isPartyMember": true }));
    if known.get("status") != quest.get("status") || known.get("giver_npc_id") != quest.get("giver_npc_id") {
        return refuse("Сейчас решение по этому поручению недоступно. Уточните его условия в мире.", "QUEST_DECISION_UNAVAILABLE");
    }
    if draft.acceptance && quest_is_impossible(state, Some(quest)) {
        return refuse("Необходимый для поручения NPC погиб", "WORLD_QUEST_IMPOSSIBLE");
    }
    if draft.quest_id.starts_with("quest:chapter:") {
        return refuse("Это цель текущей сцены, а не отдельное поручение", "WORLD_QUEST_NOT_ABANDONABLE");
    }
    let status = quest.get("status");
    let open = if draft.acceptance { is_str(status, "offered") || is_str(status, "active") } else { is_str(status, "active") };
    if !open {
        return refuse("Это задание нельзя сейчас изменить", "WORLD_QUEST_CLOSED");
    }
    let active = is_str(status, "active");
    if draft.acceptance && active && (campaign_mode_for(state) != "persistent" || persistent_story_quest(state).is_some()) {
        return refuse("Задание уже принято; основная история пока занята", "WORLD_QUEST_ALREADY_ACCEPTED");
    }
    if js::truthy(state.get("agentInteraction")) {
        return refuse("Сначала завершите текущее решение отряда", "PARTY_DECISION_CONFLICT");
    }
    let title = js::string(quest.get("title"));
    let mut interaction = Map::new();
    interaction.insert("id".into(), json!(draft.interaction_id));
    interaction.insert("type".into(), json!("vote"));
    interaction.insert("createdAt".into(), json!(draft.now));
    let (heading, description, options) = if draft.acceptance {
        (
            if active { "Выбрать основную историю?" } else { "Принять задание?" },
            format!("Отряд {} задание «{title}». Место и время не меняются.", if active { "выбирает основной историей" } else { "принимает" }),
            json!([{ "id": "later", "label": "Решить позже" }, { "id": "accept", "label": if active { "Выбрать основной историей" } else { "Принять задание" } }]),
        )
    } else {
        (
            "Отказаться от задания?",
            format!("Задание «{title}» будет оставлено. Отряд останется в текущей локации."),
            // При истечении без голосов сохраняем задание по общей политике стола.
            json!([{ "id": "keep", "label": "Продолжить задание" }, { "id": "abandon", "label": "Отказаться от задания" }]),
        )
    };
    interaction.insert("title".into(), json!(heading));
    interaction.insert("description".into(), json!(description));
    interaction.insert("options".into(), options);
    let marker = json!({ "schemaVersion": 1, "questId": draft.quest_id });
    interaction.insert(if draft.acceptance { "questAcceptance" } else { "questAbandonment" }.into(), marker);
    // `{ ...voterSnapshot(state), policy: state.partyDecisionPolicy }`: ключ
    // `policy` всегда перекрывает снимок, даже значением `undefined`.
    let mut options = match (draft.voter_snapshot)(state) {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    match state.get("partyDecisionPolicy") {
        Some(policy) => {
            options.insert("policy".into(), policy.clone());
        }
        None => {
            options.shift_remove("policy");
        }
    }
    let mut opened = party_decision_opened_event(&Value::Object(interaction), Some(&json!(draft.actor_id)), &Value::Object(options))?;
    opened["payload"]["request_fingerprint"] = json!(draft.fingerprint);
    Ok(vec![opened])
}

fn consumed(events: &[Value], interaction_id: Option<&Value>) -> bool {
    events
        .iter()
        .any(|event| is_str(event.get("event_type"), "PartyDecisionConsumed") && get(event.get("payload"), "interaction_id") == interaction_id)
}

/// Исполнение решённого голосования (`finishQuestDecision`): сохранённое
/// решение само служит возобновляемой работой после сбоя. `state` — уже
/// загруженная голова; без неё журнал читается заново. `resolve_plan` —
/// Rules Engine (`ResolveQuestDecision`). `Ok(None)` — исполнять нечего.
pub fn finish_quest_decision(executor: &AuthoritativeExecutor<'_>, campaign_id: &str, state: Option<&Value>, resolve_plan: &ResolvePlan<'_>) -> QuestDecisionResult<Option<CommitResult>> {
    let loaded;
    let current = match state {
        Some(state) => state,
        None => {
            loaded = executor.journal().load(campaign_id)?.state;
            &loaded
        }
    };
    let interaction = current.get("agentInteraction");
    let marked = js::truthy(get(interaction, "questAbandonment")) || js::truthy(get(interaction, "questAcceptance"));
    if !marked || !is_str(get(interaction, "status"), "resolved") || !is_str(get(get(current.get("mechanics"), "campaign_lifecycle"), "status"), "active") {
        return Ok(None);
    }
    let interaction_id = get(interaction, "id");
    let key = format!("quest-decision:{}", js::string(interaction_id));
    let mut command = Map::new();
    command.insert("command_type".into(), json!("ResolveQuestDecision"));
    if let Some(id) = interaction_id {
        command.insert("interaction_id".into(), id.clone());
    }
    command.insert("house_rule_id".into(), json!("skazanie:quest-decision:v1"));
    match executor.execute_commands(campaign_id, &key, &[Value::Object(command)], &json!({ "isDirector": true }), resolve_plan) {
        Ok(result) => {
            if !consumed(&result.commit.events, interaction_id) {
                return Err(PartyDecisionError::new("Ключ исполнения уже занят", "IDEMPOTENCY_CONFLICT").into());
            }
            Ok(Some(result.commit))
        }
        Err(error) => {
            if error.code() == "PARTY_DECISION_REQUIRED" {
                if let Some(previous) = executor.journal().get_by_idempotency_key(campaign_id, &key)? {
                    if consumed(&previous.events, interaction_id) {
                        return Ok(Some(previous));
                    }
                }
            }
            Err(error.into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_id_matches_js_pattern() {
        assert!(safe_id("hero-1"));
        assert!(safe_id("quest:side.a_b-1"));
        assert!(!safe_id(""));
        assert!(!safe_id("-hero"));
        assert!(!safe_id("герой"));
        assert!(safe_id(&"a".repeat(120)));
        assert!(!safe_id(&"a".repeat(121)));
    }
}

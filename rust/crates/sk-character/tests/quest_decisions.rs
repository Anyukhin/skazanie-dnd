//! Эталон `server/quest-decisions.mjs` (`fixtures/gen-quest-decisions.mjs`):
//! запрос решения против исполнителя коммитов с журналом-заглушкой и запись
//! хроники. Плюс исполнение решённого голосования.

use std::cell::RefCell;
use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_character::quest_decisions::{finish_quest_decision, quest_decision_chronicle_entry, request_quest_decision, QuestDecisionRequest};
use sk_core::{js, RuleError};
use sk_store::executor::{AuthoritativeExecutor, Journal};
use sk_store::{CommitRequest, CommitResult, Loaded, StoreError, StoreResult};

static FIXTURE: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("../fixtures/quest-decisions.json")).expect("эталон"));

/// Журнал как в генераторе: голова версии 7, коммит возвращает свои события.
struct FakeJournal {
    state: Value,
    previous: Option<CommitResult>,
    commits: RefCell<Vec<CommitRequest>>,
    refuse_commit: Option<StoreError>,
}

fn commit_from(value: &Value) -> CommitResult {
    CommitResult {
        campaign_id: js::s(value.get("campaign_id")),
        state_version: value["state_version"].as_i64().unwrap_or(0),
        current_state_version: value["current_state_version"].as_i64().unwrap_or(0),
        state: value["state"].clone(),
        metadata: value["metadata"].clone(),
        events: value["events"].as_array().cloned().unwrap_or_default(),
        duplicate: value["duplicate"].as_bool().unwrap_or(false),
        idempotency_key: js::s(value.get("idempotency_key")),
        command_id: js::s(value.get("command_id")),
    }
}

impl Journal for FakeJournal {
    fn load(&self, campaign_id: &str) -> StoreResult<Loaded> {
        Ok(Loaded { campaign_id: campaign_id.into(), state_version: 7, current_state_version: 7, state: self.state.clone(), reducer_version: 15, metadata: json!({}), events_applied: 0 })
    }

    fn commit(&self, request: CommitRequest) -> StoreResult<CommitResult> {
        if let Some(error) = &self.refuse_commit {
            return Err(error.clone());
        }
        self.commits.borrow_mut().push(request.clone());
        Ok(CommitResult {
            campaign_id: request.campaign_id.clone(),
            state_version: 8,
            current_state_version: 8,
            state: json!({}),
            metadata: json!({}),
            events: request.events.clone(),
            duplicate: false,
            idempotency_key: request.idempotency_key.clone(),
            command_id: request.command_id.clone().unwrap_or_default(),
        })
    }

    fn get_by_idempotency_key(&self, _campaign_id: &str, _key: &str) -> StoreResult<Option<CommitResult>> {
        Ok(self.previous.clone())
    }
}

fn journal(state: Value, previous: Option<CommitResult>) -> FakeJournal {
    FakeJournal { state, previous, commits: RefCell::new(Vec::new()), refuse_commit: None }
}

fn optional(value: &Value) -> Option<&Value> {
    (!value.is_null()).then_some(value)
}

#[test]
fn quest_decision_requests_match_js() {
    let cases = FIXTURE["cases"].as_array().expect("случаи");
    assert!(cases.len() >= 1500);
    let mut failures = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let request = &case["request"];
        let previous = optional(&case["previous"]).map(commit_from);
        let store = journal(case["state"].clone(), previous);
        let executor = AuthoritativeExecutor::new(&store);
        let snapshot = case["snapshot"].clone();
        let voter_snapshot = move |_state: &Value| snapshot.clone();
        let result = request_quest_decision(
            &executor,
            QuestDecisionRequest {
                campaign_id: request["campaignId"].as_str().expect("кампания"),
                actor_id: optional(&request["actorId"]),
                quest_id: optional(&request["questId"]),
                idempotency_key: optional(&request["idempotencyKey"]),
                voter_snapshot: &voter_snapshot,
                now: request["now"].as_i64().expect("время"),
                action: request["action"].as_str(),
            },
        );
        let actual = match result {
            Ok(executed) => json!({ "events": executed.commit.events }),
            Err(error) => json!({ "error": { "code": error.code(), "message": error.message() } }),
        };
        if actual != case["expected"] {
            failures.push(format!("#{index}: ожидалось {}\nполучено {}", case["expected"], actual));
        }
    }
    assert!(failures.is_empty(), "{} расхождений из {}:\n{}", failures.len(), cases.len(), failures.iter().take(5).cloned().collect::<Vec<_>>().join("\n"));
}

#[test]
fn chronicle_entries_match_js() {
    for (index, case) in FIXTURE["chronicle"].as_array().expect("хроника").iter().enumerate() {
        let expected = optional(&case["expected"]).cloned();
        assert_eq!(quest_decision_chronicle_entry(&case["event"]), expected, "#{index}: {}", case["event"]);
    }
}

fn resolved_state(status: &str) -> Value {
    json!({
        "mechanics": { "campaign_lifecycle": { "status": "active" } },
        "agentInteraction": { "id": "quest-abc", "status": status, "questAbandonment": { "schemaVersion": 1, "questId": "quest-mill" } },
    })
}

fn consume_plan(commands: &[Value], _state: &Value, _context: &Value) -> Result<Value, RuleError> {
    let interaction = commands[0]["interaction_id"].clone();
    Ok(json!({ "events": [{ "event_type": "PartyDecisionConsumed", "actor_id": "system", "payload": { "interaction_id": interaction } }] }))
}

#[test]
fn finish_executes_only_a_resolved_quest_decision() {
    let store = journal(resolved_state("open"), None);
    let executor = AuthoritativeExecutor::new(&store);
    assert!(finish_quest_decision(&executor, "CAMP", None, &consume_plan).expect("ничего").is_none());

    let store = journal(resolved_state("resolved"), None);
    let executor = AuthoritativeExecutor::new(&store);
    let context = RefCell::new(Value::Null);
    let plan = |commands: &[Value], state: &Value, context_value: &Value| {
        *context.borrow_mut() = json!({ "commands": commands, "context": context_value });
        consume_plan(commands, state, context_value)
    };
    let committed = finish_quest_decision(&executor, "CAMP", None, &plan).expect("исполнено").expect("коммит");
    assert_eq!(committed.idempotency_key, "quest-decision:quest-abc");
    assert_eq!(
        *context.borrow(),
        json!({ "commands": [{ "command_type": "ResolveQuestDecision", "interaction_id": "quest-abc", "house_rule_id": "skazanie:quest-decision:v1" }], "context": { "isDirector": true } })
    );
}

#[test]
fn finish_refuses_a_key_taken_by_another_commit() {
    let store = journal(resolved_state("resolved"), None);
    let executor = AuthoritativeExecutor::new(&store);
    let foreign = |_: &[Value], _: &Value, _: &Value| Ok(json!({ "events": [{ "event_type": "ObjectiveUpdated", "actor_id": "system", "payload": {} }] }));
    let error = finish_quest_decision(&executor, "CAMP", None, &foreign).expect_err("чужой коммит");
    assert_eq!(error.code(), "IDEMPOTENCY_CONFLICT");
}

#[test]
fn finish_returns_the_previous_commit_when_the_decision_was_already_consumed() {
    let previous = commit_from(&json!({ "campaign_id": "CAMP", "idempotency_key": "quest-decision:quest-abc", "events": [{ "event_type": "PartyDecisionConsumed", "payload": { "interaction_id": "quest-abc" } }] }));
    // Первый запрос ключа (до разбора) пуст, второй — после отказа — видит коммит.
    struct Late {
        inner: FakeJournal,
        previous: CommitResult,
        asked: RefCell<usize>,
    }
    impl Journal for Late {
        fn load(&self, campaign_id: &str) -> StoreResult<Loaded> {
            self.inner.load(campaign_id)
        }
        fn commit(&self, request: CommitRequest) -> StoreResult<CommitResult> {
            self.inner.commit(request)
        }
        fn get_by_idempotency_key(&self, _: &str, _: &str) -> StoreResult<Option<CommitResult>> {
            *self.asked.borrow_mut() += 1;
            Ok((*self.asked.borrow() > 1).then(|| self.previous.clone()))
        }
    }
    let store = Late { inner: journal(resolved_state("resolved"), None), previous, asked: RefCell::new(0) };
    let executor = AuthoritativeExecutor::new(&store);
    let required = |_: &[Value], _: &Value, _: &Value| Err(RuleError::new("PARTY_DECISION_REQUIRED", "Решение уже исполнено"));
    let committed = finish_quest_decision(&executor, "CAMP", None, &required).expect("прежний коммит").expect("коммит");
    assert_eq!(committed.idempotency_key, "quest-decision:quest-abc");

    let store = journal(resolved_state("resolved"), None);
    let executor = AuthoritativeExecutor::new(&store);
    assert_eq!(finish_quest_decision(&executor, "CAMP", None, &required).expect_err("нечего вернуть").code(), "PARTY_DECISION_REQUIRED");
}

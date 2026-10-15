//! Перенос `test/authoritative-executor.test.mjs`: одна политика устойчивости,
//! права производителей, инвариант «производное не трогает владения Rules
//! Engine», отдельный управляющий вход для отката.

use std::cell::Cell;
use std::sync::Arc;

use serde_json::{json, Value};
use sk_core::RuleError;
use sk_store::executor::{derived_event_allowlist_for_review, AuthoritativeExecutor, DerivedRequest, Journal, Producer};
use sk_store::{CommitRequest, CommitResult, EventStore, InitializeRequest, LoadOptions, Loaded, Reducer, RetentionMode, StoreOptions, StoreResult};

/// Редьюсер теста: цель сцены и счётчик событий.
struct ObjectiveReducer;

impl Reducer for ObjectiveReducer {
    fn reducer_version(&self) -> i64 {
        15
    }

    fn normalize(&self, state: Value, _mode: RetentionMode) -> Value {
        state
    }

    fn apply(&self, mut state: Value, event: &Value, _mode: RetentionMode) -> Result<Value, String> {
        if event["event_type"] == "ObjectiveUpdated" {
            state["scene"]["objective"] = event["payload"]["objective"].clone();
        }
        if event["event_type"] == "CampaignRulesetChanged" {
            state["ruleset_id"] = event["payload"]["ruleset_id_after"].clone();
        }
        Ok(state)
    }
}

fn store() -> EventStore {
    let store = EventStore::in_memory(Arc::new(ObjectiveReducer), StoreOptions::default()).expect("хранилище");
    store
        .initialize_campaign(InitializeRequest::new("EXECUTOR", json!({ "ruleset_id": "srd_5_2_1", "scene": { "location": "Лагерь", "objective": "" } })))
        .expect("кампания");
    store
}

/// Журнал, в котором чужой коммит опережает первый коммит исполнителя.
struct Racing<'a> {
    store: &'a EventStore,
    raced: Cell<bool>,
    same_key: bool,
}

impl Journal for Racing<'_> {
    fn load(&self, campaign_id: &str) -> StoreResult<Loaded> {
        self.store.load(campaign_id, &LoadOptions::default())
    }

    fn commit(&self, request: CommitRequest) -> StoreResult<CommitResult> {
        if !self.raced.get() {
            self.raced.set(true);
            if self.same_key {
                self.store.commit(request.clone())?;
            } else {
                let loaded = self.store.load(&request.campaign_id, &LoadOptions::default())?;
                self.store.commit(CommitRequest {
                    campaign_id: request.campaign_id.clone(),
                    expected_state_version: loaded.state_version,
                    idempotency_key: format!("foreign:{}", loaded.state_version),
                    command_id: Some(format!("foreign:{}", loaded.state_version)),
                    events: vec![json!({ "event_type": "ObjectiveUpdated", "actor_id": "system", "payload": { "objective": "Чужой коммит опередил исполнителя" } })],
                    ..Default::default()
                })?;
            }
        }
        self.store.commit(request)
    }

    fn get_by_idempotency_key(&self, campaign_id: &str, key: &str) -> StoreResult<Option<CommitResult>> {
        self.store.get_by_idempotency_key(campaign_id, key)
    }
}

/// Rules Engine теста: `UpdateObjective` → `ObjectiveUpdated`.
fn resolve_plan(commands: &[Value], _state: &Value, _context: &Value) -> Result<Value, RuleError> {
    let events: Vec<Value> = commands
        .iter()
        .filter(|command| command["command_type"] == "UpdateObjective")
        .map(|command| json!({ "event_type": "ObjectiveUpdated", "actor_id": "system", "payload": { "objective": command["objective"] } }))
        .collect();
    Ok(json!({ "events": events }))
}

fn objective() -> Vec<Value> {
    vec![json!({ "command_type": "UpdateObjective", "objective": "Дойти до переправы" })]
}

fn public_die(payload: Value) -> Value {
    json!({ "event_type": "PublicDieRolled", "actor_id": "hero", "target_ids": [], "visibility": "public", "source_rule_ids": [], "payload": payload })
}

#[test]
fn version_conflict_is_survived_where_the_turn_used_to_be_lost() {
    let store = store();
    let racing = Racing { store: &store, raced: Cell::new(false), same_key: false };
    let executed = AuthoritativeExecutor::new(&racing).execute_commands("EXECUTOR", "objective-1", &objective(), &json!({}), &resolve_plan).expect("команда");
    assert!(!executed.replayed);
    assert!(!executed.commit.events.is_empty(), "команда обязана дойти до журнала несмотря на чужой коммит");
    assert_eq!(store.load("EXECUTOR", &LoadOptions::default()).expect("загрузка").state["scene"]["objective"], "Дойти до переправы");
}

#[test]
fn same_key_returns_the_previous_commit_without_writing_twice() {
    let store = store();
    let executor = AuthoritativeExecutor::new(&store);
    let first = executor.execute_commands("EXECUTOR", "objective-2", &objective(), &json!({}), &resolve_plan).expect("первый");
    let version = store.load("EXECUTOR", &LoadOptions::default()).expect("загрузка").state_version;
    let second = executor.execute_commands("EXECUTOR", "objective-2", &objective(), &json!({}), &resolve_plan).expect("повтор");
    assert!(!first.replayed);
    assert!(second.replayed);
    assert_eq!(store.load("EXECUTOR", &LoadOptions::default()).expect("загрузка").state_version, version);
}

#[test]
fn race_with_the_same_key_is_marked_replayed() {
    let store = store();
    let racing = Racing { store: &store, raced: Cell::new(false), same_key: true };
    let executed = AuthoritativeExecutor::new(&racing).execute_commands("EXECUTOR", "same-key-race", &objective(), &json!({}), &resolve_plan).expect("команда");
    assert!(executed.commit.duplicate);
    assert!(executed.replayed);
    assert_eq!(store.get_events("EXECUTOR", 0, None).expect("события").len(), 1);
}

#[test]
fn empty_command_set_is_not_committed() {
    let store = store();
    let error = AuthoritativeExecutor::new(&store).execute_commands("EXECUTOR", "empty", &[], &json!({}), &resolve_plan).expect_err("пусто");
    assert_eq!(error.code(), "EMPTY_COMMAND_SET");
}

#[test]
fn derived_event_needs_its_own_producer_and_type() {
    let store = store();
    let executor = AuthoritativeExecutor::new(&store);
    let die = public_die(json!({ "expression": "1d20", "total": 14 }));
    let mut without = DerivedRequest::events("EXECUTOR", "die-1", Producer::PublicDice, vec![die.clone()]);
    without.producer = None;
    assert_eq!(executor.commit_derived(without).expect_err("без права").code(), "PRODUCER_CAPABILITY_REQUIRED");
    let foreign = DerivedRequest::events("EXECUTOR", "die-2", Producer::CampaignLifecycle, vec![die.clone()]);
    assert_eq!(executor.commit_derived(foreign).expect_err("чужой тип").code(), "DERIVED_EVENT_NOT_ALLOWED");
    let committed = executor.commit_derived(DerivedRequest::events("EXECUTOR", "die-3", Producer::PublicDice, vec![die])).expect("бросок").expect("есть коммит");
    assert!(!committed.replayed);
    assert_eq!(committed.commit.events[0]["event_type"], "PublicDieRolled");
}

#[test]
fn derived_entry_cannot_touch_rules_engine_state() {
    let store = store();
    let executor = AuthoritativeExecutor::new(&store);
    for (index, payload) in [json!({ "expression": "1d20", "total": 20, "hp": 3 }), json!({ "expression": "1d20", "total": 20, "result": { "damage": 7 } }), json!({ "expression": "1d20", "total": 20, "inventory": [] })]
        .into_iter()
        .enumerate()
    {
        let key = format!("forged:{index}");
        let error = executor.commit_derived(DerivedRequest::events("EXECUTOR", &key, Producer::PublicDice, vec![public_die(payload.clone())])).expect_err("подделка");
        assert_eq!(error.code(), "DERIVED_EVENT_TOUCHES_RULES_STATE", "{payload}");
    }
}

#[test]
fn derived_retry_is_idempotent() {
    let store = store();
    let executor = AuthoritativeExecutor::new(&store);
    let event = json!({ "event_type": "CampaignPaused", "actor_id": "owner", "target_ids": [], "visibility": "party", "source_rule_ids": [], "payload": { "reason": "перерыв" } });
    let first = executor.commit_derived(DerivedRequest::events("EXECUTOR", "pause-1", Producer::CampaignLifecycle, vec![event.clone()])).expect("первый").expect("коммит");
    let second = executor.commit_derived(DerivedRequest::events("EXECUTOR", "pause-1", Producer::CampaignLifecycle, vec![event])).expect("повтор").expect("коммит");
    assert!(!first.replayed);
    assert!(second.replayed);
}

#[test]
fn derived_events_are_rebuilt_against_fresh_state_after_a_conflict() {
    let store = store();
    let racing = Racing { store: &store, raced: Cell::new(false), same_key: false };
    // Как `campaignRulesetChangeEvent`: после чужого коммита (кампания началась)
    // смена редакции заблокирована, и сборщик обязан увидеть это на повторе.
    let derive = |state: &Value, loaded: &Loaded| -> Result<Vec<Value>, RuleError> {
        if loaded.state_version > 0 {
            return Err(RuleError::new("CAMPAIGN_RULESET_LOCKED", "Редакция уже закреплена"));
        }
        let _ = state;
        Ok(vec![json!({ "event_type": "CampaignRulesetChanged", "payload": { "ruleset_id_after": "dnd_5e_2014" } })])
    };
    let request = DerivedRequest { campaign_id: "EXECUTOR", idempotency_key: "ruleset-race", events: None, derive_events: Some(&derive), producer: Some(Producer::CampaignRuleset), derived_from: Vec::new(), metadata: Value::Null, derive_metadata: None };
    let error = AuthoritativeExecutor::new(&racing).commit_derived(request).expect_err("lock после гонки");
    assert_eq!(error.code(), "CAMPAIGN_RULESET_LOCKED");
    assert_eq!(store.load("EXECUTOR", &LoadOptions::default()).expect("загрузка").state["ruleset_id"], "srd_5_2_1");
}

#[test]
fn rewind_goes_through_the_control_entry_only() {
    let store = store();
    let executor = AuthoritativeExecutor::new(&store);
    let rewind = json!({ "event_type": "CampaignRewound", "actor_id": "owner", "target_ids": [], "visibility": "party", "source_rule_ids": [], "payload": { "target_version": 0, "state": {} } });
    let derived = DerivedRequest::events("EXECUTOR", "rewind-1", Producer::CampaignLifecycle, vec![rewind.clone()]);
    assert_eq!(executor.commit_derived(derived).expect_err("не производное").code(), "DERIVED_EVENT_NOT_ALLOWED");
    assert_eq!(executor.commit_control("EXECUTOR", "rewind-2", &rewind, Producer::PartyDecision, false).expect_err("чужое право").code(), "PRODUCER_CAPABILITY_REQUIRED");
    let committed = executor.commit_control("EXECUTOR", "rewind-3", &rewind, Producer::CampaignControl, false).expect("откат");
    assert_eq!(committed.commit.events[0]["event_type"], "CampaignRewound");
}

#[test]
fn derived_allowlist_is_complete_and_sorted_for_review() {
    let table = derived_event_allowlist_for_review();
    let mut keys: Vec<&String> = table.keys().collect();
    keys.sort();
    assert_eq!(keys, ["campaignLifecycle", "campaignRuleset", "economyClock", "partyDecision", "presence", "publicDice", "worldRumor"]);
    for (producer, types) in &table {
        let list: Vec<&str> = types.as_array().expect("список").iter().filter_map(Value::as_str).collect();
        assert!(!list.is_empty(), "{producer}: пустой список превращает право в формальность");
        let mut sorted = list.clone();
        sorted.sort_unstable();
        assert_eq!(list, sorted, "{producer}: список отсортирован для ревью");
    }
    assert_eq!(table["economyClock"], json!(["MerchantEconomyClockAdvanced"]));
    assert_eq!(table["campaignRuleset"], json!(["CampaignHouseRuleChanged", "CampaignRulesetChanged"]));
    assert_eq!(table["worldRumor"], json!(["FactionReputationAdjusted"]));
}

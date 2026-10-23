//! Сверка `game_orchestrator` с эталонами JS (`fixtures/gen-o2.mjs` →
//! `fixtures/o2.json.gz`): чистые экспорты на вызовах тестов JS, корпусе и
//! мусоре; прогоны `handle` на журнале — записи тестов JS с ответами их
//! ролей, сессии на состояниях корпуса и авторских мирах (реплики игроков,
//! уточнения, ручные броски, повторы, конфликты ключа, вопросы, `/why`,
//! команды хотбара) с моделью-заглушкой и без неё. Сверяются ответы шагов
//! (состояние — хешем без порядка ключей, события — хешами), события живого
//! рассказа, запросы к модели и итоговое состояние журнала.

use std::cell::RefCell;
use std::future::Future;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::task::{Context as TaskContext, Poll, Wake, Waker};

use serde_json::{json, Map, Value};
use sk_agents::action_adjudicator::ActionAdjudicator;
use sk_agents::lore_voice::LoreVoice;
use sk_agents::narrator::{Narrator, NarratorConfig};
use sk_agents::npc_social_controller::NpcSocialController;
use sk_agents_base::llm_client::{LlmClient, LlmError, LlmFuture};
use sk_core::{hash, js};
use sk_dice::{DiceError, DiceService, Rng};
use sk_infra::roll_registry::{RollRegistry, RollRegistryOptions};
use sk_narration_base::clarification_registry::{ClarificationRegistry, ClarificationRegistryOptions};
use sk_orchestrator::autonomous_orchestrator::{AgentFuture, AutonomousCampaignOrchestrator, CheckRegistry, FreeActionReader, OrchestratorError, OrchestratorJournal, OrchestratorResult, UnknownAction};
use sk_orchestrator::game_orchestrator::{
    events_to_client_effects, narration_npc_reactions, narration_request_fingerprint, narration_story_context, roll_purpose_label, speech_addressee, spell_speech_follow_up, structured_commands_fingerprint, with_detail_reactions, GameOrchestrator, GameOrchestratorOptions,
    HandleInput, IntentReader, LoreRetell, NarrationOptions, PlanAdjudicator, RequestFingerprint, RuleSearch, SocialResponder, SocialTarget, TableDiscussion, TurnNarrator, TurnRollRegistry, TurnRules, TurnTraceStore, UnknownActionHandler,
};
use sk_projection::trace_store::FileTraceStore;
use sk_rules::constants::GAME_STATE_PROJECTOR_VERSION;
use sk_rules::dice_record::ServiceDice;
use sk_rules::normalize::normalize_campaign_state;
use sk_rules::replay::{apply_game_event, with_retention_mode, RETENTION_REDUCER_VERSION};
use sk_rules::resolve::api::RulesEngine;
use sk_store::{EventStore, InitializeRequest, Reducer, RetentionMode, StoreOptions};

const FIXED_NOW: &str = "2026-08-01T10:00:00.000Z";
static FIXED_MS: LazyLock<i64> = LazyLock::new(|| sk_core::clock::parse_iso(FIXED_NOW).expect("момент"));

struct Fixture {
    blobs: Vec<Value>,
    states: Vec<Value>,
    pure: Vec<Value>,
    runs: Vec<Value>,
    answers: Value,
}

fn take(root: &mut Value, key: &str) -> Vec<Value> {
    match root.get_mut(key).map(Value::take) {
        Some(Value::Array(items)) => items,
        _ => Vec::new(),
    }
}

static FIXTURE: LazyLock<Fixture> = LazyLock::new(|| {
    let bytes: &[u8] = include_bytes!("../fixtures/o2.json.gz");
    let mut text = String::new();
    flate2::read::GzDecoder::new(bytes).read_to_string(&mut text).expect("gzip эталона");
    let mut root: Value = serde_json::from_str(&text).expect("JSON эталона");
    let answers = take(&mut root, "answers").into_iter().next().unwrap_or(Value::Null);
    Fixture { blobs: take(&mut root, "blobs"), states: take(&mut root, "states"), pure: take(&mut root, "pure"), runs: take(&mut root, "runs"), answers }
});

/// Состояние по ссылке эталона: индекс таблицы `states` или `{ raw }`.
fn state(reference: &Value) -> Value {
    if let Some(raw) = reference.get("raw") {
        return raw.clone();
    }
    let Some(index) = reference.as_u64() else { return Value::Null };
    let entry = &FIXTURE.states[index as usize];
    let mut map = Map::new();
    for (name, blob) in entry["k"].as_array().into_iter().flatten().zip(entry["v"].as_array().into_iter().flatten()) {
        map.insert(js::s(Some(name)), FIXTURE.blobs[blob.as_u64().unwrap_or(0) as usize].clone());
    }
    Value::Object(map)
}

fn sha(value: &Value) -> String {
    hash::sha256_hex(js::stringify(value))
}

fn canonical(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            Value::Object(keys.into_iter().map(|key| (key.clone(), canonical(&map[key]))).collect())
        }
        other => other.clone(),
    }
}

/// Метки настоящих часов: решение отряда, время рассказа у Rust.
const MASK: [&str; 4] = ["createdAt", "expiresAt", "elapsed_ms", "recovered_at"];

fn mask(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(mask).collect()),
        Value::Object(map) => Value::Object(map.iter().filter(|(key, _)| !MASK.contains(&key.as_str())).map(|(key, field)| (key.clone(), mask(field))).collect()),
        other => other.clone(),
    }
}

fn csha(value: &Value) -> String {
    sha(&canonical(&mask(value)))
}

const DROP: [&str; 4] = ["metadata", "reducer_version", "events_applied", "current_state_version"];
const HASHED: [&str; 5] = ["events", "mechanics", "visible_state_changes", "reveal", "spawn"];

fn summarize(value: &Value, key: &str) -> Value {
    match value {
        Value::Array(items) if HASHED.contains(&key) => Value::Array(items.iter().map(|entry| Value::String(csha(entry))).collect()),
        Value::Array(items) => Value::Array(items.iter().map(|entry| summarize(entry, "")).collect()),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().filter(|name| !DROP.contains(&name.as_str()) && !MASK.contains(&name.as_str())).collect();
            keys.sort();
            Value::Object(keys.into_iter().map(|name| (name.clone(), if name == "state" || name == "authoritative_state" { Value::String(csha(&map[name])) } else { summarize(&map[name], name) })).collect())
        }
        other => other.clone(),
    }
}

// --- сверка ---------------------------------------------------------------------------

enum Verdict {
    Same,
    JsFault,
    Different,
}

fn compare(expected: &Value, actual: &Value) -> Verdict {
    match (expected.get("ok"), actual.get("ok")) {
        (Some(left), Some(right)) => {
            if js::stringify(&canonical(left)) == js::stringify(&canonical(right)) {
                Verdict::Same
            } else {
                Verdict::Different
            }
        }
        (None, None) => match (expected.get("err"), actual.get("err")) {
            (Some(left), Some(right)) if left == right => Verdict::Same,
            (None, None) if expected.get("fault").is_some() && actual.get("fault").is_some() && expected.get("code") == actual.get("code") => Verdict::Same,
            _ => Verdict::Different,
        },
        (None, Some(_)) if expected.get("fault").is_some() => Verdict::JsFault,
        _ => Verdict::Different,
    }
}

fn first_difference(path: &str, left: &Value, right: &Value) -> Option<String> {
    match (left, right) {
        (Value::Object(a), Value::Object(b)) => {
            for key in a.keys().chain(b.keys().filter(|key| !a.contains_key(*key))) {
                let next = format!("{path}.{key}");
                match (a.get(key), b.get(key)) {
                    (Some(x), Some(y)) => {
                        if let Some(found) = first_difference(&next, x, y) {
                            return Some(found);
                        }
                    }
                    (x, y) => return Some(format!("{next}: JS {} / Rust {}", clip(x.unwrap_or(&Value::Null)), clip(y.unwrap_or(&Value::Null)))),
                }
            }
            None
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                return Some(format!("{path}: длина JS {} / Rust {}: {} / {}", a.len(), b.len(), clip(left), clip(right)));
            }
            a.iter().zip(b).enumerate().find_map(|(index, (x, y))| first_difference(&format!("{path}[{index}]"), x, y))
        }
        _ if js::stringify(left) == js::stringify(right) => None,
        _ => Some(format!("{path}: JS {} / Rust {}", clip(left), clip(right))),
    }
}

fn clip(value: &Value) -> String {
    js::stringify(value).chars().take(700).collect()
}

#[derive(Default)]
struct Tally {
    total: usize,
    same: usize,
    js_faults: Vec<String>,
    failures: Vec<String>,
}

impl Tally {
    fn check(&mut self, label: String, expected: &Value, actual: &Value) -> bool {
        self.total += 1;
        match compare(expected, actual) {
            Verdict::Same => {
                self.same += 1;
                true
            }
            Verdict::JsFault => {
                self.js_faults.push(label);
                false
            }
            Verdict::Different => {
                let detail = first_difference("", expected, actual).unwrap_or_default();
                self.failures.push(format!("{label}\n  {detail}"));
                false
            }
        }
    }

    fn finish(self, name: &str) {
        assert!(self.total > 0, "нет случаев {name}");
        assert!(self.failures.is_empty(), "{name}: {} из {} расходятся:\n{}", self.failures.len(), self.total, self.failures.iter().take(12).cloned().collect::<Vec<_>>().join("\n"));
        assert!(self.js_faults.is_empty(), "{name}: JS упал, Rust ответил: {:?}", self.js_faults.iter().take(8).collect::<Vec<_>>());
        eprintln!("{name}: {} сверок совпали", self.same);
    }
}

fn parallel<F>(items: &[Value], check: F) -> Tally
where
    F: Fn(usize, &Value, &mut Tally) + Sync,
{
    let threads = std::env::var("O2_THREADS").ok().and_then(|value| value.parse::<usize>().ok()).unwrap_or(2).clamp(1, 4);
    let chunk = items.len().div_ceil(threads).max(1);
    let mut tally = Tally::default();
    std::thread::scope(|scope| {
        let workers: Vec<_> = items
            .chunks(chunk)
            .enumerate()
            .map(|(part, slice)| {
                let check = &check;
                std::thread::Builder::new()
                    .stack_size(256 << 20)
                    .spawn_scoped(scope, move || {
                        let mut local = Tally::default();
                        for (offset, item) in slice.iter().enumerate() {
                            check(part * chunk + offset, item, &mut local);
                        }
                        local
                    })
                    .expect("поток сверки")
            })
            .collect();
        for worker in workers {
            let local = worker.join().expect("поток сверки");
            tally.total += local.total;
            tally.same += local.same;
            tally.js_faults.extend(local.js_faults);
            tally.failures.extend(local.failures);
        }
    });
    tally
}

// --- чистые экспорты ------------------------------------------------------------------

fn arg<'a>(case: &'a Value, index: usize) -> Option<&'a Value> {
    if case["undef"].as_array().is_some_and(|undef| undef.iter().any(|entry| entry.as_u64() == Some(index as u64))) {
        return None;
    }
    case["args"].as_array().and_then(|args| args.get(index))
}

fn state_arg(case: &Value, index: usize) -> Value {
    match arg(case, index) {
        Some(value) => match value.get("state") {
            Some(reference) => state(reference),
            None => value.clone(),
        },
        None => Value::Null,
    }
}

/// Параметр функции JS со значением по умолчанию `''`.
fn param(value: Option<&Value>, fallback: &str) -> String {
    match value {
        None => fallback.into(),
        some => js::string(some),
    }
}

fn pure_outcome(case: &Value) -> Value {
    let fn_name = js::s(case.get("fn"));
    let field = |index: usize, key: &str| arg(case, index).and_then(|value| value.get(key));
    let list = |value: Option<&Value>| value.and_then(Value::as_array).cloned().unwrap_or_default();
    let value: Result<Value, String> = match fn_name.as_str() {
        "narrationStoryContext" => {
            let viewer = arg(case, 1).cloned().unwrap_or_else(|| json!({}));
            narration_story_context(&state_arg(case, 0), &viewer, &list(arg(case, 2))).map_err(|error| error.to_string())
        }
        "narrationNpcReactions" => {
            let options = arg(case, 2);
            let target = options.and_then(|options| options.get("socialTarget")).filter(|target| js::truthy(Some(target))).map(|target| SocialTarget { npc_id: target.get("npcId").cloned().unwrap_or(Value::Null), success: target.get("success").and_then(Value::as_bool) });
            Ok(json!(narration_npc_reactions(&list(arg(case, 0)), &list(arg(case, 1)), js::truthy(options.and_then(|options| options.get("heroDeed"))), target.as_ref())))
        }
        "withDetailReactions" => {
            let details: Vec<String> = list(arg(case, 1)).iter().map(|detail| js::s(Some(detail))).collect();
            Ok(json!(with_detail_reactions(list(arg(case, 0)), &details)))
        }
        "rollPurposeLabel" => Ok(json!(roll_purpose_label(arg(case, 0)))),
        "eventsToClientEffects" => Ok(events_to_client_effects(&list(arg(case, 0)), &list(arg(case, 1)))),
        "structuredCommandsFingerprint" => Ok(json!(structured_commands_fingerprint(arg(case, 0)))),
        "narrationRequestFingerprint" => {
            let fields = RequestFingerprint {
                campaign_id: param(field(0, "campaignId"), ""),
                player_id: param(field(0, "playerId"), ""),
                message: param(field(0, "message"), ""),
                npc_id: param(field(0, "npcId"), ""),
                request_kind: param(field(0, "requestKind"), "action"),
                clarification_id: param(field(0, "clarificationId"), ""),
                supersedes_check_id: param(field(0, "supersedesCheckId"), ""),
                supersedes_proposal_id: param(field(0, "supersedesProposalId"), ""),
                question_check_id: param(field(0, "questionCheckId"), ""),
                question_proposal_id: param(field(0, "questionProposalId"), ""),
                operation: param(field(0, "operation"), ""),
            };
            Ok(json!(narration_request_fingerprint(&fields)))
        }
        "speechAddressee" => {
            let allow = js::truthy(field(3, "allowSpell"));
            Ok(speech_addressee(&js::s(arg(case, 0)), &state_arg(case, 1), &js::string(arg(case, 2)), allow).map_or(Value::Null, |found| found.to_json()))
        }
        "spellSpeechFollowUp" => Ok(spell_speech_follow_up(&js::s(arg(case, 0)), &state_arg(case, 1), &js::string(arg(case, 2))).map_or(Value::Null, |found| json!({ "npcId": found.npc_id, "speech": found.speech }))),
        other => panic!("неизвестная функция {other}"),
    };
    match value {
        Ok(value) => json!({ "ok": value }),
        Err(message) => json!({ "fault": "Error", "code": null, "message": message }),
    }
}

#[test]
fn pure_exports_match() {
    let tally = parallel(&FIXTURE.pure, |index, case, tally| {
        let actual = pure_outcome(case);
        tally.check(format!("#{index} {} {}", js::s(case.get("src")), js::s(case.get("fn"))), &case["o"], &actual);
    });
    tally.finish("чистые экспорты");
}

// --- журнал, движок, роли -----------------------------------------------------------------

struct GameReducer;

fn mode_name(mode: RetentionMode) -> &'static str {
    match mode {
        RetentionMode::Legacy => "legacy",
        RetentionMode::Current => "current",
    }
}

impl Reducer for GameReducer {
    fn reducer_version(&self) -> i64 {
        RETENTION_REDUCER_VERSION
    }

    fn snapshot_projector_version(&self) -> i64 {
        GAME_STATE_PROJECTOR_VERSION
    }

    fn normalize(&self, state: Value, mode: RetentionMode) -> Value {
        match with_retention_mode(mode_name(mode), || normalize_campaign_state(&state)) {
            Ok(Ok(normalized)) => normalized,
            _ => state,
        }
    }

    fn apply(&self, state: Value, event: &Value, mode: RetentionMode) -> Result<Value, String> {
        with_retention_mode(mode_name(mode), || apply_game_event(&state, event))?.map_err(|error| error.to_string())
    }
}

fn store() -> EventStore {
    let serial = Arc::new(AtomicU64::new(0));
    let options = StoreOptions { clock: Arc::new(|| *FIXED_MS), id_factory: Arc::new(move || format!("o2-event-{}", serial.fetch_add(1, Ordering::SeqCst) + 1)), ..StoreOptions::default() };
    EventStore::in_memory(Arc::new(GameReducer), options).expect("хранилище")
}

struct Mulberry(u32);

impl Rng for Mulberry {
    fn randint(&mut self, minimum: i64, maximum: i64) -> Result<i64, DiceError> {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        let r = f64::from(t ^ (t >> 14)) / 4_294_967_296.0;
        Ok(minimum + (r * (maximum - minimum + 1) as f64).floor() as i64)
    }
}

fn engine(seed: u32, rolls: Arc<AtomicU64>) -> RefCell<RulesEngine> {
    let dice = DiceService::new(Mulberry(seed), Box::new(move || format!("o2-roll-{}", rolls.fetch_add(1, Ordering::SeqCst) + 1)), Box::new(|| FIXED_NOW.to_string()));
    let mut uuid = 0u64;
    RefCell::new(RulesEngine {
        dice: Box::new(ServiceDice::new(dice)),
        uuid: Box::new(move || {
            uuid += 1;
            format!("uuid-{uuid}")
        }),
    })
}

fn registry(seed: u32, rolls: Arc<AtomicU64>) -> Mutex<RollRegistry> {
    let dice = DiceService::new(Mulberry(seed ^ 0x5bd1_e995), Box::new(move || format!("o2-registry-roll-{}", rolls.fetch_add(1, Ordering::SeqCst) + 1)), Box::new(|| FIXED_NOW.to_string()));
    let mut checks = 0u64;
    let options = RollRegistryOptions {
        now: Arc::new(|| *FIXED_MS),
        check_id_factory: Box::new(move || {
            checks += 1;
            format!("o2-check-{checks}")
        }),
        ..RollRegistryOptions::default()
    };
    Mutex::new(RollRegistry::new(Box::new(dice), options).expect("реестр бросков"))
}

/// Время трасс — счётчик, как `CountingTraceStore` генератора.
struct CountingTraceStore {
    inner: FileTraceStore,
    serial: Mutex<u64>,
}

impl TurnTraceStore for CountingTraceStore {
    fn get(&self, campaign_id: &str, turn_id: &str) -> OrchestratorResult<Option<Value>> {
        TurnTraceStore::get(&self.inner, campaign_id, turn_id)
    }

    fn latest(&self, campaign_id: &str, predicate: Option<&dyn Fn(&Value) -> bool>) -> OrchestratorResult<Option<Value>> {
        TurnTraceStore::latest(&self.inner, campaign_id, predicate)
    }

    fn recent(&self, campaign_id: &str, limit: usize, predicate: Option<&dyn Fn(&Value) -> bool>) -> OrchestratorResult<Vec<Value>> {
        TurnTraceStore::recent(&self.inner, campaign_id, limit, predicate)
    }

    fn save(&self, input: &Value) -> OrchestratorResult<Value> {
        let mut input = input.clone();
        if !js::truthy(input.get("created_at")) {
            let mut serial = self.serial.lock().expect("счётчик");
            *serial += 1;
            input["created_at"] = Value::String(sk_core::clock::iso(*FIXED_MS + (*serial as i64) * 1000));
        }
        TurnTraceStore::save(&self.inner, &input)
    }

    fn save_if_absent(&self, input: &Value) -> Option<OrchestratorResult<Value>> {
        let existing = match self.get(&js::s(input.get("campaign_id")), &js::s(input.get("turn_id"))) {
            Ok(existing) => existing,
            Err(error) => return Some(Err(error)),
        };
        Some(match existing {
            Some(trace) => Ok(trace),
            None => self.save(input),
        })
    }
}

/// Модель-заглушка эталона: записывает запросы (хешем), отвечает по кругу.
struct RecordingLlm {
    role: &'static str,
    calls: Arc<Mutex<Vec<Value>>>,
    dump: Option<Arc<Mutex<Vec<Value>>>>,
    answers: Vec<Value>,
    index: Mutex<usize>,
}

impl RecordingLlm {
    fn next(&self, input: &Value) -> Result<Value, LlmError> {
        self.calls.lock().expect("вызовы").push(json!({ "role": self.role, "input": csha(input) }));
        if let Some(dump) = &self.dump {
            dump.lock().expect("отладка").push(json!({ "role": self.role, "input": canonical(&mask(input)) }));
        }
        let mut index = self.index.lock().expect("счётчик");
        let answer = self.answers.get(*index % self.answers.len().max(1)).cloned().unwrap_or(Value::Null);
        *index += 1;
        if answer == json!("throw") {
            return Err(LlmError::new("LLM_DOWN", "модель недоступна"));
        }
        Ok(answer)
    }
}

impl LlmClient for RecordingLlm {
    fn model(&self) -> Option<String> {
        None
    }

    fn complete<'a>(&'a self, input: &'a Value, _options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        Box::pin(async move { self.next(input).map(|answer| json!({ "content": answer, "json": answer })) })
    }

    fn complete_json<'a>(&'a self, input: &'a Value, _options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        Box::pin(async move { self.next(input) })
    }

    fn probe(&self) -> LlmFuture<'_, Result<Value, LlmError>> {
        Box::pin(async { Ok(json!({})) })
    }

    fn health(&self) -> Value {
        json!({})
    }
}

thread_local! {
    static DEBUG_DUMP: RefCell<Option<Arc<Mutex<Vec<Value>>>>> = const { RefCell::new(None) };
}

fn llm(role: &'static str, calls: &Arc<Mutex<Vec<Value>>>) -> Arc<RecordingLlm> {
    let answers = FIXTURE.answers.get(role).and_then(Value::as_array).cloned().unwrap_or_default();
    let dump = DEBUG_DUMP.with(|dump| dump.borrow().clone());
    Arc::new(RecordingLlm { role, calls: calls.clone(), dump, answers, index: Mutex::new(0) })
}

/// Ответы роли из записи теста JS: по порядку, затем последний.
struct Replay {
    entries: Vec<Value>,
    index: Mutex<usize>,
    awaits: bool,
}

impl Replay {
    fn new(entries: Option<&Value>, awaits: bool) -> Self {
        Self { entries: entries.and_then(Value::as_array).cloned().unwrap_or_default(), index: Mutex::new(0), awaits }
    }

    fn next(&self) -> OrchestratorResult<Value> {
        let mut index = self.index.lock().expect("счётчик");
        let entry = self.entries.get((*index).min(self.entries.len().saturating_sub(1))).cloned();
        *index += 1;
        let Some(entry) = entry else { return Err(OrchestratorError::plain("нет записанного ответа роли")) };
        if let Some(error) = entry.get("err") {
            return Err(OrchestratorError::named(&js::s(error.get("name")), error.get("code").and_then(Value::as_str).map(str::to_string), js::s(error.get("message"))));
        }
        Ok(entry.get("ok").cloned().unwrap_or(Value::Null))
    }
}

impl IntentReader for Replay {
    fn parse<'a>(&'a self, _message: &'a str, _player_id: &'a str, _visible_state: &'a Value) -> AgentFuture<'a, OrchestratorResult<Value>> {
        Box::pin(async move { self.next() })
    }
}

impl PlanAdjudicator for Replay {
    fn create_plan<'a>(&'a self, _intent: &'a Value, _state: &'a Value, _rules: &'a Value) -> AgentFuture<'a, OrchestratorResult<Value>> {
        Box::pin(async move { self.next() })
    }
}

impl RuleSearch for Replay {
    fn search<'a>(&'a self, _request: &'a Value) -> AgentFuture<'a, OrchestratorResult<Value>> {
        Box::pin(async move { self.next() })
    }
}

impl TurnNarrator for Replay {
    fn render<'a>(&'a self, _brief: &'a Value, _options: NarrationOptions) -> AgentFuture<'a, OrchestratorResult<Value>> {
        Box::pin(async move { self.next() })
    }
}

impl SocialResponder for Replay {
    fn respond<'a>(&'a self, _input: &'a Value) -> AgentFuture<'a, OrchestratorResult<Option<Value>>> {
        Box::pin(async move { self.next().map(|value| (!value.is_null()).then_some(value)) })
    }
}

impl LoreRetell for Replay {
    fn retell<'a>(&'a self, _input: &'a Value) -> AgentFuture<'a, OrchestratorResult<Option<Value>>> {
        Box::pin(async move { self.next().map(|value| (!value.is_null()).then_some(value)) })
    }
}

impl TableDiscussion for Replay {
    fn discuss<'a>(&'a self, _state: &'a Value, _actor_id: &'a str, _question: &'a str, _action: String, _recent: Vec<Value>) -> AgentFuture<'a, OrchestratorResult<Value>> {
        Box::pin(async move { self.next() })
    }
}

impl UnknownActionHandler for Replay {
    fn handle_unknown_action<'a>(&'a self, _request: &'a UnknownAction) -> AgentFuture<'a, OrchestratorResult<Value>> {
        Box::pin(async move { self.next() })
    }

    fn action_adjudicator(&self) -> Option<Arc<dyn FreeActionReader>> {
        None
    }
}

impl FreeActionReader for Replay {
    fn read<'a>(&'a self, _state: &'a Value, _actor_id: &'a str, _text: &'a str, _fallback: &'a Value) -> AgentFuture<'a, OrchestratorResult<Value>> {
        Box::pin(async move { self.next() })
    }

    fn awaits_model(&self) -> bool {
        self.awaits
    }
}

struct ThreadWaker(std::thread::Thread);

impl Wake for ThreadWaker {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
}

fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = Box::pin(future);
    let waker = Waker::from(Arc::new(ThreadWaker(std::thread::current())));
    let mut context = TaskContext::from_waker(&waker);
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
            return value;
        }
        std::thread::park();
    }
}

// --- прогоны --------------------------------------------------------------------------

struct Session<'a> {
    orchestrator: &'a GameOrchestrator,
    journal: &'a EventStore,
    registry: Option<&'a Mutex<RollRegistry>>,
    campaign: String,
    hero: String,
    last: Option<Value>,
    last_input: Option<Value>,
    stream: Arc<Mutex<Vec<Value>>>,
}

fn spread(base: &Value, patch: &Value) -> Value {
    js::spread(base, patch.clone())
}

fn input_for(step: &Value, session: &Session<'_>) -> Result<Option<Value>, OrchestratorError> {
    let loaded = sk_store::executor::Journal::load(session.journal, &session.campaign)?;
    let player = step.get("playerId").cloned().unwrap_or_else(|| Value::String(session.hero.clone()));
    let base = json!({ "state": loaded.state, "campaignId": session.campaign, "playerId": player, "user": { "role": if js::truthy(step.get("admin")) { "admin" } else { "player" } } });
    let last = session.last.as_ref();
    let field = |value: Option<&Value>, key: &str| value.and_then(|value| value.get(key)).filter(|value| !value.is_null()).cloned();
    Ok(match js::s(step.get("op")).as_str() {
        "raw" => {
            let mut fields = step.get("input").cloned().unwrap_or_else(|| json!({}));
            if let Some(reference) = step.get("stateRef").filter(|value| !value.is_null()) {
                fields["state"] = state(reference);
            }
            Some(fields)
        }
        "handle" => Some(spread(&base, step.get("fields").unwrap_or(&json!({})))),
        "answer" => {
            let Some(id) = field(field(last, "clarification").as_ref(), "id").filter(|id| js::truthy(Some(id))) else { return Ok(None) };
            Some(spread(&base, &json!({ "message": step.get("message"), "clarificationId": id, "idempotencyKey": step.get("key"), "manualRoll": js::truthy(step.get("manualRoll")) })))
        }
        "roll" => {
            let check = field(last, "check");
            let Some(check_id) = field(check.as_ref(), "check_id").filter(|id| js::truthy(Some(id))) else { return Ok(None) };
            let Some(registry) = session.registry else { return Ok(None) };
            let actor = js::s(Some(&field(check.as_ref(), "actor_id").unwrap_or_else(|| base["playerId"].clone())));
            let mut registry = registry.lock().expect("реестр");
            let error = |error: sk_infra::roll_registry::RollRegistryError| OrchestratorError::named(error.name(), error.code().map(str::to_string), error.to_string());
            let issued = registry.issue(&json!({ "checkId": check_id, "campaignId": session.campaign, "actorId": actor })).map_err(error)?;
            let verified = registry.consume(issued.get("roll_id").unwrap_or(&Value::Null), &json!({ "campaignId": session.campaign, "actorId": actor, "idempotencyKey": step.get("key") }), None).map_err(error)?;
            let message = field(last, "resolved_action").or_else(|| field(session.last_input.as_ref(), "message")).unwrap_or_else(|| Value::String(String::new()));
            let mut patch = json!({ "playerId": actor, "message": message, "verifiedRoll": verified, "manualRoll": true, "idempotencyKey": step.get("key") });
            if let Some(clarification) = field(check.as_ref(), "clarification_id").filter(|id| js::truthy(Some(id))) {
                patch["clarificationId"] = clarification;
            }
            Some(spread(&base, &patch))
        }
        "confirm" => {
            let id = field(field(last, "action_proposal").as_ref(), "id").or_else(|| field(last, "proposal_id")).filter(|id| js::truthy(Some(id)));
            let (Some(id), Some(last_input)) = (id, session.last_input.as_ref()) else { return Ok(None) };
            let merged = spread(&base, last_input);
            Some(spread(&merged, &json!({ "state": loaded.state, "confirmedProposalId": id, "idempotencyKey": step.get("key") })))
        }
        "repeat" => session.last_input.as_ref().map(|input| spread(input, &json!({ "state": loaded.state }))),
        "conflict" => match session.last_input.as_ref().filter(|input| js::truthy(input.get("idempotencyKey"))) {
            Some(input) => Some(spread(input, &json!({ "state": loaded.state, "message": format!("{} и ещё раз", js::s(input.get("message"))) }))),
            None => None,
        },
        other => return Err(OrchestratorError::plain(format!("неизвестный шаг {other}"))),
    })
}

async fn perform(step: &Value, session: &mut Session<'_>) -> OrchestratorResult<Value> {
    let Some(mut fields) = input_for(step, session)? else { return Ok(json!({ "skip": true })) };
    let director = js::truthy(fields.get("__director"));
    js::delete(&mut fields, "__director");
    let mut input = HandleInput::new(fields.clone());
    input.director_capability = director;
    if js::truthy(step.get("hooks").and_then(|hooks| hooks.get("start"))) {
        let stream = session.stream.clone();
        input.on_narration_start = Some(Arc::new(move |payload: &Value| stream.lock().expect("поток").push(json!(["start", payload]))));
    }
    if js::truthy(step.get("hooks").and_then(|hooks| hooks.get("progress"))) {
        let stream = session.stream.clone();
        input.on_narration_progress = Some(Arc::new(move |text: &str, payload: &Value| stream.lock().expect("поток").push(json!(["progress", text, payload]))));
    }
    let mut remembered = fields;
    js::delete(&mut remembered, "state");
    session.last_input = Some(remembered);
    let result = session.orchestrator.handle(input).await?;
    session.last = Some(result.clone());
    Ok(result)
}

struct RunOutcome {
    outcomes: Vec<Value>,
    final_state: Option<Value>,
    calls: Vec<Value>,
    stream: Vec<Value>,
    setup: Option<Value>,
}

fn temp_dir(case: &Value, index: usize) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("sk-o2-rs-{}-{index}-{}", std::process::id(), js::s(case.get("seed"))));
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn run_case(index: usize, case: &Value) -> RunOutcome {
    let campaign = js::s(case.get("campaign"));
    let seed = case["seed"].as_u64().unwrap_or(0) as u32;
    let config = &case["config"];
    let opt = |key: &str| js::s(config.get(key));
    let flag = |key: &str| js::truthy(config.get(key));
    let journal = Arc::new(store());
    let calls = Arc::new(Mutex::new(Vec::new()));
    let debug = std::env::var("O2_DEBUG").ok().is_some_and(|value| value.split(',').any(|entry| entry.parse::<usize>().ok() == Some(index)));
    let dump = debug.then(|| Arc::new(Mutex::new(Vec::new())));
    DEBUG_DUMP.with(|slot| *slot.borrow_mut() = dump.clone());
    if let Err(error) = journal.initialize_campaign(InitializeRequest::new(campaign.clone(), state(&case["s"]))) {
        return RunOutcome { outcomes: Vec::new(), final_state: None, calls: Vec::new(), stream: Vec::new(), setup: Some(json!({ "fault": "Error", "code": error.code, "message": error.message })) };
    }
    let dir = temp_dir(case, index);
    let rolls = Arc::new(AtomicU64::new(0));
    let rules = Arc::new(engine(seed, rolls.clone()));
    let roll_registry = flag("registry").then(|| Arc::new(registry(seed, rolls)));
    let clarification_serial = Arc::new(AtomicU64::new(0));
    let storage_file = config.get("clarifications").filter(|value| js::truthy(Some(value))).map(|snapshot| {
        let file = dir.join("clarifications.json");
        std::fs::write(&file, js::stringify(snapshot)).expect("снимок уточнений");
        file
    });
    let serial = clarification_serial.clone();
    let clarifications = ClarificationRegistry::new(ClarificationRegistryOptions {
        storage_file,
        ttl_ms: None,
        now: Some(Box::new(|| *FIXED_MS as f64)),
        id_factory: Some(Box::new(move || format!("o2-clar-{}", serial.fetch_add(1, Ordering::SeqCst) + 1))),
    });
    let clarifications = match clarifications {
        Ok(registry) => Arc::new(Mutex::new(registry)),
        Err(error) => return RunOutcome { outcomes: Vec::new(), final_state: None, calls: Vec::new(), stream: Vec::new(), setup: Some(json!({ "fault": "Error", "code": error.code, "message": error.message })) },
    };
    let roles = &config["roles"];
    let replay = |key: &str| Arc::new(Replay::new(roles.get(key), flag("awaits")));
    let trace: Option<Arc<dyn TurnTraceStore>> = flag("trace").then(|| Arc::new(CountingTraceStore { inner: FileTraceStore::new(dir.join("traces")).expect("трассы"), serial: Mutex::new(0) }) as Arc<dyn TurnTraceStore>);
    let llm_adjudicator = (opt("adjudicator") == "llm").then(|| Arc::new(ActionAdjudicator::new(Some(llm("adjudicator", &calls)), None, None)));
    let reader: Option<Arc<dyn FreeActionReader>> = match opt("adjudicator").as_str() {
        "llm" => llm_adjudicator.clone().map(|adjudicator| adjudicator as Arc<dyn FreeActionReader>),
        "plain" => Some(Arc::new(ActionAdjudicator::new(None, None, None))),
        "replay" => Some(replay("read")),
        _ => None,
    };
    let narrator: Option<Arc<dyn TurnNarrator>> = match opt("narrator").as_str() {
        "llm" => {
            let mut narrator = NarratorConfig::with_client(llm("narrator", &calls), "RecordingLlm");
            narrator.json_only_client = true;
            Some(Arc::new(Narrator::new(narrator)))
        }
        "plain" => Some(Arc::new(Narrator::new(NarratorConfig::default()))),
        "replay" => Some(replay("render")),
        _ => None,
    };
    let social: Option<Arc<dyn SocialResponder>> = match opt("social").as_str() {
        "llm" => Some(Arc::new(NpcSocialController::new(Some(llm("social", &calls))))),
        "plain" => Some(Arc::new(NpcSocialController::new(None))),
        "replay" => Some(replay("respond")),
        _ => None,
    };
    let lore: Option<Arc<dyn LoreRetell>> = match opt("lore").as_str() {
        "llm" => Some(Arc::new(LoreVoice::new(Some(llm("lore", &calls)), None))),
        "plain" => Some(Arc::new(LoreVoice::new(None, None))),
        "replay" => Some(replay("retell")),
        _ => None,
    };
    let journal_dyn: Arc<dyn OrchestratorJournal> = journal.clone();
    let unknown: Arc<dyn UnknownActionHandler> = if flag("unknown") {
        replay("unknown")
    } else {
        let rules_dyn: Arc<dyn sk_orchestrator::autonomous_orchestrator::OrchestratorRules> = rules.clone();
        let mut autonomous = AutonomousCampaignOrchestrator::new(journal_dyn.clone(), rules_dyn).with_now(Arc::new(|| *FIXED_MS));
        if let Some(reader) = reader {
            autonomous = autonomous.with_action_adjudicator(reader);
        }
        if let Some(registry) = &roll_registry {
            if !js::is_false(config.get("o1Registry")) {
                autonomous = autonomous.with_roll_registry(registry.clone() as Arc<dyn CheckRegistry>);
            }
        }
        Arc::new(autonomous)
    };
    let id_serial = Arc::new(AtomicU64::new(0));
    let mut options = GameOrchestratorOptions::new(journal_dyn, rules.clone() as Arc<dyn TurnRules>);
    options.trace_store = trace;
    options.narrator = Some(narrator);
    options.npc_social_controller = social;
    options.unknown_action_handler = Some(unknown);
    options.lore_voice = lore;
    options.roll_registry = roll_registry.clone().map(|registry| registry as Arc<dyn TurnRollRegistry>);
    options.clarification_registry = Some(clarifications);
    if flag("parser") {
        options.intent_parser = Some(replay("parse"));
    }
    if flag("plan") {
        options.adjudicator = Some(replay("plan"));
    }
    if flag("retriever") {
        options.rule_retriever = Some(replay("search"));
    }
    if flag("discuss") {
        options.action_adjudicator = Some(replay("discuss"));
    } else if let Some(adjudicator) = &llm_adjudicator {
        options.action_adjudicator = Some(adjudicator.clone());
    }
    options.id_factory = Some(Arc::new(move || format!("o2-id-{}", id_serial.fetch_add(1, Ordering::SeqCst) + 1)));
    options.now = Some(Arc::new(|| *FIXED_MS));
    let orchestrator = match GameOrchestrator::new(options) {
        Ok(orchestrator) => orchestrator,
        Err(error) => return RunOutcome { outcomes: Vec::new(), final_state: None, calls: Vec::new(), stream: Vec::new(), setup: Some(error.to_json()) },
    };
    let stream = Arc::new(Mutex::new(Vec::new()));
    let mut session = Session { orchestrator: &orchestrator, journal: journal.as_ref(), registry: roll_registry.as_deref(), campaign: campaign.clone(), hero: opt("hero"), last: None, last_input: None, stream: stream.clone() };
    let mut outcomes = Vec::new();
    for step in case["steps"].as_array().into_iter().flatten() {
        let outcome = match block_on(perform(step, &mut session)) {
            Ok(result) => json!({ "ok": summarize(&result, "") }),
            Err(error) => error.to_json(),
        };
        outcomes.push(outcome);
    }
    let final_state = sk_store::executor::Journal::load(journal.as_ref(), &campaign).ok().map(|loaded| json!({ "version": loaded.state_version, "state": csha(&loaded.state) }));
    let recorded = calls.lock().expect("вызовы").clone();
    let streamed = stream.lock().expect("поток").clone();
    drop(session);
    drop(orchestrator);
    if let Some(dump) = &dump {
        eprintln!("отладка: прогон {index} в {}", dir.display());
        let _ = std::fs::write(dir.join("calls.json"), serde_json::to_string_pretty(&*dump.lock().expect("отладка")).unwrap_or_default());
        for (position, outcome) in outcomes.iter().enumerate() {
            let _ = std::fs::write(dir.join(format!("step-{position}.json")), serde_json::to_string_pretty(outcome).unwrap_or_default());
        }
    } else {
        let _ = std::fs::remove_dir_all(&dir);
    }
    RunOutcome { outcomes, final_state, calls: recorded, stream: streamed, setup: None }
}

#[test]
fn orchestrator_runs_match() {
    let only = std::env::var("O2_ONLY_RUN").ok().and_then(|value| value.parse::<usize>().ok());
    let tally = parallel(&FIXTURE.runs, |index, case, tally| {
        if only.is_some_and(|only| only != index) {
            return;
        }
        let label = format!("#{index} {} {}", js::s(case.get("src")), js::s(case.get("campaign")));
        let actual = run_case(index, case);
        if let Some(setup) = case.get("setup") {
            tally.check(format!("{label} setup"), &json!({ "fault": setup }), &actual.setup.map(|setup| json!({ "fault": setup })).unwrap_or_else(|| json!({ "ok": true })));
            return;
        }
        if let Some(setup) = &actual.setup {
            tally.check(format!("{label} setup"), &json!({ "ok": true }), &json!({ "fault": setup }));
            return;
        }
        let steps = case["steps"].as_array().cloned().unwrap_or_default();
        let expected = case["o"].as_array().cloned().unwrap_or_default();
        let mut aligned = true;
        for (position, (expected, actual)) in expected.iter().zip(&actual.outcomes).enumerate() {
            let op = js::s(steps.get(position).and_then(|step| step.get("op")));
            if !tally.check(format!("{label} шаг {position} {op}"), expected, actual) {
                aligned = false;
                break;
            }
        }
        if aligned {
            tally.check(format!("{label} итог"), &json!({ "ok": case["final"] }), &json!({ "ok": actual.final_state }));
            tally.check(format!("{label} модель"), &json!({ "ok": case["calls"] }), &json!({ "ok": actual.calls }));
            tally.check(format!("{label} поток"), &json!({ "ok": case["stream"] }), &json!({ "ok": actual.stream }));
        }
    });
    tally.finish("прогоны оркестратора");
}

//! Перенос `server/combat-lab.mjs`: процессный реестр прогонов боевого стенда
//! (`CombatLabRuns`) поверх сборки [`crate::combat_lab_setup`] — сценарии,
//! запуск, кадры наблюдателя, отчёт, отмена и вытеснение старых прогонов.
//!
//! Сам прогон боя (`runCombatScenario` из `eval/combat-lab.mjs`) — не модуль
//! сервера и в Rust не перенесён: реестр получает его как
//! [`ScenarioRunner`]. Асинхронность JS (`create` возвращает прогон в статусе
//! `running`, бой идёт дальше) повторена потоком: каждый прогон исполняется в
//! своём потоке, состояние реестра — под мьютексом, `cancel` ждёт завершения
//! прогона, как `await run.done`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexMap;
use sk_core::{hash, js};

use crate::combat_lab_setup::{
    assess_combat_lab_encounter, build_combat_lab_state, combat_lab_catalog, generate_combat_lab_encounter, CampaignRooms, CombatLabSetupError, EncounterOptions,
    NoRooms, Sources,
};

/// `COMBAT_SCENARIOS` из `eval/combat-lab.mjs`.
pub const COMBAT_SCENARIOS: [&str; 8] = ["duel", "approach", "difficult-terrain", "two-heroes", "ranged", "healing", "concentration", "opportunity-attack"];

fn scenario_name(id: &str) -> &str {
    match id {
        "duel" => "Дуэль",
        "approach" => "Сближение",
        "difficult-terrain" => "Труднопроходимая местность",
        "two-heroes" => "Два героя",
        "ranged" => "Дальний бой",
        "healing" => "Лечение",
        "concentration" => "Концентрация",
        "opportunity-attack" => "Атака по возможности",
        other => other,
    }
}

/// `CombatLabError`: отказ реестра с кодом и HTTP-статусом.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CombatLabError {
    pub message: String,
    pub code: String,
    pub status: u16,
}

impl CombatLabError {
    pub fn new(message: impl Into<String>, code: &str, status: u16) -> Self {
        Self { message: message.into(), code: code.into(), status }
    }
}

impl std::fmt::Display for CombatLabError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CombatLabError {}

/// Отказ `create`: своя ошибка реестра или отказ сборки стенда.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CreateError {
    Lab(CombatLabError),
    Setup(CombatLabSetupError),
}

impl CreateError {
    /// Статус маршрута: у `CombatLabError` — свой, у прочих — 400.
    pub fn status(&self) -> u16 {
        match self {
            CreateError::Lab(error) => error.status,
            CreateError::Setup(error) => error.status(),
        }
    }

    pub fn message(&self) -> &str {
        match self {
            CreateError::Lab(error) => &error.message,
            CreateError::Setup(error) => &error.message,
        }
    }

    pub fn code(&self) -> Option<&str> {
        match self {
            CreateError::Lab(error) => Some(&error.code),
            CreateError::Setup(error) => error.code.as_deref(),
        }
    }
}

/// Исключение прогона в форме `publicError(error)`: `{ message, code? }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunFailure {
    pub message: String,
    pub code: Option<String>,
}

impl RunFailure {
    pub fn new(message: impl Into<String>, code: Option<String>) -> Self {
        Self { message: message.into(), code }
    }

    fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("message".into(), Value::String(self.message.clone()));
        if let Some(code) = self.code.as_ref().filter(|code| !code.is_empty()) {
            map.insert("code".into(), Value::String(code.clone()));
        }
        Value::Object(map)
    }
}

impl From<CombatLabError> for RunFailure {
    fn from(error: CombatLabError) -> Self {
        Self { message: error.message, code: Some(error.code) }
    }
}

/// `AbortController.signal`.
#[derive(Debug, Clone, Default)]
pub struct AbortSignal(Arc<AtomicBool>);

impl AbortSignal {
    pub fn aborted(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    fn abort(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

/// `chooseCommand(view, actorId)`: план героя для своего состава.
pub type ChooseCommand = Arc<dyn Fn(&Value, &str) -> Value + Send + Sync>;

/// Вход прогона: `{ scenario, seed, initialState?, maxSteps?, chooseCommand? }`.
#[derive(Clone)]
pub struct ScenarioRun {
    pub scenario: String,
    pub seed: Value,
    pub initial_state: Option<Value>,
    pub max_steps: Option<i64>,
    pub choose_command: Option<ChooseCommand>,
}

/// `runCombatScenario`: исполняет бой, отдаёт кадры через `on_frame` (его
/// отказ прогон обязан вернуть как свой) и возвращает отчёт JSON
/// (`passed`, `error`, `initial_state`, `final_state`, `rolls`, `steps`).
pub trait ScenarioRunner: Send + Sync {
    fn run(&self, request: ScenarioRun, on_frame: &mut dyn FnMut(Value) -> Result<(), CombatLabError>, signal: &AbortSignal) -> Result<Value, RunFailure>;
}

/// `loadCampaign` реестра.
pub type SharedLoadCampaign = Arc<dyn Fn(&str) -> Result<Option<Value>, CombatLabSetupError> + Send + Sync>;

/// Параметры `new CombatLabRuns({ ... })`.
pub struct CombatLabRunsOptions {
    pub runner: Arc<dyn ScenarioRunner>,
    pub rooms: Arc<dyn CampaignRooms + Send + Sync>,
    pub load_campaign: Option<SharedLoadCampaign>,
    pub choose_command: Option<ChooseCommand>,
    /// `None` — 3.
    pub max_runs: Option<f64>,
    /// `None` — 2000.
    pub max_frames: Option<f64>,
}

impl CombatLabRunsOptions {
    pub fn new(runner: Arc<dyn ScenarioRunner>) -> Self {
        Self { runner, rooms: Arc::new(NoRooms), load_campaign: None, choose_command: None, max_runs: None, max_frames: None }
    }
}

struct RunRecord {
    id: String,
    status: &'static str,
    scenario: String,
    seed: Value,
    initial_state: Option<Value>,
    frames: Vec<Value>,
    error: Option<Value>,
    trace: Option<Value>,
    signal: Option<AbortSignal>,
    cancel_requested: bool,
}

#[derive(Default)]
struct Registry {
    runs: IndexMap<String, RunRecord>,
    active: Option<String>,
    creating: bool,
}

struct Shared {
    registry: Mutex<Registry>,
    finished: Condvar,
}

/// `CombatLabRuns`: небольшой процессный реестр асинхронных прогонов наблюдателя.
pub struct CombatLabRuns {
    runner: Arc<dyn ScenarioRunner>,
    rooms: Arc<dyn CampaignRooms + Send + Sync>,
    load_campaign: Option<SharedLoadCampaign>,
    choose_command: Option<ChooseCommand>,
    max_runs: usize,
    max_frames: usize,
    shared: Arc<Shared>,
}

/// `Math.max(min, Number(value) || fallback)`.
fn bounded(value: Option<f64>, min: f64, fallback: f64) -> usize {
    let number = value.unwrap_or(f64::NAN);
    let number = if number == 0.0 || number.is_nan() { fallback } else { number };
    number.max(min) as usize
}

fn lock(shared: &Shared) -> MutexGuard<'_, Registry> {
    shared.registry.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// `public(run, after)`.
fn public_view(run: &RunRecord, after: f64) -> Value {
    let frames: Vec<Value> = run.frames.iter().filter(|frame| js::number(frame.get("index")) > after).cloned().collect();
    let mut map = Map::new();
    map.insert("id".into(), Value::String(run.id.clone()));
    map.insert("status".into(), Value::String(run.status.into()));
    map.insert("scenario".into(), Value::String(run.scenario.clone()));
    map.insert("seed".into(), run.seed.clone());
    map.insert("frames".into(), Value::Array(frames));
    if let Some(error) = run.error.as_ref().filter(|error| js::truthy(Some(error))) {
        let message = error.get("message").filter(|message| js::truthy(Some(message))).unwrap_or(error);
        map.insert("error".into(), Value::String(js::string(Some(message))));
        if let Some(code) = error.get("code").filter(|code| js::truthy(Some(code))) {
            map.insert("error_code".into(), Value::String(js::string(Some(code))));
        }
    }
    Value::Object(map)
}

/// `report.steps` → `{ step, command, tactic, before_version, after_version }`.
fn trace_steps(steps: Option<&Value>) -> Result<Vec<Value>, RunFailure> {
    let steps = match steps.filter(|steps| !steps.is_null()) {
        None => return Ok(Vec::new()),
        Some(Value::Array(steps)) => steps,
        Some(_) => return Err(RunFailure::new("(report.steps ?? []).map is not a function", None)),
    };
    steps
        .iter()
        .map(|step| {
            if step.is_null() {
                return Err(RunFailure::new("Cannot destructure property 'step' of 'object null' as it is null.", None));
            }
            let mut map = Map::new();
            for key in ["step", "command", "tactic", "before_version", "after_version"] {
                if let Some(value) = step.get(key) {
                    map.insert(key.into(), value.clone());
                }
            }
            Ok(Value::Object(map))
        })
        .collect()
}

fn trace_of(report: &Value) -> Result<Value, RunFailure> {
    let mut map = Map::new();
    for key in ["initial_state", "final_state", "rolls", "error"] {
        if let Some(value) = report.get(key) {
            map.insert(key.into(), value.clone());
        }
    }
    map.insert("steps".into(), Value::Array(trace_steps(report.get("steps"))?));
    Ok(Value::Object(map))
}

impl CombatLabRuns {
    pub fn new(options: CombatLabRunsOptions) -> Self {
        Self {
            runner: options.runner,
            rooms: options.rooms,
            load_campaign: options.load_campaign,
            choose_command: options.choose_command,
            max_runs: bounded(options.max_runs, 1.0, 3.0),
            max_frames: bounded(options.max_frames, 2.0, 2000.0),
            shared: Arc::new(Shared { registry: Mutex::new(Registry::default()), finished: Condvar::new() }),
        }
    }

    fn with_sources<T>(&self, operation: impl FnOnce(&Sources<'_>) -> T) -> T {
        let load = self.load_campaign.clone();
        let closure = move |id: &str| match &load {
            Some(load) => load(id),
            None => Ok(None),
        };
        let load_ref: Option<&dyn Fn(&str) -> Result<Option<Value>, CombatLabSetupError>> = if self.load_campaign.is_some() { Some(&closure) } else { None };
        let sources = Sources::new(self.rooms.as_ref(), load_ref);
        operation(&sources)
    }

    /// `scenarios()`.
    pub fn scenarios(&self) -> Vec<Value> {
        COMBAT_SCENARIOS.iter().map(|id| json!({ "id": id, "name": scenario_name(id) })).collect()
    }

    /// `active()`: `{ id }` идущего прогона или `None`.
    pub fn active(&self) -> Option<Value> {
        let registry = lock(&self.shared);
        let id = registry.active.as_ref()?;
        let run = registry.runs.get(id)?;
        (run.status == "running").then(|| json!({ "id": run.id }))
    }

    /// `catalog()`.
    pub fn catalog(&self) -> Result<Value, CombatLabSetupError> {
        self.with_sources(combat_lab_catalog)
    }

    /// `assessEncounter(input)`: `{ assessment }`.
    pub fn assess_encounter(&self, input: Option<&Value>) -> Result<Value, CombatLabSetupError> {
        self.with_sources(|sources| {
            let options = EncounterOptions { sources: *sources, ..Default::default() };
            assess_combat_lab_encounter(input, &options).map(|assessment| json!({ "assessment": assessment }))
        })
    }

    /// `generateEncounter(input)`.
    pub fn generate_encounter(&self, input: Option<&Value>) -> Result<Value, CombatLabSetupError> {
        self.with_sources(|sources| {
            let options = EncounterOptions { sources: *sources, ..Default::default() };
            generate_combat_lab_encounter(input, &options)
        })
    }

    /// `create({ scenario = 'duel', seed, config })`: `None` — поле не задано.
    pub fn create(&self, scenario: Option<&Value>, seed: Option<&Value>, config: Option<&Value>) -> Result<Value, CreateError> {
        let default_scenario = Value::String("duel".into());
        let scenario = scenario.unwrap_or(&default_scenario);
        let known = scenario.as_str().is_some_and(|scenario| COMBAT_SCENARIOS.contains(&scenario));
        if !known && config.is_none() {
            return Err(CreateError::Lab(CombatLabError::new("Неизвестный сценарий боевого стенда", "INVALID_COMBAT_LAB_SCENARIO", 400)));
        }
        let seed_valid = js::is_safe_integer(seed) && seed.and_then(Value::as_f64).is_some_and(|seed| (0.0..=4_294_967_295.0).contains(&seed));
        let Some(seed) = seed.filter(|_| seed_valid) else {
            return Err(CreateError::Lab(CombatLabError::new("seed должен быть целым числом от 0 до 4294967295", "INVALID_COMBAT_LAB_SEED", 400)));
        };
        {
            let mut registry = lock(&self.shared);
            if registry.active.is_some() || registry.creating {
                return Err(CreateError::Lab(CombatLabError::new("Уже выполняется один прогон боевого стенда", "COMBAT_LAB_BUSY", 409)));
            }
            registry.creating = true;
        }
        let result = self.create_locked(scenario, seed, config);
        lock(&self.shared).creating = false;
        result
    }

    fn create_locked(&self, scenario: &Value, seed: &Value, config: Option<&Value>) -> Result<Value, CreateError> {
        let initial_state = match config {
            None => None,
            Some(config) => Some(self.with_sources(|sources| build_combat_lab_state(Some(config), sources)).map_err(CreateError::Setup)?),
        };
        let mut registry = lock(&self.shared);
        Self::prune(&mut registry, self.max_runs);
        if registry.runs.len() >= self.max_runs {
            return Err(CreateError::Lab(CombatLabError::new("История прогонов боевого стенда заполнена", "COMBAT_LAB_HISTORY_FULL", 503)));
        }
        let id = format!("combat-lab-{}", hash::uuid_v4());
        let signal = AbortSignal::default();
        let run = RunRecord {
            id: id.clone(),
            status: "running",
            scenario: if initial_state.is_some() { "custom".into() } else { js::s(Some(scenario)) },
            seed: seed.clone(),
            initial_state,
            frames: Vec::new(),
            error: None,
            trace: None,
            signal: Some(signal.clone()),
            cancel_requested: false,
        };
        let request = ScenarioRun {
            scenario: run.scenario.clone(),
            seed: run.seed.clone(),
            initial_state: run.initial_state.clone(),
            max_steps: run.initial_state.as_ref().map(|_| 500),
            choose_command: run.initial_state.as_ref().and(self.choose_command.clone()),
        };
        let view = public_view(&run, -1.0);
        registry.runs.insert(id.clone(), run);
        registry.active = Some(id.clone());
        drop(registry);
        let shared = Arc::clone(&self.shared);
        let runner = Arc::clone(&self.runner);
        let max_frames = self.max_frames;
        thread::spawn(move || Self::execute(&shared, runner.as_ref(), &id, request, &signal, max_frames));
        Ok(view)
    }

    /// `get(id, after)`.
    pub fn get(&self, id: &str, after: f64) -> Option<Value> {
        let registry = lock(&self.shared);
        registry.runs.get(id).map(|run| public_view(run, after))
    }

    /// `report(id)`.
    pub fn report(&self, id: &str) -> Option<Value> {
        let registry = lock(&self.shared);
        let run = registry.runs.get(id)?;
        let mut map = Map::new();
        map.insert("schema".into(), Value::String("combat-lab-observer/v1".into()));
        if let Value::Object(view) = public_view(run, -1.0) {
            map.extend(view);
        }
        map.insert("trace".into(), run.trace.clone().unwrap_or(Value::Null));
        Some(Value::Object(map))
    }

    /// `cancel(id)`: просит прогон остановиться и ждёт его завершения.
    pub fn cancel(&self, id: &str) -> Option<Value> {
        let mut registry = lock(&self.shared);
        let run = registry.runs.get_mut(id)?;
        if run.status != "running" {
            return Some(public_view(run, -1.0));
        }
        run.cancel_requested = true;
        if let Some(signal) = &run.signal {
            signal.abort();
        }
        loop {
            match registry.runs.get(id) {
                Some(run) if run.status == "running" => {}
                Some(run) => return Some(public_view(run, -1.0)),
                None => return None,
            }
            registry = self.shared.finished.wait(registry).unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }

    /// Дождаться конца идущего прогона (для вызывающих и тестов; в JS — `await run.done`).
    pub fn wait(&self, id: &str) -> Option<Value> {
        let mut registry = lock(&self.shared);
        loop {
            match registry.runs.get(id) {
                Some(run) if run.status == "running" => {}
                Some(run) => return Some(public_view(run, -1.0)),
                None => return None,
            }
            registry = self.shared.finished.wait(registry).unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }

    /// `prune()`: вытесняет завершённые прогоны, пока история полна.
    fn prune(registry: &mut Registry, max_runs: usize) {
        while registry.runs.len() >= max_runs {
            let active = registry.active.clone();
            let candidate = registry.runs.values().find(|run| Some(&run.id) != active.as_ref() && run.status != "running").map(|run| run.id.clone());
            let Some(candidate) = candidate else {
                return;
            };
            registry.runs.shift_remove(&candidate);
        }
    }

    /// `execute(run)`.
    fn execute(shared: &Shared, runner: &dyn ScenarioRunner, id: &str, request: ScenarioRun, signal: &AbortSignal, max_frames: usize) {
        let mut on_frame = |frame: Value| -> Result<(), CombatLabError> {
            let mut registry = lock(shared);
            let Some(run) = registry.runs.get_mut(id) else {
                return Ok(());
            };
            if run.frames.len() >= max_frames {
                return Err(CombatLabError::new("Прогон остановлен: превышен лимит кадров", "COMBAT_LAB_FRAME_LIMIT", 503));
            }
            run.frames.push(frame);
            Ok(())
        };
        let outcome = runner.run(request, &mut on_frame, signal).and_then(|report| trace_of(&report).map(|trace| (report, trace)));
        let mut registry = lock(shared);
        if let Some(run) = registry.runs.get_mut(id) {
            let cancelled = run.cancel_requested || signal.aborted();
            match outcome {
                Ok((report, trace)) => {
                    run.trace = Some(trace);
                    if cancelled {
                        run.status = "cancelled";
                        run.error = None;
                    } else if report.get("passed") == Some(&Value::Bool(true)) {
                        run.status = "passed";
                    } else {
                        run.status = "failed";
                        run.error = Some(match report.get("error").filter(|error| js::truthy(Some(error))) {
                            Some(error) => error.clone(),
                            None => json!({ "message": "Боевой стенд завершился без результата" }),
                        });
                    }
                }
                Err(failure) => {
                    if cancelled {
                        run.status = "cancelled";
                        run.error = None;
                    } else {
                        run.status = "failed";
                        run.error = Some(failure.to_json());
                    }
                }
            }
            run.signal = None;
        }
        if registry.active.as_deref() == Some(id) {
            registry.active = None;
        }
        drop(registry);
        shared.finished.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    /// Прогон, который отдаёт кадры и ждёт сигнала, прежде чем закончить.
    struct Scripted {
        frames: usize,
        report: Value,
        gate: Mutex<Option<mpsc::Receiver<()>>>,
        seen: Mutex<Vec<(String, bool, Option<i64>, bool)>>,
    }

    impl Scripted {
        fn new(frames: usize, report: Value) -> Self {
            Self { frames, report, gate: Mutex::new(None), seen: Mutex::new(Vec::new()) }
        }
    }

    impl ScenarioRunner for Scripted {
        fn run(&self, request: ScenarioRun, on_frame: &mut dyn FnMut(Value) -> Result<(), CombatLabError>, signal: &AbortSignal) -> Result<Value, RunFailure> {
            self.seen.lock().expect("журнал").push((request.scenario.clone(), request.initial_state.is_some(), request.max_steps, request.choose_command.is_some()));
            for index in 0..self.frames {
                on_frame(json!({ "index": index, "kind": "frame" }))?;
            }
            let gate = self.gate.lock().expect("ворота").take();
            if let Some(gate) = gate {
                while gate.recv_timeout(std::time::Duration::from_millis(5)).is_err() {
                    if signal.aborted() {
                        return Err(RunFailure::new("Прогон отменён", Some("ABORTED".into())));
                    }
                }
            }
            Ok(self.report.clone())
        }
    }

    fn runs(runner: Arc<Scripted>, max_runs: Option<f64>, max_frames: Option<f64>) -> CombatLabRuns {
        let mut options = CombatLabRunsOptions::new(runner);
        options.max_runs = max_runs;
        options.max_frames = max_frames;
        options.choose_command = Some(Arc::new(|_: &Value, _: &str| json!({ "command_type": "EndTurn" })));
        CombatLabRuns::new(options)
    }

    fn passed() -> Value {
        json!({ "passed": true, "initial_state": { "v": 1 }, "final_state": { "v": 2 }, "rolls": [], "steps": [{ "step": 1, "command": { "command_type": "EndTurn" }, "tactic": null, "before_version": 1, "after_version": 2, "extra": 1 }] })
    }

    fn id_of(view: &Value) -> String {
        view["id"].as_str().expect("id").to_string()
    }

    #[test]
    fn scenarios_and_validation_follow_js() {
        let lab = runs(Arc::new(Scripted::new(0, passed())), None, None);
        let scenarios = lab.scenarios();
        assert_eq!(scenarios.len(), 8);
        assert_eq!(scenarios[0], json!({ "id": "duel", "name": "Дуэль" }));
        let unknown = lab.create(Some(&json!("boss")), Some(&json!(1)), None).expect_err("сценарий");
        assert_eq!(unknown.code(), Some("INVALID_COMBAT_LAB_SCENARIO"));
        for seed in [None, Some(json!(-1)), Some(json!(1.5)), Some(json!(4_294_967_296_i64)), Some(json!("1"))] {
            let error = lab.create(None, seed.as_ref(), None).expect_err("seed");
            assert_eq!(error.code(), Some("INVALID_COMBAT_LAB_SEED"));
            assert_eq!(error.status(), 400);
        }
        assert!(lab.active().is_none());
        assert!(lab.get("nope", -1.0).is_none());
        assert!(lab.report("nope").is_none());
        assert!(lab.cancel("nope").is_none());
    }

    #[test]
    fn run_passes_with_frames_trace_and_after_filter() {
        let runner = Arc::new(Scripted::new(3, passed()));
        let lab = runs(Arc::clone(&runner), None, None);
        let view = lab.create(None, Some(&json!(7)), None).expect("прогон");
        assert_eq!(view["status"], "running");
        assert_eq!(view["scenario"], "duel");
        assert_eq!(view["seed"], 7);
        let id = id_of(&view);
        assert!(id.starts_with("combat-lab-"));
        let done = lab.wait(&id).expect("итог");
        assert_eq!(done["status"], "passed");
        assert!(done.get("error").is_none());
        assert_eq!(lab.get(&id, 0.0).expect("кадры")["frames"].as_array().map(Vec::len), Some(2));
        let report = lab.report(&id).expect("отчёт");
        assert_eq!(report["schema"], "combat-lab-observer/v1");
        assert_eq!(report["trace"]["steps"], json!([{ "step": 1, "command": { "command_type": "EndTurn" }, "tactic": null, "before_version": 1, "after_version": 2 }]));
        assert_eq!(report["trace"]["final_state"], json!({ "v": 2 }));
        assert!(lab.active().is_none());
        assert_eq!(runner.seen.lock().expect("журнал")[0], ("duel".to_string(), false, None, false));
    }

    #[test]
    fn failed_report_and_frame_limit_become_errors() {
        let lab = runs(Arc::new(Scripted::new(0, json!({ "passed": false, "error": { "message": "Упал", "code": "BOOM" } }))), None, None);
        let id = id_of(&lab.create(Some(&json!("ranged")), Some(&json!(1)), None).expect("прогон"));
        let done = lab.wait(&id).expect("итог");
        assert_eq!((done["status"].as_str(), done["error"].as_str(), done["error_code"].as_str()), (Some("failed"), Some("Упал"), Some("BOOM")));

        let lab = runs(Arc::new(Scripted::new(0, json!({ "passed": "yes" }))), None, None);
        let id = id_of(&lab.create(None, Some(&json!(1)), None).expect("прогон"));
        assert_eq!(lab.wait(&id).expect("итог")["error"], "Боевой стенд завершился без результата");

        let lab = runs(Arc::new(Scripted::new(5, passed())), None, Some(1.0));
        let id = id_of(&lab.create(None, Some(&json!(1)), None).expect("прогон"));
        let done = lab.wait(&id).expect("итог");
        assert_eq!((done["status"].as_str(), done["error_code"].as_str()), (Some("failed"), Some("COMBAT_LAB_FRAME_LIMIT")));
        assert_eq!(done["frames"].as_array().map(Vec::len), Some(2), "лимит кадров — не меньше двух");
    }

    #[test]
    fn busy_cancel_and_history_limit() {
        let runner = Arc::new(Scripted::new(1, passed()));
        let (open, gate) = mpsc::channel();
        *runner.gate.lock().expect("ворота") = Some(gate);
        let lab = runs(Arc::clone(&runner), Some(2.0), None);
        let first = id_of(&lab.create(None, Some(&json!(1)), None).expect("первый"));
        assert_eq!(lab.active(), Some(json!({ "id": first })));
        let busy = lab.create(None, Some(&json!(2)), None).expect_err("занят");
        assert_eq!((busy.code(), busy.status()), (Some("COMBAT_LAB_BUSY"), 409));
        let cancelled = lab.cancel(&first).expect("отмена");
        assert_eq!(cancelled["status"], "cancelled");
        assert!(cancelled.get("error").is_none());
        assert_eq!(lab.cancel(&first).expect("повтор")["status"], "cancelled");
        drop(open);

        let second = id_of(&lab.create(None, Some(&json!(2)), None).expect("второй"));
        lab.wait(&second);
        let third = id_of(&lab.create(None, Some(&json!(3)), None).expect("третий вытесняет первый"));
        lab.wait(&third);
        assert!(lab.get(&first, -1.0).is_none(), "старейший завершённый вытеснен");
        assert!(lab.get(&second, -1.0).is_some());
    }

    #[test]
    fn custom_config_builds_state_and_passes_choose_command() {
        let runner = Arc::new(Scripted::new(0, passed()));
        let lab = runs(Arc::clone(&runner), None, None);
        let config = json!({ "mapId": "open-courtyard", "party": [{ "source": "class", "classId": "fighter", "level": 1, "x": 0, "y": 0 }], "enemies": [{ "monsterId": "dnd_5e_2014:monster:goblin", "x": 8, "y": 5 }] });
        let view = lab.create(Some(&json!("not-a-scenario")), Some(&json!(4)), Some(&config)).expect("свой бой");
        assert_eq!(view["scenario"], "custom");
        lab.wait(&id_of(&view));
        assert_eq!(runner.seen.lock().expect("журнал")[0], ("custom".to_string(), true, Some(500), true));
        let broken = lab.create(None, Some(&json!(4)), Some(&json!({ "mapId": "open-courtyard", "state": {} }))).expect_err("сборка");
        assert_eq!((broken.code(), broken.status()), (Some("UNEXPECTED_COMBAT_LAB_FIELD"), 400));
        assert!(lab.active().is_none());
        let catalog = lab.catalog().expect("каталог");
        assert_eq!(catalog["limits"], json!({ "party": 6, "enemies": 12 }));
        let assessed = lab.assess_encounter(Some(&json!({ "party": [{ "source": "class", "classId": "fighter" }], "enemies": [{ "monsterId": "dnd_5e_2014:monster:goblin" }] }))).expect("оценка");
        assert_eq!(assessed["assessment"]["rawXp"], 50);
    }
}

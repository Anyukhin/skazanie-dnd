//! Тестовые крючки сервера в виде ДАННЫХ — Rust-сторона контракта
//! `test/kit/hooks-format.mjs` (задача С2, `rust/SERVER-PLAN.md`).
//!
//! Переменные окружения те же, что у JS-предзагрузки `test/kit/server-hooks.mjs`:
//!
//! - `DND_TEST_DICE_RULES` — правила костей `skazanie.test-dice/1`: первое
//!   подходящее правило (`actor`, `purpose` — шаблоны, `sides`) даёт значение
//!   (`values` — очередь, затем `value`: число, прижатое к грани, `"max"`,
//!   `"min"`); кость без правила — настоящая или отказ (`unmatched: "error"`);
//! - `DND_COMMIT_FAULTS` — сбои `skazanie.test-faults/1`: `commit` по ключу
//!   идемпотентности (`throw` — отказ до записи, `exit-before` — выход 70 до
//!   записи, `exit-after` — журнал записан, выход 71 до ответа) и
//!   `projection_ack` (отказ подтверждения проекции кампании на версии);
//!   каждый сбой срабатывает один раз за жизнь процесса.
//!
//! Принимаются только бинарём с фичей `test-hooks`, при `NODE_ENV=test` и
//! хранилище `skazanie-*` прямо в системном временном каталоге. Иначе —
//! **отказ старта** (`hooks-format.mjs`, `docs/testing.md`: «иначе сервер не
//! стартует»), а не тихая подмена: тест с костями из данных против бинаря без
//! крючков упал бы на «случайном» исходе, а не на понятной причине. Без
//! переменных крючков сервер ведёт себя как обычно, с фичей или без.
//!
//! Сборка бинаря для контрактных тестов:
//! `cargo build --release -p sk-server --features test-hooks`. Тесты крейта
//! (`cargo test -p sk-server`) получают фичу сами — через dev-зависимость
//! крейта на себя (`Cargo.toml`). Боевой `cargo build` её не включает.
//!
//! Кости — внедряемый [`sk_dice::Dice`] ядра ([`Hooks::dice`] → `Injected::dice`).
//! Сбои — крючок вокруг журнала: **все** коммиты и подтверждения проекций
//! сервера идут через [`commit`] и [`acknowledge_projection`] этого модуля, а
//! не прямо через `EventStore` (сторож — `tests/test_hooks_guard.rs`). Сбои
//! живут в потоке ядра ([`install`]): у каждого `AppState` свои, как у
//! процесса JS, — тесты в одном процессе не мешают друг другу.
//!
//! Служебная подкоманда `skazanie-server journal …` (журнал глазами теста,
//! `test/kit/journal.mjs`) — [`journal_cli`], тоже только с фичей.

use std::path::Path;

use serde_json::Value;
use sk_dice::Dice;
use sk_store::{CommitRequest, CommitResult, EventStore, StoreResult};

use crate::core::{CoreError, CoreHandle};

pub mod journal_cli;

/// Переменная правил костей.
pub const DICE_ENV: &str = "DND_TEST_DICE_RULES";
/// Переменная сбоев.
pub const FAULTS_ENV: &str = "DND_COMMIT_FAULTS";
/// Формат правил костей.
pub const DICE_FORMAT: &str = "skazanie.test-dice/1";
/// Формат сбоев.
pub const FAULTS_FORMAT: &str = "skazanie.test-faults/1";
/// Код выхода `exit-before`.
pub const EXIT_BEFORE_CODE: i32 = 70;
/// Код выхода `exit-after`.
pub const EXIT_AFTER_CODE: i32 = 71;

/// Собран ли бинарь с крючками.
pub const ENABLED: bool = cfg!(feature = "test-hooks");

/// Крючки, прочитанные из окружения запуска.
#[derive(Default)]
pub struct Hooks {
    /// Кости по правилам; `None` — обычные.
    pub dice: Option<Box<dyn Dice + Send>>,
    /// Сбои вокруг журнала; ставятся в ядро [`install`].
    pub faults: Option<CommitFaults>,
}

/// Окружение, от которого зависят крючки (чтобы проверять без `set_var`).
pub struct HookEnv<'a> {
    pub dice: Option<&'a str>,
    pub faults: Option<&'a str>,
    pub node_env: Option<&'a str>,
    /// Каталог хранилища сервера, уже абсолютный (`Config::storage_dir`).
    pub storage_dir: &'a Path,
    /// Системный временной каталог (`os.tmpdir()`).
    pub temp_dir: &'a Path,
}

/// Крючки из окружения процесса. `Err` — сервер не должен стартовать.
pub fn from_env(storage_dir: &Path) -> Result<Hooks, String> {
    let read = |name: &str| std::env::var_os(name).map(|value| value.to_string_lossy().into_owned());
    let (dice, faults, node_env) = (read(DICE_ENV), read(FAULTS_ENV), read("NODE_ENV"));
    let temp_dir = std::env::temp_dir();
    from_vars(&HookEnv { dice: dice.as_deref(), faults: faults.as_deref(), node_env: node_env.as_deref(), storage_dir, temp_dir: &temp_dir })
}

/// Разбор крючков: пустая переменная — как отсутствующая (`if (source)` JS).
pub fn from_vars(env: &HookEnv<'_>) -> Result<Hooks, String> {
    let dice = env.dice.filter(|text| !text.is_empty());
    let faults = env.faults.filter(|text| !text.is_empty());
    if dice.is_none() && faults.is_none() {
        return Ok(Hooks::default());
    }
    if !ENABLED {
        return Err(format!("Тестовые крючки ({DICE_ENV}, {FAULTS_ENV}) заданы, но бинарь собран без фичи test-hooks: cargo build --release -p sk-server --features test-hooks"));
    }
    assert_hook_storage(env.node_env, env.storage_dir, env.temp_dir)?;
    imp::parse(dice, faults)
}

/// `assertHookStorage` (`hooks-format.mjs`): `NODE_ENV=test` и хранилище —
/// прямой подкаталог временного каталога с именем `skazanie-*`.
pub fn assert_hook_storage(node_env: Option<&str>, storage_dir: &Path, temp_dir: &Path) -> Result<(), String> {
    let name_ok = storage_dir.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.len() > "skazanie-".len() && name.starts_with("skazanie-") && !name.contains(['/', '\\']));
    let isolated = name_ok && storage_dir.parent().is_some_and(|parent| same_dir(parent, temp_dir));
    if node_env != Some("test") || !isolated {
        return Err(format!("Тестовые крючки ({DICE_ENV}, {FAULTS_ENV}) разрешены только при NODE_ENV=test и хранилище skazanie-* прямо во временном каталоге"));
    }
    Ok(())
}

/// Каталог хранилища лежит прямо во временном каталоге (имя любое) — для
/// разрушающих подкоманд журнала.
pub fn directly_in(dir: &Path, parent: &Path) -> bool {
    dir.parent().is_some_and(|candidate| same_dir(candidate, parent))
}

/// Один и тот же каталог: сначала настоящие пути (короткие имена 8.3,
/// ссылки), иначе — по написанию; на Windows без учёта регистра.
fn same_dir(left: &Path, right: &Path) -> bool {
    if let (Ok(a), Ok(b)) = (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        return lexical_key(&a) == lexical_key(&b);
    }
    let absolute = |path: &Path| std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    lexical_key(&absolute(left)) == lexical_key(&absolute(right))
}

fn lexical_key(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let text = text.trim_end_matches('/').to_string();
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}

/// Поставить сбои в поток ядра (до первого коммита, то есть до сверки при
/// старте). `None` — снять.
pub async fn install(core: &CoreHandle, faults: Option<CommitFaults>) -> Result<(), CoreError> {
    core.call(move |_core| {
        Box::pin(async move {
            imp::set_faults(faults);
        })
    })
    .await
}

/// `eventStore.commit(request)` с крючком сбоя. Зовётся на потоке ядра.
pub fn commit(events: &EventStore, request: CommitRequest) -> StoreResult<CommitResult> {
    imp::commit(events, request)
}

/// `eventStore.acknowledgeProjection(...)` с крючком сбоя. Зовётся на потоке ядра.
pub fn acknowledge_projection(events: &EventStore, campaign_id: &str, projected_version: i64, projection_hash: Option<&str>) -> StoreResult<Value> {
    imp::acknowledge_projection(events, campaign_id, projected_version, projection_hash)
}

pub use imp::CommitFaults;
#[cfg(feature = "test-hooks")]
pub use imp::{CommitFaultMode, DicePicker, RulesDice};

// --- без фичи: прямые вызовы журнала -----------------------------------------

#[cfg(not(feature = "test-hooks"))]
mod imp {
    use super::*;

    /// Без фичи сбоев не бывает: тип пустой, значение не создать.
    pub enum CommitFaults {}

    pub fn parse(_dice: Option<&str>, _faults: Option<&str>) -> Result<Hooks, String> {
        Err("бинарь собран без фичи test-hooks".to_string())
    }

    pub fn set_faults(_faults: Option<CommitFaults>) {}

    #[inline]
    pub fn commit(events: &EventStore, request: CommitRequest) -> StoreResult<CommitResult> {
        events.commit(request)
    }

    #[inline]
    pub fn acknowledge_projection(events: &EventStore, campaign_id: &str, projected_version: i64, projection_hash: Option<&str>) -> StoreResult<Value> {
        events.acknowledge_projection(campaign_id, projected_version, projection_hash)
    }
}

// --- с фичей -----------------------------------------------------------------

#[cfg(feature = "test-hooks")]
mod imp {
    use std::cell::RefCell;
    use std::collections::{HashMap, VecDeque};
    use std::sync::{Arc, Mutex};

    use regex::Regex;
    use serde_json::{Map, Value};
    use sk_dice::{D20Request, DiceError, DiceService, Rng, Roll, SystemRng, Visibility};
    use sk_store::StoreError;

    use super::*;

    /// `UNSAFE_PATTERN` JS: lookaround и обратные ссылки (их нет в Rust `regex`).
    fn unsafe_pattern(pattern: &str) -> bool {
        pattern.contains("(?=") || pattern.contains("(?!") || pattern.contains("(?<") || pattern.contains("\\k<") || (1..=9).any(|digit| pattern.contains(&format!("\\{digit}")))
    }

    /// `Number.isSafeInteger(value)`.
    fn safe_integer(value: &Value) -> Option<i64> {
        const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
        if let Some(int) = value.as_i64() {
            return (int.unsigned_abs() as f64 <= MAX_SAFE).then_some(int);
        }
        let number = value.as_f64()?;
        (number.fract() == 0.0 && number.abs() <= MAX_SAFE).then_some(number as i64)
    }

    fn compile(pattern: Option<&Value>, where_: &str) -> Result<Option<Regex>, String> {
        let Some(pattern) = pattern else { return Ok(None) };
        let Some(text) = pattern.as_str().filter(|text| !text.is_empty()) else {
            return Err(format!("{where_}: шаблон должен быть непустой строкой"));
        };
        if unsafe_pattern(text) {
            return Err(format!("{where_}: lookaround и обратные ссылки не поддерживает Rust regex"));
        }
        Regex::new(text).map(Some).map_err(|error| format!("{where_}: {error}"))
    }

    fn object<'a>(value: &'a Value, message: &str) -> Result<&'a Map<String, Value>, String> {
        value.as_object().ok_or_else(|| message.to_string())
    }

    // --- кости ---

    #[derive(Debug, Clone, Copy)]
    enum Fixed {
        Max,
        Min,
        Value(i64),
    }

    struct Rule {
        actor: Option<Regex>,
        purpose: Option<Regex>,
        sides: Option<i64>,
        value: Option<Fixed>,
        queue: VecDeque<i64>,
    }

    /// `createDicePicker(parseDiceSpec(...))`: выбор значения одной кости.
    pub struct DicePicker {
        rules: Vec<Rule>,
        unmatched_error: bool,
    }

    impl DicePicker {
        /// `parseDiceSpec(input)` + `createDicePicker`: та же проверка, те же сообщения.
        pub fn parse(source: &str) -> Result<Self, String> {
            let spec: Value = serde_json::from_str(source).map_err(|error| format!("Правила костей — не JSON: {error}"))?;
            let map = object(&spec, "Правила костей — JSON-объект")?;
            if map.get("format").and_then(Value::as_str) != Some(DICE_FORMAT) {
                return Err(format!("Правила костей: format должен быть {DICE_FORMAT}"));
            }
            if let Some(key) = map.keys().find(|key| !["format", "description", "unmatched", "rules"].contains(&key.as_str())) {
                return Err(format!("Правила костей: неизвестное поле {key}"));
            }
            let unmatched_error = match map.get("unmatched") {
                None => false,
                Some(Value::String(text)) if text == "random" => false,
                Some(Value::String(text)) if text == "error" => true,
                Some(_) => return Err("Правила костей: unmatched — random или error".to_string()),
            };
            let rules = map.get("rules").and_then(Value::as_array).filter(|rules| !rules.is_empty()).ok_or("Правила костей: rules — непустой массив")?;
            let mut parsed = Vec::with_capacity(rules.len());
            for (index, rule) in rules.iter().enumerate() {
                let where_ = format!("Правила костей, rules[{index}]");
                let rule = object(rule, &format!("{where_}: правило — объект"))?;
                if let Some(key) = rule.keys().find(|key| !["actor", "purpose", "sides", "value", "values", "note"].contains(&key.as_str())) {
                    return Err(format!("{where_}: неизвестное поле {key}"));
                }
                let actor = compile(rule.get("actor"), &format!("{where_}.actor"))?;
                let purpose = compile(rule.get("purpose"), &format!("{where_}.purpose"))?;
                let sides = match rule.get("sides") {
                    None => None,
                    Some(value) => Some(safe_integer(value).filter(|sides| *sides >= 2).ok_or(format!("{where_}.sides: целое не меньше 2"))?),
                };
                if rule.get("value").is_none() && rule.get("values").is_none() {
                    return Err(format!("{where_}: нужно value или values"));
                }
                let value = match rule.get("value") {
                    None => None,
                    Some(Value::String(text)) if text == "max" => Some(Fixed::Max),
                    Some(Value::String(text)) if text == "min" => Some(Fixed::Min),
                    Some(value) => Some(Fixed::Value(safe_integer(value).ok_or(format!("{where_}.value: целое, \"max\" или \"min\""))?)),
                };
                let queue = match rule.get("values") {
                    None => VecDeque::new(),
                    Some(Value::Array(values)) => values.iter().map(safe_integer).collect::<Option<VecDeque<i64>>>().ok_or(format!("{where_}.values: массив целых"))?,
                    Some(_) => return Err(format!("{where_}.values: массив целых")),
                };
                parsed.push(Rule { actor, purpose, sides, value, queue });
            }
            Ok(Self { rules: parsed, unmatched_error })
        }

        /// Значение кости или `None` (бросает настоящий генератор).
        pub fn pick(&mut self, actor: &str, purpose: &str, minimum: i64, maximum: i64) -> Result<Option<i64>, DiceError> {
            let shown = |text: &str| if text.is_empty() { "—".to_string() } else { text.to_string() };
            let found = self.rules.iter_mut().find(|rule| {
                rule.actor.as_ref().is_none_or(|pattern| pattern.is_match(actor))
                    && rule.purpose.as_ref().is_none_or(|pattern| pattern.is_match(purpose))
                    && rule.sides.is_none_or(|sides| minimum == 1 && maximum == sides)
            });
            let Some(rule) = found else {
                if self.unmatched_error {
                    return Err(DiceError::Range(format!("Тестовые кости: нет правила для d{maximum} (actor={}, purpose={})", shown(actor), shown(purpose))));
                }
                return Ok(None);
            };
            if let Some(next) = rule.queue.pop_front() {
                if next < minimum || next > maximum {
                    return Err(DiceError::Range(format!("Тестовое значение {next} не входит в диапазон {minimum}..{maximum}")));
                }
                return Ok(Some(next));
            }
            match rule.value {
                None => Err(DiceError::Range(format!("Тестовые кости: очередь values исчерпана (actor={}, purpose={})", shown(actor), shown(purpose)))),
                Some(Fixed::Max) => Ok(Some(maximum)),
                Some(Fixed::Min) => Ok(Some(minimum)),
                Some(Fixed::Value(value)) => Ok(Some(value.clamp(minimum, maximum.max(minimum)))),
            }
        }
    }

    /// Контекст текущего броска: актор и назначение известны только `Dice`,
    /// грани — только генератору (как подмена `rng` в `server-hooks.mjs`).
    type Context = Arc<Mutex<(String, String)>>;

    struct RulesRng {
        picker: DicePicker,
        context: Context,
        real: SystemRng,
    }

    impl Rng for RulesRng {
        fn randint(&mut self, minimum: i64, maximum: i64) -> Result<i64, DiceError> {
            let (actor, purpose) = self.context.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
            match self.picker.pick(&actor, &purpose, minimum, maximum)? {
                Some(value) => Ok(value),
                None => self.real.randint(minimum, maximum),
            }
        }
    }

    /// `DiceService` с правилами из данных; кость без правила — системная.
    pub struct RulesDice {
        service: DiceService<RulesRng>,
        context: Context,
    }

    impl RulesDice {
        pub fn new(picker: DicePicker) -> Self {
            let context: Context = Arc::new(Mutex::new((String::new(), String::new())));
            let rng = RulesRng { picker, context: context.clone(), real: SystemRng };
            let service = DiceService::new(rng, Box::new(|| uuid::Uuid::new_v4().to_string()), Box::new(sk_core::clock::now_iso));
            Self { service, context }
        }

        /// Правила как у сервера, но с детерминированными id и временем —
        /// для тестов в процессе (`tests/kit/dice.rs`).
        pub fn deterministic(picker: DicePicker, prefix: &str) -> Self {
            let context: Context = Arc::new(Mutex::new((String::new(), String::new())));
            let rng = RulesRng { picker, context: context.clone(), real: SystemRng };
            Self { service: DiceService::deterministic(rng, prefix), context }
        }

        /// Значения по умолчанию те же, что у сигнатур `DiceService` JS:
        /// правило видит то назначение, которое сервер запишет в бросок.
        fn set(&self, actor: Option<&str>, purpose: &str, default_purpose: &str) {
            let purpose = if purpose.is_empty() { default_purpose } else { purpose };
            *self.context.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = (actor.unwrap_or("").to_string(), purpose.to_string());
        }
    }

    impl Dice for RulesDice {
        fn roll(&mut self, expression: &str, purpose: &str, actor_id: Option<&str>, visibility: Visibility) -> Result<Roll, DiceError> {
            self.set(actor_id, purpose, "unspecified");
            self.service.roll(expression, purpose, actor_id, visibility)
        }

        fn roll_d20(&mut self, request: &D20Request) -> Result<Roll, DiceError> {
            self.set(request.actor_id.as_deref(), &request.purpose, "check");
            self.service.roll_d20(request)
        }

        fn roll_check(&mut self, request: &D20Request, difficulty: i64) -> Result<Roll, DiceError> {
            self.set(request.actor_id.as_deref(), &request.purpose, "check");
            self.service.roll_check(request, difficulty)
        }
    }

    // --- сбои ---

    /// Режим сбоя коммита.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum CommitFaultMode {
        Throw,
        ExitBefore,
        ExitAfter,
    }

    #[derive(Debug, Clone)]
    struct AckFault {
        campaign: String,
        version: i64,
        fired: bool,
    }

    /// `parseFaultsSpec(...)`: сбои по ключу коммита и по версии подтверждения.
    #[derive(Debug, Clone, Default)]
    pub struct CommitFaults {
        commit: HashMap<String, CommitFaultMode>,
        ack: Vec<AckFault>,
    }

    impl CommitFaults {
        pub fn parse(source: &str) -> Result<Self, String> {
            let spec: Value = serde_json::from_str(source).map_err(|error| format!("Сбои — не JSON: {error}"))?;
            let map = object(&spec, "Сбои — JSON-объект")?;
            if map.get("format").and_then(Value::as_str) != Some(FAULTS_FORMAT) {
                return Err(format!("Сбои: format должен быть {FAULTS_FORMAT}"));
            }
            if let Some(key) = map.keys().find(|key| !["format", "description", "commit", "projection_ack"].contains(&key.as_str())) {
                return Err(format!("Сбои: неизвестное поле {key}"));
            }
            let mut faults = Self::default();
            let empty = Vec::new();
            let commit = match map.get("commit") {
                None | Some(Value::Null) => &empty,
                Some(Value::Array(list)) => list,
                Some(_) => return Err("Сбои: commit — массив".to_string()),
            };
            for (index, entry) in commit.iter().enumerate() {
                let key = entry.get("idempotency_key").and_then(Value::as_str).filter(|key| !key.is_empty()).ok_or(format!("Сбои, commit[{index}]: нужен idempotency_key"))?;
                let mode = match entry.get("mode").and_then(Value::as_str) {
                    Some("throw") => CommitFaultMode::Throw,
                    Some("exit-before") => CommitFaultMode::ExitBefore,
                    Some("exit-after") => CommitFaultMode::ExitAfter,
                    _ => return Err(format!("Сбои, commit[{index}].mode: throw | exit-before | exit-after")),
                };
                // `new Map(entries)`: повтор ключа — последний режим.
                faults.commit.insert(key.to_string(), mode);
            }
            let ack = match map.get("projection_ack") {
                None | Some(Value::Null) => &empty,
                Some(Value::Array(list)) => list,
                Some(_) => return Err("Сбои: projection_ack — массив".to_string()),
            };
            for (index, entry) in ack.iter().enumerate() {
                let campaign = entry.get("campaign").and_then(Value::as_str).filter(|campaign| !campaign.is_empty()).ok_or(format!("Сбои, projection_ack[{index}]: нужен campaign"))?;
                let version = entry.get("version").and_then(safe_integer).filter(|version| *version >= 0).ok_or(format!("Сбои, projection_ack[{index}].version: целое ≥ 0"))?;
                faults.ack.push(AckFault { campaign: campaign.to_string(), version, fired: false });
            }
            Ok(faults)
        }

        /// Сбой для ключа коммита — снимается при срабатывании.
        pub fn take_commit(&mut self, idempotency_key: &str) -> Option<CommitFaultMode> {
            self.commit.remove(idempotency_key)
        }

        /// Отказать ли подтверждению: один раз на запись.
        pub fn take_ack(&mut self, campaign_id: &str, version: i64) -> bool {
            let campaign = campaign_id.to_uppercase();
            match self.ack.iter_mut().find(|fault| !fault.fired && fault.campaign.to_uppercase() == campaign && fault.version == version) {
                Some(fault) => {
                    fault.fired = true;
                    true
                }
                None => false,
            }
        }
    }

    pub fn parse(dice: Option<&str>, faults: Option<&str>) -> Result<Hooks, String> {
        let dice = match dice {
            Some(source) => Some(Box::new(RulesDice::new(DicePicker::parse(source)?)) as Box<dyn Dice + Send>),
            None => None,
        };
        let faults = faults.map(CommitFaults::parse).transpose()?;
        Ok(Hooks { dice, faults })
    }

    thread_local! {
        /// Сбои этого ядра: поток ядра у каждого `AppState` свой.
        static FAULTS: RefCell<Option<CommitFaults>> = const { RefCell::new(None) };
    }

    pub fn set_faults(faults: Option<CommitFaults>) {
        FAULTS.with(|slot| *slot.borrow_mut() = faults);
    }

    fn take_commit_fault(key: &str) -> Option<CommitFaultMode> {
        FAULTS.with(|slot| slot.borrow_mut().as_mut().and_then(|faults| faults.take_commit(key)))
    }

    fn take_ack_fault(campaign_id: &str, version: i64) -> bool {
        FAULTS.with(|slot| slot.borrow_mut().as_mut().is_some_and(|faults| faults.take_ack(campaign_id, version)))
    }

    pub fn commit(events: &EventStore, request: CommitRequest) -> StoreResult<CommitResult> {
        match take_commit_fault(&request.idempotency_key) {
            None => events.commit(request),
            Some(CommitFaultMode::Throw) => Err(StoreError::new("EVENT_STORE_ERROR", "synthetic commit failure before journal write")),
            Some(CommitFaultMode::ExitBefore) => std::process::exit(EXIT_BEFORE_CODE),
            Some(CommitFaultMode::ExitAfter) => {
                // Как `await originalCommit(...)`: отказ записи — обычная
                // ошибка без выхода.
                events.commit(request)?;
                std::process::exit(EXIT_AFTER_CODE)
            }
        }
    }

    pub fn acknowledge_projection(events: &EventStore, campaign_id: &str, projected_version: i64, projection_hash: Option<&str>) -> StoreResult<Value> {
        if take_ack_fault(campaign_id, projected_version) {
            return Err(StoreError::new("EVENT_STORE_ERROR", "synthetic projection acknowledgement failure"));
        }
        events.acknowledge_projection(campaign_id, projected_version, projection_hash)
    }
}

#[cfg(all(test, feature = "test-hooks"))]
mod tests {
    use super::*;
    use serde_json::json;
    use sk_dice::D20Request;

    fn picker(spec: Value) -> DicePicker {
        DicePicker::parse(&spec.to_string()).expect("правила")
    }

    /// Те же случаи, что `test/test-kit.test.mjs` («крючки как данные»).
    #[test]
    fn dice_picker_matches_js_contract() {
        let mut pick = picker(json!({
            "format": DICE_FORMAT,
            "rules": [
                { "actor": "^hero-1$", "purpose": "^attack$", "sides": 20, "values": [4, 19], "value": "max" },
                { "actor": "^hero-", "value": "min" },
                { "actor": "^$", "sides": 6, "value": 9 },
            ],
        }));
        let d20 = |pick: &mut DicePicker| pick.pick("hero-1", "attack", 1, 20).unwrap();
        assert_eq!([d20(&mut pick), d20(&mut pick), d20(&mut pick)], [Some(4), Some(19), Some(20)], "очередь values, затем value");
        assert_eq!(pick.pick("hero-1", "damage", 1, 8).unwrap(), Some(1), "первое подходящее правило");
        assert_eq!(pick.pick("", "x", 1, 6).unwrap(), Some(6), "value прижимается к грани; пустой актор — ^$");
        assert_eq!(pick.pick("goblin", "attack", 1, 20).unwrap(), None, "без правила — настоящая кость");

        let mut strict = picker(json!({ "format": DICE_FORMAT, "unmatched": "error", "rules": [{ "actor": "^a$", "values": [7] }] }));
        assert!(strict.pick("b", "", 1, 20).unwrap_err().to_string().contains("нет правила"));
        assert_eq!(strict.pick("a", "", 1, 20).unwrap(), Some(7));
        assert!(strict.pick("a", "", 1, 20).unwrap_err().to_string().contains("исчерпана"));
        let mut range = picker(json!({ "format": DICE_FORMAT, "rules": [{ "values": [9] }] }));
        assert!(range.pick("", "", 1, 6).unwrap_err().to_string().contains("диапазон"));
    }

    #[test]
    fn dice_spec_validation_matches_js_messages() {
        let fails = |spec: Value, needle: &str| {
            let error = DicePicker::parse(&spec.to_string()).err().expect("отказ");
            assert!(error.contains(needle), "{error} ∌ {needle}");
        };
        fails(json!({ "format": DICE_FORMAT, "rules": [{ "actor": "^(?!x)", "value": 1 }] }), "Rust regex");
        fails(json!({ "format": DICE_FORMAT, "rules": [{ "value": 1, "sidez": 6 }] }), "неизвестное поле sidez");
        fails(json!({ "format": "skazanie.test-dice/2", "rules": [{ "value": 1 }] }), "format");
        fails(json!({ "format": DICE_FORMAT, "rules": [] }), "непустой");
        fails(json!({ "format": DICE_FORMAT, "rules": [{ "sides": 1, "value": 1 }] }), "sides");
        fails(json!({ "format": DICE_FORMAT, "rules": [{ "value": 1.5 }] }), "value");
        fails(json!({ "format": DICE_FORMAT, "rules": [{ "note": "x" }] }), "value или values");
        assert!(DicePicker::parse(&json!({ "format": DICE_FORMAT, "rules": [{ "value": 5.0 }] }).to_string()).is_ok(), "5.0 — безопасное целое, как в JS");
    }

    #[test]
    fn rules_dice_sees_actor_and_purpose_of_each_roll() {
        let mut dice = RulesDice::deterministic(
            picker(json!({ "format": DICE_FORMAT, "rules": [
                { "actor": "^hero-1$", "purpose": "^free_roll$", "values": [2, 5], "value": "max" },
                { "purpose": "^check$", "value": 13 },
                { "purpose": "^unspecified$", "value": 1 },
            ] })),
            "roll",
        );
        let free = |dice: &mut RulesDice| dice.roll("1d6", "free_roll", Some("hero-1"), sk_dice::Visibility::Public).unwrap().total;
        assert_eq!([free(&mut dice), free(&mut dice), free(&mut dice)], [2, 5, 6]);
        assert_eq!(dice.roll_d20(&D20Request::new("", 0)).unwrap().kept, Some(13), "пустое назначение d20 — check");
        assert_eq!(dice.roll_check(&D20Request::new("check", 2), 15).unwrap().success, Some(true));
        assert_eq!(dice.roll("2d4", "", None, sk_dice::Visibility::Public).unwrap().total, 2, "пустое назначение roll — unspecified");
    }

    #[test]
    fn faults_parse_and_fire_once() {
        let mut faults = CommitFaults::parse(
            &json!({ "format": FAULTS_FORMAT, "commit": [{ "idempotency_key": "k", "mode": "exit-after" }], "projection_ack": [{ "campaign": "abc", "version": 3 }] }).to_string(),
        )
        .unwrap();
        assert_eq!(faults.take_commit("k"), Some(CommitFaultMode::ExitAfter));
        assert_eq!(faults.take_commit("k"), None, "один раз за процесс");
        assert!(!faults.take_ack("ABC", 2));
        assert!(faults.take_ack("ABC", 3), "кампания без учёта регистра");
        assert!(!faults.take_ack("abc", 3));
        let fails = |spec: Value, needle: &str| {
            let error = CommitFaults::parse(&spec.to_string()).err().expect("отказ");
            assert!(error.contains(needle), "{error} ∌ {needle}");
        };
        fails(json!({ "format": FAULTS_FORMAT, "commit": [{ "idempotency_key": "k", "mode": "explode" }] }), "mode");
        fails(json!({ "format": FAULTS_FORMAT, "projection_ack": [{ "campaign": "A", "version": -1 }] }), "version");
        fails(json!({ "format": FAULTS_FORMAT, "extra": 1 }), "неизвестное поле extra");
    }

    #[test]
    fn hooks_only_with_node_env_test_and_skazanie_storage_in_temp() {
        let temp = tempfile::tempdir().expect("временный каталог");
        let good = temp.path().join("skazanie-kit-abc");
        std::fs::create_dir_all(&good).unwrap();
        let dice = json!({ "format": DICE_FORMAT, "rules": [{ "value": "max" }] }).to_string();
        let env = |node_env: Option<&'static str>, storage: &Path| -> Result<Hooks, String> {
            from_vars(&HookEnv { dice: Some(&dice), faults: None, node_env, storage_dir: storage, temp_dir: temp.path() })
        };
        assert!(env(Some("test"), &good).unwrap().dice.is_some());
        assert!(env(Some("production"), &good).is_err(), "не NODE_ENV=test — отказ старта");
        assert!(env(None, &good).is_err());
        assert!(env(Some("test"), &temp.path().join("other-dir")).is_err(), "имя не skazanie-*");
        assert!(env(Some("test"), &good.join("skazanie-nested")).is_err(), "не прямо во временном каталоге");
        assert!(env(Some("test"), &temp.path().join("skazanie-")).is_err(), "пустой хвост имени");
        let none = from_vars(&HookEnv { dice: Some(""), faults: None, node_env: None, storage_dir: Path::new("/var/storage"), temp_dir: temp.path() }).unwrap();
        assert!(none.dice.is_none() && none.faults.is_none(), "пустые переменные — как отсутствие");
    }
}

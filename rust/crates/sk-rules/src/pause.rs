//! Остановки разбора команды — перенос классов пауз `rules-engine.mjs`
//! (12375–12575) и обычных отказов. Задача Р0.
//!
//! В JS разбор останавливают исключения трёх родов: `RulesValidationError`
//! (отказ правила игроку), четыре класса пауз боя (окно реакции посреди
//! действия: `ResistanceChoicePause`, `ResistanceAfterRollPause`,
//! `ElementalDamageReactionPause`, `ProtectiveReactionPause`) и прочие `Error`
//! (`TypeError`, `DiceExpressionError`, `RangeError` кубиков). В Rust отказ и
//! сбой — [`Halt`], а пауза в него не входит (урок 5 плана переноса):
//!
//! - внутри разбора (`resolve/`) остановка — [`Interrupt`]: отказ, сбой или
//!   пауза. Пауза летит `?` от места броска до места ловли, как в JS;
//! - на границе API (`resolve::api`) пауза становится
//!   [`crate::outcome::Outcome::Pending`], а наружу уходит только [`Halt`].
//!   Код вида «любая ошибка — откат» у вызывающих паузу поймать не может.
//!
//! Здесь — данные и сериализация пауз: событие `ReactionWindowOpened`
//! собирается так же, как в конструкторах классов JS, побайтно. Ловля паузы
//! (`isCombatPause`) в шести местах с разной семантикой — задачи Р5 и Р10.

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_core::RuleError;

use crate::command::rules::rule_ids;
use crate::core::{command_with_rules, event_from, spread_value};

/// Прочая ошибка JS: не отказ правила и не пауза.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fault {
    /// Имя класса JS (`TypeError`, `DiceExpressionError`, `RangeError`, `Error`).
    pub name: String,
    pub message: String,
    /// `error.code`, если JS его ставит (`INVALID_REDUCER_VERSION`…).
    pub code: Option<String>,
}

impl Fault {
    pub fn new(name: impl Into<String>, message: impl Into<String>) -> Self {
        Self { name: name.into(), message: message.into(), code: None }
    }

    /// `TypeError` — обращение к полю не того типа, вызов не функции.
    pub fn type_error(message: impl Into<String>) -> Self {
        Self::new("TypeError", message)
    }

    pub fn with_code(mut self, code: impl Into<String>) -> Self {
        self.code = Some(code.into());
        self
    }
}

/// Почему команда не дала итога: отказ правила или сбой. Паузы здесь нет —
/// ожидание решения игрока приходит итогом ([`crate::outcome::Outcome`]).
#[derive(Debug, Clone)]
pub enum Halt {
    /// Отказ правила (`RulesValidationError` и ошибки валидации модулей).
    Rule(RuleError),
    /// Прочая ошибка JS.
    Fault(Fault),
}

impl Halt {
    /// Код отказа или ошибки, если он есть.
    pub fn code(&self) -> Option<&str> {
        match self {
            Halt::Rule(error) => Some(error.code.as_str()),
            Halt::Fault(fault) => fault.code.as_deref(),
        }
    }

    /// `error instanceof RulesValidationError`.
    pub fn is_rule(&self) -> bool {
        matches!(self, Halt::Rule(_))
    }

    /// Ветка или блок ещё не перенесены (заглушка каркаса).
    pub fn is_unported(&self) -> bool {
        matches!(self, Halt::Rule(error) if error.code == UNPORTED)
    }
}

impl From<RuleError> for Halt {
    fn from(error: RuleError) -> Self {
        Halt::Rule(error)
    }
}

impl From<Fault> for Halt {
    fn from(fault: Fault) -> Self {
        Halt::Fault(fault)
    }
}

impl std::fmt::Display for Halt {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Halt::Rule(error) => write!(f, "{error}"),
            Halt::Fault(fault) => write!(f, "{}: {}", fault.name, fault.message),
        }
    }
}

/// Остановка внутри разбора команды: отказ, сбой или пауза боя. Живёт только
/// в `resolve/` и тех помощниках, что зовут его броски; на границе API пауза
/// становится [`crate::outcome::Outcome::Pending`], а отказ и сбой — [`Halt`].
#[derive(Debug, Clone)]
pub enum Interrupt {
    /// Отказ правила.
    Rule(RuleError),
    /// Пауза боя: окно реакции посреди действия.
    Pause(Box<Pause>),
    /// Прочая ошибка JS.
    Fault(Fault),
}

impl Interrupt {
    /// Код отказа или ошибки, если он есть.
    pub fn code(&self) -> Option<&str> {
        match self {
            Interrupt::Rule(error) => Some(error.code.as_str()),
            Interrupt::Pause(_) => None,
            Interrupt::Fault(fault) => fault.code.as_deref(),
        }
    }

    /// `error instanceof RulesValidationError`.
    pub fn is_rule(&self) -> bool {
        matches!(self, Interrupt::Rule(_))
    }

    /// `isCombatPause(error)`.
    pub fn is_combat_pause(&self) -> bool {
        matches!(self, Interrupt::Pause(_))
    }

    /// Ветка или блок ещё не перенесены (заглушка каркаса).
    pub fn is_unported(&self) -> bool {
        matches!(self, Interrupt::Rule(error) if error.code == UNPORTED)
    }

    pub fn pause(pause: Pause) -> Self {
        Interrupt::Pause(Box::new(pause))
    }

    /// Отказ или сбой — как [`Halt`]; пауза — отдельно.
    pub fn into_halt(self) -> Result<Halt, Box<Pause>> {
        match self {
            Interrupt::Rule(error) => Ok(Halt::Rule(error)),
            Interrupt::Fault(fault) => Ok(Halt::Fault(fault)),
            Interrupt::Pause(pause) => Err(pause),
        }
    }
}

impl From<Halt> for Interrupt {
    fn from(halt: Halt) -> Self {
        match halt {
            Halt::Rule(error) => Interrupt::Rule(error),
            Halt::Fault(fault) => Interrupt::Fault(fault),
        }
    }
}

impl From<RuleError> for Interrupt {
    fn from(error: RuleError) -> Self {
        Interrupt::Rule(error)
    }
}

impl From<Fault> for Interrupt {
    fn from(fault: Fault) -> Self {
        Interrupt::Fault(fault)
    }
}

impl From<Pause> for Interrupt {
    fn from(pause: Pause) -> Self {
        Interrupt::pause(pause)
    }
}

impl std::fmt::Display for Interrupt {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Interrupt::Rule(error) => write!(f, "{error}"),
            Interrupt::Pause(pause) => write!(f, "пауза: {}", pause.message()),
            Interrupt::Fault(fault) => write!(f, "{}: {}", fault.name, fault.message),
        }
    }
}

/// Шаг проверки или помощника: ничего или отказ.
pub type Step = Result<(), Halt>;

/// Шаг разбора: ничего, отказ или пауза.
pub type Flow = Result<(), Interrupt>;

/// Код заглушки каркаса.
pub const UNPORTED: &str = "UNPORTED";

/// Отказ заглушки: блок или ветка ещё не перенесены (`name` — имя блока).
pub fn unported(name: &str) -> RuleError {
    RuleError::new(UNPORTED, name)
}

/// `new RulesValidationError(message, code)`: [`Halt`] в проверке, [`Interrupt`]
/// в разборе — по типу места.
pub fn rule<E: From<RuleError>>(message: impl Into<String>, code: &str) -> E {
    E::from(RuleError::new(code, message))
}

/// Класс паузы JS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PauseKind {
    /// `ResistanceChoicePause`: выбор Сопротивления до броска.
    ResistanceChoice,
    /// `ResistanceAfterRollPause` (наследник `ResistanceChoicePause`): после броска.
    ResistanceAfterRoll,
    /// `ElementalDamageReactionPause`: «Поглощение стихий» на урон области.
    ElementalDamageReaction,
    /// `ProtectiveReactionPause`: «Щит», парирование и прочие защиты.
    ProtectiveReaction,
}

impl PauseKind {
    /// `error.name`. Наследник `ResistanceAfterRollPause` своего имени не
    /// ставит и носит имя родителя — как в JS.
    pub fn name(self) -> &'static str {
        match self {
            PauseKind::ResistanceChoice | PauseKind::ResistanceAfterRoll => "ResistanceChoicePause",
            PauseKind::ElementalDamageReaction => "ElementalDamageReactionPause",
            PauseKind::ProtectiveReaction => "ProtectiveReactionPause",
        }
    }

    /// Имя класса JS (`error.constructor.name`).
    pub fn class_name(self) -> &'static str {
        match self {
            PauseKind::ResistanceAfterRoll => "ResistanceAfterRollPause",
            other => other.name(),
        }
    }

    /// `error.message`.
    pub fn message(self) -> &'static str {
        match self {
            PauseKind::ResistanceChoice | PauseKind::ResistanceAfterRoll => "Ожидается выбор бонуса спасброска",
            PauseKind::ElementalDamageReaction => "Ожидается реакция на элементальный урон",
            PauseKind::ProtectiveReaction => "Ожидается защитная реакция",
        }
    }
}

/// Пауза боя: команда, событие окна и накопленный префикс.
#[derive(Debug, Clone)]
pub struct Pause {
    pub kind: PauseKind,
    /// `error.command` — копия остановленной команды.
    pub command: Value,
    /// `error.windowEvent` — событие `ReactionWindowOpened`.
    pub window_event: Value,
    /// `error.prefixEvents`: события до окна (удар-открытие, возобновление).
    pub prefix_events: Vec<Value>,
    /// `error.prefixRolls`.
    pub prefix_rolls: Vec<Value>,
}

impl Pause {
    pub fn message(&self) -> &'static str {
        self.kind.message()
    }

    /// `error instanceof ResistanceChoicePause` (истинно и для «после броска»).
    pub fn is_resistance_choice(&self) -> bool {
        matches!(self.kind, PauseKind::ResistanceChoice | PauseKind::ResistanceAfterRoll)
    }

    /// Полезная нагрузка окна (`error.windowEvent.payload`) для правки на месте.
    pub fn window_payload_mut(&mut self) -> &mut Map<String, Value> {
        js::object_mut(&mut self.window_event, "payload")
    }

    /// `new ResistanceChoicePause({ … })`.
    pub fn resistance_choice(args: &ResistanceChoiceArgs<'_>) -> Self {
        let phase = args.phase.unwrap_or("before-roll");
        Self { kind: PauseKind::ResistanceChoice, command: args.command.clone(), window_event: resistance_window(args, phase), prefix_events: Vec::new(), prefix_rolls: Vec::new() }
    }

    /// `new ResistanceAfterRollPause({ …, save, options })`.
    pub fn resistance_after_roll(args: &ResistanceChoiceArgs<'_>, save: Option<&Value>, options: Option<&Value>) -> Self {
        let mut window_event = resistance_window(args, "after-roll");
        fn field<'v>(value: Option<&'v Value>, key: &str) -> Option<&'v Value> {
            value.and_then(|value| value.get(key))
        }
        let kept = field(save, "kept").filter(|value| !value.is_null()).or_else(|| field(save, "natural_roll"));
        let difficulty = field(options, "difficulty");
        let trigger_roll = json!({
            "roll_id": js::s(field(save, "roll_id")),
            "kept": js::safe_int(kept, 0),
            "modifier": js::safe_int(field(save, "modifier"), 0),
            "total": js::safe_int(field(save, "total"), 0),
            "ability": js::s(field(options, "ability")),
            "difficulty": if js::present(difficulty) { Value::from(js::safe_int(difficulty, 0)) } else { Value::Null },
            "save_event_type": "SavingThrowResolved",
        });
        let payload = js::object_mut(&mut window_event, "payload");
        payload.insert("trigger_roll".into(), trigger_roll);
        payload.insert("resistance_phase".into(), Value::String("after-roll".into()));
        Self { kind: PauseKind::ResistanceAfterRoll, command: args.command.clone(), window_event, prefix_events: Vec::new(), prefix_rolls: Vec::new() }
    }

    /// `new ElementalDamageReactionPause({ … })`.
    pub fn elemental_damage_reaction(args: &ElementalDamageArgs<'_>) -> Self {
        let command = args.command;
        let target = js::string(Some(args.target_id));
        let window_id = format!("reaction:{}:elemental:{}", js::string(command.get("command_id")), hash16(&js::string(Some(args.damage_key))));
        let mut payload = Map::new();
        payload.insert("id".into(), Value::String(window_id));
        payload.insert("trigger".into(), Value::String("spell-area-damage".into()));
        payload.insert("actor_id".into(), Value::String(target.clone()));
        payload.insert("source_actor_id".into(), Value::String(js::s(command.get("actor_id"))));
        payload.insert("target_id".into(), Value::String(target.clone()));
        payload.insert("action_ids".into(), option_ids(args.action_options));
        payload.insert("action_options".into(), args.action_options.clone());
        insert_defined(&mut payload, "damage", args.damage.cloned());
        payload.insert("trigger_roll".into(), Value::Null);
        payload.insert("pending_command".into(), command.clone());
        payload.insert("pending_dice_transcript".into(), Value::Array(args.dice_transcript.to_vec()));
        payload.insert("pending_elemental_damage".into(), json!({ "target_id": target, "damage_key": js::string(Some(args.damage_key)) }));
        payload.insert("elemental_damage_choices".into(), choice_entries(args.choices, "damage_key"));
        payload.insert("resistance_choices".into(), choice_entries(args.resistance_choices, "save_key"));
        payload.insert("protective_reaction_choices".into(), choice_entries(args.protective_choices, "key"));
        let window_event = event_from(&command_with_rules(command, &[rule_ids::REACTION]), "ReactionWindowOpened", Some(Value::Object(payload)), Some(&json!([target])));
        Self { kind: PauseKind::ElementalDamageReaction, command: command.clone(), window_event, prefix_events: Vec::new(), prefix_rolls: Vec::new() }
    }

    /// `new ProtectiveReactionPause({ … })`.
    pub fn protective_reaction(args: &ProtectiveReactionArgs<'_>) -> Self {
        let command = args.command;
        let target = js::string(Some(args.target_id));
        let reactor = match args.reactor_id.filter(|value| !value.is_null()) {
            Some(reactor) => js::string(Some(reactor)),
            None => target.clone(),
        };
        let trigger = js::string(Some(args.trigger));
        let kind = js::string(Some(args.kind));
        let window_id = format!("reaction:{}:{kind}:{}", js::string(command.get("command_id")), hash16(&format!("{target}:{trigger}")));
        let source = match args.source_actor_id.filter(|value| !value.is_null()).or_else(|| command.get("actor_id").filter(|value| !value.is_null())) {
            Some(value) => js::string(Some(value)),
            None => String::new(),
        };
        let mut payload = Map::new();
        payload.insert("id".into(), Value::String(window_id));
        payload.insert("trigger".into(), args.trigger.clone());
        payload.insert("actor_id".into(), Value::String(reactor.clone()));
        payload.insert("source_actor_id".into(), Value::String(source));
        payload.insert("target_id".into(), Value::String(target.clone()));
        payload.insert("action_ids".into(), option_ids(args.action_options));
        payload.insert("action_options".into(), args.action_options.clone());
        if let Some(damage) = args.damage.filter(|value| js::truthy(Some(value))) {
            payload.insert("damage".into(), damage.clone());
        }
        payload.insert("trigger_roll".into(), args.trigger_roll.cloned().unwrap_or(Value::Null));
        payload.insert("pending_command".into(), command.clone());
        payload.insert("pending_dice_transcript".into(), Value::Array(args.dice_transcript.to_vec()));
        let key = match args.decision_key.filter(|value| !value.is_null()) {
            Some(key) => key.clone(),
            None => Value::String(format!("{kind}:{target}")),
        };
        payload.insert("pending_protective_reaction".into(), json!({ "kind": args.kind, "key": key, "target_id": target }));
        payload.insert("protective_reaction_choices".into(), choice_entries(args.choices, "key"));
        payload.insert("resistance_choices".into(), choice_entries(args.resistance_choices, "save_key"));
        payload.insert("elemental_damage_choices".into(), choice_entries(args.elemental_choices, "damage_key"));
        let mut targets = vec![Value::String(target.clone())];
        if reactor != target {
            targets.push(Value::String(reactor));
        }
        let window_event = event_from(&command_with_rules(command, &[rule_ids::REACTION]), "ReactionWindowOpened", Some(Value::Object(payload)), Some(&Value::Array(targets)));
        Self { kind: PauseKind::ProtectiveReaction, command: command.clone(), window_event, prefix_events: Vec::new(), prefix_rolls: Vec::new() }
    }
}

/// Аргументы `ResistanceChoicePause` (и «после броска»).
#[derive(Debug, Clone, Copy)]
pub struct ResistanceChoiceArgs<'a> {
    pub command: &'a Value,
    pub target_id: &'a Value,
    /// Состояние `resistance-d4` на цели (или `null`).
    pub condition: Option<&'a Value>,
    pub save_key: &'a Value,
    pub dice_transcript: &'a [Value],
    /// Уже сделанные выборы: объект `save_key → выбор`.
    pub choices: Option<&'a Value>,
    pub elemental_choices: Option<&'a Value>,
    pub protective_choices: Option<&'a Value>,
    /// `phase` конструктора; по умолчанию `before-roll`.
    pub phase: Option<&'a str>,
}

/// Аргументы `ElementalDamageReactionPause`.
#[derive(Debug, Clone, Copy)]
pub struct ElementalDamageArgs<'a> {
    pub command: &'a Value,
    pub target_id: &'a Value,
    pub damage: Option<&'a Value>,
    pub damage_key: &'a Value,
    /// Массив вариантов реакции.
    pub action_options: &'a Value,
    pub dice_transcript: &'a [Value],
    pub choices: Option<&'a Value>,
    pub resistance_choices: Option<&'a Value>,
    pub protective_choices: Option<&'a Value>,
}

/// Аргументы `ProtectiveReactionPause`.
#[derive(Debug, Clone, Copy)]
pub struct ProtectiveReactionArgs<'a> {
    pub command: &'a Value,
    pub target_id: &'a Value,
    pub reactor_id: Option<&'a Value>,
    pub source_actor_id: Option<&'a Value>,
    pub trigger: &'a Value,
    pub kind: &'a Value,
    pub decision_key: Option<&'a Value>,
    pub action_options: &'a Value,
    pub trigger_roll: Option<&'a Value>,
    pub damage: Option<&'a Value>,
    pub dice_transcript: &'a [Value],
    pub choices: Option<&'a Value>,
    pub resistance_choices: Option<&'a Value>,
    pub elemental_choices: Option<&'a Value>,
}

fn hash16(text: &str) -> String {
    sk_core::hash::sha256_hex(text.as_bytes()).chars().take(16).collect()
}

fn insert_defined(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value);
    }
}

/// `actionOptions.map((option) => option.id)`; `undefined` в массиве — `null` в JSON.
fn option_ids(options: &Value) -> Value {
    Value::Array(options.as_array().map(|items| items.iter().map(|option| option.get("id").cloned().unwrap_or(Value::Null)).collect()).unwrap_or_default())
}

/// `Object.entries(x ?? {})` для значения JSON: ключи объекта в порядке JS,
/// индексы массива, символы строки.
pub fn object_entries(value: Option<&Value>) -> Vec<(String, Value)> {
    match value {
        Some(Value::Object(map)) => js::entries(map).into_iter().map(|(key, value)| (key.clone(), value.clone())).collect(),
        Some(Value::Array(items)) => items.iter().enumerate().map(|(index, item)| (index.to_string(), item.clone())).collect(),
        Some(Value::String(text)) => text.chars().enumerate().map(|(index, ch)| (index.to_string(), Value::String(ch.to_string()))).collect(),
        _ => Vec::new(),
    }
}

/// `Object.entries(choices ?? {}).map(([key, choice]) => ({ [field]: String(key),
/// ...(choice && typeof choice === 'object' ? clone(choice) : { use: choice === true }) }))`.
fn choice_entries(choices: Option<&Value>, field: &str) -> Value {
    let entries = object_entries(choices.filter(|value| !value.is_null()));
    Value::Array(
        entries
            .into_iter()
            .map(|(key, choice)| {
                let mut record = Map::new();
                record.insert(field.into(), Value::String(key));
                let tail = if matches!(choice, Value::Object(_) | Value::Array(_)) { spread_value(Some(&choice)) } else { json!({ "use": choice == Value::Bool(true) }).as_object().cloned().unwrap_or_default() };
                for (name, value) in tail {
                    record.insert(name, value);
                }
                Value::Object(record)
            })
            .collect(),
    )
}

/// Окно выбора Сопротивления: общая часть двух конструкторов.
fn resistance_window(args: &ResistanceChoiceArgs<'_>, phase: &str) -> Value {
    let command = args.command;
    let target = js::string(Some(args.target_id));
    let condition = args.condition.filter(|value| !value.is_null());
    let effect_id = match condition.and_then(|condition| condition.get("effect_id")).filter(|value| !value.is_null()) {
        Some(value) => Value::String(js::string(Some(value))),
        None => Value::Null,
    };
    let source_actor = condition.and_then(|condition| condition.get("source_actor")).filter(|value| !value.is_null()).or_else(|| command.get("actor_id").filter(|value| !value.is_null()));
    let source_actor_id = match source_actor {
        Some(value) => js::string(Some(value)),
        None => target.clone(),
    };
    let save_key = js::string(Some(args.save_key));
    let window_id = format!("resistance:{}:{}", js::string(command.get("command_id")), hash16(&format!("{target}:{save_key}")));
    let condition_id = match condition.and_then(|condition| condition.get("id")).filter(|value| !value.is_null()) {
        Some(value) => js::string(Some(value)),
        None => "resistance-d4".to_string(),
    };
    let before_roll = phase == "before-roll";
    let action_ids: Vec<&str> = if before_roll { vec!["use-resistance", "roll-first-resistance", "skip-resistance"] } else { vec!["use-resistance", "skip-resistance"] };
    let mut options = vec![json!({
        "id": "use-resistance", "name": "Использовать Сопротивление", "description": "Добавить 1к4 к этому спасброску.",
        "action_type": "free", "cost": 0, "resource": null,
    })];
    if before_roll {
        options.push(json!({
            "id": "roll-first-resistance", "name": "Сначала бросить", "description": "Сначала выполнить спасбросок, затем решить, добавлять ли 1к4.",
            "action_type": "free", "cost": 0, "resource": null,
        }));
    }
    options.push(json!({
        "id": "skip-resistance", "name": "Без бонуса", "description": "Сохранить Сопротивление для следующего спасброска.",
        "action_type": "free", "cost": 0, "resource": null,
    }));
    let mut payload = Map::new();
    payload.insert("id".into(), Value::String(window_id));
    payload.insert("trigger".into(), Value::String("saving-throw-bonus-choice".into()));
    payload.insert("free_choice".into(), Value::Bool(true));
    payload.insert("choice_kind".into(), Value::String("saving_throw_bonus".into()));
    payload.insert("resistance_phase".into(), Value::String(phase.into()));
    payload.insert("actor_id".into(), Value::String(target.clone()));
    payload.insert("source_actor_id".into(), Value::String(source_actor_id));
    payload.insert("target_id".into(), Value::String(target.clone()));
    payload.insert("action_ids".into(), js::strings_value(action_ids));
    payload.insert("action_options".into(), Value::Array(options));
    payload.insert("pending_command".into(), command.clone());
    payload.insert("pending_dice_transcript".into(), Value::Array(args.dice_transcript.to_vec()));
    payload.insert(
        "pending_resistance_choice".into(),
        json!({ "target_id": target, "save_key": save_key, "condition_id": condition_id, "effect_id": effect_id, "phase": phase }),
    );
    payload.insert("resistance_choices".into(), choice_entries(args.choices, "save_key"));
    payload.insert("elemental_damage_choices".into(), choice_entries(args.elemental_choices, "damage_key"));
    payload.insert("protective_reaction_choices".into(), choice_entries(args.protective_choices, "key"));
    payload.insert("resistance_save_key".into(), Value::String(save_key));
    payload.insert("resistance_condition_id".into(), Value::String(condition_id));
    payload.insert("resistance_effect_id".into(), effect_id);
    payload.insert("spell_id".into(), Value::String("resistance".into()));
    event_from(&command_with_rules(command, &[rule_ids::SAVING_THROW, rule_ids::CONDITIONS]), "ReactionWindowOpened", Some(Value::Object(payload)), Some(&json!([target])))
}

/// `resistanceChoiceMode(value)`.
pub fn resistance_choice_mode(value: Option<&Value>) -> String {
    match value {
        Some(Value::Object(map)) => match map.get("mode").filter(|mode| !mode.is_null()) {
            Some(mode) => js::string(Some(mode)),
            None => if js::is_true(map.get("use")) { "before-roll".into() } else { "decline".into() },
        },
        Some(Value::Array(_)) => "decline".into(),
        Some(Value::Bool(true)) => "before-roll".into(),
        Some(Value::String(text)) if matches!(text.as_str(), "before-roll" | "decline" | "after" | "after-use" | "after-skip") => text.clone(),
        _ => "decline".into(),
    }
}

/// `resistanceChoicesFromContext(context)`: `save_key → { …, mode }` в порядке
/// первого появления ключа (повтор перезаписывает значение, как `Map`).
pub fn resistance_choices_from_context(raw: Option<&Value>) -> sk_core::indexmap::IndexMap<String, Value> {
    let mut choices = sk_core::indexmap::IndexMap::new();
    match raw {
        Some(Value::Array(entries)) => {
            for entry in entries {
                let key = match entry.get("save_key").filter(|value| !value.is_null()).or_else(|| entry.get("saveKey").filter(|value| !value.is_null())) {
                    Some(value) => js::string(Some(value)),
                    None => String::new(),
                };
                let mut record = spread_value(Some(entry).filter(|value| !value.is_null()));
                record.insert("mode".into(), Value::String(resistance_choice_mode(Some(entry))));
                if !key.is_empty() {
                    choices.insert(key, Value::Object(record));
                }
            }
        }
        Some(value @ Value::Object(_)) => {
            for (key, choice) in object_entries(Some(value)) {
                if !key.is_empty() {
                    choices.insert(key, json!({ "mode": resistance_choice_mode(Some(&choice)) }));
                }
            }
        }
        _ => {}
    }
    choices
}

/// `resistanceChoicesObject(choices)`.
pub fn resistance_choices_object(choices: &sk_core::indexmap::IndexMap<String, Value>) -> Value {
    let mut result = Map::new();
    for (key, choice) in choices {
        let mut record = if matches!(choice, Value::Object(_) | Value::Array(_)) { spread_value(Some(choice)) } else { Map::new() };
        let mode = resistance_choice_mode(Some(choice));
        record.insert("mode".into(), Value::String(mode.clone()));
        record.insert("use".into(), Value::Bool(mode == "before-roll"));
        result.insert(key.clone(), Value::Object(record));
    }
    Value::Object(result)
}

/// `resistanceConditionFor(state, targetId)`.
pub fn resistance_condition_for<'a>(state: &'a Value, target_id: &str) -> Option<&'a Value> {
    sk_core::game::conditions(state, target_id).iter().find(|condition| sk_core::game::condition_id(condition) == "resistance-d4")
}

/// `pendingExecutionFor(context)`.
pub fn pending_execution_for(context: &crate::context::Context) -> Value {
    let mut payload = Map::new();
    payload.insert("schema_version".into(), Value::from(1));
    payload.insert("readied_release".into(), Value::Bool(context.is_true("readiedRelease")));
    payload.insert("additional_beam".into(), Value::Bool(context.is_true("additionalBeam")));
    payload.insert("reaction_resolution".into(), Value::Bool(context.is_true("reactionResolution")));
    if let Some(flee) = context.get("finalizeFleeActorId").filter(|value| js::truthy(Some(value))) {
        payload.insert("finalize_flee_actor_id".into(), Value::String(js::string(Some(flee))));
    }
    Value::Object(payload)
}

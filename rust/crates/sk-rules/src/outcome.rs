//! Итог разбора команды на границе API: записанное действие или ожидание
//! решения игрока (урок 5 плана переноса, `docs/rust-rewrite-plan.md`, §1 п.5
//! и §4 «Сквозные правила»).
//!
//! В JS пауза боя — исключение, которое обёртка `resolveCommandWithPauses`
//! превращает в событие окна, а вызывающий узнаёт об ожидании по окну в
//! состоянии. Здесь ожидание — тип: [`Outcome::Pending`] несёт события
//! команды (их коммитят так же, как события записанного действия: окно —
//! тоже событие) и [`Prompt`] — кто решает, из каких вариантов, до какого
//! срока и как команда продолжится.
//!
//! Ожидание — окно реакции, которое команда открыла и оставила открытым:
//! пауза посреди действия (Сопротивление, «Поглощение стихий», «Щит»,
//! «Оборона», «Острое словцо») и окно после действия (удар вдогонку,
//! подготовленное действие, контрзаклинание, «Несгибаемый»). Ответ — новая
//! команда игрока (`UseCombatAction` по окну).
//!
//! Ручной бросок, уточнение и голосование через разбор команды не проходят:
//! они живут в `sk-infra` (`roll_registry`), `sk-narration-base`
//! (`clarification_registry`) и `sk-memory` (`party_decision`).

use serde_json::Value;
use sk_core::js;

use crate::resolve::Resolved;

/// Итог разбора команды.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    /// Команда исполнена; решения игрока она не ждёт.
    Committed(Resolved),
    /// Команда открыла окно и ждёт решения. `resolved` — события до окна и
    /// само окно: их коммитят как есть.
    Pending { resolved: Resolved, prompt: Prompt },
}

impl Outcome {
    /// Итог по состоянию после событий команды (`after`).
    pub fn with_state_after(resolved: Resolved, after: &Value) -> Self {
        match prompt_after(&resolved.events, after) {
            Some(prompt) => Outcome::Pending { resolved, prompt },
            None => Outcome::Committed(resolved),
        }
    }

    /// Итог по состоянию до команды: события применяются, только если среди
    /// них есть открытие окна (иначе ждать нечего). Если редьюсер на них
    /// падает, итог — `Committed`: ту же ошибку скажет коммит.
    pub fn with_state_before(resolved: Resolved, raw_state: &Value) -> Self {
        if !resolved.events.iter().any(is_window_opened) {
            return Outcome::Committed(resolved);
        }
        match state_after(raw_state, &resolved.events) {
            Some(after) => Self::with_state_after(resolved, &after),
            None => Outcome::Committed(resolved),
        }
    }

    /// [`Self::with_state_before`] над нормализованным состоянием до команды.
    pub fn with_normalized_state_before(resolved: Resolved, state: &crate::normalized::NormalizedState) -> Self {
        if !resolved.events.iter().any(is_window_opened) {
            return Outcome::Committed(resolved);
        }
        let mut chain = crate::normalized::EventChain::new(state.clone());
        for event in &resolved.events {
            if chain.apply(event).is_err() {
                return Outcome::Committed(resolved);
            }
        }
        let after = chain.into_raw();
        Self::with_state_after(resolved, &after)
    }

    /// События и броски команды — для коммита в обоих исходах.
    pub fn resolved(&self) -> &Resolved {
        match self {
            Outcome::Committed(resolved) | Outcome::Pending { resolved, .. } => resolved,
        }
    }

    /// [`Outcome::resolved`] по значению.
    pub fn into_resolved(self) -> Resolved {
        match self {
            Outcome::Committed(resolved) | Outcome::Pending { resolved, .. } => resolved,
        }
    }

    /// Чьё решение ждёт команда, если ждёт.
    pub fn prompt(&self) -> Option<&Prompt> {
        match self {
            Outcome::Committed(_) => None,
            Outcome::Pending { prompt, .. } => Some(prompt),
        }
    }

    pub fn is_pending(&self) -> bool {
        matches!(self, Outcome::Pending { .. })
    }
}

/// Ожидание решения: окно реакции словами типа.
#[derive(Debug, Clone, PartialEq)]
pub struct Prompt {
    /// `id` окна; ответ ссылается на него.
    pub window_id: String,
    /// Что открыло окно (`trigger`: `attack-protection-choice`, `spell-cast`…).
    pub trigger: String,
    /// Кто решает (`actor_id` окна). Это не обязательно цель: «Оборону» и
    /// «Острое словцо» решает союзник цели.
    pub reactor: String,
    /// Кого касается решение (`target_id`).
    pub target: Option<String>,
    /// Чьё действие вызвало окно (`source_actor_id`).
    pub source: Option<String>,
    /// Варианты ответа (`action_options`) в порядке окна.
    pub options: Vec<PromptOption>,
    /// Выбор без траты реакции (бонус Сопротивления к спасброску).
    pub free_choice: bool,
    pub deadline: Deadline,
    pub resume: Continuation,
}

impl Prompt {
    /// Ожидание по полезной нагрузке `ReactionWindowOpened`.
    pub fn from_window(window: &Value) -> Self {
        let text = |key: &str| js::s(window.get(key));
        let optional = |key: &str| window.get(key).filter(|value| js::truthy(Some(value))).map(|value| js::string(Some(value)));
        let reactor = text("actor_id");
        let options = window
            .get("action_options")
            .and_then(Value::as_array)
            .map(|options| {
                options
                    .iter()
                    .map(|option| PromptOption {
                        id: js::s(option.get("id")),
                        reactor: option.get("reactor_id").filter(|value| js::truthy(Some(value))).map(|value| js::string(Some(value))).unwrap_or_else(|| reactor.clone()),
                        option: option.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let resume = if let Some(command) = window.get("pending_command").filter(|value| js::truthy(Some(value))) {
            Continuation::Replay {
                command: command.clone(),
                dice_transcript: window.get("pending_dice_transcript").and_then(Value::as_array).cloned().unwrap_or_default(),
                execution: window.get("pending_execution").filter(|value| js::truthy(Some(value))).cloned(),
            }
        } else if let Some(command) = window.get("pending_spell_command").filter(|value| js::truthy(Some(value))) {
            Continuation::Spell { command: command.clone() }
        } else {
            Continuation::Answer
        };
        Self {
            window_id: text("id"),
            trigger: text("trigger"),
            reactor,
            target: optional("target_id"),
            source: optional("source_actor_id"),
            options,
            free_choice: js::is_true(window.get("free_choice")),
            deadline: Deadline::TurnClock,
            resume,
        }
    }

    /// Все, кто может ответить: реагирующий окна и владельцы вариантов, без
    /// повторов, в порядке появления.
    pub fn reactors(&self) -> Vec<&str> {
        let mut reactors: Vec<&str> = Vec::new();
        for reactor in std::iter::once(self.reactor.as_str()).chain(self.options.iter().map(|option| option.reactor.as_str())) {
            if !reactor.is_empty() && !reactors.contains(&reactor) {
                reactors.push(reactor);
            }
        }
        reactors
    }
}

/// Вариант ответа на окно.
#[derive(Debug, Clone, PartialEq)]
pub struct PromptOption {
    /// `id` варианта — `action_id` ответа.
    pub id: String,
    /// Кто выбирает вариант: `reactor_id` варианта, иначе реагирующий окна.
    pub reactor: String,
    /// Вариант как в окне.
    pub option: Value,
}

/// Срок решения.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Deadline {
    /// Часы хода сервера (`sk-turns` `combat_turn_clock`): отсчёт с открытия
    /// окна, по истечении — автоотказ `turn-timeout`. Когда часы не идут (вне
    /// боя, ход одних врагов), срока нет. Движку длительность не известна:
    /// её задаёт сервер.
    TurnClock,
}

/// Как команда продолжится после решения.
#[derive(Debug, Clone, PartialEq)]
pub enum Continuation {
    /// Команда уже исполнена; ответ — отдельная команда реакции.
    Answer,
    /// Команда остановлена посреди разбора (`pending_command`). Ответ
    /// разбирает её заново над состоянием после ответа: кости повторяются по
    /// стенограмме `dice_transcript`, выбор приходит контекстом, флаги
    /// исполнения — `execution` (`resolve/resume.rs`). Продолжения с
    /// сохранённой точки нет: точка разбора в событие не записывается, а
    /// событие окна должно остаться байт в байт как в JS.
    Replay { command: Value, dice_transcript: Vec<Value>, execution: Option<Value> },
    /// Заклинание ждёт контрзаклинания (`pending_spell_command`): ответ
    /// гасит его или творит дальше.
    Spell { command: Value },
}

fn is_window_opened(event: &Value) -> bool {
    event.get("event_type").and_then(Value::as_str) == Some("ReactionWindowOpened")
}

/// Окно, открытое этими событиями и открытое в `after`.
pub fn prompt_after(events: &[Value], after: &Value) -> Option<Prompt> {
    let window = sk_core::game::combat(after).get("reaction_window").filter(|window| js::truthy(Some(window)))?;
    let window_id = js::s(window.get("id"));
    let opened = events.iter().rev().filter(|event| is_window_opened(event)).find_map(|event| event.get("payload").filter(|payload| js::s(payload.get("id")) == window_id))?;
    Some(Prompt::from_window(opened))
}

fn state_after(raw_state: &Value, events: &[Value]) -> Option<Value> {
    let mut state = crate::normalize::normalize_campaign_state_cow(raw_state).ok()?.into_owned();
    for event in events {
        state = crate::replay::apply_game_event_owned(state, event).ok()?;
    }
    Some(state)
}

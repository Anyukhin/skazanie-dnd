//! Перенос `server/scenario-attention.mjs` — внимание главного противника
//! сценария («Внимание Саргата» в Асстохане, `docs/astohan-scenario.md`,
//! раздел 7).
//!
//! Счётчик не хранится отдельным событием, а выводится редьюсером из журнала
//! ([`apply_scenario_attention_event`] после каждого события): место берётся
//! из сцены в момент события, поэтому replay даёт тот же счёт. Поднимают его
//! открытый расспрос о драконе в поселении с осведомителями (+1 за визит), бой
//! там же (+2), поимка осведомителя при людях; перевербованный осведомитель
//! счёт снижает. Тот же реестр помнит сцену незнакомца (приход и выдох),
//! договор финала, кошель короля, вещи оружейной и решения по осведомителям.
//!
//! Модуль — лист графа: читает состояние и сценарий (`sk_scenario`), Rules
//! Engine не знает. Числа выдоха живут в данных сценария, а не в коде.
//!
//! Реестр на границе — JSON той же формы и с тем же порядком ключей, что у JS
//! (`normalizeScenarioAttentionState`); внутри — [`ScenarioAttentionState`].

use serde::Serialize;
use serde_json::{json, Map, Value};
use sk_core::fancy_regex::Regex;
use sk_core::{js, re, text};
use sk_items::item_catalog::catalog_item;
use sk_scenario::campaign_scenario::{
    campaign_scenario, scenario_armory_rules, scenario_attention_ready_for, scenario_location_id, scenario_previous_location_id,
    scenario_purse_rules, scenario_treaty_rules,
};

use crate::support::{array, clean, head_utf16, insert_raw, is_str, js_object, nullish, prop, strict_eq, utf16_len};

pub const SCENARIO_ATTENTION_SCHEMA_VERSION: i64 = 1;
pub const SCENARIO_ATTENTION_POLICY_ID: &str = "skazanie:scenario-attention-v1";
pub const SCENARIO_COMMAND_TYPES: [&str; 1] = ["StageScenarioStranger"];
/// Договор с главным противником финала (`NegotiateScenarioTreaty`).
pub const SCENARIO_TREATY_COMMAND_TYPES: [&str; 1] = ["NegotiateScenarioTreaty"];
pub const SCENARIO_TREATY_CONCLUDED_EVENT: &str = "ScenarioTreatyConcluded";
pub const SCENARIO_TREATY_REFUSED_EVENT: &str = "ScenarioTreatyRefused";
/// Кошель короля: раз на героя, в месте выдачи (`ReceiveScenarioPurse`).
pub const SCENARIO_PURSE_COMMAND_TYPES: [&str; 1] = ["ReceiveScenarioPurse"];
pub const SCENARIO_PURSE_EVENT: &str = "ScenarioPurseGranted";
/// Королевская оружейная: одна вещь на героя (`ChooseScenarioArmoryItem`).
pub const SCENARIO_ARMORY_COMMAND_TYPES: [&str; 1] = ["ChooseScenarioArmoryItem"];
pub const SCENARIO_ARMORY_EVENT: &str = "ScenarioArmoryItemChosen";
/// Осведомитель пепельной сети: выдать страже, отпустить или перевербовать.
pub const SCENARIO_INFORMANT_COMMAND_TYPES: [&str; 1] = ["ResolveScenarioInformant"];
pub const SCENARIO_INFORMANT_CHOICES: [&str; 3] = ["expose", "release", "turn"];
pub const SCENARIO_INFORMANT_EVENT: &str = "ScenarioInformantResolved";
pub const SCENARIO_INFORMANT_TURN_FAILED_EVENT: &str = "ScenarioInformantTurnFailed";
/// Провенанс решения: выдать или отпустить редакция не описывает.
pub const SCENARIO_INFORMANT_POLICY_ID: &str = "skazanie:scenario-informant-v1";
/// Провенанс подарка: редакция стартовых вещей сценария не описывает.
pub const SCENARIO_ARMORY_POLICY_ID: &str = "skazanie:scenario-armory-v1";
pub const SCENARIO_STRANGER_STAGES: [&str; 2] = ["arrive", "reveal"];
/// Событие шага сцены незнакомца; стадия в нём — уже свершившаяся.
pub const SCENARIO_STRANGER_EVENT: &str = "ScenarioStrangerStaged";
pub const SCENARIO_STRANGER_EVENT_SCHEMA_VERSION: i64 = 1;

const HISTORY_LIMIT: usize = 40;
const COUNTED_LIMIT: usize = 200;
/// Навыки тихого расследования: ими выспрашивают, не привлекая внимания.
const QUIET_SKILLS: [&str; 4] = ["deception", "stealth", "sleight_of_hand", "sleight-of-hand"];
const STRANGER_STATES: [&str; 3] = ["none", "arrived", "revealed"];

/// Одно изменение счёта (`history`).
#[derive(Debug, Clone, PartialEq)]
pub struct AttentionChange {
    pub delta: i64,
    /// Счёт после изменения. Число JS: `NaN` возможен только при нечисловом
    /// `maximum` сценария и пишется в JSON как `null`, как у `JSON.stringify`.
    pub value: f64,
    pub reason: String,
    pub location_id: String,
    pub event_id: String,
}

/// Сцена незнакомца: `none` → `arrived` → `revealed`.
#[derive(Debug, Clone, PartialEq)]
pub struct StrangerState {
    pub stage: String,
    pub location_id: String,
    pub party_acted: bool,
}

/// Договор финала: заключён ли и кто из героев уже пробовал.
#[derive(Debug, Clone, PartialEq)]
pub struct TreatyState {
    pub concluded: bool,
    pub concluded_by: String,
    pub attempts: Vec<String>,
}

/// Реестр `scenario_attention` — то, что возвращает
/// `normalizeScenarioAttentionState`.
#[derive(Debug, Clone, PartialEq)]
pub struct ScenarioAttentionState {
    pub schema_version: i64,
    /// Счёт внимания (см. [`AttentionChange::value`] о `NaN`).
    pub value: f64,
    pub visit: i64,
    pub counted: Vec<String>,
    pub history: Vec<AttentionChange>,
    pub stranger: StrangerState,
    pub treaty: TreatyState,
    pub purse_paid: Vec<String>,
    pub armory_taken: Vec<String>,
    /// Решённые осведомители `id → expose | release | turn` в порядке создания
    /// свойств; в JSON ключи-индексы встают первыми, как у объекта JS.
    pub informants: Vec<(String, String)>,
    pub informant_turn_failed: Vec<String>,
}

/// `integer(value, fallback)`: безопасное целое `Number(value)` или запас.
fn integer(value: Option<&Value>, fallback: i64) -> i64 {
    js::safe_int(value, fallback)
}

/// `integer(value, NaN)`: безопасное целое или ничего.
fn integer_or_nan(value: Option<&Value>) -> Option<i64> {
    js::is_safe_integer_number(value).then(|| js::number(value) as i64)
}

/// `list.slice(-limit)`.
fn tail<T: Clone>(items: &[T], limit: usize) -> Vec<T> {
    items[items.len().saturating_sub(limit)..].to_vec()
}

/// `(Array.isArray(x) ? x : []).map((id) => clean(id, max)).filter(Boolean).slice(-200)`.
fn clean_list(value: Option<&Value>, max: usize) -> Vec<String> {
    let cleaned: Vec<String> = array(value).iter().map(|entry| clean(Some(entry), max)).filter(|entry| !entry.is_empty()).collect();
    tail(&cleaned, COUNTED_LIMIT)
}

/// `[...new Set([...list, extra])]`.
fn unique_with(list: &[String], extra: String) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    for entry in list.iter().cloned().chain(std::iter::once(extra)) {
        if !result.contains(&entry) {
            result.push(entry);
        }
    }
    result
}

/// `{ ...informants, [id]: outcome }`: повтор ключа меняет значение на месте.
fn set_informant(informants: &mut Vec<(String, String)>, id: String, outcome: String) {
    match informants.iter_mut().find(|(known, _)| *known == id) {
        Some(slot) => slot.1 = outcome,
        None => informants.push((id, outcome)),
    }
}

impl ScenarioAttentionState {
    /// `normalizeScenarioAttentionState(input)`: любой мусор старых кампаний
    /// становится реестром текущей схемы.
    pub fn normalize(input: Option<&Value>) -> Self {
        let value = input.filter(|value| value.is_object());
        let stranger = prop(value, "stranger");
        let stage = match prop(stranger, "stage") {
            Some(Value::String(stage)) if STRANGER_STATES.contains(&stage.as_str()) => stage.clone(),
            _ => "none".to_string(),
        };
        let treaty = prop(value, "treaty");
        let history = tail(array(prop(value, "history")), HISTORY_LIMIT)
            .iter()
            .map(|entry| {
                let entry = Some(entry);
                AttentionChange {
                    delta: integer(prop(entry, "delta"), 0),
                    value: integer(prop(entry, "value"), 0).max(0) as f64,
                    reason: clean(prop(entry, "reason"), 40),
                    location_id: clean(prop(entry, "location_id"), 120),
                    event_id: clean(prop(entry, "event_id"), 160),
                }
            })
            .collect();
        // `Object.entries` объекта или массива (индексы), затем
        // `Object.fromEntries` с чисткой: повтор ключа после чистки оставляет
        // место первого и значение последнего.
        let raw_informants: Vec<(String, &Value)> = match prop(value, "informants") {
            Some(Value::Object(map)) => js::entries(map).into_iter().map(|(key, item)| (key.clone(), item)).collect(),
            Some(Value::Array(items)) => items.iter().enumerate().map(|(index, item)| (index.to_string(), item)).collect(),
            _ => Vec::new(),
        };
        let mut informants: Vec<(String, String)> = Vec::new();
        for (key, outcome) in raw_informants {
            let id = clean(Some(&Value::String(key)), 80);
            let outcome = clean(Some(outcome), 20);
            if !id.is_empty() && SCENARIO_INFORMANT_CHOICES.contains(&outcome.as_str()) {
                set_informant(&mut informants, id, outcome);
            }
        }
        Self {
            schema_version: SCENARIO_ATTENTION_SCHEMA_VERSION,
            value: integer(prop(value, "value"), 0).max(0) as f64,
            visit: integer(prop(value, "visit"), 0).max(0),
            counted: clean_list(prop(value, "counted"), 200),
            history,
            stranger: StrangerState {
                stage,
                location_id: clean(prop(stranger, "location_id"), 120),
                party_acted: js::is_true(prop(stranger, "party_acted")),
            },
            treaty: TreatyState {
                concluded: js::is_true(prop(treaty, "concluded")),
                concluded_by: clean(prop(treaty, "concluded_by"), 120),
                attempts: clean_list(prop(treaty, "attempts"), 120),
            },
            purse_paid: clean_list(prop(value, "purse_paid"), 120),
            armory_taken: clean_list(prop(value, "armory_taken"), 120),
            informants,
            informant_turn_failed: clean_list(prop(value, "informant_turn_failed"), 80),
        }
    }

    /// Решение по осведомителю или `None`.
    pub fn informant(&self, id: &str) -> Option<&str> {
        self.informants.iter().find(|(known, _)| known == id).map(|(_, outcome)| outcome.as_str())
    }

    /// Реестр в JSON — так, как его пишет JS.
    pub fn to_value(&self) -> Value {
        let history: Vec<Value> = self
            .history
            .iter()
            .map(|change| {
                json!({
                    "delta": change.delta,
                    "value": js::num(change.value),
                    "reason": change.reason,
                    "location_id": change.location_id,
                    "event_id": change.event_id,
                })
            })
            .collect();
        let informants = js_object(self.informants.iter().map(|(id, outcome)| (id.clone(), Value::String(outcome.clone()))));
        json!({
            "schema_version": self.schema_version,
            "value": js::num(self.value),
            "visit": self.visit,
            "counted": self.counted,
            "history": history,
            "stranger": {
                "stage": self.stranger.stage,
                "location_id": self.stranger.location_id,
                "party_acted": self.stranger.party_acted,
            },
            "treaty": {
                "concluded": self.treaty.concluded,
                "concluded_by": self.treaty.concluded_by,
                "attempts": self.treaty.attempts,
            },
            "purse_paid": self.purse_paid,
            "armory_taken": self.armory_taken,
            "informants": Value::Object(informants),
            "informant_turn_failed": self.informant_turn_failed,
        })
    }
}

/// `normalizeScenarioAttentionState(input)`; `None` — `undefined`.
pub fn normalize_scenario_attention_state(input: Option<&Value>) -> Value {
    ScenarioAttentionState::normalize(input).to_value()
}

/// `campaignScenario(state)?.attention ?? null` (только истинный: модуль
/// всюду проверяет его через `!config`).
fn attention_config(state: &Value) -> Option<&'static Value> {
    campaign_scenario(state).and_then(|scenario| scenario.get("attention")).filter(|config| js::truthy(Some(config)))
}

/// `clean(value, 1_000).toLocaleLowerCase('ru').replace(/ё/gu, 'е')`.
fn folded(value: Option<&Value>) -> String {
    text::lower(&clean(value, 1_000)).replace('ё', "е")
}

/// `value.split(/[^\p{L}\p{M}]+/u).filter(Boolean)`.
fn words(value: &str) -> Vec<String> {
    text::find_all(re!(r"[\p{L}\p{M}]+", "u"), value)
}

/// `words.some((word) => word.startsWith(String(stem)))` для списка основ.
fn any_stem(stems: &[Value], words: &[String]) -> bool {
    stems.iter().any(|stem| {
        let stem = js::string(Some(stem));
        words.iter().any(|word| word.starts_with(&stem))
    })
}

/// Упоминает ли текст тему сценария: основа слова ищется в начале слова,
/// чтобы «дракон» находился в «драконе» и «драконьих», а не внутри чужого
/// слова. `config` — `attention` сценария, `text` — что угодно из JSON.
pub fn mentions_scenario_topic(config: Option<&Value>, text: Option<&Value>) -> bool {
    let value = folded(text);
    if value.is_empty() {
        return false;
    }
    any_stem(array(prop(config, "topic_stems")), &words(&value))
}

/// Повод поднять счёт (`raise`).
struct Raise<'a> {
    delta: i64,
    reason: String,
    key: String,
    location_id: String,
    event_id: Option<&'a Value>,
}

fn raise(mut ledger: ScenarioAttentionState, config: &Value, change: Raise) -> ScenarioAttentionState {
    if ledger.counted.contains(&change.key) {
        return ledger;
    }
    let maximum = js::number(config.get("maximum"));
    let value = js::max_of([0.0, js::min_of([maximum, ledger.value + change.delta as f64])]);
    ledger.value = value;
    ledger.counted.push(change.key);
    ledger.counted = tail(&ledger.counted, COUNTED_LIMIT);
    ledger.history.push(AttentionChange {
        delta: change.delta,
        value,
        reason: change.reason,
        location_id: change.location_id,
        event_id: clean(change.event_id, 160),
    });
    ledger.history = tail(&ledger.history, HISTORY_LIMIT);
    ledger
}

/// Свёртка одного события в реестр (структура). Вызывается редьюсером
/// **после** применения события: место — это сцена, в которой оно случилось.
pub fn apply_scenario_attention(ledger_input: Option<&Value>, event: Option<&Value>, state: &Value) -> ScenarioAttentionState {
    let mut ledger = ScenarioAttentionState::normalize(ledger_input);
    let config = attention_config(state);
    if !js::truthy(event) {
        return ledger;
    }
    let event_payload = prop(event, "payload");
    // Договор — часть финала, а не внимания: сворачивается и без счётчика.
    let event_type = js::s(prop(event, "event_type"));
    if event_type == SCENARIO_PURSE_EVENT || event_type == SCENARIO_ARMORY_EVENT {
        let hero_id = clean(nullish(prop(event_payload, "hero_id"), prop(event, "actor_id")), 120);
        if !hero_id.is_empty() {
            let list = if event_type == SCENARIO_PURSE_EVENT { &mut ledger.purse_paid } else { &mut ledger.armory_taken };
            *list = tail(&unique_with(list, hero_id), COUNTED_LIMIT);
        }
        return ledger;
    }
    if event_type == SCENARIO_INFORMANT_TURN_FAILED_EVENT {
        let informant_id = clean(prop(event_payload, "informant_id"), 80);
        if !informant_id.is_empty() {
            // Срез `slice(-200)` здесь JS не делает: его сделает нормализация.
            ledger.informant_turn_failed = unique_with(&ledger.informant_turn_failed, informant_id);
        }
        return ledger;
    }
    if event_type == SCENARIO_INFORMANT_EVENT {
        let informant_id = clean(prop(event_payload, "informant_id"), 80);
        let outcome = clean(prop(event_payload, "outcome"), 20);
        if informant_id.is_empty() || !SCENARIO_INFORMANT_CHOICES.contains(&outcome.as_str()) {
            return ledger;
        }
        set_informant(&mut ledger.informants, informant_id.clone(), outcome.clone());
        // Поимка на глазах у людей — громкое дело; перевербованный шлёт ложь.
        // Шаг берётся из данных сценария, а не из события: событие видит
        // игрок, а счёт внимания — нет.
        let informant = array(prop(config, "informants")).iter().find(|entry| is_str(entry.get("id"), &informant_id));
        let delta = match outcome.as_str() {
            "expose" => integer(prop(informant, "expose_delta"), 0),
            "turn" => integer(prop(prop(informant, "turn"), "delta"), 0),
            _ => 0,
        };
        return match config {
            Some(config) if delta != 0 => {
                // JS чистит id события дважды: здесь и внутри `raise`.
                let event_id = Value::String(clean(prop(event, "event_id"), 160));
                raise(ledger, config, Raise {
                    delta,
                    reason: format!("informant-{outcome}"),
                    key: format!("informant:{informant_id}"),
                    location_id: clean(prop(event_payload, "location_id"), 120),
                    event_id: Some(&event_id),
                })
            }
            _ => ledger,
        };
    }
    if event_type == SCENARIO_TREATY_CONCLUDED_EVENT {
        ledger.treaty.concluded = true;
        ledger.treaty.concluded_by = clean(prop(event, "actor_id"), 120);
        return ledger;
    }
    if event_type == SCENARIO_TREATY_REFUSED_EVENT {
        let mut attempts = ledger.treaty.attempts.clone();
        attempts.push(clean(prop(event, "actor_id"), 120));
        attempts.retain(|entry| !entry.is_empty());
        ledger.treaty.attempts = tail(&attempts, COUNTED_LIMIT);
        return ledger;
    }
    let Some(config) = config else {
        return ledger;
    };
    let payload = nullish(event_payload, None);
    let location_id = scenario_location_id(state);
    let watched = array(config.get("watched_location_ids")).iter().any(|entry| is_str(Some(entry), &location_id));
    let stranger_id = prop(config.get("stranger"), "npc_id");
    let party_ids: Vec<String> = array(state.get("partyMemberIds")).iter().map(|id| js::string(Some(id))).collect();

    if event_type == "SceneAdvanced" {
        ledger.visit += 1;
        return ledger;
    }
    if event_type == SCENARIO_STRANGER_EVENT {
        let stage = prop(payload, "stage");
        if is_str(stage, "revealed") {
            ledger.stranger.stage = "revealed".into();
        } else if is_str(stage, "arrived") {
            ledger.stranger.stage = "arrived".into();
        }
        let place = clean(prop(payload, "location_id"), 120);
        if !place.is_empty() {
            ledger.stranger.location_id = place;
        }
        ledger.stranger.party_acted = false;
        return ledger;
    }
    // Незнакомец открывается после первого же поступка отряда при нём:
    // реплики, шага, проверки. Иначе он не успел бы «прощупать» отряд.
    if ledger.stranger.stage == "arrived"
        && !ledger.stranger.party_acted
        && (party_ids.contains(&js::s(prop(event, "actor_id"))) || event_type == "NpcConversationRecorded")
    {
        ledger.stranger.party_acted = true;
    }
    let questions = |ledger: ScenarioAttentionState| {
        let key = format!("questions:{location_id}:{}", ledger.visit);
        raise(ledger, config, Raise {
            delta: 1,
            reason: "questions".into(),
            key,
            location_id: location_id.clone(),
            event_id: prop(event, "event_id"),
        })
    };
    if event_type == "NpcConversationRecorded" {
        let conversation = nullish(prop(payload, "conversation"), None);
        let npc_id = js::s(prop(conversation, "npc_id"));
        if matches!(stranger_id, Some(Value::String(stranger)) if *stranger == npc_id) {
            return ledger;
        }
        if !watched || QUIET_SKILLS.contains(&clean(prop(prop(conversation, "check"), "skill"), 40).as_str()) {
            return ledger;
        }
        if !mentions_scenario_topic(Some(config), prop(conversation, "player_message")) {
            return ledger;
        }
        return questions(ledger);
    }
    if event_type == "RulingRecorded" {
        let ruling = prop(payload, "ruling");
        let interpretation = prop(ruling, "interpretation");
        if !watched
            || !is_str(prop(interpretation, "activity_kind"), "social")
            || QUIET_SKILLS.contains(&clean(prop(interpretation, "skill"), 40).as_str())
        {
            return ledger;
        }
        if !mentions_scenario_topic(Some(config), prop(ruling, "question")) {
            return ledger;
        }
        return questions(ledger);
    }
    if event_type == "EncounterCreated" {
        if !watched {
            return ledger;
        }
        let mut encounter_id = clean(nullish(prop(payload, "encounter_id"), prop(prop(payload, "encounter"), "id")), 120);
        if encounter_id.is_empty() {
            encounter_id = clean(prop(event, "event_id"), 160);
        }
        return raise(ledger, config, Raise {
            delta: 2,
            reason: "fight".into(),
            key: format!("fight:{encounter_id}"),
            location_id: location_id.clone(),
            event_id: prop(event, "event_id"),
        });
    }
    ledger
}

/// `applyScenarioAttentionEvent(ledger, event, state)` — реестр после события
/// в JSON. `None` у реестра и события — `undefined`.
pub fn apply_scenario_attention_event(ledger_input: Option<&Value>, event: Option<&Value>, state: &Value) -> Value {
    apply_scenario_attention(ledger_input, event, state).to_value()
}

/// `scenarioAttention(state)` — внимание для Режиссёра и тестов. `None` — у
/// кампании нет сценария со счётчиком.
pub fn scenario_attention(state: &Value) -> Option<Value> {
    let config = attention_config(state)?;
    let ledger = ScenarioAttentionState::normalize(state.get("scenario_attention"));
    let full = ledger.to_value();
    let mut result = Map::new();
    result.insert("value".into(), js::num(ledger.value));
    insert_raw(&mut result, "maximum", config.get("maximum"));
    insert_raw(&mut result, "stranger_at", config.get("stranger_at"));
    insert_raw(&mut result, "ready_at", config.get("ready_at"));
    result.insert("ready".into(), Value::Bool(ledger.value >= js::number(config.get("ready_at"))));
    result.insert("stranger_stage".into(), Value::String(ledger.stranger.stage.clone()));
    result.insert("history".into(), full["history"].clone());
    result.insert("informants".into(), full["informants"].clone());
    Some(Value::Object(result))
}

/// `scenarioStrangerStage(state)`: какой шаг сцены незнакомца сейчас уместен —
/// `arrive`, `reveal` или `None`. Обе стадии — только вне боя, в месте из
/// списка незнакомца.
pub fn scenario_stranger_stage(state: &Value) -> Option<&'static str> {
    let config = attention_config(state)?;
    let mechanics = state.get("mechanics");
    if js::truthy(prop(prop(mechanics, "combat"), "active")) {
        return None;
    }
    let status = prop(prop(mechanics, "campaign_lifecycle"), "status");
    if js::truthy(status) && !is_str(status, "active") {
        return None;
    }
    let location_id = scenario_location_id(state);
    if !array(prop(config.get("stranger"), "location_ids")).iter().any(|entry| is_str(Some(entry), &location_id)) {
        return None;
    }
    let ledger = ScenarioAttentionState::normalize(state.get("scenario_attention"));
    match ledger.stranger.stage.as_str() {
        "none" => (ledger.value >= js::number(config.get("stranger_at"))).then_some("arrive"),
        "arrived" => (ledger.stranger.party_acted && ledger.stranger.location_id == location_id).then_some("reveal"),
        _ => None,
    }
}

/// `scenarioStrangerNpcId(state)`: id NPC-незнакомца сценария или пустая строка.
pub fn scenario_stranger_npc_id(state: &Value) -> String {
    clean(prop(attention_config(state).and_then(|config| config.get("stranger")), "npc_id"), 120)
}

/// `[...list]` для массива; иначе пусто.
fn copy_list(value: Option<&Value>) -> Value {
    Value::Array(array(value).to_vec())
}

/// `scenarioStrangerProfile(state, { available })` — профиль незнакомца для
/// `UpsertNpcSocialProfile`. Цели и убеждения ведут социального контроллера —
/// он играет путника, а не дракона, и себя не называет.
pub fn scenario_stranger_profile(state: &Value, available: bool) -> Option<Value> {
    let stranger = attention_config(state)?.get("stranger").filter(|stranger| js::truthy(Some(stranger)))?;
    let ledger = ScenarioAttentionState::normalize(state.get("scenario_attention"));
    let location_id = if available || ledger.stranger.location_id.is_empty() { scenario_location_id(state) } else { ledger.stranger.location_id.clone() };
    let scene_location = clean(prop(state.get("scene"), "location"), 180);
    let location = if available {
        scene_location
    } else {
        let npc = array(prop(state.get("social"), "npcs")).iter().find(|npc| strict_eq(prop(Some(npc), "id"), stranger.get("npc_id")));
        let own = clean(prop(npc, "location"), 180);
        if own.is_empty() {
            scene_location
        } else {
            own
        }
    };
    let mut profile = Map::new();
    insert_raw(&mut profile, "id", stranger.get("npc_id"));
    insert_raw(&mut profile, "name", stranger.get("name"));
    insert_raw(&mut profile, "role", stranger.get("role"));
    profile.insert("location".into(), Value::String(location));
    profile.insert("location_id".into(), Value::String(location_id));
    insert_raw(&mut profile, "public_summary", stranger.get("summary"));
    insert_raw(&mut profile, "voice", stranger.get("voice"));
    profile.insert("goals".into(), copy_list(stranger.get("goals")));
    profile.insert("beliefs".into(), copy_list(stranger.get("beliefs")));
    profile.insert("known_fact_ids".into(), json!([]));
    profile.insert("visibility".into(), json!("party"));
    profile.insert("available".into(), Value::Bool(available));
    profile.insert("tags".into(), json!(["scenario-stranger"]));
    profile.insert("schedule".into(), json!([]));
    profile.insert("inventory".into(), json!([]));
    Some(Value::Object(profile))
}

/// `scenarioStrangerBreath(state)` — выдох незнакомца из данных сценария:
/// `{ expression, ability, dc, damage_type }`.
pub fn scenario_stranger_breath(state: &Value) -> Option<Value> {
    let breath = prop(attention_config(state).and_then(|config| config.get("stranger")), "breath").filter(|breath| js::truthy(Some(breath)))?;
    let mut result = Map::new();
    for key in ["expression", "ability", "dc", "damage_type"] {
        insert_raw(&mut result, key, prop(Some(breath), key));
    }
    Some(Value::Object(result))
}

/// Родительный падеж характеристики спасброска.
fn ability_genitive(key: &str) -> Option<&'static str> {
    Some(match key {
        "str" => "Силы",
        "dex" => "Ловкости",
        "con" => "Телосложения",
        "int" => "Интеллекта",
        "wis" => "Мудрости",
        "cha" => "Харизмы",
        _ => return None,
    })
}

/// Творительный падеж типа урона.
fn damage_instrumental(key: &str) -> Option<&'static str> {
    Some(match key {
        "fire" => "огнём",
        "cold" => "холодом",
        "acid" => "кислотой",
        "lightning" => "молнией",
        "poison" => "ядом",
        "thunder" => "звуком",
        "necrotic" => "некротической энергией",
        "radiant" => "излучением",
        "force" => "силовым полем",
        "psychic" => "психической энергией",
        _ => return None,
    })
}

/// `String(value?.[0] ?? '')`: первый элемент массива или первая единица
/// строки.
fn first_target(event: Option<&Value>) -> String {
    match prop(event, "target_ids") {
        Some(Value::Array(items)) => js::s(items.first()),
        Some(Value::String(text)) => text.chars().next().map(String::from).unwrap_or_default(),
        _ => String::new(),
    }
}

/// `scenarioStrangerNarration(events, state)` — текст шага сцены незнакомца
/// для ленты: авторский текст сценария и итог выдоха по каждому герою из уже
/// записанных событий. Пустая строка — среди событий нет шага незнакомца.
/// Чисел не выдумывает: всё берётся из бросков. `events` — `None`, если JS
/// получил бы не массив.
pub fn scenario_stranger_narration(events: Option<&Value>, state: &Value) -> String {
    let Some(stranger) = attention_config(state).and_then(|config| config.get("stranger")).filter(|stranger| js::truthy(Some(stranger))) else {
        return String::new();
    };
    let events = array(events);
    let Some(staged) = events.iter().find(|event| is_str(prop(Some(event), "event_type"), SCENARIO_STRANGER_EVENT)) else {
        return String::new();
    };
    let staged_payload = prop(Some(staged), "payload");
    if is_str(prop(staged_payload, "stage"), "arrived") {
        return clean(stranger.get("arrival_text"), 1_000);
    }
    let breath = nullish(prop(staged_payload, "breath"), stranger.get("breath"));
    let players = array(state.get("players"));
    let hero_name = |hero_id: &str| {
        let hero = players.iter().find(|player| js::string(prop(Some(player), "id")) == hero_id);
        let character = prop(hero, "character");
        let name = clean(if js::truthy(character) { character } else { prop(hero, "name") }, 80);
        if name.is_empty() {
            "Герой".to_string()
        } else {
            name
        }
    };
    let from_stranger = |event: &&Value| is_str(prop(prop(Some(event), "payload"), "source"), "scenario-stranger");
    let ability = prop(breath, "ability");
    let ability_name = ability_genitive(&js::string(ability)).map_or_else(|| js::string(ability), String::from);
    let damage_name = damage_instrumental(&js::string(prop(breath, "damage_type"))).unwrap_or("");
    let dc = js::string(prop(breath, "dc"));
    let mut lines = vec![clean(stranger.get("reveal_text"), 1_000)];
    for save in events.iter().filter(|event| is_str(prop(Some(event), "event_type"), "SavingThrowResolved")).filter(from_stranger) {
        let hero_id = first_target(Some(save));
        let damage = events
            .iter()
            .filter(|event| is_str(prop(Some(event), "event_type"), "DamageApplied"))
            .filter(from_stranger)
            .find(|event| first_target(Some(event)) == hero_id);
        let amount = integer(prop(prop(damage, "payload"), "applied_amount"), 0).max(0);
        let save_payload = prop(Some(save), "payload");
        let total = integer_or_nan(prop(save_payload, "total")).map(|total| format!(" {total}")).unwrap_or_default();
        let verdict = if js::truthy(prop(save_payload, "saved")) { "успех" } else { "провал" };
        let line = format!("{}: спасбросок {ability_name}{total} против СЛ {dc} — {verdict}, {amount} урона {damage_name}.", hero_name(&hero_id));
        lines.push(line.replacen(" .", ".", 1));
    }
    lines.push(clean(stranger.get("departure_text"), 1_000));
    lines.retain(|line| !line.is_empty());
    lines.join(" ")
}

/// Бой финала по счёту внимания (`scenarioFinaleTactics`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScenarioFinaleTactics {
    /// `ready` — дракон готов; `unaware` — не ждёт отряд.
    pub readiness: &'static str,
    /// `none` — внезапности нет ни у кого; `enemies` — враги застигнуты.
    pub surprise: &'static str,
    /// Засада слуг готового дракона (`{ theme, difficulty }` сценария).
    pub ambush: Option<Value>,
    pub reason: &'static str,
}

impl ScenarioFinaleTactics {
    pub fn to_value(&self) -> Value {
        json!({ "readiness": self.readiness, "surprise": self.surprise, "ambush": self.ambush, "reason": self.reason })
    }
}

/// `scenarioFinaleTactics(state, enemyIds)` — бой финала по счёту внимания.
/// Только для встречи с главным противником в его логове; `None` — обычные
/// правила внезапности и обычная сборка. `enemy_ids` — уже `String(id)`.
///
/// - `ready` — дракон готов: к нему добавляется засада, внезапности нет ни у
///   кого, даже у прокравшегося отряда;
/// - `unaware` — дракон не ждёт: счёт ниже `unaware_below` или отряд пришёл
///   тайным ходом (`hidden_route`); сторона противника застигнута врасплох.
pub fn scenario_finale_tactics(state: &Value, enemy_ids: &[String]) -> Option<ScenarioFinaleTactics> {
    let scenario = campaign_scenario(state)?;
    let config = scenario.get("attention");
    let finale = array(scenario.get("beats")).iter().find(|beat| is_str(beat.get("kind"), "finale"));
    let finale_config = prop(config, "finale").filter(|finale| js::truthy(Some(finale)))?;
    let boss = prop(finale, "boss").filter(|boss| js::truthy(Some(boss)))?;
    if !matches!(boss.get("npc_id"), Some(Value::String(npc_id)) if enemy_ids.contains(npc_id)) {
        return None;
    }
    let boss_location = boss.get("location_id");
    let here = scenario_location_id(state);
    if !is_str(boss_location, &here) {
        return None;
    }
    if scenario_attention_ready_for(state, Some(scenario)) {
        let ambush = match finale_config.get("ready_ambush") {
            Some(Value::Object(map)) => Value::Object(map.clone()),
            _ => json!({}),
        };
        return Some(ScenarioFinaleTactics { readiness: "ready", surprise: "none", ambush: Some(ambush), reason: "attention-ready" });
    }
    let ledger = ScenarioAttentionState::normalize(state.get("scenario_attention"));
    let route = array(finale_config.get("hidden_route"));
    let on_route = |value: Option<&Value>| route.iter().take(2).any(|entry| strict_eq(Some(entry), value)) || (route.len() < 2 && value.is_none());
    let came_from = scenario_previous_location_id(state);
    let hidden_entry = !came_from.is_empty() && on_route(Some(&Value::String(came_from))) && on_route(boss_location);
    if hidden_entry {
        return Some(ScenarioFinaleTactics { readiness: "unaware", surprise: "enemies", ambush: None, reason: "hidden-route" });
    }
    if ledger.value < js::number(finale_config.get("unaware_below")) {
        return Some(ScenarioFinaleTactics { readiness: "unaware", surprise: "enemies", ambush: None, reason: "attention-low" });
    }
    None
}

/// `{ action: … }` — намерение, узнанное в тексте.
fn action(name: &str) -> Value {
    json!({ "action": name })
}

/// `scenarioTreatyActionFromText(value, state)` — предложение договора главному
/// противнику в тексте игрока: «предлагаю Саргату договор», «убеждаю дракона
/// уйти с равнин». Только узнаёт намерение; правду, ранение и СЛ проверяет
/// Rules Engine. С состоянием узнаётся только в логове: в деревне «будет ли мир
/// с драконом?» — вопрос жителю, а не переговоры. `state` — `None` у JS `null`.
pub fn scenario_treaty_action_from_text(value: &str, state: Option<&Value>) -> Option<Value> {
    if let Some(state) = state.filter(|state| js::truthy(Some(state))) {
        let rules = scenario_treaty_rules(state)?;
        if !is_str(rules.get("boss_location_id"), &scenario_location_id(state)) {
            return None;
        }
    }
    let text = folded(Some(&Value::String(value.to_string())));
    // Порядок слов не важен: «предлагаю Саргату договор» и «договор с драконом».
    let words = re!(
        r"(?<![\p{L}\p{M}])(?:договор\p{L}*|договарива\p{L}*|договорит\p{L}*|мир(?:а|ом|у)?|перемири\p{L}*|сделк\p{L}*|уговор\p{L}*|уговарива\p{L}*|убежда\p{L}*|переговор\p{L}*|виру|вира)(?![\p{L}\p{M}])",
        "iu"
    );
    let partner = re!(r"(?<![\p{L}\p{M}])(?:дракон\p{L}*|саргат\p{L}*)(?![\p{L}\p{M}])", "iu");
    (!text.is_empty() && text::test(words, &text) && text::test(partner, &text)).then(|| action("treaty"))
}

/// Глаголы решения по осведомителю в порядке проверки.
fn informant_choice(text: &str) -> Option<&'static str> {
    let verbs: [(&str, &Regex); 3] = [
        (
            "turn",
            re!(
                r"(?<![\p{L}\p{M}])(?:перевербов\p{L}*|переманив\p{L}*|перемани\p{L}*|склоня\p{L}*\s+на\s+нашу|работать\s+на\s+нас|шли\p{L}*\s+дракону\s+ложь|ложн\p{L}*\s+вест\p{L}*)",
                "iu"
            ),
        ),
        ("expose", re!(r"(?<![\p{L}\p{M}])(?:выда\p{L}*|сда\p{L}*|арестов\p{L}*|разоблач\p{L}*|страж\p{L}*)", "iu")),
        ("release", re!(r"(?<![\p{L}\p{M}])(?:отпуска\p{L}*|отпуст\p{L}*|отпущ\p{L}*|пощад\p{L}*|пусть\s+уход\p{L}*)", "iu")),
    ];
    verbs.iter().find(|(_, pattern)| text::test(pattern, text)).map(|(choice, _)| *choice)
}

/// `scenarioInformantActionFromText(value, informants)` — «выдаём Тобана
/// страже», «перевербовываю перевозчика», «отпускаем мельника»: решение по
/// осведомителю. Узнаёт его по основам имени (`name_stems`); раскрыт ли он,
/// место и «одно решение» проверяет Rules Engine.
pub fn scenario_informant_action_from_text(value: &str, informants: &[Value]) -> Option<Value> {
    let text = folded(Some(&Value::String(value.to_string())));
    if text.is_empty() {
        return None;
    }
    let words = words(&text);
    let informant = informants.iter().find(|entry| any_stem(array(prop(Some(entry), "name_stems")), &words))?;
    let choice = informant_choice(&text)?;
    let mut result = Map::new();
    result.insert("action".into(), json!("informant"));
    insert_raw(&mut result, "informant_id", prop(Some(informant), "id"));
    result.insert("choice".into(), json!(choice));
    Some(Value::Object(result))
}

/// Основы слов названия вещи: «плащ защиты» → «плащ», «защит».
fn name_stems(name: Option<&Value>) -> Vec<String> {
    let folded = text::lower(&clean(name, 160)).replace('ё', "е");
    let spaced = text::replace_all(re!(r"\+\d", "gu"), &folded, " ");
    text::find_all(re!(r"[\p{L}\d]+", "u"), &spaced)
        .into_iter()
        .filter(|word| utf16_len(word) >= 3)
        .map(|word| {
            let length = utf16_len(&word);
            head_utf16(&word, 3.max(length.saturating_sub(2)))
        })
        .collect()
}

/// `scenarioArmoryActionFromText(value, choices)` — «беру плащ защиты из
/// оружейной»: выбрать вещь в королевской оружейной. Узнаёт вещь по словам её
/// названия (`choices` — `{ catalog_id, name }`); место, «раз на героя» и сам
/// список проверяет Rules Engine. Вещь не узнана — `catalog_id: null`.
pub fn scenario_armory_action_from_text(value: &str, choices: &[Value]) -> Option<Value> {
    let text = folded(Some(&Value::String(value.to_string())));
    let place = re!(r"(?<![\p{L}\p{M}])(?:оружейн\p{L}*|арсенал\p{L}*|кладов\p{L}*\s+корол\p{L}*)", "iu");
    let take = re!(
        r"(?<![\p{L}\p{M}])(?:бер[уём]\p{L}*|возьм\p{L}*|выбира\p{L}*|выбер\p{L}*|забира\p{L}*|забер\p{L}*|взять|получ\p{L}*)(?![\p{L}\p{M}])",
        "iu"
    );
    if text.is_empty() || !text::test(place, &text) || !text::test(take, &text) {
        return None;
    }
    let mut scored: Vec<(&Value, usize, usize)> = choices
        .iter()
        .map(|choice| {
            let stems = name_stems(prop(Some(choice), "name"));
            let hits = stems.iter().filter(|stem| text.contains(stem.as_str())).count();
            (choice, hits, stems.len())
        })
        .filter(|(_, hits, _)| *hits > 0)
        .collect();
    let ratio = |hits: usize, size: usize| hits as f64 / size as f64;
    scored.sort_by(|left, right| {
        ratio(right.1, right.2).partial_cmp(&ratio(left.1, left.2)).unwrap_or(std::cmp::Ordering::Equal).then(right.1.cmp(&left.1))
    });
    let catalog_id = scored.first().and_then(|(choice, _, _)| nullish(prop(Some(choice), "catalog_id"), None)).cloned().unwrap_or(Value::Null);
    Some(json!({ "action": "armory", "catalog_id": catalog_id }))
}

/// `scenarioPurseActionFromText(value)` — «берём кошель короля»: получить
/// жалованье от короля в начале похода. Место и «раз на героя» проверяет
/// Rules Engine.
pub fn scenario_purse_action_from_text(value: &str) -> Option<Value> {
    let text = folded(Some(&Value::String(value.to_string())));
    let purse = re!(
        r"(?<![\p{L}\p{M}])(?:кошел\p{L}*|кошёл\p{L}*|жалованье|жалование|плат[аыу]|золото)(?![\p{L}\p{M}])[^.!?]{0,40}(?:корол|арес|казн)|(?:корол|арес|казн)\p{L}*[^.!?]{0,40}(?<![\p{L}\p{M}])(?:кошел\p{L}*|кошёл\p{L}*)",
        "iu"
    );
    (!text.is_empty() && text::test(purse, &text)).then(|| action("purse"))
}

/// Двор короля для одного героя-зрителя (`scenarioCourtForViewer`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScenarioCourt {
    pub purse_available: bool,
    pub armory_available: bool,
    pub armory_items: Vec<String>,
}

/// `scenarioCourtForViewer(state, { playerId })` — ждёт ли героя-зрителя здесь
/// кошель и вещь из оружейной. Реестр `scenario_attention` в проекцию не идёт
/// целиком (в нём счёт внимания), а без этой карточки игрок не узнавал, что при
/// дворе есть что взять. Карточка несёт только то, что герой и так услышал бы
/// при дворе. `player_id` — уже `String(playerId ?? '')`.
pub fn scenario_court_for_viewer(state: &Value, player_id: &str) -> Option<ScenarioCourt> {
    let purse = scenario_purse_rules(state);
    let armory = scenario_armory_rules(state);
    if purse.is_none() && armory.is_none() {
        return None;
    }
    let here = scenario_location_id(state);
    let ledger = ScenarioAttentionState::normalize(state.get("scenario_attention"));
    let hero_id = player_id.to_string();
    let armory_here = armory.as_ref().is_some_and(|armory| is_str(armory.get("location_id"), &here))
        && !hero_id.is_empty()
        && !ledger.armory_taken.contains(&hero_id);
    let purse_available = purse.as_ref().is_some_and(|purse| is_str(purse.get("location_id"), &here))
        && !hero_id.is_empty()
        && !ledger.purse_paid.contains(&hero_id);
    let armory_items = match (&armory, armory_here) {
        (Some(armory), true) => array(armory.get("catalog_ids"))
            .iter()
            .map(|id| clean(catalog_item(&js::s(Some(id))).and_then(|item| item.get("name")), 80))
            .filter(|name| !name.is_empty())
            .collect(),
        _ => Vec::new(),
    };
    Some(ScenarioCourt { purse_available, armory_available: armory_here, armory_items })
}

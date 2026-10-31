//! Перенос `server/scenario-knight.mjs`: проклятый рыцарь сценария — Дуннахан
//! Каэлан в Асстохане (`docs/astohan-scenario.md`, линия Б).
//!
//! Рыцарь появляется только в своё окно ночи (с 23:00 до 01:00 по часам мира,
//! `sk_world_time::weather`) и только при отряде в его месте. Профиль заводится
//! недоступным при создании кампании; доступным его делает Rules Engine по
//! плану [`scenario_knight_presence_plan`]. Посреди боя присутствие не
//! меняется.
//!
//! Загадка — реестр `scenario_knight`, свёртка журнала
//! ([`apply_scenario_knight_event`]): до возвращения головы рыцарь неуязвим
//! ([`scenario_knight_ward`]) и наводит ужас ([`scenario_knight_dread_for`]);
//! голову ставит `ReturnKnightHead`, мирный путь — `ReleaseCursedKnight`.
//!
//! Модуль — лист графа: читает состояние и сценарий, Rules Engine не знает.

use serde_json::{json, Map, Value};
use sk_core::{js, re, text};
use sk_scenario::campaign_scenario::{campaign_scenario, scenario_clue_fact_id, scenario_location_id};
use sk_world_time::weather::{clock_minute_of, CAMPAIGN_START_MINUTE_OF_DAY};

use crate::support::{array, clean, index0, is_str, path, prop, strict_eq};

pub const SCENARIO_KNIGHT_PRESENCE_EVENT: &str = "ScenarioKnightPresenceChanged";
pub const SCENARIO_KNIGHT_PRESENCE_EVENT_SCHEMA_VERSION: i64 = 1;
pub const SCENARIO_KNIGHT_SCHEMA_VERSION: i64 = 1;
pub const SCENARIO_KNIGHT_COMMAND_TYPES: [&str; 2] = ["ReturnKnightHead", "ReleaseCursedKnight"];
pub const SCENARIO_KNIGHT_HEAD_EVENT: &str = "ScenarioKnightHeadReturned";
pub const SCENARIO_KNIGHT_RELEASED_EVENT: &str = "ScenarioKnightReleased";
pub const SCENARIO_KNIGHT_RELEASE_FAILED_EVENT: &str = "ScenarioKnightReleaseFailed";
/// Источник спасброска ужаса в `SavingThrowResolved`.
pub const SCENARIO_KNIGHT_DREAD_SOURCE: &str = "scenario-knight-dread";
const MINUTES_PER_DAY: f64 = 1_440.0;
const LIST_LIMIT: usize = 100;

/// Поля профиля, которые принимает `UpsertNpcSocialProfile`.
const PROFILE_FIELDS: [&str; 18] = [
    "id", "name", "role", "location", "location_id", "public_summary", "voice", "speech_profile", "goals", "beliefs",
    "known_fact_ids", "social_dcs", "visibility", "reveal_on_presence", "available", "tags", "schedule", "inventory",
];

/// `campaignScenario(state)?.knight ?? null`.
fn knight_config(state: &Value) -> Option<&'static Value> {
    campaign_scenario(state)?.get("knight").filter(|config| !config.is_null())
}

/// `String(config.npc_id)` — у рыцаря каталога это всегда строка.
fn npc_id_of(config: &Value) -> String {
    js::string(config.get("npc_id"))
}

/// `state?.social?.npcs` → профиль с `id === npcId`.
fn stored_profile<'a>(state: &'a Value, config: &Value) -> Option<&'a Value> {
    let npc_id = config.get("npc_id");
    array(path(Some(state), &["social", "npcs"])).iter().find(|npc| strict_eq(prop(Some(npc), "id"), npc_id))
}

/// Ночные гости сценария мира: их профиль при создании кампании недоступен.
pub fn scenario_night_visitor_ids(scenario: Option<&Value>) -> Vec<String> {
    let npc_id = path(scenario, &["knight", "npc_id"]);
    if js::truthy(npc_id) {
        vec![js::string(npc_id)]
    } else {
        Vec::new()
    }
}

/// Что рыцарь носит с собой с начала кампании: награда упокоения лежит у него
/// в латах (npc id → catalog ids). Мирный путь отдаёт её из рук, павший в бою
/// рыцарь оставляет её в своём контейнере.
pub fn scenario_knight_starting_inventory(scenario: Option<&Value>) -> Value {
    let npc_id = js::s(path(scenario, &["knight", "npc_id"]));
    let catalog_id = js::s(path(scenario, &["knight", "release", "reward", "catalog_id"]));
    let mut result = Map::new();
    if !npc_id.is_empty() && !catalog_id.is_empty() {
        result.insert(npc_id, json!([catalog_id]));
    }
    Value::Object(result)
}

/// Минута суток в окне `[from, to)`; окно может переходить через полночь.
/// Границы окна приводятся `Number()` (в каталоге это числа).
pub fn minute_in_window(minute: f64, window: &Value) -> bool {
    let from = js::number(window.get("from_minute"));
    let to = js::number(window.get("to_minute"));
    if from <= to {
        minute >= from && minute < to
    } else {
        minute >= from || minute < to
    }
}

/// Должен ли рыцарь сейчас быть при отряде: окно ночи, место, жив.
pub fn scenario_knight_should_be_present(state: &Value) -> bool {
    let Some(config) = knight_config(state) else {
        return false;
    };
    let npc_id = npc_id_of(config);
    let vitals = path(Some(state), &["npc_world", "vitals"]).and_then(|vitals| prop(Some(vitals), &npc_id));
    if js::is_false(prop(vitals, "alive")) {
        return false;
    }
    if normalize_scenario_knight_state(state.get("scenario_knight")).released {
        return false;
    }
    if !is_str(config.get("location_id"), &scenario_location_id(state)) {
        return false;
    }
    let elapsed = path(Some(state), &["mechanics", "world_time", "elapsed_minutes"]);
    let night = config.get("night").cloned().unwrap_or(Value::Null);
    minute_in_window(clock_minute_of(elapsed) as f64, &night)
}

/// Что сделать с профилем рыцаря после хода времени или перехода сцены.
/// `None` — менять нечего (или идёт бой). Иначе —
/// `{ npc_id, present, profile, location_id, text }`: профиль для
/// `UpsertNpcSocialProfile` и, если отряд это видит, текст прихода или ухода.
pub fn scenario_knight_presence_plan(state: &Value) -> Option<Value> {
    let config = knight_config(state)?;
    if js::truthy(path(Some(state), &["mechanics", "combat", "active"])) {
        return None;
    }
    let stored = stored_profile(state, config)?;
    let present = !js::is_false(stored.get("available"));
    let should_be = scenario_knight_should_be_present(state);
    if present == should_be {
        return None;
    }
    let mut profile = Map::new();
    for field in PROFILE_FIELDS {
        if let Some(value) = stored.get(field) {
            profile.insert(field.to_string(), value.clone());
        }
    }
    profile.insert("available".into(), Value::Bool(should_be));
    // Уход виден, только если отряд при нём; ушедший без свидетелей рыцарь
    // просто перестаёт быть доступным.
    let witnessed = is_str(config.get("location_id"), &scenario_location_id(state));
    let text = if witnessed {
        clean(config.get(if should_be { "arrival_text" } else { "departure_text" }), 1_000)
    } else {
        String::new()
    };
    let mut plan = Map::new();
    insert_raw(&mut plan, "npc_id", config.get("npc_id"));
    plan.insert("present".into(), Value::Bool(should_be));
    plan.insert("profile".into(), Value::Object(profile));
    insert_raw(&mut plan, "location_id", config.get("location_id"));
    plan.insert("text".into(), Value::String(text));
    Some(Value::Object(plan))
}

fn insert_raw(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value.clone());
    }
}

// ---------------------------------------------------------------------------
// Загадка: реестр, защита, ужас и мирный путь

/// Реестр загадки (`ScenarioKnightState`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScenarioKnightState {
    pub schema_version: i64,
    pub head_returned: bool,
    pub head_returned_by: String,
    pub released: bool,
    pub released_by: String,
    pub attempts: Vec<String>,
    pub dread_resisted: Vec<String>,
}

impl ScenarioKnightState {
    /// Форма JSON, как в JS (тот же порядок ключей).
    pub fn to_json(&self) -> Value {
        json!({
            "schema_version": self.schema_version,
            "head_returned": self.head_returned,
            "head_returned_by": self.head_returned_by,
            "released": self.released,
            "released_by": self.released_by,
            "attempts": self.attempts,
            "dread_resisted": self.dread_resisted,
        })
    }
}

/// Последние `LIST_LIMIT` элементов (`list.slice(-LIST_LIMIT)`).
fn keep_tail(mut list: Vec<String>) -> Vec<String> {
    if list.len() > LIST_LIMIT {
        list.drain(..list.len() - LIST_LIMIT);
    }
    list
}

/// `normalizeScenarioKnightState(input = {})`.
pub fn normalize_scenario_knight_state(input: Option<&Value>) -> ScenarioKnightState {
    let value = input.filter(|value| value.is_object());
    let list = |key: &str| {
        keep_tail(
            array(prop(value, key))
                .iter()
                .map(|entry| clean(Some(entry), 200))
                .filter(|entry| !entry.is_empty())
                .collect(),
        )
    };
    ScenarioKnightState {
        schema_version: SCENARIO_KNIGHT_SCHEMA_VERSION,
        head_returned: js::is_true(prop(value, "head_returned")),
        head_returned_by: clean(prop(value, "head_returned_by"), 120),
        released: js::is_true(prop(value, "released")),
        released_by: clean(prop(value, "released_by"), 120),
        attempts: list("attempts"),
        dread_resisted: list("dread_resisted"),
    }
}

/// `Math.trunc(Number(x) || 0)` строкой шаблона JS.
fn night_text(value: Option<&Value>) -> String {
    let number = js::number(value);
    let number = if number.is_nan() || number == 0.0 { 0.0 } else { number };
    js::f64_string(number.trunc())
}

/// Номер ночи: ночь тянется через полночь, поэтому сутки отсчитываются от
/// полудня. «Одна попытка за ночь» и «выдержал ужас этой ночью» — по нему.
pub fn scenario_night_index(state: &Value) -> f64 {
    let raw = js::number(path(Some(state), &["mechanics", "world_time", "elapsed_minutes"]));
    let raw = if raw.is_nan() { 0.0 } else { raw };
    let elapsed = raw.trunc().max(0.0);
    ((CAMPAIGN_START_MINUTE_OF_DAY as f64 + elapsed + MINUTES_PER_DAY / 2.0) / MINUTES_PER_DAY).floor()
}

/// Свёртка события в реестр рыцаря; вызывается редьюсером после применения.
pub fn apply_scenario_knight_event(ledger_input: Option<&Value>, event: Option<&Value>, state: &Value) -> ScenarioKnightState {
    let mut ledger = normalize_scenario_knight_state(ledger_input);
    if knight_config(state).is_none() || !js::truthy(event) {
        return ledger;
    }
    let payload = event.and_then(|event| prop(Some(event), "payload")).filter(|payload| !payload.is_null());
    let event_type = js::s(prop(event, "event_type"));
    let actor = || clean(prop(event, "actor_id"), 120);
    if event_type == SCENARIO_KNIGHT_HEAD_EVENT {
        ledger.head_returned = true;
        ledger.head_returned_by = actor();
        return ledger;
    }
    if event_type == SCENARIO_KNIGHT_RELEASED_EVENT {
        ledger.released = true;
        ledger.released_by = actor();
        return ledger;
    }
    if event_type == SCENARIO_KNIGHT_RELEASE_FAILED_EVENT {
        let entry = format!("{}:{}", actor(), night_text(prop(payload, "night")));
        ledger.attempts.push(entry);
        ledger.attempts = keep_tail(ledger.attempts);
        return ledger;
    }
    if event_type == "SavingThrowResolved" && is_str(prop(payload, "source"), SCENARIO_KNIGHT_DREAD_SOURCE) && js::is_true(prop(payload, "saved")) {
        let hero_id = clean(index0(prop(event, "target_ids")).as_ref(), 120);
        if !hero_id.is_empty() {
            ledger.dread_resisted.push(format!("{hero_id}:{}", night_text(prop(payload, "night"))));
            ledger.dread_resisted = keep_tail(ledger.dread_resisted);
        }
    }
    ledger
}

/// Состояние загадки для проверок и тестов: `{ npc_id, ...реестр }`.
pub fn scenario_knight_state(state: &Value) -> Option<Value> {
    let config = knight_config(state)?;
    let mut result = Map::new();
    result.insert("npc_id".into(), Value::String(npc_id_of(config)));
    if let Value::Object(ledger) = normalize_scenario_knight_state(state.get("scenario_knight")).to_json() {
        result.extend(ledger);
    }
    Some(Value::Object(result))
}

/// Нашёл ли отряд разгадку (тайну часовни).
pub fn scenario_knight_riddle_solved(state: &Value) -> bool {
    let Some(scenario) = campaign_scenario(state) else {
        return false;
    };
    let Some(config) = scenario.get("knight").filter(|config| js::truthy(Some(config))) else {
        return false;
    };
    let id = scenario_clue_fact_id(scenario, &js::string(config.get("riddle_clue")));
    array(path(Some(state), &["worldMemory", "facts"]))
        .iter()
        .any(|fact| is_str(prop(Some(fact), "predicate"), "discovery") && is_str(prop(Some(fact), "supersedes_fact_id"), &id))
}

/// Рыцарь сейчас в сцене при отряде (его профиль доступен).
pub fn scenario_knight_present(state: &Value) -> bool {
    let Some(config) = knight_config(state) else {
        return false;
    };
    if !is_str(config.get("location_id"), &scenario_location_id(state)) {
        return false;
    }
    stored_profile(state, config).is_some_and(|profile| !js::is_false(profile.get("available")))
}

/// Защита рыцаря от урона: до возвращения головы — `{ kind: 'immune', laugh }`,
/// после — `{ kind: 'resist', except }` (сопротивление всему, кроме силового).
/// `None` — цель не рыцарь или защиты нет. `target_id` — `String(targetId)`,
/// `None` — параметр по умолчанию `''`.
pub fn scenario_knight_ward(state: &Value, target_id: Option<&Value>) -> Option<Value> {
    let config = knight_config(state)?;
    let target = target_id.map_or_else(String::new, |id| js::string(Some(id)));
    if !is_str(config.get("npc_id"), &target) {
        return None;
    }
    let ledger = normalize_scenario_knight_state(state.get("scenario_knight"));
    if ledger.released {
        return None;
    }
    Some(if ledger.head_returned {
        json!({ "kind": "resist", "except": array(config.get("ward_resist_except")) })
    } else {
        json!({ "kind": "immune", "laugh": clean(config.get("ward_laugh_text"), 600) })
    })
}

/// Ужас в начале хода героя: рыцарь в бою, голова не возвращена, герой в
/// радиусе и этой ночью ещё не выдержал. Расстояние считает Rules Engine.
/// Итог — `{ source_id, ability, dc, night }`.
pub fn scenario_knight_dread_for(state: &Value, hero_id: Option<&Value>, distance_feet: Option<f64>) -> Option<Value> {
    let config = knight_config(state)?;
    if !js::truthy(path(Some(state), &["mechanics", "combat", "active"])) {
        return None;
    }
    let ledger = normalize_scenario_knight_state(state.get("scenario_knight"));
    if ledger.head_returned || ledger.released {
        return None;
    }
    let hero = hero_id.map_or_else(String::new, |id| js::string(Some(id)));
    if !array(state.get("partyMemberIds")).iter().any(|member| js::string(Some(member)) == hero) {
        return None;
    }
    let radius = js::number(path(Some(config), &["dread", "radius_feet"]));
    // `distanceFeet == null || !Number.isFinite(distanceFeet) || distanceFeet > radius`.
    if !distance_feet.is_some_and(|distance| distance.is_finite() && !(distance > radius)) {
        return None;
    }
    let night = scenario_night_index(state);
    if ledger.dread_resisted.contains(&format!("{hero}:{}", js::f64_string(night))) {
        return None;
    }
    Some(json!({
        "source_id": npc_id_of(config),
        "ability": js::string(path(Some(config), &["dread", "ability"])),
        "dc": js::num(js::number(path(Some(config), &["dread", "dc"]))),
        "night": js::num(night),
    }))
}

/// Данные загадки для Rules Engine: досягаемость, тексты, мирный путь.
pub fn scenario_knight_rules(state: &Value) -> Option<Value> {
    let config = knight_config(state)?;
    let release = config.get("release");
    let skills: Vec<String> = array(prop(release, "skills")).iter().map(|skill| js::string(Some(skill))).collect();
    Some(json!({
        "npc_id": npc_id_of(config),
        "head_reach_feet": js::num(js::number(config.get("head_reach_feet"))),
        "head_text": clean(config.get("head_text"), 1_000),
        "release": {
            "dc": js::num(js::number(prop(release, "dc"))),
            "skills": skills,
            "reward": { "catalog_id": clean(path(release, &["reward", "catalog_id"]), 120) },
            "success_text": clean(prop(release, "success_text"), 1_000),
            "failure_text": clean(prop(release, "failure_text"), 1_000),
        },
    }))
}

/// Действие с рыцарем в тексте игрока.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KnightAction {
    /// «ставлю голову перед рыцарем» — `ReturnKnightHead`.
    ReturnHead,
    /// `ReleaseCursedKnight` с навыком `persuasion` или `religion`.
    Release { skill: &'static str },
}

impl KnightAction {
    /// Форма JSON, как в JS.
    pub fn to_json(self) -> Value {
        match self {
            Self::ReturnHead => json!({ "action": "return_head" }),
            Self::Release { skill } => json!({ "action": "release", "skill": skill }),
        }
    }
}

/// Действие с рыцарем в тексте игрока: «ставлю голову перед рыцарем»,
/// «молюсь об упокоении Каэлана» (Религия), «убеждаю рыцаря обрести покой»
/// (Убеждение). Только узнаёт намерение: допустимость проверяет Rules Engine.
pub fn scenario_knight_action_from_text(value: Option<&Value>) -> Option<KnightAction> {
    let head = re!(r"(?<![\p{L}\p{M}])(?:возвра\p{L}*|верн\p{L}*|став\p{L}*|постав\p{L}*|клад\p{L}*|полож\p{L}*|отда\p{L}*|протяг\p{L}*|прино\p{L}*|подаю|водружа\p{L}*)(?![\p{L}\p{M}])[^.!?]{0,60}(?<![\p{L}\p{M}])голов", "iu");
    let release = re!(r"(?<![\p{L}\p{M}])(?:упоко\p{L}*|освобо\p{L}*|отпуска\p{L}*|отпусти\p{L}*|убежда\p{L}*|уговарива\p{L}*|молюсь|молитв\p{L}*|благослов\p{L}*)(?![\p{L}\p{M}])[^.!?]{0,80}(?:рыцар|каэлан|дуннахан|всадник|страж|покой|проклят|клятв)", "iu");
    let religion = re!(r"(?:молитв|молюсь|молю|бог|свят|обряд|благослов|упоко|отпева|религи)", "iu");
    let lowered = text::lower(&clean(value, 1_000)).replace('ё', "е");
    if lowered.is_empty() {
        return None;
    }
    if text::test(head, &lowered) {
        return Some(KnightAction::ReturnHead);
    }
    if text::test(release, &lowered) {
        let skill = if text::test(religion, &lowered) { "religion" } else { "persuasion" };
        return Some(KnightAction::Release { skill });
    }
    None
}

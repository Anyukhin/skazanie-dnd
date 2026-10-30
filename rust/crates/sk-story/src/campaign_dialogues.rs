//! Перенос `server/campaign-dialogues.mjs` — авторские диалоги кампании:
//! разговор с вариантами ответа, как в BG3.
//!
//! Данные — `data/campaign-dialogues-v1.json`. Диалог привязан к собеседнику
//! сценария (`npc_id`) и к сценарию (`scenario_id`): в кампании без сценария
//! диалогов нет. У варианта бывают условия показа (`requires`), группа
//! «один вопрос на героя» (`group`), проверка навыка (`check`) с исходами
//! `success`/`failure`, флаги (`sets`), тайна (`reveal`/`reveal_topic`),
//! сюжетная команда (`action`) и конец разговора (`ends`).
//!
//! Модуль — лист: читает состояние и данные, событий не создаёт. Команду и
//! события исполняет Rules Engine; прогресс разговора (флаги и попытки) — в
//! состоянии, его пишет редьюсер (`apply_dialogue_event`).

use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::content::{self, ContentError, ContentResult};
use sk_core::indexmap::IndexSet;
use sk_core::{js, text};
use sk_scenario::campaign_scenario::{campaign_scenario, scenario_clue_fact_id, scenario_found_clue_ids, scenario_informant_rules, scenario_location_id, scenario_treaty_rules};
use crate::support::{head_utf16, utf16_len, PROTOTYPE_KEYS};
use sk_world_story::scenario_knight::{scenario_knight_riddle_solved, scenario_knight_state, scenario_night_index};

pub const DIALOGUES_SCHEMA_VERSION: i64 = 1;
/// Команда игрока: выбрать вариант разговора.
pub const DIALOGUE_COMMAND_TYPE: &str = "ChooseDialogueOption";
/// Событие выбранного варианта: ответ собеседника и прогресс разговора.
pub const DIALOGUE_EVENT: &str = "DialogueOptionChosen";
/// Провенанс: авторский диалог — политика проекта, а не правило редакции.
pub const DIALOGUE_POLICY_ID: &str = "skazanie:authored-dialogue-v1";

const DIALOGUES_SOURCE: &str = include_str!("../../../../data/campaign-dialogues-v1.json");
const DIALOGUE_SKILLS: [&str; 9] = ["persuasion", "deception", "intimidation", "insight", "history", "religion", "arcana", "performance", "medicine"];
const DIALOGUE_ACTIONS: [&str; 6] = ["ReceiveScenarioPurse", "ChooseScenarioArmoryItem", "ReturnKnightHead", "ReleaseCursedKnight", "ResolveScenarioInformant", "NegotiateScenarioTreaty"];
const INFORMANT_CHOICES: [&str; 3] = ["expose", "release", "turn"];

/// Исход варианта (у варианта без проверки — он же `success`).
#[derive(Clone, Debug, PartialEq)]
pub struct DialogueOutcome {
    pub reply: String,
    pub sets: Vec<String>,
    /// Тайна сценария по id.
    pub reveal: String,
    /// Тайна исходной ситуации по теме.
    pub reveal_topic: String,
}

impl DialogueOutcome {
    pub fn to_json(&self) -> Value {
        json!({ "reply": self.reply, "sets": self.sets, "reveal": self.reveal, "reveal_topic": self.reveal_topic })
    }
}

/// Условия показа варианта.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct DialogueRequires {
    pub flags: Vec<String>,
    pub flags_none: Vec<String>,
    pub clues_any: Vec<String>,
    pub clues_all: Vec<String>,
}

/// Проверка навыка варианта.
#[derive(Clone, Debug, PartialEq)]
pub struct DialogueCheck {
    pub skill: String,
    pub dc: f64,
}

impl DialogueCheck {
    pub fn to_json(&self) -> Value {
        json!({ "skill": self.skill, "dc": js::num(self.dc) })
    }
}

/// Сюжетная команда варианта.
#[derive(Clone, Debug, PartialEq)]
pub struct DialogueAction {
    pub command_type: String,
    pub catalog_id: Option<String>,
    pub informant_id: Option<String>,
    pub choice: Option<String>,
}

impl DialogueAction {
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("command_type".into(), Value::String(self.command_type.clone()));
        if let Some(catalog_id) = &self.catalog_id {
            map.insert("catalog_id".into(), Value::String(catalog_id.clone()));
        }
        if let Some(informant_id) = &self.informant_id {
            map.insert("informant_id".into(), Value::String(informant_id.clone()));
            map.insert("choice".into(), Value::String(self.choice.clone().unwrap_or_default()));
        }
        Value::Object(map)
    }
}

/// Вариант разговора.
#[derive(Clone, Debug, PartialEq)]
pub struct DialogueOption {
    pub id: String,
    pub label: String,
    pub requires: DialogueRequires,
    pub group: String,
    pub check: Option<DialogueCheck>,
    /// Исход без проверки — тоже здесь.
    pub success: DialogueOutcome,
    pub failure: Option<DialogueOutcome>,
    pub action: Option<DialogueAction>,
    pub ends: bool,
}

impl DialogueOption {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "label": self.label,
            "requires": {
                "flags": self.requires.flags,
                "flags_none": self.requires.flags_none,
                "clues_any": self.requires.clues_any,
                "clues_all": self.requires.clues_all,
            },
            "group": self.group,
            "check": self.check.as_ref().map_or(Value::Null, DialogueCheck::to_json),
            "success": self.success.to_json(),
            "failure": self.failure.as_ref().map_or(Value::Null, DialogueOutcome::to_json),
            "action": self.action.as_ref().map_or(Value::Null, DialogueAction::to_json),
            "ends": self.ends,
        })
    }
}

/// Диалог собеседника сценария.
#[derive(Clone, Debug, PartialEq)]
pub struct Dialogue {
    pub id: String,
    pub scenario_id: String,
    pub npc_id: String,
    pub greeting: String,
    pub options: Vec<DialogueOption>,
}

impl Dialogue {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "scenario_id": self.scenario_id,
            "npc_id": self.npc_id,
            "greeting": self.greeting,
            "options": self.options.iter().map(DialogueOption::to_json).collect::<Vec<_>>(),
        })
    }
}

/// Бросает ли команда проверку сама: тогда вариант задаёт навык, а исход — её
/// бросок. Упокоение рыцаря, договор и перевербовка осведомителя.
pub fn dialogue_action_checks(action: &DialogueAction) -> bool {
    action.command_type == "ReleaseCursedKnight"
        || action.command_type == "NegotiateScenarioTreaty"
        || (action.command_type == "ResolveScenarioInformant" && action.choice.as_deref() == Some("turn"))
}

/// `String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maximum)`.
fn clean(value: Option<&Value>, maximum: usize) -> String {
    head_utf16(&text::squash_spaces(&js::s(value)), maximum)
}

/// `/^[a-z0-9][a-z0-9-]{0,79}$/u`.
fn id_ok(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_lowercase() || first.is_ascii_digit())
        && utf16_len(value) <= 80
        && chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
}

fn invalid<T>(message: String) -> Result<T, String> {
    Err(format!("Диалоги кампании: {message}"))
}

fn field<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|value| value.get(key))
}

fn ids(value: Option<&Value>, place: &str) -> Result<Vec<String>, String> {
    if !js::present(value) {
        return Ok(Vec::new());
    }
    let Some(Value::Array(items)) = value else {
        return invalid(format!("{place}: ожидается список"));
    };
    items
        .iter()
        .map(|entry| {
            let id = clean(Some(entry), 80);
            if id_ok(&id) {
                Ok(id)
            } else {
                invalid(format!("{place}: id «{id}»"))
            }
        })
        .collect()
}

fn outcome(raw: Option<&Value>, place: &str) -> Result<DialogueOutcome, String> {
    let reply = clean(field(raw, "reply"), 1_200);
    if reply.is_empty() {
        return invalid(format!("{place}: нет ответа"));
    }
    let reveal = if js::present(field(raw, "reveal")) { clean(field(raw, "reveal"), 80) } else { String::new() };
    if !reveal.is_empty() && !id_ok(&reveal) {
        return invalid(format!("{place}: тайна «{reveal}»"));
    }
    let reveal_topic = if js::present(field(raw, "reveal_topic")) { clean(field(raw, "reveal_topic"), 200) } else { String::new() };
    if !reveal.is_empty() && !reveal_topic.is_empty() {
        return invalid(format!("{place}: одна тайна на исход — reveal или reveal_topic"));
    }
    Ok(DialogueOutcome { reply, sets: ids(field(raw, "sets"), &format!("{place}.sets"))?, reveal, reveal_topic })
}

fn option(raw: Option<&Value>, place: &str) -> Result<DialogueOption, String> {
    let id = clean(field(raw, "id"), 80);
    if !id_ok(&id) {
        return invalid(format!("{place}: id варианта «{id}»"));
    }
    let label = clean(field(raw, "label"), 200);
    if label.is_empty() {
        return invalid(format!("{place}.{id}: нет реплики героя"));
    }
    let requires_raw = field(raw, "requires");
    let requires = DialogueRequires {
        flags: ids(field(requires_raw, "flags"), &format!("{place}.{id}.requires.flags"))?,
        flags_none: ids(field(requires_raw, "flags_none"), &format!("{place}.{id}.requires.flags_none"))?,
        clues_any: ids(field(requires_raw, "clues_any"), &format!("{place}.{id}.requires.clues_any"))?,
        clues_all: ids(field(requires_raw, "clues_all"), &format!("{place}.{id}.requires.clues_all"))?,
    };
    let mut check = None;
    let check_raw = field(raw, "check");
    if js::present(check_raw) {
        let skill = clean(field(check_raw, "skill"), 40);
        let dc = js::number(field(check_raw, "dc"));
        if !DIALOGUE_SKILLS.contains(&skill.as_str()) {
            return invalid(format!("{place}.{id}: навык «{skill}»"));
        }
        if !(dc.is_finite() && dc.trunc() == dc) || !(5.0..=30.0).contains(&dc) {
            return invalid(format!("{place}.{id}: СЛ {}", js::string(field(check_raw, "dc"))));
        }
        check = Some(DialogueCheck { skill, dc });
    }
    let success_raw = field(raw, "success");
    let failure_raw = field(raw, "failure");
    if check.is_some() && (!js::truthy(success_raw) || !js::truthy(failure_raw)) {
        return invalid(format!("{place}.{id}: у проверки нужны success и failure"));
    }
    if check.is_none() && (js::truthy(success_raw) || js::truthy(failure_raw)) {
        return invalid(format!("{place}.{id}: success/failure — только у проверки"));
    }
    let success = if check.is_some() { outcome(success_raw, &format!("{place}.{id}.success"))? } else { outcome(raw, &format!("{place}.{id}"))? };
    let failure = if check.is_some() { Some(outcome(failure_raw, &format!("{place}.{id}.failure"))?) } else { None };
    let mut action = None;
    let action_raw = field(raw, "action");
    if js::present(action_raw) {
        let command_type = clean(field(action_raw, "command_type"), 60);
        if !DIALOGUE_ACTIONS.contains(&command_type.as_str()) {
            return invalid(format!("{place}.{id}: команда «{command_type}»"));
        }
        let catalog_id = clean(field(action_raw, "catalog_id"), 120);
        if command_type == "ChooseScenarioArmoryItem" && catalog_id.is_empty() {
            return invalid(format!("{place}.{id}: не указан предмет оружейной"));
        }
        let informant = command_type == "ResolveScenarioInformant";
        let informant_id = if informant { clean(field(action_raw, "informant_id"), 80) } else { String::new() };
        let choice = if informant { clean(field(action_raw, "choice"), 20) } else { String::new() };
        if informant && (!id_ok(&informant_id) || !INFORMANT_CHOICES.contains(&choice.as_str())) {
            return invalid(format!("{place}.{id}: осведомитель «{informant_id}» и решение «{choice}»"));
        }
        let built = DialogueAction {
            command_type: command_type.clone(),
            catalog_id: (!catalog_id.is_empty()).then_some(catalog_id),
            choice: (!informant_id.is_empty()).then_some(choice),
            informant_id: (!informant_id.is_empty()).then_some(informant_id),
        };
        if dialogue_action_checks(&built) && check.is_none() {
            return invalid(format!("{place}.{id}: команда «{command_type}» бросает проверку — нужен check с навыком"));
        }
        if !dialogue_action_checks(&built) && check.is_some() {
            return invalid(format!("{place}.{id}: команда и проверка в одном варианте не поддержаны"));
        }
        action = Some(built);
    }
    let group = if js::present(field(raw, "group")) { clean(field(raw, "group"), 80) } else { String::new() };
    if !group.is_empty() && !id_ok(&group) {
        return invalid(format!("{place}.{id}: группа «{group}»"));
    }
    Ok(DialogueOption { id, label, requires, group, check, success, failure, action, ends: js::is_true(field(raw, "ends")) })
}

/// Проверяет каталог диалогов. Ошибка данных — `Err` при загрузке: сломанный
/// диалог не должен всплыть посреди вечера.
pub fn normalize_dialogues(raw: &Value) -> Result<Vec<Dialogue>, String> {
    let version = raw.get("schema_version");
    if !version.and_then(Value::as_f64).is_some_and(|number| number == DIALOGUES_SCHEMA_VERSION as f64) {
        return invalid(format!("schema_version {}", js::string(version)));
    }
    let Some(Value::Array(entries)) = raw.get("dialogues") else {
        return invalid("нет списка dialogues".into());
    };
    let mut seen = IndexSet::new();
    let mut dialogues = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        let id = clean(entry.get("id"), 80);
        if !id_ok(&id) || seen.contains(&id) {
            return invalid(format!("диалог {index}: id «{id}»"));
        }
        seen.insert(id.clone());
        let scenario_id = clean(entry.get("scenario_id"), 80);
        let npc_id = clean(entry.get("npc_id"), 80);
        if !id_ok(&scenario_id) || !id_ok(&npc_id) {
            return invalid(format!("{id}: scenario_id и npc_id обязательны"));
        }
        let greeting = clean(entry.get("greeting"), 1_200);
        if greeting.is_empty() {
            return invalid(format!("{id}: нет приветствия"));
        }
        let raw_options = match entry.get("options") {
            Some(Value::Array(items)) if !items.is_empty() => items,
            _ => return invalid(format!("{id}: нет вариантов")),
        };
        let options = raw_options.iter().map(|item| option(Some(item), &id)).collect::<Result<Vec<_>, _>>()?;
        let mut option_ids = IndexSet::new();
        for item in &options {
            if !option_ids.insert(item.id.clone()) {
                return invalid(format!("{id}: вариант «{}» повторяется", item.id));
            }
        }
        dialogues.push(Dialogue { id, scenario_id, npc_id, greeting, options });
    }
    // Флаги общие для всех разговоров сценария: требуемый флаг должен ставить
    // хотя бы один вариант какого-нибудь диалога того же сценария.
    for dialogue in &dialogues {
        let set_flags: IndexSet<&str> = dialogues
            .iter()
            .filter(|entry| entry.scenario_id == dialogue.scenario_id)
            .flat_map(|entry| entry.options.iter())
            .flat_map(|item| item.success.sets.iter().chain(item.failure.iter().flat_map(|failure| failure.sets.iter())))
            .map(String::as_str)
            .collect();
        for item in &dialogue.options {
            for flag in item.requires.flags.iter().chain(&item.requires.flags_none) {
                if !set_flags.contains(flag.as_str()) {
                    return invalid(format!("{}.{}: флаг «{flag}» никто не ставит", dialogue.id, item.id));
                }
            }
        }
    }
    Ok(dialogues)
}

/// Путь каталога диалогов от корня репозитория.
pub const DIALOGUES_FILE: &str = "data/campaign-dialogues-v1.json";

/// Разбор и проверка каталога диалогов из текста (для тестов — сломанные копии).
pub fn parse_dialogue_catalog(text: &str) -> ContentResult<Vec<Dialogue>> {
    normalize_dialogues(&content::parse_json(DIALOGUES_FILE, text)?).map_err(|message| ContentError::new(DIALOGUES_FILE, message))
}

static PARSED: LazyLock<ContentResult<Vec<Dialogue>>> = LazyLock::new(|| parse_dialogue_catalog(DIALOGUES_SOURCE));

/// Проверка встроенного каталога диалогов (сервер зовёт её до приёма запросов).
pub fn check_dialogue_catalog() -> ContentResult<()> {
    PARSED.as_ref().map(|_| ()).map_err(Clone::clone)
}

/// Каталог диалогов (`data/campaign-dialogues-v1.json`). Данные поставляются
/// вместе с сервером: сломанный каталог — ошибка сборки, её ловит проверка
/// при старте сервера ([`check_dialogue_catalog`]), а не первый разговор.
pub static DIALOGUES: LazyLock<&'static [Dialogue]> = LazyLock::new(|| match &*PARSED {
    Ok(dialogues) => dialogues,
    Err(error) => panic!("{error}"),
});

/// Диалог собеседника в этой кампании или `None`: только у кампании со
/// сценарием, к которому он написан.
pub fn dialogue_for(state: &Value, npc_id: Option<&Value>) -> Option<&'static Dialogue> {
    let scenario = campaign_scenario(state);
    let id = clean(npc_id, 120);
    let scenario = scenario?;
    if id.is_empty() {
        return None;
    }
    let scenario_id = scenario.get("id");
    DIALOGUES.iter().find(|entry| scenario_id.and_then(Value::as_str) == Some(entry.scenario_id.as_str()) && entry.npc_id == id)
}

/// Прогресс разговора в состоянии: флаги отряда и попытки героев. Пишет его
/// только редьюсер по событию `DialogueOptionChosen`.
#[derive(Clone, Debug, PartialEq)]
pub struct DialogueProgress {
    pub flags: Vec<String>,
    /// `{ [option_id]: hero_id[] }` — как лежит в состоянии (объект или массив).
    pub chosen: Value,
    pub attempted: Value,
}

impl DialogueProgress {
    pub fn to_json(&self) -> Value {
        json!({ "flags": self.flags, "chosen": self.chosen, "attempted": self.attempted })
    }
}

/// Свойство объекта по ключу: у массива и строки строковых ключей нет.
fn prop<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match value {
        Some(Value::Object(map)) => map.get(key),
        _ => None,
    }
}

fn is_object_like(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Object(_)) | Some(Value::Array(_)))
}

pub fn dialogue_progress(state: &Value, dialogue_id: &str) -> DialogueProgress {
    let entry = prop(prop(Some(state), "dialogues"), dialogue_id);
    let flags = match prop(entry, "flags") {
        Some(Value::Array(items)) => items.iter().map(|flag| js::string(Some(flag))).collect(),
        _ => Vec::new(),
    };
    let object_or_empty = |key: &str| {
        let value = prop(entry, key);
        if js::truthy(value) && is_object_like(value) {
            value.cloned().unwrap_or_else(js::obj)
        } else {
            js::obj()
        }
    };
    DialogueProgress { flags, chosen: object_or_empty("chosen"), attempted: object_or_empty("attempted") }
}

/// `Object.values(registry)` для объекта или массива.
fn registry_values(state: &Value) -> Vec<&Value> {
    match state.get("dialogues") {
        Some(Value::Object(map)) => js::entries(map).into_iter().map(|(_, value)| value).collect(),
        Some(Value::Array(items)) => items.iter().collect(),
        _ => Vec::new(),
    }
}

fn registry_strings(state: &Value, key: &str) -> IndexSet<String> {
    registry_values(state)
        .into_iter()
        .flat_map(|entry| match prop(Some(entry), key) {
            Some(Value::Array(items)) => items.iter().map(|item| js::string(Some(item))).collect::<Vec<_>>(),
            _ => Vec::new(),
        })
        .collect()
}

/// Флаги отряда по всем разговорам кампании.
pub fn dialogue_flags(state: &Value) -> IndexSet<String> {
    registry_strings(state, "flags")
}

fn world_facts(state: &Value) -> &[Value] {
    match prop(prop(Some(state), "worldMemory"), "facts") {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

/// Факт тайны сценария по её id, если он есть в памяти мира.
fn fact_id_by_reveal(state: &Value, reveal: &str) -> String {
    let fact_id = campaign_scenario(state).map(|scenario| scenario_clue_fact_id(scenario, reveal)).unwrap_or_default();
    if !fact_id.is_empty() && world_facts(state).iter().any(|fact| prop(Some(fact), "id").and_then(Value::as_str) == Some(fact_id.as_str())) {
        fact_id
    } else {
        String::new()
    }
}

/// Факт памяти мира, который раскрывает исход: тайна сценария по id или тайна
/// исходной ситуации по теме. Пустая строка — раскрывать нечего или такой
/// тайны в этой кампании нет.
pub fn dialogue_reveal_fact_id(state: &Value, result: Option<&Value>) -> String {
    let reveal = field(result, "reveal");
    if js::truthy(reveal) {
        return fact_id_by_reveal(state, &js::string(reveal));
    }
    let topic = field(result, "reveal_topic");
    if js::truthy(topic) {
        // `clean(result.reveal_topic)` может дать пустую тему из пробелов:
        // тогда совпадает факт с пустой темой, как в JS.
        return fact_id_by_topic(state, &clean(topic, 200));
    }
    String::new()
}

fn fact_id_by_topic(state: &Value, topic: &str) -> String {
    world_facts(state)
        .iter()
        .find(|entry| {
            if prop(Some(entry), "predicate").and_then(Value::as_str) != Some("gm_secret") {
                return false;
            }
            let object = prop(Some(entry), "object");
            let source = if js::present(object) { js::s(object) } else { "{}".to_string() };
            serde_json::from_str::<Value>(&source).is_ok_and(|parsed| clean(prop(Some(&parsed), "topic"), 200) == topic)
        })
        .map(|fact| js::string(prop(Some(fact), "id")))
        .unwrap_or_default()
}

/// То же для исхода из каталога.
pub fn dialogue_outcome_fact_id(state: &Value, result: &DialogueOutcome) -> String {
    if !result.reveal.is_empty() {
        return fact_id_by_reveal(state, &result.reveal);
    }
    if !result.reveal_topic.is_empty() {
        return fact_id_by_topic(state, &clean(Some(&Value::String(result.reveal_topic.clone())), 200));
    }
    String::new()
}

/// Тайны, награду за которые уже выдал разговор: находка той же тайны поиском
/// второй предмет не выдаёт.
pub fn dialogue_granted_fact_ids(state: &Value) -> IndexSet<String> {
    registry_strings(state, "granted")
}

/// Знает ли отряд этот факт: его рассказали (журнал знания) или нашли поиском.
fn fact_known_to_party(state: &Value, fact_id: &str) -> bool {
    if fact_id.is_empty() {
        return false;
    }
    let memory = prop(Some(state), "worldMemory");
    let revealed = match prop(memory, "knowledge_revealed") {
        Some(Value::Array(items)) => items.as_slice(),
        _ => &[],
    };
    revealed.iter().any(|entry| js::string(prop(Some(entry), "fact_id")) == fact_id)
        || world_facts(state)
            .iter()
            .any(|fact| prop(Some(fact), "predicate").and_then(Value::as_str) == Some("discovery") && js::s(prop(Some(fact), "supersedes_fact_id")) == fact_id)
}

/// Выполнены ли условия показа варианта.
pub fn dialogue_option_unlocked(state: &Value, _dialogue: &Dialogue, item: &DialogueOption) -> bool {
    let flags = dialogue_flags(state);
    let clues = scenario_found_clue_ids(state);
    if !item.requires.flags.iter().all(|flag| flags.contains(flag)) {
        return false;
    }
    if item.requires.flags_none.iter().any(|flag| flags.contains(flag)) {
        return false;
    }
    if !item.requires.clues_all.is_empty() && !item.requires.clues_all.iter().all(|clue| clues.contains(clue)) {
        return false;
    }
    if !item.requires.clues_any.is_empty() && !item.requires.clues_any.iter().any(|clue| clues.contains(clue)) {
        return false;
    }
    true
}

/// `(list ?? []).includes(needle)`: у массива — строгое равенство строке, у
/// строки — подстрока, как в JS. Иное (число, объект) в JS бросает
/// `TypeError`; здесь — «нет».
fn js_includes(list: Option<&Value>, needle: &str) -> bool {
    match list {
        Some(Value::Array(items)) => items.iter().any(|item| item.as_str() == Some(needle)),
        Some(Value::String(text)) => text.contains(needle),
        _ => false,
    }
}

/// `(list ?? []).length > 0`.
fn js_nonempty(list: Option<&Value>) -> bool {
    match list {
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::String(text)) => !text.is_empty(),
        _ => false,
    }
}

fn heroes_of<'a>(map: &'a Value, option_id: &str) -> Option<&'a Value> {
    prop(Some(map), option_id)
}

fn strings_include(list: Option<&Value>, needle: &str) -> bool {
    match list {
        Some(Value::Array(items)) => items.iter().any(|item| js::string(Some(item)) == needle),
        _ => false,
    }
}

/// Открыта ли сюжетная команда варианта для героя. Кошель и вещь оружейной —
/// раз на героя; команды рыцаря — по его правилам: вариант не обещает того,
/// от чего команда откажет.
fn dialogue_action_open(state: &Value, item: &DialogueOption, hero: &str, progress: &DialogueProgress) -> bool {
    let action = item.action.as_ref();
    let kind = action.map(|action| action.command_type.as_str());
    let attention = prop(Some(state), "scenario_attention");
    if kind == Some("ReturnKnightHead") || kind == Some("ReleaseCursedKnight") {
        let Some(knight) = scenario_knight_state(state) else {
            return false;
        };
        if js::truthy(knight.get("released")) {
            return false;
        }
        let head_returned = js::truthy(knight.get("head_returned"));
        if kind == Some("ReturnKnightHead") {
            return !head_returned && scenario_knight_riddle_solved(state);
        }
        let attempt = format!("{hero}:{}", js::f64_string(scenario_night_index(state)));
        return head_returned && !js_includes(knight.get("attempts"), &attempt);
    }
    if kind == Some("ResolveScenarioInformant") {
        let wanted = action.and_then(|action| action.informant_id.as_deref());
        let informants = scenario_informant_rules(state);
        let Some(informant) = informants.iter().find(|entry| entry.get("id").and_then(Value::as_str) == wanted) else {
            return false;
        };
        let informant_id = js::s(informant.get("id"));
        if !js::truthy(informant.get("revealed")) || Some(scenario_location_id(state).as_str()) != informant.get("location_id").and_then(Value::as_str) {
            return false;
        }
        if js::truthy(prop(prop(attention, "informants"), &informant_id)) {
            return false;
        }
        let turn_failed = prop(attention, "informant_turn_failed").filter(|value| !value.is_null());
        return !(action.and_then(|action| action.choice.as_deref()) == Some("turn") && js_includes(turn_failed, &informant_id));
    }
    if kind == Some("NegotiateScenarioTreaty") {
        let Some(rules) = scenario_treaty_rules(state) else {
            return false;
        };
        if js::truthy(rules.get("concluded"))
            || !js::truthy(rules.get("truth_revealed"))
            || Some(scenario_location_id(state).as_str()) != rules.get("boss_location_id").and_then(Value::as_str)
        {
            return false;
        }
        return !strings_include(prop(prop(attention, "treaty"), "attempts"), hero);
    }
    // Кошель и вещь оружейной — раз на героя, каким бы путём он их ни взял:
    // фразой, другим вариантом или этим.
    let taken = match kind {
        Some("ReceiveScenarioPurse") => prop(attention, "purse_paid"),
        Some("ChooseScenarioArmoryItem") => prop(attention, "armory_taken"),
        _ => None,
    };
    if strings_include(taken, hero) {
        return false;
    }
    !js_includes(heroes_of(&progress.chosen, &item.id), hero)
}

/// Варианты, которые видит герой: открытые условием и ещё не исчерпанные.
/// Проверку герой пробует один раз; вариант с открытой тайной после её
/// раскрытия не нужен; сюжетная команда после исполнения этим героем — тоже.
/// Уже заданный вопрос остаётся, но помечен `asked`, как серый пункт в BG3.
///
/// `{ greeting, options: [{ id, label, check?, asked, ends }] }` или `None`.
pub fn dialogue_options_for(state: &Value, npc_id: Option<&Value>, hero_id: Option<&Value>) -> Option<Value> {
    let dialogue = dialogue_for(state, npc_id)?;
    let hero = clean(hero_id, 120);
    let progress = dialogue_progress(state, &dialogue.id);
    let chosen_by_hero = |option_id: &str| js_includes(heroes_of(&progress.chosen, option_id), &hero);
    let options: Vec<Value> = dialogue
        .options
        .iter()
        .filter(|item| dialogue_option_unlocked(state, dialogue, item))
        .filter(|item| !(item.check.is_some() && item.action.is_none() && js_includes(heroes_of(&progress.attempted, &item.id), &hero)))
        // Из группы герой выбирает один вариант: остальные для него закрыты.
        .filter(|item| {
            !(!item.group.is_empty()
                && dialogue.options.iter().any(|other| other.group == item.group && other.id != item.id && chosen_by_hero(&other.id)))
        })
        // Рассказанное второй раз не спрашивают: тайну успеха отряд уже знает.
        .filter(|item| !fact_known_to_party(state, &dialogue_outcome_fact_id(state, &item.success)))
        .filter(|item| item.action.is_none() || dialogue_action_open(state, item, &hero, &progress))
        .map(|item| {
            let mut entry = Map::new();
            entry.insert("id".into(), Value::String(item.id.clone()));
            entry.insert("label".into(), Value::String(item.label.clone()));
            if let Some(check) = &item.check {
                entry.insert("check".into(), check.to_json());
            }
            entry.insert("asked".into(), Value::Bool(js_nonempty(heroes_of(&progress.chosen, &item.id))));
            entry.insert("ends".into(), Value::Bool(item.ends));
            Value::Object(entry)
        })
        .collect();
    Some(json!({ "greeting": dialogue.greeting, "options": options }))
}

/// `[...new Set(list.map(clean).filter(Boolean))]`.
fn clean_unique(value: Option<&Value>, maximum: usize) -> Vec<Value> {
    let mut seen = IndexSet::new();
    if let Some(Value::Array(items)) = value {
        for item in items {
            let text = clean(Some(item), maximum);
            if !text.is_empty() {
                seen.insert(text);
            }
        }
    }
    seen.into_iter().map(Value::String).collect()
}

fn hero_lists(value: Option<&Value>) -> Value {
    let mut result = Map::new();
    if let Some(Value::Object(map)) = value {
        for (key, heroes) in js::entries(map) {
            let key = clean(Some(&Value::String(key.clone())), 80);
            if !key.is_empty() {
                result.insert(key, Value::Array(clean_unique(Some(heroes), 120)));
            }
        }
    }
    Value::Object(result)
}

/// Реестр разговоров в состоянии: `{ [dialogue_id]: { flags, chosen, attempted, granted } }`.
/// Выводится из журнала событием `DialogueOptionChosen`, поэтому replay сходится.
pub fn normalize_dialogue_state(value: Option<&Value>) -> Value {
    let mut result = Map::new();
    let Some(Value::Object(map)) = value else {
        return Value::Object(result);
    };
    for (dialogue_id, entry) in js::entries(map) {
        let id = clean(Some(&Value::String(dialogue_id.clone())), 80);
        // `result['__proto__'] = …` в JS меняет прототип, а не заводит ключ.
        if id.is_empty() || id == "__proto__" || !is_object_like(Some(entry)) {
            continue;
        }
        let entry = Some(entry);
        result.insert(
            id,
            json!({
                "flags": clean_unique(prop(entry, "flags"), 80),
                "chosen": hero_lists(prop(entry, "chosen")),
                "attempted": hero_lists(prop(entry, "attempted")),
                "granted": clean_unique(prop(entry, "granted"), 200),
            }),
        );
    }
    Value::Object(result)
}

/// `[...new Set([...list, ...extra])]` над строками.
fn union(list: Option<&Value>, extra: impl IntoIterator<Item = String>) -> Value {
    let mut seen: IndexSet<String> = match list {
        Some(Value::Array(items)) => items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect(),
        _ => IndexSet::new(),
    };
    seen.extend(extra);
    Value::Array(seen.into_iter().map(Value::String).collect())
}

/// Свёртка события выбранного варианта: флаги отряда, кто выбирал вариант и
/// кто уже пробовал его проверку.
pub fn apply_dialogue_event(value: Option<&Value>, event: Option<&Value>) -> Value {
    let mut state = normalize_dialogue_state(value);
    if field(event, "event_type").and_then(Value::as_str) != Some(DIALOGUE_EVENT) {
        return state;
    }
    let payload = field(event, "payload").filter(|payload| !payload.is_null());
    let dialogue_id = clean(field(payload, "dialogue_id"), 80);
    let option_id = clean(field(payload, "option_id"), 80);
    let hero = clean(field(payload, "hero_id"), 120);
    if dialogue_id.is_empty() || option_id.is_empty() || hero.is_empty() {
        return state;
    }
    let Value::Object(registry) = &mut state else {
        return state;
    };
    // Ключ прототипа (`constructor`, `__proto__`) без своей записи JS находит у
    // `Object.prototype`, и свёртка падает `TypeError`; здесь реестр остаётся
    // прежним.
    let inherited = |map: Option<&Value>, key: &str| PROTOTYPE_KEYS.contains(&key) && !matches!(map, Some(Value::Object(map)) if map.contains_key(key));
    if PROTOTYPE_KEYS.contains(&dialogue_id.as_str()) && !registry.contains_key(&dialogue_id) {
        return state;
    }
    if let Some(existing) = registry.get(&dialogue_id) {
        if inherited(existing.get("chosen"), &option_id) || (js::truthy(field(payload, "check")) && inherited(existing.get("attempted"), &option_id)) {
            return state;
        }
    } else if PROTOTYPE_KEYS.contains(&option_id.as_str()) {
        return state;
    }
    let entry = registry
        .get(&dialogue_id)
        .cloned()
        .unwrap_or_else(|| json!({ "flags": [], "chosen": {}, "attempted": {}, "granted": [] }));
    let granted = clean(field(payload, "granted_fact_id"), 200);
    let sets: Vec<String> = match field(payload, "sets") {
        Some(Value::Array(items)) => items.iter().map(|flag| clean(Some(flag), 80)).filter(|flag| !flag.is_empty()).collect(),
        _ => Vec::new(),
    };
    let with_hero = |map: Option<&Value>| {
        let mut map = match map {
            Some(Value::Object(map)) => map.clone(),
            _ => Map::new(),
        };
        let heroes = union(map.get(&option_id), [hero.clone()]);
        map.insert(option_id.clone(), heroes);
        Value::Object(map)
    };
    let chosen = with_hero(entry.get("chosen"));
    let attempted = if js::truthy(field(payload, "check")) { with_hero(entry.get("attempted")) } else { entry.get("attempted").cloned().unwrap_or_else(js::obj) };
    let granted = if granted.is_empty() { entry.get("granted").cloned().unwrap_or_else(|| json!([])) } else { union(entry.get("granted"), [granted]) };
    registry.insert(
        dialogue_id,
        json!({
            "flags": union(entry.get("flags"), sets),
            "chosen": chosen,
            "attempted": attempted,
            "granted": granted,
        }),
    );
    state
}

/// Разговоры сцены для зрителя: у каких собеседников здесь есть авторский
/// диалог и какие варианты видит его герой. Вне боя и только у тех, кто стоит
/// в сцене и виден отряду. Сам реестр разговоров (`dialogues`) наружу не идёт.
pub fn scene_dialogues_for_viewer(state: &Value, player_id: Option<&Value>) -> Value {
    let mut result = Map::new();
    let combat_active = js::truthy(prop(prop(prop(Some(state), "mechanics"), "combat"), "active"));
    if combat_active || campaign_scenario(state).is_none() {
        return Value::Object(result);
    }
    let place = |value: Option<&Value>| text::lower(&clean(value, 180));
    let here = place(prop(prop(Some(state), "scene"), "location"));
    let npcs = match prop(prop(Some(state), "social"), "npcs") {
        Some(Value::Array(items)) => items.as_slice(),
        _ => &[],
    };
    let vitals = prop(prop(Some(state), "npc_world"), "vitals");
    for npc in npcs {
        if !js::truthy(Some(npc)) || js::is_false(prop(Some(npc), "available")) || place(prop(Some(npc), "location")) != here {
            continue;
        }
        // Закрытый собеседник виден отряду, пока стоит в сцене (`reveal_on_presence`,
        // как в `npcSocialForViewer`): рыцарь в полночь.
        let visibility = prop(Some(npc), "visibility");
        if js::truthy(visibility) && !["party", "public"].contains(&js::string(visibility).as_str()) && !js::is_true(prop(Some(npc), "reveal_on_presence")) {
            continue;
        }
        let id = js::string(prop(Some(npc), "id"));
        if js::is_false(prop(prop(vitals, &id), "alive")) {
            continue;
        }
        if let Some(view) = dialogue_options_for(state, prop(Some(npc), "id"), player_id) {
            result.insert(id, view);
        }
    }
    Value::Object(result)
}

const CHECK_SKILL_LABELS: [(&str, &str); 9] = [
    ("persuasion", "Убеждение"),
    ("deception", "Обман"),
    ("intimidation", "Запугивание"),
    ("insight", "Проницательность"),
    ("history", "История"),
    ("religion", "Религия"),
    ("arcana", "Магия"),
    ("performance", "Выступление"),
    ("medicine", "Медицина"),
];

/// Строка летописи об исходе проверки в разговоре — та же форма, что у
/// свободной реплики собеседнику («Проверка «Убеждение»: успех (19).»).
pub fn dialogue_check_line(check: Option<&Value>) -> String {
    if !js::truthy(check) {
        return String::new();
    }
    let skill = clean(field(check, "skill"), 40);
    let label = CHECK_SKILL_LABELS
        .iter()
        .find(|(key, _)| *key == skill)
        .map(|(_, label)| (*label).to_string())
        .unwrap_or_else(|| skill.clone());
    let total = js::number(field(check, "total"));
    let outcome = if js::is_true(field(check, "success")) { "успех" } else { "провал" };
    let total = if total.is_finite() { format!(" ({})", js::f64_string(total)) } else { String::new() };
    format!("Проверка «{label}»: {outcome}{total}.")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Урок 7: опечатка в ключевом поле копии каталога — отказ, который
    /// называет файл и диалог.
    #[test]
    fn broken_copy_names_file_and_dialogue() {
        assert_eq!(check_dialogue_catalog(), Ok(()));
        let mut raw: Value = serde_json::from_str(DIALOGUES_SOURCE).expect("каталог");
        let dialogue = raw["dialogues"][1].as_object_mut().expect("диалог");
        let id = js::s(dialogue.get("id"));
        let npc = dialogue.shift_remove("npc_id").expect("npc_id");
        dialogue.insert("npcid".into(), npc);
        let error = parse_dialogue_catalog(&raw.to_string()).err().map(|error| error.to_string());
        assert_eq!(error, Some(format!("data/campaign-dialogues-v1.json: Диалоги кампании: {id}: scenario_id и npc_id обязательны")));
    }

    fn base() -> Value {
        json!({ "schema_version": 1, "dialogues": [{ "id": "d", "scenario_id": "s", "npc_id": "n", "greeting": "Здравствуй.", "options": [{ "id": "bye", "label": "Пока.", "reply": "Пока.", "ends": true }] }] })
    }

    fn broken(patch: Value) -> Result<Vec<Dialogue>, String> {
        let mut raw = base();
        if let (Some(entry), Value::Object(patch)) = (raw["dialogues"][0].as_object_mut(), patch) {
            entry.extend(patch);
        }
        normalize_dialogues(&raw)
    }

    #[test]
    fn catalog_loads_and_every_dialogue_can_end() {
        assert!(!DIALOGUES.is_empty());
        for dialogue in DIALOGUES.iter() {
            assert!(dialogue.options.iter().any(|option| option.ends), "{}: разговор можно закончить", dialogue.id);
        }
    }

    #[test]
    fn broken_data_is_rejected_at_load() {
        assert_eq!(normalize_dialogues(&base()).map(|list| list.len()), Ok(1));
        let error = |patch: Value| broken(patch).err().unwrap_or_default();
        assert!(error(json!({ "options": [{ "id": "x", "label": "Кто ты?", "check": { "skill": "insight", "dc": 15 }, "success": { "reply": "Да." } }] })).contains("success и failure"));
        assert!(error(json!({ "options": [{ "id": "x", "label": "Кто ты?", "reply": "Да.", "requires": { "flags": ["nobody-sets"] } }] })).contains("никто не ставит"));
        assert!(error(json!({ "options": [{ "id": "x", "label": "Кто ты?", "reply": "Да.", "action": { "command_type": "KillEveryone" } }] })).contains("команда"));
        assert!(error(json!({ "options": [{ "id": "x", "label": "Покойся.", "reply": "Да.", "action": { "command_type": "ReleaseCursedKnight" } }] })).contains("бросает проверку"));
        assert!(error(json!({ "options": [{ "id": "x", "label": "К страже.", "reply": "Да.", "action": { "command_type": "ResolveScenarioInformant", "informant_id": "toban", "choice": "burn" } }] })).contains("решение"));
        assert!(error(json!({ "options": [{ "id": "x", "label": "Кошель.", "check": { "skill": "insight", "dc": 15 }, "success": { "reply": "Да." }, "failure": { "reply": "Нет." }, "action": { "command_type": "ReceiveScenarioPurse" } }] })).contains("не поддержаны"));
        assert!(error(json!({ "options": [{ "id": "x", "label": "Кто ты?", "check": { "skill": "insight", "dc": 99 }, "success": { "reply": "Да." }, "failure": { "reply": "Нет." } }] })).contains("СЛ"));
        let mut wrong = base();
        wrong["schema_version"] = json!(2);
        assert!(normalize_dialogues(&wrong).err().unwrap_or_default().contains("schema_version"));
    }

    #[test]
    fn check_line_matches_free_reply_form() {
        assert_eq!(dialogue_check_line(Some(&json!({ "skill": "persuasion", "success": true, "total": 19 }))), "Проверка «Убеждение»: успех (19).");
        assert_eq!(dialogue_check_line(Some(&json!({ "skill": "stealth", "success": 1 }))), "Проверка «stealth»: провал.");
        assert_eq!(dialogue_check_line(None), "");
        // Ключ прототипа — незнакомый навык: печатается как есть.
        assert_eq!(dialogue_check_line(Some(&json!({ "skill": "constructor" }))), "Проверка «constructor»: провал.");
    }

    #[test]
    fn event_folds_progress() {
        let event = json!({ "event_type": DIALOGUE_EVENT, "payload": { "dialogue_id": "astohan-ares", "option_id": "task", "hero_id": "h", "sets": ["a", " a "], "check": true, "granted_fact_id": "f" } });
        let state = apply_dialogue_event(None, Some(&event));
        assert_eq!(
            js::stringify(&state),
            r#"{"astohan-ares":{"flags":["a"],"chosen":{"task":["h"]},"attempted":{"task":["h"]},"granted":["f"]}}"#
        );
        let again = apply_dialogue_event(Some(&state), Some(&event));
        assert_eq!(again, state);
    }

    #[test]
    fn blank_topic_matches_secret_without_topic_like_js() {
        // Замечено в JS: тема из одних пробелов истинна, а после `clean` пуста —
        // и совпадает с тайной исходной ситуации без темы.
        let state = json!({ "worldMemory": { "facts": [{ "id": "f1", "predicate": "gm_secret", "object": "{}" }] } });
        assert_eq!(dialogue_reveal_fact_id(&state, Some(&json!({ "reveal_topic": "   " }))), "f1");
    }
}


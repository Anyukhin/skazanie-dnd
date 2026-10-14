//! Перенос `server/world-memory.mjs`: память мира.
//!
//! Каноническая правда кампании — факты (`facts`) о сущностях (`entities`);
//! рядом лежат отношения, поручения, сюжетные нити, убеждения и слухи NPC
//! (`epistemic_claims`, отдельно от фактов) и сводки сцен. Знание героя —
//! неизменяемый журнал `knowledge_ledger` (схема v2, со старым индексом
//! `knowledge` для совместимости). Модуль проверяет команды памяти, строит их
//! события, применяет события (`apply_world_memory_event` — редьюсер, которым
//! Rules Engine ведёт `WorldFactRecorded`, `QuestUpserted` и др.), строит
//! проекцию для зрителя и ищет по ней с одним шагом по графу. Здесь же —
//! заготовки ведущего (`gm_secret`) и находки свободного действия.
//!
//! Все функции работают над `serde_json::Value` той же формы, что в JS;
//! объекты-параметры JS (`{ checkEvent, skill, … }`) передаются JSON-объектом
//! с теми же ключами.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::{js, re, text as jstext};
use sk_society::quest_consequences::{
    normalize_quest_knowledge_history, normalize_quest_responsibility, quest_for_knowledge, quest_giver_id, quest_invalidation_draft, quest_is_impossible,
    record_quest_knowledge,
};
use sk_society::retention_context::retention_mode;

use crate::jsv::{
    array, coalesce, contains, entries, first_word, get, head, is_num, is_str, js_order, keys, lower, lower_first, object, or, put, s, safe_id, same_value_zero,
    sha256, spread, spread_object, squash as text, strict_eq, string, strings_value, tpl, unique,
};

const ENTITY_KINDS: [&str; 6] = ["location", "npc", "faction", "item", "event", "concept"];
const QUEST_STATUSES: [&str; 6] = ["hidden", "offered", "active", "completed", "failed", "abandoned"];
const THREAD_STATUSES: [&str; 5] = ["hidden", "active", "resolved", "failed", "abandoned"];
const RELATION_STATUSES: [&str; 2] = ["active", "superseded"];
const EPISTEMIC_KINDS: [&str; 2] = ["belief", "rumor"];
const TRUTH_STATUSES: [&str; 3] = ["unknown", "confirmed", "refuted"];
const SUMMARY_KINDS: [&str; 2] = ["scene", "session"];
const VISIBILITIES: [&str; 3] = ["public", "party", "gm_only"];
const QUEST_PROGRESS_PREDICATES: [&str; 2] = ["discovery", "quest_progress"];

/// Навыки, успех которых может что-то открыть (`DISCOVERY_SKILLS`). Атлетика
/// или Скрытность — способ сделать, а не узнать; их успех уликой не становится.
pub const DISCOVERY_SKILLS: [&str; 9] = ["perception", "investigation", "insight", "survival", "history", "arcana", "religion", "nature", "medicine"];

/// Навыки, которыми можно открыть заготовку ведущего (`GM_SECRET_SKILLS`).
pub const GM_SECRET_SKILLS: [&str; 9] = ["investigation", "perception", "survival", "insight", "history", "arcana", "religion", "nature", "medicine"];

/// Цена тщательного поиска в минутах (`THOROUGH_SEARCH_MINUTES`).
pub const THOROUGH_SEARCH_MINUTES: i64 = 30;

/// Команды памяти мира (`WORLD_MEMORY_COMMAND_TYPES`).
pub const WORLD_MEMORY_COMMAND_TYPES: [&str; 15] = [
    "UpsertWorldEntity",
    "RecordWorldFact",
    "RevealWorldFact",
    "RecordKnowledgeRevelation",
    "RecordWorldRelationship",
    "UpsertQuest",
    "AdvanceQuestClock",
    "ResolveQuest",
    "InvalidateQuest",
    "UpsertNarrativeThread",
    "AdvanceNarrativeThreadClock",
    "RecordNpcBelief",
    "RecordRumor",
    "ResolveEpistemicClaim",
    "RecordNarrativeSummary",
];

/// Закрытые статусы квеста: изменять часы и разрешать повторно уже нельзя.
pub const CLOSED_QUEST_STATUSES: [&str; 3] = ["completed", "failed", "abandoned"];

/// Следующая цель после отказа от поручения.
pub const QUEST_ABANDONMENT_NEXT_OBJECTIVE: &str = "Выбрать дальнейшее занятие в текущей локации";

/// Отказ проверки команды памяти (`WorldMemoryValidationError`): код и текст.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct WorldMemoryValidationError {
    pub code: String,
    pub message: String,
}

impl WorldMemoryValidationError {
    pub fn new(message: impl Into<String>, code: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

impl From<WorldMemoryValidationError> for sk_core::RuleError {
    fn from(error: WorldMemoryValidationError) -> Self {
        sk_core::RuleError::new(error.code, error.message)
    }
}

type Checked<T> = Result<T, WorldMemoryValidationError>;

fn invalid<T>(message: impl Into<String>, code: &str) -> Checked<T> {
    Err(WorldMemoryValidationError::new(message, code))
}

fn has(list: &[&str], value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|value| list.contains(&value))
}

fn has_str(list: &[&str], value: &str) -> bool {
    list.contains(&value)
}

/// `String(skill ?? '').replace(/_/gu, '-')`.
fn dashed(value: Option<&Value>) -> String {
    s(value).replace('_', "-")
}

// ---------------------------------------------------------------------------
// Доказательства продвижения поручения
// ---------------------------------------------------------------------------

/// Подтверждения продвижения поручения (`questProgressEvidenceFor`):
/// факты-находки о сущностях поручения со свежим событием-источником.
/// Совпадение текста доказательством не является.
pub fn quest_progress_evidence_for(state: &Value, quest_id: &str, include_consumed: bool) -> Vec<Value> {
    let memory = get(Some(state), "worldMemory");
    let Some(quest) = array(get(memory, "quests")).iter().find(|entry| string(get(Some(entry), "id")) == quest_id) else {
        return Vec::new();
    };
    if !is_str(get(Some(quest), "status"), "active") {
        return Vec::new();
    }
    let consumed = spread(coalesce(get(Some(quest), "progress_fact_ids"), None));
    let used_sources = spread(coalesce(get(Some(quest), "progress_source_event_ids"), None));
    let entity_ids = spread(coalesce(get(Some(quest), "entity_ids"), None));
    let facts: Vec<Value> = array(get(memory, "facts"))
        .iter()
        .filter(|fact| {
            let sources = array(get(Some(fact), "source_event_ids"));
            js::truthy(get(Some(fact), "id"))
                && !is_str(get(Some(fact), "status"), "superseded")
                && has(&QUEST_PROGRESS_PREDICATES, get(Some(fact), "predicate"))
                && contains(&entity_ids, get(Some(fact), "subject_id"))
                && matches!(get(Some(fact), "source_event_ids"), Some(Value::Array(items)) if !items.is_empty())
                && (include_consumed
                    || !contains(&consumed, get(Some(fact), "id")) && sources.iter().any(|id| !contains(&used_sources, Some(id))))
        })
        .cloned()
        .collect();
    // Старые шаги Директора не хранили IDs улик. Консервативно пропускаем уже
    // учтённое число фактов, но не смешиваем его с ходом времени и провалами.
    let legacy_steps = if include_consumed {
        0
    } else {
        array(get(get(Some(state), "autonomy"), "director_history"))
            .iter()
            .filter(|entry| {
                let intent = coalesce(get(Some(entry), "intent"), Some(entry));
                is_str(get(intent, "type"), "advance_quest_clock")
                    && string(get(intent, "quest_id")) == quest_id
                    && !matches!(get(Some(entry), "proof_fact_ids"), Some(Value::Array(_)))
            })
            .count()
    };
    facts.into_iter().skip(legacy_steps).collect()
}

/// Слова, совпадение по которым ещё не говорит, что действие про это дело.
const GENERIC_TOPIC_STEMS: [&str; 30] = [
    "город", "начат", "занят", "собст", "делам", "отряд", "героя", "герои", "место", "места", "своих", "своим", "котор", "этого", "чтобы", "после", "перед", "может",
    "нужно", "сцена", "сцены", "локац", "задан", "поруч", "квест", "найти", "узнат", "добит", "попыт", "сдела",
];

/// Основы значимых слов: первые пять букв слов длиной от пяти (`topicStems`).
fn topic_stems(value: &str) -> IndexSet<String> {
    let lowered = lower(&jstext::nfkc(value));
    jstext::find_all(re!(r"[\p{L}]{5,}", "gu"), &lowered)
        .into_iter()
        .map(|word| head(&word, 5))
        .filter(|stem| !GENERIC_TOPIC_STEMS.contains(&stem.as_str()))
        .collect()
}

// ---------------------------------------------------------------------------
// Заготовки ведущего
// ---------------------------------------------------------------------------

const GM_SECRET_PREDICATE: &str = "gm_secret";

/// Заготовки ведущего из ответа модели (`normalizeGmSecrets`): текст находки,
/// тема, навыки и знающий NPC. Короче двенадцати знаков — не находка; навык вне
/// списка отбрасывается, без навыков — поиск и осмотр.
pub fn normalize_gm_secrets(value: Option<&Value>, limit: i64) -> Vec<Value> {
    let Some(Value::Array(items)) = value else {
        return Vec::new();
    };
    items
        .iter()
        .take(limit.max(0) as usize)
        .map(|entry| {
            let source = object(Some(entry)).map(|_| entry);
            let skills: Vec<String> = unique(
                array(get(source, "skills"))
                    .iter()
                    .map(|skill| jstext::replace_all(re!(r"[\s-]+", "gu"), &lower(&text(Some(skill), 40)), "_"))
                    .filter(|skill| has_str(&GM_SECRET_SKILLS, skill)),
            )
            .into_iter()
            .take(3)
            .collect();
            let skills = if skills.is_empty() { vec!["investigation".to_string(), "perception".to_string()] } else { skills };
            json!({
                "clue": text(get(source, "clue"), 600),
                "topic": text(get(source, "topic"), 160),
                "skills": strings_value(&skills),
                "holder": text(get(source, "holder"), 120),
            })
        })
        .filter(|secret| secret["clue"].as_str().is_some_and(|clue| jstext::len(clue) >= 12))
        .collect()
}

/// Скрытый факт заготовки (`gmSecretFact`). Id детерминирован от
/// пространства, соли и текста: повтор того же коммита не заводит второй
/// тайны. `input` — `{ subjectId, salt, index, sourceCommandId, recordedAtMinutes }`.
pub fn gm_secret_fact(secret: &Value, input: &Value) -> Value {
    let input = Some(input);
    let secret = Some(secret);
    let digest = sha256(&format!(
        "gm-secret\u{0}{}\u{0}{}\u{0}{}",
        tpl(get(input, "salt")),
        tpl(get(input, "index")),
        tpl(get(secret, "clue"))
    ));
    let mut object = Map::new();
    put(&mut object, "topic", get(secret, "topic"));
    let skills: Vec<Value> = array(get(secret, "skills")).iter().map(|skill| Value::String(s(Some(skill)).replace('_', "-"))).collect();
    object.insert("skills".into(), Value::Array(skills));
    put(&mut object, "holder", get(secret, "holder"));
    let mut fact = Map::new();
    fact.insert("id".into(), Value::String(format!("fact:secret:{}", head(&digest, 24))));
    put(&mut fact, "subject_id", get(input, "subjectId"));
    fact.insert("predicate".into(), json!("gm_secret"));
    fact.insert("object".into(), Value::String(serde_json::to_string(&Value::Object(object)).unwrap_or_default()));
    put(&mut fact, "summary", get(secret, "clue"));
    fact.insert("visibility".into(), json!("gm_only"));
    fact.insert("source_event_ids".into(), json!([]));
    fact.insert("source_command_id".into(), get(input, "sourceCommandId").cloned().unwrap_or_else(|| json!("")));
    fact.insert("supersedes_fact_id".into(), json!(""));
    fact.insert("status".into(), json!("active"));
    fact.insert("recorded_at_minutes".into(), get(input, "recordedAtMinutes").cloned().unwrap_or_else(|| json!(0)));
    Value::Object(fact)
}

/// «Осматриваюсь», «ищу что-нибудь», «изучаю место», «иду по следам» — общий
/// поиск без темы. Прислушаться у двери — не обыск.
fn general_search(value: &str) -> bool {
    jstext::test(
        re!(
            r"(?<![\p{L}\p{M}])(?:осматр\p{L}*|осмотр\p{L}*|огляд\p{L}*|обыскива\p{L}*|ищу|изуча\p{L}*|исследу\p{L}*|разгляд\p{L}*|рассматр\p{L}*|смотр\p{L}*\s+по\s+сторонам|пригляд\p{L}*|след\p{L}*|выслеж\p{L}*|высле\p{L}*)(?![\p{L}\p{M}])",
            "iu"
        ),
        value,
    )
}

const SEARCH_SKILLS: [&str; 3] = ["perception", "investigation", "survival"];

fn testimony_verb(value: &str) -> bool {
    jstext::test(
        re!(
            r"(?<![\p{L}\p{M}])(?:видел\p{L}*|слышал\p{L}*|знает|знал\p{L}*|помнит|помнил\p{L}*|заметил\p{L}*|рассказ\p{L}*|клянётся|клянется)(?![\p{L}\p{M}])",
            "iu"
        ),
        value,
    )
}

/// Разобранный `object` заготовки.
#[derive(Debug, Clone)]
struct SecretMeta {
    topic: String,
    skills: Vec<String>,
    holder: String,
    hero_id: String,
}

impl SecretMeta {
    fn to_value(&self) -> Value {
        json!({ "topic": self.topic, "skills": strings_value(&self.skills), "holder": self.holder, "hero_id": self.hero_id })
    }
}

/// Свидетельство хранителя: в тексте тайны названо его имя и глагол знания.
fn testimony_of_holder(fact: &Value, meta: &SecretMeta) -> bool {
    let holder = first_word(&meta.holder);
    if jstext::len(&holder) < 3 {
        return false;
    }
    let summary = s(get(Some(fact), "summary"));
    lower(&summary).contains(&lower(&holder)) && testimony_verb(&summary)
}

const SECRET_STOP_STEMS: [&str; 28] = [
    "геро", "чтоб", "кото", "этог", "свой", "свои", "своё", "этот", "этой", "есть", "было", "была", "были", "него", "тоже", "лишь", "пока", "кто-", "когд", "толь",
    "сейч", "здес", "очен", "всех", "весь", "вижу", "смот", "ищу-",
];

/// Основы для сверки заявки с секретом — по четыре буквы (`secretStems`).
fn secret_stems(value: &str) -> IndexSet<String> {
    let lowered = lower(&jstext::nfkc(value)).replace('ё', "е");
    jstext::find_all(re!(r"[\p{L}-]{4,}", "gu"), &lowered)
        .into_iter()
        .map(|word| head(&word, 4))
        .filter(|stem| !SECRET_STOP_STEMS.contains(&stem.as_str()))
        .collect()
}

fn parse_secret_meta(value: Option<&Value>) -> SecretMeta {
    let parsed: Option<Value> = serde_json::from_str(&s(value)).ok();
    match parsed {
        None => SecretMeta { topic: String::new(), skills: Vec::new(), holder: String::new(), hero_id: String::new() },
        Some(parsed) => {
            let parsed = Some(&parsed);
            let skills = match get(parsed, "skills") {
                Some(Value::Array(items)) => items.iter().map(|entry| text(Some(entry), 40).replace('_', "-")).filter(|entry| !entry.is_empty()).collect(),
                _ => Vec::new(),
            };
            SecretMeta {
                topic: text(get(parsed, "topic"), 200),
                skills,
                holder: text(get(parsed, "holder"), 120),
                hero_id: text(get(parsed, "hero_id"), 120),
            }
        }
    }
}

/// Разбор JSON `object` заготовки (`parseGmSecretObject`): тема, навыки
/// (через дефис), хранитель и герой личной нити.
pub fn parse_gm_secret_object(value: Option<&Value>) -> Value {
    parse_secret_meta(value).to_value()
}

/// Заготовка, которую отряд уже услышал: NPC назвал её id в разговоре
/// (`knowledge_ledger`) или пересказал её почти теми же словами.
fn secret_already_told(state: &Value, fact: &Value) -> bool {
    let id = s(get(Some(fact), "id"));
    let memory = get(Some(state), "worldMemory");
    let mut journal = spread(coalesce(get(memory, "knowledge_ledger"), None));
    journal.extend(spread(coalesce(get(memory, "knowledge_revealed"), None)));
    if journal.iter().any(|entry| !id.is_empty() && s(get(Some(entry), "fact_id")) == id) {
        return true;
    }
    let content = secret_stems(&s(get(Some(fact), "summary")));
    if content.len() < 5 {
        return false;
    }
    spread(coalesce(get(get(Some(state), "social"), "conversations"), None)).iter().any(|entry| {
        let said = secret_stems(&s(get(Some(entry), "npc_reply")));
        let shared = content.iter().filter(|stem| said.contains(*stem)).count();
        shared >= 6 || shared as f64 / content.len() as f64 >= 0.5
    })
}

/// `text(state.scene?.location, 160).toLocaleLowerCase('ru')`.
fn scene_location(state: &Value) -> String {
    lower(&text(get(get(Some(state), "scene"), "location"), 160))
}

/// Сущность памяти с именем текущей локации.
fn here_entity(state: &Value) -> Option<&Value> {
    let location = scene_location(state);
    array(get(get(Some(state), "worldMemory"), "entities"))
        .iter()
        .find(|entity| !location.is_empty() && lower(&text(get(Some(entity), "name"), 160)) == location)
}

struct Candidate<'a> {
    fact: &'a Value,
    meta: SecretMeta,
    exact: bool,
    related: bool,
    score: usize,
    here: bool,
    personal: bool,
}

/// Какой секрет открывает удачная проверка (`secretRevealCommand`). Сначала —
/// по теме заявки и подходящему навыку; общий поиск без темы даёт ближайший
/// секрет того же навыка в этой локации. Секрет заменяется фактом отряда.
fn secret_reveal_command(state: &Value, source_event_id: &str, skill: Option<&Value>, action_text: &str, topical_only: bool) -> Option<Value> {
    let memory = get(Some(state), "worldMemory");
    let normalized_skill = dashed(skill);
    let location = scene_location(state);
    let here_ids: HashSet<String> = array(get(memory, "entities"))
        .iter()
        .filter(|entity| !location.is_empty() && lower(&text(get(Some(entity), "name"), 160)) == location)
        .map(|entity| string(get(Some(entity), "id")))
        .collect();
    let spoken = secret_stems(action_text);
    let search_skill = has_str(&SEARCH_SKILLS, &normalized_skill);
    let candidates: Vec<Candidate> = array(get(memory, "facts"))
        .iter()
        .filter(|fact| js::truthy(Some(fact)) && is_str(get(Some(fact), "predicate"), GM_SECRET_PREDICATE))
        .filter(|fact| is_str(get(Some(fact), "status"), "active"))
        .filter(|fact| !secret_already_told(state, fact))
        .map(|fact| {
            let meta = parse_secret_meta(get(Some(fact), "object"));
            let topic = secret_stems(&format!("{} {}", meta.topic, tpl(get(Some(fact), "summary"))));
            Candidate {
                exact: meta.skills.contains(&normalized_skill),
                // Искать глазами, руками и по следам — родственные способы.
                related: search_skill && meta.skills.iter().any(|skill| has_str(&SEARCH_SKILLS, skill)),
                score: spoken.iter().filter(|stem| topic.contains(*stem)).count(),
                here: here_ids.contains(&string(get(Some(fact), "subject_id"))),
                personal: !meta.hero_id.is_empty(),
                fact,
                meta,
            }
        })
        .filter(|entry| entry.exact || entry.related)
        .collect();
    // Свидетельство хранителя по теме открывается, только если герой
    // обращается к самому хранителю.
    let asks_holder = |entry: &Candidate| {
        let holder = first_word(&entry.meta.holder);
        let length = jstext::len(&holder);
        let prefix = head(&lower(&holder), 3.max(length.saturating_sub(1)));
        length >= 3 && lower(action_text).contains(&prefix)
    };
    // Обыск руками и глазами свидетельства не находит, даже если хранитель
    // назван в той же заявке.
    let physical_search = search_skill;
    let mut topical: Vec<&Candidate> = candidates
        .iter()
        .filter(|entry| !testimony_of_holder(entry.fact, &entry.meta) || (!physical_search && asks_holder(entry)))
        .filter(|entry| entry.score >= 2 || (entry.score >= 1 && (entry.here || entry.personal)))
        .collect();
    topical.sort_by(|left, right| right.score.cmp(&left.score).then((right.here as u8).cmp(&(left.here as u8))));
    let topical = topical.first().copied();
    // Общий поиск открывает тайну этого места сперва своим навыком, затем
    // родственным; свидетельство хранителя общий осмотр не открывает.
    let searchable: Vec<&Candidate> = candidates.iter().filter(|entry| !testimony_of_holder(entry.fact, &entry.meta)).collect();
    let general = if topical.is_none() && !topical_only && general_search(action_text) {
        searchable.iter().find(|entry| entry.here && entry.exact).or_else(|| searchable.iter().find(|entry| entry.here && entry.related)).copied()
    } else {
        None
    };
    let chosen = topical.or(general)?;
    let mut fact = Map::new();
    let digest = sha256(&format!("{source_event_id}\u{0}{}", tpl(get(Some(chosen.fact), "id"))));
    fact.insert("id".into(), Value::String(format!("fact-secret-found-{}", head(&digest, 24))));
    put(&mut fact, "subject_id", get(Some(chosen.fact), "subject_id"));
    fact.insert("predicate".into(), json!("discovery"));
    fact.insert("object".into(), json!("clue"));
    fact.insert("summary".into(), Value::String(text(get(Some(chosen.fact), "summary"), 1_000)));
    fact.insert("visibility".into(), json!("party"));
    fact.insert("source_event_ids".into(), json!([source_event_id]));
    put(&mut fact, "supersedes_fact_id", get(Some(chosen.fact), "id"));
    Some(json!({ "command_type": "RecordWorldFact", "fact": Value::Object(fact) }))
}

struct NpcLead<'a> {
    npc: &'a Value,
    goal: String,
    score: usize,
}

/// Знающий собеседник — находка, когда заготовки ведущего на эту тему нет
/// (`presentNpcLead`): скрытая цель присутствующего NPC, связанная со словами
/// заявки. Одну и ту же цель второй раз не открываем.
fn present_npc_lead<'a>(state: &'a Value, spoken_text: &str) -> Option<NpcLead<'a>> {
    let location = scene_location(state);
    let spoken = secret_stems(spoken_text);
    if spoken.is_empty() {
        return None;
    }
    let revealed: Vec<String> = array(get(get(Some(state), "worldMemory"), "facts"))
        .iter()
        .filter(|fact| is_str(get(Some(fact), "predicate"), "discovery"))
        .map(|fact| lower(&text(get(Some(fact), "summary"), 1_000)))
        .collect();
    let mut leads: Vec<NpcLead> = array(get(get(Some(state), "social"), "npcs"))
        .iter()
        .filter(|npc| {
            !js::is_false(get(Some(npc), "available")) && !is_str(get(Some(npc), "visibility"), "gm_only") && !text(get(Some(npc), "name"), 120).is_empty()
        })
        .filter(|npc| location.is_empty() || !js::truthy(get(Some(npc), "location")) || lower(&text(get(Some(npc), "location"), 160)) == location)
        .flat_map(|npc| {
            array(get(Some(npc), "goals"))
                .iter()
                .map(|goal| text(Some(goal), 240))
                .filter(|goal| !goal.is_empty())
                .filter(|goal| {
                    let lowered = lower(goal);
                    !revealed.iter().any(|summary| summary.contains(&lowered))
                })
                .map(|goal| {
                    let topic = secret_stems(&format!("{goal} {}", text(get(Some(npc), "role"), 160)));
                    let score = spoken.iter().filter(|stem| topic.contains(*stem)).count();
                    NpcLead { npc, goal, score }
                })
                .collect::<Vec<_>>()
        })
        .filter(|lead| lead.score > 0)
        .collect();
    leads.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| jstext::locale_compare(&text(get(Some(left.npc), "id"), 120), &text(get(Some(right.npc), "id"), 120)))
    });
    leads.into_iter().next()
}

/// Мелкая деталь, о которой спросил игрок, — находка о текущем месте
/// (`successDetailCommand`). Тайн сцены она не раскрывает, повтор хода не
/// записывает её дважды.
fn success_detail_command(state: &Value, source_event_id: &str, success_detail: Option<&Value>, kind: &str) -> Option<Value> {
    let summary = text(success_detail, 300);
    if summary.is_empty() || source_event_id.is_empty() {
        return None;
    }
    let here = here_entity(state)?;
    if !js::truthy(get(Some(here), "id")) {
        return None;
    }
    let lowered = lower(&summary);
    let known = array(get(get(Some(state), "worldMemory"), "facts"))
        .iter()
        .any(|fact| is_str(get(Some(fact), "predicate"), "discovery") && lower(&text(get(Some(fact), "summary"), 1_000)) == lowered);
    if known {
        return None;
    }
    let digest = sha256(&format!("{source_event_id}\u{0}{summary}"));
    Some(json!({
        "command_type": "RecordWorldFact",
        "fact": {
            "id": format!("fact-{kind}-{}", head(&digest, 24)),
            "subject_id": string(get(Some(here), "id")),
            "predicate": "discovery",
            "object": kind,
            "summary": summary,
            "visibility": "party",
            "source_event_ids": [source_event_id],
        },
    }))
}

fn strip_final_punctuation(value: &str) -> String {
    jstext::replace_first(re!(r"[.!?…]+$", "u"), value, "")
}

fn npc_lead_summary(lead: &NpcLead) -> String {
    let role = text(get(Some(lead.npc), "role"), 160);
    let goal = strip_final_punctuation(&lead.goal);
    let role_part = if role.is_empty() { String::new() } else { format!(", {role},") };
    format!("{}{role_part} явно знает об этом больше, чем говорит, — и хочет {}.", text(get(Some(lead.npc), "name"), 120), lower_first(&goal))
}

/// `String(checkEvent?.event_id ?? '')`.
fn source_event_id_of(check_event: Option<&Value>) -> String {
    s(get(check_event, "event_id"))
}

/// Параметр объекта-аргумента JS с умолчанием для `undefined`.
fn param<'a>(input: &'a Value, key: &str) -> Option<&'a Value> {
    get(Some(input), key)
}

/// Строка параметра с умолчанием `''` для `undefined` (для шаблонов `${x}`).
fn param_text(input: &Value, key: &str) -> String {
    match param(input, key) {
        None => String::new(),
        value => tpl(value),
    }
}

/// Что видно и без броска (`freeActionSurfaceCommands`): на проваленном
/// осмотре ведущий всё равно показывает место. `input` — `{ checkEvent, skill,
/// surfaceDetail }`.
pub fn free_action_surface_commands(state: &Value, input: &Value) -> Vec<Value> {
    let source_event_id = source_event_id_of(param(input, "checkEvent"));
    if source_event_id.is_empty() || !has_str(&DISCOVERY_SKILLS, &dashed(param(input, "skill"))) {
        return Vec::new();
    }
    success_detail_command(state, &source_event_id, param(input, "surfaceDetail"), "surface").into_iter().collect()
}

/// Что удачная Проницательность читает в человеке, когда судья не назвал
/// реакцию (`insightRead`): знает ли он больше, чем говорит. Сама тайна не
/// раскрывается. `input` — `{ actionText, actorId }`.
pub fn insight_read(state: &Value, input: &Value) -> String {
    let action_text = match param(input, "actionText") {
        None => String::new(),
        value => s(value),
    };
    let said = lower(&action_text).replace('ё', "е");
    let here = s(get(get(Some(state), "scene"), "location_id"));
    let words = jstext::find_all(re!(r"\p{L}+", "gu"), &said);
    let npc = spread(coalesce(get(Some(state), "scene_npcs"), None)).into_iter().filter(|entry| {
        let location_id = get(Some(entry), "location_id");
        !js::is_false(get(Some(entry), "alive")) && (here.is_empty() || !js::truthy(location_id) || string(location_id) == here)
    });
    let npc = npc.into_iter().find(|entry| {
        let first = lower(&first_word(&text(get(Some(entry), "name"), 120))).replace('ё', "е");
        // Имя склоняется: «Иара» — «Иару», «Иарой»; сверяется основа слова.
        let length = jstext::len(&first);
        let stem = head(&first, 3.max(length.saturating_sub(1)));
        length >= 3 && words.iter().any(|word| word.starts_with(&stem))
    });
    let Some(npc) = npc else {
        return String::new();
    };
    let name = text(get(Some(&npc), "name"), 120);
    let first = lower(&first_word(&name));
    // Имя самого человека в его же тайне — не тема разговора.
    let own = secret_stems(&name);
    let spoken: Vec<String> = secret_stems(&action_text).into_iter().filter(|stem| !own.contains(stem)).collect();
    let name_lower = lower(&name);
    let held: Vec<(&Value, SecretMeta)> = array(get(get(Some(state), "worldMemory"), "facts"))
        .iter()
        .filter(|fact| js::truthy(Some(fact)) && is_str(get(Some(fact), "predicate"), GM_SECRET_PREDICATE))
        .filter(|fact| is_str(get(Some(fact), "status"), "active") && !secret_already_told(state, fact))
        .map(|fact| (fact, parse_secret_meta(get(Some(fact), "object"))))
        .filter(|(_, meta)| {
            let holder = lower(&meta.holder);
            !holder.is_empty() && (holder == name_lower || first_word(&holder) == first)
        })
        .collect();
    if held.is_empty() {
        return format!("{name} смотрит без тени узнавания — и, похоже, не притворяется: скрывать тут нечего.");
    }
    let actor_id = param(input, "actorId");
    let topical = held.iter().any(|(fact, meta)| {
        (js::truthy(actor_id) && actor_id.and_then(Value::as_str) == Some(meta.hero_id.as_str()))
            || spoken.iter().any(|stem| secret_stems(&format!("{} {}", meta.topic, tpl(get(Some(fact), "summary")))).contains(stem))
    });
    if topical {
        format!("{name} выдаёт себя: взгляд на миг застывает и тут же уходит в сторону — это знакомо. {name} знает об этом больше, чем говорит.")
    } else {
        format!("{name} держится ровно и узнавания не выдаёт, но настороженность не уходит: что-то {name} скрывает — только, похоже, не это.")
    }
}

/// Заявка просит обыскать не торопясь (`isThoroughSearch`).
pub fn is_thorough_search(value: Option<&Value>) -> bool {
    thorough(&s(value))
}

fn thorough(value: &str) -> bool {
    jstext::test(
        re!(
            r"(?<![\p{L}\p{M}])(?:методичн\p{L}*|тщательн\p{L}*|не\s+(?:торопясь|спеша)|кажд(?:ую|ый|ое|ой)\s+(?:доск|щел|угол|угл|камен|камн|бочк|ящик|половиц|пядь|дюйм)\p{L}*|дюйм\s+за\s+дюймом|пядь\s+за\s+пядью|шаг\s+за\s+шагом|сантиметр\s+за\s+сантиметром|перебира\p{L}*\s+вс[её])(?![\p{L}\p{M}])",
            "iu"
        ),
        value,
    )
}

/// Заявка ищет спрятанное — осмотр, обыск, простукивание (`searchesForHidden`).
fn searches_for_hidden(value: &str) -> bool {
    thorough(value) || general_search(value) || jstext::test(re!(r"(?<![\p{L}\p{M}])(?:простук|тайник|ощупыва|обшари)", "iu"), value)
}

/// Что даёт проваленный тщательный поиск вне спешки (`thoroughSearchOutcome`,
/// правило «Многократные проверки», DMG 2014, гл. 8): тайну по заявке или
/// места и цену — полчаса. `None` — правило неприменимо. `input` —
/// `{ checkEvent, skill, actionText }`.
pub fn thorough_search_outcome(state: &Value, input: &Value) -> Option<Value> {
    let check_event = param(input, "checkEvent");
    let source_event_id = source_event_id_of(check_event);
    let normalized_skill = dashed(param(input, "skill"));
    if source_event_id.is_empty() || js::is_true(get(get(check_event, "payload"), "success")) || !has_str(&SEARCH_SKILLS, &normalized_skill) {
        return None;
    }
    let action_text = match param(input, "actionText") {
        None => String::new(),
        value => s(value),
    };
    if !searches_for_hidden(&action_text) || js::is_true(get(get(get(Some(state), "mechanics"), "combat"), "active")) {
        return None;
    }
    let hostile = spread(coalesce(get(Some(state), "enemies"), None)).iter().any(|enemy| {
        let hp = coalesce(get(Some(enemy), "hp"), None).cloned().unwrap_or(json!(1));
        !js::is_false(get(Some(enemy), "alive")) && js::number(Some(&hp)) > 0.0 && !js::is_true(get(Some(enemy), "hidden"))
    });
    if hostile {
        return None;
    }
    let secret = secret_reveal_command(state, &source_event_id, Some(&Value::String(normalized_skill)), &action_text, false);
    let found = secret.is_some();
    Some(json!({ "commands": secret.into_iter().collect::<Vec<_>>(), "found": found, "minutes": THOROUGH_SEARCH_MINUTES }))
}

/// Культ, названный в замысле кампании (`cultNameFrom`): «культ «Утопленной
/// Матери»» — «Утопленной Матери». Пустая строка, если культа в замысле нет.
pub fn cult_name_from(state: &Value) -> String {
    let concept = coalesce(get(Some(state), "campaignConcept"), get(Some(state), "campaign_concept"));
    let source = ["premise", "worldSummary", "world_summary", "hook"].iter().map(|key| text(get(concept, key), 1_200)).collect::<Vec<_>>().join(" ");
    if let Some(quoted) = jstext::capture(re!(r"(?<![\p{L}])культ\p{L}*\s+«([^«»]{2,60})»", "iu"), &source, 1) {
        if !quoted.is_empty() {
            return text(Some(&Value::String(quoted)), 60);
        }
    }
    let named = jstext::capture(re!(r"(?<![\p{L}])культ\p{L}*\s+((?:[А-ЯЁ][\p{L}-]+\s*){1,3})", "u"), &source, 1);
    text(named.map(Value::String).as_ref(), 60)
}

/// Бестиарий MM14: кто носит знак культа.
const CULT_STAT_BLOCK_SLUGS: [&str; 3] = ["cultist", "cult-fanatic", "acolyte"];
const CULT_TOKENS: [&str; 4] = [
    "амулет из пробитой ракушки на просмолённом шнурке",
    "медный жетон, стёртый пальцами до блеска",
    "вытатуированная на запястье волна",
    "лоскут, нашитый на подкладку изнанкой наружу",
];

/// Улика на теле культиста (`corpseClueCommand`): знак культа из замысла
/// кампании, одна на встречу. Вещь выбирается по id контейнера — повтор хода
/// даёт тот же знак. `container` — контейнер добычи (`loot-containers`).
pub fn corpse_clue_command(state: &Value, container: &Value) -> Option<Value> {
    let container = Some(container);
    if s(get(container, "kind")) != "corpse" {
        return None;
    }
    let cult = cult_name_from(state);
    if cult.is_empty() {
        return None;
    }
    let mut source_values: Vec<Value> = Vec::new();
    source_values.extend(get(container, "source_enemy_id").cloned());
    source_values.extend(spread(coalesce(get(container, "source_enemy_ids"), None)));
    let sources: HashSet<String> = source_values.iter().filter(|value| js::truthy(Some(value))).map(|value| string(Some(value))).collect();
    let enemy = spread(coalesce(get(Some(state), "enemies"), None)).into_iter().find(|entry| {
        let slug = s(get(Some(entry), "stat_block_id"));
        sources.contains(&s(get(Some(entry), "id"))) && has_str(&CULT_STAT_BLOCK_SLUGS, slug.rsplit(':').next().unwrap_or(""))
    })?;
    let encounter = text(get(container, "encounter_id"), 160);
    let encounter_key = if encounter.is_empty() { text(get(container, "id"), 160) } else { encounter };
    let id = format!("fact-cult-sign-{}", head(&sha256(&encounter_key), 24));
    if array(get(get(Some(state), "worldMemory"), "facts")).iter().any(|fact| is_str(get(Some(fact), "id"), &id)) {
        return None;
    }
    let here = here_entity(state)?;
    if !js::truthy(get(Some(here), "id")) {
        return None;
    }
    let hex = sha256(&text(get(container, "id"), 160));
    let index = u64::from_str_radix(&hex[..8], 16).unwrap_or(0) % CULT_TOKENS.len() as u64;
    let token = CULT_TOKENS[index as usize];
    let name = jstext::replace_first(re!(r"\s+\d+$", "u"), &text(get(Some(&enemy), "name"), 80), "");
    Some(json!({
        "command_type": "RecordWorldFact",
        "fact": {
            "id": id,
            "subject_id": string(get(Some(here), "id")),
            "predicate": "discovery",
            "object": "clue",
            "summary": format!("При теле — {token}: знак культа «{cult}». {name} был из них."),
            "visibility": "party",
            "source_event_ids": [],
        },
    }))
}

/// Слова ведущего об исходе тщательного поиска (`thoroughSearchDetail`):
/// нашлось или честно пусто. `hero_name` — `None` для `undefined`.
pub fn thorough_search_detail(outcome: Option<&Value>, hero_name: Option<&Value>) -> String {
    let default = Value::String("Герой".into());
    let raw = match hero_name {
        None => &default,
        Some(value) => value,
    };
    let name = head(&s(or(Some(raw), Some(&default))), 80);
    if js::truthy(get(outcome, "found")) {
        format!("С ходу ничего не попалось, но {name} не жалеет получаса, перебирает всё по одному — и находит то, что ускользало.")
    } else {
        format!("{name} не жалеет получаса, перебирает всё по одному — и убеждается: ничего спрятанного здесь нет.")
    }
}

/// Улики свободного действия (`freeActionDiscoveryCommands`). Успешная
/// проверка познавательного навыка открывает заготовку ведущего, деталь,
/// названную арбитром, или зацепку по активному поручению; удача без находки —
/// видимая деталь места. Возвращаются команды `RecordWorldFact`, а не факты:
/// записать их нужно отдельным коммитом после проверки. `input` —
/// `{ checkEvent, skill, actionText, goalSummary, skillLabel, successDetail, surfaceDetail }`.
pub fn free_action_discovery_commands(state: &Value, input: &Value) -> Vec<Value> {
    let found = discovery_commands_for(state, input);
    if found.is_empty() {
        free_action_surface_commands(state, input)
    } else {
        found
    }
}

fn discovery_commands_for(state: &Value, input: &Value) -> Vec<Value> {
    let check_event = param(input, "checkEvent");
    let source_event_id = source_event_id_of(check_event);
    let payload = get(check_event, "payload");
    // Успех без броска — решение судьи с outcome success: такой успех
    // открывает только секрет по теме самой заявки.
    let unrolled = is_str(get(check_event, "event_type"), "RulingRecorded") && is_str(get(get(payload, "ruling"), "outcome"), "success");
    if source_event_id.is_empty() || (!js::is_true(get(payload, "success")) && !unrolled) {
        return Vec::new();
    }
    let skill = param(input, "skill");
    let skill_name = dashed(skill);
    if !has_str(&DISCOVERY_SKILLS, &skill_name) {
        return Vec::new();
    }
    let action_text = param(input, "actionText");
    let goal_summary = param(input, "goalSummary");
    let success_detail = param(input, "successDetail");
    // Проницательность читает человека: удача — это его реакция.
    if skill_name == "insight" {
        let reaction = success_detail_command(state, &source_event_id, success_detail, "detail").or_else(|| {
            let read_input = json!({
                "actionText": action_text.cloned().unwrap_or_else(|| json!("")),
                "actorId": s(get(check_event, "actor_id")),
            });
            let read = Value::String(insight_read(state, &read_input));
            success_detail_command(state, &source_event_id, Some(&read), "detail")
        });
        if let Some(reaction) = reaction {
            return vec![reaction];
        }
    }
    let spoken_text = format!("{} {}", param_text(input, "actionText"), param_text(input, "goalSummary"));
    // Секрет мастера важнее безликой «зацепки».
    if let Some(secret) = secret_reveal_command(state, &source_event_id, skill, &spoken_text, true) {
        return vec![secret];
    }
    // Ответ на заданный вопрос, названный арбитром до броска, — находка отряда.
    let detail = success_detail_command(state, &source_event_id, success_detail, "detail");
    let secret = if unrolled { None } else { secret_reveal_command(state, &source_event_id, skill, &spoken_text, false) };
    if detail.is_some() || secret.is_some() {
        return detail.into_iter().chain(secret).collect();
    }
    if unrolled {
        return Vec::new();
    }
    // Проницательность читает человека напротив, а не другого жителя.
    if skill_name == "insight" {
        return Vec::new();
    }
    let lead = present_npc_lead(state, &spoken_text);
    let spoken = topic_stems(&spoken_text);
    let memory = get(Some(state), "worldMemory");
    let entities: HashSet<String> = array(get(memory, "entities")).iter().map(|entity| s(get(Some(entity), "id"))).collect();
    let lead_command = |subject_id: &str, salt: &str, lead: &NpcLead| {
        json!({
            "command_type": "RecordWorldFact",
            "fact": {
                "id": format!("fact-discovery-{}", head(&sha256(&format!("{source_event_id}\u{0}{salt}")), 24)),
                "subject_id": subject_id,
                "predicate": "discovery",
                "object": "clue",
                "summary": npc_lead_summary(lead),
                "visibility": "party",
                "source_event_ids": [source_event_id],
            },
        })
    };
    if spoken.is_empty() {
        return Vec::new();
    }
    let mut commands: Vec<Value> = Vec::new();
    for quest in array(get(memory, "quests")) {
        // Скрытое от отряда поручение не получает улики.
        if !is_str(get(Some(quest), "status"), "active") || is_str(get(Some(quest), "visibility"), "gm_only") {
            continue;
        }
        let mut parts: Vec<String> = vec![join_part(get(Some(quest), "title")), join_part(get(Some(quest), "summary"))];
        parts.extend(spread(coalesce(get(Some(quest), "objectives"), None)).iter().map(|entry| join_part(Some(entry))));
        let topic = topic_stems(&parts.join(" "));
        if !spoken.iter().any(|stem| topic.contains(stem)) {
            continue;
        }
        let subject_id = array(get(Some(quest), "entity_ids")).iter().map(|entity| string(Some(entity))).find(|entity| entities.contains(entity));
        let Some(subject_id) = subject_id.filter(|id| !id.is_empty()) else {
            continue;
        };
        // Есть знающий собеседник — улика по делу называет его.
        if let Some(lead) = &lead {
            commands.push(lead_command(&subject_id, &tpl(get(Some(quest), "id")), lead));
            break;
        }
        let title = strip_final_punctuation(&text(get(Some(quest), "title"), 160));
        let raw_goal = strip_final_punctuation(&text(or(goal_summary, action_text), 200));
        let goal = lower_first(&raw_goal);
        let goal_part = if goal.is_empty() { String::new() } else { format!("{goal} — ") };
        let label = param(input, "skillLabel");
        let label_part = if js::truthy(label) { format!(" «{}»", text(label, 40)) } else { String::new() };
        commands.push(json!({
            "command_type": "RecordWorldFact",
            "fact": {
                "id": format!("fact-discovery-{}", head(&sha256(&format!("{source_event_id}\u{0}{}", tpl(get(Some(quest), "id")))), 24)),
                "subject_id": subject_id,
                "predicate": "discovery",
                "object": "clue",
                "summary": format!("Найдена зацепка по делу «{title}»: {goal_part}удачная проверка{label_part} принесла результат."),
                "visibility": "party",
                "source_event_ids": [source_event_id],
            },
        }));
        if commands.len() >= 2 {
            break;
        }
    }
    // Поручения по теме нет, а знающий собеседник есть: находка — о самом месте.
    if commands.is_empty() {
        if let Some(lead) = &lead {
            if let Some(here) = here_entity(state).filter(|here| js::truthy(get(Some(here), "id"))) {
                commands.push(lead_command(&string(get(Some(here), "id")), &format!("lead:{}", text(get(Some(lead.npc), "id"), 120)), lead));
            }
        }
    }
    commands
}

/// Элемент `Array.prototype.join`: `null` и `undefined` — пустая строка.
fn join_part(value: Option<&Value>) -> String {
    s(value)
}

// ---------------------------------------------------------------------------
// Нормализация записей
// ---------------------------------------------------------------------------

/// Статус квеста по исходу его развязки (`questStatusForOutcome`): одна
/// таблица на команду, событие и проектор.
pub fn quest_status_for_outcome(outcome: Option<&Value>) -> &'static str {
    if is_str(outcome, "success") {
        "completed"
    } else if is_str(outcome, "abandoned") {
        "abandoned"
    } else {
        "failed"
    }
}

/// Уникальные непустые строки списка без предела (`persistedStrings`):
/// списковые поля принятой записи не укорачиваются при нормализации.
fn persisted_strings(value: Option<&Value>, maximum: usize) -> Vec<String> {
    unique(array(value).iter().map(|item| text(Some(item), maximum)).filter(|item| !item.is_empty()))
}

/// То же с пределом проверки команды (`strings`).
fn strings(value: Option<&Value>, maximum: usize, limit: usize) -> Vec<String> {
    persisted_strings(value, maximum).into_iter().take(limit).collect()
}

fn integer(value: Option<&Value>, fallback: i64) -> i64 {
    js::safe_int(value, fallback)
}

fn str_value(value: &str) -> Value {
    Value::String(value.to_string())
}

/// `stableId(namespace, ...parts)`: sha256 частей через `\0`, 24 знака.
fn stable_id(namespace: &str, parts: &[Option<&Value>]) -> String {
    let joined = parts.iter().map(|part| text(*part, 1_000)).collect::<Vec<_>>().join("\u{0}");
    format!("{namespace}:{}", head(&sha256(&joined), 24))
}

fn id(value: Option<&Value>, field: &str) -> Checked<String> {
    let result = text(value, 120);
    if !safe_id(&result) {
        return invalid(format!("Некорректное поле {field}"), "WORLD_MEMORY_INVALID_ID");
    }
    Ok(result)
}

fn visibility(value: Option<&Value>, fallback: &str) -> Checked<String> {
    let fallback = str_value(fallback);
    let result = text(or(value, Some(&fallback)), 30);
    if !has_str(&VISIBILITIES, &result) {
        return invalid("Некорректная видимость памяти мира", "WORLD_MEMORY_INVALID_VISIBILITY");
    }
    Ok(result)
}

fn plain_object<'a>(value: Option<&'a Value>, label: &str) -> Checked<&'a Map<String, Value>> {
    match value {
        Some(Value::Object(map)) => Ok(map),
        _ => invalid(format!("{label} должен быть объектом"), "WORLD_MEMORY_INVALID_SHAPE"),
    }
}

fn assert_fields(value: &Map<String, Value>, allowed: &[&str], label: &str) -> Checked<()> {
    let unexpected: Vec<String> = keys(value).into_iter().filter(|key| !allowed.contains(&key.as_str())).collect();
    if !unexpected.is_empty() {
        return invalid(format!("{label} содержит запрещённые поля: {}", unexpected.join(", ")), "WORLD_MEMORY_UNKNOWN_FIELD");
    }
    Ok(())
}

fn elapsed_minutes(state: &Value) -> i64 {
    integer(get(get(get(Some(state), "mechanics"), "world_time"), "elapsed_minutes"), 0).max(0)
}

fn recorded_at(value: Option<&Value>) -> i64 {
    integer(value, 0).max(0)
}

/// Часы поручения или нити (`clock`).
fn clock(value: Option<&Value>) -> Value {
    let maximum = integer(get(value, "max"), 4).clamp(1, 100);
    let current = integer(get(value, "current"), 0).min(maximum).max(0);
    json!({ "current": current, "max": maximum, "label": text(get(value, "label"), 160), "triggered": current >= maximum })
}

fn known(list: &[&str], value: Option<&Value>, fallback: &str) -> Value {
    match value.and_then(Value::as_str) {
        Some(raw) if list.contains(&raw) => str_value(raw),
        _ => str_value(fallback),
    }
}

fn list_value(values: Vec<String>) -> Value {
    Value::Array(values.into_iter().map(Value::String).collect())
}

fn safe_entity(value: Option<&Value>) -> Map<String, Value> {
    let kind = text(get(value, "kind"), 30);
    let mut entity = Map::new();
    entity.insert("id".into(), Value::String(text(get(value, "id"), 120)));
    entity.insert("kind".into(), Value::String(if has_str(&ENTITY_KINDS, &kind) { kind } else { "concept".into() }));
    entity.insert("name".into(), Value::String(text(get(value, "name"), 160)));
    entity.insert("summary".into(), Value::String(text(get(value, "summary"), 1_000)));
    entity.insert("aliases".into(), list_value(persisted_strings(get(value, "aliases"), 120)));
    entity.insert("visibility".into(), known(&VISIBILITIES, get(value, "visibility"), "gm_only"));
    entity.insert("tags".into(), list_value(persisted_strings(get(value, "tags"), 60)));
    entity
}

fn safe_fact(value: Option<&Value>) -> Map<String, Value> {
    let mut fact = Map::new();
    fact.insert("id".into(), Value::String(text(get(value, "id"), 120)));
    fact.insert("subject_id".into(), Value::String(text(get(value, "subject_id"), 120)));
    fact.insert("predicate".into(), Value::String(text(get(value, "predicate"), 120)));
    fact.insert("object".into(), Value::String(text(get(value, "object"), 1_000)));
    fact.insert("summary".into(), Value::String(text(get(value, "summary"), 1_000)));
    fact.insert("visibility".into(), known(&VISIBILITIES, get(value, "visibility"), "gm_only"));
    fact.insert("source_event_ids".into(), list_value(persisted_strings(get(value, "source_event_ids"), 120)));
    fact.insert("source_command_id".into(), Value::String(text(get(value, "source_command_id"), 160)));
    fact.insert("supersedes_fact_id".into(), Value::String(text(get(value, "supersedes_fact_id"), 120)));
    fact.insert("status".into(), str_value(if is_str(get(value, "status"), "superseded") { "superseded" } else { "active" }));
    fact.insert("recorded_at_minutes".into(), json!(recorded_at(get(value, "recorded_at_minutes"))));
    fact
}

fn safe_relationship(value: Option<&Value>) -> Map<String, Value> {
    let mut relationship = Map::new();
    relationship.insert("id".into(), Value::String(text(get(value, "id"), 120)));
    relationship.insert("from_entity_id".into(), Value::String(text(get(value, "from_entity_id"), 120)));
    relationship.insert("relation".into(), Value::String(text(get(value, "relation"), 120)));
    relationship.insert("to_entity_id".into(), Value::String(text(get(value, "to_entity_id"), 120)));
    relationship.insert("summary".into(), Value::String(text(get(value, "summary"), 1_000)));
    relationship.insert("visibility".into(), known(&VISIBILITIES, get(value, "visibility"), "gm_only"));
    relationship.insert("source_event_ids".into(), list_value(persisted_strings(get(value, "source_event_ids"), 120)));
    relationship.insert("source_command_id".into(), Value::String(text(get(value, "source_command_id"), 160)));
    relationship.insert("supersedes_relationship_id".into(), Value::String(text(get(value, "supersedes_relationship_id"), 120)));
    relationship.insert("status".into(), known(&RELATION_STATUSES, get(value, "status"), "active"));
    relationship.insert("recorded_at_minutes".into(), json!(recorded_at(get(value, "recorded_at_minutes"))));
    relationship
}

fn safe_quest(value: Option<&Value>) -> Map<String, Value> {
    let responsibility = normalize_quest_responsibility(get(value, "responsibility"));
    let progress_fact_ids = persisted_strings(get(value, "progress_fact_ids"), 120);
    let progress_source_ids = persisted_strings(get(value, "progress_source_event_ids"), 120);
    let mut quest = Map::new();
    quest.insert("id".into(), Value::String(text(get(value, "id"), 120)));
    quest.insert("title".into(), Value::String(text(get(value, "title"), 180)));
    quest.insert("summary".into(), Value::String(text(get(value, "summary"), 1_000)));
    quest.insert("status".into(), known(&QUEST_STATUSES, get(value, "status"), "active"));
    quest.insert("visibility".into(), known(&VISIBILITIES, get(value, "visibility"), "party"));
    quest.insert("entity_ids".into(), list_value(persisted_strings(get(value, "entity_ids"), 120)));
    quest.insert("objectives".into(), list_value(persisted_strings(get(value, "objectives"), 300)));
    quest.insert("clock".into(), clock(get(value, "clock")));
    quest.insert("recorded_at_minutes".into(), json!(recorded_at(get(value, "recorded_at_minutes"))));
    if js::is_true(get(value, "stay_in_location")) {
        quest.insert("stay_in_location".into(), json!(true));
    }
    if let Some(responsibility) = responsibility {
        quest.insert("responsibility".into(), responsibility);
        let giver = text(get(value, "giver_npc_id"), 120);
        quest.insert("giver_npc_id".into(), if giver.is_empty() { Value::Null } else { Value::String(giver) });
    }
    if !progress_fact_ids.is_empty() {
        quest.insert("progress_fact_ids".into(), list_value(progress_fact_ids));
    }
    if !progress_source_ids.is_empty() {
        quest.insert("progress_source_event_ids".into(), list_value(progress_source_ids));
    }
    if js::present(get(value, "knowledge_history")) {
        quest.insert("knowledge_history".into(), Value::Array(normalize_quest_knowledge_history(get(value, "knowledge_history"))));
    }
    quest
}

fn safe_thread(value: Option<&Value>) -> Map<String, Value> {
    let mut thread = Map::new();
    thread.insert("id".into(), Value::String(text(get(value, "id"), 120)));
    thread.insert("title".into(), Value::String(text(get(value, "title"), 180)));
    thread.insert("summary".into(), Value::String(text(get(value, "summary"), 1_000)));
    thread.insert("status".into(), known(&THREAD_STATUSES, get(value, "status"), "active"));
    thread.insert("visibility".into(), known(&VISIBILITIES, get(value, "visibility"), "party"));
    thread.insert("entity_ids".into(), list_value(persisted_strings(get(value, "entity_ids"), 120)));
    thread.insert("quest_ids".into(), list_value(persisted_strings(get(value, "quest_ids"), 120)));
    thread.insert("clock".into(), clock(get(value, "clock")));
    thread.insert("source_event_ids".into(), list_value(persisted_strings(get(value, "source_event_ids"), 120)));
    thread.insert("source_command_id".into(), Value::String(text(get(value, "source_command_id"), 160)));
    thread.insert("recorded_at_minutes".into(), json!(recorded_at(get(value, "recorded_at_minutes"))));
    thread
}

fn safe_epistemic_claim(value: Option<&Value>) -> Map<String, Value> {
    let mut claim = Map::new();
    claim.insert("id".into(), Value::String(text(get(value, "id"), 120)));
    claim.insert("kind".into(), known(&EPISTEMIC_KINDS, get(value, "kind"), "belief"));
    claim.insert("holder_entity_id".into(), Value::String(text(get(value, "holder_entity_id"), 120)));
    claim.insert("subject_entity_id".into(), Value::String(text(get(value, "subject_entity_id"), 120)));
    claim.insert("predicate".into(), Value::String(text(get(value, "predicate"), 120)));
    claim.insert("claim".into(), Value::String(text(get(value, "claim"), 1_000)));
    claim.insert("summary".into(), Value::String(text(get(value, "summary"), 1_000)));
    claim.insert("visibility".into(), known(&VISIBILITIES, get(value, "visibility"), "gm_only"));
    claim.insert("truth_status".into(), known(&TRUTH_STATUSES, get(value, "truth_status"), "unknown"));
    claim.insert("source_event_ids".into(), list_value(persisted_strings(get(value, "source_event_ids"), 120)));
    claim.insert("source_command_id".into(), Value::String(text(get(value, "source_command_id"), 160)));
    claim.insert("truth_source_event_ids".into(), list_value(persisted_strings(get(value, "truth_source_event_ids"), 120)));
    claim.insert("truth_source_command_id".into(), Value::String(text(get(value, "truth_source_command_id"), 160)));
    claim.insert("recorded_at_minutes".into(), json!(recorded_at(get(value, "recorded_at_minutes"))));
    claim
}

fn safe_summary(value: Option<&Value>) -> Map<String, Value> {
    let mut summary = Map::new();
    summary.insert("id".into(), Value::String(text(get(value, "id"), 120)));
    summary.insert("kind".into(), known(&SUMMARY_KINDS, get(value, "kind"), "scene"));
    summary.insert("title".into(), Value::String(text(get(value, "title"), 180)));
    summary.insert("summary".into(), Value::String(text(get(value, "summary"), 2_000)));
    summary.insert("visibility".into(), known(&VISIBILITIES, get(value, "visibility"), "party"));
    summary.insert("entity_ids".into(), list_value(persisted_strings(get(value, "entity_ids"), 120)));
    summary.insert("thread_ids".into(), list_value(persisted_strings(get(value, "thread_ids"), 120)));
    summary.insert("source_event_ids".into(), list_value(persisted_strings(get(value, "source_event_ids"), 120)));
    summary.insert("source_command_id".into(), Value::String(text(get(value, "source_command_id"), 160)));
    summary.insert("recorded_at_minutes".into(), json!(recorded_at(get(value, "recorded_at_minutes"))));
    summary
}

const KNOWLEDGE_SOURCE_KINDS: [&str; 4] = ["legacy", "world_fact_revealed", "knowledge_revealed", "npc"];

fn safe_knowledge_entry(value: Option<&Value>) -> Map<String, Value> {
    let hero_id = text(get(value, "hero_id"), 120);
    let fact_id = text(get(value, "fact_id"), 120);
    let kind = text(get(value, "source_kind"), 40);
    let source_kind = if has_str(&KNOWLEDGE_SOURCE_KINDS, &kind) { kind } else { "knowledge_revealed".into() };
    let id_value = match get(value, "id") {
        raw if js::truthy(raw) => text(raw, 120),
        _ => {
            let hero = str_value(&hero_id);
            let fact = str_value(&fact_id);
            text(Some(&Value::String(stable_id("knowledge", &[Some(&hero), Some(&fact), get(value, "revealed_event_id")]))), 120)
        }
    };
    let mut entry = Map::new();
    entry.insert("id".into(), Value::String(id_value));
    entry.insert("hero_id".into(), Value::String(hero_id));
    entry.insert("fact_id".into(), Value::String(fact_id));
    entry.insert("summary".into(), Value::String(text(get(value, "summary"), 1_000)));
    entry.insert("source_event_ids".into(), list_value(persisted_strings(get(value, "source_event_ids"), 120)));
    entry.insert("source_command_id".into(), Value::String(text(get(value, "source_command_id"), 160)));
    entry.insert("revealed_event_id".into(), Value::String(text(get(value, "revealed_event_id"), 120)));
    entry.insert("source_kind".into(), Value::String(source_kind));
    entry.insert("recorded_at_minutes".into(), json!(recorded_at(get(value, "recorded_at_minutes"))));
    entry
}

/// Индекс знаний `{ hero_id: [fact_id…] }` из журнала (`indexKnowledge`).
fn index_knowledge(entries: &[Value]) -> Value {
    let mut by_hero: IndexMap<String, IndexSet<String>> = IndexMap::new();
    for entry in entries {
        let hero = get(Some(entry), "hero_id");
        let fact = get(Some(entry), "fact_id");
        if !js::truthy(hero) || !js::truthy(fact) {
            continue;
        }
        by_hero.entry(s(hero)).or_default().insert(s(fact));
    }
    let map: Map<String, Value> = by_hero.into_iter().map(|(hero, facts)| (hero, Value::Array(facts.into_iter().map(Value::String).collect()))).collect();
    Value::Object(js_order(map))
}

fn knowledge_key(entry: &Value) -> String {
    format!("{}\u{0}{}", text(get(Some(entry), "hero_id"), 120), text(get(Some(entry), "fact_id"), 120))
}

fn legacy_index_entry(hero: &str, fact_id: &str) -> Value {
    let hero_value = str_value(hero);
    let fact_value = str_value(fact_id);
    json!({
        "id": stable_id("knowledge-legacy", &[Some(&hero_value), Some(&fact_value)]),
        "hero_id": hero,
        "fact_id": fact_id,
        "summary": "",
        "source_event_ids": [],
        "source_command_id": "legacy-world-memory",
        "source_kind": "legacy",
    })
}

/// Идентификаторы фактов из старого индекса: массив или `{ fact_ids }`.
fn legacy_fact_ids(raw: &Value) -> Option<&Value> {
    match raw {
        Value::Array(_) => Some(raw),
        other => get(Some(other), "fact_ids"),
    }
}

fn current_legacy_knowledge_entries(source: &Map<String, Value>, persisted_keys: &HashSet<String>) -> Vec<Value> {
    let mut result = Vec::new();
    for (hero_id, raw) in entries(coalesce(source.get("knowledge"), None)) {
        let hero = text(Some(&Value::String(hero_id)), 120);
        for fact_id in persisted_strings(legacy_fact_ids(&raw), 120) {
            if hero.is_empty() || persisted_keys.contains(&format!("{hero}\u{0}{fact_id}")) {
                continue;
            }
            result.push(Value::Object(safe_knowledge_entry(Some(&legacy_index_entry(&hero, &fact_id)))));
        }
    }
    result
}

/// Журнал знаний, сохранённый в схеме v2; явно отсутствующий v2-журнал значит
/// миграцию старого снимка, и производный псевдоним не сохраняется.
fn persisted_ledger(source: &Map<String, Value>) -> &[Value] {
    match source.get("knowledge_ledger") {
        Some(Value::Array(items)) => items,
        Some(_) => &[],
        None => array(source.get("knowledge_revealed")),
    }
}

fn source_object(input: &Value) -> &Map<String, Value> {
    static EMPTY: LazyLock<Map<String, Value>> = LazyLock::new(Map::new);
    match input {
        Value::Object(map) => map,
        _ => &EMPTY,
    }
}

fn collection<F>(source: &Map<String, Value>, key: &str, normalize: F) -> Vec<Value>
where
    F: Fn(Option<&Value>) -> Map<String, Value>,
{
    array(source.get(key)).iter().map(|item| Value::Object(normalize(Some(item)))).collect()
}

fn memory_value(parts: [(&str, Value); 11]) -> Value {
    Value::Object(parts.into_iter().map(|(key, value)| (key.to_string(), value)).collect())
}

/// Схема v2 хранит индекс `knowledge` v1 для совместимости и неизменяемый
/// журнал `knowledge_revealed`. Каноническая правда — `facts`; убеждения и
/// слухи NPC живут отдельно в `epistemic_claims`.
fn normalize_world_memory_current(input: &Value) -> Value {
    let source = source_object(input);
    let entities = collection(source, "entities", safe_entity);
    let facts = collection(source, "facts", safe_fact);
    let relationships = collection(source, "relationships", safe_relationship);
    let quests = collection(source, "quests", safe_quest);
    let threads = collection(source, "threads", safe_thread);
    let claims = collection(source, "epistemic_claims", safe_epistemic_claim);
    let summaries = collection(source, "summaries", safe_summary);
    let persisted = persisted_ledger(source);
    // Переход v1→v2 мог оставить и новый пустой журнал, и старый индекс:
    // старая запись, которой ещё нет в журнале, сохраняется.
    let persisted_keys: HashSet<String> = persisted.iter().map(knowledge_key).collect();
    let mut raw_ledger: Vec<Value> = persisted.to_vec();
    raw_ledger.extend(current_legacy_knowledge_entries(source, &persisted_keys));
    let known: Vec<Value> = raw_ledger.iter().map(|entry| Value::Object(safe_knowledge_entry(Some(entry)))).collect();
    memory_value([
        ("schema_version", json!(2)),
        ("entities", Value::Array(entities)),
        ("facts", Value::Array(facts)),
        ("relationships", Value::Array(relationships)),
        ("quests", Value::Array(quests)),
        ("threads", Value::Array(threads)),
        ("epistemic_claims", Value::Array(claims)),
        ("summaries", Value::Array(summaries)),
        ("knowledge", index_knowledge(&known)),
        ("knowledge_revealed", Value::Array(known.clone())),
        ("knowledge_ledger", Value::Array(known)),
    ])
}

fn truncate_list(map: &mut Map<String, Value>, key: &str, limit: usize) {
    if let Some(Value::Array(items)) = map.get_mut(key) {
        items.truncate(limit);
    }
}

fn legacy_entity(value: Option<&Value>) -> Map<String, Value> {
    let mut item = safe_entity(value);
    truncate_list(&mut item, "aliases", 20);
    truncate_list(&mut item, "tags", 20);
    item
}

fn legacy_fact(value: Option<&Value>) -> Map<String, Value> {
    let mut item = safe_fact(value);
    truncate_list(&mut item, "source_event_ids", 30);
    item
}

fn legacy_relationship(value: Option<&Value>) -> Map<String, Value> {
    let mut item = safe_relationship(value);
    truncate_list(&mut item, "source_event_ids", 30);
    item
}

fn legacy_quest(value: Option<&Value>) -> Map<String, Value> {
    let mut item = safe_quest(value);
    item.shift_remove("knowledge_history");
    truncate_list(&mut item, "entity_ids", 30);
    truncate_list(&mut item, "objectives", 20);
    item
}

fn legacy_thread(value: Option<&Value>) -> Map<String, Value> {
    let mut item = safe_thread(value);
    truncate_list(&mut item, "entity_ids", 30);
    truncate_list(&mut item, "quest_ids", 30);
    truncate_list(&mut item, "source_event_ids", 30);
    item
}

fn legacy_claim(value: Option<&Value>) -> Map<String, Value> {
    let mut item = safe_epistemic_claim(value);
    truncate_list(&mut item, "source_event_ids", 30);
    truncate_list(&mut item, "truth_source_event_ids", 30);
    item
}

fn legacy_summary(value: Option<&Value>) -> Map<String, Value> {
    let mut item = safe_summary(value);
    truncate_list(&mut item, "entity_ids", 30);
    truncate_list(&mut item, "thread_ids", 30);
    truncate_list(&mut item, "source_event_ids", 50);
    item
}

fn legacy_knowledge_entry(value: Option<&Value>) -> Map<String, Value> {
    let mut item = safe_knowledge_entry(value);
    truncate_list(&mut item, "source_event_ids", 30);
    item
}

fn legacy_knowledge_entries(source: &Map<String, Value>, fact_ids: &HashSet<String>) -> Vec<Value> {
    let mut result = Vec::new();
    for (hero_id, raw) in entries(coalesce(source.get("knowledge"), None)).into_iter().take(100) {
        let hero = text(Some(&Value::String(hero_id)), 120);
        for fact_id in persisted_strings(legacy_fact_ids(&raw), 120).into_iter().take(2_000) {
            if hero.is_empty() || !fact_ids.contains(&fact_id) {
                continue;
            }
            result.push(Value::Object(legacy_knowledge_entry(Some(&legacy_index_entry(&hero, &fact_id)))));
        }
    }
    result
}

fn field_str<'a>(map: &'a Map<String, Value>, key: &str) -> &'a str {
    map.get(key).and_then(Value::as_str).unwrap_or("")
}

fn field_list(map: &Map<String, Value>, key: &str) -> Vec<String> {
    array(map.get(key)).iter().map(|item| s(Some(item))).collect()
}

fn ids_of(items: &[Map<String, Value>]) -> HashSet<String> {
    items.iter().map(|item| field_str(item, "id").to_string()).collect()
}

fn keep_last<T>(mut items: Vec<T>, limit: usize) -> Vec<T> {
    if items.len() > limit {
        items.drain(..items.len() - limit);
    }
    items
}

fn objects(items: Vec<Map<String, Value>>) -> Value {
    Value::Array(items.into_iter().map(Value::Object).collect())
}

/// Нормализация до перехода на бессрочное хранение памяти
/// (`normalizeWorldMemoryLegacy`): прежние пределы коллекций и фильтры ссылок.
pub fn normalize_world_memory_legacy(input: &Value) -> Value {
    let source = source_object(input);
    let list = |key: &str| array(source.get(key));
    let entities: Vec<Map<String, Value>> =
        list("entities").iter().map(|item| legacy_entity(Some(item))).filter(|item| !field_str(item, "id").is_empty() && !field_str(item, "name").is_empty()).take(500).collect();
    let entity_ids = ids_of(&entities);
    let facts: Vec<Map<String, Value>> = list("facts")
        .iter()
        .map(|item| legacy_fact(Some(item)))
        .filter(|item| {
            !field_str(item, "id").is_empty() && !field_str(item, "subject_id").is_empty() && !field_str(item, "predicate").is_empty() && entity_ids.contains(field_str(item, "subject_id"))
        })
        .take(2_000)
        .collect();
    let fact_ids = ids_of(&facts);
    let relationships: Vec<Map<String, Value>> = list("relationships")
        .iter()
        .map(|item| legacy_relationship(Some(item)))
        .filter(|item| {
            let from = field_str(item, "from_entity_id");
            let to = field_str(item, "to_entity_id");
            !field_str(item, "id").is_empty() && !from.is_empty() && !field_str(item, "relation").is_empty() && !to.is_empty() && entity_ids.contains(from) && entity_ids.contains(to)
        })
        .take(2_000)
        .collect();
    let quests: Vec<Map<String, Value>> =
        list("quests").iter().map(|item| legacy_quest(Some(item))).filter(|item| !field_str(item, "id").is_empty() && !field_str(item, "title").is_empty()).take(300).collect();
    let quest_ids = ids_of(&quests);
    let threads: Vec<Map<String, Value>> = list("threads")
        .iter()
        .map(|item| legacy_thread(Some(item)))
        .filter(|item| {
            !field_str(item, "id").is_empty()
                && !field_str(item, "title").is_empty()
                && field_list(item, "entity_ids").iter().all(|entity| entity_ids.contains(entity))
                && field_list(item, "quest_ids").iter().all(|quest| quest_ids.contains(quest))
        })
        .take(500)
        .collect();
    let thread_ids = ids_of(&threads);
    let claims: Vec<Map<String, Value>> = list("epistemic_claims")
        .iter()
        .map(|item| legacy_claim(Some(item)))
        .filter(|item| {
            let holder = field_str(item, "holder_entity_id");
            let subject = field_str(item, "subject_entity_id");
            !field_str(item, "id").is_empty() && !holder.is_empty() && !field_str(item, "claim").is_empty() && entity_ids.contains(holder) && (subject.is_empty() || entity_ids.contains(subject))
        })
        .take(2_000)
        .collect();
    let summaries: Vec<Map<String, Value>> = list("summaries")
        .iter()
        .map(|item| legacy_summary(Some(item)))
        .filter(|item| {
            !field_str(item, "id").is_empty()
                && !field_str(item, "title").is_empty()
                && !field_str(item, "summary").is_empty()
                && field_list(item, "entity_ids").iter().all(|entity| entity_ids.contains(entity))
                && field_list(item, "thread_ids").iter().all(|thread| thread_ids.contains(thread))
        })
        .collect();
    let summaries = keep_last(summaries, 1_000);
    let legacy_entries = legacy_knowledge_entries(source, &fact_ids);
    let persisted = persisted_ledger(source);
    let persisted_keys: HashSet<String> = persisted.iter().map(knowledge_key).collect();
    let mut raw_ledger: Vec<Value> = persisted.to_vec();
    raw_ledger.extend(legacy_entries.into_iter().filter(|entry| !persisted_keys.contains(&format!("{}\u{0}{}", s(get(Some(entry), "hero_id")), s(get(Some(entry), "fact_id"))))));
    let known: Vec<Map<String, Value>> = raw_ledger
        .iter()
        .map(|entry| legacy_knowledge_entry(Some(entry)))
        .filter(|item| !field_str(item, "id").is_empty() && !field_str(item, "hero_id").is_empty() && fact_ids.contains(field_str(item, "fact_id")))
        .collect();
    let known = keep_last(known, 5_000);
    let mut by_id: IndexMap<String, Map<String, Value>> = IndexMap::new();
    for item in known {
        by_id.insert(field_str(&item, "id").to_string(), item);
    }
    let revealed: Vec<Value> = by_id.into_values().map(Value::Object).collect();
    memory_value([
        ("schema_version", json!(2)),
        ("entities", objects(entities)),
        ("facts", objects(facts)),
        ("relationships", objects(relationships)),
        ("quests", objects(quests)),
        ("threads", objects(threads)),
        ("epistemic_claims", objects(claims)),
        ("summaries", objects(summaries)),
        ("knowledge", index_knowledge(&revealed)),
        ("knowledge_revealed", Value::Array(revealed.clone())),
        ("knowledge_ledger", Value::Array(revealed)),
    ])
}

fn legacy_mode() -> bool {
    retention_mode() == "legacy"
}

/// Каноническая память мира (`normalizeWorldMemory`): в контексте
/// `legacy` — прежние пределы, иначе бессрочное хранение.
pub fn normalize_world_memory(input: &Value) -> Value {
    if legacy_mode() {
        normalize_world_memory_legacy(input)
    } else {
        normalize_world_memory_current(input)
    }
}

fn memory_issue(issues: &mut Vec<Value>, collection: &str, record: Option<&Value>, field: Option<&str>, target_id: Option<&Value>, code: &str, index: Option<usize>) {
    let mut issue = Map::new();
    issue.insert("code".into(), str_value(code));
    issue.insert("collection".into(), str_value(collection));
    issue.insert("id".into(), Value::String(text(get(record, "id"), 120)));
    issue.insert("field".into(), field.map(str_value).unwrap_or(Value::Null));
    if let Some(target) = target_id.filter(|target| !target.is_null()) {
        issue.insert("target_id".into(), Value::String(text(Some(target), 120)));
    }
    if let Some(index) = index {
        issue.insert("index".into(), json!(index));
    }
    issues.push(Value::Object(issue));
}

const MEMORY_COLLECTIONS: [&str; 8] = ["entities", "facts", "relationships", "quests", "threads", "epistemic_claims", "summaries", "knowledge_ledger"];

/// Детерминированная диагностика целостности (`diagnoseWorldMemory`), не
/// изменяющая каноническую память: битые записи остаются в нормализованном
/// состоянии, чтобы оператор мог исправить их по ID.
pub fn diagnose_world_memory(input: &Value) -> Vec<Value> {
    let source = source_object(input);
    let memory = normalize_world_memory_current(input);
    let mut issues = Vec::new();
    for collection in MEMORY_COLLECTIONS {
        if source.get(collection).is_some_and(|value| !value.is_array()) {
            memory_issue(&mut issues, collection, Some(&json!({})), None, None, "WORLD_MEMORY_COLLECTION_INVALID", None);
        }
    }
    let records = |collection: &str| array(memory.get(collection)).to_vec();
    let mut ids: HashMap<&str, HashSet<String>> = MEMORY_COLLECTIONS.iter().map(|collection| (*collection, HashSet::new())).collect();
    for collection in MEMORY_COLLECTIONS {
        for (index, record) in records(collection).iter().enumerate() {
            let record_id = s(get(Some(record), "id"));
            let seen = ids.get_mut(collection).expect("коллекция из списка");
            if record_id.is_empty() {
                memory_issue(&mut issues, collection, Some(record), Some("id"), None, "WORLD_MEMORY_RECORD_ID_INVALID", Some(index));
            } else if seen.contains(&record_id) {
                memory_issue(&mut issues, collection, Some(record), Some("id"), get(Some(record), "id"), "WORLD_MEMORY_DUPLICATE_ID", Some(index));
            } else {
                seen.insert(record_id);
            }
        }
    }
    let check_refs = |issues: &mut Vec<Value>, collection: &str, field: &str, target: &str, targets: &dyn Fn(&Value) -> Vec<Value>| {
        for (index, record) in records(collection).iter().enumerate() {
            for target_id in targets(record) {
                if !js::truthy(Some(&target_id)) || !ids[target].contains(&s(Some(&target_id))) {
                    memory_issue(issues, collection, Some(record), Some(field), Some(&target_id), "WORLD_MEMORY_BROKEN_REFERENCE", Some(index));
                }
            }
        }
    };
    let one = |key: &'static str| move |record: &Value| vec![get(Some(record), key).cloned().unwrap_or(Value::Null)];
    let optional = |key: &'static str| {
        move |record: &Value| match get(Some(record), key) {
            Some(value) if js::truthy(Some(value)) => vec![value.clone()],
            _ => Vec::new(),
        }
    };
    let many = |key: &'static str| move |record: &Value| array(get(Some(record), key)).to_vec();
    check_refs(&mut issues, "facts", "subject_id", "entities", &one("subject_id"));
    check_refs(&mut issues, "facts", "supersedes_fact_id", "facts", &optional("supersedes_fact_id"));
    check_refs(&mut issues, "relationships", "from_entity_id", "entities", &one("from_entity_id"));
    check_refs(&mut issues, "relationships", "to_entity_id", "entities", &one("to_entity_id"));
    check_refs(&mut issues, "relationships", "supersedes_relationship_id", "relationships", &optional("supersedes_relationship_id"));
    check_refs(&mut issues, "quests", "entity_ids", "entities", &many("entity_ids"));
    check_refs(&mut issues, "threads", "entity_ids", "entities", &many("entity_ids"));
    check_refs(&mut issues, "threads", "quest_ids", "quests", &many("quest_ids"));
    check_refs(&mut issues, "epistemic_claims", "holder_entity_id", "entities", &one("holder_entity_id"));
    check_refs(&mut issues, "epistemic_claims", "subject_entity_id", "entities", &optional("subject_entity_id"));
    check_refs(&mut issues, "summaries", "entity_ids", "entities", &many("entity_ids"));
    check_refs(&mut issues, "summaries", "thread_ids", "threads", &many("thread_ids"));
    check_refs(&mut issues, "knowledge_ledger", "fact_id", "facts", &one("fact_id"));
    let empty = |record: &Value, key: &str| s(get(Some(record), key)).is_empty();
    let content_checks: [(&str, &str, &str, &dyn Fn(&Value) -> bool); 7] = [
        ("entities", "name", "WORLD_MEMORY_ENTITY_NAME_INVALID", &|record| empty(record, "name")),
        ("facts", "content", "WORLD_MEMORY_FACT_CONTENT_INVALID", &|record| empty(record, "predicate") || (empty(record, "object") && empty(record, "summary"))),
        ("relationships", "content", "WORLD_MEMORY_RELATIONSHIP_CONTENT_INVALID", &|record| empty(record, "relation") || empty(record, "summary")),
        ("quests", "title", "WORLD_MEMORY_QUEST_TITLE_INVALID", &|record| empty(record, "title")),
        ("threads", "title", "WORLD_MEMORY_THREAD_TITLE_INVALID", &|record| empty(record, "title")),
        ("epistemic_claims", "claim", "WORLD_MEMORY_CLAIM_INVALID", &|record| empty(record, "claim")),
        ("summaries", "content", "WORLD_MEMORY_SUMMARY_INVALID", &|record| empty(record, "title") || empty(record, "summary")),
    ];
    for (collection, field, code, broken) in content_checks {
        for (index, record) in records(collection).iter().enumerate() {
            if broken(record) {
                memory_issue(&mut issues, collection, Some(record), Some(field), None, code, Some(index));
            }
        }
    }
    issues
}

// ---------------------------------------------------------------------------
// Проверка команд
// ---------------------------------------------------------------------------

fn memory_list<'a>(memory: &'a Value, key: &str) -> &'a [Value] {
    array(memory.get(key))
}

fn find_by_id<'a>(list: &'a [Value], id: &str) -> Option<&'a Value> {
    list.iter().find(|item| is_str(get(Some(item), "id"), id))
}

fn exists(list: &[Value], id: &str) -> bool {
    find_by_id(list, id).is_some()
}

/// `clock(value.clock)` у входа команды: `null` в JS обрывает проверку
/// исключением `TypeError` (команда не проходит); здесь — отказ с тем же текстом.
fn input_clock(value: &Map<String, Value>) -> Checked<Value> {
    if value.get("clock").is_some_and(Value::is_null) {
        return invalid("Cannot read properties of null (reading 'max')", "WORLD_MEMORY_TYPE_ERROR");
    }
    Ok(clock(value.get("clock")))
}

fn check_clock_shape(value: &Map<String, Value>, label: &str) -> Checked<()> {
    if let Some(clock) = value.get("clock").filter(|clock| !clock.is_null()) {
        let clock = plain_object(Some(clock), label)?;
        assert_fields(clock, &["current", "max", "label"], label)?;
    }
    Ok(())
}

fn normalize_entity_input(input: Option<&Value>) -> Checked<Value> {
    let value = plain_object(input, "entity")?;
    assert_fields(value, &["id", "kind", "name", "summary", "aliases", "visibility", "tags"], "entity")?;
    let kind = text(value.get("kind"), 30);
    if !has_str(&ENTITY_KINDS, &kind) {
        return invalid("Неизвестный тип сущности мира", "WORLD_ENTITY_KIND_INVALID");
    }
    let mut result = Map::new();
    result.insert("id".into(), Value::String(id(value.get("id"), "entity.id")?));
    result.insert("kind".into(), Value::String(kind));
    let name = text(value.get("name"), 160);
    result.insert("name".into(), Value::String(name.clone()));
    result.insert("summary".into(), Value::String(text(value.get("summary"), 1_000)));
    result.insert("aliases".into(), list_value(strings(value.get("aliases"), 120, 20)));
    result.insert("visibility".into(), Value::String(visibility(value.get("visibility"), "gm_only")?));
    result.insert("tags".into(), list_value(strings(value.get("tags"), 60, 20)));
    if name.is_empty() {
        return invalid("У сущности мира должно быть имя", "WORLD_ENTITY_NAME_REQUIRED");
    }
    Ok(Value::Object(result))
}

fn normalize_fact_input(input: Option<&Value>, memory: &Value, command_id: Option<&Value>, state: &Value) -> Checked<Value> {
    let value = plain_object(input, "fact")?;
    assert_fields(value, &["id", "subject_id", "predicate", "object", "summary", "visibility", "source_event_ids", "supersedes_fact_id"], "fact")?;
    let fact_id = id(value.get("id"), "fact.id")?;
    let subject_id = id(value.get("subject_id"), "fact.subject_id")?;
    let predicate = text(value.get("predicate"), 120);
    let object_text = text(value.get("object"), 1_000);
    let summary = text(value.get("summary"), 1_000);
    let fact_visibility = visibility(value.get("visibility"), "gm_only")?;
    let source_event_ids = strings(value.get("source_event_ids"), 120, 30);
    let supersedes = if js::truthy(value.get("supersedes_fact_id")) { id(value.get("supersedes_fact_id"), "fact.supersedes_fact_id")? } else { String::new() };
    let facts = memory_list(memory, "facts");
    if !exists(memory_list(memory, "entities"), &subject_id) {
        return invalid("Сущность факта не найдена", "WORLD_ENTITY_NOT_FOUND");
    }
    if predicate.is_empty() || (object_text.is_empty() && summary.is_empty()) {
        return invalid("Факт должен содержать predicate и object/summary", "WORLD_FACT_CONTENT_REQUIRED");
    }
    if exists(facts, &fact_id) {
        return invalid("Факт с таким id уже существует; создайте новый факт с supersedes_fact_id", "WORLD_FACT_ALREADY_EXISTS");
    }
    if !supersedes.is_empty() && !facts.iter().any(|fact| is_str(get(Some(fact), "id"), &supersedes) && is_str(get(Some(fact), "status"), "active")) {
        return invalid("Заменяемый факт не найден", "WORLD_FACT_NOT_FOUND");
    }
    Ok(json!({
        "id": fact_id,
        "subject_id": subject_id,
        "predicate": predicate,
        "object": object_text,
        "summary": summary,
        "visibility": fact_visibility,
        "source_event_ids": source_event_ids,
        "source_command_id": text(command_id, 160),
        "supersedes_fact_id": supersedes,
        "status": "active",
        "recorded_at_minutes": elapsed_minutes(state),
    }))
}

fn normalize_relationship_input(input: Option<&Value>, memory: &Value, command_id: Option<&Value>, state: &Value) -> Checked<Value> {
    let value = plain_object(input, "relationship")?;
    assert_fields(value, &["id", "from_entity_id", "relation", "to_entity_id", "summary", "visibility", "source_event_ids", "supersedes_relationship_id"], "relationship")?;
    let relationship_id = id(value.get("id"), "relationship.id")?;
    let from = id(value.get("from_entity_id"), "relationship.from_entity_id")?;
    let relation = text(value.get("relation"), 120);
    let to = id(value.get("to_entity_id"), "relationship.to_entity_id")?;
    let summary = text(value.get("summary"), 1_000);
    let relationship_visibility = visibility(value.get("visibility"), "gm_only")?;
    let source_event_ids = strings(value.get("source_event_ids"), 120, 30);
    let supersedes = if js::truthy(value.get("supersedes_relationship_id")) {
        id(value.get("supersedes_relationship_id"), "relationship.supersedes_relationship_id")?
    } else {
        String::new()
    };
    let entities = memory_list(memory, "entities");
    let relationships = memory_list(memory, "relationships");
    if !exists(entities, &from) || !exists(entities, &to) {
        return invalid("Сущность отношения не найдена", "WORLD_ENTITY_NOT_FOUND");
    }
    if relation.is_empty() || summary.is_empty() {
        return invalid("Отношение должно содержать relation и summary", "WORLD_RELATIONSHIP_CONTENT_REQUIRED");
    }
    if exists(relationships, &relationship_id) {
        return invalid("Отношение с таким id уже существует; создайте новое с supersedes_relationship_id", "WORLD_RELATIONSHIP_ALREADY_EXISTS");
    }
    if !supersedes.is_empty() && !relationships.iter().any(|item| is_str(get(Some(item), "id"), &supersedes) && is_str(get(Some(item), "status"), "active")) {
        return invalid("Заменяемое отношение не найдено", "WORLD_RELATIONSHIP_NOT_FOUND");
    }
    Ok(json!({
        "id": relationship_id,
        "from_entity_id": from,
        "relation": relation,
        "to_entity_id": to,
        "summary": summary,
        "visibility": relationship_visibility,
        "source_event_ids": source_event_ids,
        "source_command_id": text(command_id, 160),
        "supersedes_relationship_id": supersedes,
        "status": "active",
        "recorded_at_minutes": elapsed_minutes(state),
    }))
}

fn status_or_active(value: Option<&Value>) -> String {
    let active = str_value("active");
    text(or(value, Some(&active)), 30)
}

fn normalize_quest_input(input: Option<&Value>, memory: &Value, state: &Value) -> Checked<Value> {
    let value = plain_object(input, "quest")?;
    assert_fields(value, &["id", "title", "summary", "status", "visibility", "entity_ids", "objectives", "clock", "responsibility", "giver_npc_id"], "quest")?;
    check_clock_shape(value, "quest.clock")?;
    let quest_id = id(value.get("id"), "quest.id")?;
    let previous = find_by_id(memory_list(memory, "quests"), &quest_id);
    let mut result = Map::new();
    result.insert("id".into(), Value::String(quest_id));
    result.insert("title".into(), Value::String(text(value.get("title"), 180)));
    result.insert("summary".into(), Value::String(text(value.get("summary"), 1_000)));
    let status = status_or_active(value.get("status"));
    result.insert("status".into(), Value::String(status.clone()));
    result.insert("visibility".into(), Value::String(visibility(value.get("visibility"), "party")?));
    let entity_ids = strings(value.get("entity_ids"), 120, 30);
    result.insert("entity_ids".into(), list_value(entity_ids.clone()));
    result.insert("objectives".into(), list_value(strings(value.get("objectives"), 300, 20)));
    result.insert("clock".into(), input_clock(value)?);
    result.insert("recorded_at_minutes".into(), json!(elapsed_minutes(state)));
    // Подтверждения прогресса не сбрасываются обновлением цели.
    for key in ["progress_fact_ids", "progress_source_event_ids"] {
        if let Some(Value::Array(items)) = get(previous, key) {
            if !items.is_empty() {
                result.insert(key.into(), Value::Array(items.clone()));
            }
        }
    }
    if !has_str(&QUEST_STATUSES, &status) {
        return invalid("Неизвестный статус квеста", "WORLD_QUEST_STATUS_INVALID");
    }
    if s(result.get("title")).is_empty() {
        return invalid("У квеста должен быть заголовок", "WORLD_QUEST_TITLE_REQUIRED");
    }
    if entity_ids.iter().any(|entity| !exists(memory_list(memory, "entities"), entity)) {
        return invalid("Квест ссылается на неизвестную сущность", "WORLD_ENTITY_NOT_FOUND");
    }
    // Техническое обновление старого поручения не снимает его зависимость.
    let responsibility = normalize_quest_responsibility(coalesce(value.get("responsibility"), get(previous, "responsibility")));
    if js::present(value.get("responsibility")) && responsibility.is_none() {
        return invalid("Неизвестная политика ответственности по поручению", "WORLD_QUEST_RESPONSIBILITY_INVALID");
    }
    if let Some(responsibility) = responsibility {
        let found = if is_str(responsibility.get("type"), "npc") {
            array(get(get(Some(state), "social"), "npcs")).iter().any(|npc| strict_eq(get(Some(npc), "id"), responsibility.get("npc_id")))
        } else {
            array(get(get(Some(state), "world_offices"), "offices")).iter().any(|office| strict_eq(get(Some(office), "id"), responsibility.get("office_id")))
        };
        if !found {
            return invalid("Ответственный за поручение не найден", "WORLD_QUEST_RESPONSIBILITY_INVALID");
        }
        let giver = quest_giver_id(state, Some(&responsibility)).unwrap_or(Value::Null);
        result.insert("responsibility".into(), responsibility);
        result.insert("giver_npc_id".into(), giver);
        let quest = Value::Object(result);
        if (status == "active" || status == "offered") && quest_is_impossible(state, Some(&quest)) {
            return invalid("Поручение невозможно: необходимый NPC погиб", "WORLD_QUEST_IMPOSSIBLE");
        }
        return Ok(quest);
    }
    Ok(Value::Object(result))
}

fn normalize_thread_input(input: Option<&Value>, memory: &Value, command_id: Option<&Value>, state: &Value) -> Checked<Value> {
    let value = plain_object(input, "thread")?;
    assert_fields(value, &["id", "title", "summary", "status", "visibility", "entity_ids", "quest_ids", "clock", "source_event_ids"], "thread")?;
    check_clock_shape(value, "thread.clock")?;
    let thread_id = id(value.get("id"), "thread.id")?;
    let title = text(value.get("title"), 180);
    let summary = text(value.get("summary"), 1_000);
    let status = status_or_active(value.get("status"));
    let thread_visibility = visibility(value.get("visibility"), "party")?;
    let entity_ids = strings(value.get("entity_ids"), 120, 30);
    let quest_ids = strings(value.get("quest_ids"), 120, 30);
    let thread_clock = input_clock(value)?;
    let source_event_ids = strings(value.get("source_event_ids"), 120, 30);
    if !has_str(&THREAD_STATUSES, &status) {
        return invalid("Неизвестный статус сюжетной нити", "WORLD_THREAD_STATUS_INVALID");
    }
    if title.is_empty() {
        return invalid("У сюжетной нити должен быть заголовок", "WORLD_THREAD_TITLE_REQUIRED");
    }
    if entity_ids.iter().any(|entity| !exists(memory_list(memory, "entities"), entity)) {
        return invalid("Нить ссылается на неизвестную сущность", "WORLD_ENTITY_NOT_FOUND");
    }
    if quest_ids.iter().any(|quest| !exists(memory_list(memory, "quests"), quest)) {
        return invalid("Нить ссылается на неизвестный квест", "WORLD_QUEST_NOT_FOUND");
    }
    Ok(json!({
        "id": thread_id,
        "title": title,
        "summary": summary,
        "status": status,
        "visibility": thread_visibility,
        "entity_ids": entity_ids,
        "quest_ids": quest_ids,
        "clock": thread_clock,
        "source_event_ids": source_event_ids,
        "source_command_id": text(command_id, 160),
        "recorded_at_minutes": elapsed_minutes(state),
    }))
}

fn normalize_epistemic_claim_input(input: Option<&Value>, memory: &Value, command_id: Option<&Value>, state: &Value, kind: &str) -> Checked<Value> {
    let label = if kind == "rumor" { "rumor" } else { "belief" };
    let value = plain_object(input, label)?;
    assert_fields(value, &["id", "holder_entity_id", "subject_entity_id", "predicate", "claim", "summary", "visibility", "source_event_ids"], label)?;
    let claim_id = id(value.get("id"), "claim.id")?;
    let holder_id = id(value.get("holder_entity_id"), "claim.holder_entity_id")?;
    let subject_id = if js::truthy(value.get("subject_entity_id")) { id(value.get("subject_entity_id"), "claim.subject_entity_id")? } else { String::new() };
    let predicate = text(value.get("predicate"), 120);
    let claim_text = text(value.get("claim"), 1_000);
    let summary = text(value.get("summary"), 1_000);
    let claim_visibility = visibility(value.get("visibility"), "gm_only")?;
    let source_event_ids = strings(value.get("source_event_ids"), 120, 30);
    let entities = memory_list(memory, "entities");
    let holder = find_by_id(entities, &holder_id);
    if !holder.is_some_and(|holder| is_str(get(Some(holder), "kind"), "npc")) {
        return invalid("Убеждение или слух должен принадлежать известному NPC", "WORLD_NPC_BELIEF_HOLDER_INVALID");
    }
    if !subject_id.is_empty() && !exists(entities, &subject_id) {
        return invalid("Сущность утверждения не найдена", "WORLD_ENTITY_NOT_FOUND");
    }
    if claim_text.is_empty() {
        return invalid("Убеждение или слух не может быть пустым", "WORLD_EPISTEMIC_CLAIM_REQUIRED");
    }
    if exists(memory_list(memory, "epistemic_claims"), &claim_id) {
        return invalid("Убеждение или слух с таким id уже существует", "WORLD_EPISTEMIC_CLAIM_ALREADY_EXISTS");
    }
    Ok(json!({
        "id": claim_id,
        "kind": kind,
        "holder_entity_id": holder_id,
        "subject_entity_id": subject_id,
        "predicate": predicate,
        "claim": claim_text,
        "summary": summary,
        "visibility": claim_visibility,
        "truth_status": "unknown",
        "source_event_ids": source_event_ids,
        "source_command_id": text(command_id, 160),
        "truth_source_event_ids": [],
        "truth_source_command_id": "",
        "recorded_at_minutes": elapsed_minutes(state),
    }))
}

fn normalize_summary_input(input: Option<&Value>, memory: &Value, command_id: Option<&Value>, state: &Value) -> Checked<Value> {
    let value = plain_object(input, "summary")?;
    assert_fields(value, &["id", "kind", "title", "summary", "visibility", "entity_ids", "thread_ids", "source_event_ids"], "summary")?;
    let summary_id = id(value.get("id"), "summary.id")?;
    let scene = str_value("scene");
    let kind = text(or(value.get("kind"), Some(&scene)), 30);
    let title = text(value.get("title"), 180);
    let summary = text(value.get("summary"), 2_000);
    let summary_visibility = visibility(value.get("visibility"), "party")?;
    let entity_ids = strings(value.get("entity_ids"), 120, 30);
    let thread_ids = strings(value.get("thread_ids"), 120, 30);
    let source_event_ids = strings(value.get("source_event_ids"), 120, 50);
    if !has_str(&SUMMARY_KINDS, &kind) {
        return invalid("Неизвестный тип summary", "WORLD_SUMMARY_KIND_INVALID");
    }
    if title.is_empty() || summary.is_empty() {
        return invalid("Summary должен содержать title и summary", "WORLD_SUMMARY_CONTENT_REQUIRED");
    }
    if source_event_ids.is_empty() {
        return invalid("Summary требует source_event_ids", "WORLD_SUMMARY_PROVENANCE_REQUIRED");
    }
    if exists(memory_list(memory, "summaries"), &summary_id) {
        return invalid("Summary с таким id уже существует", "WORLD_SUMMARY_ALREADY_EXISTS");
    }
    if entity_ids.iter().any(|entity| !exists(memory_list(memory, "entities"), entity)) {
        return invalid("Summary ссылается на неизвестную сущность", "WORLD_ENTITY_NOT_FOUND");
    }
    if thread_ids.iter().any(|thread| !exists(memory_list(memory, "threads"), thread)) {
        return invalid("Summary ссылается на неизвестную нить", "WORLD_THREAD_NOT_FOUND");
    }
    Ok(json!({
        "id": summary_id,
        "kind": kind,
        "title": title,
        "summary": summary,
        "visibility": summary_visibility,
        "entity_ids": entity_ids,
        "thread_ids": thread_ids,
        "source_event_ids": source_event_ids,
        "source_command_id": text(command_id, 160),
        "recorded_at_minutes": elapsed_minutes(state),
    }))
}

fn validate_knowledge_targets(target_ids: Option<&Value>, state: &Value) -> Checked<Vec<String>> {
    let targets = strings(target_ids, 120, 20);
    let party: HashSet<String> = array(get(Some(state), "partyMemberIds")).iter().map(|id| string(Some(id))).collect();
    if targets.is_empty() || targets.iter().any(|actor| !party.contains(actor)) {
        return invalid("Знание можно открыть только конкретным героям группы", "WORLD_KNOWLEDGE_TARGET_INVALID");
    }
    Ok(targets)
}

/// Проверка команды памяти мира (`validateWorldMemoryCommand`). Команду
/// другого типа возвращает как есть; команду памяти принимает только от
/// системного контура (`context.isAdmin` или `context.isDirector`) и
/// возвращает её с нормализованной записью, `actor_id: null` и видимостью.
pub fn validate_world_memory_command(command: &Value, state: &Value, context: &Value) -> Checked<Value> {
    let command_type = get(Some(command), "command_type");
    if !has(&WORLD_MEMORY_COMMAND_TYPES, command_type) {
        return Ok(command.clone());
    }
    if !js::is_true(get(Some(context), "isAdmin")) && !js::is_true(get(Some(context), "isDirector")) {
        return invalid("Память мира изменяет только системный контур кампании", "WORLD_MEMORY_FORBIDDEN");
    }
    let memory = normalize_world_memory(get(Some(state), "worldMemory").unwrap_or(&Value::Null));
    let mut result = spread_object(Some(command));
    result.insert("actor_id".into(), Value::Null);
    let command_id = get(Some(command), "command_id");
    let set = |result: &mut Map<String, Value>, key: &str, value: Value| {
        result.insert(key.to_string(), value);
    };
    let record_visibility = |record: &Value| record.get("visibility").cloned().unwrap_or(Value::Null);
    match command_type.and_then(Value::as_str).unwrap_or("") {
        "UpsertWorldEntity" => {
            let entity = normalize_entity_input(get(Some(command), "entity"))?;
            set(&mut result, "entity", entity.clone());
            set(&mut result, "visibility", record_visibility(&entity));
        }
        "RecordWorldFact" => {
            let fact = normalize_fact_input(get(Some(command), "fact"), &memory, command_id, state)?;
            set(&mut result, "fact", fact.clone());
            set(&mut result, "visibility", record_visibility(&fact));
        }
        "RecordWorldRelationship" => {
            let relationship = normalize_relationship_input(get(Some(command), "relationship"), &memory, command_id, state)?;
            set(&mut result, "relationship", relationship.clone());
            set(&mut result, "visibility", record_visibility(&relationship));
        }
        "RevealWorldFact" | "RecordKnowledgeRevelation" => {
            let fact_id = id(get(Some(command), "fact_id"), "fact_id")?;
            set(&mut result, "fact_id", Value::String(fact_id.clone()));
            let facts = memory_list(&memory, "facts");
            if !facts.iter().any(|fact| is_str(get(Some(fact), "id"), &fact_id) && is_str(get(Some(fact), "status"), "active")) {
                return invalid("Факт не найден", "WORLD_FACT_NOT_FOUND");
            }
            let targets = validate_knowledge_targets(get(Some(command), "target_ids"), state)?;
            set(&mut result, "target_ids", list_value(targets));
            set(&mut result, "source_event_ids", list_value(strings(get(Some(command), "source_event_ids"), 120, 30)));
            set(&mut result, "visibility", json!("specific_player"));
        }
        "UpsertQuest" => {
            let quest = normalize_quest_input(get(Some(command), "quest"), &memory, state)?;
            set(&mut result, "quest", quest.clone());
            set(&mut result, "visibility", record_visibility(&quest));
        }
        "AdvanceQuestClock" => {
            let quest_id = id(get(Some(command), "quest_id"), "quest_id")?;
            set(&mut result, "quest_id", Value::String(quest_id.clone()));
            let Some(quest) = find_by_id(memory_list(&memory, "quests"), &quest_id) else {
                return invalid("Квест не найден", "WORLD_QUEST_NOT_FOUND");
            };
            let status = get(Some(quest), "status");
            if is_str(status, "offered") {
                return invalid("Отряд ещё не принял это поручение", "WORLD_QUEST_NOT_ACCEPTED");
            }
            if has(&CLOSED_QUEST_STATUSES, status) {
                return invalid("Часы завершённого квеста нельзя изменять", "WORLD_QUEST_CLOSED");
            }
            let amount = integer(get(Some(command), "amount"), 1);
            set(&mut result, "amount", json!(amount));
            if !(1..=20).contains(&amount) {
                return invalid("Шаг часов должен быть от 1 до 20", "WORLD_QUEST_CLOCK_INVALID");
            }
            let proof_fact_ids = strings(get(Some(command), "proof_fact_ids"), 120, 30);
            if !proof_fact_ids.is_empty() {
                let candidates = progress_evidence(Some(&memory), get(Some(state), "autonomy"), &string(get(Some(quest), "id")), false);
                let valid = proof_fact_ids.len() as i64 == amount
                    && proof_fact_ids.iter().all(|fact_id| candidates.iter().any(|fact| is_str(get(Some(fact), "id"), fact_id)));
                if !valid {
                    return invalid("Продвижение квеста требует свежего доказательства этой цели", "WORLD_QUEST_PROGRESS_PROOF_INVALID");
                }
                let sources = unique(
                    candidates
                        .iter()
                        .filter(|fact| fact.get("id").and_then(Value::as_str).is_some_and(|fact_id| proof_fact_ids.iter().any(|proof| proof == fact_id)))
                        .flat_map(|fact| array(get(Some(fact), "source_event_ids")).iter().map(|id| s(Some(id))).collect::<Vec<_>>()),
                );
                set(&mut result, "proof_fact_ids", list_value(proof_fact_ids));
                set(&mut result, "proof_source_event_ids", list_value(sources));
            }
            put(&mut result, "visibility", get(Some(quest), "visibility"));
        }
        "ResolveQuest" => {
            let quest_id = id(get(Some(command), "quest_id"), "quest_id")?;
            set(&mut result, "quest_id", Value::String(quest_id.clone()));
            let Some(quest) = find_by_id(memory_list(&memory, "quests"), &quest_id) else {
                return invalid("Квест не найден", "WORLD_QUEST_NOT_FOUND");
            };
            if !is_str(get(Some(quest), "status"), "active") {
                return invalid("Разрешить можно только активный квест", "WORLD_QUEST_CLOSED");
            }
            let outcome = text(get(Some(command), "outcome"), 20);
            set(&mut result, "outcome", Value::String(outcome.clone()));
            if !["success", "failure", "abandoned"].contains(&outcome.as_str()) {
                return invalid("Исход квеста должен быть success, failure или abandoned", "WORLD_QUEST_OUTCOME_INVALID");
            }
            // Отказ — единственный исход, не требующий заполненных часов.
            if outcome != "abandoned" && !js::is_true(get(get(Some(quest), "clock"), "triggered")) {
                return invalid("Квест нельзя разрешить до заполнения его часов", "WORLD_QUEST_CLOCK_NOT_TRIGGERED");
            }
            let summary = text(get(Some(command), "summary"), 1_000);
            set(&mut result, "summary", Value::String(summary.clone()));
            if summary.is_empty() {
                return invalid("Развязка квеста требует подтверждённого итога", "WORLD_QUEST_RESOLUTION_REQUIRED");
            }
            let next_objective = text(get(Some(command), "next_objective"), 300);
            set(&mut result, "next_objective", Value::String(next_objective.clone()));
            if next_objective.is_empty() {
                return invalid("Развязка квеста требует следующей цели", "WORLD_QUEST_NEXT_OBJECTIVE_REQUIRED");
            }
            set(&mut result, "source_event_ids", list_value(strings(get(Some(command), "source_event_ids"), 120, 30)));
            put(&mut result, "visibility", get(Some(quest), "visibility"));
        }
        "InvalidateQuest" => {
            let quest_id = id(get(Some(command), "quest_id"), "quest_id")?;
            set(&mut result, "quest_id", Value::String(quest_id.clone()));
            let quest = find_by_id(memory_list(&memory, "quests"), &quest_id).cloned().unwrap_or(Value::Null);
            let mut options = Map::new();
            put(&mut options, "primaryQuestId", get(get(Some(state), "campaignConcept"), "story_quest_id"));
            let Some(draft) = quest_invalidation_draft(state, &quest, &Value::Object(options)) else {
                return invalid("Нет подтверждённой причины невозможности поручения", "WORLD_QUEST_INVALIDATION_UNPROVEN");
            };
            put(&mut result, "invalidation", draft.get("payload"));
            put(&mut result, "visibility", draft.get("visibility"));
        }
        "UpsertNarrativeThread" => {
            let thread = normalize_thread_input(get(Some(command), "thread"), &memory, command_id, state)?;
            set(&mut result, "thread", thread.clone());
            set(&mut result, "visibility", record_visibility(&thread));
        }
        "AdvanceNarrativeThreadClock" => {
            let thread_id = id(get(Some(command), "thread_id"), "thread_id")?;
            set(&mut result, "thread_id", Value::String(thread_id.clone()));
            let Some(thread) = find_by_id(memory_list(&memory, "threads"), &thread_id) else {
                return invalid("Сюжетная нить не найдена", "WORLD_THREAD_NOT_FOUND");
            };
            if has(&["resolved", "failed", "abandoned"], get(Some(thread), "status")) {
                return invalid("Часы завершённой сюжетной нити нельзя изменять", "WORLD_THREAD_CLOSED");
            }
            let amount = integer(get(Some(command), "amount"), 1);
            set(&mut result, "amount", json!(amount));
            if !(1..=20).contains(&amount) {
                return invalid("Шаг часов должен быть от 1 до 20", "WORLD_THREAD_CLOCK_INVALID");
            }
            put(&mut result, "visibility", get(Some(thread), "visibility"));
        }
        kind @ ("RecordNpcBelief" | "RecordRumor") => {
            let claim_kind = if kind == "RecordRumor" { "rumor" } else { "belief" };
            let claim = normalize_epistemic_claim_input(get(Some(command), "claim"), &memory, command_id, state, claim_kind)?;
            set(&mut result, "claim", claim.clone());
            set(&mut result, "visibility", record_visibility(&claim));
        }
        "ResolveEpistemicClaim" => {
            let claim_id = id(get(Some(command), "claim_id"), "claim_id")?;
            set(&mut result, "claim_id", Value::String(claim_id.clone()));
            let Some(claim) = find_by_id(memory_list(&memory, "epistemic_claims"), &claim_id) else {
                return invalid("Убеждение или слух не найден", "WORLD_EPISTEMIC_CLAIM_NOT_FOUND");
            };
            let truth_status = text(get(Some(command), "truth_status"), 30);
            set(&mut result, "truth_status", Value::String(truth_status.clone()));
            if !["confirmed", "refuted"].contains(&truth_status.as_str()) {
                return invalid("Истину убеждения можно только подтвердить или опровергнуть", "WORLD_TRUTH_STATUS_INVALID");
            }
            let sources = strings(get(Some(command), "source_event_ids"), 120, 30);
            set(&mut result, "source_event_ids", list_value(sources.clone()));
            if sources.is_empty() {
                return invalid("Подтверждение истины требует source_event_ids", "WORLD_TRUTH_PROVENANCE_REQUIRED");
            }
            put(&mut result, "visibility", get(Some(claim), "visibility"));
        }
        "RecordNarrativeSummary" => {
            let summary = normalize_summary_input(get(Some(command), "summary"), &memory, command_id, state)?;
            set(&mut result, "summary", summary.clone());
            set(&mut result, "visibility", record_visibility(&summary));
        }
        _ => {}
    }
    Ok(Value::Object(result))
}

/// Подтверждения продвижения по частям состояния: память и автономия.
fn progress_evidence(memory: Option<&Value>, autonomy: Option<&Value>, quest_id: &str, include_consumed: bool) -> Vec<Value> {
    let mut state = Map::new();
    if let Some(memory) = memory {
        state.insert("worldMemory".into(), memory.clone());
    }
    if let Some(autonomy) = autonomy {
        state.insert("autonomy".into(), autonomy.clone());
    }
    quest_progress_evidence_for(&Value::Object(state), quest_id, include_consumed)
}

// ---------------------------------------------------------------------------
// События
// ---------------------------------------------------------------------------

fn event(event_type: &str, payload: Option<Value>, target_ids: Option<&Value>) -> Value {
    let mut result = Map::new();
    result.insert("event_type".into(), str_value(event_type));
    if let Some(payload) = payload {
        result.insert("payload".into(), payload);
    }
    put(&mut result, "target_ids", target_ids);
    Value::Object(result)
}

fn payload(pairs: &[(&str, Option<&Value>)]) -> Value {
    let mut result = Map::new();
    for (key, value) in pairs {
        put(&mut result, key, *value);
    }
    Value::Object(result)
}

/// Событие проверенной команды памяти (`worldMemoryEvent`): `{ event_type,
/// payload, target_ids }` или `None` для команды другого типа.
pub fn world_memory_event(command: &Value) -> Option<Value> {
    let field = |key: &str| get(Some(command), key);
    let empty = json!([]);
    let sources = coalesce(field("source_event_ids"), Some(&empty));
    Some(match field("command_type").and_then(Value::as_str)? {
        "InvalidateQuest" => event("QuestInvalidated", field("invalidation").cloned(), Some(&empty)),
        "UpsertWorldEntity" => event("WorldEntityUpserted", Some(payload(&[("entity", field("entity"))])), Some(&empty)),
        "RecordWorldFact" => event("WorldFactRecorded", Some(payload(&[("fact", field("fact"))])), Some(&empty)),
        // Старые потоки событий; редьюсер пишет из него и запись журнала знаний.
        "RevealWorldFact" => event("WorldFactRevealed", Some(payload(&[("fact_id", field("fact_id")), ("source_event_ids", sources)])), field("target_ids")),
        "RecordKnowledgeRevelation" => event("KnowledgeRevealed", Some(payload(&[("fact_id", field("fact_id")), ("source_event_ids", sources)])), field("target_ids")),
        "RecordWorldRelationship" => event("WorldRelationshipRecorded", Some(payload(&[("relationship", field("relationship"))])), Some(&empty)),
        "UpsertQuest" => event("QuestUpserted", Some(payload(&[("schema_version", Some(&json!(2))), ("quest", field("quest"))])), Some(&empty)),
        "AdvanceQuestClock" => {
            let mut body = payload(&[("quest_id", field("quest_id")), ("amount", field("amount"))]);
            if matches!(field("proof_fact_ids"), Some(Value::Array(items)) if !items.is_empty()) {
                let map = body.as_object_mut().expect("объект");
                map.insert("schema_version".into(), json!(2));
                put(map, "proof_fact_ids", field("proof_fact_ids"));
                put(map, "proof_source_event_ids", coalesce(field("proof_source_event_ids"), Some(&empty)));
            }
            event("QuestClockAdvanced", Some(body), Some(&empty))
        }
        "ResolveQuest" => {
            let status = str_value(quest_status_for_outcome(field("outcome")));
            let mut body = payload(&[
                ("quest_id", field("quest_id")),
                ("outcome", field("outcome")),
                ("status", Some(&status)),
                ("summary", field("summary")),
                ("next_objective", field("next_objective")),
                ("source_event_ids", sources),
            ]);
            // Поле есть только у развязок, привязанных к запросу Режиссёра.
            if js::truthy(field("request_fingerprint")) {
                body.as_object_mut().expect("объект").insert("request_fingerprint".into(), Value::String(head(&string(field("request_fingerprint")), 128)));
            }
            event("QuestResolved", Some(body), Some(&empty))
        }
        "UpsertNarrativeThread" => event("NarrativeThreadUpserted", Some(payload(&[("thread", field("thread"))])), Some(&empty)),
        "AdvanceNarrativeThreadClock" => event("NarrativeThreadClockAdvanced", Some(payload(&[("thread_id", field("thread_id")), ("amount", field("amount"))])), Some(&empty)),
        "RecordNpcBelief" => event("NpcBeliefRecorded", Some(payload(&[("claim", field("claim"))])), Some(&empty)),
        "RecordRumor" => event("RumorRecorded", Some(payload(&[("claim", field("claim"))])), Some(&empty)),
        "ResolveEpistemicClaim" => event(
            "EpistemicClaimTruthResolved",
            Some(payload(&[("claim_id", field("claim_id")), ("truth_status", field("truth_status")), ("source_event_ids", sources)])),
            Some(&empty),
        ),
        "RecordNarrativeSummary" => event("NarrativeSummaryRecorded", Some(payload(&[("summary", field("summary"))])), Some(&empty)),
        _ => return None,
    })
}

// ---------------------------------------------------------------------------
// Редьюсер
// ---------------------------------------------------------------------------

fn list_mut<'a>(memory: &'a mut Map<String, Value>, key: &str) -> &'a mut Vec<Value> {
    let slot = memory.entry(key.to_string()).or_insert_with(|| json!([]));
    if !slot.is_array() {
        *slot = json!([]);
    }
    slot.as_array_mut().expect("массив")
}

fn take_list(memory: &mut Map<String, Value>, key: &str) -> Vec<Value> {
    std::mem::take(list_mut(memory, key))
}

/// `[...list.filter((item) => item.id !== record.id), record]`.
fn replace_record(memory: &mut Map<String, Value>, key: &str, record: Map<String, Value>) {
    let record_id = record.get("id").cloned();
    let mut items: Vec<Value> = take_list(memory, key).into_iter().filter(|item| !strict_eq(get(Some(item), "id"), record_id.as_ref())).collect();
    items.push(Value::Object(record));
    *list_mut(memory, key) = items;
}

/// `list.map((item) => item.id === id ? update(item) : item)`.
fn update_records(memory: &mut Map<String, Value>, key: &str, record_id: Option<&Value>, mut update: impl FnMut(&Value) -> Value) {
    let items: Vec<Value> = take_list(memory, key).into_iter().map(|item| if strict_eq(get(Some(&item), "id"), record_id) { update(&item) } else { item }).collect();
    *list_mut(memory, key) = items;
}

fn with_fields(record: Value, fields: Vec<(&str, Value)>) -> Value {
    let mut map = match record {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    for (key, value) in fields {
        map.insert(key.to_string(), value);
    }
    Value::Object(js_order(map))
}

/// Дописать записи журнала знаний (`appendKnowledge`).
fn append_knowledge(memory: &mut Map<String, Value>, event: &Value, fact_id: &str, target_ids: Option<&Value>, payload: Option<&Value>) {
    let available = array(memory.get("facts")).iter().any(|fact| is_str(get(Some(fact), "id"), fact_id));
    if !available {
        return;
    }
    let mut entries: Vec<Value> = match coalesce(memory.get("knowledge_ledger"), memory.get("knowledge_revealed")) {
        Some(value) => spread(Some(value)),
        None => Vec::new(),
    };
    let event_field = |key: &str| get(Some(event), key);
    let legacy = str_value("legacy");
    for hero_id in spread(coalesce(target_ids, None)) {
        let hero = text(Some(&hero_id), 120);
        if hero.is_empty() {
            continue;
        }
        let entry_id = match get(payload, "knowledge_id") {
            raw if js::truthy(raw) => text(raw, 120),
            _ => {
                let origin = or(event_field("event_id"), or(event_field("command_id"), Some(&legacy)));
                let hero_value = str_value(&hero);
                let fact_value = str_value(fact_id);
                text(Some(&Value::String(stable_id("knowledge", &[origin, Some(&hero_value), Some(&fact_value)]))), 120)
            }
        };
        let source_kind = match coalesce(get(payload, "source_kind"), None) {
            Some(kind) => kind.clone(),
            None => str_value(if is_str(event_field("event_type"), "WorldFactRevealed") { "world_fact_revealed" } else { "knowledge_revealed" }),
        };
        let mut raw = Map::new();
        raw.insert("id".into(), Value::String(entry_id));
        raw.insert("hero_id".into(), Value::String(hero));
        raw.insert("fact_id".into(), str_value(fact_id));
        put(&mut raw, "summary", get(payload, "summary"));
        raw.insert("source_event_ids".into(), coalesce(get(payload, "source_event_ids"), None).cloned().unwrap_or_else(|| json!([])));
        put(&mut raw, "source_command_id", event_field("command_id"));
        raw.insert("revealed_event_id".into(), or(event_field("event_id"), None).cloned().unwrap_or_else(|| json!("")));
        put(
            &mut raw,
            "recorded_at_minutes",
            coalesce(event_field("recorded_at_minutes"), coalesce(get(payload, "revealed_at_minutes"), get(payload, "recorded_at_minutes"))),
        );
        raw.insert("source_kind".into(), source_kind);
        let entry = safe_knowledge_entry(Some(&Value::Object(raw)));
        if !entries.iter().any(|candidate| strict_eq(get(Some(candidate), "id"), entry.get("id"))) {
            entries.push(Value::Object(entry));
        }
    }
    let revealed = if legacy_mode() { keep_last(entries, 5_000) } else { entries };
    // Порядок присваиваний JS: новые ключи встают в конец в этом порядке.
    memory.insert("knowledge_revealed".into(), Value::Array(revealed.clone()));
    memory.insert("knowledge_ledger".into(), Value::Array(revealed.clone()));
    memory.insert("knowledge".into(), index_knowledge(&revealed));
}

/// Развязка или невозможность поручения: статус по исходу, итог и «остаться
/// на месте» у событий v2 (`QuestResolved`, `QuestInvalidated`).
fn resolve_quest_records(memory: &mut Map<String, Value>, event: &Value, payload: Option<&Value>) {
    let field = |key: &str| get(payload, key);
    let status = str_value(quest_status_for_outcome(field("outcome")));
    let summary = text(field("summary"), 1_000);
    let stay = js::is_true(field("stay_in_location")) && is_num(field("event_schema_version"), 2.0);
    update_records(memory, "quests", field("quest_id"), |quest| {
        let mut fields = vec![("status", status.clone())];
        // `text(payload.summary) || quest.summary`: `undefined` в JSON не попадает.
        let next_summary = if summary.is_empty() { get(Some(quest), "summary").cloned() } else { Some(str_value(&summary)) };
        if let Some(next_summary) = next_summary {
            fields.push(("summary", next_summary));
        }
        if stay {
            fields.push(("stay_in_location", json!(true)));
        }
        with_fields(record_quest_knowledge(quest, event), fields)
    });
}

fn dedupe(values: Vec<Value>) -> Vec<Value> {
    let mut result: Vec<Value> = Vec::new();
    for value in values {
        if !result.iter().any(|item| same_value_zero(item, &value)) {
            result.push(value);
        }
    }
    result
}

/// Применить событие памяти мира (`applyWorldMemoryEvent`). `prepared` —
/// вход уже нормализован и принадлежит вызывающему (Rules Engine): событие
/// применяется к нему на месте, без повторной нормализации; в режиме
/// `legacy` этот путь не действует. Иначе вход нормализуется до и после.
pub fn apply_world_memory_event(input: Value, event: &Value, prepared: bool) -> Value {
    let legacy = legacy_mode();
    let owned = prepared && !legacy && input.is_object();
    let normalize = |value: &Value| if legacy { normalize_world_memory_legacy(value) } else { normalize_world_memory(value) };
    let mut memory = match if owned { input } else { normalize(&input) } {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    let empty = json!({});
    let payload = coalesce(get(Some(event), "payload"), Some(&empty));
    let field = |key: &str| get(payload, key);
    let schema = field("schema_version");
    let schema_1_or_2 = is_num(schema, 1.0) || is_num(schema, 2.0);
    match get(Some(event), "event_type").and_then(Value::as_str).unwrap_or("") {
        "WorldEntityUpserted" => replace_record(&mut memory, "entities", safe_entity(field("entity"))),
        "WorldFactRecorded" => {
            let fact = safe_fact(field("fact"));
            let supersedes = fact.get("supersedes_fact_id").cloned().unwrap_or(Value::Null);
            if js::truthy(Some(&supersedes)) {
                update_records(&mut memory, "facts", Some(&supersedes), |item| with_fields(item.clone(), vec![("status", json!("superseded"))]));
            }
            list_mut(&mut memory, "facts").push(Value::Object(fact));
        }
        "WorldRelationshipRecorded" => {
            let relationship = safe_relationship(field("relationship"));
            let supersedes = relationship.get("supersedes_relationship_id").cloned().unwrap_or(Value::Null);
            if js::truthy(Some(&supersedes)) {
                update_records(&mut memory, "relationships", Some(&supersedes), |item| with_fields(item.clone(), vec![("status", json!("superseded"))]));
            }
            list_mut(&mut memory, "relationships").push(Value::Object(relationship));
        }
        "WorldFactRevealed" | "KnowledgeRevealed" => {
            let empty_targets = json!([]);
            let targets = coalesce(get(Some(event), "target_ids"), Some(&empty_targets));
            append_knowledge(&mut memory, event, &text(field("fact_id"), 120), targets, payload);
        }
        "QuestUpserted" => {
            let mut quest = safe_quest(field("quest"));
            let quest_id = quest.get("id").cloned();
            let previous = array(memory.get("quests")).iter().find(|item| strict_eq(get(Some(item), "id"), quest_id.as_ref())).cloned();
            let history = previous.as_ref().and_then(|previous| record_quest_knowledge(previous, event).get("knowledge_history").cloned());
            if let Some(history) = history.filter(|history| js::truthy(Some(history))) {
                quest.insert("knowledge_history".into(), history);
            }
            replace_record(&mut memory, "quests", quest);
        }
        "QuestClockAdvanced" => {
            let step = integer(field("amount"), 1).max(1);
            let proofs = is_num(schema, 2.0);
            update_records(&mut memory, "quests", field("quest_id"), |quest| {
                let quest_clock = get(Some(quest), "clock");
                let maximum = js::number(get(quest_clock, "max"));
                let current = js::min_of([maximum, js::number(get(quest_clock, "current")) + step as f64]);
                let mut fact_ids = spread(coalesce(get(Some(quest), "progress_fact_ids"), None));
                let mut source_ids = spread(coalesce(get(Some(quest), "progress_source_event_ids"), None));
                if proofs {
                    fact_ids.extend(persisted_strings(field("proof_fact_ids"), 120).into_iter().map(Value::String));
                    source_ids.extend(persisted_strings(field("proof_source_event_ids"), 120).into_iter().map(Value::String));
                }
                let fact_ids = dedupe(fact_ids);
                let source_ids = dedupe(source_ids);
                let mut next_clock = spread_object(quest_clock);
                next_clock.insert("current".into(), js::num(current));
                next_clock.insert("triggered".into(), json!(current >= maximum));
                let mut fields = vec![("clock", Value::Object(js_order(next_clock)))];
                if !fact_ids.is_empty() {
                    fields.push(("progress_fact_ids", Value::Array(fact_ids)));
                }
                if !source_ids.is_empty() {
                    fields.push(("progress_source_event_ids", Value::Array(source_ids)));
                }
                with_fields(record_quest_knowledge(quest, event), fields)
            });
        }
        "QuestResolved" => resolve_quest_records(&mut memory, event, payload),
        "QuestInvalidated" if schema_1_or_2 => resolve_quest_records(&mut memory, event, payload),
        "QuestAssignmentChanged" if schema_1_or_2 => {
            let giver = text(field("giver_npc_id"), 120);
            let giver = if giver.is_empty() { Value::Null } else { Value::String(giver) };
            update_records(&mut memory, "quests", field("quest_id"), |quest| with_fields(record_quest_knowledge(quest, event), vec![("giver_npc_id", giver.clone())]));
        }
        "QuestAccepted" if schema_1_or_2 => {
            update_records(&mut memory, "quests", field("quest_id"), |quest| with_fields(record_quest_knowledge(quest, event), vec![("status", json!("active"))]));
        }
        "NarrativeThreadUpserted" => replace_record(&mut memory, "threads", safe_thread(field("thread"))),
        "NarrativeThreadClockAdvanced" => {
            let step = integer(field("amount"), 1).max(1);
            update_records(&mut memory, "threads", field("thread_id"), |thread| {
                let thread_clock = get(Some(thread), "clock");
                let maximum = js::number(get(thread_clock, "max"));
                let current = js::min_of([maximum, js::number(get(thread_clock, "current")) + step as f64]);
                let mut next_clock = spread_object(thread_clock);
                next_clock.insert("current".into(), js::num(current));
                next_clock.insert("triggered".into(), json!(current >= maximum));
                with_fields(thread.clone(), vec![("clock", Value::Object(js_order(next_clock)))])
            });
        }
        "NpcBeliefRecorded" | "RumorRecorded" => replace_record(&mut memory, "epistemic_claims", safe_epistemic_claim(field("claim"))),
        "EpistemicClaimTruthResolved" => {
            let truth = field("truth_status").filter(|status| has(&TRUTH_STATUSES, Some(status))).cloned();
            let sources = list_value(persisted_strings(field("source_event_ids"), 120));
            let command = Value::String(text(get(Some(event), "command_id"), 160));
            update_records(&mut memory, "epistemic_claims", field("claim_id"), |claim| {
                let status = truth.clone().or_else(|| get(Some(claim), "truth_status").cloned());
                let mut map = spread_object(Some(claim));
                put(&mut map, "truth_status", status.as_ref());
                map.insert("truth_source_event_ids".into(), sources.clone());
                map.insert("truth_source_command_id".into(), command.clone());
                Value::Object(js_order(map))
            });
        }
        "NarrativeSummaryRecorded" => {
            replace_record(&mut memory, "summaries", safe_summary(field("summary")));
            if legacy {
                let summaries = take_list(&mut memory, "summaries");
                *list_mut(&mut memory, "summaries") = keep_last(summaries, 1_000);
            }
        }
        _ => {}
    }
    let memory = Value::Object(memory);
    if owned {
        memory
    } else {
        normalize(&memory)
    }
}

// ---------------------------------------------------------------------------
// Проекция для зрителя
// ---------------------------------------------------------------------------

fn normally_visible(item: &Value, viewer: &Value) -> bool {
    if js::truthy(get(Some(viewer), "isAdmin")) {
        return true;
    }
    let item_visibility = get(Some(item), "visibility");
    if is_str(item_visibility, "public") {
        return true;
    }
    is_str(item_visibility, "party") && !js::is_false(get(Some(viewer), "isPartyMember"))
}

fn as_of_minutes(viewer: &Value) -> Option<i64> {
    let raw = coalesce(get(Some(viewer), "asOfMinutes"), get(Some(viewer), "as_of_minutes"));
    let number = js::number(raw);
    (js::is_safe_integer_number(raw) && number >= 0.0).then_some(number as i64)
}

fn in_time(item: &Value, maximum: Option<i64>) -> bool {
    maximum.is_none_or(|maximum| recorded_at(get(Some(item), "recorded_at_minutes")) <= maximum)
}

fn filtered(memory: &Value, key: &str, keep: impl Fn(&Value) -> bool) -> Vec<Value> {
    memory_list(memory, key).iter().filter(|item| keep(item)).cloned().collect()
}

/// Каноническая память глазами зрителя (`worldMemoryForViewer`), до того как
/// она уйдёт игроку или модели поиска: время, видимость, знания героя и
/// история последствий на запрошенный момент.
pub fn world_memory_for_viewer(input: &Value, viewer: &Value) -> Value {
    let memory = normalize_world_memory(input);
    let maximum = as_of_minutes(viewer);
    let time = |item: &Value| in_time(item, maximum);
    if js::truthy(get(Some(viewer), "isAdmin")) {
        let mut admin = spread_object(Some(&memory));
        for key in ["facts", "relationships", "quests", "threads", "epistemic_claims", "summaries", "knowledge_revealed"] {
            admin.insert(key.into(), Value::Array(filtered(&memory, key, time)));
        }
        let revealed = array(admin.get("knowledge_revealed")).to_vec();
        admin.insert("knowledge".into(), index_knowledge(&revealed));
        admin.insert("knowledge_ledger".into(), Value::Array(revealed));
        return Value::Object(admin);
    }
    let player_id = text(get(Some(viewer), "playerId"), 120);
    // Индекс известных фактов — из журнала, отфильтрованного по времени:
    // совместимый индекс `knowledge` раскрыл бы факт раньше, чем герой его узнал.
    let ledger = coalesce(memory.get("knowledge_ledger"), memory.get("knowledge_revealed"));
    let player_knowledge: Vec<Value> = array(ledger).iter().filter(|entry| is_str(get(Some(entry), "hero_id"), &player_id) && time(entry)).cloned().collect();
    let known: Vec<String> = unique(player_knowledge.iter().map(|entry| s(get(Some(entry), "fact_id"))));
    let known_set: HashSet<&str> = known.iter().map(String::as_str).collect();
    let facts = filtered(&memory, "facts", |fact| {
        is_str(get(Some(fact), "status"), "active") && time(fact) && (normally_visible(fact, viewer) || known_set.contains(s(get(Some(fact), "id")).as_str()))
    });
    // История последствий — относительно знания на запрошенный момент.
    let mut knowledge_memory = spread_object(Some(&memory));
    knowledge_memory.insert("facts".into(), Value::Array(filtered(&memory, "facts", time)));
    knowledge_memory.insert("knowledge_ledger".into(), Value::Array(player_knowledge.clone()));
    knowledge_memory.insert("knowledge_revealed".into(), Value::Array(player_knowledge.clone()));
    let knowledge_memory = Value::Object(knowledge_memory);
    let quests: Vec<Value> = memory_list(&memory, "quests")
        .iter()
        .map(|quest| quest_for_knowledge(quest, &knowledge_memory, viewer))
        .filter(|quest| !is_str(get(Some(quest), "status"), "hidden") && time(quest) && normally_visible(quest, viewer))
        .collect();
    let threads = filtered(&memory, "threads", |thread| !is_str(get(Some(thread), "status"), "hidden") && time(thread) && normally_visible(thread, viewer));
    let mut referenced: HashSet<String> = facts.iter().map(|fact| s(get(Some(fact), "subject_id"))).collect();
    for record in quests.iter().chain(threads.iter()) {
        referenced.extend(array(get(Some(record), "entity_ids")).iter().map(|id| s(Some(id))));
    }
    let entities = filtered(&memory, "entities", |entity| normally_visible(entity, viewer) || referenced.contains(&s(get(Some(entity), "id"))));
    let visible_entities: HashSet<String> = entities.iter().map(|entity| s(get(Some(entity), "id"))).collect();
    let entity_visible = |key: &str, record: &Value| visible_entities.contains(&s(get(Some(record), key)));
    let relationships = filtered(&memory, "relationships", |relationship| {
        is_str(get(Some(relationship), "status"), "active")
            && time(relationship)
            && normally_visible(relationship, viewer)
            && entity_visible("from_entity_id", relationship)
            && entity_visible("to_entity_id", relationship)
    });
    let claims = filtered(&memory, "epistemic_claims", |claim| {
        time(claim) && normally_visible(claim, viewer) && entity_visible("holder_entity_id", claim) && (!js::truthy(get(Some(claim), "subject_entity_id")) || entity_visible("subject_entity_id", claim))
    });
    let summaries = filtered(&memory, "summaries", |summary| time(summary) && normally_visible(summary, viewer));
    let visible_facts: HashSet<String> = facts.iter().map(|fact| s(get(Some(fact), "id"))).collect();
    let revealed: Vec<Value> = player_knowledge.into_iter().filter(|entry| visible_facts.contains(&s(get(Some(entry), "fact_id")))).collect();
    let quests: Vec<Value> = quests
        .into_iter()
        .map(|quest| {
            let mut map = spread_object(Some(&quest));
            map.shift_remove("progress_fact_ids");
            map.shift_remove("progress_source_event_ids");
            Value::Object(map)
        })
        .collect();
    let knowledge = if player_id.is_empty() {
        json!({})
    } else {
        let mut map = Map::new();
        map.insert(player_id.clone(), list_value(known.into_iter().filter(|fact| visible_facts.contains(fact)).collect()));
        Value::Object(map)
    };
    memory_value([
        ("schema_version", json!(2)),
        ("entities", Value::Array(entities)),
        ("facts", Value::Array(facts)),
        ("relationships", Value::Array(relationships)),
        ("quests", Value::Array(quests)),
        ("threads", Value::Array(threads)),
        ("epistemic_claims", Value::Array(claims)),
        ("summaries", Value::Array(summaries)),
        ("knowledge", knowledge),
        ("knowledge_revealed", Value::Array(revealed.clone())),
        ("knowledge_ledger", Value::Array(revealed)),
    ])
}

// ---------------------------------------------------------------------------
// Поиск
// ---------------------------------------------------------------------------

/// Служебные слова вопроса: местоимения, предлоги, союзы и вопросительные
/// слова, но не имена.
const RETRIEVAL_STOP_WORDS: &[&str] = &[
    "что", "кто", "где", "как", "чем", "чём", "это", "эта", "эти", "этот", "этой", "этом", "так", "там", "тут", "для", "при", "без", "над", "под", "про", "или", "его",
    "её", "она", "они", "оно", "ему", "ней", "них", "был", "была", "были", "было", "быть", "есть", "уже", "ещё", "еще", "все", "всё", "вся", "всех", "если", "когда",
    "тот", "той", "тех", "чтобы", "сейчас", "только", "может", "нам", "вам", "нас", "вас", "мне", "меня", "тебя", "себя", "свой", "своя", "свои", "кого", "кому",
    "чего", "какой", "какие", "какая", "каков", "почему", "зачем", "сколько", "куда", "откуда", "тоже", "также", "очень", "можно", "нужно", "надо", "известно",
    "расскажи", "расскажите", "сегодня", "теперь", "the", "and", "what", "who", "where", "with", "for", "from", "that", "this",
];

fn tokenize(value: &str) -> Vec<String> {
    let lowered = lower(&text(Some(&Value::String(value.to_string())), 8_000));
    split_tokens(&lowered).into_iter().filter(|token| jstext::len(token) >= 3 && !RETRIEVAL_STOP_WORDS.contains(&token.as_str())).take(240).collect()
}

fn split_tokens(value: &str) -> Vec<String> {
    let separator = re!(r"[^a-zа-яё0-9]+", "iu");
    let mut tokens = Vec::new();
    let mut last = 0;
    for found in separator.find_iter(value).filter_map(Result::ok) {
        tokens.push(value[last..found.start()].to_string());
        last = found.end();
    }
    tokens.push(value[last..].to_string());
    tokens
}

fn stem(token: &str) -> String {
    let original = lower(&text(Some(&Value::String(token.to_string())), 120));
    // Падежные хвосты и мягкий знак срезаются, иначе «серой гнили» и «Серая
    // гниль» расходятся по основам.
    let value = if jstext::test(re!(r"^[а-яё]+$", "u"), &original) {
        jstext::replace_first(
            re!(r"(?:иями|ями|ами|ого|ему|ыми|ими|иях|остью|остей|ость|ости|ение|ений|ать|ять|ить|ешь|ете|ают|яют|ях|ах|ов|ев|ий|ый|ой|ей|ых|их|ым|им|ью|ая|ое|ие|ам|ом|ую|ь|ю|ы|и|а|я|е|о|у)$", "u"),
            &original,
            "",
        )
    } else {
        jstext::replace_first(re!(r"(?:ization|ations|ation|ments|ment|ingly|ing|edly|ed|ies|es|s)$", "u"), &original, "")
    };
    if jstext::len(&value) >= 3 {
        value
    } else {
        original
    }
}

const SYNONYM_GROUPS: [&[&str]; 6] = [
    &["город", "поселение", "столица", "деревня", "town", "city", "settlement"],
    &["дорога", "путь", "маршрут", "тракт", "trail", "route"],
    &["слух", "молва", "rumor", "gossip"],
    &["задание", "квест", "цель", "quest", "objective"],
    &["гильдия", "орден", "фракция", "союз", "guild", "faction"],
    &["опасность", "угроза", "враг", "enemy", "threat"],
];

static SYNONYM_INDEX: LazyLock<HashMap<String, usize>> = LazyLock::new(|| {
    let mut index = HashMap::new();
    for (group, words) in SYNONYM_GROUPS.iter().enumerate() {
        for word in *words {
            index.insert(stem(word), group);
        }
    }
    index
});

/// Основы документа: и для совпадений, и для косинуса (`stemProfile`).
struct StemProfile {
    stems: Vec<String>,
    set: HashSet<String>,
    counts: HashMap<String, f64>,
    groups: HashSet<usize>,
}

fn stem_profile(tokens: &[String]) -> StemProfile {
    let stems: Vec<String> = tokens.iter().map(|token| stem(token)).collect();
    let mut counts: HashMap<String, f64> = HashMap::new();
    for key in &stems {
        *counts.entry(key.clone()).or_insert(0.0) += 1.0;
    }
    let groups = stems.iter().filter_map(|key| SYNONYM_INDEX.get(key).copied()).collect();
    StemProfile { set: stems.iter().cloned().collect(), stems, counts, groups }
}

fn vector_cosine(left: &HashMap<String, f64>, right: &HashMap<String, f64>) -> f64 {
    let left_magnitude: f64 = left.values().map(|value| value * value).sum();
    let right_magnitude: f64 = right.values().map(|value| value * value).sum();
    let dot: f64 = left.iter().map(|(key, value)| value * right.get(key).copied().unwrap_or(0.0)).sum();
    if left_magnitude != 0.0 && right_magnitude != 0.0 {
        dot / (left_magnitude * right_magnitude).sqrt()
    } else {
        0.0
    }
}

/// Лексическая оценка и число точных совпадений основ (`semanticMatch`).
fn semantic_match(query: &StemProfile, document: &StemProfile) -> (f64, usize) {
    if query.stems.is_empty() {
        return (0.0, 0);
    }
    let mut exact = 0;
    let mut synonym = 0;
    for query_stem in &query.stems {
        if document.set.contains(query_stem) {
            exact += 1;
        }
        if SYNONYM_INDEX.get(query_stem).is_some_and(|group| document.groups.contains(group)) {
            synonym += 1;
        }
    }
    let score = (exact * 12) as f64 + (synonym * 4) as f64 + js::round(vector_cosine(&query.counts, &document.counts) * 10_000.0) / 1_000.0;
    (score, exact)
}

/// Запись поиска: видимые поля записи и служебные поля ранжирования.
struct Record {
    value: Map<String, Value>,
    id: String,
    anchors: Vec<String>,
    hub: bool,
    search: String,
}

fn record_head(kind: Value, record_id: &Value, summary: Value, source_event_ids: Value) -> Map<String, Value> {
    let mut value = Map::new();
    value.insert("kind".into(), kind);
    value.insert("id".into(), record_id.clone());
    value.insert("summary".into(), summary);
    value.insert("source_event_ids".into(), source_event_ids);
    value
}

fn retrieval_records(memory: &Value) -> Vec<Record> {
    let mut entities: HashMap<String, &Value> = HashMap::new();
    for entity in memory_list(memory, "entities") {
        entities.insert(s(get(Some(entity), "id")), entity);
    }
    let entity_name = |entity_id: &str| entities.get(entity_id).map(|entity| s(get(Some(entity), "name"))).unwrap_or_default();
    let field = |record: &Value, key: &str| s(get(Some(record), key));
    let or_field = |record: &Value, first: &str, second: &str| or(get(Some(record), first), get(Some(record), second)).cloned().unwrap_or(Value::Null);
    let sources = |record: &Value| get(Some(record), "source_event_ids").cloned().unwrap_or(Value::Null);
    let id_value = |record: &Value| get(Some(record), "id").cloned().unwrap_or(Value::Null);
    let list = |record: &Value, key: &str| array(get(Some(record), key)).iter().map(|item| s(Some(item))).collect::<Vec<_>>();
    let mut records = Vec::new();
    for fact in memory_list(memory, "facts") {
        let subject = field(fact, "subject_id");
        let mut value = record_head(json!("fact"), &id_value(fact), or_field(fact, "summary", "object"), sources(fact));
        value.insert("fact".into(), fact.clone());
        value.insert("entity".into(), entities.get(&subject).map(|entity| (*entity).clone()).unwrap_or(Value::Null));
        let aliases = entities.get(&subject).map(|entity| list(entity, "aliases").join(" ")).unwrap_or_default();
        let search = format!("{} {aliases} {} {} {}", entity_name(&subject), field(fact, "predicate"), field(fact, "object"), field(fact, "summary"));
        records.push(Record { value, id: field(fact, "id"), anchors: vec![subject], hub: false, search });
    }
    for relationship in memory_list(memory, "relationships") {
        let from = field(relationship, "from_entity_id");
        let to = field(relationship, "to_entity_id");
        let mut value = record_head(json!("relationship"), &id_value(relationship), get(Some(relationship), "summary").cloned().unwrap_or(Value::Null), sources(relationship));
        value.insert("relationship".into(), relationship.clone());
        let search = format!("{} {} {} {}", entity_name(&from), field(relationship, "relation"), entity_name(&to), field(relationship, "summary"));
        records.push(Record { value, id: field(relationship, "id"), anchors: vec![from, to], hub: false, search });
    }
    for quest in memory_list(memory, "quests") {
        let mut value = record_head(json!("quest"), &id_value(quest), get(Some(quest), "summary").cloned().unwrap_or(Value::Null), json!([]));
        value.insert("quest".into(), quest.clone());
        let search = format!("{} {} {}", field(quest, "title"), field(quest, "summary"), list(quest, "objectives").join(" "));
        records.push(Record { value, id: field(quest, "id"), anchors: list(quest, "entity_ids"), hub: true, search });
    }
    for thread in memory_list(memory, "threads") {
        let mut value = record_head(json!("thread"), &id_value(thread), get(Some(thread), "summary").cloned().unwrap_or(Value::Null), sources(thread));
        value.insert("thread".into(), thread.clone());
        let names: Vec<String> = list(thread, "entity_ids").iter().map(|entity| entity_name(entity)).collect();
        let search = format!("{} {} {}", field(thread, "title"), field(thread, "summary"), names.join(" "));
        records.push(Record { value, id: field(thread, "id"), anchors: list(thread, "entity_ids"), hub: true, search });
    }
    for claim in memory_list(memory, "epistemic_claims") {
        let holder = field(claim, "holder_entity_id");
        let subject = field(claim, "subject_entity_id");
        let mut value = record_head(get(Some(claim), "kind").cloned().unwrap_or(Value::Null), &id_value(claim), or_field(claim, "summary", "claim"), sources(claim));
        value.insert("claim".into(), claim.clone());
        let search = format!("{} {} {} {} {}", entity_name(&holder), entity_name(&subject), field(claim, "predicate"), field(claim, "claim"), field(claim, "summary"));
        let anchors = [holder, subject].into_iter().filter(|anchor| !anchor.is_empty()).collect();
        records.push(Record { value, id: field(claim, "id"), anchors, hub: false, search });
    }
    for summary in memory_list(memory, "summaries") {
        let kind = Value::String(format!("{}_summary", tpl(get(Some(summary), "kind"))));
        let mut value = record_head(kind, &id_value(summary), get(Some(summary), "summary").cloned().unwrap_or(Value::Null), sources(summary));
        value.insert("narrative_summary".into(), summary.clone());
        let search = format!("{} {}", field(summary, "title"), field(summary, "summary"));
        records.push(Record { value, id: field(summary, "id"), anchors: list(summary, "entity_ids"), hub: false, search });
    }
    records
}

/// Доля силы, которую сущность передаёт соседу на один шаг графа.
const NEIGHBOUR_DECAY: f64 = 0.5;

/// Сущности, названные в вопросе (`namedEntities`): все основы имени или
/// одного из псевдонимов нашлись среди основ вопроса; сила — 12 за основу.
fn named_entities(memory: &Value, query: &StemProfile) -> HashMap<String, f64> {
    let mut named = HashMap::new();
    for entity in memory_list(memory, "entities") {
        let mut best: f64 = 0.0;
        let mut forms = vec![s(get(Some(entity), "name"))];
        forms.extend(array(get(Some(entity), "aliases")).iter().map(|alias| s(Some(alias))));
        for form in forms {
            let stems = unique(tokenize(&form).iter().map(|token| stem(token)));
            if !stems.is_empty() && stems.iter().all(|item| query.set.contains(item)) {
                best = best.max((stems.len() * 12) as f64);
            }
        }
        if best > 0.0 {
            named.insert(s(get(Some(entity), "id")), best);
        }
    }
    named
}

/// Один шаг по графу памяти (`neighbourActivation`): названная сущность —
/// своя сила, её сосед — половина; сущности совпавших поручений и нитей —
/// половина их оценки. Рёбра — только из проекции зрителя.
fn neighbour_activation(memory: &Value, named: &HashMap<String, f64>, hubs: &[(Vec<String>, f64)]) -> HashMap<String, f64> {
    let visible: HashSet<String> = memory_list(memory, "entities").iter().map(|entity| s(get(Some(entity), "id"))).collect();
    let mut activation: HashMap<String, f64> = HashMap::new();
    let mut raise = |entity_id: &str, value: f64| {
        if !visible.contains(entity_id) || value <= 0.0 {
            return;
        }
        if value > activation.get(entity_id).copied().unwrap_or(0.0) {
            activation.insert(entity_id.to_string(), value);
        }
    };
    for (entity_id, value) in named {
        raise(entity_id, *value);
    }
    if !named.is_empty() {
        for relationship in memory_list(memory, "relationships") {
            let from_id = s(get(Some(relationship), "from_entity_id"));
            let to_id = s(get(Some(relationship), "to_entity_id"));
            if let Some(from) = named.get(&from_id) {
                raise(&to_id, from * NEIGHBOUR_DECAY);
            }
            if let Some(to) = named.get(&to_id) {
                raise(&from_id, to * NEIGHBOUR_DECAY);
            }
        }
        for group in memory_list(memory, "quests").iter().chain(memory_list(memory, "threads")) {
            let ids: Vec<String> = array(get(Some(group), "entity_ids")).iter().map(|id| s(Some(id))).collect();
            let strongest = ids.iter().map(|id| named.get(id).copied().unwrap_or(0.0)).fold(0.0, f64::max);
            if strongest != 0.0 {
                for entity_id in &ids {
                    raise(entity_id, strongest * NEIGHBOUR_DECAY);
                }
            }
        }
    }
    for (anchors, score) in hubs {
        for entity_id in anchors {
            raise(entity_id, score * NEIGHBOUR_DECAY);
        }
    }
    activation
}

fn finish(record: Record, score: f64) -> Value {
    let mut value = record.value;
    value.insert("score".into(), js::num(score));
    Value::Object(value)
}

/// Детерминированный поиск по смыслу с одним шагом по графу
/// (`retrieveWorldMemory`). Видимость и время фильтруются в
/// [`world_memory_for_viewer`] до ранжирования, поэтому ни порядок, ни шаг
/// по графу не открывают скрытого. `options` — `{ query, limit, asOfMinutes,
/// neighbours, whenUnmatched }`: без совпадений `whenUnmatched: 'all'` (по
/// умолчанию) даёт первые записи по id, `'none'` — пустой ответ.
pub fn retrieve_world_memory(input: &Value, viewer: &Value, options: &Value) -> Vec<Value> {
    let option = |key: &str| get(Some(options), key);
    let mut scoped = spread_object(Some(viewer));
    if let Some(time) = coalesce(option("asOfMinutes"), None) {
        scoped.insert("asOfMinutes".into(), time.clone());
    }
    let memory = world_memory_for_viewer(input, &Value::Object(scoped));
    let query = stem_profile(&tokenize(&s(option("query"))));
    let maximum = match option("limit") {
        None => 8,
        limit => integer(limit, 8).clamp(1, 30),
    } as usize;
    let neighbours = match option("neighbours") {
        None => true,
        value => js::truthy(value),
    };
    let when_unmatched_none = is_str(option("whenUnmatched"), "none");
    let mut records = retrieval_records(&memory);
    let unordered = |mut records: Vec<Record>| -> Vec<Value> {
        records.sort_by(|left, right| jstext::locale_compare(&left.id, &right.id));
        records.into_iter().take(maximum).map(|record| finish(record, 0.0)).collect()
    };
    if query.stems.is_empty() {
        return unordered(records);
    }
    let scored: Vec<(f64, usize)> = records.iter().map(|record| semantic_match(&query, &stem_profile(&tokenize(&record.search)))).collect();
    if !scored.iter().any(|(lexical, _)| *lexical > 0.0) {
        return if when_unmatched_none { Vec::new() } else { unordered(records) };
    }
    let activation = if neighbours {
        let hubs: Vec<(Vec<String>, f64)> = records.iter().zip(&scored).filter(|(record, (_, exact))| record.hub && *exact > 0).map(|(record, (lexical, _))| (record.anchors.clone(), *lexical)).collect();
        neighbour_activation(&memory, &named_entities(&memory, &query), &hubs)
    } else {
        HashMap::new()
    };
    let mut ranked: Vec<(Record, f64)> = records
        .drain(..)
        .zip(scored)
        .map(|(record, (lexical, _))| {
            let boost = record.anchors.iter().map(|entity_id| activation.get(entity_id).copied().unwrap_or(0.0)).fold(0.0, f64::max);
            (record, lexical + boost)
        })
        .filter(|(_, score)| *score > 0.0)
        .collect();
    ranked.sort_by(|(left, left_score), (right, right_score)| {
        right_score.partial_cmp(left_score).unwrap_or(std::cmp::Ordering::Equal).then_with(|| jstext::locale_compare(&left.id, &right.id))
    });
    ranked.into_iter().take(maximum).map(|(record, score)| finish(record, score)).collect()
}

/// Совместимый API для игрока (`retrieveKnownWorldMemory`): проекция героя
/// фильтруется до ранжирования, а источники возвращаются только для уже
/// видимых ему фактов. `options` — `{ viewer, query, limit, atMinutes, asOfMinutes }`.
pub fn retrieve_known_world_memory(input: &Value, options: &Value) -> Vec<Value> {
    let option = |key: &str| get(Some(options), key);
    let time = coalesce(option("atMinutes"), coalesce(option("asOfMinutes"), None));
    let mut viewer = spread_object(option("viewer"));
    if let Some(time) = time {
        viewer.insert("asOfMinutes".into(), time.clone());
    }
    let memory = world_memory_for_viewer(input, &Value::Object(viewer));
    let mut known_by_fact: HashMap<String, Vec<Value>> = HashMap::new();
    for entry in array(coalesce(memory.get("knowledge_ledger"), memory.get("knowledge_revealed"))) {
        known_by_fact.entry(s(get(Some(entry), "fact_id"))).or_default().push(get(Some(entry), "id").cloned().unwrap_or(Value::Null));
    }
    let mut search = Map::new();
    search.insert("query".into(), option("query").cloned().unwrap_or_else(|| json!("")));
    search.insert("limit".into(), option("limit").cloned().unwrap_or_else(|| json!(8)));
    put(&mut search, "asOfMinutes", time);
    search.insert("whenUnmatched".into(), json!("none"));
    retrieve_world_memory(&memory, &json!({ "isAdmin": true }), &Value::Object(search))
        .into_iter()
        .filter(|entry| is_str(entry.get("kind"), "fact"))
        .map(|entry| {
            let fact = entry.get("fact").cloned().unwrap_or(Value::Null);
            let fact_id = get(Some(&fact), "id").cloned().unwrap_or(Value::Null);
            let mut result = spread_object(Some(&fact));
            result.insert("entity".into(), entry.get("entity").cloned().unwrap_or(Value::Null));
            let ids = known_by_fact.get(&s(Some(&fact_id))).cloned().unwrap_or_default();
            result.insert(
                "citation".into(),
                json!({
                    "fact_id": fact_id,
                    "source_event_ids": coalesce(get(Some(&fact), "source_event_ids"), None).cloned().unwrap_or_else(|| json!([])),
                    "knowledge_entry_ids": ids,
                }),
            );
            Value::Object(result)
        })
        .collect()
}

/// Совместимый API детерминированного Хранителя знаний (`knownWorldLore`):
/// факты по вопросу, до 30, без совпадений — пусто. `viewer` по умолчанию —
/// ведущий.
pub fn known_world_lore(input: &Value, query: Option<&Value>, viewer: Option<&Value>) -> Vec<Value> {
    let admin = json!({ "isAdmin": true });
    let viewer = viewer.unwrap_or(&admin);
    let options = json!({ "query": query.cloned().unwrap_or_else(|| json!("")), "limit": 30, "whenUnmatched": "none" });
    retrieve_world_memory(input, viewer, &options)
        .into_iter()
        .filter(|entry| is_str(entry.get("kind"), "fact"))
        .map(|entry| {
            let mut result = spread_object(entry.get("fact"));
            result.insert("entity".into(), entry.get("entity").cloned().unwrap_or(Value::Null));
            Value::Object(result)
        })
        .collect()
}

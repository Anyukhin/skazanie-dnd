//! Перенос `server/npc-social-controller.mjs`: социальные сцены NPC — реплика
//! постоянного собеседника отряда.
//!
//! Модель получает бриф только из видимого отряду: сцена, публичный профиль,
//! безопасная выжимка мотивов (`npcBehaviorPolicy`), разговоры, которые этот
//! герой мог слышать, факты и слухи, которые NPC знает (`npcKnownFactIds`),
//! публичные зацепки карты, где он назван (`public_hooks_naming_npc`), и
//! серверные зацепки «кто ещё знает» (`leads`) — без текста тайн. Ответ
//! модели проверяется по форме, повторы вырезаются (`freshReplyText`), круговые
//! отсылки — тоже; раскрытые id проходят только из переданных.
//!
//! Без модели (или когда она ошиблась) звучит детерминированный ответ
//! (`fallbackDisclosure`): совпавшее с вопросом предложение публичной зацепки
//! или открытого факта, молва, своя тайна после удачной проверки, иначе —
//! зацепка дальше. Так социальная сцена играется без модели.
//!
//! Клиент модели внедряется ([`LlmClient`]); промпт —
//! `prompts/npc_controller/social_v8.txt`, встроен при сборке.

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::{json, Map, Value};
use sk_agents_base::llm_client::{LlmClient, LlmError};
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::{hash, js, re, text};
use sk_encounters::agent_context::{
    agent_context_metadata, bounded_selection_metadata, campaign_concept_for_agent, hero_card_for_agent, scene_canon_for, scene_context_for_agent, AgentContextOptions,
    SelectionOptions,
};
use sk_memory::world_memory::retrieve_world_memory;
use sk_narration_base::model_style_profiles::prompt_for_model_role;
use sk_npc_world::tavern_life::tavern_table_mood;
use sk_projection::viewer_projection::public_world_map_for;
use sk_social::npc_social::{
    ensure_npc_social_state, implicit_secret_holder_ids, npc_behavior_policy, npc_known_fact_ids, npc_profile_at_world_time, npc_secret_meta, relationship_tier,
};
use sk_story::llm_json_schemas::NPC_SOCIAL_RESPONSE_JSON_SCHEMA;
use sk_tactics::security::build_data_only_context;

/// Версия контракта социальной роли NPC.
pub const NPC_SOCIAL_PROMPT_VERSION: &str = "npc_controller/social-v8";

/// `prompts/npc_controller/social_v8.txt`.
pub const NPC_SOCIAL_PROMPT: &str = include_str!("../../../../prompts/npc_controller/social_v8.txt");

/// Сколько фактов и слухов NPC попадает в бриф.
pub const NPC_SOCIAL_MEMORY_LIMIT: usize = 8;
/// Публичных зацепок о собеседнике в брифе не больше этого числа.
pub const NPC_PUBLIC_HOOK_LIMIT: usize = 4;
/// Зацепок «кто ещё знает, где искать» в брифе не больше этого числа.
pub const NPC_LEAD_LIMIT: usize = 3;
/// Сколько последних реплик NPC (любому герою) сверяется с новой на повтор.
pub const NPC_REPEAT_WINDOW: usize = 12;
/// Сколько своих последних реплик NPC видит в брифе как `already_said`.
pub const NPC_ALREADY_SAID_LIMIT: usize = 6;
/// Подряд одинаковых слов, после которых предложение считается повтором.
const REPEAT_WORD_RUN: usize = 6;

const STANCES: [&str; 4] = ["friendly", "neutral", "guarded", "hostile"];
const DIRECTIONS: [&str; 2] = ["npc_to_party", "party_to_npc"];
const NPC_SOCIAL_RESPONSE_FIELDS: [&str; 8] = ["npc_id", "reply", "stance", "disclosed_fact_ids", "disclosed_claim_ids", "relationship_delta", "promise", "confidence"];

// --- ошибки ------------------------------------------------------------------------

/// Исключение, которое JS пропустил бы наружу (или поймал в `try` вызова
/// модели): `TypeError` на мусорном состоянии, отказ клиента модели, ответ
/// неверной формы (`Error`, без кода).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NpcSocialError {
    pub name: String,
    pub code: Option<String>,
    pub message: String,
}

impl NpcSocialError {
    fn type_error(message: impl Into<String>) -> Self {
        Self { name: "TypeError".into(), code: None, message: message.into() }
    }

    fn error(message: impl Into<String>) -> Self {
        Self { name: "Error".into(), code: None, message: message.into() }
    }
}

impl From<LlmError> for NpcSocialError {
    fn from(error: LlmError) -> Self {
        Self { name: error.name, code: error.code, message: error.message }
    }
}

impl std::fmt::Display for NpcSocialError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.name, self.message)
    }
}

impl std::error::Error for NpcSocialError {}

type R<T> = Result<T, NpcSocialError>;

// --- приведения JS ----------------------------------------------------------------

/// Поле объекта (у не-объекта — нет поля).
fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(Value::as_object).and_then(|map| map.get(key))
}

fn path<'a>(value: Option<&'a Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().try_fold(value?, |current, key| get(Some(current), key))
}

/// Массив или пусто.
fn arr(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

/// `value?.x === 'literal'`.
fn is_str(value: Option<&Value>, expected: &str) -> bool {
    value.and_then(Value::as_str) == Some(expected)
}

/// `a === b` для значений JSON: объекты и массивы — разные ссылки.
fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        _ => false,
    }
}

/// `(state.worldMemory?.x ?? []).filter(…)`: массив — элементы,
/// `undefined`/`null` — пусто, иное — `TypeError` V8 (источник с `?.` V8
/// печатает как `(intermediate value)`).
fn filterable(value: Option<&Value>) -> R<&[Value]> {
    match value {
        None | Some(Value::Null) => Ok(&[]),
        Some(Value::Array(items)) => Ok(items),
        Some(_) => Err(NpcSocialError::type_error("((intermediate value) ?? []).filter is not a function")),
    }
}

/// Исключения, которые JS бросает раньше этого модуля в
/// `ensureNpcSocialState` (`for…of` по `state.merchants` и сущностям памяти).
/// Перенос `sk-social` мусор не отвергает, поэтому граница повторена здесь.
fn social_iteration_guard(state: &Value) -> R<()> {
    iterable(get(Some(state), "merchants"))?;
    iterable(get(world_memory(state), "entities"))?;
    Ok(())
}

/// То же для `npcKnownFactIds`: после нормализации — `filter` по сущностям
/// (`locationEntitiesById`) и `for…of` по фактам (`partyPlaceByFact`).
fn known_fact_ids_guard(state: &Value) -> R<()> {
    social_iteration_guard(state)?;
    filterable(get(world_memory(state), "entities"))?;
    iterable(get(world_memory(state), "facts"))?;
    Ok(())
}

/// `for (const x of value ?? [])`: строка перебирается по символам, иное
/// неперебираемое — `TypeError` V8.
fn iterable(value: Option<&Value>) -> R<Vec<Value>> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => Ok(items.clone()),
        Some(Value::String(chars)) => Ok(chars.chars().map(|ch| Value::String(ch.to_string())).collect()),
        Some(other) => {
            let shown = match other {
                Value::Number(number) => format!("number {}", js::js_number_string(number)),
                Value::Bool(flag) => format!("boolean {flag}"),
                _ => "object".to_string(),
            };
            Err(NpcSocialError::type_error(format!("{shown} is not iterable (cannot read property Symbol(Symbol.iterator))")))
        }
    }
}

/// `x.key` у `null`/`undefined` — `TypeError` V8.
fn deref<'a>(value: &'a Value, key: &str) -> R<Option<&'a Value>> {
    if value.is_null() {
        return Err(NpcSocialError::type_error(format!("Cannot read properties of null (reading '{key}')")));
    }
    Ok(get(Some(value), key))
}

/// `clean(value, maximum)`: `String(value ?? '')`, NFKC, пробелы схлопнуты,
/// обрезка.
fn clean(value: Option<&Value>, maximum: usize) -> String {
    clean_str(&js::s(value), maximum)
}

fn clean_str(value: &str, maximum: usize) -> String {
    text::head(&text::squash_spaces(&text::nfkc(value)), maximum)
}

fn lower(value: &str) -> String {
    text::lower(value)
}

fn str_value(value: impl Into<String>) -> Value {
    Value::String(value.into())
}

/// Вставить поле, если JS положил бы его (не `undefined`).
fn put(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value.clone());
    }
}

/// `text.split(/(?<=[.!?…])\s+/u)`.
fn split_sentences(value: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut last = 0;
    for found in re!(r"(?<=[.!?…])\s+", "u").find_iter(value).filter_map(Result::ok) {
        parts.push(value[last..found.start()].to_string());
        last = found.end();
    }
    parts.push(value[last..].to_string());
    parts
}

fn char_len(value: &str) -> usize {
    text::len(value)
}

// --- слова и имена ------------------------------------------------------------------

/// Слова без регистра и «ё»: «Мара Трижды-Мерная» → ['мара', 'трижды', 'мерная'].
fn plain_words_str(value: &str, maximum: usize) -> Vec<String> {
    let folded = lower(&clean_str(value, maximum)).replace('ё', "е");
    text::find_all(re!(r"[\p{L}\p{N}]+", "gu"), &folded)
}

fn plain_words(value: Option<&Value>, maximum: usize) -> Vec<String> {
    plain_words_str(&js::s(value), maximum)
}

fn name_ending_re() -> &'static sk_core::fancy_regex::Regex {
    re!(r"(?:ой|ей|ою|ею|ом|ем|ым|им|ую|юю|ая|яя|ов|ев|а|я|у|ю|е|ы|и|о|ь|й)$", "u")
}

fn question_ending_re() -> &'static sk_core::fancy_regex::Regex {
    re!(r"(?:иями|ями|ами|ого|его|ому|ему|ыми|ими|иях|ях|ах|ов|ев|ий|ый|ой|ей|ых|их|ым|им|ую|юю|ая|яя|ое|ее|ие|ые|ам|ям|ом|ем|ью|ь|ю|ы|и|а|я|е|о|у|й)$", "u")
}

/// Слово текста — форма слова из имени: «Мерную» к «Мерная».
fn word_names_part(word: &str, name_part: &str) -> bool {
    if word == name_part {
        return true;
    }
    let stem = text::replace_first(name_ending_re(), name_part, "");
    char_len(&stem) >= 4 && word.starts_with(&stem) && char_len(word) as i64 - char_len(&stem) as i64 <= 3
}

fn name_parts_of(profile: &Value, min_len: usize) -> Vec<String> {
    plain_words(get(Some(profile), "name"), 200).into_iter().filter(|part| char_len(part) >= min_len).collect()
}

/// Предложение говорит о собеседнике в третьем лице.
fn sentence_describes_npc(words: &[String], profile: &Value) -> bool {
    if text::test(re!(r"^(?:он|она)$", "u"), words.first().map_or("", String::as_str)) {
        return true;
    }
    let name_parts = name_parts_of(profile, 3);
    name_parts.iter().any(|part| words.iter().any(|word| word_names_part(word, part)))
}

/// Текст называет собеседника, если в нём есть каждое слово его имени.
fn text_names_npc(value: &str, profile: &Value) -> bool {
    let name_parts = name_parts_of(profile, 3);
    if name_parts.is_empty() {
        return false;
    }
    let words = plain_words_str(value, 2_000);
    name_parts.iter().all(|part| words.iter().any(|word| word_names_part(word, part)))
}

// --- память мира -----------------------------------------------------------------

fn world_memory(state: &Value) -> Option<&Value> {
    get(Some(state), "worldMemory")
}

/// Факты, которые NPC знает и может произнести.
fn npc_speakable_fact_records<'a>(state: &'a Value, profile: &Value) -> R<Vec<&'a Value>> {
    known_fact_ids_guard(state)?;
    let allowed = npc_known_fact_ids(state, profile);
    let facts = filterable(get(world_memory(state), "facts"))?;
    let mut out = Vec::new();
    for fact in facts {
        if is_str(deref(fact, "status")?, "active") && allowed.contains(&js::string(get(Some(fact), "id"))) {
            out.push(fact);
        }
    }
    Ok(out)
}

fn npc_speakable_claim_records<'a>(state: &'a Value, profile: &Value) -> R<Vec<&'a Value>> {
    let claims = filterable(get(world_memory(state), "epistemic_claims"))?;
    let profile_id = js::string(get(Some(profile), "id"));
    let mut out = Vec::new();
    for claim in claims {
        if js::string(deref(claim, "holder_entity_id")?) == profile_id {
            out.push(claim);
        }
    }
    Ok(out)
}

/// `{ ...value }` для любого значения: объект — его поля, массив и строка —
/// по индексам, иное — пусто.
fn spread_any(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => js::entries(map).into_iter().map(|(key, value)| (key.clone(), value.clone())).collect(),
        Some(Value::Array(items)) => items.iter().enumerate().map(|(index, item)| (index.to_string(), item.clone())).collect(),
        Some(Value::String(chars)) => chars.chars().enumerate().map(|(index, ch)| (index.to_string(), Value::String(ch.to_string()))).collect(),
        _ => Map::new(),
    }
}

fn retrieval_memory(state: &Value, facts: &[&Value], claims: &[&Value]) -> Value {
    let mut memory = spread_any(world_memory(state));
    memory.insert("facts".into(), Value::Array(facts.iter().map(|fact| (*fact).clone()).collect()));
    memory.insert("relationships".into(), json!([]));
    memory.insert("quests".into(), json!([]));
    memory.insert("threads".into(), json!([]));
    memory.insert("epistemic_claims".into(), Value::Array(claims.iter().map(|claim| (*claim).clone()).collect()));
    memory.insert("summaries".into(), json!([]));
    Value::Object(memory)
}

fn retrieve(memory: &Value, message: Option<&Value>) -> Vec<Value> {
    let options = json!({ "query": clean(message, 1_000), "limit": NPC_SOCIAL_MEMORY_LIMIT });
    retrieve_world_memory(memory, &json!({ "isAdmin": true }), &options)
}

/// `npcFacts(state, profile, message, { summaryLimit, spokenAloud })`.
fn npc_facts(state: &Value, profile: &Value, message: Option<&Value>, summary_limit: usize, spoken_aloud: bool) -> R<Vec<Value>> {
    let speakable: Vec<&Value> =
        npc_speakable_fact_records(state, profile)?.into_iter().filter(|fact| !spoken_aloud || !is_str(get(Some(fact), "predicate"), "opening_narration")).collect();
    let allowed: HashSet<String> = speakable.iter().map(|fact| js::string(get(Some(fact), "id"))).collect();
    let records = retrieve(&retrieval_memory(state, &speakable, &[]), message);
    let known = spoken_aloud.then(|| npc_known_fact_ids(state, profile));
    let mut out = Vec::new();
    for record in &records {
        let record = Some(record);
        let fact = get(record, "fact");
        if !is_str(get(record, "kind"), "fact") || !allowed.contains(&js::string(get(fact, "id"))) {
            continue;
        }
        let mut entry = Map::new();
        entry.insert("id".into(), str_value(js::string(get(fact, "id"))));
        entry.insert("subject".into(), str_value(clean(get(get(record, "entity"), "name"), 160)));
        let summary = get(fact, "summary").filter(|value| js::truthy(Some(value))).or_else(|| get(fact, "object"));
        entry.insert("summary".into(), str_value(clean(summary, summary_limit)));
        if !["public", "party"].contains(&js::string(get(fact, "visibility")).as_str()) {
            entry.insert("guarded".into(), Value::Bool(true));
        }
        if let Some(known) = &known {
            let supersedes = get(fact, "supersedes_fact_id");
            if is_str(get(fact, "predicate"), "discovery") && !(js::truthy(supersedes) && known.contains(&js::string(supersedes))) {
                entry.insert("party_finding".into(), Value::Bool(true));
            }
        }
        out.push(Value::Object(entry));
    }
    Ok(out)
}

fn npc_claims(state: &Value, profile: &Value, message: Option<&Value>) -> R<Vec<Value>> {
    let speakable = npc_speakable_claim_records(state, profile)?;
    let allowed: HashSet<String> = speakable.iter().map(|claim| js::string(get(Some(claim), "id"))).collect();
    let records = retrieve(&retrieval_memory(state, &[], &speakable), message);
    let mut out = Vec::new();
    for record in &records {
        let record = Some(record);
        let claim = get(record, "claim");
        let kind = get(record, "kind").and_then(Value::as_str).unwrap_or("");
        if !["belief", "rumor"].contains(&kind) || !allowed.contains(&js::string(get(claim, "id"))) {
            continue;
        }
        let summary = get(claim, "summary").filter(|value| js::truthy(Some(value))).or_else(|| get(claim, "claim"));
        let truth = get(claim, "truth_status").and_then(Value::as_str).filter(|status| ["confirmed", "refuted"].contains(status)).unwrap_or("unknown");
        out.push(json!({
            "id": js::string(get(claim, "id")),
            "kind": if is_str(get(claim, "kind"), "rumor") { "rumor" } else { "belief" },
            "summary": clean(summary, 500),
            "truth_status": truth,
        }));
    }
    Ok(out)
}

// --- публичные зацепки карты -----------------------------------------------------

fn public_world_map(state: &Value) -> Option<Value> {
    match get(Some(state), "worldMap") {
        Some(world_map @ Value::Object(_)) => public_world_map_for(Some(world_map)).ok(),
        _ => None,
    }
}

/// Перебор зацепок карты: `(место, зацепка)` в порядке JS.
fn for_each_world_hook(world_map: Option<&Value>, mut take: impl FnMut(String, &Value)) {
    for location in arr(get(world_map, "locations")) {
        let location = Some(location);
        // Само место — `clean(location.name)`, вложенные — шаблоном `${…} · ${…}`.
        for hook in arr(get(location, "storyHooks")) {
            take(js::s(get(location, "name")), hook);
        }
        let name = js::string(get(location, "name"));
        let city = get(location, "cityOverview");
        for district in arr(get(city, "districts")) {
            let place = format!("{name} · {}", js::string(get(Some(district), "name")));
            for hook in arr(get(Some(district), "storyHooks")) {
                take(place.clone(), hook);
            }
        }
        for spot in arr(get(city, "places")) {
            let place = format!("{name} · {}", js::string(get(Some(spot), "name")));
            for hook in arr(get(Some(spot), "storyHooks")) {
                take(place.clone(), hook);
            }
        }
    }
}

/// Публичные зацепки карты мира и плана города, где этот NPC назван по имени
/// (`publicHooksNamingNpc`): `{ place, text }`.
fn public_hooks_naming_npc(state: &Value, profile: &Value) -> Vec<Value> {
    let world_map = public_world_map(state);
    let mut hooks = Vec::new();
    let mut seen = HashSet::new();
    for_each_world_hook(world_map.as_ref(), |place, value| {
        let hook = clean(Some(value), 320);
        let key = lower(&hook);
        if hook.is_empty() || seen.contains(&key) || !text_names_npc(&hook, profile) {
            return;
        }
        seen.insert(key);
        hooks.push(json!({ "place": clean_str(&place, 240), "text": hook }));
    });
    hooks
}

/// Ответ раскрыл скрытое: названа тайна или слух, которые знает только этот NPC.
fn private_knowledge_disclosed(state: &Value, profile: &Value, fact_ids: &[String], claim_ids: &[String]) -> R<bool> {
    let private_facts: HashSet<String> = npc_speakable_fact_records(state, profile)?
        .into_iter()
        .filter(|fact| !visibility_open(get(Some(fact), "visibility")))
        .map(|fact| js::string(get(Some(fact), "id")))
        .collect();
    let private_claims: HashSet<String> = npc_speakable_claim_records(state, profile)?
        .into_iter()
        .filter(|claim| !visibility_open(get(Some(claim), "visibility")))
        .map(|claim| js::string(get(Some(claim), "id")))
        .collect();
    Ok(fact_ids.iter().any(|id| private_facts.contains(id)) || claim_ids.iter().any(|id| private_claims.contains(id)))
}

/// `['public', 'party'].includes(value)`.
fn visibility_open(value: Option<&Value>) -> bool {
    is_str(value, "public") || is_str(value, "party")
}

// --- отзвук личного --------------------------------------------------------------

const ECHO_STOP_WORDS: &[&str] = &[
    "этот", "этого", "этом", "этой", "эти", "чтобы", "когда", "только", "здесь", "знаю", "знает", "может", "тебе", "тебя", "меня", "тоже", "потом",
    "сейчас", "теперь", "тогда", "очень", "никто", "ничего", "было", "была", "были", "есть", "буду", "будет", "если", "хотя", "даже", "опять",
    "снова", "уже", "ещё", "еще", "всех", "весь", "всего", "который", "которая", "которые", "своей", "свой", "своих", "нужно", "надо", "просто",
    "сказал", "сказала",
];

const REPEAT_STOP_WORDS: &[&str] = &[
    "это", "этот", "эта", "эти", "того", "тому", "тоже", "было", "была", "были", "будет", "есть", "когда", "тогда", "потом", "только", "чтобы",
    "если", "даже", "ещё", "еще", "всего", "всех", "свой", "своя", "свои", "меня", "тебя", "тебе", "мне", "него", "неё", "нее", "него", "ними",
    "здесь", "там", "тут", "вот", "так", "как", "что", "кто", "где", "уже", "может", "знаю", "знаешь", "скажу", "говорю", "видела", "видел",
];

const FALLBACK_QUESTION_STOP_WORDS: &[&str] = &[
    "какой", "какая", "какое", "какие", "какую", "каком", "какого", "почему", "зачем", "когда", "куда", "откуда", "сколько", "кому", "кого", "чего",
    "этот", "этого", "этом", "этой", "тебя", "тебе", "меня", "есть", "было", "была", "были", "быть", "будет", "может", "можно", "нужно", "надо",
    "сейчас", "прямо", "теперь", "тогда", "здесь", "очень", "только", "ничего", "никто", "скажи", "скажите", "расскажи", "расскажите", "знаешь",
    "знаете", "слышал", "слышала", "слышали", "слышно", "нового", "новое", "новости", "говорю", "говорим", "спрашиваю", "спросим", "расспрашиваю",
    "расспросим", "обращаюсь", "обращаемся", "прошу", "просим", "интересуюсь", "узнаю", "хочу", "хотим", "давай", "давайте", "пожалуйста", "вопрос",
    "ответь", "подскажи", "думаешь", "думаете", "считаешь", "считаете", "видел", "видела", "видели", "пройти", "пройду", "пройдем", "пойти", "пойду",
    "пойдем", "идти", "попасть", "добраться", "найти", "найду", "найдем", "сделать", "делать",
];

const LEAD_STOP_WORDS: &[&str] = &[
    "знаешь", "знаете", "скажи", "скажите", "расскажи", "расскажите", "кто-нибудь", "что-нибудь",
];

/// Основы значимых слов для сверки отзвука.
fn echo_stems(value: &str) -> HashSet<String> {
    plain_words_str(value, 4_000)
        .into_iter()
        .filter(|word| char_len(word) >= 4 && !ECHO_STOP_WORDS.contains(&word.as_str()) && !FALLBACK_QUESTION_STOP_WORDS.contains(&word.as_str()))
        .map(|word| word_stem(&word))
        .collect()
}

/// Основа слова без падежного окончания; короче четырёх букв — слово целиком.
fn word_stem(word: &str) -> String {
    let stem = text::replace_first(question_ending_re(), word, "");
    if char_len(&stem) >= 4 {
        stem
    } else {
        word.to_string()
    }
}

/// Сколько основ запроса нашлось в теме.
fn stem_overlap(query: &IndexSet<String>, topic: &IndexSet<String>) -> i64 {
    let mut score = 0;
    for stem in query {
        if topic.contains(stem)
            || topic.iter().any(|other| (char_len(stem) >= 5 && other.starts_with(stem.as_str())) || (char_len(other) >= 5 && stem.starts_with(other.as_str())))
        {
            score += 1;
        }
    }
    score
}

/// Реплика повторяет личное: два и больше значимых слова из скрытого материала,
/// которых нет в открытом контексте.
fn reply_echoes_private_material(reply: &str, private_texts: &[String], baseline_text: &str) -> bool {
    let reply_stems = echo_stems(reply);
    if reply_stems.is_empty() {
        return false;
    }
    let baseline = echo_stems(baseline_text);
    private_texts.iter().any(|value| echo_stems(value).iter().filter(|stem| reply_stems.contains(*stem) && !baseline.contains(*stem)).count() >= 2)
}

fn hero_name(state: &Value, hero_id: Option<&Value>) -> R<String> {
    let expected = js::s(hero_id);
    let players = match get(Some(state), "players") {
        None | Some(Value::Null) => &[][..],
        Some(Value::Array(items)) => items,
        Some(_) => return Err(NpcSocialError::type_error("(state.players ?? []).find is not a function")),
    };
    let hero = players.iter().find(|player| js::s(get(Some(player), "id")) == expected);
    let name = get(hero, "character").filter(|value| js::truthy(Some(value))).or_else(|| get(hero, "name"));
    let name = clean(name, 120);
    Ok(if name.is_empty() { expected } else { name })
}

fn conversation_visible_to(entry: &Value, player_id: &str) -> bool {
    let entry = Some(entry);
    is_str(get(entry, "visibility"), "party") || (is_str(get(entry, "visibility"), "specific_player") && js::string(get(entry, "hero_id")) == player_id)
}

fn memory_terms(value: &str) -> HashSet<String> {
    text::find_all(re!(r"[\p{L}\p{N}]{4,}", "gu"), &lower(&clean_str(value, 1_000))).into_iter().collect()
}

/// Суть давней реплики: первая фраза, не длиннее сотни знаков.
fn reply_gist(reply: Option<&Value>) -> String {
    let value = clean(reply, 600);
    let first = split_sentences(&value).into_iter().next().unwrap_or_default();
    if char_len(&first) > 100 {
        format!("{}…", text::trim_end(&text::head(&first, 99)))
    } else {
        first
    }
}

/// Последние `verbatim` ответов — дословно, старые — сутью.
fn with_reply_gists(entries: Vec<Map<String, Value>>, verbatim: usize) -> Vec<Value> {
    let total = entries.len();
    entries
        .into_iter()
        .enumerate()
        .map(|(index, mut entry)| {
            if index as i64 >= total as i64 - verbatim as i64 || !js::truthy(entry.get("npc_reply")) {
                return Value::Object(entry);
            }
            let reply = entry.shift_remove("npc_reply");
            entry.insert("npc_reply_gist".into(), str_value(reply_gist(reply.as_ref())));
            Value::Object(entry)
        })
        .collect()
}

fn conversations(social: &Value) -> &[Value] {
    arr(get(Some(social), "conversations"))
}

fn same_npc(entry: &Value, profile: &Value) -> bool {
    strict_eq(get(Some(entry), "npc_id"), get(Some(profile), "id"))
}

fn template_pair(a: Option<&Value>, b: Option<&Value>) -> String {
    format!("{} {}", js::string(a), js::string(b))
}

fn relevant_npc_memory(social: &Value, profile: &Value, player_id: &str, message: Option<&Value>) -> Vec<Value> {
    let query = memory_terms(&js::s(message));
    let score = |value: &str| memory_terms(value).iter().filter(|term| query.contains(*term)).count() as i64;
    struct Ranked<'a> {
        entry: &'a Value,
        relevance: i64,
        recency: i64,
        dossier: bool,
    }
    let mut ranked: Vec<Ranked<'_>> = conversations(social)
        .iter()
        .filter(|entry| same_npc(entry, profile) && conversation_visible_to(entry, player_id))
        .enumerate()
        .map(|(index, entry)| Ranked {
            entry,
            relevance: score(&template_pair(get(Some(entry), "player_message"), get(Some(entry), "npc_reply"))),
            recency: index as i64,
            dossier: false,
        })
        .collect();
    ranked.extend(
        arr(get(Some(profile), "dossier"))
            .iter()
            .filter(|entry| dossier_visible(entry, player_id))
            .enumerate()
            .map(|(index, entry)| Ranked { entry, relevance: score(&js::s(get(Some(entry), "summary"))), recency: index as i64, dossier: true }),
    );
    ranked.sort_by(|a, b| b.relevance.cmp(&a.relevance).then(b.recency.cmp(&a.recency)));
    ranked
        .into_iter()
        .take(8)
        .map(|item| {
            let entry = Some(item.entry);
            let mut out = Map::new();
            if item.dossier {
                out.insert("kind".into(), str_value("dossier"));
                for key in ["id", "hero_id", "summary", "stance"] {
                    put(&mut out, key, get(entry, key));
                }
            } else {
                out.insert("kind".into(), str_value("conversation"));
                for key in ["id", "hero_id", "player_message", "npc_reply", "stance"] {
                    put(&mut out, key, get(entry, key));
                }
            }
            Value::Object(out)
        })
        .collect()
}

fn dossier_visible(entry: &Value, player_id: &str) -> bool {
    let entry = Some(entry);
    is_str(get(entry, "visibility"), "party") || (is_str(get(entry, "visibility"), "specific_player") && js::string(get(entry, "hero_id")) == player_id)
}

/// Скрытый материал, который мог попасть в реплику.
fn private_material_texts(state: &Value, social: &Value, profile: &Value, player_id: &str, facts: &[Value]) -> R<Vec<String>> {
    let mut texts: Vec<String> = facts.iter().filter(|fact| js::truthy(get(Some(fact), "guarded"))).map(|fact| js::s(get(Some(fact), "summary"))).collect();
    for claim in npc_speakable_claim_records(state, profile)? {
        if !visibility_open(get(Some(claim), "visibility")) {
            let summary = get(Some(claim), "summary").filter(|value| js::truthy(Some(value))).or_else(|| get(Some(claim), "claim"));
            texts.push(clean(summary, 1_000));
        }
    }
    for entry in conversations(social) {
        if same_npc(entry, profile) && js::string(get(Some(entry), "hero_id")) == player_id && is_str(get(Some(entry), "visibility"), "specific_player") {
            texts.push(format!("{} {}", clean(get(Some(entry), "player_message"), 1_000), clean(get(Some(entry), "npc_reply"), 1_000)));
        }
    }
    for entry in arr(get(Some(profile), "dossier")) {
        if is_str(get(Some(entry), "visibility"), "specific_player") && js::string(get(Some(entry), "hero_id")) == player_id {
            texts.push(clean(get(Some(entry), "summary"), 1_000));
        }
    }
    Ok(texts.into_iter().filter(|value| !value.is_empty()).collect())
}

/// Открытый контекст разговора: совпадение с ним тайной не считается.
fn open_conversation_text(state: &Value, social: &Value, profile: &Value, player_id: &str, message: Option<&Value>, facts: &[Value], hooks: &[Value]) -> String {
    let scene = get(Some(state), "scene");
    let mut parts: Vec<String> = vec![
        js::s(message),
        js::s(get(Some(profile), "name")),
        js::s(get(Some(profile), "role")),
        js::s(get(Some(profile), "public_summary")),
        js::s(get(Some(profile), "voice")),
        js::s(get(scene, "title")),
        js::s(get(scene, "location")),
        js::s(get(scene, "objective")),
    ];
    parts.extend(facts.iter().filter(|fact| !js::truthy(get(Some(fact), "guarded"))).map(|fact| js::s(get(Some(fact), "summary"))));
    parts.extend(hooks.iter().map(|hook| js::s(get(Some(hook), "text"))));
    let party: Vec<&Value> = conversations(social).iter().filter(|entry| same_npc(entry, profile) && is_str(get(Some(entry), "visibility"), "party")).collect();
    parts.extend(last_n(&party, NPC_REPEAT_WINDOW).iter().map(|entry| template_pair(get(Some(entry), "player_message"), get(Some(entry), "npc_reply"))));
    let card = hero_card_for_agent(state, Some(&str_value(player_id))).unwrap_or_else(|| json!({}));
    parts.push(js::stringify(&card));
    parts.iter().map(|value| clean_str(value, 2_000)).collect::<Vec<_>>().join(" ")
}

fn last_n<T>(items: &[T], n: usize) -> &[T] {
    &items[items.len().saturating_sub(n)..]
}

// --- антиповтор ----------------------------------------------------------------------

/// «Да. Баркас Борса.» → ['Да.', 'Баркас Борса.']
fn reply_sentences(value: &str) -> Vec<String> {
    split_sentences(&clean_str(value, 2_000)).into_iter().map(|part| text::trim(&part).to_string()).filter(|part| !part.is_empty()).collect()
}

fn word_runs(words: &[String]) -> IndexSet<String> {
    let mut runs = IndexSet::new();
    let mut index = 0;
    while index + REPEAT_WORD_RUN <= words.len() {
        runs.insert(words[index..index + REPEAT_WORD_RUN].join(" "));
        index += 1;
    }
    runs
}

struct RepeatIndex {
    runs: HashSet<String>,
    sentences: Vec<HashSet<String>>,
    stems: Vec<HashSet<String>>,
}

fn earlier_reply_index(replies: &[String]) -> RepeatIndex {
    let mut index = RepeatIndex { runs: HashSet::new(), sentences: Vec::new(), stems: Vec::new() };
    for reply in replies {
        index.runs.extend(word_runs(&plain_words_str(reply, 2_000)));
        for sentence in reply_sentences(reply) {
            index.sentences.push(plain_words_str(&sentence, 2_000).into_iter().collect());
            index.stems.push(content_stems(&sentence));
        }
    }
    index
}

/// Основы содержательных слов: «баркаса без огней» и «баркас без огня» — одно.
fn content_stems(value: &str) -> HashSet<String> {
    plain_words_str(value, 2_000).into_iter().filter(|word| char_len(word) >= 4 && !REPEAT_STOP_WORDS.contains(&word.as_str())).map(|word| text::head(&word, 4)).collect()
}

/// Предложение повторяет сказанное раньше.
fn sentence_repeats(sentence: &str, index: &RepeatIndex) -> bool {
    let words = plain_words_str(sentence, 2_000);
    if words.len() >= REPEAT_WORD_RUN && word_runs(&words).iter().any(|run| index.runs.contains(run)) {
        return true;
    }
    if words.len() < 3 {
        return false;
    }
    let own: IndexSet<&String> = words.iter().collect();
    if index.sentences.iter().any(|earlier| {
        if earlier.len() < 3 {
            return false;
        }
        let shared = own.iter().filter(|word| earlier.contains(word.as_str())).count() as f64;
        shared / own.len() as f64 >= 0.8 && shared / earlier.len() as f64 >= 0.5
    }) {
        return true;
    }
    let stems = content_stems(sentence);
    if stems.len() < 4 {
        return false;
    }
    index.stems.iter().any(|earlier| {
        if earlier.len() < 3 {
            return false;
        }
        let shared = stems.iter().filter(|stem| earlier.contains(*stem)).count() as f64;
        shared / stems.len() as f64 >= 0.65
    })
}

fn remind_request() -> &'static sk_core::fancy_regex::Regex {
    re!(r"(?<![\p{L}\p{M}])(?:напомн\p{L}*|повтор\p{L}*|ещё\s+раз|еще\s+раз|снова\s+скаж\p{L}*)(?![\p{L}\p{M}])", "iu")
}

fn referral_verb() -> &'static sk_core::fancy_regex::Regex {
    re!(
        r"(?<![\p{L}\p{M}])(?:спрос\p{L}*|спраш\p{L}*|расспрос\p{L}*|поговор\p{L}*|обратись|обратитесь|узна(?:й|йте)\s+у|загляни|загляните|иди(?:те)?\s+к|ступай(?:те)?\s+к)(?![\p{L}\p{M}])",
        "iu"
    )
}

/// Последние общие реплики других NPC этого же места (`othersSaidNearby`):
/// `{ npc, npc_reply }`.
pub fn others_said_nearby(state: &Value, social: &Value, profile: &Value) -> Vec<Value> {
    let here = lower(&clean(path(Some(state), &["scene", "location"]), 180));
    let mut by_id: IndexMap<String, &Value> = IndexMap::new();
    for npc in arr(get(Some(social), "npcs")) {
        by_id.insert(js::s(get(Some(npc), "id")), npc);
    }
    let profile_id = js::s(get(Some(profile), "id"));
    let heard: Vec<(&Value, String)> = arr(get(Some(social), "conversations"))
        .iter()
        .filter(|entry| !is_str(get(Some(entry), "visibility"), "specific_player") && js::s(get(Some(entry), "npc_id")) != profile_id)
        .map(|entry| (by_id.get(&js::s(get(Some(entry), "npc_id"))).copied(), clean(get(Some(entry), "npc_reply"), 400)))
        .filter_map(|(npc, reply)| {
            let npc = npc.filter(|npc| js::truthy(Some(npc)))?;
            if reply.is_empty() {
                return None;
            }
            let location = get(Some(npc), "location");
            (here.is_empty() || !js::truthy(location) || lower(&clean(location, 180)) == here).then_some((npc, reply))
        })
        .collect();
    last_n(&heard, 4).iter().map(|(npc, reply)| json!({ "npc": clean(get(Some(npc), "name"), 120), "npc_reply": reply })).collect()
}

/// Отсылка «спроси N», когда отряд уже говорил с N, вырезается
/// (`withoutCircularReferral`), если после неё в реплике остаётся что сказать.
pub fn without_circular_referral(reply: &str, social: &Value, profile: &Value) -> String {
    let asked: HashSet<String> = arr(get(Some(social), "conversations")).iter().map(|entry| js::s(get(Some(entry), "npc_id"))).filter(|id| !id.is_empty()).collect();
    let profile_id = js::s(get(Some(profile), "id"));
    let names: Vec<String> = arr(get(Some(social), "npcs"))
        .iter()
        .filter(|npc| {
            let id = js::string(get(Some(npc), "id"));
            asked.contains(&id) && id != profile_id
        })
        .map(|npc| {
            let name = clean(get(Some(npc), "name"), 120);
            let first = name.split(' ').next().unwrap_or("");
            lower(first).replace('ё', "е")
        })
        .filter(|name| char_len(name) >= 3)
        .collect();
    if names.is_empty() {
        return reply.to_string();
    }
    let sentences = reply_sentences(reply);
    let circular = |sentence: &str| {
        if !text::test(referral_verb(), sentence) {
            return false;
        }
        let words = text::find_all(re!(r"\p{L}+", "gu"), &lower(sentence).replace('ё', "е"));
        names.iter().any(|name| {
            let length = char_len(name);
            let prefix = text::head(name, 3.max(length.saturating_sub(1)));
            words.iter().any(|word| word.starts_with(prefix.as_str()) && char_len(word) <= length + 3)
        })
    };
    let kept: Vec<&String> = sentences.iter().filter(|sentence| !circular(sentence)).collect();
    let joined = kept.iter().map(|sentence| sentence.as_str()).collect::<Vec<_>>().join(" ");
    if kept.len() == sentences.len() || plain_words_str(&joined, 2_000).len() < 4 {
        return reply.to_string();
    }
    joined
}

/// Итог [`fresh_reply_text`]: новая часть реплики и сколько предложений вырезано.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FreshReply {
    pub text: String,
    pub dropped: usize,
}

impl FreshReply {
    /// Форма JS: `{ text, dropped }`.
    pub fn to_json(&self) -> Value {
        json!({ "text": self.text, "dropped": self.dropped })
    }
}

/// Новая часть реплики (`freshReplyText`): предложения-повторы вырезаны.
/// Пустой `text` — нового не осталось.
pub fn fresh_reply_text(reply: &str, earlier_replies: &[String]) -> FreshReply {
    let sentences = reply_sentences(reply);
    if earlier_replies.is_empty() {
        return FreshReply { text: sentences.join(" "), dropped: 0 };
    }
    let index = earlier_reply_index(earlier_replies);
    let kept: Vec<&String> = sentences.iter().filter(|sentence| !sentence_repeats(sentence, &index)).collect();
    let joined = kept.iter().map(|sentence| sentence.as_str()).collect::<Vec<_>>().join(" ");
    let dropped = sentences.len() - kept.len();
    let text = if dropped == 0 || plain_words_str(&joined, 2_000).len() >= 2 { joined } else { String::new() };
    FreshReply { text, dropped }
}

/// Последние реплики NPC, с которыми сверяется новая.
fn npc_earlier_replies(social: &Value, profile: &Value, player_id: &str, include_other_private: bool) -> Vec<String> {
    let entries: Vec<&Value> =
        conversations(social).iter().filter(|entry| same_npc(entry, profile)).filter(|entry| include_other_private || conversation_visible_to(entry, player_id)).collect();
    last_n(&entries, NPC_REPEAT_WINDOW).iter().map(|entry| clean(get(Some(entry), "npc_reply"), 2_000)).filter(|reply| !reply.is_empty()).collect()
}

fn already_said_for_brief(social: &Value, profile: &Value, player_id: &str) -> Vec<String> {
    let entries: Vec<&Value> = conversations(social).iter().filter(|entry| same_npc(entry, profile) && conversation_visible_to(entry, player_id)).collect();
    last_n(&entries, NPC_ALREADY_SAID_LIMIT).iter().map(|entry| clean(get(Some(entry), "npc_reply"), 300)).filter(|reply| !reply.is_empty()).collect()
}

// --- зацепки вместо тупика -----------------------------------------------------------

fn address_prefix_re() -> &'static sk_core::fancy_regex::Regex {
    re!(r"^\s*(?:обращаюсь|обращаемся)\s+к\s+[^:]{1,240}:\s*", "iu")
}

fn lead_stems(value: &str, profile: Option<&Value>) -> IndexSet<String> {
    let name_parts = plain_words(get(profile, "name"), 200);
    plain_words_str(&text::replace_first(address_prefix_re(), &clean_str(value, 2_000), ""), 2_000)
        .into_iter()
        .filter(|word| char_len(word) >= 4 && !FALLBACK_QUESTION_STOP_WORDS.contains(&word.as_str()) && !LEAD_STOP_WORDS.contains(&word.as_str()))
        .filter(|word| !name_parts.iter().any(|part| word_names_part(word, part)))
        .map(|word| word_stem(&word))
        .collect()
}

fn revealed_fact_ids(state: &Value) -> R<HashSet<String>> {
    let memory = match world_memory(state) {
        None | Some(Value::Null) => None,
        some => some,
    };
    let spread = |key: &str| -> R<Vec<Value>> {
        match get(memory, key) {
            None | Some(Value::Null) => Ok(Vec::new()),
            Some(Value::Array(items)) => Ok(items.clone()),
            Some(Value::String(_)) => Ok(Vec::new()),
            Some(_) => Err(NpcSocialError::type_error(format!("(memory.{key} ?? []) is not iterable"))),
        }
    };
    let mut entries = spread("knowledge_ledger")?;
    entries.extend(spread("knowledge_revealed")?);
    Ok(entries.iter().map(|entry| js::s(get(Some(entry), "fact_id"))).filter(|id| !id.is_empty()).collect())
}

struct Candidate {
    score: i64,
    lead: Map<String, Value>,
}

/// Зацепки для разговора (`conversationLeads`): кто ещё знает (`person`), где
/// искать (`place`), что говорят открыто (`hook`) и `self` — ответ знает сам
/// собеседник. `social` — `None`, как в JS, — `ensureNpcSocialState(state.social, state)`.
pub fn conversation_leads(state: &Value, profile: &Value, message: Option<&Value>, social: Option<&Value>) -> Result<Vec<Value>, NpcSocialError> {
    let owned;
    let social = match social {
        Some(social) => social,
        None => {
            social_iteration_guard(state)?;
            owned = social_state(state);
            &owned
        }
    };
    let asked = lead_stems(&js::s(message), Some(profile));
    let objective = lead_stems(&js::s(path(Some(state), &["scene", "objective"])), Some(profile));
    let scene_key = lower(&clean(path(Some(state), &["scene", "location"]), 180));
    let mut locations: IndexMap<String, String> = IndexMap::new();
    for entity in filterable(get(world_memory(state), "entities"))? {
        if is_str(get(Some(entity), "kind"), "location") && js::truthy(get(Some(entity), "id")) {
            locations.insert(js::string(get(Some(entity), "id")), clean(get(Some(entity), "name"), 180));
        }
    }
    let revealed = revealed_fact_ids(state)?;
    let implicit = implicit_secret_holder_ids(state, Some(social));
    let npcs = arr(get(Some(social), "npcs"));
    let mut npc_by_name: IndexMap<String, &Value> = IndexMap::new();
    for npc in npcs {
        npc_by_name.insert(lower(&clean(get(Some(npc), "name"), 160)), npc);
    }
    let mut known_by: IndexMap<String, &Value> = IndexMap::new();
    for npc in npcs {
        for fact_id in arr(get(Some(npc), "known_fact_ids")) {
            if let Value::String(id) = fact_id {
                known_by.entry(id.clone()).or_insert(npc);
            }
        }
    }
    let asked_before: HashSet<String> = conversations(social)
        .iter()
        .filter(|entry| is_str(get(Some(entry), "visibility"), "party") || js::truthy(get(Some(entry), "hero_id")))
        .map(|entry| js::s(get(Some(entry), "npc_id")))
        .filter(|id| !id.is_empty())
        .collect();
    let mut candidates: Vec<Candidate> = Vec::new();
    for fact in iterable(get(world_memory(state), "facts"))? {
        let fact = &fact;
        if !is_str(get(Some(fact), "predicate"), "gm_secret") || !is_str(get(Some(fact), "status"), "active") || revealed.contains(&js::string(get(Some(fact), "id"))) {
            continue;
        }
        let meta = npc_secret_meta(fact);
        let topic = lead_stems(&format!("{} {}", meta.topic, js::s(get(Some(fact), "summary"))), None);
        let question_score = stem_overlap(&asked, &topic);
        let objective_score = stem_overlap(&objective, &topic);
        let place = locations.get(&js::s(get(Some(fact), "subject_id"))).cloned().unwrap_or_default();
        let nearby = !place.is_empty() && lower(&place) == scene_key;
        if question_score == 0 && objective_score == 0 && !nearby {
            continue;
        }
        let fact_id = js::string(get(Some(fact), "id"));
        let holder = (!meta.holder.is_empty()).then(|| npc_by_name.get(&lower(&meta.holder)).copied()).flatten().filter(|npc| js::truthy(Some(npc)));
        let holder = holder
            .or_else(|| known_by.get(&fact_id).copied().filter(|npc| js::truthy(Some(npc))))
            .or_else(|| implicit.get(&fact_id).and_then(|id| npcs.iter().find(|npc| is_str(get(Some(npc), "id"), id))));
        let matched = if question_score != 0 {
            "question"
        } else if objective_score != 0 {
            "objective"
        } else {
            "nearby"
        };
        let score = question_score * 4 + objective_score * 2 + i64::from(nearby);
        let about = clean_str(&meta.topic, 100);
        let mut lead = Map::new();
        if holder.is_some_and(|holder| strict_eq(get(Some(holder), "id"), get(Some(profile), "id"))) {
            lead.insert("kind".into(), str_value("self"));
            lead.insert("match".into(), str_value(matched));
            if !about.is_empty() {
                lead.insert("about".into(), str_value(about));
            }
            candidates.push(Candidate { score: score + 1, lead });
        } else if let Some(holder) = holder.filter(|holder| !is_str(get(Some(holder), "visibility"), "gm_only")) {
            let current = npc_profile_at_world_time(holder, state);
            let location = get(Some(&current), "location").filter(|value| js::truthy(Some(value))).or_else(|| get(Some(holder), "location"));
            let holder_place = clean(location, 180);
            let was_asked = asked_before.contains(&js::string(get(Some(holder), "id")));
            lead.insert("kind".into(), str_value("person"));
            lead.insert("match".into(), str_value(matched));
            lead.insert("name".into(), str_value(clean(get(Some(holder), "name"), 120)));
            let role = clean(get(Some(holder), "role"), 120);
            if !role.is_empty() {
                lead.insert("role".into(), str_value(role));
            }
            if !holder_place.is_empty() {
                lead.insert("where".into(), str_value(holder_place));
            }
            if !about.is_empty() {
                lead.insert("about".into(), str_value(about));
            }
            if was_asked {
                lead.insert("asked_before".into(), Value::Bool(true));
            }
            candidates.push(Candidate { score: if was_asked { score - 6 } else { score }, lead });
        } else if !place.is_empty() {
            lead.insert("kind".into(), str_value("place"));
            lead.insert("match".into(), str_value(matched));
            lead.insert("where".into(), str_value(place));
            if !about.is_empty() {
                lead.insert("about".into(), str_value(about));
            }
            candidates.push(Candidate { score, lead });
        }
    }
    let world_map = public_world_map(state);
    for_each_world_hook(world_map.as_ref(), |place, value| {
        let hook = clean(Some(value), 240);
        if hook.is_empty() || text_names_npc(&hook, profile) {
            return;
        }
        let score = stem_overlap(&asked, &lead_stems(&hook, None));
        if score != 0 {
            let mut lead = Map::new();
            lead.insert("kind".into(), str_value("hook"));
            lead.insert("match".into(), str_value("question"));
            lead.insert("where".into(), str_value(clean_str(&place, 240)));
            lead.insert("text".into(), str_value(hook));
            candidates.push(Candidate { score: score * 3, lead });
        }
    });
    let any_fresh = candidates.iter().any(|entry| !js::truthy(entry.lead.get("asked_before")));
    let mut pool: Vec<Candidate> = if any_fresh { candidates.into_iter().filter(|entry| !js::truthy(entry.lead.get("asked_before"))).collect() } else { candidates };
    pool.sort_by(|left, right| right.score.cmp(&left.score));
    let mut seen = HashSet::new();
    Ok(pool
        .into_iter()
        .map(|entry| entry.lead)
        .filter(|lead| {
            let label = ["name", "text", "where"].iter().find_map(|key| lead.get(*key).filter(|value| !value.is_null())).map_or_else(String::new, |value| js::s(Some(value)));
            let key = lower(&format!("{}:{label}", js::string(lead.get("kind"))));
            seen.insert(key)
        })
        .take(NPC_LEAD_LIMIT)
        .map(Value::Object)
        .collect())
}

/// Зацепка одной фразой для запасного ответа: только имя, роль и место.
fn lead_line(lead: &Value) -> String {
    let lead = Some(lead);
    match get(lead, "kind").and_then(Value::as_str) {
        Some("person") => {
            let role = get(lead, "role").filter(|value| js::truthy(Some(value))).map_or_else(String::new, |role| format!(", {}", js::string(Some(role))));
            let place = get(lead, "where").filter(|value| js::truthy(Some(value))).map_or_else(String::new, |place| format!(" — ищите там: {}", js::string(Some(place))));
            format!("Об этом больше знает {}{role}{place}.", js::string(get(lead, "name")))
        }
        Some("place") => format!("Если где и искать, то там: {}.", js::string(get(lead, "where"))),
        Some("hook") => format!("Слышали, что говорят? {}", js::string(get(lead, "text"))),
        _ => String::new(),
    }
}

/// Реплика-признание, когда всё новое в ответе оказалось повтором.
fn repeat_acknowledgement(leads: &[Value]) -> String {
    let lead = leads.iter().find(|entry| !is_str(get(Some(entry), "kind"), "self"));
    let own = leads.iter().find(|entry| is_str(get(Some(entry), "kind"), "self"));
    if let Some(lead) = lead {
        return format!("Всё, что знаю, вы уже слышали. {}", lead_line(lead));
    }
    if own.is_some() {
        return "Всё, что можно сказать задаром, вы уже слышали. Остальное — не бесплатно.".into();
    }
    "Всё, что знаю, вы уже слышали.".into()
}

/// Что отряд уже знает: находки, открытые за игру, — последние восемь.
fn party_known_facts(state: &Value) -> R<Vec<String>> {
    let facts = filterable(get(world_memory(state), "facts"))?;
    let found: Vec<String> = facts
        .iter()
        .filter(|fact| {
            is_str(get(Some(fact), "predicate"), "discovery") && is_str(get(Some(fact), "visibility"), "party") && !is_str(get(Some(fact), "status"), "superseded")
        })
        .map(|fact| clean(get(Some(fact), "summary"), 240))
        .filter(|summary| !summary.is_empty())
        .collect();
    Ok(last_n(&found, 8).to_vec())
}

// --- бриф ---------------------------------------------------------------------------

fn selection(scope: &str, count: usize, limit: usize) -> Value {
    let scope = str_value(scope);
    let count = Value::from(count);
    let limit = Value::from(limit);
    bounded_selection_metadata(&SelectionOptions { scope: Some(&scope), candidate_count: Some(&count), limit: Some(&limit), source_available: None })
}

/// `selectionFields(metadata, prefix)`.
fn selection_fields(target: &mut Map<String, Value>, metadata: &Value, prefix: &str) {
    let metadata = Some(metadata);
    for key in ["scope", "status", "availability", "complete_within_scope"] {
        put(target, &format!("{prefix}_{key}"), get(metadata, key));
    }
    if let Some(reason) = get(metadata, "truncation_reason").filter(|value| js::truthy(Some(value))) {
        target.insert(format!("{prefix}_truncation_reason"), reason.clone());
    }
}

/// Добавочные поля брифа: повторная попытка и только что увиденное.
#[derive(Debug, Clone, Default)]
struct BriefOptions<'a> {
    leads: &'a [Value],
    repeat_retry: bool,
    repeated_lines: Vec<String>,
    just_seen: Option<&'a Value>,
}

fn social_state(state: &Value) -> Value {
    ensure_npc_social_state(&get(Some(state), "social").cloned().unwrap_or(Value::Null), state, &Value::Null)
}

fn relationship_of<'a>(social: &'a Value, profile: &Value, player_id: &str) -> Option<&'a Value> {
    let npc_id = js::string(get(Some(profile), "id"));
    get(get(get(Some(social), "relationships"), &npc_id), player_id).filter(|value| !value.is_null())
}

fn brief_for(state: &Value, profile: &Value, player_id: &str, message: Option<&Value>, check: Option<&Value>, options: &BriefOptions<'_>) -> R<Value> {
    let social = social_state(state);
    let social = &social;
    let player = str_value(player_id);
    let already_said = already_said_for_brief(social, profile, player_id);
    let already_said_candidates = conversations(social).iter().filter(|entry| same_npc(entry, profile) && conversation_visible_to(entry, player_id)).count();
    let hero_card = hero_card_for_agent(state, Some(&player));
    let current_conversation: Vec<&Value> = conversations(social)
        .iter()
        .filter(|entry| same_npc(entry, profile) && is_str(get(Some(entry), "hero_id"), player_id) && conversation_visible_to(entry, player_id))
        .collect();
    let party_conversation: Vec<&Value> = conversations(social)
        .iter()
        .filter(|entry| same_npc(entry, profile) && !is_str(get(Some(entry), "hero_id"), player_id) && conversation_visible_to(entry, player_id))
        .collect();
    let recent_ids: Vec<&Value> = last_n(&current_conversation, 6)
        .iter()
        .chain(last_n(&party_conversation, 4).iter())
        .filter_map(|entry| get(Some(entry), "id"))
        .filter(|id| js::truthy(Some(id)))
        .collect();
    let open_promises: Vec<&Value> = arr(get(Some(social), "promises"))
        .iter()
        .filter(|entry| same_npc(entry, profile) && is_str(get(Some(entry), "hero_id"), player_id) && is_str(get(Some(entry), "status"), "open"))
        .collect();
    let relevant_memory = relevant_npc_memory(social, profile, player_id, message);
    let speakable_facts = npc_facts(state, profile, message, 500, false)?;
    let speakable_claims = npc_claims(state, profile, message)?;
    let public_hooks = public_hooks_naming_npc(state, profile);
    let dossier_count = arr(get(Some(profile), "dossier")).iter().filter(|entry| dossier_visible(entry, player_id)).count();
    let relevant_memory_candidates = current_conversation.len() + dossier_count;
    let speakable_fact_count = npc_speakable_fact_records(state, profile)?.len();
    let speakable_claim_count = npc_speakable_claim_records(state, profile)?.len();
    let fact_selection = selection("facts_known_to_npc_and_available_for_dialogue", speakable_fact_count, NPC_SOCIAL_MEMORY_LIMIT);
    let claim_selection = selection("claims_held_by_npc_and_available_for_dialogue", speakable_claim_count, NPC_SOCIAL_MEMORY_LIMIT);
    let promise_selection = selection("open_promises_between_npc_and_active_hero", open_promises.len(), 10);
    let conversation_selection = selection("visible_conversation_with_active_hero", current_conversation.len(), 6);
    let party_selection = selection("party_visible_conversation_with_other_heroes", party_conversation.len(), 4);
    let memory_selection = selection("visible_relevant_npc_memory", relevant_memory_candidates, NPC_SOCIAL_MEMORY_LIMIT);
    let hook_selection = selection("party_visible_world_hooks_naming_npc", public_hooks.len(), NPC_PUBLIC_HOOK_LIMIT);

    let role = str_value("npc_social");
    let contract = str_value(NPC_SOCIAL_PROMPT_VERSION);
    let mut brief = Map::new();
    brief.insert(
        "context_metadata".into(),
        agent_context_metadata(state, &AgentContextOptions { role: Some(&role), actor_id: Some(&player), target_id: get(Some(profile), "id"), contract_version: Some(&contract) }),
    );
    brief.insert("campaign_premise".into(), campaign_concept_for_agent(state, None));
    let scene = get(Some(state), "scene");
    let mut scene_brief = Map::new();
    scene_brief.insert("title".into(), str_value(clean(get(scene, "title"), 160)));
    scene_brief.insert("location".into(), str_value(clean(get(scene, "location"), 180)));
    scene_brief.insert("mood".into(), str_value(clean(get(scene, "mood"), 160)));
    let context = scene_context_for_agent(state, Some(&player));
    put(&mut scene_brief, "spatial_context", get(Some(&context), "spatial_context"));
    brief.insert("scene".into(), Value::Object(scene_brief));
    brief.insert("scene_canon".into(), json!(scene_canon_for(state)));
    brief.insert("table_knows".into(), json!(party_known_facts(state)?));
    let relationship = relationship_of(social, profile, player_id);
    let mut npc = Map::new();
    for key in ["id", "name", "role", "public_summary", "voice", "speech_profile"] {
        put(&mut npc, key, get(Some(profile), key));
    }
    let zero = Value::from(0);
    npc.insert("behavior_policy".into(), npc_behavior_policy(profile, Some(relationship.unwrap_or(&zero))));
    brief.insert("npc".into(), Value::Object(npc));
    let score = relationship.cloned().unwrap_or_else(|| zero.clone());
    brief.insert("relationship".into(), json!({ "score": score, "tier": relationship_tier(&score) }));
    if let Some(card) = hero_card {
        brief.insert("speaking_hero".into(), card);
    }
    brief.insert("table".into(), tavern_table_mood(state, &player).unwrap_or(Value::Null));
    brief.insert(
        "open_promises".into(),
        Value::Array(
            last_n(&open_promises, 10)
                .iter()
                .map(|entry| {
                    let mut out = Map::new();
                    for key in ["id", "direction", "text", "due_hint"] {
                        put(&mut out, key, get(Some(entry), key));
                    }
                    Value::Object(out)
                })
                .collect(),
        ),
    );
    let recent: Vec<Map<String, Value>> = last_n(&current_conversation, 6)
        .iter()
        .map(|entry| {
            let entry = Some(*entry);
            let mut out = Map::new();
            for key in ["player_message", "npc_reply", "stance"] {
                put(&mut out, key, get(entry, key));
            }
            if let Some(check) = get(entry, "check").filter(|value| js::truthy(Some(value))) {
                let mut summary = Map::new();
                for key in ["skill", "success", "degree"] {
                    put(&mut summary, key, get(Some(check), key));
                }
                out.insert("check".into(), Value::Object(summary));
            }
            out
        })
        .collect();
    brief.insert("recent_conversation".into(), Value::Array(with_reply_gists(recent, 2)));
    let mut party = Vec::new();
    for entry in last_n(&party_conversation, 4) {
        let entry = Some(*entry);
        let mut out = Map::new();
        out.insert("hero".into(), str_value(hero_name(state, get(entry, "hero_id"))?));
        for key in ["player_message", "npc_reply", "stance"] {
            put(&mut out, key, get(entry, key));
        }
        party.push(out);
    }
    brief.insert("recent_party_conversation".into(), Value::Array(with_reply_gists(party, 1)));
    let memory: Vec<Value> = relevant_memory
        .into_iter()
        .filter(|entry| !is_str(get(Some(entry), "kind"), "conversation") || !get(Some(entry), "id").is_some_and(|id| recent_ids.iter().any(|recent| strict_eq(Some(recent), Some(id)))))
        .map(|entry| {
            if is_str(get(Some(&entry), "kind"), "conversation") && js::truthy(get(Some(&entry), "npc_reply")) {
                let mut rest = entry.as_object().cloned().unwrap_or_default();
                let reply = rest.shift_remove("npc_reply");
                rest.insert("npc_reply_gist".into(), str_value(reply_gist(reply.as_ref())));
                Value::Object(rest)
            } else {
                entry
            }
        })
        .collect();
    brief.insert("relevant_memory".into(), Value::Array(memory));
    brief.insert("speakable_facts".into(), Value::Array(speakable_facts));
    brief.insert("speakable_claims".into(), Value::Array(speakable_claims));
    brief.insert("public_hooks_naming_npc".into(), Value::Array(public_hooks.iter().take(NPC_PUBLIC_HOOK_LIMIT).cloned().collect()));
    brief.insert("leads".into(), Value::Array(options.leads.iter().take(NPC_LEAD_LIMIT).cloned().collect()));
    brief.insert("already_said".into(), json!(already_said));
    brief.insert("others_said".into(), Value::Array(others_said_nearby(state, social, profile)));
    let just_seen = clean(options.just_seen, 600);
    if !just_seen.is_empty() {
        brief.insert("just_seen".into(), str_value(just_seen));
    }
    if options.repeat_retry {
        brief.insert("repeat_retry".into(), Value::Bool(true));
        if !options.repeated_lines.is_empty() {
            let lines: Vec<String> = options.repeated_lines.iter().map(|line| clean_str(line, 300)).filter(|line| !line.is_empty()).take(6).collect();
            brief.insert("repeated_lines".into(), json!(lines));
        }
    }
    selection_fields(&mut brief, &selection("server_safe_leads_for_conversation_topic", options.leads.len(), NPC_LEAD_LIMIT), "leads");
    selection_fields(&mut brief, &selection("npc_replies_visible_to_active_hero", already_said_candidates, NPC_ALREADY_SAID_LIMIT), "already_said");
    selection_fields(&mut brief, &conversation_selection, "recent_conversation");
    selection_fields(&mut brief, &party_selection, "recent_party_conversation");
    selection_fields(&mut brief, &memory_selection, "relevant_memory");
    selection_fields(&mut brief, &fact_selection, "speakable_facts");
    selection_fields(&mut brief, &claim_selection, "speakable_claims");
    selection_fields(&mut brief, &hook_selection, "public_hooks_naming_npc");
    selection_fields(&mut brief, &promise_selection, "open_promises");
    brief.insert("player_message".into(), str_value(clean(message, 1_000)));
    let resolved = match check {
        Some(check) => {
            let mut out = Map::new();
            for key in ["skill", "ability", "success", "degree"] {
                put(&mut out, key, get(Some(check), key));
            }
            Value::Object(out)
        }
        None => Value::Null,
    };
    brief.insert("resolved_check".into(), resolved);
    Ok(Value::Object(brief))
}

// --- запасной ответ ------------------------------------------------------------------

struct Disclosure {
    reply: String,
    claim_ids: Vec<String>,
    fact_ids: Vec<String>,
}

impl Disclosure {
    fn say(reply: String) -> Self {
        Self { reply, claim_ids: Vec::new(), fact_ids: Vec::new() }
    }
}

/// Детерминированный ответ, когда модели нет или она не ответила
/// (`fallbackDisclosure`).
#[allow(clippy::too_many_arguments)] // повторяет сигнатуру JS-функции
fn fallback_disclosure(
    profile: &Value,
    facts: &[Value],
    claims: &[Value],
    check: Option<&Value>,
    memory: &[Value],
    message: Option<&Value>,
    hooks: &[Value],
    earlier_replies: &[String],
    leads: &[Value],
) -> Disclosure {
    let repeat_index = earlier_reply_index(earlier_replies);
    let already_said = |value: &str| earlier_replies.iter().any(|reply| reply.contains(value)) || sentence_repeats(value, &repeat_index);
    let usable_lead = leads.iter().find(|lead| !is_str(get(Some(lead), "kind"), "self") && !already_said(&lead_line(lead)));
    let own_secret_asked = leads.iter().any(|lead| is_str(get(Some(lead), "kind"), "self") && is_str(get(Some(lead), "match"), "question"));
    let with_lead = |line: &str| match usable_lead {
        Some(lead) => format!("{line} {}", lead_line(lead)),
        None => line.to_string(),
    };
    let name = js::string(get(Some(profile), "name"));
    if is_str(get(check, "skill"), "insight") {
        let reply = if js::truthy(get(check, "success")) {
            format!("{name} отвечает уклончиво, и за словами угадывается что-то недосказанное.")
        } else {
            format!("{name} отвечает ровно — по лицу ничего не прочесть.")
        };
        return Disclosure::say(reply);
    }
    if js::truthy(get(check, "success")) {
        let secret = if own_secret_asked { fallback_secret_answer(profile, message, facts, &already_said) } else { None };
        if let Some((id, sentence)) = secret {
            return Disclosure { reply: format!("{name} сдаётся: «{sentence}»"), claim_ids: Vec::new(), fact_ids: vec![id] };
        }
        return Disclosure::say(format!("{name} отвечает: «{}»", with_lead("Ладно. Говори, я слушаю.")));
    }
    if check.is_some() {
        return Disclosure::say(format!("{name} отвечает: «{}»", with_lead("Нет. Меня это не убеждает.")));
    }
    let request = lower(&clean(message, 1_000));
    if text::test(re!(r"(?:пообещ|обещани|помоги|проведи|передай|открой)", "iu"), &request) {
        return Disclosure::say(format!("{name} разводит руками: «Обещать пока нечего — скажи, чем именно помочь.»"));
    }
    if text::test(re!(r"(?:напомни|вспомни|сигнал|договор|обещал|что мы)", "iu"), &request) {
        let remembered = memory.iter().find(|entry| is_str(get(Some(entry), "kind"), "conversation") && js::truthy(get(Some(entry), "npc_reply")));
        if let Some(remembered) = remembered {
            return Disclosure::say(format!("{name} повторяет: «{}»", clean(get(Some(remembered), "npc_reply"), 500)));
        }
    }
    if let Some((kind, sentence)) = fallback_answer(profile, message, hooks, facts, &already_said) {
        return Disclosure::say(if kind == "hook" { format!("{name} подтверждает: «{sentence}»") } else { format!("{name} отвечает: «{sentence}»") });
    }
    let summary_of = |claim: &Value| js::s(get(Some(claim), "summary"));
    if let Some(rumor) = claims.iter().find(|claim| is_str(get(Some(claim), "kind"), "rumor") && !already_said(&summary_of(claim))) {
        return Disclosure { reply: format!("{name} понижает голос: «{}»", js::string(get(Some(rumor), "summary"))), claim_ids: vec![js::string(get(Some(rumor), "id"))], fact_ids: Vec::new() };
    }
    if let Some(belief) = claims.iter().find(|claim| !already_said(&summary_of(claim))) {
        return Disclosure { reply: format!("{name} отвечает: «{}»", js::string(get(Some(belief), "summary"))), claim_ids: vec![js::string(get(Some(belief), "id"))], fact_ids: Vec::new() };
    }
    if own_secret_asked {
        return Disclosure::say(format!("{name} отвечает уклончиво: «Может, что-то и знаю. Но просто так такое не рассказывают.»"));
    }
    if let Some(lead) = usable_lead {
        return Disclosure::say(format!("{name} качает головой: «Больше мне сказать нечего. {}»", lead_line(lead)));
    }
    Disclosure::say(format!("{name} качает головой: «Больше мне сказать нечего.»"))
}

/// Предложения текста для запасного ответа: `clean(…, 1000)`, разбивка, `clean(…, 320)`.
fn answer_sentences(value: Option<&Value>) -> Vec<String> {
    split_sentences(&clean(value, 1_000)).into_iter().map(|part| clean_str(&part, 320)).filter(|part| !part.is_empty()).collect()
}

/// Собственная тайна собеседника по вопросу героя — одним предложением.
fn fallback_secret_answer(profile: &Value, message: Option<&Value>, facts: &[Value], already_said: &dyn Fn(&str) -> bool) -> Option<(String, String)> {
    let stems = fallback_question_stems(profile, message);
    if stems.is_empty() {
        return None;
    }
    let mut best: Option<(String, String, usize)> = None;
    for fact in facts.iter().filter(|entry| js::truthy(get(Some(entry), "guarded"))) {
        for sentence in answer_sentences(get(Some(fact), "summary")) {
            let words = plain_words_str(&sentence, 2_000);
            if sentence_describes_npc(&words, profile) || already_said(&sentence) {
                continue;
            }
            let score = stems.iter().filter(|stem| words.iter().any(|word| word.starts_with(stem.as_str()))).count();
            if score >= 1 && best.as_ref().is_none_or(|(_, _, top)| score > *top) {
                best = Some((js::string(get(Some(fact), "id")), sentence, score));
            }
        }
    }
    best.map(|(id, sentence, _)| (id, sentence))
}

/// Основы слов вопроса без обращения и без имени самого собеседника.
fn fallback_question_stems(profile: &Value, message: Option<&Value>) -> Vec<String> {
    let name_parts = plain_words(get(Some(profile), "name"), 200);
    let words = plain_words_str(&text::replace_first(address_prefix_re(), &clean(message, 1_000), ""), 2_000);
    let stems: IndexSet<String> = words
        .into_iter()
        .filter(|word| char_len(word) >= 4 && !FALLBACK_QUESTION_STOP_WORDS.contains(&word.as_str()))
        .filter(|word| !name_parts.iter().any(|part| word_names_part(word, part)))
        .map(|word| word_stem(&word))
        .collect();
    stems.into_iter().collect()
}

/// Лучшее совпавшее с вопросом предложение из публичных зацепок о собеседнике
/// и открытых фактов: `(kind, sentence)`.
fn fallback_answer(profile: &Value, message: Option<&Value>, hooks: &[Value], facts: &[Value], already_said: &dyn Fn(&str) -> bool) -> Option<(&'static str, String)> {
    let stems = fallback_question_stems(profile, message);
    if stems.is_empty() {
        return None;
    }
    let mut candidates: Vec<(&'static str, Option<&Value>)> = hooks.iter().map(|hook| ("hook", get(Some(hook), "text"))).collect();
    candidates.extend(
        facts
            .iter()
            .filter(|fact| !js::truthy(get(Some(fact), "guarded")) && !js::truthy(get(Some(fact), "party_finding")))
            .map(|fact| ("fact", get(Some(fact), "summary"))),
    );
    let mut best: Option<(&'static str, String, usize)> = None;
    for (kind, value) in candidates {
        let mut sentences = answer_sentences(value);
        if sentences.len() > 1 && sentences.last().is_some_and(|last| !text::test(re!(r#"[.!?…»"')]$"#, "u"), last)) {
            sentences.pop();
        }
        for sentence in sentences {
            let words = plain_words_str(&sentence, 2_000);
            if kind == "fact" && sentence_describes_npc(&words, profile) {
                continue;
            }
            let score = stems.iter().filter(|stem| words.iter().any(|word| word.starts_with(stem.as_str()))).count();
            if score < 1 || already_said(&sentence) {
                continue;
            }
            if best.as_ref().is_none_or(|(_, _, top)| score > *top) {
                best = Some((kind, sentence, score));
            }
        }
    }
    best.map(|(kind, sentence, _)| (kind, sentence))
}

fn promise_within_boundary(promise_text: &str, profile: &Value) -> bool {
    let value = lower(&clean_str(promise_text, 500));
    let policy = npc_behavior_policy(profile, None);
    let boundaries = get(Some(&policy), "boundaries");
    if js::truthy(get(boundaries, "protects_people")) && text::test(re!(r"убить|убью|напад|пытк|погуб|выдам\s+людей", "iu"), &value) {
        return false;
    }
    if js::truthy(get(boundaries, "keeps_secrets")) && text::test(re!(r"раскро|выдам|расскажу|сообщу\s+тайн|открою\s+секрет", "iu"), &value) {
        return false;
    }
    true
}

/// `stableId(namespace, ...parts)`.
fn stable_id(namespace: &str, parts: &[Option<&Value>]) -> String {
    let joined = parts.iter().map(|part| clean(*part, 1_000)).collect::<Vec<_>>().join("\0");
    format!("{namespace}:{}", text::head(&hash::sha256_hex(joined.as_bytes()), 24))
}

/// `[...new Set(ids)].slice(0, 20)` по разрешённым.
fn allowed_unique(ids: Vec<String>, allowed: &HashSet<String>) -> Vec<String> {
    let unique: IndexSet<String> = ids.into_iter().filter(|id| allowed.contains(id)).collect();
    unique.into_iter().take(20).collect()
}

fn raw_ids(raw: &Value, key: &str) -> Vec<String> {
    arr(get(Some(raw), key).filter(|value| value.is_array())).iter().map(|id| js::string(Some(id))).collect()
}

#[allow(clippy::too_many_arguments)] // повторяет сигнатуру JS-функции
fn normalized_result(raw: &Value, profile: &Value, state: &Value, player_id: &str, message: Option<&Value>, turn_id: Option<&Value>, check: Option<&Value>, leads: &[Value]) -> R<Map<String, Value>> {
    let social = social_state(state);
    let social = &social;
    let facts = npc_facts(state, profile, message, 500, false)?;
    let memory = relevant_npc_memory(social, profile, player_id, message);
    let claims = npc_claims(state, profile, message)?;
    let allowed_facts: HashSet<String> = npc_speakable_fact_records(state, profile)?.iter().map(|fact| js::string(get(Some(fact), "id"))).collect();
    let allowed_claims: HashSet<String> = npc_speakable_claim_records(state, profile)?.iter().map(|claim| js::string(get(Some(claim), "id"))).collect();
    let model_reply = match get(Some(raw), "reply") {
        Some(Value::String(reply)) => clean_str(reply, 1_000),
        _ => String::new(),
    };
    let (answer_facts, fallback) = if model_reply.is_empty() {
        let stems = str_value(fallback_question_stems(profile, message).join(" "));
        let answer_facts = npc_facts(state, profile, Some(&stems), 4_000, true)?;
        let answer_hooks = public_hooks_naming_npc(state, profile);
        let earlier = npc_earlier_replies(social, profile, player_id, true);
        let fallback = fallback_disclosure(profile, &answer_facts, &claims, check, &memory, message, &answer_hooks, &earlier, leads);
        (answer_facts, fallback)
    } else {
        (Vec::new(), Disclosure::say(String::new()))
    };
    let mut fact_ids = raw_ids(raw, "disclosed_fact_ids");
    fact_ids.extend(fallback.fact_ids.iter().cloned());
    let disclosed_facts = allowed_unique(fact_ids, &allowed_facts);
    let mut claim_ids = raw_ids(raw, "disclosed_claim_ids");
    claim_ids.extend(fallback.claim_ids.iter().cloned());
    let disclosed_claims = allowed_unique(claim_ids, &allowed_claims);
    let reply = if model_reply.is_empty() { fallback.reply } else { model_reply };
    let private = private_knowledge_disclosed(state, profile, &disclosed_facts, &disclosed_claims)? || {
        let mut all_facts = facts.clone();
        all_facts.extend(answer_facts.iter().cloned());
        let texts = private_material_texts(state, social, profile, player_id, &all_facts)?;
        let baseline = open_conversation_text(state, social, profile, player_id, message, &facts, &public_hooks_naming_npc(state, profile));
        reply_echoes_private_material(&reply, &texts, &baseline)
    };
    let visibility = if private { "specific_player" } else { "party" };
    let stance = get(Some(raw), "stance").and_then(Value::as_str).filter(|stance| STANCES.contains(stance)).unwrap_or("neutral");
    let delta_source = get(Some(raw), "relationship_delta");
    let mut delta = if js::is_safe_integer_number(delta_source) { js::number(delta_source) } else { 0.0 };
    delta = delta.clamp(-2.0, 2.0);
    let mut promise = Value::Null;
    if let Some(raw_promise @ Value::Object(_)) = get(Some(raw), "promise") {
        let direction = get(Some(raw_promise), "direction").and_then(Value::as_str).filter(|direction| DIRECTIONS.contains(direction));
        if let Some(direction) = direction {
            let promise_text = clean(get(Some(raw_promise), "text"), 500);
            let due_hint = clean(get(Some(raw_promise), "due_hint"), 240);
            if !promise_text.is_empty() && !due_hint.is_empty() && promise_within_boundary(&promise_text, profile) {
                let player = str_value(player_id);
                let text_value = str_value(promise_text.clone());
                promise = json!({
                    "id": stable_id("promise", &[turn_id, get(Some(profile), "id"), Some(&player), Some(&text_value)]),
                    "direction": direction,
                    "text": promise_text,
                    "due_hint": due_hint,
                    "visibility": visibility,
                });
            }
        }
    }
    if is_str(get(check, "skill"), "insight") {
        delta = 0.0;
        promise = Value::Null;
    } else if check.is_some() && !js::truthy(get(check, "success")) {
        delta = delta.min(0.0);
        promise = Value::Null;
    }
    let confidence_number = js::number(get(Some(raw), "confidence"));
    let confidence = if confidence_number.is_nan() || confidence_number == 0.0 { 0.0 } else { confidence_number }.clamp(0.0, 1.0);
    let player = str_value(player_id);
    let mut conversation = Map::new();
    conversation.insert("id".into(), str_value(stable_id("conversation", &[turn_id, get(Some(profile), "id"), Some(&player)])));
    put(&mut conversation, "npc_id", get(Some(profile), "id"));
    conversation.insert("hero_id".into(), player.clone());
    conversation.insert("player_message".into(), str_value(clean(message, 1_000)));
    conversation.insert("npc_reply".into(), str_value(reply.clone()));
    conversation.insert("stance".into(), str_value(stance));
    conversation.insert("disclosed_fact_ids".into(), json!(disclosed_facts));
    conversation.insert("disclosed_claim_ids".into(), json!(disclosed_claims));
    conversation.insert("relationship_delta".into(), js::num(delta));
    conversation.insert("visibility".into(), str_value(visibility));
    if !promise.is_null() {
        conversation.insert("promise".into(), promise.clone());
    }
    if let Some(check) = check {
        conversation.insert("check".into(), check.clone());
    }
    let mut out = Map::new();
    put(&mut out, "npc_id", get(Some(profile), "id"));
    out.insert("reply".into(), str_value(reply));
    out.insert("stance".into(), str_value(stance));
    out.insert("disclosed_fact_ids".into(), json!(disclosed_facts));
    out.insert("disclosed_claim_ids".into(), json!(disclosed_claims));
    out.insert("relationship_delta".into(), js::num(delta));
    out.insert("promise".into(), promise);
    out.insert("confidence".into(), js::num(confidence));
    out.insert("visibility".into(), str_value(visibility));
    out.insert("conversation".into(), Value::Object(conversation));
    Ok(out)
}

// --- проверка ответа модели --------------------------------------------------------

fn finite_number(value: &Value) -> bool {
    value.as_f64().is_some_and(f64::is_finite)
}

/// Ответ модели нужной формы (`structurallyValidSocialResponse`).
fn structurally_valid_social_response(value: &Value) -> bool {
    let Value::Object(map) = value else {
        return false;
    };
    if map.keys().any(|key| !NPC_SOCIAL_RESPONSE_FIELDS.contains(&key.as_str())) {
        return false;
    }
    match map.get("reply") {
        Some(Value::String(reply)) if !text::trim(reply).is_empty() => {}
        _ => return false,
    }
    if map.get("npc_id").is_some_and(|id| !id.is_string()) {
        return false;
    }
    if map.get("stance").is_some_and(|stance| !stance.as_str().is_some_and(|stance| STANCES.contains(&stance))) {
        return false;
    }
    for key in ["disclosed_fact_ids", "disclosed_claim_ids"] {
        if map.get(key).is_some_and(|ids| !ids.as_array().is_some_and(|ids| ids.iter().all(Value::is_string))) {
            return false;
        }
    }
    if map.get("relationship_delta").is_some_and(|delta| !finite_number(delta)) {
        return false;
    }
    if map.get("confidence").is_some_and(|confidence| !finite_number(confidence)) {
        return false;
    }
    if let Some(promise) = map.get("promise").filter(|promise| !promise.is_null()) {
        let Value::Object(fields) = promise else {
            return false;
        };
        let filled = |key: &str| matches!(fields.get(key), Some(Value::String(value)) if !text::trim(value).is_empty());
        if fields.keys().any(|key| !["direction", "text", "due_hint"].contains(&key.as_str()))
            || !fields.get("direction").and_then(Value::as_str).is_some_and(|direction| DIRECTIONS.contains(&direction))
            || !filled("text")
            || !filled("due_hint")
        {
            return false;
        }
    }
    true
}

fn string_ids(value: &Value, key: &str) -> Vec<String> {
    arr(get(Some(value), key)).iter().map(|id| js::string(Some(id))).collect()
}

// --- роль ----------------------------------------------------------------------------

/// `NpcSocialController`: реплика постоянного NPC через модель или
/// детерминированный ответ.
#[derive(Clone)]
pub struct NpcSocialController {
    llm_client: Option<Arc<dyn LlmClient>>,
    /// Имя класса клиента JS (`llmClient.constructor.name`), которое уходит в
    /// `provider`: `MeteredLLMClient`, `FallbackLLMClient`, `FakeLLM`.
    provider_name: String,
}

/// Разобранный вход `respond({ state, playerId, npcId, message, turnId,
/// checkOutcome, justSeen })`.
struct RespondInput<'a> {
    state: &'a Value,
    hero_id: String,
    message: Option<&'a Value>,
    turn_id: Option<&'a Value>,
    check: Option<&'a Value>,
    just_seen: Option<&'a Value>,
}

impl NpcSocialController {
    /// `new NpcSocialController({ llmClient })`.
    pub fn new(llm_client: Option<Arc<dyn LlmClient>>) -> Self {
        Self { llm_client, provider_name: String::new() }
    }

    /// Имя класса клиента для поля `provider` (`constructor.name`); пустое — `llm`.
    pub fn with_provider_name(mut self, name: impl Into<String>) -> Self {
        self.provider_name = name.into();
        self
    }

    fn provider(&self) -> &str {
        if self.provider_name.is_empty() {
            "llm"
        } else {
            &self.provider_name
        }
    }

    /// `respond(input)`: реплика NPC или `None` (NPC нет или он недоступен).
    /// `input` — объект JS `{ state, playerId, npcId, message, turnId,
    /// checkOutcome, justSeen }`; `Err` — исключение, которое JS пропустил бы
    /// наружу (мусорное состояние вне вызова модели).
    pub async fn respond(&self, input: &Value) -> Result<Option<Value>, NpcSocialError> {
        let empty_state = json!({});
        let empty_text = str_value("");
        let source = Some(input);
        let field = |key: &str| get(source, key);
        let state = field("state").unwrap_or(&empty_state);
        if state.is_null() {
            return Err(NpcSocialError::type_error("Cannot read properties of null (reading 'social')"));
        }
        let player_id = field("playerId").unwrap_or(&empty_text);
        let npc_id = js::string(Some(field("npcId").unwrap_or(&empty_text)));
        let message = Some(field("message").unwrap_or(&empty_text));
        let turn_id = Some(field("turnId").unwrap_or(&empty_text));
        let check = field("checkOutcome").filter(|value| js::truthy(Some(value)));
        let just_seen = Some(field("justSeen").unwrap_or(&empty_text));

        social_iteration_guard(state)?;
        let social = social_state(state);
        let Some(persisted) = arr(get(Some(&social), "npcs")).iter().find(|npc| is_str(get(Some(npc), "id"), &npc_id)) else {
            return Ok(None);
        };
        let profile = npc_profile_at_world_time(persisted, state);
        if js::is_false(get(Some(&profile), "available")) {
            return Ok(None);
        }
        let role = str_value("npc_social");
        let contract = str_value(NPC_SOCIAL_PROMPT_VERSION);
        let context_metadata = agent_context_metadata(
            state,
            &AgentContextOptions { role: Some(&role), actor_id: Some(player_id), target_id: get(Some(&profile), "id"), contract_version: Some(&contract) },
        );
        let facts = npc_facts(state, &profile, message, 500, false)?;
        let hero_id = js::string(Some(player_id));
        let leads = conversation_leads(state, &profile, message, Some(&social))?;
        let request = RespondInput { state, hero_id, message, turn_id, check, just_seen };
        let Some(client) = self.llm_client.as_ref() else {
            let mut out = normalized_result(&json!({}), &profile, state, &request.hero_id, message, turn_id, check, &leads)?;
            out.insert("context_metadata".into(), context_metadata);
            out.insert("provider".into(), str_value("deterministic-social-fallback"));
            out.insert("prompt_version".into(), str_value(NPC_SOCIAL_PROMPT_VERSION));
            return Ok(Some(Value::Object(out)));
        };
        match self.with_model(client.as_ref(), &request, &profile, &social, &leads).await {
            Ok((mut out, repetition)) => {
                out.insert("context_metadata".into(), context_metadata);
                out.insert("provider".into(), str_value(self.provider()));
                out.insert("prompt_version".into(), str_value(NPC_SOCIAL_PROMPT_VERSION));
                if let Some(repetition) = repetition {
                    out.insert("repetition".into(), str_value(repetition));
                }
                Ok(Some(Value::Object(out)))
            }
            Err(error) => {
                let mut out = normalized_result(&json!({}), &profile, state, &request.hero_id, message, turn_id, check, &leads)?;
                out.insert("context_metadata".into(), context_metadata);
                out.insert("provider".into(), str_value("deterministic-social-fallback"));
                out.insert("prompt_version".into(), str_value(NPC_SOCIAL_PROMPT_VERSION));
                let code = error.code.clone().unwrap_or_else(|| error.name.clone());
                out.insert("provider_error".into(), str_value(clean_str(&code, 80)));
                out.insert("facts_available".into(), Value::from(facts.len()));
                Ok(Some(Value::Object(out)))
            }
        }
    }

    /// Запрос к модели с брифом (`complete(options)` в JS).
    async fn complete(&self, client: &dyn LlmClient, request: &RespondInput<'_>, profile: &Value, options: &BriefOptions<'_>) -> R<Value> {
        let model = client.model();
        let system = prompt_for_model_role(NPC_SOCIAL_PROMPT, model.as_deref(), "npc");
        let brief = brief_for(request.state, profile, &request.hero_id, request.message, request.check, options)?;
        let mut sections = Map::new();
        sections.insert("npc_social_brief".into(), brief);
        let input = json!({
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": build_data_only_context(Some(&Value::Object(sections))) },
            ],
            "temperature": 0.7,
            "maxTokens": 700,
            "role": "npc",
            "jsonSchema": *NPC_SOCIAL_RESPONSE_JSON_SCHEMA,
        });
        Ok(client.complete_json(&input, &json!({ "timeoutMs": 20_000 })).await?)
    }

    /// Тело `try` в JS: ответ модели, антиповтор, нормализация.
    async fn with_model(&self, client: &dyn LlmClient, request: &RespondInput<'_>, profile: &Value, social: &Value, leads: &[Value]) -> R<(Map<String, Value>, Option<&'static str>)> {
        let state = request.state;
        let base = BriefOptions { leads, just_seen: request.just_seen, ..BriefOptions::default() };
        let mut result = self.complete(client, request, profile, &base).await?;
        if !structurally_valid_social_response(&result) {
            return Err(NpcSocialError::error("NPC_SOCIAL_RESPONSE_INVALID_SHAPE"));
        }
        let mut table_heard: Vec<String> = others_said_nearby(state, social, profile).iter().map(|entry| js::s(get(Some(entry), "npc_reply"))).collect();
        table_heard.extend(party_known_facts(state)?);
        let remind = text::test(remind_request(), &js::s(request.message));
        let earlier_for = |candidate: &Value| -> R<Vec<String>> {
            if remind {
                return Ok(Vec::new());
            }
            let disclosed = private_knowledge_disclosed(state, profile, &string_ids(candidate, "disclosed_fact_ids"), &string_ids(candidate, "disclosed_claim_ids"))?;
            let mut replies = npc_earlier_replies(social, profile, &request.hero_id, !disclosed);
            replies.extend(table_heard.iter().cloned());
            Ok(replies)
        };
        let mut repetition: Option<&str> = None;
        let fresh = fresh_reply_text(&js::s(get(Some(&result), "reply")), &earlier_for(&result)?);
        if fresh.text.is_empty() {
            let repeated_lines: Vec<String> = reply_sentences(&js::s(get(Some(&result), "reply"))).into_iter().take(6).collect();
            let retry = BriefOptions { repeat_retry: true, repeated_lines, ..base.clone() };
            let retried = self.complete(client, request, profile, &retry).await.unwrap_or(Value::Null);
            let retried_fresh = if js::truthy(Some(&retried)) && structurally_valid_social_response(&retried) {
                fresh_reply_text(&js::s(get(Some(&retried), "reply")), &earlier_for(&retried)?)
            } else {
                FreshReply { text: String::new(), dropped: 0 }
            };
            if !retried_fresh.text.is_empty() {
                result = js::spread(&retried, json!({ "reply": retried_fresh.text }));
                repetition = Some("regenerated");
            } else {
                result = js::spread(&result, json!({ "reply": repeat_acknowledgement(leads), "disclosed_fact_ids": [], "disclosed_claim_ids": [], "promise": null }));
                repetition = Some("acknowledged");
            }
        } else if fresh.dropped > 0 {
            result = js::spread(&result, json!({ "reply": fresh.text }));
            repetition = Some("trimmed");
        }
        let current = js::s(get(Some(&result), "reply"));
        let unlooped = without_circular_referral(&current, social, profile);
        if unlooped != current {
            result = js::spread(&result, json!({ "reply": unlooped }));
            repetition = repetition.or(Some("referral-trimmed"));
        }
        let out = normalized_result(&result, profile, state, &request.hero_id, request.message, request.turn_id, request.check, leads)?;
        Ok((out, repetition))
    }
}

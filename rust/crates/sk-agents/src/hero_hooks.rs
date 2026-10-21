//! Перенос `server/hero-hooks.mjs`: зацепки из предысторий героев.
//!
//! Модель по предыстории героя, завязке мира, стартовой сцене, её жителям и
//! местам предлагает одну–две скрытые зацепки на героя; сервер их проверяет и
//! записывает тем же путём, каким живут заготовки ведущего (`gm_secret`,
//! `gmSecretFact`, `RecordWorldFact`). Каждому герою — одна личная нить
//! (`UpsertNarrativeThread`), её заголовок — цель героя его же словами.
//!
//! Клиент модели внедряется ([`RoleClient`]); без него плетения нет, а мотивы
//! отряда для Режиссёра ([`party_motives_for_director`]) считаются без модели.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::{js, re, text};

use crate::director_agent::RoleClient;

/// `HERO_HOOKS_PROMPT_VERSION`.
pub const HERO_HOOKS_PROMPT_VERSION: &str = "hero_hooks/v1";
const PROMPT: &str = include_str!("../../../../prompts/hero_hooks/v1.txt");

/// `HERO_HOOK_LIMIT`: зацепок на героя не больше этого числа.
pub const HERO_HOOK_LIMIT: usize = 2;
/// `HERO_HOOK_MAX_ATTEMPTS`: попыток плетения на героя за жизнь процесса.
pub const HERO_HOOK_MAX_ATTEMPTS: f64 = 2.0;
/// `HERO_HOOK_RETRY_MS`: пауза перед повторной попыткой после неудачи.
pub const HERO_HOOK_RETRY_MS: f64 = 60_000.0;
const HERO_STORY_MIN: usize = 20;
const CLUE_MIN: usize = 20;
const CLUE_MAX: usize = 300;
const TOPIC_MAX: usize = 120;
const MOTIVE_MIN: usize = 4;
const MOTIVE_MAX: usize = 90;

/// Поля факта, которые принимает команда `RecordWorldFact`.
const FACT_COMMAND_FIELDS: [&str; 8] = ["id", "subject_id", "predicate", "object", "summary", "visibility", "source_event_ids", "supersedes_fact_id"];
/// Поля профиля, которые принимает `UpsertNpcSocialProfile`.
const PROFILE_FIELDS: [&str; 18] = [
    "id", "name", "role", "location", "location_id", "public_summary", "voice", "speech_profile", "goals", "beliefs", "known_fact_ids", "social_dcs", "visibility",
    "reveal_on_presence", "available", "tags", "schedule", "inventory",
];
const PLACEHOLDERS: [&str; 3] = ["не выбран", "не выбрано", "не определено"];

/// Механика в тексте зацепки: цифры, сложности, броски, хиты, урон.
fn mechanics(value: &str) -> bool {
    text::test(re!(r"(?:\d|(?<!\p{L})(?:СЛ|КД)(?!\p{L})|урон|(?<!\p{L})хит(?:ы|ов|ам)?(?!\p{L})|бросок|броск|бросить|проверк|спасброс|преимуществ|(?<!\p{L})помех)", "iu"), value)
}

// ---------------------------------------------------------------------------
// Приведения JS
// ---------------------------------------------------------------------------

/// `value?.[key]` для объекта.
fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value?.as_object()?.get(key)
}

/// `value?.a?.b`.
fn path<'a>(value: Option<&'a Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().try_fold(value?, |current, key| get(Some(current), key))
}

/// `Array.isArray(x) ? x : []` (и `x ?? []` там, где иное в JS бросило бы).
fn array(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

/// `a ?? b`.
fn coalesce<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    match first {
        Some(value) if !value.is_null() => Some(value),
        _ => second,
    }
}

/// `a || b`.
fn or<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    if js::truthy(first) {
        first
    } else {
        second
    }
}

/// `a === 'text'`.
fn is_str(value: Option<&Value>, expected: &str) -> bool {
    matches!(value, Some(Value::String(text)) if text == expected)
}

/// `text.slice(0, max)` в единицах UTF-16.
fn head_utf16(source: &str, max: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for ch in source.chars() {
        let width = ch.len_utf16();
        if units + width > max {
            break;
        }
        units += width;
        out.push(ch);
    }
    out
}

/// `text.length` в единицах UTF-16.
fn len16(source: &str) -> usize {
    source.encode_utf16().count()
}

/// `String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)`.
fn clean_str(value: &str, maximum: usize) -> String {
    head_utf16(&text::squash_spaces(&text::nfkc(value)), maximum)
}

fn clean(value: Option<&Value>, maximum: usize) -> String {
    clean_str(&js::s(value), maximum)
}

/// `clean(value, 400).toLocaleLowerCase('ru').replaceAll('ё', 'е')`.
fn lower(value: Option<&Value>) -> String {
    lower_str(&js::s(value))
}

fn lower_str(value: &str) -> String {
    text::lower(&clean_str(value, 400)).replace('ё', "е")
}

fn digest(value: &str) -> String {
    sk_core::hash::sha256_hex(value)
}

fn story_text(value: Option<&Value>, maximum: usize) -> String {
    let text = clean(value, maximum);
    if PLACEHOLDERS.contains(&text::lower(&text).as_str()) {
        String::new()
    } else {
        text
    }
}

fn stems(value: &str) -> IndexSet<String> {
    text::find_all(re!(r"\p{L}{5,}", "gu"), &lower_str(value)).into_iter().map(|word| head_utf16(&word, 5)).collect()
}

/// `String(text ?? '').split(/(?<=[.!?…])\s+/u)[0]`.
fn first_split(value: &str) -> String {
    match re!(r"(?<=[.!?…])\s+", "u").find(value) {
        Ok(Some(found)) => value[..found.start()].to_string(),
        _ => value.to_string(),
    }
}

/// `.replace(/[.!…]+$/u, '')`.
fn strip_end_marks(value: &str) -> String {
    text::replace_first(re!(r"[.!…]+$", "u"), value, "")
}

// ---------------------------------------------------------------------------
// Экспорты
// ---------------------------------------------------------------------------

/// `heroHookThreadId(heroId)`: личная нить героя, одна на героя, id стабилен.
pub fn hero_hook_thread_id(hero_id: Option<&Value>) -> String {
    let id = clean(hero_id, 120);
    if text::test(re!(r"^[A-Za-z0-9._:-]{1,90}$", "u"), &id) {
        format!("thread:hero-hook:{id}")
    } else {
        format!("thread:hero-hook:{}", head_utf16(&digest(&id), 20))
    }
}

/// `heroHookIdempotencyKey(heroId)`: ключ коммита плетения.
pub fn hero_hook_idempotency_key(hero_id: Option<&Value>) -> String {
    format!("hero-hooks:{}", clean(hero_id, 120))
}

/// `heroHookFacts(state, heroId)`: зацепки героя (пустой `hero_id` — всех
/// героев) — заготовки ведущего с `hero_id` в JSON `object`.
pub fn hero_hook_facts<'a>(state: &'a Value, hero_id: &str) -> Vec<&'a Value> {
    let expected = clean_str(hero_id, 120);
    array(path(Some(state), &["worldMemory", "facts"]))
        .iter()
        .filter(|fact| {
            if !is_str(get(Some(fact), "predicate"), "gm_secret") {
                return false;
            }
            let owner = sk_social::npc_social::npc_secret_meta(fact).hero_id;
            if expected.is_empty() {
                !owner.is_empty()
            } else {
                owner == expected
            }
        })
        .collect()
}

fn party_heroes(state: &Value) -> Vec<&Value> {
    let party: IndexSet<String> = array(get(Some(state), "partyMemberIds")).iter().map(|id| js::string(Some(id))).collect();
    array(get(Some(state), "players"))
        .iter()
        .filter(|hero| js::truthy(get(Some(hero), "id")) && (party.is_empty() || party.contains(&js::string(get(Some(hero), "id")))))
        .collect()
}

fn find_party_hero<'a>(state: &'a Value, hero_id: &str) -> Option<&'a Value> {
    party_heroes(state).into_iter().find(|hero| js::string(get(Some(hero), "id")) == hero_id)
}

fn hero_story(hero: Option<&Value>) -> String {
    [story_text(get(hero, "backstory"), 2_000), story_text(get(hero, "bonds"), 1_000)].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ")
}

fn location_entities(state: &Value) -> Vec<&Value> {
    array(path(Some(state), &["worldMemory", "entities"]))
        .iter()
        .filter(|entity| is_str(get(Some(entity), "kind"), "location") && js::truthy(get(Some(entity), "id")) && js::truthy(get(Some(entity), "name")))
        .collect()
}

fn scene_location_entity(state: &Value) -> Option<&Value> {
    let scene = lower(path(Some(state), &["scene", "location"]));
    if scene.is_empty() {
        return None;
    }
    location_entities(state).into_iter().find(|entity| lower(get(Some(entity), "name")) == scene)
}

/// `heroNeedsHooks(state, heroId)`: лист собран, предыстория есть, зацепок и
/// личной нити ещё нет, и мир уже знает место, к которому их привязать.
pub fn hero_needs_hooks(state: &Value, hero_id: &str) -> bool {
    let Some(hero) = find_party_hero(state, hero_id) else { return false };
    if js::is_true(get(Some(hero), "characterSetupRequired")) {
        return false;
    }
    let id = js::string(get(Some(hero), "id"));
    if is_str(get(get(path(Some(state), &["mechanics", "death", "heroes"]), &id), "status"), "dead") {
        return false;
    }
    if len16(&hero_story(Some(hero))) < HERO_STORY_MIN {
        return false;
    }
    if scene_location_entity(state).is_none() {
        return false;
    }
    if !hero_hook_facts(state, &id).is_empty() {
        return false;
    }
    let thread_id = hero_hook_thread_id(get(Some(hero), "id"));
    !array(path(Some(state), &["worldMemory", "threads"])).iter().any(|thread| is_str(get(Some(thread), "id"), &thread_id))
}

/// `heroesNeedingHooks(state)`: герои, которым ещё нужны зацепки, — по
/// возрастанию id (`sort()` по строкам).
pub fn heroes_needing_hooks(state: &Value) -> Vec<String> {
    let mut ids: Vec<Value> = party_heroes(state)
        .into_iter()
        .map(|hero| js::string(get(Some(hero), "id")))
        .filter(|hero_id| hero_needs_hooks(state, hero_id))
        .map(Value::String)
        .collect();
    js::default_sort(&mut ids);
    ids.into_iter().map(|id| js::s(Some(&id))).collect()
}

fn social_npcs(social: &Value) -> &[Value] {
    array(get(Some(social), "npcs"))
}

fn unique_strings(items: impl IntoIterator<Item = String>) -> Vec<String> {
    let set: IndexSet<String> = items.into_iter().collect();
    set.into_iter().collect()
}

/// `heroHooksBrief(state, heroIds)`: бриф модели; всё, что пишет игрок,
/// уходит внутри UNTRUSTED_DATA через `buildDataOnlyContext`.
pub fn hero_hooks_brief(state: &Value, hero_ids: &[String]) -> Value {
    let social = sk_social::npc_social::ensure_npc_social_state(get(Some(state), "social").unwrap_or(&Value::Null), state, &Value::Null);
    let scene = scene_location_entity(state);
    let mut places = vec![clean(path(Some(state), &["scene", "location"]), 160)];
    places.extend(location_entities(state).into_iter().filter(|entity| !is_str(get(Some(entity), "visibility"), "gm_only")).map(|entity| clean(get(Some(entity), "name"), 160)));
    let places: Vec<String> = unique_strings(places.into_iter().filter(|place| !place.is_empty())).into_iter().take(16).collect();
    let npcs: Vec<Value> = social_npcs(&social)
        .iter()
        .filter(|npc| !is_str(get(Some(npc), "visibility"), "gm_only") && !js::is_false(get(Some(npc), "available")) && !clean(get(Some(npc), "name"), 120).is_empty())
        .take(16)
        .map(|npc| {
            let npc = Some(npc);
            json!({
                "name": clean(get(npc, "name"), 120), "role": clean(get(npc, "role"), 120), "location": clean(get(npc, "location"), 160),
                "summary": clean(get(npc, "public_summary"), 240),
            })
        })
        .collect();
    let topics: Vec<String> = unique_strings(
        array(path(Some(state), &["worldMemory", "facts"]))
            .iter()
            .filter(|fact| is_str(get(Some(fact), "predicate"), "gm_secret") && !is_str(get(Some(fact), "status"), "superseded"))
            .map(|fact| clean_str(&sk_social::npc_social::npc_secret_meta(fact).topic, 120))
            .filter(|topic| !topic.is_empty()),
    )
    .into_iter()
    .take(12)
    .collect();
    let role = Value::from("hero_hooks");
    let contract = Value::from(HERO_HOOKS_PROMPT_VERSION);
    let metadata = sk_encounters::agent_context::agent_context_metadata(
        state,
        &sk_encounters::agent_context::AgentContextOptions { role: Some(&role), actor_id: Some(&Value::Null), target_id: None, contract_version: Some(&contract) },
    );
    let heroes: Vec<Value> = hero_ids
        .iter()
        .map(|hero_id| {
            let hero = find_party_hero(state, hero_id);
            let card = sk_encounters::agent_context::hero_card_for_agent(state, Some(&Value::String(hero_id.clone()))).unwrap_or_else(|| json!({}));
            let card = Some(&card);
            let mut entry = Map::new();
            entry.insert("hero_id".into(), Value::String(hero_id.clone()));
            entry.insert("name".into(), coalesce(get(card, "name"), None).cloned().unwrap_or_else(|| Value::from("")));
            for key in ["class", "species", "background"] {
                if js::truthy(get(card, key)) {
                    entry.insert(key.into(), get(card, key).cloned().unwrap_or(Value::Null));
                }
            }
            entry.insert("backstory".into(), Value::String(story_text(get(hero, "backstory"), 900)));
            entry.insert("bonds".into(), Value::String(story_text(get(hero, "bonds"), 300)));
            entry.insert("ideals".into(), Value::String(story_text(get(hero, "ideals"), 200)));
            Value::Object(entry)
        })
        .collect();
    json!({
        "context_metadata": metadata,
        "campaign_premise": sk_encounters::agent_context::campaign_concept_for_agent(state, None),
        "scene": {
            "title": clean(path(Some(state), &["scene", "title"]), 160),
            "location": clean(coalesce(get(scene, "name"), path(Some(state), &["scene", "location"])), 160),
            "objective": clean(path(Some(state), &["scene", "objective"]), 240),
            "mood": clean(path(Some(state), &["scene", "mood"]), 160),
        },
        "places": places,
        "npcs": npcs,
        "mystery_topics": topics,
        "heroes": heroes,
    })
}

fn safe_motive(value: Option<&Value>, hooks: &[Value], hero: Option<&Value>) -> String {
    let motive = strip_end_marks(&clean(value, MOTIVE_MAX + 40));
    let own = stems(&format!("{} {} {}", hero_story(hero), js::s(get(hero, "character")), js::s(get(hero, "name"))));
    let hidden: IndexSet<String> = hooks.iter().flat_map(|hook| stems(&js::s(get(Some(hook), "clue")))).filter(|stem| !own.contains(stem)).collect();
    let leaks = stems(&motive).iter().any(|stem| hidden.contains(stem));
    let length = len16(&motive);
    if (MOTIVE_MIN..=MOTIVE_MAX).contains(&length) && !mechanics(&motive) && !leaks {
        return motive;
    }
    let sentence = |text: String| strip_end_marks(&clean_str(&first_split(&text), 400));
    let from_story = [sentence(story_text(get(hero, "bonds"), 1_000)), sentence(story_text(get(hero, "backstory"), 2_000))]
        .into_iter()
        .find(|candidate| (MOTIVE_MIN..=MOTIVE_MAX).contains(&len16(candidate)) && !mechanics(candidate));
    match from_story {
        Some(found) if !found.is_empty() => found,
        _ => {
            let name = clean(or(get(hero, "character"), get(hero, "name")), 60);
            format!("Личная история: {}", if name.is_empty() { "герой".to_string() } else { name })
        }
    }
}

/// Предложение модели для одного героя: цель и проверенные зацепки
/// (`{ clue, topic, skills, holder, holder_id }`).
#[derive(Clone, Debug, PartialEq)]
pub struct HeroHookProposal {
    pub motive: String,
    pub hooks: Vec<Value>,
}

impl HeroHookProposal {
    pub fn to_json(&self) -> Value {
        json!({ "motive": self.motive, "hooks": self.hooks })
    }

    /// Из JSON `{ motive, hooks }` (как его передаёт JS-вызывающий).
    pub fn from_json(value: &Value) -> Self {
        HeroHookProposal { motive: js::s(get(Some(value), "motive")), hooks: array(get(Some(value), "hooks")).to_vec() }
    }
}

/// `normalizeHeroHookProposals(raw, state, heroIds)`: проверка ответа модели.
/// Зацепка принимается, если в ней одно предложение правды разумной длины,
/// тема и ни одной цифры или механики; хранитель — только существующий
/// видимый NPC. Повтор уже существующей тайны отбрасывается.
pub fn normalize_hero_hook_proposals(raw: &Value, state: &Value, hero_ids: &[String]) -> IndexMap<String, HeroHookProposal> {
    let wanted: IndexSet<&str> = hero_ids.iter().map(String::as_str).collect();
    let social = sk_social::npc_social::ensure_npc_social_state(get(Some(state), "social").unwrap_or(&Value::Null), state, &Value::Null);
    let mut npc_by_name: IndexMap<String, &Value> = IndexMap::new();
    for npc in social_npcs(&social).iter().filter(|npc| !is_str(get(Some(npc), "visibility"), "gm_only") && !clean(get(Some(npc), "name"), 120).is_empty()) {
        npc_by_name.insert(lower(get(Some(npc), "name")), npc);
    }
    let existing: IndexSet<String> =
        array(path(Some(state), &["worldMemory", "facts"])).iter().filter(|fact| is_str(get(Some(fact), "predicate"), "gm_secret")).map(|fact| lower(get(Some(fact), "summary"))).collect();
    let mut proposals: IndexMap<String, HeroHookProposal> = IndexMap::new();
    for entry in array(get(Some(raw), "heroes")) {
        let hero_id = clean(get(Some(entry), "hero_id"), 120);
        if !wanted.contains(hero_id.as_str()) || proposals.contains_key(&hero_id) {
            continue;
        }
        let hero = find_party_hero(state, &hero_id);
        let mut hooks: Vec<Value> = Vec::new();
        for candidate in array(get(Some(entry), "hooks")).iter().take(4) {
            let raw_clue = clean(get(Some(candidate), "clue"), 1_000);
            let clue_length = len16(&raw_clue);
            if !(CLUE_MIN..=CLUE_MAX).contains(&clue_length) {
                continue;
            }
            let secrets = sk_memory::world_memory::normalize_gm_secrets(Some(&Value::Array(vec![candidate.clone()])), 1);
            let Some(secret) = secrets.into_iter().next() else { continue };
            let topic = js::s(secret.get("topic"));
            if topic.is_empty() || len16(&topic) > TOPIC_MAX {
                continue;
            }
            let clue = js::s(secret.get("clue"));
            if mechanics(&clue) || mechanics(&topic) {
                continue;
            }
            let clue_key = lower_str(&clue);
            if existing.contains(&clue_key) || hooks.iter().any(|hook| lower(hook.get("clue")) == clue_key) {
                continue;
            }
            let holder_name = js::s(secret.get("holder"));
            let holder = if holder_name.is_empty() { None } else { npc_by_name.get(&lower_str(&holder_name)).copied() };
            let mut hook = secret.as_object().cloned().unwrap_or_default();
            hook.insert("holder".into(), Value::String(holder.map(|npc| clean(get(Some(npc), "name"), 120)).unwrap_or_default()));
            hook.insert("holder_id".into(), Value::String(holder.map(|npc| js::string(get(Some(npc), "id"))).unwrap_or_default()));
            hooks.push(Value::Object(hook));
            if hooks.len() >= HERO_HOOK_LIMIT {
                break;
            }
        }
        if hooks.is_empty() {
            continue;
        }
        let motive = safe_motive(get(Some(entry), "motive"), &hooks, hero);
        proposals.insert(hero_id, HeroHookProposal { motive, hooks });
    }
    proposals
}

/// `heroHookCommands(state, heroId, proposal)`: команды плетения одного
/// героя — скрытые факты зацепок, хранителю — id его факта в
/// `known_fact_ids`, отряду — личная нить. Всё в одном коммите.
pub fn hero_hook_commands(state: &Value, hero_id: &str, proposal: &HeroHookProposal) -> Vec<Value> {
    let social = sk_social::npc_social::ensure_npc_social_state(get(Some(state), "social").unwrap_or(&Value::Null), state, &Value::Null);
    let scene = scene_location_entity(state);
    let locations = location_entities(state);
    let hero = find_party_hero(state, hero_id);
    let clean_hero = clean_str(hero_id, 120);
    let mut facts: Vec<Value> = Vec::new();
    let mut holder_facts: IndexMap<String, Vec<String>> = IndexMap::new();
    for (index, hook) in proposal.hooks.iter().take(HERO_HOOK_LIMIT).enumerate() {
        let hook = Some(hook);
        let holder_id = get(hook, "holder_id");
        let holder = if js::truthy(holder_id) { social_npcs(&social).iter().find(|npc| strict_eq(get(Some(npc), "id"), holder_id)) } else { None };
        let holder_place = holder.and_then(|holder| {
            let holder = Some(holder);
            locations.iter().copied().find(|entity| {
                (js::truthy(get(holder, "location_id")) && is_str(get(holder, "location_id"), &js::string(get(Some(entity), "id"))))
                    || lower(get(Some(entity), "name")) == lower(get(holder, "location"))
            })
        });
        let Some(subject) = holder_place.or(scene) else { continue };
        let secret = json!({
            "clue": get(hook, "clue").cloned().unwrap_or(Value::Null),
            "topic": get(hook, "topic").cloned().unwrap_or(Value::Null),
            "skills": get(hook, "skills").cloned().unwrap_or(Value::Null),
            "holder": get(hook, "holder").cloned().unwrap_or(Value::Null),
        });
        let base = sk_memory::world_memory::gm_secret_fact(
            &secret,
            &json!({ "subjectId": js::string(get(Some(subject), "id")), "salt": format!("hero-hook:{clean_hero}"), "index": index }),
        );
        let mut fact = Map::new();
        for field in FACT_COMMAND_FIELDS {
            if let Some(value) = base.get(field) {
                fact.insert(field.into(), value.clone());
            }
        }
        let mut object = match serde_json::from_str::<Value>(&js::s(base.get("object"))) {
            Ok(Value::Object(map)) => map,
            _ => Map::new(),
        };
        object.insert("hero_id".into(), Value::String(clean_hero.clone()));
        fact.insert("object".into(), Value::String(js::stringify(&Value::Object(object))));
        let fact_id = js::s(fact.get("id"));
        facts.push(Value::Object(fact));
        if let Some(holder) = holder {
            holder_facts.entry(js::s(get(Some(holder), "id"))).or_default().push(fact_id);
        }
    }
    if facts.is_empty() {
        return Vec::new();
    }
    let first_subject = facts.first().and_then(|fact| fact.get("subject_id")).cloned();
    let mut commands: Vec<Value> = facts.into_iter().map(|fact| json!({ "command_type": "RecordWorldFact", "fact": fact })).collect();
    for (npc_id, fact_ids) in holder_facts {
        if !array(path(Some(state), &["social", "npcs"])).iter().any(|npc| js::string(get(Some(npc), "id")) == npc_id) {
            continue;
        }
        let Some(stored) = social_npcs(&social).iter().find(|npc| is_str(get(Some(npc), "id"), &npc_id)) else { continue };
        let mut known: Vec<Value> = Vec::new();
        for value in array(get(Some(stored), "known_fact_ids")).iter().cloned().chain(fact_ids.into_iter().map(Value::String)) {
            if !known.contains(&value) {
                known.push(value);
            }
        }
        let mut npc = Map::new();
        for field in PROFILE_FIELDS {
            if let Some(value) = get(Some(stored), field) {
                npc.insert(field.into(), value.clone());
            }
        }
        npc.insert("known_fact_ids".into(), Value::Array(known));
        let command = json!({ "command_type": "UpsertNpcSocialProfile", "npc": Value::Object(npc) });
        if sk_social::npc_social::validate_npc_social_command(&command, state, &json!({ "isDirector": true })).is_err() {
            // Профиль не проходит строгую проверку: хранитель всё равно знает
            // зацепку — он назван в самой заготовке.
            continue;
        }
        commands.push(command);
    }
    let name = {
        let name = clean(or(get(hero, "character"), get(hero, "name")), 120);
        if name.is_empty() {
            "героя".to_string()
        } else {
            name
        }
    };
    let title = clean_str(&proposal.motive, 180);
    let entity = match coalesce(get(scene, "id"), None) {
        Some(id) => js::string(Some(id)),
        None => js::string(first_subject.as_ref()),
    };
    commands.push(json!({
        "command_type": "UpsertNarrativeThread",
        "thread": {
            "id": hero_hook_thread_id(Some(&Value::String(hero_id.to_string()))),
            "title": if title.is_empty() { format!("Личная история: {name}") } else { title },
            "summary": format!("Личная нить из предыстории: {name}."),
            "status": "active",
            "visibility": "party",
            "entity_ids": [entity],
            "clock": { "current": 0, "max": 4, "label": "Личная история героя" },
        },
    }));
    commands
}

/// `a === b` для примитивов JSON.
fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (None, None) | (Some(Value::Null), Some(Value::Null)) => true,
        _ => false,
    }
}

/// Мотив героя для Режиссёра (элемент [`party_motives_for_director`]).
#[derive(Clone, Debug, PartialEq)]
pub struct PartyMotive {
    pub hero_id: String,
    pub hero: String,
    pub motive: String,
    pub unrevealed_hook_leads: usize,
}

impl PartyMotive {
    pub fn to_json(&self) -> Value {
        json!({ "hero_id": self.hero_id, "hero": self.hero, "motive": self.motive, "unrevealed_hook_leads": self.unrevealed_hook_leads })
    }
}

/// `partyMotivesForDirector(state)`: на героя — короткая цель (заголовок
/// личной нити, иначе первая фраза привязанностей) и сколько его зацепок ещё
/// не раскрыто. Текстов зацепок здесь нет.
pub fn party_motives_for_director(state: &Value) -> Vec<PartyMotive> {
    let revealed: IndexSet<String> = array(path(Some(state), &["worldMemory", "knowledge_ledger"]))
        .iter()
        .chain(array(path(Some(state), &["worldMemory", "knowledge_revealed"])))
        .map(|entry| js::s(get(Some(entry), "fact_id")))
        .collect();
    let mut threads: HashMap<String, &Value> = HashMap::new();
    for thread in array(path(Some(state), &["worldMemory", "threads"])) {
        threads.insert(js::s(get(Some(thread), "id")), thread);
    }
    let first_sentence = |text: String| clean_str(&first_split(&text), 160);
    party_heroes(state)
        .into_iter()
        .map(|hero| {
            let hero_id = js::string(get(Some(hero), "id"));
            let thread = threads.get(&hero_hook_thread_id(Some(&Value::String(hero_id.clone())))).copied();
            let motive = if is_str(get(thread, "status"), "active") {
                clean(get(thread, "title"), 160)
            } else {
                let bonds = first_sentence(story_text(get(Some(hero), "bonds"), 1_000));
                if bonds.is_empty() {
                    first_sentence(story_text(get(Some(hero), "backstory"), 2_000))
                } else {
                    bonds
                }
            };
            let unrevealed = hero_hook_facts(state, &hero_id)
                .into_iter()
                .filter(|fact| !is_str(get(Some(fact), "status"), "superseded") && !revealed.contains(&js::string(get(Some(fact), "id"))))
                .count();
            PartyMotive { hero_id, hero: clean(or(get(Some(hero), "character"), get(Some(hero), "name")), 120), motive, unrevealed_hook_leads: unrevealed }
        })
        .filter(|entry| !entry.motive.is_empty() || entry.unrevealed_hook_leads > 0)
        .collect()
}

/// Часы плетения (`now`), миллисекунды.
pub type WeaverClock = Arc<dyn Fn() -> f64 + Send + Sync>;

/// `new HeroHookWeaver({ llmClient, maxAttemptsPerHero, retryMs, now })`.
#[derive(Clone, Default)]
pub struct HeroHookWeaverConfig {
    pub llm_client: Option<RoleClient>,
    /// `maxAttemptsPerHero` (`Math.max(1, Number(x) || 2)`).
    pub max_attempts_per_hero: Option<Value>,
    /// `retryMs` (`Math.max(0, Number(x) || 0)`; по умолчанию минута).
    pub retry_ms: Option<Value>,
    pub now: Option<WeaverClock>,
}

/// `HeroHookWeaver`: одна модель на всех ждущих героев; счёт попыток живёт в
/// процессе.
pub struct HeroHookWeaver {
    llm_client: Option<RoleClient>,
    max_attempts: f64,
    retry_ms: f64,
    now: WeaverClock,
    attempts: Mutex<HashMap<String, (f64, f64)>>,
}

/// `Number(x) || fallback`.
fn number_or(value: Option<&Value>, fallback: f64) -> f64 {
    let number = js::number(value);
    if number == 0.0 || number.is_nan() {
        fallback
    } else {
        number
    }
}

impl HeroHookWeaver {
    pub fn new(config: HeroHookWeaverConfig) -> Self {
        let default_attempts = Value::from(HERO_HOOK_MAX_ATTEMPTS);
        let default_retry = Value::from(HERO_HOOK_RETRY_MS);
        HeroHookWeaver {
            llm_client: config.llm_client,
            max_attempts: number_or(Some(config.max_attempts_per_hero.as_ref().unwrap_or(&default_attempts)), HERO_HOOK_MAX_ATTEMPTS).max(1.0),
            retry_ms: number_or(Some(config.retry_ms.as_ref().unwrap_or(&default_retry)), 0.0).max(0.0),
            now: config.now.unwrap_or_else(|| Arc::new(|| sk_core::clock::now_ms() as f64)),
            attempts: Mutex::new(HashMap::new()),
        }
    }

    fn attempts(&self) -> std::sync::MutexGuard<'_, HashMap<String, (f64, f64)>> {
        self.attempts.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn key(campaign_id: &str, hero_id: &str) -> String {
        format!("{campaign_id}\u{0}{hero_id}")
    }

    /// `pendingHeroIds(state, campaignId)`: модель есть, зацепок нет, попытки
    /// не исчерпаны и пауза после неудачи прошла.
    pub fn pending_hero_ids(&self, state: &Value, campaign_id: &str) -> Vec<String> {
        if self.llm_client.is_none() {
            return Vec::new();
        }
        let now = (self.now)();
        let attempts = self.attempts();
        heroes_needing_hooks(state)
            .into_iter()
            .filter(|hero_id| match attempts.get(&Self::key(campaign_id, hero_id)) {
                None => true,
                Some((count, at)) => *count < self.max_attempts && now - at >= self.retry_ms,
            })
            .collect()
    }

    /// `attemptsLeft(campaignId, heroId)`.
    pub fn attempts_left(&self, campaign_id: &str, hero_id: &str) -> bool {
        self.attempts().get(&Self::key(campaign_id, hero_id)).map_or(0.0, |(count, _)| *count) < self.max_attempts
    }

    /// `weave({ state, campaignId, heroIds })`: план коммита на героя —
    /// `{ hero_ids, plans: [{ hero_id, idempotency_key, commands }], provider,
    /// prompt_version, error? }`. Коммитит вызывающий. `hero_ids` `None` — ждущие
    /// герои ([`Self::pending_hero_ids`]).
    pub async fn weave(&self, state: &Value, campaign_id: &str, hero_ids: Option<&[Value]>) -> Value {
        let candidates: Vec<String> = match hero_ids {
            Some(ids) => ids.iter().map(|id| js::string(Some(id))).collect(),
            None => self.pending_hero_ids(state, campaign_id),
        };
        let targets: Vec<String> = candidates.into_iter().filter(|hero_id| hero_needs_hooks(state, hero_id)).collect();
        let Some(client) = self.llm_client.as_ref().filter(|_| !targets.is_empty()) else {
            return json!({ "hero_ids": [], "plans": [], "provider": "none", "prompt_version": HERO_HOOKS_PROMPT_VERSION });
        };
        let now = (self.now)();
        {
            let mut attempts = self.attempts();
            for hero_id in &targets {
                let key = Self::key(campaign_id, hero_id);
                let count = attempts.get(&key).map_or(0.0, |(count, _)| *count) + 1.0;
                attempts.insert(key, (count, now));
            }
        }
        let input = json!({
            "messages": [
                { "role": "system", "content": PROMPT },
                { "role": "user", "content": sk_tactics::security::build_data_only_context(Some(&json!({ "hero_hooks_brief": hero_hooks_brief(state, &targets) }))) },
            ],
            "temperature": 0.8,
            "maxTokens": 900,
            // Творческая роль ведущего: тот же профиль рассуждений, что у Режиссёра.
            "role": "director",
            "jsonSchema": &*sk_story::llm_json_schemas::HERO_HOOKS_JSON_SCHEMA,
        });
        let raw = match client.client().complete_json(&input, &json!({ "timeoutMs": 30_000 })).await {
            Ok(raw) => raw,
            Err(error) => {
                return json!({
                    "hero_ids": targets, "plans": [], "provider": "error", "prompt_version": HERO_HOOKS_PROMPT_VERSION,
                    "error": clean_str(&error.code.clone().unwrap_or_else(|| error.name.clone()), 80),
                });
            }
        };
        let proposals = normalize_hero_hook_proposals(&raw, state, &targets);
        let plans: Vec<Value> = targets
            .iter()
            .filter_map(|hero_id| {
                let commands = proposals.get(hero_id).map(|proposal| hero_hook_commands(state, hero_id, proposal)).unwrap_or_default();
                (!commands.is_empty()).then(|| {
                    json!({ "hero_id": hero_id, "idempotency_key": hero_hook_idempotency_key(Some(&Value::String(hero_id.clone()))), "commands": commands })
                })
            })
            .collect();
        let mut result = json!({ "hero_ids": targets, "plans": plans, "provider": client.class_name(), "prompt_version": HERO_HOOKS_PROMPT_VERSION });
        if plans_empty(&result) {
            result["error"] = Value::from("HERO_HOOKS_INVALID_RESPONSE");
        }
        result
    }
}

fn plans_empty(result: &Value) -> bool {
    array(result.get("plans")).is_empty()
}

/// Системный промпт роли (`prompts/hero_hooks/v1.txt`).
pub fn hero_hooks_prompt() -> &'static str {
    PROMPT
}

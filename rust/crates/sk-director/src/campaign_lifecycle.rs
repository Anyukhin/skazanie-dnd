//! Перенос `server/campaign-lifecycle.mjs` — жизненный цикл кампании:
//! состояния `setup → active ⇄ paused → completed/failed → archived`, события
//! переходов, цепочка арок, готовность к автоматическому финалу и смене арки,
//! перенос в следующую арку и эпилог — детерминированный текст и бриф для
//! рассказчика. Эпилог собирается из одного набора подтверждённых и видимых
//! отряду фактов (`collectEpilogueFacts`) со стабильными ключами.

use std::collections::HashMap;

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexMap;
use sk_core::{clock, js, text as jstext};
use sk_memory::world_memory::CLOSED_QUEST_STATUSES;
use sk_scenario::campaign_scenario::{campaign_scenario, scenario_ending};
use sk_society::campaign_stories::campaign_mode_for;
use sk_society::reputation_policy::reputation_tier;
use sk_story::campaign_loop_policy::{campaign_arc_climax_satisfied, campaign_arc_plan, main_quest_for, MAX_CAMPAIGN_ARCS};

use crate::adventure_director::{head16, nullish, or, prop, DirectorError, DirectorResult};

const STATUSES: [&str; 6] = ["setup", "active", "paused", "completed", "failed", "archived"];
const TERMINAL: [&str; 3] = ["completed", "failed", "archived"];
const VISIBLE_TO_PARTY: [&str; 2] = ["public", "party"];
/// Брошенный квест закрыт так же, как завершённый.
const RESOLVED_QUEST_STATUSES: [&str; 3] = CLOSED_QUEST_STATUSES;
const RESOLVED_PROMISE_STATUSES: [&str; 2] = ["fulfilled", "broken"];

/// `clean(value, maximum)`: NFKC, пробелы схлопнуты, края обрезаны, срез по UTF-16.
pub(crate) fn clean(value: Option<&Value>, maximum: usize) -> String {
    head16(&jstext::squash_spaces(&jstext::nfkc(&js::s(value))), maximum)
}

fn clean_str(value: &str, maximum: usize) -> String {
    clean(Some(&Value::String(value.to_string())), maximum)
}

/// `visibleToParty(entry, fallback)`: видимость записи или запасная
/// (`'party'` по умолчанию: запись без поля видимости отряду видна).
fn visible_to_party(entry: &Value, fallback: &Value) -> bool {
    let visibility = or(prop(Some(entry), "visibility"), Some(fallback));
    VISIBLE_TO_PARTY.contains(&clean(visibility, 30).as_str())
}

fn party() -> Value {
    Value::String("party".into())
}

fn array<'a>(value: Option<&'a Value>) -> &'a [Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

fn get<'a>(value: Option<&'a Value>, path: &[&str]) -> Option<&'a Value> {
    path.iter().fold(value, |value, key| prop(value, key))
}

/// `withoutTerminalPunctuation(value, maximum)`.
fn without_terminal_punctuation(value: &str, maximum: usize) -> String {
    let cleaned = clean_str(value, maximum);
    cleaned.trim_end_matches(['.', '!', '?', '…']).to_string()
}

fn tail<T>(items: Vec<T>, limit: usize) -> Vec<T> {
    crate::adventure_director::tail(items, limit)
}

/// Жизненный цикл из состояния (`normalizeCampaignLifecycle(state.mechanics.campaign_lifecycle, …death.campaign_status)`).
fn lifecycle_of(state: &Value) -> Value {
    let mechanics = prop(Some(state), "mechanics");
    normalize_campaign_lifecycle(prop(mechanics, "campaign_lifecycle"), get(mechanics, &["death", "campaign_status"]))
}

fn status_of(lifecycle: &Value) -> &str {
    lifecycle["status"].as_str().unwrap_or("active")
}

/// `requestedEpilogueOutcome(state, input)`.
fn requested_epilogue_outcome(state: &Value, input: Option<&Value>) -> &'static str {
    let requested = match input {
        Some(Value::String(_)) => input,
        _ => prop(input, "outcome"),
    };
    let requested = jstext::lower(&clean(requested, 30));
    if ["failed", "failure", "defeat"].contains(&requested.as_str()) {
        return "failed";
    }
    if ["completed", "complete", "success", "victory"].contains(&requested.as_str()) {
        return "completed";
    }
    let lifecycle = lifecycle_of(state);
    let defeated = get(Some(state), &["mechanics", "death", "campaign_status"]).and_then(Value::as_str) == Some("party_defeated");
    if status_of(&lifecycle) == "failed" || defeated {
        "failed"
    } else {
        "completed"
    }
}

/// `locationKey(id, name)`.
fn location_key(id: Option<&Value>, name: &str) -> String {
    let stable_id = clean(id, 120);
    if !stable_id.is_empty() {
        return format!("location:{stable_id}");
    }
    let normalized = jstext::lower(&clean_str(name, 180));
    if normalized.is_empty() {
        String::new()
    } else {
        format!("location-name:{normalized}")
    }
}

/// `collectEpilogueFacts(state, outcomeOrOptions)`: единственный видимый отряду
/// набор подтверждённых данных для обеих форм эпилога.
pub fn collect_epilogue_facts(state: &Value, outcome_or_options: Option<&Value>) -> Value {
    let outcome = requested_epilogue_outcome(state, outcome_or_options);
    let state_ref = Some(state);
    let world_memory = match prop(state_ref, "worldMemory") {
        Some(memory @ (Value::Object(_) | Value::Array(_))) => Some(memory),
        _ => None,
    };
    let gm_only = Value::String("gm_only".into());
    let visible_entities: Vec<&Value> = array(prop(world_memory, "entities")).iter().filter(|entity| visible_to_party(entity, &gm_only)).collect();
    let mut entities_by_id: HashMap<String, &Value> = HashMap::new();
    for entity in &visible_entities {
        entities_by_id.insert(clean(prop(Some(entity), "id"), 120), entity);
    }

    let dead_heroes = get(state_ref, &["mechanics", "death", "heroes"]);
    let heroes: Vec<Value> = array(prop(state_ref, "players"))
        .iter()
        .take(12)
        .filter_map(|hero| {
            let hero = Some(hero);
            let id = clean(prop(hero, "id"), 120);
            let dead = prop(prop(dead_heroes, &id), "status").and_then(Value::as_str) == Some("dead");
            let name_source = or(or(prop(hero, "character"), prop(hero, "name")), Some(&Value::String(id.clone()))).cloned();
            let name = clean(name_source.as_ref(), 120);
            (!id.is_empty() && !name.is_empty()).then(|| json!({ "key": format!("hero:{id}"), "hero_id": id, "name": name, "status": if dead { "dead" } else { "living" } }))
        })
        .collect();

    let quests: Vec<Value> = tail(
        array(prop(world_memory, "quests"))
            .iter()
            .filter(|quest| visible_to_party(quest, &party()) && RESOLVED_QUEST_STATUSES.contains(&clean(prop(Some(quest), "status"), 30).as_str()))
            .collect(),
        6,
    )
    .into_iter()
    .map(|quest| {
        let quest = Some(quest);
        let id = clean(prop(quest, "id"), 120);
        json!({
            "key": format!("quest:{id}"), "quest_id": id, "title": clean(prop(quest, "title"), 180),
            "status": clean(prop(quest, "status"), 30), "summary": clean(prop(quest, "summary"), 240),
        })
    })
    .filter(|quest| quest["quest_id"] != "" && quest["title"] != "")
    .collect();

    let social = prop(state_ref, "social");
    let mut visible_npcs: HashMap<String, &Value> = HashMap::new();
    for npc in array(prop(social, "npcs")) {
        if visible_to_party(npc, &party()) {
            visible_npcs.insert(clean(prop(Some(npc), "id"), 120), npc);
        }
    }
    let promises: Vec<Value> = tail(
        array(prop(social, "promises"))
            .iter()
            .filter(|promise| {
                visible_to_party(promise, &party())
                    && RESOLVED_PROMISE_STATUSES.contains(&clean(prop(Some(promise), "status"), 30).as_str())
                    && visible_npcs.contains_key(&clean(prop(Some(promise), "npc_id"), 120))
            })
            .collect(),
        6,
    )
    .into_iter()
    .map(|promise| {
        let promise = Some(promise);
        let npc_id = clean(prop(promise, "npc_id"), 120);
        let npc = visible_npcs.get(&npc_id).copied();
        let npc_name = or(prop(npc, "name"), Some(&Value::String(npc_id.clone()))).cloned();
        let id = clean(prop(promise, "id"), 120);
        json!({
            "key": format!("promise:{id}"), "promise_id": id, "npc_id": npc_id, "npc_name": clean(npc_name.as_ref(), 120),
            "direction": clean(prop(promise, "direction"), 40), "status": clean(prop(promise, "status"), 30), "text": clean(prop(promise, "text"), 220),
        })
    })
    .filter(|promise| promise["promise_id"] != "" && promise["text"] != "")
    .collect();

    let visible_facts: Vec<Value> = tail(
        array(prop(world_memory, "facts"))
            .iter()
            .filter(|fact| visible_to_party(fact, &gm_only) && clean(prop(Some(fact), "status"), 30) == "active")
            .collect(),
        8,
    )
    .into_iter()
    .map(|fact| {
        let fact = Some(fact);
        let subject_id = clean(prop(fact, "subject_id"), 120);
        let subject = entities_by_id.get(&subject_id).copied();
        let id = clean(prop(fact, "id"), 120);
        json!({
            "key": format!("world_fact:{id}"), "fact_id": id, "subject_id": subject_id,
            "subject_kind": clean(prop(subject, "kind"), 30), "subject_name": clean(prop(subject, "name"), 160),
            "predicate": clean(prop(fact, "predicate"), 120), "summary": clean(or(prop(fact, "summary"), prop(fact, "object")), 240),
        })
    })
    .filter(|fact| fact["fact_id"] != "" && fact["summary"] != "")
    .collect();
    let npc_fates: Vec<Value> = visible_facts.iter().filter(|fact| fact["subject_kind"] == "npc").cloned().collect();
    let world_facts: Vec<Value> = visible_facts.iter().filter(|fact| fact["subject_kind"] != "npc").cloned().collect();

    let mut visible_factions: HashMap<String, &Value> = HashMap::new();
    for entity in visible_entities.iter().filter(|entity| clean(prop(Some(entity), "kind"), 30) == "faction") {
        visible_factions.insert(clean(prop(Some(entity), "id"), 120), entity);
    }
    let mut scored: Vec<(String, i64)> = match get(state_ref, &["autonomy", "reputations"]) {
        Some(Value::Object(reputations)) => js::entries(reputations)
            .into_iter()
            .map(|(faction, raw)| {
                let score = if js::is_safe_integer_number(Some(raw)) { js::number(Some(raw)) as i64 } else { 0 };
                (clean_str(faction, 120), score.clamp(-100, 100))
            })
            .filter(|(faction, score)| *score != 0 && visible_factions.contains_key(faction))
            .collect(),
        _ => Vec::new(),
    };
    scored.sort_by(|left, right| right.1.abs().cmp(&left.1.abs()).then_with(|| jstext::locale_compare(&left.0, &right.0)));
    let faction_reputations: Vec<Value> = scored
        .into_iter()
        .take(6)
        .map(|(faction, score)| {
            let entity = visible_factions.get(&faction).copied();
            let name = or(prop(entity, "name"), Some(&Value::String(faction.clone()))).cloned();
            json!({ "key": format!("reputation:{faction}"), "faction_id": faction, "faction_name": clean(name.as_ref(), 160), "tier": reputation_tier(&Value::from(score)) })
        })
        .collect();

    let mut visited: IndexMap<String, Value> = IndexMap::new();
    let mut add_visited = |id: Option<&Value>, name: Option<&Value>| {
        let location_name = clean(name, 180);
        let key = location_key(id, &location_name);
        if key.is_empty() || location_name.is_empty() || visited.contains_key(&key) {
            return;
        }
        visited.insert(key.clone(), json!({ "key": key, "location_id": clean(id, 120), "name": location_name }));
    };
    let mut visible_visited_by_name: IndexMap<String, &Value> = IndexMap::new();
    for entity in &visible_entities {
        let tags = array(prop(Some(entity), "tags"));
        if clean(prop(Some(entity), "kind"), 30) != "location" || !tags.iter().any(|tag| tag == "visited") {
            continue;
        }
        visible_visited_by_name.insert(jstext::lower(&clean(prop(Some(entity), "name"), 180)), entity);
    }
    let mut world_visited_by_name: IndexMap<String, &Value> = IndexMap::new();
    for location in array(get(state_ref, &["worldMap", "locations"])) {
        if !js::is_true(prop(Some(location), "visited")) {
            continue;
        }
        world_visited_by_name.insert(jstext::lower(&clean(prop(Some(location), "name"), 180)), location);
    }
    let adventure = prop(state_ref, "adventure");
    let visited_ids = array(prop(adventure, "visitedLocationIds"));
    for (index, name) in array(prop(adventure, "visitedLocations")).iter().enumerate() {
        let normalized = jstext::lower(&clean(Some(name), 180));
        let known = world_visited_by_name.get(&normalized).or_else(|| visible_visited_by_name.get(&normalized)).copied();
        add_visited(or(visited_ids.get(index), prop(known, "id")), Some(name));
    }
    for location in world_visited_by_name.values() {
        add_visited(prop(Some(location), "id"), prop(Some(location), "name"));
    }
    for location in visible_visited_by_name.values() {
        add_visited(prop(Some(location), "id"), prop(Some(location), "name"));
    }
    let visited_locations: Vec<Value> = tail(visited.into_values().collect(), 8);

    let fact_keys: Vec<Value> = heroes
        .iter()
        .chain(&quests)
        .chain(&promises)
        .chain(&visible_facts)
        .chain(&faction_reputations)
        .chain(&visited_locations)
        .map(|entry| entry["key"].clone())
        .collect();
    let scene = prop(state_ref, "scene");
    json!({
        "outcome": outcome,
        "campaign": clean(or(prop(state_ref, "campaign"), Some(&Value::String("Кампания".into()))), 180),
        "final_objective": clean(prop(scene, "objective"), 300),
        "final_location": clean(prop(scene, "location"), 180),
        "heroes": heroes,
        "quests": quests,
        "promises": promises,
        "npc_fates": npc_fates,
        "world_facts": world_facts,
        "faction_reputations": faction_reputations,
        "visited_locations": visited_locations,
        "fact_keys": fact_keys,
    })
}

/// `String(value).slice(0, maximum)` для не-`null` значения.
fn string_head(value: &Value, maximum: usize) -> Value {
    Value::String(head16(&js::s(Some(value)), maximum))
}

/// `normalizeCampaignLifecycle(input, deathStatus)`: `death_status` `None` —
/// аргумент не передан (`'active'`).
pub fn normalize_campaign_lifecycle(input: Option<&Value>, death_status: Option<&Value>) -> Value {
    let raw = match input {
        Some(raw @ (Value::Object(_) | Value::Array(_))) => Some(raw),
        _ => None,
    };
    let field = |key: &str| prop(raw, key);
    let legacy_failed = death_status.and_then(Value::as_str) == Some("party_defeated");
    let status = match field("status") {
        Some(Value::String(status)) if STATUSES.contains(&status.as_str()) => status.clone(),
        _ if legacy_failed => "failed".into(),
        _ => "active".into(),
    };
    let present = |key: &str| nullish(field(key), None);
    let mut lifecycle = Map::new();
    lifecycle.insert("schema_version".into(), Value::from(1));
    lifecycle.insert("status".into(), Value::String(status));
    lifecycle.insert(
        "reason".into(),
        match present("reason") {
            None if legacy_failed => Value::String("party_final_death".into()),
            None => Value::Null,
            Some(reason) => string_head(reason, 240),
        },
    );
    lifecycle.insert("paused_at".into(), present("paused_at").cloned().unwrap_or(Value::Null));
    let concluded = match present("concluded_at") {
        Some(value) => value.clone(),
        None if legacy_failed => present("updated_at").cloned().unwrap_or(Value::Null),
        None => Value::Null,
    };
    lifecycle.insert("concluded_at".into(), concluded);
    lifecycle.insert("archived_at".into(), present("archived_at").cloned().unwrap_or(Value::Null));
    lifecycle.insert("epilogue".into(), present("epilogue").map_or(Value::Null, |epilogue| string_head(epilogue, 8_000)));
    let keys: Vec<Value> = match field("epilogue_fact_keys") {
        Some(Value::Array(keys)) => keys.iter().map(|key| clean(Some(key), 240)).filter(|key| !key.is_empty()).take(64).map(Value::String).collect(),
        _ => Vec::new(),
    };
    lifecycle.insert("epilogue_fact_keys".into(), Value::Array(keys));
    lifecycle.insert("changed_by".into(), present("changed_by").map_or(Value::Null, |changed| string_head(changed, 120)));
    // Развязка сценария: есть только у кампании, завершённой по авторскому сюжету.
    if let Some(ending @ (Value::Object(_) | Value::Array(_))) = field("ending") {
        let ending = Some(ending);
        lifecycle.insert(
            "ending".into(),
            json!({ "id": clean(prop(ending, "id"), 80), "title": clean(prop(ending, "title"), 160), "outcome": clean(prop(ending, "outcome"), 60) }),
        );
    }
    Value::Object(lifecycle)
}

/// `campaignIsReadOnly(state)`.
pub fn campaign_is_read_only(state: &Value) -> bool {
    TERMINAL.contains(&status_of(&lifecycle_of(state)))
}

/// `campaignModeFor(state)`: в JS `state.campaignConcept` без `?.` —
/// `null` вместо состояния бросает `TypeError` (`sk-society` отвечает
/// `adventure`).
fn mode_for(state: &Value) -> DirectorResult<&'static str> {
    if state.is_null() {
        return Err(DirectorError::null_read("campaignConcept"));
    }
    Ok(campaign_mode_for(state))
}

fn error(code: &str, message: impl Into<String>) -> DirectorError {
    DirectorError { name: "Error".into(), code: Some(code.into()), message: message.into() }
}

/// `assertCampaignPlayable(state)`: жизненный цикл или отказ
/// `CAMPAIGN_PAUSED`/`CAMPAIGN_READ_ONLY`.
pub fn assert_campaign_playable(state: &Value) -> DirectorResult<Value> {
    let lifecycle = lifecycle_of(state);
    if status_of(&lifecycle) == "paused" {
        return Err(error("CAMPAIGN_PAUSED", "Кампания приостановлена владельцем"));
    }
    if TERMINAL.contains(&status_of(&lifecycle)) {
        return Err(error("CAMPAIGN_READ_ONLY", "Завершённая или архивная кампания доступна только для чтения"));
    }
    Ok(lifecycle)
}

/// Переход жизненного цикла: из каких состояний, в какое и каким событием.
fn transition_for(action: &str) -> Option<(&'static [&'static str], &'static str, &'static str)> {
    Some(match action {
        "activate" => (&["setup"], "active", "CampaignActivated"),
        "pause" => (&["active"], "paused", "CampaignPaused"),
        "resume" => (&["paused"], "active", "CampaignResumed"),
        "complete" => (&["active", "paused"], "completed", "CampaignCompleted"),
        "fail" => (&["active"], "failed", "CampaignFailed"),
        "archive" => (&["setup", "paused", "completed", "failed"], "archived", "CampaignArchived"),
        _ => return None,
    })
}

/// `lifecycleEventForAction(action, state, { actorId, reason, now })`: событие
/// перехода или отказ с кодом JS. `options` `None` — аргумент не передан;
/// `now` не задан — текущее время.
/// `lifecycleActionForCommit(commit)`: действие жизненного цикла, которое
/// записал коммит маршрута `/lifecycle` (по первому событию), — для сверки
/// повтора ключа. Коммит чужого маршрута (`event_id` не `campaign-lifecycle:…`) — `None`.
pub fn lifecycle_action_for_commit(events: &[Value]) -> Option<&'static str> {
    let event = events.first()?;
    if !js::s(event.get("event_id")).starts_with("campaign-lifecycle:") {
        return None;
    }
    Some(match event.get("event_type").and_then(Value::as_str)? {
        "CampaignArcChainSet" => {
            if event.get("payload").and_then(|payload| payload.get("enabled")) == Some(&Value::Bool(true)) {
                "chain_arcs"
            } else {
                "conclude_after_arc"
            }
        }
        "CampaignActivated" => "activate",
        "CampaignPaused" => "pause",
        "CampaignResumed" => "resume",
        "CampaignCompleted" => "complete",
        "CampaignFailed" => "fail",
        "CampaignArchived" => "archive",
        _ => return None,
    })
}

pub fn lifecycle_event_for_action(action: Option<&Value>, state: &Value, options: Option<&Value>) -> DirectorResult<Value> {
    if matches!(options, Some(Value::Null)) {
        return Err(DirectorError::type_error("Cannot destructure property 'actorId' of '(intermediate value)(intermediate value)(intermediate value)' as it is null."));
    }
    let actor_id = prop(options, "actorId");
    let reason = prop(options, "reason");
    let now = prop(options, "now").cloned().unwrap_or_else(|| Value::String(clock::now_iso()));
    let lifecycle = lifecycle_of(state);
    let status = status_of(&lifecycle).to_string();
    let normalized_action = jstext::lower(&js::s(or(action, Some(&Value::String(String::new())))));
    let actor = nullish(actor_id, None).cloned().unwrap_or(Value::Null);
    let reason_text = Value::String(head16(&js::s(or(reason, Some(&Value::String(normalized_action.clone())))), 240));
    // Цепочка арок решается заранее, пока кампания идёт.
    if normalized_action == "chain_arcs" || normalized_action == "conclude_after_arc" {
        if mode_for(state)? == "persistent" {
            return Err(error("INVALID_CAMPAIGN_TRANSITION", "Постоянный мир продолжается без цепочки конечных арок"));
        }
        if status != "active" && status != "paused" {
            return Err(error("INVALID_CAMPAIGN_TRANSITION", format!("Продолжение кампании настраивается только в активной кампании, а не в \"{status}\"")));
        }
        return Ok(json!({
            "event_type": "CampaignArcChainSet", "actor_id": actor, "target_ids": [], "visibility": "party", "source_rule_ids": [], "ruling_id": null,
            "payload": { "enabled": normalized_action == "chain_arcs", "reason": reason_text, "changed_by": actor, "occurred_at": now },
        }));
    }
    // Ключ прототипа (`constructor`, `__proto__`) — не переход: в JS только
    // свои ключи `transitions` (`Object.hasOwn`).
    let Some((_, to, event)) = transition_for(&normalized_action).filter(|(from, ..)| from.contains(&status.as_str())) else {
        return Err(error("INVALID_CAMPAIGN_TRANSITION", format!("Переход lifecycle \"{status}\" → \"{normalized_action}\" запрещён")));
    };
    let mechanics = prop(Some(state), "mechanics");
    if normalized_action == "complete" && js::truthy(get(mechanics, &["combat", "active"])) {
        return Err(error("CAMPAIGN_COMBAT_ACTIVE", "Нельзя завершить кампанию во время активного боя"));
    }
    let confirmed = get(mechanics, &["death", "campaign_status"]).and_then(Value::as_str) == Some("party_defeated");
    if normalized_action == "fail" && (actor_id.and_then(Value::as_str) != Some("system") || !confirmed) {
        return Err(error("CAMPAIGN_FAILURE_NOT_CONFIRMED", "Провал кампании фиксирует только сервер после подтверждённой гибели всего отряда"));
    }
    let mut payload = Map::new();
    payload.insert("status".into(), Value::String(to.into()));
    payload.insert("reason".into(), reason_text);
    payload.insert("changed_by".into(), actor.clone());
    payload.insert("occurred_at".into(), now);
    if normalized_action == "complete" || normalized_action == "fail" {
        let outcome = json!({ "outcome": if normalized_action == "fail" { "failed" } else { "completed" } });
        let facts = collect_epilogue_facts(state, Some(&outcome));
        let epilogue = build_deterministic_epilogue(state, Some(&json!({ "outcome": facts["outcome"] })));
        if !epilogue.is_empty() {
            payload.insert("epilogue".into(), Value::String(epilogue));
        }
        payload.insert("epilogue_fact_keys".into(), facts["fact_keys"].clone());
    }
    Ok(json!({
        "event_type": event, "actor_id": actor, "target_ids": [], "visibility": "party", "source_rule_ids": [], "ruling_id": null,
        "payload": Value::Object(payload),
    }))
}

fn names(facts: &Value, status: &str) -> Vec<String> {
    array(facts.get("heroes")).iter().filter(|hero| hero["status"] == status).map(|hero| js::s(hero.get("name"))).collect()
}

/// Подпись ступени славы.
fn tier_label(tier: &str) -> &'static str {
    match tier {
        "reviled" => "ненавидит отряд",
        "distrusted" => "не доверяет отряду",
        "unknown" => "сохраняет нейтралитет",
        "respected" => "уважает отряд",
        "honoured" => "чтит отряд",
        _ => "помнит отряд",
    }
}

/// `buildDeterministicEpilogue(state, outcomeOrOptions)`: эпилог без модели —
/// только из подтверждённых фактов.
pub fn build_deterministic_epilogue(state: &Value, outcome_or_options: Option<&Value>) -> String {
    let facts = collect_epilogue_facts(state, outcome_or_options);
    let living = names(&facts, "living");
    let fallen = names(&facts, "dead");
    let s = |value: &Value| js::s(Some(value));
    let quest_outcomes: Vec<String> = array(facts.get("quests"))
        .iter()
        .map(|quest| {
            let resolution = match quest["status"].as_str() {
                Some("completed") => "завершён",
                Some("abandoned") => "оставлен отрядом",
                _ => "провален",
            };
            let summary = without_terminal_punctuation(&s(&quest["summary"]), 240);
            format!("«{}» {resolution}{}", s(&quest["title"]), if summary.is_empty() { String::new() } else { format!(": {summary}") })
        })
        .collect();
    let promise_outcomes: Vec<String> = array(facts.get("promises"))
        .iter()
        .map(|promise| {
            let resolution = if promise["status"] == "fulfilled" { "исполнено" } else { "нарушено" };
            format!("обещание {} «{}» {resolution}", s(&promise["npc_name"]), without_terminal_punctuation(&s(&promise["text"]), 220))
        })
        .collect();
    let world_outcomes: Vec<String> = array(facts.get("npc_fates"))
        .iter()
        .chain(array(facts.get("world_facts")))
        .map(|fact| without_terminal_punctuation(&s(&fact["summary"]), 240))
        .filter(|summary| !summary.is_empty())
        .collect();
    let reputation_outcomes: Vec<String> =
        array(facts.get("faction_reputations")).iter().map(|entry| format!("{} {}", s(&entry["faction_name"]), tier_label(entry["tier"].as_str().unwrap_or("")))).collect();
    let visited: Vec<String> = array(facts.get("visited_locations")).iter().map(|entry| s(&entry["name"])).collect();
    let campaign = s(&facts["campaign"]);
    let objective = s(&facts["final_objective"]);
    let location = s(&facts["final_location"]);
    let parts = [
        if facts["outcome"] == "failed" { format!("История «{campaign}» завершилась поражением.") } else { format!("История «{campaign}» завершена.") },
        if objective.is_empty() { String::new() } else { format!("Последняя цель: {objective}.") },
        if location.is_empty() { String::new() } else { format!("Финальная глава развернулась в месте «{location}».") },
        if quest_outcomes.is_empty() { String::new() } else { format!("Итоги заданий: {}.", quest_outcomes.join("; ")) },
        if promise_outcomes.is_empty() { String::new() } else { format!("Мир запомнил: {}.", promise_outcomes.join("; ")) },
        if world_outcomes.is_empty() { String::new() } else { format!("Подтверждённые последствия: {}.", world_outcomes.join("; ")) },
        if reputation_outcomes.is_empty() { String::new() } else { format!("Слава отряда: {}.", reputation_outcomes.join("; ")) },
        if visited.is_empty() { String::new() } else { format!("Путь пролёг через: {}.", visited.join(", ")) },
        if living.is_empty() { "В летописи осталась память о павших героях.".to_string() } else { format!("В летописи мира остаются: {}.", living.join(", ")) },
        if !fallen.is_empty() && !living.is_empty() { format!("Память хранит павших: {}.", fallen.join(", ")) } else { String::new() },
    ];
    let joined: Vec<&str> = parts.iter().map(String::as_str).filter(|part| !part.is_empty()).collect();
    head16(&joined.join(" "), 8_000)
}

/// `campaignCanAutoComplete(state)`: кульминация с разрешённой главной нитью
/// (или развязка сценария) — кампания может закончиться сама.
pub fn campaign_can_auto_complete(state: &Value) -> DirectorResult<bool> {
    if mode_for(state)? == "persistent" {
        return Ok(false);
    }
    if status_of(&lifecycle_of(state)) != "active" || js::truthy(get(Some(state), &["mechanics", "combat", "active"])) {
        return Ok(false);
    }
    // Кампания по сценарию заканчивается исходом боя с главным противником.
    if campaign_scenario(state).is_some() {
        return Ok(scenario_ending(state).is_some());
    }
    if get(Some(state), &["autonomy", "pacing", "phase"]).and_then(Value::as_str) != Some("climax") {
        return Ok(false);
    }
    let Some(main_quest) = main_quest_for(state) else { return Ok(false) };
    if !main_quest.get("status").and_then(Value::as_str).is_some_and(|status| CLOSED_QUEST_STATUSES.contains(&status)) {
        return Ok(false);
    }
    Ok(if campaign_arc_plan(state).is_some() { campaign_arc_climax_satisfied(state) } else { true })
}

/// `campaignCanAdvanceArc(state)`: тот же момент, что и финал, плюс запас в
/// цепочке арок; у авторского сюжета следующей арки нет.
pub fn campaign_can_advance_arc(state: &Value) -> DirectorResult<bool> {
    if !campaign_can_auto_complete(state)? || campaign_scenario(state).is_some() {
        return Ok(false);
    }
    Ok(campaign_arc_plan(state).is_some_and(|plan| js::number(plan.get("arc_number")) < MAX_CAMPAIGN_ARCS as f64))
}

/// `campaignArcCarryOver(state)`: что переезжает в следующую арку — перечнем,
/// а не «всё, кроме». Пустой элемент списка заданий в JS роняет перенос
/// (`TypeError`), как и здесь.
pub fn campaign_arc_carry_over(state: &Value) -> DirectorResult<Value> {
    let facts = collect_epilogue_facts(state, Some(&json!({ "outcome": "completed" })));
    let hero_ids = |status: &str| -> Vec<Value> {
        array(facts.get("heroes")).iter().filter(|hero| hero["status"] == status).map(|hero| hero["hero_id"].clone()).filter(|id| js::truthy(Some(id))).collect()
    };
    let mut open_quest_ids = Vec::new();
    for quest in array(get(Some(state), &["worldMemory", "quests"])) {
        if RESOLVED_QUEST_STATUSES.contains(&clean(prop(Some(quest), "status"), 30).as_str()) || js::s(prop(Some(quest), "id")).starts_with("quest:chapter:") {
            continue;
        }
        if quest.is_null() {
            return Err(DirectorError::null_read("id"));
        }
        let id = clean(prop(Some(quest), "id"), 120);
        if !id.is_empty() {
            open_quest_ids.push(Value::String(id));
        }
    }
    open_quest_ids.truncate(64);
    let mut npc_ids: Vec<String> = Vec::new();
    for promise in array(get(Some(state), &["social", "promises"])) {
        if RESOLVED_PROMISE_STATUSES.contains(&clean(prop(Some(promise), "status"), 30).as_str()) {
            continue;
        }
        let id = clean(prop(Some(promise), "npc_id"), 120);
        if !id.is_empty() && !npc_ids.contains(&id) {
            npc_ids.push(id);
        }
    }
    npc_ids.truncate(64);
    let reputation: Vec<Value> =
        array(facts.get("faction_reputations")).iter().take(32).map(|entry| json!({ "faction_id": entry["faction_id"], "tier": entry["tier"] })).collect();
    let visited: Vec<Value> = array(facts.get("visited_locations"))
        .iter()
        .map(|entry| clean(nullish(entry.get("name"), Some(entry)), 180))
        .filter(|name| !name.is_empty())
        .take(64)
        .map(Value::String)
        .collect();
    Ok(json!({
        "heroes": hero_ids("living"),
        "fallen_heroes": hero_ids("dead"),
        "open_quest_ids": open_quest_ids,
        "open_promise_npc_ids": npc_ids,
        "reputation": reputation,
        "visited_locations": visited,
    }))
}

/// `Math.max(1, Number(value) || 1)`.
fn chapter_of(value: Option<&Value>) -> Value {
    let number = js::number(value);
    let number = if number.is_nan() || number == 0.0 { 1.0 } else { number };
    js::num(number.max(1.0))
}

/// `buildEpilogueNarrationBrief(state, outcomeOrOptions)`: бриф рассказчику
/// эпилога — только видимые отряду подтверждённые события и факты. `null`
/// вместо состояния — `TypeError`, как в JS.
pub fn build_epilogue_narration_brief(state: &Value, outcome_or_options: Option<&Value>) -> DirectorResult<Value> {
    let facts = collect_epilogue_facts(state, outcome_or_options);
    if state.is_null() {
        return Err(DirectorError::null_read("adventure"));
    }
    let mut visible_events: Vec<Value> = array(facts.get("quests"))
        .iter()
        .map(|quest| {
            let outcome = match quest["status"].as_str() {
                Some("completed") => "success",
                Some("abandoned") => "abandoned",
                _ => "failure",
            };
            json!({ "event_type": "QuestResolved", "payload": { "quest_id": quest["quest_id"], "title": quest["title"], "outcome": outcome, "summary": quest["summary"] } })
        })
        .collect();
    visible_events.extend(array(facts.get("promises")).iter().map(|promise| {
        json!({ "event_type": "NpcPromiseResolved", "payload": {
            "promise_id": promise["promise_id"], "npc_id": promise["npc_id"], "npc_name": promise["npc_name"], "status": promise["status"], "text": promise["text"],
        } })
    }));
    let adventure = prop(Some(state), "adventure");
    let confirmed_facts: Vec<Value> = array(facts.get("npc_fates"))
        .iter()
        .chain(array(facts.get("world_facts")))
        .map(|fact| {
            json!({ "fact_id": fact["fact_id"], "subject_id": fact["subject_id"], "subject_kind": fact["subject_kind"],
                "subject_name": fact["subject_name"], "predicate": fact["predicate"], "summary": fact["summary"] })
        })
        .collect();
    let history: Vec<&Value> = array(prop(adventure, "history")).iter().filter(|entry| !entry.is_null() && visible_to_party(entry, &party())).collect();
    let history: Vec<Value> = tail(history, 12)
        .into_iter()
        .map(|entry| json!({ "chapter": chapter_of(entry.get("chapter")), "location": clean(entry.get("location"), 180), "outcome": clean(entry.get("outcome"), 500) }))
        .collect();
    Ok(json!({
        "visible_events": visible_events,
        "visible_state_changes": [{
            "campaign": facts["campaign"],
            "outcome": facts["outcome"],
            "chapter": chapter_of(prop(adventure, "chapter")),
            "final_location": facts["final_location"],
            "final_objective": facts["final_objective"],
            "living_heroes": names(&facts, "living"),
            "fallen_heroes": names(&facts, "dead"),
            "confirmed_fact_keys": facts["fact_keys"],
        }],
        "known_environment": {
            "confirmed_facts": confirmed_facts,
            "resolved_promises": facts["promises"],
            "faction_reputations": facts["faction_reputations"],
            "visited_locations": facts["visited_locations"],
            "confirmed_scene_history": history,
        },
        "permitted_npc_reactions": [],
        "narration_constraints": ["epilogue", "confirmed-events-only", "no-unconfirmed-world-changes", "do-not-decide-for-player-heroes"],
    }))
}

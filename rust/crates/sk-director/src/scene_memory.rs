//! Перенос `server/scene-memory.mjs` — каноническая память мира от сцены:
//! место сцены и задание главы для кампании, у которой есть только поля
//! сцены и приключения (`ensureSceneWorldMemory`), и ограниченный набор
//! событий памяти по уже проверенному переходу (`sceneWorldMemoryEvents`):
//! места, задания глав, факты пути и прибытия, заготовки ведущего и тайны
//! сценария — скрытыми фактами. Свободной памяти от модели модуль не
//! принимает.

use serde_json::{json, Map, Value};
use sk_core::{hash, js, re, text as jstext};
use sk_memory::world_memory::{gm_secret_fact, normalize_gm_secrets, normalize_world_memory};
use sk_society::campaign_stories::campaign_mode_for;
use sk_story::campaign_loop_policy::campaign_arc_plan;

use crate::adventure_director::{head16, nullish, or, prop, DirectorError, DirectorResult};
use crate::campaign_lifecycle::clean;

fn clean_str(value: &str, maximum: usize) -> String {
    clean(Some(&Value::String(value.to_string())), maximum)
}

fn array(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

/// `chapterNumber(value, fallback)`.
fn chapter_number(value: Option<&Value>, fallback: i64) -> i64 {
    if js::is_safe_integer_number(value) {
        (js::number(value) as i64).clamp(1, 999)
    } else {
        fallback
    }
}

/// `stableId(namespace, ...parts)`: части через `\0`, sha256, 24 знака.
fn stable_id(namespace: &str, parts: &[Option<&Value>]) -> String {
    let joined: Vec<String> = parts.iter().map(|part| clean(*part, 1_000)).collect();
    format!("{namespace}:{}", head16(&hash::sha256_hex(joined.join("\u{0}")), 24))
}

fn string(value: &str) -> Value {
    Value::String(value.to_string())
}

/// `locationEntity(memory, name)`.
fn location_entity<'a>(memory: &'a Value, name: &str) -> Option<&'a Value> {
    let normalized = jstext::lower(&clean_str(name, 160));
    array(memory.get("entities")).iter().find(|entity| entity["kind"] == "location" && jstext::lower(&js::s(entity.get("name"))) == normalized)
}

/// `canonicalLocation(memory, name, summary)`: место сцены с пометкой
/// `visited`; известное место сохраняет id, псевдонимы и метки.
fn canonical_location(memory: &Value, name: Option<&Value>, summary: Option<&Value>) -> Value {
    let cleaned = clean(name, 160);
    let location_name = if cleaned.is_empty() { "Unknown location".to_string() } else { cleaned };
    let existing = location_entity(memory, &location_name);
    let id = match or(prop(existing, "id"), None) {
        Some(id) => id.clone(),
        None => string(&stable_id("location", &[Some(&string(&jstext::lower(&location_name)))])),
    };
    let mut tags: Vec<Value> = Vec::new();
    for tag in array(prop(existing, "tags")).iter().chain(std::iter::once(&string("visited"))) {
        if !tags.iter().any(|known| crate::adventure_director::strict_equal(Some(known), Some(tag))) {
            tags.push(tag.clone());
        }
    }
    tags.truncate(20);
    json!({
        "id": id,
        "kind": "location",
        "name": location_name,
        "summary": clean(or(summary, prop(existing, "summary")), 1_000),
        "aliases": nullish(prop(existing, "aliases"), None).cloned().unwrap_or_else(|| json!([])),
        "visibility": if prop(existing, "visibility").and_then(Value::as_str) == Some("public") { "public" } else { "party" },
        "tags": tags,
    })
}

/// `questTitleFromObjective(value)`: исходная цель из призыва к действию
/// любой вложенности («Продолжить квест «X»» → X).
pub fn quest_title_from_objective(value: Option<&Value>) -> String {
    let wrappers = [
        re!(r"^Продолжить квест «(.+)»$", "u"),
        re!(r"^Развить последствия победы в квесте «(.+)» и приблизить развязку$", "u"),
        re!(r"^Ответить на последствия провала квеста «(.+)» и найти новый путь$", "u"),
    ];
    let mut title = clean(value, 300);
    for _ in 0..8 {
        let inner = wrappers.iter().find_map(|pattern| pattern.captures(&title).ok().flatten().and_then(|captures| captures.get(1).map(|group| group.as_str().to_string())));
        let Some(inner) = inner else { break };
        title = clean_str(&inner, 300);
    }
    title
}

/// `sceneQuest({ chapter, scene, adventure, locationId, clockMax })`.
fn scene_quest(chapter: i64, scene: Option<&Value>, adventure: Option<&Value>, location_id: &Value, clock_max: &Value) -> Value {
    let objective = clean(prop(scene, "objective"), 300);
    let hook = clean(prop(adventure, "currentHook"), 1_000);
    let number = chapter_number(Some(&Value::from(chapter)), 1);
    let quest_title = string(&quest_title_from_objective(Some(&string(&objective))));
    let fallback = string(&format!("Chapter {number}"));
    let title = clean(or(or(Some(&quest_title), prop(scene, "title")), Some(&fallback)), 180);
    let max = {
        let number = js::number(Some(clock_max));
        if number.is_nan() || number == 0.0 {
            4.0
        } else {
            number.max(1.0)
        }
    };
    json!({
        "id": format!("quest:chapter:{number}"),
        "title": title,
        "summary": if hook.is_empty() { objective.clone() } else { hook },
        "status": "active",
        "visibility": "party",
        "entity_ids": if js::truthy(Some(location_id)) { vec![location_id.clone()] } else { Vec::new() },
        "objectives": if objective.is_empty() { Vec::new() } else { vec![objective] },
        "clock": { "current": 0, "max": js::num(max), "label": "Цель сцены", "triggered": false },
    })
}

/// `campaignArcPlan(state)?.chapter_clock_max ?? 4`; у `null` вместо
/// состояния JS бросает `TypeError` в `campaignModeFor`.
fn clock_max(state: &Value) -> DirectorResult<Value> {
    if state.is_null() {
        return Err(DirectorError::null_read("campaignConcept"));
    }
    let plan = campaign_arc_plan(state);
    Ok(nullish(plan.as_ref().and_then(|plan| plan.get("chapter_clock_max")), None).cloned().unwrap_or_else(|| json!(4)))
}

/// `ensureSceneWorldMemory(input, state)`: кампания только с полями сцены и
/// приключения получает место сцены и задание главы. `input` `None` —
/// аргумент не передан.
pub fn ensure_scene_world_memory(input: Option<&Value>, state: &Value) -> DirectorResult<Value> {
    let mut memory = normalize_world_memory(input.unwrap_or(&json!({})));
    let clock_max = clock_max(state)?;
    let scene = prop(Some(state), "scene");
    let location_name = clean(or(prop(scene, "location"), prop(scene, "title")), 160);
    if location_name.is_empty() {
        return Ok(memory);
    }
    let location = canonical_location(&memory, Some(&string(&location_name)), prop(scene, "mood"));
    if !array(memory.get("entities")).iter().any(|entity| entity.get("id") == location.get("id")) {
        js::array_mut(&mut memory, "entities").push(location.clone());
    }
    let chapter = chapter_number(prop(prop(Some(state), "adventure"), "chapter"), 1);
    let quest_id = format!("quest:chapter:{chapter}");
    if campaign_mode_for(state) != "persistent"
        && !array(memory.get("quests")).iter().any(|quest| quest["id"] == quest_id.as_str())
        && !clean(prop(scene, "objective"), 300).is_empty()
    {
        let quest = scene_quest(chapter, scene, prop(Some(state), "adventure"), &location["id"], &clock_max);
        js::array_mut(&mut memory, "quests").push(quest);
    }
    Ok(normalize_world_memory(&memory))
}

/// `sceneWorldMemoryEventId(commandId)`.
pub fn scene_world_memory_event_id(command_id: Option<&Value>) -> String {
    stable_id("scene-event", &[command_id])
}

fn event(event_type: &str, payload: Value, visibility: &str) -> Value {
    json!({ "event_type": event_type, "payload": payload, "visibility": visibility, "target_ids": [] })
}

/// `{ ...base, key: value, … }`: прежние ключи остаются на месте.
fn spread(base: &Value, fields: Vec<(&str, Value)>) -> Value {
    let mut object = match base {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    for (key, value) in fields {
        object.insert(key.into(), value);
    }
    Value::Object(object)
}

/// `sceneWorldMemoryEvents(state, transition, { commandId, sourceEventId,
/// secrets, scenarioSecrets })`: события памяти по проверенному переходу.
/// `options` `None` — аргумент не передан.
pub fn scene_world_memory_events(state: &Value, transition: Option<&Value>, options: Option<&Value>) -> DirectorResult<Vec<Value>> {
    if matches!(options, Some(Value::Null)) {
        return Err(DirectorError::null_read("commandId"));
    }
    if state.is_null() {
        return Err(DirectorError::null_read("worldMemory"));
    }
    let option = |key: &str| prop(options, key);
    let empty = string("");
    let command_id = option("commandId").unwrap_or(&empty);
    let source_event_id = option("sourceEventId").unwrap_or(&empty);
    let state_ref = Some(state);
    let memory = ensure_scene_world_memory(prop(state_ref, "worldMemory"), state)?;
    let clock_max = clock_max(state)?;
    let empty_object = json!({});
    let previous_scene = nullish(prop(state_ref, "scene"), None).unwrap_or(&empty_object);
    let next_scene = nullish(prop(transition, "scene"), None).unwrap_or(&empty_object);
    let next_adventure = nullish(prop(transition, "adventure"), None).unwrap_or(&empty_object);
    let adventure = prop(state_ref, "adventure");
    let previous_chapter = chapter_number(prop(adventure, "chapter"), (chapter_number(next_adventure.get("chapter"), 2) - 1).max(1));
    let next_chapter = chapter_number(next_adventure.get("chapter"), previous_chapter + 1);
    let outcome = match next_adventure.get("history") {
        Some(Value::Array(history)) => history.last().filter(|entry| !entry.is_null()).unwrap_or(&empty_object),
        _ => &empty_object,
    };
    let outcome_status = outcome.get("status").and_then(Value::as_str);
    let persistent = campaign_mode_for(state) == "persistent";

    let previous_location = canonical_location(&memory, or(prop(Some(previous_scene), "location"), prop(Some(previous_scene), "title")), prop(Some(previous_scene), "mood"));
    let mut with_previous = memory.clone();
    {
        let entities = js::array_mut(&mut with_previous, "entities");
        entities.retain(|entity| entity.get("id") != previous_location.get("id"));
        entities.push(previous_location.clone());
    }
    let with_previous = normalize_world_memory(&with_previous);
    let next_location = canonical_location(&with_previous, or(prop(Some(next_scene), "location"), prop(Some(next_scene), "title")), prop(Some(next_scene), "mood"));
    let mut events = Vec::new();

    for entity in [&previous_location, &next_location] {
        let existing = array(memory.get("entities")).iter().find(|candidate| candidate.get("id") == entity.get("id"));
        if existing.is_none_or(|existing| js::stringify(existing) != js::stringify(entity)) {
            events.push(event("WorldEntityUpserted", json!({ "entity": entity }), "party"));
        }
    }

    let previous_quest_id = format!("quest:chapter:{previous_chapter}");
    let previous_quest = array(memory.get("quests"))
        .iter()
        .find(|quest| quest["id"] == previous_quest_id.as_str())
        .cloned()
        .unwrap_or_else(|| scene_quest(previous_chapter, Some(previous_scene), adventure, &previous_location["id"], &clock_max));
    let previous_status = match outcome_status {
        Some("abandoned") => "abandoned",
        Some("completed") => "completed",
        _ => "active",
    };
    // Цель продолжается в новом месте (`continued`): то же задание главы, те
    // же часы, новое место — сущность задания.
    let continued = outcome_status == Some("continued");
    let next_objective = clean(next_scene.get("objective"), 300);
    if !persistent {
        let quest = if continued {
            let objectives = if next_objective.is_empty() {
                nullish(previous_quest.get("objectives"), None).cloned().unwrap_or_else(|| json!([]))
            } else {
                json!([next_objective])
            };
            let mut entity_ids: Vec<Value> = Vec::new();
            for id in array(previous_quest.get("entity_ids")).iter().chain(std::iter::once(&next_location["id"])) {
                if !entity_ids.iter().any(|known| crate::adventure_director::strict_equal(Some(known), Some(id))) {
                    entity_ids.push(id.clone());
                }
            }
            spread(&previous_quest, vec![("status", string("active")), ("objectives", objectives), ("entity_ids", Value::Array(entity_ids))])
        } else {
            let summary = clean(or(outcome.get("outcome"), previous_quest.get("summary")), 1_000);
            spread(&previous_quest, vec![("summary", string(&summary)), ("status", string(previous_status))])
        };
        events.push(event("QuestUpserted", json!({ "quest": quest }), "party"));
    }

    // Та же формулировка в стартовом задании кампании меняется на остаток цели.
    if continued && !next_objective.is_empty() {
        let before = clean(previous_scene.get("objective"), 300);
        for quest in array(memory.get("quests")) {
            let objectives = array(nullish(quest.get("objectives"), None));
            if quest.get("id") == previous_quest.get("id") || quest["status"] != "active" || !objectives.iter().any(|objective| clean(Some(objective), 300) == before) {
                continue;
            }
            let replaced: Vec<Value> = objectives.iter().map(|objective| if clean(Some(objective), 300) == before { string(&next_objective) } else { objective.clone() }).collect();
            let visibility = if quest["visibility"] == "gm_only" { "gm_only" } else { "party" };
            events.push(event("QuestUpserted", json!({ "quest": spread(quest, vec![("objectives", Value::Array(replaced))]) }), visibility));
        }
    }

    if !continued && !persistent && !next_objective.is_empty() {
        let next_quest = scene_quest(next_chapter, Some(next_scene), Some(next_adventure), &next_location["id"], &clock_max);
        events.push(event("QuestUpserted", json!({ "quest": next_quest }), "party"));
    }

    let provenance = if js::truthy(Some(source_event_id)) { json!([source_event_id]) } else { json!([]) };
    let command = clean(Some(command_id), 160);
    let previous_name = js::s(previous_location.get("name"));
    let next_name = js::s(next_location.get("name"));
    let route = string(&format!("{previous_name} -> {next_name}"));
    let transition_fact = json!({
        "id": stable_id("fact", &[Some(&string("scene-transition")), Some(command_id), previous_location.get("id"), next_location.get("id")]),
        "subject_id": previous_location["id"],
        "predicate": "party_traveled_to",
        "object": next_location["name"],
        "summary": clean(or(or(prop(transition, "transition"), outcome.get("outcome")), Some(&route)), 1_000),
        "visibility": "party",
        "source_event_ids": provenance,
        "source_command_id": command,
        "supersedes_fact_id": "",
        "status": "active",
    });
    let arrived = string(&format!("The party arrived at {next_name}."));
    let arrival_fact = json!({
        "id": stable_id("fact", &[Some(&string("scene-arrival")), Some(command_id), next_location.get("id")]),
        "subject_id": next_location["id"],
        "predicate": "party_arrived",
        "object": clean(or(prop(transition, "arrival"), next_location.get("name")), 1_000),
        "summary": clean(or(prop(transition, "arrival"), Some(&arrived)), 1_000),
        "visibility": "party",
        "source_event_ids": provenance,
        "source_command_id": command,
        "supersedes_fact_id": "",
        "status": "active",
    });
    let known_fact = |id: Option<&Value>| array(memory.get("facts")).iter().any(|fact| fact.get("id") == id);
    if !known_fact(transition_fact.get("id")) {
        events.push(event("WorldFactRecorded", json!({ "fact": transition_fact }), "party"));
    }
    if !known_fact(arrival_fact.get("id")) {
        events.push(event("WorldFactRecorded", json!({ "fact": arrival_fact }), "party"));
    }
    // Заготовки ведущего новой области — скрытыми фактами места.
    let next_id = js::s(next_location.get("id"));
    let secrets = nullish(option("secrets"), None).cloned().unwrap_or_else(|| json!([]));
    for (index, secret) in normalize_gm_secrets(Some(&secrets), 3).into_iter().enumerate() {
        let secret = spread(&secret, vec![("holder", string(""))]);
        let input = json!({ "subjectId": next_location["id"], "salt": format!("scene:{command}:{next_id}"), "index": index, "sourceCommandId": command });
        let fact = gm_secret_fact(&secret, &input);
        if !known_fact(fact.get("id")) {
            events.push(event("WorldFactRecorded", json!({ "fact": fact }), "gm_only"));
        }
    }
    // Тайны сценария: id стабилен, возвращение в место не заводит тайну дважды.
    let scenario_secrets = match option("scenarioSecrets") {
        None => Vec::new(),
        Some(Value::Array(items)) => items.clone(),
        // Строка перебирается по символам; у символа нет `clue` и `fact_id`.
        Some(Value::String(text)) => text.chars().map(|ch| Value::String(ch.to_string())).collect(),
        Some(_) => return Err(DirectorError::type_error("scenarioSecrets is not iterable")),
    };
    for secret in &scenario_secrets {
        if secret.is_null() {
            return Err(DirectorError::null_read("clue"));
        }
        // `gmSecretFact`: `secret.skills.map(skill => skill.replace(…))` без проверок.
        match prop(Some(secret), "skills") {
            None => return Err(DirectorError::type_error("Cannot read properties of undefined (reading 'map')")),
            Some(Value::Null) => return Err(DirectorError::null_read("map")),
            Some(Value::Array(skills)) => {
                if skills.iter().any(|skill| !skill.is_string()) {
                    return Err(DirectorError::type_error("skill.replace is not a function"));
                }
            }
            Some(_) => return Err(DirectorError::type_error("secret.skills.map is not a function")),
        }
        let mut source = Map::new();
        for key in ["clue", "topic", "skills"] {
            if let Some(value) = prop(Some(secret), key) {
                source.insert(key.into(), value.clone());
            }
        }
        source.insert("holder".into(), string(""));
        let mut input = Map::new();
        input.insert("subjectId".into(), next_location["id"].clone());
        if let Some(salt) = prop(Some(secret), "fact_id") {
            input.insert("salt".into(), salt.clone());
        }
        input.insert("index".into(), json!(0));
        input.insert("sourceCommandId".into(), string(&command));
        let mut fact = gm_secret_fact(&Value::Object(source), &Value::Object(input));
        match prop(Some(secret), "fact_id") {
            Some(id) => fact["id"] = id.clone(),
            // `{ ...fact, id: undefined }`: в JSON ключа нет.
            None => {
                if let Value::Object(fact) = &mut fact {
                    fact.shift_remove("id");
                }
            }
        }
        if !known_fact(fact.get("id")) {
            events.push(event("WorldFactRecorded", json!({ "fact": fact }), "gm_only"));
        }
    }
    Ok(events)
}

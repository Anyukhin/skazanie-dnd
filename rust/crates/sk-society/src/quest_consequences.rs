//! Перенос `server/quest-consequences.mjs`: последствия поручений и граница
//! осведомлённости.
//!
//! Поручение, чей обязательный получатель погиб, становится невыполнимым;
//! поручение должности переходит к новому держателю. Последствие пишется в
//! журнал сразу, а игроку раскрывается по мере знания: граница
//! (`knowledge_gate`) следует за причиной, а не за публичностью задания, и
//! проекция для читателя восстанавливает последнее известное героям
//! представление.

use serde_json::{json, Map, Value};
use sk_core::js;

use crate::common::{
    array, coalesce, delete, empty, get, includes, is_str, js_order, js_string, number_of_truthy, number_or_zero, object_entries, s, spread_any, spread_iter,
    strict_eq, tpl,
};

pub const QUEST_CONSEQUENCE_POLICY_ID: &str = "skazanie:quest-consequences-v2";

const NEXT_OBJECTIVE: &str = "Выбрать дальнейшее занятие в текущей локации";

fn unique_push(list: &mut Vec<Value>, value: Value) {
    if !list.iter().any(|item| strict_eq(Some(item), Some(&value))) {
        list.push(value);
    }
}

/// Граница осведомлённости следует за причиной, а не публичностью задания
/// (`knowledgeGateForEvent`).
pub fn knowledge_gate_for_event(state: &Value, event: &Value) -> Value {
    let payload = get(Some(event), "payload");
    if js::truthy(get(payload, "knowledge_gate")) {
        return get(payload, "knowledge_gate").cloned().unwrap_or(Value::Null);
    }
    let mut candidates: Vec<Value> = Vec::new();
    candidates.extend(get(Some(event), "event_id").cloned());
    candidates.extend(get(payload, "source_event_id").cloned());
    candidates.extend(spread_iter(coalesce(get(payload, "source_event_ids"), None)));
    let source_ids: Vec<Value> = candidates.into_iter().filter(|value| js::truthy(Some(value))).collect();
    let required_subject = is_str(get(Some(event), "event_type"), "NpcDied").then(|| get(payload, "npc_id"));
    let mut player_ids: Vec<Value> = Vec::new();
    let mut players: Vec<Value> = spread_iter(coalesce(get(Some(event), "player_ids"), None));
    players.extend(spread_iter(coalesce(get(Some(event), "target_ids"), None)));
    players.extend(get(Some(event), "actor_id").cloned());
    for value in players.into_iter().filter(|value| js::truthy(Some(value))) {
        unique_push(&mut player_ids, value);
    }
    let visibility = get(Some(event), "visibility").filter(|value| js::truthy(Some(value))).cloned().unwrap_or_else(|| json!("gm_only"));
    let elapsed = get(get(get(Some(state), "mechanics"), "world_time"), "elapsed_minutes");
    let recorded = js::max_of([0.0, number_or_zero(elapsed)]);
    let facts = array(get(get(Some(state), "worldMemory"), "facts"));
    let fact_ids: Vec<Value> = facts
        .iter()
        .filter(|fact| {
            let matches_required = match required_subject {
                None => true,
                Some(subject) => strict_eq(get(Some(fact), "subject_id"), subject) && is_str(get(Some(fact), "predicate"), "died"),
            };
            matches_required && array(get(Some(fact), "source_event_ids")).iter().any(|id| source_ids.iter().any(|source| strict_eq(Some(source), Some(id))))
        })
        .map(|fact| get(Some(fact), "id").cloned().unwrap_or(Value::Null))
        .collect();
    let mut gate = Map::new();
    gate.insert("visibility".into(), visibility);
    gate.insert("recorded_at_minutes".into(), js::num(recorded));
    gate.insert("player_ids".into(), Value::Array(player_ids));
    gate.insert("source_event_ids".into(), Value::Array(source_ids));
    if let Some(subject) = required_subject {
        let mut required = Map::new();
        if let Some(subject) = subject {
            required.insert("subject_id".into(), subject.clone());
        }
        required.insert("predicate".into(), json!("died"));
        gate.insert("required_fact".into(), Value::Object(required));
    }
    gate.insert("fact_ids".into(), Value::Array(fact_ids));
    Value::Object(gate)
}

/// Видна ли граница этому читателю (`knowledgeGateVisible`). Получение знания
/// открывает проекцию, а не запускает механическое последствие снова.
pub fn knowledge_gate_visible(gate: Option<&Value>, memory: &Value, viewer: &Value) -> bool {
    if !js::truthy(gate) || js::truthy(get(Some(viewer), "isAdmin")) || is_str(get(Some(viewer), "role"), "admin") {
        return true;
    }
    let requested = coalesce(get(Some(viewer), "asOfMinutes"), get(Some(viewer), "as_of_minutes"));
    let maximum = match requested {
        None | Some(Value::Null) => f64::INFINITY,
        some => js::number(some),
    };
    if number_of_truthy(get(gate, "recorded_at_minutes")) > maximum {
        return false;
    }
    let party_member = !js::is_false(get(Some(viewer), "isPartyMember"));
    let visibility = get(gate, "visibility");
    if is_str(visibility, "public") || is_str(visibility, "party") && party_member {
        return true;
    }
    let player_id = match get(Some(viewer), "playerId") {
        Some(value) if js::truthy(Some(value)) => js_string(value),
        _ => String::new(),
    };
    let player_value = Value::String(player_id.clone());
    if is_str(visibility, "specific_player") && !player_id.is_empty() && includes(get(gate, "player_ids"), Some(&player_value)) {
        return true;
    }
    let ledger = coalesce(coalesce(get(Some(memory), "knowledge_ledger"), get(Some(memory), "knowledge_revealed")), None);
    let known: Vec<Option<Value>> = array(ledger)
        .iter()
        .filter(|entry| is_str(get(Some(entry), "hero_id"), &player_id) && number_of_truthy(get(Some(entry), "recorded_at_minutes")) <= maximum)
        .map(|entry| get(Some(entry), "fact_id").cloned())
        .collect();
    let required = get(gate, "required_fact");
    for fact in spread_iter(coalesce(get(Some(memory), "facts"), None)) {
        if number_of_truthy(get(Some(&fact), "recorded_at_minutes")) > maximum {
            continue;
        }
        if js::truthy(required)
            && (!strict_eq(get(Some(&fact), "subject_id"), get(required, "subject_id")) || !strict_eq(get(Some(&fact), "predicate"), get(required, "predicate")))
        {
            continue;
        }
        let by_id = includes(get(gate, "fact_ids"), get(Some(&fact), "id"));
        let by_source = array(get(Some(&fact), "source_event_ids")).iter().any(|id| includes(get(gate, "source_event_ids"), Some(id)));
        if !by_id && !by_source {
            continue;
        }
        let fact_id = get(Some(&fact), "id");
        let fact_visibility = get(Some(&fact), "visibility");
        if known.iter().any(|entry| strict_eq(entry.as_ref(), fact_id))
            || is_str(fact_visibility, "public")
            || is_str(fact_visibility, "party") && party_member
        {
            return true;
        }
    }
    false
}

/// История содержит только прежнее представление записи
/// (`normalizeQuestKnowledgeHistory`).
pub fn normalize_quest_knowledge_history(value: Option<&Value>) -> Vec<Value> {
    array(value)
        .iter()
        .filter(|entry| {
            strict_eq(get(Some(entry), "schema_version"), Some(&json!(1)))
                && js::truthy(get(Some(entry), "event_id"))
                && js::truthy(get(Some(entry), "previous"))
                && js::truthy(get(Some(entry), "knowledge_gate"))
        })
        .cloned()
        .collect()
}

fn knowledge_fields(event_type: Option<&Value>) -> Option<&'static [&'static str]> {
    Some(match event_type.and_then(Value::as_str)? {
        "QuestAssignmentChanged" => &["giver_npc_id"],
        "QuestInvalidated" | "QuestResolved" => &["status", "summary"],
        "QuestClockAdvanced" => &["clock"],
        "QuestAccepted" => &["status"],
        "QuestUpserted" => &["title", "status", "summary", "giver_npc_id", "clock", "recorded_at_minutes", "visibility", "entity_ids", "objectives", "responsibility"],
        _ => return None,
    })
}

/// Записать в поручение прежнее представление полей, которые меняет событие
/// (`recordQuestKnowledge`).
pub fn record_quest_knowledge(record: &Value, event: &Value) -> Value {
    let history = normalize_quest_knowledge_history(get(Some(record), "knowledge_history"));
    let payload = get(Some(event), "payload");
    if history.is_empty() && (!strict_eq(get(payload, "schema_version"), Some(&json!(2))) || !js::truthy(get(payload, "knowledge_gate"))) {
        return record.clone();
    }
    let event_id = match get(Some(event), "event_id") {
        Some(value) if js::truthy(Some(value)) => value.clone(),
        _ => {
            let command = get(Some(event), "command_id");
            let head = if js::truthy(command) {
                tpl(command)
            } else {
                let joined = match get(payload, "source_event_ids") {
                    Some(Value::Array(items)) => items.iter().map(|item| s(Some(item))).collect::<Vec<_>>().join(":"),
                    _ => String::new(),
                };
                if joined.is_empty() {
                    history.len().to_string()
                } else {
                    joined
                }
            };
            let quest_id = get(payload, "quest_id");
            let nested = get(get(payload, "quest"), "id");
            let tail = if js::truthy(quest_id) {
                tpl(quest_id)
            } else if js::truthy(nested) {
                tpl(nested)
            } else {
                tpl(get(Some(record), "id"))
            };
            Value::String(format!("{head}:{}:{tail}", tpl(get(Some(event), "event_type"))))
        }
    };
    if history.iter().any(|entry| strict_eq(get(Some(entry), "event_id"), Some(&event_id))) {
        return record.clone();
    }
    let Some(fields) = knowledge_fields(get(Some(event), "event_type")) else {
        return record.clone();
    };
    let own = |key: &str| matches!(record, Value::Object(map) if map.contains_key(key));
    let previous: Map<String, Value> = fields.iter().filter(|key| own(key)).map(|key| (key.to_string(), record[*key].clone())).collect();
    let absent: Vec<Value> = fields.iter().filter(|key| !own(key)).map(|key| json!(key)).collect();
    let gate = match coalesce(get(payload, "knowledge_gate"), None) {
        Some(gate) => gate.clone(),
        None => {
            let mut cause = spread_any(Some(event));
            let visibility = coalesce(get(Some(event), "visibility"), None).cloned().unwrap_or_else(|| json!("public"));
            cause.insert("visibility".into(), visibility);
            knowledge_gate_for_event(empty(), &Value::Object(cause))
        }
    };
    let mut entry = Map::new();
    entry.insert("schema_version".into(), json!(1));
    entry.insert("event_id".into(), event_id);
    entry.insert("previous".into(), Value::Object(previous));
    entry.insert("absent_fields".into(), Value::Array(absent));
    entry.insert("knowledge_gate".into(), gate);
    if js::truthy(get(payload, "previous_view")) {
        entry.insert("previous_view".into(), payload.and_then(|p| p.get("previous_view")).cloned().unwrap_or(Value::Null));
    }
    let mut next_history = history;
    next_history.push(Value::Object(entry));
    let mut result = spread_any(Some(record));
    result.insert("knowledge_history".into(), Value::Array(next_history));
    Value::Object(js_order(result))
}

/// Поручение глазами читателя (`questForKnowledge`): поля, изменённые
/// неизвестными ему событиями, показываются в прежнем виде.
pub fn quest_for_knowledge(record: &Value, memory: &Value, viewer: &Value) -> Value {
    let mut visible = spread_any(Some(record));
    delete(&mut visible, "knowledge_history");
    let history = spread_iter(get(Some(record), "knowledge_history"));
    let mut known_fields: Vec<Value> = Vec::new();
    let has = |fields: &Vec<Value>, key: &Value| fields.iter().any(|field| strict_eq(Some(field), Some(key)));
    for entry in history.iter().rev() {
        let known = knowledge_gate_visible(get(Some(entry), "knowledge_gate"), memory, viewer);
        for (key, value) in object_entries(get(Some(entry), "previous")) {
            let key_value = Value::String(key.clone());
            if known {
                known_fields.push(key_value);
            } else if !has(&known_fields, &key_value) {
                visible.insert(key, value);
            }
        }
        for key in spread_iter(coalesce(get(Some(entry), "absent_fields"), None)) {
            if known {
                known_fields.push(key);
            } else if !has(&known_fields, &key) {
                delete(&mut visible, &js_string(&key));
            }
        }
    }
    Value::Object(js_order(visible))
}

/// Пометка «undefined» для полей, которые JS присваивает как `undefined`:
/// ключ остаётся на своём месте, но в JSON не попадает.
const UNDEFINED: &str = "\u{0}undefined";

fn defined(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| value.as_str() != Some(UNDEFINED))
}

fn or_undefined(value: Option<&Value>) -> Value {
    value.cloned().unwrap_or_else(|| Value::String(UNDEFINED.into()))
}

fn strip_undefined(map: &mut Map<String, Value>) {
    map.retain(|_, value| value.as_str() != Some(UNDEFINED));
}

fn restore_objective(state: &Value, result: &mut Map<String, Value>, before: Option<&Value>) {
    if !js::truthy(before) {
        return;
    }
    let location = get(get(Some(state), "scene"), "location_id");
    if !strict_eq(location, get(before, "location_id")) {
        return;
    }
    if !strict_eq(defined(get(result.get("scene"), "objective")), get(before, "replaced_objective")) {
        return;
    }
    let mut scene = spread_any(result.get("scene"));
    scene.insert("objective".into(), or_undefined(get(before, "objective")));
    result.insert("scene".into(), Value::Object(scene));
    let mut adventure = spread_any(result.get("adventure"));
    adventure.insert("currentHook".into(), or_undefined(get(before, "current_hook")));
    result.insert("adventure".into(), Value::Object(adventure));
    result.insert("suggestions".into(), coalesce(get(before, "suggestions"), None).cloned().unwrap_or_else(|| json!([])));
}

/// Представление поручений и историй для читателя (`questStateForViewer`).
/// Команды всегда исполняются по исходному состоянию.
pub fn quest_state_for_viewer(state: &Value, viewer: &Value) -> Value {
    if js::truthy(get(Some(viewer), "isAdmin")) || is_str(get(Some(viewer), "role"), "admin") {
        return state.clone();
    }
    let memory = coalesce(get(Some(state), "worldMemory"), None).unwrap_or(empty());
    let concept = coalesce(get(Some(state), "campaignConcept"), None).unwrap_or(empty());
    let history: &[Value] = array(get(Some(concept), "story_history"));
    let visible_gate = |gate: Option<&Value>| knowledge_gate_visible(gate, memory, viewer);
    let hidden_stories = history.iter().filter(|story| !visible_gate(get(Some(story), "knowledge_gate"))).count();
    let mut hidden_before = 0usize;
    let mut visible_history: Vec<Value> = Vec::new();
    for story in history {
        if !visible_gate(get(Some(story), "knowledge_gate")) {
            hidden_before += 1;
            continue;
        }
        let mut rest = spread_any(Some(story));
        for key in ["knowledge_gate", "previous_view", "source_event_ids", "dependency_id", "policy_id"] {
            delete(&mut rest, key);
        }
        if hidden_before > 0 {
            let number = js::number(get(Some(story), "story_number")) - hidden_before as f64;
            rest.insert("story_number".into(), js::num(js::max_of([1.0, number])));
        }
        visible_history.push(Value::Object(rest));
    }
    let mut result = spread_any(Some(state));
    let mut world_memory = spread_any(Some(memory));
    let quests: Vec<Value> = array(get(Some(memory), "quests")).iter().map(|quest| quest_for_knowledge(quest, memory, viewer)).collect();
    world_memory.insert("quests".into(), Value::Array(quests));
    result.insert("worldMemory".into(), Value::Object(world_memory));
    if js::truthy(get(Some(state), "campaignConcept")) {
        let mut next = spread_any(Some(concept));
        if matches!(get(Some(concept), "story_history"), Some(Value::Array(_))) {
            next.insert("story_history".into(), Value::Array(visible_history));
        }
        if hidden_stories > 0 {
            let sequence = number_of_truthy(get(Some(concept), "story_sequence")) - hidden_stories as f64;
            next.insert("story_sequence".into(), js::num(js::max_of([0.0, sequence])));
        }
        result.insert("campaignConcept".into(), Value::Object(next));
    }
    if js::truthy(get(Some(state), "messages")) {
        let messages: Vec<Value> = array(get(Some(state), "messages"))
            .iter()
            .filter(|entry| visible_gate(get(Some(entry), "knowledge_gate")))
            .map(|entry| {
                let mut rest = spread_any(Some(entry));
                delete(&mut rest, "knowledge_gate");
                Value::Object(rest)
            })
            .collect();
        result.insert("messages".into(), Value::Array(messages));
    }
    for story in history.iter().rev() {
        if visible_gate(get(Some(story), "knowledge_gate")) {
            break;
        }
        let before = get(Some(story), "previous_view");
        if !js::truthy(before) {
            continue;
        }
        if let Some(Value::Object(concept)) = result.get_mut("campaignConcept") {
            if !js::present(defined(concept.get("story_quest_id"))) {
                concept.insert("story_quest_id".into(), or_undefined(get(before, "story_quest_id")));
            }
        }
        restore_objective(state, &mut result, before);
    }
    for quest in array(get(Some(memory), "quests")) {
        if history.iter().any(|story| strict_eq(get(Some(story), "quest_id"), get(Some(quest), "id"))) {
            continue;
        }
        for entry in spread_iter(coalesce(get(Some(quest), "knowledge_history"), None)).iter().rev() {
            if visible_gate(get(Some(entry), "knowledge_gate")) {
                break;
            }
            restore_objective(state, &mut result, get(Some(entry), "previous_view"));
        }
    }
    for key in ["scene", "adventure", "campaignConcept"] {
        if let Some(Value::Object(map)) = result.get_mut(key) {
            strip_undefined(map);
        }
    }
    Value::Object(result)
}

fn valid_id(id: Option<&Value>) -> bool {
    match id {
        Some(Value::String(id)) => sk_core::text::test(sk_core::re!(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$", "u"), id),
        _ => false,
    }
}

/// Причина невозможности поручения задаётся явно, а не выводится из
/// `entity_ids` (`normalizeQuestResponsibility`).
pub fn normalize_quest_responsibility(value: Option<&Value>) -> Option<Value> {
    if !js::truthy(value) {
        return None;
    }
    let schema = get(value, "schema_version");
    if js::present(schema) && !strict_eq(schema, Some(&json!(1))) {
        return None;
    }
    let kind = get(value, "type");
    let policy = get(value, "death_policy");
    if is_str(kind, "npc") && is_str(policy, "impossible") && valid_id(get(value, "npc_id")) {
        return Some(json!({ "schema_version": 1, "type": "npc", "npc_id": get(value, "npc_id"), "death_policy": "impossible" }));
    }
    if is_str(kind, "office") && is_str(policy, "transfer") && valid_id(get(value, "office_id")) {
        return Some(json!({ "schema_version": 1, "type": "office", "office_id": get(value, "office_id"), "death_policy": "transfer" }));
    }
    None
}

fn find_by_id<'a>(list: Option<&'a Value>, id: Option<&Value>) -> Option<&'a Value> {
    array(list).iter().find(|entry| strict_eq(get(Some(entry), "id"), id))
}

fn npc_world_entry<'a>(state: &'a Value, table: &str, id: &Value) -> Option<&'a Value> {
    crate::common::prop(get(get(Some(state), "npc_world"), table), &js_string(id))
}

/// Кто принимает поручение (`questGiverId`): `None` — `null` (или `undefined`
/// у личного поручения без `npc_id`).
pub fn quest_giver_id(state: &Value, responsibility: Option<&Value>) -> Option<Value> {
    if is_str(get(responsibility, "type"), "npc") {
        return get(responsibility, "npc_id").cloned();
    }
    let office = find_by_id(get(get(Some(state), "world_offices"), "offices"), get(responsibility, "office_id"));
    let id = get(office, "holder_npc_id");
    let npc = find_by_id(get(get(Some(state), "social"), "npcs"), id);
    let id = id.filter(|id| js::truthy(Some(id)))?;
    let npc = npc?;
    if js::is_false(get(Some(npc), "available"))
        || js::is_false(get(npc_world_entry(state, "vitals", id), "alive"))
        || is_str(get(npc_world_entry(state, "stances", id), "stance"), "dead")
    {
        return None;
    }
    Some(id.clone())
}

/// Стало ли поручение невыполнимым из-за смерти получателя (`questIsImpossible`).
pub fn quest_is_impossible(state: &Value, quest: Option<&Value>) -> bool {
    let Some(responsibility) = normalize_quest_responsibility(get(quest, "responsibility")) else {
        return false;
    };
    if !is_str(responsibility.get("type"), "npc") {
        return false;
    }
    let npc_id = &responsibility["npc_id"];
    js::is_false(get(npc_world_entry(state, "vitals", npc_id), "alive")) || is_str(get(npc_world_entry(state, "stances", npc_id), "stance"), "dead")
}

fn is_open_quest(quest: Option<&Value>) -> bool {
    let status = get(quest, "status");
    is_str(status, "active") || is_str(status, "offered")
}

/// Черновик `QuestInvalidated` по сохранённой смерти (`questInvalidationDraft`):
/// часы не заполняются, итог не придумывается. `options` — `{ primaryQuestId,
/// deathEvent }`, как в JS.
pub fn quest_invalidation_draft(state: &Value, quest: &Value, options: &Value) -> Option<Value> {
    if !is_open_quest(Some(quest)) || !quest_is_impossible(state, Some(quest)) {
        return None;
    }
    let primary_quest_id = coalesce(get(Some(options), "primaryQuestId"), Some(&Value::Null));
    let death_event = coalesce(get(Some(options), "deathEvent"), None);
    let npc_id = get(get(Some(quest), "responsibility"), "npc_id");
    let fact = array(get(get(Some(state), "worldMemory"), "facts")).iter().find(|entry| {
        strict_eq(get(Some(entry), "subject_id"), npc_id)
            && is_str(get(Some(entry), "predicate"), "died")
            && is_str(get(Some(entry), "status"), "active")
            && crate::common::length(get(Some(entry), "source_event_ids")).is_some_and(|length| length > 0)
    });
    let death_matches = is_str(get(death_event, "event_type"), "NpcDied") && strict_eq(get(get(death_event, "payload"), "npc_id"), npc_id);
    if fact.is_none() && !death_matches {
        return None;
    }
    let npc_name = find_by_id(get(get(Some(state), "social"), "npcs"), npc_id)
        .and_then(|npc| npc.get("name"))
        .filter(|name| js::truthy(Some(name)))
        .or(npc_id);
    let fact_sources = spread_iter(get(fact, "source_event_ids"));
    let cause = match death_event {
        Some(event) => event.clone(),
        None => {
            let mut cause = Map::new();
            cause.insert("event_type".into(), json!("NpcDied"));
            let mut payload = Map::new();
            if let Some(npc_id) = npc_id {
                payload.insert("npc_id".into(), npc_id.clone());
            }
            cause.insert("payload".into(), Value::Object(payload));
            if let Some(visibility) = get(fact, "visibility") {
                cause.insert("visibility".into(), visibility.clone());
            }
            if let Some(first) = fact_sources.first() {
                cause.insert("event_id".into(), first.clone());
            }
            Value::Object(cause)
        }
    };
    let quest_id = get(Some(quest), "id");
    let is_primary = strict_eq(quest_id, primary_quest_id);
    let mut payload = Map::new();
    payload.insert("schema_version".into(), json!(2));
    payload.insert("policy_id".into(), json!(QUEST_CONSEQUENCE_POLICY_ID));
    payload.insert("dependency_id".into(), Value::String(format!("{}:npc:{}", tpl(quest_id), tpl(npc_id))));
    payload.insert("knowledge_gate".into(), knowledge_gate_for_event(state, &cause));
    if is_primary {
        payload.insert("previous_view".into(), previous_view(state));
    }
    if let Some(id) = quest_id {
        payload.insert("quest_id".into(), id.clone());
    }
    payload.insert("outcome".into(), json!("failure"));
    payload.insert("reason".into(), json!("required_npc_dead"));
    if let Some(npc_id) = npc_id {
        payload.insert("npc_id".into(), npc_id.clone());
    }
    payload.insert(
        "summary".into(),
        Value::String(format!("Поручение «{}» стало невыполнимым: {} погиб.", tpl(get(Some(quest), "title")), tpl(npc_name))),
    );
    let death_id = get(death_event, "event_id").filter(|id| js::truthy(Some(id)));
    let sources = match death_id {
        Some(id) => vec![id.clone()],
        None => fact_sources,
    };
    payload.insert("source_event_ids".into(), Value::Array(sources));
    payload.insert("updates_scene_objective".into(), Value::Bool(is_primary));
    payload.insert("next_objective".into(), json!(NEXT_OBJECTIVE));
    Some(draft("QuestInvalidated", get(Some(quest), "visibility"), payload))
}

/// Части прежнего представления сцены: `String(scene.location_id || '')`,
/// `scene.objective || ''`, `adventure.currentHook || ''`,
/// `structuredClone(state.suggestions ?? [])`.
pub(crate) struct SceneView {
    pub location_id: Value,
    pub objective: Value,
    pub current_hook: Value,
    pub suggestions: Value,
}

pub(crate) fn scene_view(state: &Value) -> SceneView {
    let scene = get(Some(state), "scene");
    let truthy_or_empty = |value: Option<&Value>| value.filter(|value| js::truthy(Some(value))).cloned().unwrap_or_else(|| json!(""));
    SceneView {
        location_id: Value::String(s(get(scene, "location_id").filter(|value| js::truthy(Some(value))))),
        objective: truthy_or_empty(get(scene, "objective")),
        current_hook: truthy_or_empty(get(get(Some(state), "adventure"), "currentHook")),
        suggestions: coalesce(get(Some(state), "suggestions"), None).cloned().unwrap_or_else(|| json!([])),
    }
}

/// Прежнее представление сцены у невыполнимого поручения.
fn previous_view(state: &Value) -> Value {
    let view = scene_view(state);
    let mut map = Map::new();
    map.insert("location_id".into(), view.location_id);
    map.insert("objective".into(), view.objective);
    map.insert("current_hook".into(), view.current_hook);
    map.insert("suggestions".into(), view.suggestions);
    map.insert("replaced_objective".into(), json!(NEXT_OBJECTIVE));
    Value::Object(map)
}

fn draft(event_type: &str, visibility: Option<&Value>, payload: Map<String, Value>) -> Value {
    let mut event = Map::new();
    event.insert("event_type".into(), json!(event_type));
    if let Some(visibility) = visibility {
        event.insert("visibility".into(), visibility.clone());
    }
    event.insert("target_ids".into(), json!([]));
    event.insert("payload".into(), Value::Object(payload));
    Value::Object(event)
}

fn last_event_by<'a>(events: &'a [Value], types: &[&str], key: &str, id: Option<&Value>) -> Option<&'a Value> {
    events
        .iter()
        .rev()
        .find(|event| types.iter().any(|kind| is_str(get(Some(event), "event_type"), kind)) && strict_eq(get(get(Some(event), "payload"), key), id))
}

/// Последствия, которые выводятся один раз после фиксации смертей и смены
/// держателей должностей (`planQuestConsequenceDrafts`). `options` —
/// `{ primaryQuestId }`, как в JS.
pub fn plan_quest_consequence_drafts(state: &Value, events: &[Value], options: &Value) -> Vec<Value> {
    let primary = coalesce(get(Some(options), "primaryQuestId"), Some(&Value::Null)).cloned().unwrap_or(Value::Null);
    let mut result = Vec::new();
    for quest in array(get(get(Some(state), "worldMemory"), "quests")) {
        if !is_open_quest(Some(quest)) {
            continue;
        }
        let responsibility = normalize_quest_responsibility(get(Some(quest), "responsibility"));
        let kind = responsibility.as_ref().and_then(|value| value.get("type"));
        if is_str(kind, "npc") {
            let npc_id = responsibility.as_ref().and_then(|value| value.get("npc_id"));
            if let Some(death) = last_event_by(events, &["NpcDied"], "npc_id", npc_id) {
                let options = json!({ "primaryQuestId": primary, "deathEvent": death });
                if let Some(draft) = quest_invalidation_draft(state, quest, &options) {
                    result.push(draft);
                }
            }
        }
        if is_str(kind, "office") {
            let office_id = responsibility.as_ref().and_then(|value| value.get("office_id"));
            let Some(cause) = last_event_by(events, &["OfficeVacated", "OfficeHolderInstalled"], "office_id", office_id) else {
                continue;
            };
            let giver_id = quest_giver_id(state, responsibility.as_ref()).unwrap_or(Value::Null);
            let current = get(Some(quest), "giver_npc_id").filter(|value| js::truthy(Some(value))).cloned().unwrap_or(Value::Null);
            if strict_eq(Some(&current), Some(&giver_id)) {
                continue;
            }
            let office = find_by_id(get(get(Some(state), "world_offices"), "offices"), office_id);
            let name = find_by_id(get(get(Some(state), "social"), "npcs"), Some(&giver_id))
                .and_then(|npc| npc.get("name"))
                .filter(|name| js::truthy(Some(name)))
                .unwrap_or(&giver_id);
            let title = tpl(get(Some(quest), "title"));
            let office_title = tpl(get(office, "title"));
            let has_giver = js::truthy(Some(&giver_id));
            let mut payload = Map::new();
            payload.insert("schema_version".into(), json!(2));
            payload.insert("policy_id".into(), json!(QUEST_CONSEQUENCE_POLICY_ID));
            payload.insert("dependency_id".into(), Value::String(format!("{}:office:{}", tpl(get(Some(quest), "id")), tpl(office_id))));
            payload.insert("knowledge_gate".into(), knowledge_gate_for_event(state, cause));
            if let Some(id) = get(Some(quest), "id") {
                payload.insert("quest_id".into(), id.clone());
            }
            if let Some(id) = office_id {
                payload.insert("office_id".into(), id.clone());
            }
            payload.insert("giver_npc_id".into(), giver_id.clone());
            payload.insert("reason".into(), json!(if has_giver { "office_holder_changed" } else { "office_vacant" }));
            let sources: Vec<Value> = get(Some(cause), "event_id").filter(|id| js::truthy(Some(id))).cloned().into_iter().collect();
            payload.insert("source_event_ids".into(), Value::Array(sources));
            let summary = if has_giver {
                format!("По поручению «{title}» теперь принимает {} ({office_title}).", js_string(name))
            } else {
                format!("Поручение «{title}» сохраняется; должность «{office_title}» пока свободна.")
            };
            payload.insert("summary".into(), Value::String(summary));
            result.push(draft("QuestAssignmentChanged", get(Some(quest), "visibility"), payload));
        }
    }
    result
}

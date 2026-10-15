//! Ветки редьюсера `applyGameEventCurrent`: Сцена и карта: смена сцены, импорт карты, этажи, встреча и начало боя, перемещение, раскрытие, двери, взлом, объекты сцены, сущности. Задача Р4.
//!
//! JS: `server/rules-engine.mjs`, 24439–24509, 24519–24617, 24628–24695, 26059–26089, 26090–26113, 26458–26488, 26606–26608, 26609–26611, 26612–26621, 26622–26631, 26632–26635, 26636–26641, 26642–26659, 26663–26664, 26665–26671, 26672–26676, 26677–26678, 26679–26691, 26692–26698, 26699–26705, 26706–26712, 26713–26731, 26732–26749, 26750–26760, 26764–26774. Таблица меток — `reduce/table.rs`
//! (Р0). Перенося ветку, уберите её метки из [`UNPORTED`] этого файла.
//!
//! Помощники сцены — `scene/{placement,objects,levels}.rs`; карта сцены в
//! состоянии и подрайон боя — `sk-tactical`. Отказ карты (`TacticalMapError`)
//! обрывает ветку, как исключение JS обрывает `applyGameEvent`.
//! `publicAdventureMemory` (`adventure-director.mjs`, крейт `sk-director`) —
//! частная копия ниже.

use serde_json::{json, Map, Value};
use sk_core::game::{actor_id, combat_active, find_actor, is_party_summon, mechanics, mechanics_mut, replace_actor};
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::js::{self, is_true, s, safe_int, truthy};
use sk_core::text::{head, squash_spaces};
use sk_core::Event;
use sk_geometry::actor_footprint::footprint_cells_for;
use sk_tactical::combat_bounds::{ensure_scene_tactical_map, grow_combat_bounds, scene_tactical_map, sync_combat_bounds, write_scene_tactical_map};
use sk_tactical::tactical_map::{deserialize_tactical_map, legacy_cells_from_tactical_map, serialize_tactical_map, TacticalMap};

use super::conditions::{remove_summoned_actor, summon_cleanup};
use super::spells::normalize_actor_footprint_fields;
use super::world::{extra_coalesce, type_error};
use super::{scene_turn_and_round, target_of, Reduced};
use crate::constants::CREATURE_ENTITY_KINDS;
use crate::core::{battle_log_move_path, combat_actor_kind, plain_object, spread_value, unique_strings};
use crate::journal::{append_battle_log, Entry};
use crate::scene::levels::{npc_placements, npc_world_with_placements, remember_known_level, remembered_level_map, restore_level_entities, restore_scene_level_transitions, scene_level_label, scene_npc_occupied_cells, stash_level_entities};
use crate::scene::objects::{door_edge_blocks, door_trace_key, patch_scene_door, set_scene_door_state, set_scene_object_prop_state, set_scene_prop_at, update_scene_object_interaction};
use crate::scene::placement::{accepted_party_placement_entries, map_error, position_key, reveal_scene_cells, sync_scene_cells, used_cell_points, Placement};
use crate::scene_maps::{level_key, normalize_location_maps, remember_scene_map, scene_level_index, scene_location_id};
use crate::turn_economy::{action_economy, economy_of, set_economy, spend_combat_economy};

/// Метки событий этого файла, чьи ветки ещё не перенесены.
pub(super) const UNPORTED: &[&str] = &[];

/// `state.scene` как объект.
fn scene_object(state: &mut Value) -> Option<&mut Map<String, Value>> {
    state.get_mut("scene").and_then(Value::as_object_mut)
}

/// `{ ...player, ...position }` для героев с принятой позицией.
fn place_players(state: &mut Value, positions: &IndexMap<String, (i64, i64)>, clear_old: bool) {
    let Some(players) = state.get_mut("players").and_then(Value::as_array_mut) else { return };
    for player in players.iter_mut() {
        let position = positions.get(&actor_id(player)).copied();
        let Some(map) = player.as_object_mut() else { continue };
        if clear_old {
            map.shift_remove("x");
            map.shift_remove("y");
        }
        if let Some((x, y)) = position {
            map.insert("x".into(), Value::from(x));
            map.insert("y".into(), Value::from(y));
        }
    }
}

/// `Object.fromEntries(accepted.positions)`.
fn positions_object(positions: &IndexMap<String, (i64, i64)>) -> Map<String, Value> {
    positions.iter().map(|(id, (x, y))| (id.clone(), json!({ "x": x, "y": y }))).collect()
}

/// `state.mechanics.positions = { ...state.mechanics.positions, ...accepted }`.
fn merge_positions(state: &mut Value, positions: &IndexMap<String, (i64, i64)>) {
    let mut merged = spread_value(mechanics(state).get("positions"));
    for (id, position) in positions_object(positions) {
        merged.insert(id, position);
    }
    mechanics_mut(state).insert("positions".into(), Value::Object(merged));
}

/// `mechanics.combat` по умолчанию (`defaultMechanics().combat`).
fn default_combat() -> Value {
    json!({
        "active": false,
        "round": 0,
        "initiative": [],
        "active_index": -1,
        "action_economy": {},
        "reaction_window": null,
        "readied": {},
        "group_initiative": false,
        "turn_completed": [],
        "truce": null,
        "parley_attempts": 0,
    })
}

// --- память приключения (частная копия `adventure-director.mjs`) ------------

/// `OBJECTIVE_STATUSES` (`adventure-director.mjs`).
const OBJECTIVE_STATUSES: [&str; 4] = ["completed", "unresolved", "abandoned", "continued"];

/// Поля приключения, которые видит только ведущий (`privateAdventureBuckets`, 1256).
const PRIVATE_ADVENTURE_FIELDS: [&str; 18] = [
    "hidden_information",
    "hiddenInformation",
    "gm_only",
    "gmOnly",
    "gm_notes",
    "gmNotes",
    "npc_private",
    "npcPrivate",
    "private_notes",
    "privateNotes",
    "specific_player",
    "specificPlayer",
    "party",
    "secret",
    "secrets",
    "unrevealed",
    "true_state",
    "trueState",
];

/// `privateAdventureBuckets(value)` (1256).
fn private_adventure_buckets(value: Option<&Value>) -> Map<String, Value> {
    let Some(Value::Object(source)) = value else { return Map::new() };
    let mut buckets = Map::new();
    for key in PRIVATE_ADVENTURE_FIELDS {
        if let Some(field) = source.get(key) {
            buckets.insert(key.into(), field.clone());
        }
    }
    buckets
}

/// `text(value, maximum, fallback)` (`adventure-director.mjs`): пробелы JS
/// схлопнуты, края обрезаны.
fn adventure_text(value: &str, maximum: usize, fallback: &str) -> String {
    let normalized = squash_spaces(value);
    head(if normalized.is_empty() { fallback } else { &normalized }, maximum)
}

/// `publicText(value, maximum, fallback)`: только строки.
fn public_text(value: Option<&Value>, maximum: usize, fallback: &str) -> String {
    match value {
        Some(Value::String(text)) => adventure_text(text, maximum, fallback),
        _ => fallback.to_string(),
    }
}

/// `integer(value, fallback, minimum, maximum)`.
fn bounded_integer(value: Option<&Value>, fallback: i64, minimum: i64, maximum: i64) -> i64 {
    let number = js::number(value);
    if crate::core::is_safe_integer_f64(number) {
        (number as i64).clamp(minimum, maximum)
    } else {
        fallback
    }
}

/// `publicTextList(value, maximum, limit)`.
fn public_text_list(value: Option<&Value>, maximum: usize, limit: usize) -> Value {
    let mut unique: IndexSet<String> = IndexSet::new();
    for item in value.and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        if let Value::String(text) = item {
            let text = adventure_text(text, maximum, "");
            if !text.is_empty() {
                unique.insert(text);
            }
        }
    }
    let skip = unique.len().saturating_sub(limit);
    js::strings_value(unique.into_iter().skip(skip))
}

/// `publicHistoryEntry(value)`.
fn public_history_entry(value: &Value) -> Option<Value> {
    let source = value.as_object()?;
    let field = |key: &str| source.get(key);
    let mut entry = Map::new();
    entry.insert("chapter".into(), Value::from(bounded_integer(field("chapter"), 1, 1, 999)));
    entry.insert("title".into(), Value::String(public_text(field("title"), 80, "Предыдущая сцена")));
    entry.insert("location".into(), Value::String(public_text(field("location"), 120, "")));
    let location_id = public_text(field("location_id").filter(|value| !value.is_null()).or_else(|| field("locationId")), 120, "");
    if !location_id.is_empty() {
        entry.insert("location_id".into(), Value::String(location_id));
    }
    entry.insert("objective".into(), Value::String(public_text(field("objective"), 160, "")));
    entry.insert("outcome".into(), Value::String(public_text(field("outcome"), 240, "")));
    if let Some(Value::String(status)) = field("status") {
        if OBJECTIVE_STATUSES.contains(&status.as_str()) {
            entry.insert("status".into(), Value::String(status.clone()));
        }
    }
    Some(Value::Object(entry))
}

/// `publicAdventureMemory(value)` (`adventure-director.mjs`, 824) — частная
/// копия; заменить на `sk-director`.
pub(crate) fn public_adventure_memory(value: Option<&Value>) -> Map<String, Value> {
    let empty = Map::new();
    let source = value.and_then(Value::as_object).unwrap_or(&empty);
    let field = |key: &str| source.get(key);
    let mut memory = Map::new();
    memory.insert("chapter".into(), Value::from(bounded_integer(field("chapter"), 1, 1, 999)));
    let hook = public_text(field("currentHook"), 240, "");
    if !hook.is_empty() {
        memory.insert("currentHook".into(), Value::String(hook));
    }
    let transition = public_text(field("lastTransition"), 500, "");
    if !transition.is_empty() {
        memory.insert("lastTransition".into(), Value::String(transition));
    }
    memory.insert("unresolvedThreads".into(), public_text_list(field("unresolvedThreads"), 240, 20));
    memory.insert("visitedLocations".into(), public_text_list(field("visitedLocations"), 120, 50));
    memory.insert("visitedLocationIds".into(), public_text_list(field("visitedLocationIds"), 120, 50));
    let history: Vec<Value> = field("history").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]).iter().filter_map(public_history_entry).collect();
    let skip = history.len().saturating_sub(20);
    memory.insert("history".into(), Value::Array(history.into_iter().skip(skip).collect()));
    memory
}

// --- смена сцены, импорт карты, этажи --------------------------------------

/// `SceneAdvanced` (24439–24509).
pub(super) fn scene_advanced(state: &mut Value, event: &Event) -> Reduced {
    let payload = event.payload.clone();
    let previous_level = scene_level_index(state);
    if previous_level != 0 {
        let key = level_key(&scene_location_id(state), previous_level);
        let cells = state.get("scene").and_then(|scene| scene.get("cells")).cloned().unwrap_or(Value::Null);
        let map = state.get("scene").and_then(|scene| scene.get("map")).cloned();
        remember_scene_map(state, &key, &cells, map.as_ref());
        stash_level_entities(state, &key);
    }
    let scene = payload.get("scene").filter(|scene| plain_object(Some(scene))).cloned().unwrap_or_else(js::obj);
    state["scene"] = scene;
    let world_map = match payload.get("worldMap").filter(|map| plain_object(Some(map))) {
        Some(map) => map.clone(),
        None => {
            let mut probe = state.clone();
            match payload.get("scene") {
                Some(scene) => probe["scene"] = scene.clone(),
                None => js::delete(&mut probe, "scene"),
            }
            sk_geometry::world_map::ensure_campaign_world_map(&probe).map_err(|message| type_error(&message))?
        }
    };
    state["worldMap"] = world_map;
    if let Some(Value::Array(levels)) = payload.get("library_levels") {
        let library_location = scene_location_id(state);
        for level in levels {
            let index = safe_int(level.get("index"), 0);
            let Some(raw) = level.get("map").filter(|map| plain_object(Some(map))) else { continue };
            if library_location.is_empty() || index == 0 {
                continue;
            }
            let Ok(level_map) = deserialize_tactical_map(raw) else { continue };
            let Ok(serialized) = serialize_tactical_map(&level_map) else { continue };
            let cells = Value::Array(legacy_cells_from_tactical_map(&level_map));
            remember_scene_map(state, &level_key(&library_location, index), &cells, Some(&serialized));
        }
    }
    let adventure_source = match payload.get("adventure").filter(|adventure| plain_object(Some(adventure))) {
        Some(adventure) => Some(adventure.clone()),
        None => state.get("adventure").cloned(),
    };
    let mut adventure = private_adventure_buckets(state.get("adventure"));
    for (key, value) in public_adventure_memory(adventure_source.as_ref()) {
        adventure.insert(key, value);
    }
    state["adventure"] = Value::Object(adventure);
    let party = crate::scene::levels::party_ids(state);
    let scene_map = ensure_scene_tactical_map(state).map_err(map_error)?;
    let cells = state.get("scene").and_then(|scene| scene.get("cells")).cloned();
    let Placement { positions, used_cells } = accepted_party_placement_entries(state, payload.get("party_positions"), cells.as_ref(), scene_map.as_ref(), &IndexSet::new());
    reveal_scene_cells(state, &used_cell_points(&used_cells))?;
    sync_scene_cells(state);
    place_players(state, &positions, true);
    let mechanics = mechanics_mut(state);
    mechanics.insert("positions".into(), Value::Object(positions_object(&positions)));
    mechanics.insert("combat".into(), default_combat());
    mechanics.insert("encounter".into(), Value::Null);
    state["enemies"] = json!([]);
    let cleanup = summon_cleanup(&payload);
    let summons: Vec<String> = state.get("actors").and_then(Value::as_array).map(|actors| actors.iter().filter(|actor| is_party_summon(actor)).map(actor_id).collect()).unwrap_or_default();
    for summon in summons {
        remove_summoned_actor(state, &summon, cleanup);
    }
    let actors: Vec<Value> = state.get("actors").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().filter(|actor| !is_party_summon(actor)).collect();
    state["actors"] = Value::Array(actors);
    state["entities"] = json!([]);
    state["mapFeedback"] = json!([]);
    js::delete(state, "tacticalTurn");
    if state.get("agentInteraction").and_then(|interaction| interaction.get("status")).and_then(Value::as_str) == Some("resolved") {
        state["agentInteraction"] = Value::Null;
    }
    js::delete(state, "suggestions");
    let active = s(state.get("activePlayerId"));
    if !party.contains(&active) {
        let first = state.get("partyMemberIds").and_then(Value::as_array).and_then(|list| list.first()).filter(|value| !value.is_null()).cloned().unwrap_or_else(|| json!(""));
        state["activePlayerId"] = first;
    }
    Ok(())
}

/// `LocationMapImported` (24519–24617).
pub(super) fn location_map_imported(state: &mut Value, event: &Event) -> Reduced {
    let payload = event.payload.clone();
    let location_id = head(&s(payload.get("location_id")), 120);
    if location_id.is_empty() {
        return Ok(());
    }
    let preserve = is_true(payload.get("preserve_layout"));
    let mut maps: IndexMap<i64, TacticalMap> = IndexMap::new();
    for level in payload.get("levels").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        let Some(raw) = level.as_object().and_then(|level| level.get("map")) else { continue };
        if let Ok(map) = deserialize_tactical_map(raw) {
            maps.insert(safe_int(level.get("index"), 0), map);
        }
    }
    if !maps.contains_key(&0) {
        return Ok(());
    }
    let prefix = format!("{location_id}@L");
    let own = |key: &str| key == location_id || key.starts_with(&prefix);
    let kept: Map<String, Value> = normalize_location_maps(state.get("locationMaps")).into_iter().filter(|(key, _)| !own(key)).collect();
    state["locationMaps"] = Value::Object(kept);
    if !preserve {
        if let Some(stashes @ (Value::Object(_) | Value::Array(_))) = state.get("levelEntities").filter(|value| truthy(Some(value))) {
            let remaining: Map<String, Value> = spread_value(Some(stashes)).into_iter().filter(|(key, _)| !own(key)).collect();
            if remaining.is_empty() {
                js::delete(state, "levelEntities");
            } else {
                state["levelEntities"] = Value::Object(remaining);
            }
        }
        if let Some(Value::Object(known)) = state.get("locationLevels") {
            let mut known = known.clone();
            known.shift_remove(&location_id);
            state["locationLevels"] = Value::Object(known);
        }
    }
    let mut ordered: Vec<(i64, TacticalMap)> = maps.into_iter().collect();
    ordered.sort_by_key(|(index, _)| *index);
    for (index, map) in &ordered {
        let serialized = serialize_tactical_map(map).map_err(map_error)?;
        remember_scene_map(state, &level_key(&location_id, *index), &Value::Array(legacy_cells_from_tactical_map(map)), Some(&serialized));
    }
    let scene_ok = state.get("scene").is_some_and(|scene| scene.is_object() || scene.is_array());
    if !is_true(payload.get("applied_to_scene")) || scene_location_id(state) != location_id || !scene_ok {
        return Ok(());
    }
    let previous = scene_level_index(state);
    let has_previous = ordered.iter().any(|(index, _)| *index == previous);
    let active = if preserve && has_previous { previous } else { 0 };
    let Some(ground) = ordered.iter().find(|(index, _)| *index == active).or_else(|| ordered.iter().find(|(index, _)| *index == 0)).map(|(_, map)| map.clone()) else {
        return Ok(());
    };
    let stored_label = head(&ground.level_label, 120);
    let label = if stored_label.is_empty() { scene_level_label(state, active, "") } else { stored_label };
    if let Some(scene) = scene_object(state) {
        scene.insert("level".into(), json!({ "index": active, "label": label }));
    }
    write_scene_tactical_map(state, &ground).map_err(map_error)?;
    if !preserve {
        let elsewhere: Vec<Value> = npc_placements(state).into_iter().filter(|placement| s(placement.get("location_id")) != location_id).collect();
        let world = npc_world_with_placements(state.get("npc_world"), &elsewhere);
        state["npc_world"] = world;
    }
    let mut relocated: IndexSet<String> = IndexSet::new();
    let mut removed_entities: IndexSet<String> = IndexSet::new();
    for relocation in payload.get("relocations").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        let id = s(relocation.get("id"));
        if id.is_empty() {
            continue;
        }
        let removed = is_true(relocation.get("removed"));
        let x = safe_int(relocation.get("x"), -1);
        let y = safe_int(relocation.get("y"), -1);
        if relocation.get("kind").and_then(Value::as_str) == Some("entity") {
            if removed {
                removed_entities.insert(id);
                continue;
            }
            if x < 0 || y < 0 {
                continue;
            }
            let entities: Vec<Value> = state
                .get("entities")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|entity| if js::string(entity.get("id")) == id { js::spread(&entity, json!({ "x": x, "y": y })) } else { entity })
                .collect();
            state["entities"] = Value::Array(entities);
            continue;
        }
        if removed {
            if let Some(positions) = mechanics_mut(state).get_mut("positions").and_then(Value::as_object_mut) {
                positions.shift_remove(&id);
            }
            let enemies: Vec<Value> = state.get("enemies").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().filter(|enemy| actor_id(enemy) != id).collect();
            state["enemies"] = Value::Array(enemies);
            continue;
        }
        if x < 0 || y < 0 {
            continue;
        }
        js::object_mut(&mut *mechanics_value(state), "positions").insert(id.clone(), json!({ "x": x, "y": y }));
        replace_actor(state, &id, |actor| {
            if let Some(map) = actor.as_object_mut() {
                map.insert("x".into(), Value::from(x));
                map.insert("y".into(), Value::from(y));
            }
        });
        let anchor = json!({ "x": x, "y": y });
        for cell in footprint_cells_for(find_actor(state, &id), Some(&anchor)) {
            relocated.insert(position_key(cell.x, cell.y));
        }
    }
    if !removed_entities.is_empty() {
        let entities: Vec<Value> = state.get("entities").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().filter(|entity| !removed_entities.contains(&js::string(entity.get("id")))).collect();
        state["entities"] = Value::Array(entities);
    }
    let level_map = scene_tactical_map(state);
    let cells = state.get("scene").and_then(|scene| scene.get("cells")).cloned();
    let accepted = accepted_party_placement_entries(state, payload.get("party_positions"), cells.as_ref(), level_map.as_ref(), &relocated);
    reveal_scene_cells(state, &used_cell_points(&accepted.used_cells))?;
    place_players(state, &accepted.positions, false);
    merge_positions(state, &accepted.positions);
    if let Some(requirements) = payload.get("map_requirements").filter(|value| truthy(Some(value)) && (value.is_object() || value.is_array())) {
        if let Some(scene) = scene_object(state) {
            scene.insert("map_requirements".into(), requirements.clone());
        }
    }
    if is_true(payload.get("clear_library_source")) {
        if let Some(scene) = scene_object(state) {
            scene.shift_remove("map_source");
            scene.shift_remove("layout");
        }
    }
    if !preserve {
        state["mapFeedback"] = json!([]);
        let label = s(state.get("scene").and_then(|scene| scene.get("level")).and_then(|level| level.get("label")));
        remember_known_level(state, &location_id, 0, &label);
    }
    Ok(())
}

/// `state.mechanics` как значение (создаётся, если его нет).
fn mechanics_value(state: &mut Value) -> &mut Value {
    if !state.get("mechanics").is_some_and(Value::is_object) {
        state["mechanics"] = js::obj();
    }
    &mut state["mechanics"]
}

/// `MapLevelChanged` (24628–24695).
pub(super) fn map_level_changed(state: &mut Value, event: &Event) -> Reduced {
    if !state.get("scene").is_some_and(Value::is_object) {
        return Ok(());
    }
    let payload = event.payload.clone();
    let requested = s(payload.get("location_id"));
    let location_id = if requested.is_empty() { scene_location_id(state) } else { requested };
    let from_level = safe_int(payload.get("from_level"), scene_level_index(state));
    let to_level = safe_int(payload.get("to_level"), from_level);
    if from_level == to_level {
        return Ok(());
    }
    let mut target = payload.get("map").filter(|map| plain_object(Some(map))).and_then(|map| deserialize_tactical_map(map).ok());
    if target.is_none() {
        target = remembered_level_map(state, &location_id, to_level).map_err(map_error)?;
    }
    let Some(target) = target else { return Ok(()) };
    if let Some(mut leaving) = ensure_scene_tactical_map(state).map_err(map_error)? {
        if restore_scene_level_transitions(state, &mut leaving) {
            write_scene_tactical_map(state, &leaving).map_err(map_error)?;
        }
    }
    let from_key = level_key(&location_id, from_level);
    let cells = state.get("scene").and_then(|scene| scene.get("cells")).cloned().unwrap_or(Value::Null);
    let map = state.get("scene").and_then(|scene| scene.get("map")).cloned();
    remember_scene_map(state, &from_key, &cells, map.as_ref());
    stash_level_entities(state, &from_key);
    let requested_label = head(&s(payload.get("level_label")), 120);
    let label = if requested_label.is_empty() { scene_level_label(state, to_level, "") } else { requested_label };
    if let Some(scene) = scene_object(state) {
        scene.insert("level".into(), json!({ "index": to_level, "label": label }));
    }
    write_scene_tactical_map(state, &target).map_err(map_error)?;
    restore_level_entities(state, &level_key(&location_id, to_level));
    let level_map = scene_tactical_map(state);
    let mut occupied: IndexSet<String> = scene_npc_occupied_cells(state);
    let enemies = state.get("enemies").and_then(Value::as_array).cloned().unwrap_or_default();
    let summons: Vec<Value> = state.get("actors").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().filter(is_party_summon).collect();
    for actor in enemies.iter().chain(summons.iter()) {
        for key in crate::scene::levels::actor_cells_at(state, &actor_id(actor)) {
            occupied.insert(key);
        }
    }
    for entity in state.get("entities").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        if !CREATURE_ENTITY_KINDS.contains(&js::string(entity.get("kind")).as_str()) {
            continue;
        }
        let x = js::number(entity.get("x"));
        let y = js::number(entity.get("y"));
        if !crate::core::is_safe_integer_f64(x) || !crate::core::is_safe_integer_f64(y) {
            continue;
        }
        for cell in footprint_cells_for(Some(entity), Some(&json!({ "x": x as i64, "y": y as i64 }))) {
            occupied.insert(position_key(cell.x, cell.y));
        }
    }
    let cells = state.get("scene").and_then(|scene| scene.get("cells")).cloned();
    let accepted = accepted_party_placement_entries(state, payload.get("party_positions"), cells.as_ref(), level_map.as_ref(), &occupied);
    reveal_scene_cells(state, &used_cell_points(&accepted.used_cells))?;
    place_players(state, &accepted.positions, false);
    merge_positions(state, &accepted.positions);
    state["mapFeedback"] = json!([]);
    remember_known_level(state, &location_id, to_level, &label);
    Ok(())
}

// --- встреча, бой, перемещение ---------------------------------------------

/// `encounterWithoutLoadouts(encounter)` (1903): состав встречи без инвентарей.
fn encounter_without_loadouts(encounter: &Value) -> Value {
    let mut copy = encounter.clone();
    if let Some(Value::Array(enemies)) = copy.get_mut("enemies") {
        for enemy in enemies.iter_mut() {
            if let Some(map) = enemy.as_object_mut() {
                map.shift_remove("loadout");
            }
        }
    }
    copy
}

/// `EncounterCreated` (26059–26089).
pub(super) fn encounter_created(state: &mut Value, event: &Event) -> Reduced {
    let payload = event.payload.clone();
    let encounter = payload.get("encounter").filter(|value| truthy(Some(value)) && (value.is_object() || value.is_array())).cloned().unwrap_or_else(js::obj);
    let old_enemies: IndexSet<String> = state.get("enemies").and_then(Value::as_array).map(|enemies| enemies.iter().map(actor_id).collect()).unwrap_or_default();
    let kept: Map<String, Value> = spread_value(mechanics(state).get("positions")).into_iter().filter(|(id, _)| !old_enemies.contains(id)).collect();
    mechanics_mut(state).insert("positions".into(), Value::Object(kept));
    let enemies: Vec<Value> = encounter
        .get("enemies")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .map(|enemy| {
            let mut fields = spread_value(Some(enemy));
            fields.insert("alive".into(), Value::Bool(true));
            fields.insert("loadout".into(), sk_economy::enemy_loadouts::normalize_enemy_loadout(enemy.get("loadout")));
            normalize_actor_footprint_fields(Value::Object(fields))
        })
        .collect();
    state["enemies"] = Value::Array(enemies.clone());
    let authored: IndexSet<String> = enemies.iter().map(|enemy| s(enemy.get("origin").and_then(|origin| origin.get("npc_id")))).filter(|id| !id.is_empty()).collect();
    let legacy_identity = payload.get("authored_npc_identity_schema_version").and_then(Value::as_f64) != Some(1.0);
    if !authored.is_empty() && legacy_identity {
        let unavailable = |list: Option<&Value>| -> Option<Value> {
            let items = list?.as_array()?;
            Some(Value::Array(items.iter().map(|entry| if authored.contains(&js::string(entry.get("id"))) { js::spread(entry, json!({ "available": false })) } else { entry.clone() }).collect()))
        };
        let npcs = unavailable(state.get("social").and_then(|social| social.get("npcs")));
        if let (Some(npcs), Some(social)) = (npcs, state.get_mut("social").and_then(Value::as_object_mut)) {
            social.insert("npcs".into(), npcs);
        }
        if let Some(merchants) = unavailable(state.get("merchants")) {
            state["merchants"] = merchants;
        }
    }
    for enemy in &enemies {
        let id = actor_id(enemy);
        let position = json!({ "x": safe_int(enemy.get("x"), 0), "y": safe_int(enemy.get("y"), 0) });
        js::object_mut(mechanics_value(state), "positions").insert(id, position);
    }
    let pick = |keys: &[&Value]| -> String {
        keys.iter().filter_map(|value| Some(*value).filter(|value| !value.is_null())).next().map_or_else(String::new, |value| js::string(Some(value)))
    };
    let field = |key: &str| encounter.get(key).unwrap_or(&Value::Null);
    let fallback = payload.get("encounter_id").unwrap_or(&Value::Null);
    let id = pick(&[field("id"), field("encounter_id"), fallback]);
    let encounter_id = pick(&[field("encounter_id"), field("id"), fallback]);
    let enemy_ids: Vec<String> = enemies.iter().map(actor_id).collect();
    let mut staged = spread_value(Some(&encounter_without_loadouts(&encounter)));
    staged.insert("id".into(), Value::String(id.clone()));
    staged.insert("encounter_id".into(), Value::String(encounter_id));
    staged.insert("status".into(), json!("staged"));
    staged.insert("enemy_ids".into(), js::strings_value(enemy_ids.clone()));
    mechanics_mut(state).insert("encounter".into(), Value::Object(staged));
    let entry = Entry::new()
        .set("type", "encounter-created")
        .set("encounterId", id)
        .set("participantIds", js::strings_value(enemy_ids))
        .opt("difficulty", encounter.get("difficulty").cloned())
        .opt("theme", encounter.get("theme").cloned())
        .build();
    append_battle_log(state, event, entry);
    Ok(())
}

/// `CombatStarted` (26090–26113).
pub(super) fn combat_started(state: &mut Value, event: &Event) -> Reduced {
    let payload = event.payload.clone();
    let initiative = payload.get("initiative").filter(|value| !value.is_null()).cloned().unwrap_or_else(|| json!([]));
    let entries: Vec<Value> = match &initiative {
        Value::Array(entries) => entries.clone(),
        _ => return Err(type_error("payload.initiative.map is not a function")),
    };
    let mut economy = Map::new();
    for entry in &entries {
        economy.insert(js::string(entry.get("actor_id")), action_economy());
    }
    let mut combat = Map::new();
    combat.insert("active".into(), json!(true));
    combat.insert("round".into(), Value::from(safe_int(payload.get("round"), 1)));
    combat.insert("initiative".into(), initiative);
    combat.insert("active_index".into(), Value::from(safe_int(payload.get("active_index"), -1)));
    if truthy(payload.get("combat_instance_id")) {
        combat.insert("combat_instance_id".into(), Value::String(js::string(payload.get("combat_instance_id"))));
    }
    combat.insert("action_economy".into(), Value::Object(economy));
    combat.insert("reaction_window".into(), Value::Null);
    combat.insert("readied".into(), js::obj());
    combat.insert("group_initiative".into(), Value::Bool(is_true(payload.get("group_initiative"))));
    combat.insert("turn_completed".into(), json!([]));
    combat.insert("truce".into(), Value::Null);
    combat.insert("parley_attempts".into(), json!(0));
    mechanics_mut(state).insert("combat".into(), Value::Object(combat));
    let ids: Vec<String> = entries.iter().map(|entry| js::string(entry.get("actor_id"))).collect();
    sync_combat_bounds(state, &ids).map_err(map_error)?;
    let staged = mechanics(state).get("encounter").filter(|encounter| truthy(Some(encounter))).and_then(|encounter| encounter.get("status")).and_then(Value::as_str) == Some("staged");
    if staged {
        let started = extra_coalesce(event, &["occurred_at", "created_at"]);
        let encounter = mechanics(state).get("encounter").cloned().unwrap_or(Value::Null);
        mechanics_mut(state).insert("encounter".into(), js::spread(&encounter, json!({ "status": "active", "started_at": started })));
    }
    let targets = crate::core::unique_string_list(&event.target_ids);
    let entry = Entry::new().set("type", "combat-start").set("round", safe_int(payload.get("round"), 1)).set("participantIds", js::strings_value(targets)).build();
    append_battle_log(state, event, entry);
    Ok(())
}

/// `ActorMoved` (26458–26488).
pub(super) fn actor_moved(state: &mut Value, event: &Event) -> Reduced {
    let target = target_of(event);
    let payload = event.payload.clone();
    let to = payload.get("to").cloned();
    {
        let positions = js::object_mut(mechanics_value(state), "positions");
        match &to {
            Some(to) => {
                positions.insert(target.clone(), to.clone());
            }
            None => {
                positions.shift_remove(&target);
            }
        }
    }
    grow_combat_bounds(state, to.as_ref(), Some(target.as_str()).filter(|id| !id.is_empty())).map_err(map_error)?;
    let finite = |key: &str| to.as_ref().and_then(|to| to.get(key)).map(|value| js::number(Some(value))).filter(|value| value.is_finite());
    if truthy(to.as_ref()) {
        if let (Some(x), Some(y)) = (finite("x"), finite("y")) {
            replace_actor(state, &target, |actor| {
                if let Some(map) = actor.as_object_mut() {
                    map.insert("x".into(), js::num(x));
                    map.insert("y".into(), js::num(y));
                }
            });
        }
    }
    let actor = event.actor_id.clone().filter(|id| !id.is_empty());
    if let Some(actor) = actor.as_ref().filter(|_| combat_active(state) && !js::is_false(payload.get("spend_movement"))) {
        let economy = economy_of(state, actor);
        let prior = economy.get("movement_path").and_then(Value::as_array).cloned().unwrap_or_default();
        let segment: Vec<Value> = match payload.get("path") {
            Some(Value::Array(path)) => path.clone(),
            _ if truthy(to.as_ref()) => vec![to.clone().unwrap_or(Value::Null)],
            _ => Vec::new(),
        };
        let path: Vec<Value> = if prior.is_empty() {
            let from = payload.get("from").filter(|from| truthy(Some(from))).cloned().unwrap_or(Value::Null);
            std::iter::once(from).chain(segment).filter(|point| truthy(Some(point))).collect()
        } else {
            prior.into_iter().chain(segment).collect()
        };
        let spent = safe_int(payload.get("movement_spent"), safe_int(economy.get("movement_spent"), 0) + safe_int(payload.get("distance"), 0)).max(0);
        let mut patch = json!({
            "movement_spent": spent,
            "movement_path": path,
            "movement": safe_int(payload.get("movement_remaining"), 0) > 0,
        });
        if payload.get("monster_ability").and_then(Value::as_str) == Some("aggressive") {
            patch["bonus_action"] = Value::Bool(false);
        }
        set_economy(state, actor, js::spread(&economy, patch));
    }
    let (scene_turn, round) = scene_turn_and_round(state);
    let kind = combat_actor_kind(state, event.actor_id.as_deref().unwrap_or_default());
    let mut entry = Entry::new()
        .set("sceneTurn", scene_turn)
        .set("round", round)
        .set("type", "move")
        .opt("actorId", event.actor_id.clone())
        .set("actorKind", kind)
        .opt("from", payload.get("from").cloned())
        .opt("to", to)
        .set("distanceFeet", safe_int(payload.get("distance"), 0));
    if let Some(path) = battle_log_move_path(Some(&payload)) {
        entry = entry.set("path", Value::Array(path));
    }
    if is_true(payload.get("teleport")) {
        entry = entry.set("teleport", true);
    }
    append_battle_log(state, event, entry.build());
    Ok(())
}

// --- раскрытие, двери, объекты сцены ---------------------------------------

/// `AreaRevealed` (26606–26608).
pub(super) fn area_revealed(state: &mut Value, event: &Event) -> Reduced {
    let cells = event.payload.get("cells").and_then(Value::as_array).cloned().unwrap_or_default();
    reveal_scene_cells(state, &cells)
}

/// `DoorStateChanged` (26609–26611).
pub(super) fn door_state_changed(state: &mut Value, event: &Event) -> Reduced {
    let payload = event.payload.clone();
    set_scene_door_state(state, payload.get("door_id"), payload.get("state"))
}

/// `spendCombatEconomy(state, event.actor_id, 'action')`.
fn spend_action(state: &mut Value, event: &Event) {
    spend_combat_economy(state, event.actor_id.as_deref().unwrap_or_default(), "action", false, false);
}

/// `DoorBarricaded` (26612–26621).
pub(super) fn door_barricaded(state: &mut Value, event: &Event) -> Reduced {
    let payload = event.payload.clone();
    let actor = event.actor_id.clone().unwrap_or_default();
    patch_scene_door(state, payload.get("door_id"), |door| {
        let barricade = json!({
            "material_item_id": s(payload.get("material_item_id")),
            "actor_id": actor,
            "previous_state": payload.get("previous_state").filter(|value| !value.is_null()).map_or_else(|| "open".to_string(), |value| js::string(Some(value))),
            "side_x": safe_int(payload.get("side_x"), door.x),
            "side_y": safe_int(payload.get("side_y"), door.y),
        });
        Some(json!({ "barricade": barricade, "blocksMove": true, "blocksSight": true }))
    })?;
    spend_action(state, event);
    Ok(())
}

/// `DoorBarricadeCleared` (26622–26631).
pub(super) fn door_barricade_cleared(state: &mut Value, event: &Event) -> Reduced {
    let payload = event.payload.clone();
    let restored = payload.get("restored_state");
    let blocks = door_edge_blocks(restored);
    let restored_state = restored.filter(|value| !value.is_null()).map_or_else(|| "open".to_string(), |value| js::string(Some(value)));
    patch_scene_door(state, payload.get("door_id"), |_| Some(json!({ "barricade": null, "state": restored_state, "blocksMove": blocks, "blocksSight": blocks })))?;
    spend_action(state, event);
    Ok(())
}

/// `DoorBarricadeForced` (26632–26635).
pub(super) fn door_barricade_forced(state: &mut Value, event: &Event) -> Reduced {
    spend_action(state, event);
    Ok(())
}

/// `DoorForced` (26636–26641).
pub(super) fn door_forced(state: &mut Value, event: &Event) -> Reduced {
    spend_action(state, event);
    if is_true(event.payload.get("success")) {
        set_scene_door_state(state, event.payload.get("door_id"), Some(&json!("broken")))?;
    }
    Ok(())
}

/// `last_actor_id: event.actor_id == null ? current.last_actor_id : String(event.actor_id).slice(0, 120)`.
fn last_actor(current: &Map<String, Value>, event: &Event, key: &str) -> Option<Value> {
    match &event.actor_id {
        Some(actor) => Some(Value::String(head(actor, 120))),
        None => current.get(key).cloned(),
    }
}

/// Поле записи взаимодействия, которое JS ставит значением или `undefined`.
fn put(record: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    match value {
        Some(value) => {
            record.insert(key.into(), value);
        }
        None => {
            record.shift_remove(key);
        }
    }
}

/// `current.flag || condition`.
fn flag_or(current: &Map<String, Value>, key: &str, condition: bool) -> Value {
    match current.get(key).filter(|value| truthy(Some(value))) {
        Some(value) => value.clone(),
        None => Value::Bool(condition),
    }
}

/// `uniqueStrings([...(current[key] ?? []), value])` для записи взаимодействия.
fn append_unique(current: &Map<String, Value>, key: &str, value: String) -> Value {
    let mut list = current.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
    list.push(Value::String(value));
    js::strings_value(unique_strings(Some(&Value::Array(list))))
}

/// `String(event.actor_id)` для списков (`uniqueStrings([..., event.actor_id])`).
fn actor_string(event: &Event) -> String {
    event.actor_id.clone().unwrap_or_else(|| "null".into())
}

/// `DoorLockpicked` (26642–26659).
pub(super) fn door_lockpicked(state: &mut Value, event: &Event) -> Reduced {
    spend_action(state, event);
    if !is_true(event.payload.get("success")) {
        return Ok(());
    }
    set_scene_door_state(state, event.payload.get("door_id"), Some(&json!("open")))?;
    update_scene_object_interaction(state, &door_trace_key(event.payload.get("door_id")), |mut current| {
        current.insert("state".into(), json!("lockpicked"));
        current.insert("lockpicked".into(), json!(true));
        let by = last_actor(&current, event, "lockpicked_by");
        put(&mut current, "lockpicked_by", by);
        let last = last_actor(&current, event, "last_actor_id");
        put(&mut current, "last_actor_id", last);
        current
    });
    Ok(())
}

/// `LockpickNoticed` (26663–26664): след в летописи, не в механике.
pub(super) fn lockpick_noticed(_state: &mut Value, _event: &Event) -> Reduced {
    Ok(())
}

/// Обновление записи с одним только `last_actor_id`.
fn touch_interaction(state: &mut Value, event: &Event, extra: impl FnOnce(&mut Map<String, Value>)) -> Option<Value> {
    let prop = s(event.payload.get("prop_id"));
    update_scene_object_interaction(state, &prop, |mut current| {
        extra(&mut current);
        let last = last_actor(&current, event, "last_actor_id");
        put(&mut current, "last_actor_id", last);
        current
    })
}

/// `SceneObjectOperated` (26665–26671).
pub(super) fn scene_object_operated(state: &mut Value, event: &Event) -> Reduced {
    touch_interaction(state, event, |_| {});
    if is_true(event.payload.get("action_spent")) {
        spend_action(state, event);
    }
    Ok(())
}

/// `ScenarioKnightHeadReturned` (26672–26676): загадка — в реестре рыцаря.
pub(super) fn scenario_knight_head_returned(state: &mut Value, event: &Event) -> Reduced {
    if is_true(event.payload.get("action_spent")) {
        spend_action(state, event);
    }
    Ok(())
}

/// `SceneObjectCheckResolved` (26677–26678).
pub(super) fn scene_object_check_resolved(_state: &mut Value, _event: &Event) -> Reduced {
    Ok(())
}

/// `SceneObjectInspected` (26679–26691).
pub(super) fn scene_object_inspected(state: &mut Value, event: &Event) -> Reduced {
    let success = is_true(event.payload.get("success"));
    let trap = is_true(event.payload.get("trap_detected"));
    let actor = actor_string(event);
    touch_interaction(state, event, |current| {
        current.insert("inspection_attempted".into(), json!(true));
        let attempted = append_unique(current, "inspection_attempted_by", actor);
        current.insert("inspection_attempted_by".into(), attempted);
        let inspected = flag_or(current, "inspected", success);
        current.insert("inspected".into(), inspected);
        let detected = flag_or(current, "trap_detected", trap);
        current.insert("trap_detected".into(), detected);
    });
    Ok(())
}

/// `SceneObjectUseRecorded` (26692–26698).
pub(super) fn scene_object_use_recorded(state: &mut Value, event: &Event) -> Reduced {
    let actor = actor_string(event);
    touch_interaction(state, event, |current| {
        let used_by = append_unique(current, "used_by", actor);
        current.insert("used_by".into(), used_by);
    });
    Ok(())
}

/// `SceneObjectKnowledgeRevealed` (26699–26705).
pub(super) fn scene_object_knowledge_revealed(state: &mut Value, event: &Event) -> Reduced {
    let knowledge = js::string(event.payload.get("knowledge_id"));
    touch_interaction(state, event, |current| {
        let ids = append_unique(current, "knowledge_ids", knowledge);
        let ids: Vec<Value> = ids.as_array().cloned().unwrap_or_default().into_iter().take(24).collect();
        current.insert("knowledge_ids".into(), Value::Array(ids));
    });
    Ok(())
}

/// `SceneObjectLootRevealed` (26706–26712).
pub(super) fn scene_object_loot_revealed(state: &mut Value, event: &Event) -> Reduced {
    touch_interaction(state, event, |current| {
        current.insert("loot_revealed".into(), json!(true));
    });
    Ok(())
}

/// `SceneObjectStateChanged` (26713–26731).
pub(super) fn scene_object_state_changed(state: &mut Value, event: &Event) -> Reduced {
    let payload = event.payload.clone();
    let wanted = payload.get("state").and_then(Value::as_str).map(str::to_string);
    let lockpicked = is_true(payload.get("lockpicked"));
    let next = touch_interaction(state, event, |current| {
        let source = payload.get("state").filter(|value| !value.is_null()).or_else(|| current.get("state"));
        current.insert("state".into(), Value::String(head(&js::string(source), 40)));
        for (key, value) in [("opened", "open"), ("taken", "taken"), ("used", "used")] {
            let flag = flag_or(current, key, wanted.as_deref() == Some(value));
            current.insert(key.into(), flag);
        }
        let picked = flag_or(current, "lockpicked", lockpicked);
        current.insert("lockpicked".into(), picked);
        let by = match (&event.actor_id, lockpicked) {
            (Some(actor), true) => Some(Value::String(head(actor, 120))),
            _ => current.get("lockpicked_by").cloned(),
        };
        put(current, "lockpicked_by", by);
    });
    if let Some(next) = next {
        if !js::is_false(payload.get("success")) {
            set_scene_object_prop_state(state, payload.get("prop_id"), next.get("state"))?;
        }
    }
    Ok(())
}

/// `SceneObjectLootGranted` (26732–26749).
pub(super) fn scene_object_loot_granted(state: &mut Value, event: &Event) -> Reduced {
    touch_interaction(state, event, |current| {
        current.insert("loot_claimed".into(), json!(true));
        current.insert("taken".into(), json!(true));
    });
    let loot = event.payload.get("loot").and_then(Value::as_array).cloned().unwrap_or_default();
    let target = target_of(event);
    replace_actor(state, &target, |actor| {
        let mut inventory = actor.get("inventory").and_then(Value::as_array).cloned().unwrap_or_default();
        let existing: IndexSet<String> = inventory.iter().map(|item| s(item.get("id"))).collect();
        inventory.extend(loot.iter().filter(|item| truthy(item.get("id")) && !existing.contains(&js::string(item.get("id")))).cloned());
        if let Some(map) = actor.as_object_mut() {
            map.insert("inventory".into(), Value::Array(inventory));
        }
    });
    Ok(())
}

/// `SceneObjectEffectApplied` (26750–26760).
pub(super) fn scene_object_effect_applied(state: &mut Value, event: &Event) -> Reduced {
    touch_interaction(state, event, |current| {
        current.insert("used".into(), json!(true));
    });
    let target = target_of(event);
    let temporary = js::object_mut(mechanics_value(state), "temporary_hp");
    let before = safe_int(temporary.get(&target), 0).max(0);
    let after = safe_int(event.payload.get("temporary_hp_after"), 0).max(0);
    temporary.insert(target, Value::from(before.max(after)));
    Ok(())
}

/// `EntitySpawned` (26764–26774): существо карты не меняет, предмет — да.
pub(super) fn entity_spawned(state: &mut Value, event: &Event) -> Reduced {
    let entity = event.payload.get("entity").filter(|value| !value.is_null()).cloned().unwrap_or_else(js::obj);
    // `{ x: entity.x, y: entity.y }`: отсутствующее поле — `undefined` (NaN),
    // а не `null` (0).
    let mut point = Map::new();
    for key in ["x", "y"] {
        if let Some(value) = entity.get(key) {
            point.insert(key.into(), value.clone());
        }
    }
    reveal_scene_cells(state, &[Value::Object(point)])?;
    if let Some(kind) = entity.get("kind").filter(|kind| !kind.is_null()) {
        if !CREATURE_ENTITY_KINDS.contains(&js::string(Some(kind)).as_str()) {
            set_scene_prop_at(state, entity.get("x"), entity.get("y"), kind)?;
        }
    }
    let mut entities = state.get("entities").and_then(Value::as_array).cloned().unwrap_or_default();
    entities.push(entity);
    state["entities"] = Value::Array(entities);
    Ok(())
}

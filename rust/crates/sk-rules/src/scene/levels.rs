//! Уровни карты: этажи, переходы, тайники уровней. Задача Р4.
//!
//! JS: `server/rules-engine.mjs`, 2418–2710.
//!
//! Перенесено то, что зовёт редьюсер: заявленные этажи сцены, починка
//! привязок лестниц, подпись этажа, запомненная карта этажа, стэш жителей
//! покидаемого этажа и их возвращение, известные отряду этажи. Расстановка
//! отряда на целевом этаже (`levelArrivalPositions`) и план переезда при
//! замене карты (`planImportRelocations`) читают разбор команды — их
//! перенесёт задача сцены (Р6).
//!
//! Подпись этажа — `levelLabelFor` крейта `sk-world-time`, память мест —
//! `sk-director` (через `scene_maps`).
//! Мир NPC — крейт `sk-npc-world` (`normalizeNpcWorldState`,
//! `sceneNpcOccupiedCells`).

use serde_json::{json, Map, Value};
use sk_core::game::{is_party_summon, mechanics_mut};
use sk_core::indexmap::IndexSet;
use sk_core::js::{self, s};
use sk_core::text::{head, locale_compare, squash_spaces};
use sk_geometry::actor_footprint::footprint_cells_for;
use sk_tactical::tactical_map::{attach_level_transitions, deserialize_tactical_map, tactical_map_from_legacy_cells, LegacyMapOptions, TacticalMap};

use crate::scene_maps::{level_key, scene_location_id, scene_map_for_location, scene_tactical_map_for_location};

/// `MAX_LEVEL_STASHES`: сколько стэшей неактивных этажей держит состояние.
pub const MAX_LEVEL_STASHES: usize = 32;

/// `declaredSceneLevels(state)` (2424).
pub fn declared_scene_levels(state: &Value) -> Vec<Value> {
    state.get("scene").and_then(|scene| scene.get("levels")).and_then(Value::as_array).cloned().unwrap_or_default()
}

/// `restoreSceneLevelTransitions(state, map)` (2445): возвращает ли лестнице
/// её этаж; только у этажа входа.
pub fn restore_scene_level_transitions(state: &Value, map: &mut TacticalMap) -> bool {
    let levels = declared_scene_levels(state);
    if levels.is_empty() || map.level_index != 0 {
        return false;
    }
    !attach_level_transitions(map, Some(&Value::Array(levels))).is_empty()
}

/// `levelLabelFor(offset, hint)` (`level-generator.mjs`, крейт `sk-world-time`).
pub fn level_label_for(offset: i64, hint: Option<&Value>) -> String {
    sk_world_time::level_generator::level_label_for(offset, hint)
}

/// `sceneLevelLabel(state, level, transitionLabel)` (2451): слова перехода,
/// затем заявка архитектора, затем номер.
pub fn scene_level_label(state: &Value, level: i64, transition_label: &str) -> String {
    let levels = declared_scene_levels(state);
    let declared = levels.iter().find(|entry| js::number(entry.get("offset")) == level as f64);
    let chosen = if !transition_label.is_empty() {
        transition_label.to_string()
    } else {
        match declared.and_then(|entry| entry.get("label")).filter(|label| js::truthy(Some(label))) {
            Some(label) => js::string(Some(label)),
            None => String::new(),
        }
    };
    let label = squash_spaces(&chosen);
    let label = if label.is_empty() { level_label_for(level, declared.and_then(|entry| entry.get("hint"))) } else { label };
    head(&label, 120)
}


/// `rememberedLevelMap(state, locationId, level)` (2463): записи с L3 несут
/// карту; по старым клеткам восстанавливается только этаж входа.
pub fn remembered_level_map(state: &Value, location_id: &str, level: i64) -> sk_tactical::tactical_map::MapResult<Option<TacticalMap>> {
    let key = level_key(location_id, level);
    if let Some(serialized) = scene_tactical_map_for_location(state.get("locationMaps"), &key) {
        if let Ok(map) = deserialize_tactical_map(&serialized) {
            return Ok(Some(map));
        }
    }
    if level != 0 {
        return Ok(None);
    }
    let Some(cells) = scene_map_for_location(state.get("locationMaps"), &key).filter(|cells| !cells.is_empty()) else { return Ok(None) };
    let seed = s(state.get("worldMap").and_then(|world| world.get("seed")));
    let mut rebuilt = tactical_map_from_legacy_cells(&cells, &LegacyMapOptions { location_id, seed: &seed, ..LegacyMapOptions::default() })?;
    attach_level_transitions(&mut rebuilt, Some(&Value::Array(declared_scene_levels(state))));
    Ok(Some(rebuilt))
}

// --- мир NPC: посты и занятость (крейт `sk-npc-world`) ----------------------

/// `normalizeNpcWorldState(state.npc_world)`.
pub fn normalized_npc_world(state: &Value) -> Value {
    sk_npc_world::npc_positioning::normalize_npc_world_state(state.get("npc_world"), &js::obj())
}

/// `world.placements` нормализованного мира NPC.
pub fn npc_world_placements(world: &Value) -> Vec<Value> {
    world.get("placements").and_then(Value::as_array).cloned().unwrap_or_default()
}

/// `{ ...world, placements }` — без повторной нормализации.
pub fn npc_world_with_placements(world: &Value, placements: Vec<Value>) -> Value {
    let mut next = crate::core::spread_value(Some(world));
    next.insert("placements".into(), Value::Array(placements));
    Value::Object(next)
}

/// `sceneNpcOccupiedCells(state)` (`npc-positioning.mjs`): клетки постов
/// присутствующих NPC, а без постов — `scene_npcs` проекции.
pub fn scene_npc_occupied_cells(state: &Value) -> IndexSet<String> {
    sk_npc_world::npc_positioning::scene_npc_occupied_cells(state)
}

// --- стэш этажа ------------------------------------------------------------

/// `Object.entries(x).filter(([id]) => keep(id))` для `mechanics.positions`.
fn positions_where(state: &Value, keep: impl Fn(&str) -> bool) -> Map<String, Value> {
    let positions = sk_core::game::mechanics(state).get("positions").and_then(Value::as_object).cloned().unwrap_or_default();
    js::entries(&positions).into_iter().filter(|(id, _)| keep(id)).map(|(id, value)| (id.clone(), value.clone())).collect()
}

/// `partyIds = new Set(state.partyMemberIds ?? [])` (строки как есть).
pub fn party_ids(state: &Value) -> IndexSet<String> {
    state.get("partyMemberIds").and_then(Value::as_array).map(|list| list.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
}

/// Длина, как `x.length` в условии «стэш не пуст».
fn has_items(value: &Value) -> bool {
    match value {
        Value::Array(items) => !items.is_empty(),
        Value::String(text) => !text.is_empty(),
        _ => false,
    }
}

/// `stashLevelEntities(state, key)` (2622): жители покидаемого этажа уходят в
/// стэш и со сцены.
pub fn stash_level_entities(state: &mut Value, key: &str) {
    if key.is_empty() {
        return;
    }
    let party = party_ids(state);
    let location = scene_location_id(state);
    let world = normalized_npc_world(state);
    let placements = npc_world_placements(&world);
    let actors = state.get("actors").and_then(Value::as_array).cloned().unwrap_or_default();
    let summons: Vec<Value> = actors.iter().filter(|actor| is_party_summon(actor)).cloned().collect();
    let positions = positions_where(state, |id| !party.contains(id));
    let here: Vec<Value> = placements.iter().filter(|placement| s(placement.get("location_id")) == location).cloned().collect();
    let mechanics = sk_core::game::mechanics(state);
    let enemies = state.get("enemies").filter(|value| !value.is_null()).cloned().unwrap_or_else(|| json!([]));
    let entities = state.get("entities").filter(|value| !value.is_null()).cloned().unwrap_or_else(|| json!([]));
    let interactions = mechanics.get("scene_interactions").filter(|value| !value.is_null()).cloned().unwrap_or_else(js::obj);
    let encounter = mechanics.get("encounter").cloned().unwrap_or(Value::Null);
    let populated = has_items(&enemies)
        || has_items(&entities)
        || !summons.is_empty()
        || !positions.is_empty()
        || interactions.as_object().is_some_and(|map| !map.is_empty())
        || js::truthy(Some(&encounter))
        || !here.is_empty();
    let stash = json!({
        "enemies": enemies,
        "entities": entities,
        "summons": summons,
        "positions": Value::Object(positions),
        "scene_interactions": interactions,
        "encounter": encounter,
        "npc_placements": here,
    });
    let mut stashes = match state.get("levelEntities") {
        Some(value @ (Value::Object(_) | Value::Array(_))) => crate::core::spread_value(Some(value)),
        _ => Map::new(),
    };
    stashes.shift_remove(key);
    if populated {
        stashes.insert(key.to_string(), stash);
    }
    let ordered: Vec<(String, Value)> = js::entries(&stashes).into_iter().map(|(key, value)| (key.clone(), value.clone())).collect();
    let skip = ordered.len().saturating_sub(MAX_LEVEL_STASHES);
    let trimmed: Map<String, Value> = ordered.into_iter().skip(skip).collect();
    if let Some(root) = state.as_object_mut() {
        if trimmed.is_empty() {
            root.shift_remove("levelEntities");
        } else {
            root.insert("levelEntities".into(), Value::Object(trimmed));
        }
    }
    state["enemies"] = json!([]);
    state["entities"] = json!([]);
    state["actors"] = Value::Array(actors.into_iter().filter(|actor| !is_party_summon(actor)).collect());
    let party_positions = positions_where(state, |id| party.contains(id));
    let mechanics = mechanics_mut(state);
    mechanics.insert("positions".into(), Value::Object(party_positions));
    mechanics.insert("scene_interactions".into(), js::obj());
    mechanics.insert("encounter".into(), Value::Null);
    let elsewhere: Vec<Value> = placements.into_iter().filter(|placement| s(placement.get("location_id")) != location).collect();
    let world = npc_world_with_placements(&world, elsewhere);
    state["npc_world"] = world;
}

/// `restoreLevelEntities(state, key)` (2670): стэш этажа возвращается на
/// сцену; пустой стэш — пустой этаж.
pub fn restore_level_entities(state: &mut Value, key: &str) {
    let stash = (!key.is_empty())
        .then(|| state.get("levelEntities").filter(|value| value.is_object() || value.is_array()).and_then(|stashes| stashes.get(key)).filter(|stash| js::truthy(Some(stash))).cloned())
        .flatten();
    let field = |name: &str| stash.as_ref().and_then(|stash| stash.get(name)).filter(|value| !value.is_null()).cloned();
    state["enemies"] = field("enemies").unwrap_or_else(|| json!([]));
    state["entities"] = field("entities").unwrap_or_else(|| json!([]));
    let mut actors: Vec<Value> = state.get("actors").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().filter(|actor| !is_party_summon(actor)).collect();
    if let Some(Value::Array(summons)) = field("summons") {
        actors.extend(summons);
    }
    state["actors"] = Value::Array(actors);
    let interactions = field("scene_interactions").unwrap_or_else(js::obj);
    let encounter = field("encounter").filter(|value| js::truthy(Some(value))).unwrap_or(Value::Null);
    let mut positions = crate::core::spread_value(field("positions").as_ref());
    let current = sk_core::game::mechanics(state).get("positions").cloned();
    for (id, position) in crate::core::spread_value(current.as_ref()) {
        positions.insert(id, position);
    }
    let mechanics = mechanics_mut(state);
    mechanics.insert("scene_interactions".into(), interactions);
    mechanics.insert("encounter".into(), encounter);
    mechanics.insert("positions".into(), Value::Object(positions));
    let world = normalized_npc_world(state);
    let mut placements = npc_world_placements(&world);
    if let Some(Value::Array(stashed)) = field("npc_placements") {
        placements.extend(stashed);
    }
    let world = sk_npc_world::npc_positioning::normalize_npc_world_state(Some(&npc_world_with_placements(&world, placements)), &js::obj());
    state["npc_world"] = world;
    if stash.is_none() {
        return;
    }
    let mut stashes = crate::core::spread_value(state.get("levelEntities"));
    stashes.shift_remove(key);
    if let Some(root) = state.as_object_mut() {
        if stashes.is_empty() {
            root.shift_remove("levelEntities");
        } else {
            root.insert("levelEntities".into(), Value::Object(stashes));
        }
    }
}

/// `rememberKnownLevel(state, locationId, level, label)` (2693): известные
/// отряду этажи без дублей, по возрастанию; этаж входа есть всегда.
pub fn remember_known_level(state: &mut Value, location_id: &str, level: i64, label: &str) {
    if location_id.is_empty() {
        return;
    }
    let mut known = match state.get("locationLevels") {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    let mut by_index: Vec<(i64, Value)> = vec![(0, json!({ "index": 0, "label": scene_level_label(state, 0, "") }))];
    let put = |index: i64, entry: Value, by_index: &mut Vec<(i64, Value)>| match by_index.iter_mut().find(|(existing, _)| *existing == index) {
        Some(slot) => slot.1 = entry,
        None => by_index.push((index, entry)),
    };
    for entry in known.get(location_id).and_then(Value::as_array).cloned().unwrap_or_default() {
        let index = js::number(entry.get("index"));
        if !crate::core::is_safe_integer_f64(index) {
            continue;
        }
        let index = index as i64;
        let stored = head(&s(entry.get("label")), 120);
        let label = if stored.is_empty() { scene_level_label(state, index, "") } else { stored };
        put(index, json!({ "index": index, "label": label }), &mut by_index);
    }
    put(level, json!({ "index": level, "label": label }), &mut by_index);
    by_index.sort_by_key(|(index, _)| *index);
    known.insert(location_id.to_string(), Value::Array(by_index.into_iter().map(|(_, entry)| entry).collect()));
    state["locationLevels"] = Value::Object(known);
}

/// Площадь существа в клетках (`actorFootprintCellsAt(state, id)`) ключами `x,y`.
pub fn actor_cells_at(state: &Value, id: &str) -> Vec<String> {
    let actor = sk_core::game::find_actor(state, id);
    let position = sk_core::game::actor_position(state, id).map(|point| json!({ "x": point.x, "y": point.y }));
    footprint_cells_for(actor, Some(position.as_ref().unwrap_or(&Value::Null))).into_iter().map(|cell| format!("{},{}", cell.x, cell.y)).collect()
}

// --- переходы и переезд (для разбора команд, Р6) ---------------------------

/// `levelTransitionBackTo(map, fromLevel)` (2482): переход целевого этажа,
/// который ведёт обратно на покидаемый.
pub fn level_transition_back_to(map: &TacticalMap, from_level: i64) -> Option<&sk_tactical::tactical_map::TacticalProp> {
    map.props.iter().find(|prop| prop.transition.as_ref().is_some_and(|transition| transition.to_level == from_level))
}

/// Клетки площади ключами `x,y`.
fn cell_keys(actor: Option<&Value>, anchor: &Value) -> Vec<String> {
    footprint_cells_for(actor, Some(anchor)).into_iter().map(|cell| format!("{},{}", cell.x, cell.y)).collect()
}

/// Ключ клетки `x,y`.
fn pair_key(cell: (i64, i64)) -> String {
    format!("{},{}", cell.0, cell.1)
}

/// Безопасные целые координаты точки (`Number(position?.x)`).
fn safe_point(position: &Value) -> Option<(i64, i64)> {
    let x = js::number(position.as_object().and_then(|point| point.get("x")));
    let y = js::number(position.as_object().and_then(|point| point.get("y")));
    (crate::core::is_safe_integer_f64(x) && crate::core::is_safe_integer_f64(y)).then_some((x as i64, y as i64))
}

/// `levelArrivalPositions(state, map, arrivalProp)` (2550): места отряда на
/// целевом этаже волной от точки прибытия; клетки жителей стэша этажа заняты.
pub fn level_arrival_positions(state: &Value, map: &TacticalMap, arrival: Option<&sk_tactical::tactical_map::TacticalProp>) -> Result<Vec<Value>, sk_core::RuleError> {
    let party = super::placement::scene_advance_party_ids(state);
    let Some(anchor) = arrival.and_then(|prop| prop.footprint.first()).copied() else {
        return Err(sk_core::RuleError::new("LEVEL_ARRIVAL_MISSING", "У точки прибытия нет координат на целевом этаже"));
    };
    let key = level_key(&scene_location_id(state), map.level_index);
    let stash = state
        .get("levelEntities")
        .filter(|value| js::truthy(Some(value)) && (value.is_object() || value.is_array()))
        .and_then(|stashes| stashes.get(&key))
        .filter(|stash| !stash.is_null());
    let field = |name: &str| stash.and_then(|stash| stash.get(name)).and_then(Value::as_array).cloned().unwrap_or_default();
    let mut by_id: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    for actor in field("enemies").into_iter().chain(field("summons")) {
        by_id.insert(sk_core::game::actor_id(&actor), actor);
    }
    let mut occupied: IndexSet<String> = IndexSet::new();
    if let Some(Value::Object(positions)) = stash.and_then(|stash| stash.get("positions")) {
        for (id, position) in js::entries(positions) {
            let Some((x, y)) = safe_point(position) else { continue };
            occupied.extend(cell_keys(by_id.get(id.as_str()), &json!({ "x": x, "y": y })));
        }
    }
    for placement in field("npc_placements") {
        let body = json!({ "footprint": placement.get("footprint").cloned().unwrap_or(Value::Null) });
        occupied.extend(cell_keys(Some(&body), &placement));
    }
    let mut candidates: Vec<(i64, i64)> = sk_tactical::tactical_map::reachable_cells(map, anchor.x, anchor.y, true, None).into_iter().collect();
    candidates.sort_by(|left, right| {
        let distance = |cell: &(i64, i64)| (cell.0 - anchor.x).abs() + (cell.1 - anchor.y).abs();
        distance(left).cmp(&distance(right)).then(left.1.cmp(&right.1)).then(left.0.cmp(&right.0))
    });
    let actors: Vec<Option<Value>> = party.iter().map(|id| sk_core::game::find_actor(state, id).cloned()).collect();
    if !actors.iter().any(|actor| sk_geometry::actor_footprint::footprint_size_for(actor.as_ref()) > 1) {
        let available: Vec<(i64, i64)> = candidates.iter().copied().filter(|cell| !occupied.contains(&pair_key(*cell))).collect();
        if available.len() < party.len() {
            return Err(sk_core::RuleError::new("SCENE_ENTRANCE_CAPACITY_EXCEEDED", "На целевом этаже недостаточно проходимых клеток для отряда"));
        }
        return Ok(party.iter().zip(available).map(|(id, cell)| json!({ "actor_id": id, "x": cell.0, "y": cell.1 })).collect());
    }
    let mut placements = Vec::new();
    for (id, actor) in party.iter().zip(&actors) {
        let selected = candidates.iter().copied().find(|cell| {
            let anchor = json!({ "x": cell.0, "y": cell.1 });
            let footprint = footprint_cells_for(actor.as_ref(), Some(&anchor));
            !footprint.is_empty()
                && !super::placement::footprint_placement_edges_blocked(Some(map), actor.as_ref(), &anchor)
                && footprint.iter().all(|cell| sk_tactical::tactical_map::cell_passable(map, cell.x, cell.y) && !occupied.contains(&pair_key((cell.x, cell.y))))
        });
        let Some(selected) = selected else {
            return Err(sk_core::RuleError::new("SCENE_ENTRANCE_CAPACITY_EXCEEDED", "На целевом этаже недостаточно площади для отряда"));
        };
        occupied.extend(cell_keys(actor.as_ref(), &json!({ "x": selected.0, "y": selected.1 })));
        placements.push(json!({ "actor_id": id, "x": selected.0, "y": selected.1 }));
    }
    Ok(placements)
}

/// Кто переезжает при замене карты (`planImportRelocations`).
struct Mover {
    kind: &'static str,
    id: String,
    x: i64,
    y: i64,
    body: Option<Value>,
    creature: bool,
}

/// `planImportRelocations(state, map, partyPositions)` (2504): куда встают
/// все, кроме отряда, когда ведущий заменил карту, — ближайшая к прежним
/// координатам свободная клетка, где помещается площадь; без места — со
/// сцены.
pub fn plan_import_relocations(state: &Value, map: &TacticalMap, party_positions: &[Value]) -> Vec<Value> {
    let party: IndexSet<String> = super::placement::scene_advance_party_ids(state).into_iter().collect();
    let mut occupied = super::placement::prop_movement_positions(map);
    for position in party_positions {
        let actor = sk_core::game::find_actor(state, &js::string(position.get("actor_id")));
        occupied.extend(cell_keys(actor, position));
    }
    let mut movers = Vec::new();
    let positions = sk_core::game::mechanics(state).get("positions").and_then(Value::as_object).cloned().unwrap_or_default();
    let mut entries: Vec<(&String, &Value)> = js::entries(&positions);
    entries.sort_by(|left, right| locale_compare(left.0, right.0));
    for (id, position) in entries {
        if party.contains(id.as_str()) {
            continue;
        }
        let Some((x, y)) = safe_point(position) else { continue };
        movers.push(Mover { kind: "actor", id: id.clone(), x, y, body: sk_core::game::find_actor(state, id).cloned(), creature: true });
    }
    let mut entities = state.get("entities").and_then(Value::as_array).cloned().unwrap_or_default();
    entities.sort_by(|left, right| locale_compare(&s(left.get("id")), &s(right.get("id"))));
    for entity in entities {
        let Some((x, y)) = safe_point(&entity) else { continue };
        if !js::truthy(entity.get("id")) {
            continue;
        }
        let creature = crate::constants::CREATURE_ENTITY_KINDS.contains(&js::string(entity.get("kind")).as_str());
        movers.push(Mover { kind: "entity", id: js::string(entity.get("id")), x, y, body: Some(entity), creature });
    }
    let mut candidates = Vec::new();
    for y in 0..map.height {
        for x in 0..map.width {
            if sk_tactical::tactical_map::cell_passable(map, x, y) {
                candidates.push((x, y));
            }
        }
    }
    let mut relocations = Vec::new();
    for mover in movers {
        let from_x = mover.x.min(map.width - 1).max(0);
        let from_y = mover.y.min(map.height - 1).max(0);
        let mut ordered = candidates.clone();
        ordered.sort_by(|left, right| {
            let distance = |cell: &(i64, i64)| (cell.0 - from_x).abs() + (cell.1 - from_y).abs();
            distance(left).cmp(&distance(right)).then(left.1.cmp(&right.1)).then(left.0.cmp(&right.0))
        });
        let spot = ordered.into_iter().find(|cell| {
            let anchor = json!({ "x": cell.0, "y": cell.1 });
            !super::placement::footprint_placement_edges_blocked(Some(map), mover.body.as_ref(), &anchor)
                && footprint_cells_for(mover.body.as_ref(), Some(&anchor)).iter().all(|cell| sk_tactical::tactical_map::cell_passable(map, cell.x, cell.y) && !occupied.contains(&pair_key((cell.x, cell.y))))
        });
        let Some(spot) = spot else {
            relocations.push(json!({ "kind": mover.kind, "id": mover.id, "removed": true }));
            continue;
        };
        if mover.creature {
            occupied.extend(cell_keys(mover.body.as_ref(), &json!({ "x": spot.0, "y": spot.1 })));
        }
        relocations.push(json!({ "kind": mover.kind, "id": mover.id, "x": spot.0, "y": spot.1 }));
    }
    relocations
}

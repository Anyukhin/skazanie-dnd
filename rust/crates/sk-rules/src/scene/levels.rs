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
//! Частные копии чужих модулей, которых ещё нет в Rust (заменить, когда
//! появятся крейты):
//! - `levelLabelFor` (`level-generator.mjs`, `sk-world-time`);
//! - нормализация мира NPC `normalizeNpcWorldState` и занятость клеток
//!   мирными NPC `sceneNpcOccupiedCells` (`npc-positioning.mjs`,
//!   `sk-npc-world`). Посты (`placements`) нормализуются как в JS; прочие
//!   поля мира NPC (`vitals`, `stances`, `inventories`, `profiles`) состояние
//!   уже принесло нормализованными (`normalizeCampaignState` перед веткой) —
//!   для них нормализация тождественна, как и в `sync_npc_world_vital` Р0.

use serde_json::{json, Map, Value};
use sk_core::game::{is_party_summon, mechanics_mut};
use sk_core::indexmap::IndexSet;
use sk_core::js::{self, s};
use sk_core::text::{capitalize, head, locale_compare, lower, nfkc, squash_spaces};
use sk_geometry::actor_footprint::{footprint_cells_for, normalize_footprint_metadata};
use sk_tactical::tactical_map::{attach_level_transitions, deserialize_tactical_map, tactical_map_from_legacy_cells, LegacyMapOptions, TacticalMap};

use crate::scene_maps::{level_key, scene_location_id, scene_map_record};

/// `MAX_LEVEL_STASHES`: сколько стэшей неактивных этажей держит состояние.
pub const MAX_LEVEL_STASHES: usize = 32;

/// `NPC_WORLD_POLICY_ID` (`npc-positioning.mjs`).
pub const NPC_WORLD_POLICY_ID: &str = "skazanie:npc-world-v1";

/// `MAX_PLACEMENTS` (`npc-positioning.mjs`).
const MAX_PLACEMENTS: usize = 5_000;

/// `MAX_VISIBLE_NPCS` (`npc-positioning.mjs`).
const MAX_VISIBLE_NPCS: usize = 100;

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

/// `cleanText(value, maximum)` (`level-generator.mjs`): только строки.
fn clean_text(value: &str, maximum: usize) -> String {
    head(&squash_spaces(value), maximum)
}

/// `levelLabelFor(offset, hint)` (`level-generator.mjs`, 120) — частная копия.
pub fn level_label_for(offset: i64, hint: &str) -> String {
    let fallback = match offset {
        0 => "Первый этаж".to_string(),
        1 => "Второй этаж".to_string(),
        2 => "Третий этаж".to_string(),
        3 => "Четвёртый этаж".to_string(),
        -1 => "Подвал".to_string(),
        -2 => "Нижний подвал".to_string(),
        -3 => "Глубокий подвал".to_string(),
        index if index > 0 => format!("Этаж {}", index + 1),
        index => format!("Ярус {index}"),
    };
    let text = clean_text(hint, 60);
    if offset >= 0 || text.is_empty() {
        return fallback;
    }
    capitalize(&text)
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
    let label = if label.is_empty() { level_label_for(level, &s(declared.and_then(|entry| entry.get("hint")))) } else { label };
    head(&label, 120)
}

/// `sceneTacticalMapForLocation(locationMaps, key)` (`adventure-director.mjs`):
/// законсервированная карта этажа без нормализации клеток.
fn scene_tactical_map_for_location(location_maps: Option<&Value>, key: &str) -> Option<Value> {
    let id = crate::scene_maps::text(Some(&Value::String(key.to_string())), 120, "");
    if id.is_empty() {
        return None;
    }
    let record = location_maps.and_then(|maps| maps.get(&id))?.as_object()?;
    record.get("map").filter(|map| map.is_object()).cloned()
}

/// `sceneMapForLocation(locationMaps, key)` (`adventure-director.mjs`).
fn scene_map_for_location(location_maps: Option<&Value>, key: &str) -> Option<Vec<Value>> {
    let id = crate::scene_maps::text(Some(&Value::String(key.to_string())), 120, "");
    if id.is_empty() {
        return None;
    }
    let record = scene_map_record(location_maps.and_then(|maps| maps.get(&id))?, None)?;
    record.get("cells").and_then(Value::as_array).cloned()
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

// --- мир NPC: посты и занятость (частная копия `npc-positioning.mjs`) -------

/// `text(value, maximum)` (`npc-positioning.mjs`).
fn npc_text(value: Option<&Value>, maximum: usize) -> String {
    head(&squash_spaces(&nfkc(&s(value))), maximum)
}

/// `integer(value, NaN)` → безопасное целое или `None`.
fn npc_integer(value: Option<&Value>) -> Option<i64> {
    let number = js::number(value);
    crate::core::is_safe_integer_f64(number).then_some(number as i64)
}

/// `safePlacement(value)` (`npc-positioning.mjs`, 50).
fn safe_placement(value: &Value) -> Option<Value> {
    let npc_id = npc_text(value.get("npc_id"), 120);
    let location_id = npc_text(value.get("location_id"), 180);
    let x = npc_integer(value.get("x"));
    let y = npc_integer(value.get("y"));
    let (Some(x), Some(y)) = (x, y) else { return None };
    if npc_id.is_empty() || location_id.is_empty() {
        return None;
    }
    let mut placement = Map::new();
    placement.insert("npc_id".into(), Value::String(npc_id));
    placement.insert("location_id".into(), Value::String(location_id));
    placement.insert("x".into(), Value::from(x));
    placement.insert("y".into(), Value::from(y));
    if let Some(footprint) = normalize_footprint_metadata(value.get("footprint")) {
        placement.insert("footprint".into(), footprint.to_value());
    }
    placement.insert("anchor_prop_id".into(), Value::String(npc_text(value.get("anchor_prop_id"), 120)));
    let reason = npc_text(value.get("placement_reason"), 80);
    placement.insert("placement_reason".into(), Value::String(if reason.is_empty() { "deterministic-post".into() } else { reason }));
    placement.insert("policy_id".into(), Value::String(NPC_WORLD_POLICY_ID.into()));
    placement.insert("source_event_id".into(), Value::String(npc_text(value.get("source_event_id"), 120)));
    Some(Value::Object(placement))
}

/// Посты мира NPC так, как их нормализует `normalizeNpcWorldState`: без
/// мусора и повторов «место + NPC»; в режиме legacy — последние 5000.
fn normalize_npc_placements(list: &[Value]) -> Vec<Value> {
    let mut seen: IndexSet<String> = IndexSet::new();
    let mut placements = Vec::new();
    for raw in list {
        let Some(placement) = safe_placement(raw) else { continue };
        let key = format!("{}\0{}", s(placement.get("location_id")), s(placement.get("npc_id")));
        if !seen.insert(key) {
            continue;
        }
        placements.push(placement);
    }
    if sk_society::retention_context::retention_mode() == "legacy" && placements.len() > MAX_PLACEMENTS {
        let skip = placements.len() - MAX_PLACEMENTS;
        placements.drain(..skip);
    }
    placements
}

/// `normalizeNpcWorldState(value)` с заменёнными постами: шесть полей в
/// порядке JS; посты нормализуются, остальное — как пришло (нормализовано
/// до ветки).
pub fn npc_world_with_placements(world: Option<&Value>, placements: &[Value]) -> Value {
    let source = world.filter(|world| world.is_object());
    let field = |key: &str| source.and_then(|world| world.get(key)).filter(|value| value.is_object()).cloned().unwrap_or_else(js::obj);
    json!({
        "schema_version": 3,
        "placements": normalize_npc_placements(placements),
        "vitals": field("vitals"),
        "stances": field("stances"),
        "inventories": field("inventories"),
        "profiles": field("profiles"),
    })
}

/// Посты мира NPC из состояния (`normalizeNpcWorldState(state.npc_world).placements`).
pub fn npc_placements(state: &Value) -> Vec<Value> {
    let list = state.get("npc_world").filter(|world| world.is_object()).and_then(|world| world.get("placements")).and_then(Value::as_array).cloned().unwrap_or_default();
    normalize_npc_placements(&list)
}

/// `sceneLocationId(state)` из `npc-positioning.mjs` (не путать с
/// `adventure-director`).
fn npc_scene_location_id(state: &Value) -> String {
    let scene = state.get("scene");
    let field = |key: &str| scene.and_then(|scene| scene.get(key)).filter(|value| !value.is_null());
    let explicit = npc_text(field("location_id").or_else(|| field("locationId")), 180);
    if !explicit.is_empty() {
        return explicit;
    }
    let from_map = npc_text(scene.and_then(|scene| scene.get("map")).and_then(|map| map.get("locationId")), 180);
    if !from_map.is_empty() {
        return from_map;
    }
    npc_text(field("location").or_else(|| field("title")), 180)
}

/// `comparable(value)` (`npc-positioning.mjs`).
fn comparable(value: Option<&Value>) -> String {
    lower(&npc_text(value, 180))
}

/// `npcAtCurrentLocation(npc, state)`.
fn npc_at_current_location(npc: &Value, state: &Value) -> bool {
    if js::is_false(npc.get("available")) {
        return false;
    }
    let scene = state.get("scene");
    let current_id = comparable(Some(&Value::String(npc_scene_location_id(state))));
    let current_name = comparable(scene.and_then(|scene| scene.get("location").filter(|value| !value.is_null()).or_else(|| scene.get("title"))));
    let location_id = comparable(npc.get("location_id").filter(|value| !value.is_null()).or_else(|| npc.get("locationId")));
    let location = comparable(npc.get("location"));
    if !location_id.is_empty() && !current_id.is_empty() {
        return location_id == current_id;
    }
    if location.is_empty() {
        return false;
    }
    location == current_id || location == current_name
}

/// `presentSceneNpcs(state)`: живые социальные NPC текущего места по id.
fn present_scene_npcs(state: &Value) -> Vec<Value> {
    let vitals = state.get("npc_world").and_then(|world| world.get("vitals")).filter(|value| value.is_object()).cloned().unwrap_or_else(js::obj);
    let npcs = state.get("social").and_then(|social| social.get("npcs")).and_then(Value::as_array).cloned().unwrap_or_default();
    let mut present: Vec<Value> = npcs
        .into_iter()
        .filter(|npc| js::truthy(npc.get("id")) && js::truthy(npc.get("name")) && npc_at_current_location(npc, state))
        .filter(|npc| {
            let vital = vitals.get(js::string(npc.get("id")));
            let alive = !js::is_false(vital.and_then(|vital| vital.get("alive")));
            let hp = vital.and_then(|vital| vital.get("hp")).filter(|value| !value.is_null()).map_or(1.0, |value| js::number(Some(value)));
            alive && hp > 0.0
        })
        .collect();
    present.sort_by(|left, right| locale_compare(&js::string(left.get("id")), &js::string(right.get("id"))));
    present.truncate(MAX_VISIBLE_NPCS);
    present
}

/// `keyOf(position)`: `${Number(x)},${Number(y)}`.
fn key_of(position: &Value) -> String {
    format!("{},{}", js::f64_string(js::number(position.get("x"))), js::f64_string(js::number(position.get("y"))))
}

/// `sceneNpcOccupiedCells(state)` (`npc-positioning.mjs`, 610): клетки постов
/// присутствующих NPC, а без постов — `scene_npcs` проекции.
pub fn scene_npc_occupied_cells(state: &Value) -> IndexSet<String> {
    let location = npc_scene_location_id(state);
    let placements = npc_placements(state);
    let mut placed: Vec<(String, Value)> = present_scene_npcs(state)
        .into_iter()
        .filter_map(|npc| {
            let id = js::string(npc.get("id"));
            let placement = placements.iter().find(|placement| s(placement.get("npc_id")) == id && s(placement.get("location_id")) == location)?.clone();
            Some((id, placement))
        })
        .collect();
    placed.sort_by(|left, right| locale_compare(&left.0, &right.0));
    if !placed.is_empty() {
        let mut cells = IndexSet::new();
        for (_, placement) in &placed {
            let body = json!({ "footprint": placement.get("footprint").cloned().unwrap_or(Value::Null) });
            for cell in footprint_cells_for(Some(&body), Some(placement)) {
                cells.insert(format!("{},{}", cell.x, cell.y));
            }
        }
        return cells;
    }
    state
        .get("scene_npcs")
        .and_then(Value::as_array)
        .map(|npcs| npcs.iter().filter(|npc| !js::is_false(npc.get("alive"))).map(key_of).collect())
        .unwrap_or_default()
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
    let placements = npc_placements(state);
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
    let world = npc_world_with_placements(state.get("npc_world"), &elsewhere);
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
    let mut placements = npc_placements(state);
    if let Some(Value::Array(stashed)) = field("npc_placements") {
        placements.extend(stashed);
    }
    let world = npc_world_with_placements(state.get("npc_world"), &placements);
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

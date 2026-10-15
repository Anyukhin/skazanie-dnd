//! Частная копия шести функций `server/npc-positioning.mjs`, без которых не
//! считается геометрия движка: `sceneNpcOccupiedCells`,
//! `sceneNpcTransitCells`, `placedSceneNpcTargets`, `npcPlacementFor`,
//! `npcInteractionTargetForViewer`, `npcCombatActorFor` — и их помощники
//! (`normalizeNpcWorldState` без инвентарей, `presentSceneNpcs`,
//! `sceneLocationId`, `npcVitalFor`, `npcMechanicsFor`, `initialNpcVital`).
//!
//! **Заменить на `sk-npc-world` после переноса** `server/npc-positioning.mjs`
//! целиком. Эталон — `fixtures/gen-geometry.mjs` (раздел `npc`).
//!
//! Отличие от JS: `null` в списке постов, словаре живучести или позиций JS
//! роняет (`null.npc_id` — `TypeError`); здесь такая запись пропускается или
//! читается как пустой объект.

use serde_json::{json, Map, Value};
use sk_core::{js, text};
use sk_geometry::actor_footprint::normalize_footprint_metadata;
use sk_geometry::Point;

use super::{footprint_cells, key_of, KeySet};
use crate::core::{slice_utf16, spread_value};

const NPC_WORLD_POLICY_ID: &str = "skazanie:npc-world-v1";
const STANCES: [&str; 6] = ["neutral", "guarded", "frightened", "hostile", "fleeing", "dead"];
const MAX_PLACEMENTS: usize = 5_000;
const MAX_VISIBLE_NPCS: usize = 100;
const LEGACY_ENTRY_LIMIT: usize = 500;

/// `text(value, maximum)`: NFKC, пробелы схлопнуты, обрезка по UTF-16.
fn npc_text(value: Option<&Value>, maximum: usize) -> String {
    slice_utf16(&text::squash_spaces(&text::nfkc(&js::s(value))), maximum)
}

/// `comparable(value)`.
fn comparable(value: Option<&Value>) -> String {
    text::lower(&npc_text(value, 180))
}

/// `integer(value, fallback)`.
fn integer(value: Option<&Value>, fallback: f64) -> f64 {
    let number = js::number(value);
    if super::is_safe(number) {
        number
    } else {
        fallback
    }
}

fn legacy() -> bool {
    sk_society::retention_context::retention_mode() == "legacy"
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().and_then(|object| object.get(key))
}

/// `safePlacement(value)`.
fn safe_placement(value: &Value) -> Option<Value> {
    let npc_id = npc_text(field(value, "npc_id"), 120);
    let location_id = npc_text(field(value, "location_id"), 180);
    let x = integer(field(value, "x"), f64::NAN);
    let y = integer(field(value, "y"), f64::NAN);
    if npc_id.is_empty() || location_id.is_empty() || !super::is_safe(x) || !super::is_safe(y) {
        return None;
    }
    let mut placement = Map::new();
    placement.insert("npc_id".into(), Value::from(npc_id));
    placement.insert("location_id".into(), Value::from(location_id));
    placement.insert("x".into(), js::num(x));
    placement.insert("y".into(), js::num(y));
    if let Some(footprint) = normalize_footprint_metadata(field(value, "footprint")) {
        placement.insert("footprint".into(), json!({ "version": footprint.version, "size": footprint.size }));
    }
    placement.insert("anchor_prop_id".into(), Value::from(npc_text(field(value, "anchor_prop_id"), 120)));
    let reason = npc_text(field(value, "placement_reason"), 80);
    placement.insert("placement_reason".into(), Value::from(if reason.is_empty() { "deterministic-post".to_string() } else { reason }));
    placement.insert("policy_id".into(), Value::from(NPC_WORLD_POLICY_ID));
    placement.insert("source_event_id".into(), Value::from(npc_text(field(value, "source_event_id"), 120)));
    Some(Value::Object(placement))
}

/// `safeVital(value)`.
fn safe_vital(value: &Value) -> Value {
    let maximum = integer(field(value, "max_hp"), 4.0).min(500.0).max(1.0);
    let hp = integer(field(value, "hp"), maximum).min(maximum).max(0.0);
    let alive = js::is_true(field(value, "alive")) || !js::is_false(field(value, "alive")) && hp > 0.0;
    json!({ "hp": js::num(hp), "max_hp": js::num(maximum), "alive": alive })
}

/// `safeStance(value)`.
fn safe_stance(value: &Value) -> Value {
    let raw = js::string(field(value, "stance"));
    let stance = if STANCES.contains(&raw.as_str()) { raw } else { "neutral".into() };
    json!({
        "stance": stance,
        "reason": npc_text(field(value, "reason"), 120),
        "source_event_id": npc_text(field(value, "source_event_id"), 120),
        "propagation_depth": js::num(integer(field(value, "propagation_depth"), 0.0).min(1.0).max(0.0)),
    })
}

/// Нормализованный мир NPC (`normalizeNpcWorldState`) без инвентарей и
/// профилей: посты, живучесть, стойки.
pub struct NpcWorld {
    pub placements: Vec<Value>,
    pub vitals: Map<String, Value>,
    pub stances: Map<String, Value>,
}

fn npc_world_source(state: &Value) -> Option<&Value> {
    state.get("npc_world").filter(|world| world.is_object())
}

/// Первые 500 записей в legacy-режиме.
fn limited(entries: Map<String, Value>) -> Vec<(String, Value)> {
    let limit = if legacy() { LEGACY_ENTRY_LIMIT } else { usize::MAX };
    entries.into_iter().take(limit).collect()
}

fn normalized_entries(source: Option<&Value>, key: &str, normalize: impl Fn(&Value) -> Option<Value>) -> Map<String, Value> {
    let raw = source.and_then(|source| source.get(key)).filter(|value| !value.is_null());
    let mut result = Map::new();
    for (raw_id, value) in limited(spread_value(raw)) {
        let id = npc_text(Some(&Value::String(raw_id)), 120);
        if id.is_empty() {
            continue;
        }
        if let Some(value) = normalize(&value) {
            result.insert(id, value);
        }
    }
    result
}

/// `normalizeNpcWorldState(state.npc_world)`: посты, живучесть, стойки.
pub fn npc_world(state: &Value) -> NpcWorld {
    let source = npc_world_source(state);
    let mut placements = Vec::new();
    let mut keys = std::collections::HashSet::new();
    for raw in source.and_then(|source| source.get("placements")).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        let Some(placement) = safe_placement(raw) else { continue };
        let key = format!("{}\u{0}{}", js::s(placement.get("location_id")), js::s(placement.get("npc_id")));
        if !keys.insert(key) {
            continue;
        }
        placements.push(placement);
    }
    if legacy() && placements.len() > MAX_PLACEMENTS {
        placements.drain(..placements.len() - MAX_PLACEMENTS);
    }
    NpcWorld {
        placements,
        vitals: normalized_entries(source, "vitals", |value| Some(safe_vital(value))),
        stances: normalized_entries(source, "stances", |value| Some(safe_stance(value))),
    }
}

/// Профили авторских NPC (`normalizeNpcWorldState(...).profiles`).
pub fn npc_world_profiles(state: &Value) -> Map<String, Value> {
    normalized_entries(npc_world_source(state), "profiles", |value| sk_heroes::authored_npc::safe_authored_npc_mechanics(Some(value)))
}

/// `sceneLocationId(state)`.
pub fn scene_location_id(state: &Value) -> String {
    let scene = state.get("scene");
    let get = |key: &str| scene.and_then(|scene| scene.get(key));
    let explicit = npc_text(crate::core::coalesce(&[get("location_id"), get("locationId")]), 180);
    if !explicit.is_empty() {
        return explicit;
    }
    let from_map = npc_text(get("map").and_then(|map| map.get("locationId")), 180);
    if !from_map.is_empty() {
        return from_map;
    }
    npc_text(crate::core::coalesce(&[get("location"), get("title")]), 180)
}

/// `npcLocationMatchesCurrentScene(npc, state)`.
fn npc_location_matches_current_scene(npc: &Value, state: &Value) -> bool {
    let scene = state.get("scene");
    let get = |key: &str| scene.and_then(|scene| scene.get(key));
    let current_id = text::lower(&scene_location_id(state));
    let current_name = comparable(crate::core::coalesce(&[get("location"), get("title")]));
    let location_id = comparable(crate::core::coalesce(&[field(npc, "location_id"), field(npc, "locationId")]));
    let location = comparable(field(npc, "location"));
    if !location_id.is_empty() && !current_id.is_empty() {
        return location_id == current_id;
    }
    if location.is_empty() {
        return false;
    }
    location == current_id || location == current_name
}

fn social_npcs(state: &Value) -> &[Value] {
    state.get("social").and_then(|social| social.get("npcs")).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// `presentSceneNpcs(state)`: NPC текущего места, живые, по id.
fn present_scene_npcs<'a>(state: &'a Value, world: &NpcWorld) -> Vec<&'a Value> {
    let mut npcs: Vec<&Value> = social_npcs(state)
        .iter()
        .filter(|npc| js::truthy(field(npc, "id")) && js::truthy(field(npc, "name")) && !js::is_false(field(npc, "available")) && npc_location_matches_current_scene(npc, state))
        .filter(|npc| {
            let vital = world.vitals.get(&js::string(field(npc, "id")));
            let hp = vital.and_then(|vital| vital.get("hp")).filter(|hp| !hp.is_null()).cloned().unwrap_or(Value::from(1));
            !js::is_false(vital.and_then(|vital| vital.get("alive"))) && js::number(Some(&hp)) > 0.0
        })
        .collect();
    npcs.sort_by(|left, right| text::locale_compare(&js::string(field(left, "id")), &js::string(field(right, "id"))));
    npcs.truncate(MAX_VISIBLE_NPCS);
    npcs
}

/// `npcPlacementFor(state, npcId, locationId = sceneLocationId(state))`.
pub fn npc_placement_for(state: &Value, npc_id: &str, location_id: Option<&str>) -> Option<Value> {
    let location = location_id.map_or_else(|| scene_location_id(state), str::to_string);
    placement_in(&npc_world(state), npc_id, &location).cloned()
}

fn placement_in<'a>(world: &'a NpcWorld, npc_id: &str, location_id: &str) -> Option<&'a Value> {
    world.placements.iter().find(|placement| js::s(placement.get("npc_id")) == npc_id && js::s(placement.get("location_id")) == location_id)
}

/// NPC сцены с постом: `{ npc, placement }`.
#[derive(Clone, Debug, PartialEq)]
pub struct NpcTarget {
    pub npc: Value,
    pub placement: Value,
}

impl NpcTarget {
    pub fn to_value(&self) -> Value {
        json!({ "npc": self.npc, "placement": self.placement })
    }

    /// Точка поста.
    pub fn position(&self) -> Point {
        Point::from_value(Some(&self.placement))
    }

    /// `{ footprint: placement.footprint }` — площадь поста.
    pub fn footprint_actor(&self) -> Value {
        let mut actor = Map::new();
        if let Some(footprint) = self.placement.get("footprint") {
            actor.insert("footprint".into(), footprint.clone());
        }
        Value::Object(actor)
    }

    /// `footprintCellsFor({ footprint: placement.footprint }, placement)`.
    pub fn cells(&self) -> Vec<Point> {
        footprint_cells(Some(&self.footprint_actor()), Some(self.position()))
    }

    /// `String(npc.id)`.
    pub fn id(&self) -> String {
        js::string(self.npc.get("id"))
    }
}

/// `placedSceneNpcTargets(state)`.
pub fn placed_scene_npc_targets(state: &Value) -> Vec<NpcTarget> {
    let world = npc_world(state);
    placed_in(state, &world)
}

fn placed_in(state: &Value, world: &NpcWorld) -> Vec<NpcTarget> {
    let location = scene_location_id(state);
    let mut placed: Vec<NpcTarget> = present_scene_npcs(state, world)
        .into_iter()
        .filter_map(|npc| placement_in(world, &js::string(npc.get("id")), &location).map(|placement| NpcTarget { npc: npc.clone(), placement: placement.clone() }))
        .collect();
    placed.sort_by(|left, right| text::locale_compare(&left.id(), &right.id()));
    placed
}

/// `sceneNpcOccupiedCells(state)`: клетки присутствующих социальных NPC.
pub fn scene_npc_occupied_cells(state: &Value) -> KeySet {
    let placed = placed_scene_npc_targets(state);
    if !placed.is_empty() {
        return placed.iter().flat_map(NpcTarget::cells).map(key_of).collect();
    }
    scene_npcs(state).iter().filter(|npc| !js::is_false(field(npc, "alive"))).map(|npc| key_of(Point::from_value(Some(npc)))).collect()
}

/// `sceneNpcTransitCells(state)`: клетки мирных NPC — пройти можно,
/// закончить ход нельзя.
pub fn scene_npc_transit_cells(state: &Value) -> KeySet {
    let world = npc_world(state);
    let placed = placed_in(state, &world);
    if !placed.is_empty() {
        return placed
            .iter()
            .filter(|target| world.stances.get(&target.id()).and_then(|stance| stance.get("stance")).and_then(Value::as_str) != Some("hostile"))
            .flat_map(NpcTarget::cells)
            .map(key_of)
            .collect();
    }
    scene_npcs(state)
        .iter()
        .filter(|npc| {
            let stance = field(npc, "stance").filter(|stance| !stance.is_null()).map_or_else(|| "neutral".to_string(), |stance| js::string(Some(stance)));
            !js::is_false(field(npc, "alive")) && stance != "hostile"
        })
        .flat_map(|npc| footprint_cells(Some(npc), None))
        .map(key_of)
        .collect()
}

fn scene_npcs(state: &Value) -> &[Value] {
    state.get("scene_npcs").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// `initialNpcVital(npc)`: живучесть по роли.
fn initial_npc_vital(npc: Option<&Value>) -> Value {
    let tags = npc.and_then(|npc| field(npc, "tags")).and_then(Value::as_array).map(|tags| tags.iter().map(|tag| js::s(Some(tag))).collect::<Vec<_>>().join(" ")).unwrap_or_default();
    let role = text::lower(&format!("{} {}", npc_text(npc.and_then(|npc| field(npc, "role")), 160), tags));
    let maximum = if sk_core::re!(r"ветеран|veteran|рыцар|knight|телохран|bodyguard", "iu").is_match(&role).unwrap_or(false) {
        18
    } else if sk_core::re!(r"страж|guard|воин|soldier|охотник|hunter", "iu").is_match(&role).unwrap_or(false) {
        11
    } else if sk_core::re!(r"лекар|healer|жрец|priest|кузнец|blacksmith", "iu").is_match(&role).unwrap_or(false) {
        7
    } else {
        4
    };
    json!({ "hp": maximum, "max_hp": maximum, "alive": true })
}

/// `npcVitalFor(state, npcId)`.
pub fn npc_vital_for(state: &Value, npc_id: &str) -> Value {
    let world = npc_world(state);
    if let Some(persisted) = world.vitals.get(npc_id) {
        return persisted.clone();
    }
    if let Some(authored) = npc_world_profiles(state).get(npc_id) {
        let hp = authored.get("hp").cloned().unwrap_or(Value::Null);
        let alive = js::number(Some(&hp)) > 0.0;
        return json!({ "hp": hp, "max_hp": hp, "alive": alive });
    }
    let npc = social_npcs(state).iter().find(|candidate| js::string(field(candidate, "id")) == npc_id);
    initial_npc_vital(npc)
}

/// `npcMechanicsFor(state, npcId)`.
pub fn npc_mechanics_for(state: &Value, npc_id: &str) -> Option<Value> {
    npc_world_profiles(state).get(npc_id).cloned()
}

/// `npcCombatActorFor(state, npcId)`: один боевой снимок NPC из его
/// долговременного профиля.
pub fn npc_combat_actor_for(state: &Value, npc_id: &str) -> Option<Value> {
    let id = npc_text(Some(&Value::String(npc_id.to_string())), 120);
    let npc = social_npcs(state).iter().find(|candidate| js::s(field(candidate, "id")) == id)?;
    let vital = npc_vital_for(state, &id);
    let placement = npc_placement_for(state, &id, None);
    let mechanics = npc_mechanics_for(state, &id);
    let vitals = |target: &mut Map<String, Value>| {
        target.insert("hp".into(), vital.get("hp").cloned().unwrap_or(Value::Null));
        target.insert("maxHp".into(), vital.get("max_hp").cloned().unwrap_or(Value::Null));
        target.insert("alive".into(), vital.get("alive").cloned().unwrap_or(Value::Null));
    };
    if let (Some(mechanics), Some(placement)) = (mechanics.as_ref(), placement.as_ref()) {
        if let Ok(Value::Object(mut combatant)) = sk_heroes::authored_npc::authored_npc_combatant(Some(npc), Some(mechanics), Some(placement)) {
            vitals(&mut combatant);
            return Some(Value::Object(combatant));
        }
    }
    let mut actor = spread_value(Some(npc));
    actor.insert("id".into(), Value::from(id));
    actor.insert("name".into(), Value::from(npc_text(field(npc, "name"), 160)));
    vitals(&mut actor);
    if let Some(placement) = placement {
        actor.insert("x".into(), placement.get("x").cloned().unwrap_or(Value::Null));
        actor.insert("y".into(), placement.get("y").cloned().unwrap_or(Value::Null));
        if let Some(footprint) = placement.get("footprint").filter(|footprint| js::truthy(Some(footprint))) {
            actor.insert("footprint".into(), footprint.clone());
        }
    }
    Some(Value::Object(actor))
}

/// `npcInteractionTargetForViewer(state, npcId)`: публичный NPC текущей
/// сцены с постом.
pub fn npc_interaction_target_for_viewer(state: &Value, npc_id: &str) -> Option<NpcTarget> {
    let npc = social_npcs(state).iter().find(|candidate| js::string(field(candidate, "id")) == npc_id)?;
    let hidden = field(npc, "visibility").and_then(Value::as_str) == Some("gm_only") && !js::is_true(field(npc, "reveal_on_presence"));
    if hidden || !npc_location_matches_current_scene(npc, state) {
        return None;
    }
    let placement = npc_placement_for(state, npc_id, None)?;
    Some(NpcTarget { npc: npc.clone(), placement })
}

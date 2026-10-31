//! Мир NPC для геометрии движка — переходник к крейту `sk-npc-world`
//! (`server/npc-positioning.mjs`). Задача Р1 держала здесь частную копию
//! шести функций; Р4в заменила её настоящим крейтом.
//!
//! Переходник только меняет форму на границе: идентификаторы — `&str`
//! вместо значений JS, клетки — [`KeySet`] (ключи-числа геометрии) вместо
//! строк `` `${x},${y}` ``, и у [`NpcTarget`] — геометрические помощники
//! ([`NpcTargetGeometry`]). Поведение — целиком крейта.

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexSet;
use sk_core::js;
use sk_geometry::Point;
use sk_npc_world::npc_positioning as world;

pub use sk_npc_world::npc_positioning::NpcTarget;

use super::{footprint_cells, key, Key, KeySet};

/// Геометрия NPC с постом.
pub trait NpcTargetGeometry {
    /// `{ npc, placement }`.
    fn to_value(&self) -> Value;
    /// Точка поста.
    fn position(&self) -> Point;
    /// `{ footprint: placement.footprint }` — площадь поста.
    fn footprint_actor(&self) -> Value;
    /// `footprintCellsFor({ footprint: placement.footprint }, placement)`.
    fn cells(&self) -> Vec<Point>;
    /// `String(npc.id)`.
    fn id(&self) -> String;
}

impl NpcTargetGeometry for NpcTarget {
    fn to_value(&self) -> Value {
        self.to_json()
    }

    fn position(&self) -> Point {
        Point::from_value(Some(&self.placement))
    }

    fn footprint_actor(&self) -> Value {
        let mut actor = Map::new();
        if let Some(footprint) = self.placement.get("footprint") {
            actor.insert("footprint".into(), footprint.clone());
        }
        Value::Object(actor)
    }

    fn cells(&self) -> Vec<Point> {
        footprint_cells(Some(&self.footprint_actor()), Some(self.position()))
    }

    fn id(&self) -> String {
        js::string(self.npc.get("id"))
    }
}

/// Строковый ключ клетки JS (`` `${x},${y}` ``) — в ключ геометрии: обе
/// половины читаются как `Number(…)`, так что `"NaN"` и `"-0"` совпадают с
/// теми же числами геометрии.
fn key_from_text(text: &str) -> Key {
    let (x, y) = text.split_once(',').unwrap_or((text, ""));
    let number = |part: &str| js::number(Some(&Value::String(part.to_string())));
    key(number(x), number(y))
}

fn key_set(cells: IndexSet<String>) -> KeySet {
    cells.iter().map(|cell| key_from_text(cell)).collect()
}

/// `sceneNpcOccupiedCells(state)`: клетки присутствующих социальных NPC.
pub fn scene_npc_occupied_cells(state: &Value) -> KeySet {
    key_set(world::scene_npc_occupied_cells(state))
}

/// `sceneNpcTransitCells(state)`: клетки мирных NPC — пройти можно,
/// закончить ход нельзя.
pub fn scene_npc_transit_cells(state: &Value) -> KeySet {
    key_set(world::scene_npc_transit_cells(state))
}

/// `placedSceneNpcTargets(state)`.
pub fn placed_scene_npc_targets(state: &Value) -> Vec<NpcTarget> {
    world::placed_scene_npc_targets(state)
}

/// `npcPlacementFor(state, npcId, locationId = sceneLocationId(state))`.
pub fn npc_placement_for(state: &Value, npc_id: &str, location_id: Option<&str>) -> Option<Value> {
    let location = location_id.map(|location| json!(location));
    world::npc_placement_for(state, &json!(npc_id), location.as_ref())
}

/// `npcCombatActorFor(state, npcId)`.
pub fn npc_combat_actor_for(state: &Value, npc_id: &str) -> Option<Value> {
    world::npc_combat_actor_for(state, &json!(npc_id))
}

/// `npcInteractionTargetForViewer(state, npcId)`.
pub fn npc_interaction_target_for_viewer(state: &Value, npc_id: &str) -> Option<NpcTarget> {
    world::npc_interaction_target_for_viewer(state, &json!(npc_id))
}

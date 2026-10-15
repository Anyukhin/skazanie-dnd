//! Площадь существа на сцене: видна ли она, расстояние до объекта и между
//! существами, умолчания площади при порождении, помещается ли существо на
//! клетку. Задача Р1.
//!
//! JS: `server/rules-engine.mjs` — `actorFootprintVisible` (2229),
//! `actorObjectDistanceCells` (2239), `blindTargetAllowed` (2245),
//! `distanceBetweenActorPositions` (2256), `normalizeActorFootprintFields`
//! (2266), `stampActorFootprint` (2279), `actorFootprintFits` (2960).

use serde_json::{Map, Value};
use sk_core::{game, js};
use sk_geometry::actor_footprint::{footprint_distance_feet, footprint_metadata_for_size, normalize_footprint_metadata, FootprintMetadata};
use sk_geometry::Point;
use sk_tactical::tactical_map::TacticalMap;

use crate::context::Context;
use crate::tactical_geometry::{
    actor_footprint_cells_at, footprint_placement_edges_blocked, is_walkable_cell, key_of, occupied_positions, point_json, prop_movement_positions, CellMap, KeySet, Scene,
};

/// `actorFootprintVisible(state, id, position)`: хотя бы одна клетка площади
/// раскрыта и проходима; без клеток сцены — видна.
pub fn actor_footprint_visible(state: &Value, id: &str, position: Option<Point>) -> bool {
    actor_footprint_visible_in(&Scene::new(state), id, position)
}

/// [`actor_footprint_visible`] над уже разобранной сценой.
pub fn actor_footprint_visible_in(scene: &Scene<'_>, id: &str, position: Option<Point>) -> bool {
    if scene.cells().is_empty() {
        return true;
    }
    let footprint = actor_footprint_cells_at(scene.state, id, position);
    !footprint.is_empty()
        && footprint.into_iter().any(|cell| {
            let scene_cell = scene.cell(cell);
            scene_cell.is_some_and(|cell| js::is_true(cell.get("revealed"))) && is_walkable_cell(scene_cell)
        })
}

/// `actorObjectDistanceCells(state, actorId, object, position)`: расстояние
/// в клетках от площади существа до объекта сцены (его `footprint` или сама
/// точка); недостижимое — `+∞`.
pub fn actor_object_distance_cells(state: &Value, actor_id: &str, object: &Value, position: Option<Point>) -> f64 {
    let object_cells = match object.get("footprint") {
        Some(Value::Array(cells)) if !cells.is_empty() => Value::Array(cells.clone()),
        _ => Value::Array(vec![object.clone()]),
    };
    let anchor = position.or_else(|| crate::tactical_geometry::actor_point(state, actor_id)).map(point_json);
    footprint_distance_feet(game::find_actor(state, actor_id), Some(&object_cells), anchor.as_ref(), None).map_or(f64::INFINITY, |feet| feet / 5.0)
}

/// `blindTargetAllowed(command, context, state)`: туман войны — знание
/// отряда; ход планировщика противников им не ограничен.
pub fn blind_target_allowed(command: &Value, context: &Context, state: Option<&Value>) -> bool {
    if context.is_npc_scheduler() {
        if let Some(state) = state {
            if game::is_enemy_actor(state, &js::s(command.get("actor_id"))) {
                return true;
            }
        }
    }
    js::is_true(command.get("blind_target")) && (context.is_true("allowBlindTarget") || context.is_admin() || context.is_director())
}

/// `distanceBetweenActorPositions(state, firstId, firstPosition, secondId, secondPosition)`:
/// футы между площадями двух существ; `None` — `null`.
pub fn distance_between_actor_positions(state: &Value, first_id: &str, first_position: Option<Point>, second_id: &str, second_position: Option<Point>) -> Option<f64> {
    let first = first_position.map(point_json);
    let second = second_position.map(point_json);
    footprint_distance_feet(game::find_actor(state, first_id), game::find_actor(state, second_id), first.as_ref(), second.as_ref())
}

fn metadata_json(metadata: FootprintMetadata) -> Value {
    serde_json::json!({ "version": metadata.version, "size": metadata.size })
}

/// `normalizeActorFootprintFields(actor)`: некорректная явная метадата
/// замыкается на запасной размер в одну клетку.
pub fn normalize_actor_footprint_fields(actor: &Value) -> Value {
    let Value::Object(fields) = actor else { return actor.clone() };
    if !fields.contains_key("footprint") {
        return actor.clone();
    }
    let mut result = fields.clone();
    let footprint = normalize_footprint_metadata(fields.get("footprint")).unwrap_or_else(|| footprint_metadata_for_size(Some(&Value::from(1))));
    result.insert("footprint".into(), metadata_json(footprint));
    Value::Object(result)
}

/// `stampActorFootprint(actor, authoritativeSize)`: площадь server-owned
/// порождения из каталога или профиля; поле клиента не источник.
pub fn stamp_actor_footprint(actor: &Value, authoritative_size: Option<&Value>) -> Value {
    let Value::Object(fields) = actor else { return actor.clone() };
    let mut result: Map<String, Value> = fields.clone();
    result.shift_remove("footprint");
    let size = crate::core::coalesce(&[authoritative_size, fields.get("size"), fields.get("creature_size"), fields.get("creatureSize")]).cloned().unwrap_or_else(|| Value::from("medium"));
    result.insert("footprint".into(), metadata_json(footprint_metadata_for_size(Some(&size))));
    Value::Object(result)
}

/// Параметры [`actor_footprint_fits`]; `None` — значение по умолчанию JS.
#[derive(Clone, Copy, Default)]
pub struct FitOptions<'a> {
    /// `map`: `None` — карта сцены, `Some(None)` — явно без карты.
    pub map: Option<Option<&'a TacticalMap>>,
    pub cells: Option<&'a CellMap<'a>>,
    pub occupied: Option<&'a KeySet>,
    pub prop_occupied: Option<&'a KeySet>,
    pub allow_occupied: bool,
}

/// `actorFootprintFits(state, actorId, anchor, options)`: вся площадь на
/// полу, внутренние рёбра проходимы, клетки не заняты реквизитом и (если не
/// разрешено) существами.
pub fn actor_footprint_fits(state: &Value, actor_id: &str, anchor: Point, options: FitOptions<'_>) -> bool {
    let owned_map;
    let map = match options.map {
        Some(map) => map,
        None => {
            owned_map = crate::tactical_geometry::scene_tactical_map(state);
            owned_map.as_ref()
        }
    };
    let owned_cells;
    let cells = match options.cells {
        Some(cells) => cells,
        None => {
            owned_cells = crate::tactical_geometry::tactical_cell_map(state);
            &owned_cells
        }
    };
    let owned_occupied;
    let occupied = match options.occupied {
        Some(occupied) => occupied,
        None => {
            owned_occupied = occupied_positions(state, Some(actor_id), true);
            &owned_occupied
        }
    };
    let owned_props;
    let prop_occupied = match options.prop_occupied {
        Some(props) => props,
        None => {
            owned_props = if map.is_some() { prop_movement_positions(map) } else { KeySet::new() };
            &owned_props
        }
    };
    let actor = game::find_actor(state, actor_id);
    let footprint = actor_footprint_cells_at(state, actor_id, Some(anchor));
    if footprint.is_empty() || map.is_some() && footprint_placement_edges_blocked(map, actor, Some(anchor)) {
        return false;
    }
    for cell in footprint {
        let key = key_of(cell);
        if !is_walkable_cell(cells.get(&key).copied()) || prop_occupied.contains(&key) {
            return false;
        }
        if !options.allow_occupied && occupied.contains(&key) {
            return false;
        }
    }
    true
}

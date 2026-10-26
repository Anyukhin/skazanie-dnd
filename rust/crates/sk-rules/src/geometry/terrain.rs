//! Местность и цена шага: труднопроходимые клетки (паутина отдельно — для
//! `web-walker`), тяжёлая местность с множителем, единая формула цены шага
//! для `MoveActor` и планировщика NPC, цена готового пути. Задача Р1.
//!
//! JS: `server/rules-engine.mjs` — `difficultTerrainLookupFor` (10128),
//! `heavyTerrainMultiplierAt` (10166), `difficultTerrainKindsAt` (10178),
//! `movementStepCostFor` (10209), `movementCostOfPath` (10246).

use std::collections::HashMap;

use serde_json::Value;
use sk_core::{game, js};
use sk_geometry::actor_footprint::footprint_size_for;
use sk_geometry::Point;
use sk_tactical::tactical_map::TacticalMap;

use crate::areas::shape::{active_area_effects_at_in, position_in_effect_in};
use crate::core::{condition_ids_for, ignores_difficult_terrain, monster_trait_for};
use crate::tactical_geometry::{footprint_cells, is_safe, key, key_of, map_cell_at, occupied_positions, Key, KeySet, Scene};

/// Индекс длящихся областей с труднопроходимостью: явные клетки и области по
/// центру — паутина отдельно; тяжёлая местность — со своим множителем.
#[derive(Default)]
pub struct DifficultTerrainLookup<'a> {
    pub web_cells: KeySet,
    pub other_cells: KeySet,
    pub web_areas: Vec<&'a Value>,
    pub other_areas: Vec<&'a Value>,
    pub heavy_cells: HashMap<Key, i64>,
    pub heavy_areas: Vec<(&'a Value, i64)>,
}

fn is_web(effect: &Value) -> bool {
    js::s(effect.get("spell_id")).to_lowercase() == "web"
}

/// `difficultTerrainLookupFor(state)`.
pub fn difficult_terrain_lookup_for(state: &Value) -> DifficultTerrainLookup<'_> {
    let mut lookup = DifficultTerrainLookup::default();
    let effects = js::path(state, &["mechanics", "active_effects"]).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    for effect in effects {
        if !js::is_true(effect.get("difficult_terrain")) {
            continue;
        }
        let multiplier = js::safe_int(effect.get("movement_cost_multiplier"), 2).clamp(2, 4);
        let cells = effect.get("cells").and_then(Value::as_array);
        if multiplier > 2 {
            match cells {
                Some(cells) => {
                    for cell in cells {
                        let entry = lookup.heavy_cells.entry(key(js::number(cell.get("x")), js::number(cell.get("y")))).or_insert(2);
                        *entry = (*entry).max(multiplier);
                    }
                }
                None => lookup.heavy_areas.push((effect, multiplier)),
            }
        }
        let web = is_web(effect);
        match cells {
            Some(cells) => {
                let target = if web { &mut lookup.web_cells } else { &mut lookup.other_cells };
                for cell in cells {
                    let x = js::number(cell.get("x"));
                    let y = js::number(cell.get("y"));
                    if is_safe(x) && is_safe(y) {
                        target.insert(key(x, y));
                    }
                }
            }
            None => {
                if web {
                    lookup.web_areas.push(effect);
                } else {
                    lookup.other_areas.push(effect);
                }
            }
        }
    }
    lookup
}

/// Точки площади `actor` с anchor `position` (или сама точка без `actor`);
/// пустая площадь — сама точка.
fn inspected_points(position: Point, actor: Option<&Value>) -> Vec<Point> {
    let points = match actor {
        Some(actor) => footprint_cells(Some(actor), Some(position)),
        None => vec![position],
    };
    if points.is_empty() {
        vec![position]
    } else {
        points
    }
}

/// `heavyTerrainMultiplierAt(state, position, lookup, actor)`: наибольший
/// множитель цены шага (2 — обычная труднопроходимость).
pub fn heavy_terrain_multiplier_at(scene: &Scene<'_>, position: Point, lookup: Option<&DifficultTerrainLookup<'_>>, actor: Option<&Value>) -> i64 {
    let Some(lookup) = lookup.filter(|lookup| !lookup.heavy_cells.is_empty() || !lookup.heavy_areas.is_empty()) else { return 2 };
    let mut multiplier = 2;
    for point in inspected_points(position, actor) {
        multiplier = multiplier.max(lookup.heavy_cells.get(&key_of(point)).copied().unwrap_or(2));
    }
    for (effect, area_multiplier) in &lookup.heavy_areas {
        if *area_multiplier > multiplier && position_in_effect_in(scene, Some(position), effect, actor) {
            multiplier = *area_multiplier;
        }
    }
    multiplier
}

/// Причины труднопроходимости клетки: паутина и всё остальное.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TerrainKinds {
    pub web: bool,
    pub other: bool,
}

/// `difficultTerrainKindsAt(state, position, map, lookup, actor)`.
///
/// Без индекса (`lookup` `None`) учитываются все длящиеся области в клетке —
/// так в JS.
pub fn difficult_terrain_kinds_at(scene: &Scene<'_>, position: Point, map: Option<&TacticalMap>, lookup: Option<&DifficultTerrainLookup<'_>>, actor: Option<&Value>) -> TerrainKinds {
    let inspected = inspected_points(position, actor);
    let static_terrain = inspected.iter().any(|point| map.and_then(|map| map_cell_at(map, point.x, point.y)).map_or(1.0, |cell| f64::from(cell.move_cost)) > 1.0);
    let Some(lookup) = lookup else {
        let effects = active_area_effects_at_in(scene, Some(position), actor);
        return TerrainKinds { web: effects.iter().any(|effect| is_web(effect)), other: static_terrain || effects.iter().any(|effect| !is_web(effect)) };
    };
    TerrainKinds {
        web: inspected.iter().any(|point| lookup.web_cells.contains(&key_of(*point))) || lookup.web_areas.iter().any(|effect| position_in_effect_in(scene, Some(position), effect, actor)),
        other: static_terrain
            || inspected.iter().any(|point| lookup.other_cells.contains(&key_of(*point)))
            || lookup.other_areas.iter().any(|effect| position_in_effect_in(scene, Some(position), effect, actor)),
    }
}

/// `movementStepCostFor(state, actorId, { tacticalMap })`: единственная
/// формула цены шага — её считают и `MoveActor`, и планировщик хода NPC.
pub struct MovementStepCost<'a> {
    scene: Scene<'a>,
    explicit_map: Option<Option<&'a TacticalMap>>,
    lookup: DifficultTerrainLookup<'a>,
    mover: Option<&'a Value>,
    mover_side: i64,
    creature_cells: KeySet,
    pub ignores_terrain: bool,
    pub web_walker: bool,
    pub crawling: bool,
}

/// `movementStepCostFor(state, actorId, { tacticalMap })`: `tactical_map`
/// `None` — карта сцены, `Some(None)` — явно без карты.
pub fn movement_step_cost_for<'a>(state: &'a Value, actor_id: &str, tactical_map: Option<Option<&'a TacticalMap>>) -> MovementStepCost<'a> {
    let mover = game::find_actor(state, actor_id);
    MovementStepCost {
        scene: Scene::new(state),
        explicit_map: tactical_map,
        lookup: difficult_terrain_lookup_for(state),
        mover,
        mover_side: footprint_size_for(mover),
        creature_cells: occupied_positions(state, Some(actor_id), true),
        ignores_terrain: ignores_difficult_terrain(state, actor_id),
        web_walker: monster_trait_for(mover, "web-walker").is_some_and(|value| js::truthy(Some(value))),
        crawling: condition_ids_for(state, actor_id).contains("prone"),
    }
}

impl<'a> MovementStepCost<'a> {
    /// Карта, по которой считается цена (`map` результата JS).
    pub fn map(&self) -> Option<&TacticalMap> {
        match self.explicit_map {
            Some(map) => map,
            None => self.scene.map(),
        }
    }

    fn large_mover(&self) -> Option<&'a Value> {
        if self.mover_side > 1 {
            self.mover
        } else {
            None
        }
    }

    fn kinds_at(&self, step: Point, path_map: Option<&TacticalMap>) -> TerrainKinds {
        difficult_terrain_kinds_at(&self.scene, step, path_map, Some(&self.lookup), self.large_mover())
    }

    /// `difficultAt(step, pathMap = map)`.
    pub fn difficult_at(&self, step: Point) -> bool {
        self.difficult_at_on(step, self.map())
    }

    /// `difficultAt(step, pathMap)`.
    pub fn difficult_at_on(&self, step: Point, path_map: Option<&TacticalMap>) -> bool {
        let terrain = self.kinds_at(step, path_map);
        terrain.web || terrain.other
    }

    /// `chargesDifficultAt(step, pathMap = map)`.
    pub fn charges_difficult_at(&self, step: Point) -> bool {
        self.charges_difficult_at_on(step, self.map())
    }

    /// `chargesDifficultAt(step, pathMap)`.
    pub fn charges_difficult_at_on(&self, step: Point, path_map: Option<&TacticalMap>) -> bool {
        if self.ignores_terrain {
            return false;
        }
        let terrain = self.kinds_at(step, path_map);
        terrain.other || (terrain.web && !self.web_walker)
    }

    /// `throughCreatureAt(step)`: шаг в чужое пространство.
    pub fn through_creature_at(&self, step: Point) -> bool {
        if self.creature_cells.is_empty() {
            return false;
        }
        let cells = if self.mover_side > 1 { footprint_cells(self.mover, Some(step)) } else { vec![step] };
        cells.into_iter().any(|cell| self.creature_cells.contains(&key_of(cell)))
    }

    /// `stepCost(step, pathMap = map)`.
    pub fn step_cost(&self, step: Point) -> f64 {
        self.step_cost_on(step, self.map())
    }

    /// `stepCost(step, pathMap)`: 5 футов, плюс труднопроходимость (по
    /// множителю) или чужое пространство, плюс ползком.
    pub fn step_cost_on(&self, step: Point, path_map: Option<&TacticalMap>) -> f64 {
        let terrain = if self.charges_difficult_at_on(step, path_map) {
            5 * (heavy_terrain_multiplier_at(&self.scene, step, Some(&self.lookup), self.large_mover()) - 1)
        } else if !self.ignores_terrain && self.through_creature_at(step) {
            5
        } else {
            0
        };
        (5 + terrain + if self.crawling { 5 } else { 0 }) as f64
    }
}

/// `movementCostOfPath(state, actorId, path, options)`: цена уже выбранного
/// маршрута по той же формуле.
pub fn movement_cost_of_path(state: &Value, actor_id: &str, path: &[Point], tactical_map: Option<Option<&TacticalMap>>) -> f64 {
    let cost = movement_step_cost_for(state, actor_id, tactical_map);
    path.iter().map(|step| cost.step_cost(*step)).sum()
}

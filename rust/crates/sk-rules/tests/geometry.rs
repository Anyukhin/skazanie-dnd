//! Сверка задачи Р1 с эталоном JS (`fixtures/geometry.json`, генератор —
//! `fixtures/gen-geometry.mjs`): тактическая геометрия, площадь и помещение,
//! вынужденное перемещение, местность и цена шага, прыжок, скорость и
//! проекция движения, области и цели заклинаний, синхронизация карты и
//! клеток, мир NPC (`npc-positioning`, теперь — крейт `sk-npc-world`).
//!
//! Состояние эталона собирается так же, как в генераторе: база, карта и
//! производные клетки `legacyCellsFromTacticalMap` с правками. Выход —
//! JSON, крупный — `sha256:` строки `JSON.stringify`, множества —
//! отсортированные ключи `x,y`.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::{game, js, RuleError};
use sk_geometry::Point;
use sk_rules::areas::shape as area;
use sk_rules::context::Context;
use sk_rules::geometry::{footprint, forced, movement, terrain};
use sk_rules::tactical_geometry::npc_positioning::NpcTargetGeometry;
use sk_rules::tactical_geometry::{self as geo, npc_positioning as npc, KeySet, PathOptions, Scene};
use sk_rules::{scene_map_sync as sync, speed, targets};
use sk_tactical::tactical_map as tmap;

const FIXTURE: &str = include_str!("../fixtures/geometry.json");
static DATA: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(FIXTURE).expect("эталон — JSON"));
const U: &str = "__undefined__";

fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}

/// Состояние эталона: база, карта, производные клетки с правками.
fn assemble(spec: &Value) -> Value {
    let mut state = spec["base"].clone();
    if !state.is_object() {
        state = json!({});
    }
    let mut scene = state.get("scene").and_then(Value::as_object).cloned().unwrap_or_default();
    let map_index = &spec["map"];
    if !map_index.is_null() {
        let raw = match spec.get("map_value") {
            Some(value) => value.clone(),
            None => DATA["maps"][map_index.as_u64().expect("индекс карты") as usize].clone(),
        };
        let mut cells = tmap::deserialize_tactical_map(&raw).map(|map| tmap::legacy_cells_from_tactical_map(&map)).unwrap_or_default();
        for patch in array(&spec["patches"]) {
            let index = patch[0].as_u64().expect("индекс клетки") as usize;
            if let (Some(Value::Object(cell)), Some(fields)) = (cells.get_mut(index), patch[1].as_object()) {
                for (key, value) in fields {
                    cell.insert(key.clone(), value.clone());
                }
            }
        }
        scene.insert("map".into(), raw);
        if spec.get("cells") != Some(&Value::Bool(false)) {
            scene.insert("cells".into(), Value::Array(cells));
        }
    }
    state["scene"] = Value::Object(scene);
    state
}

static STATES: LazyLock<Vec<Value>> = LazyLock::new(|| array(&DATA["states"]).iter().map(assemble).collect());

fn undefined(value: &Value) -> bool {
    value.as_str() == Some(U)
}

/// Аргумент: `undefined` — `None`.
fn opt(value: &Value) -> Option<&Value> {
    (!undefined(value)).then_some(value)
}

/// Точка-аргумент: `undefined` и `null` — `None`.
fn point(value: &Value) -> Option<Point> {
    (!undefined(value) && !value.is_null()).then(|| Point::from_value(Some(value)))
}

/// `{ x: Number(v?.x), y: Number(v?.y) }`.
fn number_point(value: &Value) -> Point {
    Point::from_value(opt(value))
}

/// `Number(value)`; `undefined` — `NaN`.
fn number(value: &Value) -> f64 {
    js::number(opt(value))
}

fn text(value: &Value) -> String {
    js::s(opt(value))
}

/// Выход так, как его пишет генератор.
fn out(value: Value) -> Value {
    let text = js::stringify(&value);
    if text.encode_utf16().count() > 160 {
        Value::String(format!("sha256:{}", sk_core::hash::sha256_hex(text)))
    } else {
        value
    }
}

fn sha(value: &Value) -> String {
    sk_core::hash::sha256_hex(js::stringify(value))
}

fn keys(set: &KeySet) -> Value {
    let mut keys: Vec<String> = set.iter().map(|(x, y)| geo::position_key(Point::new(f64::from_bits(*x), f64::from_bits(*y)))).collect();
    keys.sort();
    json!(keys)
}

fn points(list: &[Point]) -> Value {
    geo::points_json(list)
}

fn path_arg(value: &Value) -> Vec<Point> {
    array(value).iter().map(|entry| Point::from_value(Some(entry))).collect()
}

fn opt_num(value: Option<f64>) -> Value {
    value.map_or(Value::Null, js::num)
}

/// `attempt(fn)` генератора.
fn attempt(result: Result<Value, RuleError>) -> Value {
    match result {
        Ok(value) => json!({ "ok": out(value) }),
        Err(error) => json!({ "err": [error.code, error.message] }),
    }
}

fn actor<'a>(state: &'a Value, id: &Value) -> Option<&'a Value> {
    game::find_actor(state, &text(id))
}

/// `arg(actorArg) === undefined ? null : findActor(state, actorArg)`.
fn optional_actor<'a>(state: &'a Value, id: &Value) -> Option<&'a Value> {
    opt(id).and_then(|id| game::find_actor(state, &js::s(Some(id))))
}

fn effect(state: &Value, index: &Value) -> Value {
    state["mechanics"]["active_effects"][index.as_u64().expect("индекс области") as usize].clone()
}

fn spell(index: &Value) -> &'static Value {
    &DATA["spells"][index.as_u64().expect("индекс заклинания") as usize]
}

fn bool_arg(value: &Value) -> bool {
    value == &Value::Bool(true)
}

fn npc_target(target: &npc::NpcTarget) -> Value {
    target.to_value()
}

/// Сверка одного вызова; `None` — вызов не сверяется (ошибка JS не правила).
fn evaluate(case: &Value) -> Option<Value> {
    let f = DATA["functions"][case[0].as_u64().expect("номер функции") as usize].as_str().expect("имя функции");
    let a = array(&case[2]);
    let null = Value::Null;
    let arg = |index: usize| a.get(index).unwrap_or(&null);
    let state_index = case[1].as_i64().unwrap_or(-1);
    let empty = json!({});
    let state: &Value = if state_index >= 0 { &STATES[state_index as usize] } else { &empty };
    let map = geo::scene_tactical_map(state);
    let value = match f {
        "cellsVisibleFrom" => {
            let radius = if undefined(arg(1)) { geo::DOORWAY_SIGHT_CELLS } else { number(arg(1)) };
            let door = opt(arg(2)).and_then(Value::as_str);
            let cells = geo::cells_visible_from(map.as_ref()?, number_point(arg(0)), radius, door);
            out(Value::Array(cells.into_iter().map(|cell| cell.to_value()).collect()))
        }
        "sightEdgeBlocked" => json!(geo::sight_edge_blocked(map.as_ref(), number_point(arg(0)), number_point(arg(1)))),
        "footprintPlacementEdgesBlocked" => json!(geo::footprint_placement_edges_blocked(map.as_ref(), actor(state, arg(0)), point(arg(1)))),
        "footprintStepBlocked" => json!(geo::footprint_step_blocked(map.as_ref(), actor(state, arg(0)), number_point(arg(1)), number_point(arg(2)))),
        "transparentMapCell" => {
            let at = number_point(arg(0));
            let cell = map.as_ref().and_then(|map| geo::map_cell_at(map, at.x, at.y));
            json!(geo::is_transparent_map_cell(cell.as_ref()))
        }
        "downedHeroPositions" => out(keys(&geo::downed_hero_positions(state, opt(arg(0)).and_then(Value::as_str)))),
        "allyPassablePositions" => out(keys(&geo::ally_passable_positions(state, &text(arg(0))))),
        "occupiedPositions" => out(keys(&geo::occupied_positions(state, opt(arg(0)).and_then(Value::as_str), bool_arg(arg(1))))),
        "propMovementPositions" => out(keys(&geo::prop_movement_positions(map.as_ref()))),
        "shortestTacticalPath" => {
            let id = text(arg(0));
            let destination = number_point(arg(1));
            let allow = bool_arg(arg(2));
            let path = if arg(3).as_str() == Some("weighted") {
                let cost = terrain::movement_step_cost_for(state, &id, None);
                let step = |point: Point, map: Option<&tmap::TacticalMap>| cost.step_cost_on(point, map);
                geo::shortest_tactical_path(state, &id, destination, PathOptions { allow_occupied_destination: allow, step_cost: Some(&step), tactical_map: Some(cost.map()) })
            } else {
                geo::shortest_tactical_path(state, &id, destination, PathOptions { allow_occupied_destination: allow, ..PathOptions::default() })
            };
            out(path.map_or(Value::Null, |path| points(&path)))
        }
        "lineCells" => out(points(&geo::line_cells(number_point(arg(0)), number_point(arg(1))))),
        "assertClearTrajectory" => attempt(geo::assert_clear_trajectory(state, number_point(arg(0)), number_point(arg(1))).map(|line| points(&line))),
        "trajectoryDetails" => out(geo::trajectory_details(state, number_point(arg(0)), number_point(arg(1))).to_value()),
        "actorTrajectoryDetails" => {
            let list = geo::actor_trajectory_details(state, &text(arg(0)), &text(arg(1)), point(arg(2)), point(arg(3)), bool_arg(arg(4)));
            out(Value::Array(list.iter().map(geo::ActorTrajectory::to_value).collect()))
        }
        "elevationAt" => json!(geo::elevation_at(state, point(arg(0)))),
        "highGroundBetween" => {
            let distance = opt(arg(2)).filter(|value| !value.is_null()).map(|value| js::number(Some(value)));
            json!(geo::high_ground_between(state, point(arg(0)), point(arg(1)), distance))
        }
        "coverBetween" => out(geo::cover_between(state, &text(arg(0)), &text(arg(1)), point(arg(2)), point(arg(3)))),
        "hasClearTrajectory" => json!(geo::has_clear_trajectory(state, number_point(arg(0)), number_point(arg(1)))),
        "actorFootprintVisible" => json!(footprint::actor_footprint_visible(state, &text(arg(0)), point(arg(1)))),
        "actorObjectDistanceCells" => js::num(footprint::actor_object_distance_cells(state, &text(arg(0)), arg(1), point(arg(2)))),
        "distanceBetweenActorPositions" => opt_num(footprint::distance_between_actor_positions(state, &text(arg(0)), point(arg(1)), &text(arg(2)), point(arg(3)))),
        "actorFootprintFits" => {
            let options = footprint::FitOptions { allow_occupied: bool_arg(arg(2)), ..footprint::FitOptions::default() };
            json!(footprint::actor_footprint_fits(state, &text(arg(0)), number_point(arg(1)), options))
        }
        "forcedPushPath" => out(points(&forced::forced_push_path(state, &text(arg(0)), point(arg(1)), number(arg(2))))),
        "forcedPullPath" => out(points(&forced::forced_pull_path(state, &text(arg(0)), point(arg(1)), number(arg(2))))),
        "forcedRandomStepPath" => out(points(&forced::forced_random_step_path(state, &text(arg(0)), opt(arg(1))))),
        "farthestSafeDestinationAwayFrom" => {
            let found = forced::farthest_safe_destination_away_from(state, &text(arg(0)), point(arg(1)), number(arg(2)));
            out(found.map_or(Value::Null, |entry| json!({ "position": geo::point_json(entry.position), "path": points(&entry.path) })))
        }
        "hasClearActorTrajectory" => json!(forced::has_clear_actor_trajectory(state, &text(arg(0)), &text(arg(1)), point(arg(2)), point(arg(3)), bool_arg(arg(4)))),
        "assertClearActorTrajectory" => attempt(forced::assert_clear_actor_trajectory(state, &text(arg(0)), &text(arg(1)), point(arg(2)), point(arg(3)), bool_arg(arg(4))).map(|line| points(&line))),
        "hasClearActorToPoint" => json!(forced::has_clear_actor_to_point(state, &text(arg(0)), point(arg(1)), number_point(arg(2)))),
        "assertClearActorToPoint" => attempt(forced::assert_clear_actor_to_point(state, &text(arg(0)), point(arg(1)), number_point(arg(2))).map(|line| points(&line))),
        "assertVoluntaryMovementPath" => {
            let result = movement::assert_voluntary_movement_path(state, &text(arg(0)), number_point(arg(1)), number_point(arg(2)), &path_arg(arg(3)));
            attempt(result.map(|()| Value::from(U)))
        }
        "longJumpMovementFor" => {
            let minimum = if undefined(arg(3)) { 5.0 } else { number(arg(3)) };
            attempt(movement::long_jump_movement_for(state, &text(arg(0)), opt(arg(1)), bool_arg(arg(2)), minimum).map(|jump| jump.to_value()))
        }
        "completedStraightCharge" => json!(movement::completed_straight_charge(state, &text(arg(0)), &text(arg(1)), opt(arg(2)))),
        "effectiveSpeedFeet" => json!(speed::effective_speed_feet(state, actor(state, arg(0)).unwrap_or(&Value::Null), &text(arg(0)))),
        "activeLongstriderConditions" => out(Value::Array(speed::active_longstrider_conditions(state, &text(arg(0))).into_iter().cloned().collect())),
        "movementBonusFeet" => json!(speed::movement_bonus_feet(state, &text(arg(0)), arg(1).as_i64().unwrap_or(0))),
        "movementForActor" => out(movement::movement_for_actor(state, &text(arg(0)))),
        "explorationMovementDurationSeconds" => attempt(movement::exploration_movement_duration_seconds(state, &text(arg(0)), number(arg(1))).map(js::num)),
        "heavyTerrainMultiplierAt" => {
            let lookup = terrain::difficult_terrain_lookup_for(state);
            json!(terrain::heavy_terrain_multiplier_at(&Scene::new(state), number_point(arg(0)), Some(&lookup), optional_actor(state, arg(1))))
        }
        "difficultTerrainKindsAt" => {
            let lookup = terrain::difficult_terrain_lookup_for(state);
            let kinds = terrain::difficult_terrain_kinds_at(&Scene::new(state), number_point(arg(0)), map.as_ref(), bool_arg(arg(2)).then_some(&lookup), optional_actor(state, arg(1)));
            json!({ "web": kinds.web, "other": kinds.other })
        }
        "movementStepCostFor" => {
            let cost = terrain::movement_step_cost_for(state, &text(arg(0)), None);
            let steps: Vec<Value> = path_arg(arg(1))
                .into_iter()
                .map(|step| json!([js::num(cost.step_cost(step)), cost.difficult_at(step), cost.charges_difficult_at(step), cost.through_creature_at(step)]))
                .collect();
            out(json!({ "ignoresTerrain": cost.ignores_terrain, "webWalker": cost.web_walker, "crawling": cost.crawling, "steps": steps }))
        }
        "movementCostOfPath" => js::num(terrain::movement_cost_of_path(state, &text(arg(0)), &path_arg(arg(1)), None)),
        "distanceBetweenActors" => opt_num(targets::distance_between_actors(state, &text(arg(0)), &text(arg(1)))),
        "deathSaveTracker" => {
            let id = text(arg(0));
            json!([targets::death_save_tracker(state, &id).to_value(), targets::is_dead_hero(state, &id), targets::is_dying_hero(state, &id), targets::is_unstable_dying_hero(state, &id)])
        }
        "knightDistanceFeet" => opt_num(targets::knight_distance_feet(state, &text(arg(0)), &text(arg(1)))),
        "areaCasterSideIds" => out(json!(area::area_caster_side_ids(state, &text(arg(0))))),
        "areaCenterOf" => {
            let effect = effect(state, arg(0));
            match area::area_center_of(state, &effect) {
                Some(center) => geo::point_json(center),
                None => effect.get("center").cloned().unwrap_or(Value::from(U)),
            }
        }
        "positionInEffect" => json!(area::position_in_effect(state, point(arg(0)), &effect(state, arg(1)), optional_actor(state, arg(2)))),
        "areaEffectAffectsActor" => json!(area::area_effect_affects_actor(state, point(arg(0)), &effect(state, arg(1)), actor(state, arg(2)))),
        "activeAreaEffectsAt" => {
            let effects = array(&state["mechanics"]["active_effects"]);
            let found = area::active_area_effects_at(state, point(arg(0)), optional_actor(state, arg(1)));
            out(json!(found.into_iter().map(|entry| effects.iter().position(|candidate| std::ptr::eq(candidate, entry)).map_or(-1, |index| index as i64)).collect::<Vec<_>>()))
        }
        "areaCellsOf" => out(points(&area::area_cells_of(state, &effect(state, arg(0))))),
        "areasOverlap" => json!(area::areas_overlap(state, &effect(state, arg(0)), &effect(state, arg(1)))),
        "spellTargetsAt" => {
            let targets = area::spell_targets_at(state, arg(0), spell(arg(1)));
            out(Value::Array(targets.iter().map(|actor| json!([game::actor_id(actor), sha(actor)])).collect()))
        }
        "npcSpellTargetsAt" => {
            let targets = area::npc_spell_targets_at(state, arg(0), spell(arg(1)));
            out(Value::Array(targets.iter().map(|entry| json!([entry.id(), sha(&entry.npc), sha(&entry.placement)])).collect()))
        }
        "wallCells" => out(points(&area::wall_cells(state, arg(0), spell(arg(1))))),
        "spellCreatureFor" => out(targets::spell_creature_for(state, &text(arg(0)), spell(arg(1))).unwrap_or(Value::Null)),
        "areaLineOfEffectClear" => json!(area::area_line_of_effect_clear(state, point(arg(0)), point(arg(1)), &area::AreaSpell::from_spell(spell(arg(2))))),
        "areaTargetHasLineOfEffect" => {
            let center = point(arg(2));
            let radius = number(arg(6));
            let kind = arg(5).as_str().unwrap_or("all");
            let within = |target: Point, origin: Option<Point>| match kind {
                "sphere" => area::position_in_area(Some(target), origin, radius, "sphere", f64::NAN, None),
                "cone" => area::position_in_cone(Some(target), origin, center, radius),
                "cube" => area::position_in_directed_cube(Some(target), origin, center, radius),
                _ => true,
            };
            let scene = Scene::new(state);
            json!(area::area_target_has_line_of_effect(&scene, arg(0), spell(arg(1)), center, point(arg(4)), actor(state, arg(3)), &within))
        }
        "actorInArea" => {
            let shape = area::shape_param(opt(arg(4)));
            let origin_actor = opt(arg(5)).map(|value| js::s(Some(value)));
            json!(area::actor_in_area(state, &text(arg(0)), point(arg(1)), point(arg(2)), number(arg(3)), shape, origin_actor.as_deref(), point(arg(6))))
        }
        "npcPlacementFor" => out(npc::npc_placement_for(state, &text(arg(0)), None).unwrap_or(Value::Null)),
        "npcInteractionTargetForViewer" => out(npc::npc_interaction_target_for_viewer(state, &text(arg(0))).map_or(Value::Null, |target| npc_target(&target))),
        "npcCombatActorFor" => out(npc::npc_combat_actor_for(state, &text(arg(0))).unwrap_or(Value::Null)),
        "sceneNpcOccupiedCells" => out(keys(&npc::scene_npc_occupied_cells(state))),
        "sceneNpcTransitCells" => out(keys(&npc::scene_npc_transit_cells(state))),
        "placedSceneNpcTargets" => out(Value::Array(npc::placed_scene_npc_targets(state).iter().map(npc_target).collect())),
        "sceneNpcOccupiedCellsLegacy" => out(keys(&sk_society::retention_context::with_retention_mode("legacy", || npc::scene_npc_occupied_cells(state)).expect("режим"))),
        "cellKinds" => {
            let cell = (!arg(0).is_null()).then_some(arg(0));
            json!([geo::is_walkable_cell(cell), geo::is_transparent_cell(cell)])
        }
        "actorShape" => {
            let subject = (!arg(0).is_null()).then_some(arg(0));
            json!([
                geo::creature_size_rank(subject),
                js::num(targets::creature_height_feet(subject)),
                area::is_large_or_larger(subject),
                movement::size_rank_by_name(subject.and_then(|actor| actor.get("size"))),
            ])
        }
        "footprintFields" => out(json!([footprint::normalize_actor_footprint_fields(arg(0)), footprint::stamp_actor_footprint(arg(0), opt(arg(1)))])),
        "pointArea" => {
            let (position, center, toward) = (point(arg(0)), point(arg(1)), point(arg(2)));
            let (radius, side) = (number(arg(3)), number(arg(4)));
            let shape = area::shape_param(opt(arg(5)));
            let version = opt(arg(6)).and_then(Value::as_str);
            let bounds = area::point_cube_bounds(center, radius, side)
                .map_or(Value::Null, |bounds| json!({ "minX": js::num(bounds.min_x), "minY": js::num(bounds.min_y), "maxX": js::num(bounds.max_x), "maxY": js::num(bounds.max_y) }));
            json!([
                area::position_in_area(position, center, radius, shape, side, version),
                area::position_in_cone(position, center, toward, radius),
                area::position_in_directed_cube(position, center, toward, radius),
                area::position_in_point_cube(position, center, radius, side),
                bounds,
                js::num(area::point_cube_cell_count(radius, side)),
            ])
        }
        "spellShape" => {
            let card = spell(arg(0));
            let center = (!arg(1).is_null()).then_some(arg(1));
            let target = (!arg(2).is_null()).then_some(arg(2));
            out(json!([
                area::circular_spell_geometry(card),
                Value::Object(area::circular_area_metadata(card, center)),
                area::spreads_around_corners(&area::AreaSpell::from_spell(card)),
                forced::forced_movement_size_allowed(card, target),
            ]))
        }
        "blindTargetAllowed" => {
            let context = Context::from_json(arg(1));
            json!(footprint::blind_target_allowed(arg(0), &context, bool_arg(arg(2)).then_some(state)))
        }
        "classSpeedBonusFeet" => json!(speed::class_speed_bonus_feet(arg(0))),
        "syncSceneCells" | "ensureSceneTacticalMap" | "rebuildSceneTacticalMap" | "reconcileSceneTacticalMap" | "writeSceneTacticalMap" => {
            let mut copy = state.clone();
            let result: Result<Option<tmap::TacticalMap>, tmap::TacticalMapError> = match f {
                "syncSceneCells" => {
                    sync::sync_scene_cells(&mut copy, None);
                    Ok(None)
                }
                "ensureSceneTacticalMap" => sync::ensure_scene_tactical_map(&mut copy),
                "rebuildSceneTacticalMap" => sync::rebuild_scene_tactical_map(&mut copy),
                "reconcileSceneTacticalMap" => sync::reconcile_scene_tactical_map(&mut copy),
                _ => {
                    let other = tmap::deserialize_tactical_map(&DATA["maps"][arg(0).as_u64().expect("карта") as usize]).expect("карта эталона");
                    sync::write_scene_tactical_map(&mut copy, &other).map(|()| None)
                }
            };
            match result {
                Ok(map) => {
                    let first = map.map_or(Value::Null, |map| Value::String(sha(&tmap::serialize_tactical_map(&map).expect("сериализация"))));
                    json!({ "ok": [first, sha(copy.get("scene").unwrap_or(&Value::Null))] })
                }
                Err(error) => json!({ "err": [error.code, error.message] }),
            }
        }
        "legacyCompare" => {
            let cells: Vec<Value> = state["scene"].get("cells").and_then(Value::as_array).cloned().unwrap_or_default();
            let derived = state["scene"].get("map").and_then(|raw| tmap::deserialize_tactical_map(raw).ok()).map(|map| tmap::legacy_cells_from_tactical_map(&map)).unwrap_or_default();
            json!([sync::same_legacy_grid(&cells, &derived), sync::legacy_cells_diverged(&cells, &derived)])
        }
        "mergeLegacyCells" => {
            let cells: Vec<Value> = state["scene"].get("cells").and_then(Value::as_array).cloned().unwrap_or_default();
            let mut map = tmap::deserialize_tactical_map(&state["scene"]["map"]).expect("карта");
            match sync::merge_legacy_cells(&mut map, &cells) {
                Ok(()) => Value::String(sha(&tmap::serialize_tactical_map(&map).expect("сериализация"))),
                Err(error) => Value::String(format!("error:{}", error.code)),
            }
        }
        other => panic!("неизвестная функция эталона {other}"),
    };
    Some(value)
}

#[test]
fn geometry_matches_js() {
    let mut failures: BTreeMap<String, (usize, String)> = BTreeMap::new();
    let mut checked: BTreeMap<String, usize> = BTreeMap::new();
    let mut skipped = 0usize;
    for case in array(&DATA["cases"]) {
        let f = DATA["functions"][case[0].as_u64().unwrap_or(0) as usize].as_str().unwrap_or_default().to_string();
        let expected = &case[3];
        if expected.get("fault").is_some() {
            skipped += 1;
            continue;
        }
        let Some(actual) = evaluate(case) else {
            skipped += 1;
            continue;
        };
        *checked.entry(f.clone()).or_default() += 1;
        if actual != *expected {
            let entry = failures.entry(f.clone()).or_insert((0, String::new()));
            if entry.0 == 0 {
                entry.1 = format!("s={} a={} JS={} Rust={}", case[1], js::stringify(&case[2]), js::stringify(expected), js::stringify(&actual));
            }
            entry.0 += 1;
        }
    }
    let total: usize = checked.values().sum();
    eprintln!("сверено вызовов: {total}, пропущено: {skipped}, функций: {}", checked.len());
    if !failures.is_empty() {
        let report: Vec<String> = failures.iter().map(|(name, (count, first))| format!("{name}: {count} из {}\n  {first}", checked.get(name).copied().unwrap_or(0))).collect();
        panic!("расхождения с JS:\n{}", report.join("\n"));
    }
}

#[test]
fn fixture_covers_corpus_states() {
    let corpus = array(&DATA["states"]).iter().filter(|spec| spec.get("corpus").is_some()).count();
    assert!(corpus >= 20, "в эталоне мало состояний корпуса: {corpus}");
    let _ = Map::<String, Value>::new();
}

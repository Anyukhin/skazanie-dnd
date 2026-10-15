//! Геометрия областей заклинаний и действий: где область стоит, какие клетки
//! в неё входят (сфера, цилиндр, куб от точки, конус и куб от заклинателя,
//! линия и стена), линия действия от начала области, кто в области, цели
//! заклинания среди участников и социальных NPC. Задача Р1.
//!
//! JS: `server/rules-engine.mjs` — `isLargeOrLarger` (9887), `areaCenterOf`
//! (9898), куб от точки (9929–9950), круговая геометрия (9952–9965),
//! `positionInArea` (9967), `spreadsAroundCorners` (9979), линия действия
//! (9988–10054), конус и куб от заклинателя (10056–10084), `actorInArea`
//! (10086), `activeAreaEffectsAt` (10097), `wallCells` (10312),
//! `positionInEffect` (10379), `areaEffectAffectsActor` (10399),
//! `areaCasterSideIds` (10432), `areaCellsOf` (10577), `areasOverlap`
//! (10608), `spellTargetsAt` (10614), `npcSpellTargetsAt` (10683).

use std::cell::RefCell;
use std::collections::HashMap;

use serde_json::{Map, Value};
use sk_core::{game, js};
use sk_geometry::actor_footprint::footprint_distance_feet;
use sk_geometry::circular_area_geometry::{
    circular_area_cells, circular_area_line_of_effect, circular_cell_covered, grid_origin_for_target_cell, CircularAreaOptions, LineOfEffectOptions, CIRCULAR_AREA_GEOMETRY_VERSION,
};
use sk_geometry::{GridCell, Point};

use crate::core::{coalesce, target_for, unique_strings};
use crate::geometry::footprint::actor_footprint_visible_in;
use crate::tactical_geometry::npc_positioning::{placed_scene_npc_targets, NpcTarget};
use crate::tactical_geometry::{
    actor_footprint_cells_at, actor_point, falsy, footprint_cells, grid_point, has_length, is_safe, is_transparent_cell, is_walkable_cell, js_max, key_of, line_cells,
    point_json, sight_edge_blocked, sign, truthy_point, KeySet, Scene,
};
use crate::targets::{is_dying_hero, spell_creature_for};

/// Форма области как её видит `positionInArea`: строка как есть; не-строка
/// не совпадает ни с одной формой.
const NO_SHAPE: &str = "\u{0}";

/// `shape = 'sphere'` по умолчанию параметра: отсутствие — сфера, `null` и
/// не-строка — «иная форма».
pub fn shape_param(value: Option<&Value>) -> &str {
    match value {
        None => "sphere",
        Some(Value::String(shape)) => shape,
        Some(_) => NO_SHAPE,
    }
}

/// `value ?? 'sphere'`: `null` тоже сфера.
pub fn shape_or_sphere(value: Option<&Value>) -> &str {
    match value {
        None | Some(Value::Null) => "sphere",
        Some(Value::String(shape)) => shape,
        Some(_) => NO_SHAPE,
    }
}

fn is_circular_version(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str) == Some(CIRCULAR_AREA_GEOMETRY_VERSION)
}

/// `isLargeOrLarger(actor)`.
pub fn is_large_or_larger(actor: Option<&Value>) -> bool {
    let field = |key: &str| actor.and_then(|actor| actor.get(key));
    let size = sk_core::text::lower(&js::s(coalesce(&[field("size"), field("creature_size"), field("creatureSize")])));
    ["large", "huge", "gargantuan", "большой", "огромный", "громадный"].iter().any(|value| size.contains(value))
}

/// `areaCenterOf(state, effect)`: аура `follows_source` идёт за заклинателем.
pub fn area_center_of(state: &Value, effect: &Value) -> Option<Point> {
    if !js::is_true(effect.get("follows_source")) {
        return truthy_point(effect.get("center"));
    }
    actor_point(state, &js::s(effect.get("source_actor"))).or_else(|| truthy_point(effect.get("center")))
}

/// Сторона куба в футах: `Number(sideFeet) > 0 ? side : max(0, Number(radius) || 0) * 2`.
fn point_cube_side(radius_feet: f64, side_feet: f64) -> f64 {
    if side_feet > 0.0 {
        side_feet
    } else {
        js_max(0.0, if falsy(radius_feet) { 0.0 } else { radius_feet }) * 2.0
    }
}

/// `pointCubeCellCount(radiusFeet, sideFeet)`: клеток по стороне куба.
pub fn point_cube_cell_count(radius_feet: f64, side_feet: f64) -> f64 {
    js_max(1.0, (point_cube_side(radius_feet, side_feet) / 5.0).floor())
}

/// Границы куба от точки, включительно.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CubeBounds {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

/// `pointCubeBounds(center, radiusFeet, sideFeet)`.
pub fn point_cube_bounds(center: Option<Point>, radius_feet: f64, side_feet: f64) -> Option<CubeBounds> {
    let side = point_cube_side(radius_feet, side_feet);
    let center = center?;
    if side <= 0.0 {
        return None;
    }
    let cells = point_cube_cell_count(radius_feet, side_feet);
    let min_offset = -((cells - 1.0) / 2.0).floor();
    let min_x = center.x + min_offset;
    let min_y = center.y + min_offset;
    Some(CubeBounds { min_x, min_y, max_x: min_x + cells - 1.0, max_y: min_y + cells - 1.0 })
}

/// `positionInPointCube(position, center, radiusFeet, sideFeet)`.
pub fn position_in_point_cube(position: Option<Point>, center: Option<Point>, radius_feet: f64, side_feet: f64) -> bool {
    let (Some(bounds), Some(position)) = (point_cube_bounds(center, radius_feet, side_feet), position) else { return false };
    position.x >= bounds.min_x && position.x <= bounds.max_x && position.y >= bounds.min_y && position.y <= bounds.max_y
}

/// `circularSpellGeometry(spell)`: круговая сфера или цилиндр от точки.
pub fn circular_spell_geometry(spell: &Value) -> bool {
    is_circular_version(spell.get("areaGeometryVersion"))
        && spell.get("target").and_then(Value::as_str) == Some("point")
        && spell.get("areaOrigin").and_then(Value::as_str) != Some("self")
        && matches!(shape_or_sphere(spell.get("areaShape")), "sphere" | "cylinder")
}

/// `circularAreaMetadata(spell, center)`: поля круговой области для события
/// или `{}`.
pub fn circular_area_metadata(spell: &Value, center: Option<&Value>) -> Map<String, Value> {
    let mut metadata = Map::new();
    if !circular_spell_geometry(spell) || !js::truthy(center) {
        return metadata;
    }
    metadata.insert("geometry_version".into(), Value::from(CIRCULAR_AREA_GEOMETRY_VERSION));
    metadata.insert("grid_origin".into(), grid_origin_for_target_cell(Point::from_value(center)).to_value());
    if let Some(id) = spell.get("id") {
        metadata.insert("spell_id".into(), id.clone());
    }
    metadata.insert("spreadsAroundCorners".into(), Value::Bool(spreads_around_corners(&AreaSpell::from_spell(spell))));
    metadata
}

/// `positionInArea(position, center, radiusFeet, shape, sideFeet, geometryVersion)`.
///
/// `radius_feet` и `side_feet` — `Number(…)` значения (`NaN` для
/// отсутствующего), `shape` — см. [`shape_param`].
pub fn position_in_area(position: Option<Point>, center: Option<Point>, radius_feet: f64, shape: &str, side_feet: f64, geometry_version: Option<&str>) -> bool {
    let (Some(position), Some(center)) = (position, center) else { return false };
    let radius = js_max(0.0, if falsy(radius_feet) { 0.0 } else { radius_feet });
    if geometry_version == Some(CIRCULAR_AREA_GEOMETRY_VERSION) && matches!(shape, "sphere" | "cylinder") {
        return circular_cell_covered(Point::new(position.x - center.x, position.y - center.y), radius / 5.0);
    }
    let dx = position.x - center.x;
    let dy = position.y - center.y;
    let distance_feet = js_max(dx.abs(), dy.abs()) * 5.0;
    if shape == "cube" {
        return position_in_point_cube(Some(position), Some(center), radius_feet, side_feet);
    }
    distance_feet <= radius
}

/// Поля заклинания, которые читают линия действия и `spreadsAroundCorners`.
#[derive(Clone, Debug, Default)]
pub struct AreaSpell<'a> {
    /// `String(spell?.id ?? spell?.spell_id ?? '')`.
    pub id: String,
    pub radius: Option<&'a Value>,
    pub spreads_around_corners: Option<&'a Value>,
    pub spreads_around_corners_snake: Option<&'a Value>,
    pub area_geometry_version: Option<&'a Value>,
}

impl<'a> AreaSpell<'a> {
    /// Карточка заклинания как есть.
    pub fn from_spell(spell: &'a Value) -> Self {
        Self {
            id: js::s(coalesce(&[spell.get("id"), spell.get("spell_id")])),
            radius: spell.get("radius"),
            spreads_around_corners: spell.get("spreadsAroundCorners"),
            spreads_around_corners_snake: spell.get("spreads_around_corners"),
            area_geometry_version: spell.get("areaGeometryVersion"),
        }
    }

    /// Псевдо-заклинание длящейся области (`positionInEffect`, `areaCellsOf`).
    fn from_effect(effect: &'a Value, with_version: bool) -> Self {
        Self {
            id: js::s(effect.get("spell_id")),
            radius: effect.get("radius_feet"),
            spreads_around_corners: effect.get("spreadsAroundCorners"),
            spreads_around_corners_snake: effect.get("spreads_around_corners"),
            area_geometry_version: if with_version { effect.get("geometry_version") } else { None },
        }
    }

    fn radius_feet(&self) -> f64 {
        let radius = js::number(self.radius);
        js_max(0.0, if falsy(radius) { 0.0 } else { radius })
    }
}

thread_local! {
    static CANONICAL_SPREADS: RefCell<HashMap<String, bool>> = RefCell::new(HashMap::new());
}

/// `spreadsAroundCorners(spell)`: флаг карточки или канонического профиля.
pub fn spreads_around_corners(spell: &AreaSpell<'_>) -> bool {
    if let Some(Value::Bool(flag)) = spell.spreads_around_corners {
        return *flag;
    }
    if let Some(Value::Bool(flag)) = spell.spreads_around_corners_snake {
        return *flag;
    }
    CANONICAL_SPREADS.with(|cache| {
        if let Some(flag) = cache.borrow().get(&spell.id) {
            return *flag;
        }
        let id = Value::String(spell.id.clone());
        let flag = sk_combat_content::combat_spells::canonical_combat_spell_for(Some(&id), None).is_some_and(|card| js::is_true(card.get("spreadsAroundCorners")));
        cache.borrow_mut().insert(spell.id.clone(), flag);
        flag
    })
}

/// `circularLineOfEffectFor(state, origin, target, radiusFeet, aroundCorners)`.
fn circular_line_of_effect_for(scene: &Scene<'_>, origin: Point, target: Point, radius_feet: f64, around_corners: bool) -> bool {
    if scene.cells().is_empty() {
        return true;
    }
    let map = scene.map();
    let is_open = |cell: GridCell| is_transparent_cell(scene.cell(grid_point(cell)));
    let is_blocked = |from: GridCell, to: GridCell| sight_edge_blocked(map, grid_point(from), grid_point(to));
    circular_area_line_of_effect(
        origin,
        target,
        &LineOfEffectOptions { radius_feet, spreads_around_corners: around_corners, is_open_cell: Some(&is_open), is_blocked_edge: Some(&is_blocked) },
    )
}

/// `areaLineOfEffectClear(state, origin, target, spell)`: есть ли линия
/// действия от начала области до клетки. Обычная область — одна прямая без
/// преград; обходящая углы — короткий поиск по прозрачным клеткам в радиусе.
pub fn area_line_of_effect_clear(state: &Value, origin: Option<Point>, target: Option<Point>, spell: &AreaSpell<'_>) -> bool {
    area_line_of_effect_clear_in(&Scene::new(state), origin, target, spell)
}

/// [`area_line_of_effect_clear`] над уже разобранной сценой.
pub fn area_line_of_effect_clear_in(scene: &Scene<'_>, origin: Option<Point>, target: Option<Point>, spell: &AreaSpell<'_>) -> bool {
    let (Some(origin), Some(target)) = (origin, target) else { return false };
    if is_circular_version(spell.area_geometry_version) {
        return circular_line_of_effect_for(scene, origin, target, spell.radius_feet(), spreads_around_corners(spell));
    }
    if scene.cells().is_empty() {
        return true;
    }
    let map = scene.map();
    if !spreads_around_corners(spell) {
        let mut previous = origin;
        for point in line_cells(origin, target) {
            if !is_transparent_cell(scene.cell(point)) || sight_edge_blocked(map, previous, point) {
                return false;
            }
            previous = point;
        }
        return true;
    }
    let radius_feet = spell.radius_feet();
    if !position_in_area(Some(target), Some(origin), radius_feet, "sphere", f64::NAN, None) {
        return false;
    }
    let mut queue = std::collections::VecDeque::from([origin]);
    let mut visited: KeySet = KeySet::from([key_of(origin)]);
    while let Some(current) = queue.pop_front() {
        if current.x == target.x && current.y == target.y {
            return true;
        }
        for (dx, dy) in [(1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0)] {
            let next = Point::new(current.x + dx, current.y + dy);
            let key = key_of(next);
            if visited.contains(&key) || !position_in_area(Some(next), Some(origin), radius_feet, "sphere", f64::NAN, None) {
                continue;
            }
            if !is_transparent_cell(scene.cell(next)) || sight_edge_blocked(map, current, next) {
                continue;
            }
            visited.insert(key);
            queue.push_back(next);
        }
    }
    false
}

/// Проверка «точка в области от начала» для [`area_target_has_line_of_effect`].
pub type WithinArea<'a> = &'a dyn Fn(Point, Option<Point>) -> bool;

/// `areaTargetHasLineOfEffect(state, command, spell, center, targetId, targetPosition, targetActor, withinArea)`:
/// хотя бы одна клетка цели в области и с линией действия хотя бы от одной
/// клетки начала (заклинатель — для областей «от себя»). `target_actor` —
/// уже выбранная карточка (`findActor` по умолчанию в JS).
pub fn area_target_has_line_of_effect(scene: &Scene<'_>, command: &Value, spell: &Value, center: Option<Point>, target_position: Option<Point>, target_actor: Option<&Value>, within_area: WithinArea<'_>) -> bool {
    let target_cells = footprint_cells(target_actor, target_position);
    let caster = js::s(command.get("actor_id"));
    let caster_position = actor_point(scene.state, &caster);
    let from_self = spell.get("areaOrigin").and_then(Value::as_str) == Some("self") || spell.get("target").and_then(Value::as_str) == Some("self");
    let origins: Vec<Option<Point>> = if from_self { actor_footprint_cells_at(scene.state, &caster, caster_position).into_iter().map(Some).collect() } else { vec![center] };
    let area_spell = AreaSpell::from_spell(spell);
    origins
        .iter()
        .any(|origin| target_cells.iter().any(|target| within_area(*target, *origin) && area_line_of_effect_clear_in(scene, *origin, Some(*target), &area_spell)))
}

/// `positionInCone(position, origin, toward, rangeFeet)`: конус 53° от начала
/// к выбранной клетке.
pub fn position_in_cone(position: Option<Point>, origin: Option<Point>, toward: Option<Point>, range_feet: f64) -> bool {
    let (Some(position), Some(origin), Some(toward)) = (position, origin, toward) else { return false };
    let direction_x = toward.x - origin.x;
    let direction_y = toward.y - origin.y;
    let target_x = position.x - origin.x;
    let target_y = position.y - origin.y;
    if (falsy(direction_x) && falsy(direction_y)) || (falsy(target_x) && falsy(target_y)) {
        return false;
    }
    let range = js_max(0.0, if falsy(range_feet) { 0.0 } else { range_feet });
    if js_max(target_x.abs(), target_y.abs()) * 5.0 > range {
        return false;
    }
    let dot = direction_x * target_x + direction_y * target_y;
    let cross = (direction_x * target_y - direction_y * target_x).abs();
    dot > 0.0 && cross * 2.0 <= dot
}

/// `positionInDirectedCube(position, origin, toward, edgeFeet)`: куб от
/// заклинателя в сторону выбранной клетки.
pub fn position_in_directed_cube(position: Option<Point>, origin: Option<Point>, toward: Option<Point>, edge_feet: f64) -> bool {
    let (Some(position), Some(origin), Some(toward)) = (position, origin, toward) else { return false };
    let direction_x = toward.x - origin.x;
    let direction_y = toward.y - origin.y;
    if falsy(direction_x) && falsy(direction_y) {
        return false;
    }
    let target_x = position.x - origin.x;
    let target_y = position.y - origin.y;
    let edge = js_max(0.0, if falsy(edge_feet) { 0.0 } else { edge_feet });
    let cells = js_max(1.0, (edge / 5.0).floor());
    let half_width = ((cells - 1.0) / 2.0).floor();
    if direction_x.abs() >= direction_y.abs() {
        let forward = target_x * sign(direction_x);
        return forward >= 1.0 && forward <= cells && target_y.abs() <= half_width;
    }
    let forward = target_y * sign(direction_y);
    forward >= 1.0 && forward <= cells && target_x.abs() <= half_width
}

/// `actorInArea(state, actorId, position, center, radiusFeet, shape, originActorId, originAnchor)`.
/// `origin_anchor` `None` — по умолчанию `center`.
#[allow(clippy::too_many_arguments)] // Сигнатура JS: восемь позиционных параметров.
pub fn actor_in_area(state: &Value, actor_id: &str, position: Option<Point>, center: Option<Point>, radius_feet: f64, shape: &str, origin_actor_id: Option<&str>, origin_anchor: Option<Point>) -> bool {
    let points = footprint_cells(game::find_actor(state, actor_id), position);
    let origins: Vec<Option<Point>> = match origin_actor_id {
        None => vec![center],
        Some(origin_id) => actor_footprint_cells_at(state, origin_id, origin_anchor.or(center)).into_iter().map(Some).collect(),
    };
    if points.is_empty() || origins.is_empty() {
        return false;
    }
    let test = |check: &dyn Fn(Point, Option<Point>) -> bool| origins.iter().any(|origin| points.iter().any(|point| check(*point, *origin)));
    match shape {
        "cone" => test(&|point, origin| position_in_cone(Some(point), origin, center, radius_feet)),
        "cube" => test(&|point, origin| position_in_directed_cube(Some(point), origin, center, radius_feet)),
        _ => test(&|point, origin| position_in_area(Some(point), origin, radius_feet, shape, f64::NAN, None)),
    }
}

fn active_effects(state: &Value) -> &[Value] {
    js::path(state, &["mechanics", "active_effects"]).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// `activeAreaEffectsAt(state, position, actor)`: длящиеся области в клетке
/// (по площади `actor`, если он передан).
pub fn active_area_effects_at<'a>(state: &'a Value, position: Option<Point>, actor: Option<&Value>) -> Vec<&'a Value> {
    active_area_effects_at_in(&Scene::new(state), position, actor)
}

/// [`active_area_effects_at`] над уже разобранной сценой.
pub fn active_area_effects_at_in<'a>(scene: &Scene<'a>, position: Option<Point>, actor: Option<&Value>) -> Vec<&'a Value> {
    active_effects(scene.state).iter().filter(|effect| position_in_effect_in(scene, position, effect, actor)).collect()
}

/// `wallCells(state, command, spell)`: клетки стены или луча — от
/// заклинателя (`areaOrigin: 'self'`) или поперёк направления к выбранной
/// клетке; линия обрывается на непрозрачной клетке и закрытой кромке.
pub fn wall_cells(state: &Value, command: &Value, spell: &Value) -> Vec<Point> {
    wall_cells_in(&Scene::new(state), command, spell)
}

/// [`wall_cells`] над уже разобранной сценой.
pub fn wall_cells_in(scene: &Scene<'_>, command: &Value, spell: &Value) -> Vec<Point> {
    let Some(origin) = actor_point(scene.state, &js::s(command.get("actor_id"))) else { return Vec::new() };
    let to = Point::from_value(command.get("to"));
    if !is_safe(to.x) || !is_safe(to.y) {
        return Vec::new();
    }
    let step_x = sign(to.x - origin.x);
    let step_y = sign(to.y - origin.y);
    if falsy(step_x) && falsy(step_y) {
        return Vec::new();
    }
    let length = js_max(1.0, ((js::safe_int(spell.get("radius"), 30).max(5)) as f64 / 5.0).floor());
    let map = scene.map();
    let transparent = |point: Point| is_transparent_cell(scene.cell(point));
    let mut line = Vec::new();
    if spell.get("areaOrigin").and_then(Value::as_str) == Some("self") {
        let mut previous = origin;
        let mut step = 1.0;
        while step <= length {
            let point = Point::new(origin.x + step_x * step, origin.y + step_y * step);
            if !transparent(point) || sight_edge_blocked(map, previous, point) {
                break;
            }
            line.push(point);
            previous = point;
            step += 1.0;
        }
        return line;
    }
    if !transparent(to) {
        return Vec::new();
    }
    let across_x = if falsy(-step_y) { 0.0 } else { -step_y };
    let across_y = if falsy(step_x) { 0.0 } else { step_x };
    let first_offset = -(length / 2.0).floor();
    let last_offset = first_offset + length - 1.0;
    let mut low = 0.0;
    let mut high = 0.0;
    let mut offset = -1.0;
    while offset >= first_offset {
        let point = Point::new(to.x + across_x * offset, to.y + across_y * offset);
        let previous = Point::new(point.x + across_x, point.y + across_y);
        if !transparent(point) || sight_edge_blocked(map, previous, point) {
            break;
        }
        low = offset;
        offset -= 1.0;
    }
    let mut offset = 1.0;
    while offset <= last_offset {
        let point = Point::new(to.x + across_x * offset, to.y + across_y * offset);
        let previous = Point::new(point.x - across_x, point.y - across_y);
        if !transparent(point) || sight_edge_blocked(map, previous, point) {
            break;
        }
        high = offset;
        offset += 1.0;
    }
    let rows = js_max(1.0, ((js::safe_int(spell.get("areaWidthFeet"), 5).max(5)) as f64 / 5.0).floor());
    let mut row = 0.0;
    while row < rows {
        let mut offset = low;
        while offset <= high {
            let point = Point::new(to.x + across_x * offset + step_x * row, to.y + across_y * offset + step_y * row);
            if is_walkable_cell(scene.cell(point)) {
                line.push(point);
            }
            offset += 1.0;
        }
        row += 1.0;
    }
    line
}

/// `effect.grid_origin ?? origin` для круговой области.
fn effect_circle_center(effect: &Value, origin: Option<Point>) -> Option<Point> {
    match effect.get("grid_origin") {
        Some(value) if !value.is_null() => truthy_point(Some(value)),
        _ => origin,
    }
}

/// `positionInEffect(state, position, effect, actor)`: в длящейся области ли
/// клетка (или площадь `actor` с этим anchor) — стена по своим клеткам,
/// остальное — по центру и радиусу с линией действия.
pub fn position_in_effect(state: &Value, position: Option<Point>, effect: &Value, actor: Option<&Value>) -> bool {
    position_in_effect_in(&Scene::new(state), position, effect, actor)
}

/// [`position_in_effect`] над уже разобранной сценой.
pub fn position_in_effect_in(scene: &Scene<'_>, position: Option<Point>, effect: &Value, actor: Option<&Value>) -> bool {
    let Some(position) = position else { return false };
    let points = match actor {
        Some(actor) => footprint_cells(Some(actor), Some(position)),
        None => vec![position],
    };
    if let Some(Value::Array(cells)) = effect.get("cells") {
        return points.iter().any(|point| cells.iter().any(|cell| js::number(cell.get("x")) == point.x && js::number(cell.get("y")) == point.y));
    }
    let center = area_center_of(scene.state, effect);
    let source_id = if js::is_true(effect.get("follows_source")) { js::s(effect.get("source_actor")) } else { String::new() };
    let origins: Vec<Option<Point>> = if source_id.is_empty() { vec![center] } else { actor_footprint_cells_at(scene.state, &source_id, center).into_iter().map(Some).collect() };
    let spell = AreaSpell::from_effect(effect, true);
    let circular = is_circular_version(effect.get("geometry_version"));
    let radius = js::number(effect.get("radius_feet"));
    let shape = shape_param(effect.get("area_shape"));
    let side = js::number(effect.get("area_side_feet"));
    let version = effect.get("geometry_version").and_then(Value::as_str);
    points.iter().any(|point| {
        origins.iter().any(|origin| {
            let center = if circular { effect_circle_center(effect, *origin) } else { *origin };
            position_in_area(Some(*point), center, radius, shape, side, version) && area_line_of_effect_clear_in(scene, center, Some(*point), &spell)
        })
    })
}

/// `areaEffectAffectsActor(state, position, effect, actor)`: область с
/// `requires_full_footprint` задевает существо, только если накрывает всю
/// его площадь.
pub fn area_effect_affects_actor(state: &Value, position: Option<Point>, effect: &Value, actor: Option<&Value>) -> bool {
    let scene = Scene::new(state);
    if !position_in_effect_in(&scene, position, effect, actor) {
        return false;
    }
    if !js::is_true(effect.get("requires_full_footprint")) {
        return true;
    }
    footprint_cells(actor, position).into_iter().all(|point| position_in_effect_in(&scene, Some(point), effect, None))
}

/// `areaCasterSideIds(state, casterId)`: заклинатель и все на его стороне.
pub fn area_caster_side_ids(state: &Value, caster_id: &str) -> Vec<String> {
    let caster_is_enemy = game::is_enemy_actor(state, caster_id);
    let mut ids = vec![caster_id.to_string()];
    ids.extend(game::list_actors(state).into_iter().filter(|candidate| game::is_enemy_actor(state, &game::actor_id(candidate)) == caster_is_enemy).map(game::actor_id));
    crate::core::unique_string_list(&ids)
}

/// `areaCellsOf(state, effect)`: клетки длящейся области — явные у стены,
/// растр круга у круговой, квадрат (или куб) с линией действия у прочих.
pub fn area_cells_of(state: &Value, effect: &Value) -> Vec<Point> {
    area_cells_of_in(&Scene::new(state), effect)
}

/// [`area_cells_of`] над уже разобранной сценой.
pub fn area_cells_of_in(scene: &Scene<'_>, effect: &Value) -> Vec<Point> {
    if let Some(Value::Array(cells)) = effect.get("cells") {
        return cells.iter().map(|cell| Point::new(js::number(cell.get("x")), js::number(cell.get("y")))).collect();
    }
    let Some(center) = area_center_of(scene.state, effect) else { return Vec::new() };
    let shape = js::s(Some(effect.get("area_shape").filter(|shape| !shape.is_null()).unwrap_or(&Value::String("sphere".into()))));
    if is_circular_version(effect.get("geometry_version")) && (shape == "sphere" || shape == "cylinder") {
        let origin = match effect.get("grid_origin") {
            Some(value) if !value.is_null() => Point::from_value(Some(value)),
            _ => center,
        };
        let radius = js::number(effect.get("radius_feet"));
        let options = CircularAreaOptions { origin, radius_feet: if falsy(radius) { 0.0 } else { radius }, ..CircularAreaOptions::default() };
        return circular_area_cells(&options).into_iter().map(grid_point).filter(|cell| position_in_effect_in(scene, Some(*cell), effect, None)).collect();
    }
    let radius_feet = js::number(effect.get("radius_feet"));
    let side_feet = js::number(effect.get("area_side_feet"));
    let point_cube = if shape == "cube" { point_cube_bounds(Some(center), radius_feet, side_feet) } else { None };
    if shape == "cube" && point_cube.is_none() {
        return Vec::new();
    }
    let radius = js_max(0.0, (js::safe_int(effect.get("radius_feet"), 0) as f64 / 5.0).floor());
    let spell = AreaSpell::from_effect(effect, false);
    let (min_x, max_x, min_y, max_y) = match point_cube {
        Some(bounds) => (bounds.min_x, bounds.max_x, bounds.min_y, bounds.max_y),
        None => (center.x - radius, center.x + radius, center.y - radius, center.y + radius),
    };
    let mut cells = Vec::new();
    let mut y = min_y;
    while y <= max_y {
        let mut x = min_x;
        while x <= max_x {
            let point = Point::new(x, y);
            if area_line_of_effect_clear_in(scene, Some(center), Some(point), &spell) {
                cells.push(point);
            }
            x += 1.0;
        }
        y += 1.0;
    }
    cells
}

/// `areasOverlap(state, left, right)`: есть ли общая клетка у двух областей.
pub fn areas_overlap(state: &Value, left: &Value, right: &Value) -> bool {
    let scene = Scene::new(state);
    let right_cells: KeySet = area_cells_of_in(&scene, right).into_iter().map(key_of).collect();
    area_cells_of_in(&scene, left).into_iter().any(|cell| right_cells.contains(&key_of(cell)))
}

/// `safeInteger(command.slot_level, spell.level)`: запас — само значение
/// `spell.level`, дальше его читает `Number`.
fn slot_level_number(command: &Value, spell: &Value) -> f64 {
    let slot = js::number(command.get("slot_level"));
    if is_safe(slot) {
        slot
    } else {
        js::number(spell.get("level"))
    }
}

/// `spellTargetsAt(state, command, spell)`: цели заклинания по той же
/// геометрии, по которой оно затем разрешается.
pub fn spell_targets_at(state: &Value, command: &Value, spell: &Value) -> Vec<Value> {
    let scene = Scene::new(state);
    let actor_id = js::s(command.get("actor_id"));
    let is_caster = |id: &str| command.get("actor_id").and_then(Value::as_str) == Some(id);
    let can_be_affected = |actor: &Value| !sk_combat_content::combat_spells::is_untargetable_summon(Some(actor)) && (game::is_living_actor(actor) || is_dying_hero(state, &game::actor_id(actor)));
    let target = spell.get("target").and_then(Value::as_str);
    let kind = spell.get("kind").and_then(Value::as_str);
    let select_in_area = js::is_true(spell.get("selectTargetsInArea"));
    let target_ids = command.get("target_ids");
    if target == Some("self") && matches!(kind, Some("area-save" | "area-damage")) {
        let Some(center) = actor_point(state, &actor_id) else { return Vec::new() };
        let radius = js::safe_int(spell.get("radius"), 5).max(0) as f64;
        let selected: Option<Vec<String>> = select_in_area.then(|| unique_strings(target_ids));
        let within = |point: Point, origin: Option<Point>| position_in_area(Some(point), origin, radius, "sphere", f64::NAN, None);
        return game::list_actors(state)
            .into_iter()
            .filter(|candidate| {
                if !can_be_affected(candidate) {
                    return false;
                }
                let id = game::actor_id(candidate);
                let excluded = match &selected {
                    Some(ids) => !ids.contains(&id),
                    None => is_caster(&id),
                };
                if excluded {
                    return false;
                }
                let Some(at) = actor_point(state, &id) else { return false };
                actor_in_area(state, &id, Some(at), Some(center), radius, "sphere", Some(&actor_id), Some(center))
                    && area_target_has_line_of_effect(&scene, command, spell, Some(center), Some(at), game::find_actor(state, &id), &within)
            })
            .cloned()
            .collect();
    }
    if target == Some("self") {
        return game::find_actor(state, &actor_id).into_iter().cloned().collect();
    }
    if target != Some("point") {
        let requested = if has_length(target_ids) { target_ids.cloned().unwrap_or(Value::Null) } else { Value::Array(vec![target_for(command)]) };
        let level = js::safe_int(spell.get("level"), 1).max(1) as f64;
        let upcast = js_max(0.0, slot_level_number(command, spell) - level) * js::safe_int(spell.get("upcastTargetsPerLevel"), 0).max(0) as f64;
        let maximum = js_max(1.0, js::safe_int(spell.get("maxTargets"), 1) as f64 + upcast);
        let count = if maximum.is_nan() { 0 } else { maximum as usize };
        return unique_strings(Some(&requested)).into_iter().take(count).filter_map(|id| spell_creature_for(state, &id, spell)).collect();
    }
    let to = Point::from_value(command.get("to"));
    let radius_fallback = if kind.is_some_and(|kind| kind.starts_with("area-")) { 5 } else { 0 };
    let radius = js::safe_int(spell.get("radius"), radius_fallback).min(600).max(0) as f64;
    if radius <= 0.0 {
        return Vec::new();
    }
    let geometry_version = circular_spell_geometry(spell).then_some(CIRCULAR_AREA_GEOMETRY_VERSION);
    let area_shape = spell.get("areaShape").and_then(Value::as_str);
    let from_self = spell.get("areaOrigin").and_then(Value::as_str) == Some("self");
    if from_self && matches!(area_shape, Some("cone" | "cube")) {
        let Some(origin) = actor_point(state, &actor_id) else { return Vec::new() };
        let shape = area_shape.unwrap_or_default();
        let within = |point: Point, source: Option<Point>| {
            if shape == "cone" {
                position_in_cone(Some(point), source, Some(to), radius)
            } else {
                position_in_directed_cube(Some(point), source, Some(to), radius)
            }
        };
        return game::list_actors(state)
            .into_iter()
            .filter(|actor| {
                let id = game::actor_id(actor);
                let Some(at) = actor_point(state, &id) else { return false };
                can_be_affected(actor)
                    && !is_caster(&id)
                    && actor_in_area(state, &id, Some(at), Some(to), radius, shape, Some(&actor_id), Some(origin))
                    && area_target_has_line_of_effect(&scene, command, spell, Some(to), Some(at), game::find_actor(state, &id), &within)
            })
            .cloned()
            .collect();
    }
    if area_shape == Some("line") {
        let wall: KeySet = wall_cells_in(&scene, command, spell).into_iter().map(key_of).collect();
        if wall.is_empty() {
            return Vec::new();
        }
        return game::list_actors(state)
            .into_iter()
            .filter(|actor| {
                let id = game::actor_id(actor);
                if !can_be_affected(actor) || is_caster(&id) {
                    return false;
                }
                actor_point(state, &id).is_some_and(|at| actor_footprint_cells_at(state, &id, Some(at)).into_iter().any(|cell| wall.contains(&key_of(cell))))
            })
            .cloned()
            .collect();
    }
    let shape = shape_or_sphere(spell.get("areaShape"));
    let side = js::number(spell.get("areaSideFeet"));
    let within = |point: Point, origin: Option<Point>| position_in_area(Some(point), origin, radius, shape, side, geometry_version);
    let explicit = select_in_area && has_length(target_ids);
    let listed = |id: &str| target_ids.and_then(Value::as_array).is_some_and(|ids| ids.iter().any(|entry| entry.as_str() == Some(id)));
    let candidates: Vec<&Value> = game::list_actors(state)
        .into_iter()
        .filter(|actor| {
            if !can_be_affected(actor) {
                return false;
            }
            let id = game::actor_id(actor);
            if explicit && !listed(&id) {
                return false;
            }
            let at = actor_point(state, &id);
            if select_in_area && !has_length(target_ids) && at.is_some() && !actor_footprint_visible_in(&scene, &id, at) {
                return false;
            }
            let Some(at) = at else { return false };
            actor_footprint_cells_at(state, &id, Some(at)).into_iter().any(|cell| position_in_area(Some(cell), Some(to), radius, shape, side, geometry_version))
                && area_target_has_line_of_effect(&scene, command, spell, Some(to), Some(at), game::find_actor(state, &id), &within)
        })
        .collect();
    if explicit {
        let ids = target_ids.and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
        return ids.iter().filter_map(|id| candidates.iter().rev().find(|actor| game::actor_id(actor) == js::string(Some(id))).map(|actor| (*actor).clone())).collect();
    }
    candidates.into_iter().cloned().collect()
}

/// `npcSpellTargetsAt(state, command, spell)`: социальные NPC сцены, которых
/// задевает область (без боевого листа в `listActors`).
pub fn npc_spell_targets_at(state: &Value, command: &Value, spell: &Value) -> Vec<NpcTarget> {
    let kind = spell.get("kind").and_then(Value::as_str);
    let select_in_area = js::is_true(spell.get("selectTargetsInArea"));
    if !matches!(kind, Some("area-save" | "area-damage")) && !select_in_area {
        return Vec::new();
    }
    let scene = Scene::new(state);
    let actor_id = js::s(command.get("actor_id"));
    let target_ids = command.get("target_ids");
    let candidates: Vec<NpcTarget> = placed_scene_npc_targets(state).into_iter().filter(|target| game::find_actor(state, &target.id()).is_none()).collect();
    let explicit = select_in_area && has_length(target_ids);
    let selected_ids: Option<Vec<String>> = explicit.then(|| unique_strings(target_ids));
    let selected: Vec<&NpcTarget> = match &selected_ids {
        Some(ids) => candidates.iter().filter(|target| ids.contains(&target.id())).collect(),
        None => candidates.iter().collect(),
    };
    let target = spell.get("target").and_then(Value::as_str);
    if target == Some("self") {
        let Some(center) = actor_point(state, &actor_id) else { return Vec::new() };
        let radius = js::safe_int(spell.get("radius"), 5).max(0) as f64;
        let caster = game::find_actor(state, &actor_id);
        let center_json = point_json(center);
        let within = |point: Point, origin: Option<Point>| position_in_area(Some(point), origin, radius, "sphere", f64::NAN, None);
        return selected
            .into_iter()
            .filter(|entry| {
                let pseudo = entry.footprint_actor();
                let distance = footprint_distance_feet(Some(&pseudo), caster, Some(&entry.placement), Some(&center_json)).unwrap_or(0.0);
                distance <= radius && area_target_has_line_of_effect(&scene, command, spell, Some(center), Some(entry.position()), Some(&pseudo), &within)
            })
            .cloned()
            .collect();
    }
    if target != Some("point") {
        return Vec::new();
    }
    let to = Point::from_value(command.get("to"));
    let radius = js::safe_int(spell.get("radius"), 5).min(600).max(0) as f64;
    let area_shape = spell.get("areaShape").and_then(Value::as_str);
    let from_self = spell.get("areaOrigin").and_then(Value::as_str) == Some("self");
    if from_self && matches!(area_shape, Some("cone" | "cube")) {
        let Some(origin) = actor_point(state, &actor_id) else { return Vec::new() };
        let cone = area_shape == Some("cone");
        let check = |point: Point, source: Option<Point>| if cone { position_in_cone(Some(point), source, Some(to), radius) } else { position_in_directed_cube(Some(point), source, Some(to), radius) };
        let sources = actor_footprint_cells_at(state, &actor_id, Some(origin));
        return candidates
            .into_iter()
            .filter(|entry| {
                let pseudo = entry.footprint_actor();
                entry.cells().into_iter().any(|cell| sources.iter().any(|source| check(cell, Some(*source))))
                    && area_target_has_line_of_effect(&scene, command, spell, Some(to), Some(entry.position()), Some(&pseudo), &check)
            })
            .collect();
    }
    if area_shape == Some("line") {
        let wall: KeySet = wall_cells_in(&scene, command, spell).into_iter().map(key_of).collect();
        return candidates.into_iter().filter(|entry| entry.cells().into_iter().any(|cell| wall.contains(&key_of(cell)))).collect();
    }
    let geometry_version = circular_spell_geometry(spell).then_some(CIRCULAR_AREA_GEOMETRY_VERSION);
    let shape = shape_or_sphere(spell.get("areaShape"));
    let side = js::number(spell.get("areaSideFeet"));
    let within = |point: Point, origin: Option<Point>| position_in_area(Some(point), origin, radius, shape, side, geometry_version);
    let affected: Vec<&NpcTarget> = selected
        .into_iter()
        .filter(|entry| {
            let pseudo = entry.footprint_actor();
            entry.cells().into_iter().any(|cell| position_in_area(Some(cell), Some(to), radius, shape, side, geometry_version))
                && area_target_has_line_of_effect(&scene, command, spell, Some(to), Some(entry.position()), Some(&pseudo), &within)
        })
        .collect();
    if explicit {
        let ids = target_ids.and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
        return ids.iter().filter_map(|id| affected.iter().rev().find(|entry| entry.id() == js::string(Some(id))).map(|entry| (*entry).clone())).collect();
    }
    affected.into_iter().cloned().collect()
}

/// Клетки в JSON — для эталонов и событий.
pub fn cells_json(cells: &[Point]) -> Value {
    crate::tactical_geometry::points_json(cells)
}

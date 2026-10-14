//! Перенос `server/circular-area-geometry.mjs` — детерминированный
//! растризатор круговой области для клеточной сетки D&D 2014.
//!
//! Начало круга лежит на пересечении сетки. Клетка `(x, y)` занимает
//! прямоугольник `[x, x + 1] × [y, y + 1]` и входит в область, когда круг
//! покрывает не менее половины её площади. Line-of-effect идёт от пересечения
//! начала до центра целевой клетки точным grid DDA либо, для заклинаний,
//! огибающих углы, поиском по покрытой части круга.
//!
//! Входы JS — рыхлые объекты, которые модуль приводит `Number()`; здесь они
//! приходят уже числами ([`Point`], `f64`), а `NaN` и бесконечность ведут себя
//! как нечисловое значение в JS. Порядок обхода клеток и вызовов коллбэков —
//! как в JS: от него зависят цели заклинаний.

use std::collections::{HashSet, VecDeque};

use serde_json::Value;
use sk_core::js;

use crate::fdlibm;
use crate::js_extra::{is_safe_integer, js_max, js_min};
use crate::{GridCell, Point};

/// `CIRCULAR_AREA_GEOMETRY_VERSION`.
pub const CIRCULAR_AREA_GEOMETRY_VERSION: &str = "circle-grid-v2";

const CELL_AREA: f64 = 1.0;
const COVERAGE_THRESHOLD: f64 = 0.5;
const EPSILON: f64 = 1e-9;

// Rules Engine ограничивает радиусы заклинаний 600 футами. Запас до 128
// клеток оставляет API безопасным даже при ошибочном внешнем вводе.
const MAX_RADIUS_CELLS: f64 = 128.0;
const MAX_GRID_COORDINATE: f64 = 1_000_000.0;

/// `finiteNumber(value, fallback)` для уже приведённого числа.
fn finite_or(number: f64, fallback: f64) -> f64 {
    if number.is_finite() {
        number
    } else {
        fallback
    }
}

/// `radiusCells(value)`: неположительный или нечисловой радиус — 0, сверху —
/// 128 клеток.
fn radius_cells(value: f64) -> f64 {
    let radius = finite_or(value, 0.0);
    if radius <= 0.0 {
        return 0.0;
    }
    js_min(MAX_RADIUS_CELLS, radius)
}

/// `gridCoordinate(value)`: округление вниз и ограничение ±1 000 000.
fn grid_coordinate(value: f64) -> f64 {
    let number = finite_or(value, 0.0);
    js_max(-MAX_GRID_COORDINATE, js_min(MAX_GRID_COORDINATE, number.floor()))
}

/// Первообразная `sqrt(radius² - x²)` для `-radius <= x <= radius`.
/// Постоянная слагаемого не важна: используются только разности значений.
fn circle_height_primitive(radius: f64, x: f64) -> f64 {
    if !(radius > 0.0) {
        return 0.0;
    }
    let bounded_x = js_max(-radius, js_min(radius, x));
    let ratio = js_max(-1.0, js_min(1.0, bounded_x / radius));
    let root = js_max(0.0, radius * radius - bounded_x * bounded_x).sqrt();
    0.5 * (bounded_x * root + radius * radius * fdlibm::asin(ratio))
}

fn circle_height(radius: f64, x: f64) -> f64 {
    js_max(0.0, radius * radius - x * x).sqrt()
}

/// Координаты x, где меняется формула вертикального среза: там круг
/// встречает горизонтальное ребро клетки. Разбиение позволяет интегрировать
/// площадь элементарной первообразной круга.
fn integration_breakpoints(left: f64, right: f64, y0: f64, y1: f64, radius: f64) -> Vec<f64> {
    let mut values = vec![left, right, 0.0];
    for edge in [y0, y1] {
        let edge_distance = edge.abs();
        if edge_distance > radius {
            continue;
        }
        let x = js_max(0.0, radius * radius - edge_distance * edge_distance).sqrt();
        values.push(-x);
        values.push(x);
    }
    // filter → `-0` в `0` → `new Set` → сортировка по возрастанию.
    let mut unique: Vec<f64> = Vec::with_capacity(values.len());
    for value in values {
        if !(value >= left && value <= right) {
            continue;
        }
        let value = if value == 0.0 { 0.0 } else { value };
        if !unique.contains(&value) {
            unique.push(value);
        }
    }
    unique.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    unique
}

/// `circularCellCoverage(cell, radius)` — площадь пересечения круга радиуса
/// `radius` клеток с началом в `(0, 0)` и клетки `cell` (координаты
/// относительно начала), от 0 до 1.
pub fn circular_cell_coverage(cell: Point, radius_value: f64) -> f64 {
    let radius = radius_cells(radius_value);
    if !(radius > 0.0) {
        return 0.0;
    }

    let x0 = finite_or(cell.x, f64::NAN);
    let y0 = finite_or(cell.y, f64::NAN);
    if !x0.is_finite() || !y0.is_finite() {
        return 0.0;
    }
    let x1 = x0 + 1.0;
    let y1 = y0 + 1.0;
    let left = js_max(x0, -radius);
    let right = js_min(x1, radius);
    if !(left < right) {
        return 0.0;
    }

    // Ближайшая точка отбрасывает клетки вне круга до тригонометрии, дальняя
    // вершина за O(1) обрабатывает полностью покрытые внутренние клетки.
    let nearest_x = if x0 > 0.0 { x0 } else if x1 < 0.0 { x1 } else { 0.0 };
    let nearest_y = if y0 > 0.0 { y0 } else if y1 < 0.0 { y1 } else { 0.0 };
    if nearest_x * nearest_x + nearest_y * nearest_y >= radius * radius - EPSILON {
        return 0.0;
    }
    let farthest_x = js_max(x0.abs(), x1.abs());
    let farthest_y = js_max(y0.abs(), y1.abs());
    if farthest_x * farthest_x + farthest_y * farthest_y <= radius * radius + EPSILON {
        return CELL_AREA;
    }

    let points = integration_breakpoints(left, right, y0, y1, radius);
    let mut area = 0.0;
    for index in 1..points.len() {
        let segment_left = points[index - 1];
        let segment_right = points[index];
        if !(segment_left < segment_right) {
            continue;
        }

        let midpoint = (segment_left + segment_right) / 2.0;
        let half_height = circle_height(radius, midpoint);
        let upper_is_circle = half_height < y1;
        let lower_is_circle = -half_height > y0;
        let mut circle_coefficient = 0.0;
        let mut constant = 0.0;
        if upper_is_circle {
            circle_coefficient += 1.0;
        } else {
            constant += y1;
        }
        if lower_is_circle {
            circle_coefficient += 1.0;
        } else {
            constant -= y0;
        }

        let midpoint_length = js_min(y1, half_height) - js_max(y0, -half_height);
        if !(midpoint_length > 0.0) {
            continue;
        }

        area += circle_coefficient
            * (circle_height_primitive(radius, segment_right) - circle_height_primitive(radius, segment_left))
            + constant * (segment_right - segment_left);
    }
    js_max(0.0, js_min(CELL_AREA, area))
}

/// `circularCellCovered(cell, radius)` — покрыта ли клетка хотя бы наполовину.
pub fn circular_cell_covered(cell: Point, radius_value: f64) -> bool {
    circular_cell_coverage(cell, radius_value) >= COVERAGE_THRESHOLD - EPSILON
}

/// `gridOriginForTargetCell(target)` — северо-западное пересечение сетки
/// выбранной клетки. Координаты намеренно округляются вниз: ошибочная
/// дробная цель не сдвигает начало круга внутрь клетки; нечисловая — `0`.
pub fn grid_origin_for_target_cell(target: Point) -> GridCell {
    GridCell::new(grid_coordinate(target.x) as i64, grid_coordinate(target.y) as i64)
}

/// Входные границы растра `{minX, minY, maxX, maxY}` как числа JS (`NaN` —
/// нечисловое поле). Границы включаются.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GridBounds {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

impl GridBounds {
    pub const fn new(min_x: f64, min_y: f64, max_x: f64, max_y: f64) -> Self {
        Self { min_x, min_y, max_x, max_y }
    }

    /// Поля `minX/minY/maxX/maxY` через `Number()`; у не-объекта их нет, и
    /// такие границы отклоняют растр целиком, как в JS.
    pub fn from_value(value: &Value) -> Self {
        let field = |name: &str| js::number(value.as_object().and_then(|map| map.get(name)));
        Self { min_x: field("minX"), min_y: field("minY"), max_x: field("maxX"), max_y: field("maxY") }
    }
}

/// `normalizeBounds`: внутренние целые границы или `None`, если хоть одна
/// нечисловая.
fn normalize_bounds(bounds: GridBounds) -> Option<GridBounds> {
    let min_x = finite_or(bounds.min_x, f64::NAN).ceil();
    let min_y = finite_or(bounds.min_y, f64::NAN).ceil();
    let max_x = finite_or(bounds.max_x, f64::NAN).floor();
    let max_y = finite_or(bounds.max_y, f64::NAN).floor();
    [min_x, min_y, max_x, max_y]
        .iter()
        .all(|value| value.is_finite())
        .then_some(GridBounds { min_x, min_y, max_x, max_y })
}

/// `safeGridPoint`: безопасные целые не дальше ±1 000 000.
fn safe_grid_point(point: Point) -> Option<GridCell> {
    let x = finite_or(point.x, f64::NAN);
    let y = finite_or(point.y, f64::NAN);
    if !is_safe_integer(x) || !is_safe_integer(y) {
        return None;
    }
    if x.abs() > MAX_GRID_COORDINATE || y.abs() > MAX_GRID_COORDINATE {
        return None;
    }
    Some(GridCell::new(x as i64, y as i64))
}

fn offset_cell(point: GridCell, dx: i64, dy: i64) -> GridCell {
    GridCell::new(point.x + dx, point.y + dy)
}

fn relative(cell: GridCell, origin: GridCell) -> Point {
    Point::new((cell.x - origin.x) as f64, (cell.y - origin.y) as f64)
}

const CARDINAL_OFFSETS: [(i64, i64); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];

/// Проверки карты для line-of-effect: открыта ли клетка и закрыто ли ребро
/// между соседними клетками. Без коллбэка клетка открыта, ребро свободно.
struct Probes<'a> {
    open: Option<&'a dyn Fn(GridCell) -> bool>,
    blocked: Option<&'a dyn Fn(GridCell, GridCell) -> bool>,
}

impl Probes<'_> {
    fn is_open_cell(&self, cell: GridCell) -> bool {
        self.open.is_none_or(|open| open(cell))
    }

    fn is_blocked_edge(&self, from: GridCell, to: GridCell) -> bool {
        self.blocked.is_some_and(|blocked| blocked(from, to))
    }
}

/// Начало — пересечение сетки, к нему примыкают четыре клетки. Выбранная
/// клетка находится в юго-восточном квадранте; началом считается только
/// часть кольца, связанная с этим квадрантом, чтобы закрытое ребро у начала
/// не стало порталом во вторую комнату.
fn accessible_origin_seeds(origin: GridCell, radius: f64, probes: &Probes) -> Vec<GridCell> {
    let selected = origin;
    let seed_cells: Vec<GridCell> = [
        selected,
        GridCell::new(origin.x, origin.y - 1),
        GridCell::new(origin.x - 1, origin.y),
        GridCell::new(origin.x - 1, origin.y - 1),
    ]
    .into_iter()
    .filter(|cell| circular_cell_covered(relative(*cell, origin), radius))
    .collect();
    if !seed_cells.contains(&selected) || !probes.is_open_cell(selected) {
        return Vec::new();
    }

    let mut queue = VecDeque::from([selected]);
    let mut visited = HashSet::from([selected]);
    while let Some(current) = queue.pop_front() {
        for (dx, dy) in CARDINAL_OFFSETS {
            let next = offset_cell(current, dx, dy);
            if !seed_cells.contains(&next) || visited.contains(&next) || !probes.is_open_cell(next) {
                continue;
            }
            if probes.is_blocked_edge(current, next) {
                continue;
            }
            visited.insert(next);
            queue.push_back(next);
        }
    }
    seed_cells.into_iter().filter(|cell| visited.contains(cell)).collect()
}

/// Обход отрезка от пересечения начала до центра целевой клетки точным grid
/// DDA. В точном пересечении угла обе соседние клетки и оба входящих ребра
/// должны быть открыты, поэтому диагональный луч не проскальзывает через
/// закрытый угол. У начала: SE — стартовая клетка, NE/SW требуют открытого
/// первого ребра, NW проходит проверку четырёх рёбер, как обычная вершина.
fn direct_grid_ray_clear(origin: GridCell, target: GridCell, radius: f64, probes: &Probes) -> bool {
    if !circular_cell_covered(relative(target, origin), radius) {
        return false;
    }
    if !probes.is_open_cell(origin) {
        return false;
    }

    let target_center_x = target.x as f64 + 0.5;
    let target_center_y = target.y as f64 + 0.5;
    let delta_x = target_center_x - origin.x as f64;
    let delta_y = target_center_y - origin.y as f64;
    if !(delta_x.is_finite() && delta_y.is_finite()) {
        return false;
    }

    // `Math.sign`: дельта — целое плюс половина, нулём не бывает.
    let step_x: i64 = if delta_x > 0.0 { 1 } else if delta_x < 0.0 { -1 } else { 0 };
    let step_y: i64 = if delta_y > 0.0 { 1 } else if delta_y < 0.0 { -1 } else { 0 };
    if step_x == 0 || step_y == 0 {
        return false;
    }
    let mut current = GridCell::new(
        origin.x + if step_x > 0 { 0 } else { -1 },
        origin.y + if step_y > 0 { 0 } else { -1 },
    );
    if !probes.is_open_cell(current) {
        return false;
    }
    if (current.x == origin.x && current.y == origin.y - 1) || (current.x == origin.x - 1 && current.y == origin.y) {
        if probes.is_blocked_edge(origin, current) {
            return false;
        }
    } else if current.x == origin.x - 1 && current.y == origin.y - 1 {
        let side_x = offset_cell(origin, step_x, 0);
        let side_y = offset_cell(origin, 0, step_y);
        if !probes.is_open_cell(side_x) || !probes.is_open_cell(side_y) {
            return false;
        }
        if probes.is_blocked_edge(origin, side_x)
            || probes.is_blocked_edge(origin, side_y)
            || probes.is_blocked_edge(side_x, current)
            || probes.is_blocked_edge(side_y, current)
        {
            return false;
        }
    }

    let delta_abs_x = delta_x.abs();
    let delta_abs_y = delta_y.abs();
    let mut next_vertical = 1.0 / delta_abs_x;
    let mut next_horizontal = 1.0 / delta_abs_y;
    let step_parameter_x = next_vertical;
    let step_parameter_y = next_horizontal;

    let max_steps = (MAX_RADIUS_CELLS * 3.0) as i64;
    for _ in 0..=max_steps {
        if !probes.is_open_cell(current) {
            return false;
        }
        if current == target {
            return true;
        }
        if next_vertical < next_horizontal - EPSILON {
            let next = offset_cell(current, step_x, 0);
            if probes.is_blocked_edge(current, next) {
                return false;
            }
            current = next;
            next_vertical += step_parameter_x;
            continue;
        }
        if next_horizontal < next_vertical - EPSILON {
            let next = offset_cell(current, 0, step_y);
            if probes.is_blocked_edge(current, next) {
                return false;
            }
            current = next;
            next_horizontal += step_parameter_y;
            continue;
        }

        // Луч попал в вершину сетки: обе боковые клетки и все четыре ребра
        // вокруг вершины — два входящих из current и два входящих в diagonal.
        let side_x = offset_cell(current, step_x, 0);
        let side_y = offset_cell(current, 0, step_y);
        let diagonal = offset_cell(current, step_x, step_y);
        if !probes.is_open_cell(side_x) || !probes.is_open_cell(side_y) {
            return false;
        }
        if probes.is_blocked_edge(current, side_x)
            || probes.is_blocked_edge(current, side_y)
            || probes.is_blocked_edge(side_x, diagonal)
            || probes.is_blocked_edge(side_y, diagonal)
        {
            return false;
        }
        current = diagonal;
        next_vertical += step_parameter_x;
        next_horizontal += step_parameter_y;
    }
    false
}

/// Заливка покрытой части круга для заклинаний, огибающих углы. Компонента
/// со стороны начала строится отдельно, чтобы непрозрачное ребро ровно у
/// начала не открыло путь во вторую комнату.
fn corner_flood_reaches(origin: GridCell, target: GridCell, radius: f64, probes: &Probes) -> bool {
    if !circular_cell_covered(relative(target, origin), radius) {
        return false;
    }
    let seeds = accessible_origin_seeds(origin, radius, probes);
    let mut visited: HashSet<GridCell> = seeds.iter().copied().collect();
    let mut queue = seeds;
    let mut queue_index = 0;
    while queue_index < queue.len() {
        let current = queue[queue_index];
        queue_index += 1;
        if current == target {
            return true;
        }
        for (dx, dy) in CARDINAL_OFFSETS {
            let next = offset_cell(current, dx, dy);
            if visited.contains(&next)
                || !circular_cell_covered(relative(next, origin), radius)
                || !probes.is_open_cell(next)
                || probes.is_blocked_edge(current, next)
            {
                continue;
            }
            visited.insert(next);
            queue.push(next);
        }
    }
    false
}

/// Параметры [`circular_area_line_of_effect`] — поля `options` в JS.
///
/// `is_open_cell` и `is_blocked_edge` необязательны; JS ловит исключение
/// коллбэка и считает клетку закрытой, а ребро — заблокированным. В Rust
/// коллбэк исключений не бросает: его ответ и есть решение.
#[derive(Clone, Copy, Default)]
pub struct LineOfEffectOptions<'a> {
    /// `radiusFeet`; нечисловой или неположительный — линии нет.
    pub radius_feet: f64,
    /// `spreadsAroundCorners === true`.
    pub spreads_around_corners: bool,
    pub is_open_cell: Option<&'a dyn Fn(GridCell) -> bool>,
    pub is_blocked_edge: Option<&'a dyn Fn(GridCell, GridCell) -> bool>,
}

/// `circularAreaLineOfEffect(origin, targetCell, options)` — есть ли
/// line-of-effect от пересечения начала до целевой клетки. `radiusFeet`
/// трактуется через стандартную клетку 5 футов. Дробные, бесконечные и
/// слишком далёкие (за ±1 000 000) координаты дают `false`.
pub fn circular_area_line_of_effect(origin: Point, target_cell: Point, options: &LineOfEffectOptions) -> bool {
    let (Some(safe_origin), Some(safe_target)) = (safe_grid_point(origin), safe_grid_point(target_cell)) else {
        return false;
    };
    let radius_feet = finite_or(options.radius_feet, 0.0);
    if !(radius_feet > 0.0) {
        return false;
    }
    let radius = radius_cells(radius_feet / 5.0);
    if !(radius > 0.0) {
        return false;
    }
    let probes = Probes { open: options.is_open_cell, blocked: options.is_blocked_edge };
    if options.spreads_around_corners {
        corner_flood_reaches(safe_origin, safe_target, radius, &probes)
    } else {
        direct_grid_ray_clear(safe_origin, safe_target, radius, &probes)
    }
}

/// Параметры [`circular_area_cells`] — `{ origin, radiusFeet, cellFeet = 5,
/// bounds }` в JS.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CircularAreaOptions {
    /// Начало круга; нечисловое или дальше ±1 000 000 — пустой растр.
    pub origin: Point,
    pub radius_feet: f64,
    /// Размер клетки в футах; по умолчанию 5.
    pub cell_feet: f64,
    /// `None` — без границ (`bounds == null`); нечисловые границы дают пустой
    /// растр.
    pub bounds: Option<GridBounds>,
}

impl Default for CircularAreaOptions {
    fn default() -> Self {
        Self { origin: Point::new(f64::NAN, f64::NAN), radius_feet: f64::NAN, cell_feet: 5.0, bounds: None }
    }
}

impl CircularAreaOptions {
    /// Параметры из JSON-объекта, как их читает JS: `cellFeet` по умолчанию 5
    /// только при отсутствии поля (`null` даёт 0 и пустой растр), `bounds:
    /// null` — без границ.
    pub fn from_value(value: &Value) -> Self {
        let Some(map) = value.as_object() else {
            return Self::default();
        };
        Self {
            origin: Point::from_value(map.get("origin")),
            radius_feet: js::number(map.get("radiusFeet")),
            cell_feet: map.get("cellFeet").map_or(5.0, |cell| js::number(Some(cell))),
            bounds: map.get("bounds").filter(|bounds| !bounds.is_null()).map(GridBounds::from_value),
        }
    }
}

/// `circularAreaCells(options)` — растр круговой области вокруг пересечения
/// сетки, построчно сверху вниз и слева направо. Границы включаются и
/// применяются после проверки круга. Неположительный или нечисловой радиус
/// даёт пустой список; радиус выше 128 клеток ограничивается.
pub fn circular_area_cells(options: &CircularAreaOptions) -> Vec<GridCell> {
    let origin_x = finite_or(options.origin.x, f64::NAN);
    let origin_y = finite_or(options.origin.y, f64::NAN);
    if !origin_x.is_finite()
        || !origin_y.is_finite()
        || origin_x.abs() > MAX_GRID_COORDINATE
        || origin_y.abs() > MAX_GRID_COORDINATE
    {
        return Vec::new();
    }
    let feet = finite_or(options.cell_feet, 5.0);
    let radius_in_feet = finite_or(options.radius_feet, 0.0);
    if !(feet > 0.0) || !(radius_in_feet > 0.0) {
        return Vec::new();
    }

    let radius = radius_cells(radius_in_feet / feet);
    if !(radius > 0.0) {
        return Vec::new();
    }
    let center = grid_origin_for_target_cell(options.origin);
    let normalized_bounds = match options.bounds {
        None => None,
        Some(bounds) => match normalize_bounds(bounds) {
            Some(bounds) => Some(bounds),
            None => return Vec::new(),
        },
    };
    if let Some(bounds) = normalized_bounds {
        if bounds.min_x > bounds.max_x || bounds.min_y > bounds.max_y {
            return Vec::new();
        }
    }

    let reach = radius.ceil() as i64;
    let mut result = Vec::new();
    for y in center.y - reach..center.y + reach {
        for x in center.x - reach..center.x + reach {
            if let Some(bounds) = normalized_bounds {
                let (fx, fy) = (x as f64, y as f64);
                if fx < bounds.min_x || fx > bounds.max_x || fy < bounds.min_y || fy > bounds.max_y {
                    continue;
                }
            }
            if circular_cell_covered(Point::new((x - center.x) as f64, (y - center.y) as f64), radius) {
                result.push(GridCell::new(x, y));
            }
        }
    }
    result
}

/// Перенос `test/circular-area-geometry.test.mjs` и геометрической части
/// `test/circular-spell-targeting.test.mjs`.
#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::time::Instant;

    use serde_json::{json, Value};

    use super::*;

    fn options(origin: (f64, f64), radius_feet: f64) -> CircularAreaOptions {
        CircularAreaOptions { origin: Point::new(origin.0, origin.1), radius_feet, ..CircularAreaOptions::default() }
    }

    fn keys(cells: &[GridCell]) -> Vec<String> {
        cells.iter().map(|cell| cell.key()).collect()
    }

    fn relative_keys(cells: &[GridCell], origin: GridCell) -> Vec<String> {
        cells.iter().map(|cell| format!("{},{}", cell.x - origin.x, cell.y - origin.y)).collect()
    }

    /// Независимый растр по правилу DMG 2014: origin на пересечении, клетка
    /// входит при покрытии круга не меньше 50 %.
    fn cells_from_rows(rows: &[&str]) -> Vec<String> {
        let height = rows.len() as i64;
        let mut result = Vec::new();
        for (row_index, row) in rows.iter().enumerate() {
            let width = row.len() as i64;
            for (column, mark) in row.chars().enumerate() {
                if mark == '#' {
                    result.push(format!("{},{}", column as i64 - width.div_euclid(2), row_index as i64 - height.div_euclid(2)));
                }
            }
        }
        result
    }

    /// Карта для line-of-effect: закрытые клетки и закрытые рёбра.
    #[derive(Default)]
    struct Walls {
        closed: HashSet<GridCell>,
        blocked: HashSet<[GridCell; 2]>,
    }

    impl Walls {
        fn closed(cells: &[(i64, i64)]) -> Self {
            Self { closed: cells.iter().map(|&(x, y)| GridCell::new(x, y)).collect(), ..Self::default() }
        }

        fn edges(edges: &[((i64, i64), (i64, i64))]) -> Self {
            Self {
                blocked: edges.iter().map(|&((ax, ay), (bx, by))| edge(GridCell::new(ax, ay), GridCell::new(bx, by))).collect(),
                ..Self::default()
            }
        }

        fn line(&self, origin: (i64, i64), target: (i64, i64), radius_feet: f64, around_corners: bool) -> bool {
            let open = |cell: GridCell| !self.closed.contains(&cell);
            let blocked = |from: GridCell, to: GridCell| self.blocked.contains(&edge(from, to));
            circular_area_line_of_effect(
                Point::new(origin.0 as f64, origin.1 as f64),
                Point::new(target.0 as f64, target.1 as f64),
                &LineOfEffectOptions {
                    radius_feet,
                    spreads_around_corners: around_corners,
                    is_open_cell: Some(&open),
                    is_blocked_edge: Some(&blocked),
                },
            )
        }
    }

    fn edge(from: GridCell, to: GridCell) -> [GridCell; 2] {
        if from <= to {
            [from, to]
        } else {
            [to, from]
        }
    }

    fn open_line(origin: (f64, f64), target: (f64, f64), radius_feet: f64) -> bool {
        circular_area_line_of_effect(
            Point::new(origin.0, origin.1),
            Point::new(target.0, target.1),
            &LineOfEffectOptions { radius_feet, ..LineOfEffectOptions::default() },
        )
    }

    #[test]
    fn public_version_is_circle_grid_v2() {
        assert_eq!(CIRCULAR_AREA_GEOMETRY_VERSION, "circle-grid-v2");
    }

    #[test]
    fn rasters_match_independent_dmg_rows() {
        let expected: [(f64, &[&str]); 4] = [
            (5.0, &["##", "##"]),
            (10.0, &[".##.", "####", "####", ".##."]),
            (20.0, &["..####..", ".######.", "########", "########", "########", "########", ".######.", "..####.."]),
            (
                30.0,
                &[
                    "....####....",
                    "..########..",
                    ".##########.",
                    ".##########.",
                    "############",
                    "############",
                    "############",
                    "############",
                    ".##########.",
                    ".##########.",
                    "..########..",
                    "....####....",
                ],
            ),
        ];
        for (radius_feet, rows) in expected {
            let actual = circular_area_cells(&options((0.0, 0.0), radius_feet));
            assert_eq!(relative_keys(&actual, GridCell::new(0, 0)), cells_from_rows(rows), "радиус {radius_feet}");
        }
    }

    #[test]
    fn circle_is_symmetric_around_origin_axes() {
        let cells = circular_area_cells(&options((12.0, -7.0), 37.5));
        let set: HashSet<String> = keys(&cells).into_iter().collect();
        for cell in &cells {
            assert!(set.contains(&format!("{},{}", 23 - cell.x, cell.y)));
            assert!(set.contains(&format!("{},{}", cell.x, -15 - cell.y)));
            assert!(set.contains(&format!("{},{}", 23 - cell.x, -15 - cell.y)));
        }
    }

    #[test]
    fn coverage_uses_exact_half_cell_threshold() {
        let quadrant = circular_cell_coverage(Point::new(0.0, 0.0), 1.0);
        assert!((quadrant - std::f64::consts::FRAC_PI_4).abs() < 1e-12);
        assert!(circular_cell_covered(Point::new(0.0, 0.0), 1.0));
        assert!(!circular_cell_covered(Point::new(1.0, 0.0), 1.0));
        assert!(circular_cell_coverage(Point::new(1.0, 0.0), 1.0) < 1e-12);
    }

    #[test]
    fn origin_rounds_target_down_and_keeps_raster() {
        assert_eq!(grid_origin_for_target_cell(Point::new(7.9, -2.1)), GridCell::new(7, -3));
        let origin = grid_origin_for_target_cell(Point::new(7.0, 4.0));
        let cells = circular_area_cells(&options((origin.x as f64, origin.y as f64), 5.0));
        assert_eq!(relative_keys(&cells, origin), ["-1,-1", "0,-1", "-1,0", "0,0"]);
        // Нечисловая цель — начало координат, как `finiteNumber(…, 0)` в JS.
        assert_eq!(grid_origin_for_target_cell(Point::from_value(Some(&Value::Null))), GridCell::new(0, 0));
    }

    #[test]
    fn bounds_are_inclusive_and_fractional_radius_is_deterministic() {
        let bounded = circular_area_cells(&CircularAreaOptions {
            bounds: Some(GridBounds::new(4.0, 5.0, 5.0, 6.0)),
            ..options((5.0, 6.0), 7.5)
        });
        assert_eq!(keys(&bounded), ["4,5", "5,5", "4,6", "5,6"]);
        assert_eq!(circular_area_cells(&options((5.0, 6.0), 7.5)).len(), 4);
    }

    #[test]
    fn bad_values_are_safe_and_huge_radius_is_capped() {
        assert!(circular_area_cells(&CircularAreaOptions::from_value(&Value::Null)).is_empty());
        assert!(circular_area_cells(&options((0.0, 0.0), 0.0)).is_empty());
        assert!(circular_area_cells(&options((0.0, 0.0), f64::NAN)).is_empty());
        assert!(circular_area_cells(&options((0.0, 0.0), f64::INFINITY)).is_empty());
        assert!(circular_area_cells(&options((f64::INFINITY, 0.0), 5.0)).is_empty());
        assert!(circular_area_cells(&options((1_000_001.0, 0.0), 5.0)).is_empty());
        assert!(circular_area_cells(&CircularAreaOptions { cell_feet: 0.0, ..options((0.0, 0.0), 10.0) }).is_empty());
        let cells = circular_area_cells(&options((0.0, 0.0), 1e12));
        assert!(cells.len() <= (2 * 128) * (2 * 128));
        // `cellFeet: null` — 0 и пустой растр, отсутствующее поле — 5 футов.
        assert!(circular_area_cells(&CircularAreaOptions::from_value(
            &json!({ "origin": { "x": 0, "y": 0 }, "radiusFeet": 10, "cellFeet": null })
        ))
        .is_empty());
        assert_eq!(
            circular_area_cells(&CircularAreaOptions::from_value(&json!({ "origin": { "x": 0, "y": 0 }, "radiusFeet": 10 }))).len(),
            12
        );
    }

    #[test]
    fn six_hundred_feet_raster_is_bounded() {
        let started = Instant::now();
        let cells = circular_area_cells(&options((300.0, 300.0), 600.0));
        let elapsed = started.elapsed();
        assert!(cells.len() > 40_000);
        assert!(elapsed.as_millis() < 2_000, "растр 600 футов занял {elapsed:?}");
    }

    #[test]
    fn direct_line_goes_to_target_cell_center() {
        let blocked = Walls::closed(&[(2, 0)]);
        assert!(!blocked.line((0, 0), (5, 2), 60.0, false));
        assert!(open_line((0.0, 0.0), (5.0, 2.0), 60.0));
    }

    #[test]
    fn direct_line_stops_at_wall_and_closed_door_edge() {
        assert!(!Walls::closed(&[(4, 2)]).line((1, 2), (7, 2), 60.0, false));
        assert!(!Walls::edges(&[((4, 2), (5, 2))]).line((1, 2), (7, 2), 60.0, false));
        assert!(open_line((1.0, 2.0), (7.0, 2.0), 60.0));
    }

    #[test]
    fn diagonal_line_checks_both_cells_of_closed_corner() {
        let closed_corner = Walls::edges(&[((1, 1), (2, 1)), ((1, 1), (1, 2))]);
        assert!(!closed_corner.line((1, 1), (5, 5), 60.0, false));
        assert!(open_line((1.0, 1.0), (5.0, 5.0), 60.0));
    }

    #[test]
    fn diagonal_line_checks_all_four_vertex_edges() {
        let (current, side_x, side_y, diagonal) = ((1, 1), (2, 1), (1, 2), (2, 2));
        for blocked_edge in [(current, side_x), (current, side_y), (side_x, diagonal), (side_y, diagonal)] {
            assert!(!Walls::edges(&[blocked_edge]).line((1, 1), (3, 3), 60.0, false), "ребро {blocked_edge:?} пропустило луч");
        }
        assert!(open_line((1.0, 1.0), (3.0, 3.0), 60.0));
    }

    #[test]
    fn origin_boundary_does_not_leak_through_closed_partition() {
        // Одно дверное ребро не объявляется всей стеной: закрыт и боковой обход.
        let closed_door = Walls::edges(&[((2, 2), (2, 1)), ((1, 2), (1, 1))]);
        assert!(!closed_door.line((2, 2), (2, 1), 10.0, false));
        assert!(closed_door.line((2, 2), (2, 2), 10.0, false));
        assert!(open_line((2.0, 2.0), (2.0, 1.0), 10.0));
    }

    #[test]
    fn direct_line_checks_origin_door_and_corners_use_open_path() {
        let closed_origin = Walls::closed(&[(2, 2)]);
        assert!(!closed_origin.line((2, 2), (2, 1), 10.0, false));
        assert!(!closed_origin.line((2, 2), (2, 1), 10.0, true));

        let origin_door = Walls::edges(&[((2, 2), (2, 1))]);
        assert!(!origin_door.line((2, 2), (2, 1), 10.0, false));
        assert!(origin_door.line((2, 2), (2, 1), 10.0, true));

        let barrier: Vec<_> = (0..13).map(|index| ((2 + index - 6, 2), (2 + index - 6, 1))).collect();
        let full_barrier = Walls::edges(&barrier);
        assert!(!full_barrier.line((2, 2), (2, 1), 10.0, false));
        assert!(!full_barrier.line((2, 2), (2, 1), 10.0, true));
    }

    #[test]
    fn diagonal_line_from_origin_checks_four_origin_vertex_edges() {
        let (origin, target, side_x, side_y) = ((2, 2), (1, 1), (1, 2), (2, 1));
        assert!(open_line((2.0, 2.0), (1.0, 1.0), 10.0));
        for blocked_edge in [(origin, side_x), (origin, side_y), (side_x, target), (side_y, target)] {
            assert!(!Walls::edges(&[blocked_edge]).line(origin, target, 10.0, false), "ребро начала {blocked_edge:?} пропустило луч");
        }
    }

    #[test]
    fn corner_spread_goes_around_wall_while_direct_line_is_blocked() {
        let wall = Walls::closed(&[(4, 2)]);
        assert!(!wall.line((1, 2), (7, 2), 60.0, false));
        assert!(wall.line((1, 2), (7, 2), 60.0, true));
    }

    #[test]
    fn corner_spread_does_not_enter_room_sealed_at_origin() {
        // Перегородка продолжается до цели: одно закрытое ребро начала не
        // выдаётся за замкнутую комнату, если вокруг есть путь.
        let barrier: Vec<_> = (0..13).map(|index| ((2 + index - 6, 2), (2 + index - 6, 1))).collect();
        assert!(!Walls::edges(&barrier).line((2, 2), (5, 1), 30.0, true));
    }

    #[test]
    fn line_rejects_fractional_infinite_and_far_coordinates() {
        assert!(!open_line((0.0, 0.0), (1.5, 1.0), 60.0));
        assert!(!open_line((0.0, 0.0), (f64::INFINITY, 1.0), 60.0));
        assert!(!open_line((0.0, 0.0), (1_000_000.0, 1_000_000.0), 600.0));
        assert!(!open_line((0.0, 0.0), (1.0, 1.0), f64::NAN));
    }

    /// `test/circular-spell-targeting.test.mjs`: огненный шар 2014 с центром
    /// на пересечении (10, 10) и радиусом 20 футов задевает клетку на дуге
    /// (8, 6), но не угол старого квадрата (6, 6).
    #[test]
    fn fireball_pilot_circle_excludes_old_square_corner() {
        let center = grid_origin_for_target_cell(Point::new(10.0, 10.0));
        assert_eq!(center, GridCell::new(10, 10));
        let cells = circular_area_cells(&options((10.0, 10.0), 20.0));
        assert!(cells.contains(&GridCell::new(8, 6)));
        assert!(!cells.contains(&GridCell::new(6, 6)));
        assert!(circular_cell_covered(Point::new(8.0 - 10.0, 6.0 - 10.0), 20.0 / 5.0));
        assert!(!circular_cell_covered(Point::new(6.0 - 10.0, 6.0 - 10.0), 20.0 / 5.0));
    }
}

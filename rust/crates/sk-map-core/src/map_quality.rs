//! Перенос `server/map-quality.mjs`: проверка качества тактической карты —
//! годится ли она для игры за столом.
//!
//! Валидатор `validate_tactical_map` отвечает на вопрос «цела ли структура».
//! Этот модуль отвечает на другой — «можно ли на этой карте играть в D&D»:
//!
//! - у каждой постройки есть дверь наружу, а в просторной постройке — больше
//!   одной комнаты, и в стенах, выходящих на улицу, есть окна;
//! - каждая проходимая клетка досягаема от входа отряда;
//! - предметы не вылезают за край карты, не стоят на глухих клетках, не
//!   перегораживают дверной проём и не налезают друг на друга;
//! - дверь ведёт с проходимой клетки на проходимую, окно смотрит наружу;
//! - постройка не обрезана краем карты.
//!
//! Это сторож инварианта `AGENTS.md` §5 («сгенерированная карта играбельна»):
//! коды и подробности замечаний — байт в байт как у JS. Модуль — лист: читает
//! только саму карту и ничего не меняет. Проверка по программе сцены
//! ([`program_report`]) берёт словарь обещанного у `scene_requirements`.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::js;
use sk_scene_base::scene_requirements::{normalize_scene_requirements, required_program_kinds, requirement_assets, requirement_terrain, requirements_coverage};
use sk_tactical::tactical_map::{self as tm, Cover, EdgeKind, TacticalEdge, TacticalMap, TacticalProp};

/// Постройка от этой площади (клеток пола) обязана делиться на комнаты.
pub const MULTI_ROOM_MIN_CELLS: usize = 48;

/// Доля клеток просторного зала (от сотни клеток), где есть укрытие рядом.
const HALL_COVER_SHARE: f64 = 0.3;

const SIDES: [(i64, i64); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];

// --- записи отчёта --------------------------------------------------------

/// Замечание проверки (`MapProblem`): код и необязательная подробность.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MapProblem {
    pub code: &'static str,
    pub detail: Option<String>,
}

impl MapProblem {
    fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self { code, detail: Some(detail.into()) }
    }

    /// Форма JS: `{ code, detail }` или `{ code }`.
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("code".into(), Value::String(self.code.into()));
        if let Some(detail) = &self.detail {
            object.insert("detail".into(), Value::String(detail.clone()));
        }
        Value::Object(object)
    }
}

fn problems_json(problems: &[MapProblem]) -> Value {
    Value::Array(problems.iter().map(MapProblem::to_json).collect())
}

/// Числа отчёта в порядке ключей объекта JS.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MapStats(pub Vec<(&'static str, i64)>);

impl MapStats {
    /// Значение по ключу.
    pub fn get(&self, key: &str) -> Option<i64> {
        self.0.iter().find(|(name, _)| *name == key).map(|(_, value)| *value)
    }

    fn push(&mut self, key: &'static str, value: i64) {
        self.0.push((key, value));
    }

    fn extend(&mut self, other: &MapStats) {
        self.0.extend(other.0.iter().copied());
    }

    pub fn to_json(&self) -> Value {
        Value::Object(self.0.iter().map(|(key, value)| ((*key).to_string(), Value::from(*value))).collect())
    }
}

/// Итог `auditTacticalMap`, `richnessReport` и `playabilityReport`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MapReport {
    pub problems: Vec<MapProblem>,
    pub warnings: Vec<MapProblem>,
    pub stats: MapStats,
}

impl MapReport {
    /// Форма JS: `{ problems, warnings, stats }`.
    pub fn to_json(&self) -> Value {
        json!({ "problems": problems_json(&self.problems), "warnings": problems_json(&self.warnings), "stats": self.stats.to_json() })
    }
}

/// Итог `programReport`: ещё и обязательное, чего нет на карте.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProgramReport {
    pub problems: Vec<MapProblem>,
    pub warnings: Vec<MapProblem>,
    pub missing: Vec<String>,
    pub stats: MapStats,
}

impl ProgramReport {
    /// Форма JS: `{ problems, warnings, missing, stats }`.
    pub fn to_json(&self) -> Value {
        json!({
            "problems": problems_json(&self.problems),
            "warnings": problems_json(&self.warnings),
            "missing": js::strings_value(self.missing.iter().cloned()),
            "stats": self.stats.to_json(),
        })
    }
}

/// Клетки под мешающими шагу предметами: клетка → `assetId` первого предмета.
pub type BlockingCells = IndexMap<(i64, i64), String>;

// --- клетка предмета ------------------------------------------------------

/// Клетка следа предмета. След из карты — целые координаты; запасная клетка
/// `Math.floor(prop.x)` бывает и `NaN`, и бесконечностью — тогда клетки нет.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Spot {
    pub x: f64,
    pub y: f64,
}

impl Spot {
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    /// Целая клетка, если координаты — целые числа; иначе такой клетки нет.
    pub fn key(&self) -> Option<(i64, i64)> {
        let whole = |value: f64| (value.is_finite() && value.fract() == 0.0 && value.abs() < 9e15).then_some(value as i64);
        Some((whole(self.x)?, whole(self.y)?))
    }

    /// `${x},${y}` по правилам JS.
    pub fn text(&self) -> String {
        format!("{},{}", js::f64_string(self.x), js::f64_string(self.y))
    }

    fn offset(&self, dx: i64, dy: i64) -> Spot {
        Spot::new(self.x + dx as f64, self.y + dy as f64)
    }
}

/// След предмета: `prop.footprint?.length ? prop.footprint : [{ x: Math.floor(prop.x), y: Math.floor(prop.y) }]`.
pub fn prop_cells(prop: &TacticalProp) -> Vec<Spot> {
    if prop.footprint.is_empty() {
        vec![Spot::new(prop.x.floor(), prop.y.floor())]
    } else {
        prop.footprint.iter().map(|point| Spot::new(point.x as f64, point.y as f64)).collect()
    }
}

fn spot_cell<'a>(map: &'a TacticalMap, spot: &Spot) -> Option<tm::TacticalCell<'a>> {
    spot.key().and_then(|(x, y)| tm::cell_at(map, x, y))
}

// --- общее ----------------------------------------------------------------

/// `new Map(map.zones.map((zone) => [zone.id, zone.kind]))`: повтор id — побеждает последняя.
fn zone_kinds(map: &TacticalMap) -> HashMap<&str, &str> {
    map.zones.iter().map(|zone| (zone.id.as_str(), zone.kind.as_str())).collect()
}

fn edge_at(map: &TacticalMap, ax: i64, ay: i64, bx: i64, by: i64) -> Option<&TacticalEdge> {
    tm::edge_between(map, ax, ay, bx, by).ok().flatten()
}

/// Ключ ссылки графа комнат: `[a, b].sort().join('|')`.
fn link_key(a: &str, b: &str) -> String {
    let (first, second) = if a.encode_utf16().cmp(b.encode_utf16()).is_le() { (a, b) } else { (b, a) };
    format!("{first}|{second}")
}

fn percent(part: f64, whole: f64) -> i64 {
    js::round(part / whole * 100.0) as i64
}

// --- постройки ------------------------------------------------------------

/// Внутренние дворы: наружные зоны, со всех сторон окружённые постройкой.
fn enclosed_courtyards(map: &TacticalMap, zone_kind: &HashMap<&str, &str>) -> HashSet<String> {
    let mut open: HashSet<&str> = HashSet::new();
    let mut seen: Vec<&str> = Vec::new();
    for y in 0..map.height {
        for x in 0..map.width {
            let Some(cell) = tm::cell_at(map, x, y) else { continue };
            if !cell.passable || zone_kind.get(cell.zone) != Some(&"exterior") {
                continue;
            }
            if !seen.contains(&cell.zone) {
                seen.push(cell.zone);
            }
            if open.contains(cell.zone) {
                continue;
            }
            // Поле, обнесённое скалой края карты, — не двор: двор стоит внутри дома.
            if x <= 1 || y <= 1 || x >= map.width - 2 || y >= map.height - 2 {
                open.insert(cell.zone);
                continue;
            }
            for (dx, dy) in SIDES {
                let Some(next) = tm::cell_at(map, x + dx, y + dy) else {
                    open.insert(cell.zone);
                    break;
                };
                if !next.passable || next.zone == cell.zone || zone_kind.get(next.zone) != Some(&"exterior") {
                    continue;
                }
                let edge = edge_at(map, x, y, x + dx, y + dy);
                if edge.is_none_or(|edge| !edge.blocks_move || edge.kind == EdgeKind::Door) {
                    open.insert(cell.zone);
                    break;
                }
            }
        }
    }
    seen.into_iter().filter(|zone| !open.contains(zone)).map(str::to_string).collect()
}

/// Компоненты связности помещений.
struct Components {
    components: Vec<Vec<(i64, i64)>>,
    component: HashMap<(i64, i64), usize>,
}

/// Помещения — связные области клеток зон `interior`, разделённые стенами;
/// `joins` — соединяет ли ребро две клетки.
fn interior_components(map: &TacticalMap, zone_kind: &HashMap<&str, &str>, joins: impl Fn(Option<&TacticalEdge>) -> bool) -> Components {
    let courtyards = enclosed_courtyards(map, zone_kind);
    // Проём между помещениями графовой планировки — проходимая клетка без
    // зоны: она соединяет комнаты. Внутренний двор — часть постройки.
    let inside = |cell: &tm::TacticalCell<'_>| {
        cell.passable && (zone_kind.get(cell.zone) == Some(&"interior") || cell.zone.is_empty() || courtyards.contains(cell.zone))
    };
    let mut component: HashMap<(i64, i64), usize> = HashMap::new();
    let mut components: Vec<Vec<(i64, i64)>> = Vec::new();
    for y in 0..map.height {
        for x in 0..map.width {
            let Some(cell) = tm::cell_at(map, x, y) else { continue };
            if !inside(&cell) || cell.zone.is_empty() || component.contains_key(&(x, y)) {
                continue;
            }
            let id = components.len();
            let mut cells = Vec::new();
            let mut queue = vec![(x, y)];
            component.insert((x, y), id);
            let mut index = 0;
            while index < queue.len() {
                let current = queue[index];
                index += 1;
                cells.push(current);
                for (dx, dy) in SIDES {
                    let next = (current.0 + dx, current.1 + dy);
                    if component.contains_key(&next) {
                        continue;
                    }
                    let Some(cell) = tm::cell_at(map, next.0, next.1) else { continue };
                    if !inside(&cell) {
                        continue;
                    }
                    if !joins(edge_at(map, current.0, current.1, next.0, next.1)) {
                        continue;
                    }
                    component.insert(next, id);
                    queue.push(next);
                }
            }
            components.push(cells);
        }
    }
    Components { components, component }
}

// --- аудит ----------------------------------------------------------------

/// `auditTacticalMap(map)`: замечания (`problems` — провал проверки),
/// предупреждения и числа карты.
pub fn audit_tactical_map(map: &TacticalMap) -> MapReport {
    let mut problems: Vec<MapProblem> = Vec::new();
    let zone_kind = zone_kinds(map);
    let kind_at = |x: i64, y: i64| -> Option<&str> {
        let cell = tm::cell_at(map, x, y)?;
        if cell.zone.is_empty() && cell.passable {
            return Some("interior");
        }
        Some(zone_kind.get(cell.zone).copied().unwrap_or("exterior"))
    };

    // --- предметы ---
    let mut blocking: BlockingCells = IndexMap::new();
    let mut props_outside: i64 = 0;
    for prop in &map.props {
        for spot in prop_cells(prop) {
            let Some(((x, y), cell)) = spot.key().and_then(|key| tm::cell_at(map, key.0, key.1).map(|cell| (key, cell))) else {
                props_outside += 1;
                problems.push(MapProblem::new("PROP_OUT_OF_BOUNDS", format!("{}@{}", prop.asset_id, spot.text())));
                continue;
            };
            if prop.transition.is_none() && prop.mount.is_none() && !cell.passable && prop.blocks_move {
                problems.push(MapProblem::new("PROP_ON_SOLID_CELL", format!("{}@{x},{y}", prop.asset_id)));
            }
            // Высокая мебель перед окном заслоняет и свет, и обзор наружу.
            if prop.transition.is_none()
                && prop.mount.is_none()
                && prop.blocks_sight
                && SIDES.iter().any(|(dx, dy)| edge_at(map, x, y, x + dx, y + dy).is_some_and(|edge| edge.kind == EdgeKind::Window))
            {
                problems.push(MapProblem::new("PROP_BLOCKS_WINDOW", format!("{}@{x},{y}", prop.asset_id)));
            }
            if prop.blocks_move && prop.mount.is_none() {
                match blocking.get(&(x, y)) {
                    Some(previous) => problems.push(MapProblem::new("PROPS_OVERLAP", format!("{previous}+{}@{x},{y}", prop.asset_id))),
                    None => {
                        blocking.insert((x, y), prop.asset_id.clone());
                    }
                }
            }
        }
        // Предмет в несколько клеток не стоит сквозь стену и не стоит одной
        // частью в доме, другой на улице (#184): модель рисуется по центру
        // футпринта, и стена проходила через очаг или печь.
        if prop.transition.is_none() && prop.mount.is_none() && prop.footprint.len() > 1 {
            let own: HashSet<(i64, i64)> = prop.footprint.iter().map(|point| (point.x, point.y)).collect();
            let crossed = prop.footprint.iter().any(|point| {
                [(1, 0), (0, 1)].iter().any(|(dx, dy)| {
                    own.contains(&(point.x + dx, point.y + dy))
                        && edge_at(map, point.x, point.y, point.x + dx, point.y + dy)
                            .is_some_and(|edge| matches!(edge.kind, EdgeKind::Wall | EdgeKind::Window | EdgeKind::Door))
                })
            });
            let kinds: HashSet<&str> = prop.footprint.iter().filter_map(|point| kind_at(point.x, point.y)).filter(|kind| !kind.is_empty()).collect();
            if crossed || kinds.len() > 1 {
                let first = prop.footprint[0];
                problems.push(MapProblem::new("PROP_CROSSES_WALL", format!("{}@{},{}", prop.asset_id, first.x, first.y)));
            }
        }
    }

    // --- рёбра: двери и окна ---
    let mut windows: i64 = 0;
    let mut exterior_doors: i64 = 0;
    for edge in tm::edge_list(map) {
        let (nx, ny) = tm::edge_neighbor(edge.x, edge.y, edge.dir);
        let a = tm::cell_at(map, edge.x, edge.y);
        let b = tm::cell_at(map, nx, ny);
        let label = format!("{},{},{}", edge.x, edge.y, edge.dir.as_str());
        if edge.kind == EdgeKind::Door {
            if !a.is_some_and(|cell| cell.passable) || !b.is_some_and(|cell| cell.passable) {
                problems.push(MapProblem::new("DOOR_TO_NOWHERE", label.clone()));
            }
            // Порог с обеих сторон и клетка сразу за проёмом в толстой стене.
            let (sx, sy) = (nx - edge.x, ny - edge.y);
            for point in [(edge.x, edge.y), (nx, ny), (edge.x - sx, edge.y - sy), (nx + sx, ny + sy)] {
                if let Some(asset) = blocking.get(&point) {
                    problems.push(MapProblem::new("DOORWAY_BLOCKED", format!("{asset}@{},{}", point.0, point.1)));
                }
            }
            if kind_at(edge.x, edge.y) != kind_at(nx, ny) {
                exterior_doors += 1;
            }
        }
        if edge.kind == EdgeKind::Window {
            windows += 1;
            // Окно в толстой стене смотрит из зала в клетку кладки — это нормально;
            // плохо окно между двумя проходимыми помещениями.
            if a.is_some_and(|cell| cell.passable)
                && b.is_some_and(|cell| cell.passable)
                && kind_at(edge.x, edge.y) == Some("interior")
                && kind_at(nx, ny) == Some("interior")
            {
                problems.push(MapProblem::new("WINDOW_BETWEEN_ROOMS", label));
            }
        }
    }

    // --- двери поселения выходят к дороге ---
    if map.zones.iter().any(|zone| zone.id == "street") {
        let road = |x: i64, y: i64| matches!(tm::cell_at(map, x, y).map(|cell| cell.zone), Some("street" | "square" | "path"));
        for door in &map.doors {
            let sides = [(door.x, door.y), tm::edge_neighbor(door.x, door.y, door.dir)];
            let outside = sides.iter().copied().find(|(x, y)| kind_at(*x, *y) == Some("exterior") && tm::cell_passable(map, *x, *y));
            let Some((ox, oy)) = outside else { continue };
            if !sides.iter().any(|(x, y)| kind_at(*x, *y) == Some("interior")) {
                continue;
            }
            let touches = road(ox, oy) || SIDES.iter().any(|(dx, dy)| road(ox + dx, oy + dy));
            if !touches {
                problems.push(MapProblem::new("DOOR_OFF_ROAD", format!("{}@{ox},{oy}", door.id)));
            }
        }
        // Тропа — проход: предмет, мешающий шагу, на ней перекрыл бы путь к двери.
        for y in 0..map.height {
            for x in 0..map.width {
                if tm::cell_at(map, x, y).is_some_and(|cell| cell.zone == "path") {
                    if let Some(asset) = blocking.get(&(x, y)) {
                        problems.push(MapProblem::new("PATH_BLOCKED", format!("{asset}@{x},{y}")));
                    }
                }
            }
        }
    }

    // --- постройки и комнаты ---
    // Постройка — помещения, связанные любым ребром, кроме глухой стены и окна.
    let buildings = interior_components(map, &zone_kind, |edge| edge.is_none_or(|edge| matches!(edge.kind, EdgeKind::Door | EdgeKind::None)));
    // Комната — помещения, связанные только ребром без стены и без двери.
    let rooms = interior_components(map, &zone_kind, |edge| edge.is_none_or(|edge| edge.kind == EdgeKind::None));
    let party = map.spawn_points.iter().find(|point| point.role == "party");
    let mut multi_room: i64 = 0;
    for cells in &buildings.components {
        let room_ids: HashSet<Option<usize>> = cells.iter().map(|cell| rooms.component.get(cell).copied()).collect();
        if room_ids.len() > 1 {
            multi_room += 1;
        }
        let label = format!("{},{}", cells[0].0, cells[0].1);
        let mut has_exit = false;
        let mut outer_walls = 0;
        let mut outer_windows = 0;
        // Постройка под открытым небом граничит с улицей. Подземелье, пещера и
        // храм-комплекс улицы не видят — окна и выход наружу с них не спрашиваются.
        let mut open_air = false;
        let mut off_map: Vec<(i64, i64)> = Vec::new();
        for &(cx, cy) in cells {
            for (dx, dy) in SIDES {
                let (nx, ny) = (cx + dx, cy + dy);
                if buildings.component.get(&(nx, ny)) == buildings.component.get(&(cx, cy)) {
                    continue;
                }
                let edge = edge_at(map, cx, cy, nx, ny);
                let outside = kind_at(nx, ny);
                let neighbor = tm::cell_at(map, nx, ny);
                if outside.is_none() && edge.is_none_or(|edge| edge.kind == EdgeKind::None) {
                    off_map.push((cx, cy));
                }
                if outside == Some("exterior") && neighbor.is_some_and(|cell| cell.passable) {
                    open_air = true;
                    if edge.is_none_or(|edge| edge.kind == EdgeKind::Door) {
                        has_exit = true;
                    }
                    if edge.is_some_and(|edge| edge.kind == EdgeKind::Wall) {
                        outer_walls += 1;
                    }
                    if edge.is_some_and(|edge| edge.kind == EdgeKind::Window) {
                        outer_windows += 1;
                    }
                }
                // Толстая стена — клетка кладки между комнатой и улицей. Окно в
                // ней стоит на одной из её граней, поэтому смотрим сквозь кладку.
                if neighbor.is_some_and(|cell| !cell.passable) {
                    let (tx, ty) = (nx + dx, ny + dy);
                    if tm::cell_passable(map, tx, ty) && kind_at(tx, ty) == Some("exterior") {
                        open_air = true;
                        let far = edge_at(map, nx, ny, tx, ty);
                        if edge.is_some_and(|edge| edge.kind == EdgeKind::Window) || far.is_some_and(|edge| edge.kind == EdgeKind::Window) {
                            outer_windows += 1;
                        } else {
                            outer_walls += 1;
                        }
                    }
                }
                if outside.is_none() && edge.is_some_and(|edge| edge.kind == EdgeKind::Door) {
                    has_exit = true;
                }
            }
        }
        // Помещение, упёртое в край карты без стены, — обрезанная постройка. Для
        // подземного комплекса край у входа отряда допустим: это устье.
        let near_entrance = |(px, py): (i64, i64)| party.is_some_and(|party| (px - party.x).abs() + (py - party.y).abs() <= 3);
        for point in &off_map {
            let text = format!("{},{}", point.0, point.1);
            if open_air {
                problems.push(MapProblem::new("BUILDING_CUT_BY_EDGE", text));
            } else if !near_entrance(*point) {
                problems.push(MapProblem::new("PASSAGE_OFF_MAP", text));
            }
        }
        if open_air {
            if !has_exit {
                problems.push(MapProblem::new("BUILDING_WITHOUT_EXIT", label.clone()));
            }
            if cells.len() >= MULTI_ROOM_MIN_CELLS && room_ids.len() < 2 {
                problems.push(MapProblem::new("BUILDING_SINGLE_ROOM", format!("{label} ({} кл.)", cells.len())));
            }
            if outer_walls >= 8 && outer_windows == 0 {
                problems.push(MapProblem::new("BUILDING_WITHOUT_WINDOWS", label));
            }
        }
    }

    // --- досягаемость ---
    let mut unreachable: i64 = 0;
    let mut passable: i64 = 0;
    match party {
        None => problems.push(MapProblem { code: "NO_PARTY_SPAWN", detail: None }),
        Some(party) => {
            if !tm::cell_passable(map, party.x, party.y) || blocking.contains_key(&(party.x, party.y)) {
                problems.push(MapProblem::new("PARTY_SPAWN_BLOCKED", format!("{},{}", party.x, party.y)));
            }
            let blocked: HashSet<(i64, i64)> = blocking.keys().copied().collect();
            let reached = tm::reachable_cells(map, party.x, party.y, true, Some(&blocked));
            for y in 0..map.height {
                for x in 0..map.width {
                    let Some(cell) = tm::cell_at(map, x, y) else { continue };
                    if !cell.passable || blocking.contains_key(&(x, y)) || cell.surface == "water" {
                        continue;
                    }
                    passable += 1;
                    if !reached.contains(&(x, y)) {
                        unreachable += 1;
                    }
                }
            }
            if passable > 0 && unreachable as f64 / passable as f64 > 0.03 {
                problems.push(MapProblem::new("UNREACHABLE_FLOOR", format!("{unreachable}/{passable}")));
            }
        }
    }

    // Петли (цикломатика графа комнат): ребро — дверь или проём между двумя
    // помещениями или помещением и улицей.
    let node_of = |x: i64, y: i64| -> Option<String> {
        if let Some(id) = rooms.component.get(&(x, y)) {
            return Some(format!("r{id}"));
        }
        tm::cell_passable(map, x, y).then(|| "out".to_string())
    };
    let mut links: IndexSet<String> = IndexSet::new();
    for edge in tm::edge_list(map) {
        if edge.kind != EdgeKind::Door {
            continue;
        }
        let (nx, ny) = tm::edge_neighbor(edge.x, edge.y, edge.dir);
        if let (Some(a), Some(b)) = (node_of(edge.x, edge.y), node_of(nx, ny)) {
            if a != b {
                links.insert(link_key(&a, &b));
            }
        }
    }
    for y in 0..map.height {
        for x in 0..map.width {
            if !tm::cell_at(map, x, y).is_some_and(|cell| cell.passable && cell.zone.is_empty()) {
                continue;
            }
            let mut around: IndexSet<String> = IndexSet::new();
            for (dx, dy) in SIDES {
                if let Some(node) = node_of(x + dx, y + dy) {
                    around.insert(node);
                }
            }
            for i in 0..around.len() {
                for j in i + 1..around.len() {
                    links.insert(link_key(&around[i], &around[j]));
                }
            }
        }
    }
    // Цикломатическое число E − V + C, где C — число компонент связности.
    let mut parent: IndexMap<String, String> = IndexMap::new();
    let root = |parent: &IndexMap<String, String>, node: &str| -> String {
        let mut current = node.to_string();
        while let Some(next) = parent.get(&current).filter(|next| **next != current) {
            current = next.clone();
        }
        current
    };
    for link in &links {
        let (a, b) = link.split_once('|').unwrap_or((link.as_str(), ""));
        parent.entry(a.to_string()).or_insert_with(|| a.to_string());
        parent.entry(b.to_string()).or_insert_with(|| b.to_string());
        let (ra, rb) = (root(&parent, a), root(&parent, b));
        parent.insert(ra, rb);
    }
    let components: HashSet<String> = parent.keys().map(|node| root(&parent, node)).collect();
    let loops = (links.len() as i64 - parent.len() as i64 + components.len() as i64).max(0);

    let richness = richness_report(map);
    let play = playability_report(map, &blocking);
    let ground = terrain_report(map, &blocking);
    problems.extend(richness.problems.iter().cloned());
    problems.extend(play.problems.iter().cloned());
    let mut warnings = richness.warnings.clone();
    warnings.extend(play.warnings.iter().cloned());
    let mut stats = MapStats::default();
    stats.extend(&richness.stats);
    stats.extend(&play.stats);
    stats.extend(&ground);
    stats.push("cells", passable);
    stats.push("buildings", buildings.components.len() as i64);
    stats.push("multi_room", multi_room);
    stats.push("rooms", rooms.components.len() as i64);
    stats.push("exterior_doors", exterior_doors);
    stats.push("loops", loops);
    stats.push("doors", map.doors.len() as i64);
    stats.push("windows", windows);
    stats.push("props", map.props.len() as i64);
    stats.push("props_outside", props_outside);
    stats.push("unreachable", unreachable);
    MapReport { problems, warnings, stats }
}

// --- богатство обстановки -------------------------------------------------

/// Предметы, которые и должны стоять рядом одинаковыми: забор тянется линией,
/// скамьи храма — рядами, стулья — вокруг стола.
const ROW_ASSETS: [&str; 18] = [
    "village_fence", "rail_fence", "prayer_bench", "crypt_niche", "crate_stack", "barrel_stack", "crate", "barrel", "bunk_bed", "grave", "chair", "stool", "bench",
    "hitching_post", "shelf_wall", "bookshelf", "sack", "pillar",
];

/// Деревья образуют рощу, но четыре одинаковых дерева вплотную — уже штамп.
const TREE_CLUSTER_LIMIT: usize = 4;

/// `Math.max(Math.abs(dx), Math.abs(dy)) <= 1`, где `NaN` — «нет».
fn touching(left: &Spot, right: &Spot) -> bool {
    let dx = (left.x - right.x).abs();
    let dy = (left.y - right.y).abs();
    !dx.is_nan() && !dy.is_nan() && dx.max(dy) <= 1.0
}

/// `richnessReport(map)`: кучки одинаковых предметов вплотную, доля самого
/// частого предмета и число разных предметов.
pub fn richness_report(map: &TacticalMap) -> MapReport {
    let mut report = MapReport::default();
    let placed: Vec<&TacticalProp> = map.props.iter().filter(|prop| prop.mount.is_none() && prop.transition.is_none()).collect();
    let cells_of: Vec<Vec<Spot>> = placed.iter().map(|prop| prop_cells(prop)).collect();
    // Соседи по разные стороны тонкой стены — это две комнаты, а не одна куча.
    let zone_of: Vec<Option<&str>> = placed.iter().map(|prop| spot_cell(map, &Spot::new(prop.x.floor(), prop.y.floor())).map(|cell| cell.zone)).collect();
    let mut by_asset: IndexMap<&str, Vec<usize>> = IndexMap::new();
    for (index, prop) in placed.iter().enumerate() {
        by_asset.entry(prop.asset_id.as_str()).or_default().push(index);
    }
    let near = |a: usize, b: usize| zone_of[a] == zone_of[b] && cells_of[a].iter().any(|left| cells_of[b].iter().any(|right| touching(left, right)));
    let mut clusters: i64 = 0;
    let mut largest: usize = 0;
    for (asset_id, indices) in &by_asset {
        if indices.len() < 3 {
            continue;
        }
        let mut seen: HashSet<usize> = HashSet::new();
        for &start in indices {
            if seen.contains(&start) {
                continue;
            }
            let mut group = vec![start];
            seen.insert(start);
            let mut cursor = 0;
            while cursor < group.len() {
                for &other in indices {
                    if seen.contains(&other) || !near(group[cursor], other) {
                        continue;
                    }
                    seen.insert(other);
                    group.push(other);
                }
                cursor += 1;
            }
            largest = largest.max(group.len());
            let tree = asset_id.starts_with("tree_") || *asset_id == "bush" || *asset_id == "shrub";
            let limit = if ROW_ASSETS.contains(asset_id) {
                usize::MAX
            } else if tree {
                TREE_CLUSTER_LIMIT
            } else {
                3
            };
            if group.len() >= limit {
                clusters += 1;
                let first = cells_of[group[0]][0];
                report.problems.push(MapProblem::new("REPEATED_CLUSTER", format!("{asset_id}×{}@{}", group.len(), first.text())));
            }
        }
    }
    // Ряды задуманы, поэтому однообразие считается по остальным предметам.
    let solo: Vec<(&str, usize)> = by_asset.iter().filter(|(asset_id, _)| !ROW_ASSETS.contains(*asset_id)).map(|(asset_id, list)| (*asset_id, list.len())).collect();
    let total = placed.len();
    let top = solo.iter().map(|(_, count)| *count).max().unwrap_or(0);
    let top_asset = solo.iter().find(|(_, count)| *count == top).map_or("", |(asset_id, _)| *asset_id);
    // Один предмет больше чем на четверть карты — однообразие.
    if total >= 16 && top as f64 / total as f64 > 0.28 {
        report.warnings.push(MapProblem::new("MONOTONOUS_PROPS", format!("{top_asset} {top}/{total}")));
    }
    report.stats.push("kinds", by_asset.len() as i64);
    report.stats.push("top_share", if total > 0 { percent(top as f64, total as f64) } else { 0 });
    report.stats.push("clusters", clusters);
    report.stats.push("largest_cluster", largest as i64);
    report
}

// --- играбельность ----------------------------------------------------------

fn free_cell(map: &TacticalMap, blocking: &BlockingCells, x: i64, y: i64) -> bool {
    tm::cell_at(map, x, y).is_some_and(|cell| cell.passable && cell.surface != "water") && !blocking.contains_key(&(x, y))
}

fn blocked_set(blocking: &BlockingCells) -> HashSet<(i64, i64)> {
    blocking.keys().copied().collect()
}

/// `playabilityReport(map, blockingAt)`: место для отряда у входа, укрытия на
/// открытом месте и в залах, дальность прямого обзора.
pub fn playability_report(map: &TacticalMap, blocking: &BlockingCells) -> MapReport {
    let mut report = MapReport::default();
    let free = |x: i64, y: i64| free_cell(map, blocking, x, y);
    // Отряд встаёт у входа: нужно хотя бы шесть свободных клеток в двух шагах.
    let party = map.spawn_points.iter().find(|point| point.role == "party");
    let mut spawn_room: i64 = 0;
    if let Some(party) = party {
        let blocked = blocked_set(blocking);
        let reached = tm::reachable_cells(map, party.x, party.y, true, Some(&blocked));
        for dy in -2..=2 {
            for dx in -2..=2 {
                let (x, y) = (party.x + dx, party.y + dy);
                if reached.contains(&(x, y)) && free(x, y) {
                    spawn_room += 1;
                }
            }
        }
        if spawn_room < 6 {
            report.problems.push(MapProblem::new("SPAWN_CRAMPED", format!("{spawn_room} кл.")));
        }
    }
    // Стена рядом — глухая клетка или ребро-стена.
    let wall_beside = |x: i64, y: i64| {
        SIDES.iter().any(|(dx, dy)| match tm::cell_at(map, x + dx, y + dy) {
            None => false,
            Some(neighbor) if !neighbor.passable => true,
            Some(_) => edge_at(map, x, y, x + dx, y + dy).is_some_and(|edge| edge.kind != EdgeKind::Door && edge.blocks_move),
        })
    };
    let mut cover_at: HashSet<(i64, i64)> = HashSet::new();
    for prop in &map.props {
        if prop.cover == Cover::None {
            continue;
        }
        for cell in &prop.footprint {
            for dy in -1..=1 {
                for dx in -1..=1 {
                    cover_at.insert((cell.x + dx, cell.y + dy));
                }
            }
        }
    }
    let zone_kind = zone_kinds(map);
    let interior = |zone: &str| zone_kind.get(zone) == Some(&"interior");
    let mut open: i64 = 0;
    let mut covered: i64 = 0;
    for y in 0..map.height {
        for x in 0..map.width {
            if !free(x, y) || tm::cell_at(map, x, y).is_some_and(|cell| interior(cell.zone)) {
                continue;
            }
            open += 1;
            if cover_at.contains(&(x, y)) || wall_beside(x, y) {
                covered += 1;
            }
        }
    }
    let cover_share = if open > 0 { covered as f64 / open as f64 } else { 1.0 };
    if open >= 150 && cover_share < 0.3 {
        report.warnings.push(MapProblem::new("OPEN_GROUND_NO_COVER", format!("{}%", js::round(cover_share * 100.0) as i64)));
    }
    // Укрытие в просторном зале: та же мерка по каждой комнате от сотни клеток.
    let mut halls: IndexMap<String, (i64, i64)> = IndexMap::new();
    for y in 0..map.height {
        for x in 0..map.width {
            let zone = tm::cell_at(map, x, y).map_or("", |cell| cell.zone);
            if !free(x, y) || !interior(zone) {
                continue;
            }
            let hall = halls.entry(zone.to_string()).or_insert((0, 0));
            hall.0 += 1;
            if cover_at.contains(&(x, y)) || wall_beside(x, y) {
                hall.1 += 1;
            }
        }
    }
    let mut barest_hall = 1.0_f64;
    for (zone, (cells, covered)) in &halls {
        if *cells < 100 {
            continue;
        }
        let share = *covered as f64 / *cells as f64;
        barest_hall = barest_hall.min(share);
        if share < HALL_COVER_SHARE {
            report.warnings.push(MapProblem::new("HALL_NO_COVER", format!("{zone} {}%", js::round(share * 100.0) as i64)));
        }
    }
    // Прямой обзор: самая длинная непрерывная линия по строке или столбцу.
    let mut sightline: i64 = 0;
    let sight_blocked: HashSet<(i64, i64)> = map.props.iter().filter(|prop| prop.blocks_sight).flat_map(|prop| prop.footprint.iter().map(|cell| (cell.x, cell.y))).collect();
    for (dx, dy) in [(1, 0), (0, 1)] {
        let (lines, length) = if dx == 1 { (map.height, map.width) } else { (map.width, map.height) };
        for start in 0..lines {
            let mut run: i64 = 0;
            for step in 0..length {
                let (x, y) = if dx == 1 { (step, start) } else { (start, step) };
                let edge = if step > 0 { edge_at(map, x - dx, y - dy, x, y) } else { None };
                let clear = tm::cell_passable(map, x, y) && !sight_blocked.contains(&(x, y));
                run = if !clear {
                    0
                } else if edge.is_some_and(|edge| edge.blocks_sight) {
                    1
                } else {
                    run + 1
                };
                sightline = sightline.max(run);
            }
        }
    }
    report.stats.push("spawn_room", spawn_room);
    report.stats.push("cover_pct", js::round(cover_share * 100.0) as i64);
    report.stats.push("hall_cover_pct", js::round(barest_hall * 100.0) as i64);
    report.stats.push("sightline_ft", sightline * 5);
    report
}

// --- местность ----------------------------------------------------------------

/// Наибольший перепад между соседними клетками, который проходят шагом, в футах.
pub const STEP_WITHOUT_CLIMB_FEET: i64 = 5;

/// `terrainReport(map, blockingAt)`: числа местности под ногами —
/// `difficult_pct`, `elevation_levels`, `smallest_plateau`, `climb_cells`,
/// `cover_side_pct` (`docs/maps-dnd-standards-plan.md`, задачи 1, 2, 7).
pub fn terrain_report(map: &TacticalMap, blocking: &BlockingCells) -> MapStats {
    let zone_kind = zone_kinds(map);
    let free = |x: i64, y: i64| free_cell(map, blocking, x, y);
    let wall = |x: i64, y: i64, nx: i64, ny: i64| edge_at(map, x, y, nx, ny).is_some_and(|edge| edge.kind != EdgeKind::Door && edge.blocks_move);
    let mut cells: i64 = 0;
    let mut difficult: i64 = 0;
    let mut open: i64 = 0;
    let mut covered: i64 = 0;
    let mut levels: HashSet<i64> = HashSet::new();
    for y in 0..map.height {
        for x in 0..map.width {
            if !free(x, y) {
                continue;
            }
            let Some(cell) = tm::cell_at(map, x, y) else { continue };
            cells += 1;
            if cell.move_cost > 1 {
                difficult += 1;
            }
            levels.insert(cell.elevation);
            if zone_kind.get(cell.zone) == Some(&"interior") {
                continue;
            }
            open += 1;
            if SIDES.iter().any(|(dx, dy)| blocking.contains_key(&(x + dx, y + dy)) || wall(x, y, x + dx, y + dy)) {
                covered += 1;
            }
        }
    }
    // Площадки: связные по сторонам клетки одной ненулевой высоты.
    let ground = |x: i64, y: i64| tm::cell_at(map, x, y).filter(|cell| cell.passable && cell.surface != "water").map(|cell| cell.elevation);
    let mut smallest_plateau: usize = 0;
    let mut seen: HashSet<(i64, i64)> = HashSet::new();
    for y in 0..map.height {
        for x in 0..map.width {
            let Some(elevation) = ground(x, y) else { continue };
            if elevation == 0 || seen.contains(&(x, y)) {
                continue;
            }
            let mut queue = vec![(x, y)];
            seen.insert((x, y));
            let mut index = 0;
            while index < queue.len() {
                let (px, py) = queue[index];
                index += 1;
                for (dx, dy) in SIDES {
                    let next = (px + dx, py + dy);
                    if seen.contains(&next) || ground(next.0, next.1) != Some(elevation) {
                        continue;
                    }
                    seen.insert(next);
                    queue.push(next);
                }
            }
            smallest_plateau = if smallest_plateau > 0 { smallest_plateau.min(queue.len()) } else { queue.len() };
        }
    }
    // Досягаемость шагом: тот же поиск от входа, но перепад не больше шага.
    let mut climb: i64 = 0;
    let party = map.spawn_points.iter().find(|point| point.role == "party");
    if let Some(party) = party.filter(|party| free(party.x, party.y)) {
        let blocked = blocked_set(blocking);
        let reached = tm::reachable_cells(map, party.x, party.y, true, Some(&blocked));
        let elevation = |x: i64, y: i64| tm::cell_at(map, x, y).map_or(0, |cell| cell.elevation);
        let mut stepped: HashSet<(i64, i64)> = HashSet::from([(party.x, party.y)]);
        let mut queue = vec![(party.x, party.y)];
        let mut index = 0;
        while index < queue.len() {
            let (px, py) = queue[index];
            index += 1;
            let own = elevation(px, py);
            for (dx, dy) in SIDES {
                let next = (px + dx, py + dy);
                if stepped.contains(&next) || !reached.contains(&next) || wall(px, py, next.0, next.1) {
                    continue;
                }
                if (elevation(next.0, next.1) - own).abs() > STEP_WITHOUT_CLIMB_FEET {
                    continue;
                }
                stepped.insert(next);
                queue.push(next);
            }
        }
        for (x, y) in &reached {
            if free(*x, *y) && !stepped.contains(&(*x, *y)) {
                climb += 1;
            }
        }
    }
    let mut stats = MapStats::default();
    stats.push("difficult_pct", if cells > 0 { percent(difficult as f64, cells as f64) } else { 0 });
    stats.push("elevation_levels", levels.len() as i64);
    stats.push("smallest_plateau", smallest_plateau as i64);
    stats.push("climb_cells", climb);
    stats.push("cover_side_pct", if open > 0 { percent(covered as f64, open as f64) } else { 0 });
    stats
}

// --- настилы ------------------------------------------------------------------

/// `platformCells(map)`: клетки настилов — наружный деревянный пол выше земли.
pub fn platform_cells(map: &TacticalMap) -> Vec<(i64, i64)> {
    let zone_kind = zone_kinds(map);
    let mut cells = Vec::new();
    for y in 0..map.height {
        for x in 0..map.width {
            if tm::cell_at(map, x, y).is_some_and(|cell| cell.passable && cell.material == "wood" && cell.elevation > 0 && zone_kind.get(cell.zone) != Some(&"interior")) {
                cells.push((x, y));
            }
        }
    }
    cells
}

/// `countPlatforms(map)`: сколько настилов на карте — связные пятна из [`platform_cells`].
pub fn count_platforms(map: &TacticalMap) -> usize {
    let raised: IndexSet<(i64, i64)> = platform_cells(map).into_iter().collect();
    let mut seen: HashSet<(i64, i64)> = HashSet::new();
    let mut count = 0;
    for start in &raised {
        if seen.contains(start) {
            continue;
        }
        count += 1;
        let mut queue = vec![*start];
        seen.insert(*start);
        let mut index = 0;
        while index < queue.len() {
            let (x, y) = queue[index];
            index += 1;
            for (dx, dy) in SIDES {
                let next = (x + dx, y + dy);
                if seen.contains(&next) || !raised.contains(&next) {
                    continue;
                }
                seen.insert(next);
                queue.push(next);
            }
        }
    }
    count
}

// --- программа сцены -----------------------------------------------------------

/// Наименьший размер карты под масштаб места.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MinSize {
    pub width: i64,
    pub height: i64,
}

/// Наименьшая карта под масштаб поселения: деревня на поле 16×16 деревней не
/// выглядит (этап 4 `docs/map-generation-plan.md`).
pub const SETTLEMENT_MIN_SIZE: MinSize = MinSize { width: 24, height: 20 };

/// Доля глухого в сцене под открытым небом, после которой площадь — не площадь.
const OPEN_SCENE_BLOCKED_SHARE: f64 = 0.35;

/// Закуток недосягаемых клеток больше этого — уже потерянная часть карты.
const POCKET_LIMIT: usize = 4;

/// Простор у центра сцены: свободных досягаемых клеток в двух шагах вокруг предмета.
const FOCUS_RADIUS: i64 = 2;
pub const FOCUS_MIN_ROOM: usize = 6;

/// `focusRoom(footprint, reached, blocked)`: свободные досягаемые клетки в двух
/// шагах вокруг следа предмета (одна мерка для проверки программы и для
/// расстановки центра сцены).
pub fn focus_room(footprint: &[Spot], reached: &IndexSet<(i64, i64)>, blocked: &HashSet<(i64, i64)>) -> usize {
    let own: HashSet<(i64, i64)> = footprint.iter().filter_map(Spot::key).collect();
    let mut around: HashSet<(i64, i64)> = HashSet::new();
    for point in footprint {
        for dy in -FOCUS_RADIUS..=FOCUS_RADIUS {
            for dx in -FOCUS_RADIUS..=FOCUS_RADIUS {
                let Some(at) = point.offset(dx, dy).key() else { continue };
                if !own.contains(&at) && reached.contains(&at) && !blocked.contains(&at) {
                    around.insert(at);
                }
            }
        }
    }
    around.len()
}

/// Параметры `programReport`: мерка масштаба и «открытая сцена» — место, где
/// собираются люди (там глухое больше трети — провал).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ProgramOptions {
    pub min_size: Option<MinSize>,
    pub open_scene: bool,
}

/// `programReport(map, program, options)`: обещанное программой сцены стоит на
/// карте и до него можно дойти от входа отряда. `program` — сохранённая
/// программа (`scene.map_requirements`) любой формы.
pub fn program_report(map: &TacticalMap, program: &Value, options: &ProgramOptions) -> ProgramReport {
    let mut report = ProgramReport::default();
    let items = normalize_scene_requirements(program);
    let required: Vec<String> = required_program_kinds(program);
    let mut counts = Map::new();
    for prop in &map.props {
        let count = counts.get(&prop.asset_id).and_then(Value::as_i64).unwrap_or(0);
        counts.insert(prop.asset_id.clone(), Value::from(count + 1));
    }
    let platforms = count_platforms(map);
    let terrain = json!({ "platform": platforms });
    let coverage = requirements_coverage(&items, Some(&Value::Object(counts)), Some(&terrain));
    for id in &coverage.missing {
        if required.contains(id) {
            report.missing.push(id.clone());
            report.problems.push(MapProblem::new("PROGRAM_ANCHOR_MISSING", id.clone()));
        } else {
            report.warnings.push(MapProblem::new("PROGRAM_ITEM_MISSING", id.clone()));
        }
    }

    let mut blocked: HashSet<(i64, i64)> = HashSet::new();
    for prop in &map.props {
        if !prop.blocks_move || prop.mount.is_some() {
            continue;
        }
        blocked.extend(prop_cells(prop).iter().filter_map(Spot::key));
    }
    let party = map.spawn_points.iter().find(|point| point.role == "party");
    let reached = party.map(|party| tm::reachable_cells(map, party.x, party.y, true, Some(&blocked))).unwrap_or_default();
    // Якорь досягаем, если отряд встаёт на его клетку или рядом с ней.
    let near = |cells: &[Spot]| {
        cells.iter().any(|point| [(0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)].iter().any(|(dx, dy)| point.offset(*dx, *dy).key().is_some_and(|key| reached.contains(&key))))
    };
    for id in &coverage.met {
        if !required.contains(id) {
            continue;
        }
        let anchors: Vec<Vec<Spot>> = if requirement_terrain(id) == Some("platform") {
            platform_cells(map).into_iter().map(|(x, y)| vec![Spot::new(x as f64, y as f64)]).collect()
        } else {
            let assets = requirement_assets(id);
            map.props.iter().filter(|prop| assets.contains(&prop.asset_id.as_str())).map(prop_cells).collect()
        };
        if !anchors.iter().any(|cells| near(cells)) {
            report.problems.push(MapProblem::new("PROGRAM_ANCHOR_UNREACHABLE", id.clone()));
        }
    }

    // Центр сцены — место, где стоят люди: вокруг него нужен простор.
    let focus = program.get("focus").and_then(Value::as_str).unwrap_or("");
    if !focus.is_empty() && coverage.met.iter().any(|id| id == focus) && requirement_terrain(focus).is_none() {
        let assets = requirement_assets(focus);
        let mut roomiest = 0;
        for prop in &map.props {
            if !assets.contains(&prop.asset_id.as_str()) {
                continue;
            }
            roomiest = roomiest.max(focus_room(&prop_cells(prop), &reached, &blocked));
        }
        if roomiest < FOCUS_MIN_ROOM {
            report.problems.push(MapProblem::new("FOCUS_CRAMPED", format!("{focus}: {roomiest} кл.")));
        }
    }

    let mut edge_props: i64 = 0;
    for prop in &map.props {
        if prop.transition.is_some() || prop.mount.is_some() {
            continue;
        }
        let (width, height) = (map.width as f64, map.height as f64);
        if prop_cells(prop).iter().any(|point| point.x <= 0.0 || point.y <= 0.0 || point.x >= width - 1.0 || point.y >= height - 1.0) {
            edge_props += 1;
            report.warnings.push(MapProblem::new("PROP_ON_EDGE", format!("{}@{}", prop.asset_id, Spot::new(prop.x.floor(), prop.y.floor()).text())));
        }
    }

    if let Some(min) = options.min_size {
        if map.width < min.width || map.height < min.height {
            report.problems.push(MapProblem::new("SCENE_TOO_SMALL", format!("{}×{} < {}×{}", map.width, map.height, min.width, min.height)));
        }
    }

    // Глухое и потерянное считаются по суше: вода гавани — часть места.
    let zone_kind = zone_kinds(map);
    let outdoors = party.is_some_and(|party| zone_kind.get(tm::cell_at(map, party.x, party.y).map_or("", |cell| cell.zone)) != Some(&"interior"));
    let mut land: i64 = 0;
    let mut solid: i64 = 0;
    let mut lost: IndexSet<(i64, i64)> = IndexSet::new();
    for y in 0..map.height {
        for x in 0..map.width {
            let Some(cell) = tm::cell_at(map, x, y) else { continue };
            if cell.surface == "water" {
                continue;
            }
            land += 1;
            if !cell.passable || blocked.contains(&(x, y)) {
                solid += 1;
            } else if party.is_some() && !reached.contains(&(x, y)) {
                lost.insert((x, y));
            }
        }
    }
    let blocked_share = if land > 0 { solid as f64 / land as f64 } else { 0.0 };
    if options.open_scene && outdoors && blocked_share > OPEN_SCENE_BLOCKED_SHARE {
        report.problems.push(MapProblem::new("OPEN_SCENE_CLUTTERED", format!("{}%", js::round(blocked_share * 100.0) as i64)));
    }
    let mut largest_pocket = 0;
    let mut seen: HashSet<(i64, i64)> = HashSet::new();
    for start in &lost {
        if seen.contains(start) {
            continue;
        }
        let mut queue = vec![*start];
        seen.insert(*start);
        let mut index = 0;
        while index < queue.len() {
            let (x, y) = queue[index];
            index += 1;
            for (dx, dy) in SIDES {
                let next = (x + dx, y + dy);
                if !lost.contains(&next) || seen.contains(&next) {
                    continue;
                }
                // Закуток — то, что связано шагом; стена на ребре делит его на части.
                if edge_at(map, x, y, next.0, next.1).is_some_and(|edge| edge.blocks_move) {
                    continue;
                }
                seen.insert(next);
                queue.push(next);
            }
        }
        largest_pocket = largest_pocket.max(queue.len());
    }
    if largest_pocket > POCKET_LIMIT {
        report.problems.push(MapProblem::new("UNREACHABLE_POCKET", format!("{largest_pocket} кл.")));
    }

    report.stats.push("program_items", items.len() as i64);
    report.stats.push("program_required", required.len() as i64);
    report.stats.push("program_met", coverage.met.len() as i64);
    report.stats.push("platforms", platforms as i64);
    report.stats.push("edge_props", edge_props);
    report.stats.push("blocked_pct", js::round(blocked_share * 100.0) as i64);
    report.stats.push("largest_pocket", largest_pocket as i64);
    report
}

// --- эталонные сцены ------------------------------------------------------

/// `MAP_PREVIEW_PRESETS`: эталонные сцены для просмотра и тестов качества —
/// по одной на каждую тему генератора и назначение здания.
pub static MAP_PREVIEW_PRESETS: LazyLock<Value> = LazyLock::new(|| {
    json!([
        { "id": "tavern", "input": { "location": "Таверна «Рыжий рог»", "theme": "таверна" } },
        { "id": "shop", "input": { "location": "Лавка травника", "theme": "лавка" } },
        { "id": "house", "input": { "location": "Дом мельника", "theme": "жилой дом" } },
        { "id": "manor", "input": { "location": "Усадьба Вельских", "theme": "усадьба" } },
        { "id": "temple", "input": { "location": "Храм Утренней звезды", "theme": "храм" } },
        { "id": "crypt", "input": { "location": "Фамильный склеп", "theme": "склеп" } },
        { "id": "cave", "input": { "location": "Пещера контрабандистов", "theme": "пещера" } },
        { "id": "forest", "input": { "location": "Поляна в Чернолесье", "theme": "лес" } },
        { "id": "road", "input": { "location": "Тракт у старого моста", "theme": "дорога" } },
        { "id": "ruins", "input": { "location": "Развалины старой заставы", "theme": "руины у дороги" } },
        { "id": "swamp", "input": { "location": "Гнилая топь", "theme": "лес", "map": { "design": { "climate": "wetland" } } } },
        { "id": "village", "input": { "location": "Деревня Кленовка", "theme": "деревня", "settlementType": "village" } },
        { "id": "town", "input": { "location": "Город Вельдбург", "theme": "город", "settlementType": "town" } },
        { "id": "harbor", "input": { "location": "Портовый квартал", "theme": "гавань у пристани", "settlementType": "town" } }
    ])
});

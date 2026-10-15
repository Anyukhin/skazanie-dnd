//! Перенос `server/graph-layout.mjs` — стадия 2 генератора сцены: граф зон
//! превращается в клетки, рёбра и зоны (`docs/tactical-map-plan.md`, раздел 8).
//!
//! Топология уже проверена стадией 1 (`sk_geometry::scene_graph`): здесь
//! решается только геометрия, и её задача — **не потерять** проверенную
//! топологию: связь графа становится настоящим проходом между помещениями, а
//! запертая связь — запертой дверью.
//!
//! Помещения нарезаются двоичным разбиением прямоугольника
//! ([`split_area`]); зоны раскладываются по листьям в порядке волн стадии 1
//! ([`assign_zones_to_leaves`]), и связь становится проёмом в общей стене.
//! Склеп (версия 2) устроен иначе: камеры 225–625 фт², вырубленные в скале, и
//! ходы в клетку шириной между ними ([`plan_chambers`]).
//!
//! Случайность — собственный детерминированный поток генератора (LCG от
//! SHA-256 сида), перенесённый точно: тот же сид даёт ту же карту.

use std::collections::HashMap;

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexMap;
use sk_core::{hash, js, re, text, Point};
use sk_geometry::scene_graph::{progression_waves, reachable_zones, validate_scene_graph, SceneGraph, SceneLink, SceneZone};
use sk_tactical::tactical_map::{
    self as tm, CellPatch, EdgePatch, MapResult, Overlays, RoomLabel, TacticalMap, TacticalMapError, TacticalMapOptions, TacticalSpawnPoint,
};

use crate::GeneratorStamp;

/// `GRAPH_LAYOUT`.
pub const GRAPH_LAYOUT: GeneratorStamp = GeneratorStamp { id: "graph-layout", version: "2" };

/// Соль случайности разбиения залами. Версия 2 изменила только склеп; храм и
/// подземелье с тем же сидом обязаны выйти прежними, поэтому их поток
/// случайности по-прежнему от версии 1.
const SPLIT_RANDOM_SALT: &str = "graph-layout:1";

/// `randomFor(seed)`: LCG от первых четырёх байт SHA-256 сида (ноль — единица).
pub(crate) fn random_for(seed: &str) -> impl FnMut() -> f64 {
    let digest = hash::sha256(seed);
    let base = u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]]);
    let mut state = if base == 0 { 1 } else { base };
    move || {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        f64::from(state) / 4_294_967_296.0
    }
}

// --- прямоугольники -----------------------------------------------------------

/// Лист разбиения или камера (`LeafRect`), границы включительно; крайние
/// клетки — кладка.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct LeafRect {
    pub min_x: i64,
    pub min_y: i64,
    pub max_x: i64,
    pub max_y: i64,
}

impl LeafRect {
    pub const fn new(min_x: i64, min_y: i64, max_x: i64, max_y: i64) -> Self {
        Self { min_x, min_y, max_x, max_y }
    }

    /// Мера листа в сортировке разбиения: `(maxX − minX)·(maxY − minY)`.
    fn split_measure(&self) -> i64 {
        (self.max_x - self.min_x) * (self.max_y - self.min_y)
    }

    /// Площадь вместе с кладкой, в клетках.
    fn cells(&self) -> i64 {
        (self.max_x - self.min_x + 1) * (self.max_y - self.min_y + 1)
    }

    /// Форма JS: `{ minX, minY, maxX, maxY }`.
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("minX".into(), Value::from(self.min_x));
        object.insert("minY".into(), Value::from(self.min_y));
        object.insert("maxX".into(), Value::from(self.max_x));
        object.insert("maxY".into(), Value::from(self.max_y));
        Value::Object(object)
    }
}

/// Помещения карты по зонам в порядке размещения (`Map<string, LeafRect>`).
pub type Rooms = IndexMap<String, LeafRect>;

/// Помещения в форме JS: `[[zoneId, rect], …]` (`[...rooms]`).
pub fn rooms_json(rooms: &Rooms) -> Value {
    Value::Array(rooms.iter().map(|(zone, rect)| json!([zone, rect.to_json()])).collect())
}

/// Двоичное разбиение прямоугольника на `count` листьев (`splitArea`).
/// Режется всегда самый большой лист — помещения выходят соизмеримыми.
/// `minimum` — минимальная сторона помещения вместе со стенами (в JS по
/// умолчанию 5).
pub fn split_area(area: LeafRect, count: usize, random: &mut dyn FnMut() -> f64, minimum: i64) -> Vec<LeafRect> {
    let mut leaves = vec![area];
    let mut guard = 0usize;
    while leaves.len() < count && guard < count.saturating_mul(8) {
        guard += 1;
        // Устойчивая сортировка, как `Array.prototype.sort`: больший — раньше.
        leaves.sort_by(|left, right| right.split_measure().cmp(&left.split_measure()));
        let target = leaves.remove(0);
        let width = target.max_x - target.min_x + 1;
        let height = target.max_y - target.min_y + 1;
        let can_split_x = width >= minimum * 2 + 1;
        let can_split_y = height >= minimum * 2 + 1;
        if !can_split_x && !can_split_y {
            leaves.push(target);
            break;
        }
        let vertical = can_split_x && (!can_split_y || if width >= height { random() < 0.8 } else { random() < 0.2 });
        if vertical {
            let low = target.min_x + minimum;
            let high = target.max_x - minimum;
            let cut = low + (random() * (high - low + 1).max(1) as f64).floor() as i64;
            leaves.push(LeafRect { max_x: cut, ..target });
            leaves.push(LeafRect { min_x: cut, ..target });
        } else {
            let low = target.min_y + minimum;
            let high = target.max_y - minimum;
            let cut = low + (random() * (high - low + 1).max(1) as f64).floor() as i64;
            leaves.push(LeafRect { max_y: cut, ..target });
            leaves.push(LeafRect { min_y: cut, ..target });
        }
    }
    // Порядок детерминированный: сверху вниз, слева направо — тогда вход
    // оказывается у края карты.
    leaves.sort_by(|left, right| left.min_y.cmp(&right.min_y).then(left.min_x.cmp(&right.min_x)));
    leaves
}

/// Ось общей стены.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WallAxis {
    /// Вертикальная стена: правый край одного — левый край другого.
    X,
    /// Горизонтальная стена.
    Y,
}

impl WallAxis {
    pub fn as_str(self) -> &'static str {
        match self {
            WallAxis::X => "x",
            WallAxis::Y => "y",
        }
    }
}

/// Общая стена двух прямоугольников: где она и какой отрезок годится под проём.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SharedWall {
    pub axis: WallAxis,
    pub at: i64,
    pub from: i64,
    pub to: i64,
}

impl SharedWall {
    /// Форма JS: `{ axis, at, from, to }`.
    pub fn to_json(&self) -> Value {
        json!({ "axis": self.axis.as_str(), "at": self.at, "from": self.from, "to": self.to })
    }
}

/// `sharedWall(a, b)`: смежны ли два прямоугольника по стене, и где именно.
pub fn shared_wall(a: &LeafRect, b: &LeafRect) -> Option<SharedWall> {
    for (left, right) in [(a, b), (b, a)] {
        if left.max_x == right.min_x {
            let from = left.min_y.max(right.min_y) + 1;
            let to = left.max_y.min(right.max_y) - 1;
            if to >= from {
                return Some(SharedWall { axis: WallAxis::X, at: left.max_x, from, to });
            }
        }
    }
    for (top, bottom) in [(a, b), (b, a)] {
        if top.max_y == bottom.min_y {
            let from = top.min_x.max(bottom.min_x) + 1;
            let to = top.max_x.min(bottom.max_x) - 1;
            if to >= from {
                return Some(SharedWall { axis: WallAxis::Y, at: top.max_y, from, to });
            }
        }
    }
    None
}

/// Порядок зон: волны стадии 1, затем зоны вне волн в порядке графа.
fn zone_order(graph: &SceneGraph) -> Vec<String> {
    let mut order: Vec<String> = progression_waves(graph).into_iter().flat_map(|wave| wave.zones).collect();
    for zone in &graph.zones {
        if !order.contains(&zone.id) {
            order.push(zone.id.clone());
        }
    }
    order
}

/// Соседи зоны по связям графа, уже стоящие в `placed`.
fn placed_neighbours(graph: &SceneGraph, placed: &Rooms, zone_id: &str) -> Vec<LeafRect> {
    graph
        .links
        .iter()
        .filter(|link| link.from == zone_id || link.to == zone_id)
        .filter_map(|link| placed.get(if link.from == zone_id { &link.to } else { &link.from }).copied())
        .collect()
}

/// `assignZonesToLeaves(graph, leaves)`: зоны по листьям так, чтобы связанные
/// зоны оказались рядом. Сначала — раскладка с возвратом, где каждая связь
/// становится общей стеной; не нашлась — жадный выбор.
pub fn assign_zones_to_leaves(graph: &SceneGraph, leaves: &[LeafRect]) -> Rooms {
    let order = zone_order(graph);
    if let Some(exact) = exact_leaf_assignment(graph, &order, leaves) {
        return exact;
    }
    let mut placed = Rooms::new();
    let mut free: Vec<LeafRect> = leaves.to_vec();
    for zone_id in &order {
        if free.is_empty() {
            break;
        }
        // Лист, смежный с уже размещённым соседом по графу: связь станет
        // проёмом в общей стене.
        let neighbours = placed_neighbours(graph, &placed, zone_id);
        let mut index = 0;
        if !neighbours.is_empty() {
            if let Some(found) = free.iter().position(|leaf| neighbours.iter().any(|neighbour| shared_wall(leaf, neighbour).is_some())) {
                index = found;
            }
        }
        let leaf = free.remove(index);
        placed.insert(zone_id.clone(), leaf);
    }
    placed
}

/// Раскладка с возвратом (`exactLeafAssignment`): зона встаёт только в лист,
/// смежный со всеми уже размещёнными соседями. Перебор ограничен бюджетом.
fn exact_leaf_assignment(graph: &SceneGraph, order: &[String], leaves: &[LeafRect]) -> Option<Rooms> {
    if order.len() > leaves.len() {
        return None;
    }
    struct Search<'a> {
        graph: &'a SceneGraph,
        order: &'a [String],
        leaves: &'a [LeafRect],
        placed: Rooms,
        used: Vec<bool>,
        budget: i64,
    }
    impl Search<'_> {
        fn place(&mut self, position: usize) -> bool {
            if position >= self.order.len() {
                return true;
            }
            let zone_id = &self.order[position];
            let neighbours = placed_neighbours(self.graph, &self.placed, zone_id);
            for index in 0..self.leaves.len() {
                if self.used[index] {
                    continue;
                }
                self.budget -= 1;
                if self.budget <= 0 {
                    continue;
                }
                let leaf = self.leaves[index];
                if !neighbours.iter().all(|neighbour| shared_wall(&leaf, neighbour).is_some()) {
                    continue;
                }
                self.placed.insert(zone_id.clone(), leaf);
                self.used[index] = true;
                if self.place(position + 1) {
                    return true;
                }
                self.placed.shift_remove(zone_id);
                self.used[index] = false;
            }
            false
        }
    }
    let mut search = Search { graph, order, leaves, placed: Rooms::new(), used: vec![false; leaves.len()], budget: 5000 };
    search.place(0).then_some(search.placed)
}

// --- камеры склепа ------------------------------------------------------------

/// Устье хода (`ChamberMouth`): клетка стены камеры, через которую в неё
/// входит ход, и стоит ли в нём дверь связи.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChamberMouth {
    pub x: i64,
    pub y: i64,
    pub door: bool,
}

/// Ход между камерами (`ChamberPassage`): клетки от устья до устья и два устья.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChamberPassage {
    pub link: SceneLink,
    pub cells: Vec<Point>,
    pub mouths: Vec<ChamberMouth>,
}

/// Раскладка склепа (`planChambers`): камеры по зонам и ходы.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChamberPlan {
    pub rooms: Rooms,
    pub passages: Vec<ChamberPassage>,
}

/// Сторона камеры, откуда выходит ход. Открытое устье (без двери) — только
/// на северной и западной стене: тонкие стены отдают проём без двери камере
/// обходом сверху вниз и слева направо, и ход южнее или восточнее такого
/// проёма по цепочке становился бы полом камеры.
#[derive(Clone, Copy)]
struct ChamberSide {
    dx: i64,
    dy: i64,
    open: bool,
}

const CHAMBER_SIDES: [ChamberSide; 4] = [
    ChamberSide { dx: 0, dy: -1, open: true },
    ChamberSide { dx: -1, dy: 0, open: true },
    ChamberSide { dx: 0, dy: 1, open: false },
    ChamberSide { dx: 1, dy: 0, open: false },
];

/// Кандидат в устье: клетка кладки и направление наружу.
#[derive(Clone, Copy, Debug)]
struct Mouth {
    x: i64,
    y: i64,
    dx: i64,
    dy: i64,
}

/// Размеры камеры вместе с кладкой, в клетках (`chamberSizes`). Галерея
/// вытянута и шире прочих, тайник теснее.
fn chamber_sizes(zone: &SceneZone, goal_zone_id: &str) -> [(i64, i64); 2] {
    if text::test(re!(r"галере", "iu"), &zone.label) {
        return [(6, 4), (4, 6)];
    }
    if zone.id == goal_zone_id {
        return [(5, 3), (3, 5)];
    }
    [(5, 4), (4, 5)]
}

/// Сколько клеток породы оставить между камерами (`minimumGap`): камеры
/// больше двадцати клеток держатся через две, чтобы лаз петли до них не
/// дотягивался.
fn minimum_gap(a: &LeafRect, b: &LeafRect) -> i64 {
    if a.cells() > 20 || b.cells() > 20 {
        2
    } else {
        1
    }
}

/// Порода между двумя камерами по прямой.
fn gap(a: &LeafRect, b: &LeafRect) -> i64 {
    (b.min_x - a.max_x - 1).max(a.min_x - b.max_x - 1).max(b.min_y - a.max_y - 1).max(a.min_y - b.max_y - 1)
}

/// Клетка в двух шагах по прямой от камеры (или в ней самой).
fn near_rect(rect: &LeafRect, x: i64, y: i64) -> bool {
    (x >= rect.min_x && x <= rect.max_x && y >= rect.min_y - 2 && y <= rect.max_y + 2)
        || (y >= rect.min_y && y <= rect.max_y && x >= rect.min_x - 2 && x <= rect.max_x + 2)
}

/// Перемешивание Фишера — Йетса на детерминированном генераторе (`shuffle`).
fn shuffle<T: Clone>(items: &[T], random: &mut dyn FnMut() -> f64) -> Vec<T> {
    let mut result = items.to_vec();
    let mut index = result.len();
    while index > 1 {
        index -= 1;
        let swap = (random() * (index + 1) as f64).floor() as usize;
        result.swap(index, swap);
    }
    result
}

/// Ошибка, на которой JS падает `TypeError`: камеры зоны входа нет, а обход
/// от неё строится (вход графа не объявлен зоной, но на него ссылаются связи).
fn missing_room_error() -> TacticalMapError {
    TacticalMapError { name: "TypeError", code: "TYPE_ERROR".into(), message: "Cannot read properties of undefined (reading 'minX')".into() }
}

/// Одна попытка раскладки камер (`tryPlanChambers`).
struct Planner<'a> {
    graph: &'a SceneGraph,
    width: i64,
    height: i64,
    /// 1 — клетка хода, 2 — её сосед: второй ход рядом не идёт.
    taken: Vec<u8>,
    rooms: Rooms,
    passages: Vec<ChamberPassage>,
}

/// Сосед в начале обхода: корень поиска.
const ROOT: i64 = -1;
/// Клетка, которой поиск ещё не коснулся.
const UNSEEN: i64 = i64::MIN;

impl Planner<'_> {
    fn at(&self, x: i64, y: i64) -> i64 {
        y * self.width + x
    }

    fn inside(&self, x: i64, y: i64) -> bool {
        x >= 1 && y >= 1 && x <= self.width - 2 && y <= self.height - 2
    }

    fn taken_at(&self, x: i64, y: i64) -> u8 {
        usize::try_from(self.at(x, y)).ok().and_then(|index| self.taken.get(index)).copied().unwrap_or(0)
    }

    fn free(&self, x: i64, y: i64) -> bool {
        self.inside(x, y) && self.taken_at(x, y) == 0 && self.rooms.values().all(|rect| !near_rect(rect, x, y))
    }

    /// Устья камеры на разрешённых сторонах (`mouthsOf`): клетка кладки (не
    /// угол), две клетки хода прямо наружу и третья — свободная порода.
    fn mouths_of(&self, rect: &LeafRect, open_only: bool) -> Vec<Mouth> {
        let mut found = Vec::new();
        for side in CHAMBER_SIDES {
            if open_only && !side.open {
                continue;
            }
            let along = side.dx == 0;
            // На стороне в три клетки устье соседствует с обоими углами, и
            // камера теряла бы всю стену — там его нет.
            let from = if along { rect.min_x + 1 } else { rect.min_y + 1 };
            let to = if along { rect.max_x - 1 } else { rect.max_y - 1 };
            if to - from < 1 {
                continue;
            }
            for step in from..=to {
                let x = if along { step } else if side.dx < 0 { rect.min_x } else { rect.max_x };
                let y = if along {
                    if side.dy < 0 {
                        rect.min_y
                    } else {
                        rect.max_y
                    }
                } else {
                    step
                };
                let clear = [1, 2].iter().all(|distance| {
                    let (cx, cy) = (x + side.dx * distance, y + side.dy * distance);
                    self.inside(cx, cy)
                        && self.taken_at(cx, cy) == 0
                        && self.rooms.values().filter(|other| *other != rect).all(|other| !near_rect(other, cx, cy))
                });
                if clear && self.free(x + side.dx * 3, y + side.dy * 3) {
                    found.push(Mouth { x, y, dx: side.dx, dy: side.dy });
                }
            }
        }
        found
    }

    /// Ход между двумя размещёнными камерами (`route`): поиск в ширину по
    /// свободной породе от третьих клеток устьев одной камеры до третьих
    /// клеток другой. Дверь связи — в устье дальней камеры, если там устье
    /// не встаёт, — в устье ближней; открытой связи двери не нужно.
    fn route(&self, from_rect: &LeafRect, to_rect: &LeafRect, link: &SceneLink, random: &mut dyn FnMut() -> f64) -> Option<ChamberPassage> {
        // (дверь: 0 — нет, 1 — у ближней, 2 — у дальней; ближнее открытое; дальнее открытое)
        let options: &[(u8, bool, bool)] = if link.kind == "open" { &[(0, true, true)] } else { &[(2, true, false), (1, false, true)] };
        let length = usize::try_from(self.width * self.height).unwrap_or(0);
        for &(door, from_open, to_open) in options {
            let sources = shuffle(&self.mouths_of(from_rect, from_open), random);
            let targets = self.mouths_of(to_rect, to_open);
            if sources.is_empty() || targets.is_empty() {
                continue;
            }
            let mut target_at: HashMap<i64, Mouth> = HashMap::new();
            for mouth in &targets {
                target_at.insert(self.at(mouth.x + mouth.dx * 3, mouth.y + mouth.dy * 3), *mouth);
            }
            let mut parent = vec![UNSEEN; length];
            let parent_of = |parent: &Vec<i64>, index: i64| usize::try_from(index).ok().and_then(|index| parent.get(index)).copied().unwrap_or(UNSEEN);
            let mut source_at: HashMap<i64, Mouth> = HashMap::new();
            let mut queue: Vec<i64> = Vec::new();
            for mouth in &sources {
                let start = self.at(mouth.x + mouth.dx * 3, mouth.y + mouth.dy * 3);
                if parent_of(&parent, start) != UNSEEN {
                    continue;
                }
                if let Some(slot) = usize::try_from(start).ok().and_then(|index| parent.get_mut(index)) {
                    *slot = ROOT;
                }
                source_at.insert(start, *mouth);
                queue.push(start);
            }
            let directions = shuffle(&[(1i64, 0i64), (-1, 0), (0, 1), (0, -1)], random);
            let mut reached = -1;
            let mut head = 0;
            while head < queue.len() && reached < 0 {
                let current = queue[head];
                head += 1;
                if target_at.contains_key(&current) {
                    reached = current;
                    break;
                }
                let x = current % self.width;
                let y = current.div_euclid(self.width);
                for (dx, dy) in &directions {
                    let next = self.at(x + dx, y + dy);
                    if parent_of(&parent, next) != UNSEEN || !self.free(x + dx, y + dy) {
                        continue;
                    }
                    if let Some(slot) = usize::try_from(next).ok().and_then(|index| parent.get_mut(index)) {
                        *slot = current;
                    }
                    queue.push(next);
                }
            }
            if reached < 0 {
                continue;
            }
            let mut middle: Vec<i64> = Vec::new();
            let mut cursor = reached;
            while cursor >= 0 {
                middle.push(cursor);
                let up = parent_of(&parent, cursor);
                cursor = if up == UNSEEN { -1 } else { up };
            }
            middle.reverse();
            let (Some(source), Some(target)) = (source_at.get(&middle[0]).copied(), target_at.get(&reached).copied()) else {
                continue;
            };
            let mut cells: Vec<Point> = Vec::with_capacity(middle.len() + 4);
            for distance in [1, 2] {
                cells.push(Point::new(source.x + source.dx * distance, source.y + source.dy * distance));
            }
            for cell in &middle {
                cells.push(Point::new(cell % self.width, cell.div_euclid(self.width)));
            }
            for distance in [2, 1] {
                cells.push(Point::new(target.x + target.dx * distance, target.y + target.dy * distance));
            }
            return Some(ChamberPassage {
                link: link.clone(),
                cells,
                mouths: vec![ChamberMouth { x: source.x, y: source.y, door: door == 1 }, ChamberMouth { x: target.x, y: target.y, door: door == 2 }],
            });
        }
        None
    }

    /// Камера вплотную к соседней (`snug`): одна клетка породы и общий
    /// отрезок стены — её потом прорубает петля.
    fn snug(&self, rect: &LeafRect) -> bool {
        self.rooms.values().any(|other| {
            if gap(rect, other) != 1 || minimum_gap(rect, other) > 1 {
                return false;
            }
            let rows = rect.max_y.min(other.max_y) - rect.min_y.max(other.min_y) - 1;
            let columns = rect.max_x.min(other.max_x) - rect.min_x.max(other.min_x) - 1;
            rows >= 1 || columns >= 1
        })
    }

    /// Клетки хода заняты, их соседи закрыты для следующего хода (`occupy`).
    fn occupy(&mut self, passage: &ChamberPassage) {
        for cell in &passage.cells {
            self.mark(cell.x, cell.y, 1);
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let (nx, ny) = (cell.x + dx, cell.y + dy);
                if self.inside(nx, ny) && self.taken_at(nx, ny) == 0 {
                    self.mark(nx, ny, 2);
                }
            }
        }
    }

    fn mark(&mut self, x: i64, y: i64, value: u8) {
        let index = self.at(x, y);
        if let Some(slot) = usize::try_from(index).ok().and_then(|index| self.taken.get_mut(index)) {
            *slot = value;
        }
    }

    /// Лежит ли клетка хода ближе трёх клеток по прямой к будущей камере
    /// (`touchesPassage`).
    fn touches_passage(&self, rect: &LeafRect) -> bool {
        for y in (rect.min_y - 2).max(0)..=(rect.max_y + 2).min(self.height - 1) {
            for x in (rect.min_x - 2).max(0)..=(rect.max_x + 2).min(self.width - 1) {
                let straight = (x >= rect.min_x && x <= rect.max_x) || (y >= rect.min_y && y <= rect.max_y);
                if straight && self.taken_at(x, y) == 1 {
                    return true;
                }
            }
        }
        false
    }
}

/// `planChambers(graph, width, height, random)`: склеп — камеры, вырубленные
/// в скале, и ходы в клетку между ними. До восьми попыток; ни одна не
/// уложилась — `None`. Ход держится не ближе трёх клеток к чужой камере по
/// прямой, а из своей выходит прямо на две клетки.
pub fn plan_chambers(graph: &SceneGraph, width: i64, height: i64, random: &mut dyn FnMut() -> f64) -> MapResult<Option<ChamberPlan>> {
    let order = zone_order(graph);
    for _ in 0..8 {
        if let Some(plan) = try_plan_chambers(graph, &order, width, height, random)? {
            return Ok(Some(plan));
        }
    }
    Ok(None)
}

/// Одна попытка раскладки камер; `None`, если какая-то камера не встала.
fn try_plan_chambers(graph: &SceneGraph, order: &[String], width: i64, height: i64, random: &mut dyn FnMut() -> f64) -> MapResult<Option<ChamberPlan>> {
    let mut planner = Planner {
        graph,
        width,
        height,
        taken: vec![0; usize::try_from(width * height).unwrap_or(0)],
        rooms: Rooms::new(),
        passages: Vec::new(),
    };
    let farthest = 3f64.max(9f64.min(js::round(width.min(height) as f64 / 4.0)));
    for zone_id in order {
        let Some(zone) = planner.graph.zones.iter().find(|entry| entry.id == *zone_id) else {
            return Ok(None);
        };
        let links: Vec<&SceneLink> = planner
            .graph
            .links
            .iter()
            .filter(|link| (link.from == *zone_id && planner.rooms.contains_key(&link.to)) || (link.to == *zone_id && planner.rooms.contains_key(&link.from)))
            .collect();
        let anchor = links.first().and_then(|link| planner.rooms.get(if link.from == *zone_id { &link.to } else { &link.from }).copied());
        let target = 1.0 + (random() * farthest).floor();
        // Половина камер ложится вплотную к уже стоящей: склеп получает петли.
        let prefer_snug = random() < 0.5;
        let mut candidates: Vec<(LeafRect, f64)> = Vec::new();
        for (w, h) in chamber_sizes(zone, &planner.graph.goal_zone_id) {
            let mut y = 1;
            while y + h - 1 <= height - 2 {
                let mut x = 1;
                while x + w - 1 <= width - 2 {
                    let rect = LeafRect::new(x, y, x + w - 1, y + h - 1);
                    x += 1;
                    if planner.rooms.values().any(|other| gap(&rect, other) < minimum_gap(&rect, other)) {
                        continue;
                    }
                    if anchor.is_some_and(|anchor| gap(&rect, &anchor) as f64 > farthest) {
                        continue;
                    }
                    if planner.touches_passage(&rect) {
                        continue;
                    }
                    let closeness = anchor.map_or(0.0, |anchor| (gap(&rect, &anchor) as f64 - target).abs());
                    let jitter = random() * 2.0;
                    let pull = if prefer_snug && planner.snug(&rect) { 6.0 } else { 0.0 };
                    candidates.push((rect, closeness + jitter - pull));
                }
                y += 1;
            }
        }
        candidates.sort_by(|left, right| left.1.partial_cmp(&right.1).unwrap_or(std::cmp::Ordering::Equal));
        let mut placed = false;
        for (rect, _) in candidates.iter().take(80) {
            let saved = planner.taken.clone();
            planner.rooms.insert(zone_id.clone(), *rect);
            let mut routed: Vec<ChamberPassage> = Vec::new();
            for link in &links {
                let outgoing = link.from == *zone_id;
                let Some(other) = planner.rooms.get(if outgoing { &link.to } else { &link.from }).copied() else { break };
                let passage = if outgoing { planner.route(rect, &other, link, random) } else { planner.route(&other, rect, link, random) };
                let Some(passage) = passage else { break };
                planner.occupy(&passage);
                routed.push(passage);
            }
            if routed.len() == links.len() {
                planner.passages.extend(routed);
                placed = true;
                break;
            }
            planner.rooms.shift_remove(zone_id);
            planner.taken = saved;
        }
        if !placed {
            return Ok(None);
        }
    }

    // Обходной ход от входа к дальней камере, не связанной со входом
    // напрямую: в склепе появляется петля. За запертую связь обход ведёт той
    // же запертой дверью на тот же ключ. Не проложился — склеп без обхода.
    for bypass in bypass_links(planner.graph) {
        let from = planner.rooms.get(&bypass.from).copied().ok_or_else(missing_room_error)?;
        let to = planner.rooms.get(&bypass.to).copied().ok_or_else(missing_room_error)?;
        let Some(passage) = planner.route(&from, &to, &bypass, random) else { continue };
        planner.occupy(&passage);
        planner.passages.push(passage);
        break;
    }
    Ok(Some(ChamberPlan { rooms: planner.rooms, passages: planner.passages }))
}

/// Возможные связи обходного хода (`bypassLinks`) — от входа к зоне, со
/// входом не связанной, лучшие первыми: больше дверей до зоны, без замка,
/// по id. Зона за единственной запертой связью получает запертую дверь на
/// ключ этой связи.
fn bypass_links(graph: &SceneGraph) -> Vec<SceneLink> {
    let entrance = graph.entrance_zone_id.as_str();
    // Сколько дверей от входа до зоны (открытая связь — ноль) и нужен ли замок.
    let mut reach: IndexMap<String, (i64, bool)> = IndexMap::new();
    reach.insert(entrance.to_string(), (0, false));
    let mut grown = true;
    while grown {
        grown = false;
        for link in &graph.links {
            for (a, b) in [(&link.from, &link.to), (&link.to, &link.from)] {
                let Some(&(doors, locked)) = reach.get(a) else { continue };
                let next = (doors + if link.kind == "open" { 0 } else { 1 }, locked || link.kind == "locked");
                // Лучше путь без замка, при равенстве — с меньшим числом дверей.
                if let Some(&(known_doors, known_locked)) = reach.get(b) {
                    if (!known_locked && next.1) || (known_locked == next.1 && known_doors <= next.0) {
                        continue;
                    }
                }
                reach.insert(b.clone(), next);
                grown = true;
            }
        }
    }
    let mut found: Vec<(SceneLink, i64)> = Vec::new();
    for zone in &graph.zones {
        let Some(&(doors, locked)) = reach.get(&zone.id) else { continue };
        if zone.id == entrance || doors < 1 {
            continue;
        }
        if graph.links.iter().any(|link| (link.from == entrance && link.to == zone.id) || (link.to == entrance && link.from == zone.id)) {
            continue;
        }
        let base = |kind: &str, key_id: Option<String>| SceneLink {
            id: format!("bypass-{}", zone.id),
            from: entrance.to_string(),
            to: zone.id.clone(),
            kind: kind.to_string(),
            key_id,
            bidirectional: true,
        };
        if !locked {
            found.push((base("door", None), doors));
            continue;
        }
        // Цель за единственной запертой связью: обход — та же дверь на тот же ключ.
        let touching: Vec<&SceneLink> = graph.links.iter().filter(|link| link.from == zone.id || link.to == zone.id).collect();
        let lock = (touching.len() == 1 && touching[0].kind == "locked" && touching[0].to == zone.id).then(|| touching[0]);
        if let Some(key) = lock.and_then(|lock| lock.key_id.as_ref()).filter(|key| !key.is_empty()) {
            found.push((base("locked", Some(key.clone())), doors));
        }
    }
    found.sort_by(|(left, left_doors), (right, right_doors)| {
        right_doors
            .cmp(left_doors)
            .then_with(|| (left.kind == "locked").cmp(&(right.kind == "locked")))
            .then_with(|| text::locale_compare(&left.id, &right.id))
    });
    found.into_iter().map(|(link, _)| link).collect()
}

// --- сборка карты -------------------------------------------------------------

/// Параметры `layoutSceneGraph`; значения по умолчанию — как в JS.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GraphLayoutOptions<'a> {
    pub seed: &'a str,
    pub width: f64,
    pub height: f64,
    pub location_id: &'a str,
    pub theme: &'a str,
    /// Материал пола помещений.
    pub material: &'a str,
}

impl Default for GraphLayoutOptions<'_> {
    fn default() -> Self {
        Self { seed: "graph", width: 26.0, height: 26.0, location_id: "", theme: "dungeon", material: "stone" }
    }
}

/// Итог `layoutSceneGraph`.
#[derive(Clone, Debug, PartialEq)]
pub struct GraphLayoutResult {
    pub map: TacticalMap,
    pub rooms: Rooms,
    pub warnings: Vec<String>,
}

/// Сторона карты по заказу: `Math.max(12, Math.min(предел, Math.round(n)))`.
fn safe_side(value: f64, limit: i64) -> i64 {
    // NaN в JS дал бы NaN-сторону; здесь — нижний предел (см. отчёт переноса).
    let rounded = js::round(value);
    if rounded.is_nan() {
        return 12;
    }
    rounded.min(limit as f64).max(12.0) as i64
}

fn floor_variant(seed: &str, x: i64, y: i64) -> i64 {
    i64::from(tm::floor_variant_at(seed, x, y, tm::FLOOR_VARIANTS))
}

/// `layoutSceneGraph(graph, options)`: собирает карту по графу зон. Всё, что
/// не помещение, — сплошная порода; связи графа — проёмы и двери.
pub fn layout_scene_graph(graph: &SceneGraph, options: &GraphLayoutOptions<'_>) -> MapResult<GraphLayoutResult> {
    let area = tm::size_class("area").unwrap_or(tm::SIZE_CLASSES[1].1);
    let arena = tm::size_class("arena").unwrap_or(tm::SIZE_CLASSES[0].1);
    let safe_width = safe_side(options.width, area.max_width);
    let safe_height = safe_side(options.height, area.max_height);
    let seed = options.seed;
    let material = options.material;
    let mut random = random_for(&format!("{SPLIT_RANDOM_SALT}:{seed}"));
    let mut warnings: Vec<String> = Vec::new();

    let mut map = tm::create_tactical_map(&TacticalMapOptions {
        width: safe_width,
        height: safe_height,
        location_id: options.location_id,
        seed,
        generator: Some((GRAPH_LAYOUT.id, GRAPH_LAYOUT.version)),
        theme: options.theme,
        size_class: if safe_width * safe_height <= arena.max_cells { "arena" } else { "area" },
        ..TacticalMapOptions::default()
    })?;
    for (zone_index, zone) in graph.zones.iter().enumerate() {
        let exterior = zone.kind == "exterior";
        tm::add_zone(
            &mut map,
            &json!({
                "id": zone.id,
                "kind": if exterior { "exterior" } else { "interior" },
                "material": if exterior { "grass" } else { material },
                "lightLevel": if exterior { "bright" } else { "dim" },
                "floorDirection": if zone_index % 2 == 0 { "horizontal" } else { "vertical" },
                "label": if zone.label.is_empty() { &zone.id } else { &zone.label },
            }),
        )?;
    }
    tm::add_zone(&mut map, &json!({ "id": "rock", "kind": "interior", "material": material, "lightLevel": "dark", "floorDirection": "horizontal", "label": "" }))?;

    // Всё, что не помещение, — сплошная порода: проходимость появляется
    // только внутри комнат.
    for y in 0..safe_height {
        for x in 0..safe_width {
            tm::set_cell(
                &mut map,
                x,
                y,
                &CellPatch {
                    passable: Some(false),
                    material: Some(material),
                    zone: Some("rock"),
                    variant: Some(floor_variant(seed, x, y)),
                    revealed: Some(false),
                    ..CellPatch::default()
                },
            )?;
        }
    }

    // Склеп — камеры в скале и ходы между ними. Не уместились — прежнее
    // разбиение: лучше просторный склеп, чем склеп без помещения.
    let planned = if options.theme == "crypt" {
        let mut crypt_random = random_for(&format!("{}:{}:{seed}", GRAPH_LAYOUT.id, GRAPH_LAYOUT.version));
        plan_chambers(graph, safe_width, safe_height, &mut crypt_random)?
    } else {
        None
    };
    let rooms = match &planned {
        Some(plan) => plan.rooms.clone(),
        None => {
            let leaves = split_area(LeafRect::new(0, 0, safe_width - 1, safe_height - 1), graph.zones.len(), &mut random, 5);
            if leaves.len() < graph.zones.len() {
                warnings.push(format!("карта вмещает {} помещений, а зон {}", leaves.len(), graph.zones.len()));
            }
            assign_zones_to_leaves(graph, &leaves)
        }
    };
    let passages: &[ChamberPassage] = planned.as_ref().map_or(&[], |plan| plan.passages.as_slice());

    for (zone_id, rect) in &rooms {
        let exterior = graph.zones.iter().find(|entry| entry.id == *zone_id).is_some_and(|zone| zone.kind == "exterior");
        for y in rect.min_y + 1..rect.max_y {
            for x in rect.min_x + 1..rect.max_x {
                tm::set_cell(
                    &mut map,
                    x,
                    y,
                    &CellPatch {
                        passable: Some(true),
                        material: Some(if exterior { "grass" } else { material }),
                        zone: Some(zone_id),
                        variant: Some(floor_variant(seed, x, y)),
                        ..CellPatch::default()
                    },
                )?;
            }
        }
    }
    // Ходы склепа — клетки без зоны: обстановка их не занимает.
    for passage in passages {
        for cell in &passage.cells {
            tm::set_cell(
                &mut map,
                cell.x,
                cell.y,
                &CellPatch { passable: Some(true), material: Some(material), zone: Some(""), variant: Some(floor_variant(seed, cell.x, cell.y)), ..CellPatch::default() },
            )?;
        }
    }

    // Стены на рёбрах: граница между проходимой клеткой и породой.
    let wall = EdgePatch { kind: Some("wall"), blocks_move: Some(true), blocks_sight: Some(true), cover: Some("three_quarters"), door_id: None };
    for y in 0..safe_height {
        for x in 0..safe_width {
            match tm::cell_at(&map, x, y) {
                Some(own) if !own.passable => {}
                _ => continue,
            }
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                if tm::cell_passable(&map, x + dx, y + dy) {
                    tm::set_edge(&mut map, x, y, x + dx, y + dy, &wall)?;
                }
            }
        }
    }

    // Связи графа становятся проёмами: у хода два устья, дверь связи — на
    // одном из них, второе — открытый проём.
    for passage in passages {
        for mouth in &passage.mouths {
            let kind = if mouth.door { passage.link.kind.as_str() } else { "open" };
            carve_doorway(&mut map, mouth.x, mouth.y, &passage.link, kind, material)?;
        }
    }
    // Связь без хода — проём в общей стене смежных помещений.
    let routed: Vec<&str> = passages.iter().map(|passage| passage.link.id.as_str()).collect();
    for link in graph.links.iter().filter(|entry| !routed.contains(&entry.id.as_str())) {
        let (Some(a), Some(b)) = (rooms.get(&link.from), rooms.get(&link.to)) else {
            warnings.push(format!("связь {}: одна из зон не размещена", link.id));
            continue;
        };
        let Some(wall) = shared_wall(a, b) else {
            warnings.push(format!("связь {}: помещения не смежны, проход не построен", link.id));
            continue;
        };
        let middle = (wall.from + wall.to).div_euclid(2);
        let (x, y) = if wall.axis == WallAxis::X { (wall.at, middle) } else { (middle, wall.at) };
        carve_doorway(&mut map, x, y, link, &link.kind, material)?;
    }

    match rooms.get(&graph.entrance_zone_id) {
        Some(spawn) => {
            let point = ((spawn.min_x + spawn.max_x).div_euclid(2), (spawn.min_y + spawn.max_y).div_euclid(2));
            map.spawn_points.push(TacticalSpawnPoint { id: "party-entrance".into(), x: point.0, y: point.1, role: "party".into() });
            // Отряд видит помещение, в которое вошёл.
            for y in spawn.min_y..=spawn.max_y {
                for x in spawn.min_x..=spawn.max_x {
                    if tm::cell_exists(&map, x, y) {
                        tm::set_cell(&mut map, x, y, &CellPatch { revealed: Some(true), ..CellPatch::default() })?;
                    }
                }
            }
        }
        None => warnings.push("зона входа не размещена, точки появления нет".into()),
    }

    map.overlays = Overlays {
        compass: true,
        scale_bar: true,
        room_labels: graph.zones.iter().filter(|zone| !zone.label.is_empty()).map(|zone| RoomLabel { zone_id: zone.id.clone(), label: zone.label.clone() }).collect(),
    };
    Ok(GraphLayoutResult { map, rooms, warnings })
}

/// `carveDoorway(map, x, y, link, material)`: прорубает проём в стене и ставит
/// на него дверь по виду связи (`kind` — вид, с которым связь пришла: устье
/// хода без двери приходит как `open`). Открытая связь остаётся проходом.
fn carve_doorway(map: &mut TacticalMap, x: i64, y: i64, link: &SceneLink, kind: &str, material: &str) -> MapResult<()> {
    if !tm::cell_exists(map, x, y) {
        return Ok(());
    }
    tm::set_cell(map, x, y, &CellPatch { passable: Some(true), material: Some(material), zone: Some(""), ..CellPatch::default() })?;
    // Рёбра-стены вокруг проёма были построены, пока он был породой: проём
    // обязан их снять.
    for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
        if !tm::cell_passable(map, x + dx, y + dy) {
            continue;
        }
        tm::set_edge(map, x, y, x + dx, y + dy, &EdgePatch { kind: Some("none"), ..EdgePatch::default() })?;
    }
    if kind == "open" {
        return Ok(());
    }
    // Ребро поперёк прохода.
    let Some((edge_x, edge_y, dir)) = tm::doorway_edge_at(map, x, y) else {
        return Ok(());
    };
    let locked = kind == "locked";
    tm::set_door(
        map,
        &json!({
            "id": format!("door-{}", link.id),
            "x": edge_x,
            "y": edge_y,
            "dir": dir.as_str(),
            // Состояние двери — начальное; дальше оно живёт в состоянии сцены.
            "state": if locked { "locked" } else { "closed" },
            "lockDc": if locked { 15 } else { 0 },
            "keyItemId": link.key_id,
            // Признаки стены — про сам проём: он открыт. Перекрывает проход
            // полотно двери (`doorBlocksStep`).
            "blocksMove": false,
            "blocksSight": false,
        }),
    )?;
    Ok(())
}

/// Замечание сборки сцены по графу: стадии 1, структурной проверки карты или
/// потери топологии.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LayoutIssue {
    pub code: String,
    pub message: String,
    pub at: Option<String>,
}

impl LayoutIssue {
    /// Форма JS: `{ code, message, at? }`.
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("code".into(), Value::String(self.code.clone()));
        object.insert("message".into(), Value::String(self.message.clone()));
        if let Some(at) = &self.at {
            object.insert("at".into(), Value::String(at.clone()));
        }
        Value::Object(object)
    }
}

/// Итог `buildSceneFromGraph`.
#[derive(Clone, Debug, PartialEq)]
pub struct SceneFromGraph {
    pub map: TacticalMap,
    pub warnings: Vec<String>,
    pub errors: Vec<LayoutIssue>,
}

/// `buildSceneFromGraph(graph, options)`: собирает карту и проверяет, что
/// геометрия не потеряла топологию — каждая зона, достижимая на графе,
/// достижима и по клеткам. Негодный граф — карта всё равно собирается, а
/// замечания стадии 1 возвращаются вместо проверки.
pub fn build_scene_from_graph(graph: &SceneGraph, options: &GraphLayoutOptions<'_>) -> MapResult<SceneFromGraph> {
    let graph_report = validate_scene_graph(graph);
    if !graph_report.ok {
        let built = layout_scene_graph(graph, options)?;
        let errors = graph_report.errors.into_iter().map(|issue| LayoutIssue { code: issue.code, message: issue.message, at: issue.at }).collect();
        return Ok(SceneFromGraph { map: built.map, warnings: Vec::new(), errors });
    }
    let built = layout_scene_graph(graph, options)?;
    let mut errors: Vec<LayoutIssue> =
        tm::validate_tactical_map(&built.map).errors.into_iter().map(|issue| LayoutIssue { code: issue.code, message: issue.message, at: issue.at }).collect();

    match built.map.spawn_points.iter().find(|point| point.role == "party") {
        None => errors.push(LayoutIssue { code: "SPAWN_POINT_MISSING".into(), message: "Точка появления отряда не построена".into(), at: None }),
        Some(spawn) => {
            // Двери, запертые по построению, при обходе не открываются —
            // поэтому достижимость по клеткам сравнивается с достижимостью по
            // графу, где ключи уже учтены.
            let reached_cells = tm::reachable_cells(&built.map, spawn.x, spawn.y, true, None);
            for zone_id in &reachable_zones(graph, None).zones {
                let Some(rect) = built.rooms.get(zone_id) else { continue };
                let found = (rect.min_y + 1..rect.max_y).any(|y| (rect.min_x + 1..rect.max_x).any(|x| reached_cells.contains(&(x, y))));
                if !found {
                    errors.push(LayoutIssue {
                        code: "GEOMETRY_LOST_TOPOLOGY".into(),
                        message: format!("Зона {zone_id} достижима на графе, но не по клеткам"),
                        at: Some(zone_id.clone()),
                    });
                }
            }
        }
    }
    Ok(SceneFromGraph { map: built.map, warnings: built.warnings, errors })
}

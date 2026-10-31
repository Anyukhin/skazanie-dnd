//! Перенос `server/combat-lab-maps.mjs`: независимый от кампании набор арен
//! боевого стенда — двор, разрушенный зал, болотная переправа, зал колонн,
//! лесная поляна, пещерный мост и терраса дозорной башни.
//!
//! Каждая арена собирается тем же API тактической карты, что и в JS, затем
//! проверяется (`validate_tactical_map`, досягаемость точек появления) и
//! отдаётся записью каталога в форме JS: клетки для интерфейса, сериализованная
//! карта, точки появления, рекомендуемые противники, число препятствий и
//! рельеф. Каталог неизменяем: наружу уходят копии.

use std::collections::HashSet;
use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_tactical::tactical_map::{
    self as tm, CellPatch, EdgeKind, EdgePatch, MapResult, TacticalMap, TacticalMapOptions,
};

/// Версия набора арен боевого стенда.
pub const COMBAT_LAB_MAPS_VERSION: &str = "skazanie:combat-lab-maps-v1";

type Points = &'static [(i64, i64)];

/// Описание арены (`createMap({ ... })`).
struct ArenaSpec {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    width: i64,
    height: i64,
    material: &'static str,
    theme: &'static str,
    build: fn(&mut TacticalMap, i64, i64) -> MapResult<()>,
    party: Points,
    enemies: Points,
    neutral: Points,
    recommended: &'static [&'static str],
}

/// Клетки для интерфейса: `{ x, y, type, passable, difficult? }`.
fn map_cells(map: &TacticalMap) -> Vec<Value> {
    tm::legacy_cells_from_tactical_map(map)
        .into_iter()
        .map(|raw| {
            let x = raw["x"].as_i64().unwrap_or(0);
            let y = raw["y"].as_i64().unwrap_or(0);
            let cell = tm::cell_at(map, x, y);
            let mut object = Map::new();
            object.insert("x".into(), Value::from(x));
            object.insert("y".into(), Value::from(y));
            object.insert("type".into(), raw["type"].clone());
            object.insert("passable".into(), Value::Bool(cell.is_some_and(|cell| cell.passable)));
            if cell.is_some_and(|cell| cell.move_cost > 1) {
                object.insert("difficult".into(), Value::Bool(true));
            }
            Value::Object(object)
        })
        .collect()
}

/// `uniquePoints(points)`: без повторов, порядок первого вхождения.
fn unique_points(points: Points) -> Vec<(i64, i64)> {
    let mut seen = HashSet::new();
    points.iter().copied().filter(|point| seen.insert(*point)).collect()
}

/// `obstacle(map, x, y, surface)`: непроходимая клетка.
fn obstacle(map: &mut TacticalMap, x: i64, y: i64, surface: &str) -> MapResult<()> {
    tm::set_cell(map, x, y, &CellPatch { passable: Some(false), revealed: Some(true), surface: Some(surface), ..CellPatch::default() })
}

/// `difficult(map, points, surface)`: труднопроходимые клетки.
fn difficult(map: &mut TacticalMap, points: &[(i64, i64)], surface: Option<&str>) -> MapResult<()> {
    for (x, y) in points {
        tm::set_cell(map, *x, *y, &CellPatch { move_cost: Some(2.0), surface, ..CellPatch::default() })?;
    }
    Ok(())
}

/// `difficultRect(width, height, x0, y0, x1, y1)`: клетки прямоугольника в границах карты.
fn difficult_rect(width: i64, height: i64, x0: i64, y0: i64, x1: i64, y1: i64) -> Vec<(i64, i64)> {
    let mut points = Vec::new();
    for y in y0.max(0)..=y1.min(height - 1) {
        for x in x0.max(0)..=x1.min(width - 1) {
            points.push((x, y));
        }
    }
    points
}

/// Непроходимые клетки видны линиям обзора как стены: рёбра строятся одним
/// проходом после всех правок планировки (`wallEdgesAroundObstacles`).
fn wall_edges_around_obstacles(map: &mut TacticalMap) -> MapResult<()> {
    let solid: Vec<(i64, i64)> = tm::cells(map).filter(|cell| !cell.passable).map(|cell| (cell.x, cell.y)).collect();
    let wall = EdgePatch { kind: Some("wall"), blocks_move: Some(true), blocks_sight: Some(true), cover: Some("three_quarters"), door_id: None };
    for (x, y) in solid {
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            if !tm::cell_passable(map, x + dx, y + dy) {
                continue;
            }
            tm::set_edge(map, x, y, x + dx, y + dy, &wall)?;
        }
    }
    Ok(())
}

/// `addSpawns(map, role, points)`: точки `role-1`, `role-2`, …
fn add_spawns(map: &mut TacticalMap, role: &str, points: Points) -> MapResult<()> {
    for (index, (x, y)) in unique_points(points).into_iter().enumerate() {
        tm::add_spawn_point(map, &json!({ "id": format!("{role}-{}", index + 1), "x": x, "y": y, "role": role }))?;
    }
    Ok(())
}

/// `createMap(spec)`: собрать, проверить и описать арену.
fn create_map(spec: &ArenaSpec) -> Result<Value, String> {
    let location = format!("combat-lab:{}", spec.id);
    let fill = CellPatch { passable: Some(true), revealed: Some(true), material: Some(spec.material), ..CellPatch::default() };
    let options = TacticalMapOptions {
        width: spec.width,
        height: spec.height,
        location_id: &location,
        seed: &location,
        generator: Some(("combat-lab-library", COMBAT_LAB_MAPS_VERSION)),
        theme: spec.theme,
        tileset_id: "skazanie-combat-lab",
        fill: Some(fill),
        ..TacticalMapOptions::default()
    };
    let build = |map: &mut TacticalMap| -> MapResult<()> {
        (spec.build)(map, spec.width, spec.height)?;
        wall_edges_around_obstacles(map)?;
        add_spawns(map, "party", spec.party)?;
        add_spawns(map, "enemy", spec.enemies)?;
        add_spawns(map, "neutral", spec.neutral)
    };
    let mut map = tm::create_tactical_map(&options).map_err(|error| error.message)?;
    build(&mut map).map_err(|error| error.message)?;

    let validation = tm::validate_tactical_map(&map);
    if !validation.ok {
        return Err(format!("Некорректная карта {}: {}", spec.id, js::stringify(&validation.to_json()["errors"])));
    }
    let reachable = unique_points(spec.party).first().map(|(x, y)| tm::reachable_cells(&map, *x, *y, true, None)).unwrap_or_default();
    for (x, y) in unique_points(spec.party).into_iter().chain(unique_points(spec.enemies)).chain(unique_points(spec.neutral)) {
        if !reachable.contains(&(x, y)) {
            return Err(format!("Точка {} {x},{y} недостижима от отряда", spec.id));
        }
    }

    let serialized = tm::serialize_tactical_map(&map).map_err(|error| error.message)?;
    let cells = map_cells(&map);
    let obstacles = cells.iter().filter(|cell| matches!(cell["type"].as_str(), Some("wall" | "water"))).count();
    let difficult_cells = cells.iter().filter(|cell| cell.get("difficult").is_some()).count();
    let wall_edges = map.edges().filter(|edge| edge.kind == EdgeKind::Wall).count();
    let mut object = Map::new();
    object.insert("id".into(), Value::String(spec.id.into()));
    object.insert("name".into(), Value::String(spec.name.into()));
    object.insert("description".into(), Value::String(spec.description.into()));
    object.insert("width".into(), Value::from(spec.width));
    object.insert("height".into(), Value::from(spec.height));
    object.insert("theme".into(), Value::String(map.theme.clone()));
    object.insert("cells".into(), Value::Array(cells));
    object.insert("map".into(), serialized);
    object.insert("spawnPoints".into(), Value::Array(map.spawn_points.iter().map(|point| point.to_json()).collect()));
    object.insert("recommended_enemy_types".into(), js::strings_value(spec.recommended.iter().copied()));
    object.insert("obstacle_count".into(), Value::from(obstacles));
    object.insert("terrain_features".into(), json!({ "difficult_cells": difficult_cells, "wall_edges": wall_edges }));
    Ok(Value::Object(object))
}

const OPEN_PARTY: Points = &[(0, 0), (0, 1), (0, 2), (1, 0), (1, 1), (1, 2)];
const OPEN_ENEMIES: Points = &[(8, 0), (9, 0), (8, 1), (9, 1), (8, 2), (9, 2), (8, 3), (9, 3), (8, 4), (9, 4), (8, 5), (9, 5)];
const HALL_PARTY: Points = &[(0, 0), (1, 0), (0, 1), (1, 1), (0, 2), (1, 2)];
const HALL_ENEMIES: Points = &[(10, 0), (11, 0), (10, 1), (11, 1), (10, 2), (11, 2), (10, 4), (11, 4), (10, 5), (11, 5), (10, 6), (11, 6)];
const MARSH_PARTY: Points = &[(0, 0), (0, 1), (0, 2), (1, 0), (1, 1), (1, 2)];
const MARSH_ENEMIES: Points = &[(9, 0), (10, 0), (9, 1), (10, 1), (9, 2), (10, 2), (9, 5), (10, 5), (9, 6), (10, 6), (9, 7), (10, 7)];
const PILLAR_PARTY: Points = &[(0, 0), (0, 1), (0, 2), (1, 0), (1, 1), (1, 2)];
const PILLAR_ENEMIES: Points = &[(12, 0), (13, 0), (12, 1), (13, 1), (12, 2), (13, 2), (12, 6), (13, 6), (12, 7), (13, 7), (10, 7), (11, 7)];
const FOREST_PARTY: Points = &[(0, 3), (0, 4), (0, 5), (1, 3), (1, 4), (1, 5)];
const FOREST_ENEMIES: Points = &[(14, 3), (15, 3), (14, 4), (15, 4), (14, 5), (15, 5), (14, 6), (15, 6), (13, 2), (14, 2), (13, 7), (14, 7)];
const BRIDGE_PARTY: Points = &[(0, 2), (0, 3), (0, 4), (1, 2), (1, 3), (1, 4)];
const BRIDGE_ENEMIES: Points = &[(13, 2), (14, 2), (13, 3), (14, 3), (13, 4), (14, 4), (13, 5), (14, 5), (12, 1), (13, 1), (12, 6), (13, 6)];
const TOWER_PARTY: Points = &[(1, 7), (2, 7), (1, 8), (2, 8), (3, 7), (3, 8)];
const TOWER_ENEMIES: Points = &[(8, 1), (9, 1), (10, 1), (8, 2), (9, 2), (10, 2), (8, 3), (9, 3), (10, 3), (7, 1), (7, 2), (7, 3)];

fn build_open_courtyard(map: &mut TacticalMap, _width: i64, _height: i64) -> MapResult<()> {
    difficult(map, &difficult_rect(10, 6, 3, 2, 6, 2), Some("rubble"))?;
    for (x, y) in [(4, 1), (5, 1), (4, 4), (5, 4)] {
        obstacle(map, x, y, "none")?;
    }
    Ok(())
}

fn build_ruined_hall(map: &mut TacticalMap, width: i64, height: i64) -> MapResult<()> {
    for y in 0..height {
        if y != height.div_euclid(2) {
            obstacle(map, 5, y, "none")?;
        }
    }
    difficult(map, &difficult_rect(width, height, 2, 4, 9, 4), Some("rubble"))
}

fn build_marsh_crossing(map: &mut TacticalMap, width: i64, height: i64) -> MapResult<()> {
    difficult(map, &difficult_rect(width, height, 2, 2, width - 3, height - 3), Some("mud"))?;
    for (x, y) in [(2, 2), (3, 2), (2, 3), (7, 4), (8, 4), (8, 5)] {
        obstacle(map, x, y, "water")?;
    }
    for y in 0..height {
        tm::set_cell(map, width.div_euclid(2), y, &CellPatch { move_cost: Some(1.0), surface: Some("none"), material: Some("wood"), ..CellPatch::default() })?;
    }
    Ok(())
}

fn build_pillar_chamber(map: &mut TacticalMap, _width: i64, _height: i64) -> MapResult<()> {
    for (x, y) in [(3, 2), (3, 5), (6, 2), (6, 5), (9, 2), (9, 5), (11, 3), (11, 4)] {
        obstacle(map, x, y, "none")?;
    }
    difficult(map, &difficult_rect(14, 8, 1, 3, 12, 3), Some("rubble"))
}

fn build_forest_clearing(map: &mut TacticalMap, _width: i64, _height: i64) -> MapResult<()> {
    difficult(map, &difficult_rect(16, 10, 2, 4, 13, 6), Some("mud"))?;
    for (x, y) in [(4, 2), (5, 2), (4, 3), (10, 7), (11, 7), (10, 8), (7, 4), (7, 5), (12, 2), (12, 3)] {
        obstacle(map, x, y, "none")?;
    }
    Ok(())
}

fn build_cavern_bridge(map: &mut TacticalMap, _width: i64, _height: i64) -> MapResult<()> {
    for x in 2..=12 {
        for y in 3..=5 {
            obstacle(map, x, y, "water")?;
        }
    }
    for y in 3..=5 {
        tm::set_cell(map, 7, y, &CellPatch { passable: Some(true), material: Some("stone"), surface: Some("none"), move_cost: Some(1.0), ..CellPatch::default() })?;
    }
    // Уступы по краям моста потом перекрывает проход стен вокруг воды (см. отчёт переноса).
    let ledge = EdgePatch { kind: Some("ledge"), blocks_move: Some(false), blocks_sight: Some(false), cover: Some("half"), door_id: None };
    for y in 3..=5 {
        tm::set_edge(map, 6, y, 7, y, &ledge)?;
        tm::set_edge(map, 7, y, 8, y, &ledge)?;
    }
    Ok(())
}

fn build_watchtower_terrace(map: &mut TacticalMap, _width: i64, _height: i64) -> MapResult<()> {
    // Терраса на 10 футов выше двора: высоты в картах — в футах.
    for (x, y) in difficult_rect(12, 10, 4, 1, 10, 3) {
        tm::set_cell(map, x, y, &CellPatch { elevation: Some(10), move_cost: Some(1.0), ..CellPatch::default() })?;
    }
    for (x, y) in [(4, 0), (5, 0), (6, 0), (7, 0), (8, 0), (9, 0), (10, 0), (4, 4), (10, 4)] {
        obstacle(map, x, y, "none")?;
    }
    difficult(map, &difficult_rect(12, 10, 4, 5, 10, 5), Some("rubble"))?;
    // Лестничный пролёт остаётся проходимым между террасой и нижним двором.
    for x in [5, 6, 7] {
        tm::set_cell(map, x, 4, &CellPatch { passable: Some(true), move_cost: Some(1.0), material: Some("stone"), elevation: Some(5), ..CellPatch::default() })?;
    }
    Ok(())
}

static SPECS: [ArenaSpec; 7] = [
    ArenaSpec {
        id: "open-courtyard",
        name: "Открытый двор",
        description: "Каменный двор с полосой осыпавшейся плитки: местность замедляет шаг, но не перекрывает обзор.",
        width: 10,
        height: 6,
        material: "stone",
        theme: "courtyard",
        build: build_open_courtyard,
        party: OPEN_PARTY,
        enemies: OPEN_ENEMIES,
        neutral: &[],
        recommended: &["humanoid", "beast"],
    },
    ArenaSpec {
        id: "ruined-hall",
        name: "Разрушенный зал",
        description: "Обвалившаяся перегородка оставляет один проход в центре; полоса щебня на дальней стороне требует двойного движения.",
        width: 12,
        height: 7,
        material: "stone",
        theme: "ruins",
        build: build_ruined_hall,
        party: HALL_PARTY,
        enemies: HALL_ENEMIES,
        neutral: &[],
        recommended: &["humanoid", "undead"],
    },
    ArenaSpec {
        id: "marsh-crossing",
        name: "Болотная переправа",
        description: "Топкая низина с двумя затопленными карманами и сухой центральной тропой, ведущей к противнику.",
        width: 11,
        height: 8,
        material: "earth",
        theme: "marsh",
        build: build_marsh_crossing,
        party: MARSH_PARTY,
        enemies: MARSH_ENEMIES,
        neutral: &[],
        recommended: &["beast", "monstrosity", "humanoid"],
    },
    ArenaSpec {
        id: "pillar-chamber",
        name: "Зал колонн",
        description: "Прямоугольная палата с колоннами и поперечной полосой скользкого камня; укрытия меняют выгодную линию атаки.",
        width: 14,
        height: 8,
        material: "stone",
        theme: "chamber",
        build: build_pillar_chamber,
        party: PILLAR_PARTY,
        enemies: PILLAR_ENEMIES,
        neutral: &[],
        recommended: &["humanoid", "giant"],
    },
    ArenaSpec {
        id: "forest-clearing",
        name: "Лесная поляна",
        description: "Заросшая поляна с мокрой травой и группами деревьев: дальние атаки прерываются плотными стволами.",
        width: 16,
        height: 10,
        material: "grass",
        theme: "forest",
        build: build_forest_clearing,
        party: FOREST_PARTY,
        enemies: FOREST_ENEMIES,
        neutral: &[],
        recommended: &["beast", "monstrosity", "humanoid"],
    },
    ArenaSpec {
        id: "cavern-bridge",
        name: "Пещерный мост",
        description: "Глубокая вода разрезает пещеру; узкий каменный мост остаётся единственным проходом между берегами.",
        width: 15,
        height: 9,
        material: "earth",
        theme: "cave",
        build: build_cavern_bridge,
        party: BRIDGE_PARTY,
        enemies: BRIDGE_ENEMIES,
        neutral: &[],
        recommended: &["ooze", "undead", "monstrosity"],
    },
    ArenaSpec {
        id: "watchtower-terrace",
        name: "Терраса дозорной башни",
        description: "Каменная башня с поднятой площадкой и обходной лестницей; высота видна в карте, но не отменяет обычную проверку шага.",
        width: 12,
        height: 10,
        material: "stone",
        theme: "fortress",
        build: build_watchtower_terrace,
        party: TOWER_PARTY,
        enemies: TOWER_ENEMIES,
        neutral: &[],
        recommended: &["humanoid", "undead", "dragon"],
    },
];

/// `COMBAT_LAB_MAPS`: каталог арен в порядке JS. Арены — постоянные данные
/// сборки: отказ сборки арены — ошибка кода, а не данных кампании.
pub static COMBAT_LAB_MAPS: LazyLock<Vec<Value>> =
    LazyLock::new(|| SPECS.iter().map(|spec| create_map(spec).unwrap_or_else(|error| panic!("{error}"))).collect());

/// `combatLabMapById(id)`: копия арены (`String(id)`), чтобы сборка боя не
/// могла изменить библиотеку.
pub fn combat_lab_map_by_id(id: Option<&Value>) -> Option<Value> {
    let id = js::string(id);
    COMBAT_LAB_MAPS.iter().find(|map| map["id"].as_str() == Some(id.as_str())).cloned()
}

/// `combatLabMapCatalog()`: каталог копий для API и интерфейса.
pub fn combat_lab_map_catalog() -> Vec<Value> {
    COMBAT_LAB_MAPS.clone()
}

//! Открытая местность: `layoutOpenTerrain`, рельеф террасами
//! (`applyOpenTerrainRelief`), берег (`dressWaterEdges`), ряды могил, укрытия
//! посреди поля, фрагменты развалин и трудная местность пятнами.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};
use sk_core::indexmap::IndexMap;
use sk_core::{js, v8math};
use sk_scene_base::asset_registry::{asset_by_id, AssetEntry};
use sk_tactical::tactical_map::{
    self as tm, CellPatch, EdgeKind, EdgePatch, MapResult, Overlays, RoomLabel, TacticalMap, TacticalMapOptions, TacticalSpawnPoint,
};

use super::cave::{arena_limits, area_limits, safe_side, theme_text, LayoutOptions};
use super::{clamp, js_max, js_min, random_for, shuffled, Result, DIRS};

/// Шаг уровня рельефа открытой местности, в футах.
pub const OPEN_TERRAIN_LEVEL_FEET: i64 = 5;

/// Наибольший перепад между проходимыми соседями, в футах: один уровень.
pub const OPEN_TERRAIN_MAX_STEP_FEET: i64 = OPEN_TERRAIN_LEVEL_FEET;

/// Наименьшая площадка одного уровня, клеток.
pub const OPEN_TERRAIN_MIN_PLATEAU: usize = 6;

/// Версия генератора открытой местности.
pub const OPEN_TERRAIN_GENERATOR_VERSION: &str = "4";

type Cell = (i64, i64);

/// Заплатка клетки открытой местности (`Partial<TacticalCell>` JS):
/// `None` у строк и чисел — поле `undefined`, `setCell` его не трогает.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TerrainPatch {
    pub passable: bool,
    pub material: Option<String>,
    pub surface: Option<String>,
    pub move_cost: f64,
    pub zone: String,
    pub variant: Option<i64>,
    pub revealed: bool,
    pub elevation: Option<i64>,
}

impl TerrainPatch {
    fn surface_is(&self, value: &str) -> bool {
        self.surface.as_deref() == Some(value)
    }

    fn cell_patch(&self) -> CellPatch<'_> {
        CellPatch {
            passable: Some(self.passable),
            revealed: Some(self.revealed),
            move_cost: Some(self.move_cost),
            surface: self.surface.as_deref(),
            material: self.material.as_deref(),
            variant: self.variant,
            elevation: self.elevation,
            zone: Some(&self.zone),
            hazard_id: None,
        }
    }

    /// `{ ...patch, passable: false, surface: 'none', moveCost: 1 }`.
    fn rock(&mut self) {
        self.passable = false;
        self.surface = Some("none".into());
        self.move_cost = 1.0;
    }
}

/// Клетка раскладки: координаты и заплатка.
#[derive(Clone, Debug, PartialEq)]
pub struct TerrainCell {
    pub x: i64,
    pub y: i64,
    pub patch: TerrainPatch,
}

/// Клетки раскладки в порядке вставки (`Map` JS с ключом `"x,y"`).
pub type TerrainCells = IndexMap<Cell, TerrainCell>;

/// Что раскладка знает о местности для рельефа.
pub struct ReliefLayout<'a> {
    pub width: i64,
    pub height: i64,
    pub entrance_y: i64,
    pub on_road_at: &'a dyn Fn(i64, i64) -> bool,
}

/// Что знает раскладка открытой местности и не хранит карта (`OPEN_LAYOUT`).
#[derive(Clone, Debug, Default)]
pub(crate) struct OpenLayout {
    pub road: HashSet<Cell>,
    pub entrance_y: i64,
}

/// `applyOpenTerrainRelief(theme, seed, terrainCells, layout)`: один-три холма
/// террасами по `OPEN_TERRAIN_LEVEL_FEET`; соседи различаются не больше чем на
/// уровень, площадка меньше `OPEN_TERRAIN_MIN_PLATEAU` клеток опускается.
pub fn apply_open_terrain_relief(theme: &Value, seed: &str, terrain_cells: &mut TerrainCells, layout: &ReliefLayout<'_>) {
    let mut random = random_for(&format!("open-relief:{}:{seed}", js::string(theme.get("id"))));
    let (width, height) = (layout.width as f64, layout.height as f64);
    let span = width.min(height);
    let count = (if layout.width * layout.height >= 900 { 2 } else { 1 }) + (random() * 2.0).floor() as usize;
    let wetland = js::truthy(theme.get("wetland"));
    let ceiling: i64 = if wetland { 1 } else { 2 };
    let tall = !wetland && random() < 0.25;
    struct Hill {
        x: f64,
        y: f64,
        rx: f64,
        ry: f64,
        phase: f64,
        peak: i64,
    }
    let mut hills: Vec<Hill> = Vec::new();
    for index in 0..count {
        let x = width * (0.3 + random() * 0.55);
        let y = height * (0.15 + random() * 0.7);
        let rx = js_max(3.0, span * (0.16 + random() * 0.12));
        let ry = js_max(3.0, span * (0.16 + random() * 0.12));
        let phase = random() * std::f64::consts::PI * 2.0;
        let peak = if index == 0 && tall {
            ceiling + 1
        } else if index > 0 && random() < 0.3 {
            1
        } else {
            ceiling
        };
        hills.push(Hill { x, y, rx, ry, phase, peak });
    }
    let passable = |cell: &TerrainCell| cell.patch.passable && !cell.patch.surface_is("water");
    let ground = |cell: &TerrainCell| passable(cell) || cell.patch.surface_is("water");
    let mut level: HashMap<Cell, i64> = HashMap::new();
    for cell in terrain_cells.values() {
        let mut tier: i64 = 0;
        for hill in &hills {
            let (cx, cy) = (cell.x as f64, cell.y as f64);
            let angle = v8math::atan2(cy - hill.y, cx - hill.x);
            let distance = v8math::hypot((cx - hill.x) / hill.rx, (cy - hill.y) / hill.ry) * (1.0 + v8math::sin(angle * 3.0 + hill.phase) * 0.12);
            tier = tier.max(js::round(hill.peak as f64 * clamp((1.25 - distance) / 0.85, 0.0, 1.0)) as i64);
        }
        if cell.patch.surface_is("water") || cell.patch.zone == "crossing" {
            tier = 0;
        }
        if (layout.on_road_at)(cell.x, cell.y) {
            tier = tier.min(1);
        }
        if cell.x <= 5 && (cell.y - layout.entrance_y).abs() <= 2 {
            tier = 0;
        }
        level.insert((cell.x, cell.y), tier);
    }
    let settle = |level: &mut HashMap<Cell, i64>| {
        for _ in 0..80 {
            let mut changed = false;
            for cell in terrain_cells.values() {
                if !ground(cell) {
                    continue;
                }
                let key = (cell.x, cell.y);
                for dy in -1..=1 {
                    for dx in -1..=1 {
                        let Some(neighbor) = terrain_cells.get(&(cell.x + dx, cell.y + dy)) else { continue };
                        if !ground(neighbor) {
                            continue;
                        }
                        let other = level.get(&(neighbor.x, neighbor.y)).copied().unwrap_or(0);
                        if level.get(&key).copied().unwrap_or(0) > other + 1 {
                            level.insert(key, other + 1);
                            changed = true;
                        }
                    }
                }
            }
            if !changed {
                break;
            }
        }
    };
    settle(&mut level);
    for _ in 0..12 {
        let mut seen: HashSet<Cell> = HashSet::new();
        let mut lowered = false;
        for start in terrain_cells.values() {
            let key = (start.x, start.y);
            let tier = level.get(&key).copied().unwrap_or(0);
            if !passable(start) || tier <= 0 || seen.contains(&key) {
                continue;
            }
            let mut patch: Vec<Cell> = vec![key];
            seen.insert(key);
            let mut index = 0;
            while index < patch.len() {
                let (px, py) = patch[index];
                for (dx, dy) in DIRS {
                    let Some(next) = terrain_cells.get(&(px + dx, py + dy)) else { continue };
                    let next_key = (next.x, next.y);
                    if seen.contains(&next_key) || !passable(next) || level.get(&next_key) != Some(&tier) {
                        continue;
                    }
                    seen.insert(next_key);
                    patch.push(next_key);
                }
                index += 1;
            }
            if patch.len() >= OPEN_TERRAIN_MIN_PLATEAU {
                continue;
            }
            for cell in &patch {
                level.insert(*cell, tier - 1);
            }
            lowered = true;
        }
        if !lowered {
            break;
        }
        settle(&mut level);
    }
    let mut feet: HashMap<Cell, i64> = HashMap::new();
    for cell in terrain_cells.values() {
        let key = (cell.x, cell.y);
        feet.insert(key, if cell.patch.surface_is("water") { -2 } else { level.get(&key).copied().unwrap_or(0) * OPEN_TERRAIN_LEVEL_FEET });
    }
    for cell in terrain_cells.values() {
        if ground(cell) {
            continue;
        }
        let mut top: i64 = -1;
        for (dx, dy) in DIRS {
            if let Some(neighbor) = terrain_cells.get(&(cell.x + dx, cell.y + dy)) {
                if ground(neighbor) {
                    top = top.max(feet.get(&(neighbor.x, neighbor.y)).copied().unwrap_or(0));
                }
            }
        }
        if top < 0 {
            top = feet.get(&(cell.x, cell.y)).copied().unwrap_or(0);
        }
        feet.insert((cell.x, cell.y), top + 1 + (random() * 2.0).floor() as i64);
    }
    for cell in terrain_cells.values_mut() {
        cell.patch.elevation = Some(feet.get(&(cell.x, cell.y)).copied().unwrap_or(0));
    }
}

/// `layoutOpenTerrain(theme, { seed, width, height, locationId })`: открытая
/// местность без помещений — проходимая площадка со скалистой кромкой, у
/// дороги — полоса утоптанной земли, по теме — пропасть с мостом, река или пруд.
pub fn layout_open_terrain(theme: &Value, options: &LayoutOptions<'_>) -> Result<TacticalMap> {
    Ok(layout_open(theme, options)?.0)
}

/// Раскладка вместе с тем, что знает только она (`OPEN_LAYOUT`).
pub(crate) fn layout_open(theme: &Value, options: &LayoutOptions<'_>) -> Result<(TacticalMap, OpenLayout)> {
    let area = area_limits();
    let safe_width = safe_side(options.width, 12, area.max_width);
    let safe_height = safe_side(options.height, 12, area.max_height);
    let seed = options.seed;
    let theme_id = js::string(theme.get("id"));
    let mut random = random_for(&format!("open:{theme_id}:{seed}"));
    let generator_id = format!("theme-{theme_id}");
    let mut map = tm::create_tactical_map(&TacticalMapOptions {
        width: safe_width,
        height: safe_height,
        location_id: options.location_id,
        seed,
        generator: Some((&generator_id, OPEN_TERRAIN_GENERATOR_VERSION)),
        theme: theme.get("id").and_then(Value::as_str).unwrap_or(""),
        size_class: if safe_width * safe_height <= arena_limits().max_cells { "arena" } else { "area" },
        ..TacticalMapOptions::default()
    })?;
    let mut field_zone = json!({ "id": "field", "kind": "exterior", "lightLevel": "bright", "floorDirection": "horizontal" });
    if let Some(object) = field_zone.as_object_mut() {
        if let Some(material) = theme.get("material") {
            object.insert("material".into(), material.clone());
        }
        if let Some(label) = theme.get("label") {
            object.insert("label".into(), label.clone());
        }
    }
    tm::add_zone(&mut map, &field_zone)?;

    let pi = std::f64::consts::PI;
    let (width_f, height_f) = (safe_width as f64, safe_height as f64);
    let road_flag = js::truthy(theme.get("road"));
    let road_y = safe_height.div_euclid(2);
    let phase = random() * pi * 2.0;
    let bend = 1 + (random() * js_max(1.0, height_f * 0.09)).floor() as i64;
    let shift = js::round((random() - 0.5) * height_f * 0.14) as i64;
    let fork_x = (width_f * (0.3 + random() * 0.4)).floor() as i64;
    let fork = road_flag && random() < 0.45;
    let trail_y = |x: i64| -> i64 {
        let wave = js::round(v8math::sin(x as f64 / js_max(1.0, width_f - 1.0) * pi * 2.0 + phase) * bend as f64) as i64;
        (road_y + shift + wave).min(safe_height - 4).max(3)
    };
    let on_road_at = |x: i64, y: i64| road_flag && ((y - trail_y(x)).abs() <= 1 || (fork && (x - fork_x).abs() <= 1 && y <= trail_y(x)));
    let material = theme_text(theme, "material");
    let theme_surface = theme.get("surface").filter(|value| !value.is_null()).map(|value| js::string(Some(value)));
    let mud = theme.get("surface").and_then(Value::as_str) == Some("mud");
    let variant = |x: i64, y: i64| i64::from(tm::floor_variant_at(seed, x, y, tm::FLOOR_VARIANTS));
    let mut terrain: TerrainCells = IndexMap::new();
    for y in 0..safe_height {
        for x in 0..safe_width {
            let on_road = on_road_at(x, y);
            let (yf, xf) = (y as f64, x as f64);
            let left = 1 + ((1.0 + v8math::sin(yf * 0.29 + phase)) * 1.2).floor() as i64;
            let right = safe_width - 2 - ((1.0 + v8math::cos(yf * 0.23 + phase)) * 1.2).floor() as i64;
            let top = 1 + ((1.0 + v8math::cos(xf * 0.25 + phase)) * 1.2).floor() as i64;
            let bottom = safe_height - 2 - ((1.0 + v8math::sin(xf * 0.31 + phase)) * 1.2).floor() as i64;
            let present = on_road || (x >= left && x <= right && y >= top && y <= bottom);
            if !present {
                continue;
            }
            let patch = TerrainPatch {
                passable: true,
                material: if on_road { Some("earth".into()) } else { material.clone() },
                surface: Some(if on_road { "none".into() } else { theme_surface.clone().unwrap_or_else(|| "none".into()) }),
                move_cost: if !on_road && mud { 2.0 } else { 1.0 },
                zone: "field".into(),
                variant: Some(variant(x, y)),
                revealed: true,
                elevation: None,
            };
            terrain.insert((x, y), TerrainCell { x, y, patch });
        }
    }
    let entrance_y = trail_y(0);
    let entrance_material = if road_flag { Some("earth".to_string()) } else { material.clone() };
    let mut x = if road_flag { 0 } else { 1 };
    while x <= 5.min(safe_width - 2) {
        for y in entrance_y - 1..=entrance_y + 1 {
            let patch = TerrainPatch {
                passable: true,
                material: entrance_material.clone(),
                surface: Some("none".into()),
                move_cost: 1.0,
                zone: "field".into(),
                variant: None,
                revealed: true,
                elevation: None,
            };
            terrain.insert((x, y), TerrainCell { x, y, patch });
        }
        x += 1;
    }
    let near_entrance = |x: i64, y: i64| x <= 5 && (y - entrance_y).abs() <= 2;
    let mut rim_noise = random_for(&format!("open-rim:{theme_id}:{seed}"));
    let is_edge = |terrain: &TerrainCells, x: i64, y: i64| DIRS.iter().any(|(dx, dy)| !terrain.contains_key(&(x + dx, y + dy)));
    let edge_cells: Vec<Cell> = terrain.values().filter(|cell| is_edge(&terrain, cell.x, cell.y)).map(|cell| (cell.x, cell.y)).collect();
    for key in &edge_cells {
        if on_road_at(key.0, key.1) || near_entrance(key.0, key.1) {
            continue;
        }
        if let Some(cell) = terrain.get_mut(key) {
            cell.patch.rock();
        }
    }
    let edge_set: HashSet<Cell> = edge_cells.iter().copied().collect();
    let forest = theme.get("id").and_then(Value::as_str) == Some("forest");
    let keys: Vec<Cell> = terrain.keys().copied().collect();
    for key in &keys {
        let Some(cell) = terrain.get(key) else { continue };
        if !cell.patch.passable || on_road_at(cell.x, cell.y) || near_entrance(cell.x, cell.y) {
            continue;
        }
        let beside_rim = DIRS.iter().any(|(dx, dy)| {
            let near = (key.0 + dx, key.1 + dy);
            edge_set.contains(&near) && terrain.get(&near).is_some_and(|edge| !edge.patch.passable)
        });
        if beside_rim && rim_noise() < if forest { 0.08 } else { 0.32 } {
            if let Some(cell) = terrain.get_mut(key) {
                cell.patch.rock();
            }
        }
    }
    let bridge_material = theme_text(theme, "bridgeMaterial");
    let crossing_zone = || {
        let mut zone = json!({ "id": "crossing", "kind": "exterior", "lightLevel": "bright", "label": "Мост" });
        if let (Some(object), Some(value)) = (zone.as_object_mut(), theme.get("bridgeMaterial")) {
            object.insert("material".into(), value.clone());
        }
        zone
    };
    let water_zone = |label: &str, floor: Option<&str>| {
        let mut zone = json!({ "id": "water", "kind": "exterior", "lightLevel": "bright", "label": label });
        if let Some(object) = zone.as_object_mut() {
            if let Some(value) = theme.get("material") {
                object.insert("material".into(), value.clone());
            }
            if let Some(floor) = floor {
                object.insert("floor".into(), json!(floor));
            }
        }
        zone
    };
    if js::truthy(theme.get("chasm")) {
        tm::add_zone(&mut map, &crossing_zone())?;
        let chasm_x = (width_f * (0.45 + random() * 0.15)).floor() as i64;
        let chasm_phase = random() * pi * 2.0;
        let chasm_center = |y: i64| chasm_x + js::round(v8math::sin(y as f64 * 0.29 + chasm_phase) * 1.4) as i64;
        let keys: Vec<Cell> = terrain.keys().copied().collect();
        for key in keys {
            if (key.0 - chasm_center(key.1)).abs() > 1 {
                continue;
            }
            if on_road_at(key.0, key.1) {
                if let Some(cell) = terrain.get_mut(&key) {
                    let patch = &mut cell.patch;
                    patch.passable = true;
                    patch.surface = Some("none".into());
                    patch.material = bridge_material.clone();
                    patch.zone = "crossing".into();
                    patch.move_cost = 1.0;
                }
                continue;
            }
            terrain.shift_remove(&key);
        }
    } else if js::truthy(theme.get("river")) {
        tm::add_zone(&mut map, &water_zone("Река", Some("river")))?;
        tm::add_zone(&mut map, &crossing_zone())?;
        let river_x = (width_f * (0.45 + random() * 0.15)).floor() as i64;
        let meander = 1.0 + (random() * 2.0).floor();
        let river_phase = random() * pi * 2.0;
        let river_center = |y: i64| river_x + js::round(v8math::sin(y as f64 * 0.33 + river_phase) * meander) as i64;
        let river_half = |y: i64| if v8math::sin(y as f64 * 0.71 + river_phase * 2.0) > 0.72 { 2 } else { 1 };
        for cell in terrain.values_mut() {
            if (cell.x - river_center(cell.y)).abs() > river_half(cell.y) {
                continue;
            }
            let bridge = (cell.y - trail_y(cell.x)).abs() <= 1;
            let patch = &mut cell.patch;
            patch.passable = bridge;
            patch.surface = Some(if bridge { "none" } else { "water" }.into());
            patch.material = if bridge { bridge_material.clone() } else { material.clone() };
            patch.zone = if bridge { "crossing" } else { "water" }.into();
            patch.move_cost = 1.0;
        }
        let mut bank_noise = random_for(&format!("open-bank:{theme_id}:{seed}"));
        let keys: Vec<Cell> = terrain.keys().copied().collect();
        for key in keys {
            let Some(cell) = terrain.get(&key) else { continue };
            if !cell.patch.passable || cell.patch.zone == "crossing" || on_road_at(key.0, key.1) || near_entrance(key.0, key.1) {
                continue;
            }
            let near_water = [1i64, -1].iter().any(|dx| terrain.get(&(key.0 + dx, key.1)).is_some_and(|near| near.patch.surface_is("water")));
            let near_bridge = [1i64, -1, 2, -2].iter().any(|dy| terrain.get(&(key.0, key.1 + dy)).is_some_and(|near| near.patch.zone == "crossing"));
            if near_water && !near_bridge && bank_noise() < 0.38 {
                if let Some(cell) = terrain.get_mut(&key) {
                    cell.patch.rock();
                }
            }
        }
    } else if js::truthy(theme.get("pond")) || (forest && random() < 0.55) {
        tm::add_zone(&mut map, &water_zone("Пруд", None))?;
        let pond_x = (width_f * (0.55 + random() * 0.25)).floor() as i64;
        let pond_side = if random() < 0.5 { -1 } else { 1 };
        let pond_y = trail_y(pond_x) + pond_side * (height_f * 0.25).floor() as i64;
        let radius = 2.0 + random() * 1.4;
        for cell in terrain.values_mut() {
            if !cell.patch.passable || on_road_at(cell.x, cell.y) || near_entrance(cell.x, cell.y) {
                continue;
            }
            let (dx, dy) = ((cell.x - pond_x) as f64, (cell.y - pond_y) as f64);
            let angle = v8math::atan2(dy, dx);
            let reach = radius * (1.0 + v8math::sin(angle * 3.0 + pond_x as f64) * 0.22);
            if v8math::hypot(dx, dy) <= reach {
                let patch = &mut cell.patch;
                patch.passable = false;
                patch.surface = Some("water".into());
                patch.zone = "water".into();
                patch.move_cost = 1.0;
            }
        }
    }
    // Связный с входом участок, включая воду.
    let start = (1, entrance_y);
    let mut queue: Vec<Cell> = vec![start];
    let mut connected: HashSet<Cell> = HashSet::from([start]);
    let mut index = 0;
    while index < queue.len() {
        let point = queue[index];
        for (dx, dy) in DIRS {
            let next = (point.0 + dx, point.1 + dy);
            if !terrain.contains_key(&next) || connected.contains(&next) {
                continue;
            }
            connected.insert(next);
            queue.push(next);
        }
        index += 1;
    }
    let mut walkable: HashSet<Cell> = HashSet::from([start]);
    let mut walk_queue: Vec<Cell> = vec![start];
    let mut index = 0;
    while index < walk_queue.len() {
        let point = walk_queue[index];
        for (dx, dy) in DIRS {
            let key = (point.0 + dx, point.1 + dy);
            if walkable.contains(&key) || !connected.contains(&key) || !terrain.get(&key).is_some_and(|cell| cell.patch.passable) {
                continue;
            }
            walkable.insert(key);
            walk_queue.push(key);
        }
        index += 1;
    }
    for point in &queue {
        if let Some(cell) = terrain.get_mut(point) {
            if cell.patch.passable && !walkable.contains(point) {
                cell.patch.rock();
            }
        }
    }
    let mut kept: TerrainCells = IndexMap::new();
    for point in &queue {
        if let Some(cell) = terrain.get(point) {
            kept.insert((cell.x, cell.y), cell.clone());
        }
    }
    if !js::truthy(theme.get("flat")) {
        apply_open_terrain_relief(theme, seed, &mut kept, &ReliefLayout { width: safe_width, height: safe_height, entrance_y, on_road_at: &on_road_at });
    }
    let mut road: HashSet<Cell> = HashSet::new();
    for cell in kept.values() {
        tm::set_cell(&mut map, cell.x, cell.y, &cell.patch.cell_patch())?;
        if cell.patch.passable && on_road_at(cell.x, cell.y) {
            road.insert((cell.x, cell.y));
        }
    }
    map.spawn_points.push(TacticalSpawnPoint { id: "party-entrance".into(), x: 1, y: entrance_y, role: "party".into() });
    map.overlays = Overlays {
        compass: true,
        scale_bar: true,
        room_labels: vec![RoomLabel { zone_id: "field".into(), label: js::s(theme.get("label")) }],
    };
    Ok((map, OpenLayout { road, entrance_y }))
}

// --- предметы ---------------------------------------------------------------------

/// Объект предмета для `addProp` по записи реестра.
pub(crate) fn asset_prop(id: &str, asset: &AssetEntry, x: f64, y: f64, rotation: f64, scale: f64, footprint: &[Cell]) -> Value {
    json!({
        "id": id, "assetId": asset.id, "x": js::num(x), "y": js::num(y), "rotation": js::num(rotation), "scale": js::num(scale),
        "footprint": footprint.iter().map(|(x, y)| json!({ "x": x, "y": y })).collect::<Vec<_>>(),
        "zOrder": 0, "blocksMove": asset.blocks_move, "blocksSight": asset.blocks_sight, "cover": asset.cover,
        "destructible": asset.destructible, "hp": js::num(asset.hp), "interactive": asset.interactive,
    })
}

/// Наклейка без клетки: проходу и укрытию не мешает.
fn decal_prop(id: &str, asset_id: &str, x: f64, y: f64, rotation: f64, scale: f64) -> Value {
    json!({
        "id": id, "assetId": asset_id, "x": js::num(x), "y": js::num(y), "rotation": js::num(rotation), "scale": js::num(scale),
        "footprint": [], "zOrder": 0, "blocksMove": false, "blocksSight": false, "cover": "none", "destructible": false, "hp": 0, "interactive": false,
    })
}

fn party(map: &TacticalMap) -> Option<(i64, i64)> {
    map.spawn_points.iter().find(|point| point.role == "party").map(|point| (point.x, point.y))
}

/// `propCells(map)`: клетки под предметами (наклейки — по их точке) и только
/// мешающие шагу. Предметы на опоре не в счёт.
fn prop_cells(map: &TacticalMap) -> (HashSet<Cell>, HashSet<Cell>) {
    let mut any = HashSet::new();
    let mut blocking = HashSet::new();
    for prop in &map.props {
        if prop.mount.is_some() {
            continue;
        }
        let cells: Vec<Cell> = if prop.footprint.is_empty() { vec![(prop.x.floor() as i64, prop.y.floor() as i64)] } else { prop.footprint.iter().map(|point| (point.x, point.y)).collect() };
        for cell in cells {
            any.insert(cell);
            if prop.blocks_move {
                blocking.insert(cell);
            }
        }
    }
    (any, blocking)
}

fn edge_at(map: &TacticalMap, ax: i64, ay: i64, bx: i64, by: i64) -> Option<&tm::TacticalEdge> {
    tm::edge_between(map, ax, ay, bx, by).ok().flatten()
}

/// `wallBetween(map, x, y, nx, ny)`: на ребре стоит стена (не дверь).
fn wall_between(map: &TacticalMap, x: i64, y: i64, nx: i64, ny: i64) -> bool {
    edge_at(map, x, y, nx, ny).is_some_and(|edge| edge.kind != EdgeKind::Door && edge.blocks_move)
}

/// `nearPartyEntrance(map, x, y, margin)`.
fn near_party_entrance(map: &TacticalMap, layout: Option<&OpenLayout>, x: i64, y: i64, margin: i64) -> bool {
    let party = party(map);
    let entrance_y = layout.map(|layout| layout.entrance_y).or(party.map(|point| point.1)).unwrap_or(0);
    if x <= 5 + margin && (y - entrance_y).abs() <= 2 + margin {
        return true;
    }
    party.is_some_and(|(px, py)| (x - px).abs().max((y - py).abs()) <= 3 + margin)
}

/// Голая земля поля: без воды, грязи и щебня; наст зимней карты — тоже земля.
fn bare_ground(surface: &str) -> bool {
    surface == "none" || surface == "ice"
}

fn reach_size(map: &TacticalMap, from: Cell, blocked: &HashSet<Cell>) -> usize {
    tm::reachable_cells(map, from.0, from.1, true, Some(blocked)).len()
}

/// `placeGraveRows(map, seed)`: надгробия 2×1 рядами через клетку посреди участка.
pub(crate) fn place_grave_rows(map: &mut TacticalMap, seed: &str) -> MapResult<()> {
    let Some(asset) = asset_by_id("grave") else { return Ok(()) };
    let mut random = random_for(&format!("graves:{seed}"));
    let entrance = party(map);
    let free = |map: &TacticalMap, x: i64, y: i64| {
        let Some(cell) = tm::cell_at(map, x, y) else { return false };
        if !cell.passable || cell.surface == "water" || cell.material == "earth" || cell.zone != "field" {
            return false;
        }
        if entrance.is_some_and(|(ex, ey)| (x - ex).abs() <= 6 && (y - ey).abs() <= 3) {
            return false;
        }
        DIRS.iter().all(|(dx, dy)| tm::cell_passable(map, x + dx, y + dy))
    };
    let mut placed = 0;
    let offset_x = (random() * 2.0).floor() as i64;
    let mut y = 4;
    while y < map.height - 4 {
        let mut x = 6 + offset_x;
        while x < map.width - 5 {
            if !free(map, x, y) || !free(map, x + 1, y) || random() < 0.18 {
                x += 3;
                continue;
            }
            placed += 1;
            tm::add_prop(map, &asset_prop(&format!("grave-row-{placed}"), asset, (x + 1) as f64, y as f64 + 0.5, 0.0, 1.0, &[(x, y), (x + 1, y)]))?;
            x += 3;
        }
        y += 3;
    }
    Ok(())
}

/// Предельное число камышей и речных камней на берегу одной карты.
const SHORE_CAPS: [(&str, usize); 2] = [("reeds", 10), ("river_rocks", 6)];

/// `dressWaterEdges(map, seed)`: камыш и речные камни на сухих клетках у
/// воды — наклейки без клетки; у моста берег чист. Возвращает, сколько
/// поставлено. `seed` — `String(seed)`.
pub fn dress_water_edges(map: &mut TacticalMap, seed: &str) -> MapResult<usize> {
    let mut random = random_for(&format!("shore:{seed}"));
    let water = |map: &TacticalMap, x: i64, y: i64| tm::cell_at(map, x, y).is_some_and(|cell| cell.surface == "water");
    let near_crossing = |map: &TacticalMap, x: i64, y: i64| (-1..=1).any(|dy| (-1..=1).any(|dx| tm::cell_at(map, x + dx, y + dy).is_some_and(|cell| cell.zone == "crossing")));
    let mut counts = [0usize; 2];
    let mut placed = 0;
    for y in 0..map.height {
        for x in 0..map.width {
            let Some(cell) = tm::cell_at(map, x, y) else { continue };
            if !cell.passable || cell.surface == "water" || near_crossing(map, x, y) {
                continue;
            }
            let Some((tx, ty)) = DIRS.iter().copied().find(|(dx, dy)| water(map, x + dx, y + dy)) else { continue };
            let roll = random();
            let slot = if roll < 0.22 {
                0
            } else if roll < 0.32 {
                1
            } else {
                continue;
            };
            let (asset_id, cap) = SHORE_CAPS[slot];
            if counts[slot] >= cap {
                continue;
            }
            if map.props.iter().any(|prop| prop.asset_id == asset_id && (prop.x.floor() as i64 - x).abs().max((prop.y.floor() as i64 - y).abs()) <= 1) {
                continue;
            }
            if asset_by_id(asset_id).is_none() {
                continue;
            }
            counts[slot] += 1;
            placed += 1;
            let px = x as f64 + 0.5 + tx as f64 * 0.28;
            let py = y as f64 + 0.5 + ty as f64 * 0.28;
            let rotation = (random() * 4.0).floor() * 90.0;
            let scale = 0.85 + random() * 0.3;
            tm::add_prop(map, &decal_prop(&format!("shore-{asset_id}-{}", counts[slot]), asset_id, px, py, rotation, scale))?;
        }
    }
    Ok(placed)
}

/// Радиус пуассоновского диска природной россыпи (`SCATTER_RADIUS`).
const SCATTER_RADIUS: [(&str, f64); 9] = [
    ("tree_oak", 2.3),
    ("tree_pine", 2.3),
    ("tree_birch", 1.8),
    ("tree_dead", 1.8),
    ("bush", 1.2),
    ("shrub", 1.2),
    ("rock_small", 1.2),
    ("boulder", 1.5),
    ("tree_stump", 1.2),
];

fn scatter_radius(asset_id: &str) -> Option<f64> {
    SCATTER_RADIUS.iter().find(|(id, _)| *id == asset_id).map(|(_, radius)| *radius)
}

struct CoverSpot {
    x: i64,
    y: i64,
    w: i64,
    h: i64,
    asset_id: String,
    rotation: f64,
    score: f64,
}

/// `placeNatureCover(map, { seed, assets, target })`: укрытия посреди поля —
/// каждое там, где до ближайшего укрытия дальше всего, пока доля клеток с
/// укрытием сбоку не дойдёт до `target`. Возвращает, сколько поставлено.
pub(crate) fn place_nature_cover(map: &mut TacticalMap, layout: Option<&OpenLayout>, seed: &str, assets: &[&str], target: f64) -> MapResult<usize> {
    let mut random = random_for(&format!("nature-cover:{seed}"));
    let empty = HashSet::new();
    let road = layout.map_or(&empty, |layout| &layout.road);
    let limit = 3i64.max(js::round((map.width * map.height) as f64 / 45.0) as i64);
    let mut counts: HashMap<String, usize> = HashMap::new();
    let mut placed: i64 = 0;
    let mut rejected: HashSet<Cell> = HashSet::new();
    let party = party(map);
    let (width, height) = (map.width, map.height);
    let inside = |x: i64, y: i64| x >= 0 && y >= 0 && x < width && y < height;
    let mut wall_side = vec![0u8; (width * height) as usize];
    for edge in tm::edge_list(map) {
        if edge.kind == EdgeKind::Door || !edge.blocks_move {
            continue;
        }
        let (nx, ny) = tm::edge_neighbor(edge.x, edge.y, edge.dir);
        for (px, py) in [(edge.x, edge.y), (nx, ny)] {
            if inside(px, py) {
                wall_side[(py * width + px) as usize] = 1;
            }
        }
    }
    let mut distance = vec![0i32; (width * height) as usize];
    let mut queue = vec![0usize; (width * height) as usize];
    let mut round = 0;
    while round < limit * 3 && placed < limit {
        round += 1;
        let (any, blocking) = prop_cells(map);
        let mut blocked = vec![0u8; (width * height) as usize];
        for (x, y) in &blocking {
            if inside(*x, *y) {
                blocked[(y * width + x) as usize] = 1;
            }
        }
        let mut open = 0usize;
        let mut covered = 0usize;
        for y in 0..height {
            for x in 0..width {
                let Some(cell) = tm::cell_at(map, x, y) else { continue };
                if !cell.passable || cell.surface == "water" || blocked[(y * width + x) as usize] != 0 {
                    continue;
                }
                open += 1;
                if wall_side[(y * width + x) as usize] != 0 || DIRS.iter().any(|(dx, dy)| inside(x + dx, y + dy) && blocked[((y + dy) * width + x + dx) as usize] != 0) {
                    covered += 1;
                }
            }
        }
        if open == 0 || covered as f64 / open as f64 >= target {
            break;
        }
        distance.fill(-1);
        let mut tail = 0;
        for index in 0..(width * height) as usize {
            if blocked[index] == 0 && wall_side[index] == 0 {
                continue;
            }
            distance[index] = 0;
            queue[tail] = index;
            tail += 1;
        }
        let mut head = 0;
        while head < tail {
            let index = queue[head];
            head += 1;
            let px = index as i64 % width;
            let py = (index as i64 - px) / width;
            for dy in -1..=1 {
                for dx in -1..=1 {
                    let (x, y) = (px + dx, py + dy);
                    if !inside(x, y) || distance[(y * width + x) as usize] >= 0 {
                        continue;
                    }
                    distance[(y * width + x) as usize] = distance[index] + 1;
                    queue[tail] = (y * width + x) as usize;
                    tail += 1;
                }
            }
        }
        let fits = |map: &TacticalMap, x: i64, y: i64, w: i64, h: i64| -> bool {
            let level = tm::cell_at(map, x, y).map(|cell| cell.elevation);
            for cy in y - 1..=y + h {
                for cx in x - 1..=x + w {
                    let cell = tm::cell_at(map, cx, cy);
                    let within = cx >= x && cx < x + w && cy >= y && cy < y + h;
                    if !within {
                        if cell.is_some_and(|cell| cell.passable && (blocking.contains(&(cx, cy)) || cell.zone == "crossing")) {
                            return false;
                        }
                        continue;
                    }
                    let Some(cell) = cell else { return false };
                    if !cell.passable || cell.surface == "water" || cell.zone != "field" || rejected.contains(&(cx, cy)) {
                        return false;
                    }
                    if cx <= 0 || cy <= 0 || cx >= map.width - 1 || cy >= map.height - 1 {
                        return false;
                    }
                    if road.contains(&(cx, cy)) || any.contains(&(cx, cy)) || Some(cell.elevation) != level || near_party_entrance(map, layout, cx, cy, 1) {
                        return false;
                    }
                    if DIRS.iter().any(|(dx, dy)| wall_between(map, cx, cy, cx + dx, cy + dy)) {
                        return false;
                    }
                }
            }
            true
        };
        let scatter: Vec<(i64, i64, f64)> =
            map.props.iter().filter_map(|prop| scatter_radius(&prop.asset_id).map(|radius| (prop.x.floor() as i64, prop.y.floor() as i64, radius))).collect();
        let mut order: Vec<&str> = assets.to_vec();
        let position = |id: &str| assets.iter().position(|candidate| *candidate == id).unwrap_or(usize::MAX);
        order.sort_by(|left, right| {
            let by_count = counts.get(*left).copied().unwrap_or(0).cmp(&counts.get(*right).copied().unwrap_or(0));
            by_count.then(position(left).cmp(&position(right)))
        });
        let mut found: Option<CoverSpot> = None;
        for asset_id in &order {
            let Some(asset) = asset_by_id(asset_id) else { continue };
            // В JS ширина и высота предмета здесь затеняют размеры карты, и
            // индекс дали `distance[cy * width + cx]` считается по ширине
            // предмета — перенесено как есть (раздел «Замечено в JS» отчёта).
            let asset_width = js_max(1.0, asset.base_footprint.w);
            let asset_height = js_max(1.0, asset.base_footprint.h);
            let turns: &[f64] = if asset_width == asset_height { &[0.0] } else { &[0.0, 90.0] };
            for rotation in turns {
                let (w, h) = if *rotation != 0.0 { (asset_height as i64, asset_width as i64) } else { (asset_width as i64, asset_height as i64) };
                let mut y = 1;
                while y + h < map.height {
                    let mut x = 1;
                    while x + w < map.width {
                        let mut nearest = f64::INFINITY;
                        for cy in y..y + h {
                            for cx in x..x + w {
                                let index = cy as f64 * asset_width + cx as f64;
                                let far = distance.get(index as usize).filter(|_| index >= 0.0).map_or(f64::NAN, |value| f64::from(*value));
                                nearest = js_min(nearest, if far < 0.0 { 99.0 } else { far });
                            }
                        }
                        let skip = nearest < 2.0 || found.as_ref().is_some_and(|found| js_min(nearest, 12.0) + 0.9 <= found.score);
                        if skip || !fits(map, x, y, w, h) {
                            x += 1;
                            continue;
                        }
                        let cx = (x as f64 + w as f64 / 2.0).floor();
                        let cy = (y as f64 + h as f64 / 2.0).floor();
                        let own = scatter_radius(asset_id).unwrap_or(0.0);
                        if scatter.iter().any(|(ox, oy, radius)| v8math::hypot(*ox as f64 - cx, *oy as f64 - cy) < own.max(*radius)) {
                            x += 1;
                            continue;
                        }
                        let score = js_min(nearest, 12.0) + random() * 0.9;
                        if found.as_ref().is_none_or(|found| score > found.score) {
                            found = Some(CoverSpot { x, y, w, h, asset_id: asset_id.to_string(), rotation: *rotation, score });
                        }
                        x += 1;
                    }
                    y += 1;
                }
            }
            if found.is_some() {
                break;
            }
        }
        let Some(best) = found else { break };
        if best.score < 2.0 {
            break;
        }
        let Some(asset) = asset_by_id(&best.asset_id) else { break };
        let mut footprint: Vec<Cell> = Vec::new();
        for cy in best.y..best.y + best.h {
            for cx in best.x..best.x + best.w {
                footprint.push((cx, cy));
            }
        }
        let mut tight = false;
        for cy in best.y - 1..=best.y + best.h {
            for cx in best.x - 1..=best.x + best.w {
                let open_cell = tm::cell_at(map, cx, cy).is_some_and(|cell| cell.passable && cell.surface != "water");
                if !open_cell || (inside(cx, cy) && wall_side[(cy * width + cx) as usize] != 0) {
                    tight = true;
                }
            }
        }
        let before = match party {
            Some(point) if tight => reach_size(map, point, &blocking),
            _ => 0,
        };
        let id = format!("nature-cover-{}", placed + 1);
        let scale = clamp(0.95 + random() * 0.2, asset.scale_range.min, asset.scale_range.max);
        let x = best.x as f64 + best.w as f64 / 2.0;
        let y = best.y as f64 + best.h as f64 / 2.0;
        tm::add_prop(map, &asset_prop(&id, asset, x, y, best.rotation, scale, &footprint))?;
        if let Some(point) = party.filter(|_| tight) {
            let after = reach_size(map, point, &prop_cells(map).1);
            if (after as i64) < before as i64 - footprint.len() as i64 {
                map.props.retain(|prop| prop.id != id);
                for cell in &footprint {
                    rejected.insert(*cell);
                }
                continue;
            }
        }
        placed += 1;
        *counts.entry(best.asset_id.clone()).or_insert(0) += 1;
    }
    Ok(placed as usize)
}

/// Стена развалин: глухая кладка.
const RUIN_WALL: EdgePatch<'static> = EdgePatch { kind: Some("wall"), blocks_move: Some(true), blocks_sight: Some(true), cover: Some("three_quarters"), door_id: None };
const NO_EDGE: EdgePatch<'static> = EdgePatch { kind: Some("none"), blocks_move: None, blocks_sight: None, cover: None, door_id: None };

/// Грань стены: клетка и её сосед.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Face {
    x: i64,
    y: i64,
    nx: i64,
    ny: i64,
}

fn line(axis: char, vx: i64, vy: i64, step: i64, length: i64) -> Vec<Face> {
    (0..length.max(0))
        .map(|index| {
            let along = if step > 0 { index } else { -1 - index };
            if axis == 'h' {
                Face { x: vx + along, y: vy - 1, nx: vx + along, ny: vy }
            } else {
                Face { x: vx - 1, y: vy + along, nx: vx, ny: vy + along }
            }
        })
        .collect()
}

/// `placeRuinFragments(map, { seed, wanted })`: фрагменты стен — обрывок или
/// угол с проломом — в разных частях карты, обломки вокруг и остатки ворот на
/// дороге. Возвращает, сколько поставлено фрагментов, считая ворота.
pub(crate) fn place_ruin_fragments(map: &mut TacticalMap, layout: Option<&OpenLayout>, seed: &str, wanted: usize) -> MapResult<usize> {
    let mut random = random_for(&format!("ruin-fragments:{seed}"));
    let empty = HashSet::new();
    let road = layout.map_or(&empty, |layout| &layout.road);
    let party = party(map);
    let reach_count = |map: &TacticalMap| party.map_or(0, |point| reach_size(map, point, &prop_cells(map).1));
    let mut reach = reach_count(map);
    let place = |map: &mut TacticalMap, random: &mut dyn FnMut() -> f64, asset_id: &str, point: Cell, id: &str| -> MapResult<()> {
        let Some(asset) = asset_by_id(asset_id) else { return Ok(()) };
        let flat = asset.base_footprint.w == 0.0 || asset.base_footprint.w.is_nan();
        let rotation = (random() * 4.0).floor() * 90.0;
        let footprint: Vec<Cell> = if flat { Vec::new() } else { vec![point] };
        tm::add_prop(map, &asset_prop(id, asset, point.0 as f64 + 0.5, point.1 as f64 + 0.5, rotation, 1.0, &footprint))?;
        Ok(())
    };
    let scatter_rubble = |map: &mut TacticalMap, random: &mut dyn FnMut() -> f64, near: &[Cell], index: usize| -> MapResult<()> {
        let (any, _) = prop_cells(map);
        let eligible: Vec<Cell> = near
            .iter()
            .copied()
            .filter(|point| {
                tm::cell_at(map, point.0, point.1).is_some_and(|cell| cell.passable && bare_ground(cell.surface) && cell.zone == "field")
                    && !road.contains(point)
                    && !near_party_entrance(map, layout, point.0, point.1, 0)
            })
            .collect();
        let candidates = shuffled(&eligible, random);
        let take = 3 + (random() * 3.0).floor() as usize;
        let chosen: Vec<Cell> = candidates.into_iter().take(take).collect();
        for point in &chosen {
            tm::set_cell(map, point.0, point.1, &CellPatch { surface: Some("rubble"), move_cost: Some(2.0), ..CellPatch::default() })?;
        }
        let free: Vec<Cell> = chosen.iter().copied().filter(|point| !any.contains(point)).collect();
        if let Some(point) = free.first() {
            place(map, random, "rubble_heap", *point, &format!("ruins-{index}-rubble_heap-1"))?;
        }
        if let Some(point) = free.get(1) {
            place(map, random, "scree", *point, &format!("ruins-{index}-scree-1"))?;
        }
        Ok(())
    };
    let mut built = 0;
    let (columns, rows) = (3i64, 2i64);
    #[derive(Clone, Copy)]
    struct Sector {
        x0: i64,
        x1: i64,
        y0: i64,
        y1: i64,
    }
    let mut sectors: Vec<Sector> = Vec::new();
    for row in 0..rows {
        for column in 0..columns {
            sectors.push(Sector {
                x0: (column * map.width).div_euclid(columns),
                x1: ((column + 1) * map.width).div_euclid(columns) - 1,
                y0: (row * map.height).div_euclid(rows),
                y1: ((row + 1) * map.height).div_euclid(rows) - 1,
            });
        }
    }
    let holds_entrance = |sector: &Sector| party.is_some_and(|(px, py)| px >= sector.x0 && px <= sector.x1 && py >= sector.y0 && py <= sector.y1);
    let outer: Vec<Sector> = sectors.iter().copied().filter(|sector| !holds_entrance(sector)).collect();
    let mut order = shuffled(&outer, &mut random);
    order.extend(sectors.iter().copied().filter(|sector| holds_entrance(sector)));
    for sector in &order {
        if built >= wanted {
            break;
        }
        for _ in 0..80 {
            let corner = random() < 0.55;
            let vx = sector.x0 + (random() * 1f64.max((sector.x1 - sector.x0 + 1) as f64)).floor() as i64;
            let vy = sector.y0 + (random() * 1f64.max((sector.y1 - sector.y0 + 1) as f64)).floor() as i64;
            let sx = if (vx as f64) < map.width as f64 / 2.0 { 1 } else { -1 };
            let sy = if (vy as f64) < map.height as f64 / 2.0 { 1 } else { -1 };
            let cells = map.width * map.height;
            let extra = if cells < 300 {
                -1
            } else if cells < 500 {
                0
            } else {
                1
            };
            let lines: Vec<Vec<Face>> = if corner {
                let first = line('h', vx, vy, sx, 3 + extra + (random() * 3.0).floor() as i64);
                let second = line('v', vx, vy, sy, 3 + extra + (random() * 3.0).floor() as i64);
                vec![first, second]
            } else if random() < 0.5 {
                vec![line('h', vx, vy, sx, 4 + extra + (random() * 4.0).floor() as i64)]
            } else {
                vec![line('v', vx, vy, sy, 4 + extra + (random() * 4.0).floor() as i64)]
            };
            let edges: Vec<Face> = lines.iter().flatten().copied().collect();
            let touched: Vec<Cell> = edges.iter().flat_map(|edge| [(edge.x, edge.y), (edge.nx, edge.ny)]).collect();
            // `Math.min(...[])` — бесконечность: пустой фрагмент не помещается.
            let Some(min_x) = touched.iter().map(|point| point.0).min().map(|value| value - 1) else { continue };
            let max_x = touched.iter().map(|point| point.0).max().map_or(0, |value| value + 1);
            let min_y = touched.iter().map(|point| point.1).min().map_or(0, |value| value - 1);
            let max_y = touched.iter().map(|point| point.1).max().map_or(0, |value| value + 1);
            if min_x < 0 || min_y < 0 || max_x > map.width - 1 || max_y > map.height - 1 {
                continue;
            }
            let (any, _) = prop_cells(map);
            let own: HashSet<Cell> = touched.iter().copied().collect();
            let mut fits = true;
            let mut y = min_y;
            while y <= max_y && fits {
                let mut x = min_x;
                while x <= max_x && fits {
                    let cell = tm::cell_at(map, x, y);
                    if own.contains(&(x, y)) && !cell.is_some_and(|cell| cell.passable && bare_ground(cell.surface) && cell.zone == "field" && !road.contains(&(x, y))) {
                        fits = false;
                    }
                    if cell.is_some_and(|cell| cell.passable) && (any.contains(&(x, y)) || near_party_entrance(map, layout, x, y, 1)) {
                        fits = false;
                    }
                    if [(1, 0), (0, 1)].iter().any(|(dx, dy)| edge_at(map, x, y, x + dx, y + dy).is_some()) {
                        fits = false;
                    }
                    x += 1;
                }
                y += 1;
            }
            let elevation = |x: i64, y: i64| tm::cell_at(map, x, y).map(|cell| cell.elevation);
            if !fits || edges.iter().any(|edge| elevation(edge.x, edge.y) != elevation(edge.nx, edge.ny)) {
                continue;
            }
            let mut standing: Vec<Vec<bool>> = lines.iter().map(|faces| (0..faces.len()).map(|index| index == 0 || random() < 0.85).collect()).collect();
            for (index, faces) in lines.iter().enumerate() {
                if faces.len() < 4 {
                    continue;
                }
                let start = 1 + (random() * (faces.len() - 2) as f64).floor() as usize;
                standing[index][start] = false;
                if start + 1 < faces.len() {
                    standing[index][start + 1] = false;
                }
            }
            let raised: Vec<Face> = lines.iter().enumerate().flat_map(|(index, faces)| faces.iter().enumerate().filter(|(step, _)| standing[index][*step]).map(|(_, face)| *face).collect::<Vec<_>>()).collect();
            for edge in &raised {
                tm::set_edge(map, edge.x, edge.y, edge.nx, edge.ny, &RUIN_WALL)?;
            }
            let now = reach_count(map);
            if now < reach {
                for edge in &raised {
                    tm::set_edge(map, edge.x, edge.y, edge.nx, edge.ny, &NO_EDGE)?;
                }
                continue;
            }
            reach = now;
            built += 1;
            let mut near: Vec<Cell> = Vec::new();
            for y in min_y..=max_y {
                for x in min_x..=max_x {
                    near.push((x, y));
                }
            }
            scatter_rubble(map, &mut random, &near, built)?;
            break;
        }
    }
    if !road.is_empty() {
        let map_height = map.height;
        let road_rows = |x: i64| -> Option<[i64; 3]> {
            let ys: Vec<i64> = (0..map_height).filter(|y| road.contains(&(x, *y))).collect();
            (ys.len() == 3 && ys[2] - ys[0] == 2).then(|| [ys[0], ys[1], ys[2]])
        };
        let mut columns_to_try: Vec<i64> = Vec::new();
        let mut x = 8i64.max((map.width as f64 * 0.3).ceil() as i64);
        while x as f64 <= (map.width as f64 * 0.75).floor() {
            columns_to_try.push(x);
            x += 1;
        }
        for x in shuffled(&columns_to_try, &mut random) {
            let Some(ys) = road_rows(x) else { continue };
            if ![x - 1, x + 1].iter().all(|column| road_rows(*column).is_some_and(|rows| rows[0] == ys[0])) {
                continue;
            }
            let stub = 2 + (random() * 2.0).floor() as i64;
            let top = ys[0] - 1;
            let bottom = ys[2] + 1;
            let posts = [(x, top), (x, bottom)];
            let wings: Vec<Face> = (0..stub)
                .map(|step| Face { x, y: top - 1 - step, nx: x + 1, ny: top - 1 - step })
                .chain((0..stub).map(|step| Face { x, y: bottom + 1 + step, nx: x + 1, ny: bottom + 1 + step }))
                .collect();
            let (any, _) = prop_cells(map);
            let clear = |map: &TacticalMap, cx: i64, cy: i64| {
                tm::cell_at(map, cx, cy).is_some_and(|cell| cell.passable && bare_ground(cell.surface) && cell.zone == "field") && !road.contains(&(cx, cy)) && !any.contains(&(cx, cy))
            };
            if !posts.iter().all(|point| clear(map, point.0, point.1)) {
                continue;
            }
            if !wings.iter().all(|edge| clear(map, edge.x, edge.y) && clear(map, edge.nx, edge.ny) && edge_at(map, edge.x, edge.y, edge.nx, edge.ny).is_none()) {
                continue;
            }
            for (index, point) in posts.iter().enumerate() {
                place(map, &mut random, "pillar", *point, &format!("ruins-gate-pillar-{}", index + 1))?;
            }
            for edge in &wings {
                tm::set_edge(map, edge.x, edge.y, edge.nx, edge.ny, &RUIN_WALL)?;
            }
            let now = reach_count(map);
            if (now as i64) < reach as i64 - posts.len() as i64 {
                map.props.retain(|prop| !prop.id.starts_with("ruins-gate-"));
                for edge in &wings {
                    tm::set_edge(map, edge.x, edge.y, edge.nx, edge.ny, &NO_EDGE)?;
                }
                continue;
            }
            // В JS здесь `reach = now`, но после ворот досягаемость больше не читается.
            built += 1;
            let near: Vec<Cell> = wings.iter().flat_map(|edge| [(edge.x - 1, edge.y), (edge.nx + 1, edge.ny), (edge.x, edge.y), (edge.nx, edge.ny)]).collect();
            scatter_rubble(map, &mut random, &near, built)?;
            break;
        }
    }
    Ok(built)
}

/// Трудная местность открытой карты по виду (`OPEN_ROUGH`): покрытие клетки,
/// наклейки и предмет, через который проходят с трудом.
struct OpenRough {
    surface: Option<&'static str>,
    decals: &'static [&'static str],
    props: &'static [&'static str],
}

fn open_rough(kind: &str) -> Option<OpenRough> {
    let entry = |surface, decals, props| Some(OpenRough { surface, decals, props });
    match kind {
        "undergrowth" => entry(None, &["fern", "leaf_litter", "forest_plant"], &["dead_bramble"]),
        "windfall" => entry(None, &["leaf_litter", "forest_plant"], &["fallen_log"]),
        "mud" => entry(Some("mud"), &["mud_patch"], &[]),
        "shallows" => entry(Some("mud"), &["lily_pad_cluster", "reeds"], &[]),
        "rubble" => entry(Some("rubble"), &["scree", "pebbles"], &[]),
        "snow" => entry(None, &["snowdrift"], &[]),
        "sand" => entry(None, &["sand_dune"], &[]),
        _ => None,
    }
}

/// `roughenOpenTerrain(map, { seed, kinds, share, sizes })`: трудная местность
/// пятнами до доли `share` свободных клеток — не на дороге и мосту, не у входа
/// и не в проходе шириной в клетку. Возвращает, сколько клеток стало трудными.
pub(crate) fn roughen_open_terrain(map: &mut TacticalMap, layout: Option<&OpenLayout>, seed: &str, kinds: &[&str], share: f64, sizes: (i64, i64)) -> MapResult<usize> {
    let mut random = random_for(&format!("open-rough:{seed}"));
    let empty = HashSet::new();
    let road = layout.map_or(&empty, |layout| &layout.road);
    let (_, blocking) = prop_cells(map);
    let mut free = 0usize;
    let mut rough = 0usize;
    for y in 0..map.height {
        for x in 0..map.width {
            let Some(cell) = tm::cell_at(map, x, y) else { continue };
            if !cell.passable || cell.surface == "water" || blocking.contains(&(x, y)) {
                continue;
            }
            free += 1;
            if cell.move_cost > 1 {
                rough += 1;
            }
        }
    }
    let target = js::round(free as f64 * share) as i64;
    let rough = rough as i64;
    let closed = |map: &TacticalMap, x: i64, y: i64, nx: i64, ny: i64| {
        let open = tm::cell_at(map, nx, ny).is_some_and(|cell| cell.passable && cell.surface != "water");
        !open || blocking.contains(&(nx, ny)) || wall_between(map, x, y, nx, ny)
    };
    let eligible = |map: &TacticalMap, x: i64, y: i64| {
        let Some(cell) = tm::cell_at(map, x, y) else { return false };
        if !cell.passable || !bare_ground(cell.surface) || cell.move_cost > 1 || cell.zone != "field" {
            return false;
        }
        if x <= 0 || y <= 0 || x >= map.width - 1 || y >= map.height - 1 {
            return false;
        }
        if blocking.contains(&(x, y)) || road.contains(&(x, y)) || near_party_entrance(map, layout, x, y, 0) {
            return false;
        }
        !(closed(map, x, y, x - 1, y) && closed(map, x, y, x + 1, y)) && !(closed(map, x, y, x, y - 1) && closed(map, x, y, x, y + 1))
    };
    let mut ground: Vec<Cell> = Vec::new();
    for y in 1..map.height - 1 {
        for x in 1..map.width - 1 {
            if eligible(map, x, y) {
                ground.push((x, y));
            }
        }
    }
    let mut centers: Vec<Cell> = Vec::new();
    let mut decal_counts: HashMap<String, usize> = HashMap::new();
    for prop in &map.props {
        *decal_counts.entry(prop.asset_id.clone()).or_insert(0) += 1;
    }
    let mut changed: i64 = 0;
    let mut patch_index = 0usize;
    let touching = |a: Cell, b: Cell| (a.0 - b.0).abs().max((a.1 - b.1).abs()) <= 1;
    for (spacing, smallest) in [(5i64, 3i64), (3, 2)] {
        for center in shuffled(&ground, &mut random) {
            if rough + changed >= target {
                break;
            }
            if !eligible(map, center.0, center.1) {
                continue;
            }
            if centers.iter().any(|other| (other.0 - center.0).abs() + (other.1 - center.1).abs() < spacing) {
                continue;
            }
            let Some(kind) = kinds.get(patch_index % kinds.len().max(1)).and_then(|name| open_rough(name)) else { continue };
            let size = (target - rough - changed).min(sizes.0 + (random() * (sizes.1 - sizes.0 + 1) as f64).floor() as i64);
            let mut cells: Vec<Cell> = vec![center];
            let mut taken: HashSet<Cell> = HashSet::from([center]);
            let mut guard = 0;
            while (cells.len() as i64) < size && guard < size * 8 {
                let from = cells[(random() * cells.len() as f64).floor() as usize];
                let (dx, dy) = DIRS[(random() * 4.0).floor() as usize];
                let next = (from.0 + dx, from.1 + dy);
                guard += 1;
                if taken.contains(&next) || !eligible(map, next.0, next.1) {
                    continue;
                }
                taken.insert(next);
                cells.push(next);
            }
            if (cells.len() as i64) < smallest.min(size) {
                continue;
            }
            centers.push(center);
            patch_index += 1;
            for point in &cells {
                tm::set_cell(map, point.0, point.1, &CellPatch { move_cost: Some(2.0), surface: kind.surface, ..CellPatch::default() })?;
            }
            changed += cells.len() as i64;
            let (any, _) = prop_cells(map);
            let same_near = |map: &TacticalMap, asset_id: &str, point: Cell| map.props.iter().any(|prop| prop.asset_id == asset_id && touching((prop.x.floor() as i64, prop.y.floor() as i64), point));
            let mut chosen: Vec<Cell> = Vec::new();
            let wanted = 3usize.min(cells.len().div_ceil(3));
            for point in shuffled(&cells, &mut random) {
                if chosen.len() >= wanted {
                    break;
                }
                if any.contains(&point) || chosen.iter().any(|other| touching(*other, point)) {
                    continue;
                }
                let mut decals: Vec<&str> = kind.decals.to_vec();
                decals.sort_by_key(|id| decal_counts.get(*id).copied().unwrap_or(0));
                let asset_id = decals[0];
                let count = decal_counts.get(asset_id).copied().unwrap_or(0);
                if asset_by_id(asset_id).is_none() || same_near(map, asset_id, point) || count as f64 >= js_max(4.0, map.props.len() as f64 * 0.2) {
                    continue;
                }
                chosen.push(point);
                decal_counts.insert(asset_id.to_string(), count + 1);
                let rotation = (random() * 4.0).floor() * 90.0;
                let scale = 0.9 + random() * 0.25;
                tm::add_prop(map, &decal_prop(&format!("open-rough-{patch_index}-{}", chosen.len()), asset_id, point.0 as f64 + 0.5, point.1 as f64 + 0.5, rotation, scale))?;
            }
            let Some(prop_asset) = kind.props.first().and_then(|id| asset_by_id(id)) else { continue };
            if random() < 0.5 {
                continue;
            }
            let width = js_max(1.0, prop_asset.base_footprint.w);
            let (fresh, _) = prop_cells(map);
            for point in shuffled(&cells, &mut random) {
                let footprint: Vec<Cell> = if width > 1.0 { vec![point, (point.0 + 1, point.1)] } else { vec![point] };
                if !footprint.iter().all(|cell| taken.contains(cell) && !fresh.contains(cell)) {
                    continue;
                }
                if same_near(map, &prop_asset.id, point) {
                    continue;
                }
                tm::add_prop(
                    map,
                    &asset_prop(&format!("open-rough-{patch_index}-{}", prop_asset.id), prop_asset, point.0 as f64 + width / 2.0, point.1 as f64 + 0.5, 0.0, 1.0, &footprint),
                )?;
                break;
            }
        }
    }
    Ok(changed as usize)
}

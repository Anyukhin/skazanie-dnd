//! Органическая пещера (`layoutOrganicCave`): узлы графа зон становятся
//! неровными залами, соединёнными вырубленным извилистым ходом. Полость
//! строится только добавлением пересекающихся дисков — связна по построению.

use serde_json::{json, Value};
use sk_core::indexmap::IndexSet;
use sk_core::{js, v8math};
use sk_tactical::tactical_map::{self as tm, CellPatch, EdgePatch, MapResult, Overlays, RoomLabel, TacticalMap, TacticalMapOptions};

use super::graph::scene_graph_for_theme;
use super::{clamp, random_for, Result, DIRS};

/// Размер и сид раскладки (`{ seed, width, height, locationId }`). Ширина и
/// высота — числа JS (дробные округляются, как `Math.round`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LayoutOptions<'a> {
    pub seed: &'a str,
    pub width: f64,
    pub height: f64,
    pub location_id: &'a str,
}

impl<'a> LayoutOptions<'a> {
    /// Умолчания JS: 26×26, без места.
    pub fn new(seed: &'a str) -> Self {
        Self { seed, width: 26.0, height: 26.0, location_id: "" }
    }
}

/// `Math.max(lower, Math.min(upper, Math.round(value)))`. Нечисловой размер
/// (в JS — `NaN` и вырожденная карта) берёт нижний предел.
pub(crate) fn safe_side(value: f64, lower: i64, upper: i64) -> i64 {
    let rounded = js::round(value);
    if rounded.is_nan() {
        return lower;
    }
    rounded.min(upper as f64).max(lower as f64) as i64
}

pub(crate) fn area_limits() -> tm::SizeClass {
    tm::size_class("area").unwrap_or(tm::SIZE_CLASSES[1].1)
}

pub(crate) fn arena_limits() -> tm::SizeClass {
    tm::size_class("arena").unwrap_or(tm::SIZE_CLASSES[0].1)
}

/// `theme.material` для заплатки клетки: `undefined` — поле не трогать.
pub(crate) fn theme_text(theme: &Value, key: &str) -> Option<String> {
    theme.get(key).map(|value| js::string(Some(value)))
}

/// `outlineImpassableCells(map)`: стены на рёбрах между полом и породой.
pub(crate) fn outline_impassable_cells(map: &mut TacticalMap) -> MapResult<()> {
    for y in 0..map.height {
        for x in 0..map.width {
            let Some(own) = tm::cell_at(map, x, y) else { continue };
            if own.passable {
                continue;
            }
            for (dx, dy) in DIRS {
                if tm::cell_passable(map, x + dx, y + dy) {
                    tm::set_edge(
                        map,
                        x,
                        y,
                        x + dx,
                        y + dy,
                        &EdgePatch { kind: Some("wall"), blocks_move: Some(true), blocks_sight: Some(true), cover: Some("three_quarters"), door_id: None },
                    )?;
                }
            }
        }
    }
    Ok(())
}

/// `layoutOrganicCave(theme, { seed, width, height, locationId })`.
pub fn layout_organic_cave(theme: &Value, options: &LayoutOptions<'_>) -> Result<TacticalMap> {
    let area = area_limits();
    let safe_width = safe_side(options.width, 16, area.max_width);
    let safe_height = safe_side(options.height, 16, area.max_height);
    let seed = options.seed;
    let theme_id = js::string(theme.get("id"));
    let mut random = random_for(&format!("cave:{theme_id}:{seed}"));
    let graph = scene_graph_for_theme(theme, seed)?;
    let theme_label = theme.get("id").and_then(Value::as_str).unwrap_or("");
    let mut map = tm::create_tactical_map(&TacticalMapOptions {
        width: safe_width,
        height: safe_height,
        location_id: options.location_id,
        seed,
        generator: Some(("theme-cave-organic", "2")),
        theme: theme_label,
        size_class: if safe_width * safe_height <= arena_limits().max_cells { "arena" } else { "area" },
        ..TacticalMapOptions::default()
    })?;
    let material = theme_text(theme, "material");
    let zone_count = graph.zones.len();
    for (index, zone) in graph.zones.iter().enumerate() {
        let light = if index == 0 {
            "dim"
        } else if index == zone_count - 1 {
            "dark"
        } else {
            "dim"
        };
        let mut record = json!({ "id": zone.id, "kind": "interior", "lightLevel": light, "floorDirection": "horizontal", "label": zone.label });
        if let (Some(object), Some(value)) = (record.as_object_mut(), theme.get("material")) {
            object.insert("material".into(), value.clone());
        }
        tm::add_zone(&mut map, &record)?;
    }
    let variant = |x: i64, y: i64| i64::from(tm::floor_variant_at(seed, x, y, tm::FLOOR_VARIANTS));
    for y in 0..safe_height {
        for x in 0..safe_width {
            tm::set_cell(
                &mut map,
                x,
                y,
                &CellPatch { passable: Some(false), material: material.as_deref(), variant: Some(variant(x, y)), revealed: Some(true), ..CellPatch::default() },
            )?;
        }
    }

    let mut floor: IndexSet<(i64, i64)> = IndexSet::new();
    let mut carve_disc = |random: &mut dyn FnMut() -> f64, cx: f64, cy: f64, radius: f64, to_edge: bool| {
        let reach = (radius + 0.5).ceil() as i64;
        for dy in -reach..=reach {
            for dx in -reach..=reach {
                let x = js::round(cx + dx as f64) as i64;
                let y = js::round(cy + dy as f64) as i64;
                let ragged = radius + random() * 0.9 - 0.45;
                if x < if to_edge { 0 } else { 1 } || y < 1 || x >= safe_width - 1 || y >= safe_height - 1 {
                    continue;
                }
                if v8math::hypot(dx as f64, dy as f64) <= ragged {
                    floor.insert((x, y));
                }
            }
        }
    };

    let count = graph.zones.len();
    let vertical_room = 2f64.max(7f64.min((safe_height as f64 * 0.26).floor()));
    let mut centers: Vec<(i64, i64)> = Vec::new();
    let pi = std::f64::consts::PI;
    let phase_base = pi * (0.35 + random() * 0.5);
    let phase = phase_base * if random() < 0.5 { 1.0 } else { -1.0 };
    for index in 0..count {
        let progress = if count <= 1 { 0.0 } else { index as f64 / (count - 1) as f64 };
        let x = js::round(3.0 + progress * (safe_width - 7) as f64) as i64;
        let wave = v8math::sin(progress * pi * 2.0 + phase + random() * 0.8) * vertical_room;
        let y = clamp(js::round(safe_height as f64 / 2.0 + wave + (random() - 0.5) * 3.0), 3.0, (safe_height - 4) as f64) as i64;
        centers.push((x, y));
        let chamber_radius = clamp(safe_width.min(safe_height) as f64 * (0.115 + random() * 0.035), 2.5, 5.0);
        carve_disc(&mut random, x as f64, y as f64, chamber_radius, false);
        let side = if random() < 0.5 { -1 } else { 1 };
        let nx = x + side * 1i64.max((chamber_radius * 0.65).floor() as i64);
        let ny = y + if random() < 0.5 { -1 } else { 1 };
        carve_disc(&mut random, nx as f64, ny as f64, chamber_radius * 0.62, false);
    }

    for index in 1..centers.len() {
        let target = centers[index];
        let (mut x, mut y) = centers[index - 1];
        let mut guard = safe_width * safe_height;
        while (x != target.0 || y != target.1) && guard > 0 {
            let radius = 1.45 + random() * 0.65;
            carve_disc(&mut random, x as f64, y as f64, radius, false);
            let dx = target.0 - x;
            let dy = target.1 - y;
            let horizontal_chance = dx.abs() as f64 / 1f64.max((dx.abs() + dy.abs()) as f64);
            if dx != 0 && (dy == 0 || random() < horizontal_chance) {
                x += dx.signum();
            } else if dy != 0 {
                y += dy.signum();
            }
            guard -= 1;
        }
        carve_disc(&mut random, target.0 as f64, target.1 as f64, 1.8, false);
    }

    let entrance_y = centers.first().map_or(safe_height.div_euclid(2), |center| center.1);
    let entrance_reach = centers.first().map_or(2, |center| center.0);
    for x in 0..=entrance_reach {
        carve_disc(&mut random, x as f64, entrance_y as f64, 1.35, true);
    }

    for (x, y) in floor.iter().copied() {
        let mut zone_index = 0;
        let mut nearest = i64::MAX;
        for (index, center) in centers.iter().enumerate() {
            let distance = (center.0 - x).abs() + (center.1 - y).abs();
            if distance < nearest {
                nearest = distance;
                zone_index = index;
            }
        }
        let zone = graph.zones.get(zone_index).or(graph.zones.first()).map_or("", |zone| zone.id.as_str());
        tm::set_cell(
            &mut map,
            x,
            y,
            &CellPatch { passable: Some(true), material: material.as_deref(), zone: Some(zone), variant: Some(variant(x, y)), revealed: Some(true), ..CellPatch::default() },
        )?;
    }

    outline_impassable_cells(&mut map)?;
    tm::add_spawn_point(&mut map, &json!({ "id": "party-entrance", "x": 1, "y": entrance_y, "role": "party" }))?;
    map.overlays = Overlays {
        compass: true,
        scale_bar: true,
        room_labels: graph.zones.iter().map(|zone| RoomLabel { zone_id: zone.id.clone(), label: zone.label.clone() }).collect(),
    };
    Ok(map)
}

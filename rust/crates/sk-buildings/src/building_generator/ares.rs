//! Авторская «Крепость Ареса»: внешний двор с тремя воротами и пять корпусов
//! вокруг него. Сид не меняет топологию — повторный вход отдаёт тот же двор,
//! двери и комнаты; меняются варианты пола и расстановка предметов.

use serde_json::{json, Value};
use sk_core::js;
use sk_props::prop_placement::{place_props, ZonePlacementPlan};
use sk_tactical::tactical_map::{self as tm, CellPatch, MapResult, TacticalMap, TacticalMapError, TacticalMapOptions, TacticalSpawnPoint};

use super::plan::{js_max, js_min};
use super::{edges_around, field, overlays_of, reachability_issues, tactical_fitness_warnings, text_or_empty, BuildingScene, EdgesAroundOptions, Rect, Result, ARES_FORTRESS_GENERATOR, ARES_FORTRESS_SIZE};

/// `paintFortressRoom(map, rect, zoneId, material)`: периметр — стена, внутри
/// — пол зоны.
fn paint_fortress_room(map: &mut TacticalMap, rect: Rect, zone_id: &str, material: &str) -> MapResult<()> {
    for y in rect.min_y..=rect.max_y {
        for x in rect.min_x..=rect.max_x {
            let border = x == rect.min_x || x == rect.max_x || y == rect.min_y || y == rect.max_y;
            let variant = i64::from(tm::floor_variant_at(&map.seed, x, y, tm::FLOOR_VARIANTS));
            let patch = CellPatch {
                passable: Some(!border),
                material: Some(if border { "stone" } else { material }),
                zone: Some(if border { "walls" } else { zone_id }),
                variant: Some(variant),
                ..CellPatch::default()
            };
            tm::set_cell(map, x, y, &patch)?;
        }
    }
    Ok(())
}

/// `addFortressDoor(map, door)`: закрытая дверь по выбранному ребру.
fn add_fortress_door(map: &mut TacticalMap, id: &str, x: i64, y: i64, dir: &str) -> MapResult<()> {
    tm::set_door(map, &json!({ "id": id, "x": x, "y": y, "dir": dir, "state": "closed", "blocksMove": false, "blocksSight": false }))?;
    Ok(())
}

/// `placeAresFortressProps(seed, map)`: смысловой план предметов крепости.
fn place_ares_fortress_props(seed: &str, map: &mut TacticalMap) -> MapResult<()> {
    let plans = json!([
        {
            "zoneId": "gallery", "purpose": "hall", "theme": "building", "density": 22,
            "require": ["table_small", "candelabra", "banner", "chair", "chandelier"],
            "prefer": ["table_small", "candelabra", "banner", "chair", "chandelier", "bookshelf"],
        },
        {
            "zoneId": "barracks", "purpose": "barracks", "theme": "building", "density": 24,
            "require": ["bunk_bed", "bunk_bed", "chest", "table_long", "bench"],
            "prefer": ["bunk_bed", "bed", "chest", "table_long", "bench", "bookshelf", "lantern_wall"],
        },
        {
            "zoneId": "stables", "purpose": "stable", "theme": "yard", "density": 22,
            "require": ["haystack", "water_trough", "hitching_post"],
            "prefer": ["haystack", "water_trough", "hitching_post", "woodpile", "lamp_post"],
        },
        {
            "zoneId": "storehouse", "purpose": "store", "theme": "building", "density": 30,
            "require": ["crate_stack", "barrel_stack", "chest", "shelf_wall"],
            "prefer": ["crate_stack", "barrel_stack", "crate", "barrel", "sack", "chest", "shelf_wall"],
        },
        {
            "zoneId": "workshop", "purpose": "workshop", "theme": "building", "density": 32,
            "require": ["crate", "barrel", "firewood_stack"],
            "prefer": ["crate", "barrel", "firewood_stack", "chest", "cauldron"],
        },
        {
            "zoneId": "exterior", "purpose": "exterior", "theme": "yard", "density": 6,
            "require": ["tree_oak", "bush", "boulder"],
            "prefer": ["tree_oak", "tree_pine", "tree_dead", "bush", "shrub", "boulder", "rock_small"],
        },
        {
            "zoneId": "courtyard", "purpose": "courtyard", "theme": "yard", "density": 8,
            "require": ["well", "water_trough", "woodpile", "lamp_post"],
            "prefer": ["well", "water_trough", "woodpile", "lamp_post", "campfire", "bush"],
        },
    ]);
    let zones: Vec<ZonePlacementPlan> = plans.as_array().map_or(&[][..], Vec::as_slice).iter().filter_map(ZonePlacementPlan::from_json).collect();
    let max_props = tm::size_class("area").map_or(0, |limits| limits.max_props);
    place_props(map, &format!("{seed}:props"), &zones, max_props)
}

/// `generateAresFortressScene(options)`: крепость Ареса; размер — не меньше
/// 36×36, не больше класса `area`.
pub fn generate_ares_fortress_scene(options: &Value) -> Result<TacticalMap> {
    let get = |key: &str| field(options, key);
    let seed = match get("seed") {
        None => "ares-fortress".to_string(),
        value => js::string(value),
    };
    let width = get("width").map_or(ARES_FORTRESS_SIZE.width as f64, |value| js::number(Some(value)));
    let height = get("height").map_or(ARES_FORTRESS_SIZE.height as f64, |value| js::number(Some(value)));
    let location_id = text_or_empty(get("locationId"), "");
    let theme = text_or_empty(get("theme"), "authored-palace");
    let with_props = get("withProps").is_none_or(|value| js::truthy(Some(value)));
    let area = tm::size_class("area").expect("класс area объявлен");
    let safe_width = js_max(36.0, js_min(area.max_width as f64, js::round(width)));
    let safe_height = js_max(36.0, js_min(area.max_height as f64, js::round(height)));
    // Размер не числом: JS строит карту 1×N или N×1 и падает на первой клетке
    // стены — тот же отказ.
    match (safe_width.is_nan(), safe_height.is_nan()) {
        (true, true) => return Err(TacticalMapError::new("Клетка NaN,13 вне границ карты", "CELL_OUT_OF_BOUNDS").into()),
        (true, false) | (false, true) => return Err(TacticalMapError::new("Клетка 3,3 вне границ карты", "CELL_OUT_OF_BOUNDS").into()),
        (false, false) => {}
    }
    let (safe_width, safe_height) = (safe_width as i64, safe_height as i64);
    let mut map = tm::create_tactical_map(&TacticalMapOptions {
        width: safe_width,
        height: safe_height,
        location_id: &location_id,
        seed: &seed,
        generator: Some((ARES_FORTRESS_GENERATOR.id, ARES_FORTRESS_GENERATOR.version)),
        theme: &theme,
        tileset_id: "fortress",
        size_class: "area",
        ..TacticalMapOptions::default()
    })?;
    for (id, kind, material, light, direction, label) in [
        ("courtyard", "exterior", "grass", "bright", "horizontal", "Большой внутренний двор"),
        ("exterior", "exterior", "grass", "bright", "horizontal", ""),
        ("gallery", "interior", "stone", "bright", "horizontal", "Военная галерея"),
        ("barracks", "interior", "wood", "dim", "vertical", "Казарма"),
        ("stables", "interior", "earth", "bright", "horizontal", "Конюшня"),
        ("storehouse", "interior", "wood", "dark", "vertical", "Военный склад"),
        ("workshop", "interior", "stone", "dim", "horizontal", "Мастерская"),
        ("walls", "interior", "stone", "dark", "horizontal", ""),
    ] {
        tm::add_zone(&mut map, &json!({ "id": id, "kind": kind, "material": material, "lightLevel": light, "floorDirection": direction, "label": label }))?;
    }
    for zone in map.zones.iter_mut() {
        if zone.kind == "interior" {
            zone.set_wall(Some("fortress".into()));
        }
    }
    let outer = Rect { min_x: 3, min_y: 3, max_x: safe_width - 4, max_y: safe_height - 4 };
    let courtyard = Rect { min_x: outer.min_x + 1, min_y: outer.min_y + 1, max_x: outer.max_x - 1, max_y: outer.max_y - 1 };
    let center_x = (outer.min_x + outer.max_x).div_euclid(2);
    for y in 0..safe_height {
        for x in 0..safe_width {
            let outside = x < outer.min_x || x > outer.max_x || y < outer.min_y || y > outer.max_y;
            let patch = CellPatch {
                passable: Some(true),
                material: Some("grass"),
                zone: Some(if outside { "exterior" } else { "" }),
                variant: Some(i64::from(tm::floor_variant_at(&seed, x, y, tm::FLOOR_VARIANTS))),
                revealed: Some(false),
                ..CellPatch::default()
            };
            tm::set_cell(&mut map, x, y, &patch)?;
        }
    }
    let floor = |material: &'static str, zone: &'static str| CellPatch { passable: Some(true), material: Some(material), zone: Some(zone), ..CellPatch::default() };
    for y in courtyard.min_y..=courtyard.max_y {
        for x in courtyard.min_x..=courtyard.max_x {
            tm::set_cell(&mut map, x, y, &floor("grass", "courtyard"))?;
        }
    }
    let wall = CellPatch { passable: Some(false), material: Some("stone"), zone: Some("walls"), ..CellPatch::default() };
    for x in outer.min_x..=outer.max_x {
        for y in [outer.min_y, outer.max_y] {
            tm::set_cell(&mut map, x, y, &wall)?;
        }
    }
    for y in outer.min_y..=outer.max_y {
        for x in [outer.min_x, outer.max_x] {
            tm::set_cell(&mut map, x, y, &wall)?;
        }
    }
    let share = |side: i64, factor: f64| js::round(side as f64 * factor) as i64;
    let gallery = Rect { min_x: share(safe_width, 0.28), min_y: 5, max_x: share(safe_width, 0.72), max_y: 13 };
    let barracks = Rect { min_x: 5, min_y: 16, max_x: share(safe_width, 0.28), max_y: (courtyard.max_y - 3).min(share(safe_height, 0.82)) };
    let stables = Rect { min_x: share(safe_width, 0.72), min_y: 16, max_x: safe_width - 6, max_y: barracks.max_y };
    let workshop_top = (courtyard.max_y - 5).min(share(safe_height, 0.72));
    let workshop_bottom = courtyard.max_y - 1;
    let storehouse = Rect { min_x: share(safe_width, 0.33), min_y: workshop_top, max_x: center_x, max_y: workshop_bottom };
    let workshop = Rect { min_x: center_x, min_y: workshop_top, max_x: share(safe_width, 0.67), max_y: workshop_bottom };
    let gallery_east_door_y = gallery.min_y + 4;
    let barracks_door_y = (barracks.min_y + barracks.max_y).div_euclid(2);
    let stables_door_y = (stables.min_y + stables.max_y).div_euclid(2);
    let storehouse_door_x = storehouse.min_x + 2;
    let workshop_door_x = workshop.min_x + 2;
    let store_workshop_door_y = (workshop_top + workshop_bottom).div_euclid(2);
    paint_fortress_room(&mut map, gallery, "gallery", "stone")?;
    paint_fortress_room(&mut map, barracks, "barracks", "wood")?;
    paint_fortress_room(&mut map, stables, "stables", "earth")?;
    paint_fortress_room(&mut map, storehouse, "storehouse", "wood")?;
    paint_fortress_room(&mut map, workshop, "workshop", "stone")?;
    // Проёмы в корпусах.
    for (x, y, material, zone) in [
        (center_x, gallery.max_y, "stone", "gallery"),
        (gallery.max_x, gallery_east_door_y, "stone", "gallery"),
        (barracks.max_x, barracks_door_y, "wood", "barracks"),
        (stables.min_x, stables_door_y, "earth", "stables"),
        (storehouse_door_x, storehouse.min_y, "wood", "storehouse"),
        (workshop_door_x, workshop.min_y, "stone", "workshop"),
        (center_x, store_workshop_door_y, "wood", "storehouse"),
    ] {
        tm::set_cell(&mut map, x, y, &floor(material, zone))?;
    }
    // Ворота: главный проезд и две боковые калитки.
    let side_gate_y = gallery.max_y + 1;
    for (x, y) in [(center_x, outer.max_y), (outer.min_x, side_gate_y), (outer.max_x, side_gate_y)] {
        tm::set_cell(&mut map, x, y, &floor("stone", "courtyard"))?;
    }
    for (x, y) in [(outer.min_x, outer.min_y), (outer.max_x, outer.max_y)] {
        tm::set_cell(&mut map, x, y, &floor("grass", "exterior"))?;
    }
    let stone_courtyard = |map: &mut TacticalMap, x: i64, y: i64| -> MapResult<()> {
        if tm::cell_at(map, x, y).is_some_and(|cell| cell.passable && cell.zone == "courtyard") {
            tm::set_cell(map, x, y, &CellPatch { material: Some("stone"), ..CellPatch::default() })?;
        }
        Ok(())
    };
    let vertical_path = |map: &mut TacticalMap, x: i64, from_y: i64, to_y: i64, half: i64| -> MapResult<()> {
        for y in from_y.min(to_y)..=from_y.max(to_y) {
            for dx in -half..=half {
                stone_courtyard(map, x + dx, y)?;
            }
        }
        Ok(())
    };
    let horizontal_path = |map: &mut TacticalMap, y: i64, from_x: i64, to_x: i64| -> MapResult<()> {
        for x in from_x.min(to_x)..=from_x.max(to_x) {
            stone_courtyard(map, x, y)?;
        }
        Ok(())
    };
    // Земляные карманы между дорожками.
    let pockets = [
        Rect { min_x: courtyard.min_x + 2, max_x: courtyard.min_x + 6, min_y: courtyard.min_y + 2, max_y: courtyard.min_y + 6 },
        Rect { min_x: courtyard.max_x - 6, max_x: courtyard.max_x - 2, min_y: courtyard.max_y - 6, max_y: courtyard.max_y - 2 },
    ];
    for pocket in pockets {
        for y in pocket.min_y..=pocket.max_y {
            for x in pocket.min_x..=pocket.max_x {
                if tm::cell_at(&map, x, y).is_some_and(|cell| cell.zone == "courtyard") {
                    tm::set_cell(&mut map, x, y, &CellPatch { material: Some("earth"), ..CellPatch::default() })?;
                }
            }
        }
    }
    vertical_path(&mut map, center_x, gallery.max_y + 1, courtyard.max_y, 1)?;
    horizontal_path(&mut map, gallery_east_door_y, center_x, gallery.max_x + 1)?;
    horizontal_path(&mut map, barracks_door_y, barracks.max_x + 1, center_x)?;
    horizontal_path(&mut map, stables_door_y, center_x, stables.min_x - 1)?;
    let workshop_path_y = workshop_top - 1;
    horizontal_path(&mut map, workshop_path_y, storehouse_door_x, workshop_door_x)?;
    vertical_path(&mut map, storehouse_door_x, workshop_path_y, storehouse.min_y - 1, 0)?;
    vertical_path(&mut map, workshop_door_x, workshop_path_y, workshop.min_y - 1, 0)?;
    // Внешние стены и корпуса: непроходимая клетка плюс ребро-стена.
    for y in 0..map.height {
        for x in 0..map.width {
            if !tm::cell_passable(&map, x, y) {
                edges_around(&mut map, x, y, "wall", &EdgesAroundOptions::default())?;
            }
        }
    }
    for (id, x, y, dir) in [
        ("gallery-courtyard-door", center_x, gallery.max_y, "s"),
        ("gallery-east-door", gallery.max_x, gallery_east_door_y, "e"),
        ("barracks-door", barracks.max_x, barracks_door_y, "e"),
        ("stables-door", stables.min_x - 1, stables_door_y, "e"),
        ("storehouse-door", storehouse_door_x, storehouse.min_y, "s"),
        ("workshop-door", workshop_door_x, workshop.min_y, "s"),
        ("storehouse-workshop-door", center_x, store_workshop_door_y, "e"),
        ("main-gate", center_x, outer.max_y - 1, "s"),
        ("west-sally", outer.min_x, side_gate_y, "e"),
        ("east-sally", outer.max_x - 1, side_gate_y, "e"),
    ] {
        add_fortress_door(&mut map, id, x, y, dir)?;
    }
    if with_props {
        place_ares_fortress_props(&seed, &mut map)?;
    }
    // Пролог начинается в галерее, у картографического стола.
    let in_gallery = |map: &TacticalMap, index: usize| map.props[index].footprint.iter().any(|cell| tm::cell_at(map, cell.x, cell.y).is_some_and(|own| own.zone == "gallery"));
    let table = (0..map.props.len())
        .find(|index| map.props[*index].asset_id == "table_long" && in_gallery(&map, *index))
        .or_else(|| (0..map.props.len()).find(|index| map.props[*index].asset_id == "table_small" && in_gallery(&map, *index)));
    if let Some(index) = table {
        map.props[index].id = "war-table".into();
    }
    let occupied: std::collections::HashSet<(i64, i64)> = map.props.iter().flat_map(|prop| prop.footprint.iter().map(|cell| (cell.x, cell.y))).collect();
    let mut gallery_cells: Vec<(i64, i64)> = Vec::new();
    for y in gallery.min_y + 1..gallery.max_y {
        for x in gallery.min_x + 1..gallery.max_x {
            if tm::cell_passable(&map, x, y) && !occupied.contains(&(x, y)) {
                gallery_cells.push((x, y));
            }
        }
    }
    let anchor = table.and_then(|index| map.props[index].footprint.first()).map_or((center_x, gallery.min_y + 3), |cell| (cell.x, cell.y));
    let distance = |cell: &(i64, i64)| (cell.0 - anchor.0).abs() + (cell.1 - anchor.1).abs();
    gallery_cells.sort_by_key(|cell| (distance(cell), cell.0, cell.1));
    let party = gallery_cells.first().copied().unwrap_or((center_x, gallery.min_y + 2));
    map.spawn_points.push(TacticalSpawnPoint { id: "party-war-gallery".into(), x: party.0, y: party.1, role: "party".into() });
    let king = gallery_cells.iter().skip(1).find(|cell| distance(cell) > 0).copied().unwrap_or(party);
    map.spawn_points.push(TacticalSpawnPoint { id: "king-war-gallery".into(), x: king.0, y: king.1, role: "neutral".into() });
    // План крепости известен приглашённой партии.
    for rect in [courtyard, gallery] {
        for y in rect.min_y..=rect.max_y {
            for x in rect.min_x..=rect.max_x {
                if tm::cell_at(&map, x, y).is_some() {
                    tm::set_cell(&mut map, x, y, &CellPatch { revealed: Some(true), ..CellPatch::default() })?;
                }
            }
        }
    }
    map.overlays = overlays_of(&map);
    Ok(map)
}

/// `buildAresFortressScene(options)`: крепость с тем же отчётом, что у сборки
/// здания: предупреждения — коды проверки, недостижимые помещения и
/// тактическая пригодность.
pub fn build_ares_fortress_scene(options: &Value) -> Result<BuildingScene> {
    let map = generate_ares_fortress_scene(options)?;
    let report = tm::validate_tactical_map(&map);
    let warnings = report.errors.iter().map(|issue| issue.code.clone()).chain(reachability_issues(&map)).chain(tactical_fitness_warnings(&map)).collect();
    Ok(BuildingScene { map, fallback: "none", warnings })
}

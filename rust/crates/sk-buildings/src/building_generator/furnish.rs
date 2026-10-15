//! Обстановка здания: заявки расстановки по назначению комнат, четверти
//! главного помещения и добивка пустой четверти мебелью.

use std::collections::HashSet;

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexSet;
use sk_core::{js, re, text, Point};
use sk_props::prop_placement::ZonePlacementPlan;
use sk_scene_base::asset_registry::{asset_by_id, AssetEntry};
use sk_tactical::tactical_map::{self as tm, TacticalMap};

use super::plan::{seed_hash, Design};
use super::{Result, RoomPlan, DIRS};

/// С какой площади помещение здания получает опоры под крышу.
pub(crate) const ROOF_POST_HALL_CELLS: usize = 240;

/// Четверть помещения от стольких клеток пола обязана быть обставлена.
pub const FURNISHED_QUARTER_CELLS: usize = 9;

/// Чем обставляется пустая четверть (`QUARTER_FURNITURE`): предмет и спутник.
fn quarter_furniture(use_: &str) -> (&'static str, &'static str) {
    match use_ {
        "dwelling" | "manor" | "barracks" => ("table_small", "chair"),
        "shop" | "smithy" => ("crate", "barrel"),
        "mill" => ("sack", "barrel"),
        _ => ("table_small", "stool"),
    }
}

/// Потолки предметов участка (`caps` заявки `yard`) в порядке ключей JS.
const YARD_CAPS: [(&str, i64); 15] = [
    ("water_trough", 1),
    ("boulder", 3),
    ("rock_small", 4),
    ("barrel", 2),
    ("woodpile", 2),
    ("rain_barrel", 2),
    ("flower_bed", 2),
    ("garden_bed", 3),
    ("hay_bales", 1),
    ("chicken_coop", 1),
    ("scarecrow", 1),
    ("tree_stump", 2),
    ("cart", 1),
    ("well", 1),
    ("hitching_post", 2),
];

fn strings(items: &[&str]) -> Value {
    Value::Array(items.iter().map(|item| Value::String((*item).into())).collect())
}

/// `designPropPlans(design, rooms, includeDecorativeTransition)`: заявки
/// расстановки объектами JS — в той же форме, что `placeProps` получает в JS.
pub(crate) fn design_prop_plans_json(design: &Design, rooms: &[RoomPlan], include_decorative_transition: bool) -> Vec<Value> {
    let has = |zone_id: &str| rooms.iter().any(|room| room.zone_id == zone_id);
    let factor = match design.density {
        "sparse" => 0.65,
        "dense" => 1.3,
        _ => 1.0,
    };
    let mut plans: Vec<Value> = Vec::new();
    let mut add = |zone_id: &str, purpose: &str, require: &[&str], prefer: &[&str], theme: &str, density: f64, caps: Option<&[(&str, i64)]>| {
        if !(has(zone_id) || zone_id == "yard") {
            return;
        }
        let mut plan = Map::new();
        plan.insert("zoneId".into(), Value::String(zone_id.into()));
        plan.insert("purpose".into(), Value::String(purpose.into()));
        plan.insert("theme".into(), Value::String(theme.into()));
        plan.insert("density".into(), js::num(js::round(density * factor)));
        plan.insert("require".into(), strings(require));
        plan.insert("prefer".into(), strings(prefer));
        if let Some(caps) = caps {
            plan.insert("caps".into(), Value::Object(caps.iter().map(|(key, cap)| ((*key).to_string(), Value::from(*cap))).collect()));
        }
        plans.push(Value::Object(plan));
    };
    let interior = "interior";
    match design.use_ {
        "tavern" => {
            let mut hall_required = vec!["bar_counter", "bar_shelf", "fireplace", "table_round", "table_small", "table_long", "chandelier", "lantern_wall"];
            if include_decorative_transition {
                hall_required.push("stairs_up");
            }
            add("hall", "hall", &hall_required, &["table_round", "table_small", "table_long", "fireplace", "bar_counter", "bar_shelf"], interior, 26.0, None);
            add("kitchen", "kitchen", &["cupboard", "barrel", "crate", "shelf_wall"], &["cupboard", "barrel", "crate", "shelf_wall"], interior, 24.0, None);
            add("store", "store", &["crate_stack", "barrel_stack", "sack", "chest"], &["crate_stack", "barrel_stack", "sack", "chest"], interior, 28.0, None);
        }
        "shop" => {
            add("hall", "shop", &["chest", "lantern_wall"], &["table_small", "chair", "shelf_wall"], interior, 25.0, None);
            add("store", "store", &["crate_stack", "barrel_stack", "sack", "chest"], &["crate_stack", "barrel_stack", "sack", "chest"], interior, 30.0, None);
            add("workshop", "workshop", &["table_long", "shelf_wall", "crate"], &["table_long", "shelf_wall", "crate", "barrel", "chest"], interior, 28.0, None);
        }
        "smithy" => {
            add("hall", "forge", &["firewood_stack", "barrel"], &["bucket", "crate", "shelf_wall", "firewood_stack", "chest"], interior, 26.0, None);
            add("store", "store", &["crate_stack", "barrel", "chest"], &["crate_stack", "barrel", "sack", "crate"], interior, 26.0, None);
            add("bedroom", "bedroom", &["bed", "chest"], &["bed", "chest", "night_table"], interior, 24.0, None);
        }
        "barracks" => {
            add("hall", "guardroom", &["table_long", "bench", "chest", "torch_wall"], &["table_long", "bench", "chair", "banner", "barrel"], interior, 24.0, None);
            add("barracks", "barracks", &["bunk_bed", "bunk_bed", "chest"], &["bunk_bed", "chest", "washbasin"], interior, 30.0, None);
            add("armory", "store", &["chest", "crate_stack", "barrel"], &["chest", "crate", "barrel", "shelf_wall"], interior, 28.0, None);
        }
        "mill" => {
            add("hall", "mill", &["sack", "sack", "barrel"], &["sack", "crate", "barrel", "barrel_stack", "basket"], interior, 26.0, None);
            add("store", "store", &["sack", "crate_stack"], &["sack", "crate", "barrel"], interior, 26.0, None);
            add("bedroom", "bedroom", &["bed", "chest"], &["bed", "chest", "table_small", "chair"], interior, 24.0, None);
        }
        "dwelling" => {
            add("hall", "living", &["fireplace", "table_small", "chair", "lantern_wall"], &["table_small", "chair", "fireplace", "rug"], interior, 23.0, None);
            add("bedroom", "bedroom", &["bed", "wardrobe", "night_table", "chest"], &["bed", "wardrobe", "night_table", "chest", "candle"], interior, 28.0, None);
            add("kitchen", "kitchen", &["fireplace", "cupboard", "crate"], &["fireplace", "cupboard", "cauldron", "crate", "shelf_wall"], interior, 25.0, None);
            add("store", "store", &["crate_stack", "barrel_stack", "sack", "chest"], &["crate_stack", "barrel_stack", "sack", "chest"], interior, 25.0, None);
        }
        _ => {
            add("hall", "dining", &["fireplace", "candelabra"], &["table_small", "chair", "candelabra", "chandelier"], interior, 25.0, None);
            if design.arcane {
                add("salon", "laboratory", &["candelabra"], &["candle", "rug"], interior, 24.0, None);
            } else {
                add("salon", "hall", &["table_small", "chair", "candelabra"], &["table_small", "chair", "candelabra", "rug"], interior, 22.0, None);
            }
            add("kitchen", "kitchen", &["fireplace", "cupboard", "crate"], &["fireplace", "cupboard", "cauldron", "crate", "shelf_wall"], interior, 25.0, None);
            add("store", "store", &["crate_stack", "barrel_stack", "chest"], &["crate_stack", "barrel_stack", "sack", "chest"], interior, 28.0, None);
        }
    }
    for room in rooms {
        if text::test(re!(r"^bedroom-\d+$", "u"), &room.zone_id) {
            add(&room.zone_id, "bedroom", &["bed", "chest"], &["bed", "chest", "night_table", "wardrobe", "candle"], interior, 26.0, None);
        }
        if text::test(re!(r"^guest-\d+$", "u"), &room.zone_id) {
            add(&room.zone_id, "bedroom", &["bed", "night_table"], &["bed", "chest", "night_table", "washbasin", "candle"], interior, 26.0, None);
        }
    }
    add("study", if design.arcane { "laboratory" } else { "study" }, &["chair"], &["bookshelf", "chest", "candle", "rug"], interior, 24.0, None);
    add("corridor", "corridor", &["lantern_wall"], &["lantern_wall", "banner", "chest"], interior, 6.0, None);
    add("courtyard", "courtyard", &["well", "cart"], &["well", "cart", "woodpile", "bush", "tree_oak", "tree_birch"], "yard", 14.0, None);
    let yard_require: &[&str] = match design.climate {
        "arid" => &["tree_dead"],
        "cold" => &["tree_pine", "woodpile"],
        _ => &["tree_oak", "woodpile"],
    };
    let yard_by_use: &[&str] = match design.use_ {
        "tavern" => &["hitching_post", "water_trough"],
        "dwelling" | "mill" => &["garden_bed"],
        "manor" => &["flower_bed"],
        _ => &[],
    };
    let mut require: Vec<&str> = yard_require.to_vec();
    if design.climate != "arid" {
        require.extend_from_slice(yard_by_use);
    }
    add(
        "yard",
        "exterior",
        &require,
        &["tree_oak", "tree_birch", "tree_pine", "bush", "boulder", "woodpile", "water_trough", "barrel", "flowers", "shrub", "tree_stump", "rain_barrel", "flower_bed", "garden_bed", "hay_bales", "chicken_coop"],
        "yard",
        if design.climate == "arid" { 4.0 } else { 6.0 },
        Some(&YARD_CAPS),
    );
    drop(add);
    if let Some(yard) = plans.iter_mut().find(|plan| plan["zoneId"] == "yard") {
        js::assign(yard, json!({ "extraThemes": ["farm"] }));
    }
    plans
}

/// Заявки расстановки в форме `placeProps` Rust.
pub(crate) fn design_prop_plans(design: &Design, rooms: &[RoomPlan], include_decorative_transition: bool) -> Vec<ZonePlacementPlan> {
    design_prop_plans_json(design, rooms, include_decorative_transition).iter().filter_map(ZonePlacementPlan::from_json).collect()
}

/// `roomQuarters(map, zoneId)`: клетки пола зоны по четвертям габарита —
/// северо-запад, северо-восток, юго-запад, юго-восток. Пустая зона — пусто.
pub fn room_quarters(map: &TacticalMap, zone_id: &str) -> Vec<Vec<Point>> {
    let cells: Vec<Point> = tm::cells(map).filter(|cell| cell.passable && cell.zone == zone_id).map(|cell| Point::new(cell.x, cell.y)).collect();
    if cells.is_empty() {
        return Vec::new();
    }
    let min_x = cells.iter().map(|cell| cell.x).min().unwrap_or(0);
    let max_x = cells.iter().map(|cell| cell.x).max().unwrap_or(0);
    let min_y = cells.iter().map(|cell| cell.y).min().unwrap_or(0);
    let max_y = cells.iter().map(|cell| cell.y).max().unwrap_or(0);
    let middle_x = (min_x + max_x) as f64 / 2.0;
    let middle_y = (min_y + max_y) as f64 / 2.0;
    let mut quarters = vec![Vec::new(), Vec::new(), Vec::new(), Vec::new()];
    for cell in cells {
        let index = usize::from(cell.x as f64 > middle_x) + if cell.y as f64 > middle_y { 2 } else { 0 };
        quarters[index].push(cell);
    }
    quarters
}

/// Четверти в форме JS: `[[{ x, y }, …], …]`.
pub fn quarters_json(quarters: &[Vec<Point>]) -> Value {
    Value::Array(quarters.iter().map(|quarter| Value::Array(quarter.iter().map(|cell| json!({ "x": cell.x, "y": cell.y })).collect())).collect())
}

/// `furnishedCells(map)`: клетки под стоящей мебелью — футпринт предметов
/// без опоры (`mount`), в порядке обхода JS.
pub fn furnished_cells(map: &TacticalMap) -> IndexSet<(i64, i64)> {
    let mut cells = IndexSet::new();
    for prop in map.props.iter().filter(|prop| prop.mount.is_none()) {
        for point in &prop.footprint {
            cells.insert((point.x, point.y));
        }
    }
    cells
}

fn footprints(map: &TacticalMap, blocking_only: bool) -> HashSet<(i64, i64)> {
    map.props
        .iter()
        .filter(|prop| prop.mount.is_none() && (!blocking_only || prop.blocks_move))
        .flat_map(|prop| prop.footprint.iter().map(|point| (point.x, point.y)))
        .collect()
}

/// `furnishEmptyQuarters(map, zoneId, use, seed)`: пустая четверть главного
/// помещения получает предмет по назначению и спутника рядом — ближе к
/// середине четверти, не у двери и не отрезая пол. Возвращает, сколько
/// предметов поставлено.
pub(crate) fn furnish_empty_quarters(map: &mut TacticalMap, zone_id: &str, use_: &str, seed: &str) -> Result<usize> {
    let (main_id, companion_id) = quarter_furniture(use_);
    let mut near_doors: HashSet<(i64, i64)> = HashSet::new();
    for door in &map.doors {
        for (x, y) in [(door.x, door.y), tm::edge_neighbor(door.x, door.y, door.dir)] {
            for (dx, dy) in [(0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)] {
                near_doors.insert((x + dx, y + dy));
            }
        }
    }
    let reach_count = |map: &TacticalMap, from: (i64, i64), blocked: &HashSet<(i64, i64)>| tm::reachable_cells(map, from.0, from.1, true, Some(blocked)).len() as i64;
    let mut placed = 0;
    for (index, quarter) in room_quarters(map, zone_id).iter().enumerate() {
        let furnished = furnished_cells(map);
        let quarter: Vec<(i64, i64)> = quarter.iter().map(|cell| (cell.x, cell.y)).collect();
        if quarter.len() < FURNISHED_QUARTER_CELLS || quarter.iter().any(|cell| furnished.contains(cell)) {
            continue;
        }
        let taken = footprints(map, false);
        let length = quarter.len() as f64;
        let center_x = quarter.iter().map(|cell| cell.0).sum::<i64>() as f64 / length;
        let center_y = quarter.iter().map(|cell| cell.1).sum::<i64>() as f64 / length;
        let mut free: Vec<(i64, i64)> = quarter.iter().copied().filter(|cell| !taken.contains(cell) && !near_doors.contains(cell)).collect();
        let tie = |cell: &(i64, i64)| f64::from(seed_hash(&format!("{seed}:quarter:{},{}", cell.0, cell.1)));
        crate::v8_sort::sort_by(&mut free, |left, right| {
            let distance = (left.0 as f64 - center_x).abs() + (left.1 as f64 - center_y).abs() - (right.0 as f64 - center_x).abs() - (right.1 as f64 - center_y).abs();
            if distance != 0.0 {
                distance
            } else {
                tie(left) - tie(right)
            }
        });
        for cell in &free {
            let Some(asset) = asset_by_id(main_id) else { break };
            let blocked = footprints(map, true);
            let anchor = free.iter().find(|other| *other != cell).or_else(|| quarter.iter().find(|other| *other != cell)).copied();
            if let Some(anchor) = anchor.filter(|_| asset.blocks_move) {
                let before = reach_count(map, anchor, &blocked);
                let mut with_cell = blocked.clone();
                with_cell.insert(*cell);
                if reach_count(map, anchor, &with_cell) != before - 1 {
                    continue;
                }
            }
            add_furniture(map, asset, *cell, &format!("quarter-{zone_id}-{index}"))?;
            placed += 1;
            let companion = asset_by_id(companion_id);
            let occupied = footprints(map, false);
            let besides = DIRS.iter().map(|(dx, dy)| (cell.0 + dx, cell.1 + dy)).find(|point| {
                tm::cell_at(map, point.0, point.1).is_some_and(|near| near.passable && near.zone == zone_id) && !occupied.contains(point) && !near_doors.contains(point)
            });
            if let (Some(companion), Some(besides)) = (companion, besides) {
                if !companion.blocks_move {
                    add_furniture(map, companion, besides, &format!("quarter-{zone_id}-{index}-companion"))?;
                    placed += 1;
                }
            }
            break;
        }
    }
    Ok(placed)
}

/// `addFurniture(map, asset, cell, id)`: предмет каталога в одну клетку —
/// масштаб посредине разброса, укрытие и прочность из реестра.
fn add_furniture(map: &mut TacticalMap, asset: &AssetEntry, cell: (i64, i64), id: &str) -> Result<()> {
    let span = asset.scale_range.max - asset.scale_range.min;
    let scale = js::parse_number(&js::to_fixed(asset.scale_range.min + span / 2.0, 3));
    let prop = json!({
        "id": id, "assetId": asset.id, "x": js::num(cell.0 as f64 + 0.5), "y": js::num(cell.1 as f64 + 0.5), "rotation": 0,
        "scale": js::num(scale), "footprint": [{ "x": cell.0, "y": cell.1 }], "zOrder": 0,
        "blocksMove": asset.blocks_move, "blocksSight": asset.blocks_sight, "cover": asset.cover,
        "destructible": asset.destructible, "hp": js::num(asset.hp), "interactive": asset.interactive,
    });
    tm::add_prop(map, &prop)?;
    Ok(())
}

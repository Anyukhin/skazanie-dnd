//! Планировка здания: назначение и замысел, программа площадей, размер
//! корпуса, форма корпуса и раскрой на помещения по схеме (боковое крыло,
//! длинный зал, внутренний двор, коридор). Чистые функции, карты не трогают.

use serde_json::{Map, Value};
use sk_core::{js, re, text};

use super::{Rect, RoomPlan};

/// Назначения здания (`BUILDING_USES`).
pub const BUILDING_USES: [&str; 7] = ["dwelling", "tavern", "shop", "manor", "smithy", "barracks", "mill"];
/// Климаты (`BUILDING_CLIMATES`).
pub const BUILDING_CLIMATES: [&str; 4] = ["temperate", "arid", "cold", "wetland"];
/// Материалы постройки (`BUILDING_ARCHITECTURES`).
pub const BUILDING_ARCHITECTURES: [&str; 6] = ["wood", "stone", "sand", "metal", "marble", "ice"];
/// Схемы планировки (`BUILDING_SCHEMES`) в порядке JS.
pub const BUILDING_SCHEMES: [&str; 4] = ["wing", "long-hall", "courtyard", "corridor"];
/// Формы корпуса (`BUILDING_SHAPES`).
pub const BUILDING_SHAPES: [&str; 4] = ["rect", "L", "cross", "round"];
const DENSITIES: [&str; 3] = ["sparse", "mixed", "dense"];

/// `buildingSeedHash(value)`: FNV-1a по кодовым точкам строки, `>>> 0`.
pub(crate) fn seed_hash(text: &str) -> u32 {
    let mut hash: u32 = 2_166_136_261;
    for character in text.chars() {
        hash ^= character as u32;
        hash = hash.wrapping_mul(16_777_619);
    }
    hash
}

/// `buildingSeedHash(\`${seed}:${salt}\`)`.
pub(crate) fn salted(seed: &str, salt: &str) -> u32 {
    seed_hash(&format!("{seed}:{salt}"))
}

/// `Math.max(a, b)` JS: `NaN` заразен.
pub(crate) fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b {
        a
    } else {
        b
    }
}

/// `Math.min(a, b)` JS: `NaN` заразен.
pub(crate) fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b {
        a
    } else {
        b
    }
}

/// `Math.floor(value * factor)` для целого: умножение в дробях, как в JS.
pub(crate) fn floor_mul(value: i64, factor: f64) -> i64 {
    (value as f64 * factor).floor() as i64
}

// --- назначение и замысел ----------------------------------------------------------

/// Служебные комнаты коридорной планировки (`CORRIDOR_ROOMS`): по убыванию нужды.
pub(crate) fn corridor_rooms(use_: &str) -> Option<&'static [&'static str]> {
    match use_ {
        "dwelling" => Some(&["kitchen", "bedroom", "bedroom-2", "store", "bedroom-3"]),
        "tavern" => Some(&["kitchen", "store", "guest-1", "guest-2", "guest-3", "guest-4"]),
        "manor" => Some(&["salon", "kitchen", "study", "bedroom", "store", "bedroom-2"]),
        _ => None,
    }
}

/// Служебные комнаты рядом с залом (`WING_ROOMS`); первая — у фасада.
pub(crate) fn wing_rooms(use_: &str) -> &'static [&'static str] {
    match use_ {
        "dwelling" => &["kitchen", "bedroom", "store"],
        "manor" => &["kitchen", "salon", "store"],
        "shop" => &["workshop", "store"],
        "barracks" => &["barracks", "armory"],
        "smithy" | "mill" => &["store", "bedroom"],
        _ => &["kitchen", "store"],
    }
}

/// Программа здания (`BUILDING_PROGRAMS`): площадь главного помещения в
/// клетках плана и сторона служебной комнаты — диапазоны.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Program {
    pub hall: (i64, i64),
    pub room: (i64, i64),
}

pub(crate) fn program(use_: &str) -> Program {
    let (hall, room) = match use_ {
        "shop" => ((18, 24), (3, 3)),
        "dwelling" => ((20, 28), (3, 3)),
        "manor" => ((34, 42), (3, 4)),
        "smithy" => ((26, 34), (3, 3)),
        "barracks" => ((28, 36), (3, 4)),
        "mill" => ((28, 36), (3, 3)),
        _ => ((32, 40), (3, 3)),
    };
    Program { hall, room }
}

/// `hallInteriorCap(use)`: предел площади главного помещения.
pub(crate) fn hall_interior_cap(use_: &str) -> i64 {
    program(use_).hall.1 + 4
}

/// Нормализованный замысел здания (`normalizeBuildingDesign`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Design {
    pub use_: &'static str,
    pub climate: &'static str,
    pub architecture: &'static str,
    pub density: &'static str,
    pub arcane: bool,
}

/// `normalizeBuildingDesign(design)`: поле из набора — как есть
/// (`String(source[key] ?? '')`), иначе запас. Не объект — пустой замысел.
pub(crate) fn normalize_design(design: &Map<String, Value>) -> Design {
    let pick = |key: &str, allowed: &[&'static str], fallback: &'static str| -> &'static str {
        let value = js::s(design.get(key));
        allowed.iter().find(|item| **item == value).copied().unwrap_or(fallback)
    };
    Design {
        use_: pick("building_use", &BUILDING_USES, "tavern"),
        climate: pick("climate", &BUILDING_CLIMATES, "temperate"),
        architecture: pick("architecture", &BUILDING_ARCHITECTURES, "wood"),
        density: pick("density", &DENSITIES, "mixed"),
        arcane: js::is_true(design.get("arcane")),
    }
}

/// `defaultBuildingDesignForTheme(theme)`: замысел старых тем по словам.
pub(crate) fn default_design_for_theme(theme: Option<&Value>) -> Value {
    let value = text::lower(&js::s(theme));
    let use_ = if text::test(re!(r"shop|market|merchant|store|магазин|рынок", "u"), &value) {
        "shop"
    } else if text::test(re!(r"manor|estate|palace|усадь|помест|дворец", "u"), &value) {
        "manor"
    } else if text::test(re!(r"house|home|dwelling|cottage|дом|жилищ", "u"), &value) {
        "dwelling"
    } else {
        "tavern"
    };
    let mut design = Map::new();
    design.insert("building_use".into(), Value::String(use_.into()));
    design.insert("climate".into(), Value::String("temperate".into()));
    design.insert("architecture".into(), Value::String("wood".into()));
    Value::Object(design)
}

/// Подпись помещения (`DESIGN_ROOM_LABELS`).
fn label_of(zone_id: &str) -> Option<&'static str> {
    Some(match zone_id {
        "hall" => "Общий зал",
        "kitchen" => "Кухня",
        "store" => "Кладовая",
        "bedroom" => "Спальня",
        "salon" => "Салон",
        "workshop" => "Мастерская",
        "courtyard" => "Внутренний двор",
        "barracks" => "Спальня стражи",
        "armory" => "Оружейная",
        "corridor" => "Коридор",
        "study" => "Кабинет",
        "guest" => "Гостевая комната",
        _ => return None,
    })
}

/// `designRoomLabel(zoneId)`: `bedroom-2` — та же спальня, `guest-3` — гостевая.
pub(crate) fn design_room_label(zone_id: &str) -> String {
    if let Some(label) = label_of(zone_id) {
        return label.to_string();
    }
    let base = text::replace_first(re!(r"-\d+$", "u"), zone_id, "");
    label_of(&base).map_or_else(|| zone_id.to_string(), str::to_string)
}

/// Подпись главного помещения по назначению (`HALL_LABELS`).
pub(crate) fn hall_label(use_: &str) -> &'static str {
    match use_ {
        "dwelling" => "Горница",
        "shop" => "Торговый зал",
        "manor" => "Парадный зал",
        "smithy" => "Кузня",
        "barracks" => "Караульная",
        "mill" => "Мельница",
        _ => "Общий зал",
    }
}

/// `designMaterialFor(architecture, roomId, yardMaterial)`.
pub(crate) fn design_material_for(architecture: &'static str, room_id: &str, yard_material: &'static str) -> &'static str {
    if room_id == "courtyard" {
        return yard_material;
    }
    if BUILDING_ARCHITECTURES.contains(&architecture) {
        architecture
    } else {
        "wood"
    }
}

// --- корпус --------------------------------------------------------------------------

/// `buildingShapeFor(design, seed, use, building)`: явная просьба сильнее
/// сида и двора; без неё — бросок по сиду. Ширина и высота корпуса — в дробях:
/// у оценки корпуса они дробные, если дробный размер карты.
pub(crate) fn building_shape_for(design: &Map<String, Value>, seed: &str, use_: &str, width: f64, height: f64) -> &'static str {
    let asked = js::s(design.get("shape"));
    if let Some(shape) = BUILDING_SHAPES.iter().find(|shape| **shape == asked) {
        return shape;
    }
    if design.get("topology").and_then(Value::as_str) == Some("courtyard") {
        return "rect";
    }
    let roll = salted(seed, "shape") % 100;
    let least = js_min(width, height);
    if use_ == "manor" && roll < 25 && least >= 14.0 {
        return "round";
    }
    if roll < 45 {
        return "rect";
    }
    if roll < 82 {
        return "L";
    }
    if least >= 14.0 {
        "cross"
    } else {
        "L"
    }
}

/// `buildingFootprintFor(seed, use, scheme, { width, height, minimum, shape })`:
/// размер корпуса с наружной стеной. Числа — дроби JS: размер карты оценки
/// бывает дробным и бесконечным.
pub(crate) fn building_footprint_for(seed: &str, use_: &str, scheme: Option<&str>, map_width: f64, map_height: f64, minimum: f64, shape: &str) -> (f64, f64) {
    let program = program(use_);
    let pick = |(from, to): (i64, i64), salt: &str| -> f64 { (from + i64::from(salted(seed, salt)) % (to - from + 1)) as f64 };
    let hall = pick(program.hall, "hall-area");
    let room = pick(program.room, "room-size");
    let count = wing_rooms(use_).len() as f64;
    let fits = |plan_width: f64, plan_height: f64| plan_width + 2.0 <= map_width - 4.0 && plan_height + 2.0 <= map_height - 4.0;
    let corridor_width = (hall_interior_cap(use_) as f64 / 5.0).floor() + 10.0;
    let (width, height);
    if scheme == Some("corridor") && corridor_rooms(use_).is_some() && fits(corridor_width, 11.0) {
        width = corridor_width;
        height = pick((11, 12), "height");
    } else if scheme == Some("courtyard") && fits(11.0, if count > 2.0 { 11.0 } else { 9.0 }) {
        width = 11.0;
        height = if count > 2.0 { pick((11, 12), "height") } else { pick((9, 10), "height") };
    } else if scheme == Some("long-hall") {
        let room_width = room + if count < 3.0 { pick((0, 1), "room-width") } else { 0.0 };
        width = count * room_width + count - 1.0;
        height = js_max(3.0, js::round(hall / width)) + 1.0 + room;
    } else {
        height = count * room + count - 1.0;
        width = js_max(3.0, js::round(hall / height)) + 1.0 + room + pick((0, 1), "side-width");
    }
    if shape == "cross" || shape == "round" {
        let share = |side: f64, salt: &str| js::round(side * (0.52 + f64::from(salted(seed, salt) % 4) * 0.05));
        return (js_max(minimum, js_min(map_width - 4.0, share(map_width, "width"))), js_max(minimum, js_min(map_height - 4.0, share(map_height, "height"))));
    }
    (js_min(map_width - 4.0, js_max(minimum, width + 2.0)), js_min(map_height - 4.0, js_max(minimum, height + 2.0)))
}

// --- раскрой на помещения --------------------------------------------------------------

/// `planRooms(interior)`: прежняя трёхкомнатная схема — зал и две комнаты.
/// Нужна генератору этажей: верхний этаж режется той же логикой.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoomsPlan {
    pub rooms: Vec<RoomPlan>,
    pub partition_x: i64,
    pub partition_y: i64,
}

impl RoomsPlan {
    /// Форма JS: `{ partitionX, partitionY, rooms }`.
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("partitionX".into(), Value::from(self.partition_x));
        object.insert("partitionY".into(), Value::from(self.partition_y));
        object.insert("rooms".into(), Value::Array(self.rooms.iter().map(RoomPlan::to_json).collect()));
        Value::Object(object)
    }
}

/// `planRooms(interior)`.
pub fn plan_rooms(interior: Rect) -> RoomsPlan {
    let partition_x = js::round(interior.min_x as f64 + (interior.max_x - interior.min_x) as f64 * 0.62) as i64;
    let partition_y = js::round(interior.min_y as f64 + (interior.max_y - interior.min_y) as f64 * 0.5) as i64;
    RoomsPlan {
        partition_x,
        partition_y,
        rooms: vec![
            RoomPlan::new("hall", interior.min_x, interior.min_y, partition_x - 1, interior.max_y),
            RoomPlan::new("kitchen", partition_x + 1, interior.min_y, interior.max_x, partition_y - 1),
            RoomPlan::new("store", partition_x + 1, partition_y + 1, interior.max_x, interior.max_y),
        ],
    }
}

/// `designRoomIsUsable(room)`.
fn usable(room: &RoomPlan) -> bool {
    room.max_x - room.min_x >= 2 && room.max_y - room.min_y >= 2
}

/// `splitAxis(start, end, count)`: комнаты вдоль оси с одноклеточной стеной;
/// остаток деления — первым комнатам. Тесно — `None`.
fn split_axis(start: i64, end: i64, count: i64) -> Option<Vec<(i64, i64)>> {
    let span = end - start + 1;
    let gap = count - 1;
    let room_size = (span - gap).div_euclid(count);
    if room_size < 3 {
        return None;
    }
    let mut extra = span - gap - room_size * count;
    let mut result = Vec::new();
    let mut cursor = start;
    for index in 0..count {
        let room_end = if index == count - 1 { end } else { cursor + room_size - 1 + i64::from(extra > 0) };
        if extra > 0 {
            extra -= 1;
        }
        result.push((cursor, room_end));
        cursor = room_end + 2;
    }
    Some(result)
}

/// `designRoomsFor(interior, use, scheme, { relaxHall })`: раскрой корпуса
/// по схеме. `relax_hall` — без предела площади зала (крест и круг).
pub(crate) fn design_rooms_for(interior: Rect, use_: &str, scheme: &str, relax_hall: bool) -> Vec<RoomPlan> {
    let Rect { min_x, min_y, max_x, max_y } = interior;
    let width = max_x - min_x + 1;
    let height = max_y - min_y + 1;
    let hall_cap = (!relax_hall).then(|| hall_interior_cap(use_));
    let capped_side = |span: i64, across: i64, least: i64| -> i64 {
        let side = match hall_cap {
            None => span,
            Some(cap) => span.min(cap.div_euclid(across.max(1))),
        };
        least.max(side)
    };
    let mut scheme = scheme;
    if let Some(corridor_rooms) = corridor_rooms(use_).filter(|_| scheme == "corridor" && width >= 14 && height >= 11) {
        let hall_height = 5;
        let corridor_min_y = min_y + hall_height + 1;
        let rooms_min_y = corridor_min_y + 2;
        let hall_width = capped_side(width, hall_height, 6);
        let front_span = width - hall_width - 1;
        let front_count: usize = if front_span >= 7 {
            2
        } else if front_span >= 3 {
            1
        } else {
            0
        };
        let inner = 3;
        let front: Vec<(i64, i64)> = match front_count {
            2 => vec![(max_x - front_span + inner + 2, max_x), (max_x - front_span + 1, max_x - front_span + inner)],
            1 => vec![(max_x - front_span + 1, max_x)],
            _ => Vec::new(),
        };
        let count = ((corridor_rooms.len() - front_count) as i64).min((width + 1).div_euclid(5));
        if count >= 2 && max_y - rooms_min_y + 1 >= 3 {
            let span = width - (count - 1);
            let size = span.div_euclid(count);
            let mut rear = Vec::new();
            let mut cursor = min_x;
            for index in 0..count {
                let room_end = if index == count - 1 { max_x } else { cursor + size - 1 };
                rear.push(RoomPlan::new(corridor_rooms[front_count + index as usize], cursor, rooms_min_y, room_end, max_y));
                cursor = room_end + 2;
            }
            let mut rooms = vec![RoomPlan::new("hall", min_x, min_y, if front_count > 0 { min_x + hall_width - 1 } else { max_x }, corridor_min_y - 2)];
            rooms.extend(front.iter().enumerate().map(|(index, room)| RoomPlan::new(corridor_rooms[index], room.0, min_y, room.1, corridor_min_y - 2)));
            rooms.push(RoomPlan::new("corridor", min_x, corridor_min_y, max_x, corridor_min_y));
            rooms.extend(rear);
            return rooms;
        }
    }
    if scheme == "corridor" {
        scheme = "wing";
    }
    let extra = wing_rooms(use_);
    let extra_count = extra.len() as i64;

    // Боковое крыло: зал во всю глубину, службы столбцом сбоку.
    let hall_columns = capped_side(width - 3.max(floor_mul(width, 0.42)) - 1, height, 3);
    let side_min_x = min_x + hall_columns + 1;
    let hall_max_x = side_min_x - 2;
    let wing = split_axis(min_y, max_y, extra_count).map(|rooms| rooms.into_iter().map(|(low, high)| (min_y + max_y - high, min_y + max_y - low)).collect::<Vec<_>>());
    if let Some(wing) = wing.filter(|_| scheme == "wing" && hall_max_x - min_x >= 2 && max_x - side_min_x >= 2) {
        let mut rooms = vec![RoomPlan::new("hall", min_x, min_y, hall_max_x, max_y)];
        rooms.extend(wing.iter().enumerate().map(|(index, room)| RoomPlan::new(extra[index], side_min_x, room.0, max_x, room.1)));
        return rooms;
    }

    // Длинный зал вдоль фасада, комнаты задним рядом.
    let hall_height = if relax_hall { 4.max(floor_mul(height, 0.38)) } else { capped_side(height - 4, width, 3) };
    let rear_min_y = min_y + hall_height + 1;
    let rear = split_axis(min_x, max_x, extra_count);
    if let Some(rear) = rear.filter(|_| scheme == "long-hall" && rear_min_y <= max_y - 2) {
        let mut rooms = vec![RoomPlan::new("hall", min_x, min_y, max_x, rear_min_y - 2)];
        rooms.extend(rear.iter().enumerate().map(|(index, room)| RoomPlan::new(extra[index], room.0, rear_min_y, room.1, max_y)));
        return rooms;
    }

    // Внутренний двор, вокруг него зал и службы.
    let plain_courtyard_width = floor_mul(width, 0.25).clamp(3, 5);
    let courtyard_height = if relax_hall { floor_mul(height, 0.28).clamp(3, 5) } else { (height - 8).clamp(3, 5) };
    let plain_hall_width = floor_mul(width - plain_courtyard_width - 2, 0.58);
    let hall_width = plain_hall_width.min(capped_side(plain_hall_width, height, 3));
    let courtyard_width = plain_courtyard_width + (plain_hall_width - hall_width).min(7 - plain_courtyard_width);
    let horizontal_room_span = width - courtyard_width - 2;
    let right_width = horizontal_room_span - hall_width;
    let courtyard_min_x = min_x + hall_width + 1;
    let courtyard_max_x = courtyard_min_x + courtyard_width - 1;
    let courtyard_min_y = min_y + if relax_hall { 4.max(floor_mul(height - courtyard_height - 2, 0.45)) } else { 4 };
    let courtyard_max_y = courtyard_min_y + courtyard_height - 1;
    let top_height = courtyard_min_y - min_y - 1;
    let bottom_height = max_y - courtyard_max_y - 1;
    let top_room = (min_y, courtyard_min_y - 2);
    let bottom_room = (courtyard_max_y + 2, max_y);
    let courtyard_right = if extra.len() > 2 { courtyard_max_x } else { max_x };
    let mut courtyard_rooms = vec![
        RoomPlan::new("hall", min_x, min_y, courtyard_min_x - 2, max_y),
        RoomPlan::new(extra[1], courtyard_min_x, top_room.0, max_x, top_room.1),
        RoomPlan::new(extra[0], courtyard_min_x, bottom_room.0, max_x, bottom_room.1),
        RoomPlan::new("courtyard", courtyard_min_x, courtyard_min_y, courtyard_right, courtyard_max_y),
    ];
    if extra.len() > 2 {
        courtyard_rooms.push(RoomPlan::new(extra[2], courtyard_max_x + 2, courtyard_min_y, max_x, courtyard_max_y));
    }
    let courtyard_fits = hall_width >= 3
        && right_width >= if extra.len() > 2 { 3 } else { 0 }
        && top_height >= 3
        && bottom_height >= 3
        && courtyard_rooms.iter().all(usable);
    let paired = if extra.len() == 2 && !relax_hall { split_axis(courtyard_min_x, max_x, 2) } else { None };
    if let Some(paired) = paired.filter(|_| scheme == "courtyard" && hall_width >= 3 && top_height >= 3 && max_y - courtyard_min_y >= 2) {
        let mut rooms = vec![RoomPlan::new("hall", min_x, min_y, courtyard_min_x - 2, max_y)];
        rooms.extend(paired.iter().enumerate().map(|(index, room)| RoomPlan::new(extra[index], room.0, top_room.0, room.1, top_room.1)));
        rooms.push(RoomPlan::new("courtyard", courtyard_min_x, courtyard_min_y, max_x, max_y));
        return rooms;
    }
    if scheme == "courtyard" && courtyard_fits {
        return courtyard_rooms;
    }

    // Схема не легла: длинный зал с доступным числом задних комнат.
    if let Some(fallback) = split_axis(min_x, max_x, extra_count.min(2)) {
        let fallback_min_y = min_y + if relax_hall { 4.max(floor_mul(height, 0.42)) } else { capped_side(height - 4, width, 3) + 1 };
        let mut rooms = vec![RoomPlan::new("hall", min_x, min_y, max_x, fallback_min_y - 2)];
        rooms.extend(fallback.iter().enumerate().map(|(index, room)| RoomPlan::new(extra[index], room.0, fallback_min_y, room.1, max_y)));
        rooms.retain(usable);
        return rooms;
    }
    vec![RoomPlan::new("hall", min_x, min_y, max_x, max_y)]
}

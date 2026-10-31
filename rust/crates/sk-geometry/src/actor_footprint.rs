//! Перенос `server/actor-footprint.mjs` — чистая геометрия площади существа.
//!
//! Модуль не знает о состоянии, событиях и карте: Rules Engine решает, можно
//! ли поставить уже рассчитанную площадь в конкретную сцену. Площадь —
//! квадрат `size × size` клеток, `x/y` актёра или anchor — верхний левый угол.
//! Входы — рыхлый JSON, как в JS (актёр, `{x, y}`, массив клеток); приведения —
//! `Number()` и `Number.isSafeInteger`.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sk_core::js;

use crate::js_extra::{is_safe_integer, js_string_or_empty, js_trim};
use crate::GridCell;

/// `ACTOR_FOOTPRINT_VERSION` — версия контракта площади в `actor.footprint`.
pub const ACTOR_FOOTPRINT_VERSION: i64 = 1;

/// `ACTOR_SIZE_SIDES` — размеры существ, из которых сервер получает сторону
/// квадратной площади; порядок — как у `Object.entries` в JS.
pub const ACTOR_SIZE_SIDES: [(&str, i64); 6] = [
    ("tiny", 1),
    ("small", 1),
    ("medium", 1),
    ("large", 2),
    ("huge", 3),
    ("gargantuan", 4),
];

const MIN_FOOTPRINT_SIDE: f64 = 1.0;
const MAX_FOOTPRINT_SIDE: f64 = 4.0;

/// Метадата площади `{ version: 1, size }` — то, что сервер кладёт в
/// `actor.footprint`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FootprintMetadata {
    pub version: i64,
    pub size: i64,
}

impl FootprintMetadata {
    /// `{ "version": 1, "size": n }`.
    pub fn to_value(self) -> Value {
        serde_json::json!({ "version": self.version, "size": self.size })
    }
}

/// Русское имя размера, которое JS тоже принимает (`большой`, `огромный`,
/// `громадный`); у малых размеров его нет, и JS сравнивает с пустой строкой.
fn russian_size_name(name: &str) -> &'static str {
    match name {
        "large" => "большой",
        "huge" => "огромный",
        "gargantuan" => "громадный",
        _ => "",
    }
}

fn side_in_bounds(number: f64) -> bool {
    is_safe_integer(number) && number >= MIN_FOOTPRINT_SIDE && number <= MAX_FOOTPRINT_SIDE
}

/// `sideFromSize`: текстовый размер (английский или русский), иначе целое
/// 1–4, иначе одна клетка. Пустой текст совпадает с «русским именем» малых
/// размеров и даёт 1 — как в JS.
fn side_from_size(value: Option<&Value>) -> i64 {
    let text = sk_core::text::lower(js_trim(&js_string_or_empty(value)));
    for (name, side) in ACTOR_SIZE_SIDES {
        if text == name || text == russian_size_name(name) {
            return side;
        }
    }
    let number = js::number(value);
    if side_in_bounds(number) {
        number as i64
    } else {
        1
    }
}

/// `footprintMetadataForSize(size)` — метадата, которую сервер ставит новым
/// актёрам. Текстовый размер принимается, потому что так его записывают
/// каталог и профиль; в сохранённую форму попадает только ограниченная
/// сторона квадрата.
pub fn footprint_metadata_for_size(size: Option<&Value>) -> FootprintMetadata {
    FootprintMetadata { version: ACTOR_FOOTPRINT_VERSION, size: side_from_size(size) }
}

/// `normalizeFootprintMetadata(value)` — только версионированный контракт
/// с целой стороной 1–4, иначе `None` (`null` в JS).
pub fn normalize_footprint_metadata(value: Option<&Value>) -> Option<FootprintMetadata> {
    let map = value?.as_object()?;
    if js::number(map.get("version")) != ACTOR_FOOTPRINT_VERSION as f64 {
        return None;
    }
    let size = js::number(map.get("size"));
    side_in_bounds(size).then_some(FootprintMetadata { version: ACTOR_FOOTPRINT_VERSION, size: size as i64 })
}

/// `footprintSizeFor(actor)` — сторона площади по версионированной метадате.
/// Старые актёры с `size: 'large'` без метадаты намеренно считаются одной
/// клеткой, чтобы старые снимки и replay не получали занятость при чтении.
pub fn footprint_size_for(actor: Option<&Value>) -> i64 {
    let metadata = actor.and_then(Value::as_object).and_then(|map| map.get("footprint"));
    normalize_footprint_metadata(metadata).map_or(1, |metadata| metadata.size)
}

/// `Number(value?.[name])` для рыхлой позиции: у не-объекта полей нет.
fn coordinate(position: Option<&Value>, name: &str) -> f64 {
    js::number(position.and_then(Value::as_object).and_then(|map| map.get(name)))
}

/// `footprintCellsFor(actor, anchor)` — абсолютные клетки, занятые актёром.
/// `x/y` — верхний левый anchor; без anchor (`null`/`undefined`) берётся
/// позиция самого актёра. Некорректные координаты дают пустой список, чтобы
/// правило карты само отклонило расстановку и не придумало координату.
pub fn footprint_cells_for(actor: Option<&Value>, anchor: Option<&Value>) -> Vec<GridCell> {
    let position = match anchor {
        Some(value) if !value.is_null() => Some(value),
        _ => actor.filter(|actor| actor.is_object()),
    };
    let x = coordinate(position, "x");
    let y = coordinate(position, "y");
    if !is_safe_integer(x) || !is_safe_integer(y) {
        return Vec::new();
    }
    let side = footprint_size_for(actor);
    let mut cells = Vec::with_capacity((side * side) as usize);
    for dy in 0..side {
        for dx in 0..side {
            // Сложение в числах JS: у края безопасных целых результат
            // округляется так же, как в V8.
            cells.push(GridCell::new((x + dx as f64) as i64, (y + dy as f64) as i64));
        }
    }
    cells
}

/// `cellsFrom(value, anchor)`: массив клеток (нечисловые отбрасываются) или
/// площадь актёра.
fn cells_from(value: Option<&Value>, anchor: Option<&Value>) -> Vec<GridCell> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|cell| {
                let x = coordinate(Some(cell), "x");
                let y = coordinate(Some(cell), "y");
                (is_safe_integer(x) && is_safe_integer(y)).then(|| GridCell::new(x as i64, y as i64))
            })
            .collect(),
        _ => footprint_cells_for(value, anchor),
    }
}

/// Дистанция в футах между двумя уже раскрытыми площадями: минимум
/// расстояния Чебышёва × 5; `None`, если хоть одна площадь пуста. Ядро
/// [`footprint_distance_feet`] для горячих путей с готовыми клетками.
pub fn cells_distance_feet(left: &[GridCell], right: &[GridCell]) -> Option<f64> {
    if left.is_empty() || right.is_empty() {
        return None;
    }
    let mut distance = f64::INFINITY;
    for first in left {
        for second in right {
            let dx = (first.x as f64 - second.x as f64).abs();
            let dy = (first.y as f64 - second.y as f64).abs();
            distance = distance.min(dx.max(dy));
        }
    }
    distance.is_finite().then_some(distance * 5.0)
}

/// Пересекаются ли две раскрытые площади. Ядро [`footprint_overlap`].
pub fn cells_overlap(left: &[GridCell], right: &[GridCell]) -> bool {
    let right_keys: HashSet<GridCell> = right.iter().copied().collect();
    left.iter().any(|cell| right_keys.contains(cell))
}

/// `footprintDistanceFeet(left, right, leftAnchor, rightAnchor)` —
/// минимальная клеточная дистанция между двумя площадями. Расстояние
/// Чебышёва — та же метрика квадратной сетки, что у ruleset; соседние площади
/// разделяют пять футов, пересекающиеся дают ноль. Принимаются и актёры, и
/// массивы клеток `[{x, y}]`. `None` — `null` в JS.
pub fn footprint_distance_feet(
    left: Option<&Value>,
    right: Option<&Value>,
    left_anchor: Option<&Value>,
    right_anchor: Option<&Value>,
) -> Option<f64> {
    cells_distance_feet(&cells_from(left, left_anchor), &cells_from(right, right_anchor))
}

/// `footprintOverlap(left, right, leftAnchor, rightAnchor)` — есть ли общая
/// клетка у двух площадей.
pub fn footprint_overlap(
    left: Option<&Value>,
    right: Option<&Value>,
    left_anchor: Option<&Value>,
    right_anchor: Option<&Value>,
) -> bool {
    cells_overlap(&cells_from(left, left_anchor), &cells_from(right, right_anchor))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn meta(size: i64) -> FootprintMetadata {
        FootprintMetadata { version: 1, size }
    }

    /// `test/actor-footprint.test.mjs`: «площадь — server-owned квадрат и
    /// legacy всегда остаётся одной клеткой» (часть модуля).
    #[test]
    fn square_footprint_and_legacy_single_cell() {
        assert_eq!(footprint_metadata_for_size(Some(&json!("large"))), meta(2));
        assert_eq!(footprint_metadata_for_size(Some(&json!("huge"))), meta(3));
        assert_eq!(footprint_metadata_for_size(Some(&json!("gargantuan"))), meta(4));
        let large = json!({ "footprint": { "version": 1, "size": 2 } });
        assert_eq!(
            footprint_cells_for(Some(&large), Some(&json!({ "x": 3, "y": 2 }))),
            vec![GridCell::new(3, 2), GridCell::new(4, 2), GridCell::new(3, 3), GridCell::new(4, 3)]
        );
        assert_eq!(footprint_size_for(Some(&json!({ "size": "gargantuan" }))), 1);
        assert_eq!(footprint_size_for(Some(&json!({ "footprint": { "version": 1, "size": "gargantuan" } }))), 1);
        assert_eq!(footprint_size_for(Some(&json!({ "footprint": { "version": 9, "size": 4 } }))), 1);
        assert_eq!(footprint_size_for(Some(&json!({ "footprint": { "version": 1, "size": 99 } }))), 1);
        assert_eq!(
            footprint_distance_feet(Some(&large), Some(&json!([{ "x": 3, "y": 1 }])), Some(&json!({ "x": 1, "y": 1 })), None),
            Some(5.0)
        );
        assert!(footprint_overlap(Some(&large), Some(&json!([{ "x": 2, "y": 2 }])), Some(&json!({ "x": 1, "y": 1 })), None));
    }

    /// `test/actor-footprint.test.mjs`: legacy-актёр со строковым `size`
    /// без метадаты остаётся одной клеткой.
    #[test]
    fn legacy_text_size_without_metadata_is_one_cell() {
        let legacy = json!({ "id": "ogre", "size": "large", "x": 4, "y": 1 });
        assert_eq!(footprint_size_for(Some(&legacy)), 1);
        assert_eq!(footprint_cells_for(Some(&legacy), None), vec![GridCell::new(4, 1)]);
    }

    /// `test/actor-footprint-events.test.mjs` (часть модуля): призванный зверь
    /// получает метадату по своему размеру, размер по умолчанию — `medium`.
    #[test]
    fn metadata_for_text_and_numeric_sizes() {
        assert_eq!(footprint_metadata_for_size(Some(&json!("medium"))), meta(1));
        assert_eq!(footprint_metadata_for_size(Some(&json!(" Большой "))), meta(2));
        assert_eq!(footprint_metadata_for_size(Some(&json!("ОГРОМНЫЙ"))), meta(3));
        assert_eq!(footprint_metadata_for_size(Some(&json!("3"))), meta(3));
        assert_eq!(footprint_metadata_for_size(Some(&json!(4))), meta(4));
        assert_eq!(footprint_metadata_for_size(Some(&json!(5))), meta(1));
        assert_eq!(footprint_metadata_for_size(Some(&json!(2.5))), meta(1));
        assert_eq!(footprint_metadata_for_size(None), meta(1));
        assert_eq!(footprint_metadata_for_size(Some(&json!("large"))).to_value(), json!({ "version": 1, "size": 2 }));
    }

    #[test]
    fn bad_coordinates_give_empty_cells_and_no_distance() {
        let actor = json!({ "footprint": { "version": 1, "size": 3 }, "x": 1.5, "y": 0 });
        assert!(footprint_cells_for(Some(&actor), None).is_empty());
        assert_eq!(footprint_distance_feet(Some(&actor), Some(&json!([{ "x": 0, "y": 0 }])), None, None), None);
        // `null` anchor берёт позицию актёра, как `anchor ?? actor` в JS.
        let placed = json!({ "x": "2", "y": null });
        assert_eq!(footprint_cells_for(Some(&placed), Some(&Value::Null)), vec![GridCell::new(2, 0)]);
        // Без актёра площадь — одна клетка в anchor.
        assert_eq!(footprint_cells_for(None, Some(&json!({ "x": 7, "y": 8 }))), vec![GridCell::new(7, 8)]);
    }
}

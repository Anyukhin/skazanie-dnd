//! Геометрия «Сказания» — перенос четырёх независимых модулей сервера:
//!
//! - [`actor_footprint`] — `server/actor-footprint.mjs`, квадратная площадь
//!   существа на клетках, дистанция и пересечение площадей;
//! - [`circular_area_geometry`] — `server/circular-area-geometry.mjs`, растр
//!   круговой области заклинания и line-of-effect от пересечения сетки;
//! - [`scene_graph`] — `server/scene-graph.mjs`, граф зон сцены: достижимость
//!   с учётом ключей и проверка рецепта до всякой геометрии;
//! - [`world_map`] — `server/world-map.mjs`, глобальная карта кампании:
//!   регионы, места, дороги, городской обзор.
//!
//! Этап паритета (`rust/PORTING.md`): поведение повторяет JS, включая порядок
//! обхода клеток и дробную арифметику; эталоны JS лежат в `fixtures/`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub mod actor_footprint;
pub mod circular_area_geometry;
pub mod scene_graph;
pub mod world_map;

mod fdlibm;
mod js_extra;

#[cfg(test)]
mod fixture_tests;

/// Клетка сетки с целыми координатами — в JSON `{ "x": …, "y": … }`.
///
/// Так JS возвращает клетки площади существа и круговой области: координаты
/// там всегда безопасные целые.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct GridCell {
    pub x: i64,
    pub y: i64,
}

impl GridCell {
    pub const fn new(x: i64, y: i64) -> Self {
        Self { x, y }
    }

    /// `{ x, y }` как JSON.
    pub fn to_value(self) -> Value {
        serde_json::json!({ "x": self.x, "y": self.y })
    }

    /// Ключ клетки, как в JS: `` `${x},${y}` ``.
    pub fn key(self) -> String {
        format!("{},{}", self.x, self.y)
    }
}

/// Точка с JS-числами: то, что JS получает из `Number(point?.x)`.
///
/// `NaN` означает отсутствующее или нечисловое поле — так модули JS видят
/// `undefined`, объект или строку без числа. Входы геометрии областей
/// принимаются в этой форме: приведение `Number()` делает [`Point::from_value`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Point {
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    /// `{ x: Number(value?.x), y: Number(value?.y) }`: у не-объекта полей нет,
    /// и обе координаты становятся `NaN`.
    pub fn from_value(value: Option<&Value>) -> Self {
        let field = |name: &str| sk_core::js::number(value.and_then(|value| value.as_object()).and_then(|map| map.get(name)));
        Self { x: field("x"), y: field("y") }
    }
}

impl From<GridCell> for Point {
    fn from(cell: GridCell) -> Self {
        Self { x: cell.x as f64, y: cell.y as f64 }
    }
}

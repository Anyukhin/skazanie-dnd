//! Перенос `server/scene-themes.mjs`: каталог тем сцены и сборка тематической
//! сцены поверх генераторов карт (этап M6, `docs/tactical-map-plan.md`).
//!
//! Тема = набор материалов, набор предметов и правила расстановки. Геометрия
//! берётся одним из способов, и выбор способа — часть темы:
//!
//! - `building` — здание с участком (`sk_buildings::building_generator`);
//! - `graph` — граф зон с проверкой ключей, затем геометрия: храм, склеп и
//!   подземелье получают помещения, пещера — органическую полость;
//! - `open` — открытая местность без помещений: лес, дорога, кладбище;
//! - `settlement` — поселение (`sk_settlements::settlement_generator`);
//! - `fortress` — авторская крепость Ареса.
//!
//! Подмодули: [`catalog`] — таблицы и опознание темы; `graph` — граф зон,
//! петли, проёмы и камеры тюрьмы; `cave` — органическая пещера; `open` —
//! открытая местность (рельеф, вода, укрытия, развалины, трудная местность);
//! `build` — `buildThemedScene`.

use std::fmt;

use serde_json::{json, Value};
use sk_buildings::building_generator::BuildingError;
use sk_core::hash;
use sk_geometry::scene_graph::SceneGraphError;
use sk_settlements::settlement_generator::SettlementError;
use sk_tactical::tactical_map::TacticalMapError;

pub mod catalog;
mod build;
mod cave;
mod graph;
mod open;

pub use build::{build_themed_scene, layout_settlement, SceneLevel, ThemedScene};
pub use catalog::{
    all_scene_themes, fallback_theme, fallback_theme_for, is_live_theme, is_live_theme_value, match_theme, resolve_scene_theme, theme_by_id, theme_for, theme_from_map_request, theme_min_size,
    SceneTheme, ThemeMinSize, SCENE_THEMES, SCENE_THEME_ALIASES, SCENE_THEME_IDS, THEME_MIN_SIZE,
};
pub use cave::{layout_organic_cave, LayoutOptions};
pub use graph::{add_shortcut_loops, scene_graph_for_theme, ShortcutLock, ShortcutOptions};
pub use open::{
    apply_open_terrain_relief, dress_water_edges, layout_open_terrain, ReliefLayout, TerrainCell, TerrainCells, TerrainPatch, OPEN_TERRAIN_GENERATOR_VERSION,
    OPEN_TERRAIN_LEVEL_FEET, OPEN_TERRAIN_MAX_STEP_FEET, OPEN_TERRAIN_MIN_PLATEAU,
};

// --- ошибка -----------------------------------------------------------------------

/// Отказ сборки сцены. `name` — класс исключения JS (`TacticalMapError`,
/// `TypeError`, `Error`), `code` — код отказа, если он есть у исключения JS.
/// В живом конвейере сборка не отказывает; отказ — только на негодном входе,
/// на котором JS бросил бы исключение.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThemeError {
    pub name: &'static str,
    pub code: Option<String>,
    pub message: String,
}

impl ThemeError {
    /// `TypeError` чтения поля у `null`.
    pub(crate) fn type_error(key: &str) -> Self {
        Self { name: "TypeError", code: None, message: format!("Cannot read properties of null (reading '{key}')") }
    }

    /// Форма эталона: `{ name, code, message }`.
    pub fn to_json(&self) -> Value {
        json!({ "name": self.name, "code": self.code, "message": self.message })
    }
}

impl From<TacticalMapError> for ThemeError {
    fn from(error: TacticalMapError) -> Self {
        let code = (error.name == TacticalMapError::NAME).then_some(error.code);
        Self { name: error.name, code, message: error.message }
    }
}

impl From<BuildingError> for ThemeError {
    fn from(error: BuildingError) -> Self {
        Self { name: error.name, code: error.code, message: error.message }
    }
}

impl From<SettlementError> for ThemeError {
    fn from(error: SettlementError) -> Self {
        Self { name: error.name, code: error.code, message: error.message }
    }
}

impl From<SceneGraphError> for ThemeError {
    fn from(error: SceneGraphError) -> Self {
        Self { name: "Error", code: Some(error.code), message: error.message }
    }
}

impl fmt::Display for ThemeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ThemeError {}

pub type Result<T> = std::result::Result<T, ThemeError>;

// --- общие помощники ----------------------------------------------------------------

/// `randomFor(seed)`: линейный конгруэнтный генератор от первых четырёх байт
/// SHA-256 строки сида (ноль заменяется единицей).
pub(crate) fn random_for(seed: &str) -> impl FnMut() -> f64 {
    let digest = hash::sha256(seed);
    let base = u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]]);
    let mut state = if base == 0 { 1 } else { base };
    move || {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        f64::from(state) / 4_294_967_296.0
    }
}

/// `shuffled(items, random)`: перемешивание Фишера — Йетса копии списка.
pub(crate) fn shuffled<T: Clone>(items: &[T], random: &mut dyn FnMut() -> f64) -> Vec<T> {
    let mut copy = items.to_vec();
    let mut index = copy.len();
    while index > 1 {
        index -= 1;
        let other = (random() * (index + 1) as f64).floor() as usize;
        copy.swap(index, other);
    }
    copy
}

/// `clamp(value, min, max)`: `Math.max(min, Math.min(max, value))`.
pub(crate) fn clamp(value: f64, min: f64, max: f64) -> f64 {
    js_max(min, js_min(max, value))
}

/// `Math.max(a, b)` с `NaN`, как в JS.
pub(crate) fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// `Math.min(a, b)` с `NaN`, как в JS.
pub(crate) fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

/// Четыре соседа клетки в порядке JS: восток, запад, юг, север.
pub(crate) const DIRS: [(i64, i64); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];

/// Сравнение строк, как `Array.prototype.sort()` без сравнителя: по кодовым
/// единицам UTF-16.
pub(crate) fn utf16_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

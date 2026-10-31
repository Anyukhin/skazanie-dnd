//! Основа сцены «Сказания» — перенос листовых модулей `server/*.mjs`, на
//! которые опираются карты, Рассказчик и проекция для игрока:
//!
//! - `scene_requirements` — словарь объектов сцены и программа сцены;
//! - `scene_map_design` — замысел карты нового места;
//! - `detail_props` — предметы набора детализации;
//! - `asset_registry` — реестр ассетов (чем рисуется предмет);
//! - `environment_catalog_revision` — выпуск каталога окружения;
//! - `equipment_visuals` — видимые модели экипировки;
//! - `actor_appearance` — публичный облик фигурки;
//! - `talespire_slab` — разбор слэба TaleSpire.
//!
//! Этап паритета: поведение совпадает с JS, данные на границе — JSON той же
//! формы. Правила переноса — `rust/PORTING.md`.

pub mod actor_appearance;
pub mod asset_registry;
pub mod detail_props;
pub mod environment_catalog_revision;
pub mod equipment_visuals;
pub mod scene_map_design;
pub mod scene_requirements;
pub mod talespire_slab;

mod util;

//! Слой локаций сцены — перенос `server/*.mjs` одиннадцатой волны, по модулю
//! на JS-файл. По плану (`rust/PORT-STATUS.md`) перенесены все пять модулей:
//!
//! | JS | Rust |
//! | --- | --- |
//! | `server/adventure-director.mjs` | [`adventure_director`] |
//! | `server/campaign-lifecycle.mjs` | [`campaign_lifecycle`] |
//! | `server/director-scene-transition.mjs` | [`director_scene_transition`] |
//! | `server/scene-memory.mjs` | [`scene_memory`] |
//! | `server/loot-containers.mjs` | [`loot_containers`] |
//!
//! Несмотря на имя, `adventure-director` — не Режиссёр (AGENTS.md §4), а слой
//! локаций: память карт мест, генерация геометрии сцены, выбор постройки из
//! библиотеки и переход между сценами.
//!
//! Этап паритета (`rust/PORTING.md`): на границе — `serde_json::Value` той же
//! формы, что у JS; карты — `TacticalMap` соседних крейтов.

pub mod adventure_director;
pub mod campaign_lifecycle;
pub mod director_scene_transition;
pub mod loot_containers;
pub mod scene_memory;

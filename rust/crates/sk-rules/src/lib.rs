//! Движок правил «Сказания» — перенос `server/rules-engine.mjs`.
//!
//! Этап паритета: состояние — JSON той же формы, что в JS, поведение сверяется
//! с корпусом (`sk-corpus`). Модули повторяют деление JS по смыслу, а не по
//! файлам: журнал боя, экономика хода, память карт, редьюсер по доменам.

pub mod classes;
pub mod economy;
pub mod journal;
pub mod reduce;
pub mod scene_maps;
pub mod speed;
pub mod tables;
pub mod world_clock;

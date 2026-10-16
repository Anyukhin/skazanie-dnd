//! Время и память мира «Сказания» — перенос детерминированных модулей
//! сервера, которые зовёт Rules Engine и такт мировых часов:
//!
//! - [`world_deeds`] — `server/world-deeds.mjs`: летопись поступков отряда,
//!   свидетели, слухи по графу мира и их отклик в репутации фракций;
//! - [`world_template_catalog`] — `server/world-template-catalog.mjs`: каталог
//!   заранее написанных миров, его проверка и стартовый комплект кампании.

pub(crate) mod common;

pub mod world_deeds;
pub mod world_template_catalog;

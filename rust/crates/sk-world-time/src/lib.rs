//! Время и память мира «Сказания» — перенос детерминированных модулей
//! сервера, которые зовут Rules Engine и такт мировых часов:
//!
//! | JS | Rust |
//! | --- | --- |
//! | `server/weather.mjs` | [`weather`] — часы кампании, время суток, погода дня, «под крышей», влияние на проверки, события смены |
//! | `server/level-generator.mjs` | [`level_generator`] — этажи построек и подземелий: верхний этаж по контуру, подвал, пещерный ярус |
//! | `server/world-deeds.mjs` | [`world_deeds`] — летопись поступков отряда, свидетели, слухи по графу мира и их отклик в репутации фракций |
//! | `server/world-template-catalog.mjs` | [`world_template_catalog`] — каталог заранее написанных миров, его проверка и стартовый комплект кампании |
//!
//! Этап паритета (`rust/PORTING.md`): вход и выход — JSON той же формы, что
//! у JS, с тем же порядком ключей; карты этажей — байт в байт строки
//! `JSON.stringify(serializeTacticalMap(map))`.

pub(crate) mod common;

pub mod level_generator;
pub mod weather;
pub mod world_deeds;
pub mod world_template_catalog;

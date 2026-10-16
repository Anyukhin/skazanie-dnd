//! Время мира «Сказания» — перенос восьмой волны:
//!
//! | JS | Rust |
//! | --- | --- |
//! | `server/weather.mjs` | [`weather`] — часы кампании, время суток, погода дня, «под крышей», влияние на проверки, события смены |
//! | `server/level-generator.mjs` | [`level_generator`] — этажи построек и подземелий: верхний этаж по контуру, подвал, пещерный ярус |
//!
//! Этап паритета (`rust/PORTING.md`): вход и выход — JSON той же формы, что
//! у JS, с тем же порядком ключей; карты этажей — байт в байт строки
//! `JSON.stringify(serializeTacticalMap(map))`.

pub mod level_generator;
pub mod weather;

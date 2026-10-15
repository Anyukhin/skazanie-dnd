//! NPC в мире «Сказания» — перенос четырёх модулей сервера:
//!
//! - [`npc_positioning`] — `server/npc-positioning.mjs`: посты жителей на
//!   карте сцены, их живучесть, стойки и вещи, проверка команд `PlaceNpc`,
//!   `MoveNpc`, `HarmNpc`, урон мирным, паника свидетелей и проекция игроку;
//! - [`tavern_life`] — `server/tavern-life.mjs`: кости на деньги и выпивка в
//!   таверне, касса соседа с закреплённым покрытием, карточка стола;
//! - [`blessings`] — `server/blessings.mjs`: молитва у святыни и треба жрецу,
//!   суточный слот, знамения и карточка благословений;
//! - [`beast_taming`] — `server/beast-taming.mjs`: лестница приручения зверя,
//!   СЛ из стат-блока, кормление пайком, спутник и стража лагеря.
//!
//! Этап паритета (`rust/PORTING.md`): поведение повторяет JS строка в строку
//! по смыслу, данные на границе — `serde_json::Value` той же формы; эталоны
//! JS лежат в `fixtures/`.

mod common;

pub mod beast_taming;
pub mod blessings;
pub mod npc_positioning;
pub mod tavern_life;

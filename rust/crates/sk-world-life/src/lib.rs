//! Жизнь мира «Сказания» вне боя — перенос трёх детерминированных модулей
//! сервера, которые зовёт Rules Engine и нормализация кампании:
//!
//! - [`captives`] — `server/captives.mjs`: пленные после сдачи и нелетального
//!   нокаута, СЛ допроса, пощада, голод и выдача страже;
//! - [`courier_letters`] — `server/courier-letters.mjs`: почта отряда, курьер
//!   на мировых минутах, детерминированный ответ и полировка модели;
//! - [`world_offices`] — `server/world-offices.mjs`: должности мира, их
//!   освобождение смертью держателя и преемство.

pub(crate) mod common;

pub mod captives;
pub mod courier_letters;
pub mod world_offices;

//! Рассказчики «Сказания» без модели — перенос модулей `server/*.mjs`:
//!
//! | JS | модуль |
//! | --- | --- |
//! | `combat-narration.mjs` | [`combat_narration`] |
//!
//! Правила переноса — `rust/PORTING.md`. Приведения JS, которых нет в
//! `sk_core` (обрезка по единицам UTF-16, `TABLE[key]` с ключами прототипа,
//! исключения `TypeError` на мусоре), собраны в [`jsv`].

pub mod combat_narration;
pub mod jsv;

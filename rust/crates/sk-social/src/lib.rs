//! Социальная жизнь NPC «Сказания»: профили, разговоры, обещания, отношения,
//! речевой профиль, граница знания и навыковые проверки в разговоре.
//!
//! Перенос `server/npc-social.mjs` и `server/npc-social-check.mjs` строка в
//! строку по смыслу (`rust/PORTING.md`): данные на границе — `serde_json::Value`
//! той же формы, что в JS, поведение сверяется с эталонами из прогона JS
//! (`fixtures/`).

mod common;

pub mod npc_social;
pub mod npc_social_check;

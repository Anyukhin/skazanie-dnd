//! Проекция состояния для зрителя и журнал трасс — перенос `server/*.mjs`
//! пятнадцатой волны (`rust/PORT-STATUS.md`):
//!
//! | JS | Rust | Задача |
//! | --- | --- | --- |
//! | `server/viewer-projection.mjs` | [`viewer_projection`] | П1 |
//! | `server/trace-store.mjs` | [`trace_store`] | П1 |
//!
//! `viewer-projection` — единственный источник того, что игрок вправе видеть
//! (`AGENTS.md` §4–§5); права и полномочия — `sk_tactics::security`.

pub mod trace_store;
pub mod viewer_projection;

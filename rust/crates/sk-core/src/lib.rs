//! Основа «Сказания».
//!
//! Формат JSON совпадает с прежним движком (`server/*.mjs`): те же имена
//! полей, поэтому сохранённые кампании, журналы событий и клиент читают его
//! без перевода. На этапе паритета логика переносится строка в строку над
//! `serde_json::Value`; помощники `js`, `text`, `clock`, `hash` повторяют
//! приведения JS, чтобы перенесённый код вёл себя так же. Правила переноса —
//! `rust/PORTING.md`.

pub mod clock;
pub mod command;
pub mod error;
pub mod event;
pub mod game;
pub mod hash;
pub mod js;
pub mod json;
pub mod state;
pub mod text;

pub use command::Command;
pub use error::{RuleError, RuleResult};
pub use event::{Event, EventDraft};
pub use fancy_regex;
pub use regex;
pub use state::*;

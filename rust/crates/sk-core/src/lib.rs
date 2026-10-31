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
pub mod content;
pub mod data_root;
pub mod error;
pub mod event;
pub mod game;
pub mod hash;
pub mod js;
pub mod json;
pub mod mechanics_support;
pub mod state;
pub mod text;
pub mod v8math;
pub mod v8sort;

pub use command::Command;
pub use error::{RuleError, RuleResult};
pub use event::{Event, EventDraft};
pub use mechanics_support::{MechanicsCensus, MechanicsSupport, UnknownMechanicsSupport};
pub use fancy_regex;
pub use indexmap;
pub use regex;
pub use state::*;

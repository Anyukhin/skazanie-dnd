//! Встречи «Сказания» — перенос `server/*.mjs` шестой волны, по модулю на
//! JS-файл:
//!
//! | JS | Rust |
//! | --- | --- |
//! | `server/encounter-assembler.mjs` | [`encounter_assembler`] |
//! | `server/agent-context.mjs` | [`agent_context`] |
//!
//! Этап паритета (`rust/PORTING.md`): на границе модулей — `serde_json::Value`
//! той же формы и с тем же порядком ключей, что у JS; тексты и коды отказов —
//! байт в байт.

pub mod agent_context;
pub mod encounter_assembler;

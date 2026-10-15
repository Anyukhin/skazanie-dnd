//! Встречи «Сказания» — перенос `server/*.mjs` шестой волны, по модулю на
//! JS-файл:
//!
//! | JS | Rust |
//! | --- | --- |
//! | `server/encounter-assembler.mjs` | [`encounter_assembler`] |
//!
//! Второй модуль крейта по плану, `server/agent-context.mjs`, ещё не
//! перенесён: он импортирует `map-quality` (крейт `sk-map-core`), которого пока
//! нет.
//!
//! Этап паритета (`rust/PORTING.md`): на границе модулей — `serde_json::Value`
//! той же формы и с тем же порядком ключей, что у JS; тексты и коды отказов —
//! байт в байт.

pub mod encounter_assembler;

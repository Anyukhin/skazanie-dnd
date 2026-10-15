//! Герои и авторские NPC «Сказания» — перенос `server/*.mjs`, по модулю на
//! JS-файл:
//!
//! | JS | Rust |
//! | --- | --- |
//! | `server/character-creation-phb.mjs` | [`character_creation_phb`] |
//! | `server/authored-npc.mjs` | [`authored_npc`] |
//!
//! Этап паритета (`rust/PORTING.md`): на границе модулей — `serde_json::Value`
//! той же формы и с тем же порядком ключей, что у JS; тексты отказов и коды —
//! байт в байт. Эталоны JS — `fixtures/`, генераторы — `fixtures/gen-*.mjs`.

pub mod authored_npc;
pub mod character_creation_phb;

mod support;

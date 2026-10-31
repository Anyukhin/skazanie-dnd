//! Внимание главного противника сценария и импровизация — перенос модулей
//! `server/*.mjs` (`rust/PORTING.md`):
//!
//! | JS | Rust |
//! | --- | --- |
//! | `server/scenario-attention.mjs` | [`scenario_attention`] |
//! | `server/improvised-effects.mjs` | [`improvised_effects`] |
//!
//! Модули детерминированы: костей не бросают, модель не зовут. На границе —
//! `serde_json::Value` той же формы и с тем же порядком ключей, что у JS;
//! эталоны JS лежат в `fixtures/`.

pub mod improvised_effects;
pub mod scenario_attention;

mod support;

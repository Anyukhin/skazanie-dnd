//! Внимание главного противника сценария — перенос модулей `server/*.mjs`
//! (`rust/PORTING.md`):
//!
//! | JS | Rust |
//! | --- | --- |
//! | `server/scenario-attention.mjs` | [`scenario_attention`] |
//!
//! Модули детерминированы: костей не бросают, модель не зовут. На границе —
//! `serde_json::Value` той же формы и с тем же порядком ключей, что у JS;
//! эталоны JS лежат в `fixtures/`.

pub mod scenario_attention;

mod support;

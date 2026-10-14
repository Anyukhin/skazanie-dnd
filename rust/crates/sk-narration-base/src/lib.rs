//! Основа рассказчиков «Сказания» — перенос модулей `server/*.mjs`, на которые
//! опираются рассказчики без модели, агенты и маршруты:
//!
//! | JS | модуль |
//! | --- | --- |
//! | `deterministic-narration.mjs` | [`deterministic_narration`] |
//! | `combat-phrases.mjs` | [`combat_phrases`] |
//! | `concentration-end-reasons.mjs` | [`concentration_end_reasons`] |
//! | `narrator-craft-quality.mjs` | [`narrator_craft_quality`] |
//! | `projection-integrity.mjs` | [`projection_integrity`] |
//! | `prompt-descriptors.mjs` | [`prompt_descriptors`] |
//! | `model-style-profiles.mjs` | [`model_style_profiles`] |
//! | `campaign-ai-context.mjs` | [`campaign_ai_context`] |
//! | `campaign-inspiration.mjs` | [`campaign_inspiration`] |
//! | `clarification-registry.mjs` | [`clarification_registry`] |
//! | `contracts.mjs` | [`contracts`] |
//! | `speech-input.mjs` | [`speech_input`] |
//!
//! Правила переноса — `rust/PORTING.md`. Приведения JS, которых нет в
//! `sk_core::js` (печать чисел, `JSON.stringify`, `String.prototype.replace`),
//! собраны в [`jsx`].

pub mod campaign_ai_context;
pub mod campaign_inspiration;
pub mod clarification_registry;
pub mod combat_phrases;
pub mod concentration_end_reasons;
pub mod contracts;
pub mod deterministic_narration;
pub mod jsx;
pub mod model_style_profiles;
pub mod narrator_craft_quality;
pub mod projection_integrity;
pub mod prompt_descriptors;
pub mod speech_input;

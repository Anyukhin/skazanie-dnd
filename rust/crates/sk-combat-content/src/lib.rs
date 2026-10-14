//! Боевое содержание «Сказания» — перенос `server/*.mjs` второй волны, по
//! модулю на JS-файл:
//!
//! | JS | Rust |
//! | --- | --- |
//! | `server/combat-spells.mjs` | [`combat_spells`] |
//! | `server/combat-lab-monsters.mjs` | [`combat_lab_monsters`] |
//! | `server/wild-shape.mjs` | [`wild_shape`] |
//! | `server/combat-actions.mjs` | [`combat_actions`] |
//! | `server/character-build.mjs` | [`character_build`] |
//! | `server/scene-hazards.mjs` | [`scene_hazards`] |
//! | `server/scene-hazard-narration.mjs` | [`scene_hazard_narration`] |
//! | `server/spell-override-audit.mjs` | [`spell_override_audit`] |
//!
//! Этап паритета (`rust/PORTING.md`): на границе модулей — `serde_json::Value`
//! той же формы и с тем же порядком ключей, что у JS; тексты байт в байт.
//! Данные `data/*.json` встроены `include_str!`.

mod jsv;

pub mod combat_actions;
pub mod combat_lab_monsters;
pub mod character_build;
pub mod combat_spells;
pub mod scene_hazard_narration;
pub mod scene_hazards;
pub mod spell_override_audit;
pub mod wild_shape;

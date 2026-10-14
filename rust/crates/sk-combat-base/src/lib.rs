//! Основа боя «Сказания» — перенос нижних модулей боевой механики:
//! `server/legendary-actions.mjs`, `server/monster-actions.mjs`,
//! `server/reaction-preferences.mjs`, `server/combat-lab-encounter-math.mjs` и
//! `server/dndsu-2014-content.mjs` (по модулю на файл).
//!
//! Данные между модулями — JSON той же формы, что в JS; нормализованные
//! профили и итоги расчётов — структуры с `to_json`, повторяющим форму JS.

mod jsv;

pub mod combat_lab_encounter_math;
pub mod dndsu_2014_content;
pub mod legendary_actions;
pub mod monster_actions;
pub mod reaction_preferences;

//! Расстановка предметов на тактической карте «Сказания» — перенос двух
//! модулей пятой волны:
//!
//! | JS | Rust |
//! | --- | --- |
//! | `server/prop-placement.mjs` | [`prop_placement`] |
//! | `server/scene-dressing.mjs` | [`scene_dressing`] |
//!
//! Оба модуля работают над типизированной картой `sk_tactical::tactical_map
//! ::TacticalMap` и мутируют её, как JS мутирует объект карты. Всё
//! детерминировано от сида: тот же сид даёт ту же расстановку, включая
//! повороты и масштабы — ГПСЧ, порядок обхода клеток и сортировки повторены
//! точно (`rust/PORTING.md`).

pub mod prop_placement;
pub mod scene_dressing;

mod js_math;
mod util;

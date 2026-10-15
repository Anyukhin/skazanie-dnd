//! Генератор зданий «Сказания» — перенос `server/building-generator.mjs`
//! шестой волны:
//!
//! | JS | Rust |
//! | --- | --- |
//! | `server/building-generator.mjs` | [`building_generator`] (подмодули — планировка, форма корпуса, проёмы, обстановка, крепость Ареса) |
//!
//! Этап паритета (`rust/PORTING.md`): тот же сид даёт ту же карту — байт в
//! байт строки `JSON.stringify(serializeTacticalMap(map))`; тексты отказов и
//! предупреждений копируются из JS. Вход сборщиков — объект JS (`options`)
//! рыхлым JSON, как у `buildBuildingScene`.

pub mod building_generator;

mod v8_sort;

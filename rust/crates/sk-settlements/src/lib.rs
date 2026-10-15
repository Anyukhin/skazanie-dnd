//! Генераторы сцен по плану — перенос `server/*.mjs` шестой волны, по модулю
//! на JS-файл:
//!
//! | JS | Rust |
//! | --- | --- |
//! | `server/graph-layout.mjs` | [`graph_layout`] |
//!
//! Этап паритета (`rust/PORTING.md`): тот же сид даёт ту же карту — байт в
//! байт строки `JSON.stringify(serializeTacticalMap(map))`; тексты
//! предупреждений и замечаний копируются из JS.

pub mod graph_layout;

/// Подпись генератора на карте (`map.generator`): `{ id, version }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GeneratorStamp {
    pub id: &'static str,
    pub version: &'static str,
}

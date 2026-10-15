//! Генераторы сцен по плану — перенос `server/*.mjs` шестой волны, по модулю
//! на JS-файл:
//!
//! | JS | Rust |
//! | --- | --- |
//! | `server/graph-layout.mjs` | [`graph_layout`] |
//! | `server/settlement-generator.mjs` | [`settlement_generator`] |
//! | `server/scene-program-layout.mjs` | [`scene_program_layout`] |
//!
//! Этап паритета (`rust/PORTING.md`): тот же сид даёт ту же карту — байт в
//! байт строки `JSON.stringify(serializeTacticalMap(map))`; тексты
//! предупреждений, замечаний и отказов копируются из JS.

use sk_core::hash;

pub mod graph_layout;
pub mod scene_program_layout;
pub mod settlement_generator;
mod v8_math;

/// Подпись генератора на карте (`map.generator`): `{ id, version }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GeneratorStamp {
    pub id: &'static str,
    pub version: &'static str,
}

/// `randomFor(seed)` обоих генераторов (в JS — две одинаковые копии): LCG от
/// первых четырёх байт SHA-256 сида (ноль — единица), `state / 2³²`.
pub(crate) fn random_for(seed: &str) -> impl FnMut() -> f64 {
    let digest = hash::sha256(seed);
    let base = u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]]);
    let mut state = if base == 0 { 1 } else { base };
    move || {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        f64::from(state) / 4_294_967_296.0
    }
}

/// Перемешивание Фишера — Йетса на детерминированном генераторе (`shuffle`,
/// `shuffled`): копия, исходный порядок не трогается.
pub(crate) fn shuffle<T: Clone>(items: &[T], random: &mut dyn FnMut() -> f64) -> Vec<T> {
    let mut result = items.to_vec();
    let mut index = result.len();
    while index > 1 {
        index -= 1;
        let swap = (random() * (index + 1) as f64).floor() as usize;
        result.swap(index, swap);
    }
    result
}

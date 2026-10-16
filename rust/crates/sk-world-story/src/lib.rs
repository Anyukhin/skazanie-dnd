//! Сюжет мира «Сказания»: модули `server/`, которые читают сценарий, часы
//! мира и сцену и решают, кто и что сейчас в ней есть.
//!
//! - [`scenario_knight`] — `server/scenario-knight.mjs`: проклятый рыцарь,
//!   приходящий только в своё окно ночи, и его загадка.

pub mod scenario_knight;

pub(crate) mod support;

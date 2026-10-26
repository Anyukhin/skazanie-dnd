//! Ветки заклинания `CastSpell` (`rules-engine.mjs`, 16836–18832). Задача Р9.
//!
//! `common` — общая часть и концентрация (точки входа диспетчера); виды
//! заклинаний — соседние файлы. При нужде Р9 делится по 17718.

pub mod attack;
pub mod common;
pub mod heal_buff;
pub mod save;
pub mod summon;
pub mod utility;

//! Ветки `resolveCommandInternal`: Сцена, карта, время: переход между этажами, импорт и перестройка карты, смена сцены, время, раскрытие области, сущности. Задача Р6.
//!
//! JS: `server/rules-engine.mjs`, 19709–19782, 22310–22359, 22360–22462, 22463–22598, 22599–22604, 22739–22743, 22752–22754. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use super::Resolve;
use crate::pause::{unported, Step};

/// `UseLevelTransition` (19709–19782).
pub fn use_level_transition(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:UseLevelTransition").into())
}

/// `ImportLocationMap` (22310–22359).
pub fn import_location_map(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:ImportLocationMap").into())
}

/// `RebuildLocationMap` (22360–22462).
pub fn rebuild_location_map(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:RebuildLocationMap").into())
}

/// `AdvanceScene` (22463–22598).
pub fn advance_scene(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:AdvanceScene").into())
}

/// `AdvanceTime` (22599–22604).
pub fn advance_time(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:AdvanceTime").into())
}

/// `RevealArea` (22739–22743).
pub fn reveal_area(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:RevealArea").into())
}

/// `SpawnEntity` (22752–22754).
pub fn spawn_entity(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:SpawnEntity").into())
}

//! Ветки `resolveCommandInternal`: Герой: выборы и заклинания, повышение уровня, импорт, броски характеристик и богатства. Задача Р6.
//!
//! JS: `server/rules-engine.mjs`, 22859–22863, 22864–22868, 22869–22873, 22874–22886, 22887–22893. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use super::Resolve;
use crate::pause::{unported, Step};

/// `SetCharacterChoices`, `SetSpellSelections` (22859–22863).
pub fn character_build(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:SetCharacterChoices").into())
}

/// `LevelUp` (22864–22868).
pub fn level_up(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:LevelUp").into())
}

/// `ImportCharacter` (22869–22873).
pub fn import_character(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:ImportCharacter").into())
}

/// `RollCharacterAbilities` (22874–22886).
pub fn roll_character_abilities(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:RollCharacterAbilities").into())
}

/// `RollCharacterWealth` (22887–22893).
pub fn roll_character_wealth(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:RollCharacterWealth").into())
}

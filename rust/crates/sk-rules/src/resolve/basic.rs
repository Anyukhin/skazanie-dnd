//! Ветки `resolveCommandInternal`: Базовые ветки: заявка действия, проверка характеристики, спасбросок, урон и лечение по команде, временные хиты, предпочтения бонуса и реакций, решение ведущего, неизвестный тип (`default`). Задача Р5.
//!
//! JS: `server/rules-engine.mjs`, 13703–13705, 13706–13798, 13799–13856, 15151–15157, 15158–15166, 15216–15221, 15314–15319, 15320–15340, 23128–23130, 23131–23132. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use super::Resolve;
use crate::pause::{unported, Step};

/// `DeclareAction` (13703–13705).
pub fn declare_action(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:DeclareAction").into())
}

/// `MakeAbilityCheck` (13706–13798).
pub fn make_ability_check(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:MakeAbilityCheck").into())
}

/// `MakeSavingThrow` (13799–13856).
pub fn make_saving_throw(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:MakeSavingThrow").into())
}

/// `ApplyDamage` (15151–15157).
pub fn apply_damage(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:ApplyDamage").into())
}

/// `ApplyHealing` (15158–15166).
pub fn apply_healing(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:ApplyHealing").into())
}

/// `GrantTemporaryHitPoints` (15216–15221).
pub fn grant_temporary_hit_points(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:GrantTemporaryHitPoints").into())
}

/// `SetSpellBonusPreference` (15314–15319).
pub fn set_spell_bonus_preference(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:SetSpellBonusPreference").into())
}

/// `SetReactionPreference` (15320–15340).
pub fn set_reaction_preference(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:SetReactionPreference").into())
}

/// `RecordRuling` (23128–23130).
pub fn record_ruling(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:RecordRuling").into())
}

/// неизвестный тип (`default`) (23131–23132).
pub fn default_branch(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:default").into())
}

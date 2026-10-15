//! Ветки `resolveCommandInternal`: Заклинание `CastSpell` (общая часть 16825–17219) и концентрация; ветки видов — соседние файлы `spell/`. Задача Р9.
//!
//! JS: `server/rules-engine.mjs`, 16814–16816, 16817–16822, 16823–18810. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use super::super::Resolve;
use crate::pause::{unported, Step};

/// `StartConcentration` (16814–16816).
pub fn start_concentration(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:StartConcentration").into())
}

/// `EndConcentration` (16817–16822).
pub fn end_concentration(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:EndConcentration").into())
}

/// `CastSpell` (16823–18810).
pub fn cast_spell(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:CastSpell").into())
}

/// Боевой лист видимого NPC сцены для заклинания 2014 (13049–13051):
/// `npcInteractionTargetForViewer(state, id)` и `npcCombatActorFor(state, id)`.
/// `None` — NPC не цель (пропустить). Вызывается только для id, у которых нет
/// листа в бою.
pub fn npc_spell_proxy_for(_state: &serde_json::Value, _id: &str) -> Result<Option<serde_json::Value>, crate::pause::Halt> {
    Err(unported("resolve:npc-spell-proxy").into())
}

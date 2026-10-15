//! Ветки `resolveCommandInternal`: Объекты сцены `OperateSceneObject` и импровизированное действие. Задача Р11.
//!
//! JS: `server/rules-engine.mjs`, 15284–15294, 19258–19701. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use super::Resolve;
use crate::pause::{unported, Step};

/// `ResolveImprovisedAction` (15284–15294).
pub fn resolve_improvised_action(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:ResolveImprovisedAction").into())
}

/// `OperateSceneObject` (19258–19701).
pub fn operate_scene_object(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:OperateSceneObject").into())
}

//! Ветки `resolveCommandInternal`: Пленные: допрос, освобождение, сдача страже, кормление, забвение, казнь. Задача Р7.
//!
//! JS: `server/rules-engine.mjs`, 21030–21080, 21081–21132, 21133–21184, 21185–21195, 21196–21203, 21204–21244. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use super::super::Resolve;
use crate::pause::{unported, Step};

/// `InterrogateCaptive` (21030–21080).
pub fn interrogate_captive(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:InterrogateCaptive").into())
}

/// `ReleaseCaptive` (21081–21132).
pub fn release_captive(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:ReleaseCaptive").into())
}

/// `HandCaptiveToGuards` (21133–21184).
pub fn hand_captive_to_guards(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:HandCaptiveToGuards").into())
}

/// `FeedCaptive` (21185–21195).
pub fn feed_captive(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:FeedCaptive").into())
}

/// `NeglectCaptive` (21196–21203).
pub fn neglect_captive(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:NeglectCaptive").into())
}

/// `ExecuteCaptive` (21204–21244).
pub fn execute_captive(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:ExecuteCaptive").into())
}

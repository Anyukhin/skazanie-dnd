//! Ходы NPC в бою — перенос `server/*.mjs` шестнадцатой волны
//! (`rust/PORT-STATUS.md`):
//!
//! | JS | Rust | Задача |
//! | --- | --- | --- |
//! | `server/npc-turn-scheduler.mjs` | [`npc_turn_scheduler`] | Н1 |
//! | `server/combat-turn-coordinator.mjs` | [`combat_turn_coordinator`] | Н1 |
//!
//! Стандартные ходы NPC — только сервер, без модели (`AGENTS.md` §6); мораль и
//! перелом боя — `sk_agents::npc_controller`. Этот файл и `Cargo.toml` правит
//! только ведущий переноса.

pub mod combat_turn_coordinator;
pub mod npc_turn_scheduler;

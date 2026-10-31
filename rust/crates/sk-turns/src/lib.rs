//! Ходы NPC в бою — перенос `server/*.mjs` шестнадцатой волны
//! (`rust/PORT-STATUS.md`):
//!
//! | JS | Rust | Задача |
//! | --- | --- | --- |
//! | `server/npc-turn-scheduler.mjs` | [`npc_turn_scheduler`] | Н1 |
//! | `server/combat-turn-coordinator.mjs` | [`combat_turn_coordinator`] | Н1 |
//! | `server/npc-controller.mjs` (`isMoraleMoment`, `commandsForMoraleDecision`) | [`morale`] | урок 7 |
//!
//! Стандартные ходы NPC — только сервер, без модели (`AGENTS.md` §6). Момент
//! морали и перевод решения в команды — детерминированное ядро [`morale`];
//! решение модели на переломе боя — `sk_agents::npc_controller::NpcMoraleAgent`,
//! который реализует [`npc_turn_scheduler::NpcController`]. Крейт от слоя
//! агентов не зависит (сторож — `sk-server/tests/crate_layers.rs`). Этот файл
//! и `Cargo.toml` правит только ведущий переноса.

pub mod combat_turn_coordinator;
pub mod morale;
pub mod npc_turn_scheduler;

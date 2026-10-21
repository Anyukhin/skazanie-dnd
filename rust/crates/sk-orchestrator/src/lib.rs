//! Оркестрация — перенос `server/*.mjs` восемнадцатой волны
//! (`rust/PORT-STATUS.md`):
//!
//! | JS | Rust | Задача |
//! | --- | --- | --- |
//! | `server/autonomous-orchestrator.mjs` | [`autonomous_orchestrator`] | О1 |
//! | `server/game-orchestrator.mjs` | [`game_orchestrator`] | О2 |
//!
//! Автономный цикл: `sk_agents::director_agent` → `sk_world_story::autonomous_campaign`
//! → [`autonomous_orchestrator`] → `sk_story::campaign_loop_policy` (запасной путь).
//! Этот файл и `Cargo.toml` правит только ведущий переноса.

pub mod autonomous_orchestrator;
pub mod game_orchestrator;

//! Агентные роли — перенос `server/*.mjs` пятнадцатой волны
//! (`rust/PORT-STATUS.md`), по модулю на JS-файл. Клиент модели не
//! импортируется, а внедряется (`sk_agents_base::llm_client`), как в JS
//! (`AGENTS.md` §4): без ключа и в тестах роли работают на заглушке.
//!
//! | JS | Rust | Задача |
//! | --- | --- | --- |
//! | `server/campaign-bootstrap.mjs` | [`campaign_bootstrap`] | А1 |
//! | `server/campaign-recap.mjs` | [`campaign_recap`] | А1 |
//! | `server/creative-director.mjs` | [`creative_director`] | А1 |
//! | `server/lore-author.mjs` | [`lore_author`] | А1 |
//! | `server/lore-voice.mjs` | [`lore_voice`] | А1 |
//! | `server/npc-controller.mjs` | [`npc_controller`] | А2 |
//! | `server/scene-architect.mjs` | [`scene_architect`] | А2 |
//! | `server/director-agent.mjs` | [`director_agent`] | А2 |
//! | `server/hero-hooks.mjs` | [`hero_hooks`] | А2 |
//! | `server/player-request-router.mjs` | [`player_request_router`] | А2 |
//! | `server/free-action-adjudication.mjs` | [`free_action_adjudication`] | А3 |
//! | `server/action-adjudicator.mjs` | [`action_adjudicator`] | А3 |
//! | `server/npc-social-controller.mjs` | [`npc_social_controller`] | А4 |
//! | `server/narrator.mjs` | [`narrator`] | А5 |
//!
//! А1 и А2 ждут только `sk-tactics` (`security`); А3–А5 — ещё и
//! `sk-projection`. Каждым файлом владеет одна задача; этот файл и
//! `Cargo.toml` правит только ведущий переноса.

pub mod action_adjudicator;
pub mod campaign_bootstrap;
pub mod campaign_recap;
pub mod creative_director;
pub mod director_agent;
pub mod free_action_adjudication;
pub mod hero_hooks;
pub mod lore_author;
pub mod lore_voice;
pub mod narrator;
pub mod npc_controller;
pub mod npc_social_controller;
pub mod player_request_router;
pub mod scene_architect;

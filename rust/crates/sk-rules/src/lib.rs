//! Движок правил «Сказания» — перенос `server/rules-engine.mjs` и
//! `server/rules/tactical-geometry.mjs`.
//!
//! Этап паритета: состояние, команда и событие — JSON той же формы, что в JS,
//! поведение сверяется с эталонами JS (`fixtures/`) и корпусом (`sk-corpus`).
//! План и раскладка по задачам Р0–Р11 — `rust/RULES-ENGINE-PLAN.md`: каждым
//! файлом владеет одна задача (владелец — в шапке файла), модули и точки
//! входа объявлены заранее (Р0), `lib.rs` и `mod.rs` правит только Р0.
//!
//! Точки входа: [`validate::validate_command`], [`resolve::resolve_command_internal`]
//! и обёртки [`resolve::api`], редьюсер [`reduce::apply_event`],
//! [`normalize::normalize_campaign_state`], [`replay`].

// Р0: ядро, команды, контекст, паузы, кости, экономика хода, журналы.
pub mod command;
pub mod constants;
pub mod context;
pub mod core;
pub mod dice_record;
pub mod enervation_link;
pub mod journal;
pub mod outcome;
pub mod pause;
pub mod tables;
pub mod turn_economy;
pub mod world_clock;

// Р1: геометрия, движение, области, цели.
pub mod areas;
pub mod geometry;
pub mod scene_map_sync;
pub mod speed;
pub mod tactical_geometry;
pub mod targets;

// Р2: состояния, проверки, урон, смерть, отдых, взлом.
pub mod checks;
pub mod conditions;
pub mod damage;
pub mod death;
pub mod lockpick;
pub mod rest;

// Р3: оружие, классы, предметы NPC, монстры, ход, встреча.
pub mod combat;

// Р4: нормализация, сцена, общество, replay, память карт.
pub mod normalize;
pub mod normalized;
pub mod replay;
pub mod schema;
pub mod scene;
pub mod scene_maps;
pub mod society_helpers;

// Р5: заклинания-помощники, реакции.
pub mod reactions;
pub mod spells;

// Р6: торговля.
pub mod merchants;

// Р7: предпросмотр d20, сводка событий.
pub mod preview_checks;
pub mod summary;

// Р8: предпросмотры атаки.
pub mod preview_attack;

// Р11: события предметов NPC.
pub mod npc_item_events;

// Точки входа (диспетчеры — Р0, тела веток — задачи по шапкам файлов).
pub mod reduce;
pub mod resolve;
pub mod validate;

//! Сюжет мира «Сказания»: модули `server/`, которые читают сценарий, часы
//! мира и сцену и решают, что происходит в кампании и вокруг отряда.
//!
//! - [`autonomous_campaign`] — `server/autonomous-campaign.mjs`: контракт
//!   намерения Режиссёра (`DIRECTOR_INTENT_TYPES`), состояние `autonomy` и
//!   его редьюсер, запасная зацепка.
//! - [`scenario_knight`] — `server/scenario-knight.mjs`: проклятый рыцарь,
//!   приходящий только в своё окно ночи, и его загадка.
//! - [`scene_canon`] — `server/scene-canon.mjs`: физический канон сцены (час,
//!   погода, свет, крыша, сырость, кто виден) и проверка противоречий текста.
//!
//! Импорт TaleSpire (`server/talespire-import.mjs`) — отдельный крейт
//! `sk-talespire`: он зовёт тактическую геометрию `sk-rules`, а `sk-rules`
//! зависит от этого крейта.

pub mod autonomous_campaign;
pub mod scenario_knight;
pub mod scene_canon;

pub(crate) mod support;

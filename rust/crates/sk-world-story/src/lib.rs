//! Сюжет мира «Сказания» — перенос модулей автономного цикла кампании:
//!
//! - [`autonomous_campaign`] — `server/autonomous-campaign.mjs`: контракт
//!   намерения Режиссёра (`DIRECTOR_INTENT_TYPES`), состояние `autonomy` и
//!   его редьюсер, запасная зацепка.
//!
//! Остальные модули крейта (мир за кадром, рыцарь сценария, канон сцены,
//! импорт TaleSpire) ждут переноса погоды (`sk-world-time`).

pub mod autonomous_campaign;

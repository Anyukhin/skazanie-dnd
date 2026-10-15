//! Ядро обработки тактических карт «Сказания» — перенос `server/*.mjs` пятой
//! волны, по модулю на JS-файл:
//!
//! | JS | Rust |
//! | --- | --- |
//! | `server/thin-walls.mjs` | [`thin_walls`] |
//! | `server/room-floors.mjs` | [`room_floors`] |
//! | `server/scene-features.mjs` | [`scene_features`] |
//! | `server/map-quality.mjs` | [`map_quality`] |
//! | `server/authored-location-maps.mjs` | [`authored_location_maps`] |
//! | `server/combat-lab-maps.mjs` | [`combat_lab_maps`] |
//! | `server/dynamic-map.mjs` | [`dynamic_map`] (и форма клетки [`dynamic_map::SceneCell`]) |
//!
//! Этап паритета (`rust/PORTING.md`): на границе — типизированная
//! [`sk_tactical::tactical_map::TacticalMap`] и `serde_json::Value` той же
//! формы и с тем же порядком ключей, что у JS; тексты и коды байт в байт.

pub mod authored_location_maps;
pub mod combat_lab_maps;
pub mod dynamic_map;
pub mod map_quality;
pub mod room_floors;
pub mod scene_features;
pub mod thin_walls;

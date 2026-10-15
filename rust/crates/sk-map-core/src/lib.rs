//! Ядро обработки тактических карт «Сказания» — перенос `server/*.mjs` пятой
//! волны, по модулю на JS-файл:
//!
//! | JS | Rust |
//! | --- | --- |
//! | `server/thin-walls.mjs` | [`thin_walls`] |
//! | `server/room-floors.mjs` | [`room_floors`] |
//!
//! Этап паритета (`rust/PORTING.md`): на границе — типизированная
//! [`sk_tactical::tactical_map::TacticalMap`] и `serde_json::Value` той же
//! формы и с тем же порядком ключей, что у JS; тексты и коды байт в байт.

pub mod room_floors;
pub mod thin_walls;

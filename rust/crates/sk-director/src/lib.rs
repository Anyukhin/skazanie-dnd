//! Слой локаций сцены — перенос `server/*.mjs` одиннадцатой волны, по модулю
//! на JS-файл. По плану (`rust/PORT-STATUS.md`) в крейте будут
//! `adventure-director`, `campaign-lifecycle`, `scene-memory`,
//! `director-scene-transition` и `loot-containers`; сейчас перенесён
//! `adventure-director`:
//!
//! | JS | Rust |
//! | --- | --- |
//! | `server/adventure-director.mjs` | [`adventure_director`] |
//!
//! Несмотря на имя, `adventure-director` — не Режиссёр (AGENTS.md §4), а слой
//! локаций: память карт мест, генерация геометрии сцены, выбор постройки из
//! библиотеки и переход между сценами.
//!
//! Этап паритета (`rust/PORTING.md`): на границе — `serde_json::Value` той же
//! формы, что у JS; карты — `TacticalMap` соседних крейтов.

pub mod adventure_director;

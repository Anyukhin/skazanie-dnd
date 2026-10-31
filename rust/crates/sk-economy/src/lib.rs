//! Экономика «Сказания» — перенос `server/*.mjs`, через которые идёт жизнь
//! денег и вещей: торговец и его склад, цены и торг, оценка вещей, экземпляр
//! предмета с историей, сборка лавки по теме и сиду, решение сцены о лавке,
//! снаряжение противников и его расход в бою, рассказчик торговли.
//!
//! Модуль на каждый JS-файл:
//!
//! | JS | Rust |
//! | --- | --- |
//! | `server/merchant-economy.mjs` | [`merchant_economy`] |
//! | `server/item-appraisal.mjs` | [`item_appraisal`] |
//! | `server/item-instances.mjs` | [`item_instances`] |
//! | `server/merchant-narration.mjs` | [`merchant_narration`] |
//! | `server/shop-assembler.mjs` | [`shop_assembler`] |
//! | `server/scene-commerce.mjs` | [`scene_commerce`] |
//! | `server/enemy-loadouts.mjs` | [`enemy_loadouts`] |
//! | `server/npc-equipment.mjs` | [`npc_equipment`] |
//!
//! Этап паритета (`rust/PORTING.md`): на границе модулей — `serde_json::Value`
//! той же формы и с тем же порядком ключей, что у JS; тексты отказов и коды —
//! байт в байт. Костей эти модули не бросают: торг решает Rules Engine, а
//! сборка лавки и снаряжение противника выводятся из сида детерминированно.

pub mod enemy_loadouts;
pub mod item_appraisal;
pub mod item_instances;
pub mod merchant_economy;
pub mod merchant_narration;
pub mod npc_equipment;
pub mod scene_commerce;
pub mod shop_assembler;

mod support;

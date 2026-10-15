//! Ветки `resolveCommandInternal`: Торговля: торг, оценка, покупка, услуги, продажа, жизненный цикл торговцев, карманная кража. Задача Р6.
//!
//! JS: `server/rules-engine.mjs`, 20348–20378, 20379–20395, 20396–20444, 20445–20475, 20476–20541, 20542–20549, 20550–20559, 20560–20568, 20569–20581, 20582–20592, 20609–20679. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use super::Resolve;
use crate::pause::{unported, Step};

/// `BargainWithMerchant` (20348–20378).
pub fn bargain_with_merchant(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:BargainWithMerchant").into())
}

/// `AppraiseItem` (20379–20395).
pub fn appraise_item(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:AppraiseItem").into())
}

/// `BuyItem` (20396–20444).
pub fn buy_item(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:BuyItem").into())
}

/// `PurchaseMerchantService` (20445–20475).
pub fn purchase_merchant_service(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:PurchaseMerchantService").into())
}

/// `SellItem` (20476–20541).
pub fn sell_item(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:SellItem").into())
}

/// `CreateMerchant` (20542–20549).
pub fn create_merchant(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:CreateMerchant").into())
}

/// `ConfigureMerchant` (20550–20559).
pub fn configure_merchant(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:ConfigureMerchant").into())
}

/// `RestockMerchant` (20560–20568).
pub fn restock_merchant(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:RestockMerchant").into())
}

/// `MoveMerchant` (20569–20581).
pub fn move_merchant(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:MoveMerchant").into())
}

/// `SetMerchantAvailability` (20582–20592).
pub fn set_merchant_availability(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:SetMerchantAvailability").into())
}

/// `PickpocketNpc` (20609–20679).
pub fn pickpocket_npc(_r: &mut Resolve<'_>) -> Step {
    Err(unported("resolve:PickpocketNpc").into())
}

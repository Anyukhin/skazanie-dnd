//! Ветки редьюсера `applyGameEventCurrent`: Торговцы: создание, настройка, пополнение, часы экономики, перемещение, доступность, оценка, торг, покупка, услуги, продажа. Задача Р6.
//!
//! JS: `server/rules-engine.mjs`, 25492–25505, 25506–25521, 25522–25540, 25541–25550, 25551–25562, 25563–25570, 25571–25581, 25582–25605, 25606–25630, 25631–25652, 25653–25699. Таблица меток — `reduce/table.rs`
//! (Р0). Перенося ветку, уберите её метки из [`UNPORTED`] этого файла.

use serde_json::Value;
use sk_core::Event;

use super::Reduced;
use crate::pause::unported;

/// Метки событий этого файла, чьи ветки ещё не перенесены.
pub(super) const UNPORTED: &[&str] = &[
    "MerchantCreated",
    "MerchantConfigured",
    "MerchantRestocked",
    "MerchantEconomyClockAdvanced",
    "MerchantMoved",
    "MerchantAvailabilityChanged",
    "MerchantItemAppraised",
    "MerchantBargainResolved",
    "MerchantPurchaseCompleted",
    "MerchantServicePurchased",
    "MerchantSaleCompleted",
];

/// `MerchantCreated` (25492–25505).
pub(super) fn merchant_created(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:MerchantCreated"))
}

/// `MerchantConfigured` (25506–25521).
pub(super) fn merchant_configured(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:MerchantConfigured"))
}

/// `MerchantRestocked` (25522–25540).
pub(super) fn merchant_restocked(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:MerchantRestocked"))
}

/// `MerchantEconomyClockAdvanced` (25541–25550).
pub(super) fn merchant_economy_clock_advanced(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:MerchantEconomyClockAdvanced"))
}

/// `MerchantMoved` (25551–25562).
pub(super) fn merchant_moved(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:MerchantMoved"))
}

/// `MerchantAvailabilityChanged` (25563–25570).
pub(super) fn merchant_availability_changed(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:MerchantAvailabilityChanged"))
}

/// `MerchantItemAppraised` (25571–25581).
pub(super) fn merchant_item_appraised(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:MerchantItemAppraised"))
}

/// `MerchantBargainResolved` (25582–25605).
pub(super) fn merchant_bargain_resolved(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:MerchantBargainResolved"))
}

/// `MerchantPurchaseCompleted` (25606–25630).
pub(super) fn merchant_purchase_completed(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:MerchantPurchaseCompleted"))
}

/// `MerchantServicePurchased` (25631–25652).
pub(super) fn merchant_service_purchased(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:MerchantServicePurchased"))
}

/// `MerchantSaleCompleted` (25653–25699).
pub(super) fn merchant_sale_completed(_state: &mut Value, _event: &Event) -> Reduced {
    Err(unported("reduce:MerchantSaleCompleted"))
}

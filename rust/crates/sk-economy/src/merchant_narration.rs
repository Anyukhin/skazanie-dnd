//! Перенос `server/merchant-narration.mjs`: рассказчик торговли без модели.
//!
//! Текст собирается только из закоммиченных событий торговли и имени
//! торговца из состояния: структурированная сделка обходит свободный ответ
//! модели, чтобы голос не придумал другое место, вещь, цену, бросок или исход.
//!
//! Рассказчик регистрируется по контракту
//! `sk_narration_base::deterministic_narration`: в JS — при импорте модуля,
//! здесь — при первом обращении к [`MERCHANT_NARRATOR`].

use std::sync::{Arc, LazyLock};

use serde_json::{Map, Value};
use sk_core::js;
use sk_narration_base::deterministic_narration::{narration_text_or, register_deterministic_narrator, DeterministicNarrator, SharedNarrator, NARRATION_TEXT_OR_DEFAULT_MAXIMUM, NARRATOR_PRIORITY};

use crate::merchant_economy::find_merchant;
use crate::support::{coalesce, get, is_object_like, safe_int};

const MERCHANT_EVENT_TYPES: [&str; 9] = [
    "MerchantBargainResolved",
    "MerchantItemAppraised",
    "MerchantPurchaseCompleted",
    "MerchantSaleCompleted",
    "MerchantCreated",
    "MerchantConfigured",
    "MerchantRestocked",
    "MerchantMoved",
    "MerchantAvailabilityChanged",
];

fn is_merchant_event(event: &Value) -> bool {
    MERCHANT_EVENT_TYPES.contains(&js::s(get(Some(event), "event_type")).as_str())
}

fn safe_text(value: Option<&Value>, fallback: &str) -> String {
    narration_text_or(value, fallback, NARRATION_TEXT_OR_DEFAULT_MAXIMUM)
}

/// `formatCopper(value)`: `55 зм 1 см 1 мм`; ноль — `0 мм`.
fn format_copper(value: Option<&Value>) -> String {
    let mut copper = safe_int(value, 0).max(0);
    let gold = copper / 100;
    copper -= gold * 100;
    let silver = copper / 10;
    copper -= silver * 10;
    let mut parts = Vec::new();
    if gold != 0 {
        parts.push(format!("{gold} зм"));
    }
    if silver != 0 {
        parts.push(format!("{silver} см"));
    }
    if copper != 0 || parts.is_empty() {
        parts.push(format!("{copper} мм"));
    }
    parts.join(" ")
}

/// `hasMerchantEvent(events)`.
pub fn has_merchant_event(events: &[Value]) -> bool {
    events.iter().any(is_merchant_event)
}

/// `merchantNarration(events, state)`: текст последнего события торговли или
/// `None`, если торговли в событиях нет.
pub fn merchant_narration(events: &[Value], state: &Value) -> Option<String> {
    let business_event = events.iter().rev().find(|event| is_merchant_event(event))?;
    let empty = Value::Object(Map::new());
    let payload = business_event.get("payload").filter(|payload| is_object_like(Some(payload))).unwrap_or(&empty);
    let field = |key: &str| get(Some(payload), key);
    let merchant = find_merchant(state, field("merchant_id"));
    let merchant_name = safe_text(coalesce(get(merchant, "name"), get(field("merchant"), "name")), "Торговец");
    let event_type = business_event.get("event_type").and_then(Value::as_str).unwrap_or("");

    match event_type {
        "MerchantCreated" => {
            let location = narration_text_or(coalesce(get(field("merchant"), "location"), get(merchant, "location")), "текущей локации", 180);
            return Some(format!("{merchant_name} раскладывает товар: в локации «{location}» можно торговать."));
        }
        "MerchantConfigured" => return Some(format!("{merchant_name} меняет условия торговли.")),
        "MerchantRestocked" => {
            let quantity = safe_int(field("total_quantity_added"), 0).max(0);
            return Some(format!("Склад «{merchant_name}» пополнен на {quantity} ед. товара."));
        }
        "MerchantMoved" => {
            let location = narration_text_or(coalesce(field("location_after"), get(merchant, "location")), "новую локацию", 180);
            return Some(format!("{merchant_name} перемещён в локацию «{location}»."));
        }
        "MerchantAvailabilityChanged" => {
            return Some(if js::is_true(field("available_after")) { format!("{merchant_name} открывает торговлю.") } else { format!("{merchant_name} временно закрывает торговлю.") });
        }
        "MerchantBargainResolved" => {
            let total = safe_int(field("roll_total"), 0);
            let difficulty = safe_int(field("difficulty"), 15);
            return Some(if js::is_true(field("success")) {
                format!("{merchant_name} принимает ваши доводы и меняет условия сделки. Проверка торга: {total} против СЛ {difficulty} — успех.")
            } else {
                format!("{merchant_name} выслушивает вас, но не уступает в цене. Проверка торга: {total} против СЛ {difficulty} — неудача.")
            });
        }
        "MerchantItemAppraised" => {
            let item_name = safe_text(coalesce(field("item_name"), field("item_id")), "предмет");
            return Some(format!("{merchant_name} осматривает «{item_name}» и называет подтверждённую цену: {}.", format_copper(field("base_unit_price_cp"))));
        }
        _ => {}
    }

    let item_name = safe_text(coalesce(get(field("item"), "name"), field("catalog_id")), "предмет");
    let quantity = safe_int(field("quantity"), 1).max(1);
    let total = format_copper(field("total_price_cp"));
    if event_type == "MerchantPurchaseCompleted" {
        return Some(format!("{merchant_name} подтверждает покупку: {item_name} × {quantity}. Списано {total}."));
    }
    Some(format!("{merchant_name} принимает товар: {item_name} × {quantity}. Получено {total}."))
}

/// `merchantNarrator`: рассказчик торговли.
#[derive(Debug, Default, Clone, Copy)]
pub struct MerchantNarrator;

impl DeterministicNarrator for MerchantNarrator {
    fn id(&self) -> &str {
        "merchant"
    }

    fn prompt_version(&self) -> &str {
        "merchant-narrator/v1"
    }

    fn provider(&self) -> &str {
        "deterministic-merchant"
    }

    fn priority(&self) -> f64 {
        NARRATOR_PRIORITY.merchant
    }

    fn matches(&self, events: &[Value]) -> bool {
        has_merchant_event(events)
    }

    fn narrate(&self, events: &[Value], state: &Value) -> Option<String> {
        merchant_narration(events, state)
    }
}

/// Рассказчик торговли в общем реестре сервера: регистрируется при первом
/// обращении (в JS — при импорте модуля).
pub static MERCHANT_NARRATOR: LazyLock<SharedNarrator> = LazyLock::new(|| {
    let narrator: SharedNarrator = Arc::new(MerchantNarrator);
    // Повторная регистрация невозможна: `LazyLock` выполняется один раз, а
    // другого рассказчика с id `merchant` в сервере нет.
    let _ = register_deterministic_narrator(Arc::clone(&narrator));
    narrator
});

/// `merchantNarrator` — зарегистрированный рассказчик.
pub fn merchant_narrator() -> SharedNarrator {
    Arc::clone(&MERCHANT_NARRATOR)
}

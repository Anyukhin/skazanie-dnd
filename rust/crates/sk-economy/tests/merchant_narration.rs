//! `merchant_narration`: эталон JS (`fixtures/merchant-narration.json`),
//! проверки из `test/merchant-narration.test.mjs` и контракт рассказчика.

mod common;

use common::{check, ok, ok_or_null, Args, Outcome};
use serde_json::{json, Value};
use sk_economy::merchant_narration::*;
use sk_narration_base::deterministic_narration::{assert_narrator_contract, deterministic_narrator_for, deterministic_narrators, render_deterministic_narration, DeterministicNarrator};

fn events(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::as_array).cloned().unwrap_or_default()
}

fn run(name: &str, args: &Args) -> Outcome {
    match name {
        "const:merchantNarrator" => {
            let narrator = MerchantNarrator;
            ok(json!({ "id": narrator.id(), "priority": narrator.priority() as i64, "promptVersion": narrator.prompt_version(), "provider": narrator.provider() }))
        }
        "hasMerchantEvent" => ok(json!(has_merchant_event(&events(args.get(0))))),
        "merchantNarration" => ok_or_null(merchant_narration(&events(args.get(0)), args.get(1).unwrap_or(&Value::Null)).map(Value::String)),
        other => panic!("неизвестная функция эталона {other}"),
    }
}

#[test]
fn narration_matches_js() {
    let summary = check(include_str!("../fixtures/merchant-narration.json"), run);
    assert!(summary.calls > 1_400, "{summary:?}");
}

fn state() -> Value {
    json!({ "merchants": [{ "id": "marten", "name": "Мартен", "location": "Рыночная площадь" }] })
}

#[test]
fn bargain_uses_only_committed_facts() {
    let events = [json!({ "event_type": "MerchantBargainResolved", "payload": { "merchant_id": "marten", "success": false, "roll_total": 12, "difficulty": 15 } })];
    assert!(has_merchant_event(&events));
    assert_eq!(merchant_narration(&events, &state()).as_deref(), Some("Мартен выслушивает вас, но не уступает в цене. Проверка торга: 12 против СЛ 15 — неудача."));
}

#[test]
fn purchase_names_item_quantity_and_exact_total() {
    let events = [json!({ "event_type": "MerchantPurchaseCompleted", "payload": { "merchant_id": "marten", "quantity": 3, "total_price_cp": 5_511, "item": { "name": "Зелье лечения" } } })];
    assert_eq!(merchant_narration(&events, &state()).as_deref(), Some("Мартен подтверждает покупку: Зелье лечения × 3. Списано 55 зм 1 см 1 мм."));
}

#[test]
fn other_events_produce_no_merchant_narration() {
    let events = [json!({ "event_type": "ActorMoved" })];
    assert!(!has_merchant_event(&events));
    assert_eq!(merchant_narration(&events, &state()), None);
}

#[test]
fn lifecycle_narration_names_committed_location_and_stock_delta() {
    let created = [json!({ "event_type": "MerchantCreated", "payload": { "merchant_id": "marten", "merchant": { "name": "Мартен", "location": "Рыночная площадь" } } })];
    assert_eq!(merchant_narration(&created, &state()).as_deref(), Some("Мартен раскладывает товар: в локации «Рыночная площадь» можно торговать."));
    let restocked = [json!({ "event_type": "MerchantRestocked", "payload": { "merchant_id": "marten", "total_quantity_added": 7 } })];
    assert_eq!(merchant_narration(&restocked, &state()).as_deref(), Some("Склад «Мартен» пополнен на 7 ед. товара."));
}

#[test]
fn narrator_follows_the_contract_and_registers_once() {
    let narrator = merchant_narrator();
    assert_narrator_contract(narrator.as_ref()).expect("контракт");
    assert_eq!((narrator.id(), narrator.prompt_version(), narrator.provider()), ("merchant", "merchant-narrator/v1", "deterministic-merchant"));
    assert!(deterministic_narrators().iter().filter(|known| known.id() == "merchant").count() == 1);
    let events = [json!({ "event_type": "MerchantSaleCompleted", "payload": { "merchant_id": "marten", "quantity": 1, "total_price_cp": 100, "item": { "name": "Кинжал" } } })];
    let found = deterministic_narrator_for(&events).expect("рассказчик торговли");
    assert_eq!(found.id(), "merchant");
    let rendered = render_deterministic_narration(found.as_ref(), &events, &state(), "запас");
    assert_eq!(rendered.narration, "Мартен принимает товар: Кинжал × 1. Получено 1 зм.");
    assert_eq!(rendered.prompt_version, "merchant-narrator/v1");
    // Повторное обращение не регистрирует второго рассказчика.
    let _ = merchant_narrator();
    assert_eq!(deterministic_narrators().iter().filter(|known| known.id() == "merchant").count(), 1);
}

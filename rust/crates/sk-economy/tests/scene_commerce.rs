//! `scene_commerce`: эталон JS (`fixtures/scene-commerce.json`) и проверки
//! из `test/scene-commerce.test.mjs`.

mod common;

use common::{check, ok, Args, Outcome};
use serde_json::json;
use sk_economy::scene_commerce::*;

fn run(name: &str, args: &Args) -> Outcome {
    match name {
        "const:SCENE_COMMERCE_PLAN_VERSION" => ok(json!(SCENE_COMMERCE_PLAN_VERSION)),
        "defaultSceneShopIntent" => ok(default_scene_shop_intent(args.get(0))),
        "normalizeSceneShopIntent" => ok(normalize_scene_shop_intent(args.get(0), args.get(1))),
        other => panic!("неизвестная функция эталона {other}"),
    }
}

#[test]
fn scene_commerce_matches_js() {
    let summary = check(include_str!("../fixtures/scene-commerce.json"), run);
    assert!(summary.calls > 900, "{summary:?}");
}

#[test]
fn city_scene_requests_a_catalog_only_shop() {
    let intent = default_scene_shop_intent(Some(&json!({ "location": "Большой город Норвин", "theme": "городские улицы и кузницы" })));
    assert_eq!(
        intent,
        json!({
            "version": SCENE_COMMERCE_PLAN_VERSION,
            "action": "create",
            "settlement_type": "city",
            "theme": "arms",
            "budget_cp": 50_000,
            "reason": "Новая сцена является поселением, поэтому Директор запросил базовую торговую точку.",
        })
    );
}

#[test]
fn forest_and_dungeon_get_no_stationary_shop() {
    for scene in [
        json!({ "location": "Чаща у Серого ручья", "theme": "дикая местность" }),
        json!({ "location": "Подземный архив", "theme": "подземные помещения" }),
        json!({ "location": "Серая чаща", "theme": "дикая местность", "arrival": "Путь из большого города приводит героев в лес." }),
    ] {
        assert_eq!(default_scene_shop_intent(Some(&scene))["action"], "none", "{scene}");
    }
}

#[test]
fn director_can_close_a_city_shop_or_call_a_traveling_trader() {
    let city = json!({ "location": "Город Норвин", "theme": "городские улицы" });
    assert_eq!(normalize_scene_shop_intent(Some(&json!({ "action": "none", "reason": "Рынок закрыт по сюжету." })), Some(&city))["action"], "none");
    let road = json!({ "location": "Северный тракт", "theme": "дорога" });
    assert_eq!(
        normalize_scene_shop_intent(Some(&json!({ "action": "create", "settlement_type": "traveling", "theme": "provisions", "budget_cp": 7_500 })), Some(&road)),
        json!({
            "version": SCENE_COMMERCE_PLAN_VERSION,
            "action": "create",
            "settlement_type": "traveling",
            "theme": "provisions",
            "budget_cp": 7_500,
            "reason": "В сцене не обнаружено поселение или постоянная торговая точка.",
        })
    );
}

#[test]
fn unsafe_fields_and_stationary_shop_in_wilderness_fail_closed() {
    let road = json!({ "location": "Северный тракт", "theme": "дорога" });
    let forged = normalize_scene_shop_intent(Some(&json!({ "action": "create", "settlement_type": "city", "theme": "arms", "budget_cp": 500_000, "base_price_cp": 1 })), Some(&road));
    assert_eq!((forged["action"].as_str(), forged["settlement_type"].as_str()), (Some("none"), Some("traveling")));
    let stationary = normalize_scene_shop_intent(Some(&json!({ "action": "create", "settlement_type": "city", "theme": "arms", "budget_cp": 500_000 })), Some(&road));
    assert_eq!((stationary["action"].as_str(), stationary["settlement_type"].as_str()), (Some("none"), Some("city")));
}

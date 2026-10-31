//! Проверки `merchant_economy` из `test/merchant-economy.test.mjs`,
//! `test/merchant-economy-clock.test.mjs`, `test/merchant-lifecycle.test.mjs`
//! и `test/merchant-appraisal.test.mjs`. То, что там идёт через Rules Engine
//! (команды покупки, продажи, торга, жизненного цикла), здесь заменено
//! состоянием, которое те команды оставляют, и сверено эталоном
//! `merchant-economy-states.json`.

use serde_json::{json, Value};
use sk_economy::item_appraisal::{appraise_item, CATEGORY_APPRAISAL_POLICY_ID};
use sk_economy::merchant_economy::*;

fn merchant_with(patch: Value) -> Value {
    let mut source = json!({
        "id": "marten", "name": "Мартен", "location": "РЫНОЧНАЯ   ПЛОЩАДЬ", "available": true,
        "secret_inventory_note": "не показывать игроку",
        "pricing": { "buy_markup_bps": 11_000, "sell_rate_bps": 5_000, "bargain_dc": 15, "success_discount_bps": 1_000, "failure_markup_bps": 500, "min_multiplier_bps": 1_000, "max_multiplier_bps": 30_000 },
        "stock": [{ "stock_id": "potion-stock", "catalog_id": "srd_5_2_1:potion-of-healing", "name": "Зелье лечения", "type": "consumable", "quantity": 3, "base_price_cp": 1, "secret_supplier": "не показывать" }],
    });
    for (key, value) in patch.as_object().cloned().unwrap_or_default() {
        source[key] = value;
    }
    normalize_merchant(Some(&source), 0)
}

fn item(value: Value) -> Value {
    normalize_inventory_item(Some(&value), InventoryItemOptions::default())
}

fn hero_inventory() -> Vec<Value> {
    vec![
        item(json!({ "id": "hero-dagger", "catalog_id": "srd_5_2_1:dagger", "name": "Кинжал", "type": "weapon", "quantity": 2, "equipped": false, "base_price_cp": 99_999 })),
        item(json!({ "id": "quest-letter", "name": "Письмо короля", "type": "document", "rarity": "сюжетный", "quantity": 1, "price_provenance": "custom-appraisal", "appraisal_policy_id": ECONOMY_POLICY_ID, "base_price_cp": 10_000 })),
    ]
}

fn state_with(merchant: Value, inventory: Vec<Value>, patch: Value) -> Value {
    let mut state = json!({
        "sessionCode": "SHOP-UNIT",
        "state_version": 0,
        "scene": { "location": "рыночная площадь" },
        "players": [{ "id": "hero", "currency": { "copper": 0, "silver": 0, "gold": 100, "platinum": 0 }, "inventory": inventory }],
        "merchants": [merchant],
    });
    for (key, value) in patch.as_object().cloned().unwrap_or_default() {
        state[key] = value;
    }
    state
}

fn sell_quote<'a>(view: &'a Value, item_id: &str) -> &'a Value {
    view["sell_quotes"].as_array().and_then(|quotes| quotes.iter().find(|quote| quote["item_id"] == item_id)).unwrap_or_else(|| panic!("нет котировки {item_id}"))
}

fn view_of(state: &Value) -> Value {
    merchant_view_for(state, Some(&json!("marten")), Some(&json!("hero"))).expect("витрина")
}

#[test]
fn catalog_price_overrides_snapshot_and_custom_has_no_authority() {
    let catalog = resolve_catalog_price(Some(&json!({ "catalog_id": "srd_5_2_1:potion-of-healing", "base_price_cp": 1 }))).expect("каталог");
    assert_eq!((catalog["base_price_cp"].as_i64(), catalog["provenance"].as_str(), catalog["source_page"].as_i64()), (Some(5_000), Some("catalog"), Some(95)));
    assert_eq!(resolve_catalog_base_price_cp(Some(&json!({ "catalog_id": "srd_5_2_1:longbow", "base_price_cp": 1 }))), 5_000);
    assert_eq!(resolve_catalog_price(Some(&json!({ "catalog_id": "custom:ring", "base_price_cp": 100_000 }))), None);
    assert_eq!(resolve_catalog_price(Some(&json!({ "catalog_id": "custom:ring", "price_provenance": "custom-appraisal", "appraisal_policy_id": ECONOMY_POLICY_ID }))), None);
    // Ключ прототипа — не запись каталога: цены нет.
    assert_eq!(resolve_catalog_price(Some(&json!({ "catalog_id": "toString" }))), None);
    assert_eq!(resolve_catalog_base_price_cp(Some(&json!({ "catalog_id": "constructor" }))), 0);
}

#[test]
fn normalizer_fills_frontend_fields_and_replaces_forged_stack_key() {
    let normalized = item(json!({ "id": "legacy", "quantity": 1, "stack_key": "forged" }));
    for (key, expected) in [("name", json!("Предмет")), ("type", json!("other")), ("weight", json!(0)), ("equipped", json!(false)), ("rarity", json!("обычный")), ("description", json!("")), ("properties", json!("")), ("image", json!(""))] {
        assert_eq!(normalized[key], expected, "{key}");
    }
    let stack_key = normalized["stack_key"].as_str().expect("ключ");
    assert!(stack_key.starts_with("custom:") && stack_key.len() == "custom:".len() + 32);
}

#[test]
fn currency_round_trip_is_exact_on_the_whole_range() {
    assert_eq!(currency_to_copper(Some(&json!({ "copper": 1, "silver": 1, "gold": 1, "platinum": 1 }))), 1_111);
    assert_eq!(normalize_currency(Some(&json!({ "copper": 8, "silver": 14, "gold": 37, "platinum": 0 }))), json!({ "copper": 8, "silver": 14, "gold": 37, "platinum": 0 }));
    for amount in [0, 1, 9, 10, 99, 100, 999, 1_000, MAX_CURRENCY_CP - 1, MAX_CURRENCY_CP] {
        assert_eq!(currency_to_copper(Some(&copper_to_currency(Some(&json!(amount))))), amount);
    }
    let over_cap = normalize_currency(Some(&json!({ "copper": MAX_CURRENCY_CP, "platinum": 9_000_000 })));
    assert_eq!(currency_to_copper(Some(&over_cap)), MAX_CURRENCY_CP);
    assert_eq!(over_cap, copper_to_currency(Some(&json!(MAX_CURRENCY_CP))));
}

#[test]
fn view_shows_public_stock_and_server_quotes() {
    assert_eq!(canonical_location_key(Some(&json!("  ＭＡＲＫＥＴ\tSquare  "))), "market square");
    assert!(locations_match(Some(&json!("РЫНОЧНАЯ   ПЛОЩАДЬ")), Some(&json!("рыночная площадь"))));
    assert!(merchant_is_at_location(Some(&json!("")), Some(&json!("рыночная площадь"))));
    let state = state_with(merchant_with(json!({})), hero_inventory(), json!({}));
    let view = view_of(&state);
    assert_eq!((view["state_version"].as_i64(), view["balance_cp"].as_i64(), view["merchant_purse_cp"].as_i64()), (Some(0), Some(10_000), Some(DEFAULT_MERCHANT_PURSE_CP)));
    assert!(view["merchant"].get("secret_inventory_note").is_none());
    assert!(view["merchant"]["stock"][0].get("secret_supplier").is_none());
    assert!(view["buy_quotes"][0]["item"].get("secret_supplier").is_none());
    assert_eq!(view["merchant"]["stock"][0]["base_price_cp"], 5_000);
    assert_eq!(view["buy_quotes"][0]["unit_price_cp"], 5_500);
    assert_eq!(sell_quote(&view, "hero-dagger")["unit_price_cp"], 100);
    assert_eq!(sell_quote(&view, "hero-dagger")["can_afford"], true);
    assert_eq!(sell_quote(&view, "quest-letter")["can_sell"], false);
}

#[test]
fn availability_follows_the_live_npc() {
    let open = state_with(merchant_with(json!({})), hero_inventory(), json!({}));
    assert_eq!(merchant_trade_availability_for(&open, Some(&json!("marten")), false).to_json(), json!({ "can_trade": true, "code": null, "reason": null }));
    let closed = json!({ "can_trade": false, "code": "MERCHANT_UNAVAILABLE", "reason": "Торговец сейчас недоступен" });
    for patch in [
        json!({ "npc_world": { "vitals": { "marten": { "hp": 0, "max_hp": 4, "alive": false } } } }),
        json!({ "social": { "npcs": [{ "id": "marten", "name": "Мартен", "location": "рыночная площадь", "available": false }] } }),
        json!({ "captives": { "captives": [{ "id": "captive:marten", "npc_id": "marten", "status": "held" }] } }),
        json!({
            "mechanics": { "world_time": { "elapsed_minutes": 60 } },
            "social": { "npcs": [{ "id": "marten", "name": "Мартен", "role": "купец", "location": "рыночная площадь", "available": true, "schedule": [{ "id": "away", "days": [], "start_minute": 0, "end_minute": 120, "location": "Склад", "available": false }] }] },
        }),
    ] {
        let state = state_with(merchant_with(json!({})), hero_inventory(), patch.clone());
        assert_eq!(merchant_trade_availability_for(&state, Some(&json!("marten")), false).to_json(), closed, "{patch}");
    }
    let away = state_with(merchant_with(json!({})), hero_inventory(), json!({ "scene": {} }));
    assert_eq!(merchant_trade_availability_for(&away, Some(&json!("marten")), false).code, Some("MERCHANT_NOT_PRESENT"));
}

#[test]
fn valuables_keep_full_price_and_catalog_mode_ignores_adjustment() {
    let treasure = item(json!({ "id": "appraised-gem", "name": "Оценённый самоцвет", "type": "treasure", "quantity": 1, "catalog_id": "srd_5_2_1:dagger", "base_price_cp": 1 }));
    let mut inventory = hero_inventory();
    inventory.push(treasure);
    let view = view_of(&state_with(merchant_with(json!({})), inventory, json!({})));
    assert_eq!((sell_quote(&view, "appraised-gem")["breakdown"]["catalog_base_unit_cp"].as_i64(), sell_quote(&view, "appraised-gem")["unit_price_cp"].as_i64()), (Some(200), Some(200)));

    let catalog = merchant_with(json!({ "pricing": { "buy_markup_bps": 11_000, "sell_rate_bps": 5_000, "min_multiplier_bps": 1_000, "max_multiplier_bps": 30_000, "mode": "catalog", "agent_adjustment_bps": 2_000 } }));
    assert_eq!(catalog["pricing"]["agent_adjustment_bps"], 0);
    let view = view_of(&state_with(catalog, hero_inventory(), json!({})));
    assert_eq!(view["buy_quotes"][0]["unit_price_cp"], 5_500);
    assert_eq!(sell_quote(&view, "hero-dagger")["unit_price_cp"], 100);
}

#[test]
fn purse_bounds_sell_quote_and_attuned_item_has_no_price() {
    let poor = merchant_with(json!({ "purse_cp": 99 }));
    let quote = sell_quote(&view_of(&state_with(poor, hero_inventory(), json!({}))), "hero-dagger").clone();
    assert_eq!((quote["unit_price_cp"].as_i64(), quote["can_afford"].as_bool(), quote["can_sell"].as_bool(), quote["max_quantity"].as_i64()), (Some(100), Some(false), Some(false), Some(0)));
    assert!(quote["reason"].as_str().unwrap_or_default().contains("недостаточно монет"));
    assert_eq!(merchant_with(json!({ "purse_cp": MAX_CURRENCY_CP + 1 }))["purse_cp"], MAX_CURRENCY_CP);

    let mut ring = sk_items::item_catalog::materialize_catalog_item("srd_5_2_1:ring-of-protection", Some(&json!({ "id": "attuned-ring" })));
    ring["equipped"] = json!(false);
    ring["attuned_to"] = json!("hero");
    let mut inventory = hero_inventory();
    inventory.push(ring);
    let view = view_of(&state_with(merchant_with(json!({ "purse_cp": 1_000_000 })), inventory, json!({})));
    let quote = sell_quote(&view, "attuned-ring");
    assert_eq!((quote["can_sell"].as_bool(), quote["max_quantity"].as_i64()), (Some(false), Some(0)));
    assert!(quote["reason"].as_str().unwrap_or_default().contains("разорвите настройку"));
}

#[test]
fn stack_key_separates_variants_of_one_catalog_id() {
    let blue = item(json!({ "id": "blue-potion", "catalog_id": "srd_5_2_1:potion-of-healing", "name": "Зелье в синей склянке", "type": "consumable", "quantity": 1, "properties": "Синяя печать", "stack_key": "same-forged-key" }));
    let red = item(json!({ "id": "red-potion", "catalog_id": "srd_5_2_1:potion-of-healing", "name": "Зелье в красной склянке", "type": "consumable", "quantity": 1, "properties": "Красная печать", "stack_key": "same-forged-key" }));
    assert_ne!(blue["stack_key"], red["stack_key"]);
    let stolen = item(json!({ "id": "blue-potion", "catalog_id": "srd_5_2_1:potion-of-healing", "name": "Зелье в синей склянке", "type": "consumable", "quantity": 1, "properties": "Синяя печать", "origin": "stolen" }));
    assert_ne!(blue["stack_key"], stolen["stack_key"], "краденое не слипается с купленным");
}

// ---------- test/merchant-economy-clock.test.mjs ----------

fn clock_merchant(patch: Value) -> Value {
    let mut source = json!({
        "id": "marten", "name": "Marten", "location": "Market", "available": true,
        "pricing": { "buy_markup_bps": 11_000, "sell_rate_bps": 5_000, "min_multiplier_bps": 1_000, "max_multiplier_bps": 30_000 },
        "stock": [{ "stock_id": "rope", "catalog_id": "srd_5_2_1:rope-hempen-50-feet", "name": "Rope", "type": "tool", "quantity": 1 }],
    });
    for (key, value) in patch.as_object().cloned().unwrap_or_default() {
        source[key] = value;
    }
    normalize_merchant(Some(&source), 0)
}

#[test]
fn services_are_bounded_server_priced_and_quoted() {
    let normalized = clock_merchant(json!({
        "services": [
            { "service_id": "repair", "name": "Repair kit", "kind": "repair", "base_price_cp": 100, "duration_minutes": 30, "tags": ["craft", "craft", ""], "forged_secret": "not retained" },
            { "service_id": "repair", "name": "Duplicate", "base_price_cp": 1 },
            { "service_id": "other", "name": "Odd", "kind": "unsupported", "base_price_cp": -1, "duration_minutes": 99_999 },
        ],
        "bargains": { "hero": { "success": true, "pricing_adjustment_bps": -1_000 } },
    }));
    let services = normalized["services"].as_array().expect("услуги");
    assert_eq!(services.len(), 2);
    assert_eq!(services[0]["tags"], json!(["craft"]));
    assert_eq!(services[0]["policy_id"], MERCHANT_SERVICES_POLICY_ID);
    assert!(services[0].get("forged_secret").is_none());
    assert_eq!((services[1]["kind"].as_str(), services[1]["base_price_cp"].as_i64(), services[1]["duration_minutes"].as_i64()), (Some("other"), Some(0), Some(10_080)));
    let quote = quote_merchant_service(Some(&normalized), Some(&json!("hero")), Some(&services[0]), None).expect("цена");
    assert_eq!((quote["price_cp"].as_i64(), quote["bargain_adjustment_bps"].as_i64()), (Some(100), Some(-1_000)));
    assert_eq!(quote_merchant_service(Some(&normalized), Some(&json!("hero")), Some(&Value::Null), None), None);

    let state = json!({ "state_version": 7, "scene": { "location": "Market" }, "players": [{ "id": "hero", "currency": { "gold": 1 }, "inventory": [] }], "merchants": [normalized] });
    let view = merchant_view_for(&state, Some(&json!("marten")), Some(&json!("hero"))).expect("витрина");
    assert_eq!(view["service_quotes"].as_array().map(Vec::len), Some(2));
    assert_eq!((view["service_quotes"][0]["price_cp"].as_i64(), view["service_quotes"][0]["can_afford"].as_bool()), (Some(100), Some(true)));
    assert!(view["merchant"]["services"][0].get("forged_secret").is_none());
    assert_eq!(view["merchant"]["restock"]["enabled"], false);
    assert_eq!(
        merchant_service_proposal(&state, Some(&json!("marten")), Some(&json!("hero")), Some(&json!("repair"))),
        Some(json!({
            "proposal_version": 1, "command_type": "PurchaseMerchantService", "merchant_id": "marten", "actor_id": "hero", "service_id": "repair",
            "expected_state_version": 7, "price_cp": 100, "can_afford": true, "requires_presence": true, "duration_minutes": 30, "policy_id": MERCHANT_SERVICES_POLICY_ID,
        }))
    );
    let mut docks = state.clone();
    docks["scene"] = json!({ "location": "Docks" });
    assert_eq!(merchant_service_proposal(&docks, Some(&json!("marten")), Some(&json!("hero")), Some(&json!("repair"))), None);
}

#[test]
fn clock_creates_restock_command_and_single_checkpoint() {
    let initial = clock_merchant(json!({ "restock_policy": { "enabled": true, "interval_minutes": 60, "last_restock_world_minute": 0, "targets": [{ "stock_id": "rope", "target_quantity": 5 }, { "stock_id": "forged", "target_quantity": 999 }] } }));
    assert_eq!(initial["restock_policy"]["policy_id"], MERCHANT_RESTOCK_POLICY_ID);
    assert_eq!(initial["restock_policy"]["targets"], json!([{ "stock_id": "rope", "target_quantity": 5 }]));
    assert_eq!(plan_merchant_restock(Some(&initial), Some(&json!(59))), None);
    let due = plan_merchant_restock(Some(&initial), Some(&json!(60))).expect("срок");
    let entry = &due["entries"][0];
    assert_eq!((entry["stock_id"].as_str(), entry["quantity_before"].as_i64(), entry["quantity_added"].as_i64(), entry["quantity_after"].as_i64()), (Some("rope"), Some(1), Some(4), Some(5)));
    assert_eq!(due["total_quantity_added"], 4);
    let command = merchant_restock_command_from_plan(Some(&initial), Some(&due)).expect("команда");
    assert_eq!(command["command_type"], "RestockMerchant");
    assert_eq!((command["items"][0]["stock_id"].as_str(), command["items"][0]["catalog_id"].as_str(), command["items"][0]["quantity"].as_i64()), (Some("rope"), Some("srd_5_2_1:rope-hempen-50-feet"), Some(4)));
    let event = merchant_economy_clock_event_from_plan(Some(&initial), Some(&due)).expect("событие");
    assert_eq!((event["event_type"].as_str(), event["payload"]["processed_at_world_minute"].as_i64()), (Some(MERCHANT_ECONOMY_CLOCK_EVENT_TYPE), Some(60)));

    let mut tampered = due.clone();
    tampered["entries"][0]["quantity_added"] = json!(999_999);
    tampered["entries"][0]["quantity_after"] = json!(999_999);
    let restored = apply_merchant_restock_plan(Some(&initial), Some(&tampered));
    assert_eq!((restored["stock"][0]["quantity"].as_i64(), restored["restock_policy"]["last_restock_world_minute"].as_i64()), (Some(5), Some(60)));
    assert_eq!(plan_merchant_restock(Some(&restored), Some(&json!(60))), None);
    let no_change = plan_merchant_restock(Some(&restored), Some(&json!(180))).expect("пустой срок");
    assert_eq!(no_change["entries"], json!([]));
    assert_eq!(merchant_restock_command_from_plan(Some(&restored), Some(&no_change)), None);
    assert_eq!(apply_merchant_restock_plan(Some(&restored), Some(&no_change))["restock_policy"]["last_restock_world_minute"], 180);
}

#[test]
fn clock_plans_each_merchant_and_ignores_disabled() {
    let due = clock_merchant(json!({ "id": "due", "restock_policy": { "enabled": true, "interval_minutes": 60, "targets": [{ "stock_id": "rope", "target_quantity": 2 }] } }));
    let disabled = clock_merchant(json!({ "id": "disabled", "restock_policy": { "enabled": false, "interval_minutes": 60, "targets": [{ "stock_id": "rope", "target_quantity": 2 }] } }));
    let plans = plan_merchant_economy_clock(&json!({ "mechanics": { "world_time": { "elapsed_minutes": 60 } }, "merchants": [due, disabled] }), None);
    assert_eq!(plans.len(), 1);
    assert_eq!((plans[0]["merchant_id"].as_str(), plans[0]["total_quantity_added"].as_i64()), (Some("due"), Some(1)));
}

// ---------- test/merchant-lifecycle.test.mjs ----------

#[test]
fn pricing_is_bounded_and_legacy_merchant_gets_default_purse() {
    let pricing = normalize_merchant_pricing(Some(&json!({ "mode": "catalog_with_agent_adjustment", "buy_markup_bps": 999_999, "sell_rate_bps": 5_000, "bargain_dc": 99, "agent_adjustment_bps": 999_999, "agent_adjustment_limit_percent": 999 })));
    assert_eq!((pricing["buy_markup_bps"].as_i64(), pricing["bargain_dc"].as_i64()), (Some(30_000), Some(30)));
    assert_eq!((pricing["agent_adjustment_limit_percent"].as_i64(), pricing["agent_adjustment_bps"].as_i64()), (Some(50), Some(5_000)));
    let legacy = normalize_merchant(Some(&json!({ "id": "legacy", "name": "Старый купец", "location": "Рыночная площадь", "stock": [] })), 0);
    assert_eq!(legacy["purse_cp"], DEFAULT_MERCHANT_PURSE_CP);
    let custom = normalize_merchant(Some(&json!({ "id": "m", "stock": [{ "stock_id": "ring", "catalog_id": "homebrew:ring", "quantity": 1 }] })), 0);
    assert_eq!(custom["stock"], json!([]), "самодельный товар без подтверждённой цены на склад не попадает");
}

// ---------- test/merchant-appraisal.test.mjs ----------

fn moon_shard() -> Value {
    item(json!({
        "id": "moon-shard", "name": "Осколок лунного клинка", "type": "treasure", "rarity": "редкий", "quantity": 2, "equipped": false,
        "base_price_cp": 99_999_999, "price_provenance": "server_appraisal_policy", "appraisal_policy_id": "agent:choose-any-price:v1",
        "appraisal": { "authoritative": true, "base_price_cp": 99_999_999, "appraisal_fingerprint": "f".repeat(64) },
    }))
}

/// Запись реестра оценок, как её кладёт `AppraiseItem` Rules Engine.
fn appraisal_record(item: &Value) -> Value {
    let stack_key = inventory_stack_key(Some(item));
    let digest = stack_key.rsplit(':').next().unwrap_or("custom").to_string();
    let mut appraisal = appraise_item(
        Some(&json!({ "homebrew_id": format!("homebrew:{digest}"), "name": item["name"], "category": "treasure", "rarity": "rare", "condition": "serviceable" })),
        Some(&json!({ "policyId": CATEGORY_APPRAISAL_POLICY_ID })),
    )
    .expect("оценка");
    let fingerprint = appraisal["appraisal_fingerprint"].as_str().unwrap_or_default()[..24].to_string();
    for (key, value) in [("appraisal_id", json!(format!("appraisal:{fingerprint}"))), ("actor_id", json!("hero")), ("merchant_id", json!("marten")), ("item_id", item["id"].clone()), ("item_stack_key", json!(stack_key))] {
        appraisal[key] = value;
    }
    appraisal
}

fn appraisal_state(purse_cp: i64, appraised: bool) -> Value {
    let shard = moon_shard();
    let registry = if appraised { json!({ "hero": { "moon-shard": appraisal_record(&shard) } }) } else { json!({}) };
    let merchant = normalize_merchant(Some(&json!({ "id": "marten", "name": "Мартен", "location": "Рыночная площадь", "available": true, "purse_cp": purse_cp, "pricing": { "buy_markup_bps": 11_000, "sell_rate_bps": 5_000, "bargain_dc": 15, "min_multiplier_bps": 1_000, "max_multiplier_bps": 30_000 }, "stock": [] })), 0);
    json!({
        "state_version": 0,
        "scene": { "title": "Рынок", "location": "Рыночная площадь" },
        "players": [{ "id": "hero", "currency": { "copper": 0, "silver": 0, "gold": 0, "platinum": 0 }, "inventory": [shard] }],
        "merchants": [merchant],
        "mechanics": { "item_appraisals": registry },
    })
}

#[test]
fn snapshot_price_is_ignored_until_server_appraisal() {
    let before = sell_quote(&view_of(&appraisal_state(12_500, false)), "moon-shard").clone();
    assert_eq!((before["unit_price_cp"].as_i64(), before["can_sell"].as_bool(), before["appraisal_required"].as_bool(), before["can_appraise"].as_bool()), (Some(0), Some(false), Some(true), Some(true)));
    let after = sell_quote(&view_of(&appraisal_state(12_500, true)), "moon-shard").clone();
    assert_eq!((after["unit_price_cp"].as_i64(), after["price_provenance"].as_str()), (Some(6_250), Some("server_appraisal_policy")));
    assert_eq!((after["appraisal_required"].as_bool(), after["can_appraise"].as_bool(), after["can_sell"].as_bool(), after["max_quantity"].as_i64()), (Some(false), Some(false), Some(true), Some(2)));
    let poor = sell_quote(&view_of(&appraisal_state(6_249, true)), "moon-shard").clone();
    assert_eq!((poor["unit_price_cp"].as_i64(), poor["can_afford"].as_bool(), poor["can_sell"].as_bool(), poor["max_quantity"].as_i64()), (Some(6_250), Some(false), Some(false), Some(0)));
}

#[test]
fn quest_item_is_neither_sellable_nor_appraisable() {
    let mut state = appraisal_state(12_500, false);
    state["players"][0]["inventory"] = json!([item(json!({ "id": "royal-letter", "name": "Письмо короля", "type": "document", "rarity": "сюжетный", "quest_item": true, "quantity": 1 }))]);
    let quote = sell_quote(&view_of(&state), "royal-letter").clone();
    assert_eq!((quote["can_sell"].as_bool(), quote["can_appraise"].as_bool(), quote["appraisal_required"].as_bool()), (Some(false), Some(false), Some(false)));
}

#[test]
fn appraised_resale_stock_keeps_authority() {
    let shard = moon_shard();
    let mut resale = shard.clone();
    resale["stock_id"] = json!("resale-moon-shard");
    resale["appraisal"] = appraisal_record(&shard);
    let mut state = appraisal_state(0, false);
    state["players"][0]["inventory"] = json!([]);
    state["players"][0]["currency"] = json!({ "gold": 100 });
    state["merchants"][0] = normalize_merchant(Some(&json!({ "id": "marten", "name": "Мартен", "location": "Рыночная площадь", "purse_cp": 0, "pricing": { "buy_markup_bps": 11_000, "sell_rate_bps": 5_000 }, "stock": [resale] })), 0);
    let stock = &state["merchants"][0]["stock"][0];
    assert_eq!((stock["base_price_cp"].as_i64(), stock["appraisal"]["base_price_cp"].as_i64()), (Some(6_250), Some(6_250)));
    let view = view_of(&state);
    let quote = view["buy_quotes"].as_array().and_then(|quotes| quotes.iter().find(|quote| quote["stock_id"] == "resale-moon-shard")).expect("котировка");
    assert_eq!((quote["unit_price_cp"].as_i64(), quote["max_quantity"].as_i64()), (Some(6_875), Some(1)));
}

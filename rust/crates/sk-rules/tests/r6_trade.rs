//! Перенесённые проверки JS торговли (`test/merchant-lifecycle.test.mjs`,
//! `test/merchant-appraisal.test.mjs`): жизненный цикл торговцев и оценка
//! вещи — команда, проверка, ветка разбора, события и редьюсер.
//!
//! Разбор идёт без хвоста последствий (задача Р5) и с пропуском блоков
//! проверки, которые ещё заглушки: у команд торговли хвост событий не
//! добавляет, а заглушки других задач их не касаются.

use serde_json::{json, Value};
use sk_dice::{DiceService, SequenceRng};
use sk_economy::merchant_economy::{merchant_view_for, DEFAULT_MERCHANT_PURSE_CP, ECONOMY_POLICY_ID, MAX_CURRENCY_CP};
use sk_rules::context::{sequence_uuids, Context};
use sk_rules::dice_record::ServiceDice;
use sk_rules::normalize::normalize_campaign_state;
use sk_rules::pause::Interrupt;
use sk_rules::validate::{Validation, BLOCKS};

/// `resolveCommand(input, state, { context })` без хвоста.
fn resolve(input: Value, state: &Value, context: Value) -> Result<(Value, Vec<Value>), Interrupt> {
    let context = Context::from_json(&context);
    let validated_state = normalize_campaign_state(&normalize_campaign_state(state)?)?;
    let mut uuid = sequence_uuids("uuid");
    let command = sk_rules::command::normalize::normalize_command(&input, &validated_state, &mut uuid)?;
    let mut validation = Validation { state: &validated_state, command, context: &context, actor_fate: None };
    for block in BLOCKS {
        match (block.check)(&mut validation) {
            Ok(()) => {}
            Err(halt) if halt.is_unported() => {}
            Err(halt) => return Err(halt.into()),
        }
    }
    let mut dice = ServiceDice::new(DiceService::deterministic(SequenceRng::new(Vec::new()), "roll"));
    let resolved = sk_rules::resolve::vitals::resolve_branch_without_tail(validation.command, state, &mut dice, &context, &mut uuid)?;
    Ok((resolved.command, resolved.events))
}

fn reduce(state: &Value, events: &[Value]) -> Value {
    events.iter().fold(state.clone(), |state, event| sk_rules::replay::apply_game_event(&state, event).expect("событие применяется"))
}

fn code<T>(result: Result<T, Interrupt>) -> String {
    match result {
        Ok(_) => "ok".into(),
        Err(halt) => halt.code().unwrap_or("?").to_string(),
    }
}

fn admin() -> Value {
    json!({ "isAdmin": true })
}

fn base_state(overrides: Value) -> Value {
    let mut state = json!({
        "sessionCode": "SHOP-LIFECYCLE", "state_version": 0, "engine_mode": "enforce",
        "scene": { "location": "Рыночная площадь" }, "players": [], "merchants": [],
    });
    sk_core::js::assign(&mut state, overrides);
    normalize_campaign_state(&state).expect("нормализация")
}

fn create_command(merchant_patch: Value, command_patch: Value) -> Value {
    let mut merchant = json!({
        "id": "marten.shop", "name": "  Мартен Рыжий  ", "title": "Поставщик припасов", "description": "Торговец из серверного каталога.",
        "greeting": "Подходите ближе.", "voice": "Говорит дружелюбно.", "location": "Рыночная площадь", "available": true, "purse_cp": 12_345,
        "pricing": { "mode": "catalog_with_agent_adjustment", "buy_markup_bps": 999_999, "sell_rate_bps": 5_000, "bargain_dc": 99, "agent_adjustment_bps": 999_999, "agent_adjustment_limit_percent": 999 },
        "stock": [{ "stock_id": "healing-potion", "catalog_id": "srd_5_2_1:potion-of-healing", "quantity": 2, "name": "Зелье лечения", "type": "consumable" }],
    });
    sk_core::js::assign(&mut merchant, merchant_patch);
    let mut command = json!({ "command_type": "CreateMerchant", "command_id": "create-marten", "expected_state_version": 0, "request_fingerprint": "fingerprint-create", "merchant": merchant });
    sk_core::js::assign(&mut command, command_patch);
    command
}

#[test]
fn lifecycle_commands_require_admin_and_no_actor() {
    let state = base_state(json!({ "merchants": [{ "id": "existing", "name": "Купец", "location": "Рыночная площадь", "stock": [] }] }));
    let commands = [
        create_command(json!({}), json!({})),
        json!({ "command_type": "ConfigureMerchant", "merchant_id": "existing", "configuration": { "name": "Новое имя" } }),
        json!({ "command_type": "RestockMerchant", "merchant_id": "existing", "items": [{ "stock_id": "torch", "catalog_id": "srd_5_2_1:torch", "quantity": 1 }] }),
        json!({ "command_type": "MoveMerchant", "merchant_id": "existing", "location": "Южные ворота" }),
        json!({ "command_type": "SetMerchantAvailability", "merchant_id": "existing", "available": false }),
    ];
    for command in commands {
        assert_eq!(code(resolve(command, &state, json!({ "isAdmin": false }))), "MERCHANT_MANAGEMENT_FORBIDDEN");
    }
    let (command, events) = resolve(json!({ "command_type": "SetMerchantAvailability", "merchant_id": "existing", "available": false }), &state, admin()).expect("разбор");
    assert_eq!(command["actor_id"], Value::Null);
    assert_eq!(events[0]["target_ids"], json!([]));
}

#[test]
fn create_merchant_accepts_safe_schema_with_bounded_pricing() {
    let initial = base_state(json!({}));
    let (_, events) = resolve(create_command(json!({}), json!({})), &initial, admin()).expect("разбор");
    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert_eq!(event["event_type"], "MerchantCreated");
    assert_eq!(event["actor_id"], Value::Null);
    assert_eq!(event["house_rule_id"], ECONOMY_POLICY_ID);
    let merchant = &event["payload"]["merchant"];
    assert_eq!(event["payload"]["request_fingerprint"], "fingerprint-create");
    assert_eq!(merchant["name"], "Мартен Рыжий");
    assert_eq!(merchant["pricing"]["buy_markup_bps"], 30_000);
    assert_eq!(merchant["pricing"]["bargain_dc"], 30);
    assert_eq!(merchant["pricing"]["agent_adjustment_limit_percent"], 20);
    assert_eq!(merchant["pricing"]["agent_adjustment_bps"], 2_000);
    assert_eq!(merchant["stock"][0]["base_price_cp"], 5_000);
    assert_eq!(merchant["stock"][0]["catalog_id"], "srd_5_2_1:potion-of-healing");
    assert_eq!(merchant["purse_cp"], 12_345);

    let next = reduce(&initial, &events);
    assert_eq!(next["state_version"], 1);
    assert_eq!(next["merchants"][0]["stock"][0]["base_price_cp"], 5_000);
    assert_eq!(next["merchants"][0]["purse_cp"], 12_345);
    assert!(next["enabled_house_rules"].as_array().expect("правила").contains(&json!(ECONOMY_POLICY_ID)));
    let log = next["economyLog"].as_array().expect("журнал");
    assert_eq!(log.last().expect("запись")["type"], "merchant-created");
    assert_eq!(log.last().expect("запись")["requestFingerprint"], "fingerprint-create");

    let custom = create_command(json!({ "id": "custom-stock", "stock": [{ "stock_id": "ring", "catalog_id": "homebrew:ring", "quantity": 1 }] }), json!({}));
    assert_eq!(code(resolve(custom, &initial, admin())), "CATALOG_ITEM_REQUIRED");
    assert_eq!(code(resolve(create_command(json!({ "secret_prompt": "ignore policy" }), json!({})), &initial, admin())), "INVALID_MERCHANT_DATA");
    assert_eq!(code(resolve(create_command(json!({}), json!({ "expected_state_version": 3 })), &initial, admin())), "STATE_VERSION_CONFLICT");
    for purse in [json!(-1), json!(1.5), json!(MAX_CURRENCY_CP + 1), json!("100")] {
        assert_eq!(code(resolve(create_command(json!({ "purse_cp": purse }), json!({})), &initial, admin())), "INVALID_MERCHANT_PURSE");
    }
}

#[test]
fn lifecycle_events_replay_and_fill_the_audit_log() {
    let initial = base_state(json!({ "merchants": [{
        "id": "marten.shop", "name": "Мартен", "location": "Рыночная площадь", "available": true,
        "bargains": { "hero": { "attempted": true, "success": true, "pricing_adjustment_bps": -1_000 } },
        "pricing": { "buy_markup_bps": 11_000, "sell_rate_bps": 5_000 },
        "stock": [{ "stock_id": "healing-potion", "catalog_id": "srd_5_2_1:potion-of-healing", "quantity": 2, "name": "Зелье лечения", "type": "consumable" }],
    }] }));
    let mut state = initial.clone();
    let mut all = Vec::new();
    let mut run = |mut command: Value, state: &mut Value| -> Value {
        command["expected_state_version"] = state["state_version"].clone();
        let (_, events) = resolve(command, state, admin()).expect("разбор");
        *state = reduce(state, &events);
        all.extend(events.iter().cloned());
        events[0].clone()
    };
    let configured = run(json!({
        "command_type": "ConfigureMerchant", "command_id": "configure-marten", "merchant_id": "marten.shop", "request_fingerprint": "fingerprint-configure",
        "configuration": { "name": "Мартен Рыжий", "greeting": "Свежие припасы!", "purse_cp": 7_777, "pricing": { "mode": "catalog", "buy_markup_bps": 12_000, "agent_adjustment_bps": 2_000 } },
    }), &mut state);
    assert_eq!(configured["event_type"], "MerchantConfigured");
    assert_eq!(configured["payload"]["request_fingerprint"], "fingerprint-configure");
    assert_eq!(state["merchants"][0]["pricing"]["mode"], "catalog");
    assert_eq!(state["merchants"][0]["pricing"]["agent_adjustment_bps"], 0);
    assert_eq!(state["merchants"][0]["purse_cp"], 7_777);
    assert_eq!(state["merchants"][0]["bargains"], json!({}));

    let restocked = run(json!({
        "command_type": "RestockMerchant", "command_id": "restock-marten", "merchant_id": "marten.shop", "request_fingerprint": "fingerprint-restock",
        "items": [{ "stock_id": "healing-potion", "quantity": 3 }, { "stock_id": "torches", "catalog_id": "srd_5_2_1:torch", "quantity": 4, "name": "Факелы", "type": "tool" }],
    }), &mut state);
    assert_eq!(restocked["event_type"], "MerchantRestocked");
    assert_eq!(restocked["payload"]["total_quantity_added"], 7);
    let stock = |state: &Value, id: &str| state["merchants"][0]["stock"].as_array().expect("склад").iter().find(|entry| entry["stock_id"] == id).cloned().expect("позиция");
    assert_eq!(stock(&state, "healing-potion")["quantity"], 5);
    assert_eq!(stock(&state, "torches")["quantity"], 4);
    assert_eq!(stock(&state, "torches")["base_price_cp"], 1);

    let moved = run(json!({ "command_type": "MoveMerchant", "command_id": "move-marten", "merchant_id": "marten.shop", "location": "Южные ворота", "request_fingerprint": "fingerprint-move" }), &mut state);
    assert_eq!(moved["event_type"], "MerchantMoved");
    assert_eq!(moved["payload"]["location_before"], "Рыночная площадь");
    assert_eq!(moved["payload"]["location_after"], "Южные ворота");

    let hidden = run(json!({ "command_type": "SetMerchantAvailability", "command_id": "hide-marten", "merchant_id": "marten.shop", "available": false, "request_fingerprint": "fingerprint-availability" }), &mut state);
    assert_eq!(hidden["event_type"], "MerchantAvailabilityChanged");
    assert_eq!(state["merchants"][0]["available"], false);
    assert_eq!(state["merchants"][0]["location"], "Южные ворота");
    let log: Vec<Value> = state["economyLog"].as_array().expect("журнал").iter().rev().take(4).rev().map(|entry| entry["type"].clone()).collect();
    assert_eq!(log, vec![json!("merchant-configured"), json!("merchant-restocked"), json!("merchant-moved"), json!("merchant-availability")]);
    assert_eq!(sk_rules::replay::replay_events(&initial, &all).expect("replay"), state);
}

#[test]
fn legacy_merchant_gets_default_purse() {
    let state = base_state(json!({ "merchants": [{ "id": "legacy", "name": "Старый купец", "location": "Рыночная площадь", "stock": [] }] }));
    assert_eq!(state["merchants"][0]["purse_cp"], DEFAULT_MERCHANT_PURSE_CP);
}

#[test]
fn restock_keeps_catalog_and_rejects_custom_and_overflow() {
    let initial = base_state(json!({ "merchants": [{ "id": "marten.shop", "name": "Мартен", "location": "Рыночная площадь", "stock": [{ "stock_id": "potion", "catalog_id": "srd_5_2_1:potion-of-healing", "quantity": 1, "name": "Зелье" }] }] }));
    let restock = |items: Value| code(resolve(json!({ "command_type": "RestockMerchant", "merchant_id": "marten.shop", "items": items }), &initial, admin()));
    assert_eq!(restock(json!([{ "stock_id": "potion", "catalog_id": "srd_5_2_1:torch", "quantity": 1 }])), "STOCK_CATALOG_MISMATCH");
    assert_eq!(restock(json!([{ "stock_id": "custom", "catalog_id": "homebrew:item", "quantity": 1 }])), "CATALOG_ITEM_REQUIRED");
    assert_eq!(restock(json!([{ "stock_id": "potion", "quantity": 999_999 }])), "STOCK_LIMIT_EXCEEDED");
    assert_eq!(code(resolve(json!({ "command_type": "SetMerchantAvailability", "merchant_id": "marten.shop", "available": "false" }), &initial, admin())), "INVALID_MERCHANT_AVAILABILITY");
}

fn appraisal_state(item_patch: Value, purse: i64) -> Value {
    let mut item = json!({
        "id": "moon-shard", "name": "Осколок лунного клинка", "type": "treasure", "rarity": "редкий", "quantity": 2, "equipped": false,
        "base_price_cp": 99_999_999, "price_provenance": "server_appraisal_policy", "appraisal_policy_id": "agent:choose-any-price:v1",
        "appraisal": { "authoritative": true, "base_price_cp": 99_999_999, "appraisal_fingerprint": "f".repeat(64) },
    });
    sk_core::js::assign(&mut item, item_patch);
    normalize_campaign_state(&json!({
        "sessionCode": "APPRAISAL-UNIT", "state_version": 0, "engine_mode": "enforce",
        "scene": { "title": "Рынок", "location": "Рыночная площадь", "cells": [] },
        "players": [{ "id": "hero", "name": "Игрок", "character": "Астер", "hp": 10, "maxHp": 10, "armor": 12, "abilities": { "cha": 14 }, "currency": { "copper": 0, "silver": 0, "gold": 0, "platinum": 0 }, "inventory": [item] }],
        "merchants": [{ "id": "marten", "name": "Мартен", "location": "Рыночная площадь", "available": true, "purse_cp": purse,
            "pricing": { "buy_markup_bps": 11_000, "sell_rate_bps": 5_000, "bargain_dc": 15, "min_multiplier_bps": 1_000, "max_multiplier_bps": 30_000 }, "stock": [] }],
    }))
    .expect("нормализация")
}

fn trade(kind: &str, patch: Value) -> Value {
    let mut command = json!({ "command_type": kind, "actor_id": "hero", "merchant_id": "marten" });
    sk_core::js::assign(&mut command, patch);
    command
}

fn sell_quote(state: &Value, item_id: &str) -> Value {
    let view = merchant_view_for(state, Some(&json!("marten")), Some(&json!("hero"))).expect("витрина");
    view["sell_quotes"].as_array().expect("котировки").iter().find(|quote| quote["item_id"] == item_id).cloned().expect("котировка")
}

#[test]
fn appraisal_is_a_replayable_registry_attestation() {
    let state = appraisal_state(json!({}), 12_500);
    let before = sell_quote(&state, "moon-shard");
    assert_eq!((before["unit_price_cp"].clone(), before["can_sell"].clone(), before["appraisal_required"].clone(), before["can_appraise"].clone()), (json!(0), json!(false), json!(true), json!(true)));
    assert_eq!(code(resolve(trade("SellItem", json!({ "item_id": "moon-shard", "quantity": 1 })), &state, json!({}))), "ITEM_NOT_SELLABLE");
    let injected = json!({ "item_id": "moon-shard", "price_cp": 1, "base_price_cp": 1, "estimated_price_cp": 1, "price_provenance": "client", "appraisal_policy_id": "agent:free-price:v1", "appraisal": { "authoritative": true, "base_price_cp": 1 } });
    let (_, events) = resolve(trade("AppraiseItem", injected), &state, json!({})).expect("оценка");
    assert_eq!(events.len(), 1);
    let payload = &events[0]["payload"];
    assert_eq!(events[0]["event_type"], "MerchantItemAppraised");
    assert_eq!(payload["base_unit_price_cp"], 6_250);
    assert_eq!(payload["appraisal"]["base_price_cp"], 6_250);
    assert_eq!(payload["appraisal"]["provenance"], "server_appraisal_policy");
    assert_eq!(payload["appraisal"]["policy_id"], "skazanie:item-appraisal:category-rarity-condition:v1");
    let fingerprint = payload["appraisal"]["appraisal_fingerprint"].as_str().expect("отпечаток");
    assert!(fingerprint.len() == 64 && fingerprint.chars().all(|ch| ch.is_ascii_hexdigit()));
    let next = reduce(&state, &events);
    assert_eq!(next["mechanics"]["item_appraisals"]["hero"]["moon-shard"]["base_price_cp"], 6_250);
    assert_eq!(next["economyLog"].as_array().and_then(|log| log.last()).expect("запись")["type"], "appraisal");
    let priced = sell_quote(&next, "moon-shard");
    assert_eq!((priced["unit_price_cp"].clone(), priced["can_sell"].clone(), priced["max_quantity"].clone()), (json!(6_250), json!(true), json!(2)));
    assert_eq!(code(resolve(trade("AppraiseItem", json!({ "item_id": "moon-shard" })), &next, json!({}))), "ITEM_ALREADY_APPRAISED");
}

#[test]
fn appraisal_rejects_catalog_and_quest_items() {
    let catalog = appraisal_state(json!({ "id": "dagger", "catalog_id": "srd_5_2_1:dagger", "name": "Кинжал", "type": "weapon", "rarity": "обычный", "quantity": 1 }), 12_500);
    assert_eq!(code(resolve(trade("AppraiseItem", json!({ "item_id": "dagger" })), &catalog, json!({}))), "APPRAISAL_NOT_REQUIRED");
    let quest = appraisal_state(json!({ "id": "royal-letter", "name": "Письмо короля", "type": "document", "rarity": "сюжетный", "quest_item": true, "quantity": 1 }), 12_500);
    assert_eq!(code(resolve(trade("AppraiseItem", json!({ "item_id": "royal-letter" })), &quest, json!({}))), "ITEM_NOT_APPRAISABLE");
}

#[test]
fn merchant_purse_bounds_sales() {
    let state = appraisal_state(json!({}), 6_249);
    let (_, events) = resolve(trade("AppraiseItem", json!({ "item_id": "moon-shard" })), &state, json!({})).expect("оценка");
    let appraised = reduce(&state, &events);
    assert_eq!(code(resolve(trade("SellItem", json!({ "item_id": "moon-shard", "quantity": 1 })), &appraised, json!({}))), "INSUFFICIENT_MERCHANT_FUNDS");
}

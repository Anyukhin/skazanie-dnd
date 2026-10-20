//! Сверка задачи Р6 с эталоном JS (`fixtures/r6.json.gz`, генератор —
//! `fixtures/gen-r6.mjs`): помощники торговли, блоки `validateCommand` 9, 10,
//! 18–24, 27, 33, 41–46, 49, 63, 64, ветки разбора сцены, кампании, героя,
//! торговли и сценария без хвоста последствий, ветки редьюсера `Merchant*`.
//!
//! Состояния — из корпуса паритета (лежат в эталоне), с заплатками `p`
//! (`[[путь…], значение]`). Выход длиннее 200 знаков сверяется по sha256
//! строки `JSON.stringify`. Ветка, которая доходит до заглушки другой задачи
//! (вложенный `MakeAbilityCheck` — Р5), считается отдельно и не валит тест:
//! она сверится, когда Р5 будет слита.

use std::io::Read;
use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_core::{hash, js, RuleError};
use sk_dice::{DiceService, SequenceRng};
use sk_rules::context::{sequence_uuids, Context};
use sk_rules::dice_record::ServiceDice;
use sk_rules::merchants as m;
use sk_rules::normalize::normalize_campaign_state;
use sk_rules::pause::Halt;
use sk_rules::validate::{Validation, BLOCKS};

const FIXTURE: &[u8] = include_bytes!("../fixtures/r6.json.gz");
static DATA: LazyLock<Value> = LazyLock::new(|| {
    let mut text = String::new();
    flate2::read::GzDecoder::new(FIXTURE).read_to_string(&mut text).expect("эталон — gzip");
    serde_json::from_str(&text).expect("эталон — JSON")
});

const U: &str = "__undefined__";

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `out(value)` генератора: длинный JSON — `sha256:` строки.
fn out(value: &Value) -> Value {
    let text = js::stringify(value);
    if utf16_len(&text) > 200 {
        Value::String(format!("sha256:{}", hash::sha256_hex(text.as_bytes())))
    } else {
        value.clone()
    }
}

fn sha(value: &Value) -> String {
    hash::sha256_hex(js::stringify(value).as_bytes())
}

fn rule_outcome(result: Result<Value, RuleError>) -> Value {
    match result {
        Ok(value) => json!({ "ok": out(&value) }),
        Err(error) => json!({ "err": [error.code, error.message] }),
    }
}

fn halt_outcome(result: Result<Value, Halt>) -> Value {
    match result {
        Ok(value) => json!({ "ok": out(&value) }),
        Err(Halt::Rule(error)) => json!({ "err": [error.code, error.message] }),
        Err(Halt::Fault(fault)) => json!({ "fault": fault.name, "code": fault.code }),
        Err(Halt::Pause(pause)) => json!({ "fault": pause.kind.name(), "code": null }),
    }
}

/// Выход эталона без текста ошибки JS (у `fault` сверяются имя и код).
fn expected(case: &Value) -> Value {
    let o = case.get("o").unwrap_or(case);
    if let Some(fault) = o.get("fault") {
        return json!({ "fault": fault, "code": o.get("code").cloned().unwrap_or(Value::Null) });
    }
    if let Some(err) = o.get("err") {
        return json!({ "err": err });
    }
    json!({ "ok": o.get("ok").cloned().unwrap_or(Value::Null) })
}

fn same(actual: &Value, expected: &Value) -> bool {
    js::stringify(actual) == js::stringify(expected)
}

fn report(name: &str, failures: &[String], total: usize) {
    assert!(total > 0, "{name}: нет случаев");
    assert!(failures.is_empty(), "{name}: {} из {total} расходятся:\n{}", failures.len(), failures.iter().take(25).cloned().collect::<Vec<_>>().join("\n"));
}

fn arg(case: &Value, index: usize) -> Option<&Value> {
    case["a"].get(index).filter(|value| value.as_str() != Some(U))
}

#[test]
fn merchant_helpers_match_js() {
    let cases = DATA["calls"].as_array().expect("вызовы");
    let mut failures = Vec::new();
    for case in cases {
        let a = |index| arg(case, index);
        let f = case["f"].as_str().unwrap_or_default();
        let actual = match f {
            "normalizeLifecycleMerchant" => rule_outcome(m::normalize_lifecycle_merchant(a(0))),
            "lifecycleMerchantFromCanonical" => rule_outcome(m::lifecycle_merchant_from_canonical(a(0))),
            "normalizeLifecyclePricing" => rule_outcome(m::normalize_lifecycle_pricing(a(0), a(1))),
            "lifecyclePricingFromCanonical" => rule_outcome(m::lifecycle_pricing_from_canonical(a(0), a(1))),
            "normalizeLifecycleStockEntry" => rule_outcome(m::normalize_lifecycle_stock_entry(a(0), &js::s(a(1)), js::safe_int(a(2), 0) as usize)),
            "lifecycleStockFromCanonical" => rule_outcome(m::lifecycle_stock_from_canonical(a(0), &js::s(a(1)), js::safe_int(a(2), 0) as usize)),
            "normalizeLifecycleConfiguration" => rule_outcome(m::normalize_lifecycle_configuration(a(0), a(1))),
            "lifecycleConfigurationFromCanonical" => rule_outcome(m::lifecycle_configuration_from_canonical(a(0), a(1))),
            "normalizeLifecycleRestock" => rule_outcome(m::normalize_lifecycle_restock(a(0), a(1).unwrap_or(&Value::Null)).map(Value::Array)),
            "appraisalCategory" => json!({ "ok": out(&json!(m::appraisal_category(a(0)))) }),
            "appraisalBlocked" => json!({ "ok": m::appraisal_blocked(a(0)) }),
            "appraisalForInventoryItem" => halt_outcome(m::appraisal_for_inventory_item(a(0).unwrap_or(&Value::Null), a(1).unwrap_or(&Value::Null), a(2).unwrap_or(&Value::Null))),
            "merchantStock" => json!({ "ok": out(&m::merchant_stock(a(0), a(1)).cloned().unwrap_or(Value::Null)) }),
            "checkedTransactionTotal" => rule_outcome(m::checked_transaction_total(a(0), a(1)).map(Value::from)),
            other => panic!("неизвестная функция {other}"),
        };
        let wanted = expected(case);
        if !same(&actual, &wanted) {
            failures.push(format!("{f} {}: Rust {} JS {}", js::stringify(&case["a"]).chars().take(300).collect::<String>(), actual, wanted));
        }
    }
    report("помощники", &failures, cases.len());
}

/// Состояние случая: сохранённое состояние с заплатками.
fn state_of(case: &Value) -> Value {
    let index = case["s"].as_u64().expect("индекс состояния") as usize;
    let mut state = DATA["states"][index].clone();
    for patch in case["p"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
        let path: Vec<&str> = patch[0].as_array().expect("путь").iter().filter_map(Value::as_str).collect();
        let mut target = &mut state;
        for key in &path[..path.len() - 1] {
            if !target.get(*key).is_some_and(Value::is_object) {
                target[*key] = json!({});
            }
            target = &mut target[*key];
        }
        target[path[path.len() - 1]] = patch[1].clone();
    }
    state
}

/// Имя блока эталона → имя блока каркаса.
fn block_name(block: &str) -> &'static str {
    match block {
        "b9" => "check_world_memory",
        "b10" => "check_npc_social",
        "b18" => "check_scenario_purse",
        "b19" => "check_scenario_informant",
        "b20" => "check_dialogue",
        "b21" => "check_scenario_armory",
        "b22" => "check_scenario_treaty",
        "b23" => "check_scenario_knight",
        "b24" => "check_scenario_stranger",
        "b27" => "check_character_build",
        "b33" => "check_character_lifecycle",
        "b41" => "check_quest_decision",
        "b42" => "check_complete_campaign",
        "b43" => "check_advance_campaign_arc",
        "b44" => "check_import_location_map",
        "b45" => "check_rebuild_location_map",
        "b46" => "check_advance_scene",
        "b49" => "check_merchant_lifecycle",
        "b63" => "check_trade",
        "b64" => "check_pickpocket",
        other => panic!("неизвестный блок {other}"),
    }
}

#[test]
fn validate_blocks_match_js() {
    let cases = DATA["blocks"].as_array().expect("блоки");
    let mut failures = Vec::new();
    // Нормализация — самое дорогое в тесте: состояние с теми же заплатками нормализуется один раз.
    let mut normalized: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    for (index, case) in cases.iter().enumerate() {
        let key = format!("{}:{}", case["s"], js::stringify(&case["p"]));
        let state = normalized
            .entry(key)
            .or_insert_with(|| {
                let raw = state_of(case);
                normalize_campaign_state(&normalize_campaign_state(&raw).expect("нормализация")).expect("нормализация")
            })
            .clone();
        let context = Context::from_json(&case["context"]);
        let name = block_name(case["block"].as_str().unwrap_or_default());
        let block = BLOCKS.iter().find(|block| block.name == name).expect("блок каркаса");
        let mut validation = Validation { state: &state, command: case["command"].clone(), context: &context, actor_fate: None };
        let result = (block.check)(&mut validation).map(|()| validation.command.clone());
        if let (Ok(command), Some(path)) = (&result, std::env::var_os("SK_R6_DUMP")) {
            // Отладка: полный выход Rust для расхождения пишется в файл.
            let _ = std::fs::write(std::path::Path::new(&path).join(format!("block-{index}.json")), js::stringify(command));
        }
        let actual = halt_outcome(result);
        let wanted = expected(case);
        if !same(&actual, &wanted) {
            failures.push(format!("#{index} {name} {}: Rust {} JS {}", js::stringify(&case["command"]).chars().take(300).collect::<String>(), actual, wanted));
        }
    }
    report("блоки", &failures, cases.len());
}

#[test]
fn resolve_branches_match_js() {
    sk_rules::merchants::install_talespire_importer(|slab, location_id, theme| {
        // Импортёр TaleSpire живёт в крейте выше `sk-rules`: в этом тесте его нет,
        // и случаи импорта карты проверяет сверка корпуса (`sk-corpus`).
        let _ = (slab, location_id, theme);
        Err(m::TaleSpireFailure { name: "TaleSpireImporterMissing".into(), code: "IMPORTER_MISSING".into(), message: String::new() })
    });
    let cases = DATA["branches"].as_array().expect("ветки");
    let mut failures = Vec::new();
    let mut waiting = 0;
    let mut checked = 0;
    for case in cases {
        // Ветка незнакомца — Р11 (`resolve/stranger.rs`, эталоны `r11.json.gz`).
        // Генератор Р6 исполнял в JS только ветки Р6, у незнакомца там нет
        // `case`, и эталон записал «ok без событий»; Р6 сверяет лишь блок 24.
        if js::s(case["command"].get("command_type")) == "StageScenarioStranger" {
            continue;
        }
        let raw = state_of(case);
        let context = Context::from_json(&case["context"]);
        let values: Vec<i64> = case["v"].as_array().expect("кости").iter().filter_map(Value::as_i64).collect();
        let mut dice = ServiceDice::new(DiceService::deterministic(SequenceRng::new(values), "roll"));
        let mut uuid = sequence_uuids("uuid");
        let result = sk_rules::resolve::vitals::resolve_branch_without_tail(case["command"].clone(), &raw, &mut dice, &context, &mut uuid);
        let kind = js::s(case["command"].get("command_type"));
        if matches!(&result, Err(halt) if halt.is_unported()) || (kind == "ImportLocationMap" && matches!(&result, Err(Halt::Fault(fault)) if fault.name == "TaleSpireImporterMissing")) {
            waiting += 1;
            continue;
        }
        checked += 1;
        let actual = match result {
            Ok(resolved) => {
                let types: Vec<Value> = resolved.events.iter().map(|event| event["event_type"].clone()).collect();
                json!({ "ok": { "sha": sha(&json!({ "events": resolved.events, "rolls": resolved.rolls })), "types": types } })
            }
            Err(halt) => halt_outcome(Err(halt)),
        };
        let wanted = expected(case);
        if !same(&actual, &wanted) {
            failures.push(format!("{kind} {}: Rust {} JS {}", js::stringify(&case["command"]).chars().take(300).collect::<String>(), actual, wanted));
        }
    }
    eprintln!("ветки: сверено {checked}, ждут Р5 или импортёра {waiting}");
    report("ветки", &failures, checked);
}

/// Проекция состояния после события торговца (как `projection` генератора).
fn projection(state: &Value) -> Value {
    let players: Vec<Value> = state
        .get("players")
        .and_then(Value::as_array)
        .map(|players| {
            players
                .iter()
                .map(|player| {
                    let mut player = player.clone();
                    if let Some(map) = player.as_object_mut() {
                        for field in ["combatSpells", "combatActions", "characterSheet", "inventoryLoad"] {
                            map.shift_remove(field);
                        }
                    }
                    player
                })
                .collect()
        })
        .unwrap_or_default();
    let mut map = serde_json::Map::new();
    for (key, value) in [("merchants", state.get("merchants")), ("economyLog", state.get("economyLog"))] {
        if let Some(value) = value {
            map.insert(key.into(), value.clone());
        }
    }
    map.insert("item_appraisals".into(), state.get("mechanics").and_then(|mechanics| mechanics.get("item_appraisals")).filter(|value| !value.is_null()).cloned().unwrap_or(Value::Null));
    map.insert("players".into(), Value::Array(players));
    if let Some(rules) = state.get("enabled_house_rules") {
        map.insert("enabled_house_rules".into(), rules.clone());
    }
    Value::Object(map)
}

#[test]
fn merchant_reducer_matches_js() {
    let cases = DATA["reduce"].as_array().expect("редьюсер");
    let mut failures = Vec::new();
    for case in cases {
        let state = DATA["states"][case["s"].as_u64().expect("индекс") as usize].clone();
        let actual = halt_outcome(sk_rules::replay::apply_game_event(&state, &case["event"]).map(|next| json!(sha(&projection(&next)))));
        let wanted = expected(case);
        if !same(&actual, &wanted) {
            failures.push(format!("{} {}: Rust {} JS {}", case["event"]["event_type"], js::stringify(&case["event"]["payload"]).chars().take(300).collect::<String>(), actual, wanted));
        }
    }
    report("редьюсер", &failures, cases.len());
}

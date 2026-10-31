//! Сверка задачи Р7 с эталоном JS (`fixtures/society-r7.json.gz`, генератор —
//! `fixtures/gen-society-r7.mjs`): блоки `validateCommand` 11–17, 25, 26;
//! ветки общества без хвоста последствий (события и броски — начало списков
//! JS); предпросмотры d20 и костей таверны, отказ молитвы, события
//! благословения; `eventSummary` и `actorNameResolver`.
//!
//! Эталон читается с диска (как у Р4б): без встроенного эталона тестовый
//! бинарник меньше и Smart App Control реже его блокирует.

use std::io::Read;
use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_dice::{DiceService, SequenceRng};
use sk_rules::context::{sequence_uuids, Context};
use sk_rules::dice_record::ServiceDice;
use sk_rules::pause::{Halt, Interrupt};
use sk_rules::preview_checks as preview;
use sk_rules::summary;
use sk_rules::validate::{Validation, BLOCKS};

static DATA: LazyLock<Value> = LazyLock::new(|| {
    let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/society-r7.json.gz")).expect("эталон читается");
    let mut text = String::new();
    flate2::read::GzDecoder::new(bytes.as_slice()).read_to_string(&mut text).expect("эталон — gzip");
    serde_json::from_str(&text).expect("эталон — JSON")
});

/// Состояния эталона после нормализации Rust (`normalizeCampaignState`).
static NORMALIZED: LazyLock<Vec<Value>> = LazyLock::new(|| {
    DATA["states"].as_array().expect("состояния").iter().map(|state| sk_rules::normalize::normalize_campaign_state(state).expect("нормализация")).collect()
});

const U: &str = "__undefined__";

/// Поля со значением `undefined` убираются (как `JSON.stringify`).
fn deep(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(map.iter().filter(|(_, field)| field.as_str() != Some(U)).map(|(key, field)| (key.clone(), deep(field))).collect()),
        Value::Array(items) => Value::Array(items.iter().map(deep).collect()),
        other => other.clone(),
    }
}

/// Аргумент: `None` — `undefined`.
fn arg(value: &Value) -> Option<Value> {
    if value.as_str() == Some(U) {
        None
    } else {
        Some(deep(value))
    }
}

fn sha(value: &Value) -> String {
    sk_core::hash::sha256_hex(js::stringify(value).as_bytes())
}

fn out(value: &Value) -> Value {
    let text = js::stringify(value);
    if text.encode_utf16().count() > 160 {
        Value::String(format!("sha256:{}", sk_core::hash::sha256_hex(text.as_bytes())))
    } else {
        value.clone()
    }
}

fn outcome<E: Into<Interrupt>>(result: Result<Value, E>, shape: impl Fn(&Value) -> Value) -> Value {
    match result.map_err(Into::into) {
        Ok(value) => json!({ "ok": shape(&value) }),
        Err(Interrupt::Rule(error)) => json!({ "err": [error.code, error.message] }),
        Err(Interrupt::Fault(fault)) => json!({ "fault": fault.name }),
        Err(Interrupt::Pause(pause)) => json!({ "fault": pause.kind.name() }),
    }
}

/// Выход эталона без текста ошибки JS (тексты `TypeError` у V8 и Rust разные).
fn expected_outcome(case: &Value) -> Value {
    let mut expected = Map::new();
    for key in ["ok", "err"] {
        if let Some(value) = case.get(key) {
            expected.insert(key.into(), value.clone());
        }
    }
    if let Some(name) = case.get("fault") {
        expected.insert("fault".into(), name.clone());
    }
    Value::Object(expected)
}

fn report(name: &str, failures: &[String], total: usize) {
    assert!(failures.is_empty(), "{name}: расхождений {} из {total}:\n{}", failures.len(), failures.iter().take(10).cloned().collect::<Vec<_>>().join("\n"));
}

#[test]
fn rust_normalization_matches_js_on_fixture_states() {
    let expected = DATA["normalized_sha"].as_array().expect("хеши");
    // JS хранит производные поля героя значениями, Rust — пустыми слотами
    // (урок 2): сверяется состояние с вычисленными полями.
    let failures: Vec<String> = NORMALIZED.iter().zip(expected).enumerate().filter(|(_, (state, sha_js))| sha(&sk_rules::derived::materialized_state(state)) != sha_js.as_str().unwrap_or_default()).map(|(index, _)| format!("состояние {index}")).collect();
    report("нормализация", &failures, expected.len());
}

#[test]
fn validate_blocks_match_js() {
    let commands = DATA["commands"].as_array().expect("команды");
    let cases = DATA["blocks"].as_array().expect("блоки");
    let mut failures = Vec::new();
    for case in cases {
        let input = &commands[case["input"].as_u64().expect("индекс") as usize];
        // `s` случая — та же команда в чужом состоянии.
        let state = &NORMALIZED[case.get("s").unwrap_or(&input["s"]).as_u64().expect("состояние") as usize];
        let context = Context::from_json(&input["context"]);
        let wanted = match case["block"].as_str().expect("блок") {
            "b11" => "check_npc_world",
            "b12" => "check_captive",
            "b13" => "check_loot_container",
            "b14" => "check_beast",
            "b15" => "check_parley",
            "b16" => "check_law",
            "b17" => "check_tavern",
            "b25" => "check_blessing",
            "b26" => "check_courier_letter",
            other => panic!("блок {other}"),
        };
        let check = BLOCKS.iter().find(|block| block.name == wanted).map(|block| block.check).expect("блок в таблице");
        let mut validation = Validation { state, command: input["command"].clone(), context: &context, actor_fate: None };
        let result = check(&mut validation).map(|()| validation.command.clone());
        let actual = outcome(result, out);
        let expected = expected_outcome(case);
        if js::stringify(&actual) != js::stringify(&expected) {
            failures.push(format!("{wanted} {}: Rust {} ожидалось {}", js::stringify(&input["command"]).chars().take(300).collect::<String>(), actual, expected));
        }
    }
    report("блоки", &failures, cases.len());
}

/// `validateCommand` перенесёнными блоками: заглушки чужих задач пропускаются
/// (как `sk-corpus resolve`).
fn validate_ported(input: &Value, state: &Value, context: &Context, uuid: &mut dyn FnMut() -> String) -> Result<Value, Interrupt> {
    let command = sk_rules::command::normalize::normalize_command(input, state, uuid)?;
    let mut validation = Validation { state, command, context, actor_fate: None };
    for block in BLOCKS {
        match (block.check)(&mut validation) {
            Ok(()) => {}
            Err(halt) if halt.is_unported() => {}
            Err(halt) => return Err(halt.into()),
        }
    }
    Ok(validation.command)
}

fn prefix_of(actual: &[Value], expected: &Value) -> bool {
    let expected = expected.as_array().map(Vec::as_slice).unwrap_or_default();
    actual.len() <= expected.len() && actual.iter().zip(expected).all(|(event, hash)| sha(event) == hash.as_str().unwrap_or_default())
}

#[test]
fn resolve_branches_match_js() {
    let cases = DATA["branches"].as_array().expect("ветки");
    let mut failures = Vec::new();
    let mut accepted = 0;
    for case in cases {
        let raw = &DATA["states"][case["s"].as_u64().expect("состояние") as usize];
        let context = Context::from_json(&case["context"]);
        let values: Vec<i64> = case["v"].as_array().map(|items| items.iter().filter_map(Value::as_i64).collect()).unwrap_or_default();
        let mut dice = ServiceDice::new(DiceService::deterministic(SequenceRng::new(values), "roll"));
        let mut uuid = sequence_uuids("uuid");
        let result = (|| {
            let validated_state = sk_rules::normalize::normalize_campaign_state(&sk_rules::normalize::normalize_campaign_state(raw)?)?;
            let command = validate_ported(&case["input"], &validated_state, &context, &mut uuid)?;
            let mut uuid = sequence_uuids("uuid-branch");
            sk_rules::resolve::vitals::resolve_branch_without_tail(command, raw, &mut dice, &context, &mut uuid)
        })();
        let expected = &case["o"];
        let label = format!("{} {}", case["input"]["command_type"], js::stringify(&case["input"]).chars().take(240).collect::<String>());
        match (result, expected.get("ok")) {
            (Ok(resolved), Some(ok)) => {
                accepted += 1;
                let filtered = sk_rules::damage::without_immune_conditions(raw, &resolved.command, &resolved.events);
                if !(prefix_of(&resolved.events, &ok["events"]) || prefix_of(&filtered, &ok["events"])) || !prefix_of(&resolved.rolls, &ok["rolls"]) {
                    let first = resolved.events.first().map(out).unwrap_or(Value::Null);
                    failures.push(format!("{label}: события Rust {} (первое {}) не начало JS {} (первое {})", resolved.events.len(), first, ok["events"].as_array().map_or(0, Vec::len), ok["first"]));
                }
            }
            (result, _) => {
                let actual = outcome(result.map(|_| json!("принято")), |value| value.clone());
                let wanted = if expected.get("ok").is_some() { json!({ "ok": "принято" }) } else { expected_outcome(expected) };
                if js::stringify(&actual) != js::stringify(&wanted) {
                    failures.push(format!("{label}: Rust {actual} ожидалось {wanted}"));
                }
            }
        }
    }
    report("ветки", &failures, cases.len());
    assert!(accepted > 300, "принятых веток мало: {accepted}");
}

fn text_or_default(value: Option<Value>, fallback: &str) -> String {
    match value {
        None => fallback.to_string(),
        Some(value) => js::string(Some(&value)),
    }
}

fn run_call(f: &str, state: &Value, args: &[Value]) -> Result<Value, Halt> {
    match f {
        "previewD20Check" => Ok(preview::preview_d20_check(state, &arg(&args[0]).unwrap_or_else(|| json!({})))?),
        "previewTavernDiceRoll" => {
            let actor = arg(&args[0]);
            let approach = arg(&args[1]);
            Ok(preview::preview_tavern_dice_roll(state, actor.as_ref(), approach.as_ref()))
        }
        "shrinePrayerRefusalFor" => {
            let actor = arg(&args[0]).unwrap_or_else(|| json!(""));
            let prop = arg(&args[1]).unwrap_or_else(|| json!(""));
            Ok(preview::shrine_prayer_refusal_for(state, &actor, &prop)?.map_or(Value::Null, |refusal| refusal.to_json()))
        }
        "blessingGrantedEvents" => {
            let command = arg(&args[0]).unwrap_or(Value::Null);
            let options = arg(&args[1]).unwrap_or_else(|| json!({}));
            let field = |key: &str| options.get(key).cloned();
            let grant = preview::BlessingGrant {
                hero_id: field("heroId").unwrap_or(Value::Null),
                source: text_or_default(field("source"), "undefined"),
                place_name: text_or_default(field("placeName"), ""),
                npc_id: text_or_default(field("npcId"), ""),
                npc_name: text_or_default(field("npcName"), ""),
                minutes: field("minutes").unwrap_or_else(|| json!(0)),
                source_event_id: text_or_default(field("sourceEventId"), ""),
            };
            Ok(Value::Array(preview::blessing_granted_events(&command, state, &grant)))
        }
        other => panic!("неизвестная функция эталона {other}"),
    }
}

#[test]
fn previews_and_helpers_match_js() {
    let calls = DATA["calls"].as_array().expect("вызовы");
    let mut failures = Vec::new();
    for case in calls {
        let f = case["f"].as_str().expect("имя");
        let state = &NORMALIZED[case["s"].as_u64().expect("состояние") as usize];
        let args = case["a"].as_array().cloned().unwrap_or_default();
        let actual = outcome(run_call(f, state, &args), out);
        let expected = expected_outcome(&case["o"]);
        if js::stringify(&actual) != js::stringify(&expected) {
            failures.push(format!("{f} s={} a={}: Rust {} ожидалось {}", case["s"], js::stringify(&case["a"]).chars().take(300).collect::<String>(), actual, expected));
        }
    }
    report("предпросмотры", &failures, calls.len());
}

#[test]
fn event_summaries_match_js() {
    let cases = DATA["summaries"].as_array().expect("сводки");
    let mut resolvers = vec![summary::actor_name_resolver(&DATA["resolver_states"][0])];
    resolvers.extend(NORMALIZED.iter().take(3).map(summary::actor_name_resolver));
    let mut failures = Vec::new();
    let mut compared = 0;
    for case in cases {
        let event = &case["e"];
        let resolver = &resolvers[case["r"].as_u64().unwrap_or(0) as usize];
        for (rust, js_text) in [(summary::event_summary_plain(event), &case["plain"]), (summary::event_summary_named(event, resolver), &case["named"])] {
            let expected = js_text.as_str().unwrap_or_default();
            // JS бросил `TypeError` на мусорном payload: Rust текстом не падает (см. `summary.rs`).
            if expected.starts_with("__throw__:") {
                continue;
            }
            compared += 1;
            let expected = if expected == U { "undefined" } else { expected };
            if rust != expected {
                failures.push(format!("{}: Rust «{rust}» ожидалось «{expected}»", js::stringify(event).chars().take(300).collect::<String>()));
            }
        }
    }
    report("сводки", &failures, compared);
}

/// `test/rules-engine.test.mjs` и соседи: сводки, которые читает игрок.
#[test]
fn event_summary_resolves_names_like_js_tests() {
    let state = json!({ "players": [{ "id": "hero-slot-4", "character": "Ирма" }], "enemies": [{ "id": "encounter-1-bugbear-1", "name": "Багбир" }], "social": { "npcs": [{ "id": "npc-1", "name": "Мельник" }] } });
    let resolver = summary::actor_name_resolver(&state);
    let fallen = json!({ "event_type": "HitPointsReducedToZero", "target_ids": ["hero-slot-4"], "payload": {} });
    assert_eq!(summary::event_summary_named(&fallen, &resolver), "Ирма выбывает из боя");
    assert_eq!(summary::event_summary_plain(&fallen), "hero-slot-4 выбывает из боя");
    let moved = json!({ "event_type": "ActorMoved", "actor_id": "encounter-1-bugbear-1", "payload": { "distance": 30 } });
    assert_eq!(summary::event_summary_named(&moved, &resolver), "Багбир перемещается на 30 фт.");
    let refused = json!({ "event_type": "NpcBribeRefused", "target_ids": ["npc-1"], "payload": {} });
    assert_eq!(summary::event_summary_named(&refused, &resolver), "Мельник не берёт денег");
    assert_eq!(summary::event_summary_plain(&json!({ "event_type": "Custom" })), "Custom");
}

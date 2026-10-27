//! Эталоны JS задачи Т1 (`fixtures/t1.json.gz`, генератор `fixtures/gen-t1.mjs`):
//! `security`, `combat_forecast_view`, `cutover_audit`. Каждая секция —
//! отдельный тест; расхождения собираются и печатаются первыми десятью.

use std::io::Read;
use std::sync::{Arc, LazyLock};

use serde_json::{json, Value};
use sk_core::js;
use sk_tactics::combat_forecast_view::with_combat_forecast;
use sk_tactics::cutover_audit::{audit_event_store, GameReducer, TacticalMapCells};
use sk_tactics::security::*;

static FIXTURE: LazyLock<Value> = LazyLock::new(|| {
    let mut text = String::new();
    flate2::read::GzDecoder::new(&include_bytes!("../fixtures/t1.json.gz")[..]).read_to_string(&mut text).expect("эталон распаковывается");
    serde_json::from_str(&text).expect("эталон — JSON")
});

fn section(name: &str) -> &'static [Value] {
    FIXTURE[name].as_array().map(Vec::as_slice).unwrap_or(&[])
}

/// Аргументы случая: `undefined` — `None`.
fn args(entry: &Value) -> Vec<Option<Value>> {
    let undef: Vec<u64> = entry["undef"].as_array().map(|list| list.iter().filter_map(Value::as_u64).collect()).unwrap_or_default();
    entry["args"]
        .as_array()
        .map(|list| list.iter().enumerate().map(|(index, value)| if undef.contains(&(index as u64)) { None } else { Some(value.clone()) }).collect())
        .unwrap_or_default()
}

fn arg(args: &[Option<Value>], index: usize) -> Option<&Value> {
    args.get(index).and_then(Option::as_ref)
}

/// Итог вызова Rust в форме эталона.
enum Got {
    Value(Option<Value>),
    Error { name: String, code: Option<String>, message: String, details: Value },
}

fn from_result(result: Result<Value, SecurityValidationError>) -> Got {
    match result {
        Ok(value) => Got::Value(Some(value)),
        Err(error) => Got::Error { name: error.name.to_string(), code: error.code, message: error.message, details: Value::Object(error.details) },
    }
}

/// Сверка итога с эталоном; `None` — совпало.
fn compare(entry: &Value, got: Got) -> Option<String> {
    let expected_error = entry.get("error");
    match (got, expected_error) {
        (Got::Error { name, code, message, details }, Some(expected)) => {
            if expected["name"].as_str() != Some(name.as_str()) {
                return Some(format!("ошибка {name}, ждали {}", expected["name"]));
            }
            if name == "TypeError" {
                return None;
            }
            if expected["code"].as_str() != code.as_deref() || expected["message"].as_str() != Some(message.as_str()) {
                return Some(format!("ошибка {code:?} «{message}», ждали {} «{}»", expected["code"], expected["message"]));
            }
            let expected_details = expected.get("details").cloned().unwrap_or_else(|| json!({}));
            (js::stringify(&expected_details) != js::stringify(&details)).then(|| format!("details {}, ждали {}", js::stringify(&details), js::stringify(&expected_details)))
        }
        (Got::Error { name, message, .. }, None) => Some(format!("ошибка {name}: {message}, ждали значение")),
        (Got::Value(_), Some(expected)) => Some(format!("значение, ждали ошибку {}", js::stringify(expected))),
        (Got::Value(value), None) => {
            let Some(value) = value else { return Some("undefined, ждали значение".into()) };
            let text = js::stringify(&value);
            if let Some(hash) = entry.get("out_hash").and_then(Value::as_str) {
                return (sk_core::hash::sha256_hex(&text) != hash).then(|| format!("хеш выхода не совпал: {}", head(&text)));
            }
            let expected = js::stringify(&entry["out"]);
            (expected != text).then(|| format!("\n  rust {}\n  js   {}", head(&text), head(&expected)))
        }
    }
}

fn head(text: &str) -> String {
    text.chars().take(1500).collect()
}

/// `out_undefined` в эталоне — итог `undefined`.
fn expects_undefined(entry: &Value) -> bool {
    entry.get("out_undefined") == Some(&Value::Bool(true))
}

fn report(name: &str, failures: Vec<String>, total: usize) {
    if !failures.is_empty() {
        let shown: Vec<String> = failures.iter().take(10).cloned().collect();
        panic!("{name}: {} из {total} расходятся:\n{}", failures.len(), shown.join("\n---\n"));
    }
    assert!(total > 0, "{name}: пустая секция");
}

fn security_call(entry: &Value) -> Got {
    let args = args(entry);
    let a = |index: usize| arg(&args, index);
    let function = entry["fn"].as_str().unwrap_or("");
    match function {
        "isVisibleTo" => Got::Value(Some(Value::Bool(is_visible_to(a(0), a(1))))),
        "projectVisibleState" => Got::Value(project_visible_state(a(0), a(1), a(2))),
        "buildNarrationBrief" => from_result(build_narration_brief(a(0))),
        "assertNarrationBrief" => from_result(assert_narration_brief(a(0))),
        "assertAllowedCommand" => from_result(assert_allowed_command(a(0))),
        "validateAllowedCommands" => from_result(validate_allowed_commands(a(0), a(1)).map(Value::Array)),
        "delimitUntrustedData" => Got::Value(Some(Value::String(delimit_untrusted_data(a(0), a(1))))),
        "buildDataOnlyContext" => Got::Value(Some(Value::String(build_data_only_context(a(0))))),
        "redactTrace" => Got::Value(redact_trace(a(0), a(1))),
        "verifyNarration" => from_result(verify_narration(a(0), a(1), a(2))),
        "assertNarrationSafe" => from_result(assert_narration_safe(a(0), a(1), a(2))),
        other => Got::Error { name: "unknown".into(), code: None, message: other.into(), details: Value::Null },
    }
}

#[test]
fn allowlist_matches_js() {
    let expected: Vec<&str> = section("allowlist").iter().filter_map(Value::as_str).collect();
    assert_eq!(COMMAND_TYPE_ALLOWLIST.as_slice(), expected.as_slice());
}

#[test]
fn security_calls_match_js() {
    let calls = section("calls");
    let mut failures = Vec::new();
    for (index, entry) in calls.iter().enumerate() {
        let got = security_call(entry);
        let mismatch = match (&got, expects_undefined(entry)) {
            (Got::Value(None), true) => None,
            (_, true) => Some("ждали undefined".to_string()),
            _ => compare(entry, got),
        };
        if let Some(mismatch) = mismatch {
            failures.push(format!("#{index} {} {}: {mismatch}", entry["fn"], head(&js::stringify(&entry["args"]))));
        }
    }
    report("security", failures, calls.len());
}

#[test]
fn corpus_projection_matches_js() {
    let states = section("states");
    let cases = section("projection");
    let mut failures = Vec::new();
    for (index, entry) in cases.iter().enumerate() {
        let state = &states[entry["state"].as_u64().unwrap_or(0) as usize];
        let options = entry.get("options").filter(|value| !value.is_null());
        let got = project_visible_state(Some(state), entry.get("viewer"), options);
        if let Some(mismatch) = compare(entry, Got::Value(got)) {
            failures.push(format!("#{index} viewer {}: {mismatch}", entry["viewer"]));
        }
    }
    report("projection", failures, cases.len());
}

#[test]
fn combat_forecast_matches_js() {
    let states = section("states");
    let cases = section("forecast");
    let mut failures = Vec::new();
    for (index, entry) in cases.iter().enumerate() {
        let args = args(entry);
        let state = entry["state"].as_i64().filter(|index| *index >= 0).map(|index| &states[index as usize]);
        let got = match with_combat_forecast(arg(&args, 0), state, arg(&args, 1)) {
            Ok(value) => Got::Value(value),
            Err(error) => Got::Error { name: match &error { sk_rules::pause::Halt::Fault(fault) => fault.name.clone(), other => format!("{other:?}") }, code: None, message: error.to_string(), details: Value::Null },
        };
        let mismatch = match (&got, expects_undefined(entry)) {
            (Got::Value(None), true) => None,
            (_, true) => Some("ждали undefined".to_string()),
            _ => compare(entry, got),
        };
        if let Some(mismatch) = mismatch {
            failures.push(format!("#{index} actor {}: {mismatch}", js::stringify(&entry["args"][1])));
        }
    }
    report("forecast", failures, cases.len());
}

/// Коды, которые возможны и в Rust: прочие — расхождения комнаты с журналом.
const STORE_CODES: [&str; 4] = ["REPLAY_DIVERGENCE", "PROJECTION_NOT_ACKNOWLEDGED", "PROJECTION_CHECKPOINT_HASH_MISMATCH", "CAMPAIGN_AUDIT_FAILED"];
const ENTRY_FIELDS: [&str; 8] = ["campaign_id", "event_version", "replay_version", "authoritative_sha256", "replay_matched", "projection_checkpoint_version", "projection_checkpoint_hash", "pending_projection"];

fn store_findings(list: &Value) -> Vec<String> {
    list.as_array()
        .map(|items| {
            items
                .iter()
                .filter(|item| STORE_CODES.contains(&item["code"].as_str().unwrap_or("")))
                .map(|item| format!("{}:{}:{}", item["code"].as_str().unwrap_or(""), item["campaign_id"].as_str().unwrap_or(""), item["reason"].as_str().unwrap_or("")))
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn cutover_audit_matches_js_over_imported_store() {
    let scenarios = section("cutover");
    let mut failures = Vec::new();
    for scenario in scenarios {
        let name = scenario["name"].as_str().unwrap_or("");
        let dir = std::env::temp_dir().join(format!("sk-tactics-t1-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for (path, body) in scenario["files"].as_object().into_iter().flatten() {
            let file = dir.join(path);
            if let Some(parent) = file.parent() {
                std::fs::create_dir_all(parent).expect("каталог эталона");
            }
            std::fs::write(&file, body.as_str().unwrap_or("")).expect("файл эталона");
        }
        let reducer = Arc::new(GameReducer::new());
        let store = sk_store::EventStore::in_memory(reducer.clone(), sk_store::StoreOptions::default()).expect("база в памяти").with_map_cells(Arc::new(TacticalMapCells));
        sk_store::import_file_store(&store, &dir).expect("перенос хранилища JS");
        let report = audit_event_store(&store, &reducer, &dir).expect("аудит");
        let _ = std::fs::remove_dir_all(&dir);
        let expected = &scenario["report"];
        let js_campaigns = expected["campaigns"].as_array().cloned().unwrap_or_default();
        let rust_campaigns = report["campaigns"].as_array().cloned().unwrap_or_default();
        if js_campaigns.len() != rust_campaigns.len() {
            failures.push(format!("{name}: кампаний {} против {}", rust_campaigns.len(), js_campaigns.len()));
            continue;
        }
        for (rust, js_entry) in rust_campaigns.iter().zip(&js_campaigns) {
            for field in ENTRY_FIELDS {
                if js::stringify(&rust[field]) != js::stringify(&js_entry[field]) {
                    failures.push(format!("{name}: {field} = {}, в JS {}", rust[field], js_entry[field]));
                }
            }
        }
        for list in ["blockers", "warnings"] {
            let (rust, js_list) = (store_findings(&report[list]), store_findings(&expected[list]));
            if rust != js_list {
                failures.push(format!("{name}: {list} {rust:?}, в JS {js_list:?}"));
            }
        }
        let rust_ready = report["blockers"].as_array().is_some_and(Vec::is_empty);
        let js_ready_on_store = store_findings(&expected["blockers"]).is_empty();
        if rust_ready != js_ready_on_store {
            failures.push(format!("{name}: ready {rust_ready}, в JS без расхождений комнаты {js_ready_on_store}"));
        }
    }
    report("cutover", failures, scenarios.len());
}

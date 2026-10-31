//! Сверка `combat_lab_setup` с эталоном JS (`fixtures/t3.json.gz`,
//! генератор — `fixtures/gen-t3.mjs`): сборка состояния, генерация и оценка
//! стычки, каталог и герои кампаний; отказы на рыхлых входах.
//!
//! Комнаты эталона (`rooms`) — [`MemoryRooms`] с правилами имени файла
//! `store.mjs` (`roomFile`); кампании-источники — `sources`, способ загрузки —
//! `loader` случая. Успех сверяется по SHA-256 строки `JSON.stringify`, отказ —
//! по имени, коду и тексту; первые собранные состояния — целиком (`full`).

use std::io::Read;
use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_core::{hash, js};
use sk_tactics::combat_lab_setup::{
    assess_combat_lab_encounter, build_combat_lab_state, combat_lab_catalog, combat_lab_heroes, generate_combat_lab_encounter, CampaignRooms, CombatLabSetupError,
    EncounterOptions, Sources,
};

const FIXTURE: &[u8] = include_bytes!("../fixtures/t3.json.gz");
static DATA: LazyLock<Value> = LazyLock::new(|| {
    let mut text = String::new();
    flate2::read::GzDecoder::new(FIXTURE).read_to_string(&mut text).expect("эталон — gzip");
    serde_json::from_str(&text).expect("эталон — JSON")
});

const U: &str = "__undefined__";

/// Комнаты `storage/rooms/<CODE>.json` в памяти.
struct MemoryRooms<'a>(&'a serde_json::Map<String, Value>);

impl CampaignRooms for MemoryRooms<'_> {
    fn room_codes(&self) -> Result<Vec<String>, CombatLabSetupError> {
        let mut codes: Vec<String> = self.0.keys().cloned().collect();
        codes.sort();
        Ok(codes)
    }

    fn room_state(&self, code: &str) -> Result<Option<Value>, CombatLabSetupError> {
        let safe: String = code.to_uppercase().chars().filter(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || *ch == '-').take(24).collect();
        if safe.is_empty() {
            return Err(CombatLabSetupError::other("Error", "Некорректный код комнаты", None));
        }
        Ok(self.0.get(&safe).cloned())
    }
}

fn outcome(result: Result<Value, CombatLabSetupError>) -> Value {
    match result {
        Ok(value) => json!({ "ok": hash::sha256_hex(js::stringify(&value)) }),
        Err(error) => json!({ "err": { "name": error.name, "code": error.code, "message": error.message } }),
    }
}

fn run_case(case: &Value) -> Value {
    let rooms_map = DATA["rooms"].as_object().expect("комнаты");
    let sources_map = DATA["sources"].as_object().expect("источники");
    let rooms = MemoryRooms(rooms_map);
    let kind = case["loader"].as_str().unwrap_or("direct").to_string();
    let load = |id: &str| -> Result<Option<Value>, CombatLabSetupError> {
        match sources_map.get(id) {
            Some(state) if kind != "throw" => Ok(Some(if kind == "wrapped" { json!({ "state": state }) } else { state.clone() })),
            _ => Err(CombatLabSetupError::other("Error", format!("нет кампании {id}"), None)),
        }
    };
    let sources = Sources::new(&rooms, if kind == "none" { None } else { Some(&load) });
    let input = (case["input"].as_str() != Some(U)).then_some(&case["input"]);
    let options_value = case.get("options").cloned().unwrap_or_else(|| json!({}));
    let options = EncounterOptions { difficulty: options_value.get("difficulty"), seed: options_value.get("seed"), theme: options_value.get("theme"), sources };
    let result = match case["kind"].as_str() {
        // Эталон снят с состояния JS, где производные поля героя заполнены (урок 2).
        Some("build") => build_combat_lab_state(input, &sources).map(|state| sk_rules::derived::materialized_state(&state)),
        Some("generate") => generate_combat_lab_encounter(input, &options),
        Some("assess") => assess_combat_lab_encounter(input, &options),
        Some("heroes") => combat_lab_heroes(&sources).map(Value::Array),
        Some("catalog") => combat_lab_catalog(&sources),
        other => panic!("неизвестный вид {other:?}"),
    };
    if let (Ok(value), Some(full)) = (&result, DATA["full"].as_array().and_then(|full| full.iter().find(|entry| entry["index"] == case["__index"]))) {
        if value != &full["value"] {
            let actual = serde_json::to_string_pretty(value).unwrap_or_default();
            let expected = serde_json::to_string_pretty(&full["value"]).unwrap_or_default();
            let first = actual.lines().zip(expected.lines()).position(|(a, b)| a != b);
            panic!("случай {}: полный эталон расходится, первая разная строка {first:?}", case["__index"]);
        }
    }
    outcome(result)
}

fn expected(case: &Value) -> Value {
    match case.get("ok") {
        Some(hash) => json!({ "ok": hash }),
        None => json!({ "err": case["err"] }),
    }
}

#[test]
fn every_case_matches_js() {
    let cases = DATA["cases"].as_array().expect("случаи");
    assert!(cases.len() > 1000, "эталон неполон: {}", cases.len());
    let mut failures = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let mut case = case.clone();
        case["__index"] = json!(index);
        let actual = run_case(&case);
        let wanted = expected(&case);
        if actual != wanted {
            failures.push(format!("#{index} {} {}\n  вход: {}\n  ждали: {}\n  вышло: {}", case["kind"], case["loader"], js::stringify(&case["input"]).chars().take(300).collect::<String>(), wanted, actual));
        }
    }
    assert!(failures.is_empty(), "{} расхождений из {}:\n{}", failures.len(), cases.len(), failures.iter().take(15).cloned().collect::<Vec<_>>().join("\n"));
}

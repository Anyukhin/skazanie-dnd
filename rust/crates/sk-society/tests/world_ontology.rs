//! Сверка `world_ontology` с эталоном JS (`fixtures/gen-world-ontology.mjs`)
//! и перенос сторожа `test/world-ontology.test.mjs`: реестр предикатов обязан
//! совпадать с тем, что пишут и читают модули `server/*.mjs`.
//!
//! Разбор модуля сверяется с эталоном, только если текст модуля не изменился
//! с момента снятия эталона (хеш SHA-256): правка `server/` делает эталон
//! устаревшим, а не перенос — неверным. Сторож реестра читает исходники
//! сервера в момент прогона, как и тест JS.

mod common;

use std::fs;
use std::path::PathBuf;

use common::{Args, Fixture, Outcome};
use serde_json::{json, Map, Value};
use sk_society::world_ontology::*;

fn server_files() -> Vec<(String, String)> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../server");
    let mut names: Vec<String> = fs::read_dir(&dir)
        .expect("каталог server/")
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".mjs"))
        .collect();
    names.sort();
    names.into_iter().map(|name| (name.trim_end_matches(".mjs").to_string(), fs::read_to_string(dir.join(&name)).expect("модуль server/"))).collect()
}

fn as_pairs(files: &[(String, String)]) -> Vec<(&str, &str)> {
    files.iter().map(|(file, source)| (file.as_str(), source.as_str())).collect()
}

fn dispatch(name: &str, args: &Args) -> Outcome {
    match name {
        "scanOntologyUsage" => Outcome::of(serde_json::to_value(scan_ontology_usage(args.val(0).as_str().unwrap_or_default(), args.val(1).as_str().unwrap_or_default())).unwrap_or_default()),
        "auditOntology" => {
            let files: Vec<(String, String)> = args
                .list(0)
                .iter()
                .map(|entry| (entry["file"].as_str().unwrap_or_default().to_string(), entry["source"].as_str().unwrap_or_default().to_string()))
                .collect();
            Outcome::of(audit_ontology(&as_pairs(&files)))
        }
        // `predicateEntryFor(predicate)`: `String(predicate ?? '')`.
        "predicateEntryFor" => Outcome::option(predicate_entry_for(&sk_core::js::s(args.opt(0))).map(PredicateEntry::to_json)),
        "ontologyViolation" => {
            let write = args.val(0);
            let text = |key: &str| write.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
            let violation = ontology_violation(&text("record"), &text("predicate"), &text("subjectKind"));
            Outcome::option(violation.map(|violation| json!({ "code": violation.code, "message": violation.message })))
        }
        _ => Outcome::Unknown,
    }
}

fn fixture() -> Fixture {
    Fixture::load(include_str!("../fixtures/world-ontology.json"))
}

#[test]
fn scanner_matches_js_on_synthetic_lines() {
    assert!(fixture().check(dispatch) >= 400);
}

#[test]
fn registry_constants_match_js() {
    let fixture = fixture();
    let constants = &fixture.root["constants"];
    assert_eq!(serde_json::to_string(&predicates_json()).ok(), serde_json::to_string(&constants["PREDICATES"]).ok());
    assert!(RELATIONS.is_empty());
    assert_eq!(constants["RELATIONS"], json!({}));
    let generic: Map<String, Value> = GENERIC_PREDICATE_CONSUMERS.iter().map(|(module, why)| (module.to_string(), json!(why))).collect();
    assert_eq!(serde_json::to_string(&generic).ok(), serde_json::to_string(&constants["GENERIC_PREDICATE_CONSUMERS"]).ok());
    assert_eq!(constants["EXTERNAL_ONLY_PREDICATES"], json!(EXTERNAL_ONLY_PREDICATES));
}

#[test]
fn scanner_matches_js_on_server_sources() {
    let fixture = fixture();
    let files = server_files();
    let mut matched = 0;
    let mut stale = Vec::new();
    for entry in fixture.root["sources"].as_array().cloned().unwrap_or_default() {
        let file = entry["file"].as_str().unwrap_or_default();
        let Some((_, source)) = files.iter().find(|(name, _)| name == file) else {
            stale.push(file.to_string());
            continue;
        };
        if sk_core::hash::sha256_hex(source) != entry["sha256"].as_str().unwrap_or_default() {
            stale.push(file.to_string());
            continue;
        }
        let scan = serde_json::to_value(scan_ontology_usage(file, source)).unwrap_or_default();
        assert_eq!(serde_json::to_string(&scan).ok(), serde_json::to_string(&entry["scan"]).ok(), "разбор server/{file}.mjs расходится с JS");
        matched += 1;
    }
    assert!(matched > 0, "ни один модуль не совпал по хешу — пересоздать эталон: node gen-world-ontology.mjs");
    if stale.is_empty() && files.len() == matched {
        let audit = audit_ontology(&as_pairs(&files));
        assert_eq!(serde_json::to_string(&audit).ok(), serde_json::to_string(&fixture.root["audit"]).ok(), "аудит всех модулей расходится с JS");
    } else {
        eprintln!("эталон онтологии устарел для {} модулей: {}", stale.len(), stale.join(", "));
    }
}

// ---------------------------------------------------------------------------
// Сторож реестра (test/world-ontology.test.mjs) — на текущих исходниках
// ---------------------------------------------------------------------------

fn strings(value: &Value) -> Vec<String> {
    value.as_array().map(|list| list.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
}

fn sorted(list: &[&str]) -> Vec<String> {
    let mut list: Vec<String> = list.iter().map(|item| item.to_string()).collect();
    list.sort();
    list
}

#[test]
fn every_produced_predicate_is_registered() {
    let files = server_files();
    let audit = audit_ontology(&as_pairs(&files));
    let produced: Vec<(&String, &Value)> = audit["predicates"].as_object().map(|map| map.iter().filter(|(_, entry)| !strings(&entry["producers"]).is_empty()).collect()).unwrap_or_default();
    assert!(produced.len() >= 20, "сканер нашёл подозрительно мало предикатов: {}", produced.len());
    let missing: Vec<&String> = produced.iter().filter(|(name, _)| predicate(name).is_none()).map(|(name, _)| *name).collect();
    assert!(missing.is_empty(), "новый предикат нужно описать в реестре: {missing:?}");
    for (name, entry) in produced {
        let registered = predicate(name).expect("предикат описан");
        assert_eq!(json!(registered.family), entry["family"], "{name}: семейство");
        assert_eq!(json!([registered.record]), entry["record"], "{name}: факт или утверждение");
    }
    assert!(audit["relations"].as_object().is_some_and(|map| map.keys().all(|name| RELATIONS.iter().any(|(known, _)| known == name))));
}

#[test]
fn every_consumed_predicate_has_a_producer() {
    let files = server_files();
    let audit = audit_ontology(&as_pairs(&files));
    let predicates = audit["predicates"].as_object().cloned().unwrap_or_default();
    assert!(predicates.get("died").is_some_and(|entry| !strings(&entry["consumers"]).is_empty()), "сканер обязан видеть чтение died");
    let orphan: Vec<&String> = predicates
        .iter()
        .filter(|(name, entry)| !strings(&entry["consumers"]).is_empty() && strings(&entry["producers"]).is_empty() && !EXTERNAL_ONLY_PREDICATES.contains(&name.as_str()))
        .map(|(name, _)| name)
        .collect();
    assert!(orphan.is_empty(), "предикат читается, но его никто не пишет: {orphan:?}");
    let declared: Vec<&str> = PREDICATES.iter().filter(|(_, entry)| entry.producers.is_empty()).map(|(name, _)| *name).collect();
    assert_eq!(sorted(&declared), sorted(&EXTERNAL_ONLY_PREDICATES));
}

#[test]
fn registry_producers_and_consumers_match_the_code() {
    let files = server_files();
    let audit = audit_ontology(&as_pairs(&files));
    let mut stale = Vec::new();
    for (name, entry) in PREDICATES {
        let scanned = &audit["predicates"][*name];
        if sorted(entry.producers) != strings(&scanned["producers"]) {
            stale.push(format!("{name}.producers"));
        }
        if sorted(entry.consumers) != strings(&scanned["consumers"]) {
            stale.push(format!("{name}.consumers"));
        }
        for module in entry.producers.iter().chain(entry.consumers) {
            let source = files.iter().find(|(file, _)| file == module).map(|(_, source)| source).unwrap_or_else(|| panic!("{name}: модуль {module} не существует"));
            let needle = if entry.family { format!("{name}${{") } else { format!("'{name}'") };
            assert!(source.contains(&needle), "{name}: в {module}.mjs нет литерала {needle}");
        }
    }
    assert!(stale.is_empty(), "реестр устарел: {stale:?}");
}

#[test]
fn generic_consumers_read_the_predicate_as_is() {
    let files = server_files();
    for (module, _) in GENERIC_PREDICATE_CONSUMERS {
        let source = files.iter().find(|(file, _)| file == module).map(|(_, source)| source).unwrap_or_else(|| panic!("{module}.mjs не найден"));
        assert!(sk_core::text::test(sk_core::re!(r"\.predicate\b", "u"), source), "{module}.mjs не обращается к .predicate");
    }
}

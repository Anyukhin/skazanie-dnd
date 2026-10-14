//! Сверка `spell_acceptance_audit` с эталоном JS (`fixtures/spell-acceptance-audit.json`,
//! генератор `fixtures/gen-spell-acceptance-audit.mjs`) и перенос
//! `test/spell-acceptance-audit.test.mjs`.
//!
//! Отчёт читает файлы репозитория и Git: эталон снят в этом же дереве, и
//! после правки зависимостей (сервер, клиент, тесты JS, данные) его нужно
//! пересоздать. `revision` и `workingTreeSha256` меняются с каждым коммитом —
//! сверяется их форма, а значения подставляются из эталона.

mod common;

use std::sync::LazyLock;

use common::{array, assert_same, hash, parse};
use serde_json::{json, Value};
use sk_combat_content::combat_spells::canonical_combat_spell_for;
use sk_combat_content::spell_acceptance_audit::{self as m, SpellAcceptanceOptions};

static FIXTURE: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../fixtures/spell-acceptance-audit.json")));

fn options_of(value: &Value) -> SpellAcceptanceOptions {
    if value.is_null() {
        return SpellAcceptanceOptions::default();
    }
    SpellAcceptanceOptions { baseline: value.get("baseline").cloned(), longstrider_evidence: value.get("longstriderEvidence").cloned(), basic_evidence: value.get("basicEvidence").cloned() }
}

fn is_hex(value: &Value, length: usize) -> bool {
    value.as_str().is_some_and(|text| text.len() == length && text.chars().all(|ch| ch.is_ascii_hexdigit()))
}

/// Отчёт Rust с моментальными полями эталона.
fn audit(name: &str) -> Value {
    let case = array(&FIXTURE["audits"]).iter().find(|case| case["name"] == name).unwrap_or_else(|| panic!("нет случая {name}"));
    let mut report = m::audit_spell_acceptance(options_of(&case["options"])).expect("аудит");
    assert!(is_hex(&report["revision"], 40), "ревизия: {}", report["revision"]);
    assert!(report["workingTreeSha256"].is_null() || is_hex(&report["workingTreeSha256"], 64));
    report["revision"] = case["report"]["revision"].clone();
    report["workingTreeSha256"] = case["report"]["workingTreeSha256"].clone();
    report
}

fn compact(report: &Value) -> Value {
    let mut compact = report.clone();
    compact["spells"] = Value::Array(array(&report["spells"]).iter().map(|card| json!([card["spellId"], hash(Some(card))])).collect());
    compact
}

#[test]
fn constants_and_text_hashes_match_js() {
    let constants = &FIXTURE["constants"];
    assert_eq!(constants["LONGSTRIDER_EVIDENCE_PATH"], m::LONGSTRIDER_EVIDENCE_PATH);
    assert_eq!(constants["BASIC_SPELL_EVIDENCE_PATH"], m::BASIC_SPELL_EVIDENCE_PATH);
    assert_eq!(constants["BASIC_SPELL_EVIDENCE_DEPENDENCIES"], json!(m::BASIC_SPELL_EVIDENCE_DEPENDENCIES.to_vec()));
    assert_eq!(constants["LONGSTRIDER_EVIDENCE_DEPENDENCIES"], json!(m::LONGSTRIDER_EVIDENCE_DEPENDENCIES.to_vec()));
    assert_eq!(constants["SPELL_ACCEPTANCE_BASELINE"], m::SPELL_ACCEPTANCE_BASELINE);
    assert_eq!(constants["SPELL_ACCEPTANCE_DIMENSIONS"], json!(m::SPELL_ACCEPTANCE_DIMENSIONS));
    for pair in array(&FIXTURE["textHashes"]) {
        assert_eq!(m::spell_evidence_text_sha256(pair[0].as_str().expect("текст")), pair[1], "{pair}");
    }
    let root = m::repository_root();
    assert_same(&Value::Object(m::longstrider_dependency_fingerprints(&root).expect("отпечатки")), &FIXTURE["longstriderFingerprints"], "longstriderDependencyFingerprints");
    assert_same(&Value::Object(m::basic_spell_dependency_fingerprints(&root).expect("отпечатки")), &FIXTURE["basicFingerprints"], "basicSpellDependencyFingerprints");
}

#[test]
fn baseline_matches_js() {
    assert_same(&m::read_spell_acceptance_baseline(&m::repository_root()), &FIXTURE["baselineAvailable"], "readSpellAcceptanceBaseline");
    let directory = std::env::temp_dir().join(format!("skazanie-spell-baseline-{}", std::process::id()));
    std::fs::create_dir_all(&directory).expect("каталог");
    let unavailable = m::read_spell_acceptance_baseline(&directory);
    let _ = std::fs::remove_dir_all(&directory);
    assert_same(&unavailable, &FIXTURE["baselineUnavailable"], "readSpellAcceptanceBaseline без истории");
}

#[test]
fn audits_match_js() {
    let cases = array(&FIXTURE["audits"]);
    assert!(cases.len() >= 30);
    for case in cases {
        let name = case["name"].as_str().expect("имя");
        let report = audit(name);
        let expected = &case["report"];
        let actual = compact(&report);
        let actual_spells = array(&actual["spells"]);
        let expected_spells = array(&expected["spells"]);
        assert_eq!(actual_spells.len(), expected_spells.len(), "{name}");
        for (card, pair) in array(&report["spells"]).iter().zip(expected_spells) {
            assert_eq!(hash(Some(card)), pair[1].as_str().expect("хеш"), "паспорт {} в {name}\n{}", pair[0], common::stringify(card));
        }
        assert_same(&actual, expected, &format!("auditSpellAcceptance {name}"));
        if name == "default" {
            assert_same(&report["spells"], &FIXTURE["fullSpells"], "паспорта основного отчёта");
        }
    }
}

type Mutation = fn(&mut Value);

fn mutations() -> Vec<(&'static str, Mutation)> {
    vec![
        ("duplicate", |value| value["spells"][1]["spellId"] = value["spells"][0]["spellId"].clone()),
        ("missing", |value| {
            value["spells"].as_array_mut().expect("массив").pop();
        }),
        ("unknown", |value| value["spells"][0]["spellId"] = json!("not-in-the-catalog")),
        ("unproved", |value| {
            let card = &mut value["spells"][0];
            card["readiness"]["rules"] = json!("verified");
            card["accepted"] = json!(true);
            card["scenarios"][0]["status"] = json!("passed");
            card["baseline"]["group"] = json!("verified");
        }),
        ("otherTree", |value| {
            let card = &mut value["spells"][0];
            card["scenarios"][0]["status"] = json!("passed");
            card["scenarios"][0]["evidence"] = json!([{ "kind": "test-run", "reference": "test/example.test.mjs", "observedAt": "2026-09-21T10:00:00Z", "treeSha256": "0".repeat(64) }]);
            card["scenarios"][1]["status"] = json!("not-applicable");
        }),
        ("sameTree", |value| {
            let tree = value["workingTreeSha256"].clone();
            let scenario = &mut value["spells"][0]["scenarios"][0];
            scenario["status"] = json!("passed");
            scenario["evidence"] = json!([{ "kind": "manual-run", "reference": "docs/x.md", "observedAt": "2026-09-21", "treeSha256": tree }]);
        }),
        ("nullScenario", |value| value["spells"][0]["scenarios"] = json!([null])),
        ("allNotApplicable", |value| {
            let card = &mut value["spells"][0];
            for scenario in card["scenarios"].as_array_mut().expect("массив") {
                scenario["status"] = json!("not-applicable");
                scenario["reason"] = json!("Общий обработчик уже проверен.");
            }
            for dimension in m::SPELL_ACCEPTANCE_DIMENSIONS {
                card["readiness"][dimension] = json!("verified");
            }
            card["accepted"] = json!(true);
            value["summary"]["accepted"] = json!(1);
        }),
        ("badSchema", |value| value["schemaVersion"] = json!("spell-acceptance/v0")),
        ("spellsNotArray", |value| value["spells"] = json!("x")),
        ("badBaseline", |value| {
            value["baseline"]["commit"] = json!("x");
            value["baseline"]["status"] = json!("lost");
        }),
        ("nullCard", |value| {
            value["spells"][0] = Value::Null;
            value["spells"][1] = json!([]);
        }),
        ("identity", |value| {
            let spells = &mut value["spells"];
            spells[0]["level"] = json!(2.5);
            spells[0]["name"] = json!("");
            spells[1]["availability"] = json!({ "supportStatus": "partial", "blocked": true });
            spells[2]["baseline"] = json!({});
            spells[3]["source"] = json!({ "cardSha256": "x", "rulesetId": "srd_5_2_1" });
            spells[4]["specification"] = json!({ "status": "done" });
            spells[5]["remaining"] = json!([]);
            spells[6]["dependencies"] = json!({ "items": [] });
        }),
        ("scenarioShape", |value| {
            let scenarios = value["spells"][0]["scenarios"].as_array_mut().expect("массив");
            scenarios[0]["dimension"] = json!("fun");
            scenarios[1]["status"] = json!("maybe");
            scenarios[2]["evidence"] = json!("x");
            scenarios[3]["status"] = json!("passed");
            scenarios[3]["dimension"] = json!("presentation");
            scenarios[3]["evidence"] = json!([{ "kind": "test-run", "reference": "r", "observedAt": "x" }, null]);
            let copy = scenarios[4].clone();
            scenarios.push(copy);
            scenarios.push(json!({ "id": "", "dimension": "rules", "description": "" }));
        }),
    ]
}

#[test]
fn validation_matches_js() {
    let bases = [("nullEvidence", audit("nullEvidence")), ("unavailableBaseline", audit("unavailableBaseline"))];
    let cases = array(&FIXTURE["validations"]);
    for (name, mutate) in mutations() {
        for (base_name, base) in &bases {
            let case = cases.iter().find(|case| case["name"] == name && case["base"] == *base_name).unwrap_or_else(|| panic!("нет случая {name}"));
            let mut value = base.clone();
            mutate(&mut value);
            assert_same(&Value::Array(m::validate_spell_acceptance_report(&value)), &case["problems"], &format!("validateSpellAcceptanceReport {name}/{base_name}"));
        }
    }
    let mut exported = bases[1].1.clone();
    exported["spells"][0]["baseline"] = json!({ "supportStatus": "partial", "group": "partial" });
    let case = cases.iter().find(|case| case["name"] == "exportedBaselineEdited").expect("случай");
    assert_same(&Value::Array(m::validate_spell_acceptance_report(&exported)), &case["problems"], "exportedBaselineEdited");
    let case = cases.iter().find(|case| case["name"] == "notObject").expect("случай");
    assert_same(&Value::Array(m::validate_spell_acceptance_report(&Value::Null)), &case["problems"], "notObject");
}

/// Матрица поимённо покрывает каталог и хранит доступность отдельно от приёмки.
#[test]
fn matrix_covers_catalog_without_acceptance() {
    let report = audit("nullEvidence");
    assert_eq!(report["ok"], true, "{}", report["problems"]);
    assert_eq!(array(&report["spells"]).len(), 439);
    assert_eq!(report["summary"]["accepted"], 0);
    assert_eq!(report["summary"]["specifications"]["pilot-draft"], 4);
    assert_eq!(report["summary"]["specifications"]["inventory-only"], 435);
    for card in array(&report["spells"]) {
        let runtime = canonical_combat_spell_for(Some(&card["spellId"]), Some(&json!({ "rulesetId": "dnd_5e_2014" }))).expect("карточка");
        assert_eq!(card["availability"]["supportStatus"], runtime["mechanicsSupport"]);
        assert_eq!(card["accepted"], false);
        assert!(array(&card["scenarios"]).iter().all(|scenario| scenario["status"] == "pending" && array(&scenario["evidence"]).is_empty()));
    }
    let unresolved: Vec<&Value> = array(&report["spells"]).iter().filter(|spell| spell["componentRequirements"]["material"]["unresolved"].as_bool() == Some(true)).collect();
    assert_eq!(unresolved.len(), 13);
    let mut royalties: Vec<&str> = array(&report["summary"]["components"]["royaltyIds"]).iter().filter_map(Value::as_str).collect();
    royalties.sort();
    assert_eq!(royalties, ["gift-of-gab", "jims-glowing-coin", "jims-magic-missile"]);
}

/// Только актуальный receipt подтверждает измерения partial-пилота.
#[test]
fn current_receipt_confirms_pilot_dimensions() {
    let report = audit("longstrider:current");
    assert_eq!(report["ok"], true, "{}", report["problems"]);
    let card = array(&report["spells"]).iter().find(|spell| spell["spellId"] == "longstrider").expect("скороход");
    assert_eq!(card["evidenceRecord"]["status"], "current");
    assert_eq!(card["readiness"]["rules"], "verified");
    assert_eq!(card["readiness"]["playerPath"], "pending");
    assert_eq!(card["accepted"], false);
    for name in ["longstrider:noReceipt", "longstrider:filenameOnly", "longstrider:missingRun", "longstrider:manual", "longstrider:onlyHttp"] {
        assert_eq!(audit(name)["ok"], false, "{name}");
    }
    assert_eq!(audit("longstrider:dropped")["evidence"]["longstrider"]["status"], "stale");
    assert_eq!(audit("longstrider:pending")["evidence"]["longstrider"]["status"], "pending");
}

#[test]
fn export_without_history_keeps_inventory() {
    let report = audit("unavailableBaseline");
    assert_eq!(report["ok"], true);
    assert_eq!(report["summary"]["initialGroups"], json!({ "unavailable": 439 }));
    assert!(!array(&report["warnings"]).is_empty());
    assert!(array(&report["spells"]).iter().all(|spell| spell["baseline"]["supportStatus"].is_null()));
}

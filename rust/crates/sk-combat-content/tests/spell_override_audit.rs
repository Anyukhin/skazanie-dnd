//! Сверка `spell_override_audit` с эталоном JS (`fixtures/spell-override-audit.json`,
//! генератор `fixtures/gen-spell-override-audit.mjs`) и перенос
//! `test/spell-override-audit.test.mjs`.
//!
//! Настоящий отчёт зависит от текста `server/rules-engine.mjs` (читаемые
//! поля), встроенного в сборку: после правки движка эталон пересоздаётся.

mod common;

use std::sync::LazyLock;

use common::{array, assert_same, parse};
use serde_json::Value;
use sk_combat_content::spell_override_audit as m;

static FIXTURE: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../fixtures/spell-override-audit.json")));

#[test]
fn real_report_matches_js() {
    assert_same(&m::audit_spell_overrides(), &FIXTURE["real"], "auditSpellOverrides");
}

#[test]
fn synthetic_reports_match_js() {
    let catalog = &FIXTURE["smallCatalog"];
    let engine = FIXTURE["engineSource"].as_str().expect("исходник");
    for case in array(&FIXTURE["synthetic"]) {
        let source = case["source"].as_str().expect("текст правок");
        let report = m::audit_spell_overrides_with(source, catalog, engine).expect("JSON правок");
        assert_same(&report, &case["report"], &format!("auditSpellOverrides: {}", case["label"]));
    }
    assert!(m::audit_spell_overrides_with("{", catalog, engine).is_err());
}

#[test]
fn every_override_is_consistent_and_executable() {
    let report = m::audit_spell_overrides();
    assert_eq!(report["problems"], serde_json::json!([]), "аудит нашёл несогласованные карточки");
    assert_eq!(report["ok"], true);
    assert!(report["checked"].as_u64().expect("число") >= 100);
}

#[test]
fn audit_measures_corrections_against_generated_catalog() {
    let report = m::audit_spell_overrides();
    assert!(report["corrections"].as_u64().expect("число") > 100);
    assert!(report["correctionsByField"]["kind"].as_u64().expect("число") > 0);
    assert!(report["correctionsByField"]["target"].as_u64().expect("число") > 0);
    assert!(report["catalog"].as_u64() > report["checked"].as_u64(), "в каталоге обязаны оставаться неразобранные карточки");
}

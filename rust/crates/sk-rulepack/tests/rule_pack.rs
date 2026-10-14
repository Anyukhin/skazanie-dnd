//! Сверка `rule_pack` с эталоном JS (`fixtures/rule-pack.json`, генератор
//! `fixtures/gen-rule-pack.mjs`) и перенос `test/rule-pack.test.mjs`.

use std::path::PathBuf;
use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_rulepack::rule_pack::{
    assert_translation_numeric_integrity, check_translation_numeric_integrity, extract_mechanical_tokens, load_rule_pack, load_rule_packs, parse_glossary_csv,
    parse_json_lines, parse_metadata_yaml, validate_rule_pack, RulePackValidationError,
};

static FIXTURE: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("../fixtures/rule-pack.json")).expect("эталон rule-pack"));

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../data/rule_packs")
}

fn load(id: &str) -> Value {
    load_rule_pack(id, &root()).unwrap_or_else(|error| panic!("{id}: {error}"))
}

fn without_directory(mut pack: Value) -> Value {
    pack.as_object_mut().expect("пакет").shift_remove("directory");
    pack
}

fn outcome(result: Result<Value, RulePackValidationError>) -> Value {
    match result {
        Ok(value) => json!({ "ok": value }),
        Err(error) if error.details.as_object().is_some_and(|details| !details.is_empty()) => json!({ "error": error.message, "details": error.details }),
        Err(error) => json!({ "error": error.message }),
    }
}

/// Правка эталона: путь в пакете, `set` или `delete`, порядок ключей как в JS.
fn apply_patch(base: &Value, patch: &[Value]) -> Value {
    let mut pack = base.clone();
    for step in patch {
        let path = step["path"].as_array().expect("путь");
        let (last, parents) = path.split_last().expect("непустой путь");
        let mut target = &mut pack;
        for key in parents {
            target = match key {
                Value::String(key) => target.get_mut(key.as_str()).expect("поле"),
                Value::Number(index) => target.get_mut(index.as_u64().expect("индекс") as usize).expect("элемент"),
                other => panic!("ключ {other}"),
            };
        }
        let delete = step["op"] == "delete";
        match (last, target) {
            (Value::String(key), Value::Object(map)) => {
                if delete {
                    map.shift_remove(key.as_str());
                } else {
                    map.insert(key.clone(), step["value"].clone());
                }
            }
            (Value::Number(index), Value::Array(items)) => {
                let index = index.as_u64().expect("индекс") as usize;
                assert!(!delete, "удаление элемента массива не используется");
                items[index] = step["value"].clone();
            }
            (key, target) => panic!("правка {key} в {target}"),
        }
    }
    pack
}

#[test]
fn loaded_packs_match_js() {
    for (id, expected) in FIXTURE["packs"].as_object().expect("пакеты") {
        assert_eq!(&without_directory(load(id)), expected, "{id}");
    }
}

#[test]
fn mechanical_tokens_match_js() {
    let cases = FIXTURE["tokens"].as_array().expect("токены");
    assert!(cases.len() > 100);
    for case in cases {
        let text = case["text"].as_str().expect("текст");
        assert_eq!(json!(extract_mechanical_tokens(text)), case["tokens"], "{text:?}");
    }
    for case in FIXTURE["integrity"].as_array().expect("сверка") {
        let check = check_translation_numeric_integrity(case["source"].as_str().expect("en"), case["translated"].as_str().expect("ru"));
        assert_eq!(check.to_json(), case["check"]);
    }
}

#[test]
fn parsers_match_js() {
    for case in FIXTURE["yaml"].as_array().expect("yaml") {
        let source = case["source"].as_str().expect("источник");
        assert_eq!(outcome(parse_metadata_yaml(source, "case.yaml")), case["result"], "{source:?}");
    }
    for case in FIXTURE["csv"].as_array().expect("csv") {
        let source = case["source"].as_str().expect("источник");
        assert_eq!(outcome(parse_glossary_csv(source, "case.csv")), case["result"], "{source:?}");
    }
    for case in FIXTURE["jsonl"].as_array().expect("jsonl") {
        let source = case["source"].as_str().expect("источник");
        assert_eq!(outcome(parse_json_lines(source, "case.jsonl").map(Value::Array)), case["result"], "{source:?}");
    }
}

#[test]
fn validation_of_mutated_packs_matches_js() {
    let cases = FIXTURE["validation"].as_array().expect("правки");
    assert!(cases.len() > 800);
    for case in cases {
        let pack = match case["pack"].as_str() {
            Some(id) => apply_patch(&FIXTURE["packs"][id], case["patch"].as_array().expect("правка")),
            None => case["value"].clone(),
        };
        let expected = case["expected"].as_str();
        assert_eq!(outcome(validate_rule_pack(&pack, expected)), case["result"], "{}", case["patch"]);
    }
}

#[test]
fn loader_outcomes_match_js() {
    for case in FIXTURE["loads"].as_array().expect("загрузки") {
        let id = case["id"].as_str().expect("id");
        match load_rule_pack(id, &root()) {
            Ok(pack) => assert_eq!(pack["summary"], case["summary"], "{id}"),
            Err(error) => assert_eq!(error.message.split(':').next(), case["error"].as_str(), "{id}: {}", error.message),
        }
    }
}

// --- перенос test/rule-pack.test.mjs ---------------------------------------

#[test]
fn loads_and_validates_the_bilingual_p0_rule_pack() {
    let pack = load("srd_5_2_1");
    assert_eq!(pack["summary"], json!({ "ruleset_id": "srd_5_2_1", "pack_id": "srd_5_2_1", "rule_count": 23, "glossary_term_count": 25, "ontology_edge_count": 23 }));
    assert_eq!(pack["manifest"]["canonical_language"], "en");
    assert_eq!(pack["manifest"]["display_languages"], json!(["ru", "en"]));
    let rules = pack["rules"].as_array().expect("правила");
    let ids: std::collections::HashSet<&str> = rules.iter().filter_map(|rule| rule["id"].as_str()).collect();
    assert_eq!(ids.len(), rules.len());
    assert!(rules.iter().all(|rule| rule["ruleset_id"] == pack["manifest"]["ruleset_id"]));
    assert!(rules.iter().all(|rule| ["title_en", "title_ru", "text_en", "text_ru"].iter().all(|field| rule[*field].as_str().is_some_and(|text| !text.is_empty()))));
    assert!(rules.iter().all(|rule| rule["license_id"] == "ORIGINAL-PARAPHRASE"));
}

#[test]
fn loads_the_russian_canonical_2014_pack_with_pinned_sources() {
    let pack = load("dnd_5e_2014");
    assert_eq!(
        pack["summary"],
        json!({ "ruleset_id": "dnd_5e_2014", "pack_id": "dnd_5e_2014", "rule_count": 28, "glossary_term_count": 34, "ontology_edge_count": 32, "source_count": 10 })
    );
    assert_eq!(pack["manifest"]["canonical_language"], "ru");
    assert_eq!(pack["manifest"]["edition_family"], "5e_2014");
    assert_eq!(pack["manifest"]["activation_status"], "preview");
    assert_eq!(pack["sourceRegistry"]["content_policy"]["copyrighted_page_text"], "not_bundled");
    let sources = pack["sourceRegistry"]["sources"].as_array().expect("источники");
    assert!(sources.iter().all(|source| source["url"].as_str().is_some_and(|url| url.starts_with("https://5e14.dnd.su/"))));
    assert!(sources.iter().all(|source| source["bundled"] == false));
    let rules = pack["rules"].as_array().expect("правила");
    assert!(rules.iter().all(|rule| rule["source_ref"].is_string() && rule["source_hash"].is_string()));
    assert!(rules.iter().any(|rule| rule["id"] == "dnd_5e_2014:environment:suffocation" && rule["text_ru"].as_str().is_some_and(|text| text.contains("опускаются до 0"))));
    assert!(rules.iter().any(|rule| rule["id"] == "dnd_5e_2014:classes:fighter-indomitable" && !rule["text_ru"].as_str().is_some_and(|text| text.contains("бонусом, равным уровню"))));
}

#[test]
fn formalization_metadata_matches_the_coverage_report() {
    let pack = load("srd_5_2_1");
    let count = |level: &str| pack["rules"].as_array().expect("правила").iter().filter(|rule| rule["formalization_level"] == level).count() as u64;
    assert_eq!(count("deterministic"), pack["coverage"]["deterministic_rule_count"].as_u64().expect("число"));
    assert_eq!(count("structured"), pack["coverage"]["structured_rule_count"].as_u64().expect("число"));
    assert_eq!(count("retrieval_only"), pack["coverage"]["retrieval_only_rule_count"].as_u64().expect("число"));
}

#[test]
fn mechanical_number_signatures_preserve_dice_modifiers_fractions_and_dc() {
    assert_eq!(extract_mechanical_tokens("Roll 2d6 + 3, compare DC 10, then apply 1/2 or 50%."), ["1/2", "10", "2d6+3", "50%"]);
    let valid = check_translation_numeric_integrity("Roll 2d6 + 3 and compare the total with DC 10.", "Бросьте 2d6 + 3 и сравните итог со СЛ 10.");
    assert!(valid.ok);
    let invalid = check_translation_numeric_integrity("Roll 2d6 + 3 and compare the total with DC 10.", "Бросьте 2d8 + 3 и сравните итог со СЛ 10.");
    assert!(!invalid.ok);
    assert_eq!(invalid.missing, ["2d6+3"]);
    assert_eq!(invalid.extra, ["2d8+3"]);
}

#[test]
fn every_stored_translation_passes_numeric_integrity() {
    for id in ["srd_5_2_1", "dnd_5e_2014"] {
        for rule in load(id)["rules"].as_array().expect("правила") {
            assert!(assert_translation_numeric_integrity(rule).expect("перевод").ok, "{}", rule["id"]);
        }
    }
}

#[test]
fn validation_rejects_a_translated_mechanical_number_change() {
    let mut pack = load("srd_5_2_1");
    let target = pack["rules"].as_array_mut().expect("правила").iter_mut().find(|rule| rule["id"].as_str().is_some_and(|id| id.ends_with("advantage-disadvantage"))).expect("правило");
    let id = target["id"].clone();
    let text = target["text_ru"].as_str().expect("текст").replace("2d20", "2d12");
    target["text_ru"] = Value::String(text);
    let error = validate_rule_pack(&pack, Some("srd_5_2_1")).expect_err("отказ");
    assert!(error.message.contains("changes mechanical numbers"));
    assert_eq!(error.details["rule_id"], id);
}

#[test]
fn validation_strictly_rejects_rules_and_edges_from_another_ruleset() {
    let mut mixed_rules = load("srd_5_2_1");
    mixed_rules["rules"][0]["ruleset_id"] = json!("other_edition");
    assert!(validate_rule_pack(&mixed_rules, None).expect_err("правило").message.contains("belongs to other_edition"));
    let mut mixed_edges = load("srd_5_2_1");
    mixed_edges["ontologyEdges"][0]["ruleset_id"] = json!("other_edition");
    assert!(validate_rule_pack(&mixed_edges, None).expect_err("ребро").message.contains("mixes other_edition"));
}

#[test]
fn source_registry_rejects_unknown_or_mismatched_revisions() {
    let mut unknown = load("dnd_5e_2014");
    unknown["rules"][0]["source_ref"] = json!("dndsu-2014-unknown");
    assert!(validate_rule_pack(&unknown, None).expect_err("источник").message.contains("references unknown source"));
    let mut mismatched = load("dnd_5e_2014");
    mismatched["rules"][0]["source_hash"] = json!("another-revision");
    assert!(validate_rule_pack(&mismatched, None).expect_err("ревизия").message.contains("source revision does not match"));
}

#[test]
fn loader_rejects_invalid_and_unavailable_ruleset_ids_without_traversal() {
    assert!(load_rule_pack("../srd_5_2_1", &root()).expect_err("обход").message.starts_with("Invalid ruleset_id"));
    let missing = load_rule_pack("not_installed_ruleset", &root()).expect_err("нет пакета");
    assert!(missing.message.starts_with("Unable to read rule pack"));
    assert_eq!(missing.details["ruleset_id"], "not_installed_ruleset");
    assert_eq!(load_rule_packs(&[], &root()).expect_err("пусто").message, "rulesetIds must be a non-empty array");
    assert_eq!(load_rule_packs(&["srd_5_2_1", "srd_5_2_1"], &root()).expect_err("повтор").message, "rulesetIds contains duplicates");
    assert_eq!(load_rule_packs(&["srd_5_2_1", "dnd_5e_2014"], &root()).expect("оба").len(), 2);
}

#[test]
fn metadata_and_glossary_parsers_are_strict_and_deterministic() {
    assert_eq!(
        parse_metadata_yaml("ruleset_id: demo\nlanguages:\n  - ru\n  - en\ncount: 2\n", "metadata.yaml").expect("yaml"),
        json!({ "ruleset_id": "demo", "languages": ["ru", "en"], "count": 2 })
    );
    assert!(parse_metadata_yaml("root:\n  nested: value\n", "metadata.yaml").expect_err("вложенность").message.contains("nested YAML is not supported"));
    let glossary = parse_glossary_csv("canonical_id,term_en,term_ru,aliases_ru,notes\nterm:test,check,проверка,\"чек|тест\",note\n", "glossary.csv").expect("csv");
    assert_eq!(glossary, json!([{ "canonical_id": "term:test", "term_en": "check", "term_ru": "проверка", "aliases_ru": ["чек", "тест"], "notes": "note" }]));
}

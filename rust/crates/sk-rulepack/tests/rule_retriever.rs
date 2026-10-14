//! Сверка `rule_retriever` с эталоном JS (`fixtures/rule-retriever.json`,
//! генератор `fixtures/gen-rule-retriever.mjs`) и перенос
//! `test/rule-retriever.test.mjs`.

use std::path::PathBuf;
use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_rulepack::rule_pack::load_rule_pack;
use sk_rulepack::rule_retriever::{deterministic_local_vector, levenshtein_distance, normalize_for_search, stem_search_token, tokenize_for_search};
use sk_rulepack::{RetrieverError, RuleRetriever};

static FIXTURE: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("../fixtures/rule-retriever.json")).expect("эталон rule-retriever"));

const RULESET_ID: &str = "srd_5_2_1";

fn load(id: &str) -> Value {
    load_rule_pack(id, &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../data/rule_packs")).unwrap_or_else(|error| panic!("{id}: {error}"))
}

fn retriever() -> RuleRetriever {
    RuleRetriever::new(&[load(RULESET_ID)]).expect("индекс")
}

fn error_json(error: &RetrieverError) -> Value {
    let name = match error {
        RetrieverError::Type(_) => "TypeError",
        RetrieverError::Range(_) => "RangeError",
        RetrieverError::Validation(_) => "RulePackValidationError",
    };
    json!({ "name": name, "message": error.message() })
}

#[test]
fn text_helpers_match_js() {
    let cases = FIXTURE["texts"].as_array().expect("тексты");
    assert!(cases.len() > 500);
    let pairs = |tokens: Vec<sk_rulepack::rule_retriever::SearchToken>| json!(tokens.into_iter().map(|token| json!([token.raw, token.stem])).collect::<Vec<_>>());
    for case in cases {
        let text = case["text"].as_str().expect("текст");
        assert_eq!(normalize_for_search(text), case["normalized"].as_str().expect("норма"), "{text:?}");
        assert_eq!(stem_search_token(text), case["stem"].as_str().expect("стем"), "{text:?}");
        assert_eq!(pairs(tokenize_for_search(text, false)), case["tokens"], "{text:?}");
        assert_eq!(pairs(tokenize_for_search(text, true)), case["tokens_all"], "{text:?}");
    }
}

#[test]
fn levenshtein_matches_js() {
    for case in FIXTURE["levenshtein"].as_array().expect("пары") {
        let maximum = case["maximum"].as_u64().map(|value| value as usize);
        let distance = levenshtein_distance(case["left"].as_str().expect("слева"), case["right"].as_str().expect("справа"), maximum);
        assert_eq!(distance as u64, case["distance"].as_u64().expect("расстояние"), "{case}");
    }
}

#[test]
fn local_vectors_match_js_bit_for_bit() {
    for (key, dimensions) in [("vectors", None), ("vectors64", Some(64))] {
        for case in FIXTURE[key].as_array().expect("векторы") {
            let text = case["text"].as_str().expect("текст");
            let vector = deterministic_local_vector(text, dimensions).expect("вектор");
            let expected: Vec<f64> = case["vector"].as_array().expect("числа").iter().map(|value| value.as_f64().expect("число")).collect();
            assert_eq!(vector, expected, "{text:?}");
        }
    }
}

#[test]
fn searches_match_js() {
    let packs = [load("srd_5_2_1"), load("dnd_5e_2014"), FIXTURE["foreign"].clone()];
    let retriever = RuleRetriever::new(&packs).expect("индекс");
    let rule_by_id = |id: &str| packs.iter().flat_map(|pack| pack["rules"].as_array().expect("правила")).find(|rule| rule["id"] == id).cloned().expect("правило");
    let cases = FIXTURE["searches"].as_array().expect("запросы");
    assert!(cases.len() > 400);
    let mut compared = 0;
    for case in cases {
        let request = &case["request"];
        match retriever.search(request) {
            Ok(mut result) => {
                assert!(case["error"].is_null(), "{request}: ожидался отказ {}", case["error"]);
                for entry in result["results"].as_array_mut().expect("результаты") {
                    let rule = rule_by_id(entry["rule_id"].as_str().expect("rule_id"));
                    let map = entry.as_object_mut().expect("результат");
                    assert_eq!(map.shift_remove("rule"), Some(rule.clone()));
                    assert_eq!(map.shift_remove("text_en"), Some(rule["text_en"].clone()));
                    assert_eq!(map.shift_remove("text_ru"), Some(rule["text_ru"].clone()));
                    compared += 1;
                }
                assert_eq!(result, case["result"], "{request}");
            }
            Err(error) => assert_eq!(error_json(&error), case["error"], "{request}"),
        }
    }
    assert!(compared > 1500, "сверено результатов: {compared}");
}

#[test]
fn constructor_refusals_match_js() {
    let srd = load("srd_5_2_1");
    let mut invalid = srd.clone();
    invalid["coverage"] = Value::Null;
    let outcomes = [
        ("empty", RuleRetriever::new(&[])),
        ("null-pack", RuleRetriever::new(&[srd.clone(), Value::Null])),
        ("dimensions", RuleRetriever::with_vector_dimensions(&[srd.clone()], 128)),
        ("duplicate", RuleRetriever::new(&[srd.clone(), srd.clone()])),
        ("invalid", RuleRetriever::new(&[invalid])),
    ];
    for (label, outcome) in outcomes {
        let expected = FIXTURE["constructors"].as_array().expect("конструкторы").iter().find(|case| case["label"] == label).expect("случай");
        match outcome {
            Ok(_) => assert_eq!(expected["ok"], true, "{label}"),
            Err(error) => assert_eq!(error_json(&error), expected["error"], "{label}"),
        }
    }
}

// --- перенос test/rule-retriever.test.mjs ----------------------------------

#[test]
fn retrieves_the_expected_rule_for_each_question() {
    let cases = [
        ("Как работает помеха?", "srd_5_2_1:core:advantage-disadvantage"),
        ("Можно ли сделать реакцию?", "srd_5_2_1:combat:reaction"),
        ("Что происходит при нуле хитов?", "srd_5_2_1:combat:zero-hit-points"),
        ("Нужно ли держать концентрацию?", "srd_5_2_1:spells:concentration"),
        ("У меня преимущество на атаку?", "srd_5_2_1:core:advantage-disadvantage"),
        ("Без помехи на броске атаки", "srd_5_2_1:core:advantage-disadvantage"),
        ("Помехха на атаке", "srd_5_2_1:core:advantage-disadvantage"),
        ("Концентрацыя", "srd_5_2_1:spells:concentration"),
        ("How do death saving throws work at zero hp?", "srd_5_2_1:combat:zero-hit-points"),
        ("Can I use a reaction after an attack?", "srd_5_2_1:combat:reaction"),
        ("Можно use reaction after attack?", "srd_5_2_1:combat:reaction"),
        ("Бросаю два d20 и беру худший", "srd_5_2_1:core:advantage-disadvantage"),
        ("Пытаюсь выплыть из бурной воды", "srd_5_2_1:environment:swimming"),
        ("Сколько герой может задерживать дыхание до удушья?", "srd_5_2_1:environment:suffocation"),
        ("Сколько серебряных монет в одной золотой?", "srd_5_2_1:economy:coins"),
        ("За сколько торговец выкупает обычное снаряжение?", "srd_5_2_1:economy:selling-equipment"),
        ("Как работает Аура защиты паладина?", "srd_5_2_1:classes:paladin-aura-of-protection"),
        ("Как воин использует Несгибаемого после провала спасброска?", "srd_5_2_1:classes:fighter-indomitable"),
    ];
    let retriever = retriever();
    for (query, expected) in cases {
        let result = retriever.search(&json!({ "queries": [query], "ruleset_id": RULESET_ID, "enabled_packs": [RULESET_ID], "limit": 5 })).expect("поиск");
        assert_eq!(result["results"][0]["rule_id"], expected, "{query}");
        assert!(result["results"].as_array().expect("результаты").iter().all(|entry| entry["ruleset_id"] == RULESET_ID));
    }
}

#[test]
fn ontology_expands_a_direct_concentration_hit_to_its_saving_throw_neighbor() {
    let result = retriever().search(&json!({ "queries": ["концентрация"], "rulesetId": RULESET_ID, "limit": 5 })).expect("поиск");
    assert_eq!(result["results"][0]["rule_id"], "srd_5_2_1:spells:concentration");
    let results = result["results"].as_array().expect("результаты");
    let saving_throw = results.iter().find(|entry| entry["rule_id"] == "srd_5_2_1:checks:saving-throw").expect("спасбросок");
    assert!(saving_throw["score_breakdown"]["ontology"].as_f64().expect("онтология") > 0.0);
    assert!(saving_throw["ontology_reasons"].as_array().expect("причины").iter().any(|reason| reason["from_rule_id"].as_str().is_some_and(|id| id.ends_with(":spells:concentration"))));
}

#[test]
fn ruleset_and_enabled_pack_filters_never_mix_editions() {
    let retriever = RuleRetriever::new(&[load(RULESET_ID), FIXTURE["foreign"].clone()]).expect("индекс");
    let base = retriever.search(&json!({ "queries": ["quantum flumph помеха"], "ruleset_id": RULESET_ID, "enabled_packs": [RULESET_ID], "limit": 20 })).expect("поиск");
    let results = base["results"].as_array().expect("результаты");
    assert!(!results.is_empty());
    assert!(results.iter().all(|entry| entry["ruleset_id"] == RULESET_ID && !entry["rule_id"].as_str().is_some_and(|id| id.contains("foreign_edition"))));
    let foreign = retriever.search(&json!({ "queries": ["quantum flumph"], "ruleset_id": "foreign_edition", "enabled_packs": ["foreign_edition"] })).expect("поиск");
    assert_eq!(foreign["results"][0]["rule_id"], "foreign_edition:core:quantum-flumph");
    let mixed = retriever.search(&json!({ "queries": ["помеха"], "ruleset_id": RULESET_ID, "enabled_packs": ["foreign_edition"] })).expect_err("смешение");
    assert!(mixed.message().contains("belongs to foreign_edition, not requested srd_5_2_1"));
    assert!(retriever.search(&json!({ "queries": ["помеха"], "ruleset_id": "missing" })).expect_err("нет").message().contains("Unknown ruleset_id"));
    assert!(retriever.search(&json!({ "queries": ["помеха"] })).expect_err("нет id").message().contains("ruleset_id is required"));
}

#[test]
fn installed_2014_and_2024_packs_remain_isolated_in_one_retriever() {
    let retriever = RuleRetriever::new(&[load("srd_5_2_1"), load("dnd_5e_2014")]).expect("индекс");
    let result = retriever
        .search(&json!({ "queries": ["Сколько раундов можно дышать после задержки дыхания?"], "ruleset_id": "dnd_5e_2014", "enabled_packs": ["dnd_5e_2014"], "limit": 10 }))
        .expect("поиск");
    assert_eq!(result["results"][0]["rule_id"], "dnd_5e_2014:environment:suffocation");
    assert!(result["results"].as_array().expect("результаты").iter().all(|entry| entry["ruleset_id"] == "dnd_5e_2014"));
    assert!(result["results"][0]["text_ru"].as_str().expect("текст").contains("опускаются до 0"));
    let mixed = retriever.search(&json!({ "queries": ["удушье"], "ruleset_id": "dnd_5e_2014", "enabled_packs": ["srd_5_2_1"] })).expect_err("смешение");
    assert!(mixed.message().contains("belongs to srd_5_2_1, not requested dnd_5e_2014"));
}

#[test]
fn same_request_produces_stable_ids_ordering_scores_and_explanations() {
    let retriever = retriever();
    let request = json!({ "queries": ["атака с преимуществом", "advantage on attack"], "ruleset_id": RULESET_ID, "enabled_packs": [RULESET_ID], "limit": 8 });
    let first = retriever.search(&request).expect("поиск");
    assert_eq!(first, retriever.search(&request).expect("повтор"));
    let scores: Vec<f64> = first["results"].as_array().expect("результаты").iter().map(|entry| entry["score"].as_f64().expect("оценка")).collect();
    assert!(scores.windows(2).all(|pair| pair[0] >= pair[1]));
}

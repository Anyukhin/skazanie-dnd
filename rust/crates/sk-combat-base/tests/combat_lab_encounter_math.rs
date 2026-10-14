//! Сверка `combat_lab_encounter_math` с эталоном JS
//! (`fixtures/combat-lab-encounter-math.json`, генератор
//! `fixtures/gen-combat-lab-encounter-math.mjs`) и перенос проверок
//! `test/combat-lab-encounter.test.mjs`, касающихся самого расчёта.

use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_combat_base::combat_lab_encounter_math::{
    assess_encounter_roster, challenge_rating_value, encounter_interval, encounter_multiplier, party_thresholds_2014, select_encounter_roster, xp_thresholds_2014_json,
    AssessmentRequest, RosterRequest, Thresholds, COMBAT_LAB_RULES_SOURCE_2014,
};
use sk_core::js;

static FIXTURE: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("../fixtures/combat-lab-encounter-math.json")).expect("эталон расчёта встречи"));

fn outcome<T>(result: Result<T, sk_combat_base::combat_lab_encounter_math::EncounterMathError>, to_json: impl Fn(T) -> Value) -> Value {
    match result {
        Ok(value) => json!({ "ok": to_json(value) }),
        Err(error) => json!({ "error": error.0 }),
    }
}

fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}

#[test]
fn threshold_table_matches_js() {
    assert_eq!(xp_thresholds_2014_json(), FIXTURE["thresholdsTable"]);
    for case in array(&FIXTURE["thresholds"]) {
        assert_eq!(outcome(party_thresholds_2014(array(&case["levels"])), |row| row.to_json()), case["result"], "{}", case["levels"]);
    }
}

#[test]
fn multipliers_and_challenge_ratings_match_js() {
    for case in array(&FIXTURE["multipliers"]) {
        let multiplier = encounter_multiplier(js::number(Some(&case["count"])), js::number(Some(&case["size"])));
        assert_eq!(js::num(multiplier), case["multiplier"], "{case}");
    }
    for case in array(&FIXTURE["challengeRatings"]) {
        let value = challenge_rating_value(Some(&case["value"]));
        assert_eq!(value.map_or(Value::Null, js::num), case["result"], "{case}");
    }
}

#[test]
fn intervals_match_js() {
    for case in array(&FIXTURE["intervals"]) {
        let row = &case["thresholds"];
        let thresholds = Thresholds {
            easy: row["easy"].as_i64().expect("easy"),
            medium: row["medium"].as_i64().expect("medium"),
            hard: row["hard"].as_i64().expect("hard"),
            deadly: row["deadly"].as_i64().expect("deadly"),
        };
        let difficulty = case["difficulty"].as_str().expect("сложность");
        assert_eq!(outcome(encounter_interval(difficulty, &thresholds), |interval| interval.to_json()), case["result"], "{case}");
    }
}

#[test]
fn roster_selection_matches_js() {
    let sets = &FIXTURE["recordSets"];
    let cases = array(&FIXTURE["selections"]);
    assert!(cases.len() > 350);
    let empty: Vec<Value> = Vec::new();
    let zero = vec![json!({ "id": "z", "xp": 0, "challenge_rating": "0" })];
    let too_strong = vec![json!({ "id": "s", "xp": 5900, "challenge_rating": "10" })];
    let mut fitted = 0;
    for case in cases {
        let request = &case["request"];
        let set = request["set"].as_str().expect("набор");
        let records: &[Value] = match set {
            "empty" => &empty,
            "zero" => &zero,
            "tooStrong" => &too_strong,
            name => array(&sets[name]),
        };
        let result = select_encounter_roster(RosterRequest {
            records,
            party_levels: array(&request["partyLevels"]),
            difficulty: request["difficulty"].as_str().expect("сложность"),
            seed: request.get("seed"),
            maximum_creatures: request.get("maximumCreatures"),
        });
        let actual = outcome(result, |roster| {
            let mut value = roster.to_json();
            value["records"] = Value::Array(roster.records.iter().map(|record| record.get("id").cloned().unwrap_or(Value::Null)).collect());
            value
        });
        if actual.get("ok").is_some() {
            fitted += 1;
        }
        assert_eq!(actual, case["result"], "{request}");
    }
    assert!(fitted > 300, "подобрано составов: {fitted}");
}

#[test]
fn assessments_match_js() {
    for case in array(&FIXTURE["assessments"]) {
        let request = &case["request"];
        let result = assess_encounter_roster(AssessmentRequest {
            records: array(&request["records"]),
            party_levels: array(&request["partyLevels"]),
            difficulty: request["difficulty"].as_str().expect("сложность"),
            seed: request.get("seed"),
        });
        assert_eq!(outcome(result, |value| value), case["result"], "{request}");
    }
}

// --- перенос test/combat-lab-encounter.test.mjs ------------------------------

#[test]
fn thresholds_and_party_size_multiplier_follow_the_published_rules() {
    assert_eq!(party_thresholds_2014(&[json!(3), json!(3), json!(3), json!(2)]).expect("пороги").to_json(), json!({ "easy": 275, "medium": 550, "hard": 825, "deadly": 1400 }));
    assert_eq!(encounter_multiplier(1.0, 2.0), 1.5);
    assert_eq!(encounter_multiplier(2.0, 2.0), 2.0);
    assert_eq!(encounter_multiplier(4.0, 4.0), 2.0);
    assert_eq!(encounter_multiplier(1.0, 6.0), 0.5);
    assert_eq!(encounter_multiplier(4.0, 6.0), 1.5);
    assert_eq!(encounter_multiplier(15.0, 1.0), 5.0);
    assert_eq!(COMBAT_LAB_RULES_SOURCE_2014.edition, "2014");
}

#[test]
fn assessment_counts_actual_xp_and_does_not_fabricate_an_empty_fight() {
    let empty = assess_encounter_roster(AssessmentRequest { records: &[], party_levels: &[json!(3), json!(2)], difficulty: "medium", seed: Some(&json!(17)) }).expect("оценка");
    assert_eq!((empty["rawXp"].clone(), empty["adjustedXp"].clone(), empty["difficulty"].clone(), empty["matched"].clone()), (json!(0), json!(0), json!("trivial"), json!(false)));
    let goblin = [json!({ "id": "dnd_5e_2014:monster:goblin", "xp": 50, "challenge_rating": "1/4" })];
    let explicit = assess_encounter_roster(AssessmentRequest { records: &goblin, party_levels: &[json!(1)], difficulty: "hard", seed: Some(&json!(17)) }).expect("оценка");
    assert_eq!(explicit["rawXp"], 50);
    assert_eq!(explicit["adjustedXp"], 75);
    assert_eq!(explicit["multiplier"], 1.5);
    assert_eq!(explicit["difficulty"], "hard");
    assert_eq!(explicit["matched"], true);
    assert_eq!(explicit["seed"], "17");
}

#[test]
fn generated_roster_is_seeded_bounded_and_matched() {
    let records = array(&FIXTURE["recordSets"]["low"]);
    let levels = [json!(3), json!(2)];
    let request = RosterRequest { records, party_levels: &levels, difficulty: "hard", seed: Some(&json!("same-seed")), maximum_creatures: None };
    let first = select_encounter_roster(request).expect("состав");
    assert_eq!(first, select_encounter_roster(request).expect("повтор"));
    assert!((1..=4).contains(&first.records.len()));
    assert!(first.adjusted_xp >= first.interval.lower && first.adjusted_xp <= first.interval.upper);
    let deadly = select_encounter_roster(RosterRequest { difficulty: "deadly", ..request }).expect("смертельная");
    assert_eq!(deadly.interval.upper, f64::INFINITY);
    assert!(deadly.to_json()["interval"]["upper"].is_null());
}

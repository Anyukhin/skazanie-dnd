//! Сверка `wild_shape` с эталоном JS (`fixtures/wild-shape.json`, генератор
//! `fixtures/gen-wild-shape.mjs`) и перенос проверок `test/wild-shape.test.mjs`,
//! касающихся самого модуля (облики и их числа; исполнение команды — Rules Engine).

mod common;

use std::sync::LazyLock;

use common::{arg, array, assert_same, parse};
use serde_json::{json, Value};
use sk_combat_content::wild_shape as m;

static FIXTURE: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../fixtures/wild-shape.json")));

#[test]
fn forms_match_js() {
    let forms = Value::Array(m::WILD_SHAPE_FORMS.iter().map(m::WildShapeForm::to_value).collect());
    assert_same(&forms, &FIXTURE["forms"], "WILD_SHAPE_FORMS");
}

#[test]
fn limits_and_choices_match_js() {
    let form_ids = [None, Some(json!("wolf")), Some(json!("giant-boar")), Some(json!("brown-bear")), Some(json!("dire-wolf")), Some(json!("nope")), Some(Value::Null), Some(json!(5))];
    let cases = array(&FIXTURE["cases"]);
    assert!(cases.len() > 200);
    for case in cases {
        let actor = arg(&case["actor"]);
        assert_eq!(json!(m::is_moon_druid(actor)), case["moon"], "isMoonDruid {case}");
        assert_eq!(sk_core::js::num(m::wild_shape_challenge_limit(actor)), case["limit"], "wildShapeChallengeLimit {case}");
        let forms: Vec<&str> = m::wild_shape_forms_for(actor).iter().map(|form| form.id).collect();
        assert_eq!(json!(forms), case["forms"], "wildShapeFormsFor {case}");
        let chosen: Vec<Value> = form_ids.iter().map(|id| m::wild_shape_form_for(actor, id.as_ref()).map_or(Value::Null, |form| Value::from(form.id))).collect();
        assert_eq!(json!(chosen), case["chosen"], "wildShapeFormFor {case}");
    }
}

/// Круг луны 7-го уровня принимает гигантского кабана (ПО 2) с его хитами.
#[test]
fn moon_druid_seven_takes_giant_boar() {
    let druid = json!({ "characterClass": "druid", "subclass": "Круг луны", "level": 7 });
    let form = m::wild_shape_form_for(Some(&druid), None).expect("облик");
    assert_eq!(form.id, "giant-boar");
    assert_eq!(form.hp, 42.0);
    assert_eq!(form.challenge_rating, 2.0);
    let land = json!({ "characterClass": "druid", "subclass": "Круг земли", "level": 7 });
    assert!(m::wild_shape_forms_for(Some(&land)).iter().all(|form| form.challenge_rating <= 0.5));
    assert!(m::wild_shape_form_for(Some(&json!({ "characterClass": "druid", "level": 1 })), None).is_none());
}

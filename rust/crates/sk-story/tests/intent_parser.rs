//! Сверка `intent_parser` с эталоном JS (`fixtures/intent-parser.json.gz`,
//! генератор `fixtures/gen-intent-parser.mjs`): вызовы из тестов JS,
//! настоящие фразы игроков на состояниях тестов и корпуса, случайный мусор.

mod common;

use common::{run, Args, Fixture, Outcome};
use serde_json::{json, Value};
use sk_story::intent_parser::*;

fn call(name: &str, args: &Args) -> Option<Outcome> {
    let ok = |value: Value| Some(Ok(Some(value)));
    match name {
        "normalizeRequestKind" => ok(json!(normalize_request_kind(args.get(0)))),
        "inferRequestKind" => ok(json!(infer_request_kind(args.get(0)))),
        "isSceneObservationRequest" => ok(json!(is_scene_observation_request(args.get(0)))),
        "waitTargetFromText" => ok(wait_target_from_text(args.get(0)).map_or(Value::Null, |target| target.to_json())),
        "classifyFreeActionKind" => ok(classify_free_action_kind(args.get(0)).map_or(Value::Null, |kind| json!(kind))),
        "actionSequence" => ok(json!(action_sequence(args.get(0)))),
        "sameNameToken" => ok(json!(same_name_token(args.str(0), args.str(1)))),
        "resolvePresentSocialActors" => ok(Value::Array(resolve_present_social_actors(args.get(0), args.get(1)))),
        "namedKnownSpell" => ok(named_known_spell(args.get(0), args.get(1), args.get(2)).map_or(Value::Null, |spell| spell.to_json())),
        "buildRuleQueries" => ok(json!(build_rule_queries(args.get(0), args.get(1)))),
        "IntentParser.parse" => ok(IntentParser::new().parse(args.get(0), args.get(1), args.get(2))),
        _ => None,
    }
}

#[test]
fn intent_parser_matches_js() {
    let fixture = Fixture::load_gz(include_bytes!("../fixtures/intent-parser.json.gz"));
    assert!(fixture.cases.len() > 10_000, "эталон полон: {}", fixture.cases.len());
    run(&fixture, call);
}

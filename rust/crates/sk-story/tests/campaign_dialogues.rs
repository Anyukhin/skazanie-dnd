//! Сверка `campaign_dialogues` с эталоном JS (`fixtures/campaign-dialogues.json.gz`,
//! генератор `fixtures/gen-campaign-dialogues.mjs`): вызовы из тестов JS,
//! состояния корпуса Асстохана и случайный мусор.

mod common;

use common::{run, set_value, Args, Fixture, Outcome};
use serde_json::{json, Value};
use sk_story::campaign_dialogues::*;

fn call(name: &str, args: &Args) -> Option<Outcome> {
    let ok = |value: Value| Some(Ok(Some(value)));
    match name {
        "dialogueActionChecks" => {
            let action = args.value(0);
            let built = DialogueAction {
                command_type: sk_core::js::s(action.get("command_type")),
                catalog_id: None,
                informant_id: None,
                choice: action.get("choice").and_then(Value::as_str).map(str::to_string),
            };
            ok(json!(dialogue_action_checks(&built)))
        }
        "normalizeDialogues" => Some(match normalize_dialogues(args.value(0)) {
            Ok(list) => Ok(Some(Value::Array(list.iter().map(Dialogue::to_json).collect()))),
            Err(message) => Err(message),
        }),
        "dialogueFor" => ok(dialogue_for(args.value(0), args.get(1)).map_or(Value::Null, Dialogue::to_json)),
        "dialogueProgress" => ok(dialogue_progress(args.value(0), args.str(1)).to_json()),
        "dialogueFlags" => ok(set_value(&dialogue_flags(args.value(0)))),
        "dialogueRevealFactId" => ok(json!(dialogue_reveal_fact_id(args.value(0), args.get(1)))),
        "dialogueGrantedFactIds" => ok(set_value(&dialogue_granted_fact_ids(args.value(0)))),
        "dialogueOptionUnlocked" => {
            let dialogue = DIALOGUES.iter().find(|entry| entry.id == args.str(1))?;
            let option = dialogue.options.iter().find(|entry| entry.id == args.str(2))?;
            ok(json!(dialogue_option_unlocked(args.value(0), dialogue, option)))
        }
        "dialogueOptionsFor" => ok(dialogue_options_for(args.value(0), args.get(1), args.get(2)).unwrap_or(Value::Null)),
        "normalizeDialogueState" => ok(normalize_dialogue_state(args.get(0))),
        "applyDialogueEvent" => ok(apply_dialogue_event(args.get(0), args.get(1))),
        "sceneDialoguesForViewer" => ok(scene_dialogues_for_viewer(args.value(0), args.get(1).and_then(|viewer| viewer.get("playerId")))),
        "dialogueCheckLine" => ok(json!(dialogue_check_line(args.get(0)))),
        _ => None,
    }
}

#[test]
fn campaign_dialogues_match_js() {
    let fixture = Fixture::load_gz(include_bytes!("../fixtures/campaign-dialogues.json.gz"));
    assert!(fixture.cases.len() > 5_000, "эталон полон: {}", fixture.cases.len());
    run(&fixture, call);
}

#[test]
fn catalog_round_trips_like_js() {
    // Каталог после проверки — та же форма, что у `DIALOGUES` в JS: эталон
    // хранит его хешем в случае `normalizeDialogues` на настоящих данных.
    let first = &DIALOGUES[0];
    assert_eq!(first.id, "astohan-ares");
    assert!(first.options.iter().any(|option| option.id == "task"));
}

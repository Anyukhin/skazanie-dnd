//! Сверка костей и пауз `sk-rules` с эталоном JS (`fixtures/dice-pause.json`,
//! генератор — `fixtures/gen-dice-pause.mjs`): стенограмма `recordingDiceService`
//! (JSON побайтно, с порядком ключей места вызова), мягкий повтор
//! `replayDiceService` с подменой Несгибаемого, `rollIndomitableReplacement`,
//! `failedSavingThrowEvent`, события окон четырёх классов пауз, выборы
//! Сопротивления и реакций из контекста.

use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_core::js;
use sk_dice::{DiceService, SequenceRng};
use sk_rules::dice_record::{failed_saving_throw_event, roll_indomitable_replacement, Recording, Replay, RulesDice, ServiceDice};
use sk_rules::pause::{self, ElementalDamageArgs, Halt, Pause, ProtectiveReactionArgs, ResistanceChoiceArgs};

const FIXTURE: &str = include_str!("../fixtures/dice-pause.json");
static DATA: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(FIXTURE).expect("эталон — JSON"));

fn list(name: &str) -> &'static [Value] {
    DATA[name].as_array().map(Vec::as_slice).unwrap_or_else(|| panic!("нет раздела {name}"))
}

fn text(value: &Value) -> String {
    js::stringify(value)
}

fn sequence(values: &Value, prefix: &str) -> ServiceDice<DiceService<SequenceRng>> {
    let values: Vec<i64> = values.as_array().expect("значения").iter().map(|value| value.as_i64().expect("целое")).collect();
    ServiceDice::new(DiceService::deterministic(SequenceRng::new(values), prefix))
}

fn halt_name(halt: &Halt) -> String {
    match halt {
        Halt::Rule(_) => "RulesValidationError".into(),
        Halt::Fault(fault) => fault.name.clone(),
        Halt::Pause(pause) => pause.kind.name().into(),
    }
}

/// Итог вызова в форме эталона: `{ result }` или `{ error: { name, code } }`.
fn perform(dice: &mut dyn RulesDice, call: &Value) -> Value {
    let args = call["args"].as_array().expect("аргументы");
    let outcome = match call["method"].as_str().expect("метод") {
        "roll" => dice.roll(args),
        "rollD20" => dice.roll_d20(&args[0]),
        "rollCheck" => dice.roll_check(&args[0]),
        other => panic!("метод {other}"),
    };
    match outcome {
        Ok(result) => json!({ "result": result }),
        Err(halt) => json!({ "error": { "name": halt_name(&halt), "code": halt.code() } }),
    }
}

#[test]
fn recording_matches_js_transcript() {
    for case in list("recording") {
        let mut service = sequence(&case["values"], "roll");
        let mut recording = Recording::new(&mut service);
        let results: Vec<Value> = case["calls"].as_array().expect("вызовы").iter().map(|call| perform(&mut recording, call)).collect();
        assert_eq!(text(&Value::Array(results)), text(&case["results"]), "итоги бросков {case}");
        assert_eq!(text(&Value::Array(recording.transcript.clone())), text(&case["transcript"]), "стенограмма {case}");
    }
}

#[test]
fn replay_matches_js() {
    for case in list("replay") {
        let mut base = sequence(&case["base_values"], "base");
        let transcript = case["transcript"].as_array().cloned().unwrap_or_default();
        let replacements = case.get("replacements").filter(|value| !value.is_null());
        let mut replay = Replay::new(&mut base, transcript, replacements, case["allow"] == json!(true));
        let mut results = Vec::new();
        for call in case["calls"].as_array().expect("вызовы") {
            let outcome = perform(&mut replay, call);
            let failed = outcome.get("error").is_some();
            results.push(outcome);
            if failed {
                break;
            }
        }
        assert_eq!(text(&Value::Array(results)), text(&case["results"]), "повтор {}: {case}", case["label"]);
    }
}

#[test]
fn indomitable_replacement_matches_js() {
    for case in list("indomitable") {
        let mut base = sequence(&case["base_values"], "reroll");
        let transcript = case["transcript"].as_array().cloned().unwrap_or_default();
        let bonus = case.get("bonus").filter(|value| !value.is_null());
        match (roll_indomitable_replacement(&mut base, &transcript, case.get("roll_id"), bonus), case.get("error")) {
            (Ok(result), None) => assert_eq!(text(&result), text(&case["result"]), "rollIndomitableReplacement {case}"),
            (Err(halt), Some(error)) => {
                assert_eq!(json!(halt_name(&halt)), error["name"], "{case}");
                assert_eq!(json!(halt.code()), error["code"], "{case}");
            }
            (other, _) => panic!("rollIndomitableReplacement {case}: {other:?}"),
        }
    }
}

#[test]
fn failed_saving_throws_match_js() {
    for case in list("saving_events") {
        assert_eq!(json!(failed_saving_throw_event(&case["event"])), case["expected"], "failedSavingThrowEvent {case}");
    }
}

fn transcript_of(value: &Value) -> Vec<Value> {
    value.as_array().cloned().unwrap_or_default()
}

fn optional<'a>(args: &'a Value, key: &str) -> Option<&'a Value> {
    args.get(key).filter(|value| value.as_str() != Some("__undefined__"))
}

#[test]
fn pauses_match_js() {
    for case in list("pauses") {
        let args = &case["args"];
        let transcript = transcript_of(&args["diceTranscript"]);
        let pause = match case["kind"].as_str().expect("класс") {
            kind @ ("ResistanceChoicePause" | "ResistanceAfterRollPause") => {
                let resistance = ResistanceChoiceArgs {
                    command: &args["command"],
                    target_id: &args["targetId"],
                    condition: args.get("condition"),
                    save_key: &args["saveKey"],
                    dice_transcript: &transcript,
                    choices: args.get("choices"),
                    elemental_choices: args.get("elementalChoices"),
                    protective_choices: args.get("protectiveChoices"),
                    phase: args.get("phase").and_then(Value::as_str),
                };
                if kind == "ResistanceChoicePause" {
                    Pause::resistance_choice(&resistance)
                } else {
                    Pause::resistance_after_roll(&resistance, case.get("save").filter(|value| !value.is_null()), case.get("options").filter(|value| !value.is_null()))
                }
            }
            "ElementalDamageReactionPause" => Pause::elemental_damage_reaction(&ElementalDamageArgs {
                command: &args["command"],
                target_id: &args["targetId"],
                damage: optional(args, "damage"),
                damage_key: &args["damageKey"],
                action_options: &args["actionOptions"],
                dice_transcript: &transcript,
                choices: args.get("choices"),
                resistance_choices: args.get("resistanceChoices"),
                protective_choices: args.get("protectiveChoices"),
            }),
            "ProtectiveReactionPause" => Pause::protective_reaction(&ProtectiveReactionArgs {
                command: &args["command"],
                target_id: &args["targetId"],
                reactor_id: args.get("reactorId"),
                source_actor_id: args.get("sourceActorId"),
                trigger: &args["trigger"],
                kind: &args["kind"],
                decision_key: args.get("decisionKey"),
                action_options: &args["actionOptions"],
                trigger_roll: args.get("triggerRoll"),
                damage: args.get("damage"),
                dice_transcript: &transcript,
                choices: args.get("choices"),
                resistance_choices: args.get("resistanceChoices"),
                elemental_choices: args.get("elementalChoices"),
            }),
            other => panic!("класс {other}"),
        };
        assert_eq!(json!(pause.kind.name()), case["name"], "{case}");
        assert_eq!(json!(pause.message()), case["message"], "{case}");
        assert_eq!(text(&pause.command), text(&case["command"]), "команда паузы {case}");
        assert_eq!(text(&pause.window_event), text(&case["window_event"]), "окно паузы {}: {case}", case["kind"]);
    }
}

fn pairs(map: &sk_core::indexmap::IndexMap<String, Value>) -> Value {
    Value::Array(map.iter().map(|(key, value)| json!([key, value])).collect())
}

#[test]
fn choices_from_context_match_js() {
    for case in list("choice_modes") {
        let value = case.get("value").filter(|value| value.as_str() != Some("__undefined__"));
        assert_eq!(json!(pause::resistance_choice_mode(value)), case["expected"], "resistanceChoiceMode {case}");
    }
    for case in list("from_context") {
        let context = &case["context"];
        let resistance = pause::resistance_choices_from_context(context.get("resistanceChoices"));
        assert_eq!(text(&pairs(&resistance)), text(&case["resistance"]), "resistanceChoicesFromContext {case}");
        assert_eq!(text(&pause::resistance_choices_object(&resistance)), text(&case["resistance_object"]), "resistanceChoicesObject {case}");
        let elemental = sk_rules::resolve::reaction_choices(context.get("elementalDamageChoices"), "damage_key");
        assert_eq!(text(&pairs(&elemental)), text(&case["elemental"]), "elementalReactionChoices {case}");
        let protective = sk_rules::resolve::reaction_choices(context.get("protectiveReactionChoices"), "key");
        assert_eq!(text(&pairs(&protective)), text(&case["protective"]), "protectiveReactionChoices {case}");
    }
    for case in list("resistance_conditions") {
        let found = pause::resistance_condition_for(&case["state"], case["id"].as_str().expect("id")).cloned().unwrap_or(Value::Null);
        assert_eq!(found, case["expected"], "resistanceConditionFor {case}");
    }
    for case in list("pending_execution") {
        let context = sk_rules::context::Context::from_json(&case["context"]);
        assert_eq!(text(&pause::pending_execution_for(&context)), text(&case["expected"]), "pendingExecutionFor {case}");
    }
}

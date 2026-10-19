//! Каркас движка (задача Р0): проход проверки до первой заглушки, отказы
//! общих блоков, точка входа разбора, заглушки редьюсера и нормализации.
//! Тест закрепляет проводку, а не правила: перенося блок или ветку, задача
//! меняет только свой файл, и этот тест продолжает проходить.

use serde_json::{json, Value};
use sk_dice::{DiceService, SequenceRng};
use sk_rules::context::{sequence_uuids, Context};
use sk_rules::dice_record::ServiceDice;
use sk_rules::normalize::{assume_normalized, normalize_campaign_state};
use sk_rules::pause::Halt;
use sk_rules::validate::{validate_command, validate_normalized, BLOCKS};

fn state() -> Value {
    json!({
        "state_version": 4,
        "ruleset_id": "srd_5_2_1",
        "players": [{ "id": "hero", "hp": 10 }],
        "enemies": [], "actors": [],
        "mechanics": { "combat": { "active": false, "round": 0, "initiative": [], "active_index": -1, "action_economy": {} }, "campaign_lifecycle": { "status": "active" }, "death": { "heroes": {} } },
    })
}

fn code(result: Result<Value, Halt>) -> String {
    result.err().and_then(|halt| halt.code().map(str::to_string)).unwrap_or_else(|| "ok".into())
}

#[test]
fn normalization_is_ported_and_assumption_stays_identity() {
    let normalized = normalize_campaign_state(&state()).expect("нормализация перенесена (Р4б)");
    assert_eq!(normalized["engine_mode"], json!("enforce"));
    assert_eq!(normalized["state_version"], json!(4));
    assert_eq!(normalized["players"][0]["maxHp"], json!(1));
    assert_eq!(assume_normalized(|| normalize_campaign_state(&state()).expect("тождественно")), state());
}

#[test]
fn common_blocks_refuse_before_any_stub() {
    let context = Context::default();
    let mut uuid = sequence_uuids("u");
    assert_eq!(code(validate_normalized(&json!({ "command_type": "Teleport", "expected_state_version": 4 }), &state(), &context, &mut uuid)), "COMMAND_NOT_ALLOWED");
    assert_eq!(code(validate_normalized(&json!({ "command_type": "DeclareAction", "actor_id": "hero", "expected_state_version": 3 }), &state(), &context, &mut uuid)), "STATE_VERSION_CONFLICT");
    let first_stub = BLOCKS.iter().find(|block| block.index == 8).expect("блок 8");
    let result = validate_normalized(&json!({ "command_type": "DeclareAction", "actor_id": "hero", "expected_state_version": 4 }), &state(), &context, &mut uuid);
    match result {
        Err(Halt::Rule(error)) => assert_eq!((error.code.as_str(), error.message.as_str()), ("UNPORTED", format!("validate:{}", first_stub.name).as_str())),
        other => panic!("ожидалась заглушка блока 8: {other:?}"),
    }
    assert!(validate_command(&json!({ "command_type": "DeclareAction" }), &state(), &context, &mut uuid).unwrap_err().is_unported(), "блок проверки — заглушка");
}

#[test]
fn resolve_entry_runs_preparation_then_validation() {
    let mut dice = ServiceDice::new(DiceService::deterministic(SequenceRng::new(vec![10, 10]), "roll"));
    let mut uuid = sequence_uuids("u");
    let input = json!({ "command_type": "Teleport", "expected_state_version": 4 });
    let refused = assume_normalized(|| sk_rules::resolve::resolve_command_internal(&input, &state(), &mut dice, &Context::default(), &mut uuid));
    assert_eq!(refused.err().and_then(|halt| halt.code().map(str::to_string)).as_deref(), Some("COMMAND_NOT_ALLOWED"));
}

#[test]
fn reducer_branch_refusal_keeps_common_steps() {
    // Все ветки `switch` перенесены (последними — торговцы, Р6): пустой
    // payload `MerchantCreated` отвергает нормализатор торговца, а общие шаги
    // редьюсера идут, как и прежде шли для заглушки.
    let mut state = state();
    let event: sk_core::Event = serde_json::from_value(json!({ "event_type": "MerchantCreated", "payload": {}, "command_id": "c" })).expect("событие");
    let result = sk_rules::reduce::apply_event_checked(&mut state, &event);
    assert_eq!(result.unwrap_err().code, "INVALID_MERCHANT_ID");
    assert_eq!(state["state_version"], 5, "общие шаги идут и после отказа ветки");
    assert!(sk_rules::reduce::is_ported("MerchantCreated"));
    assert!(sk_rules::reduce::is_ported("DamageApplied"));
    assert!(sk_rules::reduce::is_ported("DieRolled"), "у события без ветки JS — только общие шаги");
    assert!(sk_rules::reduce::is_ported("MerchantEconomyClockAdvanced"));
    assert!(!sk_rules::reduce::is_ported("LegacyStateImported"));
}

//! Перенос проверок самого модуля из `test/world-offices.test.mjs` и
//! `test/world-offices-knowledge.test.mjs`: конфигурация, освобождение,
//! преемство, редьюсер, проекция и граница осведомлённости.

use serde_json::{json, Value};
use sk_world_life::world_offices::*;

const KING: &str = "npc:king";
const MARSHAL: &str = "npc:marshal";

fn office() -> Value {
    json!({
        "id": "office:crown", "title": "Корона Валедора", "faction_id": "faction:crown", "holder_npc_id": KING, "visibility": "party",
        "successor": { "npc_id": MARSHAL, "delay_minutes": 1_440, "required_tags": ["marshal"] },
        "defender_npc_ids": ["npc:guard-1"],
    })
}

fn campaign(marshal_tags: Value) -> Value {
    json!({
        "mechanics": { "world_time": { "elapsed_minutes": 0 } },
        "world_offices": normalize_world_offices_state(Some(&json!({ "offices": [office()] })), &json!({})),
        "social": { "npcs": [
            { "id": KING, "name": "Король Арес", "role": "правитель", "location": "Штормберг", "visibility": "party", "available": true, "tags": ["faction:faction:crown", "king"] },
            { "id": MARSHAL, "name": "Маршал Ивара", "role": "маршал", "location": "Штормберг", "visibility": "party", "available": true, "tags": marshal_tags },
        ] },
        "npc_world": { "vitals": { KING: { "hp": 10, "max_hp": 10, "alive": true }, MARSHAL: { "hp": 10, "max_hp": 10, "alive": true } } },
    })
}

fn death() -> Value {
    json!({ "event_type": "NpcDied", "event_id": "event:king-died", "payload": { "npc_id": KING } })
}

fn with_id(draft: &Value, id: &str) -> Value {
    let mut event = draft.clone();
    event["event_id"] = json!(id);
    event
}

#[test]
fn configuration_is_bounded_and_typed() {
    assert_eq!(normalize_world_offices_state(None, &json!({})), json!({ "schema_version": 1, "offices": [] }));
    let normalized = normalize_world_offices_state(Some(&json!({ "offices": [office()] })), &json!({}));
    let first = &normalized["offices"][0];
    assert_eq!(first["status"], "held");
    assert_eq!(first["pending"], Value::Null);
    assert_eq!(first["defender_npc_ids"], json!(["npc:guard-1"]));
    let error = validate_office_configuration(Some(&json!({ "id": "office:x", "title": "X", "faction_id": "f", "extra": 1 })), &json!({})).unwrap_err();
    assert_eq!(error.code, "WORLD_OFFICE_UNKNOWN_FIELD");
    assert_eq!(error.message, "office содержит запрещённые поля: extra");
    let mut same = office();
    same["successor"]["npc_id"] = json!(KING);
    assert_eq!(validate_office_configuration(Some(&same), &json!({})).unwrap_err().code, "WORLD_OFFICE_SUCCESSOR_INVALID");
    let mut late = office();
    late["successor"]["delay_minutes"] = json!(0);
    assert_eq!(validate_office_configuration(Some(&late), &json!({})).unwrap_err().message, "office.successor.delay_minutes должен быть от 1 до 525600");
    assert_eq!(validate_office_configuration(Some(&office()), &json!({ "knownNpcIds": [KING] })).unwrap_err().code, "WORLD_OFFICE_REFERENCE_NOT_FOUND");
}

#[test]
fn only_death_of_current_holder_vacates_once() {
    let state = campaign(json!(["faction:faction:crown", "marshal"]));
    let other = json!({ "event_type": "NpcDied", "event_id": "event:other", "payload": { "npc_id": "npc:guard-1" } });
    assert!(plan_office_vacancy_drafts(&state, &[other], &json!({})).is_empty());
    let drafts = plan_office_vacancy_drafts(&state, &[death(), death()], &json!({ "worldMinute": 300 }));
    assert_eq!(drafts.len(), 1);
    let payload = &drafts[0]["payload"];
    assert_eq!(payload["due_at_minutes"], 1_740);
    assert_eq!(payload["previous_holder_npc_id"], KING);
    assert_eq!(drafts[0]["visibility"], "party");
    let vacant = apply_world_office_event(state.get("world_offices"), &with_id(&drafts[0], "event:vacated"), &json!({}));
    assert_eq!(vacant["offices"][0]["status"], "vacant");
    assert_eq!(vacant["offices"][0]["pending"]["candidate_npc_id"], MARSHAL);
    // Повтор того же события ничего не меняет.
    assert_eq!(apply_world_office_event(Some(&vacant), &with_id(&drafts[0], "event:vacated"), &json!({})), vacant);
    let mut after = state.clone();
    after["world_offices"] = vacant;
    assert!(plan_office_vacancy_drafts(&after, &[death()], &json!({})).is_empty());
}

#[test]
fn succession_waits_and_installs_eligible_candidate_once() {
    let state = campaign(json!(["faction:faction:crown", "marshal"]));
    let drafts = plan_office_vacancy_drafts(&state, &[death()], &json!({ "worldMinute": 300 }));
    let vacant = apply_world_office_event(state.get("world_offices"), &with_id(&drafts[0], "event:vacated"), &json!({}));
    let mut after = state.clone();
    after["world_offices"] = vacant.clone();
    assert!(plan_office_succession_drafts(&after, &json!({ "worldMinute": 1_739 })).is_empty());
    let due = plan_office_succession_drafts(&after, &json!({ "worldMinute": 1_740 }));
    assert_eq!(due.len(), 1);
    assert_eq!(due[0]["event_type"], "OfficeHolderInstalled");
    let installed = apply_world_office_event(Some(&vacant), &with_id(&due[0], "event:installed"), &json!({}));
    assert_eq!(installed["offices"][0]["holder_npc_id"], MARSHAL);
    assert_eq!(installed["offices"][0]["succession_history"][0]["outcome"], "installed");
    after["world_offices"] = installed;
    assert!(plan_office_succession_drafts(&after, &json!({ "worldMinute": 99_999 })).is_empty());
}

#[test]
fn ineligible_candidate_is_skipped_privately() {
    let state = campaign(json!(["faction:faction:crown"]));
    let drafts = plan_office_vacancy_drafts(&state, &[death()], &json!({}));
    let vacant = apply_world_office_event(state.get("world_offices"), &with_id(&drafts[0], "event:vacated"), &json!({}));
    let mut after = state.clone();
    after["world_offices"] = vacant.clone();
    let skipped = plan_office_succession_drafts(&after, &json!({ "worldMinute": 2_000 }));
    assert_eq!(skipped[0]["event_type"], "OfficeSuccessionSkipped");
    assert_eq!(skipped[0]["payload"]["reason"], "candidate_missing_tag");
    assert_eq!(skipped[0]["visibility"], "gm_only");
    assert_eq!(office_chronicle_entry(&skipped[0], &json!({})), None, "закрытая причина не уходит столу");
    let applied = apply_world_office_event(Some(&vacant), &with_id(&skipped[0], "event:skipped"), &json!({}));
    assert_eq!(applied["offices"][0]["status"], "vacant");
    assert_eq!(applied["offices"][0]["pending"], Value::Null);
    let projected = offices_for_viewer(Some(&json!({ "world_offices": applied })), &json!({ "playerId": "hero" }));
    assert_eq!(projected, vec![json!({ "office_id": "office:crown", "title": "Корона Валедора", "status": "vacant", "holder_npc_id": null })]);
}

#[test]
fn hidden_death_keeps_previous_status_until_revealed() {
    let mut state = campaign(json!(["faction:faction:crown", "marshal"]));
    state["worldMemory"] = json!({ "facts": [], "knowledge_ledger": [] });
    let mut secret = death();
    secret["visibility"] = json!("gm_only");
    secret["payload"]["knowledge_gate"] = json!({ "visibility": "gm_only", "source_event_ids": ["event:king-died"] });
    let draft = plan_office_vacancy_drafts(&state, &[secret], &json!({}))[0].clone();
    assert!(draft["payload"]["knowledge_gate"].is_object());
    let vacant = apply_world_office_event(state.get("world_offices"), &with_id(&draft, "office:hidden-vacated"), &json!({}));
    let mut after = state.clone();
    after["world_offices"] = vacant;
    let player = offices_for_viewer(Some(&after), &json!({ "playerId": "hero" }));
    assert_eq!(player[0]["status"], "held");
    assert_eq!(player[0]["holder_npc_id"], KING);
    // Ведущему статус настоящий и держатель из записи (у вакантной — `null`);
    // прежде держатель ведущему не приходил вовсе.
    let gm = offices_for_viewer(Some(&after), &json!({ "isAdmin": true }));
    assert_eq!(gm[0], json!({ "office_id": "office:crown", "title": "Корона Валедора", "status": "vacant", "holder_npc_id": null }));
    let installed = offices_for_viewer(Some(&state), &json!({ "isAdmin": true }));
    assert_eq!(installed[0]["holder_npc_id"], KING, "ведущий видит держателя занятой должности");
}

#[test]
fn chronicle_is_short_and_old_v1_events_replay() {
    let state = campaign(json!(["faction:faction:crown", "marshal"]));
    let mut draft = plan_office_vacancy_drafts(&state, &[death()], &json!({}))[0].clone();
    let entry = office_chronicle_entry(&with_id(&draft, "event:v"), &json!({})).expect("строка");
    assert_eq!(entry["text"], "Должность «Корона Валедора» остаётся вакантной.");
    assert_eq!(entry["id"], "office:OfficeVacated:event:v");
    draft["payload"]["schema_version"] = json!(1);
    let vacant = apply_world_office_event(state.get("world_offices"), &draft, &json!({}));
    assert_eq!(vacant["offices"][0]["status"], "vacant");
    draft["payload"]["schema_version"] = json!(3);
    assert_eq!(apply_world_office_event(state.get("world_offices"), &draft, &json!({}))["offices"][0]["status"], "held");
}

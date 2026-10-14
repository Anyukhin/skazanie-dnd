//! Сверка `party_decision` с эталоном `server/party-decision.mjs`
//! (`fixtures/gen-party-decision.mjs`): нормализация на мусоре, голосования
//! целиком на состояниях настоящего редьюсера, исполнение решений по
//! поручению; и проверки `test/party-decision.test.mjs`.

mod common;

use common::{Args, Fixture, Outcome};
use serde_json::{json, Value};
use sk_memory::party_decision::*;

fn dispatch(name: &str, args: &Args) -> Outcome {
    match name {
        "normalizePartyDecisionPolicy" => Outcome::of(normalize_party_decision_policy(args.opt(0))),
        "normalizePartyDecision" => Outcome::result(normalize_party_decision(args.val(0), args.opt(1))),
        "partyDecisionActiveVoterIds" => Outcome::result(party_decision_active_voter_ids(args.val(0), args.opt(1))),
        "partyDecisionOpenedEvent" => Outcome::result(party_decision_opened_event(args.val(0), args.opt(1), &args.obj(2))),
        "resolvePartyVote" => Outcome::result(resolve_party_vote(args.val(0), &args.obj(1))),
        "resolvePartyAbstain" => Outcome::result(resolve_party_abstain(args.val(0), &args.obj(1))),
        "resolvePartyRoll" => Outcome::result(resolve_party_roll(args.val(0), &args.obj(1))),
        "partyDecisionPresenceEvents" => Outcome::result(party_decision_presence_events(args.val(0), &args.obj(1))),
        "partyDecisionExpiryEvents" => Outcome::result(party_decision_expiry_events(args.val(0), Some(sk_core::js::number(args.opt(1))))),
        "questDecisionEvents" => Outcome::result(quest_decision_events(args.val(0), args.val(1), args.val(2))),
        _ => Outcome::Unknown,
    }
}

fn fixture() -> Fixture {
    Fixture::load(include_str!("../fixtures/party-decision.json"))
}

#[test]
fn party_decisions_match_js() {
    let total = fixture().check(dispatch);
    assert!(total > 2_500, "эталон подозрительно мал: {total}");
}

#[test]
fn constants_match_js() {
    let fixture = fixture();
    assert_eq!(fixture.root["constants"]["PARTY_DECISION_POLICY_VERSION"], PARTY_DECISION_POLICY_VERSION);
    assert_eq!(serde_json::to_string(&fixture.root["constants"]["DEFAULT_PARTY_DECISION_POLICY"]).ok(), serde_json::to_string(&*DEFAULT_PARTY_DECISION_POLICY).ok());
}

fn base_state() -> Value {
    json!({
        "partyMemberIds": ["a", "b", "c", "d"],
        "players": [{ "id": "a" }, { "id": "b" }, { "id": "c" }, { "id": "d" }],
        "agentInteraction": {
            "id": "decision-1", "type": "vote", "title": "Куда идти?", "description": "",
            "options": [{ "id": "north", "label": "На север" }, { "id": "south", "label": "На юг" }],
            "votes": { "a": "north", "b": "north" }, "status": "open", "resolutionPrompt": "", "createdAt": 1,
        },
    })
}

#[test]
fn open_event_strips_forged_votes_and_resolution() {
    let mut interaction = base_state()["agentInteraction"].clone();
    interaction["destinationLocationId"] = json!("форт:Север");
    interaction["votes"] = json!({ "a": "north" });
    interaction["status"] = json!("resolved");
    interaction["resolvedOptionId"] = json!("north");
    let event = party_decision_opened_event(&interaction, Some(&json!("a")), &json!({})).expect("событие открытия");
    assert_eq!(event["event_type"], "PartyDecisionOpened");
    assert_eq!(event["payload"]["interaction"]["votes"], json!({}));
    assert_eq!(event["payload"]["interaction"]["status"], "open");
    assert_eq!(event["payload"]["interaction"]["destinationLocationId"], "форт:Север");
}

#[test]
fn third_eligible_vote_emits_vote_and_majority_resolution() {
    let result = resolve_party_vote(&base_state(), &json!({ "interactionId": "decision-1", "heroId": "c", "optionId": "north", "eligibleHeroIds": ["a", "b", "c", "d"] })).expect("голос");
    let types: Vec<&str> = result["events"].as_array().into_iter().flatten().filter_map(|event| event["event_type"].as_str()).collect();
    assert_eq!(types, ["PartyVoteCast", "PartyDecisionResolved"]);
    assert_eq!(result["events"][1]["payload"]["resolved_option_id"], "north");
    assert_eq!(result["required"], 3);
}

#[test]
fn ineligible_and_unknown_votes_are_rejected() {
    let outsider = resolve_party_vote(&base_state(), &json!({ "interactionId": "decision-1", "heroId": "outsider", "optionId": "north", "eligibleHeroIds": ["a", "b", "c", "d"] }));
    assert_eq!(outsider.expect_err("чужой герой").code, "ACTOR_FORBIDDEN");
    let unknown = resolve_party_vote(&base_state(), &json!({ "interactionId": "decision-1", "heroId": "c", "optionId": "void", "eligibleHeroIds": ["a", "b", "c", "d"] }));
    assert_eq!(unknown.expect_err("нет варианта").code, "PARTY_OPTION_NOT_FOUND");
}

#[test]
fn party_roll_resolves_from_one_server_d20() {
    let mut state = base_state();
    state["agentInteraction"]["type"] = json!("roll");
    state["agentInteraction"]["difficulty"] = json!(14);
    state["agentInteraction"]["eligibleActorIds"] = json!(["a", "b"]);
    state["agentInteraction"]["options"] = json!([{ "id": "success", "label": "Success" }, { "id": "failure", "label": "Failure" }]);
    let result = resolve_party_roll(&state, &json!({ "interactionId": "decision-1", "heroId": "a", "roll": { "roll_id": "roll-1", "dice": [15], "total": 15, "created_at": "2026-07-24T00:00:00.000Z" } })).expect("бросок");
    assert_eq!(result["events"][0]["event_type"], "DieRolled");
    assert_eq!(result["events"][1]["event_type"], "PartyDecisionResolved");
    assert_eq!(result["resolvedOptionId"], "success");
    assert_eq!(result["events"][1]["payload"]["roll"]["value"], 15);
    assert_eq!(result["roll"]["rolledAt"], 1_784_851_200_000_i64);
}

/// Состояние после `PartyDecisionOpened` трёх героев с аккаунтами — как его
/// оставил бы редьюсер (`agentInteraction` = нормализованное решение).
fn continuity_state(voters: Value, voter_by_hero: Value) -> Value {
    let opened = party_decision_opened_event(
        &json!({ "id": "decision-continuity", "type": "vote", "title": "Куда идти?", "description": "",
            "options": [{ "id": "north", "label": "На север" }, { "id": "south", "label": "На юг" }], "votes": {}, "status": "open", "resolutionPrompt": "", "createdAt": 100 }),
        None,
        &json!({ "eligibleHeroIds": ["a", "b", "c"], "eligibleVoterIds": voters, "voterByHeroId": voter_by_hero, "policy": { "decisionTtlMs": 10_000 } }),
    )
    .expect("событие открытия");
    json!({ "partyMemberIds": ["a", "b", "c"], "players": [{ "id": "a", "character": "А" }, { "id": "b", "character": "Б" }, { "id": "c", "character": "В" }], "agentInteraction": opened["payload"]["interaction"] })
}

#[test]
fn disconnect_lowers_quorum_and_expiry_picks_plurality() {
    let state = continuity_state(json!(["account:a", "account:b", "account:c"]), json!({ "a": "account:a", "b": "account:b", "c": "account:c" }));
    let presence = party_decision_presence_events(&state, &json!({ "activeVoterIds": ["account:b", "account:c"] })).expect("уход");
    assert_eq!(presence["events"].as_array().map(Vec::len), Some(1));
    assert_eq!(presence["events"][0]["event_type"], "PartyDecisionAbstained");
    assert_eq!(presence["activeVoterIds"], json!(["account:b", "account:c"]));
    assert_eq!(presence["abstainedVoterIds"], json!(["account:a"]));
    assert_eq!(presence["events"][0]["payload"]["required_votes"], 2);
    let expired = party_decision_expiry_events(&state, Some(10_101.0)).expect("срок");
    assert_eq!(expired["events"][0]["event_type"], "PartyDecisionExpired");
    assert_eq!(expired["events"][0]["payload"]["resolved_option_id"], "north");
    assert_eq!(party_decision_expiry_events(&state, Some(10_099.0)).expect("срок")["events"], json!([]));
}

#[test]
fn one_account_does_not_vote_twice_for_two_heroes() {
    let mut state = continuity_state(json!(["account:owner", "account:guest"]), json!({ "a": "account:owner", "b": "account:owner", "c": "account:guest" }));
    let first = resolve_party_vote(&state, &json!({ "interactionId": "decision-continuity", "heroId": "a", "optionId": "north" })).expect("голос");
    state["agentInteraction"]["votes"] = first["votes"].clone();
    let replacement = resolve_party_vote(&state, &json!({ "interactionId": "decision-continuity", "heroId": "b", "optionId": "south" })).expect("замена");
    assert_eq!(replacement["votes"], json!({ "b": "south" }));
    assert_eq!(replacement["resolvedOptionId"], Value::Null);
    assert_eq!(replacement["events"][0]["payload"]["replaced_hero_id"], "a");
}

#[test]
fn quest_decision_requires_the_server_and_a_resolved_decision() {
    let state = json!({ "agentInteraction": { "id": "d", "status": "resolved", "resolvedOptionId": "abandon", "questAbandonment": { "schemaVersion": 1, "questId": "quest:second" } },
        "worldMemory": { "quests": [{ "id": "quest:second", "title": "Найти печать", "status": "active", "visibility": "party" }] } });
    let forbidden = quest_decision_events(&json!({ "interaction_id": "d" }), &state, &json!({ "isAdmin": true })).expect_err("только сервер");
    assert_eq!(forbidden.code(), "QUEST_DECISION_FORBIDDEN");
    let stale = quest_decision_events(&json!({ "interaction_id": "other" }), &state, &json!({ "isDirector": true })).expect_err("другое решение");
    assert_eq!(stale.code(), "PARTY_DECISION_REQUIRED");
    let events = quest_decision_events(&json!({ "interaction_id": "d", "command_id": "c" }), &state, &json!({ "isDirector": true })).expect("отказ от поручения");
    let types: Vec<&str> = events.iter().filter_map(|event| event["event_type"].as_str()).collect();
    assert_eq!(types, ["QuestResolved", "PartyDecisionConsumed"]);
    assert_eq!(events[0]["payload"]["status"], "abandoned");
    assert_eq!(events[0]["payload"]["stay_in_location"], true);
}

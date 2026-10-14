//! Проверки модуля из `test/npc-social.test.mjs`, `test/underworld.test.mjs`,
//! `test/reputation-consequences.test.mjs` и `test/authored-world-npcs.test.mjs`:
//! вид проверки, СЛ политики, подкуп, слава фракций и исход проверки на
//! детерминированных костях `sk_dice`.

use serde_json::{json, Value};
use sk_dice::{D20Request, Dice, DiceService, SequenceRng, Visibility};
use sk_social::npc_social_check::*;
use sk_society::underworld::{npc_is_fence, INCORRUPTIBLE_DC_PENALTY, INCORRUPTIBLE_TAG};

fn campaign() -> Value {
    json!({
        "sessionCode": "NPC-SOCIAL",
        "partyMemberIds": ["hero", "rogue"],
        "scene": { "title": "Market", "location": "Market Square" },
        "mechanics": { "world_time": { "elapsed_minutes": 0 }, "combat": { "active": false } },
        "merchants": [{ "id": "marta", "name": "Marta", "location": "Market Square", "available": true }],
        "social": {
            "npcs": [{ "id": "marta", "name": "Marta", "role": "merchant", "location": "Market Square", "visibility": "party", "available": true }],
            "relationships": { "marta": { "hero": 3, "rogue": -4 } },
            "conversations": [],
            "promises": [],
        },
    })
}

fn policy(state: &Value, npc_id: &str, message: &str, extra: Value) -> Option<Value> {
    let mut params = json!({ "state": state, "npcId": npc_id, "heroId": "hero", "message": message, "turnId": "t1" });
    if let (Some(target), Some(patch)) = (params.as_object_mut(), extra.as_object()) {
        for (key, value) in patch {
            target.insert(key.clone(), value.clone());
        }
    }
    build_npc_social_check_policy(&params)
}

fn classify(message: &str) -> Option<&'static str> {
    classify_npc_social_check(&json!(message))
}

#[test]
fn classifier_reads_the_skill_and_ignores_negations_and_quotes() {
    assert_eq!(classify("убеждаю Марту помочь."), Some("persuasion"));
    assert_eq!(classify("обманываю Марту."), Some("deception"));
    assert_eq!(classify("угрожаю Марте."), Some("intimidation"));
    assert_eq!(classify("проницательно изучаю её мотивы."), Some("insight"));
    assert_eq!(classify("I persuade Marta to open the gate."), Some("persuasion"));
    assert_eq!(classify("I lie to Marta about the seal."), Some("deception"));
    assert_eq!(classify("I threaten Marta."), Some("intimidation"));
    assert_eq!(classify("I use insight to read Marta's motives."), Some("insight"));
    assert_eq!(classify("I ask Marta about the weather."), None);
    assert_eq!(classify("Я не угрожаю и не требую, а спокойно объясняю."), None);
    assert_eq!(classify("Я не обманываю Марту."), None);
    assert_eq!(classify("Я цитирую фразу «я угрожаю страже»."), None);
    assert_eq!(classify("Я не хочу его запугивать."), None);
    assert_eq!(classify("Не только угрожаю, но и предлагаю сделку."), Some("intimidation"));
    assert_eq!(classify("Угрожаю: «сейчас уйдите»."), Some("intimidation"));
    assert_eq!(classify("Флиртую с трактирщицей"), Some("persuasion"), "флирт судит Убеждение");
}

#[test]
fn policy_chooses_server_owned_skill_ability_and_dc() {
    let checked = policy(&campaign(), "marta", "I persuade Marta to help.", json!({ "turnId": "turn-policy" })).expect("проверка");
    assert_eq!(checked["skill"], "persuasion");
    assert_eq!(checked["ability"], "cha");
    assert_eq!(checked["difficulty"], 12);
    assert_eq!(checked["visibility"], "specific_player");
    assert!(checked["check_id"].as_str().unwrap_or("").starts_with("social-check:"));
    let insight = build_npc_social_check_policy(&json!({ "state": campaign(), "npcId": "marta", "heroId": "hero", "message": "I use insight to read Marta's motives." })).expect("взгляд");
    assert_eq!(insight["ability"], "wis");
    assert_eq!(insight["difficulty"], 15, "проницательность на 3 сложнее");
    assert!(policy(&campaign(), "ghost", "I persuade Marta.", json!({})).is_none(), "неизвестный NPC — не проверка");
    assert!(policy(&campaign(), "marta", "Добрый день", json!({})).is_none());
}

#[test]
fn bribe_tiers_are_read_from_the_phrase() {
    let tiers: Vec<&str> = ["монету", "кошель", "щедро"].iter().map(|word| classify_bribe_tier(&json!(format!("Убеждаю и подкрепляю слова: {word}")))).collect();
    assert_eq!(tiers, ["coin", "purse", "generous"]);
    assert_eq!(classify_bribe_tier(&json!("просто уговариваю")), "");
}

fn honest_session() -> String {
    (0..200).map(|attempt| format!("UNDER-{attempt}")).find(|code| !npc_is_fence(&json!({ "sessionCode": code, "worldMap": { "currentLocationId": "market" } }), &json!({ "id": "merchant-1" }))).expect("честная кампания")
}

fn market(incorruptible: bool) -> Value {
    json!({
        "sessionCode": honest_session(),
        "partyMemberIds": ["hero"],
        "worldMap": { "currentLocationId": "market" },
        "social": { "npcs": [{ "id": "merchant-1", "name": "Горазд", "role": "купец", "location": "Рынок", "available": true, "visibility": "party", "tags": if incorruptible { vec![INCORRUPTIBLE_TAG] } else { Vec::new() } }] },
        "merchants": [{ "id": "merchant-1", "name": "Горазд", "location": "Рынок", "available": true }],
    })
}

#[test]
fn coin_eases_persuasion_but_backfires_on_the_incorruptible() {
    let base = policy(&market(false), "merchant-1", "Убеждаю его помочь", json!({})).expect("проверка");
    let bribed = policy(&market(false), "merchant-1", "Убеждаю и подкрепляю слова: кошель", json!({ "bribeReferenceCp": 10_000 })).expect("подкуп");
    assert_eq!(bribed["difficulty"].as_i64(), base["difficulty"].as_i64().map(|dc| dc - 2), "кошель сдвигает СЛ на две ступени");
    assert_eq!(bribed["bribe"]["insulted"], false);
    assert!(bribed["bribe"]["amount_cp"].as_i64().unwrap_or(0) > 0);
    let insulted = policy(&market(true), "merchant-1", "Убеждаю и подкрепляю слова: кошель", json!({ "bribeReferenceCp": 10_000 })).expect("оскорбление");
    assert_eq!(insulted["difficulty"].as_i64(), base["difficulty"].as_i64().map(|dc| dc + INCORRUPTIBLE_DC_PENALTY));
    assert_eq!(insulted["bribe"]["insulted"], true);
    let threat = policy(&market(false), "merchant-1", "Запугиваю его и сую монету", json!({ "bribeReferenceCp": 10_000 })).expect("угроза");
    assert!(threat.get("bribe").is_none(), "деньгами подкрепляют только уговор");
    let tiered = policy(&market(false), "merchant-1", "Убеждаю его", json!({ "bribeTierId": "generous", "bribeReferenceCp": 10_000 })).expect("ступень из меню");
    assert_eq!(tiered["bribe"]["tier_id"], "generous");
}

fn guild_world(reputation: Option<i64>) -> Value {
    json!({
        "autonomy": { "reputations": reputation.map_or(json!({}), |score| json!({ "guild": score })) },
        "social": { "npcs": [{ "id": "merchant-1", "name": "Марта", "location": "Рынок", "available": true, "tags": ["faction:guild"] }] },
    })
}

#[test]
fn party_fame_moves_the_dc_without_making_it_impossible() {
    let message = "Убеждаю её рассказать про караван";
    let neutral = policy(&guild_world(None), "merchant-1", message, json!({})).expect("нейтрально");
    let hated = policy(&guild_world(Some(-80)), "merchant-1", message, json!({})).expect("враг");
    let honoured = policy(&guild_world(Some(80)), "merchant-1", message, json!({})).expect("друг");
    assert_eq!(neutral["reputation_tier"], "unknown");
    assert_eq!(hated["reputation_tier"], "reviled");
    let dc = |policy: &Value| policy["difficulty"].as_i64().unwrap_or(0);
    assert!(dc(&hated) > dc(&neutral) && dc(&honoured) < dc(&neutral));
    assert!(dc(&hated) <= 25, "СЛ остаётся в границах политики");
}

#[test]
fn authored_social_dc_is_respected_and_not_moved_by_fame() {
    let mut state = guild_world(Some(-80));
    state["social"]["npcs"][0]["social_dcs"] = json!({ "persuasion": 21 });
    let authored = policy(&state, "merchant-1", "Убеждаю Марту помочь", json!({})).expect("проверка");
    assert_eq!(authored["difficulty"], 21);
    state["social"]["npcs"][0]["social_dcs"] = json!({ "persuasion": 40 });
    assert_eq!(policy(&state, "merchant-1", "Убеждаю Марту помочь", json!({})).expect("проверка")["difficulty"], 25, "ручная СЛ в границах 5–25");
}

fn resolved_event(policy: &Value, die: i64, modifier: i64) -> Value {
    let mut dice = DiceService::deterministic(SequenceRng::new([die]), "roll");
    let request = D20Request::new("ability_check:cha", modifier).actor("hero").visibility(Visibility::SpecificPlayer);
    let roll = dice.roll_check(&request, policy["difficulty"].as_i64().unwrap_or(10)).expect("бросок");
    json!({
        "event_type": "AbilityCheckResolved",
        "payload": {
            "ability": policy["ability"], "skill": policy["skill"], "roll_id": roll.roll_id, "modifier": roll.modifier, "total": roll.total,
            "difficulty": roll.difficulty, "success": roll.success,
            "social_check": { "check_id": policy["check_id"], "npc_id": policy["npc_id"], "skill": policy["skill"], "request_fingerprint": policy["request_fingerprint"] },
        },
    })
}

#[test]
fn outcome_degree_follows_the_server_roll() {
    let checked = policy(&campaign(), "marta", "I persuade Marta to help.", json!({ "turnId": "turn-check" })).expect("проверка");
    let success = npc_social_check_outcome(&resolved_event(&checked, 10, 4)).expect("исход");
    assert_eq!((success["total"].clone(), success["success"].clone(), success["degree"].clone()), (json!(14), json!(true), json!("success")));
    assert_eq!(npc_social_check_outcome(&resolved_event(&checked, 18, 4)).expect("исход")["degree"], "strong_success");
    assert_eq!(npc_social_check_outcome(&resolved_event(&checked, 5, 4)).expect("исход")["degree"], "failure");
    assert_eq!(npc_social_check_outcome(&resolved_event(&checked, 1, -9)).expect("исход")["degree"], "severe_failure");
    assert!(npc_social_check_outcome(&json!({ "event_type": "AbilityCheckResolved", "payload": { "total": 20 } })).is_none(), "не социальная проверка");
}

#[test]
fn idempotency_key_bound_to_another_check_is_a_conflict() {
    let first = policy(&campaign(), "marta", "I persuade Marta to help.", json!({})).expect("проверка");
    let event = resolved_event(&first, 12, 4);
    assert!(assert_npc_social_check_fingerprint(&event, &first).is_ok());
    let other = policy(&campaign(), "marta", "I threaten Marta.", json!({})).expect("другая проверка");
    let error = assert_npc_social_check_fingerprint(&event, &other).expect_err("конфликт");
    assert_eq!(error.code, "IDEMPOTENCY_CONFLICT");
    assert!(assert_npc_social_check_fingerprint(&json!({}), &json!({})).is_err(), "пустой отпечаток не совпадает ни с чем");
}

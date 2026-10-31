//! Проверки `test/beast-taming.test.mjs` (и `beast-taming-ui-contract`) в
//! части самого модуля — над состояниями прогалины, которые генератор
//! эталона собрал настоящим Rules Engine (метки `fixtures/beast-taming.json`).

mod common;

use common::Fixture;
use serde_json::{json, Value};
use sk_npc_world::beast_taming::*;

fn fixture() -> Fixture {
    Fixture::load(include_str!("../fixtures/beast-taming.json"))
}

fn wolf(overrides: Value) -> Value {
    sk_core::js::spread(
        &json!({ "id": "enemy-wolf", "name": "Волк 1", "hp": 11, "maxHp": 11, "creature_type": "beast", "stat_block_id": "srd_5_2_1:wolf", "provenance": { "challenge_rating": "1/4" }, "x": 2, "y": 1, "alive": true }),
        overrides,
    )
}

fn boar() -> Value {
    json!({ "id": "enemy-boar", "name": "Гигантский кабан 1", "hp": 42, "maxHp": 42, "creature_type": "beast", "stat_block_id": "srd_5_2_1:giant-boar", "provenance": { "challenge_rating": "2" }, "x": 2, "y": 2, "alive": true })
}

#[test]
fn tameability_is_a_closed_list_not_a_creature_type() {
    assert!(is_tameable_beast(Some(&wolf(json!({})))));
    assert_eq!(beast_diet_for(Some(&wolf(json!({})))), Some(BeastDiet::Predator));
    assert_eq!(beast_diet_for(Some(&boar())), Some(BeastDiet::Herbivore));
    assert!(!is_tameable_beast(Some(&json!({ "creature_type": "beast", "stat_block_id": "srd_5_2_1:giant-spider" }))));
    assert!(!is_tameable_beast(Some(&json!({ "creature_type": "humanoid", "stat_block_id": "srd_5_2_1:bandit" }))));
    assert_eq!(beast_challenge_rating(Some(&wolf(json!({})))), 0.25);
    assert_eq!(beast_challenge_rating(Some(&boar())), 2.0);
    assert_eq!(beast_challenge_rating(Some(&json!({}))), 0.0);
}

#[test]
fn difficulty_differs_honestly_by_diet_and_wounds() {
    let fixture = fixture();
    let state = fixture.labelled("glade-two");
    let whole_wolf = beast_taming_policy(state, Some(&wolf(json!({}))), None);
    assert_eq!(whole_wolf.difficulty, 13);
    assert_eq!(beast_taming_policy(state, Some(&boar()), None).difficulty, 15);
    assert_eq!(beast_taming_policy(state, Some(&wolf(json!({ "hp": 4 }))), None).difficulty, 15);
    assert_eq!(whole_wolf.parts.iter().find(|part| part.id == "predator").map(|part| part.shift), Some(3));
    assert!(!beast_taming_policy(state, Some(&boar()), None).parts.iter().any(|part| part.id == "predator"));
    // Метка силы зверя без числа CR.
    assert!(whole_wolf.parts.iter().all(|part| !part.label.contains("1/4")));
}

#[test]
fn broken_morale_and_hand_feeding_lower_the_dc_failures_raise_it() {
    let fixture = fixture();
    assert_eq!(beast_taming_policy(fixture.labelled("glade-fled"), Some(&wolf(json!({}))), None).difficulty, 11);
    let state = fixture.labelled("glade");
    let fed = beast_taming_policy(state, Some(&wolf(json!({}))), Some(&json!({ "stage": "fed", "attempts": 0, "diet": "predator" })));
    assert_eq!(fed.difficulty, 9);
    assert_eq!(fed.stage_after(), "tamed");
    assert_eq!(beast_taming_policy(state, Some(&wolf(json!({}))), Some(&json!({ "stage": "wary", "attempts": 9, "diet": "predator" }))).difficulty, 16);
}

#[test]
fn in_combat_a_beast_is_not_soothed_until_morale_breaks() {
    let fixture = fixture();
    assert_eq!(tameable_beasts(fixture.labelled("fighting"))[0].blocked_reason, Some("combat_active"));
    assert_eq!(tameable_beasts(fixture.labelled("fighting-broken"))[0].blocked_reason, None);
    assert_eq!(tameable_beasts(fixture.labelled("dead-wolf"))[0].blocked_reason, Some("beast_down"));
}

#[test]
fn the_beast_must_be_within_arms_reach() {
    let fixture = fixture();
    let far = fixture.labelled("far-wolf");
    let reach = beast_reach_for(far, Some(&json!("hero")), Some(&json!("enemy-wolf")));
    assert!(reach.out_of_reach);
    assert!(reach.distance_feet.is_some_and(|distance| distance > BEAST_APPROACH_REACH_FEET as f64));
    let near = beast_reach_for(fixture.labelled("glade"), Some(&json!("hero")), Some(&json!("enemy-wolf")));
    assert_eq!(near, BeastReach { distance_feet: Some(5.0), out_of_reach: false });
    let rows = beast_reach_by_hero(far, Some(&json!("enemy-wolf")));
    assert_eq!(rows.get("hero").map(|row| row["out_of_reach"].clone()), Some(json!(true)));
    // Без клеток досягаемости нет вовсе.
    assert_eq!(beast_reach_for(&json!({}), Some(&json!("hero")), Some(&json!("enemy-wolf"))).distance_feet, None);
}

#[test]
fn ladder_calms_feeds_and_tames_into_a_companion() {
    let fixture = fixture();
    assert_eq!(beast_list(fixture.labelled("calmed"))[0]["stage"], "calmed");
    assert_eq!(beast_list(fixture.labelled("fed"))[0]["stage"], "fed");
    let tamed = beast_list(fixture.labelled("tamed"));
    assert_eq!((tamed[0]["stage"].clone(), tamed[0]["status"].clone()), (json!("tamed"), json!("companion")));
    assert!(tameable_beasts(fixture.labelled("tamed")).is_empty(), "спутник больше не кандидат");
    assert_eq!(beast_list(fixture.labelled("bitten"))[0]["bites"], 1);
}

#[test]
fn companion_watches_the_camp_only_for_party_perception() {
    let fixture = fixture();
    let camped = fixture.labelled("tamed-camped");
    let swing = beast_watch_swing(camped, Some(&json!("perception")), Some(&json!("hero"))).expect("стража лагеря");
    assert_eq!(swing["swing"], "advantage");
    assert_eq!(beast_watch_swing(camped, Some(&json!("stealth")), Some(&json!("hero"))), None);
    assert_eq!(beast_watch_swing(camped, Some(&json!("perception")), Some(&json!("enemy-scout"))), None);
    assert_eq!(beast_watch_swing(camped, Some(&json!("perception")), None), None);
    assert_eq!(beast_watch_swing(fixture.labelled("tamed"), Some(&json!("perception")), Some(&json!("hero"))), None, "на ходу зверь ничего не даёт");
    assert_eq!(beasts_for_viewer(camped, &json!({}))["watch_advantage"], true);
}

#[test]
fn companion_survives_the_forty_first_record() {
    let mut list = vec![json!({ "id": "beast:companion", "actor_id": "enemy-wolf", "name": "Волк 1", "diet": "predator", "stage": "tamed", "status": "companion" })];
    for index in 0..44 {
        list.push(json!({ "id": format!("beast:wild-{index}"), "actor_id": format!("enemy-wild-{index}"), "name": format!("Волк {index}"), "diet": "predator", "stage": "wary" }));
    }
    let normalized = normalize_beast_state(Some(&json!({ "beasts": list })));
    let ids: Vec<&str> = normalized["beasts"].as_array().map(|items| items.iter().filter_map(|beast| beast["id"].as_str()).collect()).unwrap_or_default();
    assert_eq!(ids.len(), 40);
    assert!(ids.contains(&"beast:companion"));
    assert!(!ids.contains(&"beast:wild-0"));
    assert!(ids.contains(&"beast:wild-43"));
}

#[test]
fn companion_follows_the_party_and_scaring_is_narrative_with_a_cooldown() {
    let fixture = fixture();
    let tamed = fixture.labelled("tamed");
    assert!(plan_beast_follow_drafts(tamed).is_empty(), "в той же сцене идти некуда");
    let mut elsewhere = tamed.clone();
    elsewhere["scene"] = json!({ "title": "Тихий Брод", "location": "Тихий Брод", "location_id": "village" });
    let drafts = plan_beast_follow_drafts(&elsewhere);
    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0]["payload"]["location_name"], "Тихий Брод");
    let beast = beast_list(tamed)[0].clone();
    assert!(beast_scare_line(Some(&beast), Some(&json!(0))).contains("Волк"));
    let scared = beast_list(fixture.labelled("scared"))[0].clone();
    assert!(beast_scare_cooldown_left(Some(&scared), Some(&scared["scared_at_minutes"])) > 0);
    assert_eq!(beast_scare_cooldown_left(Some(&beast), Some(&json!(0))), 0);
}

#[test]
fn players_get_no_stat_block_or_cr_and_candidates_carry_the_declared_dc() {
    let fixture = fixture();
    let calmed = fixture.labelled("calmed");
    let view = beasts_for_viewer(calmed, &json!({}));
    let visible = &view["beasts"][0];
    assert!(visible.get("stat_block_id").is_none() && visible.get("challenge_rating").is_none());
    assert_eq!((visible["diet_label"].clone(), visible["stage_label"].clone()), (json!("хищник"), json!("успокоен")));
    assert_eq!(beasts_for_viewer(calmed, &json!({ "isAdmin": true }))["beasts"][0]["stat_block_id"], "srd_5_2_1:wolf");
    let candidate = &beasts_for_viewer(fixture.labelled("glade"), &json!({}))["candidates"][0];
    assert_eq!(candidate["difficulty"], 13);
    assert_eq!(candidate["parts"].as_array().map(|parts| parts.iter().map(|part| part["id"].clone()).collect::<Vec<_>>()), Some(vec![json!("base"), json!("challenge"), json!("predator")]));
    assert_eq!((candidate["bites_on_failure"].clone(), candidate["skill"].clone(), candidate["ability"].clone()), (json!(true), json!("animal-handling"), json!("wis")));
}

#[test]
fn food_is_found_by_catalog_id_and_name_and_findings_are_not_food() {
    let ration = json!({ "id": "item-rations", "catalog_id": "srd_5_2_1:rations-one-day", "name": "Сухой паёк, 1 день", "type": "consumable", "quantity": 2 });
    let food = |inventory: Value, resolve: Option<&dyn Fn(&str) -> Option<Value>>| beast_food_item_for(Some(&json!({ "inventory": inventory })), resolve).map(|item| item["id"].clone());
    assert_eq!(food(json!([ration]), None), Some(json!("item-rations")));
    let resolver = |id: &str| (id == "custom:jerky").then(|| json!({ "use": { "kind": "ration" } }));
    assert_eq!(food(json!([{ "id": "i1", "catalog_id": "custom:jerky", "name": "Вяленое", "quantity": 1 }]), Some(&resolver)), Some(json!("i1")));
    assert_eq!(food(json!([{ "id": "i2", "name": "Копчёное мясо", "quantity": 1 }]), None), Some(json!("i2")));
    assert_eq!(food(json!([sk_core::js::spread(&ration, json!({ "quantity": 0 }))]), None), None);
    assert_eq!(food(json!([{ "id": "i3", "name": "Верёвка пеньковая", "quantity": 1 }]), None), None);
    let trophy = json!({ "id": "i-trophy", "name": "Вяленое сердце вепря", "quantity": 1, "rarity": "редкий" });
    assert_eq!(food(json!([trophy, ration]), None), Some(json!("item-rations")));
    assert_eq!(food(json!([{ "id": "i-jerky", "name": "Копчёное мясо", "quantity": 1 }, ration]), None), Some(json!("item-rations")));
    assert_eq!(food(json!([trophy]), None), None);
    assert_eq!(food(json!([{ "id": "i-quest", "name": "Вяленое мясо", "quantity": 1, "quest_item": true }]), None), None);
    assert_eq!(food(json!([{ "id": "i-att", "name": "Вяленое мясо", "quantity": 1, "requires_attunement": true }]), None), None);
}

#[test]
fn chronicle_cards_for_the_three_ladder_steps_only() {
    let calmed = beast_chronicle_entry(&json!({ "event_type": "BeastSoothingResolved", "payload": { "beast_id": "beast:1", "beast_name": "Волк", "success": true, "stage_after": "calmed", "diet": "predator" } })).expect("карточка");
    assert_eq!(calmed["id"], "chronicle:beast:1:calmed");
    assert_eq!(calmed["author"], BEAST_CARD_TITLE);
    assert_eq!(calmed["beast"]["diet_label"], "хищник");
    assert!(beast_chronicle_entry(&json!({ "event_type": "BeastBit", "payload": { "beast_id": "beast:1" } })).is_none());
    assert!(beast_chronicle_entry(&json!({ "event_type": "BeastTamed", "payload": { "beast_id": "" } })).is_none());
    let fed = beast_chronicle_entry(&json!({ "event_type": "BeastFed", "payload": { "beast_id": "b", "diet": "constructor" } })).expect("карточка");
    // Повадка-ключ прототипа — незнакомая: подпись пустая.
    assert_eq!(fed["beast"]["diet_label"], "");
    assert!(fed["text"].as_str().is_some_and(|text| text.contains("еду")));
    assert_eq!(BEAST_PLAYER_COMMAND_TYPES, ["CalmBeast", "FeedBeast", "ScareWithBeast"]);
}

#[test]
fn reducer_climbs_the_ladder_and_raw_counters_follow_js_addition() {
    let state = json!({ "mechanics": { "world_time": { "elapsed_minutes": 90 } } });
    let met = apply_beast_event(None, &json!({ "event_type": "BeastEncountered", "payload": { "beast": { "id": "beast:1", "actor_id": "enemy-wolf", "name": "Волк" } } }), &state);
    let failed = apply_beast_event(Some(&met), &json!({ "event_type": "BeastSoothingResolved", "payload": { "beast_id": "beast:1", "success": false } }), &state);
    assert_eq!(failed["beasts"][0]["attempts"], 1);
    let calmed = apply_beast_event(Some(&failed), &json!({ "event_type": "BeastSoothingResolved", "payload": { "beast_id": "beast:1", "success": true, "stage_after": "calmed" } }), &state);
    assert_eq!((calmed["beasts"][0]["attempts"].clone(), calmed["beasts"][0]["calmed_at_minutes"].clone()), (json!(0), json!(90)));
    let tamed = apply_beast_event(Some(&calmed), &json!({ "event_type": "BeastTamed", "payload": { "beast_id": "beast:1", "at_minutes": 120 } }), &state);
    assert_eq!((tamed["beasts"][0]["status"].clone(), tamed["beasts"][0]["tamed_at_minutes"].clone()), (json!("companion"), json!(120)));
    // Сырой срез своей версии: строковый счётчик склеивается, как `"2" + 1`.
    let raw = json!({ "schema_version": 1, "beasts": [{ "id": "beast:1", "actor_id": "a", "attempts": "2" }] });
    let bumped = apply_beast_event(Some(&raw), &json!({ "event_type": "BeastSoothingResolved", "payload": { "beast_id": "beast:1", "success": false } }), &state);
    assert_eq!(bumped["beasts"][0]["attempts"], 21);
}

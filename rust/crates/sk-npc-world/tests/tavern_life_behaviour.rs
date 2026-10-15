//! Проверки `test/tavern-life.test.mjs` в части самого модуля — над
//! состояниями, которые генератор эталона собрал настоящим Rules Engine
//! (метки `fixtures/tavern-life.json`), и над срезами заведения.

mod common;

use std::collections::BTreeSet;

use common::Fixture;
use serde_json::{json, Value};
use sk_npc_world::tavern_life::*;

const HONEST: &str = "barkeep";
const CROOK: &str = "hunter";

fn fixture() -> Fixture {
    Fixture::load(include_str!("../fixtures/tavern-life.json"))
}

fn scene(title: &str) -> Value {
    json!({ "scene": { "title": title, "location": title } })
}

#[test]
fn tavern_is_recognised_by_the_scene_and_verbs_do_not_open_it() {
    for title in ["Трактир «У моста»", "Корчма на развилке", "Постоялый двор у брода", "Ночь у постоялого двора", "Шинок у дороги", "The Broken Inn", "Old Alehouse"] {
        assert!(is_tavern_scene(&scene(title)), "«{title}» таверной не опознано");
    }
    for title in [
        "Тёмный лес",
        "Лавка старьёвщика",
        "Отряд постоял у ворот",
        "Стража постояла и разошлась",
        "Войско постояло у брода",
        "Солнце постояло в зените",
        "Пивная бочка в подвале",
        "Пивной погреб под лестницей",
        "Полка со швейных машинок",
        "Finn у костра",
        "Republic Square",
    ] {
        assert!(!is_tavern_scene(&scene(title)), "«{title}» опознано таверной");
    }
    assert!(is_tavern_scene(&json!({ "scene": { "title": "Поле", "map": { "theme": "Трактир" } } })));
}

#[test]
fn only_visible_living_neighbours_sit_at_the_table() {
    let fixture = fixture();
    let mut ids: Vec<String> = tavern_opponents(fixture.labelled("campaign")).into_iter().map(|npc| npc.id).collect();
    ids.sort();
    assert_eq!(ids, vec![HONEST.to_string(), CROOK.to_string()]);
    assert!(tavern_opponents(fixture.labelled("forest")).is_empty());
    assert!(!is_tavern_opponent(fixture.labelled("campaign"), &json!("someone-else")));
}

#[test]
fn opponent_character_is_seeded_and_not_stored() {
    let fixture = fixture();
    let state = fixture.labelled("campaign");
    assert!(tavern_gambler_for(state, &json!(CROOK)).crooked, "сид кампании TAVERN сажает шулера в охотника");
    assert!(!tavern_gambler_for(state, &json!(HONEST)).crooked);
    assert_eq!(tavern_gambler_for(state, &json!(CROOK)), tavern_gambler_for(&state.clone(), &json!(CROOK)));
    assert!(!sk_core::js::stringify(&state["tavern"]).contains("crooked"));
}

#[test]
fn table_difficulties_are_the_same_for_honest_and_crooked() {
    let fixture = fixture();
    let state = fixture.labelled("campaign");
    let (mut honest, mut crooked) = ((BTreeSet::new(), BTreeSet::new()), (BTreeSet::new(), BTreeSet::new()));
    for index in 0..300 {
        let gambler = tavern_gambler_for(state, &json!(format!("patron-{index}")));
        let bucket = if gambler.crooked { &mut crooked } else { &mut honest };
        bucket.0.insert(gambler.insight_passive);
        bucket.1.insert(gambler.tell_dc);
    }
    assert!(crooked.0.len() > 1 && honest.0.len() > 1);
    assert_eq!(crooked, honest);
}

#[test]
fn crook_substitutes_the_die_not_the_sum() {
    let fixture = fixture();
    let state = fixture.labelled("campaign");
    assert_eq!(tavern_gambler_for(state, &json!(CROOK)).opponent_die(Some(&json!(7))), 7 + TAVERN_CHEAT_BONUS);
    assert_eq!(tavern_gambler_for(state, &json!(HONEST)).opponent_die(Some(&json!(7))), 7);
    assert_eq!(tavern_opponent_die(Some(&json!({ "crooked": true, "dice_bonus": 5 })), Some(&json!(18))), 20);
    assert_eq!(tavern_opponent_die(None, Some(&json!(25))), 20);
}

#[test]
fn won_bank_comes_from_the_opponent_purse_and_runs_out() {
    let fixture = fixture();
    let start = tavern_gambler_purse_for(fixture.labelled("campaign"), &json!(HONEST)).expect("касса");
    assert!(start >= TAVERN_GAMBLER_PURSE_BASE_CP);
    let drained = fixture.labelled("drained-honest");
    assert!(tavern_max_stake_for(drained, &json!(HONEST)) < 200);
    // Уход из зала кассу не воскрешает.
    let moved = fixture.labelled("drained-moved");
    assert_eq!(tavern_gambler_purse_for(moved, &json!(HONEST)), tavern_gambler_purse_for(drained, &json!(HONEST)));
    let card = tavern_for_viewer(moved, &json!({ "playerId": "hero" })).expect("карточка");
    assert!(!sk_core::js::stringify(&card).contains("purse"), "чужая бухгалтерия игроку не уезжает");
}

#[test]
fn purses_are_evicted_by_last_play_not_by_slice() {
    let mut stale = serde_json::Map::new();
    for index in 0..24 {
        stale.insert(format!("patron-{index}"), json!({ "purse_cp": 500 + index, "last_played_at_minutes": 100 + index }));
    }
    let mut crowded_input = stale.clone();
    crowded_input.insert("patron-24".into(), json!({ "purse_cp": 7, "last_played_at_minutes": 900 }));
    let crowded = normalize_tavern_state(Some(&json!({ "gamblers": crowded_input })));
    assert_eq!(crowded["gamblers"].as_object().map(serde_json::Map::len), Some(24));
    assert_eq!(crowded["gamblers"]["patron-24"]["purse_cp"], 7);
    assert!(crowded["gamblers"].get("patron-0").is_none());
    assert_eq!(crowded["gamblers"]["patron-1"]["purse_cp"], 501);

    let mut late: serde_json::Map<String, Value> = stale.iter().map(|(id, gambler)| (id.clone(), json!({ "purse_cp": gambler["purse_cp"], "last_played_at_minutes": 500 }))).collect();
    late.insert("patron-late".into(), json!({ "purse_cp": 3, "last_played_at_minutes": 1 }));
    late.insert("patron-now".into(), json!({ "purse_cp": 9, "last_played_at_minutes": 900 }));
    let oldest_is_last = normalize_tavern_state(Some(&json!({ "gamblers": late })));
    assert!(oldest_is_last["gamblers"].get("patron-late").is_none());
    assert_eq!(oldest_is_last["gamblers"]["patron-now"]["purse_cp"], 9);
}

#[test]
fn patrons_are_evicted_by_weight_and_legacy_round_moves_within_the_limit() {
    let mut empty = serde_json::Map::new();
    for index in 0..12 {
        empty.insert(format!("walker-{index}"), json!({ "drinks": 0, "scandals": 0, "ejected": false }));
    }
    let mut barred = serde_json::Map::new();
    barred.insert("barred".into(), json!({ "drinks": 0, "scandals": 2, "ejected": true }));
    barred.extend(empty.clone());
    let crowded = normalize_tavern_state(Some(&json!({ "patrons": barred })));
    assert_eq!(crowded["patrons"].as_object().map(serde_json::Map::len), Some(12));
    assert_eq!(crowded["patrons"]["barred"]["ejected"], true);
    assert!(crowded["patrons"].get("walker-0").is_none());

    let legacy = normalize_tavern_state(Some(&json!({ "patrons": empty, "round": { "id": "r-1", "hero_id": "latecomer", "npc_id": HONEST, "stake_cp": 10, "npc_total": 12 } })));
    assert_eq!(legacy["patrons"].as_object().map(serde_json::Map::len), Some(12));
    assert_eq!(legacy["patrons"]["latecomer"]["round"]["id"], "r-1");
}

#[test]
fn purse_earmarks_cover_every_open_round_at_the_table() {
    let fixture = fixture();
    let state = fixture.labelled("five-heroes");
    let rounds = tavern_open_rounds_against(state, &json!(HONEST));
    let earmarked = tavern_earmarked_cp_against(state, &json!(HONEST));
    assert_eq!(earmarked, rounds.iter().map(|round| round.stake_cp).sum::<i64>());
    let purse = tavern_gambler_purse_for(state, &json!(HONEST)).expect("касса") as f64;
    assert_eq!(tavern_free_purse_for(state, &json!(HONEST)), (purse - earmarked as f64).max(0.0));
    assert!(tavern_max_stake_for(state, &json!(HONEST)) as f64 <= tavern_free_purse_for(state, &json!(HONEST)));
    // Раунды упорядочены по id героя.
    let heroes: Vec<String> = tavern_open_rounds(state).into_iter().map(|round| round.hero_id).collect();
    let mut sorted = heroes.clone();
    sorted.sort();
    assert_eq!(heroes, sorted);
}

#[test]
fn drinks_loosen_the_tongue_then_need_a_constitution_save() {
    let fixture = fixture();
    let hero = json!("hero");
    let first = fixture.labelled("drinks-1");
    assert_eq!(tavern_drinks_for(first, &hero), 1);
    assert_eq!(tavern_social_bonus(first, &hero, Some(&json!("persuasion"))), 1);
    assert_eq!(tavern_social_bonus(first, &hero, Some(&json!("stealth"))), 0);
    assert_eq!(tavern_next_drink_dc(first, &hero), None);
    let second = fixture.labelled("drinks-2");
    assert_eq!(tavern_next_drink_dc(second, &hero), Some(11), "третья кружка — первая опасная");
    let third = fixture.labelled("drinks-3");
    assert_eq!(tavern_social_bonus(third, &hero, Some(&json!("persuasion"))), 0);
    assert_eq!(tavern_next_drink_dc(third, &hero), Some(12));
    assert_eq!(tavern_table_mood(third, &hero), Some(json!({ "drinks": 3, "shared_drink": true, "talkative": false, "over_the_edge": true })));
    // Счёт обнуляется с переходом.
    let road = fixture.labelled("drinks-road");
    assert_eq!(tavern_drinks_for(road, &hero), 0);
    assert_eq!(tavern_round_for(road, &hero), None);
    assert_eq!(tavern_table_mood(road, &hero), None);
}

#[test]
fn viewer_card_has_no_opponent_character_and_no_foreign_score() {
    let fixture = fixture();
    let card = tavern_for_viewer(fixture.labelled("opened-crook-50"), &json!({ "playerId": "hero" })).expect("карточка");
    assert_eq!(card["round"]["npc_total"], 14);
    assert_eq!(card["round"]["target"], 15);
    assert_eq!(card["drink_price_cp"], TAVERN_DRINK_PRICE_CP);
    let text = sk_core::js::stringify(&card);
    for secret in ["crooked", "insight_passive", "tell_dc", "scandals", "opened_at_minutes"] {
        assert!(!text.contains(secret), "в карточке есть {secret}");
    }
    assert_eq!(tavern_for_viewer(fixture.labelled("forest"), &json!({ "playerId": "hero" })), None);
    // `tavern-ui-contract`: ставки и подписи серверные, первая кружка безопасна.
    let fresh = tavern_for_viewer(fixture.labelled("campaign"), &json!({ "playerId": "hero" })).expect("карточка");
    assert_eq!(fresh["stakes"], json!([{ "stake_cp": 10, "label": "на медяки" }, { "stake_cp": 50, "label": "на серебро" }, { "stake_cp": 200, "label": "по-крупному" }]));
    assert_eq!(fresh["round"], Value::Null);
    assert_eq!(fresh["next_drink_dc"], Value::Null);
    let honest = fresh["opponents"].as_array().and_then(|list| list.iter().find(|npc| npc["id"] == HONEST)).cloned().expect("трактирщик за столом");
    assert_eq!(honest["max_stake_cp"], json!(tavern_max_stake_for(fixture.labelled("campaign"), &json!(HONEST))));
    assert!(TAVERN_STAKES_CP.iter().any(|stake| honest["max_stake_cp"] == json!(stake)));
    // Ведущему без героя — открытый раунд зала.
    assert_eq!(tavern_for_viewer(fixture.labelled("opened-crook-50"), &json!({}))
        .map(|card| card["round"]["hero_id"].clone()), Some(json!("hero")));
}

#[test]
fn purse_cap_leaves_the_rest_to_the_house() {
    let transfer = tavern_purse_transfer(Some(&json!(9_950)), Some(&json!(200)));
    assert_eq!((transfer.moved_cp, transfer.house_cut_cp, transfer.after_cp), (50, 150, TAVERN_GAMBLER_PURSE_MAX_CP));
    let back = tavern_purse_transfer(Some(&json!(100)), Some(&json!(-200)));
    assert_eq!((back.after_cp, back.moved_cp, back.house_cut_cp), (0, -100, 0));
}

#[test]
fn reducer_keeps_the_score_and_scene_change_keeps_only_purses() {
    let opened = apply_tavern_event(
        None,
        &json!({ "event_type": "TavernDiceRoundOpened", "payload": { "round": { "id": "r-1", "hero_id": "hero", "npc_id": HONEST, "npc_name": "Бажен", "stake_cp": 50, "npc_total": 9, "opened_at_minutes": 30 } } }),
        &json!({}),
    );
    assert_eq!(opened["patrons"]["hero"]["round"]["target"], 10);
    let caught = apply_tavern_event(Some(&opened), &json!({ "event_type": "TavernDiceRoundResolved", "payload": { "hero_id": "hero", "npc_id": HONEST, "outcome": "caught", "npc_purse_after_cp": 450, "at_minutes": 40 } }), &json!({}));
    assert_eq!(caught["patrons"]["hero"], json!({ "drinks": 0, "scandals": 1, "ejected": false, "round": null }));
    assert_eq!(caught["gamblers"][HONEST], json!({ "purse_cp": 450, "last_played_at_minutes": 40 }));
    let drunk = apply_tavern_event(Some(&caught), &json!({ "event_type": "TavernDrinkOrdered", "payload": { "hero_id": "hero" } }), &json!({}));
    assert_eq!(drunk["patrons"]["hero"]["drinks"], 1);
    let moved = apply_tavern_event(Some(&drunk), &json!({ "event_type": "SceneAdvanced", "payload": {} }), &json!({}));
    assert_eq!(moved, json!({ "schema_version": 3, "patrons": {}, "gamblers": { HONEST: { "purse_cp": 450, "last_played_at_minutes": 40 } } }));
    // Своей версии срез на неизвестном событии возвращается как есть.
    let raw = json!({ "schema_version": 3, "patrons": { "x": "junk" }, "extra": 1 });
    assert_eq!(apply_tavern_event(Some(&raw), &json!({ "event_type": "Other" }), &json!({})), raw);
}

#[test]
fn proto_keys_behave_like_js() {
    let mut patrons = serde_json::Map::new();
    patrons.insert("__proto__".into(), json!({ "drinks": 3, "scandals": 1, "ejected": true, "round": null }));
    let mut gamblers = serde_json::Map::new();
    gamblers.insert("__proto__".into(), json!({ "purse_cp": 77, "last_played_at_minutes": 9 }));
    let state = json!({ "scene": { "title": "Трактир" }, "sessionCode": "X", "tavern": { "patrons": patrons, "gamblers": gamblers } });
    // В JSON записи `__proto__` нет, а чтение по ключу её находит.
    assert_eq!(normalize_tavern_state(state.get("tavern")), json!({ "schema_version": 3, "patrons": {}, "gamblers": {} }));
    assert_eq!(tavern_drinks_for(&state, &json!("__proto__")), 3);
    assert!(tavern_ejected(&state, &json!("__proto__")));
    assert_eq!(tavern_gambler_purse_for(&state, &json!("__proto__")), Some(77));
    // Поле прототипа и унаследованная функция — касса `undefined`.
    assert_eq!(tavern_gambler_purse_for(&state, &json!("purse_cp")), None);
    assert_eq!(tavern_gambler_purse_for(&state, &json!("constructor")), None);
    assert!(tavern_free_purse_for(&state, &json!("constructor")).is_nan());
    assert_eq!(tavern_max_stake_for(&state, &json!("constructor")), 0);
}

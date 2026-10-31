//! Эталон `server/encounter-rewards.mjs` (`fixtures/gen-encounter-rewards.mjs`):
//! перехват вызовов тестов модуля и потребителей, корпус паритета и случайные
//! встречи обеих редакций. Плюс перенесённые проверки
//! `test/encounter-reward.test.mjs`, `test/encounter-rewards-v2.test.mjs`,
//! `test/encounter-rewards-ruleset.test.mjs` (части про модуль).

use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_character::encounter_rewards::*;
use sk_core::{hash, js};
use sk_dice::{DiceService, SequenceRng};
use sk_items::loot_tables::server_encounter_loot;

static FIXTURE: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("../fixtures/encounter-rewards.json")).expect("эталон encounter-rewards"));

fn resolve(fixture: &Value, arg: &Value) -> Option<Value> {
    if arg.get("$undefined").is_some() {
        return None;
    }
    let Some(index) = arg.get("$v").and_then(Value::as_u64) else { return Some(arg.clone()) };
    let mut value = &fixture["values"][index as usize];
    for step in arg.get("path").and_then(Value::as_array).into_iter().flatten() {
        value = match step {
            Value::Number(position) => &value[position.as_u64().expect("индекс") as usize],
            Value::String(key) => &value[key.as_str()],
            other => panic!("шаг пути {other}"),
        };
    }
    Some(value.clone())
}

fn dice_for(spec: &Value) -> DiceService<SequenceRng> {
    let values: Vec<i64> = spec["sequence"].as_array().into_iter().flatten().filter_map(Value::as_i64).collect();
    let mut counter = 0u64;
    DiceService::new(
        SequenceRng::new(values),
        Box::new(move || {
            counter += 1;
            format!("coin-{counter}")
        }),
        Box::new(|| "2026-01-01T00:00:00.000Z".to_string()),
    )
}

fn run(name: &str, args: &[Option<Value>]) -> RewardResult<Option<Value>> {
    let arg = |index: usize| args.get(index).and_then(Option::as_ref);
    let field = |index: usize, key: &str| arg(index).and_then(|value| value.get(key));
    let state = || arg(0).cloned().unwrap_or_else(|| json!({}));
    let some = |value: Value| Ok(Some(value));
    match name {
        "encounterCompletionStageKey" => encounter_completion_stage_key(arg(0), arg(1)).map(|key| Some(json!(key))),
        "livingEncounterRewardRecipients" => living_encounter_reward_recipients(&state()).map(|ids| Some(json!(ids))),
        "freezeEncounterOutcomePlan" => freeze_encounter_outcome_plan(&state(), arg(1)).map(Some),
        "frozenEncounterOutcomePlanFromEvent" => frozen_encounter_outcome_plan_from_event(arg(0)).map(Some),
        "encounterCoinUnitsForXp" => some(json!(encounter_coin_units_for_xp(arg(0)))),
        "rollEncounterCoins" => match arg(1).filter(|spec| !spec.is_null()) {
            Some(spec) => {
                let mut dice = dice_for(spec);
                roll_encounter_coins(arg(0), Some(&mut dice)).map(Some)
            }
            None => roll_encounter_coins(arg(0), None).map(Some),
        },
        "lootForEncounterOutcome" => loot_for_encounter_outcome(arg(0)).map(|loot| Some(Value::Array(loot))),
        "serverRewardForEncounter" => server_reward_for_encounter(&state(), arg(1)).map(Some),
        "assertEncounterRewardRecipients" => {
            let recipients = arg(1).cloned().unwrap_or_else(|| json!([]));
            assert_encounter_reward_recipients(&state(), Some(&recipients)).map(|ok| Some(json!(ok)))
        }
        "distributeEncounterRewards" => distribute_encounter_rewards(&state(), field(1, "plan"), field(1, "coins"), field(1, "loot")).map(Some),
        "assertEncounterDistributionPreconditions" => assert_encounter_distribution_preconditions(&state(), arg(1)).map(|ok| Some(json!(ok))),
        "applyEncounterRewardsDistribution" => {
            let mut state = state();
            let event = arg(1).cloned().unwrap_or(Value::Null);
            let ids = apply_encounter_rewards_distribution(&mut state, &event)?;
            some(json!({ "ids": ids, "state": state }))
        }
        "encounterRewardResponse" => encounter_reward_response(field(0, "plan"), field(0, "coins"), field(0, "loot"), field(0, "distribution")).map(Some),
        other => panic!("неизвестная функция {other}"),
    }
}

fn error_matches(expected: &Value, actual: &EncounterRewardError) -> bool {
    if expected["name"] == "TypeError" {
        return actual.name == "TypeError";
    }
    expected["name"] == actual.name && expected["code"].as_str() == actual.code() && (actual.name == "RangeError" || expected["message"].as_str() == Some(actual.message.as_str()))
}

fn head(text: &str) -> String {
    text.chars().take(600).collect()
}

#[test]
fn fixture_matches_js() {
    let fixture = &*FIXTURE;
    let cases = fixture["cases"].as_array().expect("случаи");
    assert!(cases.len() > 1_500, "мало случаев: {}", cases.len());
    let mut failures = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let name = case["fn"].as_str().expect("имя");
        let args: Vec<Option<Value>> = case["args"].as_array().expect("аргументы").iter().map(|arg| resolve(fixture, arg)).collect();
        let outcome = run(name, &args);
        let ok = match (&outcome, case.get("error")) {
            (Err(actual), Some(expected)) => error_matches(expected, actual),
            (Ok(_), Some(_)) | (Err(_), None) => false,
            (Ok(None), None) => case.get("undefined").is_some(),
            (Ok(Some(value)), None) => match (case.get("result"), case.get("sha256")) {
                (Some(expected), _) => expected == value,
                (None, Some(expected)) => expected.as_str() == Some(hash::sha256_hex(js::stringify(value).as_bytes()).as_str()),
                _ => false,
            },
        };
        if !ok {
            failures.push(format!(
                "#{index} {name}: ожидалось {}, получено {}",
                case.get("error").or(case.get("result")).or(case.get("sha256")).map_or_else(|| "undefined".into(), |value| head(&value.to_string())),
                match &outcome {
                    Ok(Some(value)) => head(&js::stringify(value)),
                    Ok(None) => "undefined".into(),
                    Err(error) => format!("{} {:?} {}", error.name, error.code, error.message),
                }
            ));
        }
    }
    let mut by_fn = std::collections::BTreeMap::<String, usize>::new();
    for failure in &failures {
        let name = failure.split_whitespace().nth(1).unwrap_or("").trim_end_matches(':').to_string();
        *by_fn.entry(name).or_default() += 1;
    }
    assert!(failures.is_empty(), "расхождений {} из {}: {:?}\n{}", failures.len(), cases.len(), by_fn, failures.iter().take(20).cloned().collect::<Vec<_>>().join("\n"));
}

// --- перенесённые проверки -------------------------------------------------------

fn id(slug: &str) -> String {
    format!("srd_5_2_1:{slug}")
}

fn xp_of(stat_block: &str) -> i64 {
    match stat_block.trim_start_matches("srd_5_2_1:") {
        "giant-rat" => 25,
        "goblin-warrior" => 50,
        "ogre" => 450,
        _ => 0,
    }
}

fn enemy(enemy_id: &str, stat_block: &str, overrides: Value) -> Value {
    let mut enemy = json!({ "id": enemy_id, "stat_block_id": stat_block, "hp": 0, "alive": false, "provenance": { "xp": xp_of(stat_block) } });
    js::assign(&mut enemy, overrides);
    enemy
}

fn reward_state(enemies: &[Value], party: &[&str], deaths: Value, extra: &[Value]) -> Value {
    json!({
        "partyMemberIds": party,
        "players": party.iter().map(|hero| json!({
            "id": hero, "hp": if hero.contains("stable") { 0 } else { 10 }, "maxHp": 10,
            "currency": { "copper": 0, "silver": 0, "gold": 0, "platinum": 0 }, "inventory": [],
        })).collect::<Vec<_>>(),
        "enemies": enemies.iter().chain(extra).cloned().collect::<Vec<_>>(),
        "mechanics": {
            "death": { "heroes": deaths },
            "encounter": {
                "id": "encounter-reward-v2", "encounter_id": "encounter-reward-v2", "status": "ended", "outcome": "enemies_defeated",
                "theme": "generic", "difficulty": "hard",
                "enemy_ids": enemies.iter().map(|enemy| enemy["id"].clone()).collect::<Vec<_>>(),
                "enemies": enemies.iter().map(|enemy| json!({ "id": enemy["id"], "stat_block_id": enemy["stat_block_id"] })).collect::<Vec<_>>(),
            },
        },
    })
}

fn code(result: RewardResult<Value>) -> String {
    result.expect_err("ожидался отказ").code.unwrap_or_default()
}

#[test]
fn frozen_outcome_takes_xp_only_from_stat_block() {
    let rat = enemy("rat", &id("giant-rat"), json!({ "xp": 9_007_199_254_740_991_i64 }));
    let goblin = enemy("goblin", &id("goblin-warrior"), json!({ "xp": -999 }));
    let outsider = enemy("outsider", &id("ogre"), json!({}));
    let state = reward_state(&[rat, goblin], &["hero-a", "hero-b"], json!({}), &[outsider]);
    let plan = freeze_encounter_outcome_plan(&state, Some(&json!("enemies_defeated"))).unwrap();
    assert_eq!(plan["total_xp"], 75);
    assert_eq!(
        plan["enemies"],
        json!([{ "enemy_id": "rat", "stat_block_id": id("giant-rat"), "xp": 25 }, { "enemy_id": "goblin", "stat_block_id": id("goblin-warrior"), "xp": 50 }])
    );
}

#[test]
fn dead_heroes_are_not_recipients_but_stable_ones_are() {
    let state = reward_state(
        &[enemy("rat-1", &id("giant-rat"), json!({}))],
        &["hero-a", "hero-dead", "hero-stable"],
        json!({ "hero-dead": { "status": "dead" }, "hero-stable": { "status": "stable" } }),
        &[],
    );
    assert_eq!(freeze_encounter_outcome_plan(&state, None).unwrap()["recipients"], json!(["hero-a", "hero-stable"]));
}

#[test]
fn invalid_outcome_plans_are_rejected_before_any_roll() {
    let base = reward_state(&[enemy("rat-1", &id("giant-rat"), json!({}))], &["hero-a", "hero-b"], json!({}), &[]);
    let freeze = |state: &Value| freeze_encounter_outcome_plan(state, None);
    let mut duplicate = base.clone();
    duplicate["mechanics"]["encounter"]["enemy_ids"].as_array_mut().unwrap().push(json!("rat-1"));
    assert_eq!(code(freeze(&duplicate)), "ENCOUNTER_ENEMY_DUPLICATE");
    let thirteen: Vec<Value> = (1..=13).map(|index| enemy(&format!("rat-{index}"), &id("giant-rat"), json!({}))).collect();
    assert_eq!(code(freeze(&reward_state(&thirteen, &["hero-a"], json!({}), &[]))), "ENCOUNTER_ENEMY_COUNT_INVALID");
    let mut unknown = base.clone();
    unknown["enemies"] = json!([]);
    assert_eq!(code(freeze(&unknown)), "ENCOUNTER_ENEMY_UNKNOWN");
    let living = reward_state(&[enemy("rat-1", &id("giant-rat"), json!({ "hp": 1, "alive": true }))], &["hero-a"], json!({}), &[]);
    assert_eq!(code(freeze(&living)), "ENCOUNTER_ENEMY_LIVING");
    let mut missing_hp = base.clone();
    let rat = missing_hp["enemies"][0].as_object_mut().unwrap();
    rat.shift_remove("hp");
    rat.shift_remove("alive");
    assert_eq!(code(freeze(&missing_hp)), "ENCOUNTER_ENEMY_LIVING");
    let mut foreign = base.clone();
    foreign["mechanics"]["encounter"]["enemies"][0]["stat_block_id"] = json!(id("ogre"));
    assert_eq!(code(freeze(&foreign)), "ENCOUNTER_ENEMY_FOREIGN");
}

#[test]
fn coins_are_one_d6_per_sorted_enemy() {
    let enemies = [enemy("rat", &id("giant-rat"), json!({})), enemy("goblin", &id("goblin-warrior"), json!({})), enemy("ogre", &id("ogre"), json!({}))];
    let plan = freeze_encounter_outcome_plan(&reward_state(&enemies, &["hero-a"], json!({}), &[]), None).unwrap();
    let mut dice = dice_for(&json!({ "sequence": [2, 3, 4] }));
    let coins = roll_encounter_coins(Some(&plan), Some(&mut dice)).unwrap();
    assert_eq!(coins["policy"], ENCOUNTER_COINS_POLICY_ID);
    let ids: Vec<&str> = coins["rolls"].as_array().unwrap().iter().map(|roll| roll["enemy_id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["goblin", "ogre", "rat"]);
    assert_eq!(coins["total_cp"], 2 * 2 + 3 * 18 + 4);
    assert_eq!(encounter_coin_units_for_xp(Some(&json!(450))), 18);
    assert_eq!(roll_encounter_coins(Some(&plan), None).unwrap_err().name, "TypeError");
}

#[test]
fn coin_cap_holds_for_twelve_malicious_enemies() {
    let enemies: Vec<Value> = (0..12).map(|index| json!({ "enemy_id": format!("e-{index:02}"), "stat_block_id": "x", "xp": 9_007_199_254_740_991_i64 })).collect();
    let plan = json!({ "rewards_eligible": true, "encounter_id": "cap", "enemies": enemies });
    let mut dice = dice_for(&json!({ "sequence": vec![6; 12] }));
    let coins = roll_encounter_coins(Some(&plan), Some(&mut dice)).unwrap();
    assert_eq!(coins["total_cp"], MAX_ENCOUNTER_COINS_CP);
}

#[test]
fn no_living_recipients_keep_everything_unassigned() {
    let state = reward_state(&[enemy("rat-1", &id("giant-rat"), json!({}))], &["hero-dead"], json!({ "hero-dead": { "status": "dead" } }), &[]);
    let plan = freeze_encounter_outcome_plan(&state, None).unwrap();
    let mut dice = dice_for(&json!({ "sequence": [3] }));
    let coins = roll_encounter_coins(Some(&plan), Some(&mut dice)).unwrap();
    let loot = Value::Array(loot_for_encounter_outcome(Some(&plan)).unwrap());
    let distribution = distribute_encounter_rewards(&state, Some(&plan), Some(&coins), Some(&loot)).unwrap();
    assert_eq!(distribution["allocations"], json!([]));
    assert_eq!(distribution["unassigned"]["xp"], 25);
    assert_eq!(distribution["unassigned"]["coins_cp"], 3);
}

#[test]
fn distribution_applies_once_and_rejects_reused_item_ids() {
    let state = reward_state(&[enemy("rat-1", &id("giant-rat"), json!({}))], &["hero-a", "hero-b"], json!({}), &[]);
    let plan = freeze_encounter_outcome_plan(&state, None).unwrap();
    let mut dice = dice_for(&json!({ "sequence": [5] }));
    let coins = roll_encounter_coins(Some(&plan), Some(&mut dice)).unwrap();
    let loot = Value::Array(loot_for_encounter_outcome(Some(&plan)).unwrap());
    let distribution = distribute_encounter_rewards(&state, Some(&plan), Some(&coins), Some(&loot)).unwrap();
    assert!(assert_encounter_distribution_preconditions(&state, Some(&distribution)).unwrap());
    let event = json!({ "event_type": "EncounterRewardsDistributed", "event_schema_version": 1, "payload": distribution });
    let mut after = state.clone();
    let ids = apply_encounter_rewards_distribution(&mut after, &event).unwrap();
    assert_eq!(ids.len(), 2);
    let total: i64 = ["hero-a", "hero-b"]
        .iter()
        .map(|hero| sk_economy::merchant_economy::currency_to_copper(after["players"].as_array().unwrap().iter().find(|player| player["id"] == *hero).map(|player| &player["currency"])))
        .sum();
    assert_eq!(total, 5);
    let mut again = after.clone();
    let items_given = after["players"].as_array().unwrap().iter().map(|player| player["inventory"].as_array().unwrap().len()).sum::<usize>();
    let reapplied = apply_encounter_rewards_distribution(&mut again, &event).unwrap();
    if items_given > 0 {
        assert!(reapplied.is_empty(), "повтор с теми же id вещей не применяется");
        assert_eq!(again, after);
        assert_eq!(code(assert_encounter_distribution_preconditions(&after, Some(&event["payload"])).map(Value::Bool)), "ENCOUNTER_REWARD_STATE_CHANGED");
    }
    let mut unknown = state.clone();
    assert!(apply_encounter_rewards_distribution(&mut unknown, &json!({ "event_type": "EncounterRewardsDistributed", "event_schema_version": 2, "payload": event["payload"] })).unwrap().is_empty());
    assert_eq!(unknown, state);
}

#[test]
fn reward_summary_matches_compat_api() {
    let enemies = [
        enemy("rat-1", &id("giant-rat"), json!({ "xp": 9_007_199_254_740_991_i64 })),
        enemy("goblin-1", &id("goblin-warrior"), json!({ "xp": -999 })),
    ];
    let mut state = reward_state(&enemies, &["hero"], json!({}), &[]);
    state["mechanics"]["encounter"]["id"] = json!("encounter-1");
    state["mechanics"]["encounter"]["encounter_id"] = json!("encounter-1");
    state["mechanics"]["encounter"]["difficulty"] = json!("medium");
    let reward = server_reward_for_encounter(&state, Some(&json!("enemies_defeated"))).unwrap();
    assert_eq!(reward["xp"], 75);
    assert_eq!(reward["recipients"], json!(["hero"]));
    assert_eq!(reward["progression"], "xp");
    assert_eq!(reward["milestone"], Value::Null);
    let expected = server_encounter_loot(Some(&json!({ "theme": "generic", "difficulty": "medium", "encounterId": "encounter-1" }))).unwrap();
    assert_eq!(reward["loot"], Value::Array(expected));
    assert_eq!(reward["loot"].as_array().unwrap().len(), 2);
}

#[test]
fn ruleset_catalogs_are_not_mixed() {
    let mut state = reward_state(&[enemy("wolf", "dnd_5e_2014:wolf", json!({ "provenance": {} }))], &["hero"], json!({}), &[]);
    state["ruleset_id"] = json!("dnd_5e_2014");
    let plan = freeze_encounter_outcome_plan(&state, None);
    if let Ok(plan) = &plan {
        assert!(plan["total_xp"].as_i64().unwrap_or(0) > 0);
    }
    let mut mixed = reward_state(&[enemy("rat", &id("giant-rat"), json!({}))], &["hero"], json!({}), &[]);
    mixed["ruleset_id"] = json!("dnd_5e_2014");
    assert_eq!(code(freeze_encounter_outcome_plan(&mixed, None)), "ENCOUNTER_RULESET_MISMATCH");
    let mut unknown = reward_state(&[enemy("x", "srd_5_2_1:not-a-monster", json!({ "provenance": {} }))], &["hero"], json!({}), &[]);
    unknown["ruleset_id"] = json!("srd_5_2_1");
    assert_eq!(code(freeze_encounter_outcome_plan(&unknown, None)), "ENCOUNTER_STAT_BLOCK_UNKNOWN");
}

/// Редакция-ключ прототипа (`constructor`) — неизвестная: каталога наград нет,
/// а не `TypeError`.
#[test]
fn prototype_ruleset_key_is_unknown_ruleset() {
    let mut state = reward_state(&[enemy("x", "homebrew:thing", json!({}))], &["hero"], json!({}), &[]);
    state["ruleset_id"] = json!("constructor");
    assert_eq!(code(freeze_encounter_outcome_plan(&state, None)), "ENCOUNTER_STAT_BLOCK_UNKNOWN");
}

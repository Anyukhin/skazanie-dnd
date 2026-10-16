//! `offscreen_world`: эталон JS (`fixtures/offscreen-world.json`, генератор —
//! `fixtures/gen-offscreen-world.mjs`) — `test/offscreen-world.test.mjs` и
//! `test/offscreen-world-ui-contract.test.mjs` под перехватом (ход времени
//! через настоящий Rules Engine, replay, проекция, рекап), случайные кампании
//! и цепочки ходов мира, мусор старых сохранений и корпус паритета. Ниже —
//! проверки модуля из тестов JS, которые не требуют движка.

mod harness;

use harness::{check, Args, Fixture, Outcome};
use serde_json::{json, Value};
use sk_core::js;
use sk_world_story::offscreen_world::*;

fn run(name: &str, args: &Args) -> Outcome {
    let state = args.or_empty(0);
    Ok(Some(match name {
        "offscreenCampaignDay" => js::num(offscreen_campaign_day(args.get(0))),
        "normalizeOffscreenWorldState" => normalize_offscreen_world_state(args.get(0)),
        "antagonistFactionFor" => antagonist_faction_for(&state).cloned().unwrap_or(Value::Null),
        "planOffscreenWorldStep" => plan_offscreen_world_step(&state, args.get(1).and_then(|options| options.get("elapsedMinutes"))).unwrap_or(Value::Null),
        "offscreenLinesFor" => json!(offscreen_lines_for(args.get(0))),
        "applyOffscreenWorldEvent" => apply_offscreen_world_event(args.get(0), args.get(1)),
        "offscreenWorldFeed" => Value::Array(offscreen_world_feed(&state, args.get(1).and_then(|options| options.get("limit")))),
        "offscreenChronicleEntry" => offscreen_chronicle_entry(args.get(0)).unwrap_or(Value::Null),
        other => panic!("неизвестная функция эталона {other}"),
    }))
}

static FIXTURE: std::sync::LazyLock<Fixture> = std::sync::LazyLock::new(|| Fixture::load_gz(include_bytes!("../fixtures/offscreen-world.json.gz")));

#[test]
fn offscreen_world_matches_js() {
    let summary = check(&FIXTURE, run);
    println!("{summary:?}");
    assert!(summary.calls > 5_000, "{summary:?}");
    assert_eq!(summary.per_fn.len(), 8, "{summary:?}");
}

#[test]
fn constants_match_js() {
    let constants = &FIXTURE.data["constants"];
    assert_eq!(constants["OFFSCREEN_WORLD_SCHEMA_VERSION"], json!(OFFSCREEN_WORLD_SCHEMA_VERSION));
    assert_eq!(constants["OFFSCREEN_WORLD_POLICY_ID"], json!(OFFSCREEN_WORLD_POLICY_ID));
    assert_eq!(constants["OFFSCREEN_WORLD_EVENT_TYPE"], json!(OFFSCREEN_WORLD_EVENT_TYPE));
    assert_eq!(constants["OFFSCREEN_CARD_TITLE"], json!(OFFSCREEN_CARD_TITLE));
    assert_eq!(constants["OFFSCREEN_CARD_TITLE_PREFIX"], json!(OFFSCREEN_CARD_TITLE_PREFIX));
    assert_eq!(constants["OFFSCREEN_STEP_MINIMUM_MINUTES"], json!(OFFSCREEN_STEP_MINIMUM_MINUTES));
    assert_eq!(constants["OFFSCREEN_STEP_INTERVAL_MINUTES"], json!(OFFSCREEN_STEP_INTERVAL_MINUTES));
    assert_eq!(constants["OFFSCREEN_QUEST_EXPIRY_MINUTES"], json!(OFFSCREEN_QUEST_EXPIRY_MINUTES));
    assert_eq!(constants["OFFSCREEN_QUEST_TICK_LIMIT"], json!(OFFSCREEN_QUEST_TICK_LIMIT));
    assert_eq!(constants["FACTION_MOVE_KINDS"], json!(FACTION_MOVE_KINDS));
    let labels: serde_json::Map<String, Value> = OFFSCREEN_ENTRY_LABELS.iter().map(|(kind, label)| (kind.to_string(), json!(label))).collect();
    assert_eq!(constants["OFFSCREEN_ENTRY_LABELS"], Value::Object(labels));
}

/// Отряд у каравана: party-видимое задание с часами, враждебная фракция и
/// известный NPC вне сцены, а рядом — тайные двойники ведущего.
fn caravan(minutes: i64) -> Value {
    json!({
        "sessionCode": "OFFSCREEN",
        "partyMemberIds": ["hero"],
        "players": [{ "id": "hero", "character": "Ада" }],
        "scene": { "title": "Двор постоялого", "location": "Тихий Брод", "location_id": "village" },
        "worldMap": { "seed": "offscreen-seed", "currentLocationId": "village", "locations": [] },
        "social": { "npcs": [
            { "id": "assassin", "name": "Тень", "location": "Мельница", "visibility": "gm_only" },
            { "id": "miller", "name": "Мельник Гость", "location": "Мельница", "visibility": "party" },
        ] },
        "worldMemory": {
            "entities": [
                { "id": "faction-cult", "kind": "faction", "name": "Круг", "visibility": "gm_only", "tags": ["antagonist"] },
                { "id": "faction-wolves", "kind": "faction", "name": "Волчья ватага", "visibility": "party", "tags": [] },
            ],
            "quests": [
                { "id": "quest-caravan", "title": "Караван у брода", "status": "active", "visibility": "party", "clock": { "current": 0, "max": 4 } },
                { "id": "quest-gm-thread", "title": "Нить", "status": "active", "visibility": "gm_only", "clock": { "current": 0, "max": 4 } },
            ],
        },
        "autonomy": { "reputations": { "faction-wolves": -30 } },
        "mechanics": { "world_time": { "elapsed_minutes": minutes } },
    })
}

#[test]
fn short_jump_does_nothing_long_rest_moves_the_world() {
    let state = caravan(0);
    assert_eq!(plan_offscreen_world_step(&state, Some(&json!(OFFSCREEN_STEP_MINIMUM_MINUTES - 1))), None);
    let planned = plan_offscreen_world_step(&state, Some(&json!(OFFSCREEN_STEP_MINIMUM_MINUTES))).expect("ход мира");
    let lines = planned["step"]["lines"].as_array().expect("строки");
    assert!((1..=3).contains(&lines.len()));
    assert_eq!(plan_offscreen_world_step(&state, Some(&json!(720))), plan_offscreen_world_step(&state, Some(&json!(720))), "детерминизм");
}

#[test]
fn gm_secrets_stay_out_of_the_world_step() {
    let state = caravan(0);
    assert_eq!(antagonist_faction_for(&state).and_then(|faction| faction.get("id")), Some(&json!("faction-wolves")));
    let planned = plan_offscreen_world_step(&state, Some(&json!(1_440))).expect("ход мира");
    let text = js::stringify(&planned);
    assert!(!text.contains("quest-gm-thread") && !text.contains("faction-cult") && !text.contains("assassin"), "{text}");
}

#[test]
fn world_steps_at_most_once_a_day() {
    let state = caravan(0);
    let planned = plan_offscreen_world_step(&state, Some(&json!(480))).expect("ход мира");
    let event = planned["drafts"].as_array().and_then(|drafts| drafts.iter().find(|draft| draft["event_type"] == OFFSCREEN_WORLD_EVENT_TYPE)).cloned().expect("событие");
    let mut rested = state.clone();
    rested["offscreen_world"] = apply_offscreen_world_event(None, Some(&event));
    rested["mechanics"]["world_time"]["elapsed_minutes"] = json!(480);
    assert_eq!(plan_offscreen_world_step(&rested, Some(&json!(480))), None, "те же сутки");
    assert!(plan_offscreen_world_step(&rested, Some(&json!(1_440))).is_some(), "следующие сутки");
    let card = offscreen_chronicle_entry(Some(&event)).expect("карточка");
    assert_eq!(card["offscreen"]["title"], json!(OFFSCREEN_CARD_TITLE));
    assert_eq!(offscreen_chronicle_entry(Some(&json!({ "event_type": "TimeAdvanced", "payload": {} }))), None);
}

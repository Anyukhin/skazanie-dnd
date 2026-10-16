//! Перенос проверок самого модуля из `test/courier-letters.test.mjs` и
//! `test/courier-letters-ui-contract.test.mjs` (без HTTP, Rules Engine и UI),
//! плюс полировка ответа моделью (`withCourierReplyDraft`) с заглушкой.

use std::future::Future;
use std::pin::pin;
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};

use serde_json::{json, Value};
use sk_world_life::courier_letters::*;

const INN: &str = "Трактир «У моста»";
const MILL: &str = "Мельница";

fn campaign() -> Value {
    json!({
        "players": [{ "id": "hero", "character": "Ада" }],
        "scene": { "title": INN, "location": INN, "location_id": "inn" },
        "social": {
            "npcs": [
                { "id": "ally", "name": "Мельник Гость", "role": "мельник", "location": MILL, "visibility": "party", "public_summary": "Мелет зерно." },
                { "id": "stranger", "name": "Возчик Сновид", "role": "возчик", "location": MILL, "visibility": "party", "public_summary": "Возит зерно." },
                { "id": "foe", "name": "Ростовщик Злоба", "role": "ростовщик", "location": MILL, "visibility": "party", "public_summary": "Считает долги." },
                { "id": "secret", "name": "Тень у очага", "role": "никто", "location": MILL, "visibility": "gm_only", "public_summary": "Ведущему." },
            ],
            "relationships": { "ally": { "hero": 60 }, "foe": { "hero": -70 } },
        },
        "worldMemory": { "entities": [
            { "id": "faction-wolves", "kind": "faction", "name": "Волчья ватага", "visibility": "party", "tags": [] },
            { "id": "faction-secret", "kind": "faction", "name": "Тайный круг", "visibility": "gm_only", "tags": [] },
        ] },
        "worldMap": {
            "locations": [{ "id": "inn", "name": INN, "x": 120, "y": 120 }, { "id": "mill", "name": MILL, "x": 420, "y": 120 }],
            "routes": [{ "from": "inn", "to": "mill", "distance": 2, "discovered": true }],
            "currentLocationId": "inn",
        },
        "mechanics": { "world_time": { "elapsed_minutes": 0 } },
    })
}

fn send(state: &Value, addressee_id: &str, body: &str) -> Value {
    let addressee = courier_addressee_for(state, Some(&json!("npc")), Some(&json!(addressee_id)), None).expect("адресат");
    plan_courier_letter(state, &json!({ "heroId": "hero", "heroName": "Ада", "addressee": addressee, "body": body, "commandId": "cmd-1" })).expect("письмо")
}

fn with_letter(state: &Value, letter: &Value) -> Value {
    let mut next = state.clone();
    next["courier_letters"] = apply_courier_letter_event(None, &json!({ "event_type": "CourierLetterSent", "payload": { "letter": letter } }));
    next
}

#[test]
fn distance_follows_roads_not_straight_line() {
    let state = campaign();
    let map = state.get("worldMap");
    assert_eq!(world_leagues_between(map, Some(&json!("inn")), Some(&json!("mill"))), Some(2.0));
    assert_eq!(world_leagues_between(map, Some(&json!("inn")), Some(&json!("inn"))), Some(0.0));
    assert_eq!(world_leagues_between(map, Some(&json!("inn")), Some(&json!("ghost"))), None);
    let mut hidden = state.clone();
    hidden["worldMap"]["routes"][0]["discovered"] = json!(false);
    // Без разведанной дороги — прямая: 300 / 48 → 6.
    assert_eq!(world_leagues_between(hidden.get("worldMap"), Some(&json!("inn")), Some(&json!("mill"))), Some(6.0));
}

#[test]
fn fee_and_time_grow_with_distance_and_hit_the_cap() {
    assert_eq!(courier_fee_for(Some(&json!(0))), COURIER_LETTER_BASE_FEE_CP);
    assert_eq!(courier_fee_for(Some(&json!(3))), COURIER_LETTER_BASE_FEE_CP + 3 * COURIER_LETTER_FEE_PER_LEAGUE_CP);
    assert_eq!(courier_fee_for(Some(&json!(500))), COURIER_LETTER_BASE_FEE_CP + COURIER_LETTER_MAX_LEAGUES * COURIER_LETTER_FEE_PER_LEAGUE_CP);
    assert_eq!(courier_travel_minutes(Some(&json!(1))), COURIER_LETTER_MINIMUM_MINUTES);
    assert_eq!(courier_travel_minutes(Some(&json!(5))), 5 * COURIER_LETTER_MINUTES_PER_LEAGUE);
    assert_eq!(courier_travel_minutes(Some(&json!(500))), COURIER_LETTER_MAX_LEAGUES * COURIER_LETTER_MINUTES_PER_LEAGUE);
}

#[test]
fn addressees_are_known_npcs_and_open_factions() {
    let state = campaign();
    let rows = courier_letter_addressees(&state);
    let ids: Vec<&str> = rows.iter().filter_map(|row| row["id"].as_str()).collect();
    assert!(ids.contains(&"ally") && ids.contains(&"faction-wolves"));
    assert!(!ids.contains(&"secret") && !ids.contains(&"faction-secret"));
    let ally = rows.iter().find(|row| row["id"] == "ally").expect("союзник");
    assert_eq!(ally["leagues"], 2);
    assert_eq!(ally["place_name"], MILL);
    let faction = rows.iter().find(|row| row["id"] == "faction-wolves").expect("фракция");
    assert_eq!(faction["leagues"], COURIER_LETTER_FACTION_LEAGUES);
    // Ближние вперёд.
    assert!(rows.windows(2).all(|pair| pair[0]["leagues"].as_i64() <= pair[1]["leagues"].as_i64()));
}

#[test]
fn tone_steps_match_relationship_tiers() {
    for (score, tone) in [(-100, "silent"), (-50, "silent"), (-49, "cold"), (-20, "cold"), (-19, "plain"), (19, "plain"), (20, "friendly"), (49, "friendly"), (50, "warm"), (500, "warm")] {
        assert_eq!(courier_tone_for(Some(&json!(score))), tone, "{score}");
    }
    assert_eq!(courier_tone_for(None), "plain");
}

#[test]
fn promise_is_recognised_by_the_word_and_due_hint_by_the_same_parser() {
    let promise = courier_letter_promise_from(Some(&json!("Здравствуй. Обещаю вернуть долг завтра. Жди."))).expect("обещание");
    assert_eq!(promise["text"], "Обещаю вернуть долг завтра.");
    assert_eq!(promise["due_hint"], "Обещаю вернуть долг завтра.");
    assert_eq!(courier_letter_promise_from(Some(&json!("Перевернуть всё."))), None, "граница слова — не `\\b`");
    assert_eq!(courier_letter_promise_from(Some(&json!(""))), None);
}

#[test]
fn delivery_is_a_social_act_and_reply_comes_later() {
    let state = campaign();
    let letter = send(&state, "ally", "Здравствуй. Обещаю помочь завтра.");
    assert_eq!(letter["status"], "in_transit");
    assert_eq!(letter["tone"], "warm");
    assert_eq!(letter["fee_cp"], 70);
    let sent = with_letter(&state, &letter);
    let travel = courier_travel_minutes(Some(&json!(2)));
    assert!(plan_courier_letter_ticks(&sent, Some(&json!(travel - 1))).is_empty(), "курьер ещё в пути");
    assert!(plan_courier_letter_ticks(&sent, Some(&json!(0))).is_empty());
    let drafts = plan_courier_letter_ticks(&sent, Some(&json!(travel)));
    let types: Vec<&str> = drafts.iter().filter_map(|draft| draft["event_type"].as_str()).collect();
    assert_eq!(types[0], "CourierLetterDelivered");
    assert!(types.contains(&"NpcRelationshipAdjusted"));
    assert!(types.contains(&"NpcPromiseRecorded"));
    assert!(types.contains(&"WorldFactRecorded"));
    assert!(!types.contains(&"CourierLetterAnswered"));
    assert_eq!(drafts, plan_courier_letter_ticks(&sent, Some(&json!(travel))), "детерминизм");
    let week = plan_courier_letter_ticks(&sent, Some(&json!(10_000)));
    let answered = week.iter().find(|draft| draft["event_type"] == "CourierLetterAnswered").expect("ответ");
    assert_eq!(answered["payload"]["provider"], "deterministic-courier-reply");
    assert_eq!(week.iter().filter(|draft| draft["event_type"] == "WorldEntityUpserted").count(), 1, "сущность адресата — один раз");
}

#[test]
fn dead_addressee_returns_the_letter() {
    let state = campaign();
    let letter = send(&state, "stranger", "Привет.");
    let mut sent = with_letter(&state, &letter);
    sent["npc_world"] = json!({ "vitals": { "stranger": { "hp": 0, "max_hp": 5, "alive": false } } });
    let drafts = plan_courier_letter_ticks(&sent, Some(&json!(2_000)));
    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0]["event_type"], "CourierLetterReturned");
    assert_eq!(drafts[0]["payload"]["reason"], "dead");
}

#[test]
fn enemy_gets_silence_and_reply_draft_only_for_same_tone() {
    let state = campaign();
    let letter = send(&state, "foe", "Верни долг.");
    assert_eq!(letter["tone"], "silent");
    let delivered = plan_courier_letter_ticks(&with_letter(&state, &letter), Some(&json!(100_000)));
    assert_eq!(delivered[0]["payload"]["answer_expected"], false);
    assert!(!delivered.iter().any(|draft| draft["event_type"] == "CourierLetterAnswered"));

    let polished = json!({ "id": "letter:x", "addressee_name": "Гость", "hero_name": "Ада", "reply_draft": "Приходи, друг.", "reply_draft_tone": "warm", "reply_provider": "RouterLlmClient" });
    assert_eq!(courier_letter_reply_for(&polished, Some(&json!("warm"))), Some(json!({ "reply": "Приходи, друг.", "provider": "RouterLlmClient" })));
    assert_eq!(courier_letter_reply_for(&polished, Some(&json!("cold"))).map(|reply| reply["provider"].clone()), Some(json!("deterministic-courier-reply")));
    assert_eq!(courier_letter_reply_for(&polished, Some(&json!("silent"))), None);
    let base = courier_letter_reply_base(&polished, Some(&json!("warm")));
    assert!(base.contains("Гость") && base.contains("Ада"));
}

#[test]
fn viewer_does_not_see_sealed_reply() {
    let state = campaign();
    let letter = send(&state, "ally", "Привет.");
    let player = courier_letter_for_viewer(Some(&letter), false).expect("письмо");
    assert!(player.get("tone").is_none() && player.get("reply").is_none());
    assert_eq!(player["status_label"], "В пути");
    let gm = courier_letter_for_viewer(Some(&letter), true).expect("письмо");
    assert_eq!(gm["tone"], "warm");
    assert!(gm.get("reply").is_none());
    let panel = courier_letters_for_viewer(&with_letter(&state, &letter), &json!({}));
    assert_eq!(panel["open_limit"], COURIER_LETTER_OPEN_LIMIT);
    assert_eq!(panel["letters"].as_array().map(Vec::len), Some(1));
    let card = courier_letter_chronicle_entry(&json!({ "event_type": "CourierLetterSent", "payload": { "letter": letter } })).expect("конверт");
    assert_eq!(card["author"], COURIER_LETTER_CARD_TITLE);
    assert_eq!(card["letter"]["from"], "Ада");
    assert_eq!(card["letter"]["to"], "Мельник Гость");
}

// ---------------------------------------------------------------------------
// withCourierReplyDraft
// ---------------------------------------------------------------------------

struct Noop;
impl Wake for Noop {
    fn wake(self: Arc<Self>) {}
}

fn block_on<F: Future>(future: F) -> F::Output {
    let waker = Waker::from(Arc::new(Noop));
    let mut context = Context::from_waker(&waker);
    let mut future = pin!(future);
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
            return value;
        }
    }
}

struct Fake(Result<Value, String>, std::cell::RefCell<Vec<String>>);
impl CourierReplyResponder for Fake {
    async fn respond(&self, request: CourierReplyRequest<'_>) -> Result<Value, String> {
        self.1.borrow_mut().push(format!("{}|{}|{}", request.npc_id, request.turn_id, request.message));
        self.0.clone()
    }
}

#[test]
fn model_polishes_only_words_and_never_blocks_sending() {
    let state = campaign();
    let command = json!({ "command_type": "SendLetter", "actor_id": "hero", "addressee_kind": "npc", "addressee_id": "ally", "body": "Обещаю прийти завтра.", "command_id": "c1" });
    let fake = Fake(Ok(json!({ "reply": "  Приходи,\n друг. ", "provider": "RouterLlmClient" })), Default::default());
    let polished = block_on(with_courier_reply_draft(&state, &command, Some(&fake)));
    assert_eq!(polished["reply_draft"], "Приходи, друг.");
    assert_eq!(polished["reply_draft_tone"], "warm");
    assert_eq!(polished["reply_provider"], "RouterLlmClient");
    assert_eq!(fake.1.borrow()[0], "ally|letter:c1|[письмо, доставлено курьером] Обещаю прийти завтра. [в письме дано слово: Обещаю прийти завтра.]");

    // Модели нет, ошибка, фолбэк разговора, враг и фракция — команда как есть.
    assert_eq!(block_on(with_courier_reply_draft::<Fake>(&state, &command, None)), command);
    assert_eq!(block_on(with_courier_reply_draft(&state, &command, Some(&Fake(Err("сеть".into()), Default::default())))), command);
    let fallback = Fake(Ok(json!({ "reply": "Ну здравствуй.", "provider": "deterministic-social-fallback" })), Default::default());
    assert_eq!(block_on(with_courier_reply_draft(&state, &command, Some(&fallback))), command);
    let mut foe = command.clone();
    foe["addressee_id"] = json!("foe");
    let silent = Fake(Ok(json!({ "reply": "x" })), Default::default());
    assert_eq!(block_on(with_courier_reply_draft(&state, &foe, Some(&silent))), foe);
    assert!(silent.1.borrow().is_empty(), "врагу модель не зовут");
    let mut faction = command.clone();
    faction["addressee_kind"] = json!("faction");
    faction["addressee_id"] = json!("faction-wolves");
    assert_eq!(block_on(with_courier_reply_draft(&state, &faction, Some(&silent))), faction);
    let unnamed = Fake(Ok(json!({ "reply": "Да." })), Default::default());
    assert_eq!(block_on(with_courier_reply_draft(&state, &command, Some(&unnamed)))["reply_provider"], "llm");
}

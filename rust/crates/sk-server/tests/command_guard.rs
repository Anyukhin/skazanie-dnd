//! Смысловые проверки С16: инвариант AGENTS.md §5 «клиентские поля
//! недоверенные (путь, дальность, цель)» и права на героя для санитайзеров
//! `/commands`. JS-сторож `test/tactical-command-guard.test.mjs` проверяет
//! клиентский `src/tactical-command-guard.mjs` (рецензия плана, §8), поэтому
//! здесь — серверный смысл тех же правил на перенесённых функциях; сверка
//! строка в строку — `command_guard_golden.rs`.

use std::cell::Cell;

use serde_json::{json, Value};
use sk_server::command_fingerprints as fp;
use sk_server::command_guard as guard;
use sk_server::command_guard::{Caller, CourierReplyModel, GuardResult, Memberships, ReplyFuture};
use sk_server::error::Failure;

fn state() -> Value {
    json!({
        "sessionCode": "GUARD-1",
        "players": [{ "id": "hero" }, { "id": "mage" }],
        "actors": [
            { "id": "wolf", "kind": "summon", "faction": "party", "ownerId": "hero" },
            { "id": "imp", "kind": "summon", "faction": "hostile", "ownerId": "hero" },
        ],
        "enemies": [{ "id": "goblin" }],
        "social": { "npcs": [{ "id": "innkeeper" }], "relationships": { "innkeeper": { "hero": 60 } } },
    })
}

fn owner() -> Value {
    json!({ "id": "u1", "role": "player", "heroIds": ["hero"] })
}

/// Хранилище, которое считает вопросы о членстве.
struct Counting(Cell<usize>);

impl Memberships for Counting {
    fn campaign_has_memberships(&self, _campaign_id: &str) -> GuardResult<bool> {
        self.0.set(self.0.get() + 1);
        Ok(false)
    }
}

fn code(result: &GuardResult<Value>) -> Option<&str> {
    result.as_ref().err().and_then(|error| error.code.as_deref())
}

#[test]
fn move_keeps_only_target_cell() {
    let user = owner();
    let caller = Caller::new(&user, &false);
    let command = json!({ "command_type": "MoveActor", "actor_id": "hero", "to": { "x": 4, "y": 5, "z": 9 }, "path": [[0, 0], [9, 9]], "distance": 999, "range": 120 });
    let sanitized = guard::sanitize_player_combat_command(&caller, &state(), &command, false).unwrap_or_default();
    assert_eq!(sanitized, json!({ "command_type": "MoveActor", "actor_id": "hero", "server_authoritative": true, "to": { "x": 4, "y": 5 } }));
}

#[test]
fn attack_fields_are_rebuilt_by_server() {
    let user = owner();
    let caller = Caller::new(&user, &false);
    let command = json!({
        "command_type": "MakeAttack", "actor_id": "hero", "target_id": "goblin", "item_id": " sword ", "attack_mode": " Melee ",
        "sneak_attack": "true", "damage": 99, "request_fingerprint": "подделка", "range": 600,
    });
    let sanitized = guard::sanitize_player_combat_command(&caller, &state(), &command, false).unwrap_or_default();
    assert_eq!(sanitized["item_id"], "sword");
    assert_eq!(sanitized["attack_mode"], "melee");
    assert!(sanitized.get("sneak_attack").is_none(), "строка вместо true не включает скрытую атаку");
    assert!(sanitized.get("damage").is_none() && sanitized.get("range").is_none());
    assert_eq!(sanitized["request_fingerprint"], fp::make_attack_command_fingerprint(&sanitized));
}

#[test]
fn player_attack_target_must_be_in_scene() {
    let user = owner();
    let caller = Caller::new(&user, &false);
    let state = state();
    let ghost = json!({ "command_type": "MakeAttack", "actor_id": "hero", "target_id": "нет-такого" });
    assert_eq!(code(&guard::sanitize_player_combat_command(&caller, &state, &ghost, false)), Some("INVALID_ATTACK_TARGET"));
    let npc = json!({ "command_type": "MakeAttack", "actor_id": "hero", "target_id": "innkeeper" });
    assert!(guard::sanitize_player_combat_command(&caller, &state, &npc, false).is_ok(), "нейтральный NPC сцены — тоже цель");
    assert!(guard::sanitize_player_combat_command(&caller, &state, &ghost, true).is_ok(), "повтор атаки сверяется без политики цели");
}

#[test]
fn foreign_hero_and_hostile_summon_are_forbidden() {
    let user = owner();
    let caller = Caller::new(&user, &false);
    let state = state();
    let foreign = json!({ "command_type": "EndTurn", "actor_id": "mage" });
    assert_eq!(code(&guard::sanitize_player_combat_command(&caller, &state, &foreign, false)), Some("ACTOR_FORBIDDEN"));
    let summon = json!({ "command_type": "EndTurn", "actor_id": "wolf" });
    assert!(guard::sanitize_player_combat_command(&caller, &state, &summon, false).is_ok(), "своё призванное существо");
    let hostile = json!({ "command_type": "EndTurn", "actor_id": "imp" });
    assert_eq!(code(&guard::sanitize_player_combat_command(&caller, &state, &hostile, false)), Some("ACTOR_FORBIDDEN"));
    let rest = json!({ "command_type": "StartRest", "actor_id": "mage" });
    assert_eq!(code(&guard::sanitize_player_rest_command(&caller, &state, &rest)), Some("ACTOR_FORBIDDEN"));
}

#[test]
fn membership_decides_without_hero_list() {
    let state = state();
    let stranger = json!({ "id": "u2", "role": "player", "heroIds": ["hero"] });
    let command = json!({ "command_type": "EndTurn", "actor_id": "hero" });
    let forbidden = guard::sanitize_player_combat_command(&Caller::new(&stranger, &true), &state, &command, false);
    assert_eq!(code(&forbidden), Some("ACTOR_FORBIDDEN"), "в кампании с членством нужен свой членский герой");
    let member = json!({ "id": "u3", "role": "player", "heroIds": [], "campaignMemberships": [{ "campaignId": "GUARD-1", "heroIds": ["hero"] }] });
    assert!(guard::sanitize_player_combat_command(&Caller::new(&member, &true), &state, &command, false).is_ok());
    let admin = json!({ "id": "u0", "role": "admin", "heroIds": [] });
    let counting = Counting(Cell::new(0));
    assert!(guard::sanitize_player_combat_command(&Caller::new(&admin, &counting), &state, &command, false).is_ok());
    assert_eq!(counting.0.get(), 0, "администратора хранилище не спрашивают");
}

#[test]
fn whitelists_reject_client_mechanics() {
    let user = owner();
    let caller = Caller::new(&user, &false);
    let state = state();
    let rest = json!({ "command_type": "SpendHitPointDie", "actor_id": "hero", "rest_id": "чужой", "healing": 30 });
    let rejected = guard::sanitize_player_rest_command(&caller, &state, &rest);
    assert_eq!(rejected.as_ref().err().map(|error| error.message.as_str()), Some("Команда отдыха содержит запрещённые поля: rest_id, healing"));
    let letter = json!({ "command_type": "SendLetter", "actor_id": "hero", "addressee_id": "innkeeper", "body": "Привет", "reply_draft": "Я согласен" });
    assert_eq!(code(&guard::sanitize_player_letter_command(&caller, &state, &letter)), Some("COURIER_COMMAND_UNKNOWN_FIELD"));
    let item = json!({ "command_type": "UseItem", "actor_id": "hero", "item_id": "potion", "to": { "x": 1, "y": 2, "z": 3 } });
    assert_eq!(code(&guard::sanitize_player_item_command(&caller, &state, &item)), Some("INVALID_ITEM_POINT"));
    let loot = json!({ "command_type": "LootContainer", "actor_id": "hero", "container_id": "c", "lines": [{ "item_instance_id": "a", "price": 0 }] });
    assert_eq!(code(&guard::sanitize_player_loot_command(&caller, &state, &loot)), Some("LOOT_COMMAND_UNKNOWN_FIELD"));
    let object = json!({ "command_type": "OperateSceneObject", "actor_id": "hero", "prop_id": "barrel", "intent": "topple", "approach": "force" });
    let sanitized = guard::sanitize_player_combat_command(&caller, &state, &object, false).unwrap_or_default();
    assert_eq!((sanitized["intent"].as_str(), sanitized["approach"].as_str()), (Some("inspect"), Some("hand")));
}

#[test]
fn merchant_route_id_wins_and_price_is_dropped() {
    let user = owner();
    let caller = Caller::new(&user, &false);
    let command = json!({ "command_type": "BuyItem", "actor_id": "hero", "merchant_id": "чужой", "stock_id": "axe", "quantity": 2, "price_cp": 1, "expected_state_version": 4 });
    let route = Value::String("smith".into());
    let sanitized = guard::sanitize_merchant_command(&caller, &state(), &command, Some(&route)).unwrap_or_default();
    assert_eq!(sanitized["merchant_id"], "smith");
    assert!(sanitized.get("price_cp").is_none());
    assert_eq!(sanitized["request_fingerprint"], fp::merchant_command_fingerprint(&sanitized));
    let stale = json!({ "command_type": "BuyItem", "actor_id": "hero", "merchant_id": "smith" });
    assert_eq!(code(&guard::sanitize_merchant_command(&caller, &state(), &stale, None)), Some("EXPECTED_STATE_VERSION_REQUIRED"));
}

#[test]
fn attack_replay_authorizes_before_comparing() {
    let user = owner();
    let caller = Caller::new(&user, &false);
    let command = json!({ "command_type": "MakeAttack", "actor_id": "hero", "target_id": "goblin" });
    let sanitized = guard::sanitize_player_combat_command(&caller, &state(), &command, false).unwrap_or_default();
    let commands = [sanitized.clone()];
    let same = json!({ "events": [{ "event_type": "AttackResolved", "payload": { "request_fingerprint": fp::make_attack_command_fingerprint(&sanitized) } }] });
    let other = json!({ "events": [{ "event_type": "AttackResolved", "payload": { "request_fingerprint": "другая атака" } }] });
    let lookup = |duplicate: Value| move |_: &str, _: &str| -> Result<Option<Value>, Failure> { Ok(Some(duplicate.clone())) };
    assert_eq!(fp::assert_make_attack_idempotency(&lookup(same), "C", "k", &commands, None), Ok(true));
    let conflict = fp::assert_make_attack_idempotency(&lookup(other.clone()), "C", "k", &commands, None);
    assert_eq!(conflict.err().and_then(|error| error.code), Some("IDEMPOTENCY_CONFLICT".into()));
    let mut deny = |_: &Value| -> GuardResult<()> { Err(Failure::new("чужой", Some("ACTOR_FORBIDDEN"))) };
    let denied = fp::assert_make_attack_idempotency(&lookup(other), "C", "k", &commands, Some(&mut deny));
    assert_eq!(denied.err().and_then(|error| error.code), Some("ACTOR_FORBIDDEN".into()), "чужой не отличит конфликт от точного ключа");
    let none = |_: &str, _: &str| -> Result<Option<Value>, Failure> { Ok(None) };
    assert_eq!(fp::assert_make_attack_idempotency(&none, "C", "k", &commands, None), Ok(false));
}

#[test]
fn rest_replay_adopts_single_rest_id() {
    let mut command = json!({ "command_type": "CompleteRest", "actor_id": "hero", "server_authoritative": true });
    let expected = fp::rest_command_fingerprint(&json!({ "command_type": "CompleteRest", "actor_id": "hero", "rest_id": "rest-9" }));
    let duplicate = json!({ "events": [{ "event_type": "RestCompleted", "payload": { "rest_id": "rest-9", "request_fingerprint": expected } }] });
    let lookup = move |_: &str, _: &str| -> Result<Option<Value>, Failure> { Ok(Some(duplicate.clone())) };
    assert_eq!(fp::assert_rest_idempotency(&lookup, "C", "k", &mut command), Ok(()));
    assert_eq!(command["rest_id"], "rest-9");
    assert_eq!(command["request_fingerprint"], Value::String(expected));
}

#[test]
fn long_rest_expands_to_time_and_completion() {
    let user = owner();
    let caller = Caller::new(&user, &false);
    let command = guard::sanitize_player_rest_command(&caller, &state(), &json!({ "command_type": "StartRest", "actor_id": "hero", "kind": "long" })).unwrap_or_default();
    let plan = guard::expand_player_rest_command(&command);
    let types: Vec<&str> = plan.iter().filter_map(|step| step["command_type"].as_str()).collect();
    assert_eq!(types, ["StartRest", "AdvanceTime", "CompleteRest"]);
    assert_eq!(plan[1]["amount"], 480);
    assert!(plan.iter().all(|step| step["request_fingerprint"] == command["request_fingerprint"]));
}

struct Model {
    reply: Value,
}

impl CourierReplyModel for Model {
    fn has_model(&self) -> bool {
        true
    }

    fn respond<'a>(&'a self, _input: Value) -> ReplyFuture<'a> {
        let reply = self.reply.clone();
        Box::pin(async move { Ok(Some(reply)) })
    }
}

#[test]
fn courier_draft_comes_only_from_the_model() {
    let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap_or_else(|error| panic!("рантайм: {error}"));
    let state = json!({
        "sessionCode": "C", "players": [{ "id": "hero" }],
        "social": { "npcs": [{ "id": "innkeeper", "name": "Трактирщик" }], "relationships": { "innkeeper": { "hero": 60 } } },
    });
    let letter = json!({ "command_type": "SendLetter", "actor_id": "hero", "addressee_kind": "npc", "addressee_id": "innkeeper", "body": "Привет" });
    let fallback = Model { reply: json!({ "reply": "Здравствуй", "provider": "deterministic-social-fallback" }) };
    assert_eq!(runtime.block_on(guard::with_courier_reply_draft(&fallback, &state, letter.clone())), letter, "фолбэк разговора в письмо не кладётся");
    let model = Model { reply: json!({ "reply": "  Жду   тебя.\n", "provider": "MeteredLLMClient" }) };
    let drafted = runtime.block_on(guard::with_courier_reply_draft(&model, &state, letter.clone()));
    assert_eq!(drafted["reply_draft"], "Жду тебя.");
    assert_eq!(drafted["reply_draft_tone"], "warm");
    assert_eq!(drafted["reply_provider"], "MeteredLLMClient");
}

//! Перенос `test/roll-registry.test.mjs` и проверок реестра из
//! `test/free-action.test.mjs`.

mod common;

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use sk_core::RuleError;
use sk_infra::roll_registry::{RollRegistry, RollRegistryError, RollRegistryOptions};

use common::SharedDice;

fn code(result: Result<impl std::fmt::Debug, RollRegistryError>) -> String {
    match result {
        Ok(value) => panic!("ожидался отказ, получено {value:?}"),
        Err(error) => error.code().map(String::from).unwrap_or_else(|| error.name().to_string()),
    }
}

fn registry(dice: &SharedDice, options: RollRegistryOptions) -> RollRegistry {
    RollRegistry::new(dice.boxed(), options).expect("реестр")
}

fn durable(file: &std::path::Path) -> RollRegistryOptions {
    RollRegistryOptions { storage_file: Some(file.to_path_buf()), ..RollRegistryOptions::default() }
}

fn fixed_now(now: i64) -> Arc<dyn Fn() -> i64 + Send + Sync> {
    Arc::new(move || now)
}

const NONE: Option<&mut dyn FnMut(&Value) -> Result<(), RuleError>> = None;

#[test]
fn issued_roll_cannot_be_cancelled_by_editing_even_after_restart() {
    let directory = tempfile::tempdir().expect("каталог");
    let file = directory.path().join("rolls.json");
    let dice = SharedDice::new(vec![1], "roll");
    let mut first = registry(&dice, durable(&file));
    let check = first.register_check(&json!({ "campaignId": "ROOM", "actorId": "hero" })).expect("карточка");
    let request = json!({ "checkId": check["check_id"], "campaignId": "ROOM", "actorId": "hero" });
    let roll = first.issue(&request).expect("кость");
    assert_eq!(code(first.invalidate_check(&check["check_id"], &request)), "CHECK_ALREADY_ROLLED");
    let mut restarted = registry(&dice, durable(&file));
    assert_eq!(code(restarted.invalidate_check(&check["check_id"], &request)), "CHECK_ALREADY_ROLLED");
    assert_eq!(restarted.issue(&request).expect("та же кость"), roll);
    let consumed = restarted.consume(&roll["roll_id"], &json!({ "campaignId": "ROOM", "actorId": "hero", "idempotencyKey": "resolve" }), NONE).expect("потребление");
    assert_eq!(consumed["roll_id"], roll["roll_id"]);
}

#[test]
fn lost_issue_response_does_not_create_a_new_roll_even_after_restart() {
    let directory = tempfile::tempdir().expect("каталог");
    let file = directory.path().join("rolls.json");
    let dice = SharedDice::new(vec![17], "roll");
    let mut first = registry(&dice, durable(&file));
    let check = first.register_check(&json!({ "campaignId": "ROOM", "actorId": "hero", "context": { "kind": "free_action" } })).expect("карточка");
    let request = json!({ "checkId": check["check_id"], "campaignId": "ROOM", "actorId": "hero" });
    let rolled = first.issue(&request).expect("кость");
    assert_eq!(first.issue(&request).expect("повтор"), rolled);
    let mut reopened = registry(&dice, durable(&file));
    assert_eq!(reopened.issue(&request).expect("после перезапуска"), rolled);
    assert_eq!(code(reopened.issue(&json!({ "checkId": check["check_id"], "campaignId": "ROOM", "actorId": "other" }))), "CHECK_FORBIDDEN");
    let mut reject = |_: &Value| Err(RuleError::new("ROLL_CONTEXT_MISMATCH", "Другая заявка"));
    let refused = reopened.consume(&rolled["roll_id"], &json!({ "campaignId": "ROOM", "actorId": "hero", "idempotencyKey": "wrong" }), Some(&mut reject));
    assert!(refused.expect_err("отказ").to_string().contains("Другая заявка"));
    let consumed = reopened.consume(&rolled["roll_id"], &json!({ "campaignId": "ROOM", "actorId": "hero", "idempotencyKey": "right" }), NONE).expect("потребление");
    assert_eq!(consumed["roll_id"], rolled["roll_id"]);
}

#[test]
fn server_roll_id_cannot_be_forged_transferred_or_reused() {
    let now = Arc::new(AtomicI64::new(1000));
    let clock = Arc::clone(&now);
    let dice = SharedDice::fixed_id(vec![14], "roll-1");
    let mut registry = registry(&dice, RollRegistryOptions { ttl_ms: 100, now: Arc::new(move || clock.load(Ordering::SeqCst)), ..RollRegistryOptions::default() });
    let check = registry.register_check(&json!({ "campaignId": "ROOM", "actorId": "hero", "label": "Атака", "modifier": 4, "difficulty": 15 })).expect("карточка");
    let issued = registry.issue(&json!({ "checkId": check["check_id"], "campaignId": "ROOM", "actorId": "hero" })).expect("кость");
    assert_eq!(issued["total"], 18);
    assert_eq!(issued["success"], true);
    let roll = json!("roll-1");
    assert_eq!(code(registry.consume(&roll, &json!({ "campaignId": "ROOM", "actorId": "other", "idempotencyKey": "turn-1" }), NONE)), "ROLL_FORBIDDEN");
    let turn = json!({ "campaignId": "ROOM", "actorId": "hero", "idempotencyKey": "turn-1" });
    assert_eq!(registry.consume(&roll, &turn, NONE).expect("первый")["total"], 18);
    assert_eq!(registry.consume(&roll, &turn, NONE).expect("повтор")["total"], 18);
    assert_eq!(code(registry.consume(&roll, &json!({ "campaignId": "ROOM", "actorId": "hero", "idempotencyKey": "turn-2" }), NONE)), "ROLL_ALREADY_USED");
    now.store(1200, Ordering::SeqCst);
    assert_eq!(code(registry.consume(&roll, &turn, NONE)), "ROLL_NOT_FOUND");
}

#[test]
fn check_parameters_are_pinned_by_server_check_id() {
    let dice = SharedDice::fixed_id(vec![12], "roll-bound");
    let mut registry = registry(&dice, RollRegistryOptions { check_id_factory: Box::new(|| "check-1".into()), ..RollRegistryOptions::default() });
    registry.register_check(&json!({ "campaignId": "ROOM", "actorId": "hero", "label": "Скрытность", "modifier": 3, "difficulty": 15, "ability": "dex" })).expect("карточка");
    let result = registry
        .issue(&json!({ "checkId": "check-1", "campaignId": "ROOM", "actorId": "hero", "label": "Подмена", "modifier": 99, "difficulty": 1, "ability": "str" }))
        .expect("кость");
    assert_eq!(result["purpose"], "Скрытность");
    assert_eq!(result["modifier"], 3);
    assert_eq!(result["difficulty"], 15);
    assert_eq!(result["ability"], "dex");
    assert_eq!(result["success"], true);
    assert_eq!(registry.issue(&json!({ "checkId": "check-1", "campaignId": "ROOM", "actorId": "hero", "modifier": 99, "difficulty": 1 })).expect("повтор"), result);
}

#[test]
fn issued_and_consumed_roll_survives_process_restart() {
    let directory = tempfile::tempdir().expect("каталог");
    let file = directory.path().join("rolls.json");
    let dice = SharedDice::fixed_id(vec![17], "durable-roll");
    let options = || RollRegistryOptions { storage_file: Some(file.clone()), now: fixed_now(1_000), ..RollRegistryOptions::default() };
    let mut first = registry(&dice, options());
    let check = first.register_check(&json!({ "campaignId": "ROOM", "actorId": "hero", "label": "История", "modifier": 2, "difficulty": 15 })).expect("карточка");
    first.issue(&json!({ "checkId": check["check_id"], "campaignId": "ROOM", "actorId": "hero" })).expect("кость");
    let turn = json!({ "campaignId": "ROOM", "actorId": "hero", "idempotencyKey": "turn-1" });
    first.consume(&json!("durable-roll"), &turn, NONE).expect("потребление");
    let mut reopened = registry(&dice, options());
    assert_eq!(reopened.consume(&json!("durable-roll"), &turn, NONE).expect("повтор")["total"], 19);
    assert_eq!(code(reopened.consume(&json!("durable-roll"), &json!({ "campaignId": "ROOM", "actorId": "hero", "idempotencyKey": "turn-2" }), NONE)), "ROLL_ALREADY_USED");
}

// Аудит PR #131, SEC-01: механическая кость выдаётся только под объявленную
// проверку, а ничейная запись механикой не потребляется.
#[test]
fn roll_without_check_card_is_not_issued() {
    let dice = SharedDice::new(vec![20], "roll");
    let mut registry = registry(&dice, RollRegistryOptions::default());
    for request in [
        json!({ "campaignId": "ROOM", "actorId": "hero" }),
        json!({ "campaignId": "ROOM", "actorId": "hero", "label": "Сила", "modifier": 12, "difficulty": 5 }),
        json!({ "checkId": "", "check_id": null, "campaignId": "ROOM", "actorId": "hero" }),
    ] {
        assert_eq!(code(registry.issue(&request)), "CHECK_REQUIRED");
    }
    assert_eq!(registry.rolls().len(), 0, "отказ не оставляет записи в реестре");
    assert_eq!(code(registry.issue(&json!({ "checkId": "missing", "campaignId": "ROOM", "actorId": "hero" }))), "CHECK_NOT_FOUND");
}

#[test]
fn unbound_record_from_old_durable_file_is_not_consumed() {
    let directory = tempfile::tempdir().expect("каталог");
    let file = directory.path().join("rolls.json");
    let roll = |id: &str, consumed_by: Value| {
        json!([id, {
            "result": { "roll_id": id, "dice": [20], "kept": 20, "modifier": 0, "total": 20, "difficulty": 10, "success": true, "label": "Проверка", "ability": null },
            "campaign_id": "ROOM", "actor_id": "hero", "expires_at": 10_000, "consumed_by": consumed_by,
        }])
    };
    // Записи до исправления: у привязанной кости нет поля `check_id`, связь
    // хранит только карточка (`issued_roll_id`).
    let payload = json!({
        "schema_version": 1,
        "rolls": [roll("generic-roll", Value::Null), roll("generic-used", json!("turn-old")), roll("legacy-bound", Value::Null)],
        "checks": [["legacy-check", {
            "check_id": "legacy-check", "campaign_id": "ROOM", "actor_id": "hero", "label": "Проверка", "modifier": 0, "difficulty": 10,
            "ability": null, "advantage": false, "disadvantage": false, "visibility": "public", "expires_at": 10_000, "issued_roll_id": "legacy-bound",
        }]],
    });
    std::fs::write(&file, payload.to_string()).expect("файл");
    let dice = SharedDice::new(vec![1], "roll");
    let mut registry = registry(&dice, RollRegistryOptions { storage_file: Some(file.clone()), now: fixed_now(1_000), ..RollRegistryOptions::default() });
    let scope = |key: &str| json!({ "campaignId": "ROOM", "actorId": "hero", "idempotencyKey": key });
    assert_eq!(code(registry.consume(&json!("generic-roll"), &scope("turn-1"), NONE)), "ROLL_UNBOUND");
    // Отказ не помечает кость использованной: повтор отвечает тем же отказом.
    assert_eq!(code(registry.consume(&json!("generic-roll"), &scope("turn-1"), NONE)), "ROLL_UNBOUND");
    // Уже потреблённая до исправления запись отдаёт прежний commit только тому
    // же ключу; новое потребление по-прежнему запрещено.
    assert_eq!(registry.consume(&json!("generic-used"), &scope("turn-old"), NONE).expect("прежний")["roll_id"], "generic-used");
    assert_eq!(code(registry.consume(&json!("generic-used"), &scope("turn-2"), NONE)), "ROLL_ALREADY_USED");
    // Привязанная кость того времени по-прежнему исполняет свою проверку.
    assert_eq!(registry.consume(&json!("legacy-bound"), &scope("turn-3"), NONE).expect("привязанная")["roll_id"], "legacy-bound");
}

// Аудит PR #131, SEC-04: `consume` — резерв до исхода commit.
#[test]
fn reservation_without_commit_is_released_and_with_commit_stays() {
    let dice = SharedDice::new(vec![3, 18], "roll");
    let mut registry = registry(&dice, RollRegistryOptions::default());
    let with_key = |key: &str| json!({ "campaignId": "ROOM", "actorId": "hero", "idempotencyKey": key });
    let failed_check = registry.register_check(&json!({ "campaignId": "ROOM", "actorId": "hero", "label": "Атлетика", "modifier": 2, "difficulty": 12 })).expect("карточка");
    let issue_request = json!({ "checkId": failed_check["check_id"], "campaignId": "ROOM", "actorId": "hero" });
    let failed_roll = registry.issue(&issue_request).expect("кость");
    let id = &failed_roll["roll_id"];
    registry.consume(id, &with_key("turn-failed"), NONE).expect("резерв");
    assert_eq!(code(registry.consume(id, &with_key("turn-other"), NONE)), "ROLL_ALREADY_USED");
    assert!(registry.finish_reservation(id, &json!({ "idempotencyKey": "turn-failed", "committed": false })).expect("снятие"));
    // Кость та же — переброса нет; повторно выдаётся она же.
    assert_eq!(registry.issue(&issue_request).expect("та же"), failed_roll);
    assert_eq!(registry.consume(id, &with_key("turn-other"), NONE).expect("другой ключ")["kept"], failed_roll["kept"]);
    registry.finish_reservation(id, &json!({ "idempotencyKey": "turn-other", "committed": true })).expect("закрепление");
    assert_eq!(code(registry.consume(id, &with_key("turn-failed"), NONE)), "ROLL_ALREADY_USED");
    // Тот же ключ после commit по-прежнему получает прежний бросок.
    assert_eq!(registry.consume(id, &with_key("turn-other"), NONE).expect("повтор")["roll_id"], *id);

    // Чужой ключ резерв не снимает.
    let check = registry.register_check(&json!({ "campaignId": "ROOM", "actorId": "hero", "label": "Скрытность", "difficulty": 10 })).expect("карточка");
    let roll = registry.issue(&json!({ "checkId": check["check_id"], "campaignId": "ROOM", "actorId": "hero" })).expect("кость");
    registry.consume(&roll["roll_id"], &with_key("turn-a"), NONE).expect("резерв");
    assert!(!registry.finish_reservation(&roll["roll_id"], &json!({ "idempotencyKey": "turn-b", "committed": false })).expect("чужой"));
    assert_eq!(code(registry.consume(&roll["roll_id"], &with_key("turn-b"), NONE)), "ROLL_ALREADY_USED");
}

#[test]
fn reservation_held_by_another_request_of_same_key_is_kept() {
    let dice = SharedDice::new(vec![11], "roll");
    let mut registry = registry(&dice, RollRegistryOptions::default());
    let check = registry.register_check(&json!({ "campaignId": "ROOM", "actorId": "hero", "label": "Проверка", "difficulty": 10 })).expect("карточка");
    let roll = registry.issue(&json!({ "checkId": check["check_id"], "campaignId": "ROOM", "actorId": "hero" })).expect("кость");
    let id = &roll["roll_id"];
    let key = |key: &str| json!({ "campaignId": "ROOM", "actorId": "hero", "idempotencyKey": key });
    // Два запроса одного ключа (повтор после таймаута клиента) держат резерв.
    registry.consume(id, &key("turn-1"), NONE).expect("первый");
    registry.consume(id, &key("turn-1"), NONE).expect("второй");
    // Первый упал до commit — второй ещё может закоммитить, кость не отпускаем.
    assert!(!registry.finish_reservation(id, &json!({ "idempotencyKey": "turn-1", "committed": false })).expect("первый исход"));
    assert_eq!(code(registry.consume(id, &key("turn-2"), NONE)), "ROLL_ALREADY_USED");
    assert!(registry.finish_reservation(id, &json!({ "idempotencyKey": "turn-1", "committed": false })).expect("второй исход"));
    assert_eq!(registry.consume(id, &key("turn-2"), NONE).expect("снова доступна")["roll_id"], *id);
}

#[test]
fn after_restart_only_reservations_without_commit_are_released() {
    let directory = tempfile::tempdir().expect("каталог");
    let file = directory.path().join("rolls.json");
    let dice = SharedDice::new(vec![5, 15, 9, 12], "orphan-roll");
    let options = || RollRegistryOptions { storage_file: Some(file.clone()), now: fixed_now(1_000), ..RollRegistryOptions::default() };
    let key = |key: &str| json!({ "campaignId": "ROOM", "actorId": "hero", "idempotencyKey": key });
    let mut first = registry(&dice, options());
    let rolls: Vec<Value> = ["crashed", "committed", "unknown", "burned"]
        .iter()
        .map(|name| {
            let check = first.register_check(&json!({ "campaignId": "ROOM", "actorId": "hero", "label": name, "difficulty": 10 })).expect("карточка");
            let roll = first.issue(&json!({ "checkId": check["check_id"], "campaignId": "ROOM", "actorId": "hero" })).expect("кость");
            first.consume(&roll["roll_id"], &key(&format!("turn-{name}")), NONE).expect("резерв");
            roll
        })
        .collect();
    // Запрос завершился без commit по существу: такой исход окончателен.
    first.finish_reservation(&rolls[3]["roll_id"], &json!({ "idempotencyKey": "turn-burned", "committed": true })).expect("закрепление");
    // Процесс остановился между consume и исходом остальных: держатели не сняты.
    let mut restarted = registry(&dice, options());
    let released = restarted
        .release_orphan_reservations(|campaign, key| {
            assert_eq!(campaign, "ROOM");
            if key == "turn-unknown" {
                return Err("журнал не прочитан");
            }
            Ok(key == "turn-committed")
        })
        .expect("сверка");
    assert_eq!(released, vec![rolls[0]["roll_id"].as_str().expect("id").to_string()]);
    assert_eq!(restarted.consume(&rolls[0]["roll_id"], &key("turn-retry"), NONE).expect("снова")["kept"], rolls[0]["kept"]);
    for kept in &rolls[1..] {
        assert_eq!(code(restarted.consume(&kept["roll_id"], &key("turn-retry"), NONE)), "ROLL_ALREADY_USED");
    }
    // Закреплённый по журналу резерв повторной сверки не требует, неизвестный — ждёт её.
    assert_eq!(restarted.rolls()[rolls[1]["roll_id"].as_str().expect("id")].get("commit_pending"), None);
    assert_eq!(restarted.rolls()[rolls[2]["roll_id"].as_str().expect("id")]["commit_pending"], true);
    // Новое потребление записано на диск: прежний ключ его не перехватит.
    let mut again = registry(&dice, options());
    assert_eq!(code(again.consume(&rolls[0]["roll_id"], &key("turn-crashed"), NONE)), "ROLL_ALREADY_USED");
}

// test/free-action.test.mjs: контекст карточки возвращается серверу только по
// явной просьбе, а открытая проверка свободного действия видна по версии.
#[test]
fn context_is_hidden_from_player_and_returned_on_request() {
    let dice = SharedDice::new(vec![18], "roll");
    let mut registry = registry(&dice, RollRegistryOptions::default());
    let context = json!({ "kind": "free_action", "action": "Прыгаю", "state_version": 3, "proposal_id": "p-1", "proposal": { "dc": 12 }, "reading": { "skill": "athletics" } });
    let check = registry.register_check(&json!({ "campaignId": "ROOM", "actorId": "hero", "label": "Прыжок", "modifier": 2, "difficulty": 12, "context": context })).expect("карточка");
    assert_eq!(check.get("context"), None, "игрок контекст не видит");
    let scope = json!({ "campaignId": "ROOM", "actorId": "hero" });
    assert_eq!(registry.get_check(&check["check_id"], &scope).expect("карточка").get("context"), None);
    let with_context = registry.get_check(&check["check_id"], &json!({ "campaignId": "ROOM", "actorId": "hero", "includeContext": true })).expect("с контекстом");
    assert_eq!(with_context["context"], context);
    assert!(registry.has_open_check(&json!({ "campaignId": "ROOM", "stateVersion": 3 })).expect("открыта"));
    assert!(!registry.has_open_check(&json!({ "campaignId": "ROOM", "stateVersion": 4 })).expect("другая версия"));
    let pending = registry.pending_narration_check(&json!({ "campaignId": "ROOM", "actorId": "hero", "stateVersion": 3 })).expect("ожидание").expect("карточка");
    assert_eq!(pending["skill"], "athletics");
    assert_eq!(pending["sides"], 20);
    assert_eq!(pending["proposal"], json!({ "dc": 12 }));
    // Отмена по proposal_id закрывает карточку.
    assert!(registry.invalidate_proposal(&json!("p-1"), &scope).expect("отмена"));
    assert_eq!(code(registry.get_check(&check["check_id"], &scope)), "CHECK_INVALIDATED");
    assert!(!registry.has_open_check(&json!({ "campaignId": "ROOM", "stateVersion": 3 })).expect("закрыта"));
}

#[test]
fn corrupt_durable_file_is_refused() {
    let directory = tempfile::tempdir().expect("каталог");
    let file = directory.path().join("rolls.json");
    let dice = SharedDice::new(vec![1], "roll");
    std::fs::write(&file, "{ broken").expect("файл");
    let error = RollRegistry::new(dice.boxed(), durable(&file)).err().expect("отказ");
    assert_eq!(error.code(), Some("ROLL_REGISTRY_CORRUPT"));
    assert!(error.to_string().starts_with("Повреждено durable-хранилище бросков: "));
    std::fs::write(&file, r#"{"schema_version":2,"rolls":[],"checks":[]}"#).expect("файл");
    let error = RollRegistry::new(dice.boxed(), durable(&file)).err().expect("отказ");
    assert_eq!(error.to_string(), "Некорректная схема durable-хранилища бросков");
}

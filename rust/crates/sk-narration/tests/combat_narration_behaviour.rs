//! Проверки самого модуля из `test/combat-narration.test.mjs` (без UI-контрактов
//! клиента). Полный набор входов тех тестов сверяется с JS в
//! `combat_narration_fixtures.rs` — здесь закреплены формулировки, ради которых
//! тесты JS писались, и найденные при переносе странности исходника.

use serde_json::{json, Value};
use sk_narration::combat_narration::*;
use sk_narration_base::deterministic_narration::{assert_narrator_contract, DeterministicNarrator};

fn state() -> Value {
    json!({
        "players": [{ "id": "hero", "character": "Лира", "hp": 24, "maxHp": 24 }],
        "enemies": [{ "id": "wolf", "name": "Волк", "hp": 20, "maxHp": 20 }],
        "actors": [],
    })
}

fn party() -> Value {
    json!({
        "partyMemberIds": ["hero", "ally"],
        "players": [{ "id": "hero", "character": "Лира", "hp": 9 }, { "id": "ally", "character": "Бор", "hp": 6 }],
        "enemies": [{ "id": "wolf", "name": "Волк", "hp": 0 }],
        "actors": [],
        "mechanics": { "death": { "heroes": {} } },
    })
}

fn event(kind: &str, payload: Value, targets: &[&str]) -> Value {
    json!({ "event_type": kind, "actor_id": "hero", "target_ids": targets, "payload": payload })
}

fn narrate(events: &[Value], state: &Value) -> String {
    combat_narration(events, state, None).expect("JS не бросает на этом входе")
}

#[test]
fn narrator_follows_the_common_contract_but_stays_unregistered() {
    assert_narrator_contract(&CombatNarrator).expect("контракт");
    assert_eq!(CombatNarrator.id(), "combat");
    assert_eq!(CombatNarrator.prompt_version(), "combat-narrator/v2");
    assert_eq!(CombatNarrator.provider(), "deterministic-combat");
    assert_eq!(CombatNarrator.priority(), 40.0);
    assert!(COMBAT_NARRATION_EVENT_TYPES.len() >= 30);
    assert!(has_combat_narration_event(&[event("AttackResolved", json!({}), &[])]));
    assert!(!has_combat_narration_event(&[event("MerchantPurchaseCompleted", json!({}), &[])]));
    assert!(!has_combat_narration_event(&[]));
    assert_eq!(CombatNarrator.narrate(&[], &state()), None);
}

#[test]
fn monster_hit_condition_and_break_free_outcome() {
    let webbed = narrate(
        &[
            json!({ "event_type": "AttackResolved", "actor_id": "wolf", "target_ids": ["hero"], "payload": { "target_id": "hero", "total": 14, "armor_class": 12, "hit": true, "action_id": "web" } }),
            json!({ "event_type": "ConditionAdded", "actor_id": "wolf", "target_ids": ["hero"], "payload": { "condition": "restrained", "action_id": "web", "escape_dc": 12 } }),
            json!({ "event_type": "ConditionAdded", "actor_id": "wolf", "target_ids": ["wolf"], "payload": { "condition": "monster-action-used:web" } }),
        ],
        &state(),
    );
    assert!(webbed.contains("Лира — состояние «Опутанный»"), "{webbed}");
    assert!(!webbed.contains("monster-action-used"));
    let freed = narrate(&[event("CombatActionUsed", json!({ "action_id": "break-free", "name": "Высвободиться", "action_type": "action", "success": true }), &[])], &state());
    assert!(freed.contains("Лира вырывается"), "{freed}");
}

#[test]
fn enemy_numbers_stay_closed() {
    let text = narrate(
        &[
            event("AttackResolved", json!({ "target_id": "wolf", "total": 22, "armor_class": 19, "hit": true }), &["wolf"]),
            event("DamageApplied", json!({ "target_id": "wolf", "applied_amount": 7, "hp_before": 20, "hp_after": 13 }), &["wolf"]),
        ],
        &state(),
    );
    assert!(text.contains("Волк") && text.contains("7 урона"), "{text}");
    assert!(!text.contains("19") && !text.contains("→"), "{text}");
    let healed = narrate(&[event("HealingApplied", json!({ "applied_amount": 9, "hp_before": 2, "hp_after": 11 }), &["hero"])], &state());
    assert_eq!(healed, "Лира восстанавливает 9 ОЗ; ОЗ 2 → 11.");
    assert_eq!(narrate(&[event("HealingApplied", json!({ "applied_amount": 5 }), &["wolf"])], &state()), "Волк восстанавливает силы.");
}

#[test]
fn encounter_end_is_named_in_russian() {
    let text = |value: Value| encounter_end_text(Some(&value));
    assert_eq!(text(json!("enemies_defeated")), "противники повержены");
    assert_eq!(text(json!("party_defeated")), "отряд пал");
    assert_eq!(encounter_end_text(None), "исход подтверждён");
    assert_eq!(text(json!("some_new_code")), "исход подтверждён");
    assert_eq!(text(json!("стража разняла драку")), "стража разняла драку");
    // `Object.hasOwn`: ключ прототипа — незнакомый код.
    assert_eq!(text(json!("constructor")), "исход подтверждён");
    let ended = narrate(&[json!({ "event_type": "EncounterEnded", "payload": { "reason": "enemies_defeated", "outcome": "enemies_defeated" } })], &json!({}));
    assert!(["Столкновение завершено", "Бой стихает", "Всё кончено"].iter().any(|head| ended.starts_with(&format!("{head}: противники повержены."))), "{ended}");
    assert!(!ended.contains("привал"), "привал после победы отключён: {ended}");
}

#[test]
fn post_defeat_recovery_and_rewards() {
    let defeat = narrate(
        &[json!({ "event_type": "DowntimeResolved", "actor_id": null, "target_ids": ["ally", "hero"], "payload": {
            "kind": "long_rest", "duration_minutes": 720, "participant_ids": ["ally", "hero"], "reason": "post_defeat_recovery",
        } })],
        &party(),
    );
    assert_eq!(defeat, "Отряд приходит в себя после поражения: противники ушли, герои отдыхают 12 часов и восстанавливают силы.");
    let reward = narrate(
        &[json!({ "event_type": "EncounterRewardsDistributed", "actor_id": null, "target_ids": ["hero", "ally"], "payload": {
            "allocations": [
                { "recipient_id": "hero", "xp": 25, "coins_cp": 105, "items": [{ "name": "Короткий лук", "quantity": 1 }, { "name": "Стрелы, 20 штук", "quantity": 1 }] },
                { "recipient_id": "ally", "xp": 25, "coins_cp": 104, "items": [{ "name": "Кинжал", "quantity": 1 }, { "name": "Кинжал", "quantity": 1 }] },
            ],
            "unassigned": { "xp": 0, "coins_cp": 0, "items": [] },
        } })],
        &party(),
    );
    assert!(
        reward.ends_with(": Лира забирает «Короткий лук» и «Стрелы, 20 штук»; Бор — «Кинжал» (2 шт.); в кошелях набралось 2 золотых и 9 медяков — на всех поровну; опыта — по 25 каждому."),
        "{reward}"
    );
    let empty = narrate(&[json!({ "event_type": "EncounterRewardsDistributed", "payload": { "allocations": [{ "recipient_id": "hero", "xp": 0, "coins_cp": 0, "items": [] }] } })], &party());
    assert_eq!(empty, "");
}

#[test]
fn sky_line_is_appended_after_fallback() {
    let events = [json!({ "event_type": "TimeOfDayChanged", "payload": { "phase_after": "evening" } })];
    let text = tactical_narration_or(&events, &json!({}), |filtered| format!("Запасной: {}", filtered.len()), None).expect("без исключения");
    assert!(text.starts_with("Запасной: 0 "), "небо не попадает к запасному рассказчику: {text}");
    assert_eq!(combat_journal_voice(&events, &json!({})).author, "Рассказчик");
    assert_eq!(combat_journal_voice(&[event("AttackResolved", json!({}), &[])], &json!({})).speaker, "system");
}

/// Замечено в JS: `null` среди событий или героев, строка вместо списка
/// укрытий — `TypeError` в `tacticalNarrationLines`; перенос возвращает ошибку.
#[test]
fn js_type_errors_on_garbage_are_errors() {
    assert!(combat_narration(&[Value::Null], &state(), None).is_err());
    assert!(combat_narration(&[event("TurnEnded", json!({}), &[])], &json!({ "players": [null] }), None).is_err());
    assert!(combat_narration(&[event("TurnEnded", json!({}), &[])], &json!({ "enemies": "волк" }), None).is_err());
    assert!(combat_narration(&[event("AttackResolved", json!({ "cover": true, "cover_blockers": "wolf" }), &["wolf"])], &state(), None).is_err());
    // Ключ прототипа как вид урона — незнакомый вид: глагол по умолчанию…
    assert!(combat_narration(&[event("AttackResolved", json!({ "hit": true, "damage_type": "constructor" }), &["wolf"])], &state(), None).is_ok());
    // …и общая подпись в строке иммунитета.
    let immune = narrate(&[event("DamageApplied", json!({ "immune": true, "raw_amount": 3, "damage_type": "constructor" }), &["wolf"])], &state());
    assert_eq!(immune, "Этот урон не действует на Волк.");
}

/// Запись состояния без стороны не печатает `undefined` в причине преимущества.
#[test]
fn condition_entry_without_side_does_not_print_undefined() {
    let malformed = narrate(&[event("AttackResolved", json!({ "target_id": "wolf", "total": 18, "armor_class": 12, "hit": true, "condition_advantage": ["prone"] }), &["wolf"])], &state());
    assert!(!malformed.contains("undefined"), "{malformed}");
    assert!(!malformed.contains("с преимуществом ()"), "{malformed}");
    let mixed = narrate(&[event("AttackResolved", json!({ "target_id": "wolf", "total": 18, "armor_class": 12, "hit": true, "condition_advantage": ["prone", "target:prone"] }), &["wolf"])], &state());
    assert!(mixed.contains("с преимуществом (цель "), "{mixed}");
    assert!(!mixed.contains("undefined"), "{mixed}");
}

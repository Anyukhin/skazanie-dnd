//! Редьюсер событий — перенос `applyGameEventCurrent` (`rules-engine.mjs`,
//! 24200–27105). Задача Р0 (диспетчер и общие шаги).
//!
//! Событие применяется к состоянию той же JSON-формы, что в JS. Порядок, как в
//! JS: замена состояния (`LegacyStateImported`, `CampaignRewound`) до
//! `switch`; ветка события по таблице меток (`table.rs`, 190 меток); общие
//! шаги — память карты сцены, реестры-выводы из журнала (`registries.rs`),
//! версия состояния и тактический ход.
//!
//! Нормализацию состояния перед веткой (`normalizeCampaignState`) делает
//! `replay::apply_game_event` (Р4); здесь состояние уже нормализовано.
//!
//! Владельцы файлов: перенесённые ранее ветки (`vitals`, `conditions`,
//! `combat`, `turns`, `spells`, `effects`, `memory`) — Р0; `scene`, `items`,
//! `world`, `social`, `character`, `registries` — Р4; `merchants` — Р6.
//! Неперенесённая ветка возвращает `UNPORTED` и состояние не меняет.

mod character;
mod combat;
mod conditions;
mod effects;
mod items;
mod memory;
mod merchants;
mod registries;
mod scene;
mod social;
mod spells;
mod table;
mod turns;
mod vitals;
mod world;

use std::collections::HashMap;
use std::sync::LazyLock;

use serde_json::Value;
use sk_core::js::safe_int;
use sk_core::{Event, RuleError};

/// Итог ветки: `UNPORTED`, если ветка ещё не перенесена.
pub type Reduced = Result<(), RuleError>;

/// Ветка события.
pub(crate) type Handler = fn(&mut Value, &Event) -> Reduced;

static HANDLERS: LazyLock<HashMap<&'static str, Handler>> = LazyLock::new(|| table::BRANCHES.iter().copied().collect());

fn handler(event_type: &str) -> Option<Handler> {
    HANDLERS.get(event_type).copied()
}

/// Метки `switch` JS в порядке `case` (190).
pub fn js_reducer_labels() -> impl Iterator<Item = &'static str> {
    table::BRANCHES.iter().map(|(label, _)| *label)
}

/// Типы событий, чьи ветки ещё не перенесены (метки `switch` и замена
/// состояния до него).
pub fn unported_event_types() -> impl Iterator<Item = &'static str> {
    [scene::UNPORTED, items::UNPORTED, world::UNPORTED, social::UNPORTED, character::UNPORTED, merchants::UNPORTED].into_iter().flatten().copied()
}

/// Шаги реестров после `switch`, которые ещё не перенесены.
pub fn unported_registries() -> &'static [&'static str] {
    registries::UNPORTED
}

/// Перенесено ли событие этого типа. Тип без своей ветки JS применяет только
/// общими шагами — он перенесён по построению.
pub fn is_ported(event_type: &str) -> bool {
    !unported_event_types().any(|kind| kind == event_type)
}

/// Применить событие: ветка типа и общие шаги после неё. Неперенесённая ветка
/// пропускается (как раньше), общие шаги идут всегда.
pub fn apply_event(state: &mut Value, event: &Event) {
    let _ = apply_event_checked(state, event);
}

/// То же, но сообщает, что ветка события ещё не перенесена (`UNPORTED`).
/// Ошибки неперенесённых реестров не сообщаются: шаги реестров идут на
/// каждом событии.
pub fn apply_event_checked(state: &mut Value, event: &Event) -> Reduced {
    if let Some(replaced) = world::replace_state(state, event) {
        return replaced;
    }
    let branch = match handler(&event.event_type) {
        Some(apply) => apply(state, event),
        None => Ok(()),
    };
    crate::scene_maps::remember_current_scene_map(state);
    let event_json = serde_json::to_value(event).unwrap_or(Value::Null);
    let _ = registries::apply_registries(state, &event_json);
    let next_version = event
        .extra
        .get("state_version_after")
        .filter(|value| sk_core::js::is_safe_integer(Some(value)))
        .map(|value| safe_int(Some(value), 0))
        .unwrap_or_else(|| sk_core::game::state_version(state) + 1);
    state["state_version"] = Value::from(next_version);
    synchronize_tactical_turn(state);
    branch
}

/// `synchronizeTacticalTurn(state)` (24097–24112).
fn synchronize_tactical_turn(state: &mut Value) {
    let combat = sk_core::game::combat(state);
    let initiative = combat.get("initiative").and_then(Value::as_array).cloned().unwrap_or_default();
    let raw_index = combat.get("active_index").cloned().unwrap_or(Value::Null);
    let active_index = safe_int(Some(&raw_index), -1);
    if !sk_core::js::truthy(combat.get("active")) || initiative.is_empty() || active_index < 0 {
        return;
    }
    let active_id = sk_core::js::s(initiative.get(active_index as usize).and_then(|entry| entry.get("actor_id")));
    if active_id.is_empty() {
        return;
    }
    let round = combat.get("round").cloned();
    let economy = crate::turn_economy::economy_of(state, &active_id);
    let scene_turn = crate::core::safe_integer_or(state.get("scene").and_then(|scene| scene.get("turn")), round.as_ref());
    state["activePlayerId"] = Value::String(active_id.clone());
    let mut turn = serde_json::Map::new();
    turn.insert("sceneTurn".into(), scene_turn);
    turn.insert("actorId".into(), Value::String(active_id));
    turn.insert("movementSpent".into(), Value::from(safe_int(economy.get("movement_spent"), 0).max(0)));
    turn.insert("actionUsed".into(), Value::Bool(economy.get("action") == Some(&Value::Bool(false))));
    if let Some(round) = round {
        turn.insert("round".into(), round);
    }
    turn.insert("activeIndex".into(), raw_index);
    state["tacticalTurn"] = Value::Object(turn);
}

/// Выбросить производные поля героя — как делает запись корпуса.
pub fn strip_derived(state: &mut Value) {
    if let Some(players) = state.get_mut("players").and_then(Value::as_array_mut) {
        for player in players {
            if let Some(map) = player.as_object_mut() {
                for field in ["combatSpells", "combatActions", "characterSheet", "inventoryLoad"] {
                    map.shift_remove(field);
                }
            }
        }
    }
}

/// Общие поля записи боевого журнала: ход сцены и раунд.
pub(crate) fn scene_turn_and_round(state: &Value) -> (i64, Value) {
    let round = sk_core::game::combat(state).get("round").cloned().unwrap_or(Value::Null);
    let scene_turn = safe_int(state.get("scene").and_then(|scene| scene.get("turn")), safe_int(Some(&round), 0));
    (scene_turn, round)
}

/// Цель события: первая из `target_ids`, иначе действующее лицо
/// (`uniqueStrings(event.target_ids)[0] ?? event.actor_id`).
pub(crate) fn target_of(event: &Event) -> String {
    let unique = crate::core::unique_string_list(&event.target_ids);
    unique.into_iter().next().unwrap_or_else(|| event.actor_id.clone().unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_has_every_js_label_once() {
        let labels: Vec<&str> = js_reducer_labels().collect();
        assert_eq!(labels.len(), 190);
        let unique: std::collections::HashSet<&str> = labels.iter().copied().collect();
        assert_eq!(unique.len(), labels.len(), "метки не повторяются");
        assert!(labels.contains(&"MerchantEconomyClockAdvanced"));
        for kind in unported_event_types() {
            assert!(labels.contains(&kind) || matches!(kind, "LegacyStateImported" | "CampaignRewound"), "{kind} — метка JS");
        }
    }

    #[test]
    fn stubs_answer_unported_and_ported_branches_do_not() {
        let state: Value = serde_json::json!({
            "players": [], "actors": [], "enemies": [], "state_version": 0, "battleLog": [], "mapFeedback": [], "economyLog": [],
            "scene": { "turn": 0 }, "mechanics": { "combat": { "active": false, "round": 0, "initiative": [], "active_index": -1, "action_economy": {} },
                "conditions": {}, "resources": {}, "death": { "heroes": {}, "saving_throws": {} }, "concentration": {}, "positions": {} },
        });
        let unported: Vec<&str> = unported_event_types().collect();
        for (label, apply) in table::BRANCHES {
            let mut copy = state.clone();
            let event = Event { event_type: label.to_string(), payload: serde_json::json!({}), ..Event::default() };
            let result = apply(&mut copy, &event);
            let stub = matches!(&result, Err(error) if error.code == crate::pause::UNPORTED);
            assert_eq!(stub, unported.contains(label), "{label}: заглушка ⇔ метка в UNPORTED");
            assert_eq!(is_ported(label), !stub, "{label}");
        }
    }
}

//! Реестры-выводы из журнала — шаги после `switch` в `applyGameEventCurrent`
//! (`rules-engine.mjs`, 27068–27099). Задача Р4.
//!
//! Порядок — контракт replay: летопись поступков, закон (читает готовую
//! летопись), таверна, благословения, мир за кадром, почта, пленные (после
//! летописи), внимание противника, рыцарь, разговоры, звери, автономия.
//! Закон, внимание, таверна, благословения и звери перенесены (крейты
//! `sk-society`, `sk-attention`, `sk-npc-world`); остальные шаги — заглушки,
//! пока нет их модулей. Перенося шаг, уберите его имя из [`UNPORTED`].

use serde_json::Value;

use super::Reduced;
use crate::pause::unported;

/// Шаги реестров, которые ещё не перенесены.
pub(super) const UNPORTED: &[&str] = &[
    "world_deeds",
    "offscreen_world",
    "courier_letters",
    "captives",
    "scenario_knight",
    "dialogues",
    "autonomy",
];

/// Все шаги по порядку. Заглушка (`UNPORTED`) не меняет состояния и не мешает
/// следующим шагам; отказ перенесённого шага (там, где JS бросает) обрывает
/// цепочку, как исключение обрывает `applyGameEvent`.
///
/// `Ok` — все перенесённые шаги прошли; `Err(UNPORTED)` — первый
/// неперенесённый шаг; иное `Err` — отказ шага, дальше событие не идёт.
pub(super) fn apply_registries(state: &mut Value, event: &Value) -> Reduced {
    let steps: [fn(&mut Value, &Value) -> Reduced; 12] =
        [world_deeds, law, tavern, blessings, offscreen_world, courier_letters, captives, scenario_attention, scenario_knight, dialogues, beasts, autonomy];
    let mut first = Ok(());
    for step in steps {
        match step(state, event) {
            Ok(()) => {}
            Err(error) if error.code == crate::pause::UNPORTED => {
                if first.is_ok() {
                    first = Err(error);
                }
            }
            Err(error) => return Err(error),
        }
    }
    first
}

/// `state.world_deeds = applyWorldDeedEvent(state.world_deeds, event, state)` (27068).
fn world_deeds(_state: &mut Value, _event: &Value) -> Reduced {
    Err(unported("registry:world_deeds"))
}

/// `state.law = applyLawEvent(state.law, event, state)` (27073).
fn law(state: &mut Value, event: &Value) -> Reduced {
    let law = sk_society::law_and_order::apply_law_event(state.get("law"), event, state);
    state["law"] = law;
    Ok(())
}

/// `state.tavern = applyTavernEvent(state.tavern, event, state)` (27076).
fn tavern(state: &mut Value, event: &Value) -> Reduced {
    let tavern = sk_npc_world::tavern_life::apply_tavern_event(state.get("tavern"), event, state);
    state["tavern"] = tavern;
    Ok(())
}

/// `state.blessings = applyBlessingEvent(state.blessings, event, state)` (27079).
fn blessings(state: &mut Value, event: &Value) -> Reduced {
    let blessings = sk_npc_world::blessings::apply_blessing_event(state.get("blessings"), event, state);
    state["blessings"] = blessings;
    Ok(())
}

/// `state.offscreen_world = applyOffscreenWorldEvent(state.offscreen_world, event)` (27083).
fn offscreen_world(_state: &mut Value, _event: &Value) -> Reduced {
    Err(unported("registry:offscreen_world"))
}

/// `state.courier_letters = applyCourierLetterEvent(state.courier_letters, event)` (27087).
fn courier_letters(_state: &mut Value, _event: &Value) -> Reduced {
    Err(unported("registry:courier_letters"))
}

/// `state.captives = applyCaptiveEvent(state.captives, event, state)` (27088).
fn captives(_state: &mut Value, _event: &Value) -> Reduced {
    Err(unported("registry:captives"))
}

/// `state.scenario_attention = applyScenarioAttentionEvent(…)` (27091).
fn scenario_attention(state: &mut Value, event: &Value) -> Reduced {
    let attention = sk_attention::scenario_attention::apply_scenario_attention_event(state.get("scenario_attention"), Some(event), state);
    state["scenario_attention"] = attention;
    Ok(())
}

/// `state.scenario_knight = applyScenarioKnightEvent(…)` (27092).
fn scenario_knight(_state: &mut Value, _event: &Value) -> Reduced {
    Err(unported("registry:scenario_knight"))
}

/// `state.dialogues = applyDialogueEvent(state.dialogues, event)` (27094).
fn dialogues(_state: &mut Value, _event: &Value) -> Reduced {
    Err(unported("registry:dialogues"))
}

/// `state.beasts = applyBeastEvent(state.beasts, event, state)` (27098).
///
/// `BeastEncountered` с `payload.beast: null` в JS роняет редьюсер
/// (`safeBeast(null)` читает `null.id`, значение по умолчанию работает только
/// для `undefined`); крейт такую запись молча пропускает, поэтому отказ
/// повторён здесь.
fn beasts(state: &mut Value, event: &Value) -> Reduced {
    let payload = event.get("payload").filter(|payload| !payload.is_null());
    if event.get("event_type").and_then(Value::as_str) == Some("BeastEncountered") && payload.and_then(|payload| payload.get("beast")).is_some_and(Value::is_null) {
        return Err(super::world::type_error("Cannot read properties of null (reading 'id')"));
    }
    let beasts = sk_npc_world::beast_taming::apply_beast_event(state.get("beasts"), event, state);
    state["beasts"] = beasts;
    Ok(())
}

/// `state.autonomy = applyAutonomyEvent(state.autonomy, event)` (27099).
fn autonomy(_state: &mut Value, _event: &Value) -> Reduced {
    Err(unported("registry:autonomy"))
}

//! Реестры-выводы из журнала — шаги после `switch` в `applyGameEventCurrent`
//! (`rules-engine.mjs`, 27068–27099). Задача Р4.
//!
//! Порядок — контракт replay: летопись поступков, закон (читает готовую
//! летопись), таверна, благословения, мир за кадром, почта, пленные (после
//! летописи), внимание противника, рыцарь, разговоры, звери, автономия.
//! Закон и внимание перенесены (крейты `sk-society`, `sk-attention`);
//! остальные шаги — заглушки, пока нет их модулей. Перенося шаг, уберите его
//! имя из [`UNPORTED`].

use serde_json::Value;

use super::Reduced;
use crate::pause::unported;

/// Шаги реестров, которые ещё не перенесены.
pub(super) const UNPORTED: &[&str] = &[
    "world_deeds",
    "tavern",
    "blessings",
    "offscreen_world",
    "courier_letters",
    "captives",
    "scenario_knight",
    "dialogues",
    "beasts",
    "autonomy",
];

/// Все шаги по порядку; ошибка шага не мешает следующим (заглушка не меняет
/// состояния). Возвращает первый неперенесённый шаг.
pub(super) fn apply_registries(state: &mut Value, event: &Value) -> Reduced {
    let steps: [fn(&mut Value, &Value) -> Reduced; 12] =
        [world_deeds, law, tavern, blessings, offscreen_world, courier_letters, captives, scenario_attention, scenario_knight, dialogues, beasts, autonomy];
    let mut first = Ok(());
    for step in steps {
        if let Err(error) = step(state, event) {
            if first.is_ok() {
                first = Err(error);
            }
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
fn tavern(_state: &mut Value, _event: &Value) -> Reduced {
    Err(unported("registry:tavern"))
}

/// `state.blessings = applyBlessingEvent(state.blessings, event, state)` (27079).
fn blessings(_state: &mut Value, _event: &Value) -> Reduced {
    Err(unported("registry:blessings"))
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
fn beasts(_state: &mut Value, _event: &Value) -> Reduced {
    Err(unported("registry:beasts"))
}

/// `state.autonomy = applyAutonomyEvent(state.autonomy, event)` (27099).
fn autonomy(_state: &mut Value, _event: &Value) -> Reduced {
    Err(unported("registry:autonomy"))
}

//! Реестры-выводы из журнала — шаги после `switch` в `applyGameEventCurrent`
//! (`rules-engine.mjs`, 27058–27103). Задача Р4.
//!
//! Порядок — контракт replay: летопись поступков, закон (читает готовую
//! летопись), таверна, благословения, мир за кадром, почта, пленные (после
//! летописи), внимание противника, рыцарь, разговоры, звери, автономия.
//! Модули: летопись — `sk-world-time`; закон — `sk-society`; таверна,
//! благословения, звери — `sk-npc-world`; почта, пленные — `sk-world-life`;
//! мир за кадром, рыцарь, автономия — `sk-world-story`; внимание —
//! `sk-attention`; разговоры — `sk-story`. Перенесены все шаги.

use serde_json::Value;

use super::Reduced;

/// Шаги реестров, которые ещё не перенесены.
pub(super) const UNPORTED: &[&str] = &[];

/// Все шаги по порядку. Отказ шага (там, где JS бросает) обрывает цепочку,
/// как исключение обрывает `applyGameEvent`.
pub(super) fn apply_registries(state: &mut Value, event: &Value) -> Reduced {
    let steps: [fn(&mut Value, &Value) -> Reduced; 12] =
        [world_deeds, law, tavern, blessings, offscreen_world, courier_letters, captives, scenario_attention, scenario_knight, dialogues, beasts, autonomy];
    for step in steps {
        step(state, event)?;
    }
    Ok(())
}

/// `state.world_deeds = applyWorldDeedEvent(state.world_deeds, event, state)` (27068).
fn world_deeds(state: &mut Value, event: &Value) -> Reduced {
    let deeds = sk_world_time::world_deeds::apply_world_deed_event(state.get("world_deeds"), event, state);
    state["world_deeds"] = deeds;
    Ok(())
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
fn offscreen_world(state: &mut Value, event: &Value) -> Reduced {
    state["offscreen_world"] = sk_world_story::offscreen_world::apply_offscreen_world_event(state.get("offscreen_world"), Some(event));
    Ok(())
}

/// `state.courier_letters = applyCourierLetterEvent(state.courier_letters, event)` (27087).
fn courier_letters(state: &mut Value, event: &Value) -> Reduced {
    state["courier_letters"] = sk_world_life::courier_letters::apply_courier_letter_event(state.get("courier_letters"), event);
    Ok(())
}

/// `state.captives = applyCaptiveEvent(state.captives, event, state)` (27088).
fn captives(state: &mut Value, event: &Value) -> Reduced {
    let captives = sk_world_life::captives::apply_captive_event(state.get("captives"), event, state);
    state["captives"] = captives;
    Ok(())
}

/// `state.scenario_attention = applyScenarioAttentionEvent(…)` (27091).
fn scenario_attention(state: &mut Value, event: &Value) -> Reduced {
    let attention = sk_attention::scenario_attention::apply_scenario_attention_event(state.get("scenario_attention"), Some(event), state);
    state["scenario_attention"] = attention;
    Ok(())
}

/// `state.scenario_knight = applyScenarioKnightEvent(…)` (27092).
fn scenario_knight(state: &mut Value, event: &Value) -> Reduced {
    let knight = sk_world_story::scenario_knight::apply_scenario_knight_event(state.get("scenario_knight"), Some(event), state);
    state["scenario_knight"] = knight.to_json();
    Ok(())
}

/// `state.dialogues = applyDialogueEvent(state.dialogues, event)` (27094).
fn dialogues(state: &mut Value, event: &Value) -> Reduced {
    state["dialogues"] = sk_story::campaign_dialogues::apply_dialogue_event(state.get("dialogues"), Some(event));
    Ok(())
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
fn autonomy(state: &mut Value, event: &Value) -> Reduced {
    state["autonomy"] = sk_world_story::autonomous_campaign::apply_autonomy_event(state.get("autonomy"), event);
    Ok(())
}

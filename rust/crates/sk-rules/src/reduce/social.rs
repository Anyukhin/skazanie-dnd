//! Ветки редьюсера `applyGameEventCurrent`: Общество: пленные, звери, парлей и перемирие, стража, благословения, письма, таверна, подкуп и карманы, мир NPC. Задача Р4.
//!
//! JS: `server/rules-engine.mjs`, 26136–26149, 26150–26165, 26177–26185, 26190–26210, 26211–26220, 26221–26230, 26231–26242, 26243–26254, 26255–26267, 26268–26280, 26284–26304, 26305–26327, 26803–26811, 26812–26824, 27066–27073. Таблица меток — `reduce/table.rs`
//! (Р0). Перенося ветку, уберите её метки из [`UNPORTED`] этого файла.
//!
//! Ветки этого файла меняют только своё: кошелёк, карточку существа, бой
//! перемирия, журналы и мир NPC (`applyNpcWorldEvent` — крейт
//! `sk-npc-world`). Реестры пленных, зверей, таверны, благословений и почты
//! выводятся из журнала после `switch` (`registries.rs`).

use serde_json::{json, Value};
use sk_core::game::{actor_id, combat, combat_mut, conditions_mut, mechanics_mut, replace_actor};
use sk_core::js::{self, is_true, present, s, safe_int, truthy};
use sk_core::Event;

use super::items::{add_inventory_item, refresh_player_derived_state};
use super::{target_of, Reduced};
use crate::core::{combat_actor_kind, restart_turn_clock, safe_integer_or};
use crate::journal::{append_battle_log, append_economy_log, Entry};

/// Метки событий этого файла, чьи ветки ещё не перенесены.
pub(super) const UNPORTED: &[&str] = &[];

/// Событие целиком в форме JS — для помощников других крейтов.
pub(super) fn event_value(event: &Event) -> Value {
    serde_json::to_value(event).unwrap_or(Value::Null)
}

/// `event.actor_id` как значение. Событие без действующего лица несёт в
/// журнале `null` (`eventFrom` берёт `command.actor_id`, а `normalizeCommand`
/// кладёт туда `null`), поэтому `None` — `null`, а не `undefined`.
pub(super) fn actor_value(event: &Event) -> Value {
    event.actor_id.clone().map_or(Value::Null, Value::String)
}

/// `targets[0] ?? event.actor_id` как значение (`None` — `null`).
pub(super) fn target_value(event: &Event) -> Value {
    match crate::core::unique_string_list(&event.target_ids).into_iter().next() {
        Some(target) => Value::String(target),
        None => actor_value(event),
    }
}

/// Ключ объекта по цели (`obj[target]`): `null` печатается как `"null"`.
pub(super) fn target_key(event: &Event) -> String {
    js::string(Some(&target_value(event)))
}

/// `String(payload.hero_id ?? event.actor_id ?? '')`.
pub(super) fn hero_or_actor(event: &Event) -> String {
    match event.payload.get("hero_id").filter(|value| !value.is_null()) {
        Some(value) => s(Some(value)),
        None => event.actor_id.clone().unwrap_or_default(),
    }
}

/// Кошелёк героя после подтверждённой движком сделки:
/// `if (id && payload.currency_after) players[id].currency = clone(currency_after)`.
pub(super) fn set_hero_currency(state: &mut Value, event: &Event) {
    let recipient = hero_or_actor(event);
    let currency = event.payload.get("currency_after");
    if recipient.is_empty() || !truthy(currency) {
        return;
    }
    let currency = currency.cloned().unwrap_or(Value::Null);
    if let Some(players) = state.get_mut("players").and_then(Value::as_array_mut) {
        for player in players.iter_mut() {
            if actor_id(player) == recipient {
                if let Some(map) = player.as_object_mut() {
                    map.insert("currency".into(), currency.clone());
                }
            }
        }
    }
}

/// Существо выходит из боя пленным или приручённым: `alive: false` и флаг,
/// без отдыха, без состояний из `dropped`.
fn leave_combat(state: &mut Value, id: &str, flag: &str, dropped: &[&str]) {
    replace_actor(state, id, |actor| {
        if let Some(map) = actor.as_object_mut() {
            map.insert("alive".into(), Value::Bool(false));
            map.insert(flag.into(), Value::Bool(true));
        }
    });
    if let Some(resting) = mechanics_mut(state).get_mut("resting").and_then(Value::as_object_mut) {
        resting.shift_remove(id);
    }
    let conditions = conditions_mut(state, id);
    conditions.retain(|condition| !dropped.contains(&sk_core::game::condition_id(condition).as_str()));
}

/// `CaptiveTaken` (26136–26149).
pub(super) fn captive_taken(state: &mut Value, event: &Event) -> Reduced {
    let captive = event.payload.get("captive");
    let id = s(captive.and_then(|captive| captive.get("actor_id")));
    if id.is_empty() {
        return Ok(());
    }
    leave_combat(state, &id, "captive", &["unconscious"]);
    let origin = captive.and_then(|captive| captive.get("origin")).filter(|value| !value.is_null());
    let reason = origin.map_or_else(|| "surrendered".to_string(), |value| js::string(Some(value)));
    append_battle_log(state, event, Entry::new().set("type", "captive-taken").set("actorId", id).set("reason", reason).build());
    Ok(())
}

/// `BeastTamed` (26150–26165).
pub(super) fn beast_tamed(state: &mut Value, event: &Event) -> Reduced {
    let id = s(event.payload.get("actor_id"));
    if id.is_empty() {
        return Ok(());
    }
    leave_combat(state, &id, "tamed", &["fled", "surrendered", "morale-tested"]);
    let diet = event.payload.get("diet").filter(|value| !value.is_null());
    let reason = diet.map_or_else(|| "predator".to_string(), |value| js::string(Some(value)));
    append_battle_log(state, event, Entry::new().set("type", "beast-tamed").set("actorId", id).set("reason", reason).build());
    Ok(())
}

/// `CaptiveHandedOver` (26177–26185).
pub(super) fn captive_handed_over(state: &mut Value, event: &Event) -> Reduced {
    set_hero_currency(state, event);
    Ok(())
}

/// `Object.assign(state.mechanics.combat, parleyCombatPatch(combat, event) ?? {})`.
fn apply_parley_patch(state: &mut Value, event: &Event) {
    let patch = sk_society::parley::parley_combat_patch(combat(state), &event_value(event));
    if let Some(patch) = patch {
        js::assign(combat_mut(state), patch);
    }
}

/// `payload.x ? String(payload.x) : undefined`.
fn text_if(entry: Entry, key: &str, value: Option<&Value>) -> Entry {
    entry.text_if(key, value)
}

/// `actorId: event.actor_id, actorKind: combatActorKind(state, event.actor_id)`.
fn actor_fields(state: &Value, entry: Entry, event: &Event) -> Entry {
    let kind = combat_actor_kind(state, event.actor_id.as_deref().unwrap_or_default());
    entry.set("actorId", actor_value(event)).set("actorKind", kind)
}

/// Раунд по `safeInteger(state.mechanics.combat.round, 0)`.
fn combat_round_value(state: &Value) -> Value {
    Value::from(safe_int(combat(state).get("round"), 0))
}

/// Раунд события по `safeInteger(payload.round, state.mechanics.combat.round)`.
fn payload_round(state: &Value, event: &Event) -> Value {
    safe_integer_or(event.payload.get("round"), combat(state).get("round"))
}

/// `ParleyProposed` (26190–26210).
pub(super) fn parley_proposed(state: &mut Value, event: &Event) -> Reduced {
    apply_parley_patch(state, event);
    let payload = &event.payload;
    let result = if is_true(payload.get("refused")) {
        "refused"
    } else if is_true(payload.get("success")) {
        "success"
    } else {
        "failure"
    };
    let mut entry = Entry::new().set("round", combat_round_value(state)).set("type", "parley");
    entry = actor_fields(state, entry, event);
    entry = text_if(entry, "targetId", payload.get("leader_id"));
    entry = text_if(entry, "ability", payload.get("skill"));
    entry = entry.set("result", result);
    if present(payload.get("total")) {
        entry = entry.set(
            "roll",
            json!({
                "die": safe_int(payload.get("kept"), 0),
                "modifier": safe_int(payload.get("modifier"), 0),
                "total": safe_int(payload.get("total"), 0),
                "difficulty": safe_int(payload.get("difficulty"), 0),
                "hit": is_true(payload.get("success")),
            }),
        );
    }
    append_battle_log(state, event, entry.build());
    Ok(())
}

/// `String(x ?? fallback)`.
fn string_or(value: Option<&Value>, fallback: &str) -> String {
    match value.filter(|value| !value.is_null()) {
        Some(value) => js::string(Some(value)),
        None => fallback.to_string(),
    }
}

/// `ParleyRejected` (26211–26220).
pub(super) fn parley_rejected(state: &mut Value, event: &Event) -> Reduced {
    let payload = &event.payload;
    let mut entry = Entry::new().set("round", combat_round_value(state)).set("type", "parley-rejected");
    entry = actor_fields(state, entry, event);
    entry = text_if(entry, "targetId", payload.get("leader_id"));
    entry = entry.set("reason", string_or(payload.get("reason"), "roll_failed"));
    append_battle_log(state, event, entry.build());
    Ok(())
}

/// `TruceEstablished` (26221–26230).
pub(super) fn truce_established(state: &mut Value, event: &Event) -> Reduced {
    apply_parley_patch(state, event);
    let leader = s(event.payload.get("truce").and_then(|truce| truce.get("leader_id")));
    let mut entry = Entry::new().set("round", combat_round_value(state)).set("type", "truce");
    entry = actor_fields(state, entry, event);
    entry = entry.set("targetId", leader);
    append_battle_log(state, event, entry.build());
    Ok(())
}

/// `TruceBroken` (26231–26242).
pub(super) fn truce_broken(state: &mut Value, event: &Event) -> Reduced {
    apply_parley_patch(state, event);
    restart_turn_clock(state, event);
    let payload = &event.payload;
    let breaker = match payload.get("actor_id").filter(|value| !value.is_null()) {
        Some(value) => s(Some(value)),
        None => event.actor_id.clone().unwrap_or_default(),
    };
    let entry = Entry::new()
        .set("round", payload_round(state, event))
        .set("type", "truce-broken")
        .set("actorId", breaker.clone())
        .set("actorKind", combat_actor_kind(state, &breaker));
    let entry = text_if(entry, "targetId", payload.get("target_id")).set("reason", string_or(payload.get("broken_by"), "party"));
    append_battle_log(state, event, entry.build());
    Ok(())
}

/// `GuardEncounterResolved` (26243–26254).
pub(super) fn guard_encounter_resolved(state: &mut Value, event: &Event) -> Reduced {
    set_hero_currency(state, event);
    Ok(())
}

/// `NpcBlessingGranted` (26255–26267).
pub(super) fn npc_blessing_granted(state: &mut Value, event: &Event) -> Reduced {
    set_hero_currency(state, event);
    Ok(())
}

/// `CourierLetterSent` (26268–26280).
pub(super) fn courier_letter_sent(state: &mut Value, event: &Event) -> Reduced {
    set_hero_currency(state, event);
    Ok(())
}

/// `TavernDiceRoundOpened`, `TavernDiceRoundCancelled`, `TavernDiceRoundResolved`, `TavernDrinkOrdered` (26284–26304).
pub(super) fn tavern_event(state: &mut Value, event: &Event) -> Reduced {
    set_hero_currency(state, event);
    Ok(())
}

/// `ParleySettled` (26305–26327).
pub(super) fn parley_settled(state: &mut Value, event: &Event) -> Reduced {
    apply_parley_patch(state, event);
    restart_turn_clock(state, event);
    let payee = hero_or_actor(event);
    set_hero_currency(state, event);
    let payload = &event.payload;
    let entry = Entry::new()
        .set("round", payload_round(state, event))
        .set("type", "parley-settled")
        .set("actorId", payee.clone())
        .set("actorKind", combat_actor_kind(state, &payee));
    let entry = text_if(entry, "targetId", payload.get("leader_id"))
        .set("reason", string_or(payload.get("outcome"), "resume"))
        .set("participantIds", payload.get("enemy_ids").filter(|value| !value.is_null()).cloned().unwrap_or_else(|| json!([])));
    append_battle_log(state, event, entry.build());
    Ok(())
}

/// `NpcBribeOffered` (26803–26811).
pub(super) fn npc_bribe_offered(state: &mut Value, event: &Event) -> Reduced {
    let target = target_of(event);
    let payload = &event.payload;
    let currency = sk_economy::merchant_economy::normalize_currency(payload.get("currency_after"));
    replace_actor(state, &target, |actor| {
        if let Some(map) = actor.as_object_mut() {
            map.insert("currency".into(), currency.clone());
        }
    });
    refresh_player_derived_state(state, std::slice::from_ref(&target))?;
    let entry = Entry::new()
        .set("type", "bribe")
        .set("actorId", target_value(event))
        .opt("npcId", payload.get("npc_id").cloned())
        .set("amountCp", safe_int(payload.get("amount_cp"), 0))
        .set("insulted", is_true(payload.get("insulted")))
        .set("policyId", payload.get("policy_id").cloned().unwrap_or(Value::Null))
        .build();
    append_economy_log(state, event, entry);
    Ok(())
}

/// `NpcPocketPicked` (26812–26824).
pub(super) fn npc_pocket_picked(state: &mut Value, event: &Event) -> Reduced {
    let target = target_of(event);
    let payload = &event.payload;
    let currency = sk_economy::merchant_economy::normalize_currency(payload.get("currency_after"));
    let item = payload.get("item").filter(|item| truthy(Some(item))).cloned();
    replace_actor(state, &target, |actor| {
        let inventory = item.as_ref().map(|item| add_inventory_item(actor.get("inventory"), item));
        if let Some(map) = actor.as_object_mut() {
            map.insert("currency".into(), currency.clone());
            if let Some(inventory) = inventory {
                map.insert("inventory".into(), inventory);
            }
        }
    });
    refresh_player_derived_state(state, std::slice::from_ref(&target))?;
    let item_name = payload.get("item").and_then(|item| item.get("name")).filter(|value| !value.is_null()).cloned().unwrap_or(Value::Null);
    let entry = Entry::new()
        .set("type", "pickpocket")
        .set("actorId", target_value(event))
        .opt("npcId", payload.get("npc_id").cloned())
        .set("amountCp", safe_int(payload.get("purse_cp"), 0))
        .set("itemName", item_name)
        .set("policyId", payload.get("policy_id").cloned().unwrap_or(Value::Null))
        .build();
    append_economy_log(state, event, entry);
    Ok(())
}

/// `applyNpcWorldEvent(state.npc_world, event)` (`npc-positioning.mjs`,
/// крейт `sk-npc-world`): мир NPC после события. Режим хранения — из
/// `with_retention_mode`, как у JS без `options`.
pub(super) fn apply_npc_world(state: &Value, event: &Event) -> Value {
    sk_npc_world::npc_positioning::apply_npc_world_event(state.get("npc_world"), &event_value(event), &js::obj())
}

/// `NpcPlaced`, `NpcMoved`, `NpcHarmed`, `NpcDied`, `NpcStanceChanged` (27066–27073).
pub(super) fn npc_world_event(state: &mut Value, event: &Event) -> Reduced {
    state["npc_world"] = apply_npc_world(state, event);
    let payload = &event.payload;
    let npc_id = s(payload.get("npc_id"));
    if event.event_type == "NpcHarmed" && payload.as_object().is_some_and(|map| map.contains_key("temporary_hp_after")) && !npc_id.is_empty() {
        let temporary = safe_int(payload.get("temporary_hp_after"), 0).max(0);
        // `state.mechanics.temporary_hp[id] = …`: у `undefined`/`null` и у
        // примитива (модуль JS в строгом режиме) — `TypeError`; свойство
        // массива в JSON не видно. Число в `__proto__` объекта JS молча
        // пропускает.
        match mechanics_mut(state).get_mut("temporary_hp") {
            Some(Value::Object(_)) if npc_id == "__proto__" => {}
            Some(Value::Object(map)) => {
                map.insert(npc_id, Value::from(temporary));
            }
            Some(Value::Array(_)) => {}
            _ => return Err(super::world::type_error("Cannot set properties of mechanics.temporary_hp")),
        }
    }
    Ok(())
}

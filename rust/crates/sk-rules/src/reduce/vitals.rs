//! Живучесть: урон, лечение, предел хитов, нокаут, спасброски от смерти,
//! гибель и воскрешение, временные хиты, ресурсы.

use serde_json::{json, Map, Value};
use sk_core::game::{actor_hp, actor_max_hp, actor_position, combat_active, combat_actor_kind, condition_id, conditions, conditions_mut, find_actor, has_condition, is_enemy_actor, is_living_actor, mechanics_mut, player_actor, replace_actor};
use sk_core::js::{is_true, s, safe_int, slice, truthy, unique_strings};
use sk_core::Event;

use super::{scene_turn_and_round, target_of};
use crate::journal::{append_battle_log, append_map_feedback, recent_battle_spell_name, Entry};

fn payload(event: &Event) -> &Value {
    &event.payload
}

fn p<'a>(event: &'a Event, key: &str) -> Option<&'a Value> {
    event.payload.get(key)
}

fn temporary_hp_set(state: &mut Value, target: &str, value: i64) {
    let mechanics = mechanics_mut(state);
    let temporary = mechanics.entry("temporary_hp").or_insert_with(sk_core::js::obj);
    if let Some(map) = temporary.as_object_mut() {
        map.insert(target.to_string(), Value::from(value));
    }
}

fn mechanics_map_remove(state: &mut Value, area: &str, key: &str) {
    if let Some(map) = mechanics_mut(state).get_mut(area).and_then(Value::as_object_mut) {
        map.remove(key);
    }
}

fn death_saves_mut(state: &mut Value) -> &mut Map<String, Value> {
    let mechanics = mechanics_mut(state);
    let death = mechanics.entry("death").or_insert_with(sk_core::js::obj);
    sk_core::js::object_mut(death, "saving_throws");
    death.get_mut("saving_throws").and_then(Value::as_object_mut).expect("спасброски")
}

fn death_heroes_mut(state: &mut Value) -> &mut Map<String, Value> {
    let mechanics = mechanics_mut(state);
    let death = mechanics.entry("death").or_insert_with(sk_core::js::obj);
    sk_core::js::object_mut(death, "heroes");
    death.get_mut("heroes").and_then(Value::as_object_mut).expect("герои")
}

fn resting_reason(state: &Value, target: &str) -> String {
    s(sk_core::game::mechanics(state).get("resting").and_then(|r| r.get(target)).and_then(|rest| rest.get("reason")))
}

/// `syncNpcWorldVital(state, npcId, { hp, maxHp, fallback })` — живучесть
/// именного NPC в `state.npc_world.vitals`.
pub(crate) fn sync_npc_world_vital(state: &mut Value, npc_id: &str, hp: Option<&Value>, max_hp: Option<&Value>, fallback: Option<(i64, i64, bool)>) {
    if npc_id.is_empty() {
        return;
    }
    let world = sk_core::js::object_mut(state, "npc_world");
    let vitals = world.entry("vitals").or_insert_with(sk_core::js::obj);
    let before = vitals.get(npc_id).cloned();
    let (before_hp, before_max) = match (&before, fallback) {
        (Some(record), _) => (safe_int(record.get("hp"), 0), safe_int(record.get("max_hp"), 1)),
        (None, Some((hp, max, _))) => (hp, max),
        (None, None) => (0, 1),
    };
    let maximum = safe_int(max_hp, before_max).max(1);
    let current = safe_int(hp, before_hp).max(0).min(maximum);
    if let Some(map) = vitals.as_object_mut() {
        map.insert(npc_id.to_string(), json!({ "hp": current, "max_hp": maximum, "alive": current > 0 }));
    }
}

/// `syncAuthoredNpcVital`: противник, порождённый именным NPC.
fn sync_authored_npc_vital(state: &mut Value, target: &str, hp: Option<&Value>, max_hp: Option<&Value>) {
    let Some(enemy) = state.get("enemies").and_then(Value::as_array).and_then(|list| list.iter().find(|enemy| sk_core::game::actor_id(enemy) == target)).cloned() else { return };
    let npc_id = s(enemy.get("origin").and_then(|origin| origin.get("npc_id")));
    if npc_id.is_empty() {
        return;
    }
    let fallback = (actor_hp(&enemy), actor_max_hp(&enemy), is_living_actor(&enemy));
    sync_npc_world_vital(state, &npc_id, hp, max_hp, Some(fallback));
}

/// `syncSocialNpcVital` — только если событие явно про социального NPC.
fn sync_social_npc_vital(state: &mut Value, target: &str, hp: Option<&Value>, max_hp: Option<&Value>, npc_id: Option<&Value>) {
    if s(npc_id) != target || target.is_empty() {
        return;
    }
    let known = state.get("social").and_then(|social| social.get("npcs")).and_then(Value::as_array).is_some_and(|npcs| npcs.iter().any(|npc| s(npc.get("id")) == target));
    if !known {
        return;
    }
    let before = state.get("npc_world").and_then(|world| world.get("vitals")).and_then(|vitals| vitals.get(target)).cloned();
    if let Some(record) = &before {
        if record.get("alive") == Some(&Value::Bool(false)) || safe_int(record.get("hp"), 0) <= 0 {
            return;
        }
    }
    let fallback = before.as_ref().map(|record| (safe_int(record.get("hp"), 0), safe_int(record.get("max_hp"), 1), true));
    sync_npc_world_vital(state, target, hp, max_hp, fallback);
}

pub fn damage_applied(state: &mut Value, event: &Event) {
    let target = target_of(event);
    let payload = payload(event).clone();
    let blocked_magic_missile = s(payload.get("spell_id")) == "magic-missile" && is_true(payload.get("blocked_by_shield"));
    let enemy = is_enemy_actor(state, &target);
    replace_actor(state, &target, |actor| {
        let hp = safe_int(payload.get("hp_after"), actor_hp(actor)).max(0);
        actor["hp"] = Value::from(hp);
        if enemy {
            actor["alive"] = Value::Bool(hp > 0);
        }
    });
    sync_authored_npc_vital(state, &target, payload.get("hp_after"), None);
    temporary_hp_set(state, &target, safe_int(payload.get("temporary_hp_after"), 0).max(0));
    if truthy(payload.get("resistance_cantrip_condition")) && truthy(payload.get("resistance_cantrip_turn")) {
        let wanted = s(payload.get("resistance_cantrip_condition"));
        let turn = s(payload.get("resistance_cantrip_turn"));
        for condition in conditions_mut(state, &target).iter_mut() {
            if condition_id(condition) != wanted {
                continue;
            }
            if !condition.is_object() {
                *condition = json!({ "id": wanted });
            }
            condition["last_used_turn"] = Value::String(turn.clone());
        }
    }
    if truthy(payload.get("death_ward_triggered")) {
        conditions_mut(state, &target).retain(|condition| condition_id(condition) != "death-ward");
    }
    if truthy(payload.get("relentless_endurance_triggered")) {
        let marker = "species-trait-used:relentless-endurance";
        if !has_condition(state, &target, marker) {
            conditions_mut(state, &target).push(json!({ "id": marker, "duration": "until-long-rest", "source": "species" }));
        }
    }
    if safe_int(payload.get("hp_after"), 0) == 0 && resting_reason(state, &target) == "knockout" {
        mechanics_map_remove(state, "resting", &target);
    }
    if safe_int(payload.get("raw_amount"), 0) > 0 && has_condition(state, &target, "magical-sleep") {
        conditions_mut(state, &target).retain(|condition| !matches!(condition_id(condition).as_str(), "magical-sleep" | "unconscious"));
    }
    if safe_int(payload.get("temporary_hp_before"), 0) > 0 && safe_int(payload.get("temporary_hp_after"), 0) == 0 {
        conditions_mut(state, &target).retain(|condition| !condition_id(condition).starts_with("armor-of-agathys:"));
    }
    let applied = safe_int(payload.get("applied_amount"), 0);
    let hp_before = safe_int(payload.get("hp_before"), 0);
    let hp_after = safe_int(payload.get("hp_after"), 0);
    let damage_type = truthy(payload.get("damage_type")).then(|| s(payload.get("damage_type")));
    let actor_id = event.actor_id.clone().unwrap_or_default();
    let spell_id = payload.get("spell_id").filter(|value| truthy(Some(value))).map(|value| s(Some(value)));
    let mut updated = false;
    if let Some(log) = state.get_mut("battleLog").and_then(Value::as_array_mut) {
        for item in log.iter_mut().rev() {
            if s(item.get("type")) == "attack" && s(item.get("targetId")) == target && item.get("actorId").map(|v| s(Some(v))).unwrap_or_default() == actor_id && item.get("damage").is_none_or(Value::is_null) {
                set_damage_fields(item, applied, damage_type.as_deref(), hp_before, hp_after);
                updated = true;
                break;
            }
        }
    }
    if !updated && spell_id.is_some() && blocked_magic_missile {
        if let Some(log) = state.get_mut("battleLog").and_then(Value::as_array_mut) {
            for item in log.iter_mut().rev() {
                if s(item.get("type")) != "spell" || s(item.get("spellId")) != "magic-missile" || s(item.get("targetId")) != target {
                    continue;
                }
                item["blocked"] = Value::Bool(true);
                updated = true;
                break;
            }
        }
    }
    if !updated {
        if let Some(spell) = &spell_id {
            if let Some(log) = state.get_mut("battleLog").and_then(Value::as_array_mut) {
                for item in log.iter_mut().rev() {
                    if s(item.get("type")) == "spell-save" && s(item.get("targetId")) == target && s(item.get("spellId")) == *spell && item.get("damage").is_none_or(Value::is_null) {
                        set_damage_fields(item, applied, damage_type.as_deref(), hp_before, hp_after);
                        updated = true;
                        break;
                    }
                }
            }
        }
    }
    if !updated {
        if let Some(spell) = &spell_id {
            let (scene_turn, round) = scene_turn_and_round(state);
            let entry = Entry::new()
                .set("sceneTurn", scene_turn)
                .set("round", round)
                .set("type", "spell-damage")
                .opt("actorId", event.actor_id.clone())
                .set("actorKind", combat_actor_kind(state, &actor_id))
                .set("targetId", target.clone())
                .set("spellId", spell.clone())
                .opt("spellName", recent_battle_spell_name(state, payload.get("spell_id")))
                .set("damage", applied)
                .opt("damageType", damage_type.clone())
                .set("hpBefore", hp_before)
                .set("hpAfter", hp_after)
                .flag_if("blocked", blocked_magic_missile)
                .build();
            append_battle_log(state, event, entry);
        }
    }
    if let Some(position) = actor_position(state, &target) {
        let defeat = payload.get("hp_after").and_then(Value::as_i64) == Some(0) || payload.get("hp_after").and_then(Value::as_f64) == Some(0.0);
        let entry = Entry::new().set("x", position.x).set("y", position.y).set("text", format!("−{applied}")).set("kind", if defeat { "defeat" } else { "damage" }).build();
        append_map_feedback(state, event, entry);
    }
}

fn set_damage_fields(item: &mut Value, applied: i64, damage_type: Option<&str>, hp_before: i64, hp_after: i64) {
    item["damage"] = Value::from(applied);
    match damage_type {
        Some(kind) => item["damageType"] = Value::String(kind.to_string()),
        None => {
            if let Some(map) = item.as_object_mut() {
                map.remove("damageType");
            }
        }
    }
    item["hpBefore"] = Value::from(hp_before);
    item["hpAfter"] = Value::from(hp_after);
}

pub fn hit_point_maximum_reduced(state: &mut Value, event: &Event) {
    let target = target_of(event);
    let payload = payload(event).clone();
    let enemy = is_enemy_actor(state, &target);
    replace_actor(state, &target, |actor| {
        let maximum = safe_int(payload.get("maximum_hp_after"), actor_max_hp(actor)).max(0);
        let hp = safe_int(payload.get("hp_after"), actor_hp(actor)).max(0).min(maximum);
        actor["maxHp"] = Value::from(maximum);
        if actor.get("max_hp").is_some() {
            actor["max_hp"] = Value::from(maximum);
        }
        actor["hp"] = Value::from(hp);
        if enemy {
            actor["alive"] = Value::Bool(maximum > 0 && hp > 0);
        }
    });
    sync_authored_npc_vital(state, &target, payload.get("hp_after"), payload.get("maximum_hp_after"));
    let entry = Entry::new()
        .set("type", "max-hp-reduction")
        .opt("actorId", event.actor_id.clone())
        .set("targetId", target)
        .set("maximumHpBefore", safe_int(payload.get("maximum_hp_before"), 0))
        .set("maximumHpAfter", safe_int(payload.get("maximum_hp_after"), 0))
        .build();
    append_battle_log(state, event, entry);
}

pub fn hit_point_maximum_increased(state: &mut Value, event: &Event) {
    let target = target_of(event);
    let payload = payload(event).clone();
    let enemy = is_enemy_actor(state, &target);
    replace_actor(state, &target, |actor| {
        let maximum = safe_int(payload.get("maximum_hp_after"), actor_max_hp(actor)).max(1);
        let hp = safe_int(payload.get("hp_after"), actor_hp(actor)).max(0).min(maximum);
        actor["maxHp"] = Value::from(maximum);
        if actor.get("max_hp").is_some() {
            actor["max_hp"] = Value::from(maximum);
        }
        actor["hp"] = Value::from(hp);
        if enemy {
            actor["alive"] = Value::Bool(hp > 0);
        }
    });
    sync_authored_npc_vital(state, &target, payload.get("hp_after"), payload.get("maximum_hp_after"));
    if safe_int(payload.get("hp_after"), 0) > 0 {
        conditions_mut(state, &target).retain(|condition| condition.get("id").map(|id| s(Some(id))).as_deref() != Some("unconscious"));
        death_saves_mut(state).remove(&target);
    }
    let entry = Entry::new()
        .set("type", "max-hp-increase")
        .opt("actorId", event.actor_id.clone())
        .set("targetId", target)
        .text_if("spellId", payload.get("spell_id"))
        .set("maximumHpBefore", safe_int(payload.get("maximum_hp_before"), 0))
        .set("maximumHpAfter", safe_int(payload.get("maximum_hp_after"), 0))
        .build();
    append_battle_log(state, event, entry);
}

pub fn hit_point_maximum_reduction_prevented(state: &mut Value, event: &Event) {
    let target = target_of(event);
    let payload = payload(event).clone();
    let entry = Entry::new()
        .set("type", "max-hp-reduction-prevented")
        .opt("actorId", event.actor_id.clone())
        .set("targetId", target)
        .set("maximumHpBefore", safe_int(payload.get("maximum_hp_before"), 0))
        .set("maximumHpAfter", safe_int(payload.get("maximum_hp_after"), 0))
        .set("spellId", "aura-of-life")
        .build();
    append_battle_log(state, event, entry);
}

pub fn healing_applied(state: &mut Value, event: &Event) {
    let target = target_of(event);
    let payload = payload(event).clone();
    let enemy = is_enemy_actor(state, &target);
    replace_actor(state, &target, |actor| {
        let hp = safe_int(payload.get("hp_after"), actor_hp(actor)).max(0).min(actor_max_hp(actor));
        actor["hp"] = Value::from(hp);
        if enemy {
            actor["alive"] = Value::Bool(hp > 0);
        }
    });
    sync_authored_npc_vital(state, &target, payload.get("hp_after"), None);
    sync_social_npc_vital(state, &target, payload.get("hp_after"), payload.get("maximum_hp_after"), payload.get("npc_id"));
    let (scene_turn, round) = scene_turn_and_round(state);
    let actor_id = event.actor_id.clone().unwrap_or_default();
    let entry = Entry::new()
        .set("sceneTurn", scene_turn)
        .set("round", round)
        .set("type", "healing")
        .opt("actorId", event.actor_id.clone())
        .set("actorKind", combat_actor_kind(state, &actor_id))
        .set("targetId", target.clone())
        .text_if("spellId", payload.get("spell_id"))
        .opt("spellName", recent_battle_spell_name(state, payload.get("spell_id")))
        .set("healing", safe_int(payload.get("applied_amount"), 0))
        .set("hpBefore", safe_int(payload.get("hp_before"), 0))
        .set("hpAfter", safe_int(payload.get("hp_after"), 0))
        .build();
    append_battle_log(state, event, entry);
    if safe_int(payload.get("hp_after"), 0) > 0 {
        conditions_mut(state, &target).retain(|condition| condition.get("id").map(|id| s(Some(id))).as_deref() != Some("unconscious"));
        death_saves_mut(state).remove(&target);
        if resting_reason(state, &target) == "knockout" {
            mechanics_map_remove(state, "resting", &target);
        }
    }
}

pub fn creature_knocked_out(state: &mut Value, event: &Event) {
    let target = target_of(event);
    let rules = Value::Array(event.source_rule_ids.iter().map(|id| Value::String(id.clone())).collect());
    let list = conditions_mut(state, &target);
    if !list.iter().any(|condition| condition.get("id").map(|id| s(Some(id))).as_deref() == Some("unconscious")) {
        list.push(json!({ "id": "unconscious", "source_rule_ids": rules }));
    }
    let minutes = safe_int(p(event, "recovery_minutes"), 60).clamp(1, 60);
    let mechanics = mechanics_mut(state);
    let resting = mechanics.entry("resting").or_insert_with(sk_core::js::obj);
    resting[target.as_str()] = json!({ "kind": "short", "reason": "knockout", "recovery_minutes_remaining": minutes });
    death_saves_mut(state).remove(&target);
}

pub fn knockout_recovery_progressed(state: &mut Value, event: &Event) {
    let target = target_of(event);
    if resting_reason(state, &target) != "knockout" {
        return;
    }
    let minutes = safe_int(p(event, "recovery_minutes_remaining"), 1).clamp(1, 60);
    if let Some(rest) = mechanics_mut(state).get_mut("resting").and_then(|r| r.get_mut(target.as_str())) {
        rest["recovery_minutes_remaining"] = Value::from(minutes);
    }
}

pub fn knockout_ended(state: &mut Value, event: &Event) {
    let target = target_of(event);
    conditions_mut(state, &target).retain(|condition| condition.get("id").map(|id| s(Some(id))).as_deref() != Some("unconscious"));
    if resting_reason(state, &target) == "knockout" {
        mechanics_map_remove(state, "resting", &target);
    }
}

fn death_tracker(event: &Event) -> Value {
    json!({
        "successes": safe_int(p(event, "successes_after"), 0).clamp(0, 2),
        "failures": safe_int(p(event, "failures_after"), 0).clamp(0, 2),
        "stable": false,
    })
}

pub fn death_saving_throw_rolled(state: &mut Value, event: &Event) {
    let target = target_of(event);
    death_saves_mut(state).insert(target.clone(), death_tracker(event));
    let payload = payload(event);
    let mut entry = Entry::new()
        .set("type", "death-save")
        .set("actorId", target)
        .set(
            "roll",
            json!({
                "die": safe_int(payload.get("natural_roll"), 0), "modifier": safe_int(payload.get("modifier"), 0),
                "total": safe_int(payload.get("total"), 0), "difficulty": 10, "hit": is_true(payload.get("success")),
            }),
        )
        .set("successes", safe_int(payload.get("successes_after"), 0))
        .set("failures", safe_int(payload.get("failures_after"), 0))
        .set("result", s(payload.get("result")))
        .set("modifierSources", sk_core::js::strings_value(unique_strings(payload.get("modifier_sources"))));
    if truthy(payload.get("item_saving_throw_bonus")) {
        entry = entry.set("itemSavingThrowBonus", safe_int(payload.get("item_saving_throw_bonus"), 1).max(1));
    }
    if truthy(payload.get("aura_of_protection_source")) {
        entry = entry.set("auraSourceId", s(payload.get("aura_of_protection_source"))).set("auraBonus", safe_int(payload.get("aura_of_protection_bonus"), 1).max(1));
    }
    if truthy(payload.get("indomitable_bonus")) {
        entry = entry.set("indomitableBonus", safe_int(payload.get("indomitable_bonus"), 1).max(1)).set("indomitableOriginalTotal", safe_int(payload.get("indomitable_original_total"), 0));
    }
    let entry = entry.build();
    append_battle_log(state, event, entry);
}

pub fn death_save_failure_recorded(state: &mut Value, event: &Event) {
    let target = target_of(event);
    death_saves_mut(state).insert(target.clone(), death_tracker(event));
    let payload = payload(event);
    let entry = Entry::new()
        .set("type", "death-save-damage")
        .set("actorId", target)
        .set("successes", safe_int(payload.get("successes_after"), 0))
        .set("failures", safe_int(payload.get("failures_after"), 0))
        .set("critical", is_true(payload.get("critical")))
        .build();
    append_battle_log(state, event, entry);
}

pub fn stable_recovery_scheduled(state: &mut Value, event: &Event) {
    let target = target_of(event);
    let minutes = safe_int(p(event, "recovery_minutes"), 60).max(1);
    death_saves_mut(state).insert(target, json!({ "successes": 0, "failures": 0, "stable": true, "recovery_minutes_remaining": minutes }));
}

pub fn stable_recovery_progressed(state: &mut Value, event: &Event) {
    let target = target_of(event);
    let minutes = safe_int(p(event, "recovery_minutes_remaining"), 1).max(1);
    death_saves_mut(state).insert(target, json!({ "successes": 0, "failures": 0, "stable": true, "recovery_minutes_remaining": minutes }));
}

pub fn hero_stabilized(state: &mut Value, event: &Event) {
    let target = target_of(event);
    death_saves_mut(state).insert(target.clone(), json!({ "successes": 0, "failures": 0, "stable": true }));
    let method = p(event, "method").filter(|value| !value.is_null()).map(|value| s(Some(value))).unwrap_or_else(|| "stabilized".into());
    let entry = Entry::new().set("type", "hero-stabilized").set("actorId", target).set("reason", method).build();
    append_battle_log(state, event, entry);
}

pub fn hero_died(state: &mut Value, event: &Event) {
    let target = target_of(event);
    death_saves_mut(state).remove(&target);
    let ended_effect = sk_core::game::mechanics(state).get("concentration").and_then(|c| c.get(target.as_str())).and_then(|entry| entry.get("effect_id")).cloned();
    super::conditions::clear_concentration_effect(state, &target, ended_effect.as_ref(), crate::reduce::conditions::summon_cleanup(payload(event)));
    mechanics_map_remove(state, "temporary_hp", &target);
    let occurred = event.extra.get("occurred_at").filter(|value| !value.is_null()).or_else(|| event.extra.get("created_at").filter(|value| !value.is_null())).cloned().unwrap_or(Value::Null);
    let combat = sk_core::game::combat(state).clone();
    let world_minutes = safe_int(sk_core::game::mechanics(state).get("world_time").and_then(|time| time.get("elapsed_minutes")), 0).max(0);
    let mut record = Map::new();
    record.insert("status".into(), Value::String("dead".into()));
    record.insert("resolution".into(), Value::Null);
    record.insert("died_at".into(), occurred.clone());
    if is_true(combat.get("active")) {
        record.insert("died_round".into(), Value::from(safe_int(combat.get("round"), 1).max(1)));
    }
    record.insert("died_world_minutes".into(), Value::from(world_minutes));
    record.insert("resolved_at".into(), Value::Null);
    record.insert("replacement_name".into(), Value::Null);
    death_heroes_mut(state).insert(target.clone(), Value::Object(record));
    let rules = Value::Array(event.source_rule_ids.iter().map(|id| Value::String(id.clone())).collect());
    let list = conditions_mut(state, &target);
    list.retain(|condition| !matches!(condition.get("id").map(|id| s(Some(id))).as_deref(), Some("unconscious") | Some("dead")));
    list.push(json!({ "id": "dead", "source_rule_ids": rules }));
    let member_ids: Vec<String> = {
        let members = sk_core::js::unique_strings(state.get("partyMemberIds"));
        let raw_members = state.get("partyMemberIds").and_then(Value::as_array).map(|list| list.iter().map(|id| s(Some(id))).collect::<Vec<_>>()).unwrap_or_default();
        if !raw_members.is_empty() {
            raw_members
        } else if members.is_empty() {
            state.get("players").and_then(Value::as_array).map(|players| players.iter().map(sk_core::game::actor_id).collect()).unwrap_or_default()
        } else {
            members
        }
    };
    let heroes = sk_core::game::mechanics(state).get("death").and_then(|death| death.get("heroes")).cloned().unwrap_or(Value::Null);
    if !member_ids.is_empty() && member_ids.iter().all(|id| heroes.get(id.as_str()).and_then(|fate| fate.get("status")).and_then(Value::as_str) == Some("dead")) {
        if let Some(death) = mechanics_mut(state).get_mut("death") {
            death["campaign_status"] = Value::String("party_defeated".into());
        }
        let legacy = event.event_schema_version.map(|version| version < 2).unwrap_or(true);
        if legacy {
            let mechanics = mechanics_mut(state);
            let lifecycle = mechanics.entry("campaign_lifecycle").or_insert_with(sk_core::js::obj);
            sk_core::js::assign(lifecycle, json!({ "status": "failed", "reason": "party_final_death", "concluded_at": occurred, "changed_by": "system" }));
        }
    }
}

pub fn hero_resurrected_or_replaced(state: &mut Value, event: &Event) {
    let target = target_of(event);
    let replaced = event.event_type == "HeroReplaced";
    let payload = payload(event).clone();
    replace_actor(state, &target, |actor| {
        if replaced {
            let fallback = [actor.get("character"), actor.get("name")].into_iter().flatten().find(|value| truthy(Some(value))).map(|value| s(Some(value))).unwrap_or_else(|| target.clone());
            let name = if truthy(payload.get("replacement_name")) { s(payload.get("replacement_name")) } else { fallback };
            actor["character"] = Value::String(slice(&name, 120));
        }
        let fallback = if replaced { actor_max_hp(actor) } else { 1 };
        actor["hp"] = Value::from(safe_int(payload.get("hp_after"), fallback).max(1).min(actor_max_hp(actor)));
    });
    if let Some(all) = mechanics_mut(state).get_mut("conditions").and_then(Value::as_object_mut) {
        all.insert(target.clone(), Value::Array(Vec::new()));
    } else {
        conditions_mut(state, &target).clear();
    }
    mechanics_map_remove(state, "concentration", &target);
    mechanics_map_remove(state, "temporary_hp", &target);
    death_saves_mut(state).remove(&target);
    if replaced {
        if let Some(pools) = mechanics_mut(state).get_mut("resources").and_then(|r| r.get_mut(target.as_str())).and_then(Value::as_object_mut) {
            for pool in pools.values_mut() {
                if pool.is_object() {
                    pool["current"] = Value::from(safe_int(pool.get("max"), 0).max(0));
                }
            }
        }
    }
    let occurred = event.extra.get("occurred_at").filter(|value| !value.is_null()).or_else(|| event.extra.get("created_at").filter(|value| !value.is_null())).cloned().unwrap_or(Value::Null);
    let heroes = death_heroes_mut(state);
    let mut record = heroes.get(&target).and_then(Value::as_object).cloned().unwrap_or_default();
    record.insert("status".into(), Value::String("resolved".into()));
    record.insert("resolution".into(), Value::String(if replaced { "replaced" } else { "resurrected" }.into()));
    record.insert("resolved_at".into(), occurred);
    record.insert("replacement_name".into(), if replaced { Value::String(slice(&s(payload.get("replacement_name")), 120)) } else { Value::Null });
    heroes.insert(target, Value::Object(record));
}

pub fn temporary_hit_points_granted(state: &mut Value, event: &Event) {
    let target = target_of(event);
    temporary_hp_set(state, &target, safe_int(p(event, "temporary_hp_after"), 0).max(0));
}

pub fn hit_points_reduced_to_zero(state: &mut Value, event: &Event) {
    let target = target_of(event);
    let rules = Value::Array(event.source_rule_ids.iter().map(|id| Value::String(id.clone())).collect());
    let list = conditions_mut(state, &target);
    if !list.iter().any(|condition| condition.get("id").map(|id| s(Some(id))).as_deref() == Some("unconscious")) {
        list.push(json!({ "id": "unconscious", "source_rule_ids": rules }));
    }
    if player_actor(state, &target).is_some() {
        death_saves_mut(state).insert(target.clone(), json!({ "successes": 0, "failures": 0, "stable": false }));
    }
    let cleanup = super::conditions::summon_cleanup(payload(event));
    let effect = sk_core::game::mechanics(state).get("concentration").and_then(|c| c.get(target.as_str())).and_then(|entry| entry.get("effect_id")).cloned();
    super::conditions::clear_concentration_effect(state, &target, effect.as_ref(), cleanup);
    if find_actor(state, &target).is_some_and(sk_core::game::is_party_summon) {
        super::conditions::remove_summoned_actor(state, &target, cleanup);
    }
}

pub fn resource_changed(state: &mut Value, event: &Event) {
    let target = target_of(event);
    let resource = s(p(event, "resource"));
    let current = safe_int(p(event, "after"), 0);
    let max = safe_int(p(event, "max"), 0).max(0);
    let mechanics = mechanics_mut(state);
    let resources = mechanics.entry("resources").or_insert_with(sk_core::js::obj);
    let pools = sk_core::js::object_mut(resources, &target);
    pools.insert(resource, json!({ "current": current, "max": max }));
}

#[allow(dead_code)]
fn unused(state: &Value) -> bool {
    combat_active(state) && !conditions(state, "").is_empty()
}

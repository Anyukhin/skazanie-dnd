//! Блоки `validateCommand`: Хиты и отдых: судьба погибшего, отдых, лечение погибшего, максимум хитов, опознание. Задача Р2.
//!
//! JS: `server/rules-engine.mjs`, 6985–6992, 6994–7042, 7058–7060, 7061–7063, 7569–7585. Порядок блоков задаёт
//! `validate/mod.rs` (Р0); здесь — только тела.

use serde_json::{json, Value};
use sk_core::js;

use super::Validation;
use crate::constants::{REST_EVENT_SCHEMA_VERSION, REST_MINIMUM_MINUTES_SHORT};
use crate::core::{actor_max_hp, len_utf16, player_actor, target_for};
use crate::pause::{rule, Step};
use crate::rest::{elapsed_rest_minutes, hit_point_dice_pool_for_actor, rest_minimum_minutes};
use crate::targets::is_dead_hero;

fn command_type(v: &Validation<'_>) -> String {
    js::s(v.command.get("command_type"))
}

/// `command.key = value` (команда после `normalizeCommand` — объект).
fn set_field(command: &mut Value, key: &str, value: Value) {
    if let Some(map) = command.as_object_mut() {
        map.insert(key.into(), value);
    }
}

/// Блок 57 (6985–6992): судьба погибшего героя.
pub fn check_resolve_hero_death(v: &mut Validation<'_>) -> Step {
    if command_type(v) != "ResolveHeroDeath" {
        return Ok(());
    }
    if player_actor(v.state, v.command.get("actor_id")).is_none() {
        return Err(rule("Разрешить судьбу можно только для героя группы", "ACTOR_FORBIDDEN"));
    }
    if v.actor_fate.as_ref().and_then(|fate| fate.get("status")).and_then(Value::as_str) != Some("dead") {
        return Err(rule("У этого героя нет неразрешённой смерти", "HERO_DEATH_NOT_PENDING"));
    }
    let resolution = v.command.get("resolution").and_then(Value::as_str);
    if !matches!(resolution, Some("resurrect" | "replace")) {
        return Err(rule("Нужно выбрать воскрешение или нового героя", "INVALID_DEATH_RESOLUTION"));
    }
    if resolution == Some("replace") && replacement_name_length(v.command.get("replacement_name")) < 2 {
        return Err(rule("Укажите имя нового героя", "REPLACEMENT_NAME_REQUIRED"));
    }
    Ok(())
}

/// `command.replacement_name.length` (после `normalizeCommand` — строка).
fn replacement_name_length(value: Option<&Value>) -> usize {
    match value {
        Some(Value::String(text)) => len_utf16(text),
        Some(Value::Array(items)) => items.len(),
        _ => 0,
    }
}

/// `Number(value) >= REST_EVENT_SCHEMA_VERSION`.
fn rest_schema_current(rest: Option<&Value>) -> bool {
    js::number(rest.and_then(|rest| rest.get("schema_version"))) >= REST_EVENT_SCHEMA_VERSION as f64
}

/// Блок 58 (6994–7042): отдых.
pub fn check_rest(v: &mut Validation<'_>) -> Step {
    let kind_of_command = command_type(v);
    if !matches!(kind_of_command.as_str(), "StartRest" | "SpendHitPointDie" | "CompleteRest") {
        return Ok(());
    }
    let kind = if v.command.get("kind").and_then(Value::as_str) == Some("long") { "long" } else { "short" };
    set_field(&mut v.command, "kind", Value::String(kind.into()));
    let state = v.state;
    if sk_core::game::combat_active(state) {
        return Err(rule("Нельзя отдыхать во время активного боя", "REST_DURING_COMBAT"));
    }
    let actor_id = js::string(v.command.get("actor_id"));
    let finder_id = js::s(v.command.get("actor_id"));
    if !sk_core::game::find_actor(state, &finder_id).is_some_and(sk_core::game::is_living_actor) {
        return Err(rule("Отдых доступен только живому герою с хитами", "REST_ACTOR_INCAPACITATED"));
    }
    let active_rest = sk_core::game::mechanics(state).get("resting").and_then(|all| all.get(&actor_id)).filter(|rest| js::truthy(Some(rest)));
    if kind_of_command == "StartRest" && active_rest.is_some() {
        return Err(rule("Герой уже отдыхает", "REST_ALREADY_STARTED"));
    }
    if kind_of_command == "CompleteRest" && active_rest.is_none() {
        return Err(rule("Сначала нужно начать отдых", "REST_NOT_STARTED"));
    }
    let rest_field = |key: &str| active_rest.and_then(|rest| rest.get(key));
    if kind_of_command == "CompleteRest" && rest_field("reason").and_then(Value::as_str) == Some("knockout") {
        return Err(rule("Восстановление после нокаута завершается сервером по таймеру, лечением или первой помощью", "KNOCKOUT_REST_AUTOMATIC"));
    }
    if kind_of_command == "CompleteRest" && rest_field("kind").and_then(Value::as_str) != Some(kind) {
        return Err(rule("Тип завершённого отдыха не совпадает с начатым", "REST_KIND_MISMATCH"));
    }
    if kind_of_command != "StartRest" {
        if let Some(rest) = active_rest {
            let expected = js::s(crate::conditions::nullish_chain(&[v.command.get("rest_id"), rest.get("rest_id")]));
            if rest_schema_current(Some(rest)) && expected != js::s(rest.get("rest_id")) {
                return Err(rule("Идентификатор отдыха не совпадает с активным", "REST_ID_MISMATCH"));
            }
            set_field(&mut v.command, "rest_id", Value::String(expected));
        }
    }
    if kind_of_command == "CompleteRest" && rest_schema_current(active_rest) {
        // Запас `REST_MINIMUM_MINUTES[kind]` у чужого вида — `undefined`, то
        // есть значение `safeInteger` по умолчанию 0.
        let fallback = rest_field("kind").and_then(Value::as_str).and_then(rest_minimum_minutes).unwrap_or(0);
        let minimum = js::safe_int(rest_field("minimum_duration_minutes"), fallback).max(REST_MINIMUM_MINUTES_SHORT);
        if elapsed_rest_minutes(state, active_rest) < minimum {
            return Err(rule("Отдых ещё не достиг минимальной длительности", "REST_DURATION_INSUFFICIENT"));
        }
    }
    if kind_of_command == "SpendHitPointDie" {
        let actor = player_actor(state, v.command.get("actor_id"));
        if active_rest.is_none() || rest_field("kind").and_then(Value::as_str) != Some("short") || js::number(rest_field("schema_version")) < REST_EVENT_SCHEMA_VERSION as f64 {
            return Err(rule("Кость хитов можно тратить только во время короткого отдыха", "HIT_POINT_DIE_REST_REQUIRED"));
        }
        if elapsed_rest_minutes(state, active_rest) < REST_MINIMUM_MINUTES_SHORT {
            return Err(rule("Короткий отдых ещё не завершён", "REST_DURATION_INSUFFICIENT"));
        }
        let Some(actor) = actor.filter(|actor| sk_core::game::actor_hp(actor) > 0) else {
            return Err(rule("Герой без хитов не может тратить кости хитов", "HIT_POINT_DIE_ACTOR_INCAPACITATED"));
        };
        if sk_core::game::actor_hp(actor) >= actor_max_hp(Some(actor)) {
            return Err(rule("У героя уже полные хиты", "HIT_POINTS_ALREADY_FULL"));
        }
        if !hit_point_dice_pool_for_actor(state, &js::s(v.command.get("actor_id"))).is_some_and(|pool| pool.spent < pool.maximum) {
            return Err(rule("Кости хитов закончились", "HIT_POINT_DICE_EXHAUSTED"));
        }
    }
    Ok(())
}

/// Блок 61 (7058–7060): лечение не поднимает погибшего.
pub fn check_healing_dead_hero(v: &mut Validation<'_>) -> Step {
    if command_type(v) == "ApplyHealing" && is_dead_hero(v.state, &js::string(Some(&target_for(&v.command)))) {
        return Err(rule("Обычное лечение не возвращает погибшего героя к жизни", "HERO_DEAD_UNRESOLVED"));
    }
    Ok(())
}

/// Блок 62 (7061–7063): уменьшение максимума хитов.
pub fn check_reduce_hit_point_maximum(v: &mut Validation<'_>) -> Step {
    if command_type(v) == "ReduceHitPointMaximum" && !v.context.truthy("isAdmin") && !v.context.truthy("serverAuthoritativeCombat") {
        return Err(rule("Уменьшать максимум ОЗ может только доверенный серверный эффект", "MAX_HP_REDUCTION_FORBIDDEN"));
    }
    Ok(())
}

/// Блок 70 (7569–7585): опознание противника.
pub fn check_identify_enemy(v: &mut Validation<'_>) -> Step {
    if command_type(v) != "IdentifyEnemy" {
        return Ok(());
    }
    let state = v.state;
    let actor_id = js::s(v.command.get("actor_id"));
    let target_id = js::s(v.command.get("target_id"));
    if !sk_core::game::find_actor(state, &actor_id).is_some_and(sk_core::game::is_living_actor) {
        return Err(rule("Опознавать противника может только живой герой", "ACTOR_DEFEATED"));
    }
    if sk_core::game::is_enemy_actor(state, &actor_id) {
        return Err(rule("Опознание доступно отряду, а не противнику", "ACTOR_FORBIDDEN"));
    }
    if !sk_core::game::is_enemy_actor(state, &target_id) {
        return Err(rule("Опознать можно только противника", "INVALID_TARGET"));
    }
    if !sk_core::game::find_actor(state, &target_id).is_some_and(sk_core::game::is_living_actor) {
        return Err(rule("Побеждённого противника опознавать поздно", "INVALID_TARGET"));
    }
    let known = crate::conditions::at_path(Some(sk_core::game::mechanics(state)), &["enemy_knowledge", "party", &target_id]);
    let exact = |key: &str| crate::conditions::at(known, key).and_then(Value::as_str) == Some("exact");
    if exact("health") && exact("armor_class") {
        return Err(rule("Этот противник уже опознан", "ENEMY_ALREADY_IDENTIFIED"));
    }
    set_field(&mut v.command, "target_id", Value::String(target_id.clone()));
    set_field(&mut v.command, "target_ids", json!([target_id]));
    Ok(())
}

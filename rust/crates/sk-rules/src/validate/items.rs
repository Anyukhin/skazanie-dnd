//! Блоки `validateCommand`: Предметы: предметы NPC, жизненный цикл предметов, выдача. Задача Р11.
//!
//! JS: `server/rules-engine.mjs`, 6714–6763, 7201–7221. Порядок блоков задаёт
//! `validate/mod.rs` (Р0); здесь — только тела.

use serde_json::Value;
use sk_core::{game, js, text};
use sk_items_life::item_lifecycle::{carrying_capacity, inventory_weight, validate_item_lifecycle_command, ItemLifecycleError};

use super::common::strict_equal;
use super::Validation;
use crate::combat::npc_items::validate_npc_item_use_command;
use crate::command::types::ITEM_LIFECYCLE_COMMAND_TYPES;
use crate::pause::{rule, Fault, Halt, Step};
use crate::targets::{distance_between_actors, is_dead_hero, is_dying_hero};

fn command_type(v: &Validation<'_>) -> String {
    js::s(v.command.get("command_type"))
}

/// `ItemLifecycleValidationError` → `RulesValidationError`; прочее (`TypeError`) — как есть.
pub(crate) fn item_lifecycle_halt(error: ItemLifecycleError) -> Halt {
    match error {
        ItemLifecycleError::Validation { message, code } => rule(message, &code),
        ItemLifecycleError::Type(message) => Fault::type_error(message).into(),
    }
}

/// `command.use_profile?.<key>`.
fn use_profile<'a>(command: &'a Value, key: &str) -> Option<&'a Value> {
    command.get("use_profile").and_then(Value::as_object).and_then(|profile| profile.get(key))
}

/// Блок 32 (6714–6763): предметы NPC и жизненный цикл предметов (с объявлением 31).
pub fn check_item_use(v: &mut Validation<'_>) -> Step {
    let kind = command_type(v);
    let actor_id = js::s(v.command.get("actor_id"));
    let npc_item_use = kind == "UseItem" && game::is_enemy_actor(v.state, &actor_id);
    if npc_item_use {
        let patch = validate_npc_item_use_command(&v.command, v.state, v.context)?;
        js::assign(&mut v.command, patch);
        return Ok(());
    }
    if !ITEM_LIFECYCLE_COMMAND_TYPES.contains(&kind.as_str()) {
        return Ok(());
    }
    let context = v.context.json();
    let patch = validate_item_lifecycle_command(&v.command, v.state, Some(&context)).map_err(item_lifecycle_halt)?;
    js::assign(&mut v.command, patch);
    if kind != "UseItem" {
        return Ok(());
    }
    let actor_id = js::s(v.command.get("actor_id"));
    let target_id = js::s(v.command.get("target_id"));
    if !strict_equal(v.command.get("target_id"), v.command.get("actor_id")) {
        let distance = distance_between_actors(v.state, &actor_id, &target_id);
        let range = js::safe_int(use_profile(&v.command, "range_feet"), 0).max(0) as f64;
        // `distance == null || distance > range`: NaN проходит, как в JS.
        let Some(distance) = distance.filter(|distance| !(*distance > range)) else {
            return Err(rule("Цель находится слишком далеко для использования предмета", "ITEM_TARGET_OUT_OF_RANGE"));
        };
        if js::is_true(use_profile(&v.command, "requires_line_of_sight")) && distance > 5.0 {
            let from = crate::tactical_geometry::actor_point(v.state, &actor_id);
            let to = crate::tactical_geometry::actor_point(v.state, &target_id);
            crate::geometry::forced::assert_clear_actor_trajectory(v.state, &actor_id, &target_id, from, to, false)?;
        }
    }
    let target = game::find_actor(v.state, &target_id);
    let profile_kind = use_profile(&v.command, "kind").and_then(Value::as_str);
    let dead = match target {
        None => true,
        Some(target) => is_dead_hero(v.state, &target_id) || target.get("alive") == Some(&Value::Bool(false)) || (profile_kind == Some("cast_spell") && !game::is_living_actor(target)),
    };
    if dead {
        return Err(rule("Предмет можно использовать только на живую цель", "ITEM_TARGET_DEAD"));
    }
    if profile_kind == Some("knight_tear") && js::string(v.command.get("target_id")) != js::string(v.command.get("actor_id")) {
        let boss_id = sk_scenario::campaign_scenario::scenario_progress(v.state).map(|progress| progress.boss.npc_id).unwrap_or_default();
        if boss_id.is_empty() || js::string(v.command.get("target_id")) != boss_id {
            return Err(rule("Слезу направляют на себя (щит) или на дракона (Хрупкая Чешуя)", "INVALID_ITEM_TARGET"));
        }
        if !game::combat_active(v.state) {
            return Err(rule("«Хрупкая Чешуя» действует только в бою с драконом", "COMBAT_NOT_ACTIVE"));
        }
    }
    if profile_kind == Some("stabilize") {
        let tracker_key = js::string(v.command.get("target_id"));
        let stable = js::path(v.state, &["mechanics", "death", "saving_throws"]).and_then(|all| all.get(tracker_key.as_str())).and_then(|tracker| tracker.get("stable"));
        if target.map_or(0, game::actor_hp) > 0 {
            return Err(rule("Стабилизация нужна только герою с 0 хитов", "ITEM_TARGET_NOT_DYING"));
        }
        if js::is_true(stable) {
            return Err(rule("Герой уже стабилен", "ITEM_TARGET_STABLE"));
        }
        if !is_dying_hero(v.state, &target_id) {
            return Err(rule("Цель нельзя стабилизировать", "ITEM_TARGET_NOT_DYING"));
        }
    }
    Ok(())
}

/// Блок 65 (7201–7221): выдача предмета.
pub fn check_grant_item(v: &mut Validation<'_>) -> Step {
    if command_type(v) != "GrantItem" {
        return Ok(());
    }
    let actor = game::find_actor(v.state, &js::s(v.command.get("actor_id")));
    let empty = js::obj();
    let source = match v.command.get("item") {
        None | Some(Value::Null) => &empty,
        Some(item) => item,
    };
    let catalog_raw = crate::core::coalesce(&[source.get("catalog_id"), source.get("catalogId")]);
    let catalog_id = text::trim(&js::s(catalog_raw)).to_string();
    let declared_origin = sk_items::item_catalog::normalize_item_origin_kind(source.get("origin"), "gifted");
    let materialized = if catalog_id.is_empty() { source.clone() } else { sk_items::item_catalog::materialize_catalog_item(&catalog_id, Some(source)) };
    let id_fallback = format!("grant:{}", js::string(v.command.get("command_id")));
    let options = sk_economy::merchant_economy::InventoryItemOptions { id_fallback: &id_fallback, preserve_unknown: true, hydrate_catalog: false };
    let mut item = sk_economy::merchant_economy::normalize_inventory_item(Some(&materialized), options);
    let origin = if declared_origin == "stolen" { "gifted".to_string() } else { declared_origin };
    if let Some(map) = item.as_object_mut() {
        map.insert("origin".into(), Value::String(origin));
    }
    let weight_value = inventory_weight(actor).map_err(item_lifecycle_halt)?;
    let weight = js::number(Some(&weight_value));
    let unit = js::number(item.get("weight"));
    let unit = if unit.is_nan() { 0.0 } else { unit.max(0.0) };
    let quantity = js::safe_int(item.get("quantity"), 1).max(1) as f64;
    if weight + unit * quantity > js::number(Some(&carrying_capacity(actor))) {
        return Err(rule("Награда превысит грузоподъёмность героя", "CARRYING_CAPACITY_EXCEEDED"));
    }
    if let Some(map) = v.command.as_object_mut() {
        map.insert("item".into(), item);
    }
    Ok(())
}

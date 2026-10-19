//! Блоки `validateCommand`: Сцена и карта: импорт, перестройка, смена сцены. Задача Р6.
//!
//! JS: `server/rules-engine.mjs`, 6843–6862, 6863–6878, 6879–6899. Порядок блоков задаёт
//! `validate/mod.rs` (Р0); здесь — только тела.

use serde_json::Value;
use sk_core::js;

use super::Validation;
use crate::normalize::scene::{normalize_party_decision_reference, normalize_scene_advance_args, normalize_scene_commerce};
use crate::pause::{rule, Halt, Step};
use crate::scene_maps::scene_location_id;

fn command_type(v: &Validation<'_>) -> String {
    js::s(v.command.get("command_type"))
}

/// `command.key = value`.
fn set_field(command: &mut Value, key: &str, value: Value) {
    if let Some(map) = command.as_object_mut() {
        map.insert(key.into(), value);
    }
}

/// Блок 44 (6843–6862): импорт карты.
pub fn check_import_location_map(v: &mut Validation<'_>) -> Step {
    if command_type(v) != "ImportLocationMap" {
        return Ok(());
    }
    if !v.context.is_true("mapImportAuthorized") {
        return Err(rule("Загружать карту может только ведущий кампании", "MAP_IMPORT_FORBIDDEN"));
    }
    let current_location_id = Value::String(scene_location_id(v.state));
    let location_id = match v.command.get("location_id").filter(|value| js::truthy(Some(value))) {
        Some(value) => value.clone(),
        None => current_location_id.clone(),
    };
    if !js::truthy(Some(&location_id)) {
        return Err(rule("Не выбрана локация для карты", "MAP_IMPORT_LOCATION_REQUIRED"));
    }
    let current = location_id == current_location_id;
    if !current && sk_geometry::world_map::world_location_by_id(v.state.get("worldMap"), &js::s(Some(&location_id))).is_none() {
        return Err(rule("Такой локации нет на карте мира кампании", "MAP_IMPORT_LOCATION_UNKNOWN"));
    }
    if current && sk_core::game::combat_active(v.state) {
        return Err(rule("Карту текущей сцены нельзя заменить во время боя", "MAP_IMPORT_DURING_COMBAT"));
    }
    if !js::truthy(v.command.get("slab")) {
        return Err(rule("Вставьте строку слэба TaleSpire", "SLAB_EMPTY"));
    }
    set_field(&mut v.command, "location_id", location_id);
    Ok(())
}

/// Блок 45 (6863–6878): перестройка карты.
pub fn check_rebuild_location_map(v: &mut Validation<'_>) -> Step {
    if command_type(v) != "RebuildLocationMap" {
        return Ok(());
    }
    if !v.context.is_true("mapImportAuthorized") {
        return Err(rule("Перестраивать карту может только ведущий кампании", "MAP_IMPORT_FORBIDDEN"));
    }
    if scene_location_id(v.state).is_empty() || !js::truthy(v.state.get("scene").and_then(|scene| scene.get("map"))) {
        return Err(rule("У текущей сцены нет карты, которую можно перестроить", "MAP_REBUILD_NO_SCENE"));
    }
    if sk_core::game::combat_active(v.state) {
        return Err(rule("Карту текущей сцены нельзя перестроить во время боя", "MAP_REBUILD_DURING_COMBAT"));
    }
    let interaction = v.state.get("agentInteraction");
    if js::truthy(interaction) {
        let status = match interaction.and_then(|interaction| interaction.get("status")).filter(|status| !status.is_null()) {
            Some(status) => js::s(Some(status)),
            None => "open".to_string(),
        };
        if ["open", "pending", "voting"].contains(&status.as_str()) {
            return Err(rule("Сначала завершите решение отряда: голосование идёт по этой карте", "MAP_REBUILD_DECISION_OPEN"));
        }
    }
    Ok(())
}

/// Блок 46 (6879–6899): смена сцены.
pub fn check_advance_scene(v: &mut Validation<'_>) -> Step {
    if command_type(v) != "AdvanceScene" {
        return Ok(());
    }
    if !v.context.is_admin() && !v.context.is_director() {
        return Err(rule("Переход между сценами доступен только системному контуру кампании", "SCENE_ADVANCE_FORBIDDEN"));
    }
    if sk_core::game::combat_active(v.state) {
        return Err(rule("Нельзя сменить сцену до завершения активного боя", "SCENE_ADVANCE_DURING_COMBAT"));
    }
    if sk_society::law_and_order::guard_encounter_is_here(v.state, None) {
        return Err(rule("Стража стоит перед отрядом: пока ей не ответили, отряд никуда не уходит", "GUARD_ENCOUNTER_BLOCKS_SCENE"));
    }
    // `normalizeCommand` JS (4649–4651) держит место `scene_args` и
    // `party_decision` даже без значения (`command.x = command.x ?? alias`
    // кладёт `undefined`), а каркас Rust такой ключ удаляет. От места зависит
    // порядок ключей проверенной команды: восстанавливаем его до присваиваний.
    if let Some(map) = v.command.as_object_mut() {
        for key in ["scene_args", "party_decision"] {
            if !map.contains_key(key) {
                map.insert(key.into(), Value::Null);
            }
        }
    }
    let args = normalize_scene_advance_args(v.command.get("scene_args")).map_err(Halt::Rule)?;
    let args = sk_scenario::campaign_scenario::scenario_scene_args(v.state, &args);
    set_field(&mut v.command, "scene_args", args);
    let commerce = normalize_scene_commerce(v.command.get("scene_commerce")).map_err(Halt::Rule)?;
    set_field(&mut v.command, "scene_commerce", commerce);
    let decision = normalize_party_decision_reference(v.command.get("party_decision"), v.context.is_director()).map_err(Halt::Rule)?;
    set_field(&mut v.command, "party_decision", decision);
    Ok(())
}

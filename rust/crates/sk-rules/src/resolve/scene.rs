//! Ветки `resolveCommandInternal`: Сцена, карта, время: переход между этажами, импорт и перестройка карты, смена сцены, время, раскрытие области, сущности. Задача Р6.
//!
//! JS: `server/rules-engine.mjs`, 19731–19804, 22332–22381, 22382–22484, 22485–22620, 22621–22626, 22761–22765, 22774–22776. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.
//!
//! Импорт слэба TaleSpire внедряется ([`crate::merchants::install_talespire_importer`]):
//! крейт импортёра сам зависит от `sk-rules`. Без зарегистрированного
//! импортёра `ImportLocationMap` отвечает ошибкой `TaleSpireImporterMissing`.

use std::sync::Arc;
use serde_json::{json, Map, Value};
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::js;
use sk_tactical::tactical_map::{deserialize_tactical_map, legacy_cells_from_tactical_map, serialize_tactical_map, TacticalMap, TacticalMapError};

use super::world_time::TimeAdvanceOptions;
use super::Resolve;
use crate::core::{command_with, event_from, npc_world_events_from, slice_utf16};
use crate::normalize::scene::canonical_scene_metadata;
use crate::normalize::summons::{party_summons_for_expiry, summon_expiry_events, summon_ids_expired_at};
use crate::pause::{rule, Fault, Interrupt, Flow};
use crate::scene::levels::{declared_scene_levels, level_arrival_positions, level_transition_back_to, plan_import_relocations, remembered_level_map, restore_scene_level_transitions, scene_level_label, LOCATION_MAP_IMPORT_SCHEMA_VERSION};
use crate::scene::placement::{map_error, scene_advance_party_ids, scene_advance_party_positions};
use crate::scene_maps::{scene_level_index, scene_location_id};

fn field(value: &Value, key: &str) -> Value {
    value.get(key).cloned().unwrap_or(Value::Null)
}

fn put(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value.clone());
    }
}

fn map_halt(error: TacticalMapError) -> Interrupt {
    Interrupt::Rule(map_error(error))
}

/// Ошибка `adventure-director` / `scene-memory`: класс JS как есть.
fn director_halt(error: sk_director::adventure_director::DirectorError) -> Interrupt {
    let fault = Fault::new(error.name, error.message);
    match error.code {
        Some(code) => fault.with_code(code).into(),
        None => fault.into(),
    }
}

fn serialize(map: &TacticalMap) -> Result<Value, Interrupt> {
    serialize_tactical_map(map).map_err(map_halt)
}

/// `[…positions].map((position) => position.actor_id)`.
fn position_actors(positions: &[Value]) -> Value {
    Value::Array(positions.iter().map(|position| field(position, "actor_id")).collect())
}

/// `planSceneNpcPlacementEvents(state)` событиями команды.
fn placement_events(command: &Value, state: &Value) -> Vec<Value> {
    let drafts = Value::Array(sk_npc_world::npc_positioning::plan_scene_npc_placement_events(state));
    npc_world_events_from(command, &drafts)
}

/// `{ entrance, scene: { cells, map } }` — вход новой карты для расстановки отряда.
fn entrance_transition(ground: &TacticalMap, serialized: &Value) -> Value {
    let mut transition = Map::new();
    if let Some(entrance) = ground.spawn_points.iter().find(|point| point.role == "party") {
        transition.insert("entrance".into(), entrance.to_json());
    }
    transition.insert("scene".into(), json!({ "cells": legacy_cells_from_tactical_map(ground), "map": serialized }));
    Value::Object(transition)
}

/// Призывы, чей срок истёк к моменту перехода: события и множество id.
fn expired_summon_events(r: &mut Resolve<'_>) -> IndexSet<String> {
    let now = crate::world_clock::world_time_seconds(&r.state);
    let expired: IndexSet<String> = summon_ids_expired_at(&r.state, now).into_iter().collect();
    let summons: Vec<Value> = party_summons_for_expiry(&r.state).into_iter().filter(|summon| expired.contains(&sk_core::game::actor_id(summon))).collect();
    let events = summon_expiry_events(&r.command, &r.state, &summons, true);
    r.events.extend(events);
    expired
}

/// `UseLevelTransition` (19731–19804).
pub fn use_level_transition(r: &mut Resolve<'_>) -> Flow {
    let Some(mut map) = crate::scene_map_sync::ensure_scene_tactical_map_shared(&mut r.state).map_err(map_halt)? else {
        return Err(rule("Для перехода между этажами нужна тактическая карта", "TACTICAL_MAP_REQUIRED"));
    };
    let prop_id = r.command.get("prop_id").cloned().unwrap_or(Value::Null);
    let find = |map: &TacticalMap| map.props.iter().position(|candidate| prop_id.as_str() == Some(candidate.id.as_str()));
    let mut index = find(&map);
    if index.and_then(|index| map.props[index].transition.as_ref()).is_none() && restore_scene_level_transitions(&r.state, &mut map) {
        crate::scene_map_sync::write_scene_tactical_map(Arc::make_mut(&mut r.state), &map).map_err(map_halt)?;
        index = find(&map);
    }
    let Some(prop) = index.map(|index| map.props[index].clone()).filter(|prop| prop.transition.is_some()) else {
        return Err(rule("Этот предмет не ведёт на другой этаж", "TRANSITION_NOT_FOUND"));
    };
    let Some(transition) = prop.transition.clone() else { return Err(rule("Этот предмет не ведёт на другой этаж", "TRANSITION_NOT_FOUND")) };
    if sk_core::game::combat_active(&r.state) {
        return Err(rule("Сначала завершите бой: между этажами в бою не ходят", "LEVEL_TRANSITION_IN_COMBAT"));
    }
    let actor_id = js::string(r.command.get("actor_id"));
    if !scene_advance_party_ids(&r.state).contains(&actor_id) {
        return Err(rule("Между этажами водит партию только её персонаж", "PARTY_MEMBER_REQUIRED"));
    }
    let actor_key = js::s(r.command.get("actor_id"));
    let Some(at) = crate::tactical_geometry::actor_point(&r.state, &actor_key) else {
        return Err(rule("Участник должен находиться на карте", "MAP_POSITION_REQUIRED"));
    };
    if crate::geometry::footprint::actor_object_distance_cells(&r.state, &actor_key, &prop.to_json(), Some(at)) > 1.0 {
        return Err(rule("До перехода нужно дойти: встаньте вплотную", "TRANSITION_TOO_FAR"));
    }
    let location_id = scene_location_id(&r.state);
    let from_level = map.level_index;
    let to_level = transition.to_level;
    let label = scene_level_label(&r.state, to_level, &transition.label);
    let mut target = remembered_level_map(&r.state, &location_id, to_level).map_err(map_halt)?;
    let mut generated = false;
    if target.is_none() {
        let declared = declared_scene_levels(&r.state).into_iter().find(|entry| js::number(entry.get("offset")) == to_level as f64);
        let declared_hint = js::s(declared.as_ref().and_then(|entry| entry.get("hint")));
        let hint = Value::String(if declared_hint.is_empty() { transition.label.clone() } else { declared_hint });
        let scene = r.state.get("scene");
        let base_seed = sk_director::adventure_director::memory::stable_location_map_seed(r.state.get("worldMap"), Some(&json!(location_id)), scene.and_then(|scene| scene.get("location")));
        let seed = Value::String(sk_director::adventure_director::memory::level_seed(&base_seed, to_level));
        let theme = Value::String(js::s(scene.and_then(|scene| scene.get("theme"))));
        let level = Value::from(to_level);
        let source_prop = prop.to_json();
        let options = sk_world_time::level_generator::LevelOptions {
            location_id: &location_id,
            level: Some(&level),
            seed: Some(&seed),
            base_map: Some(&map),
            source_prop: Some(&source_prop),
            hint: Some(&hint),
            theme: Some(&theme),
        };
        let result = sk_world_time::level_generator::generate_level_map(&options).map_err(|error| {
            let fault = Fault::new(error.name, error.message);
            Interrupt::from(match error.code {
                Some(code) => fault.with_code(code),
                None => fault,
            })
        })?;
        let Some(built) = result.map else {
            let (code, message) = match result.errors.first() {
                Some(issue) => (issue.code.clone(), issue.message.clone()),
                None => ("LEVEL_GENERATION_FAILED".to_string(), format!("Этаж {to_level} не удалось построить")),
            };
            return Err(rule(message, &code));
        };
        target = Some(built);
        generated = true;
    }
    let Some(target) = target else { return Ok(()) };
    let Some(arrival) = level_transition_back_to(&target, from_level).cloned() else {
        return Err(rule("На целевом этаже нет обратного перехода", "LEVEL_ARRIVAL_MISSING"));
    };
    let expired = expired_summon_events(r);
    let transition_state = if expired.is_empty() { r.state.clone() } else { Arc::new(r.project_events()?) };
    let positions = level_arrival_positions(&transition_state, &target, Some(&arrival)).map_err(Interrupt::Rule)?;
    let mut payload = Map::new();
    payload.insert("location_id".into(), json!(location_id));
    payload.insert("from_level".into(), json!(from_level));
    payload.insert("to_level".into(), json!(to_level));
    payload.insert("level_label".into(), json!(label));
    payload.insert("arrival_prop_id".into(), json!(arrival.id));
    payload.insert("party_positions".into(), Value::Array(positions.clone()));
    if generated {
        payload.insert("map".into(), serialize(&target)?);
    }
    let targets = position_actors(&positions);
    r.events.push(event_from(&r.command, "MapLevelChanged", Some(Value::Object(payload)), Some(&targets)));
    Ok(())
}

/// `importTaleSpireSlab` через зарегистрированный импортёр.
fn import_slab(slab: Option<&Value>, location_id: &str, theme: &str) -> Result<Value, Interrupt> {
    let Some(importer) = crate::merchants::talespire_importer() else {
        return Err(Fault::new("TaleSpireImporterMissing", "Импортёр TaleSpire не зарегистрирован").into());
    };
    importer(slab.and_then(Value::as_str), location_id, theme).map_err(|failure| {
        if failure.name == "TaleSpireSlabError" || failure.name == "TaleSpireImportError" {
            rule(failure.message, &failure.code)
        } else {
            Fault::new(failure.name, failure.message).with_code(failure.code).into()
        }
    })
}

/// `String(primary ?? secondary ?? fallback).slice(0, 120) || fallback`.
fn location_name(primary: Option<&Value>, secondary: Option<&Value>, fallback: &Value) -> Value {
    let chosen = primary.filter(|value| !value.is_null()).or_else(|| secondary.filter(|value| !value.is_null()));
    let text = match chosen {
        Some(value) => js::s(Some(value)),
        None => js::string(Some(fallback)),
    };
    let text = slice_utf16(&text, 120);
    if text.is_empty() {
        fallback.clone()
    } else {
        Value::String(text)
    }
}

/// `ImportLocationMap` (22332–22381).
pub fn import_location_map(r: &mut Resolve<'_>) -> Flow {
    let location_id = field(&r.command, "location_id");
    let current = location_id.as_str() == Some(scene_location_id(&r.state).as_str());
    let location = sk_geometry::world_map::world_location_by_id(r.state.get("worldMap"), &js::s(Some(&location_id))).cloned();
    let scene = r.state.get("scene").cloned().unwrap_or(Value::Null);
    let theme = if current { slice_utf16(&js::s(scene.get("theme")), 60) } else { String::new() };
    let imported = import_slab(r.command.get("slab"), &js::s(Some(&location_id)), &theme)?;
    let mut payload = Map::new();
    payload.insert("schema_version".into(), json!(LOCATION_MAP_IMPORT_SCHEMA_VERSION));
    payload.insert("location_id".into(), location_id.clone());
    let scene_location = if current { scene.get("location").cloned() } else { Some(json!("")) };
    payload.insert("location_name".into(), location_name(location.as_ref().and_then(|location| location.get("name")), scene_location.as_ref(), &location_id));
    put(&mut payload, "source", imported.get("source"));
    put(&mut payload, "stats", imported.get("stats"));
    let warnings: Vec<Value> = imported.get("warnings").and_then(Value::as_array).map(|items| items.iter().take(20).cloned().collect()).unwrap_or_default();
    payload.insert("warnings".into(), Value::Array(warnings));
    put(&mut payload, "levels", imported.get("levels"));
    payload.insert("applied_to_scene".into(), json!(current));
    let mut positions = Vec::new();
    if current {
        let ground_value = imported.get("levels").and_then(Value::as_array).and_then(|levels| levels.iter().find(|level| level.get("index") == Some(&json!(0)))).and_then(|level| level.get("map")).cloned();
        let Some(ground_value) = ground_value else { return Err(Fault::type_error("Cannot read properties of undefined (reading 'map')").into()) };
        let ground = deserialize_tactical_map(&ground_value).map_err(map_halt)?;
        let serialized = serialize(&ground)?;
        positions = scene_advance_party_positions(&r.state, &entrance_transition(&ground, &serialized)).map_err(Interrupt::Rule)?;
        payload.insert("party_positions".into(), Value::Array(positions.clone()));
        payload.insert("relocations".into(), Value::Array(plan_import_relocations(&r.state, &ground, &positions)));
    }
    let source = command_with(&r.command, "visibility", json!(if current { "party" } else { "gm_only" }));
    let targets = if current { position_actors(&positions) } else { json!([]) };
    let event = event_from(&source, "LocationMapImported", Some(Value::Object(payload)), Some(&targets));
    r.events.push(event.clone());
    if current {
        let applied = crate::replay::apply_game_event(&r.state, &event)?;
        r.events.extend(placement_events(&r.command, &applied));
    }
    Ok(())
}

/// `RebuildLocationMap` (22382–22484).
pub fn rebuild_location_map(r: &mut Resolve<'_>) -> Flow {
    let location_id = scene_location_id(&r.state);
    let scene = r.state.get("scene").cloned().unwrap_or_else(|| json!({}));
    if js::is_true(r.command.get("preserve_layout")) {
        return refresh_location_floors(r, &location_id, &scene);
    }
    let location = js::s(scene.get("location"));
    let wanted = sk_core::text::lower(&location);
    let residents: Vec<Value> = r
        .state
        .get("social")
        .and_then(|social| social.get("npcs"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter(|npc| !js::is_false(npc.get("available")) && sk_core::text::lower(&js::s(npc.get("location"))) == wanted)
        .map(|npc| {
            let mut resident = Map::new();
            put(&mut resident, "name", npc.get("name"));
            put(&mut resident, "role", npc.get("role"));
            put(&mut resident, "summary", npc.get("public_summary"));
            Value::Object(resident)
        })
        .collect();
    let stored = sk_scene_base::scene_requirements::normalize_scene_requirements(scene.get("map_requirements").unwrap_or(&Value::Null));
    let texts = Value::Array(vec![json!(location), field(&scene, "title"), field(&scene, "mood"), field(&scene, "objective"), field(&r.command, "text")]);
    let fresh = sk_scene_base::scene_requirements::scene_map_requirements_for(&texts, Some(&Value::Array(residents)), None).map(|program| program.to_value());
    let program = if !stored.is_empty() && !js::truthy(r.command.get("text")) { scene.get("map_requirements").cloned() } else { fresh };
    let program = program.filter(|program| js::truthy(Some(program)));
    let base_seed = sk_director::adventure_director::memory::stable_location_map_seed(r.state.get("worldMap"), Some(&json!(location_id)), Some(&json!(location)));
    let seed = format!("{base_seed}:rebuild:{}", js::safe_int(r.state.get("state_version"), 0));
    let description: Vec<String> = [scene.get("title"), scene.get("mood"), r.command.get("text")].into_iter().filter(|value| js::truthy(*value)).map(js::s).collect();
    let mut input = Map::new();
    input.insert("theme".into(), json!(js::s(scene.get("theme"))));
    input.insert("location".into(), json!(location));
    input.insert("sceneKind".into(), json!(js::s(scene.get("scene_kind"))));
    input.insert("worldKind".into(), json!(sk_director::adventure_director::memory::known_world_kind(r.state.get("worldMap"), Some(&json!(location_id)), Some(&json!(location)))));
    input.insert("seed".into(), json!(seed));
    input.insert("locationId".into(), json!(location_id));
    input.insert("description".into(), json!(slice_utf16(&description.join(" "), 2_000)));
    input.insert("useLibrary".into(), json!(false));
    input.insert("requirements".into(), program.as_ref().and_then(|program| program.get("items")).filter(|items| !items.is_null()).cloned().unwrap_or_else(|| json!([])));
    input.insert("program".into(), program.clone().unwrap_or(Value::Null));
    let geometry = sk_director::adventure_director::geometry::generate_scene_geometry(&Value::Object(input)).map_err(director_halt)?;
    let mut ground = geometry.map;
    ground.location_id = location_id.clone();
    let serialized = serialize(&ground)?;
    let missing = geometry.missing.unwrap_or_default();
    let mut payload = Map::new();
    payload.insert("schema_version".into(), json!(2));
    payload.insert("location_id".into(), json!(location_id));
    let world_name = sk_geometry::world_map::world_location_by_id(r.state.get("worldMap"), &location_id).and_then(|node| node.get("name")).cloned();
    payload.insert("location_name".into(), location_name(world_name.as_ref(), Some(&json!(location)), &json!(location_id)));
    payload.insert("source".into(), json!({ "format": "scene-program-rebuild", "version": sk_scene_base::scene_requirements::SCENE_REQUIREMENTS_VERSION, "seed": seed }));
    payload.insert("stats".into(), json!({}));
    payload.insert("warnings".into(), Value::Array(missing.iter().map(|id| json!(format!("Обязательное не встало на карту: {id}"))).take(20).collect()));
    let level_label = slice_utf16(&ground.level_label, 120);
    let level_label = if level_label.is_empty() { scene_level_label(&r.state, 0, "") } else { level_label };
    payload.insert("levels".into(), json!([{ "index": 0, "label": level_label, "map": serialized }]));
    payload.insert("applied_to_scene".into(), json!(true));
    if let Some(program) = &program {
        let mut requirements = crate::core::spread_value(Some(program));
        if !missing.is_empty() {
            requirements.insert("missing".into(), json!(missing));
        }
        payload.insert("map_requirements".into(), Value::Object(requirements));
    }
    payload.insert("clear_library_source".into(), json!(true));
    let positions = scene_advance_party_positions(&r.state, &entrance_transition(&ground, &serialized)).map_err(Interrupt::Rule)?;
    payload.insert("party_positions".into(), Value::Array(positions.clone()));
    payload.insert("relocations".into(), Value::Array(plan_import_relocations(&r.state, &ground, &positions)));
    let source = command_with(&r.command, "visibility", json!("party"));
    let event = event_from(&source, "LocationMapImported", Some(Value::Object(payload)), Some(&position_actors(&positions)));
    r.events.push(event.clone());
    let applied = crate::replay::apply_game_event(&r.state, &event)?;
    r.events.extend(placement_events(&r.command, &applied));
    Ok(())
}

/// Ремонт карты ведущим (`preserve_layout`, 22363–22410): геометрия всех
/// этажей остаётся, перекрашивается пол внутри помещений.
fn refresh_location_floors(r: &mut Resolve<'_>, location_id: &str, scene: &Value) -> Flow {
    let active_level = scene_level_index(&r.state);
    let no_scene = || rule::<Interrupt>("Текущая карта повреждена и не может быть обновлена", "MAP_REBUILD_NO_SCENE");
    let mut maps: IndexMap<i64, TacticalMap> = IndexMap::new();
    let current = deserialize_tactical_map(scene.get("map").unwrap_or(&Value::Null)).map_err(|_| no_scene())?;
    maps.insert(active_level, current);
    let mut levels: IndexSet<i64> = IndexSet::new();
    levels.insert(0);
    levels.insert(active_level);
    let prefix = format!("{location_id}@L");
    if let Some(location_maps) = r.state.get("locationMaps").and_then(Value::as_object) {
        for key in js::keys(location_maps) {
            if key == location_id {
                levels.insert(0);
            } else if let Some(rest) = key.strip_prefix(&prefix) {
                let level = js::parse_number(rest);
                if crate::core::is_safe_integer_f64(level) {
                    levels.insert(level as i64);
                }
            }
        }
    }
    let mut sorted: Vec<i64> = levels.into_iter().collect();
    sorted.sort();
    for level in sorted {
        if maps.contains_key(&level) {
            continue;
        }
        if let Some(remembered) = remembered_level_map(&r.state, location_id, level).map_err(map_halt)? {
            maps.insert(level, remembered);
        }
    }
    if !maps.contains_key(&0) {
        return Err(rule("Для обновления покрытия нужен сохранённый этаж входа", "MAP_REBUILD_NO_SCENE"));
    }
    let scene_theme = js::s(scene.get("theme"));
    let mut refreshed = 0usize;
    for map in maps.values_mut() {
        let theme = if map.theme.is_empty() { scene_theme.clone() } else { map.theme.clone() };
        refreshed += sk_director::adventure_director::geometry::refresh_scene_floors(map, &theme).map_err(director_halt)?;
    }
    let mut entries: Vec<(&i64, &TacticalMap)> = maps.iter().collect();
    entries.sort_by_key(|(index, _)| **index);
    let mut levels_payload = Vec::new();
    for (index, map) in entries {
        let label = slice_utf16(&map.level_label, 120);
        let label = if label.is_empty() { scene_level_label(&r.state, *index, "") } else { label };
        levels_payload.push(json!({ "index": index, "label": label, "map": serialize(map)? }));
    }
    let world_name = sk_geometry::world_map::world_location_by_id(r.state.get("worldMap"), location_id).and_then(|node| node.get("name")).cloned();
    let mut payload = Map::new();
    payload.insert("schema_version".into(), json!(2));
    payload.insert("location_id".into(), json!(location_id));
    payload.insert("location_name".into(), location_name(world_name.as_ref(), scene.get("location"), &json!(location_id)));
    payload.insert("source".into(), json!({ "format": "scene-floor-refresh", "version": 1 }));
    payload.insert("stats".into(), json!({ "floor_zones": refreshed }));
    payload.insert("warnings".into(), json!([]));
    payload.insert("levels".into(), Value::Array(levels_payload));
    payload.insert("applied_to_scene".into(), json!(true));
    payload.insert("preserve_layout".into(), json!(true));
    let source = command_with(&r.command, "visibility", json!("party"));
    let targets = js::strings_value(scene_advance_party_ids(&r.state));
    r.events.push(event_from(&source, "LocationMapImported", Some(Value::Object(payload)), Some(&targets)));
    Ok(())
}

/// Первое истинное значение цепочки `a || b || …`.
fn first_truthy<'a>(values: &[Option<&'a Value>]) -> Option<&'a Value> {
    values.iter().copied().find(|value| js::truthy(*value)).flatten()
}

/// Событие из черновика модуля с его видимостью.
fn draft_event(command: &Value, draft: &Value) -> Value {
    let source = command_with(command, "visibility", field(draft, "visibility"));
    event_from(&source, &js::s(draft.get("event_type")), draft.get("payload").cloned(), draft.get("target_ids"))
}

/// `AdvanceScene` (22485–22620).
pub fn advance_scene(r: &mut Resolve<'_>) -> Flow {
    expired_summon_events(r);
    if js::truthy(r.command.get("party_decision")) {
        let decision = r.state.get("agentInteraction").cloned().unwrap_or(Value::Null);
        let reference = field(&r.command, "party_decision");
        let linked = js::truthy(Some(&decision))
            && decision.get("status").and_then(Value::as_str) == Some("resolved")
            && js::string(decision.get("id")) == js::string(reference.get("interaction_id"))
            && js::string(decision.get("resolvedOptionId")) == js::string(reference.get("resolved_option_id"));
        if !linked {
            return Err(rule("Переход сцены не связан с текущим подтверждённым решением группы", "PARTY_DECISION_REQUIRED"));
        }
        let eligible = decision.get("eligibleActorIds").filter(|value| !value.is_null()).cloned().unwrap_or_else(|| json!([]));
        let mut payload = Map::new();
        put(&mut payload, "interaction_id", decision.get("id"));
        put(&mut payload, "resolved_option_id", decision.get("resolvedOptionId"));
        r.events.push(event_from(&r.command, "PartyDecisionConsumed", Some(Value::Object(payload)), Some(&eligible)));
    }
    let minutes = js::num(sk_social::npc_social::campaign_elapsed_minutes(&r.state));
    let closed = crate::society_helpers::tavern_rounds_closed_by_departure(&r.command, &r.state, &minutes);
    r.events.extend(closed);
    let scene_args = field(&r.command, "scene_args");
    let transition = sk_director::adventure_director::transition::create_scene_transition(&scene_args, &r.state).map_err(director_halt)?;
    let metadata = canonical_scene_metadata(&scene_args, Some(&transition));
    let mut canonical = crate::core::spread_value(Some(&transition));
    let mut canonical_scene = crate::core::spread_value(transition.get("scene"));
    for (key, value) in crate::core::spread_value(Some(&metadata)) {
        canonical_scene.insert(key, value);
    }
    canonical.insert("scene".into(), Value::Object(canonical_scene));
    let canonical = Value::Object(canonical);
    let positions = scene_advance_party_positions(&r.state, &canonical).map_err(Interrupt::Rule)?;
    let scene_event_id = sk_director::scene_memory::scene_world_memory_event_id(r.command.get("command_id"));
    let mut payload = crate::core::spread_value(Some(&canonical));
    for (key, value) in crate::core::spread_value(Some(&metadata)) {
        payload.insert(key, value);
    }
    let state_scene = r.state.get("scene").cloned().unwrap_or(Value::Null);
    payload.insert("location_before".into(), json!(js::s(state_scene.get("location"))));
    payload.insert("location_after".into(), json!(js::s(canonical.get("scene").and_then(|scene| scene.get("location")))));
    payload.insert("party_positions".into(), Value::Array(positions.clone()));
    put(&mut payload, "scene_commerce", r.command.get("scene_commerce"));
    put(&mut payload, "party_decision", r.command.get("party_decision"));
    put(&mut payload, "request_fingerprint", r.command.get("request_fingerprint"));
    payload.insert("summon_lifecycle_version".into(), json!(crate::constants::SUMMON_LIFECYCLE_VERSION));
    let mut scene_event = event_from(&r.command, "SceneAdvanced", Some(Value::Object(payload)), Some(&position_actors(&positions)));
    scene_event["event_id"] = json!(scene_event_id);
    r.events.push(scene_event.clone());
    let mut transitioned = crate::replay::apply_game_event(&r.state, &scene_event)?;
    if let Some(sky) = sk_world_time::weather::region_weather_event_draft(&r.state, &transitioned) {
        let source = command_with(&r.command, "visibility", field(&sky, "visibility"));
        r.events.push(event_from(&source, &js::s(sky.get("event_type")), sky.get("payload").cloned(), Some(&json!([]))));
    }
    let captives = Value::Array(sk_world_life::captives::plan_captive_relocation_drafts(&transitioned));
    for relocation in npc_world_events_from(&r.command, &captives) {
        transitioned = crate::replay::apply_game_event(&transitioned, &relocation)?;
        r.events.push(relocation);
    }
    let beasts = Value::Array(sk_npc_world::beast_taming::plan_beast_follow_drafts(&transitioned));
    for follow in npc_world_events_from(&r.command, &beasts) {
        transitioned = crate::replay::apply_game_event(&transitioned, &follow)?;
        r.events.push(follow);
    }
    let location_after_id = js::s(transitioned.get("scene").and_then(|scene| scene.get("location_id")));
    for npc in sk_scenario::campaign_scenario::scenario_location_npcs(&transitioned, &location_after_id) {
        let known = transitioned.get("social").and_then(|social| social.get("npcs")).and_then(Value::as_array).is_some_and(|npcs| npcs.iter().any(|existing| existing.get("id") == npc.get("id")));
        if known {
            continue;
        }
        let system = command_with(&r.command, "actor_id", Value::Null);
        let mut request = command_with(&system, "command_type", json!("UpsertNpcSocialProfile"));
        let mut profile = crate::core::spread_value(Some(&npc));
        // `{ ...npc, location: transitionedState.scene?.location }`: `undefined` стирает своё поле.
        match transitioned.get("scene").and_then(|scene| scene.get("location")) {
            Some(location) => profile.insert("location".into(), location.clone()),
            None => profile.shift_remove("location"),
        };
        request["npc"] = Value::Object(profile);
        let upsert = sk_social::npc_social::validate_npc_social_command(&request, &transitioned, &json!({ "isDirector": true }))
            .map_err(|error| Interrupt::Fault(Fault::new("NpcSocialValidationError", error.message.clone()).with_code(error.code.clone())))?;
        for social in sk_social::npc_social::npc_social_events(&upsert, &transitioned) {
            let event = draft_event(&system, &social);
            transitioned = crate::replay::apply_game_event(&transitioned, &event)?;
            r.events.push(event);
        }
    }
    r.events.extend(placement_events(&r.command, &transitioned));
    let options = json!({ "commandId": field(&r.command, "command_id") });
    if let Some(encounter) = sk_society::law_and_order::guard_encounter_trigger_for(&transitioned, &options) {
        let source = command_with(&r.command, "visibility", json!("party"));
        let payload = json!({
            "encounter": encounter,
            "options": sk_society::law_and_order::guard_options_for(Some(&encounter)),
            "policy_id": sk_society::law_and_order::LAW_POLICY_ID,
        });
        r.events.push(event_from(&source, "GuardEncounterStarted", Some(payload), Some(&json!([]))));
    }
    let location_id = js::s(canonical.get("scene").and_then(|scene| scene.get("location_id")));
    let mut memory_options = Map::new();
    memory_options.insert("commandId".into(), field(&r.command, "command_id"));
    memory_options.insert("sourceEventId".into(), json!(scene_event_id));
    put(&mut memory_options, "secrets", scene_args.get("secrets"));
    memory_options.insert("scenarioSecrets".into(), Value::Array(sk_scenario::campaign_scenario::scenario_secrets_for(&r.state, &location_id)));
    let memory = sk_director::scene_memory::scene_world_memory_events(&r.state, Some(&canonical), Some(&Value::Object(memory_options))).map_err(director_halt)?;
    for draft in memory {
        r.events.push(draft_event(&r.command, &draft));
    }
    let prior_title = match first_truthy(&[state_scene.get("title"), state_scene.get("location")]) {
        Some(value) => js::s(Some(value)),
        None => "Предыдущая сцена".to_string(),
    };
    let prior_summary = match first_truthy(&[scene_args.get("scene_summary"), scene_args.get("outcome"), scene_args.get("completed_objective"), state_scene.get("objective")]) {
        Some(value) => js::s(Some(value)),
        None => {
            let place = match first_truthy(&[state_scene.get("location")]) {
                Some(value) => js::s(Some(value)),
                None => "предыдущую локацию".to_string(),
            };
            format!("Отряд покинул {place}.")
        }
    };
    let recorded_at = js::safe_int(r.state.get("mechanics").and_then(|mechanics| mechanics.get("world_time")).and_then(|time| time.get("elapsed_minutes")), 0).max(0);
    let mut summary = Map::new();
    summary.insert("id".into(), json!(format!("scene-summary:{}", slice_utf16(&js::string(r.command.get("command_id")), 100))));
    summary.insert("kind".into(), json!("scene"));
    summary.insert("title".into(), json!(slice_utf16(&prior_title, 180)));
    summary.insert("summary".into(), json!(slice_utf16(&prior_summary, 2_000)));
    summary.insert("visibility".into(), json!("party"));
    summary.insert("entity_ids".into(), json!([]));
    summary.insert("thread_ids".into(), json!([]));
    summary.insert("source_event_ids".into(), json!([scene_event_id]));
    put(&mut summary, "source_command_id", r.command.get("command_id"));
    summary.insert("recorded_at_minutes".into(), json!(recorded_at));
    let source = command_with(&r.command, "visibility", json!("party"));
    r.events.push(event_from(&source, "NarrativeSummaryRecorded", Some(json!({ "summary": Value::Object(summary) })), Some(&json!([]))));
    let command = r.command.clone();
    r.append_scenario_knight_presence(&command)
}

/// `AdvanceTime` (22621–22626).
pub fn advance_time(r: &mut Resolve<'_>) -> Flow {
    let amount = js::number(r.command.get("amount"));
    let amount = if amount.is_nan() { 0.0 } else { amount.max(0.0) };
    let unit = if js::truthy(r.command.get("unit")) { js::s(r.command.get("unit")) } else { "minute".to_string() };
    let command = r.command.clone();
    r.append_world_time_consequences(&command, Some(&js::num(amount)), Some(&json!(unit)), TimeAdvanceOptions::default())
}

/// `RevealArea` (22761–22765).
pub fn reveal_area(r: &mut Resolve<'_>) -> Flow {
    let cells: Vec<Value> = match r.command.get("cells") {
        Some(Value::Array(cells)) => cells
            .iter()
            .take(100)
            .map(|cell| {
                if cell.is_null() {
                    return Err(Interrupt::from(Fault::type_error("Cannot read properties of null (reading 'x')")));
                }
                Ok(json!({ "x": crate::core::safe_integer_or(cell.get("x"), None), "y": crate::core::safe_integer_or(cell.get("y"), None) }))
            })
            .collect::<Result<_, _>>()?,
        _ => Vec::new(),
    };
    r.events.push(event_from(&r.command, "AreaRevealed", Some(json!({ "cells": cells })), Some(&json!([]))));
    Ok(())
}

/// `SpawnEntity` (22774–22776).
pub fn spawn_entity(r: &mut Resolve<'_>) -> Flow {
    let entity = r.command.get("entity").filter(|value| !value.is_null()).cloned().unwrap_or_else(|| json!({}));
    r.events.push(event_from(&r.command, "EntitySpawned", Some(json!({ "entity": entity })), Some(&json!([]))));
    Ok(())
}

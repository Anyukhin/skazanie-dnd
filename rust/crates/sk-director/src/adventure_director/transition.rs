//! `createSceneTransition(input, state)` — переход между сценами: новая глава
//! (или шаг той же, если цель `continued`), запись прежней сцены в историю,
//! сверка карты мира, карта места — запомненная или новая — и точка входа
//! отряда. Слова перехода сверяются с построенной картой: фраза о постройке,
//! которой на карте нет, в событие не попадает.

use serde_json::{json, Map, Value};
use sk_core::{js, text as jstext};
use sk_geometry::world_map::{reconcile_world_map, world_location_by_id};
use sk_scene_base::scene_map_design::world_location_design_context;
use sk_scene_base::scene_requirements::{missing_structure_for, scene_map_requirements_for, text_against_map, SCENE_REQUIREMENTS_VERSION};
use sk_story::map_library::{active_map_library, library_ids_in_use, MapLibrary};
use sk_tactical::tactical_map::{cell_at, deserialize_tactical_map, serialize_tactical_map, tactical_map_from_legacy_cells, LegacyMapOptions, TacticalMap};
use sk_themes::scene_themes::resolve_scene_theme;
use sk_world_time::level_generator::{normalize_declared_levels, DeclaredLevel};

use super::entry::{entrance_on_side, entry_side_toward, outside_entrance_for};
use super::geometry::{generate_scene_geometry_for, GeometryArgs, SceneGeometry};
use super::memory::{
    known_world_kind, library_scene_fields, normalized_scene_cells, public_adventure_memory, scene_location_id, scene_map_for_location, scene_tactical_map_for_location,
    stable_location_map_seed, OBJECTIVE_STATUSES,
};
use super::{head16, integer, nullish, or, prop, public_text, tail, text, text_or_value, unique, DirectorError, DirectorResult};

/// Карта сцены перехода: живая (новая или пересобранная из клеток) либо
/// запомненная сериализованная — та остаётся рыхлым JSON, как в JS.
enum SceneMap {
    Live(TacticalMap),
    Stored(Value),
}

/// `sceneStructureFacts(rawMap)` по живой карте.
fn live_structure_facts(map: &TacticalMap) -> Value {
    let zones: Vec<Value> = map
        .zones
        .iter()
        .map(|zone| json!({ "kind": text(Some(&Value::String(zone.kind.clone())), 20, ""), "label": text(Some(&Value::String(zone.label.clone())), 80, "") }))
        .collect();
    let props: Vec<Value> = map
        .props
        .iter()
        .map(|prop| text(Some(&Value::String(prop.asset_id.clone())), 80, ""))
        .filter(|asset| !asset.is_empty())
        .map(Value::String)
        .collect();
    json!({
        "theme": text(Some(&Value::String(map.theme.clone())), 60, ""),
        "zones": zones,
        "doors": map.doors.len(),
        "props": props,
        "water": has_water(map),
    })
}

fn has_water(map: &TacticalMap) -> bool {
    (0..map.height).any(|y| (0..map.width).any(|x| cell_at(map, x, y).is_some_and(|cell| cell.surface == "water")))
}

/// `sceneStructureFacts(rawMap)`: что карта знает о постройках и местности —
/// для сверки слов перехода. Битая карта даёт пустые факты; у сохранённой
/// карты без слоёв неизвестна только вода.
fn structure_facts(map: &SceneMap) -> Value {
    match map {
        SceneMap::Live(map) => live_structure_facts(map),
        SceneMap::Stored(raw) => {
            if !raw.is_object() && !raw.is_array() {
                return json!({});
            }
            let raw_ref = Some(raw);
            let list = |key: &str| -> &[Value] {
                match prop(raw_ref, key) {
                    Some(Value::Array(items)) => items,
                    _ => &[],
                }
            };
            let zones: Vec<Value> = list("zones")
                .iter()
                .map(|zone| json!({ "kind": text(prop(Some(zone), "kind"), 20, ""), "label": text(prop(Some(zone), "label"), 80, "") }))
                .collect();
            let props: Vec<Value> =
                list("props").iter().map(|prop_value| text(prop(Some(prop_value), "assetId"), 80, "")).filter(|asset| !asset.is_empty()).map(Value::String).collect();
            let doors = match prop(raw_ref, "doors") {
                Some(Value::Array(items)) => items.len(),
                _ => 0,
            };
            // Старая карта без слоёв: воду не узнать, остальное уже прочитано.
            let water = deserialize_tactical_map(raw).is_ok_and(|live| has_water(&live));
            json!({
                "theme": text(prop(raw_ref, "theme"), 60, ""),
                "zones": zones,
                "doors": doors,
                "props": props,
                "water": water,
            })
        }
    }
}

/// Значения `undefined` в объекте параметров JS не попадают вовсе.
fn insert_defined(object: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        object.insert(key.into(), value.clone());
    }
}

/// `typeof value === 'string'`-части через пробел, срезанные по UTF-16.
fn joined_strings(values: &[Option<&Value>], limit: usize) -> String {
    let parts: Vec<&str> = values.iter().filter_map(|value| value.and_then(Value::as_str)).collect();
    head16(&parts.join(" "), limit)
}

/// `createSceneTransition(input, state)` с активной библиотекой карт.
pub fn create_scene_transition(input: &Value, state: &Value) -> DirectorResult<Value> {
    let library = active_map_library();
    create_scene_transition_with(input, state, library.as_deref())
}

/// `createSceneTransition(input, state)`: переход между сценами. Вход —
/// аргументы сцены от Режиссёра (`scene_args`), состояние — кампания до
/// перехода. Итог — `{ scene, worldMap, adventure, transition, arrival,
/// library_levels?, entrance }` в форме JS. `library` — библиотека готовых
/// карт (`None` — без неё).
pub fn create_scene_transition_with(input: &Value, state: &Value, library: Option<&MapLibrary>) -> DirectorResult<Value> {
    if state.is_null() {
        return Err(DirectorError::null_read("scene"));
    }
    let state_ref = Some(state);
    let previous_scene_value = nullish(prop(state_ref, "scene"), None).cloned().unwrap_or_else(|| json!({}));
    let previous_scene = Some(&previous_scene_value);
    let previous_adventure = public_adventure_memory(prop(state_ref, "adventure"));
    if input.is_null() {
        return Err(DirectorError::null_read("objective_status"));
    }
    let input_ref = Some(input);
    let field = |key: &str| prop(input_ref, key);
    let scene_field = |key: &str| prop(previous_scene, key);

    let objective_status: &str = match field("objective_status") {
        Some(Value::String(status)) => OBJECTIVE_STATUSES.iter().copied().find(|known| known == status).unwrap_or("completed"),
        _ => "completed",
    };
    // `continued` — шаг той же главы, а не новая.
    let current_chapter = integer(previous_adventure.get("chapter"), 1, 1, 999);
    let chapter = if objective_status == "continued" { current_chapter } else { current_chapter + 1 };
    let title = text(field("title"), 80, &format!("Глава {chapter}"));
    let requested_location_id = public_text(nullish(field("location_id"), field("locationId")), 120, "");
    let world_map_before = prop(state_ref, "worldMap");
    let requested_location = world_location_by_id(world_map_before, &requested_location_id);
    // Имя точки карты мира — строка в карте, собранной `world-map`; иное
    // значение приводится `String()` (см. отчёт переноса).
    let location = match requested_location.and_then(|node| node.get("name")) {
        name if js::truthy(name) => js::s(name),
        _ => text(field("location"), 120, &title),
    };
    let location_value = Value::String(location.clone());
    let mood = text(field("mood"), 160, "Неизведанное место, полное новых возможностей");
    let objective = text(field("objective"), 160, "Исследовать новую локацию и найти путь дальше");
    let previous_place = text(or(scene_field("location"), scene_field("title")), 100, "прежнего места");
    let transition = text(field("transition"), 500, &format!("Путь из «{previous_place}» приводит героев в «{location}»."));
    let arrival = text(field("arrival"), 500, &format!("Перед героями открывается {location}."));
    let hook = text(field("hook"), 240, &objective);
    let theme = text(field("theme"), 80, &location);
    let danger = match field("danger") {
        Some(Value::String(danger)) if ["низкая", "средняя", "высокая"].contains(&danger.as_str()) => danger.clone(),
        _ => "средняя".to_string(),
    };
    let completed_objective = text_or_value(field("completed_objective"), 160, scene_field("objective"))?;
    let previous_location_id = public_text(nullish(scene_field("location_id"), scene_field("locationId")), 120, "");
    let mut history_entry = Map::new();
    history_entry.insert("chapter".into(), Value::from(if objective_status == "continued" { chapter } else { (chapter - 1).max(1) }));
    history_entry.insert("title".into(), Value::String(text(scene_field("title"), 80, "Предыдущая сцена")));
    history_entry.insert("location".into(), Value::String(text(scene_field("location"), 120, "")));
    if !previous_location_id.is_empty() {
        history_entry.insert("location_id".into(), Value::String(previous_location_id));
    }
    let outcome_fallback = if js::truthy(Some(&completed_objective)) {
        format!("Цель «{}» завершена.", js::s(Some(&completed_objective)))
    } else {
        "Герои покинули эту локацию.".to_string()
    };
    history_entry.insert("objective".into(), completed_objective);
    history_entry.insert("outcome".into(), Value::String(text(field("outcome"), 240, &outcome_fallback)));
    history_entry.insert("status".into(), Value::String(objective_status.into()));
    let mut history: Vec<Value> = match previous_adventure.get("history") {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    };
    history.push(Value::Object(history_entry));
    let history = tail(history, 20);
    let mut unresolved_threads: Vec<String> = match previous_adventure.get("unresolvedThreads") {
        Some(Value::Array(items)) => items.iter().map(|item| js::s(Some(item))).collect(),
        _ => Vec::new(),
    };
    if js::truthy(field("carry_unresolved")) || objective_status == "unresolved" {
        unresolved_threads.push(text(or(previous_adventure.get("currentHook"), scene_field("objective")), 240, ""));
    }
    let visited_locations: Vec<String> = match previous_adventure.get("visitedLocations") {
        Some(Value::Array(items)) => items.iter().map(|item| js::s(Some(item))).collect(),
        _ => Vec::new(),
    };

    // --- карта мира ---------------------------------------------------------------
    let mut options = Map::new();
    insert_defined(&mut options, "seed", or(prop(world_map_before, "seed"), prop(state_ref, "sessionCode")));
    insert_defined(&mut options, "campaignName", prop(state_ref, "campaign"));
    insert_defined(&mut options, "concept", prop(state_ref, "campaignConcept"));
    options.insert("currentLocation".into(), location_value.clone());
    options.insert("currentLocationId".into(), Value::String(requested_location_id.clone()));
    insert_defined(&mut options, "previousLocation", or(scene_field("location"), scene_field("title")));
    let scene_location = scene_location_id(state);
    let previous_location_id_raw = nullish(nullish(scene_field("location_id"), scene_field("locationId")), None)
        .cloned()
        .unwrap_or_else(|| Value::String(scene_location.clone()));
    options.insert("previousLocationId".into(), previous_location_id_raw);
    let mut known_locations: Vec<Value> = visited_locations.iter().cloned().map(Value::String).collect();
    known_locations.push(location_value.clone());
    options.insert("knownLocations".into(), Value::Array(known_locations));
    options.insert("transition".into(), Value::String(transition.clone()));
    let mut scene_options = Map::new();
    scene_options.insert("objective".into(), Value::String(objective.clone()));
    insert_defined(&mut scene_options, "scene_kind", field("scene_kind"));
    scene_options.insert("danger".into(), Value::String(danger.clone()));
    options.insert("scene".into(), Value::Object(scene_options));
    let world_map = reconcile_world_map(world_map_before, &Value::Object(options)).map_err(DirectorError::type_error)?;
    let world_ref = Some(&world_map);

    let location_id = js::s(world_map.get("currentLocationId"));
    let location_id_value = Value::String(location_id.clone());
    let known_kind = public_text(Some(&Value::String(known_world_kind(world_map_before, Some(&location_id_value), Some(&location_value)))), 40, "");
    let location_maps = prop(state_ref, "locationMaps");
    let same_place = scene_location == location_id;
    let remembered_cells = scene_map_for_location(location_maps, Some(&location_id_value))
        .or_else(|| same_place.then(|| normalized_scene_cells(scene_field("cells"))));
    let remembered_map = scene_tactical_map_for_location(location_maps, Some(&location_id_value))
        .or_else(|| (same_place && js::truthy(scene_field("map"))).then(|| scene_field("map").cloned().unwrap_or(Value::Null)));
    let requested_map = match field("map") {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    let request_value = Value::Object(requested_map.clone());
    let place_context = world_location_design_context(&world_map, Some(&location_id_value), Some(&location_value));
    let declared_levels = normalize_declared_levels(field("levels"));
    let settlement_type = public_text(field("settlement_type"), 40, "");
    let mut theme_input = Map::new();
    theme_input.insert("location".into(), location_value.clone());
    theme_input.insert("theme".into(), Value::String(theme.clone()));
    insert_defined(&mut theme_input, "sceneKind", field("scene_kind"));
    theme_input.insert("settlementType".into(), Value::String(settlement_type.clone()));
    theme_input.insert("worldKind".into(), Value::String(known_kind.clone()));
    theme_input.insert("request".into(), request_value.clone());
    let resolved_theme = resolve_scene_theme(&Value::Object(theme_input));

    // Обязательные объекты — из слов этой сцены, которые видит игрок. Карта
    // знакомого места не перестраивается, и список получает только новая карта.
    let map_requirements = if remembered_cells.is_some() {
        None
    } else {
        let lower_location = jstext::lower(&location);
        let npcs: Vec<Value> = match prop(prop(state_ref, "social"), "npcs") {
            Some(Value::Array(items)) => items
                .iter()
                .filter(|npc| !js::is_false(prop(Some(npc), "available")) && jstext::lower(&js::s(prop(Some(npc), "location"))) == lower_location)
                .map(|npc| {
                    let mut entry = Map::new();
                    insert_defined(&mut entry, "name", prop(Some(npc), "name"));
                    insert_defined(&mut entry, "role", prop(Some(npc), "role"));
                    insert_defined(&mut entry, "summary", prop(Some(npc), "public_summary"));
                    Value::Object(entry)
                })
                .collect(),
            _ => Vec::new(),
        };
        let texts = json!([location, theme, title, mood, objective, arrival]);
        scene_map_requirements_for(&texts, Some(&Value::Array(npcs)), prop(requested_map.get("design"), "landmarks"))
    };
    let program_value = map_requirements.as_ref().map(|program| program.to_value());
    let stable_seed = stable_location_map_seed(world_ref, Some(&location_id_value), Some(&location_value));
    let entry_side_new = entry_side_toward(world_ref, Some(&location_id_value), nullish(scene_field("location_id"), scene_field("locationId")));
    let generated: Option<SceneGeometry> = if remembered_cells.is_some() {
        None
    } else {
        let concept = prop(state_ref, "campaignConcept");
        let args = GeometryArgs {
            theme: Value::String(theme.clone()),
            danger: Value::String(danger.clone()),
            location: location_value.clone(),
            scene_kind: field("scene_kind").cloned().unwrap_or(Value::String(String::new())),
            settlement_type: Value::String(settlement_type.clone()),
            // Карта мира **до** сверки: место, которого на ней не было, только
            // что получило вид от этой же сцены.
            world_kind: Value::String(known_kind.clone()),
            seed: Value::String(stable_seed.clone()),
            location_id: location_id_value.clone(),
            requested_map: requested_map.clone(),
            levels: declared_levels.clone(),
            description: Value::String(joined_strings(
                &[Some(&Value::String(place_context.description.clone())), Some(&Value::String(title.clone())), Some(&Value::String(mood.clone())), field("arrival")],
                2000,
            )),
            world_description: Value::String(joined_strings(
                &[prop(concept, "worldSummary"), prop(concept, "premise"), prop(concept, "setting"), prop(concept, "description")],
                2400,
            )),
            biome: Value::String(place_context.biome.clone()),
            use_library: true,
            used_library_ids: library_ids_in_use(location_maps.unwrap_or(&Value::Null)).into_iter().collect(),
            requirements: program_value.as_ref().and_then(|program| program.get("items").cloned()).unwrap_or_else(|| json!([])),
            program: program_value.clone().unwrap_or(Value::Null),
            entry_side: Value::String(entry_side_new.to_string()),
        };
        Some(generate_scene_geometry_for(&args, library)?)
    };

    // Заявка архитектора на этажи сильнее; без неё — этажи генератора.
    let scene_levels: Vec<DeclaredLevel> = if !declared_levels.is_empty() {
        declared_levels.clone()
    } else {
        generated.as_ref().and_then(|generated| generated.levels.clone()).unwrap_or_default()
    };
    let map_theme = text(nullish(resolved_theme.get("assetTheme"), resolved_theme.get("id")), 60, "");
    let from_memory = remembered_cells.is_some();
    let (cells, generated_rest) = match (remembered_cells, generated) {
        (Some(cells), None) => (cells, None),
        (_, Some(generated)) => {
            let SceneGeometry { cells, map, missing, library, .. } = generated;
            (cells, Some((map, missing, library)))
        }
        (None, None) => (Vec::new(), None),
    };
    let (generated_map, generated_missing, library_geometry) = match generated_rest {
        Some((map, missing, library)) => (Some(map), missing, library),
        None => (None, None, None),
    };
    let mut tactical = match (remembered_map, generated_map) {
        (Some(stored), _) => SceneMap::Stored(stored),
        (None, Some(map)) => SceneMap::Live(map),
        (None, None) => SceneMap::Live(tactical_map_from_legacy_cells(
            &cells,
            &LegacyMapOptions { location_id: &location_id, seed: &stable_seed, generator: None, tileset_id: "" },
        )?),
    };
    if let SceneMap::Live(map) = &mut tactical {
        if !map_theme.is_empty() {
            map.theme = map_theme.clone();
        }
    }
    let serialized_map = match &tactical {
        SceneMap::Stored(stored) => stored.clone(),
        SceneMap::Live(map) => serialize_tactical_map(map)?,
    };
    // Вход при возвращении: знакомая карта не поворачивается, вход ищется на
    // её краю со стороны, откуда отряд пришёл на этот раз.
    let return_entrance = match &tactical {
        SceneMap::Stored(stored) => {
            let side = entry_side_toward(world_ref, Some(&location_id_value), nullish(scene_field("location_id"), scene_field("locationId")));
            if side.is_empty() {
                None
            } else {
                deserialize_tactical_map(stored).ok().and_then(|live| entrance_on_side(&live, side))
            }
        }
        SceneMap::Live(_) => None,
    };
    let party_spawn: Option<Value> = match return_entrance {
        Some((x, y)) => Some(json!({ "x": x, "y": y })),
        None => match &tactical {
            SceneMap::Live(map) => map.spawn_points.iter().find(|point| point.role == "party").map(|spawn| {
                let (x, y) = outside_entrance_for(map, spawn.x as f64, spawn.y as f64).unwrap_or((spawn.x, spawn.y));
                json!({ "x": x, "y": y })
            }),
            SceneMap::Stored(stored) => {
                let spawn = match prop(Some(stored), "spawnPoints") {
                    Some(Value::Array(points)) => points.iter().find(|point| prop(Some(point), "role").and_then(Value::as_str) == Some("party")),
                    _ => None,
                };
                spawn.map(|spawn| {
                    let outside = deserialize_tactical_map(&serialized_map)
                        .ok()
                        .and_then(|live| outside_entrance_for(&live, js::number(prop(Some(spawn), "x")), js::number(prop(Some(spawn), "y"))));
                    match outside {
                        Some((x, y)) => json!({ "x": x, "y": y }),
                        None => spawn.clone(),
                    }
                })
            }
        },
    };

    // Слова перехода сверяются с построенной картой; имя постройки, которой
    // на карте нет, уходит в `missing`, и Рассказчик о нём молчит.
    let facts = structure_facts(&tactical);
    let checked_arrival = text_against_map(Some(&Value::String(arrival)), &facts, &location, false);
    let checked_transition = text_against_map(Some(&Value::String(transition)), &facts, &location, true);
    let arrival_text = if checked_arrival.text.is_empty() { format!("Отряд прибывает в локацию «{location}».") } else { checked_arrival.text };
    let transition_text = if checked_transition.text.is_empty() {
        format!("Путь из «{previous_place}» приводит героев в «{location}».")
    } else {
        checked_transition.text
    };
    let missing_structure = if from_memory { String::new() } else { missing_structure_for(&location, &facts) };
    let mut missing: Vec<String> = generated_missing.unwrap_or_default();
    if !missing_structure.is_empty() {
        missing.push(missing_structure.clone());
    }
    let missing = unique(missing);
    let program = match program_value {
        Some(program) => Some(program),
        None if !missing_structure.is_empty() => Some(json!({ "version": SCENE_REQUIREMENTS_VERSION, "items": [] })),
        None => None,
    };

    let previous_turn = js::number(scene_field("turn"));
    let previous_turn = if previous_turn.is_nan() || previous_turn == 0.0 { 0.0 } else { previous_turn };
    let mut scene = Map::new();
    scene.insert("title".into(), Value::String(title));
    scene.insert("location".into(), location_value.clone());
    scene.insert("location_id".into(), location_id_value.clone());
    scene.insert("mood".into(), Value::String(mood));
    scene.insert("objective".into(), Value::String(objective));
    scene.insert("turn".into(), js::num(js_max(0.0, previous_turn) + 1.0));
    // Этажи живут в самой сцене: `SceneAdvanced` несёт сцену целиком, и
    // заявка восстанавливается при replay без новой строки в reducer.
    if !scene_levels.is_empty() {
        scene.insert("levels".into(), Value::Array(scene_levels.iter().map(DeclaredLevel::to_json).collect()));
    }
    // Библиотечная карта приносит свои этажи: заявка архитектора уступает
    // фактической постройке.
    if let Some(library) = &library_geometry {
        for (key, value) in library_scene_fields(library) {
            scene.insert(key, value);
        }
    }
    if let Some(Value::Object(mut program)) = program {
        if !missing.is_empty() {
            program.insert("missing".into(), js::strings_value(missing.iter().cloned()));
        }
        scene.insert("map_requirements".into(), Value::Object(program));
    }
    scene.insert("cells".into(), Value::Array(cells));
    scene.insert("map".into(), serialized_map);

    let mut adventure = Map::new();
    adventure.insert("chapter".into(), Value::from(chapter));
    adventure.insert("history".into(), Value::Array(history));
    adventure.insert("currentHook".into(), Value::String(hook));
    adventure.insert("lastTransition".into(), Value::String(transition_text.clone()));
    let threads = tail(unique(unresolved_threads.into_iter().filter(|thread| !thread.is_empty())), 20);
    adventure.insert("unresolvedThreads".into(), js::strings_value(threads));
    let mut visited = visited_locations;
    visited.push(location.clone());
    adventure.insert("visitedLocations".into(), js::strings_value(tail(unique(visited), 50)));
    let mut visited_ids: Vec<Value> = match previous_adventure.get("visitedLocationIds") {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    };
    visited_ids.push(world_map.get("currentLocationId").cloned().unwrap_or(Value::Null));
    adventure.insert("visitedLocationIds".into(), Value::Array(tail(unique_values(visited_ids.into_iter().filter(|id| js::truthy(Some(id))).collect()), 50)));

    let entrance = match party_spawn {
        Some(spawn) => {
            let mut entrance = Map::new();
            insert_defined(&mut entrance, "x", prop(Some(&spawn), "x"));
            insert_defined(&mut entrance, "y", prop(Some(&spawn), "y"));
            Value::Object(entrance)
        }
        None => {
            let y = if requested_map.is_empty() {
                Value::from(4)
            } else {
                let height = match &tactical {
                    SceneMap::Live(map) => map.height as f64,
                    SceneMap::Stored(stored) => js::number(prop(Some(stored), "height")),
                };
                js::num(((height - 1.0) / 2.0).floor())
            };
            json!({ "x": 1, "y": y })
        }
    };

    let mut result = Map::new();
    result.insert("scene".into(), Value::Object(scene));
    result.insert("worldMap".into(), world_map.clone());
    result.insert("adventure".into(), Value::Object(adventure));
    result.insert("transition".into(), Value::String(transition_text));
    result.insert("arrival".into(), Value::String(arrival_text));
    if let Some(library) = library_geometry.filter(|library| !library.levels.is_empty()) {
        result.insert("library_levels".into(), Value::Array(library.levels.iter().map(|level| level.to_json()).collect()));
    }
    result.insert("entrance".into(), entrance);
    Ok(Value::Object(result))
}

/// `Math.max(a, b)` JS: `NaN` заразен.
fn js_max(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        f64::NAN
    } else {
        left.max(right)
    }
}

/// `[...new Set(values)]` для значений JSON (SameValueZero: строки и числа
/// по значению, объекты — каждый свой).
fn unique_values(values: Vec<Value>) -> Vec<Value> {
    let mut result: Vec<Value> = Vec::new();
    for value in values {
        let duplicate = match &value {
            Value::Object(_) | Value::Array(_) => false,
            _ => result.iter().any(|known| super::strict_equal(Some(known), Some(&value))),
        };
        if !duplicate {
            result.push(value);
        }
    }
    result
}

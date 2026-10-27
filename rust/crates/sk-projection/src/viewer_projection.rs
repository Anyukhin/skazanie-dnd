//! Перенос `server/viewer-projection.mjs` — единственного источника того, что
//! игрок вправе видеть (`AGENTS.md` §4–§5).
//!
//! Модуль принимает внутреннее состояние кампании (рыхлый JSON, которому нельзя
//! доверять по форме) и сужает его до того, что видно зрителю: комната
//! ([`campaign_state_for_viewer`]), события ([`mechanics_for_viewer`]), разбор
//! хода ([`turn_explanation_for_viewer`]), итог команды
//! ([`turn_result_for_viewer`]), переход сцены ([`scene_transition_for_viewer`]),
//! а также публичные формы сцены, тактической карты, карты мира, приключения,
//! врага и встречи.
//!
//! Отличия от JS — только там, где JS не может вести себя иначе на JSON:
//! - кэш проекции карты по объекту (`WeakMap`) не переносится: проекция чистая,
//!   итог тот же;
//! - `TypeError` JS на мусорном входе (`null` вместо объекта, `.map` у
//!   не-массива) — [`ProjectionError`] с именем `TypeError`; текст — описание
//!   для людей, а не текст V8;
//! - ключи `Object.prototype` (`constructor`, `toString`, …) как идентификаторы
//!   врагов, владельцев и событий считаются обычными неизвестными ключами;
//!   ключ `__proto__` в объекте, который JS собирает присваиванием, не
//!   вставляется (в JS это сеттер прототипа);
//! - `slice(0, n)` считает единицы UTF-16, как JS; суррогатная пара, которую JS
//!   разрезал бы пополам, отбрасывается целиком (строка Rust не держит
//!   одиночный суррогат);
//! - ключи раскрытых клеток для подсветки областей в событиях собираются прямо
//!   из `scene.cells` (тот же набор, что `publicSceneFor(...).cells`), без
//!   проекции карты, которая в этот набор не входит.

use std::collections::{HashMap, HashSet};
use std::fmt;

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexSet;
use sk_core::{hash, js, re, text};
use sk_rules::tactical_geometry::Scene;
use sk_tactical::tactical_map::{self as tmap, PropMount, TacticalMap, TacticalMapError, TacticalProp};

// --- ошибки ------------------------------------------------------------------------

/// Исключение, которое JS пропустил бы наружу: `TypeError` на мусорном входе
/// или ошибка соседнего модуля (`LootContainerError`, `TacticalMapError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectionError {
    pub name: String,
    pub code: Option<String>,
    pub message: String,
}

impl ProjectionError {
    fn type_error(message: impl Into<String>) -> Self {
        Self { name: "TypeError".into(), code: None, message: message.into() }
    }

    fn null_read(key: &str) -> Self {
        Self::type_error(format!("Cannot read properties of null (reading '{key}')"))
    }

    fn not_function(what: &str, method: &str) -> Self {
        Self::type_error(format!("{what}.{method} is not a function"))
    }
}

impl fmt::Display for ProjectionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.name, self.message)
    }
}

impl std::error::Error for ProjectionError {}

impl From<TacticalMapError> for ProjectionError {
    fn from(error: TacticalMapError) -> Self {
        Self { name: error.name.to_string(), code: Some(error.code), message: error.message }
    }
}

impl From<sk_tactical::action_hints::ActionHintsError> for ProjectionError {
    fn from(error: sk_tactical::action_hints::ActionHintsError) -> Self {
        Self::type_error(error.message)
    }
}

impl From<sk_director::loot_containers::LootContainerError> for ProjectionError {
    fn from(error: sk_director::loot_containers::LootContainerError) -> Self {
        Self { name: error.name.to_string(), code: error.code, message: error.message }
    }
}

pub type ProjectionResult<T> = Result<T, ProjectionError>;
type R<T> = ProjectionResult<T>;

// --- помощники приведения ------------------------------------------------------------

/// `value?.[key]` — поле есть только у объекта.
fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(Value::as_object).and_then(|map| map.get(key))
}

/// `a ?? b`.
fn coalesce<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    if js::present(a) {
        a
    } else {
        b
    }
}

/// `value === 'text'`.
fn is_str(value: Option<&Value>, expected: &str) -> bool {
    matches!(value, Some(Value::String(text)) if text == expected)
}

/// `typeof value === 'object' && value !== null` (объект или массив).
fn objectish(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Object(_) | Value::Array(_)))
}

fn plain(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

/// `Array.isArray(value) ? value : []`.
fn arr(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

/// `(value ?? []).map(...)`: не-массив вместо массива — `TypeError` JS.
fn list_or_empty<'a>(value: Option<&'a Value>, what: &str) -> R<&'a [Value]> {
    match value {
        None | Some(Value::Null) => Ok(&[]),
        Some(Value::Array(items)) => Ok(items),
        Some(_) => Err(ProjectionError::not_function(what, "map")),
    }
}

/// `{ ...value }`: объект — копия, массив и строка — индексы, прочее — пусто.
fn spread_any(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map.clone(),
        Some(Value::Array(items)) => items.iter().enumerate().map(|(index, item)| (index.to_string(), item.clone())).collect(),
        Some(Value::String(text)) => text.chars().enumerate().map(|(index, ch)| (index.to_string(), Value::String(ch.to_string()))).collect(),
        _ => Map::new(),
    }
}

/// `Object.entries(value)` для рыхлого значения.
fn entries_any(value: Option<&Value>) -> Vec<(String, Value)> {
    match value {
        Some(Value::Object(map)) => js::entries(map).into_iter().map(|(key, value)| (key.clone(), value.clone())).collect(),
        other => spread_any(other).into_iter().collect(),
    }
}

/// `text.slice(0, units)` по единицам UTF-16.
fn head16(text: &str, units: usize) -> String {
    let mut taken = 0;
    let mut out = String::new();
    for ch in text.chars() {
        taken += ch.len_utf16();
        if taken > units {
            break;
        }
        out.push(ch);
    }
    out
}

/// `text(value, maximum)`: `String(value ?? '').normalize('NFKC').trim().slice(0, maximum)`.
fn text_of(value: Option<&Value>, maximum: usize) -> String {
    head16(text::trim(&text::nfkc(&js::s(value))), maximum)
}

fn text_value(value: Option<&Value>, maximum: usize) -> Value {
    Value::String(text_of(value, maximum))
}

/// `integer(value, fallback)`.
fn integer(value: Option<&Value>, fallback: i64) -> i64 {
    js::safe_int(value, fallback)
}

fn is_admin(user: Option<&Value>) -> bool {
    is_str(get(user, "role"), "admin")
}

/// Строгое `a === b` для полей JSON: разные объекты не равны.
fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        _ => false,
    }
}

/// Аргумент `actorId = ''` функции JS: `None` — `undefined`, то есть `''`.
fn actor_arg(actor_id: Option<&Value>) -> Value {
    actor_id.cloned().unwrap_or_else(|| Value::String(String::new()))
}

/// Вставка присваиванием (`object[key] = value`): `__proto__` в JSON не попадает.
fn assign_key(map: &mut Map<String, Value>, key: &str, value: Value) {
    if key != "__proto__" {
        map.insert(key.to_string(), value);
    }
}

fn for_narrator() -> Value {
    json!({ "forNarrator": true })
}

fn project(value: &Value, viewer: &Value) -> Option<Value> {
    sk_tactics::security::project_visible_state(Some(value), Some(viewer), Some(&for_narrator()))
}

/// `new Set((state?.enemies ?? []).map((enemy) => text(enemy?.id ?? enemy?.actor_id, 120)))`.
fn enemy_ids(state: Option<&Value>) -> R<IndexSet<String>> {
    Ok(list_or_empty(get(state, "enemies"), "state.enemies")?
        .iter()
        .map(|enemy| text_of(coalesce(get(Some(enemy), "id"), get(Some(enemy), "actor_id")), 120))
        .collect())
}

/// `viewerFor(state, user, actorId)`.
fn viewer_for(state: Option<&Value>, user: Option<&Value>, actor: &Value) -> Value {
    let party: Vec<Value> = match get(state, "partyMemberIds") {
        Some(Value::Array(ids)) => ids.iter().map(|id| Value::String(js::string(Some(id)))).collect(),
        _ => Vec::new(),
    };
    json!({
        "role": if is_admin(user) { "admin" } else { "player" },
        "playerId": js::s(Some(actor)),
        "partyIds": party,
        "isPartyMember": true,
    })
}

// --- приключение и карта мира --------------------------------------------------------

fn public_history_entry(entry: &Value) -> Value {
    let entry = Some(entry);
    let mut out = Map::new();
    out.insert("chapter".into(), Value::from(integer(get(entry, "chapter"), 1).max(1)));
    out.insert("title".into(), text_value(get(entry, "title"), 120));
    out.insert("location".into(), text_value(get(entry, "location"), 180));
    out.insert("objective".into(), text_value(get(entry, "objective"), 500));
    out.insert("outcome".into(), text_value(get(entry, "outcome"), 500));
    if js::present(get(entry, "status")) {
        out.insert("status".into(), text_value(get(entry, "status"), 40));
    }
    Value::Object(out)
}

fn last_n(mut items: Vec<Value>, count: usize) -> Vec<Value> {
    if items.len() > count {
        items.drain(..items.len() - count);
    }
    items
}

/// `publicAdventureFor(adventure)`: только повествовательная непрерывность, без
/// закрытых корзин. `None` — `undefined` (как `{}`); `null` — `TypeError` JS.
pub fn public_adventure_for(adventure: Option<&Value>) -> ProjectionResult<Value> {
    if matches!(adventure, Some(Value::Null)) {
        return Err(ProjectionError::null_read("chapter"));
    }
    let mut out = Map::new();
    out.insert("chapter".into(), Value::from(integer(get(adventure, "chapter"), 1).max(1)));
    if js::present(get(adventure, "currentHook")) {
        out.insert("currentHook".into(), text_value(get(adventure, "currentHook"), 500));
    }
    if js::present(get(adventure, "lastTransition")) {
        out.insert("lastTransition".into(), text_value(get(adventure, "lastTransition"), 1_000));
    }
    let strings = |key: &str, maximum: usize, count: usize| {
        let list: Vec<Value> = arr(get(adventure, key)).iter().map(|entry| text_of(Some(entry), maximum)).filter(|entry| !entry.is_empty()).map(Value::String).collect();
        Value::Array(last_n(list, count))
    };
    out.insert("unresolvedThreads".into(), strings("unresolvedThreads", 500, 20));
    out.insert("visitedLocations".into(), strings("visitedLocations", 180, 50));
    let history: Vec<Value> = arr(get(adventure, "history")).iter().filter(|entry| entry.is_object()).map(public_history_entry).collect();
    out.insert("history".into(), Value::Array(last_n(history, 20)));
    Ok(Value::Object(out))
}

/// `publicWorldMapFor(worldMap)`: известные и посещённые точки (не больше 50,
/// текущая не выпадает), их регионы и открытые маршруты между ними.
pub fn public_world_map_for(world_map: Option<&Value>) -> ProjectionResult<Value> {
    if matches!(world_map, Some(Value::Null)) {
        return Err(ProjectionError::null_read("currentLocationId"));
    }
    let current = text_of(get(world_map, "currentLocationId"), 100);
    let visible: Vec<&Value> = arr(get(world_map, "locations"))
        .iter()
        .filter(|location| {
            let location = Some(*location);
            !js::is_false(get(location, "known")) || js::is_true(get(location, "visited")) || text_of(get(location, "id"), 100) == current
        })
        .collect();
    let current_index = if current.is_empty() { None } else { visible.iter().position(|location| text_of(get(Some(location), "id"), 100) == current) };
    let locations: Vec<&Value> = match current_index {
        Some(index) if index >= 50 => visible[..49].iter().copied().chain(std::iter::once(visible[index])).collect(),
        _ => visible.iter().take(50).copied().collect(),
    };
    let location_ids: HashSet<String> = locations.iter().map(|location| text_of(get(Some(location), "id"), 100)).filter(|id| !id.is_empty()).collect();
    let region_ids: HashSet<String> = locations.iter().map(|location| text_of(get(Some(location), "regionId"), 100)).filter(|id| !id.is_empty()).collect();
    let mut out = Map::new();
    out.insert("version".into(), Value::from(integer(get(world_map, "version"), 1).max(1)));
    out.insert("name".into(), text_value(get(world_map, "name"), 160));
    out.insert("width".into(), Value::from(integer(get(world_map, "width"), 1000).clamp(320, 2000)));
    out.insert("height".into(), Value::from(integer(get(world_map, "height"), 640).clamp(240, 1200)));
    out.insert("currentLocationId".into(), Value::String(if location_ids.contains(&current) { current.clone() } else { String::new() }));
    if let Value::Object(background) = sk_geometry::world_map::normalize_world_map_background(world_map) {
        out.extend(background);
    }
    let regions: Vec<Value> = arr(get(world_map, "regions"))
        .iter()
        .filter(|region| region_ids.contains(&text_of(get(Some(region), "id"), 100)))
        .take(12)
        .map(|region| {
            let region = Some(region);
            json!({
                "id": text_of(get(region, "id"), 100), "name": text_of(get(region, "name"), 120), "biome": text_of(get(region, "biome"), 40),
                "x": integer(get(region, "x"), 0), "y": integer(get(region, "y"), 0), "radius": integer(get(region, "radius"), 180),
            })
        })
        .collect();
    out.insert("regions".into(), Value::Array(regions));
    let projected_locations: Vec<Value> = locations
        .iter()
        .map(|location| {
            let location = Some(*location);
            let city = sk_geometry::world_map::normalize_city_overview(coalesce(get(location, "cityOverview"), get(location, "city_overview")));
            let mut entry = Map::new();
            entry.insert("id".into(), text_value(get(location, "id"), 100));
            entry.insert("name".into(), text_value(get(location, "name"), 160));
            entry.insert("kind".into(), text_value(get(location, "kind"), 40));
            entry.insert("x".into(), Value::from(integer(get(location, "x"), 0)));
            entry.insert("y".into(), Value::from(integer(get(location, "y"), 0)));
            entry.insert("regionId".into(), text_value(get(location, "regionId"), 100));
            entry.insert("summary".into(), text_value(get(location, "summary"), 500));
            entry.insert("known".into(), Value::Bool(!js::is_false(get(location, "known"))));
            entry.insert("visited".into(), Value::Bool(js::is_true(get(location, "visited"))));
            if let Value::Object(lore) = sk_geometry::world_map::normalize_world_map_location_lore(location) {
                entry.extend(lore);
            }
            if let Some(city) = city {
                entry.insert("cityOverview".into(), city);
            }
            Value::Object(entry)
        })
        .collect();
    out.insert("locations".into(), Value::Array(projected_locations));
    let routes: Vec<Value> = arr(get(world_map, "routes"))
        .iter()
        .take(100)
        .filter(|route| {
            let route = Some(*route);
            !js::is_false(get(route, "discovered")) && location_ids.contains(&text_of(get(route, "from"), 100)) && location_ids.contains(&text_of(get(route, "to"), 100))
        })
        .map(|route| {
            let route = Some(route);
            json!({
                "id": text_of(get(route, "id"), 100), "from": text_of(get(route, "from"), 100), "to": text_of(get(route, "to"), 100),
                "kind": text_of(get(route, "kind"), 40), "distance": integer(get(route, "distance"), 1).max(1),
                "danger": text_of(get(route, "danger"), 40), "discovered": !js::is_false(get(route, "discovered")),
            })
        })
        .collect();
    out.insert("routes".into(), Value::Array(routes));
    Ok(Value::Object(out))
}

// --- клетки и тактическая карта ------------------------------------------------------

const PUBLIC_CELL_TYPES: [&str; 4] = ["wall", "floor", "water", "door"];
const PUBLIC_CELL_MATERIALS: [&str; 8] = ["stone", "wood", "earth", "grass", "sand", "metal", "marble", "ice"];
const PUBLIC_CELL_PATTERNS: [&str; 9] = ["small-room", "great-hall", "keep", "courtyard", "crypt", "cave-cluster", "village", "bridge", "natural"];

fn region_max_cells() -> usize {
    tmap::size_class("region").map_or(10_000, |class| class.max_cells.max(0) as usize)
}

/// `publicCellsFor(cells, movementBlockedCells)`: материал, вариант, pattern,
/// edge_mask и feature — только у раскрытой клетки.
fn public_cells_for(value: Option<&Value>, blocked: &HashSet<String>) -> Vec<Value> {
    let empty = Value::Object(Map::new());
    arr(value)
        .iter()
        .take(region_max_cells())
        .map(|raw| {
            let cell = if objectish(Some(raw)) { Some(raw) } else { Some(&empty) };
            let revealed = js::is_true(get(cell, "revealed"));
            let raw_type = js::s(get(cell, "type"));
            let x = integer(get(cell, "x"), 0);
            let y = integer(get(cell, "y"), 0);
            let mut out = Map::new();
            out.insert("x".into(), Value::from(x));
            out.insert("y".into(), Value::from(y));
            out.insert("type".into(), Value::String(if PUBLIC_CELL_TYPES.contains(&raw_type.as_str()) { raw_type } else { "floor".into() }));
            out.insert("revealed".into(), Value::Bool(revealed));
            if revealed {
                let material = js::s(get(cell, "material"));
                if PUBLIC_CELL_MATERIALS.contains(&material.as_str()) {
                    out.insert("material".into(), Value::String(material));
                }
                let pattern = js::s(get(cell, "pattern"));
                if PUBLIC_CELL_PATTERNS.contains(&pattern.as_str()) {
                    out.insert("pattern".into(), Value::String(pattern));
                }
                let variant = js::number(get(cell, "variant"));
                if js::is_safe_integer_number(get(cell, "variant")) {
                    out.insert("variant".into(), js::num(variant.clamp(0.0, 5.0)));
                }
                if let Some(Value::String(mask)) = get(cell, "edge_mask") {
                    if mask.len() <= 4 && mask.chars().all(|ch| matches!(ch, 'n' | 'e' | 's' | 'w')) {
                        out.insert("edge_mask".into(), Value::String(mask.clone()));
                    }
                }
                if js::present(get(cell, "feature")) {
                    out.insert("feature".into(), text_value(get(cell, "feature"), 40));
                }
                if blocked.contains(&format!("{x},{y}")) {
                    out.insert("movementBlocked".into(), Value::Bool(true));
                }
            }
            Value::Object(out)
        })
        .collect()
}

/// Ключи `x,y` раскрытых клеток `publicCellsFor(cells)`.
fn revealed_keys_from_cells(cells: Option<&Value>) -> IndexSet<String> {
    let empty = Value::Object(Map::new());
    arr(cells)
        .iter()
        .take(region_max_cells())
        .filter_map(|raw| {
            let cell = if objectish(Some(raw)) { Some(raw) } else { Some(&empty) };
            js::is_true(get(cell, "revealed")).then(|| format!("{},{}", integer(get(cell, "x"), 0), integer(get(cell, "y"), 0)))
        })
        .collect()
}

/// `publicRevealedCellKeys(publicSceneFor(scene))`: `null` вместо сцены — `TypeError` JS.
fn scene_revealed_keys(scene: Option<&Value>) -> R<IndexSet<String>> {
    if matches!(scene, Some(Value::Null)) {
        return Err(ProjectionError::null_read("map"));
    }
    Ok(revealed_keys_from_cells(get(scene, "cells")))
}

/// Проекция тактической карты: карта, её хеш и обезличенные клетки частично
/// видимого блокирующего предмета.
struct ProjectedMap {
    map: Value,
    hash: String,
    movement_blocked: HashSet<String>,
}

fn bit_at(bits: &[u8], index: usize) -> bool {
    bits.get(index >> 3).is_some_and(|byte| byte & (1 << (index & 7)) != 0)
}

/// Первая единица UTF-16 — в верхний регистр (`label[0].toLocaleUpperCase('ru-RU') + label.slice(1)`).
fn capitalize_first_unit(label: &str) -> String {
    let mut chars = label.chars();
    match chars.next() {
        Some(first) if first.len_utf16() == 1 => first.to_uppercase().chain(chars).collect(),
        _ => label.to_string(),
    }
}

/// `materializePropMetadataForTransport(projectedMap, props)`.
fn materialize_prop_metadata(projected: &mut Value, props: &[TacticalProp]) {
    let Some(list) = projected.get_mut("props").and_then(Value::as_array_mut) else { return };
    let mut by_id: HashMap<String, usize> = HashMap::new();
    for (index, prop) in list.iter().enumerate() {
        by_id.insert(js::s(get(Some(prop), "id")), index);
    }
    for prop in props {
        let Some(&index) = by_id.get(&prop.id) else { continue };
        let Some(target) = list.get_mut(index).and_then(Value::as_object_mut) else { continue };
        let label = sk_tactical::scene_interactions::scene_object_label_for(Some(&Value::String(prop.asset_id.clone())));
        if !label.is_empty() {
            target.insert("label".into(), Value::String(capitalize_first_unit(&label)));
        }
        if prop.interactive {
            target.insert("interactive".into(), Value::Bool(true));
        }
        let Some(interaction) = &prop.interaction else { continue };
        target.insert("interactive".into(), Value::Bool(true));
        target.insert(
            "interaction".into(),
            json!({ "kind": interaction.kind, "verbs": interaction.verbs, "pointOfInterest": interaction.point_of_interest }),
        );
    }
}

/// `computePublicTacticalMap(value)`.
fn compute_public_tactical_map(value: &Value) -> R<Option<ProjectedMap>> {
    let Ok(mut map) = tmap::deserialize_tactical_map(value) else { return Ok(None) };
    let width = map.width;
    let height = map.height;
    let revealed = map.layers.revealed.clone();
    let revealed_at = |x: i64, y: i64| x >= 0 && y >= 0 && x < width && y < height && bit_at(&revealed, (y * width + x) as usize);
    let movement_blocked = partially_blocked_cells(&map, &revealed_at);
    let cell_count = (width * height).max(0) as usize;
    let stone = tmap::MATERIALS.iter().position(|material| *material == "stone").unwrap_or(0) as u8;
    let none = tmap::SURFACES.iter().position(|surface| *surface == "none").unwrap_or(0) as u8;
    for index in 0..cell_count {
        if bit_at(&revealed, index) {
            continue;
        }
        if let Some(slot) = map.layers.material.get_mut(index) {
            *slot = stone;
        }
        if let Some(slot) = map.layers.variant.get_mut(index) {
            *slot = 0;
        }
        if let Some(slot) = map.layers.surface.get_mut(index) {
            *slot = none;
        }
        if let Some(slot) = map.layers.move_cost.get_mut(index) {
            *slot = 1;
        }
        if let Some(slot) = map.layers.elevation.get_mut(index) {
            *slot = 0;
        }
        map.hazards.remove(&index.to_string());
    }
    let mut zone_codes: HashMap<u8, u8> = HashMap::new();
    let mut visible_zones = Vec::new();
    for index in 0..cell_count {
        let Some(source) = map.layers.zone_id.get(index).copied() else { continue };
        let exists = source > 0 && map.zones.get(usize::from(source) - 1).is_some();
        if !bit_at(&revealed, index) || !exists {
            map.layers.zone_id[index] = 0;
            continue;
        }
        let code = match zone_codes.get(&source) {
            Some(code) => *code,
            None => {
                let code = (visible_zones.len() + 1) as u8;
                zone_codes.insert(source, code);
                visible_zones.push(map.zones[usize::from(source) - 1].clone());
                code
            }
        };
        map.layers.zone_id[index] = code;
    }
    map.zones = visible_zones;
    let zone_ids: HashSet<String> = map.zones.iter().map(|zone| zone.id.clone()).collect();
    map.overlays.room_labels.retain(|label| zone_ids.contains(&label.zone_id));
    map.spawn_points.retain(|point| revealed_at(point.x, point.y));
    map.props.retain(|prop| {
        if prop.footprint.is_empty() {
            revealed_at(prop.x.floor() as i64, prop.y.floor() as i64)
        } else {
            prop.footprint.iter().all(|cell| revealed_at(cell.x, cell.y))
        }
    });
    let prop_ids: HashSet<String> = map.props.iter().map(|prop| prop.id.clone()).collect();
    map.props.retain(|prop| match &prop.mount {
        Some(PropMount::Surface { prop_id }) => prop_ids.contains(prop_id),
        _ => true,
    });
    for prop in &mut map.props {
        if let Some(interaction) = &mut prop.interaction {
            interaction.detail_key = None;
            interaction.reward_key = None;
        }
    }
    let mut visible_edges: HashSet<String> = HashSet::new();
    map.retain_edges(|edge| {
        let neighbor_x = edge.x + i64::from(edge.dir == tmap::EdgeDir::E);
        let neighbor_y = edge.y + i64::from(edge.dir == tmap::EdgeDir::S);
        if revealed_at(edge.x, edge.y) || revealed_at(neighbor_x, neighbor_y) {
            visible_edges.insert(format!("{},{},{}", edge.x, edge.y, edge.dir.as_str()));
            true
        } else {
            false
        }
    });
    let doors: Vec<Value> = map
        .doors
        .iter()
        .filter(|door| visible_edges.contains(&format!("{},{},{}", door.x, door.y, door.dir.as_str())))
        .map(|door| {
            let mut entry = door.to_json();
            if let Some(object) = entry.as_object_mut() {
                object.insert("keyItemId".into(), Value::Null);
                if let Some(barricade) = door.barricade() {
                    object.insert("barricade".into(), json!({ "side_x": barricade.side_x, "side_y": barricade.side_y }));
                }
            }
            entry
        })
        .collect();
    let mut projected = tmap::serialize_tactical_map(&map)?;
    if let Some(object) = projected.as_object_mut() {
        object.insert("doors".into(), Value::Array(doors));
    }
    materialize_prop_metadata(&mut projected, &map.props);
    let hash = tmap::serialized_tactical_map_hash(&projected);
    Ok(Some(ProjectedMap { map: projected, hash, movement_blocked }))
}

/// `partiallyBlockedCellsFor(map, revealedAt)`.
fn partially_blocked_cells(map: &TacticalMap, revealed_at: &impl Fn(i64, i64) -> bool) -> HashSet<String> {
    let mut cells = HashSet::new();
    for prop in &map.props {
        if !prop.blocks_move || prop.footprint.len() < 2 {
            continue;
        }
        let visible: Vec<_> = prop.footprint.iter().filter(|cell| revealed_at(cell.x, cell.y)).collect();
        if visible.is_empty() || visible.len() == prop.footprint.len() {
            continue;
        }
        for cell in visible {
            cells.insert(format!("{},{}", cell.x, cell.y));
        }
    }
    cells
}

/// `projectPublicTacticalMap(value)`.
fn project_public_tactical_map(value: Option<&Value>) -> R<Option<ProjectedMap>> {
    match value {
        Some(value @ (Value::Object(_) | Value::Array(_))) => compute_public_tactical_map(value),
        _ => Ok(None),
    }
}

/// `publicTacticalMapWithHashFor(value)`: `{ map, hash }` карты, обезличенной
/// по туману, или `None` (`null`), если карта не читается. Хеш — от проекции.
pub fn public_tactical_map_with_hash_for(value: Option<&Value>) -> ProjectionResult<Option<Value>> {
    Ok(project_public_tactical_map(value)?.map(|projected| json!({ "map": projected.map, "hash": projected.hash })))
}

/// `publicTacticalMapFor(value)`: только карта из [`public_tactical_map_with_hash_for`].
pub fn public_tactical_map_for(value: Option<&Value>) -> ProjectionResult<Option<Value>> {
    Ok(project_public_tactical_map(value)?.map(|projected| projected.map))
}

/// `adminTacticalMapFor(value)`: `None` — та же карта (JS вернул бы `value`).
fn admin_tactical_map_for(value: Option<&Value>) -> Option<Value> {
    let value @ Value::Object(_) = value? else { return None };
    let map = tmap::deserialize_tactical_map(value).ok()?;
    let mut projected = tmap::serialize_tactical_map(&map).ok()?;
    materialize_prop_metadata(&mut projected, &map.props);
    Some(projected)
}

/// `adminSceneFor(scene)`.
fn admin_scene_for(scene: Option<&Value>) -> Value {
    match scene {
        None => Value::Object(Map::new()),
        Some(Value::Object(object)) => match admin_tactical_map_for(object.get("map")) {
            Some(map) => {
                let mut out = object.clone();
                out.insert("map".into(), map);
                Value::Object(out)
            }
            None => Value::Object(object.clone()),
        },
        Some(other) => other.clone(),
    }
}

/// `publicKnownLevelsFor(value)`.
fn public_known_levels_for(value: Option<&Value>) -> Vec<Value> {
    arr(value)
        .iter()
        .filter(|entry| js::is_safe_integer_number(get(Some(entry), "index")))
        .take(8)
        .map(|entry| json!({ "index": integer(get(Some(entry), "index"), 0), "label": text_of(get(Some(entry), "label"), 120) }))
        .collect()
}

/// `publicMapSourceFor(value)`: атрибуция готовой карты.
fn public_map_source_for(value: Option<&Value>) -> Option<Value> {
    plain(value)?;
    let title = text_of(get(value, "title"), 160);
    let author = text_of(get(value, "author"), 120);
    if title.is_empty() && author.is_empty() {
        return None;
    }
    let link = |raw: Option<&Value>| {
        let href = text_of(raw, 300);
        if text::test(re!(r#"^https:\/\/[^\s"'<>]+$"#, "u"), &href) {
            href
        } else {
            String::new()
        }
    };
    Some(json!({
        "title": title, "author": author, "license": text_of(get(value, "license"), 120),
        "url": link(get(value, "url")), "license_url": link(get(value, "license_url")), "site": text_of(get(value, "site"), 80),
    }))
}

/// `publicSceneFor(scene, knownLevels)`: сцена глазами игрока — строгий белый
/// список, клетки и карта по туману, известные этажи. `None` — `undefined`;
/// `null` — `TypeError` JS.
pub fn public_scene_for(scene: Option<&Value>, known_levels: Option<&Value>) -> ProjectionResult<Value> {
    if matches!(scene, Some(Value::Null)) {
        return Err(ProjectionError::null_read("map"));
    }
    let projected = project_public_tactical_map(get(scene, "map"))?;
    let levels = public_known_levels_for(known_levels);
    let level_index = get(get(scene, "level"), "index");
    let location_id = text_of(coalesce(coalesce(get(scene, "location_id"), get(scene, "locationId")), get(get(scene, "map"), "locationId")), 180);
    let blocked = projected.as_ref().map(|map| map.movement_blocked.clone()).unwrap_or_default();
    let mut out = Map::new();
    out.insert("title".into(), text_value(get(scene, "title"), 120));
    out.insert("location".into(), text_value(get(scene, "location"), 180));
    if !location_id.is_empty() {
        out.insert("location_id".into(), Value::String(location_id));
    }
    out.insert("mood".into(), text_value(get(scene, "mood"), 500));
    out.insert("objective".into(), text_value(get(scene, "objective"), 500));
    out.insert("turn".into(), Value::from(integer(get(scene, "turn"), 0).max(0)));
    out.insert("cells".into(), Value::Array(public_cells_for(get(scene, "cells"), &blocked)));
    if js::is_safe_integer_number(level_index) {
        out.insert("level".into(), json!({ "index": integer(level_index, 0), "label": text_of(get(get(scene, "level"), "label"), 120) }));
    }
    if !levels.is_empty() {
        out.insert("levels".into(), Value::Array(levels));
    }
    if let Some(projected) = projected {
        out.insert("map".into(), projected.map);
        out.insert("map_hash".into(), Value::String(projected.hash));
    }
    for (key, maximum) in [("theme", 120), ("danger", 40), ("scene_kind", 40), ("settlement_type", 40)] {
        if js::present(get(scene, key)) {
            out.insert(key.into(), text_value(get(scene, key), maximum));
        }
    }
    if let Some(source) = public_map_source_for(get(scene, "map_source")) {
        out.insert("map_source".into(), source);
    }
    Ok(Value::Object(out))
}

// --- враги --------------------------------------------------------------------------

/// `enemyKnowledgeFor(state, enemyId, actorId)`: `None` — `{}`.
fn enemy_knowledge_for<'a>(state: Option<&'a Value>, enemy_id: &str, actor: &Value) -> Option<&'a Value> {
    let registry = get(get(state, "mechanics"), "enemy_knowledge");
    let entry = coalesce(get(get(registry, "party"), enemy_id), get(registry, enemy_id)).filter(|entry| js::present(Some(entry)))?;
    if let Some(Value::Array(known_by)) = get(Some(entry), "known_by") {
        let known: Vec<String> = known_by.iter().map(|id| js::string(Some(id))).collect();
        if js::truthy(Some(actor)) && !known.contains(&js::string(Some(actor))) {
            return None;
        }
    }
    Some(entry)
}

/// `exactEnemyFact(knowledge, key)`.
fn exact_enemy_fact(knowledge: Option<&Value>, key: &str) -> bool {
    is_str(get(knowledge, key), "exact") || js::is_true(get(knowledge, key))
}

/// `exactEnemyHealthKnown(state, enemyId, actorId)`.
fn exact_enemy_health_known(state: Option<&Value>, enemy_id: &str, actor: &Value) -> bool {
    let knowledge = enemy_knowledge_for(state, enemy_id, actor);
    is_str(get(knowledge, "health"), "exact") || exact_enemy_fact(knowledge, "hp") || js::is_true(get(knowledge, "exact_hp"))
}

/// `enemyHealthStatus(enemy)`.
fn enemy_health_status(enemy: Option<&Value>) -> String {
    if !js::present(get(enemy, "hp")) && !js::present(get(enemy, "maxHp")) {
        if js::is_false(get(enemy, "alive")) {
            return "defeated".into();
        }
        let status = text_of(get(enemy, "healthStatus"), 20);
        return if status.is_empty() { "unharmed".into() } else { status };
    }
    let hp = integer(get(enemy, "hp"), 0).max(0);
    let maximum = integer(coalesce(get(enemy, "maxHp"), get(enemy, "max_hp")), 1).max(1);
    if js::is_false(get(enemy, "alive")) || hp <= 0 {
        return "defeated".into();
    }
    let ratio = hp as f64 / maximum as f64;
    if ratio >= 1.0 {
        "unharmed"
    } else if ratio > 0.5 {
        "wounded"
    } else if ratio > 0.25 {
        "bloodied"
    } else {
        "critical"
    }
    .into()
}

/// `publicEnemyImage(value)`: только файлы репозитория.
fn public_enemy_image(value: Option<&Value>) -> String {
    let candidate = text_of(value, 180);
    if text::test(re!(r"^\/assets\/enemies\/(?:dnd-2014\/)?[a-z0-9][a-z0-9-]*\.png$", "u"), &candidate) {
        return candidate;
    }
    if sk_chargen::npc_portraits::NPC_PORTRAIT_CHARACTER_ASSETS.iter().any(|(_, path)| *path == candidate) {
        candidate
    } else {
        String::new()
    }
}

/// `maskedActorIdentity(actor)`.
fn masked_actor_identity(actor: Option<&Value>) -> bool {
    if ["masked", "is_masked", "identity_masked", "identityMasked", "masked_identity"].iter().any(|key| js::is_true(get(actor, key)))
        || js::is_false(get(actor, "identified"))
        || js::is_false(get(actor, "identity_known"))
    {
        return true;
    }
    let name = text_of(coalesce(get(actor, "name"), get(actor, "character")), 160);
    text::test(
        re!(r"^(?:\?+|unknown|неизвестн|неопознан|безымянн|скрыт|маскир|masked|тайн(?:ый|ое|ая)|враг|существо|creature|enemy)(?:\s|$)", "iu"),
        &name,
    )
}

/// `publicActorFootprintFor(actor, { hideMasked })`: `{ version: 1, size }`
/// или `None`; маскированному врагу размер не отдаётся.
pub fn public_actor_footprint_for(actor: Option<&Value>, hide_masked: bool) -> Option<Value> {
    let raw = get(actor, "footprint").filter(|raw| raw.is_object())?;
    if js::number(get(Some(raw), "version")) != 1.0 {
        return None;
    }
    if hide_masked && masked_actor_identity(actor) {
        return None;
    }
    let raw_size = js::number(get(Some(raw), "size"));
    if !js::is_safe_integer_number(get(Some(raw), "size")) || !(1.0..=4.0).contains(&raw_size) {
        return None;
    }
    let size = sk_geometry::actor_footprint::footprint_size_for(actor);
    (1..=4).contains(&size).then(|| json!({ "version": 1, "size": size }))
}

/// `publicActorWithFootprint(actor, options)`.
fn public_actor_with_footprint(actor: &Value, hide_masked: bool) -> Value {
    let mut rest = spread_any(Some(actor));
    rest.shift_remove("footprint");
    if let Some(footprint) = public_actor_footprint_for(Some(actor), hide_masked) {
        rest.insert("footprint".into(), footprint);
    }
    Value::Object(rest)
}

/// `publicEnemyFootprintFor(state, enemy)`.
fn public_enemy_footprint_for(state: Option<&Value>, enemy: &Value) -> Option<Value> {
    let footprint = public_actor_footprint_for(Some(enemy), true)?;
    let anchor = json!({ "x": integer(get(Some(enemy), "x"), 0), "y": integer(get(Some(enemy), "y"), 0) });
    let cells = sk_geometry::actor_footprint::footprint_cells_for(Some(&json!({ "footprint": footprint })), Some(&anchor));
    if cells.is_empty() {
        return None;
    }
    let raw_map = get(get(state, "scene"), "map");
    if js::present(raw_map) {
        let map = tmap::deserialize_tactical_map(raw_map?).ok()?;
        return cells.iter().all(|cell| tmap::cell_at(&map, cell.x, cell.y).is_some_and(|found| found.revealed)).then_some(footprint);
    }
    let legacy = arr(get(get(state, "scene"), "cells"));
    if legacy.is_empty() {
        return None;
    }
    let by_position: HashMap<String, &Value> = legacy.iter().map(|cell| (format!("{},{}", integer(get(Some(cell), "x"), 0), integer(get(Some(cell), "y"), 0)), cell)).collect();
    cells
        .iter()
        .all(|cell| by_position.get(&format!("{},{}", cell.x, cell.y)).is_some_and(|found| js::is_true(get(Some(found), "revealed"))))
        .then_some(footprint)
}

/// `publicLegendaryFor(enemy, state, id)`.
fn public_legendary_for(enemy: &Value, state: Option<&Value>, id: &str) -> R<Option<Value>> {
    let Some(declared) = get(Some(enemy), "legendary").filter(|value| value.is_object()) else { return Ok(None) };
    if arr(get(Some(declared), "actions")).is_empty() {
        return Ok(None);
    }
    let uses = integer(get(Some(declared), "uses"), 3).clamp(1, 5);
    let stored = get(get(get(state, "mechanics"), "conditions"), id);
    let conditions = match stored {
        None | Some(Value::Null) => &[][..],
        Some(Value::Array(items)) => items.as_slice(),
        Some(_) => return Err(ProjectionError::not_function("conditions", "map")),
    };
    let spent = conditions
        .iter()
        .filter(|condition| text_of(coalesce(get(Some(condition), "id"), Some(condition)), 160).starts_with("legendary-action-used:"))
        .count() as i64;
    Ok(Some(json!({ "uses": uses, "used": spent.clamp(0, uses) })))
}

/// `publicEnemyFor(enemy, state, actorId)`: качественная карточка врага;
/// точные ОЗ, КД, скорость и стат-блок — только по знанию отряда.
pub fn public_enemy_for(enemy: Option<&Value>, state: Option<&Value>, actor_id: Option<&Value>) -> ProjectionResult<Value> {
    let empty = Value::Object(Map::new());
    let enemy = match enemy {
        None => &empty,
        Some(Value::Null) => return Err(ProjectionError::null_read("id")),
        Some(enemy) => enemy,
    };
    let state = state.or(Some(&empty));
    let actor = actor_arg(actor_id);
    let source = Some(enemy);
    let id = text_of(coalesce(get(source, "id"), get(source, "actor_id")), 120);
    let knowledge = enemy_knowledge_for(state, &id, &actor);
    let exact_health = exact_enemy_health_known(state, &id, &actor);
    let image = public_enemy_image(get(source, "image"));
    let creature_type = text_of(get(source, "creature_type"), 80);
    let legendary = public_legendary_for(enemy, state, &id)?;
    let footprint = public_enemy_footprint_for(state, enemy);
    let mut out = Map::new();
    out.insert("id".into(), Value::String(id.clone()));
    out.insert("name".into(), text_value(get(source, "name"), 120));
    if let Some(legendary) = legendary {
        out.insert("boss".into(), Value::Bool(true));
        out.insert("legendary".into(), legendary);
    }
    out.insert("x".into(), Value::from(integer(get(source, "x"), 0)));
    out.insert("y".into(), Value::from(integer(get(source, "y"), 0)));
    if let Some(footprint) = footprint {
        out.insert("footprint".into(), footprint);
    }
    if !image.is_empty() {
        out.insert("image".into(), Value::String(image));
    }
    if !creature_type.is_empty() {
        out.insert("creature_type".into(), Value::String(creature_type));
    }
    let alive = !js::is_false(get(source, "alive")) && (!js::present(get(source, "hp")) || integer(get(source, "hp"), 0) > 0);
    out.insert("alive".into(), Value::Bool(alive));
    out.insert("healthStatus".into(), Value::String(enemy_health_status(source)));
    out.insert("healthKnown".into(), Value::String(if exact_health { "exact" } else { "banded" }.into()));
    if exact_health {
        out.insert("hp".into(), Value::from(integer(get(source, "hp"), 0).max(0)));
        out.insert("maxHp".into(), Value::from(integer(coalesce(get(source, "maxHp"), get(source, "max_hp")), 1).max(1)));
    }
    if exact_enemy_fact(knowledge, "armor_class") || exact_enemy_fact(knowledge, "armor") {
        out.insert("armor".into(), Value::from(integer(coalesce(get(source, "armor"), get(source, "armor_class")), 10).max(0)));
    }
    if exact_enemy_fact(knowledge, "speed") {
        out.insert("speed".into(), Value::from(sk_rules::speed::effective_speed_feet(state.unwrap_or(&Value::Null), enemy, &id)));
    }
    if exact_enemy_fact(knowledge, "stat_block") && js::present(get(source, "stat_block_id")) {
        out.insert("stat_block_id".into(), text_value(get(source, "stat_block_id"), 120));
    }
    Ok(Value::Object(out))
}

/// `publicInitiativeFor(initiative, state, actorId)`.
fn public_initiative_for(initiative: Option<&Value>, state: Option<&Value>) -> R<Value> {
    let enemies = enemy_ids(state)?;
    Ok(Value::Array(
        arr(initiative)
            .iter()
            .map(|entry| {
                let entry_id = text_of(get(Some(entry), "actor_id"), 120);
                if !enemies.contains(&entry_id) {
                    return entry.clone();
                }
                let mut out = Map::new();
                out.insert("actor_id".into(), Value::String(entry_id));
                if js::present(get(Some(entry), "shared_with")) {
                    out.insert("shared_with".into(), text_value(get(Some(entry), "shared_with"), 120));
                }
                Value::Object(out)
            })
            .collect(),
    ))
}

// --- журнал боя ---------------------------------------------------------------------

const TARGET_ROLL_EVENT_TYPES: [&str; 4] = ["SavingThrowResolved", "AbilityCheckResolved", "SpellSavingThrowResolved", "ConcentrationSavingThrowResolved"];
const TARGET_ROLL_BATTLE_LOG_TYPES: [&str; 2] = ["spell-save", "concentration-save"];
const UNKNOWN_AREA_SPELL_ID: &str = "";
const PUBLIC_AREA_ID_NAMESPACE: &str = "skazanie:public-area:v1";

/// `publicAreaId(value)`: постоянный публичный ключ длящейся области.
fn public_area_id(value: Option<&Value>) -> String {
    let source = text_of(value, 180);
    let digest = hash::sha256_hex(format!("{PUBLIC_AREA_ID_NAMESPACE}\0{source}"));
    format!("area-public-v1:{}", &digest[..24])
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct PublicPoint {
    x: i64,
    y: i64,
}

impl PublicPoint {
    fn key(self) -> String {
        format!("{},{}", self.x, self.y)
    }

    fn to_value(self) -> Value {
        json!({ "x": self.x, "y": self.y })
    }

    fn to_map(self) -> Map<String, Value> {
        let mut out = Map::new();
        out.insert("x".into(), Value::from(self.x));
        out.insert("y".into(), Value::from(self.y));
        out
    }
}

/// `publicPoint(value)`.
fn public_point(value: Option<&Value>) -> Option<PublicPoint> {
    value.filter(|value| value.is_object())?;
    let x = get(value, "x");
    let y = get(value, "y");
    (js::is_safe_integer_number(x) && js::is_safe_integer_number(y)).then(|| PublicPoint { x: integer(x, 0), y: integer(y, 0) })
}

fn has_own(value: &Value, key: &str) -> bool {
    value.as_object().is_some_and(|map| map.contains_key(key))
}

/// Видимость журнала: кто и какие клетки уже в проекции зрителя.
struct Visibility<'a> {
    actor_ids: &'a IndexSet<String>,
    cell_keys: &'a IndexSet<String>,
    enemy_ids: &'a IndexSet<String>,
    social_npc_ids: &'a IndexSet<String>,
}

/// `publicBattleEventFor(entry, state, actorId, visibility)`: `None` — `null`.
fn public_battle_event_for(entry: &Value, state: Option<&Value>, actor: &Value, visibility: &Visibility<'_>) -> Option<Value> {
    let Value::Object(source) = entry else { return Some(entry.clone()) };
    let ids = visibility.actor_ids;
    let cells = visibility.cell_keys;
    let mut result = source.clone();
    if let Some(Value::Array(target_ids)) = source.get("targetIds") {
        result.insert("targetIds".into(), Value::Array(target_ids.iter().filter(|id| ids.contains(&js::string(Some(id)))).cloned().collect()));
    }
    let spell_id = source.get("spellId");
    if is_str(spell_id, "longstrider") || is_str(spell_id, "mass-cure-wounds") {
        let targets: Vec<Value> = if matches!(source.get("targetIds"), Some(Value::Array(_))) {
            arr(result.get("targetIds")).to_vec()
        } else {
            let target = source.get("targetId");
            if ids.contains(&js::string(target)) {
                vec![target.cloned().unwrap_or(Value::Null)]
            } else {
                Vec::new()
            }
        };
        let actor_visible = ids.contains(&js::string(source.get("actorId")));
        if !actor_visible && targets.is_empty() {
            return None;
        }
        result.insert("targetIds".into(), Value::Array(targets.clone()));
        if !actor_visible {
            result.shift_remove("actorId");
        }
        if !ids.contains(&js::string(source.get("targetId"))) {
            match targets.first() {
                Some(first) => {
                    result.insert("targetId".into(), first.clone());
                }
                None => {
                    result.shift_remove("targetId");
                }
            }
        }
        if is_str(spell_id, "longstrider") {
            for key in ["from", "to", "area"] {
                result.shift_remove(key);
            }
        }
    }
    let has_visual = source.contains_key("attackVisual") || source.contains_key("attack_visual");
    let attack_visual = if has_visual {
        sk_scene_base::actor_appearance::normalize_attack_visual(coalesce(source.get("attackVisual"), source.get("attack_visual")))
    } else {
        None
    };
    if has_visual {
        result.shift_remove("attack_visual");
        match &attack_visual {
            Some(visual) => {
                result.insert("attackVisual".into(), visual.clone());
            }
            None => {
                result.shift_remove("attackVisual");
            }
        }
    }
    let entry_type = source.get("type");
    if is_str(entry_type, "attack") {
        result.shift_remove("trajectory");
    }
    let target_id = text_of(coalesce(source.get("targetId"), source.get("target_id")), 120);
    let acting_id = text_of(coalesce(source.get("actorId"), source.get("actor_id")), 120);
    if is_str(entry_type, "healing") {
        if !ids.contains(&target_id) {
            return None;
        }
        if !ids.contains(&acting_id) {
            for key in ["actorId", "actor_id", "actorKind", "from"] {
                result.shift_remove(key);
            }
        }
    }
    let visible_cell = |point: PublicPoint| cells.contains(&point.key());
    if is_str(entry_type, "attack") && (has_own(entry, "from") || has_own(entry, "to")) {
        let from = public_point(source.get("from"));
        let to = public_point(source.get("to"));
        match (from, to) {
            (Some(from), Some(to)) if attack_visual.is_some() && ids.contains(&acting_id) && ids.contains(&target_id) && visible_cell(from) && visible_cell(to) => {
                result.insert("from".into(), from.to_value());
                result.insert("to".into(), to.to_value());
            }
            _ => {
                result.shift_remove("from");
                result.shift_remove("to");
            }
        }
    }
    if is_str(entry_type, "spell") && (has_own(entry, "from") || has_own(entry, "to") || has_own(entry, "area")) {
        let from = public_point(source.get("from"));
        let to = public_point(source.get("to"));
        let area = public_point(source.get("area"));
        let source_visible = !acting_id.is_empty() && ids.contains(&acting_id);
        match from {
            Some(from) if source_visible && visible_cell(from) => {
                result.insert("from".into(), from.to_value());
            }
            _ => {
                result.shift_remove("from");
            }
        }
        match to {
            Some(to) if visible_cell(to) => {
                result.insert("to".into(), to.to_value());
                let raw_area = source.get("area");
                match area {
                    Some(area) if visible_cell(area) && js::is_finite_number(get(raw_area, "radiusFeet")) => {
                        let mut public_area = area.to_map();
                        public_area.insert("radiusFeet".into(), Value::from(integer(get(raw_area, "radiusFeet"), 0).max(0)));
                        let grid_origin = public_point(get(raw_area, "gridOrigin"));
                        if let Some(grid) = grid_origin.filter(|grid| is_str(get(raw_area, "geometryVersion"), "circle-grid-v2") && visible_cell(*grid)) {
                            public_area.insert("geometryVersion".into(), Value::String("circle-grid-v2".into()));
                            public_area.insert("gridOrigin".into(), grid.to_value());
                            let shape = get(raw_area, "shape");
                            if is_str(shape, "sphere") || is_str(shape, "cylinder") {
                                public_area.insert("shape".into(), shape.cloned().unwrap_or(Value::Null));
                            }
                        }
                        result.insert("area".into(), Value::Object(public_area));
                    }
                    _ => {
                        result.shift_remove("area");
                    }
                }
            }
            _ => {
                result.shift_remove("to");
                result.shift_remove("area");
            }
        }
    }
    if is_str(entry_type, "area-attack") && has_own(entry, "from") {
        let from = public_point(source.get("from"));
        let area = public_point(source.get("area"));
        match (from, area) {
            (Some(from), Some(area)) if ids.contains(&acting_id) && visible_cell(from) && visible_cell(area) => {
                let raw_area = source.get("area");
                result.insert("from".into(), from.to_value());
                let mut public_area = area.to_map();
                public_area.insert("radiusFeet".into(), Value::from(integer(get(raw_area, "radiusFeet"), 5).max(5)));
                let shape = get(raw_area, "shape");
                let shape = if is_str(shape, "sphere") || is_str(shape, "cone") || is_str(shape, "line") { shape.cloned().unwrap_or(Value::Null) } else { Value::String("sphere".into()) };
                public_area.insert("shape".into(), shape);
                result.insert("area".into(), Value::Object(public_area));
            }
            _ => {
                result.shift_remove("from");
                result.shift_remove("area");
            }
        }
    }
    if is_str(entry_type, "move") && (has_own(entry, "from") || has_own(entry, "to")) {
        let from = public_point(source.get("from"));
        let to = public_point(source.get("to"));
        match (from, to) {
            (Some(from), Some(to)) if ids.contains(&acting_id) && visible_cell(from) && visible_cell(to) => {
                result.insert("from".into(), from.to_value());
                result.insert("to".into(), to.to_value());
            }
            _ => {
                result.shift_remove("from");
                result.shift_remove("to");
            }
        }
    }
    if is_str(entry_type, "move") && has_own(entry, "path") {
        let path: Vec<Option<PublicPoint>> = arr(source.get("path")).iter().map(|point| public_point(Some(point))).collect();
        let to = public_point(result.get("to"));
        let valid = js::truthy(result.get("from"))
            && to.is_some()
            && !path.is_empty()
            && path.iter().all(|point| point.is_some_and(visible_cell))
            && matches!((path.last(), to), (Some(Some(last)), Some(to)) if last.key() == to.key());
        if valid {
            result.insert("path".into(), Value::Array(path.into_iter().flatten().map(PublicPoint::to_value).collect()));
        } else {
            result.shift_remove("path");
        }
    }
    if visibility.social_npc_ids.contains(&target_id) {
        for key in ["hpBefore", "hpAfter", "maximumHpBefore", "maximumHpAfter"] {
            result.shift_remove(key);
        }
    }
    let enemies = visibility.enemy_ids;
    if enemies.contains(&target_id) && !exact_enemy_health_known(state, &target_id, actor) {
        for key in ["hpBefore", "hpAfter", "maximumHpBefore", "maximumHpAfter"] {
            result.shift_remove(key);
        }
        if text_of(entry_type, 40) == "healing" {
            result.shift_remove("healing");
        }
        if objectish(result.get("roll")) {
            let mut roll = spread_any(result.get("roll"));
            roll.shift_remove("difficulty");
            result.insert("roll".into(), Value::Object(roll));
        }
    }
    let roll_belongs_to_target = TARGET_ROLL_BATTLE_LOG_TYPES.contains(&text_of(entry_type, 40).as_str());
    if objectish(result.get("roll")) && (enemies.contains(&acting_id) || (roll_belongs_to_target && enemies.contains(&target_id))) {
        let roll = result.get("roll");
        let public_roll = json!({ "total": integer(get(roll, "total"), 0), "hit": js::is_true(get(roll, "hit")) });
        result.insert("roll".into(), public_roll);
        result.shift_remove("rollDice");
    }
    Some(Value::Object(result))
}

// --- состояния, ресурсы и области -----------------------------------------------------

/// Условия противника с закрытым ключом: префикс → качественная форма.
const OPAQUE_ENEMY_CONDITION_IDS: [(&str, &str); 7] = [
    ("weapon-coated:", "weapon-coated"),
    ("monster-action-used:", "monster-action-used"),
    ("npc-tactic-used:", "npc-tactic-used"),
    ("monster-spell-used:", "monster-spell-used"),
    ("pocket-picked:", "pocket-picked"),
    ("legendary-action-used:", "legendary-action-used"),
    ("legendary-resistance-used:", "legendary-resistance-used"),
];

/// Служебная бухгалтерия хода — не состояние существа.
const ENEMY_BOOKKEEPING_CONDITIONS: [&str; 6] =
    ["monster-action-used", "npc-tactic-used", "monster-spell-used", "legendary-action-used", "legendary-resistance-used", "pocket-picked"];

/// Поля условия, которые принадлежат ведущему.
const ENEMY_CONDITION_PRIVATE_KEYS: [&str; 4] = ["rider_damage", "rider_damage_type", "rider_source_name", "source_item_id"];

/// `publicEnemyConditionId(value)`.
fn public_enemy_condition_id(value: Option<&Value>) -> String {
    let id = text_of(value, 160);
    match OPAQUE_ENEMY_CONDITION_IDS.iter().find(|(prefix, _)| id.starts_with(prefix)) {
        Some((_, public)) => (*public).to_string(),
        None => id,
    }
}

fn condition_key(condition: &Value) -> Option<&Value> {
    coalesce(get(Some(condition), "id"), Some(condition))
}

/// `publicConditionsFor(value, enemyIds, visibleActorIds)`.
fn public_conditions_for(value: Option<&Value>, enemies: &IndexSet<String>, visible: &IndexSet<String>) -> Value {
    let Some(map) = plain(value) else { return Value::Object(Map::new()) };
    let mut projected = Map::new();
    for (owner, stored) in js::entries(map) {
        let Value::Array(stored_list) = stored else {
            assign_key(&mut projected, owner, stored.clone());
            continue;
        };
        let mut conditions = Vec::new();
        for condition in stored_list {
            let scoped = matches!(get(Some(condition), "true_strike_version"), Some(Value::Number(number)) if number.as_f64() == Some(1.0));
            if !scoped
                && !is_str(get(Some(condition), "id"), "longstrider")
                && !is_str(get(Some(condition), "spell_id"), "longstrider")
                && !is_str(Some(condition), "longstrider")
            {
                conditions.push(condition.clone());
                continue;
            }
            if !visible.contains(owner) {
                continue;
            }
            if !objectish(Some(condition)) {
                conditions.push(condition.clone());
                continue;
            }
            let mut copy = spread_any(Some(condition));
            if !visible.contains(&js::string(copy.get("source_actor"))) {
                copy.shift_remove("source_actor");
            }
            if scoped && !visible.contains(&js::string(copy.get("target_actor_id"))) {
                copy.shift_remove("target_actor_id");
            }
            conditions.push(Value::Object(copy));
        }
        if !stored_list.is_empty() && conditions.is_empty() {
            continue;
        }
        if !enemies.contains(owner) {
            let kept: Vec<Value> =
                conditions.into_iter().filter(|condition| !ENEMY_BOOKKEEPING_CONDITIONS.contains(&public_enemy_condition_id(condition_key(condition)).as_str())).collect();
            assign_key(&mut projected, owner, Value::Array(kept));
            continue;
        }
        let public: Vec<Value> = conditions
            .iter()
            .filter_map(|condition| {
                let public_id = public_enemy_condition_id(condition_key(condition));
                if public_id.is_empty() || ENEMY_BOOKKEEPING_CONDITIONS.contains(&public_id.as_str()) {
                    return None;
                }
                let Value::Object(object) = condition else { return Some(Value::String(public_id)) };
                let mut copy = object.clone();
                copy.insert("id".into(), Value::String(public_id));
                for key in ENEMY_CONDITION_PRIVATE_KEYS {
                    copy.shift_remove(key);
                }
                Some(Value::Object(copy))
            })
            .collect();
        assign_key(&mut projected, owner, Value::Array(public));
    }
    Value::Object(projected)
}

/// `publicActorKeyedMapFor(value, enemyIds, known)`.
fn public_actor_keyed_map_for(value: Option<&Value>, enemies: &IndexSet<String>, known: impl Fn(&str) -> bool) -> Value {
    let Some(map) = plain(value) else { return Value::Object(Map::new()) };
    Value::Object(js::entries(map).into_iter().filter(|(owner, _)| !enemies.contains(*owner) || known(owner)).map(|(key, value)| (key.clone(), value.clone())).collect())
}

/// `publicResourcesFor(state, value)`.
fn public_resources_for(state: &Value, value: Option<&Value>) -> R<Value> {
    let Some(map) = plain(value) else { return Ok(Value::Object(Map::new())) };
    let mut out = Map::new();
    for (owner, pools) in js::entries(map) {
        let Value::Object(pool_map) = pools else {
            out.insert(owner.clone(), pools.clone());
            continue;
        };
        let players = list_or_empty(get(Some(state), "players"), "state.players")?;
        let Some(actor) = players.iter().find(|candidate| js::s(get(Some(candidate), "id")) == *owner) else {
            out.insert(owner.clone(), pools.clone());
            continue;
        };
        let superseded: HashSet<String> = sk_combat_content::combat_actions::superseded_feature_resource_ids_for(Some(actor)).into_iter().collect();
        if superseded.is_empty() {
            out.insert(owner.clone(), pools.clone());
            continue;
        }
        let kept: Map<String, Value> = js::entries(pool_map).into_iter().filter(|(resource, _)| !superseded.contains(*resource)).map(|(key, value)| (key.clone(), value.clone())).collect();
        out.insert(owner.clone(), Value::Object(kept));
    }
    Ok(Value::Object(out))
}

/// `publicActiveEffectFor(state, effect, visibleCellKeys, visibleActorIds)`.
fn public_active_effect_for(scene: &Scene<'_>, effect: &Value, cells: &IndexSet<String>, visible: &IndexSet<String>) -> Option<Value> {
    let source = Some(effect);
    let id = text_of(coalesce(get(source, "effect_id"), get(source, "id")), 180);
    if id.is_empty() {
        return None;
    }
    let center = public_point(get(source, "center"));
    let center_visible = center.is_some_and(|center| cells.contains(&center.key()));
    let grid_origin = public_point(get(source, "grid_origin"));
    let covered: Vec<Value> = cells
        .iter()
        .filter_map(|key| {
            let mut parts = key.split(',').map(js::parse_number);
            let x = parts.next().unwrap_or(f64::NAN);
            let y = parts.next().unwrap_or(f64::NAN);
            sk_rules::areas::shape::position_in_effect_in(scene, Some(sk_geometry::Point::new(x, y)), effect, None).then(|| json!({ "x": js::num(x), "y": js::num(y) }))
        })
        .collect();
    let source_actor = text_of(get(source, "source_actor"), 120);
    let source_visible = !source_actor.is_empty() && visible.contains(&source_actor);
    if !center_visible && covered.is_empty() && !(js::is_true(get(source, "follows_source")) && source_visible) {
        return None;
    }
    let public_id = public_area_id(Some(&Value::String(id)));
    let mut out = Map::new();
    out.insert("id".into(), Value::String(public_id.clone()));
    out.insert("effect_id".into(), Value::String(public_id));
    out.insert("spell_id".into(), Value::String(if center_visible || source_visible { text_of(get(source, "spell_id"), 120) } else { UNKNOWN_AREA_SPELL_ID.into() }));
    if source_visible {
        out.insert("source_actor".into(), Value::String(source_actor));
    }
    if let Some(center) = center.filter(|_| center_visible) {
        out.insert("center".into(), center.to_value());
    }
    if center_visible && is_str(get(source, "geometry_version"), "circle-grid-v2") {
        if let Some(grid) = grid_origin.filter(|grid| cells.contains(&grid.key())) {
            out.insert("geometry_version".into(), Value::String("circle-grid-v2".into()));
            out.insert("grid_origin".into(), grid.to_value());
        }
    }
    if !covered.is_empty() {
        out.insert("cells".into(), Value::Array(covered));
    }
    if js::is_true(get(source, "difficult_terrain")) {
        out.insert("difficult_terrain".into(), Value::Bool(true));
    }
    if js::is_true(get(source, "concentration")) {
        out.insert("concentration".into(), Value::Bool(true));
    }
    if center_visible && js::present(get(source, "radius_feet")) {
        out.insert("radius_feet".into(), Value::from(integer(get(source, "radius_feet"), 0).max(0)));
    }
    let shape = js::string(get(source, "area_shape"));
    if center_visible && ["sphere", "cylinder", "cone", "cube", "line"].contains(&shape.as_str()) {
        out.insert("area_shape".into(), Value::String(shape));
    }
    if center_visible && js::present(get(source, "area_side_feet")) {
        out.insert("area_side_feet".into(), Value::from(integer(get(source, "area_side_feet"), 0).max(0)));
    }
    Some(Value::Object(out))
}

/// `publicActiveEffectsFor(state, value, visibleCellKeys, visibleActorIds)`.
fn public_active_effects_for(state: &Value, value: Option<&Value>, cells: &IndexSet<String>, visible: &IndexSet<String>) -> Value {
    let Some(Value::Array(effects)) = value else { return Value::Array(Vec::new()) };
    let scene = Scene::new(state);
    Value::Array(effects.iter().filter(|effect| effect.is_object()).filter_map(|effect| public_active_effect_for(&scene, effect, cells, visible)).collect())
}

/// `publicConcentrationFor(value, enemyIds, visibleActorIds, activeEffects)`.
fn public_concentration_for(value: Option<&Value>, enemies: &IndexSet<String>, visible: &IndexSet<String>, active_effects: Option<&Value>) -> Value {
    let Some(map) = plain(value) else { return Value::Object(Map::new()) };
    let mut area_ids: HashMap<String, String> = HashMap::new();
    for effect in arr(active_effects) {
        if !effect.is_object() {
            continue;
        }
        let id = text_of(coalesce(get(Some(effect), "effect_id"), get(Some(effect), "id")), 180);
        if !id.is_empty() {
            let public = public_area_id(Some(&Value::String(id.clone())));
            area_ids.insert(id, public);
        }
    }
    Value::Object(
        js::entries(map)
            .into_iter()
            .filter(|(owner, _)| visible.contains(*owner) && !enemies.contains(*owner))
            .map(|(owner, focus)| {
                let original = text_of(get(Some(focus), "effect_id"), 180);
                let effect_id = area_ids.get(&original).cloned().unwrap_or(original);
                (owner.clone(), if effect_id.is_empty() { json!({}) } else { json!({ "effect_id": effect_id }) })
            })
            .collect(),
    )
}

/// `redactSpellVisualPayload(payload, state)`.
fn redact_spell_visual_payload(payload: &mut Map<String, Value>, cells: &IndexSet<String>) {
    for key in ["from", "to", "origin", "center", "area_grid_origin"] {
        if !payload.contains_key(key) {
            continue;
        }
        let visible = public_point(payload.get(key)).is_some_and(|point| cells.contains(&point.key()));
        if !visible {
            payload.shift_remove(key);
        }
    }
    if !js::truthy(payload.get("area_grid_origin")) {
        payload.shift_remove("area_geometry_version");
    }
}

/// `publicCombatMessageFor(message)`: строки системы боя без КД и ОЗ.
fn public_combat_message_for(message: &Value) -> Value {
    let Value::Object(object) = message else { return message.clone() };
    let is_combat = js::s(object.get("id")).starts_with("combat-") || text::lower(&js::s(object.get("author"))).contains("система боя");
    let Some(Value::String(body)) = object.get("text") else { return message.clone() };
    if !is_combat {
        return message.clone();
    }
    let mut body = text::replace_all(re!(r"\s+против КД\s+\d+\s+—", "u"), body, " —");
    body = text::replace_all(re!(r";\s*ОЗ\s+\d+\s*→\s*\d+", "u"), &body, "");
    body = text::replace_all(re!(r",\s*но Охрана от смерти срабатывает и оставляет 1 ОЗ", "u"), &body, ", но Охрана от смерти удерживает цель на ногах");
    body = text::replace_all(re!(r"Максимум ОЗ ([^.]+?) снижается:\s*\d+\s*→\s*\d+", "u"), &body, "Максимум ОЗ ${1} снижается");
    let mut out = object.clone();
    out.insert("text".into(), Value::String(body));
    Value::Object(out)
}

/// `publicEncounterFor(encounter)`: `None` — `null` (не объект).
/// `encounter` `None` — `undefined` (как `{}`).
pub fn public_encounter_for(encounter: Option<&Value>) -> Option<Value> {
    let empty = Value::Object(Map::new());
    let encounter = encounter.unwrap_or(&empty);
    let source = Some(encounter);
    if !encounter.is_object() {
        return None;
    }
    let status = js::string(get(source, "status"));
    let mut out = Map::new();
    out.insert("id".into(), text_value(coalesce(get(source, "id"), get(source, "encounter_id")), 120));
    out.insert("status".into(), Value::String(if ["staged", "active", "ended"].contains(&status.as_str()) { status } else { "staged".into() }));
    out.insert("difficulty".into(), text_value(get(source, "difficulty"), 40));
    if let Some(label) = sk_encounters::encounter_assembler::encounter_difficulty_label(get(source, "difficulty")) {
        out.insert("difficulty_label".into(), label);
    }
    out.insert("theme".into(), text_value(get(source, "theme"), 40));
    out.insert("proposal_id".into(), text_value(get(source, "proposal_id"), 120));
    let ids: Vec<Value> = arr(get(source, "enemy_ids")).iter().map(|id| text_of(Some(id), 120)).filter(|id| !id.is_empty()).take(12).map(Value::String).collect();
    out.insert("enemy_ids".into(), Value::Array(ids));
    let threat = get(source, "threat");
    if objectish(threat) {
        out.insert(
            "threat".into(),
            json!({
                "budget_xp": integer(get(threat, "budget_xp"), 0).max(0),
                "spent_xp": integer(get(threat, "spent_xp"), 0).max(0),
                "quantity": integer(get(threat, "quantity"), 0).max(0),
            }),
        );
    }
    Some(Value::Object(out))
}

// --- окно реакции ---------------------------------------------------------------------

/// `REACTION_DAMAGE_PUBLIC_KEYS`: белый список урона окна реакции.
pub const REACTION_DAMAGE_PUBLIC_KEYS: [&str; 12] = [
    "damage_type",
    "raw_amount",
    "applied_amount",
    "immune",
    "resistant",
    "vulnerable",
    "temporary_hp_before",
    "temporary_hp_after",
    "temporary_hp_absorbed",
    "hp_before",
    "hp_after",
    "death_ward_triggered",
];

/// `REACTION_DAMAGE_COMPONENT_PUBLIC_KEYS`: белый список слагаемого урона.
pub const REACTION_DAMAGE_COMPONENT_PUBLIC_KEYS: [&str; 5] = ["damage_type", "raw_amount", "applied_amount", "temporary_hp_absorbed", "source"];

/// `publicReactionDamageFor(damage)`.
fn public_reaction_damage_for(damage: &Map<String, Value>) -> Map<String, Value> {
    let mut projected = Map::new();
    for key in REACTION_DAMAGE_PUBLIC_KEYS {
        if let Some(value) = damage.get(key) {
            projected.insert(key.into(), value.clone());
        }
    }
    if let Some(Value::Array(components)) = damage.get("damage_components") {
        let list: Vec<Value> = components
            .iter()
            .take(12)
            .map(|component| {
                let mut public = Map::new();
                if let Value::Object(component) = component {
                    for key in REACTION_DAMAGE_COMPONENT_PUBLIC_KEYS {
                        if let Some(value) = component.get(key) {
                            public.insert(key.into(), value.clone());
                        }
                    }
                }
                Value::Object(public)
            })
            .collect();
        projected.insert("damage_components".into(), Value::Array(list));
    }
    projected
}

/// `publicReactionWindowFor(window, state, actorId)`: `Null` — не объект.
fn public_reaction_window_for(window: Option<&Value>, state: Option<&Value>, actor: &Value) -> R<Value> {
    let Some(source) = plain(window) else { return Ok(Value::Null) };
    let window = Some(window.unwrap_or(&Value::Null));
    let enemies = enemy_ids(state)?;
    let target_id = text_of(source.get("target_id"), 120);
    let enemy_target = enemies.contains(&target_id);
    let enemy_source = enemies.contains(&text_of(source.get("source_actor_id"), 120));
    let raw_roll = source.get("trigger_roll");
    let mut trigger_roll = objectish(raw_roll).then(|| {
        let mut roll = Map::new();
        roll.insert("kept".into(), Value::from(integer(get(raw_roll, "kept"), 0)));
        roll.insert("modifier".into(), Value::from(integer(get(raw_roll, "modifier"), 0)));
        roll.insert("total".into(), Value::from(integer(get(raw_roll, "total"), 0)));
        roll.insert("difficulty".into(), Value::from(integer(get(raw_roll, "difficulty"), 0).max(0)));
        roll.insert("ability".into(), text_value(get(raw_roll, "ability"), 20));
        roll.insert("save_event_type".into(), text_value(get(raw_roll, "save_event_type"), 80));
        roll
    });
    if let Some(roll) = trigger_roll.as_mut() {
        if enemy_target {
            roll.shift_remove("difficulty");
        }
        let trigger = js::string(source.get("trigger"));
        let own_saving_throw = !enemies.contains(&text_of(source.get("actor_id"), 120)) && ["saving-throw-bonus-choice", "failed-saving-throw"].contains(&trigger.as_str());
        if enemy_source && !own_saving_throw {
            roll.shift_remove("kept");
            roll.shift_remove("modifier");
        }
        if js::truthy(get(raw_roll, "roll_id")) {
            roll.insert("roll_id".into(), text_value(get(raw_roll, "roll_id"), 160));
        }
        if is_str(source.get("resistance_phase"), "after-roll") && !js::present(get(raw_roll, "difficulty")) {
            roll.shift_remove("difficulty");
        }
    }
    let mut damage = plain(source.get("damage")).map(public_reaction_damage_for);
    if let Some(damage) = damage.as_mut() {
        if enemy_target && !exact_enemy_health_known(state, &target_id, actor) {
            for key in ["hp_before", "hp_after", "temporary_hp_before", "temporary_hp_after", "temporary_hp_absorbed", "raw_amount"] {
                damage.shift_remove(key);
            }
            if let Some(Value::Array(components)) = damage.get_mut("damage_components") {
                for component in components.iter_mut() {
                    if let Value::Object(component) = component {
                        component.shift_remove("temporary_hp_absorbed");
                        component.shift_remove("raw_amount");
                    }
                }
            }
        }
    }
    let mut out = Map::new();
    out.insert("id".into(), text_value(source.get("id"), 160));
    out.insert("trigger".into(), text_value(source.get("trigger"), 80));
    let phase = source.get("resistance_phase");
    if is_str(phase, "before-roll") || is_str(phase, "after-roll") {
        out.insert("resistance_phase".into(), phase.cloned().unwrap_or(Value::Null));
    }
    out.insert("actor_id".into(), text_value(source.get("actor_id"), 120));
    out.insert("source_actor_id".into(), text_value(source.get("source_actor_id"), 120));
    out.insert("target_id".into(), text_value(source.get("target_id"), 120));
    let action_ids: Vec<Value> = arr(source.get("action_ids")).iter().map(|id| text_of(Some(id), 120)).filter(|id| !id.is_empty()).take(20).map(Value::String).collect();
    out.insert("action_ids".into(), Value::Array(action_ids));
    let options: Vec<Value> = arr(source.get("action_options"))
        .iter()
        .take(20)
        .map(|option| {
            let option = Some(option);
            let mut entry = Map::new();
            entry.insert("id".into(), text_value(get(option, "id"), 120));
            entry.insert("name".into(), text_value(get(option, "name"), 160));
            entry.insert("description".into(), text_value(get(option, "description"), 500));
            if js::present(get(option, "resource")) {
                entry.insert("resource".into(), text_value(get(option, "resource"), 120));
            }
            if js::present(get(option, "cost")) {
                entry.insert("cost".into(), Value::from(integer(get(option, "cost"), 0).max(0)));
            }
            if js::present(get(option, "slot_level")) {
                entry.insert("slot_level".into(), Value::from(integer(get(option, "slot_level"), 0).max(0)));
            }
            if js::truthy(get(option, "requires_beneficiary")) {
                entry.insert("requires_beneficiary".into(), Value::Bool(true));
            }
            Value::Object(entry)
        })
        .collect();
    out.insert("action_options".into(), Value::Array(options));
    if let Some(roll) = trigger_roll {
        out.insert("trigger_roll".into(), Value::Object(roll));
    }
    if js::present(source.get("fighter_level")) {
        out.insert("fighter_level".into(), Value::from(integer(source.get("fighter_level"), 1).max(1)));
    }
    if let Some(damage) = damage {
        out.insert("damage".into(), Value::Object(damage));
    }
    if objectish(get(window, "pending_spell")) {
        out.insert("pending_spell".into(), Value::Object(spread_any(get(window, "pending_spell"))));
    }
    Ok(Value::Object(out))
}

/// `publicAutonomyFor(autonomy)`: темп, свои переходы и привалы, слава
/// ступенями; замысел Режиссёра наружу не идёт.
fn public_autonomy_for(autonomy: Option<&Value>) -> Option<Value> {
    let source = plain(autonomy)?;
    let empty = Value::Object(Map::new());
    let pacing = source.get("pacing").filter(|value| value.is_object()).unwrap_or(&empty);
    let reputations = source.get("reputations").filter(|value| value.is_object()).unwrap_or(&empty);
    let mut out = Map::new();
    if let Some(version) = source.get("schema_version") {
        out.insert("schema_version".into(), version.clone());
    }
    let phase = get(Some(pacing), "phase");
    let phase = if ["breather", "development", "escalation", "climax"].iter().any(|candidate| is_str(phase, candidate)) { phase.cloned().unwrap_or(Value::Null) } else { Value::String("breather".into()) };
    out.insert(
        "pacing".into(),
        json!({
            "beat": integer(get(Some(pacing), "beat"), 0).max(0),
            "phase": phase,
            "tension": integer(get(Some(pacing), "tension"), 0).clamp(0, 100),
        }),
    );
    out.insert("travel_history".into(), Value::Array(last_n(arr(source.get("travel_history")).to_vec(), 20)));
    out.insert("downtime_history".into(), Value::Array(last_n(arr(source.get("downtime_history")).to_vec(), 20)));
    let standing: Vec<Value> = reputations
        .as_object()
        .map(|map| js::entries(map))
        .unwrap_or_default()
        .into_iter()
        .take(100)
        .map(|(faction, score)| (text_of(Some(&Value::String(faction.clone())), 120), sk_society::reputation_policy::reputation_tier(score)))
        .filter(|(faction, _)| !faction.is_empty())
        .map(|(faction, tier)| json!({ "faction_id": faction, "tier": tier }))
        .collect();
    out.insert("reputation_standing".into(), Value::Array(standing));
    Some(Value::Object(out))
}

/// `PROJECTED_STATE_KEYS`: ключи состояния, по которым у проекции есть
/// осознанное решение (своя публичная форма или «отдаём как есть»). Это
/// белый список комнаты игрока: ключа нет в списке — игроку он не уходит.
pub const PROJECTED_STATE_KEYS: [&str; 64] = [
    "scene",
    "adventure",
    "worldMap",
    "worldMemory",
    "social",
    "merchants",
    "scene_npcs",
    "npc_world",
    "world_offices",
    "world_deeds",
    "offscreen_world",
    "courier_letters",
    "captives",
    "beasts",
    "law",
    "loot_containers",
    "tavern",
    "blessings",
    "scenario_attention",
    "scenario_knight",
    "scenario_court",
    "dialogues",
    "scene_dialogues",
    "lockpicking",
    "weather",
    "weather_by_actor",
    "enemies",
    "mechanics",
    "battleLog",
    "messages",
    "autonomy",
    "suggested_actions",
    "actor_appearances",
    "sessionCode",
    "campaign",
    "partyName",
    "partyMemberIds",
    "partyDecisionPolicy",
    "campaignConcept",
    "character_start_level",
    "state_version",
    "ruleset_id",
    "ruleset_version",
    "enabled_rule_packs",
    "enabled_house_rules",
    "ruleset_locked_at",
    "ruleset_selection_locked",
    "engine_mode",
    "players",
    "entities",
    "mapFeedback",
    "rulings",
    "activePlayerId",
    "tacticalTurn",
    "isNarrating",
    "pendingCheck",
    "agentInteraction",
    "lastDiceRoll",
    "actors",
    "economyLog",
    "state_projector_version",
    "presence",
    "turn_clock",
    "locationMaps",
];

// --- герои и облик --------------------------------------------------------------------

/// `playerItemsWithCapabilities(players, viewerId, rulesetId, state)`.
fn player_items_with_capabilities(players: Option<&Value>, viewer: &str, ruleset_id: &str, state: Option<&Value>) -> R<Vec<Value>> {
    let mut out = Vec::new();
    for player in arr(players) {
        if player.is_null() {
            return Err(ProjectionError::type_error("Cannot destructure 'actor' as it is null."));
        }
        let own = viewer.is_empty() || js::s(get(Some(player), "id")) == viewer;
        let Value::Object(mut public) = public_actor_with_footprint(player, false) else { continue };
        if !own {
            if let Some(Value::Array(actions)) = public.get("combatActions") {
                let filtered: Vec<Value> = actions.iter().filter(|action| js::s(get(Some(action), "id")) != "enervation-repeat").cloned().collect();
                public.insert("combatActions".into(), Value::Array(filtered));
            }
        }
        let spellcasting = if own && js::truthy(public.get("characterSheet")) { sk_combat_content::combat_spells::hero_spellcasting_summary_for(Some(player)) } else { None };
        let state_truthy = state.filter(|state| js::truthy(Some(state)));
        if own {
            if let Some(state) = state_truthy {
                let id = Value::String(js::s(get(Some(player), "id")));
                let modes = sk_rules::reactions::hero_reaction_modes_for(state, Some(&id));
                public.insert("reactionModes".into(), Value::Array(modes));
            }
        }
        if let Some(spellcaster) = spellcasting {
            let mut sheet = spread_any(public.get("characterSheet"));
            sheet.insert("spellcaster".into(), spellcaster);
            public.insert("characterSheet".into(), Value::Object(sheet));
        }
        if let (true, Some(state), "dnd_5e_2014", Some(Value::Array(spells))) = (own, state_truthy, ruleset_id, public.get("combatSpells")) {
            let spells: Vec<Value> = spells
                .iter()
                .map(|spell| {
                    let mut entry = spread_any(Some(spell));
                    entry.insert("componentAvailability".into(), sk_rules::spells::components::spell_component_availability_for(state, Some(player), Some(spell)).to_value());
                    Value::Object(entry)
                })
                .collect();
            public.insert("combatSpells".into(), Value::Array(spells));
        }
        let inventory: Vec<Value> = arr(public.get("inventory"))
            .iter()
            .map(|item| {
                let capabilities = sk_items::item_catalog::item_viewer_capabilities(Some(item), ruleset_id);
                let with = match capabilities {
                    Some(capabilities) => {
                        let mut copy = spread_any(Some(item));
                        copy.insert("capabilities".into(), capabilities);
                        Value::Object(copy)
                    }
                    None => item.clone(),
                };
                if own || !sk_items::item_catalog::PRIVATE_ITEM_ORIGIN_KINDS.contains(&js::s(get(Some(item), "origin")).as_str()) {
                    return with;
                }
                let mut rest = spread_any(Some(&with));
                rest.shift_remove("origin");
                Value::Object(rest)
            })
            .collect();
        public.insert("inventory".into(), Value::Array(inventory));
        out.push(Value::Object(public));
    }
    Ok(out)
}

/// `actorAppearancesForViewer(visible)`: облик фигурок только из уже
/// разрешённых записей комнаты.
pub fn actor_appearances_for_viewer(visible: Option<&Value>) -> Value {
    let mut appearances = Map::new();
    for (kind, key) in [("hero", "players"), ("enemy", "enemies"), ("summon", "actors"), ("neutral", "scene_npcs")] {
        let kind = Value::String(kind.into());
        for actor in arr(get(visible, key)) {
            if !sk_scene_base::actor_appearance::public_appearance_record(actor) {
                continue;
            }
            let id = text_of(get(Some(actor), "id"), 120);
            if id.is_empty() {
                continue;
            }
            appearances.insert(id, sk_scene_base::actor_appearance::actor_appearance_for(Some(&kind), Some(actor)));
        }
    }
    Value::Object(appearances)
}

/// `weatherByActorFor(state, { isAdmin, actorId })`.
fn weather_by_actor_for(state: &Value, is_admin: bool, actor_id: &str) -> Value {
    let party: HashSet<String> = arr(get(Some(state), "partyMemberIds")).iter().map(|id| js::string(Some(id))).collect();
    let mut ids: IndexSet<String> = IndexSet::new();
    for player in arr(get(Some(state), "players")) {
        let id = js::s(coalesce(get(Some(player), "id"), get(Some(player), "actor_id")));
        if !id.is_empty() && (is_admin || party.contains(&id) || id == actor_id) {
            ids.insert(id);
        }
    }
    Value::Object(ids.into_iter().map(|id| (id.clone(), sk_world_time::weather::weather_for_viewer(state, Some(&Value::String(id))))).collect())
}

fn suggested(room: &Value, actor: &Value) -> R<Value> {
    Ok(Value::Array(sk_tactical::action_hints::suggested_actions_for(Some(room), Some(actor))?.iter().map(|hint| hint.to_json()).collect()))
}

fn actor_list<'a>(state: Option<&'a Value>, keys: &[&str]) -> R<Vec<&'a Value>> {
    let mut list = Vec::new();
    for key in keys {
        match get(state, key) {
            None | Some(Value::Null) => {}
            Some(Value::Array(items)) => list.extend(items.iter()),
            Some(_) => return Err(ProjectionError::type_error(format!("state.{key} is not iterable"))),
        }
    }
    Ok(list)
}

fn actor_key(actor: &Value) -> R<String> {
    if actor.is_null() {
        return Err(ProjectionError::null_read("id"));
    }
    Ok(js::string(get(Some(actor), "id")))
}

/// Ветка ведущего `campaignStateForViewer`.
fn admin_room(state: &Value, actor: &Value) -> R<Value> {
    let actor_s = js::s(Some(actor));
    let source = Some(state);
    // Эти поля ниже заменяются всегда: на их месте — `null` до замены (ключ
    // сохраняет позицию), сцена и герои не копируются впустую (Ск2).
    const REPLACED: [&str; 4] = ["scene", "players", "mechanics", "merchants"];
    let mut room: Map<String, Value> = match state {
        Value::Object(map) => map.iter().map(|(key, value)| (key.clone(), if REPLACED.contains(&key.as_str()) { Value::Null } else { value.clone() })).collect(),
        _ => spread_any(source),
    };
    if js::truthy(get(source, "world_offices")) {
        room.insert("world_offices".into(), Value::Array(sk_world_life::world_offices::offices_for_viewer(source, &json!({ "isAdmin": true }))));
    }
    let scene_npcs = sk_npc_world::npc_positioning::scene_npcs_for_viewer(state);
    let mut appearance_input = Map::new();
    for key in ["players", "enemies", "actors"] {
        if let Some(value) = get(source, key) {
            appearance_input.insert(key.into(), value.clone());
        }
    }
    appearance_input.insert("scene_npcs".into(), Value::Array(scene_npcs.clone()));
    room.insert("actor_appearances".into(), actor_appearances_for_viewer(Some(&Value::Object(appearance_input))));
    let merchants: Vec<Value> = list_or_empty(get(source, "merchants"), "state.merchants")?
        .iter()
        .map(|merchant| {
            let mut entry = spread_any(Some(merchant));
            let can_trade = sk_economy::merchant_economy::merchant_trade_availability_for(state, Some(merchant), false).can_trade;
            entry.insert("can_trade".into(), Value::Bool(can_trade));
            Value::Object(entry)
        })
        .collect();
    room.insert("merchants".into(), Value::Array(merchants));
    room.insert("scene".into(), admin_scene_for(get(source, "scene")));
    room.insert("scene_npcs".into(), Value::Array(scene_npcs));
    room.insert("players".into(), Value::Array(player_items_with_capabilities(get(source, "players"), "", &js::s(get(source, "ruleset_id")), source)?));
    if js::truthy(get(source, "world_deeds")) {
        let deeds = sk_world_time::world_deeds::world_deeds_feed(state, &json!({ "limit": 40 }));
        room.insert("world_deeds".into(), json!({ "schema_version": sk_world_time::world_deeds::WORLD_DEEDS_SCHEMA_VERSION, "deeds": deeds }));
    }
    if js::truthy(get(source, "offscreen_world")) {
        let steps = sk_world_story::offscreen_world::offscreen_world_feed(state, Some(&json!(20)));
        room.insert("offscreen_world".into(), json!({ "schema_version": sk_world_story::offscreen_world::OFFSCREEN_WORLD_SCHEMA_VERSION, "steps": steps }));
    }
    room.insert("courier_letters".into(), sk_world_life::courier_letters::courier_letters_for_viewer(state, &json!({ "isAdmin": true })));
    room.insert("law".into(), sk_society::law_and_order::law_for_viewer(state, &json!({ "isAdmin": true })));
    room.insert("loot_containers".into(), sk_director::loot_containers::loot_containers_for_viewer(state, Some(&Value::String(actor_s.clone())), Some(&Value::Bool(true)))?);
    room.insert("beasts".into(), sk_npc_world::beast_taming::beasts_for_viewer(state, &json!({ "isAdmin": true })));
    insert_viewer_cards(&mut room, state, &actor_s)?;
    room.insert("weather".into(), sk_world_time::weather::weather_for_viewer(state, Some(actor)));
    room.insert("weather_by_actor".into(), weather_by_actor_for(state, true, &actor_s));
    let mut mechanics = spread_any(coalesce(get(source, "mechanics"), None));
    let mut movement = Map::new();
    for actor in actor_list(source, &["players", "actors", "enemies"])? {
        let id = actor_key(actor)?;
        movement.insert(id.clone(), sk_rules::geometry::movement::movement_for_actor(state, &id));
    }
    mechanics.insert("movement".into(), Value::Object(movement));
    let mut dice = Map::new();
    for player in list_or_empty(get(source, "players"), "state.players")? {
        let id = actor_key(player)?;
        let pool = sk_rules::rest::hit_point_dice_pool_for_actor(state, &js::s(get(Some(player), "id"))).map_or(Value::Null, sk_rules::rest::HitPointDicePool::to_value);
        dice.insert(id, pool);
    }
    mechanics.insert("hit_point_dice".into(), Value::Object(dice));
    room.insert("mechanics".into(), Value::Object(mechanics));
    let room = Value::Object(room);
    let hints = suggested(&room, &Value::String(actor_s))?;
    let Value::Object(mut room) = room else { return Ok(room) };
    room.insert("suggested_actions".into(), hints);
    Ok(Value::Object(room))
}

/// Карточки под героя-зрителя: таверна, благословения, взлом, двор сценария,
/// разговоры сцены — одинаковые у ведущего и у игрока.
fn insert_viewer_cards(room: &mut Map<String, Value>, state: &Value, actor_s: &str) -> R<()> {
    let player = json!({ "playerId": actor_s });
    let actor_value = Value::String(actor_s.to_string());
    room.insert("tavern".into(), sk_npc_world::tavern_life::tavern_for_viewer(state, &player).unwrap_or(Value::Null));
    room.insert("blessings".into(), sk_npc_world::blessings::blessings_for_viewer(state, &player));
    room.insert("lockpicking".into(), sk_ruleset::lockpicking::lockpicking_for_viewer(Some(state), Some(&actor_value)));
    let court = match sk_attention::scenario_attention::scenario_court_for_viewer(state, actor_s) {
        Some(court) => serde_json::to_value(court).map_err(|error| ProjectionError::type_error(error.to_string()))?,
        None => Value::Null,
    };
    room.insert("scenario_court".into(), court);
    room.insert("scene_dialogues".into(), sk_story::campaign_dialogues::scene_dialogues_for_viewer(state, Some(&actor_value)));
    Ok(())
}

/// `campaignStateForViewer(state, user, actorId)`: комната для зрителя.
/// Ведущему — состояние целиком плюс вычисленные карточки; игроку — строгая
/// проекция, которая собирается из разрешённого. `None` — `undefined`.
pub fn campaign_state_for_viewer(state: Option<&Value>, user: Option<&Value>, actor_id: Option<&Value>) -> ProjectionResult<Option<Value>> {
    let Some(state) = state else { return Ok(None) };
    if !objectish(Some(state)) {
        return Ok(Some(state.clone()));
    }
    let actor = actor_arg(actor_id);
    if is_admin(user) {
        return admin_room(state, &actor).map(Some);
    }
    player_room(state, user, &actor).map(Some)
}

/// Ветка игрока `campaignStateForViewer`.
fn player_room(raw_state: &Value, user: Option<&Value>, actor: &Value) -> R<Value> {
    let actor_s = js::s(Some(actor));
    let quest_state = sk_society::quest_consequences::quest_state_for_viewer(raw_state, &viewer_for(Some(raw_state), user, actor));
    let state = &quest_state;
    let source = Some(state);
    let viewer = viewer_for(source, user, actor);
    // `{ locationMaps, scene, worldMemory, social, ...projectable }`: копируются
    // только оставшиеся поля — карты и сцена (большая часть состояния) не
    // копируются ради того, чтобы тут же их выбросить (Ск2).
    const SET_ASIDE: [&str; 4] = ["locationMaps", "scene", "worldMemory", "social"];
    let projectable: Map<String, Value> = match source {
        Some(Value::Object(map)) => map.iter().filter(|(key, _)| !SET_ASIDE.contains(&key.as_str())).map(|(key, value)| (key.clone(), value.clone())).collect(),
        other => {
            let mut projectable = spread_any(other);
            for key in SET_ASIDE {
                projectable.shift_remove(key);
            }
            projectable
        }
    };
    let visible = match project(&Value::Object(projectable), &viewer) {
        Some(value @ Value::Object(_)) => value,
        Some(Value::Null) | None => Value::Object(Map::new()),
        Some(other) => other,
    };
    let visible_ref = Some(&visible);
    let mut public_state = spread_any(visible_ref);
    for key in [
        "locationMaps",
        "npc_world",
        "world_offices",
        "levelEntities",
        "world_deeds",
        "law",
        "loot_containers",
        "tavern",
        "blessings",
        "courier_letters",
        "scenario_attention",
        "scenario_knight",
        "dialogues",
    ] {
        public_state.shift_remove(key);
    }
    // Белый список: ключ состояния без решения в `PROJECTED_STATE_KEYS`
    // (например `locationLevels` — этажи всех локаций) игроку не уходит.
    public_state.retain(|key, _| PROJECTED_STATE_KEYS.contains(&key.as_str()));
    let raw_scene = get(source, "scene");
    let current_location = js::s(coalesce(coalesce(get(raw_scene, "location_id"), get(raw_scene, "locationId")), get(get(source, "worldMap"), "currentLocationId")));
    let scene = public_scene_for(raw_scene, get(get(source, "locationLevels"), &current_location))?;
    let merchants: Vec<Value> = arr(get(visible_ref, "merchants"))
        .iter()
        .filter(|merchant| sk_economy::merchant_economy::merchant_trade_availability_for(state, Some(merchant), false).can_trade)
        .map(sk_economy::merchant_economy::public_merchant_for)
        .collect();
    let mut enemies = Vec::new();
    for enemy in arr(get(visible_ref, "enemies")) {
        enemies.push(public_enemy_for(Some(enemy), source, Some(actor))?);
    }
    let mut actors = Vec::new();
    for entry in arr(get(visible_ref, "actors")) {
        if entry.is_null() {
            return Err(ProjectionError::type_error("Cannot destructure 'actor' as it is null."));
        }
        actors.push(public_actor_with_footprint(entry, false));
    }
    let scene_npcs = sk_npc_world::npc_positioning::scene_npcs_for_viewer(state);
    let public_players = public_state.get("players").cloned();
    let visible_ids: IndexSet<String> = arr(public_players.as_ref())
        .iter()
        .chain(enemies.iter())
        .chain(actors.iter())
        .chain(scene_npcs.iter())
        .map(|entry| text_of(get(Some(entry), "id"), 120))
        .filter(|id| !id.is_empty())
        .collect();
    let cell_keys = revealed_keys_from_cells(scene.get("cells"));
    let enemy_set = enemy_ids(source)?;
    let mut social_ids: IndexSet<String> = IndexSet::new();
    for npc in list_or_empty(get(get(source, "social"), "npcs"), "state.social.npcs")? {
        social_ids.insert(actor_key(npc)?);
    }
    let raw_mechanics = get(visible_ref, "mechanics");
    let mechanics = if objectish(raw_mechanics) {
        Some(player_mechanics(state, raw_mechanics, actor, &public_players, &actors, &enemy_set, &visible_ids, &cell_keys, &social_ids)?)
    } else {
        raw_mechanics.cloned()
    };
    let mut room = public_state;
    room.insert("players".into(), Value::Array(player_items_with_capabilities(public_players.as_ref(), &actor_s, &js::s(get(source, "ruleset_id")), source)?));
    room.insert("actors".into(), Value::Array(actors));
    room.insert("scene".into(), scene);
    room.insert("adventure".into(), public_adventure_for(get(visible_ref, "adventure"))?);
    room.insert("worldMap".into(), public_world_map_for(coalesce(get(visible_ref, "worldMap"), get(source, "worldMap")))?);
    let viewer_card = json!({ "playerId": actor_s, "isAdmin": false, "isPartyMember": true });
    room.insert("worldMemory".into(), sk_memory::world_memory::world_memory_for_viewer(get(source, "worldMemory").unwrap_or(&Value::Null), &viewer_card));
    let mut social_viewer = viewer_card.clone();
    if let Some(object) = social_viewer.as_object_mut() {
        object.insert("state".into(), state.clone());
    }
    room.insert("social".into(), sk_social::npc_social::npc_social_for_viewer(get(source, "social").unwrap_or(&Value::Null), &social_viewer));
    room.insert("scene_npcs".into(), Value::Array(scene_npcs));
    if js::truthy(get(source, "world_offices")) {
        let offices = sk_world_life::world_offices::offices_for_viewer(source, &json!({ "isPartyMember": true, "playerId": actor_s }));
        room.insert("world_offices".into(), Value::Array(offices));
    }
    room.insert("captives".into(), sk_world_life::captives::captives_for_viewer(state, &json!({ "isAdmin": false })));
    room.insert("loot_containers".into(), sk_director::loot_containers::loot_containers_for_viewer(state, Some(&Value::String(actor_s.clone())), Some(&Value::Bool(false)))?);
    room.insert("beasts".into(), sk_npc_world::beast_taming::beasts_for_viewer(state, &json!({ "isAdmin": false })));
    room.insert("law".into(), sk_society::law_and_order::law_for_viewer(state, &json!({ "isAdmin": false })));
    insert_viewer_cards(&mut room, state, &actor_s)?;
    let steps = sk_world_story::offscreen_world::offscreen_world_feed(state, Some(&json!(20)));
    room.insert("offscreen_world".into(), json!({ "schema_version": sk_world_story::offscreen_world::OFFSCREEN_WORLD_SCHEMA_VERSION, "steps": steps }));
    room.insert("courier_letters".into(), sk_world_life::courier_letters::courier_letters_for_viewer(state, &json!({ "isAdmin": false })));
    room.insert("weather".into(), sk_world_time::weather::weather_for_viewer(state, Some(actor)));
    room.insert("weather_by_actor".into(), weather_by_actor_for(state, false, &actor_s));
    room.insert("merchants".into(), Value::Array(merchants));
    room.insert("enemies".into(), Value::Array(enemies));
    match mechanics {
        Some(mechanics) => {
            room.insert("mechanics".into(), mechanics);
        }
        None => {
            room.shift_remove("mechanics");
        }
    }
    let visibility = Visibility { actor_ids: &visible_ids, cell_keys: &cell_keys, enemy_ids: &enemy_set, social_npc_ids: &visible_social_ids(source, &visible_ids)? };
    let battle_log: Vec<Value> =
        arr(get(visible_ref, "battleLog")).iter().filter_map(|entry| public_battle_event_for(entry, source, actor, &visibility)).filter(|entry| js::truthy(Some(entry))).collect();
    room.insert("battleLog".into(), Value::Array(battle_log));
    room.insert("messages".into(), Value::Array(arr(get(visible_ref, "messages")).iter().map(public_combat_message_for).collect()));
    if let Some(autonomy) = public_autonomy_for(get(source, "autonomy")) {
        room.insert("autonomy".into(), autonomy);
    }
    let room_value = Value::Object(room);
    let appearances = actor_appearances_for_viewer(Some(&room_value));
    let hints = suggested(&room_value, actor)?;
    let Value::Object(mut room) = room_value else { return Ok(room_value) };
    room.insert("actor_appearances".into(), appearances);
    room.insert("suggested_actions".into(), hints);
    Ok(Value::Object(room))
}

/// Видимые социальные NPC журнала боя (`visibleSocialNpcIds`).
fn visible_social_ids(state: Option<&Value>, visible: &IndexSet<String>) -> R<IndexSet<String>> {
    Ok(list_or_empty(get(get(state, "social"), "npcs"), "state.social.npcs")?
        .iter()
        .map(|npc| text_of(get(Some(npc), "id"), 120))
        .filter(|id| !id.is_empty() && visible.contains(id))
        .collect())
}

/// `mechanics` комнаты игрока.
#[allow(clippy::too_many_arguments)] // повторяет замыкание JS над локальными переменными проекции
fn player_mechanics(
    state: &Value,
    mechanics: Option<&Value>,
    actor: &Value,
    public_players: &Option<Value>,
    actors: &[Value],
    enemies: &IndexSet<String>,
    visible: &IndexSet<String>,
    cells: &IndexSet<String>,
    social_ids: &IndexSet<String>,
) -> R<Value> {
    let source = Some(state);
    let mut out = spread_any(mechanics);
    for key in ["enemy_knowledge", "active_effects", "concentration", "reaction_preferences"] {
        out.shift_remove(key);
    }
    let preferences = get(get(mechanics, "reaction_preferences"), &js::string(Some(actor)));
    if js::truthy(Some(actor)) && js::truthy(preferences) {
        let mut own = Map::new();
        own.insert(js::string(Some(actor)), preferences.cloned().unwrap_or(Value::Null));
        out.insert("reaction_preferences".into(), Value::Object(own));
    }
    if out.contains_key("resources") {
        let resources = public_resources_for(state, out.get("resources"))?;
        out.insert("resources".into(), resources);
    }
    let mut movement = Map::new();
    let players = match public_players {
        None | Some(Value::Null) => &[][..],
        Some(Value::Array(items)) => items.as_slice(),
        Some(_) => return Err(ProjectionError::type_error("publicState.players is not iterable")),
    };
    for entry in players.iter().chain(actors.iter()) {
        let id = actor_key(entry)?;
        if enemies.contains(&id) {
            continue;
        }
        movement.insert(id.clone(), sk_rules::geometry::movement::movement_for_actor(state, &id));
    }
    out.insert("movement".into(), Value::Object(movement));
    if js::truthy(get(mechanics, "conditions")) {
        out.insert("conditions".into(), public_conditions_for(get(mechanics, "conditions"), enemies, visible));
    }
    if plain(mechanics).is_some_and(|map| map.contains_key("active_effects")) {
        out.insert("active_effects".into(), public_active_effects_for(state, get(mechanics, "active_effects"), cells, visible));
    }
    if plain(mechanics).is_some_and(|map| map.contains_key("concentration")) {
        out.insert("concentration".into(), public_concentration_for(get(mechanics, "concentration"), enemies, visible, get(get(source, "mechanics"), "active_effects")));
    }
    if js::truthy(get(mechanics, "temporary_hp")) {
        let filtered: Map<String, Value> = entries_any(get(mechanics, "temporary_hp")).into_iter().filter(|(id, _)| !social_ids.contains(id)).collect();
        out.insert("temporary_hp".into(), public_actor_keyed_map_for(Some(&Value::Object(filtered)), enemies, |id| exact_enemy_health_known(source, id, actor)));
    }
    if js::truthy(get(mechanics, "defenses")) {
        out.insert(
            "defenses".into(),
            public_actor_keyed_map_for(get(mechanics, "defenses"), enemies, |id| exact_enemy_fact(enemy_knowledge_for(source, id, actor), "stat_block")),
        );
    }
    let mut dice = Map::new();
    if js::truthy(Some(actor)) {
        let pool = sk_rules::rest::hit_point_dice_pool_for_actor(state, &js::s(Some(actor))).map_or(Value::Null, sk_rules::rest::HitPointDicePool::to_value);
        dice.insert(js::string(Some(actor)), pool);
    }
    out.insert("hit_point_dice".into(), Value::Object(dice));
    out.insert("encounter".into(), public_encounter_for(get(mechanics, "encounter")).unwrap_or(Value::Null));
    let combat = get(mechanics, "combat");
    if objectish(combat) {
        let mut public_combat = spread_any(combat);
        public_combat.shift_remove("combat_instance_id");
        let empty = Value::Object(Map::new());
        let economy_source = coalesce(get(combat, "action_economy"), Some(&empty));
        let mut economy_out = Map::new();
        for (id, economy) in entries_any(economy_source) {
            let mut public_economy = spread_any(Some(&economy));
            for key in ["loading_weapon_item_ids", "loadingWeaponItemIds", "attack_action_id", "attack_action_stack"] {
                public_economy.shift_remove(key);
            }
            if let Some(Value::Array(stack)) = get(Some(&economy), "attack_action_stack") {
                let frames: Vec<Value> = stack
                    .iter()
                    .map(|frame| {
                        let mut safe = spread_any(Some(frame));
                        for key in ["id", "loading_weapon_item_ids", "loadingWeaponItemIds"] {
                            safe.shift_remove(key);
                        }
                        Value::Object(safe)
                    })
                    .collect();
                public_economy.insert("attack_action_stack".into(), Value::Array(frames));
            }
            economy_out.insert(id, Value::Object(public_economy));
        }
        public_combat.insert("action_economy".into(), Value::Object(economy_out));
        public_combat.insert("initiative".into(), public_initiative_for(get(combat, "initiative"), source)?);
        public_combat.insert("reaction_window".into(), public_reaction_window_for(get(combat, "reaction_window"), source, actor)?);
        out.insert("combat".into(), Value::Object(public_combat));
    }
    Ok(Value::Object(out))
}

// --- события --------------------------------------------------------------------------

/// Видимые зрителю существа сцены (`projectVisibleState([...players, ...actors, ...enemies])` и фишки NPC).
fn visible_actor_ids(state: &Value, viewer: &Value) -> R<IndexSet<String>> {
    let all: Vec<Value> = actor_list(Some(state), &["players", "actors", "enemies"])?.into_iter().cloned().collect();
    let projected = match project(&Value::Array(all), viewer) {
        Some(Value::Array(items)) => items,
        _ => Vec::new(),
    };
    let npcs = sk_npc_world::npc_positioning::scene_npcs_for_viewer(state);
    let mut ids = IndexSet::new();
    for entry in projected.iter().chain(npcs.iter()) {
        ids.insert(actor_key(entry)?);
    }
    Ok(ids)
}

fn filter_target_ids(visible: &mut Map<String, Value>, ids: &IndexSet<String>) {
    if let Some(Value::Array(targets)) = visible.get("target_ids") {
        let kept: Vec<Value> = targets.iter().filter(|id| ids.contains(&js::string(Some(id)))).cloned().collect();
        visible.insert("target_ids".into(), Value::Array(kept));
    }
}

fn remove_keys(map: &mut Map<String, Value>, keys: &[&str]) {
    for key in keys {
        map.shift_remove(*key);
    }
}

/// `eventForViewer(event, user, actorId, state)`: `None` — событие зрителю не видно.
fn event_for_viewer(event: &Value, user: Option<&Value>, actor: &Value, state: &Value) -> R<Option<Value>> {
    if event.is_null() {
        return Err(ProjectionError::null_read("payload"));
    }
    if state.is_null() {
        return Err(ProjectionError::null_read("worldMemory"));
    }
    let source = Some(state);
    let viewer = viewer_for(source, user, actor);
    let empty = Value::Object(Map::new());
    let memory = state.get("worldMemory").unwrap_or(&empty);
    if !sk_society::quest_consequences::knowledge_gate_visible(get(get(Some(event), "payload"), "knowledge_gate"), memory, &viewer) {
        return Ok(None);
    }
    let Some(projected) = project(event, &viewer).filter(|value| js::truthy(Some(value))) else { return Ok(None) };
    let mut visible = spread_any(Some(&projected));
    let mut payload = plain(visible.get("payload")).cloned().unwrap_or_default();
    remove_keys(&mut payload, &["knowledge_gate", "previous_view", "proof_fact_ids", "proof_source_event_ids"]);
    if let Some(Value::Object(quest)) = payload.get("quest") {
        let mut quest = quest.clone();
        remove_keys(&mut quest, &["progress_fact_ids", "progress_source_event_ids"]);
        payload.insert("quest".into(), Value::Object(quest));
    }
    remove_keys(
        &mut payload,
        &[
            "action_economy_version",
            "attack_action_resource",
            "attack_action_id",
            "attack_action_boundary",
            "attack_action_kind",
            "attack_action_limit",
            "attack_action_spends_action",
            "attack_action_extra_kind",
            "action_boundary_id",
            "action_boundary_kind",
            "action_boundary_limit",
            "action_boundary_queued",
        ],
    );
    let event_type = visible.get("event_type").cloned();
    let is_type = |name: &str| is_str(event_type.as_ref(), name);
    let type_string = js::string(event_type.as_ref());
    if is_type("SpellAreaCreated") && objectish(payload.get("effect")) {
        let ids = visible_actor_ids(state, &viewer)?;
        let cells = scene_revealed_keys(get(source, "scene"))?;
        let scene = Scene::new(state);
        let effect = payload.get("effect").cloned().unwrap_or(Value::Null);
        let Some(public_effect) = public_active_effect_for(&scene, &effect, &cells, &ids) else { return Ok(None) };
        payload.clear();
        payload.insert("effect".into(), public_effect);
        if !ids.contains(&js::string(visible.get("actor_id"))) {
            visible.shift_remove("actor_id");
        }
        filter_target_ids(&mut visible, &ids);
    }
    if (is_type("LegendaryActionUsed") || is_type("CombatActionUsed")) && objectish(payload.get("area")) {
        let ids = visible_actor_ids(state, &viewer)?;
        let cells = scene_revealed_keys(get(source, "scene"))?;
        let area = payload.get("area").cloned();
        let area = area.as_ref();
        let from = public_point(get(area, "from"));
        let to = public_point(get(area, "to"));
        match (from, to) {
            (Some(from), Some(to)) if ids.contains(&js::string(visible.get("actor_id"))) && cells.contains(&from.key()) && cells.contains(&to.key()) => {
                let shape = get(area, "shape");
                let shape = if is_str(shape, "sphere") || is_str(shape, "cone") || is_str(shape, "line") { shape.cloned().unwrap_or(Value::Null) } else { Value::String("sphere".into()) };
                let mut public_area = Map::new();
                public_area.insert("shape".into(), shape);
                public_area.insert("from".into(), from.to_value());
                public_area.insert("to".into(), to.to_value());
                public_area.insert("size_feet".into(), Value::from(integer(get(area, "size_feet"), 5).max(5)));
                if js::truthy(get(area, "damage_type")) {
                    public_area.insert("damage_type".into(), text_value(get(area, "damage_type"), 40));
                }
                let targets: Vec<Value> = arr(get(area, "target_ids")).iter().map(|id| js::string(Some(id))).filter(|id| ids.contains(id)).map(Value::String).collect();
                public_area.insert("target_ids".into(), Value::Array(targets));
                payload.insert("area".into(), Value::Object(public_area));
            }
            _ => {
                payload.shift_remove("area");
            }
        }
    }
    if is_type("SpellAreaRemoved") {
        let ids = visible_actor_ids(state, &viewer)?;
        let original = text_of(payload.get("effect_id"), 180);
        payload.clear();
        if !original.is_empty() {
            payload.insert("effect_id".into(), Value::String(public_area_id(Some(&Value::String(original)))));
        }
        if !ids.contains(&js::string(visible.get("actor_id"))) {
            visible.shift_remove("actor_id");
        }
        filter_target_ids(&mut visible, &ids);
    }
    let spell_id = payload.get("spell_id");
    if is_str(spell_id, "longstrider") || is_str(spell_id, "mass-cure-wounds") || is_str(spell_id, "true-strike") || is_str(payload.get("condition"), "longstrider") {
        let ids = visible_actor_ids(state, &viewer)?;
        let candidates: Vec<Value> = match visible.get("target_ids") {
            Some(Value::Array(targets)) => targets.clone(),
            _ => vec![payload.get("target_id").cloned().unwrap_or(Value::Null)],
        };
        let target_was_undefined = !matches!(visible.get("target_ids"), Some(Value::Array(_))) && !payload.contains_key("target_id");
        let targets: Vec<Value> = candidates
            .into_iter()
            .filter(|id| if target_was_undefined { ids.contains("undefined") } else { ids.contains(&js::string(Some(id))) })
            .collect();
        let actor_visible = ids.contains(&js::string(visible.get("actor_id")));
        if targets.is_empty() && (!is_type("SpellCast") || !actor_visible) {
            return Ok(None);
        }
        visible.insert("target_ids".into(), Value::Array(targets));
        if !actor_visible {
            visible.shift_remove("actor_id");
        }
        if !ids.contains(&js::string(payload.get("source_actor"))) {
            payload.shift_remove("source_actor");
        }
        if !ids.contains(&js::string(payload.get("target_id"))) {
            payload.shift_remove("target_id");
        }
        let true_strike = matches!(payload.get("true_strike_version"), Some(Value::Number(number)) if number.as_f64() == Some(1.0));
        if true_strike && !ids.contains(&js::string(payload.get("target_actor_id"))) {
            payload.shift_remove("target_actor_id");
        }
        if is_str(payload.get("spell_id"), "longstrider") || is_str(payload.get("condition"), "longstrider") {
            remove_keys(&mut payload, &["from", "to", "origin", "center"]);
        }
    }
    if is_type("HealingApplied") {
        if let Some(Value::Array(targets)) = visible.get("target_ids") {
            let mut social_target = false;
            for target in targets {
                let npcs = list_or_empty(get(get(source, "social"), "npcs"), "state.social.npcs")?;
                if npcs.iter().any(|npc| js::s(get(Some(npc), "id")) == js::string(Some(target))) {
                    social_target = true;
                    break;
                }
            }
            if social_target {
                remove_keys(
                    &mut payload,
                    &["hp", "max_hp", "hp_before", "hp_after", "maximum_hp", "maximum_hp_before", "maximum_hp_after", "raw_amount", "requested_amount", "amount", "rolled_amount"],
                );
            }
        }
    }
    if is_type("SpellCast") {
        let cells = scene_revealed_keys(get(source, "scene"))?;
        redact_spell_visual_payload(&mut payload, &cells);
    }
    if is_type("CampaignStoryCompleted") {
        let quest_state = sk_society::quest_consequences::quest_state_for_viewer(state, &viewer);
        let history = get(get(Some(&quest_state), "campaignConcept"), "story_history");
        let stories = match history {
            None | Some(Value::Null) => &[][..],
            Some(Value::Array(items)) => items.as_slice(),
            Some(_) => return Err(ProjectionError::not_function("story_history", "find")),
        };
        let mut known = None;
        for story in stories {
            if story.is_null() {
                return Err(ProjectionError::null_read("story_id"));
            }
            if strict_eq(get(Some(story), "story_id"), payload.get("story_id")) {
                known = Some(story);
                break;
            }
        }
        if let Some(story) = known.filter(|story| js::truthy(Some(story))) {
            match get(Some(story), "story_number") {
                Some(number) => {
                    payload.insert("story_number".into(), number.clone());
                }
                None => {
                    payload.shift_remove("story_number");
                }
            }
        }
    }
    if payload.contains_key("attack_visual") {
        match sk_scene_base::actor_appearance::normalize_attack_visual(payload.get("attack_visual")) {
            Some(visual) => {
                payload.insert("attack_visual".into(), visual);
            }
            None => {
                payload.shift_remove("attack_visual");
            }
        }
    }
    if is_type("LocationMapImported") {
        let levels: Vec<Value> = arr(payload.get("levels"))
            .iter()
            .map(|level| {
                let index = js::number(get(Some(level), "index"));
                let index = if index.is_nan() || index == 0.0 { 0.0 } else { index };
                json!({ "index": js::num(index), "label": head16(&js::s(get(Some(level), "label")), 120) })
            })
            .collect();
        remove_keys(&mut payload, &["levels", "warnings", "stats", "source", "relocations", "party_positions"]);
        payload.insert("levels".into(), Value::Array(levels));
    }
    if is_type("SceneAdvanced") {
        payload.shift_remove("library_levels");
        let scene = public_scene_for(payload.get("scene"), None)?;
        payload.insert("scene".into(), scene);
        let adventure = public_adventure_for(payload.get("adventure"))?;
        payload.insert("adventure".into(), adventure);
        let world_map = public_world_map_for(payload.get("worldMap"))?;
        payload.insert("worldMap".into(), world_map);
    }
    if is_type("MapLevelChanged") && js::truthy(payload.get("map")) {
        match project_public_tactical_map(payload.get("map"))? {
            Some(projected) => {
                payload.insert("map".into(), projected.map);
                payload.insert("map_hash".into(), Value::String(projected.hash));
            }
            None => {
                payload.shift_remove("map");
            }
        }
    }
    if is_type("DoorBarricaded") {
        payload.shift_remove("material_item_id");
    }
    if is_type("MerchantCreated") && js::truthy(payload.get("merchant")) {
        let merchant = sk_economy::merchant_economy::public_merchant_for(payload.get("merchant").unwrap_or(&Value::Null));
        payload.insert("merchant".into(), merchant);
    }
    if is_type("EncounterCreated") && js::truthy(payload.get("encounter")) {
        let encounter = payload.get("encounter").cloned();
        let mut public = spread_any(public_encounter_for(encounter.as_ref()).as_ref());
        let mut enemies = Vec::new();
        for enemy in arr(get(encounter.as_ref(), "enemies")) {
            enemies.push(public_enemy_for(Some(enemy), source, Some(actor))?);
        }
        public.insert("enemies".into(), Value::Array(enemies));
        payload.insert("encounter".into(), Value::Object(public));
    }
    if is_type("GuardEncounterStarted") {
        let encounter = sk_society::law_and_order::public_guard_encounter_for(payload.get("encounter")).unwrap_or(Value::Null);
        payload.insert("encounter".into(), encounter);
    }
    if is_type("GuardEncounterResolved") {
        payload.shift_remove("level");
    }
    if is_type("WantedCleared") {
        remove_keys(&mut payload, &["level_before", "crime_ids"]);
    }
    if is_type("WantedLevelRaised") {
        payload.shift_remove("crime");
    }
    if is_type("TavernDiceRoundOpened") && js::truthy(payload.get("round")) {
        match sk_npc_world::tavern_life::public_tavern_round_for(payload.get("round")) {
            Some(round) => {
                payload.insert("round".into(), round);
            }
            None => {
                payload.shift_remove("round");
            }
        }
    }
    if is_type("TavernDiceRoundResolved") || is_type("TavernDiceRoundCancelled") {
        remove_keys(&mut payload, &["npc_purse_before_cp", "npc_purse_after_cp", "house_cut_cp"]);
    }
    if is_type("CourierLetterSent") && js::truthy(payload.get("letter")) {
        match sk_world_life::courier_letters::courier_letter_for_viewer(payload.get("letter"), false) {
            Some(letter) => {
                payload.insert("letter".into(), letter);
            }
            None => {
                payload.shift_remove("letter");
            }
        }
    }
    if is_type("CourierLetterDelivered") && !is_admin(user) {
        payload.shift_remove("tone");
    }
    if is_type("EncounterOutcomeRecorded") {
        remove_keys(&mut payload, &["plan", "prepared_reward"]);
    }
    if is_type("EncounterCoinsRolled") {
        let rolls: Vec<Value> = arr(payload.get("rolls"))
            .iter()
            .map(|roll| {
                let roll = Some(roll);
                let dice: Vec<Value> = arr(get(roll, "dice")).iter().map(|value| Value::from(integer(Some(value), 0))).take(12).collect();
                json!({
                    "roll_id": text_of(get(roll, "roll_id"), 160), "expression": text_of(get(roll, "expression"), 40), "dice": dice,
                    "total": integer(get(roll, "total"), 0), "amount_cp": integer(get(roll, "amount_cp"), 0),
                })
            })
            .collect();
        payload.insert("rolls".into(), Value::Array(rolls));
    }
    if is_type("NpcItemUsed") {
        remove_keys(&mut payload, &["item_instance_id", "catalog_id", "item_name"]);
    }
    if is_type("NpcPocketPicked") {
        payload.shift_remove("purse_cp");
    }
    if is_type("MerchantDenouncedThief") {
        payload.shift_remove("wanted_level");
    }
    if is_type("NpcPlaced") {
        payload.shift_remove("vitality");
    }
    if is_type("OfficeVacated") || is_type("OfficeHolderInstalled") || is_type("OfficeSuccessionSkipped") {
        remove_keys(&mut payload, &["succession_id", "due_at_minutes", "reason", "source_event_id"]);
    }
    if is_type("NpcHarmed") {
        remove_keys(&mut payload, &["hp", "max_hp", "hp_before", "hp_after", "raw_amount", "temporary_hp_before", "temporary_hp_after", "temporary_hp_absorbed"]);
        if let Some(Value::Array(components)) = payload.get_mut("damage_components") {
            for component in components.iter_mut() {
                if let Value::Object(component) = component {
                    component.shift_remove("temporary_hp_absorbed");
                }
            }
        }
    }
    if is_type("NpcSavingThrowResolved") {
        remove_keys(&mut payload, &["modifier", "kept", "dice", "roll_id", "expression"]);
    }
    if is_type("NpcSocialProfileUpserted") && js::truthy(payload.get("npc")) {
        let viewer_card = json!({ "playerId": js::s(Some(actor)), "isAdmin": false, "isPartyMember": true, "state": state });
        let npc = sk_social::npc_social::npc_profile_for_viewer_at(payload.get("npc").unwrap_or(&Value::Null), &viewer_card);
        payload.insert("npc".into(), npc);
    }
    if is_type("CaptiveTaken") && js::truthy(payload.get("captive")) {
        match sk_world_life::captives::captive_for_viewer(payload.get("captive")) {
            Some(captive) => {
                payload.insert("captive".into(), captive);
            }
            None => {
                payload.shift_remove("captive");
            }
        }
    }
    if is_type("LootContainerCreated") && js::truthy(payload.get("container")) {
        let options = sk_director::loot_containers::ContainerViewOptions { with_contents: Some(&Value::Bool(false)), ..Default::default() };
        match sk_director::loot_containers::loot_container_for_viewer(payload.get("container").unwrap_or(&Value::Null), options) {
            Some(container) => {
                payload.insert("container".into(), container);
            }
            None => {
                payload.shift_remove("container");
            }
        }
    }
    if is_type("LootContainerTaken") {
        payload.shift_remove("remaining_items");
        let items: Vec<Value> = arr(payload.get("items"))
            .iter()
            .map(|item| {
                let item = Some(item);
                let weight = js::number(get(item, "weight"));
                let weight = if weight.is_nan() { 0.0 } else { weight };
                json!({
                    "id": text_of(get(item, "id"), 160), "catalog_id": text_of(get(item, "catalog_id"), 120), "name": text_of(get(item, "name"), 120),
                    "type": text_of(get(item, "type"), 40), "quantity": integer(get(item, "quantity"), 1), "weight": js::num(weight.max(0.0) + 0.0),
                })
            })
            .collect();
        payload.insert("items".into(), Value::Array(items));
    }
    if is_type("BeastEncountered") && js::truthy(payload.get("beast")) {
        match sk_npc_world::beast_taming::beast_for_viewer(payload.get("beast")) {
            Some(beast) => {
                payload.insert("beast".into(), beast);
            }
            None => {
                payload.shift_remove("beast");
            }
        }
    }
    let target_ids: Vec<String> = arr(visible.get("target_ids")).iter().map(|id| js::string(Some(id))).collect();
    let actor_string = js::string(Some(actor));
    if (type_string == "HitPointDieSpent" || type_string == "HitPointDiceRestored") && js::s(visible.get("actor_id")) != actor_string && !target_ids.contains(&actor_string) {
        remove_keys(&mut payload, &["pool_before", "pool_after", "restored"]);
    }
    let enemies = enemy_ids(source)?;
    let enemy_target_id = match target_ids.iter().find(|id| enemies.contains(*id)) {
        Some(id) => id.clone(),
        None if enemies.contains(&js::s(payload.get("target_id"))) => js::string(payload.get("target_id")),
        None => String::new(),
    };
    let enemy_actor = enemies.contains(&js::s(visible.get("actor_id")));
    if !enemy_target_id.is_empty() && !exact_enemy_health_known(source, &enemy_target_id, actor) {
        remove_keys(
            &mut payload,
            &[
                "hp",
                "max_hp",
                "hp_before",
                "hp_after",
                "maximum_hp",
                "maximum_hp_before",
                "maximum_hp_after",
                "temporary_hp_before",
                "temporary_hp_after",
                "temporary_hp_absorbed",
                "temporary_hp_amount",
                "offered",
                "raw_amount",
                "armor_class",
            ],
        );
        if let Some(Value::Array(rules)) = visible.get("source_rule_ids") {
            let kept: Vec<Value> = rules.iter().filter(|id| !js::string(Some(id)).ends_with(":combat:temporary-hit-points")).cloned().collect();
            visible.insert("source_rule_ids".into(), Value::Array(kept));
        }
        if type_string == "HealingApplied" {
            remove_keys(&mut payload, &["requested_amount", "applied_amount"]);
        }
    }
    if !enemy_target_id.is_empty() {
        remove_keys(&mut payload, &["item_resistance_sources", "item_immunity_sources", "critical_protection_sources"]);
    }
    if is_type("CombatStarted") {
        let initiative = public_initiative_for(payload.get("initiative"), source)?;
        payload.insert("initiative".into(), initiative);
    }
    if enemy_actor {
        remove_keys(
            &mut payload,
            &["modifier", "kept", "attack_bonus", "damage_expression", "damage_dice", "action_id", "dice", "expression", "item_id", "item_name", "catalog_id", "effect_id", "legendary_action_id"],
        );
    }
    if enemy_actor && ["SpellSavingThrowResolved", "SavingThrowResolved", "NpcSavingThrowResolved", "DamageApplied", "ConditionAdded"].contains(&type_string.as_str()) {
        remove_keys(&mut payload, &["difficulty", "save_dc"]);
    }
    if (type_string == "ConditionAdded" || type_string == "ConditionRemoved") && (enemy_actor || !enemy_target_id.is_empty()) {
        let condition = public_enemy_condition_id(payload.get("condition"));
        if ENEMY_BOOKKEEPING_CONDITIONS.contains(&condition.as_str()) {
            return Ok(None);
        }
        if js::present(payload.get("condition")) {
            payload.insert("condition".into(), Value::String(condition));
        }
        remove_keys(&mut payload, &ENEMY_CONDITION_PRIVATE_KEYS);
    }
    if !enemy_target_id.is_empty() && TARGET_ROLL_EVENT_TYPES.contains(&type_string.as_str()) {
        remove_keys(&mut payload, &["modifier", "kept", "dice", "roll_id", "expression"]);
    }
    if is_type("AbilityCheckResolved") && js::truthy(payload.get("social_check")) {
        payload.shift_remove("difficulty");
        let check = payload.get("social_check").cloned();
        let check = check.as_ref();
        let social = json!({
            "check_id": js::s(get(check, "check_id")),
            "npc_id": js::s(get(check, "npc_id")),
            "skill": js::s(coalesce(get(check, "skill"), payload.get("skill"))),
            "difficulty_hidden": true,
        });
        payload.insert("social_check".into(), social);
    }
    if is_type("ReactionWindowOpened") {
        let window = public_reaction_window_for(Some(&Value::Object(payload)), source, actor)?;
        visible.insert("payload".into(), window);
        return Ok(Some(Value::Object(visible)));
    }
    visible.insert("payload".into(), Value::Object(payload));
    Ok(Some(Value::Object(visible)))
}

/// `mechanicsForViewer(events, user, actorId, state)`: события глазами игрока;
/// ведущему и не-массиву — как есть. `state` `None` — `undefined` (как `{}`).
pub fn mechanics_for_viewer(events: Option<&Value>, user: Option<&Value>, actor_id: Option<&Value>, state: Option<&Value>) -> ProjectionResult<Option<Value>> {
    let Some(Value::Array(list)) = events else { return Ok(events.cloned()) };
    if is_admin(user) {
        return Ok(events.cloned());
    }
    let actor = actor_arg(actor_id);
    let empty = Value::Object(Map::new());
    let state = state.unwrap_or(&empty);
    let mut out = Vec::new();
    for event in list {
        if let Some(projected) = event_for_viewer(event, user, &actor, state)? {
            out.push(projected);
        }
    }
    Ok(Some(Value::Array(out)))
}

/// `rollVisibleFor(roll, user)`.
fn roll_visible_for(roll: &Value, user: Option<&Value>) -> bool {
    if is_admin(user) {
        return true;
    }
    if text::test(re!(r"^npc_(?:spell|area)_save:", "u"), &js::s(get(Some(roll), "purpose"))) {
        return false;
    }
    let visibility = match get(Some(roll), "visibility") {
        Some(value) if !value.is_null() => js::s(Some(value)),
        _ => "public".to_string(),
    };
    !["gm_only", "npc_private"].contains(&visibility.as_str())
}

/// `turnExplanationForViewer(explanation, user, actorId, state)`: разбор хода
/// (`/why`) без заготовок ведущего, бросков врага и закрытых событий.
pub fn turn_explanation_for_viewer(explanation: Option<&Value>, user: Option<&Value>, actor_id: Option<&Value>, state: Option<&Value>) -> ProjectionResult<Option<Value>> {
    let Some(source) = explanation.filter(|value| objectish(Some(value))) else { return Ok(explanation.cloned()) };
    if is_admin(user) {
        return Ok(Some(source.clone()));
    }
    let empty = Value::Object(Map::new());
    let state_value = state.unwrap_or(&empty);
    let enemies = enemy_ids(Some(state_value))?;
    let mut out = spread_any(Some(source));
    let commands: Vec<Value> = arr(get(Some(source), "commands"))
        .iter()
        .map(|raw| {
            let scene_args = get(Some(raw), "scene_args");
            let command = match scene_args {
                Some(Value::Object(args)) if args.contains_key("secrets") => {
                    let mut copy = spread_any(Some(raw));
                    let filtered: Map<String, Value> = js::entries(args).into_iter().filter(|(key, _)| key.as_str() != "secrets").map(|(key, value)| (key.clone(), value.clone())).collect();
                    copy.insert("scene_args".into(), Value::Object(filtered));
                    Value::Object(copy)
                }
                _ => raw.clone(),
            };
            let command_ref = Some(&command);
            if !enemies.contains(&js::s(get(command_ref, "actor_id"))) {
                return command;
            }
            let mut public = Map::new();
            public.insert("type".into(), text_value(coalesce(get(command_ref, "type"), get(command_ref, "command_type")), 80));
            public.insert("actor_id".into(), text_value(get(command_ref, "actor_id"), 120));
            if js::present(get(command_ref, "target_id")) {
                public.insert("target_id".into(), text_value(get(command_ref, "target_id"), 120));
            }
            Value::Object(public)
        })
        .collect();
    out.insert("commands".into(), Value::Array(commands));
    let rolls: Vec<Value> = arr(get(Some(source), "rolls"))
        .iter()
        .filter(|roll| roll_visible_for(roll, user))
        .map(|roll| {
            let roll_ref = Some(roll);
            if !enemies.contains(&js::s(coalesce(get(roll_ref, "actor_id"), get(roll_ref, "actorId")))) {
                return roll.clone();
            }
            json!({
                "roll_id": text_of(coalesce(get(roll_ref, "roll_id"), get(roll_ref, "id")), 160),
                "purpose": text_of(get(roll_ref, "purpose"), 80),
                "total": integer(get(roll_ref, "total"), 0),
                "visibility": text_of(get(roll_ref, "visibility"), 40),
            })
        })
        .collect();
    out.insert("rolls".into(), Value::Array(rolls));
    match mechanics_for_viewer(get(Some(source), "events"), user, actor_id, Some(state_value))? {
        Some(events) => {
            out.insert("events".into(), events);
        }
        None => {
            out.shift_remove("events");
        }
    }
    Ok(Some(Value::Object(out)))
}

/// `sceneTransitionForViewer(transition)`: переход сцены глазами игрока.
pub fn scene_transition_for_viewer(transition: Option<&Value>) -> ProjectionResult<Option<Value>> {
    let Some(source @ Value::Object(_)) = transition else { return Ok(transition.cloned()) };
    let source = Some(source);
    let entrance = get(source, "entrance");
    Ok(Some(json!({
        "scene": public_scene_for(get(source, "scene"), None)?,
        "adventure": public_adventure_for(get(source, "adventure"))?,
        "worldMap": public_world_map_for(get(source, "worldMap"))?,
        "transition": text_of(get(source, "transition"), 2_000),
        "arrival": text_of(get(source, "arrival"), 2_000),
        "entrance": { "x": integer(get(entrance, "x"), 0), "y": integer(get(entrance, "y"), 0) },
    })))
}

/// `turnResultForViewer(result, user, actorId)`: все публичные поверхности
/// итога команды или повествования одинаково — комната, события, броски,
/// переход сцены.
pub fn turn_result_for_viewer(result: Option<&Value>, user: Option<&Value>, actor_id: Option<&Value>) -> ProjectionResult<Option<Value>> {
    let Some(source) = result.filter(|value| objectish(Some(value))) else { return Ok(result.cloned()) };
    let source_ref = Some(source);
    let authoritative = get(source_ref, "authoritative_state");
    // `authoritative_state` в выводе всегда заменяет своя проекция (для
    // `Some(state)` `campaign_state_for_viewer` всегда `Some`), поэтому
    // само полное состояние не копируется и не обходится проекцией: на его
    // месте — пустая заглушка того же вида, а остаётся ли ключ в проекции,
    // решает `survives_projection` по полям самой записи (Ск2).
    let replaced = js::truthy(authoritative) && authoritative.is_some_and(Value::is_object);
    if is_admin(user) {
        let mut out: Map<String, Value> = match source {
            Value::Object(map) if replaced => map.iter().map(|(key, value)| (key.clone(), if key == "authoritative_state" { Value::Null } else { value.clone() })).collect(),
            _ => spread_any(source_ref),
        };
        if js::truthy(authoritative) {
            if let Some(state) = campaign_state_for_viewer(authoritative, user, actor_id)? {
                out.insert("authoritative_state".into(), state);
            }
        }
        return Ok(Some(Value::Object(out)));
    }
    let actor = actor_arg(actor_id);
    let viewer = viewer_for(authoritative, user, &actor);
    let stubbed = match (source, authoritative) {
        (Value::Object(map), Some(state)) if replaced => {
            let keep = sk_tactics::security::survives_projection(state, Some(&viewer), Some(&for_narrator()));
            Some(Value::Object(
                map.iter()
                    .filter(|(key, _)| keep || key.as_str() != "authoritative_state")
                    .map(|(key, value)| (key.clone(), if key == "authoritative_state" { Value::Object(Map::new()) } else { value.clone() }))
                    .collect(),
            ))
        }
        _ => None,
    };
    let visible = match project(stubbed.as_ref().unwrap_or(source), &viewer) {
        Some(value) if !value.is_null() => value,
        _ => Value::Object(Map::new()),
    };
    let mut public_result = spread_any(Some(&visible));
    public_result.shift_remove("locationMaps");
    let mut effects = match get(Some(&visible), "effects") {
        Some(Value::Object(map)) => Some(Value::Object(map.clone())),
        other => other.cloned(),
    };
    if let Some(Value::Object(map)) = effects.as_mut() {
        if js::truthy(map.get("scene")) {
            let scene = scene_transition_for_viewer(map.get("scene"))?.unwrap_or(Value::Null);
            map.insert("scene".into(), scene);
        }
    }
    let enemies = enemy_ids(authoritative)?;
    if let Some(Value::Object(map)) = effects.as_mut() {
        if let Some(roll) = map.get("roll").filter(|roll| js::truthy(Some(roll))).cloned() {
            if !roll_visible_for(&roll, user) {
                map.shift_remove("roll");
            } else if enemies.contains(&js::s(get(Some(&roll), "actor_id"))) {
                let roll_ref = Some(&roll);
                let mut public = Map::new();
                public.insert("roll_id".into(), text_value(get(roll_ref, "roll_id"), 160));
                public.insert("actor_id".into(), text_value(get(roll_ref, "actor_id"), 120));
                public.insert("total".into(), Value::from(integer(get(roll_ref, "total"), 0)));
                public.insert("label".into(), text_value(get(roll_ref, "label"), 120));
                if let Some(Value::Bool(success)) = get(roll_ref, "success") {
                    public.insert("success".into(), Value::Bool(*success));
                }
                map.insert("roll".into(), Value::Object(public));
            }
        }
    }
    let mut out = public_result;
    match effects {
        Some(effects) => {
            out.insert("effects".into(), effects);
        }
        None => {
            out.shift_remove("effects");
        }
    }
    // События — проекцией каждого события; не массив — только тем, что
    // оставила общая проекция результата, а не сырым `result.mechanics`.
    let mechanics = match get(source_ref, "mechanics") {
        events @ Some(Value::Array(_)) => mechanics_for_viewer(events, user, Some(&actor), authoritative)?,
        _ => get(Some(&visible), "mechanics").cloned(),
    };
    match mechanics {
        Some(mechanics) => {
            out.insert("mechanics".into(), mechanics);
        }
        None => {
            out.shift_remove("mechanics");
        }
    }
    // Броски — из уже спроецированного результата: закрытые корзины внутри
    // броска вырезает общая проекция.
    if let Some(Value::Array(rolls)) = get(Some(&visible), "rolls") {
        out.insert("rolls".into(), Value::Array(rolls.iter().filter(|roll| roll_visible_for(roll, user)).cloned().collect()));
    }
    if let Some(changes @ Value::Array(_)) = get(Some(&visible), "visible_state_changes") {
        if let Some(projected) = mechanics_for_viewer(Some(changes), user, Some(&actor), authoritative)? {
            out.insert("visible_state_changes".into(), projected);
        }
    }
    if js::truthy(authoritative) {
        if let Some(state) = campaign_state_for_viewer(authoritative, user, Some(&actor))? {
            out.insert("authoritative_state".into(), state);
        }
    }
    Ok(Some(Value::Object(out)))
}

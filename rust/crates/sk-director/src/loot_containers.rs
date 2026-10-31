//! Перенос `server/loot-containers.mjs`: контейнеры добычи — куда девается
//! вещь, когда её хозяин выбыл (AGENTS.md §4, «Жизнь вещи»).
//!
//! Четыре решения модуля JS переносятся как есть:
//!
//! 1. контейнер рождается в той же фиксации, что и выбытие:
//!    [`plan_loot_container_drafts`] собирает черновики `LootContainerCreated`
//!    из пары состояний «до/после» и событий этой же фиксации;
//! 2. остаток переезжает, а не пересобирается: в контейнер ложатся те же
//!    экземпляры, и из инвентаря владельца они убираются
//!    ([`apply_loot_container_event`]);
//! 3. клиент не называет вещь: команда `LootContainer` несёт только ключи
//!    ([`validate_loot_container_command`] держит закрытый список полей);
//! 4. набор берётся целиком или никак: любой отказ отменяет всю команду.
//!
//! Смотреть содержимое можно только вблизи — пять футов
//! ([`LOOT_CONTAINER_REACH_FEET`], [`loot_containers_for_viewer`]).
//!
//! Где JS бросает `TypeError` на мусоре старых сохранений (чтение поля у
//! `null`, `.map` у строки), Rust возвращает [`LootContainerError`] с именем
//! `TypeError`; текст — описание для людей, не текст V8.

use std::collections::{HashMap, HashSet};
use std::fmt;

use serde_json::{json, Map, Value};
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::{hash, js, text as jstext};
use sk_economy::item_instances::{item_instance_snapshot, normalize_item_instance, ITEM_INSTANCE_SCHEMA_VERSION, MAX_ITEM_INSTANCE_QUANTITY};
use sk_economy::merchant_economy::{inventory_stack_key, normalize_inventory_item, resolve_catalog_base_price_cp, InventoryItemOptions, MAX_STOCK_QUANTITY};
use sk_geometry::actor_footprint::{footprint_distance_feet, normalize_footprint_metadata};
use sk_items::item_catalog::{catalog_item_truthy, ITEM_ORIGIN_KINDS};
use sk_items_life::item_lifecycle::{carrying_capacity, inventory_weight};
use sk_social::npc_social::campaign_elapsed_minutes;

use crate::adventure_director::{head16, level_key, nullish, prop, scene_level_index, scene_location_id};

pub const LOOT_CONTAINERS_SCHEMA_VERSION: i64 = 1;
pub const LOOT_CONTAINERS_POLICY_ID: &str = "skazanie:loot-containers-v1";
pub const LOOT_CONTAINER_CREATED_EVENT_SCHEMA_VERSION: i64 = 1;
pub const LOOT_CONTAINER_TAKEN_EVENT_SCHEMA_VERSION: i64 = 1;
/// Версия payload для тела из server-owned инвентаря NPC.
pub const NPC_LOOT_PAYLOAD_SCHEMA_VERSION: i64 = 1;
pub const NPC_LOOT_SOURCE: &str = "npc_world.inventories";

/// Виды контейнеров: тело, оружие пленного, брошенное по уговору парлея,
/// схрон (никем не создаётся) и метнутое героем оружие.
pub const LOOT_CONTAINER_KINDS: [&str; 5] = ["corpse", "captive", "abandoned", "cache", "dropped"];
/// Версия поля `thrown_weapon` в `LootContainerCreated`.
pub const THROWN_WEAPON_PAYLOAD_SCHEMA_VERSION: i64 = 1;
pub const LOOT_CONTAINER_STATUSES: [&str; 2] = ["available", "emptied"];

/// `LOOT_CONTAINER_COMMAND_TYPES`.
pub const LOOT_CONTAINER_COMMAND_TYPES: [&str; 1] = ["LootContainer"];

/// Обыскивают вытянутой рукой: своя клетка или соседняя.
pub const LOOT_CONTAINER_REACH_FEET: i64 = 5;

pub const MAX_LOOT_CONTAINERS: usize = 60;
pub const MAX_LOOT_CONTAINER_ITEMS: usize = 24;
pub const MAX_LOOT_LINES: usize = 12;
/// Столько предметов держит инвентарь героя.
pub const MAX_LOOT_RECIPIENT_INVENTORY_ITEMS: usize = 200;

// --- ошибка ---------------------------------------------------------------------------

/// Отказ модуля: `LootContainerError` JS (код и текст — как в JS) или
/// `TypeError` на мусоре во входе.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LootContainerError {
    pub name: &'static str,
    pub code: Option<String>,
    pub message: String,
}

impl LootContainerError {
    pub const NAME: &'static str = "LootContainerError";

    fn rule(message: impl Into<String>, code: &str) -> Self {
        Self { name: Self::NAME, code: Some(code.into()), message: message.into() }
    }

    fn type_error(message: impl Into<String>) -> Self {
        Self { name: "TypeError", code: None, message: message.into() }
    }

    fn null_read(key: &str) -> Self {
        Self::type_error(format!("Cannot read properties of null (reading '{key}')"))
    }

    /// Форма эталона: `{ name, code, message }`.
    pub fn to_json(&self) -> Value {
        json!({ "name": self.name, "code": self.code, "message": self.message })
    }
}

impl fmt::Display for LootContainerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for LootContainerError {}

/// Итог вызова, который в JS мог бросить исключение.
pub type LootResult<T> = Result<T, LootContainerError>;

fn reject<T>(message: &str, code: &str) -> LootResult<T> {
    Err(LootContainerError::rule(message, code))
}

// --- приведения JS ------------------------------------------------------------------

/// `text(value, maximum)` модуля: NFKC, пробелы схлопнуты, края обрезаны,
/// затем `slice(0, maximum)` по единицам UTF-16.
fn text(value: Option<&Value>, maximum: usize) -> String {
    head16(&jstext::squash_spaces(&jstext::nfkc(&js::s(value))), maximum)
}

/// `integer(value, fallback)` модуля.
fn integer(value: Option<&Value>, fallback: i64) -> i64 {
    js::safe_int(value, fallback)
}

/// `coordinate(value)`: безопасное целое или `null`.
fn coordinate(value: Option<&Value>) -> Value {
    if js::is_safe_integer_number(value) {
        js::num(js::number(value))
    } else {
        Value::Null
    }
}

/// `createHash('sha256').update(parts.map(String(x ?? '')).join('\0'))`.
fn digest(parts: &[String]) -> String {
    hash::sha256_hex(parts.join("\0"))
}

fn actor_id_of(actor: Option<&Value>) -> String {
    js::s(nullish(prop(actor, "id"), prop(actor, "actor_id")))
}

fn str_of(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

fn is_str(value: Option<&Value>, expected: &str) -> bool {
    str_of(value) == Some(expected)
}

fn array(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

fn plain(value: Option<&Value>) -> Option<&Map<String, Value>> {
    match value {
        Some(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// `(value ?? [])` перед `.map/.find/.some`: `undefined`/`null` — пусто,
/// массив — он сам, иное — `TypeError` («… is not a function»).
fn list_or_type_error<'a>(value: Option<&'a Value>, method: &str) -> LootResult<&'a [Value]> {
    match value {
        None | Some(Value::Null) => Ok(&[]),
        Some(Value::Array(items)) => Ok(items),
        Some(_) => Err(LootContainerError::type_error(format!("value.{method} is not a function"))),
    }
}

/// `{ ...value }`: объект — копия, строка и массив — индексы, иное — пусто.
fn spread_of(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map.clone(),
        Value::Array(items) => items.iter().enumerate().map(|(index, item)| (index.to_string(), item.clone())).collect(),
        Value::String(text) => text.chars().enumerate().map(|(index, ch)| (index.to_string(), Value::String(ch.to_string()))).collect(),
        _ => Map::new(),
    }
}

/// `value?.[0]`: элемент массива или первая единица строки.
fn first_of(value: Option<&Value>) -> Option<Value> {
    match value? {
        Value::Array(items) => items.first().cloned(),
        Value::String(text) => text.chars().next().map(|ch| Value::String(ch.to_string())),
        _ => None,
    }
}

/// `array.sort()` строк: по единицам UTF-16.
fn sort_utf16(items: &mut [String]) {
    items.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
}

/// `[...new Set(items)]`.
fn unique(items: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    items.into_iter().filter(|item| seen.insert(item.clone())).collect()
}

/// `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u`.
fn safe_id(id: &str) -> bool {
    let mut chars = id.chars();
    let Some(first) = chars.next() else { return false };
    first.is_ascii_alphanumeric() && id.len() <= 120 && chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-'))
}

fn strings(items: &[String]) -> Value {
    Value::Array(items.iter().map(|item| Value::String(item.clone())).collect())
}

// --- состояние ------------------------------------------------------------------------

/// `normalizeLootContainer(value)`: приведение одного контейнера из
/// сохранения, payload события или импорта. `None` — запись не контейнер.
pub fn normalize_loot_container(value: Option<&Value>) -> Option<Value> {
    let empty = Map::new();
    let source = plain(value).unwrap_or(&empty);
    let get = |key: &str| source.get(key);
    let id = text(get("id"), 120);
    if !safe_id(&id) {
        return None;
    }
    let kind = str_of(get("kind")).filter(|kind| LOOT_CONTAINER_KINDS.contains(kind))?.to_string();
    let mut seen = HashSet::new();
    let unique_items: Vec<Value> = array(get("items"))
        .iter()
        .take(MAX_LOOT_CONTAINER_ITEMS)
        .filter_map(|item| normalize_item_instance(Some(item)))
        .filter(|item| seen.insert(js::string(item.get("item_instance_id"))))
        .collect();
    let footprint = normalize_footprint_metadata(get("footprint"));
    let source_enemy_ids: Vec<String> = unique(array(get("source_enemy_ids")).iter().map(|entry| text(Some(entry), 120)).filter(|entry| !entry.is_empty())).into_iter().take(12).collect();
    let source_npc_id = text(nullish(get("source_npc_id"), get("sourceNpcId")), 120);
    let status = if unique_items.is_empty() {
        "emptied".to_string()
    } else {
        str_of(get("status")).filter(|status| LOOT_CONTAINER_STATUSES.contains(status)).unwrap_or("available").to_string()
    };
    let mut container = Map::new();
    container.insert("schema_version".into(), json!(LOOT_CONTAINERS_SCHEMA_VERSION));
    container.insert("policy_id".into(), json!(LOOT_CONTAINERS_POLICY_ID));
    container.insert("id".into(), json!(id));
    container.insert("kind".into(), json!(kind));
    container.insert("source_enemy_id".into(), json!(text(nullish(get("source_enemy_id"), get("sourceEnemyId")), 120)));
    container.insert("source_enemy_ids".into(), strings(&source_enemy_ids));
    if !source_npc_id.is_empty() {
        container.insert("source_npc_id".into(), json!(source_npc_id));
    }
    container.insert("encounter_id".into(), json!(text(nullish(get("encounter_id"), get("encounterId")), 160)));
    let name = text(get("name"), 160);
    container.insert("name".into(), json!(if name.is_empty() { "Добыча".to_string() } else { name }));
    container.insert("location_id".into(), json!(text(nullish(get("location_id"), get("locationId")), 180)));
    container.insert("location_name".into(), json!(text(nullish(get("location_name"), get("locationName")), 180)));
    container.insert("x".into(), coordinate(get("x")));
    container.insert("y".into(), coordinate(get("y")));
    if let Some(footprint) = footprint {
        container.insert("footprint".into(), footprint.to_value());
    }
    container.insert("status".into(), json!(status));
    container.insert("created_at_minutes".into(), json!(integer(nullish(get("created_at_minutes"), get("createdAtMinutes")), 0).max(0)));
    container.insert("items".into(), Value::Array(unique_items));
    Some(Value::Object(container))
}

/// `evictLootOverflow`: сверх бюджета первыми уходят опустошённые, невзятое —
/// последним и только по возрасту.
fn evict_loot_overflow(containers: Vec<Value>) -> Vec<Value> {
    if containers.len() <= MAX_LOOT_CONTAINERS {
        return containers;
    }
    let mut doomed = HashSet::new();
    let mut excess = containers.len() - MAX_LOOT_CONTAINERS;
    for status in ["emptied", "available"] {
        for (index, container) in containers.iter().enumerate() {
            if excess == 0 {
                break;
            }
            if doomed.contains(&index) || !is_str(container.get("status"), status) {
                continue;
            }
            doomed.insert(index);
            excess -= 1;
        }
    }
    containers.into_iter().enumerate().filter(|(index, _)| !doomed.contains(index)).map(|(_, container)| container).collect()
}

/// `normalizeLootContainersState(input)`: реестр без дублей и сверх бюджета.
pub fn normalize_loot_containers_state(input: Option<&Value>) -> Value {
    let mut containers = Vec::new();
    let mut seen = HashSet::new();
    for raw in array(plain(input).and_then(|source| source.get("containers"))) {
        let Some(container) = normalize_loot_container(Some(raw)) else { continue };
        let id = js::s(container.get("id"));
        if !seen.insert(id) {
            continue;
        }
        containers.push(container);
    }
    json!({ "schema_version": LOOT_CONTAINERS_SCHEMA_VERSION, "containers": evict_loot_overflow(containers) })
}

fn containers_of(normalized: Value) -> Vec<Value> {
    match normalized {
        Value::Object(mut map) => match map.shift_remove("containers") {
            Some(Value::Array(items)) => items,
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

/// `lootContainerList(state)`.
pub fn loot_container_list(state: &Value) -> Vec<Value> {
    containers_of(normalize_loot_containers_state(prop(Some(state), "loot_containers")))
}

/// `lootContainerFor(state, containerId)`.
pub fn loot_container_for(state: &Value, container_id: Option<&Value>) -> Option<Value> {
    let expected = text(container_id, 120);
    loot_container_list(state).into_iter().find(|container| is_str(container.get("id"), &expected))
}

/// `sceneLootLocationKey(state)`: ключ яруса, на котором стоит отряд.
/// `null` — `TypeError`, как у `sceneLocationId` JS.
pub fn scene_loot_location_key(state: &Value) -> LootResult<String> {
    if state.is_null() {
        return Err(LootContainerError::null_read("scene"));
    }
    Ok(level_key(&scene_location_id(state), scene_level_index(state)))
}

/// `lootContainersInScene(state, { includeEmptied })`: контейнеры текущего
/// яруса; опустошённые — только по просьбе.
pub fn loot_containers_in_scene(state: &Value, include_emptied: bool) -> LootResult<Vec<Value>> {
    let key = scene_loot_location_key(state)?;
    Ok(loot_container_list(state)
        .into_iter()
        .filter(|container| is_str(container.get("location_id"), &key))
        .filter(|container| include_emptied || is_str(container.get("status"), "available"))
        .collect())
}

fn container_id(kind: &str, parts: &[String], encounter_id: &str, location_key: &str, minutes: i64) -> String {
    let mut sorted: Vec<String> = parts.iter().map(|part| text(Some(&Value::String(part.clone())), 160)).collect();
    sort_utf16(&mut sorted);
    let mut all = vec![
        kind.to_string(),
        text(Some(&Value::String(encounter_id.to_string())), 160),
        text(Some(&Value::String(location_key.to_string())), 180),
        minutes.max(0).to_string(),
    ];
    all.extend(sorted);
    format!("loot:{}:{}", text(Some(&Value::String(kind.to_string())), 20), &digest(&all)[..24])
}

/// `lootContainerIdFor(kind, sourceIds, scope)`: в свёртку идут вид,
/// встреча, ярус, минута и отсортированные источники. `scope` —
/// `{ encounterId, locationKey, minutes }`.
pub fn loot_container_id_for(kind: Option<&Value>, source_ids: &[Value], scope: &Value) -> String {
    let parts: Vec<String> = source_ids.iter().map(|value| text(Some(value), 160)).collect();
    let mut sorted = parts;
    sort_utf16(&mut sorted);
    let mut all = vec![
        js::s(kind),
        text(prop(Some(scope), "encounterId"), 160),
        text(prop(Some(scope), "locationKey"), 180),
        integer(prop(Some(scope), "minutes"), 0).max(0).to_string(),
    ];
    all.extend(sorted);
    format!("loot:{}:{}", text(kind, 20), &digest(&all)[..24])
}

fn minutes_integer(minutes: f64) -> i64 {
    integer(Some(&js::num(minutes)), 0)
}

// --- создание вместе с фиксацией выбытия --------------------------------------------

fn container_title(kind: &str) -> &'static str {
    match kind {
        "corpse" => "Тело",
        "captive" => "Оружие пленного",
        "abandoned" => "Брошенная добыча",
        "cache" => "Схрон",
        "dropped" => "Брошенное оружие",
        _ => "Добыча",
    }
}

fn container_name(kind: &str, enemy_name: Option<&Value>) -> String {
    let title = container_title(kind);
    let name = text(enemy_name, 100);
    if kind == "abandoned" || name.is_empty() {
        title.to_string()
    } else {
        format!("{title}: {name}")
    }
}

fn lootable_items_of(enemy: Option<&Value>, weapons_only: bool) -> Vec<Value> {
    array(prop(prop(enemy, "loadout"), "items"))
        .iter()
        .filter_map(|item| normalize_item_instance(Some(item)))
        .filter(|item| js::is_true(item.get("lootable")))
        .filter(|item| !weapons_only || js::s(prop(item.get("snapshot"), "type")) == "weapon")
        .collect()
}

/// `itemForContainer`: экземпляр меняет владельца, `origin` — его история —
/// остаётся.
fn item_for_container(item: &Value, container_id: &str) -> Value {
    let mut patched = spread_of(item);
    patched.insert("equipped".into(), json!(false));
    patched.insert("owner".into(), json!({ "kind": "container", "actor_id": container_id }));
    normalize_item_instance(Some(&Value::Object(patched))).unwrap_or(Value::Null)
}

fn position_of(state: Option<&Value>, actor_id: &str) -> (Value, Value) {
    let stored = prop(prop(prop(state, "mechanics"), "positions"), actor_id);
    (coordinate(prop(stored, "x")), coordinate(prop(stored, "y")))
}

fn position_value(position: &(Value, Value)) -> Value {
    json!({ "x": position.0, "y": position.1 })
}

struct DraftSpec<'a> {
    kind: &'static str,
    enemies: Vec<&'a Value>,
    source_ids: Vec<String>,
    state: &'a Value,
    minutes: f64,
    location_key: &'a str,
    location_name: &'a str,
    encounter_id: &'a str,
    weapons_only: bool,
    anchor_id: String,
    anchor_position: Option<(Value, Value)>,
    prebuilt_items: Option<Vec<Value>>,
    source_npc_id: String,
    name_override: String,
    id_parts: Option<Vec<String>>,
    target_ids: Option<Vec<String>>,
    payload_extra: Map<String, Value>,
    /// `None` — поле не передано (`undefined`), `Some(Null)` — явный `null`.
    footprint_override: Option<Value>,
}

impl<'a> DraftSpec<'a> {
    fn new(kind: &'static str, state: &'a Value, minutes: f64, location_key: &'a str, location_name: &'a str, encounter_id: &'a str) -> Self {
        Self {
            kind,
            enemies: Vec::new(),
            source_ids: Vec::new(),
            state,
            minutes,
            location_key,
            location_name,
            encounter_id,
            weapons_only: false,
            anchor_id: String::new(),
            anchor_position: None,
            prebuilt_items: None,
            source_npc_id: String::new(),
            name_override: String::new(),
            id_parts: None,
            target_ids: None,
            payload_extra: Map::new(),
            footprint_override: None,
        }
    }
}

/// `containerDraft`: черновик `LootContainerCreated`; пустой контейнер не
/// создаётся.
fn container_draft(spec: DraftSpec<'_>) -> Option<Value> {
    let id = container_id(spec.kind, spec.id_parts.as_ref().unwrap_or(&spec.source_ids), spec.encounter_id, spec.location_key, minutes_integer(spec.minutes));
    let source_items = match spec.prebuilt_items {
        Some(items) => items,
        None => spec.enemies.iter().flat_map(|enemy| lootable_items_of(Some(enemy), spec.weapons_only)).collect(),
    };
    let items: Vec<Value> = source_items.iter().take(MAX_LOOT_CONTAINER_ITEMS).map(|item| item_for_container(item, &id)).collect();
    if items.is_empty() {
        return None;
    }
    let anchor = spec.anchor_position.unwrap_or_else(|| position_of(Some(spec.state), &spec.anchor_id));
    let footprint = match &spec.footprint_override {
        Some(value) => normalize_footprint_metadata(Some(value)),
        None if spec.enemies.len() == 1 => normalize_footprint_metadata(prop(Some(spec.enemies[0]), "footprint")),
        None => None,
    };
    let name = if spec.name_override.is_empty() {
        container_name(spec.kind, if spec.enemies.len() == 1 { prop(Some(spec.enemies[0]), "name") } else { None })
    } else {
        spec.name_override
    };
    let mut raw = Map::new();
    raw.insert("id".into(), json!(id));
    raw.insert("kind".into(), json!(spec.kind));
    raw.insert("source_enemy_id".into(), json!(if spec.source_ids.len() == 1 { spec.source_ids[0].clone() } else { String::new() }));
    raw.insert("source_enemy_ids".into(), strings(&spec.source_ids));
    if !spec.source_npc_id.is_empty() {
        raw.insert("source_npc_id".into(), json!(spec.source_npc_id));
    }
    raw.insert("encounter_id".into(), json!(spec.encounter_id));
    raw.insert("name".into(), json!(name));
    raw.insert("location_id".into(), json!(spec.location_key));
    raw.insert("location_name".into(), json!(spec.location_name));
    raw.insert("x".into(), anchor.0);
    raw.insert("y".into(), anchor.1);
    if let Some(footprint) = footprint {
        raw.insert("footprint".into(), footprint.to_value());
    }
    raw.insert("status".into(), json!("available"));
    raw.insert("created_at_minutes".into(), js::num(spec.minutes));
    raw.insert("items".into(), Value::Array(items));
    let mut payload = Map::new();
    payload.insert("schema_version".into(), json!(LOOT_CONTAINER_CREATED_EVENT_SCHEMA_VERSION));
    payload.insert("policy_id".into(), json!(LOOT_CONTAINERS_POLICY_ID));
    payload.insert("container".into(), normalize_loot_container(Some(&Value::Object(raw))).unwrap_or(Value::Null));
    for (key, value) in spec.payload_extra {
        payload.insert(key, value);
    }
    Some(json!({
        "event_type": "LootContainerCreated",
        "event_schema_version": LOOT_CONTAINER_CREATED_EVENT_SCHEMA_VERSION,
        "payload": Value::Object(payload),
        "target_ids": strings(spec.target_ids.as_ref().unwrap_or(&spec.source_ids)),
        "visibility": "party",
    }))
}

fn npc_inventory_of<'a>(state: &'a Value, npc_id: &str) -> &'a [Value] {
    let inventories = prop(prop(Some(state), "npc_world"), "inventories");
    match inventories {
        Some(Value::Object(map)) => array(map.get(npc_id)),
        _ => &[],
    }
}

struct NpcAnchor {
    position: (Value, Value),
    footprint: Value,
}

fn footprint_value(value: Option<&Value>) -> Value {
    normalize_footprint_metadata(value).map_or(Value::Null, |footprint| footprint.to_value())
}

fn npc_anchor_of(state: &Value, npc_id: &str, actor: Option<&Value>) -> NpcAnchor {
    let origin = prop(actor, "origin");
    let authored = is_str(prop(origin, "kind"), "authored-npc") || js::s(prop(origin, "npc_id")) == npc_id;
    let stored = position_of(Some(state), npc_id);
    let actor_position = (coordinate(prop(actor, "x")), coordinate(prop(actor, "y")));
    let location_id = scene_location_id(state);
    let placement = array(prop(prop(Some(state), "npc_world"), "placements"))
        .iter()
        .find(|entry| js::s(prop(Some(entry), "npc_id")) == npc_id && js::s(prop(Some(entry), "location_id")) == location_id);
    let known = |position: &(Value, Value)| !position.0.is_null() && !position.1.is_null();
    if authored && known(&stored) {
        return NpcAnchor { position: stored, footprint: footprint_value(prop(actor, "footprint")) };
    }
    if authored && known(&actor_position) {
        return NpcAnchor { position: actor_position, footprint: footprint_value(prop(actor, "footprint")) };
    }
    if let Some(placement) = placement {
        return NpcAnchor {
            position: (coordinate(prop(Some(placement), "x")), coordinate(prop(Some(placement), "y"))),
            footprint: footprint_value(prop(Some(placement), "footprint")),
        };
    }
    NpcAnchor { position: if known(&stored) { stored } else { actor_position }, footprint: footprint_value(prop(actor, "footprint")) }
}

fn npc_name_of(state: &Value, npc_id: &str, actor: Option<&Value>, event: Option<&Value>) -> String {
    let social = array(prop(prop(Some(state), "social"), "npcs")).iter().find(|npc| js::s(prop(Some(npc), "id")) == npc_id);
    let npc_id_value = Value::String(npc_id.to_string());
    let name = nullish(nullish(nullish(prop(social, "name"), prop(actor, "name")), prop(prop(event, "payload"), "npc_name")), Some(&npc_id_value));
    text(name, 160)
}

fn npc_loot_source_key(source: &Map<String, Value>, normalized: &Value, index: usize) -> String {
    let get = |key: &str| source.get(key);
    let explicit = text(nullish(nullish(nullish(get("item_instance_id"), get("itemInstanceId")), get("id")), get("item_id")), 160);
    if !explicit.is_empty() {
        return format!("{explicit}:{index}");
    }
    format!("{}:{}:{index}", text(nullish(get("catalog_id"), get("catalogId")), 120), text(normalized.get("name"), 120))
}

fn npc_loot_origin(source: &Map<String, Value>, normalized: &Value) -> Value {
    let origin = source.get("origin");
    let declared = match origin {
        Some(Value::String(_)) => origin,
        Some(Value::Object(map)) => map.get("kind"),
        _ => normalized.get("origin"),
    };
    let declared_text = js::s(declared);
    let kind = if ITEM_ORIGIN_KINDS.contains(&declared_text.as_str()) { declared_text } else { "unknown".to_string() };
    let empty = Map::new();
    let object = plain(origin).unwrap_or(&empty);
    json!({
        "kind": kind,
        "template_id": text(nullish(object.get("template_id"), object.get("templateId")), 120),
        "source_id": text(nullish(object.get("source_id"), object.get("sourceId")), 160),
    })
}

fn npc_loot_snapshot_field(value: Option<&Value>, fallback: &Value, field: &str) -> Value {
    let blank_string = matches!(value, Some(Value::String(text)) if jstext::trim(text).is_empty());
    let Some(value) = value.filter(|value| !value.is_null() && !blank_string) else {
        return fallback.clone();
    };
    let fallback_truthy = js::truthy(Some(fallback));
    if field == "name" && value.as_str() == Some("Предмет") && fallback_truthy && fallback.as_str() != Some("Предмет") {
        return fallback.clone();
    }
    if field == "type" && value.as_str() == Some("other") && fallback_truthy && fallback.as_str() != Some("other") {
        return fallback.clone();
    }
    if field == "weight" && js::number(Some(value)) == 0.0 && js::number(Some(fallback)) > 0.0 {
        return fallback.clone();
    }
    value.clone()
}

const UNKNOWN_SNAPSHOT_FIELDS: [&str; 14] = [
    "name",
    "type",
    "weight",
    "description",
    "properties",
    "base_price_cp",
    "mechanics_status",
    "rarity",
    "combat",
    "passive_effects",
    "charges",
    "recharge",
    "requires_attunement",
    "image",
];

fn npc_loot_snapshot(source: &Map<String, Value>, normalized: &Value, catalog_id: &str) -> Value {
    let supplied = plain(source.get("snapshot")).or_else(|| plain(normalized.get("snapshot")));
    if let Some(supplied) = supplied.filter(|map| !map.is_empty()) {
        let mut snapshot = supplied.clone();
        snapshot.insert("catalog_id".into(), json!(catalog_id));
        return Value::Object(snapshot);
    }
    if catalog_item_truthy(catalog_id) {
        let catalog_snapshot = item_instance_snapshot(Some(&json!(catalog_id))).unwrap_or_else(|_| json!({}));
        let mut fields = Map::new();
        if let Value::Object(map) = &catalog_snapshot {
            for (field, value) in js::entries(map) {
                fields.insert(field.clone(), npc_loot_snapshot_field(normalized.get(field.as_str()), value, field));
            }
        }
        fields.insert("catalog_id".into(), json!(catalog_id));
        return Value::Object(fields);
    }
    // Неизвестная пользовательская вещь остаётся явной: каталог не придумывает
    // для неё оружие или другую механику.
    let mut snapshot = Map::new();
    snapshot.insert("catalog_id".into(), json!(catalog_id));
    if js::truthy(normalized.get("catalog_schema_version")) {
        snapshot.insert("catalog_schema_version".into(), normalized["catalog_schema_version"].clone());
    }
    for field in UNKNOWN_SNAPSHOT_FIELDS {
        if let Some(value) = normalized.get(field) {
            snapshot.insert(field.into(), value.clone());
        }
    }
    Value::Object(snapshot)
}

struct NpcLootSource {
    source_key: String,
    source_item_instance_id: String,
    catalog_id: String,
    quantity: i64,
    snapshot: Value,
    charges: Value,
    origin: Value,
    unknown_catalog: bool,
}

fn normalize_npc_loot_sources(state: &Value, npc_id: &str) -> Vec<NpcLootSource> {
    let empty = Map::new();
    npc_inventory_of(state, npc_id)
        .iter()
        .enumerate()
        .map(|(index, raw)| {
            let source = plain(Some(raw)).unwrap_or(&empty);
            let mut input = source.clone();
            input.insert("equipped".into(), json!(false));
            input.insert("attuned_to".into(), Value::Null);
            let normalized = normalize_inventory_item(Some(&Value::Object(input)), InventoryItemOptions { preserve_unknown: true, ..InventoryItemOptions::default() });
            let catalog_id = text(nullish(nullish(normalized.get("catalog_id"), source.get("catalog_id")), source.get("catalogId")), 120);
            let source_key = npc_loot_source_key(source, &normalized, index);
            let effective_catalog_id = if catalog_id.is_empty() { format!("npc-raw:{}", &digest(&[npc_id.to_string(), source_key.clone()])[..24]) } else { catalog_id.clone() };
            NpcLootSource {
                quantity: integer(normalized.get("quantity"), 1).max(1),
                source_item_instance_id: text(nullish(source.get("item_instance_id"), source.get("itemInstanceId")), 160),
                snapshot: npc_loot_snapshot(source, &normalized, &effective_catalog_id),
                charges: nullish(source.get("charges"), normalized.get("charges")).cloned().unwrap_or(Value::Null),
                origin: npc_loot_origin(source, &normalized),
                unknown_catalog: catalog_id.is_empty() || !catalog_item_truthy(&catalog_id),
                catalog_id: effective_catalog_id,
                source_key,
            }
        })
        .collect()
}

fn npc_loot_instance_id(npc_id: &str, source: &NpcLootSource, part_index: i64, used: &HashSet<String>) -> String {
    let preferred = if !source.source_item_instance_id.is_empty() && part_index == 0 {
        source.source_item_instance_id.clone()
    } else {
        format!("npc:{}", &digest(&[npc_id.to_string(), source.source_key.clone(), part_index.to_string()])[..40])
    };
    if !used.contains(&preferred) {
        return preferred;
    }
    let mut collision = 1;
    loop {
        let fallback = format!("npc:{}", &digest(&[npc_id.to_string(), source.source_key.clone(), part_index.to_string(), collision.to_string()])[..40]);
        if !used.contains(&fallback) {
            return fallback;
        }
        collision += 1;
    }
}

struct NpcLootScope<'a> {
    state: &'a Value,
    inventory_state: &'a Value,
    npc_id: &'a str,
    event: Option<&'a Value>,
    minutes: f64,
    location_key: &'a str,
    location_name: &'a str,
    encounter_id: &'a str,
}

fn npc_loot_drafts(scope: NpcLootScope<'_>) -> LootResult<Vec<Value>> {
    let npc_id = scope.npc_id;
    let sources = normalize_npc_loot_sources(scope.inventory_state, npc_id);
    if sources.is_empty() {
        return Ok(Vec::new());
    }
    let mut segments: Vec<(usize, i64, i64)> = Vec::new();
    for (index, source) in sources.iter().enumerate() {
        let mut left = source.quantity;
        let mut part_index = 0;
        while left > 0 {
            let quantity = MAX_ITEM_INSTANCE_QUANTITY.min(left);
            segments.push((index, quantity, part_index));
            left -= quantity;
            part_index += 1;
        }
    }
    let part_count = segments.len().div_ceil(MAX_LOOT_CONTAINER_ITEMS);
    if part_count > MAX_LOOT_CONTAINERS {
        return reject("Инвентарь NPC не помещается в ограниченное число контейнеров", "NPC_LOOT_CONTAINER_LIMIT");
    }
    let actor = array(prop(Some(scope.state), "enemies"))
        .iter()
        .find(|candidate| actor_id_of(Some(candidate)) == npc_id || js::s(prop(prop(Some(candidate), "origin"), "npc_id")) == npc_id);
    let anchor = npc_anchor_of(scope.state, npc_id, actor);
    let name = container_name("corpse", Some(&Value::String(npc_name_of(scope.state, npc_id, actor, scope.event))));
    let mut drafts = Vec::new();
    let mut used = HashSet::new();
    for part in 0..part_count {
        let container_parts = vec![format!("npc:{npc_id}"), format!("part:{part}")];
        let id = container_id("corpse", &container_parts, scope.encounter_id, scope.location_key, minutes_integer(scope.minutes));
        let chunk = &segments[(part * MAX_LOOT_CONTAINER_ITEMS).min(segments.len())..((part + 1) * MAX_LOOT_CONTAINER_ITEMS).min(segments.len())];
        let mut items = Vec::new();
        for &(source_index, quantity, part_index) in chunk {
            let source = &sources[source_index];
            let item_instance_id = npc_loot_instance_id(npc_id, source, part_index, &used);
            used.insert(item_instance_id.clone());
            let mut raw = Map::new();
            raw.insert("schema_version".into(), json!(ITEM_INSTANCE_SCHEMA_VERSION));
            raw.insert("item_instance_id".into(), json!(item_instance_id));
            raw.insert("catalog_id".into(), json!(source.catalog_id));
            raw.insert("snapshot".into(), source.snapshot.clone());
            raw.insert("quantity".into(), json!(quantity));
            let snapshot_charges = prop(Some(&source.snapshot), "charges");
            if js::truthy(Some(&source.charges)) || (source.source_item_instance_id.is_empty() && js::truthy(snapshot_charges)) {
                let charges = nullish(Some(&source.charges), snapshot_charges).cloned();
                if let Some(charges) = charges {
                    raw.insert("charges".into(), charges);
                }
            }
            raw.insert("equipped".into(), json!(false));
            raw.insert("owner".into(), json!({ "kind": "container", "actor_id": id }));
            raw.insert("origin".into(), source.origin.clone());
            raw.insert("lootable".into(), json!(true));
            if let Some(item) = normalize_item_instance(Some(&Value::Object(raw))) {
                items.push(item);
            }
        }
        if items.len() != chunk.len() {
            return reject("Часть инвентаря NPC не удалось сохранить как экземпляр", "NPC_LOOT_ITEM_INVALID");
        }
        let unknown_items = unique(chunk.iter().filter(|segment| sources[segment.0].unknown_catalog).map(|segment| digest(&[npc_id.to_string(), sources[segment.0].source_key.clone()])[..16].to_string()));
        let mut npc_loot = Map::new();
        npc_loot.insert("schema_version".into(), json!(NPC_LOOT_PAYLOAD_SCHEMA_VERSION));
        npc_loot.insert("source".into(), json!(NPC_LOOT_SOURCE));
        npc_loot.insert("npc_id".into(), json!(npc_id));
        npc_loot.insert("part_index".into(), json!(part));
        npc_loot.insert("part_count".into(), json!(part_count));
        npc_loot.insert("clear_inventory".into(), json!(part == 0));
        if !unknown_items.is_empty() {
            npc_loot.insert("unknown_items".into(), strings(&unknown_items));
        }
        let mut spec = DraftSpec::new("corpse", scope.state, scope.minutes, scope.location_key, scope.location_name, scope.encounter_id);
        spec.anchor_position = Some(anchor.position.clone());
        spec.footprint_override = Some(anchor.footprint.clone());
        spec.prebuilt_items = Some(items);
        spec.source_npc_id = npc_id.to_string();
        spec.name_override = name.clone();
        spec.id_parts = Some(container_parts);
        spec.target_ids = Some(vec![npc_id.to_string()]);
        spec.payload_extra.insert("npc_loot".into(), Value::Object(npc_loot));
        if let Some(draft) = container_draft(spec) {
            drafts.push(draft);
        }
    }
    Ok(drafts)
}

fn npc_id_of_event(event: &Value) -> String {
    let first = first_of(prop(Some(event), "target_ids"));
    js::s(nullish(prop(prop(Some(event), "payload"), "npc_id"), first.as_ref()))
}

/// `lootCommitTouchesContainers(before, events)`: дешёвый гейт — может ли
/// фиксация вообще породить контейнер.
pub fn loot_commit_touches_containers(before: &Value, events: &Value) -> bool {
    let lootable: HashSet<String> = array(prop(Some(before), "enemies"))
        .iter()
        .filter(|enemy| array(prop(prop(Some(enemy), "loadout"), "items")).iter().any(|item| js::is_true(prop(Some(item), "lootable"))))
        .map(|enemy| actor_id_of(Some(enemy)))
        .filter(|id| !id.is_empty())
        .collect();
    let npc_ids: HashSet<String> = match prop(prop(Some(before), "npc_world"), "inventories") {
        Some(Value::Object(map)) => map.iter().filter(|(_, inventory)| matches!(inventory, Value::Array(items) if !items.is_empty())).map(|(id, _)| id.clone()).collect(),
        _ => HashSet::new(),
    };
    if lootable.is_empty() && npc_ids.is_empty() {
        return false;
    }
    array(Some(events)).iter().any(|event| {
        let event_type = prop(Some(event), "event_type");
        let payload = prop(Some(event), "payload");
        (is_str(event_type, "CaptiveTaken") && !lootable.is_empty())
            || (is_str(event_type, "ParleySettled") && js::s(prop(payload, "outcome")) == "tribute" && !lootable.is_empty())
            || (prop(payload, "hp_after").and_then(Value::as_f64) == Some(0.0) && array(prop(Some(event), "target_ids")).iter().any(|id| lootable.contains(&js::string(Some(id)))))
            || (is_str(event_type, "NpcDied") && npc_ids.contains(&npc_id_of_event(event)))
    })
}

/// `planLootContainerDrafts(before, after, events)`: черновики
/// `LootContainerCreated` для одной фиксации — тела NPC, пленные, брошенный
/// тюк парлея и тела противников.
pub fn plan_loot_container_drafts(before: &Value, after: &Value, events: &Value) -> LootResult<Vec<Value>> {
    let event_list = array(Some(events));
    if after.is_null() {
        return Err(LootContainerError::null_read("mechanics"));
    }
    let minutes = campaign_elapsed_minutes(after);
    let location_key = scene_loot_location_key(after)?;
    let mut existing: HashSet<String> = loot_container_list(after)
        .iter()
        .filter(|container| is_str(container.get("location_id"), &location_key) && is_str(container.get("status"), "available"))
        .map(|container| js::s(container.get("id")))
        .collect();
    let scene = prop(Some(after), "scene");
    let location_name = text(nullish(prop(scene, "location"), prop(scene, "title")), 180);
    let encounter = prop(prop(Some(after), "mechanics"), "encounter");
    let encounter_id = text(nullish(prop(encounter, "id"), prop(encounter, "encounter_id")), 160);
    let mut enemies_before: IndexMap<String, &Value> = IndexMap::new();
    for enemy in array(prop(Some(before), "enemies")) {
        enemies_before.insert(actor_id_of(Some(enemy)), enemy);
    }
    let mut enemies_after: IndexMap<String, &Value> = IndexMap::new();
    for enemy in array(prop(Some(after), "enemies")) {
        enemies_after.insert(actor_id_of(Some(enemy)), enemy);
    }
    let mut npc_death_events: Vec<(String, &Value)> = event_list
        .iter()
        .filter(|event| is_str(prop(Some(event), "event_type"), "NpcDied"))
        .map(|event| (npc_id_of_event(event), event))
        .filter(|(npc_id, _)| !npc_id.is_empty())
        .collect();
    npc_death_events.sort_by(|left, right| jstext::locale_compare(&left.0, &right.0));
    let social_npc_ids: HashSet<String> = array(prop(prop(Some(before), "social"), "npcs")).iter().map(|npc| text(prop(Some(npc), "id"), 120)).filter(|id| !id.is_empty()).collect();
    let authored_npc_ids: HashSet<String> = enemies_before
        .values()
        .filter(|enemy| {
            let origin = prop(Some(enemy), "origin");
            is_str(prop(origin, "kind"), "authored-npc") || js::truthy(prop(origin, "npc_id"))
        })
        .flat_map(|enemy| [actor_id_of(Some(enemy)), text(prop(prop(Some(enemy), "origin"), "npc_id"), 120)])
        .filter(|id| !id.is_empty())
        .collect();
    let npc_owner_ids: HashSet<String> = npc_death_events
        .iter()
        .map(|(npc_id, _)| npc_id.clone())
        .filter(|npc_id| !npc_inventory_of(before, npc_id).is_empty() || social_npc_ids.contains(npc_id) || authored_npc_ids.contains(npc_id))
        .collect();
    let mut npc_deaths: IndexMap<String, &Value> = IndexMap::new();
    for (npc_id, event) in &npc_death_events {
        if !npc_inventory_of(before, npc_id).is_empty() {
            npc_deaths.insert(npc_id.clone(), event);
        }
    }

    // Плен фиксируется собственным событием и в том же коммите.
    let captured: HashSet<String> = event_list
        .iter()
        .filter(|event| is_str(prop(Some(event), "event_type"), "CaptiveTaken"))
        .map(|event| js::s(prop(prop(prop(Some(event), "payload"), "captive"), "actor_id")))
        .filter(|id| !id.is_empty())
        .collect();
    // «Уйти, оставив добычу» — исход парлея `tribute`.
    let tribute = event_list.iter().find(|event| is_str(prop(Some(event), "event_type"), "ParleySettled") && js::s(prop(prop(Some(event), "payload"), "outcome")) == "tribute");
    let tribute_ids: HashSet<String> = array(prop(prop(tribute, "payload"), "enemy_ids")).iter().map(|id| js::string(Some(id))).collect();

    let mut drafts = Vec::new();
    for (npc_id, death) in &npc_deaths {
        let scope = NpcLootScope {
            state: after,
            inventory_state: before,
            npc_id,
            event: Some(death),
            minutes,
            location_key: &location_key,
            location_name: &location_name,
            encounter_id: &encounter_id,
        };
        for draft in npc_loot_drafts(scope)? {
            let id = prop(prop(Some(&draft), "payload"), "container").and_then(|container| prop(Some(container), "id"));
            if !js::truthy(id) {
                continue;
            }
            let id = js::s(id);
            if existing.contains(&id) {
                continue;
            }
            existing.insert(id);
            drafts.push(draft);
        }
    }
    let draft_id = |draft: &Value| js::s(prop(prop(Some(draft), "payload"), "container").and_then(|container| prop(Some(container), "id")));
    let mut abandoned: Vec<&Value> = Vec::new();
    let mut ordered: Vec<(&String, &&Value)> = enemies_before.iter().collect();
    ordered.sort_by(|left, right| jstext::locale_compare(left.0, right.0));
    for (enemy_id, enemy_before) in ordered {
        if npc_owner_ids.contains(enemy_id) {
            continue;
        }
        let Some(enemy_after) = enemies_after.get(enemy_id).copied().filter(|enemy| js::truthy(Some(enemy))) else { continue };
        let mut base = DraftSpec::new("corpse", before, minutes, &location_key, &location_name, &encounter_id);
        base.enemies = vec![enemy_after];
        base.source_ids = vec![enemy_id.clone()];
        base.anchor_id = enemy_id.clone();
        if captured.contains(enemy_id) {
            base.kind = "captive";
            base.weapons_only = true;
            if let Some(draft) = container_draft(base).filter(|draft| !existing.contains(&draft_id(draft))) {
                drafts.push(draft);
            }
            continue;
        }
        if tribute_ids.contains(enemy_id) {
            abandoned.push(enemy_after);
            continue;
        }
        if enemy_before.is_null() {
            return Err(LootContainerError::null_read("hp"));
        }
        // Тело — на переходе «были ОЗ — не осталось», а не по флагу `alive`.
        if integer(prop(Some(enemy_before), "hp"), 0).max(0) > 0 && integer(prop(Some(enemy_after), "hp"), 0).max(0) == 0 {
            if let Some(draft) = container_draft(base).filter(|draft| !existing.contains(&draft_id(draft))) {
                drafts.push(draft);
            }
        }
    }
    if !abandoned.is_empty() {
        let mut source_ids: Vec<String> = abandoned.iter().map(|enemy| actor_id_of(Some(enemy))).collect();
        sort_utf16(&mut source_ids);
        let mut spec = DraftSpec::new("abandoned", before, minutes, &location_key, &location_name, &encounter_id);
        spec.anchor_id = source_ids.first().cloned().unwrap_or_default();
        spec.enemies = abandoned;
        spec.source_ids = source_ids;
        if let Some(draft) = container_draft(spec).filter(|draft| !existing.contains(&draft_id(draft))) {
            drafts.push(draft);
        }
    }
    Ok(drafts)
}

// --- команда обыска -------------------------------------------------------------------

/// Поля команды: список закрыт, лишнее поле — чужой вес, цена или механика.
const LOOT_COMMAND_FIELDS: [&str; 22] = [
    "command_type",
    "command_id",
    "campaign_id",
    "actor_id",
    "target_id",
    "target_ids",
    "container_id",
    "lines",
    "recipient_id",
    "merchant_id",
    "stock_id",
    "action_id",
    "item_id",
    "quantity",
    "expected_state_version",
    "ruleset_id",
    "source_rule_ids",
    "house_rule_id",
    "ruling_id",
    "visibility",
    "request_fingerprint",
    "server_authoritative",
];

/// `normalizeLootLines(input)`: строки обыска — экземпляр и количество.
pub fn normalize_loot_lines(input: Option<&Value>) -> Vec<Value> {
    let Some(Value::Array(lines)) = input else { return Vec::new() };
    lines
        .iter()
        .take(MAX_LOOT_LINES)
        .filter_map(|line| {
            let line = plain(Some(line))?;
            let item_instance_id = text(nullish(line.get("item_instance_id"), line.get("itemInstanceId")), 160);
            (!item_instance_id.is_empty()).then(|| json!({ "item_instance_id": item_instance_id, "quantity": integer(line.get("quantity"), 1) }))
        })
        .collect()
}

/// `playerActor(state, id)`: найденный элемент как есть (и ложный тоже —
/// вызывающий проверяет истинность, как `!owner` в JS).
fn player_actor<'a>(state: &'a Value, id: &str) -> Option<&'a Value> {
    array(prop(Some(state), "players")).iter().find(|candidate| actor_id_of(Some(candidate)) == id)
}

fn truthy_actor(actor: Option<&Value>) -> Option<&Value> {
    actor.filter(|actor| js::truthy(Some(actor)))
}

fn in_party_with(state: &Value, id: &str) -> bool {
    let members = array(prop(Some(state), "partyMemberIds"));
    let ids: Vec<String> = if members.is_empty() {
        // `(state?.players ?? []).map(actorIdOf)`: сюда доходят только с
        // найденным героем, то есть с массивом героев.
        array(prop(Some(state), "players")).iter().map(|player| actor_id_of(Some(player))).collect()
    } else {
        members.iter().map(|member| js::string(Some(member))).collect()
    };
    ids.iter().any(|member| member == id)
}

fn reachable(state: &Value, actor: &Value, container: &Value) -> bool {
    // У контейнера без клетки досягаемость проверяется только сценой.
    if !js::present(prop(Some(container), "x")) || !js::present(prop(Some(container), "y")) {
        return true;
    }
    let position = position_of(Some(state), &actor_id_of(Some(actor)));
    if position.0.is_null() || position.1.is_null() {
        return false;
    }
    let anchor = position_value(&position);
    footprint_distance_feet(Some(actor), Some(container), Some(&anchor), Some(container)).is_some_and(|feet| feet <= LOOT_CONTAINER_REACH_FEET as f64)
}

/// Происхождение вещи на границе кармана: источник → поступок.
fn container_origin_kind(kind: &str) -> Option<&'static str> {
    match kind {
        "corpse" | "captive" => Some("looted"),
        "abandoned" | "cache" => Some("found"),
        // Своё оружие, поднятое с земли, не становится находкой.
        "dropped" => Some("unknown"),
        _ => None,
    }
}

/// Сведения о броске для [`thrown_weapon_drop_draft`] (`{ commandId,
/// ownerId, item, position }` JS); `None` — поле не передано.
#[derive(Debug, Clone, Copy, Default)]
pub struct ThrownWeaponInfo<'a> {
    pub command_id: Option<&'a Value>,
    pub owner_id: Option<&'a Value>,
    pub item: Option<&'a Value>,
    pub position: Option<&'a Value>,
}

/// `thrownWeaponDropDraft(state, throwInfo)`: метнутое героем оружие падает
/// у цели контейнером `dropped` в той же фиксации, что и бросок. `None` —
/// вещь без записи каталога остаётся в руке.
pub fn thrown_weapon_drop_draft(state: &Value, info: ThrownWeaponInfo<'_>) -> LootResult<Option<Value>> {
    let item = info.item;
    let catalog_id = text(nullish(prop(item, "catalog_id"), prop(item, "catalogId")), 120);
    let item_id = text(prop(item, "id"), 120);
    let owner = text(info.owner_id, 120);
    if catalog_id.is_empty() || item_id.is_empty() || owner.is_empty() {
        return Ok(None);
    }
    let location_key = scene_loot_location_key(state)?;
    let minutes = campaign_elapsed_minutes(state);
    let encounter = prop(prop(Some(state), "mechanics"), "encounter");
    let encounter_id = text(nullish(prop(encounter, "id"), prop(encounter, "encounter_id")), 160);
    let declared_origin = text(prop(item, "origin"), 40);
    let mut snapshot = item.map(spread_of).unwrap_or_default();
    snapshot.insert("catalog_id".into(), json!(catalog_id));
    let mut raw = Map::new();
    raw.insert("item_instance_id".into(), json!(format!("thrown:{}", &digest(&[js::s(info.command_id), owner.clone(), item_id.clone()])[..24])));
    raw.insert("catalog_id".into(), json!(catalog_id));
    raw.insert("snapshot".into(), Value::Object(snapshot));
    raw.insert("quantity".into(), json!(1));
    if let Some(charges @ (Value::Object(_) | Value::Array(_))) = prop(item, "charges") {
        raw.insert("charges".into(), charges.clone());
    }
    raw.insert("owner".into(), json!({ "kind": "container", "actor_id": "pending" }));
    let origin_kind = if ITEM_ORIGIN_KINDS.contains(&declared_origin.as_str()) { declared_origin } else { "unknown".to_string() };
    raw.insert("origin".into(), json!({ "kind": origin_kind, "source_id": owner, "template_id": item_id }));
    raw.insert("lootable".into(), json!(true));
    let Some(instance) = normalize_item_instance(Some(&Value::Object(raw))) else { return Ok(None) };
    let location_name = text(prop(prop(Some(state), "scene"), "location"), 180);
    let item_name = text(prop(item, "name"), 100);
    let mut spec = DraftSpec::new("dropped", state, minutes, &location_key, &location_name, &encounter_id);
    spec.id_parts = Some(vec![owner.clone(), item_id.clone(), text(info.command_id, 160)]);
    spec.anchor_position = Some((coordinate(prop(info.position, "x")), coordinate(prop(info.position, "y"))));
    spec.prebuilt_items = Some(vec![instance]);
    spec.name_override = format!("{}: {}", container_title("dropped"), if item_name.is_empty() { "вещь" } else { &item_name });
    spec.target_ids = Some(vec![owner.clone()]);
    spec.footprint_override = Some(Value::Null);
    spec.payload_extra.insert(
        "thrown_weapon".into(),
        json!({
            "schema_version": THROWN_WEAPON_PAYLOAD_SCHEMA_VERSION,
            "owner_id": owner,
            "item_id": item_id,
            "quantity_before": integer(prop(item, "quantity"), 1).max(1),
        }),
    );
    Ok(container_draft(spec))
}

/// `lootCombatActionFor(state, actorId, container)`: чем в бою оплачивается
/// обыск; своё брошенное оружие — взаимодействием с предметом. `None` — вне
/// боя.
pub fn loot_combat_action_for(state: &Value, actor_id: Option<&Value>, container: Option<&Value>) -> Option<&'static str> {
    let combat = prop(prop(Some(state), "mechanics"), "combat");
    if !js::is_true(prop(combat, "active")) {
        return None;
    }
    let economy = prop(prop(combat, "action_economy"), &text(actor_id, 120));
    Some(if is_str(prop(container, "kind"), "dropped") && !js::is_false(prop(economy, "object_interaction")) { "object_interaction" } else { "action" })
}

enum ThrownReturn {
    ReturnTo(String),
    Id(String),
}

/// `thrownWeaponReturn`: поднятое своё оружие — обратно в ту же стопку или
/// под прежним идентификатором, если он свободен.
fn thrown_weapon_return(state: &Value, container: &Value, instance: &Value, recipient_id: &str) -> LootResult<Option<ThrownReturn>> {
    if !is_str(container.get("kind"), "dropped") {
        return Ok(None);
    }
    let origin = instance.get("origin");
    let original_id = text(prop(origin, "template_id"), 120);
    if original_id.is_empty() || text(prop(origin, "source_id"), 120) != recipient_id {
        return Ok(None);
    }
    let recipient = player_actor(state, recipient_id);
    let stack = list_or_type_error(prop(recipient, "inventory"), "find")?.iter().find(|item| js::s(prop(Some(item), "id")) == original_id);
    if let Some(stack) = stack {
        let same = text(nullish(prop(Some(stack), "catalog_id"), prop(Some(stack), "catalogId")), 120) == text(instance.get("catalog_id"), 120);
        return Ok(same.then_some(ThrownReturn::ReturnTo(original_id)));
    }
    let mut taken = false;
    for player in list_or_type_error(prop(Some(state), "players"), "some")? {
        if list_or_type_error(prop(Some(player), "inventory"), "some")?.iter().any(|item| js::s(prop(Some(item), "id")) == original_id) {
            taken = true;
            break;
        }
    }
    Ok((!taken).then_some(ThrownReturn::Id(original_id)))
}

/// `inventoryItemFromInstance(instance, { id, quantity, containerKind })`:
/// экземпляр контейнера → запись инвентаря героя по его снимку.
pub fn inventory_item_from_instance(instance: &Value, id: &str, quantity: i64, container_kind: &str) -> Value {
    let snapshot_value = prop(Some(instance), "snapshot").filter(|value| matches!(value, Value::Object(_) | Value::Array(_)));
    let mut item = snapshot_value.map(spread_of).unwrap_or_default();
    let declared = js::s(prop(prop(Some(instance), "origin"), "kind"));
    let origin = if !declared.is_empty() && declared != "enemy_loadout" && declared != "unknown" {
        declared
    } else {
        container_origin_kind(container_kind).unwrap_or("found").to_string()
    };
    item.insert("id".into(), json!(id));
    item.insert("quantity".into(), json!(quantity));
    item.insert("equipped".into(), json!(false));
    item.insert("origin".into(), json!(origin));
    // `properties` в снимке нет намеренно: карточке нужно описание записи.
    item.insert("properties".into(), json!(text(prop(snapshot_value, "description"), 500)));
    if let Some(charges) = prop(Some(instance), "charges").filter(|charges| js::truthy(Some(charges))) {
        item.insert("charges".into(), charges.clone());
    }
    normalize_inventory_item(Some(&Value::Object(item)), InventoryItemOptions::default())
}

fn looted_item_id(command_id: Option<&Value>, container_id: &str, item_instance_id: &str) -> String {
    format!("loot:{}", &digest(&[js::s(command_id), container_id.to_string(), item_instance_id.to_string()])[..24])
}

/// `!candidate.equipped && !candidate.attuned_to && stackKey(candidate) ===
/// stackKey(item)` одного кандидата; `null` — `TypeError`.
fn stacks_with(candidate: &Value, key: &str) -> LootResult<bool> {
    if candidate.is_null() {
        return Err(LootContainerError::null_read("equipped"));
    }
    Ok(!js::truthy(prop(Some(candidate), "equipped")) && !js::truthy(prop(Some(candidate), "attuned_to")) && inventory_stack_key(Some(candidate)) == key)
}

/// `validateLootContainerCommand(command, state, context)`: проверка обыска
/// от прав к физике; итог — обогащённая команда с уже собранным набором.
pub fn validate_loot_container_command(command: &Value, state: &Value, context: &Value) -> LootResult<Value> {
    let Some(command_map) = command.as_object().filter(|_| LOOT_CONTAINER_COMMAND_TYPES.iter().any(|kind| is_str(command.get("command_type"), kind))) else {
        return Ok(command.clone());
    };
    let unexpected: Vec<&str> = js::keys(command_map).into_iter().map(String::as_str).filter(|key| !LOOT_COMMAND_FIELDS.contains(key)).collect();
    if !unexpected.is_empty() {
        return reject(&format!("Команда обыска содержит запрещённые поля: {}", unexpected.join(", ")), "LOOT_COMMAND_UNKNOWN_FIELD");
    }
    let owner_id = text(command.get("actor_id"), 120);
    let Some(owner) = truthy_actor(player_actor(state, &owner_id)) else {
        return reject("Обыскивать может только герой отряда", "ACTOR_FORBIDDEN");
    };
    if !in_party_with(state, &owner_id) {
        return reject("Обыскивать может только герой отряда", "ACTOR_FORBIDDEN");
    }
    let allowed = js::is_true(prop(Some(context), "isAdmin")) || array(prop(Some(context), "allowedActorIds")).iter().any(|id| js::string(Some(id)) == owner_id);
    if !allowed {
        return reject("Обыскивать можно только своим героем", "ACTOR_FORBIDDEN");
    }
    if js::is_false(prop(Some(owner), "alive")) || integer(prop(Some(owner), "hp"), 0).max(0) <= 0 {
        return reject("Герой без сознания не обыскивает", "ACTOR_DEFEATED");
    }

    let Some(container) = loot_container_for(state, command.get("container_id")) else {
        return reject("Контейнер добычи не найден", "LOOT_CONTAINER_NOT_FOUND");
    };
    if !is_str(container.get("status"), "available") {
        return reject("Здесь уже ничего не осталось", "LOOT_CONTAINER_EMPTY");
    }
    if !is_str(container.get("location_id"), &scene_loot_location_key(state)?) {
        return reject("Этот контейнер остался в другом месте", "LOOT_CONTAINER_NOT_IN_SCENE");
    }
    if !reachable(state, owner, &container) {
        return reject("До добычи надо дойти: обыскивают в пределах пяти футов", "LOOT_CONTAINER_OUT_OF_REACH");
    }

    let lines = normalize_loot_lines(command.get("lines"));
    if lines.is_empty() {
        return reject("Не выбрано ни одного предмета", "LOOT_LINES_REQUIRED");
    }
    let line_id = |line: &Value| js::s(line.get("item_instance_id"));
    if lines.iter().map(line_id).collect::<HashSet<_>>().len() != lines.len() {
        return reject("Один и тот же предмет указан дважды", "LOOT_LINE_DUPLICATE");
    }
    let container_items = array(container.get("items"));
    let mut by_instance_id: HashMap<String, &Value> = HashMap::new();
    for item in container_items {
        by_instance_id.insert(js::string(item.get("item_instance_id")), item);
    }
    let mut taken: Vec<(&Value, i64)> = Vec::new();
    for line in &lines {
        let Some(instance) = by_instance_id.get(&line_id(line)).copied() else {
            return reject("Этого предмета в контейнере уже нет", "LOOT_ITEM_GONE");
        };
        let available = integer(instance.get("quantity"), 1).max(0);
        let quantity = integer(line.get("quantity"), 1);
        if quantity < 1 || quantity > available {
            return reject("Недопустимое количество предметов", "LOOT_QUANTITY_INVALID");
        }
        taken.push((instance, quantity));
    }

    let recipient_text = text(command.get("recipient_id"), 120);
    let recipient_id = if recipient_text.is_empty() { owner_id.clone() } else { recipient_text };
    let Some(recipient) = truthy_actor(player_actor(state, &recipient_id)).filter(|_| in_party_with(state, &recipient_id)) else {
        return reject("Получатель должен быть героем этого отряда", "LOOT_RECIPIENT_INVALID");
    };
    // В бою добыча уходит только тому, кто нагнулся.
    if js::is_true(prop(prop(prop(Some(state), "mechanics"), "combat"), "active")) && recipient_id != owner_id {
        return reject("В бою добыча достаётся тому, кто обыскивает", "LOOT_RECIPIENT_DURING_COMBAT");
    }

    let container_id_text = js::s(container.get("id"));
    let container_kind = js::s(container.get("kind"));
    let mut returns = Vec::new();
    let mut items = Vec::new();
    for (instance, quantity) in &taken {
        let back = thrown_weapon_return(state, &container, instance, &recipient_id)?;
        let id = match &back {
            Some(ThrownReturn::Id(id)) => id.clone(),
            _ => looted_item_id(command.get("command_id"), &container_id_text, &js::s(instance.get("item_instance_id"))),
        };
        if let Some(ThrownReturn::ReturnTo(to)) = &back {
            returns.push(json!({ "item_id": id, "to_item_id": to }));
        }
        items.push(inventory_item_from_instance(instance, &id, *quantity, &container_kind));
    }
    let returned_ids: HashSet<String> = returns.iter().map(|entry| js::s(entry.get("item_id"))).collect();
    let inventory = array(prop(Some(recipient), "inventory"));
    let mut existing_ids = HashSet::new();
    for player in list_or_type_error(prop(Some(state), "players"), "flatMap")? {
        for item in list_or_type_error(prop(Some(player), "inventory"), "map")? {
            let id = js::s(prop(Some(item), "id"));
            if !id.is_empty() {
                existing_ids.insert(id);
            }
        }
    }
    if items.iter().any(|item| {
        let id = js::string(item.get("id"));
        !returned_ids.contains(&id) && existing_ids.contains(&id)
    }) {
        return reject("Идентификатор поднятой вещи уже занят", "LOOT_ITEM_ID_COLLISION");
    }
    let item_keys: Vec<String> = items.iter().map(|item| inventory_stack_key(Some(item))).collect();
    let mut merged = 0;
    for key in &item_keys {
        for candidate in inventory {
            if stacks_with(candidate, key)? {
                merged += 1;
                break;
            }
        }
    }
    if inventory.len() + items.len() - merged > MAX_LOOT_RECIPIENT_INVENTORY_ITEMS {
        return reject("Инвентарь получателя заполнен", "LOOT_INVENTORY_CAPACITY_EXCEEDED");
    }
    for (item, key) in items.iter().zip(&item_keys) {
        let mut stacked = 0i64;
        for candidate in inventory {
            if stacks_with(candidate, key)? {
                stacked += integer(prop(Some(candidate), "quantity"), 1).max(1);
            }
        }
        if stacked + integer(item.get("quantity"), 1).max(1) > MAX_STOCK_QUANTITY {
            return reject("Стопка предметов получателя превысит допустимый размер", "LOOT_STACK_LIMIT_EXCEEDED");
        }
    }
    let added_weight: f64 = items
        .iter()
        .map(|item| {
            let weight = js::number(item.get("weight"));
            let weight = if weight.is_nan() { 0.0 } else { weight };
            weight.max(0.0) * integer(item.get("quantity"), 1).max(1) as f64
        })
        .sum();
    let carried = inventory_weight(Some(recipient)).map_err(|error| LootContainerError::type_error(error.to_string()))?;
    if js::number(Some(&carried)) + added_weight > js::number(Some(&carrying_capacity(Some(recipient)))) {
        return reject("Получатель не унесёт столько", "CARRYING_CAPACITY_EXCEEDED");
    }

    let remaining: Vec<Value> = container_items
        .iter()
        .map(|item| {
            let line = taken.iter().find(|(instance, _)| js::s(instance.get("item_instance_id")) == js::s(item.get("item_instance_id")));
            match line {
                Some((_, quantity)) => {
                    let mut copy = spread_of(item);
                    copy.insert("quantity".into(), json!((integer(item.get("quantity"), 1) - quantity).max(0)));
                    Value::Object(copy)
                }
                None => item.clone(),
            }
        })
        .filter(|item| integer(item.get("quantity"), 0) > 0)
        .collect();

    let combat_action = loot_combat_action_for(state, Some(&Value::String(owner_id.clone())), Some(&container));
    let mut result = command_map.clone();
    result.insert("actor_id".into(), json!(owner_id));
    result.insert("container_id".into(), json!(container_id_text));
    result.insert("recipient_id".into(), json!(recipient_id));
    result.insert("lines".into(), Value::Array(lines));
    result.insert("target_ids".into(), strings(&unique([owner_id.clone(), recipient_id.clone()])));
    result.insert("visibility".into(), json!("party"));
    result.insert("loot_container".into(), container);
    result.insert("loot_items".into(), Value::Array(items));
    result.insert("loot_remaining".into(), Value::Array(remaining));
    if !returns.is_empty() {
        result.insert("loot_returns".into(), Value::Array(returns));
    }
    result.insert("loot_combat_action".into(), js::opt_str(combat_action));
    Ok(Value::Object(result))
}

/// `lootContainerCommandEvents(command)`: событие `LootContainerTaken`
/// проверенной команды.
pub fn loot_container_command_events(command: &Value) -> LootResult<Vec<Value>> {
    if !LOOT_CONTAINER_COMMAND_TYPES.iter().any(|kind| is_str(prop(Some(command), "command_type"), kind)) {
        return Ok(Vec::new());
    }
    let container = command.get("loot_container");
    if !js::present(container) {
        return Err(LootContainerError::type_error("Cannot read properties of undefined (reading 'id')"));
    }
    let remaining = array(command.get("loot_remaining"));
    let lines: Vec<Value> = list_or_type_error(command.get("lines"), "map")?.iter().map(|line| Value::Object(spread_of(line))).collect();
    let mut payload = Map::new();
    payload.insert("schema_version".into(), json!(LOOT_CONTAINER_TAKEN_EVENT_SCHEMA_VERSION));
    payload.insert("policy_id".into(), json!(LOOT_CONTAINERS_POLICY_ID));
    let insert_defined = |payload: &mut Map<String, Value>, key: &str, value: Option<&Value>| {
        if let Some(value) = value {
            payload.insert(key.into(), value.clone());
        }
    };
    insert_defined(&mut payload, "container_id", prop(container, "id"));
    insert_defined(&mut payload, "container_kind", prop(container, "kind"));
    insert_defined(&mut payload, "container_name", prop(container, "name"));
    insert_defined(&mut payload, "actor_id", command.get("actor_id"));
    insert_defined(&mut payload, "recipient_id", command.get("recipient_id"));
    payload.insert("lines".into(), Value::Array(lines));
    payload.insert("items".into(), nullish(command.get("loot_items"), None).cloned().unwrap_or_else(|| json!([])));
    if let Some(Value::Array(returns)) = command.get("loot_returns") {
        if !returns.is_empty() {
            payload.insert("returns".into(), Value::Array(returns.clone()));
        }
    }
    payload.insert("remaining_items".into(), Value::Array(remaining.to_vec()));
    payload.insert("remaining_count".into(), json!(remaining.len()));
    payload.insert("status_after".into(), json!(if remaining.is_empty() { "emptied" } else { "available" }));
    payload.insert("combat_action".into(), nullish(command.get("loot_combat_action"), None).cloned().unwrap_or(Value::Null));
    payload.insert("request_fingerprint".into(), nullish(command.get("request_fingerprint"), None).cloned().unwrap_or(Value::Null));
    Ok(vec![json!({
        "event_type": "LootContainerTaken",
        "event_schema_version": LOOT_CONTAINER_TAKEN_EVENT_SCHEMA_VERSION,
        "payload": Value::Object(payload),
        "target_ids": strings(&unique([js::string(command.get("actor_id")), js::string(command.get("recipient_id"))])),
        "visibility": "party",
    })])
}

// --- редьюсеры --------------------------------------------------------------------------

fn with_container(state: &Value, container: Value) -> Value {
    let id = js::s(container.get("id"));
    let mut current = loot_container_list(state);
    if let Some(slot) = current.iter_mut().find(|entry| js::s(entry.get("id")) == id) {
        *slot = container;
    } else {
        current.push(container);
    }
    normalize_loot_containers_state(Some(&json!({ "containers": current })))
}

/// `addLootedItem`: вещь ложится в сумку; уже лежащая под тем же `id` —
/// узнаётся и пропускается.
fn add_looted_item(current: Vec<Value>, incoming: &Value) -> LootResult<Vec<Value>> {
    let incoming_id = js::s(incoming.get("id"));
    if !incoming_id.is_empty() && current.iter().any(|item| js::s(prop(Some(item), "id")) == incoming_id) {
        return Ok(current);
    }
    let key = inventory_stack_key(Some(incoming));
    let index = current.iter().position(|item| !js::truthy(prop(Some(item), "equipped")) && !js::truthy(prop(Some(item), "attuned_to")) && inventory_stack_key(Some(item)) == key);
    let Some(index) = index else {
        let mut next = current;
        next.push(incoming.clone());
        return Ok(next);
    };
    let mut next = current;
    if next[index].is_null() {
        return Err(LootContainerError::null_read("quantity"));
    }
    let quantity = MAX_STOCK_QUANTITY.min(integer(prop(Some(&next[index]), "quantity"), 1) + integer(incoming.get("quantity"), 1));
    let mut merged = spread_of(&next[index]);
    merged.insert("quantity".into(), json!(quantity));
    next[index] = Value::Object(merged);
    Ok(next)
}

fn instance_quantities(items: &[Value]) -> HashMap<String, i64> {
    items.iter().map(|item| (js::s(prop(Some(item), "item_instance_id")), integer(prop(Some(item), "quantity"), 1).max(0))).collect()
}

fn same_instance_quantities(left: &[Value], right: &[Value]) -> bool {
    let first = instance_quantities(left);
    let second = instance_quantities(right);
    first.len() == second.len() && first.iter().all(|(id, quantity)| second.get(id) == Some(quantity))
}

fn state_object(state: &mut Value) -> LootResult<&mut Map<String, Value>> {
    match state {
        Value::Object(map) => Ok(map),
        _ => Err(LootContainerError::type_error("Cannot create property 'loot_containers' on non-object state")),
    }
}

/// `applyLootContainerEvent(state, event)`: применение событий контейнеров
/// на месте. Числа берутся только из payload; повтор того же события
/// добычу второй раз не выдаёт. Итог — ID героев, чьи производные поля
/// инвентаря надо обновить.
pub fn apply_loot_container_event(state: &mut Value, event: &Value) -> LootResult<Vec<String>> {
    let empty = json!({});
    let payload = prop(Some(event), "payload").filter(|payload| matches!(payload, Value::Object(_) | Value::Array(_))).unwrap_or(&empty);
    let event_type = prop(Some(event), "event_type");
    let versions = |expected: i64| js::number(prop(Some(event), "event_schema_version")) == expected as f64 && js::number(prop(Some(payload), "schema_version")) == expected as f64;
    if is_str(event_type, "LootContainerCreated") && versions(LOOT_CONTAINER_CREATED_EVENT_SCHEMA_VERSION) {
        let Some(container) = normalize_loot_container(prop(Some(payload), "container")) else { return Ok(Vec::new()) };
        let current = loot_container_for(state, container.get("id"));
        let container_items = array(container.get("items")).to_vec();
        let already_applied = current.as_ref().is_some_and(|current| same_instance_quantities(array(current.get("items")), &container_items));
        let next = with_container(state, container.clone());
        state_object(state)?.insert("loot_containers".into(), next);
        let npc_loot = plain(prop(Some(payload), "npc_loot"));
        let npc_loot_value = npc_loot.map(|map| Value::Object(map.clone()));
        let npc_loot_ref = npc_loot_value.as_ref();
        if !already_applied
            && js::number(prop(npc_loot_ref, "schema_version")) == NPC_LOOT_PAYLOAD_SCHEMA_VERSION as f64
            && is_str(prop(npc_loot_ref, "source"), NPC_LOOT_SOURCE)
            && js::is_true(prop(npc_loot_ref, "clear_inventory"))
        {
            let npc_id = text(nullish(prop(npc_loot_ref, "npc_id"), container.get("source_npc_id")), 120);
            let map = state_object(state)?;
            let inventories = prop(map.get("npc_world"), "inventories");
            if let Some(Value::Object(inventories)) = inventories {
                if !npc_id.is_empty() && inventories.contains_key(&npc_id) {
                    let mut next_inventories = inventories.clone();
                    next_inventories.shift_remove(&npc_id);
                    let mut npc_world = map.get("npc_world").filter(|world| js::present(Some(world))).map(spread_of).unwrap_or_default();
                    npc_world.insert("inventories".into(), Value::Object(next_inventories));
                    map.insert("npc_world".into(), Value::Object(npc_world));
                }
            }
        }
        // Брошенное героем оружие уходит из руки тем же событием.
        let thrown = prop(Some(payload), "thrown_weapon").filter(|thrown| matches!(thrown, Value::Object(_) | Value::Array(_)));
        if !already_applied && js::number(prop(thrown, "schema_version")) == THROWN_WEAPON_PAYLOAD_SCHEMA_VERSION as f64 {
            let owner_id = text(prop(thrown, "owner_id"), 120);
            let item_id = text(prop(thrown, "item_id"), 120);
            let mut touched = false;
            let map = state_object(state)?;
            let players = array(map.get("players")).to_vec();
            let mut next_players = Vec::with_capacity(players.len());
            for player in players {
                if actor_id_of(Some(&player)) != owner_id {
                    next_players.push(player);
                    continue;
                }
                if player.is_null() {
                    return Err(LootContainerError::null_read("inventory"));
                }
                let mut inventory = Vec::new();
                for entry in array(prop(Some(&player), "inventory")) {
                    if js::s(prop(Some(entry), "id")) != item_id {
                        inventory.push(entry.clone());
                        continue;
                    }
                    touched = true;
                    if entry.is_null() {
                        return Err(LootContainerError::null_read("quantity"));
                    }
                    let left = integer(prop(Some(entry), "quantity"), 1).max(1) - 1;
                    if left > 0 {
                        let mut copy = spread_of(entry);
                        copy.insert("quantity".into(), json!(left));
                        inventory.push(Value::Object(copy));
                    }
                }
                let mut copy = spread_of(&player);
                copy.insert("inventory".into(), Value::Array(inventory));
                next_players.push(Value::Object(copy));
            }
            map.insert("players".into(), Value::Array(next_players));
            return Ok(if touched { vec![owner_id] } else { Vec::new() });
        }
        // Вещь переезжает, а не копируется.
        let moved_ids: HashSet<String> = container_items.iter().map(|item| js::string(item.get("item_instance_id"))).collect();
        let mut source_ids: IndexSet<String> = IndexSet::new();
        let first_source = container.get("source_enemy_id").cloned().unwrap_or(Value::Null);
        for id in std::iter::once(&first_source).chain(array(container.get("source_enemy_ids"))) {
            if js::truthy(Some(id)) {
                source_ids.insert(js::string(Some(id)));
            }
        }
        let map = state_object(state)?;
        if !source_ids.is_empty() {
            if let Some(Value::Array(enemies)) = map.get_mut("enemies") {
                for enemy in enemies.iter_mut() {
                    if !source_ids.contains(&actor_id_of(Some(enemy))) {
                        continue;
                    }
                    let items: Vec<Value> = array(prop(prop(Some(enemy), "loadout"), "items"))
                        .iter()
                        .filter(|item| !moved_ids.contains(&js::string(prop(Some(item), "item_instance_id"))))
                        .cloned()
                        .collect();
                    let mut loadout = prop(Some(enemy), "loadout").filter(|loadout| js::present(Some(loadout))).map(spread_of).unwrap_or_default();
                    loadout.insert("items".into(), Value::Array(items));
                    let mut copy = spread_of(enemy);
                    copy.insert("loadout".into(), Value::Object(loadout));
                    *enemy = Value::Object(copy);
                }
            }
        }
        return Ok(Vec::new());
    }
    if is_str(event_type, "LootContainerTaken") && versions(LOOT_CONTAINER_TAKEN_EVENT_SCHEMA_VERSION) {
        let container_id = text(prop(Some(payload), "container_id"), 120);
        let Some(current) = loot_container_for(state, Some(&Value::String(container_id))) else { return Ok(Vec::new()) };
        let remaining: Vec<Value> = array(prop(Some(payload), "remaining_items")).iter().filter_map(|item| normalize_item_instance(Some(item))).collect();
        // Контейнер уже стоит на остатке этого события — обыск состоялся.
        let already_applied = same_instance_quantities(array(current.get("items")), &remaining);
        let mut patched = spread_of(&current);
        let status = if remaining.is_empty() { "emptied" } else { "available" };
        patched.insert("items".into(), Value::Array(remaining));
        patched.insert("status".into(), json!(status));
        let next_container = normalize_loot_container(Some(&Value::Object(patched))).unwrap_or(Value::Null);
        let next = with_container(state, next_container);
        let map = state_object(state)?;
        map.insert("loot_containers".into(), next);
        if already_applied {
            return Ok(Vec::new());
        }
        let recipient_id = text(prop(Some(payload), "recipient_id"), 120);
        let items: Vec<Value> = array(prop(Some(payload), "items"))
            .iter()
            .map(|item| normalize_inventory_item(Some(item), InventoryItemOptions { preserve_unknown: true, ..InventoryItemOptions::default() }))
            .collect();
        if recipient_id.is_empty() || items.is_empty() {
            return Ok(Vec::new());
        }
        let mut return_targets: HashMap<String, String> = HashMap::new();
        for entry in array(prop(Some(payload), "returns")) {
            let from = text(prop(Some(entry), "item_id"), 120);
            let to = text(prop(Some(entry), "to_item_id"), 120);
            if !from.is_empty() && !to.is_empty() {
                return_targets.insert(from, to);
            }
        }
        let mut applied = false;
        let players = array(map.get("players")).to_vec();
        let mut next_players = Vec::with_capacity(players.len());
        for player in players {
            if actor_id_of(Some(&player)) != recipient_id {
                next_players.push(player);
                continue;
            }
            applied = true;
            let mut inventory = array(prop(Some(&player), "inventory")).to_vec();
            for item in &items {
                let target = return_targets.get(&js::s(item.get("id")));
                if let Some(target) = target.filter(|target| inventory.iter().any(|entry| js::s(prop(Some(entry), "id")) == **target)) {
                    inventory = inventory
                        .into_iter()
                        .map(|entry| {
                            if js::s(prop(Some(&entry), "id")) != *target {
                                return entry;
                            }
                            let quantity = MAX_STOCK_QUANTITY.min(integer(prop(Some(&entry), "quantity"), 1) + integer(item.get("quantity"), 1));
                            let mut copy = spread_of(&entry);
                            copy.insert("quantity".into(), json!(quantity));
                            Value::Object(copy)
                        })
                        .collect();
                    continue;
                }
                inventory = add_looted_item(inventory, item)?;
            }
            let mut copy = spread_of(&player);
            copy.insert("inventory".into(), Value::Array(inventory));
            next_players.push(Value::Object(copy));
        }
        map.insert("players".into(), Value::Array(next_players));
        return Ok(if applied { vec![recipient_id] } else { Vec::new() });
    }
    Ok(Vec::new())
}

// --- проекция -----------------------------------------------------------------------------

/// `lootItemForViewer(item)`: публичная форма экземпляра — без `owner` и
/// `origin`; цена — той же политикой, что у вещи в сумке. `null` —
/// `TypeError`, как в JS.
pub fn loot_item_for_viewer(item: &Value) -> LootResult<Value> {
    if item.is_null() {
        return Err(LootContainerError::null_read("catalog_id"));
    }
    let snapshot = prop(Some(item), "snapshot").filter(|snapshot| js::truthy(Some(snapshot)));
    let catalog_id = text(prop(Some(item), "catalog_id"), 120);
    let base_price_cp = resolve_catalog_base_price_cp(Some(&json!({ "catalog_id": catalog_id }))).max(0);
    let weight = js::number(prop(snapshot, "weight"));
    let mut view = Map::new();
    view.insert("item_instance_id".into(), json!(text(prop(Some(item), "item_instance_id"), 160)));
    view.insert("catalog_id".into(), json!(catalog_id));
    let name = text(prop(snapshot, "name"), 120);
    view.insert("name".into(), json!(if name.is_empty() { "Предмет".to_string() } else { name }));
    view.insert("type".into(), json!(text(prop(snapshot, "type"), 40)));
    view.insert("rarity".into(), json!(text(prop(snapshot, "rarity"), 40)));
    view.insert("weight".into(), js::num(if weight.is_nan() || weight == 0.0 { 0.0 } else { weight.max(0.0) }));
    view.insert("quantity".into(), json!(integer(prop(Some(item), "quantity"), 1).max(1)));
    view.insert("description".into(), json!(text(prop(snapshot, "description"), 1_000)));
    view.insert("mechanics_status".into(), json!(text(prop(snapshot, "mechanics_status"), 40)));
    if base_price_cp > 0 {
        view.insert("base_price_cp".into(), json!(base_price_cp));
    }
    if js::truthy(prop(snapshot, "image")) {
        view.insert("image".into(), json!(text(prop(snapshot, "image"), 500)));
    }
    let charges = prop(Some(item), "charges");
    if js::truthy(charges) {
        view.insert("charges".into(), json!({ "current": integer(prop(charges, "current"), 0).max(0), "max": integer(prop(charges, "max"), 0).max(0) }));
    }
    if js::is_true(prop(snapshot, "requires_attunement")) {
        view.insert("requires_attunement".into(), json!(true));
    }
    Ok(Value::Object(view))
}

fn distance_feet_to(state: &Value, actor: Option<&Value>, container: &Value) -> Option<f64> {
    let actor = truthy_actor(actor)?;
    if !js::present(prop(Some(container), "x")) || !js::present(prop(Some(container), "y")) {
        return None;
    }
    let position = position_of(Some(state), &actor_id_of(Some(actor)));
    if position.0.is_null() || position.1.is_null() {
        return None;
    }
    footprint_distance_feet(Some(actor), Some(container), Some(&position_value(&position)), Some(container))
}

/// `lootContainerReachFor(state, actor, container)`: решение о досягаемости
/// вместе с числом, которым оно объясняется (`{ reachable, distance_feet }`).
/// Контейнер `null` — `TypeError`, как в JS.
pub fn loot_container_reach_for(state: &Value, actor: Option<&Value>, container: &Value) -> LootResult<Value> {
    let Some(actor) = truthy_actor(actor) else {
        return Ok(json!({ "reachable": false, "distance_feet": null }));
    };
    if container.is_null() {
        return Err(LootContainerError::null_read("x"));
    }
    Ok(json!({
        "reachable": reachable(state, actor, container),
        "distance_feet": distance_feet_to(state, Some(actor), container).map_or(Value::Null, js::num),
    }))
}

/// Параметры [`loot_container_for_viewer`] (`{ withContents, distanceFeet,
/// cellRevealed }` JS); `None` — поле не передано.
#[derive(Debug, Clone, Copy, Default)]
pub struct ContainerViewOptions<'a> {
    pub with_contents: Option<&'a Value>,
    pub distance_feet: Option<&'a Value>,
    pub cell_revealed: Option<&'a Value>,
}

/// `lootContainerForViewer(container, options)`: публичная форма контейнера;
/// содержимое — только по защищённому чтению (`withContents`).
pub fn loot_container_for_viewer(container: &Value, options: ContainerViewOptions<'_>) -> Option<Value> {
    let normalized = normalize_loot_container(Some(container))?;
    // Без расстояния (`null` по умолчанию) — без поля, а не `Number(null) = 0`.
    let distance_source = options.distance_feet.unwrap_or(&Value::Null);
    let distance_number = js::number(Some(distance_source));
    let distance = (!distance_source.is_null() && distance_number.is_finite() && distance_number >= 0.0).then(|| js::round(distance_number));
    let with_contents = options.with_contents.unwrap_or(&Value::Bool(false));
    let items = array(normalized.get("items"));
    let total: f64 = items
        .iter()
        .map(|item| {
            let weight = js::number(prop(item.get("snapshot"), "weight"));
            let weight = if weight.is_nan() { 0.0 } else { weight };
            weight.max(0.0) * integer(item.get("quantity"), 1).max(1) as f64
        })
        .sum();
    let mut view = Map::new();
    view.insert("schema_version".into(), json!(LOOT_CONTAINERS_SCHEMA_VERSION));
    for key in ["id", "kind", "name", "status", "source_enemy_id"] {
        view.insert(key.into(), normalized[key].clone());
    }
    if let Some(npc_id) = normalized.get("source_npc_id") {
        view.insert("source_npc_id".into(), npc_id.clone());
    }
    view.insert("x".into(), normalized["x"].clone());
    view.insert("y".into(), normalized["y"].clone());
    view.insert("cell_revealed".into(), json!(!js::is_false(options.cell_revealed)));
    view.insert("item_count".into(), json!(items.len()));
    view.insert("total_weight".into(), js::num(js::round(total * 100.0) / 100.0));
    view.insert("can_inspect".into(), json!(js::is_true(Some(with_contents))));
    if let Some(distance) = distance {
        view.insert("distance_feet".into(), js::num(distance));
    }
    if js::truthy(Some(with_contents)) {
        // Экземпляр после нормализации — объект, `TypeError` здесь не бывает.
        view.insert("items".into(), Value::Array(items.iter().filter_map(|item| loot_item_for_viewer(item).ok()).collect()));
    }
    Some(Value::Object(view))
}

fn revealed_cell_keys(state: &Value) -> Option<HashSet<String>> {
    let cells = array(prop(prop(Some(state), "scene"), "cells"));
    if cells.is_empty() {
        return None;
    }
    Some(
        cells
            .iter()
            .filter(|cell| js::is_true(prop(Some(cell), "revealed")))
            .map(|cell| format!("{},{}", integer(prop(Some(cell), "x"), -1), integer(prop(Some(cell), "y"), -1)))
            .collect(),
    )
}

/// `lootContainersForViewer(state, { actorId, isAdmin })`: контейнеры для
/// стола. Ведущий видит содержимое всегда; игрок — того контейнера, до
/// которого дотягивается его герой. `actor_id`: `None` — не передан (`''`).
pub fn loot_containers_for_viewer(state: &Value, actor_id: Option<&Value>, is_admin: Option<&Value>) -> LootResult<Value> {
    let empty_id = Value::String(String::new());
    let actor_id = actor_id.unwrap_or(&empty_id);
    let actor = truthy_actor(player_actor(state, &js::s(Some(actor_id))));
    let is_admin = js::is_true(is_admin);
    let combat = prop(prop(Some(state), "mechanics"), "combat");
    let combat_active = js::is_true(prop(combat, "active"));
    let containers = loot_containers_in_scene(state, false)?;
    let revealed = if !is_admin && containers.iter().any(|container| js::present(container.get("x")) && js::present(container.get("y"))) { revealed_cell_keys(state) } else { None };
    let action_spent = combat_active && actor.is_some() && js::is_false(prop(prop(prop(combat, "action_economy"), &js::string(Some(actor_id))), "action"));
    let mut cards = Vec::new();
    for container in &containers {
        let distance = distance_feet_to(state, actor, container).map_or(Value::Null, js::num);
        let with_contents = Value::Bool(is_admin || actor.is_some_and(|actor| reachable(state, actor, container)));
        let x = container.get("x").filter(|x| js::present(Some(x)));
        let y = container.get("y").filter(|y| js::present(Some(y)));
        let cell_revealed = match (&revealed, x, y) {
            (Some(revealed), Some(x), Some(y)) => revealed.contains(&format!("{},{}", js::s(Some(x)), js::s(Some(y)))),
            _ => true,
        };
        let cell_revealed = Value::Bool(cell_revealed);
        let Some(card) = loot_container_for_viewer(container, ContainerViewOptions { with_contents: Some(&with_contents), distance_feet: Some(&distance), cell_revealed: Some(&cell_revealed) }) else { continue };
        let cost = if combat_active && actor.is_some() { loot_combat_action_for(state, Some(actor_id), loot_container_for(state, card.get("id")).as_ref()) } else { None };
        cards.push(match cost {
            Some(cost) => js::spread(&card, json!({ "action_cost": cost })),
            None => card,
        });
    }
    Ok(json!({
        "schema_version": LOOT_CONTAINERS_SCHEMA_VERSION,
        "reach_feet": LOOT_CONTAINER_REACH_FEET,
        "action_cost": if combat_active { json!("action") } else { Value::Null },
        "action_spent": action_spent,
        "containers": cards,
    }))
}

//! Перенос `server/npc-positioning.mjs` — NPC на карте сцены.
//!
//! Мир NPC (`state.npc_world`) — посты жителей по локациям, их живучесть,
//! стойки, вещи в руках и авторские боевые профили. Модуль выбирает пост у
//! подходящего предмета (`planSceneNpcPlacementEvents`), проверяет команды
//! `PlaceNpc`/`MoveNpc`/`HarmNpc`, строит события урона мирному NPC с паникой
//! свидетелей и репутацией фракций, переносит боевую копию авторского NPC
//! обратно в пост мира и применяет события к срезу (`applyNpcWorldEvent`).
//! Проекция игроку — `sceneNpcsForViewer`: без ОЗ и закрытого профиля.
//!
//! Режим удержания (`withRetentionMode`, `sk_society::retention_context`)
//! читается нормализатором: legacy-replay включает прежние пределы.
//!
//! Чтение `obj[id]` повторяет JS и для ключей прототипа (`constructor`,
//! `__proto__`): у живучести такой NPC — унаследованная функция без полей, и в
//! Rust её заменяет пустой объект `{}` (чтения полей дают то же `undefined`).

use std::collections::HashSet;

use serde_json::{json, Map, Value};
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::{js, re, text as jstext, MechanicsSupport, RuleError};
use sk_economy::merchant_economy::{inventory_stack_key, normalize_inventory_item, InventoryItemOptions, MAX_STOCK_QUANTITY};
use sk_geometry::actor_footprint::{footprint_cells_for, footprint_distance_feet, footprint_metadata_for_size, normalize_footprint_metadata};
use sk_heroes::authored_npc::{authored_npc_combatant, safe_authored_npc_mechanics};
use sk_map_core::map_quality::platform_cells;
use sk_scene_base::scene_requirements::{normalize_scene_posts, requirement_assets, requirement_terrain};
use sk_society::reputation_policy::faction_ids_for_npc;
use sk_society::retention_context::retention_mode;
use sk_tactical::tactical_map::{cell_at, deserialize_tactical_map, movement_step_blocked, TacticalMap, TacticalProp};

use crate::common::{
    array, coalesce, digest, get, integer, integer_or, is_safe_f64, iterate, js_max, member, number_key, object_entries, opt_integer, spread, string,
    text, text_str, utf16_cmp, visibility_of, assign_key, comparable, Member,
};

/// `NPC_WORLD_POLICY_ID`.
pub const NPC_WORLD_POLICY_ID: &str = "skazanie:npc-world-v1";
/// `NPC_WORLD_COMMAND_TYPES` — команды мира NPC.
pub const NPC_WORLD_COMMAND_TYPES: [&str; 3] = ["PlaceNpc", "MoveNpc", "HarmNpc"];
/// `MAX_NPC_INVENTORY_OWNERS` — предел владельцев вещей в legacy-replay.
pub const MAX_NPC_INVENTORY_OWNERS: usize = 500;
/// `MAX_NPC_INVENTORY_ITEMS` — предел вещей одного NPC.
pub const MAX_NPC_INVENTORY_ITEMS: usize = 100;

const STANCES: [&str; 6] = ["neutral", "guarded", "frightened", "hostile", "fleeing", "dead"];
const MAX_PLACEMENTS: usize = 5_000;
const MAX_VISIBLE_NPCS: usize = 100;
const MAX_PROPAGATED_NPCS: usize = 24;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// `NpcWorldValidationError` — отказ команды мира NPC.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NpcWorldValidationError {
    pub message: String,
    pub code: String,
}

impl NpcWorldValidationError {
    /// Имя класса ошибки JS.
    pub const NAME: &'static str = "NpcWorldValidationError";

    pub fn new(message: impl Into<String>, code: impl Into<String>) -> Self {
        Self { message: message.into(), code: code.into() }
    }
}

impl std::fmt::Display for NpcWorldValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for NpcWorldValidationError {}

impl From<NpcWorldValidationError> for RuleError {
    fn from(error: NpcWorldValidationError) -> Self {
        RuleError::new(error.code, error.message)
    }
}

fn fail<T>(message: &str, code: &str) -> Result<T, NpcWorldValidationError> {
    Err(NpcWorldValidationError::new(message, code))
}

/// NPC сцены вместе с его постом (`{ npc, placement }` в JS).
#[derive(Debug, Clone, PartialEq)]
pub struct NpcTarget {
    pub npc: Value,
    pub placement: Value,
}

impl NpcTarget {
    /// `{ npc, placement }`.
    pub fn to_json(&self) -> Value {
        json!({ "npc": self.npc, "placement": self.placement })
    }
}

/// Текущее состояние сохраняет принятые записи NPC; legacy replay включает
/// старые пределы. `options` — `{ isLegacy }` или `{ retention }`; без них —
/// режим из `with_retention_mode`.
fn legacy_retention(options: &Value) -> bool {
    if let Value::Object(context) = options {
        if context.contains_key("isLegacy") {
            return js::is_true(context.get("isLegacy"));
        }
        if context.contains_key("retention") {
            return context.get("retention").and_then(Value::as_str) == Some("legacy");
        }
    }
    retention_mode() == "legacy"
}

/// `stableId(...parts)`: первые 24 знака sha256.
fn stable_id(parts: &[String]) -> String {
    digest(parts)[..24].to_string()
}

/// `String(part ?? '')` для частей `stableId`.
fn part(value: Option<&Value>) -> String {
    js::s(value)
}

fn cell_key(x: i64, y: i64) -> String {
    format!("{x},{y}")
}

/// `keyOf(position)`: `` `${Number(position?.x)},${Number(position?.y)}` ``.
fn key_of(position: Option<&Value>) -> String {
    format!("{},{}", number_key(js::number(get(position, "x"))), number_key(js::number(get(position, "y"))))
}

/// Вставить поле или убрать его, если в JS там `undefined`.
fn set_or_remove(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    match value {
        Some(value) => {
            map.insert(key.to_string(), value.clone());
        }
        None => {
            map.shift_remove(key);
        }
    }
}

fn safe_placement(value: Option<&Value>) -> Option<Value> {
    let npc_id = text(get(value, "npc_id"), 120);
    let location_id = text(get(value, "location_id"), 180);
    let x = opt_integer(get(value, "x"));
    let y = opt_integer(get(value, "y"));
    let (Some(x), Some(y)) = (x, y) else { return None };
    if npc_id.is_empty() || location_id.is_empty() {
        return None;
    }
    let mut placement = Map::new();
    placement.insert("npc_id".into(), string(npc_id));
    placement.insert("location_id".into(), string(location_id));
    placement.insert("x".into(), Value::from(x));
    placement.insert("y".into(), Value::from(y));
    if let Some(footprint) = normalize_footprint_metadata(get(value, "footprint")) {
        placement.insert("footprint".into(), footprint.to_value());
    }
    placement.insert("anchor_prop_id".into(), string(text(get(value, "anchor_prop_id"), 120)));
    let reason = text(get(value, "placement_reason"), 80);
    placement.insert("placement_reason".into(), string(if reason.is_empty() { "deterministic-post".to_string() } else { reason }));
    placement.insert("policy_id".into(), string(NPC_WORLD_POLICY_ID));
    placement.insert("source_event_id".into(), string(text(get(value, "source_event_id"), 120)));
    Some(Value::Object(placement))
}

fn vital_value(hp: Option<&Value>, max_hp: Option<&Value>, alive: Option<&Value>) -> Value {
    let maximum = 1.max(500.min(integer(max_hp, 4)));
    let hp = 0.max(maximum.min(integer(hp, maximum)));
    // Явный `alive: true` нужен для нокаута: такой NPC уже не действует, но
    // ещё не погиб и может вернуться в историю после восстановления.
    let alive = js::is_true(alive) || (!js::is_false(alive) && hp > 0);
    json!({ "hp": hp, "max_hp": maximum, "alive": alive })
}

fn safe_vital(value: Option<&Value>) -> Value {
    vital_value(get(value, "hp"), get(value, "max_hp"), get(value, "alive"))
}

fn stance_value(stance: Option<&Value>, reason: Option<&Value>, source_event_id: Option<&Value>, depth: Option<&Value>) -> Value {
    let raw = js::string(stance);
    let stance = if STANCES.contains(&raw.as_str()) { raw } else { "neutral".to_string() };
    json!({
        "stance": stance,
        "reason": text(reason, 120),
        "source_event_id": text(source_event_id, 120),
        "propagation_depth": 0.max(1.min(integer(depth, 0))),
    })
}

fn safe_stance(value: Option<&Value>) -> Value {
    stance_value(get(value, "stance"), get(value, "reason"), get(value, "source_event_id"), get(value, "propagation_depth"))
}

fn inventory_options() -> InventoryItemOptions<'static> {
    InventoryItemOptions { preserve_unknown: true, ..InventoryItemOptions::default() }
}

fn safe_npc_inventory(value: Option<&Value>, legacy: bool) -> Vec<Value> {
    let mut inventory: Vec<Value> = Vec::new();
    let mut stack_indexes: IndexMap<String, usize> = IndexMap::new();
    for raw in array(value) {
        if !raw.is_object() {
            continue;
        }
        let mut source = spread(Some(raw));
        source.insert("equipped".into(), Value::Bool(false));
        source.insert("attuned_to".into(), Value::Null);
        let item = normalize_inventory_item(Some(&Value::Object(source)), inventory_options());
        let stack_key = inventory_stack_key(Some(&item));
        if let Some(&index) = stack_indexes.get(&stack_key) {
            let merged = MAX_STOCK_QUANTITY.min(integer(inventory[index].get("quantity"), 1) + integer(item.get("quantity"), 1));
            if let Some(map) = inventory[index].as_object_mut() {
                map.insert("quantity".into(), Value::from(merged));
            }
            continue;
        }
        if legacy && inventory.len() >= MAX_NPC_INVENTORY_ITEMS {
            continue;
        }
        stack_indexes.insert(stack_key, inventory.len());
        inventory.push(item);
    }
    inventory
}

fn limited<T>(entries: Vec<T>, legacy: bool) -> Vec<T> {
    if legacy {
        entries.into_iter().take(500).collect()
    } else {
        entries
    }
}

/// `normalizeNpcWorldState(input, options)`: срез мира NPC схемы 3.
///
/// Записи без идентификатора отбрасываются, посты одной локации не
/// дублируются, живучесть и стойки зажимаются, вещи складываются в стопки,
/// профиль авторского NPC проверяется заново. В legacy-replay действуют
/// прежние пределы (500 записей, 5000 постов, 100 вещей).
pub fn normalize_npc_world_state(input: Option<&Value>, options: &Value) -> Value {
    let legacy = legacy_retention(options);
    let source = input.filter(|value| value.is_object());
    let mut placements: Vec<Value> = Vec::new();
    let mut placement_keys: HashSet<String> = HashSet::new();
    for raw in array(get(source, "placements")) {
        let Some(placement) = safe_placement(Some(raw)) else { continue };
        let key = format!("{}\0{}", js::s(placement.get("location_id")), js::s(placement.get("npc_id")));
        if !placement_keys.insert(key) {
            continue;
        }
        placements.push(placement);
    }
    let mut vitals = Map::new();
    for (npc_id, value) in limited(object_entries(get(source, "vitals")), legacy) {
        let id = text_str(&npc_id, 120);
        if !id.is_empty() {
            vitals.insert(id, safe_vital(Some(&value)));
        }
    }
    let mut stances = Map::new();
    for (npc_id, value) in limited(object_entries(get(source, "stances")), legacy) {
        let id = text_str(&npc_id, 120);
        if !id.is_empty() {
            stances.insert(id, safe_stance(Some(&value)));
        }
    }
    let mut inventories = Map::new();
    for (raw_npc_id, value) in object_entries(get(source, "inventories")) {
        if legacy && inventories.len() >= MAX_NPC_INVENTORY_OWNERS {
            break;
        }
        let id = text_str(&raw_npc_id, 120);
        if id.is_empty() || inventories.contains_key(&id) {
            continue;
        }
        let inventory = safe_npc_inventory(Some(&value), legacy);
        if inventory.is_empty() {
            continue;
        }
        inventories.insert(id, Value::Array(inventory));
    }
    let mut profiles = Map::new();
    for (npc_id, value) in limited(object_entries(get(source, "profiles")), legacy) {
        let id = text_str(&npc_id, 120);
        if id.is_empty() {
            continue;
        }
        if let Some(profile) = safe_authored_npc_mechanics(Some(&value)) {
            profiles.insert(id, profile);
        } else {
            // `Object.fromEntries` положил бы и пустой профиль, но фильтр
            // `npcId && profile` убирает пару целиком — прежний профиль того же
            // ключа остаётся.
        }
    }
    let placements = if legacy && placements.len() > MAX_PLACEMENTS { placements.split_off(placements.len() - MAX_PLACEMENTS) } else { placements };
    let mut world = Map::new();
    world.insert("schema_version".into(), Value::from(3));
    world.insert("placements".into(), Value::Array(placements));
    world.insert("vitals".into(), Value::Object(vitals));
    world.insert("stances".into(), Value::Object(stances));
    world.insert("inventories".into(), Value::Object(inventories));
    world.insert("profiles".into(), Value::Object(profiles));
    Value::Object(world)
}

/// `normalizeNpcWorldStateLegacy(input)`: ограниченный reducer мира NPC для
/// legacy-состояния коммита.
pub fn normalize_npc_world_state_legacy(input: Option<&Value>) -> Value {
    normalize_npc_world_state(input, &json!({ "isLegacy": true }))
}

fn world_of(state: &Value) -> Value {
    normalize_npc_world_state(get(Some(state), "npc_world"), &Value::Null)
}

fn world_placements(world: &Value) -> &[Value] {
    array(world.get("placements"))
}

/// `sceneLocationId(state)`: явный `location_id` сцены, иначе `locationId`
/// карты, иначе название места.
pub fn scene_location_id(state: &Value) -> String {
    let scene = get(Some(state), "scene");
    let explicit = text(coalesce(get(scene, "location_id"), get(scene, "locationId")), 180);
    if !explicit.is_empty() {
        return explicit;
    }
    let from_map = text(get(get(scene, "map"), "locationId"), 180);
    if !from_map.is_empty() {
        return from_map;
    }
    text(coalesce(get(scene, "location"), get(scene, "title")), 180)
}

fn scene_place_name(state: &Value) -> Option<&Value> {
    let scene = get(Some(state), "scene");
    coalesce(get(scene, "location"), get(scene, "title"))
}

fn npc_location_matches_current_scene(npc: Option<&Value>, state: &Value) -> bool {
    let current_id = jstext::lower(&text_str(&scene_location_id(state), 180));
    let current_name = comparable(scene_place_name(state));
    let location_id = comparable(coalesce(get(npc, "location_id"), get(npc, "locationId")));
    let location = comparable(get(npc, "location"));
    if !location_id.is_empty() && !current_id.is_empty() {
        return location_id == current_id;
    }
    if location.is_empty() {
        return false;
    }
    location == current_id || location == current_name
}

fn npc_at_current_location(npc: Option<&Value>, state: &Value) -> bool {
    !js::is_false(get(npc, "available")) && npc_location_matches_current_scene(npc, state)
}

fn social_npcs(state: &Value) -> &[Value] {
    array(get(get(Some(state), "social"), "npcs"))
}

/// `presentSceneNpcs` с готовым словарём живучести (`world.vitals`) и, при
/// необходимости, своим списком NPC вместо `state.social.npcs`.
fn present_in(state: &Value, vitals: Option<&Value>, npcs: &[Value]) -> Vec<Value> {
    let mut present: Vec<Value> = npcs
        .iter()
        .filter(|npc| js::truthy(get(Some(npc), "id")) && js::truthy(get(Some(npc), "name")) && npc_at_current_location(Some(npc), state))
        .filter(|npc| {
            let vital = member(vitals, &js::s(get(Some(npc), "id")));
            let hp = vital.field("hp");
            let hp = if hp.nullish() { 1.0 } else { js::number(hp.own()) };
            !js::is_false(vital.field("alive").own()) && hp > 0.0
        })
        .cloned()
        .collect();
    present.sort_by(|left, right| jstext::locale_compare(&js::s(get(Some(left), "id")), &js::s(get(Some(right), "id"))));
    present.truncate(MAX_VISIBLE_NPCS);
    present
}

/// `presentSceneNpcs(state)`: живые и доступные NPC текущей сцены по
/// идентификатору, не больше ста.
pub fn present_scene_npcs(state: &Value) -> Vec<Value> {
    let world = world_of(state);
    present_in(state, world.get("vitals"), social_npcs(state))
}

fn placement_in<'w>(world: &'w Value, npc_id: &str, location_id: &str) -> Option<&'w Value> {
    world_placements(world)
        .iter()
        .find(|placement| placement.get("npc_id").and_then(Value::as_str) == Some(npc_id) && placement.get("location_id").and_then(Value::as_str) == Some(location_id))
}

/// `npcPlacementFor(state, npcId, locationId)`: пост NPC в локации; без
/// `location_id` (`None`, `undefined` в JS) — в текущей.
pub fn npc_placement_for(state: &Value, npc_id: &Value, location_id: Option<&Value>) -> Option<Value> {
    let expected_npc = js::s(Some(npc_id));
    let expected_location = match location_id {
        None => scene_location_id(state),
        Some(value) => js::s(Some(value)),
    };
    placement_in(&world_of(state), &expected_npc, &expected_location).cloned()
}

fn vital_in(state: &Value, world: &Value, npc_id: &str) -> Value {
    match member(world.get("vitals"), npc_id) {
        Member::Own(persisted) if js::truthy(Some(persisted)) => return persisted.clone(),
        // Унаследованная функция: истинна, полей нет.
        Member::Function | Member::Prototype => return json!({}),
        _ => {}
    }
    if let Some(authored) = member(world.get("profiles"), npc_id).own().filter(|value| js::truthy(Some(value))) {
        let mut vital = Map::new();
        if let Some(hp) = authored.get("hp") {
            vital.insert("hp".into(), hp.clone());
            vital.insert("max_hp".into(), hp.clone());
        }
        vital.insert("alive".into(), Value::Bool(js::number(authored.get("hp")) > 0.0));
        return Value::Object(vital);
    }
    let npc = social_npcs(state).iter().find(|candidate| js::string(get(Some(candidate), "id")) == npc_id);
    initial_npc_vital(npc)
}

/// `npcVitalFor(state, npcId)`: сохранённая живучесть, иначе ОЗ авторского
/// профиля, иначе начальная по роли.
///
/// Для идентификатора — ключа прототипа (`constructor`) JS возвращает
/// унаследованную функцию; здесь — пустой объект с тем же поведением полей.
pub fn npc_vital_for(state: &Value, npc_id: &Value) -> Value {
    let world = world_of(state);
    vital_in(state, &world, &js::s(Some(npc_id)))
}

fn mechanics_in(world: &Value, npc_id: &str) -> Option<Value> {
    match member(world.get("profiles"), npc_id) {
        Member::Own(profile) if !profile.is_null() => Some(profile.clone()),
        // `structuredClone(Object.prototype)` — пустой объект.
        Member::Prototype => Some(json!({})),
        // `structuredClone` функции в JS бросает `DataCloneError`; здесь
        // профиля просто нет (см. отчёт переноса).
        _ => None,
    }
}

/// `npcMechanicsFor(state, npcId)`: копия авторского боевого профиля или `None`.
pub fn npc_mechanics_for(state: &Value, npc_id: &Value) -> Option<Value> {
    mechanics_in(&world_of(state), &js::s(Some(npc_id)))
}

/// `npcCombatActorFor(state, npcId)`: один боевой снимок NPC из его
/// долговременного профиля.
///
/// Авторский NPC не получает второй лист при входе в бой: социальная запись,
/// сохранённый профиль, текущая живучесть и пост описывают одного человека.
/// Для обычного NPC без профиля остаётся безопасный снимок — пригодный для
/// геометрии и мягких серверных последствий, но без авторской механики.
pub fn npc_combat_actor_for(state: &Value, npc_id: &Value) -> Option<Value> {
    let id = text(Some(npc_id), 120);
    let npc = social_npcs(state).iter().find(|candidate| js::s(get(Some(candidate), "id")) == id)?;
    if !js::truthy(Some(npc)) {
        return None;
    }
    let world = world_of(state);
    let vital = vital_in(state, &world, &id);
    let placement = placement_in(&world, &id, &scene_location_id(state)).cloned();
    let mechanics = mechanics_in(&world, &id);
    if let (Some(mechanics), Some(placement)) = (mechanics.as_ref(), placement.as_ref()) {
        // Повреждённый профиль не превращает обычную социальную запись в
        // недоступную кампанию: при отказе ниже остаётся запасной снимок.
        if let Ok(Value::Object(mut actor)) = authored_npc_combatant(Some(npc), Some(mechanics), Some(placement)) {
            set_or_remove(&mut actor, "hp", vital.get("hp"));
            set_or_remove(&mut actor, "maxHp", vital.get("max_hp"));
            set_or_remove(&mut actor, "alive", vital.get("alive"));
            return Some(Value::Object(actor));
        }
    }
    let mut actor = spread(Some(npc));
    actor.insert("id".into(), string(id));
    actor.insert("name".into(), string(text(get(Some(npc), "name"), 160)));
    set_or_remove(&mut actor, "hp", vital.get("hp"));
    set_or_remove(&mut actor, "maxHp", vital.get("max_hp"));
    set_or_remove(&mut actor, "alive", vital.get("alive"));
    if let Some(placement) = placement {
        actor.insert("x".into(), placement.get("x").cloned().unwrap_or(Value::Null));
        actor.insert("y".into(), placement.get("y").cloned().unwrap_or(Value::Null));
        if let Some(footprint) = placement.get("footprint").filter(|value| js::truthy(Some(value))) {
            actor.insert("footprint".into(), footprint.clone());
        }
    }
    Some(Value::Object(actor))
}

/// `npcInteractionTargetForViewer(state, npcId)`: узкий public-presence gate
/// для действий игрока с NPC. Он намеренно не раскрывает доступность и
/// живучесть: различать их вызывающий вправе только после того, как публичный
/// профиль и пост текущей сцены уже доказаны.
pub fn npc_interaction_target_for_viewer(state: &Value, npc_id: &Value) -> Option<NpcTarget> {
    let expected = js::s(Some(npc_id));
    let npc = social_npcs(state).iter().find(|candidate| js::string(get(Some(candidate), "id")) == expected)?;
    if !js::truthy(Some(npc)) {
        return None;
    }
    let hidden = get(Some(npc), "visibility").and_then(Value::as_str) == Some("gm_only") && !js::is_true(get(Some(npc), "reveal_on_presence"));
    if hidden || !npc_location_matches_current_scene(Some(npc), state) {
        return None;
    }
    let world = world_of(state);
    let placement = placement_in(&world, &expected, &scene_location_id(state))?;
    Some(NpcTarget { npc: npc.clone(), placement: placement.clone() })
}

fn role_text(npc: Option<&Value>) -> String {
    let tags: Vec<String> = array(get(npc, "tags")).iter().map(|tag| js::s(Some(tag))).collect();
    jstext::lower(&format!("{} {}", text(get(npc, "role"), 160), tags.join(" ")))
}

/// `initialNpcVital(npc)`: начальные ОЗ по роли и тегам — ветеран 18, страж
/// 11, лекарь и ремесленник 7, прочие 4.
pub fn initial_npc_vital(npc: Option<&Value>) -> Value {
    let role = role_text(npc);
    let maximum = if jstext::test(re!(r"ветеран|veteran|рыцар|knight|телохран|bodyguard", "iu"), &role) {
        18
    } else if jstext::test(re!(r"страж|guard|воин|soldier|охотник|hunter", "iu"), &role) {
        11
    } else if jstext::test(re!(r"лекар|healer|жрец|priest|кузнец|blacksmith", "iu"), &role) {
        7
    } else {
        4
    };
    json!({ "hp": maximum, "max_hp": maximum, "alive": true })
}

fn scene_map(state: &Value) -> Option<TacticalMap> {
    let map = get(get(Some(state), "scene"), "map")?;
    if !js::truthy(Some(map)) {
        return None;
    }
    deserialize_tactical_map(map).ok()
}

fn prop_cells(prop: &TacticalProp) -> Vec<(i64, i64)> {
    if !prop.footprint.is_empty() {
        // Клетки площади предмета карта уже зажала в целые.
        return prop.footprint.iter().map(|cell| (cell.x, cell.y)).collect();
    }
    let (x, y) = (prop.x.floor(), prop.y.floor());
    if is_safe_f64(x) && is_safe_f64(y) {
        vec![(x as i64, y as i64)]
    } else {
        Vec::new()
    }
}

fn prop_occupied_cells(map: &TacticalMap) -> HashSet<String> {
    map.props.iter().flat_map(prop_cells).map(|(x, y)| cell_key(x, y)).collect()
}

/// Сторона квадратной площади по метадате (`footprintSizeFor({ footprint })`).
fn footprint_side(footprint: Option<&Value>) -> i64 {
    normalize_footprint_metadata(footprint).map_or(1, |metadata| metadata.size)
}

/// `footprintCellsFor({ footprint }, { x, y })` для безопасных целых: сложение
/// в числах JS, как в `actor-footprint`.
fn square_cells(footprint: Option<&Value>, x: i64, y: i64) -> Vec<(i64, i64)> {
    let side = footprint_side(footprint);
    let mut cells = Vec::with_capacity((side * side) as usize);
    for dy in 0..side {
        for dx in 0..side {
            cells.push(((x as f64 + dx as f64) as i64, (y as f64 + dy as f64) as i64));
        }
    }
    cells
}

/// Клетки площади на месте записи с `x`/`y` (пост, кандидат).
fn placement_cells(footprint: Option<&Value>, anchor: &Value) -> Vec<String> {
    footprint_cells_for(Some(&json!({ "footprint": footprint.cloned().unwrap_or(Value::Null) })), Some(anchor)).into_iter().map(|cell| cell.key()).collect()
}

fn actor_occupied_cells(state: &Value) -> IndexSet<String> {
    let mut occupied = IndexSet::new();
    let positions = get(get(Some(state), "mechanics"), "positions");
    let mut actors = iterate(get(Some(state), "players"));
    actors.extend(iterate(get(Some(state), "enemies")));
    actors.extend(iterate(get(Some(state), "actors")));
    for actor in &actors {
        if js::is_false(get(Some(actor), "alive")) || js::number(get(Some(actor), "hp")) == 0.0 {
            continue;
        }
        let id = js::s(coalesce(get(Some(actor), "id"), get(Some(actor), "actor_id")));
        let position = match member(positions, &id) {
            Member::Own(found) if !found.is_null() => Some(found),
            Member::Function | Member::Prototype => None,
            _ => Some(actor),
        };
        let x = js::number(get(position, "x"));
        let y = js::number(get(position, "y"));
        if is_safe_f64(x) && is_safe_f64(y) {
            for cell in footprint_cells_for(Some(actor), Some(&json!({ "x": x as i64, "y": y as i64 }))) {
                occupied.insert(cell.key());
            }
        }
    }
    for entity in iterate(get(Some(state), "entities")) {
        if !["creature", "npc", "enemy"].contains(&js::string(get(Some(&entity), "kind")).as_str()) {
            continue;
        }
        let x = js::number(get(Some(&entity), "x"));
        let y = js::number(get(Some(&entity), "y"));
        if is_safe_f64(x) && is_safe_f64(y) {
            for cell in footprint_cells_for(Some(&entity), Some(&json!({ "x": x as i64, "y": y as i64 }))) {
                occupied.insert(cell.key());
            }
        }
    }
    occupied
}

fn role_assets(npc: &Value) -> &'static [&'static str] {
    let role = role_text(Some(npc));
    let matches = |pattern: &sk_core::fancy_regex::Regex| jstext::test(pattern, &role);
    if matches(re!(r"корол|правител|king|ruler|marshal|archivist|messenger", "iu")) {
        return &["table_royal", "table_long", "table_small", "table_round", "bookshelf"];
    }
    if matches(re!(r"торгов|merchant|трактир|innkeep|бармен|barkeep", "iu")) {
        return &["bar_counter", "table_long", "table_round", "stall", "counter"];
    }
    if matches(re!(r"жрец|priest|свящ|cleric", "iu")) {
        return &["altar", "shrine", "candle", "fireplace"];
    }
    if matches(re!(r"лекар|healer|травник|herbal", "iu")) {
        return &["table_long", "fireplace", "campfire", "shelf"];
    }
    if matches(re!(r"кузнец|blacksmith|ремесл|artisan", "iu")) {
        return &["forge", "anvil", "workbench", "fireplace"];
    }
    if matches(re!(r"страж|guard|часов|watch", "iu")) {
        return &["signpost", "hitching_post", "gate", "door", "campfire"];
    }
    if matches(re!(r"фермер|farmer|конюх|stable", "iu")) {
        return &["well", "hitching_post", "cart", "hay"];
    }
    &["table_round", "table_long", "table_small", "well", "signpost", "campfire", "fireplace"]
}

/// Пост из программы сцены (`scene.map_requirements.posts`) точнее догадки по
/// роли: «хранитель записей стоит у запертого ящика» — значит, у ящика.
fn preferred_assets(npc: &Value) -> Vec<String> {
    let post: Vec<String> = array(npc.get("post_assets")).iter().map(|asset| js::string(Some(asset))).collect();
    let mut preferred = post.clone();
    preferred.extend(role_assets(npc).iter().filter(|asset| !post.iter().any(|known| known == *asset)).map(|asset| asset.to_string()));
    preferred
}

fn asset_rank(preferred: &[String], asset_id: &str) -> usize {
    preferred.iter().position(|asset| asset_id.contains(asset.as_str())).unwrap_or(preferred.len())
}

fn suitable_props<'m>(map: &'m TacticalMap, preferred: &[String]) -> Vec<&'m TacticalProp> {
    let mut props: Vec<&TacticalProp> = map.props.iter().collect();
    props.sort_by(|left, right| asset_rank(preferred, &left.asset_id).cmp(&asset_rank(preferred, &right.asset_id)).then_with(|| jstext::locale_compare(&left.id, &right.id)));
    props
}

fn cell_allowed(map: &TacticalMap, x: f64, y: f64, occupied: &IndexSet<String>, prop_occupied: &HashSet<String>, footprint: Option<&Value>) -> bool {
    if !is_safe_f64(x) || !is_safe_f64(y) {
        return false;
    }
    let cells = square_cells(footprint, x as i64, y as i64);
    let blocked = cells.iter().any(|&(cx, cy)| {
        let key = cell_key(cx, cy);
        let cell = cell_at(map, cx, cy);
        !cell.as_ref().is_some_and(|cell| cell.passable) || !cell.as_ref().is_some_and(|cell| cell.revealed) || occupied.contains(&key) || prop_occupied.contains(&key)
    });
    if cells.is_empty() || blocked {
        return false;
    }
    for &(cx, cy) in &cells {
        for (dx, dy) in [(1, 0), (0, 1)] {
            let next = (cx + dx, cy + dy);
            if !cells.contains(&next) {
                continue;
            }
            // Соседние клетки площади: ребро между ними всегда есть, отказа нет.
            if movement_step_blocked(map, cx, cy, next.0, next.1).unwrap_or(false) {
                return false;
            }
        }
    }
    true
}

/// `placementCellAllowed(map, position, …)`: `Number(position?.x)`.
fn position_allowed(map: &TacticalMap, position: Option<&Value>, occupied: &IndexSet<String>, prop_occupied: &HashSet<String>, footprint: Option<&Value>) -> bool {
    cell_allowed(map, js::number(get(position, "x")), js::number(get(position, "y")), occupied, prop_occupied, footprint)
}

fn spawn_footprint_in(world: &Value, npc_id: &str) -> Option<Value> {
    let size = member(world.get("profiles"), npc_id).field("size");
    if !size.truthy() {
        return None;
    }
    let footprint = footprint_metadata_for_size(size.own());
    (footprint.size > 1).then(|| footprint.to_value())
}

struct Candidate {
    x: i64,
    y: i64,
    anchor_prop_id: String,
    score: (u8, f64, u8, f64, String),
}

fn tag_suffix(npc: &Value, prefix: &str) -> Option<String> {
    let tag = array(npc.get("tags")).iter().find(|tag| js::string(Some(tag)).starts_with(prefix))?;
    // `tag.slice(n)` у строки; у массива это пустой массив, ни с одним
    // идентификатором зоны или предмета он не совпадает.
    tag.as_str().map(|tag| jstext::slice(tag, prefix.chars().count() as i64, None))
}

fn candidate_cells(map: &TacticalMap, npc: &Value, occupied: &IndexSet<String>, prop_occupied: &HashSet<String>, footprint: Option<&Value>) -> Vec<Candidate> {
    let preferred = preferred_assets(npc);
    let post = tag_suffix(npc, "post:");
    let assigned_zone = post.as_ref().and_then(|post| map.zones.iter().find(|zone| &zone.id == post));
    let anchor_id = tag_suffix(npc, "anchor:");
    let assigned_prop = anchor_id.as_ref().and_then(|anchor| map.props.iter().find(|prop| &prop.id == anchor));
    let props: Vec<&TacticalProp> = match assigned_prop {
        Some(prop) => vec![prop],
        None => suitable_props(map, &preferred),
    };
    let props: Vec<(&TacticalProp, Vec<(i64, i64)>, usize)> = props.into_iter().map(|prop| (prop, prop_cells(prop), asset_rank(&preferred, &prop.asset_id))).collect();
    // Пост без предмета — настил: житель стоит на самом настиле, а не у
    // случайного стола (мастер настилов в программе скита).
    let terrain: Option<HashSet<String>> = (npc.get("post_terrain").and_then(Value::as_str) == Some("platform")).then(|| platform_cells(map).into_iter().map(|(x, y)| cell_key(x, y)).collect());
    let seed = map.seed.clone();
    let npc_id = js::s(npc.get("id"));
    let mut candidates = Vec::new();
    for y in 0..map.height {
        for x in 0..map.width {
            if !cell_allowed(map, x as f64, y as f64, occupied, prop_occupied, footprint) {
                continue;
            }
            if let Some(zone) = assigned_zone {
                if cell_at(map, x, y).map(|cell| cell.zone) != Some(zone.id.as_str()) {
                    continue;
                }
            }
            let mut anchor: Option<&TacticalProp> = None;
            let mut anchor_distance = MAX_SAFE_INTEGER;
            let mut anchor_rank = (preferred.len() + 1) as f64;
            for (prop, cells, rank) in &props {
                let distance_to_prop = cells.iter().map(|&(cx, cy)| ((x - cx).abs().max((y - cy).abs())) as f64).fold(f64::INFINITY, f64::min);
                let rank = *rank as f64;
                let closer = distance_to_prop < anchor_distance;
                let same = distance_to_prop == anchor_distance;
                if closer || (same && rank < anchor_rank) || (same && rank == anchor_rank && jstext::locale_compare(&prop.id, anchor.map_or("", |anchor| anchor.id.as_str())).is_lt()) {
                    anchor = Some(prop);
                    anchor_distance = distance_to_prop;
                    anchor_rank = rank;
                }
            }
            let tie = stable_id(&[seed.clone(), npc_id.clone(), x.to_string(), y.to_string()]);
            let off_terrain = terrain.as_ref().is_some_and(|cells| !cells.is_empty() && !cells.contains(&cell_key(x, y)));
            candidates.push(Candidate {
                x,
                y,
                anchor_prop_id: if anchor_distance <= 2.0 { anchor.map_or_else(String::new, |anchor| anchor.id.clone()) } else { String::new() },
                score: (
                    // Клетка настила впереди любой другой; занятый настил не
                    // оставляет жителя без места — он встанет по обычной мерке.
                    u8::from(off_terrain),
                    anchor_rank,
                    if anchor_distance == 1.0 {
                        0
                    } else if anchor_distance == 2.0 {
                        1
                    } else {
                        2
                    },
                    anchor_distance,
                    tie,
                ),
            });
        }
    }
    candidates.sort_by(|left, right| {
        let (a, b) = (&left.score, &right.score);
        a.0.cmp(&b.0)
            .then_with(|| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
            .then_with(|| a.2.cmp(&b.2))
            .then_with(|| a.3.partial_cmp(&b.3).unwrap_or(std::cmp::Ordering::Equal))
            .then_with(|| utf16_cmp(&a.4, &b.4))
    });
    candidates
}

/// `isValidNpcPost(state, position, { occupied, exceptNpcId })`: раскрытая,
/// проходимая и свободная клетка карты сцены для поста NPC. Без `occupied`
/// занятость — клетки героев, противников и существ; посты остальных NPC
/// этой локации добавляются всегда.
pub fn is_valid_npc_post(state: &Value, position: Option<&Value>, occupied: Option<IndexSet<String>>, except_npc_id: &str) -> bool {
    let Some(map) = scene_map(state) else { return false };
    let mut occupied = occupied.unwrap_or_else(|| actor_occupied_cells(state));
    let prop_occupied = prop_occupied_cells(&map);
    let world = world_of(state);
    let location_id = scene_location_id(state);
    for placement in world_placements(&world) {
        if placement.get("location_id").and_then(Value::as_str) != Some(location_id.as_str()) || placement.get("npc_id").and_then(Value::as_str) == Some(except_npc_id) {
            continue;
        }
        for key in placement_cells(placement.get("footprint"), placement) {
            occupied.insert(key);
        }
    }
    let own = placement_in(&world, except_npc_id, &location_id).and_then(|placement| placement.get("footprint")).filter(|value| js::truthy(Some(value))).cloned();
    let footprint = own.or_else(|| spawn_footprint_in(&world, except_npc_id));
    position_allowed(&map, position, &occupied, &prop_occupied, footprint.as_ref())
}

/// `planSceneNpcPlacementEvents` над своим списком NPC (`{ ...state, social:
/// { ...state.social, npcs } }` в JS).
fn plan_placements(state: &Value, npcs: &[Value]) -> Vec<Value> {
    let Some(map) = scene_map(state) else { return Vec::new() };
    let location_id = scene_location_id(state);
    if location_id.is_empty() {
        return Vec::new();
    }
    let world = world_of(state);
    let present = present_in(state, world.get("vitals"), npcs);
    let present_ids: HashSet<String> = present.iter().map(|npc| js::string(npc.get("id"))).collect();
    let mut occupied = actor_occupied_cells(state);
    let prop_occupied = prop_occupied_cells(&map);
    // PlaceNpc планирует только выбранного NPC. Резервируем остальные посты
    // этой локации, иначе новый житель может оказаться поверх прежнего.
    for placement in world_placements(&world) {
        let npc_id = js::s(placement.get("npc_id"));
        if placement.get("location_id").and_then(Value::as_str) != Some(location_id.as_str()) || present_ids.contains(&npc_id) {
            continue;
        }
        if position_allowed(&map, Some(placement), &occupied, &prop_occupied, placement.get("footprint")) {
            for key in placement_cells(placement.get("footprint"), placement) {
                occupied.insert(key);
            }
        }
    }
    let mut events = Vec::new();
    let posts = normalize_scene_posts(get(get(Some(state), "scene"), "map_requirements").unwrap_or(&Value::Null));
    for present_npc in &present {
        let name = text(present_npc.get("name"), 120);
        let npc = match posts.iter().find(|entry| entry.npc == name) {
            Some(post) => {
                let mut npc = spread(Some(present_npc));
                npc.insert("post_assets".into(), js::strings_value(requirement_assets(&post.id)));
                set_or_remove(&mut npc, "post_terrain", requirement_terrain(&post.id).map(|terrain| Value::String(terrain.to_string())).as_ref());
                Value::Object(npc)
            }
            None => present_npc.clone(),
        };
        let npc_id = js::string(npc.get("id"));
        let existing = placement_in(&world, &npc_id, &location_id);
        let footprint: Option<Value> = match existing {
            Some(existing) => existing.get("footprint").filter(|value| !value.is_null()).cloned(),
            None => spawn_footprint_in(&world, &npc_id),
        };
        if let Some(existing) = existing {
            if position_allowed(&map, Some(existing), &occupied, &prop_occupied, footprint.as_ref()) {
                for key in placement_cells(footprint.as_ref(), existing) {
                    occupied.insert(key);
                }
                continue;
            }
        }
        let Some(selected) = candidate_cells(&map, &npc, &occupied, &prop_occupied, footprint.as_ref()).into_iter().next() else { continue };
        for (x, y) in square_cells(footprint.as_ref(), selected.x, selected.y) {
            occupied.insert(cell_key(x, y));
        }
        let mut placement = Map::new();
        placement.insert("npc_id".into(), string(npc_id.clone()));
        placement.insert("npc_name".into(), string(text(npc.get("name"), 160)));
        placement.insert("npc_role".into(), string(text(npc.get("role"), 160)));
        placement.insert("location_id".into(), string(location_id.clone()));
        placement.insert("x".into(), Value::from(selected.x));
        placement.insert("y".into(), Value::from(selected.y));
        placement.insert("anchor_prop_id".into(), string(selected.anchor_prop_id));
        if let Some(footprint) = footprint.as_ref().filter(|value| js::truthy(Some(value))) {
            placement.insert("footprint".into(), footprint.clone());
        }
        placement.insert("placement_reason".into(), string(if existing.is_some() { "relocated-invalid-post" } else { "role-suitable-post" }));
        placement.insert("policy_id".into(), string(NPC_WORLD_POLICY_ID));
        match existing {
            Some(existing) => {
                placement.insert("from".into(), json!({ "x": existing.get("x"), "y": existing.get("y") }));
            }
            None => {
                let vitality = match member(world.get("profiles"), &npc_id) {
                    Member::Own(profile) if js::truthy(Some(profile)) => {
                        let mut vitality = Map::new();
                        if let Some(hp) = profile.get("hp") {
                            vitality.insert("hp".into(), hp.clone());
                            vitality.insert("max_hp".into(), hp.clone());
                        }
                        vitality.insert("alive".into(), Value::Bool(true));
                        Value::Object(vitality)
                    }
                    // Унаследованная функция истинна, а ОЗ у неё нет.
                    Member::Function | Member::Prototype => json!({ "alive": true }),
                    _ => initial_npc_vital(Some(&npc)),
                };
                placement.insert("vitality".into(), vitality);
            }
        }
        events.push(json!({
            "event_type": if existing.is_some() { "NpcMoved" } else { "NpcPlaced" },
            "payload": Value::Object(placement),
            "target_ids": [npc_id],
            "visibility": visibility_of(Some(&npc)),
        }));
    }
    events
}

/// `planSceneNpcPlacementEvents(state)`: события размещения без применения.
/// Первый визит создаёт `NpcPlaced`; изменившаяся карта переносит старый пост
/// через `NpcMoved`.
pub fn plan_scene_npc_placement_events(state: &Value) -> Vec<Value> {
    plan_placements(state, social_npcs(state))
}

fn social_npc<'s>(state: &'s Value, npc_id: &str) -> Option<&'s Value> {
    social_npcs(state).iter().find(|npc| js::string(get(Some(npc), "id")) == npc_id).filter(|npc| js::truthy(Some(npc)))
}

fn required_system_context(context: &Value) -> Result<(), NpcWorldValidationError> {
    let flag = |key: &str| js::is_true(get(Some(context), key));
    if !flag("isAdmin") && !flag("isDirector") && !flag("serverAuthoritativeCombat") {
        return fail("Положение и уязвимость мирных NPC изменяет только серверный контур", "NPC_WORLD_FORBIDDEN");
    }
    Ok(())
}

/// `validateNpcWorldCommand(input, state, context)`: проверка `PlaceNpc`,
/// `MoveNpc` и `HarmNpc`; возвращает канонизированную команду.
pub fn validate_npc_world_command(input: &Value, state: &Value, context: &Value) -> Result<Value, NpcWorldValidationError> {
    required_system_context(context)?;
    let mut command = spread(Some(input));
    let npc_id = text(coalesce(command.get("npc_id"), command.get("npcId")), 120);
    let Some(npc) = social_npc(state, &npc_id) else {
        return fail("NPC не найден", "NPC_WORLD_NPC_NOT_FOUND");
    };
    if !npc_at_current_location(Some(npc), state) {
        return fail("NPC отсутствует в текущей сцене", "NPC_NOT_PRESENT");
    }
    command.insert("npc_id".into(), string(npc_id.clone()));
    command.insert("actor_id".into(), Value::Null);
    command.insert("target_id".into(), Value::Null);
    command.insert("target_ids".into(), json!([]));
    let world = world_of(state);
    let current_location = scene_location_id(state);
    let command_type = command.get("command_type").and_then(Value::as_str).map(str::to_string);
    if command_type.as_deref() == Some("HarmNpc") {
        if !js::is_true(get(Some(context), "serverAuthoritativeCombat")) && !js::is_true(get(Some(context), "isAdmin")) {
            return fail("Урон мирному NPC принимает только авторитетный серверный бой", "NPC_HARM_FORBIDDEN");
        }
        let amount = integer(command.get("amount"), 0);
        if amount <= 0 || amount > 1_000 {
            return fail("Урон NPC должен быть положительным целым", "NPC_HARM_AMOUNT_INVALID");
        }
        if placement_in(&world, &npc_id, &current_location).is_none() {
            return fail("NPC не находится в текущей сцене", "NPC_NOT_PRESENT");
        }
        if !js::truthy(vital_in(state, &world, &npc_id).get("alive")) {
            return fail("Погибший NPC не может получить повторный урон", "NPC_ALREADY_DEAD");
        }
        command.insert("amount".into(), Value::from(amount));
        let damage_type = text(command.get("damage_type"), 40);
        command.insert("damage_type".into(), string(if damage_type.is_empty() { "untyped".to_string() } else { damage_type }));
        let source_event_id = text(command.get("source_event_id"), 120);
        command.insert("source_event_id".into(), string(source_event_id));
        let source_actor_id = text(command.get("source_actor_id"), 120);
        command.insert("source_actor_id".into(), string(source_actor_id));
        let trigger = text(command.get("trigger"), 80);
        command.insert("trigger".into(), string(if trigger.is_empty() { "server-collateral".to_string() } else { trigger }));
        return Ok(Value::Object(command));
    }
    let requested_location = text(command.get("location_id"), 180);
    let location_id = if requested_location.is_empty() { current_location.clone() } else { requested_location };
    if location_id.is_empty() || location_id != current_location {
        return fail("NPC можно разместить только в текущей локации", "NPC_LOCATION_MISMATCH");
    }
    command.insert("location_id".into(), string(location_id.clone()));
    let existing = placement_in(&world, &npc_id, &location_id).is_some();
    if command_type.as_deref() == Some("PlaceNpc") && existing {
        return fail("NPC уже размещён; используйте MoveNpc", "NPC_ALREADY_PLACED");
    }
    if !js::truthy(vital_in(state, &world, &npc_id).get("alive")) {
        return fail("Погибшего NPC нельзя разместить на новом посту", "NPC_ALREADY_DEAD");
    }
    let requested = coalesce(command.get("to"), command.get("position")).cloned();
    if js::truthy(requested.as_ref()) {
        let x = opt_integer(get(requested.as_ref(), "x"));
        let y = opt_integer(get(requested.as_ref(), "y"));
        let position = match (x, y) {
            (Some(x), Some(y)) => json!({ "x": x, "y": y }),
            // `integer(…, NaN)`: такая клетка постом не бывает.
            _ => return fail("Пост NPC должен быть раскрытой, проходимой и свободной клеткой", "NPC_POST_INVALID"),
        };
        if !is_valid_npc_post(state, Some(&position), None, &npc_id) {
            return fail("Пост NPC должен быть раскрытой, проходимой и свободной клеткой", "NPC_POST_INVALID");
        }
        command.insert("to".into(), position);
    } else {
        let planned = plan_placements(state, std::slice::from_ref(npc)).into_iter().next();
        let Some(planned) = planned else {
            return fail("На карте нет свободного поста для NPC", "NPC_POST_UNAVAILABLE");
        };
        let payload = &planned["payload"];
        command.insert("to".into(), json!({ "x": payload.get("x"), "y": payload.get("y") }));
        command.insert("anchor_prop_id".into(), payload.get("anchor_prop_id").cloned().unwrap_or(Value::Null));
    }
    if command_type.as_deref() == Some("MoveNpc") && !existing {
        return fail("Сначала NPC нужно разместить в этой локации", "NPC_POST_NOT_FOUND");
    }
    let anchor = text(command.get("anchor_prop_id"), 120);
    command.insert("anchor_prop_id".into(), string(anchor));
    Ok(Value::Object(command))
}

fn placed_targets_in(state: &Value, world: &Value) -> Vec<NpcTarget> {
    let location_id = scene_location_id(state);
    let mut targets: Vec<NpcTarget> = present_in(state, world.get("vitals"), social_npcs(state))
        .into_iter()
        .filter_map(|npc| {
            let placement = placement_in(world, &js::s(npc.get("id")), &location_id)?.clone();
            Some(NpcTarget { npc, placement })
        })
        .collect();
    targets.sort_by(|left, right| jstext::locale_compare(&js::string(left.npc.get("id")), &js::string(right.npc.get("id"))));
    targets
}

/// `placedSceneNpcTargets(state)`: присутствующие NPC сцены, у которых есть пост.
pub fn placed_scene_npc_targets(state: &Value) -> Vec<NpcTarget> {
    placed_targets_in(state, &world_of(state))
}

fn target_cells(target: &NpcTarget) -> Vec<String> {
    placement_cells(target.placement.get("footprint"), &target.placement)
}

/// `sceneNpcOccupiedCells(state)`: клетки присутствующих социальных NPC — тот
/// же набор, что уходит в `scene_npcs`. Rules Engine считает их занятостью,
/// чтобы герой не встал поверх мирного NPC. Проекции игрока не несут
/// `npc_world`, но хранят координаты в `scene_npcs` — запасной путь держит
/// предпросмотр маршрута в том же ритме, что и сервер.
pub fn scene_npc_occupied_cells(state: &Value) -> IndexSet<String> {
    let placed = placed_scene_npc_targets(state);
    if !placed.is_empty() {
        return placed.iter().flat_map(target_cells).collect();
    }
    array(get(Some(state), "scene_npcs")).iter().filter(|npc| !js::is_false(get(Some(npc), "alive"))).map(|npc| key_of(Some(npc))).collect()
}

/// `sceneNpcTransitCells(state)`: клетки, через которые можно пройти, но на
/// которых нельзя закончить ход. Мирный NPC не превращает узкий проход в
/// невидимую стену; враждебный остаётся полным блокером.
pub fn scene_npc_transit_cells(state: &Value) -> IndexSet<String> {
    let world = world_of(state);
    let placed = placed_targets_in(state, &world);
    if !placed.is_empty() {
        return placed
            .iter()
            .filter(|target| member(world.get("stances"), &js::string(target.npc.get("id"))).field("stance").own().and_then(Value::as_str) != Some("hostile"))
            .flat_map(target_cells)
            .collect();
    }
    array(get(Some(state), "scene_npcs"))
        .iter()
        .filter(|npc| !js::is_false(get(Some(npc), "alive")) && js::s(coalesce(get(Some(npc), "stance"), Some(&json!("neutral")))) != "hostile")
        .flat_map(|npc| footprint_cells_for(Some(npc), None).into_iter().map(|cell| cell.key()))
        .collect()
}

fn distance_to_point(target: &NpcTarget, point: Option<&Value>) -> Option<f64> {
    let actor = json!({ "footprint": target.placement.get("footprint").cloned().unwrap_or(Value::Null) });
    let cells = Value::Array(vec![point.cloned().unwrap_or(Value::Null)]);
    footprint_distance_feet(Some(&actor), Some(&cells), Some(&target.placement), None)
}

/// `npcTargetsWithinArea(state, center, radiusFeet)`: NPC с постом, чья
/// площадь в радиусе от центра.
pub fn npc_targets_within_area(state: &Value, center: Option<&Value>, radius_feet: Option<&Value>) -> Vec<NpcTarget> {
    let radius = js::number(radius_feet);
    let radius = js_max(0.0, if radius.is_nan() || radius == 0.0 { 0.0 } else { radius });
    let mut targets: Vec<NpcTarget> = placed_scene_npc_targets(state)
        .into_iter()
        .filter(|target| distance_to_point(target, center).is_some_and(|distance| distance <= radius))
        .collect();
    targets.sort_by(|left, right| jstext::locale_compare(&js::string(left.npc.get("id")), &js::string(right.npc.get("id"))));
    targets
}

/// `npcMissCollateralTarget(state, { targetPosition, attackTotal, armorClass })`:
/// ближний промах на 1–2 пункта задевает одного NPC в пяти футах от цели.
pub fn npc_miss_collateral_target(state: &Value, target_position: Option<&Value>, attack_total: Option<&Value>, armor_class: Option<&Value>) -> Option<NpcTarget> {
    let miss_margin = js::number(armor_class) - js::number(attack_total);
    if !js::truthy(target_position) || !miss_margin.is_finite() || miss_margin < 1.0 || miss_margin > 2.0 {
        return None;
    }
    npc_targets_within_area(state, target_position, Some(&json!(5))).into_iter().next()
}

fn nearby_placed_npcs(state: &Value, world: &Value, origin: &Value, radius_cells: f64, excluded: &HashSet<String>) -> Vec<NpcTarget> {
    let location_id = scene_location_id(state);
    let mut nearby: Vec<(NpcTarget, Option<f64>)> = present_in(state, world.get("vitals"), social_npcs(state))
        .into_iter()
        .filter_map(|npc| {
            let id = js::s(npc.get("id"));
            let placement = placement_in(world, &id, &location_id)?.clone();
            let target = NpcTarget { npc, placement };
            if excluded.contains(&js::string(target.npc.get("id"))) {
                return None;
            }
            let distance = distance_to_point(&target, Some(origin));
            // `null <= 30` в JS — истина: пустая площадь считается рядом.
            (distance.unwrap_or(0.0) <= radius_cells * 5.0).then_some((target, distance))
        })
        .collect();
    nearby.sort_by(|(left, left_distance), (right, right_distance)| {
        let left_distance = left_distance.unwrap_or(MAX_SAFE_INTEGER);
        let right_distance = right_distance.unwrap_or(MAX_SAFE_INTEGER);
        left_distance
            .partial_cmp(&right_distance)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| jstext::locale_compare(&js::string(left.npc.get("id")), &js::string(right.npc.get("id"))))
    });
    nearby.into_iter().map(|(target, _)| target).collect()
}

fn stance_draft(npc: &Value, stance: &str, reason: &str, source_event_id: Value, propagation_depth: i64) -> Value {
    let id = js::string(npc.get("id"));
    json!({
        "event_type": "NpcStanceChanged",
        "payload": {
            "npc_id": id,
            "npc_name": text(npc.get("name"), 160),
            "stance": stance,
            "reason": reason,
            "source_event_id": source_event_id,
            "propagation_depth": propagation_depth,
            "policy_id": NPC_WORLD_POLICY_ID,
        },
        "target_ids": [id],
        "visibility": visibility_of(Some(npc)),
    })
}

fn witness_and_reputation_drafts(witnesses: &[&NpcTarget], source_event_id: &str, severity: &str) -> Vec<Value> {
    let witness_ids: Vec<String> = witnesses.iter().map(|target| js::string(target.npc.get("id"))).collect();
    let mut factions: IndexSet<String> = IndexSet::new();
    for target in witnesses {
        factions.extend(faction_ids_for_npc(Some(&target.npc)));
    }
    let mut factions: Vec<String> = factions.into_iter().collect();
    factions.sort_by(|left, right| utf16_cmp(left, right));
    let mut events = vec![json!({
        "event_type": "WitnessConsequencePropagated",
        "payload": {
            "source_event_id": source_event_id,
            "witness_ids": witness_ids,
            "faction_ids": factions,
            "propagation_scope": "nearby-one-hop",
            "outcome": "harmful",
            "severity": severity,
            "provenance": { "source": "server-npc-witness-policy", "policy": NPC_WORLD_POLICY_ID },
        },
        "target_ids": witness_ids,
        "visibility": "party",
    })];
    let delta = if severity == "major" { -5 } else { -2 };
    for faction_id in &factions {
        events.push(json!({
            "event_type": "FactionReputationAdjusted",
            "payload": {
                "faction_id": faction_id,
                "delta": delta,
                "source_event_id": source_event_id,
                "witness_ids": witness_ids,
                "provenance": { "source": "server-reputation-table", "policy": "faction-reputation-v1" },
            },
            "target_ids": [],
            "visibility": "party",
        }));
    }
    events
}

/// Параметры `npcHarmEventDrafts(state, { … })`. `None` — `undefined` в JS:
/// действует значение по умолчанию.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct NpcHarmOptions {
    pub npc_id: Option<Value>,
    pub amount: Option<Value>,
    /// По умолчанию `untyped`.
    pub damage_type: Option<Value>,
    /// По умолчанию `[]`.
    pub damage_components: Option<Value>,
    /// По умолчанию `null`.
    pub temporary_hp_before: Option<Value>,
    pub temporary_hp_after: Option<Value>,
    pub temporary_hp_absorbed: Option<Value>,
    /// По умолчанию `''`.
    pub source_event_id: Option<Value>,
    pub source_actor_id: Option<Value>,
    /// По умолчанию `server-collateral`.
    pub trigger: Option<Value>,
    pub command_id: Option<Value>,
}

impl NpcHarmOptions {
    /// Параметры из объекта JS (`{ npcId, amount, damageType, … }`).
    pub fn from_json(options: &Value) -> Self {
        let field = |key: &str| options.get(key).cloned();
        Self {
            npc_id: field("npcId"),
            amount: field("amount"),
            damage_type: field("damageType"),
            damage_components: field("damageComponents"),
            temporary_hp_before: field("temporaryHpBefore"),
            temporary_hp_after: field("temporaryHpAfter"),
            temporary_hp_absorbed: field("temporaryHpAbsorbed"),
            source_event_id: field("sourceEventId"),
            source_actor_id: field("sourceActorId"),
            trigger: field("trigger"),
            command_id: field("commandId"),
        }
    }
}

/// `npcHarmEventDrafts(state, options)`: события урона мирному NPC и
/// социальных последствий. Паника ограничена прямыми свидетелями и одним
/// соседним кольцом.
pub fn npc_harm_event_drafts(state: &Value, options: &NpcHarmOptions) -> Vec<Value> {
    let npc_id = js::s(options.npc_id.as_ref());
    let damage_type = options.damage_type.clone().unwrap_or_else(|| json!("untyped"));
    let damage_components = options.damage_components.clone().unwrap_or_else(|| json!([]));
    let temporary_hp_before = options.temporary_hp_before.clone().unwrap_or(Value::Null);
    let temporary_hp_after = options.temporary_hp_after.clone().unwrap_or(Value::Null);
    let temporary_hp_absorbed = options.temporary_hp_absorbed.clone().unwrap_or(Value::Null);
    let source_event_id = options.source_event_id.clone().unwrap_or_else(|| json!(""));
    let source_actor_id = options.source_actor_id.clone().unwrap_or_else(|| json!(""));
    let trigger = options.trigger.clone().unwrap_or_else(|| json!("server-collateral"));
    let command_id = options.command_id.clone().unwrap_or_else(|| json!(""));
    let amount = options.amount.as_ref();

    let Some(npc) = social_npc(state, &npc_id) else { return Vec::new() };
    let world = world_of(state);
    let location_id = scene_location_id(state);
    let Some(placement) = placement_in(&world, &npc_id, &location_id).cloned() else { return Vec::new() };
    let before = vital_in(state, &world, &npc_id);
    if !js::truthy(before.get("alive")) {
        return Vec::new();
    }
    let before_hp = integer(before.get("hp"), 0);
    let components: Vec<Map<String, Value>> = match &damage_components {
        Value::Array(items) => items
            .iter()
            .map(|component| {
                let c = Some(component);
                let mut entry = Map::new();
                let kind = text(coalesce(get(c, "damage_type"), get(c, "damageType")), 40);
                entry.insert("damage_type".into(), string(if kind.is_empty() { "untyped".to_string() } else { kind }));
                entry.insert("raw_amount".into(), Value::from(0.max(integer(coalesce(coalesce(get(c, "raw_amount"), get(c, "rawAmount")), get(c, "amount")), 0))));
                entry.insert("applied_amount".into(), Value::from(0.max(integer(coalesce(coalesce(get(c, "applied_amount"), get(c, "appliedAmount")), get(c, "amount")), 0))));
                if js::present(get(c, "temporary_hp_absorbed")) || js::present(get(c, "temporaryHpAbsorbed")) {
                    entry.insert("temporary_hp_absorbed".into(), Value::from(0.max(integer(coalesce(get(c, "temporary_hp_absorbed"), get(c, "temporaryHpAbsorbed")), 0))));
                }
                entry
            })
            .filter(|entry| integer(entry.get("raw_amount"), 0) > 0 || integer(entry.get("applied_amount"), 0) > 0)
            .collect(),
        _ => Vec::new(),
    };
    let mut remaining_hp = before_hp;
    let normalized: Vec<Map<String, Value>> = components
        .into_iter()
        .map(|mut component| {
            let applied = 0.max(remaining_hp.min(integer(component.get("applied_amount"), 0)));
            remaining_hp -= applied;
            component.insert("applied_amount".into(), Value::from(applied));
            component
        })
        .collect();
    let component_raw: i64 = normalized.iter().map(|component| integer(component.get("raw_amount"), 0)).sum();
    let component_applied: i64 = normalized.iter().map(|component| integer(component.get("applied_amount"), 0)).sum();
    let applied = if normalized.is_empty() { 0.max(before_hp.min(integer(amount, 0))) } else { component_applied };
    let has_temporary_hp = js::present(Some(&temporary_hp_before)) || js::present(Some(&temporary_hp_after)) || js::present(Some(&temporary_hp_absorbed));
    let temporary_before = has_temporary_hp.then(|| 0.max(integer(Some(&temporary_hp_before), 0)));
    let temporary_after = has_temporary_hp.then(|| 0.max(integer(Some(&temporary_hp_after), temporary_before.unwrap_or(0))));
    let temporary_absorbed = if has_temporary_hp { 0.max(integer(Some(&temporary_hp_absorbed), temporary_before.unwrap_or(0) - temporary_after.unwrap_or(0))) } else { 0 };
    if applied == 0 && temporary_absorbed == 0 {
        return Vec::new();
    }
    let after_hp = before_hp - applied;
    let alive = after_hp > 0;
    let max_hp = before.get("max_hp").cloned();
    let optional = |value: Option<i64>| value.map_or_else(String::new, |value| value.to_string());
    let harm_event_id = format!(
        "npc-harmed:{}",
        stable_id(&[
            part(Some(&command_id)),
            npc_id.clone(),
            part(Some(&source_event_id)),
            before_hp.to_string(),
            applied.to_string(),
            optional(temporary_before),
            optional(temporary_after),
            temporary_absorbed.to_string(),
        ])
    );
    let death_event_id = format!("npc-died:{}", stable_id(&[part(Some(&command_id)), npc_id.clone(), part(Some(&source_event_id)), before_hp.to_string(), applied.to_string()]));
    let npc_key = js::string(npc.get("id"));
    let npc_name = text(npc.get("name"), 160);
    let mut payload = Map::new();
    payload.insert("npc_id".into(), string(npc_key.clone()));
    payload.insert("npc_name".into(), string(npc_name.clone()));
    let damage_label = if normalized.len() > 1 {
        "mixed".to_string()
    } else {
        let label = text(coalesce(normalized.first().and_then(|component| component.get("damage_type")), Some(&damage_type)), 40);
        if label.is_empty() {
            "untyped".to_string()
        } else {
            label
        }
    };
    payload.insert("damage_type".into(), string(damage_label));
    payload.insert("raw_amount".into(), Value::from(if normalized.is_empty() { integer(amount, 0) } else { component_raw }));
    payload.insert("applied_amount".into(), Value::from(applied));
    if normalized.len() > 1 {
        payload.insert("damage_components".into(), Value::Array(normalized.iter().cloned().map(Value::Object).collect()));
    }
    if has_temporary_hp {
        payload.insert("temporary_hp_before".into(), json!(temporary_before));
        payload.insert("temporary_hp_after".into(), json!(temporary_after));
        payload.insert("temporary_hp_absorbed".into(), json!(temporary_absorbed));
    }
    payload.insert("hp_before".into(), Value::from(before_hp));
    payload.insert("hp_after".into(), Value::from(after_hp));
    set_or_remove(&mut payload, "max_hp", max_hp.as_ref());
    payload.insert("source_event_id".into(), source_event_id.clone());
    payload.insert("source_actor_id".into(), source_actor_id.clone());
    payload.insert("trigger".into(), trigger.clone());
    payload.insert("policy_id".into(), string(NPC_WORLD_POLICY_ID));
    let mut events = vec![json!({
        "event_type": "NpcHarmed",
        "event_id": harm_event_id,
        "payload": Value::Object(payload),
        "target_ids": [npc_key],
        "visibility": "party",
    })];
    if !alive {
        events.push(json!({
            "event_type": "NpcDied",
            "event_id": death_event_id,
            "payload": {
                "npc_id": npc_key,
                "npc_name": npc_name,
                "location_id": location_id,
                "source_event_id": harm_event_id,
                "source_actor_id": source_actor_id,
                "trigger": trigger,
                "policy_id": NPC_WORLD_POLICY_ID,
            },
            "target_ids": [npc_key],
            "visibility": "party",
        }));
    }
    let max = js::number(max_hp.as_ref());
    let own_stance = if alive {
        if (after_hp * 2) as f64 <= max {
            "fleeing"
        } else {
            "hostile"
        }
    } else {
        "dead"
    };
    events.push(stance_draft(npc, own_stance, if alive { "harmed" } else { "killed" }, string(if alive { harm_event_id.clone() } else { death_event_id.clone() }), 0));

    let excluded: HashSet<String> = HashSet::from([npc_key.clone()]);
    let mut direct = nearby_placed_npcs(state, &world, &placement, 6.0, &excluded);
    direct.truncate(12);
    let direct_ids: HashSet<String> = direct.iter().map(|target| js::string(target.npc.get("id"))).collect();
    for witness in &direct {
        events.push(stance_draft(&witness.npc, "frightened", "witnessed-npc-harm", string(harm_event_id.clone()), 0));
    }
    let mut ring: HashSet<String> = direct_ids.clone();
    ring.insert(npc_key.clone());
    let mut propagated: Vec<NpcTarget> = Vec::new();
    for witness in &direct {
        for neighbor in nearby_placed_npcs(state, &world, &witness.placement, 3.0, &ring) {
            let neighbor_id = js::string(neighbor.npc.get("id"));
            if propagated.iter().any(|candidate| js::string(candidate.npc.get("id")) == neighbor_id) {
                continue;
            }
            propagated.push(neighbor);
            if propagated.len() >= MAX_PROPAGATED_NPCS.saturating_sub(direct.len()) {
                break;
            }
        }
        if direct.len() + propagated.len() >= MAX_PROPAGATED_NPCS {
            break;
        }
    }
    for witness in &propagated {
        events.push(stance_draft(&witness.npc, "guarded", "nearby-panic", string(harm_event_id.clone()), 1));
    }
    let witnesses: Vec<&NpcTarget> = direct.iter().chain(propagated.iter()).collect();
    events.extend(witness_and_reputation_drafts(&witnesses, if alive { &harm_event_id } else { &death_event_id }, if alive { "minor" } else { "major" }));

    if !alive {
        let entities = array(get(get(Some(state), "worldMemory"), "entities"));
        let entity_exists = entities.iter().any(|entity| js::string(get(Some(entity), "id")) == npc_key);
        if !entity_exists {
            let tags: Vec<Value> = array(npc.get("tags")).iter().take(20).cloned().collect();
            events.push(json!({
                "event_type": "WorldEntityUpserted",
                "payload": {
                    "entity": {
                        "id": npc_key,
                        "kind": "npc",
                        "name": npc_name,
                        "summary": text(npc.get("public_summary"), 1_000),
                        "aliases": [],
                        "visibility": "party",
                        "tags": tags,
                    },
                },
                "target_ids": [],
                "visibility": "party",
            }));
        }
        let elapsed = get(get(get(Some(state), "mechanics"), "world_time"), "elapsed_minutes");
        events.push(json!({
            "event_type": "WorldFactRecorded",
            "payload": {
                "fact": {
                    "id": format!("fact:npc-death:{}", stable_id(&[death_event_id.clone()])),
                    "subject_id": npc_key,
                    "predicate": "died",
                    "object": location_id,
                    "summary": format!("{npc_name} погиб(ла) в локации «{}».", text(scene_place_name(state), 180)),
                    "visibility": "party",
                    "source_event_ids": [death_event_id],
                    "source_command_id": text(Some(&command_id), 160),
                    "supersedes_fact_id": "",
                    "status": "active",
                    "recorded_at_minutes": 0.max(integer(elapsed, 0)),
                },
            },
            "target_ids": [],
            "visibility": "party",
        }));
    }
    events
}

fn actor_id_of(value: Option<&Value>) -> String {
    text(coalesce(get(value, "id"), get(value, "actor_id")), 120)
}

fn actor_position_of(state: &Value, actor: &Value) -> Option<(i64, i64)> {
    let id = actor_id_of(Some(actor));
    let positions = get(get(Some(state), "mechanics"), "positions");
    let stored = match member(positions, &id) {
        Member::Own(found) if !found.is_null() => Some(found),
        Member::Function | Member::Prototype => None,
        _ => Some(actor),
    };
    Some((opt_integer(get(stored, "x"))?, opt_integer(get(stored, "y"))?))
}

fn event_targets_actor(event: &Value, actor_id: &str) -> bool {
    array(event.get("target_ids")).iter().any(|target| js::string(Some(target)) == actor_id)
}

fn event_source_id(event: Option<&Value>, command_id: &Value, suffix: &str) -> String {
    let own = text(coalesce(get(event, "event_id"), get(event, "command_id")), 120);
    if own.is_empty() {
        format!("{}:{suffix}", text(Some(command_id), 120))
    } else {
        own
    }
}

fn event_type(event: &Value) -> Option<&str> {
    event.get("event_type").and_then(Value::as_str)
}

fn has_npc_world_outcome(events: &[Value], npc_id: &str) -> bool {
    events.iter().any(|event| matches!(event_type(event), Some("NpcHarmed" | "NpcDied")) && js::s(get(get(Some(event), "payload"), "npc_id")) == npc_id)
}

fn non_lethal_outcome(events: &[Value], actor_id: &str) -> bool {
    events.iter().any(|event| {
        if !event_targets_actor(event, actor_id) {
            return false;
        }
        let payload = event.get("payload");
        match event_type(event) {
            Some("CreatureKnockedOut") => true,
            Some("ConditionAdded") => ["surrendered", "fled"].contains(&js::s(get(payload, "condition")).as_str()),
            _ => js::is_true(get(payload, "knock_out")) || js::is_true(get(payload, "surrendered")),
        }
    })
}

fn non_lethal_harm_drafts(events: Vec<Value>) -> Vec<Value> {
    events
        .into_iter()
        .filter_map(|event| {
            let payload = event.get("payload");
            let drop = match event_type(&event) {
                Some("NpcDied") | Some("WorldEntityUpserted") => true,
                Some("NpcStanceChanged") => js::s(get(payload, "stance")) == "dead",
                Some("WorldFactRecorded") => js::s(get(get(payload, "fact"), "predicate")) == "died",
                _ => false,
            };
            if drop {
                return None;
            }
            if event_type(&event) != Some("NpcHarmed") {
                return Some(event);
            }
            let mut event = event;
            if let Some(payload) = event.get_mut("payload").and_then(Value::as_object_mut) {
                // Нокаут сохраняет тело в мире с нулевыми ОЗ, но не записывает смерть.
                payload.insert("schema_version".into(), json!(2));
                payload.insert("alive".into(), json!(true));
                payload.insert("non_lethal".into(), json!(true));
            }
            Some(event)
        })
        .collect()
}

fn actor_lists(state: &Value) -> Vec<Value> {
    let mut actors = Vec::new();
    for key in ["players", "enemies", "actors"] {
        actors.extend(array(get(Some(state), key)).iter().cloned());
    }
    actors
}

/// `planAuthoredNpcWorldEvents(before, after, events, { commandId, actorId })`:
/// переносит боевую копию авторского NPC обратно в постоянный пост мира.
///
/// `after` — состояние после `events`. Урон считается от `before`:
/// `npcHarmEventDrafts` берёт абсолютные ОЗ и старый пост, чтобы replay и выбор
/// свидетелей оставались стабильными. Лечение синхронизирует основной
/// редьюсер (`HealingApplied`), отдельного события здесь нет.
pub fn plan_authored_npc_world_events(before: &Value, after: &Value, events: &Value, command_id: &Value, actor_id: &Value) -> Vec<Value> {
    let event_list = array(Some(events));
    let before_actors = actor_lists(before);
    let after_actors = actor_lists(after);
    let mut actors: IndexMap<String, String> = IndexMap::new();
    for actor in before_actors.iter().chain(after_actors.iter()) {
        let id = actor_id_of(Some(actor));
        let npc_id = text(get(get(Some(actor), "origin"), "npc_id"), 120);
        if !id.is_empty() && !npc_id.is_empty() && !actors.contains_key(&npc_id) {
            actors.insert(npc_id, id);
        }
    }
    let mut drafts = Vec::new();
    for (npc_id, combat_actor_id) in &actors {
        let npc_key = json!(npc_id);
        let before_actor = before_actors.iter().find(|candidate| &actor_id_of(Some(candidate)) == combat_actor_id).cloned().or_else(|| npc_combat_actor_for(before, &npc_key));
        let after_actor = after_actors.iter().find(|candidate| &actor_id_of(Some(candidate)) == combat_actor_id).cloned().or_else(|| npc_combat_actor_for(after, &npc_key));
        let (Some(before_actor), Some(after_actor)) = (before_actor, after_actor) else { continue };

        let before_placement = npc_placement_for(before, &npc_key, None);
        let after_placement = npc_placement_for(after, &npc_key, None);
        let before_position = actor_position_of(before, &before_actor);
        let after_position = actor_position_of(after, &after_actor);
        let movement: Vec<&Value> = event_list.iter().filter(|event| event_type(event) == Some("ActorMoved") && event_targets_actor(event, combat_actor_id)).collect();
        let already_moved = event_list.iter().any(|event| event_type(event) == Some("NpcMoved") && js::s(get(get(Some(event), "payload"), "npc_id")) == *npc_id);
        if let (Some(before_placement), Some((x, y))) = (before_placement.as_ref(), after_position) {
            if before_position != Some((x, y)) && !already_moved {
                let source = event_source_id(movement.last().copied(), command_id, &format!("move:{npc_id}"));
                let name = array(get(get(Some(after), "social"), "npcs")).iter().find(|npc| js::string(get(Some(npc), "id")) == *npc_id).and_then(|npc| npc.get("name"));
                let mut payload = Map::new();
                payload.insert("npc_id".into(), json!(npc_id));
                payload.insert("npc_name".into(), json!(text(name, 160)));
                payload.insert("location_id".into(), before_placement.get("location_id").cloned().unwrap_or(Value::Null));
                payload.insert("x".into(), json!(x));
                payload.insert("y".into(), json!(y));
                let footprint = coalesce(after_placement.as_ref().and_then(|placement| placement.get("footprint")), before_placement.get("footprint"));
                if js::truthy(footprint) {
                    payload.insert("footprint".into(), footprint.cloned().unwrap_or(Value::Null));
                }
                let anchor = coalesce(after_placement.as_ref().and_then(|placement| placement.get("anchor_prop_id")), before_placement.get("anchor_prop_id"));
                set_or_remove(&mut payload, "anchor_prop_id", anchor);
                payload.insert("from".into(), before_position.map_or(Value::Null, |(fx, fy)| json!({ "x": fx, "y": fy })));
                payload.insert("placement_reason".into(), json!("authored-actor-sync"));
                payload.insert("policy_id".into(), json!(NPC_WORLD_POLICY_ID));
                payload.insert("source_event_id".into(), json!(source));
                drafts.push(json!({
                    "event_type": "NpcMoved",
                    "event_id": format!("npc-moved:{}", stable_id(&[part(Some(command_id)), npc_id.clone(), source.clone(), x.to_string(), y.to_string()])),
                    "payload": Value::Object(payload),
                    "target_ids": [npc_id],
                    "visibility": "party",
                }));
            }
        }

        let damage_events: Vec<&Value> = event_list
            .iter()
            .filter(|event| event_type(event) == Some("DamageApplied") && event_targets_actor(event, combat_actor_id) && js::is_safe_integer_number(get(get(Some(event), "payload"), "hp_after")))
            .collect();
        if damage_events.is_empty() || has_npc_world_outcome(event_list, npc_id) {
            continue;
        }
        let before_vital = npc_vital_for(before, &npc_key);
        let before_hp = js::number(before_vital.get("hp"));
        let stored_hp = member(get(get(Some(after), "npc_world"), "vitals"), npc_id).field("hp").own();
        let after_hp = js_max(0.0, integer_or(after_actor.get("hp"), integer_or(stored_hp, before_hp)));
        let damage = js_max(0.0, before_hp - after_hp);
        if damage == 0.0 || damage.is_nan() || js::is_false(before_vital.get("alive")) {
            continue;
        }
        let Some(source_event) = damage_events.last().copied() else { continue };
        let source = event_source_id(Some(source_event), command_id, &format!("damage:{npc_id}"));
        let payload = source_event.get("payload");
        let harm_command = {
            let own = text(Some(command_id), 120);
            if own.is_empty() {
                text(source_event.get("command_id"), 120)
            } else {
                own
            }
        };
        let options = NpcHarmOptions {
            npc_id: Some(npc_key.clone()),
            amount: Some(js::num(damage)),
            damage_type: Some(coalesce(get(payload, "damage_type"), None).cloned().unwrap_or_else(|| json!("untyped"))),
            source_event_id: Some(json!(source)),
            source_actor_id: Some(coalesce(coalesce(get(payload, "source_actor_id"), source_event.get("actor_id")), Some(actor_id)).cloned().unwrap_or(Value::Null)),
            trigger: Some(coalesce(get(payload, "trigger"), None).cloned().unwrap_or_else(|| json!("actor-damage"))),
            command_id: Some(json!(harm_command)),
            ..NpcHarmOptions::default()
        };
        let harm = npc_harm_event_drafts(before, &options);
        drafts.extend(if non_lethal_outcome(event_list, combat_actor_id) { non_lethal_harm_drafts(harm) } else { harm });
    }
    drafts
}

/// `npcCombatStanceEventDrafts(state, { sourceEventId, participantIds })`:
/// начало боя пугает NPC в тридцати футах от участников и настораживает их
/// соседей — без хода в инициативе.
pub fn npc_combat_stance_event_drafts(state: &Value, source_event_id: &Value, participant_ids: &Value) -> Vec<Value> {
    let positions = get(get(Some(state), "mechanics"), "positions");
    let mut participants = iterate(get(Some(state), "players"));
    participants.extend(iterate(get(Some(state), "enemies")));
    participants.extend(iterate(get(Some(state), "actors")));
    let origins: Vec<Value> = array(Some(participant_ids))
        .iter()
        .filter_map(|id| {
            let key = js::string(Some(id));
            match member(positions, &key) {
                Member::Own(found) if !found.is_null() => Some(found.clone()),
                Member::Function | Member::Prototype => None,
                _ => participants.iter().find(|actor| js::string(coalesce(get(Some(actor), "id"), get(Some(actor), "actor_id"))) == key).cloned(),
            }
        })
        .filter(|position| js::is_safe_integer_number(get(Some(position), "x")) && js::is_safe_integer_number(get(Some(position), "y")))
        .collect();
    if origins.is_empty() {
        return Vec::new();
    }
    let world = world_of(state);
    let location_id = scene_location_id(state);
    let present: Vec<NpcTarget> = present_in(state, world.get("vitals"), social_npcs(state))
        .into_iter()
        .filter_map(|npc| {
            let placement = placement_in(&world, &js::s(npc.get("id")), &location_id)?.clone();
            Some(NpcTarget { npc, placement })
        })
        .collect();
    let mut direct: Vec<&NpcTarget> = present.iter().filter(|target| origins.iter().any(|origin| distance_to_point(target, Some(origin)).unwrap_or(f64::INFINITY) <= 30.0)).collect();
    direct.truncate(12);
    let direct_ids: HashSet<String> = direct.iter().map(|target| js::string(target.npc.get("id"))).collect();
    let mut propagated: Vec<&NpcTarget> = Vec::new();
    for witness in &direct {
        let witness_actor = json!({ "footprint": witness.placement.get("footprint").cloned().unwrap_or(Value::Null) });
        for neighbor in present.iter().filter(|target| {
            if direct_ids.contains(&js::string(target.npc.get("id"))) {
                return false;
            }
            let actor = json!({ "footprint": target.placement.get("footprint").cloned().unwrap_or(Value::Null) });
            footprint_distance_feet(Some(&actor), Some(&witness_actor), Some(&target.placement), Some(&witness.placement)).unwrap_or(f64::INFINITY) <= 15.0
        }) {
            let neighbor_id = js::string(neighbor.npc.get("id"));
            if propagated.iter().any(|candidate| js::string(candidate.npc.get("id")) == neighbor_id) {
                continue;
            }
            propagated.push(neighbor);
            if direct.len() + propagated.len() >= MAX_PROPAGATED_NPCS {
                break;
            }
        }
        if direct.len() + propagated.len() >= MAX_PROPAGATED_NPCS {
            break;
        }
    }
    direct
        .iter()
        .map(|target| stance_draft(&target.npc, "frightened", "nearby-combat", source_event_id.clone(), 0))
        .chain(propagated.iter().map(|target| stance_draft(&target.npc, "guarded", "nearby-panic", source_event_id.clone(), 1)))
        .collect()
}

/// `applyNpcWorldEvent(input, event, options)`: срез мира NPC после события.
pub fn apply_npc_world_event(input: Option<&Value>, event: &Value, options: &Value) -> Value {
    let legacy = legacy_retention(options);
    let mut world = normalize_npc_world_state(input, options);
    let empty = json!({});
    let payload = coalesce(event.get("payload"), Some(&empty));
    let npc_id = text(get(payload, "npc_id"), 120);
    let kind = event_type(event);
    let Some(world_map) = world.as_object_mut() else { return world };
    if matches!(kind, Some("NpcPlaced" | "NpcMoved")) {
        let mut source = spread(payload);
        source.insert("source_event_id".into(), event.get("event_id").cloned().unwrap_or(Value::Null));
        if let Some(placement) = safe_placement(Some(&Value::Object(source))) {
            let npc = placement.get("npc_id").cloned();
            let location = placement.get("location_id").cloned();
            let mut placements: Vec<Value> = array(world_map.get("placements"))
                .iter()
                .filter(|entry| entry.get("npc_id") != npc.as_ref() || entry.get("location_id") != location.as_ref())
                .cloned()
                .collect();
            placements.push(placement);
            if legacy && placements.len() > MAX_PLACEMENTS {
                placements = placements.split_off(placements.len() - MAX_PLACEMENTS);
            }
            world_map.insert("placements".into(), Value::Array(placements));
        }
        let vitality = get(payload, "vitality");
        if kind == Some("NpcPlaced") && js::truthy(vitality) && !npc_id.is_empty() && !member(world_map.get("vitals"), &npc_id).truthy() {
            if let Some(Value::Object(vitals)) = world_map.get_mut("vitals") {
                assign_key(vitals, &npc_id, safe_vital(vitality));
            }
        }
    }
    if kind == Some("NpcHarmed") && !npc_id.is_empty() {
        let schema_two = get(payload, "schema_version").and_then(Value::as_f64) == Some(2.0);
        let alive = (schema_two && js::is_true(get(payload, "non_lethal")) && js::is_true(get(payload, "alive"))) || js::number(get(payload, "hp_after")) > 0.0;
        let vital = vital_value(get(payload, "hp_after"), get(payload, "max_hp"), Some(&Value::Bool(alive)));
        if let Some(Value::Object(vitals)) = world_map.get_mut("vitals") {
            assign_key(vitals, &npc_id, vital);
        }
    }
    if kind == Some("NpcDied") && !npc_id.is_empty() {
        let mut before = match member(world_map.get("vitals"), &npc_id) {
            Member::Own(found) if !found.is_null() => spread(Some(found)),
            Member::Function | Member::Prototype => Map::new(),
            _ => match json!({ "hp": 0, "max_hp": 4, "alive": false }) {
                Value::Object(map) => map,
                _ => Map::new(),
            },
        };
        before.insert("hp".into(), json!(0));
        before.insert("alive".into(), json!(false));
        if let Some(Value::Object(vitals)) = world_map.get_mut("vitals") {
            assign_key(vitals, &npc_id, Value::Object(before));
        }
    }
    if kind == Some("NpcStanceChanged") && !npc_id.is_empty() {
        let source = get(payload, "source_event_id");
        let source = if js::truthy(source) { source } else { event.get("event_id") };
        let stance = stance_value(get(payload, "stance"), get(payload, "reason"), source, get(payload, "propagation_depth"));
        if let Some(Value::Object(stances)) = world_map.get_mut("stances") {
            assign_key(stances, &npc_id, stance);
        }
    }
    // Вещь, которую NPC отдаёт из своих рук (упокоенный рыцарь — Слезу),
    // уходит из его инвентаря тем же событием, что кладёт её герою.
    let owner_id = text(get(payload, "source_npc_id"), 120);
    if kind == Some("ItemGranted") && !owner_id.is_empty() {
        // Вещь узнаётся по любому из двух ключей: в руках NPC у неё может быть
        // только `id`, а выданная герою уже несёт и `item_instance_id`.
        let item = get(payload, "item");
        let keys: HashSet<String> = [get(item, "item_instance_id"), get(item, "id")].into_iter().map(|value| text(value, 160)).filter(|key| !key.is_empty()).collect();
        let inventory: Vec<Value> = world_map.get("inventories").and_then(|map| map.get(&owner_id)).map(|value| array(Some(value)).to_vec()).unwrap_or_default();
        let index = inventory.iter().position(|entry| [get(Some(entry), "item_instance_id"), get(Some(entry), "id")].into_iter().any(|value| keys.contains(&text(value, 160))));
        if let Some(index) = index {
            let remaining: Vec<Value> = inventory.into_iter().enumerate().filter(|(position, _)| *position != index).map(|(_, entry)| entry).collect();
            if let Some(Value::Object(inventories)) = world_map.get_mut("inventories") {
                inventories.insert(owner_id, Value::Array(remaining));
            }
        }
    }
    if kind == Some("ItemTransferred") && get(payload, "recipient_kind").and_then(Value::as_str) == Some("npc") {
        let recipient_id = text(get(payload, "to_actor_id"), 120);
        let item = get(payload, "item");
        let mut source = if js::truthy(item) && matches!(item, Some(Value::Object(_) | Value::Array(_))) { spread(item) } else { Map::new() };
        source.insert("quantity".into(), json!(1.max(integer(get(payload, "quantity"), 1))));
        source.insert("equipped".into(), json!(false));
        source.insert("attuned_to".into(), Value::Null);
        let incoming = safe_npc_inventory(Some(&Value::Array(vec![Value::Object(source)])), legacy).into_iter().next();
        if let (false, Some(incoming)) = (recipient_id.is_empty(), incoming) {
            let mut inventory: Vec<Value> = world_map.get("inventories").and_then(|map| map.get(&recipient_id)).map(|value| array(Some(value)).to_vec()).unwrap_or_default();
            let stack_key = inventory_stack_key(Some(&incoming));
            let stack_index = if js::is_false(get(payload, "stackable")) { None } else { inventory.iter().position(|entry| inventory_stack_key(Some(entry)) == stack_key) };
            let changed = match stack_index {
                Some(index) => {
                    let quantity = MAX_STOCK_QUANTITY.min(integer(inventory[index].get("quantity"), 1) + integer(incoming.get("quantity"), 1));
                    let mut merged = spread(Some(&inventory[index]));
                    merged.insert("quantity".into(), json!(quantity));
                    inventory[index] = Value::Object(merged);
                    true
                }
                None if inventory.len() < MAX_NPC_INVENTORY_ITEMS => {
                    inventory.push(incoming);
                    true
                }
                None => false,
            };
            if changed {
                if let Some(Value::Object(inventories)) = world_map.get_mut("inventories") {
                    inventories.insert(recipient_id, Value::Array(inventory));
                }
            }
        }
    }
    normalize_npc_world_state(Some(&world), options)
}

fn public_health_status(vital: &Value) -> &'static str {
    if !js::truthy(vital.get("alive")) {
        return "dead";
    }
    let hp = js::number(vital.get("hp"));
    let max = js::number(vital.get("max_hp"));
    if hp * 2.0 <= max {
        "bloodied"
    } else if hp < max {
        "hurt"
    } else {
        "unharmed"
    }
}

/// `sceneNpcsForViewer(state)`: NPC текущей сцены глазами игрока — пост,
/// стойка, состояние здоровья словом и флаг входа в бой; ОЗ и профиль
/// остаются на сервере. Боевая копия NPC в активном бою не дублируется.
pub fn scene_npcs_for_viewer(state: &Value) -> Vec<Value> {
    let world = world_of(state);
    let location_id = scene_location_id(state);
    let combat_active = js::is_true(get(get(get(Some(state), "mechanics"), "combat"), "active"));
    let combat_npc_ids: HashSet<String> = if combat_active {
        let mut actors = array(get(Some(state), "enemies")).to_vec();
        actors.extend(array(get(Some(state), "actors")).iter().cloned());
        actors.iter().map(|actor| js::s(get(get(Some(actor), "origin"), "npc_id"))).filter(|id| !id.is_empty()).collect()
    } else {
        HashSet::new()
    };
    let no_vitals = json!({});
    let mut visible: Vec<Value> = present_in(state, Some(&no_vitals), social_npcs(state))
        .into_iter()
        .filter(|npc| !combat_npc_ids.contains(&js::string(npc.get("id"))))
        .filter(|npc| npc.get("visibility").and_then(Value::as_str) != Some("gm_only") || js::is_true(npc.get("reveal_on_presence")))
        .filter_map(|npc| {
            let id = js::string(npc.get("id"));
            let placement = placement_in(&world, &id, &location_id)?;
            let vital = match member(world.get("vitals"), &id) {
                Member::Own(found) if !found.is_null() => found.clone(),
                Member::Function | Member::Prototype => json!({}),
                _ => initial_npc_vital(Some(&npc)),
            };
            let stance = member(world.get("stances"), &id).field("stance");
            let stance = if stance.nullish() { json!("neutral") } else { stance.own().cloned().unwrap_or(Value::Null) };
            let mechanics = member(world.get("profiles"), &id);
            let open_profile = mechanics.truthy() && !MechanicsSupport::is(mechanics.field("status").own(), MechanicsSupport::RulingOnly);
            // `Boolean(…) && available && vital.alive && vital.hp > 0`: ложное
            // `vital.alive` возвращается как есть — `undefined` у унаследованной
            // функции в JSON не пишется.
            let can_start_combat: Option<Value> = if !open_profile || js::is_false(npc.get("available")) {
                Some(json!(false))
            } else if !js::truthy(vital.get("alive")) {
                vital.get("alive").cloned()
            } else {
                Some(json!(js::number(vital.get("hp")) > 0.0))
            };
            let mut entry = Map::new();
            entry.insert("id".into(), json!(id));
            entry.insert("name".into(), json!(text(npc.get("name"), 160)));
            entry.insert("role".into(), json!(text(npc.get("role"), 160)));
            entry.insert("location_id".into(), json!(location_id));
            entry.insert("x".into(), placement.get("x").cloned().unwrap_or(Value::Null));
            entry.insert("y".into(), placement.get("y").cloned().unwrap_or(Value::Null));
            let anchor = placement.get("anchor_prop_id").filter(|value| js::truthy(Some(value))).cloned().unwrap_or(Value::Null);
            entry.insert("anchor_prop_id".into(), anchor);
            if let Some(footprint) = normalize_footprint_metadata(placement.get("footprint")) {
                entry.insert("footprint".into(), footprint.to_value());
            }
            entry.insert("stance".into(), stance);
            set_or_remove(&mut entry, "alive", vital.get("alive"));
            entry.insert("health_status".into(), json!(public_health_status(&vital)));
            // Флаг говорит только о доступности входа в бой. Сам профиль и его
            // характеристики остаются закрытыми серверной проекцией.
            set_or_remove(&mut entry, "can_start_combat", can_start_combat.as_ref());
            Some(Value::Object(entry))
        })
        .collect();
    visible.sort_by(|left, right| jstext::locale_compare(&js::s(left.get("id")), &js::s(right.get("id"))));
    visible.truncate(MAX_VISIBLE_NPCS);
    visible
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_id_is_24_hex() {
        let id = stable_id(&["a".into(), String::new(), "3".into()]);
        assert_eq!(id.len(), 24);
        assert_eq!(id, &digest(&["a".into(), String::new(), "3".into()])[..24]);
    }

    #[test]
    fn normalize_drops_records_without_ids_and_dedupes_posts() {
        let world = normalize_npc_world_state(
            Some(&json!({
                "placements": [
                    { "npc_id": "a", "location_id": "x", "x": 1, "y": 2 },
                    { "npc_id": "a", "location_id": "x", "x": 3, "y": 4 },
                    { "npc_id": "", "location_id": "x", "x": 1, "y": 2 },
                    { "npc_id": "b", "location_id": "x", "x": 1.5, "y": 2 },
                ],
                "vitals": { "a": { "hp": 900, "max_hp": 900 }, " ": { "hp": 1 } },
                "stances": { "a": { "stance": "hostile", "propagation_depth": 5 } },
            })),
            &Value::Null,
        );
        assert_eq!(world["placements"].as_array().map(Vec::len), Some(1));
        assert_eq!(world["placements"][0]["x"], json!(1));
        assert_eq!(world["placements"][0]["placement_reason"], json!("deterministic-post"));
        assert_eq!(world["vitals"], json!({ "a": { "hp": 500, "max_hp": 500, "alive": true } }));
        assert_eq!(world["stances"]["a"]["propagation_depth"], json!(1));
    }

    #[test]
    fn initial_vital_by_role() {
        assert_eq!(initial_npc_vital(Some(&json!({ "role": "Ветеран стражи" })))["hp"], json!(18));
        assert_eq!(initial_npc_vital(Some(&json!({ "role": "", "tags": ["hunter"] })))["hp"], json!(11));
        assert_eq!(initial_npc_vital(Some(&json!({ "role": "кузнец" })))["hp"], json!(7));
        assert_eq!(initial_npc_vital(None)["hp"], json!(4));
    }
}

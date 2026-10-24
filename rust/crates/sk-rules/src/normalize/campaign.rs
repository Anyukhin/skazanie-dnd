//! Нормализация состояния кампании `normalizeCampaignState` и производные поля
//! героя. Задача Р4б.
//!
//! JS: `server/rules-engine.mjs`, 1663–2219 (`inferredItemCombat`,
//! `normalizeInventory`, `normalizeEnemyKnowledge`, `normalizeProgression`,
//! `normalizeSceneInteractions`, `defaultMechanics`, `encounterWithoutLoadouts`,
//! `withoutDerivedPlayerFields`, `normalizeCampaignState`). Пересчёт
//! производных полей после события (`refreshPlayerDerivedState`, 23603) —
//! `reduce/items.rs`.
//!
//! Порядок ключей — как у JS: поле, которое уже было в объекте, остаётся на
//! своём месте (`IndexMap::insert`), новое встаёт в конец, удаление —
//! `shift_remove`. Производные поля героя обнуляются (`null`), а не удаляются,
//! чтобы ключ остался на прежнем месте.
//!
//! Ошибки, которые JS не ловит (`TypeError` на `null` вместо героя, отказ
//! предыстории, карты мира, памяти сцены, груза), обрывают нормализацию
//! `Halt::Fault` с текстом JS, как `throw` в JS.

use serde_json::{json, Map, Value};
use sk_core::game::{actor_id, list_actors};
use sk_core::js::{self, is_true, present, safe_int, truthy};
use sk_core::re;
use sk_core::text as jstext;

use crate::constants::{class_hit_point_die_size, REST_EVENT_SCHEMA_VERSION, REST_MINIMUM_MINUTES_LONG, REST_MINIMUM_MINUTES_SHORT, REST_POLICY_ID, TURN_REACTION_EXTENSION_LIMIT};
use crate::core::{slice_utf16, unique_strings};
use crate::pause::{Fault, Halt};
use crate::turn_economy::{action_economy, normalize_loading_weapon_item_ids};
use crate::world_clock::{duration_in_minutes_exact, normalized_clock_seconds};

/// `MILESTONES_PER_LEVEL`.
pub const MILESTONES_PER_LEVEL: i64 = 3;

/// `ENEMY_KNOWLEDGE_FACTS`.
pub const ENEMY_KNOWLEDGE_FACTS: [&str; 4] = ["health", "armor_class", "speed", "stat_block"];

/// `DERIVED_PLAYER_FIELDS`.
pub const DERIVED_PLAYER_FIELDS: [&str; 4] = ["combatSpells", "combatActions", "characterSheet", "inventoryLoad"];

/// `READIED_TRIGGERS` (ключи).
const READIED_TRIGGERS: [&str; 2] = ["enemy-approaches", "enemy-casts-spell"];

/// `MAX_STOCK_QUANTITY` (`merchant-economy.mjs`).
const MAX_STOCK_QUANTITY: i64 = sk_economy::merchant_economy::MAX_STOCK_QUANTITY;

/// `MAX_CHARACTER_LEVEL` (`character-lifecycle.mjs`).
const MAX_CHARACTER_LEVEL: i64 = sk_character::character_lifecycle::MAX_CHARACTER_LEVEL;

fn type_error(message: impl Into<String>) -> Halt {
    Halt::Fault(Fault::type_error(message))
}

fn error(message: impl Into<String>) -> Halt {
    Halt::Fault(Fault::new("Error", message))
}

/// `Object.entries(value)` для значения любого вида: у объекта — его поля в
/// порядке JS, у массива — индексы, у строки — символы; иначе пусто.
fn entries_of(value: Option<&Value>) -> Vec<(String, Value)> {
    match value {
        Some(Value::Object(map)) => js::entries(map).into_iter().map(|(key, value)| (key.clone(), value.clone())).collect(),
        Some(Value::Array(items)) => items.iter().enumerate().map(|(index, item)| (index.to_string(), item.clone())).collect(),
        Some(Value::String(text)) => text.chars().enumerate().map(|(index, ch)| (index.to_string(), Value::String(ch.to_string()))).collect(),
        _ => Vec::new(),
    }
}

/// `{ ...value }`: поля объекта, индексы массива или строки; иначе пусто.
fn spread_of(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map.clone(),
        other => entries_of(other).into_iter().collect(),
    }
}

/// `typeof value === 'object' && value !== null` (массив тоже объект).
fn is_object_like(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Object(_) | Value::Array(_)))
}

/// `value ?? fallback`.
fn nullish<'a>(value: Option<&'a Value>, fallback: Option<&'a Value>) -> Option<&'a Value> {
    match value {
        None | Some(Value::Null) => fallback,
        some => some,
    }
}

/// `inferredItemCombat(item)` (1663).
pub fn inferred_item_combat(item: &Value) -> Option<Value> {
    let combat = item.get("combat");
    if truthy(combat) && is_object_like(combat) {
        return combat.cloned();
    }
    let text = jstext::lower(&format!("{} {}", js::s(item.get("name")), js::s(item.get("properties"))));
    if jstext::test(re!(r"динамит|dynamite", "u"), &text) {
        return Some(json!({ "kind": "thrown-area", "ability": "dex", "damage": "3d6", "damageType": "fire", "normalRange": 60, "radius": 10, "saveAbility": "dex", "saveDc": 12, "halfOnSave": true }));
    }
    if jstext::test(re!(r"гранат|бомб|grenade|bomb", "u"), &text) {
        return Some(json!({ "kind": "thrown-area", "ability": "dex", "damage": "2d6", "damageType": "fire", "normalRange": 60, "radius": 10, "saveAbility": "dex", "saveDc": 12, "halfOnSave": true }));
    }
    if jstext::test(re!(r"арбалет|crossbow", "u"), &text) {
        return Some(json!({ "kind": "ranged", "ability": "dex", "damage": "1d8", "damageType": "piercing", "normalRange": 80, "longRange": 320, "twoHanded": true, "ammunition": true }));
    }
    if jstext::test(re!(r"длинн.{0,3}лук|longbow", "u"), &text) {
        return Some(json!({ "kind": "ranged", "ability": "dex", "damage": "1d8", "damageType": "piercing", "normalRange": 150, "longRange": 600, "twoHanded": true, "ammunition": true }));
    }
    if jstext::test(re!(r"лук|bow", "u"), &text) {
        return Some(json!({ "kind": "ranged", "ability": "dex", "damage": "1d6", "damageType": "piercing", "normalRange": 80, "longRange": 320, "twoHanded": true, "ammunition": true }));
    }
    None
}

/// `normalizeInventory(input, ownerId)` (1674).
pub fn normalize_inventory(input: Option<&Value>, owner_id: &str) -> Vec<Value> {
    let Some(Value::Array(items)) = input else { return Vec::new() };
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();
    for (index, raw) in items.iter().take(200).enumerate() {
        let Value::Object(fields) = raw else { continue };
        let quantity = safe_int(fields.get("quantity"), 1);
        if quantity <= 0 {
            continue;
        }
        let fallback = format!("{owner_id}-item-{}", index + 1);
        let raw_id = match fields.get("id") {
            None | Some(Value::Null) => fallback.clone(),
            some => js::s(some),
        };
        let trimmed = slice_utf16(jstext::trim(&raw_id), 120);
        let base = if trimmed.is_empty() { fallback } else { trimmed };
        let mut id = base.clone();
        let mut suffix = index + 1;
        while seen.contains(&id) {
            id = format!("{}-{suffix}", slice_utf16(&base, 108));
            suffix += 1;
        }
        seen.insert(id.clone());
        let mut item = fields.clone();
        item.insert("id".into(), Value::String(id.clone()));
        item.insert("quantity".into(), Value::from(quantity.min(MAX_STOCK_QUANTITY)));
        let item = Value::Object(item);
        let mut merged = item.clone();
        if let Some(combat) = inferred_item_combat(&item) {
            merged["combat"] = combat;
        }
        let options = sk_economy::merchant_economy::InventoryItemOptions { id_fallback: &id, preserve_unknown: true, hydrate_catalog: false };
        result.push(sk_economy::merchant_economy::normalize_inventory_item(Some(&merged), options));
    }
    result
}

/// `normalizeEnemyKnowledge(input)` (1714).
pub fn normalize_enemy_knowledge(input: Option<&Value>) -> Value {
    let party = input.and_then(|source| source.as_object()).and_then(|source| source.get("party")).filter(|party| party.is_object());
    let mut known_party = Map::new();
    if let Some(Value::Object(party)) = party {
        for (enemy_id, facts) in js::entries(party).into_iter().take(500) {
            let id = slice_utf16(enemy_id, 120);
            let Some(Value::Object(facts)) = Some(facts) else { continue };
            if id.is_empty() {
                continue;
            }
            let mut known = Map::new();
            for fact in ENEMY_KNOWLEDGE_FACTS {
                let value = facts.get(fact);
                if value.and_then(Value::as_str) == Some("exact") || is_true(value) {
                    known.insert(fact.into(), Value::String("exact".into()));
                }
            }
            if !known.is_empty() {
                known_party.insert(id, Value::Object(known));
            }
        }
    }
    json!({ "party": Value::Object(known_party) })
}

/// `normalizeProgression(input)` (1743).
pub fn normalize_progression(input: Option<&Value>) -> Value {
    let source = input.filter(|value| value.is_object());
    let entries: &[Value] = match source.and_then(|source| source.get("milestones")) {
        Some(Value::Array(items)) => items,
        _ => &[],
    };
    let start = entries.len().saturating_sub(200);
    let milestones: Vec<Value> = entries[start..]
        .iter()
        .map(|entry| {
            json!({
                "id": slice_utf16(&js::s(entry.get("id")), 160),
                "milestone": slice_utf16(&js::s(entry.get("milestone")), 160),
                "encounter_id": slice_utf16(&js::s(entry.get("encounter_id")), 160),
            })
        })
        .filter(|entry| entry["id"].as_str().is_some_and(|id| !id.is_empty()))
        .collect();
    let since = safe_int(source.and_then(|source| source.get("milestones_since_level")), milestones.len() as i64).max(0);
    json!({
        "milestones": milestones,
        "milestones_since_level": since,
        "milestones_per_level": MILESTONES_PER_LEVEL,
        "level_up_available": since >= MILESTONES_PER_LEVEL,
    })
}

/// `String(value).slice(0, n)` либо `null` для `value == null`.
fn optional_text(value: Option<&Value>, limit: usize) -> Value {
    if present(value) {
        Value::String(slice_utf16(&js::s(value), limit))
    } else {
        Value::Null
    }
}

fn strings_head(value: Option<&Value>, limit: usize) -> Value {
    js::strings_value(unique_strings(value).into_iter().take(limit))
}

/// `normalizeSceneInteractions(input)` (1759).
pub fn normalize_scene_interactions(input: Option<&Value>) -> Value {
    let mut result = Map::new();
    let Some(Value::Object(source)) = input else { return Value::Object(result) };
    for (prop_id, value) in js::entries(source).into_iter().take(2_000) {
        let Value::Object(value) = value else { continue };
        if prop_id.is_empty() {
            continue;
        }
        let get = |key: &str| value.get(key);
        let state = match get("state") {
            None | Some(Value::Null) => "idle".to_string(),
            some => js::s(some),
        };
        result.insert(
            slice_utf16(prop_id, 120),
            json!({
                "state": slice_utf16(&state, 40),
                "inspected": is_true(get("inspected")),
                "inspection_attempted": is_true(get("inspection_attempted")) || is_true(get("inspected")),
                "inspection_attempted_by": strings_head(get("inspection_attempted_by"), 120),
                "opened": is_true(get("opened")),
                "taken": is_true(get("taken")),
                "used": is_true(get("used")),
                "used_by": strings_head(get("used_by"), 120),
                "loot_claimed": is_true(get("loot_claimed")),
                "loot_revealed": is_true(get("loot_revealed")),
                "trap_detected": is_true(get("trap_detected")),
                "lockpicked": is_true(get("lockpicked")),
                "lockpicked_by": optional_text(get("lockpicked_by"), 120),
                "knowledge_ids": strings_head(get("knowledge_ids"), 24),
                "last_actor_id": optional_text(get("last_actor_id"), 120),
            }),
        );
    }
    Value::Object(result)
}

/// `defaultMechanics()` (1786).
pub fn default_mechanics() -> Value {
    json!({
        "schema_version": 1,
        "temporary_hp": {},
        "resources": {},
        "hit_point_dice": {},
        "resting": {},
        "conditions": {},
        "defenses": {},
        "concentration": {},
        "positions": {},
        "item_appraisals": {},
        "scene_interactions": {},
        "encounter": null,
        "active_effects": [],
        "progression": { "milestones": [], "milestones_since_level": 0, "milestones_per_level": MILESTONES_PER_LEVEL, "level_up_available": false },
        "shapes": {},
        "death": { "campaign_status": "active", "heroes": {}, "saving_throws": {} },
        "campaign_lifecycle": {
            "schema_version": 1, "status": "active", "reason": null, "paused_at": null, "concluded_at": null,
            "archived_at": null, "epilogue": null, "changed_by": null,
        },
        "combat": default_combat(),
    })
}

/// `defaultMechanics().combat`.
fn default_combat() -> Value {
    json!({
        "active": false,
        "round": 0,
        "initiative": [],
        "active_index": -1,
        "action_economy": {},
        "reaction_window": null,
        "readied": {},
        "group_initiative": false,
        "turn_completed": [],
        "truce": null,
        "parley_attempts": 0,
    })
}

/// `encounterWithoutLoadouts(encounter)` (1903).
pub fn encounter_without_loadouts(encounter: &Value) -> Value {
    let mut copy = encounter.clone();
    if let Some(Value::Array(enemies)) = copy.get_mut("enemies") {
        for enemy in enemies.iter_mut() {
            if let Value::Object(fields) = enemy {
                fields.shift_remove("loadout");
            }
        }
    }
    copy
}

/// `withoutDerivedPlayerFields(players)` (1925).
pub fn without_derived_player_fields(players: &Value) -> Value {
    let Value::Array(list) = players else { return players.clone() };
    Value::Array(
        list.iter()
            .map(|player| {
                let Value::Object(fields) = player else { return player.clone() };
                let mut stripped = fields.clone();
                for field in DERIVED_PLAYER_FIELDS {
                    if let Some(slot) = stripped.get_mut(field) {
                        *slot = Value::Null;
                    }
                }
                Value::Object(stripped)
            })
            .collect(),
    )
}

/// Поле `state.mechanics?.<key>`.
fn raw_mechanics<'a>(source: &'a Value, key: &str) -> Option<&'a Value> {
    source.get("mechanics").and_then(|mechanics| mechanics.get(key))
}

/// `clone(value ?? {})`.
fn clone_or_object(value: Option<&Value>) -> Value {
    match value {
        None | Some(Value::Null) => Value::Object(Map::new()),
        Some(other) => other.clone(),
    }
}

/// `Object.fromEntries(Object.entries(clone(value ?? {})).filter(([id, x]) => id && x && typeof x === 'object'))`.
fn object_entries(value: Option<&Value>) -> Vec<(String, Value)> {
    entries_of(Some(&clone_or_object(value))).into_iter().filter(|(id, entry)| !id.is_empty() && is_object_like(Some(entry))).collect()
}

fn hit_point_dice(source: &Value) -> Result<Value, Halt> {
    let players: &[Value] = source.get("players").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    // `(state.players ?? []).find` — у не-массива метода нет.
    let players_findable = matches!(source.get("players"), None | Some(Value::Null | Value::Array(_)));
    let mut result = Map::new();
    for (id, pool) in object_entries(raw_mechanics(source, "hit_point_dice")) {
        if !players_findable {
            return Err(type_error("(state.players ?? []).find is not a function"));
        }
        let Some(actor) = players.iter().find(|candidate| actor_id(candidate) == id) else { continue };
        let maximum = safe_int(actor.get("level"), 1).clamp(1, 12);
        let die_size = crate::tables::character_class_key(actor).and_then(|key| class_hit_point_die_size(&key)).unwrap_or(8);
        result.insert(
            id,
            json!({
                "schema_version": 1,
                "maximum": maximum,
                "spent": safe_int(pool.get("spent"), 0).min(maximum).max(0),
                "die_size": die_size,
            }),
        );
    }
    Ok(Value::Object(result))
}

fn resting(source: &Value) -> Value {
    let mut result = Map::new();
    for (id, rest) in object_entries(raw_mechanics(source, "resting")) {
        let long = rest.get("kind").and_then(Value::as_str) == Some("long");
        let mut entry = Map::new();
        entry.insert("kind".into(), Value::String(if long { "long" } else { "short" }.into()));
        if js::number(rest.get("schema_version")) >= REST_EVENT_SCHEMA_VERSION as f64 {
            entry.insert("schema_version".into(), Value::from(REST_EVENT_SCHEMA_VERSION));
            entry.insert("policy_id".into(), Value::String(REST_POLICY_ID.into()));
            entry.insert("rest_id".into(), Value::String(slice_utf16(&js::s(rest.get("rest_id")), 180)));
            entry.insert("started_at_minutes".into(), Value::from(safe_int(rest.get("started_at_minutes"), 0).max(0)));
            let fallback = if long { REST_MINIMUM_MINUTES_LONG } else { REST_MINIMUM_MINUTES_SHORT };
            entry.insert("minimum_duration_minutes".into(), Value::from(safe_int(rest.get("minimum_duration_minutes"), fallback).max(REST_MINIMUM_MINUTES_SHORT)));
        }
        if rest.get("reason").and_then(Value::as_str) == Some("knockout") {
            entry.insert("reason".into(), Value::String("knockout".into()));
            entry.insert("recovery_minutes_remaining".into(), Value::from(safe_int(rest.get("recovery_minutes_remaining"), 60).clamp(1, 60)));
        }
        result.insert(id, Value::Object(entry));
    }
    Value::Object(result)
}

fn world_time(source: &Value) -> Value {
    let empty = Value::Object(Map::new());
    let raw = nullish(raw_mechanics(source, "world_time"), Some(&empty)).unwrap_or(&empty);
    let elapsed_field = raw.get("elapsed_minutes");
    let elapsed = if present(elapsed_field) && js::is_safe_integer_number(elapsed_field) {
        js::number(elapsed_field).max(0.0)
    } else {
        duration_in_minutes_exact(raw.get("amount"), raw.get("unit"))
    };
    let remainder = raw.get("second_remainder");
    let carried = (normalized_clock_seconds(js::number(remainder)) / 60.0).floor();
    let mut time = Map::new();
    time.insert("amount".into(), js::num(elapsed + carried));
    time.insert("unit".into(), Value::String("minute".into()));
    time.insert("elapsed_minutes".into(), js::num(elapsed + carried));
    if present(remainder) {
        time.insert("second_remainder".into(), js::num(normalized_clock_seconds(normalized_clock_seconds(js::number(remainder)) % 60.0)));
    }
    Value::Object(time)
}

fn death(source: &Value) -> Value {
    let death = raw_mechanics(source, "death");
    let status = if death.and_then(|death| death.get("campaign_status")).and_then(Value::as_str) == Some("party_defeated") { "party_defeated" } else { "active" };
    let mut heroes = Map::new();
    for (id, fate) in object_entries(death.and_then(|death| death.get("heroes"))) {
        let get = |key: &str| fate.get(key);
        let resolution = js::string(get("resolution"));
        let mut entry = Map::new();
        entry.insert("status".into(), Value::String(if get("status").and_then(Value::as_str) == Some("dead") { "dead" } else { "resolved" }.into()));
        entry.insert("resolution".into(), if resolution == "resurrected" || resolution == "replaced" { Value::String(resolution) } else { Value::Null });
        entry.insert("died_at".into(), nullish(get("died_at"), None).cloned().unwrap_or(Value::Null));
        for key in ["died_round", "died_world_minutes"] {
            if js::is_safe_integer(get(key)) {
                entry.insert(key.into(), get(key).cloned().unwrap_or(Value::Null));
            }
        }
        entry.insert("resolved_at".into(), nullish(get("resolved_at"), None).cloned().unwrap_or(Value::Null));
        entry.insert("replacement_name".into(), optional_text(get("replacement_name"), 120));
        heroes.insert(id, Value::Object(entry));
    }
    let mut saving_throws = Map::new();
    for (id, tracker) in object_entries(death.and_then(|death| death.get("saving_throws"))) {
        let stable = is_true(tracker.get("stable"));
        let recovery = safe_int(tracker.get("recovery_minutes_remaining"), 0).clamp(0, 1_440);
        let mut entry = Map::new();
        entry.insert("successes".into(), Value::from(safe_int(tracker.get("successes"), 0).clamp(0, 2)));
        entry.insert("failures".into(), Value::from(safe_int(tracker.get("failures"), 0).clamp(0, 2)));
        entry.insert("stable".into(), Value::Bool(stable));
        if stable && recovery > 0 {
            entry.insert("recovery_minutes_remaining".into(), Value::from(recovery));
        }
        saving_throws.insert(id, Value::Object(entry));
    }
    json!({ "campaign_status": status, "heroes": Value::Object(heroes), "saving_throws": Value::Object(saving_throws) })
}

fn combat(source: &Value) -> Value {
    let Value::Object(mut combat) = default_combat() else { return default_combat() };
    for (key, value) in spread_of(nullish(raw_mechanics(source, "combat"), None)) {
        combat.insert(key, value);
    }
    let initiative = match combat.get("initiative") {
        Some(Value::Array(items)) => Value::Array(items.clone()),
        _ => Value::Array(Vec::new()),
    };
    combat.insert("initiative".into(), initiative);
    let window = combat.get("reaction_window").filter(|window| truthy(Some(window)) && is_object_like(Some(window))).cloned().unwrap_or(Value::Null);
    combat.insert("reaction_window".into(), window);
    let readied: Map<String, Value> = object_entries(combat.get("readied"))
        .into_iter()
        .filter(|(_, readied)| {
            let trigger = js::string(readied.get("trigger"));
            READIED_TRIGGERS.contains(&trigger.as_str()) || crate::command::rules::OBJECT_PROTOTYPE_KEYS.contains(&trigger.as_str())
        })
        .collect();
    combat.insert("readied".into(), Value::Object(readied));
    let group = is_true(combat.get("group_initiative"));
    combat.insert("group_initiative".into(), Value::Bool(group));
    let completed = js::strings_value(unique_strings(combat.get("turn_completed")));
    combat.insert("turn_completed".into(), completed);
    let active = truthy(combat.get("active"));
    if active && is_true(combat.get("round_time_pending")) {
        combat.insert("round_time_pending".into(), Value::Bool(true));
    } else {
        combat.shift_remove("round_time_pending");
    }
    let truce = if active { sk_society::parley::normalize_truce(combat.get("truce")).unwrap_or(Value::Null) } else { Value::Null };
    combat.insert("truce".into(), truce);
    let attempts = if active { safe_int(combat.get("parley_attempts"), 0).max(0) } else { 0 };
    combat.insert("parley_attempts".into(), Value::from(attempts));
    let extensions = safe_int(combat.get("turn_reaction_extensions"), 0).min(TURN_REACTION_EXTENSION_LIMIT).max(0);
    if extensions > 0 {
        combat.insert("turn_reaction_extensions".into(), Value::from(extensions));
    } else {
        combat.shift_remove("turn_reaction_extensions");
    }
    for key in ["turn_started_at", "turn_started_event_id"] {
        if present(combat.get(key)) {
            let text = js::s(combat.get(key));
            combat.insert(key.into(), Value::String(text));
        } else {
            combat.shift_remove(key);
        }
    }
    let mut economies = Map::new();
    for (id, economy) in entries_of(Some(&clone_or_object(combat.get("action_economy")))) {
        let Value::Object(mut entry) = action_economy() else { continue };
        if truthy(Some(&economy)) && is_object_like(Some(&economy)) {
            for (key, value) in spread_of(Some(&economy)) {
                entry.insert(key, value);
            }
        }
        let pick = |snake: &str, camel: &str| nullish(economy.get(snake), economy.get(camel)).cloned();
        entry.insert("movement_spent".into(), Value::from(safe_int(pick("movement_spent", "movementSpent").as_ref(), 0).max(0)));
        entry.insert("movement_bonus".into(), Value::from(safe_int(pick("movement_bonus", "movementBonus").as_ref(), 0).max(0)));
        entry.insert("extra_actions".into(), Value::from(safe_int(pick("extra_actions", "extraActions").as_ref(), 0).max(0)));
        entry.insert("surged_action_only".into(), Value::Bool(is_true(economy.get("surged_action_only"))));
        entry.insert("loading_weapon_item_ids".into(), normalize_loading_weapon_item_ids(pick("loading_weapon_item_ids", "loadingWeaponItemIds").as_ref()));
        economies.insert(id, Value::Object(entry));
    }
    combat.insert("action_economy".into(), Value::Object(economies));
    Value::Object(combat)
}

/// `state.mechanics` нормализации (без ресурсов и позиций существ — их
/// дописывает [`normalize_campaign_state`] после героев).
fn mechanics(source: &Value) -> Result<Value, Halt> {
    let Value::Object(mut mechanics) = default_mechanics() else { return Ok(default_mechanics()) };
    if let Some(Value::Object(raw)) = source.get("mechanics") {
        for (key, value) in raw {
            mechanics.insert(key.clone(), value.clone());
        }
    }
    let raw = |key: &str| raw_mechanics(source, key);
    mechanics.insert("temporary_hp".into(), Value::Object(spread_of(nullish(raw("temporary_hp"), None))));
    mechanics.insert("resources".into(), clone_or_object(raw("resources")));
    mechanics.insert("hit_point_dice".into(), hit_point_dice(source)?);
    mechanics.insert("resting".into(), resting(source));
    for key in ["conditions", "defenses", "concentration", "positions", "item_appraisals"] {
        mechanics.insert(key.into(), clone_or_object(raw(key)));
    }
    mechanics.insert("scene_interactions".into(), normalize_scene_interactions(raw("scene_interactions")));
    mechanics.insert("enemy_knowledge".into(), normalize_enemy_knowledge(raw("enemy_knowledge")));
    let preferences = sk_combat_base::reaction_preferences::normalize_reaction_preferences(raw("reaction_preferences"));
    if preferences.as_object().is_some_and(|map| !map.is_empty()) {
        mechanics.insert("reaction_preferences".into(), preferences);
    } else {
        mechanics.shift_remove("reaction_preferences");
    }
    let encounter = raw("encounter").filter(|encounter| truthy(Some(encounter)) && is_object_like(Some(encounter))).map(encounter_without_loadouts).unwrap_or(Value::Null);
    mechanics.insert("encounter".into(), encounter);
    let effects = match raw("active_effects") {
        Some(Value::Array(items)) => Value::Array(items.clone()),
        _ => Value::Array(Vec::new()),
    };
    mechanics.insert("active_effects".into(), effects);
    mechanics.insert("progression".into(), normalize_progression(raw("progression")));
    mechanics.insert("world_time".into(), world_time(source));
    let death = death(source);
    let lifecycle = sk_director::campaign_lifecycle::normalize_campaign_lifecycle(raw("campaign_lifecycle"), death.get("campaign_status"));
    mechanics.insert("death".into(), death);
    mechanics.insert("campaign_lifecycle".into(), lifecycle);
    mechanics.insert("combat".into(), combat(source));
    Ok(Value::Object(mechanics))
}

/// Герой нормализации (`state.players.map(...)`, 2097–2133).
fn normalize_player(state: &Value, player: &Value) -> Result<Value, Halt> {
    if player.is_null() {
        return Err(type_error("Cannot convert undefined or null to object"));
    }
    let ruleset_id = js::s(state.get("ruleset_id"));
    let fields = player.as_object();
    let has = |key: &str| fields.is_some_and(|fields| fields.contains_key(key));
    let mut normalized = Value::Object(spread_of(Some(player)));
    if has("subclass") {
        match sk_combat_content::combat_actions::normalized_combat_subclass_for(Some(player)) {
            Some(subclass) => normalized["subclass"] = Value::String(subclass),
            None => js::delete(&mut normalized, "subclass"),
        }
    }
    if has("classSkillProficiencies") {
        normalized["classSkillProficiencies"] = js::strings_value(sk_ruleset::character_progression::normalized_class_skill_proficiencies(Some(&normalized)));
    }
    if matches!(player.get("backgroundChoices").and_then(|choices| choices.get("replacementSkills")), Some(Value::Array(_))) {
        let benefits = sk_ruleset::backgrounds::with_background_benefits(Some(&normalized), &ruleset_id).map_err(|failure| error(format!("{failure:?}")))?;
        js::assign(&mut normalized, benefits);
    }
    if has("selectedFeatureIds") {
        normalized["selectedFeatureIds"] = js::strings_value(sk_ruleset::character_progression::normalized_selected_feature_ids(Some(&normalized)));
    }
    let selections = sk_combat_content::combat_spells::normalized_spell_selections_for(Some(&normalized));
    for key in ["knownSpellIds", "preparedSpellIds"] {
        if has(key) {
            normalized[key] = nullish(selections.get(key), None).cloned().unwrap_or_else(|| Value::Array(Vec::new()));
        }
    }
    let level = safe_int(player.get("level"), 1).clamp(1, 12);
    let proficiency = sk_character::character_lifecycle::proficiency_bonus_for_level(Some(&Value::from(level))).map_err(|failure| error(failure.message.clone()))?;
    let options = json!({ "rulesetId": state.get("ruleset_id").cloned().unwrap_or(Value::Null) });
    let spells = sk_combat_content::combat_spells::combat_spells_for(Some(&normalized), Some(&options));
    let mut actions = sk_combat_content::combat_actions::combat_actions_for(Some(&normalized));
    if let Some(continuation) = crate::enervation_link::enervation_continuation_action_for(state, normalized.get("id"), None) {
        actions.push(continuation);
    }
    let owner = match player.get("id") {
        None | Some(Value::Null) => "actor".to_string(),
        some => js::s(some),
    };
    let mut actor = match normalized {
        Value::Object(fields) => fields,
        _ => Map::new(),
    };
    actor.insert("level".into(), Value::from(level));
    actor.insert("experience".into(), Value::from(safe_int(player.get("experience"), 0).max(0)));
    actor.insert("proficiency".into(), Value::from(proficiency));
    actor.insert("hp".into(), Value::from(safe_int(player.get("hp"), 0).max(0)));
    actor.insert("maxHp".into(), Value::from(safe_int(nullish(player.get("maxHp"), player.get("max_hp")), 1).max(1)));
    actor.insert("currency".into(), sk_economy::merchant_economy::normalize_currency(player.get("currency")));
    actor.insert("inventory".into(), Value::Array(normalize_inventory(player.get("inventory"), &owner)));
    actor.insert("combatSpells".into(), Value::Array(spells));
    actor.insert("combatActions".into(), Value::Array(actions));
    let actor = Value::Object(actor);
    let options = sk_combat_content::combat_actions::class_resource_options_for(Some(state)).to_value();
    let sheet = sk_character::character_lifecycle::derive_character_sheet(Some(&actor), Some(&options)).unwrap_or(Value::Null);
    let load = sk_items_life::item_lifecycle::inventory_load_for(Some(&actor)).map_err(|failure| type_error(failure.message()))?;
    let Value::Object(mut with_load) = actor else { unreachable!("герой нормализации — объект") };
    with_load.insert("inventoryLoad".into(), load);
    with_load.insert("characterSheet".into(), sheet);
    Ok(crate::geometry::footprint::normalize_actor_footprint_fields_owned(Value::Object(with_load)))
}

/// Общие поля прочих существ и противников (`hp`, `maxHp`, `alive`).
fn vital_fields(actor: &Value, fields: &mut Map<String, Value>) {
    let hp = safe_int(actor.get("hp"), 0);
    fields.insert("hp".into(), Value::from(hp.max(0)));
    fields.insert("maxHp".into(), Value::from(safe_int(nullish(actor.get("maxHp"), actor.get("max_hp")), 1).max(1)));
    fields.insert("alive".into(), Value::Bool(!js::is_false(actor.get("alive")) && hp > 0));
}

fn null_read(field: &str) -> Halt {
    type_error(format!("Cannot read properties of null (reading '{field}')"))
}

/// `normalizeCampaignState(rawState)` (1936–2219): копия состояния со всеми
/// умолчаниями и производными полями. Вход не меняется.
pub fn normalize_campaign_state(input: &Value) -> Result<Value, Halt> {
    let empty = Value::Object(Map::new());
    let source = if is_object_like(Some(input)) { input } else { &empty };
    let Value::Object(source_fields) = source else {
        // Массив вместо состояния: JS кладёт поля на сам массив, и
        // `JSON.stringify` их не печатает. Такое состояние не играбельно.
        return Err(type_error("normalizeCampaignState: состояние — массив"));
    };
    let mut fields = source_fields.clone();
    // `worldMemory: undefined` — ключ остаётся на своём месте (или встаёт в
    // конец), значение пересоздаёт память ниже.
    fields.insert("worldMemory".into(), Value::Null);
    if let Some(players) = source_fields.get("players") {
        fields.insert("players".into(), without_derived_player_fields(players));
    }
    let mut state = Value::Object(fields);
    let start_level = safe_int(nullish(state.get("character_start_level"), state.get("characterStartLevel")), 1).clamp(1, MAX_CHARACTER_LEVEL).max(1);
    state["character_start_level"] = Value::from(start_level);
    let mechanics = mechanics(&state)?;
    let version = safe_int(nullish(state.get("state_version"), state.get("stateVersion")), 0).max(0);
    state["state_version"] = Value::from(version);
    state["engine_mode"] = Value::String("enforce".into());
    let pick_truthy = |first: &str, second: &str, fallback: &str, state: &Value| -> String {
        [state.get(first), state.get(second)].into_iter().find(|value| truthy(*value)).map(|value| js::s(value)).unwrap_or_else(|| fallback.to_string())
    };
    let ruleset_id = pick_truthy("ruleset_id", "rulesetId", sk_ruleset::rules_core::DEFAULT_RULESET_ID, &state);
    state["ruleset_id"] = Value::String(ruleset_id.clone());
    let ruleset_version = pick_truthy("ruleset_version", "rulesetVersion", "5.2.1", &state);
    state["ruleset_version"] = Value::String(ruleset_version);
    let mut packs = unique_strings(nullish(state.get("enabled_rule_packs"), state.get("enabledRulePacks")));
    if packs.is_empty() {
        packs = vec![ruleset_id];
    }
    state["enabled_rule_packs"] = js::strings_value(packs);
    let mut house_rules = unique_strings(nullish(state.get("enabled_house_rules"), state.get("enabledHouseRules")));
    state["enabled_house_rules"] = js::strings_value(house_rules.clone());
    let locked_at = nullish(state.get("ruleset_locked_at"), state.get("rulesetLockedAt")).cloned().unwrap_or(Value::Null);
    state["ruleset_locked_at"] = locked_at;
    state["ruleset_selection_locked"] = Value::Bool(is_true(state.get("ruleset_selection_locked")) || is_true(state.get("rulesetSelectionLocked")));
    state["mechanics"] = mechanics;

    let players = match state.get("players") {
        Some(Value::Array(players)) => {
            let mut normalized = Vec::with_capacity(players.len());
            for player in players {
                normalized.push(normalize_player(&state, player)?);
            }
            normalized
        }
        _ => Vec::new(),
    };
    state["players"] = Value::Array(players);
    let actors = match state.get("actors") {
        Some(Value::Array(actors)) => {
            let mut normalized = Vec::with_capacity(actors.len());
            for actor in actors {
                if actor.is_null() {
                    return Err(null_read("id"));
                }
                let mut fields = spread_of(Some(actor));
                let id = js::s(nullish(actor.get("id"), actor.get("actor_id")));
                fields.insert("id".into(), Value::String(id));
                vital_fields(actor, &mut fields);
                let normalized_actor = crate::geometry::footprint::normalize_actor_footprint_fields_owned(Value::Object(fields));
                if truthy(normalized_actor.get("id")) {
                    normalized.push(normalized_actor);
                }
            }
            normalized
        }
        _ => Vec::new(),
    };
    state["actors"] = Value::Array(actors);
    let player_ids: Vec<String> = {
        let mut ids: Vec<String> = Vec::new();
        for player in state["players"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
            let id = js::string(player.get("id"));
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        ids
    };
    let party_name = [state.get("partyName")].into_iter().find(|value| truthy(*value)).map(|value| js::s(value)).unwrap_or_else(|| "Отряд героев".to_string());
    state["partyName"] = Value::String(slice_utf16(&party_name, 120));
    let mut members: Vec<String> = unique_strings(state.get("partyMemberIds")).into_iter().filter(|id| player_ids.contains(id)).collect();
    if members.is_empty() {
        members = player_ids.clone();
    }
    state["partyMemberIds"] = js::strings_value(members);
    let enemies = match state.get("enemies") {
        Some(Value::Array(enemies)) => {
            let mut normalized = Vec::with_capacity(enemies.len());
            for enemy in enemies {
                if enemy.is_null() {
                    return Err(null_read("hp"));
                }
                let mut fields = spread_of(Some(enemy));
                vital_fields(enemy, &mut fields);
                fields.insert("loadout".into(), sk_economy::enemy_loadouts::normalize_enemy_loadout(enemy.get("loadout")));
                normalized.push(crate::geometry::footprint::normalize_actor_footprint_fields_owned(Value::Object(fields)));
            }
            normalized
        }
        _ => Vec::new(),
    };
    state["enemies"] = Value::Array(enemies);
    let merchants = sk_economy::merchant_economy::normalize_merchants(state.get("merchants"));
    let has_merchants = !merchants.is_empty();
    state["merchants"] = Value::Array(merchants);
    let economy_policy = sk_economy::merchant_economy::ECONOMY_POLICY_ID;
    if has_merchants && !house_rules.iter().any(|rule| rule == economy_policy) {
        house_rules.push(economy_policy.to_string());
        state["enabled_house_rules"] = js::strings_value(house_rules);
    }
    seed_resources_and_positions(&mut state);
    for (key, keep) in [("mapFeedback", 6usize), ("battleLog", 50), ("economyLog", 50)] {
        let list = match state.get(key) {
            Some(Value::Array(items)) => items[items.len().saturating_sub(keep)..].to_vec(),
            _ => Vec::new(),
        };
        state[key] = Value::Array(list);
    }
    state["adventure"] = adventure(&state);
    state["locationMaps"] = Value::Object(sk_director::adventure_director::normalize_location_maps(state.get("locationMaps")));
    let world_map = sk_geometry::world_map::ensure_campaign_world_map(&state).map_err(|message| type_error(message))?;
    state["worldMap"] = sk_scenario::campaign_scenario::apply_scenario_map_reveals(&state, &world_map);
    let scene_map = crate::scene_map_sync::reconcile_scene_tactical_map(&mut state).map_err(|failure| error(failure.to_string()))?;
    if let Some(map) = scene_map {
        crate::scene_map_sync::sync_scene_cells(&mut state, Some(&map));
    }
    sk_director::adventure_director::remember_current_scene_map(&mut state);
    let memory = sk_director::scene_memory::ensure_scene_world_memory(source.get("worldMemory"), &state).map_err(|failure| Halt::Fault(Fault::new(failure.name.clone(), failure.message.clone())))?;
    state["worldMemory"] = memory;
    if sk_society::campaign_stories::campaign_mode_for(&state) == "persistent" {
        match state.get("campaignConcept") {
            None | Some(Value::Null) => return Err(type_error(format!("Cannot read properties of {} (reading 'story_quest_id')", if state.get("campaignConcept").is_some() { "null" } else { "undefined" }))),
            Some(concept) if concept.get("story_quest_id").is_none() => {
                let quest = sk_society::campaign_stories::persistent_story_quest(&state).and_then(|quest| quest.get("id")).filter(|id| !id.is_null()).cloned().unwrap_or(Value::Null);
                let mut concept = spread_of(Some(concept));
                concept.insert("story_quest_id".into(), quest);
                state["campaignConcept"] = Value::Object(concept);
            }
            Some(_) => {}
        }
    }
    let options = Value::Object(Map::new());
    let social = sk_social::npc_social::ensure_npc_social_state(state.get("social").unwrap_or(&Value::Null), &state, &options);
    state["social"] = social;
    state["npc_world"] = sk_npc_world::npc_positioning::normalize_npc_world_state(state.get("npc_world"), &options);
    if truthy(state.get("world_offices")) {
        state["world_offices"] = sk_world_life::world_offices::normalize_world_offices_state(state.get("world_offices"), &options);
    }
    state["world_deeds"] = sk_world_time::world_deeds::normalize_world_deeds_state(state.get("world_deeds"));
    state["offscreen_world"] = sk_world_story::offscreen_world::normalize_offscreen_world_state(state.get("offscreen_world"));
    state["courier_letters"] = sk_world_life::courier_letters::normalize_courier_letter_state(state.get("courier_letters"));
    state["captives"] = sk_world_life::captives::normalize_captives_state(state.get("captives"));
    state["scenario_attention"] = sk_attention::scenario_attention::normalize_scenario_attention_state(state.get("scenario_attention"));
    state["scenario_knight"] = sk_world_story::scenario_knight::normalize_scenario_knight_state(state.get("scenario_knight")).to_json();
    state["dialogues"] = sk_story::campaign_dialogues::normalize_dialogue_state(state.get("dialogues"));
    state["loot_containers"] = sk_director::loot_containers::normalize_loot_containers_state(state.get("loot_containers"));
    state["beasts"] = sk_npc_world::beast_taming::normalize_beast_state(state.get("beasts"));
    state["law"] = sk_society::law_and_order::normalize_law_state(state.get("law"));
    state["tavern"] = sk_npc_world::tavern_life::normalize_tavern_state(state.get("tavern"));
    state["blessings"] = sk_npc_world::blessings::normalize_blessing_state(state.get("blessings"));
    state["autonomy"] = sk_world_story::autonomous_campaign::normalize_autonomy_state(state.get("autonomy"));
    state["partyDecisionPolicy"] = sk_memory::party_decision::normalize_party_decision_policy(state.get("partyDecisionPolicy"));
    if let Some(interaction @ Value::Object(_)) = state.get("agentInteraction") {
        // Отказ нормализации сохраняет legacy-метаданные решения (JS `catch`).
        if let Ok(decision) = sk_memory::party_decision::normalize_party_decision(interaction, state.get("partyDecisionPolicy")) {
            state["agentInteraction"] = decision;
        }
    }
    Ok(state)
}

/// Запасы и клетки существ (2160–2172): ячейки заклинаний и запасы классов —
/// полными, позиция — из `x`/`y` существа, если её ещё нет.
fn seed_resources_and_positions(state: &mut Value) {
    let options = sk_combat_content::combat_actions::class_resource_options_for(Some(state));
    let mut seeds: Vec<(String, Vec<(String, Value)>, Option<(f64, f64)>)> = Vec::new();
    for actor in list_actors(state) {
        let id = actor_id(actor);
        let mut maximums = Vec::new();
        for table in [sk_combat_content::combat_spells::spell_slot_maximums_for(Some(actor)), sk_combat_content::combat_actions::combat_resource_maximums_for(Some(actor), options)] {
            for (resource, maximum) in entries_of(Some(&table)) {
                maximums.push((resource, maximum));
            }
        }
        let x = js::number(actor.get("x"));
        let y = js::number(actor.get("y"));
        let safe = |value: f64| value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0;
        seeds.push((id, maximums, (safe(x) && safe(y)).then_some((x, y))));
    }
    let mechanics = &mut state["mechanics"];
    for (id, maximums, position) in seeds {
        let resources = js::object_mut(mechanics, "resources");
        let slot = resources.entry(id.clone()).or_insert(Value::Null);
        if slot.is_null() {
            *slot = Value::Object(Map::new());
        }
        if let Value::Object(pools) = slot {
            for (resource, maximum) in maximums {
                if !truthy(pools.get(&resource)) {
                    pools.insert(resource, json!({ "current": maximum, "max": maximum }));
                }
            }
        }
        let positions = js::object_mut(mechanics, "positions");
        if let Some((x, y)) = position {
            if !truthy(positions.get(&id)) {
                positions.insert(id, json!({ "x": js::num(x), "y": js::num(y) }));
            }
        }
    }
}

/// `state.adventure` нормализации (2177–2183).
fn adventure(state: &Value) -> Value {
    let raw = state.get("adventure").filter(|adventure| truthy(Some(adventure)) && is_object_like(Some(adventure)));
    let mut adventure = spread_of(raw);
    let get = |key: &str| raw.and_then(|raw| raw.get(key));
    adventure.insert("chapter".into(), Value::from(safe_int(get("chapter"), 1).max(1)));
    let history = match get("history") {
        Some(Value::Array(items)) => items[items.len().saturating_sub(20)..].to_vec(),
        _ => Vec::new(),
    };
    adventure.insert("history".into(), Value::Array(history));
    let location = state.get("scene").and_then(|scene| scene.get("location"));
    let fallback = if truthy(location) { Value::Array(vec![location.cloned().unwrap_or(Value::Null)]) } else { Value::Array(Vec::new()) };
    let visited = unique_strings(nullish(get("visitedLocations"), Some(&fallback)));
    let visited: Vec<String> = visited[visited.len().saturating_sub(50)..].to_vec();
    adventure.insert("visitedLocations".into(), js::strings_value(visited));
    Value::Object(adventure)
}

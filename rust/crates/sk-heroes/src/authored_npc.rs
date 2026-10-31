//! Перенос `server/authored-npc.mjs`: боевой лист авторского NPC сценария
//! (профиль, характеристики, навыки, иммунитеты, черты планировщика,
//! действия, заклинания, легендарные и особые действия, особенности и
//! тактика) — строгая проверка при загрузке мира, безопасная нормализация
//! сохранённого листа и боевая форма NPC с портретом для встречи.
//!
//! Принимается только то, что исполняет сервер: черты — те, что знает
//! планировщик NPC, заклинания — с серверной механикой, легендарные
//! действия — те, что принимает `sk_combat_base::legendary_actions`, особые —
//! области `sk_combat_base::monster_actions`. Прочее — отказ
//! [`AuthoredNpcValidationError`], а не молча пропущенная строка.

use std::fmt;

use serde_json::{json, Map, Value};
use sk_chargen::npc_portraits::NPC_PORTRAIT_CHARACTER_ASSETS;
use sk_combat_base::legendary_actions::legendary_profile_for;
use sk_combat_base::monster_actions::monster_area_action;
use sk_combat_content::combat_spells::canonical_combat_spell_for;
use sk_core::{js, re, text, MechanicsSupport};
use sk_geometry::actor_footprint::footprint_metadata_for_size;

use crate::support::{array, defined, prop, same_value_zero};

/// `AUTHORED_NPC_MECHANICS_STATUSES`: статусы механики листа и особенностей.
pub const AUTHORED_NPC_MECHANICS_STATUSES: [&str; 3] = [MechanicsSupport::Verified.as_str(), MechanicsSupport::Partial.as_str(), MechanicsSupport::RulingOnly.as_str()];

/// Путь листа в текстах отказов по умолчанию (`path = 'npc.mechanics'`).
pub const DEFAULT_MECHANICS_PATH: &str = "npc.mechanics";

/// Код отказа по умолчанию (`code = 'AUTHORED_NPC_INVALID'`).
pub const AUTHORED_NPC_INVALID: &str = "AUTHORED_NPC_INVALID";

const ABILITIES: [&str; 6] = ["str", "dex", "con", "int", "wis", "cha"];
const SKILLS: [&str; 18] = [
    "acrobatics",
    "animal_handling",
    "arcana",
    "athletics",
    "deception",
    "history",
    "insight",
    "intimidation",
    "investigation",
    "medicine",
    "nature",
    "perception",
    "performance",
    "persuasion",
    "religion",
    "sleight_of_hand",
    "stealth",
    "survival",
];
const CREATURE_TYPES: [&str; 14] = [
    "aberration",
    "beast",
    "celestial",
    "construct",
    "dragon",
    "elemental",
    "fey",
    "fiend",
    "giant",
    "humanoid",
    "monstrosity",
    "ooze",
    "plant",
    "undead",
];
const SIZES: [&str; 6] = ["tiny", "small", "medium", "large", "huge", "gargantuan"];
const DAMAGE_TYPES: [&str; 13] =
    ["acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic", "piercing", "poison", "psychic", "radiant", "slashing", "thunder"];
const CONDITIONS: [&str; 15] = [
    "blinded",
    "charmed",
    "deafened",
    "exhaustion",
    "frightened",
    "grappled",
    "incapacitated",
    "invisible",
    "paralyzed",
    "petrified",
    "poisoned",
    "prone",
    "restrained",
    "stunned",
    "unconscious",
];
const ACTION_KINDS: [&str; 2] = ["melee", "ranged"];
const ENCOUNTER_DIFFICULTIES: [&str; 4] = ["easy", "medium", "hard", "deadly"];
const EXECUTABLE_TRAITS: [&str; 9] =
    ["aggressive", "bloodied-frenzy", "charge", "keep-distance", "martial-advantage", "multiattack", "nimble-escape", "pack-tactics", "relentless-pursuit"];
const LEGENDARY_KINDS: [&str; 2] = ["attack", "save"];
const AREA_SHAPES: [&str; 2] = ["sphere", "cone"];

const MECHANICS_FIELDS: [&str; 27] = [
    "profile_id",
    "status",
    "level",
    "challenge_rating",
    "xp",
    "encounter_difficulty",
    "hp",
    "armor",
    "speed",
    "initiative_bonus",
    "proficiency_bonus",
    "size",
    "creature_type",
    "abilities",
    "skills",
    "saving_throws",
    "damage_vulnerabilities",
    "damage_resistances",
    "damage_immunities",
    "condition_immunities",
    "traits",
    "action_profiles",
    "spellcasting",
    "legendary",
    "special_actions",
    "features",
    "tactics",
];
const TRAIT_FIELDS: [&str; 5] = ["id", "name", "attacks", "action_id", "action_counts"];
const ACTION_FIELDS: [&str; 10] =
    ["id", "name", "kind", "attack_modifier", "damage_expression", "damage_type", "range_feet", "normal_range_feet", "tactical_priority", "on_hit"];
const ON_HIT_FIELDS: [&str; 2] = ["damage_expression", "damage_type"];
const FEATURE_FIELDS: [&str; 4] = ["id", "name", "status", "description"];
const SPELLCASTING_FIELDS: [&str; 4] = ["ability", "save_dc", "attack_bonus", "spells"];
const SPELL_FIELDS: [&str; 2] = ["id", "uses"];
const LEGENDARY_FIELDS: [&str; 3] = ["uses", "resistance", "actions"];
const LEGENDARY_ACTION_FIELDS: [&str; 15] = [
    "id",
    "name",
    "cost",
    "kind",
    "attack_modifier",
    "damage_expression",
    "damage_type",
    "range_feet",
    "save_ability",
    "save_dc",
    "half_on_save",
    "condition",
    "radius_feet",
    "cooldown_turns",
    "area_shape",
];

/// `AuthoredNpcValidationError`: отказ проверки авторского листа; `code` —
/// всегда `AUTHORED_NPC_INVALID` (как у конструктора JS по умолчанию).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthoredNpcValidationError {
    pub message: String,
    pub code: String,
}

impl AuthoredNpcValidationError {
    /// Имя класса ошибки JS.
    pub const NAME: &'static str = "AuthoredNpcValidationError";

    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), code: AUTHORED_NPC_INVALID.into() }
    }
}

impl fmt::Display for AuthoredNpcValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AuthoredNpcValidationError {}

type Checked<T> = Result<T, AuthoredNpcValidationError>;

fn invalid<T>(message: impl Into<String>) -> Checked<T> {
    Err(AuthoredNpcValidationError::new(message))
}

/// `clean(value, maximum)`: `String(value ?? '')`, NFKC, пробельные серии —
/// один пробел, `trim`, первые `maximum` символов.
fn clean(value: Option<&Value>, maximum: usize) -> String {
    text::head(&text::squash_spaces(&text::nfkc(&js::s(value))), maximum)
}

/// `record(value, path)`: объект-словарь, иначе отказ.
fn record<'a>(value: Option<&'a Value>, path: &str) -> Checked<&'a Map<String, Value>> {
    match value {
        Some(Value::Object(map)) => Ok(map),
        _ => invalid(format!("{path} должен быть объектом")),
    }
}

/// `exactFields(value, allowed, path)`: неизвестные поля — в порядке
/// `Object.keys` (индексы раньше прочих).
fn exact_fields(value: &Map<String, Value>, allowed: &[&str], path: &str) -> Checked<()> {
    let unknown: Vec<&str> = js::keys(value).into_iter().map(String::as_str).filter(|key| !allowed.contains(key)).collect();
    if unknown.is_empty() {
        Ok(())
    } else {
        invalid(format!("{path} содержит неизвестные поля: {}", unknown.join(", ")))
    }
}

fn identifier(value: Option<&Value>, path: &str) -> Checked<String> {
    let result = clean(value, 120);
    if !text::test(re!(r"^[a-z0-9][a-z0-9._:-]{0,119}$", "u"), &result) {
        return invalid(format!("{path} должен быть безопасным ASCII-идентификатором"));
    }
    Ok(result)
}

/// `integer(value, path, minimum, maximum)`: `Number(value)` — безопасное
/// целое в границах.
fn integer(value: Option<&Value>, path: &str, minimum: i64, maximum: i64) -> Checked<i64> {
    let result = js::number(value);
    let safe = result.is_finite() && result.fract() == 0.0 && result.abs() <= 9_007_199_254_740_991.0;
    if !safe || result < minimum as f64 || result > maximum as f64 {
        return invalid(format!("{path} должен быть целым числом от {minimum} до {maximum}"));
    }
    Ok(result as i64)
}

fn enum_value(value: Option<&Value>, values: &[&str], path: &str) -> Checked<String> {
    let result = clean(value, 80);
    if !values.contains(&result.as_str()) {
        return invalid(format!("{path} имеет недопустимое значение «{result}»"));
    }
    Ok(result)
}

fn unique_enums(value: Option<&Value>, values: &[&str], path: &str) -> Checked<Vec<String>> {
    let Some(value) = defined(value) else {
        return Ok(Vec::new());
    };
    let Value::Array(items) = value else {
        return invalid(format!("{path} должен быть массивом"));
    };
    let mut result: Vec<String> = Vec::new();
    for (index, entry) in items.iter().enumerate() {
        let entry = enum_value(Some(entry), values, &format!("{path}[{index}]"))?;
        if !result.contains(&entry) {
            result.push(entry);
        }
    }
    result.truncate(20);
    Ok(result)
}

/// `assertUniqueIds(entries, path)`: `Set` по `entry.id` (SameValueZero), в
/// тексте — `String(entry.id)`.
fn assert_unique_ids(entries: &[Value], path: &str) -> Checked<()> {
    let mut seen: Vec<Option<&Value>> = Vec::new();
    for entry in entries {
        let id = entry.get("id");
        if seen.iter().any(|known| same_value_zero(*known, id)) {
            return invalid(format!("{path} содержит повторяющийся id «{}»", js::string(id)));
        }
        seen.push(id);
    }
    Ok(())
}

/// `bonusMap(value, allowed, path, { requireAll })`.
fn bonus_map(value: Option<&Value>, allowed: &[&str], path: &str, require_all: bool) -> Checked<Value> {
    let source = record(value, path)?;
    exact_fields(source, allowed, path)?;
    if require_all {
        let missing: Vec<&str> = allowed.iter().copied().filter(|key| defined(source.get(*key)).is_none()).collect();
        if !missing.is_empty() {
            return invalid(format!("{path} не содержит: {}", missing.join(", ")));
        }
    }
    let (minimum, maximum) = if require_all { (1, 30) } else { (-20, 20) };
    let mut result = Map::new();
    for (key, bonus) in js::entries(source) {
        result.insert(key.clone(), json!(integer(Some(bonus), &format!("{path}.{key}"), minimum, maximum)?));
    }
    Ok(Value::Object(result))
}

/// `Object.fromEntries(...)`: ключи-индексы впереди по возрастанию, прочие —
/// в порядке вставки; повтор ключа меняет значение на месте первого.
fn from_entries(entries: Vec<(String, Value)>) -> Map<String, Value> {
    let mut map = Map::new();
    for (key, value) in entries {
        map.insert(key, value);
    }
    if !map.keys().any(|key| js::is_array_index_key(key)) {
        return map;
    }
    let order: Vec<String> = js::keys(&map).into_iter().cloned().collect();
    let mut source = map;
    let mut result = Map::new();
    for key in order {
        if let Some(value) = source.shift_remove(&key) {
            result.insert(key, value);
        }
    }
    result
}

fn normalize_trait(value: &Value, path: &str) -> Checked<Value> {
    let source = record(Some(value), path)?;
    exact_fields(source, &TRAIT_FIELDS, path)?;
    let trait_id = identifier(source.get("id"), &format!("{path}.id"))?;
    if !EXECUTABLE_TRAITS.contains(&trait_id.as_str()) {
        return invalid(format!("{path}.id не исполняется планировщиком NPC"));
    }
    let action_counts = match defined(source.get("action_counts")) {
        None => None,
        some => Some(record(some, &format!("{path}.action_counts"))?),
    };
    let mut result = Map::new();
    result.insert("id".into(), json!(trait_id));
    let name = clean(source.get("name"), 160);
    result.insert("name".into(), json!(if name.is_empty() { trait_id.clone() } else { name }));
    if defined(source.get("attacks")).is_some() {
        result.insert("attacks".into(), json!(integer(source.get("attacks"), &format!("{path}.attacks"), 1, 6)?));
    }
    if defined(source.get("action_id")).is_some() {
        result.insert("action_id".into(), json!(identifier(source.get("action_id"), &format!("{path}.action_id"))?));
    }
    if let Some(counts) = action_counts {
        let mut entries = Vec::new();
        for (action_id, count) in js::entries(counts) {
            let key = identifier(Some(&json!(action_id)), &format!("{path}.action_counts key"))?;
            let count = integer(Some(count), &format!("{path}.action_counts.{action_id}"), 1, 6)?;
            entries.push((key, json!(count)));
        }
        result.insert("action_counts".into(), Value::Object(from_entries(entries)));
    }
    Ok(Value::Object(result))
}

fn dice_expression(value: Option<&Value>, path: &str) -> Checked<String> {
    let expression = clean(value, 40);
    if !is_dice(&expression) {
        return invalid(format!("{path}.damage_expression имеет неподдерживаемую формулу"));
    }
    Ok(expression)
}

fn is_dice(expression: &str) -> bool {
    text::test(re!(r"^\d{1,2}d\d{1,3}(?:[+-]\d{1,3})?$", "u"), expression)
}

fn normalize_action(value: &Value, path: &str) -> Checked<Value> {
    let source = record(Some(value), path)?;
    exact_fields(source, &ACTION_FIELDS, path)?;
    let damage_expression = dice_expression(source.get("damage_expression"), path)?;
    let range = integer(source.get("range_feet"), &format!("{path}.range_feet"), 5, 600)?;
    let normal_range = match defined(source.get("normal_range_feet")) {
        None => None,
        some => Some(integer(some, &format!("{path}.normal_range_feet"), 5, 600)?),
    };
    if normal_range.is_some_and(|normal| normal > range) {
        return invalid(format!("{path}.normal_range_feet больше предельной дальности"));
    }
    let id_path = format!("{path}.id");
    let mut result = Map::new();
    result.insert("id".into(), json!(identifier(source.get("id"), &id_path)?));
    let name = clean(source.get("name"), 160);
    let name = if name.is_empty() { identifier(source.get("id"), &id_path)? } else { name };
    result.insert("name".into(), json!(name));
    result.insert("kind".into(), json!(enum_value(source.get("kind"), &ACTION_KINDS, &format!("{path}.kind"))?));
    result.insert("attack_modifier".into(), json!(integer(source.get("attack_modifier"), &format!("{path}.attack_modifier"), -10, 20)?));
    result.insert("damage_expression".into(), json!(damage_expression));
    result.insert("damage_type".into(), json!(enum_value(source.get("damage_type"), &DAMAGE_TYPES, &format!("{path}.damage_type"))?));
    result.insert("range_feet".into(), json!(range));
    if let Some(normal) = normal_range {
        result.insert("normal_range_feet".into(), json!(normal));
    }
    if defined(source.get("tactical_priority")).is_some() {
        result.insert(
            "tactical_priority".into(),
            json!(integer(source.get("tactical_priority"), &format!("{path}.tactical_priority"), 0, 20)?),
        );
    }
    if defined(source.get("on_hit")).is_some() {
        result.insert("on_hit".into(), normalize_on_hit(source.get("on_hit"), &format!("{path}.on_hit"))?);
    }
    Ok(Value::Object(result))
}

/// Дополнительный урон попадания (`2к8 холодом` у клинка Дуннахана). Его
/// исполняет та же ветка атаки, что и `on_hit` бестиария: кость бросается
/// отдельно, вид урона — свой. Спасброска и состояния у авторского листа нет.
fn normalize_on_hit(value: Option<&Value>, path: &str) -> Checked<Value> {
    let source = record(value, path)?;
    exact_fields(source, &ON_HIT_FIELDS, path)?;
    let damage_expression = dice_expression(source.get("damage_expression"), path)?;
    let damage_type = enum_value(source.get("damage_type"), &DAMAGE_TYPES, &format!("{path}.damage_type"))?;
    Ok(json!({ "damage_expression": damage_expression, "damage_type": damage_type }))
}

fn normalize_feature(value: &Value, path: &str) -> Checked<Value> {
    let source = record(Some(value), path)?;
    exact_fields(source, &FEATURE_FIELDS, path)?;
    let description = clean(source.get("description"), 600);
    if description.is_empty() {
        return invalid(format!("{path}.description должен быть непустым"));
    }
    let id_path = format!("{path}.id");
    let id = identifier(source.get("id"), &id_path)?;
    let name = clean(source.get("name"), 160);
    let name = if name.is_empty() { identifier(source.get("id"), &id_path)? } else { name };
    let status = enum_value(source.get("status"), &AUTHORED_NPC_MECHANICS_STATUSES, &format!("{path}.status"))?;
    Ok(json!({ "id": id, "name": name, "status": status, "description": description }))
}

fn normalize_spellcasting(value: Option<&Value>, path: &str) -> Checked<Value> {
    let source = record(value, path)?;
    exact_fields(source, &SPELLCASTING_FIELDS, path)?;
    let raw_spells = array(source.get("spells"));
    if raw_spells.is_empty() || raw_spells.len() > 20 {
        return invalid(format!("{path}.spells должен содержать от 1 до 20 записей"));
    }
    let mut seen: Vec<String> = Vec::new();
    let mut spells = Vec::new();
    for (index, raw) in raw_spells.iter().enumerate() {
        let spell_path = format!("{path}.spells[{index}]");
        let spell = record(Some(raw), &spell_path)?;
        exact_fields(spell, &SPELL_FIELDS, &spell_path)?;
        let spell_id = identifier(spell.get("id"), &format!("{spell_path}.id"))?;
        if seen.contains(&spell_id) {
            return invalid(format!("{path}.spells содержит повтор «{spell_id}»"));
        }
        seen.push(spell_id.clone());
        let catalog = canonical_combat_spell_for(Some(&json!(spell_id)), None);
        let unsupported = catalog.as_ref().is_none_or(|catalog| {
            let support = MechanicsSupport::parse(&js::string(catalog.get("mechanicsSupport")));
            support.is_some_and(|status| !status.is_executable())
        });
        if unsupported {
            return invalid(format!("{spell_path}.id не имеет исполнимой серверной механики"));
        }
        let uses = if spell.get("uses").and_then(Value::as_str) == Some("at-will") {
            json!("at-will")
        } else {
            json!(integer(spell.get("uses"), &format!("{spell_path}.uses"), 1, 9)?)
        };
        spells.push(json!({ "id": spell_id, "uses": uses }));
    }
    let ability = enum_value(source.get("ability"), &ABILITIES, &format!("{path}.ability"))?;
    let save_dc = integer(source.get("save_dc"), &format!("{path}.save_dc"), 5, 30)?;
    let attack_bonus = integer(source.get("attack_bonus"), &format!("{path}.attack_bonus"), -10, 20)?;
    Ok(json!({ "ability": ability, "save_dc": save_dc, "attack_bonus": attack_bonus, "spells": spells }))
}

fn normalize_legendary_action(raw: &Value, action_path: &str) -> Checked<Value> {
    let action = record(Some(raw), action_path)?;
    exact_fields(action, &LEGENDARY_ACTION_FIELDS, action_path)?;
    let field = |key: &str| action.get(key);
    let at = |key: &str| format!("{action_path}.{key}");
    let kind = enum_value(field("kind"), &LEGENDARY_KINDS, &at("kind"))?;
    let damage_expression = defined(field("damage_expression")).map(|expression| clean(Some(expression), 40));
    let damage_expression = damage_expression.filter(|expression| !expression.is_empty());
    if let Some(expression) = &damage_expression {
        if !is_dice(expression) {
            return invalid(format!("{action_path}.damage_expression имеет неподдерживаемую формулу"));
        }
    }
    let mut result = Map::new();
    result.insert("id".into(), json!(identifier(field("id"), &at("id"))?));
    let name = clean(field("name"), 160);
    let name = if name.is_empty() { identifier(field("id"), &at("id"))? } else { name };
    result.insert("name".into(), json!(name));
    result.insert("cost".into(), json!(integer(field("cost"), &at("cost"), 1, 5)?));
    result.insert("kind".into(), json!(kind));
    if kind == "attack" {
        result.insert("attack_modifier".into(), json!(integer(field("attack_modifier"), &at("attack_modifier"), -10, 20)?));
    }
    if let Some(expression) = damage_expression {
        result.insert("damage_expression".into(), json!(expression));
    }
    result.insert("damage_type".into(), json!(enum_value(field("damage_type"), &DAMAGE_TYPES, &at("damage_type"))?));
    result.insert("range_feet".into(), json!(integer(field("range_feet"), &at("range_feet"), 5, 600)?));
    if kind == "save" {
        result.insert("save_ability".into(), json!(enum_value(field("save_ability"), &ABILITIES, &at("save_ability"))?));
        result.insert("save_dc".into(), json!(integer(field("save_dc"), &at("save_dc"), 5, 30)?));
        result.insert("half_on_save".into(), json!(js::is_true(field("half_on_save"))));
        result.insert("radius_feet".into(), json!(integer(field("radius_feet"), &at("radius_feet"), 0, 120)?));
        if defined(field("area_shape")).is_some() {
            result.insert("area_shape".into(), json!(enum_value(field("area_shape"), &AREA_SHAPES, &at("area_shape"))?));
        }
        if defined(field("condition")).is_some() {
            result.insert("condition".into(), json!(enum_value(field("condition"), &CONDITIONS, &at("condition"))?));
        }
    }
    if defined(field("cooldown_turns")).is_some() {
        result.insert("cooldown_turns".into(), json!(integer(field("cooldown_turns"), &at("cooldown_turns"), 1, 10)?));
    }
    Ok(Value::Object(result))
}

fn normalize_legendary(value: Option<&Value>, path: &str) -> Checked<Value> {
    let source = record(value, path)?;
    exact_fields(source, &LEGENDARY_FIELDS, path)?;
    let raw_actions = array(source.get("actions"));
    if raw_actions.is_empty() || raw_actions.len() > 6 {
        return invalid(format!("{path}.actions должен содержать от 1 до 6 записей"));
    }
    let actions = raw_actions
        .iter()
        .enumerate()
        .map(|(index, raw)| normalize_legendary_action(raw, &format!("{path}.actions[{index}]")))
        .collect::<Checked<Vec<Value>>>()?;
    assert_unique_ids(&actions, &format!("{path}.actions"))?;
    let uses = integer(source.get("uses"), &format!("{path}.uses"), 1, 5)?;
    let zero = json!(0);
    let resistance = integer(Some(defined(source.get("resistance")).unwrap_or(&zero)), &format!("{path}.resistance"), 0, 5)?;
    let legendary = json!({ "uses": uses, "resistance": resistance, "actions": actions });
    let executable = legendary_profile_for(Some(&json!({ "legendary": legendary }))).map(|profile| profile.actions.len());
    if executable != Some(actions.len()) {
        return invalid(format!("{path} не исполняется модулем легендарных действий"));
    }
    Ok(legendary)
}

/// Особые действия стат-блока — те же записи `save_area`, что у бестиария
/// (дыхание дракона с перезарядкой 5–6). Принимается только то, что
/// исполняет `UseMonsterAction`: прочее — честный отказ при загрузке мира,
/// а не справочная строка, которую бой молча пропустит.
fn normalize_special_actions(value: Option<&Value>, path: &str) -> Checked<Value> {
    let items = match value {
        Some(Value::Array(items)) if items.len() <= 4 => items,
        _ => return invalid(format!("{path} должен быть массивом до 4 записей")),
    };
    let mut actions = Vec::new();
    for (index, raw) in items.iter().enumerate() {
        let item_path = format!("{path}[{index}]");
        let action = Value::Object(record(Some(raw), &item_path)?.clone());
        if monster_area_action(Some(&action)).is_none() {
            return invalid(format!("{item_path} не исполняется обработчиком областей существ"));
        }
        actions.push(action);
    }
    assert_unique_ids(&actions, path)?;
    Ok(Value::Array(actions))
}

/// `normalizeAuthoredNpcMechanics(value)` с путём по умолчанию `npc.mechanics`.
pub fn normalize_authored_npc_mechanics(value: Option<&Value>) -> Result<Value, AuthoredNpcValidationError> {
    normalize_authored_npc_mechanics_at(value, DEFAULT_MECHANICS_PATH)
}

/// `normalizeAuthoredNpcMechanics(value, path)`: проверенный боевой лист в
/// форме JS; отказ называет поле по `path` (`templates[3].opening.npcs[0]
/// .mechanics.hp`). Порядок проверок — как в JS: первым срабатывает тот же
/// отказ.
pub fn normalize_authored_npc_mechanics_at(value: Option<&Value>, path: &str) -> Result<Value, AuthoredNpcValidationError> {
    let source = record(value, path)?;
    exact_fields(source, &MECHANICS_FIELDS, path)?;
    let field = |key: &str| source.get(key);
    let at = |key: &str| format!("{path}.{key}");
    let challenge_rating = clean(field("challenge_rating"), 20);
    if !text::test(re!(r"^\d{1,2}(?:\/\d{1,2})?$", "u"), &challenge_rating) {
        return invalid(format!("{path}.challenge_rating имеет неверный формат"));
    }
    let empty: [Value; 0] = [];
    let raw_traits = defined(field("traits"));
    let raw_actions = array(field("action_profiles"));
    let raw_features = array(field("features"));
    let raw_tactics = array(field("tactics"));
    let raw_traits: &[Value] = match raw_traits {
        None => &empty,
        Some(Value::Array(items)) if items.len() <= 12 => items,
        Some(_) => return invalid(format!("{path}.traits должен быть массивом до 12 записей")),
    };
    if raw_actions.is_empty() || raw_actions.len() > 12 {
        return invalid(format!("{path}.action_profiles должен содержать от 1 до 12 записей"));
    }
    if raw_features.is_empty() || raw_features.len() > 12 {
        return invalid(format!("{path}.features должен содержать от 1 до 12 записей"));
    }
    if raw_tactics.is_empty() || raw_tactics.len() > 8 {
        return invalid(format!("{path}.tactics должен содержать от 1 до 8 строк"));
    }
    let mut tactics = Vec::new();
    for (index, entry) in raw_tactics.iter().enumerate() {
        let result = clean(Some(entry), 320);
        if result.is_empty() {
            return invalid(format!("{path}.tactics[{index}] должен быть непустым"));
        }
        tactics.push(Value::String(result));
    }
    let traits = raw_traits
        .iter()
        .enumerate()
        .map(|(index, entry)| normalize_trait(entry, &format!("{path}.traits[{index}]")))
        .collect::<Checked<Vec<Value>>>()?;
    let actions = raw_actions
        .iter()
        .enumerate()
        .map(|(index, entry)| normalize_action(entry, &format!("{path}.action_profiles[{index}]")))
        .collect::<Checked<Vec<Value>>>()?;
    let features = raw_features
        .iter()
        .enumerate()
        .map(|(index, entry)| normalize_feature(entry, &format!("{path}.features[{index}]")))
        .collect::<Checked<Vec<Value>>>()?;
    assert_unique_ids(&traits, &at("traits"))?;
    assert_unique_ids(&actions, &at("action_profiles"))?;
    assert_unique_ids(&features, &at("features"))?;
    let action_ids: Vec<&str> = actions.iter().filter_map(|entry| entry.get("id").and_then(Value::as_str)).collect();
    for entry in &traits {
        if let Some(action_id) = entry.get("action_id").and_then(Value::as_str).filter(|id| !id.is_empty()) {
            if !action_ids.contains(&action_id) {
                return invalid(format!("{path}.traits ссылается на неизвестное действие «{action_id}»"));
            }
        }
        if let Some(Value::Object(counts)) = entry.get("action_counts") {
            for action_id in js::keys(counts) {
                if !action_ids.contains(&action_id.as_str()) {
                    return invalid(format!("{path}.traits ссылается на неизвестное действие «{action_id}»"));
                }
            }
        }
    }
    let mut result = Map::new();
    result.insert("profile_id".into(), json!(identifier(field("profile_id"), &at("profile_id"))?));
    result.insert("status".into(), json!(enum_value(field("status"), &AUTHORED_NPC_MECHANICS_STATUSES, &at("status"))?));
    result.insert("level".into(), json!(integer(field("level"), &at("level"), 1, 20)?));
    result.insert("challenge_rating".into(), json!(challenge_rating));
    result.insert("xp".into(), json!(integer(field("xp"), &at("xp"), 0, 100_000)?));
    result.insert(
        "encounter_difficulty".into(),
        json!(enum_value(field("encounter_difficulty"), &ENCOUNTER_DIFFICULTIES, &at("encounter_difficulty"))?),
    );
    result.insert("hp".into(), json!(integer(field("hp"), &at("hp"), 1, 500)?));
    result.insert("armor".into(), json!(integer(field("armor"), &at("armor"), 5, 30)?));
    result.insert("speed".into(), json!(integer(field("speed"), &at("speed"), 0, 120)?));
    result.insert("initiative_bonus".into(), json!(integer(field("initiative_bonus"), &at("initiative_bonus"), -10, 20)?));
    result.insert("proficiency_bonus".into(), json!(integer(field("proficiency_bonus"), &at("proficiency_bonus"), 2, 9)?));
    result.insert("size".into(), json!(enum_value(field("size"), &SIZES, &at("size"))?));
    result.insert("creature_type".into(), json!(enum_value(field("creature_type"), &CREATURE_TYPES, &at("creature_type"))?));
    result.insert("abilities".into(), bonus_map(field("abilities"), &ABILITIES, &at("abilities"), true)?);
    result.insert("skills".into(), bonus_map(field("skills"), &SKILLS, &at("skills"), false)?);
    result.insert("saving_throws".into(), bonus_map(field("saving_throws"), &ABILITIES, &at("saving_throws"), false)?);
    for key in ["damage_vulnerabilities", "damage_resistances", "damage_immunities"] {
        result.insert(key.into(), json!(unique_enums(field(key), &DAMAGE_TYPES, &at(key))?));
    }
    result.insert("condition_immunities".into(), json!(unique_enums(field("condition_immunities"), &CONDITIONS, &at("condition_immunities"))?));
    result.insert("traits".into(), Value::Array(traits));
    result.insert("action_profiles".into(), Value::Array(actions));
    if defined(field("spellcasting")).is_some() {
        result.insert("spellcasting".into(), normalize_spellcasting(field("spellcasting"), &at("spellcasting"))?);
    }
    if defined(field("legendary")).is_some() {
        result.insert("legendary".into(), normalize_legendary(field("legendary"), &at("legendary"))?);
    }
    if defined(field("special_actions")).is_some() {
        result.insert("special_actions".into(), normalize_special_actions(field("special_actions"), &at("special_actions"))?);
    }
    result.insert("features".into(), Value::Array(features));
    result.insert("tactics".into(), Value::Array(tactics));
    Ok(Value::Object(result))
}

/// `safeAuthoredNpcMechanics(value)`: проверенный лист или `None` — для
/// сохранённого состояния, где повреждённый профиль отбрасывается без
/// поломки кампании (`null`/`undefined` на входе — тоже `None`).
pub fn safe_authored_npc_mechanics(value: Option<&Value>) -> Option<Value> {
    defined(value)?;
    normalize_authored_npc_mechanics(value).ok()
}

fn portrait_for(npc_id: &str) -> Option<&'static str> {
    NPC_PORTRAIT_CHARACTER_ASSETS.iter().find(|(id, _)| *id == npc_id).map(|(_, url)| *url)
}

/// `authoredNpcCombatant({ npc, mechanics, position })`: боевая форма
/// авторского NPC для встречи — лист проверяется заново, первое действие
/// становится основной атакой, портрет — из allowlist персонажных портретов.
///
/// Как в JS, `damageBonus` — модуль числа после знака формулы основного
/// действия: у `1d6-2` он `2` (см. «Замечено в JS» отчёта переноса).
pub fn authored_npc_combatant(
    npc: Option<&Value>,
    mechanics: Option<&Value>,
    position: Option<&Value>,
) -> Result<Value, AuthoredNpcValidationError> {
    let mechanics = normalize_authored_npc_mechanics(mechanics)?;
    let npc_id = identifier(prop(npc, "id"), "npc.id")?;
    let name = clean(prop(npc, "name"), 160);
    if name.is_empty() {
        return invalid("npc.name должен быть непустым");
    }
    let x = integer(prop(position, "x"), "position.x", 0, 10_000)?;
    let y = integer(prop(position, "y"), "position.y", 0, 10_000)?;
    let null = Value::Null;
    let field = |key: &str| mechanics.get(key).unwrap_or(&null);
    let primary = array(mechanics.get("action_profiles")).first().cloned().unwrap_or(Value::Null);
    let expression = js::s(primary.get("damage_expression"));
    let die = text::capture(re!(r"d(\d+)", "u"), &expression, 1).map_or(f64::NAN, |digits| js::parse_number(&digits));
    let die = if die == 0.0 || die.is_nan() { 6.0 } else { die };
    let flat = text::capture(re!(r"[+-](\d+)$", "u"), &expression, 1).map_or(f64::NAN, |digits| js::parse_number(&digits));
    let flat = if flat == 0.0 || flat.is_nan() { 0.0 } else { flat };
    let mut actor = Map::new();
    actor.insert("id".into(), json!(npc_id));
    actor.insert("name".into(), json!(name));
    // `NPC_PORTRAIT_CHARACTER_ASSETS[npcId]` находит и ключ прототипа
    // (`constructor`): JS кладёт в `image` функцию, которую JSON не пишет.
    if let Some(image) = portrait_for(&npc_id) {
        actor.insert("image".into(), json!(image));
    }
    for (to, from) in [("hp", "hp"), ("maxHp", "hp"), ("armor", "armor"), ("speed", "speed"), ("level", "level"), ("initiativeBonus", "initiative_bonus"), ("proficiency", "proficiency_bonus")] {
        actor.insert(to.into(), field(from).clone());
    }
    actor.insert("attackBonus".into(), primary.get("attack_modifier").cloned().unwrap_or(Value::Null));
    actor.insert("damageDice".into(), js::num(die));
    actor.insert("damageBonus".into(), js::num(flat));
    actor.insert("abilities".into(), field("abilities").clone());
    actor.insert("skillModifiers".into(), field("skills").clone());
    actor.insert("savingThrowModifiers".into(), field("saving_throws").clone());
    actor.insert("creature_type".into(), field("creature_type").clone());
    actor.insert("size".into(), field("size").clone());
    actor.insert("footprint".into(), footprint_metadata_for_size(mechanics.get("size")).to_value());
    for key in ["damage_vulnerabilities", "damage_resistances", "damage_immunities", "condition_immunities", "traits", "action_profiles"] {
        actor.insert(key.into(), field(key).clone());
    }
    actor.insert("attack_profile".into(), primary.clone());
    if let Some(spellcasting) = mechanics.get("spellcasting").filter(|value| js::truthy(Some(value))) {
        actor.insert("spellcasting".into(), spellcasting.clone());
    }
    if let Some(legendary) = mechanics.get("legendary").filter(|value| js::truthy(Some(value))) {
        actor.insert("legendary".into(), legendary.clone());
    }
    if let Some(special) = mechanics.get("special_actions").filter(|value| !array(Some(value)).is_empty()) {
        actor.insert("special_actions".into(), special.clone());
    }
    actor.insert("authored_features".into(), field("features").clone());
    actor.insert("authored_tactics".into(), field("tactics").clone());
    actor.insert("x".into(), json!(x));
    actor.insert("y".into(), json!(y));
    actor.insert("alive".into(), json!(true));
    let profile_id = field("profile_id").clone();
    actor.insert("stat_block_id".into(), profile_id.clone());
    actor.insert("loadout".into(), json!([]));
    actor.insert("origin".into(), json!({ "kind": "authored-npc", "npc_id": npc_id, "profile_id": profile_id }));
    actor.insert(
        "provenance".into(),
        json!({
            "kind": "server-owned-authored-npc-profile",
            "ruleset_id": "authored",
            "source_version": "1.0.0",
            "challenge_rating": field("challenge_rating"),
            "xp": field("xp"),
        }),
    );
    Ok(Value::Object(actor))
}

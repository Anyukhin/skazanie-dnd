//! Состояние кампании.
//!
//! Имена полей JSON — как в JS-движке. Числа читаются снисходительно (строка с
//! числом, `null` → умолчание), как `safeInteger`: старые снимки и тестовые
//! фикстуры прежнего движка не всегда строги.

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

/// Снисходительное чтение чисел и флагов.
pub mod lenient {
    use super::*;

    pub fn i64<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
        let value = Value::deserialize(deserializer)?;
        Ok(crate::json::int(Some(&value), 0))
    }

    pub fn opt_i64<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<i64>, D::Error> {
        let value = Value::deserialize(deserializer)?;
        Ok(match &value {
            Value::Null => None,
            Value::Number(_) | Value::String(_) => {
                let parsed = crate::json::int(Some(&value), i64::MIN);
                (parsed != i64::MIN).then_some(parsed)
            }
            _ => None,
        })
    }

    pub fn bool_true<'de, D: Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
        let value = Value::deserialize(deserializer)?;
        Ok(!matches!(value, Value::Bool(false)))
    }

    pub fn bool_false<'de, D: Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
        let value = Value::deserialize(deserializer)?;
        Ok(matches!(value, Value::Bool(true)))
    }

    pub fn opt_string<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
        let value = Value::deserialize(deserializer)?;
        Ok(match value {
            Value::String(text) => Some(text),
            Value::Number(number) => Some(number.to_string()),
            _ => None,
        })
    }

    pub fn string<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
        Ok(opt_string(deserializer)?.unwrap_or_default())
    }

    pub fn strings<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<String>, D::Error> {
        let value = Value::deserialize(deserializer)?;
        Ok(crate::json::strings(Some(&value)))
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn yes() -> bool {
    true
}

/// Клетка на тактической карте.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, Default)]
pub struct Point {
    #[serde(deserialize_with = "lenient::i64", default)]
    pub x: i64,
    #[serde(deserialize_with = "lenient::i64", default)]
    pub y: i64,
}

impl Point {
    pub const fn new(x: i64, y: i64) -> Self {
        Self { x, y }
    }

    /// Расстояние в клетках по правилу D&D 5e (диагональ = 5 футов).
    pub fn chebyshev(self, other: Point) -> i64 {
        (self.x - other.x).abs().max((self.y - other.y).abs())
    }
}

/// Позиция существа: клетка и, если есть, уровень (этаж).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Position {
    #[serde(deserialize_with = "lenient::i64", default)]
    pub x: i64,
    #[serde(deserialize_with = "lenient::i64", default)]
    pub y: i64,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Position {
    pub fn point(&self) -> Point {
        Point::new(self.x, self.y)
    }
}

/// Характеристики.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Abilities {
    #[serde(default, deserialize_with = "lenient::opt_i64", skip_serializing_if = "Option::is_none")]
    pub str: Option<i64>,
    #[serde(default, deserialize_with = "lenient::opt_i64", skip_serializing_if = "Option::is_none")]
    pub dex: Option<i64>,
    #[serde(default, deserialize_with = "lenient::opt_i64", skip_serializing_if = "Option::is_none")]
    pub con: Option<i64>,
    #[serde(default, deserialize_with = "lenient::opt_i64", skip_serializing_if = "Option::is_none")]
    pub int: Option<i64>,
    #[serde(default, deserialize_with = "lenient::opt_i64", skip_serializing_if = "Option::is_none")]
    pub wis: Option<i64>,
    #[serde(default, deserialize_with = "lenient::opt_i64", skip_serializing_if = "Option::is_none")]
    pub cha: Option<i64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Abilities {
    /// Значение характеристики; без значения — 10, как в JS.
    pub fn score(&self, ability: &str) -> i64 {
        match ability {
            "str" => self.str,
            "dex" => self.dex,
            "con" => self.con,
            "int" => self.int,
            "wis" => self.wis,
            "cha" => self.cha,
            _ => None,
        }
        .unwrap_or(10)
    }

    pub fn modifier(&self, ability: &str) -> i64 {
        crate::json::ability_modifier(self.score(ability))
    }
}

/// Вещь в инвентаре.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Item {
    #[serde(deserialize_with = "lenient::string", default)]
    pub id: String,
    #[serde(default, deserialize_with = "lenient::opt_string", skip_serializing_if = "Option::is_none")]
    pub catalog_id: Option<String>,
    #[serde(default, deserialize_with = "lenient::opt_string", skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(rename = "type", default, deserialize_with = "lenient::opt_string", skip_serializing_if = "Option::is_none")]
    pub item_type: Option<String>,
    #[serde(default, deserialize_with = "lenient::opt_i64", skip_serializing_if = "Option::is_none")]
    pub quantity: Option<i64>,
    #[serde(default, deserialize_with = "lenient::bool_false", skip_serializing_if = "is_false")]
    pub equipped: bool,
    #[serde(default, deserialize_with = "lenient::opt_string", skip_serializing_if = "Option::is_none")]
    pub equipped_slot: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Item {
    /// Количество; без поля — 1.
    pub fn count(&self) -> i64 {
        self.quantity.unwrap_or(1)
    }
}

/// Герой, противник или призванное существо. Форма общая: так её хранил JS.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Actor {
    #[serde(deserialize_with = "lenient::string", default)]
    pub id: String,
    #[serde(default, deserialize_with = "lenient::opt_string", skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "lenient::opt_string", skip_serializing_if = "Option::is_none")]
    pub character: Option<String>,
    #[serde(deserialize_with = "lenient::i64", default)]
    pub hp: i64,
    #[serde(rename = "maxHp", deserialize_with = "lenient::i64", default)]
    pub max_hp: i64,
    #[serde(default, deserialize_with = "lenient::opt_i64", skip_serializing_if = "Option::is_none")]
    pub armor: Option<i64>,
    #[serde(default, deserialize_with = "lenient::opt_i64", skip_serializing_if = "Option::is_none")]
    pub speed: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alive: Option<bool>,
    #[serde(default, deserialize_with = "lenient::opt_i64", skip_serializing_if = "Option::is_none")]
    pub level: Option<i64>,
    #[serde(default, deserialize_with = "lenient::opt_i64", skip_serializing_if = "Option::is_none")]
    pub proficiency: Option<i64>,
    #[serde(rename = "characterClass", default, deserialize_with = "lenient::opt_string", skip_serializing_if = "Option::is_none")]
    pub character_class: Option<String>,
    #[serde(default, deserialize_with = "lenient::opt_string", skip_serializing_if = "Option::is_none")]
    pub subclass: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub abilities: Option<Abilities>,
    #[serde(default, deserialize_with = "lenient::opt_i64", skip_serializing_if = "Option::is_none")]
    pub x: Option<i64>,
    #[serde(default, deserialize_with = "lenient::opt_i64", skip_serializing_if = "Option::is_none")]
    pub y: Option<i64>,
    #[serde(default)]
    pub inventory: Vec<Item>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Actor {
    pub fn display_name(&self) -> &str {
        self.character.as_deref().or(self.name.as_deref()).unwrap_or(&self.id)
    }

    pub fn ability_modifier(&self, ability: &str) -> i64 {
        self.abilities.as_ref().map(|abilities| abilities.modifier(ability)).unwrap_or(0)
    }

    /// Жив ли: `alive !== false` и хиты выше нуля либо герой без поля `alive`.
    pub fn is_alive_flag(&self) -> bool {
        self.alive != Some(false)
    }

    pub fn extra_str(&self, key: &str) -> Option<&str> {
        self.extra.get(key).and_then(Value::as_str)
    }

    pub fn extra_i64(&self, key: &str) -> Option<i64> {
        self.extra.get(key).filter(|value| !value.is_null()).map(|value| crate::json::int(Some(value), 0))
    }
}

/// Запас ресурса: ячейки, очки, умения.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Pool {
    #[serde(deserialize_with = "lenient::i64", default)]
    pub current: i64,
    #[serde(deserialize_with = "lenient::i64", default)]
    pub max: i64,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Наложенное состояние.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Condition {
    #[serde(deserialize_with = "lenient::string", default)]
    pub id: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Condition {
    pub fn named(id: impl Into<String>) -> Self {
        Self { id: id.into(), extra: Map::new() }
    }

    pub fn source_actor(&self) -> Option<&str> {
        self.extra.get("source_actor").and_then(Value::as_str)
    }

    pub fn duration(&self) -> Option<&str> {
        self.extra.get("duration").and_then(Value::as_str)
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.extra.get(key).filter(|value| !value.is_null())
    }
}

/// Список состояний читается и из массива строк (старые фикстуры JS).
fn conditions_map<'de, D: Deserializer<'de>>(deserializer: D) -> Result<BTreeMap<String, Vec<Condition>>, D::Error> {
    let raw: BTreeMap<String, Value> = BTreeMap::deserialize(deserializer)?;
    Ok(raw
        .into_iter()
        .map(|(id, list)| {
            let conditions = match list {
                Value::Array(items) => items
                    .into_iter()
                    .filter_map(|item| match item {
                        Value::String(name) => Some(Condition::named(name)),
                        Value::Object(_) => serde_json::from_value(item).ok(),
                        _ => None,
                    })
                    .collect(),
                _ => Vec::new(),
            };
            (id, conditions)
        })
        .collect())
}

/// Экономика хода существа.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActionEconomy {
    #[serde(default = "yes", deserialize_with = "lenient::bool_true")]
    pub action: bool,
    #[serde(default = "yes", deserialize_with = "lenient::bool_true")]
    pub bonus_action: bool,
    #[serde(default = "yes", deserialize_with = "lenient::bool_true")]
    pub reaction: bool,
    #[serde(default = "yes", deserialize_with = "lenient::bool_true")]
    pub movement: bool,
    #[serde(default = "yes", deserialize_with = "lenient::bool_true")]
    pub object_interaction: bool,
    #[serde(default, deserialize_with = "lenient::i64")]
    pub movement_spent: i64,
    #[serde(default)]
    pub movement_path: Vec<Point>,
    #[serde(default, deserialize_with = "lenient::i64")]
    pub movement_bonus: i64,
    #[serde(default, deserialize_with = "lenient::i64")]
    pub extra_actions: i64,
    #[serde(default, deserialize_with = "lenient::bool_false")]
    pub surged_action_only: bool,
    #[serde(default, deserialize_with = "lenient::i64")]
    pub attacks_used: i64,
    #[serde(default, deserialize_with = "lenient::i64")]
    pub attacks_allowed: i64,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Виды экономики, у которых свой список перезаряженного оружия.
pub const LOADING_ACTION_TYPES: [&str; 3] = ["action", "bonus_action", "reaction"];

/// Пустые списки перезарядки: `{ action: [], bonus_action: [], reaction: [] }`.
pub fn empty_loading_weapon_item_ids() -> Value {
    Value::Object(LOADING_ACTION_TYPES.iter().map(|kind| ((*kind).to_string(), Value::Array(Vec::new()))).collect())
}

impl Default for ActionEconomy {
    /// Как `actionEconomy()` в JS.
    fn default() -> Self {
        let mut extra = Map::new();
        extra.insert("loading_weapon_item_ids".into(), empty_loading_weapon_item_ids());
        Self {
            action: true,
            bonus_action: true,
            reaction: true,
            movement: true,
            object_interaction: true,
            movement_spent: 0,
            movement_path: Vec::new(),
            movement_bonus: 0,
            extra_actions: 0,
            surged_action_only: false,
            attacks_used: 0,
            attacks_allowed: 1,
            extra,
        }
    }
}

impl ActionEconomy {
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.extra.get(key).filter(|value| !value.is_null())
    }

    pub fn int(&self, key: &str) -> i64 {
        crate::json::int(self.extra.get(key), 0)
    }

    pub fn set(&mut self, key: &str, value: impl Into<Value>) {
        self.extra.insert(key.into(), value.into());
    }

    pub fn remove(&mut self, key: &str) {
        self.extra.remove(key);
    }

    /// Версия экономики событий (`action_economy_version`).
    pub fn version(&self) -> i64 {
        self.int("action_economy_version")
    }
}

/// Строка инициативы.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct InitiativeEntry {
    #[serde(deserialize_with = "lenient::string", default)]
    pub actor_id: String,
    #[serde(default, deserialize_with = "lenient::opt_i64", skip_serializing_if = "Option::is_none")]
    pub total: Option<i64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Бой.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Combat {
    #[serde(default, deserialize_with = "lenient::bool_false")]
    pub active: bool,
    #[serde(default, deserialize_with = "lenient::i64")]
    pub round: i64,
    #[serde(default)]
    pub initiative: Vec<InitiativeEntry>,
    #[serde(default, deserialize_with = "lenient::i64")]
    pub active_index: i64,
    #[serde(default)]
    pub action_economy: BTreeMap<String, ActionEconomy>,
    #[serde(default)]
    pub reaction_window: Option<Value>,
    #[serde(default)]
    pub readied: Map<String, Value>,
    #[serde(default, deserialize_with = "lenient::bool_false")]
    pub group_initiative: bool,
    #[serde(default, deserialize_with = "lenient::strings")]
    pub turn_completed: Vec<String>,
    #[serde(default)]
    pub truce: Option<Value>,
    #[serde(default, deserialize_with = "lenient::i64")]
    pub parley_attempts: i64,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Combat {
    /// Чей сейчас ход.
    pub fn active_actor(&self) -> Option<&str> {
        usize::try_from(self.active_index).ok().and_then(|index| self.initiative.get(index)).map(|entry| entry.actor_id.as_str())
    }

    pub fn economy(&self, actor_id: &str) -> ActionEconomy {
        self.action_economy.get(actor_id).cloned().unwrap_or_default()
    }
}

/// Спасброски от смерти героя.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct DeathSaves {
    #[serde(default, deserialize_with = "lenient::i64")]
    pub successes: i64,
    #[serde(default, deserialize_with = "lenient::i64")]
    pub failures: i64,
    #[serde(default, deserialize_with = "lenient::bool_false")]
    pub stable: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Смерть и судьба героев.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Death {
    #[serde(default, deserialize_with = "lenient::string")]
    pub campaign_status: String,
    #[serde(default)]
    pub heroes: BTreeMap<String, Value>,
    #[serde(default)]
    pub saving_throws: BTreeMap<String, DeathSaves>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Death {
    pub fn hero_status(&self, hero_id: &str) -> Option<&str> {
        self.heroes.get(hero_id).and_then(|record| record.get("status")).and_then(Value::as_str)
    }
}

/// Механика: позиции, состояния, ресурсы, бой, смерть.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Mechanics {
    #[serde(default, deserialize_with = "lenient::i64")]
    pub schema_version: i64,
    #[serde(default)]
    pub temporary_hp: BTreeMap<String, Value>,
    #[serde(default)]
    pub resources: BTreeMap<String, BTreeMap<String, Pool>>,
    #[serde(default, deserialize_with = "conditions_map")]
    pub conditions: BTreeMap<String, Vec<Condition>>,
    #[serde(default)]
    pub positions: BTreeMap<String, Position>,
    #[serde(default)]
    pub concentration: BTreeMap<String, Value>,
    #[serde(default)]
    pub shapes: BTreeMap<String, Value>,
    #[serde(default)]
    pub death: Death,
    #[serde(default)]
    pub combat: Combat,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Mechanics {
    pub fn condition_ids(&self, actor_id: &str) -> Vec<&str> {
        self.conditions.get(actor_id).map(|list| list.iter().map(|condition| condition.id.as_str()).collect()).unwrap_or_default()
    }

    pub fn has_condition(&self, actor_id: &str, condition: &str) -> bool {
        self.conditions.get(actor_id).is_some_and(|list| list.iter().any(|entry| entry.id == condition))
    }

    pub fn pool(&self, actor_id: &str, resource: &str) -> Pool {
        self.resources.get(actor_id).and_then(|pools| pools.get(resource)).cloned().unwrap_or_default()
    }

    /// Временные хиты существа (в JS — число или объект `{ amount }`).
    pub fn temporary_hp_of(&self, actor_id: &str) -> i64 {
        match self.temporary_hp.get(actor_id) {
            Some(Value::Object(record)) => crate::json::int(record.get("amount").or(record.get("current")), 0),
            Some(value) => crate::json::int(Some(value), 0),
            None => 0,
        }
        .max(0)
    }
}

/// Клетка карты сцены.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Cell {
    #[serde(deserialize_with = "lenient::i64", default)]
    pub x: i64,
    #[serde(deserialize_with = "lenient::i64", default)]
    pub y: i64,
    #[serde(rename = "type", default, deserialize_with = "lenient::string")]
    pub cell_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revealed: Option<bool>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Сцена.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Scene {
    #[serde(default, deserialize_with = "lenient::opt_string", skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "lenient::opt_string", skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(default, deserialize_with = "lenient::opt_string", skip_serializing_if = "Option::is_none")]
    pub location_id: Option<String>,
    #[serde(default, deserialize_with = "lenient::opt_i64", skip_serializing_if = "Option::is_none")]
    pub turn: Option<i64>,
    #[serde(default)]
    pub cells: Vec<Cell>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map: Option<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Состояние кампании.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct CampaignState {
    #[serde(rename = "sessionCode", default, deserialize_with = "lenient::opt_string", skip_serializing_if = "Option::is_none")]
    pub session_code: Option<String>,
    #[serde(default, deserialize_with = "lenient::i64")]
    pub state_version: i64,
    #[serde(default, deserialize_with = "lenient::string")]
    pub ruleset_id: String,
    #[serde(default, deserialize_with = "lenient::string")]
    pub ruleset_version: String,
    #[serde(default, deserialize_with = "lenient::strings")]
    pub enabled_rule_packs: Vec<String>,
    #[serde(default, deserialize_with = "lenient::strings")]
    pub enabled_house_rules: Vec<String>,
    #[serde(rename = "partyMemberIds", default, deserialize_with = "lenient::strings")]
    pub party_member_ids: Vec<String>,
    #[serde(rename = "activePlayerId", default, deserialize_with = "lenient::opt_string", skip_serializing_if = "Option::is_none")]
    pub active_player_id: Option<String>,
    #[serde(default)]
    pub players: Vec<Actor>,
    #[serde(default)]
    pub enemies: Vec<Actor>,
    #[serde(default)]
    pub actors: Vec<Actor>,
    #[serde(default)]
    pub scene: Scene,
    #[serde(default)]
    pub mechanics: Mechanics,
    #[serde(rename = "battleLog", default)]
    pub battle_log: Vec<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Сторона существа.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Party,
    Enemy,
    Other,
}

impl CampaignState {
    pub fn from_json(value: Value) -> serde_json::Result<Self> {
        serde_json::from_value(value)
    }

    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).expect("состояние сериализуется")
    }

    /// Существо по id: герои, противники, прочие.
    pub fn actor(&self, id: &str) -> Option<&Actor> {
        self.players.iter().chain(self.enemies.iter()).chain(self.actors.iter()).find(|actor| actor.id == id)
    }

    pub fn actor_mut(&mut self, id: &str) -> Option<&mut Actor> {
        if let Some(index) = self.players.iter().position(|actor| actor.id == id) {
            return self.players.get_mut(index);
        }
        if let Some(index) = self.enemies.iter().position(|actor| actor.id == id) {
            return self.enemies.get_mut(index);
        }
        self.actors.iter_mut().find(|actor| actor.id == id)
    }

    pub fn side(&self, id: &str) -> Side {
        if self.players.iter().any(|actor| actor.id == id) {
            Side::Party
        } else if self.enemies.iter().any(|actor| actor.id == id) {
            Side::Enemy
        } else {
            // Призванные существа отряда живут в `actors` с владельцем-героем.
            match self.actors.iter().find(|actor| actor.id == id) {
                Some(actor) if actor.extra_str("ownerId").is_some_and(|owner| self.players.iter().any(|hero| hero.id == owner)) => Side::Party,
                Some(actor) if actor.extra_str("hostile").is_some() || actor.extra.get("hostile").and_then(Value::as_bool) == Some(true) => Side::Enemy,
                _ => Side::Other,
            }
        }
    }

    /// Позиция существа: из `mechanics.positions`, иначе из `x`/`y` карточки.
    pub fn position(&self, id: &str) -> Option<Point> {
        if let Some(position) = self.mechanics.positions.get(id) {
            return Some(position.point());
        }
        let actor = self.actor(id)?;
        Some(Point::new(actor.x?, actor.y?))
    }

    pub fn has_house_rule(&self, rule: &str) -> bool {
        self.enabled_house_rules.iter().any(|entry| entry == rule)
    }

    pub fn uses_2014(&self) -> bool {
        self.ruleset_id.is_empty() || self.ruleset_id == "dnd_5e_2014"
    }

    pub fn cell(&self, point: Point) -> Option<&Cell> {
        self.scene.cells.iter().find(|cell| cell.x == point.x && cell.y == point.y)
    }
}

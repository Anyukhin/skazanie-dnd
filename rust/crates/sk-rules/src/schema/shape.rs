//! Проверка формы состояния при загрузке (урок 4): строгие `serde`-структуры
//! ядра формы — верх `CampaignState`, основные поля героя и NPC, `combat`.
//!
//! Это проверка, а не рабочее представление: движок читает и пишет тот же
//! `serde_json::Value`, а структуры только подтверждают, что снимок той
//! формы, которую даёт нормализация. Поля вне ядра структуры не описывают:
//! `serde` пропускает их без копии (`#[serde(flatten)]` буферизовал бы всё
//! поддерево, а снимок конца кампании — мегабайты), они остаются в `Value`.
//!
//! Структуры читают `&Value` без копии (`Deserialize` для `&Value`). Ошибка
//! называет путь поля (`players[2].hp`): каждое вложенное поле читается
//! своим шагом с отметкой пути.

use serde::de::IgnoredAny;
use serde::Deserialize;
use serde_json::Value;

/// Нарушение формы: путь поля и что с ним не так.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShapeError {
    pub path: String,
    pub message: String,
}

impl std::fmt::Display for ShapeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.path, self.message)
    }
}

impl std::error::Error for ShapeError {}

/// Число JS (целое или дробное).
#[derive(Deserialize)]
#[serde(transparent)]
struct Number(#[allow(dead_code)] f64);

/// Верх состояния кампании.
#[derive(Deserialize)]
#[allow(dead_code)] // поля только проверяются при чтении
struct CampaignState {
    players: Vec<IgnoredAny>,
    state_version: Number,
    mechanics: IgnoredAny,
    #[serde(default)]
    actors: Option<Vec<IgnoredAny>>,
    #[serde(default)]
    enemies: Option<Vec<IgnoredAny>>,
    #[serde(default)]
    scene: Option<std::collections::BTreeMap<String, IgnoredAny>>,
    #[serde(default)]
    messages: Option<Vec<IgnoredAny>>,
    #[serde(default, rename = "battleLog")]
    battle_log: Option<Vec<IgnoredAny>>,
}

/// Герой: основные поля листа.
#[derive(Deserialize)]
#[allow(dead_code)] // поля только проверяются при чтении
struct Player {
    id: String,
    hp: Number,
    #[serde(rename = "maxHp")]
    max_hp: Number,
    #[serde(default)]
    inventory: Option<Vec<IgnoredAny>>,
    #[serde(default)]
    abilities: Option<std::collections::BTreeMap<String, IgnoredAny>>,
}

/// NPC сцены (`actors`) и враги (`enemies`): объект с идентификатором.
#[derive(Deserialize)]
#[allow(dead_code)] // поля только проверяются при чтении
struct Actor {
    id: Value,
}

/// `mechanics`: опорные реестры боя.
#[derive(Deserialize)]
#[allow(dead_code)] // поля только проверяются при чтении
struct Mechanics {
    combat: IgnoredAny,
    positions: std::collections::BTreeMap<String, IgnoredAny>,
    conditions: std::collections::BTreeMap<String, IgnoredAny>,
}

/// `mechanics.combat`.
#[derive(Deserialize)]
#[allow(dead_code)] // поля только проверяются при чтении
struct Combat {
    active: bool,
    round: Number,
    initiative: Vec<IgnoredAny>,
    active_index: Number,
    action_economy: std::collections::BTreeMap<String, IgnoredAny>,
}

/// Прочитать `value` как `T`; ошибка — с путём.
fn read<'a, T: Deserialize<'a>>(value: &'a Value, path: &str) -> Result<T, ShapeError> {
    T::deserialize(value).map_err(|error| ShapeError { path: path.to_string(), message: error.to_string() })
}

/// Поле объекта или ошибка «нет поля».
fn field<'a>(value: &'a Value, key: &str, path: &str) -> Result<&'a Value, ShapeError> {
    value.get(key).ok_or_else(|| ShapeError { path: path.to_string(), message: "нет поля".to_string() })
}

fn each<'a>(value: Option<&'a Value>) -> impl Iterator<Item = (usize, &'a Value)> {
    value.and_then(Value::as_array).into_iter().flatten().enumerate()
}

/// Проверить форму нормализованного состояния кампании. Сначала поля по
/// одному (ошибка — с точным путём), затем структуры целиком.
pub fn check_campaign_state(state: &Value) -> Result<(), ShapeError> {
    if !state.is_object() {
        return Err(ShapeError { path: "$".into(), message: "состояние — не объект".into() });
    }
    read::<Vec<IgnoredAny>>(field(state, "players", "players")?, "players")?;
    read::<Number>(field(state, "state_version", "state_version")?, "state_version")?;
    for key in ["actors", "enemies", "messages", "battleLog"] {
        if let Some(value) = state.get(key) {
            read::<Option<Vec<IgnoredAny>>>(value, key)?;
        }
    }
    if let Some(scene) = state.get("scene") {
        read::<Option<std::collections::BTreeMap<String, IgnoredAny>>>(scene, "scene")?;
    }
    for (index, player) in each(state.get("players")) {
        let at = format!("players[{index}]");
        if !player.is_object() {
            return Err(ShapeError { path: at, message: "герой — не объект".into() });
        }
        read::<String>(field(player, "id", &format!("{at}.id"))?, &format!("{at}.id"))?;
        for key in ["hp", "maxHp"] {
            let path = format!("{at}.{key}");
            read::<Number>(field(player, key, &path)?, &path)?;
        }
        if let Some(inventory) = player.get("inventory") {
            read::<Option<Vec<IgnoredAny>>>(inventory, &format!("{at}.inventory"))?;
        }
        read::<Player>(player, &at)?;
    }
    for key in ["actors", "enemies"] {
        for (index, actor) in each(state.get(key)) {
            let at = format!("{key}[{index}]");
            if !actor.is_object() {
                return Err(ShapeError { path: at, message: "существо — не объект".into() });
            }
            read::<Actor>(actor, &at)?;
        }
    }
    let mechanics = field(state, "mechanics", "mechanics")?;
    if !mechanics.is_object() {
        return Err(ShapeError { path: "mechanics".into(), message: "не объект".into() });
    }
    for key in ["positions", "conditions"] {
        let path = format!("mechanics.{key}");
        read::<std::collections::BTreeMap<String, IgnoredAny>>(field(mechanics, key, &path)?, &path)?;
    }
    let combat = field(mechanics, "combat", "mechanics.combat")?;
    if !combat.is_object() {
        return Err(ShapeError { path: "mechanics.combat".into(), message: "не объект".into() });
    }
    for key in ["active", "round", "initiative", "active_index", "action_economy"] {
        let path = format!("mechanics.combat.{key}");
        let value = field(combat, key, &path)?;
        match key {
            "active" => read::<bool>(value, &path).map(drop)?,
            "initiative" => read::<Vec<IgnoredAny>>(value, &path).map(drop)?,
            "action_economy" => read::<std::collections::BTreeMap<String, IgnoredAny>>(value, &path).map(drop)?,
            _ => read::<Number>(value, &path).map(drop)?,
        }
    }
    read::<Combat>(combat, "mechanics.combat")?;
    read::<Mechanics>(mechanics, "mechanics")?;
    read::<CampaignState>(state, "$")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn minimal() -> Value {
        json!({
            "players": [{ "id": "hero", "hp": 7, "maxHp": 10, "inventory": [], "abilities": { "str": 10 } }],
            "actors": [{ "id": "npc" }],
            "state_version": 3,
            "mechanics": { "positions": {}, "conditions": {}, "combat": { "active": false, "round": 0, "initiative": [], "active_index": 0, "action_economy": {} } },
            "extra": { "kept": true }
        })
    }

    #[test]
    fn accepts_the_core_shape_and_ignores_the_rest() {
        assert_eq!(check_campaign_state(&minimal()), Ok(()));
    }

    #[test]
    fn names_the_broken_field() {
        let mut state = minimal();
        state["players"] = json!({ "hero": {} });
        assert_eq!(check_campaign_state(&state).map_err(|error| error.path), Err("players".to_string()));
        let mut state = minimal();
        state["players"][0]["hp"] = json!("семь");
        assert_eq!(check_campaign_state(&state).map_err(|error| error.path), Err("players[0].hp".to_string()));
        let mut state = minimal();
        state["mechanics"]["combat"]["initiative"] = json!({});
        assert_eq!(check_campaign_state(&state).map_err(|error| error.path), Err("mechanics.combat.initiative".to_string()));
    }
}

//! Перенос `server/combat-forecast-view.mjs` — прогноз удара для конкретного
//! зрителя: шанс попасть, крит, укрытие, дальность.
//!
//! Числа считает `attackForecast` (`sk_rules::preview_attack::attack_forecast`)
//! по доверенному состоянию, а здесь решается, что из них этому зрителю можно
//! показать. Правило раскрытия одно — то же, что у карточки врага в проекции:
//! КД цели открыта ровно тогда, когда проекция отдала зрителю поле `armor`.
//! Пока КД закрыта, закрыто и всё, что из неё выводится: процент попадания при
//! известном бонусе атаки однозначно восстанавливает КД (инвариант «прогноз
//! удара не выдаёт закрытую КД процентом попадания»,
//! `test/combat-forecast-disclosure.test.mjs`). Шанс крита остаётся, кроме
//! гарантированного крита по обездвиженной цели в упор — там он равен шансу
//! попасть и прячется вместе с ним.
//!
//! Мусор в состоянии ведёт себя как в JS: обращение к полю `null` и вызов
//! метода массива у не-массива — `TypeError` ([`Halt::Fault`]); строка вместо
//! списка врагов перебирается по символам.

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_rules::pause::{Fault, Halt};
use sk_rules::preview_attack::{attack_forecast, ForecastOptions};

/// `value?.[key]` для объекта; у прочих значений именованных полей нет.
fn prop<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match value {
        Some(Value::Object(map)) => map.get(key),
        _ => None,
    }
}

/// `value.key` без `?.`: у `null` — `TypeError`.
fn strict_prop<'a>(value: &'a Value, key: &str) -> Result<Option<&'a Value>, Halt> {
    if value.is_null() {
        return Err(Fault::type_error(format!("Cannot read properties of null (reading '{key}')")).into());
    }
    Ok(prop(Some(value), key))
}

/// `a ?? b`.
fn nullish<'a>(value: Option<&'a Value>, fallback: Option<&'a Value>) -> Option<&'a Value> {
    if js::present(value) {
        value
    } else {
        fallback
    }
}

/// Список для метода массива (`.some`, `.find`, `.filter`, `.concat`):
/// отсутствующее — пустой, не-массив — `TypeError`.
fn array_for_method<'a>(value: Option<&'a Value>, method: &str) -> Result<&'a [Value], Halt> {
    match value {
        None | Some(Value::Null) => Ok(&[]),
        Some(Value::Array(items)) => Ok(items.as_slice()),
        Some(_) => Err(Fault::type_error(format!("(intermediate value).{method} is not a function")).into()),
    }
}

/// `for (const x of value ?? [])`: массив, строка по символам, иначе `TypeError`.
fn iterate(value: Option<&Value>) -> Result<Vec<Value>, Halt> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => Ok(items.clone()),
        Some(Value::String(text)) => Ok(text.chars().map(|ch| Value::String(ch.to_string())).collect()),
        Some(_) => Err(Fault::type_error("value is not iterable").into()),
    }
}

/// `container?.[key]`: ключ свойства — `String(key)`; у массива — индекс.
fn index<'a>(container: Option<&'a Value>, key: &Value) -> Option<&'a Value> {
    let key = js::s(Some(key));
    match container {
        Some(Value::Object(map)) => map.get(&key),
        Some(Value::Array(items)) if js::is_array_index_key(&key) => key.parse::<usize>().ok().and_then(|position| items.get(position)),
        _ => None,
    }
}

/// `{ ...value }` для любого значения: строка и массив дают ключи-индексы.
fn spread_any(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map.clone(),
        Value::Array(items) => items.iter().enumerate().map(|(position, item)| (position.to_string(), item.clone())).collect(),
        Value::String(text) => text.chars().enumerate().map(|(position, ch)| (position.to_string(), Value::String(ch.to_string()))).collect(),
        _ => Map::new(),
    }
}

/// `withoutHiddenArmor(shot)`: скрыть из варианта удара всё, что выдаёт
/// закрытую КД.
fn without_hidden_armor(mut shot: Map<String, Value>) -> Map<String, Value> {
    shot.insert("armor_class".into(), Value::Null);
    shot.insert("hit_chance".into(), Value::Null);
    if js::truthy(shot.get("critical_on_hit")) {
        shot.insert("critical_chance".into(), Value::Null);
    }
    // Иначе `critical_chance: shot.critical_chance` — поле остаётся как было,
    // а отсутствующее (`undefined`) в JSON не попадает.
    shot.insert("armor_known".into(), Value::Bool(false));
    shot
}

/// `withCombatForecast(projected, trustedState, viewerActorId)`: проекция
/// зрителя с полем `combatForecast` (`{ actor_id, targets }`), если зритель
/// сейчас ходит и есть хотя бы одна видимая ему живая цель; иначе проекция
/// как есть. `None` — `undefined`.
pub fn with_combat_forecast(projected: Option<&Value>, trusted_state: Option<&Value>, viewer_actor_id: Option<&Value>) -> Result<Option<Value>, Halt> {
    let unchanged = || Ok(projected.cloned());
    let Some(projected_value) = projected.filter(|value| js::truthy(Some(value))) else { return unchanged() };
    let combat = prop(prop(trusted_state, "mechanics"), "combat");
    if !js::truthy(prop(combat, "active")) {
        return unchanged();
    }
    let active_index = nullish(prop(combat, "active_index"), None).cloned().unwrap_or_else(|| Value::from(0));
    let attacker_id = js::s(prop(index(prop(combat, "initiative"), &active_index), "actor_id"));
    if attacker_id.is_empty() {
        return unchanged();
    }
    // Прогноз нужен только тому, кто сейчас ходит: чужой ход игрок не планирует.
    let mut controls = js::s(viewer_actor_id) == attacker_id;
    if !controls {
        for player in array_for_method(prop(Some(projected_value), "players"), "some")? {
            if js::string(strict_prop(player, "id")?) == attacker_id {
                controls = true;
                break;
            }
        }
    }
    if !controls {
        return unchanged();
    }
    let mut roster: Vec<Value> = array_for_method(prop(trusted_state, "players"), "concat")?.to_vec();
    match prop(trusted_state, "actors") {
        None | Some(Value::Null) => {}
        Some(Value::Array(items)) => roster.extend(items.iter().cloned()),
        Some(other) => roster.push(other.clone()),
    }
    let mut attacker = None;
    for actor in &roster {
        if js::string(strict_prop(actor, "id")?) == attacker_id {
            attacker = Some(actor);
            break;
        }
    }
    let Some(attacker) = attacker else { return unchanged() };
    let mut options: Vec<(Value, String)> = Vec::new();
    for item in array_for_method(prop(Some(attacker), "inventory"), "filter")? {
        if js::truthy(prop(Some(item), "equipped")) && js::truthy(prop(prop(Some(item), "combat"), "kind")) {
            let label = match nullish(prop(Some(item), "name"), None) {
                Some(name) => js::string(Some(name)),
                None => "Оружие".to_string(),
            };
            options.push((Value::String(js::string(prop(Some(item), "id"))), label));
        }
    }
    options.push((Value::Null, "Базовая атака".to_string()));
    options.truncate(6);

    let mut forecast = Map::new();
    let trusted = trusted_state.unwrap_or(&Value::Null);
    for enemy in iterate(prop(trusted_state, "enemies"))? {
        if !js::truthy(Some(&enemy)) || js::is_false(prop(Some(&enemy), "alive")) || js::number(prop(Some(&enemy), "hp")) <= 0.0 {
            continue;
        }
        let enemy_id = js::string(prop(Some(&enemy), "id"));
        let mut visible = None;
        for candidate in array_for_method(prop(Some(projected_value), "enemies"), "find")? {
            if js::string(strict_prop(candidate, "id")?) == enemy_id {
                visible = Some(candidate);
                break;
            }
        }
        let Some(visible) = visible else { continue };
        // Источник истины — уже собранная карточка врага для этого зрителя.
        let armor_known = visible.as_object().is_some_and(|card| card.contains_key("armor"));
        let mut entries = Vec::new();
        for (item_id, label) in &options {
            let shot = attack_forecast(trusted, &attacker_id, &enemy_id, ForecastOptions { item_id: Some(item_id), ..ForecastOptions::default() })?;
            let Some(shot) = shot.filter(|shot| js::truthy(Some(shot))) else { continue };
            let mut entry = spread_any(&shot);
            entry.insert("label".into(), Value::String(label.clone()));
            entry.insert("item_id".into(), item_id.clone());
            entry.insert("armor_known".into(), Value::Bool(true));
            entries.push(Value::Object(if armor_known { entry } else { without_hidden_armor(entry) }));
        }
        // `forecast['__proto__'] = …` в JS меняет прототип, а не ключ: такой цели
        // нет ни в `Object.keys`, ни в JSON.
        if !entries.is_empty() && enemy_id != "__proto__" {
            forecast.insert(enemy_id, Value::Array(entries));
        }
    }
    if forecast.is_empty() {
        return unchanged();
    }
    let mut output = spread_any(projected_value);
    output.insert("combatForecast".into(), json!({ "actor_id": attacker_id, "targets": Value::Object(forecast) }));
    Ok(Some(Value::Object(output)))
}

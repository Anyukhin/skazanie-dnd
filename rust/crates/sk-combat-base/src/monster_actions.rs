//! Перенос `server/monster-actions.mjs`: доступность особых приёмов
//! чудовищ — перезарядка, «X раз», мультиатака, допустимая цель, область.
//!
//! Правила общие для движка и планировщика NPC. Потраченное хранится
//! маркерами состояний `monster-action-used:<ключ>` (перезарядка) и
//! `monster-action-used:<ключ>#<n>` (ограниченные применения). Состояния
//! передаются списком JSON: строка-идентификатор или объект с `id` (и
//! `source_actor` у захвата), как в JS.
//!
//! Из `dice-service` нужен только разбор выражения урона:
//! [`sk_dice::parse_dice_expression`]. Бросков модуль не делает.

use serde_json::{Map, Value};
use sk_core::{js, text};

use crate::jsv::{self, nullish, strict_eq, string_of};

const SAVE_ABILITIES: [&str; 6] = ["str", "dex", "con", "int", "wis", "cha"];
const DAMAGE_TYPES: [&str; 13] = ["acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic", "piercing", "poison", "psychic", "radiant", "slashing", "thunder"];
const INCAPACITATING: [&str; 5] = ["incapacitated", "paralyzed", "petrified", "stunned", "unconscious"];

fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    jsv::member(value, key)
}

/// Значения, которые `Math.min(...x)` получил бы из `x`: элементы массива или
/// символы строки. Прочее в JS не итерируется и роняет вызов — здесь пусто.
fn spread_numbers(value: Option<&Value>) -> Vec<f64> {
    match value {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items.iter().map(|item| js::number(Some(item))).collect(),
        Some(Value::String(text)) => text.chars().map(|ch| js::parse_number(&ch.to_string())).collect(),
        Some(_) => Vec::new(),
    }
}

/// `monsterRechargeMinimum(action)`: наименьший успех перезарядки 1–6 или 0.
pub fn monster_recharge_minimum(action: Option<&Value>) -> i64 {
    let recharge = get(action, "recharge");
    let value = if js::truthy(recharge) && matches!(recharge, Some(Value::Object(_)) | Some(Value::Array(_))) {
        js::min_of(spread_numbers(get(recharge, "success")))
    } else {
        js::number(Some(nullish(recharge, Some(&Value::from(0))).unwrap_or(&Value::Null)))
    };
    if value.is_finite() && value.fract() == 0.0 && (1.0..=6.0).contains(&value) {
        value as i64
    } else {
        0
    }
}

/// `monsterActionUsageKey(action)`: группа перезарядки или id приёма.
pub fn monster_action_usage_key(action: Option<&Value>) -> String {
    js::s(nullish(nullish(get(action, "recharge_group"), get(get(action, "recharge"), "group")), get(action, "id")))
}

/// Идентификатор состояния из списка: `String(value?.id ?? value)`.
fn condition_id(value: &Value) -> String {
    match nullish(get(Some(value), "id").filter(|_| value.is_object() || value.is_array()), None) {
        Some(id) => string_of(Some(id)),
        None => string_of(Some(value)),
    }
}

/// `monsterActionUsesSpent(action, conditions)`.
pub fn monster_action_uses_spent(action: Option<&Value>, conditions: &[Value]) -> usize {
    let marker = format!("monster-action-used:{}", monster_action_usage_key(action));
    let numbered = format!("{marker}#");
    conditions
        .iter()
        .filter(|value| {
            let id = condition_id(value);
            id == marker || id.starts_with(&numbered)
        })
        .count()
}

/// `monsterActionAvailable(action, conditions)`.
pub fn monster_action_available(action: Option<&Value>, conditions: &[Value]) -> bool {
    let spent = monster_action_uses_spent(action, conditions);
    if monster_recharge_minimum(action) != 0 {
        return spent == 0;
    }
    let maximum = js::number(Some(nullish(get(action, "uses"), Some(&Value::from(0))).unwrap_or(&Value::Null)));
    let safe = maximum.is_finite() && maximum.fract() == 0.0 && maximum.abs() <= 9_007_199_254_740_991.0;
    !safe || maximum <= 0.0 || (spent as f64) < maximum
}

/// `monsterActionSpentMarker(action, conditions)`: маркер следующего
/// применения или `None`, если приём ничем не ограничен.
pub fn monster_action_spent_marker(action: Option<&Value>, conditions: &[Value]) -> Option<String> {
    let marker = format!("monster-action-used:{}", monster_action_usage_key(action));
    if monster_recharge_minimum(action) != 0 {
        return Some(marker);
    }
    if js::number(get(action, "uses")) > 0.0 {
        return Some(format!("{marker}#{}", monster_action_uses_spent(action, conditions) + 1));
    }
    None
}

/// `monsterAttackTargetAllowed(action, conditions, sourceId)`: цель отвечает
/// `target_condition` и `target_any_conditions` приёма. `source_id` —
/// захвативший (`None` — `null` в JS).
pub fn monster_attack_target_allowed(action: Option<&Value>, conditions: &[Value], source_id: Option<&str>) -> bool {
    let ids: Vec<String> = conditions.iter().map(condition_id).collect();
    let has = |id: &str| ids.iter().any(|known| known == id);
    let target_condition = get(action, "target_condition");
    if js::truthy(target_condition) && !has(&string_of(target_condition)) {
        return false;
    }
    let any = match get(action, "target_any_conditions") {
        Some(Value::Array(items)) if !items.is_empty() => items,
        _ => return true,
    };
    any.iter().any(|condition| match condition {
        Value::String(name) if name == "incapacitated" => INCAPACITATING.iter().any(|id| has(id)),
        Value::String(name) if name == "grappled" => conditions.iter().any(|entry| {
            let source = get(Some(entry), "source_actor");
            jsv::is_str(get(Some(entry), "id"), "grappled")
                && match source_id {
                    Some(source_id) => jsv::is_str(source, source_id),
                    None => matches!(source, Some(Value::Null)),
                }
        }),
        Value::String(name) => has(name),
        _ => false,
    })
}

/// `monsterOnHitTargetAllowed(onHit, target)`: вид цели и исключения
/// эффекта попадания (эльфы — по расе и подвидам).
pub fn monster_on_hit_target_allowed(on_hit: &Value, target: Option<&Value>) -> bool {
    let kind = text::lower(&string_of(nullish(nullish(get(target, "creature_type"), get(target, "creatureType")), Some(&Value::String("humanoid".into())))));
    let required = on_hit.get("required_target_type");
    if js::truthy(required) && !jsv::is_str(required, &kind) {
        return false;
    }
    let race_source = nullish(nullish(nullish(get(get(target, "speciesBenefits"), "race_id"), get(target, "race_id")), get(target, "raceId")), get(target, "race"));
    // `?? ''`: последний запас — пустая строка.
    let race = text::lower(&js::s(race_source));
    let mut tags: Vec<Value> = vec![Value::String(kind), Value::String(race.clone())];
    if let Some(Value::Array(subtypes)) = get(target, "subtypes") {
        tags.extend(subtypes.iter().cloned());
    }
    if race.starts_with("elf-") || race == "drow" || race == "эльф" {
        tags.push(Value::String("elf".into()));
    }
    let excluded = match on_hit.get("excluded_targets") {
        Some(Value::Array(items)) => items.as_slice(),
        _ => &[],
    };
    !excluded.iter().any(|item| tags.iter().any(|tag| strict_eq(Some(tag), Some(item))))
}

/// `monsterMultiattackSequences(actor)`: последовательности мультиатаки,
/// целиком состоящие из реализованных атак (`action_profiles`).
pub fn monster_multiattack_sequences(actor: Option<&Value>) -> Vec<Vec<String>> {
    let traits = get(actor, "traits").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let Some(multiattack) = traits.iter().find(|item| jsv::is_str(get(Some(item), "id"), "multiattack")) else {
        return Vec::new();
    };
    let profiles: Vec<String> = get(actor, "action_profiles").and_then(Value::as_array).map(|items| items.iter().map(|action| string_of(get(Some(action), "id"))).collect()).unwrap_or_default();
    let non_empty = |value: Option<&Value>| value.and_then(Value::as_array).filter(|items| !items.is_empty()).cloned();
    let sequences: Vec<Value> = non_empty(multiattack.get("sequences"))
        .or_else(|| non_empty(multiattack.get("sequence")).map(|sequence| vec![Value::Array(sequence)]))
        .unwrap_or_default();
    sequences
        .iter()
        .enumerate()
        .filter(|(index, sequence)| {
            let requirement = get(multiattack.get("sequence_conditions"), &index.to_string());
            if js::truthy(requirement) && !(jsv::is_str(get(requirement, "requires"), "flying") && jsv::is_str(get(actor, "movement_mode"), "fly")) {
                return false;
            }
            matches!(sequence, Value::Array(ids) if !ids.is_empty() && ids.len() <= 8 && ids.iter().all(|id| profiles.contains(&string_of(Some(id)))))
        })
        .map(|(_, sequence)| sequence.as_array().map(|ids| ids.iter().map(|id| string_of(Some(id))).collect()).unwrap_or_default())
        .collect()
}

/// `monsterMultiattackSequenceFor(actor, nextActionId, usedActionIds)`.
pub fn monster_multiattack_sequence_for(actor: Option<&Value>, next_action_id: &str, used_action_ids: &[String]) -> Option<Vec<String>> {
    let remaining: Vec<Vec<String>> = monster_multiattack_sequences(actor)
        .into_iter()
        .filter(|sequence| used_action_ids.iter().enumerate().all(|(index, id)| sequence.get(index) == Some(id)))
        .collect();
    let next = remaining.iter().find(|sequence| sequence.get(used_action_ids.len()).map(String::as_str) == Some(next_action_id)).cloned();
    next.or_else(|| remaining.into_iter().next())
}

/// `Object.keys(value ?? {}).length`.
fn own_keys_count(value: Option<&Value>) -> usize {
    match value {
        Some(Value::Object(map)) => map.len(),
        Some(Value::Array(items)) => items.len(),
        Some(Value::String(text)) => jsv::utf16_len(text),
        _ => 0,
    }
}

fn is_safe_integer_value(value: Option<&Value>) -> bool {
    js::is_safe_integer(value)
}

/// `monsterAreaAction(action)`: формализованная область урона (`save_area`
/// с конусом, линией шириной 5 футов или сферой) либо `None`; прочие особые
/// действия остаются справочными.
pub fn monster_area_action(action: Option<&Value>) -> Option<Value> {
    let action_value = action?;
    let field = |key: &str| get(action, key);
    if !jsv::is_str(field("kind"), "save_area") || !js::truthy(field("id")) || js::truthy(field("condition")) || js::truthy(field("on_hit")) || own_keys_count(field("effects")) > 0 {
        return None;
    }
    let save = field("save");
    if !SAVE_ABILITIES.iter().any(|ability| jsv::is_str(get(save, "ability"), ability)) {
        return None;
    }
    let dc = get(save, "dc");
    if !is_safe_integer_value(dc) || js::number(dc) < 1.0 || js::number(dc) > 40.0 {
        return None;
    }
    if !["half_damage", "no_damage"].iter().any(|success| jsv::is_str(get(save, "success"), success)) {
        return None;
    }
    let area = field("area");
    let shape = get(area, "shape").and_then(Value::as_str).filter(|shape| ["cone", "line", "sphere"].contains(shape))?.to_string();
    if shape == "line" && js::number(Some(nullish(get(area, "width_ft"), Some(&Value::from(5))).unwrap_or(&Value::Null))) != 5.0 {
        return None;
    }
    let length = js::number(nullish(get(area, "length_ft"), get(area, "radius_ft")));
    if !(length.is_finite() && length.fract() == 0.0) || !(5.0..=120.0).contains(&length) {
        return None;
    }
    let components = match field("damage") {
        Some(Value::Array(items)) if !items.is_empty() && items.len() <= 4 => items,
        _ => return None,
    };
    for component in components {
        if !DAMAGE_TYPES.iter().any(|kind| jsv::is_str(get(Some(component), "type"), kind)) {
            return None;
        }
        let expression = get(Some(component), "expression");
        if js::truthy(expression) {
            sk_dice::parse_dice_expression(&js::s(expression)).ok()?;
        } else {
            let amount = get(Some(component), "amount");
            if !is_safe_integer_value(amount) || js::number(amount) < 0.0 {
                return None;
            }
        }
    }
    let width = js::number(get(area, "width_ft"));
    let width = if width == 0.0 || width.is_nan() { 5.0 } else { width };
    let mut result = match action_value {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    result.insert("name".into(), Value::String(string_of(nullish(nullish(field("name_ru"), field("name")), field("id")))));
    result.insert("recharge".into(), Value::from(monster_recharge_minimum(action)));
    result.insert("recharge_group".into(), nullish(field("recharge_group"), get(field("recharge"), "group")).cloned().unwrap_or(Value::Null));
    result.insert("shape".into(), Value::String(shape));
    result.insert("length_feet".into(), js::num(length));
    result.insert("width_feet".into(), js::num(width.min(120.0).max(5.0)));
    Some(Value::Object(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn several_uses_count_one_by_one_and_shared_recharge_links_variants() {
        let spike = json!({ "id": "tail-spike", "uses": 3 });
        let mut conditions: Vec<Value> = Vec::new();
        for _ in 0..3 {
            assert!(monster_action_available(Some(&spike), &conditions));
            conditions.push(Value::String(monster_action_spent_marker(Some(&spike), &conditions).expect("маркер")));
        }
        assert!(!monster_action_available(Some(&spike), &conditions));
        let fire = json!({ "id": "fire-breath", "recharge": { "success": [5, 6], "group": "breaths" } });
        let sleep = json!({ "id": "sleep-breath", "recharge": { "success": [5, 6], "group": "breaths" } });
        let spent = vec![Value::String(monster_action_spent_marker(Some(&fire), &[]).expect("маркер"))];
        assert!(!monster_action_available(Some(&sleep), &spent));
    }

    #[test]
    fn recharge_minimum_follows_js_coercions() {
        assert_eq!(monster_recharge_minimum(Some(&json!({ "recharge": { "success": [5, 6] } }))), 5);
        assert_eq!(monster_recharge_minimum(Some(&json!({ "recharge": { "success": "46" } }))), 4);
        assert_eq!(monster_recharge_minimum(Some(&json!({ "recharge": "6" }))), 6);
        assert_eq!(monster_recharge_minimum(Some(&json!({ "recharge": [5] }))), 0);
        assert_eq!(monster_recharge_minimum(Some(&json!({ "recharge": 7 }))), 0);
        assert_eq!(monster_recharge_minimum(None), 0);
    }

    #[test]
    fn grapple_requirement_reads_the_source_actor() {
        let action = json!({ "target_any_conditions": ["grappled"] });
        let grappled = [json!({ "id": "grappled", "source_actor": "boss" })];
        assert!(monster_attack_target_allowed(Some(&action), &grappled, Some("boss")));
        assert!(!monster_attack_target_allowed(Some(&action), &grappled, Some("other")));
        assert!(!monster_attack_target_allowed(Some(&action), &grappled, None));
        assert!(monster_attack_target_allowed(Some(&json!({ "target_any_conditions": ["incapacitated"] })), &[json!("stunned")], None));
    }
}

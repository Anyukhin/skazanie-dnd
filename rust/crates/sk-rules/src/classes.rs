//! Класс героя и число атак за действие Атака — перенос части
//! `server/combat-actions.mjs` (`actorClass`, `weaponAttacksPerActionFor`).

use serde_json::Value;
use sk_core::js::{s, safe_int};

/// Класс по тексту роли, как `actorClass`: первый совпавший шаблон в порядке JS.
pub fn actor_class(actor: &Value) -> Option<&'static str> {
    let role = format!("{} {} {}", s(actor.get("role")), s(actor.get("class")), s(actor.get("characterClass"))).to_lowercase();
    const PATTERNS: [(&str, &[&str]); 11] = [
        ("barbarian", &["варвар", "barbarian"]),
        ("bard", &["бард", "bard"]),
        ("cleric", &["жрец", "cleric"]),
        ("druid", &["друид", "druid"]),
        ("fighter", &["воин", "fighter"]),
        ("monk", &["монах", "monk"]),
        ("paladin", &["паладин", "paladin"]),
        ("ranger", &["следопыт", "ranger"]),
        ("rogue", &["плут", "разбойник", "rogue"]),
        ("sorcerer", &["чарод", "sorcer"]),
        ("warlock", &["колдун", "warlock"]),
    ];
    for (key, words) in PATTERNS {
        if words.iter().any(|word| role.contains(word)) {
            return Some(key);
        }
    }
    if role.contains("волшеб") || role.contains("wizard") || has_word_mag(&role) {
        return Some("wizard");
    }
    None
}

/// `/маг\b/u` в JS. Граница слова в JS считается только по ASCII: «г» — не
/// символ слова, поэтому `\b` после «маг» есть лишь перед ASCII-символом
/// слова, а перед пробелом и концом строки её нет. Повторяем это буквально.
fn has_word_mag(role: &str) -> bool {
    let mut search = role;
    while let Some(index) = search.find("маг") {
        let after = &search[index + "маг".len()..];
        if matches!(after.chars().next(), Some(next) if next.is_ascii_alphanumeric() || next == '_') {
            return true;
        }
        search = after;
    }
    false
}

/// Уровень героя для таблиц классов: 1–12.
pub fn class_level(actor: &Value) -> i64 {
    let level = actor.get("level").and_then(|value| value.as_f64().or_else(|| value.as_str().and_then(|text| text.parse().ok()))).unwrap_or(0.0);
    let level = if level.is_finite() && level != 0.0 { level.trunc() as i64 } else { 1 };
    level.clamp(1, 12)
}

/// `weaponAttacksPerActionFor(actor)`: Дополнительная атака с 5-го уровня,
/// у воина с 11-го — три атаки.
pub fn weapon_attacks_per_action(actor: &Value) -> i64 {
    let level = class_level(actor);
    match actor_class(actor) {
        Some("fighter") if level >= 11 => 3,
        Some("fighter" | "barbarian" | "monk" | "paladin" | "ranger") if level >= 5 => 2,
        _ => 1,
    }
}

/// Черта существа из `traits` (`monsterTraitFor`).
pub fn monster_trait<'a>(actor: &'a Value, trait_id: &str) -> Option<&'a Value> {
    actor.get("traits")?.as_array()?.iter().find(|entry| match entry {
        Value::Object(map) => s(map.get("id")) == trait_id,
        other => s(Some(other)) == trait_id,
    })
}

/// `monsterMultiattackSequences(actor)`: допустимые последовательности мультиатаки.
pub fn monster_multiattack_sequences(actor: &Value) -> Vec<Vec<String>> {
    let Some(multiattack) = monster_trait(actor, "multiattack") else { return Vec::new() };
    let profiles: std::collections::HashSet<String> = actor
        .get("action_profiles")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(|action| s(action.get("id"))).collect())
        .unwrap_or_default();
    let nonempty = |value: Option<&Value>| value.and_then(Value::as_array).filter(|items| !items.is_empty()).cloned();
    let sequences: Vec<Value> = if let Some(list) = nonempty(multiattack.get("sequences")) {
        list
    } else if let Some(single) = nonempty(multiattack.get("sequence")) {
        vec![Value::Array(single)]
    } else {
        Vec::new()
    };
    sequences
        .iter()
        .enumerate()
        .filter(|(index, sequence)| {
            let requirement = multiattack.get("sequence_conditions").and_then(|list| list.get(*index)).filter(|value| !value.is_null());
            if let Some(requirement) = requirement {
                if !(s(requirement.get("requires")) == "flying" && s(actor.get("movement_mode")) == "fly") {
                    return false;
                }
            }
            sequence.as_array().is_some_and(|items| !items.is_empty() && items.len() <= 8 && items.iter().all(|id| profiles.contains(&s(Some(id)))))
        })
        .map(|(_, sequence)| sequence.as_array().map(|items| items.iter().map(|id| s(Some(id))).collect()).unwrap_or_default())
        .collect()
}

/// Число атак мультиатаки существа (`allowedWeaponAttacks` без героя и ускорения).
pub fn monster_multiattack_count(actor: &Value) -> i64 {
    let Some(multiattack) = monster_trait(actor, "multiattack") else { return 1 };
    let action_count: i64 = multiattack
        .get("action_counts")
        .and_then(Value::as_object)
        .map(|counts| counts.iter().map(|(id, count)| if id.is_empty() { 0 } else { safe_int(Some(count), 0).clamp(0, 8) }).sum())
        .unwrap_or(0);
    let own_sequence = multiattack.get("sequence").and_then(Value::as_array).map(Vec::len).unwrap_or(0) as i64;
    let sequence_count = monster_multiattack_sequences(actor).iter().map(|sequence| sequence.len() as i64).chain([own_sequence, 0]).max().unwrap_or(0);
    let count = if action_count > 0 {
        action_count
    } else if sequence_count > 0 {
        sequence_count
    } else {
        safe_int(multiattack.get("attacks"), 1)
    };
    count.clamp(1, 8)
}

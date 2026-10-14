//! Перенос `server/character-progression.mjs`: каталог развития классов
//! 1–12 уровня (`data/dndsu-class-build-rules-1-12.json`) — классовые навыки,
//! их лимиты, выборы особенностей по уровням (боевые стили, манёвры,
//! метамагия, воззвания, дары договора) и характеристика навыка.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::{js, re, text};

use crate::support::{array, defined, embedded_json, prop, slice_len, unique_strings};

const CATALOG_SOURCE: &str = include_str!("../../../../data/dndsu-class-build-rules-1-12.json");
const MANIFEST_SOURCE: &str = include_str!("../../../../data/character-rules-manifest.json");

/// Разобранный каталог и его индексы (в JS — состояние модуля).
struct Catalog {
    provenance: Value,
    payload: Value,
    /// `SKILLS`: id → запись навыка.
    skills: Vec<(String, Value)>,
    /// `CLASS_RULES`: ключ класса → правило навыков класса.
    class_rules: HashMap<String, Value>,
    feature_groups: Vec<Value>,
    /// `SKILL_ABILITY_BY_KEY`.
    skill_ability_by_key: HashMap<String, Value>,
    /// `SKILL_ID_BY_KEY`.
    skill_id_by_key: HashMap<String, String>,
}

static CATALOG: LazyLock<Catalog> = LazyLock::new(|| {
    let provenance = embedded_json(MANIFEST_SOURCE);
    let payload = embedded_json(CATALOG_SOURCE);
    let mut skills: Vec<(String, Value)> = Vec::new();
    for entry in array(payload.get("skills")) {
        let id = js::s(entry.get("id"));
        match skills.iter_mut().find(|(known, _)| *known == id) {
            Some(slot) => slot.1 = entry.clone(),
            None => skills.push((id, entry.clone())),
        }
    }
    let class_rules = array(payload.get("classes"))
        .iter()
        .filter_map(|entry| Some((entry.get("classKey")?.as_str()?.to_string(), entry.clone())))
        .collect();
    let feature_groups = array(payload.get("featureChoiceGroups")).to_vec();
    let skill_ability_by_key =
        skills.iter().map(|(id, entry)| (canonical_skill_key(id), entry.get("ability").cloned().unwrap_or(Value::Null))).collect();
    let skill_id_by_key = skills.iter().map(|(id, _)| (canonical_skill_key(id), id.clone())).collect();
    Catalog { provenance, payload, skills, class_rules, feature_groups, skill_ability_by_key, skill_id_by_key }
});

/// `CHARACTER_RULES_PROVENANCE`: манифест происхождения каталога.
pub static CHARACTER_RULES_PROVENANCE: LazyLock<Value> = LazyLock::new(|| CATALOG.provenance.clone());

/// Проверка, которую JS делает при загрузке модуля: каталог совпадает со своим
/// манифестом (хеш, размер, предельный уровень). Данные встроены при сборке,
/// поэтому здесь она — сторож в тестах, а не паника при первом обращении.
#[cfg_attr(not(test), allow(dead_code))] // вызывается только тестами
fn catalog_provenance_check() -> Result<(), String> {
    let manifest = &CATALOG.provenance;
    let hash = sk_core::hash::sha256_hex(CATALOG_SOURCE.as_bytes());
    if Some(hash.as_str()) != manifest.get("source_sha256").and_then(Value::as_str)
        || Some(CATALOG_SOURCE.len() as u64) != manifest.get("source_size_bytes").and_then(Value::as_u64)
    {
        return Err("Character rules catalog does not match its versioned provenance manifest".into());
    }
    if manifest.get("maximum_character_level") != CATALOG.payload.get("maximumCharacterLevel") {
        return Err("Character rules manifest level cap does not match the catalog".into());
    }
    Ok(())
}

/// `normalizedName(value)`: нижний регистр, «ё» → «е», всё кроме букв и цифр —
/// пробел.
fn normalized_name(value: Option<&Value>) -> String {
    let lowered = text::lower(&js::s(value)).replace('ё', "е");
    text::trim(&text::replace_all(re!(r"[^a-zа-я0-9]+", "giu"), &lowered, " ")).to_string()
}

/// `${actor?.role ?? ''} ${actor?.class ?? ''} ${actor?.characterClass ?? ''}` в нижнем регистре.
fn role_text(actor: Option<&Value>) -> String {
    let part = |key: &str| js::s(defined(prop(actor, key)));
    text::lower(&format!("{} {} {}", part("role"), part("class"), part("characterClass")))
}

/// `characterClassKey(actor)`: класс из `characterClass`, иначе по словам роли.
pub fn character_class_key(actor: Option<&Value>) -> Option<String> {
    let explicit = text::lower(&js::s(defined(prop(actor, "characterClass"))));
    if CATALOG.class_rules.contains_key(&explicit) {
        return Some(explicit);
    }
    let role = role_text(actor);
    let patterns: [(&str, &sk_core::fancy_regex::Regex); 12] = [
        ("barbarian", re!(r"варвар|barbarian", "u")),
        ("bard", re!(r"бард|bard", "u")),
        ("cleric", re!(r"жрец|cleric", "u")),
        ("druid", re!(r"друид|druid", "u")),
        ("fighter", re!(r"воин|fighter", "u")),
        ("monk", re!(r"монах|monk", "u")),
        ("paladin", re!(r"паладин|paladin", "u")),
        ("ranger", re!(r"следопыт|ranger", "u")),
        ("rogue", re!(r"плут|разбойник|rogue", "u")),
        ("sorcerer", re!(r"чарод|sorcer", "u")),
        ("warlock", re!(r"колдун|warlock", "u")),
        // `маг\b` в JS — граница ASCII-слова: «маг» в конце строки или перед
        // кириллицей её не даёт (см. отчёт переноса), перенесено как есть.
        ("wizard", re!(r"волшеб|wizard|маг\b", "u")),
    ];
    patterns.iter().find(|(_, pattern)| text::test(pattern, &role)).map(|(key, _)| key.to_string())
}

/// `classSkillRuleFor(actor)`: правило навыков класса героя.
pub fn class_skill_rule_for(actor: Option<&Value>) -> Option<Value> {
    let class_key = character_class_key(actor)?;
    CATALOG.class_rules.get(&class_key).cloned()
}

/// Ключ сравнения навыка: `animal_handling` и `animal-handling` — одно.
fn canonical_skill_key(value: &str) -> String {
    text::lower(text::trim(value)).replace('_', "-")
}

fn canonical_skill_key_of(value: Option<&Value>) -> String {
    canonical_skill_key(&js::s(value))
}

/// `catalogSkillId(value)`: написание навыка в каноне проекта
/// (подчёркивания); незнакомое значение — как есть.
pub fn catalog_skill_id(value: Option<&Value>) -> String {
    CATALOG.skill_id_by_key.get(&canonical_skill_key_of(value)).cloned().unwrap_or_else(|| js::s(value))
}

/// `normalizedClassSkillProficiencies(actor)`: выбранные классовые навыки из
/// списка класса без повторов и не больше лимита.
pub fn normalized_class_skill_proficiencies(actor: Option<&Value>) -> Vec<String> {
    let Some(rule) = class_skill_rule_for(actor) else {
        return Vec::new();
    };
    let Some(Value::Array(selected)) = prop(actor, "classSkillProficiencies") else {
        return Vec::new();
    };
    let allowed: Vec<String> = array(rule.get("skills")).iter().map(|skill| canonical_skill_key_of(Some(skill))).collect();
    let unique = unique_strings(selected.iter().map(|entry| catalog_skill_id(Some(entry))));
    let filtered: Vec<String> = unique.into_iter().filter(|id| allowed.contains(&canonical_skill_key(id))).collect();
    let keep = slice_len(filtered.len(), js::number(rule.get("choiceCount")));
    filtered.into_iter().take(keep).collect()
}

/// `isSkillProficient(actor, skillId)`: без списка выбора — владеет всем
/// (прежние герои); иначе только выбранным, плюс Обман и Убеждение колдуна с
/// «Влиянием обольщения».
pub fn is_skill_proficient(actor: Option<&Value>, skill_id: Option<&Value>) -> bool {
    if !matches!(prop(actor, "classSkillProficiencies"), Some(Value::Array(_))) {
        return true;
    }
    let wanted = canonical_skill_key_of(skill_id);
    if (wanted == "deception" || wanted == "persuasion") && normalized_selected_feature_ids(actor).iter().any(|id| id == "beguiling-influence") {
        return true;
    }
    normalized_class_skill_proficiencies(actor).iter().any(|id| canonical_skill_key(id) == wanted)
}

/// `skillAbility(skillId)`: характеристика навыка или `None`.
pub fn skill_ability(skill_id: Option<&Value>) -> Option<Value> {
    CATALOG.skill_ability_by_key.get(&canonical_skill_key_of(skill_id)).filter(|value| !value.is_null()).cloned()
}

/// `choiceCountAtLevel(group, level)`: число выборов группы на уровне —
/// значение с наибольшим порогом, не превышающим уровень, иначе 0.
fn choice_count_at_level(group: &Value, level: f64) -> f64 {
    let mut entries: Vec<(&String, &Value)> = match group.get("countsByLevel") {
        Some(Value::Object(counts)) => js::entries(counts),
        _ => Vec::new(),
    };
    entries.sort_by(|(left, _), (right, _)| {
        let (left, right) = (js::parse_number(left), js::parse_number(right));
        right.partial_cmp(&left).unwrap_or(std::cmp::Ordering::Equal)
    });
    let found = entries.into_iter().find(|(minimum, _)| level >= js::parse_number(minimum)).map(|(_, count)| count);
    match defined(found) {
        Some(count) => js::number(Some(count)),
        None => 0.0,
    }
}

fn hero_level(actor: Option<&Value>) -> f64 {
    let level = js::number(prop(actor, "level"));
    let level = if level.is_nan() || level == 0.0 { 1.0 } else { level };
    level.min(12.0).max(1.0)
}

/// `featureChoiceGroupsFor(actor)`: группы выборов особенностей класса,
/// открытые на уровне героя, с `choiceCount` этого уровня.
pub fn feature_choice_groups_for(actor: Option<&Value>) -> Vec<Value> {
    let class_key = character_class_key(actor);
    let level = hero_level(actor);
    let subclass_raw = defined(prop(actor, "subclass")).or_else(|| defined(prop(actor, "subClass"))).or_else(|| prop(actor, "archetype"));
    let subclass = normalized_name(subclass_raw);
    CATALOG
        .feature_groups
        .iter()
        .filter(|group| {
            group.get("classKey").and_then(Value::as_str).is_some_and(|key| class_key.as_deref() == Some(key))
                && level >= js::number(group.get("unlockLevel"))
                && (!js::truthy(group.get("subclass")) || normalized_name(group.get("subclass")) == subclass)
        })
        .map(|group| {
            let mut entry = match group {
                Value::Object(map) => map.clone(),
                _ => Map::new(),
            };
            entry.insert("choiceCount".into(), js::num(choice_count_at_level(group, level)));
            Value::Object(entry)
        })
        .collect()
}

/// `abilityScoreChoiceLevelsFor(actor)`: уровни стандартного улучшения
/// характеристик класса.
pub fn ability_score_choice_levels_for(actor: Option<&Value>) -> Vec<i64> {
    match character_class_key(actor).as_deref() {
        Some("fighter") => vec![4, 6, 8, 12],
        Some("rogue") => vec![4, 8, 10, 12],
        _ => vec![4, 8, 12],
    }
}

/// `normalizedSelectedFeatureIds(actor)`: выбранные особенности, которые есть в
/// открытых группах, не больше лимита каждой группы.
pub fn normalized_selected_feature_ids(actor: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(selected)) = prop(actor, "selectedFeatureIds") else {
        return Vec::new();
    };
    let selected: Vec<String> = selected.iter().map(|entry| crate::support::string_of(Some(entry))).collect();
    feature_choice_groups_for(actor)
        .iter()
        .flat_map(|group| {
            let options: Vec<&Value> = array(group.get("options"))
                .iter()
                .filter(|option| option.get("id").and_then(Value::as_str).is_some_and(|id| selected.iter().any(|entry| entry == id)))
                .collect();
            let keep = slice_len(options.len(), js::number(group.get("choiceCount")));
            options.into_iter().take(keep).map(|option| js::s(option.get("id"))).collect::<Vec<_>>()
        })
        .collect()
}

/// `isOptionalFeatureSelected(actor, featureId)`: необязательная особенность
/// доступна, только если выбрана; обязательные и прежние герои — всегда.
pub fn is_optional_feature_selected(actor: Option<&Value>, feature_id: Option<&Value>) -> bool {
    if !matches!(prop(actor, "selectedFeatureIds"), Some(Value::Array(_))) {
        return true;
    }
    let optional = feature_choice_groups_for(actor).iter().any(|group| {
        array(group.get("options")).iter().any(|option| match (option.get("id"), feature_id) {
            (Some(id), Some(wanted)) => crate::support::same_value_zero(id, wanted),
            _ => false,
        })
    });
    let wanted = js::s(feature_id);
    !optional || normalized_selected_feature_ids(actor).contains(&wanted)
}

/// `classBuildCatalogInfo()`: сводка каталога для клиента и аудита.
pub fn class_build_catalog_info() -> Value {
    let payload = &CATALOG.payload;
    let mut info = Map::new();
    info.insert("provenance".into(), CATALOG.provenance.clone());
    if let Some(profile) = payload.get("rulesProfile") {
        info.insert("rulesProfile".into(), profile.clone());
    }
    if let Some(level) = payload.get("maximumCharacterLevel") {
        info.insert("maximumCharacterLevel".into(), level.clone());
    }
    info.insert("skillCount".into(), json!(CATALOG.skills.len()));
    info.insert("featureChoiceGroupCount".into(), json!(CATALOG.feature_groups.len()));
    info.insert("skills".into(), Value::Array(array(payload.get("skills")).to_vec()));
    let classes = array(payload.get("classes"))
        .iter()
        .map(|entry| {
            let mut class = Map::new();
            for key in ["classKey", "choiceCount"] {
                if let Some(value) = entry.get(key) {
                    class.insert(key.into(), value.clone());
                }
            }
            class.insert("optionCount".into(), json!(array(entry.get("skills")).len()));
            class.insert("skillIds".into(), Value::Array(array(entry.get("skills")).to_vec()));
            if let Some(url) = entry.get("sourceUrl") {
                class.insert("sourceUrl".into(), url.clone());
            }
            Value::Object(class)
        })
        .collect();
    info.insert("classes".into(), Value::Array(classes));
    Value::Object(info)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_matches_its_provenance_manifest() {
        assert_eq!(catalog_provenance_check(), Ok(()));
    }

    #[test]
    fn class_constructor_has_18_skills_and_limits_for_12_classes() {
        let info = class_build_catalog_info();
        assert_eq!(info["rulesProfile"], json!("dndsu-5e-2014-official"));
        assert_eq!(info["provenance"]["engine_ruleset_id"], json!("srd_5_2_1"));
        assert!(text::test(re!(r"^[a-f0-9]{64}$", "u"), info["provenance"]["source_sha256"].as_str().unwrap_or("")));
        assert_eq!(info["skillCount"], json!(18));
        let classes = array(info.get("classes"));
        assert_eq!(classes.len(), 12);
        let count = |key: &str| classes.iter().find(|entry| entry["classKey"] == json!(key)).map(|entry| entry["choiceCount"].clone());
        assert_eq!(count("fighter"), Some(json!(2)));
        assert_eq!(count("rogue"), Some(json!(4)));
        assert!(classes.iter().all(|entry| entry["sourceUrl"].as_str().is_some_and(|url| url.starts_with("https://www.dnd.su/class/"))));
    }

    #[test]
    fn server_accepts_only_the_allowed_number_of_class_skills() {
        let actor = json!({ "characterClass": "fighter", "classSkillProficiencies": ["athletics", "stealth", "perception", "athletics"] });
        assert_eq!(normalized_class_skill_proficiencies(Some(&actor)), ["athletics", "perception"]);
        assert!(is_skill_proficient(Some(&actor), Some(&json!("athletics"))));
        assert!(!is_skill_proficient(Some(&actor), Some(&json!("stealth"))));
    }

    #[test]
    fn class_choices_grow_on_rule_levels() {
        let group = |actor: Value, id: &str| {
            feature_choice_groups_for(Some(&actor)).into_iter().find(|group| group["id"] == json!(id)).map(|group| group["choiceCount"].clone())
        };
        let fighter = |level: i64| json!({ "characterClass": "fighter", "subclass": "Мастер боевых искусств", "level": level });
        assert_eq!(group(fighter(3), "fighter-fighting-style"), Some(json!(1)));
        assert_eq!(group(fighter(3), "fighter-maneuvers"), Some(json!(3)));
        assert_eq!(group(fighter(10), "fighter-maneuvers"), Some(json!(7)));
        assert_eq!(feature_choice_groups_for(Some(&json!({ "characterClass": "sorcerer", "level": 3 })))[0]["choiceCount"], json!(2));
        assert_eq!(feature_choice_groups_for(Some(&json!({ "characterClass": "sorcerer", "level": 10 })))[0]["choiceCount"], json!(3));
    }

    #[test]
    fn selected_features_keep_group_order_and_limits() {
        let fighter = json!({
            "characterClass": "fighter", "subclass": "Мастер боевых искусств", "level": 3,
            "selectedFeatureIds": ["fighting-style-defense", "trip-attack", "parry", "rally"],
        });
        assert_eq!(normalized_selected_feature_ids(Some(&fighter)), ["fighting-style-defense", "trip-attack", "rally", "parry"]);
    }

    #[test]
    fn skill_ids_accept_both_spellings() {
        assert_eq!(catalog_skill_id(Some(&json!("animal-handling"))), "animal_handling");
        assert_eq!(skill_ability(Some(&json!("Sleight-Of-Hand"))), Some(json!("dex")));
        assert_eq!(skill_ability(Some(&json!("unknown"))), None);
        // `маг\b` — граница ASCII-слова, как в JS.
        assert_eq!(character_class_key(Some(&json!({ "role": "маг" }))), None);
        assert_eq!(character_class_key(Some(&json!({ "role": "Волшебник" }))), Some("wizard".into()));
    }
}

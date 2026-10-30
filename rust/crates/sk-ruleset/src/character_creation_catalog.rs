//! Перенос `server/character-creation-catalog.mjs`: каталоги происхождения
//! героя по редакциям (`data/character-creation-policy-v1.json` — 2024,
//! `data/character-creation-dnd-5e-2014.json` — 2014): виды и подвиды, их
//! выборы (языки, навыки, инструменты, заговоры, драконье наследие),
//! преимущества вида и проверка прибавок характеристик от вида.

use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::content::{self, ContentError, ContentResult};
use sk_core::js;

use crate::ruleset_config::{ruleset_profile, ProfileOptions, RulesetSelectionError, DND_2014_RULESET_ID, LEGACY_DEFAULT_RULESET_ID};
use crate::support::{array, checked, defined, embedded_catalog, includes, js_ordered, prop, string_of, unique_values};

/// Пути каталогов происхождения от корня репозитория.
pub const CURRENT_POLICY_FILE: &str = "data/character-creation-policy-v1.json";
pub const CLASSIC_POLICY_FILE: &str = "data/character-creation-dnd-5e-2014.json";
const CURRENT_POLICY_SOURCE: &str = include_str!("../../../../data/character-creation-policy-v1.json");
const CLASSIC_POLICY_SOURCE: &str = include_str!("../../../../data/character-creation-dnd-5e-2014.json");

/// Разбор и проверка каталога происхождения редакции `ruleset_id` из текста:
/// проверка JS при загрузке модуля (`assertPolicy`), редакция, id видов и
/// профилей прибавок (по ним ищет код) и группы выбора вида — id группы
/// уникален, варианты лежат в группе или в `choice_catalogs` и их не меньше
/// `count` (как `pnpm content:verify`; без каталога варианты молча пусты).
pub fn parse_creation_policy(file: &str, text: &str, ruleset_id: &str) -> ContentResult<Value> {
    let policy = embedded_catalog(file, text)?;
    content::root_object(file, &policy)?;
    assert_policy(&policy).map_err(|message| ContentError::new(file, message))?;
    content::root_str(file, &policy, "ruleset_id", ruleset_id)?;
    content::keyed_records(file, &policy, "origin_bonus_profiles", "id")?;
    for (index, (_, species)) in content::keyed_records(file, &policy, "species_options", "id")?.into_iter().enumerate() {
        let label = content::record_label("species_options", index, species);
        let groups = match species.get("choice_groups") {
            None => &[][..],
            Some(Value::Array(groups)) => groups.as_slice(),
            Some(_) => return Err(ContentError::at(file, label, "choice_groups должен быть массивом")),
        };
        for (group_id, group) in content::keyed_items(file, groups, &format!("{label}.choice_groups"), "id")? {
            let options = match group.get("options") {
                Some(Value::Array(options)) => Some(options.len()),
                _ => prop(policy.get("choice_catalogs"), &string_of(group.get("catalog"))).and_then(Value::as_array).map(Vec::len),
            };
            let Some(count) = options else {
                return Err(ContentError::at(file, format!("{label}.{group_id}"), format!("нет вариантов: каталога «{}» нет в choice_catalogs", js::s(group.get("catalog")))));
            };
            let required = match group.get("count") {
                None | Some(Value::Null) => 0.0,
                value => js::number(value),
            };
            if (count as f64) < required {
                return Err(ContentError::at(file, format!("{label}.{group_id}"), format!("вариантов {count} меньше count")));
            }
        }
    }
    Ok(policy)
}

/// Каталоги в порядке `policies` (`Map`): сначала 2024, затем 2014.
static POLICIES: LazyLock<ContentResult<[(&'static str, Value); 2]>> = LazyLock::new(|| {
    Ok([
        (LEGACY_DEFAULT_RULESET_ID, parse_creation_policy(CURRENT_POLICY_FILE, CURRENT_POLICY_SOURCE, LEGACY_DEFAULT_RULESET_ID)?),
        (DND_2014_RULESET_ID, parse_creation_policy(CLASSIC_POLICY_FILE, CLASSIC_POLICY_SOURCE, DND_2014_RULESET_ID)?),
    ])
});

fn policies() -> &'static [(&'static str, Value); 2] {
    checked(&POLICIES)
}

/// Проверка встроенных каталогов происхождения (сервер зовёт её до приёма запросов).
pub fn check_creation_policies() -> ContentResult<()> {
    POLICIES.as_ref().map(|_| ()).map_err(Clone::clone)
}

const ABILITY_IDS: [&str; 6] = ["str", "dex", "con", "int", "wis", "cha"];

// У базового драконорождённого 2014 тип спасброска оружия дыхания зависит от
// наследия: зелёный, белый и серебряный драконы требуют Телосложение, остальные
// — Ловкость. Это отдельное свойство ancestry, а не общий дефолт области.
const DRAGON_ANCESTRY_SAVE_ABILITIES: [(&str, &str); 10] = [
    ("black", "dex"),
    ("blue", "dex"),
    ("brass", "dex"),
    ("bronze", "dex"),
    ("copper", "dex"),
    ("gold", "dex"),
    ("green", "con"),
    ("red", "dex"),
    ("silver", "con"),
    ("white", "con"),
];

/// Каталог создания героя для редакции; `ruleset_id` — уже приведённое
/// `String(rulesetId ?? '')`, пустое — редакция 2024 по умолчанию.
fn policy_for(ruleset_id: &str) -> Result<&'static Value, RulesetSelectionError> {
    let profile = ruleset_profile(ruleset_id, ProfileOptions::fallback(LEGACY_DEFAULT_RULESET_ID))?;
    // Нет каталога у установленной редакции — `TypeError` в JS; обе
    // установленные редакции свой каталог имеют.
    policies().iter().find(|(id, _)| *id == profile.id).map(|(_, policy)| policy).ok_or_else(|| {
        RulesetSelectionError::new(format!("Нет каталога создания героя для {}", profile.id), "RULESET_INVALID")
    })
}

fn object_of(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    }
}

fn public_choice_group(policy: &Value, group: &Value) -> Value {
    let options = match group.get("options") {
        Some(Value::Array(options)) => options.clone(),
        // `policy.choice_catalogs?.[group.catalog]`: ключ — `String(group.catalog)`.
        _ => match prop(prop(Some(policy), "choice_catalogs"), &string_of(group.get("catalog"))) {
            Some(Value::Array(options)) => options.clone(),
            _ => Vec::new(),
        },
    };
    let mut result = object_of(group);
    result.insert("options".into(), Value::Array(options));
    Value::Object(result)
}

fn public_species_option(policy: &Value, option: &Value) -> Value {
    let mut result = object_of(option);
    let groups = array(option.get("choice_groups")).iter().map(|group| public_choice_group(policy, group)).collect();
    result.insert("choice_groups".into(), Value::Array(groups));
    Value::Object(result)
}

fn public_policy(policy: &Value) -> Value {
    let mut result = object_of(policy);
    let options = array(policy.get("species_options")).iter().map(|option| public_species_option(policy, option)).collect();
    result.insert("species_options".into(), Value::Array(options));
    Value::Object(result)
}

/// Проверка формы каталога, которую JS делает при загрузке модуля
/// (`assertPolicy`); здесь — в [`parse_creation_policy`], то есть при старте
/// сервера.
fn assert_policy(policy: &Value) -> Result<(), String> {
    let ruleset = string_of(policy.get("ruleset_id"));
    let valid = policy.get("schema_version") == Some(&json!(1))
        && policy.get("method").and_then(Value::as_str) == Some("standard_array")
        && policy.get("standard_array").and_then(Value::as_array).is_some_and(|values| values.len() == 6)
        && policy.get("origin_bonus_profiles").is_some_and(Value::is_array)
        && policy.get("species_options").is_some_and(Value::is_array);
    if !valid {
        return Err(format!("Некорректный каталог создания героя {ruleset}"));
    }
    let species_ids: Vec<String> = array(policy.get("species_options")).iter().map(|entry| string_of(entry.get("id"))).collect();
    let profile_ids: Vec<String> = array(policy.get("origin_bonus_profiles")).iter().map(|entry| string_of(entry.get("id"))).collect();
    if crate::support::unique_strings(species_ids.iter().cloned()).len() != species_ids.len() {
        return Err(format!("Повтор species id в {ruleset}"));
    }
    if policy.get("bonus_source").and_then(Value::as_str) == Some("species") {
        for species in array(policy.get("species_options")) {
            if !profile_ids.contains(&string_of(species.get("bonus_profile_id"))) {
                return Err(format!("Вид {} ссылается на неизвестный bonus profile", string_of(species.get("id"))));
            }
        }
    }
    Ok(())
}

/// `characterCreationPolicyFor(rulesetId)`: публичный каталог происхождения
/// редакции с раскрытыми вариантами выборов.
pub fn character_creation_policy_for(ruleset_id: &str) -> Result<Value, RulesetSelectionError> {
    Ok(public_policy(policy_for(ruleset_id)?))
}

fn find_species<'a>(policy: &'a Value, species_option_id: &str) -> Option<&'a Value> {
    array(policy.get("species_options")).iter().find(|entry| string_of(entry.get("id")) == species_option_id)
}

/// `speciesOptionFor(speciesOptionId, rulesetId)`: вид с раскрытыми выборами
/// или `None`. `species_option_id` — уже приведённое `String(x ?? '')`.
pub fn species_option_for(species_option_id: &str, ruleset_id: &str) -> Result<Option<Value>, RulesetSelectionError> {
    let policy = policy_for(ruleset_id)?;
    Ok(find_species(policy, species_option_id).map(|option| public_species_option(policy, option)))
}

/// `originBonusProfileFor(profileId, rulesetId)`: профиль прибавок вида или
/// `None`.
pub fn origin_bonus_profile_for(profile_id: &str, ruleset_id: &str) -> Result<Option<Value>, RulesetSelectionError> {
    let policy = policy_for(ruleset_id)?;
    Ok(array(policy.get("origin_bonus_profiles")).iter().find(|entry| string_of(entry.get("id")) == profile_id).cloned())
}

/// `defaultSpeciesChoices(speciesOptionId, rulesetId)`: первые варианты каждой
/// группы выбора вида.
pub fn default_species_choices(species_option_id: &str, ruleset_id: &str) -> Result<Option<Value>, RulesetSelectionError> {
    let Some(option) = species_option_for(species_option_id, ruleset_id)? else {
        return Ok(None);
    };
    let choices: Map<String, Value> = array(option.get("choice_groups"))
        .iter()
        .map(|group| {
            let options = array(group.get("options"));
            let count = js::number(Some(defined(group.get("count")).unwrap_or(&json!(0))));
            let keep = crate::support::slice_len(options.len(), count);
            let ids = options.iter().take(keep).map(|entry| entry.get("id").cloned().unwrap_or(Value::Null)).collect();
            (string_of(group.get("id")), Value::Array(ids))
        })
        .collect();
    Ok(Some(Value::Object(js_ordered(choices))))
}

/// `resolveSpeciesChoices(speciesOptionId, choices = {}, rulesetId)`:
/// проверка выборов вида. `choices` `None` — не передан (`{}`).
pub fn resolve_species_choices(species_option_id: &str, choices: Option<&Value>, ruleset_id: &str) -> Result<Value, RulesetSelectionError> {
    let Some(option) = species_option_for(species_option_id, ruleset_id)? else {
        return Ok(json!({ "ok": false, "reason": "Выбран неподдерживаемый вид персонажа" }));
    };
    let empty = Value::Object(Map::new());
    let Some(Value::Object(choices)) = Some(choices.unwrap_or(&empty)) else {
        return Ok(json!({ "ok": false, "reason": "speciesChoices должен быть объектом" }));
    };
    let groups = array(option.get("choice_groups"));
    let allowed: Vec<String> = groups.iter().map(|group| string_of(group.get("id"))).collect();
    for key in js::keys(choices) {
        if !allowed.contains(key) {
            return Ok(json!({ "ok": false, "reason": format!("Выбор {key} не принадлежит этому виду") }));
        }
    }
    let mut resolved = Map::new();
    let mut selected_options: Vec<Value> = Vec::new();
    for group in groups {
        let group_id = string_of(group.get("id"));
        let label = string_of(group.get("label"));
        let selected: Vec<String> = array(choices.get(&group_id)).iter().map(|entry| string_of(Some(entry))).collect();
        // `Math.max(0, Number(group.count ?? 0))`: `NaN` заразен.
        let count = js::number(Some(defined(group.get("count")).unwrap_or(&json!(0))));
        let expected = if count.is_nan() { f64::NAN } else { count.max(0.0) };
        if selected.len() as f64 != expected || crate::support::unique_strings(selected.iter().cloned()).len() != selected.len() {
            return Ok(json!({ "ok": false, "reason": format!("{label}: нужно выбрать {}", js::f64_string(expected)) }));
        }
        let options = array(group.get("options"));
        // `new Map(options.map(e => [String(e.id), e]))`: при повторе id — последний.
        let by_id = |id: &str| options.iter().rev().find(|entry| string_of(entry.get("id")) == id);
        if selected.iter().any(|id| by_id(id).is_none()) {
            return Ok(json!({ "ok": false, "reason": format!("{label}: неизвестный вариант") }));
        }
        let known_languages = array(option.get("languages"));
        if group.get("kind").and_then(Value::as_str) == Some("language")
            && selected.iter().any(|id| includes(known_languages, &Value::String(id.clone())))
        {
            return Ok(json!({ "ok": false, "reason": format!("{label}: этот язык уже известен персонажу") }));
        }
        resolved.insert(group_id.clone(), json!(selected));
        for id in &selected {
            // `{ group_id, kind, ...entry }`: поле записи перекрывает `kind` на его месте.
            let mut entry = Map::new();
            entry.insert("group_id".into(), group.get("id").cloned().unwrap_or(Value::Null));
            entry.insert("kind".into(), group.get("kind").cloned().unwrap_or(Value::Null));
            if let Some(Value::Object(fields)) = by_id(id) {
                for (key, value) in fields {
                    entry.insert(key.clone(), value.clone());
                }
            }
            if group.get("kind").is_none() && by_id(id).and_then(|fields| fields.get("kind")).is_none() {
                entry.shift_remove("kind");
            }
            if group.get("id").is_none() && by_id(id).and_then(|fields| fields.get("group_id")).is_none() {
                entry.shift_remove("group_id");
            }
            selected_options.push(Value::Object(entry));
        }
    }
    Ok(json!({ "ok": true, "choices": js_ordered(resolved), "selected_options": selected_options }))
}

/// `speciesBenefitsFor(speciesOptionId, rulesetId, choices)`: преимущества
/// вида с учётом выборов (по умолчанию — первые варианты). `None`, если вида
/// нет или выбор неверен.
pub fn species_benefits_for(species_option_id: &str, ruleset_id: &str, choices: Option<&Value>) -> Result<Option<Value>, RulesetSelectionError> {
    let Some(option) = species_option_for(species_option_id, ruleset_id)? else {
        return Ok(None);
    };
    let profile = match option.get("bonus_profile_id").filter(|id| js::truthy(Some(id))) {
        Some(id) => origin_bonus_profile_for(&js::s(Some(id)), ruleset_id)?,
        None => None,
    };
    let defaults = match defined(choices) {
        Some(_) => None,
        None => default_species_choices(species_option_id, ruleset_id)?,
    };
    let empty = Value::Object(Map::new());
    let effective = defined(choices).or(defaults.as_ref()).unwrap_or(&empty);
    let resolved = resolve_species_choices(species_option_id, Some(effective), ruleset_id)?;
    if !js::is_true(resolved.get("ok")) {
        return Ok(None);
    }
    let selected = array(resolved.get("selected_options"));
    let ids_of_kind = |kind: &str| -> Vec<Value> {
        selected
            .iter()
            .filter(|entry| entry.get("kind").and_then(Value::as_str) == Some(kind))
            .map(|entry| entry.get("id").cloned().unwrap_or(Value::Null))
            .collect()
    };
    let selected_languages = ids_of_kind("language");
    let selected_skills = ids_of_kind("skill");
    let selected_tools = ids_of_kind("tool");
    let selected_cantrips: Vec<Value> = ids_of_kind("cantrip")
        .into_iter()
        .map(|id| json!({ "id": id, "minimum_level": 1, "ability": "int", "uses": "at-will", "source": "species-choice" }))
        .collect();
    let ancestry = selected.iter().find(|entry| entry.get("kind").and_then(Value::as_str) == Some("ancestry"));
    let mut mechanics = defined(option.get("mechanics")).map(object_of).unwrap_or_default();
    if let Some(ancestry) = ancestry {
        let resistances = unique_values(
            crate::support::spread_items(defined(mechanics.get("damage_resistances")))
                .into_iter()
                .chain([ancestry.get("damage_type").cloned().unwrap_or(Value::Null)]),
        );
        mechanics.insert("damage_resistances".into(), Value::Array(resistances));
        let mut dragon = Map::new();
        for key in ["id", "label", "damage_type", "shape"] {
            if let Some(value) = ancestry.get(key) {
                dragon.insert(key.into(), value.clone());
            }
        }
        dragon.insert("distance_feet".into(), js::num(js::number(ancestry.get("distance_feet"))));
        let save = DRAGON_ANCESTRY_SAVE_ABILITIES.iter().find(|(id, _)| *id == string_of(ancestry.get("id"))).map_or("dex", |(_, ability)| ability);
        dragon.insert("save_ability".into(), json!(save));
        mechanics.insert("dragon_ancestry".into(), Value::Object(dragon));
    }
    let innate_spells: Vec<Value> = crate::support::spread_items(defined(mechanics.get("innate_spells"))).into_iter().chain(selected_cantrips).collect();
    let union = |base: Option<&Value>, extra: Vec<Value>| Value::Array(unique_values(crate::support::spread_items(defined(base)).into_iter().chain(extra)));
    let policy = policy_for(ruleset_id)?;
    let traits_status = if mechanics.is_empty() { "ruling-only" } else { "partial" };
    let mut benefits = Map::new();
    benefits.insert("ruleset_id".into(), json!(string_of(policy.get("ruleset_id"))));
    if let Some(id) = option.get("id") {
        benefits.insert("species_option_id".into(), id.clone());
    }
    if let Some(race) = defined(option.get("race_id")).or(option.get("id")) {
        benefits.insert("race_id".into(), race.clone());
    }
    benefits.insert("subrace_id".into(), defined(option.get("subrace_id")).cloned().unwrap_or(Value::Null));
    benefits.insert("size".into(), defined(option.get("size")).cloned().unwrap_or(Value::Null));
    benefits.insert("base_speed".into(), js::num(js::number(option.get("base_speed"))));
    benefits.insert("choices".into(), resolved.get("choices").cloned().unwrap_or(Value::Null));
    benefits.insert("languages".into(), union(option.get("languages"), selected_languages));
    benefits.insert("skill_proficiencies".into(), union(mechanics.get("skill_proficiencies"), selected_skills));
    benefits.insert("tool_proficiencies".into(), union(mechanics.get("tool_proficiencies"), selected_tools));
    benefits.insert("innate_spells".into(), Value::Array(innate_spells));
    benefits.insert("mechanics".into(), Value::Object(mechanics));
    benefits.insert("ability_bonus_profile_id".into(), profile.as_ref().and_then(|profile| defined(profile.get("id"))).cloned().unwrap_or(Value::Null));
    benefits.insert("trait_summaries".into(), Value::Array(crate::support::spread_items(defined(option.get("trait_summaries")))));
    benefits.insert("traits_supported".into(), json!(false));
    benefits.insert("traits_mechanics_status".into(), json!(traits_status));
    benefits.insert("source_url".into(), defined(option.get("source_url")).cloned().unwrap_or(Value::Null));
    Ok(Some(Value::Object(benefits)))
}

/// `validateSpeciesOriginBonuses(speciesOptionId, profileId, originBonuses,
/// rulesetId)`: прибавки характеристик соответствуют виду (только для
/// редакций, где их даёт вид). `profile_id` — значение как пришло.
pub fn validate_species_origin_bonuses(
    species_option_id: &str,
    profile_id: Option<&Value>,
    origin_bonuses: Option<&Value>,
    ruleset_id: &str,
) -> Result<Value, RulesetSelectionError> {
    let policy = policy_for(ruleset_id)?;
    if policy.get("bonus_source").and_then(Value::as_str) != Some("species") {
        return Ok(json!({ "ok": true, "selectedAbilities": [] }));
    }
    let Some(option) = find_species(policy, species_option_id) else {
        return Ok(json!({ "ok": false, "reason": "Выбран неподдерживаемый вид персонажа" }));
    };
    let wanted_profile = js::s(profile_id);
    if string_of(option.get("bonus_profile_id")) != wanted_profile {
        return Ok(json!({ "ok": false, "reason": "Профиль прибавок не принадлежит выбранному виду" }));
    }
    let Some(profile) = array(policy.get("origin_bonus_profiles")).iter().find(|entry| string_of(entry.get("id")) == wanted_profile) else {
        return Ok(json!({ "ok": false, "reason": "Неизвестный профиль прибавок вида" }));
    };
    let fixed = defined(profile.get("fixed_bonuses"));
    let excluded: Vec<String> = array(profile.get("excluded_choices")).iter().map(|entry| string_of(Some(entry))).collect();
    let number_or_zero = |value: Option<&Value>| js::number(Some(defined(value).unwrap_or(&json!(0))));
    let choice_amount = number_or_zero(profile.get("choice_amount"));
    let mut selected: Vec<&str> = Vec::new();
    for ability in ABILITY_IDS {
        let actual = number_or_zero(prop(origin_bonuses, ability));
        let base = number_or_zero(prop(fixed, ability));
        if actual == base {
            continue;
        }
        if choice_amount > 0.0 && actual == base + choice_amount && !excluded.iter().any(|entry| entry == ability) {
            selected.push(ability);
            continue;
        }
        return Ok(json!({ "ok": false, "reason": "Прибавки не соответствуют выбранной расе или подрасе" }));
    }
    let choice_count = number_or_zero(profile.get("choice_count"));
    if selected.len() as f64 != choice_count {
        return Ok(json!({
            "ok": false,
            "reason": format!("Нужно выбрать {} дополнительные характеристики вида", js::f64_string(choice_count)),
        }));
    }
    Ok(json!({ "ok": true, "selectedAbilities": selected }))
}

/// `characterCreationOriginCatalogInfo()`: сводка каталогов по редакциям.
pub fn character_creation_origin_catalog_info() -> Value {
    Value::Object(
        policies()
            .iter()
            .map(|(ruleset_id, policy)| {
                let mut info = Map::new();
                info.insert("ruleset_id".into(), json!(ruleset_id));
                info.insert("species_options".into(), json!(array(policy.get("species_options")).len()));
                info.insert("bonus_profiles".into(), json!(array(policy.get("origin_bonus_profiles")).len()));
                if let Some(source) = policy.get("bonus_source") {
                    info.insert("bonus_source".into(), source.clone());
                }
                (ruleset_id.to_string(), Value::Object(info))
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const RULESET_ID: &str = "dnd_5e_2014";

    /// Урок 7: опечатка в ключевом поле копии каталога — отказ, который
    /// называет файл и запись; группа выбора без каталога вариантов — тоже.
    #[test]
    fn broken_copy_names_file_and_species() {
        assert_eq!(check_creation_policies(), Ok(()));
        let mut raw: Value = serde_json::from_str(CLASSIC_POLICY_SOURCE).expect("каталог");
        let species = raw["species_options"][3].as_object_mut().expect("вид");
        let id = species.shift_remove("id").expect("id");
        species.insert("iid".into(), id);
        let error = parse_creation_policy(CLASSIC_POLICY_FILE, &raw.to_string(), RULESET_ID).err().map(|error| error.to_string());
        assert_eq!(error.as_deref(), Some("data/character-creation-dnd-5e-2014.json: species_options[3] «Лесной эльф»: нет поля «id»"));
        let mut raw: Value = serde_json::from_str(CLASSIC_POLICY_SOURCE).expect("каталог");
        raw["choice_catalogs"].as_object_mut().expect("каталоги").shift_remove("dwarf_tools");
        let error = parse_creation_policy(CLASSIC_POLICY_FILE, &raw.to_string(), RULESET_ID).err().map(|error| error.to_string());
        assert_eq!(error.as_deref(), Some("data/character-creation-dnd-5e-2014.json: species_options[0] «dwarf-hill».artisan-tool: нет вариантов: каталога «dwarf_tools» нет в choice_catalogs"));
        let mut raw: Value = serde_json::from_str(CURRENT_POLICY_SOURCE).expect("каталог");
        raw["origin_bonus_profiles"][1]["id"] = json!("");
        let error = parse_creation_policy(CURRENT_POLICY_FILE, &raw.to_string(), LEGACY_DEFAULT_RULESET_ID).err().map(|error| error.to_string());
        assert_eq!(error.as_deref(), Some("data/character-creation-policy-v1.json: origin_bonus_profiles[1] «Предыстория: +2 и +1»: поле «id» должно быть непустой строкой"));
    }

    #[test]
    fn embedded_policies_pass_the_load_time_check() {
        for (_, policy) in policies().iter() {
            assert_eq!(assert_policy(policy), Ok(()));
        }
    }

    #[test]
    fn all_elves_have_perception_and_drow_get_no_free_language() {
        for id in ["elf-high", "elf-wood", "elf-drow"] {
            let choices = default_species_choices(id, RULESET_ID).ok().flatten();
            let benefits = species_benefits_for(id, RULESET_ID, choices.as_ref()).ok().flatten().unwrap_or(Value::Null);
            assert!(array(benefits.get("skill_proficiencies")).contains(&json!("perception")), "{id}");
        }
        let drow = species_benefits_for("elf-drow", RULESET_ID, Some(&json!({}))).ok().flatten().unwrap_or(Value::Null);
        assert_eq!(drow["languages"], json!(["common", "elvish"]));
    }

    #[test]
    fn half_elf_choices_become_proficiencies() {
        let choices = json!({ "extra-language": ["giant"], "versatility-skills": ["perception", "stealth"] });
        let half_elf = resolve_species_choices("half-elf", Some(&choices), RULESET_ID).unwrap_or(Value::Null);
        assert_eq!(half_elf["ok"], json!(true));
        let benefits = species_benefits_for("half-elf", RULESET_ID, half_elf.get("choices")).ok().flatten().unwrap_or(Value::Null);
        assert!(array(benefits.get("languages")).contains(&json!("giant")));
        assert_eq!(benefits["skill_proficiencies"], json!(["perception", "stealth"]));
        let repeated = json!({ "extra-language": ["elvish"], "versatility-skills": ["perception", "perception"] });
        assert_eq!(resolve_species_choices("half-elf", Some(&repeated), RULESET_ID).unwrap_or(Value::Null)["ok"], json!(false));
    }

    #[test]
    fn unknown_ruleset_is_refused() {
        assert_eq!(character_creation_policy_for("invented").map_err(|error| error.code), Err("RULESET_INVALID".into()));
        assert!(character_creation_policy_for("").is_ok());
    }
}

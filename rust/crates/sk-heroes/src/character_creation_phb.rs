//! Перенос `server/character-creation-phb.mjs`: единственный переход от
//! выборов мастера создания героя PHB 2014 (класс, подкласс, боевой стиль,
//! черта вариантного человека, вид, предыстория, замены повторов) к
//! преимуществам листа героя первого уровня, а также каталог мастера —
//! классы, черты, инструменты, языки и заклинания 0–1 круга PHB.
//!
//! Проверки нижнего слоя не повторяются здесь, а вызываются из готовых
//! крейтов: `sk_ruleset` (классы, черты, виды, предыстории) и
//! `sk_combat_content` (карточки заклинаний).

use std::fmt;

use serde_json::{json, Map, Value};
use sk_combat_content::combat_spells::canonical_combat_spell_for;
use sk_core::js;
use sk_ruleset::backgrounds::{background_benefits, background_by_id, background_catalog_for, phb_tool_options, BackgroundError};
use sk_ruleset::character_creation_catalog::{default_species_choices, species_benefits_for};
use sk_ruleset::character_creation_class_options::{class_option_for, class_options_catalog, validate_class_choices, PHB_2014_TOOL_IDS};
use sk_ruleset::character_creation_feats::{class_spell_list, resolve_character_creation_feat, PHB_2014_FEATS, PHB_CANTRIPS, PHB_FIRST_LEVEL_SPELLS};
use sk_ruleset::ruleset_config::{RulesetSelectionError, DND_2014_RULESET_ID};

use crate::support::{array, defined, includes, insert_present, prop, same_value_zero, unique_values};

const ABILITIES: [&str; 6] = ["str", "dex", "con", "int", "wis", "cha"];
const CASTERS: [&str; 6] = ["bard", "cleric", "druid", "sorcerer", "warlock", "wizard"];

/// `PHB_FIGHTING_STYLES`: особенность «боевой стиль» мастера создания →
/// боевой стиль класса воина PHB 2014 (в порядке объекта JS).
pub const PHB_FIGHTING_STYLES: [(&str, &str); 6] = [
    ("fighting-style-defense", "defense"),
    ("fighting-style-dueling", "dueling"),
    ("fighting-style-great-weapon", "great_weapon_fighting"),
    ("fighting-style-protection", "protection"),
    ("fighting-style-two-weapon", "two_weapon_fighting"),
    ("fighting-style-archery", "archery"),
];

/// `PHB_FIGHTING_STYLES` как объект JS.
pub fn phb_fighting_styles_json() -> Value {
    Value::Object(PHB_FIGHTING_STYLES.iter().map(|(feature, style)| ((*feature).to_string(), json!(style))).collect())
}

/// `PHB_FIGHTING_STYLES[featureId]` по собственным ключам объекта.
pub fn phb_fighting_style(feature_id: &str) -> Option<&'static str> {
    PHB_FIGHTING_STYLES.iter().find(|(feature, _)| *feature == feature_id).map(|(_, style)| *style)
}

const SPELL_ID_EXCEPTIONS: [(&str, &str); 2] =
    [("tashas_hideous_laughter", "tasha-s-hideous-laughter"), ("tensers_floating_disk", "tenser-s-floating-disk")];

const TOOL_ID_EXCEPTIONS: [(&str, &str); 5] = [
    ("dragonchess_set", "dragonchess"),
    ("three_dragon_ante_set", "three_dragon_ante"),
    ("playing_card_set", "playing_cards"),
    ("land_vehicles", "vehicles_land"),
    ("water_vehicles", "vehicles_water"),
];

fn exception(table: &[(&str, &'static str)], key: &str) -> Option<&'static str> {
    table.iter().find(|(from, _)| *from == key).map(|(_, to)| *to)
}

/// `phbSpellId(id)`: id заклинания классовых таблиц (`cure_wounds`) → id
/// каталога заклинаний (`cure-wounds`). Ключ — `String(id)`, исключения — по
/// собственному ключу таблицы.
pub fn phb_spell_id(id: Option<&Value>) -> String {
    let key = js::string(id);
    exception(&SPELL_ID_EXCEPTIONS, &key).map_or_else(|| key.replace('_', "-"), str::to_string)
}

/// `phbToolId(id)`: id инструмента классов и черт (`land_vehicles`,
/// `thieves-tools`) → id каталога инструментов PHB (`vehicles_land`,
/// `thieves_tools`). Ключ — `String(id)`, исключения — по собственному ключу.
pub fn phb_tool_id(id: Option<&Value>) -> String {
    let key = js::string(id);
    exception(&TOOL_ID_EXCEPTIONS, &key).map_or_else(|| key.replace('-', "_"), str::to_string)
}

/// `phbToolId(id)` как значение JS: на ключе `Object.prototype` — не строка
/// каталога, а свойство прототипа.
fn tool_id_value(id: &Value) -> Value {
    Value::String(phb_tool_id(Some(id)))
}

/// `languageId(id)`: `String(id).replaceAll('_', '-')`.
fn language_id(id: &Value) -> String {
    js::string(Some(id)).replace('_', "-")
}

/// Отказ сборки героя PHB — `TypeError` JS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PhbCreationError {
    /// `TypeError`, который бросает модуль или модуль ниже (предыстории):
    /// текст для игрока, вызывающий кладёт его в `IMPORT_PHB_CHOICES_INVALID`.
    Invalid(String),
    /// `TypeError` рантайма JS на мусоре во входе (обращение к полю `null`,
    /// распаковка неитерируемого, `.map` у не-массива). Текст V8 не
    /// повторяется дословно.
    Runtime(String),
}

impl PhbCreationError {
    pub fn message(&self) -> &str {
        match self {
            Self::Invalid(message) | Self::Runtime(message) => message,
        }
    }
}

impl fmt::Display for PhbCreationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for PhbCreationError {}

impl From<BackgroundError> for PhbCreationError {
    fn from(error: BackgroundError) -> Self {
        match error {
            BackgroundError::Runtime(message) => Self::Runtime(message),
            BackgroundError::Type(message) => Self::Invalid(message),
            BackgroundError::Ruleset(error) => Self::Invalid(error.message),
        }
    }
}

/// Редакция здесь всегда `dnd_5e_2014`, и отказа выбора редакции не бывает;
/// если он всё же придёт — его текст.
impl From<RulesetSelectionError> for PhbCreationError {
    fn from(error: RulesetSelectionError) -> Self {
        Self::Invalid(error.message)
    }
}

fn fail<T>(reason: impl Into<String>) -> Result<T, PhbCreationError> {
    Err(PhbCreationError::Invalid(reason.into()))
}

/// `[...value]`: массив — его элементы, строка — её символы; прочее у JS —
/// `TypeError` «… is not iterable».
fn spread(value: Option<&Value>, expression: &str) -> Result<Vec<Value>, PhbCreationError> {
    match value {
        Some(Value::Array(items)) => Ok(items.clone()),
        Some(Value::String(text)) => Ok(text.chars().map(|ch| Value::String(ch.to_string())).collect()),
        _ => Err(PhbCreationError::Runtime(format!("{expression} is not iterable"))),
    }
}

/// `[...(value ?? [])]`.
fn spread_nullish(value: Option<&Value>, expression: &str) -> Result<Vec<Value>, PhbCreationError> {
    match defined(value) {
        None => Ok(Vec::new()),
        some => spread(some, expression),
    }
}

/// `(value ?? []).map(...)`: метод есть только у массива.
fn map_nullish<'a>(value: Option<&'a Value>, expression: &str) -> Result<&'a [Value], PhbCreationError> {
    match defined(value) {
        None => Ok(&[]),
        Some(Value::Array(items)) => Ok(items),
        Some(_) => Err(PhbCreationError::Runtime(format!("{expression}.map is not a function"))),
    }
}

/// Число JS в JSON-контексте черты: `NaN` и бесконечность JSON не выражает,
/// поэтому они передаются строкой — `Number("NaN")` даёт тот же `NaN`, и
/// проверка черты отвечает так же.
fn number_value(number: f64) -> Value {
    if number.is_finite() {
        js::num(number)
    } else {
        Value::String(js::f64_string(number))
    }
}

/// `phbFirstLevelSpells()`: заговоры и заклинания 1 круга PHB из классовых
/// таблиц — карточки локального каталога с полем `classes`.
pub fn phb_first_level_spells() -> Result<Vec<Value>, PhbCreationError> {
    let mut ids: Vec<&'static str> = Vec::new();
    for (_, list) in PHB_CANTRIPS.iter().chain(PHB_FIRST_LEVEL_SPELLS.iter()) {
        for id in list.iter() {
            if !ids.contains(id) {
                ids.push(id);
            }
        }
    }
    ids.into_iter()
        .map(|id| {
            let Some(spell) = canonical_combat_spell_for(Some(&json!(id)), None) else {
                return fail(format!("В локальном каталоге отсутствует заклинание PHB: {id}"));
            };
            let cantrip = spell.get("level").and_then(Value::as_f64) == Some(0.0);
            let table = if cantrip { &PHB_CANTRIPS } else { &PHB_FIRST_LEVEL_SPELLS };
            let classes: Vec<&str> = PHB_CANTRIPS
                .iter()
                .map(|(class_id, _)| *class_id)
                .filter(|class_id| class_spell_list(table, class_id).is_some_and(|list| list.contains(&id)))
                .collect();
            let mut entry = match spell {
                Value::Object(map) => map,
                _ => Map::new(),
            };
            entry.insert("classes".into(), json!(classes));
            Ok(Value::Object(entry))
        })
        .collect()
}

fn id_label(entry: &Value) -> Value {
    let mut result = Map::new();
    insert_present(&mut result, "id", entry.get("id"));
    insert_present(&mut result, "label", entry.get("name"));
    Value::Object(result)
}

/// `phbCreationCatalog()`: каталог мастера создания PHB 2014.
pub fn phb_creation_catalog() -> Result<Value, PhbCreationError> {
    let tools: Vec<Value> = array(Some(&phb_tool_options())).iter().map(id_label).collect();
    let background_catalog = background_catalog_for(DND_2014_RULESET_ID)?;
    let languages: Vec<Value> = array(background_catalog.get("language_options")).iter().map(id_label).collect();
    let spells: Vec<Value> = phb_first_level_spells()?
        .iter()
        .map(|spell| {
            let mut entry = Map::new();
            for (to, from) in [
                ("id", "id"),
                ("name", "name"),
                ("classes", "classes"),
                ("level", "level"),
                ("ritual", "ritual"),
                ("description", "description"),
                ("casting_time", "castingTime"),
                ("range_text", "rangeText"),
                ("mechanics_support", "mechanicsSupport"),
            ] {
                insert_present(&mut entry, to, spell.get(from));
            }
            Value::Object(entry)
        })
        .collect();
    let mut catalog = Map::new();
    catalog.insert("schema_version".into(), json!(1));
    catalog.insert("classes".into(), class_options_catalog());
    catalog.insert("feats".into(), Value::Array(PHB_2014_FEATS.clone()));
    catalog.insert("tools".into(), Value::Array(tools));
    catalog.insert("languages".into(), Value::Array(languages));
    catalog.insert("spells".into(), Value::Array(spells));
    Ok(Value::Object(catalog))
}

const RAW_KEYS: [&str; 7] = ["schema_version", "classChoices", "feat", "backgroundEquipmentChoices", "equipmentMode", "wealthRollId", "purchases"];

/// `{ ...value }` в объектном литерале: собственные перечислимые поля объекта
/// (индексы раньше прочих), элементы массива и символы строки под ключами-
/// индексами; у числа и булева значения полей нет.
fn object_spread_into(target: &mut Map<String, Value>, value: Option<&Value>) {
    match value {
        Some(Value::Object(map)) => {
            for (key, entry) in js::entries(map) {
                target.insert(key.clone(), entry.clone());
            }
        }
        Some(Value::Array(items)) => {
            for (index, entry) in items.iter().enumerate() {
                target.insert(index.to_string(), entry.clone());
            }
        }
        Some(Value::String(text)) => {
            for (index, ch) in text.chars().enumerate() {
                target.insert(index.to_string(), Value::String(ch.to_string()));
            }
        }
        _ => {}
    }
}

/// `PHB_FIGHTING_STYLES[selected[0]]` при `selected.length === 1`: значение
/// по собственному ключу `String(selected[0])` или `None`, если стиль не выбран.
fn selected_fighting_style(selected: Option<&Value>) -> Option<Value> {
    let (length_is_one, first) = match defined(selected) {
        // `?? []`: пустой список.
        None => (false, None),
        Some(Value::Array(items)) => (items.len() == 1, items.first().cloned()),
        Some(Value::String(text)) => (text.encode_utf16().count() == 1, Some(Value::String(text.clone()))),
        Some(Value::Object(map)) => (map.get("length").and_then(Value::as_f64) == Some(1.0), map.get("0").cloned()),
        Some(_) => (false, None),
    };
    if !length_is_one {
        return None;
    }
    let key = js::string(first.as_ref());
    phb_fighting_style(&key).map(|style| json!(style))
}

/// `resolvePhbCreation(source)`: проверенные выборы PHB 2014 и преимущества
/// листа героя первого уровня; `None`, если в документе нет `phbCreation`.
///
/// Отказ — [`PhbCreationError`] с текстом JS. Порядок проверок и вычислений —
/// как в JS, поэтому на мусоре первым срабатывает тот же отказ.
pub fn resolve_phb_creation(source: Option<&Value>) -> Result<Option<Value>, PhbCreationError> {
    let Some(source) = defined(source) else {
        let kind = if source.is_none() { "undefined" } else { "null" };
        return Err(PhbCreationError::Runtime(format!("Cannot read properties of {kind} (reading 'phbCreation')")));
    };
    let field = |key: &str| prop(Some(source), key);
    let Some(raw) = defined(field("phbCreation")) else {
        return Ok(None);
    };
    let Value::Object(raw_map) = raw else {
        return fail("Неизвестный формат создания PHB 2014");
    };
    if raw_map.get("schema_version").and_then(Value::as_f64) != Some(1.0) {
        return fail("Неизвестный формат создания PHB 2014");
    }
    if raw_map.keys().any(|key| !RAW_KEYS.contains(&key.as_str())) {
        return fail("Неизвестное поле создания PHB 2014");
    }
    let equipment_mode = raw_map.get("equipmentMode");
    if js::truthy(equipment_mode) && !matches!(equipment_mode.and_then(Value::as_str), Some("standard" | "wealth")) {
        return fail("Неизвестный способ стартового снаряжения");
    }
    if js::number(field("level")) != 1.0 {
        return fail("Мастер PHB создаёт героя первого уровня; развитие выполняется после создания");
    }
    let character_class = field("characterClass");
    let class_is = |id: &str| character_class.and_then(Value::as_str) == Some(id);
    let Some(definition) = class_option_for(character_class) else {
        return fail("Неизвестный класс PHB");
    };

    let generation = field("abilityGeneration");
    let species_id_value = prop(generation, "speciesOptionId");
    let species_id = js::s(species_id_value);
    let default_choices = match defined(field("speciesChoices")) {
        Some(_) => None,
        None => default_species_choices(&species_id, DND_2014_RULESET_ID)?,
    };
    let species_choices = defined(field("speciesChoices")).or(default_choices.as_ref());
    let Some(species) = species_benefits_for(&species_id, DND_2014_RULESET_ID, species_choices)? else {
        return fail("Нужно завершить выбор расы");
    };

    let background_id = js::s(field("backgroundId"));
    let background_choices = field("backgroundChoices");
    let Some(background) = background_by_id(&background_id, DND_2014_RULESET_ID, prop(background_choices, "customization"))? else {
        return fail("Нужно выбрать предысторию");
    };
    let Some(background_grants) = background_benefits(&background_id, None, background_choices, DND_2014_RULESET_ID)? else {
        return fail("Нужно завершить выборы предыстории");
    };

    let subclass_value = field("subclass");
    let mut subclass: Option<&Value> = None;
    for entry in array(definition.get("subclass_options")) {
        let mut candidates = vec![entry.get("id").cloned(), entry.get("label").cloned()];
        candidates.extend(spread_nullish(entry.get("aliases"), "(entry.aliases ?? [])")?.into_iter().map(Some));
        if candidates.iter().any(|candidate| same_value_zero(candidate.as_ref(), subclass_value)) {
            subclass = Some(entry);
            break;
        }
    }

    let zero = json!(0);
    let pre_feat_abilities: Map<String, Value> = ABILITIES
        .iter()
        .map(|ability| {
            let base = js::number(prop(prop(generation, "baseScores"), ability));
            let bonus = js::number(Some(defined(prop(prop(generation, "originBonuses"), ability)).unwrap_or(&zero)));
            ((*ability).to_string(), number_value(base + bonus))
        })
        .collect();

    let mut known_skills = spread_nullish(field("classSkillProficiencies"), "(source.classSkillProficiencies ?? [])")?;
    known_skills.extend(spread(species.get("skill_proficiencies"), "species.skill_proficiencies")?);
    known_skills.extend(spread(background.get("skillProficiencies"), "background.skillProficiencies")?);
    known_skills.extend(spread_nullish(prop(background_choices, "replacementSkills"), "(source.backgroundChoices?.replacementSkills ?? [])")?);

    let mut known_tools = spread(definition.get("tool_proficiencies"), "definition.tool_proficiencies")?;
    known_tools.extend(spread(species.get("tool_proficiencies"), "species.tool_proficiencies")?);
    known_tools.extend(spread(background_grants.get("tool_proficiencies"), "backgroundGrants.tool_proficiencies")?);
    let known_tools: Vec<Value> = known_tools.iter().map(tool_id_value).collect();

    let mut armor = spread(definition.get("armor_proficiencies"), "definition.armor_proficiencies")?;
    armor.extend(spread_nullish(prop(species.get("mechanics"), "armor_proficiencies"), "(species.mechanics?.armor_proficiencies ?? [])")?);
    armor.extend(spread_nullish(prop(subclass, "additional_armor_proficiencies"), "(subclass?.additional_armor_proficiencies ?? [])")?);
    let mut weapons = spread(definition.get("weapon_proficiencies"), "definition.weapon_proficiencies")?;
    weapons.extend(spread_nullish(prop(species.get("mechanics"), "weapon_proficiencies"), "(species.mechanics?.weapon_proficiencies ?? [])")?);
    weapons.extend(spread_nullish(prop(subclass, "additional_weapon_proficiencies"), "(subclass?.additional_weapon_proficiencies ?? [])")?);

    let raw_feat = raw_map.get("feat");
    let mut feat: Option<Value> = None;
    if species_id_value.and_then(Value::as_str) == Some("human-variant") {
        if !js::truthy(prop(raw_feat, "id")) {
            return fail("Вариантный человек должен выбрать одну черту PHB 2014");
        }
        let mut languages = spread(species.get("languages"), "species.languages")?;
        languages.extend(spread(background_grants.get("languages"), "backgroundGrants.languages")?);
        let context = json!({
            "abilities": pre_feat_abilities,
            "armor": armor,
            "weapons": weapons,
            "skills": known_skills,
            "tools": known_tools,
            "languages": languages,
            "canCastSpells": character_class.and_then(Value::as_str).is_some_and(|id| CASTERS.contains(&id)),
        });
        let empty = json!({});
        let choices = defined(prop(raw_feat, "choices")).unwrap_or(&empty);
        let resolved = resolve_character_creation_feat(prop(raw_feat, "id"), Some(choices), Some(&context));
        if !js::truthy(resolved.get("ok")) {
            return fail(js::s(resolved.get("reason")));
        }
        feat = Some(resolved);
    } else if js::truthy(raw_feat) {
        return fail("Черта при создании доступна только вариантному человеку");
    }
    let feat_benefit = |key: &str| feat.as_ref().and_then(|feat| prop(feat.get("benefits"), key));

    let mut choices = Map::new();
    object_spread_into(&mut choices, defined(raw_map.get("classChoices")));
    choices.insert("skills".into(), defined(field("classSkillProficiencies")).cloned().unwrap_or_else(|| json!([])));
    if js::truthy(subclass_value) {
        choices.insert("subclass".into(), subclass_value.cloned().unwrap_or(Value::Null));
    }
    if class_is("fighter") {
        let Some(style) = selected_fighting_style(field("selectedFeatureIds")) else {
            return fail("Воин выбирает один из шести боевых стилей PHB 2014");
        };
        choices.insert("fighting_style".into(), style);
    }
    let mut context_skills = known_skills.clone();
    context_skills.extend(spread_nullish(feat_benefit("skill_proficiencies"), "(feat?.benefits.skill_proficiencies ?? [])")?);
    let class_result = validate_class_choices(
        character_class,
        Some(&Value::Object(choices)),
        Some(&json!({ "skill_proficiencies": context_skills, "tool_proficiencies": known_tools })),
    );
    if !js::truthy(class_result.get("ok")) {
        let errors: Vec<String> = array(class_result.get("errors")).iter().map(|error| js::s(Some(error))).collect();
        return fail(errors.join("; "));
    }
    let null = Value::Null;
    let class_grants = class_result.get("benefits").unwrap_or(&null);
    let class_choices = class_result.get("choices").unwrap_or(&null);

    let mut additional_skills = spread_nullish(class_choices.get("knowledge_skills"), "(classResult.choices.knowledge_skills ?? [])")?;
    if let Some(skill) = class_choices.get("nature_skill").filter(|skill| js::truthy(Some(skill))) {
        additional_skills.push(skill.clone());
    }
    additional_skills.extend(spread_nullish(feat_benefit("skill_proficiencies"), "(feat?.benefits.skill_proficiencies ?? [])")?);

    let mut additional_tools = spread(class_grants.get("tool_proficiencies"), "classGrants.tool_proficiencies")?;
    additional_tools.extend(spread_nullish(feat_benefit("tool_proficiencies"), "(feat?.benefits.tool_proficiencies ?? [])")?);
    let additional_tools: Vec<Value> = additional_tools.iter().map(tool_id_value).collect();
    let mut all_tools = spread(species.get("tool_proficiencies"), "species.tool_proficiencies")?;
    all_tools.extend(spread(background_grants.get("tool_proficiencies"), "backgroundGrants.tool_proficiencies")?);
    all_tools.extend(additional_tools.iter().cloned());
    let all_tools: Vec<Value> = all_tools.iter().map(tool_id_value).collect();
    let duplicate_tools = all_tools.len() - unique_values(all_tools.iter().cloned()).len();
    let replacement_tools: Vec<Value> = map_nullish(prop(background_choices, "replacementTools"), "(source.backgroundChoices?.replacementTools ?? [])")?
        .iter()
        .map(tool_id_value)
        .collect();
    if replacement_tools.len() != duplicate_tools
        || unique_values(replacement_tools.iter().cloned()).len() != duplicate_tools
        || replacement_tools.iter().any(|id| !id.as_str().is_some_and(|id| PHB_2014_TOOL_IDS.contains(&id)) || includes(&all_tools, id))
    {
        return fail(format!("Выберите {duplicate_tools} новых инструментальных владений взамен повторов"));
    }

    let mut additional_language_values = spread_nullish(class_grants.get("languages"), "(classGrants.languages ?? [])")?;
    if class_is("druid") {
        additional_language_values.push(json!("druidic"));
    }
    if class_is("rogue") {
        additional_language_values.push(json!("thieves-cant"));
    }
    additional_language_values.extend(spread_nullish(feat_benefit("language_proficiencies"), "(feat?.benefits.language_proficiencies ?? [])")?);
    let additional_languages: Vec<String> = additional_language_values.iter().map(language_id).collect();
    let background_catalog = background_catalog_for(DND_2014_RULESET_ID)?;
    let catalog_languages = array(background_catalog.get("language_options"));
    let mut language_options: Vec<Value> = catalog_languages.iter().map(|entry| entry.get("id").cloned().unwrap_or(Value::Null)).collect();
    language_options.extend(["common", "druidic", "thieves-cant"].map(|id| json!(id)));
    if additional_languages.iter().any(|id| !includes(&language_options, &json!(id))) {
        return fail("Выберите язык из каталога PHB 2014");
    }
    let mut fixed_language_values = spread(species.get("languages"), "species.languages")?;
    fixed_language_values.extend(spread(background_grants.get("languages"), "backgroundGrants.languages")?);
    let mut fixed_languages = unique_values(fixed_language_values);
    if let Some(language) = prop(class_choices.get("favored_enemy"), "language").filter(|language| js::truthy(Some(language))) {
        let id = json!(language_id(language));
        if !includes(&fixed_languages, &id) {
            fixed_languages.push(id);
        }
    }
    let mut chosen_language_values = spread_nullish(class_choices.get("knowledge_languages"), "(classResult.choices.knowledge_languages ?? [])")?;
    chosen_language_values.extend(spread_nullish(feat_benefit("language_proficiencies"), "(feat?.benefits.language_proficiencies ?? [])")?);
    let chosen_languages: Vec<Value> = chosen_language_values.iter().map(|id| json!(language_id(id))).collect();
    if chosen_languages.iter().any(|id| includes(&fixed_languages, id)) || unique_values(chosen_languages.iter().cloned()).len() != chosen_languages.len() {
        return fail("Выбранный дополнительный язык уже известен: выберите другой");
    }

    let spell_ids = |value: Option<&Value>, expression: &str| -> Result<Vec<String>, PhbCreationError> {
        Ok(map_nullish(value, expression)?.iter().map(|id| phb_spell_id(Some(id))).collect())
    };
    let domain_spells = spell_ids(class_grants.get("domain_spell_ids"), "(classGrants.domain_spell_ids ?? [])")?;
    let mut domain_spells_by_level: Vec<(String, Vec<String>)> = Vec::new();
    if let Some(Value::Object(levels)) = defined(class_grants.get("domain_spell_ids_by_level")) {
        for (level, ids) in js::entries(levels) {
            domain_spells_by_level.push((level.clone(), spell_ids(Some(ids), "ids")?));
        }
    }
    let expanded_spells = spell_ids(prop(class_grants.get("expanded_spell_list"), "1"), "(classGrants.expanded_spell_list?.[1] ?? [])")?;

    let mut grants: Vec<Value> = Vec::new();
    if let Some(cantrip) = class_grants.get("extra_druid_cantrip").filter(|cantrip| js::truthy(Some(cantrip))) {
        grants.push(json!({ "id": phb_spell_id(Some(cantrip)), "ability": "wis", "uses": "at-will", "source": "nature-domain" }));
    }
    if prop(class_grants.get("subclass"), "id").and_then(Value::as_str) == Some("light") {
        grants.push(json!({ "id": "light", "ability": "wis", "uses": "at-will", "source": "light-domain" }));
    }
    let magic = feat_benefit("spellcasting").filter(|magic| js::truthy(Some(magic)));
    if let Some(magic) = magic {
        let grant = |id: &Value, uses: Value| {
            let mut entry = Map::new();
            entry.insert("id".into(), json!(phb_spell_id(Some(id))));
            insert_present(&mut entry, "ability", magic.get("ability"));
            entry.insert("uses".into(), uses);
            insert_present(&mut entry, "source", magic.get("source"));
            insert_present(&mut entry, "class_key", magic.get("class_key"));
            Value::Object(entry)
        };
        for id in map_nullish(magic.get("cantrips"), "(magic.cantrips ?? [])")? {
            grants.push(grant(id, json!("at-will")));
        }
        if let Some(spell) = magic.get("first_level_spell").filter(|spell| js::truthy(Some(spell))) {
            grants.push(grant(spell, json!(1)));
        }
    }

    let mut value = Map::new();
    value.insert("schema_version".into(), json!(1));
    value.insert("classChoices".into(), class_choices.clone());
    if let Some(feat) = &feat {
        let mut entry = Map::new();
        insert_present(&mut entry, "id", prop(feat.get("feat"), "id"));
        insert_present(&mut entry, "choices", feat.get("choices"));
        value.insert("feat".into(), Value::Object(entry));
    }
    if let Some(choices) = raw_map.get("backgroundEquipmentChoices").filter(|choices| js::truthy(Some(choices))) {
        value.insert("backgroundEquipmentChoices".into(), choices.clone());
    }

    let mut additional_tool_result = additional_tools.clone();
    additional_tool_result.extend(replacement_tools.iter().cloned());

    let mut armor_all = armor;
    armor_all.extend(spread_nullish(feat_benefit("armor_proficiencies"), "(feat?.benefits.armor_proficiencies ?? [])")?);
    let mut weapons_all = weapons;
    weapons_all.extend(spread_nullish(feat_benefit("weapon_proficiencies"), "(feat?.benefits.weapon_proficiencies ?? [])")?);
    let mut tools_all = all_tools.clone();
    tools_all.extend(replacement_tools.iter().cloned());
    let tools_unique = unique_values(tools_all);
    let tool_options = phb_tool_options();
    let tool_labels: Vec<Value> = tools_unique
        .iter()
        .map(|id| {
            array(Some(&tool_options))
                .iter()
                .find(|entry| same_value_zero(entry.get("id"), Some(id)))
                .and_then(|entry| defined(entry.get("name")))
                .cloned()
                .unwrap_or_else(|| id.clone())
        })
        .collect();
    let mut languages_all = fixed_languages.clone();
    languages_all.extend(additional_languages.iter().map(|id| json!(id)));
    let languages_unique = unique_values(languages_all);
    let language_labels: Vec<Value> = languages_unique
        .iter()
        .map(|id| {
            let fixed = match js::string(Some(id)).as_str() {
                "common" => Some("Общий"),
                "druidic" => Some("Друидический"),
                "thieves-cant" => Some("Воровской жаргон"),
                _ => None,
            };
            fixed
                .map(|label| json!(label))
                .or_else(|| catalog_languages.iter().find(|entry| same_value_zero(entry.get("id"), Some(id))).and_then(|entry| defined(entry.get("name"))).cloned())
                .unwrap_or_else(|| id.clone())
        })
        .collect();
    let spell_name = |id: &str| -> Value {
        canonical_combat_spell_for(Some(&json!(id)), None)
            .and_then(|spell| defined(spell.get("name")).cloned())
            .unwrap_or_else(|| json!(id))
    };
    let mut saving_throws = spread(class_grants.get("saving_throw_proficiencies"), "classGrants.saving_throw_proficiencies")?;
    saving_throws.extend(spread_nullish(feat_benefit("saving_throw_proficiencies"), "(feat?.benefits.saving_throw_proficiencies ?? [])")?);
    let number_or_zero = |value: Option<&Value>| js::number(Some(defined(value).unwrap_or(&zero)));

    let mut benefits = Map::new();
    benefits.insert("schema_version".into(), json!(1));
    benefits.insert("class".into(), class_grants.clone());
    let feat_summary = match &feat {
        Some(feat) => {
            let mut entry = Map::new();
            insert_present(&mut entry, "id", prop(feat.get("feat"), "id"));
            insert_present(&mut entry, "name", prop(feat.get("feat"), "name"));
            object_spread_into(&mut entry, feat.get("benefits"));
            Value::Object(entry)
        }
        None => Value::Null,
    };
    benefits.insert("feat".into(), feat_summary);
    benefits.insert("armor_proficiencies".into(), Value::Array(unique_values(armor_all)));
    benefits.insert("weapon_proficiencies".into(), Value::Array(unique_values(weapons_all)));
    benefits.insert("tool_proficiencies".into(), Value::Array(tools_unique));
    benefits.insert("tool_proficiency_labels".into(), Value::Array(tool_labels));
    benefits.insert("languages".into(), Value::Array(languages_unique));
    benefits.insert("language_labels".into(), Value::Array(language_labels));
    benefits.insert("expertise".into(), defined(class_grants.get("expertise")).cloned().unwrap_or_else(|| json!([])));
    benefits.insert("domain_spells".into(), json!(domain_spells));
    benefits.insert(
        "domain_spells_by_level".into(),
        Value::Object(domain_spells_by_level.iter().map(|(level, ids)| (level.clone(), json!(ids))).collect()),
    );
    benefits.insert("expanded_spells".into(), json!(expanded_spells));
    benefits.insert("domain_spell_names".into(), Value::Array(domain_spells.iter().map(|id| spell_name(id)).collect()));
    benefits.insert(
        "domain_spell_names_by_level".into(),
        Value::Object(
            domain_spells_by_level
                .iter()
                .map(|(level, ids)| (level.clone(), Value::Array(ids.iter().map(|id| spell_name(id)).collect())))
                .collect(),
        ),
    );
    benefits.insert("spell_grants".into(), Value::Array(grants));
    let ritual_book = magic.filter(|magic| magic.get("source").and_then(Value::as_str) == Some("ritual-caster")).cloned().unwrap_or(Value::Null);
    benefits.insert("ritual_book".into(), ritual_book);
    benefits.insert(
        "extra_hit_points_per_level".into(),
        js::num(number_or_zero(class_grants.get("max_hit_points_bonus_per_class_level")) + number_or_zero(feat_benefit("hit_point_maximum_bonus_per_level"))),
    );
    benefits.insert("speed_bonus".into(), js::num(number_or_zero(feat_benefit("speed_bonus"))));
    benefits.insert("initiative_bonus".into(), js::num(number_or_zero(feat_benefit("initiative_bonus"))));
    benefits.insert("passive_skill_bonuses".into(), defined(feat_benefit("passive_skill_bonuses")).cloned().unwrap_or_else(|| json!({})));
    benefits.insert("unarmored_armor_class".into(), defined(class_grants.get("unarmored_armor_class")).cloned().unwrap_or(Value::Null));
    benefits.insert("saving_throw_proficiencies".into(), Value::Array(unique_values(saving_throws)));

    let mut result = Map::new();
    result.insert("value".into(), Value::Object(value));
    result.insert("abilityBonuses".into(), defined(feat_benefit("ability_increases")).cloned().unwrap_or_else(|| json!({})));
    result.insert("additionalSkills".into(), Value::Array(additional_skills));
    result.insert("additionalTools".into(), Value::Array(additional_tool_result));
    result.insert("additionalLanguages".into(), json!(additional_languages));
    result.insert("benefits".into(), Value::Object(benefits));
    Ok(Some(Value::Object(result)))
}

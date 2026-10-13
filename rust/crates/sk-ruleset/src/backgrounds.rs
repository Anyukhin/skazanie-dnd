//! Перенос `server/backgrounds.mjs`: каталоги предысторий по редакциям
//! (`data/backgrounds-srd-5-2-1.json`, `data/backgrounds-dnd-5e-2014.json`),
//! авторская предыстория и варианты PHB 2014, прибавки характеристик от
//! предыстории (2024), выбор инструментов и языков и итоговые преимущества
//! предыстории на листе героя.

use std::fmt;
use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::{js, text};

use crate::character_creation_class_options::{PHB_2014_SKILLS, PHB_2014_TOOL_IDS};
use crate::ruleset_config::{ruleset_profile, ProfileOptions, RulesetSelectionError, DND_2014_RULESET_ID, LEGACY_DEFAULT_RULESET_ID};
use crate::support::{array, defined, embedded_json, includes, path, prop, same_value_zero, spread_items, string_of, unique_strings, unique_values};

const TOOL_LABELS: [(&str, &str); 39] = [
    ("alchemists_supplies", "Алхимические принадлежности"),
    ("brewers_supplies", "Принадлежности пивовара"),
    ("calligraphers_supplies", "Принадлежности каллиграфа"),
    ("carpenters_tools", "Инструменты плотника"),
    ("cartographers_tools", "Инструменты картографа"),
    ("cobblers_tools", "Инструменты сапожника"),
    ("cooks_utensils", "Кухонная утварь"),
    ("glassblowers_tools", "Инструменты стеклодува"),
    ("jewelers_tools", "Инструменты ювелира"),
    ("leatherworkers_tools", "Инструменты кожевника"),
    ("masons_tools", "Инструменты каменщика"),
    ("painters_supplies", "Принадлежности художника"),
    ("potters_tools", "Инструменты гончара"),
    ("smiths_tools", "Инструменты кузнеца"),
    ("tinkers_tools", "Инструменты ремонтника"),
    ("weavers_tools", "Инструменты ткача"),
    ("woodcarvers_tools", "Инструменты резчика по дереву"),
    ("bagpipes", "Волынка"),
    ("drum", "Барабан"),
    ("dulcimer", "Цимбалы"),
    ("flute", "Флейта"),
    ("lute", "Лютня"),
    ("lyre", "Лира"),
    ("horn", "Рожок"),
    ("pan_flute", "Свирель"),
    ("shawm", "Шалмей"),
    ("viol", "Виола"),
    ("dice_set", "Игральные кости"),
    ("dragonchess_set", "Драконьи шахматы"),
    ("playing_cards", "Игральные карты"),
    ("three_dragon_ante_set", "Ставка трёх драконов"),
    ("disguise_kit", "Набор для грима"),
    ("forgery_kit", "Набор для подделок"),
    ("herbalism_kit", "Набор травника"),
    ("navigators_tools", "Инструменты навигатора"),
    ("poisoners_kit", "Набор отравителя"),
    ("thieves_tools", "Воровские инструменты"),
    ("vehicles_land", "Наземный транспорт"),
    ("vehicles_water", "Водный транспорт"),
];

fn tool_label(id: &str) -> Option<&'static str> {
    TOOL_LABELS.iter().find(|(key, _)| *key == id).map(|(_, label)| *label)
}

/// `PHB_BACKGROUND_VARIANTS`: варианты предысторий PHB 2014.
pub static PHB_BACKGROUND_VARIANTS: LazyLock<Value> = LazyLock::new(|| {
    json!([
        { "id": "spy", "backgroundId": "criminal", "name": "Шпион" },
        { "id": "gladiator", "backgroundId": "entertainer", "name": "Гладиатор" },
        { "id": "guild-merchant", "backgroundId": "guild-artisan", "name": "Гильдейский торговец" },
        { "id": "knight", "backgroundId": "noble", "name": "Рыцарь", "feature": { "id": "retainers", "name": "Слуги", "supported": false } },
        { "id": "pirate", "backgroundId": "sailor", "name": "Пират", "feature": { "id": "bad-reputation", "name": "Дурная репутация", "supported": false } },
    ])
});

/// `phbToolOptions()`: инструменты PHB 2014 с русскими названиями.
pub fn phb_tool_options() -> Value {
    Value::Array(
        PHB_2014_TOOL_IDS
            .iter()
            .map(|id| {
                let name = tool_label(id).or_else(|| tool_label(&format!("{id}_set"))).unwrap_or(id);
                json!({ "id": id, "name": name })
            })
            .collect(),
    )
}

const CURRENT_CATALOG_SOURCE: &str = include_str!("../../../../data/backgrounds-srd-5-2-1.json");
const CLASSIC_CATALOG_SOURCE: &str = include_str!("../../../../data/backgrounds-dnd-5e-2014.json");

/// Каталоги в порядке `catalogs` (`Map`): сначала 2024, затем 2014.
static CATALOGS: LazyLock<[(&'static str, Value); 2]> = LazyLock::new(|| {
    [(LEGACY_DEFAULT_RULESET_ID, embedded_json(CURRENT_CATALOG_SOURCE)), (DND_2014_RULESET_ID, embedded_json(CLASSIC_CATALOG_SOURCE))]
});

fn classic_catalog() -> &'static Value {
    &CATALOGS[1].1
}

const ABILITY_IDS: [&str; 6] = ["str", "dex", "con", "int", "wis", "cha"];

/// Что бросает модуль: неизвестная редакция (`RulesetSelectionError`) или
/// неверная авторская предыстория (`TypeError` в JS — без кода).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackgroundError {
    Ruleset(RulesetSelectionError),
    Type(String),
}

impl BackgroundError {
    pub fn message(&self) -> &str {
        match self {
            Self::Ruleset(error) => &error.message,
            Self::Type(message) => message,
        }
    }
}

impl fmt::Display for BackgroundError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Ruleset(error) => error.fmt(f),
            Self::Type(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for BackgroundError {}

impl From<RulesetSelectionError> for BackgroundError {
    fn from(error: RulesetSelectionError) -> Self {
        Self::Ruleset(error)
    }
}

fn type_error(message: &str) -> BackgroundError {
    BackgroundError::Type(message.into())
}

/// `resolveBackgroundCustomization(raw)`: проверенная авторская предыстория
/// PHB 2014 или `None` для `null`/`undefined`.
pub fn resolve_background_customization(raw: Option<&Value>) -> Result<Option<Value>, BackgroundError> {
    let Some(raw) = defined(raw) else {
        return Ok(None);
    };
    let Value::Object(value) = raw else {
        return Err(type_error("Настройка предыстории должна быть объектом"));
    };
    const KEYS: [&str; 5] = ["name", "skills", "toolCount", "featureBackgroundId", "variant"];
    if value.keys().any(|key| !KEYS.contains(&key.as_str())) {
        return Err(type_error("Неизвестное поле настройки предыстории"));
    }
    let skills = match value.get("skills") {
        Some(Value::Array(skills))
            if skills.len() == 2
                && unique_values(skills.iter().cloned()).len() == 2
                && skills.iter().all(|id| id.as_str().is_some_and(|id| PHB_2014_SKILLS.contains(&id))) =>
        {
            skills
        }
        _ => return Err(type_error("Авторская предыстория даёт два разных навыка")),
    };
    // `Number.isInteger(toolCount)` без приведения: только число.
    let tool_count = value.get("toolCount");
    let count = tool_count.and_then(Value::as_f64).filter(|count| count.fract() == 0.0);
    if !count.is_some_and(|count| (0.0..=2.0).contains(&count)) {
        return Err(type_error("Выберите всего два инструмента или языка"));
    }
    let feature_background_id = value.get("featureBackgroundId");
    let feature_exists = array(classic_catalog().get("backgrounds"))
        .iter()
        .any(|entry| matches!((entry.get("id"), feature_background_id), (Some(id), Some(wanted)) if same_value_zero(id, wanted)));
    if !feature_exists {
        return Err(type_error("Выберите существующую особенность предыстории"));
    }
    let requested_variant = value.get("variant").filter(|variant| js::truthy(Some(variant)));
    let variant = requested_variant.and_then(|wanted| {
        array(Some(&PHB_BACKGROUND_VARIANTS)).iter().find(|entry| {
            entry.get("id").is_some_and(|id| same_value_zero(id, wanted))
                && matches!((entry.get("backgroundId"), feature_background_id), (Some(id), Some(feature)) if same_value_zero(id, feature))
        })
    });
    if requested_variant.is_some() && variant.is_none() {
        return Err(type_error("Вариант не принадлежит выбранной предыстории"));
    }
    let name_source = defined(value.get("name")).map_or_else(|| "Своя предыстория".to_string(), |name| js::s(Some(name)));
    let mut result = Map::new();
    result.insert("name".into(), json!(text::head(text::trim(&name_source), 160)));
    result.insert("skills".into(), Value::Array(skills.clone()));
    result.insert("toolCount".into(), tool_count.cloned().unwrap_or(Value::Null));
    result.insert("featureBackgroundId".into(), json!(string_of(feature_background_id)));
    if let Some(variant) = variant {
        result.insert("variant".into(), variant.get("id").cloned().unwrap_or(Value::Null));
    }
    Ok(Some(Value::Object(result)))
}

/// Каталог предысторий редакции; `ruleset_id` — уже приведённое
/// `String(rulesetId ?? '')`, пустое — 2024 по умолчанию.
fn catalog_for(ruleset_id: &str) -> Result<&'static Value, RulesetSelectionError> {
    let profile = ruleset_profile(ruleset_id, ProfileOptions::fallback(LEGACY_DEFAULT_RULESET_ID))?;
    CATALOGS.iter().find(|(id, _)| *id == profile.id).map(|(_, catalog)| catalog).ok_or_else(|| {
        RulesetSelectionError::new(format!("Нет каталога предысторий для {}", profile.id), "RULESET_INVALID")
    })
}

fn ability_modes_for(catalog: &Value) -> Vec<Value> {
    array(catalog.get("abilityChoiceModes"))
        .iter()
        .map(|mode| {
            let mut entry = match mode {
                Value::Object(map) => map.clone(),
                _ => Map::new(),
            };
            entry.insert("increases".into(), Value::Array(spread_items(mode.get("increases"))));
            Value::Object(entry)
        })
        .collect()
}

fn public_background(catalog: &Value, entry: &Value) -> Value {
    let tool_choice = entry.get("toolChoice");
    let group = js::s(defined(prop(tool_choice, "group")));
    let options = if group.is_empty() {
        Value::Array(Vec::new())
    } else {
        defined(prop(catalog.get("toolChoiceGroups"), &group)).cloned().unwrap_or_else(|| json!([]))
    };
    let mut result = match entry {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    let tool_proficiencies = match defined(entry.get("toolProficiencies")) {
        Some(list) => list.clone(),
        None => match entry.get("toolProficiency").filter(|tool| js::truthy(Some(tool))) {
            Some(tool) => json!([tool]),
            None => json!([]),
        },
    };
    result.insert("toolProficiencies".into(), tool_proficiencies);
    if let Some(choice) = tool_choice.filter(|choice| js::truthy(Some(choice))) {
        let mut choice = match choice {
            Value::Object(map) => map.clone(),
            _ => Map::new(),
        };
        choice.insert("options".into(), options);
        result.insert("toolChoice".into(), Value::Object(choice));
    }
    Value::Object(result)
}

/// `backgroundCatalogFor(rulesetId)`: публичный каталог предысторий
/// редакции; для 2014 — с авторской предысторией и вариантами.
pub fn background_catalog_for(ruleset_id: &str) -> Result<Value, RulesetSelectionError> {
    let catalog = catalog_for(ruleset_id)?;
    let mut result = Map::new();
    result.insert("policy_id".into(), json!(string_of(Some(defined(catalog.get("policyId")).unwrap_or(&json!("skazanie.backgrounds"))))));
    result.insert("ability_modes".into(), Value::Array(ability_modes_for(catalog)));
    result.insert("language_options".into(), defined(catalog.get("languageOptions")).cloned().unwrap_or_else(|| json!([])));
    let options = array(catalog.get("backgrounds")).iter().map(|entry| public_background(catalog, entry)).collect();
    result.insert("options".into(), Value::Array(options));
    result.insert("origin_feats_supported".into(), json!(false));
    result.insert("background_features_supported".into(), json!(false));
    if ruleset_id == DND_2014_RULESET_ID {
        result.insert(
            "customization".into(),
            json!({
                "skill_count": 2,
                "tool_language_count": 2,
                "tool_options": phb_tool_options(),
                "variants": PHB_BACKGROUND_VARIANTS.clone(),
            }),
        );
    }
    Ok(Value::Object(result))
}

/// `backgroundById(id, rulesetId, customization)`: публичная запись
/// предыстории; для 2014 с авторской настройкой — с её навыками,
/// инструментами и особенностью. `id` — уже приведённое `String(id ?? '')`.
pub fn background_by_id(id: &str, ruleset_id: &str, customization: Option<&Value>) -> Result<Option<Value>, BackgroundError> {
    let catalog = catalog_for(ruleset_id)?;
    let Some(entry) = array(catalog.get("backgrounds")).iter().find(|candidate| string_of(candidate.get("id")) == id) else {
        return Ok(None);
    };
    let result = public_background(catalog, entry);
    if ruleset_id != DND_2014_RULESET_ID || defined(customization).is_none() {
        return Ok(Some(result));
    }
    let Some(selected) = resolve_background_customization(customization)? else {
        return Ok(Some(result));
    };
    let feature_background = array(classic_catalog().get("backgrounds"))
        .iter()
        .find(|entry| matches!((entry.get("id"), selected.get("featureBackgroundId")), (Some(id), Some(wanted)) if same_value_zero(id, wanted)));
    let variant = array(Some(&PHB_BACKGROUND_VARIANTS))
        .iter()
        .find(|entry| matches!((entry.get("id"), selected.get("variant")), (Some(id), Some(wanted)) if same_value_zero(id, wanted)));
    let mut merged = match result {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    let name = selected.get("name").filter(|name| js::truthy(Some(name))).or_else(|| merged.get("name")).cloned();
    match name {
        Some(name) => merged.insert("name".into(), name),
        None => merged.remove("name"),
    };
    merged.insert("skillProficiencies".into(), selected.get("skills").cloned().unwrap_or(Value::Null));
    merged.insert("toolProficiencies".into(), json!([]));
    let tool_count = selected.get("toolCount").cloned().unwrap_or(Value::Null);
    merged.insert("toolChoice".into(), json!({ "count": tool_count, "options": phb_tool_options() }));
    merged.insert("languageChoiceCount".into(), js::num(2.0 - js::number(Some(&tool_count))));
    // `variant?.feature ?? featureBackground?.feature`; `undefined` в JSON не попадает.
    match defined(prop(variant, "feature")).or_else(|| prop(feature_background, "feature")) {
        Some(feature) => merged.insert("feature".into(), feature.clone()),
        None => merged.remove("feature"),
    };
    Ok(Some(Value::Object(merged)))
}

/// `resolveBackgroundAbilityChoice(backgroundId, choice = {}, rulesetId)`:
/// прибавки характеристик от предыстории (в 2014 их нет).
pub fn resolve_background_ability_choice(background_id: &str, choice: Option<&Value>, ruleset_id: &str) -> Result<Value, BackgroundError> {
    let catalog = catalog_for(ruleset_id)?;
    let Some(background) = background_by_id(background_id, ruleset_id, None)? else {
        return Ok(json!({ "ok": false, "reason": "Такой предыстории нет в каталоге" }));
    };
    let modes = ability_modes_for(catalog);
    let picked: Vec<String> = array(prop(choice, "abilities")).iter().map(|value| text::lower(&string_of(Some(value)))).collect();
    let mode_value = prop(choice, "mode");
    if modes.is_empty() {
        if !picked.is_empty() || (js::truthy(mode_value) && mode_value.and_then(Value::as_str) != Some("none")) {
            return Ok(json!({ "ok": false, "reason": "В редакции 2014 предыстория не повышает характеристики" }));
        }
        return Ok(json!({ "ok": true, "bonuses": {}, "mode": "none" }));
    }
    let allowed = array(background.get("abilityOptions"));
    let wanted_mode = js::s(defined(mode_value));
    let mode = modes.iter().find(|entry| entry.get("id").and_then(Value::as_str) == Some(wanted_mode.as_str())).unwrap_or(&modes[0]);
    let increases = array(mode.get("increases"));
    let expected = increases.len();
    if picked.len() != expected {
        return Ok(json!({
            "ok": false,
            "reason": format!("Для раскладки «{}» нужно выбрать {expected} характеристики", string_of(mode.get("label"))),
        }));
    }
    if unique_strings(picked.iter().cloned()).len() != picked.len() {
        return Ok(json!({ "ok": false, "reason": "Характеристики в раскладке не должны повторяться" }));
    }
    for ability in &picked {
        if !ABILITY_IDS.contains(&ability.as_str()) {
            return Ok(json!({ "ok": false, "reason": "Неизвестная характеристика" }));
        }
        if !includes(allowed, &Value::String(ability.clone())) {
            return Ok(json!({ "ok": false, "reason": "Эта предыстория такую характеристику не повышает" }));
        }
    }
    let bonuses: Map<String, Value> =
        picked.iter().enumerate().map(|(index, ability)| (ability.clone(), increases.get(index).cloned().unwrap_or(Value::Null))).collect();
    Ok(json!({ "ok": true, "bonuses": bonuses, "mode": mode.get("id").cloned().unwrap_or(Value::Null) }))
}

/// `defaultBackgroundAbilityChoice(backgroundId, rulesetId)`: первая раскладка
/// и первые характеристики предыстории.
pub fn default_background_ability_choice(background_id: &str, ruleset_id: &str) -> Result<Option<Value>, BackgroundError> {
    let catalog = catalog_for(ruleset_id)?;
    let Some(background) = background_by_id(background_id, ruleset_id, None)? else {
        return Ok(None);
    };
    let modes = ability_modes_for(catalog);
    let Some(first) = modes.first() else {
        return Ok(Some(json!({ "mode": "none", "abilities": [] })));
    };
    let count = array(first.get("increases")).len();
    let abilities: Vec<Value> = array(background.get("abilityOptions")).iter().take(count).cloned().collect();
    Ok(Some(json!({ "mode": first.get("id").cloned().unwrap_or(Value::Null), "abilities": abilities })))
}

/// `resolveBackgroundChoices(backgroundId, choice = {}, rulesetId)`: выбор
/// инструментов и языков предыстории.
pub fn resolve_background_choices(background_id: &str, choice: Option<&Value>, ruleset_id: &str) -> Result<Value, BackgroundError> {
    let catalog = catalog_for(ruleset_id)?;
    let Some(background) = background_by_id(background_id, ruleset_id, prop(choice, "customization"))? else {
        return Ok(json!({ "ok": false, "reason": "Такой предыстории нет в каталоге" }));
    };
    let tool_choice = background.get("toolChoice");
    let tool_options = array(defined(prop(tool_choice, "options")));
    let number_or_zero = |value: Option<&Value>| js::number(Some(defined(value).unwrap_or(&json!(0))));
    let tool_count = number_or_zero(prop(tool_choice, "count"));
    let tools: Vec<String> = array(prop(choice, "tools")).iter().map(|value| string_of(Some(value))).collect();
    let languages: Vec<String> = array(prop(choice, "languages")).iter().map(|value| string_of(Some(value))).collect();
    let language_count = number_or_zero(background.get("languageChoiceCount"));
    if tools.len() as f64 != tool_count || unique_strings(tools.iter().cloned()).len() != tools.len() {
        return Ok(json!({ "ok": false, "reason": format!("Нужно выбрать {} владений инструментами", js::f64_string(tool_count)) }));
    }
    if languages.len() as f64 != language_count || unique_strings(languages.iter().cloned()).len() != languages.len() {
        return Ok(json!({ "ok": false, "reason": format!("Нужно выбрать {} языков предыстории", js::f64_string(language_count)) }));
    }
    let allowed_tools: Vec<String> = tool_options.iter().map(|entry| string_of(entry.get("id"))).collect();
    let allowed_languages: Vec<String> = array(catalog.get("languageOptions")).iter().map(|entry| string_of(entry.get("id"))).collect();
    if tools.iter().any(|id| !allowed_tools.contains(id)) {
        return Ok(json!({ "ok": false, "reason": "Предыстория не позволяет выбрать этот инструмент" }));
    }
    if languages.iter().any(|id| !allowed_languages.contains(id)) {
        return Ok(json!({ "ok": false, "reason": "Неизвестный язык предыстории" }));
    }
    let selected_tool_entries: Vec<Value> = tools
        .iter()
        .filter_map(|id| tool_options.iter().find(|entry| string_of(entry.get("id")) == *id))
        .filter(|entry| js::truthy(Some(entry)))
        .cloned()
        .collect();
    Ok(json!({
        "ok": true,
        "tools": tools,
        "languages": languages,
        "selected_tool_entries": selected_tool_entries,
        "fixed_tool_proficiencies": defined(background.get("toolProficiencies")).cloned().unwrap_or_else(|| json!([])),
    }))
}

/// `defaultBackgroundChoices(backgroundId, rulesetId)`: первые инструменты и
/// языки предыстории.
pub fn default_background_choices(background_id: &str, ruleset_id: &str) -> Result<Option<Value>, BackgroundError> {
    let background = background_by_id(background_id, ruleset_id, None)?;
    let catalog = catalog_for(ruleset_id)?;
    let Some(background) = background else {
        return Ok(None);
    };
    let take_ids = |list: &[Value], count: Option<&Value>| -> Vec<Value> {
        let count = js::number(Some(defined(count).unwrap_or(&json!(0))));
        let keep = crate::support::slice_len(list.len(), count);
        list.iter().take(keep).map(|entry| entry.get("id").cloned().unwrap_or(Value::Null)).collect()
    };
    let tool_choice = background.get("toolChoice");
    Ok(Some(json!({
        "tools": take_ids(array(defined(prop(tool_choice, "options"))), prop(tool_choice, "count")),
        "languages": take_ids(array(catalog.get("languageOptions")), background.get("languageChoiceCount")),
    })))
}

/// `withBackgroundBenefits(actor, rulesetId)`: герой с навыками и
/// преимуществами своей предыстории; без предыстории — без этих полей.
pub fn with_background_benefits(actor: Option<&Value>, ruleset_id: &str) -> Result<Value, BackgroundError> {
    let background =
        background_by_id(&js::s(defined(prop(actor, "backgroundId"))), ruleset_id, path(actor, &["backgroundChoices", "customization"]))?;
    let mut rest = match actor {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    let Some(background) = background else {
        rest.remove("backgroundSkillProficiencies");
        rest.remove("backgroundBenefits");
        return Ok(Value::Object(rest));
    };
    let species_skills = defined(prop(actor, "speciesSkillProficiencies")).or_else(|| path(actor, &["speciesBenefits", "skill_proficiencies"]));
    let granted: Vec<String> = spread_items(defined(prop(actor, "classSkillProficiencies")))
        .into_iter()
        .chain(spread_items(defined(species_skills)))
        .chain(spread_items(defined(prop(actor, "creationSkillProficiencies"))))
        .chain(spread_items(background.get("skillProficiencies")))
        .map(|id| string_of(Some(&id)).replace('-', "_"))
        .collect();
    let known = unique_strings(granted.iter().cloned());
    let count = if ruleset_id == DND_2014_RULESET_ID { granted.len() - known.len() } else { 0 };
    // При смене классовых выборов старый повтор может исчезнуть: он больше не
    // даёт дополнительное владение. Сам сохранённый выбор остаётся в документе.
    let replacements: Vec<Value> = unique_values(spread_items(defined(path(actor, &["backgroundChoices", "replacementSkills"]))))
        .into_iter()
        .filter(|id| !id.as_str().is_some_and(|id| known.iter().any(|known| known == id)))
        .take(count)
        .collect();
    let skills: Vec<Value> = spread_items(background.get("skillProficiencies")).into_iter().chain(replacements).collect();
    let benefits = background_benefits(
        &js::s(defined(background.get("id"))),
        prop(actor, "backgroundAbilityChoice"),
        prop(actor, "backgroundChoices"),
        ruleset_id,
    )?;
    rest.insert("backgroundSkillProficiencies".into(), Value::Array(skills.clone()));
    let benefits = benefits.map_or(Value::Null, |benefits| {
        let mut merged = match benefits {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        merged.insert("skill_proficiencies".into(), Value::Array(skills));
        Value::Object(merged)
    });
    rest.insert("backgroundBenefits".into(), benefits);
    Ok(Value::Object(rest))
}

/// `backgroundBenefits(backgroundId, abilityChoice, choices, rulesetId)`:
/// итоговые преимущества предыстории; `None`, если предыстории нет или выбор
/// неверен.
pub fn background_benefits(
    background_id: &str,
    ability_choice: Option<&Value>,
    choices: Option<&Value>,
    ruleset_id: &str,
) -> Result<Option<Value>, BackgroundError> {
    let catalog = catalog_for(ruleset_id)?;
    let Some(background) = background_by_id(background_id, ruleset_id, prop(choices, "customization"))? else {
        return Ok(None);
    };
    let empty = Value::Object(Map::new());
    let default_ability = match defined(ability_choice) {
        Some(_) => None,
        None => default_background_ability_choice(background_id, ruleset_id)?,
    };
    let ability_choice = defined(ability_choice).or(default_ability.as_ref()).unwrap_or(&empty);
    let resolved_abilities = resolve_background_ability_choice(background_id, Some(ability_choice), ruleset_id)?;
    let default_choices = match defined(choices) {
        Some(_) => None,
        None => default_background_choices(background_id, ruleset_id)?,
    };
    let choices = defined(choices).or(default_choices.as_ref()).unwrap_or(&empty);
    let resolved_choices = resolve_background_choices(background_id, Some(choices), ruleset_id)?;
    if !js::is_true(resolved_abilities.get("ok")) || !js::is_true(resolved_choices.get("ok")) {
        return Ok(None);
    }
    let fixed_tools = array(defined(background.get("toolProficiencies")));
    let selected_tools = array(defined(resolved_choices.get("selected_tool_entries")));
    let tool_ids = unique_strings(fixed_tools.iter().chain(selected_tools).map(|entry| string_of(entry.get("id"))));
    let profile = ruleset_profile(ruleset_id, ProfileOptions::fallback(LEGACY_DEFAULT_RULESET_ID))?;
    let mut benefits = Map::new();
    benefits.insert("ruleset_id".into(), json!(profile.id));
    if let Some(id) = background.get("id") {
        benefits.insert("background_id".into(), id.clone());
    }
    benefits.insert(
        "policy_id".into(),
        json!(string_of(Some(defined(catalog.get("policyId")).unwrap_or(&json!("skazanie.backgrounds"))))),
    );
    for (key, source) in [("ability_bonuses", "bonuses"), ("ability_mode", "mode")] {
        if let Some(value) = resolved_abilities.get(source) {
            benefits.insert(key.into(), value.clone());
        }
    }
    benefits.insert("skill_proficiencies".into(), Value::Array(spread_items(background.get("skillProficiencies"))));
    benefits.insert("tool_proficiency".into(), tool_ids.first().map_or(Value::Null, |id| json!(id)));
    benefits.insert("tool_proficiencies".into(), json!(tool_ids));
    benefits.insert("languages".into(), Value::Array(array(resolved_choices.get("languages")).to_vec()));
    benefits.insert("origin_feat".into(), defined(path(Some(&background), &["originFeat", "id"])).cloned().unwrap_or(Value::Null));
    benefits.insert("origin_feat_supported".into(), json!(false));
    benefits.insert("background_feature".into(), defined(path(Some(&background), &["feature", "id"])).cloned().unwrap_or(Value::Null));
    benefits.insert("background_feature_supported".into(), json!(js::is_true(path(Some(&background), &["feature", "supported"]))));
    benefits.insert("equipment".into(), defined(background.get("equipment")).cloned().unwrap_or(Value::Null));
    Ok(Some(Value::Object(benefits)))
}

/// `backgroundCatalogInfo()`: сводка каталогов предысторий по редакциям.
pub fn background_catalog_info() -> Value {
    Value::Object(
        CATALOGS
            .iter()
            .map(|(ruleset_id, catalog)| {
                let info = json!({
                    "ruleset_id": ruleset_id,
                    "backgrounds": array(catalog.get("backgrounds")).len(),
                    "ability_modes": array(catalog.get("abilityChoiceModes")).len(),
                });
                (ruleset_id.to_string(), info)
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classic_backgrounds_give_no_ability_bonuses() {
        let choices = json!({ "tools": ["dice_set"], "languages": [] });
        let benefits = background_benefits("soldier", None, Some(&choices), DND_2014_RULESET_ID).ok().flatten().unwrap_or(Value::Null);
        assert_eq!(benefits["ability_bonuses"], json!({}));
        assert_eq!(benefits["skill_proficiencies"], json!(["athletics", "intimidation"]));
    }

    #[test]
    fn customization_is_validated() {
        let bad = json!({ "skills": ["arcana"], "toolCount": 1, "featureBackgroundId": "sage" });
        assert!(matches!(resolve_background_customization(Some(&bad)), Err(BackgroundError::Type(_))));
        let good = json!({ "name": "  Бродяга  ", "skills": ["arcana", "history"], "toolCount": 1, "featureBackgroundId": "criminal", "variant": "spy" });
        let resolved = resolve_background_customization(Some(&good)).ok().flatten().unwrap_or(Value::Null);
        assert_eq!(resolved["name"], json!("Бродяга"));
        assert_eq!(resolved["variant"], json!("spy"));
        assert_eq!(resolve_background_customization(Some(&Value::Null)), Ok(None));
    }
}

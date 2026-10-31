//! Перенос `server/character-build.mjs`: развитие и подготовка героя вне боя —
//! проверка команд `SetCharacterChoices` (подкласс, классовые навыки и
//! особенности, улучшение характеристик или черта PHB 2014 вместо него) и
//! `SetSpellSelections` (известные и подготовленные заклинания) и событие,
//! которое они порождают. Производные поля героя после выбора (карточки
//! заклинаний, действия, запасы) считают `combat_spells` и `combat_actions`
//! из тех же полей.

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexSet;
use sk_core::{js, re, text};
use sk_ruleset::character_creation_feats::resolve_character_creation_feat;
use sk_ruleset::character_progression::{ability_score_choice_levels_for, catalog_skill_id, normalized_class_skill_proficiencies, normalized_selected_feature_ids};
use sk_ruleset::ruleset_config::DND_2014_RULESET_ID;

use crate::combat_actions::normalized_combat_subclass_for;
use crate::combat_spells::{normalized_spell_selections_for, spell_selection_rules_for};
use crate::jsv::{self, array, defined, is_str, nullish, num, prop};

/// Команды, которые проверяет модуль.
pub const CHARACTER_BUILD_COMMAND_TYPES: [&str; 2] = ["SetCharacterChoices", "SetSpellSelections"];

/// Отказ проверки (`CharacterBuildValidationError`): текст и код — как в JS.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CharacterBuildValidationError {
    pub message: String,
    pub code: String,
}

impl CharacterBuildValidationError {
    /// Имя класса ошибки JS.
    pub const NAME: &'static str = "CharacterBuildValidationError";

    fn new(message: impl Into<String>, code: &str) -> Self {
        Self { message: message.into(), code: code.into() }
    }
}

impl std::fmt::Display for CharacterBuildValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for CharacterBuildValidationError {}

type BuildResult<T> = Result<T, CharacterBuildValidationError>;

const ABILITY_IDS: [&str; 6] = ["str", "dex", "con", "int", "wis", "cha"];

/// `clean(value, maximum)`: `String(value ?? '').normalize('NFKC').trim().slice(0, maximum)`.
fn clean(value: Option<&Value>, maximum: usize) -> String {
    text::clean(value, maximum)
}

fn unique_ids(value: Option<&Value>, field: &str) -> BuildResult<Vec<String>> {
    let Some(Value::Array(items)) = value else {
        return Err(CharacterBuildValidationError::new(format!("{field} должен быть массивом"), "SPELL_SELECTION_INVALID"));
    };
    if items.len() > 100 {
        return Err(CharacterBuildValidationError::new(format!("{field} содержит слишком много значений"), "SPELL_SELECTION_LIMIT_EXCEEDED"));
    }
    let result: IndexSet<String> = items.iter().map(|item| clean(Some(item), 120)).filter(|item| !item.is_empty()).collect();
    // Алфавит совпадает с cleanIdentifier в character-lifecycle.mjs: навыки
    // серверного каталога хранятся в snake_case.
    if result.iter().any(|item| !text::test(re!(r"^[a-z0-9][a-z0-9_-]{0,119}$", "u"), item)) {
        return Err(CharacterBuildValidationError::new(format!("{field} содержит некорректный идентификатор"), "SPELL_SELECTION_INVALID"));
    }
    Ok(result.into_iter().collect())
}

fn same_ids(left: &[String], right: &[String]) -> bool {
    left.len() == right.len() && left.iter().all(|item| right.contains(item))
}

fn is_record(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Object(_)))
}

/// `Object.fromEntries(Object.entries(source).flatMap(...))` по ключам-уровням:
/// ключ — `String(Number(level))` для безопасного целого, порядок — как у
/// объекта JS (индексы — по возрастанию).
fn by_level<F>(source: Option<&Value>, mut map: F) -> Map<String, Value>
where
    F: FnMut(&Value) -> Option<Value>,
{
    let mut result = Map::new();
    if let Some(Value::Object(source)) = source {
        for (level, entry) in js::entries(source) {
            let numeric = js::parse_number(level);
            if !jsv::is_safe_integer(numeric) {
                continue;
            }
            if let Some(value) = map(entry) {
                result.insert(js::f64_string(numeric), value);
            }
        }
    }
    jsv::js_ordered(result)
}

fn level_feats_for(actor: Option<&Value>) -> Map<String, Value> {
    by_level(prop(actor, "levelFeats").filter(|source| source.is_object()), |entry| {
        if !entry.is_object() || text::trim(&js::s(entry.get("id"))).is_empty() {
            return None;
        }
        let mut feat = Map::new();
        feat.insert("id".into(), Value::from(text::lower(text::trim(&jsv::string(entry.get("id"))))));
        feat.insert("choices".into(), if is_record(entry.get("choices")) { entry["choices"].clone() } else { json!({}) });
        if is_record(entry.get("benefits")) {
            feat.insert("benefits".into(), entry["benefits"].clone());
        }
        Some(Value::Object(feat))
    })
}

fn feat_context_for(actor: Option<&Value>, level_feats: &Map<String, Value>) -> Value {
    let mut existing_feats: Vec<Value> = Vec::new();
    let mut existing_choices = Map::new();
    let initial_feat_id = text::lower(text::trim(&js::s(jsv::path(actor, &["creationBenefits", "feat", "id"]))));
    if !initial_feat_id.is_empty() {
        existing_feats.push(Value::from(initial_feat_id.clone()));
        let initial_choices = jsv::path(actor, &["phbCreation", "feat", "choices"]);
        if is_record(initial_choices) {
            existing_choices.insert(initial_feat_id, json!([initial_choices.cloned()]));
        }
    }
    for entry in level_feats.values() {
        let id = jsv::string(entry.get("id"));
        existing_feats.push(entry.get("id").cloned().unwrap_or(Value::Null));
        let slot = existing_choices.entry(id).or_insert_with(|| json!([]));
        if !slot.is_array() {
            *slot = json!([]);
        }
        if let Some(list) = slot.as_array_mut() {
            list.push(entry.get("choices").cloned().unwrap_or(Value::Null));
        }
    }
    let benefits = prop(actor, "creationBenefits").filter(|benefits| benefits.is_object());
    let list = |value: Option<&Value>| Value::Array(array(value).to_vec());
    let mut skills: Vec<Value> = Vec::new();
    for key in ["classSkillProficiencies", "backgroundSkillProficiencies", "speciesSkillProficiencies", "creationSkillProficiencies"] {
        skills.extend(array(prop(actor, key)).iter().cloned());
    }
    let can_cast = spell_selection_rules_for(actor).is_some()
        || !array(prop(benefits, "spell_grants")).is_empty()
        || !array(prop(actor, "creationSpellGrants")).is_empty();
    json!({
        "abilities": defined(prop(actor, "abilities")).cloned().unwrap_or_else(|| json!({})),
        "proficiency": {
            "armor": list(prop(benefits, "armor_proficiencies")),
            "weapons": list(prop(benefits, "weapon_proficiencies")),
        },
        "skills": skills,
        "tools": list(prop(benefits, "tool_proficiencies")),
        "languages": list(prop(benefits, "languages")),
        "canCastSpells": can_cast,
        "allowCappedAbilityIncrease": true,
        "feats": existing_feats,
        "existingFeatChoices": Value::Object(jsv::js_ordered(existing_choices)),
    })
}

/// `addUnique(target, values)`: `includes` по SameValueZero.
fn add_unique(target: Option<&Value>, values: Option<&Value>) -> Value {
    let mut result: Vec<Value> = array(target).to_vec();
    for value in array(values) {
        if !jsv::includes(&result, value) {
            result.push(value.clone());
        }
    }
    Value::Array(result)
}

fn feat_spell_grants(benefits: Option<&Value>) -> Vec<Value> {
    let spellcasting = prop(benefits, "spellcasting").filter(|value| value.is_object());
    let Some(spellcasting) = spellcasting else {
        return Vec::new();
    };
    let grant = |id: &Value, uses: Value| {
        let mut grant = Map::new();
        grant.insert("id".into(), Value::from(jsv::string(Some(id))));
        if let Some(ability) = spellcasting.get("ability") {
            grant.insert("ability".into(), ability.clone());
        }
        grant.insert("uses".into(), uses);
        grant.insert("source".into(), defined(spellcasting.get("source")).cloned().unwrap_or_else(|| Value::from("level-feat")));
        if let Some(class_key) = spellcasting.get("class_key") {
            grant.insert("class_key".into(), class_key.clone());
        }
        Value::Object(grant)
    };
    let mut grants: Vec<Value> = array(spellcasting.get("cantrips")).iter().map(|id| grant(id, Value::from("at-will"))).collect();
    if js::truthy(spellcasting.get("first_level_spell")) {
        grants.push(grant(&spellcasting["first_level_spell"], Value::from(1)));
    }
    grants
}

/// Без повторов по `JSON.stringify`, порядок первого вхождения.
fn unique_by_json(grants: Vec<Value>) -> Vec<Value> {
    let mut seen: IndexSet<String> = IndexSet::new();
    grants.into_iter().filter(|grant| seen.insert(jsv::stringify(grant))).collect()
}

fn merge_benefits(actor: Option<&Value>, benefits: Option<&Value>) -> Value {
    let mut base = prop(actor, "creationBenefits").and_then(Value::as_object).cloned().unwrap_or_default();
    let addition = benefits.filter(|value| value.is_object());
    let added = |key: &str| prop(addition, key);
    for field in ["armor_proficiencies", "weapon_proficiencies", "tool_proficiencies", "language_proficiencies", "saving_throw_proficiencies", "expertise"] {
        let merged = add_unique(base.get(field), added(field));
        base.insert(field.into(), merged);
    }
    let languages = add_unique(base.get("languages"), added("language_proficiencies"));
    base.insert("languages".into(), languages);
    let labels = add_unique(base.get("language_labels"), added("language_proficiencies"));
    base.insert("language_labels".into(), labels);
    let tool_labels = add_unique(base.get("tool_proficiency_labels"), added("tool_proficiencies"));
    base.insert("tool_proficiency_labels".into(), tool_labels);
    let mut passive = base.get("passive_skill_bonuses").and_then(Value::as_object).cloned().unwrap_or_default();
    if let Some(Value::Object(bonuses)) = added("passive_skill_bonuses") {
        for (key, value) in js::entries(bonuses) {
            let current = js::number(Some(defined(passive.get(key)).unwrap_or(&Value::from(0))));
            passive.insert(key.clone(), num(current + js::number(Some(defined(Some(value)).unwrap_or(&Value::from(0))))));
        }
    }
    if !passive.is_empty() {
        base.insert("passive_skill_bonuses".into(), Value::Object(jsv::js_ordered(passive)));
    }
    let number = |value: Option<&Value>| js::number(Some(defined(value).unwrap_or(&Value::from(0))));
    for field in ["speed_bonus", "initiative_bonus", "hit_point_maximum_bonus_per_level"] {
        let amount = number(added(field));
        if amount != 0.0 && !amount.is_nan() {
            let total = number(base.get(field)) + amount;
            base.insert(field.into(), num(total));
        }
    }
    let hit_point_bonus = number(added("extra_hit_points_per_level")) + number(added("hit_point_maximum_bonus_per_level"));
    if hit_point_bonus != 0.0 && !hit_point_bonus.is_nan() {
        let total = number(base.get("extra_hit_points_per_level")) + hit_point_bonus;
        base.insert("extra_hit_points_per_level".into(), num(total));
    }
    if is_record(added("spellcasting")) {
        base.insert("level_feat_spellcasting".into(), added("spellcasting").cloned().unwrap_or(Value::Null));
    }
    if let Some(Value::Object(addition_static)) = added("static") {
        let mut merged = base.get("level_feat_static").and_then(Value::as_object).cloned().unwrap_or_default();
        for (key, value) in addition_static {
            merged.insert(key.clone(), value.clone());
        }
        base.insert("level_feat_static".into(), Value::Object(jsv::js_ordered(merged)));
    }
    if is_str(prop(added("spellcasting"), "source"), "ritual-caster") {
        base.insert("ritual_book".into(), added("spellcasting").cloned().unwrap_or(Value::Null));
    }
    let mut grants: Vec<Value> = array(base.get("spell_grants")).to_vec();
    grants.extend(feat_spell_grants(addition));
    base.insert("spell_grants".into(), Value::Array(unique_by_json(grants)));
    Value::Object(base)
}

fn merge_feat_spell_grants(actor: Option<&Value>, benefits: Option<&Value>) -> Value {
    let mut grants: Vec<Value> = array(prop(actor, "creationSpellGrants")).to_vec();
    grants.extend(feat_spell_grants(benefits));
    Value::Array(unique_by_json(grants))
}

/// Характеристики 1–30 (отсутствующая — 10).
fn bounded_abilities(actor: Option<&Value>) -> Map<String, Value> {
    ABILITY_IDS
        .iter()
        .map(|id| {
            let score = jsv::max2(1.0, jsv::min2(30.0, jsv::number_or(jsv::path(actor, &["abilities", id]), 10.0)));
            (id.to_string(), num(score))
        })
        .collect()
}

fn score_of(abilities: &Map<String, Value>, id: &str) -> f64 {
    js::number(abilities.get(id))
}

fn apply_ability_increases(actor: Option<&Value>, benefits: Option<&Value>) -> Map<String, Value> {
    let mut abilities = bounded_abilities(actor);
    if let Some(Value::Object(increases)) = prop(benefits, "ability_increases") {
        for (id, amount) in js::entries(increases) {
            if abilities.contains_key(id) {
                let raised = jsv::min2(20.0, score_of(&abilities, id) + jsv::max2(0.0, jsv::number_or(Some(amount), 0.0)));
                abilities.insert(id.clone(), num(raised));
            }
        }
    }
    abilities
}

fn ability_score_choices_for(actor: Option<&Value>) -> Map<String, Value> {
    by_level(prop(actor, "abilityScoreIncreases").filter(|source| source.is_object()), |choices| {
        let Value::Array(choices) = choices else {
            return None;
        };
        Some(Value::Array(choices.iter().map(|choice| Value::from(jsv::string(Some(choice)))).collect()))
    })
}

fn normalize_ability_score_choices(value: Option<&Value>) -> BuildResult<Vec<String>> {
    let Some(Value::Array(items)) = value.filter(|value| matches!(value, Value::Array(items) if items.len() == 1 || items.len() == 2)) else {
        return Err(CharacterBuildValidationError::new("Улучшение характеристик должно дать +2 одной или +1 двум характеристикам", "ABILITY_SCORE_CHOICE_INVALID"));
    };
    let choices: Vec<String> = items.iter().map(|entry| text::lower(&clean(Some(entry), 12))).collect();
    if choices.iter().any(|entry| !ABILITY_IDS.contains(&entry.as_str())) {
        return Err(CharacterBuildValidationError::new("Выбрана неизвестная характеристика", "ABILITY_SCORE_CHOICE_INVALID"));
    }
    Ok(choices)
}

/// Уровень выбора: безопасное целое из списка уровней класса, не выше уровня героя.
fn checked_choice_level(raw_level: Option<&Value>, actor: Option<&Value>, message: &str) -> BuildResult<i64> {
    let level = js::number(raw_level);
    let actor_level = js::number(Some(defined(prop(actor, "level")).unwrap_or(&Value::from(1))));
    if !jsv::is_safe_integer(level) || !ability_score_choice_levels_for(actor).contains(&(level as i64)) || level > actor_level {
        return Err(CharacterBuildValidationError::new(message, "ABILITY_SCORE_LEVEL_INVALID"));
    }
    Ok(level as i64)
}

struct AbilityScores {
    level: Value,
    all: Value,
    abilities: Value,
}

fn ability_score_choice_for(command: &Value, actor: Option<&Value>) -> BuildResult<AbilityScores> {
    let raw_level = nullish(command.get("ability_score_level"), command.get("abilityScoreLevel"));
    let raw_choices = nullish(command.get("ability_score_increases"), command.get("abilityScoreIncreases"));
    let existing = ability_score_choices_for(actor);
    let level_feats = level_feats_for(actor);
    if !js::present(raw_level) && !js::present(raw_choices) {
        return Ok(AbilityScores {
            level: Value::Null,
            all: Value::Object(existing),
            abilities: defined(prop(actor, "abilities")).cloned().unwrap_or_else(|| json!({})),
        });
    }
    let level = checked_choice_level(raw_level, actor, "Улучшение характеристик недоступно на этом уровне")?;
    let choices = normalize_ability_score_choices(raw_choices)?;
    let key = level.to_string();
    if level_feats.contains_key(&key) {
        return Err(CharacterBuildValidationError::new("На этом уровне уже выбрана черта вместо улучшения характеристик", "ABILITY_SCORE_CHOICE_LOCKED"));
    }
    let choices_value = json!(choices);
    let previous = existing.get(&key).cloned();
    if previous.as_ref().is_some_and(|previous| jsv::stringify(previous) != jsv::stringify(&choices_value)) {
        return Err(CharacterBuildValidationError::new("Улучшение характеристик этого уровня уже выбрано", "ABILITY_SCORE_CHOICE_LOCKED"));
    }
    let mut all = existing;
    all.insert(key, choices_value);
    let all = jsv::js_ordered(all);
    let mut abilities = bounded_abilities(actor);
    if previous.is_none() {
        if choices.len() == 1 {
            let id = &choices[0];
            if score_of(&abilities, id) > 18.0 {
                return Err(CharacterBuildValidationError::new("Характеристика уже достигла максимума 20", "ABILITY_SCORE_MAX_REACHED"));
            }
            let raised = score_of(&abilities, id) + 2.0;
            abilities.insert(id.clone(), num(raised));
        } else {
            for id in &choices {
                if score_of(&abilities, id) >= 20.0 {
                    return Err(CharacterBuildValidationError::new("Характеристика уже достигла максимума 20", "ABILITY_SCORE_MAX_REACHED"));
                }
                let raised = score_of(&abilities, id) + 1.0;
                abilities.insert(id.clone(), num(raised));
            }
        }
    }
    Ok(AbilityScores { level: Value::from(level), all: Value::Object(all), abilities: Value::Object(abilities) })
}

struct FeatChoice {
    level: i64,
    entry: Value,
    all: Value,
    abilities: Value,
    creation_benefits: Value,
    creation_skill_proficiencies: Value,
    creation_spell_grants: Value,
}

fn ability_score_feat_for(command: &Value, actor: Option<&Value>, ruleset_id: Option<&Value>) -> BuildResult<Option<FeatChoice>> {
    let raw_level = nullish(command.get("ability_score_level"), command.get("abilityScoreLevel"));
    let raw_feat = nullish(command.get("ability_score_feat"), command.get("abilityScoreFeat"));
    let raw_asi = nullish(command.get("ability_score_increases"), command.get("abilityScoreIncreases"));
    if !js::present(raw_feat) {
        return Ok(None);
    }
    if !is_str(ruleset_id, DND_2014_RULESET_ID) {
        return Err(CharacterBuildValidationError::new("Черты PHB 2014 доступны только в редакции D&D 5e 2014", "ABILITY_SCORE_FEAT_UNAVAILABLE"));
    }
    if js::present(raw_asi) {
        return Err(CharacterBuildValidationError::new("Нельзя выбрать и улучшение характеристик, и черту на одном уровне", "ABILITY_SCORE_CHOICE_CONFLICT"));
    }
    let level = checked_choice_level(raw_level, actor, "Черта вместо улучшения характеристик недоступна на этом уровне")?;
    let key = level.to_string();
    let existing_asi = ability_score_choices_for(actor).contains_key(&key);
    let level_feats = level_feats_for(actor);
    if existing_asi || level_feats.contains_key(&key) {
        return Err(CharacterBuildValidationError::new("Выбор этого уровня уже зафиксирован", "ABILITY_SCORE_CHOICE_LOCKED"));
    }
    let Some(raw_feat) = raw_feat.filter(|value| value.is_object()) else {
        return Err(CharacterBuildValidationError::new("ability_score_feat должен быть объектом", "ABILITY_SCORE_FEAT_INVALID"));
    };
    let feat_id = text::lower(&clean(raw_feat.get("id"), 80));
    let choices = if is_record(raw_feat.get("choices")) { raw_feat["choices"].clone() } else { json!({}) };
    let resolved = resolve_character_creation_feat(Some(&Value::from(feat_id)), Some(&choices), Some(&feat_context_for(actor, &level_feats)));
    if !js::truthy(resolved.get("ok")) {
        let message = defined(resolved.get("reason")).map_or_else(|| "Выбор черты недоступен".to_string(), |reason| jsv::string(Some(reason)));
        let code = defined(resolved.get("code")).map_or_else(|| "ABILITY_SCORE_FEAT_INVALID".to_string(), |code| jsv::string(Some(code)));
        return Err(CharacterBuildValidationError { message, code });
    }
    let benefits = resolved.get("benefits");
    let mut entry = Map::new();
    if let Some(id) = jsv::path(Some(&resolved), &["feat", "id"]) {
        entry.insert("id".into(), id.clone());
    }
    if let Some(choices) = resolved.get("choices") {
        entry.insert("choices".into(), choices.clone());
    }
    if let Some(benefits) = benefits {
        entry.insert("benefits".into(), benefits.clone());
    }
    let entry = Value::Object(entry);
    let mut all = level_feats;
    all.insert(key, entry.clone());
    Ok(Some(FeatChoice {
        level,
        entry,
        all: Value::Object(jsv::js_ordered(all)),
        abilities: Value::Object(apply_ability_increases(actor, benefits)),
        creation_benefits: merge_benefits(actor, benefits),
        creation_skill_proficiencies: add_unique(prop(actor, "creationSkillProficiencies"), prop(benefits, "skill_proficiencies")),
        creation_spell_grants: merge_feat_spell_grants(actor, benefits),
    }))
}

/// Проверка команды развития или подготовки героя. Чужая команда
/// возвращается как есть; своя — в каноническом виде, с полями события.
pub fn validate_character_build_command(command: &Value, state: &Value, context: Option<&Value>) -> BuildResult<Value> {
    let command_type = command.get("command_type");
    if !CHARACTER_BUILD_COMMAND_TYPES.iter().any(|kind| is_str(command_type, kind)) {
        return Ok(command.clone());
    }
    let actor_id = clean(command.get("actor_id"), 120);
    let actor = array(state.get("players")).iter().find(|candidate| jsv::string(candidate.get("id")) == actor_id);
    let Some(actor_value) = actor else {
        return Err(CharacterBuildValidationError::new("Герой не найден", "ACTOR_NOT_FOUND"));
    };
    let actor = Some(actor_value);
    let allowed: Vec<String> = array(prop(context, "allowedActorIds")).iter().map(|id| jsv::string(Some(id))).collect();
    if !js::is_true(prop(context, "isAdmin")) && !allowed.contains(&actor_id) {
        return Err(CharacterBuildValidationError::new("Изменять подготовку может только владелец героя", "ACTOR_FORBIDDEN"));
    }
    if js::truthy(jsv::path(Some(state), &["mechanics", "combat", "active"])) {
        return Err(CharacterBuildValidationError::new("Нельзя менять развитие или подготовку героя во время боя", "CHARACTER_BUILD_DURING_COMBAT"));
    }
    let empty = json!([]);
    let ids_field = |snake: &str, camel: &str| defined(nullish(command.get(snake), command.get(camel))).unwrap_or(&empty).clone();

    if is_str(command_type, "SetCharacterChoices") {
        let subclass = clean(command.get("subclass"), 160);
        // Написание навыка приводится к канону каталога сразу на входе.
        let skills_raw = unique_ids(Some(&ids_field("class_skill_proficiencies", "classSkillProficiencies")), "class_skill_proficiencies")?;
        let class_skills: Vec<String> = skills_raw.iter().map(|id| catalog_skill_id(Some(&Value::from(id.clone())))).collect::<IndexSet<_>>().into_iter().collect();
        let selected_features = unique_ids(Some(&ids_field("selected_feature_ids", "selectedFeatureIds")), "selected_feature_ids")?;
        let mut candidate = actor_value.as_object().cloned().unwrap_or_default();
        candidate.insert("subclass".into(), Value::from(subclass.clone()));
        candidate.insert("classSkillProficiencies".into(), json!(class_skills));
        candidate.insert("selectedFeatureIds".into(), json!(selected_features));
        let candidate = Value::Object(candidate);
        let canonical_subclass = normalized_combat_subclass_for(Some(&candidate)).unwrap_or_default();
        let canonical_skills = normalized_class_skill_proficiencies(Some(&candidate));
        let canonical_features = normalized_selected_feature_ids(Some(&candidate));
        if (!subclass.is_empty() && canonical_subclass != subclass) || !same_ids(&class_skills, &canonical_skills) || !same_ids(&selected_features, &canonical_features) {
            return Err(CharacterBuildValidationError::new("Выбор подкласса, навыков или классовых особенностей недоступен для уровня героя", "CHARACTER_CHOICE_NOT_ALLOWED"));
        }
        let feat_choice = ability_score_feat_for(command, actor, state.get("ruleset_id"))?;
        let ability_scores = match &feat_choice {
            Some(feat) => AbilityScores { level: Value::from(feat.level), all: feat.all.clone(), abilities: feat.abilities.clone() },
            None => ability_score_choice_for(command, actor)?,
        };
        let mut safe = command.as_object().cloned().unwrap_or_default();
        for key in ["creation_benefits", "creation_skill_proficiencies", "creation_spell_grants", "level_feats"] {
            safe.shift_remove(key);
        }
        if feat_choice.is_none() {
            safe.shift_remove("ability_score_feat");
        }
        safe.insert("actor_id".into(), Value::from(actor_id.clone()));
        safe.insert("target_id".into(), Value::from(actor_id.clone()));
        safe.insert("target_ids".into(), json!([actor_id]));
        safe.insert("subclass".into(), Value::from(canonical_subclass));
        safe.insert("class_skill_proficiencies".into(), json!(canonical_skills));
        safe.insert("selected_feature_ids".into(), json!(canonical_features));
        safe.insert("ability_score_level".into(), ability_scores.level);
        let increases = if feat_choice.is_some() { Value::Object(ability_score_choices_for(actor)) } else { ability_scores.all };
        safe.insert("ability_score_increases".into(), increases);
        safe.insert("abilities_after".into(), ability_scores.abilities);
        match feat_choice {
            Some(feat) => {
                safe.insert("ability_score_feat".into(), feat.entry);
                safe.insert("level_feats".into(), feat.all);
                safe.insert("creation_benefits".into(), feat.creation_benefits);
                safe.insert("creation_skill_proficiencies".into(), feat.creation_skill_proficiencies);
                safe.insert("creation_spell_grants".into(), feat.creation_spell_grants);
            }
            None => {
                safe.insert("level_feats".into(), Value::Object(level_feats_for(actor)));
            }
        }
        safe.insert("visibility".into(), Value::from("party"));
        return Ok(Value::Object(safe));
    }

    let known = unique_ids(Some(&ids_field("known_spell_ids", "knownSpellIds")), "known_spell_ids")?;
    let prepared = unique_ids(Some(&ids_field("prepared_spell_ids", "preparedSpellIds")), "prepared_spell_ids")?;
    let rules = spell_selection_rules_for(actor);
    if rules.is_none() && (!known.is_empty() || !prepared.is_empty()) {
        return Err(CharacterBuildValidationError::new("У этого героя нет доступной системы заклинаний", "SPELLCASTING_NOT_AVAILABLE"));
    }
    let mut candidate = actor_value.as_object().cloned().unwrap_or_default();
    candidate.insert("knownSpellIds".into(), json!(known));
    candidate.insert("preparedSpellIds".into(), json!(prepared));
    let normalized = normalized_spell_selections_for(Some(&Value::Object(candidate)));
    let strings = |key: &str| -> Vec<String> { array(normalized.get(key)).iter().map(|id| js::s(Some(id))).collect() };
    let canonical_known = strings("knownSpellIds");
    let canonical_prepared = strings("preparedSpellIds");
    if !same_ids(&known, &canonical_known) || !same_ids(&prepared, &canonical_prepared) {
        return Err(CharacterBuildValidationError::new("Выбор содержит недоступное заклинание или превышает лимит класса и уровня", "SPELL_SELECTION_NOT_ALLOWED"));
    }
    let mut safe = command.as_object().cloned().unwrap_or_default();
    safe.insert("actor_id".into(), Value::from(actor_id.clone()));
    safe.insert("target_id".into(), Value::from(actor_id.clone()));
    safe.insert("target_ids".into(), json!([actor_id]));
    safe.insert("known_spell_ids".into(), json!(canonical_known));
    safe.insert("prepared_spell_ids".into(), json!(canonical_prepared));
    safe.insert("visibility".into(), Value::from("party"));
    Ok(Value::Object(safe))
}

/// Событие проверенной команды: `{ event_type, payload, target_ids }` или `None`.
pub fn character_build_event(command: &Value) -> Option<Value> {
    let field = |key: &str| command.get(key);
    let target_ids = json!([field("actor_id").cloned().unwrap_or(Value::Null)]);
    let fingerprint = Value::from(clean(field("request_fingerprint"), 128));
    if is_str(field("command_type"), "SetCharacterChoices") {
        let mut payload = Map::new();
        payload.insert("schema_version".into(), Value::from(2));
        for key in ["subclass", "class_skill_proficiencies", "selected_feature_ids", "ability_score_level", "ability_score_increases", "abilities_after"] {
            if let Some(value) = field(key) {
                payload.insert(key.into(), value.clone());
            }
        }
        for key in ["level_feats", "ability_score_feat", "creation_benefits", "creation_skill_proficiencies", "creation_spell_grants"] {
            if js::truthy(field(key)) {
                payload.insert(key.into(), field(key).cloned().unwrap_or(Value::Null));
            }
        }
        payload.insert("request_fingerprint".into(), fingerprint);
        return Some(json!({ "event_type": "CharacterChoicesUpdated", "payload": Value::Object(payload), "target_ids": target_ids }));
    }
    if !is_str(field("command_type"), "SetSpellSelections") {
        return None;
    }
    let mut payload = Map::new();
    for key in ["known_spell_ids", "prepared_spell_ids"] {
        if let Some(value) = field(key) {
            payload.insert(key.into(), value.clone());
        }
    }
    payload.insert("request_fingerprint".into(), fingerprint);
    Some(json!({ "event_type": "SpellSelectionsUpdated", "payload": Value::Object(payload), "target_ids": target_ids }))
}

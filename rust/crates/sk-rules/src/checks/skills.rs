//! Навыки и знания о противнике (`ENEMY_LORE_*`, `skillProficiencyForActor`). Задача Р2.
//!
//! JS: `server/rules-engine.mjs`, 709–742 (опознание противника: навык и СЛ),
//! 4911–5075 (владение навыком, временные навыки заклинаний, базовый
//! модификатор спасброска), 5475 (`persuasionCheckModifier`).
//!
//! Владение читается только из нормализованного листа; точные totals
//! стат-блока принимает лишь настоящий противник из `state.enemies` с
//! серверным провенансом 2014 (сравнение по ссылке, как `===` в JS).

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_ruleset::character_progression::{is_skill_proficient, skill_ability};

use crate::conditions::{at, at_path, nullish_chain};
use crate::core::ability_modifier;

/// `DND_2014_RULESET_ID`.
const DND_2014: &str = "dnd_5e_2014";

// --- опознание противника (709–742) ------------------------------------------

/// `DEFAULT_ENEMY_LORE_SKILL`.
pub const DEFAULT_ENEMY_LORE_SKILL: &str = "arcana";

/// `ENEMY_LORE_DIFFICULTY[category]`.
pub fn enemy_lore_difficulty(category: &str) -> Option<i64> {
    match category {
        "easy" => Some(10),
        "medium" => Some(15),
        "hard" => Some(20),
        _ => None,
    }
}

/// `actorId(actor)` для необязательного актёра.
pub(crate) fn actor_id_of(actor: Option<&Value>) -> String {
    actor.map(sk_core::game::actor_id).unwrap_or_default()
}

/// `challengeRatingValue(actor)`: `1/8`, `1/2`, `3` → число; неразобранное — 0.
pub fn challenge_rating_value(actor: Option<&Value>) -> f64 {
    let raw_value = nullish_chain(&[at_path(actor, &["provenance", "challenge_rating"]), at(actor, "challenge_rating"), at(actor, "challengeRating")]);
    let raw = sk_core::text::trim(&js::s(raw_value)).to_string();
    if raw.is_empty() {
        return 0.0;
    }
    if let Ok(Some(fraction)) = sk_core::re!(r"^(\d+)\s*\/\s*(\d+)$").captures(&raw) {
        let numerator = js::parse_number(fraction.get(1).map_or("", |found| found.as_str()));
        let denominator = js::parse_number(fraction.get(2).map_or("", |found| found.as_str()));
        return if denominator > 0.0 { numerator / denominator } else { 0.0 };
    }
    let value = js::parse_number(&raw);
    if value.is_finite() && value >= 0.0 { value } else { 0.0 }
}

/// `enemyLoreCheckFor(actor)`: `{ skill, difficulty_category, difficulty, challenge_rating }`.
pub fn enemy_lore_check_for(actor: Option<&Value>) -> Value {
    let kind = nullish_chain(&[at(actor, "creature_type"), at(actor, "creatureType"), at(actor, "monster_type"), at(actor, "monsterType"), at(actor, "kind")]);
    let kind = sk_core::text::lower(&js::s(kind));
    let skill = if sk_core::text::test(sk_core::re!(r"undead|нежит|fiend|исчад|демон|дьявол|celestial|небожит|ангел", "u"), &kind) {
        "religion"
    } else if sk_core::text::test(sk_core::re!(r"beast|звер|животн|plant|растен|ooze|слизь|тина", "u"), &kind) {
        "nature"
    } else {
        DEFAULT_ENEMY_LORE_SKILL
    };
    let challenge = challenge_rating_value(actor);
    let category = if challenge < 1.0 { "easy" } else if challenge < 5.0 { "medium" } else { "hard" };
    json!({ "skill": skill, "difficulty_category": category, "difficulty": enemy_lore_difficulty(category), "challenge_rating": js::num(challenge) })
}

// --- владение навыком (4911–5075) ---------------------------------------------

/// `canonicalSkillId(value)`: `String(value ?? '').trim().toLocaleLowerCase('en').replace(/_/g, '-')`.
pub fn canonical_skill_id(value: Option<&Value>) -> String {
    sk_core::text::lower(sk_core::text::trim(&js::s(value))).replace('_', "-")
}

fn canonical_text(text: &str) -> String {
    canonical_skill_id(Some(&Value::String(text.to_string())))
}

/// `BORROWED_KNOWLEDGE_CONDITION_PREFIX`.
pub const BORROWED_KNOWLEDGE_CONDITION_PREFIX: &str = "borrowed-knowledge:";
/// `SKILL_EMPOWERMENT_CONDITION_PREFIX`.
pub const SKILL_EMPOWERMENT_CONDITION_PREFIX: &str = "skill-empowerment:";

/// `x === 1` для числа JSON.
fn is_one(value: Option<&Value>) -> bool {
    value.and_then(Value::as_f64) == Some(1.0)
}

/// `skillFromCondition(condition, prefix)`: навык временного состояния заклинания.
pub fn skill_from_condition(condition: &Value, prefix: &str) -> Option<String> {
    let id = js::s(condition.get("id"));
    let spell_id = &prefix[..prefix.len() - 1];
    if !is_one(condition.get("skill_buff_version")) || !id.starts_with(prefix) || js::s(condition.get("spell_id")) != spell_id {
        return None;
    }
    let skill = canonical_text(&id[prefix.len()..]);
    js::truthy(skill_ability(Some(&Value::String(skill.clone()))).as_ref()).then_some(skill)
}

/// `skillConditionIsActive(state, condition)`: срок временного навыка не вышел.
pub fn skill_condition_is_active(state: &Value, condition: &Value) -> bool {
    if js::present(condition.get("expires_at_seconds")) {
        return js::number(condition.get("expires_at_seconds")) > crate::world_clock::world_time_seconds(state);
    }
    if js::present(condition.get("expires_at_minutes")) {
        return js::safe_int(condition.get("expires_at_minutes"), 0) > js::safe_int(at_path(Some(state), &["mechanics", "world_time", "elapsed_minutes"]), 0);
    }
    true
}

/// `temporarySkillConditionsFor(state, actorId, prefix)`: навыки действующих
/// временных состояний (`state` может отсутствовать — тогда их нет).
pub fn temporary_skill_conditions_for(state: Option<&Value>, actor_id: &str, prefix: &str) -> Vec<String> {
    let Some(state) = state else { return Vec::new() };
    sk_core::game::conditions(state, actor_id)
        .iter()
        .filter(|condition| skill_condition_is_active(state, condition))
        .filter_map(|condition| skill_from_condition(condition, prefix))
        .collect()
}

/// `listedSkill(values, skill)`.
pub fn listed_skill(values: Option<&Value>, skill: &str) -> bool {
    let requested = canonical_text(skill);
    match values {
        Some(Value::Array(items)) => items.iter().any(|value| canonical_skill_id(Some(value)) == requested),
        _ => false,
    }
}

/// `serverOwned2014StatBlockFor(actor, state)`: стат-блок противника 2014 с
/// серверным провенансом. `actor` должен быть ссылкой внутрь `state.enemies`.
pub fn server_owned_2014_stat_block_for<'a>(actor: Option<&'a Value>, state: Option<&Value>) -> Option<&'a Value> {
    let actor = actor?;
    let state = state?;
    let enemies = state.get("enemies").and_then(Value::as_array)?;
    if !enemies.iter().any(|candidate| std::ptr::eq(candidate, actor)) || state.get("ruleset_id").and_then(Value::as_str) != Some(DND_2014) {
        return None;
    }
    let provenance = actor.get("provenance");
    let stat_block_id = js::s(actor.get("stat_block_id"));
    if at(provenance, "kind").and_then(Value::as_str) != Some("server-owned-dnd-2014-stat-block")
        || at(provenance, "ruleset_id").and_then(Value::as_str) != Some(DND_2014)
        || js::s(at(provenance, "stat_block_id")) != stat_block_id
        || !stat_block_id.starts_with("dnd_5e_2014:monster:")
    {
        return None;
    }
    Some(actor)
}

/// `String(skillAbility(id) || 'str')`.
fn skill_ability_or_str(id: &str) -> String {
    match skill_ability(Some(&Value::String(id.to_string()))) {
        Some(value) if js::truthy(Some(&value)) => js::string(Some(&value)),
        _ => "str".into(),
    }
}

/// Карточка автора: `origin.kind === 'authored-npc'` с тем же id и профилем.
fn authored_sheet(actor: Option<&Value>) -> bool {
    at_path(actor, &["origin", "kind"]).and_then(Value::as_str) == Some("authored-npc")
        && js::s(at_path(actor, &["origin", "npc_id"])) == actor_id_of(actor)
        && js::s(at_path(actor, &["origin", "profile_id"])) == js::s(at(actor, "stat_block_id"))
}

/// `skillProficiencyForActor(actor, skill, state)`: владение навыком из листа.
pub fn skill_proficiency_for_actor(actor: Option<&Value>, skill: Option<&Value>, state: Option<&Value>) -> Value {
    let id = canonical_skill_id(skill);
    if let Some(stat_block) = server_owned_2014_stat_block_for(actor, state) {
        let skills = stat_block.get("skills").filter(|value| value.is_object());
        let skill_key = skills.and_then(Value::as_object).and_then(|map| js::keys(map).into_iter().find(|key| canonical_text(key) == id).cloned());
        let Some(skill_key) = skill_key.filter(|key| !key.is_empty()) else {
            return json!({ "skill": id, "proficient": false, "expertise": false, "multiplier": 0, "bonus": 0, "stat_block": true });
        };
        let explicit = js::number(at(skills, &skill_key));
        if crate::core::is_safe_integer_f64(explicit) {
            let ability = skill_ability_or_str(&id);
            let bonus = (explicit as i64 - ability_modifier(at_path(actor, &["abilities", &ability]))).clamp(-30, 30);
            return json!({ "skill": id, "proficient": true, "expertise": false, "multiplier": 1, "bonus": bonus, "explicit_total": explicit as i64, "stat_block": true });
        }
    }
    let underscored = id.replace('-', "_");
    if authored_sheet(actor) {
        let explicit = nullish_chain(&[
            at_path(actor, &["skillModifiers", &id]),
            at_path(actor, &["skillModifiers", &underscored]),
            at_path(actor, &["skill_modifiers", &id]),
            at_path(actor, &["skill_modifiers", &underscored]),
        ]);
        if js::is_safe_integer_number(explicit) {
            let total = js::number(explicit) as i64;
            let ability = skill_ability_or_str(&id);
            let bonus = (total - ability_modifier(at_path(actor, &["abilities", &ability]))).clamp(-30, 30);
            return json!({ "skill": id, "proficient": true, "expertise": false, "multiplier": 1, "bonus": bonus, "explicit_total": total });
        }
    }
    let sheet_entry = nullish_chain(&[at_path(actor, &["characterSheet", "skills", &id]), at_path(actor, &["characterSheet", "skills", &underscored])]).filter(|value| !value.is_null());
    let from_background = listed_skill(at(actor, "backgroundSkillProficiencies"), &id);
    let from_species = listed_skill(at(actor, "speciesSkillProficiencies"), &id);
    let expertise = [at(actor, "skillExpertiseIds"), at(actor, "expertiseSkillIds"), at(actor, "skillExpertise"), at(actor, "expertiseSkills"), at_path(actor, &["characterSheet", "skill_expertise"])]
        .into_iter()
        .any(|values| listed_skill(values, &id))
        || js::is_true(at(sheet_entry, "expertise"));
    let owner = actor_id_of(actor);
    let borrowed_knowledge = temporary_skill_conditions_for(state, &owner, BORROWED_KNOWLEDGE_CONDITION_PREFIX).iter().any(|skill| *skill == id);
    let skill_empowerment = temporary_skill_conditions_for(state, &owner, SKILL_EMPOWERMENT_CONDITION_PREFIX).iter().any(|skill| *skill == id);
    let proficient = expertise
        || from_background
        || from_species
        || js::is_true(at(sheet_entry, "proficient"))
        || is_skill_proficient(actor, Some(&Value::String(id.clone())))
        || borrowed_knowledge;
    let proficiency = js::safe_int(at(actor, "proficiency"), 0).max(0);
    let multiplier = if expertise {
        2
    } else if proficient {
        if skill_empowerment { 2 } else { 1 }
    } else {
        0
    };
    let mut result = Map::new();
    result.insert("skill".into(), Value::String(id));
    result.insert("proficient".into(), Value::Bool(proficient));
    result.insert("expertise".into(), Value::Bool(expertise));
    result.insert("multiplier".into(), Value::from(multiplier));
    result.insert("bonus".into(), Value::from(proficiency * multiplier));
    if borrowed_knowledge {
        result.insert("borrowed_knowledge".into(), Value::Bool(true));
    }
    if skill_empowerment {
        result.insert("skill_empowerment".into(), Value::Bool(true));
    }
    Value::Object(result)
}

/// `skillProficiencyBonus(actor, skill, state)`.
pub fn skill_proficiency_bonus(actor: Option<&Value>, skill: &str, state: Option<&Value>) -> i64 {
    js::safe_int(skill_proficiency_for_actor(actor, Some(&Value::String(skill.to_string())), state).get("bonus"), 0)
}

/// `savingThrowModifierForActor(actor, ability, currentModifier, state, { includeProficiency })`:
/// базовый модификатор спасброска героя и NPC.
pub fn saving_throw_modifier_for_actor(actor: Option<&Value>, ability: Option<&Value>, current_modifier: Option<&Value>, state: Option<&Value>, include_proficiency: bool) -> i64 {
    let id = sk_core::text::lower(&js::s(ability));
    let baseline = ability_modifier(at_path(actor, &["abilities", &id]));
    let supplied = if js::is_safe_integer_number(current_modifier) { js::number(current_modifier) as i64 } else { baseline };
    let owner = actor_id_of(actor);
    let is_player = state.and_then(|state| state.get("players")).and_then(Value::as_array).is_some_and(|players| players.iter().any(|candidate| sk_core::game::actor_id(candidate) == owner));
    let proficiency = if is_player && include_proficiency && super::saves::is_saving_throw_proficient(actor, Some(&Value::String(id.clone()))) {
        js::safe_int(at(actor, "proficiency"), 0)
    } else {
        0
    };
    let resolved = supplied + proficiency;
    if let Some(stat_block) = server_owned_2014_stat_block_for(actor, state) {
        if let Some(Value::Object(saves)) = stat_block.get("saving_throws") {
            if let Some(value) = saves.get(&id) {
                let explicit = js::number(Some(value));
                if crate::core::is_safe_integer_f64(explicit) {
                    return (explicit as i64 + (supplied - baseline)).clamp(-30, 30);
                }
            }
        }
    }
    let explicit = if authored_sheet(actor) { nullish_chain(&[at_path(actor, &["savingThrowModifiers", &id]), at_path(actor, &["saving_throw_modifiers", &id])]) } else { None };
    if !js::is_safe_integer_number(explicit) {
        return resolved;
    }
    let explicit = js::number(explicit) as i64;
    (baseline + explicit - ability_modifier(at_path(actor, &["abilities", &id])) + (supplied - baseline)).clamp(-30, 30)
}

/// `persuasionCheckModifier(actor)`: явный итог Убеждения или Хар + бонус, в пределах −10…20.
pub fn persuasion_check_modifier(actor: Option<&Value>) -> i64 {
    let explicit_totals = [at_path(actor, &["skills", "persuasion_modifier"]), at_path(actor, &["skillModifiers", "persuasion"]), at(actor, "persuasionModifier")];
    let explicit = explicit_totals.into_iter().find(|value| js::is_safe_integer_number(*value)).flatten();
    if js::present(explicit) {
        return js::safe_int(explicit, 0).clamp(-10, 20);
    }
    let bonuses = [at_path(actor, &["skills", "persuasion_bonus"]), at_path(actor, &["skillBonuses", "persuasion"]), at(actor, "persuasionBonus")];
    let bonus = bonuses.into_iter().find(|value| js::is_safe_integer_number(*value)).flatten();
    (ability_modifier(at_path(actor, &["abilities", "cha"])) + js::safe_int(bonus, 0)).clamp(-10, 20)
}

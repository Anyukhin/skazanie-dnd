//! Проверки и спасброски: виды, пассивное восприятие, скрытность, внезапность, ауры, свет и погода, броски спасбросков. Задача Р2.
//!
//! JS: `server/rules-engine.mjs`, 3418 (`seesInMagicalDarkness`), 11259–11367
//! (преимущество вида, везение полурослика, помеха проверок и страх, проверка
//! с состояниями, состязание в захвате), 11456–11505 (пассивное восприятие,
//! скрытность, внезапность, «Меткий удар»), 11507–11543 (модификаторы атаки от
//! состояний), 11545–11730 (ауры, владение спасброском, кровавое безумие,
//! противоядие, проверка из реестра бросков, заговор «Свет» и погода),
//! 12043–12154 (броски спасбросков, Увёртливость, Чувство опасности), 12176
//! (`savingThrowSucceeded`).
//!
//! Кости — только через [`RulesDice`]; аргументы бросков собираются объектом
//! JSON с порядком ключей места вызова JS (его пишет стенограмма). Поле,
//! которое JS кладёт как `undefined`, в объект не попадает; если же место
//! вызова JS передало ключ со значением `undefined`, а функция его
//! перезаписывает (`advantage`, `disadvantage`, `modifier`, `actorId`), ключ
//! приходит со значением [`js::UNDEFINED`] — он держит место в порядке ключей
//! стенограммы, а в кости не попадает.

use serde_json::{json, Map, Value};
use sk_core::js;

use crate::checks::skills::{saving_throw_modifier_for_actor, skill_proficiency_bonus};
use crate::conditions::{
    at, at_path, auto_failed_save_condition_for, check_advantage_condition_for, condition_save_bonus_for, includes_str, nullish_chain, save_advantage_against_condition_for,
    save_advantage_condition_for, save_disadvantage_condition_for, saving_throw_against_condition,
};
use crate::core::{ability_modifier, condition_ids_for, incapacitating_condition_for, monster_trait_for, unique_strings};
use crate::damage::item_effect_total;
use crate::dice_record::RulesDice;
use crate::pause::Halt;
use crate::tables::{character_class_key, condition_effect, condition_effects};
use crate::tactical_geometry::{actor_point, footprint_cells, tactical_cell_map, trajectory_details};
use crate::targets::distance_between_actors;

/// Метод d20 костей: `rollD20` или `rollCheck`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum D20Method {
    RollD20,
    RollCheck,
}

impl D20Method {
    fn call(self, dice: &mut dyn RulesDice, options: &Value) -> Result<Value, Halt> {
        match self {
            D20Method::RollD20 => dice.roll_d20(options),
            D20Method::RollCheck => dice.roll_check(options),
        }
    }
}

/// Поле опций броска. Значение [`js::UNDEFINED`] — ключ, который место вызова
/// JS положило как `undefined`: читается как отсутствие, но держит место в
/// порядке ключей, если функция перезапишет его (`{ ...options, modifier }`).
fn opt<'a>(options: &'a Value, key: &str) -> Option<&'a Value> {
    options.get(key).filter(|value| value.as_str() != Some(js::UNDEFINED))
}

/// Опции без полей `undefined` — так их видят кости и стенограмма JS.
fn defined(options: &Value) -> Value {
    let mut copy = options.clone();
    js::strip_undefined(&mut copy);
    copy
}

fn find<'a>(state: &'a Value, id: &str) -> Option<&'a Value> {
    sk_core::game::find_actor(state, id)
}

fn number(value: Option<&Value>) -> f64 {
    js::number(value)
}

// --- «Дьявольское зрение» (3418) ---------------------------------------------

/// `seesInMagicalDarkness(actor)`: колдун с «Дьявольским зрением».
pub fn sees_in_magical_darkness(actor: Option<&Value>) -> bool {
    let Some(actor) = actor else { return false };
    js::truthy(Some(actor))
        && character_class_key(actor).as_deref() == Some("warlock")
        && sk_ruleset::character_progression::normalized_selected_feature_ids(Some(actor)).iter().any(|id| id == "devils-sight")
}

// --- вид, везение, помеха, страх (11259–11367) -------------------------------

/// `speciesSaveAdvantageFor(state, id, { ability, condition, purpose })`.
pub fn species_save_advantage_for(state: &Value, id: &str, ability: Option<&Value>, condition: Option<&Value>, purpose: Option<&Value>) -> Option<String> {
    let actor = find(state, id);
    let mechanics = nullish_chain(&[at_path(actor, &["speciesBenefits", "mechanics"])]);
    let purpose_text = js::s(purpose);
    let (spell, against) = saving_throw_against_condition(condition, purpose);
    if includes_str(at(mechanics, "save_advantage_conditions"), &against) {
        return Some(against);
    }
    let magical = purpose_text.contains("spell") || spell.is_some();
    if magical && includes_str(at(mechanics, "magic_save_advantage_abilities"), &js::s(ability)) {
        return Some("magic".into());
    }
    None
}

/// `rollD20WithSpeciesLuck(state, diceService, actorId, options, method)`:
/// «Везение» перебрасывает выпавшую единицу.
pub fn roll_d20_with_species_luck(state: &Value, dice: &mut dyn RulesDice, actor_id: &str, options: &Value, method: D20Method) -> Result<Value, Halt> {
    let first = method.call(dice, &defined(options))?;
    let actor = find(state, actor_id);
    if number(first.get("kept")) != 1.0 || !js::is_true(at_path(actor, &["speciesBenefits", "mechanics", "reroll_natural_one"])) {
        return Ok(first);
    }
    let mut reroll_options = Map::new();
    reroll_options.insert("modifier".into(), Value::from(0));
    let purpose = match opt(options, "purpose").filter(|value| !value.is_null()) {
        Some(purpose) => js::s(Some(purpose)),
        None => "d20".into(),
    };
    reroll_options.insert("purpose".into(), Value::String(format!("{purpose}:halfling-luck")));
    reroll_options.insert("actorId".into(), Value::String(actor_id.into()));
    if let Some(visibility) = opt(options, "visibility") {
        reroll_options.insert("visibility".into(), visibility.clone());
    }
    let reroll = dice.roll_d20(&Value::Object(reroll_options))?;
    let mut faces: Vec<f64> = first.get("dice").and_then(Value::as_array).map(|items| items.iter().map(|item| number(Some(item))).collect()).unwrap_or_default();
    if let Some(index) = faces.iter().position(|face| *face == 1.0) {
        faces[index] = number(reroll.get("kept"));
    }
    let mode = first.get("mode").and_then(Value::as_str);
    let kept = match mode {
        Some("advantage") => js::max_of(faces.iter().copied()),
        Some("disadvantage") => js::min_of(faces.iter().copied()),
        _ => faces.first().copied().unwrap_or(f64::NAN),
    };
    let total = kept + number(first.get("modifier"));
    let mut result = crate::core::spread_value(Some(&first));
    result.insert("dice".into(), Value::Array(faces.iter().map(|face| js::num(*face)).collect()));
    result.insert("kept".into(), js::num(kept));
    result.insert("total".into(), js::num(total));
    if method == D20Method::RollCheck {
        result.insert("success".into(), Value::Bool(total >= number(first.get("difficulty"))));
    }
    result.insert("halfling_luck".into(), Value::Bool(true));
    insert_present(&mut result, "halfling_luck_original_roll_id", first.get("roll_id"));
    insert_present(&mut result, "halfling_luck_original_natural", first.get("kept"));
    insert_present(&mut result, "halfling_luck_reroll_roll_id", reroll.get("roll_id"));
    insert_present(&mut result, "halfling_luck_reroll_natural", reroll.get("kept"));
    Ok(Value::Object(result))
}

/// Поле со значением, которое JS положил бы как есть (`undefined` — нет поля).
fn insert_present(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value.clone());
    }
}

/// `checkDisadvantageConditionFor(state, id, ability = null)`.
pub fn check_disadvantage_condition_for(state: &Value, id: &str, ability: Option<&Value>) -> Option<String> {
    let conditions = condition_ids_for(state, id);
    let ability_text = match ability {
        None | Some(Value::Null) => "null".to_string(),
        Some(value) => js::string(Some(value)),
    };
    if sk_core::game::uses_2014(state) && js::truthy(ability) {
        let hex = sk_core::game::conditions(state, id).iter().find(|condition| js::string(condition.get("id")).starts_with("hexed:") && js::string(condition.get("spell_option")) == ability_text);
        if let Some(hex) = hex {
            return Some(js::string(hex.get("id")));
        }
    }
    let table = condition_effects();
    table.as_object().map(js::keys).unwrap_or_default().into_iter().find(|condition| {
        let Some(effect) = table.get(condition.as_str()) else { return false };
        conditions.contains(condition.as_str())
            && (condition.as_str() != "frightened" || frightened_source_in_sight(state, id))
            && (js::is_true(effect.get("checkDisadvantage")) || includes_str(effect.get("checkDisadvantageAbilities"), &ability_text))
    }).cloned()
}

/// `fearSourceInSight(state, id, sourceId)`: геометрическая линия обзора до источника страха.
pub fn fear_source_in_sight(state: &Value, id: &str, source_id: &str) -> bool {
    let (Some(from), Some(to)) = (actor_point(state, id), actor_point(state, source_id)) else { return true };
    if tactical_cell_map(state).is_empty() {
        return true;
    }
    let ends = footprint_cells(find(state, source_id), Some(to));
    footprint_cells(find(state, id), Some(from)).into_iter().any(|start| ends.iter().any(|end| !trajectory_details(state, start, *end).blocked))
}

/// `frightenedSourceInSight(state, id)`: в 2014 страх мешает, пока источник на виду.
pub fn frightened_source_in_sight(state: &Value, id: &str) -> bool {
    if !sk_core::game::uses_2014(state) {
        return true;
    }
    sk_core::game::conditions(state, id)
        .iter()
        .filter(|condition| sk_core::game::condition_id(condition) == "frightened")
        .any(|condition| condition.get("spell_id").and_then(Value::as_str) == Some("phantasmal-killer") || fear_source_in_sight(state, id, &js::s(condition.get("source_actor"))))
}

/// `rollAbilityCheckWithConditions(state, diceService, id, ability, options, method)`.
pub fn roll_ability_check_with_conditions(state: &Value, dice: &mut dyn RulesDice, id: &str, ability: Option<&Value>, options: &Value, method: D20Method) -> Result<Value, Halt> {
    if !sk_core::game::uses_2014(state) {
        return method.call(dice, &defined(options));
    }
    let mut next = crate::core::spread_value(Some(options));
    next.insert("advantage".into(), Value::Bool(js::truthy(opt(options, "advantage")) || check_advantage_condition_for(state, id, ability).is_some()));
    next.insert("disadvantage".into(), Value::Bool(js::truthy(opt(options, "disadvantage")) || check_disadvantage_condition_for(state, id, ability).is_some()));
    roll_d20_with_species_luck(state, dice, id, &Value::Object(next), method)
}

/// `contestDefenseCheck(state, actor)`: Атлетика или Акробатика, что больше.
pub fn contest_defense_check(state: &Value, actor: Option<&Value>) -> (&'static str, i64) {
    let athletics = ability_modifier(at_path(actor, &["abilities", "str"])) + skill_proficiency_bonus(actor, "athletics", Some(state));
    let acrobatics = ability_modifier(at_path(actor, &["abilities", "dex"])) + skill_proficiency_bonus(actor, "acrobatics", Some(state));
    if acrobatics > athletics { ("dex", acrobatics) } else { ("str", athletics) }
}

/// Опции броска `{ modifier, purpose, actorId, visibility }` (без `undefined`).
fn check_options(modifier: i64, purpose: String, actor_id: &str, visibility: Option<&Value>) -> Value {
    let mut options = Map::new();
    options.insert("modifier".into(), Value::from(modifier));
    options.insert("purpose".into(), Value::String(purpose));
    options.insert("actorId".into(), Value::String(actor_id.into()));
    insert_present(&mut options, "visibility", visibility);
    Value::Object(options)
}

/// `grappleContest(state, diceService, command, targetId, rolls)`: `{ attacker, defender, success[, automatic_success] }`.
pub fn grapple_contest(state: &Value, dice: &mut dyn RulesDice, command: &Value, target_id: &str, rolls: &mut Vec<Value>) -> Result<Value, Halt> {
    if sk_core::game::uses_2014(state) && incapacitating_condition_for(state, target_id).is_some() {
        return Ok(json!({ "attacker": null, "defender": null, "success": true, "automatic_success": true }));
    }
    let actor_id = js::s(command.get("actor_id"));
    let actor = find(state, &actor_id);
    let (defense_ability, defense_modifier) = contest_defense_check(state, find(state, target_id));
    let action = js::string(command.get("action_id"));
    let visibility = command.get("visibility");
    let modifier = ability_modifier(at_path(actor, &["abilities", "str"])) + skill_proficiency_bonus(actor, "athletics", Some(state));
    let attacker_options = check_options(modifier, format!("{action}:athletics"), &actor_id, visibility);
    let attacker = roll_ability_check_with_conditions(state, dice, &actor_id, Some(&Value::String("str".into())), &attacker_options, D20Method::RollD20)?;
    let defender_options = check_options(defense_modifier, format!("{action}:defense"), target_id, visibility);
    let defender = roll_ability_check_with_conditions(state, dice, target_id, Some(&Value::String(defense_ability.into())), &defender_options, D20Method::RollD20)?;
    rolls.push(attacker.clone());
    rolls.push(defender.clone());
    let success = number(attacker.get("total")) > number(defender.get("total"));
    Ok(json!({ "attacker": attacker, "defender": defender, "success": success }))
}

// --- восприятие, скрытность, внезапность, «Меткий удар» (11478–11527) --------

/// `passivePerception(actor, state)`: число JS (надбавка листа может быть дробной).
pub fn passive_perception(actor: Option<&Value>, state: Option<&Value>) -> f64 {
    let bonus = nullish_chain(&[at_path(actor, &["creationBenefits", "passive_skill_bonuses", "perception"])]);
    let bonus = if js::present(bonus) { number(bonus) } else { 0.0 };
    (10 + ability_modifier(at_path(actor, &["abilities", "wis"])) + skill_proficiency_bonus(actor, "perception", state)) as f64 + bonus
}

/// `hiddenStealthTotal(state, id)`: итог Скрытности спрятавшегося.
pub fn hidden_stealth_total(state: &Value, id: &str) -> i64 {
    let hidden = sk_core::game::conditions(state, id).iter().find(|condition| sk_core::game::condition_id(condition) == "hidden");
    let actor = find(state, id);
    let passive = 10
        + ability_modifier(at_path(actor, &["abilities", "dex"]))
        + skill_proficiency_bonus(actor, "stealth", Some(state))
        + if condition_ids_for(state, id).contains("pass-without-trace") { 10 } else { 0 };
    js::safe_int(hidden.and_then(|hidden| hidden.get("check_total")), passive)
}

/// `surprisedParticipants(state, { party, enemies })`: застигнутые врасплох.
pub fn surprised_participants(state: &Value, party: &[String], enemies: &[String]) -> Vec<String> {
    let unseen = |id: &String| {
        let conditions = condition_ids_for(state, id);
        conditions.contains("hidden") || conditions.contains("invisible")
    };
    let mut surprised = Vec::new();
    for (observers, threats) in [(party, enemies), (enemies, party)] {
        if threats.is_empty() || !threats.iter().all(unseen) {
            continue;
        }
        for observer in observers {
            let perception = passive_perception(find(state, observer), Some(state));
            if threats.iter().all(|threat| (hidden_stealth_total(state, threat) as f64) > perception) {
                surprised.push(Value::String(observer.clone()));
            }
        }
    }
    unique_strings(Some(&Value::Array(surprised)))
}

/// `activeTrueStrikeFor(state, attackerId, targetId)`.
pub fn active_true_strike_for(state: &Value, attacker_id: &str, target_id: &str) -> bool {
    let Some(condition) = sk_core::game::conditions(state, attacker_id).iter().find(|entry| entry.get("id").and_then(Value::as_str) == Some("true-strike")) else {
        return false;
    };
    if condition.get("true_strike_version").and_then(Value::as_f64) != Some(1.0) {
        return true;
    }
    let concentration = sk_core::game::mechanics(state).get("concentration").and_then(|all| all.get(attacker_id));
    js::is_true(condition.get("true_strike_armed"))
        && js::string(condition.get("target_actor_id")) == target_id
        && js::s(at(concentration, "effect_id")) == js::string(condition.get("effect_id"))
}

// --- модификаторы атаки от состояний (11529–11565) ----------------------------

/// Параметры `conditionAttackModifiers`.
#[derive(Debug, Clone, Copy)]
pub struct AttackConditionOptions<'a> {
    /// `distanceFeet` (`null` — неизвестно).
    pub distance_feet: Option<f64>,
    /// `profileKind`.
    pub profile_kind: Option<&'a str>,
    /// `meleeReachFeet` (по умолчанию 5).
    pub melee_reach_feet: Option<&'a Value>,
    /// `weaponAttack` (по умолчанию `true`).
    pub weapon_attack: bool,
}

impl Default for AttackConditionOptions<'_> {
    fn default() -> Self {
        Self { distance_feet: None, profile_kind: None, melee_reach_feet: None, weapon_attack: true }
    }
}

/// Итог `conditionAttackModifiers`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AttackConditionModifiers {
    pub advantage: Vec<String>,
    pub disadvantage: Vec<String>,
    pub automatic_critical: bool,
}

impl AttackConditionModifiers {
    pub fn to_value(&self) -> Value {
        json!({ "advantage": self.advantage, "disadvantage": self.disadvantage, "automaticCritical": self.automatic_critical })
    }
}

/// `conditionAttackModifiers(state, attackerId, targetId, options)`.
pub fn condition_attack_modifiers(state: &Value, attacker_id: &str, target_id: &str, options: AttackConditionOptions<'_>) -> AttackConditionModifiers {
    let attacker_conditions = condition_ids_for(state, attacker_id);
    let target_conditions = condition_ids_for(state, target_id);
    let reach = js::safe_int(Some(options.melee_reach_feet.unwrap_or(&Value::from(5))), 5).max(5);
    let condition_reach = if sk_core::game::uses_2014(state) { 5 } else { reach } as f64;
    let within_reach = options.distance_feet.is_some_and(|distance| distance <= condition_reach);
    let beyond_reach = options.distance_feet.is_some_and(|distance| distance > condition_reach);
    let ranged = options.profile_kind == Some("ranged");
    let mut result = AttackConditionModifiers::default();
    let devils_sight = sees_in_magical_darkness(find(state, attacker_id));
    let flag = |effect: Option<&Value>, key: &str| js::truthy(effect.and_then(|effect| effect.get(key)));
    for condition in &attacker_conditions {
        let effect = condition_effect(condition);
        if flag(effect, "attackAdvantage") {
            result.advantage.push(format!("attacker:{condition}"));
        }
        if condition == "magical-darkness" && devils_sight {
            continue;
        }
        if flag(effect, "attackDisadvantage") && (condition != "frightened" || frightened_source_in_sight(state, attacker_id)) {
            result.disadvantage.push(format!("attacker:{condition}"));
        }
        if flag(effect, "attackDisadvantageAgainstSource")
            && sk_core::game::conditions(state, attacker_id).iter().any(|entry| entry.get("id").and_then(Value::as_str) == Some(condition.as_str()) && js::s(entry.get("source_actor")) == target_id)
        {
            result.disadvantage.push(format!("attacker:{condition}"));
        }
    }
    for condition in &target_conditions {
        let effect = condition_effect(condition);
        if flag(effect, "grantsAttackAdvantage") {
            result.advantage.push(format!("target:{condition}"));
        }
        if condition == "magical-darkness" && devils_sight {
            continue;
        }
        if flag(effect, "grantsAttackDisadvantage") {
            result.disadvantage.push(format!("target:{condition}"));
        }
        if flag(effect, "grantsRangedWeaponAttackDisadvantage") && options.weapon_attack && ranged {
            result.disadvantage.push(format!("target:{condition}"));
        }
    }
    if target_conditions.contains("prone") {
        if within_reach {
            result.advantage.push("target:prone".into());
        }
        if beyond_reach {
            result.disadvantage.push("target:prone".into());
        }
    }
    result.automatic_critical = (sk_core::game::uses_2014(state) || !ranged)
        && within_reach
        && target_conditions.iter().any(|condition| js::is_true(condition_effect(condition).and_then(|effect| effect.get("autoCriticalInReach"))));
    result
}

// --- ауры (11567–11632) ---------------------------------------------------------

/// Источник «Ауры жизни».
#[derive(Debug, Clone, PartialEq)]
pub struct AuraOfLife {
    pub source_id: String,
    pub effect_id: Value,
}

impl AuraOfLife {
    pub fn to_value(&self) -> Value {
        json!({ "source_id": self.source_id, "effect_id": self.effect_id })
    }
}

/// `activeAuraOfLifeSource(state, targetId)`.
pub fn active_aura_of_life_source(state: &Value, target_id: &str) -> Option<AuraOfLife> {
    find(state, target_id)?;
    let target_is_enemy = sk_core::game::is_enemy_actor(state, target_id);
    for source in sk_core::game::list_actors(state) {
        let source_id = sk_core::game::actor_id(source);
        if sk_core::game::is_enemy_actor(state, &source_id) != target_is_enemy || !sk_core::game::is_living_actor(source) {
            continue;
        }
        let Some(aura) = sk_core::game::conditions(state, &source_id).iter().find(|condition| sk_core::game::condition_id(condition) == "aura-of-life") else { continue };
        let ids = condition_ids_for(state, &source_id);
        if ids.contains("unconscious") || ids.contains("incapacitated") || ids.contains("dead") {
            continue;
        }
        let concentration = sk_core::game::mechanics(state).get("concentration").and_then(|all| all.get(&source_id));
        if !js::truthy(concentration) || js::s(at(concentration, "effect_id")) != js::s(aura.get("effect_id")) {
            continue;
        }
        let distance = if source_id == target_id { Some(0.0) } else { distance_between_actors(state, &source_id, target_id) };
        if distance.is_some_and(|distance| distance <= 30.0) {
            return Some(AuraOfLife { source_id, effect_id: aura.get("effect_id").filter(|value| !value.is_null()).cloned().unwrap_or(Value::Null) });
        }
    }
    None
}

/// «Аура защиты» паладина: `{ source_id, bonus, radius_feet }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuraOfProtection {
    pub source_id: String,
    pub bonus: i64,
    pub radius_feet: i64,
}

impl AuraOfProtection {
    pub fn to_value(&self) -> Value {
        json!({ "source_id": self.source_id, "bonus": self.bonus, "radius_feet": self.radius_feet })
    }
}

/// `activeAuraOfProtection(state, targetId)`: сильнейшая аура паладина в 10 футах.
pub fn active_aura_of_protection(state: &Value, target_id: &str) -> Option<AuraOfProtection> {
    find(state, target_id)?;
    let target_is_enemy = sk_core::game::is_enemy_actor(state, target_id);
    let mut candidates = Vec::new();
    for source in sk_core::game::list_actors(state) {
        let source_id = sk_core::game::actor_id(source);
        if character_class_key(source).as_deref() != Some("paladin") || js::safe_int(source.get("level"), 1) < 6 {
            continue;
        }
        if sk_core::game::is_enemy_actor(state, &source_id) != target_is_enemy || !sk_core::game::is_living_actor(source) {
            continue;
        }
        let ids = condition_ids_for(state, &source_id);
        let disabled = if sk_core::game::uses_2014(state) {
            ids.contains("unconscious") || ids.contains("dead")
        } else {
            ["unconscious", "incapacitated", "stunned", "paralyzed", "dead"].iter().any(|condition| ids.contains(*condition))
        };
        if disabled {
            continue;
        }
        let distance = if source_id == target_id { Some(0.0) } else { distance_between_actors(state, &source_id, target_id) };
        if !distance.is_some_and(|distance| distance <= 10.0) {
            continue;
        }
        candidates.push(AuraOfProtection { bonus: ability_modifier(at_path(Some(source), &["abilities", "cha"])).max(1), source_id, radius_feet: 10 });
    }
    candidates.sort_by(|left, right| right.bonus.cmp(&left.bonus).then_with(|| sk_core::text::locale_compare(&left.source_id, &right.source_id)));
    candidates.into_iter().next()
}

/// Итог `savingThrowModifierWithAura`.
#[derive(Debug, Clone, PartialEq)]
pub struct AuraSave {
    pub modifier: f64,
    pub aura: Option<AuraOfProtection>,
    pub item_saving_throw_bonus: f64,
}

/// `savingThrowModifierWithAura(state, targetId, baseModifier)`.
pub fn saving_throw_modifier_with_aura(state: &Value, target_id: &str, base_modifier: Option<&Value>) -> Result<AuraSave, Halt> {
    let aura = active_aura_of_protection(state, target_id);
    let item = item_effect_total(find(state, target_id), "saving_throw_bonus")?;
    let modifier = js::safe_int(base_modifier, 0) as f64 + aura.as_ref().map_or(0, |aura| aura.bonus) as f64 + item;
    Ok(AuraSave { modifier, aura, item_saving_throw_bonus: item })
}

/// `auraOfProtectionPayload(aura)`.
pub fn aura_of_protection_payload(aura: Option<&AuraOfProtection>) -> Map<String, Value> {
    let mut payload = Map::new();
    if let Some(aura) = aura {
        payload.insert("aura_of_protection_source".into(), Value::String(aura.source_id.clone()));
        payload.insert("aura_of_protection_bonus".into(), Value::from(aura.bonus));
        payload.insert("aura_of_protection_radius_feet".into(), Value::from(aura.radius_feet));
    }
    payload
}

/// `itemSavingThrowPayload(bonus)`.
pub fn item_saving_throw_payload(bonus: f64) -> Map<String, Value> {
    let mut payload = Map::new();
    if bonus > 0.0 {
        payload.insert("item_saving_throw_bonus".into(), js::num(bonus));
    }
    payload
}

// --- владение спасброском, кровавое безумие, противоядие (11634–11670) --------

/// `CLASS_SAVING_THROW_PROFICIENCIES[classKey]`.
pub fn class_saving_throw_proficiencies(class_key: &str) -> &'static [&'static str] {
    match class_key {
        "barbarian" | "fighter" => &["str", "con"],
        "bard" => &["dex", "cha"],
        "cleric" | "paladin" | "warlock" => &["wis", "cha"],
        "druid" | "wizard" => &["int", "wis"],
        "monk" | "ranger" => &["str", "dex"],
        "rogue" => &["dex", "int"],
        "sorcerer" => &["con", "cha"],
        _ => &[],
    }
}

/// `isSavingThrowProficient(actor, ability)`.
pub fn is_saving_throw_proficient(actor: Option<&Value>, ability: Option<&Value>) -> bool {
    let ability = sk_core::text::lower(&js::s(ability));
    if includes_str(at_path(actor, &["creationBenefits", "saving_throw_proficiencies"]), &ability) {
        return true;
    }
    let explicit = [at(actor, "savingThrowProficiencies"), at(actor, "saving_throw_proficiencies"), at(actor, "saveProficiencies")].into_iter().flatten().find(|value| value.is_array());
    if let Some(Value::Array(list)) = explicit {
        return list.iter().any(|entry| sk_core::text::lower(&js::string(Some(entry))) == ability);
    }
    let class_key = actor.and_then(character_class_key).unwrap_or_default();
    class_saving_throw_proficiencies(&class_key).contains(&ability.as_str())
}

/// `bloodiedFrenzySaveAdvantage(state, targetId)`.
pub fn bloodied_frenzy_save_advantage(state: &Value, target_id: &str) -> bool {
    let actor = find(state, target_id);
    let Some(found) = monster_trait_for(actor, "bloodied-frenzy") else { return false };
    let hp = actor.map(sk_core::game::actor_hp).unwrap_or(0);
    js::truthy(Some(found)) && !js::is_false(found.get("saving_throws")) && hp * 2 <= crate::core::actor_max_hp(actor).max(1)
}

/// `activeAntitoxinSaveAdvantage(state, targetId, conditionContext)`: `{ expires_at_minutes }`.
pub fn active_antitoxin_save_advantage(state: &Value, target_id: &str, condition_context: Option<&Value>) -> Option<i64> {
    if sk_core::text::lower(&js::s(condition_context)) != "poisoned" {
        return None;
    }
    let elapsed = js::safe_int(at_path(Some(state), &["mechanics", "world_time", "elapsed_minutes"]), 0).max(0);
    let effect = sk_core::game::conditions(state, target_id)
        .iter()
        .find(|condition| sk_core::game::condition_id(condition) == "antitoxin" && js::safe_int(condition.get("expires_at_minutes"), -1) > elapsed)?;
    Some(js::safe_int(effect.get("expires_at_minutes"), elapsed))
}

// --- проверка из реестра бросков (11680–11710) ---------------------------------

/// `checkRollFromVerified(verified, options)`: d20-проверка из броска игрока;
/// `options` — объект JS (`modifier`, `difficulty`, `purpose`, `actorId`,
/// `advantage`, `disadvantage`, `visibility`; отсутствие — значение по умолчанию).
pub fn check_roll_from_verified(verified: Option<&Value>, options: &Value) -> Option<Value> {
    let option = |key: &str| opt(options, key);
    let faces: Vec<i64> = match at(verified, "dice") {
        Some(Value::Array(items)) => items.iter().map(|value| js::safe_int(Some(value), 0)).filter(|value| (1..=20).contains(value)).collect(),
        _ => Vec::new(),
    };
    if faces.is_empty() {
        return None;
    }
    let advantage = js::truthy(option("advantage"));
    let disadvantage = js::truthy(option("disadvantage"));
    let mode = if advantage && !disadvantage {
        "advantage"
    } else if disadvantage && !advantage {
        "disadvantage"
    } else {
        "normal"
    };
    if mode != "normal" && faces.len() < 2 {
        return None;
    }
    let kept = match mode {
        "advantage" => faces.iter().copied().max().unwrap_or(0),
        "disadvantage" => faces.iter().copied().min().unwrap_or(0),
        _ => faces[0],
    };
    let modifier = match option("modifier") {
        None => 0,
        value => js::safe_int(value, 0),
    };
    let difficulty = match option("difficulty") {
        None => 10,
        value => js::safe_int(value, 10),
    };
    let total = kept + modifier;
    let purpose = match option("purpose") {
        None => "check".to_string(),
        Some(value) if js::truthy(Some(value)) => js::string(Some(value)),
        Some(_) => "check".to_string(),
    };
    let actor = match option("actorId") {
        None | Some(Value::Null) => Value::Null,
        Some(value) => Value::String(crate::core::slice_utf16(&js::string(Some(value)), 120)),
    };
    let visibility = match option("visibility").and_then(Value::as_str) {
        Some(value @ ("private" | "party")) => value.to_string(),
        _ => "public".to_string(),
    };
    let expression = format!("{}d20{}", faces.len(), crate::core::signed(modifier));
    Some(json!({
        "roll_id": js::s(at(verified, "roll_id")),
        "expression": expression,
        "dice": faces,
        "kept": kept,
        "mode": mode,
        "modifier": modifier,
        "total": total,
        "difficulty": difficulty,
        "success": total >= difficulty,
        "purpose": crate::core::slice_utf16(&purpose, 80),
        "actor_id": actor,
        "visibility": visibility,
        "created_at": at(verified, "created_at").filter(|value| !value.is_null()).cloned().unwrap_or(Value::Null),
        "player_rolled": true,
    }))
}

// --- заговор «Свет» и погода (11723–11752) ---------------------------------------

/// `LIGHT_CONDITION`.
pub const LIGHT_CONDITION: &str = "light";
/// `NIGHT_PERCEPTION_EFFECT_ID`.
pub const NIGHT_PERCEPTION_EFFECT_ID: &str = "night-perception";

/// `lightBrightRadiusFeet()`: радиус яркого света из карточки заговора.
pub fn light_bright_radius_feet() -> i64 {
    let spell = sk_combat_content::combat_spells::canonical_combat_spell_for(Some(&Value::String(LIGHT_CONDITION.into())), None);
    js::safe_int(spell.as_ref().and_then(|spell| spell.get("radius")), 0).max(0)
}

/// `litByLightCantrip(state, actorId)`: стоит ли актёр в ярком свету заговора.
///
/// Как в JS, `distanceBetweenActors` без позиции (`null`) сравнивается как 0:
/// носитель вне поля освещает всех.
pub fn lit_by_light_cantrip(state: &Value, actor_id: &str) -> bool {
    if actor_id.is_empty() {
        return false;
    }
    if condition_ids_for(state, actor_id).contains(LIGHT_CONDITION) {
        return true;
    }
    let radius = light_bright_radius_feet();
    if radius <= 0 {
        return false;
    }
    sk_core::game::list_actors(state).into_iter().any(|candidate| {
        let bearer = sk_core::game::actor_id(candidate);
        if bearer == actor_id || !condition_ids_for(state, &bearer).contains(LIGHT_CONDITION) {
            return false;
        }
        distance_between_actors(state, actor_id, &bearer).unwrap_or(0.0) <= radius as f64
    })
}

/// `weatherCheckSwingFor(state, skill, actorId)`: погода проверки; ночную
/// помеху Восприятию снимает «Свет».
pub fn weather_check_swing_for(state: &Value, skill: Option<&Value>, actor_id: Option<&Value>) -> Option<Value> {
    let swing = sk_world_time::weather::weather_check_swing(state, skill, actor_id)?;
    if swing.get("effect_id").and_then(Value::as_str) == Some(NIGHT_PERCEPTION_EFFECT_ID) && lit_by_light_cantrip(state, &js::s(actor_id)) {
        return None;
    }
    Some(swing)
}

// --- броски спасбросков (12065–12129) ----------------------------------------------

/// `const { avoid_or_end_condition, ...diceOptions } = options`.
fn split_condition_context(options: &Value) -> (Option<&Value>, Map<String, Value>) {
    let mut dice_options = crate::core::spread_value(Some(options));
    dice_options.shift_remove("avoid_or_end_condition");
    (opt(options, "avoid_or_end_condition"), dice_options)
}

/// Модификатор спасброска как число JSON (`auraProtection.modifier`).
fn modifier_value(modifier: f64) -> Value {
    js::num(modifier)
}

/// `rollSavingThrowD20(state, diceService, targetId, options)`: единая воронка
/// спасбросков d20 — автопровал, преимущество и помеха состояний, ауры, вид.
pub fn roll_saving_throw_d20(state: &Value, dice: &mut dyn RulesDice, target_id: &str, options: &Value) -> Result<Value, Halt> {
    let (condition_context, mut dice_options) = split_condition_context(options);
    let ability = opt(options, "ability");
    let actor = find(state, target_id);
    let condition_save_bonus = condition_save_bonus_for(state, target_id, ability);
    let authored = saving_throw_modifier_for_actor(actor, ability, opt(options, "modifier"), Some(state), true) + condition_save_bonus;
    let aura = saving_throw_modifier_with_aura(state, target_id, Some(&Value::from(authored)))?;
    let auto_failed = auto_failed_save_condition_for(state, target_id, ability);
    let advantage_condition = save_advantage_condition_for(state, target_id, ability).or_else(|| save_advantage_against_condition_for(state, target_id, condition_context, opt(options, "purpose")));
    let disadvantage_condition = save_disadvantage_condition_for(state, target_id, ability);
    let bloodied_frenzy = bloodied_frenzy_save_advantage(state, target_id);
    let antitoxin = active_antitoxin_save_advantage(state, target_id, condition_context);
    // Пустая строка (`''.includes`) у JS ложна: преимущества нет.
    let species = species_save_advantage_for(state, target_id, ability, condition_context, opt(options, "purpose")).filter(|value| !value.is_empty());
    let danger_sense = danger_sense_advantage(state, target_id, ability);
    let advantage = js::is_true(opt(options, "advantage")) || advantage_condition.is_some() || bloodied_frenzy || antitoxin.is_some() || species.is_some() || danger_sense;
    dice_options.insert("advantage".into(), Value::Bool(advantage));
    dice_options.insert("disadvantage".into(), Value::Bool(js::is_true(opt(options, "disadvantage")) || disadvantage_condition.is_some()));
    dice_options.insert("modifier".into(), modifier_value(aura.modifier));
    dice_options.insert("actorId".into(), Value::String(target_id.into()));
    let roll = roll_d20_with_species_luck(state, dice, target_id, &Value::Object(dice_options), D20Method::RollD20)?;
    let mut result = crate::core::spread_value(Some(&roll));
    result.extend(aura_of_protection_payload(aura.aura.as_ref()));
    result.extend(item_saving_throw_payload(aura.item_saving_throw_bonus));
    if let Some(condition) = &advantage_condition {
        result.insert("save_advantage_condition".into(), Value::String(condition.clone()));
    }
    if condition_save_bonus != 0 {
        result.insert("condition_save_bonus".into(), Value::from(condition_save_bonus));
    }
    if bloodied_frenzy {
        result.insert("bloodied_frenzy".into(), Value::Bool(true));
    }
    if let Some(expires) = antitoxin {
        result.insert("antitoxin_advantage".into(), Value::Bool(true));
        result.insert("antitoxin_expires_at_minutes".into(), Value::from(expires));
    }
    if let Some(species) = species {
        result.insert("species_save_advantage".into(), Value::String(species));
    }
    if danger_sense {
        result.insert("danger_sense".into(), Value::Bool(true));
    }
    if let Some(condition) = disadvantage_condition {
        result.insert("save_disadvantage_condition".into(), Value::String(condition));
    }
    if let Some(condition) = auto_failed {
        result.insert("auto_failed".into(), Value::Bool(true));
        result.insert("auto_failed_condition".into(), Value::String(condition));
    }
    Ok(Value::Object(result))
}

/// `rollSavingThrowCheck(state, diceService, targetId, options)`: спасбросок
/// проверкой с СЛ (`rollCheck`); автопровал ставит `success: false`.
pub fn roll_saving_throw_check(state: &Value, dice: &mut dyn RulesDice, target_id: &str, options: &Value) -> Result<Value, Halt> {
    let (condition_context, mut dice_options) = split_condition_context(options);
    let ability = opt(options, "ability");
    let actor = find(state, target_id);
    let authored = saving_throw_modifier_for_actor(actor, ability, opt(options, "modifier"), Some(state), true);
    let aura = saving_throw_modifier_with_aura(state, target_id, Some(&Value::from(authored)))?;
    let auto_failed = auto_failed_save_condition_for(state, target_id, ability);
    let bloodied_frenzy = bloodied_frenzy_save_advantage(state, target_id);
    let antitoxin = active_antitoxin_save_advantage(state, target_id, condition_context);
    // Пустая строка (`''.includes`) у JS ложна: преимущества нет.
    let species = species_save_advantage_for(state, target_id, ability, condition_context, opt(options, "purpose")).filter(|value| !value.is_empty());
    let advantage = js::is_true(opt(options, "advantage")) || bloodied_frenzy || antitoxin.is_some() || species.is_some();
    dice_options.insert("advantage".into(), Value::Bool(advantage));
    dice_options.insert("modifier".into(), modifier_value(aura.modifier));
    dice_options.insert("actorId".into(), Value::String(target_id.into()));
    let roll = roll_d20_with_species_luck(state, dice, target_id, &Value::Object(dice_options), D20Method::RollCheck)?;
    let mut result = crate::core::spread_value(Some(&roll));
    result.extend(aura_of_protection_payload(aura.aura.as_ref()));
    result.extend(item_saving_throw_payload(aura.item_saving_throw_bonus));
    if bloodied_frenzy {
        result.insert("bloodied_frenzy".into(), Value::Bool(true));
    }
    if let Some(expires) = antitoxin {
        result.insert("antitoxin_advantage".into(), Value::Bool(true));
        result.insert("antitoxin_expires_at_minutes".into(), Value::from(expires));
    }
    if let Some(species) = species {
        result.insert("species_save_advantage".into(), Value::String(species));
    }
    if let Some(condition) = auto_failed {
        result.insert("success".into(), Value::Bool(false));
        result.insert("auto_failed".into(), Value::Bool(true));
        result.insert("auto_failed_condition".into(), Value::String(condition));
    }
    Ok(Value::Object(result))
}

// --- Увёртливость, Чувство опасности, итог спасброска (12138–12198) ---------------

/// `hasEvasion(state, targetId)`.
pub fn has_evasion(state: &Value, target_id: &str) -> bool {
    let Some(actor) = find(state, target_id) else { return false };
    let class_key = character_class_key(actor).unwrap_or_default();
    let feature = !sk_core::game::is_enemy_actor(state, target_id) && ["rogue", "monk"].contains(&class_key.as_str()) && js::safe_int(actor.get("level"), 1) >= 7;
    if !feature && monster_trait_for(Some(actor), "evasion").is_none() {
        return false;
    }
    let ids = condition_ids_for(state, target_id);
    !["incapacitated", "paralyzed", "stunned", "unconscious", "petrified"].iter().any(|condition| ids.contains(*condition))
}

/// `savedDamageAmount(state, targetId, { ability, saved, halfOnSave, total })`.
pub fn saved_damage_amount(state: &Value, target_id: &str, ability: Option<&Value>, saved: bool, half_on_save: bool, total: Option<&Value>) -> i64 {
    let amount = js::safe_int(total, 0).max(0);
    if !half_on_save {
        return if saved { 0 } else { amount };
    }
    if js::string(ability) == "dex" && has_evasion(state, target_id) {
        return if saved { 0 } else { amount.div_euclid(2) };
    }
    if saved { amount.div_euclid(2) } else { amount }
}

/// `dangerSenseAdvantage(state, targetId, ability)`.
pub fn danger_sense_advantage(state: &Value, target_id: &str, ability: Option<&Value>) -> bool {
    if js::string(ability) != "dex" {
        return false;
    }
    let Some(actor) = find(state, target_id) else { return false };
    if sk_core::game::is_enemy_actor(state, target_id) || character_class_key(actor).as_deref() != Some("barbarian") || js::safe_int(actor.get("level"), 1) < 2 {
        return false;
    }
    let ids = condition_ids_for(state, target_id);
    !["blinded", "deafened", "incapacitated", "paralyzed", "stunned", "unconscious", "petrified"].iter().any(|condition| ids.contains(*condition))
}

/// `savingThrowSucceeded(save, difficulty)`: принудительный провал не теряется.
pub fn saving_throw_succeeded(save: Option<&Value>, difficulty: f64) -> bool {
    !js::is_true(at(save, "auto_failed")) && js::safe_int(at(save, "total"), 0) as f64 >= difficulty
}

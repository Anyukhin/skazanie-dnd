//! Ячейки и кости заклинаний: выбор ячейки, усиление, лучи, концентрация,
//! бонусное заклинание. Задача Р5.
//!
//! JS: `server/rules-engine.mjs` — `creatureTypeFor`, `understandsSpellLanguage`
//! (2978–2990), `sculptSpellsLimit` (3410), `chooseSpellSlot` и кости усиления
//! (9816–9907), `reactionSlotChoice`, `withSpellOptionOverrides`,
//! `conditionsForSlotLevel`, `delayedSpellDamageExpression` (10481–10535),
//! `concentrationSaveAdvantageFor` (10580), `lifeDomainCaster` (10802),
//! `assertBonusActionSpellAllowed` (10812–10829), лучи и снаряды (11051–11080).

use serde_json::{Map, Value};
use sk_core::js;

use crate::core::{ability_modifier, resource_pool, spread_value, Pool};
use crate::pause::{rule, Halt};

fn at<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|value| value.as_object()).and_then(|map| map.get(key))
}

/// `spell.level` целым (каталог всегда задаёт круг числом).
pub fn spell_level(spell: &Value) -> i64 {
    js::safe_int(spell.get("level"), 0)
}

/// `safeInteger(value, spell.level)`.
fn level_or_spell(value: Option<&Value>, spell: &Value) -> i64 {
    js::safe_int(value, spell_level(spell))
}

/// Выбранная ячейка (`{ resource, level, pool }`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpellSlot {
    pub resource: String,
    pub level: i64,
    pub pool: Pool,
}

impl SpellSlot {
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("resource".into(), Value::String(self.resource.clone()));
        map.insert("level".into(), Value::from(self.level));
        map.insert("pool".into(), self.pool.to_value());
        Value::Object(map)
    }
}

/// `creatureTypeFor(actor)`.
pub fn creature_type_for(actor: Option<&Value>) -> String {
    let raw = crate::core::coalesce(&[at(actor, "creature_type"), at(actor, "creatureType"), at(actor, "monster_type"), at(actor, "monsterType")]);
    let value = sk_core::text::lower(&js::s(raw));
    if sk_core::text::test(sk_core::re!(r"construct|конструкт", "u"), &value) {
        return "construct".into();
    }
    if sk_core::text::test(sk_core::re!(r"undead|нежит", "u"), &value) {
        return "undead".into();
    }
    if sk_core::text::test(sk_core::re!(r"humanoid|гуманоид", "u"), &value) || (value.is_empty() && (js::truthy(at(actor, "character")) || js::truthy(at(actor, "characterClass")))) {
        return "humanoid".into();
    }
    value
}

/// `understandsSpellLanguage(actor)`.
pub fn understands_spell_language(actor: Option<&Value>) -> bool {
    if js::is_false(at(actor, "understands_language")) || js::is_false(at(actor, "understandsLanguage")) {
        return false;
    }
    let conditions = at(actor, "conditions");
    let listed = match conditions {
        None | Some(Value::Null) => false,
        Some(Value::Array(items)) => items.iter().any(|condition| sk_core::game::condition_id(condition) == "cannot-understand-language"),
        // `(x ?? []).some` у не-массива — TypeError в JS; лист героя его не держит.
        Some(_) => false,
    };
    !listed
}

/// `sculptSpellsLimit(actor, spell, slotLevel)`: сколько существ волшебник
/// школы Воплощения выводит из-под своей области.
pub fn sculpt_spells_limit(actor: Option<&Value>, spell: &Value, slot_level: Option<&Value>) -> i64 {
    let Some(actor_value) = actor.filter(|actor| js::truthy(Some(actor))) else { return 0 };
    if crate::tables::character_class_key(actor_value).as_deref() != Some("wizard") || js::safe_int(actor_value.get("level"), 1) < 2 {
        return 0;
    }
    let subclass = sk_combat_content::combat_actions::normalized_combat_subclass_for(actor).unwrap_or_default();
    if !sk_core::text::test(sk_core::re!(r"воплощ|evocation", "iu"), &subclass) {
        return 0;
    }
    if !sk_core::text::test(sk_core::re!(r"воплощ|evocation", "iu"), &js::s(spell.get("school"))) {
        return 0;
    }
    1 + js::safe_int(spell.get("level"), 0).max(level_or_spell(slot_level, spell))
}

fn invalid_resource(message: &str) -> Halt {
    rule(message, "INVALID_CASTING_RESOURCE")
}

/// `{ ...spell, slotResource, fallbackSlotResource: null }`.
fn with_slot_resource(spell: &Value, resource: &Value) -> Value {
    let mut map = spread_value(Some(spell));
    map.insert("slotResource".into(), resource.clone());
    map.insert("fallbackSlotResource".into(), Value::Null);
    Value::Object(map)
}

/// `chooseSpellSlot(state, actorId, spell, requestedLevel, castingResource = null)`.
///
/// `requested_level`: `None` — `undefined`, `Some(Null)` — `null`;
/// `casting_resource`: `None` и `Some(Null)` — источник не выбран.
pub fn choose_spell_slot(state: &Value, actor_id: &str, spell: Option<&Value>, requested_level: Option<&Value>, casting_resource: Option<&Value>) -> Result<Option<SpellSlot>, Halt> {
    let Some(spell) = spell.filter(|spell| js::truthy(Some(spell))) else { return Ok(None) };
    let slot_resource = spell.get("slotResource");
    if spell.get("level").and_then(Value::as_f64) == Some(0.0) || !js::truthy(slot_resource) {
        return Ok(None);
    }
    if let Some(casting) = casting_resource.filter(|value| !value.is_null()) {
        let Some(resource) = casting.as_str().filter(|text| sk_core::text::test(sk_core::re!(r"^[a-z0-9_:-]{1,120}$", "u"), text)) else {
            return Err(invalid_resource("Некорректный источник применения заклинания"));
        };
        let class_level = sk_core::text::capture(sk_core::re!(r"^spell_slots_([1-6])$", "u"), resource, 1);
        let fallback = spell.get("fallbackSlotResource");
        let class_allowed = [slot_resource, fallback].into_iter().any(|value| sk_core::text::test(sk_core::re!(r"^spell_slots_[1-6]$", "u"), &js::s(value)));
        let allowed = if class_level.is_some() { class_allowed } else { slot_resource.and_then(Value::as_str) == Some(resource) || fallback.and_then(Value::as_str) == Some(resource) };
        if !allowed || resource.is_empty() {
            return Err(invalid_resource("Этот источник недоступен для заклинания"));
        }
        let class_number = class_level.as_deref().map(js::parse_number);
        if let (Some(level), Some(requested)) = (class_number, requested_level.filter(|value| !value.is_null())) {
            if js::number(Some(requested)) != level {
                return Err(invalid_resource("Выбранный источник не совпадает с кругом ячейки"));
            }
        }
        let next = with_slot_resource(spell, casting);
        let next_requested = class_number.map(js::num);
        return choose_spell_slot(state, actor_id, Some(&next), next_requested.as_ref().or(requested_level), None);
    }
    let explicit = requested_level.is_some_and(|value| !value.is_null());
    let requested = if explicit { js::number(requested_level) } else { f64::NAN };
    let level = spell_level(spell);
    let reject = || rule(format!("Для заклинания нужен целый круг ячейки от {} до 6", js::f64_string(js::number(spell.get("level")))), "INVALID_SPELL_SLOT_LEVEL");
    let require_fixed = |fixed: f64| -> Result<(), Halt> {
        if !explicit {
            return Ok(());
        }
        if !crate::core::is_safe_integer_f64(requested) || requested != fixed {
            return Err(reject());
        }
        Ok(())
    };
    let slot_name = js::string(slot_resource);
    if slot_name.starts_with("species_spell_") {
        let pool = resource_pool(state, actor_id, &slot_name, 0);
        let actor = sk_core::game::find_actor(state, actor_id);
        let fixed = match sk_combat_content::combat_spells::fixed_spell_slot_level_for(actor, Some(spell)) {
            Some(value) if !value.is_null() => js::number(Some(&value)),
            _ => level.max(js::safe_int(spell.get("innateCastLevel"), level)) as f64,
        };
        if pool.current > 0 {
            require_fixed(fixed)?;
            return Ok(Some(SpellSlot { resource: slot_name, level: fixed as i64, pool }));
        }
        if let Some(fallback) = spell.get("fallbackSlotResource").filter(|value| js::truthy(Some(value))) {
            let next = with_slot_resource(spell, fallback);
            return choose_spell_slot(state, actor_id, Some(&next), requested_level, None);
        }
        return Ok(None);
    }
    if slot_name == "pact_slots" || slot_name == "mystic_arcanum_6" {
        let pool = resource_pool(state, actor_id, &slot_name, 0);
        let fixed = match sk_combat_content::combat_spells::fixed_spell_slot_level_for(sk_core::game::find_actor(state, actor_id), Some(spell)) {
            Some(value) if !value.is_null() => js::number(Some(&value)),
            _ => level as f64,
        };
        require_fixed(fixed)?;
        return Ok((pool.current > 0).then(|| SpellSlot { resource: slot_name, level: fixed as i64, pool }));
    }
    if explicit && (!crate::core::is_safe_integer_f64(requested) || requested < level as f64 || requested > 6.0) {
        return Err(reject());
    }
    let levels: Vec<i64> = if explicit { vec![requested as i64] } else { (level..7).collect() };
    for level in levels {
        let resource = format!("spell_slots_{level}");
        let pool = resource_pool(state, actor_id, &resource, 0);
        if pool.current > 0 {
            return Ok(Some(SpellSlot { resource, level, pool }));
        }
    }
    Ok(None)
}

/// `spellAttackDamageModifier(spell, actor)`.
pub fn spell_attack_damage_modifier(spell: &Value, actor: Option<&Value>) -> i64 {
    let ability = spell.get("spellcastingAbility").filter(|value| js::truthy(Some(value))).map(|value| js::string(Some(value))).unwrap_or_else(|| "int".into());
    ability_modifier(at(at(actor, "abilities"), &ability))
}

/// Модификатор выражения костей: `+m`, `-m` или пусто.
fn modifier_suffix(modifier: i64) -> String {
    if modifier > 0 {
        format!("+{modifier}")
    } else if modifier < 0 {
        modifier.to_string()
    } else {
        String::new()
    }
}

/// `safeInteger(value, spell.level)` и `spell.level` числами JS (`NaN`, если
/// у карточки нет круга).
fn slot_and_level(slot_level: Option<&Value>, spell: &Value) -> (f64, f64) {
    let level = js::number(spell.get("level"));
    let slot = if js::is_safe_integer_number(slot_level) { js::number(slot_level) } else { level };
    (slot, level)
}

/// `Math.max(a, b)` с `NaN`, как в JS.
fn js_max(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        f64::NAN
    } else {
        left.max(right)
    }
}

/// `scaledSpellDice(spell, actor, slotLevel)` строкой выражения (`None` — урона нет).
pub fn scaled_spell_dice_text(spell: Option<&Value>, actor: Option<&Value>, slot_level: Option<&Value>) -> Option<String> {
    scaled_spell_dice(spell, actor, slot_level).map(|value| js::string(Some(&value)))
}

/// `scaledSpellDice(spell, actor, slotLevel)`: кость урона с ростом заговора,
/// усилением ячейкой и «Мучительным взрывом». Непарсящееся выражение
/// возвращается как есть — и строкой, и числом, как в JS.
pub fn scaled_spell_dice(spell: Option<&Value>, actor: Option<&Value>, slot_level: Option<&Value>) -> Option<Value> {
    let spell = spell?;
    let damage = spell.get("damage").filter(|value| js::truthy(Some(value)))?;
    let Ok(parsed) = sk_dice::parse_dice_expression(&js::string(Some(damage))) else { return Some(damage.clone()) };
    let mut count = f64::from(parsed.count);
    let (slot, level) = slot_and_level(slot_level, spell);
    if spell.get("level").and_then(Value::as_f64) == Some(0.0) && !js::is_true(spell.get("beamScaling")) && !js::is_false(spell.get("cantripDamageScaling")) {
        let caster_level = crate::core::coalesce(&[at(spell.get("monsterSpell"), "casterLevel"), at(actor, "level")]);
        let caster_level = js::safe_int(caster_level, 1).max(1);
        count += f64::from(u8::from(caster_level >= 5));
        count += f64::from(u8::from(caster_level >= 11));
    } else if js::truthy(spell.get("upcastDicePerLevel")) && slot > level {
        count += js::safe_int(spell.get("upcastDicePerLevel"), 0) as f64 * (slot - level);
    }
    let agonizing = if spell.get("id").and_then(Value::as_str) == Some("eldritch-blast")
        && actor.is_some_and(|actor| js::truthy(Some(actor)))
        && !js::truthy(spell.get("monsterSpell"))
        && sk_ruleset::character_progression::normalized_selected_feature_ids(actor).iter().any(|id| id == "agonizing-blast")
    {
        ability_modifier(at(at(actor, "abilities"), "cha"))
    } else {
        0
    };
    let modifier = parsed.modifier + agonizing;
    Some(Value::String(format!("{}d{}{}", js::f64_string(count), parsed.sides, modifier_suffix(modifier))))
}

/// `scaledDiceExpression(expression, extraLevels = 0, dicePerLevel = 0, maximumDice = 100)`.
pub fn scaled_dice_expression(expression: &str, extra_levels: Option<&Value>, dice_per_level: Option<&Value>, maximum_dice: Option<&Value>) -> String {
    let Ok(parsed) = sk_dice::parse_dice_expression(expression) else { return expression.to_string() };
    let maximum = match maximum_dice {
        None => 100,
        Some(value) => js::safe_int(Some(value), 100),
    }
    .max(1);
    let extra = js::safe_int(extra_levels, 0).max(0) * js::safe_int(dice_per_level, 0).max(0);
    let count = maximum.min(i64::from(parsed.count) + extra);
    format!("{count}d{}{}", parsed.sides, modifier_suffix(parsed.modifier))
}

/// `reactionSlotChoice(state, actorId, spell, offered, requestedLevel)`.
pub fn reaction_slot_choice(state: &Value, actor_id: &str, spell: &Value, offered: &Value, requested_level: Option<&Value>) -> Result<Value, Halt> {
    let level = js::safe_int(requested_level, 0);
    let offered_level = js::safe_int(spell.get("level"), 1).max(level_or_spell(at(Some(offered), "slot_level"), spell));
    if level == offered_level {
        return Ok(offered.clone());
    }
    if level < offered_level || level > 9 {
        return Err(rule("Ячейку реакции можно выбрать только не ниже предложенной", "INVALID_SPELL_SLOT_LEVEL"));
    }
    let resource = format!("spell_slots_{level}");
    let pool = resource_pool(state, actor_id, &resource, 0);
    if pool.current < 1 {
        return Err(rule("Нет свободной ячейки этого круга", "INSUFFICIENT_RESOURCE"));
    }
    let mut map = spread_value(Some(offered));
    map.insert("resource".into(), Value::String(resource));
    map.insert("slot_level".into(), Value::from(level));
    Ok(Value::Object(map))
}

/// `withSpellOptionOverrides(spell, option)`.
pub fn with_spell_option_overrides(spell: &Value, option: Option<&Value>) -> Value {
    let key = match option.filter(|value| !value.is_null()) {
        Some(value) => js::string(Some(value)),
        None => String::new(),
    };
    match at(spell.get("spellOptionOverrides"), &key) {
        Some(overrides @ (Value::Object(_) | Value::Array(_))) => {
            let mut map = spread_value(Some(spell));
            for (name, value) in spread_value(Some(overrides)) {
                map.insert(name, value);
            }
            Value::Object(map)
        }
        _ => spell.clone(),
    }
}

/// `conditionsForSlotLevel(spell, slotLevel)`: состояния наибольшей ступени,
/// до которой дотягивается ячейка.
pub fn conditions_for_slot_level(spell: Option<&Value>, slot_level: Option<&Value>) -> Option<Vec<String>> {
    let spell = spell?;
    let table = match spell.get("conditionsBySlotLevel") {
        Some(table @ (Value::Object(_) | Value::Array(_))) => table,
        _ => return None,
    };
    let entries = crate::pause::object_entries(Some(table));
    let slot = js::safe_int(spell.get("level"), 0).max(level_or_spell(slot_level, spell));
    let mut steps: Vec<i64> = entries.iter().map(|(key, _)| js::safe_int(Some(&Value::String(key.clone())), 0)).filter(|level| *level <= slot).collect();
    steps.sort_by(|left, right| right.cmp(left));
    let step = *steps.first()?;
    match at(Some(table), &step.to_string()).or_else(|| table.as_array().and_then(|items| usize::try_from(step).ok().and_then(|index| items.get(index)))) {
        Some(Value::Array(items)) => Some(items.iter().map(|item| js::string(Some(item))).collect()),
        _ => None,
    }
}

/// `delayedSpellDamageExpression(spell, slotLevel)`.
pub fn delayed_spell_damage_expression(spell: &Value, slot_level: Option<&Value>) -> String {
    let level = spell_level(spell);
    let extra = (level_or_spell(slot_level, spell) - level).max(0);
    scaled_dice_expression(&js::string(spell.get("delayedDamage")), Some(&Value::from(extra)), Some(&Value::from(js::safe_int(spell.get("delayedDamageUpcastDicePerLevel"), 0))), None)
}

/// `concentrationSaveAdvantageFor(actor)`: «Боевой заклинатель» и его
/// аналоги дают преимущество спасброска концентрации.
pub fn concentration_save_advantage_for(actor: Option<&Value>) -> bool {
    let benefits = crate::core::coalesce(&[at(actor, "creationBenefits"), at(actor, "creation_benefits")]);
    let static_benefits = at(benefits, "static");
    let selected = crate::core::coalesce(&[at(actor, "selectedFeatureIds"), at(actor, "selected_feature_ids")]);
    js::is_true(at(static_benefits, "concentration_save_advantage"))
        || js::is_true(at(benefits, "concentration_save_advantage"))
        || matches!(selected, Some(Value::Array(items)) if items.iter().any(|item| js::string(Some(item)) == "war-caster"))
}

/// `lifeDomainCaster(actor)`: жрец домена Жизни.
pub fn life_domain_caster(actor: Option<&Value>) -> bool {
    let Some(actor_value) = actor else { return false };
    if crate::tables::character_class_key(actor_value).as_deref() != Some("cleric") {
        return false;
    }
    let subclass = match sk_combat_content::combat_actions::normalized_combat_subclass_for(actor) {
        Some(subclass) => subclass,
        None => js::s(actor_value.get("subclass")),
    };
    sk_core::text::test(sk_core::re!(r"life|zhiz|жизн", "iu"), &subclass)
}

/// `assertBonusActionSpellAllowed(state, id, spell, actionType)`.
pub fn assert_bonus_action_spell_allowed(state: &Value, id: &str, spell: &Value, action_type: Option<&Value>) -> Result<(), Halt> {
    if !crate::combat::turn::is_own_combat_turn(state, Some(&Value::String(id.into()))) {
        return Ok(());
    }
    let economy = sk_core::game::combat(state).get("action_economy").and_then(|all| all.get(id));
    let field = |key: &str| at(economy, key);
    if !sk_core::game::uses_2014(state) {
        if js::truthy(spell.get("slotResource")) && js::truthy(field("slot_spell_cast_2024")) {
            return Err(rule("На этом ходу ячейка заклинания уже потрачена: за ход тратится только одна", "ONE_SPELL_SLOT_PER_TURN"));
        }
        return Ok(());
    }
    let bonus = action_type.and_then(Value::as_str) == Some("bonus_action");
    let action = action_type.and_then(Value::as_str) == Some("action");
    let cantrip_action = spell.get("level").and_then(Value::as_f64) == Some(0.0) && action;
    if (bonus && js::truthy(field("other_spell_cast_2014"))) || (!bonus && js::truthy(field("bonus_spell_cast_2014")) && !cantrip_action) {
        return Err(rule("После магии бонусным действием на этом ходу разрешён только заговор со временем накладывания «1 действие»", "BONUS_ACTION_SPELL_RESTRICTION"));
    }
    Ok(())
}

/// `beamCountFor(actor, spell, slotLevel = null)`: число лучей заклинания.
/// `slot_level: None` — значение по умолчанию `null`.
pub fn beam_count_for(actor: Option<&Value>, spell: Option<&Value>, slot_level: Option<&Value>) -> i64 {
    let slot_level = slot_level.unwrap_or(&Value::Null);
    if js::is_true(at(spell, "beamScaling")) {
        let caster_level = crate::core::coalesce(&[at(at(spell, "monsterSpell"), "casterLevel"), at(actor, "level")]);
        let level = js::safe_int(caster_level, 1).max(1);
        return if level >= 17 {
            4
        } else if level >= 11 {
            3
        } else if level >= 5 {
            2
        } else {
            1
        };
    }
    let declared = js::safe_int(at(spell, "beams"), 0);
    if declared <= 0 {
        return 1;
    }
    let spell_level = at(spell, "level");
    let fallback = js::safe_int(spell_level, 0);
    let slot = if js::is_safe_integer_number(Some(slot_level)) { js::number(Some(slot_level)) as i64 } else { fallback };
    let extra_levels = (slot - js::safe_int(spell_level, 1).max(1)).max(0);
    1.max(declared + extra_levels * js::safe_int(at(spell, "upcastBeamsPerLevel"), 0).max(0))
}

/// `hasMultipleBeams(spell)`.
pub fn has_multiple_beams(spell: Option<&Value>) -> bool {
    js::is_true(at(spell, "beamScaling")) || js::safe_int(at(spell, "beams"), 0) > 0
}

/// `spellProjectileCount(spell, slotLevel)`: снаряды «Волшебной стрелы».
/// Число JS: у карточки без круга — `NaN`.
pub fn spell_projectile_count(spell: &Value, slot_level: Option<&Value>) -> f64 {
    let (slot, level) = slot_and_level(slot_level, spell);
    let extra = js_max(0.0, slot - level);
    js_max(1.0, js::safe_int(spell.get("projectileCount"), 3) as f64 + extra * js::safe_int(spell.get("upcastProjectilesPerLevel"), 1).max(0) as f64)
}

/// `spellDamageEstimate(actor, spell, slotLevel = spell?.level)`: средний урон
/// до защиты и броска попадания. `slot_level: None` — по умолчанию круг заклинания.
pub fn spell_damage_estimate(actor: Option<&Value>, spell: Option<&Value>, slot_level: Option<&Value>) -> f64 {
    let Some(spell) = spell else { return 0.0 };
    let slot_level = slot_level.or_else(|| spell.get("level"));
    if !js::truthy(spell.get("damage")) {
        return 0.0;
    }
    let projectiles = js::truthy(spell.get("projectileCount"));
    let expression = if projectiles { Some(js::string(spell.get("damage"))) } else { scaled_spell_dice_text(Some(spell), actor, slot_level) };
    let Ok(dice) = sk_dice::parse_dice_expression(&expression.unwrap_or_default()) else { return 0.0 };
    let count = if projectiles { spell_projectile_count(spell, slot_level) } else { beam_count_for(actor, Some(spell), slot_level) as f64 };
    let modifier = if js::truthy(spell.get("addAbilityModifier")) { spell_attack_damage_modifier(spell, actor) } else { 0 };
    js_max(0.0, f64::from(dice.count) * (f64::from(dice.sides) + 1.0) / 2.0 + dice.modifier as f64 + modifier as f64) * count
}

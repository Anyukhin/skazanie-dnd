//! Перенос `server/adjudicator.mjs`: детерминированный разбор заявки игрока
//! (интент `intent-parser`) в план механики — проверку, команду, бросок или
//! черновик решения ведущего. Модель здесь не вызывается: числа, цели и
//! допустимость повторно проверяет Rules Engine при исполнении плана.
//!
//! JS-метод `Adjudicator#createPlan` асинхронный, но без ожиданий внутри —
//! здесь он синхронный. Отказ правила внутри составного манёвра
//! (`RulesValidationError`) становится карточкой уточнения, прочие ошибки
//! (`TypeError` на мусоре заявки) возвращаются как [`Halt::Fault`].

use serde_json::{json, Map, Value};
use sk_core::{game, hash, js, text};
use sk_rules::checks::skills::skill_proficiency_for_actor;
use sk_rules::command::rules::rule_ids;
use sk_rules::core::ability_modifier;
use sk_rules::pause::{Fault, Halt};
use sk_rules::preview_attack::{default_attack_item_id_for, preview_approach_attack, preview_long_jump_attack, preview_swing_attack, swing_prop_for_text};
use sk_ruleset::ruleset_config::{ruleset_rule_id, LEGACY_DEFAULT_RULESET_ID};

/// `DIFFICULTY_CLASSES`: серверная таблица сложности.
pub const DIFFICULTY_CLASSES: [(&str, i64); 3] = [("easy", 10), ("medium", 15), ("hard", 20)];
/// `DIFFICULTY_CATEGORIES`: `Object.keys(DIFFICULTY_CLASSES)`.
pub const DIFFICULTY_CATEGORIES: [&str; 3] = ["easy", "medium", "hard"];

const EASY: f64 = 10.0;
const MEDIUM: f64 = 15.0;

/// Сколько длится наступивший час (`WAIT_TARGET_SPAN_MINUTES`): ночь — до
/// рассвета, вечер — до ночи, остальное — четыре часа.
fn wait_target_span_minutes(id: &str) -> i64 {
    match id {
        "night" => 7 * 60,
        "dusk" => 5 * 60,
        _ => WAIT_DEFAULT_SPAN_MINUTES,
    }
}
const WAIT_DEFAULT_SPAN_MINUTES: i64 = 4 * 60;
/// Сколько выжидает отряд, когда ждать нужного часа уже не нужно.
const WAIT_ALREADY_MINUTES: i64 = 30;

fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(Value::as_object).and_then(|map| map.get(key))
}

fn type_error(message: &str) -> Halt {
    Halt::Fault(Fault::type_error(message))
}

/// `value[0]` (`optional` — `value?.[0]`): у `undefined`/`null` без `?.` —
/// `TypeError`; у строки — первый знак; у объекта — поле `"0"`.
fn first_of(value: Option<&Value>, optional: bool) -> Result<Option<Value>, Halt> {
    match value {
        None | Some(Value::Null) if optional => Ok(None),
        None | Some(Value::Null) => Err(type_error("Cannot read properties of undefined (reading '0')")),
        Some(Value::Array(items)) => Ok(items.first().cloned()),
        Some(Value::String(text)) => Ok(text.chars().next().map(|ch| Value::String(ch.to_string()))),
        Some(Value::Object(map)) => Ok(map.get("0").cloned()),
        Some(_) => Ok(None),
    }
}

/// Поле в объект, только если оно не `undefined` (JSON его бы опустил).
fn put(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value.clone());
    }
}

/// `${value}` шаблонной строки.
fn tpl(value: Option<&Value>) -> String {
    js::string(value)
}

/// `retrievedIds(retrievedRules, fallbacks, rulesetId)`.
fn retrieved_ids(retrieved_rules: Option<&Value>, fallbacks: &[&str], ruleset_id: Option<&Value>) -> Result<Vec<String>, Halt> {
    let mut ids: Vec<String> = Vec::new();
    if let Some(Value::Array(results)) = get(retrieved_rules, "results") {
        let mut taken = 0;
        for result in results {
            let rule_id = match result {
                Value::Null => return Err(type_error("Cannot read properties of null (reading 'rule_id')")),
                Value::Object(map) => map.get("rule_id"),
                _ => None,
            };
            if js::truthy(rule_id) {
                if taken < 5 {
                    ids.push(js::s(rule_id));
                }
                taken += 1;
            }
        }
    }
    // `rulesetId = LEGACY_DEFAULT_RULESET_ID` срабатывает только на `undefined`.
    let ruleset = match ruleset_id {
        None => LEGACY_DEFAULT_RULESET_ID.to_string(),
        Some(value) => js::s(Some(value)),
    };
    let mut unique: Vec<String> = Vec::new();
    for id in ids.into_iter().chain(fallbacks.iter().map(|id| id.to_string())) {
        let mapped = ruleset_rule_id(&id, &ruleset);
        if !unique.contains(&mapped) {
            unique.push(mapped);
        }
    }
    Ok(unique)
}

fn strings(list: &[String]) -> Value {
    Value::Array(list.iter().cloned().map(Value::String).collect())
}

/// `attackProfile(actor)`: модификатор Силы с бонусом мастерства и кубы
/// надетого оружия из его свойств.
fn attack_profile(actor: Option<&Value>) -> Result<Map<String, Value>, Halt> {
    let strength = ability_modifier(get(get(actor, "abilities"), "str"));
    let mut equipped = None;
    if let Some(Value::Array(inventory)) = get(actor, "inventory") {
        for item in inventory {
            if item.is_null() {
                return Err(type_error("Cannot read properties of null (reading 'equipped')"));
            }
            if js::truthy(get(Some(item), "equipped")) && get(Some(item), "type").and_then(Value::as_str) == Some("weapon") {
                equipped = Some(item);
                break;
            }
        }
    }
    let properties = js::s(get(equipped, "properties"));
    let expression = text::capture(sk_core::re!(r"\b(\d{1,2}d\d{1,3}(?:\s*[+-]\s*\d{1,2})?)", "i"), &properties, 1)
        .map(|found| text::replace_all(sk_core::re!(r"\s+", ""), &found, ""))
        .filter(|found| !found.is_empty());
    let proficiency = js::number(get(actor, "proficiency"));
    let proficiency = if proficiency.is_nan() || proficiency == 0.0 { 0.0 } else { proficiency };
    let damage = expression.unwrap_or_else(|| {
        let bonus = if strength > 0 {
            format!("+{strength}")
        } else if strength < 0 {
            strength.to_string()
        } else {
            String::new()
        };
        format!("1d6{bonus}")
    });
    let mut map = Map::new();
    map.insert("attack_modifier".into(), js::num(strength as f64 + proficiency));
    map.insert("damage_expression".into(), Value::String(damage));
    map.insert("damage_type".into(), Value::String("slashing".into()));
    Ok(map)
}

/// `({ … })[approach] ?? 'wis'`: ключ — `approach`, приведённый к строке.
fn ability_for_approach(approach: Option<&Value>) -> &'static str {
    match js::string(approach).as_str() {
        "strength" => "str",
        "stealth" => "dex",
        "arcana" | "investigation" => "int",
        "perception" | "survival" => "wis",
        "persuasion" | "intimidation" => "cha",
        _ => "wis",
    }
}

fn skill_for_approach(approach: Option<&Value>) -> &'static str {
    match js::s(approach).as_str() {
        "strength" => "athletics",
        "stealth" => "stealth",
        "arcana" => "arcana",
        "perception" => "perception",
        "persuasion" => "persuasion",
        "intimidation" => "intimidation",
        "investigation" => "investigation",
        "survival" => "survival",
        _ => "",
    }
}

fn difficulty_category_from_value(value: Option<&Value>) -> Option<&'static str> {
    let difficulty = js::number(value);
    if !difficulty.is_finite() {
        return None;
    }
    if difficulty <= EASY {
        return Some("easy");
    }
    if difficulty <= MEDIUM {
        return Some("medium");
    }
    Some("hard")
}

/// `difficultyCategoryFor(intent, state)`: названная категория, иначе
/// сложность действующей опасности героя, иначе по словам заявки.
pub fn difficulty_category_for(intent: Option<&Value>, state: &Value) -> &'static str {
    let requested_raw = match get(intent, "difficulty_category").filter(|value| !value.is_null()) {
        Some(value) => Some(value),
        None => get(intent, "difficultyCategory"),
    };
    let requested = text::lower(text::trim(&js::s(requested_raw)));
    if let Some(category) = DIFFICULTY_CATEGORIES.iter().find(|category| **category == requested) {
        return category;
    }
    let actor_key = js::string(get(intent, "actor_id"));
    let hazards = get(get(Some(state), "mechanics"), "hazards");
    let list = get(hazards, &actor_key);
    let active = match list {
        Some(Value::Array(items)) => items.first(),
        Some(Value::Object(map)) => map.get("0"),
        _ => None,
    };
    if let Some(category) = difficulty_category_from_value(get(active, "escapeDifficulty")) {
        return category;
    }
    let raw = match get(intent, "raw_message").filter(|value| !value.is_null()) {
        Some(value) => js::string(Some(value)),
        None => String::new(),
    };
    if text::test(sk_core::re!(r"(бурн|шторм|rough water|тон\w*|удуш|suffocat|drown)", "iu"), &raw) {
        "hard"
    } else {
        "medium"
    }
}

/// `difficultyClassFor(category)`: неизвестная категория — средняя.
pub fn difficulty_class_for(category: &str) -> i64 {
    DIFFICULTY_CLASSES.iter().find(|(name, _)| *name == category).map_or(15, |(_, value)| *value)
}

/// `String(x ?? '')` для текстовой проверки регулярным выражением (`re.test(x ?? '')`).
fn regex_text(value: Option<&Value>) -> String {
    match value.filter(|value| !value.is_null()) {
        Some(value) => js::string(Some(value)),
        None => String::new(),
    }
}

/// `Adjudicator`: детерминированный разбор заявки.
#[derive(Debug, Clone, Copy, Default)]
pub struct Adjudicator;

impl Adjudicator {
    /// `createPlan({ intent, state, retrievedRules })`.
    pub fn create_plan(&self, intent: Option<&Value>, state: &Value, retrieved_rules: Option<&Value>) -> Result<Value, Halt> {
        create_plan(intent, state, retrieved_rules)
    }
}

/// `new Adjudicator().createPlan({ intent, state, retrievedRules })`.
pub fn create_plan(intent: Option<&Value>, state: &Value, retrieved_rules: Option<&Value>) -> Result<Value, Halt> {
    let ruleset = get(Some(state), "ruleset_id");
    let rule_ids_for = |fallbacks: &[&str]| retrieved_ids(retrieved_rules, fallbacks, ruleset);
    let rule_ids = rule_ids_for(&[])?;
    let intent_confidence = js::number(get(intent, "confidence"));
    let intent_confidence = if intent_confidence.is_nan() || intent_confidence == 0.0 { 0.0 } else { intent_confidence };
    let rules_confidence = match get(retrieved_rules, "confidence").filter(|value| !value.is_null()) {
        Some(value) => js::number(Some(value)),
        None => 1.0,
    };
    let confidence = js::min_of([intent_confidence, rules_confidence]);
    let mut base = Map::new();
    base.insert("rule_ids".into(), strings(&rule_ids));
    base.insert("proposed_commands".into(), json!([]));
    base.insert("roll_requests".into(), json!([]));
    base.insert("ruling_required".into(), Value::Bool(false));
    base.insert("ruling_draft".into(), Value::Null);
    base.insert("narration_constraints".into(), json!(["Не добавлять механические последствия сверх подтверждённых событий"]));
    base.insert("confidence".into(), js::num(confidence));
    let with = |patch: Vec<(&str, Value)>| -> Value {
        let mut map = base.clone();
        for (key, value) in patch {
            map.insert(key.into(), value);
        }
        Value::Object(map)
    };
    let clarify = |message: String| with(vec![("clarification_required", Value::Bool(true)), ("clarification_message", Value::String(message))]);

    if js::truthy(get(intent, "requires_clarification")) {
        let mut map = base.clone();
        map.insert("clarification_required".into(), Value::Bool(true));
        put(&mut map, "missing_information", get(intent, "missing_information"));
        return Ok(Value::Object(map));
    }
    let actor_id_raw = get(intent, "actor_id");
    let actor_id = js::s(actor_id_raw);
    let actor = game::find_actor(state, &actor_id);
    let raw_message = get(intent, "raw_message");
    let state_version = get(Some(state), "state_version");
    let declare = || {
        let mut map = Map::new();
        map.insert("command_type".into(), Value::String("DeclareAction".into()));
        put(&mut map, "actor_id", actor_id_raw);
        put(&mut map, "action", raw_message);
        put(&mut map, "expected_state_version", state_version);
        Value::Object(map)
    };
    let actor_field = |map: &mut Map<String, Value>| put(map, "actor_id", actor_id_raw);
    let name_of = |target: Option<&Value>| -> Result<String, Halt> {
        let Some(target) = target else { return Err(type_error("Cannot read properties of null (reading 'name')")) };
        let name = get(Some(target), "name").filter(|value| !value.is_null()).or_else(|| get(Some(target), "character"));
        Ok(tpl(name))
    };

    match get(intent, "intent").and_then(Value::as_str) {
        Some("approach_attack") => {
            let attempt = (|| -> Result<Value, Halt> {
                let target_raw = first_of(get(intent, "targets"), false)?;
                let target_id = js::s(target_raw.as_ref());
                let route = preview_approach_attack(state, &actor_id, &target_id)?;
                let mut key = Map::new();
                key.insert("kind".into(), Value::String("approach-attack/v1".into()));
                put(&mut key, "campaign_id", get(Some(state), "sessionCode"));
                put(&mut key, "state_version", state_version);
                put(&mut key, "actor_id", actor_id_raw);
                put(&mut key, "target_id", target_raw.as_ref());
                put(&mut key, "action", raw_message);
                put(&mut key, "path", route.get("path"));
                let id = hash::sha256_hex(js::stringify(&Value::Object(key)));
                let target = game::find_actor(state, &target_id);
                let mut commands = vec![declare()];
                commands.extend(route_commands(&route)?);
                let mut proposal = Map::new();
                proposal.insert("id".into(), Value::String(id));
                proposal.insert("kind".into(), Value::String("approach_attack".into()));
                put(&mut proposal, "state_version", state_version);
                actor_field(&mut proposal);
                put(&mut proposal, "target_id", target_raw.as_ref());
                proposal.insert("title".into(), Value::String(format!("Подойти и атаковать: {}", name_of(target)?)));
                put(&mut proposal, "path", route.get("path"));
                put(&mut proposal, "to", route.get("to"));
                put(&mut proposal, "movement_feet", route.get("movement_feet"));
                proposal.insert("cost".into(), Value::String(format!("{} фт перемещения + {}", tpl(route.get("movement_feet")), tpl(route.get("attack_cost")))));
                proposal.insert("consequence".into(), Value::String("Герой пройдёт отмеченным маршрутом и совершит один удар. Движение может вызвать реакции и последствия поверхностей; если герой не сможет продолжать, атака не состоится.".into()));
                Ok(with(vec![("maneuver", Value::String("approach_attack".into())), ("proposed_commands", Value::Array(commands)), ("proposal", Value::Object(proposal))]))
            })();
            match attempt {
                Err(Halt::Rule(error)) => Ok(clarify(error.message)),
                other => other,
            }
        }
        Some("compound_maneuver") => {
            let attempt = (|| -> Result<Value, Halt> {
                let target_raw = first_of(get(intent, "targets"), true)?;
                let target_id = js::s(target_raw.as_ref());
                let text_value = match raw_message.filter(|value| !value.is_null()) {
                    Some(value) => value.clone(),
                    None => Value::String(String::new()),
                };
                let swing_prop = swing_prop_for_text(state, Some(&text_value))?;
                let message = regex_text(raw_message);
                if text::test(sk_core::re!(r"(люстр|chandelier)", "iu"), &message) && swing_prop.is_none() {
                    return Ok(clarify("На этой карте нет серверно подтверждённой люстры с точкой опоры и высотой. Можно сначала выбрать обычный маршрут и затем атаковать противника; заявка ничего не расходует.".into()));
                }
                let running_start = text::test(sk_core::re!(r"(?:с|для)\s+разбег\p{L}*", "iu"), &message);
                let prop_id = swing_prop.as_ref().and_then(|prop| prop.get("id"));
                let route = match &swing_prop {
                    Some(_) => preview_swing_attack(state, &actor_id, &target_id, prop_id, running_start)?,
                    None => preview_long_jump_attack(state, &actor_id, &target_id, running_start)?,
                };
                let swing = swing_prop.is_some();
                let mut key = Map::new();
                key.insert("kind".into(), Value::String(if swing { "swing-attack/v1" } else { "long-jump-attack/v1" }.into()));
                put(&mut key, "campaign_id", get(Some(state), "sessionCode"));
                put(&mut key, "state_version", state_version);
                put(&mut key, "actor_id", actor_id_raw);
                put(&mut key, "target_id", target_raw.as_ref());
                put(&mut key, "action", raw_message);
                put(&mut key, "path", route.get("path"));
                key.insert("running_start".into(), Value::Bool(running_start));
                key.insert("prop_id".into(), match prop_id {
                    Some(value) if !value.is_null() => value.clone(),
                    _ => Value::Null,
                });
                let id = hash::sha256_hex(js::stringify(&Value::Object(key)));
                let target = game::find_actor(state, &target_id);
                let mut commands = vec![declare()];
                commands.extend(route_commands(&route)?);
                let name = name_of(target)?;
                let mut proposal = Map::new();
                proposal.insert("id".into(), Value::String(id));
                proposal.insert("kind".into(), Value::String("approach_attack".into()));
                put(&mut proposal, "state_version", state_version);
                actor_field(&mut proposal);
                put(&mut proposal, "target_id", target_raw.as_ref());
                proposal.insert("title".into(), Value::String(if swing { format!("Раскачаться на люстре и атаковать: {name}") } else { format!("Прыгнуть и атаковать: {name}") }));
                put(&mut proposal, "path", route.get("path"));
                put(&mut proposal, "to", route.get("to"));
                put(&mut proposal, "movement_feet", route.get("movement_feet"));
                let cost = if swing {
                    let Some(ruling) = route.get("ruling").filter(|value| !value.is_null()) else {
                        return Err(type_error("Cannot read properties of undefined (reading 'difficulty')"));
                    };
                    format!("{} фт движения + {}; Сила (Атлетика) СЛ {}", tpl(route.get("movement_feet")), tpl(route.get("attack_cost")), tpl(ruling.get("difficulty")))
                } else {
                    format!("{} фт прыжка + {}", tpl(route.get("movement_feet")), tpl(route.get("attack_cost")))
                };
                proposal.insert("cost".into(), Value::String(cost));
                proposal.insert("consequence".into(), Value::String(if swing {
                    "Предлагаемое временное решение для этой люстры: успех даёт обычный удар без бонусного урона; при провале герой срывается, не удерживает опору и падает ничком у неё, без удара."
                } else {
                    "Герой совершит горизонтальный прыжок по отмеченной траектории и один обычный удар. Прыжок не добавляет урон; стены, занятые клетки и реакция по пути остаются действительными."
                }.into()));
                if js::truthy(route.get("ruling")) {
                    put(&mut proposal, "ruling", route.get("ruling"));
                }
                Ok(with(vec![
                    ("maneuver", Value::String(if swing { "swing_attack" } else { "long_jump_attack" }.into())),
                    ("proposed_commands", Value::Array(commands)),
                    ("proposal", Value::Object(proposal)),
                ]))
            })();
            match attempt {
                Err(Halt::Rule(error)) => Ok(clarify(format!("{}. Попытка ничего не расходует.", error.message))),
                other => other,
            }
        }
        Some("cast_spell") => {
            let spell_id = js::s(get(intent, "spell_id"));
            if spell_id.is_empty() {
                return ruling(&base, confidence, intent, retrieved_rules, &rule_ids);
            }
            let mut options = Map::new();
            put(&mut options, "rulesetId", ruleset);
            let spell = sk_combat_content::combat_spells::combat_spell_for(actor, Some(&Value::String(spell_id.clone())), Some(&Value::Object(options)));
            let Some(spell) = spell else {
                return Ok(clarify("Этого заклинания сейчас нет под рукой — оно не подготовлено. Можно выбрать другое на панели.".into()));
            };
            let name = tpl(spell.get("name"));
            if spell.get("target").and_then(Value::as_str) == Some("point") {
                return Ok(clarify(format!("«{name}» бьёт по площади — укажите место на карте, и заклинание сорвётся с пальцев.")));
            }
            let target_raw = first_of(get(intent, "targets"), true)?;
            let target_kind = js::string(spell.get("target"));
            if !js::truthy(target_raw.as_ref()) && (target_kind == "enemy" || target_kind == "creature") {
                return Ok(clarify(format!("«{name}» — в кого именно? Назовите цель или выберите её на карте.")));
            }
            let sources = strings(&rule_ids_for(&[rule_ids::ATTACK, rule_ids::DAMAGE])?);
            let mut command = Map::new();
            command.insert("command_type".into(), Value::String("CastSpell".into()));
            actor_field(&mut command);
            command.insert("spell_id".into(), Value::String(spell_id));
            command.insert("server_authoritative".into(), Value::Bool(true));
            if js::truthy(target_raw.as_ref()) {
                put(&mut command, "target_id", target_raw.as_ref());
            }
            if js::truthy(get(intent, "knock_out")) {
                command.insert("knock_out".into(), Value::Bool(true));
            }
            command.insert("source_rule_ids".into(), sources.clone());
            Ok(with(vec![("rule_ids", sources), ("proposed_commands", json!([Value::Object(command)])), ("confidence", js::num(0.82))]))
        }
        Some("attack") => {
            let target_raw = first_of(get(intent, "targets"), true)?;
            let item_id = if js::truthy(target_raw.as_ref()) { default_attack_item_id_for(state, &actor_id, &js::s(target_raw.as_ref()))? } else { None };
            let sources = strings(&rule_ids_for(&[rule_ids::ATTACK, rule_ids::DAMAGE])?);
            let mut command = Map::new();
            command.insert("command_type".into(), Value::String("MakeAttack".into()));
            actor_field(&mut command);
            put(&mut command, "target_id", target_raw.as_ref());
            for (key, value) in attack_profile(actor)? {
                command.insert(key, value);
            }
            if let Some(item_id) = item_id.filter(|id| !id.is_empty()) {
                command.insert("item_id".into(), Value::String(item_id));
            }
            command.insert("source_rule_ids".into(), sources.clone());
            let mut roll = Map::new();
            roll.insert("expression".into(), Value::String("1d20".into()));
            roll.insert("purpose".into(), Value::String("attack".into()));
            actor_field(&mut roll);
            Ok(with(vec![("rule_ids", sources), ("proposed_commands", json!([Value::Object(command)])), ("roll_requests", json!([Value::Object(roll)])), ("confidence", js::num(0.82))]))
        }
        Some("ability_check") => {
            let category = difficulty_category_for(intent, state);
            let difficulty = difficulty_class_for(category);
            let ability = ability_for_approach(get(intent, "approach"));
            let skill = skill_for_approach(get(intent, "approach"));
            let proficiency = if skill.is_empty() { None } else { Some(skill_proficiency_for_actor(actor, Some(&Value::String(skill.into())), Some(state))) };
            let sources = strings(&rule_ids_for(&[rule_ids::ABILITY_CHECK])?);
            let mut command = Map::new();
            command.insert("command_type".into(), Value::String("MakeAbilityCheck".into()));
            actor_field(&mut command);
            command.insert("ability".into(), Value::String(ability.into()));
            if !skill.is_empty() {
                command.insert("skill".into(), Value::String(skill.into()));
            }
            if let Some(proficiency) = proficiency.as_ref().filter(|value| js::truthy(Some(value))) {
                put(&mut command, "proficient", proficiency.get("proficient"));
                put(&mut command, "expertise", proficiency.get("expertise"));
                put(&mut command, "proficiency_bonus", proficiency.get("bonus"));
            }
            command.insert("difficulty".into(), Value::from(difficulty));
            command.insert("difficulty_category".into(), Value::String(category.into()));
            command.insert("source_rule_ids".into(), sources.clone());
            let mut roll = Map::new();
            roll.insert("expression".into(), Value::String("1d20".into()));
            roll.insert("purpose".into(), Value::String(format!("ability_check:{ability}")));
            actor_field(&mut roll);
            Ok(with(vec![("rule_ids", sources), ("proposed_commands", json!([Value::Object(command)])), ("roll_requests", json!([Value::Object(roll)])), ("confidence", js::num(0.74))]))
        }
        Some("saving_throw") => {
            let category = difficulty_category_for(intent, state);
            let sources = strings(&rule_ids_for(&[rule_ids::SAVING_THROW])?);
            let mut command = Map::new();
            command.insert("command_type".into(), Value::String("MakeSavingThrow".into()));
            actor_field(&mut command);
            command.insert("ability".into(), Value::String(ability_for_approach(get(intent, "approach")).into()));
            command.insert("difficulty".into(), Value::from(difficulty_class_for(category)));
            command.insert("difficulty_category".into(), Value::String(category.into()));
            command.insert("source_rule_ids".into(), sources.clone());
            let mut roll = Map::new();
            roll.insert("expression".into(), Value::String("1d20".into()));
            roll.insert("purpose".into(), Value::String("saving_throw".into()));
            actor_field(&mut roll);
            Ok(with(vec![("rule_ids", sources), ("proposed_commands", json!([Value::Object(command)])), ("roll_requests", json!([Value::Object(roll)])), ("confidence", js::num(0.72))]))
        }
        // Свободный текст не доказывает источник лечения или расход ресурса.
        Some("healing") => ruling(&base, confidence, intent, retrieved_rules, &rule_ids),
        Some("end_turn") => {
            let sources = strings(&rule_ids_for(&[rule_ids::TURNS])?);
            let mut command = Map::new();
            command.insert("command_type".into(), Value::String("EndTurn".into()));
            actor_field(&mut command);
            command.insert("source_rule_ids".into(), sources.clone());
            Ok(with(vec![("rule_ids", sources), ("proposed_commands", json!([Value::Object(command)])), ("confidence", js::num(0.95))]))
        }
        Some("start_combat") => {
            let mut participants = Vec::new();
            for key in ["players", "actors"] {
                match state.get(key) {
                    None | Some(Value::Null) => {}
                    Some(Value::Array(items)) => {
                        for item in items {
                            if item.is_null() {
                                return Err(type_error("Cannot read properties of null (reading 'id')"));
                            }
                            participants.push(js::string(get(Some(item), "id")));
                        }
                    }
                    // `[...'ab']` — знаки строки, у знака нет `id`.
                    Some(Value::String(text)) => participants.extend(text.chars().map(|_| "undefined".to_string())),
                    Some(_) => return Err(type_error("object is not iterable")),
                }
            }
            participants.retain(|id| !id.is_empty());
            let sources = strings(&rule_ids_for(&[rule_ids::INITIATIVE])?);
            let mut command = Map::new();
            command.insert("command_type".into(), Value::String("StartCombat".into()));
            actor_field(&mut command);
            command.insert("participant_ids".into(), strings(&participants));
            command.insert("source_rule_ids".into(), sources.clone());
            let rolls: Vec<Value> = participants.iter().map(|id| json!({ "expression": "1d20", "purpose": "initiative", "actor_id": id })).collect();
            Ok(with(vec![("rule_ids", sources), ("proposed_commands", json!([Value::Object(command)])), ("roll_requests", Value::Array(rolls)), ("confidence", js::num(0.8))]))
        }
        Some("end_combat") => {
            let sources = strings(&rule_ids_for(&[rule_ids::INITIATIVE, rule_ids::TURNS])?);
            let mut command = Map::new();
            command.insert("command_type".into(), Value::String("EndCombat".into()));
            actor_field(&mut command);
            command.insert("source_rule_ids".into(), sources.clone());
            Ok(with(vec![("rule_ids", sources), ("proposed_commands", json!([Value::Object(command)])), ("confidence", js::num(0.9))]))
        }
        Some("scenario_purse") => {
            // Кошель короля: место, «раз на героя» и сумму решает Rules Engine.
            let sources = strings(&rule_ids_for(&[rule_ids::ECONOMY_COINS])?);
            let mut command = Map::new();
            command.insert("command_type".into(), Value::String("ReceiveScenarioPurse".into()));
            actor_field(&mut command);
            command.insert("source_rule_ids".into(), sources.clone());
            Ok(with(vec![("rule_ids", sources), ("proposed_commands", json!([Value::Object(command)])), ("confidence", js::num(0.9))]))
        }
        Some("scenario_informant") => {
            let informant = get(intent, "scenario_informant");
            let turn = get(informant, "choice").and_then(Value::as_str) == Some("turn");
            let sources = if turn { strings(&rule_ids_for(&[rule_ids::ABILITY_CHECK])?) } else { json!([]) };
            let mut command = Map::new();
            command.insert("command_type".into(), Value::String("ResolveScenarioInformant".into()));
            actor_field(&mut command);
            put(&mut command, "informant_id", get(informant, "informant_id"));
            put(&mut command, "choice", get(informant, "choice"));
            command.insert("source_rule_ids".into(), sources.clone());
            Ok(with(vec![("rule_ids", sources), ("proposed_commands", json!([Value::Object(command)])), ("confidence", js::num(0.9))]))
        }
        Some("scenario_armory") => {
            let mut command = Map::new();
            command.insert("command_type".into(), Value::String("ChooseScenarioArmoryItem".into()));
            actor_field(&mut command);
            let catalog = get(get(intent, "scenario_armory"), "catalog_id").filter(|value| !value.is_null()).cloned().unwrap_or(Value::Null);
            command.insert("catalog_id".into(), catalog);
            command.insert("source_rule_ids".into(), json!([]));
            Ok(with(vec![("rule_ids", json!([])), ("proposed_commands", json!([Value::Object(command)])), ("confidence", js::num(0.9))]))
        }
        Some("scenario_treaty") => {
            let sources = strings(&rule_ids_for(&[rule_ids::ABILITY_CHECK])?);
            let mut command = Map::new();
            command.insert("command_type".into(), Value::String("NegotiateScenarioTreaty".into()));
            actor_field(&mut command);
            command.insert("source_rule_ids".into(), sources.clone());
            Ok(with(vec![("rule_ids", sources), ("proposed_commands", json!([Value::Object(command)])), ("confidence", js::num(0.9))]))
        }
        Some("scenario_knight") => {
            let action = get(intent, "scenario_knight");
            let release = get(action, "action").and_then(Value::as_str) == Some("release");
            let rule_list = strings(&rule_ids_for(&[if release { rule_ids::ABILITY_CHECK } else { rule_ids::TURNS }])?);
            let mut command = Map::new();
            if release {
                command.insert("command_type".into(), Value::String("ReleaseCursedKnight".into()));
                actor_field(&mut command);
                put(&mut command, "skill", get(action, "skill"));
                command.insert("source_rule_ids".into(), strings(&rule_ids_for(&[rule_ids::ABILITY_CHECK])?));
            } else {
                command.insert("command_type".into(), Value::String("ReturnKnightHead".into()));
                actor_field(&mut command);
                command.insert("source_rule_ids".into(), strings(&rule_ids_for(&[rule_ids::TURNS])?));
            }
            Ok(with(vec![("rule_ids", rule_list), ("proposed_commands", json!([Value::Object(command)])), ("confidence", js::num(0.9))]))
        }
        Some("wait") => {
            // Ожидание до часа суток — то же течение времени, что у отдыха, но
            // без отдыха. Посреди боя ждать нечего, сутки — потолок.
            let Some(target) = sk_story::intent_parser::wait_target_from_text(raw_message) else {
                return Ok(clarify("До какого часа ждать: полуночи, рассвета, полудня или вечера?".into()));
            };
            let mechanics = get(Some(state), "mechanics");
            if js::truthy(get(get(mechanics, "combat"), "active")) {
                return Ok(clarify("Посреди боя ждать некогда. Попытка ничего не расходует.".into()));
            }
            let elapsed = get(get(mechanics, "world_time"), "elapsed_minutes").filter(|value| !value.is_null()).cloned().unwrap_or(Value::from(0));
            let until = sk_world_time::weather::minutes_until_clock(&elapsed, target.minute);
            // Цель уже наступила, и недавно: отряд выжидает полчаса.
            let already = until == 0 || 24 * 60 - until <= wait_target_span_minutes(target.id);
            let minutes = if already { WAIT_ALREADY_MINUTES } else { until };
            let sources = strings(&rule_ids_for(&[rule_ids::RESOURCE])?);
            let mut wait = Map::new();
            wait.insert("target".into(), Value::String(target.id.into()));
            wait.insert("label".into(), Value::String(target.label.into()));
            wait.insert("minutes".into(), Value::from(minutes));
            if already {
                wait.insert("already".into(), Value::Bool(true));
            }
            let command = json!({ "command_type": "AdvanceTime", "amount": minutes, "unit": "minute", "source_rule_ids": sources.clone() });
            Ok(with(vec![("rule_ids", sources), ("wait", Value::Object(wait)), ("proposed_commands", json!([command])), ("confidence", js::num(0.9))]))
        }
        Some("rest") => {
            let kind = if text::test(sk_core::re!(r"долг|продолж|long", "iu"), &js::string(raw_message)) { "long" } else { "short" };
            let minutes = if kind == "long" { 480 } else { 60 };
            let sources = strings(&rule_ids_for(&[rule_ids::RESOURCE])?);
            let step = |command_type: &str| {
                let mut command = Map::new();
                command.insert("command_type".into(), Value::String(command_type.into()));
                actor_field(&mut command);
                command.insert("kind".into(), Value::String(kind.into()));
                command.insert("source_rule_ids".into(), sources.clone());
                Value::Object(command)
            };
            let advance = json!({ "command_type": "AdvanceTime", "amount": minutes, "unit": "minute", "source_rule_ids": sources.clone() });
            Ok(with(vec![("rule_ids", sources.clone()), ("proposed_commands", json!([step("StartRest"), advance, step("CompleteRest")])), ("confidence", js::num(0.9))]))
        }
        _ => ruling(&base, confidence, intent, retrieved_rules, &rule_ids),
    }
}

/// `[...route.commands]`: команды предпросмотра манёвра.
fn route_commands(route: &Value) -> Result<Vec<Value>, Halt> {
    match route.get("commands") {
        Some(Value::Array(commands)) => Ok(commands.clone()),
        _ => Err(type_error("route.commands is not iterable")),
    }
}

/// Хвост `createPlan`: черновик решения ведущего без механики.
fn ruling(base: &Map<String, Value>, confidence: f64, intent: Option<&Value>, retrieved_rules: Option<&Value>, rule_ids: &[String]) -> Result<Value, Halt> {
    // `retrievedRules?.confidence < 0.45`: `undefined` не меньше ничего.
    let low = get(retrieved_rules, "confidence").is_some_and(|value| js::number(Some(value)) < 0.45);
    let question = match get(intent, "raw_message").filter(|value| !value.is_null()) {
        Some(value) => value.clone(),
        None => Value::String(String::new()),
    };
    let mut draft = Map::new();
    draft.insert("question".into(), question);
    draft.insert("selected_interpretation".into(), Value::String("Разрешить как временное решение ведущего без автоматического изменения механического состояния.".into()));
    draft.insert("rationale".into(), Value::String(if low { "Низкая уверенность поиска правил." } else { "Механика ещё не формализована." }.into()));
    draft.insert("supporting_rule_ids".into(), strings(rule_ids));
    draft.insert("scope".into(), Value::String("single_event".into()));
    draft.insert("approved_by_owner".into(), Value::Bool(false));
    draft.insert("world_change".into(), Value::Bool(false));
    draft.insert("overrides_rule_ids".into(), json!([]));
    let mut map = base.clone();
    map.insert("ruling_required".into(), Value::Bool(true));
    map.insert("ruling_draft".into(), Value::Object(draft));
    let mut constraints = base.get("narration_constraints").and_then(Value::as_array).cloned().unwrap_or_default();
    constraints.push(Value::String("no-unconfirmed-world-changes".into()));
    map.insert("narration_constraints".into(), Value::Array(constraints));
    map.insert("confidence".into(), js::num(js::min_of([confidence, 0.5])));
    Ok(Value::Object(map))
}

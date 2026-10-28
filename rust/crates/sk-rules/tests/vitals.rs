//! Сверка задачи Р2 с эталоном JS (`fixtures/vitals.json`, генератор —
//! `fixtures/gen-vitals.mjs`): состояния, проверки и спасброски, урон и защиты,
//! смерть, отдых, взлом, «Несгибаемый»; броски со стенограммой костей; блоки
//! `validateCommand` 57, 58, 61, 62, 70; ветки разбора Р2 без хвоста.
//!
//! Вызов эталона — `{ f, s, a, o }`: функция, индекс состояния, аргументы
//! (`__undefined__` — `undefined`, `{ "$actor": id }` — участник состояния по
//! ссылке), выход (`ok` — JSON или `sha256:` строки `JSON.stringify`, `err` —
//! код и текст отказа, `fault` — имя ошибки JS).

use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_dice::{DiceService, SequenceRng};
use sk_rules::checks::{indomitable, saves, skills};
use sk_rules::conditions as cond;
use sk_rules::context::{sequence_uuids, Context};
use sk_rules::dice_record::{Recording, RulesDice, ServiceDice};
use sk_rules::pause::{Halt, Interrupt};
use sk_rules::validate::Validation;
use sk_rules::{damage, death, lockpick, rest};

const FIXTURE: &str = include_str!("../fixtures/vitals.json");
static DATA: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(FIXTURE).expect("эталон — JSON"));

const U: &str = "__undefined__";

/// Поля со значением `undefined` убираются (как `JSON.stringify`).
fn deep(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(map.iter().filter(|(_, field)| field.as_str() != Some(U)).map(|(key, field)| (key.clone(), deep(field))).collect()),
        Value::Array(items) => Value::Array(items.iter().map(deep).collect()),
        other => other.clone(),
    }
}

/// Поле со значением `undefined` держит место ключа маркером [`js::UNDEFINED`]
/// (опции бросков: функция перезаписывает такие ключи на месте).
fn deep_marker(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(map.iter().map(|(key, field)| (key.clone(), if field.as_str() == Some(U) { Value::String(js::UNDEFINED.into()) } else { deep_marker(field) })).collect()),
        Value::Array(items) => Value::Array(items.iter().map(deep_marker).collect()),
        other => other.clone(),
    }
}

/// Аргументы вызова: `None` — `undefined`, участник — ссылкой в состояние.
struct Args<'a> {
    state: &'a Value,
    values: Vec<Option<Value>>,
    actors: Vec<Option<&'a Value>>,
}

impl<'a> Args<'a> {
    fn new(state: &'a Value, raw: &'a Value) -> Self {
        Self::with(state, raw, deep)
    }

    fn with(state: &'a Value, raw: &'a Value, nested: fn(&Value) -> Value) -> Self {
        let mut values = Vec::new();
        let mut actors = Vec::new();
        for item in raw.as_array().map(Vec::as_slice).unwrap_or(&[]) {
            let actor_ref = item.as_object().filter(|map| map.len() == 1).and_then(|map| map.get("$actor")).and_then(Value::as_str);
            if let Some(id) = actor_ref {
                actors.push(sk_core::game::find_actor(state, id));
                values.push(None);
            } else if item.as_str() == Some(U) {
                actors.push(None);
                values.push(None);
            } else {
                actors.push(None);
                values.push(Some(nested(item)));
            }
        }
        Self { state, values, actors }
    }

    fn v(&self, index: usize) -> Option<&Value> {
        self.values.get(index).and_then(Option::as_ref)
    }

    fn actor(&self, index: usize) -> Option<&'a Value> {
        self.actors.get(index).copied().flatten()
    }

    /// `String(id ?? '')` — идентификаторы эталона всегда строки.
    fn id(&self, index: usize) -> String {
        js::s(self.v(index))
    }

    fn text(&self, index: usize) -> String {
        js::string(self.v(index))
    }

    fn flag(&self, index: usize) -> bool {
        js::truthy(self.v(index))
    }

    fn number(&self, index: usize) -> Option<f64> {
        self.v(index).filter(|value| !value.is_null()).map(|value| js::number(Some(value)))
    }

    fn state_opt(&self, index: usize) -> Option<&'a Value> {
        self.flag(index).then_some(self.state)
    }
}

fn opt_string(value: Option<String>) -> Value {
    value.map(Value::String).unwrap_or(Value::Null)
}

fn utf16_sorted(mut values: Vec<String>) -> Value {
    values.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    js::strings_value(values)
}

/// `out(value)` генератора.
fn out(value: &Value) -> Value {
    if value.as_str() == Some(U) {
        return value.clone();
    }
    let text = js::stringify(value);
    // `SK_VITALS_FULL=1` — печатать выход Rust целиком (отладка расхождений).
    if text.encode_utf16().count() > 160 && std::env::var_os("SK_VITALS_FULL").is_none() {
        Value::String(format!("sha256:{}", sk_core::hash::sha256_hex(text.as_bytes())))
    } else {
        value.clone()
    }
}

fn outcome<E: Into<Interrupt>>(result: Result<Value, E>) -> Value {
    match result.map_err(Into::into) {
        Ok(value) => json!({ "ok": out(&value) }),
        Err(Interrupt::Rule(error)) => json!({ "err": [error.code, error.message] }),
        Err(Interrupt::Fault(fault)) => json!({ "fault": fault.name }),
        Err(Interrupt::Pause(pause)) => json!({ "fault": pause.kind.name() }),
    }
}

/// Выход эталона без текста ошибки JS (тексты `TypeError` у V8 и Rust разные).
fn expected_outcome(expected: &Value) -> Value {
    match expected.get("fault") {
        Some(name) => json!({ "fault": name }),
        None => expected.clone(),
    }
}

fn ok(value: Value) -> Result<Value, Halt> {
    Ok(value)
}

fn run_call(f: &str, a: &Args<'_>) -> Result<Value, Halt> {
    let st = a.state;
    match f {
        // conditions.rs
        "freedomBlocksSpellCondition" => ok(json!(cond::freedom_blocks_spell_condition(st, &a.text(0), &a.text(1)))),
        "areaEffectSparesActor" => ok(json!(cond::area_effect_spares_actor(a.v(0), &a.text(1)))),
        "areaEffectAlreadyHolds" => ok(json!(cond::area_effect_already_holds(st, a.v(0), &a.text(1)))),
        "actorDoesNotNeedBreathing" => ok(json!(cond::actor_does_not_need_breathing(a.actor(0)))),
        "areaEffectAutomaticSave" => ok(cond::area_effect_automatic_save(st, &a.id(0), a.v(1))),
        "blessBonusEnabled" => ok(json!(cond::bless_bonus_enabled(st, &a.text(0)))),
        "checkAdvantageConditionFor" => ok(opt_string(cond::check_advantage_condition_for(st, &a.text(0), a.v(1)))),
        "autoFailedSaveConditionFor" => ok(opt_string(cond::auto_failed_save_condition_for(st, &a.text(0), a.v(1)))),
        "conditionNumericBonus" => ok(json!(cond::condition_numeric_bonus(st, &a.text(0), &a.text(1)))),
        "conditionWeaponDamageDice" => ok(Value::Array(cond::condition_weapon_damage_dice(st, &a.text(0), a.number(1)).iter().map(cond::ConditionDie::to_value).collect())),
        "saveAdvantageConditionFor" => ok(opt_string(cond::save_advantage_condition_for(st, &a.text(0), a.v(1)))),
        "conditionSaveBonusFor" => ok(json!(cond::condition_save_bonus_for(st, &a.text(0), a.v(1)))),
        "saveDisadvantageConditionFor" => ok(opt_string(cond::save_disadvantage_condition_for(st, &a.text(0), a.v(1)))),
        "savingThrowAgainstCondition" => {
            let (spell, against) = cond::saving_throw_against_condition(a.v(0), a.v(1));
            ok(json!({ "spell": spell, "against": against }))
        }
        "saveAdvantageAgainstConditionFor" => ok(opt_string(cond::save_advantage_against_condition_for(st, &a.text(0), a.v(1), a.v(2)))),
        "spellTimedConditionPayload" => ok(Value::Object(cond::spell_timed_condition_payload(st, a.v(0).unwrap_or(&Value::Null), a.v(1).unwrap_or(&Value::Null), a.flag(2)))),
        "exhaustionLevelOf" => ok(json!(cond::exhaustion_level_of(st, &a.text(0)))),
        "exhaustionStepDownEvents" => ok(Value::Array(cond::exhaustion_step_down_events(st, a.v(0).unwrap_or(&Value::Null), &a.text(1), a.v(2)))),
        "exhaustionStepUpEvents" => {
            let source = cond::ExhaustionSource { source_actor: a.v(2), effect_id: a.v(3), spell_id: a.v(4), trigger: a.v(5) };
            ok(Value::Array(cond::exhaustion_step_up_events(st, a.v(0).unwrap_or(&Value::Null), &a.text(1), source)))
        }
        "hitPointMaximumBonusOf" => ok(json!(cond::hit_point_maximum_bonus_of(st, &a.text(0)))),
        // skills.rs
        "enemyLoreCheckFor" => ok(skills::enemy_lore_check_for(a.actor(0))),
        "skillProficiencyForActor" => ok(skills::skill_proficiency_for_actor(a.actor(0), a.v(1), a.state_opt(2))),
        "savingThrowModifierForActor" => ok(json!(skills::saving_throw_modifier_for_actor(a.actor(0), a.v(1), a.v(2), a.state_opt(3), a.flag(4)))),
        "persuasionCheckModifier" => ok(json!(skills::persuasion_check_modifier(a.actor(0)))),
        "serverOwned2014StatBlockFor" => ok(json!(skills::server_owned_2014_stat_block_for(a.actor(0), Some(st)).is_some())),
        "canonicalSkillId" => ok(json!(skills::canonical_skill_id(a.v(0)))),
        "challengeRatingValue" => ok(js::num(skills::challenge_rating_value(a.v(0)))),
        "listedSkill" => ok(json!(skills::listed_skill(a.v(0), &a.text(1)))),
        "skillFromCondition" => ok(opt_string(skills::skill_from_condition(a.v(0).unwrap_or(&Value::Null), &a.text(1)))),
        // saves.rs
        "seesInMagicalDarkness" => ok(json!(saves::sees_in_magical_darkness(a.actor(0)))),
        "speciesSaveAdvantageFor" => ok(opt_string(saves::species_save_advantage_for(st, &a.id(0), a.v(1), a.v(2), a.v(3)))),
        "checkDisadvantageConditionFor" => ok(opt_string(saves::check_disadvantage_condition_for(st, &a.text(0), a.v(1)))),
        "fearSourceInSight" => ok(json!(saves::fear_source_in_sight(st, &a.text(0), &a.text(1)))),
        "frightenedSourceInSight" => ok(json!(saves::frightened_source_in_sight(st, &a.text(0)))),
        "contestDefenseCheck" => {
            let (ability, modifier) = saves::contest_defense_check(st, a.actor(0));
            ok(json!({ "ability": ability, "modifier": modifier }))
        }
        "passivePerception" => ok(js::num(saves::passive_perception(a.actor(0), a.state_opt(1)))),
        "hiddenStealthTotal" => ok(json!(saves::hidden_stealth_total(st, &a.text(0)))),
        "surprisedParticipants" => {
            let list = |index: usize| a.v(index).and_then(Value::as_array).map(|items| items.iter().map(|item| js::string(Some(item))).collect::<Vec<_>>()).unwrap_or_default();
            ok(js::strings_value(saves::surprised_participants(st, &list(0), &list(1))))
        }
        "activeTrueStrikeFor" => ok(json!(saves::active_true_strike_for(st, &a.text(0), &a.text(1)))),
        "conditionAttackModifiers" => {
            let kind = a.v(3).and_then(Value::as_str);
            let options = saves::AttackConditionOptions { distance_feet: a.number(2), profile_kind: kind, melee_reach_feet: a.v(4), weapon_attack: a.flag(5) };
            ok(saves::condition_attack_modifiers(st, &a.text(0), &a.text(1), options).to_value())
        }
        "activeAuraOfLifeSource" => ok(saves::active_aura_of_life_source(st, &a.text(0)).map_or(Value::Null, |aura| aura.to_value())),
        "activeAuraOfProtection" => ok(saves::active_aura_of_protection(st, &a.text(0)).map_or(Value::Null, |aura| aura.to_value())),
        "savingThrowModifierWithAura" => {
            let aura = saves::saving_throw_modifier_with_aura(st, &a.text(0), a.v(1))?;
            ok(json!({ "modifier": js::num(aura.modifier), "aura": aura.aura.map_or(Value::Null, |aura| aura.to_value()), "itemSavingThrowBonus": js::num(aura.item_saving_throw_bonus) }))
        }
        "isSavingThrowProficient" => ok(json!(saves::is_saving_throw_proficient(a.actor(0), a.v(1)))),
        "bloodiedFrenzySaveAdvantage" => ok(json!(saves::bloodied_frenzy_save_advantage(st, &a.text(0)))),
        "activeAntitoxinSaveAdvantage" => ok(saves::active_antitoxin_save_advantage(st, &a.text(0), a.v(1)).map_or(Value::Null, |expires| json!({ "expires_at_minutes": expires }))),
        "litByLightCantrip" => ok(json!(saves::lit_by_light_cantrip(st, &a.id(0)))),
        "weatherCheckSwingFor" => ok(saves::weather_check_swing_for(st, a.v(0), a.v(1)).unwrap_or(Value::Null)),
        "hasEvasion" => ok(json!(saves::has_evasion(st, &a.text(0)))),
        "savedDamageAmount" => ok(json!(saves::saved_damage_amount(st, &a.text(0), a.v(1), a.flag(2), a.flag(3), a.v(4)))),
        "dangerSenseAdvantage" => ok(json!(saves::danger_sense_advantage(st, &a.text(0), a.v(1)))),
        "checkRollFromVerified" => ok(saves::check_roll_from_verified(a.v(0), a.v(1).unwrap_or(&Value::Null)).unwrap_or(Value::Null)),
        "savingThrowSucceeded" => ok(json!(saves::saving_throw_succeeded(a.v(0), a.number(1).unwrap_or(f64::NAN)))),
        // damage.rs
        "resolvedHealingRoll" => ok(damage::resolved_healing_roll(st, &a.text(0), a.v(1), a.v(2))),
        "effectiveArmorClass" => Ok(js::num(damage::effective_armor_class(st, a.actor(0), &a.text(1))?)),
        "immuneToMagicalSleep" => ok(json!(damage::immune_to_magical_sleep(st, a.actor(0)))),
        "statBlockConditionImmunities" => ok(utf16_sorted(damage::stat_block_condition_immunities(st, &a.id(0)).into_iter().collect())),
        "defenseFor" => ok(damage::defense_for(st, &a.text(0)).to_value()),
        "damagePayload" => Ok(damage::damage_payload(st, &a.text(0), a.v(1), a.v(2), a.v(3), a.v(4))?),
        "conditionArmorClassBonus" => ok(json!(damage::condition_armor_class_bonus(st, &a.text(0)))),
        "statBlockDamageList" => ok(js::strings_value(damage::stat_block_damage_list(a.v(0)))),
        "conditionalDamageDefenseApplies" => ok(json!(damage::conditional_damage_defense_applies(a.v(0), a.v(1), a.v(2)))),
        "damagePayloadWithHpFloor" => ok(damage::damage_payload_with_hp_floor(a.v(0).unwrap_or(&Value::Null), a.v(1))),
        "spellHpPoolExpression" => Ok(Value::String(damage::spell_hp_pool_expression(a.v(0), a.v(1), a.v(2), a.v(3))?)),
        "withoutImmuneConditions" => {
            let events = a.v(1).and_then(Value::as_array).cloned().unwrap_or_default();
            ok(Value::Array(damage::without_immune_conditions(st, a.v(0).unwrap_or(&Value::Null), &events)))
        }
        // death.rs
        "fallsProneEvents" => ok(Value::Array(death::falls_prone_events(st, a.v(0).unwrap_or(&Value::Null), &a.text(1)))),
        "zeroHitPointDamageConsequences" => ok(Value::Array(death::zero_hit_point_damage_consequences(st, a.v(0).unwrap_or(&Value::Null), &a.text(1), a.v(2).unwrap_or(&Value::Null), a.flag(3)))),
        "assertRevivableHero" => death::assert_revivable_hero(st, &a.text(0), a.v(1).unwrap_or(&Value::Null)).map(|()| Value::String(U.into())),
        // rest.rs
        "restMinimumMinutesFor" => ok(json!(rest::rest_minimum_minutes_for(st, &a.id(0), &a.text(1)))),
        "hitPointDicePoolForActor" => ok(rest::hit_point_dice_pool_for_actor(st, &a.id(0)).map_or(Value::Null, rest::HitPointDicePool::to_value)),
        "elapsedRestMinutes" => ok(json!(rest::elapsed_rest_minutes(st, a.v(0)))),
        // lockpick.rs
        "lockpickCheckModifier" => ok(json!(lockpick::lockpick_check_modifier(a.actor(0)))),
        "lockpickNoticeEvents" => {
            let args = lockpick::LockpickNotice { target_kind: a.v(1), target_id: a.v(2), target_label: a.v(3), check: a.v(4), notice: a.v(5) };
            ok(Value::Array(lockpick::lockpick_notice_events(st, a.v(0).unwrap_or(&Value::Null), args)))
        }
        // indomitable.rs
        "indomitableOpportunitiesFor" => {
            let events = a.v(0).and_then(Value::as_array).cloned().unwrap_or_default();
            ok(Value::Array(indomitable::indomitable_opportunities_for(st, &events, a.v(1)).iter().map(indomitable::IndomitableOpportunity::to_value).collect()))
        }
        other => panic!("неизвестная функция эталона {other}"),
    }
}

fn state_of(index: &Value) -> &'static Value {
    static NULL: Value = Value::Null;
    match index.as_i64() {
        Some(index) if index >= 0 => &DATA["states"][index as usize],
        _ => &NULL,
    }
}

fn report(failures: &[String], total: usize) {
    assert!(failures.is_empty(), "расхождений {} из {total}:\n{}", failures.len(), failures.iter().take(if std::env::var_os("SK_VITALS_FULL").is_some() { 5000 } else { 8 }).cloned().collect::<Vec<_>>().join("\n"));
}

#[test]
fn pure_functions_match_js() {
    let calls = DATA["calls"].as_array().expect("вызовы");
    let mut failures = Vec::new();
    for case in calls {
        let f = case["f"].as_str().expect("имя");
        let state = state_of(&case["s"]);
        let args = Args::new(state, &case["a"]);
        let actual = outcome(run_call(f, &args));
        let expected = expected_outcome(&case["o"]);
        if js::stringify(&actual) != js::stringify(&expected) {
            failures.push(format!("{f} s={} a={}: Rust {} ожидалось {}", case["s"], js::stringify(&case["a"]).chars().take(300).collect::<String>(), actual, expected));
        }
    }
    report(&failures, calls.len());
}

fn sequence(values: &Value) -> ServiceDice<DiceService<SequenceRng>> {
    let values: Vec<i64> = values.as_array().map(|items| items.iter().filter_map(Value::as_i64).collect()).unwrap_or_default();
    ServiceDice::new(DiceService::deterministic(SequenceRng::new(values), "roll"))
}

fn method_of(value: Option<&Value>) -> saves::D20Method {
    if value.and_then(Value::as_str) == Some("rollCheck") { saves::D20Method::RollCheck } else { saves::D20Method::RollD20 }
}

fn run_dice(f: &str, a: &Args<'_>, dice: &mut dyn RulesDice) -> Result<Value, Halt> {
    let st = a.state;
    match f {
        "rollD20WithSpeciesLuck" => {
            let method = method_of(a.v(2));
            let mut options = a.v(1).and_then(Value::as_object).cloned().unwrap_or_default();
            if method == saves::D20Method::RollCheck {
                options.insert("difficulty".into(), json!(12));
            }
            Ok(saves::roll_d20_with_species_luck(st, dice, &a.id(0), &Value::Object(options), method)?)
        }
        "rollAbilityCheckWithConditions" => saves::roll_ability_check_with_conditions(st, dice, &a.text(0), a.v(1), a.v(2).unwrap_or(&Value::Null), method_of(a.v(3))),
        "grappleContest" => {
            let mut rolls = Vec::new();
            let result = saves::grapple_contest(st, dice, a.v(0).unwrap_or(&Value::Null), &a.text(1), &mut rolls)?;
            Ok(json!({ "result": result, "rolls": rolls }))
        }
        "rollSavingThrowD20" => saves::roll_saving_throw_d20(st, dice, &a.text(0), a.v(1).unwrap_or(&Value::Null)),
        "rollSavingThrowCheck" => saves::roll_saving_throw_check(st, dice, &a.text(0), a.v(1).unwrap_or(&Value::Null)),
        "deathSavingThrowAtTurnStart" => {
            let result = death::death_saving_throw_at_turn_start(st, a.v(0).unwrap_or(&Value::Null), &a.text(1), dice)?;
            Ok(json!({ "events": result.events, "rolls": result.rolls }))
        }
        other => panic!("неизвестный бросок эталона {other}"),
    }
}

#[test]
fn dice_functions_match_js() {
    let calls = DATA["dice"].as_array().expect("броски");
    let mut failures = Vec::new();
    for case in calls {
        let f = case["f"].as_str().expect("имя");
        let state = state_of(&case["s"]);
        let args = Args::with(state, &case["a"], deep_marker);
        let mut base = sequence(&case["v"]);
        let mut recording = Recording::new(&mut base);
        let actual = outcome(run_dice(f, &args, &mut recording));
        let transcript = Value::Array(recording.transcript.clone());
        let expected = expected_outcome(&case["o"]);
        if js::stringify(&actual) != js::stringify(&expected) || js::stringify(&transcript) != js::stringify(&case["t"]) {
            failures.push(format!(
                "{f} s={} a={}: Rust {} ожидалось {}\n  стенограмма Rust {}\n  стенограмма JS   {}",
                case["s"],
                js::stringify(&case["a"]).chars().take(300).collect::<String>(),
                actual,
                expected,
                js::stringify(&transcript).chars().take(600).collect::<String>(),
                js::stringify(&case["t"]).chars().take(600).collect::<String>()
            ));
        }
    }
    report(&failures, calls.len());
}

type Check = fn(&mut Validation<'_>) -> sk_rules::pause::Step;

fn block(name: &str) -> Check {
    use sk_rules::validate::BLOCKS;
    let wanted = match name {
        "b57" => "check_resolve_hero_death",
        "b58" => "check_rest",
        "b61" => "check_healing_dead_hero",
        "b62" => "check_reduce_hit_point_maximum",
        "b70" => "check_identify_enemy",
        other => panic!("блок {other}"),
    };
    BLOCKS.iter().find(|block| block.name == wanted).map(|block| block.check).expect("блок в таблице")
}

/// `actorFate` (6981): `command.actor_id ? state.mechanics.death.heroes[actor_id] : null`.
fn actor_fate(state: &Value, command: &Value) -> Option<Value> {
    if !js::truthy(command.get("actor_id")) {
        return None;
    }
    sk_core::game::mechanics(state).get("death").and_then(|death| death.get("heroes")).and_then(|heroes| heroes.get(js::string(command.get("actor_id")))).cloned()
}

#[test]
fn validate_blocks_match_js() {
    let commands = DATA["commands"].as_array().expect("команды");
    let cases = DATA["blocks"].as_array().expect("блоки");
    let mut failures = Vec::new();
    for case in cases {
        let input = &commands[case["input"].as_u64().expect("индекс") as usize];
        let state = state_of(&input["s"]);
        let context = Context::from_json(&input["context"]);
        let mut validation = Validation { state, command: input["command"].clone(), context: &context, actor_fate: actor_fate(state, &input["command"]) };
        let result = block(case["block"].as_str().expect("блок"))(&mut validation).map(|()| validation.command.clone());
        let actual = outcome(result);
        let mut expected = Map::new();
        for key in ["ok", "err", "fault"] {
            if let Some(value) = case.get(key) {
                expected.insert(key.into(), value.clone());
            }
        }
        let expected = expected_outcome(&Value::Object(expected));
        if js::stringify(&actual) != js::stringify(&expected) {
            failures.push(format!("{} {}: Rust {} ожидалось {}", case["block"], js::stringify(&input["command"]).chars().take(400).collect::<String>(), actual, expected));
        }
    }
    report(&failures, cases.len());
}

#[test]
fn resolve_branches_match_js() {
    let cases = DATA["branches"].as_array().expect("ветки");
    let mut failures = Vec::new();
    for case in cases {
        let state = state_of(&case["s"]);
        let context = Context::from_json(&case["context"]);
        let mut dice = sequence(&case["v"]);
        let mut uuid = sequence_uuids("uuid");
        let result = sk_rules::normalize::assume_normalized(|| sk_rules::resolve::vitals::resolve_branch_without_tail(case["command"].clone(), state, &mut dice, &context, &mut uuid));
        let actual = outcome(result.map(|resolved| json!({ "events": resolved.events, "rolls": resolved.rolls })));
        let expected = expected_outcome(&case["o"]);
        if js::stringify(&actual) != js::stringify(&expected) {
            failures.push(format!("{} {}: Rust {} ожидалось {}", case["command"]["command_type"], js::stringify(&case["command"]).chars().take(300).collect::<String>(), actual, expected));
        }
    }
    report(&failures, cases.len());
}

// --- перенесённые проверки JS ------------------------------------------------------

/// `test/enemy-identification.test.mjs`: навык и СЛ — по виду и опасности.
#[test]
fn enemy_lore_table_matches_js_tests() {
    let check = |actor: Value| skills::enemy_lore_check_for(Some(&actor));
    assert_eq!(check(json!({ "creature_type": "beast", "provenance": { "challenge_rating": "1/4" } })), json!({ "skill": "nature", "difficulty_category": "easy", "difficulty": 10, "challenge_rating": 0.25 }));
    assert_eq!(check(json!({ "creature_type": "construct", "provenance": { "challenge_rating": "3" } })), json!({ "skill": "arcana", "difficulty_category": "medium", "difficulty": 15, "challenge_rating": 3 }));
    assert_eq!(check(json!({ "creature_type": "undead", "provenance": { "challenge_rating": "21" } })), json!({ "skill": "religion", "difficulty_category": "hard", "difficulty": 20, "challenge_rating": 21 }));
    assert_eq!(check(json!({})), json!({ "skill": "arcana", "difficulty_category": "easy", "difficulty": 10, "challenge_rating": 0 }));
}

/// `test/exhaustion.test.mjs`: ступень истощения — из id состояния.
#[test]
fn exhaustion_level_matches_js_tests() {
    let at = |level: i64| {
        let conditions = if level > 0 { json!({ "hero": [{ "id": format!("exhaustion:{level}") }] }) } else { json!({}) };
        json!({ "players": [{ "id": "hero", "hp": 10 }], "mechanics": { "conditions": conditions } })
    };
    assert_eq!(cond::exhaustion_level_of(&at(0), "hero"), 0);
    assert_eq!(cond::exhaustion_level_of(&at(3), "hero"), 3);
    assert_eq!(cond::exhaustion_level_of(&at(6), "hero"), 6);
}

/// `test/rest-mechanics.test.mjs`: кость хитов — по классу, неизвестный класс — d8.
#[test]
fn hit_point_die_size_matches_js_tests() {
    let expected = [
        ("barbarian", 12), ("fighter", 10), ("paladin", 10), ("ranger", 10), ("bard", 8), ("cleric", 8), ("druid", 8),
        ("monk", 8), ("rogue", 8), ("warlock", 8), ("sorcerer", 6), ("wizard", 6), ("inventor", 8),
    ];
    let players: Vec<Value> = expected.iter().map(|(class, _)| json!({ "id": class, "characterClass": class, "level": 3, "hp": 10, "maxHp": 10, "abilities": { "con": 10 }, "inventory": [] })).collect();
    let state = json!({ "players": players, "mechanics": {} });
    for (id, die) in expected {
        assert_eq!(rest::hit_point_dice_pool_for_actor(&state, id).map(rest::HitPointDicePool::to_value), Some(json!({ "schema_version": 1, "maximum": 3, "spent": 0, "die_size": die })));
    }
}

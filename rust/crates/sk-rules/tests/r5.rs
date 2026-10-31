//! Сверка задачи Р5 с эталоном JS (`fixtures/r5.json.gz`, генератор —
//! `fixtures/gen-r5.mjs`): заклинания-помощники, реакции, последствия
//! областей, «Обессиливание», сверка концентрации, удар-открытие; замыкания
//! `resolveCommandInternal` (методы `Resolve`) со стенограммой костей; полный
//! `resolveCommand` и `resolveCommands` на ветках Р5 (мягкая проверка); блок
//! проверки 8.
//!
//! Вызов эталона — `{ f, s, a, o }`, как у `tests/vitals.rs`; ссылки в
//! аргументах — `$actor`, `$spell` (заклинание героя), `$canon` (карточка).

use std::io::Read;
use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::js;
use sk_dice::{DiceService, SequenceRng};
use sk_rules::areas::consequences as area;
use sk_rules::context::{sequence_uuids, Context};
use sk_rules::dice_record::{Recording, RulesDice, ServiceDice};
use sk_rules::outcome::Outcome;
use sk_rules::pause::{Halt, Interrupt};
use sk_rules::reactions as re;
use sk_rules::resolve::{api, kernel, opening_strike as os, post, Resolve, Resolved};
use sk_rules::spells::{components as comp, enervation as en, slots};

const FIXTURE: &[u8] = include_bytes!("../fixtures/r5.json.gz");
static DATA: LazyLock<Value> = LazyLock::new(|| {
    let mut text = String::new();
    flate2::read::GzDecoder::new(FIXTURE).read_to_string(&mut text).expect("эталон — gzip");
    serde_json::from_str(&text).expect("эталон — JSON")
});
static NORMALIZED: LazyLock<Vec<Value>> = LazyLock::new(|| {
    DATA["states"].as_array().expect("состояния").iter().map(|state| sk_rules::normalize::normalize_campaign_state(state).expect("нормализация")).collect()
});

const U: &str = "__undefined__";

fn deep(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(map.iter().filter(|(_, field)| field.as_str() != Some(U)).map(|(key, field)| (key.clone(), deep(field))).collect()),
        Value::Array(items) => Value::Array(items.iter().map(deep).collect()),
        other => other.clone(),
    }
}

fn ruleset_options(state: &Value) -> Value {
    match state.get("ruleset_id") {
        Some(ruleset) => json!({ "rulesetId": ruleset }),
        None => json!({}),
    }
}

/// Аргументы: `None` — `undefined`, ссылки разрешены в нормализованном состоянии.
struct Args {
    values: Vec<Option<Value>>,
}

impl Args {
    fn new(state: &Value, raw: &Value) -> Self {
        let values = raw
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[])
            .iter()
            .map(|item| {
                if item.as_str() == Some(U) {
                    return None;
                }
                if let Some(map) = item.as_object().filter(|map| map.len() == 1) {
                    if let Some(id) = map.get("$actor").and_then(Value::as_str) {
                        return sk_core::game::find_actor(state, id).cloned();
                    }
                    if let Some(Value::Array(pair)) = map.get("$spell") {
                        let actor = sk_core::game::find_actor(state, &js::s(pair.first()));
                        return sk_combat_content::combat_spells::combat_spell_for(actor, pair.get(1), Some(&ruleset_options(state)));
                    }
                    if let Some(id) = map.get("$canon") {
                        return sk_combat_content::combat_spells::canonical_combat_spell_for(Some(id), Some(&ruleset_options(state)));
                    }
                }
                Some(deep(item))
            })
            .collect();
        Self { values }
    }

    fn v(&self, index: usize) -> Option<&Value> {
        self.values.get(index).and_then(Option::as_ref)
    }

    /// Значение без `null` (`null` и `undefined` — `None`).
    fn some(&self, index: usize) -> Option<&Value> {
        self.v(index).filter(|value| !value.is_null())
    }

    fn id(&self, index: usize) -> String {
        js::s(self.v(index))
    }

    fn flag(&self, index: usize) -> bool {
        js::truthy(self.v(index))
    }

    fn number(&self, index: usize) -> f64 {
        js::number(self.v(index))
    }

    fn null(&self, index: usize) -> &Value {
        self.v(index).unwrap_or(&Value::Null)
    }
}

fn out(value: &Value) -> Value {
    if value.as_str() == Some(U) {
        return value.clone();
    }
    let text = js::stringify(value);
    if text.encode_utf16().count() > 160 && std::env::var_os("SK_R5_FULL").is_none() {
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
        Err(Interrupt::Pause(pause)) => json!({ "pause": pause.kind.class_name(), "window": out(&pause.window_event), "command": out(&pause.command), "prefix": out(&Value::Array(pause.prefix_events.clone())) }),
    }
}

fn expected_outcome(expected: &Value) -> Value {
    match expected.get("fault") {
        Some(name) => json!({ "fault": name }),
        None => expected.clone(),
    }
}

fn undefined() -> Value {
    Value::String(U.into())
}

fn opt(value: Option<Value>) -> Value {
    value.unwrap_or(Value::Null)
}

fn resolved_json(resolved: &Resolved) -> Value {
    json!({ "command": resolved.command, "events": resolved.events, "rolls": resolved.rolls })
}

fn result_of(value: &Value) -> Resolved {
    Resolved { command: value["command"].clone(), events: value["events"].as_array().cloned().unwrap_or_default(), rolls: value["rolls"].as_array().cloned().unwrap_or_default() }
}

fn spell_reactor(reactor: Option<re::SpellReactor>) -> Value {
    reactor.map_or(Value::Null, |reactor| json!([sk_core::game::actor_id(&reactor.actor), reactor.spell["id"], reactor.slot.to_value()]))
}

fn run_call(f: &str, s: usize, a: &Args) -> Result<Value, Halt> {
    let st = &NORMALIZED[s];
    let raw = &DATA["states"][s];
    let ok = |value: Value| -> Result<Value, Halt> { Ok(value) };
    match f {
        // slots.rs
        "creatureTypeFor" => ok(json!(slots::creature_type_for(a.v(0)))),
        "understandsSpellLanguage" => ok(json!(slots::understands_spell_language(a.v(0)))),
        "sculptSpellsLimit" => ok(a.v(1).map_or(Value::Null, |spell| json!(slots::sculpt_spells_limit(a.v(0), spell, a.v(2))))),
        "chooseSpellSlot" => Ok(opt(slots::choose_spell_slot(st, &a.id(0), a.v(1), a.v(2), a.v(3))?.map(|slot| slot.to_value()))),
        "scaledSpellDice" => ok(opt(slots::scaled_spell_dice(a.v(0), a.v(1), a.v(2)))),
        "scaledDiceExpression" => ok(json!(slots::scaled_dice_expression(&js::string(a.v(0)), a.v(1), a.v(2), a.v(3)))),
        "reactionSlotChoice" => match a.v(1) {
            Some(spell) => Ok(slots::reaction_slot_choice(st, &a.id(0), spell, a.null(2), a.v(3))?),
            None => ok(Value::Null),
        },
        "withSpellOptionOverrides" => ok(a.v(0).map_or_else(undefined, |spell| slots::with_spell_option_overrides(spell, a.v(1)))),
        "conditionsForSlotLevel" => ok(opt(slots::conditions_for_slot_level(a.v(0), a.v(1)).map(js::strings_value))),
        "delayedSpellDamageExpression" => ok(json!(slots::delayed_spell_damage_expression(a.null(0), a.v(1)))),
        "concentrationSaveAdvantageFor" => ok(json!(slots::concentration_save_advantage_for(a.v(0)))),
        "lifeDomainCaster" => ok(json!(slots::life_domain_caster(a.v(0)))),
        "assertBonusActionSpellAllowed" => match a.v(1) {
            Some(spell) => Ok(slots::assert_bonus_action_spell_allowed(st, &a.id(0), spell, a.v(2)).map(|()| undefined())?),
            None => ok(Value::Null),
        },
        "beamCountFor" => ok(json!(slots::beam_count_for(a.v(0), a.v(1), a.v(2)))),
        "hasMultipleBeams" => ok(json!(slots::has_multiple_beams(a.v(0)))),
        "spellProjectileCount" => ok(a.v(0).map_or(Value::Null, |spell| js::num(slots::spell_projectile_count(spell, a.v(1))))),
        "spellDamageEstimate" => ok(js::num(slots::spell_damage_estimate(a.v(0), a.v(1), a.v(2)))),
        // components.rs
        "spellInventoryFor" => ok(a.v(0).map_or(Value::Null, |actor| Value::Array(comp::spell_inventory_for(st, Some(actor))))),
        "spellMaterialPaymentFor" => ok(match (a.v(0), a.v(1)) {
            (Some(actor), Some(spell)) => comp::spell_material_payment_for(st, Some(actor), Some(spell)).map_or(Value::Null, |(item, quantity)| json!({ "item": item, "quantity": js::num(quantity) })),
            _ => Value::Null,
        }),
        "spellComponentCostEvents" => Ok(Value::Array(comp::spell_component_cost_events(st, a.null(0), a.v(1), &Context::from_json(a.null(2)))?)),
        "spellComponentAvailabilityFor" => ok(comp::spell_component_availability_for(st, a.v(0), a.v(1)).to_value()),
        "assertSpellComponentsAllowed" => comp::assert_spell_components_allowed(st, a.v(0), a.v(1), &Context::from_json(a.null(2))).map(|()| undefined()),
        // enervation.rs
        "silveryFortuneFor" => ok(opt(en::silvery_fortune_for(st, &a.id(0)))),
        "removeSilveryFortuneEvent" => ok(en::remove_silvery_fortune_event(a.null(0), st, &a.id(1), a.v(2).and_then(Value::as_str))),
        "hasEnervationContinuation" => ok(json!(en::has_enervation_continuation(raw))),
        "enervationReasons" => ok(sk_rules::enervation_link::enervation_link_for(st, a.v(0)).map_or(Value::Null, |link| json!([en::enervation_continuation_invalid_reason(st, &link), en::enervation_trigger_reason(st, &link)]))),
        "closeEnervationAfterOtherAction" => Ok(resolved_json(&en::close_enervation_after_other_action(result_of(a.null(0)), sk_rules::normalized::StateIn { raw, normalized: &sk_rules::normalized::NormalizedState::normalize(raw)? })?)),
        "closeEnervationAfterTriggers" => Ok(resolved_json(&en::close_enervation_after_triggers(result_of(a.null(0)), sk_rules::normalized::StateIn { raw, normalized: &sk_rules::normalized::NormalizedState::normalize(raw)? })?)),
        "closeFinishedSpellBuffs" => Ok(resolved_json(&en::close_finished_spell_buffs(result_of(a.null(0)), raw)?)),
        // reactions.rs
        "opportunityAttackers" => {
            let path = a.v(2).and_then(Value::as_array).cloned().unwrap_or_default();
            Ok(js::strings_value(re::opportunity_attackers(st, &a.id(0), a.v(1), &path)?.iter().map(sk_core::game::actor_id)))
        }
        "reactionOptionsAfterAttack" => match a.v(0) {
            Some(actor) => {
                let options = re::AttackReactionOptions {
                    hit: a.flag(1),
                    critical: a.flag(2),
                    attack_total: a.number(3),
                    armor_class: a.number(4),
                    damage: a.some(5).cloned(),
                    distance_feet: a.some(6).map(|value| js::number(Some(value))),
                    allow_parry: a.flag(7),
                    allow_riposte: a.flag(8),
                };
                Ok(Value::Array(re::reaction_options_after_attack(st, actor, &options)?))
            }
            None => ok(Value::Null),
        },
        "reactionOptionsAfterElementalDamage" => ok(Value::Array(re::reaction_options_after_elemental_damage(st, a.v(0), a.v(1)))),
        "protectiveAttackReactionOptions" => {
            let options = re::ProtectiveAttackOptions {
                hit: a.flag(1),
                critical: a.flag(2),
                attack_total: a.number(3),
                armor_class: a.number(4),
                damage_type: a.v(5).cloned(),
                distance_feet: a.some(6).map(|value| js::number(Some(value))),
            };
            Ok(Value::Array(re::protective_attack_reaction_options(st, a.v(0), &options)?))
        }
        "allyAttackReactionFor" => {
            let kind = if a.v(2).and_then(Value::as_str) == Some("cutting-words") { re::AllyReactionKind::CuttingWords } else { re::AllyReactionKind::Protection };
            ok(re::ally_attack_reaction_for(st, &a.id(0), &a.id(1), kind).map_or(Value::Null, |reactor| re::ally_attack_reaction_option(&reactor)))
        }
        "shieldReactionOption" => ok(opt(re::shield_reaction_option(st, a.v(0)))),
        "shieldConditionEvent" => ok(re::shield_condition_event(a.null(0), &a.id(1))),
        "absorbElementsConditionEvents" => ok(Value::Array(re::absorb_elements_condition_events(a.null(0), &a.id(1), a.v(2), a.v(3)))),
        "absorbElementsDamagePayload" => re::absorb_elements_damage_payload(a.null(0), st, &a.id(1)),
        "uncannyDodgeDamagePayload" => ok(re::uncanny_dodge_damage_payload(a.null(0))),
        "reducedReactionDamage" => ok(re::reduced_reaction_damage(a.v(0), a.v(1))),
        "counterspellReactionFor" => ok(spell_reactor(re::counterspell_reaction_for(st, &a.id(0)))),
        "silveryBarbsReactionFor" => ok(spell_reactor(re::silvery_barbs_reaction_for(st, &a.id(0), a.some(1).and_then(Value::as_str)))),
        "counterspellWindowFor" => ok(a.v(1).map_or(Value::Null, |spell| opt(re::counterspell_window_for(st, a.null(0), spell)))),
        "heroReactionModesFor" => ok(Value::Array(re::hero_reaction_modes_for(st, a.v(0)))),
        // areas/consequences.rs
        "areaTriggerTurnKey" => ok(opt(area::area_trigger_turn_key(st).map(Value::String))),
        "areaEffectTriggeredThisTurn" => ok(json!(area::area_effect_triggered_this_turn(st, a.v(0), &a.id(1)))),
        "areaTriggerMarkEvent" => ok(opt(area::area_trigger_mark_event(st, a.null(0), a.v(1), &a.id(2), &a.id(3)))),
        "wearsMetalArmor" => ok(json!(area::wears_metal_armor(a.v(0)))),
        // post.rs
        "concentrationReconciliationEvents" => {
            let events = a.v(1).and_then(Value::as_array).cloned().unwrap_or_default();
            Ok(Value::Array(post::concentration_reconciliation_events(st, a.null(0), &events)?))
        }
        // opening_strike.rs
        "openingStrikeFor" => Ok(match os::opening_strike_for(a.null(0), sk_rules::normalized::StateIn { raw, normalized: &sk_rules::normalized::NormalizedState::normalize(raw)? }, &Context::from_json(a.null(1)))? {
            Some(strike) => {
                let mut map = Map::new();
                map.insert("actor_id".into(), Value::String(strike.actor_id));
                map.insert("command_type".into(), Value::String(strike.command_type));
                if let Some(npc) = strike.npc_id {
                    map.insert("npc_id".into(), Value::String(npc));
                }
                Value::Object(map)
            }
            None => Value::Null,
        }),
        "openingStrikeTurnState" => {
            let mut state = os::opening_strike_turn_state(st, raw, &a.id(0), a.v(1))?;
            sk_rules::reduce::strip_derived(&mut state);
            Ok(state)
        }
        other => panic!("неизвестная функция эталона {other}"),
    }
}

fn report(failures: &[String], total: usize) {
    assert!(failures.is_empty(), "расхождений {} из {total}:\n{}", failures.len(), failures.iter().take(if std::env::var_os("SK_R5_FULL").is_some() { 400 } else { 10 }).cloned().collect::<Vec<_>>().join("\n"));
}

#[test]
fn helpers_match_js() {
    let calls = DATA["calls"].as_array().expect("вызовы");
    let mut failures = Vec::new();
    for case in calls {
        let f = case["f"].as_str().expect("имя");
        let s = case["s"].as_u64().expect("состояние") as usize;
        let args = Args::new(&NORMALIZED[s], &case["a"]);
        let actual = outcome(run_call(f, s, &args));
        let expected = expected_outcome(&case["o"]);
        if js::stringify(&actual) != js::stringify(&expected) {
            failures.push(format!("{f} s={s} a={}: Rust {} ожидалось {}", js::stringify(&case["a"]).chars().take(300).collect::<String>(), actual, expected));
        }
    }
    report(&failures, calls.len());
}

fn sequence(values: &Value) -> ServiceDice<DiceService<SequenceRng>> {
    let values: Vec<i64> = values.as_array().map(|items| items.iter().filter_map(Value::as_i64).collect()).unwrap_or_default();
    ServiceDice::new(DiceService::deterministic(SequenceRng::new(values), "roll"))
}

/// Контекст разбора после подготовки `resolveCommandInternal` для уже
/// проверенной команды (без прокси NPC и вероломства — генератор их обходит).
fn resolve_for<'a>(raw: &Value, command: Value, context: &Context, dice: &'a mut dyn RulesDice, uuid: sk_rules::context::Uuid<'a>) -> Resolve<'a> {
    let depth = context.resolve_depth().max(0);
    let context = context.with("__resolve_depth", Value::from(depth + 1));
    let state = sk_rules::normalize::normalize_campaign_state(raw).expect("нормализация");
    let projector = sk_rules::replay::CommandProjector::new(&state);
    let target_id = sk_rules::core::target_for(&command);
    let resistance_choices = sk_rules::pause::resistance_choices_from_context(context.get("resistanceChoices"));
    let elemental_reaction_choices = sk_rules::resolve::reaction_choices(context.get("elementalDamageChoices"), "damage_key");
    let protective_reaction_choices = sk_rules::resolve::reaction_choices(context.get("protectiveReactionChoices"), "key");
    let truce_before_command = sk_society::parley::truce_for(&state);
    Resolve {
        state,
        command,
        context,
        depth,
        dice: Recording::new(dice),
        uuid,
        events: Vec::new(),
        rolls: Vec::new(),
        target_id,
        inspiration_spent: IndexSet::new(),
        resistance_cantrip_uses: IndexSet::new(),
        resistance_choices,
        resistance_used_targets: IndexSet::new(),
        resistance_save_sequence: 0,
        elemental_reaction_choices,
        elemental_reaction_sequence: 0,
        protective_reaction_choices,
        nested_consequences_resolved: false,
        truce_before_command,
        legendary_spends_in_command: IndexMap::new(),
        oiled_targets: IndexSet::new(),
        projector,
    }
}

fn run_probe(r: &mut Resolve<'_>, f: &str, a: &[Option<Value>]) -> Result<Value, Interrupt> {
    let st = r.state.clone();
    let v = |index: usize| a.get(index).and_then(Option::as_ref);
    let some = |index: usize| v(index).filter(|value| !value.is_null());
    match f {
        "spendBardicInspiration" => Ok(json!(r.spend_bardic_inspiration(&st, v(0), &js::string(v(1)))?)),
        "damageTurnKey" => Ok(json!(r.damage_turn_key(&st))),
        "consumeResistanceBonus" => Ok(json!(r.consume_resistance_bonus(&st, &js::s(v(0)), v(1).unwrap_or(&Value::Null))?)),
        "resistanceSaveState" => {
            let state = r.resistance_save_state(&st, v(0), v(1).unwrap_or(&json!({})))?;
            let mut map = Map::new();
            map.insert("bonus".into(), json!(state.bonus));
            map.insert("condition".into(), opt(state.condition));
            map.insert("saveKey".into(), opt(state.save_key.map(Value::String)));
            map.insert("mode".into(), Value::String(state.mode));
            Ok(Value::Object(map))
        }
        "rollSavingThrow" => r.roll_saving_throw(&st, v(0), &with_markers(v(1))),
        "areaSaveModifierFor" => {
            let result = r.area_save_modifier_for(&st, v(0))?;
            Ok(json!({ "modifier": result.modifier, "events": result.events }))
        }
        "legendaryResistanceFor" => {
            let conditions = v(1).and_then(Value::as_array).cloned().unwrap_or_default();
            Ok(r.legendary_resistance_for(&st, v(0), &conditions, js::number(v(2))).map_or(Value::Null, |result| Value::Array(result.events)))
        }
        "resolveDamagePayload" => r.resolve_damage_payload(&st, &js::s(v(0)), v(1).cloned().unwrap_or(Value::Null), v(2).unwrap_or(&Value::Null), some(3), some(4)),
        "prepareElementalReactionDamage" => r.prepare_elemental_reaction_damage(&st, &js::s(v(0)), v(1).cloned().unwrap_or(Value::Null), some(2), None),
        "resolveDamageWithReactions" => r.resolve_damage_with_reactions(&st, &js::s(v(0)), v(1).cloned().unwrap_or(Value::Null), v(2).unwrap_or(&Value::Null), None, None),
        "appendMagicMissileResolution" => {
            let Some(target) = sk_core::game::find_actor(&st, &js::s(v(0))).cloned() else { return Ok(json!("no-target")) };
            let spell = sk_combat_content::combat_spells::canonical_combat_spell_for(Some(&json!("magic-missile")), Some(&ruleset_options(&st))).unwrap_or(Value::Null);
            let command = r.command.clone();
            let force = json!("force");
            r.append_magic_missile_resolution(kernel::MagicMissile { source_command: &command, spell: &spell, target: &target, slot_level: v(1), damage_type: &force, source_item: some(2) })?;
            Ok(undefined())
        }
        "rollAmount" => Ok(json!(r.roll_amount(&js::string(v(0)), v(1).map_or(0.0, |value| js::number(Some(value))))?)),
        "areaEntryConsequences" => Ok(Value::Array(r.area_entry_consequences(&st, &js::s(v(0)), v(1), v(2), v(3).and_then(Value::as_str))?)),
        "areaTurnConsequences" => Ok(Value::Array(r.area_turn_consequences(&st, v(0), v(1).and_then(Value::as_str))?)),
        other => panic!("неизвестное замыкание {other}"),
    }
}

/// Опции броска: поле `undefined` держит место ключа маркером.
fn with_markers(value: Option<&Value>) -> Value {
    fn walk(value: &Value) -> Value {
        match value {
            Value::Object(map) => Value::Object(map.iter().map(|(key, field)| (key.clone(), if field.as_str() == Some(U) { Value::String(js::UNDEFINED.into()) } else { walk(field) })).collect()),
            other => other.clone(),
        }
    }
    value.map(walk).unwrap_or_else(|| json!({}))
}

#[test]
fn closures_match_js() {
    let probes = DATA["probes"].as_array().expect("замыкания");
    let mut failures = Vec::new();
    for case in probes {
        let s = case["s"].as_u64().expect("состояние") as usize;
        let raw = &DATA["states"][s];
        let f = case["f"].as_str().expect("имя");
        let context = Context::from_json(&deep(&case["context"]));
        let mut dice = sequence(&case["v"]);
        let mut uuid = sequence_uuids("uuid");
        let mut r = resolve_for(raw, case["command"].clone(), &context, &mut dice, &mut uuid);
        let args: Vec<Option<Value>> = case["a"].as_array().map(Vec::as_slice).unwrap_or(&[]).iter().map(|item| if item.as_str() == Some(U) { None } else if f == "rollSavingThrow" { Some(item.clone()) } else { Some(deep(item)) }).collect();
        let actual = json!({
            "o": outcome(run_probe(&mut r, f, &args)),
            "events": out(&Value::Array(r.events.clone())),
            "rolls": out(&Value::Array(r.rolls.clone())),
            "t": out(&Value::Array(r.dice.transcript.clone())),
        });
        let expected = json!({ "o": expected_outcome(&case["o"]), "events": case["events"], "rolls": case["rolls"], "t": case["t"] });
        if js::stringify(&actual) != js::stringify(&expected) {
            failures.push(format!("{f} s={s} a={}: Rust {} ожидалось {}", js::stringify(&case["a"]).chars().take(300).collect::<String>(), actual, expected));
        }
    }
    report(&failures, probes.len());
}

#[test]
fn resolve_command_matches_js() {
    let cases = DATA["resolves"].as_array().expect("разборы");
    let mut failures = Vec::new();
    for case in cases {
        let s = case["s"].as_u64().expect("состояние") as usize;
        let raw = &DATA["states"][s];
        let input = deep(&case["input"]);
        let context = Context::from_json(&case["context"]);
        let mut dice = sequence(&case["v"]);
        let mut uuid = sequence_uuids("uuid");
        let result = api::with_lenient_validation(|| api::resolve_command(&input, raw, &mut dice, &context, &mut uuid)).map(Outcome::into_resolved).map_err(Interrupt::from);
        let actual = outcome(result.map(|resolved| resolved_json(&resolved)));
        let expected = expected_outcome(&case["o"]);
        if js::stringify(&actual) != js::stringify(&expected) {
            failures.push(format!("{} s={s}: Rust {} ожидалось {}", input["command_type"], actual, expected));
        }
    }
    report(&failures, cases.len());
}

#[test]
fn resolve_commands_matches_js() {
    let cases = DATA["plans"].as_array().expect("планы");
    let mut failures = Vec::new();
    for case in cases {
        let s = case["s"].as_u64().expect("состояние") as usize;
        let raw = &DATA["states"][s];
        let commands: Vec<Value> = case["commands"].as_array().map(|items| items.iter().map(deep).collect()).unwrap_or_default();
        let context = Context::from_json(&json!({ "isAdmin": true }));
        let mut dice = sequence(&case["v"]);
        let mut uuid = sequence_uuids("uuid");
        let result = api::with_lenient_validation(|| api::resolve_commands(&commands, raw, &mut dice, &context, false, &mut uuid)).map_err(Interrupt::from);
        let actual = outcome(result.map(|plan| {
            let mut state = plan.state;
            sk_rules::reduce::strip_derived(&mut state);
            json!({ "commands": plan.commands, "events": plan.events, "rolls": plan.rolls, "state": state })
        }));
        let expected = expected_outcome(&case["o"]);
        if js::stringify(&actual) != js::stringify(&expected) {
            failures.push(format!("план s={s}: Rust {} ожидалось {}", actual, expected));
        }
    }
    report(&failures, cases.len());
}

#[test]
fn social_check_block_matches_js() {
    let block = sk_rules::validate::BLOCKS.iter().find(|block| block.name == "check_social_check").expect("блок 8");
    let cases = DATA["blocks"].as_array().expect("блоки");
    let mut failures = Vec::new();
    for case in cases {
        let s = case["s"].as_u64().expect("состояние") as usize;
        let context = Context::from_json(&case["context"]);
        let mut validation = sk_rules::validate::Validation { state: &NORMALIZED[s], command: case["command"].clone(), context: &context, actor_fate: None };
        let actual = outcome((block.check)(&mut validation).map(|()| validation.command.clone()));
        let expected = expected_outcome(&case["o"]);
        if js::stringify(&actual) != js::stringify(&expected) {
            failures.push(format!("блок 8 s={s}: Rust {} ожидалось {}", actual, expected));
        }
    }
    report(&failures, cases.len());
}

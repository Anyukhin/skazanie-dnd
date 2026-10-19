//! Сверка задачи Р3 с эталоном JS (`fixtures/combat-r3.json.gz`, генератор —
//! `fixtures/gen-combat-r3.mjs`): оружие и профили атаки, умения классов,
//! предметы NPC, монстры и легендарные действия, экономика хода и
//! `assertTurn`, сборка встречи; броски со стенограммой; блоки
//! `validateCommand` 50–53 на записях корпуса и синтетике.
//!
//! Вызов эталона — `{ f, s, a, o }`, как у `tests/vitals.rs`. Контекст с
//! серверными маркерами — поле `__marks` (`monk`, `loading`, `offhand`).

use std::io::Read;
use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_core::js;
use sk_dice::{DiceService, SequenceRng};
use sk_rules::combat::{class_features as cf, encounter as enc, monsters as mon, npc_items as npc, turn, weapons as w};
use sk_rules::context::Context;
use sk_rules::dice_record::{Recording, RulesDice, ServiceDice};
use sk_rules::pause::Halt;
use sk_rules::validate::Validation;

const FIXTURE: &[u8] = include_bytes!("../fixtures/combat-r3.json.gz");
static DATA: LazyLock<Value> = LazyLock::new(|| {
    let mut text = String::new();
    flate2::read::GzDecoder::new(FIXTURE).read_to_string(&mut text).expect("эталон — gzip");
    serde_json::from_str(&text).expect("эталон — JSON")
});

const U: &str = "__undefined__";

fn deep(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(map.iter().filter(|(_, field)| field.as_str() != Some(U)).map(|(key, field)| (key.clone(), deep(field))).collect()),
        Value::Array(items) => Value::Array(items.iter().map(deep).collect()),
        other => other.clone(),
    }
}

struct Args<'a> {
    state: &'a Value,
    values: Vec<Option<Value>>,
    actors: Vec<Option<&'a Value>>,
}

impl<'a> Args<'a> {
    fn new(state: &'a Value, raw: &'a Value) -> Self {
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
                values.push(Some(deep(item)));
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

    /// `String(x ?? '')`.
    fn id(&self, index: usize) -> String {
        js::s(self.v(index))
    }

    /// `String(x)`.
    fn text(&self, index: usize) -> String {
        js::string(self.v(index))
    }

    fn flag(&self, index: usize) -> bool {
        js::truthy(self.v(index))
    }

    fn owned(&self, index: usize) -> Value {
        self.v(index).cloned().unwrap_or(Value::Null)
    }
}

fn context_of(raw: Option<&Value>) -> Context {
    let mut fields = raw.cloned().unwrap_or_else(|| json!({}));
    let marks = fields.as_object_mut().and_then(|map| map.shift_remove("__marks"));
    let mut context = Context::from_json(&deep(&fields));
    if let Some(marks) = marks {
        context.monk_bonus_attack = js::is_true(marks.get("monk"));
        context.loading_action_type = marks.get("loading").cloned();
        context.offhand_attack = js::is_true(marks.get("offhand"));
    }
    context
}

fn out(value: &Value) -> Value {
    if value.as_str() == Some(U) {
        return value.clone();
    }
    let text = js::stringify(value);
    if text.encode_utf16().count() > 200 {
        Value::String(format!("sha256:{}", sk_core::hash::sha256_hex(text.as_bytes())))
    } else {
        value.clone()
    }
}

fn outcome(result: Result<Value, Halt>) -> Value {
    match result {
        Ok(value) => json!({ "ok": out(&value) }),
        Err(Halt::Rule(error)) => json!({ "err": [error.code, error.message] }),
        Err(Halt::Fault(fault)) => json!({ "fault": fault.name }),
        Err(Halt::Pause(pause)) => json!({ "fault": pause.kind.name() }),
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

fn ok(value: Value) -> Result<Value, Halt> {
    Ok(value)
}

fn opt(value: Option<Value>) -> Value {
    value.unwrap_or(Value::Null)
}

fn opt_ref(value: Option<&Value>) -> Value {
    value.cloned().unwrap_or(Value::Null)
}

fn attack_options<'a>(a: &'a Args<'_>, mode: usize, ability: usize, off_hand: Option<usize>) -> w::AttackOptions<'a> {
    w::AttackOptions { attack_mode: a.v(mode), attack_ability: a.v(ability), off_hand: off_hand.is_some_and(|index| a.flag(index)) }
}

fn npc_world(state: &Value) -> Value {
    state.get("npc_world").cloned().unwrap_or_else(undefined)
}

fn run_call(f: &str, a: &Args<'_>) -> Result<Value, Halt> {
    let st = a.state;
    match f {
        // weapons.rs
        "trustedAttackProfile" => w::trusted_attack_profile(st, a.actor(0), a.v(1)),
        "combatItem" => ok(opt_ref(w::combat_item(a.actor(0), &a.text(1)))),
        "itemInstanceKey" => ok(json!(w::item_instance_key(a.v(0)))),
        "combatItemForCommand" => ok(opt_ref(w::combat_item_for_command(a.actor(0), a.v(1)))),
        "weaponCatalogKey" => ok(json!(w::weapon_catalog_key(a.v(0)))),
        "shillelaghConditionFor" => ok(opt_ref(w::shillelagh_condition_for(st, &a.text(0), a.v(1)))),
        "shillelaghConditionsFor" => {
            let key = a.v(1).filter(|value| !value.is_null()).map(|value| js::string(Some(value)));
            ok(Value::Array(w::shillelagh_conditions_for(st, &a.text(0), key.as_deref()).into_iter().cloned().collect()))
        }
        "shillelaghRemovalEvents" => {
            let item_key = a.v(1).filter(|value| !value.is_null()).map(|value| js::string(Some(value)));
            let exclude = a.v(2).filter(|value| !value.is_null()).map(|value| js::string(Some(value)));
            let reason = a.v(3).map(|value| js::string(Some(value)));
            let options = w::ShillelaghRemoval { item_key: item_key.as_deref(), exclude_item_key: exclude.as_deref(), reason: reason.as_deref() };
            ok(Value::Array(w::shillelagh_removal_events(st, &a.owned(0), options)))
        }
        "shillelaghWeaponFor" => ok(opt_ref(w::shillelagh_weapon_for(a.v(0)))),
        "magicalWeaponConditionFor" => ok(json!(w::magical_weapon_condition_for(st, &a.text(0)))),
        "monsterWeaponAttacksMagical" => ok(json!(w::monster_weapon_attacks_magical(a.actor(0)))),
        "itemAttackProfile" => ok(opt(w::item_attack_profile(st, a.actor(0), a.v(1), attack_options(a, 2, 3, Some(4))))),
        "weaponDamageSourceFor" => ok(opt(w::weapon_damage_source_for(st, a.actor(0), a.v(1), a.v(2).filter(|value| !value.is_null()), a.v(3).filter(|value| !value.is_null())))),
        "weaponCriticalThreshold" => ok(json!(w::weapon_critical_threshold(st, a.actor(0)))),
        "offHandWeaponFor" => ok(opt_ref(w::off_hand_weapon_for(a.actor(0)))),
        "attackKindFor" => ok(json!(w::attack_kind_for(a.v(0), a.v(1), a.v(2)))),
        "heroAmmunitionSupply" => ok(opt(w::hero_ammunition_supply(a.actor(0), a.v(1)))),
        "heroAmmunitionExpenditure" => ok(opt(w::hero_ammunition_expenditure(a.actor(0), a.v(1)))),
        "equippedWeaponAttacks" => ok(Value::Array(w::equipped_weapon_attacks(st, a.actor(0)).into_iter().map(|entry| json!({ "itemId": entry.item_id, "profile": entry.profile })).collect())),
        "swingDetailsFor" => {
            let details = w::swing_details_for(st, &a.text(0), a.v(1), a.flag(2))?;
            Ok(json!({
                "prop": details.prop,
                "profile": details.profile,
                "anchor": { "x": js::num(details.anchor.x), "y": js::num(details.anchor.y) },
                "actor": sk_core::game::actor_id(&details.actor),
                "from": { "x": js::num(details.from.x), "y": js::num(details.from.y) },
                "reachHeight": js::num(details.reach_height),
            }))
        }
        "averageDamageOf" => ok(js::num(w::average_damage_of(a.v(0)))),
        "attackProfileFor" => Ok(opt(w::attack_profile_for(st, &a.id(0), a.v(1))?)),
        "weaponAttackProfileFor" => ok(opt(w::weapon_attack_profile_for(st, &a.id(0), a.v(1), attack_options(a, 2, 3, None)))),
        "opportunityAttackProfile" => Ok(w::opportunity_attack_profile(st, a.actor(0))?.map_or(Value::Null, |entry| json!({ "profile": entry.profile, "item_id": entry.item_id }))),
        "criticalDamageExpression" => Ok(json!(w::critical_damage_expression(&a.text(0))?)),
        "weaponCoatingRiderFor" => ok(opt(w::weapon_coating_rider_for(st, a.v(0), a.v(1)))),
        // class_features.rs
        "monkMartialArtsAttackProfile" => cf::monk_martial_arts_attack_profile(a.actor(0)),
        "weaponFightingStyleBonus" => {
            let properties: Vec<String> = a.v(3).and_then(Value::as_array).map(|items| items.iter().map(|item| js::string(Some(item))).collect()).unwrap_or_default();
            ok(cf::weapon_fighting_style_bonus(a.actor(0), a.v(1), &a.owned(2), &properties).to_value())
        }
        "bardicInspirationFor" => ok(cf::bardic_inspiration_for(st, &a.text(0)).map_or(Value::Null, |entry| entry.to_value())),
        "bardicInspirationDieSides" => ok(json!(cf::bardic_inspiration_die_sides(a.actor(0)))),
        "divineSmiteActionFor" | "fontOfMagicActionFor" | "layOnHandsActionFor" => {
            let mut command = a.owned(0);
            let action = a.owned(1);
            let result = match f {
                "divineSmiteActionFor" => cf::divine_smite_action_for(st, &mut command, &action)?,
                "fontOfMagicActionFor" => cf::font_of_magic_action_for(st, &mut command, &action)?,
                _ => cf::lay_on_hands_action_for(st, &mut command, &action)?,
            };
            Ok(json!({ "result": result, "command": command }))
        }
        "colossusSlayerReady" => ok(json!(cf::colossus_slayer_ready(st, a.actor(0), a.actor(1)))),
        "sneakAttackDiceCount" => ok(json!(cf::sneak_attack_dice_count(a.actor(0)))),
        "sneakAttackSupportingAlly" => ok(json!(cf::sneak_attack_supporting_ally(st, &a.id(0), &a.id(1)).map(sk_core::game::actor_id).unwrap_or_default())),
        "assertMonkUnarmedActionAllowed" => cf::assert_monk_unarmed_action_allowed(st, a.actor(0), a.v(1)).map(|()| undefined()),
        // npc_items.rs
        "validateNpcItemUseCommand" => npc::validate_npc_item_use_command(&a.owned(0), st, &context_of(a.v(1))),
        "npcEquipmentSpentEvent" => ok(npc::npc_equipment_spent_event(&a.owned(0), &a.owned(1))),
        // monsters.rs
        "monsterSpellUsesSpent" => ok(json!(mon::monster_spell_uses_spent(st, &a.text(0), &a.text(1)))),
        "validateMonsterSpellCommand" => mon::validate_monster_spell_command(&a.owned(0), st, &context_of(a.v(1))),
        "validateLegendaryActionCommand" => mon::validate_legendary_action_command(&a.owned(0), st, &context_of(a.v(1))),
        "legendaryActionsResetAtTurnStart" => ok(Value::Array(mon::legendary_actions_reset_at_turn_start(st, &a.owned(0), a.v(1)))),
        "npcDamageContext" => ok(mon::npc_damage_context(st, &a.id(0)).into_owned()),
        "monsterMultiattackActionCounts" => ok(Value::Array(mon::monster_multiattack_action_counts(a.v(0)).into_iter().map(|(id, count)| json!([id, count])).collect())),
        "monsterMultiattackActionIds" => Ok(js::strings_value(mon::monster_multiattack_action_ids(a.actor(0), a.v(1), a.v(2))?)),
        "syncNpcWorldVital" => {
            let mut copy = st.clone();
            mon::sync_npc_world_vital(&mut copy, &a.id(0), a.v(1), a.v(2), a.v(3).cloned());
            ok(npc_world(&copy))
        }
        "syncAuthoredNpcVital" => {
            let mut copy = st.clone();
            mon::sync_authored_npc_vital(&mut copy, &a.text(0), a.v(1), a.v(2));
            ok(npc_world(&copy))
        }
        "syncSocialNpcVital" => {
            let mut copy = st.clone();
            mon::sync_social_npc_vital(&mut copy, &a.id(0), a.v(1), a.v(2), a.v(3));
            ok(npc_world(&copy))
        }
        // turn.rs
        "initiativeGroupIds" => ok(js::strings_value(turn::initiative_group_ids(st))),
        "isActiveTurnActor" => ok(json!(turn::is_active_turn_actor(st, &a.text(0)))),
        "isOwnCombatTurn" => ok(json!(turn::is_own_combat_turn(st, a.v(0)))),
        "crossbowExpertFor" => ok(json!(turn::crossbow_expert_for(a.actor(0)))),
        "crossbowProfileFor" => ok(json!(turn::crossbow_profile_for(a.v(0)))),
        "loadingWeaponLimitApplies" => ok(json!(turn::loading_weapon_limit_applies(st, a.actor(0), a.v(1)))),
        "loadingWeaponUsed" => ok(json!(turn::loading_weapon_used(a.v(0), &a.text(1), a.v(2)))),
        "hasteActionAllows" => ok(json!(turn::haste_action_allows(a.v(0)))),
        "hasUntouchedNormalActionFrame" => ok(json!(turn::has_untouched_normal_action_frame(a.v(0)))),
        "hasteOnlyActionFrame" => ok(json!(turn::haste_only_action_frame(a.v(0)))),
        "attackActionPlan" => ok(turn::attack_action_plan(st, &a.owned(0), &context_of(a.v(1))).to_value()),
        "assertTurn" => turn::assert_turn(&a.owned(0), st, &context_of(a.v(1))).map(|()| undefined()),
        "assertActorPermission" => turn::assert_actor_permission(&a.owned(0), &context_of(a.v(1)), st).map(|()| undefined()),
        "commandRequiresNormalActionFrame" => ok(json!(turn::command_requires_normal_action_frame(&a.owned(0), a.v(1)))),
        "validateAttackNpcCommand" => {
            let mut command = a.owned(0);
            enc::validate_attack_npc_command(&mut command, st)?;
            Ok(command)
        }
        "assembleEncounterFromState" => enc::assemble_encounter_from_state(st, &a.owned(0)),
        // encounter.rs
        "authoredOfficeParticipants" => ok(js::strings_value(enc::authored_office_participants(st, &a.text(0)))),
        "isEmptyHeroSeat" => ok(json!(enc::is_empty_hero_seat(a.actor(0)))),
        "encounterAssemblyInput" => {
            let input = enc::encounter_assembly_input(st, &Default::default())?;
            Ok(json!({ "party": input.party, "cells": input.cells }))
        }
        "npcCombatRequestFingerprint" => ok(json!(enc::npc_combat_request_fingerprint(&a.owned(0)))),
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
    let limit = if std::env::var_os("SK_R3_FULL").is_some() { 5000 } else { 10 };
    assert!(failures.is_empty(), "расхождений {} из {total}:\n{}", failures.len(), failures.iter().take(limit).cloned().collect::<Vec<_>>().join("\n"));
}

/// `SK_R3_ONLY=имя` — сверять одну функцию.
fn selected(f: &str) -> bool {
    std::env::var("SK_R3_ONLY").map_or(true, |only| only.split(',').any(|name| name == f))
}

#[test]
fn functions_match_js() {
    let calls = DATA["calls"].as_array().expect("вызовы");
    let mut failures = Vec::new();
    let mut checked = 0;
    for case in calls {
        let f = case["f"].as_str().expect("имя");
        if !selected(f) {
            continue;
        }
        checked += 1;
        let state = match case.get("bs").and_then(Value::as_u64) {
            Some(index) => &DATA["block_states"][index as usize],
            None => state_of(&case["s"]),
        };
        let args = Args::new(state, &case["a"]);
        let raw = run_call(f, &args);
        let full = if std::env::var_os("SK_R3_FULL").is_some() { format!(" полностью {}", raw.as_ref().map(js::stringify).unwrap_or_default().chars().take(1500).collect::<String>()) } else { String::new() };
        let actual = outcome(raw);
        let expected = expected_outcome(&case["o"]);
        if js::stringify(&actual) != js::stringify(&expected) {
            failures.push(format!("{f} s={} a={}: Rust {} ожидалось {}{full}", case["s"], js::stringify(&case["a"]).chars().take(300).collect::<String>(), actual, expected));
        }
    }
    assert!(checked > 0 || std::env::var_os("SK_R3_ONLY").is_some(), "эталон пуст");
    report(&failures, checked);
}

fn sequence(values: &Value) -> ServiceDice<DiceService<SequenceRng>> {
    let values: Vec<i64> = values.as_array().map(|items| items.iter().filter_map(Value::as_i64).collect()).unwrap_or_default();
    ServiceDice::new(DiceService::deterministic(SequenceRng::new(values), "roll"))
}

fn run_dice(f: &str, a: &Args<'_>, dice: &mut dyn RulesDice) -> Result<Value, Halt> {
    match f {
        "greatWeaponFightingReroll" => {
            let result = w::great_weapon_fighting_reroll(&a.owned(0), dice, &a.owned(1))?;
            Ok(json!({ "roll": result.roll, "rerolls": result.rerolls }))
        }
        "monsterRechargeAtTurnStart" => {
            let result = mon::monster_recharge_at_turn_start(a.state, &a.owned(0), a.v(1), dice)?;
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
        let args = Args::new(state, &case["a"]);
        let mut base = sequence(&case["v"]);
        let mut recording = Recording::new(&mut base);
        let actual = outcome(run_dice(f, &args, &mut recording));
        let transcript = Value::Array(recording.transcript.clone());
        let expected = expected_outcome(&case["o"]);
        if js::stringify(&actual) != js::stringify(&expected) || js::stringify(&transcript) != js::stringify(&case["t"]) {
            failures.push(format!("{f} s={}: Rust {} ожидалось {}\n  стенограмма Rust {}\n  стенограмма JS   {}", case["s"], actual, expected, js::stringify(&transcript), js::stringify(&case["t"])));
        }
    }
    report(&failures, calls.len());
}

type Check = fn(&mut Validation<'_>) -> sk_rules::pause::Step;

fn block(name: &str) -> Check {
    use sk_rules::validate::BLOCKS;
    let wanted = match name {
        "b50" => "check_actor_exists",
        "b51" => "check_targets_exist",
        "b52" => "check_actor_permission",
        "b53" => "check_turn",
        other => panic!("блок {other}"),
    };
    BLOCKS.iter().find(|block| block.name == wanted).map(|block| block.check).expect("блок в таблице")
}

#[test]
fn validate_blocks_match_js() {
    let cases = DATA["blocks"].as_array().expect("блоки");
    let mut failures = Vec::new();
    let mut corpus = 0;
    for case in cases {
        let state = match case.get("synthetic").and_then(Value::as_u64) {
            Some(index) => &DATA["states"][index as usize],
            None => {
                corpus += 1;
                &DATA["block_states"][case["s"].as_u64().expect("индекс") as usize]
            }
        };
        let context = context_of(case.get("context"));
        let mut validation = Validation { state, command: case["command"].clone(), context: &context, actor_fate: None };
        let result = block(case["block"].as_str().expect("блок"))(&mut validation).map(|()| validation.command.clone());
        let actual = outcome(result);
        let mut expected = serde_json::Map::new();
        for key in ["ok", "err", "fault"] {
            if let Some(value) = case.get(key) {
                expected.insert(key.into(), value.clone());
            }
        }
        let expected = expected_outcome(&Value::Object(expected));
        if js::stringify(&actual) != js::stringify(&expected) {
            failures.push(format!("{} {}: Rust {} ожидалось {}", case["block"], js::stringify(&case["command"]).chars().take(400).collect::<String>(), actual, expected));
        }
    }
    assert!(corpus > 0, "в эталоне нет записей корпуса");
    report(&failures, cases.len());
}

// --- перенесённые проверки JS ------------------------------------------------------

/// Чародей 7-го уровня (`test/font-of-magic.test.mjs`): очки и ячейки 1–4 круга.
fn sorcerer(points: i64, slots: [i64; 4]) -> Value {
    let max = [4, 3, 3, 1];
    let mut resources = serde_json::Map::new();
    resources.insert("sorcery_points".into(), json!({ "current": points, "max": 7 }));
    for (index, current) in slots.iter().enumerate() {
        resources.insert(format!("spell_slots_{}", index + 1), json!({ "current": current, "max": max[index] }));
    }
    json!({ "players": [{ "id": "sorc" }], "enemies": [], "mechanics": { "resources": { "sorc": resources } } })
}

fn font(state: &Value, extra: Value) -> Result<(Value, Value), Halt> {
    let mut command = js::spread(&json!({ "actor_id": "sorc" }), extra);
    let action = json!({ "id": "font-of-magic", "resource": "sorcery_points", "cost": 1 });
    let result = cf::font_of_magic_action_for(state, &mut command, &action)?;
    Ok((result, command))
}

/// `test/font-of-magic.test.mjs`: цена ячейки, выбор по умолчанию, перевод в очки, отказы.
#[test]
fn font_of_magic_matches_js_tests() {
    let (action, command) = font(&sorcerer(7, [4, 3, 1, 1]), json!({ "slot_level": 3, "font_mode": "create" })).expect("ячейка 3-го круга");
    assert_eq!(action["cost"], json!(5));
    assert_eq!(action["effect"], json!({ "kind": "restore_resource", "resource": "spell_slots_3", "amount": 1 }));
    assert_eq!(command["font_mode"], json!("create"));
    let (action, _) = font(&sorcerer(3, [4, 1, 0, 1]), json!({})).expect("младшая недостающая");
    assert_eq!(action["effect"]["resource"], json!("spell_slots_2"), "3-й круг стоит 5 очков, их нет — ячейка 2-го за 3");
    let (action, _) = font(&sorcerer(2, [4, 3, 3, 1]), json!({ "slot_level": 3, "font_mode": "convert" })).expect("перевод");
    assert_eq!(action["resource"], json!("spell_slots_3"));
    assert_eq!(action["effect"], json!({ "kind": "restore_resource", "resource": "sorcery_points", "amount": 3 }));
    let (action, command) = font(&sorcerer(2, [4, 3, 3, 1]), json!({})).expect("всё полно — младшая в очки");
    assert_eq!(action["resource"], json!("spell_slots_1"));
    assert_eq!(command["slot_level"], json!(1));
    let code = |state: Value, extra: Value| match font(&state, extra) {
        Err(Halt::Rule(error)) => error.code,
        other => panic!("ожидался отказ, а не {other:?}"),
    };
    assert_eq!(code(sorcerer(7, [4, 3, 3, 1]), json!({ "slot_level": 2, "font_mode": "create" })), "FONT_OF_MAGIC_NOTHING_TO_CREATE");
    assert_eq!(code(sorcerer(4, [4, 3, 0, 1]), json!({ "slot_level": 3, "font_mode": "create" })), "FONT_OF_MAGIC_NOTHING_TO_CREATE");
    assert_eq!(code(sorcerer(7, [4, 3, 3, 1]), json!({ "slot_level": 1, "font_mode": "convert" })), "FONT_OF_MAGIC_NOTHING_TO_CONVERT");
    assert_eq!(code(sorcerer(7, [4, 3, 3, 1]), json!({})), "FONT_OF_MAGIC_NOTHING_TO_CONVERT");
}

/// Критический урон удваивает кости, не модификатор; костей не больше 100.
#[test]
fn critical_damage_doubles_dice() {
    assert_eq!(w::critical_damage_expression("1d8+3").expect("выражение"), "2d8+3");
    assert_eq!(w::critical_damage_expression("2d6-1").expect("выражение"), "4d6-1");
    assert_eq!(w::critical_damage_expression("60d6").expect("выражение"), "100d6");
}

/// Мультиатака со счётчиками: id по алфавиту, не больше восьми ударов.
#[test]
fn multiattack_counts_sorted_and_capped() {
    let actor = json!({ "traits": [{ "id": "multiattack", "action_counts": { "claw": 2, "bite": 1, "tail": 9 } }] });
    let ids = mon::monster_multiattack_action_ids(Some(&actor), None, None).expect("последовательность");
    assert_eq!(ids, vec!["bite", "claw", "claw", "tail", "tail", "tail", "tail", "tail"]);
}

//! Сверка перенесённой ранее экономики хода, тактического хода и журналов с
//! эталоном JS (`fixtures/turn-economy.json`, генератор —
//! `fixtures/gen-turn-economy.mjs`): траты действия и кадров Атака,
//! `applyVersionedAttackEconomy`, лимиты атак, `synchronizeTacticalTurn`,
//! `combatTurnKey`, перезарядка, `eventJournalId`, три журнала,
//! `recentBattleSpellName`, `attackEndpointsFor`, `battleLogAreaFromPayload`.

use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_core::Event;
use sk_rules::journal;
use sk_rules::turn_economy as e;

const FIXTURE: &str = include_str!("../fixtures/turn-economy.json");
static DATA: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(FIXTURE).expect("эталон — JSON"));

fn cases(name: &str) -> &'static [Value] {
    DATA["cases"][name].as_array().map(Vec::as_slice).unwrap_or_else(|| panic!("нет раздела {name}"))
}

fn state(case: &Value) -> Value {
    DATA["states"][case["state"].as_u64().expect("индекс состояния") as usize].clone()
}

fn text(value: &Value) -> String {
    js::stringify(value)
}

fn undefined(value: &Value) -> Option<&Value> {
    (value.as_str() != Some("__undefined__")).then_some(value)
}

fn event(value: &Value) -> Event {
    serde_json::from_value(value.clone()).expect("событие")
}

#[test]
fn loading_and_frames_match_js() {
    for case in cases("helpers") {
        let raw = undefined(&case["raw"]);
        assert_eq!(text(&e::normalize_loading_weapon_item_ids(raw)), text(&case["normalized"]), "normalizeLoadingWeaponItemIds {case}");
        let mut economy = Map::new();
        economy.insert("foo".into(), json!(1));
        if let Some(raw) = raw {
            economy.insert("loading_weapon_item_ids".into(), raw.clone());
        }
        let economy = Value::Object(economy);
        for (index, resource) in ["action", "bonus_action", "reaction"].into_iter().enumerate() {
            for (item_index, item) in [json!("bow"), json!(""), Value::Null, json!(5), json!("a")].iter().enumerate() {
                let actual = e::with_loading_weapon_item(&economy, resource, item);
                assert_eq!(text(&actual), text(&case["with_item"][index][item_index]), "withLoadingWeaponItem {resource} {item} {case}");
            }
            assert_eq!(text(&e::clear_loading_weapon_resource(&economy, resource)), text(&case["cleared"][index]), "clearLoadingWeaponResource {resource} {case}");
        }
    }
    for case in cases("frames") {
        let economy = &case["economy"];
        let frame = e::current_frame(economy);
        assert_eq!(text(&frame.as_ref().map(e::Frame::to_value).unwrap_or(Value::Null)), text(&case["frame"]), "attackActionFrameFromEconomy {case}");
        assert_eq!(text(&e::frames_value(&e::pending_frames(economy))), text(&case["pending"]), "pendingAttackActionFrames {case}");
        let with_frame = frame.as_ref().map(|frame| e::with_frame(economy, frame)).unwrap_or(Value::Null);
        assert_eq!(text(&with_frame), text(&case["with_frame"]), "attackActionEconomyWithFrame {case}");
        assert_eq!(json!(e::event_version(economy)), case["version"], "actionEconomyEventVersion {case}");
    }
    for case in cases("loading_resource") {
        let payload = case.get("payload").filter(|value| !value.is_null());
        assert_eq!(json!(e::loading_resource_for(case["reaction_attack"] == json!(true), payload)), case["expected"], "loadingResourceFor {case}");
    }
}

#[test]
fn spending_matches_js() {
    for case in cases("spend") {
        let mut state = state(case);
        let id = case["id"].as_str().expect("id");
        match case["call"].as_str().expect("вызов") {
            "combat:action" => e::spend_combat_economy(&mut state, id, "action", false, false),
            "combat:bonus_action" => e::spend_combat_economy(&mut state, id, "bonus_action", false, false),
            "combat:reaction" => e::spend_combat_economy(&mut state, id, "reaction", false, false),
            "combat:magic" => e::spend_combat_economy(&mut state, id, "action", true, false),
            "combat:normal" => e::spend_combat_economy(&mut state, id, "action", false, true),
            "frame" => e::spend_versioned_action_frame(&mut state, id, true, false),
            "frame:surge" => e::spend_versioned_action_frame(&mut state, id, false, false),
            "frame:haste" => e::spend_versioned_action_frame(&mut state, id, true, true),
            "spell" => e::spend_versioned_spell_action(&mut state, id),
            "only" => e::spend_versioned_action_only(&mut state, id),
            "replacement" => e::spend_versioned_attack_replacement(&mut state, id),
            other => panic!("вызов {other}"),
        }
        let actual = state["mechanics"]["combat"]["action_economy"].get(id).cloned().unwrap_or(Value::Null);
        assert_eq!(text(&actual), text(&case["expected"]), "{} {id}: {case}", case["call"]);
    }
}

#[test]
fn versioned_attack_economy_matches_js() {
    for case in cases("attack") {
        let mut state = state(case);
        let event = event(&case["event"]);
        let reference = event.command_id.clone().or_else(|| event.extra.get("event_id").filter(|value| !value.is_null()).map(|value| js::string(Some(value)))).unwrap_or_else(|| "unknown".into());
        e::apply_versioned_attack_economy(&mut state, event.actor_id.as_deref(), &reference, &case["payload"]);
        let id = event.actor_id.clone().unwrap_or_default();
        let actual = state["mechanics"]["combat"]["action_economy"].get(&id).cloned().unwrap_or(Value::Null);
        assert_eq!(text(&actual), text(&case["expected"]), "applyVersionedAttackEconomy {case}");
    }
}

#[test]
fn attack_limits_match_js() {
    for case in cases("limits") {
        let state = state(case);
        let id = case["id"].as_str().expect("id");
        let actor = Some(&case["actor"]);
        assert_eq!(json!(e::allowed_weapon_attacks(&state, actor, id)), case["allowed"], "allowedWeaponAttacks {case}");
        assert_eq!(json!(e::weapon_attack_limit_for_action(&state, actor, id, false)), case["normal"], "weaponAttackLimitForAction {case}");
        assert_eq!(json!(e::weapon_attack_limit_for_action(&state, actor, id, true)), case["multiattack"], "weaponAttackLimitForAction multiattack {case}");
    }
}

#[test]
fn tactical_turn_and_turn_key_match_js() {
    for case in cases("sync") {
        let mut state = state(case);
        e::synchronize_tactical_turn(&mut state);
        let actual = json!({ "activePlayerId": state.get("activePlayerId").cloned().unwrap_or(Value::Null), "tacticalTurn": state.get("tacticalTurn").cloned().unwrap_or(Value::Null) });
        assert_eq!(text(&actual), text(&case["expected"]), "synchronizeTacticalTurn {case}");
    }
    for case in cases("turn_key") {
        let state = state(case);
        assert_eq!(json!(e::combat_turn_key(&state, "ghost")), case["expected"], "combatTurnKey {case}");
    }
}

#[test]
fn journals_match_js() {
    for case in cases("journal") {
        let mut state = state(case);
        state["battleLog"] = case["battle_log_before"].clone();
        state["mapFeedback"] = case["map_feedback_before"].clone();
        let event = event(&case["event"]);
        let entry = case["entry"].as_object().cloned().expect("запись");
        assert_eq!(json!(journal::event_journal_id(&state, &event)), case["journal_id"], "eventJournalId {case}");
        let mut battle = state.clone();
        journal::append_battle_log(&mut battle, &event, entry.clone());
        assert_eq!(text(&battle["battleLog"]), text(&case["battle_log"]), "appendBattleLog {case}");
        let mut feedback = state.clone();
        journal::append_map_feedback(&mut feedback, &event, entry.clone());
        assert_eq!(text(&feedback["mapFeedback"]), text(&case["map_feedback"]), "appendMapFeedback {case}");
        let mut economy = state.clone();
        journal::append_economy_log(&mut economy, &event, entry);
        assert_eq!(text(&economy["economyLog"]), text(&case["economy_log"]), "appendEconomyLog {case}");
        let name = journal::recent_battle_spell_name(&state, undefined(&case["spell_id"])).unwrap_or(Value::Null);
        assert_eq!(name, case["spell_name"], "recentBattleSpellName {case}");
        let area = journal::battle_log_area_from_payload(&state, &event, &case["payload"]).map(Value::Object).unwrap_or(Value::Null);
        assert_eq!(text(&area), text(&case["area"]), "battleLogAreaFromPayload {case}");
    }
    for case in cases("endpoints") {
        let endpoints = journal::attack_endpoints_for(undefined(&case["value"])).unwrap_or(Value::Null);
        assert_eq!(text(&endpoints), text(&case["expected"]), "attackEndpointsFor {case}");
    }
}

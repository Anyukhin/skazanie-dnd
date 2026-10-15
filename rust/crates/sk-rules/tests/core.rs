//! Сверка ядра `sk-rules` с эталоном JS (`fixtures/core.json`, генератор —
//! `fixtures/gen-core.mjs` на «открытой копии» движка): константы и таблицы,
//! множества команд модулей, метки `switch` разбора и редьюсера, помощники
//! ядра и событий, «Обессиливание», метка времени раунда, провенанс. JSON
//! сравнивается строкой `JSON.stringify` — вместе с порядком ключей.

use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_rules::command::rules::{source_ids_for, COMMAND_RULES, RULE_IDS};
use sk_rules::command::types as t;
use sk_rules::constants as c;
use sk_rules::core as k;

const FIXTURE: &str = include_str!("../fixtures/core.json");
static DATA: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(FIXTURE).expect("эталон — JSON"));

fn text(value: &Value) -> String {
    js::stringify(value)
}

fn cases(name: &str) -> &'static [Value] {
    DATA["cases"][name].as_array().map(Vec::as_slice).unwrap_or_else(|| panic!("нет раздела {name}"))
}

fn strs(items: &[&str]) -> Value {
    js::strings_value(items.iter().copied())
}

fn opt(value: Option<&'static str>) -> Value {
    value.map(Value::from).unwrap_or(Value::Null)
}

#[test]
fn engine_constants_match_js() {
    let constants = &DATA["constants"];
    let rule_ids: Map<String, Value> = RULE_IDS.iter().map(|(key, id)| (key.to_string(), Value::from(*id))).collect();
    assert_eq!(text(&Value::Object(rule_ids)), text(&constants["RULE_IDS"]));
    let command_rules: Map<String, Value> = COMMAND_RULES.iter().map(|(kind, rules)| (kind.to_string(), strs(rules))).collect();
    assert_eq!(text(&Value::Object(command_rules)), text(&constants["COMMAND_RULES"]));
    let allowed: Vec<&str> = t::ALLOWED_COMMAND_TYPES.iter().copied().collect();
    assert_eq!(strs(&allowed), constants["ALLOWED_COMMAND_TYPES"]);
    assert_eq!(strs(&t::MERCHANT_LIFECYCLE_COMMAND_TYPES), constants["MERCHANT_LIFECYCLE_COMMAND_TYPES"]);
    assert_eq!(strs(&t::ENCOUNTER_LIFECYCLE_COMMAND_TYPES), constants["ENCOUNTER_LIFECYCLE_COMMAND_TYPES"]);
    for (kind, expected) in constants["needs_actor"].as_object().expect("needsActor") {
        assert_eq!(Value::Bool(t::needs_actor(kind)), *expected, "needsActor({kind})");
    }
    assert_eq!(json!(c::GAME_STATE_PROJECTOR_VERSION), constants["GAME_STATE_PROJECTOR_VERSION"]);
    assert_eq!(json!(c::GAME_REDUCER_VERSION), constants["GAME_REDUCER_VERSION"]);
    assert_eq!(json!(c::TURN_REACTION_EXTENSION_LIMIT), constants["TURN_REACTION_EXTENSION_LIMIT"]);
    assert_eq!(json!(c::PICKPOCKET_CAUGHT_RELATIONSHIP_DELTA), constants["PICKPOCKET_CAUGHT_RELATIONSHIP_DELTA"]);
    assert_eq!(json!(c::MAGIC_ITEM_SPELL_IMMUNITY_EVENT_SCHEMA_VERSION), constants["MAGIC_ITEM_SPELL_IMMUNITY_EVENT_SCHEMA_VERSION"]);
    assert_eq!(strs(&c::MONK_BONUS_UNARMED_ACTION_IDS), constants["MONK_BONUS_UNARMED_ACTION_IDS"]);
    assert_eq!(strs(&c::LOADING_ACTION_TYPES), constants["LOADING_ACTION_TYPES"]);
    assert_eq!(json!(c::ACTION_ECONOMY_EVENT_VERSION), constants["ACTION_ECONOMY_EVENT_VERSION"]);
    assert_eq!(strs(&c::ATTACK_ACTION_KINDS), constants["ATTACK_ACTION_KINDS"]);
    assert_eq!(json!(c::REST_POLICY_ID), constants["REST_POLICY_ID"]);
    assert_eq!(json!(c::REST_EVENT_SCHEMA_VERSION), constants["REST_EVENT_SCHEMA_VERSION"]);
    assert_eq!(json!(c::HIT_POINT_DIE_EVENT_SCHEMA_VERSION), constants["HIT_POINT_DIE_EVENT_SCHEMA_VERSION"]);
    assert_eq!(json!(c::AMMUNITION_SPENT_EVENT_SCHEMA_VERSION), constants["AMMUNITION_SPENT_EVENT_SCHEMA_VERSION"]);
    assert_eq!(json!({ "short": c::REST_MINIMUM_MINUTES_SHORT, "long": c::REST_MINIMUM_MINUTES_LONG }), constants["REST_MINIMUM_MINUTES"]);
    let die_sizes: Map<String, Value> = c::CLASS_HIT_POINT_DIE_SIZES.iter().map(|(class, size)| (class.to_string(), json!(size))).collect();
    assert_eq!(text(&Value::Object(die_sizes)), text(&constants["CLASS_HIT_POINT_DIE_SIZES"]));
    assert_eq!(json!(c::SUMMON_LIFECYCLE_VERSION), constants["SUMMON_LIFECYCLE_VERSION"]);
    assert_eq!(json!(c::MOVE_BATTLE_LOG_PATH_VERSION), constants["MOVE_BATTLE_LOG_PATH_VERSION"]);
    assert_eq!(strs(&c::EXTINGUISHABLE_FLAME_CONDITIONS), constants["EXTINGUISHABLE_FLAME_CONDITIONS"]);
    let triggers: Map<String, Value> = c::READIED_TRIGGERS.iter().map(|(id, label)| (id.to_string(), json!(label))).collect();
    assert_eq!(text(&Value::Object(triggers)), text(&constants["READIED_TRIGGERS"]));
    assert_eq!(strs(&c::CREATURE_ENTITY_KINDS), constants["CREATURE_ENTITY_KINDS"]);
    assert_eq!(strs(&c::ALL_ABILITIES), constants["ALL_ABILITIES"]);
    assert_eq!(json!(c::PROTECTION_FROM_ENERGY_EXPIRY_POLICY), constants["PROTECTION_FROM_ENERGY_EXPIRY_POLICY"]);
    assert_eq!(text(sk_rules::tables::condition_effects()), text(&constants["CONDITION_EFFECTS"]), "data/condition-effects.json устарел");
    assert_eq!(strs(&c::SOURCE_SCOPED_BOOLEAN_CONDITIONS), constants["SOURCE_SCOPED_BOOLEAN_CONDITIONS"]);
    assert_eq!(strs(sk_rules::tables::incapacitating_conditions()), constants["INCAPACITATING_CONDITIONS"]);
    assert_eq!(strs(&sk_rules::tables::speed_zero_conditions()), constants["SPEED_ZERO_CONDITIONS"]);
    assert_eq!(json!(c::CUTTING_WORDS_ACTION_ID), constants["CUTTING_WORDS_ACTION_ID"]);
    assert_eq!(strs(&c::PROTECTION_ACTION_IDS), constants["PROTECTION_ACTION_IDS"]);
    let labels: Map<String, Value> = c::REACTION_PREFERENCE_LABELS.iter().map(|(id, label)| (id.to_string(), json!(label))).collect();
    assert_eq!(text(&Value::Object(labels)), text(&constants["REACTION_PREFERENCE_LABELS"]));
    assert_eq!(strs(&c::REACTION_PREFERENCE_SPELL_IDS), constants["REACTION_PREFERENCE_SPELL_IDS"]);
    assert_eq!(strs(&c::REACTION_PREFERENCE_ACTION_IDS), constants["REACTION_PREFERENCE_ACTION_IDS"]);
    assert_eq!(json!(sk_rules::resolve::round_time::COMBAT_ROUND_TIME_POLICY), constants["COMBAT_ROUND_TIME_POLICY"]);
    assert_eq!(strs(&sk_rules::resolve::round_time::COMBAT_ROUND_TIME_COMMANDS), constants["COMBAT_ROUND_TIME_COMMANDS"]);
}

#[test]
fn module_command_sets_match_js() {
    let sets = &DATA["sets"];
    let check = |name: &str, value: Value| assert_eq!(value, sets[name], "{name}");
    check("NPC_WORLD_COMMAND_TYPES", strs(&t::NPC_WORLD_COMMAND_TYPES));
    check("CAPTIVE_PLAYER_COMMAND_TYPES", strs(&t::CAPTIVE_PLAYER_COMMAND_TYPES));
    check("CAPTIVE_COMMAND_TYPES", strs(&t::CAPTIVE_COMMAND_TYPES));
    check("CAPTIVE_INTERROGATION_SKILLS", strs(&t::CAPTIVE_INTERROGATION_SKILLS));
    check("CAPTIVES_POLICY_ID", json!(t::CAPTIVES_POLICY_ID));
    check("BEAST_COMMAND_TYPES", strs(&t::BEAST_COMMAND_TYPES));
    check("BEAST_TAMING_POLICY_ID", json!(t::BEAST_TAMING_POLICY_ID));
    check("LOOT_CONTAINER_COMMAND_TYPES", strs(&t::LOOT_CONTAINER_COMMAND_TYPES));
    check("LOOT_CONTAINERS_POLICY_ID", json!(t::LOOT_CONTAINERS_POLICY_ID));
    check("MAX_LOOT_LINES", json!(t::MAX_LOOT_LINES));
    check("TAVERN_COMMAND_TYPES", strs(&t::TAVERN_COMMAND_TYPES));
    check("TAVERN_DICE_APPROACHES", strs(&t::TAVERN_DICE_APPROACHES));
    check("TAVERN_STAKES_CP", json!(t::TAVERN_STAKES_CP));
    check("TAVERN_POLICY_ID", json!(t::TAVERN_POLICY_ID));
    check("COURIER_LETTER_COMMAND_TYPES", strs(&t::COURIER_LETTER_COMMAND_TYPES));
    check("COURIER_LETTER_BODY_LIMIT", json!(t::COURIER_LETTER_BODY_LIMIT));
    check("COURIER_LETTERS_POLICY_ID", json!(t::COURIER_LETTERS_POLICY_ID));
    check("BLESSING_COMMAND_TYPES", strs(&t::BLESSING_COMMAND_TYPES));
    check("BLESSINGS_POLICY_ID", json!(t::BLESSINGS_POLICY_ID));
    check("SCENARIO_KNIGHT_COMMAND_TYPES", strs(&t::SCENARIO_KNIGHT_COMMAND_TYPES));
    check("DIALOGUE_COMMAND_TYPE", json!(t::DIALOGUE_COMMAND_TYPE));
    check("DIALOGUE_POLICY_ID", json!(t::DIALOGUE_POLICY_ID));
    check("ITEM_LIFECYCLE_COMMAND_TYPES", strs(&t::ITEM_LIFECYCLE_COMMAND_TYPES));
    check("CHARACTER_LIFECYCLE_COMMAND_TYPES", strs(&t::CHARACTER_LIFECYCLE_COMMAND_TYPES));
    check("SCENARIO_COMMAND_TYPES", strs(&t::SCENARIO_COMMAND_TYPES));
    check("SCENARIO_TREATY_COMMAND_TYPES", strs(&t::SCENARIO_TREATY_COMMAND_TYPES));
    check("SCENARIO_PURSE_COMMAND_TYPES", strs(&t::SCENARIO_PURSE_COMMAND_TYPES));
    check("SCENARIO_ARMORY_COMMAND_TYPES", strs(&t::SCENARIO_ARMORY_COMMAND_TYPES));
    check("SCENARIO_INFORMANT_COMMAND_TYPES", strs(&t::SCENARIO_INFORMANT_COMMAND_TYPES));
    check("SCENARIO_INFORMANT_POLICY_ID", json!(t::SCENARIO_INFORMANT_POLICY_ID));
    check("SCENARIO_ARMORY_POLICY_ID", json!(t::SCENARIO_ARMORY_POLICY_ID));
    check("SCENARIO_STRANGER_STAGES", strs(&t::SCENARIO_STRANGER_STAGES));
    check("CHARACTER_BUILD_COMMAND_TYPES", strs(&t::CHARACTER_BUILD_COMMAND_TYPES));
    check("ECONOMY_POLICY_ID", json!(t::ECONOMY_POLICY_ID));
    check("WORLD_MEMORY_COMMAND_TYPES", strs(&t::WORLD_MEMORY_COMMAND_TYPES));
    check("SLAB_MAX_TEXT_LENGTH", json!(t::SLAB_MAX_TEXT_LENGTH));
    check("NPC_SOCIAL_COMMAND_TYPES", strs(&t::NPC_SOCIAL_COMMAND_TYPES));
    check("GUARD_ESCAPE_SKILLS", strs(&t::GUARD_ESCAPE_SKILLS));
    check("LAW_COMMAND_TYPES", strs(&t::LAW_COMMAND_TYPES));
    check("LAW_POLICY_ID", json!(t::LAW_POLICY_ID));
    check("PARLEY_COMMAND_TYPES", strs(&t::PARLEY_COMMAND_TYPES));
    check("PARLEY_POLICY_ID", json!(t::PARLEY_POLICY_ID));
    check("PARLEY_SKILLS", strs(&t::PARLEY_SKILLS));
    check("TRUCE_BREAKING_COMMAND_TYPES", strs(&t::TRUCE_BREAKING_COMMAND_TYPES));
}

#[test]
fn switch_labels_match_js() {
    let resolve: Vec<&str> = sk_rules::resolve::RESOLVE_LABELS.to_vec();
    assert_eq!(strs(&resolve), DATA["structure"]["resolve_labels"], "метки диспетчера resolveCommandInternal");
    let reduce: Vec<&str> = sk_rules::reduce::js_reducer_labels().collect();
    assert_eq!(strs(&reduce), DATA["structure"]["reduce_labels"], "метки switch редьюсера");
}

#[test]
fn core_helpers_match_js() {
    for case in cases("unique_strings") {
        assert_eq!(json!(k::unique_strings(case.get("input"))), case["expected"], "uniqueStrings {case}");
    }
    for case in cases("ability_modifier") {
        assert_eq!(json!(k::ability_modifier(case.get("score"))), case["expected"], "abilityModifier {case}");
    }
    for case in cases("dice_expression") {
        let result = k::dice_expression(case.get("dice"), case.get("bonus"), case["fallback"].as_i64().expect("грани"));
        match (result, case.get("error")) {
            (Ok(expression), None) => assert_eq!(json!(expression), case["expected"], "diceExpression {case}"),
            (Err(sk_rules::pause::Halt::Fault(fault)), Some(name)) => assert_eq!(json!(fault.name), *name, "diceExpression {case}"),
            (other, _) => panic!("diceExpression {case}: {other:?}"),
        }
    }
    for case in cases("monster_trait_for") {
        let found = k::monster_trait_for(case.get("actor"), case["trait_id"].as_str().expect("id")).cloned().unwrap_or(Value::Null);
        assert_eq!(text(&found), text(&case["expected"]), "monsterTraitFor {case}");
    }
    for case in cases("monster_action_for") {
        let found = k::monster_action_for(case.get("actor"), case.get("action_id")).cloned().unwrap_or(Value::Null);
        assert_eq!(text(&found), text(&case["expected"]), "monsterActionFor {case}");
    }
    for case in cases("armor") {
        let actor = case.get("actor");
        assert_eq!(json!(k::has_equipped_shield(actor)), case["shield"], "hasEquippedShield {case}");
        assert_eq!(json!(k::armor_stealth_disadvantage(actor)), case["stealth"], "armorStealthDisadvantage {case}");
        assert_eq!(json!(k::armor_strength_speed_penalty(actor)), case["penalty"], "armorStrengthSpeedPenalty {case}");
    }
    for case in cases("target_for") {
        assert_eq!(k::target_for(&case["command"]), case["expected"], "targetFor {case}");
    }
    for case in cases("player_actor") {
        let found = k::player_actor(&case["state"], case.get("id")).cloned().unwrap_or(Value::Null);
        assert_eq!(found, case["expected"], "playerActor {case}");
    }
    for case in cases("same_campaign_party") {
        assert_eq!(json!(k::same_campaign_party(&case["state"], case["id"].as_str().expect("id"))), case["expected"], "sameCampaignParty {case}");
    }
    for case in cases("objective_within_limit") {
        let maximum = case["maximum"].as_u64().expect("предел") as usize;
        assert_eq!(json!(k::objective_within_limit(case.get("value"), maximum)), case["expected"], "objectiveWithinLimit {case}");
    }
    for case in cases("inventory_item") {
        let found = k::inventory_item(case.get("actor"), case.get("item_id")).cloned().unwrap_or(Value::Null);
        assert_eq!(found, case["expected"], "inventoryItem {case}");
    }
    for case in cases("assert_mechanics_supported") {
        match k::assert_mechanics_supported(case.get("subject"), "«Левитации»") {
            Ok(()) => assert_eq!(case["ok"], json!(true), "assertMechanicsSupported {case}"),
            Err(error) => {
                assert_eq!(json!(error.code), case["code"], "assertMechanicsSupported {case}");
                assert_eq!(json!(error.message), case["message"], "assertMechanicsSupported {case}");
            }
        }
    }
    for case in cases("casting_time_minutes") {
        assert_eq!(js::num(k::casting_time_minutes(case.get("value"))), case["expected"], "castingTimeMinutes {case}");
    }
    for case in cases("durations") {
        assert_eq!(js::num(sk_rules::world_clock::duration_in_minutes_exact(case.get("amount"), case.get("unit"))), case["minutes"], "durationInMinutes {case}");
        assert_eq!(js::num(sk_rules::world_clock::duration_in_seconds(case.get("amount"), case.get("unit"))), case["seconds"], "durationInSeconds {case}");
    }
    for case in cases("normalized_clock_seconds") {
        assert_eq!(js::num(sk_rules::world_clock::normalized_clock_seconds_of(case.get("value"))), case["expected"], "normalizedClockSeconds {case}");
    }
    for case in cases("world_time_seconds") {
        assert_eq!(js::num(sk_rules::world_clock::world_time_seconds(&case["state"])), case["expected"], "worldTimeSeconds {case}");
    }
}

#[test]
fn events_match_js() {
    for case in cases("event_from") {
        let event = k::event_from(&case["command"], case["event_type"].as_str().expect("тип"), case.get("payload").cloned(), case.get("targets"));
        assert_eq!(text(&event), text(&case["expected"]), "eventFrom {case}");
    }
    for case in cases("command_with_rules") {
        let rules: Vec<&str> = case["rules"].as_array().expect("правила").iter().map(|rule| rule.as_str().expect("строка")).collect();
        assert_eq!(text(&k::command_with_rules(&case["command"], &rules)), text(&case["expected"]), "commandWithRules {case}");
    }
    for case in cases("hero_died") {
        assert_eq!(text(&k::hero_died_event_from(&case["command"], case.get("payload").cloned(), None)), text(&case["expected"]), "heroDiedEventFrom {case}");
    }
    for case in cases("item_granted") {
        assert_eq!(text(&k::item_granted_event_from(&case["command"], case.get("payload").cloned(), case.get("targets"))), text(&case["expected"]), "itemGrantedEventFrom {case}");
    }
    for case in cases("npc_world_events_from") {
        let events = k::npc_world_events_from(&case["command"], &case["drafts"]);
        assert_eq!(text(&Value::Array(events)), text(&case["expected"]), "npcWorldEventsFrom {case}");
    }
}

#[test]
fn state_helpers_match_js() {
    for case in cases("actor_max_hp") {
        assert_eq!(json!(k::actor_max_hp(case.get("actor"))), case["expected"], "actorMaxHp {case}");
    }
    for case in cases("resource_pool") {
        let pool = k::resource_pool(&case["state"], "hero", case["resource"].as_str().expect("ресурс"), case["provided_max"].as_i64().expect("max"));
        assert_eq!(pool.to_value(), case["expected"], "resourcePool {case}");
    }
    for case in cases("conditions") {
        let state = &case["state"];
        let id = case["id"].as_str().expect("id");
        let ids: Vec<String> = k::condition_ids_for(state, id).into_iter().collect();
        assert_eq!(json!(ids), case["ids"], "conditionIdsFor {case}");
        assert_eq!(opt(k::incapacitating_condition_for(state, id)), case["incapacitating"], "incapacitatingConditionFor {case}");
        assert_eq!(opt(k::speed_zero_condition_for(state, id)), case["speed_zero"], "speedZeroConditionFor {case}");
        assert_eq!(json!(k::ignores_difficult_terrain(state, id)), case["ignores_difficult_terrain"], "ignoresDifficultTerrain {case}");
    }
    for case in cases("combat_actor_kind") {
        assert_eq!(json!(k::combat_actor_kind(&case["state"], case["id"].as_str().expect("id"))), case["expected"], "combatActorKind {case}");
    }
    for case in cases("restart_turn_clock") {
        let mut state = json!({ "mechanics": { "combat": { "active": true, "turn_started_at": "old", "turn_started_event_id": "old-id" } } });
        let event: sk_core::Event = serde_json::from_value(case["event"].clone()).expect("событие");
        k::restart_turn_clock(&mut state, &event);
        assert_eq!(text(&state["mechanics"]["combat"]), text(&case["expected"]), "restartTurnClock {case}");
    }
    for case in cases("battle_log_move_path") {
        let path = k::battle_log_move_path(case.get("payload")).map(Value::Array).unwrap_or(Value::Null);
        assert_eq!(path, case["expected"], "battleLogMovePath {case}");
    }
    for case in cases("readied_option_for") {
        let option = k::readied_option_for(case.get("readied"), case.get("reason").and_then(Value::as_str));
        assert_eq!(text(&option), text(&case["expected"]), "readiedOptionFor {case}");
    }
    for case in cases("condition_uses_effect_identity") {
        let result = k::condition_uses_effect_identity(case["condition"].as_str().expect("состояние"), case.get("payload"));
        assert_eq!(json!(result), case["expected"], "conditionUsesEffectIdentity {case}");
    }
}

#[test]
fn enervation_link_matches_js() {
    for case in cases("enervation") {
        let state = &case["state"];
        let link = sk_rules::enervation_link::enervation_link_for(state, case.get("caster_id")).map(|link| link.to_value()).unwrap_or(Value::Null);
        assert_eq!(text(&link), text(&case["link"]), "enervationLinkFor {case}");
        let action = sk_rules::enervation_link::enervation_continuation_action_for(state, case.get("caster_id"), case.get("action_id")).unwrap_or(Value::Null);
        assert_eq!(text(&action), text(&case["action"]), "enervationContinuationActionFor {case}");
    }
}

#[test]
fn combat_round_time_marker_matches_js() {
    for case in cases("round_time") {
        let result = sk_rules::resolve::Resolved {
            command: case["result"]["command"].clone(),
            events: case["result"]["events"].as_array().cloned().unwrap_or_default(),
            rolls: case["result"]["rolls"].as_array().cloned().unwrap_or_default(),
        };
        let context = sk_rules::context::Context::from_json(&case["context"]);
        let marked = sk_rules::resolve::round_time::with_combat_round_time_marker(result, &case["raw_state"], &context);
        let actual = json!({ "command": marked.command, "events": marked.events, "rolls": marked.rolls });
        assert_eq!(text(&actual), text(&case["expected"]), "withCombatRoundTimeMarker {case}");
    }
}

#[test]
fn source_rule_ids_match_js() {
    for case in cases("source_ids_for") {
        let command = case["command"].as_object().expect("команда");
        match (source_ids_for(command, &case["state"]), case.get("error")) {
            (Ok(ids), None) => assert_eq!(json!(ids), case["expected"], "sourceIdsFor {case}"),
            (Err(halt), Some(error)) => {
                let name = match &halt {
                    sk_rules::pause::Halt::Rule(_) => "RulesValidationError".to_string(),
                    sk_rules::pause::Halt::Fault(fault) => fault.name.clone(),
                    sk_rules::pause::Halt::Pause(_) => "Pause".to_string(),
                };
                assert_eq!(json!(name), error["name"], "sourceIdsFor {case}");
                assert_eq!(halt.code().map(Value::from).unwrap_or(Value::Null), error["code"], "sourceIdsFor {case}");
            }
            (other, _) => panic!("sourceIdsFor {case}: {other:?}"),
        }
    }
}

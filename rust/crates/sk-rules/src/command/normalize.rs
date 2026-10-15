//! Нормализация команды — `normalizeCommand` (`rules-engine.mjs`, 4579–4873).
//! Задача Р0.
//!
//! Команда приходит недоверенным JSON-объектом: имена в двух написаниях
//! (`actor_id`/`actorId`), строки любой длины, поля, которые клиент называть
//! не вправе. Здесь команда приводится к форме, которую видят проверка и
//! разбор: строки обрезаны, служебные поля проставлены, лишние удалены.
//! Порядок присваиваний — как в JS: от него зависит порядок ключей команды,
//! а команда целиком уходит в `pending_command` окна реакции.

use serde_json::{Map, Value};
use sk_core::js;
use sk_ruleset::rules_core::DEFAULT_RULESET_ID;

use super::rules::source_ids_for;
use super::types::*;
use crate::context::Uuid;
use crate::core::{safe_integer_or, slice_utf16, spread_value, unique_strings};
use crate::pause::{rule, Halt};

type Obj = Map<String, Value>;

/// `a ?? b ?? …` по ключам команды.
fn first<'a>(command: &'a Obj, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| command.get(*key).filter(|value| !value.is_null()))
}

/// `a == null && b == null ? null : String(a ?? b).slice(0, limit)`.
fn optional_string(command: &Obj, keys: &[&str], limit: usize) -> Value {
    match first(command, keys) {
        None => Value::Null,
        Some(value) => Value::String(slice_utf16(&js::string(Some(value)), limit)),
    }
}

/// `String(a ?? b ?? fallback)`.
fn string_or(command: &Obj, keys: &[&str], fallback: &str) -> String {
    match first(command, keys) {
        None => fallback.to_string(),
        Some(value) => js::string(Some(value)),
    }
}

/// `String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, limit)`.
fn squashed(value: Option<&Value>, limit: usize) -> String {
    let text = sk_core::text::nfkc(&js::s(value));
    slice_utf16(&sk_core::text::squash_spaces(&text), limit)
}

fn set(command: &mut Obj, key: &str, value: Value) {
    command.insert(key.into(), value);
}

fn set_text(command: &mut Obj, key: &str, value: String) {
    command.insert(key.into(), Value::String(value));
}

fn delete(command: &mut Obj, key: &str) {
    command.shift_remove(key);
}

/// `command.target_id = null; command.target_ids = []`.
fn clear_targets(command: &mut Obj) {
    set(command, "target_id", Value::Null);
    set(command, "target_ids", Value::Array(Vec::new()));
}

/// `command.x = command.x ?? command.y`; `undefined` в JS — ключа нет.
fn set_coalesced(command: &mut Obj, key: &str, alias: &str) {
    match first(command, &[key, alias]).cloned() {
        Some(value) => set(command, key, value),
        None => delete(command, key),
    }
}

/// `if (!command.house_rule_id) command.house_rule_id = policy`.
fn default_house_rule(command: &mut Obj, policy: &str) {
    if !js::truthy(command.get("house_rule_id")) {
        set_text(command, "house_rule_id", policy.to_string());
    }
}

/// `normalizeLootLines(input)` (`loot-containers.mjs`): до двенадцати строк
/// `{ item_instance_id, quantity }` с ключом экземпляра.
pub fn normalize_loot_lines(input: Option<&Value>) -> Value {
    let Some(Value::Array(lines)) = input else { return Value::Array(Vec::new()) };
    let mut result = Vec::new();
    for line in lines.iter().take(MAX_LOOT_LINES) {
        let Some(object) = line.as_object() else { continue };
        let id_source = object.get("item_instance_id").filter(|value| !value.is_null()).or_else(|| object.get("itemInstanceId"));
        let id = squashed(id_source, 160);
        if id.is_empty() {
            continue;
        }
        let quantity = object.get("quantity");
        let quantity = if js::is_safe_integer_number(quantity) { js::num(js::number(quantity)) } else { Value::from(1) };
        let mut entry = Map::new();
        entry.insert("item_instance_id".into(), Value::String(id));
        entry.insert("quantity".into(), quantity);
        result.push(Value::Object(entry));
    }
    Value::Array(result)
}

/// `{ ...(input ?? {}) }`.
fn copy_input(input: &Value) -> Obj {
    match input {
        Value::Null => Map::new(),
        other => spread_value(Some(other)),
    }
}

/// `normalizeCommand(input, state)`. `uuid` — `randomUUID()` для команды без id.
pub fn normalize_command(input: &Value, state: &Value, uuid: Uuid<'_>) -> Result<Value, Halt> {
    let mut command = copy_input(input);
    let command_type = string_or(&command, &["command_type", "type"], "");
    set_text(&mut command, "command_type", command_type.clone());
    let ruleset_id = match state.get("ruleset_id").filter(|value| js::truthy(Some(value))) {
        Some(value) => js::string(Some(value)),
        None => DEFAULT_RULESET_ID.to_string(),
    };
    set_text(&mut command, "ruleset_id", ruleset_id);
    let command_id = match first(&command, &["command_id", "commandId"]) {
        Some(value) => js::string(Some(value)),
        None => uuid(),
    };
    set_text(&mut command, "command_id", command_id);
    let actor_id = optional_string(&command, &["actor_id", "actorId"], usize::MAX);
    set(&mut command, "actor_id", actor_id);
    let target_id = optional_string(&command, &["target_id", "targetId"], usize::MAX);
    set(&mut command, "target_id", target_id);
    if command_type == "CastSpell" {
        let spell_id = js::string(first(&command, &["spell_id", "spellId"]));
        let options = match state.get("ruleset_id") {
            Some(ruleset) => serde_json::json!({ "rulesetId": ruleset }),
            None => serde_json::json!({}),
        };
        let spell = sk_combat_content::combat_spells::canonical_combat_spell_for(Some(&Value::String(spell_id.clone())), Some(&options));
        let rejects = matches!(spell_id.as_str(), "longstrider" | "mass-cure-wounds" | "destructive-wave")
            || spell.as_ref().and_then(|spell| spell.get("rejectDuplicateTargetIds")) == Some(&Value::Bool(true));
        if rejects {
            if let Some(Value::Array(targets)) = first(&command, &["target_ids", "targetIds"]) {
                if targets.len() != unique_strings(Some(&Value::Array(targets.clone()))).len() {
                    return Err(rule("Выберите каждую цель только один раз", "INVALID_SPELL_TARGETS"));
                }
            }
        }
    }
    let targets_source = match first(&command, &["target_ids", "targetIds"]) {
        Some(value) => value.clone(),
        None if js::truthy(command.get("target_id")) => Value::Array(vec![command["target_id"].clone()]),
        None => Value::Array(Vec::new()),
    };
    set(&mut command, "target_ids", js::strings_value(unique_strings(Some(&targets_source))));
    let source_rule_ids = source_ids_for(&command, state)?;
    set(&mut command, "source_rule_ids", js::strings_value(source_rule_ids));
    let house_rule_id = first(&command, &["house_rule_id", "houseRuleId"]).cloned().unwrap_or(Value::Null);
    set(&mut command, "house_rule_id", house_rule_id);
    let ruling_id = first(&command, &["ruling_id", "rulingId"]).cloned().unwrap_or(Value::Null);
    set(&mut command, "ruling_id", ruling_id);
    for (key, alias) in [("merchant_id", "merchantId"), ("stock_id", "stockId"), ("item_id", "itemId")] {
        let value = optional_string(&command, &[key, alias], 120);
        set(&mut command, key, value);
    }
    if matches!(command_type.as_str(), "BarricadeDoor" | "ClearDoorBarricade") {
        let material = optional_string(&command, &["material_item_id", "materialItemId"], 120);
        set(&mut command, "material_item_id", material);
        let door = optional_string(&command, &["door_id", "doorId"], 120);
        set(&mut command, "door_id", door);
        let force = js::is_true(command.get("force"));
        set(&mut command, "force", Value::Bool(force));
    }
    if command_type == "MakeAttack" {
        let mode = optional_string(&command, &["attack_mode", "attackMode"], 40);
        set(&mut command, "attack_mode", mode);
        let ability = optional_string(&command, &["attack_ability", "attackAbility"], 8);
        set(&mut command, "attack_ability", ability);
        let sneak = js::is_true(command.get("sneak_attack")) || js::is_true(command.get("sneakAttack"));
        set(&mut command, "sneak_attack", Value::Bool(sneak));
    }
    if command_type == "PurchaseMerchantService" {
        let service = optional_string(&command, &["service_id", "serviceId"], 120);
        set(&mut command, "service_id", service);
    }
    let action_id = optional_string(&command, &["action_id", "actionId"], 120);
    set(&mut command, "action_id", action_id);
    let quantity = safe_integer_or(command.get("quantity"), Some(&Value::from(1)));
    set(&mut command, "quantity", quantity);
    let fingerprint = match command.get("request_fingerprint").filter(|value| !value.is_null()) {
        Some(value) => Value::String(slice_utf16(&js::string(Some(value)), 128)),
        None => Value::Null,
    };
    set(&mut command, "request_fingerprint", fingerprint);
    let merchant_lifecycle = MERCHANT_LIFECYCLE_COMMAND_TYPES.contains(&command_type.as_str());
    if matches!(command_type.as_str(), "BargainWithMerchant" | "AppraiseItem" | "BuyItem" | "SellItem" | "PurchaseMerchantService") || merchant_lifecycle {
        default_house_rule(&mut command, ECONOMY_POLICY_ID);
    }
    if merchant_lifecycle {
        set(&mut command, "actor_id", Value::Null);
        clear_targets(&mut command);
    }
    if ENCOUNTER_LIFECYCLE_COMMAND_TYPES.contains(&command_type.as_str()) {
        set(&mut command, "actor_id", Value::Null);
        clear_targets(&mut command);
        let difficulty = string_or(&command, &["difficulty"], "");
        set_text(&mut command, "difficulty", difficulty);
        let theme = string_or(&command, &["theme"], "");
        set_text(&mut command, "theme", theme);
        let seed = slice_utf16(&string_or(&command, &["seed"], ""), 120);
        set_text(&mut command, "seed", seed);
    }
    if command_type == "AttackNpc" {
        let npc_id = slice_utf16(&string_or(&command, &["npc_id", "npcId"], ""), 120);
        set_text(&mut command, "npc_id", npc_id);
        delete(&mut command, "npcId");
        delete(&mut command, "encounter");
        delete(&mut command, "seed");
        clear_targets(&mut command);
    }
    if command_type == "AdvanceScene" {
        set(&mut command, "actor_id", Value::Null);
        clear_targets(&mut command);
        set_coalesced(&mut command, "scene_args", "sceneArgs");
        delete(&mut command, "sceneArgs");
        set_coalesced(&mut command, "party_decision", "partyDecision");
        delete(&mut command, "partyDecision");
    }
    if NPC_WORLD_COMMAND_TYPES.contains(&command_type.as_str()) {
        set(&mut command, "actor_id", Value::Null);
        clear_targets(&mut command);
        let npc_id = slice_utf16(&string_or(&command, &["npc_id", "npcId"], ""), 120);
        set_text(&mut command, "npc_id", npc_id);
        delete(&mut command, "npcId");
    }
    if command_type == DIALOGUE_COMMAND_TYPE {
        clear_targets(&mut command);
        let npc_id = slice_utf16(&string_or(&command, &["npc_id"], ""), 120);
        set_text(&mut command, "npc_id", npc_id);
        let option_id = slice_utf16(&string_or(&command, &["option_id"], ""), 80);
        set_text(&mut command, "option_id", option_id);
        delete(&mut command, "dialogue_option");
        set_text(&mut command, "house_rule_id", DIALOGUE_POLICY_ID.to_string());
    }
    if SCENARIO_PURSE_COMMAND_TYPES.contains(&command_type.as_str()) {
        clear_targets(&mut command);
        delete(&mut command, "amount");
    }
    if SCENARIO_ARMORY_COMMAND_TYPES.contains(&command_type.as_str()) {
        clear_targets(&mut command);
        let catalog_id = slice_utf16(&string_or(&command, &["catalog_id"], ""), 120);
        set_text(&mut command, "catalog_id", catalog_id);
        delete(&mut command, "armory_item");
        set_text(&mut command, "house_rule_id", SCENARIO_ARMORY_POLICY_ID.to_string());
    }
    if SCENARIO_INFORMANT_COMMAND_TYPES.contains(&command_type.as_str()) {
        clear_targets(&mut command);
        let informant = slice_utf16(&string_or(&command, &["informant_id"], ""), 80);
        set_text(&mut command, "informant_id", informant);
        let choice = slice_utf16(&string_or(&command, &["choice"], ""), 20);
        set_text(&mut command, "choice", choice);
        delete(&mut command, "difficulty");
        delete(&mut command, "skill");
        set_text(&mut command, "house_rule_id", SCENARIO_INFORMANT_POLICY_ID.to_string());
    }
    if SCENARIO_TREATY_COMMAND_TYPES.contains(&command_type.as_str()) {
        clear_targets(&mut command);
        delete(&mut command, "skill");
        delete(&mut command, "difficulty");
    }
    if SCENARIO_KNIGHT_COMMAND_TYPES.contains(&command_type.as_str()) {
        clear_targets(&mut command);
        let skill = if command_type == "ReleaseCursedKnight" { slice_utf16(&sk_core::text::lower(&string_or(&command, &["skill"], "")), 40) } else { String::new() };
        set_text(&mut command, "skill", skill);
        delete(&mut command, "reward_item");
        delete(&mut command, "reward_source_npc_id");
        delete(&mut command, "difficulty");
    }
    if SCENARIO_COMMAND_TYPES.contains(&command_type.as_str()) {
        set(&mut command, "actor_id", Value::Null);
        clear_targets(&mut command);
        let stage = js::string(command.get("stage"));
        let stage = if SCENARIO_STRANGER_STAGES.contains(&stage.as_str()) { stage } else { String::new() };
        set_text(&mut command, "stage", stage);
        delete(&mut command, "npc");
    }
    if CAPTIVE_COMMAND_TYPES.contains(&command_type.as_str()) {
        let captive_id = slice_utf16(&string_or(&command, &["captive_id", "captiveId"], ""), 120);
        set_text(&mut command, "captive_id", captive_id);
        delete(&mut command, "captiveId");
        if command_type == "InterrogateCaptive" {
            let skill = js::string(command.get("skill"));
            let skill = if CAPTIVE_INTERROGATION_SKILLS.contains(&skill.as_str()) { skill } else { "intimidation".to_string() };
            set_text(&mut command, "skill", skill);
        }
        if command_type == "NeglectCaptive" {
            set(&mut command, "actor_id", Value::Null);
            clear_targets(&mut command);
        }
    }
    if LOOT_CONTAINER_COMMAND_TYPES.contains(&command_type.as_str()) {
        let container_id = slice_utf16(&string_or(&command, &["container_id", "containerId"], ""), 120);
        set_text(&mut command, "container_id", container_id);
        delete(&mut command, "containerId");
        let recipient_id = slice_utf16(&string_or(&command, &["recipient_id", "recipientId"], ""), 120);
        set_text(&mut command, "recipient_id", recipient_id);
        delete(&mut command, "recipientId");
        let lines = normalize_loot_lines(command.get("lines"));
        set(&mut command, "lines", lines);
        clear_targets(&mut command);
        default_house_rule(&mut command, LOOT_CONTAINERS_POLICY_ID);
    }
    if BEAST_COMMAND_TYPES.contains(&command_type.as_str()) {
        let beast_id = slice_utf16(&string_or(&command, &["beast_id", "beastId"], ""), 120);
        set_text(&mut command, "beast_id", beast_id);
        delete(&mut command, "beastId");
        clear_targets(&mut command);
    }
    if PARLEY_COMMAND_TYPES.contains(&command_type.as_str()) {
        clear_targets(&mut command);
        if command_type == "ProposeParley" {
            let skill = js::string(command.get("skill"));
            let skill = if PARLEY_SKILLS.contains(&skill.as_str()) { skill } else { "persuasion".to_string() };
            set_text(&mut command, "skill", skill);
        }
        if command_type == "SettleParley" {
            let outcome = slice_utf16(&string_or(&command, &["outcome"], ""), 40);
            set_text(&mut command, "outcome", outcome);
            default_house_rule(&mut command, PARLEY_POLICY_ID);
        }
    }
    if LAW_COMMAND_TYPES.contains(&command_type.as_str()) {
        clear_targets(&mut command);
        if command_type == "ResolveGuardEncounter" {
            let resolution = slice_utf16(&string_or(&command, &["resolution"], ""), 30);
            set_text(&mut command, "resolution", resolution);
            let skill = js::string(command.get("skill"));
            let skill = if GUARD_ESCAPE_SKILLS.contains(&skill.as_str()) { skill } else { "stealth".to_string() };
            set_text(&mut command, "skill", skill);
        }
        if command_type == "ClearWantedLevel" {
            set(&mut command, "actor_id", Value::Null);
            let region = slice_utf16(&string_or(&command, &["region_id", "regionId"], ""), 180);
            set_text(&mut command, "region_id", region);
            delete(&mut command, "regionId");
        }
        default_house_rule(&mut command, LAW_POLICY_ID);
    }
    if TAVERN_COMMAND_TYPES.contains(&command_type.as_str()) {
        clear_targets(&mut command);
        if command_type == "OpenTavernDiceRound" {
            let npc_id = slice_utf16(&string_or(&command, &["npc_id", "npcId"], ""), 120);
            set_text(&mut command, "npc_id", npc_id);
            delete(&mut command, "npcId");
            let stake = js::safe_int(first(&command, &["stake_cp", "stakeCp"]), 0);
            set(&mut command, "stake_cp", Value::from(if TAVERN_STAKES_CP.contains(&stake) { stake } else { 0 }));
            delete(&mut command, "stakeCp");
        }
        if command_type == "AnswerTavernDiceRound" {
            let approach = js::string(command.get("approach"));
            let approach = if TAVERN_DICE_APPROACHES.contains(&approach.as_str()) { approach } else { "fair".to_string() };
            set_text(&mut command, "approach", approach);
        }
        default_house_rule(&mut command, TAVERN_POLICY_ID);
    }
    if COURIER_LETTER_COMMAND_TYPES.contains(&command_type.as_str()) {
        clear_targets(&mut command);
        let kind = slice_utf16(&string_or(&command, &["addressee_kind", "addresseeKind"], "npc"), 20);
        set_text(&mut command, "addressee_kind", kind);
        let addressee = slice_utf16(&string_or(&command, &["addressee_id", "addresseeId"], ""), 120);
        set_text(&mut command, "addressee_id", addressee);
        delete(&mut command, "addresseeKind");
        delete(&mut command, "addresseeId");
        let body = squashed(command.get("body"), COURIER_LETTER_BODY_LIMIT);
        set_text(&mut command, "body", body);
        let draft = squashed(command.get("reply_draft"), 1_000);
        set_text(&mut command, "reply_draft", draft);
        let tone = slice_utf16(&string_or(&command, &["reply_draft_tone"], ""), 20);
        set_text(&mut command, "reply_draft_tone", tone);
        let provider = slice_utf16(&string_or(&command, &["reply_provider"], ""), 80);
        set_text(&mut command, "reply_provider", provider);
        default_house_rule(&mut command, COURIER_LETTERS_POLICY_ID);
    }
    if command_type == "ResolveHeroDeath" {
        let resolution = string_or(&command, &["resolution"], "");
        set_text(&mut command, "resolution", resolution);
        let name = match command.get("replacement_name").filter(|value| !value.is_null()) {
            Some(value) => slice_utf16(sk_core::text::trim(&js::string(Some(value))), 120),
            None => String::new(),
        };
        set_text(&mut command, "replacement_name", name);
    }
    if command_type == "OperateSceneObject" {
        let prop_id = slice_utf16(&string_or(&command, &["prop_id", "propId"], ""), 120);
        set_text(&mut command, "prop_id", prop_id);
        let intent = string_or(&command, &["intent"], "inspect");
        let approach = if command.get("approach").and_then(Value::as_str) == Some("force") && intent != "lockpick" { "force" } else { "hand" };
        set_text(&mut command, "intent", intent);
        set_text(&mut command, "approach", approach.to_string());
    }
    if command_type == "UseLevelTransition" {
        let prop_id = slice_utf16(&string_or(&command, &["prop_id", "propId"], ""), 120);
        set_text(&mut command, "prop_id", prop_id);
    }
    if command_type == "ImportLocationMap" {
        let location = slice_utf16(sk_core::text::trim(&string_or(&command, &["location_id", "locationId"], "")), 120);
        set_text(&mut command, "location_id", location);
        let slab = match command.get("slab") {
            Some(Value::String(text)) => slice_utf16(text, SLAB_MAX_TEXT_LENGTH + 1),
            _ => String::new(),
        };
        set_text(&mut command, "slab", slab);
    }
    if command_type == "RebuildLocationMap" {
        let text = squashed(command.get("text"), 2_000);
        set_text(&mut command, "text", text);
        let preserve = js::is_true(command.get("preserve_layout"));
        set(&mut command, "preserve_layout", Value::Bool(preserve));
    }
    if command_type == "ReceiveNpcBlessing" {
        let npc_id = slice_utf16(&string_or(&command, &["npc_id", "npcId"], ""), 120);
        set_text(&mut command, "npc_id", npc_id);
        default_house_rule(&mut command, BLESSINGS_POLICY_ID);
    }
    let expected = safe_integer_or(first(&command, &["expected_state_version", "expectedStateVersion"]), state.get("state_version"));
    set(&mut command, "expected_state_version", expected);
    Ok(Value::Object(command))
}

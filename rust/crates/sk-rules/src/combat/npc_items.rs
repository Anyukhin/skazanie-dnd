//! Предметы NPC в бою (`NPC_ITEM_USE`, `validateNpcItemUseCommand`). Задача Р3.
//!
//! JS: `server/rules-engine.mjs`, 5183–5312 (поля команды, цена тактики,
//! проверка команды предмета противника) и 8771 (`npcEquipmentSpentEvent`).
//!
//! Тактики и вещи противника объявляет `sk-economy` (`server/npc-equipment.mjs`);
//! здесь — только дверь планировщика, закрытый список полей и условия тактик.

use serde_json::{json, Map, Value};
use sk_core::{game, js};
use sk_economy::npc_equipment::{npc_melee_weapon_binding_for_item, npc_tactic_condition, npc_usable_item_for, NPC_EQUIPMENT_EVENT_SCHEMA_VERSION, NPC_EQUIPMENT_POLICY_ID, NPC_HEALING_POTION_HP_PERCENT};

use crate::conditions::at_path;
use crate::context::Context;
use crate::core::{condition_ids_for, event_from, player_actor, same_campaign_party, spread_value};
use crate::pause::{rule, Halt};

/// `NPC_ITEM_USE_COMMAND_FIELDS`: закрытый список полей команды предмета противника.
pub const NPC_ITEM_USE_COMMAND_FIELDS: [&str; 20] = [
    "command_type",
    "command_id",
    "campaign_id",
    "actor_id",
    "target_id",
    "target_ids",
    "item_id",
    "npc_tactic",
    "weapon_id",
    "merchant_id",
    "stock_id",
    "action_id",
    "quantity",
    "expected_state_version",
    "ruleset_id",
    "source_rule_ids",
    "house_rule_id",
    "ruling_id",
    "visibility",
    "request_fingerprint",
];

/// Поле `server_authoritative` — двадцать первое в `Set` JS.
const SERVER_AUTHORITATIVE_FIELD: &str = "server_authoritative";

/// `NPC_TACTIC_ECONOMY_ERRORS`: чем существо платит за тактику и что ответить,
/// если это уже потрачено.
pub fn npc_tactic_economy_error(resource: &str) -> Option<(&'static str, &'static str)> {
    match resource {
        "action" => Some(("Действие на этом ходу уже потрачено", "ACTION_SPENT")),
        "bonus_action" => Some(("Бонусное действие на этом ходу уже потрачено", "BONUS_ACTION_SPENT")),
        _ => None,
    }
}

fn allowed_field(key: &str) -> bool {
    key == SERVER_AUTHORITATIVE_FIELD || NPC_ITEM_USE_COMMAND_FIELDS.contains(&key)
}

/// `validateNpcItemUseCommand(command, state, context)` (5212–5312):
/// противник пользуется своей вещью — только руками планировщика ходов.
pub fn validate_npc_item_use_command(command: &Value, state: &Value, context: &Context) -> Result<Value, Halt> {
    if !context.is_true("isNpcScheduler") {
        return Err(rule("Инвентарём противника распоряжается только серверный планировщик ходов", "NPC_ITEM_USE_FORBIDDEN"));
    }
    let unexpected: Vec<&String> = command.as_object().map(js::keys).unwrap_or_default().into_iter().filter(|key| !allowed_field(key)).collect();
    if !unexpected.is_empty() {
        let names: Vec<&str> = unexpected.iter().map(|key| key.as_str()).collect();
        return Err(rule(format!("Команда предмета противника содержит запрещённые поля: {}", names.join(", ")), "ITEM_COMMAND_UNKNOWN_FIELD"));
    }
    let actor_id = command.get("actor_id");
    let Some(enemy) = game::find_actor(state, &js::s(actor_id)) else {
        return Err(rule("Существо не найдено", "ACTOR_NOT_FOUND"));
    };
    if !game::is_living_actor(enemy) {
        return Err(rule("Побеждённое существо не пользуется вещами", "ACTOR_DEFEATED"));
    }
    if !game::combat_active(state) {
        return Err(rule("Снаряжение противника расходуется только в бою", "COMBAT_NOT_ACTIVE"));
    }
    let ruleset = js::s(state.get("ruleset_id"));
    let Some(item) = npc_usable_item_for(Some(enemy), command.get("item_id"), &ruleset) else {
        return Err(rule("У существа нет такой вещи или сервер не умеет её применять", "NPC_ITEM_NOT_USABLE"));
    };
    if js::s(command.get("npc_tactic")) != js::s(item.get("tactic")) {
        return Err(rule("Заявленная тактика не соответствует вещи", "NPC_ITEM_TACTIC_MISMATCH"));
    }
    let actor_key = js::string(actor_id);
    let conditions = condition_ids_for(state, &actor_key);
    if js::truthy(item.get("once_per_combat")) && conditions.contains(&npc_tactic_condition(item.get("tactic"))) {
        return Err(rule("Эту тактику существо в этом бою уже применяло", "NPC_ITEM_TACTIC_SPENT"));
    }
    let item_use = item.get("use").cloned().unwrap_or(Value::Null);
    let tactic_resource = js::s(item_use.get("combat_action"));
    let economy = at_path(Some(game::combat(state)), &["action_economy", &js::string(actor_id)]);
    if let Some((message, code)) = npc_tactic_economy_error(&tactic_resource) {
        if js::is_false(economy.and_then(|economy| economy.get(&tactic_resource))) {
            return Err(rule(message, code));
        }
    }
    let target_id = js::string(crate::core::coalesce(&[command.get("target_id"), actor_id]).or(actor_id));
    let mut result = spread_value(Some(command));
    result.insert("target_id".into(), Value::String(target_id.clone()));
    result.insert(
        "npc_item".into(),
        json!({
            "item_instance_id": item["item_instance_id"],
            "catalog_id": item["catalog_id"],
            "item_name": item["item_name"],
            "quantity_before": item["quantity"],
            "tactic": item["tactic"],
            "label": item["label"],
            "once_per_combat": item["once_per_combat"],
        }),
    );
    let mut use_profile = spread_value(Some(&item_use));
    use_profile.insert("attack_replacement".into(), Value::Bool(false));
    result.insert("use_profile".into(), Value::Object(use_profile));
    let tactic = js::s(item.get("tactic"));
    let actor_text = js::string(actor_id);
    if tactic == "heal" {
        if target_id != actor_text {
            return Err(rule("Зелье существо пьёт само", "INVALID_ITEM_TARGET"));
        }
        let hp = game::actor_hp(enemy);
        let maximum = game::actor_max_hp(enemy).max(1);
        if hp <= 0 || hp * 100 > maximum * NPC_HEALING_POTION_HP_PERCENT {
            return Err(rule("Зелье идёт в ход только на последних хитах", "NPC_ITEM_TACTIC_NOT_APPLICABLE"));
        }
    }
    if tactic == "flask" {
        let target = player_actor(state, Some(&Value::String(target_id.clone())));
        if !target.is_some_and(game::is_living_actor) || !same_campaign_party(state, &target_id) {
            return Err(rule("Склянку мечут в живого героя отряда", "INVALID_ITEM_TARGET"));
        }
        let distance = crate::targets::distance_between_actors(state, &js::s(actor_id), &target_id);
        let range_feet = js::safe_int(item_use.get("range_feet"), 20).max(5) as f64;
        if distance.is_none_or(|distance| distance < 5.0 || distance > range_feet) {
            return Err(rule("Цель находится вне дальности броска склянки", "ITEM_TARGET_OUT_OF_RANGE"));
        }
        if js::is_true(item_use.get("requires_line_of_sight")) {
            let from = crate::tactical_geometry::actor_point(state, &actor_text);
            let to = crate::tactical_geometry::actor_point(state, &target_id);
            crate::geometry::forced::assert_clear_actor_trajectory(state, &actor_text, &target_id, from, to, false)?;
        }
    }
    if tactic == "coat" {
        if target_id != actor_text {
            return Err(rule("Яд наносят на своё оружие", "INVALID_ITEM_TARGET"));
        }
        let Some(binding) = npc_melee_weapon_binding_for_item(Some(enemy), command.get("weapon_id")) else {
            return Err(rule("Яд наносится на связанное ближнее оружие существа", "INVALID_WEAPON"));
        };
        if conditions.contains(&format!("weapon-coated:{}", js::string(binding.get("item_instance_id")))) {
            return Err(rule("Это оружие уже смазано ядом", "NPC_ITEM_TACTIC_SPENT"));
        }
        if js::safe_int(economy.and_then(|economy| economy.get("attacks_used")), 0) > 0 {
            return Err(rule("Яд наносят до первого удара", "NPC_ITEM_TACTIC_NOT_APPLICABLE"));
        }
        result.insert(
            "npc_weapon".into(),
            json!({ "action_id": binding["action_id"], "item_instance_id": binding["item_instance_id"], "item_name": binding["item_name"] }),
        );
    }
    result.insert("target_ids".into(), json!([target_id]));
    Ok(Value::Object(result))
}

/// `npcEquipmentSpentEvent(command, payload)` (8793): служебный расход
/// снаряжения противника, видимый только ведущему.
pub fn npc_equipment_spent_event(command: &Value, payload: &Value) -> Value {
    let owner = js::string(command.get("actor_id"));
    let source = crate::core::command_with(command, "visibility", Value::String("gm_only".into()));
    let mut body = Map::new();
    body.insert("schema_version".into(), Value::from(NPC_EQUIPMENT_EVENT_SCHEMA_VERSION));
    body.insert("policy_id".into(), Value::String(NPC_EQUIPMENT_POLICY_ID.into()));
    body.insert("owner_id".into(), Value::String(owner.clone()));
    for (key, value) in spread_value(Some(payload)) {
        body.insert(key, value);
    }
    event_from(&source, "NpcEquipmentSpent", Some(Value::Object(body)), Some(&json!([owner])))
}

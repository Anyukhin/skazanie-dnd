//! Блоки `validateCommand`: Актёр, цели, полномочия и ход (`assertActorPermission`, `assertTurn`). Задача Р3.
//!
//! JS: `server/rules-engine.mjs`, 6955–6957, 6958–6972, 6973, 6974. Порядок блоков задаёт
//! `validate/mod.rs` (Р0); здесь — только тела.

use serde_json::{json, Value};
use sk_core::js;

use super::Validation;
use crate::combat::turn::{assert_actor_permission, assert_turn};
use crate::command::types::{needs_actor, NPC_SOCIAL_COMMAND_TYPES};
use crate::pause::{rule, Step};
use crate::tactical_geometry::npc_positioning::NpcTargetGeometry;

fn command_type(v: &Validation<'_>) -> String {
    js::s(v.command.get("command_type"))
}

/// Блок 50 (6955–6957): действующий персонаж найден.
pub fn check_actor_exists(v: &mut Validation<'_>) -> Step {
    if needs_actor(&command_type(v)) {
        let actor_id = v.command.get("actor_id");
        if !js::truthy(actor_id) || sk_core::game::find_actor(v.state, &js::s(actor_id)).is_none() {
            return Err(rule("Действующий персонаж не найден", "ACTOR_NOT_FOUND"));
        }
    }
    Ok(())
}

/// Команды, для которых цели не ищутся (`break` цикла 6959).
const TARGETS_UNCHECKED: [&str; 5] = ["RevealArea", "UpdateObjective", "SpawnEntity", "GrantItem", "RecordRuling"];

/// Блок 51 (6958–6972): цели найдены.
pub fn check_targets_exist(v: &mut Validation<'_>) -> Step {
    let kind = command_type(v);
    let ids: Vec<Value> = v.command.get("target_ids").and_then(Value::as_array).cloned().unwrap_or_default();
    if ids.is_empty() || TARGETS_UNCHECKED.contains(&kind.as_str()) || NPC_SOCIAL_COMMAND_TYPES.contains(&kind.as_str()) {
        return Ok(());
    }
    let state = v.state;
    let command = &v.command;
    let spell_id = command.get("spell_id");
    let cast = kind == "CastSpell";
    let creature_spell = cast && matches!(spell_id.and_then(Value::as_str), Some("longstrider" | "mass-cure-wounds"));
    for id in &ids {
        let id_text = js::string(Some(id));
        if kind == "TransferItem" && command.get("recipient_kind").and_then(Value::as_str) == Some("npc") && id_text == js::string(command.get("recipient_id")) {
            continue;
        }
        let found = if creature_spell {
            let mut spell = serde_json::Map::new();
            if let Some(spell_id) = spell_id {
                spell.insert("id".into(), spell_id.clone());
            }
            crate::targets::spell_creature_for(state, &js::s(Some(id)), &Value::Object(spell)).is_some()
        } else {
            sk_core::game::find_actor(state, &js::s(Some(id))).is_some()
        };
        if found {
            continue;
        }
        let npc_target = cast && {
            let options = json!({ "rulesetId": state.get("ruleset_id").cloned().unwrap_or(Value::Null) });
            match sk_combat_content::combat_spells::canonical_combat_spell_for(spell_id, Some(&options)) {
                Some(spell) => crate::areas::shape::npc_spell_targets_at(state, command, &spell).iter().any(|target| target.id() == id_text),
                None => false,
            }
        };
        if !npc_target {
            return Err(rule(format!("Цель {id_text} не найдена"), "TARGET_NOT_FOUND"));
        }
    }
    Ok(())
}

/// Блок 52 (6973): полномочия (`assertActorPermission`).
pub fn check_actor_permission(v: &mut Validation<'_>) -> Step {
    assert_actor_permission(&v.command, v.context, v.state)
}

/// Блок 53 (6974): ход и экономика хода (`assertTurn`).
pub fn check_turn(v: &mut Validation<'_>) -> Step {
    assert_turn(&v.command, v.state, v.context)
}

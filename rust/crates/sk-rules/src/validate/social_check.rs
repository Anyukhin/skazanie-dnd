//! Блоки `validateCommand`: социальная проверка `MakeAbilityCheck` от
//! контроллера NPC. Задача Р5.
//!
//! JS: `server/rules-engine.mjs`, 6174–6205. Порядок блоков задаёт
//! `validate/mod.rs` (Р0); здесь — только тела.
//!
//! Блок переписывает команду на месте: герой, навык, характеристика, СЛ,
//! видимость и подкуп приходят из политики проверки (`context.socialCheck`),
//! а не из тела запроса; присланный `modifier` удаляется.

use serde_json::{Map, Value};
use sk_core::js;

use super::Validation;
use crate::core::player_actor;
use crate::pause::{rule, Step};

/// Блок 8 (6174–6205): социальная проверка только от контроллера NPC.
pub fn check_social_check(v: &mut Validation<'_>) -> Step {
    if v.command.get("command_type").and_then(Value::as_str) != Some("MakeAbilityCheck") || !js::present(v.command.get("social_check")) {
        return Ok(());
    }
    let expected = v.context.get("socialCheck").filter(|value| js::truthy(Some(value))).cloned();
    let Some(expected) = expected.filter(|_| v.context.is_true("isSocialController")) else {
        return Err(rule("Social checks can only be created by the server NPC controller", "NPC_SOCIAL_CHECK_FORBIDDEN"));
    };
    let field = |key: &str| expected.get(key);
    let hero = js::string(field("hero_id"));
    let bribe = field("bribe").filter(|value| js::truthy(Some(value)));
    if let Some(bribe) = bribe {
        let purse = sk_economy::merchant_economy::currency_to_copper(player_actor(v.state, field("hero_id")).and_then(|actor| actor.get("currency")));
        if purse < js::safe_int(bribe.get("amount_cp"), 0).max(0) {
            return Err(rule("На такую щедрость у героя не хватает монет", "INSUFFICIENT_FUNDS"));
        }
    }
    let mut social = Map::new();
    social.insert("check_id".into(), Value::String(js::string(field("check_id"))));
    social.insert("npc_id".into(), Value::String(js::string(field("npc_id"))));
    social.insert("skill".into(), Value::String(js::string(field("skill"))));
    social.insert("request_fingerprint".into(), Value::String(js::string(field("request_fingerprint"))));
    if let Some(bribe) = bribe {
        social.insert("bribe".into(), bribe.clone());
    }
    let visibility = if field("visibility").and_then(Value::as_str) == Some("specific_player") { "specific_player" } else { "party" };
    let Some(command) = v.command.as_object_mut() else { return Ok(()) };
    command.insert("actor_id".into(), Value::String(hero.clone()));
    command.insert("target_id".into(), Value::String(hero.clone()));
    command.insert("target_ids".into(), Value::Array(vec![Value::String(hero)]));
    command.insert("skill".into(), Value::String(js::string(field("skill"))));
    command.insert("ability".into(), Value::String(js::string(field("ability"))));
    command.insert("difficulty".into(), Value::from(js::safe_int(field("difficulty"), 10)));
    command.insert("visibility".into(), Value::String(visibility.into()));
    command.insert("social_check".into(), Value::Object(social));
    command.shift_remove("modifier");
    command.insert("advantage".into(), Value::Bool(js::truthy(field("advantage"))));
    command.insert("disadvantage".into(), Value::Bool(js::truthy(field("disadvantage"))));
    Ok(())
}

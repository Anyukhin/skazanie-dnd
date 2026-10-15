//! Общие блоки `validateCommand`: тип и версия, ожидающее окно реакции,
//! недособранный герой, статус кампании, погибший герой, провенанс,
//! количества. Задача Р0.
//!
//! JS: `server/rules-engine.mjs`, 6135–6151, 6777–6809, 6981–6984, 7819–7832.

use serde_json::Value;
use sk_core::js;

use super::Validation;
use crate::command::types::{
    is_allowed_command_type, CAPTIVE_COMMAND_TYPES, CHARACTER_BUILD_COMMAND_TYPES, CHARACTER_LIFECYCLE_COMMAND_TYPES, ITEM_LIFECYCLE_COMMAND_TYPES, NPC_SOCIAL_COMMAND_TYPES,
    NPC_WORLD_COMMAND_TYPES, WORLD_MEMORY_COMMAND_TYPES,
};
use crate::pause::{rule, Fault, Halt, Step};

fn command_type(v: &Validation<'_>) -> String {
    js::s(v.command.get("command_type"))
}

/// `a === b` для значений JSON (`None` — `undefined`). Объекты и массивы
/// равны только сами себе — у копий JSON ссылки разные.
pub fn strict_equal(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64().zip(b.as_f64()).is_some_and(|(a, b)| a == b),
        (Some(Value::String(a)), Some(Value::String(b))) => a == b,
        (Some(Value::Bool(a)), Some(Value::Bool(b))) => a == b,
        _ => false,
    }
}

/// `container?.includes(item)`: массив — `SameValueZero`, строка — подстрока,
/// `null`/`undefined` — ложь (необязательная цепочка), прочее — `TypeError`.
pub fn js_includes(container: Option<&Value>, item: Option<&Value>, what: &str) -> Result<bool, Halt> {
    match container {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Array(items)) => Ok(items.iter().any(|entry| match (entry, item) {
            (Value::Number(a), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
            (entry, Some(item)) => entry == item,
            (_, None) => false,
        })),
        Some(Value::String(text)) => Ok(text.contains(&js::string(item))),
        Some(_) => Err(Fault::type_error(format!("{what}.includes is not a function")).into()),
    }
}

/// Блок 2 (6135–6137): тип команды разрешён.
pub fn check_command_allowed(v: &mut Validation<'_>) -> Step {
    if !is_allowed_command_type(&command_type(v)) {
        return Err(rule("Тип команды не разрешён", "COMMAND_NOT_ALLOWED"));
    }
    Ok(())
}

/// Блок 3 (6138–6140): версия состояния совпадает.
pub fn check_state_version(v: &mut Validation<'_>) -> Step {
    if !strict_equal(v.command.get("expected_state_version"), v.state.get("state_version")) {
        return Err(rule("Состояние кампании изменилось; ход нужно повторить", "STATE_VERSION_CONFLICT"));
    }
    Ok(())
}

/// Команды, которые не могут перебить ожидающее продолжение (6148–6149).
const CONTINUATION_BLOCKED: [&str; 14] = [
    "CastSpell", "MakeAttack", "MakeAreaAttack", "UseMonsterAction", "UseLegendaryAction", "MoveActor", "ChangeWeapon", "EquipItem", "UseItem", "ActivateItem",
    "UseCombatAction", "EndTurn", "EndCombat", "StartRest",
];

/// Блок 7 (6141–6151, с объявлениями 4–6): новая команда не заменяет
/// остановленное действие; вложенное серверное продолжение само закрывает окно.
pub fn check_pending_reaction(v: &mut Validation<'_>) -> Step {
    let pending = sk_core::game::combat(v.state).get("reaction_window");
    let field = |key: &str| pending.and_then(|window| window.as_object()).and_then(|window| window.get(key));
    let awaiting = js::truthy(field("pending_command")) || js::truthy(field("pending_spell_command"));
    let kind = command_type(v);
    let action_id = v.command.get("action_id");
    let reaction_choice = kind == "UseCombatAction"
        && (action_id.and_then(Value::as_str) == Some("decline-reaction") || js_includes(field("action_ids"), action_id, "pendingReaction?.action_ids?")?);
    if awaiting && v.context.resolve_depth() <= 1 && !reaction_choice && CONTINUATION_BLOCKED.contains(&kind.as_str()) {
        return Err(rule("Сначала нужно завершить ожидающий выбор реакции.", "COMBAT_REACTION_PENDING"));
    }
    Ok(())
}

/// Блок 37 (6777–6802, с объявлениями 34–36): недособранный герой действует
/// только командами сборки; сервер по тайм-ауту завершает за него ход.
pub fn check_character_setup(v: &mut Validation<'_>) -> Step {
    let actor_id = js::s(v.command.get("actor_id"));
    let setup_actor = v.state.get("players").and_then(Value::as_array).into_iter().flatten().find(|actor| sk_core::game::actor_id(actor) == actor_id);
    let Some(setup_actor) = setup_actor else { return Ok(()) };
    if !js::truthy(setup_actor.get("characterSetupRequired")) {
        return Ok(());
    }
    let kind = command_type(v);
    let command_field = |key: &str| v.command.get(key);
    let ends_turn = matches!(kind.as_str(), "EndTurn" | "EndCombat");
    let server_timeout_may_skip = (ends_turn || kind == "UseCombatAction" && command_field("action_id").and_then(Value::as_str) == Some("decline-reaction"))
        && js::is_true(command_field("server_authoritative"))
        && v.context.is_admin()
        && v.context.server_authoritative_combat()
        && (command_field("auto_skip_reason").and_then(Value::as_str) == Some("turn-timeout") || ends_turn && v.context.is_npc_scheduler());
    let staged = setup_actor.get("characterSetupStage").and_then(Value::as_str) == Some("leveling") && matches!(kind.as_str(), "SetCharacterChoices" | "SetSpellSelections" | "LevelUp");
    if !matches!(kind.as_str(), "ImportCharacter" | "RollCharacterAbilities" | "RollCharacterWealth") && !staged && !server_timeout_may_skip {
        return Err(rule("Сначала завершите создание этого героя", "CHARACTER_SETUP_REQUIRED"));
    }
    Ok(())
}

fn lifecycle_status<'a>(v: &Validation<'a>) -> Option<&'a Value> {
    sk_core::game::mechanics(v.state).get("campaign_lifecycle").and_then(|lifecycle| lifecycle.get("status"))
}

/// Блок 39 (6803–6806, с объявлением 38): кампания на паузе.
pub fn check_campaign_paused(v: &mut Validation<'_>) -> Step {
    if lifecycle_status(v).and_then(Value::as_str) == Some("paused") {
        return Err(rule("Кампания приостановлена владельцем", "CAMPAIGN_PAUSED"));
    }
    Ok(())
}

/// Блок 40 (6807–6809): завершённая кампания только для чтения.
pub fn check_campaign_read_only(v: &mut Validation<'_>) -> Step {
    if matches!(lifecycle_status(v).and_then(Value::as_str), Some("completed" | "failed" | "archived")) && command_type(v) != "EndCombat" {
        return Err(rule("Завершённая или архивная кампания доступна только для чтения", "CAMPAIGN_READ_ONLY"));
    }
    Ok(())
}

/// Блок 56 (6981–6984, с объявлением 55): погибший герой не действует, пока
/// его не заменят или не воскресят. Судьба героя остаётся в
/// [`Validation::actor_fate`] для блока 57.
pub fn check_dead_hero(v: &mut Validation<'_>) -> Step {
    v.actor_fate = if js::truthy(v.command.get("actor_id")) {
        let actor_id = js::string(v.command.get("actor_id"));
        sk_core::game::mechanics(v.state).get("death").and_then(|death| death.get("heroes")).and_then(|heroes| heroes.get(&actor_id)).cloned()
    } else {
        None
    };
    let dead = v.actor_fate.as_ref().and_then(|fate| fate.get("status")).and_then(Value::as_str) == Some("dead");
    if dead && !matches!(command_type(v).as_str(), "ResolveHeroDeath" | "EndCombat" | "EndTurn") {
        return Err(rule("Погибший герой не может действовать, пока его не заменят или не воскресят", "HERO_DEAD_UNRESOLVED"));
    }
    Ok(())
}

/// Команды без провенанса по природе (7819).
const PROVENANCE_FREE: [&str; 14] = [
    "DeclareAction", "RevealArea", "UpdateObjective", "SpawnEntity", "GrantItem", "RecordRuling", "AdvanceScene", "ImportLocationMap", "RebuildLocationMap",
    "UseLevelTransition", "CreateEncounter", "CompleteCampaign", "AdvanceCampaignArc", "ScareWithBeast",
];

fn provenance_free(kind: &str) -> bool {
    PROVENANCE_FREE.contains(&kind)
        || WORLD_MEMORY_COMMAND_TYPES.contains(&kind)
        || NPC_SOCIAL_COMMAND_TYPES.contains(&kind)
        || NPC_WORLD_COMMAND_TYPES.contains(&kind)
        || CAPTIVE_COMMAND_TYPES.contains(&kind)
        || CHARACTER_BUILD_COMMAND_TYPES.contains(&kind)
        || ITEM_LIFECYCLE_COMMAND_TYPES.contains(&kind)
        || CHARACTER_LIFECYCLE_COMMAND_TYPES.contains(&kind)
}

/// Блок 74 (7819–7821): у механического решения есть провенанс.
pub fn check_provenance(v: &mut Validation<'_>) -> Step {
    let rules = match v.command.get("source_rule_ids") {
        Some(Value::Array(items)) => items.len(),
        Some(Value::String(text)) => crate::core::len_utf16(text),
        Some(Value::Null) | None => return Err(Fault::type_error("Cannot read properties of undefined (reading 'length')").into()),
        Some(_) => 0,
    };
    if rules == 0 && !js::truthy(v.command.get("house_rule_id")) && !js::truthy(v.command.get("ruling_id")) && !provenance_free(&command_type(v)) {
        return Err(rule("Для механического решения нужен rule_id, house_rule_id или ruling_id", "PROVENANCE_REQUIRED"));
    }
    Ok(())
}

/// Блок 75 (7822–7825): неотрицательное количество или формула.
pub fn check_amount(v: &mut Validation<'_>) -> Step {
    if matches!(command_type(v).as_str(), "ApplyDamage" | "ApplyHealing" | "ReduceHitPointMaximum" | "GrantTemporaryHitPoints") {
        let amount = js::number(v.command.get("amount"));
        if (!amount.is_finite() || amount < 0.0) && !js::truthy(v.command.get("expression")) {
            return Err(rule("Нужно неотрицательное количество или формула костей", "INVALID_AMOUNT"));
        }
    }
    Ok(())
}

/// `String(value || '')`.
fn string_or_empty(value: Option<&Value>) -> String {
    if js::truthy(value) { js::string(value) } else { String::new() }
}

/// Блок 76 (7826–7829): ресурс назван, количество — положительное целое.
pub fn check_resource(v: &mut Validation<'_>) -> Step {
    if matches!(command_type(v).as_str(), "SpendResource" | "RestoreResource") {
        if sk_core::text::trim(&string_or_empty(v.command.get("resource"))).is_empty() {
            return Err(rule("Не указан ресурс", "RESOURCE_REQUIRED"));
        }
        let amount = js::number(v.command.get("amount"));
        if !crate::core::is_safe_integer_f64(amount) || amount <= 0.0 {
            return Err(rule("Количество ресурса должно быть положительным целым", "INVALID_AMOUNT"));
        }
    }
    Ok(())
}

/// Блок 77 (7830–7832): у `AddCondition` названо состояние.
pub fn check_condition_required(v: &mut Validation<'_>) -> Step {
    if command_type(v) == "AddCondition" && sk_core::text::trim(&string_or_empty(v.command.get("condition"))).is_empty() {
        return Err(rule("Не указано состояние", "CONDITION_REQUIRED"));
    }
    Ok(())
}

//! Блоки `validateCommand`: Общество: NPC-мир, пленные, контейнеры, звери, парлей, закон, таверна, благословения, письма. Задача Р7.
//!
//! JS: `server/rules-engine.mjs`, 6204–6213, 6214–6243, 6244–6251, 6252–6260, 6261–6287, 6288–6352, 6353–6465, 6641–6679, 6683. Порядок блоков задаёт
//! `validate/mod.rs` (Р0); здесь — только тела.
//!
//! Блоки, которые дополняют команду (`Object.assign`), пишут поля в
//! `v.command` на месте — следующий блок видит дополненную команду.

use serde_json::{json, Value};
use sk_core::js;

use super::Validation;
use crate::core::{incapacitating_condition_for, player_actor};
use crate::pause::{rule, Fault, Halt, Step};
use crate::preview_checks::{assert_send_letter_allowed, validated_beast_target};

fn command_type(v: &Validation<'_>) -> String {
    js::s(v.command.get("command_type"))
}

/// `Object.assign(command, patch)`.
fn assign(command: &mut Value, patch: Value) {
    js::assign(command, patch);
}

/// `command.key = value`.
fn set_field(command: &mut Value, key: &str, value: Value) {
    if let Some(map) = command.as_object_mut() {
        map.insert(key.into(), value);
    }
}

/// `isLivingActor(findActor(state, command.actor_id))`.
fn actor_living(v: &Validation<'_>) -> bool {
    sk_core::game::find_actor(v.state, &js::s(v.command.get("actor_id"))).is_some_and(sk_core::game::is_living_actor)
}

/// `currencyToCopper(playerActor(state, command.actor_id).currency)`.
fn actor_balance_cp(v: &Validation<'_>) -> f64 {
    let hero = player_actor(v.state, v.command.get("actor_id"));
    sk_economy::merchant_economy::currency_to_copper(hero.and_then(|hero| hero.get("currency"))) as f64
}

/// Блок 11 (6204–6213): команды мира NPC.
pub fn check_npc_world(v: &mut Validation<'_>) -> Step {
    if !sk_npc_world::npc_positioning::NPC_WORLD_COMMAND_TYPES.contains(&command_type(v).as_str()) {
        return Ok(());
    }
    match sk_npc_world::npc_positioning::validate_npc_world_command(&v.command, v.state, &v.context.json()) {
        Ok(patch) => {
            assign(&mut v.command, patch);
            Ok(())
        }
        Err(error) => Err(rule(error.message, &error.code)),
    }
}

/// Блок 12 (6214–6243): пленные.
pub fn check_captive(v: &mut Validation<'_>) -> Step {
    use sk_world_life::captives::{captive_for, captive_settlement_for, CAPTIVE_COMMAND_TYPES, CAPTIVE_PLAYER_COMMAND_TYPES};
    let kind = command_type(v);
    if !CAPTIVE_COMMAND_TYPES.contains(&kind.as_str()) {
        return Ok(());
    }
    let Some(captive) = captive_for(v.state, v.command.get("captive_id")).filter(|captive| js::truthy(Some(captive))) else {
        return Err(rule("Пленный не найден", "CAPTIVE_NOT_FOUND"));
    };
    if captive.get("status").and_then(Value::as_str) != Some("held") {
        return Err(rule("Судьба этого пленного уже решена", "CAPTIVE_ALREADY_RESOLVED"));
    }
    if kind == "NeglectCaptive" && !v.context.is_director() && !v.context.is_admin() {
        return Err(rule("Голод пленного отмечают только серверные часы кампании", "CAPTIVE_NEGLECT_FORBIDDEN"));
    }
    if CAPTIVE_PLAYER_COMMAND_TYPES.contains(&kind.as_str()) {
        if sk_core::game::combat_active(v.state) {
            return Err(rule("С пленным разбираются после боя, а не посреди него", "CAPTIVE_DURING_COMBAT"));
        }
        if player_actor(v.state, v.command.get("actor_id")).is_none() {
            return Err(rule("Действие с пленным доступно только герою отряда", "ACTOR_FORBIDDEN"));
        }
        if !actor_living(v) {
            return Err(rule("Герой без сознания не может распорядиться пленным", "CAPTIVE_ACTOR_INCAPACITATED"));
        }
    }
    let length = |key: &str| captive.get(key).and_then(Value::as_array).map_or(0, Vec::len);
    if kind == "InterrogateCaptive" && length("revealed_fact_ids") >= length("known_fact_ids") {
        return Err(rule("Пленный уже рассказал всё, что знает", "CAPTIVE_KNOWLEDGE_EXHAUSTED"));
    }
    if kind == "HandCaptiveToGuards" && captive_settlement_for(v.state).is_none() {
        return Err(rule("Сдать пленного можно только в поселении, где есть стража", "CAPTIVE_NO_SETTLEMENT"));
    }
    Ok(())
}

/// Блок 13 (6244–6251): контейнер добычи.
pub fn check_loot_container(v: &mut Validation<'_>) -> Step {
    use sk_director::loot_containers::{validate_loot_container_command, LootContainerError, LOOT_CONTAINER_COMMAND_TYPES};
    if !LOOT_CONTAINER_COMMAND_TYPES.contains(&command_type(v).as_str()) {
        return Ok(());
    }
    match validate_loot_container_command(&v.command, v.state, &v.context.json()) {
        Ok(patch) => {
            assign(&mut v.command, patch);
            Ok(())
        }
        Err(error) if error.name == LootContainerError::NAME => Err(rule(error.message, error.code.as_deref().unwrap_or(""))),
        Err(error) => Err(Halt::Fault(Fault::new(error.name, error.message))),
    }
}

/// Блок 14 (6252–6260): звери.
pub fn check_beast(v: &mut Validation<'_>) -> Step {
    if !sk_npc_world::beast_taming::BEAST_COMMAND_TYPES.contains(&command_type(v).as_str()) {
        return Ok(());
    }
    if player_actor(v.state, v.command.get("actor_id")).is_none() {
        return Err(rule("Подойти к зверю может только герой отряда", "ACTOR_FORBIDDEN"));
    }
    if !actor_living(v) {
        return Err(rule("Герой без сознания к зверю не подойдёт", "ACTOR_DEFEATED"));
    }
    let patch = validated_beast_target(v.state, &v.command)?;
    assign(&mut v.command, patch);
    Ok(())
}

/// Блок 15 (6261–6287): переговоры.
pub fn check_parley(v: &mut Validation<'_>) -> Step {
    use sk_society::parley::{standing_enemies, truce_for, PARLEY_COMMAND_TYPES};
    let kind = command_type(v);
    if !PARLEY_COMMAND_TYPES.contains(&kind.as_str()) {
        return Ok(());
    }
    if !sk_core::game::combat_active(v.state) {
        return Err(rule("Переговоры посреди боя возможны только в бою", "COMBAT_NOT_ACTIVE"));
    }
    if player_actor(v.state, v.command.get("actor_id")).is_none() {
        return Err(rule("Вести переговоры может только герой отряда", "ACTOR_FORBIDDEN"));
    }
    if !actor_living(v) {
        return Err(rule("Герой без сознания не ведёт переговоров", "ACTOR_DEFEATED"));
    }
    let truce = truce_for(v.state).filter(|truce| js::truthy(Some(truce)));
    if kind == "ProposeParley" {
        if truce.is_some() {
            return Err(rule("Перемирие уже объявлено: договаривайтесь об условиях", "TRUCE_ALREADY_ACTIVE"));
        }
        if standing_enemies(v.state).is_empty() {
            return Err(rule("Переговоры вести не с кем: на ногах не осталось противников", "PARLEY_NO_TARGET"));
        }
    }
    if kind == "SettleParley" {
        let Some(truce) = truce else {
            return Err(rule("Условия обсуждают под перемирием, а его нет", "TRUCE_NOT_ACTIVE"));
        };
        if incapacitating_condition_for(v.state, &js::string(v.command.get("actor_id"))).is_some() {
            return Err(rule("Недееспособный герой не может заключить уговор", "ACTOR_INCAPACITATED"));
        }
        let outcome = v.command.get("outcome").cloned().unwrap_or(Value::Null);
        let allowed = truce.get("outcomes").and_then(Value::as_array).is_some_and(|outcomes| outcomes.iter().any(|candidate| js_includes_eq(candidate, &outcome)));
        if !allowed {
            return Err(rule("Противник на такие условия не пойдёт", "PARLEY_OUTCOME_FORBIDDEN"));
        }
    }
    Ok(())
}

/// Равенство элемента в `Array.prototype.includes` (SameValueZero) для JSON.
fn js_includes_eq(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Object(_), _) | (Value::Array(_), _) => false,
        _ => left == right,
    }
}

/// Отказ сборки встречи стражи: `RulesValidationError(error.message, error.code ?? 'ENCOUNTER_ASSEMBLY_REJECTED')`.
fn encounter_assembly_refusal(halt: Halt) -> Halt {
    match halt {
        Halt::Rule(error) => rule(error.message, &error.code),
        Halt::Fault(fault) => rule(fault.message, fault.code.as_deref().unwrap_or("ENCOUNTER_ASSEMBLY_REJECTED")),
        Halt::Pause(pause) => rule(pause.message().to_string(), "ENCOUNTER_ASSEMBLY_REJECTED"),
    }
}

/// Блок 16 (6288–6352): закон.
pub fn check_law(v: &mut Validation<'_>) -> Step {
    use sk_society::law_and_order::{current_region_id, guard_encounter_for, guard_encounter_is_here, wanted_for, GUARD_ENCOUNTER_DIFFICULTY, GUARD_ENCOUNTER_THEME, GUARD_RESOLUTIONS, LAW_COMMAND_TYPES};
    let kind = command_type(v);
    if !LAW_COMMAND_TYPES.contains(&kind.as_str()) {
        return Ok(());
    }
    if kind == "ClearWantedLevel" {
        if !v.context.is_admin() && !v.context.is_director() {
            return Err(rule("Снять розыск может только ведущий кампании", "WANTED_CLEAR_FORBIDDEN"));
        }
        let region = match v.command.get("region_id").filter(|value| js::truthy(Some(value))) {
            Some(region) => region.clone(),
            None => Value::String(current_region_id(v.state)),
        };
        set_field(&mut v.command, "region_id", region.clone());
        if !js::truthy(Some(&region)) {
            return Err(rule("Не указан край, с которого снимается розыск", "WANTED_REGION_REQUIRED"));
        }
        if js::number(wanted_for(v.state, &region).get("level")) <= 0.0 {
            return Err(rule("В этом краю отряд и так никто не ищет", "WANTED_ALREADY_CLEAR"));
        }
    }
    if kind == "ResolveGuardEncounter" {
        let encounter = guard_encounter_for(v.state);
        if !js::truthy(Some(&encounter)) {
            return Err(rule("Стража сейчас никого не останавливает", "GUARD_ENCOUNTER_NOT_ACTIVE"));
        }
        if !guard_encounter_is_here(v.state, Some(&encounter)) {
            return Err(rule("Эта стража осталась в другом месте", "GUARD_ENCOUNTER_ELSEWHERE"));
        }
        if sk_core::game::combat_active(v.state) {
            return Err(rule("Пока идёт бой, страже не отвечают", "GUARD_ENCOUNTER_DURING_COMBAT"));
        }
        let resolution = v.command.get("resolution").and_then(Value::as_str).unwrap_or_default().to_string();
        if !v.command.get("resolution").is_some_and(Value::is_string) || !GUARD_RESOLUTIONS.contains(&resolution.as_str()) {
            return Err(rule("Такого ответа страже не предусмотрено", "GUARD_RESOLUTION_FORBIDDEN"));
        }
        if player_actor(v.state, v.command.get("actor_id")).is_none() {
            return Err(rule("Отвечать страже может только герой отряда", "ACTOR_FORBIDDEN"));
        }
        if !actor_living(v) {
            return Err(rule("Герой без сознания страже не отвечает", "ACTOR_DEFEATED"));
        }
        if resolution == "fine" && actor_balance_cp(v) < js::number(encounter.get("fine_cp")) {
            return Err(rule("На виру не хватает монет", "INSUFFICIENT_FUNDS"));
        }
        if resolution == "fight" {
            let living_enemy = v.state.get("enemies").and_then(Value::as_array).is_some_and(|enemies| enemies.iter().any(sk_core::game::is_living_actor));
            let status = js::s(v.state.get("mechanics").and_then(|mechanics| mechanics.get("encounter")).and_then(|encounter| encounter.get("status")));
            if living_enemy || status == "staged" || status == "active" {
                return Err(rule("В сцене уже есть незавершённое столкновение", "ENCOUNTER_ALREADY_PRESENT"));
            }
            let level = js::string(encounter.get("level"));
            let difficulty = GUARD_ENCOUNTER_DIFFICULTY.iter().find(|(key, _)| key.to_string() == level).map_or("medium", |(_, difficulty)| *difficulty);
            let request = json!({ "difficulty": difficulty, "theme": GUARD_ENCOUNTER_THEME, "seed": format!("guard:{}", js::string(encounter.get("id"))) });
            let assembled = crate::combat::encounter::assemble_encounter_from_state(v.state, &request).map_err(encounter_assembly_refusal)?;
            set_field(&mut v.command, "encounter", assembled);
        }
    }
    Ok(())
}

/// Блок 17 (6353–6465): таверна.
pub fn check_tavern(v: &mut Validation<'_>) -> Step {
    use sk_npc_world::tavern_life::{is_tavern_opponent, is_tavern_scene, tavern_earmarked_cp_against, tavern_ejected, tavern_free_purse_for, tavern_gambler_purse_for, tavern_round_for, TAVERN_COMMAND_TYPES, TAVERN_DRINK_PRICE_CP, TAVERN_STAKES_CP};
    let kind = command_type(v);
    if !TAVERN_COMMAND_TYPES.contains(&kind.as_str()) {
        return Ok(());
    }
    if !is_tavern_scene(v.state) {
        return Err(rule("Ни костей, ни выпивки здесь не подают: это не таверна", "TAVERN_SCENE_REQUIRED"));
    }
    if sk_core::game::combat_active(v.state) {
        return Err(rule("Посреди боя не играют и не пьют", "TAVERN_DURING_COMBAT"));
    }
    if player_actor(v.state, v.command.get("actor_id")).is_none() {
        return Err(rule("За стол садится только герой отряда", "ACTOR_FORBIDDEN"));
    }
    if !actor_living(v) {
        return Err(rule("Герой без сознания за стол не садится", "ACTOR_DEFEATED"));
    }
    let null = Value::Null;
    let actor_id = v.command.get("actor_id").unwrap_or(&null).clone();
    if kind != "LeaveTavernDiceRound" && tavern_ejected(v.state, &actor_id) {
        return Err(rule("Героя уже выставили за дверь этого заведения", "TAVERN_PATRON_EJECTED"));
    }
    let round = tavern_round_for(v.state, &actor_id);
    if kind == "OpenTavernDiceRound" {
        if round.is_some() {
            return Err(rule("Кость соперника уже на столе: сначала ответьте на бросок", "TAVERN_ROUND_ALREADY_OPEN"));
        }
        let stake = v.command.get("stake_cp").and_then(Value::as_f64);
        if !stake.is_some_and(|stake| TAVERN_STAKES_CP.iter().any(|allowed| *allowed as f64 == stake)) {
            return Err(rule("Такой ставки за этим столом не принимают", "TAVERN_STAKE_FORBIDDEN"));
        }
        let stake = stake.unwrap_or_default();
        let npc_id = v.command.get("npc_id").unwrap_or(&null).clone();
        if !is_tavern_opponent(v.state, &npc_id) {
            return Err(rule("С этим за костями никто не сидит", "TAVERN_OPPONENT_NOT_FOUND"));
        }
        if actor_balance_cp(v) < stake {
            return Err(rule("На такую ставку у героя не хватает монет", "INSUFFICIENT_FUNDS"));
        }
        if tavern_free_purse_for(v.state, &npc_id) < stake {
            let message = if tavern_earmarked_cp_against(v.state, &npc_id) > 0 {
                "Соперник такую ставку не закроет: его кассу уже держат другие раунды"
            } else {
                "Соперник такую ставку не закроет: у него столько нет"
            };
            return Err(rule(message, "TAVERN_OPPONENT_BROKE"));
        }
    }
    if kind == "AnswerTavernDiceRound" {
        let Some(round) = &round else {
            return Err(rule("Кости на стол ещё никто не бросал", "TAVERN_ROUND_NOT_OPEN"));
        };
        if tavern_gambler_purse_for(v.state, &Value::String(round.npc_id.clone())).is_some_and(|purse| purse < round.stake_cp) {
            return Err(rule("Соперник уже спустил всё: банк ему нечем закрыть", "TAVERN_OPPONENT_BROKE"));
        }
    }
    if kind == "LeaveTavernDiceRound" && round.is_none() {
        return Err(rule("Из-за стола можно встать только с открытым раундом", "TAVERN_ROUND_NOT_OPEN"));
    }
    if kind == "OrderTavernDrink" && actor_balance_cp(v) < TAVERN_DRINK_PRICE_CP as f64 {
        return Err(rule("На выпивку не хватает монет", "INSUFFICIENT_FUNDS"));
    }
    Ok(())
}

/// Блок 25 (6641–6679): благословение.
pub fn check_blessing(v: &mut Validation<'_>) -> Step {
    use sk_npc_world::blessings::{blessing_availability_for, hero_is_blessed, is_blessing_priest, BLESSING_COMMAND_TYPES, BLESSING_DONATION_CP};
    if !BLESSING_COMMAND_TYPES.contains(&command_type(v).as_str()) {
        return Ok(());
    }
    if sk_core::game::combat_active(v.state) {
        return Err(rule("Посреди боя благословений не раздают", "BLESSING_DURING_COMBAT"));
    }
    if player_actor(v.state, v.command.get("actor_id")).is_none() {
        return Err(rule("Благословение принимает только герой отряда", "ACTOR_FORBIDDEN"));
    }
    if !actor_living(v) {
        return Err(rule("Герой без сознания благословения не принимает", "ACTOR_DEFEATED"));
    }
    let null = Value::Null;
    if !is_blessing_priest(v.state, v.command.get("npc_id").unwrap_or(&null)) {
        return Err(rule("Этот человек благословений не даёт", "BLESSING_PRIEST_NOT_FOUND"));
    }
    if actor_balance_cp(v) < BLESSING_DONATION_CP as f64 {
        return Err(rule("На пожертвование не хватает монет", "INSUFFICIENT_FUNDS"));
    }
    let actor_id = v.command.get("actor_id").unwrap_or(&null);
    let minutes = js::num(sk_social::npc_social::campaign_elapsed_minutes(v.state));
    if !blessing_availability_for(v.state, actor_id, Some(&minutes)).available {
        return Err(rule("Этот герой уже обращался к богам сегодня", "BLESSING_ALREADY_TODAY"));
    }
    if hero_is_blessed(v.state, actor_id) {
        return Err(rule("Благословение этого героя ещё не израсходовано", "BLESSING_ALREADY_ACTIVE"));
    }
    Ok(())
}

/// Блок 26 (6683): письмо.
pub fn check_courier_letter(v: &mut Validation<'_>) -> Step {
    if sk_world_life::courier_letters::COURIER_LETTER_COMMAND_TYPES.contains(&command_type(v).as_str()) {
        assert_send_letter_allowed(v.state, &v.command)?;
    }
    Ok(())
}

//! Редьюсер событий — перенос `applyGameEventCurrent` (`rules-engine.mjs`).
//!
//! Событие применяется к состоянию той же JSON-формы, что в JS. После ветки
//! события идут общие шаги: память карты сцены, реестры-выводы из журнала
//! (летопись поступков, закон, таверна…), версия состояния и тактический ход.

mod combat;
mod conditions;
mod effects;
mod labels;
mod spells;
mod turns;
mod vitals;

use serde_json::Value;
use sk_core::js::safe_int;
use sk_core::Event;

/// Что делать с событием этого типа.
type Handler = fn(&mut Value, &Event);

fn handler(event_type: &str) -> Option<Handler> {
    Some(match event_type {
        // Только журнал: на состояние не влияют.
        "DieRolled" => noop,
        // Живучесть.
        "DamageApplied" => vitals::damage_applied,
        "HitPointMaximumReduced" => vitals::hit_point_maximum_reduced,
        "HitPointMaximumIncreased" => vitals::hit_point_maximum_increased,
        "HitPointMaximumReductionPrevented" => vitals::hit_point_maximum_reduction_prevented,
        "HealingApplied" => vitals::healing_applied,
        "CreatureKnockedOut" => vitals::creature_knocked_out,
        "KnockoutRecoveryProgressed" => vitals::knockout_recovery_progressed,
        "KnockoutEnded" => vitals::knockout_ended,
        "DeathSavingThrowRolled" => vitals::death_saving_throw_rolled,
        "DeathSaveFailureRecorded" => vitals::death_save_failure_recorded,
        "StableRecoveryScheduled" => vitals::stable_recovery_scheduled,
        "StableRecoveryProgressed" => vitals::stable_recovery_progressed,
        "HeroStabilized" => vitals::hero_stabilized,
        "HeroDied" => vitals::hero_died,
        "HeroResurrected" | "HeroReplaced" => vitals::hero_resurrected_or_replaced,
        "TemporaryHitPointsGranted" => vitals::temporary_hit_points_granted,
        "HitPointsReducedToZero" => vitals::hit_points_reduced_to_zero,
        "ResourceSpent" | "ResourceRestored" => vitals::resource_changed,
        // Состояния и концентрация.
        "ConditionAdded" => conditions::condition_added,
        "ConditionRemoved" => conditions::condition_removed,
        "SpellSavingThrowResolved" => conditions::spell_saving_throw_resolved,
        "ConcentrationSavingThrowResolved" => conditions::concentration_saving_throw_resolved,
        "ConcentrationStarted" => conditions::concentration_started,
        "ConcentrationEnded" => conditions::concentration_ended,
        "EnemyKnowledgeRevealed" => conditions::enemy_knowledge_revealed,
        // Бой.
        "SneakAttackApplied" => combat::sneak_attack_applied,
        "AttackResolved" => combat::attack_resolved,
        "AreaAttackResolved" => combat::area_attack_resolved,
        "CombatActionUsed" => combat::combat_action_used,
        // Ход, раунд, отдых, время.
        "CombatRoundTimeMarked" => turns::combat_round_time_marked,
        "TurnStarted" => turns::turn_started,
        "TurnEnded" => turns::turn_ended,
        "CombatEnded" => turns::combat_ended,
        "EncounterEnded" => turns::encounter_ended,
        "RestStarted" => turns::rest_started,
        "HitPointDieSpent" | "HitPointDiceRestored" => turns::hit_point_dice_changed,
        "TimeAdvanced" => turns::time_advanced,
        // Заклинание, облик, призыв.
        "SpellCast" => spells::spell_cast,
        "ShapeChanged" => spells::shape_changed,
        "SummonedCreatureCreated" => spells::summoned_creature_created,
        // Эффекты боя без внешних модулей.
        "SpellAreaCreated" => effects::spell_area_created,
        "SpellAreaTriggered" => effects::spell_area_triggered,
        "SpellAreaRemoved" => effects::spell_area_removed,
        "ReactionWindowOpened" => effects::reaction_window_opened,
        "ReactionWindowClosed" => effects::reaction_window_closed,
        "ActionReadied" => effects::action_readied,
        "ReadiedActionExpired" => effects::readied_action_expired,
        "ReactionDamageReduced" => effects::reaction_damage_reduced,
        "SpellCountered" => effects::spell_countered,
        "ShapeReverted" => effects::shape_reverted,
        "SummonedCreatureDismissed" => effects::summoned_creature_dismissed,
        "PublicDieRolled" => effects::public_die_rolled,
        "OpeningStrikeEconomyRestored" => effects::opening_strike_economy_restored,
        "SpellBonusPreferenceChanged" => effects::spell_bonus_preference_changed,
        "ReactionPreferenceChanged" => effects::reaction_preference_changed,
        "LegendaryActionUsed" => combat::legendary_action_used,
        // Жизнь кампании.
        "CampaignActivated" | "CampaignResumed" => effects::campaign_resumed,
        "CampaignPaused" => effects::campaign_paused,
        "CampaignArchived" => effects::campaign_archived,
        "CampaignCompleted" | "CampaignFailed" => effects::campaign_concluded,
        "CampaignHouseRuleChanged" => effects::campaign_house_rule_changed,
        "CampaignRulesetChanged" => effects::campaign_ruleset_changed,
        "ObjectiveUpdated" => effects::objective_updated,
        "RulingRecorded" => effects::ruling_recorded,
        _ => return None,
    })
}

fn noop(_: &mut Value, _: &Event) {}

/// Перенесено ли событие этого типа.
pub fn is_ported(event_type: &str) -> bool {
    handler(event_type).is_some() || !labels::JS_REDUCER_EVENT_TYPES.contains(&event_type)
}

/// Применить событие: ветка типа и общие шаги после неё.
pub fn apply_event(state: &mut Value, event: &Event) {
    if let Some(apply) = handler(&event.event_type) {
        apply(state, event);
    }
    crate::scene_maps::remember_current_scene_map(state);
    apply_registries(state, event);
    let next_version = event
        .extra
        .get("state_version_after")
        .filter(|value| sk_core::js::is_safe_integer(Some(value)))
        .map(|value| safe_int(Some(value), 0))
        .unwrap_or_else(|| sk_core::game::state_version(state) + 1);
    state["state_version"] = Value::from(next_version);
    synchronize_tactical_turn(state);
}

/// Реестры-выводы из журнала — в порядке JS: летопись поступков, закон,
/// таверна, благословения, мир за кадром, почта, пленные, внимание
/// противника, рыцарь, разговоры, звери, автономия. Закон читает уже готовую
/// летопись; остальные реестры подключаются по мере переноса их модулей.
fn apply_registries(state: &mut Value, event: &Event) {
    let event_json = serde_json::to_value(event).unwrap_or(Value::Null);
    let law = sk_society::law_and_order::apply_law_event(state.get("law"), &event_json, state);
    state["law"] = law;
}

/// `synchronizeTacticalTurn(state)`.
fn synchronize_tactical_turn(state: &mut Value) {
    let combat = sk_core::game::combat(state);
    let active_index = safe_int(combat.get("active_index"), -1);
    let initiative = combat.get("initiative").and_then(Value::as_array).cloned().unwrap_or_default();
    if !sk_core::js::is_true(combat.get("active")) || initiative.is_empty() || active_index < 0 {
        return;
    }
    let active_id = sk_core::js::s(initiative.get(active_index as usize).and_then(|entry| entry.get("actor_id")));
    if active_id.is_empty() {
        return;
    }
    let round = combat.get("round").cloned().unwrap_or(Value::Null);
    let economy = crate::economy::economy_of(state, &active_id);
    let scene_turn = safe_int(state.get("scene").and_then(|scene| scene.get("turn")), safe_int(Some(&round), 0));
    state["activePlayerId"] = Value::String(active_id.clone());
    state["tacticalTurn"] = serde_json::json!({
        "sceneTurn": scene_turn,
        "actorId": active_id,
        "movementSpent": safe_int(economy.get("movement_spent"), 0).max(0),
        "actionUsed": economy.get("action") == Some(&Value::Bool(false)),
        "round": round,
        "activeIndex": active_index,
    });
}

/// Выбросить производные поля героя — как делает запись корпуса.
pub fn strip_derived(state: &mut Value) {
    if let Some(players) = state.get_mut("players").and_then(Value::as_array_mut) {
        for player in players {
            if let Some(map) = player.as_object_mut() {
                for field in ["combatSpells", "combatActions", "characterSheet", "inventoryLoad"] {
                    map.shift_remove(field);
                }
            }
        }
    }
}

/// Общие поля записи боевого журнала: ход сцены и раунд.
pub(crate) fn scene_turn_and_round(state: &Value) -> (i64, Value) {
    let round = sk_core::game::combat(state).get("round").cloned().unwrap_or(Value::Null);
    let scene_turn = safe_int(state.get("scene").and_then(|scene| scene.get("turn")), safe_int(Some(&round), 0));
    (scene_turn, round)
}

/// Цель события: первая из `target_ids`, иначе действующее лицо.
pub(crate) fn target_of(event: &Event) -> String {
    let unique = sk_core::js::unique_strings(Some(&Value::Array(event.target_ids.iter().map(|id| Value::String(id.clone())).collect())));
    unique.into_iter().next().unwrap_or_else(|| event.actor_id.clone().unwrap_or_default())
}

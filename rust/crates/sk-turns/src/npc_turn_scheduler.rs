//! Перенос `server/npc-turn-scheduler.mjs`: детерминированная боевая политика
//! NPC и цикл ходов сервера.
//!
//! - [`plan_npc_turn`] — план хода существа (снаряжение, магия стат-блока,
//!   области, подход, удар, отход). Модели здесь нет: то же состояние даёт
//!   тот же план, порядок перебора кандидатов и ничьи — как в JS, сортировки
//!   с компаратором — только [`sk_core::v8sort::sort_by`];
//! - [`plan_legendary_action`] — легендарное действие босса между чужими ходами;
//! - [`run_npc_turn_scheduler`] — цикл сервера: ходы NPC, конец боя,
//!   легендарные действия, восстановление стабилизированного отряда. Мораль
//!   спрашивается один раз на пороге через [`NpcController`], вне момента
//!   морали контроллер не зовётся. Момент морали и перевод решения в команды —
//!   детерминированное ядро [`crate::morale`]; роль модели `NpcMoraleAgent`
//!   и её реализация [`NpcController`] — в слое агентов
//!   (`sk_agents::npc_controller`), ядро от него не зависит.
//!
//! Ошибки, которые JS бросил бы наружу (отказ нормализации, `TypeError`
//! движка), возвращаются как [`Halt`] / [`SchedulerError`].

use std::cell::{OnceCell, RefCell};
use std::future::Future;
use std::pin::Pin;

use serde_json::{json, Map, Value};
use sk_combat_base::legendary_actions::{choose_legendary_action, is_boss_actor, legendary_profile_for, legendary_uses_spent, legendary_window_key, legendary_window_spent, LegendaryTarget};
use sk_combat_base::monster_actions::{monster_action_available, monster_attack_target_allowed, monster_multiattack_sequence_for, monster_multiattack_sequences};
use sk_combat_content::combat_spells::{is_hostile_summon, is_party_summon, is_untargetable_summon, monster_combat_spell_for, monster_spell_uses_spent_in, monster_spellcasting_for};
use sk_core::indexmap::IndexSet;
use sk_core::{game, hash, js, re, text, v8sort, MechanicsSupport, RuleError};
use crate::morale::{commands_for_morale_decision, is_morale_moment};
use sk_economy::npc_equipment::{npc_action_unavailable_reason, npc_needs_healing_potion, npc_tactic_condition, npc_usable_items, npc_weapon_binding_for};
use sk_geometry::actor_footprint::{footprint_distance_feet, footprint_size_for};
use sk_geometry::Point;
use sk_rules::areas::shape::spell_targets_at;
use sk_rules::combat::turn::initiative_group_ids;
use sk_rules::combat::weapons::attack_profile_for;
use sk_rules::context::Context;
use sk_rules::core::incapacitating_condition_for;
use sk_rules::geometry::movement::movement_for_actor;
use sk_rules::geometry::terrain::movement_step_cost_for;

use sk_rules::normalize::normalize_campaign_state;
use sk_rules::normalized::NormalizedState;
use sk_rules::pause::{Fault, Halt};
use sk_rules::preview_attack::preview_monster_action;
use sk_rules::resolve::api::RulesEngine;
use sk_rules::speed::effective_speed_feet;
use sk_rules::spells::slots::spell_damage_estimate;
use sk_rules::tactical_geometry::{actor_point, cover_between, footprint_cells, has_clear_trajectory, high_ground_between, key, key_of, occupied_positions, point_json, shortest_tactical_path, KeySet, PathOptions, StepCost};
use sk_scenario::campaign_scenario::scenario_encounter_end_reason;
use sk_society::parley::truce_holds;
use sk_store::executor::{AuthoritativeExecutor, Executed, ExecutorError, Journal};
use sk_store::{EventStore, StoreError, StoreResult};

const CELL_FEET: f64 = 5.0;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Словарь повадок: имя черты на стат-блоке → политика, которая её исполняет
/// (`NPC_BEHAVIOR_POLICIES`). Порядок — как в JS.
pub const NPC_BEHAVIOR_POLICIES: [(&str, &str); 5] = [
    ("multiattack", "multiattack"),
    ("keepDistance", "keep-distance"),
    ("charge", "charge"),
    ("bloodiedFrenzy", "bloodied-frenzy"),
    ("relentlessPursuit", "relentless-pursuit"),
];

const MULTIATTACK: &str = "multiattack";
const KEEP_DISTANCE: &str = "keep-distance";
const BLOODIED_FRENZY: &str = "bloodied-frenzy";
const RELENTLESS_PURSUIT: &str = "relentless-pursuit";

/// `NPC_BEHAVIOR_POLICIES` объектом JSON.
pub fn npc_behavior_policies() -> Value {
    Value::Object(NPC_BEHAVIOR_POLICIES.iter().map(|(name, policy)| ((*name).to_string(), Value::from(*policy))).collect())
}

/// Укрытие цели: штраф выбора цели (`COVER_TARGET_PENALTY`).
fn cover_target_penalty(level: &str) -> f64 {
    match level {
        "none" => 0.0,
        "half" => 70.0,
        "three-quarters" => 160.0,
        _ => 0.0,
    }
}

/// Собственное укрытие стрелка (`OWN_COVER_BONUS`).
fn own_cover_bonus(level: &str) -> f64 {
    match level {
        "none" => 0.0,
        "half" => 45.0,
        "three-quarters" => 90.0,
        _ => 0.0,
    }
}

const CLEAR_SHOT_BONUS: f64 = 200.0;
const HIGH_GROUND_BONUS: f64 = 120.0;
/// Надбавка заряженной recharge-способности: она сильнее обычной атаки.
const RECHARGE_READY_BONUS: f64 = 120.0;
/// Потолки перебора: позиции сначала оцениваются геометрией, путь
/// проверяется только у лучших.
const MAX_EVALUATED_POSITIONS: usize = 24;
const MAX_ROUTED_POSITIONS: usize = 5;
const MAX_COVER_THREATS: usize = 3;
const BLOODIED_RATIO: f64 = 0.25;
/// Союзник-NPC зовёт на помощь, когда потерял половину и больше.
const NPC_SPELL_HEAL_HP_PERCENT: f64 = 50.0;

// --- приведения JS ---------------------------------------------------------------------

fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value?.as_object()?.get(key)
}

fn path<'a>(value: Option<&'a Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().try_fold(value?, |current, key| get(Some(current), key))
}

/// `a ?? b`.
fn nullish<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    match first {
        Some(value) if !value.is_null() => Some(value),
        _ => second,
    }
}

fn number(value: Option<&Value>) -> f64 {
    js::number(value)
}

/// `Number(x) || fallback`.
fn number_or(value: Option<&Value>, fallback: f64) -> f64 {
    let value = js::number(value);
    if value == 0.0 || value.is_nan() {
        fallback
    } else {
        value
    }
}

/// `x || fallback` для числа.
fn or_number(value: f64, fallback: f64) -> f64 {
    if value == 0.0 || value.is_nan() {
        fallback
    } else {
        value
    }
}

/// `Math.max(a, b)` с заразным `NaN`.
fn max2(a: f64, b: f64) -> f64 {
    js::max_of([a, b])
}

/// `Math.min(a, b)` с заразным `NaN`.
fn min2(a: f64, b: f64) -> f64 {
    js::min_of([a, b])
}

fn truthy_number(value: f64) -> bool {
    value != 0.0 && !value.is_nan()
}

/// `a || b` для ответа сравнителя: `0` и `NaN` уступают следующему.
fn or_else(first: f64, next: impl FnOnce() -> f64) -> f64 {
    if first == 0.0 || first.is_nan() {
        next()
    } else {
        first
    }
}

fn compare_text(left: &str, right: &str) -> f64 {
    match text::locale_compare(left, right) {
        std::cmp::Ordering::Less => -1.0,
        std::cmp::Ordering::Equal => 0.0,
        std::cmp::Ordering::Greater => 1.0,
    }
}

/// Индексы `0..len`, упорядоченные сравнителем JS (TimSort V8).
fn sorted_indices(len: usize, compare: impl FnMut(usize, usize) -> f64) -> Vec<usize> {
    let mut compare = compare;
    let mut order: Vec<usize> = (0..len).collect();
    v8sort::sort_by(&mut order, |left, right| compare(*left, *right));
    order
}

fn list(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items.as_slice(),
        _ => &[],
    }
}

fn id_of(actor: &Value) -> String {
    game::actor_id(actor)
}

fn type_is(value: Option<&Value>, expected: &str) -> bool {
    value.and_then(Value::as_str) == Some(expected)
}

/// `arr[index]` по числу JS: только целый неотрицательный индекс.
fn at_index(items: &[Value], index: f64) -> Option<&Value> {
    (index >= 0.0 && index.fract() == 0.0 && index < items.len() as f64).then(|| &items[index as usize])
}

fn point_of(value: Option<Point>) -> Option<Value> {
    value.map(point_json)
}

fn economy_of<'a>(state: &'a Value, id: &str) -> Option<&'a Value> {
    path(Some(state), &["mechanics", "combat", "action_economy", id])
}

fn conditions_of<'a>(state: &'a Value, id: &str) -> &'a [Value] {
    list(path(Some(state), &["mechanics", "conditions", id]))
}

/// `conditionIds(state, id)`: `new Set(conditions.map((c) => String(c?.id ?? c)))`.
fn condition_ids(state: &Value, id: &str) -> IndexSet<String> {
    conditions_of(state, id).iter().map(condition_id).collect()
}

fn condition_id(condition: &Value) -> String {
    js::string(nullish(get(Some(condition), "id"), Some(condition)))
}

fn single(text: &str) -> Value {
    Value::String(text.to_string())
}

fn end_turn(actor_id: &str) -> Value {
    json!({ "command_type": "EndTurn", "actor_id": actor_id })
}

// --- участники боя -------------------------------------------------------------------

fn party_members(state: &Value) -> IndexSet<String> {
    let ids = state.get("partyMemberIds");
    let filled = matches!(ids, Some(Value::Array(items)) if !items.is_empty());
    if filled {
        list(ids).iter().map(|id| js::string(Some(id))).collect()
    } else {
        list(state.get("players")).iter().map(id_of).collect()
    }
}

/// `isCombatCapable(state, actor)`.
fn is_combat_capable(state: &Value, actor: &Value) -> bool {
    if !game::is_living_actor(actor) {
        return false;
    }
    let id = id_of(actor);
    !type_is(path(Some(state), &["mechanics", "resting", &id, "reason"]), "knockout") && !condition_ids(state, &id).contains("unconscious")
}

/// `livingParty(state)`: живые боеспособные герои отряда и их призывы.
fn living_party(state: &Value) -> Vec<&Value> {
    let members = party_members(state);
    let mut party: Vec<&Value> = list(state.get("players")).iter().filter(|actor| members.contains(&id_of(actor)) && is_combat_capable(state, actor)).collect();
    party.extend(list(state.get("actors")).iter().filter(|actor| {
        is_party_summon(Some(actor))
            && !is_untargetable_summon(Some(actor))
            && members.contains(&js::string(nullish(actor.get("ownerId"), actor.get("owner_id"))))
            && is_combat_capable(state, actor)
    }));
    party
}

/// `unstableDyingParty(state)`: упавшие герои, чьи спасброски ещё идут.
fn unstable_dying_party(state: &Value) -> Vec<&Value> {
    let members = party_members(state);
    let combat = path(Some(state), &["mechanics", "combat"]);
    let queued: IndexSet<String> = list(get(combat, "initiative")).iter().map(|entry| js::s(get(Some(entry), "actor_id"))).collect();
    let combat_active = js::is_true(get(combat, "active"));
    list(state.get("players"))
        .iter()
        .filter(|actor| {
            let id = id_of(actor);
            let tracker = path(Some(state), &["mechanics", "death", "saving_throws", &id]);
            members.contains(&id)
                && (!combat_active || queued.contains(&id))
                && number(actor.get("hp")) == 0.0
                && !type_is(path(Some(state), &["mechanics", "death", "heroes", &id, "status"]), "dead")
                && !js::is_true(get(tracker, "stable"))
        })
        .collect()
}

/// `stableUnconsciousParty(state)`.
fn stable_unconscious_party(state: &Value) -> Vec<&Value> {
    let members = party_members(state);
    list(state.get("players"))
        .iter()
        .filter(|actor| {
            let id = id_of(actor);
            let tracker = path(Some(state), &["mechanics", "death", "saving_throws", &id]);
            members.contains(&id) && number(actor.get("hp")) == 0.0 && !type_is(path(Some(state), &["mechanics", "death", "heroes", &id, "status"]), "dead") && js::is_true(get(tracker, "stable"))
        })
        .collect()
}

/// `livingEnemies(state)`: враги встречи и враждебные призывы.
fn living_enemies(state: &Value) -> Vec<&Value> {
    let encounter: IndexSet<String> = match path(Some(state), &["mechanics", "encounter", "enemy_ids"]) {
        Some(Value::Array(ids)) => ids.iter().map(|id| js::string(Some(id))).collect(),
        _ => IndexSet::new(),
    };
    list(state.get("enemies"))
        .iter()
        .filter(|enemy| is_combat_capable(state, enemy) && (encounter.is_empty() || encounter.contains(&id_of(enemy)) || is_hostile_summon(Some(enemy))))
        .collect()
}

fn source_effect(actor: &Value) -> String {
    js::s(nullish(actor.get("sourceEffectId"), actor.get("source_effect_id")))
}

/// `attackableTargetsFor(state, enemy)`.
fn attackable_targets_for<'a>(state: &'a Value, enemy: &Value) -> Vec<&'a Value> {
    let mut targets = living_party(state);
    if js::is_true(enemy.get("hostile_to_all")) {
        let own = source_effect(enemy);
        let enemy_id = id_of(enemy);
        targets.extend(living_enemies(state).into_iter().filter(|other| id_of(other) != enemy_id && !(is_hostile_summon(Some(other)) && source_effect(other) == own)));
    } else {
        targets.extend(living_enemies(state).into_iter().filter(|other| is_hostile_summon(Some(other))));
    }
    targets
}

// --- геометрия -----------------------------------------------------------------------

/// `distanceFeetBetweenActors(state, leftId, rightId, leftPosition, rightPosition)`:
/// `None` позиции — `null` в JS (площадь — по полям самой карточки).
fn distance_between(state: &Value, left_id: &str, right_id: &str, left: Option<Point>, right: Option<Point>) -> f64 {
    let left_anchor = point_of(left);
    let right_anchor = point_of(right);
    footprint_distance_feet(game::find_actor(state, left_id), game::find_actor(state, right_id), left_anchor.as_ref(), right_anchor.as_ref()).unwrap_or(f64::INFINITY)
}

/// `distanceFeetBetweenActors(state, leftId, rightId)` с позициями по умолчанию.
fn distance_default(state: &Value, left_id: &str, right_id: &str) -> f64 {
    distance_between(state, left_id, right_id, actor_point(state, left_id), actor_point(state, right_id))
}

/// `distanceFeetToPoint(state, actorId, position, point)`.
fn distance_to_point(state: &Value, actor_id: &str, position: Option<Point>, point: Point) -> f64 {
    let anchor = point_of(position);
    let target = json!([point_json(point)]);
    footprint_distance_feet(game::find_actor(state, actor_id), Some(&target), anchor.as_ref(), None).unwrap_or(f64::INFINITY)
}

/// `gridDistance({ state, id }, { state, id })`.
fn grid_distance(state: &Value, left_id: &str, right_id: &str) -> f64 {
    let feet = distance_default(state, left_id, right_id);
    if feet.is_finite() {
        feet / CELL_FEET
    } else {
        MAX_SAFE_INTEGER
    }
}

fn cells_of(state: &Value, id: &str, position: Option<Point>) -> Vec<Point> {
    footprint_cells(game::find_actor(state, id), position)
}

/// `hasClearActorTrajectory(state, attackerId, targetId, from, to)`.
fn clear_between(state: &Value, attacker_id: &str, target_id: &str, from: Option<Point>, to: Option<Point>) -> bool {
    let starts = cells_of(state, attacker_id, from);
    let ends = cells_of(state, target_id, to);
    starts.iter().any(|start| ends.iter().any(|end| has_clear_trajectory(state, *start, *end)))
}

/// `hasClearActorToPoint(state, actorId, from, to)`.
fn clear_to_point(state: &Value, actor_id: &str, from: Option<Point>, to: Point) -> bool {
    cells_of(state, actor_id, from).iter().any(|start| has_clear_trajectory(state, *start, to))
}

/// `traitFor(actor, id)`: объект черты, `{ id }` для строки, иначе `None`.
fn trait_for(actor: &Value, id: &str) -> Option<Value> {
    let found = list(actor.get("traits")).iter().find(|candidate| js::string(nullish(get(Some(candidate), "id"), Some(candidate))) == id)?;
    if found.is_object() || found.is_array() {
        Some(found.clone())
    } else if js::truthy(Some(found)) {
        Some(json!({ "id": id }))
    } else {
        None
    }
}

fn has_trait(actor: &Value, id: &str) -> bool {
    trait_for(actor, id).is_some()
}

fn profile_kind(profile: Option<&Value>) -> Option<&str> {
    get(profile, "kind").and_then(Value::as_str)
}

// --- действия существа ---------------------------------------------------------------

/// `multiattackActionCounts(multiattack)`: счётчики по действию, ключи по
/// `localeCompare`.
fn multiattack_action_counts(multiattack: Option<&Value>) -> Vec<(String, f64)> {
    let Some(Value::Object(counts)) = get(multiattack, "action_counts") else { return Vec::new() };
    let entries: Vec<(String, f64)> = js::entries(counts)
        .into_iter()
        .map(|(id, count)| (id.clone(), max2(0.0, min2(8.0, number_or(Some(count), 0.0)))))
        .filter(|(id, count)| !id.is_empty() && *count > 0.0)
        .collect();
    let order = sorted_indices(entries.len(), |left, right| compare_text(&entries[left].0, &entries[right].0));
    order.into_iter().map(|index| entries[index].clone()).collect()
}

fn count_for(counts: &[(String, f64)], id: &str) -> Option<f64> {
    counts.iter().find(|(key, _)| key == id).map(|(_, count)| *count)
}

/// `Array.from({ length })`: длина по `ToLength`.
fn js_length(value: f64) -> usize {
    if value.is_nan() || value <= 0.0 {
        0
    } else {
        value.floor().min(1.0e6) as usize
    }
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    list(value).iter().map(|id| js::string(Some(id))).collect()
}

/// `actionProfiles(state, enemy)`: профили движка, которыми существо может
/// ударить прямо сейчас.
fn action_profiles(state: &Value, enemy: &Value) -> Result<Vec<Value>, Halt> {
    let enemy_id = id_of(enemy);
    let explicit = list(enemy.get("action_profiles"));
    let spent: Vec<Value> = condition_ids(state, &enemy_id).into_iter().map(Value::String).collect();
    let economy = economy_of(state, &enemy_id);
    let attacks_used = max2(0.0, number_or(get(economy, "attacks_used"), 0.0));
    let multiattack = trait_for(enemy, MULTIATTACK);
    let action_counts = multiattack_action_counts(multiattack.as_ref());
    let used_action_ids: Vec<String> = match get(economy, "multiattack_action_ids") {
        Some(Value::Array(ids)) => ids.iter().map(|id| js::string(Some(id))).collect(),
        _ if attacks_used > 0.0 && js::truthy(get(economy, "multiattack_action_id")) => vec![js::string(get(economy, "multiattack_action_id"))],
        _ => Vec::new(),
    };
    let fixed_sequence: Vec<String> = match get(multiattack.as_ref(), "sequence") {
        Some(Value::Array(_)) => string_list(get(multiattack.as_ref(), "sequence")).into_iter().filter(|id| !id.is_empty()).collect(),
        _ => Vec::new(),
    };
    let sequences = monster_multiattack_sequences(Some(enemy));
    let next_index = (attacks_used.fract() == 0.0).then_some(attacks_used as usize);
    let allowed_next: IndexSet<String> = sequences
        .iter()
        .filter(|sequence| used_action_ids.iter().enumerate().all(|(index, id)| sequence.get(index) == Some(id)))
        .filter_map(|sequence| next_index.and_then(|index| sequence.get(index)).cloned())
        .filter(|id| !id.is_empty())
        .collect();
    let required_action_id: Option<String> = if js::is_true(get(multiattack.as_ref(), "same_action")) && attacks_used > 0.0 {
        Some(js::s(get(economy, "multiattack_action_id"))).filter(|id| !id.is_empty())
    } else if !sequences.is_empty() {
        None
    } else {
        next_index.and_then(|index| fixed_sequence.get(index)).cloned()
    };
    let available: Vec<&Value> = explicit
        .iter()
        .filter(|action| {
            let action_id = js::s(get(Some(action), "id"));
            monster_action_available(Some(action), &spent)
                && (sequences.is_empty() || allowed_next.contains(&js::string(get(Some(action), "id"))))
                && required_action_id.as_ref().is_none_or(|required| &action_id == required)
                && npc_action_unavailable_reason(Some(enemy), Some(&single(&action_id))).is_none()
                && (action_counts.is_empty() || (used_action_ids.iter().filter(|id| **id == action_id).count() as f64) < count_for(&action_counts, &action_id).unwrap_or(0.0))
        })
        .collect();
    if !explicit.is_empty() {
        let mut profiles = Vec::new();
        for action in available {
            if let Some(profile) = attack_profile_for(state, &enemy_id, get(Some(action), "id"))? {
                if js::truthy(Some(&profile)) {
                    profiles.push(profile);
                }
            }
        }
        return Ok(profiles);
    }
    let fallback = attack_profile_for(state, &enemy_id, None)?;
    Ok(match fallback {
        Some(profile) if npc_action_unavailable_reason(Some(enemy), Some(&single(&js::s(profile.get("id"))))).is_none() => vec![profile],
        _ => Vec::new(),
    })
}

/// `inAttackRange(state, attackerId, targetId, profile, from)`.
fn in_attack_range(state: &Value, attacker_id: &str, target_id: &str, profile: &Value, from: Option<Point>) -> bool {
    let target = actor_point(state, target_id);
    let (Some(from), Some(target)) = (from, target) else { return false };
    let range = number(profile.get("range_feet"));
    let distance = distance_between(state, attacker_id, target_id, Some(from), Some(target));
    distance >= CELL_FEET && distance <= range && (range <= CELL_FEET || clear_between(state, attacker_id, target_id, Some(from), Some(target)))
}

/// `averageDamage(expression, flat)`.
fn average_damage(expression: Option<&Value>, flat: Option<&Value>) -> f64 {
    let source = js::s(expression);
    if let Some(captures) = re!(r"^(\d+)d(\d+)([+-]\d+)?$", "u").captures(&source).ok().flatten() {
        let part = |index: usize| captures.get(index).map(|found| js::parse_number(found.as_str()));
        let count = part(1).unwrap_or(f64::NAN);
        let sides = part(2).unwrap_or(f64::NAN);
        let bonus = part(3).unwrap_or(0.0);
        return count * (sides + 1.0) / 2.0 + bonus;
    }
    max2(0.0, number_or(flat, 0.0))
}

/// `prefersRangedCombat(enemy)`.
fn prefers_ranged_combat(enemy: &Value) -> bool {
    let expected = |profile: &Value| {
        let hit_chance = min2(0.95, max2(0.05, (6.0 + number_or(profile.get("attack_modifier"), 0.0)) / 20.0));
        average_damage(profile.get("damage_expression"), profile.get("damage_amount")) * hit_chance
    };
    let profiles = list(enemy.get("action_profiles"));
    let best = |kind: &str| profiles.iter().filter(|profile| type_is(get(Some(profile), "kind"), kind)).fold(-1.0, |top, profile| max2(top, expected(profile)));
    let melee = best("melee");
    melee < 0.0 || best("ranged") >= melee
}

fn keeps_distance(enemy: &Value) -> bool {
    has_trait(enemy, KEEP_DISTANCE) && prefers_ranged_combat(enemy)
}

fn adjacent_enemy_ally(state: &Value, enemy: &Value, target: &Value) -> bool {
    let target_id = id_of(target);
    let enemy_id = id_of(enemy);
    living_enemies(state).iter().any(|ally| id_of(ally) != enemy_id && distance_default(state, &id_of(ally), &target_id) == CELL_FEET)
}

fn adjacent_party_member(state: &Value, enemy: &Value) -> bool {
    let enemy_id = id_of(enemy);
    living_party(state).iter().any(|member| distance_default(state, &id_of(member), &enemy_id) == CELL_FEET)
}

/// `meleeThreatWithinReach(state, enemy)`.
fn melee_threat_within_reach(state: &Value, enemy: &Value) -> bool {
    let enemy_id = id_of(enemy);
    living_party(state).iter().any(|member| {
        let id = id_of(member);
        let feet = distance_default(state, &id, &enemy_id);
        let speed = effective_speed_feet(state, member, &id) as f64;
        feet <= speed + CELL_FEET
    })
}

/// `targetCoverLevel(state, attackerId, targetId, from, to)`.
fn target_cover_level(state: &Value, attacker_id: &str, target_id: &str, from: Option<Point>, to: Option<Point>) -> String {
    if from.is_none() || to.is_none() {
        return "none".into();
    }
    let cover = cover_between(state, attacker_id, target_id, from, to);
    js::string(nullish(cover.get("level"), Some(&single("none"))))
}

fn ranged_profile_for(state: &Value, actor: &Value) -> Result<Option<Value>, Halt> {
    let profile = attack_profile_for(state, &id_of(actor), None)?;
    Ok(profile.filter(|profile| type_is(profile.get("kind"), "ranged")))
}

/// `rangedThreats(state, enemy)`: ближайшие стрелки отряда.
fn ranged_threats<'a>(state: &'a Value, enemy: &Value) -> Result<Vec<&'a Value>, Halt> {
    let enemy_id = id_of(enemy);
    let Some(from) = actor_point(state, &enemy_id) else { return Ok(Vec::new()) };
    let mut entries: Vec<(&Value, Option<Point>)> = Vec::new();
    for hero in living_party(state) {
        if ranged_profile_for(state, hero)?.is_some() && actor_point(state, &id_of(hero)).is_some() {
            entries.push((hero, actor_point(state, &id_of(hero))));
        }
    }
    let order = sorted_indices(entries.len(), |left, right| {
        let (left_hero, left_at) = entries[left];
        let (right_hero, right_at) = entries[right];
        let difference = distance_between(state, &id_of(left_hero), &enemy_id, left_at, Some(from)) - distance_between(state, &id_of(right_hero), &enemy_id, right_at, Some(from));
        or_else(difference, || compare_text(&id_of(left_hero), &id_of(right_hero)))
    });
    Ok(order.into_iter().take(MAX_COVER_THREATS).map(|index| entries[index].0).collect())
}

/// `ownCoverScore(state, enemy, position, threats)`.
fn own_cover_score(state: &Value, enemy: &Value, position: Option<Point>, threats: &[&Value]) -> f64 {
    if position.is_none() || threats.is_empty() {
        return 0.0;
    }
    let enemy_id = id_of(enemy);
    let mut total = 0.0;
    for threat in threats {
        let threat_id = id_of(threat);
        let threat_at = actor_point(state, &threat_id);
        let level = target_cover_level(state, &threat_id, &enemy_id, threat_at, position);
        total += if level == "none" && !clear_between(state, &threat_id, &enemy_id, threat_at, position) { own_cover_bonus("three-quarters") } else { own_cover_bonus(&level) };
    }
    js::round(total / threats.len() as f64)
}

/// `highGroundBonus(state, from, to, attackerId, targetId)`.
fn high_ground_bonus(state: &Value, from: Option<Point>, to: Option<Point>, attacker_id: &str, target_id: &str) -> f64 {
    let (Some(from), Some(to)) = (from, to) else { return 0.0 };
    let distance = if !attacker_id.is_empty() && !target_id.is_empty() {
        distance_between(state, attacker_id, target_id, Some(from), Some(to))
    } else {
        max2((from.x - to.x).abs(), (from.y - to.y).abs()) * CELL_FEET
    };
    if high_ground_between(state, Some(from), Some(to), Some(distance)) == "higher" {
        HIGH_GROUND_BONUS
    } else {
        0.0
    }
}

/// `stopBlockedFor(state, actorId)`: где ходу нельзя закончиться.
struct StopBlocked<'a> {
    occupied: KeySet,
    actor: Option<&'a Value>,
}

impl<'a> StopBlocked<'a> {
    fn new(state: &'a Value, actor_id: &str) -> Self {
        Self { occupied: occupied_positions(state, Some(actor_id), true), actor: game::find_actor(state, actor_id) }
    }

    fn blocked(&self, position: Point) -> bool {
        footprint_cells(self.actor, Some(position)).iter().any(|cell| self.occupied.contains(&key_of(*cell)))
    }
}

fn cell_point(cell: &Value) -> Point {
    Point::new(number(cell.get("x")), number(cell.get("y")))
}

fn walkable_type(cell: Option<&Value>) -> bool {
    matches!(get(cell, "type").and_then(Value::as_str), Some("floor" | "door"))
}

fn scene_cells(state: &Value) -> &[Value] {
    list(path(Some(state), &["scene", "cells"]))
}

fn chebyshev(left: Point, right: Point) -> f64 {
    max2((left.x - right.x).abs(), (left.y - right.y).abs())
}

/// `candidatePositions(state, enemy, budgetFeet, anchor, prefer)`.
fn candidate_positions(state: &Value, enemy: &Value, budget_feet: f64, anchor: Option<Point>, far: bool) -> Vec<Point> {
    let enemy_id = id_of(enemy);
    let from = actor_point(state, &enemy_id);
    let maximum_steps = max2(0.0, (budget_feet / CELL_FEET).floor());
    let Some(from) = from.filter(|_| truthy_number(maximum_steps)) else { return Vec::new() };
    let mut occupied: KeySet = KeySet::new();
    for actor in living_party(state).into_iter().chain(living_enemies(state)) {
        let id = id_of(actor);
        for cell in footprint_cells(Some(actor), actor_point(state, &id)) {
            occupied.insert(key_of(cell));
        }
    }
    let stop = StopBlocked::new(state, &enemy_id);
    let cells = scene_cells(state);
    let mut by_key: std::collections::HashMap<(u64, u64), &Value> = std::collections::HashMap::new();
    for cell in cells {
        by_key.insert(key(number(cell.get("x")), number(cell.get("y"))), cell);
    }
    let reachable: Vec<Point> = cells
        .iter()
        .filter(|cell| js::truthy(cell.get("revealed")) && walkable_type(Some(cell)))
        .map(cell_point)
        .filter(|cell| chebyshev(*cell, from) <= maximum_steps)
        .filter(|cell| {
            !stop.blocked(*cell)
                && footprint_cells(Some(enemy), Some(*cell)).iter().all(|point| {
                    let found = by_key.get(&key_of(*point)).copied();
                    js::truthy(get(found, "revealed")) && walkable_type(found) && !occupied.contains(&key_of(*point))
                })
        })
        .collect();
    let reference = anchor.unwrap_or(from);
    let direction = if far { -1.0 } else { 1.0 };
    let order = sorted_indices(reachable.len(), |left, right| {
        let (l, r) = (reachable[left], reachable[right]);
        or_else(direction * (chebyshev(l, reference) - chebyshev(r, reference)), || or_else(l.x - r.x, || l.y - r.y))
    });
    order.into_iter().take(MAX_EVALUATED_POSITIONS).map(|index| reachable[index]).collect()
}

/// Маршрут, который существо оплатит.
struct Route {
    path: Vec<Point>,
    cost_feet: f64,
}

/// `shortestTacticalPath(state, actorId, destination)` без параметров.
fn plain_path(state: &Value, actor_id: &str, destination: Option<Point>) -> Option<Vec<Point>> {
    shortest_tactical_path(state, actor_id, destination.unwrap_or(Point::new(f64::NAN, f64::NAN)), PathOptions::default())
}

fn path_cost(state: &Value, actor_id: &str, path: &[Point]) -> f64 {
    let cost = movement_step_cost_for(state, actor_id, None);
    path.iter().map(|step| cost.step_cost(*step)).sum()
}

/// `affordableRouteTo(state, enemy, cell, budgetFeet)`.
fn affordable_route_to(state: &Value, enemy: &Value, cell: Point, budget_feet: f64) -> Option<Route> {
    let enemy_id = id_of(enemy);
    let path = plain_path(state, &enemy_id, Some(cell)).filter(|path| !path.is_empty())?;
    let cost_feet = path_cost(state, &enemy_id, &path);
    if cost_feet > budget_feet {
        return None;
    }
    Some(Route { path, cost_feet })
}

fn remaining_movement_feet(state: &Value, enemy_id: &str) -> f64 {
    number(movement_for_actor(state, enemy_id).get("movement_remaining"))
}

/// Позиция, найденная `firstAffordable`.
struct Placement {
    destination: Point,
    cost_feet: f64,
}

/// `rankedPositions(state, enemy, budgetFeet, anchor, positionScore, currentScore, prefer)`.
fn ranked_positions(state: &Value, enemy: &Value, budget_feet: f64, anchor: Option<Point>, mut position_score: impl FnMut(Point) -> Option<f64>, current: Option<f64>, far: bool) -> Vec<(f64, Point)> {
    let mut scored: Vec<(f64, Point)> = Vec::new();
    for cell in candidate_positions(state, enemy, budget_feet, anchor, far) {
        let Some(score) = position_score(cell) else { continue };
        if current.is_some_and(|current| score <= current) {
            continue;
        }
        scored.push((score, cell));
    }
    let order = sorted_indices(scored.len(), |left, right| {
        let (l, r) = (scored[left], scored[right]);
        or_else(r.0 - l.0, || or_else(l.1.x - r.1.x, || l.1.y - r.1.y))
    });
    order.into_iter().take(MAX_ROUTED_POSITIONS).map(|index| scored[index]).collect()
}

/// `firstAffordable(state, enemy, ranked, budgetFeet)`.
fn first_affordable(state: &Value, enemy: &Value, ranked: &[(f64, Point)], budget_feet: f64) -> Option<Placement> {
    ranked.iter().find_map(|(_, cell)| {
        affordable_route_to(state, enemy, *cell, budget_feet).and_then(|route| route.path.last().map(|destination| Placement { destination: *destination, cost_feet: route.cost_feet }))
    })
}

/// `withinReachOfAdjacentHostiles(state, enemy)`: соседи-противники стрелка.
fn adjacent_hostiles(state: &Value, enemy: &Value) -> Vec<(String, Option<Point>)> {
    let enemy_id = id_of(enemy);
    let Some(from) = actor_point(state, &enemy_id) else { return Vec::new() };
    attackable_targets_for(state, enemy)
        .into_iter()
        .map(|hostile| (id_of(hostile), actor_point(state, &id_of(hostile))))
        .filter(|(id, at)| at.is_some() && distance_between(state, &enemy_id, id, Some(from), *at) <= CELL_FEET)
        .collect()
}

/// `firingPositionFor(state, enemy, target, profile)`.
fn firing_position_for(state: &Value, enemy: &Value, target: &Value, profile: &Value) -> Result<Option<Placement>, Halt> {
    if !type_is(profile.get("kind"), "ranged") {
        return Ok(None);
    }
    let enemy_id = id_of(enemy);
    let target_id = id_of(target);
    let from = actor_point(state, &enemy_id);
    let target_at = actor_point(state, &target_id);
    let (Some(from), Some(target_at)) = (from, target_at) else { return Ok(None) };
    let budget_feet = remaining_movement_feet(state, &enemy_id);
    let threats = ranged_threats(state, enemy)?;
    let adjacent = adjacent_hostiles(state, enemy);
    let range = number(profile.get("range_feet"));
    let position_score = |position: Point| -> Option<f64> {
        let distance = distance_between(state, &enemy_id, &target_id, Some(position), Some(target_at));
        if distance < CELL_FEET || distance > range {
            return None;
        }
        if !adjacent.iter().all(|(id, at)| distance_between(state, &enemy_id, id, Some(position), *at) <= CELL_FEET) {
            return None;
        }
        if !clear_between(state, &enemy_id, &target_id, Some(position), Some(target_at)) {
            return None;
        }
        let cover = target_cover_level(state, &enemy_id, &target_id, Some(position), Some(target_at));
        Some(
            (if cover == "none" { CLEAR_SHOT_BONUS } else { 0.0 }) - cover_target_penalty(&cover) + own_cover_score(state, enemy, Some(position), &threats) + high_ground_bonus(state, Some(position), Some(target_at), &enemy_id, &target_id)
                - (if distance <= CELL_FEET { 70.0 } else { 0.0 }),
        )
    };
    let current = position_score(from);
    let ceiling = CLEAR_SHOT_BONUS + (if threats.is_empty() { 0.0 } else { own_cover_bonus("three-quarters") }) + HIGH_GROUND_BONUS;
    if current.is_some_and(|current| current >= ceiling) {
        return Ok(None);
    }
    let ranked = ranked_positions(state, enemy, budget_feet, Some(from), position_score, current, false);
    Ok(first_affordable(state, enemy, &ranked, budget_feet))
}

/// `shouldRetreatBloodied(state, enemy)`.
fn should_retreat_bloodied(state: &Value, enemy: &Value) -> Result<bool, Halt> {
    let hp = max2(0.0, number_or(enemy.get("hp"), 0.0));
    let max_hp = max2(1.0, or_number(or_number(number(nullish(enemy.get("maxHp"), enemy.get("max_hp"))), hp), 1.0));
    if hp <= 0.0 || hp / max_hp >= BLOODIED_RATIO {
        return Ok(false);
    }
    if [BLOODIED_FRENZY, RELENTLESS_PURSUIT].iter().any(|name| has_trait(enemy, name)) {
        return Ok(false);
    }
    let conditions = condition_ids(state, &id_of(enemy));
    if conditions.contains("morale-tested") || conditions.contains("fled") || conditions.contains("surrendered") {
        return Ok(false);
    }
    Ok(adjacent_party_member(state, enemy) || melee_threat_within_reach(state, enemy) || under_ranged_fire(state, enemy)?)
}

/// `underRangedFire(state, enemy)`.
fn under_ranged_fire(state: &Value, enemy: &Value) -> Result<bool, Halt> {
    let enemy_id = id_of(enemy);
    let Some(at) = actor_point(state, &enemy_id) else { return Ok(false) };
    for hero in ranged_threats(state, enemy)? {
        let hero_id = id_of(hero);
        let hero_at = actor_point(state, &hero_id);
        let profile = ranged_profile_for(state, hero)?;
        let distance = distance_between(state, &hero_id, &enemy_id, hero_at, Some(at));
        let range = match get(profile.as_ref(), "range_feet") {
            Some(value) if !value.is_null() => number(Some(value)),
            _ => 0.0,
        };
        if distance <= range && clear_between(state, &hero_id, &enemy_id, hero_at, Some(at)) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `bloodiedRetreatFor(state, enemy)`.
fn bloodied_retreat_for(state: &Value, enemy: &Value) -> Result<Option<Point>, Halt> {
    let enemy_id = id_of(enemy);
    let Some(from) = actor_point(state, &enemy_id) else { return Ok(None) };
    let budget_feet = remaining_movement_feet(state, &enemy_id);
    let mut heroes: Vec<(String, Point, Option<Value>)> = Vec::new();
    for hero in living_party(state) {
        let id = id_of(hero);
        let at = actor_point(state, &id);
        let profile = attack_profile_for(state, &id, None)?;
        if let Some(at) = at {
            heroes.push((id, at, profile));
        }
    }
    let allies: Vec<(String, Point)> = living_enemies(state).into_iter().filter(|ally| id_of(ally) != enemy_id).filter_map(|ally| actor_point(state, &id_of(ally)).map(|at| (id_of(ally), at))).collect();
    let position_score = |position: Point| -> Option<f64> {
        let mut score = 0.0;
        for (hero_id, hero_at, profile) in &heroes {
            let reach_raw = if profile_kind(profile.as_ref()) == Some("melee") { number(get(profile.as_ref(), "range_feet")) } else { CELL_FEET };
            let reach_feet = max2(CELL_FEET, or_number(reach_raw, CELL_FEET));
            let distance = distance_between(state, &enemy_id, hero_id, Some(position), Some(*hero_at));
            if distance > reach_feet {
                score += 60.0;
            }
            score += min2(120.0, distance * 2.0);
            let level = target_cover_level(state, hero_id, &enemy_id, Some(*hero_at), Some(position));
            score += if level == "none" && !clear_between(state, hero_id, &enemy_id, Some(*hero_at), Some(position)) { own_cover_bonus("three-quarters") } else { own_cover_bonus(&level) };
        }
        let nearest = allies.iter().fold(MAX_SAFE_INTEGER, |best, (ally_id, ally_at)| min2(best, distance_between(state, &enemy_id, ally_id, Some(position), Some(*ally_at)) / CELL_FEET));
        if !allies.is_empty() {
            score += max2(0.0, 60.0 - nearest * 12.0);
        }
        Some(score)
    };
    let order = sorted_indices(heroes.len(), |left, right| {
        let (l, r) = (&heroes[left], &heroes[right]);
        or_else(distance_between(state, &enemy_id, &l.0, Some(from), Some(l.1)) - distance_between(state, &enemy_id, &r.0, Some(from), Some(r.1)), || compare_text(&l.0, &r.0))
    });
    let anchor = order.first().map(|index| heroes[*index].1).unwrap_or(from);
    let current = position_score(from);
    let ranked = ranked_positions(state, enemy, budget_feet, Some(anchor), position_score, current, true);
    Ok(first_affordable(state, enemy, &ranked, budget_feet).map(|placement| placement.destination))
}

/// `reachableMeleeScore(enemy)`.
fn reachable_melee_score(enemy: &Value) -> f64 {
    if prefers_ranged_combat(enemy) {
        980.0
    } else {
        1_010.0
    }
}

/// `hitChanceFor(profile, targetArmor, disadvantage)`.
fn hit_chance_for(profile: &Value, target_armor: f64, disadvantage: bool) -> f64 {
    let modifier = number(nullish(profile.get("modifier"), profile.get("attack_modifier")));
    let kind = js::string(profile.get("kind"));
    if !(kind == "melee" || kind == "ranged") || !modifier.is_finite() {
        return 0.6;
    }
    let chance = min2(0.95, max2(0.05, (21.0 + modifier - target_armor) / 20.0));
    if disadvantage {
        chance * chance
    } else {
        chance
    }
}

/// `profile?.range_feet ?? CELL_FEET` числом.
fn range_or_cell(profile: Option<&Value>) -> f64 {
    match get(profile, "range_feet") {
        Some(value) if !value.is_null() => number(Some(value)),
        _ => CELL_FEET,
    }
}

/// `meleeReachableThisTurn(state, enemy, path, profile)`.
fn melee_reachable_this_turn(state: &Value, enemy: &Value, path: Option<&[Point]>, profile: &Value) -> bool {
    let Some(path) = path.filter(|path| !path.is_empty()) else { return false };
    let enemy_id = id_of(enemy);
    if js::is_false(get(economy_of(state, &enemy_id), "action")) {
        return false;
    }
    let range_cells = max2(1.0, (range_or_cell(Some(profile)) / CELL_FEET).floor());
    let approach = max2(0.0, path.len() as f64 - range_cells);
    if !truthy_number(approach) {
        return false;
    }
    (affordable_path_prefix(state, &enemy_id, path, approach, remaining_movement_feet(state, &enemy_id)).0 as f64) >= approach
}

/// `footprintStrikePath(state, enemy, target, profiles)`: путь крупного тела к удару.
fn footprint_strike_path(state: &Value, enemy: &Value, target: &Value, profiles: &[Value]) -> Option<Vec<Point>> {
    let enemy_id = id_of(enemy);
    let target_id = id_of(target);
    let side = footprint_size_for(Some(enemy));
    let target_at = actor_point(state, &target_id);
    let target_at = target_at.filter(|_| side > 1)?;
    let reaches = profiles.iter().filter(|profile| type_is(profile.get("kind"), "melee")).map(|profile| or_number(number(profile.get("range_feet")), CELL_FEET));
    let reach_feet = js::max_of(std::iter::once(CELL_FEET).chain(reaches));
    let range_cells = max2(1.0, (reach_feet / CELL_FEET).floor());
    let cost = movement_step_cost_for(state, &enemy_id, None);
    let map = cost.map();
    let step_cost = |point: Point, path_map: Option<&_>| cost.step_cost_on(point, path_map);
    let step: StepCost<'_> = &step_cost;
    let mut best: Option<(Vec<Point>, f64)> = None;
    let side = side as f64;
    let mut x = target_at.x - range_cells - side + 1.0;
    while x <= target_at.x + range_cells {
        let mut y = target_at.y - range_cells - side + 1.0;
        while y <= target_at.y + range_cells {
            let anchor = Point::new(x, y);
            y += 1.0;
            let distance = distance_between(state, &enemy_id, &target_id, Some(anchor), Some(target_at));
            if distance < CELL_FEET || distance > reach_feet {
                continue;
            }
            let Some(path) = shortest_tactical_path(state, &enemy_id, anchor, PathOptions { tactical_map: Some(map), step_cost: Some(step), ..PathOptions::default() }).filter(|path| !path.is_empty()) else {
                continue;
            };
            let total: f64 = path.iter().map(|point| step(*point, map)).sum();
            let better = match &best {
                None => true,
                Some((best_path, best_cost)) => total < *best_cost || (total == *best_cost && path.len() < best_path.len()),
            };
            if better {
                best = Some((path, total));
            }
        }
        x += 1.0;
    }
    best.map(|(mut path, _)| {
        path.extend(std::iter::repeat_n(target_at, js_length(range_cells)));
        path
    })
}

/// Кандидат `targetCandidates`: цель, профиль удара и оценка.
#[derive(Debug, Clone)]
pub struct Candidate<'a> {
    pub actor: &'a Value,
    pub path: Option<Vec<Point>>,
    pub in_range: bool,
    pub blocked_shot: bool,
    pub cover_level: String,
    pub distance: f64,
    pub profile: Value,
    pub score: f64,
}

impl Candidate<'_> {
    /// Кандидат в JSON для сверки с эталоном JS.
    pub fn to_json(&self) -> Value {
        json!({
            "actor_id": id_of(self.actor),
            "path": self.path.as_ref().map(|path| Value::Array(path.iter().copied().map(point_json).collect())),
            "inRange": self.in_range,
            "blockedShot": self.blocked_shot,
            "coverLevel": self.cover_level,
            "distance": js::num(self.distance),
            "profile_id": self.profile.get("id").cloned(),
            "score": js::num(self.score),
        })
    }
}

/// `targetCandidates(state, enemy)`: все пары «цель × профиль» по убыванию оценки.
pub fn target_candidates<'a>(state: &'a Value, enemy: &Value) -> Result<Vec<Candidate<'a>>, Halt> {
    let enemy_id = id_of(enemy);
    let enemy_at = actor_point(state, &enemy_id);
    let profiles = action_profiles(state, enemy)?;
    let hostile_to_all = js::is_true(enemy.get("hostile_to_all"));
    let stop = OnceCell::new();
    let large = footprint_size_for(Some(enemy)) > 1;
    let relentless = has_trait(enemy, RELENTLESS_PURSUIT);
    let pack_trait = has_trait(enemy, "pack-tactics") || has_trait(enemy, "martial-advantage");
    let mut candidates: Vec<Candidate<'a>> = Vec::new();
    for target in attackable_targets_for(state, enemy) {
        let target_id = id_of(target);
        let target_at = actor_point(state, &target_id);
        let mut route = shortest_tactical_path(state, &enemy_id, target_at.unwrap_or(Point::new(f64::NAN, f64::NAN)), PathOptions { allow_occupied_destination: true, ..PathOptions::default() });
        if let Some(found) = &route {
            if large && found.len() > 1 {
                let stop = stop.get_or_init(|| StopBlocked::new(state, &enemy_id));
                if found[..found.len() - 1].iter().all(|step| stop.blocked(*step)) {
                    if let Some(strike) = footprint_strike_path(state, enemy, target, &profiles) {
                        route = Some(strike);
                    }
                }
            }
        }
        if route.is_none() {
            route = footprint_strike_path(state, enemy, target, &profiles);
        }
        let path_distance = match &route {
            Some(found) => found.len() as f64,
            None => grid_distance(state, &enemy_id, &target_id),
        };
        let support = adjacent_enemy_ally(state, enemy, target);
        let target_conditions = conditions_of(state, &target_id);
        for profile in &profiles {
            if !monster_attack_target_allowed(Some(profile), target_conditions, Some(&enemy_id)) {
                continue;
            }
            let kind = profile_kind(Some(profile));
            let range = number(profile.get("range_feet"));
            let in_range = in_attack_range(state, &enemy_id, &target_id, profile, enemy_at);
            let damage = average_damage(profile.get("damage_expression"), profile.get("damage_amount"));
            let target_hp = max2(1.0, number_or(target.get("hp"), 1.0));
            let target_armor = max2(0.0, number_or(target.get("armor"), 10.0));
            let on_hit_condition = path(Some(profile), &["on_hit", "condition"]);
            let control_value = if js::truthy(on_hit_condition) && !condition_ids(state, &target_id).contains(&js::string(on_hit_condition)) {
                let priority = profile.get("tactical_priority");
                80.0 + (if js::truthy(priority) { number(priority) } else { 0.0 }) * 10.0
            } else {
                0.0
            };
            let pack_value = if support && pack_trait { 90.0 } else { 0.0 };
            let recharge_value = if number(profile.get("recharge")) > 0.0 { RECHARGE_READY_BONUS } else { 0.0 };
            let distance = match (enemy_at, target_at) {
                (Some(from), Some(to)) => distance_between(state, &enemy_id, &target_id, Some(from), Some(to)),
                _ => f64::INFINITY,
            };
            let ranged = kind == Some("ranged");
            let ranged_at_melee_penalty = if ranged && distance == CELL_FEET { 70.0 } else { 0.0 };
            let cover_level = if ranged { target_cover_level(state, &enemy_id, &target_id, enemy_at, target_at) } else { "none".to_string() };
            let cover_penalty = cover_target_penalty(&cover_level);
            let high_ground = if ranged { high_ground_bonus(state, enemy_at, target_at, &enemy_id, &target_id) } else { 0.0 };
            let blocked_shot = ranged && distance >= CELL_FEET && distance <= range && !clear_between(state, &enemy_id, &target_id, enemy_at, target_at);
            let finishing_blow = damage >= target_hp && ranged_at_melee_penalty == 0.0;
            let expected_damage = damage * hit_chance_for(profile, target_armor, ranged_at_melee_penalty != 0.0);
            let reachable_melee = !in_range && kind == Some("melee") && melee_reachable_this_turn(state, enemy, route.as_deref(), profile);
            let open = f64::from(u8::from(in_range && !blocked_shot)) * 1_000.0;
            let has_path = f64::from(u8::from(route.is_some())) * 400.0;
            let score = if hostile_to_all {
                open + has_path - path_distance * 50.0
            } else {
                let wounded = if relentless {
                    max2(0.0, 800.0 - path_distance * 80.0)
                } else if finishing_blow {
                    260.0
                } else {
                    js::round((1.0 - target_hp / max2(target_hp, number_or(target.get("maxHp"), target_hp))) * 100.0)
                };
                let armor_and_tactics = if relentless { 0.0 } else { max2(0.0, 22.0 - target_armor) * 4.0 + control_value + pack_value };
                open + (if reachable_melee { reachable_melee_score(enemy) } else { 0.0 }) + has_path + min2(300.0, expected_damage * 24.0) + wounded + armor_and_tactics + recharge_value - path_distance * 3.0 - ranged_at_melee_penalty - cover_penalty
                    + high_ground
            };
            candidates.push(Candidate { actor: target, path: route.clone(), in_range: in_range && !blocked_shot, blocked_shot, cover_level, distance: path_distance, profile: profile.clone(), score });
        }
    }
    let order = sorted_indices(candidates.len(), |left, right| {
        let (l, r) = (&candidates[left], &candidates[right]);
        or_else(r.score - l.score, || {
            or_else(f64::from(u8::from(r.in_range)) - f64::from(u8::from(l.in_range)), || {
                or_else(l.distance - r.distance, || or_else(compare_text(&id_of(l.actor), &id_of(r.actor)), || compare_text(&js::s(l.profile.get("id")), &js::s(r.profile.get("id")))))
            })
        })
    });
    let mut slots: Vec<Option<Candidate<'a>>> = candidates.into_iter().map(Some).collect();
    Ok(order.into_iter().filter_map(|index| slots[index].take()).collect())
}

/// `affordablePathPrefix(state, actorId, path, maximumSteps, budgetFeet)`:
/// `(steps, costFeet)`.
fn affordable_path_prefix(state: &Value, actor_id: &str, path: &[Point], maximum_steps: f64, budget_feet: f64) -> (usize, f64) {
    let cost = movement_step_cost_for(state, actor_id, None);
    let stop = StopBlocked::new(state, actor_id);
    let limit = min2(max2(0.0, maximum_steps), path.len() as f64);
    let mut steps = 0;
    let mut cost_feet = 0.0;
    let mut walked = 0.0;
    let mut index = 0usize;
    while (index as f64) < limit {
        let next = walked + cost.step_cost(path[index]);
        if next > budget_feet {
            break;
        }
        walked = next;
        if !stop.blocked(path[index]) {
            cost_feet = walked;
            steps = index + 1;
        }
        index += 1;
    }
    (steps, cost_feet)
}

/// `fleeDestination(state, enemy, sourceId)`: дальше всего от изгнавшего.
fn flee_destination(state: &Value, enemy: &Value, source_id: &str) -> Option<Point> {
    let enemy_id = id_of(enemy);
    let from = actor_point(state, &enemy_id)?;
    let source_at = actor_point(state, source_id)?;
    let budget_feet = remaining_movement_feet(state, &enemy_id);
    let maximum_steps = max2(0.0, (budget_feet / CELL_FEET).floor());
    if !truthy_number(maximum_steps) {
        return None;
    }
    let cost = movement_step_cost_for(state, &enemy_id, None);
    let stop = StopBlocked::new(state, &enemy_id);
    let here = distance_between(state, &enemy_id, source_id, Some(from), Some(source_at));
    let mut best: Option<(f64, Point)> = None;
    for cell in scene_cells(state) {
        if !js::truthy(cell.get("revealed")) || !walkable_type(Some(cell)) {
            continue;
        }
        let destination = cell_point(cell);
        if stop.blocked(destination) {
            continue;
        }
        let distance = distance_between(state, &enemy_id, source_id, Some(destination), Some(source_at));
        if distance <= here || best.is_some_and(|(best_distance, _)| distance < best_distance) {
            continue;
        }
        let Some(path) = plain_path(state, &enemy_id, Some(destination)) else { continue };
        if path.is_empty() || path.len() as f64 > maximum_steps {
            continue;
        }
        if path.iter().map(|step| cost.step_cost(*step)).sum::<f64>() > budget_feet {
            continue;
        }
        let Some(end) = path.last().copied() else { continue };
        let better = match best {
            None => true,
            Some((best_distance, best_destination)) => distance > best_distance || (distance == best_distance && (destination.x < best_destination.x || (destination.x == best_destination.x && destination.y < best_destination.y))),
        };
        if better {
            best = Some((distance, end));
        }
    }
    best.map(|(_, destination)| destination)
}

fn turned_undead_plan(state: &NormalizedState, enemy: &Value, source_id: &str) -> Result<Vec<Value>, Halt> {
    let id = id_of(enemy);
    let mut commands = Vec::new();
    let destination = flee_destination(state, enemy, source_id);
    if let Some(destination) = destination {
        commands.push(json!({ "command_type": "MoveActor", "actor_id": id, "to": point_json(destination) }));
    }
    let dodge = json!({ "command_type": "UseCombatAction", "actor_id": id, "action_id": "dodge" });
    if destination.is_none() && npc_command_valid(state, &dodge)? {
        commands.push(dodge);
    }
    commands.push(end_turn(&id));
    Ok(commands)
}

/// `retreatDestination(state, enemy, target, profile)`: клетка отхода с линией огня.
fn retreat_destination(state: &Value, enemy: &Value, target: &Value, range_feet: f64, normal_range_feet: f64) -> Option<Point> {
    let enemy_id = id_of(enemy);
    let target_id = id_of(target);
    actor_point(state, &enemy_id)?;
    let target_at = actor_point(state, &target_id)?;
    let budget_feet = remaining_movement_feet(state, &enemy_id);
    let maximum_steps = max2(0.0, (budget_feet / CELL_FEET).floor());
    if !truthy_number(maximum_steps) {
        return None;
    }
    let cost = movement_step_cost_for(state, &enemy_id, None);
    let stop = StopBlocked::new(state, &enemy_id);
    let mut best: Option<(f64, Point)> = None;
    for cell in scene_cells(state) {
        if !js::truthy(cell.get("revealed")) || !walkable_type(Some(cell)) {
            continue;
        }
        let point = cell_point(cell);
        if stop.blocked(point) {
            continue;
        }
        let Some(path) = plain_path(state, &enemy_id, Some(point)) else { continue };
        if path.is_empty() || path.len() as f64 > maximum_steps {
            continue;
        }
        if path.iter().map(|step| cost.step_cost(*step)).sum::<f64>() > budget_feet {
            continue;
        }
        let Some(destination) = path.last().copied() else { continue };
        let distance = distance_between(state, &enemy_id, &target_id, Some(destination), Some(target_at));
        if distance > range_feet || distance < CELL_FEET || !clear_between(state, &enemy_id, &target_id, Some(destination), Some(target_at)) {
            continue;
        }
        let score = min2(distance, normal_range_feet) * 10.0 + path.len() as f64;
        let better = match best {
            None => true,
            Some((best_score, best_destination)) => score > best_score || (score == best_score && (destination.x < best_destination.x || (destination.x == best_destination.x && destination.y < best_destination.y))),
        };
        if better {
            best = Some((score, destination));
        }
    }
    best.map(|(_, destination)| destination)
}

/// `monsterMultiattackSequenceFor` с идентификатором JS: не-строка ни с чем не
/// совпадает (`===`).
fn sequence_key(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        _ => "\u{0}не-строка".into(),
    }
}

/// `multiattackActionIds(enemy, selectedProfile, usedActionIds)`.
fn multiattack_action_ids(enemy: &Value, selected: Option<&Value>, used: Option<&Value>) -> Vec<String> {
    let Some(multiattack) = trait_for(enemy, MULTIATTACK) else {
        let id = get(selected, "id");
        return if js::truthy(id) { vec![js::string(id)] } else { Vec::new() };
    };
    let counts = multiattack_action_counts(Some(&multiattack));
    if !counts.is_empty() {
        return counts.iter().flat_map(|(id, count)| std::iter::repeat_n(id.clone(), js_length(*count))).collect();
    }
    let used_ids: Vec<String> = list(used).iter().map(|id| sequence_key(Some(id))).collect();
    if let Some(chosen) = monster_multiattack_sequence_for(Some(enemy), &sequence_key(get(selected, "id")), &used_ids) {
        return chosen;
    }
    if let Some(Value::Array(_)) = multiattack.get("sequence") {
        let sequence: Vec<String> = string_list(multiattack.get("sequence")).into_iter().filter(|id| !id.is_empty()).collect();
        if !sequence.is_empty() {
            return sequence;
        }
    }
    let count = max2(1.0, min2(8.0, number_or(multiattack.get("attacks"), 1.0)));
    let action_id = js::s(nullish(multiattack.get("action_id"), get(selected, "id")));
    if action_id.is_empty() {
        Vec::new()
    } else {
        std::iter::repeat_n(action_id, js_length(count)).collect()
    }
}

/// `multiattackCount(enemy)`.
fn multiattack_count(enemy: &Value) -> f64 {
    let Some(multiattack) = trait_for(enemy, MULTIATTACK) else { return 1.0 };
    let total: f64 = multiattack_action_counts(Some(&multiattack)).iter().map(|(_, count)| *count).sum();
    if truthy_number(total) {
        return min2(8.0, total);
    }
    let sequence_length = match multiattack.get("sequence") {
        Some(Value::Array(_)) => string_list(multiattack.get("sequence")).into_iter().filter(|id| !id.is_empty()).count(),
        _ => 0,
    };
    let longest = js::max_of(std::iter::once(sequence_length as f64).chain(monster_multiattack_sequences(Some(enemy)).iter().map(|option| option.len() as f64)));
    or_number(longest, max2(1.0, min2(8.0, number_or(multiattack.get("attacks"), 1.0))))
}

/// `attackCommands(state, enemy, targetId, selectedProfile)`.
fn attack_commands(state: &Value, enemy: &Value, target_id: &str, selected: &Value) -> Vec<Value> {
    let enemy_id = id_of(enemy);
    let economy = economy_of(state, &enemy_id);
    let used = nullish(get(economy, "multiattack_action_ids"), None);
    let sequence = multiattack_action_ids(enemy, Some(selected), used);
    let counts = multiattack_action_counts(trait_for(enemy, MULTIATTACK).as_ref());
    let attacks_used = max2(0.0, number_or(get(economy, "attacks_used"), 0.0));
    let selected_id = nullish(selected.get("id"), None).cloned();
    let action_id: Option<Value> = if !counts.is_empty() {
        selected_id
    } else {
        match at_index_str(&sequence, attacks_used) {
            Some(id) => Some(Value::String(id)),
            None => selected_id,
        }
    };
    let attack_count = if sequence.is_empty() { multiattack_count(enemy) } else { sequence.len() as f64 };
    let mut command = Map::new();
    command.insert("command_type".into(), single("MakeAttack"));
    command.insert("actor_id".into(), Value::String(enemy_id));
    command.insert("target_id".into(), single(target_id));
    if let Some(action_id) = action_id.filter(|id| js::truthy(Some(id))) {
        command.insert("action_id".into(), Value::String(js::string(Some(&action_id))));
    }
    if attack_count > 1.0 {
        command.insert("monster_ability".into(), single("multiattack"));
        command.insert("multiattack_index".into(), js::num(attacks_used + 1.0));
        command.insert("multiattack_count".into(), js::num(attack_count));
    }
    vec![Value::Object(command)]
}

fn at_index_str(items: &[String], index: f64) -> Option<String> {
    (index >= 0.0 && index.fract() == 0.0 && index < items.len() as f64).then(|| items[index as usize].clone())
}

// --- снаряжение ----------------------------------------------------------------------

fn equipment_item_command(enemy: &Value, item: &Value, extra: Option<(&str, Value)>) -> Value {
    let id = id_of(enemy);
    let mut command = Map::new();
    command.insert("command_type".into(), single("UseItem"));
    command.insert("actor_id".into(), Value::String(id.clone()));
    command.insert("target_id".into(), Value::String(id));
    if let Some(value) = item.get("item_instance_id") {
        command.insert("item_id".into(), value.clone());
    }
    if let Some(value) = item.get("tactic") {
        command.insert("npc_tactic".into(), value.clone());
    }
    if let Some((key, value)) = extra {
        command.insert(key.into(), value);
    }
    Value::Object(command)
}

fn usable_with_tactic<'a>(usable: &'a [Value], tactic: &str) -> Option<&'a Value> {
    usable.iter().find(|item| type_is(item.get("tactic"), tactic))
}

/// `healingPotionCommandFor(state, enemy, usable, economy)`.
fn healing_potion_command_for(state: &Value, enemy: &Value, usable: &[Value], economy: Option<&Value>) -> Option<Value> {
    let potion = usable_with_tactic(usable, "heal")?;
    let resource = js::s(path(Some(potion), &["use", "combat_action"]));
    if !npc_needs_healing_potion(Some(enemy)) || (!resource.is_empty() && js::is_false(get(economy, &resource))) {
        return None;
    }
    if condition_ids(state, &id_of(enemy)).contains(&npc_tactic_condition(Some(&single("heal")))) {
        return None;
    }
    Some(equipment_item_command(enemy, potion, None))
}

/// `weaponPoisonCommandFor(state, enemy, usable, economy, profile)`.
fn weapon_poison_command_for(state: &Value, enemy: &Value, usable: &[Value], economy: Option<&Value>, profile: &Value) -> Option<Value> {
    if js::is_false(get(economy, "bonus_action")) || max2(0.0, number_or(get(economy, "attacks_used"), 0.0)) > 0.0 {
        return None;
    }
    let conditions = condition_ids(state, &id_of(enemy));
    if conditions.contains(&npc_tactic_condition(Some(&single("coat")))) {
        return None;
    }
    let poison = usable_with_tactic(usable, "coat")?;
    let binding = npc_weapon_binding_for(Some(enemy), profile.get("id"))?;
    if !type_is(binding.get("kind"), "melee") || number(binding.get("item_quantity")) <= 0.0 {
        return None;
    }
    if conditions.contains(&format!("weapon-coated:{}", js::string(binding.get("item_instance_id")))) {
        return None;
    }
    Some(equipment_item_command(enemy, poison, Some(("weapon_id", binding.get("item_instance_id").cloned().unwrap_or(Value::Null)))))
}

/// `thrownFlaskCommandFor(state, enemy, usable, economy, from)`.
fn thrown_flask_command_for(state: &Value, enemy: &Value, usable: &[Value], economy: Option<&Value>, from: Option<Point>) -> Option<Value> {
    if js::is_false(get(economy, "action")) || max2(0.0, number_or(get(economy, "attacks_used"), 0.0)) > 0.0 {
        return None;
    }
    let flask = usable_with_tactic(usable, "flask")?;
    let from = from?;
    let enemy_id = id_of(enemy);
    let range_feet = max2(CELL_FEET, number_or(path(Some(flask), &["use", "range_feet"]), 20.0));
    let heroes: Vec<(String, f64)> = living_party(state)
        .into_iter()
        .filter_map(|hero| actor_point(state, &id_of(hero)).map(|at| (id_of(hero), at)))
        .map(|(id, at)| {
            let feet = distance_between(state, &enemy_id, &id, Some(from), Some(at));
            (id, feet, at)
        })
        .filter(|(id, feet, at)| *feet >= CELL_FEET && *feet <= range_feet && clear_between(state, &enemy_id, id, Some(from), Some(*at)))
        .map(|(id, feet, _)| (id, feet))
        .collect();
    let order = sorted_indices(heroes.len(), |left, right| or_else(heroes[left].1 - heroes[right].1, || compare_text(&heroes[left].0, &heroes[right].0)));
    let target = order.first().map(|index| heroes[*index].0.clone())?;
    let mut command = equipment_item_command(enemy, flask, None);
    if let Some(map) = command.as_object_mut() {
        map.insert("target_id".into(), Value::String(target));
    }
    Some(command)
}

// --- магия стат-блока ----------------------------------------------------------------

/// `sharedSpellSlotAvailable(state, enemy, spell)`.
fn shared_spell_slot_available(state: &Value, enemy: &Value, spell: &Value) -> bool {
    if !js::truthy(spell.get("slotResource")) {
        return true;
    }
    let minimum = max2(1.0, number_or(spell.get("level"), 1.0));
    let Some(Value::Object(pools)) = path(Some(state), &["mechanics", "resources", &id_of(enemy)]) else { return false };
    js::entries(pools).into_iter().any(|(resource, pool)| {
        let Some(level) = resource.strip_prefix("spell_slots_").filter(|digits| !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())) else { return false };
        js::parse_number(level) >= minimum && max2(0.0, number_or(get(Some(pool), "current"), 0.0)) > 0.0
    })
}

/// `availableMonsterSpells(state, enemy)`.
fn available_monster_spells(state: &Value, enemy: &Value) -> Vec<Value> {
    let Some(block) = monster_spellcasting_for(Some(enemy)) else { return Vec::new() };
    let conditions = condition_ids(state, &id_of(enemy));
    block
        .spells
        .iter()
        .filter_map(|entry| monster_combat_spell_for(Some(enemy), Some(&Value::String(entry.id.clone())), None))
        .filter(|spell| {
            let per_day = path(Some(spell), &["monsterSpell", "perDay"]);
            MechanicsSupport::parse(&js::string(spell.get("mechanicsSupport"))).is_some_and(MechanicsSupport::is_executable)
                && type_is(spell.get("actionType"), "action")
                && shared_spell_slot_available(state, enemy, spell)
                && (!js::present(per_day) || (monster_spell_uses_spent_in(conditions.iter(), &js::s(spell.get("id"))) as f64) < number(per_day))
        })
        .collect()
}

fn spell_cast_command(enemy: &Value, spell: &Value, extra: (&str, Value)) -> Value {
    let mut command = Map::new();
    command.insert("command_type".into(), single("CastSpell"));
    command.insert("actor_id".into(), Value::String(id_of(enemy)));
    if let Some(id) = spell.get("id") {
        command.insert("spell_id".into(), id.clone());
    }
    command.insert(extra.0.into(), extra.1);
    Value::Object(command)
}

fn npc_context(actor_id: &str) -> Context {
    Context::from_json(&json!({ "serverAuthoritativeCombat": true, "isNpcScheduler": true, "allowedActorIds": [actor_id] }))
}

fn validation_uuid() -> impl FnMut() -> String {
    let mut counter = 0u64;
    move || {
        counter += 1;
        format!("npc-plan-{counter}")
    }
}

fn with_authority(command: &Value) -> Value {
    let mut input = command.as_object().cloned().unwrap_or_default();
    input.insert("server_authoritative".into(), Value::Bool(true));
    Value::Object(input)
}

/// `validateSpellPlan(spell, extra)`: команда с кругом ячейки движка или `None`.
fn validate_spell_plan(state: &NormalizedState, enemy: &Value, spell: &Value, extra: (&str, Value)) -> Result<Option<Value>, Halt> {
    let command = spell_cast_command(enemy, spell, extra);
    let mut uuid = validation_uuid();
    match sk_rules::validate::validate_normalized(&with_authority(&command), state, &npc_context(&id_of(enemy)), &mut uuid) {
        Ok(normalized) => {
            let mut result = command.as_object().cloned().unwrap_or_default();
            if js::present(normalized.get("slot_level")) {
                result.insert("slot_level".into(), normalized.get("slot_level").cloned().unwrap_or(Value::Null));
            }
            if js::truthy(normalized.get("spell_slot_resource")) {
                result.insert("spell_slot_resource".into(), normalized.get("spell_slot_resource").cloned().unwrap_or(Value::Null));
            }
            Ok(Some(Value::Object(result)))
        }
        Err(halt) if halt.is_rule() => Ok(None),
        Err(halt) => Err(halt),
    }
}

fn living_targets(state: &Value, command: &Value, spell: &Value) -> Vec<Value> {
    spell_targets_at(state, command, spell).into_iter().filter(game::is_living_actor).collect()
}

fn spell_level_value(command: &Value, spell: &Value) -> Value {
    js::num(number(nullish(command.get("slot_level"), spell.get("level"))))
}

/// `monsterSpellPlanFor(state, enemy, candidate, economy)`: лечение союзника,
/// контроль, область по двоим героям, урон по лучшей цели.
fn monster_spell_plan_for(state: &NormalizedState, enemy: &Value, candidate: Option<&Candidate<'_>>, economy: Option<&Value>) -> Result<Option<Value>, Halt> {
    if js::is_false(get(economy, "action")) {
        return Ok(None);
    }
    let spells = available_monster_spells(state, enemy);
    if spells.is_empty() {
        return Ok(None);
    }
    let id = id_of(enemy);
    let Some(from) = actor_point(state, &id) else { return Ok(None) };
    let in_range = |spell: &Value, at: Point, target_id: Option<&str>| {
        let (distance, clear) = match target_id {
            Some(target_id) => (distance_between(state, &id, target_id, Some(from), Some(at)), clear_between(state, &id, target_id, Some(from), Some(at))),
            None => (distance_to_point(state, &id, Some(from), at), clear_to_point(state, &id, Some(from), at)),
        };
        distance <= max2(CELL_FEET, number(spell.get("range"))) && (distance <= CELL_FEET || clear)
    };
    let active_concentration = js::truthy(path(Some(state), &["mechanics", "concentration", &id]));

    let wounded: Vec<(String, Point, f64, f64)> = living_enemies(state)
        .into_iter()
        .filter(|ally| id_of(ally) != id)
        .map(|ally| (id_of(ally), actor_point(state, &id_of(ally)), max2(0.0, number_or(ally.get("hp"), 0.0)), max2(1.0, number_or(ally.get("maxHp"), 1.0))))
        .filter_map(|(ally_id, at, hp, maximum)| at.map(|at| (ally_id, at, hp, maximum)))
        .filter(|(_, _, hp, maximum)| *hp > 0.0 && hp * 100.0 <= maximum * NPC_SPELL_HEAL_HP_PERCENT)
        .collect();
    let order = sorted_indices(wounded.len(), |left, right| {
        let (l, r) = (&wounded[left], &wounded[right]);
        or_else(l.2 / l.3 - r.2 / r.3, || compare_text(&l.0, &r.0))
    });
    if let Some(wounded) = order.first().map(|index| &wounded[*index]) {
        let healing = spells.iter().find(|spell| type_is(spell.get("kind"), "healing") && type_is(spell.get("target"), "ally") && in_range(spell, wounded.1, Some(&wounded.0)));
        if let Some(healing) = healing {
            if let Some(command) = validate_spell_plan(state, enemy, healing, ("target_id", Value::String(wounded.0.clone())))? {
                return Ok(Some(command));
            }
        }
    }

    let target_id = candidate.map(|candidate| id_of(candidate.actor)).unwrap_or_default();
    let target_at = if target_id.is_empty() { None } else { actor_point(state, &target_id) };
    let Some(target_at) = target_at.filter(|_| !target_id.is_empty()) else { return Ok(None) };
    let target_conditions = condition_ids(state, &target_id);
    for spell in &spells {
        let conditions = list(spell.get("conditions"));
        let control = type_is(spell.get("target"), "enemy")
            && matches!(spell.get("conditions"), Some(Value::Array(items)) if !items.is_empty())
            && conditions.iter().all(|condition| !target_conditions.contains(&js::string(Some(condition))))
            && (!js::truthy(spell.get("concentration")) || !active_concentration)
            && in_range(spell, target_at, Some(&target_id));
        if !control {
            continue;
        }
        let Some(command) = validate_spell_plan(state, enemy, spell, ("target_id", Value::String(target_id.clone())))? else { continue };
        let targets = living_targets(state, &command, spell);
        if targets.len() == 1 && id_of(&targets[0]) == target_id {
            return Ok(Some(command));
        }
    }

    // Центры областей: сперва герои, затем открытые клетки сцены.
    struct Center {
        at: Point,
        priority: u8,
        tie: String,
    }
    let mut centers: Vec<Center> = Vec::new();
    let mut seen: IndexSet<String> = IndexSet::new();
    let mut add_center = |at: Point, priority: u8, tie: String| {
        if !sk_rules::tactical_geometry::is_safe(at.x) || !sk_rules::tactical_geometry::is_safe(at.y) {
            return;
        }
        let key = format!("{},{}", js::f64_string(at.x), js::f64_string(at.y));
        if !seen.insert(key) {
            return;
        }
        centers.push(Center { at, priority, tie });
    };
    for hero in living_party(state) {
        if let Some(at) = actor_point(state, &id_of(hero)) {
            add_center(at, 0, id_of(hero));
        }
    }
    for cell in scene_cells(state) {
        if type_is(cell.get("type"), "wall") || js::is_false(cell.get("revealed")) {
            continue;
        }
        let x = cell.get("x");
        let y = cell.get("y");
        add_center(cell_point(cell), 1, format!("{},{}", js::string(x), js::string(y)));
    }
    struct AreaOption<'s> {
        spell: &'s Value,
        to: Point,
        caught: usize,
        score: f64,
        priority: u8,
        tie: String,
        command: Option<Value>,
    }
    let mut options: Vec<AreaOption<'_>> = Vec::new();
    for spell in &spells {
        if !type_is(spell.get("target"), "point") || !(number(spell.get("radius")) > 0.0) || !js::truthy(spell.get("damage")) || (js::truthy(spell.get("concentration")) && active_concentration) {
            continue;
        }
        let mut best: Option<AreaOption<'_>> = None;
        for center in &centers {
            if !in_range(spell, center.at, None) {
                continue;
            }
            let command = spell_cast_command(enemy, spell, ("to", point_json(center.at)));
            let affected = living_targets(state, &command, spell);
            let party_targets = affected.iter().filter(|target| !game::is_enemy_actor(state, &id_of(target))).count();
            let friendly_fire = affected.iter().any(|target| game::is_enemy_actor(state, &id_of(target)));
            if party_targets < 2 || friendly_fire {
                continue;
            }
            let score = spell_damage_estimate(Some(enemy), Some(spell), spell.get("level")) * party_targets as f64;
            let better = match &best {
                None => true,
                Some(best) => {
                    score > best.score
                        || (score == best.score
                            && (party_targets > best.caught
                                || (party_targets == best.caught && (center.priority < best.priority || (center.priority == best.priority && text::locale_compare(&center.tie, &best.tie) == std::cmp::Ordering::Less)))))
                }
            };
            if better {
                best = Some(AreaOption { spell, to: center.at, caught: party_targets, score, priority: center.priority, tie: center.tie.clone(), command: None });
            }
        }
        if let Some(best) = best {
            options.push(best);
        }
    }
    let area_order = |items: &[AreaOption<'_>]| {
        sorted_indices(items.len(), |left, right| {
            let (l, r) = (&items[left], &items[right]);
            or_else(r.score - l.score, || {
                or_else(r.caught as f64 - l.caught as f64, || or_else(number(r.spell.get("level")) - number(l.spell.get("level")), || compare_text(&js::s(l.spell.get("id")), &js::s(r.spell.get("id")))))
            })
        })
    };
    let order = area_order(&options);
    let mut slots: Vec<Option<AreaOption<'_>>> = options.into_iter().map(Some).collect();
    let mut validated: Vec<AreaOption<'_>> = Vec::new();
    for index in order {
        let Some(mut option) = slots[index].take() else { continue };
        let Some(command) = validate_spell_plan(state, enemy, option.spell, ("to", point_json(option.to)))? else { continue };
        option.score = spell_damage_estimate(Some(enemy), Some(option.spell), Some(&spell_level_value(&command, option.spell))) * option.caught as f64;
        option.command = Some(command);
        validated.push(option);
    }
    let order = area_order(&validated);
    if let Some(first) = order.first() {
        return Ok(validated[*first].command.clone());
    }

    let mut damaging: Vec<(&Value, Value, f64)> = Vec::new();
    for spell in &spells {
        if !type_is(spell.get("target"), "enemy") || !js::truthy(spell.get("damage")) || (js::truthy(spell.get("concentration")) && active_concentration) || !in_range(spell, target_at, Some(&target_id)) {
            continue;
        }
        let Some(command) = validate_spell_plan(state, enemy, spell, ("target_id", Value::String(target_id.clone())))? else { continue };
        let targets = living_targets(state, &command, spell);
        if targets.len() != 1 || id_of(&targets[0]) != target_id {
            continue;
        }
        let score = spell_damage_estimate(Some(enemy), Some(spell), Some(&spell_level_value(&command, spell)));
        damaging.push((spell, command, score));
    }
    let order = sorted_indices(damaging.len(), |left, right| or_else(damaging[right].2 - damaging[left].2, || compare_text(&js::s(damaging[left].0.get("id")), &js::s(damaging[right].0.get("id")))));
    Ok(order.first().map(|index| damaging[*index].1.clone()))
}

// --- легендарные действия ------------------------------------------------------------

/// `planLegendaryAction(rawState, bossId)`: легендарное действие после чужого
/// хода или `None`.
pub fn plan_legendary_action(raw_state: &Value, boss_id: &str) -> Result<Option<Value>, Halt> {
    plan_legendary_action_normalized(&NormalizedState::normalize(raw_state)?, boss_id)
}

/// [`plan_legendary_action`] над нормализованным состоянием.
pub fn plan_legendary_action_normalized(state: &NormalizedState, boss_id: &str) -> Result<Option<Value>, Halt> {
    let state = state.in_ambient_mode()?;
    let boss = game::find_actor(&state, boss_id);
    let profile = legendary_profile_for(boss);
    let combat = path(Some(&state), &["mechanics", "combat"]);
    let (Some(profile), Some(boss)) = (profile, boss) else { return Ok(None) };
    if !js::truthy(get(combat, "active")) || !game::is_enemy_actor(&state, boss_id) || !is_combat_capable(&state, boss) {
        return Ok(None);
    }
    if incapacitating_condition_for(&state, boss_id).is_some() {
        return Ok(None);
    }
    let active = at_index(list(get(combat, "initiative")), number(get(combat, "active_index")));
    if js::s(get(active, "actor_id")) == boss_id {
        return Ok(None);
    }
    let conditions = condition_ids(&state, boss_id);
    let window = legendary_window_key(combat);
    if legendary_window_spent(conditions.iter(), &window) {
        return Ok(None);
    }
    let remaining = profile.uses as f64 - legendary_uses_spent(conditions.iter()) as f64;
    let from = actor_point(&state, boss_id);
    let Some(from) = from.filter(|_| remaining > 0.0) else { return Ok(None) };
    let targets: Vec<LegendaryTarget> = living_party(&state)
        .into_iter()
        .filter_map(|hero| actor_point(&state, &id_of(hero)).map(|at| (id_of(hero), at)))
        .map(|(id, at)| LegendaryTarget { distance_feet: distance_between(&state, boss_id, &id, Some(from), Some(at)), id })
        .collect();
    let chosen = choose_legendary_action(Some(boss), remaining, &targets, |marker| conditions.contains(marker));
    Ok(chosen.map(|chosen| json!({ "command_type": "UseLegendaryAction", "actor_id": boss_id, "legendary_action_id": chosen.action.id, "target_id": chosen.target_id })))
}

// --- публичная тактика ---------------------------------------------------------------

/// `publicTacticFor(state, enemy, candidate, commands)`: причина выбора,
/// видимая за столом (`{ tactic, target_id }`).
pub fn public_tactic_for(state: &Value, enemy: &Value, candidate: Option<&Candidate<'_>>, commands: &[Value]) -> Option<Value> {
    let candidate = candidate?;
    let target_id = id_of(candidate.actor);
    let profile = &candidate.profile;
    let supported = adjacent_enemy_ally(state, enemy, candidate.actor);
    let pack = supported && (has_trait(enemy, "pack-tactics") || has_trait(enemy, "martial-advantage"));
    let target_hp = max2(0.0, number_or(candidate.actor.get("hp"), 0.0));
    let target_maximum = max2(1.0, or_number(or_number(number(candidate.actor.get("maxHp")), target_hp), 1.0));
    let wounded = target_hp > 0.0 && target_hp <= target_maximum / 2.0;
    let condition = js::s(path(Some(profile), &["on_hit", "condition"]));
    let controlled = !condition.is_empty() && condition_ids(state, &target_id).contains(&condition);
    let retreat = commands.iter().any(|command| type_is(command.get("command_type"), "MoveActor"))
        && commands.iter().any(|command| matches!(js::s(command.get("monster_ability")).as_str(), "keep-distance" | "nimble-escape"));
    let spell_cast = commands.iter().find(|command| type_is(command.get("command_type"), "CastSpell"));
    let ranged = profile_kind(Some(profile)) == Some("ranged");
    let tactic = if let Some(cast) = spell_cast {
        let target = cast.get("target_id");
        if js::truthy(target) && game::is_enemy_actor(state, &js::string(target)) {
            "выхаживает союзника"
        } else {
            "бьёт заклинанием"
        }
    } else if commands.iter().any(|command| type_is(command.get("command_type"), "UseItem")) {
        "пускает в ход снаряжение"
    } else if retreat {
        "держит дистанцию"
    } else if pack {
        "тактика стаи"
    } else if !condition.is_empty() && !controlled {
        "пытается сковать цель"
    } else if wounded {
        "давит на раненого"
    } else if candidate.in_range {
        if ranged {
            "держит линию огня"
        } else {
            "атакует доступную цель"
        }
    } else if ranged {
        "выходит на линию атаки"
    } else {
        "сокращает дистанцию"
    };
    Some(json!({ "tactic": tactic, "target_id": target_id }))
}

/// `monsterAreaPlanFor(state, enemy, candidate)`: дыхание и прочие области.
fn monster_area_plan_for(state: &Value, enemy: &Value, candidate: Option<&Candidate<'_>>) -> Result<Option<Value>, Halt> {
    let id = id_of(enemy);
    if js::is_false(get(economy_of(state, &id), "action")) {
        return Ok(None);
    }
    let actions: Vec<&Value> = list(enemy.get("special_actions")).iter().filter(|action| type_is(action.get("kind"), "save_area")).collect();
    let origins: Vec<Point> = living_party(state).into_iter().filter_map(|target| actor_point(state, &id_of(target))).collect();
    let attack_value = match candidate {
        Some(candidate) => average_damage(candidate.profile.get("damage_expression"), candidate.profile.get("damage_amount")) * multiattack_count(enemy) * 0.6,
        None => 0.0,
    };
    let mut best: Option<(f64, Option<Value>, Point)> = None;
    for action in actions {
        for to in &origins {
            let preview = match preview_monster_action(state, &id, action.get("id"), Some(&point_json(*to))) {
                Ok(preview) => preview,
                Err(halt) if halt.is_rule() => continue,
                Err(halt) => return Err(halt),
            };
            if preview.affected_ids.iter().any(|target| game::is_enemy_actor(state, target)) {
                continue;
            }
            let damage: f64 = list(preview.action.get("damage")).iter().fold(0.0, |sum, component| sum + average_damage(component.get("expression"), component.get("amount")));
            let score = damage * preview.affected_ids.len() as f64;
            if score >= attack_value && best.as_ref().is_none_or(|(best_score, _, _)| score > *best_score) {
                best = Some((score, action.get("id").cloned(), *to));
            }
        }
    }
    Ok(best.map(|(_, action_id, to)| {
        let mut command = Map::new();
        command.insert("command_type".into(), single("UseMonsterAction"));
        command.insert("actor_id".into(), Value::String(id.clone()));
        if let Some(action_id) = action_id {
            command.insert("action_id".into(), action_id);
        }
        command.insert("to".into(), point_json(to));
        Value::Object(command)
    }))
}

/// `npcCommandValid(state, command)`.
fn npc_command_valid(state: &NormalizedState, command: &Value) -> Result<bool, Halt> {
    let mut uuid = validation_uuid();
    match sk_rules::validate::validate_normalized(&with_authority(command), state, &npc_context(&js::string(command.get("actor_id"))), &mut uuid) {
        Ok(_) => Ok(true),
        Err(halt) if halt.is_rule() => Ok(false),
        Err(halt) => Err(halt),
    }
}

// --- план хода -----------------------------------------------------------------------

/// `planNpcTurn(rawState, enemyId)`: команды хода существа.
pub fn plan_npc_turn(raw_state: &Value, enemy_id: &str) -> Result<Vec<Value>, Halt> {
    plan_npc_turn_normalized(&NormalizedState::normalize(raw_state)?, enemy_id)
}

/// [`plan_npc_turn`] над нормализованным состоянием: проверки команд-кандидатов
/// идут без повторной нормализации.
pub fn plan_npc_turn_normalized(state: &NormalizedState, enemy_id: &str) -> Result<Vec<Value>, Halt> {
    let state = state.in_ambient_mode()?;
    let state: &NormalizedState = &state;
    let end = || end_turn(enemy_id);
    let Some(enemy) = game::find_actor(state, enemy_id).filter(|enemy| game::is_enemy_actor(state, enemy_id) && is_combat_capable(state, enemy)) else {
        return Ok(vec![end()]);
    };
    if incapacitating_condition_for(state, enemy_id).is_some() {
        return Ok(vec![end()]);
    }
    let own_conditions = conditions_of(state, enemy_id);
    if let Some(turned) = own_conditions.iter().find(|condition| condition_id(condition) == "turned") {
        return turned_undead_plan(state, enemy, &js::s(get(Some(turned), "source_actor")));
    }
    let stand_up = json!({ "command_type": "UseCombatAction", "actor_id": enemy_id, "action_id": "stand-up" });
    if own_conditions.iter().any(|condition| condition_id(condition) == "prone") {
        let speed = effective_speed_feet(state, enemy, enemy_id) as f64;
        let remaining = remaining_movement_feet(state, enemy_id);
        if speed > 0.0 && remaining >= (speed / 2.0).ceil() && npc_command_valid(state, &stand_up)? {
            return Ok(vec![stand_up]);
        }
    }
    let regain = json!({ "command_type": "UseCombatAction", "actor_id": enemy_id, "action_id": "steady-nerves" });
    if own_conditions.iter().any(|condition| js::truthy(get(Some(condition), "action_save_ability"))) && npc_command_valid(state, &regain)? {
        return Ok(vec![regain, end()]);
    }
    let economy = economy_of(state, enemy_id);
    let used_before_plan = max2(0.0, number_or(get(economy, "attacks_used"), 0.0));
    let declared = multiattack_count(enemy);
    let frame_limit = max2(0.0, number_or(get(economy, "attack_action_limit"), 0.0));
    let frame_kind = js::string(nullish(get(economy, "attack_action_kind"), Some(&single("normal"))));
    let frame_applies = frame_limit > 0.0 && (used_before_plan > 0.0 || frame_kind != "normal");
    let attacks_allowed = if condition_ids(state, enemy_id).contains("slowed") {
        1.0
    } else if frame_applies {
        min2(declared, frame_limit)
    } else {
        declared
    };
    if js::is_false(get(economy, "action")) && (used_before_plan == 0.0 || used_before_plan >= attacks_allowed) {
        return Ok(vec![end()]);
    }
    let candidates = target_candidates(state, enemy)?;
    let candidate = candidates.first();
    let usable = npc_usable_items(Some(enemy), &js::s(state.get("ruleset_id")));
    let bloodied_retreat = if should_retreat_bloodied(state, enemy)? { bloodied_retreat_for(state, enemy)? } else { None };
    let healing_sip = healing_potion_command_for(state, enemy, &usable, economy);
    let healing_uses_action = healing_sip.as_ref().is_some_and(|sip| {
        usable.iter().find(|item| item.get("item_instance_id") == sip.get("item_id")).is_some_and(|item| type_is(path(Some(item), &["use", "combat_action"]), "action"))
    });
    if healing_uses_action {
        return Ok(vec![healing_sip.unwrap_or(Value::Null), end()]);
    }
    let with_sip = |middle: Vec<Value>| {
        let mut commands: Vec<Value> = healing_sip.iter().cloned().collect();
        commands.extend(middle);
        commands.push(end());
        commands
    };
    let area_plan = if bloodied_retreat.is_some() { None } else { monster_area_plan_for(state, enemy, candidate)? };
    if let Some(area) = area_plan {
        return Ok(with_sip(vec![area]));
    }
    let spell_plan = if bloodied_retreat.is_some() { None } else { monster_spell_plan_for(state, enemy, candidate, economy)? };
    if let Some(spell) = spell_plan {
        return Ok(with_sip(vec![spell]));
    }
    let enemy_at = actor_point(state, enemy_id);
    let Some(candidate) = candidate else {
        let flask = if bloodied_retreat.is_some() { None } else { thrown_flask_command_for(state, enemy, &usable, economy, enemy_at) };
        return Ok(with_sip(flask.into_iter().collect()));
    };
    let target_id = id_of(candidate.actor);
    let profile = &candidate.profile;
    let range = number(profile.get("range_feet"));
    let ranged = profile_kind(Some(profile)) == Some("ranged");
    let target_at = actor_point(state, &target_id);
    let adjacent = distance_between(state, enemy_id, &target_id, enemy_at, target_at) == CELL_FEET;
    let mut commands: Vec<Value> = Vec::new();
    let mut movement_only_phase = false;
    let mut planned_movement_feet = 0.0;
    let mut planned_position: Option<Point> = None;
    let move_to = |to: Point, ability: Option<&str>| {
        let mut command = Map::new();
        command.insert("command_type".into(), single("MoveActor"));
        command.insert("actor_id".into(), single(enemy_id));
        command.insert("to".into(), point_json(to));
        if let Some(ability) = ability {
            command.insert("monster_ability".into(), single(ability));
        }
        Value::Object(command)
    };
    let nimble_disengage = || json!({ "command_type": "AddCondition", "actor_id": enemy_id, "target_id": enemy_id, "condition": "disengaged", "duration": "until-own-turn-end", "monster_ability": "nimble-escape" });
    let normal_range = number(profile.get("normal_range_feet"));
    if let Some(retreat) = bloodied_retreat {
        if adjacent_party_member(state, enemy) && !js::is_false(get(economy, "action")) {
            commands.push(json!({ "command_type": "UseCombatAction", "actor_id": enemy_id, "action_id": "disengage" }));
        }
        commands.push(move_to(retreat, Some("bloodied-withdrawal")));
        movement_only_phase = true;
    } else if candidate.in_range && ranged && keeps_distance(enemy) && !adjacent_party_member(state, enemy) && melee_threat_within_reach(state, enemy) {
        if let Some(retreat) = retreat_destination(state, enemy, candidate.actor, range, normal_range) {
            commands.push(move_to(retreat, Some(KEEP_DISTANCE)));
        }
        commands.extend(attack_commands(state, enemy, &target_id, profile));
    } else if candidate.in_range && ranged && keeps_distance(enemy) && adjacent && !has_trait(enemy, "nimble-escape") {
        if let Some(retreat) = retreat_destination(state, enemy, candidate.actor, range, normal_range) {
            commands.push(move_to(retreat, Some(KEEP_DISTANCE)));
            movement_only_phase = true;
        } else {
            commands.extend(attack_commands(state, enemy, &target_id, profile));
        }
    } else if candidate.in_range && ranged && adjacent && has_trait(enemy, "nimble-escape") {
        if let Some(retreat) = retreat_destination(state, enemy, candidate.actor, range, normal_range) {
            commands.push(nimble_disengage());
            commands.push(move_to(retreat, None));
            commands.extend(attack_commands(state, enemy, &target_id, profile));
        }
    } else if candidate.blocked_shot {
        if let Some(firing) = firing_position_for(state, enemy, candidate.actor, profile)? {
            planned_movement_feet = firing.cost_feet;
            planned_position = Some(firing.destination);
            commands.push(move_to(firing.destination, Some("firing-position")));
            commands.extend(attack_commands(state, enemy, &target_id, profile));
        } else if let Some(route) = candidate.path.as_ref().filter(|path| !path.is_empty()) {
            let budget = remaining_movement_feet(state, enemy_id);
            let (steps, cost) = affordable_path_prefix(state, enemy_id, route, max2(0.0, route.len() as f64 - 1.0), budget);
            if steps > 0 {
                planned_movement_feet = cost;
                planned_position = Some(route[steps - 1]);
                commands.push(move_to(route[steps - 1], None));
            }
        }
    } else if let Some(route) = candidate.path.as_ref().filter(|path| !candidate.in_range && !path.is_empty()) {
        let range_cells = max2(1.0, (range_or_cell(Some(profile)) / CELL_FEET).floor());
        let speed_feet = effective_speed_feet(state, enemy, enemy_id) as f64;
        let available_feet = remaining_movement_feet(state, enemy_id);
        let aggressive_available = has_trait(enemy, "aggressive") && !js::is_false(get(economy, "bonus_action"));
        let approach_steps = max2(0.0, route.len() as f64 - range_cells);
        let affordable = affordable_path_prefix(state, enemy_id, route, approach_steps, available_feet);
        let needs_aggressive = aggressive_available && (affordable.0 as f64) < approach_steps;
        let needs_dash = !needs_aggressive && (affordable.0 as f64) < approach_steps && !js::is_false(get(economy, "action")) && used_before_plan == 0.0 && thrown_flask_command_for(state, enemy, &usable, economy, enemy_at).is_none();
        let reach = if needs_aggressive || needs_dash { affordable_path_prefix(state, enemy_id, route, approach_steps, available_feet + speed_feet) } else { affordable };
        let dashed = needs_dash && reach.0 > affordable.0;
        if dashed {
            commands.push(json!({ "command_type": "UseCombatAction", "actor_id": enemy_id, "action_id": "dash" }));
        }
        if reach.0 > 0 {
            planned_movement_feet = reach.1;
            planned_position = Some(route[reach.0 - 1]);
            commands.push(move_to(route[reach.0 - 1], needs_aggressive.then_some("aggressive")));
        }
        let destination = if reach.0 > 0 { Some(route[reach.0 - 1]) } else { actor_point(state, enemy_id) };
        let distance_after = match (destination, target_at) {
            (Some(destination), Some(target_at)) => distance_between(state, enemy_id, &target_id, Some(destination), Some(target_at)),
            _ => MAX_SAFE_INTEGER,
        };
        if !dashed && distance_after >= CELL_FEET && distance_after <= range && (range <= CELL_FEET || clear_between(state, enemy_id, &target_id, destination, target_at)) {
            commands.extend(attack_commands(state, enemy, &target_id, profile));
        }
    } else if candidate.in_range {
        if let Some(firing) = firing_position_for(state, enemy, candidate.actor, profile)? {
            planned_movement_feet = firing.cost_feet;
            planned_position = Some(firing.destination);
            commands.push(move_to(firing.destination, Some("firing-position")));
        }
        commands.extend(attack_commands(state, enemy, &target_id, profile));
    }
    let attack_planned = commands.iter().any(|command| type_is(command.get("command_type"), "MakeAttack"));
    if !attack_planned && !movement_only_phase && planned_position.is_none() {
        if let Some(flask) = thrown_flask_command_for(state, enemy, &usable, economy, enemy_at) {
            commands.push(flask);
        }
    }
    let bonus_action_planned = commands.iter().any(|command| matches!(js::s(command.get("monster_ability")).as_str(), "nimble-escape" | "aggressive"));
    let weapon_poison = if !bonus_action_planned && healing_sip.is_none() && attack_planned { weapon_poison_command_for(state, enemy, &usable, economy, profile) } else { None };
    let bonus_equipment = if bonus_action_planned { None } else { healing_sip.clone().or(weapon_poison) };
    let has_bonus_equipment = bonus_equipment.is_some();
    if let Some(equipment) = bonus_equipment {
        commands.insert(0, equipment);
    }
    if attack_planned && !has_bonus_equipment && profile_kind(Some(profile)) == Some("melee") && attacks_allowed <= 1.0 && has_trait(enemy, "nimble-escape") && !js::is_false(get(economy, "bonus_action")) {
        let retreat_state = match planned_position {
            Some(position) => Some(retreat_state_at(state, enemy_id, position, economy, planned_movement_feet)?),
            None => None,
        };
        let retreat_state_ref = retreat_state.as_ref().unwrap_or(state);
        let retreat_enemy = game::find_actor(retreat_state_ref, enemy_id).unwrap_or(enemy);
        if let Some(retreat) = retreat_destination(retreat_state_ref, retreat_enemy, candidate.actor, 10_000.0, 10_000.0) {
            commands.push(nimble_disengage());
            commands.push(move_to(retreat, None));
        }
    }
    if !movement_only_phase && (!attack_planned || attacks_allowed <= 1.0) {
        commands.push(end());
    }
    Ok(commands)
}

/// Состояние для хитрого отхода после подхода: существо уже стоит на
/// клетке плана и потратило его движение.
fn retreat_state_at(state: &Value, enemy_id: &str, position: Point, economy: Option<&Value>, planned_movement_feet: f64) -> Result<Value, Halt> {
    let mut retreat = normalize_campaign_state(state)?;
    let spent = max2(0.0, number_or(get(economy, "movement_spent"), 0.0)) + planned_movement_feet;
    if let Some(mechanics) = retreat.get_mut("mechanics").and_then(Value::as_object_mut) {
        let positions = mechanics.entry("positions").or_insert_with(|| json!({}));
        if let Some(positions) = positions.as_object_mut() {
            positions.insert(enemy_id.to_string(), point_json(position));
        }
    }
    if let Some(actor) = game::find_actor_mut(&mut retreat, enemy_id).and_then(Value::as_object_mut) {
        actor.insert("x".into(), js::num(position.x));
        actor.insert("y".into(), js::num(position.y));
    }
    if let Some(economy) = retreat.pointer_mut("/mechanics/combat/action_economy").and_then(Value::as_object_mut) {
        let mut entry = economy.get(enemy_id).and_then(Value::as_object).cloned().unwrap_or_default();
        entry.insert("movement_spent".into(), js::num(spent));
        economy.insert(enemy_id.to_string(), Value::Object(entry));
    }
    Ok(retreat)
}

// --- цикл сервера --------------------------------------------------------------------

/// `keyPart(value)` планировщика: замена по кодовым единицам UTF-16 (регулярка
/// без флага `u`), затем первые 60.
fn key_part(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            out.push(ch);
        } else {
            for _ in 0..ch.len_utf16() {
                out.push('-');
            }
        }
    }
    let out: String = out.chars().take(60).collect();
    if out.is_empty() {
        "none".into()
    } else {
        out
    }
}

fn safe_or(value: Option<&Value>, fallback: f64) -> Value {
    let number = js::number(value);
    if sk_rules::tactical_geometry::is_safe(number) {
        js::num(number)
    } else {
        js::num(fallback)
    }
}

/// `schedulerKey(campaignId, state, actorId, suffix, instanceOverride)`.
fn scheduler_key(campaign_id: &str, state: &Value, actor_id: &str, suffix: &str, instance_override: Option<&str>) -> String {
    let combat = path(Some(state), &["mechanics", "combat"]);
    let instance: Option<Value> = match instance_override {
        Some(instance) => Some(single(instance)),
        None => get(combat, "combat_instance_id").cloned(),
    };
    let Some(instance) = instance.filter(|instance| js::truthy(Some(instance))) else {
        return format!("npc:{}:r{}:i{}:{}:{}", key_part(campaign_id), js::string(get(combat, "round")), js::string(get(combat, "active_index")), key_part(actor_id), suffix);
    };
    let tuple = json!([campaign_id, js::string(Some(&instance)), safe_or(get(combat, "round"), 0.0), safe_or(get(combat, "active_index"), -1.0), actor_id, suffix]);
    format!("npc:{}:{}", key_part(campaign_id), hash::sha256_hex(js::stringify(&tuple)))
}

/// Журнал планировщика: исполнителю нужен [`Journal`], восстановлению
/// старых ключей — чтение событий (`typeof eventStore.getEvents === 'function'`).
pub trait NpcTurnJournal: Journal {
    /// `getEvents(campaignId, { after_version, up_to_version })`; `None` —
    /// у журнала такого метода нет.
    fn events_between(&self, _campaign_id: &str, _after_version: i64, _up_to_version: i64) -> Option<StoreResult<Vec<Value>>> {
        None
    }
}

impl NpcTurnJournal for EventStore {
    fn events_between(&self, campaign_id: &str, after_version: i64, up_to_version: i64) -> Option<StoreResult<Vec<Value>>> {
        Some(self.get_events(campaign_id, after_version, Some(up_to_version)))
    }
}

/// Движок, разбирающий план (`rulesEngine.resolvePlan`): итог — JSON
/// `{ commands, events, rolls, state }`.
pub trait NpcRulesEngine {
    fn resolve_plan(&self, commands: &[Value], state: &Value, context: &Value) -> Result<Value, Halt>;
    /// [`Self::resolve_plan`] над нормализованным состоянием (урок 4).
    fn resolve_plan_normalized(&self, commands: &[Value], state: &NormalizedState, context: &Value) -> Result<Value, Halt> {
        self.resolve_plan(commands, state.value(), context)
    }
}

impl NpcRulesEngine for RefCell<RulesEngine> {
    fn resolve_plan(&self, commands: &[Value], state: &Value, context: &Value) -> Result<Value, Halt> {
        let plan = json!({ "proposed_commands": commands });
        let resolved = self.borrow_mut().resolve_plan(&plan, state, &Context::from_json(context))?;
        Ok(json!({ "commands": resolved.commands, "events": resolved.events, "rolls": resolved.rolls, "state": resolved.state }))
    }

    fn resolve_plan_normalized(&self, commands: &[Value], state: &NormalizedState, context: &Value) -> Result<Value, Halt> {
        let plan = json!({ "proposed_commands": commands });
        let resolved = self.borrow_mut().resolve_plan_normalized(&plan, state, &Context::from_json(context))?;
        Ok(json!({ "commands": resolved.commands, "events": resolved.events, "rolls": resolved.rolls, "state": resolved.state }))
    }
}

/// Будущее, возвращаемое контроллером морали.
pub type DecisionFuture<'a> = Pin<Box<dyn Future<Output = Option<Value>> + 'a>>;

/// Контроллер морали (`npcController.decide({ state, enemyId })`).
pub trait NpcController {
    fn decide<'a>(&'a self, state: &'a Value, enemy_id: &'a str) -> DecisionFuture<'a>;
}

/// Отказ планировщика.
#[derive(Debug, Clone)]
pub enum SchedulerError {
    /// `RulesValidationError`: отказ движка или самого планировщика.
    Rule(RuleError),
    /// Прочая ошибка движка (`TypeError` и т. п.).
    Halt(Halt),
    /// Исполнитель или хранилище.
    Executor(ExecutorError),
    /// `RangeError` параметров.
    Range(String),
}

impl SchedulerError {
    /// Код для HTTP и сверки.
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Rule(error) => Some(&error.code),
            Self::Halt(halt) => halt.code(),
            Self::Executor(error) => Some(error.code()),
            Self::Range(_) => None,
        }
    }

    /// `error instanceof RulesValidationError`.
    pub fn is_rules_validation(&self) -> bool {
        matches!(self, Self::Rule(_))
    }

    fn rule(code: &str, message: impl Into<String>) -> Self {
        Self::Rule(RuleError::new(code, message))
    }
}

impl std::fmt::Display for SchedulerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rule(error) => write!(formatter, "{error}"),
            Self::Halt(halt) => write!(formatter, "{halt}"),
            Self::Executor(error) => write!(formatter, "{error}"),
            Self::Range(message) => write!(formatter, "RangeError: {message}"),
        }
    }
}

impl std::error::Error for SchedulerError {}

impl From<Halt> for SchedulerError {
    fn from(halt: Halt) -> Self {
        match halt {
            Halt::Rule(error) => Self::Rule(error),
            other => Self::Halt(other),
        }
    }
}

impl From<StoreError> for SchedulerError {
    fn from(error: StoreError) -> Self {
        Self::Executor(ExecutorError::Store(error))
    }
}

/// Итог `runNpcTurnScheduler`: `{ state, state_version, turns, events }`.
#[derive(Debug, Clone, PartialEq)]
pub struct SchedulerResult {
    pub state: std::sync::Arc<Value>,
    pub state_version: i64,
    pub turns: Vec<Value>,
    pub events: Vec<Value>,
}

impl SchedulerResult {
    pub fn to_json(&self) -> Value {
        json!({ "state": self.state.as_ref(), "state_version": self.state_version, "turns": self.turns, "events": self.events })
    }
}

/// Параметры `runNpcTurnScheduler`.
pub struct SchedulerOptions<'a> {
    pub campaign_id: &'a str,
    pub journal: &'a dyn NpcTurnJournal,
    pub rules_engine: &'a dyn NpcRulesEngine,
    pub npc_controller: Option<&'a dyn NpcController>,
    pub advance_npc: bool,
    pub max_turns: i64,
}

impl<'a> SchedulerOptions<'a> {
    /// Значения по умолчанию JS: `advanceNpc = true`, `maxTurns = 160`.
    pub fn new(campaign_id: &'a str, journal: &'a dyn NpcTurnJournal, rules_engine: &'a dyn NpcRulesEngine) -> Self {
        Self { campaign_id, journal, rules_engine, npc_controller: None, advance_npc: true, max_turns: 160 }
    }
}

/// Восстановление ключа старого снимка без маркера боя.
struct Recovery<'s> {
    state: &'s Value,
    actor_id: String,
    suffix: String,
}

struct PlanCommit {
    committed: Executed,
    key: String,
}

/// Исполнить готовые команды через [`AuthoritativeExecutor`] (сервер, `isAdmin`).
///
/// Исполнитель с запоминанием прочих ошибок движка: `ResolvePlan` знает только
/// `RuleError`, а планировщику важно отличить отказ правила от `TypeError`.
pub fn execute_plan(journal: &dyn NpcTurnJournal, rules_engine: &dyn NpcRulesEngine, campaign_id: &str, key: &str, commands: &[Value], context: &Value, max_attempts: usize) -> Result<Executed, SchedulerError> {
    let executor = AuthoritativeExecutor::new(journal).with_max_attempts(max_attempts);
    let fault: RefCell<Option<Halt>> = RefCell::new(None);
    // Голова журнала уже нормализована хранилищем: движок берёт её как есть.
    let resolve = |commands: &[Value], state: &std::sync::Arc<Value>, reducer_version: i64, context: &Value| -> Result<Value, RuleError> {
        match NormalizedState::from_journal(state, reducer_version).and_then(|state| rules_engine.resolve_plan_normalized(commands, &state, context)) {
            Ok(resolved) => Ok(resolved),
            Err(Halt::Rule(error)) => Err(error),
            Err(other) => {
                let code = other.code().unwrap_or("ENGINE_FAULT").to_string();
                let message = other.to_string();
                *fault.borrow_mut() = Some(other);
                Err(RuleError::new(code, message))
            }
        }
    };
    match executor.execute_commands_on_head(campaign_id, key, commands, context, &resolve) {
        Ok(executed) => Ok(executed),
        Err(ExecutorError::Rule(error)) => match fault.borrow_mut().take() {
            Some(halt) => Err(SchedulerError::Halt(halt)),
            None => Err(SchedulerError::Rule(error)),
        },
        Err(other) => Err(SchedulerError::Executor(other)),
    }
}

fn execute_at(options: &SchedulerOptions<'_>, commands: &[Value], key: &str, context: &Value) -> Result<Executed, SchedulerError> {
    let planned: Vec<Value> = commands
        .iter()
        .enumerate()
        .map(|(index, command)| {
            let mut map = command.as_object().cloned().unwrap_or_default();
            map.insert("server_authoritative".into(), Value::Bool(true));
            map.insert("campaign_id".into(), single(options.campaign_id));
            map.insert("command_id".into(), Value::String(format!("{key}:{}", index + 1)));
            Value::Object(map)
        })
        .collect();
    execute_plan(options.journal, options.rules_engine, options.campaign_id, key, &planned, context, 3)
}

/// `commitPlan(...)`: план через исполнителя, при столкновении со старым
/// ключом — один повтор с экземпляром боя из журнала.
fn commit_plan(options: &SchedulerOptions<'_>, loaded_version: i64, commands: &[Value], key: &str, recovery: Option<&Recovery<'_>>) -> Result<PlanCommit, SchedulerError> {
    let context = json!({ "isAdmin": true, "isNpcScheduler": true, "serverAuthoritativeCombat": true, "actor_ids": [] });
    let mut used_key = key.to_string();
    let mut committed = execute_at(options, commands, &used_key, &context)?;
    if committed.replayed && committed.commit.state_version < loaded_version {
        if let Some(recovery) = recovery.filter(|recovery| !js::truthy(path(Some(recovery.state), &["mechanics", "combat", "combat_instance_id"]))) {
            if let Some(history) = options.journal.events_between(options.campaign_id, committed.commit.state_version, loaded_version) {
                let history = history?;
                let started = history.iter().rev().find(|event| type_is(event.get("event_type"), "CombatStarted") && js::truthy(event.get("event_id")));
                if let Some(started) = started {
                    let instance = format!("legacy-recovery:{}:{}", js::string(started.get("event_id")), js::string(started.get("state_version_after")));
                    let recovered = scheduler_key(options.campaign_id, recovery.state, &recovery.actor_id, &recovery.suffix, Some(&instance));
                    if recovered != used_key {
                        used_key = recovered;
                        committed = execute_at(options, commands, &used_key, &context)?;
                    }
                }
            }
        }
    }
    let events_len = match &committed.resolved {
        Some(resolved) => list(resolved.get("events")).len(),
        None => committed.commit.events.len(),
    };
    if events_len == 0 {
        return Err(SchedulerError::rule("NPC_TURN_EMPTY", "NPC turn produced no events"));
    }
    Ok(PlanCommit { committed, key: used_key })
}

/// `duplicateWithoutProgress(loaded, committed)`.
fn duplicate_without_progress(loaded_version: i64, committed: &Executed) -> bool {
    committed.replayed && committed.commit.state_version <= loaded_version
}

fn insert_present(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value.clone());
    }
}

/// `runNpcTurnScheduler({ campaignId, eventStore, rulesEngine, npcController,
/// advanceNpc, maxTurns })`: двигает только серверных участников.
pub async fn run_npc_turn_scheduler(options: SchedulerOptions<'_>) -> Result<SchedulerResult, SchedulerError> {
    Ok(run_npc_turn_scheduler_marked(options).await?.0)
}

/// [`run_npc_turn_scheduler`] с отметкой, нормализовано ли `state` итога (Ск3):
/// ранние выходы без боя, с окном реакции и перемирием отдают нормализованное
/// состояние, остальные — сырое из журнала. Координатору хода отметка
/// позволяет не нормализовать ту же версию второй раз.
pub(crate) async fn run_npc_turn_scheduler_marked(options: SchedulerOptions<'_>) -> Result<(SchedulerResult, bool), SchedulerError> {
    if !(1..=256).contains(&options.max_turns) {
        return Err(SchedulerError::Range("maxTurns must be between 1 and 256".into()));
    }
    let campaign_id = options.campaign_id;
    let mut loaded = options.journal.load(campaign_id)?;
    let mut turns: Vec<Value> = Vec::new();
    let mut events: Vec<Value> = Vec::new();
    let done = |state: std::sync::Arc<Value>, version: i64, turns: Vec<Value>, events: Vec<Value>| Ok((SchedulerResult { state, state_version: version, turns, events }, false));
    let done_normalized = |state: std::sync::Arc<Value>, version: i64, turns: Vec<Value>, events: Vec<Value>| Ok((SchedulerResult { state, state_version: version, turns, events }, true));
    for _ in 0..options.max_turns {
        let state = NormalizedState::from_loaded(&loaded)?;
        let combat = path(Some(&state), &["mechanics", "combat"]).cloned().unwrap_or(Value::Null);
        let combat = Some(&combat);
        if !js::truthy(get(combat, "active")) {
            let stable = stable_unconscious_party(&state);
            let last_end = list(state.get("battleLog")).iter().rev().find(|entry| type_is(get(Some(entry), "type"), "combat-end"));
            if living_party(&state).is_empty() && !stable.is_empty() && type_is(get(last_end, "reason"), "enemies_defeated") {
                let key = format!("npc:{}:stable-recovery:v{}", key_part(campaign_id), loaded.state_version);
                let plan = commit_plan(&options, loaded.state_version, &[json!({ "command_type": "AdvanceTime", "amount": 60, "unit": "minute" })], &key, None)?;
                if duplicate_without_progress(loaded.state_version, &plan.committed) {
                    return done(loaded.state, loaded.state_version, turns, events);
                }
                events.extend(plan.committed.commit.events.iter().cloned());
                turns.push(json!({
                    "actor_id": stable.iter().map(|actor| id_of(actor)).collect::<Vec<_>>().join(","),
                    "kind": "stable-recovery",
                    "elapsed_minutes": 60,
                    "idempotency_key": key,
                    "state_version": plan.committed.commit.state_version,
                }));
                loaded = options.journal.load(campaign_id)?;
                continue;
            }
            let version = loaded.state_version;
            return done_normalized(state.shared(), version, turns, events);
        }
        if js::truthy(get(combat, "reaction_window")) || truce_holds(&state) {
            let version = loaded.state_version;
            return done_normalized(state.shared(), version, turns, events);
        }
        let completed: IndexSet<String> = list(get(combat, "turn_completed")).iter().map(|id| js::string(Some(id))).collect();
        let current_id = match initiative_group_ids(&state).into_iter().find(|id| !completed.contains(id)) {
            Some(id) => id,
            None => js::s(get(at_index(list(get(combat, "initiative")), number(get(combat, "active_index"))), "actor_id")),
        };
        let party = living_party(&state);
        let enemies = living_enemies(&state);
        let dying = unstable_dying_party(&state);
        let round = get(combat, "round");
        let active_index = get(combat, "active_index");
        if (party.is_empty() || enemies.is_empty()) && dying.is_empty() {
            let reason = if !enemies.is_empty() {
                if type_is(path(Some(&state), &["mechanics", "death", "campaign_status"]), "party_defeated") {
                    "party_defeated"
                } else {
                    "party_incapacitated"
                }
            } else {
                scenario_encounter_end_reason(&state).unwrap_or("enemies_defeated")
            };
            let key_actor = if !current_id.is_empty() {
                current_id.clone()
            } else if party.first().is_some_and(|actor| js::truthy(actor.get("id"))) {
                js::s(party.first().and_then(|actor| actor.get("id")))
            } else {
                js::s(enemies.first().and_then(|actor| actor.get("id")))
            };
            let suffix = format!("end-{reason}");
            let key = scheduler_key(campaign_id, &state, &key_actor, &suffix, None);
            let Some(actor) = game::find_actor(&state, &current_id).or_else(|| party.first().copied()).or_else(|| enemies.first().copied()) else {
                return Err(SchedulerError::rule("INVALID_COMBAT_STATE", "Combat has no actor that can close it"));
            };
            let actor_id = id_of(actor);
            let recovery = Recovery { state: &state, actor_id: if current_id.is_empty() { actor_id.clone() } else { current_id.clone() }, suffix };
            let plan = commit_plan(&options, loaded.state_version, &[json!({ "command_type": "EndCombat", "actor_id": actor_id, "reason": reason })], &key, Some(&recovery))?;
            if duplicate_without_progress(loaded.state_version, &plan.committed) {
                return done(loaded.state, loaded.state_version, turns, events);
            }
            events.extend(plan.committed.commit.events.iter().cloned());
            let mut turn = Map::new();
            turn.insert("actor_id".into(), Value::String(actor_id));
            insert_present(&mut turn, "round", round);
            insert_present(&mut turn, "active_index", active_index);
            turn.insert("kind".into(), single("combat-end"));
            turn.insert("reason".into(), single(reason));
            turn.insert("idempotency_key".into(), Value::String(plan.key));
            turn.insert("state_version".into(), Value::from(plan.committed.commit.state_version));
            turns.push(Value::Object(turn));
            loaded = options.journal.load(campaign_id)?;
            continue;
        }
        let current = game::find_actor(&state, &current_id);
        let mut legendary: Option<(String, Value)> = None;
        if options.advance_npc {
            let mut bosses: Vec<(String, Value)> = Vec::new();
            for enemy in living_enemies(&state).into_iter().filter(|enemy| is_boss_actor(Some(enemy))) {
                if let Some(command) = plan_legendary_action_normalized(&state, &id_of(enemy))? {
                    bosses.push((id_of(enemy), command));
                }
            }
            let order = sorted_indices(bosses.len(), |left, right| compare_text(&bosses[left].0, &bosses[right].0));
            legendary = order.first().map(|index| bosses[*index].clone());
        }
        if let Some((boss_id, command)) = legendary {
            let suffix = format!("legendary-{}", key_part(&js::s(command.get("legendary_action_id"))));
            let key = scheduler_key(campaign_id, &state, &boss_id, &suffix, None);
            let recovery = Recovery { state: &state, actor_id: boss_id.clone(), suffix };
            let plan = commit_plan(&options, loaded.state_version, std::slice::from_ref(&command), &key, Some(&recovery))?;
            if duplicate_without_progress(loaded.state_version, &plan.committed) {
                return done(loaded.state, loaded.state_version, turns, events);
            }
            events.extend(plan.committed.commit.events.iter().cloned());
            let mut turn = Map::new();
            turn.insert("actor_id".into(), Value::String(boss_id));
            insert_present(&mut turn, "round", round);
            insert_present(&mut turn, "active_index", active_index);
            turn.insert("kind".into(), single("legendary-action"));
            turn.insert("commands".into(), json!(["UseLegendaryAction"]));
            turn.insert("tactic".into(), single("действует вне очереди"));
            insert_present(&mut turn, "target_id", command.get("target_id"));
            turn.insert("idempotency_key".into(), Value::String(plan.key));
            turn.insert("state_version".into(), Value::from(plan.committed.commit.state_version));
            turns.push(Value::Object(turn));
            loaded = options.journal.load(campaign_id)?;
            continue;
        }
        let capable = current.is_some_and(|current| is_combat_capable(&state, current));
        let enemy_turn = game::is_enemy_actor(&state, &current_id);
        if capable && !enemy_turn {
            return done(loaded.state, loaded.state_version, turns, events);
        }
        if capable && enemy_turn && !options.advance_npc {
            return done(loaded.state, loaded.state_version, turns, events);
        }
        let Some(current) = current else {
            return Err(SchedulerError::rule("INVALID_COMBAT_STATE", "Initiative references an unknown actor"));
        };
        let ordinary_enemy = capable && enemy_turn;
        let ordinary_commands = if ordinary_enemy { plan_npc_turn_normalized(&state, &current_id)? } else { vec![end_turn(&current_id)] };
        let ordinary_tactic = if ordinary_enemy {
            let candidates = target_candidates(&state, current)?;
            public_tactic_for(&state, current, candidates.first(), &ordinary_commands)
        } else {
            None
        };
        let decision = match options.npc_controller {
            Some(controller) if is_morale_moment(&state, &current_id) => controller.decide(&state, &current_id).await,
            _ => None,
        };
        let decision = decision.filter(|decision| js::truthy(Some(decision)));
        let mut commands = match &decision {
            Some(decision) => commands_for_morale_decision(&state, &current_id, Some(decision), ordinary_commands.clone()),
            None => ordinary_commands.clone(),
        };
        let economy = economy_of(&state, &current_id);
        let attack_phase = max2(0.0, number_or(get(economy, "attacks_used"), 0.0));
        let movement_phase = max2(0.0, number_or(get(economy, "movement_spent"), 0.0));
        let action_spent_phase = if js::is_false(get(economy, "action")) { 1 } else { 0 };
        let mut suffix = match &decision {
            Some(decision) => format!("morale-{}", js::string(decision.get("disposition"))),
            None if capable => format!("turn-a{}-m{}-s{action_spent_phase}", js::f64_string(attack_phase), js::f64_string(movement_phase)),
            None => "skip".into(),
        };
        let mut key = scheduler_key(campaign_id, &state, &current_id, &suffix, None);
        let mut cornered: Option<String> = None;
        let attempt = commit_plan(&options, loaded.state_version, &commands, &key, Some(&Recovery { state: &state, actor_id: current_id.clone(), suffix: suffix.clone() }));
        let plan = match attempt {
            Ok(plan) => plan,
            Err(error) => {
                let fights = decision.as_ref().is_some_and(|decision| type_is(decision.get("disposition"), "fight"));
                if decision.is_none() || !error.is_rules_validation() || fights {
                    return Err(error);
                }
                let code = error.code().unwrap_or("RULES_REJECTED");
                cornered = Some(code.chars().take(80).collect());
                commands = commands_for_morale_decision(&state, &current_id, Some(&json!({ "disposition": "fight" })), ordinary_commands.clone());
                suffix = "morale-cornered".into();
                key = scheduler_key(campaign_id, &state, &current_id, &suffix, None);
                commit_plan(&options, loaded.state_version, &commands, &key, Some(&Recovery { state: &state, actor_id: current_id.clone(), suffix: suffix.clone() }))?
            }
        };
        if duplicate_without_progress(loaded.state_version, &plan.committed) {
            return done(loaded.state, loaded.state_version, turns, events);
        }
        events.extend(plan.committed.commit.events.iter().cloned());
        let mut turn = Map::new();
        turn.insert("actor_id".into(), Value::String(current_id.clone()));
        insert_present(&mut turn, "round", round);
        insert_present(&mut turn, "active_index", active_index);
        turn.insert("kind".into(), single(if capable { "enemy-turn" } else { "skipped-defeated" }));
        turn.insert("commands".into(), Value::Array(commands.iter().map(|command| command.get("command_type").cloned().unwrap_or(Value::Null)).collect()));
        let creative = decision.as_ref().map(|decision| {
            let mut creative = Map::new();
            insert_present(&mut creative, "disposition", decision.get("disposition"));
            insert_present(&mut creative, "reaction", decision.get("reaction"));
            insert_present(&mut creative, "provider", decision.get("provider"));
            if let Some(rejected) = &cornered {
                creative.insert("rejected".into(), Value::String(rejected.clone()));
                creative.insert("applied".into(), single("fight"));
            }
            Value::Object(creative)
        });
        turn.insert("creative_decision".into(), creative.unwrap_or(Value::Null));
        let tactic: Option<Value> = if cornered.is_some() {
            let mut tactic = ordinary_tactic.as_ref().and_then(Value::as_object).cloned().unwrap_or_default();
            tactic.insert("tactic".into(), single("загнан в угол"));
            Some(Value::Object(tactic))
        } else if let Some(decision) = &decision {
            Some(json!({ "tactic": if type_is(decision.get("disposition"), "surrender") { "слом морали" } else { "пытается спастись" } }))
        } else {
            ordinary_tactic
        };
        if let Some(Value::Object(tactic)) = tactic {
            for (field, value) in tactic {
                turn.insert(field, value);
            }
        }
        turn.insert("idempotency_key".into(), Value::String(plan.key));
        turn.insert("state_version".into(), Value::from(plan.committed.commit.state_version));
        turns.push(Value::Object(turn));
        loaded = options.journal.load(campaign_id)?;
    }
    Err(SchedulerError::rule("NPC_TURN_LIMIT", format!("NPC scheduler exceeded {} turns", options.max_turns)))
}

/// Внутренние решения планировщика — для сверки с эталоном JS (кандидаты
/// целей и публичная тактика). В игре не используются.
#[doc(hidden)]
pub mod probe {
    use super::*;

    /// `targetCandidates(normalizeCampaignState(state), enemy)` в JSON.
    pub fn target_candidates_json(raw_state: &Value, enemy_id: &str) -> Result<Value, Halt> {
        let state = normalize_campaign_state(raw_state)?;
        let Some(enemy) = game::find_actor(&state, enemy_id) else { return Ok(Value::Null) };
        Ok(Value::Array(target_candidates(&state, enemy)?.iter().map(Candidate::to_json).collect()))
    }

    /// `publicTacticFor(state, enemy, targetCandidates(state, enemy)[0], commands)`.
    pub fn public_tactic_json(raw_state: &Value, enemy_id: &str, commands: &[Value]) -> Result<Value, Halt> {
        let state = normalize_campaign_state(raw_state)?;
        let Some(enemy) = game::find_actor(&state, enemy_id) else { return Ok(Value::Null) };
        let candidates = target_candidates(&state, enemy)?;
        Ok(public_tactic_for(&state, enemy, candidates.first(), commands).unwrap_or(Value::Null))
    }

    /// Ошибка `Fault` по имени — для тестов.
    pub fn fault(name: &str) -> Halt {
        Halt::Fault(Fault::new(name, name))
    }
}

//! Перенос `server/party-tactics.mjs`: тактика автономного героя — серверная
//! политика, а не решение модели.
//!
//! Три политики, все исполняются существующими typed-командами и проверяются
//! движком:
//! - [`plan_hero_turn`] — план целого хода (лечение зельем, удар вплотную,
//!   сосредоточение огня на самом раненом), всегда завершается `EndTurn`;
//! - [`plan_hero_reaction`] — ответ на **уже открытое** движком окно реакции
//!   по закрытому списку предпочтений;
//! - [`plan_hero_combat_command`] — одна команда шага боевого стенда:
//!   кандидаты (зелье, заклинания, действия, удары, подход) проверяются
//!   `validateCommand` на технической копии состояния и ранжируются.
//!
//! Случайности нет: то же состояние даёт тот же план. Порядок перебора
//! кандидатов и разрешение ничьих — как в JS; сортировки с компаратором —
//! только [`sk_core::v8sort::sort_by`]. Ошибки, которые JS бросил бы наружу
//! (`TypeError` на мусоре, отказ прогноза удара), возвращаются как [`Halt`].

use std::cell::OnceCell;
use std::cmp::Ordering;

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexMap;
use sk_core::{game, js, text, v8sort};
use sk_geometry::actor_footprint::{footprint_cells_for, footprint_distance_feet};
use sk_geometry::Point;
use sk_rules::areas::shape::spell_targets_at;
use sk_rules::combat::weapons::{attack_profile_for, weapon_attack_profile_for, AttackOptions};
use sk_rules::context::Context;
use sk_rules::geometry::movement::movement_for_actor;
use sk_rules::geometry::terrain::movement_cost_of_path;
use sk_rules::pause::{Fault, Halt};
use sk_rules::preview_attack::{attack_forecast, ForecastOptions};
use sk_rules::speed::effective_speed_feet;
use sk_rules::spells::slots::spell_damage_estimate;
use sk_rules::tactical_geometry::{actor_point, key, occupied_positions, point_json, shortest_tactical_path, KeySet, PathOptions};

/// Доля максимума ОЗ, ниже которой союзник считается тяжело раненным.
pub const HEAL_THRESHOLD_RATIO: f64 = 0.35;
/// Профиль лечебного предмета из `server/item-lifecycle.mjs`.
const HEALING_CATALOG_ID: &str = "srd_5_2_1:potion-of-healing";
const HEALING_RANGE_FEET: f64 = 5.0;

/// Доля максимума ОЗ (в процентах), начиная с которой удар стоит
/// «Невероятного уклонения». Сравнение целыми — ровно четверть не зависит от
/// двоичного представления `0.25`.
pub const UNCANNY_DODGE_DAMAGE_PERCENT: f64 = 25.0;

/// Порядок предпочтений автономного героя в открытом окне реакции; всё, чего
/// в списке нет, окно закрывает отказом.
pub const AUTONOMOUS_REACTION_PRIORITY: [&str; 6] = ["opportunity-attack", "fighter-zaschita", "paladin-zaschita", "bard-kollegiya-znaniy-ostroe-slovtso", "cast:shield", "uncanny-dodge"];

const COMBAT_POLICY_SUPPORT: [&str; 2] = ["verified", "partial"];
const DAMAGE_SPELL_KINDS: [&str; 6] = ["attack", "damage", "save", "debuff", "area-save", "area-damage"];
const EXTINGUISHABLE_FLAME_CONDITIONS: [&str; 2] = ["searing-smite-flames", "alchemists-fire-flames"];
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// План хода: сработавшее правило и typed-команды.
#[derive(Debug, Clone, PartialEq)]
pub struct TacticPlan {
    pub rule: String,
    pub commands: Vec<Value>,
}

impl TacticPlan {
    /// `{ rule, commands }` в форме JS.
    pub fn to_json(&self) -> Value {
        json!({ "rule": self.rule, "commands": self.commands })
    }
}

/// Одна команда боевого шага и её объяснение.
#[derive(Debug, Clone, PartialEq)]
pub struct CombatStep {
    pub command: Value,
    pub reason: String,
}

impl CombatStep {
    /// `{ command, reason }` в форме JS.
    pub fn to_json(&self) -> Value {
        json!({ "command": self.command, "reason": self.reason })
    }
}

// --- приведения и чтение состояния ---------------------------------------------------

fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(Value::as_object).and_then(|map| map.get(key))
}

fn path<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().try_fold(value, |current, key| current.as_object().and_then(|map| map.get(*key)))
}

/// `a ?? b`: первое значение, не равное `undefined`/`null`, иначе последнее.
fn nullish<'a>(values: &[Option<&'a Value>]) -> Option<&'a Value> {
    values.iter().copied().find(|value| js::present(*value)).unwrap_or_else(|| values.last().copied().flatten())
}

fn type_error(message: &str) -> Halt {
    Halt::Fault(Fault::type_error(message))
}

/// `(value ?? [])` перед методом массива: не массив и не `undefined`/`null` —
/// `TypeError` (`x.filter is not a function`).
fn list(value: Option<&Value>) -> Result<&[Value], Halt> {
    match value {
        None | Some(Value::Null) => Ok(&[]),
        Some(Value::Array(items)) => Ok(items.as_slice()),
        Some(_) => Err(type_error("value.filter is not a function")),
    }
}

/// `Math.max(a, b)` и `Math.min(a, b)` с заразным `NaN`.
fn max2(a: f64, b: f64) -> f64 {
    js::max_of([a, b])
}

fn min2(a: f64, b: f64) -> f64 {
    js::min_of([a, b])
}

/// `Number(x) || fallback`.
fn number_or(value: Option<&Value>, fallback: f64) -> f64 {
    let number = js::number(value);
    if number.is_nan() || number == 0.0 {
        fallback
    } else {
        number
    }
}

fn ordering(order: Ordering) -> f64 {
    match order {
        Ordering::Less => -1.0,
        Ordering::Equal => 0.0,
        Ordering::Greater => 1.0,
    }
}

/// `left.localeCompare(right)` числом JS.
fn compare_text(left: &str, right: &str) -> f64 {
    ordering(text::locale_compare(left, right))
}

/// `a || b` для ответа сравнителя: `0` и `NaN` уступают следующему.
fn or_else(first: f64, next: impl FnOnce() -> f64) -> f64 {
    if first == 0.0 || first.is_nan() {
        next()
    } else {
        first
    }
}

fn sorted<'a>(mut items: Vec<&'a Value>, compare: impl FnMut(&&'a Value, &&'a Value) -> f64) -> Vec<&'a Value> {
    v8sort::sort_by(&mut items, compare);
    items
}

/// `idOf(actor)` и `combatId(actor)`: `String(actor?.id ?? actor?.actor_id ?? '')`.
fn id_of(actor: &Value) -> String {
    game::actor_id(actor)
}

fn combat_id(actor: &Value) -> String {
    game::actor_id(actor)
}

/// `Number(actor?.hp ?? actor?.hitPoints ?? 0) || 0`.
fn hp_of(actor: &Value) -> f64 {
    let raw = nullish(&[get(Some(actor), "hp"), get(Some(actor), "hitPoints")]);
    if js::present(raw) {
        number_or(raw, 0.0)
    } else {
        0.0
    }
}

/// `Math.max(1, Number(actor?.maxHp ?? actor?.max_hp ?? 0) || 1)`.
fn max_hp_of(actor: Option<&Value>) -> f64 {
    let raw = nullish(&[get(actor, "maxHp"), get(actor, "max_hp")]);
    let number = if js::present(raw) { number_or(raw, 1.0) } else { 1.0 };
    max2(1.0, number)
}

/// `Number.isFinite(Number(actor?.hp)) ? Number(actor.hp) : null`.
fn combat_hp(actor: &Value) -> Option<f64> {
    let number = js::number(get(Some(actor), "hp"));
    number.is_finite().then_some(number)
}

/// `Math.max(1, Number(actor?.maxHp ?? actor?.max_hp) || 1)`.
fn combat_max_hp(actor: Option<&Value>) -> f64 {
    max2(1.0, number_or(nullish(&[get(actor, "maxHp"), get(actor, "max_hp")]), 1.0))
}

fn actor_hp_number(actor: &Value) -> f64 {
    js::number(get(Some(actor), "hp"))
}

/// `actorDistanceFeet(state, leftId, rightId, leftPosition, rightPosition)`:
/// `None` позиции — `null` в JS, площадь берётся по полям самой карточки.
fn actor_distance_feet(state: &Value, left_id: &str, right_id: &str, left: Option<Point>, right: Option<Point>) -> f64 {
    let left_anchor = left.map(point_json);
    let right_anchor = right.map(point_json);
    footprint_distance_feet(game::find_actor(state, left_id), game::find_actor(state, right_id), left_anchor.as_ref(), right_anchor.as_ref()).unwrap_or(f64::INFINITY)
}

fn combat_distance(state: &Value, left_id: &str, right_id: &str) -> f64 {
    actor_distance_feet(state, left_id, right_id, actor_point(state, left_id), actor_point(state, right_id))
}

/// Герой мёртв окончательно — лечить его нельзя.
fn is_dead_hero(state: &Value, hero_id: &str) -> bool {
    path(state, &["mechanics", "death", "heroes"]).and_then(|heroes| get(Some(heroes), hero_id)).and_then(|hero| get(Some(hero), "status")).and_then(Value::as_str) == Some("dead")
}

fn healing_item(actor: &Value) -> Result<Option<&Value>, Halt> {
    Ok(list(get(Some(actor), "inventory"))?.iter().find(|item| {
        js::s(nullish(&[get(Some(item), "catalog_id"), get(Some(item), "catalogId")])) == HEALING_CATALOG_ID && quantity(item) > 0.0
    }))
}

/// `Number(item?.quantity ?? 1)`.
fn quantity(item: &Value) -> f64 {
    match get(Some(item), "quantity").filter(|value| !value.is_null()) {
        Some(value) => js::number(Some(value)),
        None => 1.0,
    }
}

fn equipped_weapon(actor: Option<&Value>) -> Result<Option<&Value>, Halt> {
    Ok(list(get(actor, "inventory"))?.iter().find(|item| {
        get(Some(item), "type").and_then(Value::as_str) == Some("weapon")
            && js::is_true(get(Some(item), "equipped"))
            && quantity(item) > 0.0
            && matches!(js::s(get(get(Some(item), "combat"), "kind")).as_str(), "melee" | "ranged")
    }))
}

/// `new Set((state?.mechanics?.conditions?.[id] ?? []).map((c) => String(c?.id ?? c)))`.
fn condition_ids(state: &Value, actor_id: &str) -> Result<Vec<String>, Halt> {
    let conditions = path(state, &["mechanics", "conditions"]).and_then(|map| get(Some(map), actor_id));
    let mut ids: Vec<String> = Vec::new();
    for condition in list(conditions)? {
        let id = js::string(nullish(&[get(Some(condition), "id"), Some(condition)]));
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    Ok(ids)
}

fn has(ids: &[String], id: &str) -> bool {
    ids.iter().any(|known| known == id)
}

/// Ид участников отряда: `partyMemberIds`, если он не пуст, иначе все герои.
fn party_ids(state: &Value) -> Result<Vec<String>, Halt> {
    let members = state.get("partyMemberIds");
    let length_truthy = match members {
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Object(map)) => js::truthy(map.get("length")),
        _ => false,
    };
    if length_truthy {
        let Some(Value::Array(items)) = members else { return Err(type_error("partyMemberIds.map is not a function")) };
        return Ok(items.iter().map(|id| js::string(Some(id))).collect());
    }
    Ok(list(state.get("players"))?.iter().map(id_of).collect())
}

/// `partyActorsForTactics(state)`.
fn party_actors(state: &Value) -> Result<Vec<&Value>, Halt> {
    let ids = party_ids(state)?;
    Ok(list(state.get("players"))?.iter().filter(|actor| has(&ids, &combat_id(actor))).collect())
}

fn visible_living_enemy(actor: &Value) -> bool {
    js::truthy(Some(actor)) && !js::is_false(get(Some(actor), "alive")) && (!js::present(get(Some(actor), "hp")) || actor_hp_number(actor) > 0.0)
}

fn visible_living_ally(actor: &Value) -> bool {
    js::truthy(Some(actor)) && !js::is_false(get(Some(actor), "alive")) && actor_hp_number(actor) > 0.0
}

fn downed_ally(actor: &Value) -> bool {
    js::truthy(Some(actor)) && !js::is_false(get(Some(actor), "alive")) && actor_hp_number(actor) <= 0.0
}

fn enemies_for_tactics(state: &Value) -> Result<Vec<&Value>, Halt> {
    Ok(list(state.get("enemies"))?.iter().filter(|actor| visible_living_enemy(actor)).collect())
}

fn economy_for<'a>(state: &'a Value, actor_id: &str) -> Option<&'a Value> {
    path(state, &["mechanics", "combat", "action_economy"]).and_then(|map| get(Some(map), actor_id))
}

fn attack_available(economy: Option<&Value>) -> bool {
    let used = js::number(get(economy, "attacks_used"));
    !js::is_false(get(economy, "action")) || used > 0.0 && used < js::number(get(economy, "attacks_allowed"))
}

fn resource_for<'a>(state: &'a Value, actor_id: &str, resource: &str) -> Option<&'a Value> {
    path(state, &["mechanics", "resources"]).and_then(|map| get(Some(map), actor_id)).and_then(|map| get(Some(map), resource)).filter(|value| !value.is_null())
}

// --- лечение -------------------------------------------------------------------------

/// `healingTargetFor(state, actorId)`: кого лечить — сначала упавшие, затем
/// тяжело раненные; внутри группы меньшие ОЗ вперёд, при равенстве — ид.
pub fn healing_target_for(state: &Value, _actor_id: &str) -> Result<Option<Value>, Halt> {
    let ids = party_ids(state)?;
    let candidates: Vec<&Value> = list(state.get("players"))?
        .iter()
        .filter(|player| has(&ids, &id_of(player)) && !is_dead_hero(state, &id_of(player)))
        .filter(|player| hp_of(player) <= 0.0 || hp_of(player) <= max2(1.0, (max_hp_of(Some(player)) * HEAL_THRESHOLD_RATIO).floor()))
        .collect();
    if candidates.is_empty() {
        return Ok(None);
    }
    let ranked = sorted(candidates, |left, right| {
        let downed = f64::from(u8::from(hp_of(left) > 0.0)) - f64::from(u8::from(hp_of(right) > 0.0));
        if downed != 0.0 {
            return downed;
        }
        or_else(hp_of(left) - hp_of(right), || compare_text(&id_of(left), &id_of(right)))
    });
    Ok(ranked.first().map(|actor| (*actor).clone()))
}

// --- план хода -----------------------------------------------------------------------

fn movement_remaining(state: &Value, actor_id: &str) -> f64 {
    js::number(movement_for_actor(state, actor_id).get("movement_remaining"))
}

/// `approachCommands`: дойти до цели, остановившись на `keep` футов раньше.
fn approach_commands(state: &Value, actor_id: &str, target_id: &str, keep_distance_feet: f64, planned_movement_feet: f64) -> (Vec<Value>, Option<Point>) {
    let to = actor_point(state, target_id);
    let route = to.and_then(|to| shortest_tactical_path(state, actor_id, to, PathOptions { allow_occupied_destination: true, ..PathOptions::default() }));
    let keep_cells = max2(0.0, (keep_distance_feet / 5.0).floor());
    let planned = if planned_movement_feet.is_nan() { 0.0 } else { planned_movement_feet };
    let available = movement_remaining(state, actor_id) - max2(0.0, planned);
    // `stepsWithinSpeed`.
    let budget = max2(0.0, (max2(0.0, available) / 5.0).floor());
    let needed = max2(0.0, route.as_ref().map_or(0.0, |route| route.len() as f64) - keep_cells);
    let steps = min2(needed, budget);
    let step = route.as_ref().and_then(|route| {
        let index = steps - 1.0;
        (index >= 0.0 && index.fract() == 0.0).then(|| route.get(index as usize).copied()).flatten()
    });
    match step {
        Some(step) if steps > 0.0 => (vec![json!({ "command_type": "MoveActor", "actor_id": actor_id, "to": point_json(step) })], Some(step)),
        _ => (Vec::new(), actor_point(state, actor_id)),
    }
}

fn stand_up_plan(state: &Value, actor_id: &str, actor: &Value) -> Result<(Vec<Value>, f64), Halt> {
    let conditions = path(state, &["mechanics", "conditions"]).and_then(|map| get(Some(map), actor_id));
    let prone = list(conditions)?.iter().any(|condition| js::string(nullish(&[get(Some(condition), "id"), Some(condition)])) == "prone");
    if !prone {
        return Ok((Vec::new(), 0.0));
    }
    let speed = effective_speed_feet(state, actor, actor_id) as f64;
    let movement_cost = (speed / 2.0).ceil();
    let available = movement_remaining(state, actor_id);
    if speed == 0.0 || available < movement_cost {
        return Ok((Vec::new(), 0.0));
    }
    Ok((vec![json!({ "command_type": "UseCombatAction", "actor_id": actor_id, "action_id": "stand-up" })], movement_cost))
}

/// `planHeroTurn(state, actorId)`: план хода автономного героя, всегда
/// завершающийся `EndTurn`; `rule` — какое правило сработало.
pub fn plan_hero_turn(state: &Value, actor_id: &str) -> Result<TacticPlan, Halt> {
    let actor = game::find_actor(state, actor_id);
    let living: Vec<&Value> = list(state.get("enemies"))?.iter().filter(|enemy| game::is_living_actor(enemy)).collect();
    let end = json!({ "command_type": "EndTurn", "actor_id": actor_id });
    let plan = |rule: &str, commands: Vec<Value>| TacticPlan { rule: rule.into(), commands };
    let Some(actor) = actor.filter(|_| !living.is_empty()) else { return Ok(plan("end-turn", vec![end])) };

    let from = actor_point(state, actor_id);
    let (standing, standing_cost) = stand_up_plan(state, actor_id, actor)?;
    let with_standing = |commands: Vec<Value>, end: &Value| {
        let mut all = standing.clone();
        all.extend(commands);
        all.push(end.clone());
        all
    };

    // 1. Упавший или тяжело раненный союзник важнее ещё одного удара.
    let potion = healing_item(actor)?;
    let wounded = match potion {
        Some(_) => healing_target_for(state, actor_id)?,
        None => None,
    };
    if let (Some(potion), Some(wounded)) = (potion, wounded) {
        let ally_id = id_of(&wounded);
        let mut commands = Vec::new();
        let mut position = from;
        if actor_distance_feet(state, actor_id, &ally_id, position, actor_point(state, &ally_id)) > HEALING_RANGE_FEET && ally_id != actor_id {
            let (moves, at) = approach_commands(state, actor_id, &ally_id, HEALING_RANGE_FEET, standing_cost);
            commands.extend(moves);
            position = at;
        }
        if ally_id == actor_id || actor_distance_feet(state, actor_id, &ally_id, position, actor_point(state, &ally_id)) <= HEALING_RANGE_FEET {
            commands.push(json!({ "command_type": "UseItem", "actor_id": actor_id, "item_id": js::string(get(Some(potion), "id")), "target_id": ally_id }));
            let rule = if ally_id == actor_id { "heal-self" } else { "heal-ally" };
            return Ok(plan(rule, with_standing(commands, &end)));
        }
        // Дойти не успели — ход не пропадает: ниже отработает обычная атака.
    }

    let Some(profile) = attack_profile_for(state, actor_id, None)? else {
        return Ok(plan("no-attack-profile", with_standing(Vec::new(), &end)));
    };
    let weapon = equipped_weapon(Some(actor))?;
    let weapon_id = weapon.map(|weapon| js::string(get(Some(weapon), "id")));
    let weapon_profile = weapon_id.as_ref().and_then(|id| weapon_attack_profile_for(state, actor_id, Some(&Value::String(id.clone())), AttackOptions::default()));
    // Порог — обычная дальность оружия по тому же профилю, что соберёт движок.
    let attack_range = js::number(nullish(&[get(weapon_profile.as_ref(), "normal_range_feet"), profile.get("range_feet")]));
    let attack_command = |target_id: &str| {
        let mut command = Map::new();
        command.insert("command_type".into(), Value::String("MakeAttack".into()));
        command.insert("actor_id".into(), Value::String(actor_id.into()));
        command.insert("target_id".into(), Value::String(target_id.into()));
        if weapon_profile.is_some() {
            if let Some(id) = &weapon_id {
                command.insert("item_id".into(), Value::String(id.clone()));
            }
        }
        command.insert("server_authoritative".into(), Value::Bool(true));
        Value::Object(command)
    };
    let by_hp = |left: &&Value, right: &&Value| or_else(hp_of(left) - hp_of(right), || compare_text(&id_of(left), &id_of(right)));

    // 2. Противник вплотную бьётся здесь и сейчас.
    let adjacent = sorted(living.iter().copied().filter(|enemy| actor_distance_feet(state, actor_id, &id_of(enemy), from, actor_point(state, &id_of(enemy))) <= HEALING_RANGE_FEET).collect(), by_hp);
    if let Some(adjacent) = adjacent.first() {
        return Ok(plan("attack-adjacent", with_standing(vec![attack_command(&id_of(adjacent))], &end)));
    }

    // 3. Иначе — сосредоточение огня на самом раненом противнике.
    let ranked = sorted(living.clone(), by_hp);
    let target_id = ranked.first().map(|target| id_of(target)).unwrap_or_default();
    let mut commands = Vec::new();
    let mut position = from;
    if actor_distance_feet(state, actor_id, &target_id, position, actor_point(state, &target_id)) > attack_range {
        let (moves, at) = approach_commands(state, actor_id, &target_id, attack_range, standing_cost);
        commands.extend(moves);
        position = at;
    }
    if actor_distance_feet(state, actor_id, &target_id, position, actor_point(state, &target_id)) <= attack_range {
        commands.push(attack_command(&target_id));
        let rule = if commands.len() > 1 { "close-and-attack" } else { "attack-focus" };
        return Ok(plan(rule, with_standing(commands, &end)));
    }
    Ok(plan("advance", with_standing(commands, &end)))
}

// --- реакции -------------------------------------------------------------------------

/// Сколько ОЗ снял удар, открывший окно: обычный урон плюс съеденный временный.
fn reaction_damage_taken(window: Option<&Value>) -> f64 {
    let damage = get(window, "damage");
    if !js::truthy(damage) || !matches!(damage, Some(Value::Object(_)) | Some(Value::Array(_))) {
        return 0.0;
    }
    max2(0.0, number_or(get(damage, "applied_amount"), 0.0)) + max2(0.0, number_or(get(damage, "temporary_hp_absorbed"), 0.0))
}

fn reaction_damage_pending(window: Option<&Value>) -> bool {
    let trigger = js::s(get(window, "trigger"));
    let damage = get(window, "damage");
    (trigger == "attack-shield-choice" || trigger == "attack-protective-choice")
        && js::truthy(damage)
        && matches!(damage, Some(Value::Object(_)) | Some(Value::Array(_)))
        && !js::present(get(damage, "applied_amount"))
}

fn offered_ids(window: Option<&Value>) -> Vec<String> {
    match get(window, "action_ids") {
        Some(Value::Array(ids)) => ids.iter().map(|id| js::string(Some(id))).collect(),
        _ => Vec::new(),
    }
}

/// `planHeroReaction(state, reactionWindow)`: ответ на уже открытое окно
/// реакции по [`AUTONOMOUS_REACTION_PRIORITY`]; `None` окна — текущее окно
/// состояния.
pub fn plan_hero_reaction(state: &Value, reaction_window: Option<&Value>) -> TacticPlan {
    let window = match reaction_window.filter(|value| !value.is_null()) {
        Some(window) => Some(window),
        None => path(state, &["mechanics", "combat", "reaction_window"]).filter(|value| !value.is_null()),
    };
    let actor_id = js::s(get(window, "actor_id"));
    let command = |action_id: &str| {
        let mut command = Map::new();
        command.insert("command_type".into(), Value::String("UseCombatAction".into()));
        command.insert("actor_id".into(), Value::String(actor_id.clone()));
        command.insert("action_id".into(), Value::String(action_id.into()));
        if action_id != "decline-reaction" {
            command.insert("target_id".into(), Value::String(js::s(get(window, "source_actor_id"))));
        }
        command.insert("server_authoritative".into(), Value::Bool(true));
        Value::Object(command)
    };
    let decline = TacticPlan { rule: "decline-reaction".into(), commands: vec![command("decline-reaction")] };
    if !js::truthy(window) || actor_id.is_empty() {
        return decline;
    }
    let offered = offered_ids(window);
    let damage_pending = reaction_damage_pending(window);
    let chosen = AUTONOMOUS_REACTION_PRIORITY.iter().find(|action_id| {
        if !has(&offered, action_id) {
            return false;
        }
        if **action_id != "uncanny-dodge" {
            return true;
        }
        let actor = game::find_actor(state, &actor_id);
        damage_pending || reaction_damage_taken(window) * 100.0 >= max_hp_of(actor) * UNCANNY_DODGE_DAMAGE_PERCENT
    });
    match chosen {
        Some(action_id) => TacticPlan { rule: (*action_id).into(), commands: vec![command(action_id)] },
        None => decline,
    }
}

// --- проверка кандидатов движком -----------------------------------------------------

/// `{ ...value }` для произвольного значения JSON.
fn spread_any(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map.clone(),
        Value::Array(items) => items.iter().enumerate().map(|(index, item)| (index.to_string(), item.clone())).collect(),
        Value::String(text) => text.chars().enumerate().map(|(index, ch)| (index.to_string(), Value::String(ch.to_string()))).collect(),
        _ => Map::new(),
    }
}

/// `cloneForTacticValidation(state)`: техническая копия, где клетки сцены
/// раскрыты, а у видимых живых врагов без хитов — один технический хит.
fn clone_for_tactic_validation(state: &Value) -> Result<Value, Halt> {
    let mut clone = state.clone();
    if let Some(Value::Array(cells)) = clone.get_mut("scene").and_then(|scene| scene.get_mut("cells")) {
        for cell in cells.iter_mut() {
            if get(Some(cell), "revealed") == Some(&Value::Bool(false)) {
                continue;
            }
            let mut map = spread_any(cell);
            map.insert("revealed".into(), Value::Bool(true));
            *cell = Value::Object(map);
        }
    }
    let enemies = list(clone.get("enemies"))?.to_vec();
    let mut mapped = Vec::with_capacity(enemies.len());
    for enemy in enemies {
        if js::is_false(get(Some(&enemy), "alive")) || js::present(get(Some(&enemy), "hp")) {
            mapped.push(enemy);
            continue;
        }
        if enemy.is_null() {
            return Err(type_error("Cannot read properties of null (reading 'maxHp')"));
        }
        let max_hp = max2(1.0, number_or(Some(get(Some(&enemy), "maxHp").filter(|value| !value.is_null()).unwrap_or(&Value::from(1))), 1.0));
        let mut map = spread_any(&enemy);
        map.insert("hp".into(), Value::from(1));
        map.insert("maxHp".into(), js::num(max_hp));
        map.insert("alive".into(), Value::Bool(true));
        mapped.push(Value::Object(map));
    }
    if let Value::Object(root) = &mut clone {
        root.insert("enemies".into(), Value::Array(mapped));
    }
    Ok(clone)
}

/// Контекст одного решения: исходное состояние и (лениво) техническая копия
/// для `validateCommand` — она одна и та же для всех кандидатов шага.
///
/// JS на каждый кандидат заново клонирует и нормализует копию
/// (`validateCommand` → `normalizeCampaignState`). Нормализация детерминирована
/// и входа не меняет, поэтому здесь копия нормализуется один раз, а кандидат
/// проверяется `validate_normalized` — те же блоки проверки в том же порядке.
/// Ошибка нормализации, как и в JS, отклоняет любой кандидат.
struct Tactics<'a> {
    state: &'a Value,
    validation: OnceCell<Result<Value, Halt>>,
    normalized: OnceCell<Option<Value>>,
}

impl<'a> Tactics<'a> {
    fn new(state: &'a Value) -> Self {
        Self { state, validation: OnceCell::new(), normalized: OnceCell::new() }
    }

    fn validation_state(&self) -> Result<&Value, Halt> {
        self.validation.get_or_init(|| clone_for_tactic_validation(self.state)).as_ref().map_err(Clone::clone)
    }

    fn normalized_state(&self) -> Option<&Value> {
        self.normalized
            .get_or_init(|| self.validation_state().ok().and_then(|validation| sk_rules::normalize::normalize_campaign_state(validation).ok()))
            .as_ref()
    }

    /// `validatesTacticCommand(state, actorId, command)`: любая ошибка — `false`.
    fn validates(&self, actor_id: &str, command: &Value) -> bool {
        let Some(normalized) = self.normalized_state() else { return false };
        let mut input = spread_any(command);
        input.insert("actor_id".into(), Value::String(actor_id.into()));
        input.insert("server_authoritative".into(), Value::Bool(true));
        let context = Context::from_json(&json!({ "serverAuthoritativeCombat": true, "allowedActorIds": [actor_id] }));
        let mut counter = 0u64;
        let mut uuid = move || {
            counter += 1;
            format!("tactics-{counter}")
        };
        sk_rules::validate::validate_normalized(&Value::Object(input), normalized, &context, &mut uuid).is_ok()
    }
}

/// `commandWithTarget(actorId, command)`: `{ ...command, actor_id, server_authoritative: true }`.
fn command_with_target(actor_id: &str, command: Value) -> Value {
    let mut map = spread_any(&command);
    map.insert("actor_id".into(), Value::String(actor_id.into()));
    map.insert("server_authoritative".into(), Value::Bool(true));
    Value::Object(map)
}

fn reaction_command_for_tactics(window: Option<&Value>, action_id: &str, actor_id: &str, extra: Option<(&str, Value)>) -> Value {
    let mut command = Map::new();
    command.insert("command_type".into(), Value::String("UseCombatAction".into()));
    command.insert("actor_id".into(), Value::String(actor_id.into()));
    command.insert("action_id".into(), Value::String(action_id.into()));
    command.insert("server_authoritative".into(), Value::Bool(true));
    if let Some((key, value)) = extra {
        command.insert(key.into(), value);
    }
    let source = get(window, "source_actor_id");
    if action_id != "decline-reaction" && !command.contains_key("target_id") && js::truthy(source) {
        command.insert("target_id".into(), Value::String(js::string(source)));
    }
    Value::Object(command)
}

fn plan_expanded_combat_reaction(tactics: &Tactics<'_>, window: &Value) -> Result<Option<CombatStep>, Halt> {
    let state = tactics.state;
    let window = Some(window);
    let actor_id = js::s(get(window, "actor_id"));
    let offered = offered_ids(window);
    if actor_id.is_empty() || offered.is_empty() {
        return Ok(None);
    }
    let damage = reaction_damage_taken(window);
    let damage_pending = reaction_damage_pending(window);
    let damage_type = text::lower(&js::s(get(get(window, "damage"), "damage_type")));
    let elemental = matches!(damage_type.as_str(), "acid" | "cold" | "fire" | "lightning" | "thunder");
    let trigger = js::s(get(window, "trigger"));
    let trigger_roll = get(window, "trigger_roll").filter(|value| !value.is_null());
    let actor = game::find_actor(state, &actor_id);
    let choose = |action_id: &str, reason: String, extra: Option<(&str, Value)>| -> Option<CombatStep> {
        if !has(&offered, action_id) {
            return None;
        }
        let command = reaction_command_for_tactics(window, action_id, &actor_id, extra);
        tactics.validates(&actor_id, &command).then_some(CombatStep { command, reason })
    };

    // Сначала предотвращаем вражеское заклинание, затем сохраняем проваленный спасбросок.
    if let Some(plan) = choose("cast:counterspell", "Прервать вражеское заклинание Контрзаклинанием".into(), None) {
        return Ok(Some(plan));
    }
    if let Some(plan) = choose("indomitable", "Перебросить проваленный спасбросок Несгибаемостью".into(), None) {
        return Ok(Some(plan));
    }
    // Щит отменяет весь удар; ответный удар разумен только после промаха.
    if let Some(plan) = choose("cast:shield", "Отменить попавший удар реакцией «Щит»".into(), None) {
        return Ok(Some(plan));
    }
    if elemental && (damage > 0.0 || damage_pending) {
        if let Some(plan) = choose("cast:absorb-elements", format!("Снизить {damage_type}-урон «Поглощением стихий»"), None) {
            return Ok(Some(plan));
        }
    }
    if damage_pending {
        if let Some(plan) = choose("uncanny-dodge", "Снизить ещё не разрешённый удар Невероятным уклонением".into(), None) {
            return Ok(Some(plan));
        }
    }
    if damage > 0.0 && damage * 100.0 >= max2(1.0, combat_max_hp(actor)) * 10.0 {
        if let Some(plan) = choose("parry", "Снизить крупный удар Парированием".into(), None) {
            return Ok(Some(plan));
        }
    }
    if damage > 0.0 {
        if let Some(plan) = choose("cast:hellish-rebuke", "Ответить на полученный удар Адским возмездием".into(), None) {
            return Ok(Some(plan));
        }
    }
    if trigger == "attack-missed" || get(trigger_roll, "hit") == Some(&Value::Bool(false)) {
        if let Some(plan) = choose("riposte", "Ответить на промах противника Ответным ударом".into(), None) {
            return Ok(Some(plan));
        }
    }

    if has(&offered, "cast:silvery-barbs") {
        let ally = party_actors(state)?.into_iter().find(|candidate| visible_living_ally(candidate) && combat_distance(state, &actor_id, &combat_id(candidate)) <= 60.0);
        if let Some(ally) = ally {
            if let Some(plan) = choose("cast:silvery-barbs", "Перебросить удачный бросок Искусной остротой".into(), Some(("beneficiary_id", Value::String(combat_id(ally))))) {
                return Ok(Some(plan));
            }
        }
    }

    for (action_id, reason) in [("readied-spell", "Выпустить заготовленное заклинание"), ("readied-attack", "Выполнить заготовленный удар"), ("opportunity-attack", "Провести атаку по возможности")] {
        if let Some(plan) = choose(action_id, reason.into(), None) {
            return Ok(Some(plan));
        }
    }

    // Прежний порог «Невероятного уклонения» и прежний отказ для обычных окон.
    let old = plan_hero_reaction(state, window);
    Ok(old.commands.first().filter(|command| tactics.validates(&actor_id, command)).map(|command| CombatStep { command: command.clone(), reason: format!("Реакция: {}", old.rule) }))
}

// --- кандидаты боевого шага ----------------------------------------------------------

struct Candidate {
    command: Value,
    score: f64,
    reason: String,
}

struct Candidates<'t, 'a> {
    tactics: &'t Tactics<'a>,
    actor_id: String,
    list: Vec<Candidate>,
}

impl Candidates<'_, '_> {
    /// `add(command, score, reason, validated)`.
    fn add(&mut self, command: Value, score: f64, reason: String, validated: bool) {
        if !validated && !self.tactics.validates(&self.actor_id, &command) {
            return;
        }
        self.list.push(Candidate { command, score, reason });
    }
}

fn action_resource_available(state: &Value, actor_id: &str, action: &Value) -> bool {
    let resource_key = action.get("resource");
    if !js::truthy(resource_key) {
        return true;
    }
    let resource = resource_for(state, actor_id, &js::string(resource_key));
    js::truthy(resource) && js::number(get(resource, "current")) >= max2(1.0, number_or(action.get("cost"), 1.0))
}

/// Ячейка заклинания: ресурс и круг (`None` — заговор без ячейки).
struct Slot {
    level: Value,
}

fn spell_slots_for_tactics(state: &Value, actor_id: &str, actor: &Value, spell: &Value) -> Vec<Option<Slot>> {
    let level = js::number(spell.get("level"));
    if level <= 0.0 {
        return vec![None];
    }
    let slot_resource = spell.get("slotResource");
    let fixed_kind = matches!(slot_resource.and_then(Value::as_str), Some("pact_slots") | Some("mystic_arcanum_6")) || js::s(slot_resource).starts_with("species_spell_");
    if fixed_kind {
        let resource = resource_for(state, actor_id, &js::string(slot_resource));
        let fixed = sk_combat_content::combat_spells::fixed_spell_slot_level_for(Some(actor), Some(spell)).filter(|value| !value.is_null());
        let level = fixed.unwrap_or_else(|| js::num(max2(level, number_or(spell.get("innateCastLevel"), level))));
        return if js::number(get(resource, "current")) > 0.0 { vec![Some(Slot { level })] } else { Vec::new() };
    }
    let mut slots = Vec::new();
    let mut circle = max2(1.0, number_or(spell.get("level"), 1.0));
    while circle <= 6.0 {
        let resource = format!("spell_slots_{}", js::f64_string(circle));
        if js::number(get(resource_for(state, actor_id, &resource), "current")) > 0.0 {
            slots.push(Some(Slot { level: js::num(circle) }));
        }
        circle += 1.0;
    }
    slots
}

/// `new Set(spell.conditions.map(String))` пересекается с состояниями цели.
fn has_spell_condition(state: &Value, target_id: &str, spell: &Value) -> Result<bool, Halt> {
    let conditions: Vec<String> = list(spell.get("conditions"))?.iter().map(|condition| js::string(Some(condition))).collect();
    if conditions.is_empty() {
        return Ok(false);
    }
    let target = condition_ids(state, target_id)?;
    Ok(conditions.iter().any(|condition| has(&target, condition)))
}

struct AreaTargets {
    enemies: usize,
    allies: usize,
}

fn area_targets_for_tactics(validation: &Value, actor_id: &str, spell: &Value, to: Value) -> Result<AreaTargets, Halt> {
    let enemies: Vec<String> = enemies_for_tactics(validation)?.into_iter().map(combat_id).collect();
    let affected = spell_targets_at(validation, &json!({ "actor_id": actor_id, "to": to }), spell);
    let hostile = affected.iter().filter(|actor| has(&enemies, &combat_id(actor))).count();
    Ok(AreaTargets { enemies: hostile, allies: affected.len() - hostile })
}

/// `spellTacticalScore(actor, spell, slotLevel = spell.level, targets)`: оценка
/// для выбора, а не расчёт урона — без скрытой КД и пробных бросков.
fn spell_tactical_score(actor: &Value, spell: &Value, slot_level: Option<&Value>, targets: f64) -> f64 {
    let slot_level = slot_level.or_else(|| spell.get("level"));
    let average = spell_damage_estimate(Some(actor), Some(spell), slot_level);
    if average == 0.0 || average.is_nan() {
        return 220.0 + 100.0 * targets;
    }
    let success = if js::truthy(spell.get("automaticHit")) {
        1.0
    } else if js::truthy(spell.get("halfOnSave")) {
        0.75
    } else {
        0.65
    };
    // Цена круга растёт: небольшой выигрыш не оправдывает самую высокую ячейку.
    500.0 + average * success * 30.0 * targets - sk_core::v8math::pow(max2(0.0, js::number(slot_level)), 2.0) * 20.0
}

/// `Number(slot?.level ?? 0)`.
fn slot_number(slot: &Option<Slot>) -> f64 {
    match slot {
        Some(slot) if !slot.level.is_null() => js::number(Some(&slot.level)),
        _ => 0.0,
    }
}

fn combat_distance_to_position(state: &Value, actor_id: &str, position: &Value) -> f64 {
    let Some(from) = actor_point(state, actor_id) else { return MAX_SAFE_INTEGER };
    if !js::truthy(Some(position)) {
        return MAX_SAFE_INTEGER;
    }
    let from = point_json(from);
    footprint_distance_feet(game::find_actor(state, actor_id), Some(&Value::Array(vec![position.clone()])), Some(&from), None).unwrap_or(MAX_SAFE_INTEGER)
}

/// `safeCell(state, position)`: клетка сцены раскрыта и не стена.
fn safe_cell(state: &Value, position: &Value) -> Result<bool, Halt> {
    let x = js::number(position.get("x"));
    let y = js::number(position.get("y"));
    let cells = list(path(state, &["scene", "cells"]))?;
    let cell = cells.iter().find(|candidate| js::number(get(Some(candidate), "x")) == x && js::number(get(Some(candidate), "y")) == y);
    Ok(cell.is_some_and(|cell| js::truthy(Some(cell)) && !js::is_false(get(Some(cell), "revealed")) && get(Some(cell), "type").and_then(Value::as_str) != Some("wall")))
}

fn base_cast(actor_id: &str, spell: &Value, slot: &Option<Slot>) -> Map<String, Value> {
    let mut base = Map::new();
    base.insert("command_type".into(), Value::String("CastSpell".into()));
    base.insert("actor_id".into(), Value::String(actor_id.into()));
    if let Some(id) = spell.get("id") {
        base.insert("spell_id".into(), id.clone());
    }
    base.insert("server_authoritative".into(), Value::Bool(true));
    if let Some(slot) = slot {
        base.insert("slot_level".into(), slot.level.clone());
    }
    base
}

fn with_fields(base: &Map<String, Value>, fields: Vec<(&str, Value)>) -> Value {
    let mut map = base.clone();
    for (key, value) in fields {
        map.insert(key.into(), value);
    }
    Value::Object(map)
}

fn target_fields(id: String) -> Vec<(&'static str, Value)> {
    vec![("target_id", Value::String(id.clone())), ("target_ids", json!([id]))]
}

fn spell_candidates_for(candidates: &mut Candidates<'_, '_>, actor: &Value) -> Result<(), Halt> {
    let tactics = candidates.tactics;
    let state = tactics.state;
    let actor_id = candidates.actor_id.clone();
    let economy = economy_for(state, &actor_id);
    let enemies = enemies_for_tactics(state)?;
    let allies = party_actors(state)?;
    let validation = tactics.validation_state()?;
    let mut options = Map::new();
    if let Some(ruleset) = state.get("ruleset_id") {
        options.insert("rulesetId".into(), ruleset.clone());
    }
    let spells = sk_combat_content::combat_spells::combat_spells_for(Some(actor), Some(&Value::Object(options)));
    for spell in &spells {
        let support = spell.get("mechanicsSupport").and_then(Value::as_str).unwrap_or("");
        if !COMBAT_POLICY_SUPPORT.contains(&support) || js::is_false(spell.get("prepared")) {
            continue;
        }
        let action_type = spell.get("actionType").and_then(Value::as_str);
        let Some(action_type) = action_type.filter(|kind| matches!(*kind, "action" | "bonus_action")) else { continue };
        if js::is_false(get(economy, action_type)) {
            continue;
        }
        if js::truthy(spell.get("concentration")) && js::truthy(path(state, &["mechanics", "concentration"]).and_then(|map| get(Some(map), &actor_id))) {
            continue;
        }
        if has_spell_condition(state, &actor_id, spell)? {
            continue;
        }
        let kind = spell.get("kind").and_then(Value::as_str).unwrap_or("");
        let target_kind = spell.get("target").and_then(Value::as_str);
        let name = js::string(spell.get("name"));
        let bonus = action_type == "bonus_action";
        let economy_type = if bonus { "bonus_action" } else { "action" };
        'slots: for slot in spell_slots_for_tactics(state, &actor_id, actor, spell) {
            let base = base_cast(&actor_id, spell, &slot);
            let slot_level = slot.as_ref().map(|slot| &slot.level);
            let add_spell = |candidates: &mut Candidates<'_, '_>, command: Value, score: f64, reason: String| -> bool {
                if js::is_false(get(economy, economy_type)) || !tactics.validates(&actor_id, &command) {
                    return false;
                }
                candidates.add(command, score, reason, true);
                true
            };
            if kind == "healing" && target_kind != Some("point") {
                let wounded: Vec<&Value> = allies
                    .iter()
                    .copied()
                    .filter(|ally| !is_dead_hero(state, &combat_id(ally)) && (downed_ally(ally) || actor_hp_number(ally) <= max2(1.0, (combat_max_hp(Some(ally)) * HEAL_THRESHOLD_RATIO).floor())))
                    .collect();
                let wounded = sorted(wounded, |left, right| or_else(actor_hp_number(left) - actor_hp_number(right), || compare_text(&combat_id(left), &combat_id(right))));
                for target in wounded {
                    let command = with_fields(&base, target_fields(combat_id(target)));
                    let amount = number_or(spell.get("healingAmount"), 0.0);
                    let healing = if amount != 0.0 {
                        amount
                    } else {
                        let mut healing_spell = spread_any(spell);
                        match spell.get("healing") {
                            Some(value) => healing_spell.insert("damage".into(), value.clone()),
                            None => healing_spell.shift_remove("damage"),
                        };
                        match spell.get("upcastHealingDicePerLevel") {
                            Some(value) => healing_spell.insert("upcastDicePerLevel".into(), value.clone()),
                            None => healing_spell.shift_remove("upcastDicePerLevel"),
                        };
                        spell_damage_estimate(Some(actor), Some(&Value::Object(healing_spell)), slot_level)
                    };
                    let downed = downed_ally(target);
                    let useful = min2(if downed { 1.0 } else { combat_max_hp(Some(target)) - actor_hp_number(target) }, healing);
                    let score = (if downed { 10_000.0 } else { 4_000.0 }) + useful * 30.0 + (if bonus { 150.0 } else { 0.0 }) - sk_core::v8math::pow(slot_number(&slot), 2.0) * 20.0;
                    add_spell(candidates, command, score, format!("{name} спасает {}", combat_id(target)));
                }
            }
            if kind == "buff" && target_kind != Some("point") {
                let pool: Vec<&Value> = if target_kind == Some("enemy") { enemies.clone() } else { allies.iter().copied().filter(|ally| visible_living_ally(ally)).collect() };
                let range = js::number(Some(spell.get("range").filter(|value| !value.is_null()).unwrap_or(&Value::from(0))));
                let in_range: Vec<&Value> = pool.into_iter().filter(|target| combat_distance(state, &actor_id, &combat_id(target)) <= range).collect();
                if target_kind == Some("enemy") {
                    let mut fresh = Vec::new();
                    for target in in_range {
                        if !has_spell_condition(state, &combat_id(target), spell)? {
                            fresh.push(target);
                        }
                    }
                    for target in fresh {
                        // Усиление выгоднее до оставшегося удара, чем на следующий ход.
                        let score = if attack_available(economy) { 1_200.0 } else { 250.0 };
                        if add_spell(candidates, with_fields(&base, target_fields(combat_id(target))), score - slot_number(&slot), format!("{name} усиливает следующие атаки по {}", combat_id(target))) {
                            break;
                        }
                    }
                } else if target_kind == Some("self") {
                    let weapon_kind = equipped_weapon(Some(actor))?.and_then(|weapon| get(get(Some(weapon), "combat"), "kind")).cloned();
                    let next_hit = spell.get("nextWeaponHit");
                    let next = js::truthy(next_hit)
                        && js::truthy(weapon_kind.as_ref())
                        && (!js::truthy(get(next_hit, "meleeOnly")) || weapon_kind.as_ref().and_then(Value::as_str) == Some("melee"))
                        && (!js::truthy(get(next_hit, "rangedOnly")) || weapon_kind.as_ref().and_then(Value::as_str) == Some("ranged"));
                    let score = if next && attack_available(economy) { 1_000.0 } else { 180.0 };
                    add_spell(candidates, with_fields(&base, target_fields(actor_id.clone())), score, format!("{name} усиливает героя"));
                } else if !in_range.is_empty() {
                    let maximum = max2(1.0, number_or(spell.get("maxTargets"), 1.0));
                    let mut selected = Vec::new();
                    for target in in_range {
                        if !has_spell_condition(state, &combat_id(target), spell)? {
                            selected.push(target);
                        }
                    }
                    selected.truncate(if maximum.is_finite() { maximum.trunc().max(0.0) as usize } else { usize::MAX });
                    if selected.is_empty() {
                        continue 'slots;
                    }
                    let ids: Vec<Value> = selected.iter().map(|target| Value::String(combat_id(target))).collect();
                    let command = with_fields(&base, vec![("target_id", Value::String(combat_id(selected[0]))), ("target_ids", Value::Array(ids))]);
                    add_spell(candidates, command, 180.0 + selected.len() as f64 * 30.0, format!("{name} поддерживает отряд"));
                }
            }
            if DAMAGE_SPELL_KINDS.contains(&kind) {
                if target_kind == Some("point") {
                    let range = js::number(Some(spell.get("range").filter(|value| !value.is_null()).unwrap_or(&Value::from(0))));
                    let mut sources: Vec<Value> = enemies.iter().map(|enemy| actor_point(state, &combat_id(enemy)).map_or(Value::Null, point_json)).collect();
                    match path(state, &["scene", "cells"]) {
                        None | Some(Value::Null) => {}
                        Some(Value::Array(cells)) => sources.extend(cells.iter().cloned()),
                        // `[...'ab']` — знаки строки: у знака нет координат, дальше фильтра он не проходит.
                        Some(Value::String(_)) => {}
                        Some(_) => return Err(type_error("scene.cells is not iterable")),
                    }
                    let mut points: IndexMap<String, Value> = IndexMap::new();
                    for to in sources {
                        if !js::truthy(Some(&to)) || js::is_false(get(Some(&to), "revealed")) || get(Some(&to), "type").and_then(Value::as_str) == Some("wall") {
                            continue;
                        }
                        if !(combat_distance_to_position(state, &actor_id, &to) <= range) {
                            continue;
                        }
                        let x = get(Some(&to), "x");
                        let y = get(Some(&to), "y");
                        let mut point = Map::new();
                        if let Some(x) = x {
                            point.insert("x".into(), x.clone());
                        }
                        if let Some(y) = y {
                            point.insert("y".into(), y.clone());
                        }
                        points.insert(format!("{},{}", js::string(x), js::string(y)), Value::Object(point));
                    }
                    let mut areas: Vec<(Value, usize)> = Vec::new();
                    for to in points.into_values() {
                        if !safe_cell(state, &to)? {
                            continue;
                        }
                        let area = area_targets_for_tactics(validation, &actor_id, spell, to.clone())?;
                        if area.enemies > 0 && area.allies == 0 {
                            areas.push((to, area.enemies));
                        }
                    }
                    let mut order: Vec<usize> = (0..areas.len()).collect();
                    v8sort::sort_by(&mut order, |left, right| areas[*right].1 as f64 - areas[*left].1 as f64);
                    for index in order {
                        let (to, count) = &areas[index];
                        let command = with_fields(&base, vec![("to", to.clone())]);
                        if !tactics.validates(&actor_id, &command) {
                            continue;
                        }
                        let score = spell_tactical_score(actor, spell, slot_level, *count as f64);
                        add_spell(candidates, command, score, format!("{name} поражает {count} противников без союзного огня"));
                        break;
                    }
                } else if target_kind == Some("self") && matches!(kind, "area-save" | "area-damage") {
                    let area = area_targets_for_tactics(validation, &actor_id, spell, Value::Null)?;
                    if area.enemies > 0 && area.allies == 0 {
                        let score = spell_tactical_score(actor, spell, slot_level, area.enemies as f64);
                        add_spell(candidates, Value::Object(base.clone()), score, format!("{name} поражает врагов рядом"));
                    }
                } else if target_kind == Some("enemy") {
                    let range = js::number(Some(spell.get("range").filter(|value| !value.is_null()).unwrap_or(&Value::from(0))));
                    let targets = sorted(enemies.clone(), |left, right| {
                        or_else(combat_distance(state, &actor_id, &combat_id(left)) - combat_distance(state, &actor_id, &combat_id(right)), || compare_text(&combat_id(left), &combat_id(right)))
                    });
                    for target in targets {
                        if combat_distance(state, &actor_id, &combat_id(target)) > range {
                            continue;
                        }
                        let command = with_fields(&base, target_fields(combat_id(target)));
                        let in_melee = kind == "attack" && spell.get("attackKind").and_then(Value::as_str) != Some("melee") && enemies.iter().any(|enemy| combat_distance(state, &actor_id, &combat_id(enemy)) <= 5.0);
                        let score = spell_tactical_score(actor, spell, slot_level, 1.0) - if in_melee { 120.0 } else { 0.0 };
                        if add_spell(candidates, command, score, format!("{name} атакует {}", combat_id(target))) {
                            break;
                        }
                    }
                }
            }
            // Призывы и прочие verified-заклинания без полноценного контроллера пропускаются.
        }
    }
    Ok(())
}

/// `pathThroughOccupiedCells`: путь сквозь живые фишки (кроме героя и цели).
fn path_through_occupied_cells(actor_id: &str, target_id: &str, validation: &Value) -> Result<Option<Vec<Point>>, Halt> {
    let mut route_state = validation.clone();
    for key in ["players", "actors", "enemies"] {
        let actors = list(route_state.get(key))?.to_vec();
        let mapped: Vec<Value> = actors
            .into_iter()
            .map(|actor| {
                let id = combat_id(&actor);
                if id == actor_id || id == target_id {
                    return actor;
                }
                let mut map = spread_any(&actor);
                map.insert("alive".into(), Value::Bool(false));
                map.insert("hp".into(), Value::from(0));
                Value::Object(map)
            })
            .collect();
        if let Value::Object(root) = &mut route_state {
            root.insert(key.into(), Value::Array(mapped));
        }
    }
    Ok(actor_point(&route_state, target_id).and_then(|to| shortest_tactical_path(&route_state, actor_id, to, PathOptions { allow_occupied_destination: true, ..PathOptions::default() })))
}

/// `freePathPrefix`: префикс пути до первой клетки, занятой живой фишкой.
fn free_path_prefix(state: &Value, route: Option<Vec<Point>>, actor_id: &str, target_id: &str) -> Result<Vec<Point>, Halt> {
    let Some(route) = route else { return Ok(Vec::new()) };
    let mut occupied: Vec<(i64, i64)> = Vec::new();
    for key in ["players", "actors", "enemies"] {
        for actor in list(state.get(key))? {
            if actor.is_null() {
                return Err(type_error("Cannot read properties of null (reading 'alive')"));
            }
            let id = combat_id(actor);
            if id == actor_id || id == target_id || js::is_false(get(Some(actor), "alive")) {
                continue;
            }
            let hp = get(Some(actor), "hp").filter(|value| !value.is_null()).cloned().unwrap_or(Value::from(1));
            if !(js::number(Some(&hp)) > 0.0) {
                continue;
            }
            let anchor = actor_point(state, &id).map(point_json);
            occupied.extend(footprint_cells_for(Some(actor), anchor.as_ref()).into_iter().map(|cell| (cell.x, cell.y)));
        }
    }
    let blocked = route.iter().position(|at| occupied.contains(&(at.x as i64, at.y as i64)));
    Ok(match blocked {
        Some(index) => route[..index].to_vec(),
        None => route,
    })
}

/// Рабочая копия для прогноза удара с другой клетки: в JS — свежий
/// `structuredClone` на каждую клетку, здесь одна копия, у которой меняется
/// только `mechanics.positions[actor]` (остальное от клетки не зависит).
fn set_position(attack_state: &mut Value, actor_id: &str, at: Point) -> Result<(), Halt> {
    let positions = attack_state.get_mut("mechanics").and_then(|mechanics| mechanics.get_mut("positions"));
    match positions {
        Some(Value::Object(map)) => {
            map.insert(actor_id.into(), point_json(at));
            Ok(())
        }
        _ => Err(type_error("Cannot set properties of undefined")),
    }
}

fn forecast_reaches(state: &Value, actor_id: &str, target_id: &str, item_id: Option<&str>) -> Result<bool, Halt> {
    let item = item_id.map(|id| Value::String(id.into()));
    let options = ForecastOptions { item_id: item.as_ref(), ..ForecastOptions::default() };
    let forecast = attack_forecast(state, actor_id, target_id, options)?;
    let reach = get(forecast.as_ref(), "reachable").filter(|value| !value.is_null()).or_else(|| get(forecast.as_ref(), "in_range"));
    Ok(js::truthy(reach))
}

struct Movement {
    command: Value,
}

fn same_coordinate(left: f64, right: f64) -> bool {
    js::f64_string(left) == js::f64_string(right)
}

/// `movementCandidateFor(state, actorId, targetId, itemId)`: шаг к цели до
/// клетки, откуда удар достаёт, без ухода из-под угрозы вплотную.
fn movement_candidate_for(tactics: &Tactics<'_>, actor_id: &str, target_id: &str, item_id: Option<&str>) -> Result<Option<Movement>, Halt> {
    let state = tactics.state;
    let validation = tactics.validation_state()?;
    let actor = game::find_actor(validation, actor_id);
    let from = actor_point(validation, actor_id);
    let to = actor_point(validation, target_id);
    let (Some(actor), Some(_), Some(to)) = (actor, from, to) else { return Ok(None) };
    let mut route = shortest_tactical_path(validation, actor_id, to, PathOptions { allow_occupied_destination: true, ..PathOptions::default() });
    if route.is_none() {
        // Союзник в узком проходе: путь сквозь фишки, затем свободный префикс.
        route = Some(free_path_prefix(validation, path_through_occupied_cells(actor_id, target_id, validation)?, actor_id, target_id)?);
    }
    let route = route.unwrap_or_default();
    if route.is_empty() {
        return Ok(None);
    }
    let budget = movement_remaining(validation, actor_id);
    let conditions = condition_ids(state, actor_id)?;
    let protected_movement = ["disengaged", "invisible", "zephyr-strike"].iter().any(|id| has(&conditions, id));
    // Дальность скрытого оружия неизвестна: видимый враг вплотную с реакцией
    // держит героя в досягаемости, пока не выполнен безопасный Отход.
    let mut threats: Vec<(String, Point)> = Vec::new();
    if !protected_movement {
        for enemy in enemies_for_tactics(state)? {
            let id = combat_id(enemy);
            if combat_distance(state, actor_id, &id) <= 5.0 && !js::is_false(get(economy_for(state, &id), "reaction")) {
                if let Some(at) = actor_point(state, &id) {
                    threats.push((id, at));
                }
            }
        }
    }
    let mut chosen: Option<Point> = None;
    let mut spent = 0.0;
    let occupied = occupied_positions(validation, Some(actor_id), true);
    let mut attack_state: Option<Value> = None;
    for step in &route {
        if threats.iter().any(|(id, at)| actor_distance_feet(state, id, actor_id, Some(*at), Some(*step)) > 5.0) {
            break;
        }
        let step_cost = movement_cost_of_path(validation, actor_id, &[*step], None);
        if spent + step_cost > budget {
            break;
        }
        spent += step_cost;
        if same_coordinate(step.x, to.x) && same_coordinate(step.y, to.y) {
            break;
        }
        if footprint_body_occupied(actor, *step, &occupied) {
            continue;
        }
        let working = attack_state.get_or_insert_with(|| validation.clone());
        set_position(working, actor_id, *step)?;
        chosen = Some(*step);
        if forecast_reaches(working, actor_id, target_id, item_id)? {
            break;
        }
    }
    if chosen.is_none() && threats.is_empty() {
        // Путь к опорной клетке цели упёрся в лежащих и в само тело цели:
        // свободная клетка вокруг цели, откуда удар достаёт.
        if let Some(cell) = attack_cell_near_target(validation, actor_id, target_id, item_id, budget, &occupied)? {
            chosen = Some(cell);
        }
    }
    let Some(chosen) = chosen else { return Ok(None) };
    let command = json!({ "command_type": "MoveActor", "actor_id": actor_id, "to": point_json(chosen), "server_authoritative": true });
    if !tactics.validates(actor_id, &command) {
        return Ok(None);
    }
    Ok(Some(Movement { command }))
}

fn footprint_body_occupied(actor: &Value, at: Point, occupied: &KeySet) -> bool {
    footprint_cells_for(Some(actor), Some(&point_json(at))).iter().any(|cell| occupied.contains(&key(cell.x as f64, cell.y as f64)))
}

/// `attackCellNearTarget`: ближайшая по цене пути свободная клетка вокруг цели,
/// с которой прогноз удара достаёт, в пределах оставшегося движения.
fn attack_cell_near_target(validation: &Value, actor_id: &str, target_id: &str, item_id: Option<&str>, budget: f64, occupied: &KeySet) -> Result<Option<Point>, Halt> {
    let actor = game::find_actor(validation, actor_id);
    let target = game::find_actor(validation, target_id);
    let target_at = actor_point(validation, target_id);
    let (Some(actor), Some(target), Some(target_at)) = (actor, target, target_at) else { return Ok(None) };
    let body: Vec<(i64, i64)> = footprint_cells_for(Some(target), Some(&point_json(target_at))).into_iter().map(|cell| (cell.x, cell.y)).collect();
    let mut ring: IndexMap<(i64, i64), ()> = IndexMap::new();
    for (x, y) in &body {
        for dx in -1..=1 {
            for dy in -1..=1 {
                let cell = (x + dx, y + dy);
                if !body.contains(&cell) {
                    ring.insert(cell, ());
                }
            }
        }
    }
    let mut best: Option<(Point, f64)> = None;
    let mut attack_state: Option<Value> = None;
    for (x, y) in ring.into_keys() {
        let cell = Point::new(x as f64, y as f64);
        let blocked = footprint_cells_for(Some(actor), Some(&point_json(cell))).iter().any(|part| occupied.contains(&key(part.x as f64, part.y as f64)) || body.contains(&(part.x, part.y)));
        if blocked {
            continue;
        }
        let Some(route) = shortest_tactical_path(validation, actor_id, cell, PathOptions::default()).filter(|route| !route.is_empty()) else { continue };
        let cost = movement_cost_of_path(validation, actor_id, &route, None);
        if cost > budget || best.is_some_and(|(_, known)| cost >= known) {
            continue;
        }
        let working = attack_state.get_or_insert_with(|| validation.clone());
        set_position(working, actor_id, cell)?;
        if forecast_reaches(working, actor_id, target_id, item_id)? {
            best = Some((cell, cost));
        }
    }
    Ok(best.map(|(cell, _)| cell))
}

/// Множитель прогноза: помеха, преимущество или обычный бросок.
fn forecast_multiplier(forecast: Option<&Value>) -> f64 {
    if js::truthy(get(forecast, "disadvantage")) {
        0.4
    } else if js::truthy(get(forecast, "advantage")) {
        0.85
    } else {
        0.65
    }
}

fn add_attack_candidates(candidates: &mut Candidates<'_, '_>, actor: &Value) -> Result<(), Halt> {
    let tactics = candidates.tactics;
    let state = tactics.state;
    let actor_id = candidates.actor_id.clone();
    let enemies = enemies_for_tactics(state)?;
    let item_id = equipped_weapon(Some(actor))?.map(|weapon| js::string(get(Some(weapon), "id")));
    let item_value = item_id.as_ref().map(|id| Value::String(id.clone()));
    let economy = economy_for(state, &actor_id);
    for target in enemies {
        let target_id = combat_id(target);
        let options = ForecastOptions { item_id: item_value.as_ref().filter(|id| js::truthy(Some(id))), ..ForecastOptions::default() };
        let forecast = attack_forecast(state, &actor_id, &target_id, options)?;
        let mut attack = Map::new();
        attack.insert("command_type".into(), Value::String("MakeAttack".into()));
        attack.insert("target_id".into(), Value::String(target_id.clone()));
        if let Some(id) = item_id.as_ref().filter(|id| !id.is_empty()) {
            attack.insert("item_id".into(), Value::String(id.clone()));
        }
        let attack = command_with_target(&actor_id, Value::Object(attack));
        let reach = get(forecast.as_ref(), "reachable").filter(|value| !value.is_null()).or_else(|| get(forecast.as_ref(), "in_range"));
        if js::truthy(reach) && tactics.validates(&actor_id, &attack) {
            let damage = max2(0.0, number_or(get(forecast.as_ref(), "average_damage"), 0.0));
            candidates.add(attack, 500.0 + damage * 30.0 * forecast_multiplier(forecast.as_ref()), format!("Атаковать {target_id} доступным оружием"), true);
            continue;
        }
        if attack_available(economy) {
            if let Some(approach) = movement_candidate_for(tactics, &actor_id, &target_id, item_id.as_deref().filter(|id| !id.is_empty()))? {
                candidates.add(approach.command, 260.0, format!("Подойти к {target_id}, чтобы атаковать"), true);
            }
        }
    }
    Ok(())
}

fn action_command(actor_id: &str, action_id: &Value, extra: Vec<(&str, Value)>) -> Value {
    let mut command = Map::new();
    command.insert("command_type".into(), Value::String("UseCombatAction".into()));
    command.insert("action_id".into(), action_id.clone());
    for (key, value) in extra {
        command.insert(key.into(), value);
    }
    command_with_target(actor_id, Value::Object(command))
}

fn has_extinguishable_flames(state: &Value, actor_id: &str) -> Result<bool, Halt> {
    Ok(condition_ids(state, actor_id)?.iter().any(|condition| EXTINGUISHABLE_FLAME_CONDITIONS.contains(&condition.as_str())))
}

fn add_action_candidates(candidates: &mut Candidates<'_, '_>, actor: &Value) -> Result<(), Halt> {
    let tactics = candidates.tactics;
    let state = tactics.state;
    let actor_id = candidates.actor_id.clone();
    let actions: Vec<Value> = sk_combat_content::combat_actions::combat_actions_for(Some(actor))
        .into_iter()
        .filter(|action| COMBAT_POLICY_SUPPORT.contains(&action.get("mechanicsSupport").and_then(Value::as_str).unwrap_or("")) && action.get("id").and_then(Value::as_str) != Some("extra-attack"))
        .collect();
    let economy = economy_for(state, &actor_id);
    let conditions = condition_ids(state, &actor_id)?;
    let enemies = enemies_for_tactics(state)?;
    let allies = party_actors(state)?;
    let distance = |id: &str| combat_distance(state, &actor_id, id);
    let range_or = |action: &Value, fallback: i64| js::number(Some(action.get("range").filter(|value| !value.is_null()).unwrap_or(&Value::from(fallback))));
    for action in &actions {
        if !action_resource_available(state, &actor_id, action) {
            continue;
        }
        let id_value = action.get("id").cloned().unwrap_or(Value::Null);
        let id = id_value.as_str().unwrap_or("");
        let name = js::string(action.get("name"));
        let effect = action.get("effect");
        let effect_kind = get(effect, "kind").and_then(Value::as_str);
        let target_kind = action.get("target").and_then(Value::as_str);
        if id == "stand-up" {
            continue;
        }
        if id == "second-wind" {
            if let Some(hp) = combat_hp(actor) {
                if hp / combat_max_hp(Some(actor)) <= 0.35 {
                    candidates.add(action_command(&actor_id, &id_value, Vec::new()), 3_500.0, "Использовать «Второе дыхание» на тяжело раненного героя".into(), false);
                }
            }
            continue;
        }
        if id == "action-surge" {
            if js::is_false(get(economy, "action")) {
                candidates.add(action_command(&actor_id, &id_value, Vec::new()), 190.0, "Вернуть действие «Всплеском действий»".into(), false);
            }
            continue;
        }
        if id == "cunning-dash" || id == "expeditious-retreat-dash" {
            if id == "expeditious-retreat-dash" && !has(&conditions, "expeditious-retreat") {
                continue;
            }
            let target = enemies.iter().find(|enemy| distance(&combat_id(enemy)) > 5.0);
            if let Some(target) = target {
                if !js::is_false(get(economy, "bonus_action")) && movement_candidate_for(tactics, &actor_id, &combat_id(target), None)?.is_some() {
                    candidates.add(action_command(&actor_id, &id_value, Vec::new()), 120.0, "Получить дополнительное перемещение бонусным действием".into(), false);
                }
            }
            continue;
        }
        // Дикий облик Круга луны — бонусным действием, пока идёт бой.
        let shape = path(state, &["mechanics", "shapes"]).and_then(|map| get(Some(map), &actor_id)).filter(|value| !value.is_null());
        if effect_kind == Some("wild_shape") {
            if !js::truthy(shape) && action.get("actionType").and_then(Value::as_str) == Some("bonus_action") && !js::is_false(get(economy, "bonus_action")) && !enemies.is_empty() {
                candidates.add(action_command(&actor_id, &id_value, Vec::new()), 1_000.0, "Принять Дикий облик бонусным действием".into(), false);
            }
            continue;
        }
        if effect_kind == Some("wild_shape_heal") {
            let hp = combat_hp(actor);
            if get(get(shape, "form"), "wild_shape") == Some(&Value::Bool(true)) && hp.is_some_and(|hp| hp / combat_max_hp(Some(actor)) <= 0.5) && !js::is_false(get(economy, "bonus_action")) {
                candidates.add(action_command(&actor_id, &id_value, Vec::new()), 2_000.0, "Целебный облик: ячейка в хиты зверя".into(), false);
            }
            continue;
        }
        if effect_kind == Some("heal") {
            let pool: Vec<&Value> = if target_kind == Some("self") { vec![actor] } else { allies.iter().copied().filter(|ally| combat_id(ally) != actor_id).collect() };
            let range = range_or(action, 0);
            let targets: Vec<&Value> = pool
                .into_iter()
                .filter(|ally| !is_dead_hero(state, &combat_id(ally)) && distance(&combat_id(ally)) <= range && (downed_ally(ally) || actor_hp_number(ally) < combat_max_hp(Some(ally)) * 0.35))
                .collect();
            for target in targets {
                let downed = downed_ally(target);
                let useful = min2(if downed { 1.0 } else { combat_max_hp(Some(target)) - actor_hp_number(target) }, number_or(get(effect, "amount"), 5.0));
                let command = action_command(&actor_id, &id_value, target_fields(combat_id(target)));
                candidates.add(command, (if downed { 10_000.0 } else { 4_000.0 }) + useful * 30.0 - 10.0, format!("{name} лечит союзника"), false);
            }
            continue;
        }
        if id == "stabilize" || id == "first-aid" {
            // Стабилизировать — только того, кто ещё бросает спасброски от смерти.
            let range = range_or(action, 5);
            let target = allies.iter().find(|ally| {
                downed_ally(ally)
                    && !is_dead_hero(state, &combat_id(ally))
                    && path(state, &["mechanics", "death", "saving_throws"]).and_then(|map| get(Some(map), &combat_id(ally))).and_then(|throws| get(Some(throws), "stable")) != Some(&Value::Bool(true))
                    && distance(&combat_id(ally)) <= range
            });
            if let Some(target) = target {
                candidates.add(action_command(&actor_id, &id_value, target_fields(combat_id(target))), 8_000.0, format!("{name} спасает лежащего союзника"), false);
            }
            continue;
        }
        if id == "disengage" || id == "cunning-disengage" {
            if enemies.iter().any(|enemy| distance(&combat_id(enemy)) <= 5.0) && !has(&conditions, "disengaged") {
                candidates.add(action_command(&actor_id, &id_value, Vec::new()), 90.0, "Выйти из досягаемости без атаки по возможности".into(), false);
            }
            continue;
        }
        if matches!(id, "break-free" | "steady-nerves" | "search" | "hide" | "ready" | "ready-action") {
            continue;
        }
        if id == "extinguish-self" && !has_extinguishable_flames(state, &actor_id)? {
            continue;
        }
        if id == "reckless-attack" && has(&conditions, "reckless") {
            continue;
        }
        if id == "reckless-attack" && (js::number(get(economy, "attacks_used")) > 0.0 || actor_hp_number(actor) < combat_max_hp(Some(actor)) / 2.0) {
            continue;
        }
        if id == "rage" && has(&conditions, "raging") {
            continue;
        }
        let effect_condition = get(effect, "condition");
        let already_affected = |target: &Value| -> Result<bool, Halt> {
            if !js::truthy(effect_condition) {
                return Ok(false);
            }
            let condition = js::string(effect_condition);
            let ids = condition_ids(state, &combat_id(target))?;
            Ok(has(&ids, &condition) || has(&ids, &format!("{condition}:{actor_id}")))
        };
        let target: Option<&Value> = if target_kind == Some("self") {
            None
        } else if target_kind == Some("ally") {
            let mut pool = Vec::new();
            for ally in allies.iter().copied().filter(|ally| visible_living_ally(ally)) {
                if id == "extinguish-ally" && !has_extinguishable_flames(state, &combat_id(ally))? {
                    continue;
                }
                if combat_id(ally) != actor_id && !already_affected(ally)? {
                    pool.push(ally);
                }
            }
            sorted(pool, |left, right| or_else(actor_hp_number(left) - actor_hp_number(right), || compare_text(&combat_id(left), &combat_id(right)))).first().copied()
        } else {
            let range = range_or(action, 5);
            let mut pool = Vec::new();
            for enemy in enemies.iter().copied() {
                if !already_affected(enemy)? && distance(&combat_id(enemy)) <= range {
                    pool.push(enemy);
                }
            }
            sorted(pool, |left, right| or_else(distance(&combat_id(left)) - distance(&combat_id(right)), || compare_text(&combat_id(left), &combat_id(right)))).first().copied()
        };
        if target_kind == Some("enemy") && target.is_none_or(|target| distance(&combat_id(target)) > range_or(action, 5)) {
            continue;
        }
        if target_kind == Some("ally") && target.is_none() {
            continue;
        }
        // Изгнание нежити — когда рядом есть неизгнанная нежить.
        let mut undead_near = false;
        if get(effect, "areaUndead") == Some(&Value::Bool(true)) {
            let radius = js::number(Some(get(effect, "radius").filter(|value| !value.is_null()).unwrap_or(&Value::from(30))));
            for enemy in &enemies {
                let creature = text::lower(&js::s(nullish(&[get(Some(enemy), "creature_type"), get(Some(enemy), "creatureType")])));
                if text::test(sk_core::re!(r"undead|нежит", "u"), &creature) && !has(&condition_ids(state, &combat_id(enemy))?, "turned") && distance(&combat_id(enemy)) <= radius {
                    undead_near = true;
                    break;
                }
            }
        }
        if target_kind == Some("self") && !matches!(id, "dash" | "dodge" | "rage" | "reckless-attack") && !undead_near {
            continue;
        }
        if id == "dash" {
            let mut reachable = false;
            for enemy in &enemies {
                if movement_candidate_for(tactics, &actor_id, &combat_id(enemy), None)?.is_some() {
                    reachable = true;
                    break;
                }
            }
            if !reachable {
                continue;
            }
        }
        if id == "dodge" && !enemies.iter().any(|enemy| distance(&combat_id(enemy)) <= 5.0) && actor_hp_number(actor) > combat_max_hp(Some(actor)) * 0.4 {
            continue;
        }
        let mut extra = match target {
            Some(target) => target_fields(combat_id(target)),
            None => Vec::new(),
        };
        let weapon = if js::truthy(action.get("requiresWeapon")) { equipped_weapon(Some(actor))? } else { None };
        let item_id = weapon.map(|weapon| js::string(get(Some(weapon), "id")));
        if let Some(item_id) = &item_id {
            extra.push(("item_id", Value::String(item_id.clone())));
        }
        let command = action_command(&actor_id, &id_value, extra);
        let mut score = if id == "rage" {
            900.0
        } else if id == "reckless-attack" {
            750.0
        } else if undead_near {
            800.0
        } else {
            70.0
        };
        if let (Some("weapon_attack"), Some(target)) = (effect_kind, target) {
            let item = item_id.as_ref().filter(|id| !id.is_empty()).map(|id| Value::String(id.clone()));
            let forecast = attack_forecast(state, &actor_id, &combat_id(target), ForecastOptions { item_id: item.as_ref(), ..ForecastOptions::default() })?;
            // Кара оценивается младшей ячейкой: её движок и возьмёт без названного круга.
            let extra_damage = if get(effect, "extraDamageByLevel").and_then(Value::as_str) == Some("sneak") {
                Some(Value::String(format!("{}d6", js::f64_string((js::number(actor.get("level")) / 2.0).ceil()))))
            } else if js::truthy(get(effect, "divineSmite")) {
                Some(Value::String("2d8".into()))
            } else {
                get(effect, "extraDamage").cloned()
            };
            let mut extra_spell = Map::new();
            extra_spell.insert("level".into(), Value::from(1));
            if let Some(damage) = extra_damage {
                extra_spell.insert("damage".into(), damage);
            }
            let extra = spell_damage_estimate(Some(actor), Some(&Value::Object(extra_spell)), None);
            let attacks = max2(1.0, number_or(get(effect, "attacks"), 1.0));
            score = 500.0 + (max2(0.0, number_or(get(forecast.as_ref(), "average_damage"), 0.0)) + extra) * attacks * 30.0 * forecast_multiplier(forecast.as_ref())
                + (if js::truthy(effect_condition) { 100.0 } else { 0.0 })
                - (if js::truthy(action.get("resource")) { 20.0 } else { 0.0 });
        }
        if tactics.validates(&actor_id, &command) {
            candidates.add(command, score, format!("{name} — подходящая поддержанная тактика"), true);
        }
    }
    Ok(())
}

/// `===` для полей команды: числа сравниваются как числа, `undefined` и
/// `null` различаются; объекты и массивы — разные ссылки.
fn strict_eq(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        (Some(Value::Object(_)), _) | (Some(Value::Array(_)), _) => false,
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

/// `planHeroCombatCommand(state, actorId)`: одна команда автономного боевого
/// шага на player-visible проекции; после commit вызывающий снова передаёт
/// свежую проекцию.
pub fn plan_hero_combat_command(state: &Value, actor_id: &str) -> Result<CombatStep, Halt> {
    let actor_id = actor_id.to_string();
    let end = command_with_target(&actor_id, json!({ "command_type": "EndTurn" }));
    let tactics = Tactics::new(state);
    let reaction = path(state, &["mechanics", "combat", "reaction_window"]);
    if js::truthy(reaction) && js::string(get(reaction, "actor_id")) == actor_id {
        if let Some(window) = reaction {
            if let Some(planned) = plan_expanded_combat_reaction(&tactics, window)? {
                return Ok(planned);
            }
        }
        let fallback = plan_hero_reaction(state, reaction);
        return Ok(CombatStep { command: fallback.commands.first().cloned().unwrap_or(end), reason: format!("Реакция: {}", fallback.rule) });
    }
    let actor = game::find_actor(state, &actor_id);
    let Some(actor) = actor.filter(|actor| combat_hp(actor).is_some_and(|hp| hp > 0.0)) else {
        return Ok(CombatStep { command: end, reason: "Герой не может действовать и завершает ход".into() });
    };
    let combat = path(state, &["mechanics", "combat"]);
    let index = js::number(get(combat, "active_index"));
    let current = match get(combat, "initiative") {
        Some(Value::Array(order)) if index >= 0.0 && index.fract() == 0.0 => order.get(index as usize),
        Some(Value::Object(map)) => map.get(&js::f64_string(index)),
        _ => None,
    }
    .and_then(|entry| get(Some(entry), "actor_id"));
    if !js::truthy(get(combat, "active")) || (js::truthy(current) && js::string(current) != actor_id) {
        return Ok(CombatStep { command: end, reason: "Сейчас ход другого участника".into() });
    }

    let economy = economy_for(state, &actor_id);
    let mut candidates = Candidates { tactics: &tactics, actor_id: actor_id.clone(), list: Vec::new() };
    let prone = has(&condition_ids(state, &actor_id)?, "prone");
    let stand = command_with_target(&actor_id, json!({ "command_type": "UseCombatAction", "action_id": "stand-up" }));
    if prone && tactics.validates(&actor_id, &stand) {
        return Ok(CombatStep { command: stand, reason: "Встать после падения перед следующим решением".into() });
    }
    let healing = healing_item(actor)?;
    let heal_target = match healing {
        Some(_) => healing_target_for(state, &actor_id)?,
        None => None,
    };
    if let (Some(healing), Some(heal_target)) = (healing, heal_target.as_ref()) {
        let target_id = combat_id(heal_target);
        let downed = downed_ally(heal_target);
        if target_id == actor_id || combat_distance(state, &actor_id, &target_id) <= HEALING_RANGE_FEET {
            let command = command_with_target(&actor_id, json!({ "command_type": "UseItem", "item_id": js::string(get(Some(healing), "id")), "target_id": target_id }));
            candidates.add(command, if downed { 9_500.0 } else { 3_800.0 }, format!("Зелье лечения помогает {target_id}"), false);
        } else if let Some(approach) = movement_candidate_for(&tactics, &actor_id, &target_id, None)? {
            candidates.add(approach.command, if downed { 9_200.0 } else { 3_500.0 }, format!("Подойти к {target_id} для лечения зельем"), false);
        }
    }
    spell_candidates_for(&mut candidates, actor)?;
    add_action_candidates(&mut candidates, actor)?;
    add_attack_candidates(&mut candidates, actor)?;

    let list = std::mem::take(&mut candidates.list);
    let texts: Vec<(String, String)> = list.iter().map(|candidate| (js::string(candidate.command.get("command_type")), js::stringify(&candidate.command))).collect();
    let mut order: Vec<usize> = (0..list.len()).collect();
    v8sort::sort_by(&mut order, |left, right| {
        or_else(list[*right].score - list[*left].score, || or_else(compare_text(&texts[*left].0, &texts[*right].0), || compare_text(&texts[*left].1, &texts[*right].1)))
    });
    let mut best = order.first().copied();
    if let Some(top) = best {
        let command = &list[top].command;
        if command.get("command_type").and_then(Value::as_str) == Some("CastSpell") && js::number(command.get("slot_level")) > 0.0 {
            // При почти равной полезности бережём старшую ячейку, но не хуже
            // конкурирующего заговора, удара или лечения.
            let same_cast = |candidate: &Candidate| {
                let other = &candidate.command;
                strict_eq(other.get("spell_id"), command.get("spell_id"))
                    && (std::ptr::eq(other, command) || strict_eq(other.get("target_id"), command.get("target_id")))
                    && strict_eq(get(other.get("to"), "x"), get(command.get("to"), "x"))
                    && strict_eq(get(other.get("to"), "y"), get(command.get("to"), "y"))
            };
            let rival = order.iter().find(|index| !same_cast(&list[**index])).map_or(0.0, |index| list[*index].score);
            let threshold = max2(list[top].score * 0.95, rival);
            let mut same: Vec<usize> = order.iter().copied().filter(|index| same_cast(&list[*index]) && list[*index].score >= threshold).collect();
            v8sort::sort_by(&mut same, |left, right| js::number(list[*left].command.get("slot_level")) - js::number(list[*right].command.get("slot_level")));
            if let Some(cheapest) = same.first() {
                best = Some(*cheapest);
            }
        }
    }
    if let Some(best) = best {
        let candidate = &list[best];
        return Ok(CombatStep { command: candidate.command.clone(), reason: candidate.reason.clone() });
    }

    let enemies = enemies_for_tactics(state)?;
    let ranked = sorted(enemies, |left, right| or_else(combat_distance(state, &actor_id, &combat_id(left)) - combat_distance(state, &actor_id, &combat_id(right)), || compare_text(&combat_id(left), &combat_id(right))));
    if let Some(target) = ranked.first() {
        if !js::is_false(get(economy, "action")) {
            if let Some(movement) = movement_candidate_for(&tactics, &actor_id, &combat_id(target), None)? {
                return Ok(CombatStep { command: movement.command, reason: format!("Сблизиться с {} по доступному маршруту", combat_id(target)) });
            }
        }
    }
    Ok(CombatStep { command: end, reason: "Нет безопасной поддержанной команды; завершить ход".into() })
}

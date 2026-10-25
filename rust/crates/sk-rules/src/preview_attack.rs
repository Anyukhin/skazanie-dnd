//! Предпросмотры атаки: форма броска (преимущество и помеха), шанс попадания,
//! прогноз удара, оружие по умолчанию, подход с атакой, прыжок и `swing` с
//! атакой, особое действие существа. Задача Р8.
//!
//! JS: `server/rules-engine.mjs`, 3794–3876 (`attackSwingShape`,
//! `d20HitChance`), 3929–3995 (`defaultAttackItemIdFor`,
//! `previewApproachAttack`), 4035–4264 (`swingPropForText`,
//! `previewSwingAttack`, `previewLongJumpAttack`, `attackForecast`;
//! `averageDamageOf` перенесён Р3 в `combat/weapons.rs`), 5065–5103
//! (`serverOwnedMonsterActor`, `previewMonsterAction`).
//!
//! Форма броска — единственный владелец вопроса «с преимуществом или с
//! помехой бьёт удар»: ею пользуются и `MakeAttack`, и прогноз для
//! интерфейса. Предпросмотры составных манёвров перебирают клетки вокруг цели
//! и спрашивают `validateCommand` (мягкую проверку сверки — через
//! [`crate::resolve::api::validate`]), как JS.

use serde_json::{json, Map, Value};
use sk_core::{game, js, text};
use sk_geometry::Point;

use crate::checks::saves::{active_true_strike_for, condition_attack_modifiers, AttackConditionModifiers, AttackConditionOptions};
use crate::combat::weapons::{average_damage_of, equipped_weapon_attacks, item_attack_profile, swing_details_for, trusted_attack_profile, AttackOptions};
use crate::conditions::condition_numeric_bonus;
use crate::context::Context;
use crate::core::{condition_ids_for, monster_trait_for};
use crate::damage::effective_armor_class;
use crate::geometry::footprint::{actor_footprint_fits, distance_between_actor_positions, FitOptions};
use crate::geometry::forced::has_clear_actor_trajectory;
use crate::geometry::movement::{assert_voluntary_movement_path, long_jump_movement_for, movement_for_actor, LongJump};
use crate::geometry::terrain::movement_step_cost_for;
use crate::normalize::normalize_campaign_state_cow;
use crate::pause::{rule, Halt};
use crate::tactical_geometry::{actor_point, cover_between, high_ground_between, key, key_of, occupied_positions, point_json, points_json, scene_tactical_map, shortest_tactical_path, tactical_cell_map, PathOptions};

fn at<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|value| value.as_object()).and_then(|map| map.get(key))
}

/// `[...new Set(list.map(String))]`.
fn unique(list: Vec<String>) -> Vec<String> {
    let mut seen = sk_core::indexmap::IndexSet::new();
    for item in list {
        seen.insert(item);
    }
    seen.into_iter().collect()
}

// --- форма броска атаки (3794–3865) -----------------------------------------------

/// Итог `attackSwingShape`.
#[derive(Debug, Clone, PartialEq)]
pub struct SwingShape {
    pub advantage: bool,
    pub disadvantage: bool,
    pub advantage_sources: Vec<String>,
    pub disadvantage_sources: Vec<String>,
    pub automatic_critical: bool,
    /// `higher`, `lower` или `level`.
    pub high_ground: &'static str,
}

impl SwingShape {
    /// Форма JS (`{ advantage, disadvantage, advantageSources, … }`).
    pub fn to_value(&self) -> Value {
        json!({
            "advantage": self.advantage,
            "disadvantage": self.disadvantage,
            "advantageSources": self.advantage_sources,
            "disadvantageSources": self.disadvantage_sources,
            "automaticCritical": self.automatic_critical,
            "highGround": self.high_ground,
        })
    }
}

/// Параметры `attackSwingShape` — те, что передают оба места вызова JS
/// (`actorAt`, `targetAt`, `distanceFeet` всегда явные).
#[derive(Debug, Clone, Default)]
pub struct SwingOptions {
    pub actor_at: Option<Point>,
    pub target_at: Option<Point>,
    pub distance_feet: Option<f64>,
    /// `conditionModifiers`; `None` — значение по умолчанию JS (считается здесь).
    pub condition_modifiers: Option<AttackConditionModifiers>,
    /// `Boolean(commandAdvantage)`.
    pub command_advantage: bool,
    /// `Boolean(commandDisadvantage)`.
    pub command_disadvantage: bool,
    /// `Boolean(extraAdvantage)`.
    pub extra_advantage: bool,
}

/// `conditionAttackModifiers(…)` с параметрами по умолчанию `attackSwingShape`.
pub fn swing_condition_modifiers(state: &Value, attacker_id: &str, target_id: &str, profile: Option<&Value>, distance_feet: Option<f64>) -> AttackConditionModifiers {
    let kind = at(profile, "kind");
    let melee = kind.and_then(Value::as_str) == Some("melee");
    let five = Value::from(5);
    let reach = if melee { at(profile, "normal_range_feet") } else { Some(&five) };
    condition_attack_modifiers(
        state,
        attacker_id,
        target_id,
        AttackConditionOptions { distance_feet, profile_kind: kind.and_then(Value::as_str), melee_reach_feet: reach, weapon_attack: true },
    )
}

/// `attackSwingShape(state, attackerId, targetId, profile, options)`:
/// преимущество, помеха и их причины.
pub fn attack_swing_shape(state: &Value, attacker_id: &str, target_id: &str, profile: Option<&Value>, options: SwingOptions) -> SwingShape {
    let SwingOptions { actor_at, target_at, distance_feet, condition_modifiers, command_advantage, command_disadvantage, extra_advantage } = options;
    let condition_modifiers = condition_modifiers.unwrap_or_else(|| swing_condition_modifiers(state, attacker_id, target_id, profile, distance_feet));
    let attacker = game::find_actor(state, attacker_id);
    let attacker_conditions = condition_ids_for(state, attacker_id);
    let target_conditions = condition_ids_for(state, target_id);
    let adjacent_to = |candidate_id: &str, position: Option<Point>, other_id: &str, other: Option<Point>| {
        position.is_some() && other.is_some() && distance_between_actor_positions(state, candidate_id, position, other_id, other) == Some(5.0)
    };
    let kind = at(profile, "kind").and_then(Value::as_str);
    let attacker_is_enemy = game::is_enemy_actor(state, attacker_id);
    let enemy_adjacent = kind == Some("ranged")
        && game::list_actors(state).into_iter().any(|candidate| {
            let id = game::actor_id(candidate);
            game::is_enemy_actor(state, &id) != attacker_is_enemy && game::is_living_actor(candidate) && adjacent_to(&id, actor_point(state, &id), attacker_id, actor_at)
        });
    let long_range = profile.is_some() && distance_feet.is_some_and(|distance| distance > js::number(at(profile, "normal_range_feet")));
    let allied_support = game::list_actors(state).into_iter().any(|candidate| {
        let id = game::actor_id(candidate);
        id != attacker_id && game::is_enemy_actor(state, &id) == attacker_is_enemy && game::is_living_actor(candidate) && adjacent_to(&id, actor_point(state, &id), target_id, target_at)
    });
    let pack_tactics = monster_trait_for(attacker, "pack-tactics").is_some_and(|value| js::truthy(Some(value))) && allied_support;
    let high_ground = high_ground_between(state, actor_at, target_at, distance_feet);
    let compelled_against_other = game::conditions(state, attacker_id)
        .iter()
        .any(|condition| game::condition_id(condition) == "compelled-duel" && js::s(at(Some(condition), "source_actor")) != target_id);
    let one_shot_disadvantage = attacker_conditions.contains("disadvantage-next-attack") || attacker_conditions.contains("disadvantage-next-weapon-attack") || compelled_against_other;

    let mut advantage_sources: Vec<String> = Vec::new();
    let add = |list: &mut Vec<String>, on: bool, label: &str| {
        if on {
            list.push(label.to_string());
        }
    };
    add(&mut advantage_sources, js::truthy(at(profile, "advantage")), "свойство атаки");
    add(&mut advantage_sources, attacker_conditions.contains("helped"), "помощь союзника");
    add(&mut advantage_sources, attacker_conditions.contains("hidden"), "атака из укрытия");
    add(&mut advantage_sources, attacker_conditions.contains("reckless"), "безрассудная атака");
    add(&mut advantage_sources, attacker_conditions.contains("steady-aim"), "точный прицел");
    add(&mut advantage_sources, active_true_strike_for(state, attacker_id, target_id), "верный удар");
    add(&mut advantage_sources, attacker_conditions.contains("silvery-fortune"), "серебряная удача");
    add(&mut advantage_sources, target_conditions.contains("guiding-bolt-advantage"), "направляющий снаряд");
    add(&mut advantage_sources, target_conditions.contains("faerie-fire"), "огонь фей");
    add(&mut advantage_sources, target_conditions.contains("reckless"), "цель бьётся безрассудно");
    add(&mut advantage_sources, pack_tactics, "тактика стаи");
    add(&mut advantage_sources, high_ground == "higher", "позиция выше цели");
    add(&mut advantage_sources, extra_advantage, "заготовленный эффект");
    advantage_sources.extend(condition_modifiers.advantage.iter().cloned());

    let mut disadvantage_sources: Vec<String> = Vec::new();
    add(&mut disadvantage_sources, js::truthy(at(profile, "disadvantage")), "свойство атаки");
    add(&mut disadvantage_sources, enemy_adjacent, "противник вплотную");
    add(&mut disadvantage_sources, long_range, "дальний диапазон");
    // Туман мешает стрелять только под открытым небом; подпись — из модуля погоды.
    if kind == Some("ranged") {
        if let Some(weather) = sk_world_time::weather::weather_ranged_penalty(state, Some(&Value::String(attacker_id.into()))).filter(|value| js::truthy(Some(value))) {
            disadvantage_sources.push(js::string(weather.get("reason")));
        }
    }
    add(&mut disadvantage_sources, target_conditions.contains("dodging"), "цель уклоняется");
    add(&mut disadvantage_sources, one_shot_disadvantage, "помеха на следующую атаку");
    add(&mut disadvantage_sources, high_ground == "lower", "позиция ниже цели");
    disadvantage_sources.extend(condition_modifiers.disadvantage.iter().cloned());

    let advantage = if profile.is_some() { !advantage_sources.is_empty() } else { command_advantage || !advantage_sources.is_empty() };
    let disadvantage = if profile.is_some() { !disadvantage_sources.is_empty() } else { command_disadvantage || !disadvantage_sources.is_empty() };
    SwingShape {
        advantage,
        disadvantage,
        advantage_sources: unique(advantage_sources),
        disadvantage_sources: unique(disadvantage_sources),
        automatic_critical: condition_modifiers.automatic_critical,
        high_ground,
    }
}

/// `d20HitChance(target, { advantage, disadvantage })`: 20 всегда попадает,
/// 1 всегда мимо.
pub fn d20_hit_chance(target: f64, advantage: bool, disadvantage: bool) -> f64 {
    use crate::tactical_geometry::{js_max, js_min};
    let needed = js_min(20.0, js_max(2.0, target.ceil()));
    let single = (21.0 - needed) / 20.0;
    if advantage == disadvantage {
        return single;
    }
    if advantage {
        1.0 - sk_core::v8math::pow(1.0 - single, 2.0)
    } else {
        sk_core::v8math::pow(single, 2.0)
    }
}

// --- прогноз удара (4213–4256) ------------------------------------------------------

/// Параметры `attackForecast` (`{ actionId, itemId, attackMode, attackAbility }`).
#[derive(Debug, Clone, Copy, Default)]
pub struct ForecastOptions<'a> {
    pub action_id: Option<&'a Value>,
    pub item_id: Option<&'a Value>,
    pub attack_mode: Option<&'a Value>,
    pub attack_ability: Option<&'a Value>,
}

/// `attackForecast(state, attackerId, targetId, options)`: шанс попадания,
/// крита и разбор модификаторов для интерфейса. `None` — участника нет.
pub fn attack_forecast(state: &Value, attacker_id: &str, target_id: &str, options: ForecastOptions<'_>) -> Result<Option<Value>, Halt> {
    let attacker = game::find_actor(state, attacker_id);
    let target = game::find_actor(state, target_id);
    let (Some(attacker), Some(target)) = (attacker, target) else { return Ok(None) };
    let item_profile = if js::truthy(options.item_id) {
        item_attack_profile(state, Some(attacker), options.item_id, AttackOptions { attack_mode: options.attack_mode.filter(|value| !value.is_null()), attack_ability: options.attack_ability.filter(|value| !value.is_null()), off_hand: false })
    } else {
        None
    };
    let profile = match item_profile {
        Some(profile) => profile,
        None => trusted_attack_profile(state, Some(attacker), options.action_id)?,
    };
    let actor_at = actor_point(state, attacker_id);
    let target_at = actor_point(state, target_id);
    let distance_feet = if actor_at.is_some() && target_at.is_some() { distance_between_actor_positions(state, attacker_id, actor_at, target_id, target_at) } else { None };
    let cover = cover_between(state, attacker_id, target_id, actor_at, target_at);
    let cover_bonus = js::number(cover.get("armorClassBonus"));
    let armor_class = effective_armor_class(state, Some(target), target_id)? + cover_bonus;
    let modifier = js::safe_int(profile.get("modifier"), 0) + condition_numeric_bonus(state, attacker_id, "attackBonus");
    let range_feet = js::safe_int(profile.get("range_feet"), 5);
    let in_range = distance_feet.is_some_and(|distance| distance >= 5.0 && distance <= range_feet as f64);
    let blocked_trajectory = in_range && range_feet > 5 && !has_clear_actor_trajectory(state, attacker_id, target_id, actor_at, target_at, false);
    let swing = attack_swing_shape(state, attacker_id, target_id, Some(&profile), SwingOptions { actor_at, target_at, distance_feet, ..SwingOptions::default() });
    let hit_chance = d20_hit_chance(armor_class - modifier as f64, swing.advantage, swing.disadvantage);
    let melee = profile.get("kind").and_then(Value::as_str) == Some("melee");
    let critical_reach = if melee { js::number(profile.get("normal_range_feet")) } else { 5.0 };
    let critical_on_hit = swing.automatic_critical && distance_feet.is_some_and(|distance| distance <= critical_reach);
    let critical_chance = if critical_on_hit { hit_chance } else { d20_hit_chance(20.0, swing.advantage, swing.disadvantage) };
    let reachable = in_range && !blocked_trajectory;
    let action_id = crate::core::coalesce(&[profile.get("id"), options.action_id]);
    let unreachable_reason = if reachable {
        Value::Null
    } else if blocked_trajectory {
        Value::from("линия удара перекрыта")
    } else if distance_feet.is_some_and(|distance| distance < 5.0) {
        Value::from("слишком близко")
    } else {
        Value::from(format!("нужно подойти на {range_feet} фт"))
    };
    let mut result = Map::new();
    result.insert("action_id".into(), Value::String(js::s(action_id)));
    result.insert("attack_mode".into(), crate::core::coalesce(&[profile.get("mode")]).cloned().unwrap_or(Value::Null));
    result.insert("attack_ability".into(), crate::core::coalesce(&[profile.get("ability")]).cloned().unwrap_or(Value::Null));
    result.insert("attack_modifier".into(), Value::from(modifier));
    result.insert("armor_class".into(), js::num(armor_class));
    result.insert("cover_bonus".into(), cover.get("armorClassBonus").cloned().unwrap_or(Value::Null));
    result.insert(
        "cover_label".into(),
        if cover_bonus > 0.0 { crate::core::coalesce(&[cover.get("label")]).cloned().unwrap_or_else(|| Value::from("укрытие")) } else { Value::Null },
    );
    result.insert("distance_feet".into(), distance_feet.map_or(Value::Null, js::num));
    result.insert("range_feet".into(), Value::from(range_feet));
    result.insert("in_range".into(), Value::Bool(reachable));
    result.insert("unreachable_reason".into(), unreachable_reason);
    result.insert("advantage".into(), Value::Bool(reachable && swing.advantage));
    result.insert("disadvantage".into(), Value::Bool(reachable && swing.disadvantage));
    result.insert("advantage_sources".into(), if reachable { js::strings_value(swing.advantage_sources.clone()) } else { json!([]) });
    result.insert("disadvantage_sources".into(), if reachable { js::strings_value(swing.disadvantage_sources.clone()) } else { json!([]) });
    result.insert("hit_chance".into(), if reachable { js::num(js::round(hit_chance * 100.0)) } else { Value::Null });
    result.insert("critical_chance".into(), if reachable { js::num(js::round(critical_chance * 100.0)) } else { Value::Null });
    result.insert("critical_on_hit".into(), Value::Bool(reachable && critical_on_hit));
    result.insert("average_damage".into(), js::num(average_damage_of(Some(&profile))));
    Ok(Some(Value::Object(result)))
}

// --- составные манёвры (3929–4211) --------------------------------------------------

/// `{ ...state, mechanics: { ...mechanics, positions: { ...positions, [id]: to } } }`.
fn state_at(state: &Value, actor_id: &str, to: Point) -> Value {
    let mut next = state.clone();
    if let Some(root) = next.as_object_mut() {
        let mechanics = root.entry("mechanics").or_insert_with(js::obj);
        if !mechanics.is_object() {
            *mechanics = js::obj();
        }
        let positions = js::object_mut(mechanics, "positions");
        positions.insert(actor_id.to_string(), point_json(to));
    }
    next
}

/// `validateCommand(command, state, { allowedActorIds: [actorId] })`.
fn validate_from(command: &Value, state: &Value, actor_id: &str) -> Result<Value, Halt> {
    let context = Context::from_json(&json!({ "allowedActorIds": [actor_id] }));
    let mut uuid = crate::context::random_uuid;
    crate::resolve::api::validate(command, state, &context, &mut uuid)
}

/// `forecast?.in_range`.
fn forecast_in_range(state: &Value, actor_id: &str, target_id: &str, item_id: Option<&Value>) -> Result<bool, Halt> {
    let forecast = attack_forecast(state, actor_id, target_id, ForecastOptions { item_id, ..ForecastOptions::default() })?;
    Ok(js::truthy(forecast.as_ref().and_then(|forecast| forecast.get("in_range"))))
}

/// `Math.max(1, Math.min(6, Math.floor(Number(profile.range_feet || 5) / 5)))`.
fn reach_radius(profile: &Value) -> i64 {
    let range = profile.get("range_feet").filter(|value| js::truthy(Some(value))).map_or(5.0, |value| js::number(Some(value)));
    crate::tactical_geometry::js_max(1.0, crate::tactical_geometry::js_min(6.0, (range / 5.0).floor())) as i64
}

/// Сравнение кандидатов: `a.cost - b.cost || a.to.y - b.to.y || a.to.x - b.to.x`.
fn by_cost_then_cell(a: (f64, Point), b: (f64, Point)) -> std::cmp::Ordering {
    let order = |left: f64, right: f64| left.partial_cmp(&right).unwrap_or(std::cmp::Ordering::Equal);
    order(a.0, b.0).then(order(a.1.y, b.1.y)).then(order(a.1.x, b.1.x))
}

/// `Number(economy.attacks_used) > 0 && Number(economy.attacks_used) < Number(economy.attacks_allowed)`.
fn attack_continuation(state: &Value, actor_id: &str) -> bool {
    let economy = at(game::combat(state).get("action_economy"), actor_id);
    let used = js::number(at(economy, "attacks_used"));
    used > 0.0 && used < js::number(at(economy, "attacks_allowed"))
}

/// `defaultAttackItemIdFor(rawState, actorId, targetId)`: надетое оружие героя
/// для атаки без `item_id` — ближнее, иначе первое, которым цель достаётся.
pub fn default_attack_item_id_for(raw_state: &Value, actor_id: &str, target_id: &str) -> Result<Option<String>, Halt> {
    let state = normalize_campaign_state_cow(raw_state)?;
    let actor = game::find_actor(&state, actor_id);
    if actor.is_none() || game::find_actor(&state, target_id).is_none() {
        return Ok(None);
    }
    let mut usable = Vec::new();
    for weapon in equipped_weapon_attacks(&state, actor) {
        let item = Value::String(weapon.item_id.clone());
        if forecast_in_range(&state, actor_id, target_id, Some(&item))? {
            usable.push(weapon);
        }
    }
    let melee = usable.iter().find(|weapon| weapon.profile.get("kind").and_then(Value::as_str) == Some("melee"));
    Ok(melee.or(usable.first()).map(|weapon| weapon.item_id.clone()))
}

/// `previewApproachAttack(rawState, actorId, targetId)`: маршрут составной
/// ближней атаки — подход по самому дешёвому пути и удар.
pub fn preview_approach_attack(raw_state: &Value, actor_id: &str, target_id: &str) -> Result<Value, Halt> {
    let state = normalize_campaign_state_cow(raw_state)?;
    let actor = game::find_actor(&state, actor_id);
    let target = game::find_actor(&state, target_id);
    if !game::combat_active(&state) {
        return Err(rule("Такой манёвр доступен после начала боя", "COMBAT_REQUIRED"));
    }
    if actor.is_none() || !target.is_some_and(|target| game::is_enemy_actor(&state, target_id) && game::is_living_actor(target)) {
        return Err(rule("Выберите живого противника на карте", "INVALID_TARGET"));
    }
    let weapon = equipped_weapon_attacks(&state, actor).into_iter().find(|candidate| candidate.profile.get("kind").and_then(Value::as_str) == Some("melee"));
    let profile = match &weapon {
        Some(weapon) => weapon.profile.clone(),
        None => trusted_attack_profile(&state, actor, None)?,
    };
    let weapon_item = weapon.as_ref().map(|weapon| Value::String(weapon.item_id.clone()));
    if profile.get("kind").and_then(Value::as_str) != Some("melee") {
        return Err(rule("Для этого манёвра нужно оружие ближнего боя", "MELEE_WEAPON_REQUIRED"));
    }
    let (Some(from), Some(target_at)) = (actor_point(&state, actor_id), actor_point(&state, target_id)) else {
        return Err(rule("Герой и противник должны находиться на карте", "MAP_POSITION_REQUIRED"));
    };
    let cost = movement_step_cost_for(&state, actor_id, None);
    let map = cost.map();
    let cells = tactical_cell_map(&state);
    if !cells.get(&key_of(target_at)).is_some_and(|cell| !js::is_false(cell.get("revealed"))) {
        return Err(rule("Цель находится в нераскрытой части карты", "TARGET_NOT_VISIBLE"));
    }
    let occupied = occupied_positions(&state, Some(actor_id), true);
    let budget = js::number(movement_for_actor(&state, actor_id).get("movement_remaining"));
    let radius = reach_radius(&profile);
    let mut attack = Map::new();
    attack.insert("command_type".into(), Value::from("MakeAttack"));
    attack.insert("actor_id".into(), Value::from(actor_id));
    attack.insert("target_id".into(), Value::from(target_id));
    if let Some(item) = &weapon_item {
        attack.insert("item_id".into(), item.clone());
    }
    attack.insert("server_authoritative".into(), Value::Bool(true));
    let attack = Value::Object(attack);
    let mut attack_refusal: Option<Halt> = None;
    let step = |point: Point, path_map: Option<&sk_tactical::tactical_map::TacticalMap>| cost.step_cost_on(point, path_map);
    let mut candidates: Vec<(Point, Vec<Point>, f64)> = Vec::new();
    for dx in -radius..=radius {
        for dy in -radius..=radius {
            let to = Point::new(target_at.x + dx as f64, target_at.y + dy as f64);
            if !actor_footprint_fits(&state, actor_id, to, FitOptions { map: Some(map), cells: Some(&cells), occupied: Some(&occupied), ..FitOptions::default() }) {
                continue;
            }
            let Some(path) = shortest_tactical_path(&state, actor_id, to, PathOptions { tactical_map: Some(map), step_cost: Some(&step), ..PathOptions::default() }) else { continue };
            if path.iter().any(|cell| cells.get(&key_of(*cell)).is_some_and(|cell| js::is_false(cell.get("revealed")))) {
                continue;
            }
            if !path.is_empty() && assert_voluntary_movement_path(&state, actor_id, from, to, &path).is_err() {
                continue;
            }
            let total: f64 = path.iter().map(|cell| cost.step_cost_on(*cell, map)).sum();
            if total > budget {
                continue;
            }
            let at_destination = state_at(&state, actor_id, to);
            if !forecast_in_range(&at_destination, actor_id, target_id, weapon_item.as_ref())? {
                continue;
            }
            match validate_from(&attack, &at_destination, actor_id) {
                Ok(_) => {}
                Err(error) if error.is_rule() => {
                    if attack_refusal.is_none() {
                        attack_refusal = Some(error);
                    }
                    continue;
                }
                Err(error) => return Err(error),
            }
            candidates.push((to, path, total));
        }
    }
    // `dx`/`dy` от `-radius` — тот же порядок, что `x`/`y` от `target - radius` в JS.
    candidates.sort_by(|a, b| by_cost_then_cell((a.2, a.0), (b.2, b.0)));
    let Some((to, path, total)) = candidates.into_iter().next() else {
        return Err(attack_refusal.unwrap_or_else(|| rule("Не хватает свободного пути или скорости, чтобы подойти и атаковать", "APPROACH_UNREACHABLE")));
    };
    let movement = json!({ "command_type": "MoveActor", "actor_id": actor_id, "to": point_json(to), "server_authoritative": true });
    if !path.is_empty() {
        validate_from(&movement, &state, actor_id)?;
    }
    let mut commands = Vec::new();
    if !path.is_empty() {
        commands.push(movement);
    }
    commands.push(attack);
    let continuation = attack_continuation(&state, actor_id);
    Ok(json!({
        "commands": commands,
        "path": points_json(&path),
        "to": point_json(to),
        "movement_feet": js::num(total),
        "attack_cost": if continuation { "одна оставшаяся атака" } else { "действие «Атака» (один удар)" },
    }))
}

/// Клетка опоры реквизита: первая клетка площади или округлённые координаты.
fn public_anchor(prop: &sk_tactical::tactical_map::TacticalProp) -> Point {
    match prop.footprint.first() {
        Some(cell) => Point::new(cell.x as f64, cell.y as f64),
        None => Point::new(prop.x.floor(), prop.y.floor()),
    }
}

/// `swingPropForText(rawState, text)`: люстра, к которой просит прыгнуть
/// свободная заявка; несколько подходящих — отказ с перечнем.
pub fn swing_prop_for_text(raw_state: &Value, text_value: Option<&Value>) -> Result<Option<Value>, Halt> {
    let state = normalize_campaign_state_cow(raw_state)?;
    let text_raw = match text_value {
        None => String::new(),
        Some(value) => js::string(Some(value)),
    };
    let mention = sk_core::re!(r"(люстр|chandelier)", "iu");
    if !text::test(mention, &text_raw) {
        return Ok(None);
    }
    let map = scene_tactical_map(&state);
    let cells = tactical_cell_map(&state);
    let props: &[sk_tactical::tactical_map::TacticalProp] = map.as_ref().map_or(&[], |map| map.props.as_slice());
    // `prop.level_index ?? prop.levelIndex`: у разобранного реквизита карты
    // таких полей нет, и фильтр по этажу JS никогда не срабатывает.
    let visible: Vec<&sk_tactical::tactical_map::TacticalProp> = props
        .iter()
        .filter(|prop| {
            if sk_combat_content::scene_hazards::swing_prop_profile_for(Some(&Value::String(prop.asset_id.clone()))).is_none() {
                return false;
            }
            cells.get(&key_of(public_anchor(prop))).is_some_and(|cell| js::is_true(cell.get("revealed")))
        })
        .collect();
    let normalized = text::lower(&text::nfkc(&text_raw));
    let label_of = |prop: &sk_tactical::tactical_map::TacticalProp| sk_tactical::scene_interactions::scene_object_label_for(Some(&Value::String(prop.asset_id.clone())));
    let coordinate = |anchor: Point| format!("{},{}", js::f64_string(anchor.x), js::f64_string(anchor.y));
    let selected: Vec<&sk_tactical::tactical_map::TacticalProp> = visible
        .iter()
        .copied()
        .filter(|prop| {
            let anchor = public_anchor(prop);
            let label = text::lower(&label_of(prop));
            let id = text::lower(&prop.id);
            let coordinate = coordinate(anchor);
            (!id.is_empty() && normalized.contains(&id))
                || (!label.is_empty() && normalized.contains(&format!("{label} {coordinate}")))
                || (!label.is_empty() && normalized.contains(&format!("{label} у {coordinate}")))
                || (normalized.contains(&coordinate) && text::test(sk_core::re!(r"люстр|chandelier", "iu"), &normalized))
        })
        .collect();
    let candidates = if selected.is_empty() { visible } else { selected };
    if candidates.len() > 1 {
        let labels: Vec<String> = candidates
            .iter()
            .map(|prop| {
                let label = label_of(prop);
                let label = if label.is_empty() { "предмет".to_string() } else { label };
                format!("{label} у опоры {}", coordinate(public_anchor(prop)))
            })
            .collect();
        return Err(rule(format!("Уточните, к какой опоре прыгнуть: {}", labels.join(", ")), "SWING_PROP_AMBIGUOUS"));
    }
    Ok(candidates.first().map(|prop| prop.to_json()))
}

/// Общая часть прыжковых манёвров: живой противник на раскрытой клетке.
fn jump_target(state: &Value, target_id: &str) -> Result<(), Halt> {
    let target = game::find_actor(state, target_id);
    if !target.is_some_and(|target| game::is_enemy_actor(state, target_id) && game::is_living_actor(target)) {
        return Err(rule("Выберите живого противника на карте", "INVALID_TARGET"));
    }
    Ok(())
}

/// `previewSwingAttack(rawState, actorId, targetId, propId, { runningStart })`:
/// прыжок на опоре сцены и обычная ближняя атака.
pub fn preview_swing_attack(raw_state: &Value, actor_id: &str, target_id: &str, prop_id: Option<&Value>, running_start: bool) -> Result<Value, Halt> {
    let state = normalize_campaign_state_cow(raw_state)?;
    let details = swing_details_for(&state, actor_id, prop_id, running_start)?;
    if !game::combat_active(&state) {
        return Err(rule("Такой манёвр доступен после начала боя", "COMBAT_REQUIRED"));
    }
    jump_target(&state, target_id)?;
    let profile = trusted_attack_profile(&state, Some(&details.actor), None)?;
    if profile.get("kind").and_then(Value::as_str) != Some("melee") {
        return Err(rule("Для swing с атакой нужно оружие ближнего боя", "MELEE_WEAPON_REQUIRED"));
    }
    let target_at = actor_point(&state, target_id);
    let cells = tactical_cell_map(&state);
    let map = scene_tactical_map(&state);
    let target_cell = target_at.and_then(|point| cells.get(&key_of(point)).copied());
    let (Some(target_at), Some(target_cell)) = (target_at, target_cell) else {
        return Err(rule("Противник должен находиться на карте", "MAP_POSITION_REQUIRED"));
    };
    if js::is_false(target_cell.get("revealed")) {
        return Err(rule("Цель находится в нераскрытой части карты", "TARGET_NOT_VISIBLE"));
    }
    let radius = reach_radius(&profile);
    let occupied = occupied_positions(&state, Some(actor_id), true);
    let attack = json!({ "command_type": "MakeAttack", "actor_id": actor_id, "target_id": target_id, "server_authoritative": true });
    let mut candidates: Vec<(LongJump, Point)> = Vec::new();
    for dx in -radius..=radius {
        for dy in -radius..=radius {
            let to = Point::new(target_at.x + dx as f64, target_at.y + dy as f64);
            if !actor_footprint_fits(&state, actor_id, to, FitOptions { map: Some(map.as_ref()), cells: Some(&cells), occupied: Some(&occupied), ..FitOptions::default() }) {
                continue;
            }
            let Ok(route) = long_jump_movement_for(&state, actor_id, Some(&point_json(to)), running_start, 5.0) else { continue };
            let landing = state_at(&state, actor_id, to);
            if !forecast_in_range(&landing, actor_id, target_id, None)? {
                continue;
            }
            match validate_from(&attack, &landing, actor_id) {
                Ok(_) => {}
                Err(error) if error.is_rule() => continue,
                Err(error) => return Err(error),
            }
            candidates.push((route, to));
        }
    }
    candidates.sort_by(|a, b| by_cost_then_cell((a.0.distance_feet, a.1), (b.0.distance_feet, b.1)));
    let Some((route, to)) = candidates.into_iter().next() else {
        return Err(rule("Не хватает прыжка, свободной скорости или места для swing-приземления", "SWING_UNREACHABLE"));
    };
    let check = details.profile.get("check");
    let mut ruling = Map::new();
    ruling.insert("policy_id".into(), Value::from(sk_combat_content::scene_hazards::SCENE_SWING_POLICY_ID));
    ruling.insert("status".into(), Value::from("ruling"));
    ruling.insert("prop_id".into(), Value::String(js::string(prop_id)));
    for key in ["ability", "skill", "difficulty"] {
        if let Some(value) = at(check, key) {
            ruling.insert(key.into(), value.clone());
        }
    }
    ruling.insert("on_failure".into(), Value::from("Герой срывается и падает ничком у точки опоры; удар не происходит."));
    let ruling = Value::Object(ruling);
    let mut prop = Map::new();
    prop.insert("id".into(), Value::String(js::string(prop_id)));
    prop.insert("asset_id".into(), Value::String(js::string(details.prop.get("assetId"))));
    if let Some(height) = details.profile.get("height_feet") {
        prop.insert("height_feet".into(), height.clone());
    }
    if let Some(anchor) = details.profile.get("anchor") {
        prop.insert("anchor".into(), anchor.clone());
    }
    Ok(json!({
        "commands": [
            {
                "command_type": "MoveActor", "actor_id": actor_id, "to": point_json(to),
                "movement_mode": "swing", "swing_prop_id": js::string(prop_id), "swing_running_start": running_start,
                "swing_ruling": ruling, "house_rule_id": sk_combat_content::scene_hazards::SCENE_SWING_POLICY_ID, "server_authoritative": true,
            },
            attack,
        ],
        "path": points_json(&route.path),
        "to": point_json(to),
        "movement_feet": js::num(route.distance_feet),
        "ruling": ruling,
        "attack_cost": "действие «Атака» (один удар)",
        "prop": Value::Object(prop),
    }))
}

/// `previewLongJumpAttack(rawState, actorId, targetId, { runningStart })`:
/// горизонтальный прыжок в длину и одна ближняя атака.
pub fn preview_long_jump_attack(raw_state: &Value, actor_id: &str, target_id: &str, running_start: bool) -> Result<Value, Halt> {
    let state = normalize_campaign_state_cow(raw_state)?;
    let actor = game::find_actor(&state, actor_id);
    if !game::combat_active(&state) {
        return Err(rule("Такой манёвр доступен после начала боя", "COMBAT_REQUIRED"));
    }
    let Some(actor) = actor else { return Err(rule("Выберите живого противника на карте", "INVALID_TARGET")) };
    jump_target(&state, target_id)?;
    let profile = trusted_attack_profile(&state, Some(actor), None)?;
    if profile.get("kind").and_then(Value::as_str) != Some("melee") {
        return Err(rule("Для прыжка с атакой нужно оружие ближнего боя", "MELEE_WEAPON_REQUIRED"));
    }
    let (Some(_), Some(target_at)) = (actor_point(&state, actor_id), actor_point(&state, target_id)) else {
        return Err(rule("Герой и противник должны находиться на карте", "MAP_POSITION_REQUIRED"));
    };
    let cells = tactical_cell_map(&state);
    if !cells.get(&key(target_at.x, target_at.y)).is_some_and(|cell| !js::is_false(cell.get("revealed"))) {
        return Err(rule("Цель находится в нераскрытой части карты", "TARGET_NOT_VISIBLE"));
    }
    let economy = at(game::combat(&state).get("action_economy"), actor_id);
    let movement_spent = js::safe_int(at(economy, "movement_spent"), 0).max(0);
    if running_start && movement_spent < 10 {
        return Err(rule("Для прыжка с разбега сначала нужно потратить 10 фт на разбег", "JUMP_RUNNING_START_REQUIRED"));
    }
    let strength_score = js::safe_int(at(actor.get("abilities"), "str"), 10).max(1);
    let maximum_jump_feet = if running_start { strength_score } else { strength_score.div_euclid(2) };
    let radius = reach_radius(&profile);
    let occupied = occupied_positions(&state, Some(actor_id), true);
    let attack = json!({ "command_type": "MakeAttack", "actor_id": actor_id, "target_id": target_id, "server_authoritative": true });
    let mut candidates: Vec<(LongJump, Point)> = Vec::new();
    for dx in -radius..=radius {
        for dy in -radius..=radius {
            let to = Point::new(target_at.x + dx as f64, target_at.y + dy as f64);
            let map = scene_tactical_map(&state);
            if !actor_footprint_fits(&state, actor_id, to, FitOptions { map: Some(map.as_ref()), cells: Some(&cells), occupied: Some(&occupied), ..FitOptions::default() }) {
                continue;
            }
            let Ok(jump) = long_jump_movement_for(&state, actor_id, Some(&point_json(to)), running_start, 5.0) else { continue };
            let at_destination = state_at(&state, actor_id, to);
            if !forecast_in_range(&at_destination, actor_id, target_id, None)? {
                continue;
            }
            match validate_from(&attack, &at_destination, actor_id) {
                Ok(_) => {}
                Err(error) if error.is_rule() => continue,
                Err(error) => return Err(error),
            }
            candidates.push((jump, to));
        }
    }
    candidates.sort_by(|a, b| by_cost_then_cell((a.0.distance_feet, a.1), (b.0.distance_feet, b.1)));
    let Some((jump, to)) = candidates.into_iter().next() else {
        return Err(rule("Не хватает длины прыжка, свободной скорости или места для приземления", "JUMP_UNREACHABLE"));
    };
    let continuation = attack_continuation(&state, actor_id);
    Ok(json!({
        "commands": [
            { "command_type": "MoveActor", "actor_id": actor_id, "to": point_json(to), "movement_mode": "long_jump", "jump_running_start": running_start, "server_authoritative": true },
            attack,
        ],
        "path": points_json(&jump.path),
        "to": point_json(to),
        "movement_feet": js::num(jump.distance_feet),
        "jump": { "kind": "long", "running_start": running_start, "distance_feet": js::num(jump.distance_feet), "maximum_feet": maximum_jump_feet },
        "attack_cost": if continuation { "одна оставшаяся атака" } else { "действие «Атака» (один удар)" },
    }))
}

// --- особое действие существа (5065–5103) --------------------------------------------

/// `serverOwnedMonsterActor(actor, state)`: стат-блок принадлежит серверу —
/// запись бестиария 2014 или авторский NPC мира с проверенными приёмами.
pub fn server_owned_monster_actor<'a>(actor: Option<&'a Value>, state: &Value) -> Option<&'a Value> {
    if crate::checks::skills::server_owned_2014_stat_block_for(actor, Some(state)).is_some() {
        return actor;
    }
    let actor_value = actor?;
    let enemies = state.get("enemies").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    // `candidate === actor`: та же запись списка противников, не копия.
    let enemy = enemies.iter().any(|candidate| std::ptr::eq(candidate, actor_value));
    let authored = at(at(actor, "origin"), "kind").and_then(Value::as_str) == Some("authored-npc")
        && at(at(actor, "provenance"), "kind").and_then(Value::as_str) == Some("server-owned-authored-npc-profile");
    (enemy && authored).then_some(actor_value)
}

/// `conditionIdsFor(state, id)` значениями: множество, которое JS передаёт
/// модулю приёмов существ (`[...conditions]`).
pub fn condition_id_values(state: &Value, id: &str) -> Vec<Value> {
    condition_ids_for(state, id).into_iter().map(Value::String).collect()
}

/// Итог `previewMonsterAction`: `{ action, origin, to, affectedIds }`.
#[derive(Debug, Clone, PartialEq)]
pub struct MonsterActionPreview {
    pub action: Value,
    pub origin: Point,
    pub to: Point,
    pub affected_ids: Vec<String>,
}

impl MonsterActionPreview {
    pub fn to_value(&self) -> Value {
        json!({ "action": self.action, "origin": point_json(self.origin), "to": point_json(self.to), "affectedIds": self.affected_ids })
    }
}

/// `previewMonsterAction(rawState, id, actionId, toward)`: формализованная
/// область особого действия и задетые ею существа.
pub fn preview_monster_action(raw_state: &Value, id: &str, action_id: Option<&Value>, toward: Option<&Value>) -> Result<MonsterActionPreview, Halt> {
    let state = normalize_campaign_state_cow(raw_state)?;
    let actor = game::find_actor(&state, id);
    let Some(actor) = server_owned_monster_actor(actor, &state).filter(|actor| game::is_living_actor(actor)) else {
        return Err(rule("Приём доступен только действующему существу из каталога 2014", "MONSTER_ACTION_NOT_AVAILABLE"));
    };
    let wanted = js::string(action_id);
    let actions = actor.get("special_actions").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let source = actions.iter().find(|action| js::string(action.get("id")) == wanted);
    let Some(action) = sk_combat_base::monster_actions::monster_area_action(source) else {
        return Err(rule("Для особого действия ещё нет исполняемого обработчика", "MONSTER_ACTION_UNSUPPORTED"));
    };
    if !sk_combat_base::monster_actions::monster_action_available(Some(&action), &condition_id_values(&state, id)) {
        return Err(rule("Приём ещё не восстановился", "MONSTER_ACTION_SPENT"));
    }
    let origin = actor_point(&state, id);
    let coordinate = |key: &str| match at(toward, key).filter(|value| !value.is_null()) {
        Some(value) => js::number(Some(value)),
        None => origin.map_or(f64::NAN, |origin| if key == "x" { origin.x } else { origin.y }),
    };
    let to = Point::new(coordinate("x"), coordinate("y"));
    let safe = |value: f64| value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0;
    let Some(origin) = origin.filter(|_| safe(to.x) && safe(to.y)) else {
        return Err(rule("Нужно направление на карте", "MAP_POSITION_REQUIRED"));
    };
    let shape = js::s(action.get("shape"));
    if shape != "sphere" && to.x == origin.x && to.y == origin.y {
        return Err(rule("Нужно направление от существа", "MONSTER_ACTION_DIRECTION_REQUIRED"));
    }
    let length = js::number(action.get("length_feet"));
    let line: Option<std::collections::HashSet<crate::tactical_geometry::Key>> = (shape == "line").then(|| {
        let command = json!({ "actor_id": id, "to": point_json(to) });
        let spell = json!({ "areaOrigin": "self", "radius": action.get("length_feet").cloned().unwrap_or(Value::Null) });
        crate::areas::shape::wall_cells(&state, &command, &spell).into_iter().map(key_of).collect()
    });
    let mut affected_ids = Vec::new();
    for target in game::list_actors(&state) {
        let target_id = game::actor_id(target);
        if target_id == id || (!game::is_living_actor(target) && !crate::targets::is_dying_hero(&state, &target_id)) {
            continue;
        }
        let Some(position) = actor_point(&state, &target_id) else { continue };
        if !has_clear_actor_trajectory(&state, id, &target_id, Some(origin), Some(position), false) {
            continue;
        }
        let target_cells = crate::tactical_geometry::actor_footprint_cells_at(&state, &target_id, Some(position));
        let caught = if shape == "cone" {
            crate::areas::shape::actor_in_area(&state, &target_id, Some(position), Some(to), length, "cone", Some(id), Some(origin))
        } else if let Some(line) = &line {
            target_cells.iter().any(|cell| line.contains(&key_of(*cell)))
        } else {
            crate::areas::shape::actor_in_area(&state, &target_id, Some(position), Some(origin), length, "sphere", Some(id), Some(origin))
        };
        if caught {
            affected_ids.push(target_id);
        }
    }
    if affected_ids.is_empty() {
        return Err(rule("В области нет целей", "MONSTER_ACTION_NO_TARGETS"));
    }
    let charmer = game::conditions(&state, id)
        .iter()
        .any(|condition| condition.get("id").and_then(Value::as_str) == Some("charmed") && affected_ids.contains(&js::string(condition.get("source_actor"))));
    if charmer {
        return Err(rule("Очарованное существо не может навредить очаровавшему его", "CHARMED_ATTACK_FORBIDDEN"));
    }
    Ok(MonsterActionPreview { action, origin, to, affected_ids })
}

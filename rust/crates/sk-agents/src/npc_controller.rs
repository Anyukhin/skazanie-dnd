//! Перенос `server/npc-controller.mjs`: мораль и перелом боя NPC
//! (`NpcMoraleAgent`, промпт `prompts/npc_controller/v1.txt`).
//!
//! Вне момента морали [`NpcMoraleAgent::decide`] возвращает `None`: обычные
//! ходы NPC — детерминированная политика сервера, модель зовётся только на
//! переломе. Без модели и при её отказе исход даёт детерминированная монетка
//! от кампании, врага и раунда. [`commands_for_morale_decision`] переводит
//! решение в команды Rules Engine (`AddCondition`, `MoveActor`).

use serde_json::{json, Value};
use sk_core::{js, re, text};
use sk_geometry::Point;
use sk_rules::tactical_geometry::{shortest_tactical_path, PathOptions};
use sk_ruleset::rules_actors::{actor_position, find_actor, is_enemy_actor, is_living_actor};

use crate::director_agent::RoleClient;

const PROMPT: &str = include_str!("../../../../prompts/npc_controller/v1.txt");
const DISPOSITIONS: [&str; 3] = ["fight", "flee", "surrender"];
const FINAL_MORALE_CONDITIONS: [&str; 2] = ["fled", "surrendered"];

fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value?.as_object()?.get(key)
}

fn path<'a>(value: Option<&'a Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().try_fold(value?, |current, key| get(Some(current), key))
}

fn coalesce<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    match first {
        Some(value) if !value.is_null() => Some(value),
        _ => second,
    }
}

fn head_utf16(source: &str, max: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for ch in source.chars() {
        let width = ch.len_utf16();
        if units + width > max {
            break;
        }
        units += width;
        out.push(ch);
    }
    out
}

/// `Number(x) || fallback`.
fn number_or(value: Option<&Value>, fallback: f64) -> f64 {
    let number = js::number(value);
    if number == 0.0 || number.is_nan() {
        fallback
    } else {
        number
    }
}

fn actor_id(actor: Option<&Value>) -> String {
    js::s(coalesce(get(actor, "id"), get(actor, "actor_id")))
}

/// `String(actor?.character ?? actor?.name ?? actorId(actor) ?? 'NPC').slice(0, 100)`.
fn actor_name(actor: Option<&Value>) -> String {
    let name = match coalesce(get(actor, "character"), get(actor, "name")) {
        Some(value) => js::string(Some(value)),
        None => actor_id(actor),
    };
    head_utf16(&name, 100)
}

fn conditions_for<'a>(state: &'a Value, id: &str) -> &'a [Value] {
    match path(Some(state), &["mechanics", "conditions", id]) {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

fn condition_label(entry: &Value) -> String {
    js::string(coalesce(get(Some(entry), "id"), Some(entry)))
}

fn has_condition(state: &Value, id: &str, condition: &str) -> bool {
    conditions_for(state, id).iter().any(|entry| condition_label(entry) == condition)
}

fn hp_of(actor: Option<&Value>) -> f64 {
    number_or(get(actor, "hp"), 0.0).max(0.0)
}

/// `Math.max(1, Number(maxHp ?? max_hp) || fallback)`.
fn max_hp_of(actor: Option<&Value>, fallback: f64) -> f64 {
    let value = js::number(coalesce(get(actor, "maxHp"), get(actor, "max_hp")));
    let value = if value == 0.0 || value.is_nan() { fallback } else { value };
    if value.is_nan() {
        f64::NAN
    } else {
        value.max(1.0)
    }
}

fn boss_morale(state: &Value, id: &str) -> Option<Value> {
    sk_scenario::campaign_scenario::scenario_boss_morale(state, id)
}

/// `isMoraleMoment(state, enemyId)`: живой враг на пороге морали, ещё не
/// проверенный и не сбежавший/сдавшийся.
pub fn is_morale_moment(state: &Value, enemy_id: &str) -> bool {
    let enemy = find_actor(Some(state), enemy_id);
    if enemy.is_none() || !is_enemy_actor(Some(state), enemy_id) || !is_living_actor(enemy) {
        return false;
    }
    if has_condition(state, enemy_id, "morale-tested") || FINAL_MORALE_CONDITIONS.iter().any(|condition| has_condition(state, enemy_id, condition)) {
        return false;
    }
    let hp = hp_of(enemy);
    let fallback = if hp == 0.0 { 1.0 } else { hp };
    let max_hp = max_hp_of(enemy, fallback);
    // Главный противник сценария проверяет мораль на своём пороге. Порог, не
    // ставший числом (`null` из `NaN`), сравнивается как `NaN` — ложь.
    let threshold = match boss_morale(state, enemy_id) {
        Some(morale) => match morale.get("threshold") {
            Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
            _ => f64::NAN,
        },
        None => 0.3,
    };
    hp / max_hp <= threshold
}

fn coin(state: &Value, enemy: Option<&Value>, suffix: &str) -> u8 {
    let campaign = js::s(coalesce(get(Some(state), "campaign_id"), get(Some(state), "sessionCode")));
    let round = coalesce(path(Some(state), &["mechanics", "combat", "round"]), None).map_or_else(|| "0".to_string(), |value| js::s(Some(value)));
    sk_core::hash::sha256(format!("{campaign}:{}:{round}{suffix}", actor_id(enemy)))[0]
}

fn local_disposition(state: &Value, enemy: Option<&Value>) -> &'static str {
    // Сломленный главный противник сценария улетает, а не сдаётся в плен.
    if boss_morale(state, &actor_id(enemy)).is_some() {
        return if coin(state, enemy, ":boss") % 2 == 0 { "fight" } else { "flee" };
    }
    let identity = text::lower(&format!("{} {} {}", actor_name(enemy), js::s(get(enemy, "kind")), js::s(get(enemy, "type"))));
    if text::test(re!(r"нежит|скелет|зомби|конструкт|голем|автомат", "u"), &identity) {
        return "fight";
    }
    if text::test(re!(r"звер|волк|паук|крыса|животн", "u"), &identity) {
        return "flee";
    }
    match coin(state, enemy, "") % 3 {
        0 => "fight",
        1 => "flee",
        _ => "surrender",
    }
}

fn normalize_decision(value: Option<&Value>, fallback: &str, expected_id: &str) -> serde_json::Map<String, Value> {
    let disposition = match get(value, "disposition") {
        Some(Value::String(kind)) if DISPOSITIONS.contains(&kind.as_str()) => kind.clone(),
        _ => fallback.to_string(),
    };
    let reaction = head_utf16(text::trim(&text::replace_all(re!(r"[\r\n]+", "g"), &js::s(get(value, "reaction")), " ")), 240);
    let confidence = number_or(get(value, "confidence"), 0.0).clamp(0.0, 1.0);
    let mut decision = serde_json::Map::new();
    decision.insert("npc_id".into(), Value::String(expected_id.to_string()));
    decision.insert("disposition".into(), Value::String(disposition));
    decision.insert("reaction".into(), Value::String(reaction));
    decision.insert("confidence".into(), js::num(confidence));
    decision
}

/// Бриф модели о сломленном NPC: только видимое отряду.
pub fn public_brief(state: &Value, enemy: &Value) -> Value {
    let enemy = Some(enemy);
    let id = actor_id(enemy);
    let conditions: Vec<Value> = conditions_for(state, &id).iter().map(|entry| Value::String(condition_label(entry))).take(12).collect();
    let heroes: Vec<Value> = match get(Some(state), "players") {
        Some(Value::Array(players)) => {
            players.iter().filter(|hero| is_living_actor(Some(hero))).map(|hero| json!({ "id": actor_id(Some(hero)), "name": actor_name(Some(hero)) })).take(8).collect()
        }
        _ => Vec::new(),
    };
    json!({
        "npc": {
            "id": id,
            "name": actor_name(enemy),
            "kind": js::s(coalesce(get(enemy, "kind"), get(enemy, "type"))),
            "hp": js::num(hp_of(enemy)),
            "max_hp": js::num(max_hp_of(enemy, 1.0)),
            "visible_conditions": conditions,
        },
        "scene": {
            "title": js::s(path(Some(state), &["scene", "title"])),
            "location": js::s(path(Some(state), &["scene", "location"])),
            "mood": js::s(path(Some(state), &["scene", "mood"])),
            "objective": js::s(path(Some(state), &["scene", "objective"])),
        },
        "campaign_premise": sk_encounters::agent_context::campaign_concept_for_agent(state, None),
        "visible_heroes": heroes,
        "allowed_dispositions": DISPOSITIONS,
    })
}

/// `NpcMoraleAgent`: только мораль и перелом боя.
#[derive(Clone, Debug, Default)]
pub struct NpcMoraleAgent {
    llm_client: Option<RoleClient>,
}

impl NpcMoraleAgent {
    /// `new NpcMoraleAgent({ llmClient })`.
    pub fn new(llm_client: Option<RoleClient>) -> Self {
        NpcMoraleAgent { llm_client }
    }

    /// Запрос к модели, который отправил бы [`Self::decide`].
    pub fn model_request(state: &Value, enemy: &Value) -> Value {
        json!({
            "messages": [
                { "role": "system", "content": PROMPT },
                { "role": "user", "content": sk_tactics::security::build_data_only_context(Some(&json!({ "npc_morale_brief": public_brief(state, enemy) }))) },
            ],
            "temperature": 0.65,
            "maxTokens": 300,
        })
    }

    /// `decide({ state, enemyId })`: `{ npc_id, disposition, reaction,
    /// confidence, provider, provider_error? }`; вне момента морали — `None`.
    pub async fn decide(&self, state: &Value, enemy_id: &str) -> Option<Value> {
        let enemy = find_actor(Some(state), enemy_id)?;
        if !is_morale_moment(state, enemy_id) {
            return None;
        }
        let fallback = local_disposition(state, Some(enemy));
        let id = actor_id(Some(enemy));
        let Some(client) = self.llm_client.as_ref() else {
            let mut decision = normalize_decision(None, fallback, &id);
            decision.insert("provider".into(), Value::from("deterministic-morale-fallback"));
            return Some(Value::Object(decision));
        };
        match client.client().complete_json(&Self::model_request(state, enemy), &json!({})).await {
            Ok(result) => {
                let mut decision = normalize_decision(Some(&result), fallback, &id);
                // Модель не может сдать главного противника в плен: сломленный, он улетает.
                if decision.get("disposition").and_then(Value::as_str) == Some("surrender") && boss_morale(state, &id).is_some() {
                    decision.insert("disposition".into(), Value::from("flee"));
                }
                decision.insert("provider".into(), Value::from(client.class_name()));
                Some(Value::Object(decision))
            }
            Err(error) => {
                let mut decision = normalize_decision(None, fallback, &id);
                decision.insert("provider".into(), Value::from("deterministic-morale-fallback"));
                decision.insert("provider_error".into(), Value::String(head_utf16(&error.code.clone().unwrap_or_else(|| error.name.clone()), 80)));
                Some(Value::Object(decision))
            }
        }
    }
}

fn farthest_reachable_destination(state: &Value, enemy_id: &str) -> Option<Point> {
    let enemy = find_actor(Some(state), enemy_id)?;
    let from = actor_position(Some(state), enemy_id)?;
    // Бюджет — футы, а не клетки: `MoveActor` берёт взвешенный путь.
    let budget = number_or(sk_rules::geometry::movement::movement_for_actor(state, enemy_id).get("movement_remaining"), 0.0).max(0.0);
    let maximum_steps = (budget / 5.0).floor();
    if maximum_steps == 0.0 {
        return None;
    }
    let cost = sk_rules::geometry::terrain::movement_step_cost_for(state, enemy_id, None);
    let map = cost.map();
    let step = |point: Point, path_map: Option<&sk_tactical::tactical_map::TacticalMap>| cost.step_cost_on(point, path_map);
    let heroes: Vec<(&Value, Value)> = match get(Some(state), "players") {
        Some(Value::Array(players)) => players
            .iter()
            .filter(|hero| is_living_actor(Some(hero)))
            .filter_map(|hero| actor_position(Some(state), &actor_id(Some(hero))).map(|at| (hero, json!({ "x": at.x, "y": at.y }))))
            .collect(),
        _ => Vec::new(),
    };
    let cells: &[Value] = match path(Some(state), &["scene", "cells"]) {
        Some(Value::Array(cells)) => cells,
        _ => &[],
    };
    let width = js::number(Some(coalesce(path(Some(state), &["scene", "grid", "width"]), None).unwrap_or(&Value::from(0))));
    let height = js::number(Some(coalesce(path(Some(state), &["scene", "grid", "height"]), None).unwrap_or(&Value::from(0))));
    let (fx, fy) = (from.x as f64, from.y as f64);
    let mut best: Option<(f64, Point)> = None;
    for cell in cells {
        let kind = get(Some(cell), "type");
        if !js::is_true(get(Some(cell), "revealed")) || !(matches!(kind, Some(Value::String(t)) if t == "floor" || t == "door")) {
            continue;
        }
        let (cx, cy) = (js::number(get(Some(cell), "x")), js::number(get(Some(cell), "y")));
        if !((cx - fx).abs() + (cy - fy).abs() <= maximum_steps) {
            continue;
        }
        let Some(route) = shortest_tactical_path(state, enemy_id, Point::new(cx, cy), PathOptions { tactical_map: Some(map), step_cost: Some(&step), ..PathOptions::default() }) else {
            continue;
        };
        if route.is_empty() || route.len() as f64 > maximum_steps {
            continue;
        }
        if route.iter().map(|point| step(*point, map)).sum::<f64>() > budget {
            continue;
        }
        let Some(destination) = route.last().copied() else { continue };
        let hero_distance = if heroes.is_empty() {
            route.len() as f64
        } else {
            let anchor = json!({ "x": js::num(destination.x), "y": js::num(destination.y) });
            heroes
                .iter()
                .map(|(hero, at)| sk_geometry::actor_footprint::footprint_distance_feet(Some(enemy), Some(hero), Some(&anchor), Some(at)).unwrap_or(9_007_199_254_740_991.0) / 5.0)
                .fold(f64::INFINITY, |a, b| if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) })
        };
        let edge = [destination.x, destination.y, js_max0(width - 1.0 - destination.x), js_max0(height - 1.0 - destination.y)]
            .into_iter()
            .fold(f64::INFINITY, |a, b| if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) });
        let score = hero_distance * 100.0 + route.len() as f64 * 4.0 - edge;
        if best.as_ref().is_none_or(|(best_score, _)| score > *best_score) {
            best = Some((score, destination));
        }
    }
    best.map(|(_, destination)| destination)
}

/// `commandsForMoraleDecision(state, enemyId, decision, ordinaryCommands)`:
/// решение морали — команды Rules Engine.
pub fn commands_for_morale_decision(state: &Value, enemy_id: &str, decision: Option<&Value>, ordinary_commands: Vec<Value>) -> Vec<Value> {
    let actor = enemy_id.to_string();
    let disposition = match get(decision, "disposition") {
        Some(Value::String(kind)) if DISPOSITIONS.contains(&kind.as_str()) => kind.as_str(),
        _ => return ordinary_commands,
    };
    let condition = |name: &str| json!({ "command_type": "AddCondition", "actor_id": actor, "target_id": actor, "condition": name });
    if disposition == "fight" {
        let mut commands = vec![condition("morale-tested")];
        commands.extend(ordinary_commands);
        return commands;
    }
    if disposition == "flee" && js::truthy(boss_morale(state, &actor).as_ref().and_then(|morale| morale.get("flies"))) {
        // Дракон улетает за горы: пути по клеткам ему не нужно.
        return vec![condition("fled")];
    }
    if disposition == "flee" {
        if let Some(destination) = farthest_reachable_destination(state, &actor) {
            return vec![
                json!({ "command_type": "MoveActor", "actor_id": actor, "to": { "x": js::num(destination.x), "y": js::num(destination.y) } }),
                condition("fled"),
            ];
        }
    }
    vec![condition("surrendered")]
}

/// Системный промпт роли (`prompts/npc_controller/v1.txt`).
pub fn npc_morale_prompt() -> &'static str {
    PROMPT
}

/// `Math.max(0, value)` с `NaN`, как в JS.
fn js_max0(value: f64) -> f64 {
    if value.is_nan() {
        f64::NAN
    } else {
        value.max(0.0)
    }
}

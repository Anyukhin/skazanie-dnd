//! Перенос `server/npc-controller.mjs`: мораль и перелом боя NPC
//! (`NpcMoraleAgent`, промпт `prompts/npc_controller/v1.txt`).
//!
//! Вне момента морали [`NpcMoraleAgent::decide`] возвращает `None`: обычные
//! ходы NPC — детерминированная политика сервера, модель зовётся только на
//! переломе. Без модели и при её отказе исход даёт детерминированная монетка
//! от кампании, врага и раунда.
//!
//! Детерминированные [`is_morale_moment`] и [`commands_for_morale_decision`]
//! (решение — команды Rules Engine `AddCondition`, `MoveActor`) живут в ядре,
//! `sk_turns::morale`, и реэкспортируются отсюда; здесь же — реализация
//! `sk_turns::npc_turn_scheduler::NpcController` для [`NpcMoraleAgent`]
//! (урок 7: ядро от слоя агентов не зависит).

use serde_json::{json, Value};
use sk_core::{js, re, text};
use sk_ruleset::rules_actors::{find_actor, is_living_actor};
use sk_turns::morale::{actor_id, boss_morale, condition_label, conditions_for, hp_of, max_hp_of, number_or, DISPOSITIONS};
use sk_turns::npc_turn_scheduler::{DecisionFuture, NpcController};

pub use sk_turns::morale::{commands_for_morale_decision, is_morale_moment};

use crate::director_agent::RoleClient;

const PROMPT: &str = include_str!("../../../../prompts/npc_controller/v1.txt");

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

/// `String(actor?.character ?? actor?.name ?? actorId(actor) ?? 'NPC').slice(0, 100)`.
fn actor_name(actor: Option<&Value>) -> String {
    let name = match coalesce(get(actor, "character"), get(actor, "name")) {
        Some(value) => js::string(Some(value)),
        None => actor_id(actor),
    };
    head_utf16(&name, 100)
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

impl NpcController for NpcMoraleAgent {
    fn decide<'a>(&'a self, state: &'a Value, enemy_id: &'a str) -> DecisionFuture<'a> {
        Box::pin(NpcMoraleAgent::decide(self, state, enemy_id))
    }
}

/// Системный промпт роли (`prompts/npc_controller/v1.txt`).
pub fn npc_morale_prompt() -> &'static str {
    PROMPT
}

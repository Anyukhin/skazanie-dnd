//! Перенос `server/weapon-attack-view.mjs` (#188) — сводка удара надетым
//! оружием для куклы героя во вкладке «Вещи».
//!
//! Числа считает Rules Engine (`weaponAttackSummary`,
//! [`sk_rules::preview_attack::weapon_attack_summary`]) по доверенному
//! состоянию — тем же путём, что и настоящая атака. Сводка ложится только на
//! вещи своего героя: инвентарь соседа по столу проекция показывает, а его
//! модификатор удара — нет. Ведущему (зритель без героя) сводка идёт по всем.

use serde_json::Value;
use sk_core::js;
use sk_rules::preview_attack::weapon_attack_summary;

/// `withWeaponAttackSummaries(projected, trustedState, viewerActorId)`:
/// проекция зрителя, где надетые вещи с боевым профилем получили
/// `attack_summary`. Нечего добавить — проекция как есть. `None` — `undefined`.
pub fn with_weapon_attack_summaries(projected: Option<&Value>, trusted_state: Option<&Value>, viewer_actor_id: Option<&Value>) -> Option<Value> {
    let viewer = js::s(viewer_actor_id);
    let Some(projected_value) = projected.filter(|value| js::truthy(Some(value))) else { return projected.cloned() };
    let Some(Value::Array(players)) = projected_value.get("players") else { return projected.cloned() };
    let Some(trusted) = trusted_state.filter(|value| js::truthy(Some(value))) else { return projected.cloned() };
    let mut changed = false;
    let next_players: Vec<Value> = players
        .iter()
        .map(|player| {
            let Some(Value::Array(inventory)) = player.get("inventory") else { return player.clone() };
            if !viewer.is_empty() && js::s(player.get("id")) != viewer {
                return player.clone();
            }
            let player_id = js::string(player.get("id"));
            let mut touched = false;
            let next_inventory: Vec<Value> = inventory
                .iter()
                .map(|item| {
                    if !js::truthy(item.get("equipped")) || !js::truthy(item.get("combat")) {
                        return item.clone();
                    }
                    let Some(summary) = weapon_attack_summary(trusted, &player_id, &js::string(item.get("id"))) else { return item.clone() };
                    touched = true;
                    let mut next = item.clone();
                    if let Some(object) = next.as_object_mut() {
                        object.insert("attack_summary".into(), summary);
                    }
                    next
                })
                .collect();
            if !touched {
                return player.clone();
            }
            changed = true;
            let mut next = player.clone();
            if let Some(object) = next.as_object_mut() {
                object.insert("inventory".into(), Value::Array(next_inventory));
            }
            next
        })
        .collect();
    if !changed {
        return projected.cloned();
    }
    let mut next = projected_value.clone();
    if let Some(object) = next.as_object_mut() {
        object.insert("players".into(), Value::Array(next_players));
    }
    Some(next)
}

//! Кто вошёл и что ему можно — перенос помощников `server/index.mjs`:
//! `requireUser`/`requireAdmin` (498–508), членство и герои кампании
//! (510–526), доступ к комнате и ассетам (2275–2297), отказ до сверки
//! (2299–2324), голосующие и герои отряда (2478–2562), проекция зрителя
//! (2545–2546).
//!
//! Функции над [`Accounts`] синхронные (SQLite под одним замком, который
//! держат и HTTP-потоки): их зовут только внутри [`crate::core::blocking`] —
//! и из обработчика, и из задания ядра. Синхронно с потока ядра — нельзя:
//! вход другого игрока (scrypt) или запись сессии остановили бы ядро на
//! замке (рецензия С0, CORE-02). Ошибка
//! хранилища, которую JS не ловит (`normalizeCampaignId` бросает на
//! недопустимом коде), возвращается как [`Failure`].

use serde_json::{Map, Value};
use sk_core::indexmap::IndexSet;
use sk_core::js;
use sk_store::accounts::Accounts;

use crate::dispatch::RouteCtx;
use crate::error::{ApiError, ApiResult, Failure};
use crate::room::Room;
use crate::streams::Presence;

/// `String(x || '')`: ложное значение (`0`, `false`, `''`, `null`) — пустая строка.
pub fn string_or_empty(value: Option<&Value>) -> String {
    if js::truthy(value) {
        js::string(value)
    } else {
        String::new()
    }
}

fn array<'a>(value: Option<&'a Value>) -> &'a [Value] {
    value.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn is_admin(user: &Value) -> bool {
    user.get("role").and_then(Value::as_str) == Some("admin")
}

/// Пользователь по cookie сессии (`userForToken(cookies(req).skazanie_session)`).
/// Сбой хранилища — 500 (в JS исключение мимо маршрута).
pub async fn current_user(ctx: &RouteCtx) -> ApiResult<Option<Value>> {
    let Some(token) = ctx.session_token() else { return Ok(None) };
    if token.is_empty() {
        return Ok(None);
    }
    let accounts = ctx.state.accounts.clone();
    Ok(crate::core::blocking(move || accounts.user_for_token(&token)).await??)
}

/// `requireUser(req, res)`: 401 `Нужно войти в аккаунт`.
pub async fn require_user(ctx: &RouteCtx) -> ApiResult<Value> {
    current_user(ctx).await?.ok_or_else(|| ApiError::new(axum::http::StatusCode::UNAUTHORIZED, "Нужно войти в аккаунт"))
}

/// `requireAdmin(req, res)`: 401 без входа, 403 `Требуются права администратора`.
pub async fn require_admin(ctx: &RouteCtx) -> ApiResult<Value> {
    let user = require_user(ctx).await?;
    if !is_admin(&user) {
        return Err(ApiError::new(axum::http::StatusCode::FORBIDDEN, "Требуются права администратора"));
    }
    Ok(user)
}

/// `campaignMembership(user, campaignId)` (510–512): членство из профиля пользователя.
pub fn campaign_membership<'a>(user: &'a Value, campaign_id: &str) -> Option<&'a Value> {
    let wanted = string_or_empty(Some(&Value::String(campaign_id.to_string()))).to_uppercase();
    array(user.get("campaignMemberships")).iter().find(|membership| js::string(membership.get("campaignId")) == wanted)
}

/// `campaignHeroIds(user, campaignId)` (514–522) — значения как в JS.
pub fn campaign_hero_values(accounts: &Accounts, user: &Value, campaign_id: &str) -> Result<Vec<Value>, Failure> {
    let own = || array(user.get("heroIds")).to_vec();
    if sk_core::text::trim(campaign_id).is_empty() {
        return Ok(own());
    }
    if let Some(membership) = campaign_membership(user, campaign_id) {
        return Ok(array(membership.get("heroIds")).to_vec());
    }
    if is_admin(user) {
        return Ok(own());
    }
    Ok(if accounts.campaign_has_memberships(campaign_id)? { Vec::new() } else { own() })
}

/// `campaignHeroIds(user, campaignId).map(String)`.
pub fn campaign_hero_ids(accounts: &Accounts, user: &Value, campaign_id: &str) -> Result<Vec<String>, Failure> {
    Ok(campaign_hero_values(accounts, user, campaign_id)?.iter().map(|id| js::string(Some(id))).collect())
}

/// `canUseHero(user, heroId, campaignId)` (524–526): `includes` строгий.
pub fn can_use_hero(accounts: &Accounts, user: &Value, hero_id: Option<&Value>, campaign_id: &str) -> Result<bool, Failure> {
    if is_admin(user) {
        return Ok(true);
    }
    let wanted = Value::String(string_or_empty(hero_id));
    Ok(campaign_hero_values(accounts, user, campaign_id)?.contains(&wanted))
}

/// `canManageCampaignAssets(user, room)` (2275–2280).
pub fn can_manage_campaign_assets(accounts: &Accounts, user: Option<&Value>, room: &Room) -> Result<bool, Failure> {
    let Some(user) = user else { return Ok(false) };
    if is_admin(user) {
        return Ok(true);
    }
    let campaign_id = string_or_empty(room.state.as_ref().and_then(|state| state.get("sessionCode")));
    if campaign_id.is_empty() {
        return Ok(false);
    }
    let membership = accounts.campaign_membership_for(&js::s(user.get("id")), &campaign_id)?;
    Ok(membership.is_some_and(|membership| membership.get("role").and_then(Value::as_str) == Some("owner")))
}

/// `canAccessRoom(user, room)` (2282–2293) с запасным путём старых кампаний
/// без записей о членстве: доступ по героям комнаты.
pub fn can_access_room(accounts: &Accounts, user: Option<&Value>, room: &Room) -> Result<bool, Failure> {
    let Some(user) = user else { return Ok(false) };
    if is_admin(user) {
        return Ok(true);
    }
    let state = room.state.as_ref();
    let campaign_id = string_or_empty(state.and_then(|state| state.get("sessionCode")));
    if campaign_membership(user, &campaign_id).is_some() {
        return Ok(true);
    }
    if !campaign_id.is_empty() && accounts.campaign_has_memberships(&campaign_id)? {
        return Ok(false);
    }
    let player_ids: Vec<String> = array(state.and_then(|state| state.get("players"))).iter().map(|player| js::string(player.get("id"))).collect();
    let party = array(state.and_then(|state| state.get("partyMemberIds")));
    let member_ids: Vec<String> = if party.is_empty() { player_ids } else { party.iter().map(|id| js::string(Some(id))).collect() };
    Ok(array(user.get("heroIds")).iter().any(|id| member_ids.contains(&js::string(Some(id)))))
}

/// `accessDeniedBeforeReconcile(user, campaignId)` (2299–2324): окончательный
/// отказ до сверки проекции. Любая ошибка — «решит прежний путь» (`false`).
pub fn access_denied_before_reconcile(accounts: &Accounts, user: Option<&Value>, campaign_id: &str, get_room: impl FnOnce(&str) -> Result<Room, Failure>) -> bool {
    let check = || -> Result<bool, Failure> {
        let Some(user) = user else { return Ok(false) };
        if is_admin(user) || campaign_membership(user, campaign_id).is_some() {
            return Ok(false);
        }
        let room = get_room(campaign_id)?;
        if room.state.is_none() || can_access_room(accounts, Some(user), &room)? {
            return Ok(false);
        }
        let session_code = string_or_empty(room.state.as_ref().and_then(|state| state.get("sessionCode"))).to_uppercase();
        Ok(!session_code.is_empty() && session_code == campaign_id.to_uppercase() && accounts.campaign_has_memberships(&session_code)?)
    };
    check().unwrap_or(false)
}

/// `connectedHeroIdsForCampaign(campaignId)` (2478–2482); только на потоке
/// ядра (`&*core.streams`).
pub fn connected_hero_ids_for_campaign<P: Presence + ?Sized>(presence: &P, campaign_id: &str) -> IndexSet<String> {
    presence.connected_hero_ids(campaign_id)
}

/// `partyVoterIdForAccount(campaignId, userId)` (2484–2486).
pub fn party_voter_id_for_account(campaign_id: &str, user_id: &str) -> String {
    let digest = sk_core::hash::sha256_hex(format!("{}\0{user_id}", campaign_id.to_uppercase()));
    format!("account:{}", &digest[..24.min(digest.len())])
}

/// `partyHeroIds(state)` (2510–2514): все герои отряда.
pub fn party_hero_ids(state: &Value) -> Vec<String> {
    let party = array(state.get("partyMemberIds"));
    let ids: Vec<String> = if party.is_empty() {
        array(state.get("players")).iter().map(|player| js::string(player.get("id"))).collect()
    } else {
        party.iter().map(|id| js::string(Some(id))).collect()
    };
    let mut unique: IndexSet<String> = IndexSet::new();
    for id in ids {
        unique.insert(id);
    }
    unique.into_iter().collect()
}

/// Порядок ключей объекта JS: индексы массива по возрастанию, затем прочие
/// в порядке вставки (`Object.fromEntries`).
fn js_ordered(entries: Vec<(String, Value)>) -> Map<String, Value> {
    let (mut indices, rest): (Vec<_>, Vec<_>) = entries.into_iter().partition(|(key, _)| js::is_array_index_key(key));
    indices.sort_by_key(|(key, _)| key.parse::<u64>().unwrap_or(u64::MAX));
    indices.into_iter().chain(rest).collect()
}

/// `partyVoterSnapshot(campaignId, state, eligibleHeroIds)` (2488–2508):
/// `{ voterByHeroId, eligibleVoterIds }`.
pub fn party_voter_snapshot(accounts: &Accounts, campaign_id: &str, state: &Value, eligible_hero_ids: &[String]) -> Result<Value, Failure> {
    let memberships = accounts.list_campaign_memberships(campaign_id)?;
    Ok(party_voter_snapshot_with(&memberships, campaign_id, state, eligible_hero_ids))
}

/// [`party_voter_snapshot`] по уже прочитанным членствам кампании
/// (`listCampaignMemberships`): для сборщика событий в ядре, где аккаунты
/// синхронно не читаются (С11, решение по заданию).
pub fn party_voter_snapshot_with(memberships: &[Value], campaign_id: &str, state: &Value, eligible_hero_ids: &[String]) -> Value {
    let hero_scope = state.get("partyDecisionPolicy").and_then(|policy| policy.get("voterScope")).and_then(Value::as_str) == Some("hero");
    let mut owner_by_hero: indexmap::IndexMap<String, String> = indexmap::IndexMap::new();
    for membership in memberships {
        for hero_id in array(membership.get("heroIds")) {
            owner_by_hero.entry(js::string(Some(hero_id))).or_insert_with(|| js::string(membership.get("userId")));
        }
    }
    let mut heroes: IndexSet<String> = IndexSet::new();
    for id in eligible_hero_ids {
        heroes.insert(id.clone());
    }
    let entries: Vec<(String, Value)> = heroes
        .into_iter()
        .map(|hero_id| {
            let voter = match owner_by_hero.get(&hero_id) {
                Some(owner) if !hero_scope => party_voter_id_for_account(campaign_id, owner),
                _ => format!("hero:{hero_id}"),
            };
            (hero_id, Value::String(voter))
        })
        .collect();
    let voter_by_hero = js_ordered(entries);
    let mut voters: IndexSet<String> = IndexSet::new();
    for voter in voter_by_hero.values() {
        voters.insert(js::s(Some(voter)));
    }
    let mut snapshot = Map::new();
    snapshot.insert("voterByHeroId".into(), Value::Object(voter_by_hero));
    snapshot.insert("eligibleVoterIds".into(), Value::Array(voters.into_iter().map(Value::String).collect()));
    Value::Object(snapshot)
}

/// `campaignVoterCount(campaignId, state)` (2532–2534).
pub fn campaign_voter_count(accounts: &Accounts, campaign_id: &str, state: &Value) -> Result<usize, Failure> {
    let snapshot = party_voter_snapshot(accounts, campaign_id, state, &party_hero_ids(state))?;
    Ok(array(snapshot.get("eligibleVoterIds")).len())
}

/// `viewerStateFor(state, user, actorId)` (2545–2547): проекция зрителя с
/// прогнозом удара (закрытая КД не раскрывается процентом попадания) и
/// сводкой удара надетым оружием своего героя (#188).
pub fn viewer_state_for(state: &Value, user: &Value, actor_id: Option<&Value>) -> Result<Option<Value>, Failure> {
    let span = sk_store::perf::span("viewer.projection");
    let projected = sk_projection::viewer_projection::campaign_state_for_viewer(Some(state), Some(user), actor_id)?;
    drop(span);
    let span = sk_store::perf::span("viewer.forecast");
    let forecast = sk_tactics::combat_forecast_view::with_combat_forecast(projected.as_ref(), Some(state), actor_id)?;
    drop(span);
    let _span = sk_store::perf::span("viewer.weapon");
    Ok(sk_tactics::weapon_attack_view::with_weapon_attack_summaries(forecast.as_ref(), Some(state), actor_id))
}

/// `ownedViewerActorId(state, user, campaignId)` (2548–2552).
pub fn owned_viewer_actor_id(accounts: &Accounts, state: &Value, user: &Value, campaign_id: &str) -> Result<String, Failure> {
    let players = array(state.get("players"));
    Ok(campaign_hero_ids(accounts, user, campaign_id)?.into_iter().find(|id| players.iter().any(|player| js::string(player.get("id")) == *id)).unwrap_or_default())
}

/// `assignedCampaignHeroIds(campaignId, state)` (2554–2562).
pub fn assigned_campaign_hero_ids(accounts: &Accounts, campaign_id: &str, state: &Value) -> Result<Vec<String>, Failure> {
    let party: IndexSet<String> = party_hero_ids(state).into_iter().collect();
    let memberships: Vec<Value> = accounts.list_campaign_memberships(campaign_id)?.into_iter().filter(|membership| membership.get("status").and_then(Value::as_str) != Some("revoked")).collect();
    if memberships.is_empty() {
        return Ok(Vec::new());
    }
    let mut assigned: IndexSet<String> = IndexSet::new();
    for membership in &memberships {
        for hero_id in array(membership.get("heroIds")) {
            assigned.insert(js::string(Some(hero_id)));
        }
    }
    Ok(assigned.into_iter().filter(|hero_id| party.contains(hero_id)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn accounts() -> Accounts {
        Accounts::in_memory().unwrap_or_else(|error| panic!("{error}"))
    }

    #[test]
    fn voter_id_matches_node_sha256() {
        // Эталон: createHash('sha256').update('ABC').update('\0').update('user-1').digest('hex').slice(0, 24).
        assert_eq!(party_voter_id_for_account("abc", "user-1"), "account:2ab92d07c828b1808719e522");
    }

    #[test]
    fn voter_snapshot_orders_keys_like_object_from_entries() {
        let accounts = accounts();
        let state = json!({ "players": [{ "id": "h2" }, { "id": 10 }, { "id": "2" }] });
        let snapshot = party_voter_snapshot(&accounts, "ABC", &state, &party_hero_ids(&state)).unwrap_or_else(|error| panic!("{error}"));
        let keys: Vec<&String> = snapshot["voterByHeroId"].as_object().map(|map| map.keys().collect()).unwrap_or_default();
        assert_eq!(keys, ["2", "10", "h2"], "целые ключи — первыми, по возрастанию");
        assert_eq!(snapshot["eligibleVoterIds"], json!(["hero:2", "hero:10", "hero:h2"]));
        assert_eq!(campaign_voter_count(&accounts, "ABC", &state).ok(), Some(3));
    }

    #[test]
    fn legacy_room_access_by_heroes_and_membership_lock() {
        let accounts = accounts();
        let user = json!({ "id": "u1", "role": "player", "heroIds": ["hero-a"], "campaignMemberships": [] });
        let room = Room { code: "OLD-1".into(), version: 1, state: Some(json!({ "sessionCode": "OLD-1", "players": [{ "id": "hero-a" }] })), updated_at: None };
        assert_eq!(can_access_room(&accounts, Some(&user), &room).ok(), Some(true), "старая кампания без членства — по героям");
        assert_eq!(can_access_room(&accounts, None, &room).ok(), Some(false));
        let party = Room { state: Some(json!({ "sessionCode": "OLD-1", "players": [{ "id": "hero-a" }], "partyMemberIds": ["hero-b"] })), ..room.clone() };
        assert_eq!(can_access_room(&accounts, Some(&user), &party).ok(), Some(false), "состав отряда важнее списка игроков");
        assert_eq!(campaign_hero_ids(&accounts, &user, "OLD-1").ok(), Some(vec!["hero-a".to_string()]));
        assert_eq!(campaign_hero_ids(&accounts, &user, "  ").ok(), Some(vec!["hero-a".to_string()]));
        assert_eq!(can_use_hero(&accounts, &user, Some(&json!("hero-a")), "OLD-1").ok(), Some(true));
        assert_eq!(can_use_hero(&accounts, &user, Some(&json!(0)), "OLD-1").ok(), Some(false));
        let denied = access_denied_before_reconcile(&accounts, Some(&user), "OLD-1", |_| Ok(room.clone()));
        assert!(!denied, "без записей о членстве решает прежний путь");
    }

    /// Бой: герой ходит, у гоблина КД `armor`. Состояние — через нормализацию движка.
    fn combat_state(armor: i64) -> Value {
        sk_rules::normalize::normalize_campaign_state(&json!({
            "sessionCode": "FCST-1",
            "partyMemberIds": ["hero"],
            "players": [{ "id": "hero", "character": "Герой", "hp": 12, "maxHp": 12, "armor": 14, "proficiency": 2,
                "abilities": { "str": 16, "dex": 12, "con": 12, "int": 10, "wis": 10, "cha": 8 }, "x": 0, "y": 0,
                "inventory": [{ "id": "sword", "name": "Длинный меч", "type": "weapon", "quantity": 1, "equipped": true,
                    "combat": { "kind": "melee", "ability": "str", "damage": "1d8", "damageType": "slashing", "normalRange": 5 } }] }],
            "enemies": [{ "id": "goblin", "name": "Гоблин", "hp": 10, "maxHp": 10, "armor": armor, "alive": true, "x": 1, "y": 0 }],
            "scene": { "turn": 1, "cells": [
                { "x": 0, "y": 0, "type": "floor", "revealed": true },
                { "x": 1, "y": 0, "type": "floor", "revealed": true },
            ] },
            "mechanics": { "combat": { "active": true, "round": 1, "active_index": 0,
                "initiative": [{ "actor_id": "hero" }, { "actor_id": "goblin" }], "action_economy": { "hero": { "action": true } } } },
        }))
        .unwrap_or_else(|error| panic!("{error}"))
    }

    fn sword_shot(view: &Option<Value>) -> Value {
        let entries = view.as_ref().and_then(|view| view["combatForecast"]["targets"]["goblin"].as_array().cloned()).unwrap_or_default();
        entries.into_iter().find(|entry| entry["item_id"] == "sword").unwrap_or(Value::Null)
    }

    /// Сторож AGENTS §5 «прогноз удара не выдаёт закрытую КД процентом
    /// попадания» на пути маршрутов: `viewer_state_for` = проекция зрителя +
    /// прогноз (`index.mjs:2544–2546`).
    #[test]
    fn viewer_state_hides_closed_armor_from_hit_chance() {
        let player = json!({ "id": "u1", "role": "player", "heroIds": ["hero"], "campaignMemberships": [] });
        let (low, high) = (combat_state(13), combat_state(18));
        let actor = json!("hero");
        let low_view = viewer_state_for(&low, &player, Some(&actor)).unwrap_or_else(|error| panic!("{error}"));
        let high_view = viewer_state_for(&high, &player, Some(&actor)).unwrap_or_else(|error| panic!("{error}"));
        let shot = sword_shot(&high_view);
        assert_ne!(shot, Value::Null, "прогноз есть: ход героя");
        assert_eq!(shot["hit_chance"], Value::Null, "закрытая КД — без процента попадания");
        assert_eq!(shot["armor_class"], Value::Null);
        assert_eq!(sword_shot(&low_view), shot, "прогноз не зависит от закрытой КД");

        let admin = json!({ "id": "a1", "role": "admin", "heroIds": [], "campaignMemberships": [] });
        let gm_view = viewer_state_for(&high, &admin, Some(&json!(""))).unwrap_or_else(|error| panic!("{error}"));
        let gm_shot = sword_shot(&gm_view);
        assert_eq!((gm_shot["armor_class"].clone(), gm_shot["hit_chance"].clone()), (json!(18), json!(40)), "ведущему КД открыта");
    }

    #[test]
    fn membership_from_profile_is_case_insensitive_on_request() {
        let user = json!({ "campaignMemberships": [{ "campaignId": "ABC-1", "heroIds": ["h"] }] });
        assert!(campaign_membership(&user, "abc-1").is_some());
        assert!(campaign_membership(&user, "abc-2").is_none());
        assert_eq!(party_hero_ids(&json!({ "partyMemberIds": [1, "1", "b"] })), ["1", "b"]);
    }
}

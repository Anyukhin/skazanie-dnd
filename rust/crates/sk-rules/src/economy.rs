//! Экономика хода — перенос помощников `rules-engine.mjs`: кадры действия
//! Атака (обычное, всплеск, ускорение, лишнее), трата действия, перезарядка.
//! Форма объекта экономики — как в JS, поэтому функции работают над JSON.

use serde_json::{json, Map, Value};
use sk_core::game::{combat_active, combat_mut, find_actor, has_condition};
use sk_core::js::{s, safe_int, strings_value, unique_strings};

use crate::classes::{monster_multiattack_count, monster_trait, weapon_attacks_per_action};

pub const ACTION_ECONOMY_EVENT_VERSION: i64 = 2;
pub const ATTACK_ACTION_KINDS: [&str; 4] = ["normal", "extra", "surge", "haste"];
pub const LOADING_ACTION_TYPES: [&str; 3] = ["action", "bonus_action", "reaction"];

/// `actionEconomy()`.
pub fn action_economy() -> Value {
    json!({
        "action": true, "bonus_action": true, "reaction": true, "movement": true, "object_interaction": true,
        "movement_spent": 0, "movement_path": [], "movement_bonus": 0, "extra_actions": 0,
        "surged_action_only": false, "attacks_used": 0, "attacks_allowed": 1,
        "loading_weapon_item_ids": { "action": [], "bonus_action": [], "reaction": [] }
    })
}

/// Экономика существа или свежая.
pub fn economy_of(state: &Value, id: &str) -> Value {
    sk_core::game::combat(state).get("action_economy").and_then(|all| all.get(id)).filter(|value| !value.is_null()).cloned().unwrap_or_else(action_economy)
}

pub fn set_economy(state: &mut Value, id: &str, economy: Value) {
    let combat = combat_mut(state);
    sk_core::js::object_mut(combat, "action_economy").insert(id.to_string(), economy);
}

/// `{ ...economy, ...patch }`.
pub fn with(economy: &Value, patch: Value) -> Value {
    sk_core::js::spread(economy, patch)
}

fn remove_keys(economy: &mut Value, keys: &[&str]) {
    if let Some(map) = economy.as_object_mut() {
        for key in keys {
            map.shift_remove(*key);
        }
    }
}

/// `actionEconomyEventVersion(payload)`.
pub fn event_version(value: &Value) -> i64 {
    safe_int(value.get("action_economy_version"), 0)
}

/// `normalizeLoadingWeaponItemIds(raw)`.
pub fn normalize_loading_weapon_item_ids(raw: Option<&Value>) -> Value {
    let source = raw.filter(|value| value.is_object());
    let mut map = Map::new();
    for kind in LOADING_ACTION_TYPES {
        map.insert(kind.into(), strings_value(unique_strings(source.and_then(|value| value.get(kind)))));
    }
    Value::Object(map)
}

/// `clearLoadingWeaponResource(economy, resource)`.
pub fn clear_loading_weapon_resource(economy: &Value, resource: &str) -> Value {
    let mut current = normalize_loading_weapon_item_ids(economy.get("loading_weapon_item_ids"));
    current[resource] = Value::Array(Vec::new());
    with(economy, json!({ "loading_weapon_item_ids": current }))
}

/// `withLoadingWeaponItem(economy, resource, itemId)`.
pub fn with_loading_weapon_item(economy: &Value, resource: &str, item_id: &Value) -> Value {
    let mut current = normalize_loading_weapon_item_ids(economy.get("loading_weapon_item_ids"));
    let id = s(Some(item_id));
    let list = current[resource].as_array_mut().expect("список");
    if id.is_empty() || list.iter().any(|entry| entry.as_str() == Some(id.as_str())) {
        return with(economy, json!({ "loading_weapon_item_ids": current }));
    }
    list.push(Value::String(id));
    with(economy, json!({ "loading_weapon_item_ids": current }))
}

/// `loadingResourceFor({ reaction_attack }, {}, payload)`.
pub fn loading_resource_for(reaction_attack: bool, payload: Option<&Value>) -> &'static str {
    if reaction_attack {
        return "reaction";
    }
    let declared = s(payload.and_then(|p| p.get("loading_action_type")));
    LOADING_ACTION_TYPES.iter().copied().find(|kind| *kind == declared).unwrap_or("action")
}

/// Кадр действия Атака.
#[derive(Debug, Clone)]
pub struct Frame {
    pub id: String,
    pub kind: String,
    pub limit: i64,
    pub attacks_used: i64,
    pub loading: Value,
}

impl Frame {
    pub fn to_value(&self) -> Value {
        json!({ "id": self.id, "kind": self.kind, "limit": self.limit, "attacks_used": self.attacks_used, "loading_weapon_item_ids": self.loading })
    }
}

fn kind_of(value: Option<&Value>) -> String {
    let kind = s(value);
    if ATTACK_ACTION_KINDS.contains(&kind.as_str()) { kind } else { "normal".into() }
}

/// `attackActionFrameFromEconomy(economy)`.
pub fn current_frame(economy: &Value) -> Option<Frame> {
    if !sk_core::js::truthy(economy.get("attack_action_id")) {
        return None;
    }
    Some(Frame {
        id: s(economy.get("attack_action_id")),
        kind: kind_of(economy.get("attack_action_kind")),
        limit: safe_int(economy.get("attack_action_limit"), safe_int(economy.get("attacks_allowed"), 1)).max(1),
        attacks_used: safe_int(economy.get("attacks_used"), 0).max(0),
        loading: normalize_loading_weapon_item_ids(economy.get("loading_weapon_item_ids")),
    })
}

/// `pendingAttackActionFrames(economy)`.
pub fn pending_frames(economy: &Value) -> Vec<Frame> {
    economy
        .get("attack_action_stack")
        .and_then(Value::as_array)
        .map(|stack| {
            stack
                .iter()
                .filter(|frame| frame.is_object() && sk_core::js::truthy(frame.get("id")))
                .map(|frame| Frame {
                    id: s(frame.get("id")),
                    kind: kind_of(frame.get("kind")),
                    limit: safe_int(frame.get("limit"), 1).max(1),
                    attacks_used: safe_int(frame.get("attacks_used"), 0).max(0),
                    loading: normalize_loading_weapon_item_ids(frame.get("loading_weapon_item_ids")),
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn frames_value(frames: &[Frame]) -> Value {
    Value::Array(frames.iter().map(Frame::to_value).collect())
}

/// `attackActionEconomyWithFrame(economy, frame)`.
pub fn with_frame(economy: &Value, frame: &Frame) -> Value {
    with(
        economy,
        json!({
            "attack_action_id": frame.id,
            "attack_action_kind": frame.kind,
            "attack_action_limit": frame.limit,
            "attacks_used": frame.attacks_used,
            "attacks_allowed": frame.limit,
            "loading_weapon_item_ids": normalize_loading_weapon_item_ids(Some(&frame.loading)),
        }),
    )
}

/// Возобновить следующий кадр из стопки: общая часть трат действия.
fn resume(economy: &Value, resumed: &Frame, pending: &[Frame], extra_actions: i64) -> Value {
    let resumed_action = resumed.attacks_used == 0;
    let base = with(
        economy,
        json!({
            "action": resumed_action, "extra_actions": extra_actions,
            "surged_action_only": resumed.kind == "surge", "attack_action_stack": frames_value(pending),
        }),
    );
    with(
        &with_frame(&base, resumed),
        json!({
            "action": resumed_action, "extra_actions": extra_actions,
            "surged_action_only": resumed.kind == "surge", "attack_action_stack": frames_value(pending),
        }),
    )
}

/// `spendVersionedActionFrame(state, id, { allowSurge, allowHaste })`.
pub fn spend_versioned_action_frame(state: &mut Value, id: &str, allow_surge: bool, allow_haste: bool) {
    let economy = economy_of(state, id);
    let Some(current) = current_frame(&economy) else {
        set_economy(state, id, with(&economy, json!({ "action": false, "surged_action_only": false })));
        return;
    };
    let mut pending = pending_frames(&economy);
    let pending_normal = pending.iter().position(|frame| frame.kind == "normal" && frame.attacks_used == 0);
    let current_can_cast = (allow_haste || current.kind != "haste") && (allow_surge || current.kind != "surge");
    if !current_can_cast {
        if let Some(index) = pending_normal {
            pending.remove(index);
            set_economy(state, id, with(&economy, json!({ "attack_action_stack": frames_value(&pending) })));
            return;
        }
    }
    let special = matches!(current.kind.as_str(), "surge" | "haste" | "extra");
    let extra_actions = (safe_int(economy.get("extra_actions"), 0) - i64::from(special)).max(0);
    if !pending.is_empty() {
        let resumed = pending.remove(0);
        set_economy(state, id, resume(&economy, &resumed, &pending, extra_actions));
        return;
    }
    let cleared = clear_loading_weapon_resource(&economy, "action");
    set_economy(
        state,
        id,
        with(
            &economy,
            json!({
                "action": false, "extra_actions": extra_actions, "surged_action_only": false, "attack_action_stack": [],
                "loading_weapon_item_ids": cleared["loading_weapon_item_ids"].clone(),
            }),
        ),
    );
}

/// `spendCombatEconomy(state, id, resource, { magic, normalActionOnly })`.
pub fn spend_combat_economy(state: &mut Value, id: &str, resource: &str, magic: bool, normal_action_only: bool) {
    if !combat_active(state) || id.is_empty() {
        return;
    }
    let current = economy_of(state, id);
    if resource == "action" && event_version(&current) >= ACTION_ECONOMY_EVENT_VERSION && !normal_action_only {
        spend_versioned_action_frame(state, id, true, false);
        return;
    }
    if resource != "action" {
        let mut patch = Map::new();
        patch.insert(resource.into(), Value::Bool(false));
        set_economy(state, id, with(&current, Value::Object(patch)));
        return;
    }
    if normal_action_only {
        set_economy(state, id, with(&current, json!({ "action": false, "surged_action_only": false })));
        return;
    }
    let extra = safe_int(current.get("extra_actions"), 0).max(0);
    if extra > 0 {
        let next = with(&current, json!({ "action": true, "extra_actions": extra - 1, "surged_action_only": magic }));
        set_economy(state, id, clear_loading_weapon_resource(&next, "action"));
        return;
    }
    set_economy(state, id, with(&current, json!({ "action": false, "surged_action_only": false })));
}

/// `allowedWeaponAttacks(state, actor, id)`.
pub fn allowed_weapon_attacks(state: &Value, actor: &Value, id: &str) -> i64 {
    let monster = if monster_trait(actor, "multiattack").is_some() { monster_multiattack_count(actor) } else { 1 };
    monster.max(weapon_attacks_per_action(actor) + i64::from(has_condition(state, id, "hasted")))
}

/// `weaponAttackLimitForAction(state, actor, id, command)`.
pub fn weapon_attack_limit_for_action(state: &Value, actor: Option<&Value>, id: &str, multiattack: bool) -> i64 {
    let Some(actor) = actor else { return 1 };
    if multiattack {
        return allowed_weapon_attacks(state, actor, id);
    }
    weapon_attacks_per_action(actor).max(1)
}

/// `applyVersionedAttackEconomy(state, event, payload)`.
pub fn apply_versioned_attack_economy(state: &mut Value, actor_id: Option<&str>, event_ref: &str, payload: &Value) {
    let reaction_attack = sk_core::js::is_true(payload.get("reaction_attack"));
    let actor_id = actor_id.unwrap_or("");
    if reaction_attack || s(payload.get("attack_action_resource")) != "action" {
        if sk_core::js::is_true(payload.get("loading_weapon"))
            && !sk_core::js::is_false(payload.get("loading_limit_applies"))
            && sk_core::js::present(payload.get("item_id"))
            && combat_active(state)
            && !actor_id.is_empty()
        {
            let resource = loading_resource_for(reaction_attack, Some(payload));
            let economy = economy_of(state, actor_id);
            let versioned = with(&economy, json!({ "action_economy_version": ACTION_ECONOMY_EVENT_VERSION }));
            set_economy(state, actor_id, with_loading_weapon_item(&versioned, resource, &payload["item_id"]));
        }
        return;
    }
    let Some(attacker) = find_actor(state, actor_id).cloned() else { return };
    if !combat_active(state) || actor_id.is_empty() {
        return;
    }
    let previous = economy_of(state, actor_id);
    let boundary = s(payload.get("attack_action_boundary"));
    let kind = kind_of(payload.get("attack_action_kind"));
    let normal_limit = weapon_attack_limit_for_action(state, Some(&attacker), actor_id, false);
    let limit = safe_int(payload.get("attack_action_limit"), normal_limit).max(1);
    let mut economy = with(&previous, json!({ "action_economy_version": ACTION_ECONOMY_EVENT_VERSION, "attacks_allowed": limit }));
    if boundary == "start" {
        let attack_action_id = if sk_core::js::present(payload.get("attack_action_id")) {
            s(payload.get("attack_action_id"))
        } else {
            format!("attack-action:{event_ref}")
        };
        let cleared = clear_loading_weapon_resource(&economy, "action")["loading_weapon_item_ids"].clone();
        economy = with(
            &economy,
            json!({
                "attacks_used": 0, "attack_action_id": attack_action_id, "attack_action_kind": kind,
                "attack_action_limit": limit, "loading_weapon_item_ids": cleared,
            }),
        );
        if kind == "extra" {
            let extra = (safe_int(economy.get("extra_actions"), 0) - 1).max(0);
            economy["extra_actions"] = Value::from(extra);
            remove_keys(&mut economy, &["extra_action_kind", "extra_action_limit"]);
        }
    }
    let used = safe_int(economy.get("attacks_used"), 0).max(0) + 1;
    economy["attacks_used"] = Value::from(used);
    if kind != "normal" && used >= limit {
        let mut pending = pending_frames(&economy);
        let extra_actions = (safe_int(economy.get("extra_actions"), 0) - 1).max(0);
        if !pending.is_empty() {
            let resumed = pending.remove(0);
            let resumed_action = resumed.attacks_used == 0;
            let base = with(
                &economy,
                json!({ "action": resumed_action, "extra_actions": extra_actions, "surged_action_only": resumed.kind == "surge", "attack_action_stack": frames_value(&pending) }),
            );
            let framed = with_frame(&base, &resumed);
            economy = with(
                &economy,
                json!({ "extra_actions": extra_actions, "surged_action_only": resumed.kind == "surge", "attack_action_stack": frames_value(&pending) }),
            );
            if let Some(map) = framed.as_object() {
                for (key, value) in map {
                    economy[key.as_str()] = value.clone();
                }
            }
        } else {
            let cleared = clear_loading_weapon_resource(&economy, "action")["loading_weapon_item_ids"].clone();
            economy = with(
                &economy,
                json!({
                    "action": false, "extra_actions": extra_actions, "attacks_used": 0,
                    "attacks_allowed": weapon_attack_limit_for_action(state, Some(&attacker), actor_id, false),
                    "attack_action_stack": [], "loading_weapon_item_ids": cleared,
                }),
            );
            remove_keys(&mut economy, &["attack_action_id", "attack_action_kind", "attack_action_limit"]);
        }
    } else if kind == "normal" {
        economy["action"] = Value::Bool(false);
    }
    if sk_core::js::is_true(payload.get("loading_weapon")) && !sk_core::js::is_false(payload.get("loading_limit_applies")) && sk_core::js::present(payload.get("item_id")) && !(kind != "normal" && used >= limit) {
        economy = with_loading_weapon_item(&economy, loading_resource_for(false, Some(payload)), &payload["item_id"]);
    }
    let used_action_ids: Vec<Value> = economy.get("multiattack_action_ids").and_then(Value::as_array).map(|ids| ids.iter().map(|id| Value::String(s(Some(id)))).collect()).unwrap_or_default();
    if sk_core::js::truthy(payload.get("action_id")) {
        let first = if sk_core::js::present(economy.get("multiattack_action_id")) { s(economy.get("multiattack_action_id")) } else { s(payload.get("action_id")) };
        economy["multiattack_action_id"] = Value::String(first);
        if monster_trait(&attacker, "multiattack").is_some() {
            let mut ids = used_action_ids;
            ids.push(Value::String(s(payload.get("action_id"))));
            economy["multiattack_action_ids"] = Value::Array(ids);
        }
    }
    set_economy(state, actor_id, economy);
}

/// Ключ хода (`combatTurnKey`).
pub fn combat_turn_key(state: &Value, fallback_actor: &str) -> Option<String> {
    if !combat_active(state) {
        return None;
    }
    let combat = sk_core::game::combat(state);
    let index = safe_int(combat.get("active_index"), -1);
    let active = (index >= 0)
        .then(|| combat.get("initiative").and_then(Value::as_array).and_then(|list| list.get(index as usize)).and_then(|entry| entry.get("actor_id")).filter(|value| !value.is_null()).map(|value| s(Some(value))))
        .flatten()
        .unwrap_or_else(|| fallback_actor.to_string());
    Some(format!("combat:{}:{active}", safe_int(combat.get("round"), 1)))
}

/// `spendVersionedAttackReplacement(state, id)`: действие предметом вместо
/// атаки — тратит одну атаку текущего кадра, а не всё действие.
pub fn spend_versioned_attack_replacement(state: &mut Value, id: &str) {
    let economy = economy_of(state, id);
    let actor = find_actor(state, id).cloned();
    let current = current_frame(&economy).unwrap_or_else(|| Frame {
        id: format!("item-action:{id}"),
        kind: "normal".into(),
        limit: weapon_attack_limit_for_action(state, actor.as_ref(), id, false).max(1),
        attacks_used: 0,
        loading: json!({ "action": [], "bonus_action": [], "reaction": [] }),
    });
    let used = current.attacks_used.max(0) + 1;
    let mut next = with(
        &economy,
        json!({
            "action_economy_version": ACTION_ECONOMY_EVENT_VERSION,
            "attack_action_id": current.id,
            "attack_action_kind": current.kind,
            "attack_action_limit": current.limit,
            "attacks_allowed": current.limit,
            "attacks_used": used,
            "loading_weapon_item_ids": current.loading,
        }),
    );
    if current.kind != "normal" && used >= current.limit {
        let mut pending = pending_frames(&economy);
        let extra_actions = (safe_int(economy.get("extra_actions"), 0) - 1).max(0);
        if pending.is_empty() {
            let cleared = clear_loading_weapon_resource(&next, "action");
            next = with(
                &next,
                json!({ "action": false, "extra_actions": extra_actions, "attack_action_stack": [], "loading_weapon_item_ids": cleared["loading_weapon_item_ids"].clone() }),
            );
        } else {
            let resumed = pending.remove(0);
            next = resume(&next, &resumed, &pending, extra_actions);
        }
    } else if current.kind == "normal" {
        next["action"] = Value::Bool(false);
    }
    set_economy(state, id, next);
}

/// `spendVersionedSpellAction(state, id)`: заклинание действием; всплеск
/// действия годится только по редакции 2014.
pub fn spend_versioned_spell_action(state: &mut Value, id: &str) {
    let allow_surge = sk_core::game::uses_2014(state);
    spend_versioned_action_frame(state, id, allow_surge, false);
}

/// `spendVersionedActionOnly(state, id)`.
pub fn spend_versioned_action_only(state: &mut Value, id: &str) {
    spend_versioned_action_frame(state, id, false, false);
}

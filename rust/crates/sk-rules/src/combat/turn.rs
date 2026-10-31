//! Ход: `assertActorPermission`, `assertTurn`, группы инициативы, план действия Атака, свой ход, траты экономики. Задача Р3.
//!
//! JS: `server/rules-engine.mjs`, 1853 (`initiativeGroupIds`), 5506–5514
//! (`assertActorPermission`), 5505–5798 (`assertTurn`), 9345–9378
//! (перезарядка: «Арбалетчик», лимит выстрела), 9404–9467
//! (`attackActionPlan`), 10446 (`isActiveTurnActor`), 10452
//! (`TYPED_RIDER_DAMAGE_TYPES`), 10784 (`isOwnCombatTurn`), 23798–23843
//! (кадр Ускорения: что ему нельзя).
//!
//! Экономика хода — JSON той же формы, что в JS; кадры и перезарядка — Р0
//! (`crate::turn_economy`). Ключи `combat.action_economy[id]` и
//! `conditions[id]` — свойства JS: `null` даёт ключ `"null"`.

use serde_json::{json, Value};
use sk_core::{game, js};

use crate::combat::class_features::is_monk_bonus_attack_context;
use crate::combat::monsters::{monster_multiattack_action_counts, monster_multiattack_action_ids};
use crate::combat::weapons::{item_attack_profile, AttackOptions};
use crate::conditions::{at, at_path};
use crate::context::Context;
use crate::core::{condition_ids_for, incapacitating_condition_for, monster_trait_for, string_of, target_for};
use crate::pause::{rule, Fault, Halt, Step};
use crate::turn_economy::{current_frame, event_version, loading_resource_for_command, normalize_loading_weapon_item_ids, pending_frames, weapon_attack_limit_for_action, ACTION_ECONOMY_EVENT_VERSION, ATTACK_ACTION_KINDS};

/// `TYPED_RIDER_DAMAGE_TYPES`: типы урона добавочной кости оружия на выбор заклинателя.
pub const TYPED_RIDER_DAMAGE_TYPES: [&str; 7] = ["acid", "cold", "fire", "lightning", "thunder", "radiant", "necrotic"];

/// Команды, которым `assertTurn` проверяет очередь и экономику хода.
pub const TURN_COMMAND_TYPES: [&str; 23] = [
    "UseMonsterAction",
    "MakeAttack",
    "MakeAreaAttack",
    "ChangeWeapon",
    "EquipItem",
    "CastSpell",
    "UseCombatAction",
    "UseItem",
    "ActivateItem",
    "IdentifyEnemy",
    "ProposeParley",
    "CalmBeast",
    "FeedBeast",
    "MoveActor",
    "OperateDoor",
    "BarricadeDoor",
    "ClearDoorBarricade",
    "OperateSceneObject",
    "LootContainer",
    "ReturnKnightHead",
    "NegotiateScenarioTreaty",
    "EndCombat",
    "EndTurn",
];

/// Ключ свойства JS: `obj[x]` — `String(x)`.
fn key(value: Option<&Value>) -> String {
    js::string(value)
}

/// `array[index]` JS: индекс — число или строка-индекс.
fn index_of(value: Option<&Value>) -> Option<usize> {
    match value? {
        Value::Number(number) => number.as_f64().filter(|f| *f >= 0.0 && f.fract() == 0.0 && *f < 4_294_967_295.0).map(|f| f as usize),
        Value::String(text) if js::is_array_index_key(text) => text.parse().ok(),
        _ => None,
    }
}

fn initiative(combat: &Value) -> &[Value] {
    combat.get("initiative").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// `combat.initiative[combat.active_index]`.
fn current_entry(combat: &Value) -> Option<&Value> {
    index_of(combat.get("active_index")).and_then(|index| initiative(combat).get(index))
}

/// `combat.action_economy[id]`.
fn economy_at<'a>(combat: &'a Value, id: &str) -> Option<&'a Value> {
    at_path(Some(combat), &["action_economy", id])
}

/// `initiativeGroupIds(state)` (1853–1864): соседи по очереди на одной
/// стороне — одна фаза.
pub fn initiative_group_ids(state: &Value) -> Vec<String> {
    let combat = game::combat(state);
    let order = initiative(combat);
    if !js::truthy(combat.get("group_initiative")) || order.is_empty() {
        return Vec::new();
    }
    let index = js::safe_int(combat.get("active_index"), -1);
    if index < 0 || index as usize >= order.len() {
        return Vec::new();
    }
    let index = index as usize;
    let actor_of = |entry: &Value| js::string(at(Some(entry), "actor_id"));
    let side_of = |entry: &Value| game::is_enemy_actor(state, &actor_of(entry));
    let side = side_of(&order[index]);
    let mut group = vec![actor_of(&order[index])];
    let mut step = index;
    while step > 0 && side_of(&order[step - 1]) == side {
        step -= 1;
        group.insert(0, actor_of(&order[step]));
    }
    let mut step = index + 1;
    while step < order.len() && side_of(&order[step]) == side {
        group.push(actor_of(&order[step]));
        step += 1;
    }
    group
}

/// `isActiveTurnActor(state, actorId)` (10468): чей сейчас ход (без группы).
pub fn is_active_turn_actor(state: &Value, actor_id: &str) -> bool {
    let combat = game::combat(state);
    js::truthy(combat.get("active")) && js::s(at(current_entry(combat), "actor_id")) == actor_id
}

/// `isOwnCombatTurn(state, id)` (10806): ход существа, в том числе в групповой фазе.
pub fn is_own_combat_turn(state: &Value, id: Option<&Value>) -> bool {
    let combat = game::combat(state);
    if !js::truthy(combat.get("active")) {
        return false;
    }
    let completed = combat.get("turn_completed").and_then(Value::as_array).is_some_and(|ids| ids.iter().any(|entry| crate::validate::common::strict_equal(Some(entry), id)));
    if completed {
        return false;
    }
    let Some(Value::String(id)) = id else {
        return false;
    };
    js::string(at(current_entry(combat), "actor_id")) == *id || initiative_group_ids(state).iter().any(|member| member == id)
}

/// `assertActorPermission(command, context, state)` (5506–5514).
pub fn assert_actor_permission(command: &Value, context: &Context, state: &Value) -> Step {
    if !js::truthy(command.get("actor_id")) || context.truthy("isAdmin") {
        return Ok(());
    }
    let Some(Value::Array(allowed)) = context.get("allowedActorIds") else { return Ok(()) };
    let allowed: Vec<String> = allowed.iter().map(string_of).collect();
    let actor_id = js::s(command.get("actor_id"));
    let actor = game::find_actor(state, &actor_id);
    let owner = js::s(crate::core::coalesce(&[at(actor, "controllerId"), at(actor, "controller_id"), at(actor, "ownerId"), at(actor, "owner_id")]));
    // `allowed.includes(command.actor_id)` — строгое сравнение со строкой.
    let actor_allowed = command.get("actor_id").and_then(Value::as_str).is_some_and(|id| allowed.iter().any(|entry| entry == id));
    if !actor_allowed && !(sk_combat_content::combat_spells::is_party_summon(actor) && allowed.iter().any(|entry| *entry == owner)) {
        return Err(rule("Игрок не может действовать от имени этого персонажа", "ACTOR_FORBIDDEN"));
    }
    Ok(())
}

/// `crossbowExpertFor(actor)` (9367): «Арбалетчик» или выгода создания без перезарядки.
pub fn crossbow_expert_for(actor: Option<&Value>) -> bool {
    let mut selected: Vec<String> = Vec::new();
    for field in ["selectedFeatureIds", "selected_feature_ids"] {
        if let Some(Value::Array(ids)) = at(actor, field) {
            selected.extend(ids.iter().map(string_of));
        }
    }
    let creation = at(actor, "creationBenefits");
    let benefits = crate::core::coalesce(&[at(creation, "static"), creation]);
    selected.iter().any(|id| id == "crossbow-expert") || js::is_true(at(benefits, "ignore_loading_property"))
}

/// `crossbowProfileFor(profile)` (9377): профиль — каталожный арбалет.
pub fn crossbow_profile_for(profile: Option<&Value>) -> bool {
    let item = at(profile, "item");
    let catalog_id = js::s(crate::core::coalesce(&[at(item, "catalog_id"), at(item, "catalogId")]));
    let catalog_key = catalog_id.split(':').next_back().unwrap_or("");
    ["light-crossbow", "hand-crossbow", "heavy-crossbow"].contains(&catalog_key) && js::truthy(at(sk_items::item_catalog::catalog_item(&catalog_id), "weapon"))
}

/// `loadingWeaponLimitApplies(state, actor, profile)` (9385): одно оружие со
/// свойством «перезарядка» — один выстрел за действие (редакция 2014).
pub fn loading_weapon_limit_applies(state: &Value, actor: Option<&Value>, profile: Option<&Value>) -> bool {
    let loading = match at(profile, "properties") {
        Some(Value::Array(items)) => items.iter().any(|item| item.as_str() == Some("loading")),
        Some(Value::String(text)) => text.contains("loading"),
        _ => false,
    };
    sk_ruleset::rules_core::uses_dnd2014(Some(state)) && loading && !(crossbow_expert_for(actor) && crossbow_profile_for(profile))
}

/// `loadingWeaponUsed(economy, resource, itemId)` (9391).
pub fn loading_weapon_used(economy: Option<&Value>, resource: &str, item_id: Option<&Value>) -> bool {
    let ids = normalize_loading_weapon_item_ids(economy.and_then(|economy| economy.get("loading_weapon_item_ids")));
    let wanted = js::string(item_id);
    ids.get(resource).and_then(Value::as_array).is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(wanted.as_str())))
}

/// План действия Атака (`attackActionPlan`).
#[derive(Debug, Clone, PartialEq)]
pub struct AttackActionPlan {
    pub resource: String,
    /// `null`, `start` или `continue`.
    pub boundary: Option<&'static str>,
    pub kind: String,
    /// `extraKind` лишнего действия (только у `kind: 'extra'`).
    pub extra_kind: Option<String>,
    pub id: Option<String>,
    pub limit: i64,
    pub spends_action: bool,
}

impl AttackActionPlan {
    pub fn to_value(&self) -> Value {
        let mut map = serde_json::Map::new();
        map.insert("resource".into(), Value::String(self.resource.clone()));
        map.insert("boundary".into(), js::opt_str(self.boundary));
        map.insert("kind".into(), Value::String(self.kind.clone()));
        if let Some(extra) = &self.extra_kind {
            map.insert("extraKind".into(), Value::String(extra.clone()));
        }
        map.insert("id".into(), js::opt_str(self.id.as_deref()));
        map.insert("limit".into(), Value::from(self.limit));
        map.insert("spendsAction".into(), Value::Bool(self.spends_action));
        Value::Object(map)
    }
}

fn attack_kind(value: Option<&Value>) -> Option<String> {
    let kind = js::string(value);
    ATTACK_ACTION_KINDS.contains(&kind.as_str()).then_some(kind)
}

/// `attackActionPlan(state, command, context)` (9426–9489): начинает ли удар
/// новое действие Атака или продолжает начатое и сколько в нём атак.
pub fn attack_action_plan(state: &Value, command: &Value, context: &Context) -> AttackActionPlan {
    let actor_key = key(command.get("actor_id"));
    let actor = game::find_actor(state, &js::s(command.get("actor_id")));
    let economy = crate::turn_economy::economy_of(state, &actor_key);
    let resource = loading_resource_for_command(command, context, None).to_string();
    let reaction = js::is_true(command.get("reaction_attack")) || context.is_true("reactionResolution");
    if resource != "action" || reaction {
        return AttackActionPlan { resource: resource.clone(), boundary: None, kind: resource, extra_kind: None, id: None, limit: 1, spends_action: false };
    }
    let multiattack = command.get("monster_ability").and_then(Value::as_str) == Some("multiattack");
    let normal_limit = weapon_attack_limit_for_action(state, actor, &actor_key, multiattack);
    let current_id = if js::truthy(economy.get("attack_action_id")) { js::string(economy.get("attack_action_id")) } else { String::new() };
    let current_kind = attack_kind(economy.get("attack_action_kind"));
    let current_limit = js::safe_int(economy.get("attack_action_limit"), js::safe_int(economy.get("attacks_allowed"), normal_limit)).max(1);
    let used = js::safe_int(economy.get("attacks_used"), 0).max(0);
    let action_free = !js::is_false(economy.get("action"));
    let starts_monster_multiattack = context.is_true("isNpcScheduler") && multiattack && current_kind.as_deref() == Some("normal") && used == 0 && action_free;
    let fresh_id = || format!("attack-action:{}", js::s(command.get("command_id")));
    if event_version(&economy) >= ACTION_ECONOMY_EVENT_VERSION {
        if !current_id.is_empty() && used > 0 && used < current_limit {
            return AttackActionPlan { resource, boundary: Some("continue"), kind: current_kind.unwrap_or_else(|| "normal".into()), extra_kind: None, id: Some(current_id), limit: current_limit, spends_action: false };
        }
        let limit = if !current_id.is_empty() && !starts_monster_multiattack { current_limit } else { normal_limit };
        let id = if current_id.is_empty() { fresh_id() } else { current_id };
        return AttackActionPlan { resource, boundary: Some("start"), kind: current_kind.unwrap_or_else(|| "normal".into()), extra_kind: None, id: Some(id), limit, spends_action: action_free };
    }
    let extra_actions = js::safe_int(economy.get("extra_actions"), 0).max(0);
    if extra_actions > 0 {
        let extra_kind = attack_kind(economy.get("extra_action_kind")).unwrap_or_else(|| if condition_ids_for(state, &actor_key).contains("hasted") { "haste".into() } else { "surge".into() });
        let extra_limit = js::safe_int(economy.get("extra_action_limit"), if extra_kind == "haste" { 1 } else { normal_limit }).max(1);
        return AttackActionPlan { resource, boundary: Some("start"), kind: "extra".into(), extra_kind: Some(extra_kind), id: Some(fresh_id()), limit: extra_limit, spends_action: false };
    }
    if !current_id.is_empty() && used > 0 && used < current_limit {
        return AttackActionPlan { resource, boundary: Some("continue"), kind: current_kind.unwrap_or_else(|| "normal".into()), extra_kind: None, id: Some(current_id), limit: current_limit, spends_action: false };
    }
    if let Some(kind) = current_kind.filter(|_| !current_id.is_empty() && used == 0 && action_free) {
        return AttackActionPlan { resource, boundary: Some("start"), kind, extra_kind: None, id: Some(current_id), limit: current_limit, spends_action: true };
    }
    AttackActionPlan { resource, boundary: Some("start"), kind: "normal".into(), extra_kind: None, id: Some(fresh_id()), limit: normal_limit, spends_action: action_free }
}

/// `hasteActionAllows(actionId)` (23820): что разрешает действие Ускорения.
pub fn haste_action_allows(action_id: Option<&Value>) -> bool {
    matches!(js::s(action_id).as_str(), "dash" | "disengage" | "hide" | "use-object")
}

/// `hasUntouchedNormalActionFrame(economy)` (23824).
pub fn has_untouched_normal_action_frame(economy: Option<&Value>) -> bool {
    pending_frames(economy.unwrap_or(&Value::Null)).iter().any(|frame| frame.kind == "normal" && frame.attacks_used == 0)
}

/// `hasteOnlyActionFrame(economy)` (23828).
pub fn haste_only_action_frame(economy: Option<&Value>) -> bool {
    current_frame(economy.unwrap_or(&Value::Null)).is_some_and(|frame| frame.kind == "haste") && !has_untouched_normal_action_frame(economy)
}

/// `commandRequiresNormalActionFrame(command, economy)` (23833–23858).
pub fn command_requires_normal_action_frame(command: &Value, economy: Option<&Value>) -> bool {
    match js::s(command.get("command_type")).as_str() {
        "LootContainer" => command.get("loot_combat_action").and_then(Value::as_str) != Some("object_interaction"),
        "IdentifyEnemy" | "ProposeParley" | "CalmBeast" | "FeedBeast" | "UseMonsterAction" | "ChangeWeapon" | "MakeAreaAttack" | "OperateSceneObject" | "BarricadeDoor" | "ClearDoorBarricade" => true,
        "OperateDoor" => matches!(js::s(command.get("intent")).as_str(), "force" | "lockpick"),
        // Первое взаимодействие с предметом бесплатно; после его расхода
        // валидатор жизненного цикла поднимает команду до обычного действия.
        "EquipItem" => js::is_false(economy.and_then(|economy| economy.get("object_interaction"))),
        "ResolveImprovisedAction" => !matches!(command.get("action_cost").and_then(Value::as_str), Some("bonus_action" | "free")),
        _ => false,
    }
}

/// `assertNormalActionFrameAvailable(command, economy)` (23861–23865).
pub fn assert_normal_action_frame_available(command: &Value, economy: Option<&Value>) -> Step {
    if haste_only_action_frame(economy) && command_requires_normal_action_frame(command, economy) {
        return Err(rule("Оставшееся действие Ускорения нельзя потратить на этот поступок", "HASTE_ACTION_LIMIT"));
    }
    Ok(())
}

fn spent(resource: &str) -> Halt {
    let label = match resource {
        "bonus_action" => "Бонусное действие",
        "reaction" => "Реакция",
        _ => "Действие",
    };
    let code = match resource {
        "bonus_action" => "BONUS_ACTION_SPENT",
        "reaction" => "REACTION_SPENT",
        _ => "ACTION_SPENT",
    };
    rule(format!("{label} на этом ходу уже потрачено"), code)
}

fn action_spent() -> Halt {
    rule("Действие на этом ходу уже потрачено", "ACTION_SPENT")
}

/// `economy?.[resource] === false`.
fn resource_spent(economy: Option<&Value>, resource: &str) -> bool {
    js::is_false(economy.and_then(|economy| economy.get(resource)))
}

/// `(list ?? []).includes(value)` для значений JSON (строгое равенство).
fn list_includes(list: Option<&Value>, value: Option<&Value>) -> Result<bool, Halt> {
    crate::validate::common::js_includes(list.filter(|list| !list.is_null()), value, "action_ids")
}

/// `assertTurn(command, state, context)` (5527–5820): очередь, приказы,
/// дееспособность и экономика хода в бою.
pub fn assert_turn(command: &Value, state: &Value, context: &Context) -> Step {
    let combat = game::combat(state);
    let command_type = js::s(command.get("command_type"));
    // `ResolveImprovisedAction` в списке JS нет: его ветка ниже недостижима.
    if !js::truthy(combat.get("active")) || !TURN_COMMAND_TYPES.contains(&command_type.as_str()) {
        return Ok(());
    }
    let actor_id = command.get("actor_id");
    let actor_key = key(actor_id);
    let actor_text = actor_id.and_then(Value::as_str);
    let find_actor = || game::find_actor(state, &js::s(actor_id));
    if command_type == "MakeAttack" && js::truthy(command.get("item_id")) {
        let actor = find_actor();
        let profile = item_attack_profile(state, actor, command.get("item_id"), AttackOptions { attack_mode: command.get("attack_mode"), attack_ability: command.get("attack_ability"), off_hand: false });
        let economy = economy_at(combat, &actor_key);
        let resource = loading_resource_for_command(command, context, None);
        if loading_weapon_limit_applies(state, actor, profile.as_ref()) && loading_weapon_used(economy, resource, command.get("item_id")) {
            return Err(rule("Оружие со свойством «перезарядка» позволяет только один выстрел за действие", "LOADING_WEAPON_LIMIT"));
        }
    }
    if context.truthy("reactionResolution") && command_type == "MakeAttack" {
        return Ok(());
    }
    // Дополнительные лучи одного заклинания — часть уже совершённого действия.
    if context.truthy("additionalBeam") && command_type == "CastSpell" {
        return Ok(());
    }
    // Заготовленное заклинание уже оплачено действием на прошлом ходу.
    if context.truthy("readiedRelease") && command_type == "CastSpell" {
        return Ok(());
    }
    if context.truthy("spellMovement") && command_type == "MoveActor" && js::is_true(command.get("reaction_movement")) {
        return Ok(());
    }
    let action_id = command.get("action_id");
    let pending_reaction = combat.get("reaction_window").filter(|window| js::truthy(Some(window)));
    if sk_ruleset::rules_core::uses_dnd2014(Some(state)) && command_type == "UseCombatAction" {
        if let Some(window) = pending_reaction.filter(|window| actor_text.is_some_and(|id| js::string(window.get("actor_id")) == id)) {
            if action_id.and_then(Value::as_str) == Some("decline-reaction") {
                return Ok(());
            }
            if list_includes(window.get("action_ids"), action_id)? {
                let free_choice = matches!(window.get("trigger").and_then(Value::as_str), Some("failed-saving-throw" | "saving-throw-bonus-choice"));
                if !free_choice {
                    if let Some(incapacitating) = incapacitating_condition_for(state, &actor_key) {
                        return Err(rule(format!("Недееспособное существо не может совершать реакции ({incapacitating})"), "ACTOR_INCAPACITATED"));
                    }
                    if resource_spent(economy_at(combat, &actor_key), "reaction") {
                        return Err(rule("Реакция уже потрачена", "REACTION_SPENT"));
                    }
                }
                return Ok(());
            }
        }
    }
    let current = current_entry(combat);
    // В групповом режиме ходить может любой из текущей фазы, кто ещё не отходил.
    let completed: Vec<String> = combat.get("turn_completed").and_then(Value::as_array).map(|ids| ids.iter().map(string_of).collect()).unwrap_or_default();
    let completed_this_phase = actor_text.is_some_and(|id| completed.iter().any(|entry| entry == id));
    let group_turn = actor_text.is_some_and(|id| initiative_group_ids(state).iter().any(|member| member == id)) && !completed_this_phase;
    if completed_this_phase {
        return Err(rule("Этот участник уже отходил в текущей фазе", "OUT_OF_TURN"));
    }
    if js::truthy(current) && actor_text != Some(js::string(at(current, "actor_id")).as_str()) && !group_turn {
        if command_type == "UseCombatAction" {
            let window = combat.get("reaction_window").filter(|window| js::truthy(Some(window)));
            if let Some(window) = window.filter(|window| actor_text.is_some_and(|id| js::string(window.get("actor_id")) == id)) {
                let action = sk_combat_content::combat_actions::combat_action_for(find_actor(), action_id).or_else(|| crate::enervation_link::enervation_continuation_action_for(state, actor_id, action_id));
                let trigger = window.get("trigger").and_then(Value::as_str);
                let permitted = action_id.and_then(Value::as_str) == Some("decline-reaction")
                    || trigger == Some("failed-saving-throw") && action_id.and_then(Value::as_str) == Some("indomitable")
                    || trigger == Some("saving-throw-bonus-choice") && list_includes(window.get("action_ids"), action_id)?
                    || list_includes(window.get("action_ids"), action_id)? && {
                        let id = action_id.and_then(Value::as_str);
                        matches!(id, Some("opportunity-attack" | "readied-attack" | "readied-spell"))
                            || match id {
                                Some(id) => id.starts_with("cast:"),
                                None => return Err(Fault::type_error("Cannot read properties of null (reading 'startsWith')").into()),
                            }
                            || at(action.as_ref(), "actionType").and_then(Value::as_str) == Some("reaction")
                    };
                if permitted {
                    return Ok(());
                }
            }
        }
        return Err(rule("Сейчас ход другого участника", "OUT_OF_TURN"));
    }
    let actor_conditions = game::conditions(state, &actor_key);
    let condition_text = |condition: &Value| match at(Some(condition), "id").filter(|id| !id.is_null()) {
        Some(id) => string_of(id),
        None => string_of(condition),
    };
    if let Some(command_condition) = actor_conditions.iter().find(|condition| condition_text(condition).starts_with("command:")) {
        let full = js::string(at(Some(command_condition), "id"));
        let option = String::from_utf16_lossy(&full.encode_utf16().skip("command:".len()).collect::<Vec<u16>>());
        let movement_command = command_type == "MoveActor";
        let end_turn_command = command_type == "EndTurn";
        if matches!(option.as_str(), "halt" | "drop" | "grovel") && !end_turn_command {
            return Err(rule("Существо должно исполнить наложенный приказ и окончить ход", "COMMAND_RESTRICTS_TURN"));
        }
        if matches!(option.as_str(), "approach" | "flee") && !movement_command && !end_turn_command {
            return Err(rule("Существо должно потратить ход на перемещение согласно приказу", "COMMAND_RESTRICTS_TURN"));
        }
    }
    let incapacitating = incapacitating_condition_for(state, &actor_key);
    if let Some(incapacitating) = incapacitating {
        let exempt = matches!(command_type.as_str(), "MoveActor" | "EndTurn" | "EndCombat") || (command_type == "UseCombatAction" && action_id.and_then(Value::as_str) == Some("indomitable"));
        if !exempt {
            return Err(rule(format!("Недееспособное существо не может совершать действия и реакции ({incapacitating})"), "ACTOR_INCAPACITATED"));
        }
    }
    let target = js::string(Some(&target_for(command)));
    let charmed_by_target = actor_conditions.iter().any(|condition| condition_text(condition) == "charmed" && js::s(at(Some(condition), "source_actor")) == target);
    if charmed_by_target && matches!(command_type.as_str(), "MakeAttack" | "CastSpell" | "UseCombatAction") {
        return Err(rule("Очарованное существо не может атаковать очаровавшего его", "CHARMED_ATTACK_FORBIDDEN"));
    }
    let economy = economy_at(combat, &actor_key);
    assert_normal_action_frame_available(command, economy)?;
    let pending_normal_action = has_untouched_normal_action_frame(economy);
    let truthy_field = |name: &str| js::truthy(economy.and_then(|economy| economy.get(name)));
    let kind_is = |kind: &str| economy.and_then(|economy| economy.get("attack_action_kind")).and_then(Value::as_str) == Some(kind);
    let uses_2014 = sk_ruleset::rules_core::uses_dnd2014(Some(state));
    match command_type.as_str() {
        "CastSpell" => {
            if js::is_true(at_path(state.get("mechanics"), &["shapes", &actor_key, "form", "wild_shape"])) {
                return Err(rule("В диком облике друид не колдует: сначала вернитесь в свой облик", "WILD_SHAPE_NO_SPELLS"));
            }
            let options = json!({ "rulesetId": state.get("ruleset_id").cloned().unwrap_or(Value::Null) });
            let spell = sk_combat_content::combat_spells::combat_spell_for(find_actor(), command.get("spell_id"), Some(&options));
            let action_type = spell.as_ref().and_then(|spell| spell.get("actionType")).and_then(Value::as_str);
            let quickened = condition_ids_for(state, &actor_key).contains("metamagic-quickened") && action_type == Some("action");
            let resource = if quickened || action_type == Some("bonus_action") {
                "bonus_action"
            } else if action_type == Some("reaction") {
                "reaction"
            } else {
                "action"
            };
            let surge_magic_forbidden = !uses_2014 && (truthy_field("surged_action_only") || kind_is("surge") && !pending_normal_action);
            let haste_only_action = kind_is("haste") && !pending_normal_action;
            if resource == "action" && (surge_magic_forbidden || haste_only_action) {
                return Err(rule("Дополнительное действие от Всплеска действий нельзя потратить на магию", "ACTION_SURGE_MAGIC_FORBIDDEN"));
            }
            if js::truthy(economy) && resource_spent(economy, resource) {
                return Err(spent(resource));
            }
        }
        "IdentifyEnemy" | "ReturnKnightHead" | "NegotiateScenarioTreaty" | "ProposeParley" | "CalmBeast" | "FeedBeast" => {
            if resource_spent(economy, "action") {
                return Err(action_spent());
            }
        }
        "LootContainer" => {
            let container = sk_director::loot_containers::loot_container_for(state, command.get("container_id"));
            let cost = sk_director::loot_containers::loot_combat_action_for(state, actor_id, container.as_ref());
            if cost != Some("object_interaction") && resource_spent(economy, "action") {
                return Err(action_spent());
            }
        }
        "ResolveImprovisedAction" => {
            let cost = command.get("action_cost").and_then(Value::as_str);
            let resource = match cost {
                Some("bonus_action") => Some("bonus_action"),
                Some("free") => None,
                _ => Some("action"),
            };
            if let Some(resource) = resource.filter(|resource| resource_spent(economy, resource)) {
                return Err(if resource == "bonus_action" { spent("bonus_action") } else { action_spent() });
            }
            if resource == Some("action") && (truthy_field("surged_action_only") || kind_is("haste")) {
                return Err(rule("Дополнительное действие от Всплеска действий нельзя потратить на импровизацию", "ACTION_SURGE_IMPROVISED_FORBIDDEN"));
            }
        }
        "UseCombatAction" => {
            let action = sk_combat_content::combat_actions::combat_action_for(find_actor(), action_id).or_else(|| crate::enervation_link::enervation_continuation_action_for(state, actor_id, action_id));
            let resource = match at(action.as_ref(), "actionType").and_then(Value::as_str) {
                Some("bonus_action") => Some("bonus_action"),
                Some("reaction") => Some("reaction"),
                Some("free") => None,
                _ => Some("action"),
            };
            if let Some(resource) = resource.filter(|resource| resource_spent(economy, resource)) {
                return Err(spent(resource));
            }
            if resource == Some("action") && kind_is("haste") && !haste_action_allows(action_id) && !pending_normal_action {
                return Err(rule("Ускоренное действие ограничено атакой, рывком, отходом, засадой или предметом", "HASTE_ACTION_LIMIT"));
            }
        }
        "UseItem" => {
            let use_profile = command.get("use_profile");
            let resource = match at(use_profile, "combat_action").and_then(Value::as_str) {
                Some("bonus_action") => Some("bonus_action"),
                Some("action") => Some("action"),
                _ => None,
            };
            let surge_magic_forbidden = !uses_2014 && (truthy_field("surged_action_only") || kind_is("surge") && !pending_normal_action);
            if resource == Some("action") && at(use_profile, "kind").and_then(Value::as_str) == Some("cast_spell") && (surge_magic_forbidden || kind_is("haste") && !pending_normal_action) {
                return Err(rule("Дополнительное действие от Всплеска действий нельзя потратить на магию", "ACTION_SURGE_MAGIC_FORBIDDEN"));
            }
            let attacks_used = js::safe_int(economy.and_then(|economy| economy.get("attacks_used")), 0).max(0);
            let versioned_frame = if event_version(economy.unwrap_or(&Value::Null)) >= ACTION_ECONOMY_EVENT_VERSION { current_frame(economy.unwrap_or(&Value::Null)) } else { None };
            let continuation = resource == Some("action")
                && js::is_true(at(use_profile, "attack_replacement"))
                && command.get("use_mode").and_then(Value::as_str) != Some("spill")
                && match &versioned_frame {
                    Some(frame) => !resource_spent(economy, "action") || attacks_used > 0 && attacks_used < frame.limit,
                    None => attacks_used > 0 && (attacks_used as f64) < sk_combat_content::combat_actions::weapon_attacks_per_action_for(find_actor()),
                };
            if let Some(resource) = resource.filter(|resource| resource_spent(economy, resource) && !continuation) {
                return Err(if resource == "bonus_action" { spent("bonus_action") } else { action_spent() });
            }
        }
        "ActivateItem" => {
            if resource_spent(economy, "bonus_action") {
                return Err(spent("bonus_action"));
            }
        }
        "EquipItem" => {
            if command.get("combat_action").and_then(Value::as_str) == Some("action") && resource_spent(economy, "action") {
                return Err(rule("Взаимодействие с предметом требует действия, но оно уже потрачено", "ACTION_SPENT"));
            }
        }
        "UseMonsterAction" | "MakeAttack" | "MakeAreaAttack" | "ChangeWeapon" => {
            let attacks_used = js::safe_int(economy.and_then(|economy| economy.get("attacks_used")), 0).max(0);
            // Замедленное существо делает не больше одной атаки за ход.
            if command_type == "MakeAttack"
                && attacks_used >= 1
                && condition_ids_for(state, &actor_key).iter().any(|condition| crate::tables::condition_effect(condition).is_some_and(|effect| js::is_true(effect.get("singleAttackPerTurn"))))
            {
                return Err(rule("Замедленное существо совершает не больше одной атаки за ход", "SLOWED_SINGLE_ATTACK"));
            }
            let multiattack_command = command.get("monster_ability").and_then(Value::as_str) == Some("multiattack");
            if command_type == "MakeAttack" && multiattack_command {
                check_multiattack(command, state, context, economy, find_actor(), attacks_used)?;
            }
            if js::truthy(economy) && resource_spent(economy, "action") {
                if command_type == "MakeAttack" && is_monk_bonus_attack_context(context) {
                    return Ok(());
                }
                // Удар бонусным действием платит бонусным действием родительского умения.
                if command_type == "MakeAttack" && context.loading_action_type.as_ref().and_then(Value::as_str) == Some("bonus_action") {
                    return Ok(());
                }
                let economy_value = economy.unwrap_or(&Value::Null);
                if command_type == "MakeAttack" && event_version(economy_value) >= ACTION_ECONOMY_EVENT_VERSION {
                    let attack_limit = js::safe_int(economy_value.get("attack_action_limit"), js::safe_int(economy_value.get("attacks_allowed"), 1)).max(1);
                    let continuation = attacks_used > 0 && attacks_used < attack_limit;
                    let queued_extra_action = js::safe_int(economy_value.get("extra_actions"), 0).max(0) > 0;
                    if !(continuation || queued_extra_action) {
                        return Err(action_spent());
                    }
                } else {
                    let actor = find_actor();
                    let attacks_allowed = if command_type == "MakeAttack" { crate::turn_economy::allowed_weapon_attacks(state, actor, &actor_key) } else { 1 };
                    let hasted = f64::from(u8::from(condition_ids_for(state, &actor_key).contains("hasted")));
                    let class_attack_limit = sk_combat_content::combat_actions::weapon_attacks_per_action_for(actor) + hasted;
                    let class_continuation = attacks_used > 0 && (attacks_used as f64) < class_attack_limit;
                    let monster_continuation = command_type == "MakeAttack" && multiattack_command && attacks_used > 0 && attacks_used < attacks_allowed;
                    if !(class_continuation || monster_continuation) {
                        return Err(action_spent());
                    }
                }
            }
            if command_type == "MakeAreaAttack" && kind_is("haste") && !pending_normal_action {
                return Err(rule("Ускоренное действие нельзя потратить на область", "HASTE_ACTION_LIMIT"));
            }
        }
        _ => {}
    }
    Ok(())
}

/// Проверка заявленной мультиатаки (5757–5782).
fn check_multiattack(command: &Value, _state: &Value, context: &Context, economy: Option<&Value>, actor: Option<&Value>, attacks_used: i64) -> Step {
    let field = |name: &str| economy.and_then(|economy| economy.get(name));
    let used_raw = field("multiattack_action_ids").filter(|value| !value.is_null());
    let sequence = monster_multiattack_action_ids(actor, command.get("action_id"), used_raw)?;
    let expected_action_id = sequence.get(attacks_used as usize);
    let multiattack = monster_trait_for(actor, "multiattack");
    let action_counts = monster_multiattack_action_counts(multiattack);
    let used_action_ids: Vec<String> = match field("multiattack_action_ids") {
        Some(Value::Array(ids)) => ids.iter().map(string_of).collect(),
        _ if attacks_used > 0 && js::truthy(field("multiattack_action_id")) => vec![js::string(field("multiattack_action_id"))],
        _ => Vec::new(),
    };
    let command_action = js::s(command.get("action_id"));
    let action_count_valid = action_counts.is_empty() || (used_action_ids.iter().filter(|id| **id == command_action).count() as i64) < action_counts.get(&command_action).copied().unwrap_or(0);
    let same_action_mismatch = js::is_true(at(multiattack, "same_action")) && attacks_used > 0 && js::s(field("multiattack_action_id")) != command_action;
    let invalid = !context.truthy("isNpcScheduler")
        || sequence.len() <= 1
        || same_action_mismatch
        || !action_count_valid
        || action_counts.is_empty() && command_action != expected_action_id.cloned().unwrap_or_default()
        || js::safe_int(command.get("multiattack_index"), 0) != attacks_used + 1
        || js::safe_int(command.get("multiattack_count"), 0) != sequence.len() as i64;
    if invalid {
        return Err(rule("Команда не соответствует объявленной последовательности multiattack", "INVALID_MONSTER_MULTIATTACK"));
    }
    Ok(())
}

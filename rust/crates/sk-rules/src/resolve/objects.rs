//! Ветки `resolveCommandInternal`: Объекты сцены `OperateSceneObject` и импровизированное действие. Задача Р11.
//!
//! JS: `server/rules-engine.mjs`, 15306–15316, 19280–19723. Диспетчер — `resolve/dispatch.rs`
//! (Р0); ветка дописывает события в `r.events` и броски в `r.rolls`.

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexSet;
use sk_core::{game, js};
use sk_npc_world::blessings::{blessing_omen_for, BLESSINGS_POLICY_ID, BLESSING_ATTACK_BONUS, BLESSING_CONDITION, BLESSING_DURATION, PRAYER_ABILITY, PRAYER_DC, PRAYER_MINUTES, PRAYER_SKILL};
use sk_ruleset::lockpicking::{has_thieves_tools, THIEVES_TOOLS_REQUIRED_CODE, THIEVES_TOOLS_REQUIRED_MESSAGE};
use sk_tactical::scene_interactions::{scene_interaction_definition, scene_object_label_for, scene_object_loot, SCENE_INTERACTION_POLICY_ID};
use sk_tactical::tactical_map::TacticalMap;

use super::doors::{action_spent, actor_targets, ensure_map, roll_check};
use super::kernel::undef;
use super::world_time::TimeAdvanceOptions;
use super::Resolve;
use crate::checks::saves::{check_roll_from_verified, roll_ability_check_with_conditions, saved_damage_amount, D20Method};
use crate::checks::skills::skill_proficiency_bonus;
use crate::command::rules::rule_ids;
use crate::constants::{REST_EVENT_SCHEMA_VERSION, REST_MINIMUM_MINUTES_SHORT, REST_POLICY_ID};
use crate::core::{ability_modifier, command_with, command_with_rules, event_from, slice_utf16, spread_value};
use crate::death::zero_hit_point_damage_consequences;
use crate::lockpick::{lockpick_check_modifier, lockpick_notice_events, LockpickNotice};
use crate::pause::{rule, Fault, Interrupt, Flow};
use crate::preview_checks::{blessing_granted_events, preview_d20_check, scene_place_text, shrine_prayer_refusal_for, BlessingGrant};
use crate::validate::common::js_includes;

fn at<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(Value::as_object).and_then(|map| map.get(key))
}

/// Поле, которое JS кладёт как есть (`undefined` в JSON не попадает).
fn insert_present(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value.clone());
    }
}

/// `{ ...event, [key]: value }`.
fn with_field(mut event: Value, key: &str, value: Value) -> Value {
    if let Some(map) = event.as_object_mut() {
        map.insert(key.into(), value);
    }
    event
}

/// `ResolveImprovisedAction` (15306–15316).
pub fn resolve_improvised_action(r: &mut Resolve<'_>) -> Flow {
    if !game::combat_active(&r.state) {
        return Ok(());
    }
    let action_type = match r.command.get("action_cost").and_then(Value::as_str) {
        Some("bonus_action") => "bonus_action",
        Some("free") => "free",
        _ => "action",
    };
    let summary = r.command.get("summary").filter(|value| js::truthy(Some(value))).map_or_else(|| "Импровизация".to_string(), |value| js::string(Some(value)));
    let payload = json!({ "action_id": "improvised-action", "name": slice_utf16(&summary, 160), "action_type": action_type, "improvised": true });
    let source = command_with_rules(&r.command, &[rule_ids::TURNS]);
    r.events.push(event_from(&source, "CombatActionUsed", Some(payload), Some(&actor_targets(&r.command))));
    Ok(())
}

/// Неизменные данные разбора объекта: карта, проп, определение, состояние
/// взаимодействия.
struct SceneObject {
    map: TacticalMap,
    /// Проп в форме JS (`map.props[i]`).
    prop: Value,
    prop_id: Value,
    definition: Value,
    interaction: Value,
    /// `state.mechanics.combat.active` как есть.
    in_combat: Option<Value>,
    actor: Option<Value>,
}

impl SceneObject {
    fn definition(&self, key: &str) -> Option<&Value> {
        self.definition.get(key)
    }

    fn kind(&self) -> Option<&Value> {
        self.definition("kind")
    }

    fn interaction_state(&self) -> Option<&Value> {
        self.interaction.get("state")
    }

    fn interaction_flag(&self, key: &str) -> bool {
        js::truthy(self.interaction.get(key))
    }

    fn state_is(&self, wanted: &str) -> bool {
        self.interaction_state().and_then(Value::as_str) == Some(wanted)
    }
}

/// `resolveSceneCheck(checkDefinition, modifierOverride)`: проверка у объекта
/// и событие `SceneObjectCheckResolved`.
fn resolve_scene_check(r: &mut Resolve<'_>, object: &SceneObject, check: &Value, modifier_override: Option<i64>) -> Result<Value, Interrupt> {
    let actor_id = js::s(r.command.get("actor_id"));
    let actor = object.actor.as_ref();
    let ability = check.get("ability");
    let skill = check.get("skill");
    let modifier = match modifier_override {
        Some(modifier) => modifier,
        None => ability_modifier(at(at(actor, "abilities"), &js::string(ability))) + skill_proficiency_bonus(actor, &js::s(skill), Some(&r.state)),
    };
    let mut options = Map::new();
    options.insert("modifier".into(), Value::from(modifier));
    options.insert("difficulty".into(), undef(check.get("dc")));
    options.insert("purpose".into(), undef(check.get("purpose")));
    options.insert("actorId".into(), undef(r.command.get("actor_id")));
    options.insert("visibility".into(), undef(r.command.get("visibility")));
    let result = roll_ability_check_with_conditions(&r.state, &mut r.dice, &actor_id, ability, &Value::Object(options), D20Method::RollCheck)?;
    r.rolls.push(result.clone());
    let mut payload = Map::new();
    payload.insert("prop_id".into(), object.prop_id.clone());
    insert_present(&mut payload, "intent", r.command.get("intent"));
    insert_present(&mut payload, "approach", r.command.get("approach"));
    insert_present(&mut payload, "ability", ability);
    insert_present(&mut payload, "skill", skill);
    insert_present(&mut payload, "difficulty", check.get("dc"));
    payload.extend(spread_value(Some(&result)));
    let source = command_with_rules(&r.command, &[rule_ids::ABILITY_CHECK]);
    r.events.push(event_from(&source, "SceneObjectCheckResolved", Some(Value::Object(payload)), Some(&json!([]))));
    Ok(result)
}

/// `operated()`: событие `SceneObjectOperated`.
fn operated(r: &mut Resolve<'_>, object: &SceneObject) {
    let mut payload = Map::new();
    payload.insert("prop_id".into(), object.prop_id.clone());
    insert_present(&mut payload, "kind", object.kind());
    insert_present(&mut payload, "intent", r.command.get("intent"));
    insert_present(&mut payload, "approach", r.command.get("approach"));
    insert_present(&mut payload, "action_spent", object.in_combat.as_ref());
    payload.insert("policy_id".into(), json!(SCENE_INTERACTION_POLICY_ID));
    r.events.push(event_from(&r.command, "SceneObjectOperated", Some(Value::Object(payload)), Some(&json!([]))));
}

/// `SceneObjectStateChanged` с полями в порядке места вызова.
fn state_changed(r: &mut Resolve<'_>, fields: Vec<(&str, Option<Value>)>) {
    let mut payload = Map::new();
    for (key, value) in fields {
        if let Some(value) = value {
            payload.insert(key.into(), value);
        }
    }
    r.events.push(event_from(&r.command, "SceneObjectStateChanged", Some(Value::Object(payload)), Some(&json!([]))));
}

/// `sceneObjectLoot({ mapSeed: map.seed, prop })`.
fn loot_of(object: &SceneObject) -> Result<Value, Interrupt> {
    scene_object_loot(&object.map.seed, Some(&object.prop)).map(Value::Array).map_err(|message| Fault::new("Error", message).into())
}

/// Урон по `targetId` с разбором защит и последствиями нуля хитов.
fn apply_object_damage(r: &mut Resolve<'_>, state: &Value, target_id: &str, amount: Value, damage_type: Option<&Value>, prop_id: &Value, reason: &str) -> Flow {
    let damage_type = damage_type.cloned().unwrap_or(Value::Null);
    let resolved = r.resolve_damage_payload(state, target_id, amount, &damage_type, None, None)?;
    let mut payload = spread_value(Some(&resolved));
    payload.insert("prop_id".into(), prop_id.clone());
    payload.insert("reason".into(), json!(reason));
    let payload = Value::Object(payload);
    let source = command_with_rules(&r.command, &[rule_ids::DAMAGE]);
    r.events.push(event_from(&source, "DamageApplied", Some(payload.clone()), Some(&json!([target_id]))));
    let consequences = zero_hit_point_damage_consequences(state, &r.command, target_id, &payload, false);
    r.events.extend(consequences);
    Ok(())
}

/// `OperateSceneObject` (19280–19723).
pub fn operate_scene_object(r: &mut Resolve<'_>) -> Flow {
    let Some(map) = ensure_map(r)? else {
        return Err(rule("Для объекта нужна тактическая карта", "TACTICAL_MAP_REQUIRED"));
    };
    let props: Vec<Value> = map.props.iter().map(|prop| prop.to_json()).collect();
    let wanted = r.command.get("prop_id").and_then(Value::as_str);
    let Some(index) = map.props.iter().position(|candidate| Some(candidate.id.as_str()) == wanted) else {
        return Err(rule("Такого объекта нет на карте", "SCENE_OBJECT_NOT_FOUND"));
    };
    let tactical_prop = map.props[index].clone();
    let prop = props[index].clone();
    if !tactical_prop.interactive {
        return Err(rule("Этот объект не отмечен как интерактивный", "SCENE_OBJECT_NOT_INTERACTIVE"));
    }
    let prop_id = Value::String(tactical_prop.id.clone());
    let Some(definition) = scene_interaction_definition(&map.seed, &props, Some(&prop_id)) else {
        return Err(rule("Для этого объекта нет серверного правила взаимодействия", "SCENE_OBJECT_UNSUPPORTED"));
    };
    if !js_includes(definition.get("verbs"), r.command.get("intent"), "definition.verbs")? {
        return Err(rule("Для этого объекта такое действие недоступно", "SCENE_OBJECT_INTENT_NOT_ALLOWED"));
    }
    let actor_id = js::s(r.command.get("actor_id"));
    let Some(at_point) = game::actor_position(&r.state, &actor_id) else {
        return Err(rule("Участник должен находиться на карте", "MAP_POSITION_REQUIRED"));
    };
    let anchor = sk_geometry::Point::new(at_point.x as f64, at_point.y as f64);
    if crate::geometry::footprint::actor_object_distance_cells(&r.state, &actor_id, &prop, Some(anchor)) > 1.0 {
        return Err(rule("До объекта нужно дотянуться: встаньте вплотную", "SCENE_OBJECT_OUT_OF_REACH"));
    }
    let actor = game::find_actor(&r.state, &actor_id).cloned();
    if !actor.as_ref().is_some_and(game::is_living_actor) {
        return Err(rule("Взаимодействовать может только дееспособный участник", "ACTOR_DEFEATED"));
    }
    let interaction = crate::scene::objects::scene_object_state(&r.state, &tactical_prop, &definition);
    let in_combat = game::combat(&r.state).get("active").cloned();
    let combat_active = js::truthy(in_combat.as_ref());
    if action_spent(&r.state, &actor_id) {
        return Err(rule("Действие на этом ходу уже потрачено", "ACTION_SPENT"));
    }
    let intent = r.command.get("intent").cloned();
    let intent_is = |wanted: &str| intent.as_ref().and_then(Value::as_str) == Some(wanted);
    let kind = js::s(definition.get("kind"));
    if kind == "campfire" && intent_is("use") && combat_active {
        return Err(rule("Нельзя устраивать привал во время активного боя", "REST_DURING_COMBAT"));
    }
    let state = r.state.clone();
    let object = SceneObject { map, prop, prop_id: prop_id.clone(), definition, interaction, in_combat, actor };
    let at_json = json!({ "x": at_point.x, "y": at_point.y });

    if intent_is("pray") {
        return pray(r, &state, &object);
    }

    if intent_is("topple") || intent_is("ignite") {
        if object.state_is("toppled") || object.state_is("burning") || object.state_is("burned") {
            return Err(rule("Объект уже изменён и второй раз не поддаётся", "SCENE_OBJECT_ALREADY_ALTERED"));
        }
        let hazard = object.definition(if intent_is("topple") { "topple" } else { "ignite" }).filter(|value| js::truthy(Some(value))).cloned();
        let Some(hazard) = hazard else {
            return Err(rule("Для этого объекта такое действие недоступно", "SCENE_OBJECT_INTENT_NOT_ALLOWED"));
        };
        let cells = sk_combat_content::scene_hazards::hazard_prop_cells(Some(&object.prop));
        if cells.is_empty() {
            return Err(rule("У объекта нет клеток на карте", "SCENE_OBJECT_OUT_OF_REACH"));
        }
        operated(r, &object);
        if intent_is("topple") {
            let mut check_definition = Map::new();
            for key in ["ability", "skill", "dc", "purpose"] {
                insert_present(&mut check_definition, key, hazard.get(key));
            }
            let check = resolve_scene_check(r, &object, &Value::Object(check_definition), None)?;
            if !js::truthy(check.get("success")) {
                state_changed(r, vec![("prop_id", Some(prop_id.clone())), ("state", object.interaction_state().cloned()), ("success", Some(json!(false))), ("intent", intent.clone())]);
                return Ok(());
            }
            topple_victims(r, &state, &object, &hazard, &cells)?;
            state_changed(r, vec![("prop_id", Some(prop_id.clone())), ("state", Some(json!("toppled"))), ("intent", intent.clone())]);
            return Ok(());
        }
        let map_props = Value::Array(object.map.props.iter().map(|prop| prop.to_json()).collect());
        let Some(source) = sk_combat_content::scene_hazards::fire_source_near(Some(&map_props), Some(&at_json), object.actor.as_ref()) else {
            return Err(rule("Нечем поджечь: рядом нет открытого огня и нет подходящего предмета", "SCENE_OBJECT_NO_FIRE_SOURCE"));
        };
        let round = game::combat(&state).get("round").cloned();
        let effect = sk_combat_content::scene_hazards::burning_prop_effect(sk_combat_content::scene_hazards::BurningPropInput {
            prop_id: Some(&prop_id),
            command_id: r.command.get("command_id"),
            cells: &cells,
            definition: &hazard,
            source_actor_id: r.command.get("actor_id"),
            round: round.as_ref(),
        });
        let effect_id = effect.get("effect_id").cloned();
        let source_rules = command_with_rules(&r.command, &[rule_ids::CONDITIONS]);
        r.events.push(event_from(&source_rules, "SpellAreaCreated", Some(json!({ "effect": effect })), Some(&json!([]))));
        state_changed(
            r,
            vec![("prop_id", Some(prop_id.clone())), ("state", Some(json!("burning"))), ("intent", intent.clone()), ("fire_source", source.get("kind").cloned()), ("effect_id", effect_id)],
        );
        return Ok(());
    }

    if intent_is("inspect") {
        let attempted_by = object.interaction.get("inspection_attempted_by");
        let attempted_by_len = attempted_by.and_then(Value::as_array).map_or(0, Vec::len);
        let attempted = js_includes(attempted_by, r.command.get("actor_id"), "interaction.inspection_attempted_by")? || (object.interaction_flag("inspection_attempted") && attempted_by_len == 0);
        if attempted {
            return Err(rule("Этот герой уже осматривал объект", "SCENE_OBJECT_ALREADY_INSPECTED"));
        }
        operated(r, &object);
        // `success` и `trap_detected` берут `check.success` как есть.
        let mut success = Some(Value::Bool(true));
        let mut trap_detected = Some(Value::Bool(false));
        let trap = object.definition("trap").filter(|value| js::truthy(Some(value))).cloned();
        let check = object.definition("check").filter(|value| js::truthy(Some(value))).cloned();
        if kind == "container" && trap.is_some() {
            let notice = trap.as_ref().and_then(|trap| trap.get("notice")).cloned().unwrap_or(Value::Null);
            let result = resolve_scene_check(r, &object, &notice, None)?;
            success = result.get("success").cloned();
            trap_detected = success.clone();
        } else if let Some(check) = check {
            let result = resolve_scene_check(r, &object, &check, None)?;
            success = result.get("success").cloned();
        }
        let mut payload = Map::new();
        payload.insert("prop_id".into(), prop_id.clone());
        insert_present(&mut payload, "kind", object.kind());
        insert_present(&mut payload, "success", success.as_ref());
        insert_present(&mut payload, "trap_detected", trap_detected.as_ref());
        r.events.push(event_from(&r.command, "SceneObjectInspected", Some(Value::Object(payload)), Some(&json!([]))));
        let detail = object.definition("detail").filter(|value| js::truthy(Some(value))).cloned();
        if let Some(detail) = detail.filter(|_| js::truthy(success.as_ref())) {
            let mut payload = Map::new();
            payload.insert("prop_id".into(), prop_id.clone());
            payload.insert("knowledge_id".into(), Value::String(format!("{}:{}", js::string(Some(&prop_id)), js::string(detail.get("id")))));
            insert_present(&mut payload, "detail_key", object.definition("detailKey"));
            insert_present(&mut payload, "text", detail.get("text"));
            r.events.push(event_from(&r.command, "SceneObjectKnowledgeRevealed", Some(Value::Object(payload)), Some(&json!([]))));
        }
        return Ok(());
    }

    if intent_is("lockpick") {
        if kind != "container" {
            return Err(rule("Замок бывает только у контейнера", "SCENE_OBJECT_INTENT_NOT_ALLOWED"));
        }
        if object.interaction_flag("opened") || object.state_is("open") || object.state_is("taken") {
            return Err(rule("Этот контейнер уже открыт", "SCENE_OBJECT_ALREADY_OPEN"));
        }
        if !has_thieves_tools(object.actor.as_ref()) {
            return Err(rule(THIEVES_TOOLS_REQUIRED_MESSAGE, THIEVES_TOOLS_REQUIRED_CODE));
        }
        let lock = object.definition("lock").filter(|value| js::truthy(Some(value))).cloned();
        let Some(lock) = lock.filter(|_| object.state_is("locked")) else {
            return Err(rule("Замка на этом объекте нет — крышка просто откидывается", "SCENE_OBJECT_NOT_LOCKED"));
        };
        operated(r, &object);
        let mut check_definition = spread_value(Some(&lock));
        check_definition.insert("purpose".into(), json!("scene-object:container:lockpick"));
        let check = resolve_scene_check(r, &object, &Value::Object(check_definition), Some(lockpick_check_modifier(object.actor.as_ref())))?;
        let label = scene_object_label_for(object.prop.get("assetId"));
        let label = Value::String(if label.is_empty() { "чужой замок".into() } else { label });
        let kind_value = json!("prop");
        let notices = lockpick_notice_events(&state, &r.command, LockpickNotice { target_kind: Some(&kind_value), target_id: Some(&prop_id), target_label: Some(&label), check: Some(&check), notice: None });
        r.events.extend(notices);
        if !js::truthy(check.get("success")) {
            let current = object.interaction_state().cloned();
            state_changed(r, vec![("prop_id", Some(prop_id.clone())), ("state", current.clone()), ("previous_state", current), ("success", Some(json!(false))), ("intent", intent.clone())]);
            return Ok(());
        }
        return container_opened(r, &state, &object, intent.as_ref());
    }

    if intent_is("open") {
        if kind != "container" {
            return Err(rule("Открывать можно только контейнер", "SCENE_OBJECT_INTENT_NOT_ALLOWED"));
        }
        if object.interaction_flag("opened") || object.state_is("open") || object.state_is("taken") {
            return Err(rule("Этот контейнер уже открыт", "SCENE_OBJECT_ALREADY_OPEN"));
        }
        let force = r.command.get("approach").and_then(Value::as_str) == Some("force");
        if object.state_is("locked") && !force {
            return Err(rule("Здесь замок: его вскрывают отмычками или ломают силой", "SCENE_OBJECT_LOCKED"));
        }
        operated(r, &object);
        let mut success = Value::Bool(true);
        if object.state_is("locked") {
            let dc = at(object.definition("lock"), "dc").filter(|value| !value.is_null()).cloned().unwrap_or(json!(12));
            let check = resolve_scene_check(r, &object, &json!({ "ability": "str", "skill": "athletics", "dc": dc, "purpose": "scene-object:container:force" }), None)?;
            success = check.get("success").cloned().unwrap_or(Value::Null);
        } else if force {
            let check = resolve_scene_check(r, &object, &json!({ "ability": "str", "skill": "athletics", "dc": 10, "purpose": "scene-object:container:force" }), None)?;
            success = check.get("success").cloned().unwrap_or(Value::Null);
        }
        if !js::truthy(Some(&success)) {
            let current = object.interaction_state().cloned();
            state_changed(r, vec![("prop_id", Some(prop_id.clone())), ("state", current.clone()), ("previous_state", current), ("success", Some(json!(false)))]);
            return Ok(());
        }
        return container_opened(r, &state, &object, intent.as_ref());
    }

    if intent_is("take") {
        if object.interaction_flag("loot_claimed") || object.interaction_flag("taken") {
            return Err(rule("Находка из этого объекта уже забрана", "SCENE_OBJECT_LOOT_ALREADY_CLAIMED"));
        }
        if kind == "container" && !object.interaction_flag("opened") && !object.state_is("open") {
            return Err(rule("Сначала контейнер нужно открыть", "SCENE_OBJECT_NOT_OPEN"));
        }
        operated(r, &object);
        let loot = loot_of(&object)?;
        let mut payload = Map::new();
        payload.insert("prop_id".into(), prop_id.clone());
        insert_present(&mut payload, "reward_key", object.definition("rewardKey"));
        payload.insert("loot".into(), loot);
        payload.insert("policy_id".into(), json!(SCENE_INTERACTION_POLICY_ID));
        r.events.push(event_from(&r.command, "SceneObjectLootGranted", Some(Value::Object(payload)), Some(&actor_targets(&r.command))));
        let current = object.interaction_state().cloned();
        state_changed(r, vec![("prop_id", Some(prop_id.clone())), ("state", Some(json!("taken"))), ("previous_state", current), ("success", Some(json!(true)))]);
        return Ok(());
    }

    if kind == "campfire" {
        let used_by = object.interaction.get("used_by");
        let used_by_len = used_by.and_then(Value::as_array).map_or(0, Vec::len);
        let used = js_includes(used_by, r.command.get("actor_id"), "interaction.used_by")? || (object.interaction_flag("used") && used_by_len == 0);
        if used {
            return Err(rule("Этот герой уже отдыхал у костра", "SCENE_OBJECT_ALREADY_USED"));
        }
        if js::truthy(game::mechanics(&state).get("resting").and_then(|resting| resting.get(actor_id.as_str()))) {
            return Err(rule("Герой уже отдыхает", "REST_ALREADY_STARTED"));
        }
        operated(r, &object);
        let started = js::safe_int(js::path(&state, &["mechanics", "world_time", "elapsed_minutes"]), 0).max(0);
        let rest_id = format!("rest:{}:campfire", js::string(r.command.get("command_id")));
        let rules = command_with_rules(&r.command, &[rule_ids::RESOURCE]);
        let started_payload = json!({
            "schema_version": REST_EVENT_SCHEMA_VERSION,
            "policy_id": REST_POLICY_ID,
            "rest_id": rest_id,
            "kind": "short",
            "started_at_minutes": started,
            "ended_at_minutes": null,
            "duration_minutes": 0,
            "minimum_duration_minutes": REST_MINIMUM_MINUTES_SHORT,
            "source_prop_id": prop_id,
        });
        let event = event_from(&rules, "RestStarted", Some(started_payload), Some(&actor_targets(&r.command)));
        r.events.push(with_field(event, "event_schema_version", json!(REST_EVENT_SCHEMA_VERSION)));
        r.append_world_time_consequences(&rules, Some(&json!(REST_MINIMUM_MINUTES_SHORT)), Some(&json!("minute")), TimeAdvanceOptions::default())?;
        let completed_payload = json!({
            "schema_version": REST_EVENT_SCHEMA_VERSION,
            "policy_id": REST_POLICY_ID,
            "rest_id": rest_id,
            "kind": "short",
            "started_at_minutes": started,
            "ended_at_minutes": started + REST_MINIMUM_MINUTES_SHORT,
            "duration_minutes": REST_MINIMUM_MINUTES_SHORT,
            "source_prop_id": prop_id,
        });
        let event = event_from(&rules, "RestCompleted", Some(completed_payload), Some(&actor_targets(&r.command)));
        r.events.push(with_field(event, "event_schema_version", json!(REST_EVENT_SCHEMA_VERSION)));
        let mut payload = Map::new();
        payload.insert("prop_id".into(), prop_id.clone());
        insert_present(&mut payload, "kind", object.kind());
        payload.insert("policy_id".into(), json!(SCENE_INTERACTION_POLICY_ID));
        r.events.push(event_from(&r.command, "SceneObjectUseRecorded", Some(Value::Object(payload)), Some(&actor_targets(&r.command))));
        return Ok(());
    }

    if object.interaction_flag("used") {
        return Err(rule("Эффект этого объекта уже использован", "SCENE_OBJECT_ALREADY_USED"));
    }
    if !object.interaction_flag("inspected") {
        return Err(rule("Сначала объект нужно осмотреть", "SCENE_OBJECT_NOT_INSPECTED"));
    }
    operated(r, &object);
    if let Some(effect) = object.definition("effect").filter(|value| js::truthy(Some(value))) {
        let before = js::safe_int(game::mechanics(&state).get("temporary_hp").and_then(|all| all.get(actor_id.as_str())), 0).max(0);
        let after = js::max_of([before as f64, js::number(effect.get("temporary_hp"))]);
        let mut payload = Map::new();
        payload.insert("prop_id".into(), prop_id.clone());
        insert_present(&mut payload, "effect_id", effect.get("id"));
        payload.insert("temporary_hp_before".into(), json!(before));
        payload.insert("temporary_hp_after".into(), js::num(after));
        let source = command_with_rules(&r.command, &[rule_ids::TEMPORARY_HP]);
        r.events.push(event_from(&source, "SceneObjectEffectApplied", Some(Value::Object(payload)), Some(&actor_targets(&r.command))));
    }
    let current = object.interaction_state().cloned();
    state_changed(r, vec![("prop_id", Some(prop_id)), ("state", Some(json!("used"))), ("previous_state", current), ("success", Some(json!(true)))]);
    Ok(())
}

/// Опрокинутая мебель: спасбросок Ловкости и урон тем, кто стоит под ней.
fn topple_victims(r: &mut Resolve<'_>, state: &Value, object: &SceneObject, hazard: &Value, cells: &[Value]) -> Flow {
    let covered: IndexSet<String> = cells.iter().map(|cell| format!("{}:{}", js::string(cell.get("x")), js::string(cell.get("y")))).collect();
    let actor_id = js::string(r.command.get("actor_id"));
    let caught: Vec<Value> = game::list_actors(state)
        .into_iter()
        .filter(|candidate| {
            let id = game::actor_id(candidate);
            if id == actor_id || !game::is_living_actor(candidate) {
                return false;
            }
            game::actor_position(state, &id).is_some_and(|at| covered.contains(&format!("{}:{}", at.x, at.y)))
        })
        .cloned()
        .collect();
    let save_ability = hazard.get("save_ability");
    for victim in caught {
        let victim_id = game::actor_id(&victim);
        let mut options = Map::new();
        options.insert("modifier".into(), Value::from(ability_modifier(at(victim.get("abilities"), &js::string(save_ability)))));
        options.insert("difficulty".into(), undef(hazard.get("save_dc")));
        options.insert("purpose".into(), json!("scene-object:topple-save"));
        options.insert("actorId".into(), json!(victim_id));
        options.insert("visibility".into(), undef(r.command.get("visibility")));
        let save = roll_check(r, &Value::Object(options))?;
        r.rolls.push(save.clone());
        let mut payload = spread_value(Some(&save));
        insert_present(&mut payload, "ability", save_ability);
        insert_present(&mut payload, "difficulty", hazard.get("save_dc"));
        payload.insert("prop_id".into(), object.prop_id.clone());
        let source = command_with_rules(&r.command, &[rule_ids::SAVING_THROW]);
        r.events.push(event_from(&source, "SavingThrowResolved", Some(Value::Object(payload)), Some(&json!([victim_id]))));
        let visibility = r.visibility();
        let damage_roll = r.roll_dice(hazard.get("damage").cloned().unwrap_or(Value::Null), "scene_object_topple_damage", json!(victim_id), visibility)?;
        r.rolls.push(damage_roll.clone());
        r.events.push(event_from(&r.command, "DieRolled", Some(damage_roll.clone()), Some(&json!([]))));
        let saved = js::is_true(save.get("success"));
        let amount = saved_damage_amount(state, &victim_id, save_ability, saved, true, damage_roll.get("total"));
        if amount > 0 {
            apply_object_damage(r, state, &victim_id, Value::from(amount), hazard.get("damage_type"), &object.prop_id, "scene-object-topple")?;
        }
        if !js::truthy(save.get("success")) {
            let source = command_with_rules(&r.command, &[rule_ids::CONDITIONS]);
            r.events.push(event_from(&source, "ConditionAdded", Some(json!({ "condition": "prone" })), Some(&json!([victim_id]))));
        }
    }
    Ok(())
}

/// `containerOpened(previousState, openedIntent)`: крышка откинута, находка
/// на виду, ловушка сработала.
fn container_opened(r: &mut Resolve<'_>, state: &Value, object: &SceneObject, opened_intent: Option<&Value>) -> Flow {
    let previous = object.interaction_state().cloned();
    let mut fields = vec![("prop_id", Some(object.prop_id.clone())), ("state", Some(json!("open"))), ("previous_state", previous), ("success", Some(json!(true))), ("intent", opened_intent.cloned())];
    if opened_intent.and_then(Value::as_str) == Some("lockpick") {
        fields.push(("lockpicked", Some(json!(true))));
    }
    state_changed(r, fields);
    let loot = loot_of(object)?;
    let mut payload = Map::new();
    payload.insert("prop_id".into(), object.prop_id.clone());
    insert_present(&mut payload, "reward_key", object.definition("rewardKey"));
    payload.insert("loot".into(), loot);
    payload.insert("policy_id".into(), json!(SCENE_INTERACTION_POLICY_ID));
    r.events.push(event_from(&r.command, "SceneObjectLootRevealed", Some(Value::Object(payload)), Some(&json!([]))));
    let trap = object.definition("trap").filter(|value| js::truthy(Some(value))).cloned();
    if let Some(trap) = trap.filter(|_| !object.interaction_flag("trap_detected")) {
        let damage = trap.get("damage");
        let purpose = js::string(at(damage, "purpose"));
        let visibility = r.visibility();
        let actor = r.command.get("actor_id").cloned().unwrap_or(Value::Null);
        let roll = r.roll_dice(at(damage, "expression").cloned().unwrap_or(Value::Null), &purpose, actor, visibility)?;
        r.rolls.push(roll.clone());
        r.events.push(event_from(&r.command, "DieRolled", Some(roll.clone()), Some(&json!([]))));
        let actor_id = js::s(r.command.get("actor_id"));
        apply_object_damage(r, state, &actor_id, roll.get("total").cloned().unwrap_or(Value::Null), at(damage, "type"), &object.prop_id, "scene-object-trap")?;
    }
    Ok(())
}

/// Молитва у святыни (`intent === 'pray'`).
fn pray(r: &mut Resolve<'_>, state: &Value, object: &SceneObject) -> Flow {
    let actor_value = r.command.get("actor_id").cloned().unwrap_or(Value::Null);
    if let Some(refusal) = shrine_prayer_refusal_for(state, &actor_value, &object.prop_id)? {
        return Err(rule(refusal.message, refusal.code));
    }
    let minutes = js::num(sk_social::npc_social::campaign_elapsed_minutes(state));
    operated(r, object);
    let mut preview_options = Map::new();
    preview_options.insert("actorId".into(), actor_value.clone());
    preview_options.insert("kind".into(), json!("check"));
    preview_options.insert("ability".into(), json!(PRAYER_ABILITY));
    preview_options.insert("skill".into(), json!(PRAYER_SKILL));
    preview_options.insert("difficulty".into(), json!(PRAYER_DC));
    let preview = preview_d20_check(state, &Value::Object(preview_options))?;
    let mut options = Map::new();
    options.insert("modifier".into(), undef(preview.get("modifier")));
    options.insert("difficulty".into(), json!(PRAYER_DC));
    options.insert("purpose".into(), Value::String(format!("shrine-prayer:{PRAYER_SKILL}")));
    options.insert("actorId".into(), undef(r.command.get("actor_id")));
    options.insert("advantage".into(), undef(preview.get("advantage")));
    options.insert("disadvantage".into(), undef(preview.get("disadvantage")));
    options.insert("visibility".into(), json!("party"));
    let options = Value::Object(options);
    let check = match check_roll_from_verified(r.command.get("verified_roll"), &options) {
        Some(check) => check,
        None => roll_check(r, &options)?,
    };
    r.rolls.push(check.clone());
    let party = command_with(&r.command, "visibility", json!("party"));
    let mut payload = Map::new();
    insert_present(&mut payload, "ability", preview.get("ability"));
    insert_present(&mut payload, "skill", preview.get("skill"));
    payload.extend(spread_value(Some(&check)));
    r.events.push(event_from(&command_with_rules(&party, &[rule_ids::ABILITY_CHECK]), "AbilityCheckResolved", Some(Value::Object(payload)), Some(&json!([actor_value]))));
    let success = js::truthy(check.get("success"));
    let omen = if !success && js::safe_int(check.get("kept"), 0) == 1 {
        let seed = format!("{}:{}:{}", js::s(state.get("sessionCode")), js::string(Some(&object.prop_id)), js::string(Some(&minutes)));
        blessing_omen_for(Some(&Value::String(seed))).to_string()
    } else {
        String::new()
    };
    let outcome = if success {
        "blessed"
    } else if !omen.is_empty() {
        "omen"
    } else {
        "silence"
    };
    let shrine_name = slice_utf16(&scene_place_text(state), 180);
    let event_id = format!("shrine-prayer:{}", slice_utf16(&js::string(r.command.get("command_id")), 100));
    let mut payload = Map::new();
    insert_present(&mut payload, "hero_id", r.command.get("actor_id"));
    payload.insert("prop_id".into(), object.prop_id.clone());
    payload.insert("place_name".into(), json!(shrine_name));
    payload.insert("outcome".into(), json!(outcome));
    payload.insert("skill".into(), json!(PRAYER_SKILL));
    payload.insert("difficulty".into(), json!(PRAYER_DC));
    payload.insert("total".into(), json!(js::safe_int(check.get("total"), 0)));
    if !omen.is_empty() {
        payload.insert("omen".into(), json!(omen));
    }
    if outcome == "blessed" {
        payload.insert("condition".into(), json!(BLESSING_CONDITION));
        payload.insert("attack_bonus".into(), json!(BLESSING_ATTACK_BONUS));
        payload.insert("duration".into(), json!(BLESSING_DURATION));
    }
    payload.insert("at_minutes".into(), minutes.clone());
    payload.insert("policy_id".into(), json!(BLESSINGS_POLICY_ID));
    let event = event_from(&party, "ShrinePrayerResolved", Some(Value::Object(payload)), Some(&json!([actor_value])));
    r.events.push(with_field(event, "event_id", json!(event_id)));
    if outcome == "blessed" {
        let grant = BlessingGrant {
            hero_id: actor_value,
            source: "shrine".into(),
            place_name: shrine_name,
            npc_id: String::new(),
            npc_name: String::new(),
            minutes,
            source_event_id: event_id,
        };
        let granted = blessing_granted_events(&r.command, state, &grant);
        r.events.extend(granted);
    }
    let source = command_with_rules(&r.command, &[rule_ids::RESOURCE]);
    r.append_world_time_consequences(&source, Some(&json!(PRAYER_MINUTES)), Some(&json!("minute")), TimeAdvanceOptions::default())
}

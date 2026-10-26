//! События предметов в бою: брошенная склянка, вещь противника, рассыпанная
//! зона; порядок инициативы. Задача Р11.
//!
//! JS: `server/rules-engine.mjs`, 8692–8974 (кроме 8771 — `npcEquipmentSpentEvent`,
//! он в `combat::npc_items`, Р3), 12180 (`sortedInitiative`).
//!
//! В JS склянка и вещь противника получают кости, броски, разбор урона и
//! спасбросок параметрами; единственный вызывающий — ветка `UseItem`, и
//! параметры там — замыкания разбора. Здесь это методы [`Resolve`]: события
//! защит и вдохновения, как и в JS, уходят в `r.events` раньше событий,
//! которые функция возвращает.

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexSet;
use sk_core::{game, js, text};

use crate::checks::saves::{is_saving_throw_proficient, saving_throw_succeeded};
use crate::command::rules::rule_ids;
use crate::core::{ability_modifier, actor_max_hp, command_with, command_with_rules, event_from, slice_utf16, spread_value, unique_strings};
use crate::death::zero_hit_point_damage_consequences;
use crate::pause::{rule, Halt};
use crate::resolve::kernel::undef;
use crate::resolve::Resolve;

fn at<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(Value::as_object).and_then(|map| map.get(key))
}

fn at_path<'a>(value: Option<&'a Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().fold(value, |value, key| at(value, key))
}

/// Поле, которое JS кладёт как есть (`undefined` в JSON не попадает).
fn insert_present(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value.clone());
    }
}

/// `value ?? null`.
fn or_null(value: Option<&Value>) -> Value {
    value.cloned().unwrap_or(Value::Null)
}

/// `value ?? fallback` (строкой).
fn string_or(value: Option<&Value>, fallback: &str) -> String {
    match value.filter(|value| !value.is_null()) {
        Some(value) => js::string(Some(value)),
        None => fallback.to_string(),
    }
}

/// `new Set(state.partyMemberIds?.length ? state.partyMemberIds.map(String) : state.players.map(actorId))`.
pub fn party_member_ids(state: &Value) -> IndexSet<String> {
    let members = state.get("partyMemberIds").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    if !members.is_empty() {
        return members.iter().map(|id| js::string(Some(id))).collect();
    }
    state.get("players").and_then(Value::as_array).into_iter().flatten().map(game::actor_id).collect()
}

/// `sortedInitiative(entries)` (12202): выше итог, затем модификатор, затем
/// id (`localeCompare`). Разность в JS — `NaN || …` уходит к следующему
/// ключу, поэтому сравнитель — V8 TimSort шаг в шаг.
pub fn sorted_initiative(entries: &[Value]) -> Vec<Value> {
    let mut order: Vec<usize> = (0..entries.len()).collect();
    let number = |entry: &Value, key: &str| js::number(entry.get(key));
    sk_core::v8sort::sort_by(&mut order, |left, right| {
        let (left, right) = (&entries[*left], &entries[*right]);
        let total = number(right, "total") - number(left, "total");
        if total != 0.0 && !total.is_nan() {
            return total;
        }
        let modifier = number(right, "modifier") - number(left, "modifier");
        if modifier != 0.0 && !modifier.is_nan() {
            return modifier;
        }
        match text::locale_compare(&js::string(left.get("actor_id")), &js::string(right.get("actor_id"))) {
            std::cmp::Ordering::Less => -1.0,
            std::cmp::Ordering::Equal => 0.0,
            std::cmp::Ordering::Greater => 1.0,
        }
    });
    order.into_iter().map(|index| entries[index].clone()).collect()
}

/// Предмет склянки: `{ id, name, catalog_id }` у противника или вещь героя.
pub struct FlaskItem<'a> {
    pub item: &'a Value,
    /// `purposeSubject`: подпись броска снаружи (`null` — каталог или id).
    pub purpose_subject: Option<String>,
}

/// `thrownFlaskEvents(state, command, { actor, item, use, … })` (8692–8791):
/// метательная склянка — спасбросок Ловкости вместо броска атаки.
pub fn thrown_flask_events(r: &mut Resolve<'_>, state: &Value, command: &Value, actor: Option<&Value>, flask: FlaskItem<'_>, profile: &Value) -> Result<Vec<Value>, Halt> {
    let item = flask.item;
    let target_id = js::s(command.get("target_id"));
    let Some(target) = game::find_actor(state, &target_id).cloned() else {
        return Err(rule("Цель броска не найдена", "TARGET_NOT_FOUND"));
    };
    let mut events = Vec::new();
    let purpose_of = match flask.purpose_subject {
        Some(subject) => subject,
        None => js::string(crate::core::coalesce(&[item.get("catalog_id"), item.get("id")])),
    };
    let save = profile.get("save");
    let save_ability = string_or(at(save, "ability"), "dex");
    let dc = at(save, "dc");
    let dc_ability = string_or(at(dc, "ability"), "dex");
    let proficiency_bonus = if js::is_true(at(dc, "proficiency")) { js::safe_int(at(actor, "proficiency"), 0).max(0) } else { 0 };
    let save_dc = (js::safe_int(at(dc, "base"), 8) + ability_modifier(at_path(actor, &["abilities", &dc_ability])) + proficiency_bonus).max(1);
    let save_ability_value = Value::String(save_ability.clone());
    let target_proficient = is_saving_throw_proficient(Some(&target), Some(&save_ability_value));
    let actor_id = js::s(command.get("actor_id"));
    let cover = if save_ability == "dex" {
        let from = crate::tactical_geometry::actor_point(state, &actor_id);
        let to = crate::tactical_geometry::actor_point(state, &target_id);
        crate::tactical_geometry::cover_between(state, &actor_id, &target_id, from, to)
    } else {
        json!({ "armorClassBonus": 0, "level": "none", "blockers": [] })
    };
    let save_modifier = ability_modifier(at_path(Some(&target), &["abilities", &save_ability])) as f64 + js::number(cover.get("armorClassBonus"));
    let mut options = Map::new();
    options.insert("ability".into(), save_ability_value.clone());
    options.insert("modifier".into(), js::num(save_modifier));
    options.insert("purpose".into(), Value::String(format!("item_thrown_save:{purpose_of}:{save_ability}")));
    options.insert("visibility".into(), undef(command.get("visibility")));
    let target_value = Value::String(target_id.clone());
    let save_roll = r.roll_saving_throw(state, Some(&target_value), &Value::Object(options))?;
    r.rolls.push(save_roll.clone());
    let saved = saving_throw_succeeded(Some(&save_roll), save_dc as f64);
    let mut payload = spread_value(Some(&save_roll));
    payload.insert("ability".into(), save_ability_value.clone());
    payload.insert("difficulty".into(), json!(save_dc));
    payload.insert("success".into(), json!(saved));
    payload.insert("saved".into(), json!(saved));
    payload.insert("source".into(), json!("item-thrown"));
    insert_present(&mut payload, "item_id", item.get("id"));
    insert_present(&mut payload, "item_name", item.get("name"));
    payload.insert("proficient".into(), json!(target_proficient));
    insert_present(&mut payload, "cover", cover.get("level"));
    let targets = json!([target_id]);
    events.push(event_from(&command_with_rules(command, &[rule_ids::SAVING_THROW]), "SavingThrowResolved", Some(Value::Object(payload)), Some(&targets)));
    if saved {
        return Ok(events);
    }
    let allowed: Vec<String> = unique_strings(profile.get("damage_creature_types")).into_iter().map(|value| value.to_lowercase()).collect();
    let creature_type = js::s(crate::core::coalesce(&[target.get("creature_type"), target.get("creatureType")])).to_lowercase();
    if !allowed.is_empty() && !allowed.contains(&creature_type) {
        let mut payload = Map::new();
        insert_present(&mut payload, "item_id", item.get("id"));
        insert_present(&mut payload, "item_name", item.get("name"));
        payload.insert("reason".into(), json!("creature-type"));
        payload.insert("damage_type".into(), or_null(profile.get("damage_type").filter(|value| !value.is_null())));
        payload.insert("applicable_creature_types".into(), json!(allowed));
        events.push(event_from(command, "ItemEffectIneffective", Some(Value::Object(payload)), Some(&targets)));
        return Ok(events);
    }
    if js::truthy(profile.get("damage")) {
        let visibility = crate::core::coalesce(&[command.get("visibility")]).cloned().unwrap_or_else(|| json!("public"));
        let damage_roll = r.roll_dice(Value::String(js::string(profile.get("damage"))), &format!("item_thrown_damage:{purpose_of}"), command.get("actor_id").cloned().unwrap_or(Value::Null), visibility)?;
        r.rolls.push(damage_roll.clone());
        let mut rolled = spread_value(Some(&damage_roll));
        insert_present(&mut rolled, "item_id", item.get("id"));
        insert_present(&mut rolled, "damage_type", profile.get("damage_type"));
        events.push(event_from(command, "DieRolled", Some(Value::Object(rolled)), Some(&json!([]))));
        let damage_type = Value::String(string_or(profile.get("damage_type"), "acid"));
        let resolved = r.resolve_damage_payload(state, &target_id, damage_roll.get("total").cloned().unwrap_or(Value::Null), &damage_type, None, None)?;
        let mut applied = spread_value(Some(&resolved));
        insert_present(&mut applied, "item_id", item.get("id"));
        insert_present(&mut applied, "item_name", item.get("name"));
        applied.insert("saved".into(), json!(false));
        applied.insert("save_dc".into(), json!(save_dc));
        insert_present(&mut applied, "save_total", save_roll.get("total"));
        events.push(event_from(&command_with_rules(command, &[rule_ids::DAMAGE]), "DamageApplied", Some(Value::Object(applied)), Some(&targets)));
        events.extend(zero_hit_point_damage_consequences(state, command, &target_id, &resolved, false));
    }
    if let Some(condition) = profile.get("on_failed_save_condition").filter(|value| js::truthy(Some(value))) {
        let mut payload = Map::new();
        payload.insert("condition".into(), Value::String(js::string(condition.get("id"))));
        payload.insert("duration".into(), or_null(condition.get("duration").filter(|value| !value.is_null())));
        insert_present(&mut payload, "source_actor", command.get("actor_id"));
        insert_present(&mut payload, "item_id", item.get("id"));
        insert_present(&mut payload, "item_name", item.get("name"));
        if js::truthy(condition.get("recurring_damage")) {
            payload.insert("recurring_damage".into(), Value::String(js::string(condition.get("recurring_damage"))));
            payload.insert("recurring_damage_type".into(), Value::String(string_or(condition.get("recurring_damage_type"), "fire")));
        }
        if js::truthy(condition.get("fire_damage_bonus")) {
            payload.insert("fire_damage_bonus".into(), json!(js::safe_int(condition.get("fire_damage_bonus"), 0)));
        }
        events.push(event_from(&command_with_rules(command, &[rule_ids::CONDITIONS]), "ConditionAdded", Some(Value::Object(payload)), Some(&targets)));
    }
    Ok(events)
}

/// `npcItemUseEvents(state, command, …)` (8815–8910): противник пускает в
/// ход свою вещь — `NpcItemUsed`, действие вещи и `NpcEquipmentSpent`.
pub fn npc_item_use_events(r: &mut Resolve<'_>, state: &Value, command: &Value) -> Result<Vec<Value>, Halt> {
    let owner_id = js::string(command.get("actor_id"));
    let enemy = game::find_actor(state, &owner_id).cloned();
    let npc_item = command.get("npc_item").cloned().unwrap_or(Value::Null);
    let profile = command.get("use_profile").cloned().unwrap_or(Value::Null);
    let target_id = js::string(command.get("target_id"));
    let item_field = |key: &str| npc_item.get(key);
    let mut payload = Map::new();
    payload.insert("schema_version".into(), json!(sk_economy::npc_equipment::NPC_EQUIPMENT_EVENT_SCHEMA_VERSION));
    payload.insert("policy_id".into(), json!(sk_economy::npc_equipment::NPC_EQUIPMENT_POLICY_ID));
    payload.insert("owner_id".into(), json!(owner_id));
    for key in ["tactic", "label", "item_instance_id", "catalog_id", "item_name"] {
        insert_present(&mut payload, key, item_field(key));
    }
    payload.insert("target_id".into(), json!(target_id));
    payload.insert("combat_action".into(), or_null(profile.get("combat_action").filter(|value| !value.is_null())));
    payload.insert("request_fingerprint".into(), or_null(command.get("request_fingerprint").filter(|value| !value.is_null())));
    let mut events = vec![event_from(command, "NpcItemUsed", Some(Value::Object(payload)), Some(&json!([target_id])))];
    let tactic = item_field("tactic").and_then(Value::as_str).map(str::to_string);
    let tactic_text = js::string(item_field("tactic"));
    if tactic.as_deref() == Some("heal") {
        let roll = r.roll_dice(Value::String(js::string(profile.get("expression"))), &format!("npc-item:{tactic_text}:healing"), json!(owner_id), json!("gm_only"))?;
        r.rolls.push(roll.clone());
        events.push(event_from(&command_with(command, "visibility", json!("gm_only")), "DieRolled", Some(roll.clone()), Some(&json!([]))));
        let before = enemy.as_ref().map_or(0, game::actor_hp);
        let healed = js::safe_int(roll.get("total"), 0).max(0);
        let after = actor_max_hp(enemy.as_ref()).min(before + healed);
        let mut payload = Map::new();
        payload.insert("requested_amount".into(), json!(healed));
        payload.insert("applied_amount".into(), json!(after - before));
        payload.insert("hp_before".into(), json!(before));
        payload.insert("hp_after".into(), json!(after));
        insert_present(&mut payload, "item_id", item_field("item_instance_id"));
        insert_present(&mut payload, "item_name", item_field("item_name"));
        events.push(event_from(&command_with_rules(command, &[rule_ids::HEALING]), "HealingApplied", Some(Value::Object(payload)), Some(&json!([owner_id]))));
    }
    if tactic.as_deref() == Some("flask") {
        let mut item = Map::new();
        insert_present(&mut item, "id", item_field("item_instance_id"));
        insert_present(&mut item, "name", item_field("item_name"));
        insert_present(&mut item, "catalog_id", item_field("catalog_id"));
        let item = Value::Object(item);
        let flask = FlaskItem { item: &item, purpose_subject: Some(format!("npc-item:{tactic_text}")) };
        events.extend(thrown_flask_events(r, state, command, enemy.as_ref(), flask, &profile)?);
    }
    if tactic.as_deref() == Some("coat") {
        let weapon = js::string(at(command.get("npc_weapon"), "item_instance_id"));
        let payload = json!({
            "condition": format!("weapon-coated:{weapon}"),
            "duration": string_or(profile.get("duration"), "rounds:10"),
            "source_actor": owner_id,
            "rider_damage": js::string(profile.get("rider_damage")),
            "rider_damage_type": string_or(profile.get("rider_damage_type"), "poison"),
            "rider_source_name": js::string(item_field("item_name")),
        });
        events.push(event_from(&command_with_rules(command, &[rule_ids::CONDITIONS]), "ConditionAdded", Some(payload), Some(&json!([owner_id]))));
    }
    if js::truthy(item_field("once_per_combat")) {
        let payload = json!({ "condition": sk_economy::npc_equipment::npc_tactic_condition(item_field("tactic")), "source_actor": owner_id });
        events.push(event_from(&command_with_rules(command, &[rule_ids::CONDITIONS]), "ConditionAdded", Some(payload), Some(&json!([owner_id]))));
    }
    let consumed = js::safe_int(profile.get("consumes"), 1).max(1);
    let quantity_before = item_field("quantity_before").cloned();
    // `Math.max(0, quantity_before - consumed)`: NaN остаётся NaN, как в JS.
    let quantity_after = js::num(js::max_of([0.0, js::number(quantity_before.as_ref()) - consumed as f64]));
    let mut spent = Map::new();
    spent.insert("action_id".into(), Value::Null);
    for key in ["item_instance_id", "catalog_id", "item_name"] {
        insert_present(&mut spent, key, item_field(key));
    }
    spent.insert("reason".into(), json!("item-use"));
    insert_present(&mut spent, "quantity_before", quantity_before.as_ref());
    spent.insert("quantity_after".into(), quantity_after.clone());
    insert_present(&mut spent, "shots_before", quantity_before.as_ref());
    spent.insert("shots_after".into(), quantity_after);
    events.push(crate::combat::npc_items::npc_equipment_spent_event(command, &Value::Object(spent)));
    Ok(events)
}

/// `spilledZoneEvents(state, command, { item, use })` (8923–8973):
/// калтропы и лужа масла — обычный площадный эффект в клетке игрока.
pub fn spilled_zone_events(state: &Value, command: &Value, item: &Value, profile: &Value) -> Result<Vec<Value>, Halt> {
    let spill = if command.get("use_mode").and_then(Value::as_str) == Some("spill") { profile.get("spill_mode") } else { Some(profile) };
    let Some(zone) = at(spill, "zone").filter(|zone| js::truthy(Some(zone))) else {
        return Err(rule("У предмета нет серверного профиля рассыпания", "ITEM_SPILL_NOT_AVAILABLE"));
    };
    let actor_id = js::s(command.get("actor_id"));
    let from = game::actor_position(state, &actor_id);
    let to_x = js::number(at(command.get("to"), "x")).floor();
    let to_y = js::number(at(command.get("to"), "y")).floor();
    let Some(from) = from else {
        return Err(rule("Герой должен находиться на карте", "MAP_POSITION_REQUIRED"));
    };
    if !to_x.is_finite() || !to_y.is_finite() {
        return Err(rule("Нужна клетка", "INVALID_DESTINATION"));
    }
    let cells = crate::tactical_geometry::tactical_cell_map(state);
    let cell = cells.get(&crate::tactical_geometry::key(to_x, to_y));
    let blocked = match cell {
        None => true,
        Some(cell) => cell.get("revealed") == Some(&Value::Bool(false)) || cell.get("type").and_then(Value::as_str) == Some("wall"),
    };
    if blocked {
        return Err(rule("В эту клетку нельзя высыпать предмет", "INVALID_DESTINATION"));
    }
    let range_raw = crate::core::coalesce(&[at(spill, "range_feet"), profile.get("range_feet")]);
    let range_feet = js::safe_int(range_raw, 5).max(5) as f64;
    let to = json!({ "x": js::num(to_x), "y": js::num(to_y) });
    let anchor = json!({ "x": from.x, "y": from.y });
    let distance = sk_geometry::actor_footprint::footprint_distance_feet(game::find_actor(state, &actor_id), Some(&json!([to])), Some(&anchor), None).unwrap_or(f64::INFINITY);
    if distance > range_feet {
        return Err(rule("Клетка находится слишком далеко", "ITEM_TARGET_OUT_OF_RANGE"));
    }
    let zone_id = js::string(zone.get("id"));
    let identifier = format!("item-zone:{zone_id}:{}", slice_utf16(&js::string(command.get("command_id")), 140));
    let null_or = |key: &str| or_null(zone.get(key).filter(|value| !value.is_null()));
    let mut effect = Map::new();
    effect.insert("id".into(), json!(identifier));
    effect.insert("effect_id".into(), json!(identifier));
    effect.insert("spell_id".into(), Value::String(format!("item:{zone_id}")));
    effect.insert("source_actor".into(), Value::String(js::string(command.get("actor_id"))));
    effect.insert("center".into(), to.clone());
    effect.insert("cells".into(), json!([to]));
    effect.insert("area_shape".into(), json!("line"));
    effect.insert("radius_feet".into(), json!(5));
    effect.insert("difficult_terrain".into(), json!(false));
    effect.insert("trigger_on_enter".into(), json!(true));
    effect.insert("trigger_on_turn_end".into(), json!(js::present(zone.get("damage_amount")) || js::present(zone.get("damage"))));
    effect.insert("save_ability".into(), null_or("save_ability"));
    effect.insert("save_dc".into(), json!(js::safe_int(zone.get("save_dc"), 10)));
    effect.insert("condition".into(), null_or("condition"));
    effect.insert("damage".into(), null_or("damage"));
    effect.insert("damage_amount".into(), json!(js::safe_int(zone.get("damage_amount"), 0)));
    effect.insert("damage_type".into(), null_or("damage_type"));
    effect.insert("half_on_save".into(), json!(false));
    effect.insert("follows_source".into(), json!(false));
    effect.insert("concentration".into(), json!(false));
    effect.insert("item_id".into(), Value::String(js::string(item.get("id"))));
    effect.insert("item_name".into(), Value::String(js::string(item.get("name"))));
    if js::is_true(zone.get("flammable")) {
        let burning_type = string_or(zone.get("burning_damage_type"), "fire");
        effect.insert("flammable".into(), json!({ "damage": null, "damageType": burning_type }));
        effect.insert(
            "ignites_into".into(),
            json!({
                "damage_amount": js::safe_int(zone.get("burning_damage_amount"), 5),
                "damage_type": burning_type,
                "rounds": js::safe_int(zone.get("burning_rounds"), 2).max(1),
            }),
        );
    }
    let round = js::safe_int(game::combat(state).get("round"), 1);
    effect.insert("expires_round".into(), json!(round + js::safe_int(zone.get("rounds"), 10).max(1)));
    let source = command_with_rules(command, &[rule_ids::CONDITIONS]);
    Ok(vec![event_from(&source, "SpellAreaCreated", Some(json!({ "effect": Value::Object(effect) })), Some(&json!([])))])
}

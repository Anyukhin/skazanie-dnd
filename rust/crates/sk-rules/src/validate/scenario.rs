//! Блоки `validateCommand`: Сценарий: кошель, осведомитель, диалог, оружейная, договор, рыцарь, незнакомец. Задача Р6.
//!
//! JS: `server/rules-engine.mjs`, 6488–6501, 6502–6524, 6525–6548, 6549–6571, 6572–6601, 6602–6641, 6642–6662. Порядок блоков задаёт
//! `validate/mod.rs` (Р0); здесь — только тела.
//!
//! Данные сценария читают модули `campaign-scenario` (`sk-scenario`),
//! `scenario-attention` (`sk-attention`), `scenario-knight` (`sk-world-story`)
//! и `campaign-dialogues` (`sk-story`); блок решает только допустимость и
//! дописывает в команду то, что ветка разбора возьмёт как есть (навык и СЛ,
//! вещь, профиль незнакомца).

use serde_json::{json, Value};
use sk_core::js;
use sk_economy::merchant_economy::{normalize_inventory_item, InventoryItemOptions};

use super::Validation;
use crate::command::types::{
    DIALOGUE_COMMAND_TYPE, SCENARIO_ARMORY_COMMAND_TYPES, SCENARIO_COMMAND_TYPES, SCENARIO_INFORMANT_COMMAND_TYPES, SCENARIO_KNIGHT_COMMAND_TYPES, SCENARIO_PURSE_COMMAND_TYPES, SCENARIO_TREATY_COMMAND_TYPES,
};
use crate::core::{actor_max_hp, player_actor, same_campaign_party};
use crate::pause::{rule, Step};

fn command_type(v: &Validation<'_>) -> String {
    js::s(v.command.get("command_type"))
}

/// `command.key = value`.
fn set_field(command: &mut Value, key: &str, value: Value) {
    if let Some(map) = command.as_object_mut() {
        map.insert(key.into(), value);
    }
}

/// `a?.b?.c` по пути.
fn at<'a>(value: Option<&'a Value>, path: &[&str]) -> Option<&'a Value> {
    let mut current = value?;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

/// `(list ?? []).map(String)`: не массив — пусто.
fn string_list(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items.iter().map(|item| js::string(Some(item))).collect(),
        _ => Vec::new(),
    }
}

/// `(list ?? []).includes(value)` строгим равенством.
fn includes(list: Option<&Value>, value: Option<&Value>) -> bool {
    let wanted = value.unwrap_or(&Value::Null);
    list.and_then(Value::as_array).is_some_and(|items| items.iter().any(|item| item == wanted))
}

/// Герой отряда из команды (`playerActor` и `sameCampaignParty`).
fn party_hero<'a>(v: &Validation<'a>) -> Option<&'a Value> {
    let hero = player_actor(v.state, v.command.get("actor_id"))?;
    same_campaign_party(v.state, &js::string(v.command.get("actor_id"))).then_some(hero)
}

fn actor_key(v: &Validation<'_>) -> String {
    js::string(v.command.get("actor_id"))
}

/// Блок 18 (6488–6501): кошель короля.
pub fn check_scenario_purse(v: &mut Validation<'_>) -> Step {
    if !SCENARIO_PURSE_COMMAND_TYPES.contains(&command_type(v).as_str()) {
        return Ok(());
    }
    let Some(rules) = sk_scenario::campaign_scenario::scenario_purse_rules(v.state) else {
        return Err(rule("В этой кампании кошеля от короля нет", "SCENARIO_PURSE_ABSENT"));
    };
    if party_hero(v).is_none() {
        return Err(rule("Кошель получает герой отряда", "ACTOR_FORBIDDEN"));
    }
    if sk_core::game::combat_active(v.state) {
        return Err(rule("Посреди боя кошелей не раздают", "SCENARIO_PURSE_DURING_COMBAT"));
    }
    if Some(sk_scenario::campaign_scenario::scenario_location_id(v.state).as_str()) != rules.get("location_id").and_then(Value::as_str) {
        return Err(rule("Кошель выдают в королевской казне, при дворе", "SCENARIO_PURSE_WRONG_PLACE"));
    }
    if string_list(at(v.state.get("scenario_attention"), &["purse_paid"])).contains(&actor_key(v)) {
        return Err(rule("Этот герой уже получил кошель короля", "SCENARIO_PURSE_ALREADY_PAID"));
    }
    set_field(&mut v.command, "visibility", json!("party"));
    Ok(())
}

/// Блок 19 (6502–6524): осведомитель.
pub fn check_scenario_informant(v: &mut Validation<'_>) -> Step {
    if !SCENARIO_INFORMANT_COMMAND_TYPES.contains(&command_type(v).as_str()) {
        return Ok(());
    }
    let wanted = v.command.get("informant_id").cloned().unwrap_or(Value::Null);
    let Some(informant) = sk_scenario::campaign_scenario::scenario_informant_rules(v.state).into_iter().find(|entry| entry.get("id") == Some(&wanted)) else {
        return Err(rule("Такого осведомителя в кампании нет", "SCENARIO_INFORMANT_UNKNOWN"));
    };
    let Some(hero) = party_hero(v) else { return Err(rule("Решает герой отряда", "ACTOR_FORBIDDEN")) };
    if !sk_core::game::is_living_actor(hero) {
        return Err(rule("Герой без сознания ничего не решает", "ACTOR_DEFEATED"));
    }
    let choice = v.command.get("choice").and_then(Value::as_str).unwrap_or_default().to_string();
    if !sk_attention::scenario_attention::SCENARIO_INFORMANT_CHOICES.contains(&choice.as_str()) || !v.command.get("choice").is_some_and(Value::is_string) {
        return Err(rule("Осведомителя можно выдать страже, отпустить или перевербовать", "SCENARIO_INFORMANT_CHOICE_INVALID"));
    }
    let name = js::s(informant.get("name"));
    if !js::truthy(informant.get("revealed")) {
        return Err(rule(format!("Кто здесь доносит дракону, отряд ещё не знает: {name} не раскрыт"), "SCENARIO_INFORMANT_HIDDEN"));
    }
    if sk_core::game::combat_active(v.state) {
        return Err(rule("Посреди боя не до осведомителей", "SCENARIO_INFORMANT_DURING_COMBAT"));
    }
    if Some(sk_scenario::campaign_scenario::scenario_location_id(v.state).as_str()) != informant.get("location_id").and_then(Value::as_str) {
        return Err(rule(format!("{name} — не здесь"), "SCENARIO_INFORMANT_WRONG_PLACE"));
    }
    let id = js::s(informant.get("id"));
    if js::truthy(at(v.state.get("scenario_attention"), &["informants", &id])) {
        return Err(rule(format!("Судьба осведомителя уже решена: {name}"), "SCENARIO_INFORMANT_RESOLVED"));
    }
    if choice == "turn" && includes(at(v.state.get("scenario_attention"), &["informant_turn_failed"]), informant.get("id")) {
        return Err(rule("Перевербовать его уже не вышло: остаётся выдать или отпустить", "SCENARIO_INFORMANT_TURN_SPENT"));
    }
    if choice == "turn" {
        set_field(&mut v.command, "skill", at(Some(&informant), &["turn", "skill"]).cloned().unwrap_or(Value::Null));
        set_field(&mut v.command, "difficulty", at(Some(&informant), &["turn", "dc"]).cloned().unwrap_or(Value::Null));
    }
    set_field(&mut v.command, "visibility", json!("public"));
    Ok(())
}

/// `String(value ?? '').trim().toLocaleLowerCase('ru')`.
fn place(value: Option<&Value>) -> String {
    sk_core::text::lower(sk_core::text::trim(&js::s(value)))
}

/// Блок 20 (6525–6548): авторский диалог.
pub fn check_dialogue(v: &mut Validation<'_>) -> Step {
    if command_type(v) != DIALOGUE_COMMAND_TYPE {
        return Ok(());
    }
    let Some(dialogue) = sk_story::campaign_dialogues::dialogue_for(v.state, v.command.get("npc_id")) else {
        return Err(rule("С этим собеседником нет разговора с вариантами", "DIALOGUE_ABSENT"));
    };
    let Some(hero) = party_hero(v) else { return Err(rule("Говорит герой отряда", "ACTOR_FORBIDDEN")) };
    if !sk_core::game::is_living_actor(hero) {
        return Err(rule("Герой без сознания не разговаривает", "ACTOR_DEFEATED"));
    }
    if sk_core::game::combat_active(v.state) {
        return Err(rule("Посреди боя не до разговоров", "DIALOGUE_DURING_COMBAT"));
    }
    let npc_id = v.command.get("npc_id").and_then(Value::as_str);
    let npcs = at(v.state.get("social"), &["npcs"]).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let npc = npcs.iter().find(|entry| npc_id == Some(js::string(entry.get("id")).as_str()));
    let absent = match npc {
        None => true,
        Some(npc) => {
            let id = js::string(npc.get("id"));
            js::is_false(npc.get("available"))
                || js::is_false(at(v.state.get("npc_world"), &["vitals", &id, "alive"]))
                || place(npc.get("location")) != place(at(v.state.get("scene"), &["location"]))
        }
    };
    let Some(npc) = npc.filter(|_| !absent) else {
        return Err(rule("Собеседника здесь нет", "DIALOGUE_NPC_ABSENT"));
    };
    let option_id = v.command.get("option_id").and_then(Value::as_str);
    let option = dialogue.options.iter().find(|entry| Some(entry.id.as_str()) == option_id);
    let offered = sk_story::campaign_dialogues::dialogue_options_for(v.state, v.command.get("npc_id"), v.command.get("actor_id"));
    let offered = offered.as_ref().and_then(|value| value.get("options")).and_then(Value::as_array).cloned().unwrap_or_default();
    let Some(option) = option.filter(|option| offered.iter().any(|entry| entry.get("id").and_then(Value::as_str) == Some(option.id.as_str()))) else {
        return Err(rule("Этот вариант разговора сейчас недоступен", "DIALOGUE_OPTION_UNAVAILABLE"));
    };
    let mut chosen = serde_json::Map::new();
    chosen.insert("dialogue_id".into(), Value::String(dialogue.id.clone()));
    chosen.insert("npc_name".into(), Value::String(js::s(npc.get("name"))));
    for (key, value) in crate::core::spread_value(Some(&option.to_json())) {
        chosen.insert(key, value);
    }
    set_field(&mut v.command, "dialogue_option", Value::Object(chosen));
    set_field(&mut v.command, "visibility", json!("party"));
    Ok(())
}

/// `normalizeInventoryItem(item, { idFallback, preserveUnknown: true })` с `origin: 'gifted'`.
fn gifted_item(item: &Value, id_fallback: &str) -> Value {
    let mut normalized = normalize_inventory_item(Some(item), InventoryItemOptions { id_fallback, preserve_unknown: true, hydrate_catalog: false });
    if let Some(map) = normalized.as_object_mut() {
        map.insert("origin".into(), json!("gifted"));
    }
    normalized
}

/// Блок 21 (6549–6571): оружейная.
pub fn check_scenario_armory(v: &mut Validation<'_>) -> Step {
    if !SCENARIO_ARMORY_COMMAND_TYPES.contains(&command_type(v).as_str()) {
        return Ok(());
    }
    let Some(rules) = sk_scenario::campaign_scenario::scenario_armory_rules(v.state) else {
        return Err(rule("В этой кампании королевской оружейной нет", "SCENARIO_ARMORY_ABSENT"));
    };
    if party_hero(v).is_none() {
        return Err(rule("Вещь из оружейной получает герой отряда", "ACTOR_FORBIDDEN"));
    }
    if sk_core::game::combat_active(v.state) {
        return Err(rule("Посреди боя оружейная закрыта", "SCENARIO_ARMORY_DURING_COMBAT"));
    }
    if Some(sk_scenario::campaign_scenario::scenario_location_id(v.state).as_str()) != rules.get("location_id").and_then(Value::as_str) {
        return Err(rule("Королевская оружейная — при дворе, в Штормберге", "SCENARIO_ARMORY_WRONG_PLACE"));
    }
    if string_list(at(v.state.get("scenario_attention"), &["armory_taken"])).contains(&actor_key(v)) {
        return Err(rule("Этот герой уже выбрал вещь в оружейной", "SCENARIO_ARMORY_ALREADY_TAKEN"));
    }
    if !includes(rules.get("catalog_ids"), v.command.get("catalog_id")) {
        let names: Vec<String> = rules
            .get("catalog_ids")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[])
            .iter()
            .filter_map(|id| sk_items::item_catalog::catalog_item(&js::s(Some(id))).and_then(|item| item.get("name")).filter(|name| js::truthy(Some(name))).map(|name| js::s(Some(name))))
            .collect();
        return Err(rule(format!("Назовите вещь из оружейной: {}", names.join(", ")), "SCENARIO_ARMORY_ITEM_UNKNOWN"));
    }
    let catalog_id = js::s(v.command.get("catalog_id"));
    let item = sk_items::item_catalog::materialize_catalog_item(&catalog_id, Some(&json!({ "quantity": 1, "origin": "gifted" })));
    let fallback = format!("armory:{}", js::string(v.command.get("command_id")));
    set_field(&mut v.command, "armory_item", gifted_item(&item, &fallback));
    set_field(&mut v.command, "visibility", json!("party"));
    Ok(())
}

/// Блок 22 (6572–6601): договор.
pub fn check_scenario_treaty(v: &mut Validation<'_>) -> Step {
    if !SCENARIO_TREATY_COMMAND_TYPES.contains(&command_type(v).as_str()) {
        return Ok(());
    }
    let Some(rules) = sk_scenario::campaign_scenario::scenario_treaty_rules(v.state) else {
        return Err(rule("В этой кампании договор с противником не предусмотрен", "SCENARIO_TREATY_ABSENT"));
    };
    if js::truthy(rules.get("concluded")) {
        return Err(rule("Договор уже заключён", "SCENARIO_TREATY_CONCLUDED"));
    }
    let Some(hero) = party_hero(v) else { return Err(rule("Договаривается только герой отряда", "ACTOR_FORBIDDEN")) };
    if !sk_core::game::is_living_actor(hero) {
        return Err(rule("Герой без сознания не ведёт переговоров", "ACTOR_DEFEATED"));
    }
    if Some(sk_scenario::campaign_scenario::scenario_location_id(v.state).as_str()) != rules.get("boss_location_id").and_then(Value::as_str) {
        return Err(rule("Договориться можно только с самим драконом, в его логове", "SCENARIO_TREATY_WRONG_PLACE"));
    }
    if !js::truthy(rules.get("truth_revealed")) {
        return Err(rule("Саргат не станет слушать, пока правда о походе на Вулканиса не раскрыта", "SCENARIO_TREATY_TRUTH_MISSING"));
    }
    let boss_id = js::s(rules.get("boss_npc_id"));
    if js::is_false(at(v.state.get("npc_world"), &["vitals", &boss_id, "alive"])) {
        return Err(rule("Договариваться больше не с кем", "SCENARIO_TREATY_BOSS_GONE"));
    }
    if string_list(at(v.state.get("scenario_attention"), &["treaty", "attempts"])).contains(&actor_key(v)) {
        return Err(rule("Этого героя дракон уже выслушал и не поверил", "SCENARIO_TREATY_ATTEMPT_SPENT"));
    }
    if sk_core::game::combat_active(v.state) {
        let Some(boss) = sk_core::game::find_actor(v.state, &boss_id).filter(|boss| sk_core::game::is_living_actor(boss)) else {
            return Err(rule("Договариваться больше не с кем", "SCENARIO_TREATY_BOSS_GONE"));
        };
        let ratio = sk_core::game::actor_hp(boss) as f64 / (actor_max_hp(Some(boss)).max(1) as f64);
        if ratio > js::number(rules.get("wounded_ratio")) {
            return Err(rule("Пока дракон не ранен всерьёз, он не станет торговаться", "SCENARIO_TREATY_BOSS_UNHURT"));
        }
    }
    set_field(&mut v.command, "skill", rules.get("skill").cloned().unwrap_or(Value::Null));
    set_field(&mut v.command, "difficulty", rules.get("dc").cloned().unwrap_or(Value::Null));
    set_field(&mut v.command, "visibility", json!("public"));
    Ok(())
}

/// Блок 23 (6602–6641): проклятый рыцарь.
pub fn check_scenario_knight(v: &mut Validation<'_>) -> Step {
    let kind = command_type(v);
    if !SCENARIO_KNIGHT_COMMAND_TYPES.contains(&kind.as_str()) {
        return Ok(());
    }
    let rules = sk_world_story::scenario_knight::scenario_knight_rules(v.state);
    let knight = sk_world_story::scenario_knight::scenario_knight_state(v.state);
    let (Some(rules), Some(knight)) = (rules, knight) else {
        return Err(rule("В этой кампании нет проклятого рыцаря", "SCENARIO_KNIGHT_ABSENT"));
    };
    let Some(hero) = party_hero(v) else { return Err(rule("Действует только герой отряда", "ACTOR_FORBIDDEN")) };
    if !sk_core::game::is_living_actor(hero) {
        return Err(rule("Герой без сознания ничего не делает", "ACTOR_DEFEATED"));
    }
    if js::truthy(knight.get("released")) {
        return Err(rule("Рыцарь уже обрёл покой", "SCENARIO_KNIGHT_RELEASED"));
    }
    if !sk_world_story::scenario_knight::scenario_knight_present(v.state) {
        return Err(rule("Рыцаря сейчас здесь нет: он приходит в полночь", "SCENARIO_KNIGHT_NOT_PRESENT"));
    }
    let npc_id = js::s(rules.get("npc_id"));
    if kind == "ReturnKnightHead" {
        if js::truthy(knight.get("head_returned")) {
            return Err(rule("Голова уже перед рыцарем", "SCENARIO_KNIGHT_HEAD_RETURNED"));
        }
        if !sk_world_story::scenario_knight::scenario_knight_riddle_solved(v.state) {
            return Err(rule("Где его голова, отряд ещё не знает: загадка замка не разгадана", "SCENARIO_KNIGHT_RIDDLE_UNSOLVED"));
        }
        let reach = js::number(rules.get("head_reach_feet"));
        let distance = crate::targets::knight_distance_feet(v.state, &js::s(v.command.get("actor_id")), &npc_id);
        if distance.is_none_or(|distance| distance > reach) {
            return Err(rule(format!("Голову ставят перед рыцарем: подойдите на {} футов", js::s(rules.get("head_reach_feet"))), "TARGET_OUT_OF_RANGE"));
        }
    } else {
        if sk_core::game::combat_active(v.state) {
            return Err(rule("Упокоить рыцаря можно только без боя", "SCENARIO_KNIGHT_DURING_COMBAT"));
        }
        if !js::truthy(knight.get("head_returned")) {
            return Err(rule("Сначала верните рыцарю его голову", "SCENARIO_KNIGHT_HEAD_MISSING"));
        }
        let skills = at(Some(&rules), &["release", "skills"]);
        if !includes(skills, v.command.get("skill")) {
            let first = skills.and_then(Value::as_array).and_then(|skills| skills.first()).cloned();
            match first {
                Some(skill) => set_field(&mut v.command, "skill", skill),
                None => {
                    if let Some(map) = v.command.as_object_mut() {
                        // `command.skill = skills[0]` у пустого списка — `undefined`.
                        map.shift_remove("skill");
                    }
                }
            }
        }
        let night = js::f64_string(sk_world_story::scenario_knight::scenario_night_index(v.state));
        let attempt = format!("{}:{night}", actor_key(v));
        if knight.get("attempts").and_then(Value::as_array).is_some_and(|attempts| attempts.iter().any(|entry| entry.as_str() == Some(attempt.as_str()))) {
            return Err(rule("Этой ночью рыцарь уже выслушал этого героя", "SCENARIO_KNIGHT_ATTEMPT_SPENT"));
        }
        set_field(&mut v.command, "difficulty", at(Some(&rules), &["release", "dc"]).cloned().unwrap_or(Value::Null));
        let reward_id = js::s(at(Some(&rules), &["release", "reward", "catalog_id"]));
        let carried = at(v.state.get("npc_world"), &["inventories", &npc_id])
            .and_then(Value::as_array)
            .and_then(|items| items.iter().find(|item| js::s(item.get("catalog_id")) == reward_id))
            .cloned();
        let source = match &carried {
            Some(item) => item.clone(),
            None => sk_items::item_catalog::materialize_catalog_item(&reward_id, Some(&json!({ "quantity": 1, "origin": "gifted" }))),
        };
        let fallback = format!("knight-tear:{}", js::string(v.command.get("command_id")));
        set_field(&mut v.command, "reward_item", gifted_item(&source, &fallback));
        set_field(&mut v.command, "reward_source_npc_id", if carried.is_some() { Value::String(npc_id) } else { Value::Null });
    }
    set_field(&mut v.command, "visibility", json!("public"));
    Ok(())
}

/// Блок 24 (6642–6662): незнакомец.
pub fn check_scenario_stranger(v: &mut Validation<'_>) -> Step {
    if !SCENARIO_COMMAND_TYPES.contains(&command_type(v).as_str()) {
        return Ok(());
    }
    if !v.context.is_director() && !v.context.is_admin() {
        return Err(rule("Сцену сценария ставит только Режиссёр", "SCENARIO_STAGE_FORBIDDEN"));
    }
    if !js::truthy(v.command.get("stage")) {
        return Err(rule("Неизвестный шаг сцены незнакомца", "SCENARIO_STAGE_INVALID"));
    }
    let due = sk_attention::scenario_attention::scenario_stranger_stage(v.state);
    if due.map(|stage| Value::String(stage.into())).as_ref() != v.command.get("stage") {
        return Err(rule("Этот шаг сцены незнакомца сейчас не к месту", "SCENARIO_STAGE_NOT_DUE"));
    }
    let arrive = v.command.get("stage").and_then(Value::as_str) == Some("arrive");
    let profile = sk_attention::scenario_attention::scenario_stranger_profile(v.state, arrive).unwrap_or(Value::Null);
    let request = json!({ "command_type": "UpsertNpcSocialProfile", "npc": profile });
    let validated = sk_social::npc_social::validate_npc_social_command(&request, v.state, &json!({ "isDirector": true })).map_err(|error| rule(error.message, &error.code))?;
    set_field(&mut v.command, "npc", validated.get("npc").cloned().unwrap_or(Value::Null));
    set_field(&mut v.command, "visibility", json!("public"));
    Ok(())
}

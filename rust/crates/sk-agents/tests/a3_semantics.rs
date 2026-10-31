//! Смысловые проверки из тестов JS о модулях А3 (`test/free-action-adjudication`,
//! `action-adjudicator`, `free-action-approach`, `free-action-hazard-*`,
//! `free-action-wall-contact`, `level-transition-phrase` — без оркестратора и
//! HTTP-сервера; сквозные части этих тестов перенесёт задача оркестратора).

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Wake, Waker};

use serde_json::{json, Map, Value};
use sk_agents::action_adjudicator::{adjudication_brief, ActionAdjudicator, DiscussOptions};
use sk_agents::free_action_adjudication as fa;
use sk_agents_base::llm_client::{LlmClient, LlmError, LlmFuture};
use sk_rules::normalize::normalize_campaign_state;
use sk_tactical::tactical_map::{add_prop, add_zone, create_tactical_map, legacy_cells_from_tactical_map, serialize_tactical_map, set_cell_json, set_edge_json, TacticalMap, TacticalMapOptions};

struct ThreadWaker(std::thread::Thread);

impl Wake for ThreadWaker {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
}

fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = Box::pin(future);
    let waker = Waker::from(Arc::new(ThreadWaker(std::thread::current())));
    let mut context = Context::from_waker(&waker);
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
            return value;
        }
        std::thread::park();
    }
}

/// Заглушка: один и тот же ответ (или отказ) на каждый вызов, счётчик вызовов.
struct Stub {
    reply: Result<Value, String>,
    calls: Mutex<usize>,
}

impl Stub {
    fn ok(value: Value) -> Arc<Self> {
        Arc::new(Self { reply: Ok(value), calls: Mutex::new(0) })
    }

    fn failing() -> Arc<Self> {
        Arc::new(Self { reply: Err("LLM_PROVIDER_ERROR".into()), calls: Mutex::new(0) })
    }

    fn count(&self) -> usize {
        *self.calls.lock().unwrap()
    }
}

impl LlmClient for Stub {
    fn model(&self) -> Option<String> {
        None
    }

    fn complete<'a>(&'a self, _input: &'a Value, _options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        Box::pin(async { Err(LlmError::new("UNUSED", "не ожидается")) })
    }

    fn complete_json<'a>(&'a self, _input: &'a Value, _options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        *self.calls.lock().unwrap() += 1;
        let reply = self.reply.clone().map_err(|message| LlmError { name: "Error".into(), code: None, message, details: Map::new(), provider_usage: None });
        Box::pin(async move { reply })
    }

    fn probe(&self) -> LlmFuture<'_, Result<Value, LlmError>> {
        Box::pin(async { Ok(json!([])) })
    }

    fn health(&self) -> Value {
        json!([])
    }
}

fn adjudicator(stub: &Arc<Stub>) -> ActionAdjudicator {
    ActionAdjudicator::new(Some(Arc::clone(stub) as Arc<dyn LlmClient>), None, None)
}

fn normalize(value: Value) -> Value {
    normalize_campaign_state(&value).expect("состояние нормализуется")
}

fn s(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}

fn map(width: i64, height: i64, location: &str) -> TacticalMap {
    let mut map = create_tactical_map(&TacticalMapOptions { width, height, location_id: location, seed: location, ..TacticalMapOptions::default() }).expect("карта");
    for y in 0..height {
        for x in 0..width {
            set_cell_json(&mut map, x, y, &json!({ "passable": true, "revealed": true, "material": "stone" })).expect("клетка");
        }
    }
    map
}

fn bind(state: &Value, actor: &str, text: &str, input: &Value) -> Value {
    fa::bind_free_action_reading_to_state(state, actor, text, input, false).expect("привязка")
}

fn interpret_bound(state: &Value, actor: &str, text: &str) -> Value {
    bind(state, actor, text, &fa::interpret_free_action(text))
}

// --- free-action-adjudication.test.mjs ------------------------------------------------

#[test]
fn jumps_read_as_acrobatics() {
    for text in ["Вспрыгиваю на люстру", "Хочу вспрыгнуть на стол", "Спрыгну с уступа", "Прыгаю через канаву", "Совершаю прыжок через ручей"] {
        let reading = fa::interpret_free_action(text);
        assert_eq!(reading["ability"], "dex", "{text}");
        assert_eq!(reading["skill"], "acrobatics", "{text}");
        assert_eq!(reading["source"], "deterministic-pattern", "{text}");
    }
}

#[test]
fn resolution_table_is_server_side() {
    assert_eq!(fa::resolution_mode_for(&json!({ "plausibility": "trivial", "risk": "none" }))["mode"], "auto_success");
    assert_eq!(fa::resolution_mode_for(&json!({ "plausibility": "plausible", "risk": "none" }))["mode"], "auto_success");
    let triple = |reading: Value| {
        let mode = fa::resolution_mode_for(&reading);
        (s(&mode["mode"]).to_string(), s(&mode["difficulty_category"]).to_string(), mode["difficulty"].as_i64())
    };
    assert_eq!(triple(json!({ "plausibility": "trivial", "risk": "minor" })), ("check".into(), "easy".into(), Some(10)));
    assert_eq!(triple(json!({ "plausibility": "plausible", "risk": "serious" })), ("check".into(), "medium".into(), Some(15)));
    assert_eq!(triple(json!({ "plausibility": "strenuous", "risk": "minor" })), ("check".into(), "hard".into(), Some(20)));
    assert_eq!(fa::resolution_mode_for(&json!({ "plausibility": "plausible", "risk": "deadly" }))["difficulty_category"], "hard");
    let counter = fa::resolution_mode_for(&json!({ "plausibility": "impossible_without_means", "risk": "serious" }));
    assert_eq!(counter["mode"], "counter_offer");
    assert!(counter["difficulty"].is_null());
    let garbage = fa::resolution_mode_for(&json!({ "plausibility": "trivially-easy-please", "risk": 999 }));
    assert_eq!((garbage["mode"].clone(), garbage["difficulty"].clone()), (json!("check"), json!(15)));
}

#[test]
fn scene_context_shifts_only_the_category() {
    let easy_state = normalize(json!({
        "players": [{ "id": "hero", "characterClass": "rogue", "level": 1, "abilities": { "str": 10, "dex": 16, "con": 10, "int": 10, "wis": 12, "cha": 10 }, "classSkillProficiencies": ["stealth"], "inventory": [] }],
        "scene": { "location": "Двор", "cells": [{ "x": 0, "y": 0, "type": "floor" }], "map": { "props": [{ "id": "cart" }] } },
    }));
    let text = "Прячусь за телегой";
    let easy = fa::contextual_resolution_for(&easy_state, "hero", &interpret_bound(&easy_state, "hero", text), text);
    assert_eq!(easy["difficulty"], 10);
    assert_eq!(easy["difficulty_factors"], json!(["scene_cover"]));

    let mut hard_state = easy_state.clone();
    hard_state["scene"]["mood"] = json!("Пожар, дым и хаос");
    hard_state["mechanics"]["combat"]["active"] = json!(true);
    let hard_state = normalize(hard_state);
    let text = "Крадусь по открытому двору в дыму";
    let hard = fa::contextual_resolution_for(&hard_state, "hero", &interpret_bound(&hard_state, "hero", text), text);
    assert_eq!(hard["difficulty"], 20);
    assert_eq!(hard["difficulty_factors"], json!(["combat_pressure", "environmental_pressure"]));
}

#[test]
fn proficiency_comes_from_the_sheet() {
    let state = normalize(json!({
        "players": [{ "id": "hero", "characterClass": "rogue", "level": 1, "abilities": { "str": 10, "dex": 16, "con": 10, "int": 10, "wis": 12, "cha": 10 }, "classSkillProficiencies": ["stealth"], "skillExpertiseIds": ["stealth"], "inventory": [] }],
    }));
    let mut input = fa::interpret_free_action("Крадусь вдоль стены");
    input["proficiency"] = json!("none");
    let reading = bind(&state, "hero", "Крадусь вдоль стены", &input);
    assert_eq!(reading["skill"], "stealth");
    assert_eq!(reading["proficiency"], "expertise");
    assert_eq!(reading["proficiency_bonus"], 4);
}

#[test]
fn transfer_builds_only_the_owner_command() {
    let state = normalize(json!({
        "partyMemberIds": ["hero", "ally"],
        "players": [
            { "id": "hero", "character": "Ада", "characterClass": "fighter", "level": 1, "abilities": { "str": 12, "dex": 10, "con": 10, "int": 10, "wis": 10, "cha": 10 }, "classSkillProficiencies": [], "inventory": [{ "id": "rope", "name": "Верёвка", "type": "tool", "quantity": 2 }] },
            { "id": "ally", "character": "Бор", "characterClass": "fighter", "level": 1, "abilities": { "str": 12, "dex": 10, "con": 10, "int": 10, "wis": 10, "cha": 10 }, "classSkillProficiencies": [], "inventory": [{ "id": "torch", "name": "Факел", "type": "tool", "quantity": 1 }] },
        ],
    }));
    let give_text = "Передаю Бору верёвку";
    let give = fa::resolve_inventory_transfer(&state, "hero", give_text, &interpret_bound(&state, "hero", give_text)).expect("передача");
    assert_eq!(give["status"], "command");
    assert_eq!(give["command"], json!({ "command_type": "TransferItem", "actor_id": "hero", "recipient_id": "ally", "item_id": "rope", "quantity": 1 }));
    let take_text = "Беру у Бора факел";
    let take = fa::resolve_inventory_transfer(&state, "hero", take_text, &interpret_bound(&state, "hero", take_text)).expect("ответ");
    assert_eq!(take["status"], "clarification");
    assert!(s(&take["narration"]).contains("владелец"));
}

fn corpse_search(state: &Value, text: &str) -> Value {
    fa::resolve_corpse_search(state, "hero", text, &interpret_bound(state, "hero", text)).expect("обыск").expect("ответ")
}

#[test]
fn corpse_search_never_invents_contents() {
    let bare = normalize(json!({
        "players": [{ "id": "hero", "character": "Ада", "inventory": [] }],
        "enemies": [{ "id": "goblin", "name": "Гоблин", "hp": 0, "maxHp": 7, "alive": false }],
    }));
    let result = corpse_search(&bare, "Обыскиваю тело гоблина");
    assert_eq!(result["status"], "clarification");
    assert_eq!(result["server_owned_contents"], false);
    assert!(s(&result["narration"]).contains("не буду выдумывать"));

    // В JS снаряжение берётся из сборщика встреч и переживает нормализацию; здесь
    // состояние собрано вручную и не нормализуется — проверяется только обыск.
    let armed = json!({
        "players": [{ "id": "hero", "character": "Ада", "inventory": [] }],
        "enemies": [{ "id": "captain", "name": "Капитан стражи", "hp": 0, "maxHp": 30, "alive": false, "loadout": { "template_id": "x", "items": [{ "item_instance_id": "sword-1", "catalog_id": "srd_5_2_1:longsword", "quantity": 1 }], "purse_cp": 0 } }],
    });
    let result = corpse_search(&armed, "Обыскиваю тело капитана стражи");
    assert_eq!(result["server_owned_contents"], true);
    assert_eq!(result["corpse_id"], "captain");
    assert!(s(&result["narration"]).contains("есть снаряжение"));
    assert!(result.get("command").is_none());

    let purse = normalize(json!({
        "players": [{ "id": "hero", "character": "Ада", "inventory": [] }],
        "enemies": [{ "id": "thug", "name": "Головорез", "hp": 0, "maxHp": 11, "alive": false, "loadout": { "template_id": "srd_5_2_1:bandit", "items": [], "purse_cp": 54 } }],
    }));
    let result = corpse_search(&purse, "Проверяю карманы тела головореза");
    assert_eq!(result["server_owned_contents"], true);
    assert_eq!(result["corpse_id"], "thug");
}

fn satisfied(state: &Value, actor: &str, means: Value) -> Value {
    fa::verify_means(state, actor, Some(&means))
}

#[test]
fn means_are_checked_against_the_sheet_by_id_and_name() {
    let state = json!({ "players": [{ "id": "hero", "inventory": [{ "id": "rope-1", "catalog_id": "srd_5_2_1:rope", "name": "Верёвка" }], "knownSpellIds": ["fire-bolt"] }] });
    assert_eq!(satisfied(&state, "hero", json!(["Верёвка"]))["satisfied"], true);
    assert_eq!(satisfied(&state, "hero", json!(["fire-bolt"]))["satisfied"], true);
    let missing = satisfied(&state, "hero", json!(["Крылья", "Верёвка"]));
    assert_eq!(missing["satisfied"], false);
    assert_eq!(missing["missing"], json!(["Крылья"]));
    for named in ["заклинание «Огненный снаряд»", "Огненный снаряд", "заговор «огненный снаряд»"] {
        assert_eq!(satisfied(&state, "hero", json!([named]))["satisfied"], true, "{named}");
    }

    let party = json!({
        "ruleset_id": "srd_5_2_1",
        "players": [
            { "id": "mirel", "character": "Мирель", "characterClass": "wizard", "level": 3, "abilities": { "int": 16 }, "knownSpellIds": ["fire-bolt", "mage-hand", "magic-missile", "shield"], "preparedSpellIds": ["magic-missile"], "inventory": [{ "id": "staff-1", "catalog_id": "srd_5_2_1:quarterstaff", "name": "Боевой посох" }] },
            { "id": "borin", "character": "Борин", "characterClass": "fighter", "level": 3, "selectedFeatureIds": ["fighting-style-defense"] },
        ],
    });
    for named in ["заклинание «Огненный снаряд»", "«Огненный снаряд»", "огненный снаряд", "заговор \"Огненный Снаряд\"", "Fire Bolt", "заклинание «Волшебная стрела»", "Боевой посох", "staff-1", "предмет «Боевой посох»"] {
        assert_eq!(satisfied(&party, "mirel", json!([named]))["satisfied"], true, "{named}");
    }
    for absent in ["заклинание «Огненный шар»", "заклинание «Луч холода»", "полёт"] {
        let refusal = satisfied(&party, "mirel", json!([absent, "заклинание «Огненный снаряд»"]));
        assert_eq!(refusal["missing"], json!([absent]), "{absent}");
    }
    assert_eq!(satisfied(&party, "borin", json!(["умение «Второе дыхание»"]))["satisfied"], true);
    assert_eq!(satisfied(&party, "borin", json!(["боевой стиль «Защита»"]))["satisfied"], true);
    assert_eq!(satisfied(&party, "borin", json!(["умение «Ярость»"]))["missing"], json!(["умение «Ярость»"]));
}

#[test]
fn legacy_fail_forward_table_survives() {
    for risk in ["none", "minor", "serious", "deadly"] {
        let consequence = fa::fail_forward_for(Some(&json!(risk)), None);
        assert!(consequence["minutes"].as_i64().unwrap_or(0) > 0, "{risk}");
        assert!(!s(&consequence["summary"]).is_empty(), "{risk}");
    }
    assert_eq!(fa::fail_forward_for(Some(&json!("serious")), None)["advances_quest_clock"], true);
    assert_eq!(fa::fail_forward_for(Some(&json!("none")), None)["advances_quest_clock"], false);
    assert_eq!(fa::fail_forward_for(Some(&json!("minor")), Some(&json!("exposure")))["consequence_type"], "exposure");
}

#[test]
fn stunts_require_a_check_even_if_the_model_says_trivial() {
    let state = normalize(json!({ "players": [{ "id": "hero", "inventory": [] }], "scene": { "cells": [] } }));
    for (text, skill, ability) in [("Удерживаю стойку на одной ладони", "acrobatics", "dex"), ("Держу тело горизонтально на шесте", "athletics", "str"), ("Прохожу по узкой вращающейся опоре", "acrobatics", "dex")] {
        let reading = bind(&state, "hero", text, &json!({
            "activity_kind": "stunt", "duration_class": "prolonged", "skill": skill, "ability": ability,
            "plausibility": "trivial", "risk": "none", "consequence_type": "time", "effect": "none",
            "damage_expression": "100d100", "duration_minutes": 999, "success": true,
        }));
        let resolution = fa::contextual_resolution_for(&state, "hero", &reading, text);
        let policy = fa::free_action_resolution_policy(&reading);
        assert_eq!(resolution["mode"], "check", "{text}");
        assert_eq!(resolution["difficulty"], 20, "{text}");
        assert_eq!(policy["success_minutes"], 0, "{text}");
        assert_eq!(policy["failure"]["minutes"], 0, "{text}");
        assert_eq!(policy["failure"]["damage_expression"], "1d4", "{text}");
        for forbidden in ["damage_expression", "duration_minutes", "success"] {
            assert!(reading.get(forbidden).is_none(), "{forbidden}");
        }
    }
}

#[test]
fn duration_follows_the_work() {
    let state = normalize(json!({ "players": [{ "id": "hero", "inventory": [] }], "scene": { "cells": [] } }));
    for (text, skill, kind, duration, consequence, minutes) in [
        ("Убеждаю собеседника помочь", "persuasion", "social", "brief", "lost_opportunity", 1),
        ("Сопоставляю записи в старых книгах", "investigation", "knowledge", "prolonged", "injury", 60),
        ("Проворачиваю тяжёлый механизм с опасной отдачей", "athletics", "environmental", "extended", "injury", 10),
        ("Незаметно меняю положение за колонной", "stealth", "stealth", "instant", "exposure", 0),
    ] {
        let reading = bind(&state, "hero", text, &json!({ "skill": skill, "activity_kind": kind, "duration_class": duration, "consequence_type": consequence, "plausibility": "plausible", "risk": "serious" }));
        let policy = fa::free_action_resolution_policy(&reading);
        assert_eq!(policy["success_minutes"], minutes, "{text}");
        assert_eq!(policy["failure"]["minutes"], minutes, "{text}");
        assert!(policy["failure"].get("damage_expression").is_none(), "{text}");
        assert_eq!(policy["failure"]["advances_quest_clock"], false, "{text}");
        let summary = s(&policy["failure"]["summary"]);
        assert!(!summary.contains("место перестало быть спокойным") && !summary.contains("события пошли своим ходом"), "{text}");
    }
}

#[test]
fn old_confirmed_profiles_keep_their_price() {
    let state = normalize(json!({ "players": [{ "id": "hero", "inventory": [] }], "scene": { "cells": [] } }));
    let preserve = |text: &str, input: Value| fa::bind_free_action_reading_to_state(&state, "hero", text, &input, true).expect("привязка");
    let legacy = fa::free_action_resolution_policy(&preserve("Акробатический трюк", json!({ "ability": "dex", "skill": "acrobatics", "plausibility": "strenuous", "risk": "minor", "consequence_type": "time" })));
    assert_eq!(legacy["success_minutes"], 5);
    assert_eq!(legacy["failure"]["minutes"], 10);
    assert!(legacy["failure"].get("damage_expression").is_none());
    let old = fa::free_action_resolution_policy(&preserve("Сложный трюк", json!({
        "ability": "dex", "skill": "acrobatics", "plausibility": "strenuous", "risk": "minor", "consequence_type": "injury",
        "activity_kind": "stunt", "duration_class": "instant", "policy_version": "free-action-resolution/v1", "hazard": "fire",
    })));
    assert_eq!(old["success_minutes"], 0);
    assert_eq!(old["failure"]["damage_expression"], "1d4");
    assert_eq!(old["failure"]["damage_type"], "bludgeoning");
    for (text, skill) in [("Поправляю рукав", "sleight_of_hand"), ("Спокойно удерживаю простую позу на ровном полу", "acrobatics")] {
        let routine = bind(&state, "hero", text, &json!({ "activity_kind": "routine", "skill": skill, "plausibility": "trivial", "risk": "none" }));
        assert_eq!(fa::contextual_resolution_for(&state, "hero", &routine, "")["mode"], "auto_success", "{text}");
        assert!(fa::free_action_resolution_policy(&routine)["failure"].get("damage_expression").is_none(), "{text}");
    }
}

#[test]
fn stakes_are_declared_before_the_roll() {
    let resolution = fa::resolution_mode_for(&json!({ "plausibility": "plausible", "risk": "serious" }));
    let stakes = fa::stakes_for(&json!({ "ability": "str", "skill": "athletics", "resolution": resolution, "risk": "serious" })).expect("ставки");
    assert_eq!(stakes["difficulty"], 15);
    assert_eq!(stakes["ability"], "str");
    assert!(!s(&stakes["on_failure"]).is_empty());
    let auto = fa::resolution_mode_for(&json!({ "plausibility": "trivial", "risk": "none" }));
    assert!(fa::stakes_for(&json!({ "resolution": auto, "risk": "none" })).is_none());
}

#[test]
fn repeated_failed_attempt_is_recognized() {
    let mut state = json!({ "scene": { "location": "Корчма", "objective": "Найти караван", "cells": [] }, "mechanics": { "world_time": { "elapsed_minutes": 0 } }, "rulings": [] });
    let fingerprint = fa::attempt_fingerprint("hero", "выломать дверь плечом", "дверь");
    let situation = fa::situation_fingerprint(&state);
    state["rulings"] = json!([{ "outcome": "failure", "provenance": { "attempt_fingerprint": fingerprint, "situation_fingerprint": situation } }]);
    assert!(fa::previous_failed_attempt(&state, &fingerprint).is_some());
    let mut later = state.clone();
    later["mechanics"] = json!({ "world_time": { "elapsed_minutes": 30 } });
    assert!(fa::previous_failed_attempt(&later, &fingerprint).is_none());
    assert!(fa::previous_failed_attempt(&state, &fa::attempt_fingerprint("hero", "подобрать замок", "дверь")).is_none());
}

#[test]
fn goal_beats_approach_for_observation() {
    let state = normalize(json!({
        "partyMemberIds": ["hero"],
        "players": [{ "id": "hero", "character": "Ада", "characterClass": "cleric", "level": 1, "abilities": { "str": 10, "dex": 12, "con": 12, "int": 10, "wis": 16, "cha": 10 }, "inventory": [] }],
    }));
    let model_said = |text: &str| {
        let mut reading = fa::interpret_free_action(text);
        for (key, value) in [("skill", "acrobatics"), ("ability", "dex"), ("activity_kind", "stunt"), ("plausibility", "plausible"), ("risk", "minor"), ("effect", "none"), ("hazard", "")] {
            reading[key] = json!(value);
        }
        reading
    };
    let crowd = "Проталкиваюсь сквозь толпу к шлюзам и смотрю, кто пытается их открыть";
    let watched = bind(&state, "hero", crowd, &model_said(crowd));
    assert_eq!(watched["skill"], "perception");
    assert_eq!(watched["ability"], "wis");
    assert_ne!(watched["activity_kind"], "stunt");
    assert_ne!(watched["consequence_type"], "injury");
    let jump = "Перепрыгиваю через перила к шлюзу и смотрю, кто его открывает";
    assert_eq!(bind(&state, "hero", jump, &model_said(jump))["skill"], "acrobatics");
}

// --- action-adjudicator.test.mjs ------------------------------------------------------

fn bridge_scene() -> Value {
    normalize(json!({
        "players": [{
            "id": "hero", "character": "Аster", "characterClass": "fighter", "level": 1, "hp": 20, "maxHp": 20, "armor": 15, "speed": 30, "x": 0, "y": 0,
            "abilities": { "str": 16, "dex": 12, "con": 14, "int": 10, "wis": 12, "cha": 8 },
            "classSkillProficiencies": ["athletics", "perception"], "skillExpertiseIds": ["perception"], "preparedSpellIds": ["sacred-flame"],
            "inventory": [{ "id": "rope", "name": "Верёвка", "quantity": 1, "equipped": false }],
        }],
        "enemies": [{ "id": "ogre", "name": "Огр", "hp": 25, "maxHp": 25, "armor": 12, "alive": true, "x": 1, "y": 0 }],
        "scene": { "title": "Мост", "location": "Мост", "mood": "Ветрено", "objective": "Удержать мост", "turn": 1, "cells": [{ "x": 0, "y": 0, "type": "floor", "revealed": true }] },
        "mechanics": { "combat": { "active": true, "round": 2, "active_index": 0, "initiative": [{ "actor_id": "hero" }, { "actor_id": "ogre" }], "action_economy": { "hero": { "action": true, "bonus_action": false, "movement": true, "movement_spent": 10 } } } },
    }))
}

fn contact_scene(fire: bool, wall: bool) -> Value {
    let mut tactical = map(3, 1, "contact-preview");
    if fire {
        add_prop(&mut tactical, &json!({ "id": "campfire-preview", "assetId": "campfire", "x": 1.5, "y": 0.5, "footprint": [{ "x": 1, "y": 0 }] })).expect("костёр");
    }
    if wall {
        set_edge_json(&mut tactical, 0, 0, 1, 0, &json!({ "kind": "wall", "blocksMove": true, "blocksSight": true })).expect("стена");
    }
    let mut state = bridge_scene();
    state["scene"]["map"] = serialize_tactical_map(&tactical).expect("карта");
    state["scene"]["cells"] = json!([]);
    state["mechanics"]["combat"]["active"] = json!(false);
    normalize(state)
}

#[test]
fn hidden_npc_never_reaches_the_brief_or_binding() {
    let mut state = bridge_scene();
    let location = state["scene"]["location"].clone();
    state["social"]["npcs"].as_array_mut().expect("npcs").push(json!({ "id": "secret", "name": "Тайный наблюдатель", "location": location, "visibility": "gm_only", "available": true }));
    let brief = sk_core::js::stringify(&adjudication_brief(&state, "hero", "Осматриваюсь", None));
    assert!(!brief.contains("Тайный наблюдатель") && !brief.contains("\"secret\""));
    let stub = Stub::ok(json!({
        "goal_summary": "Отвлечь наблюдателя", "approach_summary": "Шумом переключить внимание", "obstacle": "наблюдатель",
        "ability": "cha", "skill": "performance", "plausibility": "plausible", "risk": "minor", "action_cost": "action",
        "effect": "distract", "effect_target": "secret", "target_id": "secret", "proficiency": "none", "consequence_type": "noise",
    }));
    let text = "Отвлекаю Тайного наблюдателя";
    let reading = block_on(adjudicator(&stub).read(&state, "hero", text, &fa::interpret_free_action(text), None)).expect("прочтение");
    assert_ne!(reading["target_id"], "secret");
    assert_ne!(reading["effect_target"], "secret");
    assert!(reading["reference_ambiguities"].as_array().is_some_and(|fields| fields.contains(&json!("target_id"))));
}

#[test]
fn brief_carries_sheet_scene_participants_and_economy() {
    let brief = adjudication_brief(&bridge_scene(), "hero", "Опрокидываю жаровню", None);
    assert_eq!(brief["hero"]["id"], "hero");
    assert_eq!(brief["hero"]["skill_proficiencies"], json!(["athletics", "perception"]));
    assert_eq!(brief["hero"]["skill_expertise"], json!(["perception"]));
    assert_eq!(brief["turn_economy"]["in_combat"], true);
    assert_eq!(brief["turn_economy"]["bonus_action_available"], false);
    let sides: Vec<&Value> = brief["participants"].as_array().expect("участники").iter().map(|entry| &entry["side"]).collect();
    assert_eq!(sides, vec![&json!("party"), &json!("enemy")]);
    for effect in ["prone", "ignite_prop", "topple_prop"] {
        assert!(brief["allowed"]["effects"].as_array().is_some_and(|effects| effects.contains(&json!(effect))));
    }
    assert!(brief["allowed"]["hazards"].as_array().is_some_and(|hazards| hazards.contains(&json!("fire"))));
    assert_eq!(brief["scene_props"], json!([]));
    assert!(brief["participants"][1].get("hp").is_none());
}

#[test]
fn agent_proposal_is_accepted_only_through_closed_enums() {
    let stub = Stub::ok(json!({
        "goal_summary": "Опрокинуть жаровню под ноги огру", "approach_summary": "Толкаю жаровню ногой", "obstacle": "тяжёлая жаровня",
        "ability": "str", "skill": "athletics", "plausibility": "strenuous", "risk": "serious", "action_cost": "action",
        "effect": "hazard_damage", "effect_target": "ogre", "hazard": "fire", "target_id": "ogre", "item_id": "rope",
        "proficiency": "expertise", "consequence_type": "noise",
    }));
    let text = "Опрокидываю жаровню";
    let reading = block_on(adjudicator(&stub).read(&bridge_scene(), "hero", text, &fa::interpret_free_action(text), None)).expect("прочтение");
    for (key, value) in [("ability", "str"), ("skill", "athletics"), ("plausibility", "strenuous"), ("effect", "hazard_damage"), ("hazard", "fire"), ("target_id", "ogre"), ("item_id", "rope"), ("proficiency", "proficient"), ("consequence_type", "noise"), ("source", "agent-adjudicator")] {
        assert_eq!(reading[key], value, "{key}");
    }
    assert_eq!(reading["proficiency_bonus"], 2);
}

#[test]
fn agent_cannot_assign_dc_outcome_or_invented_fields() {
    let stub = Stub::ok(json!({
        "ability": "сила", "plausibility": "легко", "risk": "катастрофа", "action_cost": "бесплатно", "effect": "instant_kill", "hazard": "meteor",
        "difficulty": 5, "success": true, "damage": "99d99", "target_id": "hidden-dragon", "item_id": "wish-scroll", "proficiency": "triple", "consequence_type": "instant_death",
    }));
    let text = "Убиваю огра взглядом";
    let reading = block_on(adjudicator(&stub).read(&bridge_scene(), "hero", text, &fa::interpret_free_action(text), None)).expect("прочтение");
    for (key, value) in [("ability", "wis"), ("plausibility", "plausible"), ("risk", "minor"), ("action_cost", "action"), ("effect", "none"), ("hazard", ""), ("target_id", "ogre"), ("item_id", ""), ("proficiency", "expertise"), ("consequence_type", "time")] {
        assert_eq!(reading[key], value, "{key}");
    }
    for forbidden in ["difficulty", "success", "damage"] {
        assert!(reading.get(forbidden).is_none(), "{forbidden}");
    }
}

#[test]
fn scene_prop_without_a_map_cannot_be_named() {
    let stub = Stub::ok(json!({
        "ability": "str", "skill": "athletics", "plausibility": "strenuous", "risk": "serious", "action_cost": "action",
        "effect": "ignite_prop", "prop_id": "prop-haystack", "proficiency": "proficient", "consequence_type": "noise",
    }));
    let text = "Поджигаю стог сена у стены";
    let reading = block_on(adjudicator(&stub).read(&bridge_scene(), "hero", text, &fa::interpret_free_action(text), None)).expect("прочтение");
    assert_eq!(reading["prop_id"], "");
    assert_eq!(reading["effect"], "none");
}

#[test]
fn model_failure_and_broken_shapes_fall_back_to_the_table() {
    let text = "Подпираю створку ворот обломком бревна";
    let fallback = fa::interpret_free_action(text);
    let reading = block_on(adjudicator(&Stub::failing()).read(&bridge_scene(), "hero", text, &fallback, None)).expect("прочтение");
    assert_eq!(reading["ability"], fallback["ability"]);
    assert_eq!(reading["skill"], fallback["skill"]);
    assert!(s(&reading["source"]).ends_with("after-agent-error"));

    let valid = json!({
        "goal_summary": "Проверить проход", "approach_summary": "Осмотреть замок", "obstacle": "замок", "ability": "wis", "skill": "perception",
        "plausibility": "plausible", "risk": "minor", "action_cost": "action", "effect": "none", "proficiency": "none", "consequence_type": "time", "required_means": [],
    });
    let mut bad_means = valid.clone();
    bad_means["required_means"] = json!(["верёвка", 4]);
    let mut bad_risk = valid.clone();
    bad_risk["risk"] = json!("reckless");
    for payload in [bad_means, bad_risk, json!({})] {
        let result = block_on(adjudicator(&Stub::ok(payload)).read(&bridge_scene(), "hero", "Осматриваю замок", &fa::interpret_free_action("Осматриваю замок"), None)).expect("прочтение");
        assert!(s(&result["source"]).ends_with("after-agent-error"));
    }

    let without = block_on(ActionAdjudicator::new(None, None, None).read(&bridge_scene(), "hero", text, &fallback, None)).expect("прочтение");
    assert_eq!(without["source"], fallback["source"]);
    assert_eq!(without["skill"], "athletics");
    assert_eq!(without["proficiency"], "proficient");
    assert_eq!(without["proficiency_bonus"], 2);
    assert_eq!(without["reference_ambiguities"], json!([]));
}

#[test]
fn contact_questions_never_call_the_model() {
    let stub = Stub::ok(json!({ "ability": "dex", "skill": "acrobatics" }));
    let options = DiscussOptions { action: "делаю двойное сальто".into(), recent: vec![json!({ "question": "Что будет при провале?", "answer": "Проверка Акробатики." })], check: None };
    let fire = block_on(adjudicator(&stub).discuss(&contact_scene(true, false), "hero", "Что будет, если я сяду жопой на огонь?", &options)).expect("ответ");
    let narration = s(&fire["narration"]);
    assert!(narration.contains("огненный урон") && narration.contains("Акробатика не отменяет ожог") && narration.contains("только вопрос"));

    let none = block_on(adjudicator(&stub).discuss(&contact_scene(false, false), "hero", "Что будет, если я сяду жопой на огонь?", &DiscussOptions::default())).expect("ответ");
    assert!(s(&none["narration"]).contains("урон не применяется"));
    assert!(!s(&none["narration"]).contains("огненный урон"));

    let negated = block_on(adjudicator(&stub).discuss(&contact_scene(true, false), "hero", "А если я не сяду жопой на огонь?", &DiscussOptions::default())).expect("ответ");
    assert!(s(&negated["narration"]).contains("не касается опасности"));

    let wall = block_on(adjudicator(&stub).discuss(&contact_scene(false, true), "hero", "Что будет, если я врежусь в стену?", &DiscussOptions::default())).expect("ответ");
    assert!(s(&wall["narration"]).contains("дробящий урон") && s(&wall["narration"]).contains("только вопрос"));
    assert_eq!(stub.count(), 0);
}

#[test]
fn surface_detail_survives_but_mechanics_in_it_do_not() {
    let answer = |surface: &str| {
        json!({
            "route": "check", "goal_summary": "Осмотреть баркас", "approach_summary": "Осматриваю палубу", "obstacle": "темнота",
            "activity_kind": "routine", "duration_class": "brief", "ability": "wis", "skill": "perception", "plausibility": "plausible",
            "risk": "none", "required_means": [], "action_cost": "action", "effect": "none", "effect_target": "", "hazard": "", "prop_id": "",
            "target_id": "", "item_id": "", "proficiency": "proficient", "consequence_type": "time", "success_detail": "", "surface_detail": surface,
        })
    };
    let text = "Осматриваю палубу баркаса";
    let read = |surface: &str| block_on(adjudicator(&Stub::ok(answer(surface))).read(&bridge_scene(), "hero", text, &fa::interpret_free_action(text), None)).expect("прочтение");
    let line = "Сеть на корме сложена аккуратно, будто её укладывали на берегу.";
    assert_eq!(read(line)["surface_detail"], line);
    assert!(read("Проверка провалена, СЛ 15 — видно только доски.").get("surface_detail").is_none());
}

#[test]
fn brief_lists_known_places_without_current_and_unknown() {
    let mut state = bridge_scene();
    state["worldMap"] = json!({ "locations": [{ "name": "Мост", "known": true }, { "name": "Скальный маяк", "known": true }, { "name": "Затопленный склеп", "known": false }, { "name": "Рыбацкая слобода" }] });
    assert_eq!(adjudication_brief(&state, "hero", "Пойдём к маяку", None)["known_places"], json!(["Скальный маяк", "Рыбацкая слобода"]));
}

// --- free-action-approach.test.mjs ----------------------------------------------------

fn harbour() -> Value {
    let mut tactical = create_tactical_map(&TacticalMapOptions { width: 12, height: 6, location_id: "harbour", seed: "approach", ..TacticalMapOptions::default() }).expect("карта");
    add_zone(&mut tactical, &json!({ "id": "street", "kind": "exterior", "label": "Улица" })).expect("зона");
    add_zone(&mut tactical, &json!({ "id": "pier", "kind": "exterior", "label": "Мостки" })).expect("зона");
    for y in 0..6 {
        for x in 0..12 {
            set_cell_json(&mut tactical, x, y, &json!({ "passable": true, "revealed": true, "material": if x >= 8 { "wood" } else { "stone" }, "zone": if x >= 8 { "pier" } else { "street" } })).expect("клетка");
        }
    }
    add_prop(&mut tactical, &json!({ "id": "barrel-1", "assetId": "barrel", "x": 6, "y": 1 })).expect("бочка");
    add_prop(&mut tactical, &json!({ "id": "boat-1", "assetId": "rowboat", "x": 10, "y": 4 })).expect("лодка");
    normalize(json!({
        "sessionCode": "APPROACH",
        "scene": { "title": "Причал", "location": "Причал", "location_id": "harbour", "map": serialize_tactical_map(&tactical).expect("карта"), "cells": legacy_cells_from_tactical_map(&tactical) },
        "players": [
            { "id": "hero", "character": "Мирель", "x": 0, "y": 2, "hp": 10, "maxHp": 10, "armor": 11, "speed": 30, "inventory": [] },
            { "id": "ally", "character": "Борин", "x": 0, "y": 3, "hp": 10, "maxHp": 10, "armor": 16, "speed": 25, "inventory": [] },
        ],
        "social": { "npcs": [{ "id": "lida", "name": "Лида Воронина", "role": "рыбачка", "location": "Причал", "visibility": "party", "available": true }] },
        "npc_world": { "schema_version": 3, "placements": [{ "npc_id": "lida", "location_id": "harbour", "x": 9, "y": 1 }], "inventories": {}, "vitals": {} },
    }))
}

fn near(to: &Value, x: i64, y: i64) -> bool {
    let (tx, ty) = (to["x"].as_i64().unwrap_or(-99), to["y"].as_i64().unwrap_or(-99));
    (tx - x).abs().max((ty - y).abs()) <= 1
}

#[test]
fn approach_phrase_parses_in_any_person() {
    let request = |text: &str| fa::approach_request_from(text).map(|request| (request.phrase, request.remainder));
    assert_eq!(request("Иду к бочкам"), Some(("бочкам".into(), String::new())));
    assert_eq!(request("Мирель выходит из таверны к мосткам"), Some(("мосткам".into(), String::new())));
    assert_eq!(request("Я выхожу к причалу, подхожу к баркасу и методично осматриваю его"), Some(("баркасу".into(), "методично осматриваю его".into())));
    assert_eq!(request("Борин идёт к бочкам на причале и простукивает их").map(|(_, rest)| rest), Some("простукивает их".into()));
    assert_eq!(request("Осматриваю бочки"), None);
}

#[test]
fn approach_moves_to_the_named_thing_place_or_person() {
    let state = harbour();
    let barrels = fa::resolve_exploration_command(&state, "hero", "Иду к бочкам").expect("подход");
    assert_eq!(barrels["status"], "command");
    assert_eq!(barrels["command"]["command_type"], "MoveActor");
    assert!(near(&barrels["command"]["to"], 6, 1));
    assert!(!s(&barrels["narration"]).contains("К кому"));
    let pier = fa::free_action_approach_plan(&state, "hero", "Мирель выходит к мосткам");
    assert_eq!((pier["status"].clone(), pier["kind"].clone()), (json!("ready"), json!("zone")));
    assert!(pier["destination"]["to"]["x"].as_i64().unwrap_or(0) >= 8);
    let person = fa::free_action_approach_plan(&state, "hero", "Мирель подходит к Лиде и спрашивает про баркас");
    assert_eq!((person["status"].clone(), person["kind"].clone()), (json!("ready"), json!("actor")));
    assert!(near(&person["destination"]["to"], 9, 1));
    assert_eq!(person["remainder"], "спрашивает про баркас");
    let boat = fa::free_action_approach_plan(&state, "hero", "Подхожу к баркасу и осматриваю его");
    assert_eq!((boat["status"].clone(), boat["kind"].clone()), (json!("ready"), json!("prop")));
    assert!(near(&boat["destination"]["to"], 10, 4));
    assert!(fa::resolve_exploration_command(&state, "hero", "Подхожу к баркасу и осматриваю его").is_none(), "составная заявка идёт арбитру");
    assert_eq!(fa::free_action_approach_plan(&state, "hero", "Иду к старому колоколу")["status"], "unresolved");
    assert!(fa::resolve_exploration_command(&state, "hero", "Иду к старому колоколу").is_none());
    assert_eq!(fa::free_action_approach_plan(&state, "hero", "Иду к бочке")["status"], "ready");
}

// --- free-action-hazard-safety.test.mjs ---------------------------------------------------

fn safety_fixture(wall: bool, extinguished: bool) -> Value {
    let mut tactical = map(3, 1, "hazard-safety");
    add_prop(&mut tactical, &json!({ "id": "fire", "assetId": "campfire", "x": 1.5, "y": 0.5, "footprint": [{ "x": 1, "y": 0 }] })).expect("огонь");
    if wall {
        set_edge_json(&mut tactical, 0, 0, 1, 0, &json!({ "kind": "wall", "blocksMove": true, "blocksSight": true })).expect("стена");
    }
    normalize(json!({
        "players": [{ "id": "hero", "character": "Ада", "hp": 20, "maxHp": 20, "x": 0, "y": 0, "inventory": [] }],
        "scene": { "location": "Зал", "cells": [], "map": serialize_tactical_map(&tactical).expect("карта") },
        "mechanics": if extinguished { json!({ "scene_interactions": { "fire": { "state": "extinguished" } } }) } else { json!({}) },
    }))
}

fn stunt_contact(state: &Value, text: &str, hazard: &str) -> Option<Value> {
    let reading = bind(state, "hero", text, &json!({ "activity_kind": "stunt", "skill": "acrobatics", "ability": "dex", "plausibility": "strenuous", "risk": "minor", "consequence_type": "injury", "hazard": hazard, "effect": "none" }));
    fa::resolve_hazard_contact(state, "hero", text, &reading)
}

#[test]
fn avoidance_negation_and_nearness_are_not_self_harm() {
    let state = safety_fixture(false, false);
    for text in ["Перепрыгиваю через костёр", "Не касаюсь огня", "Сажусь рядом с костром"] {
        assert_ne!(stunt_contact(&state, text, "fire").map(|result| result["status"].clone()), Some(json!("contact")), "{text}");
    }
    for state in [safety_fixture(true, false), safety_fixture(false, true)] {
        assert_eq!(stunt_contact(&state, "Сажусь в огонь", "fire").expect("ответ")["status"], "unavailable");
    }
    assert!(stunt_contact(&state, "Прыгаю пару раз на месте", "").is_none());
}

#[test]
fn lava_is_fire_but_glava_is_not() {
    assert_eq!(fa::canonical_environment_hazard_id(Some(&json!("лава"))), "fire");
    assert_eq!(fa::canonical_environment_hazard_id(Some(&json!("главу"))), "");
    assert_eq!(fa::canonical_environment_hazard_id(Some(&json!("славу"))), "");
}

// --- free-action-wall-contact.test.mjs ----------------------------------------------------

fn wall_actor(id: &str, x: i64) -> Value {
    json!({ "id": id, "character": id, "hp": 20, "maxHp": 20, "x": x, "y": 0, "abilities": { "str": 14, "dex": 12, "con": 12, "int": 10, "wis": 10, "cha": 10 }, "inventory": [] })
}

struct WallOptions {
    wall: bool,
    origin_revealed: bool,
    wall_revealed: bool,
    wall_x: i64,
    edge_kind: Option<&'static str>,
    actor_x: i64,
}

impl Default for WallOptions {
    fn default() -> Self {
        Self { wall: true, origin_revealed: true, wall_revealed: true, wall_x: 1, edge_kind: None, actor_x: 0 }
    }
}

fn native_wall(options: WallOptions) -> Value {
    let mut tactical = map(4, 1, "wall-contact");
    if options.wall || options.edge_kind.is_some() {
        let kind = options.edge_kind.unwrap_or("wall");
        set_edge_json(&mut tactical, options.wall_x - 1, 0, options.wall_x, 0, &json!({ "kind": kind, "blocksMove": options.wall, "blocksSight": options.wall })).expect("ребро");
        if !options.origin_revealed {
            set_cell_json(&mut tactical, options.wall_x - 1, 0, &json!({ "revealed": false })).expect("клетка");
        }
        if !options.wall_revealed {
            set_cell_json(&mut tactical, options.wall_x, 0, &json!({ "revealed": false })).expect("клетка");
        }
    }
    normalize(json!({
        "sessionCode": "WALL-CONTACT", "activePlayerId": "hero", "partyMemberIds": ["hero"],
        "players": [wall_actor("hero", options.actor_x), wall_actor("other", if options.actor_x == 3 { 0 } else { 3 })],
        "scene": { "title": "Зал", "location": "Зал", "cells": [], "map": serialize_tactical_map(&tactical).expect("карта") },
    }))
}

fn legacy_wall(revealed: bool) -> Value {
    let mut state = normalize(json!({
        "sessionCode": "WALL-LEGACY", "activePlayerId": "hero", "partyMemberIds": ["hero"],
        "players": [wall_actor("hero", 0), wall_actor("other", 3)],
        "scene": { "title": "Старый зал", "location": "Старый зал", "cells": [
            { "x": 0, "y": 0, "type": "floor", "revealed": true }, { "x": 1, "y": 0, "type": "wall", "revealed": revealed },
            { "x": 2, "y": 0, "type": "floor", "revealed": true }, { "x": 3, "y": 0, "type": "floor", "revealed": true },
        ] },
    }));
    if let Some(scene) = state["scene"].as_object_mut() {
        scene.shift_remove("map");
    }
    state
}

fn contact(state: &Value, text: &str) -> Option<Value> {
    fa::resolve_hazard_contact(state, "hero", text, &interpret_bound(state, "hero", text))
}

fn status(state: &Value, text: &str) -> Value {
    contact(state, text).map_or(Value::Null, |result| result["status"].clone())
}

#[test]
fn wall_collision_needs_a_visible_wall_and_is_not_touch_or_breach() {
    for (state, kind) in [(native_wall(WallOptions::default()), "wall-edge"), (legacy_wall(true), "wall-cell")] {
        let hit = contact(&state, "врезаюсь в стену").expect("удар");
        assert_eq!(hit["status"], "contact");
        assert_eq!(hit["hazard_id"], "crush");
        assert_eq!(hit["damage_type"], "bludgeoning");
        assert_eq!(hit["expression"], "2d6");
        assert_eq!(hit["source"]["kind"], kind);
    }
    let state = native_wall(WallOptions::default());
    assert_eq!(status(&state, "со всего разбега врезаюсь в стену"), "contact");
    for text in ["не врезаюсь в стену", "касаюсь стены", "подхожу к стене", "врезаю нож в стену", "врезаюсь в стенного стража", "могу ли врезаться в стену?", "если я врежусь в стену", "хочу врезаться в стену", "врезаюсь в стену, чтобы проломить её"] {
        assert!(contact(&state, text).is_none(), "{text}");
    }
    let mut stale = native_wall(WallOptions { wall: false, edge_kind: Some("door"), ..WallOptions::default() });
    stale["scene"]["cells"] = json!([{ "x": 0, "y": 0, "type": "floor", "revealed": true }, { "x": 1, "y": 0, "type": "wall", "revealed": true }]);
    assert_eq!(status(&stale, "врезаюсь в стену"), "unavailable");
    assert_eq!(status(&native_wall(WallOptions { wall_x: 4, actor_x: 3, ..WallOptions::default() }), "врезаюсь в стену"), "contact");
    assert_eq!(status(&native_wall(WallOptions { wall_x: 2, ..WallOptions::default() }), "врезаюсь в стену"), "unavailable");
    assert_eq!(status(&native_wall(WallOptions { origin_revealed: false, ..WallOptions::default() }), "врезаюсь в стену"), "unavailable");
    assert_eq!(status(&native_wall(WallOptions { wall_revealed: false, ..WallOptions::default() }), "врезаюсь в стену"), "contact");
    assert_eq!(status(&legacy_wall(false), "врезаюсь в стену"), "unavailable");
}

// --- level-transition-phrase.test.mjs ----------------------------------------------------

#[test]
fn phrases_without_climbing_are_not_stairs() {
    let state = harbour();
    for text in ["Поднимаю упавшую кружку", "Спускаю собаку с поводка", "Иду к стойке", "Поднимаемся наверх по склону к замку", "Спускаемся вниз к реке"] {
        let result = fa::resolve_exploration_command(&state, "hero", text);
        let uses = result.as_ref().is_some_and(|result| {
            let commands = result.get("commands").and_then(Value::as_array).cloned().unwrap_or_else(|| vec![result["command"].clone()]);
            commands.iter().any(|command| command["command_type"] == "UseLevelTransition")
        });
        assert!(!uses, "{text}");
    }
    let none = fa::resolve_exploration_command(&state, "hero", "Поднимаемся по лестнице на второй этаж").expect("уточнение");
    assert_eq!(none["status"], "clarification");
    assert!(s(&none["narration"]).contains("Лестницы наверх"));
}

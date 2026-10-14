//! Сверка `scenario_attention` с эталоном JS (`fixtures/scenario-attention.json`,
//! генератор — `fixtures/gen-scenario-attention.mjs`): журналы кампании
//! Асстохана, собранные настоящим JS-движком, свёртка мусора, нормализация,
//! читатели состояния, текст сцены незнакомца и узнавание намерений. JSON
//! сравнивается строкой — вместе с порядком ключей.
//!
//! Ниже — проверки модуля из `test/scenario-attention.test.mjs` на тех же
//! журналах (сами команды Rules Engine здесь не переносятся).

use std::sync::LazyLock;

use serde::Serialize;
use serde_json::{json, Map, Value};
use sk_attention::scenario_attention::*;
use sk_core::js;

const FIXTURE: &str = include_str!("../fixtures/scenario-attention.json");
static DATA: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(FIXTURE).expect("эталон — JSON"));

fn table(name: &str) -> &'static Value {
    &DATA["tables"][name]
}

fn cases(name: &str) -> &'static [Value] {
    DATA[name].as_array().expect("массив случаев")
}

/// Подставить общий контекст кампании вместо `$concept` и `$map`.
fn expand(state: &Value) -> Value {
    let Some(map) = state.as_object() else {
        return state.clone();
    };
    let context = table("context");
    let mut result = Map::new();
    if map.contains_key("$concept") {
        result.insert("campaignConcept".into(), context["campaignConcept"].clone());
    }
    if map.contains_key("$map") {
        result.insert("worldMap".into(), context["worldMap"].clone());
    }
    for (key, value) in map {
        if key != "$concept" && key != "$map" {
            result.insert(key.clone(), value.clone());
        }
    }
    Value::Object(result)
}

fn text<T: Serialize>(value: T) -> String {
    serde_json::to_string(&value).expect("сериализация")
}

fn assert_same<T: Serialize>(actual: T, expected: &Value, what: impl Fn() -> String) {
    let actual = text(actual);
    let expected = text(expected);
    assert_eq!(actual, expected, "{}", what());
}

/// Состояние шага журнала: общий контекст и сцена шага.
fn chain_state(chain: &Value, step: &Value) -> Value {
    let mut state = chain["context"].as_object().cloned().unwrap_or_default();
    for key in ["scene", "partyMemberIds"] {
        if let Some(value) = step.get(key) {
            state.insert(key.into(), value.clone());
        }
    }
    Value::Object(state)
}

#[test]
fn constants_match_js() {
    let constants = &DATA["constants"];
    assert_eq!(constants["SCENARIO_ATTENTION_SCHEMA_VERSION"], json!(SCENARIO_ATTENTION_SCHEMA_VERSION));
    assert_eq!(constants["SCENARIO_ATTENTION_POLICY_ID"], json!(SCENARIO_ATTENTION_POLICY_ID));
    assert_eq!(constants["SCENARIO_COMMAND_TYPES"], json!(SCENARIO_COMMAND_TYPES));
    assert_eq!(constants["SCENARIO_TREATY_COMMAND_TYPES"], json!(SCENARIO_TREATY_COMMAND_TYPES));
    assert_eq!(constants["SCENARIO_TREATY_CONCLUDED_EVENT"], json!(SCENARIO_TREATY_CONCLUDED_EVENT));
    assert_eq!(constants["SCENARIO_TREATY_REFUSED_EVENT"], json!(SCENARIO_TREATY_REFUSED_EVENT));
    assert_eq!(constants["SCENARIO_PURSE_COMMAND_TYPES"], json!(SCENARIO_PURSE_COMMAND_TYPES));
    assert_eq!(constants["SCENARIO_PURSE_EVENT"], json!(SCENARIO_PURSE_EVENT));
    assert_eq!(constants["SCENARIO_ARMORY_COMMAND_TYPES"], json!(SCENARIO_ARMORY_COMMAND_TYPES));
    assert_eq!(constants["SCENARIO_ARMORY_EVENT"], json!(SCENARIO_ARMORY_EVENT));
    assert_eq!(constants["SCENARIO_INFORMANT_COMMAND_TYPES"], json!(SCENARIO_INFORMANT_COMMAND_TYPES));
    assert_eq!(constants["SCENARIO_INFORMANT_CHOICES"], json!(SCENARIO_INFORMANT_CHOICES));
    assert_eq!(constants["SCENARIO_INFORMANT_EVENT"], json!(SCENARIO_INFORMANT_EVENT));
    assert_eq!(constants["SCENARIO_INFORMANT_TURN_FAILED_EVENT"], json!(SCENARIO_INFORMANT_TURN_FAILED_EVENT));
    assert_eq!(constants["SCENARIO_INFORMANT_POLICY_ID"], json!(SCENARIO_INFORMANT_POLICY_ID));
    assert_eq!(constants["SCENARIO_ARMORY_POLICY_ID"], json!(SCENARIO_ARMORY_POLICY_ID));
    assert_eq!(constants["SCENARIO_STRANGER_STAGES"], json!(SCENARIO_STRANGER_STAGES));
    assert_eq!(constants["SCENARIO_STRANGER_EVENT"], json!(SCENARIO_STRANGER_EVENT));
    assert_eq!(constants["SCENARIO_STRANGER_EVENT_SCHEMA_VERSION"], json!(SCENARIO_STRANGER_EVENT_SCHEMA_VERSION));
}

/// Каждое событие журнала: реестр после свёртки совпадает с редьюсером JS.
#[test]
fn reducer_matches_js_journals_event_by_event() {
    let mut steps = 0;
    for chain in cases("chains") {
        let name = chain["name"].as_str().unwrap_or_default();
        for (index, step) in chain["steps"].as_array().expect("шаги").iter().enumerate() {
            let state = chain_state(chain, step);
            let actual = apply_scenario_attention_event(step.get("before"), step.get("event"), &state);
            assert_same(&actual, &step["after"], || format!("{name}, шаг {index}: {}", step["event"]["event_type"]));
            steps += 1;
        }
    }
    assert!(steps > 900, "шагов журнала: {steps}");
}

/// Журнал целиком: Rust сворачивает свои же выходы и приходит к реестру JS.
#[test]
fn reducer_replays_whole_journals() {
    for chain in cases("chains") {
        let name = chain["name"].as_str().unwrap_or_default();
        let mut ledger = chain["initial"].clone();
        for (index, step) in chain["steps"].as_array().expect("шаги").iter().enumerate() {
            ledger = apply_scenario_attention_event(Some(&ledger), step.get("event"), &chain_state(chain, step));
            assert_same(&ledger, &step["after"], || format!("{name}: после шага {index}"));
        }
        assert_same(&ledger, &chain["final"], || format!("{name}: итог журнала"));
    }
}

#[test]
fn reducer_matches_js_on_junk() {
    for (index, case) in cases("apply").iter().enumerate() {
        let state = expand(&case["state"]);
        let actual = apply_scenario_attention_event(case.get("ledger"), case.get("event"), &state);
        assert_same(&actual, &case["expected"], || format!("свёртка #{index}: {case}"));
    }
}

#[test]
fn normalization_matches_js_on_junk() {
    for (index, case) in cases("normalize").iter().enumerate() {
        let actual = normalize_scenario_attention_state(case.get("input"));
        assert_same(&actual, &case["expected"], || format!("нормализация #{index}: {}", case.get("input").map(Value::to_string).unwrap_or_default()));
        // Нормализация идемпотентна только по содержанию счёта: проверяем, что
        // повторная не падает и сохраняет схему.
        let again = normalize_scenario_attention_state(Some(&actual));
        assert_eq!(again["schema_version"], json!(1));
    }
}

fn opt<T: Serialize>(value: Option<T>) -> Value {
    value.map_or(Value::Null, |value| serde_json::to_value(value).expect("сериализация"))
}

#[test]
fn state_readers_match_js() {
    let enemy_lists: Vec<Vec<String>> = table("enemy_lists")
        .as_array()
        .expect("списки врагов")
        .iter()
        .map(|list| list.as_array().expect("список").iter().map(|id| js::string(Some(id))).collect())
        .collect();
    let viewers: Vec<String> = table("viewers").as_array().expect("зрители").iter().map(|id| js::s(Some(id))).collect();
    for case in cases("readers") {
        let label = case["label"].as_str().unwrap_or_default();
        let state = expand(&case["state"]);
        let expected = &case["expected"];
        assert_same(scenario_attention(&state), &expected["attention"], || format!("{label}: scenarioAttention"));
        assert_same(scenario_stranger_stage(&state), &expected["stranger_stage"], || format!("{label}: scenarioStrangerStage"));
        assert_same(scenario_stranger_npc_id(&state), &expected["stranger_npc_id"], || format!("{label}: scenarioStrangerNpcId"));
        assert_same(scenario_stranger_profile(&state, true), &expected["profile_available"], || format!("{label}: профиль"));
        assert_same(scenario_stranger_profile(&state, false), &expected["profile_unavailable"], || format!("{label}: профиль улетевшего"));
        assert_same(scenario_stranger_breath(&state), &expected["breath"], || format!("{label}: выдох"));
        for (index, enemy_ids) in enemy_lists.iter().enumerate() {
            let actual = opt(scenario_finale_tactics(&state, enemy_ids).map(|tactics| tactics.to_value()));
            assert_same(&actual, &expected["finale"][index], || format!("{label}: финал для {enemy_ids:?}"));
        }
        for (index, viewer) in viewers.iter().enumerate() {
            assert_same(opt(scenario_court_for_viewer(&state, viewer)), &expected["court"][index], || format!("{label}: двор для «{viewer}»"));
        }
    }
}

#[test]
fn stranger_narration_matches_js() {
    for (index, case) in cases("narration").iter().enumerate() {
        let state = expand(&case["state"]);
        let actual = scenario_stranger_narration(case.get("events").filter(|events| events.is_array()), &state);
        assert_eq!(actual, case["expected"].as_str().expect("текст"), "текст #{index}");
    }
}

#[test]
fn topic_detection_matches_js() {
    let configs = table("topic_configs").as_array().expect("настройки темы");
    for case in cases("topic") {
        let config = &configs[case["config"].as_u64().expect("индекс") as usize];
        let actual = mentions_scenario_topic(Some(config).filter(|config| !config.is_null()), case.get("text"));
        assert_eq!(Value::Bool(actual), case["expected"], "тема: {case}");
    }
}

#[test]
fn treaty_detection_matches_js() {
    let states: Vec<Value> = table("treaty_states").as_array().expect("состояния").iter().map(expand).collect();
    for case in cases("treaty") {
        let state = &states[case["state"].as_u64().expect("индекс") as usize];
        let actual = scenario_treaty_action_from_text(&js::s(case.get("text")), Some(state).filter(|state| !state.is_null()));
        assert_same(actual, &case["expected"], || format!("договор: {case}"));
    }
}

#[test]
fn purse_detection_matches_js() {
    for case in cases("purse") {
        assert_same(scenario_purse_action_from_text(&js::s(case.get("text"))), &case["expected"], || format!("кошель: {case}"));
    }
}

#[test]
fn informant_detection_matches_js() {
    let lists = table("informant_lists").as_array().expect("списки");
    for case in cases("informant") {
        let informants = lists[case["informants"].as_u64().expect("индекс") as usize].as_array().expect("осведомители");
        let actual = scenario_informant_action_from_text(&js::s(case.get("text")), informants);
        assert_same(actual, &case["expected"], || format!("осведомитель: {case}"));
    }
}

#[test]
fn armory_detection_matches_js() {
    let lists = table("choice_lists").as_array().expect("списки");
    for case in cases("armory") {
        let choices = lists[case["choices"].as_u64().expect("индекс") as usize].as_array().expect("вещи");
        let actual = scenario_armory_action_from_text(&js::s(case.get("text")), choices);
        assert_same(actual, &case["expected"], || format!("оружейная: {case}"));
    }
}

// ---------------------------------------------------------------------------
// Проверки модуля из `test/scenario-attention.test.mjs`

fn chain(name: &str) -> &'static Value {
    cases("chains").iter().find(|chain| chain["name"] == name).expect("журнал")
}

/// Состояние кампании Асстохана в месте `location_id` с реестром `ledger`.
fn state_at(location_id: &str, ledger: Value) -> Value {
    let mut state = table("context").clone();
    state["scene"] = json!({ "location_id": location_id });
    state["partyMemberIds"] = json!(["attention-hero"]);
    state["scenario_attention"] = ledger;
    state
}

fn conversation(npc_id: &str, message: &str, skill: Option<&str>) -> Value {
    let mut conversation = json!({ "npc_id": npc_id, "player_message": message });
    if let Some(skill) = skill {
        conversation["check"] = json!({ "skill": skill });
    }
    json!({ "event_id": format!("ev-{message}"), "event_type": "NpcConversationRecorded", "actor_id": "attention-hero", "payload": { "conversation": conversation } })
}

#[test]
fn questions_raise_attention_once_per_visit_only_in_watched_places() {
    let ledger = normalize_scenario_attention_state(None);
    let watch = state_at("astohan-ash-watch", ledger.clone());
    let after = apply_scenario_attention_event(Some(&ledger), Some(&conversation("villager", "Что вы знаете о драконе?", None)), &watch);
    assert_eq!(after["value"], json!(0), "на заставе осведомителей нет");

    let redstone = state_at("astohan-redstone", ledger.clone());
    let bread = apply_scenario_attention_event(Some(&ledger), Some(&conversation("villager", "Где здесь можно купить хлеба?", None)), &redstone);
    assert_eq!(bread["value"], json!(0), "вопрос не о драконе");
    let first = apply_scenario_attention_event(Some(&bread), Some(&conversation("villager", "Расскажите про Саргата, куда он летает?", None)), &redstone);
    assert_eq!(first["value"], json!(1));
    let second = apply_scenario_attention_event(Some(&first), Some(&conversation("villager", "А драконье логово далеко?", None)), &redstone);
    assert_eq!(second["value"], json!(1), "одна деревня за визит — один слух");
    let moved = apply_scenario_attention_event(Some(&second), Some(&json!({ "event_type": "SceneAdvanced" })), &redstone);
    let third = apply_scenario_attention_event(Some(&moved), Some(&conversation("villager", "Видели дракона в последние дни?", None)), &redstone);
    assert_eq!(third["value"], json!(2), "новый визит — новый слух");
    let reasons: Vec<&Value> = third["history"].as_array().expect("история").iter().map(|entry| &entry["reason"]).collect();
    assert_eq!(reasons, [&json!("questions"), &json!("questions")]);

    // Журнал JS той же сцены: тот же счёт.
    assert_eq!(chain("ATT-Q")["final"]["history"][0]["reason"], json!("questions"));
}

#[test]
fn quiet_skills_and_the_stranger_himself_do_not_raise_attention() {
    let ledger = normalize_scenario_attention_state(None);
    let mittlayd = state_at("astohan-mittlayd", ledger.clone());
    let quiet = apply_scenario_attention_event(Some(&ledger), Some(&conversation("villager", "Где видели дракона?", Some("deception"))), &mittlayd);
    assert_eq!(quiet["value"], json!(0), "под видом торговца — тихое расследование");
    let ruling = |skill: &str| {
        json!({ "event_id": format!("ruling-{skill}"), "event_type": "RulingRecorded", "payload": { "ruling": {
            "question": "Выспрашиваю у перевозчиков, где видели дракона", "interpretation": { "activity_kind": "social", "skill": skill },
        } } })
    };
    assert_eq!(apply_scenario_attention_event(Some(&ledger), Some(&ruling("stealth")), &mittlayd)["value"], json!(0));
    assert_eq!(apply_scenario_attention_event(Some(&ledger), Some(&ruling("persuasion")), &mittlayd)["value"], json!(1));
    let stranger = apply_scenario_attention_event(Some(&ledger), Some(&conversation("astohan-ash-stranger", "Мы ищем дракона", None)), &mittlayd);
    assert_eq!(stranger["value"], json!(0), "разговор с самим незнакомцем счёт не поднимает");
}

#[test]
fn a_fight_in_a_watched_settlement_adds_two_and_the_stranger_comes_at_three() {
    let ledger = json!({ "value": 1 });
    let redstone = state_at("astohan-redstone", ledger.clone());
    let fight = json!({ "event_id": "ev-fight", "event_type": "EncounterCreated", "payload": { "encounter": { "id": "encounter-1" } } });
    let after = apply_scenario_attention_event(Some(&ledger), Some(&fight), &redstone);
    assert_eq!(after["value"], json!(3));
    assert_eq!(after["history"][0]["reason"], json!("fight"));
    let mut state = redstone.clone();
    state["scenario_attention"] = after.clone();
    assert_eq!(scenario_stranger_stage(&state), Some("arrive"));
    let mut fighting = state.clone();
    fighting["mechanics"] = json!({ "combat": { "active": true } });
    assert_eq!(scenario_stranger_stage(&fighting), None, "посреди боя незнакомец не приходит");

    let arrived = apply_scenario_attention_event(
        Some(&after),
        Some(&json!({ "event_type": SCENARIO_STRANGER_EVENT, "payload": { "stage": "arrived", "location_id": "astohan-redstone" } })),
        &state,
    );
    state["scenario_attention"] = arrived.clone();
    assert_eq!(scenario_stranger_stage(&state), None, "пока отряд при нём ничего не сделал, он не раскрывается");
    let acted = apply_scenario_attention_event(Some(&arrived), Some(&json!({ "event_type": "ActorMoved", "actor_id": "attention-hero" })), &state);
    assert_eq!(acted["stranger"]["party_acted"], json!(true));
    state["scenario_attention"] = acted;
    assert_eq!(scenario_stranger_stage(&state), Some("reveal"));
    let profile = scenario_stranger_profile(&state, true).expect("профиль");
    assert_eq!(profile["name"], json!("Незнакомец в пепельном плаще"), "имени дракона у незнакомца нет");
    assert_eq!(profile["location_id"], json!("astohan-redstone"));
    assert_eq!(scenario_stranger_breath(&state), Some(json!({ "expression": "8d6", "ability": "dex", "dc": 17, "damage_type": "fire" })));
}

#[test]
fn reveal_narration_reports_every_save_from_the_rolls() {
    let reveal = cases("narration")
        .iter()
        .find(|case| case["expected"].as_str().is_some_and(|text| text.contains("Ирма: спасбросок Ловкости") && text.contains("Олвин: спасбросок")))
        .expect("выдох в журнале");
    let text = scenario_stranger_narration(reveal.get("events"), &expand(&reveal["state"]));
    assert!(text.contains("Саргат"));
    assert!(text.contains("Ирма: спасбросок Ловкости ") && text.contains(" против СЛ 17 — "), "{text}");
    assert!(text.contains(" урона огнём."), "{text}");
    assert!(text.contains("Не ищите меня"));
}

#[test]
fn finale_tactics_follow_the_attention_count() {
    let boss = ["astohan-sargat".to_string()];
    let lair = |value: i64, came_from: &str| {
        let mut state = state_at("astohan-vulkanis-brazier", json!({ "value": value }));
        state["adventure"] = json!({ "history": [{ "location_id": came_from }] });
        state
    };
    let ready = scenario_finale_tactics(&lair(6, "astohan-obsidian-pass"), &boss).expect("готовый дракон");
    assert_eq!(ready.to_value(), json!({ "readiness": "ready", "surprise": "none", "ambush": { "theme": "warband", "difficulty": "medium" }, "reason": "attention-ready" }));
    let unaware = scenario_finale_tactics(&lair(0, "astohan-obsidian-pass"), &boss).expect("беспечный дракон");
    assert_eq!(unaware.reason, "attention-low");
    assert_eq!(scenario_finale_tactics(&lair(4, "astohan-obsidian-pass"), &boss), None, "перевалом при счёте 4 — ни готов, ни беспечен");
    let tunnel = scenario_finale_tactics(&lair(4, "astohan-smugglers-cave"), &boss).expect("тайный ход");
    assert_eq!(tunnel.to_value(), json!({ "readiness": "unaware", "surprise": "enemies", "ambush": null, "reason": "hidden-route" }));
    assert_eq!(scenario_finale_tactics(&lair(0, "astohan-obsidian-pass"), &["astohan-ash-goblin".to_string()]), None, "без Саргата тактика не применяется");
    assert_eq!(scenario_finale_tactics(&state_at("astohan-redstone", json!({ "value": 0 })), &boss), None, "вне логова — обычный бой");
}

#[test]
fn informants_resolve_once_with_attention_steps_from_scenario_data() {
    let ledger = normalize_scenario_attention_state(None);
    let redstone = state_at("astohan-redstone", ledger.clone());
    let exposed = apply_scenario_attention_event(
        Some(&ledger),
        Some(&json!({ "event_id": "ev-expose", "event_type": SCENARIO_INFORMANT_EVENT, "payload": { "informant_id": "toban", "outcome": "expose", "location_id": "astohan-redstone" } })),
        &redstone,
    );
    assert_eq!(exposed["value"], json!(2), "поимка при людях — +2");
    assert_eq!(exposed["informants"], json!({ "toban": "expose" }));
    let turned = apply_scenario_attention_event(
        Some(&json!({ "value": 3 })),
        Some(&json!({ "event_type": SCENARIO_INFORMANT_EVENT, "payload": { "informant_id": "ferryman", "outcome": "turn" } })),
        &redstone,
    );
    assert_eq!(turned["value"], json!(2), "перевербованный шлёт дракону ложь");
    let released = apply_scenario_attention_event(
        Some(&json!({ "value": 3 })),
        Some(&json!({ "event_type": SCENARIO_INFORMANT_EVENT, "payload": { "informant_id": "ferryman", "outcome": "release" } })),
        &redstone,
    );
    assert_eq!(released["value"], json!(3), "отпущенный счёт не меняет");
    let failed = apply_scenario_attention_event(None, Some(&json!({ "event_type": SCENARIO_INFORMANT_TURN_FAILED_EVENT, "payload": { "informant_id": "ferryman" } })), &redstone);
    assert_eq!(failed["informant_turn_failed"], json!(["ferryman"]));
}

#[test]
fn court_card_shows_only_what_the_hero_can_still_take() {
    let mut state = state_at("astohan-stormberg", json!({ "purse_paid": ["attention-hero"] }));
    let court = scenario_court_for_viewer(&state, "attention-hero").expect("двор");
    assert!(!court.purse_available, "кошель уже получен");
    assert!(court.armory_available);
    assert!(court.armory_items.iter().any(|name| name.contains("Плащ защиты")), "{:?}", court.armory_items);
    assert!(scenario_court_for_viewer(&state, "attention-mage").expect("двор").purse_available);
    assert!(!scenario_court_for_viewer(&state, "").expect("двор").purse_available, "без героя-зрителя ничего не ждёт");
    state["scene"] = json!({ "location_id": "astohan-redstone" });
    let away = scenario_court_for_viewer(&state, "attention-mage").expect("двор");
    assert!(!away.purse_available && !away.armory_available && away.armory_items.is_empty());
    assert_eq!(scenario_court_for_viewer(&json!({}), "attention-hero"), None, "кампания без сценария");
}

#[test]
fn intents_are_recognized_in_player_text() {
    let lair = state_at("astohan-vulkanis-brazier", json!({}));
    assert_eq!(scenario_treaty_action_from_text("Предлагаю Саргату договор", Some(&lair)), Some(json!({ "action": "treaty" })));
    assert_eq!(scenario_treaty_action_from_text("Будет ли мир с драконом?", Some(&state_at("astohan-redstone", json!({})))), None, "в деревне это вопрос жителю");
    assert_eq!(scenario_treaty_action_from_text("убеждаю дракона уйти", None), Some(json!({ "action": "treaty" })));
    assert_eq!(scenario_purse_action_from_text("Берём кошель короля"), Some(json!({ "action": "purse" })));
    assert_eq!(scenario_purse_action_from_text("Берём кошель"), None);
    let informants = vec![json!({ "id": "toban", "name_stems": ["тобан", "мельник"] })];
    assert_eq!(scenario_informant_action_from_text("Выдаём Тобана страже", &informants), Some(json!({ "action": "informant", "informant_id": "toban", "choice": "expose" })));
    assert_eq!(scenario_informant_action_from_text("Перевербовываю мельника", &informants).expect("решение")["choice"], json!("turn"));
    assert_eq!(scenario_informant_action_from_text("Отпускаем Ларса", &informants), None);
    let choices = vec![json!({ "catalog_id": "cloak", "name": "Плащ защиты" }), json!({ "catalog_id": "brooch", "name": "Брошь защиты" })];
    assert_eq!(scenario_armory_action_from_text("Беру плащ защиты из оружейной", &choices), Some(json!({ "action": "armory", "catalog_id": "cloak" })));
    assert_eq!(scenario_armory_action_from_text("Беру что-нибудь в оружейной", &choices), Some(json!({ "action": "armory", "catalog_id": null })));
    assert_eq!(scenario_armory_action_from_text("Беру плащ", &choices), None, "без оружейной это не выбор вещи");
}

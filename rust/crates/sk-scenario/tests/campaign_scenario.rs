//! Сверка `campaign_scenario` с эталоном JS (`fixtures/campaign-scenario.json`,
//! генератор — `fixtures/gen-campaign-scenario.mjs`) и перенесённые проверки
//! каталога из `test/campaign-scenario.test.mjs`.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use serde_json::{json, Map, Value};
use sk_scenario::campaign_scenario::*;

const FIXTURE: &str = include_str!("../fixtures/campaign-scenario.json");
const WORLDS: &str = include_str!("../../../../data/campaign-worlds-v1.json");
const BOSS: &str = "astohan-sargat";

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("эталон — JSON")
}

fn to_value<T: Serialize>(value: T) -> Value {
    serde_json::to_value(value).expect("сериализация")
}

fn opt<T: Serialize>(value: Option<T>) -> Value {
    value.map_or(Value::Null, to_value)
}

/// `{ ...a, ...b }` над объектами-состояниями, как генератор складывает случай.
fn spread(base: &Value, patch: &Value) -> Value {
    let mut result = base.as_object().cloned().unwrap_or_default();
    for (key, value) in patch.as_object().into_iter().flatten() {
        result.insert(key.clone(), value.clone());
    }
    Value::Object(result)
}

fn without(value: Value, keys: &[&str]) -> Value {
    match value {
        Value::Object(mut map) => {
            for key in keys {
                map.shift_remove(*key);
            }
            Value::Object(map)
        }
        other => other,
    }
}

fn replace(value: &mut Value, key: &str, make: impl FnOnce(&Value) -> Value) {
    if let Some(slot) = value.get_mut(key) {
        let next = make(slot);
        *slot = next;
    }
}

fn progress_digest(progress: Value) -> Value {
    let mut digest = without(progress, &["scenario_id", "scenario_version", "boss"]);
    if digest.is_null() {
        return digest;
    }
    replace(&mut digest, "beats", |beats| {
        Value::Array(beats.as_array().into_iter().flatten().map(|beat| json!([beat["id"], beat["completed"]])).collect())
    });
    replace(&mut digest, "clues", |clues| {
        Value::Array(clues.as_array().into_iter().flatten().map(|clue| json!([clue["id"], clue["found"]])).collect())
    });
    digest
}

fn director_digest(mut brief: Value) -> Value {
    replace(&mut brief, "beats", |beats| Value::Array(beats.as_array().into_iter().flatten().map(|beat| beat["completed"].clone()).collect()));
    brief
}

fn informant_digest(list: Vec<Value>) -> Value {
    Value::Array(list.iter().map(|entry| json!({ "id": entry["id"], "revealed": entry["revealed"] })).collect())
}

fn treaty_digest(treaty: Option<Value>) -> Value {
    treaty.map_or(Value::Null, |treaty| json!({ "truth_revealed": treaty["truth_revealed"], "concluded": treaty["concluded"] }))
}

fn reveal_digest(result: &Value, input: &Value) -> Value {
    if result == input {
        return json!({ "same": true });
    }
    let Value::Object(map) = result else {
        return json!({ "value": result });
    };
    let changed = |key: &str, flag: &str| -> Value {
        let before = input.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
        let after = map.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
        Value::Array(
            after
                .iter()
                .enumerate()
                .filter(|(index, entry)| before.get(*index) != Some(entry))
                .map(|(index, entry)| json!([index, entry.get(flag).cloned().unwrap_or(Value::Null)]))
                .collect(),
        )
    };
    json!({
        "keys": map.keys().cloned().collect::<Vec<_>>(),
        "locations": changed("locations", "known"),
        "routes": changed("routes", "discovered"),
    })
}

struct Diff {
    checked: usize,
    failures: Vec<String>,
}

impl Diff {
    fn new() -> Self {
        Self { checked: 0, failures: Vec::new() }
    }

    fn check(&mut self, what: &str, input: &str, actual: Value, expected: &Value) {
        if expected.get("throws").is_some() {
            return;
        }
        self.checked += 1;
        let same = actual == *expected && serde_json::to_string(&actual).ok() == serde_json::to_string(expected).ok();
        if !same {
            self.failures.push(format!("{what} [{input}]:\n    rust: {actual}\n    js:   {expected}"));
        }
    }

    fn finish(self, label: &str) {
        let shown: Vec<&String> = self.failures.iter().take(30).collect();
        assert!(
            self.failures.is_empty(),
            "{label}: расхождений с JS {} из {}:\n{}",
            self.failures.len(),
            self.checked,
            shown.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("\n")
        );
        eprintln!("{label}: сверено {} значений", self.checked);
    }
}

#[test]
fn states_match_js() {
    let data = fixture();
    let bases = data["bases"].as_array().expect("состояния");
    let mut diff = Diff::new();
    for (index, case) in data["cases"].as_array().expect("случаи").iter().enumerate() {
        let state = spread(&bases[case["base"].as_u64().expect("индекс") as usize], &case["patch"]);
        let full = case["full"].as_bool().unwrap_or(false);
        let out = &case["out"];
        let tag = format!("случай {index}, основа {}", case["base"]);
        let progress = opt(scenario_progress(&state));
        let director = opt(scenario_director_brief(&state));
        let narrator = opt(scenario_narrator_brief(&state));
        let world_map = state.get("worldMap").cloned().unwrap_or(Value::Null);
        let revealed = apply_scenario_map_reveals(&state, &world_map);
        let checks: Vec<(&str, Value)> = vec![
            ("scenario_id", campaign_scenario(&state).map_or(Value::Null, |scenario| scenario["id"].clone())),
            ("location_id", json!(scenario_location_id(&state))),
            ("previous_location_id", json!(scenario_previous_location_id(&state))),
            ("progress", if full { progress } else { progress_digest(progress) }),
            ("phase", json!(scenario_phase(&state))),
            ("destinations", json!(scenario_destination_ids(&state))),
            ("encounter_for", opt(scenario_encounter_for(&state))),
            ("ending", opt(scenario_ending(&state))),
            ("narrator", if full { narrator } else { without(narrator, &["campaign", "premise"]) }),
            ("director", if full { director } else { director_digest(director) }),
            ("milestone", json!(scenario_milestone_level(&state))),
            ("informants", informant_digest(scenario_informant_rules(&state))),
            ("treaty", treaty_digest(scenario_treaty_rules(&state))),
            ("end_reason", json!(scenario_encounter_end_reason(&state))),
            ("boss_morale", opt(scenario_boss_morale(&state, BOSS))),
            ("other_morale", opt(scenario_boss_morale(&state, "astohan-lomar"))),
            ("attention_ready", json!(scenario_attention_ready(&state))),
            ("found_clue_ids", json!(scenario_found_clue_ids(&state).into_iter().collect::<Vec<_>>())),
            ("reveals", reveal_digest(&revealed, &world_map)),
        ];
        for (what, actual) in checks {
            diff.check(what, &tag, actual, &out[what]);
        }
        if let Some(expected) = out.get("reveals_full") {
            diff.check("reveals_full", &tag, revealed.clone(), expected);
        }
        for entry in out.get("scene_args").and_then(Value::as_array).into_iter().flatten() {
            diff.check("scene_args", &format!("{tag}, {}", entry["args"]), scenario_scene_args(&state, &entry["args"]), &entry["result"]);
        }
    }
    diff.finish("состояния кампании");
}

#[test]
fn cards_rules_and_constants_match_js() {
    let data = fixture();
    let bases = data["bases"].as_array().expect("состояния");
    let (scenario_state, free_state) = (&bases[0], &bases[1]);
    let scenario = &list_campaign_scenarios()[0];
    let mut diff = Diff::new();
    diff.check("arc_version", "", json!(SCENARIO_ARC_VERSION), &data["arc_version"]);
    diff.check("arc_preset", "", json!(SCENARIO_ARC_PRESET), &data["arc_preset"]);
    diff.check("arc_plan", "", build_scenario_arc_plan(scenario), &data["arc_plan"]);
    diff.check("clue_fact_id", "", json!(scenario_clue_fact_id(scenario, "ash-gate")), &data["clue_fact_id"]);
    for rule in data["rules"].as_array().expect("правила") {
        let state = &bases[rule["base"].as_u64().expect("индекс") as usize];
        let tag = format!("основа {}", rule["base"]);
        diff.check("purse", &tag, opt(scenario_purse_rules(state)), &rule["purse"]);
        diff.check("armory", &tag, opt(scenario_armory_rules(state)), &rule["armory"]);
        diff.check("informants", &tag, json!(scenario_informant_rules(state)), &rule["informants"]);
        diff.check("treaty", &tag, opt(scenario_treaty_rules(state)), &rule["treaty"]);
    }
    for card in data["cards"].as_array().expect("карточки") {
        let id = card["id"].as_str().unwrap_or("");
        diff.check("npcs", id, json!(scenario_location_npcs(scenario_state, id)), &card["npcs"]);
        diff.check("npcs_free", id, json!(scenario_location_npcs(free_state, id)), &card["npcs_free"]);
        diff.check("secrets", id, json!(scenario_secrets_for(scenario_state, id)), &card["secrets"]);
        diff.check("secrets_free", id, json!(scenario_secrets_for(free_state, id)), &card["secrets_free"]);
    }
    for reward in data["rewards"].as_array().expect("награды") {
        let fact_id = reward["fact_id"].as_str().unwrap_or("");
        diff.check("reward", fact_id, json!(scenario_clue_reward_catalog_id(scenario_state, fact_id)), &reward["catalog_id"]);
        diff.check("reward_free", fact_id, json!(scenario_clue_reward_catalog_id(free_state, fact_id)), &reward["catalog_id_free"]);
    }
    for holder in data["holders"].as_array().expect("хранители") {
        let npc_id = holder["npc_id"].as_str().unwrap_or("");
        diff.check("known_by", npc_id, json!(scenario_clue_fact_ids_known_by(Some(scenario), npc_id)), &holder["fact_ids"]);
        diff.check("known_by_null", npc_id, json!(scenario_clue_fact_ids_known_by(None, npc_id)), &holder["fact_ids_null"]);
    }
    for template in data["templates"].as_array().expect("миры") {
        let id = template["id"].as_str().unwrap_or("");
        let found = scenario_for_world_template(id).map_or(Value::Null, |scenario| scenario["id"].clone());
        diff.check("for_world_template", id, found, &template["scenario_id"]);
    }
    for entry in data["scene_args_odd"].as_array().expect("аргументы") {
        let args = &entry["args"];
        diff.check("scene_args", &args.to_string(), scenario_scene_args(scenario_state, args), &entry["result"]);
        diff.check("scene_args_free", &args.to_string(), scenario_scene_args(free_state, args), &entry["result_free"]);
    }
    diff.finish("карточки и правила");
}

#[test]
fn catalog_is_the_data_file() {
    let raw: Value = serde_json::from_str(include_str!("../../../../data/campaign-scenarios-v1.json")).expect("каталог");
    assert_eq!(list_campaign_scenarios(), raw["scenarios"].as_array().expect("сценарии").as_slice());
}

/// `сценарий Асстохана ссылается только на места и NPC своего мира`.
#[test]
fn astohan_scenario_refers_to_its_world() {
    let worlds: Value = serde_json::from_str(WORLDS).expect("миры");
    let scenarios = list_campaign_scenarios();
    assert_eq!(scenarios.len(), 1);
    let scenario = &scenarios[0];
    let template = worlds["templates"]
        .as_array()
        .expect("шаблоны")
        .iter()
        .find(|template| template["id"] == scenario["world_template_id"])
        .expect("мир сценария");
    let locations: HashMap<&str, &Value> =
        template["world_map"]["locations"].as_array().expect("места").iter().map(|location| (location["id"].as_str().unwrap_or(""), location)).collect();
    let npcs: HashMap<&str, &Value> =
        template["opening"]["npcs"].as_array().expect("NPC").iter().map(|npc| (npc["id"].as_str().unwrap_or(""), npc)).collect();
    let cards = scenario["locations"].as_array().expect("карточки");
    for card in cards {
        assert!(locations.contains_key(card["location_id"].as_str().unwrap_or("")), "{}", card["location_id"]);
    }
    assert_eq!(cards.len(), locations.len(), "у каждого места мира есть карточка сцены");
    let beats = scenario["beats"].as_array().expect("узлы");
    for beat in beats {
        for location_id in beat["location_ids"].as_array().expect("места узла") {
            assert!(locations.contains_key(location_id.as_str().unwrap_or("")), "{}: {location_id}", beat["id"]);
        }
    }
    let finale = beats.iter().find(|beat| beat["kind"] == "finale").expect("финал");
    let boss = npcs.get(finale["boss"]["npc_id"].as_str().unwrap_or("")).expect("главный противник в мире");
    assert!(boss.get("mechanics").is_some_and(|mechanics| !mechanics.is_null()), "у главного противника есть боевой лист");
    assert_eq!(boss["location"], locations[finale["boss"]["location_id"].as_str().unwrap_or("")]["name"]);
    let text = serde_json::to_string(beats).expect("узлы");
    for (index, _) in text.match_indices("\"npc_defeated\":\"") {
        let rest = &text[index + "\"npc_defeated\":\"".len()..];
        let id = &rest[..rest.find('"').unwrap_or(0)];
        assert!(npcs.contains_key(id), "{id}");
    }
    let mut endings: Vec<&str> = scenario["endings"].as_array().expect("развязки").iter().filter_map(|ending| ending["id"].as_str()).collect();
    endings.sort_unstable();
    assert_eq!(endings, ["banished", "defeat", "slain", "treaty"]);
    let roads: HashSet<String> = template["world_map"]["routes"]
        .as_array()
        .expect("дороги")
        .iter()
        .map(|route| {
            let mut pair = [route["from"].as_str().unwrap_or(""), route["to"].as_str().unwrap_or("")];
            pair.sort_unstable();
            pair.join(":")
        })
        .collect();
    for reveal in scenario["map_reveals"].as_array().expect("открытия") {
        for route in reveal["routes"].as_array().expect("дороги открытия") {
            let mut pair: Vec<&str> = route.as_array().expect("пара").iter().filter_map(Value::as_str).collect();
            pair.sort_unstable();
            assert!(roads.contains(&pair.join(":")), "{}: дорога {route} есть на карте мира", reveal["id"]);
        }
    }
}

/// Кампания по сценарию — по арке `scenario-arc-v1`; без арки сценария нет.
#[test]
fn scenario_follows_campaign_arc() {
    let mut arc = Map::new();
    arc.insert("version".into(), json!(SCENARIO_ARC_VERSION));
    arc.insert("scenario_id".into(), json!("astohan-dragon-hunt"));
    arc.insert("scenario_version".into(), json!(1));
    let state = json!({ "campaignConcept": { "arc": arc }, "scene": { "location_id": "astohan-stormberg" } });
    let progress = scenario_progress(&state).expect("сюжет");
    assert_eq!(progress.scenario_id, "astohan-dragon-hunt");
    assert!(!progress.beats.iter().find(|beat| beat.id == "prologue").expect("пролог").completed);
    assert_eq!(scenario_phase(&state), Some("breather"));
    assert_eq!(scenario_progress(&json!({ "campaignConcept": { "arc": { "version": "other" } } })), None);
}

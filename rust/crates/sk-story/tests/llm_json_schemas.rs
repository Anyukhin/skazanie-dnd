//! Паритет `llm_json_schemas` с `server/llm-json-schemas.mjs`: схемы байт в
//! байт (`fixtures/llm-json-schemas.json`), плюс проверки
//! `test/llm-json-schemas.test.mjs`, касающиеся самих схем.

use serde_json::{json, Value};
use sk_core::js;
use sk_encounters::encounter_assembler::{ENCOUNTER_DIFFICULTIES, ENCOUNTER_THEMES};
use sk_story::llm_json_schemas as s;
use sk_world_story::autonomous_campaign::{normalize_director_intent, DIRECTOR_INTENT_TYPES};

const FIXTURE: &str = include_str!("../fixtures/llm-json-schemas.json");

fn all_schemas() -> [&'static Value; 4] {
    [&s::DIRECTOR_INTENT_JSON_SCHEMA, &s::NPC_SOCIAL_RESPONSE_JSON_SCHEMA, &s::CAMPAIGN_CREATION_JSON_SCHEMA, &s::HERO_HOOKS_JSON_SCHEMA]
}

#[test]
fn schemas_match_js_byte_for_byte() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("эталон");
    let list = |values: &[&str]| json!(values);
    let actual = [
        ("DIRECTOR_SCENE_RESOLUTIONS", list(&s::DIRECTOR_SCENE_RESOLUTIONS)),
        ("DIRECTOR_INTENT_JSON_SCHEMA", s::DIRECTOR_INTENT_JSON_SCHEMA.clone()),
        ("NPC_SOCIAL_STANCES", list(&s::NPC_SOCIAL_STANCES)),
        ("NPC_PROMISE_DIRECTIONS", list(&s::NPC_PROMISE_DIRECTIONS)),
        ("NPC_SOCIAL_RESPONSE_JSON_SCHEMA", s::NPC_SOCIAL_RESPONSE_JSON_SCHEMA.clone()),
        ("CAMPAIGN_CREATION_JSON_SCHEMA", s::CAMPAIGN_CREATION_JSON_SCHEMA.clone()),
        ("HERO_HOOKS_JSON_SCHEMA", s::HERO_HOOKS_JSON_SCHEMA.clone()),
    ];
    assert_eq!(fixture.as_object().map(|map| map.len()), Some(actual.len()));
    for (name, value) in actual {
        assert_eq!(js::stringify(&value), fixture[name].as_str().unwrap_or(""), "{name}");
    }
}

/// Узлы-объекты схемы с путями.
fn object_nodes<'a>(schema: &'a Value, path: String, out: &mut Vec<(String, &'a Value)>) {
    let types = match &schema["type"] {
        Value::Array(items) => items.clone(),
        other => vec![other.clone()],
    };
    if types.contains(&json!("object")) {
        out.push((path.clone(), schema));
    }
    if let Some(properties) = schema["properties"].as_object() {
        for (key, child) in properties {
            object_nodes(child, format!("{path}.{key}"), out);
        }
    }
    if schema.get("items").is_some() {
        object_nodes(&schema["items"], format!("{path}[]"), out);
    }
}

fn all_nodes<'a>(schema: &'a Value, out: &mut Vec<&'a Value>) {
    out.push(schema);
    if let Some(properties) = schema["properties"].as_object() {
        for child in properties.values() {
            all_nodes(child, out);
        }
    }
    if schema.get("items").is_some() {
        all_nodes(&schema["items"], out);
    }
}

#[test]
fn every_schema_follows_strict_mode() {
    for entry in all_schemas() {
        let name = entry["name"].as_str().unwrap_or("");
        assert_eq!(entry["strict"], json!(true), "{name}");
        assert_eq!(entry["schema"]["type"], json!("object"), "{name}");
        let mut objects = Vec::new();
        object_nodes(&entry["schema"], "$".into(), &mut objects);
        for (path, node) in objects {
            assert_eq!(node["additionalProperties"], json!(false), "{name} {path}");
            let mut required: Vec<String> = node["required"].as_array().into_iter().flatten().filter_map(|key| key.as_str().map(str::to_string)).collect();
            let mut keys: Vec<String> = node["properties"].as_object().into_iter().flat_map(|map| map.keys().cloned()).collect();
            required.sort();
            keys.sort();
            assert_eq!(required, keys, "{name} {path}");
        }
        let mut nodes = Vec::new();
        all_nodes(&entry["schema"], &mut nodes);
        for node in nodes {
            for keyword in ["pattern", "anyOf", "oneOf", "allOf", "minimum", "maximum", "$ref", "format"] {
                assert!(node.get(keyword).is_none(), "{name}: {keyword}");
            }
        }
    }
}

fn with_null(values: &[&str]) -> Value {
    let mut list: Vec<Value> = values.iter().map(|value| json!(value)).collect();
    list.push(Value::Null);
    Value::Array(list)
}

fn director_sample(overrides: Value) -> Value {
    let mut sample = json!({
        "type": "continue_exploration", "theme": null, "difficulty": null, "quest_id": null, "npc_id": null,
        "hook": null, "destination": null, "resolution": null, "reason": null,
    });
    if let (Some(map), Some(patch)) = (sample.as_object_mut(), overrides.as_object()) {
        for (key, value) in patch {
            map.insert(key.clone(), value.clone());
        }
    }
    sample
}

#[test]
fn director_schema_lists_exactly_validator_allowlists() {
    let properties = &s::DIRECTOR_INTENT_JSON_SCHEMA["schema"]["properties"];
    assert_eq!(properties["type"]["enum"], json!(DIRECTOR_INTENT_TYPES));
    assert_eq!(properties["theme"]["enum"], with_null(&ENCOUNTER_THEMES));
    assert_eq!(properties["difficulty"]["enum"], with_null(&ENCOUNTER_DIFFICULTIES));
    assert_eq!(properties["resolution"]["enum"], with_null(&s::DIRECTOR_SCENE_RESOLUTIONS));
    for theme in ENCOUNTER_THEMES {
        for difficulty in ENCOUNTER_DIFFICULTIES {
            let intent = normalize_director_intent(Some(&director_sample(json!({ "type": "request_encounter", "theme": theme, "difficulty": difficulty })))).expect("встреча");
            assert_eq!(intent["theme"], json!(theme));
        }
    }
    for resolution in s::DIRECTOR_SCENE_RESOLUTIONS {
        let intent = normalize_director_intent(Some(&director_sample(json!({ "type": "resolve_scene", "resolution": resolution })))).expect("развязка");
        assert_eq!(intent["resolution"], json!(resolution));
    }
    assert!(normalize_director_intent(Some(&director_sample(json!({ "type": "resolve_scene", "resolution": "victory" })))).is_err());
    // Каждое поле схемы — известное валидатору поле.
    for key in properties.as_object().into_iter().flat_map(|map| map.keys()) {
        let value = if key == "type" { json!("continue_exploration") } else { Value::Null };
        let mut intent = json!({ "type": "continue_exploration" });
        intent[key.as_str()] = value;
        assert!(normalize_director_intent(Some(&intent)).is_ok(), "{key}");
    }
}

#[test]
fn social_schema_enums() {
    let properties = &s::NPC_SOCIAL_RESPONSE_JSON_SCHEMA["schema"]["properties"];
    assert_eq!(properties["stance"]["enum"], json!(s::NPC_SOCIAL_STANCES));
    assert_eq!(properties["promise"]["properties"]["direction"]["enum"], json!(s::NPC_PROMISE_DIRECTIONS));
}

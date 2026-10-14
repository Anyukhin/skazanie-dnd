//! Сверка `scene_hazards` и `scene_hazard_narration` с эталоном JS
//! (`fixtures/scene-hazards.json`, генератор `fixtures/gen-scene-hazards.mjs`)
//! и перенос проверок `test/scene-hazards.test.mjs`, касающихся самих
//! модулей (исполнение команды и реестр ассетов — Rules Engine и чужие крейты).

mod common;

use std::sync::LazyLock;

use common::{arg, array, assert_same, parse};
use serde_json::{json, Value};
use sk_combat_content::scene_hazard_narration as n;
use sk_combat_content::scene_hazards::{self as m, BurningPropInput};
use sk_narration_base::deterministic_narration::DeterministicNarrator;

static FIXTURE: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../fixtures/scene-hazards.json")));

#[test]
fn catalog_lists_and_narrator_contract_match_js() {
    let constants = &FIXTURE["constants"];
    assert_eq!(constants["SCENE_SWING_POLICY_ID"], m::SCENE_SWING_POLICY_ID);
    assert_eq!(json!(m::scene_hazard_asset_ids()), constants["hazardIds"]);
    assert_eq!(json!(m::fire_source_asset_ids()), constants["fireIds"]);
    assert_eq!(json!(m::swing_prop_asset_ids()), constants["swingIds"]);
    let narrator = n::SceneHazardNarrator;
    let contract = json!({ "id": narrator.id(), "priority": sk_core::js::num(narrator.priority()), "promptVersion": narrator.prompt_version(), "provider": narrator.provider() });
    assert_eq!(contract, constants["narrator"]);
    let registered = n::register_scene_hazard_narrator().expect("регистрация");
    assert_eq!(registered.id(), "scene-hazard");
    assert!(n::register_scene_hazard_narrator().is_ok(), "повторный вызов не регистрирует дважды");
}

#[test]
fn asset_definitions_match_js() {
    for case in array(&FIXTURE["assets"]) {
        let asset = arg(&case["assetId"]);
        let context = format!("{}", case["assetId"]);
        assert_eq!(m::hazard_asset_key(asset), case["key"], "hazardAssetKey {context}");
        assert_eq!(m::scene_hazard_tags_for(asset).to_value(), case["tags"], "sceneHazardTagsFor {context}");
        assert_eq!(json!(m::scene_hazard_verbs_for(asset)), case["verbs"], "sceneHazardVerbsFor {context}");
        assert_same(&m::topple_definition_for(asset).unwrap_or(Value::Null), &case["topple"], &format!("toppleDefinitionFor {context}"));
        assert_same(&m::ignite_definition_for(asset).unwrap_or(Value::Null), &case["ignite"], &format!("igniteDefinitionFor {context}"));
        assert_same(&m::swing_prop_profile_for(asset).unwrap_or(Value::Null), &case["swing"], &format!("swingPropProfileFor {context}"));
    }
}

#[test]
fn cells_fire_sources_and_burning_zones_match_js() {
    for case in array(&FIXTURE["cells"]) {
        assert_same(&Value::Array(m::hazard_prop_cells(arg(&case["prop"]))), &case["cells"], &format!("hazardPropCells {}", case["prop"]));
    }
    for case in array(&FIXTURE["fire"]) {
        let near = m::fire_source_near(arg(&case["props"]), arg(&case["position"]), arg(&case["actor"])).unwrap_or(Value::Null);
        assert_same(&near, &case["near"], &format!("fireSourceNear {case}"));
    }
    for case in array(&FIXTURE["burning"]) {
        let input = &case["input"];
        let effect = m::burning_prop_effect(BurningPropInput {
            prop_id: input.get("propId"),
            command_id: input.get("commandId"),
            cells: array(&input["cells"]),
            definition: &input["definition"],
            source_actor_id: input.get("sourceActorId"),
            round: input.get("round"),
        });
        assert_same(&effect, &case["effect"], &format!("burningPropEffect {input}"));
    }
}

#[test]
fn narration_matches_js() {
    let cases = array(&FIXTURE["narration"]);
    assert!(cases.len() > 200);
    for case in cases {
        let events = array(&case["events"]);
        assert_eq!(serde_json::json!(n::has_scene_hazard_event(events)), case["matches"], "hasSceneHazardEvent {case}");
        assert_eq!(n::scene_hazard_narration(events, &case["state"]).map_or(Value::Null, Value::from), case["text"], "sceneHazardNarration {case}");
    }
}

/// `test/scene-hazards.test.mjs`: теги и глаголы обстановки из `assetId`.
#[test]
fn hazard_tags_follow_asset_id() {
    let tags = |id: &str| m::scene_hazard_tags_for(Some(&json!(id))).to_value();
    assert_eq!(tags("bookshelf"), json!({ "heavy": true, "flammable": true, "fireSource": false }));
    assert_eq!(tags("campfire"), json!({ "heavy": false, "flammable": false, "fireSource": true }));
    assert_eq!(tags("statue"), json!({ "heavy": true, "flammable": false, "fireSource": false }));
    assert_eq!(tags("rune"), json!({ "heavy": false, "flammable": false, "fireSource": false }));
    assert_eq!(m::hazard_asset_key(Some(&json!("props/table_long.png"))), "table_long");
    assert_eq!(m::scene_hazard_verbs_for(Some(&json!("table_long"))), ["topple", "ignite"]);
    assert_eq!(m::scene_hazard_verbs_for(Some(&json!("statue"))), ["topple"]);
    assert!(m::scene_hazard_verbs_for(Some(&json!("rune"))).is_empty());
    assert!(m::scene_hazard_asset_ids().len() >= 30);
    for decor in ["chair", "stool", "sack", "bucket", "night_table", "mug", "sign_board", "floor_stain", "washbasin"] {
        assert!(m::scene_hazard_verbs_for(Some(&json!(decor))).is_empty(), "{decor}");
    }
}

#[test]
fn chandelier_has_server_owned_swing_profile() {
    assert_eq!(m::swing_prop_asset_ids(), ["chandelier"]);
    assert_eq!(
        m::swing_prop_profile_for(Some(&json!("chandelier"))),
        Some(json!({ "anchor": "ceiling", "height_feet": 10, "reach_feet": 5, "check": { "ability": "str", "skill": "athletics", "difficulty": 12 }, "failure_condition": "prone" }))
    );
}

/// Род подписи согласует глагол: «Колонна качнулась», «Дрова занимаются».
#[test]
fn narration_agrees_with_label_gender() {
    let state = |asset: &str| json!({ "scene": { "map": { "props": [{ "id": "prop-target", "assetId": asset }] } } });
    let failed = [json!({ "event_type": "SceneObjectStateChanged", "payload": { "intent": "topple", "prop_id": "prop-target", "success": false } })];
    assert_eq!(n::scene_hazard_narration(&failed, &state("pillar")).as_deref(), Some("Колонна качнулась, но устояла: опрокинуть её не вышло."));
    assert_eq!(n::scene_hazard_narration(&failed, &state("bookshelf")).as_deref(), Some("Стеллаж качнулся, но устоял: опрокинуть его не вышло."));
    let hurt = [
        json!({ "event_type": "SceneObjectStateChanged", "payload": { "intent": "topple", "prop_id": "prop-target", "success": true } }),
        json!({ "event_type": "DamageApplied", "payload": { "reason": "scene-object-topple" } }),
    ];
    assert!(n::scene_hazard_narration(&hurt, &state("pillar")).expect("текст").contains("под ней"));
    let fire = [json!({ "event_type": "SceneObjectStateChanged", "payload": { "intent": "ignite", "prop_id": "prop-target", "fire_source": "prop" } })];
    let text = n::scene_hazard_narration(&fire, &state("firewood_stack")).expect("текст");
    assert!(text.starts_with("Дрова занимаются огнём"));
    assert!(!text.chars().any(|ch| ch.is_ascii_digit()), "чисел механики в тексте быть не должно");
    assert!(!n::has_scene_hazard_event(&[json!({ "event_type": "SceneObjectStateChanged", "payload": { "intent": "open" } })]));
    assert!(!n::has_scene_hazard_event(&[]));
}

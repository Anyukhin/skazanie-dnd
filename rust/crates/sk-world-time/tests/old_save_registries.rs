//! Старые сохранения (`test/old-save-registries.test.mjs`): `null` в летописи
//! поступков, вид и ступень — ключи прототипа, `actor_names` не списком.

use serde_json::json;
use sk_world_time::world_deeds::*;

#[test]
fn null_deeds_and_prototype_kinds_are_dropped() {
    let deeds = normalize_world_deeds_state(Some(&json!({ "deeds": [null, { "id": "deed-1", "kind": "theft" }, { "id": "deed-2", "kind": "constructor" }] })));
    let ids: Vec<&str> = deeds["deeds"].as_array().expect("летопись").iter().map(|deed| deed["id"].as_str().expect("id")).collect();
    assert_eq!(ids, ["deed-1"]);
    assert!(rumor_wording(&json!({ "kind": "theft", "actor_names": "Марта" }), Some(&json!(0))).contains("чужаки"));
    assert_eq!(rumor_reputation_delta(Some(&json!({ "kind": "theft", "severity": "constructor" })), Some(&json!(0))), -2.0);
}

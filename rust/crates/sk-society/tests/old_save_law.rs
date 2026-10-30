//! Старые сохранения (`test/old-save-registries.test.mjs`): `applyLawEvent`
//! нормализует состояние и при верной версии с массивом `crimes`.

use serde_json::json;
use sk_society::law_and_order::*;

#[test]
fn law_event_normalizes_versioned_state() {
    let law = json!({ "schema_version": 1, "crimes": [], "encounter": { "id": "guard-1", "region_id": "region-1", "escape_attempts": "2" } });
    let after = apply_law_event(Some(&law), &json!({ "event_type": "GuardEncounterResolved", "payload": { "resolution": "flee", "success": false } }), &json!({}));
    assert_eq!(after["encounter"]["escape_attempts"], 3);
    let dirty = json!({ "schema_version": 1, "crimes": [null, { "id": "crime-1", "kind": "theft", "region_id": "region-1", "points": "2" }], "cleared": {}, "encounter": null });
    let cleaned = apply_law_event(Some(&dirty), &json!({ "event_type": "Unrelated" }), &json!({}));
    let crimes: Vec<(&str, i64)> = cleaned["crimes"].as_array().expect("преступления").iter().map(|crime| (crime["id"].as_str().expect("id"), crime["points"].as_i64().expect("очки"))).collect();
    assert_eq!(crimes, [("crime-1", 2)]);
    assert_eq!(apply_law_event(Some(&cleaned), &json!({ "event_type": "Unrelated" }), &json!({})), cleaned);
}

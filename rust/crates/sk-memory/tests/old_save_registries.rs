//! Старые сохранения (`test/old-save-registries.test.mjs`): `null` в коллекциях
//! памяти мира — пустая запись, `clock: null` у задания — часы по умолчанию.

use serde_json::json;
use sk_memory::world_memory::normalize_world_memory;

#[test]
fn null_entries_and_null_clock_read_as_defaults() {
    let memory = normalize_world_memory(&json!({
        "entities": [null, { "id": "npc-1", "kind": "npc", "name": "Марта" }],
        "facts": [null], "relationships": [null], "threads": [null, { "id": "thread-1", "title": "Нить", "clock": null }],
        "epistemic_claims": [null], "summaries": [null], "knowledge_ledger": [null],
        "quests": [null, { "id": "quest-1", "title": "Карта", "clock": null }],
    }));
    assert_eq!(memory["entities"].as_array().map(Vec::len), Some(2));
    assert_eq!(memory["entities"][0]["id"], "");
    let default_clock = json!({ "current": 0, "max": 4, "label": "", "triggered": false });
    let quest = memory["quests"].as_array().expect("задания").iter().find(|quest| quest["id"] == "quest-1").expect("задание");
    assert_eq!(quest["clock"], default_clock);
    let thread = memory["threads"].as_array().expect("нити").iter().find(|thread| thread["id"] == "thread-1").expect("нить");
    assert_eq!(thread["clock"], default_clock);
}

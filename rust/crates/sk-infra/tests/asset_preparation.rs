//! `asset_preparation`: перенос проверок модуля из
//! `test/asset-preparation.test.mjs` (сервис портретов там — заглушка) и
//! сверка с эталоном JS (`fixtures/gen-asset-preparation.mjs`).

mod common;

use std::convert::Infallible;

use serde_json::{json, Value};
use sk_infra::asset_preparation::{items_without_illustration, npc_portrait_inventory, plan_preparation, NpcPortraitCache, ASSET_PREPARATION_POLICY_ID, MAX_PREPARATION_BATCH};

use common::{fixture_path, same_json};

struct Cache {
    ids: Vec<Value>,
    calls: std::sync::Mutex<Vec<Value>>,
}

impl Cache {
    fn new(ids: Vec<Value>) -> Self {
        Self { ids, calls: std::sync::Mutex::new(Vec::new()) }
    }
}

impl NpcPortraitCache for Cache {
    type Error = Infallible;

    async fn cached(&self, campaign_id: &str, npc_id: &Value) -> Result<Option<Value>, Infallible> {
        self.calls.lock().expect("вызовы").push(json!([campaign_id, npc_id]));
        Ok(self.ids.contains(npc_id).then(|| json!({ "cacheHit": true })))
    }
}

fn major(_state: &Value, profile: &Value) -> bool {
    profile["tags"].as_array().is_some_and(|tags| tags.contains(&json!("major")))
}

#[test]
fn plan_respects_cap_unknown_ids_and_ready_assets() {
    let inventories = json!({ "npcs": [{ "id": "npc:a", "has_portrait": false }, { "id": "npc:b", "has_portrait": true }], "locations": [] });
    assert_eq!(plan_preparation(&json!({ "npc_ids": ["npc:a", "npc:b"] }), &inventories, false)["npc_ids"], json!(["npc:a"]), "готовое пропускается");
    assert_eq!(plan_preparation(&json!({ "npc_ids": ["npc:a", "npc:b"] }), &inventories, true)["npc_ids"], json!(["npc:a", "npc:b"]));
    assert_eq!(plan_preparation(&json!({ "npc_ids": ["npc:a", "npc:a"] }), &inventories, false)["npc_ids"], json!(["npc:a"]), "дубликаты схлопываются");
    assert_eq!(plan_preparation(&json!({}), &inventories, false)["code"], "NOTHING_REQUESTED");
    assert_eq!(plan_preparation(&json!({ "npc_ids": [] }), &inventories, false)["code"], "NOTHING_REQUESTED");
    assert_eq!(plan_preparation(&json!({ "npc_ids": ["npc:zzz"] }), &inventories, false)["code"], "UNKNOWN_ASSET");

    let large: Vec<Value> = (0..=MAX_PREPARATION_BATCH).map(|index| json!({ "id": format!("npc:{index}"), "has_portrait": false })).collect();
    let ids: Vec<Value> = large.iter().map(|entry| entry["id"].clone()).collect();
    let overflow = plan_preparation(&json!({ "npc_ids": ids }), &json!({ "npcs": large }), false);
    assert_eq!(overflow["ok"], false);
    assert_eq!(overflow["code"], "BATCH_TOO_LARGE");
    assert!(overflow["message"].as_str().expect("текст").contains(&MAX_PREPARATION_BATCH.to_string()));
    assert_eq!(plan_preparation(&json!({ "npc_ids": ids[..MAX_PREPARATION_BATCH] }), &json!({ "npcs": large }), false)["ok"], true);
}

#[test]
fn cap_is_shared_by_all_kinds_of_images() {
    let npcs: Vec<Value> = (0..MAX_PREPARATION_BATCH - 1).map(|index| json!({ "id": format!("npc:{index}"), "has_portrait": false })).collect();
    let npc_ids: Vec<Value> = npcs.iter().map(|entry| entry["id"].clone()).collect();
    let inventories = json!({ "npcs": npcs, "locations": [{ "id": "loc:norvin", "has_illustration": false }, { "id": "loc:archive", "has_illustration": true }] });
    let fits = plan_preparation(&json!({ "npc_ids": npc_ids, "location_ids": ["loc:norvin"] }), &inventories, false);
    assert_eq!(fits["ok"], true, "ровно потолок проходит");
    assert_eq!(fits["location_ids"], json!(["loc:norvin"]));
    let overflow = plan_preparation(&json!({ "npc_ids": npc_ids, "location_ids": ["loc:norvin", "loc:archive"] }), &inventories, true);
    assert_eq!(overflow["code"], "BATCH_TOO_LARGE", "потолок общий, а не по потолку на вид");
    assert_eq!([overflow["npc_ids"].clone(), overflow["location_ids"].clone()], [json!([]), json!([])]);
    assert_eq!(plan_preparation(&json!({ "location_ids": ["loc:archive"] }), &inventories, false)["location_ids"], json!([]));
    assert_eq!(plan_preparation(&json!({ "location_ids": ["loc:archive"] }), &inventories, true)["location_ids"], json!(["loc:archive"]));
    let unknown = plan_preparation(&json!({ "location_ids": ["loc:unknown"] }), &inventories, false);
    assert_eq!(unknown["code"], "UNKNOWN_ASSET");
    assert!(unknown["message"].as_str().expect("текст").contains("локации"));
}

#[test]
fn refusal_returns_its_own_empty_lists() {
    let inventories = json!({ "npcs": [{ "id": "npc:a", "has_portrait": false }], "locations": [] });
    let mut first = plan_preparation(&json!({ "npc_ids": ["npc:zzz"] }), &inventories, false);
    let second = plan_preparation(&json!({}), &inventories, false);
    first["npc_ids"].as_array_mut().expect("список").push(json!("npc:a"));
    assert_eq!(second["npc_ids"], json!([]));
    assert_eq!(plan_preparation(&json!({}), &inventories, false)["npc_ids"], json!([]));
}

#[test]
fn items_without_illustration_are_listed_deterministically_without_duplicates() {
    let state = json!({
        "players": [
            { "id": "hero", "inventory": [
                { "id": "sword", "name": "Меч", "image": "/generated/items/x.webp" },
                { "id": "amulet", "name": "Амулет" },
                { "id": "rope", "name": "Верёвка", "image": "" },
            ] },
            { "id": "ally", "inventory": [{ "id": "amulet", "name": "Амулет" }, { "id": "lantern", "name": "Фонарь" }] },
        ],
    });
    let ids: Vec<Value> = items_without_illustration(&state).into_iter().map(|entry| entry["id"].clone()).collect();
    assert_eq!(ids, [json!("amulet"), json!("lantern"), json!("rope")]);
    assert!(items_without_illustration(&json!({})).is_empty());
    assert!(items_without_illustration(&Value::Null).is_empty());
}

#[tokio::test]
async fn inventory_shows_who_has_no_portrait_yet() {
    let first = json!({ "id": "npc:bram", "name": "Брам", "role": "merchant" });
    let second = json!({ "id": "npc:marta", "name": "Марта", "role": "merchant" });
    let cache = Cache::new(vec![json!("npc:marta")]);
    let inventory = npc_portrait_inventory(&cache, "PREP", &json!({}), |_, _| true, &[second.clone(), first.clone()]).await.expect("инвентарь");
    let pairs: Vec<(Value, Value)> = inventory.iter().map(|entry| (entry["id"].clone(), entry["has_portrait"].clone())).collect();
    assert_eq!(pairs, [(json!("npc:bram"), json!(false)), (json!("npc:marta"), json!(true))], "порядок детерминирован, состояние кеша честное");
    // Второстепенные NPC в подготовку не попадают: платить за невидимое незачем.
    assert!(npc_portrait_inventory(&cache, "PREP", &json!({}), |_, _| false, &[first]).await.expect("инвентарь").is_empty());
}

#[tokio::test]
async fn authored_portrait_counts_as_ready_without_campaign_cache() {
    let authored = json!({ "id": "astohan-sargat", "name": "Саргат", "role": "молодой красный дракон", "portrait_url": "/assets/npcs/astohan-sargat.webp" });
    let cache = Cache::new(Vec::new());
    let inventory = npc_portrait_inventory(&cache, "ASTOHAN-AUTHORED", &json!({}), |_, _| false, &[authored]).await.expect("инвентарь");
    assert_eq!(inventory.iter().map(|entry| (entry["id"].clone(), entry["has_portrait"].clone())).collect::<Vec<_>>(), [(json!("astohan-sargat"), json!(true))]);
    assert!(cache.calls.lock().expect("вызовы").is_empty(), "готовый портрет кеш не спрашивает");
    assert_eq!(ASSET_PREPARATION_POLICY_ID, "skazanie:asset-preparation-v1");
}

fn fixture() -> Value {
    serde_json::from_str(&std::fs::read_to_string(fixture_path("asset-preparation.json")).expect("эталон")).expect("json")
}

#[test]
fn plans_match_js() {
    let fixture = fixture();
    assert_eq!(fixture["max_batch"], MAX_PREPARATION_BATCH);
    let cases = fixture["plans"].as_array().expect("планы");
    for (index, case) in cases.iter().enumerate() {
        let result = plan_preparation(case.get("requested").unwrap_or(&Value::Null), &case["inventories"], case["regenerate"].as_bool().expect("флаг"));
        assert!(same_json(&result, &case["result"]), "план {index}: {result} вместо {}", case["result"]);
    }
    assert!(cases.len() >= 400);
}

#[test]
fn items_match_js() {
    let fixture = fixture();
    let cases = fixture["items"].as_array().expect("состояния");
    for (index, case) in cases.iter().enumerate() {
        let result = Value::from(items_without_illustration(case.get("state").unwrap_or(&Value::Null)));
        assert!(same_json(&result, &case["result"]), "состояние {index}: {result} вместо {}", case["result"]);
    }
    assert!(cases.len() >= 200);
}

#[tokio::test]
async fn inventories_match_js() {
    let fixture = fixture();
    let cases = fixture["inventories"].as_array().expect("инвентари");
    for (index, case) in cases.iter().enumerate() {
        let cache = Cache::new(case["cached_ids"].as_array().expect("кеш").clone());
        let profiles = case["profiles"].as_array().expect("профили");
        let state = json!({ "marker": "state" });
        let result = npc_portrait_inventory(&cache, "PREP", &state, |state, profile| state["marker"] == "state" && major(state, profile), profiles).await.expect("инвентарь");
        assert!(same_json(&Value::from(result.clone()), &case["result"]), "инвентарь {index}: {result:?} вместо {}", case["result"]);
        assert_eq!(Value::from(cache.calls.lock().expect("вызовы").clone()), case["calls"], "инвентарь {index}: обращения к кешу");
    }
    assert!(cases.len() >= 150);
}

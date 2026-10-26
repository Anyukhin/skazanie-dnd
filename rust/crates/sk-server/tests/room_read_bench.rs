//! Микробенч чтения комнаты (Ск4): `GET /api/rooms/:id` на настоящем сервере
//! набора — медиана запроса и медианы этапов `sk_store::perf` на один запрос.
//! Сценарий — как у бюджета горячего пути: кампания мастером, импорт бойца,
//! ходы исследования; затем `SK_ROOM_BENCH_RUNS` (по умолчанию 40) чтений.
//!
//! `cargo test --release -p sk-server --test room_read_bench -- --ignored --nocapture`

mod kit;

use std::collections::BTreeMap;
use std::time::Instant;

use kit::{Client, TestServer};
use serde_json::{json, Value};

const CAMPAIGN: &str = "BENCH";
const HERO: &str = "hero-slot-1";

fn median(mut samples: Vec<f64>) -> f64 {
    samples.sort_by(f64::total_cmp);
    samples[samples.len() / 2]
}

fn fighter() -> Value {
    let base = json!({ "str": 15, "dex": 14, "con": 13, "int": 12, "wis": 10, "cha": 8 });
    let abilities: serde_json::Map<String, Value> = base.as_object().into_iter().flatten().map(|(key, value)| (key.clone(), json!(value.as_i64().unwrap_or(10) + 1))).collect();
    json!({ "schema": "skazanie.character", "schema_version": 1, "character": {
        "character": "Воин", "characterClass": "fighter", "species": "Человек", "background": "Мудрец", "backgroundId": "sage",
        "level": 1, "experience": 0, "abilities": abilities,
        "abilityGeneration": { "policyId": "skazanie.character-abilities.dnd-5e-2014", "policyVersion": 2, "method": "standard_array",
            "baseScores": base, "originBonusProfileId": "human", "originBonuses": { "str": 1, "dex": 1, "con": 1, "int": 1, "wis": 1, "cha": 1 }, "speciesOptionId": "human" },
        "speciesChoices": { "extra-language": ["dwarvish"] }, "backgroundChoices": { "tools": [], "languages": ["elvish", "draconic"] },
        "starterEquipmentChoices": { "armor": ["chain-mail"], "melee-loadout": ["longsword-shield"], "secondary": ["light-crossbow"], "pack": ["explorers-pack"] },
        "baseSpeed": 30, "hitPointIncreases": [], "classSkillProficiencies": ["athletics", "perception"], "selectedFeatureIds": ["fighting-style-defense"],
        "knownSpellIds": [], "preparedSpellIds": [],
    } })
}

async fn command(client: &mut Client, key: &str, command: Value) -> kit::TestResponse {
    client.post(&format!("/api/campaigns/{CAMPAIGN}/commands"), &json!({ "idempotency_key": key, "command": command })).await
}

fn position(state: &Value) -> (i64, i64) {
    let stored = &state["mechanics"]["positions"][HERO];
    let hero = state["players"].as_array().into_iter().flatten().find(|player| player["id"] == HERO).cloned().unwrap_or(Value::Null);
    let pick = |key: &str| stored[key].as_i64().or_else(|| hero[key].as_i64()).unwrap_or(0);
    (pick("x"), pick("y"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "микробенч: cargo test --release -p sk-server --test room_read_bench -- --ignored --nocapture"]
async fn room_read_bench() {
    let runs: usize = std::env::var("SK_ROOM_BENCH_RUNS").ok().and_then(|value| value.parse().ok()).unwrap_or(40);
    let server = TestServer::start().await;
    let mut player = server.client();
    player.register("bench@mail.ru").await;
    let bootstrap = json!({ "code": CAMPAIGN, "name": "Бенч", "bootstrap": { "slotCount": 1, "startLevel": 1, "rulesetId": "dnd_5e_2014", "world": { "preset": "Классическое фэнтези" } } });
    player.post("/api/campaigns", &bootstrap).await.expect(201);
    let imported = command(&mut player, "import", json!({ "command_type": "ImportCharacter", "actor_id": HERO, "document": fighter() })).await.expect(200);
    let origin = position(&imported["authoritative_state"]);
    let mut step = None;
    for (index, (dx, dy)) in [(1, 0), (0, 1), (-1, 0), (0, -1), (1, 1), (-1, 1), (1, -1), (-1, -1)].into_iter().enumerate() {
        let to = json!({ "x": origin.0 + dx, "y": origin.1 + dy });
        if command(&mut player, &format!("probe-{index}"), json!({ "command_type": "MoveActor", "actor_id": HERO, "to": to })).await.status == 200 {
            step = Some(to);
            break;
        }
    }
    let targets = [json!({ "x": origin.0, "y": origin.1 }), step.unwrap_or_else(|| panic!("нет свободной клетки"))];
    for index in 0..2 {
        command(&mut player, &format!("warm-{index}"), json!({ "command_type": "MoveActor", "actor_id": HERO, "to": targets[index % 2] })).await.expect(200);
    }
    let room = format!("/api/rooms/{CAMPAIGN}");
    let mut body_bytes = 0;
    for _ in 0..3 {
        body_bytes = player.get(&room).await.expect(200).to_string().len();
    }
    sk_store::perf::enable();
    let _ = sk_store::perf::take();
    let mut totals = Vec::with_capacity(runs);
    let mut spans: BTreeMap<&'static str, Vec<f64>> = BTreeMap::new();
    for _ in 0..runs {
        let started = Instant::now();
        player.get(&room).await.expect(200);
        totals.push(started.elapsed().as_secs_f64() * 1e3);
        for (name, _, ms) in sk_store::perf::take() {
            spans.entry(name).or_default().push(ms);
        }
    }
    eprintln!("[room-bench] GET /api/rooms median {:.2} мс (n={runs}, тело ≈{body_bytes} байт)", median(totals));
    for (name, samples) in spans {
        eprintln!("    {name:<36} median {:>7.2} мс", median(samples));
    }
}

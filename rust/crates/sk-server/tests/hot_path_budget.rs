//! Бюджет горячего пути (Ск2): ход `/commands` и чтение комнаты на настоящем
//! сервере набора — по образцу `test/tactical-map-budget.test.mjs`.
//!
//! - **Детерминированный сторож** (везде, в любой сборке): в установившемся
//!   ходе журнал не переигрывается — ни голова, ни версия ниже головы
//!   (`sk_store::perf`: счётчики `store.load.*_replay`). Это и был регресс
//!   «время растёт с длиной летописи»: комната привязана к версии, которую
//!   голова уже обогнала, и каждое её чтение переигрывало события от снимка.
//! - **Время** — медиана девяти ходов после прогрева: строгий порог локально,
//!   на общем раннере (`CI` / `GITHUB_ACTIONS`) — с четырёхкратным запасом
//!   ([`SHARED_RUNNER_TOLERANCE`]). Отладочная сборка порог не проверяет (только
//!   печатает): она медленнее release в разы, а CI собирает её.
//!
//! Фактические числа печатаются всегда.

mod kit;

use std::time::Instant;

use kit::{Client, TestServer};
use serde_json::{json, Value};

/// Медиана хода исследования (`MoveActor`), мс, release, машина разработчика.
/// Ск3 (одна нормализация на оборот координатора, память итогов
/// нормализации, `js::stringify` без выделений на значение): замер
/// 327–329 мс, порог — с полуторным запасом.
const MOVE_BUDGET_MS: f64 = 500.0;
/// Медиана `GET /api/rooms/:id`, мс (замер Ск3 — 52 мс).
const ROOM_BUDGET_MS: f64 = 90.0;
/// Запас общего раннера.
const SHARED_RUNNER_TOLERANCE: f64 = 4.0;
const RUNS: usize = 9;

fn shared_runner() -> bool {
    ["CI", "GITHUB_ACTIONS"].iter().any(|name| std::env::var(name).is_ok_and(|value| value == "true" || value == "1"))
}

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

const CAMPAIGN: &str = "BUDGET";
const HERO: &str = "hero-slot-1";

async fn command(client: &mut Client, key: &str, command: Value) -> kit::TestResponse {
    client.post(&format!("/api/campaigns/{CAMPAIGN}/commands"), &json!({ "idempotency_key": key, "command": command })).await
}

fn position(state: &Value) -> (i64, i64) {
    let stored = &state["mechanics"]["positions"][HERO];
    let hero = state["players"].as_array().into_iter().flatten().find(|player| player["id"] == HERO).cloned().unwrap_or(Value::Null);
    let pick = |key: &str| stored[key].as_i64().or_else(|| hero[key].as_i64()).unwrap_or(0);
    (pick("x"), pick("y"))
}

fn replays(spans: &[(&'static str, u32, f64)]) -> u32 {
    spans.iter().filter(|(name, _, _)| matches!(*name, "store.load.head_replay" | "store.load.at_version_replay")).map(|(_, count, _)| *count).sum()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hot_path_stays_within_budget_and_never_replays_the_journal() {
    let server = TestServer::start().await;
    let mut player = server.client();
    player.register("budget@mail.ru").await;
    let bootstrap = json!({ "code": CAMPAIGN, "name": "Бюджет", "bootstrap": { "slotCount": 1, "startLevel": 1, "rulesetId": "dnd_5e_2014", "world": { "preset": "Классическое фэнтези" } } });
    player.post("/api/campaigns", &bootstrap).await.expect(201);
    let imported = command(&mut player, "import", json!({ "command_type": "ImportCharacter", "actor_id": HERO, "document": fighter() })).await.expect(200);
    let state = imported["authoritative_state"].clone();
    let origin = position(&state);
    // Соседняя клетка, куда ход проходит; ход обратно — на исходную.
    let mut step = None;
    for (index, (dx, dy)) in [(1, 0), (0, 1), (-1, 0), (0, -1), (1, 1), (-1, 1), (1, -1), (-1, -1)].into_iter().enumerate() {
        let to = json!({ "x": origin.0 + dx, "y": origin.1 + dy });
        let moved = command(&mut player, &format!("probe-{index}"), json!({ "command_type": "MoveActor", "actor_id": HERO, "to": to })).await;
        if moved.status == 200 {
            step = Some(to);
            break;
        }
    }
    let step = step.unwrap_or_else(|| panic!("рядом с героем нет свободной клетки: {origin:?}"));
    let targets = [json!({ "x": origin.0, "y": origin.1 }), step];
    // Прогрев: два хода туда-обратно.
    for index in 0..2 {
        command(&mut player, &format!("warm-{index}"), json!({ "command_type": "MoveActor", "actor_id": HERO, "to": targets[index % 2] })).await.expect(200);
    }
    sk_store::perf::enable();
    let _ = sk_store::perf::take();
    let mut moves = Vec::with_capacity(RUNS);
    for index in 0..RUNS {
        let started = Instant::now();
        command(&mut player, &format!("move-{index}"), json!({ "command_type": "MoveActor", "actor_id": HERO, "to": targets[index % 2] })).await.expect(200);
        moves.push(started.elapsed().as_secs_f64() * 1e3);
    }
    let mut rooms = Vec::with_capacity(RUNS);
    for _ in 0..RUNS {
        let started = Instant::now();
        player.get(&format!("/api/rooms/{CAMPAIGN}")).await.expect(200);
        rooms.push(started.elapsed().as_secs_f64() * 1e3);
    }
    let spans = sk_store::perf::take();
    let (moved, room) = (median(moves), median(rooms));
    let tolerance = if shared_runner() { SHARED_RUNNER_TOLERANCE } else { 1.0 };
    let release = !cfg!(debug_assertions);
    eprintln!(
        "[budget] MoveActor median {moved:.1} мс (порог {:.0}), GET /api/rooms median {room:.1} мс (порог {:.0}){}{}",
        MOVE_BUDGET_MS * tolerance,
        ROOM_BUDGET_MS * tolerance,
        if shared_runner() { " [ci]" } else { "" },
        if release { "" } else { " — отладочная сборка: время не проверяется" },
    );
    assert_eq!(replays(&spans), 0, "горячий путь переигрывает журнал: {spans:?}");
    if release {
        assert!(moved <= MOVE_BUDGET_MS * tolerance, "ход исследования {moved:.1} мс дольше бюджета {:.0} мс", MOVE_BUDGET_MS * tolerance);
        assert!(room <= ROOM_BUDGET_MS * tolerance, "чтение комнаты {room:.1} мс дольше бюджета {:.0} мс", ROOM_BUDGET_MS * tolerance);
    }
}

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
//! - **Счёт нормализаций и копий** (Ск5, детерминированно): полных
//!   нормализаций состояния (`normalize.full`) и копий нормализованного
//!   состояния (`state.copy`) на ход исследования и на конец хода героя в
//!   бою (с ходами NPC) — не больше закреплённого. Было (урок 4): 8 и 9 на
//!   `MoveActor`, 23 и 17 на `EndTurn`; стало 2 и 8, 2 и 12–14 — после
//!   замкнутых типов событий редьюсера (`NORMALIZATION_CLOSED_EVENT_TYPES`)
//!   и общего состояния разбора; чтение комнаты — одна нормализация
//!   (проекция). Пропуски нормализации (`normalize.skipped`)
//!   на конце хода обязаны быть: иначе замкнутость тихо отключилась.
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
/// Медиана `GET /api/rooms/:id`, мс. Ск3 — 52 мс (порог 90); Ск4 (сверка
/// проекции по ссылке и без второго хеша, права и тело ответа без копий
/// состояния, память проекции карты) — 41–46 мс на машине под нагрузкой
/// соседних сборок, порог — 60.
const ROOM_BUDGET_MS: f64 = 60.0;
/// Запас общего раннера.
const SHARED_RUNNER_TOLERANCE: f64 = 4.0;
const RUNS: usize = 9;
/// Полных нормализаций на ход исследования (Ск5: состояние комнаты у
/// оркестратора и проекция комнаты после коммита).
const MOVE_NORMALIZATIONS: u32 = 2;
/// Копий нормализованного состояния на ход исследования.
const MOVE_STATE_COPIES: u32 = 8;
/// Полных нормализаций на чтение комнаты (проекция комнаты).
const ROOM_NORMALIZATIONS: u32 = 1;
/// Полных нормализаций на конец хода героя в бою вместе с ходами NPC.
const END_TURN_NORMALIZATIONS: u32 = 2;
/// Копий нормализованного состояния на конец хода героя с ходами NPC
/// (12–14: число зависит от ходов NPC до следующего хода героя).
const END_TURN_STATE_COPIES: u32 = 14;

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
        // #190: герой 2014 создаётся только с выборами PHB — как в
        // `test/chain-lightning-api.test.mjs` и соседях.
        "phbCreation": { "schema_version": 1, "classChoices": {} },
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

/// Сколько раз прошёл отрезок `name`.
fn count(spans: &[(&'static str, u32, f64)], name: &str) -> u32 {
    spans.iter().filter(|(known, _, _)| *known == name).map(|(_, count, _)| *count).sum()
}

fn active_actor(state: &Value) -> String {
    let combat = &state["mechanics"]["combat"];
    let index = combat["active_index"].as_u64().unwrap_or(0) as usize;
    combat["initiative"][index]["actor_id"].as_str().unwrap_or_default().to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hot_path_stays_within_budget_and_never_replays_the_journal() {
    let server = TestServer::start().await;
    let mut admin = server.client();
    admin.setup_admin().await;
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
    let move_spans = sk_store::perf::take();
    let mut rooms = Vec::with_capacity(RUNS);
    for _ in 0..RUNS {
        let started = Instant::now();
        player.get(&format!("/api/rooms/{CAMPAIGN}")).await.expect(200);
        rooms.push(started.elapsed().as_secs_f64() * 1e3);
    }
    let room_spans = sk_store::perf::take();
    let (moved, room) = (median(moves), median(rooms));
    let runs = RUNS as u32;
    let (move_normalizations, move_copies) = (count(&move_spans, "normalize.full"), count(&move_spans, "state.copy"));
    let room_normalizations = count(&room_spans, "normalize.full");

    // Бой: сборка встречи ведущим, конец хода героя с ходами NPC — счёт
    // нормализаций и копий на каждый конец хода героя.
    let state = player.get(&format!("/api/rooms/{CAMPAIGN}")).await.expect(200)["state"].clone();
    let expected = state["state_version"].as_i64().unwrap_or(0);
    let assembled = admin.post(&format!("/api/campaigns/{CAMPAIGN}/encounters/assemble"), &json!({ "idempotency_key": "budget-encounter", "expected_state_version": expected, "difficulty": "easy", "theme": "beasts", "seed": "hot-path-budget" })).await.expect(200);
    let mut state = assembled["authoritative_state"].clone();
    let mut end_turns: Vec<(u32, u32, u32)> = Vec::new();
    for serial in 0..40 {
        if end_turns.len() >= 3 || state["mechanics"]["combat"]["active"] != true {
            break;
        }
        let active = active_actor(&state);
        let body = json!({ "command_type": "EndTurn", "actor_id": active });
        let _ = sk_store::perf::take();
        let ended = if active == HERO { command(&mut player, &format!("end-{serial}"), body).await } else { command(&mut admin, &format!("end-{serial}"), body).await };
        let turn = sk_store::perf::take();
        state = ended.expect(200)["authoritative_state"].clone();
        if active == HERO {
            end_turns.push((count(&turn, "normalize.full"), count(&turn, "state.copy"), count(&turn, "normalize.skipped")));
        }
    }
    let tolerance = if shared_runner() { SHARED_RUNNER_TOLERANCE } else { 1.0 };
    let release = !cfg!(debug_assertions);
    eprintln!(
        "[budget] MoveActor median {moved:.1} мс (порог {:.0}), GET /api/rooms median {room:.1} мс (порог {:.0}){}{}",
        MOVE_BUDGET_MS * tolerance,
        ROOM_BUDGET_MS * tolerance,
        if shared_runner() { " [ci]" } else { "" },
        if release { "" } else { " — отладочная сборка: время не проверяется" },
    );
    eprintln!(
        "[budget] на ход исследования: нормализаций {:.1} (порог {MOVE_NORMALIZATIONS}), копий состояния {:.1} (порог {MOVE_STATE_COPIES}); на чтение комнаты нормализаций {:.1} (порог {ROOM_NORMALIZATIONS}); конец хода героя (нормализаций, копий, пропусков): {end_turns:?}",
        f64::from(move_normalizations) / f64::from(runs),
        f64::from(move_copies) / f64::from(runs),
        f64::from(room_normalizations) / f64::from(runs),
    );
    assert_eq!(replays(&move_spans) + replays(&room_spans), 0, "горячий путь переигрывает журнал: {move_spans:?} {room_spans:?}");
    assert!(room_normalizations <= ROOM_NORMALIZATIONS * runs, "чтение комнаты: {room_normalizations} полных нормализаций на {runs} чтений, порог {ROOM_NORMALIZATIONS} на чтение");
    assert!(move_normalizations <= MOVE_NORMALIZATIONS * runs, "ход исследования: {move_normalizations} полных нормализаций на {runs} ходов, порог {MOVE_NORMALIZATIONS} на ход");
    assert!(move_copies <= MOVE_STATE_COPIES * runs, "ход исследования: {move_copies} копий состояния на {runs} ходов, порог {MOVE_STATE_COPIES} на ход");
    assert!(!end_turns.is_empty(), "в бою не дошло до хода героя");
    for (normalizations, copies, skipped) in &end_turns {
        assert!(*normalizations <= END_TURN_NORMALIZATIONS, "конец хода героя: {normalizations} полных нормализаций, порог {END_TURN_NORMALIZATIONS}");
        assert!(*copies <= END_TURN_STATE_COPIES, "конец хода героя: {copies} копий состояния, порог {END_TURN_STATE_COPIES}");
        assert!(*skipped > 0, "конец хода героя без пропусков нормализации: замкнутые типы событий не сработали");
    }
    if release {
        assert!(moved <= MOVE_BUDGET_MS * tolerance, "ход исследования {moved:.1} мс дольше бюджета {:.0} мс", MOVE_BUDGET_MS * tolerance);
        assert!(room <= ROOM_BUDGET_MS * tolerance, "чтение комнаты {room:.1} мс дольше бюджета {:.0} мс", ROOM_BUDGET_MS * tolerance);
    }
}

//! Бюджет длинного журнала (урок 11 плана переноса): ход и чтение комнаты не
//! дорожают с длиной журнала кампании.
//!
//! Журнал набирается быстро, мимо HTTP: события двух настоящих ходов
//! (туда и обратно) повторяются прямо в хранилище коммитами по сто событий,
//! а трассы хода — копиями настоящей трассы. Затем те же операции, что на
//! коротком журнале, сравниваются с ним.
//!
//! - **Детерминированные сторожа** (в любой сборке): выделенная память на
//!   `MoveActor`, `GET /api/rooms` и `EndTurn` не растёт с длиной журнала и
//!   не выходит из абсолютного бюджета; журнал на горячем пути не
//!   переигрывается. Память считает свой распределитель этого бинаря.
//! - **Время** печатается; проверяется только с
//!   `SKAZANIE_LONG_JOURNAL_STRICT_TIME=1` и в release: ход на длинном
//!   журнале не дольше, чем на коротком, с запасом на шум общей машины.
//!
//! Длина — `SKAZANIE_LONG_JOURNAL_VERSIONS`: по умолчанию 2000 версий в
//! release и 500 в отладочной сборке. Набивка идёт через редьюсер (около
//! 50 мс на событие хода в release), поэтому 10 000 версий — около девяти
//! минут: так проверяется цель урока вручную.

mod kit;

use std::alloc::{GlobalAlloc, Layout, System};
use std::time::Instant;

use kit::{Client, TestServer};
use serde_json::{json, Value};

/// Распределитель-счётчик поверх системного: каждое выделение — в счётчики
/// `sk_store::perf` (как фича `alloc-count` у бинаря сервера).
struct Counting;

// SAFETY: тот же контракт `GlobalAlloc`, вызовы передаются `System`.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        sk_store::perf::note_allocation(layout.size());
        // SAFETY: см. выше.
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        sk_store::perf::note_allocation(layout.size());
        // SAFETY: см. выше.
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: см. выше.
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        sk_store::perf::note_allocation(new_size);
        // SAFETY: см. выше.
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

/// Абсолютные бюджеты выделений на операцию, МБ (урок 11, release и
/// отладочная сборка выделяют одинаково). Замер урока 11 на 160 и 10 000
/// версиях: ход исследования ≈ 560–650, чтение комнаты ≈ 50–55, конец хода с
/// ходами NPC ≈ 1100–1200; бюджет — с запасом около четверти. Урок 4
/// (состояние на `Arc`, нормализация на границе) должен их опустить.
const MOVE_BUDGET_MB: f64 = 820.0;
const ROOM_BUDGET_MB: f64 = 70.0;
const END_TURN_BUDGET_MB: f64 = 1500.0;
/// Рост выделений длинного журнала против короткого: не больше 10 % и 4 МБ.
const GROWTH: f64 = 1.10;
const GROWTH_SLACK_MB: f64 = 4.0;
const RUNS: usize = 5;

const CAMPAIGN: &str = "LONGBUDGET";
const HERO: &str = "hero-slot-1";

fn median(mut samples: Vec<f64>) -> f64 {
    samples.sort_by(f64::total_cmp);
    samples[samples.len() / 2]
}

fn versions() -> i64 {
    std::env::var("SKAZANIE_LONG_JOURNAL_VERSIONS").ok().and_then(|text| text.parse().ok()).unwrap_or(if cfg!(debug_assertions) { 500 } else { 2_000 })
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
        "knownSpellIds": [], "preparedSpellIds": [], "phbCreation": { "schema_version": 1, "classChoices": {} },
    } })
}

fn position(state: &Value, actor: &str) -> (i64, i64) {
    let stored = &state["mechanics"]["positions"][actor];
    let hero = state["players"].as_array().into_iter().flatten().find(|player| player["id"] == actor).cloned().unwrap_or(Value::Null);
    let pick = |key: &str| stored[key].as_i64().or_else(|| hero[key].as_i64()).unwrap_or(0);
    (pick("x"), pick("y"))
}

fn active_actor(state: &Value) -> String {
    let combat = &state["mechanics"]["combat"];
    let index = combat["active_index"].as_u64().unwrap_or(0) as usize;
    combat["initiative"][index]["actor_id"].as_str().unwrap_or_default().to_string()
}

/// Одна операция: время, мегабайты выделений (все потоки процесса) и ответ.
struct Sample {
    ms: f64,
    mb: f64,
    body: Value,
}

async fn measured(client: &mut Client, method: &str, target: &str, body: Option<&Value>) -> Sample {
    let (bytes, _, _) = sk_store::perf::allocation_counters();
    let started = Instant::now();
    let response = match (method, body) {
        ("POST", Some(body)) => client.post(target, body).await,
        _ => client.get(target).await,
    };
    let ms = started.elapsed().as_secs_f64() * 1e3;
    let (after, _, _) = sk_store::perf::allocation_counters();
    let body = response.expect(200);
    Sample { ms, mb: (after - bytes) as f64 / 1_048_576.0, body }
}

struct Phase {
    move_ms: f64,
    move_mb: f64,
    room_ms: f64,
    room_mb: f64,
    replays: u32,
}

struct Game {
    player: Client,
    serial: usize,
    targets: [Value; 2],
}

impl Game {
    async fn command(&mut self, command: Value) -> Sample {
        self.serial += 1;
        let body = json!({ "idempotency_key": format!("budget-{}", self.serial), "command": command });
        measured(&mut self.player, "POST", &format!("/api/campaigns/{CAMPAIGN}/commands"), Some(&body)).await
    }

    async fn step(&mut self) -> Sample {
        let to = self.targets[self.serial % 2].clone();
        self.command(json!({ "command_type": "MoveActor", "actor_id": HERO, "to": to })).await
    }

    async fn phase(&mut self) -> Phase {
        sk_store::perf::enable();
        let _ = sk_store::perf::take();
        let mut moves = Vec::new();
        for _ in 0..RUNS {
            moves.push(self.step().await);
        }
        let mut rooms = Vec::new();
        for _ in 0..RUNS {
            rooms.push(measured(&mut self.player, "GET", &format!("/api/rooms/{CAMPAIGN}"), None).await);
        }
        let replays = sk_store::perf::take().iter().filter(|(name, _, _)| matches!(*name, "store.load.head_replay" | "store.load.at_version_replay")).map(|(_, count, _)| *count).sum();
        Phase {
            move_ms: median(moves.iter().map(|sample| sample.ms).collect()),
            move_mb: median(moves.iter().map(|sample| sample.mb).collect()),
            room_ms: median(rooms.iter().map(|sample| sample.ms).collect()),
            room_mb: median(rooms.iter().map(|sample| sample.mb).collect()),
            replays,
        }
    }
}

/// Журнал до `target` версий: события двух ходов (туда и обратно) —
/// коммитами по сто событий; герой остаётся на месте.
async fn pad_journal(server: &TestServer, pair: Vec<Value>, target: i64) -> i64 {
    server
        .state
        .core
        .call(move |core| {
            Box::pin(async move {
                let mut version = core.events.load(CAMPAIGN, &sk_store::LoadOptions::default()).expect("голова").state_version;
                let per_commit = (100 / pair.len()).max(1) * pair.len();
                let mut serial = 0;
                while version + (per_commit as i64) <= target {
                    let events: Vec<Value> = pair.iter().cycle().take(per_commit).cloned().collect();
                    serial += 1;
                    let request = sk_store::CommitRequest { campaign_id: CAMPAIGN.into(), expected_state_version: version, idempotency_key: format!("pad-{serial}"), events, ..Default::default() };
                    version = core.events.commit(request).expect("коммит набивки").state_version;
                }
                version
            })
        })
        .await
        .expect("ядро")
}

/// Трассы хода до `count` копиями последней настоящей трассы.
fn pad_traces(server: &TestServer, count: usize) -> usize {
    let directory = server.storage().join("turn-traces").join(CAMPAIGN);
    let template = std::fs::read_dir(&directory).expect("трассы").filter_map(Result::ok).map(|entry| entry.path()).find(|path| path.extension().is_some_and(|extension| extension == "json")).expect("настоящая трасса");
    let body = std::fs::read(&template).expect("трасса");
    for index in 0..count {
        std::fs::write(directory.join(format!("pad-{index:05}.json")), &body).expect("копия трассы");
    }
    std::fs::read_dir(&directory).expect("трассы").count()
}

fn check_growth(label: &str, short: f64, long: f64) {
    assert!(long <= short * GROWTH + GROWTH_SLACK_MB, "{label}: выделения растут с длиной журнала — {short:.1} МБ → {long:.1} МБ");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn turn_and_room_read_do_not_grow_with_journal_length() {
    let server = TestServer::start().await;
    let mut admin = server.client();
    admin.setup_admin().await;
    let mut player = server.client();
    player.register("long-budget@mail.ru").await;
    let bootstrap = json!({ "code": CAMPAIGN, "name": "Длинный журнал", "bootstrap": { "slotCount": 1, "startLevel": 1, "rulesetId": "dnd_5e_2014", "world": { "preset": "Классическое фэнтези" } } });
    player.post("/api/campaigns", &bootstrap).await.expect(201);
    let imported = player.post(&format!("/api/campaigns/{CAMPAIGN}/commands"), &json!({ "idempotency_key": "import", "command": { "command_type": "ImportCharacter", "actor_id": HERO, "document": fighter() } })).await.expect(200);
    let origin = position(&imported["authoritative_state"], HERO);
    let mut step = None;
    for (index, (dx, dy)) in [(1, 0), (0, 1), (-1, 0), (0, -1), (1, 1), (-1, 1), (1, -1), (-1, -1)].into_iter().enumerate() {
        let to = json!({ "x": origin.0 + dx, "y": origin.1 + dy });
        let probe = player.post(&format!("/api/campaigns/{CAMPAIGN}/commands"), &json!({ "idempotency_key": format!("probe-{index}"), "command": { "command_type": "MoveActor", "actor_id": HERO, "to": to } })).await;
        if probe.status == 200 {
            step = Some(to);
            break;
        }
    }
    let step = step.unwrap_or_else(|| panic!("рядом с героем нет свободной клетки: {origin:?}"));
    // Герой на `step`: ход с чётным `serial` — на исходную, с нечётным — на `step`.
    let mut game = Game { player, serial: 0, targets: [json!({ "x": origin.0, "y": origin.1 }), step] };
    for _ in 0..3 {
        game.step().await;
    }
    let short = game.phase().await;

    // Набивка: события двух последних ходов (туда и обратно) — герой после
    // неё там же, где после настоящего второго хода.
    let version = |sample: Sample| sample.body["authoritative_state"]["state_version"].as_i64().expect("версия");
    let start = version(game.step().await);
    game.step().await;
    let back = version(game.step().await);
    let short_version = back;
    let pair = server.state.core.call(move |core| Box::pin(async move { core.events.get_events(CAMPAIGN, start, Some(back)) })).await.expect("ядро").expect("события ходов");
    assert!(pair.len() >= 2, "события двух ходов: {}", pair.len());
    let target = versions();
    let started = Instant::now();
    let long_version = pad_journal(&server, pair, target).await;
    let traces = pad_traces(&server, (target / 2) as usize);
    eprintln!("[long-journal] журнал {short_version} → {long_version} версий, трасс {traces}, набивка {:.1} с", started.elapsed().as_secs_f64());
    // Первый ход после набивки догоняет комнату и строит оглавление трасс.
    let first = game.step().await;
    game.step().await;
    let long = game.phase().await;

    // Бой: сборка встречи ведущим, конец хода героя с ходами NPC.
    let state = measured(&mut game.player, "GET", &format!("/api/rooms/{CAMPAIGN}"), None).await.body["state"].clone();
    let expected = state["state_version"].as_i64().unwrap_or(0);
    let assembled = measured(&mut admin, "POST", &format!("/api/campaigns/{CAMPAIGN}/encounters/assemble"), Some(&json!({ "idempotency_key": "budget-encounter", "expected_state_version": expected, "difficulty": "easy", "theme": "beasts", "seed": "long-journal-budget" }))).await;
    let mut state = assembled.body["authoritative_state"].clone();
    let mut end_turns = Vec::new();
    let mut serial = 0;
    for _ in 0..40 {
        if end_turns.len() >= 3 || state["mechanics"]["combat"]["active"] != true {
            break;
        }
        let active = active_actor(&state);
        serial += 1;
        let body = json!({ "idempotency_key": format!("budget-combat-{serial}"), "command": { "command_type": "EndTurn", "actor_id": active } });
        let target = format!("/api/campaigns/{CAMPAIGN}/commands");
        let sample = if active == HERO { measured(&mut game.player, "POST", &target, Some(&body)).await } else { measured(&mut admin, "POST", &target, Some(&body)).await };
        state = sample.body["authoritative_state"].clone();
        if active == HERO {
            end_turns.push(sample);
        }
    }
    assert!(!end_turns.is_empty(), "в бою не дошло до хода героя");
    let end_turn_ms = median(end_turns.iter().map(|sample| sample.ms).collect());
    let end_turn_mb = median(end_turns.iter().map(|sample| sample.mb).collect());

    eprintln!(
        "[long-journal] {short_version} версий: MoveActor {:.0} мс / {:.0} МБ, GET {:.0} мс / {:.1} МБ",
        short.move_ms, short.move_mb, short.room_ms, short.room_mb
    );
    eprintln!(
        "[long-journal] {long_version} версий: первый ход {:.0} мс / {:.0} МБ; MoveActor {:.0} мс / {:.0} МБ, GET {:.0} мс / {:.1} МБ; сборка встречи {:.0} мс / {:.0} МБ; EndTurn {end_turn_ms:.0} мс / {end_turn_mb:.0} МБ",
        first.ms, first.mb, long.move_ms, long.move_mb, long.room_ms, long.room_mb, assembled.ms, assembled.mb
    );

    assert!(long_version >= target - 100, "журнал набит до {long_version}, а не до {target}");
    assert_eq!(short.replays + long.replays, 0, "горячий путь переигрывает журнал");
    check_growth("MoveActor", short.move_mb, long.move_mb);
    check_growth("GET /api/rooms", short.room_mb, long.room_mb);
    assert!(long.move_mb <= MOVE_BUDGET_MB, "MoveActor выделяет {:.0} МБ, бюджет {MOVE_BUDGET_MB:.0}", long.move_mb);
    assert!(long.room_mb <= ROOM_BUDGET_MB, "GET /api/rooms выделяет {:.1} МБ, бюджет {ROOM_BUDGET_MB:.0}", long.room_mb);
    assert!(end_turn_mb <= END_TURN_BUDGET_MB, "EndTurn выделяет {end_turn_mb:.0} МБ, бюджет {END_TURN_BUDGET_MB:.0}");
    if std::env::var("SKAZANIE_LONG_JOURNAL_STRICT_TIME").is_ok_and(|value| value == "1") && !cfg!(debug_assertions) {
        assert!(long.move_ms <= short.move_ms * 1.5 + 20.0, "ход на длинном журнале {:.0} мс против {:.0} мс на коротком", long.move_ms, short.move_ms);
        assert!(long.room_ms <= short.room_ms * 1.5 + 20.0, "чтение комнаты на длинном журнале {:.0} мс против {:.0} мс", long.room_ms, short.room_ms);
    }
}

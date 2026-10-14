//! Перенос `test/architect-usage.test.mjs` и эталон JS
//! (`fixtures/architect-usage.json`, генератор `fixtures/gen-architect-usage.mjs`):
//! результаты вызовов и точное содержимое файла учёта после каждого шага.
//!
//! Лимита на генерацию локаций нет, есть предупреждение о расходе: проверяется
//! счёт и однократность сигнала, а не отказ.

use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use sk_agents_base::architect_usage::{architect_alert_text, campaign_key, ArchitectUsageStore, DEFAULT_ARCHITECT_ALERT_THRESHOLD};
use sk_narration_base::jsx::stringify;

struct Fixture {
    _directory: tempfile::TempDir,
    storage_file: PathBuf,
}

fn temporary() -> Fixture {
    let directory = tempfile::Builder::new().prefix("skazanie-architect-").tempdir().expect("каталог");
    let storage_file = directory.path().join("architect-usage.json");
    Fixture { _directory: directory, storage_file }
}

fn store(fixture: &Fixture, threshold: i64) -> ArchitectUsageStore {
    ArchitectUsageStore::new(&fixture.storage_file, Some(&json!(threshold)), None).expect("счётчик")
}

fn today() -> String {
    sk_core::clock::now_iso().chars().take(10).collect()
}

#[test]
fn generation_increments_campaign_counter_without_touching_neighbour() {
    let fixture = temporary();
    let store = store(&fixture, 3);
    assert_eq!(store.generations_today("ALFA"), 0);
    assert_eq!(store.record_generation("ALFA").expect("запись").generations, 1);
    assert_eq!(store.record_generation("ALFA").expect("запись").generations, 2);
    assert_eq!(store.generations_today("ALFA"), 2);
    assert_eq!(store.generations_today("BETA"), 0);
    assert_eq!(store.record_generation("BETA").expect("запись").generations, 1);
    assert_eq!(store.generations_today("ALFA"), 2, "счётчик соседней кампании не сдвинулся");
}

#[test]
fn threshold_fires_exactly_once_per_day_and_counting_continues_silently() {
    let fixture = temporary();
    let store = store(&fixture, 3);
    assert!(!store.record_generation("ALFA").expect("запись").alert, "до порога предупреждения нет");
    assert!(!store.record_generation("ALFA").expect("запись").alert);
    let crossing = store.record_generation("ALFA").expect("запись");
    assert!(crossing.alert, "на пересечении порога предупреждение уходит");
    assert_eq!((crossing.generations, crossing.threshold), (3, 3));
    assert!(!store.record_generation("ALFA").expect("запись").alert);
    assert!(!store.record_generation("ALFA").expect("запись").alert);
    assert_eq!(store.generations_today("ALFA"), 5);
}

#[test]
fn calendar_day_change_resets_counter_and_alert() {
    let fixture = temporary();
    let now = Arc::new(AtomicI64::new(sk_core::clock::parse_iso("2026-08-02T21:00:00.000Z").expect("время")));
    let clock = Arc::clone(&now);
    let store = ArchitectUsageStore::new(&fixture.storage_file, Some(&json!(2)), Some(Arc::new(move || clock.load(Ordering::SeqCst)))).expect("счётчик");
    store.record_generation("ALFA").expect("запись");
    assert!(store.record_generation("ALFA").expect("запись").alert);
    assert_eq!(store.generations_today("ALFA"), 2);
    now.store(sk_core::clock::parse_iso("2026-08-03T09:00:00.000Z").expect("время"), Ordering::SeqCst);
    assert_eq!(store.generations_today("ALFA"), 0, "новый день — новый счёт");
    assert!(!store.record_generation("ALFA").expect("запись").alert);
    assert!(store.record_generation("ALFA").expect("запись").alert, "предупреждение снова доступно на новом дне");
}

#[test]
fn counter_survives_process_restart() {
    let fixture = temporary();
    let first = store(&fixture, 3);
    first.record_generation("ALFA").expect("запись");
    first.record_generation("ALFA").expect("запись");
    let second = store(&fixture, 3);
    assert_eq!(second.generations_today("ALFA"), 2);
    assert!(second.record_generation("ALFA").expect("запись").alert, "порог считается по сохранённому счёту");
    assert!(!store(&fixture, 3).record_generation("ALFA").expect("запись").alert, "однократность тоже durable");
}

#[test]
fn old_agent_lab_records_stay_readable() {
    let fixture = temporary();
    let store = store(&fixture, 2);
    std::fs::write(&fixture.storage_file, stringify(&json!({ "schema_version": 1, "day": today(), "campaigns": { "ALFA": { "generations": 0, "lab_generations": 2, "alerted": false } } }))).expect("файл");
    assert_eq!(store.generations_today("ALFA"), 0, "dry-run лаборатории локаций не создаёт");
    assert_eq!(store.report()["campaigns"]["ALFA"]["lab_generations"], 2, "но расход админ видит");
    assert!(!store.record_generation("ALFA").expect("запись").alert);
    assert!(store.record_generation("ALFA").expect("запись").alert, "порог достигается только настоящими локациями");
}

#[test]
fn report_breaks_down_campaigns_for_today() {
    let fixture = temporary();
    let store = store(&fixture, 2);
    store.record_generation("ALFA").expect("запись");
    store.record_generation("ALFA").expect("запись");
    store.record_generation("BETA").expect("запись");
    std::fs::write(
        &fixture.storage_file,
        stringify(&json!({ "schema_version": 1, "day": today(), "campaigns": { "ALFA": { "generations": 2, "lab_generations": 0, "alerted": true }, "BETA": { "generations": 1, "lab_generations": 1, "alerted": false } } })),
    )
    .expect("файл");
    let report = store.report();
    assert_eq!(report["alert_threshold"], 2);
    let day = report["day"].as_str().expect("день");
    assert!(day.len() == 10 && day.as_bytes()[4] == b'-' && day.as_bytes()[7] == b'-', "{day}");
    assert_eq!(report["campaigns"]["ALFA"]["generations"], 2);
    assert_eq!(report["campaigns"]["ALFA"]["alerted"], true);
    assert_eq!(report["campaigns"]["BETA"]["generations"], 1);
    assert_eq!(report["campaigns"]["BETA"]["alerted"], false);
    assert_eq!(report["total_generations"], 3);
    assert_eq!(report["total_lab_generations"], 1);
}

#[test]
fn threshold_comes_from_settings_and_junk_falls_back_to_default() {
    let fixture = temporary();
    let make = |value: Value| ArchitectUsageStore::new(&fixture.storage_file, Some(&value), None).expect("счётчик").alert_threshold();
    assert_eq!(make(json!(7)), 7);
    for junk in [json!(0), json!(-3), json!("NaN"), json!("много")] {
        assert_eq!(make(junk.clone()), DEFAULT_ARCHITECT_ALERT_THRESHOLD, "{junk}");
    }
    assert_eq!(ArchitectUsageStore::new(&fixture.storage_file, None, None).expect("счётчик").alert_threshold(), 3);
    assert_eq!(ArchitectUsageStore::new("", None, None).err().as_deref(), Some("ArchitectUsageStore requires storageFile"));
}

#[test]
fn damaged_file_does_not_break_the_turn() {
    let fixture = temporary();
    std::fs::write(&fixture.storage_file, "{ это не json").expect("файл");
    let store = store(&fixture, 2);
    assert_eq!(store.generations_today("ALFA"), 0);
    assert_eq!(store.record_generation("ALFA").expect("запись").generations, 1);
}

#[test]
fn alert_text_names_the_number_and_says_there_is_no_limit() {
    let text = architect_alert_text(4);
    assert!(text.contains("создано 4 новых локаций"));
    assert!(text.contains("Ограничения нет"));
}

#[test]
fn campaign_key_follows_js() {
    assert_eq!(campaign_key("alfa-1"), "ALFA-1");
    assert_eq!(campaign_key("ß_x"), "SSX");
    assert_eq!(campaign_key("Кампания 7"), "7");
    assert_eq!(campaign_key(&"x".repeat(30)), "X".repeat(24));
    assert_eq!(campaign_key("  "), "");
}

#[test]
fn scenarios_match_js_files_and_results() {
    let fixture: Value = serde_json::from_str(include_str!("../fixtures/architect-usage.json")).expect("эталон");
    let start = fixture["start"].as_i64().expect("время");
    let mut failures = Vec::new();
    let mut steps = 0;
    for (index, scenario) in fixture["scenarios"].as_array().expect("сценарии").iter().enumerate() {
        let directory = tempfile::tempdir().expect("каталог");
        let file = directory.path().join(format!("usage-{index}.json"));
        let now = Arc::new(AtomicI64::new(start));
        let clock = Arc::clone(&now);
        let store = ArchitectUsageStore::new(&file, scenario.get("threshold"), Some(Arc::new(move || clock.load(Ordering::SeqCst)))).expect("счётчик");
        if Some(store.alert_threshold()) != scenario["alertThreshold"].as_i64() {
            failures.push(format!("сценарий {index}: порог {} против {}", store.alert_threshold(), scenario["alertThreshold"]));
        }
        for step in scenario["steps"].as_array().expect("шаги") {
            steps += 1;
            let id = step["id"].as_str().unwrap_or("");
            let out = match step["op"].as_str().unwrap_or("") {
                "write" => {
                    std::fs::write(&file, step["content"].as_str().unwrap_or("")).expect("файл");
                    None
                }
                "delete" => {
                    let _ = std::fs::remove_file(&file);
                    None
                }
                "now" => {
                    now.store(step["value"].as_i64().expect("время"), Ordering::SeqCst);
                    None
                }
                "record" => Some(store.record_generation(id).expect("запись").to_json()),
                "today" => Some(json!(store.generations_today(id))),
                "report" => Some(store.report()),
                other => panic!("неизвестный шаг {other}"),
            };
            if let Some(out) = out {
                if stringify(&out) != stringify(&step["out"]) {
                    failures.push(format!("сценарий {index}, {}: {} против {}", stringify(step), stringify(&out), stringify(&step["out"])));
                }
                let written = std::fs::read_to_string(&file).ok();
                if written.as_deref() != step["file"].as_str() {
                    failures.push(format!("сценарий {index}, {}: файл {written:?}", stringify(step)));
                }
            }
        }
    }
    for entry in fixture["alertTexts"].as_array().expect("тексты") {
        if architect_alert_text(entry["generations"].as_i64().unwrap_or(0)) != entry["text"].as_str().unwrap_or("") {
            failures.push(format!("текст {entry}"));
        }
    }
    assert!(steps > 100, "шагов {steps}");
    assert!(failures.is_empty(), "{} расхождений с JS:\n{}", failures.len(), failures.iter().take(6).cloned().collect::<Vec<_>>().join("\n"));
}

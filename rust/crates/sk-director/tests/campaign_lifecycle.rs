//! Эталоны JS `fixtures/campaign-lifecycle.json.gz` (генератор
//! `fixtures/gen-campaign-lifecycle.mjs`): вызовы тестов JS и случайные
//! состояния — итог сверяется строкой `JSON.stringify`, отказ — именем, кодом
//! и текстом.

use std::io::Read;
use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_core::js;
use sk_director::adventure_director::DirectorError;
use sk_director::campaign_lifecycle::*;

static FIXTURE: LazyLock<Value> = LazyLock::new(|| {
    let mut text = String::new();
    flate2::read::GzDecoder::new(&include_bytes!("../fixtures/campaign-lifecycle.json.gz")[..]).read_to_string(&mut text).expect("эталон gzip");
    serde_json::from_str(&text).expect("эталон JSON")
});

fn args(entry: &Value) -> Vec<Option<Value>> {
    let undef: Vec<u64> = entry["undef"].as_array().map(|items| items.iter().filter_map(Value::as_u64).collect()).unwrap_or_default();
    entry["args"].as_array().expect("аргументы").iter().enumerate().map(|(index, value)| (!undef.contains(&(index as u64))).then(|| value.clone())).collect()
}

fn call(fn_name: &str, args: &[Option<Value>]) -> Result<Value, DirectorError> {
    let a = |index: usize| args.get(index).and_then(Option::as_ref);
    let empty = json!({});
    // `state = {}`: отсутствующее состояние — пустой объект.
    let state = |index: usize| a(index).unwrap_or(&empty);
    Ok(match fn_name {
        "collectEpilogueFacts" => collect_epilogue_facts(state(0), a(1)),
        "normalizeCampaignLifecycle" => normalize_campaign_lifecycle(a(0), a(1)),
        "campaignIsReadOnly" => Value::Bool(campaign_is_read_only(state(0))),
        "assertCampaignPlayable" => assert_campaign_playable(state(0))?,
        "lifecycleEventForAction" => lifecycle_event_for_action(a(0), state(1), a(2))?,
        "buildDeterministicEpilogue" => Value::String(build_deterministic_epilogue(state(0), a(1))),
        "campaignCanAutoComplete" => Value::Bool(campaign_can_auto_complete(state(0))?),
        "campaignCanAdvanceArc" => Value::Bool(campaign_can_advance_arc(state(0))?),
        "campaignArcCarryOver" => campaign_arc_carry_over(state(0))?,
        "buildEpilogueNarrationBrief" => build_epilogue_narration_brief(state(0), a(1))?,
        other => panic!("неизвестная функция эталона: {other}"),
    })
}

#[test]
fn lifecycle_calls_match_js() {
    let cases = FIXTURE["calls"].as_array().expect("вызовы");
    let mut failures = Vec::new();
    for case in cases {
        let fn_name = case["fn"].as_str().expect("fn");
        let label = format!("{fn_name} {} {}", case["label"].as_str().unwrap_or(""), js::stringify(&case["args"]).chars().take(160).collect::<String>());
        let actual = match call(fn_name, &args(case)) {
            Ok(value) => json!({ "out": value }),
            Err(error) => json!({ "error": error.to_json() }),
        };
        let expected = match case.get("error") {
            Some(error) => json!({ "error": error }),
            None => json!({ "out": case["out"] }),
        };
        if js::stringify(&actual) != js::stringify(&expected) {
            failures.push(format!(
                "{label}\n  JS:   {}\n  Rust: {}",
                js::stringify(&expected).chars().take(700).collect::<String>(),
                js::stringify(&actual).chars().take(700).collect::<String>()
            ));
        }
    }
    assert!(failures.is_empty(), "{} расхождений из {}:\n{}", failures.len(), cases.len(), failures.iter().take(8).cloned().collect::<Vec<_>>().join("\n"));
    assert!(cases.len() > 1000, "вызовов: {}", cases.len());
}

fn state_with(lifecycle: Value) -> Value {
    json!({ "campaign": "Предел зимы", "players": [{ "id": "hero", "character": "Ада" }],
        "scene": { "location": "Северная башня", "objective": "Остановить бурю" }, "mechanics": { "campaign_lifecycle": lifecycle } })
}

fn options() -> Value {
    json!({ "actorId": "admin", "now": "2026-10-16T12:00:00.000Z" })
}

/// `test/campaign-lifecycle.test.mjs`: пауза, возобновление, завершение и архив по порядку.
#[test]
fn lifecycle_permits_pause_resume_completion_and_archival() {
    let mut state = state_with(json!({ "status": "active" }));
    for (action, status, event) in [("pause", "paused", "CampaignPaused"), ("resume", "active", "CampaignResumed"), ("complete", "completed", "CampaignCompleted"), ("archive", "archived", "CampaignArchived")] {
        let result = lifecycle_event_for_action(Some(&json!(action)), &state, Some(&options())).expect("переход");
        assert_eq!(result["event_type"], event);
        assert_eq!(result["payload"]["status"], status);
        state["mechanics"]["campaign_lifecycle"]["status"] = json!(status);
    }
    assert!(campaign_is_read_only(&state));
    let error = assert_campaign_playable(&state).expect_err("архив только для чтения");
    assert_eq!(error.code.as_deref(), Some("CAMPAIGN_READ_ONLY"));
}

/// Завершение во время боя запрещено; переход из конечного состояния — тоже.
#[test]
fn completion_is_rejected_during_combat_and_terminal_is_final() {
    let mut state = state_with(json!({ "status": "active" }));
    state["mechanics"]["combat"] = json!({ "active": true });
    let error = lifecycle_event_for_action(Some(&json!("complete")), &state, Some(&options())).expect_err("бой");
    assert_eq!(error.code.as_deref(), Some("CAMPAIGN_COMBAT_ACTIVE"));
    let completed = state_with(json!({ "status": "completed" }));
    let error = lifecycle_event_for_action(Some(&json!("resume")), &completed, Some(&options())).expect_err("конечное");
    assert_eq!(error.code.as_deref(), Some("INVALID_CAMPAIGN_TRANSITION"));
}

/// Старое поражение отряда читается как провал; провал фиксирует только сервер.
#[test]
fn legacy_party_defeat_normalizes_to_failed() {
    let lifecycle = normalize_campaign_lifecycle(Some(&json!({ "updated_at": "2026-01-01" })), Some(&json!("party_defeated")));
    assert_eq!(lifecycle["status"], "failed");
    assert_eq!(lifecycle["reason"], "party_final_death");
    assert_eq!(lifecycle["concluded_at"], "2026-01-01");
    let mut state = state_with(json!({ "status": "active" }));
    state["mechanics"]["death"] = json!({ "campaign_status": "party_defeated" });
    let error = lifecycle_event_for_action(Some(&json!("fail")), &state, Some(&options())).expect_err("не сервер");
    assert_eq!(error.code.as_deref(), Some("CAMPAIGN_FAILURE_NOT_CONFIRMED"));
    let system = json!({ "actorId": "system", "now": "2026-10-16T12:00:00.000Z" });
    let failed = lifecycle_event_for_action(Some(&json!("fail")), &state, Some(&system)).expect("провал");
    assert_eq!(failed["event_type"], "CampaignFailed");
    assert!(failed["payload"]["epilogue"].as_str().is_some_and(|text| text.contains("завершилась поражением")));
}

/// Эпилог — только из подтверждённого: скрытое задание в него не попадает.
#[test]
fn deterministic_epilogue_uses_only_visible_facts() {
    let mut state = state_with(json!({ "status": "active" }));
    state["worldMemory"] = json!({ "quests": [
        { "id": "quest:storm", "title": "Остановить бурю", "summary": "Буря рассеялась.", "status": "completed", "visibility": "party" },
        { "id": "quest:hidden", "title": "Скрытая цель круга", "summary": "Заговор.", "status": "completed", "visibility": "gm_only" },
        { "id": "quest:left", "title": "Вывести жителей", "summary": "", "status": "abandoned", "visibility": "party" },
    ] });
    let epilogue = build_deterministic_epilogue(&state, None);
    assert!(epilogue.starts_with("История «Предел зимы» завершена."), "{epilogue}");
    assert!(epilogue.contains("«Остановить бурю» завершён: Буря рассеялась"));
    assert!(epilogue.contains("«Вывести жителей» оставлен отрядом"));
    assert!(!epilogue.contains("Скрытая цель"));
    let facts = collect_epilogue_facts(&state, Some(&json!("failed")));
    assert_eq!(facts["outcome"], "failed");
    assert_eq!(facts["fact_keys"], json!(["hero:hero", "quest:quest:storm", "quest:quest:left"]));
}

//! Микробенч проекции зрителя (Ск2): время `campaign_state_for_viewer` и
//! `turn_result_for_viewer` на настоящем состоянии кампании в бою.
//!
//! Состояние снимает замер горячего пути:
//! `node rust/crates/sk-server/bench/hot-path.mjs --impl rust --dump-state <файл>`,
//! затем `SK_VIEWER_BENCH_STATE=<файл>` и запуск этого теста с `--ignored
//! --nocapture`. Без переменной тест ничего не делает.

use std::time::Instant;

use serde_json::{json, Value};
use sk_projection::viewer_projection::{campaign_state_for_viewer, turn_result_for_viewer};

fn median(mut samples: Vec<f64>) -> f64 {
    samples.sort_by(f64::total_cmp);
    samples[samples.len() / 2]
}

fn time(label: &str, rounds: usize, mut operation: impl FnMut()) {
    operation();
    let samples: Vec<f64> = (0..rounds)
        .map(|_| {
            let started = Instant::now();
            operation();
            started.elapsed().as_secs_f64() * 1e3
        })
        .collect();
    println!("{label:<44} median {:>8.2} ms", median(samples));
}

#[test]
#[ignore = "микробенч: SK_VIEWER_BENCH_STATE=<файл> cargo test --release -p sk-projection --test viewer_bench -- --ignored --nocapture"]
fn viewer_projection_bench() {
    let Ok(path) = std::env::var("SK_VIEWER_BENCH_STATE") else { return };
    let input: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("файл состояния")).expect("JSON");
    let state = &input["state"];
    let user = &input["user"];
    let actor = &input["actor_id"];
    let admin = json!({ "id": "admin", "role": "admin" });
    let rounds = 20;
    time("clone(state)", rounds, || drop(std::hint::black_box(state.clone())));
    time("serde_json::to_string(state)", rounds, || drop(std::hint::black_box(serde_json::to_string(state))));
    time("campaign_state_for_viewer(player)", rounds, || drop(std::hint::black_box(campaign_state_for_viewer(Some(state), Some(user), Some(actor)))));
    time("campaign_state_for_viewer(admin)", rounds, || drop(std::hint::black_box(campaign_state_for_viewer(Some(state), Some(&admin), Some(actor)))));
    let result = json!({ "authoritative_state": state, "mechanics": [], "state_version": state["state_version"], "narration": "", "room_version": 1 });
    time("turn_result_for_viewer(player)", rounds, || drop(std::hint::black_box(turn_result_for_viewer(Some(&result), Some(user), Some(actor)))));
    let projected = campaign_state_for_viewer(Some(state), Some(user), Some(actor)).expect("проекция").unwrap_or(Value::Null);
    time("serde_json::to_string(projected)", rounds, || drop(std::hint::black_box(serde_json::to_string(&projected))));
    time("sk_rules normalize_campaign_state", rounds, || drop(std::hint::black_box(sk_rules::normalize::normalize_campaign_state(state))));
}

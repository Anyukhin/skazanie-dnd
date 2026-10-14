//! Сверка `lockpicking` с эталоном JS.

mod common;

use common::{check, ok, ok_or_null, Outcome};
use serde_json::json;
use sk_ruleset::lockpicking as m;

#[test]
fn lockpicking_matches_js() {
    let count = check(include_str!("../fixtures/lockpicking.json"), |name, args| -> Outcome {
        match name {
            "const:LOCKPICKING_POLICY_ID" => ok(json!(m::LOCKPICKING_POLICY_ID)),
            "const:LOCKPICKING_SCHEMA_VERSION" => ok(json!(m::LOCKPICKING_SCHEMA_VERSION)),
            "const:THIEVES_TOOLS_ID" => ok(json!(m::THIEVES_TOOLS_ID)),
            "const:THIEVES_TOOLS_NAME" => ok(json!(m::THIEVES_TOOLS_NAME)),
            "const:THIEVES_TOOLS_REQUIRED_MESSAGE" => ok(json!(m::THIEVES_TOOLS_REQUIRED_MESSAGE)),
            "const:THIEVES_TOOLS_REQUIRED_CODE" => ok(json!(m::THIEVES_TOOLS_REQUIRED_CODE)),
            "const:LOCKPICK_NOISE_SEVERITY" => {
                ok(json!({ "failure": m::LOCKPICK_NOISE_SEVERITY.failure, "fumble": m::LOCKPICK_NOISE_SEVERITY.fumble }))
            }
            "const:LOCKPICK_TRACE_SHARE" => ok(json!(m::LOCKPICK_TRACE_SHARE)),
            "hasThievesTools" => ok(json!(m::has_thieves_tools(args.get(0)))),
            "lockpickingForViewer" => ok(m::lockpicking_for_viewer(args.get(0), args.option(1, "playerId"))),
            "lockpickNoiseFor" => ok_or_null(m::lockpick_noise_for(args.get(0))),
            "lockpickTraceNoticedFor" => {
                ok_or_null(m::lockpick_trace_noticed_for(args.get(0), args.option(1, "targetId"), args.option(1, "witnessIds")))
            }
            other => panic!("нет сверки для {other}"),
        }
    });
    assert!(count > 1000);
}

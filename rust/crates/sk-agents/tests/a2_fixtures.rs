//! Сверка задачи А2 с эталоном JS (`fixtures/gen-a2.mjs` → `fixtures/a2.json.gz`):
//! функции модулей npc-controller, scene-architect, director-agent,
//! hero-hooks, player-request-router и их роли с записывающей заглушкой модели.

mod a2_support;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};

use a2_support::{block_on, fixture, hash, resolve, role_client, RecordingLlm, Reply};
use serde_json::{json, Value};
use sk_agents::director_agent::{fallback_director_intent, DirectorAgent};
use sk_agents::hero_hooks::{self as hooks, HeroHookProposal, HeroHookWeaver, HeroHookWeaverConfig};
use sk_agents::npc_controller::{commands_for_morale_decision, is_morale_moment, NpcMoraleAgent};
use sk_agents::player_request_router as router;
use sk_agents::scene_architect::{self as architect, PlanRequest, SceneArchitectAgent};
use sk_core::js;

static FIXTURE: LazyLock<Value> = LazyLock::new(|| fixture("a2.json.gz"));

fn states() -> &'static [Value] {
    FIXTURE["states"].as_array().map(Vec::as_slice).unwrap_or(&[])
}

/// Аргумент случая: `undefined` (позиции из `undef`) — `None`.
struct Args<'a> {
    values: Vec<Value>,
    undef: Vec<usize>,
    _entry: &'a Value,
}

impl<'a> Args<'a> {
    fn new(entry: &'a Value) -> Self {
        let values = entry["args"].as_array().map(|items| items.iter().map(|item| resolve(item, states())).collect()).unwrap_or_default();
        let undef = entry.get("undef").and_then(Value::as_array).map(|items| items.iter().filter_map(Value::as_u64).map(|index| index as usize).collect()).unwrap_or_default();
        Args { values, undef, _entry: entry }
    }

    fn get(&self, index: usize) -> Option<&Value> {
        if self.undef.contains(&index) {
            return None;
        }
        self.values.get(index)
    }

    /// Состояние с параметром по умолчанию `{}`.
    fn state(&self, index: usize) -> Value {
        self.get(index).cloned().unwrap_or_else(|| json!({}))
    }

    /// `String(x ?? '')`.
    fn s(&self, index: usize) -> String {
        js::s(self.get(index))
    }

    /// `String(x || '')`.
    fn or_empty(&self, index: usize) -> String {
        if js::truthy(self.get(index)) {
            js::s(self.get(index))
        } else {
            String::new()
        }
    }

    /// `String(x)` с параметром по умолчанию `''`.
    fn string_default(&self, index: usize) -> String {
        match self.get(index) {
            None => String::new(),
            value => js::string(value),
        }
    }

    fn field(&self, index: usize, key: &str) -> Option<&Value> {
        self.get(index)?.as_object()?.get(key)
    }

    fn strings(&self, index: usize) -> Vec<String> {
        self.get(index).and_then(Value::as_array).map(|items| items.iter().map(|item| js::string(Some(item))).collect()).unwrap_or_default()
    }
}

fn opt(value: Option<Value>) -> Value {
    value.unwrap_or(Value::Null)
}

/// Исполнить случай функции; `None` — функции нет в переносе.
fn call(name: &str, args: &Args<'_>) -> Option<Result<Value, Value>> {
    let ok = |value: Value| Some(Ok(value));
    match name {
        "selectAgentRole" => ok(Value::from(router::select_agent_role(&args.or_empty(0)))),
        "roleAllowsWorldTools" => ok(Value::Bool(match args.get(0) {
            Some(Value::String(role)) => router::role_allows_world_tools(role),
            _ => true,
        })),
        "answerTableQuestion" => ok(opt(router::answer_table_question(&args.s(0), &args.state(1), args.field(2, "worldClock")))),
        "answerVisibleScene" => ok(opt(router::answer_visible_scene(&args.s(0), &args.state(1)))),
        "partyOptionLabel" => {
            let limit = args.get(1).filter(|value| !value.is_null()).map_or(router::PARTY_OPTION_LIMIT, |value| js::number(Some(value)) as usize);
            ok(Value::String(router::party_option_label(args.get(0), limit)))
        }
        "unknownDestinationReply" => {
            let revealed = |prop: &Value| !js::is_false(prop.get("revealed"));
            let filter: Option<&dyn Fn(&Value) -> bool> = if js::truthy(args.field(2, "revealedOnly")) { Some(&revealed) } else { None };
            ok(Value::String(router::unknown_destination_reply(&args.s(0), &args.state(1), filter)))
        }
        "proposeAgentInteraction" => ok(opt(router::propose_agent_interaction(&args.or_empty(0), &args.state(1), &js::s(args.field(2, "sourceText")), &js::s(args.field(2, "actorName"))))),
        "proposeRoutedTravel" => ok(opt(router::propose_routed_travel(args.get(0), &args.state(1), &args.s(2), &args.s(3)))),
        "answerKnownLore" => {
            let options = router::KnownLoreOptions { viewer: args.field(2, "viewer").cloned(), actor_id: args.field(2, "actorId").cloned() };
            ok(opt(router::answer_known_lore(&args.or_empty(0), &args.state(1), &options)))
        }
        "resolvePartyDecision" => ok(opt(router::resolve_party_decision(args.get(0), &args.state(1)))),
        "interpretResolvedPartyDecision" => ok(opt(architect::interpret_resolved_party_decision(args.get(0), &args.state(1)))),
        "buildDirectorPlanningBrief" => ok(architect::build_director_planning_brief(&args.state(0))),
        "knownDestinationsFrom" => ok(Value::Array(architect::known_destinations_from(&args.state(0)))),
        "fallbackDirectorIntent" => Some(fallback_director_intent(&args.state(0), &args.s(1)).map_err(|error| json!({ "code": error.code, "message": error.message }))),
        "isMoraleMoment" => ok(Value::Bool(is_morale_moment(&args.state(0), &args.s(1)))),
        "commandsForMoraleDecision" => {
            let ordinary = args.get(3).and_then(Value::as_array).cloned().unwrap_or_default();
            ok(Value::Array(commands_for_morale_decision(&args.state(0), &js::string(args.get(1)), args.get(2), ordinary)))
        }
        "heroHookThreadId" => ok(Value::String(hooks::hero_hook_thread_id(args.get(0)))),
        "heroHookIdempotencyKey" => ok(Value::String(hooks::hero_hook_idempotency_key(args.get(0)))),
        "heroHookFacts" => {
            let state = args.state(0);
            ok(Value::Array(hooks::hero_hook_facts(&state, &args.s(1)).into_iter().cloned().collect()))
        }
        "heroNeedsHooks" => ok(Value::Bool(hooks::hero_needs_hooks(&args.state(0), &args.string_default(1)))),
        "heroesNeedingHooks" => ok(json!(hooks::heroes_needing_hooks(&args.state(0)))),
        "heroHooksBrief" => ok(hooks::hero_hooks_brief(&args.state(0), &args.strings(1))),
        "normalizeHeroHookProposals" => {
            let raw = args.get(0).cloned().unwrap_or(Value::Null);
            let proposals = hooks::normalize_hero_hook_proposals(&raw, &args.state(1), &args.strings(2));
            ok(Value::Array(proposals.into_iter().map(|(key, proposal)| json!([key, proposal.to_json()])).collect()))
        }
        "heroHookCommands" => {
            let proposal = HeroHookProposal::from_json(args.get(2).unwrap_or(&Value::Null));
            ok(Value::Array(hooks::hero_hook_commands(&args.state(0), &args.string_default(1), &proposal)))
        }
        "partyMotivesForDirector" => ok(Value::Array(hooks::party_motives_for_director(&args.state(0)).iter().map(|entry| entry.to_json()).collect())),
        _ => None,
    }
}

fn short(value: &Value) -> String {
    let text = js::stringify(value);
    text.chars().take(1200).collect()
}

#[test]
fn functions_match_js() {
    let cases = FIXTURE["cases"].as_array().expect("cases");
    let mut checked = 0;
    let mut skipped = 0;
    let mut failures: Vec<String> = Vec::new();
    for (index, entry) in cases.iter().enumerate() {
        let name = entry["fn"].as_str().unwrap_or("");
        let args = Args::new(entry);
        if let Some(thrown) = entry.get("throws") {
            // Исключение JS на мусоре: исход фиксирован только там, где Rust
            // тоже возвращает отказ (политика Режиссёра).
            if name == "fallbackDirectorIntent" {
                if let Some(Err(error)) = call(name, &args) {
                    checked += 1;
                    if error["message"] != thrown["message"] || error["code"] != thrown["code"] {
                        failures.push(format!("#{index} {name}: отказ {} против {}", short(&error), short(thrown)));
                    }
                    continue;
                }
            }
            skipped += 1;
            continue;
        }
        let Some(result) = call(name, &args) else { panic!("неизвестная функция {name}") };
        checked += 1;
        let actual = match result {
            Ok(value) => value,
            Err(error) => json!({ "rust_error": error }),
        };
        if actual != entry["out"] {
            failures.push(format!("#{index} {name} [{}]\n  rust: {}\n  js:   {}", entry["src"].as_str().unwrap_or(""), short(&actual), short(&entry["out"])));
        }
    }
    eprintln!("функции: сверено {checked}, пропущено исключений JS {skipped}, расхождений {}", failures.len());
    assert!(failures.is_empty(), "{} расхождений, первые:\n{}", failures.len(), failures.iter().take(15).cloned().collect::<Vec<_>>().join("\n"));
    assert!(checked > 10_000, "мало случаев: {checked}");
}

fn replies(entry: &Value) -> Vec<Reply> {
    entry["replies"].as_array().map(|items| items.iter().map(Reply::from_fixture).collect()).unwrap_or_default()
}

fn run_role(entry: &Value) -> (Result<Value, Value>, Vec<Value>) {
    let args = Args::new(entry);
    let with_client = !entry["replies"].is_null();
    let llm = RecordingLlm::new(replies(entry), entry["model"].as_str());
    let client = with_client.then(|| role_client(&llm));
    let result = match entry["cls"].as_str().unwrap_or("") {
        "DirectorAgent" => {
            let mode = args.get(2).filter(|mode| !mode.is_null());
            block_on(DirectorAgent::new(client).choose(&args.state(0), &args.s(1), mode)).map_err(|error| json!({ "code": error.code, "message": error.message }))
        }
        "NpcMoraleAgent" => Ok(opt(block_on(NpcMoraleAgent::new(client).decide(&args.state(0), &args.s(1))))),
        "SceneArchitectAgent" => {
            let options = args.get(1);
            let field = |key: &str| options.and_then(|options| options.get(key));
            let request = PlanRequest {
                action: js::s(field("action")),
                decision: js::s(field("decision")),
                destination_hint: js::s(field("destinationHint")),
                destination_location_id: js::s(field("destinationLocationId")),
                abandons_quest: js::truthy(field("abandonsQuest")),
            };
            Ok(block_on(SceneArchitectAgent::new(client).plan(&args.state(0), &request)))
        }
        "HeroHookWeaver" => {
            let state = args.state(0);
            let times: Vec<f64> = args.get(4).and_then(Value::as_array).map(|items| items.iter().map(|item| js::number(Some(item))).collect()).unwrap_or_default();
            let tick = Arc::new(AtomicUsize::new(0));
            let clock_tick = tick.clone();
            let clock_times = times.clone();
            let config = args.get(3);
            let weaver = HeroHookWeaver::new(HeroHookWeaverConfig {
                llm_client: client,
                max_attempts_per_hero: config.and_then(|config| config.get("maxAttemptsPerHero")).cloned(),
                retry_ms: config.and_then(|config| config.get("retryMs")).cloned(),
                now: Some(Arc::new(move || clock_times[clock_tick.load(Ordering::SeqCst).min(clock_times.len() - 1)])),
            });
            let hero_ids = args.get(2).and_then(Value::as_array).cloned();
            let first = block_on(weaver.weave(&state, "CAMP", hero_ids.as_deref()));
            tick.store(1, Ordering::SeqCst);
            let pending = weaver.pending_hero_ids(&state, "CAMP");
            let left: Vec<bool> = state["players"].as_array().map(|players| players.iter().map(|hero| weaver.attempts_left("CAMP", &js::string(hero.get("id")))).collect()).unwrap_or_default();
            let second = block_on(weaver.weave(&state, "CAMP", None));
            Ok(json!({ "first": first, "pending": pending, "left": left, "second": second }))
        }
        other => panic!("неизвестная роль {other}"),
    };
    (result, llm.calls())
}

#[test]
fn roles_match_js() {
    let roles = FIXTURE["roles"].as_array().expect("roles");
    let mut failures: Vec<String> = Vec::new();
    let mut by_class: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    let mut skipped = 0;
    for (index, entry) in roles.iter().enumerate() {
        let class = entry["cls"].as_str().unwrap_or("").to_string();
        *by_class.entry(class.clone()).or_default() += 1;
        let (result, calls) = run_role(entry);
        let actual = match (&result, entry.get("throws")) {
            (Err(error), Some(thrown)) => {
                if error["message"] != thrown["message"] {
                    failures.push(format!("#{index} {class}: отказ {} против {}", short(error), short(thrown)));
                }
                continue;
            }
            // TypeError JS на мусоре (точка карты без имени у `fallbackPlan`): Rust не
            // падает — расхождение записано в отчёте («Замечено в JS»).
            (Ok(_), Some(thrown)) if thrown["name"] == "TypeError" => {
                skipped += 1;
                continue;
            }
            (Ok(value), _) => value.clone(),
            (Err(error), None) => json!({ "rust_error": error }),
        };
        if actual != entry["out"] {
            failures.push(format!("#{index} {class} итог\n  rust: {}\n  js:   {}", short(&actual), short(&entry["out"])));
            continue;
        }
        let calls = Value::Array(calls);
        if hash(&calls) != entry["calls_hash"].as_str().unwrap_or("") {
            let expected = entry.get("calls").map(short).unwrap_or_else(|| "(только хеш)".into());
            failures.push(format!("#{index} {class} запросы к модели\n  rust: {}\n  js:   {expected}", short(&calls)));
        }
    }
    eprintln!("роли: {by_class:?}, пропущено TypeError JS {skipped}, расхождений {}", failures.len());
    assert!(failures.is_empty(), "{} расхождений, первые:\n{}", failures.len(), failures.iter().take(10).cloned().collect::<Vec<_>>().join("\n"));
    for class in ["DirectorAgent", "NpcMoraleAgent", "SceneArchitectAgent", "HeroHookWeaver"] {
        assert!(by_class.get(class).copied().unwrap_or(0) >= 30, "мало случаев роли {class}");
    }
}

/// Полные запросы первых случаев роли совпадают с записанными в эталоне —
/// подсказка при расхождении хеша.
#[test]
fn first_role_calls_are_recorded_in_full() {
    let roles = FIXTURE["roles"].as_array().expect("roles");
    for entry in roles.iter().filter(|entry| entry.get("calls").is_some()) {
        let (_, calls) = run_role(entry);
        let calls = Value::Array(calls);
        assert_eq!(hash(&calls), entry["calls_hash"].as_str().unwrap_or(""));
        assert_eq!(&calls, &entry["calls"]);
    }
}

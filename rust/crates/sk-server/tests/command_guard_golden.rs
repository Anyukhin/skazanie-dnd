//! Эталон «Г» С16: `fixtures/command-guard.json` снят генератором
//! `fixtures/gen-c16.mjs` с исходников `server/index.mjs` (функции вырезаны по
//! диапазонам строк, зависимости — заглушки). Здесь те же входы идут в
//! `command_guard`/`command_fingerprints`; сравнение — по строке
//! `JSON.stringify` (порядок ключей и запись чисел как в JS), включая отказы
//! (код и текст), вопросы о членстве, повтор журнала и вызовы модели.

use std::cell::RefCell;

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_server::command_fingerprints as fp;
use sk_server::command_guard as guard;
use sk_server::command_guard::{Caller, CourierReplyModel, GuardResult, Memberships, ReplyFuture};
use sk_server::error::Failure;

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/command-guard.json");

/// Членство кампании из случая: `true`/`false` или `"throw"`; вопросы пишутся.
struct FakeMemberships {
    answer: Value,
    calls: RefCell<Vec<String>>,
}

impl Memberships for FakeMemberships {
    fn campaign_has_memberships(&self, campaign_id: &str) -> GuardResult<bool> {
        self.calls.borrow_mut().push(campaign_id.to_string());
        if self.answer.as_str() == Some("throw") {
            return Err(Failure::new("Некорректный код кампании", Some("INVALID_CAMPAIGN_ID")));
        }
        Ok(self.answer == Value::Bool(true))
    }
}

/// Модель почты из случая: ответ, `null` или `"throw"`; вход пишется без состояния.
struct FakeModel<'a> {
    has_model: bool,
    reply: Value,
    state: Option<&'a Value>,
    calls: RefCell<Vec<Value>>,
}

impl CourierReplyModel for FakeModel<'_> {
    fn has_model(&self) -> bool {
        self.has_model
    }

    fn respond<'b>(&'b self, input: Value) -> ReplyFuture<'b> {
        let field = |key: &str| input.get(key).cloned().filter(|value| !value.is_null()).unwrap_or(Value::Null);
        self.calls.borrow_mut().push(json!({
            "playerId": field("playerId"),
            "npcId": field("npcId"),
            "message": input.get("message").cloned(),
            "turnId": input.get("turnId").cloned(),
            "state": self.state.is_some_and(|state| input.get("state") == Some(state)),
        }));
        let reply = self.reply.clone();
        Box::pin(async move {
            match reply {
                Value::String(text) if text == "throw" => Err("провайдер молчит".to_string()),
                Value::Null => Ok(None),
                other => Ok(Some(other)),
            }
        })
    }
}

fn resolve(value: &Value, fixture: &Value) -> Value {
    if let Some(id) = value.get("$state").and_then(Value::as_str) {
        return fixture["states"][id].clone();
    }
    if let Some(id) = value.get("$user").and_then(Value::as_str) {
        return fixture["users"][id].clone();
    }
    value.clone()
}

fn outcome<T>(result: GuardResult<T>, ok: impl FnOnce(T) -> Value) -> Value {
    match result {
        Ok(value) => json!({ "ok": ok(value) }),
        Err(error) => json!({ "err": { "code": error.code, "message": error.message } }),
    }
}

fn string_list(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::as_array).cloned().unwrap_or_default()
}

/// Прогон одного случая в форме `{ out, calls?, authorized?, after?, respond? }`.
fn run_case(case: &Value, fixture: &Value, runtime: &tokio::runtime::Runtime) -> Value {
    let name = case["fn"].as_str().unwrap_or_default();
    let undef: Vec<usize> = case.get("undef").and_then(Value::as_array).map(|list| list.iter().filter_map(Value::as_u64).map(|index| index as usize).collect()).unwrap_or_default();
    let args: Vec<Option<Value>> = case["args"].as_array().map(|list| list.iter().enumerate().map(|(index, value)| (!undef.contains(&index)).then(|| resolve(value, fixture))).collect()).unwrap_or_default();
    let arg = |index: usize| args.get(index).and_then(Option::as_ref);
    let env = case.get("env").cloned().unwrap_or_else(|| json!({}));
    let memberships = FakeMemberships { answer: env.get("memberships").cloned().unwrap_or(Value::Bool(false)), calls: RefCell::new(Vec::new()) };
    let duplicate = env.get("duplicate").cloned().unwrap_or(Value::Null);
    let journal = move |_: &str, _: &str| -> Result<Option<Value>, Failure> {
        match &duplicate {
            Value::Null => Ok(None),
            Value::String(text) if text == "throw" => Err(Failure::new("Журнал недоступен", Some("STORE_UNAVAILABLE"))),
            other => Ok(Some(other.clone())),
        }
    };
    let null = Value::Null;
    let user = arg(0).unwrap_or(&null);
    let caller = Caller::new(user, &memberships);
    let state = arg(1).unwrap_or(&null);
    let input = arg(2).unwrap_or(&null);
    let mut extra = Map::new();
    let out = match name {
        "canUseHero" => outcome(caller.can_use_hero(arg(1), arg(2)), Value::Bool),
        "commandType" => json!({ "ok": guard::command_type(arg(0).unwrap_or(&null)) }),
        "lootTakenRecordFor" => json!({ "ok": guard::loot_taken_record_for(arg(0).unwrap_or(&null), arg(1)) }),
        "merchantCommandFingerprint" => json!({ "ok": fp::merchant_command_fingerprint(arg(0).unwrap_or(&null)) }),
        "itemCommandFingerprint" => json!({ "ok": fp::item_command_fingerprint(arg(0).unwrap_or(&null)) }),
        "makeAttackCommandFingerprint" => json!({ "ok": fp::make_attack_command_fingerprint(arg(0).unwrap_or(&null)) }),
        "restCommandFingerprint" => json!({ "ok": fp::rest_command_fingerprint(arg(0).unwrap_or(&null)) }),
        "lootCommandFingerprint" => json!({ "ok": fp::loot_command_fingerprint(arg(0).unwrap_or(&null)) }),
        "characterBuildFingerprint" => json!({ "ok": fp::character_build_fingerprint(arg(0).unwrap_or(&null)) }),
        "authoritativeCombatCommandBase" => json!({ "ok": guard::authoritative_combat_command_base(arg(0).unwrap_or(&null)) }),
        "normalizeMakeAttackCommand" => outcome(guard::normalize_make_attack_command(arg(0).unwrap_or(&null), None), |value| value),
        "makeAttackEventFingerprints" => json!({ "ok": fp::make_attack_event_fingerprints(arg(0)) }),
        "assertMakeAttackIdempotency" => {
            let mode = env.get("authorize").and_then(Value::as_str).map(str::to_string);
            let mut authorized = 0;
            let commands = string_list(arg(2));
            let result = {
                let mut authorize = |_: &Value| -> GuardResult<()> {
                    authorized += 1;
                    if mode.as_deref() == Some("throw") {
                        return Err(Failure::new("Команда доступна только владельцу героя или его призванного существа", Some("ACTOR_FORBIDDEN")));
                    }
                    Ok(())
                };
                let callback: Option<&mut fp::AuthorizeDuplicate<'_>> = if mode.is_some() { Some(&mut authorize as &mut fp::AuthorizeDuplicate<'_>) } else { None };
                fp::assert_make_attack_idempotency(&journal, "C", "k", &commands, callback)
            };
            extra.insert("authorized".into(), json!(authorized));
            outcome(result, Value::Bool)
        }
        "assertMakeAttackResultFingerprint" => outcome(fp::assert_make_attack_result_fingerprint(arg(0).unwrap_or(&null), &string_list(arg(1))), |()| Value::Null),
        "assertNpcCombatActorPermission" => outcome(guard::assert_npc_combat_actor_permission(&caller, state, input), Value::String),
        "sanitizePlayerNpcCombatCommand" => outcome(guard::sanitize_player_npc_combat_command(&caller, state, input), |value| value),
        "assertNpcCombatIdempotency" => outcome(fp::assert_npc_combat_idempotency(&journal, "C", "k", input), |()| Value::Null),
        "assertNpcCombatResultFingerprint" => outcome(fp::assert_npc_combat_result_fingerprint(arg(0).unwrap_or(&null), state), |()| Value::Null),
        "assertRestIdempotency" => {
            let mut command = input.clone();
            let result = fp::assert_rest_idempotency(&journal, "C", "k", &mut command);
            extra.insert("after".into(), command);
            outcome(result, |()| Value::Null)
        }
        "assertRestResultFingerprint" => outcome(fp::assert_rest_result_fingerprint(arg(0).unwrap_or(&null), state), |()| Value::Null),
        "assertItemIdempotency" => outcome(fp::assert_item_idempotency(&journal, "C", "k", input), |()| Value::Null),
        "assertItemResultFingerprint" => outcome(fp::assert_item_result_fingerprint(arg(0).unwrap_or(&null), state), |()| Value::Null),
        "assertLootIdempotency" => outcome(fp::assert_loot_idempotency(&journal, "C", "k", input), |()| Value::Null),
        "assertLootResultFingerprint" => outcome(fp::assert_loot_result_fingerprint(arg(0).unwrap_or(&null), state), |()| Value::Null),
        "assertCharacterBuildResultFingerprint" => outcome(fp::assert_character_build_result_fingerprint(arg(0).unwrap_or(&null), &string_list(arg(1))), |()| Value::Null),
        "combatActorFor" => outcome(guard::combat_actor_for(arg(0).unwrap_or(&null), arg(1)), |actor| actor.cloned().unwrap_or(Value::Null)),
        "assertPlayerCombatActorPermission" => outcome(guard::assert_player_combat_actor_permission(&caller, state, input), Value::clone),
        "sanitizePlayerCombatCommand" => {
            let skip = js::truthy(arg(3).and_then(|options| options.get("skipAttackTargetPolicy")));
            outcome(guard::sanitize_player_combat_command(&caller, state, input, skip), |value| value)
        }
        "sanitizePlayerRestCommand" => outcome(guard::sanitize_player_rest_command(&caller, state, input), |value| value),
        "expandPlayerRestCommand" => json!({ "ok": guard::expand_player_rest_command(arg(0).unwrap_or(&null)) }),
        "sanitizePlayerCharacterCommand" => outcome(guard::sanitize_player_character_command(&caller, state, input), |value| value),
        "sanitizePlayerPickpocketCommand" => outcome(guard::sanitize_player_pickpocket_command(&caller, state, input), |value| value),
        "sanitizePlayerCaptiveCommand" => outcome(guard::sanitize_player_captive_command(&caller, state, input), |value| value),
        "sanitizePlayerLootCommand" => outcome(guard::sanitize_player_loot_command(&caller, state, input), |value| value),
        "sanitizePlayerBeastCommand" => outcome(guard::sanitize_player_beast_command(&caller, state, input), |value| value),
        "sanitizePlayerLawCommand" => outcome(guard::sanitize_player_law_command(&caller, state, input), |value| value),
        "sanitizePlayerTavernCommand" => outcome(guard::sanitize_player_tavern_command(&caller, state, input), |value| value),
        "sanitizePlayerBlessingCommand" => outcome(guard::sanitize_player_blessing_command(&caller, state, input), |value| value),
        "sanitizePlayerDialogueCommand" => outcome(guard::sanitize_player_dialogue_command(&caller, state, input), |value| value),
        "sanitizePlayerLetterCommand" => outcome(guard::sanitize_player_letter_command(&caller, state, input), |value| value),
        "sanitizePlayerItemCommand" => outcome(guard::sanitize_player_item_command(&caller, state, input), |value| value),
        "sanitizeMerchantCommand" => outcome(guard::sanitize_merchant_command(&caller, state, input, arg(3)), |value| value),
        "withCourierReplyDraft" => {
            let letter_state = arg(0).unwrap_or(&null);
            let model = FakeModel { has_model: js::is_true(env.get("model")), reply: env.get("reply").cloned().unwrap_or(Value::Null), state: Some(letter_state), calls: RefCell::new(Vec::new()) };
            let command = arg(1).cloned().unwrap_or(Value::Null);
            let drafted = runtime.block_on(guard::with_courier_reply_draft(&model, letter_state, command));
            extra.insert("respond".into(), Value::Array(model.calls.into_inner()));
            json!({ "ok": drafted })
        }
        other => json!({ "unknown": other }),
    };
    let mut result = Map::new();
    result.insert("out".into(), out);
    let calls = memberships.calls.into_inner();
    if !calls.is_empty() {
        result.insert("calls".into(), js::strings_value(calls));
    }
    for (key, value) in extra {
        result.insert(key, value);
    }
    Value::Object(result)
}

fn expected_of(case: &Value) -> Value {
    let mut expected = Map::new();
    for key in ["out", "calls", "authorized", "after", "respond"] {
        if let Some(value) = case.get(key) {
            expected.insert(key.into(), value.clone());
        }
    }
    Value::Object(expected)
}

fn same_list(actual: &[&str], expected: &Value) -> bool {
    let actual: Vec<Value> = actual.iter().map(|item| Value::String((*item).to_string())).collect();
    js::stringify(&Value::Array(actual)) == js::stringify(expected)
}

#[test]
fn command_guard_matches_js_golden() {
    let text = std::fs::read_to_string(FIXTURE).unwrap_or_default();
    assert!(!text.is_empty(), "нет эталона {FIXTURE}: node rust/crates/sk-server/fixtures/gen-c16.mjs");
    let fixture: Value = serde_json::from_str(&text).unwrap_or_else(|error| panic!("эталон не разобрался: {error}"));
    let sets = &fixture["sets"];
    let die: Vec<Value> = guard::PUBLIC_DIE_SIDES.iter().map(|side| Value::from(*side)).collect();
    assert_eq!(js::stringify(&Value::Array(die)), js::stringify(&sets["PUBLIC_DIE_SIDES"]), "PUBLIC_DIE_SIDES");
    let named: [(&str, &[&str]); 24] = [
        ("PLAYER_COMBAT_COMMANDS", guard::PLAYER_COMBAT_COMMANDS),
        ("PLAYER_NPC_COMBAT_COMMANDS", guard::PLAYER_NPC_COMBAT_COMMANDS),
        ("PLAYER_REST_COMMANDS", guard::PLAYER_REST_COMMANDS),
        ("PLAYER_CHARACTER_COMMANDS", guard::PLAYER_CHARACTER_COMMANDS),
        ("PLAYER_CHARACTER_LIFECYCLE_COMMANDS", guard::PLAYER_CHARACTER_LIFECYCLE_COMMANDS),
        ("PLAYER_ITEM_COMMANDS", guard::PLAYER_ITEM_COMMANDS),
        ("PLAYER_MERCHANT_COMMANDS", guard::PLAYER_MERCHANT_COMMANDS),
        ("PLAYER_PICKPOCKET_COMMANDS", guard::PLAYER_PICKPOCKET_COMMANDS),
        ("PLAYER_CAPTIVE_COMMANDS", guard::PLAYER_CAPTIVE_COMMANDS),
        ("PLAYER_BEAST_COMMANDS", guard::PLAYER_BEAST_COMMANDS),
        ("PLAYER_LAW_COMMANDS", guard::PLAYER_LAW_COMMANDS),
        ("PLAYER_LOOT_COMMANDS", guard::PLAYER_LOOT_COMMANDS),
        ("LOOT_STALE_ERROR_CODES", guard::LOOT_STALE_ERROR_CODES),
        ("PLAYER_TAVERN_COMMANDS", guard::PLAYER_TAVERN_COMMANDS),
        ("PLAYER_LETTER_COMMANDS", guard::PLAYER_LETTER_COMMANDS),
        ("PLAYER_BLESSING_COMMANDS", guard::PLAYER_BLESSING_COMMANDS),
        ("PLAYER_DIALOGUE_COMMANDS", guard::PLAYER_DIALOGUE_COMMANDS),
        ("ADMIN_MERCHANT_LIFECYCLE_COMMANDS", guard::ADMIN_MERCHANT_LIFECYCLE_COMMANDS),
        ("SERVER_WORLD_COMMANDS", guard::SERVER_WORLD_COMMANDS),
        ("SERVER_ENCOUNTER_COMMANDS", guard::SERVER_ENCOUNTER_COMMANDS),
        ("NPC_COMBAT_PRIMARY_EVENT_TYPES", fp::NPC_COMBAT_PRIMARY_EVENT_TYPES),
        ("REST_PRIMARY_EVENT_TYPES", fp::REST_PRIMARY_EVENT_TYPES),
        ("ITEM_PRIMARY_EVENT_TYPES", fp::ITEM_PRIMARY_EVENT_TYPES),
        ("LOOT_PRIMARY_EVENT_TYPES", fp::LOOT_PRIMARY_EVENT_TYPES),
    ];
    for (name, actual) in named {
        assert!(same_list(actual, &sets[name]), "набор {name}: Rust {actual:?}, JS {}", sets[name]);
    }

    let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap_or_else(|error| panic!("рантайм: {error}"));
    let cases = fixture["cases"].as_array().cloned().unwrap_or_default();
    assert!(cases.len() > 10_000, "эталон слишком мал: {}", cases.len());
    let mut failures = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let actual = run_case(case, &fixture, &runtime);
        let expected = expected_of(case);
        if js::stringify(&actual) != js::stringify(&expected) {
            failures.push(format!("#{index} {}\n  args: {}\n  env: {}\n  JS:   {}\n  Rust: {}", case["fn"], js::stringify(&case["args"]).chars().take(600).collect::<String>(), case.get("env").map(js::stringify).unwrap_or_default(), js::stringify(&expected), js::stringify(&actual)));
        }
    }
    let mut by_fn: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for failure in &failures {
        let name = failure.split_whitespace().nth(1).unwrap_or_default().to_string();
        *by_fn.entry(name).or_default() += 1;
    }
    assert!(failures.is_empty(), "{} из {} случаев расходятся с JS ({by_fn:?}):\n{}", failures.len(), cases.len(), failures.iter().take(15).cloned().collect::<Vec<_>>().join("\n"));
}

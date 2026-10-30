//! Сверка задачи Р8 с эталоном JS (`fixtures/r8.json.gz`, генератор —
//! `fixtures/gen-r8.mjs`): форма броска атаки, шанс d20, прогноз удара,
//! оружие по умолчанию, предпросмотры подхода, прыжка и swing, люстра по
//! тексту, особое действие существа; блоки проверки 28–29 и 66–68; полный
//! `resolveCommand` веток `MakeAttack`, `ChangeWeapon`, `MakeAreaAttack`,
//! `UseMonsterAction`, `UseLegendaryAction` (мягкая проверка блоков других
//! задач). Разбор, дошедший до заглушки другой задачи, считается отдельно.

use std::io::Read;
use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_core::js;
use sk_dice::{DiceError, DiceService, Rng};
use sk_rules::context::{sequence_uuids, Context};
use sk_rules::dice_record::ServiceDice;
use sk_rules::outcome::Outcome;
use sk_rules::pause::Halt;
use sk_rules::preview_attack as pa;
use sk_rules::resolve::api;

const FIXTURE: &[u8] = include_bytes!("../fixtures/r8.json.gz");
static DATA: LazyLock<Value> = LazyLock::new(|| {
    let mut text = String::new();
    flate2::read::GzDecoder::new(FIXTURE).read_to_string(&mut text).expect("эталон — gzip");
    serde_json::from_str(&text).expect("эталон — JSON")
});
static NORMALIZED: LazyLock<Vec<Value>> = LazyLock::new(|| {
    DATA["states"].as_array().expect("состояния").iter().map(|state| sk_rules::normalize::normalize_campaign_state(state).expect("нормализация")).collect()
});

const U: &str = "__undefined__";

fn deep(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(map.iter().filter(|(_, field)| field.as_str() != Some(U)).map(|(key, field)| (key.clone(), deep(field))).collect()),
        Value::Array(items) => Value::Array(items.iter().map(|item| if item.as_str() == Some(U) { Value::Null } else { deep(item) }).collect()),
        other => other.clone(),
    }
}

/// Аргумент: `None` — `undefined`.
fn arg(args: &Value, index: usize) -> Option<Value> {
    let item = args.get(index)?;
    if item.as_str() == Some(U) {
        None
    } else {
        Some(deep(item))
    }
}

fn out(value: &Value) -> Value {
    let text = js::stringify(value);
    if text.encode_utf16().count() > 160 && std::env::var_os("SK_R8_FULL").is_none() {
        Value::String(format!("sha256:{}", sk_core::hash::sha256_hex(text.as_bytes())))
    } else {
        value.clone()
    }
}

fn outcome(result: Result<Value, Halt>) -> Value {
    match result {
        Ok(value) => json!({ "ok": out(&value) }),
        Err(Halt::Rule(error)) => json!({ "err": [error.code, error.message] }),
        Err(Halt::Fault(fault)) => json!({ "fault": fault.name }),
    }
}

fn expected_outcome(expected: &Value) -> Value {
    match expected.get("fault") {
        Some(name) => json!({ "fault": name }),
        None => expected.clone(),
    }
}

fn report(failures: &[String], total: usize) {
    let limit = if std::env::var_os("SK_R8_FULL").is_some() { 400 } else { 10 };
    assert!(failures.is_empty(), "расхождений {} из {total}:\n{}", failures.len(), failures.iter().take(limit).cloned().collect::<Vec<_>>().join("\n"));
}

/// Кости по кругу, как `CycleDiceRng` генератора.
struct CycleRng {
    values: Vec<i64>,
    index: usize,
}

impl Rng for CycleRng {
    fn randint(&mut self, minimum: i64, maximum: i64) -> Result<i64, DiceError> {
        let value = self.values.get(self.index % self.values.len().max(1)).copied().unwrap_or(1);
        self.index += 1;
        Ok(minimum + (value - 1).rem_euclid(maximum - minimum + 1))
    }
}

fn cycle(values: &Value) -> ServiceDice<DiceService<CycleRng>> {
    let values: Vec<i64> = values.as_array().map(|items| items.iter().filter_map(Value::as_i64).collect()).unwrap_or_default();
    ServiceDice::new(DiceService::deterministic(CycleRng { values, index: 0 }, "roll"))
}

fn text(value: &Option<Value>) -> String {
    js::s(value.as_ref())
}

fn position(state: &Value, id: &str) -> Option<sk_geometry::Point> {
    sk_rules::tactical_geometry::actor_point(state, id)
}

fn run_call(f: &str, s: usize, args: &Value) -> Result<Value, Halt> {
    let state = &NORMALIZED[s];
    let raw = &DATA["states"][s];
    let a = |index: usize| arg(args, index);
    match f {
        "attackForecast" => {
            let options = a(2).unwrap_or(Value::Null);
            let field = |key: &str| options.get(key).filter(|value| !value.is_null());
            let forecast = pa::attack_forecast(
                state,
                &text(&a(0)),
                &text(&a(1)),
                pa::ForecastOptions { action_id: field("actionId"), item_id: field("itemId"), attack_mode: field("attackMode"), attack_ability: field("attackAbility") },
            )?;
            Ok(forecast.unwrap_or(Value::Null))
        }
        "attackSwingShape" => {
            let attacker_id = text(&a(0));
            let target_id = text(&a(1));
            let actor = sk_core::game::find_actor(state, &attacker_id);
            let kind = text(&a(2));
            let item = a(3).filter(|value| js::truthy(Some(value)));
            let profile = match kind.as_str() {
                "trusted" => match actor {
                    Some(actor) => Some(sk_rules::combat::weapons::trusted_attack_profile(state, Some(actor), None)?),
                    None => None,
                },
                "item" => match (actor, &item) {
                    (Some(actor), Some(item)) => sk_rules::combat::weapons::item_attack_profile(state, Some(actor), Some(item), Default::default()),
                    _ => None,
                },
                _ => None,
            };
            let actor_at = position(state, &attacker_id);
            let target_at = position(state, &target_id);
            let distance_feet = if actor_at.is_some() && target_at.is_some() { sk_rules::geometry::footprint::distance_between_actor_positions(state, &attacker_id, actor_at, &target_id, target_at) } else { None };
            let options = pa::SwingOptions {
                actor_at,
                target_at,
                distance_feet,
                condition_modifiers: None,
                command_advantage: js::truthy(a(4).as_ref()),
                command_disadvantage: js::truthy(a(5).as_ref()),
                extra_advantage: js::truthy(a(6).as_ref()),
            };
            Ok(pa::attack_swing_shape(state, &attacker_id, &target_id, profile.as_ref(), options).to_value())
        }
        "defaultAttackItemIdFor" => Ok(pa::default_attack_item_id_for(raw, &text(&a(0)), &text(&a(1)))?.map_or(Value::Null, Value::String)),
        "serverOwnedMonsterActor" => Ok(Value::Bool(pa::server_owned_monster_actor(sk_core::game::find_actor(state, &text(&a(0))), state).is_some())),
        "previewApproachAttack" => pa::preview_approach_attack(raw, &text(&a(0)), &text(&a(1))),
        "previewLongJumpAttack" => pa::preview_long_jump_attack(raw, &text(&a(0)), &text(&a(1)), js::truthy(a(2).as_ref())),
        "previewSwingAttack" => pa::preview_swing_attack(raw, &text(&a(0)), &text(&a(1)), a(2).as_ref(), js::truthy(a(3).as_ref())),
        "swingPropForText" => Ok(pa::swing_prop_for_text(raw, a(0).as_ref())?.unwrap_or(Value::Null)),
        "previewMonsterAction" => Ok(pa::preview_monster_action(raw, &js::string(a(0).as_ref()), a(1).as_ref(), a(2).as_ref())?.to_value()),
        "d20HitChance" => {
            let value = pa::d20_hit_chance(js::number(a(0).as_ref()), js::truthy(a(1).as_ref()), js::truthy(a(2).as_ref()));
            Ok(js::num(value))
        }
        other => panic!("неизвестный вызов {other}"),
    }
}

#[test]
fn previews_match_js() {
    let calls = DATA["calls"].as_array().expect("вызовы");
    let mut failures = Vec::new();
    for case in calls {
        let f = case["f"].as_str().expect("имя");
        let s = case["s"].as_u64().expect("состояние") as usize;
        let actual = outcome(api::with_lenient_validation(|| run_call(f, s, &case["a"])));
        let expected = expected_outcome(&case["o"]);
        if js::stringify(&actual) != js::stringify(&expected) {
            failures.push(format!("{f} s={s} a={}: Rust {} ожидалось {}", js::stringify(&case["a"]).chars().take(300).collect::<String>(), actual, expected));
        }
    }
    report(&failures, calls.len());
}

#[test]
fn validate_blocks_match_js() {
    let cases = DATA["blocks"].as_array().expect("блоки");
    let named = |name: &str| sk_rules::validate::BLOCKS.iter().find(|block| block.name == name).expect("блок").check;
    let legendary = [named("check_legendary_action"), named("check_monster_action")];
    let attack = [named("check_make_attack"), named("check_change_weapon"), named("check_make_area_attack")];
    let mut failures = Vec::new();
    for case in cases {
        let s = case["s"].as_u64().expect("состояние") as usize;
        let context = Context::from_json(&case["context"]);
        let mut validation = sk_rules::validate::Validation { state: &NORMALIZED[s], command: case["command"].clone(), context: &context, actor_fate: None };
        let checks: &[fn(&mut sk_rules::validate::Validation<'_>) -> sk_rules::pause::Step] = if case["block"] == "legendary" { &legendary } else { &attack };
        let result = checks.iter().try_for_each(|check| check(&mut validation)).map(|()| validation.command.clone());
        let actual = outcome(result);
        let expected = expected_outcome(&case["o"]);
        if js::stringify(&actual) != js::stringify(&expected) {
            failures.push(format!("блок {} s={s} {}: Rust {} ожидалось {}", case["block"], case["command"]["command_type"], actual, expected));
        }
    }
    report(&failures, cases.len());
}

#[test]
fn resolve_command_matches_js() {
    let cases = DATA["resolves"].as_array().expect("разборы");
    let mut failures = Vec::new();
    let mut stubs = std::collections::BTreeMap::<String, usize>::new();
    for case in cases {
        let s = case["s"].as_u64().expect("состояние") as usize;
        let raw = &DATA["states"][s];
        let input = deep(&case["input"]);
        let context = Context::from_json(&deep(&case["context"]));
        let mut dice = cycle(&case["v"]);
        let mut uuid = sequence_uuids("uuid");
        let result = api::with_lenient_validation(|| api::resolve_command(&input, raw, &mut dice, &context, &mut uuid));
        if let Err(halt) = &result {
            if halt.is_unported() {
                if let Halt::Rule(error) = halt {
                    *stubs.entry(error.message.clone()).or_default() += 1;
                }
                continue;
            }
        }
        let actual = outcome(result.map(Outcome::into_resolved).map(|resolved| json!({ "command": resolved.command, "events": resolved.events, "rolls": resolved.rolls })));
        let expected = expected_outcome(&case["o"]);
        if js::stringify(&actual) != js::stringify(&expected) {
            failures.push(format!("{} s={s} {}: Rust {} ожидалось {}", input["command_type"], input["command_id"], actual, expected));
        }
    }
    if !stubs.is_empty() {
        eprintln!("дошло до заглушек других задач: {stubs:?}");
    }
    report(&failures, cases.len());
}

//! Сверка `authored_npc` с эталоном JS и перенос проверок модуля из
//! `test/authored-world-npcs.test.mjs` и `test/scenario-knight.test.mjs`
//! (Rules Engine, планировщик, bootstrap и проекции туда не входят).

mod common;

use common::{check, constant, ok, ok_or_null, runtime, thrown, Args, JsError, Outcome, UNDEFINED};
use serde_json::{json, Value};
use sk_chargen::npc_portraits::NPC_PORTRAIT_CHARACTER_ASSETS;
use sk_combat_base::legendary_actions::legendary_profile_for;
use sk_heroes::authored_npc as m;

const FIXTURE: &str = include_str!("../fixtures/authored-npc.json");
const WORLDS: &str = include_str!("../../../../data/campaign-worlds-v1.json");

fn refused(error: m::AuthoredNpcValidationError) -> JsError {
    thrown(m::AuthoredNpcValidationError::NAME, Some(&error.code), &error.message)
}

fn outcome(result: Result<Value, m::AuthoredNpcValidationError>) -> Outcome {
    result.map(Some).map_err(refused)
}

/// `authoredNpcCombatant(input)`: разбор `{ npc, mechanics, position } = {}`
/// — `null` не разбирается (`TypeError`), прочее отдаёт свои поля.
fn combatant(input: Option<&Value>) -> Outcome {
    if matches!(input, Some(Value::Null)) {
        return Err(runtime("Cannot destructure property 'npc' of null"));
    }
    let field = |key: &str| input.and_then(|input| input.as_object()).and_then(|map| map.get(key));
    outcome(m::authored_npc_combatant(field("npc"), field("mechanics"), field("position")))
}

/// Поставить `value` по пути `path` (`None` — снять поле), как генератор.
fn apply(target: &mut Value, path: &[Value], value: Option<Value>) {
    let Some((last, prefix)) = path.split_last() else { return };
    let mut current = target;
    for key in prefix {
        current = match key {
            Value::Number(index) => &mut current[index.as_u64().unwrap_or_default() as usize],
            other => &mut current[other.as_str().unwrap_or_default()],
        };
    }
    match (current, last, value) {
        (Value::Array(items), Value::Number(index), Some(value)) => {
            let index = index.as_u64().unwrap_or_default() as usize;
            if index < items.len() {
                items[index] = value;
            } else {
                items.push(value);
            }
        }
        (Value::Object(map), key, Some(value)) => {
            map.insert(sk_core::js::s(Some(key)), value);
        }
        (Value::Object(map), key, None) => {
            map.shift_remove(&sk_core::js::s(Some(key)));
        }
        _ => panic!("путь правки не найден: {path:?}"),
    }
}

#[test]
fn authored_npc_matches_js() {
    let npcs = constant(FIXTURE, "npcs");
    let mechanics_of = |id: &Value| -> Value {
        npcs.as_array().and_then(|list| list.iter().find(|npc| &npc["id"] == id)).map(|npc| npc["mechanics"].clone()).expect("NPC из эталона")
    };
    let count = check(FIXTURE, |name, args: &Args| -> Outcome {
        match name {
            "const:npcs" => ok(npcs.clone()),
            "const:AUTHORED_NPC_MECHANICS_STATUSES" => ok(json!(m::AUTHORED_NPC_MECHANICS_STATUSES)),
            "normalizeAuthoredNpcMechanics" => match args.get(1) {
                Some(path) => outcome(m::normalize_authored_npc_mechanics_at(args.get(0), path.as_str().unwrap_or_default())),
                None => outcome(m::normalize_authored_npc_mechanics(args.get(0))),
            },
            "safeAuthoredNpcMechanics" => ok_or_null(m::safe_authored_npc_mechanics(args.get(0))),
            "authoredNpcCombatant" => combatant(args.get(0)),
            "mutated" => {
                let mut mechanics = mechanics_of(args.get(0).expect("id NPC"));
                let path = args.get(1).and_then(Value::as_array).cloned().unwrap_or_default();
                let value = args.get(2).cloned().filter(|value| value.as_str() != Some(UNDEFINED));
                apply(&mut mechanics, &path, value);
                outcome(m::normalize_authored_npc_mechanics(Some(&mechanics)))
            }
            other => panic!("нет сверки для {other}"),
        }
    });
    assert!(count > 8000, "{count}");
}

fn astohan_npcs() -> Vec<Value> {
    let worlds: Value = serde_json::from_str(WORLDS).expect("campaign-worlds-v1.json");
    let template = worlds["templates"].as_array().and_then(|list| list.iter().find(|entry| entry["id"] == "astohan-plains")).cloned().expect("шаблон Асстохана");
    template["opening"]["npcs"].as_array().cloned().unwrap_or_default()
}

const NPC_IDS: [&str; 8] = ["astohan-ares", "astohan-ivara", "astohan-oren", "astohan-mira", "astohan-lomar", "astohan-eldrin", "astohan-kaelan", "astohan-sargat"];

/// «Асстоханские равнины содержат восемь стабильных и механически разных
/// NPC»: лист шаблона мира (`getWorldTemplate` уже нормализует его) при
/// повторной нормализации не меняется.
#[test]
fn astohan_npcs_are_stable_and_distinct() {
    let npcs = astohan_npcs();
    assert_eq!(npcs.iter().map(|npc| npc["id"].as_str().unwrap_or_default()).collect::<Vec<_>>(), NPC_IDS);
    let mut profiles: Vec<&str> = npcs.iter().map(|npc| npc["mechanics"]["profile_id"].as_str().unwrap_or_default()).collect();
    profiles.sort_unstable();
    profiles.dedup();
    assert_eq!(profiles.len(), NPC_IDS.len());
    for npc in &npcs {
        let mechanics = m::normalize_authored_npc_mechanics(Some(&npc["mechanics"])).expect("лист шаблона");
        assert_eq!(m::normalize_authored_npc_mechanics(Some(&mechanics)).as_ref(), Ok(&mechanics), "{}", npc["name"]);
        assert_eq!(sk_core::js::stringify(&m::normalize_authored_npc_mechanics(Some(&mechanics)).unwrap_or_default()), sk_core::js::stringify(&mechanics));
        assert!(mechanics["skills"].as_object().map_or(0, |skills| skills.len()) >= 4, "{}", npc["name"]);
        assert!(!mechanics["action_profiles"].as_array().cloned().unwrap_or_default().is_empty());
        let features = mechanics["features"].as_array().cloned().unwrap_or_default();
        assert!(features.iter().all(|feature| m::AUTHORED_NPC_MECHANICS_STATUSES.contains(&feature["status"].as_str().unwrap_or_default())));
    }
}

/// «неподдержанное поле, trait и заклинание не становятся авторской
/// механикой».
#[test]
fn unsupported_fields_traits_and_spells_are_refused() {
    let valid = astohan_npcs()[0]["mechanics"].clone();
    let with = |key: &str, value: Value| {
        let mut mechanics = valid.clone();
        mechanics[key] = value;
        m::normalize_authored_npc_mechanics(Some(&mechanics)).expect_err("отказ")
    };
    let error = with("damage_multiplier", json!(99));
    assert_eq!(error.code, "AUTHORED_NPC_INVALID");
    assert_eq!(error.message, "npc.mechanics содержит неизвестные поля: damage_multiplier");
    assert!(with("traits", json!([{ "id": "instant-victory", "name": "Победа" }])).message.contains("не исполняется планировщиком"));
    let action = valid["action_profiles"][0].clone();
    assert!(with("action_profiles", json!([action.clone(), action])).message.contains("повторяющийся id"));
    let spells = json!({ "ability": "int", "save_dc": 15, "attack_bonus": 7, "spells": [{ "id": "detect-magic", "uses": 1 }] });
    assert!(with("spellcasting", spells).message.contains("не имеет исполнимой серверной механики"));
    assert_eq!(m::safe_authored_npc_mechanics(Some(&json!({ "profile_id": "broken" }))), None);
    assert_eq!(m::safe_authored_npc_mechanics(None), None);
    assert_eq!(m::safe_authored_npc_mechanics(Some(&Value::Null)), None);
}

/// «все восемь боевых профилей понятны существующему планировщику»: у
/// боевой формы — портрет из allowlist, легендарный блок исполним.
#[test]
fn combatants_carry_portraits_and_executable_legendary_blocks() {
    for npc in astohan_npcs() {
        let actor = m::authored_npc_combatant(Some(&npc), Some(&npc["mechanics"]), Some(&json!({ "x": 4, "y": 2 }))).expect("боевая форма");
        let id = npc["id"].as_str().unwrap_or_default();
        let portrait = NPC_PORTRAIT_CHARACTER_ASSETS.iter().find(|(key, _)| *key == id).map(|(_, url)| *url);
        assert_eq!(actor["image"].as_str(), portrait, "{id}");
        assert_eq!(actor["origin"], json!({ "kind": "authored-npc", "npc_id": id, "profile_id": npc["mechanics"]["profile_id"] }));
        assert_eq!(actor["stat_block_id"], npc["mechanics"]["profile_id"]);
        assert_eq!((actor["x"].clone(), actor["y"].clone(), actor["alive"].clone()), (json!(4), json!(2), json!(true)));
        if npc["mechanics"].get("legendary").is_some() {
            assert!(legendary_profile_for(Some(&actor)).is_some(), "{id}");
        }
    }
}

/// Саргат: дыхание — особое действие с перезарядкой (16к6 по книге), а
/// легендарные — хвост и крылья; 178 хитов.
#[test]
fn sargat_breath_is_a_special_action() {
    let sargat = astohan_npcs().into_iter().find(|npc| npc["id"] == "astohan-sargat").expect("Саргат");
    let actor = m::authored_npc_combatant(Some(&sargat), Some(&sargat["mechanics"]), Some(&json!({ "x": 4, "y": 2 }))).expect("боевая форма");
    assert_eq!(actor["hp"], json!(178));
    assert_eq!(actor["stat_block_id"], json!("astohan:sargat-v1"));
    let breath = actor["special_actions"].as_array().and_then(|list| list.iter().find(|action| action["id"] == "fire-breath")).cloned().expect("дыхание");
    assert_eq!(breath["damage"][0]["expression"], json!("16d6"));
    let legendary: Vec<&str> = actor["legendary"]["actions"].as_array().map(|list| list.iter().filter_map(|action| action["id"].as_str()).collect()).unwrap_or_default();
    assert_eq!(legendary, ["tail-sweep", "wing-buffet"]);
    assert_eq!(actor["footprint"], json!({ "version": 1, "size": 2 }));
}

/// `test/scenario-knight.test.mjs`: Лунный Судья добавляет 2к8 холодом, Вой
/// Проклятых — 4к8 звуком раз в три хода.
#[test]
fn kaelan_blade_and_wail() {
    let kaelan = astohan_npcs().into_iter().find(|npc| npc["id"] == "astohan-kaelan").expect("Каэлан");
    let mechanics = m::normalize_authored_npc_mechanics(Some(&kaelan["mechanics"])).expect("лист");
    let blade = mechanics["action_profiles"].as_array().and_then(|list| list.iter().find(|action| action["id"] == "moon-judge")).cloned().expect("клинок");
    assert_eq!(blade["on_hit"], json!({ "damage_expression": "2d8", "damage_type": "cold" }));
    let wail = mechanics["legendary"]["actions"].as_array().and_then(|list| list.iter().find(|action| action["id"] == "wail-of-the-condemned")).cloned().expect("вой");
    assert_eq!(wail["damage_expression"], json!("4d8"));
    assert_eq!(wail["damage_type"], json!("thunder"));
    assert_eq!(wail["save_ability"], json!("con"));
    assert_eq!(wail["half_on_save"], json!(true));
    assert_eq!(wail["radius_feet"], json!(30));
    assert_eq!(wail["cooldown_turns"], json!(3));
}

/// Модуль числа после знака формулы основного действия — как в JS:
/// у `1d6-2` бонус урона `2`, а не `-2`.
#[test]
fn combatant_damage_bonus_drops_the_sign_like_js() {
    let mut mechanics = astohan_npcs()[0]["mechanics"].clone();
    mechanics["action_profiles"][0]["damage_expression"] = json!("1d6-2");
    let actor = m::authored_npc_combatant(Some(&json!({ "id": "npc", "name": "Имя" })), Some(&mechanics), Some(&json!({ "x": 1, "y": 1 }))).expect("боевая форма");
    assert_eq!((actor["damageDice"].clone(), actor["damageBonus"].clone()), (json!(6), json!(2)));
}

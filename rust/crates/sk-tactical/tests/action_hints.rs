//! Сверка `action_hints` с эталоном JS (`fixtures/action-hints.json`,
//! генератор `fixtures/gen-action-hints.mjs`) и перенос проверок
//! `suggestedActionsFor` из `test/action-hints.test.mjs`, `lockpicking`,
//! `courier-letters-ui-contract` и `blessings-ui-contract`.

mod common;

use std::sync::LazyLock;

use common::{arg, array, parse};
use serde_json::{json, Value};
use sk_tactical::action_hints::{self as ah, ActionHintsError};

static FIXTURE: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../fixtures/action-hints.json")));

/// `setPath` генератора: недостающие и не-контейнеры по пути — новые `{}`
/// (дальше строка) или `[]` (дальше индекс); `undefined` удаляет.
fn set_path(target: &mut Value, path: &[Value], value: Option<Value>) {
    let mut current = target;
    for (index, key) in path[..path.len() - 1].iter().enumerate() {
        let next_is_index = path[index + 1].is_number();
        let fresh = || if next_is_index { json!([]) } else { json!({}) };
        let suitable = |child: Option<&Value>| child.is_some_and(|child| (child.is_object() || child.is_array()) && child.is_array() == next_is_index);
        current = match (current, key) {
            (Value::Array(items), Value::Number(position)) => {
                let position = position.as_u64().expect("индекс") as usize;
                if !suitable(items.get(position)) {
                    if position == items.len() {
                        items.push(fresh());
                    } else {
                        items[position] = fresh();
                    }
                }
                &mut items[position]
            }
            (Value::Object(map), Value::String(name)) => {
                if !suitable(map.get(name)) {
                    map.insert(name.clone(), fresh());
                }
                map.get_mut(name).expect("ключ вставлен")
            }
            (other, key) => panic!("путь заплатки не сходится: {other} [{key}]"),
        };
    }
    match (current, path.last().expect("путь")) {
        (Value::Array(items), Value::Number(position)) => {
            let position = position.as_u64().expect("индекс") as usize;
            match value {
                None => {
                    items.remove(position);
                }
                Some(value) if position == items.len() => items.push(value),
                Some(value) => items[position] = value,
            }
        }
        (Value::Object(map), Value::String(name)) => match value {
            None => {
                map.shift_remove(name);
            }
            Some(value) => {
                map.insert(name.clone(), value);
            }
        },
        (other, key) => panic!("путь заплатки не сходится: {other} [{key}]"),
    }
}

fn outcome(room: Option<&Value>, actor: Option<&Value>) -> Value {
    match ah::suggested_actions_json(room, actor) {
        Ok(hints) => json!({ "result": hints }),
        Err(error) => json!({ "error": { "name": ActionHintsError::NAME, "message": error.message } }),
    }
}

#[test]
fn constants_match_js() {
    let constants = &FIXTURE["constants"];
    assert_eq!(constants["MAX_ACTION_HINTS"], ah::MAX_ACTION_HINTS);
    assert_eq!(constants["MAX_PROP_HINTS"], ah::MAX_PROP_HINTS);
    assert_eq!(constants["MAX_LOOT_HINTS"], ah::MAX_LOOT_HINTS);
    assert_eq!(constants["THEFT_HINT_REACH_FEET"], ah::THEFT_HINT_REACH_FEET);
}

#[test]
fn projected_and_patched_rooms_match_js() {
    let rooms = array(&FIXTURE["rooms"]);
    let cases = array(&FIXTURE["cases"]);
    let mut failures = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let mut room = rooms[case["room"].as_u64().expect("индекс комнаты") as usize].clone();
        for step in case.get("patch").map(array).unwrap_or(&[]) {
            set_path(&mut room, array(&step[0]), arg(&step[1]).cloned());
        }
        let actual = outcome(Some(&room), arg(&case["actor"]));
        if actual != case["out"] {
            failures.push(format!("#{index} {} actor={}\n  Rust: {actual}\n  JS:   {}", case["source"], case["actor"], case["out"]));
        }
    }
    assert!(failures.is_empty(), "расхождений {} из {}:\n{}", failures.len(), cases.len(), failures.iter().take(10).cloned().collect::<Vec<_>>().join("\n"));
    assert!(cases.len() >= 1_500, "случаев меньше, чем снято: {}", cases.len());
    let sources: std::collections::HashSet<&str> = cases.iter().filter_map(|case| case["source"].as_str()).map(|source| source.split(':').next().unwrap_or(source)).collect();
    for source in ["action-hints", "beast-taming", "blessings-ui-contract", "courier-letters-ui-contract", "lockpicking", "tavern-life", "tavern-ui-contract", "walk", "patch"] {
        assert!(sources.contains(source), "в эталоне нет комнат из {source}");
    }
}

// --- перенос проверок из test/*.test.mjs ---------------------------------------

fn room(patch: Value) -> Value {
    let mut scene = json!({ "objective": "", "map": { "props": [], "doors": [] } });
    if let Some(extra) = patch.get("scene").and_then(Value::as_object) {
        for (key, value) in extra {
            scene[key] = value.clone();
        }
    }
    json!({
        "scene": scene,
        "scene_npcs": patch.get("scene_npcs").cloned().unwrap_or(json!([])),
        "mechanics": patch.get("mechanics").cloned().unwrap_or(json!({ "combat": { "active": false } })),
    })
}

fn prop(id: &str, asset_id: &str, verbs: Value, extra: Value) -> Value {
    let mut interaction = json!({ "kind": "container", "verbs": verbs });
    if let Some(extra) = extra.as_object() {
        for (key, value) in extra {
            interaction[key] = value.clone();
        }
    }
    json!({ "id": id, "assetId": asset_id, "interactive": true, "interaction": interaction })
}

fn hints(room: &Value, actor: Option<&str>) -> Vec<ah::ActionHint> {
    let actor = actor.map(Value::from);
    ah::suggested_actions_for(Some(room), actor.as_ref()).expect("подсказки")
}

fn texts(room: &Value, actor: Option<&str>) -> Vec<String> {
    hints(room, actor).into_iter().map(|hint| hint.text).collect()
}

#[test]
fn hints_gather_props_npcs_objective_and_exit() {
    let built = room(json!({
        "scene": { "objective": "Найти пропавшего писаря", "map": { "props": [prop("chest-1", "chest", json!(["inspect", "open"]), json!({}))], "doors": [{ "x": 1, "y": 0, "dir": "e" }] } },
        "scene_npcs": [{ "id": "npc-1", "name": "Бром", "role": "трактирщик", "alive": true, "stance": "neutral" }],
    }));
    let list = hints(&built, None);
    assert_eq!(
        list.iter().map(|hint| hint.text.as_str()).collect::<Vec<_>>(),
        ["Можно осмотреть: Сундук", "Можно заговорить с кем-то из местных: Бром (трактирщик)", "Цель отряда: Найти пропавшего писаря", "Можно уйти из этого места через дверь"]
    );
    assert_eq!(list.iter().map(|hint| hint.id.as_str()).collect::<Vec<_>>(), ["prop:chest-1:inspect", "npc:npc-1", "objective", "exit"]);
}

#[test]
fn no_hints_in_combat() {
    let combat = room(json!({
        "scene": { "objective": "Выжить", "map": { "props": [prop("chest-1", "chest", json!(["inspect"]), json!({}))], "doors": [{ "x": 1, "y": 0, "dir": "e" }] } },
        "scene_npcs": [{ "id": "npc-1", "name": "Бром", "alive": true }],
        "mechanics": { "combat": { "active": true } },
    }));
    assert!(hints(&combat, None).is_empty());
}

#[test]
fn onward_objective_names_how_to_continue() {
    let objective = "Продолжить путь из Айрская башня к «Дормар»";
    let first = hints(&room(json!({ "scene": { "location": "Айрская башня", "objective": objective } })), None);
    assert_eq!(first[0].id, "objective");
    assert_eq!(first[0].text, "Цель отряда: продолжить путь к «Дормар» — нажмите «Решение группы» или напишите «продолжаем путь»");
    let stale = hints(&room(json!({ "scene": { "location": "Дормар", "objective": objective } })), None);
    assert_eq!(stale[0].text, format!("Цель отряда: {objective}"));
}

#[test]
fn empty_foreign_and_contentless_rooms_give_nothing() {
    for value in [Value::Null, json!("комната")] {
        assert!(ah::suggested_actions_for(Some(&value), None).expect("подсказки").is_empty());
    }
    assert!(ah::suggested_actions_for(None, None).expect("подсказки").is_empty());
    assert!(hints(&room(json!({})), None).is_empty());
    let silent = room(json!({ "scene": { "map": { "props": [{ "id": "rug", "assetId": "rug" }, prop("x", "chest", json!(["левитировать"]), json!({})), prop("y", "нет-такого-ассета", json!(["inspect"]), json!({}))], "doors": [] } } }));
    assert!(hints(&silent, None).is_empty());
    let hostile = room(json!({ "scene_npcs": [{ "id": "a", "name": "Головорез", "alive": true, "stance": "hostile" }, { "id": "b", "name": "Труп", "alive": false }] }));
    assert!(hints(&hostile, None).is_empty());
}

#[test]
fn far_props_ask_the_reader_to_come_closer() {
    let chest = |id: &str, x: i64, y: i64| {
        let mut value = prop(id, "chest", json!(["inspect"]), json!({}));
        value["x"] = json!(x as f64 + 0.5);
        value["y"] = json!(y as f64 + 0.5);
        value["footprint"] = json!([{ "x": x, "y": y }]);
        value
    };
    let with_hero = |props: Value, hero: (i64, i64), mechanics: Option<Value>| {
        let mut built = room(json!({ "scene": { "map": { "props": props, "doors": [] } } }));
        if let Some(mechanics) = mechanics {
            built["mechanics"] = mechanics;
        }
        built["players"] = json!([{ "id": "hero", "character": "Мира", "x": hero.0, "y": hero.1 }]);
        built
    };
    let far = with_hero(json!([chest("chest-1", 6, 4)]), (0, 0), None);
    assert_eq!(texts(&far, Some("hero")), ["Можно осмотреть: Сундук — надо подойти вплотную"]);
    assert_eq!(texts(&far, None), ["Можно осмотреть: Сундук"]);
    assert_eq!(texts(&far, Some("stranger")), ["Можно осмотреть: Сундук"]);
    assert_eq!(texts(&with_hero(json!([chest("chest-1", 6, 4)]), (5, 3), None), Some("hero")), ["Можно осмотреть: Сундук"]);
    let moved = with_hero(json!([chest("chest-1", 6, 4)]), (0, 0), Some(json!({ "combat": { "active": false }, "positions": { "hero": { "x": 6, "y": 5 } } })));
    assert_eq!(texts(&moved, Some("hero")), ["Можно осмотреть: Сундук"]);
    let twins = with_hero(json!([chest("chest-a", 7, 7), chest("chest-b", 1, 1)]), (0, 0), None);
    assert_eq!(hints(&twins, Some("hero")), [ah::ActionHint { id: "prop:chest-b:inspect".into(), text: "Можно осмотреть: Сундук".into() }]);
    assert_eq!(hints(&twins, None), [ah::ActionHint { id: "prop:chest-a:inspect".into(), text: "Можно осмотреть: Сундук".into() }]);
}

#[test]
fn furnishing_never_becomes_a_hint() {
    let furnished = room(json!({
        "scene": {
            "objective": "Дождаться связного",
            "map": {
                "props": [
                    prop("bench-1", "bench", json!(["inspect"]), json!({})),
                    prop("broom-1", "broom", json!(["inspect", "ignite"]), json!({})),
                    prop("cobweb-1", "cobweb", json!(["inspect", "ignite"]), json!({})),
                    prop("rug-1", "rug", json!(["inspect", "ignite"]), json!({})),
                ],
                "doors": [{ "x": 0, "y": 1, "dir": "s" }],
            },
        },
        "scene_npcs": [{ "id": "npc-1", "name": "Бром", "role": "трактирщик", "alive": true }],
    }));
    assert_eq!(texts(&furnished, None), ["Можно заговорить с кем-то из местных: Бром (трактирщик)", "Цель отряда: Дождаться связного", "Можно уйти из этого места через дверь"]);
}

#[test]
fn props_get_at_most_two_lines_and_never_at_the_expense_of_people() {
    let poi = json!({ "pointOfInterest": true });
    let props = json!([
        prop("a-altar", "altar", json!(["inspect", "use"]), poi.clone()),
        prop("b-chest", "chest", json!(["inspect", "open"]), poi.clone()),
        prop("c-grave", "grave", json!(["inspect", "take"]), poi.clone()),
        prop("d-urn", "urn", json!(["inspect"]), poi),
    ]);
    let doors = json!([{ "x": 0, "y": 0, "dir": "s" }]);
    let crowded = room(json!({ "scene": { "objective": "Найти писаря", "map": { "props": props, "doors": doors } }, "scene_npcs": [{ "id": "z", "name": "Зевака", "alive": true }] }));
    assert_eq!(texts(&crowded, None), ["Можно осмотреть: Алтарь", "Можно заговорить: Зевака", "Цель отряда: Найти писаря", "Можно уйти из этого места через дверь"]);
    let quiet = room(json!({ "scene": { "objective": "Найти писаря", "map": { "props": props, "doors": doors } } }));
    assert_eq!(hints(&quiet, None).iter().filter(|hint| hint.id.starts_with("prop:")).count(), ah::MAX_PROP_HINTS);
    let talkative = room(json!({ "scene": { "objective": "Найти писаря", "map": { "props": props, "doors": doors } }, "scene_npcs": [{ "id": "a", "name": "Бром", "alive": true }, { "id": "b", "name": "Марта", "alive": true }] }));
    assert_eq!(texts(&talkative, None), ["Можно заговорить: Бром", "Можно заговорить: Марта", "Цель отряда: Найти писаря", "Можно уйти из этого места через дверь"]);
}

#[test]
fn order_is_deterministic_and_bounded() {
    let props = vec![
        prop("b-crate", "crate", json!(["open"]), json!({})),
        prop("a-altar", "altar", json!(["inspect"]), json!({ "pointOfInterest": true })),
        prop("c-barrel", "barrel", json!(["topple"]), json!({})),
        prop("d-bones", "bone_pile", json!(["inspect"]), json!({})),
    ];
    let many = room(json!({ "scene": { "objective": "Цель", "map": { "props": props, "doors": [{ "x": 0, "y": 0, "dir": "s" }] } } }));
    let first = hints(&many, None);
    assert_eq!(first.len(), ah::MAX_ACTION_HINTS);
    assert_eq!(first[0].text, "Можно осмотреть: Алтарь");
    let reversed: Vec<Value> = props.iter().rev().cloned().collect();
    let shuffled = room(json!({ "scene": { "objective": "Цель", "map": { "props": reversed, "doors": [{ "x": 0, "y": 0, "dir": "s" }] } } }));
    assert_eq!(hints(&shuffled, None), first);
}

#[test]
fn lockpick_hint_only_for_the_proficient() {
    let locked = |proficient: bool, state: &str| json!({ "scene": { "map": { "doors": [{ "id": "d", "state": state }] } }, "lockpicking": { "proficient": proficient } });
    assert_eq!(
        hints(&locked(true, "locked"), None),
        [
            ah::ActionHint { id: "lockpick:door".into(), text: "Можно вскрыть замок отмычкой: запертая дверь".into() },
            ah::ActionHint { id: "exit".into(), text: "Можно уйти из этого места через дверь".into() },
        ]
    );
    assert_eq!(hints(&locked(false, "locked"), None), [ah::ActionHint { id: "exit".into(), text: "Можно уйти из этого места через дверь".into() }]);
    assert_eq!(hints(&locked(true, "closed"), None), [ah::ActionHint { id: "exit".into(), text: "Можно уйти из этого места через дверь".into() }]);
}

#[test]
fn courier_hint_comes_from_the_projection() {
    let base = |post: Option<Value>| {
        let mut built = room(json!({}));
        if let Some(post) = post {
            built["courier_letters"] = post;
        }
        built
    };
    let addressee = json!({ "kind": "npc", "id": "ally", "name": "Мельник Гость", "leagues": 6, "fee_cp": 110 });
    let idle = hints(&base(Some(json!({ "letters": [], "addressees": [addressee] }))), None);
    let write = idle.iter().find(|hint| hint.id == "letter:write").expect("приглашение написать");
    assert!(write.text.contains("110"));
    let travelling = hints(&base(Some(json!({ "letters": [{ "id": "letter:1", "status": "in_transit", "addressee_name": "Мельник Гость", "place_name": "Мельница" }], "addressees": [addressee] }))), None);
    assert!(travelling.iter().any(|hint| hint.id == "letter:in-transit"));
    assert!(!travelling.iter().any(|hint| hint.id == "letter:write"));
    assert!(hints(&base(None), None).iter().all(|hint| !hint.id.starts_with("letter:")));
}

/// Замечено в JS: `courier_letters.addressees` с `null` первым адресатом —
/// `TypeError` (чтение `name` у `null`); Rust возвращает ту же ошибку.
#[test]
fn null_first_addressee_throws_type_error_as_in_js() {
    let broken = json!({ "courier_letters": { "letters": [], "addressees": [null, { "name": "Гость", "fee_cp": 10 }] } });
    let error = ah::suggested_actions_for(Some(&broken), None).expect_err("TypeError, как в JS");
    assert_eq!(error.message, "Cannot read properties of null (reading 'name')");
    // В бою до почты дело не доходит.
    let mut fighting = broken.clone();
    fighting["mechanics"] = json!({ "combat": { "active": true } });
    assert!(ah::suggested_actions_for(Some(&fighting), None).expect("бой").is_empty());
}

#[test]
fn blessing_offer_only_while_available() {
    let chapel = |extra: Value| {
        let mut built = room(json!({ "scene": { "map": { "props": [{ "id": "altar", "assetId": "altar", "interactive": true, "interaction": { "verbs": ["inspect", "pray"] } }], "doors": [] } } }));
        let mut blessings = json!({ "available": true, "blessed": false, "priests": [{ "id": "father", "name": "Отец Мирон" }], "prayer_dc": 12, "donation_cp": 25 });
        for (key, value) in extra.as_object().into_iter().flatten() {
            blessings[key] = value.clone();
        }
        built["blessings"] = blessings;
        built
    };
    let offer = hints(&chapel(json!({})), Some("hero"));
    assert!(offer.iter().any(|hint| hint.id == "blessing:offer" && hint.text.contains("помолиться")));
    assert!(!hints(&chapel(json!({ "available": false })), Some("hero")).iter().any(|hint| hint.id == "blessing:offer"));
    assert!(!hints(&chapel(json!({ "blessed": true })), Some("hero")).iter().any(|hint| hint.id == "blessing:offer"));
}

/// Ключ прототипа в виде контейнера добычи — незнакомый вид: общая фраза.
#[test]
fn prototype_loot_kind_is_unknown_kind() {
    let loot = |kind: &str| json!({ "loot_containers": { "containers": [{ "id": "c", "name": "Тело: Волк", "kind": kind, "item_count": 1, "can_inspect": true }] } });
    assert_eq!(texts(&loot("constructor"), None), ["Можно обыскать добычу: Волк"]);
    assert_eq!(texts(&loot("__proto__"), None), ["Можно обыскать добычу: Волк"]);
    assert_eq!(texts(&loot("toString"), None), ["Можно обыскать добычу: Волк"]);
    assert_eq!(texts(&loot("corpse"), None), ["Можно обыскать тело: Волк"]);
}

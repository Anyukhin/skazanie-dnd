//! `talespire_import`: эталон JS (`fixtures/talespire-import.json`, генератор —
//! `fixtures/gen-talespire-import.mjs`) — дома и отказы из
//! `test/talespire-import.test.mjs` и сотни случайных построек, собранных
//! кодировщиком `test/talespire-fixtures.mjs` (v2, v1, v1 «как есть», мусор);
//! паспорт, оценка качества и ремонт этажа на картах импорта и их правках;
//! подписи комнат. Карты сравниваются SHA-256 строки `JSON.stringify`
//! (`sk_core::js::stringify`), этажи импорта проверяются аудитом
//! `sk_map_core::map_quality` на структурные ошибки.

mod common;

use common::{check, Args, Fixture, Outcome};
use serde_json::{json, Value};
use sk_core::js;
use sk_tactical::tactical_map::{deserialize_tactical_map, serialize_tactical_map, validate_tactical_map, TacticalMap};
use sk_talespire::talespire_import::*;

fn options_of(value: Option<&Value>) -> ImportOptions {
    let mut options = ImportOptions::default();
    let Some(value) = value else { return options };
    if let Some(location) = value.get("locationId") {
        options.location_id = js::s(Some(location));
    }
    if let Some(theme) = value.get("theme") {
        options.theme = js::s(Some(theme));
    }
    if let Some(labels) = value.get("levelLabels") {
        options.level_labels = labels.clone();
    }
    options.underground = js::truthy(value.get("underground"));
    options
}

fn map_of(value: Option<&Value>) -> TacticalMap {
    deserialize_tactical_map(value.unwrap_or(&Value::Null)).expect("карта эталона разбирается")
}

fn stats_of(value: Option<&Value>) -> Stats {
    value.and_then(Value::as_object).cloned().unwrap_or_default()
}

fn run(name: &str, args: &Args) -> Outcome {
    Ok(Some(match name {
        "importTaleSpireSlab" => {
            let text = args.get(0).and_then(Value::as_str);
            match import_talespire_slab(text, &options_of(args.get(1))) {
                Ok(result) => result,
                Err(error) => return Err(error.code),
            }
        }
        "worldBoxesForSlab" => {
            let slab = sk_scene_base::talespire_slab::decode_slab(args.get(0).and_then(Value::as_str)).map_err(|error| error.code)?;
            let table = talespire_asset_table().map_err(|error| error.code)?;
            let (boxes, unknown) = world_boxes_for_slab(&slab, table);
            json!({ "boxes": boxes.iter().map(WorldBox::to_json).collect::<Vec<_>>(), "unknown": unknown })
        }
        "mapPassport" => {
            let maps: Vec<TacticalMap> = args.get(0).and_then(Value::as_array).map(|items| items.iter().map(|item| map_of(Some(item))).collect()).unwrap_or_default();
            map_passport(&maps.iter().collect::<Vec<_>>())
        }
        "auditTacticalMap" => sk_map_core::map_quality::audit_tactical_map(&map_of(args.get(0))).to_json(),
        "importQuality" => import_quality(&map_of(args.get(0)), &stats_of(args.get(1))),
        "repairImportedLevel" => {
            let mut map = map_of(args.get(0));
            let mut stats = stats_of(args.get(1));
            repair_imported_level(&mut map, &mut stats).map_err(|error| error.code)?;
            json!({ "map": serialize_tactical_map(&map).map_err(|error| error.code)?, "stats": stats })
        }
        "roomLabelFor" => {
            let room = args.get(1);
            let field = |key: &str| room.and_then(|room| room.get(key));
            let info = RoomInfo {
                cells: js::number(field("cells")),
                interior: js::truthy(field("interior")),
                level: js::number(field("level")),
                material: js::s(field("material")),
                underground: js::truthy(field("underground")),
            };
            json!(room_label_for(args.get(0).unwrap_or(&json!({})), &info))
        }
        other => panic!("неизвестная функция эталона {other}"),
    }))
}

static FIXTURE: std::sync::LazyLock<Fixture> = std::sync::LazyLock::new(|| Fixture::load_gz(include_bytes!("../fixtures/talespire-import.json.gz")));

#[test]
fn talespire_import_matches_js() {
    let summary = check(&FIXTURE, run);
    println!("{summary:?}");
    assert!(summary.calls > 2_500, "{summary:?}");
    assert_eq!(summary.per_fn.len(), 7, "{summary:?}");
}

#[test]
fn constants_match_js() {
    assert_eq!(FIXTURE.data["constants"]["TALESPIRE_IMPORT_VERSION"], json!(TALESPIRE_IMPORT_VERSION));
    assert_eq!(FIXTURE.data["constants"]["TALESPIRE_MAX_SOURCE_CELLS"], js::num(TALESPIRE_MAX_SOURCE_CELLS));
}

/// Слэбы эталона, которые импорт принимает.
fn imported() -> Vec<Value> {
    FIXTURE
        .cases()
        .iter()
        .filter(|case| case["fn"] == "importTaleSpireSlab" && case.get("error").is_none())
        .filter_map(|case| {
            let args = FIXTURE.args(case);
            import_talespire_slab(args.get(0).and_then(Value::as_str), &options_of(args.get(1))).ok()
        })
        .collect()
}

/// Этажи импорта проходят проверку карты (аудит качества сверяется с JS выше):
/// у каждого этажа выше и ниже входа есть переход, у входа — точка отряда.
#[test]
fn imported_levels_are_valid_maps() {
    let mut levels = 0;
    for result in imported() {
        for level in result["levels"].as_array().expect("этажи") {
            let map = map_of(level.get("map"));
            assert!(validate_tactical_map(&map).ok, "{}", level["label"]);
            if map.level_index != 0 {
                assert!(map.props.iter().any(|prop| prop.transition.is_some()), "этаж без перехода");
            } else {
                assert!(map.spawn_points.iter().any(|point| point.role == "party"), "вход без точки отряда");
            }
            levels += 1;
        }
    }
    assert!(levels > 300, "этажей {levels}");
}

#[test]
fn import_is_deterministic() {
    let case = FIXTURE.cases().iter().find(|case| case["fn"] == "importTaleSpireSlab" && case.get("error").is_none()).expect("слэб");
    let args = FIXTURE.args(case);
    let text = args.get(0).and_then(Value::as_str);
    let first = import_talespire_slab(text, &ImportOptions::default()).expect("импорт");
    let second = import_talespire_slab(text, &ImportOptions::default()).expect("импорт");
    assert_eq!(js::stringify(&first), js::stringify(&second));
}

#[test]
fn room_labels_follow_furnishing() {
    let room = |interior: bool, material: &str| RoomInfo { cells: 30.0, interior, level: 0.0, material: material.into(), underground: false };
    assert_eq!(room_label_for(&json!({ "bar_counter": 1, "chair": 2 }), &room(true, "wood")), "Общий зал");
    assert_eq!(room_label_for(&json!({ "bone_pile": 1 }), &room(true, "wood")), "Комната", "декоративный череп — не склеп");
    assert_eq!(room_label_for(&json!({ "sarcophagus": 1 }), &room(true, "wood")), "Склеп");
    assert_eq!(room_label_for(&json!({}), &RoomInfo { cells: 300.0, ..room(false, "grass") }), "Поляна");
    assert_eq!(room_label_for(&json!({}), &RoomInfo { underground: true, ..room(true, "earth") }), "Пещера");
}

#[test]
fn garbage_gets_a_code_not_a_panic() {
    for text in [None, Some(""), Some("не слэб"), Some("H4sI")] {
        let error = import_talespire_slab(text, &ImportOptions::default()).expect_err("мусор");
        assert!(error.code.starts_with("SLAB_"), "{error:?}");
    }
}

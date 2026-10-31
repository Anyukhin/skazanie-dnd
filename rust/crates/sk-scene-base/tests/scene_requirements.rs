//! Сверка `scene_requirements` с JS: эталон `fixtures/scene-requirements.json`
//! (`fixtures/gen-scene-requirements.mjs`) и перенесённые проверки
//! `test/scene-requirements.test.mjs`, `test/map-quality.test.mjs`.

mod common;

use std::sync::LazyLock;

use common::{assert_json, Mismatches};
use serde_json::{json, Value};
use sk_scene_base::asset_registry::list_assets;
use sk_scene_base::scene_requirements::*;

static FIXTURE: LazyLock<Value> =
    LazyLock::new(|| serde_json::from_str(include_str!("../fixtures/scene-requirements.json")).expect("эталон scene-requirements"));

fn ids(text: &str) -> Vec<String> {
    scene_requirements_from_text(&json!(text)).into_iter().map(|item| item.id).collect()
}

fn items(text: Value) -> Value {
    serde_json::to_value(scene_requirements_from_text(&text)).expect("json")
}

fn requirements(value: &Value) -> Vec<Requirement> {
    value
        .as_array()
        .expect("список")
        .iter()
        .map(|item| Requirement { id: item["id"].as_str().expect("id").to_string(), count: item["count"].as_f64().unwrap_or(f64::NAN) })
        .collect()
}

fn facts(id: &str) -> &'static Value {
    &FIXTURE["facts"][id]
}

#[test]
fn dictionary_matches_js() {
    assert_eq!(FIXTURE["version"], json!(SCENE_REQUIREMENTS_VERSION));
    assert_eq!(FIXTURE["landmarkRoles"], json!(LANDMARK_ROLES));
    let kinds: Vec<Value> = SCENE_REQUIREMENT_KINDS
        .iter()
        .map(|kind| json!({ "id": kind.id, "label": kind.label, "source": kind.source, "assets": kind.assets, "terrain": kind.terrain, "fromText": kind.from_text }))
        .collect();
    assert_json(&Value::Array(kinds), &FIXTURE["kinds"], "словарь видов");
    let structures: Vec<Value> = SCENE_STRUCTURE_KINDS
        .iter()
        .map(|kind| json!({ "id": kind.id, "label": kind.label, "source": kind.source, "building": kind.building, "journey": kind.journey }))
        .collect();
    assert_json(&Value::Array(structures), &FIXTURE["structures"], "словарь построек");
    for lookup in FIXTURE["lookups"].as_array().expect("lookups") {
        let id = lookup["id"].as_str().expect("id");
        assert_json(
            &json!({ "id": id, "label": requirement_label(id), "assets": requirement_assets(id), "terrain": requirement_terrain(id) }),
            lookup,
            id,
        );
    }
}

#[test]
fn from_text_grid_matches_js() {
    let grid = &FIXTURE["fromTextGrid"];
    let mut check = Mismatches::new();
    for (word_index, word) in grid["words"].as_array().expect("words").iter().enumerate() {
        for (prefix_index, prefix) in grid["prefixes"].as_array().expect("prefixes").iter().enumerate() {
            let input = format!("{}{}", prefix.as_str().expect("prefix"), word.as_str().expect("word"));
            let actual: Vec<Value> = scene_requirements_from_text(&json!(input)).into_iter().map(|item| json!([item.id, sk_core::js::num(item.count)])).collect();
            check.check(&Value::Array(actual), &grid["outputs"][word_index][prefix_index], || format!("{input:?}"));
        }
    }
    check.finish("сетка словоформ");
}

#[test]
fn from_text_corpus_matches_js() {
    let mut check = Mismatches::new();
    for case in FIXTURE["fromText"].as_array().expect("fromText") {
        check.check(&items(case["input"].clone()), &case["output"], || format!("{}", case["input"]));
    }
    check.finish("фразы корпуса");
}

#[test]
fn map_requirements_match_js() {
    let npcs = FIXTURE["npcs"].as_array().expect("npcs");
    let landmark_sets = FIXTURE["landmarkSets"].as_array().expect("landmarkSets");
    let mut check = Mismatches::new();
    for case in FIXTURE["mapRequirements"].as_array().expect("mapRequirements") {
        let residents = case["npcs"].as_array().map(|list| Value::Array(list.iter().map(|index| npcs[index.as_u64().expect("номер") as usize].clone()).collect()));
        let landmarks = case["landmarks"].as_i64().filter(|index| *index >= 0).map(|index| landmark_sets[index as usize].clone());
        let actual = scene_map_requirements_for(&case["texts"], residents.as_ref(), landmarks.as_ref()).map(|program| program.to_value()).unwrap_or(Value::Null);
        check.check(&actual, &case["output"], || format!("{} npcs={} landmarks={}", case["texts"], case["npcs"], case["landmarks"]));
    }
    for case in FIXTURE["mapRequirementsOdd"].as_array().expect("odd") {
        let options = &case["options"];
        let actual = scene_map_requirements_for(&case["texts"], options.get("npcs"), options.get("landmarks")).map(|program| program.to_value()).unwrap_or(Value::Null);
        check.check(&actual, &case["output"], || format!("{options}"));
    }
    check.finish("программа сцены");
}

#[test]
fn normalizers_match_js() {
    let mut check = Mismatches::new();
    for case in FIXTURE["landmarks"].as_array().expect("landmarks") {
        check.check(&serde_json::to_value(normalize_landmarks(&case["input"])).expect("json"), &case["output"], || format!("якоря {}", case["input"]));
    }
    for case in FIXTURE["required"].as_array().expect("required") {
        check.check(&json!(required_program_kinds(&case["input"])), &case["output"], || format!("обязательные {}", case["input"]));
    }
    for case in FIXTURE["posts"].as_array().expect("posts") {
        check.check(&serde_json::to_value(normalize_scene_posts(&case["input"])).expect("json"), &case["output"], || format!("посты {}", case["input"]));
    }
    for case in FIXTURE["normalizeRequirements"].as_array().expect("normalize") {
        check.check(&serde_json::to_value(normalize_scene_requirements(&case["input"])).expect("json"), &case["output"], || format!("список {}", case["input"]));
    }
    check.finish("нормализация");
}

#[test]
fn mentions_match_js() {
    let ids = FIXTURE["mentionIds"].as_array().expect("mentionIds");
    let mut check = Mismatches::new();
    for case in FIXTURE["mentions"].as_array().expect("mentions") {
        for (index, id) in ids.iter().enumerate() {
            let id = id.as_str().expect("id");
            let text = Some(&case["text"]).filter(|value| !value.is_null());
            check.check(&json!(requirement_mention(text, id)), &case["outputs"][index], || format!("{} / {id}", case["text"]));
        }
    }
    check.finish("упоминания");
}

#[test]
fn anchors_and_coverage_match_js() {
    let mut check = Mismatches::new();
    for case in FIXTURE["anchorCounts"].as_array().expect("anchorCounts") {
        let terrain = if case["terrainMissing"] == json!(true) { None } else { Some(&case["terrain"]) };
        check.check(&anchor_counts_for(Some(&case["props"]), terrain), &case["output"], || format!("якоря {} {}", case["props"], case["terrain"]));
    }
    for case in FIXTURE["anchorCoverage"].as_array().expect("anchorCoverage") {
        let actual = anchor_coverage(&requirements(&case["requirements"]), Some(&case["anchors"]));
        check.check(&serde_json::to_value(actual).expect("json"), &case["output"], || format!("покрытие {} {}", case["requirements"], case["anchors"]));
    }
    for case in FIXTURE["coverage"].as_array().expect("coverage") {
        let terrain = if case["terrainMissing"] == json!(true) { None } else { Some(&case["terrain"]) };
        let actual = requirements_coverage(&requirements(&case["requirements"]), Some(&case["props"]), terrain);
        check.check(&serde_json::to_value(actual).expect("json"), &case["output"], || format!("обещанное {} {} {}", case["requirements"], case["props"], case["terrain"]));
    }
    check.finish("якоря и покрытие");
}

#[test]
fn structures_match_js() {
    let grid = &FIXTURE["structurePresent"];
    let locations = grid["locations"].as_array().expect("locations");
    let mut check = Mismatches::new();
    for (index, id) in grid["ids"].as_array().expect("ids").iter().enumerate() {
        let id = id.as_str().expect("id");
        for (facts_id, outputs) in grid["outputs"][index].as_object().expect("факты") {
            for (location_index, location) in locations.iter().enumerate() {
                let location = location.as_str().expect("место");
                check.check(&json!(structure_present(id, facts(facts_id), location)), &outputs[location_index], || format!("{id} / {facts_id} / {location}"));
            }
        }
    }
    for case in FIXTURE["textAgainstMap"].as_array().expect("textAgainstMap") {
        let value = Some(&case["value"]).filter(|value| !value.is_null());
        for output in case["outputs"].as_array().expect("outputs") {
            let (facts_id, location, journey) = (output[0].as_str().expect("факты"), output[1].as_str().expect("место"), output[2] == json!(true));
            let actual = serde_json::to_value(text_against_map(value, facts(facts_id), location, journey)).expect("json");
            check.check(&actual, &output[3], || format!("{} / {facts_id} / {location} / {journey}", case["value"]));
        }
    }
    for case in FIXTURE["missingStructure"].as_array().expect("missingStructure") {
        let location = case["location"].as_str().expect("место");
        let facts_id = case["facts"].as_str().expect("факты");
        check.check(&json!(missing_structure_for(location, facts(facts_id))), &case["output"], || format!("{location} / {facts_id}"));
    }
    check.finish("постройки");
}

// --- Перенесённые проверки test/scene-requirements.test.mjs -----------------

#[test]
fn live_prologue_gives_shelter_crate_three_platforms_and_threshold_stones() {
    let prologue = "Деревня проснулась рано. Под общим навесом стоит ящик с документами старосты, \
        к воде спускаются три дощатых настила, а на каждом крыльце — камни на порогах от сырости.";
    assert_eq!(
        items(json!(prologue)),
        json!([{ "id": "shelter", "count": 1 }, { "id": "crate", "count": 1 }, { "id": "platform", "count": 3 }, { "id": "threshold_stone", "count": 1 }])
    );
}

#[test]
fn russian_morphology_catches_cases_but_not_lookalikes() {
    assert_eq!(ids("У колодца, у костра и под навесами"), ["well", "campfire", "shelter"]);
    assert_eq!(ids("Сундуки, ларец и шкатулка"), ["chest"]);
    assert!(ids("Он навеселе. Столица шумит, у столба дежурит стража. Котлован пуст.").is_empty());
    assert!(ids("Подстолье и заборщик").is_empty(), "слово внутри другого слова не считается");
    assert_eq!(ids("СТАРЫЙ КОЛОДЕЦ"), ["well"], "регистр не важен");
}

#[test]
fn negation_drops_object_and_loose_number_is_not_a_count() {
    assert!(ids("Здесь нет колодца, а площадь без навеса.").is_empty());
    assert!(ids("Нет ни одного колодца у мельницы.").is_empty());
    assert_eq!(ids("Без старого навеса пусто, но колодец на месте."), ["well"]);
    assert_eq!(items(json!("В двух шагах от колодца")), json!([{ "id": "well", "count": 1 }]));
    assert_eq!(items(json!("Их было три. Настилы прогнили")), json!([{ "id": "platform", "count": 1 }]));
    assert_eq!(items(json!("Две бочки и 4 ящика")), json!([{ "id": "barrels", "count": 2 }, { "id": "crate", "count": 4 }]));
    assert_eq!(items(json!("Двенадцать фонарей")), json!([{ "id": "lantern", "count": 1 }]), "незнакомое числительное — просто «есть»");
    assert_eq!(items(json!("20 бочек")), json!([{ "id": "barrels", "count": 6 }]), "количество ограничено");
    // Повтор берёт наибольшее количество и первое место упоминания.
    assert_eq!(items(json!(["Костёр у дороги.", "Два костра дымят."])), json!([{ "id": "campfire", "count": 2 }]));
}

#[test]
fn scene_field_appears_only_with_promises_and_survives_normalization() {
    assert!(scene_map_requirements_for(&json!(["Пустая дорога в поле.", null, 42]), None, None).is_none());
    let field = scene_map_requirements_for(&json!("У колодца стоит телега"), None, None).expect("поле");
    assert_eq!(
        field.to_value(),
        json!({ "version": SCENE_REQUIREMENTS_VERSION, "items": [{ "id": "well", "count": 1 }, { "id": "cart", "count": 1 }], "focus": "well" })
    );
    assert_eq!(normalize_scene_requirements(&field.to_value()), field.items);
    assert_eq!(
        serde_json::to_value(normalize_scene_requirements(&json!([{ "id": "well", "count": 0 }, { "id": "well", "count": 3 }, { "id": "ufo" }, "x"]))).expect("json"),
        json!([{ "id": "well", "count": 1 }])
    );
    assert!(normalize_scene_requirements(&Value::Null).is_empty());
}

#[test]
fn every_kind_is_built_from_registry_assets_or_honestly_not() {
    let registered: std::collections::HashSet<&str> = list_assets().iter().map(|asset| asset.id.as_str()).collect();
    for kind in SCENE_REQUIREMENT_KINDS.iter() {
        for asset in kind.assets {
            assert!(registered.contains(asset), "{}: предмета {asset} нет в реестре", kind.id);
        }
        assert!(!requirement_label(kind.id).is_empty());
    }
    assert_eq!(requirement_assets("shelter"), ["market_awning"]);
    assert!(requirement_assets("platform").is_empty());
    let coverage = requirements_coverage(
        &[Requirement { id: "shelter".into(), count: 1.0 }, Requirement { id: "crate".into(), count: 2.0 }],
        Some(&json!({ "crate": 1, "chest": 1 })),
        None,
    );
    assert_eq!(coverage, Coverage { met: vec!["crate".into()], missing: vec!["shelter".into()] });
}

#[test]
fn scene_program_has_focus_posts_and_post_items() {
    let npcs = json!([
        { "name": "Илва", "role": "староста скита", "summary": "Держит раскрытую копию соглашения о проходе." },
        { "name": "Терен", "role": "хранитель записей", "summary": "Стоит у запертого ящика для документов." },
        { "name": "Вейра", "role": "мастер настилов", "summary": "Пахнет смолой и мокрым деревом." },
        { "name": "Гость", "role": "странник", "summary": "Молча слушает." },
    ]);
    let field = scene_map_requirements_for(&json!("В центре скита — общий навес, к воде спускаются три настила."), Some(&npcs), None).expect("поле");
    assert_eq!(field.version, "scene-requirements/v3");
    assert_eq!(field.focus.as_deref(), Some("shelter"));
    assert_eq!(
        serde_json::to_value(&field.posts).expect("json"),
        json!([{ "npc": "Илва", "id": "shelter" }, { "npc": "Терен", "id": "crate" }, { "npc": "Вейра", "id": "platform" }])
    );
    assert!(field.items.iter().any(|item| item.id == "crate"), "ящик хранителя попал в обещанное");
    assert_eq!(normalize_scene_posts(&field.to_value()), field.posts);
    assert!(normalize_scene_posts(&json!({ "items": [], "posts": [{ "npc": "x", "id": "ufo" }, { "npc": "", "id": "well" }] })).is_empty());
    assert!(normalize_scene_posts(&json!({ "version": "scene-requirements/v1", "items": [{ "id": "well", "count": 1 }] })).is_empty());
    let smith = scene_map_requirements_for(&json!("Площадь с колодцем."), Some(&json!([{ "name": "Тор", "role": "кузнец", "summary": "" }])), None).expect("поле");
    assert_eq!(serde_json::to_value(smith.posts).expect("json"), json!([{ "npc": "Тор", "id": "forge" }]));
}

#[test]
fn arrival_line_loses_sentences_about_missing_buildings_only() {
    let road = json!({ "theme": "road", "zones": [{ "kind": "exterior", "label": "Дорога" }, { "kind": "exterior", "label": "Река" }, { "kind": "exterior", "label": "Мост" }], "doors": 0, "props": [], "water": true });
    let tower = json!({ "theme": "building", "zones": [{ "kind": "exterior", "label": "Участок" }, { "kind": "interior", "label": "Парадный зал" }], "doors": 3, "props": [], "water": false });
    let arrival = json!("Над обрывом высится башня маяка. Тяжёлая дверь приоткрыта. Через реку перекинут мост. Вдали белеет ещё один маяк.");
    assert_eq!(
        text_against_map(Some(&arrival), &road, "Старый маяк", false),
        TextAgainstMap { text: "Через реку перекинут мост. Вдали белеет ещё один маяк.".into(), dropped: vec!["lighthouse".into(), "door".into()] }
    );
    assert_eq!(
        text_against_map(Some(&arrival), &tower, "Старый маяк", false),
        TextAgainstMap {
            text: "Над обрывом высится башня маяка. Тяжёлая дверь приоткрыта. Вдали белеет ещё один маяк.".into(),
            dropped: vec!["bridge".into()]
        }
    );
    let quoted = json!("Путь приводит героев в «Старую башню». Моста здесь нет.");
    assert_eq!(text_against_map(Some(&quoted), &road, "Старый маяк", false).text, "Путь приводит героев в «Старую башню». Моста здесь нет.");
    assert!(text_against_map(Some(&json!("Перед героями открывается Старый маяк.")), &road, "Старый маяк", false).dropped.is_empty());
    assert!(text_against_map(Some(&json!("Отряд переходит мост и покидает таверну.")), &tower, "Старый маяк", true).dropped.is_empty());
    assert_eq!(text_against_map(Some(&json!("Герои входят в таверну на берегу.")), &tower, "Старый маяк", true).dropped, ["tavern"]);
    assert_eq!(missing_structure_for("Старый маяк", &road), "lighthouse");
    assert_eq!(missing_structure_for("Старый маяк", &tower), "");
    assert_eq!(missing_structure_for("Северная пристань", &road), "");
    assert_eq!(requirement_label("lighthouse"), "маяк");
    assert!(SCENE_STRUCTURE_KINDS.iter().all(|kind| !SCENE_REQUIREMENT_KINDS.iter().any(|item| item.id == kind.id)));
}

#[test]
fn mooring_from_words_and_boat_only_from_landmarks() {
    assert_eq!(ids("Таверна стоит у самого причала, пахнет смолой."), ["mooring"]);
    assert!(ids("Баркас Тома не вернулся с ночного лова.").is_empty(), "пропавшая лодка — не предмет на карте");
    assert!(ids("Он причалил на рассвете, челнок застрял в ткацком станке.").is_empty());
    let marked = scene_map_requirements_for(&json!("Утро у пристани."), None, Some(&json!([{ "kind": "rowboat", "role": "clue" }]))).expect("поле");
    assert_eq!(serde_json::to_value(&marked.items).expect("json"), json!([{ "id": "mooring", "count": 1 }, { "id": "rowboat", "count": 1 }]));
    assert_eq!(marked.clues, ["rowboat"]);
    assert_eq!(requirement_assets("mooring"), ["mooring_post"]);
}

// --- test/map-quality.test.mjs: покрытие обещанного ---------------------------

#[test]
fn coverage_counts_quantities_and_platform_cells() {
    let needed = scene_requirements_from_text(&json!("Три настила и две бочки у колодца."));
    let coverage = requirements_coverage(&needed, Some(&json!({ "barrel": 1, "keg": 1, "well": 1 })), Some(&json!({ "platform": 2 })));
    assert_eq!(coverage.met, ["barrels", "well"]);
    assert_eq!(coverage.missing, ["platform"]);
    let enough = requirements_coverage(&needed, Some(&json!({ "barrel": 2, "well": 1 })), Some(&json!({ "platform": 3 })));
    assert!(enough.missing.is_empty());
}

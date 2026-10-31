//! Сверка `map_library` с эталоном JS (`fixtures/map-library.json`,
//! генератор `fixtures/gen-map-library.mjs`) и перенос
//! `test/map-library.test.mjs` и части `test/talestavern-collector.test.mjs`
//! про виды места — там, где предмет проверки сама библиотека (подбор через
//! `AdvanceScene` и Rules Engine — в крейтах верхних волн).

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_core::{hash, js};
use sk_story::map_library::{
    choose_library_map, climate_for, library_anchors, library_ids_in_use, library_level_problems, library_place_kinds, library_request_for, place_kinds_for,
    LibraryRequest, LibraryRequestInput, MapLibrary, PickOptions, LIBRARY_SEED_PREFIX, MAP_LIBRARY_DIR, MAP_LIBRARY_SCHEMA_VERSION, MIN_LIBRARY_QUALITY,
    MIN_LIBRARY_SCORE,
};

static FIXTURE: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("../fixtures/map-library.json")).expect("эталон"));

/// Пул карт этажей эталона по хешу.
static MAPS: LazyLock<HashMap<String, Value>> = LazyLock::new(|| {
    array(&FIXTURE["maps"]).iter().map(|entry| (entry["key"].as_str().expect("ключ").to_string(), entry["map"].clone())).collect()
});

fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or_else(|| panic!("массив в эталоне: {value}"))
}

fn stringify(value: &Value) -> String {
    js::stringify(value)
}

fn sha(value: &Value) -> String {
    hash::sha256_hex(stringify(value))
}

/// Этажи эталона с картами из пула (`{ "$map": <хеш> }`).
fn resolved(levels: &Value) -> Value {
    match levels {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|level| match level.get("map").and_then(|map| map.get("$map")).and_then(Value::as_str) {
                    Some(key) => {
                        let mut level = level.clone();
                        level["map"] = MAPS.get(key).cloned().unwrap_or_else(|| panic!("нет карты {key}"));
                        level
                    }
                    None => level.clone(),
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

fn strings(value: &Value) -> Vec<String> {
    array(value).iter().filter_map(Value::as_str).map(str::to_string).collect()
}

/// Виды места JS без ключей прототипа: в JS это функции, в JSON — `null`.
fn kinds_without_phantoms(value: &Value) -> Vec<String> {
    strings(value)
}

fn building(id: &str) -> &'static Value {
    array(&FIXTURE["buildings"]).iter().find(|building| building["id"] == id).unwrap_or_else(|| panic!("нет постройки {id}"))
}

/// Вход `libraryRequestFor` из эталона: отсутствующее поле — значение по умолчанию.
fn request_for(input: &Value) -> LibraryRequest {
    let text = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or("");
    let number = |key: &str, fallback: f64| input.get(key).map_or(fallback, |value| js::number(Some(value)));
    let levels: Vec<Value> = input.get("levels").and_then(Value::as_array).cloned().unwrap_or_default();
    let empty = json!([]);
    library_request_for(&LibraryRequestInput {
        theme_id: text("themeId"),
        building_use: text("buildingUse"),
        topology: text("topology"),
        climate: text("climate"),
        world_kind: text("worldKind"),
        levels: &levels,
        width: number("width", 26.0),
        height: number("height", 22.0),
        place: text("place"),
        world: text("world"),
        requirements: input.get("requirements").unwrap_or(&empty),
        program: input.get("program").unwrap_or(&Value::Null),
    })
}

fn input(value: Value) -> LibraryRequest {
    request_for(&value)
}

static TEMP: AtomicUsize = AtomicUsize::new(0);

/// Временный каталог хранилища; удаляется при выходе из области.
struct Storage(PathBuf);

impl Storage {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("sk-story-map-library-{}-{}", std::process::id(), TEMP.fetch_add(1, Ordering::SeqCst)));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("временный каталог");
        Self(path)
    }
}

impl Drop for Storage {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// --- эталон -------------------------------------------------------------------------

#[test]
fn constants_match_js() {
    let constants = &FIXTURE["constants"];
    assert_eq!(js::num(MIN_LIBRARY_SCORE), constants["MIN_LIBRARY_SCORE"]);
    assert_eq!(js::num(MIN_LIBRARY_QUALITY), constants["MIN_LIBRARY_QUALITY"]);
    assert_eq!(MAP_LIBRARY_DIR, constants["MAP_LIBRARY_DIR"]);
    assert_eq!(MAP_LIBRARY_SCHEMA_VERSION, constants["MAP_LIBRARY_SCHEMA_VERSION"]);
    assert_eq!(LIBRARY_SEED_PREFIX, constants["LIBRARY_SEED_PREFIX"]);
}

#[test]
fn place_kinds_and_climates_match_js() {
    for case in array(&FIXTURE["placeKinds"]) {
        let kinds = place_kinds_for(&strings(&case["types"]), &strings(&case["terrains"]), Some(&case["passport"]), case["title"].as_str().unwrap_or(""));
        assert_eq!(kinds, kinds_without_phantoms(&case["kinds"]), "placeKindsFor {}", stringify(case));
    }
    for case in array(&FIXTURE["climates"]) {
        assert_eq!(climate_for(&strings(&case["terrains"]), Some(&case["passport"])), case["climate"], "climateFor {}", stringify(case));
    }
}

#[test]
fn library_requests_match_js() {
    for case in array(&FIXTURE["requests"]) {
        let request = request_for(&case["input"]);
        assert_eq!(stringify(&request.to_json()), stringify(&case["request"]), "libraryRequestFor {}", stringify(&case["input"]));
        // Заявка из объекта JS — та же.
        assert_eq!(LibraryRequest::from_json(&case["request"]), request);
    }
}

#[test]
fn level_problems_match_js() {
    let cases = array(&FIXTURE["levels"]);
    assert!(cases.len() > 200);
    for case in cases {
        let problems: Vec<Value> = library_level_problems(&resolved(&case["levels"])).iter().map(|problem| problem.to_json()).collect();
        assert_eq!(stringify(&Value::Array(problems)), stringify(&case["problems"]), "{}", case["label"]);
    }
}

#[test]
fn entry_kinds_and_anchors_match_js() {
    for case in array(&FIXTURE["entries"]) {
        assert_eq!(library_place_kinds(&case["entry"]), kinds_without_phantoms(&case["placeKinds"]), "libraryPlaceKinds {}", case["entry"]["id"]);
        assert_eq!(stringify(&library_anchors(&case["entry"])), stringify(&case["anchors"]), "libraryAnchors {}", case["entry"]["id"]);
    }
}

#[test]
fn choose_library_map_matches_js() {
    let entries: Vec<Value> = array(&FIXTURE["entries"]).iter().map(|case| case["entry"].clone()).collect();
    let mut chosen = 0;
    for case in array(&FIXTURE["choose"]) {
        let pool: Vec<Value> = array(&case["pool"]).iter().map(|index| entries[index.as_u64().expect("индекс") as usize].clone()).collect();
        let request = LibraryRequest::from_json(&case["request"]);
        let used = strings(&case["usedIds"]);
        let picked = choose_library_map(&pool, &request, case["seed"].as_str().expect("сид"), &used).expect("подбор без отказа");
        let id = picked.map_or(Value::Null, |entry| entry["id"].clone());
        assert_eq!(id, case["chosen"], "chooseLibraryMap {}", stringify(case));
        chosen += usize::from(!id.is_null());
    }
    assert!(chosen > 100, "выбрано {chosen}");
}

#[test]
fn library_ids_in_use_match_js() {
    for case in array(&FIXTURE["idsInUse"]) {
        let ids: Vec<String> = library_ids_in_use(&case["locationMaps"]).into_iter().collect();
        assert_eq!(ids, strings(&case["ids"]), "libraryIdsInUse {}", stringify(&case["locationMaps"]));
    }
}

/// Сценарии `MapLibrary` во временном каталоге: файлы на диске — те же
/// байты, что пишет JS (хеш текста), подбор — тот же.
#[test]
fn library_scenarios_match_js() {
    for scenario in array(&FIXTURE["library"]) {
        let label = scenario["label"].as_str().expect("метка");
        let storage = Storage::new();
        let library = MapLibrary::new(&storage.0);
        let results = array(&scenario["results"]);
        for (index, step) in array(&scenario["steps"]).iter().enumerate() {
            let expected = &results[index];
            let context = format!("{label}, шаг {index} ({})", step["op"]);
            let actual = match step["op"].as_str().expect("шаг") {
                "put" => {
                    let levels = match step["building"].as_str() {
                        Some(id) => resolved(&building(id)["levels"]),
                        None => resolved(step.get("levels").unwrap_or(&json!([]))),
                    };
                    match library.put(&step["entry"], &levels) {
                        Err(error) => json!({ "error": error.message }),
                        Ok(()) => {
                            let dir = storage.0.join(MAP_LIBRARY_DIR);
                            let index_text = std::fs::read_to_string(dir.join("index.json")).expect("индекс");
                            let file = std::fs::read_to_string(dir.join("maps").join(format!("{}.json", js::string(step["entry"].get("id"))))).expect("этажи");
                            json!({ "index": hash::sha256_hex(index_text), "file": hash::sha256_hex(file) })
                        }
                    }
                }
                "pick" => {
                    let request = LibraryRequest::from_json(&step["request"]);
                    let answers: RefCell<Vec<bool>> = RefCell::new(step.get("answers").map(|answers| array(answers).iter().map(|answer| answer == &Value::Bool(true)).collect()).unwrap_or_default());
                    let calls = Cell::new(0);
                    let check = |_: &Value| {
                        calls.set(calls.get() + 1);
                        let mut answers = answers.borrow_mut();
                        if answers.is_empty() {
                            true
                        } else {
                            answers.remove(0)
                        }
                    };
                    let used = step.get("usedIds").map(strings).unwrap_or_default();
                    let options = PickOptions { seed: step["seed"].as_str().expect("сид"), used_ids: &used, check: step.get("answers").map(|_| &check as &dyn Fn(&Value) -> bool) };
                    let picked = library.pick(&request, &options).expect("подбор");
                    json!({
                        "id": picked.as_ref().map_or(Value::Null, |picked| picked.entry["id"].clone()),
                        "levels": picked.as_ref().map_or(Value::Null, |picked| Value::String(sha(&Value::Array(picked.levels.clone())))),
                        "calls": calls.get(),
                    })
                }
                "levels" => {
                    let levels = library.levels(step["id"].as_str().expect("id")).expect("этажи");
                    json!({ "levels": levels.map_or(Value::Null, |levels| Value::String(sha(&Value::Array(levels)))) })
                }
                "entries" => json!({ "ids": library.entries().expect("записи").iter().map(|entry| entry["id"].clone()).collect::<Vec<_>>() }),
                "raw-index" => {
                    // Кэш индекса — по времени изменения файла, как в JS: запись
                    // в тот же тик часов файловой системы осталась бы незамеченной.
                    // JS между шагами медленнее; здесь — явная пауза.
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    std::fs::write(storage.0.join(MAP_LIBRARY_DIR).join("index.json"), step["text"].as_str().expect("текст")).expect("запись индекса");
                    json!({ "ids": library.entries().expect("записи").iter().map(|entry| entry["id"].clone()).collect::<Vec<_>>() })
                }
                other => panic!("шаг {other}"),
            };
            assert_eq!(stringify(&actual), stringify(expected), "{context}");
        }
    }
}

// --- перенос test/map-library.test.mjs ------------------------------------------------

fn entry_for(id: &str, overrides: Value) -> Value {
    let mut entry = json!({
        "id": id,
        "title": format!("Карта {id}"),
        "source": { "site": "TalesTavern", "url": format!("https://talestavern.com/slab/{id}/"), "author": "Автор", "license": "Attribution-NonCommercial", "license_url": "https://creativecommons.org/licenses/by-nc/4.0/", "downloads": 10 },
        "place_kinds": ["tavern"],
        "climate": "",
        "terrains": [],
        "types": ["inn"],
        "passport": { "features": ["common_room", "bedrooms", "interior", "upstairs"], "interior_share": 0.8, "floor_cells": 500, "material": "wood", "summary": "Двухэтажное строение." },
        "levels": [{ "index": 0, "label": "Первый этаж" }],
        "slab_sha256": "x",
        "added_at": "2026-10-02T00:00:00.000Z",
    });
    if let (Some(object), Value::Object(overrides)) = (entry.as_object_mut(), overrides) {
        for (key, value) in overrides {
            object.insert(key, value);
        }
    }
    entry
}

fn yard_entry(id: &str, cells: i64, props: Value, types: Value, place_kinds: Value, features: Value) -> Value {
    let side = js::round((cells as f64).sqrt()) as i64;
    entry_for(
        id,
        json!({
            "place_kinds": place_kinds,
            "types": types,
            "passport": { "features": features, "interior_share": 0.2, "floor_cells": cells, "width": side, "height": side, "levels": [{ "index": 0, "label": "Земля", "cells": cells, "rooms": [] }], "material": "earth", "summary": "Открытая местность.", "props": props },
        }),
    )
}

fn yard(id: &str, cells: i64, props: Value) -> Value {
    yard_entry(id, cells, props, json!(["village"]), json!(["village"]), json!(["exterior", "street"]))
}

fn choose(entries: &[Value], request: &LibraryRequest, seed: &str, used: &[&str]) -> Option<String> {
    let used: Vec<String> = used.iter().map(|id| id.to_string()).collect();
    choose_library_map(entries, request, seed, &used).expect("подбор").map(|entry| js::string(entry.get("id")))
}

fn house_passport() -> Value {
    building("tt-house")["passport"].clone()
}

fn house_levels() -> Value {
    resolved(&building("tt-house")["levels"])
}

#[test]
fn scene_request_uses_generator_vocabulary() {
    assert_eq!(input(json!({ "themeId": "building", "buildingUse": "tavern" })).place_kinds, ["tavern"]);
    assert_eq!(input(json!({ "themeId": "building", "buildingUse": "manor" })).place_kinds, ["manor", "fortress"]);
    assert_eq!(input(json!({ "themeId": "cave", "worldKind": "dungeon" })).place_kinds, ["dungeon", "cave"]);
    assert!(input(json!({ "themeId": "forest" })).exterior);
    assert!(input(json!({ "themeId": "building", "levels": [{ "offset": -1 }] })).wants_cellar);
    let s = |items: &[&str]| items.iter().map(|item| item.to_string()).collect::<Vec<_>>();
    assert_eq!(place_kinds_for(&s(&["inn", "merchant"]), &s(&["desert"]), Some(&json!({ "features": [], "interior_share": 0.4 })), ""), ["shop", "tavern"]);
    // Паспорт не дописывает виды к авторским, но выручает, когда автор их не дал.
    assert_eq!(place_kinds_for(&[], &s(&["dungeon"]), Some(&json!({ "features": ["crypt"], "interior_share": 0.9 })), ""), ["dungeon"]);
    assert_eq!(place_kinds_for(&[], &[], Some(&json!({ "features": ["crypt"], "interior_share": 0.9 })), ""), ["crypt"]);
    assert_eq!(place_kinds_for(&s(&["merchant"]), &[], Some(&json!({ "features": [], "interior_share": 0.5 })), "Cog Small Ship Merchant"), ["ship"]);
    assert_eq!(input(json!({ "themeId": "settlement", "place": "Палуба торгового корабля" })).place_kinds, ["ship"]);
    assert_eq!(input(json!({ "themeId": "building", "world": "Киберпанк-мегаполис будущего" })).genre, "scifi");
    assert_eq!(input(json!({ "themeId": "building", "world": "Королевство драконов" })).genre, "fantasy");
    assert_eq!(climate_for(&s(&["desert"]), Some(&json!({ "material": "wood" }))), "arid");
    assert_eq!(climate_for(&[], Some(&json!({ "material": "ice" }))), "cold");
}

#[test]
fn choice_needs_place_kind_and_climate_and_skips_used_maps() {
    let entries = vec![
        entry_for("tavern-a", json!({})),
        entry_for("tavern-desert", json!({ "climate": "arid" })),
        entry_for("cave-a", json!({ "place_kinds": ["cave"], "types": ["caves"] })),
        entry_for("tavern-scifi", json!({ "passport": { "features": ["common_room"], "interior_share": 0.8, "floor_cells": 500, "material": "metal", "summary": "", "genre": "scifi" } })),
        entry_for("glade", json!({ "place_kinds": ["wilds"], "types": ["nature"], "passport": { "features": ["exterior", "grove"], "interior_share": 0.05, "floor_cells": 600, "material": "grass", "summary": "" } })),
    ];
    let tavern = input(json!({ "themeId": "building", "buildingUse": "tavern" }));
    assert_eq!(choose(&entries, &tavern, "a", &[]).as_deref(), Some("tavern-a"), "пустынная таверна в умеренном мире не встаёт");
    assert_eq!(choose(&entries, &LibraryRequest { climate: "arid".into(), ..tavern.clone() }, "a", &[]).as_deref(), Some("tavern-desert"));
    assert_eq!(choose(&entries, &tavern, "a", &["tavern-a"]), None, "единственная подходящая уже стоит в другой локации");
    assert_eq!(choose(&entries, &input(json!({ "themeId": "temple" })), "a", &[]), None, "нет храма — генератор сам");
    assert_eq!(choose(&entries, &input(json!({ "themeId": "forest", "climate": "arid" })), "a", &[]), None, "лесная поляна в пустыню не попадает");
    assert_eq!(choose(&entries, &input(json!({ "themeId": "forest" })), "a", &[]).as_deref(), Some("glade"));
    // Уличная сцена требует признака вида места.
    let bare = vec![entry_for("bare-field", json!({ "place_kinds": ["wilds"], "types": ["nature"], "passport": { "features": ["exterior"], "interior_share": 0.05, "floor_cells": 600, "material": "grass", "summary": "" } }))];
    assert_eq!(choose(&bare, &input(json!({ "themeId": "forest" })), "a", &[]), None);
    let station = input(json!({ "themeId": "building", "buildingUse": "tavern", "world": "орбитальная станция будущего" }));
    assert_eq!(choose(&entries, &station, "a", &[]).as_deref(), Some("tavern-scifi"), "бар станции — из научно-фантастического набора");
    // Выбор среди равных детерминирован по сиду места.
    let twins = vec![entry_for("twin-a", json!({})), entry_for("twin-b", json!({})), entry_for("twin-c", json!({}))];
    let picks: std::collections::HashSet<Option<String>> = ["s1", "s2", "s3", "s4", "s5", "s6"].iter().map(|seed| choose(&twins, &tavern, seed, &[])).collect();
    assert!(picks.len() > 1, "разные места получают разные карты из равных");
    assert_eq!(choose(&twins, &tavern, "s1", &[]), choose(&twins, &tavern, "s1", &[]));
}

#[test]
fn library_store_levels_and_ids_in_use() {
    let storage = Storage::new();
    let library = MapLibrary::new(&storage.0);
    assert!(library.entries().expect("записи").is_empty());
    library.put(&entry_for("tt-house", json!({ "passport": house_passport() })), &house_levels()).expect("запись");
    assert_eq!(library.entries().expect("записи").iter().map(|entry| entry["id"].clone()).collect::<Vec<_>>(), [json!("tt-house")]);
    let levels = library.levels("tt-house").expect("этажи").expect("есть");
    assert_eq!(levels.iter().map(|level| level["index"].clone()).collect::<Vec<_>>(), [json!(0), json!(1)]);
    assert_eq!(library.levels("../etc/passwd").expect("этажи"), None, "идентификатор не выводит за пределы каталога");
    let tavern = input(json!({ "themeId": "building", "buildingUse": "tavern" }));
    let picked = library.pick(&tavern, &PickOptions { seed: "x", used_ids: &[], check: None }).expect("подбор");
    assert_eq!(picked.map(|picked| picked.entry["id"].clone()), Some(json!("tt-house")));
    let ids: Vec<String> = library_ids_in_use(&json!({ "a": { "map": { "seed": "library:tt-house:0" } }, "b": { "map": { "seed": "other" } } })).into_iter().collect();
    assert_eq!(ids, ["tt-house"]);
}

#[test]
fn unplayable_map_is_skipped_for_next() {
    let storage = Storage::new();
    let library = MapLibrary::new(&storage.0);
    // Тот же дом без точки появления отряда: сцену на нём не начать.
    let mut broken = house_levels();
    if let Some(levels) = broken.as_array_mut() {
        for level in levels {
            if level["index"] == 0 {
                level["map"]["spawnPoints"] = json!([]);
            }
        }
    }
    library.put(&entry_for("tt-broken", json!({ "passport": house_passport() })), &broken).expect("запись");
    let request = input(json!({ "themeId": "building", "buildingUse": "tavern" }));
    let pick = |seed: &str| library.pick(&request, &PickOptions { seed, used_ids: &[], check: None }).expect("подбор").map(|picked| picked.entry["id"].clone());
    assert_eq!(pick("x"), None, "единственная карта битая — работает генератор");
    library.put(&entry_for("tt-house", json!({ "passport": house_passport() })), &house_levels()).expect("запись");
    for seed in ["s1", "s2", "s3", "s4"] {
        assert_eq!(pick(seed), Some(json!("tt-house")), "{seed}: выбрана битая карта");
    }
}

#[test]
fn farm_is_not_a_village_even_in_old_index() {
    let farmhouse = yard_entry("japanese-farmhouse", 256, json!({}), json!(["farm", "home"]), json!(["village"]), json!(["bedrooms", "camp", "exterior"]));
    assert_eq!(strings(&farmhouse["place_kinds"]), ["village"], "в индексе запись лежит деревней");
    assert_eq!(library_place_kinds(&farmhouse), ["house"], "нынешний словарь видит дом");
    assert_eq!(choose(&[farmhouse], &input(json!({ "themeId": "settlement" })), "a", &[]), None);
    let s = |items: &[&str]| items.iter().map(|item| item.to_string()).collect::<Vec<_>>();
    assert_eq!(place_kinds_for(&s(&["farm", "multiple-structures"]), &[], Some(&json!({ "features": [], "interior_share": 0.1 })), ""), ["village"]);
}

#[test]
fn passport_awning_passes_choice() {
    // Подбор по паспорту карту выбирает; проверку карты по программе делает
    // вызывающий (`check` в `pick`).
    let entry = yard("tt-awning", 600, json!({ "market_awning": 1 }));
    let request = input(json!({ "themeId": "settlement", "requirements": [{ "id": "shelter", "count": 1 }] }));
    assert_eq!(choose(&[entry], &request, "a", &[]).as_deref(), Some("tt-awning"), "по паспорту карта подходит");
}

#[test]
fn exterior_scene_needs_area_of_its_place_kind() {
    let village = input(json!({ "themeId": "settlement" }));
    assert_eq!(choose(&[yard("yard", 256, json!({}))], &village, "a", &[]), None, "80×80 футов — двор одного дома");
    assert_eq!(choose(&[yard("hamlet", 600, json!({}))], &village, "a", &[]).as_deref(), Some("hamlet"));
    assert_eq!(choose(&[yard("hamlet", 420, json!({}))], &input(json!({ "themeId": "settlement", "width": 40, "height": 30 })), "a", &[]), None);
    let mut passport = entry_for("x", json!({}))["passport"].clone();
    passport["floor_cells"] = json!(120);
    let tiny = entry_for("tiny-inn", json!({ "passport": passport }));
    assert_eq!(choose(&[tiny], &input(json!({ "themeId": "building", "buildingUse": "tavern" })), "a", &[]).as_deref(), Some("tiny-inn"));
}

#[test]
fn promised_objects_are_checked_against_map_anchors() {
    let plain = yard("plain-village", 600, json!({ "haystack": 2 }));
    let with_well = yard("well-village", 600, json!({ "well": 1, "campfire": 1 }));
    let request = |requirements: Value| input(json!({ "themeId": "settlement", "requirements": requirements }));
    assert!(MIN_LIBRARY_SCORE > 0.0);
    let both = [plain.clone(), with_well.clone()];
    assert!(["plain-village", "well-village"].contains(&choose(&both, &request(json!([])), "a", &[]).as_deref().unwrap_or("")));
    for seed in ["a", "b", "c", "d"] {
        assert_eq!(choose(&both, &request(json!([{ "id": "well", "count": 1 }])), seed, &[]).as_deref(), Some("well-village"));
    }
    let village = json!([{ "id": "shelter", "count": 1 }, { "id": "crate", "count": 1 }, { "id": "platform", "count": 3 }, { "id": "threshold_stone", "count": 1 }]);
    assert_eq!(choose(&both, &request(village), "a", &[]), None);
    assert_eq!(choose(&[with_well], &request(json!([{ "id": "well", "count": 2 }, { "id": "campfire", "count": 2 }])), "a", &[]), None);
    let normalized = request(json!([{ "id": "dragon", "count": 1 }, { "id": "well", "count": 99 }, null])).to_json()["requirements"].clone();
    assert_eq!(normalized, json!([{ "id": "well", "count": 6 }]));
}

#[test]
fn stage_five_required_anchors_and_import_quality() {
    let program = json!({ "items": [{ "id": "shelter", "count": 1 }, { "id": "well", "count": 1 }, { "id": "chest", "count": 1 }], "focus": "shelter", "posts": [{ "npc": "Терен", "id": "chest" }], "clues": ["well"] });
    let request = input(json!({ "themeId": "settlement", "requirements": program["items"], "program": program }));
    let mut required = request.required.clone();
    required.sort();
    assert_eq!(required, ["chest", "shelter", "well"]);
    let mut two = yard("two-of-three", 600, json!({}));
    two["passport"]["anchors"] = json!({ "shelter": 1, "well": 1 });
    let mut one = yard("one-of-three", 600, json!({}));
    one["passport"]["anchors"] = json!({ "shelter": 1 });
    assert_eq!(choose(std::slice::from_ref(&one), &request, "a", &[]), None, "меньше 60% обязательного — карта не годится");
    assert_eq!(choose(&[one, two], &request, "a", &[]).as_deref(), Some("two-of-three"));
    let legacy = yard("legacy", 600, json!({ "market_awning": 1, "well": 1, "chest": 1 }));
    assert_eq!(choose(&[legacy], &request, "a", &[]).as_deref(), Some("legacy"));
    let mut poor = yard("poor", 600, json!({ "market_awning": 1, "well": 1, "chest": 1 }));
    poor["passport"]["quality"] = json!({ "score": MIN_LIBRARY_QUALITY - 0.1, "reachable": 0.6, "dropped": 0.4, "cells": 600 });
    assert_eq!(choose(&[poor], &request, "a", &[]), None);
}

fn level_case(label: &str) -> Value {
    resolved(&array(&FIXTURE["levels"]).iter().find(|case| case["label"] == label).unwrap_or_else(|| panic!("нет случая {label}"))["levels"])
}

fn codes(levels: &Value) -> Vec<(f64, String)> {
    library_level_problems(levels).into_iter().map(|problem| (problem.level, problem.code)).collect()
}

#[test]
fn broken_upper_level_is_not_chosen_and_whole_house_is() {
    assert!(library_level_problems(&house_levels()).is_empty(), "целый дом: второй этаж без точки появления, но с обратной лестницей");
    assert_eq!(codes(&level_case("tt-house/upper-out-of-bounds")), [(1.0, "PROP_OUT_OF_BOUNDS".to_string())]);
    assert_eq!(codes(&level_case("tt-house/upper-walled-arrival")), [(1.0, "PARTY_SPAWN_BLOCKED".to_string())]);
    assert_eq!(codes(&level_case("tt-house/upper-no-return")), [(0.0, "TRANSITION_WITHOUT_RETURN".to_string()), (1.0, "LEVEL_UNREACHABLE".to_string())]);
    assert_eq!(codes(&level_case("tt-house/ground-only")).into_iter().map(|(_, code)| code).collect::<Vec<_>>(), ["TRANSITION_BROKEN"]);

    let storage = Storage::new();
    let library = MapLibrary::new(&storage.0);
    let request = input(json!({ "themeId": "building", "buildingUse": "tavern" }));
    library.put(&entry_for("tt-bad-upper", json!({ "passport": house_passport() })), &level_case("tt-house/upper-out-of-bounds")).expect("запись");
    library.put(&entry_for("tt-no-return", json!({ "passport": house_passport() })), &level_case("tt-house/upper-no-return")).expect("запись");
    let dir = storage.0.join(MAP_LIBRARY_DIR);
    let index_before = std::fs::read_to_string(dir.join("index.json")).expect("индекс");
    let map_before = std::fs::read_to_string(dir.join("maps").join("tt-bad-upper.json")).expect("этажи");
    let pick = |seed: &str| library.pick(&request, &PickOptions { seed, used_ids: &[], check: None }).expect("подбор");
    for seed in ["s1", "s2", "s3", "s4"] {
        assert_eq!(pick(seed), None, "{seed}: выбрана постройка с битым этажом");
    }
    assert_eq!(std::fs::read_to_string(dir.join("index.json")).expect("индекс"), index_before, "подбор библиотеку не переписывает");
    assert_eq!(std::fs::read_to_string(dir.join("maps").join("tt-bad-upper.json")).expect("этажи"), map_before, "запись битой не помечается");
    library.put(&entry_for("tt-house", json!({ "passport": house_passport() })), &house_levels()).expect("запись");
    for seed in ["s1", "s2", "s3", "s4"] {
        let picked = pick(seed).expect("целая постройка выбрана");
        assert_eq!(picked.entry["id"], "tt-house", "{seed}: целая постройка не выбрана");
        assert_eq!(picked.levels.iter().map(|level| level["index"].clone()).collect::<Vec<_>>(), [json!(0), json!(1)]);
        assert_eq!(pick(seed).map(|again| again.entry["id"].clone()), Some(picked.entry["id"].clone()), "выбор по сиду детерминирован");
    }
}

#[test]
fn map_failing_program_check_yields_to_next() {
    let storage = Storage::new();
    let library = MapLibrary::new(&storage.0);
    library.put(&yard("tt-first", 600, json!({})), &house_levels()).expect("запись");
    library.put(&yard("tt-second", 600, json!({})), &house_levels()).expect("запись");
    let seen = Cell::new(0);
    let check = |_: &Value| {
        seen.set(seen.get() + 1);
        seen.get() > 1
    };
    let picked = library.pick(&input(json!({ "themeId": "settlement" })), &PickOptions { seed: "next", used_ids: &[], check: Some(&check) }).expect("подбор");
    assert!(picked.is_some(), "вторая карта выбрана");
    assert_eq!(seen.get(), 2, "первую отбросила проверка, вторую она пропустила");
}

// --- перенос test/talestavern-collector.test.mjs (виды места) ----------------------------

#[test]
fn collector_record_keeps_village_kind_from_author_types() {
    // `libraryRecordFor`: виды места — `placeKindsFor` по категориям страницы
    // и паспорту импортированного слэба.
    let s = |items: &[&str]| items.iter().map(|item| item.to_string()).collect::<Vec<_>>();
    let passport = house_passport();
    assert!(place_kinds_for(&s(&["village"]), &s(&["woodland"]), Some(&passport), "Тестовая деревня").contains(&"village".to_string()));
    assert_eq!(climate_for(&s(&["woodland"]), Some(&passport)), "");
    // Категории автора без нашего вида — по паспорту, а без признаков — пусто.
    assert_eq!(place_kinds_for(&s(&["farm"]), &[], Some(&json!({ "features": [], "interior_share": 0 })), "Тестовая деревня"), Vec::<String>::new());
}

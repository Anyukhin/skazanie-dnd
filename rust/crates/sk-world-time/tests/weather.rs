//! Перенос `server/weather.mjs`: эталон JS (`fixtures/weather.json.gz`,
//! генератор `fixtures/gen-weather.mjs`) и проверки самого модуля из
//! `test/weather.test.mjs` (без движка правил, проекции и UI).

use std::io::Read;
use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::{hash, js};
use sk_world_time::weather::*;

static FIXTURE: LazyLock<Value> = LazyLock::new(|| {
    let bytes = include_bytes!("../fixtures/weather.json.gz");
    let mut text = String::new();
    flate2::read::GzDecoder::new(&bytes[..]).read_to_string(&mut text).expect("эталон погоды читается");
    serde_json::from_str(&text).expect("эталон погоды — JSON")
});

fn section(name: &str) -> &'static [Value] {
    FIXTURE[name].as_array().map(Vec::as_slice).unwrap_or(&[])
}

const SEED: &str = "weather-seed";

// ---------------------------------------------------------------------------
// Опрос состояния — то же, что `fixtures/weather-probe.mjs`
// ---------------------------------------------------------------------------

const PROBE_SKILLS: [&str; 7] = ["perception", "Survival", " stealth ", "sleight_of_hand", "persuasion", "PERCEPTION", ""];
const PROBE_MINUTES: [i64; 5] = [0, 300, 720, 1_260, 99_999];

fn probe_advances() -> Vec<Value> {
    vec![
        json!(0),
        json!(1),
        json!(59),
        json!(60),
        json!(180),
        json!(420),
        json!(480),
        json!(1_439),
        json!(1_440),
        json!(2_880),
        json!(4_000),
        json!("30"),
        json!(-5),
        json!(10_000_000),
        json!(1.5),
    ]
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().and_then(|object| object.get(key))
}

fn nullish<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    match first {
        None | Some(Value::Null) => second,
        some => some,
    }
}

fn probe_actor_ids(state: &Value) -> Vec<Value> {
    let mut ids = vec![Value::Null, json!("missing")];
    let mut add = |value: Option<&Value>| {
        let id = sk_core::text::trim(&js::s(value)).to_string();
        if !id.is_empty() && !ids.iter().any(|known| known.as_str() == Some(id.as_str())) {
            ids.push(Value::String(id));
        }
    };
    add(field(state, "activePlayerId"));
    for key in ["players", "enemies", "actors"] {
        let Some(list) = field(state, key).and_then(Value::as_array) else { continue };
        for actor in list.iter().take(3) {
            add(nullish(field(actor, "id"), field(actor, "actor_id")));
        }
    }
    ids
}

fn probe_location_ids(state: &Value) -> Vec<String> {
    let Some(locations) = field(state, "worldMap").and_then(|map| field(map, "locations")).and_then(Value::as_array) else {
        return Vec::new();
    };
    locations.iter().take(6).filter_map(|location| field(location, "id").and_then(Value::as_str).map(str::to_string)).collect()
}

fn region_key(region: Option<&Value>) -> Value {
    let Some(region) = region else { return Value::Null };
    let part = |key: &str| match field(region, key) {
        None => Value::Null,
        Some(value) => value.clone(),
    };
    json!([part("id"), part("name"), part("biome")])
}

fn opt(value: Option<Value>) -> Value {
    value.unwrap_or(Value::Null)
}

fn probe(state: &Value) -> Value {
    let actors: Vec<Value> = probe_actor_ids(state)
        .into_iter()
        .map(|id| {
            let actor = if id.is_null() { None } else { Some(&id) };
            json!({
                "id": id,
                "clock": world_clock_for(state, actor, None),
                "viewer": weather_for_viewer(state, actor),
                "agents": world_clock_for_agents(state, actor),
                "labels": weather_effect_labels(state, actor),
                "swings": PROBE_SKILLS.iter().map(|skill| opt(weather_check_swing(state, Some(&json!(skill)), actor))).collect::<Vec<_>>(),
                "ranged": opt(weather_ranged_penalty(state, actor)),
                "indoors": is_indoors(state, actor),
            })
        })
        .collect();
    let regions: Vec<Value> = probe_location_ids(state)
        .into_iter()
        .map(|location_id| {
            let mut after = state.clone();
            if let Some(map) = after.get_mut("worldMap").and_then(Value::as_object_mut) {
                map.insert("currentLocationId".into(), Value::String(location_id));
            }
            opt(region_weather_event_draft(state, &after))
        })
        .collect();
    let scene = match field(state, "scene") {
        None | Some(Value::Null) => Value::Object(Map::new()),
        Some(scene) => scene.clone(),
    };
    json!({
        "elapsed": elapsed_minutes_of(state),
        "seed": campaign_seed_of(state),
        "region": region_key(current_region_of(state)),
        "biome": current_biome_of(state),
        "weather": weather_of(state),
        "scene_indoor": is_indoor_scene(&scene),
        "clock": world_clock_for(state, None, None),
        "at_minutes": PROBE_MINUTES.iter().map(|minute| world_clock_for(state, Some(&json!(minute)), None)).collect::<Vec<_>>(),
        "actors": actors,
        "drafts": probe_advances().iter().map(|advance| world_clock_event_drafts(state, advance)).collect::<Vec<_>>(),
        "regions": regions,
    })
}

/// Сцена эталона держит ссылку на карту из таблицы `maps`.
fn resolve_maps(state: &mut Value) {
    let maps = section("maps");
    if let Some(scene) = state.get_mut("scene").and_then(Value::as_object_mut) {
        if let Some(index) = scene.get("map").and_then(|map| map.get("$map")).and_then(Value::as_u64) {
            scene.insert("map".into(), maps[index as usize].clone());
        }
    }
}

#[test]
fn fixture_states_match_js_probe() {
    let states = section("states");
    assert!(states.len() > 3_000, "эталон состояний неполон: {}", states.len());
    let mut failures = Vec::new();
    for case in states {
        let mut state = case["state"].clone();
        resolve_maps(&mut state);
        let actual = probe(&state);
        if hash::sha256_hex(js::stringify(&actual)) != case["probe"].as_str().unwrap_or_default() {
            if failures.is_empty() {
                if let Some(full) = case.get("full") {
                    eprintln!("ожидалось: {}", js::stringify(full));
                }
                eprintln!("получено:  {}", js::stringify(&actual));
            }
            failures.push(case["label"].as_str().unwrap_or("?").to_string());
        }
    }
    assert!(failures.is_empty(), "расхождения ({}): {:?}", failures.len(), &failures[..failures.len().min(20)]);
}

#[test]
fn fixture_clock_matches_js() {
    let targets = [json!(0), json!(300), json!(-1), json!(-1_441), json!(1_439), json!(1_440), json!(2.7), json!(-2.7), json!("600"), Value::Null, json!("x"), json!(true), json!(1e21)];
    for case in section("clock") {
        let minute = &case["minute"];
        assert_eq!(clock_minute_of(minute), case["clock_minute"].as_i64().unwrap_or(-1), "{minute}");
        assert_eq!(clock_label_of(minute), case["label"].as_str().unwrap_or_default(), "{minute}");
        assert_eq!(campaign_day_of(minute), case["day"].as_i64().unwrap_or(-1), "{minute}");
        assert_eq!(time_of_day_of(minute), case["phase"].as_str().unwrap_or_default(), "{minute}");
        let until: Vec<i64> = targets.iter().map(|target| minutes_until_clock(minute, target)).collect();
        assert_eq!(json!(until), case["until"], "{minute}");
        let state = json!({ "mechanics": { "world_time": { "elapsed_minutes": minute } } });
        assert_eq!(elapsed_minutes_of(&state), case["elapsed"].as_i64().unwrap_or(-1), "{minute}");
    }
}

#[test]
fn fixture_days_match_js() {
    let cases = section("days");
    assert!(cases.len() > 2_000);
    for case in cases {
        let seed = case["seed"].as_str().unwrap_or_default();
        let biome = case["biome"].as_str().unwrap_or_default();
        if case.get("from").is_some() {
            let expected = case["weather"].as_str().unwrap_or_default();
            let count = expected.split(',').count() as i64;
            let actual: Vec<&str> = (0..count).map(|day| weather_on_day(seed, day, biome)).collect();
            assert_eq!(actual.join(","), expected, "{seed} / {biome}");
        } else {
            assert_eq!(weather_on_day(seed, &case["day"], biome), case["weather"].as_str().unwrap_or_default(), "{case}");
        }
    }
}

#[test]
fn fixture_labels_pins_narration_scenes_effects_match_js() {
    for case in section("labels") {
        let id = js::string(Some(&case["id"]));
        assert_eq!(day_phase_label(&id), case["phase"].as_str().unwrap_or_default(), "{case}");
        assert_eq!(weather_condition_label(&id), case["weather"].as_str().unwrap_or_default(), "{case}");
        assert_eq!(weather_condition_summary(&id), case["summary"].as_str().unwrap_or_default(), "{case}");
    }
    for case in section("pins") {
        let state = if case.get("state").is_some() { Value::Null } else { json!({ "mechanics": { "weather_pins": case["pins"] } }) };
        assert_eq!(pinned_weather_on(&state, &case["day"]), case["weather"].as_str().unwrap_or_default(), "{case}");
    }
    for case in section("narration") {
        assert_eq!(world_clock_narration(&case["event"]), case["text"].as_str().unwrap_or_default(), "{case}");
    }
    for case in section("scenes") {
        assert_eq!(is_indoor_scene(&case["scene"]), case["indoor"].as_bool().unwrap_or(false), "{case}");
    }
    for case in section("effects") {
        let ids: Vec<&str> = weather_effects_under(
            case["indoors"].as_bool().unwrap_or(false),
            case["phase"].as_str().unwrap_or_default(),
            case["weather"].as_str().unwrap_or_default(),
        )
        .into_iter()
        .map(|effect| effect.id)
        .collect();
        assert_eq!(json!(ids), case["ids"], "{case}");
    }
}

// ---------------------------------------------------------------------------
// Проверки модуля из `test/weather.test.mjs`
// ---------------------------------------------------------------------------

#[test]
fn weather_is_a_pure_function_of_seed_day_and_climate() {
    for day in 0..12 {
        let first = weather_on_day(SEED, day, "plains");
        assert_eq!(weather_on_day(SEED, day, "plains"), first, "повторный вопрос даёт тот же ответ");
        assert!(WEATHER_CONDITION_IDS.contains(&first), "погода берётся только из закрытого списка");
    }
    let mine: Vec<&str> = (0..30).map(|day| weather_on_day(SEED, day, "plains")).collect();
    let other: Vec<&str> = (0..30).map(|day| weather_on_day("иной-сид", day, "plains")).collect();
    let swamp: Vec<&str> = (0..30).map(|day| weather_on_day(SEED, day, "marsh")).collect();
    assert_ne!(mine, other, "у другой кампании своя погода");
    assert_ne!(mine, swamp, "в топях небо не такое, как на равнине");
}

#[test]
fn climate_tables_are_closed_complete_and_sum_up() {
    let declared: Vec<&str> = sk_geometry::world_map::BIOMES.to_vec();
    let table: Vec<&str> = BIOME_WEATHER_WEIGHTS.iter().map(|(biome, _)| *biome).collect();
    let mut sorted_declared = declared.clone();
    sorted_declared.sort_unstable();
    let mut sorted_table = table.clone();
    sorted_table.sort_unstable();
    assert_eq!(sorted_table, sorted_declared, "у климата карты мира нет строки в таблице погоды (или наоборот)");
    for (biome, weights) in BIOME_WEATHER_WEIGHTS {
        assert_eq!(weights.iter().sum::<i64>(), WEATHER_TABLE_WEIGHT, "сумма весов климата {biome} съехала");
    }
}

#[test]
fn time_of_day_and_calendar_follow_boundaries() {
    assert_eq!(clock_label_of(0), "08:00", "кампания начинается утром, а не в полночь");
    assert_eq!(time_of_day_of(0), "morning");
    assert_eq!(time_of_day_of(3 * 60), "day", "11:00 — уже день");
    assert_eq!(time_of_day_of(9 * 60), "evening", "17:00 — вечер");
    assert_eq!(time_of_day_of(14 * 60), "night", "22:00 — ночь");
    assert_eq!(time_of_day_of(20 * 60), "night", "04:00 — ещё ночь");
    assert_eq!(time_of_day_of(21 * 60), "morning", "05:00 — рассвет");
    assert_eq!(campaign_day_of(0), 0);
    assert_eq!(campaign_day_of(20 * 60 + 59), 0, "без минуты пять утра — ещё вчерашний день");
    assert_eq!(campaign_day_of(21 * 60), 1, "ровно в пять утра начинаются новые сутки");
}

#[test]
fn scene_themes_split_into_indoor_and_outdoor_without_remainder() {
    for theme in sk_themes::scene_themes::SCENE_THEMES.iter() {
        let indoor = INDOOR_SCENE_THEMES.contains(&theme.id);
        let outdoor = OUTDOOR_SCENE_THEMES.contains(&theme.id);
        assert!(indoor != outdoor, "тема {} не отнесена ни к помещению, ни к улице (или сразу к обоим)", theme.id);
    }
    assert!(is_indoor_scene(&json!({ "location": "Безымянное место", "scene_kind": "dungeon" })));
    assert!(!is_indoor_scene(&json!({ "location": "Безымянное место", "scene_kind": "wilderness" })));
    assert!(!is_indoor_scene(&json!({})), "без данных сцена считается открытой");
}

#[test]
fn one_sky_never_gives_a_skill_both_sides() {
    let mut seen = Vec::new();
    for phase in DAY_PHASE_IDS {
        for weather in WEATHER_CONDITION_IDS {
            let mut by_skill: Vec<(&str, &str)> = Vec::new();
            for effect in weather_effects_under(false, phase, weather) {
                for skill in effect.skills {
                    if !seen.contains(skill) {
                        seen.push(*skill);
                    }
                    if let Some((_, previous)) = by_skill.iter().find(|(known, _)| known == skill) {
                        assert_eq!(*previous, effect.swing, "{phase}/{weather}: навыку {skill} назначены обе стороны");
                    }
                    by_skill.push((skill, effect.swing));
                }
            }
            assert!(weather_effects_under(true, phase, weather).is_empty(), "под крышей не действует ничего");
        }
    }
    seen.sort_unstable();
    let mut affected = WEATHER_AFFECTED_SKILLS.to_vec();
    affected.sort_unstable();
    assert_eq!(seen, affected, "набор затронутых навыков выводится из таблицы");
    let ids: Vec<&str> = WEATHER_EFFECTS.iter().map(|effect| effect.id).collect();
    assert_eq!(ids, WEATHER_EFFECT_IDS);
}

#[test]
fn pinned_sky_ignores_junk() {
    let state = json!({ "mechanics": { "weather_pins": [{ "day": 0.5, "weather": "storm" }, { "day": 0, "weather": "snow" }, null] } });
    assert_eq!(pinned_weather_on(&state, 0), "");
    let pinned = json!({ "mechanics": { "weather_pins": [{ "day": 0, "weather": "storm" }], "world_time": { "elapsed_minutes": 900 } } });
    assert_eq!(pinned_weather_on(&pinned, 0), "storm");
    assert_eq!(weather_of(&pinned), "storm");
}

#[test]
fn chronicle_line_is_deterministic_and_russian() {
    let phase = world_clock_narration(&json!({ "event_type": "TimeOfDayChanged", "payload": { "phase_after": "night" } }));
    assert_eq!(phase, "Темнеет окончательно — наступила ночь.");
    let sky = world_clock_narration(&json!({ "event_type": "WeatherChanged", "payload": { "weather_after": "storm" } }));
    assert!(sky.starts_with("Собралась гроза."));
    assert_eq!(world_clock_narration(&json!({ "event_type": "AttackResolved", "payload": {} })), "", "чужое событие рассказчик неба не описывает");
    let region = world_clock_narration(&json!({ "event_type": "WeatherChanged", "payload": { "weather_after": "rain", "reason": "region" } }));
    assert!(region.starts_with("За краем — другое небо."));
}

/// Ключ прототипа вместо времени суток, неба или климата — незнакомое значение:
/// пустая строка летописи и климат по умолчанию.
#[test]
fn prototype_key_in_payload_is_unknown_value() {
    let line = world_clock_narration(&json!({ "event_type": "TimeOfDayChanged", "payload": { "phase_after": "constructor" } }));
    assert_eq!(line, "");
    let sky = world_clock_narration(&json!({ "event_type": "WeatherChanged", "payload": { "weather_after": "toString", "reason": "region" } }));
    assert!(sky.starts_with("За краем — другое небо.") && !sky.contains("native code"), "{sky}");
    // Климат-ключ прототипа берёт веса равнины (сид дня — по исходному слову).
    let days: Vec<&str> = (0..9).map(|day| weather_on_day(SEED, day, "constructor")).collect();
    assert_eq!(days, ["clear", "clear", "clear", "storm", "rain", "overcast", "overcast", "overcast", "clear"]);
}

/// Замечено в JS: число вместо героя `weatherForViewer` читает как минуты.
#[test]
fn numeric_actor_id_is_read_as_minutes_like_js() {
    let state = json!({ "mechanics": { "world_time": { "elapsed_minutes": 0 } } });
    assert_eq!(weather_for_viewer(&state, Some(&json!(780)))["clock"], json!("21:00"));
}

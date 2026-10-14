//! Сверка `talespire_slab` с JS: эталон `fixtures/talespire-slab.json`
//! (`fixtures/gen-talespire-slab.mjs`, слэбы собраны кодировщиком
//! `test/talespire-fixtures.mjs`) и перенесённые проверки разбора из
//! `test/talespire-import.test.mjs`.

mod common;

use std::sync::LazyLock;

use common::Mismatches;
use serde_json::{json, Value};
use sk_scene_base::talespire_slab::*;

static FIXTURE: LazyLock<Value> =
    LazyLock::new(|| serde_json::from_str(include_str!("../fixtures/talespire-slab.json")).expect("эталон talespire-slab"));

fn decoded(input: &Value) -> Value {
    // `undefined` эталон записывает меткой.
    let text = input.as_str().filter(|text| *text != "__undefined__");
    match decode_slab(text) {
        Ok(slab) if slab.instances.len() > 400 => {
            let instances = Value::Array(slab.instances.iter().map(SlabInstance::to_value).collect());
            let text = serde_json::to_string(&instances).expect("json");
            json!({ "summary": {
                "version": slab.version, "packedBytes": slab.packed_bytes, "kinds": slab.kinds,
                "count": slab.instances.len(), "sha256": sk_core::hash::sha256_hex(text),
            } })
        }
        Ok(slab) => json!({ "slab": slab.to_value() }),
        Err(error) => json!({ "error": { "code": error.code, "message": error.message, "name": "TaleSpireSlabError" } }),
    }
}

fn case(label: &str) -> &'static Value {
    FIXTURE["cases"].as_array().expect("cases").iter().find(|case| case["label"] == label).unwrap_or_else(|| panic!("нет случая {label}"))
}

#[test]
fn slabs_match_js() {
    let mut check = Mismatches::new();
    for case in FIXTURE["cases"].as_array().expect("cases") {
        check.check(&decoded(&case["input"]), &case["output"], || format!("{}", case["label"]));
    }
    check.finish("слэбы");
}

#[test]
fn guid_and_text_normalization_match_js() {
    let mut check = Mismatches::new();
    for case in FIXTURE["guids"].as_array().expect("guids") {
        let bytes: Vec<u8> = case["bytes"].as_array().expect("bytes").iter().map(|byte| byte.as_u64().expect("байт") as u8).collect();
        check.check(&json!(guid_from_bytes(&bytes)), &case["output"], || format!("{bytes:?}"));
    }
    for case in FIXTURE["normalized"].as_array().expect("normalized") {
        // `String(text ?? '')`.
        let text = match &case["text"] {
            Value::String(text) if text == "__undefined__" => String::new(),
            Value::String(text) => text.clone(),
            Value::Null => String::new(),
            other => other.to_string(),
        };
        check.check(&json!(normalize_slab_text(&text)), &case["output"], || format!("{}", case["text"]));
    }
    check.finish("GUID и текст");
}

// --- test/talespire-import.test.mjs: разбор слэба -----------------------------

#[test]
fn v2_slab_decodes_cells_and_15_degree_rotation() {
    let slab = decode_slab(case("две записи v2")["input"].as_str()).expect("слэб");
    assert_eq!(slab.version, 2);
    assert_eq!(slab.kinds, 2);
    let door = slab.instances.iter().find(|instance| matches!(instance, SlabInstance::V2 { rotation, .. } if *rotation == 90.0)).expect("дверь");
    let SlabInstance::V2 { x, y, z, rotation, .. } = door else { panic!("v2") };
    assert_eq!((*x, *y, *z, *rotation), (6.75, 0.5, 3.0, 90.0));
}

#[test]
fn v1_slab_carries_world_box_and_quarter_turns() {
    let slab = decode_slab(case("дверь v1")["input"].as_str()).expect("слэб");
    assert_eq!(slab.version, 1);
    let SlabInstance::V1 { center, extent, rotation, .. } = &slab.instances[0] else { panic!("v1") };
    assert_eq!((center.x, center.y, center.z), (7.0, 1.5, 3.5));
    assert_eq!((extent.x, extent.y, extent.z), (0.25, 1.0, 0.5));
    assert_eq!(*rotation, 90.0);
}

#[test]
fn backtick_fence_and_messenger_line_breaks_do_not_matter() {
    let house = decode_slab(case("дом v2")["input"].as_str()).expect("дом");
    let wrapped = decode_slab(case("кавычки и переносы")["input"].as_str()).expect("в кавычках");
    assert_eq!(wrapped.instances.len(), house.instances.len());
}

#[test]
fn garbage_gets_clear_code_not_zlib_exception() {
    for (label, code) in [
        ("пусто", "SLAB_EMPTY"),
        ("число", "SLAB_EMPTY"),
        ("не base64", "SLAB_NOT_BASE64"),
        ("base64 текста", "SLAB_NOT_GZIP"),
        ("неверная сигнатура", "SLAB_BAD_MAGIC"),
        ("версия 3", "SLAB_VERSION_UNSUPPORTED"),
        ("обрезанный заголовок", "SLAB_TRUNCATED"),
        ("слишком длинный текст", "SLAB_TOO_LARGE"),
    ] {
        let error = decode_slab(case(label)["input"].as_str()).expect_err(label);
        assert_eq!(error.code, code, "{label}");
    }
}

#[test]
fn layouts_and_instances_are_limited_before_building_instances() {
    let flood = case("лавина объектов")["input"].as_str().expect("слэб");
    let started = std::time::Instant::now();
    assert_eq!(decode_slab(Some(flood)).expect_err("лавина").code, "SLAB_TOO_MANY_INSTANCES");
    assert!(started.elapsed().as_millis() < 2000, "отказ по заголовкам видов");
    assert_eq!(decode_slab(case("видов больше предела")["input"].as_str()).expect_err("виды").code, "SLAB_TOO_MANY_LAYOUTS");
    assert_eq!(decode_slab(case("предел объектов")["input"].as_str()).expect("предел").instances.len(), SLAB_MAX_INSTANCES);
}

#[test]
fn huge_but_finite_v1_is_rejected() {
    for (label, code) in [
        ("v1 1e+30,0.25,0.5,0.5,0.25,0.5 r0", "SLAB_COORDINATE_OUT_OF_RANGE"),
        ("v1 100000000000000000,0.25,0.5,20,0.25,0.5 r0", "SLAB_COORDINATE_OUT_OF_RANGE"),
        ("v1 5,0.25,5,100000,0.25,100000 r0", "SLAB_EXTENT_TOO_LARGE"),
        ("v1 NaN,0,0,1,1,1 r0", "SLAB_CORRUPT"),
    ] {
        assert_eq!(decode_slab(case(label)["input"].as_str()).expect_err(label).code, code, "{label}");
    }
    assert_eq!(decode_slab(case("далёкая комната v1")["input"].as_str()).expect("далёкая").instances.len(), 100);
}

//! `world_template_catalog`: эталон JS (`fixtures/world-template-catalog.json`)
//! — вызовы из тестов модуля, экспорты на всех шаблонах и мусорных id и
//! мутации каталога: `loadCatalog` JS на `data/campaign-worlds-v1.json` с
//! одной-двумя правками против [`validate_world_template_catalog`] на тех же
//! правках.

mod common;

use std::sync::LazyLock;

use common::{ok, Args, Fixture, JsError, Outcome};
use serde_json::{json, Value};
use sk_world_time::world_template_catalog::*;

static DATA: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("../../../../data/campaign-worlds-v1.json")).expect("каталог миров"));

fn error(error: WorldTemplateCatalogError) -> JsError {
    JsError { name: error.name.to_string(), code: Some(error.code), message: error.message }
}

fn outcome(result: Result<Value, WorldTemplateCatalogError>) -> Outcome {
    result.map(Some).map_err(error)
}

/// Правка эталона — как `applyMutation` генератора.
fn apply_mutation(root: &mut Value, mutation: &Value) {
    let path = mutation["path"].as_array().cloned().unwrap_or_default();
    let Some((last, parents)) = path.split_last() else { return };
    let mut parent = root;
    for key in parents {
        let next = match (parent, key) {
            (Value::Array(items), Value::Number(index)) => items.get_mut(index.as_u64().unwrap_or(u64::MAX) as usize),
            (Value::Object(map), key) => map.get_mut(&key.as_str().map_or_else(|| key.to_string(), str::to_string)),
            _ => None,
        };
        match next {
            Some(value) if value.is_object() || value.is_array() => parent = value,
            _ => return,
        }
    }
    let op = mutation["op"].as_str().unwrap_or_default();
    let value = mutation.get("value").cloned().unwrap_or(Value::Null);
    let slot: Option<&mut Value> = match (&mut *parent, last) {
        (Value::Array(items), Value::Number(index)) => {
            let index = index.as_u64().unwrap_or(u64::MAX) as usize;
            match op {
                "set" => {
                    while items.len() <= index {
                        items.push(Value::Null);
                    }
                    items[index] = value;
                    return;
                }
                "delete" => {
                    if index < items.len() {
                        items.remove(index);
                    }
                    return;
                }
                _ => items.get_mut(index),
            }
        }
        (Value::Object(map), key) => {
            let key = key.as_str().map_or_else(|| key.to_string(), str::to_string);
            match op {
                "set" => {
                    map.insert(key, value);
                    return;
                }
                "delete" => {
                    map.shift_remove(&key);
                    return;
                }
                _ => map.get_mut(&key),
            }
        }
        _ => None,
    };
    let Some(Value::Array(items)) = slot else { return };
    match op {
        "dup" if !items.is_empty() => {
            let first = items[0].clone();
            items.push(first);
        }
        "clear" => items.clear(),
        "remove" if !items.is_empty() => {
            items.pop();
        }
        _ => {}
    }
}

fn load_mutated(mutations: Option<&Value>) -> Outcome {
    let mut payload = DATA.clone();
    for mutation in mutations.and_then(Value::as_array).into_iter().flatten() {
        apply_mutation(&mut payload, mutation);
    }
    validate_world_template_catalog(&payload, &image_exists_in_project).map(|templates| Some(Value::Array(templates))).map_err(error)
}

pub fn run(name: &str, args: &Args) -> Outcome {
    let empty = json!({});
    match name {
        "listWorldTemplates" => list_world_templates().map(|list| Some(Value::Array(list))).map_err(error),
        "getWorldTemplate" => outcome(get_world_template(args.get(0))),
        "worldTemplateOpening" => outcome(world_template_opening(args.get(0), args.get(1).unwrap_or(&empty))),
        "worldTemplateConcept" => outcome(world_template_concept(args.get(0))),
        "loadCatalog" => load_mutated(args.get(0)),
        other => {
            let _ = ok(Value::Null);
            panic!("неизвестная функция эталона {other}")
        }
    }
}

#[test]
fn world_template_catalog_matches_js() {
    let fixture = Fixture::load(include_str!("../fixtures/world-template-catalog.json"));
    let summary = common::check(&fixture, run);
    println!("{summary:?}");
    assert!(summary.calls > 1_000, "{summary:?}");
}

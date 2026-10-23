//! Кости тестового сервера — по образцу `test/kit/dice.mjs` и опции `dice`
//! `startTestServer`: те же правила `skazanie.test-dice/1`, что читает бинарь
//! (`sk_server::test_hooks::RulesDice`), только с детерминированными id и
//! временем броска.

use std::path::PathBuf;

use serde_json::Value;
use sk_dice::{Dice, DiceService, FixedRng, SequenceRng};
use sk_server::test_hooks::{DicePicker, RulesDice, DICE_FORMAT};

/// Кости набора по умолчанию: каждая грань — 10 (прижимается к грани).
pub fn fixed(value: i64) -> Box<dyn Dice + Send> {
    Box::new(DiceService::deterministic(FixedRng(value), "roll"))
}

/// Значения по очереди; кончились — отказ броска.
pub fn sequence(values: impl Into<Vec<i64>>) -> Box<dyn Dice + Send> {
    Box::new(DiceService::deterministic(SequenceRng::new(values), "roll"))
}

/// Правила костей объектом; поле `format` можно опустить, как у `hookData` JS.
pub fn rules(spec: Value) -> Box<dyn Dice + Send> {
    let mut spec = spec;
    if let Some(map) = spec.as_object_mut() {
        map.entry("format").or_insert_with(|| Value::from(DICE_FORMAT));
    }
    let picker = DicePicker::parse(&spec.to_string()).unwrap_or_else(|error| panic!("правила костей: {error}"));
    Box::new(RulesDice::deterministic(picker, "roll"))
}

/// Корень репозитория (для `test/fixtures/*.dice.json`).
pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("..")
}

/// Правила из общего файла `test/fixtures/<имя>.dice.json` — те же, что у JS-тестов.
pub fn rules_file(name: &str) -> Box<dyn Dice + Send> {
    let path = repo_root().join("test").join("fixtures").join(format!("{name}.dice.json"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    rules(serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display())))
}

//! Сверка нормализации `normalizeCampaignState` с JS: `sk-corpus normalize <каталог>`.
//!
//! Эталон — `sk-rules/fixtures/normalize-corpus.json` (снимает
//! `gen-normalize-corpus.mjs`): по каждому состоянию `states/` корпуса sha256
//! `JSON.stringify` нормализованного JS-состояния целиком и без производных
//! полей героя. `SK_CORPUS_DUMP=<каталог>` кладёт туда Rust-итог первых
//! расхождений (`<sha>.json`), чтобы сравнить с `--dump` генератора.

use std::collections::BTreeMap;

use serde_json::Value;
use sk_core::{hash, js};

use crate::Corpus;

const ORACLE: &str = include_str!("../../sk-rules/fixtures/normalize-corpus.json");

/// Производные поля героя (`DERIVED_PLAYER_FIELDS`).
const DERIVED: [&str; 4] = ["combatSpells", "combatActions", "characterSheet", "inventoryLoad"];

/// Итог сверки нормализации.
#[derive(Debug, Default)]
pub struct NormalizeReport {
    pub total: usize,
    /// Совпало целиком (с производными полями героя).
    pub equal: usize,
    /// Совпало без производных полей героя, а с ними — нет.
    pub equal_without_derived: usize,
    pub different: usize,
    /// Rust бросил там, где JS нет (или наоборот).
    pub throws_mismatch: usize,
    pub missing_state: usize,
    pub errors: BTreeMap<String, usize>,
    pub different_hashes: Vec<String>,
    pub derived_hashes: Vec<String>,
}

impl NormalizeReport {
    pub fn render(&self) -> String {
        let mut text = format!(
            "состояний: {}\n  совпало целиком: {}\n  совпало без производных полей героя: {}\n  расходится: {}\n  бросает не так, как JS: {}\n  нет состояния: {}\n",
            self.total, self.equal, self.equal_without_derived, self.different, self.throws_mismatch, self.missing_state
        );
        for (message, count) in &self.errors {
            text.push_str(&format!("  {count:5}  {message}\n"));
        }
        text.push_str("\nрасходятся (первые):\n");
        for hash in self.different_hashes.iter().take(20) {
            text.push_str(&format!("  {hash}\n"));
        }
        text.push_str("\nрасходятся только производные поля (первые):\n");
        for hash in self.derived_hashes.iter().take(20) {
            text.push_str(&format!("  {hash}\n"));
        }
        text
    }
}

fn stripped(state: &Value) -> Value {
    let mut copy = state.clone();
    if let Some(players) = copy.get_mut("players").and_then(Value::as_array_mut) {
        for player in players {
            if let Some(map) = player.as_object_mut() {
                for field in DERIVED {
                    map.shift_remove(field);
                }
            }
        }
    }
    copy
}

/// Сверить нормализацию на всех состояниях эталона.
pub fn check_normalize(corpus: &Corpus, limit: Option<usize>) -> std::io::Result<NormalizeReport> {
    let oracle: Value = serde_json::from_str(ORACLE).map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    let dump = std::env::var("SK_CORPUS_DUMP").ok();
    let mut report = NormalizeReport::default();
    let cases = oracle.get("cases").and_then(Value::as_array).cloned().unwrap_or_default();
    for case in cases.iter().take(limit.unwrap_or(usize::MAX)) {
        let (Some(state_hash), Some(full), Some(without)) = (case.get(0).and_then(Value::as_str), case.get(1).and_then(Value::as_str), case.get(2).and_then(Value::as_str)) else { continue };
        report.total += 1;
        let Ok(state) = corpus.state(state_hash) else {
            report.missing_state += 1;
            continue;
        };
        match sk_rules::normalize::normalize_campaign_state(&state) {
            Err(error) => {
                if full != "throws" {
                    report.throws_mismatch += 1;
                    *report.errors.entry(crate::truncate(&error.to_string(), 160)).or_default() += 1;
                }
            }
            Ok(normalized) => {
                if full == "throws" {
                    report.throws_mismatch += 1;
                    *report.errors.entry(format!("JS бросает: {without}")).or_default() += 1;
                    continue;
                }
                if hash::sha256_hex(js::stringify(&normalized).as_bytes()) == full {
                    report.equal += 1;
                    continue;
                }
                let same_without = hash::sha256_hex(js::stringify(&stripped(&normalized)).as_bytes()) == without;
                if same_without {
                    report.equal_without_derived += 1;
                    report.derived_hashes.push(state_hash.to_string());
                } else {
                    report.different += 1;
                    report.different_hashes.push(state_hash.to_string());
                }
                if let Some(directory) = &dump {
                    if report.different_hashes.len() + report.derived_hashes.len() <= 60 {
                        let _ = std::fs::write(format!("{directory}/{state_hash}.json"), js::stringify_pretty(&normalized, 1));
                    }
                }
            }
        }
    }
    Ok(report)
}

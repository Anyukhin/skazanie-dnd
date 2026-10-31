//! Сверка `eventSummary` с JS по событиям корпуса: `sk-corpus summary
//! <каталог корпуса> <файл сводок JS>`.
//!
//! Файл сводок пишет `rust/crates/sk-rules/fixtures/gen-summary-corpus.mjs`:
//! строка JSONL `{ file, row, plain, named }` на запись корпуса с событиями,
//! `plain` — сводки без подстановки имён, `named` — с `actorNameResolver`
//! состояния до команды.

use std::collections::{BTreeMap, HashMap};

use serde_json::Value;

use crate::{truncate, Corpus};

/// Итог сверки сводок.
#[derive(Debug, Default)]
pub struct SummaryReport {
    pub records: usize,
    pub events: usize,
    pub equal: usize,
    /// Тип события → расхождений.
    pub different: BTreeMap<String, usize>,
    /// Записей корпуса без строки в файле сводок.
    pub missing: usize,
    pub examples: Vec<String>,
}

impl SummaryReport {
    pub fn render(&self) -> String {
        let total: usize = self.different.values().sum();
        let mut text = format!("сводки событий: записей {}, событий {} (×2: без имён и с именами)\n  совпало: {}\n  расходится: {}\n  записей без сводок JS: {}\n", self.records, self.events, self.equal, total, self.missing);
        if !self.different.is_empty() {
            text.push_str("расхождения по типам:\n");
            for (kind, count) in &self.different {
                text.push_str(&format!("  {count:5}  {kind}\n"));
            }
        }
        if !self.examples.is_empty() {
            text.push_str("примеры:\n");
            for example in self.examples.iter().take(20) {
                text.push_str(&format!("  {example}\n"));
            }
        }
        text
    }
}

/// Сверка сводок всех событий корпуса.
pub fn check_summary(corpus: &Corpus, js_file: &str) -> std::io::Result<SummaryReport> {
    let mut expected: HashMap<(String, usize), (Vec<String>, Vec<String>)> = HashMap::new();
    for line in std::fs::read_to_string(js_file)?.lines().filter(|line| !line.trim().is_empty()) {
        let Ok(entry) = serde_json::from_str::<Value>(line) else { continue };
        let texts = |key: &str| entry.get(key).and_then(Value::as_array).map(|items| items.iter().map(|item| item.as_str().unwrap_or_default().to_string()).collect()).unwrap_or_default();
        let (Some(file), Some(row)) = (entry.get("file").and_then(Value::as_str), entry.get("row").and_then(Value::as_u64)) else { continue };
        expected.insert((file.to_string(), row as usize), (texts("plain"), texts("named")));
    }
    let mut report = SummaryReport::default();
    for record in corpus.records()? {
        let events: Vec<Value> = record.outcome.get("events").and_then(Value::as_array).cloned().unwrap_or_default();
        if events.is_empty() {
            continue;
        }
        report.records += 1;
        let Some((plain, named)) = expected.get(&(record.file.clone(), record.row)) else {
            report.missing += 1;
            continue;
        };
        let state = corpus.state(&record.state).unwrap_or(Value::Null);
        let resolver = sk_rules::summary::actor_name_resolver(&state);
        for (index, event) in events.iter().enumerate() {
            report.events += 1;
            let rust_plain = sk_rules::summary::event_summary_plain(event);
            let rust_named = sk_rules::summary::event_summary_named(event, &resolver);
            for (rust, js) in [(rust_plain, plain.get(index)), (rust_named, named.get(index))] {
                if js.map(String::as_str) == Some(rust.as_str()) {
                    report.equal += 1;
                } else {
                    let kind = sk_core::js::s(event.get("event_type"));
                    *report.different.entry(kind.clone()).or_default() += 1;
                    if report.examples.len() < 40 {
                        report.examples.push(format!("{}:{} #{index} {kind}: JS «{}» Rust «{}»", record.file, record.row, truncate(js.map(String::as_str).unwrap_or("—"), 160), truncate(&rust, 160)));
                    }
                }
            }
        }
    }
    Ok(report)
}

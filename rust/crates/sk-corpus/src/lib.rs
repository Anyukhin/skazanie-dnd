//! Сверка с корпусом JS (`server/rules-corpus.mjs`, `tools/corpus-after-states.mjs`).
//!
//! Корпус — каталог с `corpus-*.jsonl` (команда, броски, исход), `states/`
//! (состояния по sha256) и `after.jsonl` (состояние после событий по записи).

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use sk_core::Event;

pub mod normalize;
pub mod resolve;
pub use normalize::{check_normalize, NormalizeReport};
pub use resolve::{check_resolve, ResolveReport};

/// Одна запись корпуса.
#[derive(Debug, Clone)]
pub struct Record {
    pub file: String,
    pub row: usize,
    pub state: String,
    pub command: Value,
    pub context: Value,
    pub dice: Value,
    pub outcome: Value,
}

impl Record {
    pub fn ok(&self) -> bool {
        self.outcome.get("ok").and_then(Value::as_bool) == Some(true)
    }

    pub fn events(&self) -> Vec<Event> {
        self.outcome.get("events").and_then(Value::as_array).map(|items| items.iter().filter_map(|item| serde_json::from_value(item.clone()).ok()).collect()).unwrap_or_default()
    }

    pub fn command_type(&self) -> &str {
        self.command.get("command_type").and_then(Value::as_str).unwrap_or("?")
    }
}

/// Корпус на диске.
pub struct Corpus {
    root: PathBuf,
    after: HashMap<(String, usize), String>,
}

impl Corpus {
    pub fn open(root: impl AsRef<Path>) -> std::io::Result<Self> {
        let root = root.as_ref().to_path_buf();
        let mut after = HashMap::new();
        if let Ok(text) = fs::read_to_string(root.join("after.jsonl")) {
            for line in text.lines().filter(|line| !line.trim().is_empty()) {
                if let Ok(entry) = serde_json::from_str::<Value>(line) {
                    if let (Some(file), Some(row), Some(hash)) = (entry.get("file").and_then(Value::as_str), entry.get("row").and_then(Value::as_u64), entry.get("after").and_then(Value::as_str)) {
                        after.insert((file.to_string(), row as usize), hash.to_string());
                    }
                }
            }
        }
        Ok(Self { root, after })
    }

    /// Все записи по порядку файлов.
    pub fn records(&self) -> std::io::Result<Vec<Record>> {
        let mut files: Vec<_> = fs::read_dir(&self.root)?
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with("corpus-") && name.ends_with(".jsonl"))
            .collect();
        files.sort();
        let mut records = Vec::new();
        for file in files {
            let text = fs::read_to_string(self.root.join(&file))?;
            let mut row = 0;
            for line in text.lines() {
                if line.trim().is_empty() {
                    continue;
                }
                row += 1;
                let Ok(entry) = serde_json::from_str::<Value>(line) else { continue };
                records.push(Record {
                    file: file.clone(),
                    row,
                    state: entry.get("state").and_then(Value::as_str).unwrap_or_default().to_string(),
                    command: entry.get("command").cloned().unwrap_or(Value::Null),
                    context: entry.get("context").cloned().unwrap_or(Value::Null),
                    dice: entry.get("dice").cloned().unwrap_or(Value::Null),
                    outcome: entry.get("outcome").cloned().unwrap_or(Value::Null),
                });
            }
        }
        Ok(records)
    }

    pub fn state(&self, hash: &str) -> std::io::Result<Value> {
        let text = fs::read_to_string(self.root.join("states").join(format!("{hash}.json")))?;
        serde_json::from_str(&text).map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
    }

    pub fn after_state(&self, record: &Record) -> Option<Value> {
        let hash = self.after.get(&(record.file.clone(), record.row))?;
        self.state(hash).ok()
    }
}

/// Первое расхождение двух JSON: путь и обе стороны (порядок ключей не важен).
pub fn first_difference(expected: &Value, actual: &Value, path: &mut Vec<String>) -> Option<(String, Value, Value)> {
    match (expected, actual) {
        (Value::Object(left), Value::Object(right)) => {
            let mut keys: Vec<&String> = left.keys().chain(right.keys()).collect();
            keys.sort();
            keys.dedup();
            for key in keys {
                let l = left.get(key).unwrap_or(&Value::Null);
                let r = right.get(key).unwrap_or(&Value::Null);
                path.push(key.clone());
                if let Some(found) = first_difference(l, r, path) {
                    return Some(found);
                }
                path.pop();
            }
            None
        }
        (Value::Array(left), Value::Array(right)) => {
            if left.len() != right.len() {
                return Some((format!("{}[len]", path.join(".")), Value::from(left.len()), Value::from(right.len())));
            }
            for (index, (l, r)) in left.iter().zip(right).enumerate() {
                path.push(format!("[{index}]"));
                if let Some(found) = first_difference(l, r, path) {
                    return Some(found);
                }
                path.pop();
            }
            None
        }
        (Value::Number(left), Value::Number(right)) => {
            let same = match (left.as_f64(), right.as_f64()) {
                (Some(a), Some(b)) => (a - b).abs() < 1e-9,
                _ => left == right,
            };
            (!same).then(|| (path.join("."), expected.clone(), actual.clone()))
        }
        _ => (expected != actual).then(|| (path.join("."), expected.clone(), actual.clone())),
    }
}

/// Итог сверки редьюсера.
#[derive(Debug, Default)]
pub struct ReducerReport {
    pub total: usize,
    pub equal: usize,
    /// Совпавшие записи (`файл:строка`) — сверка «не хуже» между прогонами.
    pub equal_records: Vec<String>,
    pub different: usize,
    pub not_ported: usize,
    pub no_oracle: usize,
    pub missing_types: BTreeMap<String, usize>,
    pub difference_paths: BTreeMap<String, usize>,
    pub examples: Vec<String>,
}

impl ReducerReport {
    pub fn render(&self) -> String {
        let mut text = format!(
            "записей с событиями: {}\n  совпало: {}\n  расходится: {}\n  есть неперенесённые события: {}\n  нет эталона: {}\n",
            self.total, self.equal, self.different, self.not_ported, self.no_oracle
        );
        let mut missing: Vec<_> = self.missing_types.iter().collect();
        missing.sort_by(|a, b| b.1.cmp(a.1));
        text.push_str("\nнеперенесённые типы событий (по числу записей):\n");
        for (name, count) in missing.iter().take(40) {
            text.push_str(&format!("  {count:5}  {name}\n"));
        }
        let mut paths: Vec<_> = self.difference_paths.iter().collect();
        paths.sort_by(|a, b| b.1.cmp(a.1));
        text.push_str("\nпервые расхождения по пути:\n");
        for (name, count) in paths.iter().take(40) {
            text.push_str(&format!("  {count:5}  {name}\n"));
        }
        text.push_str("\nпримеры:\n");
        for example in self.examples.iter().take(15) {
            text.push_str(&format!("  {example}\n"));
        }
        text
    }
}

/// Нормализованный путь для свода: индексы массивов заменены на `[]`.
fn path_bucket(path: &str) -> String {
    let mut result = String::new();
    let mut in_index = false;
    for ch in path.chars() {
        match ch {
            '[' => {
                in_index = true;
                result.push_str("[]");
            }
            ']' => in_index = false,
            _ if in_index => {}
            _ => result.push(ch),
        }
    }
    // Ключи-идентификаторы существ схлопываются: mechanics.conditions.hero → mechanics.conditions.*
    let parts: Vec<&str> = result.split('.').collect();
    let mut out = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        let previous = index.checked_sub(1).map(|i| parts[i]).unwrap_or("");
        if matches!(previous, "conditions" | "positions" | "resources" | "action_economy" | "saving_throws" | "heroes" | "temporary_hp" | "concentration" | "shapes") {
            out.push("*");
        } else {
            out.push(part);
        }
    }
    out.join(".")
}

/// Сверка редьюсера: события записи применяются Rust-редьюсером к состоянию «до».
pub fn check_reducer(corpus: &Corpus, filter: Option<&str>) -> std::io::Result<ReducerReport> {
    let mut report = ReducerReport::default();
    let raw_reducer = std::env::var("SK_CORPUS_RAW_REDUCER").is_ok_and(|value| value == "1");
    for record in corpus.records()? {
        if !record.ok() {
            continue;
        }
        if let Some(filter) = filter {
            if record.command_type() != filter {
                continue;
            }
        }
        let events = record.events();
        if events.is_empty() {
            continue;
        }
        report.total += 1;
        let missing: Vec<&str> = events.iter().map(|event| event.event_type.as_str()).filter(|kind| !sk_rules::reduce::is_ported(kind)).collect();
        if !missing.is_empty() {
            report.not_ported += 1;
            let mut unique = missing.clone();
            unique.sort();
            unique.dedup();
            for kind in unique {
                *report.missing_types.entry(kind.to_string()).or_default() += 1;
            }
            continue;
        }
        let Some(expected) = corpus.after_state(&record) else {
            report.no_oracle += 1;
            continue;
        };
        // Как `tools/corpus-after-states.mjs`: состояние «до» нормализуется,
        // затем каждое событие идёт через `applyGameEvent` (режим retention,
        // нормализация перед веткой, редьюсер).
        let before = corpus.state(&record.state)?;
        let raw_events: Vec<Value> = record.outcome.get("events").and_then(Value::as_array).cloned().unwrap_or_default();
        // `SK_CORPUS_RAW_REDUCER=1` — прежняя сверка до Р4б: события подряд без
        // нормализации (для сравнения «до/после» по записям).
        let replayed = if raw_reducer {
            let mut state = before.clone();
            for event in &events {
                sk_rules::reduce::apply_event(&mut state, event);
            }
            Ok(state)
        } else {
            sk_rules::normalize::normalize_campaign_state(&before).and_then(|mut state| {
                for event in &raw_events {
                    state = sk_rules::replay::apply_game_event(&state, event)?;
                }
                Ok(state)
            })
        };
        let mut state = match replayed {
            Ok(state) => state,
            Err(error) => {
                report.different += 1;
                *report.difference_paths.entry(format!("ошибка: {}", truncate(&error.to_string(), 80))).or_default() += 1;
                continue;
            }
        };
        sk_rules::reduce::strip_derived(&mut state);
        let mut path = Vec::new();
        match first_difference(&expected, &state, &mut path) {
            None => {
                report.equal += 1;
                report.equal_records.push(format!("{}:{}", record.file, record.row));
            }
            Some((at, left, right)) => {
                report.different += 1;
                *report.difference_paths.entry(path_bucket(&at)).or_default() += 1;
                if report.examples.len() < 40 {
                    let types: Vec<&str> = events.iter().map(|event| event.event_type.as_str()).collect();
                    report.examples.push(format!(
                        "{}:{} {} [{}] {}: JS={} Rust={}",
                        record.file,
                        record.row,
                        record.command_type(),
                        types.join(","),
                        at,
                        truncate(&left.to_string(), 160),
                        truncate(&right.to_string(), 160)
                    ));
                }
            }
        }
    }
    Ok(report)
}

pub(crate) fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        text.to_string()
    } else {
        format!("{}…", text.chars().take(limit).collect::<String>())
    }
}

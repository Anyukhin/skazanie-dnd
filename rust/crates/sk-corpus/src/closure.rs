//! Замкнутость редьюсера относительно нормализации (урок 4):
//! `sk-corpus closure <каталог корпуса> [тип команды]`.
//!
//! Для каждой записи с событиями: `S₀ = normalize(состояние «до»)`, затем по
//! событиям `Sᵢ₊₁ = applyGameEvent(Sᵢ, Eᵢ)`. Проверяется, что каждое `Sᵢ` —
//! неподвижная точка нормализации в режиме своего события:
//! `normalize(Sᵢ) == Sᵢ` с порядком ключей и записью чисел (как
//! `JSON.stringify`). Нормализация считается заново, без памяти итогов.
//!
//! Заодно каждое нормализованное состояние проходит проверку формы снимка
//! (`sk_rules::schema::shape`): форма, которую даёт нормализация, обязана её
//! проходить.
//!
//! Итог на корпусе v2 (урок 4): замкнутости нет — после 37 типов событий
//! нормализация меняет итог редьюсера (умолчания `combat`, ресурсы врагов,
//! `stack_key`, сводки мест, производные поля героя), поэтому
//! `NormalizedState::applied` нормализует итог каждого события.

use std::collections::BTreeMap;

use serde_json::Value;
use sk_core::js;

use crate::{truncate, Corpus};

/// Итог проверки замкнутости.
#[derive(Debug, Default)]
pub struct ClosureReport {
    /// Записей с событиями.
    pub records: usize,
    /// Проверено состояний (исходные и после каждого события).
    pub states: usize,
    /// Исходное состояние после одной нормализации — не неподвижная точка.
    pub start_not_fixed: usize,
    /// Состояние после события — не неподвижная точка (тип события → записей).
    pub not_closed: BTreeMap<String, usize>,
    /// Первое расхождение по пути (тип события и путь → записей).
    pub paths: BTreeMap<String, usize>,
    /// Нормализованное состояние не прошло проверку формы
    /// (`sk_rules::schema::shape`): путь → состояний.
    pub shape_failures: BTreeMap<String, usize>,
    /// Ошибки нормализации или редьюсера.
    pub errors: BTreeMap<String, usize>,
    pub examples: Vec<String>,
}

impl ClosureReport {
    pub fn closed(&self) -> bool {
        self.start_not_fixed == 0 && self.not_closed.is_empty() && self.errors.is_empty() && self.shape_failures.is_empty()
    }

    pub fn render(&self) -> String {
        let not_closed: usize = self.not_closed.values().sum();
        let mut text = format!(
            "записей с событиями: {}\n  проверено состояний: {}\n  исходное — не неподвижная точка: {}\n  после события — не неподвижная точка: {}\n  ошибок: {}\n",
            self.records,
            self.states,
            self.start_not_fixed,
            not_closed,
            self.errors.values().sum::<usize>()
        );
        text.push_str(&format!("  нормализованных состояний не той формы: {}
", self.shape_failures.values().sum::<usize>()));
        for (path, count) in &self.shape_failures {
            text.push_str(&format!("  {count:5}  форма: {path}
"));
        }
        if !self.not_closed.is_empty() {
            text.push_str("\nтипы событий, после которых нужна нормализация:\n");
            for (kind, count) in &self.not_closed {
                text.push_str(&format!("  {count:5}  {kind}\n"));
            }
            text.push_str("\nпервые расхождения:\n");
            for (path, count) in &self.paths {
                text.push_str(&format!("  {count:5}  {path}\n"));
            }
        }
        for (message, count) in &self.errors {
            text.push_str(&format!("  {count:5}  ошибка: {message}\n"));
        }
        if !self.examples.is_empty() {
            text.push_str("\nпримеры:\n");
            for example in self.examples.iter().take(20) {
                text.push_str(&format!("  {example}\n"));
            }
        }
        text
    }
}

/// Первое расхождение с учётом порядка ключей и записи чисел.
pub fn first_ordered_difference(left: &Value, right: &Value, path: &mut Vec<String>) -> Option<String> {
    match (left, right) {
        (Value::Object(left), Value::Object(right)) => {
            for (index, ((left_key, left_value), (right_key, right_value))) in left.iter().zip(right.iter()).enumerate() {
                if left_key != right_key {
                    return Some(format!("{}{{ключ {index}: {left_key} ≠ {right_key}}}", path.join(".")));
                }
                path.push(left_key.clone());
                if let Some(found) = first_ordered_difference(left_value, right_value, path) {
                    return Some(found);
                }
                path.pop();
            }
            (left.len() != right.len()).then(|| format!("{}{{ключей {} ≠ {}}}", path.join("."), left.len(), right.len()))
        }
        (Value::Array(left), Value::Array(right)) => {
            for (index, (left, right)) in left.iter().zip(right.iter()).enumerate() {
                path.push(format!("[{index}]"));
                if let Some(found) = first_ordered_difference(left, right, path) {
                    return Some(found);
                }
                path.pop();
            }
            (left.len() != right.len()).then(|| format!("{}[длина {} ≠ {}]", path.join("."), left.len(), right.len()))
        }
        _ => (js::stringify(left) != js::stringify(right)).then(|| format!("{}: {} ≠ {}", path.join("."), truncate(&js::stringify(left), 60), truncate(&js::stringify(right), 60))),
    }
}

/// Индексы массивов — `[]` (для свода путей).
fn bucket(path: &str) -> String {
    let mut out = String::new();
    let mut in_index = false;
    for ch in path.chars() {
        match ch {
            '[' => {
                in_index = true;
                out.push_str("[]");
            }
            ']' if in_index => in_index = false,
            _ if in_index => {}
            _ => out.push(ch),
        }
    }
    out
}

/// Нормализация заново (без памяти итогов) в режиме события.
fn renormalize(state: &Value, event: Option<&Value>) -> Result<Value, String> {
    let mode = event.map_or("current", sk_rules::replay::event_retention_mode);
    sk_rules::replay::with_retention_mode(mode, || sk_rules::normalize::normalize_campaign_state(state))?.map_err(|halt| halt.to_string())
}

fn check_shape(report: &mut ClosureReport, normalized: &Value) {
    if let Err(error) = sk_rules::schema::shape::check_campaign_state(normalized) {
        *report.shape_failures.entry(truncate(&error.to_string(), 120)).or_default() += 1;
    }
}

/// Проверить замкнутость на всех записях корпуса (или одного типа команды).
pub fn check_closure(corpus: &Corpus, filter: Option<&str>) -> std::io::Result<ClosureReport> {
    let mut report = ClosureReport::default();
    for record in corpus.records()? {
        if !record.ok() || filter.is_some_and(|kind| record.command_type() != kind) {
            continue;
        }
        let events: Vec<Value> = record.outcome.get("events").and_then(Value::as_array).cloned().unwrap_or_default();
        if events.is_empty() {
            continue;
        }
        report.records += 1;
        let place = format!("{}:{} {}", record.file, record.row, record.command_type());
        let before = corpus.state(&record.state)?;
        let mut state = match renormalize(&before, events.first()) {
            Ok(state) => state,
            Err(error) => {
                *report.errors.entry(truncate(&error, 120)).or_default() += 1;
                continue;
            }
        };
        report.states += 1;
        match renormalize(&state, events.first()) {
            Ok(again) if first_ordered_difference(&again, &state, &mut Vec::new()).is_none() => check_shape(&mut report, &again),
            Ok(again) => {
                report.start_not_fixed += 1;
                if report.examples.len() < 40 {
                    let at = first_ordered_difference(&again, &state, &mut Vec::new()).unwrap_or_default();
                    report.examples.push(format!("{place}: исходное: {at}"));
                }
            }
            Err(error) => {
                *report.errors.entry(truncate(&error, 120)).or_default() += 1;
                continue;
            }
        }
        for event in &events {
            let kind = js::s(event.get("event_type"));
            let next = match sk_rules::replay::apply_game_event(&state, event) {
                Ok(next) => next,
                Err(error) => {
                    *report.errors.entry(truncate(&format!("{kind}: {error}"), 120)).or_default() += 1;
                    break;
                }
            };
            report.states += 1;
            match renormalize(&next, Some(event)) {
                Ok(again) => {
                    check_shape(&mut report, &again);
                    if let Some(at) = first_ordered_difference(&again, &next, &mut Vec::new()) {
                        *report.not_closed.entry(kind.clone()).or_default() += 1;
                        *report.paths.entry(format!("{kind} {}", bucket(at.split(':').next().unwrap_or(&at)))).or_default() += 1;
                        if report.examples.len() < 40 {
                            report.examples.push(format!("{place} [{kind}]: {at}"));
                        }
                    }
                }
                Err(error) => {
                    *report.errors.entry(truncate(&format!("{kind}: {error}"), 120)).or_default() += 1;
                    break;
                }
            }
            state = next;
        }
    }
    Ok(report)
}

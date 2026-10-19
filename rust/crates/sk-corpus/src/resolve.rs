//! Сверка разбора с корпусом JS: `sk-corpus resolve <каталог> <тип>`.
//!
//! По умолчанию — полный путь `resolveCommand` (обёртки и хвост, Р5) с мягкой
//! проверкой; `SK_CORPUS_BRANCH_ONLY=1` — только ветка без хвоста (ниже).
//!
//! Запись корпуса хранит нормализованное JS-состояние до команды, вход
//! команды, контекст, стенограмму костей и исход (`events` или код отказа).
//! Здесь команда проходит `normalizeCommand` и **перенесённые** блоки
//! `validateCommand` (блок-заглушка пропускается и попадает в отчёт), затем
//! ветка диспетчера без хвоста последствий (хвост — Р5). Кости — стенограмма
//! записи (`replayDiceService`: метод сверяется, результат берётся записанный),
//! аргументы бросков ветки сверяются со стенограммой отдельно.
//!
//! Итоги: «совпало» — события ветки равны событиям JS; «совпало до хвоста» —
//! события ветки равны началу событий JS (остальное добавляет хвост Р5);
//! «отказ совпал» — тот же код отказа; «отказ JS в блоке-заглушке» — JS
//! отказал, а Rust нет, но часть блоков проверки ещё не перенесена.
//! `SK_CORPUS_VERBOSE=1` печатает имена пропущенных блоков.

use std::collections::BTreeMap;

use serde_json::Value;
use sk_core::js;
use sk_rules::context::{sequence_uuids, Context};
use sk_rules::pause::Halt;

use crate::{first_difference, truncate, Corpus};

/// Итог сверки разбора по типу команды.
#[derive(Debug, Default)]
pub struct ResolveReport {
    /// Записей этого типа.
    pub total: usize,
    /// События ветки совпали с событиями JS целиком.
    pub equal: usize,
    /// Совпало после известных частей хвоста и обёртки: маркер раунда
    /// `CombatRoundTimeMarked` (`resolveCommandWithPauses`) снят с событий JS,
    /// `withoutImmuneConditions` применён к событиям ветки.
    pub equal_after_wrapper: usize,
    /// События ветки — начало событий JS: остальное добавил хвост последствий (Р5).
    pub tail_added: usize,
    /// Отказ JS повторён тем же кодом.
    pub refusal_equal: usize,
    /// JS отказал, Rust — нет или иначе, а часть блоков проверки ещё заглушки.
    pub refusal_in_skipped: usize,
    /// Расхождение.
    pub different: usize,
    /// Разбор дошёл до заглушки (имя заглушки → записей).
    pub unported: BTreeMap<String, usize>,
    /// Аргументы бросков ветки разошлись со стенограммой JS.
    pub dice_args_different: usize,
    /// Блоки проверки, пропущенные как заглушки (имя → записей).
    pub skipped_blocks: BTreeMap<String, usize>,
    pub examples: Vec<String>,
}

impl ResolveReport {
    pub fn render(&self, kind: &str) -> String {
        let mut text = format!(
            "разбор {kind}: записей {}\n  совпало: {}\n  совпало с маркером раунда и withoutImmuneConditions: {}\n  совпало до хвоста (остальное добавит хвост, Р5): {}\n  отказ совпал: {}\n  отказ JS, вероятно, в блоке-заглушке: {}\n  расходится: {}\n  аргументы костей расходятся: {}\n",
            self.total, self.equal, self.equal_after_wrapper, self.tail_added, self.refusal_equal, self.refusal_in_skipped, self.different, self.dice_args_different
        );
        if !self.unported.is_empty() {
            text.push_str("дошло до заглушки:\n");
            for (name, count) in &self.unported {
                text.push_str(&format!("  {count:5}  {name}\n"));
            }
        }
        if !self.skipped_blocks.is_empty() {
            let names: Vec<&str> = self.skipped_blocks.keys().map(String::as_str).collect();
            text.push_str(&format!("блоков-заглушек пропущено: {} из {}\n", names.len(), sk_rules::validate::BLOCKS.len()));
            if std::env::var_os("SK_CORPUS_VERBOSE").is_some() {
                text.push_str(&format!("  {}\n", names.join(", ")));
            }
        }
        if !self.examples.is_empty() {
            text.push_str("примеры:\n");
            for example in self.examples.iter().take(15) {
                text.push_str(&format!("  {example}\n"));
            }
        }
        text
    }
}

/// `normalizeCommand` и перенесённые блоки `validateCommand` по порядку;
/// блок-заглушка пропускается, его имя — в `skipped`. `command_id`, которого
/// не было во входе, JS выдал `randomUUID` — он записан в событиях исхода.
fn validate_ported(input: &Value, state: &Value, context: &Context, command_id: Option<String>, skipped: &mut Vec<&'static str>) -> Result<Value, Halt> {
    let mut fallback = sequence_uuids("corpus-uuid");
    let mut known = command_id;
    let mut uuid = move || known.take().unwrap_or_else(&mut fallback);
    let command = sk_rules::command::normalize::normalize_command(input, state, &mut uuid)?;
    let mut validation = sk_rules::validate::Validation { state, command, context, actor_fate: None };
    for block in sk_rules::validate::BLOCKS {
        match (block.check)(&mut validation) {
            Ok(()) => {}
            Err(halt) if halt.is_unported() => skipped.push(block.name),
            Err(halt) => return Err(halt),
        }
    }
    Ok(validation.command)
}

fn halt_text(halt: &Halt) -> String {
    match halt {
        Halt::Rule(error) => format!("отказ {}: {}", error.code, error.message),
        Halt::Fault(fault) => format!("ошибка {}: {}", fault.name, fault.message),
        Halt::Pause(pause) => format!("пауза {}", pause.kind.name()),
    }
}

fn same(left: &[Value], right: &[Value]) -> bool {
    left.len() == right.len() && left.iter().zip(right).all(|(a, b)| js::stringify(a) == js::stringify(b))
}

/// Первое расхождение списков событий словами.
fn event_difference(expected: &[Value], actual: &[Value]) -> String {
    let index = actual.iter().zip(expected).position(|(a, b)| js::stringify(a) != js::stringify(b)).unwrap_or(actual.len().min(expected.len()));
    match (expected.get(index), actual.get(index)) {
        (Some(left), Some(right)) => {
            let mut path = Vec::new();
            match first_difference(left, right, &mut path) {
                Some((at, l, r)) => format!("событие {index} ({}) {at}: JS={} Rust={}", js::s(left.get("event_type")), truncate(&l.to_string(), 160), truncate(&r.to_string(), 160)),
                None => format!("событие {index} ({}): порядок ключей", js::s(left.get("event_type"))),
            }
        }
        (left, right) => format!(
            "событий JS {} Rust {} (первое лишнее: JS {} / Rust {})",
            expected.len(),
            actual.len(),
            left.map_or_else(|| "—".to_string(), |event| js::s(event.get("event_type"))),
            right.map_or_else(|| "—".to_string(), |event| js::s(event.get("event_type")))
        ),
    }
}

/// Сверка разбора команд одного типа.
pub fn check_resolve(corpus: &Corpus, kind: &str) -> std::io::Result<ResolveReport> {
    let mut report = ResolveReport::default();
    let assume = std::env::var("SK_CORPUS_ASSUME_NORMALIZED").is_ok_and(|value| value == "1");
    for record in corpus.records()? {
        if record.command_type() != kind {
            continue;
        }
        report.total += 1;
        let state = corpus.state(&record.state)?;
        let context = Context::from_json(&record.context);
        let transcript = record.dice.as_array().cloned().unwrap_or_default();
        let mut base = sk_rules::dice_record::dry_run_dice();
        let mut replay = sk_rules::dice_record::Replay::new(&mut base, transcript.clone(), None, false);
        let mut recording = sk_rules::dice_record::Recording::new(&mut replay);
        let mut skipped = Vec::new();
        let command_id = record.outcome.get("events").and_then(Value::as_array).and_then(|events| events.first()).and_then(|event| event.get("command_id")).map(|id| js::string(Some(id)));
        // Нормализация перенесена (Р4б): разбор нормализует состояние сам, как
        // `resolveCommandInternal`. `SK_CORPUS_ASSUME_NORMALIZED=1` — прежний
        // режим (состояние корпуса считается уже нормализованным).
        let branch_only = std::env::var("SK_CORPUS_BRANCH_ONLY").is_ok_and(|value| value == "1");
        let mut run = || {
            if !branch_only {
                // Полный путь `resolveCommand` (Р5): обёртки, удар-открытие,
                // хвост последствий и режимы реакций; блоки-заглушки проверки
                // пропускает мягкая проверка. `SK_CORPUS_BRANCH_ONLY=1` —
                // прежний режим (ветка без хвоста).
                let mut known = command_id.clone();
                let mut fallback = sequence_uuids("corpus-uuid");
                let mut uuid = move || known.take().unwrap_or_else(&mut fallback);
                sk_rules::resolve::api::take_skipped_blocks();
                let result = sk_rules::resolve::api::with_lenient_validation(|| sk_rules::resolve::api::resolve_command(&record.command, &state, &mut recording, &context, &mut uuid));
                skipped.extend(sk_rules::resolve::api::take_skipped_blocks());
                return result;
            }
            // JS: `resolveCommandInternal` нормализует состояние, `validateCommand`
            // — ещё раз (нормализация не всегда идемпотентна).
            let validated_state = if assume { state.clone() } else { sk_rules::normalize::normalize_campaign_state(&sk_rules::normalize::normalize_campaign_state(&state)?)? };
            let command = validate_ported(&record.command, &validated_state, &context, command_id.clone(), &mut skipped)?;
            let mut uuid = sequence_uuids("corpus-uuid");
            sk_rules::resolve::vitals::resolve_branch_without_tail(command, &state, &mut recording, &context, &mut uuid)
        };
        let result = if assume { sk_rules::normalize::assume_normalized(run) } else { run() };
        let any_skipped = !skipped.is_empty();
        for name in skipped {
            *report.skipped_blocks.entry(name.to_string()).or_default() += 1;
        }
        let place = format!("{}:{}", record.file, record.row);
        // `SK_CORPUS_DUMP=<файл>:<строка>`: события или отказ Rust этой записи целиком.
        if std::env::var("SK_CORPUS_DUMP").is_ok_and(|wanted| wanted == place) {
            match &result {
                Ok(resolved) => eprintln!("{place}: Rust {}", js::stringify(&Value::Array(resolved.events.clone()))),
                Err(halt) => eprintln!("{place}: Rust {}", halt_text(halt)),
            }
        }
        let rust_args: Vec<String> = recording.transcript.iter().map(|entry| js::stringify(entry.get("args").unwrap_or(&Value::Null))).collect();
        let js_args: Vec<String> = transcript.iter().take(rust_args.len()).map(|entry| js::stringify(entry.get("args").unwrap_or(&Value::Null))).collect();
        if record.ok() && rust_args != js_args {
            report.dice_args_different += 1;
            if report.examples.len() < 40 {
                report.examples.push(format!("{place}: кости Rust {} JS {}", truncate(&rust_args.join(","), 200), truncate(&js_args.join(","), 200)));
            }
        }
        let mut example = None;
        match (&result, record.ok()) {
            (Err(halt), _) if halt.is_unported() => {
                let name = match halt {
                    Halt::Rule(error) => error.message.clone(),
                    _ => String::new(),
                };
                *report.unported.entry(name).or_default() += 1;
            }
            (Err(halt), false) if halt.code() == record.outcome.get("code").and_then(Value::as_str) => report.refusal_equal += 1,
            (_, false) if any_skipped => {
                report.refusal_in_skipped += 1;
                let rust = match &result {
                    Ok(_) => "принял".to_string(),
                    Err(halt) => halt_text(halt),
                };
                example = Some(format!("{place}: JS отказал {} (Rust {rust})", js::s(record.outcome.get("code"))));
            }
            (Err(halt), _) => {
                report.different += 1;
                example = Some(format!("{place}: Rust {}, JS {}", halt_text(halt), truncate(&js::stringify(&record.outcome), 200)));
            }
            (Ok(_), false) => {
                report.different += 1;
                example = Some(format!("{place}: Rust принял, JS отказал {}", truncate(&js::stringify(&record.outcome), 200)));
            }
            (Ok(resolved), true) => {
                let expected: Vec<Value> = record.outcome.get("events").and_then(Value::as_array).cloned().unwrap_or_default();
                let actual = &resolved.events;
                let unmarked: Vec<Value> = expected.iter().skip_while(|event| event.get("event_type").and_then(Value::as_str) == Some("CombatRoundTimeMarked")).cloned().collect();
                let filtered = sk_rules::damage::without_immune_conditions(&state, &resolved.command, actual);
                if same(actual, &expected) {
                    report.equal += 1;
                } else if same(actual, &unmarked) || same(&filtered, &unmarked) {
                    report.equal_after_wrapper += 1;
                } else if actual.len() < expected.len() && same(actual, &expected[..actual.len()]) {
                    report.tail_added += 1;
                    example = Some(format!("{place}: хвост добавил {}", expected[actual.len()..].iter().map(|event| js::s(event.get("event_type"))).collect::<Vec<_>>().join(",")));
                } else {
                    report.different += 1;
                    example = Some(format!("{place}: {}", event_difference(&expected, actual)));
                }
            }
        }
        if let Some(example) = example.filter(|_| report.examples.len() < 40) {
            report.examples.push(example);
        }
    }
    Ok(report)
}

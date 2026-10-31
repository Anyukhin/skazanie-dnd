//! `cargo run -p sk-corpus -- reducer <каталог корпуса> [тип команды]`
//! `cargo run -p sk-corpus -- normalize <каталог корпуса> [предел]`
//! `cargo run -p sk-corpus -- closure <каталог корпуса> [тип команды]`
//! `cargo run -p sk-corpus -- resolve <каталог корпуса> <тип команды>[,<тип>…] | all`
//! `cargo run -p sk-corpus -- summary <каталог корпуса> <файл сводок JS>`

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map(String::as_str).unwrap_or("reducer");
    let root = args.get(2).cloned().unwrap_or_else(|| "../tmp/corpus-v1".into());
    let filter = args.get(3).map(String::as_str);
    let corpus = sk_corpus::Corpus::open(&root).expect("корпус открывается");
    match mode {
        "reducer" => {
            let report = sk_corpus::check_reducer(&corpus, filter).expect("сверка редьюсера");
            print!("{}", report.render());
            // Список совпавших записей — чтобы сверить «не хуже» между прогонами.
            if let Ok(path) = std::env::var("SK_CORPUS_EQUAL") {
                std::fs::write(&path, report.equal_records.join("\n")).expect("список совпавших записей пишется");
            }
        }
        "closure" => {
            // Урок 4: итог редьюсера от нормализованного состояния — неподвижная
            // точка нормализации. Код 1 — замкнутость нарушена.
            let report = sk_corpus::check_closure(&corpus, filter).expect("проверка замкнутости");
            print!("{}", report.render());
            // Ск5: замкнутость в целом не достигнута (код 1 — как прежде), а
            // список замкнутых типов горячего пути обязан держаться (код 3).
            if !report.closed_types_hold() {
                std::process::exit(3);
            }
            if !report.closed() {
                std::process::exit(1);
            }
        }
        "normalize" => {
            let limit = filter.and_then(|text| text.parse::<usize>().ok());
            let report = sk_corpus::check_normalize(&corpus, limit).expect("сверка нормализации");
            print!("{}", report.render());
        }
        "replay-dump" => {
            // Отладка: состояние после событий записи `<файл>:<строка>` — в файл.
            let (Some(target), Some(output)) = (filter, args.get(4)) else {
                eprintln!("укажите запись и файл: replay-dump <каталог> <файл:строка> <выход.json>");
                std::process::exit(2);
            };
            let records = corpus.records().expect("записи корпуса");
            let Some(record) = records.iter().find(|record| format!("{}:{}", record.file, record.row) == target) else {
                eprintln!("нет записи {target}");
                std::process::exit(2);
            };
            let before = corpus.state(&record.state).expect("состояние «до»");
            let events: Vec<serde_json::Value> = record.outcome.get("events").and_then(serde_json::Value::as_array).cloned().unwrap_or_default();
            match sk_rules::replay::replay_events(&before, &events) {
                Ok(mut state) => {
                    sk_rules::reduce::strip_derived(&mut state);
                    std::fs::write(output, sk_core::js::stringify_pretty(&state, 1)).expect("запись");
                }
                Err(error) => eprintln!("ошибка: {error}"),
            }
        }
        "resolve" => {
            let Some(kinds) = filter else {
                eprintln!("укажите тип команды: resolve <каталог> <тип>[,<тип>…]");
                std::process::exit(2);
            };
            // `all` — все типы команд, что есть в корпусе (в порядке первой встречи).
            let all: Vec<String> = if kinds == "all" {
                let mut seen: Vec<String> = Vec::new();
                for record in corpus.records().expect("записи корпуса") {
                    let kind = record.command_type();
                    if kind != "?" && !seen.iter().any(|known| known == kind) {
                        seen.push(kind.to_string());
                    }
                }
                seen
            } else {
                kinds.split(',').filter(|kind| !kind.is_empty()).map(str::to_string).collect()
            };
            let kinds: Vec<&str> = all.iter().map(String::as_str).collect();
            for (kind, report) in sk_corpus::check_resolve_many(&corpus, &kinds).expect("сверка разбора") {
                println!("{}", report.render(&kind));
            }
        }
        "summary" => {
            // Сводки событий (`eventSummary`) против файла сводок JS
            // (`sk-rules/fixtures/gen-summary-corpus.mjs`).
            let Some(file) = filter else {
                eprintln!("укажите файл сводок JS: summary <каталог> <файл.jsonl>");
                std::process::exit(2);
            };
            let report = sk_corpus::check_summary(&corpus, file).expect("сверка сводок");
            print!("{}", report.render());
        }
        other => {
            eprintln!("неизвестный режим {other}; есть: reducer, closure, normalize, resolve, summary");
            std::process::exit(2);
        }
    }
}

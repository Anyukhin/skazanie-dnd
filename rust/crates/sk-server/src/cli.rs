//! Разбор аргументов `skazanie-server` (С19.1): сервер запускается только
//! без аргументов; справка и неизвестный аргумент порт не открывают.
//!
//! - без аргументов — сервер;
//! - `--help`, `-h` — справка в stdout, код 0;
//! - `journal …`, `session …`, `room …`, `audit …` — служебные подкоманды
//!   набора тестов (`test/kit/journal.mjs`, `sessions.mjs`, `rooms.mjs`, фича
//!   `test-hooks`);
//! - `import-legacy …` — перенос старого storage
//!   ([`crate::legacy_import::run`], С19.2);
//! - иное — справка в stderr, код 2 ([`USAGE_EXIT`]).
//!
//! Прежний позиционный «корень проекта» (`skazanie-server <каталог>`) убран:
//! корень данных и раздачи клиента — `DND_DATA_DIR` (`sk_core::data_root`).

/// Код выхода при ошибке использования (как у `clap` и `getopt`).
pub const USAGE_EXIT: i32 = 2;

/// Справка.
pub const HELP: &str = "\
skazanie-server — HTTP-сервер «Сказания».

Использование:
  skazanie-server                      запустить сервер
  skazanie-server --help | -h          эта справка
  skazanie-server import-legacy …      перенести старое storage (JS) в базу
  skazanie-server journal …            журнал кампании (только сборка с test-hooks)
  skazanie-server session …            сессии входа (только сборка с test-hooks)
  skazanie-server room | audit …       комната и сверка хранилища (только сборка с test-hooks)

Окружение (также из .env в текущем каталоге):
  AGENT_HOST, AGENT_PORT     адрес и порт (по умолчанию 0.0.0.0:8787)
  DND_STORAGE_DIR            рабочие данные (по умолчанию ./storage)
  DND_DATA_DIR               корень данных: data/, prompts/, public/, dist/
                             (по умолчанию каталог бинаря, если рядом есть
                             data/, иначе корень репозитория сборки)
  ROUTERAI_API_KEY           ключ модели; без него — демо-режим
";

/// Что просили запуском.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Invocation {
    /// Запустить сервер.
    Serve,
    /// Справка.
    Help,
    /// `journal` с остатком аргументов.
    Journal(Vec<String>),
    /// `session` с остатком аргументов.
    Session(Vec<String>),
    /// `room` или `audit` набора тестов (`test/kit/rooms.mjs`): имя и остаток аргументов.
    Room(String, Vec<String>),
    /// `import-legacy` с остатком аргументов.
    ImportLegacy(Vec<String>),
    /// Неизвестный аргумент.
    Unknown(String),
}

/// Разобрать аргументы без имени программы.
pub fn parse(args: &[String]) -> Invocation {
    let Some(first) = args.first() else { return Invocation::Serve };
    let rest = args[1..].to_vec();
    match first.as_str() {
        "--help" | "-h" => Invocation::Help,
        "journal" => Invocation::Journal(rest),
        "session" => Invocation::Session(rest),
        "room" | "audit" => Invocation::Room(first.clone(), rest),
        "import-legacy" => Invocation::ImportLegacy(rest),
        other => Invocation::Unknown(other.to_string()),
    }
}

/// Исполнить всё, кроме запуска сервера: `Some(код)` — процесс завершается
/// с этим кодом, `None` — запускать сервер.
pub fn run_tool(invocation: &Invocation) -> Option<i32> {
    match invocation {
        Invocation::Serve => None,
        Invocation::Help => {
            print!("{HELP}");
            Some(0)
        }
        Invocation::Journal(rest) => Some(crate::test_hooks::journal_cli::main(rest)),
        Invocation::Session(rest) => Some(crate::test_hooks::session_cli::main(rest)),
        Invocation::Room(name, rest) => Some(crate::test_hooks::room_cli::main(name, rest)),
        Invocation::ImportLegacy(rest) => Some(crate::legacy_import::run(rest)),
        Invocation::Unknown(argument) => {
            eprintln!("skazanie-server: неизвестный аргумент «{argument}»\n\n{HELP}");
            Some(USAGE_EXIT)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn only_empty_arguments_start_the_server() {
        assert_eq!(parse(&[]), Invocation::Serve);
        for help in ["--help", "-h"] {
            assert_eq!(parse(&args(&[help])), Invocation::Help, "{help}");
        }
        assert_eq!(parse(&args(&["journal", "--storage", "x"])), Invocation::Journal(args(&["--storage", "x"])));
        assert_eq!(parse(&args(&["session", "--expire"])), Invocation::Session(args(&["--expire"])));
        assert_eq!(parse(&args(&["import-legacy"])), Invocation::ImportLegacy(Vec::new()));
        for unknown in ["help", "--port", "serve", ".", "C:/repo", "--HELP", ""] {
            assert_eq!(parse(&args(&[unknown])), Invocation::Unknown(unknown.to_string()), "{unknown}");
        }
        assert_eq!(run_tool(&Invocation::Unknown("x".into())), Some(USAGE_EXIT));
        assert_eq!(run_tool(&Invocation::Serve), None);
    }
}

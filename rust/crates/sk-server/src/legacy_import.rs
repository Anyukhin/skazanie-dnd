//! Подкоманда `skazanie-server import-legacy` — перенос старого storage JS
//! (файлы `rooms/*.json`, аккаунты, журналы) в базу Rust.
//!
//! Заглушка С19.1: место и сигнатура закреплены разбором аргументов
//! ([`crate::cli`]); перенос реализует задача С19.2 в этом модуле.

/// Исполнить подкоманду; возвращает код выхода процесса.
pub fn run(args: &[String]) -> i32 {
    let _ = args;
    eprintln!("skazanie-server import-legacy: пока не реализовано (задача С19.2)");
    crate::cli::USAGE_EXIT
}

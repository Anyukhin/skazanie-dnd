//! Корень данных процесса — каталог, в котором лежат `data/`, `prompts/`,
//! `public/` и собранный клиент `dist/` (С19.1).
//!
//! В JS эти пути считаются от `import.meta.url` модуля, то есть от дерева
//! исходников. Бинарь Rust живёт отдельно от дерева сборки (Docker, другая
//! машина), поэтому всё, что сервер **читает с диска во время работы**, берёт
//! корень отсюда. Встраивание `include_str!` — время сборки, оно корня не
//! касается.
//!
//! Выбор корня ([`resolve_with`]), первый подходящий:
//!
//! 1. `DND_DATA_DIR` — непустая переменная окружения; относительный путь — от
//!    текущего каталога. Проверки содержимого здесь нет: её делает запуск
//!    сервера ([`missing_entries`]) и отказывает понятным текстом;
//! 2. каталог бинаря, если рядом с ним есть `data/` (раскладка выпуска:
//!    `skazanie-server`, `data/`, `prompts/`, `public/`, `dist/` вместе);
//! 3. корень репозитория времени сборки ([`build_root`]) — так тесты и набор
//!    `test/kit` работают из дерева сборки, как раньше.
//!
//! Корень один на процесс: [`init`] закрепляет выбранный запуском, иначе
//! первый вызов [`get`] выбирает его сам по окружению. Изменяемого
//! глобального состояния, кроме этого `OnceLock`, нет.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Переменная окружения корня данных.
pub const ENV_VAR: &str = "DND_DATA_DIR";

/// Что должно лежать в корне, чтобы сервер мог работать: пакеты правил
/// читаются с диска при запуске (`RuleCatalog::load`).
pub const REQUIRED_ENTRIES: &[&str] = &["data/rule_packs"];

/// Откуда взят корень.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// `DND_DATA_DIR`.
    Env,
    /// Каталог бинаря (рядом есть `data/`).
    BesideBinary,
    /// Корень репозитория времени сборки.
    BuildTree,
}

impl Source {
    /// Подпись для сообщений запуска.
    pub fn label(self) -> &'static str {
        match self {
            Source::Env => ENV_VAR,
            Source::BesideBinary => "рядом с бинарём",
            Source::BuildTree => "дерево сборки",
        }
    }
}

/// Выбранный корень данных.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DataRoot {
    pub path: PathBuf,
    pub source: Source,
}

impl DataRoot {
    /// Путь внутри корня (`data/x.json`, `public/assets/…`).
    pub fn join(&self, relative: impl AsRef<Path>) -> PathBuf {
        self.path.join(relative)
    }
}

static ROOT: OnceLock<DataRoot> = OnceLock::new();

/// Корень репозитория, из которого собран крейт (`rust/crates/sk-core` → три
/// уровня вверх).
pub fn build_root() -> PathBuf {
    let mut root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for _ in 0..3 {
        root.pop();
    }
    root
}

/// Выбор корня без обращения к глобальному состоянию: `env` — значение
/// `DND_DATA_DIR`, `cwd` — текущий каталог, `exe` — путь бинаря.
pub fn resolve_with(env: Option<OsString>, cwd: &Path, exe: Option<&Path>) -> DataRoot {
    if let Some(value) = env.filter(|value| !value.is_empty()) {
        let path = PathBuf::from(value);
        let path = if path.is_absolute() { path } else { cwd.join(path) };
        return DataRoot { path, source: Source::Env };
    }
    if let Some(dir) = exe.and_then(Path::parent) {
        if dir.join("data").is_dir() {
            return DataRoot { path: dir.to_path_buf(), source: Source::BesideBinary };
        }
    }
    DataRoot { path: build_root(), source: Source::BuildTree }
}

/// Выбор корня по окружению процесса.
pub fn resolve() -> DataRoot {
    let cwd = std::env::current_dir().unwrap_or_default();
    let exe = std::env::current_exe().ok();
    resolve_with(std::env::var_os(ENV_VAR), &cwd, exe.as_deref())
}

/// Закрепить корень процесса до первого чтения. Уже выбранный (явно или
/// первым [`get`]) не меняется: возвращается действующий.
pub fn init(root: DataRoot) -> Result<&'static DataRoot, &'static DataRoot> {
    let mut fresh = Some(root);
    let current = ROOT.get_or_init(|| fresh.take().unwrap_or_else(resolve));
    if fresh.is_none() {
        Ok(current)
    } else {
        Err(current)
    }
}

/// Корень процесса; при первом вызове без [`init`] выбирается по окружению.
pub fn get() -> &'static DataRoot {
    ROOT.get_or_init(resolve)
}

/// Путь корня процесса.
pub fn path() -> &'static Path {
    &get().path
}

/// Путь внутри корня процесса.
pub fn join(relative: impl AsRef<Path>) -> PathBuf {
    get().join(relative)
}

/// Каких обязательных записей ([`REQUIRED_ENTRIES`]) нет в корне.
pub fn missing_entries(root: &DataRoot) -> Vec<&'static str> {
    REQUIRED_ENTRIES.iter().copied().filter(|entry| !root.join(entry).is_dir()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_wins_and_relative_is_from_cwd() {
        let cwd = Path::new("/work");
        let chosen = resolve_with(Some("payload".into()), cwd, Some(Path::new("/opt/bin/skazanie-server")));
        assert_eq!(chosen, DataRoot { path: cwd.join("payload"), source: Source::Env });
        let absolute = build_root();
        let chosen = resolve_with(Some(absolute.clone().into_os_string()), cwd, None);
        assert_eq!(chosen.path, absolute);
    }

    #[test]
    fn empty_env_falls_through_to_build_tree() {
        let chosen = resolve_with(Some(OsString::new()), Path::new("/work"), Some(Path::new("/nowhere/skazanie-server")));
        assert_eq!(chosen, DataRoot { path: build_root(), source: Source::BuildTree });
    }

    #[test]
    fn data_beside_binary_is_preferred_over_build_tree() {
        let root = build_root();
        // Бинарь «в корне репозитория»: рядом лежит `data/`.
        let chosen = resolve_with(None, Path::new("/work"), Some(&root.join("skazanie-server")));
        assert_eq!(chosen, DataRoot { path: root.clone(), source: Source::BesideBinary });
        assert!(missing_entries(&chosen).is_empty(), "в дереве сборки пакеты правил есть");
        let empty = DataRoot { path: root.join("rust").join("crates").join("sk-core").join("src"), source: Source::Env };
        assert_eq!(missing_entries(&empty), vec!["data/rule_packs"]);
    }
}

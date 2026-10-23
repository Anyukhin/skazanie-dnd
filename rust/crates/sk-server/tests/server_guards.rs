//! Статические сторожа sk-server (С2, рецензия плана §8):
//!
//! - модель видит только сервер: `RouterAiClient` и генераторы картинок
//!   собираются только в `src/main.rs` и `src/state.rs` (и в наборе
//!   `tests/kit`), а в `AppState` клиенты лежат только как `Metered` — каждый
//!   вызов идёт через учёт расхода (Rust-аналог `test/security.test.mjs`:
//!   `llm-client` импортирует только `index.mjs`);
//! - сбои журнала из данных применимы ко всем коммитам: `commit` и
//!   `acknowledge_projection` журнала зовутся только через
//!   `sk_server::test_hooks` (иначе `DND_COMMIT_FAULTS` молча не сработает).

use std::path::{Path, PathBuf};

use regex::Regex;

fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("каталог исходников") {
        let path = entry.expect("запись каталога").path();
        if path.is_dir() {
            sources(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

fn src_files() -> Vec<(String, String)> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    sources(&root, &mut files);
    files.sort();
    files
        .into_iter()
        .map(|path| {
            let relative = path.strip_prefix(&root).expect("внутри src").to_string_lossy().replace('\\', "/");
            (relative, std::fs::read_to_string(&path).expect("исходник"))
        })
        .collect()
}

/// Строки кода без комментариев `//` (документация упоминает имена свободно).
fn code_lines(text: &str) -> impl Iterator<Item = (usize, &str)> {
    text.lines().enumerate().map(|(index, line)| (index + 1, line.split("//").next().unwrap_or(""))).filter(|(_, line)| !line.trim().is_empty())
}

fn offences(pattern: &Regex, allowed: &[&str]) -> Vec<String> {
    let mut found = Vec::new();
    for (file, text) in src_files() {
        if allowed.contains(&file.as_str()) {
            continue;
        }
        for (line, code) in code_lines(&text) {
            if pattern.is_match(code) {
                found.push(format!("src/{file}:{line}: {}", code.trim()));
            }
        }
    }
    found
}

#[test]
fn model_and_image_clients_are_built_only_at_the_entry_point() {
    let construct = Regex::new(r"\b(RouterAiClient|RouterImageGenerator|LocalImageGenerator|MeteredLLMClient|FallbackLlmClient)\s*(::\s*new\b|\{)").unwrap();
    let found = offences(&construct, &["main.rs", "state.rs"]);
    assert!(found.is_empty(), "клиенты модели и картинок собираются только в main.rs/state.rs (AGENTS §4):\n{}", found.join("\n"));
    let custom = Regex::new(r"\bimpl\b[^{]*\bLlmClient\s+for\b").unwrap();
    let found = offences(&custom, &[]);
    assert!(found.is_empty(), "свой клиент модели в sk-server обошёл бы учёт расхода:\n{}", found.join("\n"));
}

#[test]
fn app_state_holds_models_only_as_metered() {
    let state = std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src").join("state.rs")).expect("state.rs");
    let block = |name: &str| -> String {
        let start = state.find(&format!("pub struct {name}")).unwrap_or_else(|| panic!("нет struct {name}"));
        let end = start + state[start..].find("\n}").expect("конец struct");
        state[start..end].to_string()
    };
    let clients = block("LlmClients");
    let fields: Vec<&str> = clients.lines().map(str::trim).filter(|line| line.starts_with("pub ") && line.contains(':')).collect();
    assert!(!fields.is_empty());
    for field in &fields {
        assert!(field.ends_with("Option<Metered>,"), "поле клиентов модели не через учёт расхода: {field}");
    }
    let app = block("AppState");
    let raw = Regex::new(r"dyn\s+LlmClient|RouterAiClient|FallbackLlmClient").unwrap();
    assert!(!raw.is_match(&app), "AppState держит клиента модели мимо Metered:\n{app}");
    // `Metered` нельзя собрать мимо `MeteredLLMClient`: поле закрыто.
    assert!(state.contains("pub struct Metered(Arc<dyn LlmClient>);"), "поле Metered должно оставаться закрытым");
}

#[test]
fn journal_writes_go_through_test_hooks() {
    let direct = Regex::new(r"\b(events|store|event_store|journal)\s*\.\s*(commit|acknowledge_projection)\s*\(").unwrap();
    let found = offences(&direct, &["test_hooks.rs", "test_hooks/journal_cli.rs"]);
    assert!(
        found.is_empty(),
        "коммит и подтверждение проекции — только через sk_server::test_hooks::{{commit, acknowledge_projection}}, иначе сбои DND_COMMIT_FAULTS не сработают:\n{}",
        found.join("\n")
    );
}

//! Сверка `content_integrity` с эталоном JS (`fixtures/content-integrity.json`,
//! генератор `fixtures/gen-content-integrity.mjs`) и перенос
//! `test/content-integrity.test.mjs`.
//!
//! Шаблон-корень собирается во временном каталоге так же, как в генераторе;
//! каждый случай применяет свои правки, при необходимости пересчитывает хеши
//! артефактов, запускает гейт и восстанавливает затронутые файлы.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::{hash, js};
use sk_items_life::content_integrity::{verify_content_integrity, verify_declared_artifact, ContentIntegrityFailure};

static FIXTURE: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("../fixtures/content-integrity.json")).expect("эталон content-integrity"));

const DETAIL_KEYS: [&str; 7] = ["path", "expected", "actual", "undeclared", "missing", "unknown", "problems"];

fn project_root() -> PathBuf {
    std::path::absolute(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")).expect("корень")
}

/// Абсолютный путь без `..`, как его печатает `path.resolve`.
fn display_root(path: &Path) -> String {
    let mut normalized = PathBuf::new();
    for component in std::path::absolute(path).expect("путь").components() {
        match component {
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::CurDir => {}
            other => normalized.push(other),
        }
    }
    normalized.display().to_string()
}

struct Workspace {
    root: PathBuf,
    copy: Vec<String>,
    write: Map<String, Value>,
}

impl Workspace {
    fn new(tag: &str) -> Self {
        let template = &FIXTURE["template"];
        let root = std::env::temp_dir().join(format!("sk-items-life-ci-rs-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let copy = template["copy"].as_array().expect("copy").iter().map(|item| item.as_str().expect("путь").to_string()).collect();
        let write = template["write"].as_object().expect("write").clone();
        let workspace = Self { root, copy, write };
        for file in workspace.copy.clone() {
            workspace.restore(&file);
        }
        for file in workspace.write.keys().cloned().collect::<Vec<_>>() {
            workspace.restore(&file);
        }
        workspace
    }

    fn path(&self, file: &str) -> PathBuf {
        self.root.join(file)
    }

    fn restore(&self, file: &str) {
        let target = self.path(file);
        std::fs::create_dir_all(target.parent().expect("каталог")).expect("каталог");
        if let Some(text) = self.write.get(file) {
            std::fs::write(&target, text.as_str().expect("текст")).expect("запись");
        } else {
            std::fs::copy(project_root().join(file), &target).expect("копия");
        }
    }

    fn template_files(&self) -> impl Iterator<Item = &str> {
        self.copy.iter().map(String::as_str).chain(self.write.keys().map(String::as_str))
    }

    /// Вернуть шаблон после случая: затронутые файлы и всё под затронутыми
    /// каталогами — из источника, новые файлы — удалить.
    fn reset(&self, touched: &[String]) {
        let restore: Vec<String> = self.template_files().filter(|file| touched.iter().any(|t| file == t || file.starts_with(&format!("{t}/")))).map(str::to_string).collect();
        for file in touched {
            if !self.template_files().any(|known| known == file) {
                let target = self.path(file);
                if target.is_dir() {
                    let _ = std::fs::remove_dir_all(&target);
                } else {
                    let _ = std::fs::remove_file(&target);
                }
            }
        }
        for file in restore {
            self.restore(&file);
        }
    }

    fn apply(&self, ops: &[Value]) -> Vec<String> {
        let mut touched = vec!["data/content-provenance.json".to_string()];
        for op in ops {
            let file = op["file"].as_str().expect("файл");
            touched.push(file.to_string());
            let target = self.path(file);
            match op["op"].as_str().expect("op") {
                "json" => {
                    let mut value: Value = serde_json::from_str(&std::fs::read_to_string(&target).expect("чтение")).expect("JSON");
                    set_at(&mut value, op["path"].as_array().expect("путь"), op["action"].as_str().expect("действие"), op.get("value"));
                    std::fs::write(&target, js::stringify_pretty(&value, 2)).expect("запись");
                }
                "write" => {
                    std::fs::create_dir_all(target.parent().expect("каталог")).expect("каталог");
                    std::fs::write(&target, op["text"].as_str().expect("текст")).expect("запись");
                }
                "remove" => {
                    if target.is_dir() {
                        std::fs::remove_dir_all(&target).expect("удаление каталога");
                    } else if target.exists() {
                        std::fs::remove_file(&target).expect("удаление");
                    }
                }
                "replace" => {
                    let text = std::fs::read_to_string(&target).expect("чтение");
                    let from = op["from"].as_str().expect("from");
                    assert!(text.contains(from), "replace: нет «{from}» в {file}");
                    std::fs::write(&target, text.replacen(from, op["to"].as_str().expect("to"), 1)).expect("запись");
                }
                other => panic!("неизвестная операция {other}"),
            }
        }
        touched
    }

    /// Пересчёт sha256/size_bytes артефактов, как `seal()` генератора.
    fn seal(&self) {
        let file = self.path("data/content-provenance.json");
        let Ok(text) = std::fs::read_to_string(&file) else { return };
        let Ok(mut value) = serde_json::from_str::<Value>(&text) else { return };
        let Some(artifacts) = value.get_mut("artifacts").and_then(Value::as_array_mut) else { return };
        let mut changed = false;
        for artifact in artifacts {
            let Some(path) = artifact.get("path").and_then(Value::as_str).map(str::to_string) else { continue };
            let Some(fields) = artifact.as_object_mut() else { continue };
            let target = self.path(&path);
            if !target.is_file() {
                continue;
            }
            let bytes = std::fs::read(&target).expect("чтение");
            let digest = hash::sha256_hex(&bytes);
            if fields.get("sha256").and_then(Value::as_str) != Some(digest.as_str()) || fields.get("size_bytes").and_then(Value::as_u64) != Some(bytes.len() as u64) {
                fields.insert("sha256".into(), Value::String(digest));
                fields.insert("size_bytes".into(), Value::from(bytes.len()));
                changed = true;
            }
        }
        if changed {
            std::fs::write(&file, js::stringify_pretty(&value, 2)).expect("запись");
        }
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn set_at(value: &mut Value, path: &[Value], action: &str, new_value: Option<&Value>) {
    let (last, parents) = path.split_last().expect("непустой путь");
    let mut node = value;
    for key in parents {
        node = match key {
            Value::Number(index) => &mut node[index.as_u64().expect("индекс") as usize],
            Value::String(name) => &mut node[name.as_str()],
            other => panic!("ключ {other}"),
        };
    }
    match (action, last) {
        ("set", Value::Number(index)) => node[index.as_u64().expect("индекс") as usize] = new_value.cloned().expect("value"),
        ("set", Value::String(name)) => {
            node.as_object_mut().expect("объект").insert(name.clone(), new_value.cloned().expect("value"));
        }
        ("delete", Value::Number(index)) => {
            node.as_array_mut().expect("массив").remove(index.as_u64().expect("индекс") as usize);
        }
        ("delete", Value::String(name)) => {
            node.as_object_mut().expect("объект").shift_remove(name);
        }
        ("push", Value::String(name)) => node[name.as_str()].as_array_mut().expect("массив").push(new_value.cloned().expect("value")),
        other => panic!("правка {other:?}"),
    }
}

fn clean(text: &str, root: &Path) -> String {
    text.replace(&display_root(root), "<root>").replace(&display_root(&project_root()), "<project>").replace('\\', "/")
}

fn outcome(result: Result<Value, ContentIntegrityFailure>, root: &Path) -> Value {
    match result {
        Ok(report) => json!({ "ok": report }),
        Err(ContentIntegrityFailure::Integrity(error)) => {
            let mut details = Map::new();
            for key in DETAIL_KEYS {
                if let Some(value) = error.details.get(key) {
                    details.insert(key.into(), value.clone());
                }
            }
            let message = if error.code == "CONTENT_MANIFEST_INVALID" { clean(error.message.split(": ").next().unwrap_or_default(), root) } else { clean(&error.message, root) };
            json!({ "error": { "name": "ContentIntegrityError", "code": error.code, "message": message, "details": details } })
        }
        Err(ContentIntegrityFailure::RulePack(error)) => json!({ "error": { "name": "RulePackValidationError", "message": clean(&error.message, root) } }),
        Err(ContentIntegrityFailure::Type(_)) => json!({ "error": { "name": "TypeError" } }),
        Err(ContentIntegrityFailure::Io { code, .. }) => json!({ "error": { "name": "Error", "code": code } }),
    }
}

#[test]
fn spoiled_copies_match_js() {
    let workspace = Workspace::new("cases");
    let cases = FIXTURE["cases"].as_array().expect("случаи");
    assert!(cases.len() > 250, "случаев {}", cases.len());
    let mut failures = Vec::new();
    for case in cases {
        let touched = workspace.apply(case["ops"].as_array().expect("ops"));
        if case.get("seal") != Some(&Value::Bool(false)) {
            workspace.seal();
        }
        let actual = outcome(verify_content_integrity(&workspace.root), &workspace.root);
        if actual != case["outcome"] {
            failures.push(format!("{}\n  JS:   {}\n  Rust: {}", case["name"], js::stringify(&case["outcome"]), js::stringify(&actual)));
        }
        workspace.reset(&touched);
    }
    assert!(failures.is_empty(), "расхождений {}:\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn declared_artifacts_match_js() {
    let workspace = Workspace::new("declared");
    let mut failures = Vec::new();
    for case in FIXTURE["declared"].as_array().expect("объявления") {
        let actual = outcome(verify_declared_artifact(&workspace.root, &case["artifact"]), &workspace.root);
        if actual != case["outcome"] {
            failures.push(format!("{}\n  JS:   {}\n  Rust: {}", js::stringify(&case["artifact"]), js::stringify(&case["outcome"]), js::stringify(&actual)));
        }
    }
    assert!(failures.is_empty(), "расхождений {}:\n{}", failures.len(), failures.join("\n"));
}

/// `test/content-integrity.test.mjs`: настоящий корень проекта — тот же отчёт,
/// что у JS при снятии эталона (меняется вместе с набором ассетов: эталон
/// пересоздаётся генератором).
#[test]
fn real_project_report_matches_js() {
    let root = project_root();
    let report = verify_content_integrity(&root).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(json!({ "ok": report }), FIXTURE["real"]);
    let integrity = &report["integrity"];
    assert_eq!(integrity["ok"], true);
    assert_eq!(integrity["rule_pack"]["rule_count"], 23);
    let packs: Vec<Value> = integrity["rule_packs"].as_array().expect("пакеты").iter().map(|pack| json!([pack["ruleset_id"], pack["rule_count"]])).collect();
    assert_eq!(packs, vec![json!(["srd_5_2_1", 23]), json!(["dnd_5e_2014", 28])]);
    assert_eq!(integrity["target_rule_references"]["referenced_terms"], 34);
    assert_eq!(integrity["compatibility_catalogs"]["spells"], 439);
    assert_eq!(integrity["compatibility_catalogs"]["classes"], 12);
    assert_eq!(
        integrity["character_creation_catalogs"]["dnd_5e_2014"],
        json!({ "species_options": 15, "backgrounds": 13, "classes_with_starter_equipment": 12, "species_choice_groups": 10, "starter_choice_groups": 37, "bonus_source": "species" })
    );
    assert_eq!(integrity["character_creation_catalogs"]["srd_5_2_1"]["bonus_source"], "background");
    assert_eq!(integrity["item_catalog"], json!({ "entries": 145, "shop_entries": 50 }));
    let category = |id: &str| integrity["coverage"].as_array().expect("покрытие").iter().find(|entry| entry["id"] == id).cloned().expect("категория");
    assert_eq!(category("equipment")["count"], 145);
    assert_eq!(category("feats")["coverage"], "missing");

    // Гейт выпуска закрыт, пока права и обязательное покрытие не решены.
    assert_eq!(report["release"]["ready"], false);
    let blockers = report["release"]["blockers"].as_array().expect("блокеры");
    for blocker in ["PROJECT_LICENSE_MISSING", "RIGHTS:public/assets", "COVERAGE:feats:missing"] {
        assert!(blockers.iter().any(|entry| entry == blocker), "нет блокера {blocker}");
    }
}

#[test]
fn changed_registered_artifact_fails_closed() {
    let root = project_root();
    let artifact = json!({ "path": "data/rule_packs/srd_5_2_1/rules.jsonl", "sha256": "0".repeat(64), "size_bytes": 29517, "rights_status": "verified" });
    let result = verify_declared_artifact(&root, &artifact);
    assert_eq!(result.as_ref().err().and_then(ContentIntegrityFailure::code), Some("CONTENT_HASH_MISMATCH"));
    assert_eq!(outcome(result, &root), FIXTURE["changed_rules"]);
}

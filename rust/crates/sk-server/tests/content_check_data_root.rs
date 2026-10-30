//! Урок 7: `check-content --data-dir` проверяет чужой корень данных — копию
//! пакетов правил с опечаткой в ключевом поле манифеста и без картинок миров.
//! Отказ называет файл и запись, код — 1. Свой файл тестов: корень данных
//! процесса задаётся один раз.

use std::path::Path;

use sk_server::content_check::{check_all, failures, run};

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).expect("каталог копии");
    for entry in std::fs::read_dir(from).unwrap_or_else(|error| panic!("{}: {error}", from.display())) {
        let entry = entry.expect("запись каталога");
        let path = entry.path();
        if path.is_dir() {
            copy_tree(&path, &to.join(entry.file_name()));
        } else {
            std::fs::copy(&path, to.join(entry.file_name())).expect("копия файла");
        }
    }
}

#[test]
fn broken_copy_of_data_root_names_pack_and_template() {
    let temp = tempfile::tempdir().expect("временный каталог");
    let packs = temp.path().join("data").join("rule_packs");
    copy_tree(&sk_core::data_root::build_root().join("data").join("rule_packs"), &packs);
    let manifest = packs.join("srd_5_2_1").join("manifest.yaml");
    let text = std::fs::read_to_string(&manifest).expect("манифест");
    assert!(text.contains("ruleset_id:"), "{text}");
    std::fs::write(&manifest, text.replacen("ruleset_id:", "ruleset_idx:", 1)).expect("манифест с опечаткой");

    assert_eq!(run(&["--data-dir".into(), temp.path().display().to_string()]), 1);
    let outcomes = check_all();
    let errors: Vec<String> = failures(&outcomes).iter().map(|error| error.to_string()).collect();
    assert!(errors.contains(&"data/rule_packs: srd_5_2_1: manifest.ruleset_id must be a non-empty string".to_string()), "{errors:?}");
    // Картинок `public/` в копии нет: каталог миров называет шаблон и файл.
    assert!(errors.iter().any(|error| error.starts_with("data/campaign-worlds-v1.json: templates[0].image")), "{errors:?}");
    assert_eq!(errors.len(), 2, "{errors:?}");
}

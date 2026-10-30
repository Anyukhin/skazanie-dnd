//! Урок 7: каталоги контента проверяются при старте. Проверка по настоящему
//! `data/` чиста, подкоманда `check-content` даёт 0, а отказ и паника
//! загрузчика становятся ошибкой с именем файла (код 1 — в `run`).

use sk_core::content::ContentError;
use sk_server::cli::{run_tool, Invocation};
use sk_server::content_check::{catalogs, check_all, failures, run_checks, verify_before_listen, Catalog};

#[test]
fn real_data_passes_every_catalog_check() {
    let outcomes = check_all();
    let errors: Vec<String> = failures(&outcomes).iter().map(|error| error.to_string()).collect();
    assert!(errors.is_empty(), "каталоги data/ не прошли проверку:\n{}", errors.join("\n"));
    assert_eq!(outcomes.len(), catalogs().len());
    // Каждый каталог `data/`, который встраивает или читает сервер, — в списке.
    let files: Vec<&str> = catalogs().iter().flat_map(|catalog| catalog.files.iter().copied()).collect();
    for file in [
        "data/campaign-scenarios-v1.json",
        "data/campaign-dialogues-v1.json",
        "data/authored-location-maps-v1.json",
        "data/campaign-worlds-v1.json",
        "data/backgrounds-srd-5-2-1.json",
        "data/backgrounds-dnd-5e-2014.json",
        "data/character-creation-policy-v1.json",
        "data/character-creation-dnd-5e-2014.json",
        "data/dndsu-class-build-rules-1-12.json",
        "data/character-rules-manifest.json",
        "data/starter-equipment-dnd-5e-2014.json",
        "data/starter-item-presentation.json",
        "data/asset-rights.json",
        "data/talespire-assets-v1.json",
        "data/compendia/dnd_5e_2014",
        "data/dndsu-class-actions-1-12.json",
        "data/dndsu-spells-0-6.json",
        "data/dndsu-spell-mechanics-overrides.json",
        "data/rule_packs",
    ] {
        assert!(files.contains(&file), "{file} нет в списке проверки");
    }
    assert_eq!(verify_before_listen(), Ok(()));
    assert_eq!(run_tool(&Invocation::CheckContent(Vec::new())), Some(0));
    assert_eq!(run_tool(&Invocation::CheckContent(vec!["--json".into()])), Some(0));
    assert_eq!(run_tool(&Invocation::CheckContent(vec!["--bogus".into()])), Some(sk_server::cli::USAGE_EXIT));
}

fn broken() -> sk_core::content::ContentResult<()> {
    Err(ContentError::at("data/x.json", "items[2] «меч»", "нет поля «id»"))
}

fn panicking() -> sk_core::content::ContentResult<()> {
    panic!("встроенный JSON: expected value at line 1 column 1");
}

fn clean() -> sk_core::content::ContentResult<()> {
    Ok(())
}

#[test]
fn failures_and_panics_name_the_file() {
    let list = [
        Catalog { name: "чистый", files: &["data/ok.json"], check: clean },
        Catalog { name: "сломанный", files: &["data/x.json"], check: broken },
        Catalog { name: "паника", files: &["data/y.json", "data/z.json"], check: panicking },
    ];
    let outcomes = run_checks(&list);
    let errors: Vec<String> = failures(&outcomes).iter().map(|error| error.to_string()).collect();
    assert_eq!(
        errors,
        ["data/x.json: items[2] «меч»: нет поля «id»", "data/y.json: паника при загрузке: встроенный JSON: expected value at line 1 column 1"]
    );
    assert_eq!(outcomes.iter().map(|outcome| outcome.name).collect::<Vec<_>>(), ["чистый", "сломанный", "паника"]);
}

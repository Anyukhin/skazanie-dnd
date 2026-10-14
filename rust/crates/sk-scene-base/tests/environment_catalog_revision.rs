//! Сверка `environment_catalog_revision` с JS: эталон
//! `fixtures/environment-catalog-revision.json`
//! (`fixtures/gen-environment-catalog-revision.mjs`) и перенесённые проверки
//! `test/map-catalog-revision.test.mjs` (в части модуля).

mod common;

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use common::Mismatches;
use serde_json::{json, Value};
use sk_scene_base::environment_catalog_revision::*;

static FIXTURE: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../fixtures/environment-catalog-revision.json")).expect("эталон environment-catalog-revision")
});

/// Временный каталог теста; удаляется при выходе.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("sk-scene-base-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&path).ok();
        std::fs::create_dir_all(&path).expect("каталог");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).ok();
    }
}

#[test]
fn constants_and_safe_ids_match_js() {
    assert_eq!(FIXTURE["legacy"], json!(LEGACY_CATALOG_REVISION));
    assert_eq!(FIXTURE["source"], json!(SAFE_CATALOG_REVISION));
    let mut check = Mismatches::new();
    for case in FIXTURE["safe"].as_array().expect("safe") {
        check.check(&json!(is_safe_catalog_revision(Some(&case["value"]))), &case["output"], || format!("{}", case["value"]));
    }
    check.finish("безопасный выпуск");
}

#[test]
fn manifests_match_js() {
    let dir = TempDir::new("revision-fixture");
    let mut check = Mismatches::new();
    for (index, case) in FIXTURE["manifests"].as_array().expect("manifests").iter().enumerate() {
        let file = dir.path().join(format!("manifest-{index}.json"));
        std::fs::write(&file, case["text"].as_str().expect("text")).expect("запись");
        check.check(&json!(current_environment_catalog_revision_at(&file, None)), &case["output"], || format!("{}", case["text"]));
    }
    let folder = dir.path().join("folder.json");
    std::fs::create_dir_all(&folder).expect("каталог");
    check.check(&json!(current_environment_catalog_revision_at(&folder, None)), &FIXTURE["folder"], || "каталог вместо файла".into());
    check.finish("манифесты");
}

#[test]
fn default_revision_reads_release_id_of_public_manifest() {
    let expected = std::fs::read_to_string(&*ENVIRONMENT_MANIFEST_PATH)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|manifest| manifest["release"]["id"].as_str().map(String::from))
        .filter(|id| is_safe_catalog_revision_str(id))
        .unwrap_or_else(|| LEGACY_CATALOG_REVISION.to_string());
    let revision = current_environment_catalog_revision();
    assert_eq!(revision, expected);
    assert!(is_safe_catalog_revision_str(&revision));
}

// --- test/map-catalog-revision.test.mjs --------------------------------------

#[test]
fn current_release_from_release_id_and_missing_manifest_gives_pr79() {
    let dir = TempDir::new("revision-manifest");
    let manifest = dir.path().join("manifest.json");
    std::fs::write(&manifest, r#"{"release":{"id":"new_release"}}"#).expect("запись");
    assert_eq!(current_environment_catalog_revision_at(&manifest, None), "new_release");
    std::fs::write(&manifest, r#"{"version":1}"#).expect("запись");
    assert_eq!(current_environment_catalog_revision_at(&manifest, None), LEGACY_CATALOG_REVISION);
    assert_eq!(current_environment_catalog_revision_at(&dir.path().join("missing.json"), None), LEGACY_CATALOG_REVISION);
    assert_eq!(LEGACY_CATALOG_REVISION, "pr79");
}

#[test]
fn docker_layout_uses_dist_manifest_but_dev_public_wins() {
    let dir = TempDir::new("revision-layout");
    let public_manifest = dir.path().join("public/assets/models/environment/manifest.json");
    let dist_manifest = dir.path().join("dist/assets/models/environment/manifest.json");
    std::fs::create_dir_all(dist_manifest.parent().expect("каталог")).expect("каталог");
    std::fs::write(&dist_manifest, r#"{"version":1,"release":{"id":"docker-release"}}"#).expect("запись");
    assert_eq!(current_environment_catalog_revision_at(&public_manifest, Some(&dist_manifest)), "docker-release");

    std::fs::create_dir_all(public_manifest.parent().expect("каталог")).expect("каталог");
    std::fs::write(&public_manifest, r#"{"version":1}"#).expect("запись");
    assert_eq!(current_environment_catalog_revision_at(&public_manifest, Some(&dist_manifest)), LEGACY_CATALOG_REVISION);

    std::fs::write(&public_manifest, r#"{"version":1,"release":{"id":"dev-release"}}"#).expect("запись");
    assert_eq!(current_environment_catalog_revision_at(&public_manifest, Some(&dist_manifest)), "dev-release");
}

#[test]
fn explicit_empty_fallback_disables_default_dist_path() {
    let dir = TempDir::new("revision-empty-fallback");
    assert_eq!(current_environment_catalog_revision_at(&dir.path().join("missing.json"), Some(Path::new(""))), LEGACY_CATALOG_REVISION);
    let repeated = dir.path().join("same.json");
    std::fs::write(&repeated, r#"{"release":{"id":"same"}}"#).expect("запись");
    assert_eq!(current_environment_catalog_revision_at(&repeated, Some(&repeated)), "same");
}

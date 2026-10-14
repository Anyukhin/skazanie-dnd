//! Перенос `server/environment-catalog-revision.mjs`: какой выпуск каталога
//! окружения закрепляет новая карта (`catalogRevision`).
//!
//! Выпуск читается из `release.id` манифеста каталога окружения на диске: в
//! рабочей копии — из `public/assets`, в образе Docker — из собранной копии в
//! `dist/assets`. Нет манифеста или в нём нет выпуска — живёт старый каталог
//! `pr79`. Чтение кэшируется до следующего изменения файла (размер и время
//! правки). Манифест не встраивается в сборку: выпуск меняется без
//! пересборки сервера, как в JS.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::UNIX_EPOCH;

use serde_json::Value;
use sk_core::{re, text};

use crate::util::repo_root;

/// Старый каталог, который уже входит в сохранённые карты и сайт.
pub const LEGACY_CATALOG_REVISION: &str = "pr79";

/// Источник `SAFE_CATALOG_REVISION` в синтаксисе JS (флаг `u`).
pub const SAFE_CATALOG_REVISION: &str = r"^[a-z0-9][a-z0-9_-]{0,95}$";

/// Манифест каталога окружения в рабочей копии.
pub static ENVIRONMENT_MANIFEST_PATH: LazyLock<PathBuf> =
    LazyLock::new(|| repo_root().join("public/assets/models/environment/manifest.json"));

/// Собранная копия манифеста (образ Docker).
pub static ENVIRONMENT_DIST_MANIFEST_PATH: LazyLock<PathBuf> =
    LazyLock::new(|| repo_root().join("dist/assets/models/environment/manifest.json"));

/// Скомпилированное `SAFE_CATALOG_REVISION`.
pub fn safe_catalog_revision() -> &'static sk_core::fancy_regex::Regex {
    re!(SAFE_CATALOG_REVISION, "u")
}

/// Строка — безопасный идентификатор выпуска.
pub fn is_safe_catalog_revision(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(is_safe_catalog_revision_str)
}

/// То же для строки.
pub fn is_safe_catalog_revision_str(value: &str) -> bool {
    text::test(safe_catalog_revision(), value)
}

struct RevisionCacheEntry {
    signature: String,
    revision: String,
}

static REVISION_CACHE: LazyLock<Mutex<HashMap<PathBuf, RevisionCacheEntry>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// `${stats.size}:${stats.mtimeMs}` — подпись файла для кэша.
fn signature(metadata: &std::fs::Metadata) -> String {
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("{}:{modified}", metadata.len())
}

/// Активный выпуск каталога по путям по умолчанию: манифест рабочей копии,
/// затем собранная копия.
pub fn current_environment_catalog_revision() -> String {
    current_environment_catalog_revision_at(&ENVIRONMENT_MANIFEST_PATH, None)
}

/// `currentEnvironmentCatalogRevision(manifestPath, fallbackManifestPath)`.
///
/// `fallback: None` — значение по умолчанию JS: собранная копия, если
/// `manifest_path` — путь по умолчанию, иначе без запасного пути. Пустой путь
/// пропускается, повтор — тоже.
pub fn current_environment_catalog_revision_at(manifest_path: &Path, fallback: Option<&Path>) -> String {
    let default_fallback: &Path = if manifest_path == ENVIRONMENT_MANIFEST_PATH.as_path() {
        ENVIRONMENT_DIST_MANIFEST_PATH.as_path()
    } else {
        Path::new("")
    };
    let fallback = fallback.unwrap_or(default_fallback);
    let mut paths: Vec<&Path> = Vec::new();
    for path in [manifest_path, fallback] {
        if !path.as_os_str().is_empty() && !paths.contains(&path) {
            paths.push(path);
        }
    }
    for path in paths {
        let Ok(metadata) = std::fs::metadata(path) else { continue };
        let signature = signature(&metadata);
        let mut cache = REVISION_CACHE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(cached) = cache.get(path) {
            if cached.signature == signature {
                return cached.revision.clone();
            }
        }
        // Повреждённый manifest оставляет прежний каталог.
        let manifest = std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes)).ok());
        let candidate = manifest.as_ref().and_then(|manifest| manifest.get("release")).and_then(|release| release.get("id"));
        let revision = match candidate.and_then(Value::as_str) {
            Some(id) if is_safe_catalog_revision_str(id) => id.to_string(),
            _ => LEGACY_CATALOG_REVISION.to_string(),
        };
        cache.insert(path.to_path_buf(), RevisionCacheEntry { signature, revision: revision.clone() });
        return revision;
    }
    LEGACY_CATALOG_REVISION.to_string()
}

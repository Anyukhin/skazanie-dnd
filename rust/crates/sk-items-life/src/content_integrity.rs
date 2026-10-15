//! Перенос `server/content-integrity.mjs`: гейт целостности встроенного
//! контента перед выпуском.
//!
//! Проверяется: артефакты `data/content-provenance.json` (путь внутри корня,
//! размер, SHA-256, статус прав, известный источник), полный реестр ассетов
//! `data/asset-rights.json` против каталога `public/assets`, оба пакета правил
//! и ссылки их правил на глоссарий, каталоги совместимости dnd.su, каталоги
//! создания героя 2014, матрица покрытия против счётчиков рантайма и
//! обязательные уведомления `ATTRIBUTION.md`. Итог — отчёт целостности и
//! список блокеров выпуска.
//!
//! Файлы читаются из переданного корня (`rootDir` в JS) во время вызова;
//! каталоги предметов, заклинаний, бестиария и происхождения — встроенные, из
//! крейтов нижних волн, как модули, которые импортирует JS.
//!
//! Мусор в JSON-файлах JS переживает по-своему: где он обращается к полю
//! `null` или перебирает объект — это `TypeError`
//! ([`ContentIntegrityFailure::Type`]); где строку перебирают по символам,
//! `Object.keys` строки даёт индексы, а ключ прототипа (`constructor`)
//! находится у любого объекта — Rust повторяет то же.

use std::cmp::Ordering;
use std::fmt;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
use sk_core::{hash, js};
use sk_rulepack::rule_pack::load_rule_pack;
use sk_rulepack::RulePackValidationError;

const RIGHTS: [&str; 5] = ["verified", "cleared", "project_license_required", "review_required", "blocked"];
const COVERAGE: [&str; 3] = ["complete", "partial", "missing"];

/// Собственные свойства `Object.prototype`: `obj[key]` в JS находит их у любого
/// обычного объекта, `key in obj` для них истинно.
const PROTOTYPE_KEYS: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

const ATTRIBUTION_NOTICES: [&str; 6] = [
    "System Reference Document 5.2.1 (“SRD 5.2.1”) by Wizards of the Coast LLC",
    "https://creativecommons.org/licenses/by/4.0/legalcode",
    "не означает официальный статус, одобрение",
    "data/rule_packs/dnd_5e_2014",
    "5e14.dnd.su",
    "Права на русские переводы и базу dnd.su по-прежнему не подтверждены",
];

/// `ContentIntegrityError`: сообщение, код и подробности (`Object.assign(this,
/// details)` в JS — здесь отдельным объектом).
#[derive(Debug, Clone, PartialEq)]
pub struct ContentIntegrityError {
    pub message: String,
    pub code: String,
    pub details: Map<String, Value>,
}

impl ContentIntegrityError {
    fn new(message: impl Into<String>, code: &str) -> Self {
        Self { message: message.into(), code: code.into(), details: Map::new() }
    }

    fn with(mut self, key: &str, value: Value) -> Self {
        self.details.insert(key.into(), value);
        self
    }
}

/// Любой отказ гейта: собственный, пакета правил, `TypeError` JS на мусоре
/// или необёрнутая ошибка файловой системы (`readdirSync`, `readFileSync`).
#[derive(Debug, Clone, PartialEq)]
pub enum ContentIntegrityFailure {
    Integrity(ContentIntegrityError),
    RulePack(RulePackValidationError),
    /// `TypeError` JS: обращение к полю `null`, перебор не-итерируемого,
    /// `.map` у не-массива. Текст — описание для людей, не текст V8.
    Type(String),
    /// Ошибка ввода-вывода, которую JS пропускает как есть; `code` — как у
    /// Node (`ENOENT`, `EISDIR`, `EACCES`, `EIO`).
    Io { code: String, message: String },
}

impl ContentIntegrityFailure {
    /// Код ошибки, как его видит вызывающий JS (`error.code`).
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Integrity(error) => Some(&error.code),
            Self::Io { code, .. } => Some(code),
            Self::RulePack(_) | Self::Type(_) => None,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::Integrity(error) => &error.message,
            Self::RulePack(error) => &error.message,
            Self::Type(message) => message,
            Self::Io { message, .. } => message,
        }
    }
}

impl fmt::Display for ContentIntegrityFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for ContentIntegrityFailure {}

impl From<ContentIntegrityError> for ContentIntegrityFailure {
    fn from(error: ContentIntegrityError) -> Self {
        Self::Integrity(error)
    }
}

type Result<T> = std::result::Result<T, ContentIntegrityFailure>;

fn fail<T>(message: impl Into<String>, code: &str) -> Result<T> {
    Err(ContentIntegrityError::new(message, code).into())
}

fn type_error<T>(what: impl Into<String>) -> Result<T> {
    Err(ContentIntegrityFailure::Type(what.into()))
}

// --- доступ к значениям, как в JS ------------------------------------------

/// `value.key`: у `undefined`/`null` — `TypeError`, у примитивов и массивов
/// нужных здесь полей нет.
fn prop<'a>(value: Option<&'a Value>, key: &str) -> Result<Option<&'a Value>> {
    match value {
        None | Some(Value::Null) => type_error(format!("Cannot read properties of {} (reading '{key}')", if value.is_none() { "undefined" } else { "null" })),
        Some(Value::Object(map)) => Ok(map.get(key)),
        Some(_) => Ok(None),
    }
}

/// `value?.key`.
fn opt_prop<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match value {
        Some(Value::Object(map)) => map.get(key),
        _ => None,
    }
}

/// `for (const x of value)`: массив — элементы, строка — символы (по кодовым
/// точкам), остальное не итерируется.
fn iterate(value: Option<&Value>) -> Result<Vec<Value>> {
    match value {
        Some(Value::Array(items)) => Ok(items.clone()),
        Some(Value::String(text)) => Ok(text.chars().map(|ch| Value::String(ch.to_string())).collect()),
        _ => type_error("value is not iterable"),
    }
}

/// `for (const x of value ?? [])`.
fn iterate_nullish(value: Option<&Value>) -> Result<Vec<Value>> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        other => iterate(other),
    }
}

/// `value.map(…)`, `value.reduce(…)`: метод есть только у массива.
fn array_method(value: Option<&Value>) -> Result<&Vec<Value>> {
    match value {
        Some(Value::Array(items)) => Ok(items),
        None | Some(Value::Null) => type_error("Cannot read properties of null or undefined"),
        Some(_) => type_error("value.map is not a function"),
    }
}

/// `value.length` для арифметики: у `undefined`/`null` — `TypeError`, у
/// массива и строки (в единицах UTF-16) — длина, у прочего `undefined` → `NaN`.
fn length(value: Option<&Value>) -> Result<f64> {
    match value {
        None | Some(Value::Null) => type_error("Cannot read properties of null or undefined (reading 'length')"),
        other => Ok(length_or_nan(other)),
    }
}

/// `value?.length` в сравнении `!== n`: отсутствие — `NaN`, как и `undefined`.
fn length_or_nan(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Array(items)) => items.len() as f64,
        Some(Value::String(text)) => text.encode_utf16().count() as f64,
        _ => f64::NAN,
    }
}

/// `x === y` для значений JSON; `None` — `undefined`. Объекты и массивы из
/// разных мест разбора никогда не равны.
fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        _ => false,
    }
}

fn is_str(value: Option<&Value>, expected: &str) -> bool {
    matches!(value, Some(Value::String(text)) if text == expected)
}

fn is_num(value: Option<&Value>, expected: f64) -> bool {
    matches!(value, Some(Value::Number(number)) if number.as_f64() == Some(expected))
}

/// `${value}` в шаблонной строке.
fn tpl(value: Option<&Value>) -> String {
    js::string(value)
}

/// `new Set()` значений JSON: равенство SameValueZero, `undefined` — `None`.
#[derive(Default)]
struct JsSet {
    items: Vec<Option<Value>>,
}

impl JsSet {
    fn has(&self, value: Option<&Value>) -> bool {
        self.items.iter().any(|item| strict_eq(item.as_ref(), value))
    }

    fn add(&mut self, value: Option<&Value>) {
        if !self.has(value) {
            self.items.push(value.cloned());
        }
    }

    fn size(&self) -> usize {
        self.items.len()
    }
}

/// `Object.keys(value ?? {})`.
fn object_keys(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Object(map)) => js::keys(map).into_iter().cloned().collect(),
        Some(Value::Array(items)) => (0..items.len()).map(|index| index.to_string()).collect(),
        Some(Value::String(text)) => (0..text.encode_utf16().count()).map(|index| index.to_string()).collect(),
        _ => Vec::new(),
    }
}

/// `catalog[key]` истинно: собственная запись (всегда объект) или свойство
/// прототипа.
fn catalog_has(catalog: &Map<String, Value>, key: &str) -> bool {
    catalog.contains_key(key) || PROTOTYPE_KEYS.contains(&key)
}

/// `String(Object.prototype[key])`.
fn prototype_value_string(key: &str) -> String {
    match key {
        "constructor" => "function Object() { [native code] }".into(),
        "__proto__" => "[object Object]".into(),
        name => format!("function {name}() {{ [native code] }}"),
    }
}

/// Сравнение строк как в `Array.prototype.sort` без сравнителя: по единицам
/// UTF-16.
fn utf16_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

// --- пути, как `path.resolve` / `path.relative` Node ------------------------

#[cfg(windows)]
const SEP: char = '\\';
#[cfg(not(windows))]
const SEP: char = '/';

/// Абсолютный путь, разобранный лексически: префикс (диск `C:` на Windows,
/// пусто на Unix) и сегменты без `.` и `..`.
#[derive(Debug, Clone)]
struct LexPath {
    prefix: String,
    segments: Vec<String>,
}

impl LexPath {
    fn absolute(path: &Path) -> Self {
        let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
        let text = absolute.to_string_lossy().into_owned();
        let (prefix, rest) = split_drive(&text);
        let mut lex = Self { prefix: prefix.to_string(), segments: Vec::new() };
        lex.push_all(rest);
        lex
    }

    fn push_all(&mut self, rest: &str) {
        for segment in rest.split(['/', '\\']) {
            match segment {
                "" | "." => {}
                ".." => {
                    self.segments.pop();
                }
                other => self.segments.push(other.to_string()),
            }
        }
    }

    /// `path.resolve(this, relative)` для пути с прямыми слэшами.
    fn resolve(&self, relative: &str) -> Self {
        let (drive, rest) = split_drive(relative);
        let mut base = if drive.is_empty() {
            self.clone()
        } else if rest.starts_with(['/', '\\']) || !same_name(drive, &self.prefix) {
            // Путь от корня диска; у чужого диска без слэша JS берёт текущий
            // каталог того диска — здесь корень (такой путь в данных не встречается).
            Self { prefix: drive.to_string(), segments: Vec::new() }
        } else {
            self.clone()
        };
        base.push_all(rest);
        base
    }

    /// `path.relative(this, target)`.
    fn relative(&self, target: &Self) -> String {
        if !same_name(&self.prefix, &target.prefix) {
            return target.display();
        }
        let common = self.segments.iter().zip(&target.segments).take_while(|(a, b)| same_name(a, b)).count();
        let mut parts: Vec<&str> = vec![".."; self.segments.len() - common];
        parts.extend(target.segments[common..].iter().map(String::as_str));
        parts.join(&SEP.to_string())
    }

    fn display(&self) -> String {
        format!("{}{SEP}{}", self.prefix, self.segments.join(&SEP.to_string()))
    }

    fn path(&self) -> PathBuf {
        PathBuf::from(self.display())
    }
}

#[cfg(windows)]
fn split_drive(text: &str) -> (&str, &str) {
    let bytes = text.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        (&text[..2], &text[2..])
    } else {
        ("", text)
    }
}

#[cfg(not(windows))]
fn split_drive(text: &str) -> (&str, &str) {
    ("", text)
}

#[cfg(windows)]
fn same_name(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

#[cfg(not(windows))]
fn same_name(a: &str, b: &str) -> bool {
    a == b
}

/// `safeProjectFile(rootDir, relativePath)`.
fn safe_project_file(root: &LexPath, relative_path: Option<&Value>) -> Result<LexPath> {
    let normalized = js::s(relative_path).replace('\\', "/");
    if normalized.is_empty() || normalized.starts_with('/') || normalized.split('/').any(|part| part == "..") {
        return fail(format!("Unsafe artifact path: {}", tpl(relative_path)), "CONTENT_PATH_INVALID");
    }
    let absolute = root.resolve(&normalized);
    let rel = root.relative(&absolute);
    if rel.is_empty() || rel.starts_with("..") || rel.contains(&format!("..{SEP}")) {
        return fail(format!("Artifact escapes project root: {}", tpl(relative_path)), "CONTENT_PATH_INVALID");
    }
    Ok(absolute)
}

fn project_file(root: &LexPath, relative: &str) -> Result<LexPath> {
    safe_project_file(root, Some(&Value::String(relative.into())))
}

// --- файлы -----------------------------------------------------------------

fn io_code(error: &std::io::Error) -> &'static str {
    match error.kind() {
        std::io::ErrorKind::NotFound => "ENOENT",
        std::io::ErrorKind::PermissionDenied => "EACCES",
        std::io::ErrorKind::IsADirectory => "EISDIR",
        std::io::ErrorKind::NotADirectory => "ENOTDIR",
        _ => "EIO",
    }
}

/// `readFileSync(file)`: каталог — `EISDIR`, как у Node (Windows отвечает
/// «доступ запрещён»).
fn read_bytes(file: &LexPath) -> Result<Vec<u8>> {
    let path = file.path();
    if path.is_dir() {
        return Err(ContentIntegrityFailure::Io { code: "EISDIR".into(), message: format!("EISDIR: illegal operation on a directory, read '{}'", file.display()) });
    }
    std::fs::read(&path).map_err(|error| ContentIntegrityFailure::Io { code: io_code(&error).into(), message: format!("{}: {error}, open '{}'", io_code(&error), file.display()) })
}

/// `readJson(file)`: любой отказ чтения или разбора — `CONTENT_MANIFEST_INVALID`.
/// Хвост сообщения (текст ошибки) у Rust свой: V8 пишет «Unexpected token…».
fn read_json(file: &LexPath) -> Result<Value> {
    let parsed = read_bytes(file)
        .map_err(|error| error.message().to_string())
        .and_then(|bytes| serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes)).map_err(|error| error.to_string()));
    parsed.or_else(|message| fail(format!("Cannot read JSON {}: {message}", file.display()), "CONTENT_MANIFEST_INVALID"))
}

/// `sha256File(file)`: SHA-256 содержимого файла в hex.
pub fn sha256_file(file: &Path) -> std::io::Result<String> {
    std::fs::read(file).map(hash::sha256_hex)
}

fn is_sha256(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|byte| matches!(byte, b'a'..=b'f' | b'0'..=b'9'))
}

/// `verifyDeclaredArtifact(rootDir, artifact)`: путь внутри корня, размер,
/// SHA-256 и статус прав объявленного файла; возвращает
/// `{ path, sha256, size_bytes, rights_status }`.
pub fn verify_declared_artifact(root_dir: &Path, artifact: &Value) -> Result<Value> {
    verify_artifact(&LexPath::absolute(root_dir), artifact)
}

fn verify_artifact(root: &LexPath, artifact: &Value) -> Result<Value> {
    let Value::Object(fields) = artifact else {
        return fail("Artifact declaration must be an object", "CONTENT_ARTIFACT_INVALID");
    };
    let path = fields.get("path");
    let file = safe_project_file(root, path)?;
    let shown = tpl(path);
    let path_value = path.cloned().unwrap_or(Value::Null);
    let Ok(metadata) = std::fs::metadata(file.path()) else {
        return Err(ContentIntegrityError::new(format!("Registered artifact is missing: {shown}"), "CONTENT_ARTIFACT_MISSING").with("path", path_value).into());
    };
    let actual_size = metadata.len();
    let declared_size = fields.get("size_bytes");
    let size_ok = js::is_safe_integer(declared_size) && js::number(declared_size) >= 0.0 && js::number(declared_size) == actual_size as f64;
    if !size_ok {
        return Err(ContentIntegrityError::new(format!("Size mismatch for {shown}: expected {}, actual {actual_size}", tpl(declared_size)), "CONTENT_SIZE_MISMATCH")
            .with("path", path_value)
            .into());
    }
    let declared_hash = fields.get("sha256");
    if !is_sha256(&js::s(declared_hash)) {
        return Err(ContentIntegrityError::new(format!("Invalid SHA-256 declaration for {shown}"), "CONTENT_HASH_INVALID").with("path", path_value).into());
    }
    let actual_hash = hash::sha256_hex(read_bytes(&file)?);
    if !is_str(declared_hash, &actual_hash) {
        return Err(ContentIntegrityError::new(format!("SHA-256 mismatch for {shown}"), "CONTENT_HASH_MISMATCH")
            .with("path", path_value)
            .with("expected", declared_hash.cloned().unwrap_or(Value::Null))
            .with("actual", Value::String(actual_hash))
            .into());
    }
    let rights = fields.get("rights_status");
    if !RIGHTS.iter().any(|status| is_str(rights, status)) {
        return Err(ContentIntegrityError::new(format!("Unknown rights status for {shown}"), "CONTENT_RIGHTS_STATUS_INVALID").with("path", path_value).into());
    }
    Ok(json!({ "path": path_value, "sha256": actual_hash, "size_bytes": actual_size, "rights_status": rights }))
}

/// `walkFiles(directory)`: все файлы под каталогом, пути через `/`, имена
/// каждого уровня по `sort()`.
fn walk_files(directory: &Path, prefix: &str) -> Result<Vec<String>> {
    let io = |error: std::io::Error| ContentIntegrityFailure::Io { code: io_code(&error).into(), message: format!("{}: {error}, scandir '{}'", io_code(&error), directory.display()) };
    let mut names: Vec<String> = std::fs::read_dir(directory).map_err(io)?.map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().into_owned())).collect::<std::io::Result<_>>().map_err(io)?;
    names.sort_by(|a, b| utf16_cmp(a, b));
    let mut files = Vec::new();
    for name in names {
        let absolute = directory.join(&name);
        let relative = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
        let metadata = std::fs::metadata(&absolute).map_err(io)?;
        if metadata.is_dir() {
            files.extend(walk_files(&absolute, &relative)?);
        } else {
            files.push(relative);
        }
    }
    Ok(files)
}

fn validate_asset_registry(root: &LexPath, registry: &Value) -> Result<Vec<Value>> {
    let assets_root = prop(Some(registry), "assets_root")?;
    let assets = prop(Some(registry), "assets")?;
    if !is_num(prop(Some(registry), "schema_version")?, 1.0) || !is_str(assets_root, "public/assets") || !matches!(assets, Some(Value::Array(_))) {
        return fail("Asset rights registry has an unsupported shape", "ASSET_REGISTRY_INVALID");
    }
    let mut declared = JsSet::default();
    let mut artifacts = Vec::new();
    for tuple in assets.and_then(Value::as_array).into_iter().flatten() {
        let Some([path, sha256, size_bytes]) = tuple.as_array().and_then(|items| <&[Value; 3]>::try_from(items.as_slice()).ok()) else {
            return fail("Asset registry entry must be [path, sha256, size]", "ASSET_REGISTRY_INVALID");
        };
        if declared.has(Some(path)) {
            return fail(format!("Duplicate asset declaration: {}", tpl(Some(path))), "ASSET_REGISTRY_DUPLICATE");
        }
        declared.add(Some(path));
        let mut artifact = Map::new();
        artifact.insert("path".into(), Value::String(format!("{}/{}", tpl(assets_root), tpl(Some(path)))));
        artifact.insert("sha256".into(), sha256.clone());
        artifact.insert("size_bytes".into(), size_bytes.clone());
        if let Some(status) = registry.get("rights_status") {
            artifact.insert("rights_status".into(), status.clone());
        }
        artifacts.push(verify_artifact(root, &Value::Object(artifact))?);
    }
    let actual = walk_files(&safe_project_file(root, assets_root)?.path(), "")?;
    let undeclared: Vec<Value> = actual.iter().filter(|path| !declared.has(Some(&Value::String((*path).clone())))).map(|path| Value::String(path.clone())).collect();
    let missing: Vec<Value> = declared
        .items
        .iter()
        .filter(|path| !matches!(path, Some(Value::String(text)) if actual.contains(text)))
        .map(|path| path.clone().unwrap_or(Value::Null))
        .collect();
    if !undeclared.is_empty() || !missing.is_empty() {
        let join = |items: &[Value]| {
            let text = items.iter().map(|item| js::s(Some(item))).collect::<Vec<_>>().join(", ");
            if text.is_empty() { "-".to_string() } else { text }
        };
        return Err(ContentIntegrityError::new(format!("Asset registry drift: undeclared={}; missing={}", join(&undeclared), join(&missing)), "ASSET_REGISTRY_DRIFT")
            .with("undeclared", Value::Array(undeclared))
            .with("missing", Value::Array(missing))
            .into());
    }
    Ok(artifacts)
}

fn validate_rule_references(pack: &Value) -> Result<Value> {
    let empty = Vec::new();
    let glossary = pack.get("glossary").and_then(Value::as_array).unwrap_or(&empty);
    let rules = pack.get("rules").and_then(Value::as_array).unwrap_or(&empty);
    let mut glossary_ids = JsSet::default();
    for entry in glossary {
        glossary_ids.add(entry.get("canonical_id"));
    }
    let mut unknown = Vec::new();
    for rule in rules {
        for reference in iterate_nullish(rule.get("entity_refs"))? {
            if !glossary_ids.has(Some(&reference)) {
                unknown.push(Value::String(format!("{} -> {}", tpl(rule.get("id")), tpl(Some(&reference)))));
            }
        }
    }
    if !unknown.is_empty() {
        let text = unknown.iter().map(|item| js::s(Some(item))).collect::<Vec<_>>().join(", ");
        return Err(ContentIntegrityError::new(format!("Unknown rule entity references: {text}"), "RULE_REFERENCE_INVALID").with("unknown", Value::Array(unknown)).into());
    }
    let mut levels = Map::new();
    for rule in rules {
        let key = tpl(rule.get("formalization_level"));
        let count = levels.get(&key).and_then(Value::as_i64).unwrap_or(0);
        levels.insert(key, Value::from(count + 1));
    }
    let coverage = pack.get("coverage");
    for level in ["deterministic", "structured", "retrieval_only"] {
        let declared = js::number(opt_prop(coverage, &format!("{level}_rule_count")));
        let actual = levels.get(level).and_then(Value::as_i64).unwrap_or(0);
        if declared != actual as f64 {
            return fail(format!("Coverage {level}_rule_count={}, actual={actual}", js::f64_string(declared)), "RULE_COVERAGE_COUNT_MISMATCH");
        }
    }
    let mut ordered = Map::new();
    for (key, value) in js::entries(&levels) {
        ordered.insert(key.clone(), value.clone());
    }
    Ok(json!({ "referenced_terms": glossary_ids.size(), "formalization": ordered }))
}

fn sum_lengths(entries: &[Value], key: &str) -> Result<f64> {
    let mut total = 0.0;
    for entry in entries {
        total += length(prop(Some(entry), key)?)?;
    }
    Ok(total)
}

fn validate_compatibility_catalogs(root: &LexPath) -> Result<Value> {
    let spells = read_json(&project_file(root, "data/dndsu-spells-0-6.json")?)?;
    let overrides = read_json(&project_file(root, "data/dndsu-spell-mechanics-overrides.json")?)?;
    let actions = read_json(&project_file(root, "data/dndsu-class-actions-1-12.json")?)?;
    let build = read_json(&project_file(root, "data/dndsu-class-build-rules-1-12.json")?)?;
    let spell_list = array_method(prop(Some(&spells), "spells")?)?;
    let mut spell_ids = JsSet::default();
    for spell in spell_list {
        spell_ids.add(prop(Some(spell), "id")?);
    }
    let action_classes = array_method(prop(Some(&actions), "classes")?)?;
    let mut class_ids = JsSet::default();
    for entry in action_classes {
        class_ids.add(prop(Some(entry), "classKey")?);
    }
    let mut build_class_ids = JsSet::default();
    for entry in array_method(prop(Some(&build), "classes")?)? {
        build_class_ids.add(prop(Some(entry), "classKey")?);
    }
    let mut problems: Vec<String> = Vec::new();
    let count = prop(Some(&spells), "count")?;
    if !is_num(count, spell_list.len() as f64) {
        problems.push(format!("spell count {} != {}", tpl(count), spell_list.len()));
    }
    let override_ids = object_keys(prop(Some(&overrides), "spells")?);
    for id in &override_ids {
        if !spell_ids.has(Some(&Value::String(id.clone()))) {
            problems.push(format!("override references unknown spell {id}"));
        }
    }
    for spell in spell_list {
        for class_id in iterate_nullish(prop(Some(spell), "classes")?)? {
            if !class_ids.has(Some(&class_id)) {
                problems.push(format!("spell {} references unknown class {}", tpl(spell.get("id")), tpl(Some(&class_id))));
            }
        }
        if !tpl(prop(Some(spell), "sourceUrl")?).starts_with("https://www.dnd.su/") {
            problems.push(format!("spell {} has an unapproved source URL", tpl(spell.get("id"))));
        }
    }
    for entry in action_classes {
        let class_key = entry.get("classKey");
        if !build_class_ids.has(class_key) {
            problems.push(format!("class actions missing build rules for {}", tpl(class_key)));
        }
        for action in iterate(prop(Some(entry), "actions")?)? {
            let action_class = prop(Some(&action), "classKey")?;
            if !strict_eq(action_class, class_key) {
                problems.push(format!("action {} belongs to {}, expected {}", tpl(opt_prop(Some(&action), "id")), tpl(action_class), tpl(class_key)));
            }
        }
    }
    for class_id in &build_class_ids.items {
        if !class_ids.has(class_id.as_ref()) {
            problems.push(format!("build rules reference unknown class {}", tpl(class_id.as_ref())));
        }
    }
    if !problems.is_empty() {
        let shown = problems.iter().take(20).cloned().collect::<Vec<_>>().join("; ");
        return Err(ContentIntegrityError::new(format!("Compatibility catalog integrity failed: {shown}"), "CATALOG_REFERENCE_INVALID").with("problems", json!(problems)).into());
    }
    Ok(json!({
        "spells": spell_list.len(),
        "classes": action_classes.len(),
        "subclasses": js::num(sum_lengths(action_classes, "subclasses")?),
        "actions": js::num(sum_lengths(action_classes, "actions")?),
        "overrides": override_ids.len(),
    }))
}

/// `ITEM_CATALOG[item[key]]` истинно.
fn item_known(item: &Value, key: &str) -> Result<bool> {
    let catalog_id = prop(Some(item), key)?;
    Ok(catalog_has(sk_items::item_catalog::item_catalog(), &tpl(catalog_id)))
}

fn validate_character_creation_catalogs(root: &LexPath) -> Result<Value> {
    let origins = sk_ruleset::character_creation_catalog::character_creation_origin_catalog_info();
    let backgrounds = sk_ruleset::backgrounds::background_catalog_info();
    let starter = read_json(&project_file(root, "data/starter-equipment-dnd-5e-2014.json")?)?;
    let classic_backgrounds = read_json(&project_file(root, "data/backgrounds-dnd-5e-2014.json")?)?;
    let mut problems: Vec<String> = Vec::new();
    let classic = origins.get("dnd_5e_2014");
    let modern = origins.get("srd_5_2_1");
    if !is_num(opt_prop(classic, "species_options"), 15.0) || !is_str(opt_prop(classic, "bonus_source"), "species") {
        problems.push("2014 must expose 14 core race/subrace options plus variant human with species-owned ability bonuses".into());
    }
    let classic_backgrounds_info = backgrounds.get("dnd_5e_2014");
    if !is_num(opt_prop(classic_backgrounds_info, "backgrounds"), 13.0) || !is_num(opt_prop(classic_backgrounds_info, "ability_modes"), 0.0) {
        problems.push("2014 must expose 13 backgrounds without background ability modes".into());
    }
    if !is_str(opt_prop(modern, "bonus_source"), "background") {
        problems.push("2024 background-owned ability bonuses changed".into());
    }
    let classic_origins = sk_ruleset::character_creation_catalog::character_creation_policy_for("dnd_5e_2014").map_err(|error| ContentIntegrityFailure::Type(format!("{error:?}")))?;
    let starter_classes = prop(Some(&starter), "classes")?;
    if !is_num(prop(Some(&starter), "schema_version")?, 2.0)
        || !is_num(prop(Some(&starter), "policy_version")?, 2.0)
        || !is_str(prop(Some(&starter), "ruleset_id")?, "dnd_5e_2014")
        || length_or_nan(starter_classes) != 12.0
    {
        problems.push("2014 starter equipment v2 must cover 12 classes".into());
    }
    let mut class_ids = JsSet::default();
    let mut starter_choice_groups = 0;
    for profile in iterate_nullish(starter_classes)? {
        let class_id = prop(Some(&profile), "class_id")?;
        if class_ids.has(class_id) {
            problems.push(format!("duplicate 2014 starter class {}", tpl(class_id)));
        }
        class_ids.add(class_id);
        let mut group_ids = JsSet::default();
        for item in iterate_nullish(profile.get("legacy_default_items"))? {
            if !item_known(&item, "catalog_id")? {
                problems.push(format!("unknown legacy starter item {}", tpl(item.get("catalog_id"))));
            }
        }
        for item in iterate_nullish(profile.get("fixed_items"))? {
            if !item_known(&item, "catalog_id")? {
                problems.push(format!("unknown starter item {}", tpl(item.get("catalog_id"))));
            }
        }
        for group in iterate_nullish(profile.get("choice_groups"))? {
            starter_choice_groups += 1;
            let group_id = prop(Some(&group), "id")?;
            if !js::truthy(group_id) || group_ids.has(group_id) {
                problems.push(format!("invalid starter choice group {}:{}", tpl(class_id), tpl(group_id)));
            }
            group_ids.add(group_id);
            let mut option_ids = JsSet::default();
            let options = group.get("options");
            if options_short(options, group.get("count")) {
                problems.push(format!("empty starter choice group {}:{}", tpl(class_id), tpl(group_id)));
            }
            for option in iterate_nullish(options)? {
                let option_id = prop(Some(&option), "id")?;
                if !js::truthy(option_id) || option_ids.has(option_id) {
                    problems.push(format!("duplicate starter option {}:{}:{}", tpl(class_id), tpl(group_id), tpl(option_id)));
                }
                option_ids.add(option_id);
                for item in iterate_nullish(option.get("items"))? {
                    if !item_known(&item, "catalog_id")? {
                        problems.push(format!("unknown starter item {}", tpl(item.get("catalog_id"))));
                    }
                }
            }
        }
    }
    let mut species_choice_groups = 0;
    for species in iterate(classic_origins.get("species_options"))? {
        let mut group_ids = JsSet::default();
        for group in iterate_nullish(species.get("choice_groups"))? {
            species_choice_groups += 1;
            let group_id = prop(Some(&group), "id")?;
            let options = group.get("options");
            if !js::truthy(group_id) || group_ids.has(group_id) || options_short(options, group.get("count")) {
                problems.push(format!("invalid species choice group {}:{}", tpl(species.get("id")), tpl(group_id)));
            }
            group_ids.add(group_id);
            let mut option_ids = Vec::new();
            for option in array_method(options)? {
                option_ids.push(js::string(prop(Some(option), "id")?));
            }
            let mut unique = option_ids.clone();
            unique.sort();
            unique.dedup();
            if unique.len() != option_ids.len() {
                problems.push(format!("duplicate species option {}:{}", tpl(species.get("id")), tpl(group_id)));
            }
            if is_str(group.get("kind"), "cantrip") {
                for spell_id in &option_ids {
                    let spell = sk_combat_content::combat_spells::canonical_combat_spell_for(Some(&Value::String(spell_id.clone())), None);
                    let valid = spell.as_ref().is_some_and(|spell| {
                        is_num(spell.get("level"), 0.0) && spell.get("classes").and_then(Value::as_array).is_some_and(|classes| classes.iter().any(|class| class == "wizard"))
                    });
                    if !valid {
                        problems.push(format!("invalid species cantrip {}:{spell_id}", tpl(species.get("id"))));
                    }
                }
            }
        }
    }
    for background in iterate_nullish(prop(Some(&classic_backgrounds), "backgrounds")?)? {
        let equipment = prop(Some(&background), "equipment")?;
        for item in iterate_nullish(opt_prop(equipment, "catalogItems"))? {
            if !item_known(&item, "catalogId")? {
                problems.push(format!("unknown background item {}", tpl(item.get("catalogId"))));
            }
        }
    }
    if !problems.is_empty() {
        return Err(ContentIntegrityError::new(format!("Character creation catalog integrity failed: {}", problems.join("; ")), "CHARACTER_CREATION_CATALOG_INVALID")
            .with("problems", json!(problems))
            .into());
    }
    let field = |value: Option<&Value>, key: &str| opt_prop(value, key).cloned().unwrap_or(Value::Null);
    let modern_backgrounds = backgrounds.get("srd_5_2_1");
    Ok(json!({
        "dnd_5e_2014": {
            "species_options": field(classic, "species_options"),
            "backgrounds": field(classic_backgrounds_info, "backgrounds"),
            "classes_with_starter_equipment": js::num(length(starter_classes)?),
            "species_choice_groups": species_choice_groups,
            "starter_choice_groups": starter_choice_groups,
            "bonus_source": field(classic, "bonus_source"),
        },
        "srd_5_2_1": {
            "species_options": field(modern, "species_options"),
            "backgrounds": field(modern_backgrounds, "backgrounds"),
            "bonus_source": field(modern, "bonus_source"),
        },
    }))
}

/// `!Array.isArray(options) || options.length < Number(count ?? 0)`; при
/// `NaN` сравнение ложно.
fn options_short(options: Option<&Value>, count: Option<&Value>) -> bool {
    let needed = match count {
        None | Some(Value::Null) => 0.0,
        other => js::number(other),
    };
    match options {
        Some(Value::Array(items)) => (items.len() as f64) < needed,
        _ => true,
    }
}

fn runtime_coverage_counts(root: &LexPath, rule_pack: &Value) -> Result<Vec<(&'static str, f64)>> {
    let actions = read_json(&project_file(root, "data/dndsu-class-actions-1-12.json")?)?;
    let classes = sk_combat_content::combat_actions::combat_class_catalog_info();
    let spells = sk_combat_content::combat_spells::spell_catalog_info(None);
    Ok(vec![
        ("classes", length_or_nan(classes.get("classes"))),
        ("subclasses", sum_lengths(array_method(prop(Some(&actions), "classes")?)?, "subclasses")?),
        ("spells", js::number(spells.get("count"))),
        ("monsters", sk_encounters::encounter_assembler::SRD_5_2_1_MONSTER_ALLOWLIST.as_object().map_or(0, Map::len) as f64),
        ("equipment", sk_items::item_catalog::item_catalog().len() as f64),
        ("commerce_equipment", sk_items::item_catalog::ITEM_SHOP_CATALOG_IDS.len() as f64),
        ("feats", 0.0),
        ("glossary", length_or_nan(rule_pack.get("glossary"))),
    ])
}

fn validate_coverage_matrix(matrix: &Value, counts: &[(&'static str, f64)]) -> Result<Vec<Value>> {
    let categories = prop(Some(matrix), "categories")?;
    let Some(Value::Array(categories)) = categories.filter(|_| is_num(matrix.get("schema_version"), 1.0)) else {
        return fail("Rules coverage matrix has an unsupported shape", "COVERAGE_MATRIX_INVALID");
    };
    let count_of = |key: &str| counts.iter().find(|(name, _)| *name == key).map(|(_, count)| *count);
    let mut seen = JsSet::default();
    let mut result = Vec::new();
    for category in categories {
        let id = prop(Some(category), "id")?;
        if !js::truthy(id) || seen.has(id) {
            return fail(format!("Invalid or duplicate coverage category {}", tpl(id)), "COVERAGE_MATRIX_INVALID");
        }
        seen.add(id);
        let coverage = category.get("coverage");
        if !COVERAGE.iter().any(|state| is_str(coverage, state)) {
            return fail(format!("Unknown coverage state for {}", tpl(id)), "COVERAGE_MATRIX_INVALID");
        }
        let key = tpl(id);
        let count = count_of(&key);
        if count.is_none() && !PROTOTYPE_KEYS.contains(&key.as_str()) {
            return fail(format!("Coverage category {key} has no runtime counter"), "COVERAGE_MATRIX_INVALID");
        }
        let expected = category.get("expected_count");
        match count {
            Some(count) if js::number(expected) == count => {}
            Some(count) => {
                return fail(format!("Coverage count mismatch for {key}: expected {}, runtime {}", tpl(expected), js::f64_string(count)), "COVERAGE_MATRIX_COUNT_MISMATCH");
            }
            None => {
                return fail(format!("Coverage count mismatch for {key}: expected {}, runtime {}", tpl(expected), prototype_value_string(&key)), "COVERAGE_MATRIX_COUNT_MISMATCH");
            }
        }
        result.push(json!({
            "id": id,
            "coverage": coverage,
            "count": js::num(count.unwrap_or(f64::NAN)),
            "mandatory_for_release": js::is_true(category.get("mandatory_for_release")),
        }));
    }
    Ok(result)
}

fn assert_attribution(root: &LexPath) -> Result<()> {
    let bytes = read_bytes(&project_file(root, "ATTRIBUTION.md")?)?;
    let attribution = String::from_utf8_lossy(&bytes);
    let missing: Vec<&str> = ATTRIBUTION_NOTICES.into_iter().filter(|text| !attribution.contains(text)).collect();
    if !missing.is_empty() {
        return fail(format!("ATTRIBUTION.md misses required notices: {}", missing.join(", ")), "ATTRIBUTION_MISSING");
    }
    Ok(())
}

/// `[...set].sort()`: по строковому виду в единицах UTF-16.
fn sorted_values(set: JsSet) -> Vec<Value> {
    let mut values: Vec<Value> = set.items.into_iter().map(|item| item.unwrap_or(Value::Null)).collect();
    values.sort_by(|a, b| utf16_cmp(&js::string(Some(a)), &js::string(Some(b))));
    values
}

fn is_released_rights(value: Option<&Value>) -> bool {
    is_str(value, "verified") || is_str(value, "cleared")
}

/// `verifyContentIntegrity({ rootDir })`: полный отчёт целостности и гейт
/// выпуска для корня проекта.
pub fn verify_content_integrity(root_dir: &Path) -> Result<Value> {
    let root = LexPath::absolute(root_dir);
    let provenance = read_json(&project_file(&root, "data/content-provenance.json")?)?;
    let mut source_ids = JsSet::default();
    let sources = prop(Some(&provenance), "external_sources")?;
    if js::present(sources) {
        for source in array_method(sources)? {
            source_ids.add(prop(Some(source), "id")?);
        }
    }
    let mut artifacts = Vec::new();
    for artifact in iterate_nullish(prop(Some(&provenance), "artifacts")?)? {
        let source_id = prop(Some(&artifact), "source_id")?;
        if !source_ids.has(source_id) {
            return fail(format!("Artifact {} references unknown source {}", tpl(opt_prop(Some(&artifact), "path")), tpl(source_id)), "CONTENT_SOURCE_INVALID");
        }
        artifacts.push(verify_artifact(&root, &artifact)?);
    }
    let asset_registry = read_json(&project_file(&root, "data/asset-rights.json")?)?;
    let assets = validate_asset_registry(&root, &asset_registry)?;
    let packs_root = project_file(&root, "data/rule_packs")?.path();
    let rule_pack = load_rule_pack("srd_5_2_1", &packs_root).map_err(ContentIntegrityFailure::RulePack)?;
    let target_rule_pack = load_rule_pack("dnd_5e_2014", &packs_root).map_err(ContentIntegrityFailure::RulePack)?;
    let rule_references = validate_rule_references(&rule_pack)?;
    let target_rule_references = validate_rule_references(&target_rule_pack)?;
    let compatibility = validate_compatibility_catalogs(&root)?;
    let character_creation = validate_character_creation_catalogs(&root)?;
    let counts = runtime_coverage_counts(&root, &rule_pack)?;
    let coverage = validate_coverage_matrix(&read_json(&project_file(&root, "data/rules-coverage-matrix.json")?)?, &counts)?;
    assert_attribution(&root)?;

    let mut blockers = JsSet::default();
    for blocker in iterate_nullish(provenance.get("release_blockers"))? {
        blockers.add(Some(&blocker));
    }
    for artifact in &artifacts {
        if !is_released_rights(artifact.get("rights_status")) {
            blockers.add(Some(&Value::String(format!("RIGHTS:{}", tpl(artifact.get("path"))))));
        }
    }
    if !is_released_rights(asset_registry.get("rights_status")) || !is_str(asset_registry.get("distribution"), "allowed") {
        blockers.add(Some(&json!("RIGHTS:public/assets")));
    }
    for category in &coverage {
        if js::is_true(category.get("mandatory_for_release")) && !is_str(category.get("coverage"), "complete") {
            blockers.add(Some(&Value::String(format!("COVERAGE:{}:{}", tpl(category.get("id")), tpl(category.get("coverage"))))));
        }
    }
    let count = |key: &str| counts.iter().find(|(name, _)| *name == key).map_or(f64::NAN, |(_, count)| *count);
    let summary = |pack: &Value| pack.get("summary").cloned().unwrap_or(Value::Null);
    Ok(json!({
        "schema_version": 1,
        "integrity": {
            "ok": true,
            "artifacts": artifacts.len(),
            "assets": assets.len(),
            "rule_pack": summary(&rule_pack),
            "rule_packs": [summary(&rule_pack), summary(&target_rule_pack)],
            "rule_references": rule_references,
            "target_rule_references": target_rule_references,
            "compatibility_catalogs": compatibility,
            "character_creation_catalogs": character_creation,
            "item_catalog": {
                "entries": js::num(count("equipment")),
                "shop_entries": js::num(count("commerce_equipment")),
            },
            "coverage": coverage,
        },
        "release": {
            "ready": blockers.size() == 0,
            "blockers": sorted_values(blockers),
        },
    }))
}

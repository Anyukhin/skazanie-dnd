//! Зашифрованная копия хранилища — перенос `server/backup-service.mjs`.
//!
//! Копия — один JSON-конверт: ключ из секрета через scrypt (N=16384, r=8,
//! p=1, как `scryptSync` Node по умолчанию; соль 16 байт), шифр AES-256-GCM
//! (iv 12 байт, тег 16 байт, AAD — строка формата). Внутри — манифест с
//! содержимым файлов в base64 и их SHA-256. Формат тот же, что пишет JS:
//! копию, снятую Node, восстанавливает Rust, и наоборот.
//!
//! Аудит PR #131, RCV-05: копия снимается только с остановленного сервера.
//! Сервер объявляет себя файлом-отметкой (`claim_storage_writer`) и раз в
//! минуту обновляет в нём время; копия по умолчанию отказывает, пока отметка
//! живая (`BACKUP_WRITER_ACTIVE`), а осознанный обход — `allow_live_writer`.

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use aes_gcm::aead::{AeadInOut, KeyInit};
use aes_gcm::Aes256Gcm;
use indexmap::IndexMap;
use rand::RngCore as _;
use serde_json::{json, Map, Value};
use sk_core::js;

use crate::support::{
    atomic_write, base64_decode_lenient, base64_encode, create_exclusive, field, is_absolute_text, node_buffer_from, number, path_text, read_utf8, relative, resolve, strict_number, strict_str, stringify,
    stringify_pretty, template, utf16_cmp,
};

pub const BACKUP_SCHEMA_VERSION: i64 = 1;
pub const BACKUP_FORMAT: &str = "skazanie:encrypted-storage-backup-v1";
const MAX_FILES: usize = 100_000;
const MAX_FILE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Отметка живого сервера в корне storage (в архив не попадает).
pub const STORAGE_WRITER_MARKER: &str = ".server-writer.json";
const WRITER_HEARTBEAT_MS: u64 = 60_000;
const WRITER_STALE_MS: i64 = 5 * 60_000;

/// Ошибка сервиса копий.
#[derive(Debug, thiserror::Error)]
pub enum BackupError {
    /// `BackupError` JS: код, текст и поля, которые JS кладёт на ошибку
    /// (`writer` у `BACKUP_WRITER_ACTIVE`, итог сверки у
    /// `RESTORE_RECONCILIATION_FAILED`).
    #[error("{message}")]
    Rejected { code: &'static str, message: String, details: Map<String, Value> },
    /// Сбой файловой системы (в JS — ошибка `node:fs` без кода сервиса).
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl BackupError {
    /// `error.code` отказа сервиса.
    pub fn code(&self) -> Option<&str> {
        match self {
            BackupError::Rejected { code, .. } => Some(code),
            BackupError::Io(_) => None,
        }
    }

    /// Поля отказа.
    pub fn details(&self) -> Option<&Map<String, Value>> {
        match self {
            BackupError::Rejected { details, .. } => Some(details),
            BackupError::Io(_) => None,
        }
    }
}

fn backup_error(code: &'static str, message: impl Into<String>) -> BackupError {
    BackupError::Rejected { code, message: message.into(), details: Map::new() }
}

// ---------------------------------------------------------------------------
// Машина и процесс
// ---------------------------------------------------------------------------

/// `os.hostname()`: DNS-имя машины, как его отдаёт Node (на Windows —
/// `GetComputerNameExW(ComputerNameDnsHostname)`, регистр сохраняется).
pub fn hostname() -> String {
    platform::hostname()
}

/// `process.kill(pid, 0)` без исключения: процесс есть (в том числе чужой —
/// `EPERM`) или нет.
pub fn process_alive(pid: i64) -> bool {
    // `process.kill` принимает только int32; иное — `ERR_INVALID_ARG_TYPE`.
    if pid != i64::from(pid as i32) {
        return false;
    }
    platform::process_alive(pid as i32)
}

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED, STILL_ACTIVE, WAIT_TIMEOUT};
    use windows_sys::Win32::System::SystemInformation::{ComputerNameDnsHostname, GetComputerNameExW};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetExitCodeProcess, OpenProcess, WaitForSingleObject, PROCESS_QUERY_INFORMATION, PROCESS_TERMINATE, PROCESS_SYNCHRONIZE};

    pub(super) fn hostname() -> String {
        let mut size: u32 = 0;
        // SAFETY: первый вызов с пустым буфером только сообщает нужный размер.
        unsafe { GetComputerNameExW(ComputerNameDnsHostname, std::ptr::null_mut(), &mut size) };
        let mut buffer = vec![0u16; size as usize + 1];
        let mut length = buffer.len() as u32;
        // SAFETY: буфер длиной `length` символов принадлежит нам.
        let ok = unsafe { GetComputerNameExW(ComputerNameDnsHostname, buffer.as_mut_ptr(), &mut length) };
        if ok == 0 {
            return std::env::var("COMPUTERNAME").unwrap_or_default();
        }
        String::from_utf16_lossy(&buffer[..length as usize])
    }

    /// `uv_kill(pid, 0)` libuv: открыть процесс, проверить код выхода и
    /// сигнальность; отказ в доступе — процесс есть.
    pub(super) fn process_alive(pid: i32) -> bool {
        // SAFETY: вызовы Win32 с проверкой результата; дескриптор закрывается.
        unsafe {
            let handle = if pid == 0 { GetCurrentProcess() } else { OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_INFORMATION | PROCESS_SYNCHRONIZE, 0, pid as u32) };
            if handle.is_null() {
                return GetLastError() == ERROR_ACCESS_DENIED;
            }
            let mut status: u32 = 0;
            let alive = if GetExitCodeProcess(handle, &mut status) == 0 {
                GetLastError() == ERROR_ACCESS_DENIED
            } else {
                status == STILL_ACTIVE as u32 && WaitForSingleObject(handle, 0) == WAIT_TIMEOUT
            };
            if pid != 0 {
                CloseHandle(handle);
            }
            alive
        }
    }
}

#[cfg(unix)]
mod platform {
    pub(super) fn hostname() -> String {
        let mut buffer = vec![0u8; 256];
        // SAFETY: буфер принадлежит нам, длина передана.
        let result = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) };
        if result != 0 {
            return String::new();
        }
        let end = buffer.iter().position(|byte| *byte == 0).unwrap_or(buffer.len());
        String::from_utf8_lossy(&buffer[..end]).into_owned()
    }

    pub(super) fn process_alive(pid: i32) -> bool {
        // SAFETY: сигнал 0 только проверяет существование процесса.
        let result = unsafe { libc::kill(pid, 0) };
        result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}

#[cfg(not(any(windows, unix)))]
mod platform {
    pub(super) fn hostname() -> String {
        String::new()
    }

    pub(super) fn process_alive(_pid: i32) -> bool {
        true
    }
}

// ---------------------------------------------------------------------------
// Отметка пишущего сервера
// ---------------------------------------------------------------------------

fn marker_file(storage_dir: &Path) -> PathBuf {
    resolve(storage_dir).join(STORAGE_WRITER_MARKER)
}

/// Настройки `claimStorageWriter(storageDir, { heartbeatMs, now })`.
pub struct ClaimWriterOptions {
    pub heartbeat_ms: u64,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl Default for ClaimWriterOptions {
    fn default() -> Self {
        Self { heartbeat_ms: WRITER_HEARTBEAT_MS, now: Arc::new(sk_core::clock::now_ms) }
    }
}

/// Отметка этого процесса (`{ file, writer_id, release }`). Снимается
/// `release()` или при уничтожении — как `process.once('exit', release)` в
/// `server/index.mjs`.
#[must_use = "отметка снимается, как только значение уничтожено"]
pub struct StorageWriterClaim {
    pub file: PathBuf,
    pub writer_id: String,
    stop: Option<mpsc::Sender<()>>,
    heartbeat: Option<JoinHandle<()>>,
}

impl StorageWriterClaim {
    /// Удаляет отметку, только если она всё ещё своя: новый сервер на том же
    /// каталоге мог уже переписать её.
    pub fn release(&mut self) {
        let Some(stop) = self.stop.take() else { return };
        drop(stop);
        if let Some(heartbeat) = self.heartbeat.take() {
            let _ = heartbeat.join();
        }
        let own = read_utf8(&self.file).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok()).is_some_and(|marker| strict_str(marker.get("writer_id"), &self.writer_id));
        if own {
            let _ = fs::remove_file(&self.file);
        }
    }
}

impl Drop for StorageWriterClaim {
    fn drop(&mut self) {
        self.release();
    }
}

/// Объявляет текущий процесс писателем storage.
pub fn claim_storage_writer(storage_dir: &Path, options: ClaimWriterOptions) -> Result<StorageWriterClaim, BackupError> {
    let file = marker_file(storage_dir);
    let now = options.now;
    let identity = json!({
        "schema_version": 1,
        "writer_id": sk_core::hash::uuid_v4(),
        "pid": std::process::id(),
        "host": hostname(),
        "started_at": sk_core::clock::iso(now()),
    });
    let writer_id = js::s(identity.get("writer_id"));
    let write = {
        let file = file.clone();
        move || -> std::io::Result<()> {
            let marker = js::spread(&identity, json!({ "heartbeat_at": sk_core::clock::iso(now()) }));
            atomic_write(&file, format!("{}\n", stringify_pretty(&marker)).as_bytes())
        }
    };
    write()?;
    let (stop, stopped) = mpsc::channel::<()>();
    let interval = Duration::from_millis(options.heartbeat_ms.max(1));
    let heartbeat = std::thread::spawn(move || {
        // Пропуск такта не опасен: отметка устареет только после нескольких подряд.
        while let Err(mpsc::RecvTimeoutError::Timeout) = stopped.recv_timeout(interval) {
            let _ = write();
        }
    });
    Ok(StorageWriterClaim { file, writer_id, stop: Some(stop), heartbeat: Some(heartbeat) })
}

/// Настройки `inspectStorageWriter(storageDir, { now, host, isProcessAlive, staleAfterMs })`.
pub struct InspectWriterOptions {
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub host: Option<String>,
    pub is_process_alive: Arc<dyn Fn(i64) -> bool + Send + Sync>,
    pub stale_after_ms: i64,
}

impl Default for InspectWriterOptions {
    fn default() -> Self {
        Self { now: Arc::new(sk_core::clock::now_ms), host: None, is_process_alive: Arc::new(process_alive), stale_after_ms: WRITER_STALE_MS }
    }
}

/// Состояние отметки писателя: `absent` — сервера нет, `stale` — отметка
/// осталась от остановленного сервера, `live` — сервер пишет прямо сейчас.
pub fn inspect_storage_writer(storage_dir: &Path, options: &InspectWriterOptions) -> Result<Value, BackupError> {
    let file = marker_file(storage_dir);
    if !file.exists() {
        return Ok(json!({ "state": "absent", "marker_file": path_text(&file) }));
    }
    // Нечитаемую отметку судим по времени файла.
    let marker = read_utf8(&file).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let declared = sk_core::clock::parse_iso(&js::s(field(marker.as_ref(), "heartbeat_at")));
    let heartbeat = match declared {
        Some(ms) => ms,
        None => {
            let modified = fs::metadata(&file)?.modified()?;
            match modified.duration_since(std::time::UNIX_EPOCH) {
                Ok(duration) => duration.as_millis() as i64,
                Err(error) => -(error.duration().as_millis() as i64),
            }
        }
    };
    let pid = number(field(marker.as_ref(), "pid"));
    let safe_pid = pid.is_finite() && pid.fract() == 0.0 && pid.abs() <= 9_007_199_254_740_991.0;
    let mut details = Map::new();
    details.insert("marker_file".into(), Value::String(path_text(&file)));
    details.insert("pid".into(), if safe_pid { Value::from(pid as i64) } else { Value::Null });
    details.insert("host".into(), field(marker.as_ref(), "host").cloned().unwrap_or(Value::Null));
    details.insert("started_at".into(), field(marker.as_ref(), "started_at").cloned().unwrap_or(Value::Null));
    details.insert("heartbeat_at".into(), Value::String(sk_core::clock::iso(heartbeat)));
    let with_state = |state: &str, reason: Option<&str>| {
        let mut result = Map::new();
        result.insert("state".into(), Value::String(state.into()));
        if let Some(reason) = reason {
            result.insert("reason".into(), Value::String(reason.into()));
        }
        result.extend(details.clone());
        Value::Object(result)
    };
    if (options.now)() - heartbeat > options.stale_after_ms {
        return Ok(with_state("stale", Some("heartbeat_expired")));
    }
    let host = options.host.clone().unwrap_or_else(hostname);
    if strict_str(field(marker.as_ref(), "host"), &host) && safe_pid && pid > 0.0 && !(options.is_process_alive)(pid as i64) {
        return Ok(with_state("stale", Some("process_not_running")));
    }
    Ok(with_state("live", None))
}

// ---------------------------------------------------------------------------
// Файлы и конверт
// ---------------------------------------------------------------------------

fn sha256(bytes: &[u8]) -> String {
    sk_core::hash::sha256_hex(bytes)
}

fn require_secret(secret: &str) -> Result<&str, BackupError> {
    if secret.len() < 32 {
        return Err(backup_error("BACKUP_SECRET_TOO_SHORT", "Backup secret must contain at least 32 UTF-8 bytes"));
    }
    Ok(secret)
}

/// `safeRelativePath(value)`: `/`-путь без пустых сегментов, `.` и `..`.
fn safe_relative_path(value: Option<&Value>) -> Result<String, BackupError> {
    let path = js::s(value).replace('\\', "/");
    if path.is_empty() || path.starts_with('/') || path.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
        return Err(backup_error("BACKUP_PATH_INVALID", format!("Unsafe backup entry path: {}", template(value))));
    }
    Ok(path)
}

fn safe_child(root_dir: &Path, relative_path: &str) -> Result<PathBuf, BackupError> {
    let root = resolve(root_dir);
    let path = safe_relative_path(Some(&Value::String(relative_path.into())))?;
    let absolute = resolve(&root.join(&path));
    let rel = relative(&root, &absolute);
    let separator = std::path::MAIN_SEPARATOR_STR;
    if rel.is_empty() || rel.starts_with("..") || rel.contains(&format!("..{separator}")) || is_absolute_text(&rel) {
        return Err(backup_error("BACKUP_PATH_INVALID", format!("Backup entry escapes target: {relative_path}")));
    }
    Ok(absolute)
}

struct CollectedFile {
    absolute: PathBuf,
    path: String,
    size: u64,
}

fn collect_files(root_dir: &Path, directory: &Path, prefix: &str) -> Result<Vec<CollectedFile>, BackupError> {
    let mut result = Vec::new();
    let mut names: Vec<String> = fs::read_dir(directory)?.map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().into_owned())).collect::<Result<_, _>>()?;
    names.sort_by(|left, right| utf16_cmp(left, right));
    for name in names {
        if name.ends_with(".tmp") || name.contains(".tmp.") {
            continue;
        }
        // Отметка живого сервера — состояние процесса, а не данные: восстановленный
        // каталог не должен выглядеть занятым чужим pid.
        if prefix.is_empty() && name == STORAGE_WRITER_MARKER {
            continue;
        }
        let absolute = directory.join(&name);
        let relative_path = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        let stat = fs::symlink_metadata(&absolute)?;
        if stat.file_type().is_symlink() {
            return Err(backup_error("BACKUP_SYMLINK_FORBIDDEN", format!("Symbolic links are not allowed in backups: {relative_path}")));
        }
        if stat.is_dir() {
            result.extend(collect_files(root_dir, &absolute, &relative_path)?);
        } else if stat.is_file() {
            let path = safe_relative_path(Some(&Value::String(relative_path)))?;
            result.push(CollectedFile { absolute, path, size: stat.len() });
        } else {
            return Err(backup_error("BACKUP_ENTRY_UNSUPPORTED", format!("Unsupported filesystem entry: {relative_path}")));
        }
        if result.len() > MAX_FILES {
            return Err(backup_error("BACKUP_LIMIT_EXCEEDED", format!("Backup exceeds {MAX_FILES} files")));
        }
    }
    Ok(result)
}

fn derive_key(secret: &str, salt: &[u8]) -> Result<[u8; 32], BackupError> {
    let secret = require_secret(secret)?;
    let mut key = [0u8; 32];
    let params = scrypt::Params::new(14, 8, 1).map_err(|_| backup_error("BACKUP_AUTHENTICATION_FAILED", "Backup authentication or decryption failed"))?;
    scrypt::scrypt(secret.as_bytes(), salt, &params, &mut key).map_err(|_| backup_error("BACKUP_AUTHENTICATION_FAILED", "Backup authentication or decryption failed"))?;
    Ok(key)
}

fn encrypted_envelope(payload: &Value, secret: &str) -> Result<Value, BackupError> {
    let mut salt = [0u8; 16];
    let mut iv = [0u8; 12];
    rand::rng().fill_bytes(&mut salt);
    rand::rng().fill_bytes(&mut iv);
    let key = derive_key(secret, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| backup_error("BACKUP_ERROR", "Backup key has an invalid length"))?;
    let nonce = aes_gcm::aead::Nonce::<Aes256Gcm>::from(iv);
    let mut buffer = stringify(payload).into_bytes();
    let tag = cipher
        .encrypt_inout_detached(&nonce, BACKUP_FORMAT.as_bytes(), buffer.as_mut_slice().into())
        .map_err(|_| backup_error("BACKUP_ERROR", "Backup encryption failed"))?;
    Ok(json!({
        "schema_version": BACKUP_SCHEMA_VERSION,
        "format": BACKUP_FORMAT,
        "kdf": { "name": "scrypt", "salt": base64_encode(&salt) },
        "cipher": { "name": "aes-256-gcm", "iv": base64_encode(&iv), "tag": base64_encode(tag.as_slice()) },
        "ciphertext": base64_encode(&buffer),
    }))
}

fn authentication_failed() -> BackupError {
    backup_error("BACKUP_AUTHENTICATION_FAILED", "Backup authentication or decryption failed")
}

fn decode_envelope(source: &[u8], secret: &str) -> Result<Value, BackupError> {
    let envelope: Value = serde_json::from_str(&String::from_utf8_lossy(source)).map_err(|_| backup_error("BACKUP_ENVELOPE_INVALID", "Backup envelope is not valid JSON"))?;
    if !strict_number(envelope.get("schema_version"), BACKUP_SCHEMA_VERSION as f64)
        || !strict_str(envelope.get("format"), BACKUP_FORMAT)
        || !strict_str(field(envelope.get("kdf"), "name"), "scrypt")
        || !strict_str(field(envelope.get("cipher"), "name"), "aes-256-gcm")
    {
        return Err(backup_error("BACKUP_ENVELOPE_INVALID", "Backup envelope has an unsupported format"));
    }
    let bytes = |value: Option<&Value>| node_buffer_from(value).ok_or_else(authentication_failed);
    let salt = bytes(field(envelope.get("kdf"), "salt"))?;
    let iv = bytes(field(envelope.get("cipher"), "iv"))?;
    let tag = bytes(field(envelope.get("cipher"), "tag"))?;
    let mut ciphertext = bytes(envelope.get("ciphertext"))?;
    if salt.len() != 16 || iv.len() != 12 || tag.len() != 16 || ciphertext.is_empty() {
        return Err(authentication_failed());
    }
    let key = derive_key(secret, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| authentication_failed())?;
    let nonce = aes_gcm::aead::Nonce::<Aes256Gcm>::try_from(iv.as_slice()).map_err(|_| authentication_failed())?;
    let tag = aes_gcm::aead::Tag::<Aes256Gcm>::try_from(tag.as_slice()).map_err(|_| authentication_failed())?;
    cipher.decrypt_inout_detached(&nonce, BACKUP_FORMAT.as_bytes(), ciphertext.as_mut_slice().into(), &tag).map_err(|_| authentication_failed())?;
    serde_json::from_str(&String::from_utf8_lossy(&ciphertext)).map_err(|_| authentication_failed())
}

fn is_safe_integer_value(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Number(number)) if number.as_f64().is_some_and(|float| float.fract() == 0.0 && float.abs() <= 9_007_199_254_740_991.0))
}

fn is_sha256_hex(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn entry_bytes(entry: &Value) -> Vec<u8> {
    base64_decode_lenient(&js::s(field(Some(entry), "data")))
}

fn validate_payload(payload: &Value) -> Result<(), BackupError> {
    let files = match payload.get("files") {
        Some(Value::Array(files)) if strict_number(payload.get("schema_version"), BACKUP_SCHEMA_VERSION as f64) && strict_str(payload.get("format"), BACKUP_FORMAT) => files,
        _ => return Err(backup_error("BACKUP_PAYLOAD_INVALID", "Decrypted backup payload has an unsupported shape")),
    };
    if files.len() > MAX_FILES {
        return Err(backup_error("BACKUP_LIMIT_EXCEEDED", "Backup contains too many files"));
    }
    let mut seen = std::collections::HashSet::new();
    let mut total_bytes: u64 = 0;
    for entry in files {
        let path = safe_relative_path(field(Some(entry), "path"))?;
        if !seen.insert(path.clone()) {
            return Err(backup_error("BACKUP_PAYLOAD_INVALID", format!("Duplicate backup entry: {path}")));
        }
        let bytes = entry_bytes(entry);
        let size = field(Some(entry), "size_bytes");
        let size_number = number(size);
        if !is_safe_integer_value(size) || size_number < 0.0 || size_number > MAX_FILE_BYTES as f64 || bytes.len() as f64 != size_number {
            return Err(backup_error("BACKUP_PAYLOAD_INVALID", format!("Invalid size for backup entry {path}")));
        }
        let hash = field(Some(entry), "sha256");
        if !is_sha256_hex(&js::s(hash)) || !strict_str(hash, &sha256(&bytes)) {
            return Err(backup_error("BACKUP_HASH_MISMATCH", format!("Hash mismatch for backup entry {path}")));
        }
        total_bytes += bytes.len() as u64;
        if total_bytes > MAX_TOTAL_BYTES {
            return Err(backup_error("BACKUP_LIMIT_EXCEEDED", "Backup exceeds the total size limit"));
        }
    }
    if number(payload.get("total_bytes")) != total_bytes as f64 || number(payload.get("file_count")) != files.len() as f64 {
        return Err(backup_error("BACKUP_PAYLOAD_INVALID", "Backup manifest totals do not match its entries"));
    }
    Ok(())
}

fn read_verified_backup(backup_file: &Path, secret: &str) -> Result<Value, BackupError> {
    let source = fs::read(resolve(backup_file)).map_err(|_| backup_error("BACKUP_NOT_FOUND", format!("Backup file does not exist: {}", backup_file.display())))?;
    let payload = decode_envelope(&source, secret)?;
    validate_payload(&payload)?;
    Ok(payload)
}

fn payload_files(payload: &Value) -> &[Value] {
    payload.get("files").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

// ---------------------------------------------------------------------------
// Создание, проверка, сверка, восстановление
// ---------------------------------------------------------------------------

/// Настройки `createStorageBackup({ sourceDir, backupFile, secret, now, allowLiveWriter })`.
pub struct CreateBackupOptions {
    pub source_dir: PathBuf,
    pub backup_file: PathBuf,
    pub secret: String,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub allow_live_writer: bool,
}

impl CreateBackupOptions {
    pub fn new(source_dir: impl Into<PathBuf>, backup_file: impl Into<PathBuf>, secret: impl Into<String>) -> Self {
        Self { source_dir: source_dir.into(), backup_file: backup_file.into(), secret: secret.into(), now: Arc::new(sk_core::clock::now_ms), allow_live_writer: false }
    }
}

fn writer_active(writer: &Value) -> BackupError {
    let pid = match writer.get("pid") {
        Some(value) if !value.is_null() => js::s(Some(value)),
        _ => "?".into(),
    };
    let host = match writer.get("host") {
        Some(value) if !value.is_null() => template(Some(value)),
        _ => "?".into(),
    };
    let mut details = Map::new();
    details.insert("writer".into(), writer.clone());
    BackupError::Rejected {
        code: "BACKUP_WRITER_ACTIVE",
        message: format!("Storage is in use by a running server (pid {pid} on {host}); stop it before taking a backup"),
        details,
    }
}

/// `createStorageBackup(...)`: зашифрованная копия каталога в новый файл.
pub fn create_storage_backup(options: &CreateBackupOptions) -> Result<Value, BackupError> {
    let source = resolve(&options.source_dir);
    let output = resolve(&options.backup_file);
    let is_directory = fs::symlink_metadata(&source).map(|meta| meta.is_dir()).unwrap_or(false);
    if !source.exists() || !is_directory {
        return Err(backup_error("BACKUP_SOURCE_INVALID", format!("Storage directory does not exist: {}", source.display())));
    }
    let relative_output = relative(&source, &output);
    if !relative_output.is_empty() && !relative_output.starts_with("..") && !is_absolute_text(&relative_output) {
        return Err(backup_error("BACKUP_TARGET_INSIDE_SOURCE", "Backup file must be outside the storage directory"));
    }
    if output.exists() {
        return Err(backup_error("BACKUP_ALREADY_EXISTS", format!("Backup file already exists: {}", output.display())));
    }
    // Аудит PR #131, RCV-05: копия с живого сервера может быть несогласованной,
    // поэтому по умолчанию она не снимается. Осознанный обход — `allow_live_writer`.
    let inspect = InspectWriterOptions::default();
    let writer = inspect_storage_writer(&source, &inspect)?;
    let state = js::s(writer.get("state"));
    if state == "live" && !options.allow_live_writer {
        return Err(writer_active(&writer));
    }
    let files = collect_files(&source, &source, "")?;
    let mut total_bytes: u64 = 0;
    let mut entries = Vec::with_capacity(files.len());
    for file in &files {
        if file.size > MAX_FILE_BYTES {
            return Err(backup_error("BACKUP_LIMIT_EXCEEDED", format!("File exceeds backup limit: {}", file.path)));
        }
        let bytes = fs::read(&file.absolute)?;
        total_bytes += bytes.len() as u64;
        if total_bytes > MAX_TOTAL_BYTES {
            return Err(backup_error("BACKUP_LIMIT_EXCEEDED", "Backup exceeds the total size limit"));
        }
        entries.push(json!({ "path": file.path, "size_bytes": bytes.len(), "sha256": sha256(&bytes), "data": base64_encode(&bytes) }));
    }
    // Сервер мог подняться, пока файлы читались: такая копия уже не с покоя.
    if !options.allow_live_writer {
        let after = inspect_storage_writer(&source, &inspect)?;
        if strict_str(after.get("state"), "live") {
            return Err(writer_active(&after));
        }
    }
    let created_at = sk_core::clock::iso((options.now)());
    let file_count = entries.len();
    let payload = json!({
        "schema_version": BACKUP_SCHEMA_VERSION,
        "format": BACKUP_FORMAT,
        "created_at": created_at,
        "file_count": file_count,
        "total_bytes": total_bytes,
        "files": entries,
    });
    let envelope = encrypted_envelope(&payload, &options.secret)?;
    atomic_write(&output, format!("{}\n", stringify_pretty(&envelope)).as_bytes())?;
    // Что знала копия о сервере в момент снятия. `live` бывает только при
    // явном обходе, и тогда согласованность архива не гарантируется.
    let writer_summary = if state == "absent" {
        json!({ "state": "absent" })
    } else {
        let mut summary = Map::new();
        summary.insert("state".into(), Value::String(state.clone()));
        if let Some(reason) = writer.get("reason").filter(|reason| js::truthy(Some(reason))) {
            summary.insert("reason".into(), reason.clone());
        }
        for key in ["pid", "host", "heartbeat_at"] {
            if let Some(value) = writer.get(key) {
                summary.insert(key.into(), value.clone());
            }
        }
        Value::Object(summary)
    };
    let mut result = Map::new();
    result.insert("backup_file".into(), Value::String(path_text(&output)));
    result.insert("created_at".into(), Value::String(created_at));
    result.insert("file_count".into(), Value::from(file_count));
    result.insert("total_bytes".into(), Value::from(total_bytes));
    result.insert("encrypted".into(), Value::Bool(true));
    result.insert("writer".into(), writer_summary);
    if state == "live" {
        result.insert("consistency".into(), Value::String("not_guaranteed".into()));
    }
    Ok(Value::Object(result))
}

/// `verifyStorageBackup({ backupFile, secret })`: расшифровать и проверить манифест.
pub fn verify_storage_backup(backup_file: &Path, secret: &str) -> Result<Value, BackupError> {
    let payload = read_verified_backup(backup_file, secret)?;
    let mut result = Map::new();
    result.insert("backup_file".into(), Value::String(path_text(&resolve(backup_file))));
    for key in ["created_at", "file_count", "total_bytes"] {
        if let Some(value) = payload.get(key) {
            result.insert(key.into(), value.clone());
        }
    }
    result.insert("encrypted".into(), Value::Bool(true));
    result.insert("verified".into(), Value::Bool(true));
    Ok(Value::Object(result))
}

fn compare_with_payload(source: &Path, payload: &Value) -> Result<Value, BackupError> {
    let mut expected: IndexMap<String, &Value> = IndexMap::new();
    for entry in payload_files(payload) {
        expected.insert(js::s(field(Some(entry), "path")), entry);
    }
    let actual_files = if source.exists() { collect_files(source, source, "")? } else { Vec::new() };
    let mut actual: IndexMap<String, &CollectedFile> = IndexMap::new();
    for file in &actual_files {
        actual.insert(file.path.clone(), file);
    }
    let missing: Vec<String> = expected.keys().filter(|path| !actual.contains_key(*path)).cloned().collect();
    let unexpected: Vec<String> = actual.keys().filter(|path| !expected.contains_key(*path)).cloned().collect();
    let mut changed = Vec::new();
    for (path, entry) in &expected {
        let Some(current) = actual.get(path) else { continue };
        let differs = !strict_number(field(Some(entry), "size_bytes"), current.size as f64) || !strict_str(field(Some(entry), "sha256"), &sha256(&fs::read(&current.absolute)?));
        if differs {
            changed.push(path.clone());
        }
    }
    Ok(json!({
        "identical": missing.is_empty() && unexpected.is_empty() && changed.is_empty(),
        "missing": missing,
        "unexpected": unexpected,
        "changed": changed,
    }))
}

/// `compareStorageToBackup({ sourceDir, backupFile, secret })`: какие файлы
/// каталога пропали (`missing`), лишние (`unexpected`) и изменились (`changed`).
pub fn compare_storage_to_backup(source_dir: &Path, backup_file: &Path, secret: &str) -> Result<Value, BackupError> {
    let source = resolve(source_dir);
    let payload = read_verified_backup(backup_file, secret)?;
    compare_with_payload(&source, &payload)
}

/// `restoreStorageBackup({ backupFile, targetDir, secret })`: восстановить в
/// пустой или отсутствующий каталог и сверить результат байт в байт.
pub fn restore_storage_backup(backup_file: &Path, target_dir: &Path, secret: &str) -> Result<Value, BackupError> {
    let payload = read_verified_backup(backup_file, secret)?;
    let target = resolve(target_dir);
    if target.exists() && fs::read_dir(&target)?.next().is_some() {
        return Err(backup_error("RESTORE_TARGET_NOT_EMPTY", "Restore target must be absent or empty"));
    }
    fs::create_dir_all(&target)?;
    for entry in payload_files(&payload) {
        let output = safe_child(&target, &js::s(field(Some(entry), "path")))?;
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut handle = create_exclusive(&output)?;
        let written = handle.write_all(&entry_bytes(entry));
        drop(handle);
        written?;
    }
    let reconciliation = compare_storage_to_backup(&target, backup_file, secret)?;
    if !js::is_true(reconciliation.get("identical")) {
        return Err(BackupError::Rejected {
            code: "RESTORE_RECONCILIATION_FAILED",
            message: "Restored storage failed reconciliation".into(),
            details: reconciliation.as_object().cloned().unwrap_or_default(),
        });
    }
    let mut result = Map::new();
    result.insert("target_dir".into(), Value::String(path_text(&target)));
    for key in ["file_count", "total_bytes"] {
        if let Some(value) = payload.get(key) {
            result.insert(key.into(), value.clone());
        }
    }
    result.insert("restored".into(), Value::Bool(true));
    result.insert("reconciliation".into(), reconciliation);
    Ok(Value::Object(result))
}

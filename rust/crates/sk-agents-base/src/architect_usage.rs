//! Перенос `server/architect-usage.mjs`: счётчик живых генераций локаций
//! Архитектора сцены (задача 1.4 плана `docs/experience-upgrade-plan.md`).
//!
//! Решение владельца: в хаос-режиме локации создаются **без лимита**, но после
//! порога стол получает предупреждение о расходе. Поэтому отказа здесь нет:
//! счётчик считает и один раз за день сообщает, что расход выше обычного.
//! Считаются только генерации, дошедшие до модели (`trace.mode === 'model'`).
//!
//! Файл — тот же JSON, что пишет JS (`JSON.stringify(state, null, 2)`, запись
//! через временный файл и переименование): `{ schema_version, day, campaigns:
//! { KEY: { generations, lab_generations, alerted } } }`. Смена календарного
//! дня (UTC) обнуляет счёт; повреждённый файл — счёт заново.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Map, Value};
use sk_core::js;

use crate::js_json;

const SCHEMA_VERSION: i64 = 1;

/// `DEFAULT_ARCHITECT_ALERT_THRESHOLD`.
pub const DEFAULT_ARCHITECT_ALERT_THRESHOLD: i64 = 3;

/// Часы хранилища (`now`), миллисекунды.
pub type ArchitectClock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// `dayKey(timestamp)`: `new Date(timestamp).toISOString().slice(0, 10)`.
fn day_key(timestamp: i64) -> String {
    sk_core::clock::iso(timestamp).chars().take(10).collect()
}

/// `campaignKey(value)`: `String(value ?? '').toUpperCase()`, только
/// `[A-Z0-9-]`, не длиннее 24 символов.
pub fn campaign_key(value: &str) -> String {
    sk_core::text::upper(value).chars().filter(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || *ch == '-').take(24).collect()
}

fn empty_state(day: &str) -> Value {
    json!({ "schema_version": SCHEMA_VERSION, "day": day, "campaigns": {} })
}

fn empty_campaign() -> Map<String, Value> {
    let mut entry = Map::new();
    entry.insert("generations".into(), Value::from(0));
    entry.insert("lab_generations".into(), Value::from(0));
    entry.insert("alerted".into(), Value::Bool(false));
    entry
}

/// Счётчик: `Number(x)`, если это безопасное неотрицательное целое, иначе 0.
fn counter(value: Option<&Value>) -> i64 {
    let number = js::number(value);
    if js::is_safe_integer_number(value) && number >= 0.0 {
        number as i64
    } else {
        0
    }
}

/// `{ ...value }` для записи кампании (массив — ключами-индексами).
fn spread(value: &Value) -> Map<String, Value> {
    crate::llm_client::spread_object(value)
}

/// `atomicWrite(file, value)` из `server/store.mjs`: каталог создаётся,
/// запись — во временный файл рядом и переименование поверх.
fn atomic_write(file: &Path, value: &Value) -> std::io::Result<()> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut temporary = file.as_os_str().to_owned();
    temporary.push(format!(".{}.tmp", sk_core::hash::uuid_v4()));
    let temporary = PathBuf::from(temporary);
    std::fs::write(&temporary, js_json::stringify_pretty(value))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&temporary, file)
}

/// `recordGeneration(campaignId)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GenerationRecord {
    pub day: String,
    pub generations: i64,
    pub threshold: i64,
    /// Истинен ровно один раз за день на кампанию — на пересечении порога.
    pub alert: bool,
}

impl GenerationRecord {
    pub fn to_json(&self) -> Value {
        json!({ "day": self.day, "generations": self.generations, "threshold": self.threshold, "alert": self.alert })
    }
}

/// `ArchitectUsageStore`.
pub struct ArchitectUsageStore {
    storage_file: PathBuf,
    alert_threshold: i64,
    now: ArchitectClock,
}

impl ArchitectUsageStore {
    /// `new ArchitectUsageStore({ storageFile, alertThreshold, now })`:
    /// порог — `Number(alertThreshold)`, если это безопасное целое больше нуля,
    /// иначе [`DEFAULT_ARCHITECT_ALERT_THRESHOLD`].
    pub fn new(storage_file: impl AsRef<Path>, alert_threshold: Option<&Value>, now: Option<ArchitectClock>) -> Result<Self, String> {
        let storage_file = storage_file.as_ref();
        if storage_file.as_os_str().is_empty() {
            return Err("ArchitectUsageStore requires storageFile".into());
        }
        let threshold = js::number(alert_threshold);
        Ok(ArchitectUsageStore {
            storage_file: std::path::absolute(storage_file).unwrap_or_else(|_| storage_file.to_path_buf()),
            alert_threshold: if js::is_safe_integer_number(alert_threshold) && threshold > 0.0 { threshold as i64 } else { DEFAULT_ARCHITECT_ALERT_THRESHOLD },
            now: now.unwrap_or_else(|| Arc::new(sk_core::clock::now_ms)),
        })
    }

    pub fn storage_file(&self) -> &Path {
        &self.storage_file
    }

    /// `alertThreshold`.
    pub fn alert_threshold(&self) -> i64 {
        self.alert_threshold
    }

    /// `_read()`: состояние, приведённое к текущему дню.
    fn read(&self) -> Value {
        let today = day_key((self.now)());
        let Ok(bytes) = std::fs::read(&self.storage_file) else {
            return empty_state(&today);
        };
        // `readFileSync(file, 'utf8')`: битые байты — U+FFFD, BOM остаётся
        // (и `JSON.parse` на нём падает).
        let text = String::from_utf8_lossy(&bytes);
        let Ok(parsed) = js_json::parse(&text) else {
            return empty_state(&today);
        };
        let value = parsed.into_value();
        let campaigns_ok = matches!(value.get("campaigns"), Some(Value::Object(_)));
        if value.get("schema_version").and_then(Value::as_f64) != Some(SCHEMA_VERSION as f64) || !campaigns_ok {
            return empty_state(&today);
        }
        if value.get("day").and_then(Value::as_str) != Some(today.as_str()) {
            return empty_state(&today);
        }
        value
    }

    /// `_campaign(state, key)`: запись кампании с приведёнными счётчиками;
    /// отсутствующая заводится в `state` пустой.
    fn campaign(state: &mut Value, key: &str) -> Map<String, Value> {
        let campaigns = js::object_mut(state, "campaigns");
        match campaigns.get(key) {
            Some(entry @ (Value::Object(_) | Value::Array(_))) => {
                let mut normalized = empty_campaign();
                for (field, value) in spread(entry) {
                    normalized.insert(field, value);
                }
                normalized.insert("generations".into(), Value::from(counter(entry.get("generations"))));
                normalized.insert("lab_generations".into(), Value::from(counter(entry.get("lab_generations"))));
                normalized.insert("alerted".into(), Value::Bool(js::is_true(entry.get("alerted"))));
                normalized
            }
            _ => {
                campaigns.insert(key.to_string(), Value::Object(empty_campaign()));
                empty_campaign()
            }
        }
    }

    /// `generationsToday(campaignId)`: сколько локаций кампания создала сегодня.
    pub fn generations_today(&self, campaign_id: &str) -> i64 {
        let mut state = self.read();
        let key = campaign_key(campaign_id);
        if key.is_empty() {
            return 0;
        }
        counter(Self::campaign(&mut state, &key).get("generations"))
    }

    /// `recordGeneration(campaignId)`: одна живая генерация. Ошибка записи
    /// файла — как исключение `atomicWrite` в JS.
    pub fn record_generation(&self, campaign_id: &str) -> std::io::Result<GenerationRecord> {
        let mut state = self.read();
        let day = js::s(state.get("day"));
        let key = campaign_key(campaign_id);
        if key.is_empty() {
            return Ok(GenerationRecord { day, generations: 0, threshold: self.alert_threshold, alert: false });
        }
        let mut entry = Self::campaign(&mut state, &key);
        let generations = counter(entry.get("generations")) + 1;
        entry.insert("generations".into(), Value::from(generations));
        // Порог достигнут, когда за день создано столько локаций, сколько
        // названо порогом; предупреждение уходит один раз.
        let alert = !js::is_true(entry.get("alerted")) && generations >= self.alert_threshold;
        if alert {
            entry.insert("alerted".into(), Value::Bool(true));
        }
        js::object_mut(&mut state, "campaigns").insert(key, Value::Object(entry));
        atomic_write(&self.storage_file, &state)?;
        Ok(GenerationRecord { day, generations, threshold: self.alert_threshold, alert })
    }

    /// `report()`: разбивка по кампаниям за сегодня — для `/api/admin/usage`.
    pub fn report(&self) -> Value {
        let state = self.read();
        let mut campaigns = Map::new();
        let mut total_generations = 0.0;
        let mut total_lab_generations = 0.0;
        if let Some(Value::Object(entries)) = state.get("campaigns") {
            for (key, entry) in js::entries(entries) {
                let generations = or_zero(js::number(entry.get("generations")));
                let lab_generations = or_zero(js::number(entry.get("lab_generations")));
                total_generations += generations;
                total_lab_generations += lab_generations;
                campaigns.insert(
                    key.clone(),
                    json!({ "generations": js::num(generations), "lab_generations": js::num(lab_generations), "alerted": js::is_true(entry.get("alerted")) }),
                );
            }
        }
        json!({
            "day": state.get("day").cloned().unwrap_or(Value::Null),
            "alert_threshold": self.alert_threshold,
            "campaigns": campaigns,
            "total_generations": js::num(total_generations),
            "total_lab_generations": js::num(total_lab_generations),
        })
    }
}

/// `Number(x) || 0`.
fn or_zero(number: f64) -> f64 {
    if number.is_nan() || number == 0.0 {
        0.0
    } else {
        number
    }
}

/// `architectAlertText(generations)`: лимита нет — формулировка не пугает запретом.
pub fn architect_alert_text(generations: i64) -> String {
    format!("За сегодня создано {generations} новых локаций — расход токенов выше обычного. Ограничения нет, это только предупреждение.")
}

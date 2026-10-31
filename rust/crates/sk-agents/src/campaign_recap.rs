//! Перенос `server/campaign-recap.mjs`: рекап «В прошлой серии».
//!
//! Источник честный: сводки сцен, открытые квесты и нити, открытые обещания —
//! ничего не придумывается с нуля. Видимость — главный инвариант: материал
//! читается **только** через проекции отряда (`world_memory_for_viewer`,
//! `npc_social_for_viewer`), рекап показывается всему столу и кешируется на
//! кампанию.
//!
//! Модель только полирует текст ([`CampaignRecapService::polish`]); её
//! отсутствие, отказ или пустой ответ — не ошибка: детерминированный текст
//! ([`deterministic_recap_text`]) из тех же данных — полноценный результат.
//! Клиент модели внедряется ([`LlmClient`]); промпт — `prompts/recap/v1.txt`,
//! встроен при сборке.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Map, Value};
use sk_agents_base::llm_client::LlmClient;
use sk_core::indexmap::IndexMap;
use sk_core::{clock, js, re, text};
use sk_memory::world_memory::world_memory_for_viewer;
use sk_social::npc_social::npc_social_for_viewer;
use sk_tactics::security::build_data_only_context;
use sk_world_story::offscreen_world::OFFSCREEN_CARD_TITLE_PREFIX;

const CACHE_SCHEMA_VERSION: i64 = 1;
/// Перерыв, после которого начинается «новый вечер», в часах.
pub const DEFAULT_RECAP_GAP_HOURS: f64 = 8.0;
const RECAP_SUMMARY_LIMIT: usize = 5;
const RECAP_SUMMARY_MINIMUM: usize = 3;
const RECAP_OPEN_ITEM_LIMIT: usize = 3;
const CACHE_ENTRY_LIMIT: usize = 200;

/// `prompts/recap/v1.txt`.
pub const RECAP_PROMPT: &str = include_str!("../../../../prompts/recap/v1.txt");

/// `clean(value, maximum = 400)`: NFKC, пробелы схлопнуты, края обрезаны.
fn clean(value: Option<&Value>, maximum: usize) -> String {
    text::head(&text::squash_spaces(&text::nfkc(&js::s(value))), maximum)
}

/// `campaignKey(value)`: `[A-Z0-9-]` после `toUpperCase`, до 24 знаков.
fn campaign_key(value: Option<&Value>) -> String {
    let upper = text::upper(&js::s(value));
    text::head(&upper.chars().filter(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || *ch == '-').collect::<String>(), 24)
}

fn prop<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(Value::as_object).and_then(|map| map.get(key))
}

fn list(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

fn tail<T: Clone>(items: &[T], count: usize) -> Vec<T> {
    items[items.len().saturating_sub(count)..].to_vec()
}

/// `Math.max(0, Number(stateVersion) || 0)`.
fn version_number(value: Option<&Value>) -> f64 {
    let number = js::number(value);
    let number = if number.is_nan() || number == 0.0 { 0.0 } else { number };
    if number < 0.0 {
        0.0
    } else {
        number
    }
}

/// `atomicWrite(file, value)` из `server/store.mjs`.
fn atomic_write(file: &Path, value: &Value) -> std::io::Result<()> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut temporary = file.as_os_str().to_owned();
    temporary.push(format!(".{}.tmp", sk_core::hash::uuid_v4()));
    let temporary = PathBuf::from(temporary);
    std::fs::write(&temporary, js::stringify_pretty(value, 2))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&temporary, file)
}

/// `RecapCacheStore`: durable-кеш рекапа. Ключ — кампания и версия
/// состояния: новое событие поднимает версию, и кеш инвалидируется сам.
#[derive(Debug, Clone)]
pub struct RecapCacheStore {
    storage_file: PathBuf,
}

impl RecapCacheStore {
    /// `new RecapCacheStore({ storageFile })`.
    pub fn new(storage_file: impl AsRef<Path>) -> Self {
        let path = storage_file.as_ref();
        let absolute = if path.is_absolute() { path.to_path_buf() } else { std::env::current_dir().map(|dir| dir.join(path)).unwrap_or_else(|_| path.to_path_buf()) };
        Self { storage_file: absolute }
    }

    pub fn storage_file(&self) -> &Path {
        &self.storage_file
    }

    fn empty() -> Value {
        json!({ "schema_version": CACHE_SCHEMA_VERSION, "entries": {} })
    }

    /// `_read()`: испорченный кеш — лишний вызов модели, а не сломанный вход.
    fn read(&self) -> Value {
        let Ok(raw) = std::fs::read_to_string(&self.storage_file) else { return Self::empty() };
        let Ok(value) = serde_json::from_str::<Value>(&raw) else { return Self::empty() };
        let version_ok = value.get("schema_version").and_then(Value::as_f64) == Some(CACHE_SCHEMA_VERSION as f64);
        let entries_ok = value.get("entries").is_some_and(|entries| entries.is_object());
        if !version_ok || !entries_ok {
            return Self::empty();
        }
        value
    }

    /// `key(campaignId, stateVersion)`.
    pub fn key(&self, campaign_id: Option<&Value>, state_version: Option<&Value>) -> String {
        format!("{}:{}", campaign_key(campaign_id), js::f64_string(version_number(state_version)))
    }

    /// `get(campaignId, stateVersion)`: запись с непустым `text` или `None`.
    pub fn get(&self, campaign_id: Option<&Value>, state_version: Option<&Value>) -> Option<Value> {
        let state = self.read();
        let entry = state.get("entries").and_then(|entries| entries.get(self.key(campaign_id, state_version)))?;
        match entry.get("text") {
            Some(Value::String(text)) if !text.is_empty() && entry.is_object() => Some(entry.clone()),
            _ => None,
        }
    }

    /// `set(campaignId, stateVersion, value)`: прошлые версии той же кампании
    /// вытесняются, чужих остаётся не больше двухсот.
    pub fn set(&self, campaign_id: Option<&Value>, state_version: Option<&Value>, value: &Value) -> std::io::Result<Value> {
        let mut state = self.read();
        let key = self.key(campaign_id, state_version);
        let prefix = format!("{}:", campaign_key(campaign_id));
        let others: Vec<(String, Value)> = state
            .get("entries")
            .and_then(Value::as_object)
            .map(|entries| js::entries(entries).into_iter().filter(|(entry_key, _)| !entry_key.starts_with(&prefix)).map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default();
        let copy = Value::Object(value.as_object().cloned().unwrap_or_default());
        let mut entries = Map::new();
        for (entry_key, entry) in tail(&others, CACHE_ENTRY_LIMIT) {
            entries.insert(entry_key, entry);
        }
        entries.insert(key, copy.clone());
        if let Value::Object(map) = &mut state {
            map.insert("entries".into(), Value::Object(entries));
        }
        atomic_write(&self.storage_file, &state)?;
        Ok(copy)
    }
}

/// Зритель рекапа — всегда отряд целиком (`PARTY_VIEWER`), никогда игрок и
/// никогда админ: один текст показывается всему столу.
fn party_viewer() -> Value {
    json!({ "playerId": "", "isPartyMember": true })
}

/// `freshestByTitle(summaries)`: из повторяющейся рубрики «Пока вас не было…»
/// остаётся последняя запись — и на её месте в порядке; прочие сводки идут
/// по своему id.
fn freshest_by_title(summaries: &[Value]) -> Vec<Value> {
    let rubric = clean(Some(&Value::String(OFFSCREEN_CARD_TITLE_PREFIX.to_string())), 160);
    let mut by_title: IndexMap<String, Value> = IndexMap::new();
    for summary in summaries {
        let title = clean(prop(Some(summary), "title"), 160);
        let key = if !title.is_empty() && title.starts_with(&rubric) { format!("rubric:{title}") } else { format!("id:{}", clean(prop(Some(summary), "id"), 120)) };
        by_title.shift_remove(&key);
        by_title.insert(key, summary.clone());
    }
    by_title.into_values().collect()
}

/// `recapSources(state, viewer)`: материал рекапа в видимости зрителя
/// (по умолчанию — отряда). `viewer` `None` — отряд.
pub fn recap_sources(state: &Value, viewer: Option<&Value>) -> Value {
    let party = party_viewer();
    let viewer = viewer.unwrap_or(&party);
    let null = Value::Null;
    let memory = world_memory_for_viewer(prop(Some(state), "worldMemory").unwrap_or(&null), viewer);
    let social = npc_social_for_viewer(prop(Some(state), "social").unwrap_or(&null), viewer);
    let with_summary: Vec<Value> = list(prop(Some(&memory), "summaries")).iter().filter(|summary| !clean(prop(Some(summary), "summary"), 1_000).is_empty()).cloned().collect();
    let summaries: Vec<Value> = tail(&freshest_by_title(&with_summary), RECAP_SUMMARY_LIMIT)
        .iter()
        .map(|summary| {
            json!({
                "id": clean(prop(Some(summary), "id"), 120),
                "title": clean(prop(Some(summary), "title"), 160),
                "summary": clean(prop(Some(summary), "summary"), 1_000),
            })
        })
        .collect();
    let open_items = |source: &Value, key: &str, status: &str| -> Vec<Value> {
        let matching: Vec<Value> = list(prop(Some(source), key)).iter().filter(|item| prop(Some(item), "status").and_then(Value::as_str) == Some(status)).cloned().collect();
        tail(&matching, RECAP_OPEN_ITEM_LIMIT)
    };
    let titled = |items: Vec<Value>| -> Vec<Value> {
        items
            .iter()
            .map(|item| json!({ "title": clean(prop(Some(item), "title"), 160), "summary": clean(prop(Some(item), "summary"), 400) }))
            .filter(|item| item["title"].as_str().is_some_and(|title| !title.is_empty()))
            .collect()
    };
    let quests = titled(open_items(&memory, "quests", "active"));
    let threads = titled(open_items(&memory, "threads", "active"));
    let promises: Vec<Value> = open_items(&social, "promises", "open")
        .iter()
        .map(|entry| json!({ "text": clean(prop(Some(entry), "text"), 300), "due_hint": clean(prop(Some(entry), "due_hint"), 120) }))
        .filter(|entry| entry["text"].as_str().is_some_and(|text| !text.is_empty()))
        .collect();
    json!({ "summaries": summaries, "quests": quests, "threads": threads, "promises": promises })
}

/// `sentence(value)`: строка с точкой в конце.
fn sentence(value: &str) -> String {
    let text = clean(Some(&Value::String(value.to_string())), 400);
    if text.is_empty() {
        return String::new();
    }
    if text::test(re!(r"[.!?…]$", "u"), &text) {
        text
    } else {
        format!("{text}.")
    }
}

/// `deterministicRecapText(sources)`: рекап без модели из тех же данных.
pub fn deterministic_recap_text(sources: &Value) -> String {
    // Шаблонные строки JS печатают `undefined` и `null` словами.
    let field = |item: &Value, key: &str| js::string(prop(Some(item), key));
    let mut parts = Vec::new();
    let summaries = list(prop(Some(sources), "summaries"));
    for summary in tail(summaries, RECAP_SUMMARY_MINIMUM) {
        let title = prop(Some(&summary), "title");
        parts.push(if js::truthy(title) {
            sentence(&format!("{}: {}", field(&summary, "title"), field(&summary, "summary")))
        } else {
            sentence(&js::s(prop(Some(&summary), "summary")))
        });
    }
    let titled = |item: &Value| {
        if js::truthy(prop(Some(item), "summary")) {
            format!("{}: {}", field(item, "title"), field(item, "summary"))
        } else {
            field(item, "title")
        }
    };
    if let Some(quest) = list(prop(Some(sources), "quests")).first() {
        parts.push(sentence(&format!("Открытая цель — {}", titled(quest))));
    }
    if let Some(thread) = list(prop(Some(sources), "threads")).first() {
        parts.push(sentence(&format!("Незакрытая нить — {}", titled(thread))));
    }
    if let Some(promise) = list(prop(Some(sources), "promises")).first() {
        let due = prop(Some(promise), "due_hint");
        let due = if js::truthy(due) { format!(" ({})", js::string(due)) } else { String::new() };
        parts.push(sentence(&format!("Отряд остался должен: {}{due}", field(promise, "text"))));
    }
    parts.into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ")
}

/// Часы сервиса (`now`, миллисекунды).
pub type RecapClock = Arc<dyn Fn() -> f64 + Send + Sync>;

/// `CampaignRecapService`.
#[derive(Clone)]
pub struct CampaignRecapService {
    llm_client: Option<Arc<dyn LlmClient>>,
    cache: Option<RecapCacheStore>,
    gap_hours: f64,
    now: RecapClock,
}

impl CampaignRecapService {
    /// `new CampaignRecapService({ llmClient, cache, gapHours, now })`;
    /// `gap_hours` не положительное конечное число — 8 часов; `now` `None` —
    /// системные часы.
    pub fn new(llm_client: Option<Arc<dyn LlmClient>>, cache: Option<RecapCacheStore>, gap_hours: Option<&Value>, now: Option<RecapClock>) -> Self {
        let hours = match gap_hours {
            None => DEFAULT_RECAP_GAP_HOURS,
            some => js::number(some),
        };
        let gap_hours = if hours.is_finite() && hours > 0.0 { hours } else { DEFAULT_RECAP_GAP_HOURS };
        Self { llm_client, cache, gap_hours, now: now.unwrap_or_else(|| Arc::new(|| clock::now_ms() as f64)) }
    }

    pub fn gap_hours(&self) -> f64 {
        self.gap_hours
    }

    /// `hasGap(lastEventAt)`: перерыв достаточной длины — признак нового вечера.
    pub fn has_gap(&self, last_event_at: Option<&Value>) -> bool {
        let Some(last) = clock::parse_iso(&js::s(last_event_at)) else { return false };
        (self.now)() - last as f64 >= self.gap_hours * 3_600_000.0
    }

    /// `polish(sources)`: текст модели или `None` при отказе и пустом ответе.
    pub async fn polish(&self, sources: &Value) -> Option<String> {
        let client = self.llm_client.as_ref()?;
        let mut sections = Map::new();
        sections.insert("recap_sources".into(), sources.clone());
        let request = json!({
            "messages": [
                { "role": "system", "content": RECAP_PROMPT },
                { "role": "user", "content": build_data_only_context(Some(&Value::Object(sections))) },
            ],
            "temperature": 0.5,
            "maxTokens": 400,
        });
        let result = (**client).complete_json(&request, &json!({})).await.ok()?;
        let text = clean(prop(Some(&result), "recap"), 1_500);
        (!text.is_empty()).then_some(text)
    }

    /// `recapFor({ campaignId, state, stateVersion, lastEventAt })`:
    /// `{ recap: null, reason }` или `{ recap: { text, version, provider } }`.
    /// Ошибка записи кеша — как исключение `atomicWrite` в JS.
    pub async fn recap_for(&self, input: &Value) -> std::io::Result<Value> {
        let input = Some(input);
        let campaign_id = prop(input, "campaignId");
        let empty = Value::Object(Map::new());
        let state = prop(input, "state").unwrap_or(&empty);
        let zero = json!(0);
        let state_version = prop(input, "stateVersion").unwrap_or(&zero);
        if !self.has_gap(prop(input, "lastEventAt")) {
            return Ok(json!({ "recap": null, "reason": "no_gap" }));
        }
        let sources = recap_sources(state, None);
        if list(prop(Some(&sources), "summaries")).is_empty() {
            return Ok(json!({ "recap": null, "reason": "no_summaries" }));
        }
        let version = {
            let number = js::number(Some(state_version));
            if number.is_nan() || number == 0.0 {
                json!(0)
            } else {
                js::num(number)
            }
        };
        if let Some(cached) = self.cache.as_ref().and_then(|cache| cache.get(campaign_id, Some(state_version))) {
            let provider = clean(prop(Some(&cached), "provider"), 40);
            let provider = if provider.is_empty() { "cache".to_string() } else { provider };
            return Ok(json!({ "recap": { "text": cached["text"], "version": version, "provider": provider } }));
        }
        let polished = self.polish(&sources).await;
        let text = polished.clone().unwrap_or_else(|| deterministic_recap_text(&sources));
        if text.is_empty() {
            return Ok(json!({ "recap": null, "reason": "no_summaries" }));
        }
        let provider = if polished.is_some() { "model" } else { "deterministic" };
        if let Some(cache) = &self.cache {
            let created_at = clock::iso((self.now)().trunc() as i64);
            cache.set(campaign_id, Some(state_version), &json!({ "text": text, "provider": provider, "created_at": created_at }))?;
        }
        Ok(json!({ "recap": { "text": text, "version": version, "provider": provider } }))
    }
}

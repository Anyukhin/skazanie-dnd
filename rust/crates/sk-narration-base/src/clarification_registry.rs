//! Перенос `server/clarification-registry.mjs`: долговечный реестр непрозрачных
//! продолжений диалога — уточнения, память короткого диалога и предложения
//! маршрута.
//!
//! Клиент получает только случайный идентификатор и безопасные поля карточки;
//! исходное намерение читается из реестра сервера и никогда не декодируется из
//! запроса клиента. Записи — JSON той же формы, что в JS, файл хранилища —
//! байт в байт как `JSON.stringify` в JS (атомарная запись через временный
//! файл). Входы методов — объекты с полями JS (`campaignId`, `actorId`,
//! `stateVersion`…), отказы — [`RuleError`] с кодами JS.
//!
//! Время (`now`) и идентификаторы (`idFactory`) внедряются; порядок их вызовов
//! совпадает с JS, включая идентификатор временного файла при каждой записи.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use sk_core::indexmap::IndexMap;
use sk_core::{js, re, text, RuleError};

use crate::jsx;

const SCHEMA_VERSION: f64 = 1.0;
const DEFAULT_TTL_MS: f64 = 60.0 * 60.0 * 1_000.0;

/// Источник времени в миллисекундах (`Date.now()`).
pub type Clock = Box<dyn FnMut() -> f64 + Send>;
/// Источник идентификаторов (`randomUUID()`).
pub type IdFactory = Box<dyn FnMut() -> String + Send>;

/// Параметры конструктора (`{ storageFile, ttlMs, now, idFactory }`).
#[derive(Default)]
pub struct ClarificationRegistryOptions {
    pub storage_file: Option<PathBuf>,
    /// `ttlMs` в любой форме JS; не конечное положительное число — час.
    pub ttl_ms: Option<Value>,
    pub now: Option<Clock>,
    pub id_factory: Option<IdFactory>,
}

/// `text(value, maximum)`: NFKC, пробелы схлопнуты, края обрезаны, не длиннее `maximum`.
fn clean(value: Option<&Value>, maximum: usize) -> String {
    let normalized = text::nfkc(&jsx::string(value));
    let collapsed = text::replace_all(re!(r"\s+", "gu"), &normalized, " ");
    text::head(text::trim(&collapsed), maximum)
}

fn error(message: &str, code: &str) -> RuleError {
    RuleError::new(code, message)
}

fn io_error(cause: &std::io::Error) -> RuleError {
    let code = match cause.kind() {
        std::io::ErrorKind::NotFound => "ENOENT",
        std::io::ErrorKind::PermissionDenied => "EACCES",
        std::io::ErrorKind::AlreadyExists => "EEXIST",
        _ => "EIO",
    };
    RuleError::new(code, cause.to_string())
}

fn input<'a>(options: &'a Value, key: &str) -> Option<&'a Value> {
    options.get(key)
}

/// Поле записи (`entry.field`); у не объекта полей нет.
fn get<'a>(entry: &'a Value, key: &str) -> Option<&'a Value> {
    entry.get(key)
}

/// `entry.field === text`: строгое равенство строке.
fn equals_text(value: Option<&Value>, expected: &str) -> bool {
    value.and_then(Value::as_str) == Some(expected)
}

/// `Number(a) === Number(b)`.
fn same_number(left: Option<&Value>, right: Option<&Value>) -> bool {
    js::number(left) == js::number(right)
}

fn cleaned_list(value: Option<&Value>, maximum: usize, limit: usize) -> Value {
    let items = match value {
        Some(Value::Array(items)) => items.iter().map(|item| clean(Some(item), maximum)).filter(|item| !item.is_empty()).take(limit).collect(),
        _ => Vec::new(),
    };
    js::strings_value(items)
}

/// `safeIntent(intent)`: только безопасные поля намерения, в порядке JS.
fn safe_intent(intent: Option<&Value>) -> Value {
    let Some(intent) = intent.filter(|intent| intent.is_object()) else {
        return Value::Null;
    };
    let mut safe = Map::new();
    safe.insert("actor_id".into(), Value::String(clean(get(intent, "actor_id"), 120)));
    safe.insert("intent".into(), Value::String(clean(get(intent, "intent"), 80)));
    safe.insert("approach".into(), Value::String(clean(get(intent, "approach"), 80)));
    safe.insert("targets".into(), cleaned_list(get(intent, "targets"), 120, 8));
    safe.insert("mentioned_entities".into(), cleaned_list(get(intent, "mentioned_entities"), 120, 8));
    safe.insert("missing_information".into(), cleaned_list(get(intent, "missing_information"), 80, 8));
    safe.insert("free_action_kind".into(), Value::String(clean(get(intent, "free_action_kind"), 80)));
    let confidence = js::number(get(intent, "confidence"));
    safe.insert("confidence".into(), js::num(if confidence.is_finite() { confidence } else { 0.0 }));
    if let Some(Value::Array(candidates)) = get(intent, "target_candidates") {
        let candidates = candidates
            .iter()
            .take(8)
            .map(|candidate| {
                let mut safe_candidate = Map::new();
                safe_candidate.insert("id".into(), Value::String(clean(get(candidate, "id"), 120)));
                safe_candidate.insert("name".into(), Value::String(clean(get(candidate, "name"), 120)));
                safe_candidate.insert("role".into(), Value::String(clean(get(candidate, "role"), 80)));
                Value::Object(safe_candidate)
            })
            .collect();
        safe.insert("target_candidates".into(), Value::Array(candidates));
    }
    if let Some(steps @ Value::Array(_)) = get(intent, "action_steps") {
        safe.insert("action_steps".into(), cleaned_list(Some(steps), 500, 6));
    }
    if let Some(constraints @ Value::Array(_)) = get(intent, "constraints") {
        safe.insert("constraints".into(), cleaned_list(Some(constraints), 200, 6));
    }
    if js::present(get(intent, "pending_step")) {
        safe.insert("pending_step".into(), Value::String(clean(get(intent, "pending_step"), 500)));
    }
    Value::Object(safe)
}

/// `{ id, ...entry }`: `id` первым; собственный `id` записи перекрывает значение.
fn with_id(id: &str, entry: &Value) -> Value {
    let mut result = Map::new();
    result.insert("id".into(), Value::String(id.to_string()));
    if let Value::Object(fields) = entry {
        for (key, value) in fields {
            result.insert(key.clone(), value.clone());
        }
    }
    Value::Object(result)
}

/// `x?.length` истинно: непустой массив или строка, у объекта — его поле `length`.
fn has_length(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Object(map)) => js::truthy(map.get("length")),
        _ => false,
    }
}

/// `[id, entry]` из файла: деструктуризация пары, как в JS (строка — по символам).
fn pair(item: &Value) -> Result<(String, Value), RuleError> {
    let corrupt = || error("Некорректная схема хранилища уточнений", "CLARIFICATION_REGISTRY_CORRUPT");
    match item {
        Value::Array(parts) => Ok((jsx::string_strict(parts.first()), parts.get(1).cloned().unwrap_or(Value::Null))),
        Value::String(text) => {
            let mut chars = text.chars();
            let id = chars.next().map_or_else(|| "undefined".to_string(), |ch| ch.to_string());
            let entry = chars.next().map_or(Value::Null, |ch| Value::String(ch.to_string()));
            Ok((id, entry))
        }
        _ => Err(corrupt()),
    }
}

fn read_map(payload: &Value, key: &str) -> Result<IndexMap<String, Value>, RuleError> {
    let mut map = IndexMap::new();
    if let Some(Value::Array(items)) = payload.get(key) {
        for item in items {
            let (id, entry) = pair(item)?;
            map.insert(id, entry);
        }
    }
    Ok(map)
}

fn pairs_value(map: &IndexMap<String, Value>) -> Value {
    Value::Array(map.iter().map(|(key, entry)| Value::Array(vec![Value::String(key.clone()), entry.clone()])).collect())
}

/// Реестр уточнений.
pub struct ClarificationRegistry {
    storage_file: Option<PathBuf>,
    ttl_ms: f64,
    now: Clock,
    id_factory: IdFactory,
    entries: IndexMap<String, Value>,
    revoked_proposals: IndexMap<String, Value>,
    proposals: IndexMap<String, Value>,
    dialogues: IndexMap<String, Value>,
}

impl ClarificationRegistry {
    /// `new ClarificationRegistry(options)`: загрузка хранилища и очистка
    /// истёкшего (с записью, если что-то удалено).
    pub fn new(options: ClarificationRegistryOptions) -> Result<Self, RuleError> {
        let ttl = js::number(options.ttl_ms.as_ref());
        let storage_file = match options.storage_file {
            Some(path) => Some(std::path::absolute(&path).unwrap_or(path)),
            None => None,
        };
        let mut registry = Self {
            storage_file,
            ttl_ms: if ttl.is_finite() && ttl > 0.0 { ttl } else { DEFAULT_TTL_MS },
            now: options.now.unwrap_or_else(|| Box::new(|| sk_core::clock::now_ms() as f64)),
            id_factory: options.id_factory.unwrap_or_else(|| Box::new(sk_core::hash::uuid_v4)),
            entries: IndexMap::new(),
            revoked_proposals: IndexMap::new(),
            proposals: IndexMap::new(),
            dialogues: IndexMap::new(),
        };
        registry.load()?;
        registry.cleanup()?;
        Ok(registry)
    }

    /// Файл хранилища (абсолютный путь), если он задан.
    pub fn storage_file(&self) -> Option<&Path> {
        self.storage_file.as_deref()
    }

    /// `load()`: прочитать хранилище, если файл есть. Битый JSON или чужая
    /// схема — `CLARIFICATION_REGISTRY_CORRUPT`.
    pub fn load(&mut self) -> Result<(), RuleError> {
        let Some(file) = self.storage_file.as_ref().filter(|file| file.exists()) else {
            return Ok(());
        };
        let parsed = std::fs::read_to_string(file)
            .map_err(|cause| cause.to_string())
            .and_then(|source| serde_json::from_str::<Value>(&source).map_err(|cause| cause.to_string()));
        let payload = parsed.map_err(|cause| error(&format!("Повреждено хранилище уточнений: {cause}"), "CLARIFICATION_REGISTRY_CORRUPT"))?;
        let schema_ok = payload.get("schema_version").and_then(Value::as_f64) == Some(SCHEMA_VERSION);
        if !schema_ok || !payload.get("entries").is_some_and(Value::is_array) {
            return Err(error("Некорректная схема хранилища уточнений", "CLARIFICATION_REGISTRY_CORRUPT"));
        }
        self.entries = read_map(&payload, "entries")?;
        self.revoked_proposals = read_map(&payload, "revoked_proposals")?;
        self.proposals = read_map(&payload, "proposals")?;
        self.dialogues = read_map(&payload, "dialogues")?;
        Ok(())
    }

    /// Содержимое файла хранилища — `JSON.stringify` состояния реестра.
    pub fn serialized(&self) -> String {
        let mut payload = Map::new();
        payload.insert("schema_version".into(), Value::from(1));
        payload.insert("entries".into(), pairs_value(&self.entries));
        payload.insert("revoked_proposals".into(), pairs_value(&self.revoked_proposals));
        payload.insert("proposals".into(), pairs_value(&self.proposals));
        payload.insert("dialogues".into(), pairs_value(&self.dialogues));
        jsx::stringify(&Value::Object(payload))
    }

    /// `persist()`: атомарная запись через временный файл
    /// `<файл>.<pid>.<id>.tmp` (создаётся только новым, права 0600).
    pub fn persist(&mut self) -> Result<(), RuleError> {
        let Some(file) = self.storage_file.clone() else {
            return Ok(());
        };
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent).map_err(|cause| io_error(&cause))?;
        }
        let temporary = PathBuf::from(format!("{}.{}.{}.tmp", file.display(), std::process::id(), (self.id_factory)()));
        let mut open = std::fs::OpenOptions::new();
        open.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            open.mode(0o600);
        }
        let mut descriptor = open.open(&temporary).map_err(|cause| io_error(&cause))?;
        let written = descriptor.write_all(self.serialized().as_bytes());
        drop(descriptor);
        written.map_err(|cause| io_error(&cause))?;
        std::fs::rename(&temporary, &file).map_err(|cause| io_error(&cause))
    }

    /// `cleanup()`: удалить истёкшие записи всех четырёх видов; запись на диск —
    /// только если что-то удалено. Запись без числового `expires_at` не истекает.
    pub fn cleanup(&mut self) -> Result<(), RuleError> {
        let cutoff = (self.now)();
        let mut changed = false;
        for map in [&mut self.entries, &mut self.revoked_proposals, &mut self.proposals, &mut self.dialogues] {
            let before = map.len();
            map.retain(|_, entry| !(js::number(get(entry, "expires_at")) <= cutoff));
            changed |= map.len() != before;
        }
        if changed {
            self.persist()?;
        }
        Ok(())
    }

    /// `create({ campaignId, actorId, stateVersion, action, question, intent })`:
    /// та же незавершённая заявка возвращается прежней карточкой; новая
    /// завершает прежние уточнения этого героя в этой кампании.
    pub fn create(&mut self, options: &Value) -> Result<Value, RuleError> {
        self.cleanup()?;
        let campaign = clean(input(options, "campaignId"), 120);
        let actor = clean(input(options, "actorId"), 120);
        let state_version = input(options, "stateVersion");
        let action = clean(input(options, "action"), 2_000);
        let question = clean(input(options, "question"), 600);
        for (id, existing) in &self.entries {
            if !js::truthy(get(existing, "completed"))
                && equals_text(get(existing, "campaign_id"), &campaign)
                && equals_text(get(existing, "actor_id"), &actor)
                && same_number(get(existing, "state_version"), state_version)
                && equals_text(get(existing, "action"), &action)
                && equals_text(get(existing, "question"), &question)
            {
                return Ok(Self::public(id, existing));
            }
        }
        let id = format!("clarification:{}", (self.id_factory)());
        let mut entry = Map::new();
        entry.insert("campaign_id".into(), Value::String(campaign.clone()));
        entry.insert("actor_id".into(), Value::String(actor.clone()));
        entry.insert("state_version".into(), Value::from(js::safe_int(state_version, 0)));
        entry.insert("action".into(), Value::String(action));
        entry.insert("question".into(), Value::String(question.clone()));
        // `intent = null` по умолчанию срабатывает только для отсутствующего поля.
        entry.insert("original_intent".into(), safe_intent(input(options, "intent")));
        entry.insert("expires_at".into(), js::num((self.now)() + self.ttl_ms));
        if campaign.is_empty() || actor.is_empty() || question.is_empty() {
            return Err(error("Недостаточно данных для сохранения уточнения", "CLARIFICATION_INVALID"));
        }
        for previous in self.entries.values_mut() {
            if equals_text(get(previous, "campaign_id"), &campaign) && equals_text(get(previous, "actor_id"), &actor) {
                if let Some(fields) = previous.as_object_mut() {
                    fields.insert("completed".into(), Value::Bool(true));
                }
            }
        }
        let entry = Value::Object(entry);
        let card = Self::public(&id, &entry);
        self.entries.insert(id, entry);
        self.persist()?;
        Ok(card)
    }

    /// `rememberDialogue({ campaignId, actorId, question, answer, action, stateVersion })`:
    /// у героя хранятся шесть последних обменов.
    pub fn remember_dialogue(&mut self, options: &Value) -> Result<Value, RuleError> {
        self.cleanup()?;
        let campaign = clean(input(options, "campaignId"), 120);
        let actor = clean(input(options, "actorId"), 120);
        let question = clean(input(options, "question"), 600);
        let answer = clean(input(options, "answer"), 2_000);
        if campaign.is_empty() || actor.is_empty() || question.is_empty() || answer.is_empty() {
            return Err(error("Недостаточно данных для сохранения диалога", "CLARIFICATION_DIALOGUE_INVALID"));
        }
        let id = format!("dialogue:{}", (self.id_factory)());
        let state_version = input(options, "stateVersion");
        let state_version = if !js::present(state_version) || !js::is_safe_integer_number(state_version) {
            Value::Null
        } else {
            js::num(js::number(state_version))
        };
        let created_at = (self.now)();
        let expires_at = (self.now)() + self.ttl_ms;
        let mut entry = Map::new();
        entry.insert("campaign_id".into(), Value::String(campaign.clone()));
        entry.insert("actor_id".into(), Value::String(actor.clone()));
        entry.insert("question".into(), Value::String(question));
        entry.insert("answer".into(), Value::String(answer));
        entry.insert("action".into(), Value::String(clean(input(options, "action"), 2_000)));
        entry.insert("state_version".into(), state_version);
        entry.insert("created_at".into(), js::num(created_at));
        entry.insert("expires_at".into(), js::num(expires_at));
        self.dialogues.insert(id.clone(), Value::Object(entry));
        let own: Vec<String> = self
            .dialogues
            .iter()
            .filter(|(_, entry)| equals_text(get(entry, "campaign_id"), &campaign) && equals_text(get(entry, "actor_id"), &actor))
            .map(|(id, _)| id.clone())
            .collect();
        for old in own.iter().take(own.len().saturating_sub(6)) {
            self.dialogues.shift_remove(old);
        }
        self.persist()?;
        let stored = self.dialogues.get(&id).cloned().unwrap_or(Value::Null);
        Ok(with_id(&id, &stored))
    }

    /// `recentDialogue({ campaignId, actorId })`: до шести последних, новые первыми.
    pub fn recent_dialogue(&mut self, options: &Value) -> Result<Vec<Value>, RuleError> {
        self.cleanup()?;
        let campaign = clean(input(options, "campaignId"), 120);
        let actor = clean(input(options, "actorId"), 120);
        Ok(self
            .dialogues
            .iter()
            .rev()
            .filter(|(_, entry)| equals_text(get(entry, "campaign_id"), &campaign) && equals_text(get(entry, "actor_id"), &actor))
            .take(6)
            .map(|(id, entry)| with_id(id, entry))
            .collect())
    }

    /// `resetDialogue({ campaignId, actorId })`: сколько записей удалено.
    pub fn reset_dialogue(&mut self, options: &Value) -> Result<usize, RuleError> {
        self.cleanup()?;
        let campaign = clean(input(options, "campaignId"), 120);
        let actor = clean(input(options, "actorId"), 120);
        let before = self.dialogues.len();
        self.dialogues.retain(|_, entry| !(equals_text(get(entry, "campaign_id"), &campaign) && equals_text(get(entry, "actor_id"), &actor)));
        let removed = before - self.dialogues.len();
        if removed > 0 {
            self.persist()?;
        }
        Ok(removed)
    }

    /// `resolve(id, { campaignId, actorId, stateVersion })`: уточнение героя
    /// этой кампании; при заданной версии — только той же версии обстановки.
    pub fn resolve(&mut self, id: Option<&Value>, options: &Value) -> Result<Value, RuleError> {
        self.cleanup()?;
        let key = clean(id, 300);
        let Some(entry) = self.entries.get(&key) else {
            return Err(error("Уточнение не найдено или истекло. Отправьте действие заново.", "CLARIFICATION_NOT_FOUND"));
        };
        if !js::truthy(Some(entry)) {
            return Err(error("Уточнение не найдено или истекло. Отправьте действие заново.", "CLARIFICATION_NOT_FOUND"));
        }
        if !equals_text(get(entry, "campaign_id"), &clean(input(options, "campaignId"), 120)) || !equals_text(get(entry, "actor_id"), &clean(input(options, "actorId"), 120)) {
            return Err(error("Уточнение не принадлежит этому герою или кампании.", "CLARIFICATION_FORBIDDEN"));
        }
        let state_version = input(options, "stateVersion");
        if js::present(state_version) && !same_number(get(entry, "state_version"), state_version) {
            return Err(error("Обстановка изменилась, поэтому старое уточнение больше не действует. Отправьте заявку заново.", "CLARIFICATION_STALE"));
        }
        Ok(with_id(&key, entry))
    }

    /// `current({ campaignId, actorId, stateVersion })`: последнее незавершённое
    /// уточнение героя для этой версии обстановки.
    pub fn current(&mut self, options: &Value) -> Result<Option<Value>, RuleError> {
        self.cleanup()?;
        let campaign = clean(input(options, "campaignId"), 120);
        let actor = clean(input(options, "actorId"), 120);
        let state_version = input(options, "stateVersion");
        Ok(self
            .entries
            .iter()
            .rev()
            .find(|(_, entry)| {
                !js::truthy(get(entry, "completed"))
                    && equals_text(get(entry, "campaign_id"), &campaign)
                    && equals_text(get(entry, "actor_id"), &actor)
                    && same_number(get(entry, "state_version"), state_version)
            })
            .map(|(id, entry)| Self::public(id, entry)))
    }

    /// `complete(id, { campaignId, actorId })`. Как в JS, отметка ставится по
    /// `String(id)` без обрезки: если ключ нашёлся только после обрезки, JS
    /// падал на `undefined.completed`; здесь — `CLARIFICATION_NOT_FOUND`.
    pub fn complete(&mut self, id: Option<&Value>, options: &Value) -> Result<(), RuleError> {
        let mut scoped = Map::new();
        for key in ["campaignId", "actorId"] {
            if let Some(value) = input(options, key) {
                scoped.insert(key.into(), value.clone());
            }
        }
        self.resolve(id, &Value::Object(scoped))?;
        let Some(fields) = self.entries.get_mut(&jsx::string_strict(id)).and_then(Value::as_object_mut) else {
            return Err(error("Уточнение не найдено или истекло. Отправьте действие заново.", "CLARIFICATION_NOT_FOUND"));
        };
        fields.insert("completed".into(), Value::Bool(true));
        self.persist()
    }

    /// `revokeProposal(proposalId, { campaignId, actorId })`.
    pub fn revoke_proposal(&mut self, proposal_id: Option<&Value>, options: &Value) -> Result<(), RuleError> {
        self.cleanup()?;
        let id = clean(proposal_id, 300);
        let campaign = clean(input(options, "campaignId"), 120);
        let actor = clean(input(options, "actorId"), 120);
        let key = format!("{campaign}\u{0}{actor}\u{0}{id}");
        let mut revoked = Map::new();
        revoked.insert("expires_at".into(), js::num((self.now)() + self.ttl_ms));
        self.revoked_proposals.insert(key, Value::Object(revoked));
        if let Some(proposal) = self.proposals.get_mut(&id) {
            if js::truthy(Some(proposal)) && equals_text(get(proposal, "campaign_id"), &campaign) && equals_text(get(proposal, "actor_id"), &actor) {
                if let Some(fields) = proposal.as_object_mut() {
                    fields.insert("revoked".into(), Value::Bool(true));
                }
            }
        }
        self.persist()
    }

    /// `isProposalRevoked(proposalId, { campaignId, actorId })`.
    pub fn is_proposal_revoked(&mut self, proposal_id: Option<&Value>, options: &Value) -> Result<bool, RuleError> {
        self.cleanup()?;
        let id = clean(proposal_id, 300);
        let key = format!("{}\u{0}{}\u{0}{id}", clean(input(options, "campaignId"), 120), clean(input(options, "actorId"), 120));
        Ok(self.revoked_proposals.contains_key(&key) || self.proposals.get(&id).is_some_and(|proposal| js::is_true(get(proposal, "revoked"))))
    }

    /// `issueProposal({ campaignId, actorId, stateVersion, proposal, planFingerprint })`:
    /// копия предложения с выданным `id`.
    pub fn issue_proposal(&mut self, options: &Value) -> Result<Value, RuleError> {
        self.cleanup()?;
        let id = format!("proposal:{}", (self.id_factory)());
        let campaign = clean(input(options, "campaignId"), 120);
        let actor = clean(input(options, "actorId"), 120);
        let fingerprint = clean(input(options, "planFingerprint"), 128);
        let mut proposal = match input(options, "proposal") {
            None | Some(Value::Null) => Value::Object(Map::new()),
            Some(value) => value.clone(),
        };
        let expires_at = js::num((self.now)() + self.ttl_ms);
        if campaign.is_empty() || actor.is_empty() || fingerprint.is_empty() || !js::truthy(get(&proposal, "title")) {
            return Err(error("Недостаточно данных для сохранения предложения", "PROPOSAL_INVALID"));
        }
        if let Some(fields) = proposal.as_object_mut() {
            fields.insert("id".into(), Value::String(id.clone()));
        }
        let mut entry = Map::new();
        entry.insert("campaign_id".into(), Value::String(campaign));
        entry.insert("actor_id".into(), Value::String(actor));
        entry.insert("state_version".into(), Value::from(js::safe_int(input(options, "stateVersion"), 0)));
        entry.insert("proposal".into(), proposal.clone());
        entry.insert("plan_fingerprint".into(), Value::String(fingerprint));
        entry.insert("expires_at".into(), expires_at);
        entry.insert("revoked".into(), Value::Bool(false));
        self.proposals.insert(id, Value::Object(entry));
        self.persist()?;
        Ok(proposal)
    }

    /// `resolveProposal(id, { campaignId, actorId, stateVersion })`: запись
    /// предложения целиком.
    pub fn resolve_proposal(&mut self, id: Option<&Value>, options: &Value) -> Result<Value, RuleError> {
        self.cleanup()?;
        let key = clean(id, 300);
        let entry = match self.proposals.get(&key) {
            Some(entry) if js::truthy(Some(entry)) => entry.clone(),
            _ => return Err(error("Предложение не найдено или истекло. Отправьте заявку заново.", "PROPOSAL_NOT_FOUND")),
        };
        if !equals_text(get(&entry, "campaign_id"), &clean(input(options, "campaignId"), 120)) || !equals_text(get(&entry, "actor_id"), &clean(input(options, "actorId"), 120)) {
            return Err(error("Предложение не принадлежит этому герою или кампании.", "PROPOSAL_FORBIDDEN"));
        }
        if js::truthy(get(&entry, "revoked")) || self.is_proposal_revoked(Some(&Value::String(key.clone())), options)? {
            return Err(error("Это предложение уже отменено изменением заявки. Получите новый маршрут.", "PROPOSAL_REVOKED"));
        }
        let state_version = input(options, "stateVersion");
        if js::present(state_version) && !same_number(get(&entry, "state_version"), state_version) {
            return Err(error("Обстановка изменилась, поэтому старое предложение больше не действует.", "PROPOSAL_STALE"));
        }
        Ok(entry)
    }

    /// `getProposal(id, options)` — то же, что [`Self::resolve_proposal`].
    pub fn get_proposal(&mut self, id: Option<&Value>, options: &Value) -> Result<Value, RuleError> {
        self.resolve_proposal(id, options)
    }

    /// `public(id, entry)`: безопасная карточка уточнения для клиента.
    pub fn public(id: &str, entry: &Value) -> Value {
        let mut card = Map::new();
        card.insert("id".into(), Value::String(id.to_string()));
        for key in ["campaign_id", "actor_id", "state_version", "action", "question"] {
            if let Some(value) = get(entry, key) {
                card.insert(key.into(), value.clone());
            }
        }
        let intent = get(entry, "original_intent");
        let steps = intent.and_then(|intent| get(intent, "action_steps"));
        let pending = intent.and_then(|intent| get(intent, "pending_step"));
        if has_length(steps) || equals_text(pending, "proposal") {
            card.insert("confirmation_required".into(), Value::Bool(true));
        }
        Value::Object(card)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    fn temp_dir(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("sk-clarification-{name}-{}", sk_core::hash::uuid_v4()));
        std::fs::create_dir_all(&directory).expect("каталог");
        directory
    }

    fn counter_ids() -> IdFactory {
        let mut index = 0;
        Box::new(move || {
            index += 1;
            format!("id-{index}")
        })
    }

    #[test]
    fn dialogue_memory_is_limited_to_six_and_owned_by_account() {
        let directory = temp_dir("six");
        let mut registry = ClarificationRegistry::new(ClarificationRegistryOptions {
            storage_file: Some(directory.join("registry.json")),
            now: Some(Box::new(|| 1_000.0)),
            id_factory: Some(counter_ids()),
            ..Default::default()
        })
        .expect("реестр");
        for index in 0..8 {
            registry.remember_dialogue(&json!({ "campaignId": "camp", "actorId": "hero", "question": format!("q{index}"), "answer": format!("a{index}") })).expect("диалог");
        }
        registry.remember_dialogue(&json!({ "campaignId": "camp", "actorId": "other", "question": "чужой", "answer": "чужой ответ" })).expect("чужой");
        let questions = |registry: &mut ClarificationRegistry, actor: &str| -> Vec<String> {
            registry.recent_dialogue(&json!({ "campaignId": "camp", "actorId": actor })).expect("память").iter().map(|entry| entry["question"].as_str().unwrap_or("").to_string()).collect()
        };
        assert_eq!(questions(&mut registry, "hero"), ["q7", "q6", "q5", "q4", "q3", "q2"]);
        assert_eq!(questions(&mut registry, "other"), ["чужой"]);
        assert_eq!(registry.reset_dialogue(&json!({ "campaignId": "camp", "actorId": "hero" })).expect("сброс"), 6);
        assert_eq!(questions(&mut registry, "other"), ["чужой"]);
        std::fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn dialogue_survives_restart_and_ttl() {
        let directory = temp_dir("restart");
        let clock = Arc::new(AtomicU64::new(1_000));
        let options = || {
            let clock = Arc::clone(&clock);
            ClarificationRegistryOptions { storage_file: Some(directory.join("registry.json")), now: Some(Box::new(move || clock.load(Ordering::SeqCst) as f64)), ..Default::default() }
        };
        let mut registry = ClarificationRegistry::new(options()).expect("реестр");
        registry
            .remember_dialogue(&json!({ "campaignId": "camp", "actorId": "hero", "question": "куда идти?", "answer": "к северным воротам", "action": "route", "stateVersion": 7 }))
            .expect("диалог");
        let mut restarted = ClarificationRegistry::new(options()).expect("перезапуск");
        assert_eq!(restarted.recent_dialogue(&json!({ "campaignId": "camp", "actorId": "hero" })).expect("память")[0]["answer"], json!("к северным воротам"));
        clock.fetch_add(60 * 60 * 1_000 + 1, Ordering::SeqCst);
        assert!(restarted.recent_dialogue(&json!({ "campaignId": "camp", "actorId": "hero" })).expect("память").is_empty());
        let card = restarted
            .create(&json!({ "campaignId": "camp", "actorId": "hero", "question": "что дальше?", "stateVersion": 1, "intent": { "actor_id": "hero", "intent": "clarify", "approach": "ask", "action_steps": ["шаг 1"], "constraints": ["не шуметь"], "pending_step": "выбрать дверь" } }))
            .expect("уточнение");
        assert!(card["id"].as_str().expect("id").starts_with("clarification:"));
        assert_eq!(card["confirmation_required"], json!(true));
        std::fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn corrupt_storage_is_reported() {
        let directory = temp_dir("corrupt");
        let file = directory.join("registry.json");
        std::fs::write(&file, "{не json").expect("файл");
        let open = || ClarificationRegistry::new(ClarificationRegistryOptions { storage_file: Some(file.clone()), ..Default::default() });
        let error = open().err().expect("битый файл");
        assert_eq!(error.code, "CLARIFICATION_REGISTRY_CORRUPT");
        assert!(error.message.starts_with("Повреждено хранилище уточнений: "));
        std::fs::write(&file, r#"{"schema_version":2,"entries":[]}"#).expect("файл");
        let error = open().err().expect("чужая схема");
        assert_eq!((error.code.as_str(), error.message.as_str()), ("CLARIFICATION_REGISTRY_CORRUPT", "Некорректная схема хранилища уточнений"));
        std::fs::remove_dir_all(directory).ok();
    }
}

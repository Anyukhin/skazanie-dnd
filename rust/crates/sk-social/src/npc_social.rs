//! Перенос `server/npc-social.mjs`: социальное состояние NPC.
//!
//! Профили NPC (расписание, запас, речевой профиль, ручные СЛ, досье),
//! разговоры, обещания и отношения с героями; нормализация состояния
//! (`ensure_npc_social_state` — ею пользуется весь сервер), редьюсер событий
//! `NpcSocialProfileUpserted`, `NpcConversationRecorded`,
//! `NpcRelationshipAdjusted`, `NpcRelationshipTierChanged`,
//! `NpcPromiseRecorded`, `NpcPromiseResolved` (его зовёт Rules Engine), проверка
//! социальных команд и их события, граница знания NPC, проекция для игрока и
//! досье для Рассказчика.
//!
//! Формы JSON совпадают с JS байт в байт; режим удержания истории (`legacy`
//! для прежних хешей коммитов) читается из `options` или из контекста
//! `sk_society::retention_context`, как в JS.

use std::collections::{HashMap, HashSet};
use std::fmt;

use serde_json::{json, Map, Value};
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::{js, re, text, RuleError};
use sk_society::retention_context::retention_mode;
use sk_society::underworld::UNDERWORLD_PRIVATE_TAGS;

use crate::common::{
    array, clean, clean_lower, clone_js, coalesce, element, empty, get, is_safe, is_str, iterate, js_order, object_entries, one_of, or_empty, put_opt,
    spread_of, strict_eq, tpl,
};

const PROFILE_VISIBILITIES: [&str; 3] = ["public", "party", "gm_only"];
const DOSSIER_VISIBILITIES: [&str; 4] = ["public", "party", "specific_player", "gm_only"];
const PROMISE_DIRECTIONS: [&str; 2] = ["npc_to_party", "party_to_npc"];
const PROMISE_STATUSES: [&str; 4] = ["open", "fulfilled", "broken", "cancelled"];
const STANCES: [&str; 4] = ["friendly", "neutral", "guarded", "hostile"];
/// Навыки социальной проверки. Список дублирует `NPC_SOCIAL_CHECK_SKILLS` из
/// `npc_social_check` намеренно, как в JS: обратный импорт замкнул бы модули в
/// цикл, а расхождение ловит тест.
pub(crate) const SOCIAL_CHECK_SKILLS: [&str; 4] = ["persuasion", "deception", "intimidation", "insight"];
const SOCIAL_CHECK_DEGREES: [&str; 4] = ["strong_success", "success", "failure", "severe_failure"];

/// Сколько записей досье NPC видит игрок.
pub const NPC_DOSSIER_PROFILE_LIMIT: usize = 12;
const NPC_DOSSIER_LEGACY_LIMIT: usize = NPC_DOSSIER_PROFILE_LIMIT;

/// Пределы досье для Рассказчика (`NPC_NARRATOR_DOSSIER_LIMITS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NarratorDossierLimits {
    pub npcs: usize,
    pub interactions: usize,
    pub promises: usize,
}

impl NarratorDossierLimits {
    /// Запись в форме JS.
    pub fn to_json(&self) -> Value {
        json!({ "npcs": self.npcs, "interactions": self.interactions, "promises": self.promises })
    }
}

pub const NPC_NARRATOR_DOSSIER_LIMITS: NarratorDossierLimits = NarratorDossierLimits { npcs: 1, interactions: 3, promises: 2 };

/// Команды социального контура (`NPC_SOCIAL_COMMAND_TYPES`).
pub const NPC_SOCIAL_COMMAND_TYPES: [&str; 3] = ["UpsertNpcSocialProfile", "RecordNpcSocialTurn", "ResolveNpcPromise"];

/// Тайны авторского сценария раздаёт сам сценарий (`holders`), сервер их не переназначает.
const SCENARIO_SECRET_PREFIX: &str = "fact:secret:scenario:";

static NULL: Value = Value::Null;

/// Отказ социальной команды (`NpcSocialValidationError`): код для клиента,
/// текст для человека. Rules Engine переводит его в отказ правила с тем же
/// кодом и текстом (`From<…> for RuleError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NpcSocialValidationError {
    pub code: String,
    pub message: String,
}

impl NpcSocialValidationError {
    /// Код по умолчанию конструктора JS.
    pub const DEFAULT_CODE: &'static str = "NPC_SOCIAL_INVALID";

    pub fn new(message: impl Into<String>, code: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

impl fmt::Display for NpcSocialValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for NpcSocialValidationError {}

impl From<NpcSocialValidationError> for RuleError {
    fn from(error: NpcSocialValidationError) -> Self {
        RuleError::new(error.code, error.message)
    }
}

type Checked<T> = Result<T, NpcSocialValidationError>;

fn fail<T>(message: impl Into<String>, code: &str) -> Checked<T> {
    Err(NpcSocialValidationError::new(message, code))
}

/// Текущее состояние сохраняет принятую историю. Legacy replay явно включает
/// прежний ограниченный reducer, чтобы старые хеши коммитов воспроизводились.
/// `options` — `{ isLegacy }` или `{ retention: 'legacy' | 'current' }`; без них
/// — режим из `with_retention_mode`.
fn legacy_retention(options: &Value) -> bool {
    if let Value::Object(context) = options {
        if context.contains_key("isLegacy") {
            return js::is_true(context.get("isLegacy"));
        }
        if context.contains_key("retention") {
            return is_str(context.get("retention"), "legacy");
        }
    }
    retention_mode() == "legacy"
}

fn string_value(text: &str) -> Value {
    Value::String(text.to_string())
}

fn clean_str(text: &str, maximum: usize) -> String {
    clean(Some(&string_value(text)), maximum)
}

/// `strings(value, maximum, limit)`: очищенные строки без пустых и повторов.
fn strings(value: Option<&Value>, maximum: usize, limit: usize) -> Vec<String> {
    let mut seen: IndexSet<String> = IndexSet::new();
    for item in array(value) {
        let cleaned = clean(Some(item), maximum);
        if !cleaned.is_empty() {
            seen.insert(cleaned);
        }
    }
    seen.into_iter().take(limit).collect()
}

fn strings_json(values: &[String]) -> Value {
    Value::Array(values.iter().map(|value| string_value(value)).collect())
}

fn integer(value: Option<&Value>, fallback: i64) -> i64 {
    js::safe_int(value, fallback)
}

fn identifier_pattern() -> &'static sk_core::fancy_regex::Regex {
    re!(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$", "u")
}

/// `validIdentifier(value)`: проверка по очищенной строке.
fn valid_identifier(value: &str) -> bool {
    text::test(identifier_pattern(), &clean_str(value, 120))
}

fn str_field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn max0(value: f64) -> f64 {
    if value < 0.0 {
        0.0
    } else {
        value
    }
}

// ── Расписание и запас ─────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct ScheduleEntry {
    id: String,
    days: Vec<i64>,
    start: i64,
    end: i64,
    location: String,
    available: bool,
    summary: String,
    visibility: String,
}

impl ScheduleEntry {
    fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "days": self.days,
            "start_minute": self.start,
            "end_minute": self.end,
            "location": self.location,
            "available": self.available,
            "summary": self.summary,
            "visibility": self.visibility,
        })
    }
}

fn week_day(day: &Value) -> Option<i64> {
    let number = js::number(Some(day));
    (is_safe(number) && (0.0..=6.0).contains(&number)).then_some(number as i64)
}

fn safe_schedule_entry(value: &Value) -> Option<ScheduleEntry> {
    if !value.is_object() {
        return None;
    }
    let source = Some(value);
    let id = clean(get(source, "id"), 120);
    let location = clean(get(source, "location"), 180);
    let start = js::number(get(source, "start_minute"));
    let end = js::number(get(source, "end_minute"));
    if !valid_identifier(&id) || location.is_empty() || !is_safe(start) || !is_safe(end) || start < 0.0 || start >= 1_440.0 || end <= start || end > 1_440.0 {
        return None;
    }
    let mut days: Vec<i64> = Vec::new();
    for day in array(get(source, "days")) {
        if let Some(day) = week_day(day) {
            if !days.contains(&day) {
                days.push(day);
            }
        }
    }
    days.sort_unstable();
    Some(ScheduleEntry {
        id,
        days,
        start: start as i64,
        end: end as i64,
        location,
        available: !js::is_false(get(source, "available")),
        summary: clean(get(source, "summary"), 300),
        visibility: one_of(get(source, "visibility"), &PROFILE_VISIBILITIES).unwrap_or("party").to_string(),
    })
}

fn schedule_days_overlap(left: &ScheduleEntry, right: &ScheduleEntry) -> bool {
    if left.days.is_empty() || right.days.is_empty() {
        return true;
    }
    left.days.iter().any(|day| right.days.contains(day))
}

fn safe_schedule(value: Option<&Value>) -> Vec<ScheduleEntry> {
    let mut candidates: Vec<ScheduleEntry> = array(value).iter().filter_map(safe_schedule_entry).collect();
    candidates.sort_by(|left, right| left.start.cmp(&right.start).then(left.end.cmp(&right.end)).then_with(|| text::locale_compare(&left.id, &right.id)));
    let mut accepted: Vec<ScheduleEntry> = Vec::new();
    let mut ids: HashSet<String> = HashSet::new();
    for entry in candidates {
        if ids.contains(&entry.id) {
            continue;
        }
        let overlaps = accepted.iter().any(|other| schedule_days_overlap(&entry, other) && entry.start < other.end && other.start < entry.end);
        if overlaps {
            continue;
        }
        ids.insert(entry.id.clone());
        accepted.push(entry);
        if accepted.len() >= 64 {
            break;
        }
    }
    accepted
}

fn schedule_json(entries: &[ScheduleEntry]) -> Value {
    Value::Array(entries.iter().map(ScheduleEntry::to_json).collect())
}

#[derive(Debug, Clone)]
struct InventoryEntry {
    id: String,
    name: String,
    quantity: i64,
    description: String,
    visibility: String,
}

impl InventoryEntry {
    fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "quantity": self.quantity,
            "description": self.description,
            "visibility": self.visibility,
        })
    }
}

fn safe_inventory_entry(value: &Value) -> Option<InventoryEntry> {
    if !value.is_object() {
        return None;
    }
    let source = Some(value);
    let id = clean(get(source, "id"), 120);
    let name = clean(get(source, "name"), 160);
    let quantity = js::number(get(source, "quantity"));
    if !valid_identifier(&id) || name.is_empty() || !is_safe(quantity) || quantity < 0.0 || quantity > 9_999.0 {
        return None;
    }
    Some(InventoryEntry {
        id,
        name,
        quantity: quantity as i64,
        description: clean(get(source, "description"), 500),
        visibility: one_of(get(source, "visibility"), &PROFILE_VISIBILITIES).unwrap_or("party").to_string(),
    })
}

fn safe_inventory(value: Option<&Value>, options: &Value) -> Vec<InventoryEntry> {
    let mut inventory: Vec<InventoryEntry> = Vec::new();
    let mut ids: HashSet<String> = HashSet::new();
    for item in array(value) {
        let Some(safe) = safe_inventory_entry(item) else { continue };
        if ids.contains(&safe.id) {
            continue;
        }
        ids.insert(safe.id.clone());
        inventory.push(safe);
        if legacy_retention(options) && inventory.len() >= 100 {
            break;
        }
    }
    inventory
}

// ── Отношение, время, сроки ─────────────────────────────────────────────────

/// Ступень отношения по очкам (`relationshipTier`); значение приводится как в JS.
pub fn relationship_tier(value: &Value) -> &'static str {
    relationship_tier_for(integer(Some(value), 0))
}

/// Ступень отношения по уже целому счёту.
pub fn relationship_tier_for(score: i64) -> &'static str {
    let score = score.clamp(-100, 100);
    if score <= -50 {
        "hostile"
    } else if score <= -20 {
        "unfriendly"
    } else if score >= 50 {
        "trusted"
    } else if score >= 20 {
        "friendly"
    } else {
        "neutral"
    }
}

/// Минуты мира кампании (`campaignElapsedMinutes`). Дробное число JS: при
/// мусорных часах бывает бесконечным — так же, как в JS.
pub fn campaign_elapsed_minutes(state: &Value) -> f64 {
    let world_time = get(get(Some(state), "mechanics"), "world_time");
    let elapsed = get(world_time, "elapsed_minutes");
    if js::present(elapsed) && js::is_safe_integer_number(elapsed) {
        return max0(js::number(elapsed));
    }
    let raw = js::number(get(world_time, "amount"));
    let amount = max0(if raw.is_nan() { 0.0 } else { raw });
    let unit = clean_lower(get(world_time, "unit"), 20);
    if ["hour", "hours", "час", "часа", "часов"].contains(&unit.as_str()) {
        return (amount * 60.0).floor();
    }
    if ["day", "days", "день", "дня", "дней"].contains(&unit.as_str()) {
        return (amount * 1_440.0).floor();
    }
    amount.floor()
}

/// Срок обещания из подсказки «завтра», «через 2 часа» (`promiseDueOffsetMinutes`).
pub fn promise_due_offset_minutes(value: &Value) -> Option<i64> {
    let hint = clean_lower(Some(value), 240);
    if hint.is_empty() {
        return None;
    }
    if text::test(re!(r"\b(?:tomorrow|next day)\b|завтра", "iu"), &hint) {
        return Some(1_440);
    }
    if text::test(re!(r"\btonight\b|сегодня(?:\s+вечером)?", "iu"), &hint) {
        return Some(720);
    }
    if text::test(re!(r"\bsoon\b|скоро", "iu"), &hint) {
        return Some(240);
    }
    let pattern = re!(r"(?:через|in)?\s*(\d{1,3})\s*(минут(?:у|ы)?|мин|час(?:а|ов)?|дн(?:я|ей)|minute(?:s)?|min|hour(?:s)?|hr|day(?:s)?)", "iu");
    let captures = pattern.captures(&hint).ok().flatten()?;
    let digits = captures.get(1).map(|group| group.as_str()).unwrap_or("");
    let amount = integer(Some(&string_value(digits)), 1).clamp(1, 90);
    let unit = text::lower(captures.get(2).map(|group| group.as_str()).unwrap_or(""));
    let multiplier = if text::test(re!(r"^(?:час|hour|hr)", "iu"), &unit) {
        60
    } else if text::test(re!(r"^(?:дн|day)", "iu"), &unit) {
        1_440
    } else {
        1
    };
    Some((amount * multiplier).min(129_600))
}

// ── Строгий ввод ────────────────────────────────────────────────────────────

fn identifier(value: Option<&Value>, field: &str) -> Checked<String> {
    let result = clean(value, 120);
    if !text::test(identifier_pattern(), &result) {
        return fail(format!("Некорректное поле {field}"), "NPC_SOCIAL_INVALID_ID");
    }
    Ok(result)
}

fn object<'a>(value: Option<&'a Value>, label: &str) -> Checked<&'a Map<String, Value>> {
    match value {
        Some(Value::Object(map)) => Ok(map),
        _ => fail(format!("{label} должен быть объектом"), "NPC_SOCIAL_INVALID_SHAPE"),
    }
}

fn fields(value: &Map<String, Value>, allowed: &[&str], label: &str) -> Checked<()> {
    let unexpected: Vec<&str> = js::keys(value).into_iter().map(String::as_str).filter(|key| !allowed.contains(key)).collect();
    if !unexpected.is_empty() {
        return fail(format!("{label} содержит запрещённые поля: {}", unexpected.join(", ")), "NPC_SOCIAL_UNKNOWN_FIELD");
    }
    Ok(())
}

/// Ручные СЛ социальных проверок этого NPC.
///
/// Диапазон тот же, что у политики (5–25): ручная СЛ уточняет сложность, а не
/// отменяет её границы. Поле приватное, как цели и убеждения: игроку СЛ до
/// броска не показывают.
fn safe_social_dcs(value: Option<&Value>) -> Value {
    let Some(Value::Object(map)) = value else { return js::obj() };
    let mut result = Map::new();
    for (skill, dc) in js::entries(map) {
        if !SOCIAL_CHECK_SKILLS.contains(&skill.as_str()) {
            continue;
        }
        let number = js::number(Some(dc));
        if !is_safe(number) {
            continue;
        }
        result.insert(skill.clone(), Value::from((number as i64).clamp(5, 25)));
    }
    Value::Object(result)
}

// ── Голос и поведение ───────────────────────────────────────────────────────

/// Короткий server-owned речевой профиль NPC (`npcSpeechProfile`).
///
/// Старые кампании хранят одно поле `voice`. Оно остаётся совместимым
/// источником, но нормализатор раскладывает его в три исполнимых признака:
/// темп, словарь и речевую привычку. Новые профили могут передать эти признаки
/// явно.
pub fn npc_speech_profile(value: &Value) -> Value {
    let source = Some(value);
    let explicit = match get(source, "speech_profile") {
        Some(profile @ Value::Object(_)) => Some(profile),
        _ => None,
    };
    let voice = clean(get(source, "voice"), 500);
    let role = clean(get(source, "role"), 160);
    let style = text::lower(&format!("{voice} {role}"));
    let matches = |pattern: &sk_core::fancy_regex::Regex| text::test(pattern, &style);
    let mut pace = clean(get(explicit, "pace"), 100);
    if pace.is_empty() {
        pace = if matches(re!(r"быстр|тороп|скороговор", "iu")) {
            "быстро, короткими фразами"
        } else if matches(re!(r"медлен|нетороп|пауз", "iu")) {
            "медленно, с заметными паузами"
        } else if matches(re!(r"коротк|лаконич|немногослов", "iu")) {
            "ровно, короткими фразами"
        } else {
            "ровно, фразами средней длины"
        }
        .to_string();
    }
    let mut lexicon = clean(get(explicit, "lexicon"), 180);
    if lexicon.is_empty() {
        lexicon = if matches(re!(r"прибаут|послов|простореч|жаргон", "iu")) {
            "простые слова, поговорки и профессиональные присказки".to_string()
        } else if matches(re!(r"архив|уч[её]н|книж|летопис|писар", "iu")) {
            "точные книжные слова и названия записей".to_string()
        } else if matches(re!(r"торгов|купц|лавк|трактир|постоял", "iu")) {
            "бытовые и деловые слова своей работы".to_string()
        } else if !role.is_empty() {
            format!("предметные слова из роли «{role}»")
        } else {
            "простые предметные слова".to_string()
        };
    }
    let mut mannerism = clean(get(explicit, "mannerism"), 180);
    if mannerism.is_empty() {
        mannerism = if matches(re!(r"прибаут|послов", "iu")) {
            "вставляет одну короткую прибаутку, не повторяя её дословно".to_string()
        } else if matches(re!(r"пауз|медлен|нетороп", "iu")) {
            "перед важным выводом делает короткую паузу".to_string()
        } else if matches(re!(r"коротк|лаконич|немногослов", "iu")) {
            "заканчивает ответ без лишнего пояснения".to_string()
        } else if !voice.is_empty() {
            format!("сохраняет указанную манеру: {voice}")
        } else {
            "перед выводом задаёт один уточняющий вопрос".to_string()
        };
    }
    json!({ "pace": pace, "lexicon": lexicon, "mannerism": mannerism })
}

/// Безопасная выжимка целей NPC (`npcBehaviorPolicy`): мотивы никогда не
/// передаются модели текстом. `relationship` — `None` для `undefined`
/// (по умолчанию 0); сравнивается как число JS.
pub fn npc_behavior_policy(profile: &Value, relationship: Option<&Value>) -> Value {
    let source = Some(profile);
    let mut parts: Vec<String> = Vec::new();
    for key in ["goals", "beliefs"] {
        for item in iterate(coalesce(get(source, key), None)) {
            parts.push(js::s(Some(&item)));
        }
    }
    let source_text = text::lower(&parts.join(" "));
    let protective = text::test(re!(r"защит|сохран|берег|страж|поряд|семь", "iu"), &source_text);
    let inquisitive = text::test(re!(r"узна|исслед|тайн|знани|разобрат", "iu"), &source_text);
    let transactional = text::test(re!(r"торг|прибыл|золот|долг|обмен|выгод", "iu"), &source_text);
    let secretive = text::test(re!(r"тайн|скрыт|секрет|никому|молч", "iu"), &source_text);
    let score = relationship.map_or(0.0, |value| js::number(Some(value)));
    let stance = if score >= 20.0 {
        "friendly"
    } else if score <= -20.0 {
        "hostile"
    } else if score <= -5.0 {
        "guarded"
    } else {
        "neutral"
    };
    let concession_style = if secretive || protective {
        "conditional"
    } else if transactional {
        "reciprocal"
    } else {
        "open"
    };
    let initiative = if inquisitive {
        "asks_for_details"
    } else if protective {
        "offers_safe_next_step"
    } else if transactional {
        "names_a_trade"
    } else {
        "waits_for_request"
    };
    json!({
        "stance": stance,
        "concession_style": concession_style,
        "initiative": initiative,
        "boundaries": { "protects_people": protective, "keeps_secrets": secretive },
    })
}

// ── Профиль, досье, разговор, обещание ──────────────────────────────────────

fn safe_npc_dossier_entry(value: &Value, options: &Value) -> Option<Value> {
    if !value.is_object() {
        return None;
    }
    let source = Some(value);
    let id = clean(get(source, "id"), 120);
    let provenance = get(source, "provenance");
    let source_conversation_id = clean(get(provenance, "source_conversation_id"), 120);
    let summary = clean(get(source, "summary"), 600);
    if id.is_empty() || source_conversation_id.is_empty() || summary.is_empty() {
        return None;
    }
    let legacy = legacy_retention(options);
    let id_limit = if legacy { 12 } else { usize::MAX };
    let claim_ids = Value::Array(array(get(source, "disclosed_claims")).iter().map(|claim| element(get(Some(claim), "id"))).collect());
    let disclosed_claim_ids = strings(Some(&claim_ids), 120, id_limit);
    let mut entry = Map::new();
    entry.insert("id".into(), string_value(&id));
    entry.insert("kind".into(), string_value("recorded_exchange"));
    entry.insert("hero_id".into(), string_value(&clean(get(source, "hero_id"), 120)));
    entry.insert("summary".into(), string_value(&summary));
    entry.insert("stance".into(), string_value(one_of(get(source, "stance"), &STANCES).unwrap_or("neutral")));
    entry.insert("visibility".into(), string_value(one_of(get(source, "visibility"), &DOSSIER_VISIBILITIES).unwrap_or("party")));
    entry.insert(
        "epistemic_status".into(),
        string_value(if disclosed_claim_ids.is_empty() { "recorded_dialogue_not_world_fact" } else { "contains_unverified_claims" }),
    );
    entry.insert("disclosed_fact_ids".into(), strings_json(&strings(get(source, "disclosed_fact_ids"), 120, id_limit)));
    entry.insert(
        "disclosed_claims".into(),
        Value::Array(disclosed_claim_ids.iter().map(|claim_id| json!({ "id": claim_id, "truth_status": "unknown" })).collect()),
    );
    let event_limit = if legacy_retention(options) { 8 } else { usize::MAX };
    entry.insert(
        "provenance".into(),
        json!({
            "source_kind": "NpcConversationRecorded",
            "source_conversation_id": source_conversation_id,
            "source_event_ids": strings(get(provenance, "source_event_ids"), 120, event_limit),
        }),
    );
    Some(Value::Object(entry))
}

fn safe_npc_dossier(value: Option<&Value>, options: &Value) -> Vec<Value> {
    let mut entries: IndexMap<String, Value> = IndexMap::new();
    for candidate in array(value) {
        let Some(entry) = safe_npc_dossier_entry(candidate, options) else { continue };
        let id = str_field(&entry, "id").to_string();
        entries.shift_remove(&id);
        entries.insert(id, entry);
    }
    let normalized: Vec<Value> = entries.into_values().collect();
    if legacy_retention(options) {
        let skip = normalized.len().saturating_sub(NPC_DOSSIER_LEGACY_LIMIT);
        normalized.into_iter().skip(skip).collect()
    } else {
        normalized
    }
}

fn safe_profile(value: &Value, options: &Value) -> Value {
    let source = Some(value);
    let legacy = legacy_retention(options);
    let mut profile = Map::new();
    profile.insert("id".into(), string_value(&clean(get(source, "id"), 120)));
    profile.insert("name".into(), string_value(&clean(get(source, "name"), 160)));
    profile.insert("role".into(), string_value(&clean(get(source, "role"), 160)));
    profile.insert("location".into(), string_value(&clean(get(source, "location"), 180)));
    let location_id = clean(coalesce(get(source, "location_id"), get(source, "locationId")), 120);
    if !location_id.is_empty() {
        profile.insert("location_id".into(), string_value(&location_id));
    }
    profile.insert("public_summary".into(), string_value(&clean(get(source, "public_summary"), 1_000)));
    profile.insert("voice".into(), string_value(&clean(get(source, "voice"), 500)));
    profile.insert("speech_profile".into(), npc_speech_profile(value));
    profile.insert("goals".into(), strings_json(&strings(get(source, "goals"), 300, 12)));
    profile.insert("beliefs".into(), strings_json(&strings(get(source, "beliefs"), 300, 20)));
    profile.insert("known_fact_ids".into(), strings_json(&strings(get(source, "known_fact_ids"), 120, if legacy { 100 } else { usize::MAX })));
    profile.insert("social_dcs".into(), safe_social_dcs(get(source, "social_dcs")));
    profile.insert("visibility".into(), string_value(one_of(get(source, "visibility"), &PROFILE_VISIBILITIES).unwrap_or("party")));
    if js::is_true(get(source, "reveal_on_presence")) {
        profile.insert("reveal_on_presence".into(), Value::Bool(true));
    }
    profile.insert("available".into(), Value::Bool(!js::is_false(get(source, "available"))));
    profile.insert("tags".into(), strings_json(&strings(get(source, "tags"), 60, 20)));
    profile.insert("schedule".into(), schedule_json(&safe_schedule(get(source, "schedule"))));
    profile.insert(
        "inventory".into(),
        Value::Array(safe_inventory(get(source, "inventory"), options).iter().map(InventoryEntry::to_json).collect()),
    );
    profile.insert("dossier".into(), Value::Array(safe_npc_dossier(get(source, "dossier"), options)));
    Value::Object(profile)
}

fn minutes_or_null(value: Option<&Value>) -> Value {
    if js::present(value) && js::is_safe_integer_number(value) {
        Value::from(integer(value, 0).max(0))
    } else {
        Value::Null
    }
}

fn safe_promise(value: &Value) -> Value {
    let source = Some(value);
    let mut promise = Map::new();
    promise.insert("id".into(), string_value(&clean(get(source, "id"), 120)));
    promise.insert("npc_id".into(), string_value(&clean(get(source, "npc_id"), 120)));
    promise.insert("hero_id".into(), string_value(&clean(get(source, "hero_id"), 120)));
    promise.insert("direction".into(), string_value(one_of(get(source, "direction"), &PROMISE_DIRECTIONS).unwrap_or("npc_to_party")));
    promise.insert("text".into(), string_value(&clean(get(source, "text"), 500)));
    promise.insert("due_hint".into(), string_value(&clean(get(source, "due_hint"), 240)));
    promise.insert("status".into(), string_value(one_of(get(source, "status"), &PROMISE_STATUSES).unwrap_or("open")));
    promise.insert(
        "visibility".into(),
        string_value(if is_str(get(source, "visibility"), "specific_player") { "specific_player" } else { "party" }),
    );
    promise.insert("source_conversation_id".into(), string_value(&clean(get(source, "source_conversation_id"), 120)));
    promise.insert("created_at_minutes".into(), Value::from(integer(get(source, "created_at_minutes"), 0).max(0)));
    promise.insert("deadline_minutes".into(), minutes_or_null(get(source, "deadline_minutes")));
    promise.insert("resolved_at_minutes".into(), minutes_or_null(get(source, "resolved_at_minutes")));
    promise.insert(
        "resolution_reason".into(),
        one_of(get(source, "resolution_reason"), &["manual", "deadline"]).map_or(Value::Null, string_value),
    );
    promise.insert("consequence_delta".into(), Value::from(integer(get(source, "consequence_delta"), 0).clamp(-25, 25)));
    Value::Object(promise)
}

fn safe_social_check(value: Option<&Value>) -> Option<Value> {
    let source @ Some(Value::Object(_)) = value else { return None };
    let skill = clean(get(source, "skill"), 30);
    if !SOCIAL_CHECK_SKILLS.contains(&skill.as_str()) {
        return None;
    }
    let success = js::is_true(get(source, "success"));
    let degree = one_of(get(source, "degree"), &SOCIAL_CHECK_DEGREES).unwrap_or(if success { "success" } else { "failure" });
    Some(json!({
        "check_id": clean(get(source, "check_id"), 120),
        "npc_id": clean(get(source, "npc_id"), 120),
        "skill": skill,
        "ability": clean(get(source, "ability"), 10),
        "roll_id": clean(get(source, "roll_id"), 120),
        "total": integer(get(source, "total"), 0).clamp(-50, 100),
        "modifier": integer(get(source, "modifier"), 0).clamp(-30, 30),
        "success": success,
        "degree": degree,
    }))
}

fn safe_conversation(value: &Value, options: &Value) -> Value {
    let source = Some(value);
    let id_limit = if legacy_retention(options) { 20 } else { usize::MAX };
    let mut conversation = Map::new();
    conversation.insert("id".into(), string_value(&clean(get(source, "id"), 120)));
    conversation.insert("npc_id".into(), string_value(&clean(get(source, "npc_id"), 120)));
    conversation.insert("hero_id".into(), string_value(&clean(get(source, "hero_id"), 120)));
    conversation.insert("player_message".into(), string_value(&clean(get(source, "player_message"), 1_000)));
    conversation.insert("npc_reply".into(), string_value(&clean(get(source, "npc_reply"), 1_000)));
    conversation.insert("stance".into(), string_value(one_of(get(source, "stance"), &STANCES).unwrap_or("neutral")));
    conversation.insert("disclosed_fact_ids".into(), strings_json(&strings(get(source, "disclosed_fact_ids"), 120, id_limit)));
    conversation.insert("disclosed_claim_ids".into(), strings_json(&strings(get(source, "disclosed_claim_ids"), 120, id_limit)));
    conversation.insert(
        "visibility".into(),
        string_value(if is_str(get(source, "visibility"), "specific_player") { "specific_player" } else { "party" }),
    );
    if let Some(check) = safe_social_check(get(source, "check")) {
        conversation.insert("check".into(), check);
    }
    Value::Object(conversation)
}

fn dossier_entry_from_conversation(conversation: &Value, event: &Value, options: &Value) -> Option<Value> {
    let source = Some(conversation);
    let hero_line = clean(get(source, "player_message"), 240);
    let npc_line = clean(get(source, "npc_reply"), 320);
    let mut lines: Vec<String> = Vec::new();
    if !hero_line.is_empty() {
        lines.push(format!("Герой сказал: «{hero_line}»."));
    }
    if !npc_line.is_empty() {
        lines.push(format!("Ответ NPC: «{npc_line}»."));
    }
    let claims: Vec<Value> = array(get(source, "disclosed_claim_ids")).iter().map(|id| json!({ "id": id })).collect();
    let draft = json!({
        "id": format!("interaction:{}", tpl(get(source, "id"))),
        "hero_id": element(get(source, "hero_id")),
        "summary": lines.join(" "),
        "stance": element(get(source, "stance")),
        "visibility": element(get(source, "visibility")),
        "disclosed_fact_ids": element(get(source, "disclosed_fact_ids")),
        "disclosed_claims": claims,
        "provenance": {
            "source_conversation_id": element(get(source, "id")),
            "source_event_ids": [element(get(Some(event), "event_id"))],
        },
    });
    safe_npc_dossier_entry(&draft, options)
}

// ── Нормализация состояния ──────────────────────────────────────────────────

fn social_part<'a>(social: &'a Value, key: &str) -> &'a [Value] {
    array(social.get(key))
}

/// Нормализованное социальное состояние (`normalizeNpcSocialState`).
/// `options` — режим удержания (см. модуль); `Value::Null` — из контекста.
pub fn normalize_npc_social_state(input: &Value, options: &Value) -> Value {
    let legacy = legacy_retention(options);
    let source = if input.is_object() { Some(input) } else { Some(empty()) };
    let mut npcs: Vec<Value> = array(get(source, "npcs"))
        .iter()
        .map(|npc| safe_profile(npc, options))
        .filter(|npc| !str_field(npc, "id").is_empty() && !str_field(npc, "name").is_empty())
        .collect();
    if legacy {
        npcs.truncate(500);
    }
    let npc_ids: HashSet<String> = npcs.iter().map(|npc| str_field(npc, "id").to_string()).collect();

    let mut relationship_entries = object_entries(coalesce(get(source, "relationships"), None));
    if legacy {
        relationship_entries.truncate(500);
    }
    let mut relationships = Map::new();
    for (npc_id, value) in relationship_entries {
        let key = clean_str(&npc_id, 120);
        if !npc_ids.contains(&key) || !value.is_object() {
            continue;
        }
        let mut hero_entries = object_entries(Some(&value));
        if legacy {
            hero_entries.truncate(100);
        }
        let mut heroes = Map::new();
        for (hero_id, score) in hero_entries {
            let hero = clean_str(&hero_id, 120);
            if hero.is_empty() {
                continue;
            }
            heroes.insert(hero, Value::from(integer(Some(&score), 0).clamp(-100, 100)));
        }
        relationships.insert(key, Value::Object(js_order(heroes)));
    }
    let relationships = js_order(relationships);

    let mut conversations: Vec<Value> = array(get(source, "conversations"))
        .iter()
        .map(|item| safe_conversation(item, options))
        .filter(|item| {
            !str_field(item, "id").is_empty() && npc_ids.contains(str_field(item, "npc_id")) && !str_field(item, "hero_id").is_empty() && !str_field(item, "npc_reply").is_empty()
        })
        .collect();
    if legacy {
        let skip = conversations.len().saturating_sub(500);
        conversations.drain(..skip);
    }
    let conversation_ids: HashSet<String> = conversations.iter().map(|item| str_field(item, "id").to_string()).collect();
    let mut promises: Vec<Value> = array(get(source, "promises"))
        .iter()
        .map(safe_promise)
        .filter(|item| {
            let source_conversation = str_field(item, "source_conversation_id");
            !str_field(item, "id").is_empty()
                && npc_ids.contains(str_field(item, "npc_id"))
                && !str_field(item, "text").is_empty()
                && (source_conversation.is_empty() || conversation_ids.contains(source_conversation))
        })
        .collect();
    if legacy {
        let skip = promises.len().saturating_sub(500);
        promises.drain(..skip);
    }
    let mut relationship_tiers = Map::new();
    for (npc_id, heroes) in &relationships {
        let tiers: Map<String, Value> = heroes
            .as_object()
            .map(|heroes| heroes.iter().map(|(hero_id, score)| (hero_id.clone(), string_value(relationship_tier(score)))).collect())
            .unwrap_or_default();
        relationship_tiers.insert(npc_id.clone(), Value::Object(tiers));
    }
    let mut social = Map::new();
    social.insert("schema_version".into(), Value::from(4));
    social.insert("npcs".into(), Value::Array(npcs));
    social.insert("relationships".into(), Value::Object(relationships));
    social.insert("relationship_tiers".into(), Value::Object(relationship_tiers));
    social.insert("conversations".into(), Value::Array(conversations));
    social.insert("promises".into(), Value::Array(promises));
    Value::Object(social)
}

/// Воспроизводит ограниченный social reducer для legacy-состояния коммита
/// (`normalizeNpcSocialStateLegacy`).
pub fn normalize_npc_social_state_legacy(input: &Value) -> Value {
    normalize_npc_social_state(input, &json!({ "isLegacy": true }))
}

fn profile_from_merchant(merchant: &Value) -> Value {
    let source = Some(merchant);
    let title = get(source, "title");
    let role = if js::truthy(title) { element(title) } else { string_value("merchant") };
    let voice = get(source, "voice");
    let voice = if js::truthy(voice) { element(voice) } else { element(get(source, "greeting")) };
    let draft = json!({
        "id": element(get(source, "id")),
        "name": element(get(source, "name")),
        "role": role,
        "location": element(get(source, "location")),
        "public_summary": element(get(source, "description")),
        "voice": voice,
        "goals": [], "beliefs": [], "known_fact_ids": [], "visibility": "party",
        "available": !js::is_false(get(source, "available")),
        "tags": ["merchant"], "schedule": [], "inventory": [],
    });
    safe_profile(&draft, &NULL)
}

/// Социальное состояние с профилями постоянных торговцев и NPC памяти мира
/// (`ensureNpcSocialState`). Им пользуется весь сервер: каждое чтение
/// социального состояния идёт через эту нормализацию.
pub fn ensure_npc_social_state(input: &Value, state: &Value, options: &Value) -> Value {
    let social = normalize_npc_social_state(input, options);
    let state = Some(state);
    let mut profiles: IndexMap<String, Value> = IndexMap::new();
    for npc in social_part(&social, "npcs") {
        profiles.insert(str_field(npc, "id").to_string(), npc.clone());
    }
    for merchant in iterate(coalesce(get(state, "merchants"), None)) {
        let profile = profile_from_merchant(&merchant);
        let id = str_field(&profile, "id").to_string();
        if id.is_empty() || str_field(&profile, "name").is_empty() {
            continue;
        }
        let mut merged = spread_of(Some(&profile));
        if let Some(Value::Object(existing)) = profiles.get(&id) {
            for (key, value) in existing {
                merged.insert(key.clone(), value.clone());
            }
        }
        merged.insert("location".into(), string_value(&clean(get(Some(&merchant), "location"), 180)));
        merged.insert("available".into(), Value::Bool(!js::is_false(get(Some(&merchant), "available"))));
        profiles.insert(id, Value::Object(merged));
    }
    for entity in iterate(coalesce(get(get(state, "worldMemory"), "entities"), None)) {
        let entity = Some(&entity);
        let id = get(entity, "id");
        if !is_str(get(entity, "kind"), "npc") || !js::truthy(id) || !js::truthy(get(entity, "name")) || profiles.contains_key(&tpl(id)) {
            continue;
        }
        let visibility = match get(entity, "visibility").and_then(Value::as_str) {
            Some("public") => "public",
            Some("party") => "party",
            _ => "gm_only",
        };
        let draft = json!({
            "id": element(id),
            "name": element(get(entity, "name")),
            "public_summary": element(get(entity, "summary")),
            "location": "",
            "visibility": visibility,
            "available": true,
            "tags": element(get(entity, "tags")),
        });
        profiles.insert(tpl(id), safe_profile(&draft, &NULL));
    }
    let mut merged = social.as_object().cloned().unwrap_or_default();
    merged.insert("npcs".into(), Value::Array(profiles.into_values().collect()));
    normalize_npc_social_state(&Value::Object(merged), options)
}

// ── Профиль во времени и для зрителя ────────────────────────────────────────

fn elapsed_minutes_for(value: &Value) -> f64 {
    match value {
        Value::Number(number) if number.as_f64().is_some_and(is_safe) => max0(number.as_f64().unwrap_or(0.0)),
        other => campaign_elapsed_minutes(other),
    }
}

fn viewer_may_see(visibility: Option<&Value>, viewer: &Value) -> bool {
    let viewer = Some(viewer);
    js::is_true(get(viewer, "isAdmin")) || is_str(visibility, "public") || (is_str(visibility, "party") && !js::is_false(get(viewer, "isPartyMember")))
}

fn schedule_entry_at(profile: &Value, state_or_elapsed: &Value) -> Option<ScheduleEntry> {
    let elapsed = elapsed_minutes_for(state_or_elapsed);
    let day = (elapsed / 1_440.0).floor() % 7.0;
    let minute = elapsed % 1_440.0;
    safe_schedule(get(Some(profile), "schedule")).into_iter().find(|entry| {
        (entry.days.is_empty() || entry.days.iter().any(|candidate| *candidate as f64 == day)) && (entry.start as f64) <= minute && minute < entry.end as f64
    })
}

/// Действующая запись расписания (`npcScheduleEntryAt`) без изменения
/// сохранённого профиля. Второй аргумент — состояние кампании или число минут.
pub fn npc_schedule_entry_at(profile: &Value, state_or_elapsed_minutes: &Value) -> Option<Value> {
    schedule_entry_at(profile, state_or_elapsed_minutes).map(|entry| entry.to_json())
}

/// Профиль в текущий момент мира (`npcProfileAtWorldTime`): расписание
/// переносит место и доступность, смерть и участие в бою делают NPC
/// недоступным. Вывод, а не запись: базовое место в журнале не меняется.
pub fn npc_profile_at_world_time(profile: &Value, state_or_elapsed_minutes: &Value) -> Value {
    let normalized = safe_profile(profile, &NULL);
    let mut current = normalized.as_object().cloned().unwrap_or_default();
    if let Some(active) = schedule_entry_at(&normalized, state_or_elapsed_minutes) {
        current.insert("location".into(), string_value(&active.location));
        current.insert("available".into(), Value::Bool(active.available));
    }
    let source = Some(state_or_elapsed_minutes);
    let world = if state_or_elapsed_minutes.is_object() { get(source, "npc_world") } else { None };
    let id = str_field(&normalized, "id");
    let vital = match get(world, "vitals") {
        Some(Value::Object(vitals)) => vitals.get(id),
        _ => None,
    };
    let mut combat_npc_ids: HashSet<String> = HashSet::new();
    if js::is_true(get(get(get(source, "mechanics"), "combat"), "active")) {
        for actor in array(get(source, "enemies")).iter().chain(array(get(source, "actors"))) {
            let npc_id = js::s(get(get(Some(actor), "origin"), "npc_id"));
            if !npc_id.is_empty() {
                combat_npc_ids.insert(npc_id);
            }
        }
    }
    if js::is_false(get(vital, "alive")) || js::number(get(vital, "hp")) <= 0.0 || combat_npc_ids.contains(id) {
        current.insert("available".into(), Value::Bool(false));
    }
    Value::Object(current)
}

/// Белый список профиля NPC для игрока — **одна** функция на все каналы
/// (`npcProfileForViewerAt`): её читает и проекция состояния, и канал событий.
/// `viewer` — `{ isAdmin, isPartyMember, playerId, state | elapsed_minutes }`.
pub fn npc_profile_for_viewer_at(profile: &Value, viewer: &Value) -> Value {
    profile_for_viewer_at(profile, viewer, None)
}

/// [`npc_profile_for_viewer_at`]; `state` — `viewer.state`, переданное
/// отдельно, чтобы не копировать состояние в карточку зрителя (Ск4).
fn profile_for_viewer_at(profile: &Value, viewer: &Value, state: Option<&Value>) -> Value {
    let viewer = or_empty(viewer);
    let normalized = safe_profile(profile, &NULL);
    let source = Some(viewer);
    let when = state.unwrap_or_else(|| coalesce(get(source, "state"), coalesce(get(source, "elapsed_minutes"), Some(empty()))).unwrap_or(empty()));
    let active = schedule_entry_at(&normalized, when);
    // Скрытое расписание влияет на игру, но не выдаёт закрытое место: игрок
    // видит только, что с NPC сейчас не поговорить.
    let current = match active {
        Some(entry) if !viewer_may_see(Some(&string_value(&entry.visibility)), viewer) => {
            let mut hidden = normalized.as_object().cloned().unwrap_or_default();
            hidden.insert("location".into(), string_value(""));
            hidden.insert("available".into(), Value::Bool(false));
            Value::Object(hidden)
        }
        _ => npc_profile_at_world_time(&normalized, when),
    };
    let is_admin = js::is_true(get(source, "isAdmin"));
    // Теги изнанки столу не принадлежат: игрок узнаёт «скупщика» и
    // «неподкупного» следствием, а не описью; у ведущего закрытого нет.
    let tags: Vec<Value> = array(current.get("tags"))
        .iter()
        .filter(|tag| is_admin || !UNDERWORLD_PRIVATE_TAGS.contains(&tpl(Some(tag)).as_str()))
        .cloned()
        .collect();
    let inventory: Vec<Value> = array(current.get("inventory"))
        .iter()
        .filter(|item| item.get("quantity").and_then(Value::as_i64).unwrap_or(0) > 0 && viewer_may_see(item.get("visibility"), viewer))
        .map(|item| {
            json!({
                "id": element(item.get("id")),
                "name": element(item.get("name")),
                "quantity": element(item.get("quantity")),
                "description": element(item.get("description")),
            })
        })
        .collect();
    let player_id = clean(get(source, "playerId"), 120);
    let dossier: Vec<Value> = array(current.get("dossier"))
        .iter()
        .filter(|entry| {
            let visibility = entry.get("visibility");
            is_admin
                || is_str(visibility, "public")
                || (is_str(visibility, "party") && !js::is_false(get(source, "isPartyMember")))
                || (is_str(visibility, "specific_player") && str_field(entry, "hero_id") == player_id)
        })
        .map(|entry| {
            let mut visible = entry.as_object().cloned().unwrap_or_default();
            visible.shift_remove("visibility");
            clone_js(&Value::Object(visible))
        })
        .collect();
    let skip = dossier.len().saturating_sub(NPC_DOSSIER_PROFILE_LIMIT);
    let mut result = Map::new();
    for key in ["id", "name", "role", "location", "public_summary", "voice", "available"] {
        put_opt(&mut result, key, current.get(key));
    }
    result.insert("tags".into(), Value::Array(tags));
    result.insert("inventory".into(), Value::Array(inventory));
    result.insert("dossier".into(), Value::Array(dossier.into_iter().skip(skip).collect()));
    Value::Object(result)
}

// ── Граница знания NPC ──────────────────────────────────────────────────────
//
// NPC знает только:
// - своё — id из `known_fact_ids` (так стартовые NPC получают пролог и тайны);
// - публичное (`public`) — то, что знает весь мир;
// - факты отряда, которые он видел сам: факт привязан к месту (подлежащее —
//   сущность-локация), NPC стоял там в минуту записи, и отряд был там же;
//   факт без места считается не увиденным;
// - заготовки ведущего (`gm_secret`), где он назван хранителем, а у заготовки
//   места без хранителя — одного жителя этого места, выбранного сервером
//   (`implicit_secret_holder_ids`).

fn place_key(value: Option<&Value>) -> String {
    clean_lower(value, 180).replace('ё', "е")
}

fn knowledge_stems(value: &str) -> HashSet<String> {
    let lowered = text::lower(&clean_str(value, 2_000)).replace('ё', "е");
    text::find_all(re!(r"\p{L}{5,}", "gu"), &lowered).into_iter().map(|word| text::head(&word, 5)).collect()
}

/// Детерминированный разрыв ничьей без криптографии: FNV-1a по кодовым точкам.
fn stable_order(value: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for ch in value.chars() {
        hash ^= ch as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// Поля заготовки ведущего из JSON `object` (`npcSecretMeta`): тема, хранитель и
/// герой, к предыстории которого она привязана.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NpcSecretMeta {
    pub topic: String,
    pub holder: String,
    pub hero_id: String,
}

impl NpcSecretMeta {
    /// Запись в форме JS.
    pub fn to_json(&self) -> Value {
        json!({ "topic": self.topic, "holder": self.holder, "hero_id": self.hero_id })
    }
}

/// Тема, хранитель и герой заготовки ведущего (`npcSecretMeta`); неразборчивый
/// JSON — пустые поля.
pub fn npc_secret_meta(fact: &Value) -> NpcSecretMeta {
    let raw = js::s(get(Some(fact), "object"));
    match js_json::parse(&raw) {
        Some(parsed) => {
            let field = |key: &str, maximum: usize| clean_str(&parsed.field(key).map(js_json::Json::to_js_string).unwrap_or_default(), maximum);
            NpcSecretMeta { topic: field("topic", 200), holder: field("holder", 120), hero_id: field("hero_id", 120) }
        }
        None => NpcSecretMeta::default(),
    }
}

/// `JSON.parse` для заготовки ведущего. `serde_json` отвергает числа вне
/// диапазона f64 (`1e400`), а JS читает их как `Infinity`, и `String(…)` поля
/// даёт `"Infinity"`; здесь числа — f64 JS, остальное — грамматика JSON.
mod js_json {
    use sk_core::js;

    pub(super) enum Json {
        Null,
        Bool(bool),
        Number(f64),
        Text(String),
        Array(Vec<Json>),
        Object(Vec<(String, Json)>),
    }

    impl Json {
        /// `parsed?.[key]`: поле объекта (последнее из повторов, как `JSON.parse`).
        pub(super) fn field(&self, key: &str) -> Option<&Json> {
            match self {
                Json::Object(fields) => fields.iter().rev().find(|(name, _)| name == key).map(|(_, value)| value),
                _ => None,
            }
        }

        /// `String(value ?? '')`.
        pub(super) fn to_js_string(&self) -> String {
            match self {
                Json::Null => String::new(),
                Json::Bool(flag) => flag.to_string(),
                Json::Number(number) => js::f64_string(*number),
                Json::Text(text) => text.clone(),
                Json::Array(items) => items.iter().map(Json::to_js_string).collect::<Vec<_>>().join(","),
                Json::Object(_) => "[object Object]".into(),
            }
        }
    }

    /// Предел вложенности: глубже — отказ разбора, а не переполнение стека.
    const MAX_DEPTH: usize = 512;

    struct Parser<'a> {
        bytes: &'a [u8],
        text: &'a str,
        at: usize,
    }

    pub(super) fn parse(text: &str) -> Option<Json> {
        let mut parser = Parser { bytes: text.as_bytes(), text, at: 0 };
        parser.space();
        let value = parser.value(0)?;
        parser.space();
        (parser.at == parser.bytes.len()).then_some(value)
    }

    impl Parser<'_> {
        fn space(&mut self) {
            while matches!(self.bytes.get(self.at), Some(b' ' | b'\t' | b'\n' | b'\r')) {
                self.at += 1;
            }
        }

        fn eat(&mut self, literal: &str) -> bool {
            if self.text[self.at..].starts_with(literal) {
                self.at += literal.len();
                true
            } else {
                false
            }
        }

        fn value(&mut self, depth: usize) -> Option<Json> {
            if depth > MAX_DEPTH {
                return None;
            }
            match *self.bytes.get(self.at)? {
                b'n' => self.eat("null").then_some(Json::Null),
                b't' => self.eat("true").then_some(Json::Bool(true)),
                b'f' => self.eat("false").then_some(Json::Bool(false)),
                b'"' => self.string().map(Json::Text),
                b'[' => {
                    self.at += 1;
                    let mut items = Vec::new();
                    self.space();
                    if self.eat("]") {
                        return Some(Json::Array(items));
                    }
                    loop {
                        self.space();
                        items.push(self.value(depth + 1)?);
                        self.space();
                        if self.eat("]") {
                            return Some(Json::Array(items));
                        }
                        if !self.eat(",") {
                            return None;
                        }
                    }
                }
                b'{' => {
                    self.at += 1;
                    let mut fields = Vec::new();
                    self.space();
                    if self.eat("}") {
                        return Some(Json::Object(fields));
                    }
                    loop {
                        self.space();
                        if self.bytes.get(self.at) != Some(&b'"') {
                            return None;
                        }
                        let key = self.string()?;
                        self.space();
                        if !self.eat(":") {
                            return None;
                        }
                        self.space();
                        fields.push((key, self.value(depth + 1)?));
                        self.space();
                        if self.eat("}") {
                            return Some(Json::Object(fields));
                        }
                        if !self.eat(",") {
                            return None;
                        }
                    }
                }
                b'-' | b'0'..=b'9' => self.number(),
                _ => None,
            }
        }

        fn digits(&mut self) -> usize {
            let start = self.at;
            while matches!(self.bytes.get(self.at), Some(b'0'..=b'9')) {
                self.at += 1;
            }
            self.at - start
        }

        fn number(&mut self) -> Option<Json> {
            let start = self.at;
            if self.bytes.get(self.at) == Some(&b'-') {
                self.at += 1;
            }
            if self.bytes.get(self.at) == Some(&b'0') {
                self.at += 1;
            } else if self.digits() == 0 {
                return None;
            }
            if self.bytes.get(self.at) == Some(&b'.') {
                self.at += 1;
                if self.digits() == 0 {
                    return None;
                }
            }
            if matches!(self.bytes.get(self.at), Some(b'e' | b'E')) {
                self.at += 1;
                if matches!(self.bytes.get(self.at), Some(b'+' | b'-')) {
                    self.at += 1;
                }
                if self.digits() == 0 {
                    return None;
                }
            }
            self.text[start..self.at].parse::<f64>().ok().map(Json::Number)
        }

        fn hex4(&mut self) -> Option<u32> {
            let digits = self.text.get(self.at..self.at + 4)?;
            if !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return None;
            }
            self.at += 4;
            u32::from_str_radix(digits, 16).ok()
        }

        fn string(&mut self) -> Option<String> {
            self.at += 1;
            let mut out = String::new();
            loop {
                let rest = &self.text[self.at..];
                let ch = rest.chars().next()?;
                self.at += ch.len_utf8();
                match ch {
                    '"' => return Some(out),
                    '\u{0}'..='\u{1f}' => return None,
                    '\\' => {
                        let escape = *self.bytes.get(self.at)?;
                        self.at += 1;
                        match escape {
                            b'"' => out.push('"'),
                            b'\\' => out.push('\\'),
                            b'/' => out.push('/'),
                            b'b' => out.push('\u{8}'),
                            b'f' => out.push('\u{c}'),
                            b'n' => out.push('\n'),
                            b'r' => out.push('\r'),
                            b't' => out.push('\t'),
                            b'u' => {
                                let unit = self.hex4()?;
                                let code = if (0xD800..0xDC00).contains(&unit) && self.text[self.at..].starts_with("\\u") {
                                    let save = self.at;
                                    self.at += 2;
                                    match self.hex4() {
                                        Some(low) if (0xDC00..0xE000).contains(&low) => 0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00),
                                        _ => {
                                            self.at = save;
                                            unit
                                        }
                                    }
                                } else {
                                    unit
                                };
                                // Одиночная половина суррогатной пары в строке Rust
                                // невозможна; JS хранит её как есть.
                                out.push(char::from_u32(code).unwrap_or('\u{FFFD}'));
                            }
                            _ => return None,
                        }
                    }
                    other => out.push(other),
                }
            }
        }
    }
}

fn location_entities_by_id(state: &Value) -> IndexMap<String, &Value> {
    let mut locations: IndexMap<String, &Value> = IndexMap::new();
    for entity in array(get(get(Some(state), "worldMemory"), "entities")) {
        let source = Some(entity);
        if is_str(get(source, "kind"), "location") && js::truthy(get(source, "id")) && js::truthy(get(source, "name")) {
            locations.insert(tpl(get(source, "id")), entity);
        }
    }
    locations
}

fn world_facts(state: &Value) -> Vec<Value> {
    iterate(coalesce(get(get(Some(state), "worldMemory"), "facts"), None))
}

/// Где стоял отряд, когда записан каждый факт: старт — место пролога, каждое
/// прибытие (`party_arrived`) переносит отряд. Пустая строка — место неизвестно.
fn party_place_by_fact(state: &Value, locations: &IndexMap<String, &Value>) -> HashMap<String, String> {
    let mut places: HashMap<String, String> = HashMap::new();
    let mut current = String::new();
    for fact in world_facts(state) {
        let source = Some(&fact);
        let subject = locations.get(&js::s(get(source, "subject_id")));
        let predicate = get(source, "predicate");
        if is_str(predicate, "party_arrived") && subject.is_some() {
            current = place_key(subject.and_then(|subject| subject.get("name")));
        } else if current.is_empty() && is_str(predicate, "opening_narration") && subject.is_some() {
            current = place_key(subject.and_then(|subject| subject.get("name")));
        }
        places.insert(js::s(get(source, "id")), current.clone());
    }
    places
}

fn npc_witnessed_fact(profile: &Value, fact: &Value, locations: &IndexMap<String, &Value>, party_places: &HashMap<String, String>) -> bool {
    let source = Some(fact);
    let Some(subject) = locations.get(&js::s(get(source, "subject_id"))) else { return false };
    let place = place_key(subject.get("name"));
    let party_place = party_places.get(&js::s(get(source, "id"))).cloned().unwrap_or_default();
    if !party_place.is_empty() && party_place != place {
        return false;
    }
    let minutes = js::number(get(source, "recorded_at_minutes"));
    let when = if is_safe(minutes) { max0(minutes) } else { 0.0 };
    let then = npc_profile_at_world_time(profile, &js::num(when));
    let subject_id = tpl(subject.get("id"));
    if js::truthy(then.get("location_id")) && is_str(then.get("location_id"), &subject_id) {
        return true;
    }
    js::truthy(then.get("location")) && place_key(then.get("location")) == place
}

/// Хранитель заготовки места, у которой автор хранителя не назвал
/// (`implicitSecretHolderIds`): житель этого места, чья роль ближе всего к теме
/// тайны; ничья решается стабильным хешем. Вывод из состояния, а не событие.
/// `social` — нормализованное социальное состояние; `None` — как в JS,
/// `ensure_npc_social_state(state.social, state)`.
///
/// Возвращает id факта → id NPC в порядке фактов.
pub fn implicit_secret_holder_ids(state: &Value, social: Option<&Value>) -> IndexMap<String, String> {
    let owned;
    let social = match social {
        Some(social) => social,
        None => {
            owned = ensure_npc_social_state(&element(get(Some(state), "social")), state, &NULL);
            &owned
        }
    };
    let locations = location_entities_by_id(state);
    let mut explicitly_known: HashSet<String> = HashSet::new();
    for npc in array(get(Some(social), "npcs")) {
        match coalesce(get(Some(npc), "known_fact_ids"), None) {
            Some(Value::Array(items)) => explicitly_known.extend(items.iter().filter_map(Value::as_str).map(str::to_string)),
            Some(Value::String(single)) => {
                explicitly_known.insert(single.clone());
            }
            _ => {}
        }
    }
    let npcs = array(get(Some(social), "npcs"));
    let mut holders: IndexMap<String, String> = IndexMap::new();
    for fact in world_facts(state) {
        let source = Some(&fact);
        if !is_str(get(source, "predicate"), "gm_secret") || is_str(get(source, "status"), "superseded") {
            continue;
        }
        let fact_id = js::s(get(source, "id"));
        if fact_id.is_empty() || fact_id.starts_with(SCENARIO_SECRET_PREFIX) || explicitly_known.contains(&fact_id) {
            continue;
        }
        let meta = npc_secret_meta(&fact);
        if !meta.holder.is_empty() {
            continue;
        }
        let Some(subject) = locations.get(&js::s(get(source, "subject_id"))) else { continue };
        let place = place_key(subject.get("name"));
        let subject_id = tpl(subject.get("id"));
        let topic = knowledge_stems(&format!("{} {}", meta.topic, js::s(get(source, "summary"))));
        let mut candidates: Vec<(&Value, usize, u32)> = npcs
            .iter()
            .filter(|npc| {
                let npc_source = Some(*npc);
                let location_id = get(npc_source, "location_id");
                let location = get(npc_source, "location");
                !is_str(get(npc_source, "visibility"), "gm_only")
                    && !js::is_false(get(npc_source, "available"))
                    && ((js::truthy(location_id) && is_str(location_id, &subject_id)) || (js::truthy(location) && place_key(location) == place))
            })
            .map(|npc| {
                let npc_source = Some(npc);
                let stems = knowledge_stems(&format!("{} {}", tpl(get(npc_source, "role")), tpl(get(npc_source, "public_summary"))));
                let score = stems.iter().filter(|stem| topic.contains(*stem)).count();
                let order = stable_order(&format!("{fact_id}\u{0}{}", tpl(get(npc_source, "id"))));
                (npc, score, order)
            })
            .collect();
        candidates.sort_by(|left, right| right.1.cmp(&left.1).then(left.2.cmp(&right.2)));
        if let Some((npc, _, _)) = candidates.first() {
            holders.insert(fact_id, tpl(npc.get("id")));
        }
    }
    holders
}

/// Что NPC может знать и произнести (`npcKnownFactIds`). Статус факта
/// (`active`) проверяет вызывающий: здесь граница знания, а не актуальность.
/// `profile` — профиль NPC; для ещё не заведённого NPC — черновик с местом и именем.
pub fn npc_known_fact_ids(state: &Value, profile: &Value) -> IndexSet<String> {
    let social = ensure_npc_social_state(&element(get(Some(state), "social")), state, &NULL);
    let npc_id = clean(get(Some(profile), "id"), 120);
    let persisted = (!npc_id.is_empty())
        .then(|| social_part(&social, "npcs").iter().find(|npc| str_field(npc, "id") == npc_id).cloned())
        .flatten()
        .unwrap_or_else(|| safe_profile(profile, &NULL));
    let mut known: IndexSet<String> = IndexSet::new();
    for id in array(persisted.get("known_fact_ids")) {
        known.insert(js::s(Some(id)));
    }
    for id in strings(get(Some(profile), "known_fact_ids"), 120, usize::MAX) {
        known.insert(id);
    }
    let locations = location_entities_by_id(state);
    let party_places = party_place_by_fact(state, &locations);
    let implicit = implicit_secret_holder_ids(state, Some(&social));
    let name_key = place_key(persisted.get("name"));
    let persisted_id = str_field(&persisted, "id").to_string();
    // Сущность памяти мира, которая и есть этот NPC: факты о нём самом — его.
    let mut self_entity_ids: HashSet<String> = HashSet::new();
    for entity in array(get(get(Some(state), "worldMemory"), "entities")) {
        let source = Some(entity);
        if is_str(get(source, "kind"), "npc") && (tpl(get(source, "id")) == persisted_id || (!name_key.is_empty() && place_key(get(source, "name")) == name_key)) {
            self_entity_ids.insert(tpl(get(source, "id")));
        }
    }
    if !persisted_id.is_empty() {
        self_entity_ids.insert(persisted_id);
    }
    for fact in world_facts(state) {
        let source = Some(&fact);
        let fact_id = js::s(get(source, "id"));
        if fact_id.is_empty() || known.contains(&fact_id) {
            continue;
        }
        let visibility = get(source, "visibility");
        if is_str(visibility, "public") {
            known.insert(fact_id);
        } else if is_str(visibility, "party") {
            // Находка, которая заменила известную NPC тайну, — та же правда. Факт
            // о самом NPC — его собственная история, кроме находки отряда о нём.
            let supersedes = get(source, "supersedes_fact_id");
            if (js::truthy(supersedes) && known.contains(&tpl(supersedes)))
                || (self_entity_ids.contains(&js::s(get(source, "subject_id"))) && !is_str(get(source, "predicate"), "discovery"))
                || npc_witnessed_fact(&persisted, &fact, &locations, &party_places)
            {
                known.insert(fact_id);
            }
        } else if is_str(get(source, "predicate"), "gm_secret") {
            let holder = npc_secret_meta(&fact).holder;
            if (!holder.is_empty() && !name_key.is_empty() && place_key(Some(&string_value(&holder))) == name_key)
                || (!npc_id.is_empty() && implicit.get(&fact_id).is_some_and(|holder_id| *holder_id == npc_id))
            {
                known.insert(fact_id);
            }
        }
    }
    known
}

/// Публичные и увиденные NPC факты отряда (`npcWitnessedFactIds`) — то, что
/// новый житель места знает, едва появившись. Тайны сюда не входят.
pub fn npc_witnessed_fact_ids(state: &Value, profile: &Value) -> Vec<String> {
    let locations = location_entities_by_id(state);
    let party_places = party_place_by_fact(state, &locations);
    let draft = safe_profile(profile, &NULL);
    array(get(get(Some(state), "worldMemory"), "facts"))
        .iter()
        .filter(|fact| !is_str(get(Some(fact), "status"), "superseded") && js::truthy(get(Some(fact), "id")))
        .filter(|fact| {
            let visibility = get(Some(fact), "visibility");
            is_str(visibility, "public") || (is_str(visibility, "party") && npc_witnessed_fact(&draft, fact, &locations, &party_places))
        })
        .map(|fact| clean(get(Some(fact), "id"), 120))
        .collect()
}

// ── Проверка команд ─────────────────────────────────────────────────────────

const SCHEDULE_FIELDS: [&str; 8] = ["id", "days", "start_minute", "end_minute", "location", "available", "summary", "visibility"];
const INVENTORY_FIELDS: [&str; 5] = ["id", "name", "quantity", "description", "visibility"];
const PROFILE_FIELDS: [&str; 19] = [
    "id", "name", "role", "location", "location_id", "public_summary", "voice", "speech_profile", "goals", "beliefs", "known_fact_ids", "social_dcs", "visibility",
    "reveal_on_presence", "available", "tags", "schedule", "inventory", "dossier",
];
const CONVERSATION_FIELDS: [&str; 12] = [
    "id", "npc_id", "hero_id", "player_message", "npc_reply", "stance", "disclosed_fact_ids", "disclosed_claim_ids", "relationship_delta", "visibility", "promise", "check",
];
const PROMISE_FIELDS: [&str; 5] = ["id", "direction", "text", "due_hint", "visibility"];

fn strict_schedule_input(value: Option<&Value>) -> Checked<Vec<ScheduleEntry>> {
    if !js::present(value) {
        return Ok(Vec::new());
    }
    let items = match value {
        Some(Value::Array(items)) if items.len() <= 64 => items,
        _ => return fail("NPC schedule must contain at most 64 entries", "NPC_SOCIAL_SCHEDULE_INVALID"),
    };
    for entry in items {
        let item = object(Some(entry), "npc.schedule entry")?;
        fields(item, &SCHEDULE_FIELDS, "npc.schedule entry")?;
        identifier(item.get("id"), "npc.schedule.id")?;
        let days_ok = matches!(item.get("days"), Some(Value::Array(days)) if days.len() <= 7 && days.iter().all(|day| week_day(day).is_some()));
        if !days_ok {
            return fail("NPC schedule days must be weekdays 0 through 6", "NPC_SOCIAL_SCHEDULE_INVALID");
        }
        let start = js::number(item.get("start_minute"));
        let end = js::number(item.get("end_minute"));
        if clean(item.get("location"), 180).is_empty() || !is_safe(start) || !is_safe(end) || start < 0.0 || start >= 1_440.0 || end <= start || end > 1_440.0 {
            return fail("NPC schedule interval is invalid", "NPC_SOCIAL_SCHEDULE_INVALID");
        }
        if js::present(item.get("visibility")) && one_of(item.get("visibility"), &PROFILE_VISIBILITIES).is_none() {
            return fail("NPC schedule visibility is invalid", "NPC_SOCIAL_SCHEDULE_INVALID");
        }
    }
    let normalized = safe_schedule(value);
    if normalized.len() != items.len() {
        return fail("NPC schedule has duplicate ids or overlapping intervals", "NPC_SOCIAL_SCHEDULE_CONFLICT");
    }
    Ok(normalized)
}

fn strict_inventory_input(value: Option<&Value>) -> Checked<Vec<InventoryEntry>> {
    if !js::present(value) {
        return Ok(Vec::new());
    }
    let items = match value {
        Some(Value::Array(items)) if items.len() <= 100 => items,
        _ => return fail("NPC inventory must contain at most 100 entries", "NPC_SOCIAL_INVENTORY_INVALID"),
    };
    for entry in items {
        let item = object(Some(entry), "npc.inventory entry")?;
        fields(item, &INVENTORY_FIELDS, "npc.inventory entry")?;
        identifier(item.get("id"), "npc.inventory.id")?;
        let quantity = js::number(item.get("quantity"));
        if clean(item.get("name"), 160).is_empty() || !is_safe(quantity) || quantity < 0.0 || quantity > 9_999.0 {
            return fail("NPC inventory item is invalid", "NPC_SOCIAL_INVENTORY_INVALID");
        }
        if js::present(item.get("visibility")) && one_of(item.get("visibility"), &PROFILE_VISIBILITIES).is_none() {
            return fail("NPC inventory visibility is invalid", "NPC_SOCIAL_INVENTORY_INVALID");
        }
    }
    let normalized = safe_inventory(value, &NULL);
    if normalized.len() != items.len() {
        return fail("NPC inventory has duplicate item ids", "NPC_SOCIAL_INVENTORY_CONFLICT");
    }
    Ok(normalized)
}

fn strict_id_list_input(value: Option<&Value>, maximum: usize, field: &str) -> Checked<Vec<String>> {
    if !js::present(value) {
        return Ok(Vec::new());
    }
    match value {
        Some(Value::Array(items)) if items.len() <= maximum => Ok(strings(value, 120, maximum)),
        _ => fail(format!("{field} must contain at most {maximum} entries"), "NPC_SOCIAL_INPUT_LIMIT"),
    }
}

fn strict_speech_profile_input(value: Option<&Value>) -> Checked<Value> {
    let profile = object(value, "npc.speech_profile")?;
    fields(profile, &["pace", "lexicon", "mannerism"], "npc.speech_profile")?;
    let pace = clean(profile.get("pace"), 100);
    let lexicon = clean(profile.get("lexicon"), 180);
    let mannerism = clean(profile.get("mannerism"), 180);
    if pace.is_empty() || lexicon.is_empty() || mannerism.is_empty() {
        return fail("Речевой профиль NPC требует темп, словарь и привычку", "NPC_SOCIAL_SPEECH_PROFILE_INVALID");
    }
    Ok(json!({ "pace": pace, "lexicon": lexicon, "mannerism": mannerism }))
}

fn normalize_profile_input(input: Option<&Value>) -> Checked<Value> {
    let value = object(input, "npc")?;
    fields(value, &PROFILE_FIELDS, "npc")?;
    // Досье принадлежит серверу. Поле принимается только для round-trip
    // спроецированного профиля: присланные записи игнорируются.
    let mut editable = js_order(value.clone());
    editable.shift_remove("dossier");
    let known_fact_ids = strict_id_list_input(editable.get("known_fact_ids"), 100, "npc.known_fact_ids")?;
    let id = identifier(editable.get("id"), "npc.id")?;
    let speech_profile = if js::present(editable.get("speech_profile")) { Some(strict_speech_profile_input(editable.get("speech_profile"))?) } else { None };
    let schedule = strict_schedule_input(editable.get("schedule"))?;
    let inventory = strict_inventory_input(editable.get("inventory"))?;
    let mut draft = editable;
    draft.insert("id".into(), string_value(&id));
    draft.insert("known_fact_ids".into(), strings_json(&known_fact_ids));
    if let Some(speech_profile) = speech_profile {
        draft.insert("speech_profile".into(), speech_profile);
    }
    draft.insert("schedule".into(), schedule_json(&schedule));
    draft.insert("inventory".into(), Value::Array(inventory.iter().map(InventoryEntry::to_json).collect()));
    let result = safe_profile(&Value::Object(draft), &NULL);
    if str_field(&result, "name").is_empty() {
        return fail("У NPC должно быть имя", "NPC_SOCIAL_NAME_REQUIRED");
    }
    let visibility = coalesce(value.get("visibility"), None);
    if visibility.is_some() && one_of(visibility, &PROFILE_VISIBILITIES).is_none() {
        return fail("Некорректная видимость NPC", "NPC_SOCIAL_VISIBILITY_INVALID");
    }
    Ok(result)
}

struct NormalizedConversation {
    conversation: Value,
    relationship_delta: i64,
    promise: Option<Value>,
}

fn normalize_conversation_input(input: Option<&Value>, state: &Value, command: &Value, context: &Value) -> Checked<NormalizedConversation> {
    let value = object(input, "conversation")?;
    fields(value, &CONVERSATION_FIELDS, "conversation")?;
    let state_source = Some(state);
    let social = ensure_npc_social_state(&element(get(state_source, "social")), state, &NULL);
    let npc_id = identifier(value.get("npc_id"), "conversation.npc_id")?;
    let hero_source = if js::truthy(value.get("hero_id")) { value.get("hero_id") } else { get(Some(command), "actor_id") };
    let hero_id = identifier(hero_source, "conversation.hero_id")?;
    let npc = social_part(&social, "npcs").iter().find(|candidate| str_field(candidate, "id") == npc_id).map(|persisted| npc_profile_at_world_time(persisted, state));
    let Some(npc) = npc.filter(|npc| !js::is_false(npc.get("available"))) else {
        return fail("NPC недоступен для разговора", "NPC_SOCIAL_NPC_UNAVAILABLE");
    };
    let members: Vec<String> = array(coalesce(get(state_source, "partyMemberIds"), None)).iter().map(|member| js::string(Some(member))).collect();
    if !members.contains(&hero_id) {
        return fail("Герой разговора не входит в отряд", "NPC_SOCIAL_HERO_INVALID");
    }
    if js::truthy(get(get(get(state_source, "mechanics"), "combat"), "active")) {
        return fail("Развёрнутый разговор недоступен во время боя", "NPC_SOCIAL_DURING_COMBAT");
    }
    let scene_location = clean_lower(get(get(state_source, "scene"), "location"), 180);
    let npc_location = str_field(&npc, "location");
    if !npc_location.is_empty() && !scene_location.is_empty() && text::lower(npc_location) != scene_location {
        return fail("NPC находится в другой локации", "NPC_SOCIAL_WRONG_LOCATION");
    }
    let canonical = safe_social_check(get(Some(context), "socialCheckOutcome"));
    let proposed = safe_social_check(value.get("check"));
    if js::present(value.get("check")) {
        let matches = match (&canonical, &proposed) {
            (Some(canonical), Some(proposed)) => ["check_id", "npc_id", "skill", "success"].iter().all(|key| proposed.get(*key) == canonical.get(*key)),
            _ => false,
        };
        if !matches {
            return fail("The conversation check does not match the server result", "NPC_SOCIAL_CHECK_MISMATCH");
        }
    }
    if canonical.as_ref().is_some_and(|check| str_field(check, "npc_id") != npc_id) {
        return fail("The social check belongs to another NPC", "NPC_SOCIAL_CHECK_MISMATCH");
    }

    let stance = one_of(value.get("stance"), &STANCES).unwrap_or("neutral");
    // Раскрыть можно то, что NPC знает, и, как прежде, любой факт, уже
    // известный отряду: его повтор ничего скрытого не открывает.
    let mut known = npc_known_fact_ids(state, &npc);
    let facts = world_facts(state);
    for fact in &facts {
        if one_of(get(Some(fact), "visibility"), &["public", "party"]).is_some() {
            known.insert(tpl(get(Some(fact), "id")));
        }
    }
    let disclosed = strict_id_list_input(value.get("disclosed_fact_ids"), 20, "conversation.disclosed_fact_ids")?;
    let active_facts: HashSet<String> = array(get(get(state_source, "worldMemory"), "facts"))
        .iter()
        .filter(|fact| is_str(get(Some(fact), "status"), "active"))
        .map(|fact| tpl(get(Some(fact), "id")))
        .collect();
    if disclosed.iter().any(|fact_id| !known.contains(fact_id) || !active_facts.contains(fact_id)) {
        return fail("NPC попытался раскрыть неизвестный или неактуальный факт", "NPC_SOCIAL_FACT_FORBIDDEN");
    }
    let disclosed_claims = strict_id_list_input(value.get("disclosed_claim_ids"), 20, "conversation.disclosed_claim_ids")?;
    let speakable_claims: HashSet<String> = array(get(get(state_source, "worldMemory"), "epistemic_claims"))
        .iter()
        .filter(|claim| tpl(get(Some(claim), "holder_entity_id")) == npc_id)
        .map(|claim| tpl(get(Some(claim), "id")))
        .collect();
    if disclosed_claims.iter().any(|claim_id| !speakable_claims.contains(claim_id)) {
        return fail("NPC попытался раскрыть чужое убеждение или слух", "NPC_SOCIAL_CLAIM_FORBIDDEN");
    }
    let conversation_id = identifier(value.get("id"), "conversation.id")?;
    let mut draft = Map::new();
    draft.insert("id".into(), string_value(&conversation_id));
    draft.insert("npc_id".into(), string_value(&npc_id));
    draft.insert("hero_id".into(), string_value(&hero_id));
    draft.insert("player_message".into(), element(value.get("player_message")));
    draft.insert("npc_reply".into(), element(value.get("npc_reply")));
    draft.insert("stance".into(), string_value(stance));
    draft.insert("disclosed_fact_ids".into(), strings_json(&disclosed));
    draft.insert("disclosed_claim_ids".into(), strings_json(&disclosed_claims));
    draft.insert("visibility".into(), element(value.get("visibility")));
    if let Some(check) = &canonical {
        draft.insert("check".into(), check.clone());
    }
    let conversation = safe_conversation(&Value::Object(draft), &NULL);
    if str_field(&conversation, "player_message").is_empty() || str_field(&conversation, "npc_reply").is_empty() {
        return fail("Разговор должен содержать реплику героя и ответ NPC", "NPC_SOCIAL_CONTENT_REQUIRED");
    }
    let mut relationship_delta = integer(value.get("relationship_delta"), 0).clamp(-2, 2);
    let mut promise = None;
    if js::present(value.get("promise")) {
        let promise_value = object(value.get("promise"), "promise")?;
        fields(promise_value, &PROMISE_FIELDS, "promise")?;
        if one_of(promise_value.get("direction"), &PROMISE_DIRECTIONS).is_none() {
            return fail("Некорректное направление обещания", "NPC_PROMISE_DIRECTION_INVALID");
        }
        let promise_id = identifier(promise_value.get("id"), "promise.id")?;
        let elapsed = campaign_elapsed_minutes(state);
        let deadline = match promise_due_offset_minutes(promise_value.get("due_hint").unwrap_or(&NULL)) {
            None => Value::Null,
            Some(offset) => js::num(elapsed + offset as f64),
        };
        let draft = json!({
            "id": promise_id,
            "npc_id": npc_id,
            "hero_id": hero_id,
            "direction": element(promise_value.get("direction")),
            "text": element(promise_value.get("text")),
            "due_hint": element(promise_value.get("due_hint")),
            "visibility": element(promise_value.get("visibility")),
            "status": "open",
            "source_conversation_id": element(conversation.get("id")),
            "created_at_minutes": js::num(elapsed),
            "deadline_minutes": deadline,
        });
        let normalized = safe_promise(&draft);
        if str_field(&normalized, "text").is_empty() {
            return fail("Обещание не может быть пустым", "NPC_PROMISE_TEXT_REQUIRED");
        }
        promise = Some(normalized);
    }
    if let Some(check) = &canonical {
        if is_str(check.get("skill"), "insight") {
            relationship_delta = 0;
            promise = None;
        } else if !js::is_true(check.get("success")) {
            relationship_delta = relationship_delta.min(0);
            promise = None;
        }
    }
    Ok(NormalizedConversation { conversation, relationship_delta, promise })
}

/// Проверка социальной команды (`validateNpcSocialCommand`): нормализованная
/// команда или отказ с кодом. Команда другого типа возвращается как есть.
/// `context` — `{ isAdmin, isDirector, isSocialController, socialCheckOutcome }`.
pub fn validate_npc_social_command(command: &Value, state: &Value, context: &Value) -> Result<Value, NpcSocialValidationError> {
    let command_type = get(Some(command), "command_type");
    let Some(command_type) = one_of(command_type, &NPC_SOCIAL_COMMAND_TYPES) else { return Ok(command.clone()) };
    let state = or_empty(state);
    let context = or_empty(context);
    let can_manage = js::is_true(get(Some(context), "isAdmin")) || js::is_true(get(Some(context), "isDirector"));
    let mut result = spread_of(Some(command));
    if command_type == "UpsertNpcSocialProfile" {
        if !can_manage {
            return fail("Профили NPC изменяет только системный контур", "NPC_SOCIAL_FORBIDDEN");
        }
        let npc = normalize_profile_input(get(Some(command), "npc"))?;
        result.insert("actor_id".into(), Value::Null);
        result.insert("target_ids".into(), json!([]));
        let visibility = element(npc.get("visibility"));
        result.insert("npc".into(), npc);
        result.insert("visibility".into(), visibility);
        return Ok(Value::Object(result));
    }
    let social_controller = js::is_true(get(Some(context), "isSocialController"));
    if command_type == "RecordNpcSocialTurn" {
        if !can_manage && !social_controller {
            return fail("Социальный результат не подтверждён серверным контроллером", "NPC_SOCIAL_FORBIDDEN");
        }
        let normalized = normalize_conversation_input(get(Some(command), "conversation"), state, command, context)?;
        let conversation = normalized.conversation;
        result.insert("conversation".into(), conversation.clone());
        result.insert("relationship_delta".into(), Value::from(normalized.relationship_delta));
        result.insert("promise".into(), normalized.promise.unwrap_or(Value::Null));
        result.insert("actor_id".into(), element(conversation.get("hero_id")));
        result.insert("target_ids".into(), json!([element(conversation.get("npc_id"))]));
        result.insert("visibility".into(), element(conversation.get("visibility")));
        return Ok(Value::Object(result));
    }
    if !can_manage && !social_controller {
        return fail("Обещания NPC изменяет только системный контур", "NPC_SOCIAL_FORBIDDEN");
    }
    let social = ensure_npc_social_state(&element(get(Some(state), "social")), state, &NULL);
    let promise_id = identifier(get(Some(command), "promise_id"), "promise_id")?;
    let promise = social_part(&social, "promises").iter().find(|candidate| str_field(candidate, "id") == promise_id);
    let Some(promise) = promise.filter(|promise| is_str(promise.get("status"), "open")) else {
        return fail("Открытое обещание не найдено", "NPC_PROMISE_NOT_FOUND");
    };
    let status = clean(get(Some(command), "status"), 30);
    if !["fulfilled", "broken", "cancelled"].contains(&status.as_str()) {
        return fail("Некорректный итог обещания", "NPC_PROMISE_STATUS_INVALID");
    }
    result.insert("actor_id".into(), Value::Null);
    result.insert("target_ids".into(), json!([element(promise.get("hero_id"))]));
    result.insert("promise_id".into(), string_value(&promise_id));
    result.insert("status".into(), string_value(&status));
    result.insert("resolved_at_minutes".into(), js::num(campaign_elapsed_minutes(state)));
    result.insert("resolution_reason".into(), string_value("manual"));
    result.insert("consequence_delta".into(), Value::from(promise_consequence(promise, &status)));
    result.insert("visibility".into(), element(promise.get("visibility")));
    Ok(Value::Object(result))
}

fn promise_consequence(promise: &Value, status: &str) -> i64 {
    let party_to_npc = is_str(promise.get("direction"), "party_to_npc");
    match status {
        "fulfilled" => {
            if party_to_npc {
                8
            } else {
                4
            }
        }
        "broken" => {
            if party_to_npc {
                -15
            } else {
                -8
            }
        }
        _ => 0,
    }
}

// ── События ─────────────────────────────────────────────────────────────────

fn relationship_score(social: &Value, npc_id: Option<&Value>, hero_id: Option<&Value>) -> i64 {
    let heroes = social.get("relationships").and_then(|relationships| relationships.get(tpl(npc_id)));
    match heroes.and_then(|heroes| heroes.get(tpl(hero_id))) {
        None | Some(Value::Null) => 0,
        Some(score) => integer(Some(score), 0),
    }
}

#[allow(clippy::too_many_arguments)] // Повторяет сигнатуру `relationshipEvents` JS.
fn relationship_events(
    state: &Value,
    npc_id: Option<&Value>,
    hero_id: Option<&Value>,
    delta: Option<&Value>,
    reason: Option<&Value>,
    promise_id: Option<&Value>,
    score_override: Option<i64>,
) -> (Vec<Value>, i64) {
    let before = match score_override {
        Some(score) => score,
        None => {
            let social = ensure_npc_social_state(&element(get(Some(state), "social")), state, &NULL);
            relationship_score(&social, npc_id, hero_id)
        }
    };
    let bounded_delta = integer(delta, 0).clamp(-25, 25);
    if bounded_delta == 0 {
        return (Vec::new(), before);
    }
    let after = (before + bounded_delta).clamp(-100, 100);
    let tier_before = relationship_tier_for(before);
    let tier_after = relationship_tier_for(after);
    let mut payload = Map::new();
    put_opt(&mut payload, "npc_id", npc_id);
    put_opt(&mut payload, "hero_id", hero_id);
    payload.insert("delta".into(), Value::from(bounded_delta));
    payload.insert("score_before".into(), Value::from(before));
    payload.insert("score_after".into(), Value::from(after));
    payload.insert("tier_before".into(), string_value(tier_before));
    payload.insert("tier_after".into(), string_value(tier_after));
    payload.insert("reason".into(), string_value(&clean(reason, 80)));
    payload.insert("promise_id".into(), string_value(&clean(promise_id, 120)));
    let payload = Value::Object(payload);
    let draft = |event_type: &str| {
        json!({ "event_type": event_type, "payload": payload.clone(), "target_ids": [element(hero_id)], "visibility": "specific_player" })
    };
    let mut events = vec![draft("NpcRelationshipAdjusted")];
    if tier_before != tier_after {
        events.push(draft("NpcRelationshipTierChanged"));
    }
    (events, after)
}

/// Черновики событий отношения для тех, кто двигает его **не разговором**
/// (`npcRelationshipEventDrafts`), например дошедшее письмо. Арифметика
/// отношения — границы дельты, потолок счёта и порог смены ступени — живёт в
/// одном месте. Возвращаются черновики (`event_type`/`payload`/`target_ids`/
/// `visibility`): `event_id` и версию проставляет Rules Engine.
/// `options` — `{ npcId, heroId, delta, reason, promiseId }`, как в JS.
pub fn npc_relationship_event_drafts(state: &Value, options: &Value) -> Vec<Value> {
    let options = Some(options);
    let npc = clean(get(options, "npcId"), 120);
    let hero = clean(get(options, "heroId"), 120);
    if npc.is_empty() || hero.is_empty() {
        return Vec::new();
    }
    let state = or_empty(state);
    relationship_events(state, Some(&string_value(&npc)), Some(&string_value(&hero)), get(options, "delta"), get(options, "reason"), get(options, "promiseId"), None).0
}

/// События проверенной социальной команды (`npcSocialEvents`).
pub fn npc_social_events(command: &Value, state: &Value) -> Vec<Value> {
    let state = or_empty(state);
    let source = Some(command);
    let command_type = get(source, "command_type");
    if is_str(command_type, "UpsertNpcSocialProfile") {
        let mut payload = Map::new();
        if let Some(npc) = get(source, "npc") {
            payload.insert("npc".into(), clone_js(npc));
        }
        let mut event = Map::new();
        event.insert("event_type".into(), string_value("NpcSocialProfileUpserted"));
        event.insert("payload".into(), Value::Object(payload));
        event.insert("target_ids".into(), json!([]));
        put_opt(&mut event, "visibility", get(source, "visibility"));
        return vec![Value::Object(event)];
    }
    if is_str(command_type, "RecordNpcSocialTurn") {
        let conversation = get(source, "conversation");
        let command_id = tpl(get(source, "command_id"));
        let conversation_event_id = format!("{command_id}:conversation");
        let npc_id = get(conversation, "npc_id");
        let hero_id = get(conversation, "hero_id");
        let mut payload = Map::new();
        if let Some(conversation) = conversation {
            payload.insert("conversation".into(), clone_js(conversation));
        }
        let mut first = Map::new();
        first.insert("event_id".into(), string_value(&conversation_event_id));
        first.insert("event_type".into(), string_value("NpcConversationRecorded"));
        first.insert("payload".into(), Value::Object(payload));
        first.insert("target_ids".into(), json!([element(npc_id), element(hero_id)]));
        put_opt(&mut first, "visibility", get(source, "visibility"));
        let mut events = vec![Value::Object(first)];
        let revealed_at = js::num(campaign_elapsed_minutes(state));
        for (index, fact_id) in array(get(conversation, "disclosed_fact_ids")).iter().enumerate() {
            let mut knowledge = Map::new();
            knowledge.insert("knowledge_id".into(), string_value(&format!("{}:knowledge:{}", tpl(get(conversation, "id")), index + 1)));
            put_opt(&mut knowledge, "hero_id", hero_id);
            knowledge.insert("fact_id".into(), fact_id.clone());
            knowledge.insert("source_event_ids".into(), json!([conversation_event_id]));
            knowledge.insert("source_kind".into(), string_value("npc"));
            knowledge.insert("revealed_at_minutes".into(), revealed_at.clone());
            events.push(json!({
                "event_id": format!("{command_id}:knowledge:{}", index + 1),
                "event_type": "KnowledgeRevealed",
                "payload": Value::Object(knowledge),
                "target_ids": [element(hero_id)],
                "visibility": "specific_player",
            }));
        }
        let reason = string_value("conversation");
        events.extend(relationship_events(state, npc_id, hero_id, get(source, "relationship_delta"), Some(&reason), None, None).0);
        let promise = get(source, "promise");
        if js::truthy(promise) {
            let mut payload = Map::new();
            put_opt(&mut payload, "promise", promise.map(clone_js).as_ref());
            let mut event = Map::new();
            event.insert("event_type".into(), string_value("NpcPromiseRecorded"));
            event.insert("payload".into(), Value::Object(payload));
            event.insert("target_ids".into(), json!([element(hero_id)]));
            put_opt(&mut event, "visibility", get(promise, "visibility"));
            events.push(Value::Object(event));
        }
        return events;
    }
    if is_str(command_type, "ResolveNpcPromise") {
        let social = ensure_npc_social_state(&element(get(Some(state), "social")), state, &NULL);
        let promise = social_part(&social, "promises").iter().find(|candidate| strict_eq(candidate.get("id"), get(source, "promise_id")));
        let mut payload = Map::new();
        for key in ["promise_id", "status", "resolved_at_minutes", "resolution_reason", "consequence_delta"] {
            put_opt(&mut payload, key, get(source, key).map(clone_js).as_ref());
        }
        let mut event = Map::new();
        event.insert("event_type".into(), string_value("NpcPromiseResolved"));
        event.insert("payload".into(), Value::Object(payload));
        put_opt(&mut event, "target_ids", get(source, "target_ids").map(clone_js).as_ref());
        put_opt(&mut event, "visibility", get(source, "visibility"));
        let mut events = vec![Value::Object(event)];
        if let Some(promise) = promise {
            let reason = string_value(&format!("promise-{}", tpl(get(source, "status"))));
            events.extend(relationship_events(state, promise.get("npc_id"), promise.get("hero_id"), get(source, "consequence_delta"), Some(&reason), promise.get("id"), None).0);
        }
        return events;
    }
    Vec::new()
}

/// Просроченные обещания ломаются по сроку (`npcPromiseDeadlineEvents`): каждое
/// — событием итога и событиями отношения; счёт копится по паре NPC — герой.
pub fn npc_promise_deadline_events(state: &Value, elapsed_minutes: &Value) -> Vec<Value> {
    let state = or_empty(state);
    let social = ensure_npc_social_state(&element(get(Some(state), "social")), state, &NULL);
    let start = campaign_elapsed_minutes(state);
    let end = start + integer(Some(elapsed_minutes), 0).max(0) as f64;
    let mut scores: HashMap<String, i64> = HashMap::new();
    let mut events: Vec<Value> = Vec::new();
    let reason = string_value("promise-deadline");
    for promise in social_part(&social, "promises") {
        let deadline = promise.get("deadline_minutes").and_then(Value::as_f64);
        let Some(deadline) = deadline.filter(|deadline| is_str(promise.get("status"), "open") && *deadline <= end) else { continue };
        let delta = promise_consequence(promise, "broken");
        events.push(json!({
            "event_type": "NpcPromiseResolved",
            "payload": {
                "promise_id": element(promise.get("id")),
                "status": "broken",
                "resolved_at_minutes": js::num(js::max_of([start, deadline])),
                "resolution_reason": "deadline",
                "consequence_delta": delta,
            },
            "target_ids": [element(promise.get("hero_id"))],
            "visibility": element(promise.get("visibility")),
        }));
        let key = format!("{}\u{0}{}", tpl(promise.get("npc_id")), tpl(promise.get("hero_id")));
        let before = scores.get(&key).copied().unwrap_or_else(|| relationship_score(&social, promise.get("npc_id"), promise.get("hero_id")));
        let (relationship, after) = relationship_events(state, promise.get("npc_id"), promise.get("hero_id"), Some(&Value::from(delta)), Some(&reason), promise.get("id"), Some(before));
        events.extend(relationship);
        scores.insert(key, after);
    }
    events
}

// ── Редьюсер ────────────────────────────────────────────────────────────────

/// Редьюсер социальных событий (`applyNpcSocialEvent`): Rules Engine зовёт его
/// для `NpcSocialProfileUpserted`, `NpcConversationRecorded`,
/// `NpcRelationshipAdjusted`, `NpcRelationshipTierChanged`,
/// `NpcPromiseRecorded`, `NpcPromiseResolved`. Прочие события только
/// нормализуют состояние. `options` — режим удержания (см. модуль).
pub fn apply_npc_social_event(input: &Value, event: &Value, state: &Value, options: &Value) -> Value {
    let legacy = legacy_retention(options);
    let state = or_empty(state);
    let social = ensure_npc_social_state(input, state, options);
    let mut social = social.as_object().cloned().unwrap_or_default();
    let event_source = Some(event);
    let payload = coalesce(get(event_source, "payload"), None).unwrap_or(empty());
    let payload_source = Some(payload);
    let take = |social: &mut Map<String, Value>, key: &str| -> Vec<Value> {
        match social.get_mut(key) {
            Some(Value::Array(items)) => std::mem::take(items),
            _ => Vec::new(),
        }
    };
    match get(event_source, "event_type").and_then(Value::as_str) {
        Some("NpcSocialProfileUpserted") => {
            let npc_payload = get(payload_source, "npc");
            let target = clean(get(npc_payload, "id"), 120);
            let npcs = take(&mut social, "npcs");
            let previous_dossier = npcs.iter().find(|candidate| str_field(candidate, "id") == target).and_then(|previous| previous.get("dossier")).cloned();
            let mut draft = spread_of(npc_payload);
            draft.insert("dossier".into(), previous_dossier.unwrap_or(Value::Null));
            let npc = safe_profile(&Value::Object(draft), options);
            let id = str_field(&npc, "id").to_string();
            let mut next: Vec<Value> = npcs.into_iter().filter(|candidate| str_field(candidate, "id") != id).collect();
            next.push(npc);
            social.insert("npcs".into(), Value::Array(next));
        }
        Some("NpcConversationRecorded") => {
            let conversation = safe_conversation(get(payload_source, "conversation").unwrap_or(&NULL), options);
            let id = str_field(&conversation, "id").to_string();
            let mut conversations: Vec<Value> = take(&mut social, "conversations").into_iter().filter(|candidate| str_field(candidate, "id") != id).collect();
            conversations.push(conversation.clone());
            if legacy {
                let skip = conversations.len().saturating_sub(500);
                conversations.drain(..skip);
            }
            social.insert("conversations".into(), Value::Array(conversations));
            if let Some(entry) = dossier_entry_from_conversation(&conversation, event, options) {
                let entry_id = str_field(&entry, "id").to_string();
                let npc_id = str_field(&conversation, "npc_id").to_string();
                let npcs: Vec<Value> = take(&mut social, "npcs")
                    .into_iter()
                    .map(|npc| {
                        if str_field(&npc, "id") != npc_id {
                            return npc;
                        }
                        let mut dossier: Vec<Value> = array(npc.get("dossier")).iter().filter(|candidate| str_field(candidate, "id") != entry_id).cloned().collect();
                        dossier.push(entry.clone());
                        let mut draft = npc.as_object().cloned().unwrap_or_default();
                        draft.insert("dossier".into(), Value::Array(dossier));
                        safe_profile(&Value::Object(draft), options)
                    })
                    .collect();
                social.insert("npcs".into(), Value::Array(npcs));
            }
        }
        Some("NpcRelationshipAdjusted") => {
            let npc_id = clean(get(payload_source, "npc_id"), 120);
            let hero_id = clean(get(payload_source, "hero_id"), 120);
            let delta = integer(get(payload_source, "delta"), 0).clamp(-25, 25);
            // Счёт меняется, а ступени (`relationship_tiers`) — нет: в JS их
            // пересчитывает только следующая нормализация.
            let mut relationships = match social.get("relationships") {
                Some(Value::Object(map)) => map.clone(),
                _ => Map::new(),
            };
            let mut heroes = match relationships.get(&npc_id) {
                Some(Value::Object(heroes)) => heroes.clone(),
                _ => Map::new(),
            };
            let before = heroes.get(&hero_id).map_or(0, |score| integer(Some(score), 0));
            heroes.insert(hero_id, Value::from((before + delta).clamp(-100, 100)));
            relationships.insert(npc_id, Value::Object(js_order(heroes)));
            social.insert("relationships".into(), Value::Object(js_order(relationships)));
        }
        Some("NpcPromiseRecorded") => {
            let promise = safe_promise(get(payload_source, "promise").unwrap_or(&NULL));
            let id = str_field(&promise, "id").to_string();
            let mut promises: Vec<Value> = take(&mut social, "promises").into_iter().filter(|candidate| str_field(candidate, "id") != id).collect();
            promises.push(promise);
            if legacy {
                let skip = promises.len().saturating_sub(500);
                promises.drain(..skip);
            }
            social.insert("promises".into(), Value::Array(promises));
        }
        Some("NpcPromiseResolved") => {
            let promises: Vec<Value> = take(&mut social, "promises")
                .into_iter()
                .map(|promise| {
                    if !(strict_eq(promise.get("id"), get(payload_source, "promise_id")) && is_str(promise.get("status"), "open")) {
                        return promise;
                    }
                    let status = one_of(get(payload_source, "status"), &PROMISE_STATUSES).map(string_value).unwrap_or_else(|| element(promise.get("status")));
                    let mut draft = promise.as_object().cloned().unwrap_or_default();
                    draft.insert("status".into(), status);
                    draft.insert("resolved_at_minutes".into(), element(get(payload_source, "resolved_at_minutes")));
                    draft.insert("resolution_reason".into(), element(get(payload_source, "resolution_reason")));
                    draft.insert("consequence_delta".into(), element(get(payload_source, "consequence_delta")));
                    safe_promise(&Value::Object(draft))
                })
                .collect();
            social.insert("promises".into(), Value::Array(promises));
        }
        _ => {}
    }
    Value::Object(social)
}

// ── Проекция для игрока ─────────────────────────────────────────────────────

/// Социальное состояние, которое имеет право видеть игрок (`npcSocialForViewer`):
/// публичные данные NPC без мотивов и убеждений, свои разговоры и обещания,
/// своё отношение. Ведущий видит всё.
pub fn npc_social_for_viewer(input: &Value, viewer: &Value) -> Value {
    social_for_viewer(input, viewer, None)
}

/// [`npc_social_for_viewer`] с состоянием кампании отдельно от карточки
/// зрителя: то же, что `viewer` с полем `state`, но без копии состояния в
/// карточку (Ск4). `state` — объект состояния кампании.
pub fn npc_social_for_viewer_in(input: &Value, viewer: &Value, state: &Value) -> Value {
    social_for_viewer(input, viewer, Some(state))
}

fn social_for_viewer(input: &Value, viewer: &Value, state: Option<&Value>) -> Value {
    let social = normalize_npc_social_state(input, &NULL);
    let viewer = or_empty(viewer);
    let source = Some(viewer);
    if js::truthy(get(source, "isAdmin")) {
        return social;
    }
    let player_id = clean(get(source, "playerId"), 120);
    let viewer_state = state.unwrap_or_else(|| coalesce(get(source, "state"), None).unwrap_or(empty()));
    let scene = get(Some(viewer_state), "scene");
    let scene_location_id = clean(coalesce(get(scene, "location_id"), get(scene, "locationId")), 120);
    let scene_location = clean_lower(get(scene, "location"), 180);
    let npcs: Vec<Value> = social_part(&social, "npcs")
        .iter()
        .filter(|npc| {
            if viewer_may_see(npc.get("visibility"), viewer) {
                return true;
            }
            if !js::is_true(npc.get("reveal_on_presence")) {
                return false;
            }
            let current = npc_profile_at_world_time(npc, viewer_state);
            !js::is_false(current.get("available"))
                && ((!scene_location_id.is_empty() && is_str(current.get("location_id"), &scene_location_id))
                    || (!scene_location.is_empty() && clean_lower(current.get("location"), 180) == scene_location))
        })
        .map(|npc| profile_for_viewer_at(npc, viewer, state))
        .collect();
    let visible_npc_ids: IndexSet<String> = npcs.iter().map(|npc| str_field(npc, "id").to_string()).collect();
    let visible_entry = |entry: &&Value| visible_npc_ids.contains(str_field(entry, "npc_id")) && (is_str(entry.get("visibility"), "party") || str_field(entry, "hero_id") == player_id);
    let conversations: Vec<Value> = social_part(&social, "conversations").iter().filter(visible_entry).map(clone_js).collect();
    let promises: Vec<Value> = social_part(&social, "promises").iter().filter(visible_entry).map(clone_js).collect();
    let player = string_value(&player_id);
    let mut relationships = Map::new();
    let mut relationship_tiers = Map::new();
    for npc_id in &visible_npc_ids {
        let score = relationship_score(&social, Some(&string_value(npc_id)), Some(&player));
        let mut entry = Map::new();
        entry.insert(player_id.clone(), Value::from(score));
        relationships.insert(npc_id.clone(), Value::Object(entry));
        let mut tier = Map::new();
        tier.insert(player_id.clone(), string_value(relationship_tier_for(score)));
        relationship_tiers.insert(npc_id.clone(), Value::Object(tier));
    }
    let mut result = Map::new();
    result.insert("schema_version".into(), Value::from(4));
    result.insert("npcs".into(), Value::Array(npcs.iter().map(clone_js).collect()));
    result.insert("relationships".into(), Value::Object(js_order(relationships)));
    result.insert("relationship_tiers".into(), Value::Object(js_order(relationship_tiers)));
    result.insert("conversations".into(), Value::Array(conversations));
    result.insert("promises".into(), Value::Array(promises));
    Value::Object(result)
}

// ── Досье для Рассказчика ───────────────────────────────────────────────────

fn narrator_dossier_visibility_allowed(value: Option<&Value>) -> bool {
    !["gm_only", "gmOnly", "npc_private", "npcPrivate"].contains(&js::s(value).as_str())
}

fn narrator_npc_key(value: Option<&Value>) -> String {
    clean_lower(value, 160)
}

fn narrator_dossier_record_visible(record: &Value, viewer_ids: &HashSet<String>, viewer_names: &HashSet<String>) -> bool {
    let source = Some(record);
    let visibility = get(source, "visibility");
    if !narrator_dossier_visibility_allowed(visibility) {
        return false;
    }
    if !is_str(visibility, "specific_player") {
        return true;
    }
    viewer_ids.contains(&js::s(get(source, "hero_id"))) || viewer_names.contains(&narrator_npc_key(get(source, "hero")))
}

fn texts(value: Option<&Value>, maximum: usize, limit: usize) -> Vec<Value> {
    array(value).iter().map(|item| clean(Some(item), maximum)).filter(|item| !item.is_empty()).take(limit).map(Value::String).collect()
}

fn tail(items: Vec<Value>, limit: usize) -> Vec<Value> {
    let skip = items.len().saturating_sub(limit);
    items.into_iter().skip(skip).collect()
}

/// Явное event-sourced досье из уже спроецированного брифа Рассказчика
/// (`npcDossiersForNarrator`). Намеренно не восстанавливается из
/// `recent_interactions`: полное досье передаёт владелец story-context.
pub fn npc_dossiers_for_narrator(brief: &Value) -> Vec<Value> {
    let story = coalesce(get(get(Some(brief), "known_environment"), "story_context"), None).unwrap_or(empty());
    let story = Some(story);
    let present: Vec<&Value> = array(get(story, "present_npcs"))
        .iter()
        .filter(|npc| js::truthy(get(Some(npc), "id")) && js::truthy(get(Some(npc), "name")) && narrator_dossier_visibility_allowed(get(Some(npc), "visibility")))
        .take(4)
        .collect();
    if present.is_empty() {
        return Vec::new();
    }
    let mut present_by_id: IndexMap<String, &Value> = IndexMap::new();
    for npc in &present {
        present_by_id.insert(tpl(npc.get("id")), npc);
    }
    let viewer_heroes: Vec<&Value> = array(get(story, "heroes")).iter().filter(|hero| js::truthy(get(Some(hero), "is_viewer"))).collect();
    let viewer_ids: HashSet<String> = viewer_heroes.iter().map(|hero| js::s(get(Some(hero), "id"))).filter(|id| !id.is_empty()).collect();
    let viewer_names: HashSet<String> = viewer_heroes.iter().map(|hero| narrator_npc_key(get(Some(hero), "name"))).filter(|name| !name.is_empty()).collect();
    let mut dossiers: Vec<Value> = Vec::new();
    for source in array(get(story, "npc_dossiers")) {
        if !narrator_dossier_record_visible(source, &viewer_ids, &viewer_names) {
            continue;
        }
        let record = Some(source);
        let Some(npc) = present_by_id.get(&js::s(get(record, "npc_id"))) else { continue };
        let mut interactions: Vec<Value> = Vec::new();
        let mut interaction_keys: HashSet<String> = HashSet::new();
        for entry in array(get(record, "interactions")) {
            if !narrator_dossier_record_visible(entry, &viewer_ids, &viewer_names) {
                continue;
            }
            let item = Some(entry);
            let provenance = get(item, "provenance");
            let source_conversation_id = clean(get(provenance, "source_conversation_id"), 120);
            let id = clean(get(item, "id"), 120);
            let record_key = if id.is_empty() { source_conversation_id.clone() } else { id.clone() };
            let summary = clean(get(item, "summary"), 600);
            if record_key.is_empty() || summary.is_empty() || interaction_keys.contains(&record_key) {
                continue;
            }
            interaction_keys.insert(record_key);
            let stance = clean(get(item, "stance"), 40);
            let claims: Vec<Value> = array(get(item, "disclosed_claims"))
                .iter()
                .map(|claim| clean(get(Some(claim), "id"), 120))
                .filter(|claim_id| !claim_id.is_empty())
                .take(12)
                .map(|claim_id| json!({ "id": claim_id, "truth_status": "unknown" }))
                .collect();
            interactions.push(json!({
                "id": id,
                "kind": "recorded_exchange",
                "hero_id": clean(get(item, "hero_id"), 120),
                "summary": summary,
                "stance": if stance.is_empty() { "neutral".to_string() } else { stance },
                "epistemic_status": if is_str(get(item, "epistemic_status"), "contains_unverified_claims") { "contains_unverified_claims" } else { "recorded_dialogue_not_world_fact" },
                "disclosed_claims": claims,
                "provenance": {
                    "source_kind": "NpcConversationRecorded",
                    "source_conversation_id": source_conversation_id,
                    "source_event_ids": texts(get(provenance, "source_event_ids"), 120, 8),
                },
            }));
        }
        let mut promises: Vec<Value> = Vec::new();
        let mut promise_keys: HashSet<String> = HashSet::new();
        for promise in array(get(record, "promises")) {
            if !narrator_dossier_record_visible(promise, &viewer_ids, &viewer_names) {
                continue;
            }
            let item = Some(promise);
            let id = clean(get(item, "id"), 120);
            let promise_text = clean(get(item, "text"), 280);
            if id.is_empty() || promise_text.is_empty() || promise_keys.contains(&id) {
                continue;
            }
            promise_keys.insert(id.clone());
            promises.push(json!({
                "id": id,
                "direction": clean(get(item, "direction"), 40),
                "text": promise_text,
                "due_hint": clean(get(item, "due_hint"), 160),
                "status": "open",
                "provenance": {
                    "source_kind": "event_reduced_promise",
                    "source_id": id,
                    "source_conversation_id": clean(get(item, "source_conversation_id"), 120),
                },
            }));
        }
        let relationship_source = get(record, "relationship");
        let tier = clean(get(relationship_source, "tier"), 40);
        let relationship = if tier.is_empty() { "neutral".to_string() } else { tier };
        if interactions.is_empty() && promises.is_empty() && relationship == "neutral" {
            continue;
        }
        dossiers.push(json!({
            "npc_id": clean(npc.get("id"), 120),
            "name": clean(npc.get("name"), 160),
            "relationship": {
                "tier": relationship,
                "provenance": {
                    "source_kind": "event_reduced_relationship",
                    "source_event_ids": texts(get(get(relationship_source, "provenance"), "source_event_ids"), 120, 8),
                },
            },
            "interactions": tail(interactions, NPC_NARRATOR_DOSSIER_LIMITS.interactions),
            "promises": tail(promises, NPC_NARRATOR_DOSSIER_LIMITS.promises),
        }));
        if dossiers.len() >= NPC_NARRATOR_DOSSIER_LIMITS.npcs {
            break;
        }
    }
    dossiers
}

/// Готовая реплика NPC в ленту (`npcConversationNarration`): реплику подписывает
/// сам NPC, а не Рассказчик; исход проверки — строкой перед ответом.
pub fn npc_conversation_narration(events: &[Value], state: &Value) -> Option<Value> {
    let event = events.iter().find(|candidate| is_str(get(Some(candidate), "event_type"), "NpcConversationRecorded"))?;
    let conversation = get(get(Some(event), "payload"), "conversation");
    let reply = get(conversation, "npc_reply");
    if !js::truthy(reply) {
        return None;
    }
    let npcs = array(get(get(Some(state), "social"), "npcs"));
    let npc = npcs.iter().find(|entry| strict_eq(get(Some(entry), "id"), get(conversation, "npc_id")));
    let npc_name = clean(get(npc, "name"), 80);
    let check = get(conversation, "check");
    let skill = get(check, "skill");
    let skill_label = match tpl(skill).as_str() {
        "persuasion" => "Убеждение".to_string(),
        "deception" => "Обман".to_string(),
        "intimidation" => "Запугивание".to_string(),
        "insight" => "Проницательность".to_string(),
        _ => tpl(skill),
    };
    let outcome_label = if js::truthy(get(check, "success")) { "успех" } else { "провал" };
    let check_summary = if js::truthy(check) { format!("Проверка «{skill_label}»: {outcome_label} ({}).\n", tpl(get(check, "total"))) } else { String::new() };
    let mut narration = Map::new();
    narration.insert("narration".into(), Value::String(format!("{check_summary}{}", tpl(reply))));
    if !npc_name.is_empty() {
        narration.insert("journal_author".into(), Value::String(npc_name));
    }
    narration.insert("provider".into(), string_value("NpcSocialController"));
    narration.insert("prompt_version".into(), string_value("npc_controller/social-v8"));
    narration.insert("verification".into(), json!({ "valid": true, "violations": [] }));
    Some(Value::Object(narration))
}

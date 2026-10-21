//! Перенос `server/narrator.mjs`: Рассказчик — текст после commit.
//!
//! Рассказчик не создаёт событий и не объявляет смерть: он получает уже
//! спроецированный бриф (`NarrationBrief`, `sk_tactics::security`), строит
//! запрос к модели (промпт `prompts/narrator/v14.txt` и отобранные примеры
//! стиля `few-shot-v2.json`), выпускает в поток только проверенные законченные
//! предложения и принимает ответ, лишь если он прошёл синхронную проверку
//! ([`verify_narrator_craft`] поверх `verify_narration`). Отклонённый черновик
//! получает одну правку, затем — детерминированный текст
//! ([`deterministic_narration`]). Художественные замечания
//! ([`verify_narrator_feedback`]) копятся в памяти и уходят модели на
//! следующем ходу.
//!
//! Клиент модели внедряется ([`NarratorConfig::llm_client`]); без него звучит
//! только детерминированный текст. Реализует трейт
//! [`CriticalNarrator`](crate::creative_director::CriticalNarrator) творческого
//! режиссёра.

use std::future::Future;
use std::sync::{Arc, Condvar, LazyLock, Mutex};
use std::task::{Context, Poll};

use serde_json::{json, Map, Value};
use sk_agents_base::llm_client::{AbortController, AbortSignal, CallHooks, DeltaHandler, LlmClient, LlmClientExt, LlmError, LlmErrorExt, LlmFuture};
use sk_core::fancy_regex::Regex;
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::{js, re, text};
use sk_narration_base::campaign_ai_context::{current_narrator_generation_parameters, current_narrator_style, current_narrator_style_instruction};
use sk_narration_base::combat_phrases::accusative_name;
use sk_narration_base::model_style_profiles::prompt_for_model_role;
use sk_narration_base::narrator_craft_quality::find_narrator_cliches_in;
use sk_tactics::security::{assert_narration_brief, build_data_only_context, DeterministicNarrationVerifier, SecurityValidationError};

use crate::creative_director::CriticalNarrator;
use crate::free_action_adjudication::{ability_label_ru, skill_label_ru};

/// Версия контракта Рассказчика.
pub const NARRATOR_PROMPT_VERSION: &str = "narrator/v14";
/// Версия корпуса примеров стиля.
pub const NARRATOR_FEW_SHOT_VERSION: &str = "narrator-few-shot/v2";
pub const NARRATOR_RECENT_TEXT_LIMIT: usize = 3;
/// Порог пересечения 3-грамм с недавним текстом, выше которого нарация
/// считается повтором (0.05 отсекал общий словарь сцены, см. JS).
pub const NARRATOR_RECENT_3GRAM_OVERLAP_MAX: f64 = 0.14;
/// Сколько уже написанных моделью клише напоминать ей на следующем ходу.
pub const NARRATOR_CLICHE_REMINDER_LIMIT: usize = 6;
pub const NARRATOR_FEEDBACK_MEMORY_LIMIT: usize = 128;
pub const NARRATOR_ARC_RECAP_MEMORY_LIMIT: usize = 128;
pub const NARRATOR_STREAM_MAX_BYTES: usize = 12 * 1024;
pub const NARRATOR_DEFAULT_TIMEOUT_MS: i64 = 12_000;

/// `prompts/narrator/v14.txt`.
pub const NARRATOR_PROMPT: &str = include_str!("../../../../prompts/narrator/v14.txt");
const FEW_SHOT_SOURCE: &str = include_str!("../../../../prompts/narrator/few-shot-v2.json");

/// `NARRATOR_FEW_SHOT_CORPUS`: примеры стиля в форме JS (`{ id, style,
/// moment, tones, player_message, allowed_facts, response_goal, text }`).
/// Некорректный корпус в JS роняет импорт модуля; здесь — пустой список
/// (корпус встроен при сборке, его форму держит тест).
pub static NARRATOR_FEW_SHOT_CORPUS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    let Ok(document) = serde_json::from_str::<Value>(FEW_SHOT_SOURCE) else { return Vec::new() };
    if !is_str(prop(Some(&document), "version"), NARRATOR_FEW_SHOT_VERSION) {
        return Vec::new();
    }
    let Some(examples) = prop(Some(&document), "examples").and_then(Value::as_array) else { return Vec::new() };
    examples
        .iter()
        .map(|example| {
            let field = |key: &str| Value::String(js::s(prop(Some(example), key)));
            let strings = |key: &str| Value::Array(arr(prop(Some(example), key)).iter().map(|item| Value::String(js::string(Some(item)))).collect());
            json!({
                "id": field("id"),
                "style": field("style"),
                "moment": field("moment"),
                "tones": strings("tones"),
                "player_message": field("player_message"),
                "allowed_facts": strings("allowed_facts"),
                "response_goal": field("response_goal"),
                "text": field("text"),
            })
        })
        .collect()
});

// ---------------------------------------------------------------------------
// Значения JS
// ---------------------------------------------------------------------------

type V<'a> = Option<&'a Value>;

/// `value?.[key]` у объекта (у прочих значений полей нет).
fn prop<'a>(value: V<'a>, key: &str) -> V<'a> {
    value.and_then(Value::as_object).and_then(|map| map.get(key))
}

/// `Array.isArray(value) ? value : []`.
fn arr(value: V<'_>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

/// `a ?? b`.
fn nullish<'a>(first: V<'a>, second: V<'a>) -> V<'a> {
    if js::present(first) {
        first
    } else {
        second
    }
}

/// `a || b`.
fn or<'a>(first: V<'a>, second: V<'a>) -> V<'a> {
    if js::truthy(first) {
        first
    } else {
        second
    }
}

fn is_str(value: V<'_>, expected: &str) -> bool {
    value.and_then(Value::as_str) == Some(expected)
}

/// `value?.[0]`: элемент массива, символ строки, поле `0` объекта.
fn index0(value: V<'_>) -> Option<Value> {
    match value {
        Some(Value::Array(items)) => items.first().cloned(),
        Some(Value::String(chars)) => chars.chars().next().map(|ch| Value::String(ch.to_string())),
        Some(Value::Object(map)) => map.get("0").cloned(),
        _ => None,
    }
}

/// `a === b` для значений JSON (`undefined` — `None`); объекты и массивы
/// разные всегда — в JS это разные ссылки.
fn strict_eq(left: V<'_>, right: V<'_>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(a)), Some(Value::Bool(b))) => a == b,
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        (Some(Value::String(a)), Some(Value::String(b))) => a == b,
        _ => false,
    }
}

fn string_value(text: impl Into<String>) -> Value {
    Value::String(text.into())
}

/// `sceneText(value, maximum)`: `String(value ?? '')`, пробелы схлопнуты,
/// края обрезаны, первые `maximum` символов.
fn st(value: V<'_>, maximum: usize) -> String {
    text::head(&text::squash_spaces(&js::s(value)), maximum)
}

fn st_str(value: &str, maximum: usize) -> String {
    text::head(&text::squash_spaces(value), maximum)
}

/// `toLocaleLowerCase('ru').replace(/ё/gu, 'е')`.
fn folded(value: &str) -> String {
    text::lower(value).replace('ё', "е")
}

/// `.length` значения: массив и строка — длина, объект — его поле `length`,
/// иное — `undefined`.
fn length_value(value: V<'_>) -> Option<Value> {
    match value {
        Some(Value::Array(items)) => Some(Value::from(items.len())),
        Some(Value::String(chars)) => Some(Value::from(chars.encode_utf16().count())),
        Some(Value::Object(map)) => map.get("length").cloned(),
        _ => None,
    }
}

/// `(value ?? []).length > 0`.
fn has_items(value: V<'_>) -> bool {
    let value = if js::present(value) { value } else { None };
    js::number(length_value(value).as_ref()) > 0.0
}

/// `(value ?? []).length` как условие.
fn length_truthy(value: V<'_>) -> bool {
    let value = if js::present(value) { value } else { None };
    js::truthy(length_value(value).as_ref())
}

/// `brief?.known_environment?.player_intent ?? brief?.player_intent`.
fn player_intent(brief: &Value) -> V<'_> {
    nullish(prop(prop(Some(brief), "known_environment"), "player_intent"), prop(Some(brief), "player_intent"))
}

fn environment(brief: &Value) -> V<'_> {
    prop(Some(brief), "known_environment")
}

fn scene_of(brief: &Value) -> V<'_> {
    prop(environment(brief), "scene")
}

fn events_of(brief: &Value) -> &[Value] {
    arr(prop(Some(brief), "visible_events"))
}

fn event_type(event: &Value) -> Option<&str> {
    prop(Some(event), "event_type").and_then(Value::as_str)
}

/// `String(event?.event_type ?? '')`.
fn event_type_text(event: &Value) -> String {
    js::s(prop(Some(event), "event_type"))
}

/// `event?.payload?.[key]`.
fn payload_field<'a>(event: &'a Value, key: &str) -> V<'a> {
    prop(prop(Some(event), "payload"), key)
}

/// `[...values].filter(Boolean).join(' ')`.
fn joined(values: &[V<'_>]) -> String {
    values.iter().filter(|value| js::truthy(**value)).map(|value| js::s(*value)).collect::<Vec<_>>().join(" ")
}

/// `Array.isArray(value) ? value : [value]`.
fn spread_list(value: V<'_>) -> Vec<V<'_>> {
    match value {
        Some(Value::Array(items)) => items.iter().map(Some).collect(),
        other => vec![other],
    }
}

/// `text.split(regex)` для выражения, которое не совпадает с пустой строкой.
fn split_re<'t>(regex: &Regex, value: &'t str) -> Vec<&'t str> {
    let mut pieces = Vec::new();
    let mut last = 0;
    for found in regex.find_iter(value).filter_map(Result::ok) {
        if found.end() == found.start() {
            continue;
        }
        pieces.push(&value[last..found.start()]);
        last = found.end();
    }
    pieces.push(&value[last..]);
    pieces
}

/// `text.slice(Math.max(0, index - count), index)` по символам: `count`
/// последних символов перед байтовой позицией `index`.
fn chars_before(value: &str, index: usize, count: usize) -> &str {
    let before = &value[..index];
    let start = before.char_indices().rev().nth(count.saturating_sub(1)).map_or(0, |(at, _)| at);
    if count == 0 {
        return "";
    }
    &before[start..]
}

/// `escapePattern`: символы выражения JS экранируются обратной косой.
fn escape_pattern(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        if ".*+?^${}()|[]\\".contains(ch) {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
}

/// `new RegExp(source, flags)`; не собралось — нет совпадений.
/// Собранные выражения по исходнику и флагам: V8 тоже не пересобирает
/// одинаковые `new RegExp(...)`, а сборка выражения с `\p{L}` и флагом `i` —
/// дорогая часть проверки.
static DYNAMIC_REGEX_CACHE: LazyLock<Mutex<std::collections::HashMap<String, Option<Arc<Regex>>>>> = LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

fn dynamic_regex(source: &str, flags: &str) -> Option<Arc<Regex>> {
    let key = format!("{flags}\u{0}{source}");
    if let Some(found) = lock(&DYNAMIC_REGEX_CACHE).get(&key) {
        return found.clone();
    }
    let compiled = text::js_regex(source, flags).map(Arc::new);
    let mut cache = lock(&DYNAMIC_REGEX_CACHE);
    if cache.len() >= 4_096 {
        cache.clear();
    }
    cache.insert(key, compiled.clone());
    compiled
}

fn regex_test(regex: Option<&Regex>, value: &str) -> bool {
    regex.is_some_and(|regex| text::test(regex, value))
}

fn first_match(regex: &Regex, value: &str) -> Option<String> {
    regex.find(value).ok().flatten().map(|found| found.as_str().to_string())
}

fn object(map: Map<String, Value>) -> Value {
    Value::Object(map)
}

// ---------------------------------------------------------------------------
// Повторы и клише
// ---------------------------------------------------------------------------

fn narration_trigrams(value: &str) -> IndexSet<String> {
    let normalized = text::lower(&text::nfkc(&st_str(value, 4_000)));
    let tokens = text::find_all(re!(r"[a-zа-яё0-9]+", "giu"), &normalized);
    let mut result = IndexSet::new();
    let mut index = 0;
    while index + 3 <= tokens.len() {
        result.insert(tokens[index..index + 3].join(" "));
        index += 1;
    }
    result
}

struct Overlap {
    score: f64,
    shared: String,
}

fn trigram_jaccard(left_text: &str, right_text: &str) -> Overlap {
    let left = narration_trigrams(left_text);
    let right = narration_trigrams(right_text);
    if left.is_empty() && right.is_empty() {
        return Overlap { score: 0.0, shared: String::new() };
    }
    let mut intersection = 0usize;
    let mut shared = String::new();
    for item in &left {
        if !right.contains(item) {
            continue;
        }
        intersection += 1;
        if shared.is_empty() {
            shared = item.clone();
        }
    }
    let denominator = (left.len() + right.len()).saturating_sub(intersection).max(1);
    Overlap { score: intersection as f64 / denominator as f64, shared }
}

/// `boundedRecentNarrations(values)`.
fn bounded_recent_narrations(values: &[Value]) -> Vec<String> {
    let all: Vec<String> = values.iter().map(|value| st(Some(value), 4_000)).filter(|value| !value.is_empty()).collect();
    let skip = all.len().saturating_sub(NARRATOR_RECENT_TEXT_LIMIT);
    all.into_iter().skip(skip).collect()
}

fn closest_recent_narration(value: &str, recent: &[Value]) -> Overlap {
    let mut closest = Overlap { score: 0.0, shared: String::new() };
    for entry in bounded_recent_narrations(recent) {
        let candidate = trigram_jaccard(value, &entry);
        if candidate.score > closest.score {
            closest = candidate;
        }
    }
    closest
}

fn weather_mention() -> &'static Regex {
    re!(r"(?<![а-яё])(?:дожд\p{L}*|морос\p{L}*|капл\p{L}*|туч\p{L}*|ливн\p{L}*|снег\p{L}*|метел\p{L}*|туман\p{L}*|гроз\p{L}*|небо|небе|солнц\p{L}*|ветер|ветр\p{L}*|утренн\p{L}*\s+свет)(?![а-яё])", "iu")
}

/// `weatherRecentlyMentioned(recentNarrations)`: погода уже звучала в одном
/// из двух последних ответов.
pub fn weather_recently_mentioned(recent: &[Value]) -> bool {
    let bounded = bounded_recent_narrations(recent);
    let skip = bounded.len().saturating_sub(2);
    bounded.iter().skip(skip).any(|entry| text::test(weather_mention(), entry))
}

/// `recentClicheReminders(recentNarrations)`: читаемые формы клише, которые
/// модель уже написала в недавних ответах.
pub fn recent_cliche_reminders(recent: &[Value]) -> Vec<String> {
    let mut seen: IndexMap<&'static str, String> = IndexMap::new();
    for entry in bounded_recent_narrations(recent) {
        for cliche in find_narrator_cliches_in(&entry) {
            seen.entry(cliche.entry.id).or_insert_with(|| st_str(cliche.entry.label, 60));
        }
    }
    seen.into_values().take(NARRATOR_CLICHE_REMINDER_LIMIT).collect()
}

const SUGGESTION_STOP_WORDS: &[&str] = &[
    "герой", "героя", "сцена", "сцены", "место", "цель", "дальше", "снова", "проверить", "осмотреть", "осмотреться", "узнать", "спросить", "уточнить", "поговорить", "использовать",
    "применить", "предложить", "продолжить", "the", "and", "with", "from", "into",
];

fn suggestion_root(token: &str) -> String {
    let value = text::lower(token);
    let root = if text::test(re!(r"^[а-яё]+$", "u"), &value) {
        text::replace_first(re!(r"(?:иями|ями|ами|ого|ему|ыми|ими|иях|ость|ости|ение|ений|ать|ять|ить|ешь|ете|ают|яют|ому|ей|ой|ий|ый|ая|яя|ое|ие|ам|ом|ую|ах|ях|ов|ев|ы|и|а|я|е|о|у)$", "u"), &value, "")
    } else {
        text::replace_first(re!(r"(?:ations|ation|ments|ment|ingly|ing|edly|ed|ies|es|s)$", "u"), &value, "")
    };
    if text::len(&root) >= 3 {
        root
    } else {
        value
    }
}

/// `suggestionRoots(value)` для строки `String(value ?? '')`.
fn suggestion_roots(value: &str) -> IndexSet<String> {
    let lowered = text::lower(&st_str(value, 2_000));
    text::find_all(re!(r"[a-zа-яё0-9]+", "giu"), &lowered)
        .into_iter()
        .filter(|token| text::len(token) >= 3 && !SUGGESTION_STOP_WORDS.contains(&token.as_str()))
        .map(|token| suggestion_root(&token))
        .collect()
}

/// `sharedRootCount(left, right)` для уже склеенных сторон.
fn shared_roots(left: &str, right: &str) -> usize {
    let left = suggestion_roots(left);
    let right = suggestion_roots(right);
    left.iter().filter(|root| right.contains(*root)).count()
}

// ---------------------------------------------------------------------------
// Момент, тон, план ответа
// ---------------------------------------------------------------------------

fn moment_patterns() -> [(&'static str, &'static Regex); 4] {
    [
        ("transition", re!(r"Scene|Travel|Location|Area|CampaignArc", "i")),
        ("combat", re!(r"Attack|Damage|Healing|Combat|Turn|SavingThrow|Concentration|Death|Knockout", "i")),
        ("discovery", re!(r"Reveal|Discover|Inspect|Search|WorldFact|Lore", "i")),
        ("social", re!(r"Npc|Relationship|Promise|Conversation|Dialogue", "i")),
    ]
}

/// `narratorMomentFor(brief)`: `transition`, `combat`, `discovery`,
/// `social`, `action` или `quiet`.
pub fn narrator_moment_for(brief: &Value) -> &'static str {
    let events = events_of(brief);
    for (moment, pattern) in moment_patterns() {
        if events.iter().any(|event| text::test(pattern, &event_type_text(event))) {
            return moment;
        }
    }
    if length_truthy(prop(Some(brief), "permitted_npc_reactions")) {
        return "social";
    }
    let scene = scene_of(brief);
    if js::truthy(prop(scene, "transition")) || js::truthy(prop(scene, "arrival")) {
        return "transition";
    }
    if events.is_empty() {
        "quiet"
    } else {
        "action"
    }
}

fn tone_patterns() -> [(&'static str, &'static Regex); 6] {
    [
        ("tense", re!(r"напряж|опас|тревог|угроз|страх|мрач|жестк|tense|danger|grim|dark", "iu")),
        ("mysterious", re!(r"тайн|загад|мист|неизвест|скрыт|myst|secret", "iu")),
        ("somber", re!(r"печал|траур|скорб|безысход|суров|somber|tragic", "iu")),
        ("warm", re!(r"тёпл|уют|друж|добро|светл|warm|friendly", "iu")),
        ("hopeful", re!(r"надеж|героич|ободр|hope|heroic", "iu")),
        ("triumphant", re!(r"триумф|побед|торжеств|triumph|victor", "iu")),
    ]
}

fn narrator_tone_tags(brief: &Value) -> Vec<&'static str> {
    let premise = prop(environment(brief), "campaign_premise");
    let scene = scene_of(brief);
    let source = joined(&[prop(premise, "tone"), prop(premise, "themes"), prop(scene, "mood"), prop(scene, "theme")]);
    let tags: Vec<&'static str> = tone_patterns().into_iter().filter(|(_, pattern)| text::test(pattern, &source)).map(|(tag, _)| tag).collect();
    if tags.is_empty() {
        vec!["grounded"]
    } else {
        tags
    }
}

/// Декларация и число броска не разрешают рассказчику завершить само действие.
const DECLARATION_EVENTS: [&str; 3] = ["ActionDeclared", "RulingRecorded", "ObjectiveUpdated"];

fn is_declaration_type(event: &Value) -> bool {
    event_type(event).is_some_and(|kind| DECLARATION_EVENTS.contains(&kind))
}

/// `freeActionRulingOutcome(event)`: итог судейского решения по свободному
/// действию (`success`/`failure`) или `None`, если это ещё декларация.
pub fn free_action_ruling_outcome(event: &Value) -> Option<&'static str> {
    if event_type(event) != Some("RulingRecorded") {
        return None;
    }
    match prop(payload_field(event, "ruling"), "outcome").and_then(Value::as_str) {
        Some("success") => Some("success"),
        Some("failure") => Some("failure"),
        _ => None,
    }
}

fn is_declaration_event(event: &Value) -> bool {
    is_declaration_type(event) && free_action_ruling_outcome(event).is_none()
}

fn echo_sentences() -> &'static Regex {
    re!(r#"(?:«[^«»]*»|[^.!?…])+(?:[.!?…]+[»"]*|$)\s*"#, "gu")
}

/// `withoutEchoOfPlayer(narration, brief)`: предложения, почти целиком
/// повторяющие заявку игрока, срезаются, если после них остаётся ответ.
pub fn without_echo_of_player(narration: &str, brief: &Value) -> String {
    let action = js::s(prop(player_intent(brief), "action"));
    if action.is_empty() || narration.is_empty() {
        return narration.to_string();
    }
    let stem = |word: &str| text::head(&folded(word), 5);
    let said: IndexSet<String> = text::find_all(re!(r"\p{L}{4,}", "gu"), &action).iter().map(|word| stem(word)).collect();
    let mut sentences = text::find_all(echo_sentences(), narration);
    if sentences.is_empty() {
        sentences = vec![narration.to_string()];
    }
    let echo = |sentence: &str| {
        let unquoted = text::replace_all(re!(r"«[^«»]*»", "gu"), sentence, " ");
        let words: Vec<String> = text::find_all(re!(r"\p{L}{4,}", "gu"), &unquoted).iter().map(|word| stem(word)).collect();
        let quoted = text::test(re!(r"«[^«»]{8,}»", "u"), sentence) && action.contains(&text::capture(re!(r"«([^«»]{8,})»", "u"), sentence, 1).unwrap_or_else(|| "\u{0}".to_string()));
        if words.is_empty() {
            return quoted;
        }
        let shared = words.iter().filter(|word| said.contains(*word)).count() as f64 / words.len() as f64;
        shared >= 0.7 || (quoted && shared >= 0.5)
    };
    let kept: Vec<&String> = sentences.iter().filter(|sentence| !echo(sentence)).collect();
    if kept.is_empty() || kept.len() == sentences.len() {
        return narration.to_string();
    }
    text::trim(&kept.iter().map(|sentence| sentence.as_str()).collect::<String>()).to_string()
}

const THIN_RESULT_EVENTS: [&str; 6] = ["AbilityCheckResolved", "DieRolled", "RollResolved", "DamageApplied", "HealingApplied", "TimeAdvanced"];

/// `narratorResponsePlan(brief)`: что и сколько должен сказать ответ.
pub fn narrator_response_plan(brief: &Value) -> Value {
    let events = events_of(brief);
    let intent = player_intent(brief);
    let roleplay = js::is_true(prop(intent, "roleplay_speech"));
    let has_reactions = has_items(prop(Some(brief), "permitted_npc_reactions"));
    let declaration_only = !events.is_empty() && events.iter().all(is_declaration_event) && !has_reactions;
    let free_outcome = events.iter().find_map(free_action_ruling_outcome);
    let injured = events.iter().any(|event| event_type(event) == Some("DamageApplied"));
    let observation = !injured
        && events.iter().any(|event| event_type(event) == Some("AbilityCheckResolved") && ["perception", "investigation"].contains(&js::s(payload_field(event, "skill")).as_str()));
    let lively_outcome = (free_outcome == Some("success") && !injured) || observation;
    let failed_free_action = free_outcome == Some("failure") && !injured;
    let thin_result = !lively_outcome
        && !failed_free_action
        && !events.is_empty()
        && events.iter().all(|event| {
            let kind = event_type(event);
            is_declaration_type(event)
                || kind.is_some_and(|kind| THIN_RESULT_EVENTS.contains(&kind))
                || (matches!(kind, Some("DoorLockpicked" | "DoorForced")) && !js::is_true(payload_field(event, "success")))
                || (kind == Some("DoorStateChanged") && !is_str(payload_field(event, "state"), "open"))
        })
        && !has_reactions;
    let moment = narrator_moment_for(brief);
    let speech_act = if declaration_only {
        "acknowledge_intent"
    } else if !events.is_empty() || has_reactions {
        "report_result"
    } else {
        "describe_scene"
    };
    let discovered = events.iter().any(|event| event_type(event) == Some("WorldFactRecorded") && is_str(prop(payload_field(event, "fact"), "predicate"), "discovery"));
    let outcome_detail = text::trim(&js::s(prop(intent, "outcome_detail"))).to_string();
    let thorough_search = js::s(prop(intent, "thorough_search"));
    let spell_cast = text::trim(&js::s(prop(prop(intent, "spell_cast"), "name"))).to_string();
    let spell_note = if spell_cast.is_empty() {
        String::new()
    } else {
        format!(" Заклинание «{spell_cast}» сработало: его действие видно — не пиши, что ничего не появилось или оно не подействовало.")
    };
    let check_success = events.iter().find(|event| event_type(event) == Some("AbilityCheckResolved")).and_then(|event| payload_field(event, "success"));
    let check_outcome = free_outcome.or(match check_success {
        Some(Value::Bool(true)) => Some("success"),
        Some(Value::Bool(false)) => Some("failure"),
        _ => None,
    });
    let must_answer: String = if declaration_only {
        "Кратко пояснить, что намерение ещё не стало выполненным действием.".into()
    } else if thorough_search == "found" && discovered {
        "Не пересказывая заявку: с ходу не нашлось, но долгий поиск не торопясь принёс находку — назови её вещественно по записанной находке; что ушло время, покажи деталью (свеча прогорела, дождь стих), а не отчётом «ушло около получаса». Сверх находки сведений не добавлять.".into()
    } else if thorough_search == "nothing" {
        "Не пересказывая заявку: герой обыскал всё не торопясь и убедился, что спрятанного здесь нет; что ушло время, покажи деталью, а не отчётом; одна живая деталь места. Скрытого не выдумывать.".into()
    } else if !outcome_detail.is_empty() && check_outcome == Some("failure") {
        format!(
            "Не пересказывая заявку, показать, почему не достигнута цель проверки и чем это обернулось, — через деталь исхода (что герой видит при этом исходе), своими словами и не теряя её смысла{}. То, что герой делает наверняка (заклинание, шаг, слова), состоялось. Сверх этого скрытого не выдумывать.",
            if discovered { "; назвать и записанную деталь места" } else { "" }
        )
    } else if !outcome_detail.is_empty() && check_outcome == Some("success") && !discovered {
        "Не пересказывая заявку, показать, как именно вышло, — через деталь исхода (что герой видит при этом исходе), своими словами и не теряя её смысла; добавить, как откликается место или люди рядом (только разрешённые реакции). Новых находок, сведений и согласия NPC не добавлять.".into()
    } else if free_outcome == Some("failure") {
        if discovered {
            "Не пересказывая заявку, показать, что не достигнута цель проверки из player_intent.goal, и назвать деталь места из события WorldFactRecorded — это то, что герой всё же видит или слышит. То, что герой делает наверняка (player_intent.approach: заклинание, шаг, слова), состоялось. Скрытого и причину неудачи не выдумывать.".into()
        } else {
            "Не пересказывая заявку, показать, что не достигнута цель проверки из player_intent.goal, и одну живую деталь того, что герой при этом видит, слышит или чувствует. То, что герой делает наверняка (player_intent.approach: заклинание, шаг, слова), состоялось. Скрытого и причину неудачи не выдумывать.".into()
        }
    } else if roleplay {
        "Слова героя уже прозвучали и услышаны — не повторяй, не пересказывай и не глуши их («слова тонут в грохоте»). Ответь на них как ведущий одной-двумя фразами: дай отозваться месту через new_element (если он есть) — деталь, которой ещё не было, и пусть она откликается на сказанное или подталкивает к следующему шагу; если сказанное касается предыстории героя, пусть деталь отзовётся ей. Взгляд или жест из permitted_npc_reactions — только если такого не было в recent_narrations. За других героев отряда не отвечай и решений за них не принимай.".into()
    } else if discovered {
        "Не пересказывая заявку, сразу назвать находку из события WorldFactRecorded (predicate discovery) — то, что герой нашёл или узнал, своими словами и вещественно; добавить, как откликается место или люди рядом (только permitted_npc_reactions). Сверх находки сведений и согласия NPC не добавлять.".into()
    } else if free_outcome == Some("success") {
        "Не пересказывая заявку, показать, что из неё вышло: видимый результат и как откликается место или люди рядом (только permitted_npc_reactions); новых находок, сведений и согласия NPC не добавлять.".into()
    } else if !events.is_empty() || has_reactions {
        "Сначала передать исход текущего шага по видимым событиям и разрешённым реакциям.".into()
    } else {
        "Кратко описать уже известную обстановку без нового события.".into()
    };
    let soft_sentence_limit: i64 = if thin_result {
        1
    } else if moment == "transition" || lively_outcome {
        4
    } else {
        3
    };
    let mut plan = json!({
        "version": "narrator-response-plan/v2",
        "mode": "world_narration",
        "speech_act": speech_act,
        "must_answer": must_answer,
        "include_scene_detail": !thin_result,
        "include_memory": !thin_result && free_outcome.is_none(),
        "max_questions": 0,
        "soft_sentence_limit": soft_sentence_limit,
        "stop_after": speech_act,
        "delivery": if thin_result { "after_validation" } else { "sentence_buffered" },
    });
    if !spell_note.is_empty() {
        plan["must_answer"] = string_value(format!("{must_answer}{spell_note}"));
        plan["include_scene_detail"] = Value::Bool(true);
        plan["soft_sentence_limit"] = Value::from(soft_sentence_limit.max(3));
    }
    plan
}

fn plan_flag(plan: &Value, key: &str) -> bool {
    js::truthy(prop(Some(plan), key))
}

/// `selectNarratorFewShotExamples(brief, { style, count })`: до трёх примеров
/// стиля, ближайших моменту и тону сцены. `style` по умолчанию — стиль
/// кампании (`currentNarratorStyle()`), `count` — 3.
pub fn select_narrator_few_shot_examples(brief: &Value, style: Option<&Value>, count: Option<&Value>) -> Vec<Value> {
    if !plan_flag(&narrator_response_plan(brief), "include_scene_detail") {
        return Vec::new();
    }
    let style = match style {
        Some(style) => js::string(Some(style)),
        None => current_narrator_style(),
    };
    let selected_style = if ["neutral", "formal", "ironic"].contains(&style.as_str()) { style } else { "neutral".to_string() };
    let moment = narrator_moment_for(brief);
    let tones: IndexSet<&str> = narrator_tone_tags(brief).into_iter().collect();
    let requested = match count {
        None => 3.0,
        Some(value) => {
            let number = js::number(Some(value));
            if number.is_nan() || number == 0.0 {
                3.0
            } else {
                number
            }
        }
    };
    let maximum = 2.0_f64.max(3.0_f64.min(requested)).floor() as usize;
    let mut scored: Vec<(f64, &Value)> = NARRATOR_FEW_SHOT_CORPUS
        .iter()
        .filter(|example| is_str(prop(Some(example), "style"), &selected_style))
        .map(|example| {
            let moment_score = if is_str(prop(Some(example), "moment"), moment) { 10.0 } else { 0.0 };
            let tone_score: f64 = arr(prop(Some(example), "tones")).iter().map(|tone| if tones.contains(js::s(Some(tone)).as_str()) { 2.0 } else { 0.0 }).sum();
            (moment_score + tone_score, example)
        })
        .collect();
    scored.sort_by(|(left_score, left), (right_score, right)| {
        right_score
            .partial_cmp(left_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| text::locale_compare(&js::s(prop(Some(left), "id")), &js::s(prop(Some(right), "id"))))
    });
    scored.into_iter().take(maximum).map(|(_, example)| example.clone()).collect()
}

fn narrator_prompt_with_examples(examples: &[Value]) -> String {
    if examples.is_empty() {
        return NARRATOR_PROMPT.to_string();
    }
    let fragments: Vec<String> = examples
        .iter()
        .enumerate()
        .map(|(index, example)| {
            let field = |key: &str| js::s(prop(Some(example), key));
            let list = |key: &str, separator: &str| arr(prop(Some(example), key)).iter().map(|item| js::s(Some(item))).collect::<Vec<_>>().join(separator);
            format!(
                "{}. [{}; {}; {}]\nОбращение: {}\nРазрешённые факты: {}\nЗадача ответа: {}\nОтвет: {}",
                index + 1,
                field("style"),
                field("moment"),
                list("tones", ", "),
                field("player_message"),
                list("allowed_facts", " "),
                field("response_goal"),
                field("text")
            )
        })
        .collect();
    let marker = "\nВерни только готовое повествование обычным текстом.";
    let example_section = format!(
        "\nCURATED_STYLE_EXAMPLES ({NARRATOR_FEW_SHOT_VERSION}):\nЭто отдельные вымышленные сцены для ритма фразы, не факты текущего хода.\n{}\nСобытия и предметы этих примеров нельзя переносить в ответ без собственных оснований в NarrationBrief.\n",
        fragments.join("\n")
    );
    if NARRATOR_PROMPT.contains(marker) {
        NARRATOR_PROMPT.replacen(marker, &format!("{example_section}{marker}"), 1)
    } else {
        format!("{NARRATOR_PROMPT}{example_section}")
    }
}

/// `narratorContentDirectives(brief)`: `{ tone, themes, boundaries }` из
/// посылки кампании.
pub fn narrator_content_directives(brief: &Value) -> Value {
    let premise = prop(environment(brief), "campaign_premise");
    json!({
        "tone": st(prop(premise, "tone"), 500),
        "themes": st(prop(premise, "themes"), 800),
        "boundaries": st(prop(premise, "boundaries"), 1_000),
    })
}

// ---------------------------------------------------------------------------
// Пересказ прошлой арки
// ---------------------------------------------------------------------------

fn number_text(value: f64) -> String {
    js::f64_string(value)
}

fn arc_recap_identity(brief: &Value, recap: &Value) -> String {
    let premise = prop(environment(brief), "campaign_premise");
    let arc_number = js::number(prop(Some(recap), "arc_number"));
    let arc_number = if arc_number.is_nan() || arc_number == 0.0 { 0.0 } else { arc_number };
    [
        st(prop(premise, "preset"), 160),
        st(prop(premise, "premise"), 400),
        number_text(arc_number),
        st(prop(Some(recap), "title"), 160),
        st(prop(Some(recap), "epilogue"), 1_200),
    ]
    .join("\u{1f}")
}

fn recap_said(narration: &str) -> bool {
    text::test(re!(r"в\s+прошл(?:ый|ую)\s+раз", "iu"), narration)
}

fn arc_recap_seen(recap: &Value, recent: &[Value]) -> bool {
    bounded_recent_narrations(recent)
        .iter()
        .any(|narration| recap_said(narration) && shared_roots(narration, &joined(&[prop(Some(recap), "title"), prop(Some(recap), "epilogue")])) >= 2)
}

/// Параметры [`narrator_arc_recap`] (`{ includeOpeningArc, recentNarrations,
/// recappedArcKeys }`).
#[derive(Debug, Clone, Copy, Default)]
pub struct ArcRecapOptions<'a> {
    pub include_opening_arc: bool,
    pub recent_narrations: &'a [Value],
    pub recapped_arc_keys: Option<&'a IndexSet<String>>,
}

/// `narratorArcRecap(brief, options)`: пересказ закрытой арки из
/// `arc_history` — на самом событии перехода либо на первом вызове в первой
/// главе новой арки.
pub fn narrator_arc_recap(brief: &Value, options: &ArcRecapOptions<'_>) -> Option<Value> {
    arc_recap_with(brief, None, options)
}

/// Пересказ с учётом подменённого значения: внутри `render` бриф несёт уже
/// решённый пересказ (в JS — скрытое символьное свойство брифа).
fn arc_recap_with(brief: &Value, arc_override: Option<&Option<Value>>, options: &ArcRecapOptions<'_>) -> Option<Value> {
    if let Some(fixed) = arc_override {
        return fixed.clone();
    }
    let transition = events_of(brief).iter().find(|event| event_type(event) == Some("CampaignArcCompleted"));
    let premise = prop(environment(brief), "campaign_premise");
    let current_arc = js::number(prop(premise, "current_arc_number"));
    let current_chapter = js::number(prop(premise, "current_chapter"));
    let safe = |value: f64| value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0;
    let opening_new_arc = safe(current_arc) && current_arc > 1.0 && current_chapter == 1.0;
    if transition.is_none() && !(options.include_opening_arc && opening_new_arc) {
        return None;
    }
    let closed_from_event = js::number(transition.and_then(|event| prop(prop(prop(Some(event), "payload"), "closed_arc"), "arc_number")));
    let closed_arc = if safe(closed_from_event) && closed_from_event > 0.0 {
        Some(closed_from_event)
    } else if safe(current_arc) && current_arc > 1.0 {
        Some(current_arc - 1.0)
    } else {
        None
    };
    let history = arr(prop(premise, "arc_history"));
    let entry = history.iter().rev().find(|candidate| closed_arc.is_none_or(|closed| js::number(prop(Some(candidate), "arc_number")) == closed));
    let epilogue = st(entry.and_then(|entry| prop(Some(entry), "epilogue")), 1_200);
    if epilogue.is_empty() {
        return None;
    }
    let entry_number = js::number(entry.and_then(|entry| prop(Some(entry), "arc_number")));
    let arc_number = if entry_number.is_nan() || entry_number == 0.0 { closed_arc.map_or(Value::Null, js::num) } else { js::num(entry_number) };
    let recap = json!({
        "heading": "В прошлый раз",
        "arc_number": arc_number,
        "title": st(entry.and_then(|entry| prop(Some(entry), "title")), 160),
        "epilogue": epilogue,
    });
    let recap_key = arc_recap_identity(brief, &recap);
    if transition.is_none() && (arc_recap_seen(&recap, options.recent_narrations) || options.recapped_arc_keys.is_some_and(|keys| keys.contains(&recap_key))) {
        return None;
    }
    Some(recap)
}

// ---------------------------------------------------------------------------
// Сенсорные якоря
// ---------------------------------------------------------------------------

struct Palette {
    smell: [&'static str; 3],
    sound: [&'static str; 3],
    light: [&'static str; 3],
    touch: [&'static str; 3],
}

impl Palette {
    fn slot(&self, slot: &str) -> &[&'static str; 3] {
        match slot {
            "smell" => &self.smell,
            "sound" => &self.sound,
            "light" => &self.light,
            _ => &self.touch,
        }
    }
}

const SENSORY_PALETTES: [(&str, Palette); 8] = [
    (
        "tavern",
        Palette {
            smell: ["тёплый запах хлебной корки", "дым очага с пряной горечью", "запах дерева и пролитого эля"],
            sound: ["негромкий звон посуды", "потрескивание поленьев", "скрип половиц под редкими шагами"],
            light: ["медовый свет очага", "неровное пламя настенных свечей", "янтарные полосы света из окон"],
            touch: ["гладкое дерево, натёртое ладонями", "тепло от очага на одной стороне лица", "прохладная медь дверной скобы"],
        },
    ),
    (
        "forest",
        Palette {
            smell: ["смолистый запах хвои", "сырой запах мха и коры", "горечь раздавленных листьев"],
            sound: ["шорох ветвей над тропой", "редкий треск сухих сучьев", "приглушённый свист ветра между стволами"],
            light: ["пятнистый свет под кронами", "узкие серые лучи между стволами", "зелёный полумрак под ветвями"],
            touch: ["влажная кора под пальцами", "мягкая хвоя под сапогами", "холодные капли с нижних ветвей"],
        },
    ),
    (
        "cavern",
        Palette {
            smell: ["минеральная сырость камня", "запах холодной воды", "слабая горечь пещерной пыли"],
            sound: ["мерная капель в глубине", "долгое эхо каждого шага", "тихий ток воды за стеной"],
            light: ["свет, дробящийся на влажном камне", "узкий отблеск на своде", "густая тень за пределом огня"],
            touch: ["холодная шероховатость стены", "скользкая каменная крошка", "сырой воздух на коже"],
        },
    ),
    (
        "temple",
        Palette {
            smell: ["сухой запах ладана", "воск и холодный камень", "пыль старых тканей"],
            sound: ["долгое эхо под сводом", "тихий звон подвесок", "шелест воздуха в высоких нишах"],
            light: ["бледные полосы из верхних окон", "ровное сияние на плитах", "цветные пятна от витража"],
            touch: ["гладкий камень перил", "прохлада плит под ладонью", "сухая пыль на резьбе"],
        },
    ),
    (
        "settlement",
        Palette {
            smell: ["дым печей и влажная древесина", "запах сена у дворов", "смесь дорожной пыли и горячего железа"],
            sound: ["стук колёс по камню", "далёкий лай за оградой", "голоса из соседних дворов"],
            light: ["свет из низких окон", "длинные тени между домами", "бледное небо над крышами"],
            touch: ["пыль на деревянных перилах", "шероховатый камень мостовой", "прохлада железной скобы"],
        },
    ),
    (
        "dungeon",
        Palette {
            smell: ["застоявшаяся сырость", "каменная пыль и старое железо", "холодный запах подземного сквозняка"],
            sound: ["глухой отклик шагов", "скрежет цепи где-то впереди", "редкая капля за стеной"],
            light: ["тусклый отблеск на кладке", "резкая граница света и тьмы", "дрожащая тень в проёме"],
            touch: ["крошка раствора под пальцами", "холод ржавой решётки", "влажный камень стены"],
        },
    ),
    (
        "coast",
        Palette {
            smell: ["солёный запах водорослей", "запах смолы и мокрых канатов", "горечь гнилой рыбы у воды"],
            sound: ["удары волн о камни внизу", "крики чаек сквозь ветер", "глухой стук лодки о сваи"],
            light: ["отблески на мокром камне", "белая пена в темноте у скал", "серый свет над водой"],
            touch: ["солёные брызги на лице", "скользкий от водорослей камень", "мокрая верёвка под ладонью"],
        },
    ),
    (
        "generic",
        Palette {
            smell: ["запах влажного камня", "сухая пыль старого дерева", "прохладный воздух с горечью дыма"],
            sound: ["ровный шум ветра снаружи", "короткое эхо шагов", "далёкий неразборчивый звук"],
            light: ["мягкий боковой свет", "длинные неподвижные тени", "неровная граница света и тени"],
            touch: ["холод камня под пальцами", "шероховатое дерево под ладонью", "сухой сквозняк у пола"],
        },
    ),
];

fn palette_named(name: &str) -> &'static Palette {
    SENSORY_PALETTES.iter().find(|(id, _)| *id == name).map_or(&SENSORY_PALETTES[7].1, |(_, palette)| palette)
}

/// Кэш якорей по ключу сцены, как `sensoryAnchorCache` в JS (общий на
/// процесс, не больше 256 записей).
static SENSORY_ANCHOR_CACHE: LazyLock<Mutex<IndexMap<String, Value>>> = LazyLock::new(|| Mutex::new(IndexMap::new()));

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Очистить кэш сенсорных якорей (в JS он живёт до перезапуска процесса).
/// Нужен эталонам: последовательность вызовов JS начиналась с пустого кэша.
#[doc(hidden)]
pub fn reset_sensory_anchor_cache() {
    lock(&SENSORY_ANCHOR_CACHE).clear();
}

fn stable_text_hash(value: &str) -> u32 {
    let mut hash: i32 = 2_166_136_261_u32 as i32;
    for ch in value.chars() {
        hash ^= ch as i32;
        hash = hash.wrapping_mul(16_777_619);
    }
    hash as u32
}

fn sensory_palette_for(scene: V<'_>) -> &'static str {
    let source = joined(&[prop(scene, "title"), prop(scene, "location"), prop(scene, "theme"), prop(scene, "material")]);
    if text::test(re!(r"трактир|таверн|постоял|inn|tavern", "iu"), &source) {
        return "tavern";
    }
    if text::test(re!(r"маяк|причал|гаван|пристан|побереж|(?<![а-яё])берег|(?<![а-яё])порт(?![а-яё]*(?:рет|ье|н|ал|фел|ик))|lighthouse|harbou?r|dock|coast|pier", "iu"), &source) {
        return "coast";
    }
    if text::test(re!(r"лес|роща|чащ|дерев|хво|forest|wood", "iu"), &source) {
        return "forest";
    }
    if text::test(re!(r"пещер|грот|каверн|cave|cavern", "iu"), &source) {
        return "cavern";
    }
    if text::test(re!(r"храм|святилищ|часовн|temple|shrine", "iu"), &source) {
        return "temple";
    }
    if text::test(re!(r"город|деревн|посел|улиц|ворот|village|town|city", "iu"), &source) {
        return "settlement";
    }
    if text::test(re!(r"подзем|склеп|темниц|руин|dungeon|crypt|ruin", "iu"), &source) {
        return "dungeon";
    }
    "generic"
}

const SENSORY_SLOTS: [&str; 4] = ["smell", "sound", "light", "touch"];

fn normalized_sensory_anchors(value: V<'_>) -> Option<Vec<(&'static str, String)>> {
    let value = value.filter(|value| value.is_object())?;
    let anchors: Vec<(&'static str, String)> = SENSORY_SLOTS.iter().map(|slot| (*slot, st(prop(Some(value), slot), 180))).collect();
    (anchors.iter().filter(|(_, anchor)| !anchor.is_empty()).count() >= 3).then_some(anchors)
}

fn canon_sensory_overrides(canon: Option<&Value>) -> Vec<(&'static str, &'static str)> {
    let Some(canon) = canon else { return Vec::new() };
    if js::is_true(prop(Some(canon), "indoors")) {
        return Vec::new();
    }
    let phase = js::s(prop(prop(Some(canon), "time"), "phase"));
    let weather = js::s(prop(prop(Some(canon), "weather"), "id"));
    let mut overrides = Vec::new();
    if phase == "night" {
        overrides.push(("light", if weather == "clear" { "холодный свет луны и звёзд" } else { "редкие огни, тонущие в темноте" }));
    } else if weather == "fog" {
        overrides.push(("light", "серая пелена тумана, глотающая очертания"));
    } else if weather == "rain" || weather == "storm" {
        overrides.push(("light", "серый свет под низкими тучами"));
    }
    match weather.as_str() {
        "rain" => overrides.push(("touch", "холодные капли дождя на лице")),
        "storm" => overrides.push(("touch", "порывы мокрого ветра")),
        "fog" => overrides.push(("touch", "влажная пелена тумана на коже")),
        _ => {}
    }
    overrides
}

fn override_for(overrides: &[(&'static str, &'static str)], slot: &str) -> Option<&'static str> {
    overrides.iter().find(|(name, _)| *name == slot).map(|(_, anchor)| *anchor)
}

fn canon_compatible(anchor: &str, canon: Option<&Value>) -> bool {
    sk_world_story::scene_canon::sensory_anchor_conflicts(Some(&string_value(anchor)), canon).is_empty()
}

fn canon_anchor_key(canon: Option<&Value>) -> String {
    let Some(canon) = canon else { return String::new() };
    [prop(prop(Some(canon), "time"), "phase"), prop(prop(Some(canon), "time"), "clock"), prop(prop(Some(canon), "weather"), "id"), prop(Some(canon), "indoors")]
        .iter()
        .map(|value| js::s(*value))
        .collect::<Vec<_>>()
        .join("|")
}

fn scene_canon_of(brief: &Value) -> Option<Value> {
    let empty = json!({});
    let environment = nullish(environment(brief), Some(&empty)).unwrap_or(&empty);
    sk_world_story::scene_canon::scene_canon_from_environment(Some(environment))
}

/// `sensoryAnchorsFor(brief, { rotation })`: запах, звук, свет и касание места
/// — явные из сцены или из палитры по названию; под открытым небом свет и
/// касание задаёт канон, противоречащие ему якоря выпадают. `rotation` по
/// умолчанию — 0.
pub fn sensory_anchors_for(brief: &Value, rotation: Option<&Value>) -> Value {
    let scene = scene_of(brief);
    let canon = scene_canon_of(brief);
    let canon = canon.as_ref();
    let overrides = canon_sensory_overrides(canon);
    if let Some(explicit) = normalized_sensory_anchors(prop(scene, "sensory_anchors")) {
        if canon.is_none() {
            return object(explicit.into_iter().map(|(slot, anchor)| (slot.to_string(), string_value(anchor))).collect());
        }
        return object(
            explicit
                .into_iter()
                .map(|(slot, anchor)| {
                    let chosen = override_for(&overrides, slot).map(str::to_string).unwrap_or_else(|| if canon_compatible(&anchor, canon) { anchor } else { String::new() });
                    (slot, chosen)
                })
                .filter(|(_, anchor)| !anchor.is_empty())
                .map(|(slot, anchor)| (slot.to_string(), string_value(anchor)))
                .collect(),
        );
    }
    let scene_key = st(or(or(prop(scene, "id"), prop(scene, "location")), prop(scene, "title")), 240);
    if scene_key.is_empty() {
        return json!({});
    }
    let rotation_number = match rotation {
        None => 0.0,
        Some(value) => {
            let number = js::number(Some(value));
            if number.is_nan() {
                0.0
            } else {
                number
            }
        }
    };
    // `+ 0.0` снимает знак у `-0`: `String(-0)` в JS — «0».
    let turn = rotation_number.floor().max(0.0) + 0.0;
    let turn_text = number_text(turn);
    let key = if canon.is_some() { format!("{scene_key}\u{0}{}\u{0}{turn_text}", canon_anchor_key(canon)) } else { format!("{scene_key}\u{0}{turn_text}") };
    if let Some(cached) = lock(&SENSORY_ANCHOR_CACHE).get(&key) {
        return cached.clone();
    }
    let palette = palette_named(sensory_palette_for(scene));
    let seed = stable_text_hash(&scene_key);
    let pick = |slot: &str, shift: u32| -> String {
        if let Some(anchor) = override_for(&overrides, slot) {
            return anchor.to_string();
        }
        let options: Vec<&str> = palette.slot(slot).iter().copied().filter(|anchor| canon_compatible(anchor, canon)).collect();
        if options.is_empty() {
            return String::new();
        }
        let position = ((seed >> shift) as f64 + turn) % options.len() as f64;
        options.get(position as usize).map(|anchor| anchor.to_string()).unwrap_or_default()
    };
    let anchors: Map<String, Value> =
        [("smell", pick("smell", 0)), ("sound", pick("sound", 5)), ("light", pick("light", 10)), ("touch", pick("touch", 15))].into_iter().filter(|(_, anchor)| !anchor.is_empty()).map(|(slot, anchor)| (slot.to_string(), string_value(anchor))).collect();
    let anchors = object(anchors);
    let mut cache = lock(&SENSORY_ANCHOR_CACHE);
    cache.insert(key, anchors.clone());
    while cache.len() > 256 {
        cache.shift_remove_index(0);
    }
    anchors
}

// ---------------------------------------------------------------------------
// Память и обстановка
// ---------------------------------------------------------------------------

/// `value || fallback` как строка.
fn or_str(value: V<'_>, fallback: &str) -> String {
    if js::truthy(value) {
        js::s(value)
    } else {
        fallback.to_string()
    }
}

fn by_score_desc(entries: &mut [Value]) {
    entries.sort_by(|left, right| js::number(prop(Some(right), "score")).partial_cmp(&js::number(prop(Some(left), "score"))).unwrap_or(std::cmp::Ordering::Equal));
}

fn score_of(entry: Option<&Value>) -> f64 {
    js::number(entry.and_then(|entry| prop(Some(entry), "score")))
}

/// `narratorMemoryFocus(brief)`: самая тесно связанная со сценой видимая
/// деталь прошлого (обещание, прежние слова, эпизод, решение) или `None`.
pub fn narrator_memory_focus(brief: &Value) -> Option<Value> {
    let environment = environment(brief);
    let scene = prop(environment, "scene");
    let story = prop(environment, "story_context");
    let scene_values = [prop(scene, "title"), prop(scene, "location"), prop(scene, "objective")];
    let fact_values: Vec<V<'_>> = arr(prop(prop(environment, "world_memory"), "facts")).iter().flat_map(|fact| [prop(Some(fact), "subject"), prop(Some(fact), "summary")]).collect();
    let current_values: Vec<V<'_>> = scene_values.iter().copied().chain(fact_values.iter().copied()).collect();
    let scene_joined = joined(&scene_values);
    let fact_joined = joined(&fact_values);
    let current_joined = joined(&current_values);

    let mut promises: Vec<Value> = arr(prop(story, "open_promises"))
        .iter()
        .map(|entry| {
            let entry = Some(entry);
            json!({
                "kind": "promise",
                "label": st_str(&or_str(prop(entry, "npc"), "Открытое обещание"), 120),
                "cue": st(prop(entry, "text"), 500),
                "due_hint": st(prop(entry, "due_hint"), 160),
                "score": shared_roots(&joined(&[prop(entry, "npc"), prop(entry, "text"), prop(entry, "due_hint")]), &scene_joined),
            })
        })
        .filter(|entry| js::truthy(prop(Some(entry), "cue")))
        .collect();
    by_score_desc(&mut promises);
    if score_of(promises.first()) >= 2.0 {
        return promises.into_iter().next();
    }

    let mut interactions: Vec<Value> = arr(prop(story, "recent_interactions"))
        .iter()
        .map(|entry| {
            let entry = Some(entry);
            json!({
                "kind": "interaction",
                "label": st_str(&or_str(prop(entry, "npc"), "NPC"), 120),
                "cue": st(prop(entry, "npc_reply"), 500),
                "player_message": st(prop(entry, "player_message"), 240),
                "score": shared_roots(&joined(&[prop(entry, "npc"), prop(entry, "player_message"), prop(entry, "npc_reply")]), &current_joined),
            })
        })
        .filter(|entry| js::truthy(prop(Some(entry), "cue")))
        .collect();
    by_score_desc(&mut interactions);
    if score_of(interactions.first()) >= 2.0 {
        return interactions.into_iter().next();
    }

    let mut summaries: Vec<Value> = arr(prop(story, "recent_summaries"))
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let entry = Some(entry);
            json!({
                "kind": "summary",
                "label": st_str(&or_str(prop(entry, "title"), "Прошлая сцена"), 160),
                "cue": st(prop(entry, "summary"), 500),
                "source_id": st(prop(entry, "id"), 120),
                "order": index,
                "score": shared_roots(&joined(&[prop(entry, "title"), prop(entry, "summary")]), &fact_joined),
            })
        })
        .filter(|entry| js::truthy(prop(Some(entry), "cue")))
        .collect();
    summaries.sort_by(|left, right| {
        js::number(prop(Some(right), "score"))
            .partial_cmp(&js::number(prop(Some(left), "score")))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| js::number(prop(Some(left), "order")).partial_cmp(&js::number(prop(Some(right), "order"))).unwrap_or(std::cmp::Ordering::Equal))
    });
    if score_of(summaries.first()) >= 2.0 {
        return summaries.into_iter().next();
    }

    let mut decisions: Vec<Value> = arr(prop(story, "recent_decisions"))
        .iter()
        .map(|entry| {
            let entry = Some(entry);
            json!({
                "kind": "decision",
                "label": st_str(&or_str(or(prop(entry, "title"), prop(entry, "location")), "Прежнее решение"), 160),
                "cue": st(or(prop(entry, "outcome"), prop(entry, "objective")), 500),
                "score": shared_roots(&joined(&[prop(entry, "title"), prop(entry, "location"), prop(entry, "objective"), prop(entry, "outcome")]), &current_joined),
            })
        })
        .filter(|entry| js::truthy(prop(Some(entry), "cue")))
        .collect();
    by_score_desc(&mut decisions);
    if score_of(decisions.first()) >= 1.0 {
        decisions.into_iter().next()
    } else {
        None
    }
}

/// `freshSceneElement(brief, recent)`: якорь карты с его стороной, которого
/// не было в последних четырёх ответах; пусто — предложить нечего.
pub fn fresh_scene_element(brief: &Value, recent: &[Value]) -> String {
    let scene = scene_of(brief);
    let skip = recent.len().saturating_sub(4);
    let said = folded(&recent.iter().skip(skip).map(|entry| js::s(Some(entry))).collect::<Vec<_>>().join(" "));
    for mark in arr(prop(scene, "landmarks")) {
        let label = st(prop(Some(mark), "label"), 60);
        let lowered = folded(&label);
        let first = split_re(re!(r"\s+", "u"), &lowered).first().map(|word| text::head(word, 5)).unwrap_or_default();
        if label.is_empty() || text::len(&first) < 3 || said.contains(&first) {
            continue;
        }
        let place = st(prop(Some(mark), "where"), 40);
        return if place.is_empty() { label } else { format!("{label} — {place}") };
    }
    String::new()
}

/// `nowCardFor(brief, canon)`: где и когда отряд прямо сейчас.
fn now_card_for(brief: &Value, canon: Option<&Value>) -> Option<Value> {
    let scene = scene_of(brief);
    let area = prop(prop(scene, "spatial_context"), "current_area");
    let heroes = arr(prop(prop(scene, "field"), "heroes"));
    let mut card = Map::new();
    card.insert("place".into(), string_value(st(prop(scene, "location"), 120)));
    if js::truthy(prop(area, "name")) {
        card.insert("hero_area".into(), string_value(st(prop(area, "name"), 80)));
        card.insert("indoors".into(), Value::Bool(js::is_true(prop(area, "indoors"))));
    }
    if js::truthy(prop(prop(canon, "time"), "phase_label")) {
        card.insert("time_of_day".into(), string_value(st(prop(prop(canon, "time"), "phase_label"), 40)));
    }
    if js::truthy(prop(prop(canon, "weather"), "label")) {
        card.insert("weather".into(), string_value(st(prop(prop(canon, "weather"), "label"), 40)));
    }
    if !heroes.is_empty() {
        let party: Vec<Value> = heroes
            .iter()
            .take(6)
            .map(|hero| {
                let condition = prop(Some(hero), "condition");
                let tail = if js::truthy(condition) && !is_str(condition, "цел") { format!(", {}", st(condition, 20)) } else { String::new() };
                string_value(format!("{}: {}{tail}", st(prop(Some(hero), "name"), 40), st(prop(Some(hero), "area"), 40)))
            })
            .collect();
        card.insert("party".into(), Value::Array(party));
    }
    let facts = arr(prop(scene, "canon"));
    if !facts.is_empty() {
        card.insert("canon".into(), Value::Array(facts.iter().take(4).map(|fact| string_value(st(Some(fact), 200))).collect()));
    }
    let has_place = js::truthy(card.get("place")) || js::truthy(card.get("hero_area"));
    has_place.then(|| object(card))
}

fn scene_canon_for_prompt(canon: &Value) -> Value {
    let canon = Some(canon);
    json!({
        "summary": st(prop(canon, "summary"), 900),
        "time_of_day": st(prop(prop(canon, "time"), "phase_label"), 40),
        "clock": st(prop(prop(canon, "time"), "clock"), 8),
        "weather": st(prop(prop(canon, "weather"), "label"), 40),
        "indoors": js::is_true(prop(canon, "indoors")),
        "light": st(prop(prop(canon, "light"), "label"), 160),
        "surfaces": st(prop(prop(canon, "surfaces"), "label"), 160),
        "water_nearby": js::is_true(prop(prop(canon, "surfaces"), "water_nearby")),
        "materials": arr(prop(prop(canon, "surfaces"), "materials")).iter().map(|value| string_value(st(Some(value), 40))).take(3).collect::<Vec<_>>(),
        "location_kind": st(prop(prop(canon, "location"), "kind_label"), 60),
    })
}

/// События, которых рассказчик не произносит (деление часов задания).
const UNNARRATED_EVENT_TYPES: [&str; 1] = ["QuestClockAdvanced"];

fn narratable_events(brief: &Value) -> Vec<&Value> {
    events_of(brief).iter().filter(|event| !UNNARRATED_EVENT_TYPES.contains(&event_type_text(event).as_str())).collect()
}

fn object_or_empty(value: V<'_>) -> Map<String, Value> {
    value.and_then(Value::as_object).cloned().unwrap_or_default()
}

/// `briefForNarratorPrompt(brief)`: бриф для запроса к модели — без канона
/// (он уходит отдельным блоком), с видимой памятью только вокруг фокуса.
fn brief_for_narrator_prompt(brief: &Value) -> Value {
    let focus = narrator_memory_focus(brief);
    let mut environment_map = object_or_empty(environment(brief));
    environment_map.shift_remove("scene_canon");
    let story = environment_map.get("story_context").filter(|value| js::present(Some(value))).cloned().unwrap_or_else(|| json!({}));
    let story = Some(&story);
    let mut prompt_story = object_or_empty(story);
    prompt_story.shift_remove("npc_dossiers");
    let viewer_heroes: Vec<&Value> = arr(prop(story, "heroes")).iter().filter(|hero| js::truthy(prop(Some(hero), "is_viewer"))).collect();
    let viewer_ids: IndexSet<String> = viewer_heroes.iter().map(|hero| js::s(prop(Some(hero), "id"))).filter(|id| !id.is_empty()).collect();
    let viewer_names: IndexSet<String> = viewer_heroes.iter().map(|hero| text::lower(&st(prop(Some(hero), "name"), 120))).filter(|name| !name.is_empty()).collect();
    let visible_social_record = |record: &Value| {
        let visibility = prop(Some(record), "visibility");
        if ["gm_only", "gmOnly", "npc_private", "npcPrivate"].contains(&js::s(visibility).as_str()) {
            return false;
        }
        if !is_str(visibility, "specific_player") {
            return true;
        }
        viewer_ids.contains(&js::s(prop(Some(record), "hero_id"))) || viewer_names.contains(&text::lower(&st(prop(Some(record), "hero"), 120)))
    };
    let focus_kind = focus.as_ref().map(|focus| js::s(prop(Some(focus), "kind")));
    let focus_cue = focus.as_ref().map(|focus| js::s(prop(Some(focus), "cue")));
    let focused = |kind: &str, cue: String| match (&focus_kind, &focus_cue) {
        (None, _) => true,
        (Some(focus_kind), Some(focus_cue)) => focus_kind == kind && &cue == focus_cue,
        _ => false,
    };
    let summaries: Vec<Value> = arr(prop(story, "recent_summaries")).iter().filter(|entry| focused("summary", st(prop(Some(entry), "summary"), 500))).cloned().collect();
    let decisions: Vec<Value> =
        arr(prop(story, "recent_decisions")).iter().filter(|entry| focused("decision", st(or(prop(Some(entry), "outcome"), prop(Some(entry), "objective")), 500))).cloned().collect();
    let present_npcs: Vec<Value> = arr(prop(story, "present_npcs"))
        .iter()
        .map(|npc| {
            let npc = Some(npc);
            let mut entry = json!({
                "id": st(prop(npc, "id"), 120),
                "name": st(prop(npc, "name"), 120),
                "role": st(prop(npc, "role"), 120),
                "public_summary": st(prop(npc, "public_summary"), 300),
                "voice": st(prop(npc, "voice"), 200),
                "speech_profile": {
                    "pace": st(prop(prop(npc, "speech_profile"), "pace"), 100),
                    "lexicon": st(prop(prop(npc, "speech_profile"), "lexicon"), 180),
                    "mannerism": st(prop(prop(npc, "speech_profile"), "mannerism"), 180),
                },
                "relationship": st(prop(npc, "relationship"), 40),
            });
            if js::is_false(prop(npc, "known_by_name")) {
                entry["known_by_name"] = Value::Bool(false);
            }
            entry
        })
        .collect();
    let promises: Vec<Value> = arr(prop(story, "open_promises"))
        .iter()
        .filter(|promise| visible_social_record(promise))
        .filter(|promise| focused("promise", st(prop(Some(promise), "text"), 500)))
        .map(|promise| {
            let promise = Some(promise);
            json!({
                "id": st(prop(promise, "id"), 120),
                "npc": st(prop(promise, "npc"), 120),
                "hero_id": st(prop(promise, "hero_id"), 120),
                "direction": st(prop(promise, "direction"), 40),
                "text": st(prop(promise, "text"), 280),
                "due_hint": st(prop(promise, "due_hint"), 160),
                "source_conversation_id": st(prop(promise, "source_conversation_id"), 120),
            })
        })
        .collect();
    let interactions: Vec<Value> = arr(prop(story, "recent_interactions"))
        .iter()
        .filter(|interaction| visible_social_record(interaction))
        .filter(|interaction| focused("interaction", st(prop(Some(interaction), "npc_reply"), 500)))
        .map(|interaction| {
            let interaction = Some(interaction);
            json!({
                "npc": st(prop(interaction, "npc"), 120),
                "hero": st(prop(interaction, "hero"), 120),
                "hero_id": st(prop(interaction, "hero_id"), 120),
                "player_message": st(prop(interaction, "player_message"), 240),
                "npc_reply": st(prop(interaction, "npc_reply"), 320),
                "stance": st(prop(interaction, "stance"), 40),
            })
        })
        .collect();
    prompt_story.insert("recent_summaries".into(), Value::Array(summaries));
    prompt_story.insert("recent_decisions".into(), Value::Array(decisions));
    prompt_story.insert("present_npcs".into(), Value::Array(present_npcs.clone()));
    prompt_story.insert("open_promises".into(), Value::Array(promises));
    prompt_story.insert("recent_interactions".into(), Value::Array(interactions));
    environment_map.insert("story_context".into(), object(prompt_story));
    let mut prompt_brief = object_or_empty(Some(brief));
    let narratable: Vec<Value> = narratable_events(brief).into_iter().cloned().collect();
    prompt_brief.insert("visible_events".into(), Value::Array(narratable.clone()));

    if !plan_flag(&narrator_response_plan(brief), "include_memory") {
        const OUTCOME_FIELDS: [&str; 10] = ["ability", "skill", "success", "saved", "hit", "state", "damage_type", "immune", "resistant", "vulnerable"];
        let short_events: Vec<Value> = narratable
            .iter()
            .map(|event| {
                let mut entry = Map::new();
                for key in ["event_type", "actor_id", "target_ids"] {
                    if let Some(value) = prop(Some(event), key) {
                        entry.insert(key.into(), value.clone());
                    }
                }
                let mut payload = Map::new();
                for key in OUTCOME_FIELDS {
                    if let Some(value) = payload_field(event, key).filter(|value| !value.is_null()) {
                        payload.insert(key.into(), value.clone());
                    }
                }
                entry.insert("payload".into(), object(payload));
                object(entry)
            })
            .collect();
        prompt_brief.insert("visible_events".into(), Value::Array(short_events));
        prompt_brief.insert("visible_state_changes".into(), Value::Array(Vec::new()));
        environment_map.shift_remove("world_memory");
        environment_map.shift_remove("scenario");
        let mut scene = environment_map.get("scene").filter(|value| js::present(Some(value))).map(|value| object_or_empty(Some(value))).unwrap_or_default();
        scene.shift_remove("sensory_anchors");
        environment_map.insert("scene".into(), object(scene));
        let heroes = Value::Array(arr(prop(story, "heroes")).to_vec());
        environment_map.insert("story_context".into(), json!({ "heroes": heroes, "present_npcs": present_npcs }));
        prompt_brief.insert("known_environment".into(), object(environment_map));
        return object(prompt_brief);
    }
    if let Some(focus) = focus {
        let mut prompt_focus = object_or_empty(Some(&focus));
        prompt_focus.shift_remove("score");
        prompt_focus.shift_remove("order");
        if let Some(Value::Object(story)) = environment_map.get_mut("story_context") {
            story.insert("memory_focus".into(), object(prompt_focus));
        }
    }
    prompt_brief.insert("known_environment".into(), object(environment_map));
    object(prompt_brief)
}

fn memory_focus_is_recalled(narration: &str, focus: Option<&Value>) -> bool {
    let Some(focus) = focus else { return true };
    shared_roots(narration, &joined(&[prop(Some(focus), "label"), prop(Some(focus), "cue")])) >= 2
}

fn memory_focus_reminder(focus: Option<&Value>, variant: usize) -> String {
    let Some(focus) = focus else { return String::new() };
    let label = js::s(prop(Some(focus), "label"));
    let cue = js::s(prop(Some(focus), "cue"));
    match js::s(prop(Some(focus), "kind")).as_str() {
        "promise" => [
            format!("Открытым остаётся обещание — {label}: {cue}"),
            format!("Обещание всё ещё не закрыто — {label}: {cue}"),
            format!("Прежнее обещание не исполнено — {label}: {cue}"),
            format!("Нынешний шаг возвращает к обещанию — {label}: {cue}"),
        ][variant % 4]
            .clone(),
        "interaction" => {
            let cue = text::replace_first(re!(r"[.!?]+$", "u"), &cue, "");
            [
                format!("Прежние слова звучат снова — {label}: «{cue}»"),
                format!("Из прошлой беседы помнится — {label}: «{cue}»"),
                format!("Ещё раньше было сказано — {label}: «{cue}»"),
                format!("В памяти остался прежний ответ — {label}: «{cue}»"),
            ][variant % 4]
                .clone()
        }
        _ => String::new(),
    }
}

// ---------------------------------------------------------------------------
// Синхронная проверка ремесла
// ---------------------------------------------------------------------------

const CURRENT_REACTION_VERBS: &[&str] = &[
    "кива(?:ет|ют|л[аио]?)",
    "перелист(?:ывает|ывают|нул[аио]?)",
    "отодвига(?:ет|ют|л[аио]?)",
    "убира(?:ет|ют|л[аио]?)",
    "смотр(?:ит|ят)",
    "гляд(?:ит|ят)",
    "переглядыва(?:ется|ются)",
    "улыба(?:ется|ются)",
    "вздыха(?:ет|ют)",
    "жестикулиру(?:ет|ют)",
    "открыва(?:ет|ют)",
    "бер[её]т",
    "клад[её]т",
    "говорит",
    "отвеча(?:ет|ют)",
    "произнос(?:ит|ят)",
    "спрашива(?:ет|ют)",
    "отворачива(?:ется|ются)",
    "поворачива(?:ется|ются)",
    "уход(?:ит|ят)",
    "покида(?:ет|ют)",
    "выход(?:ит|ят)",
    "вход(?:ит|ят)",
    "подход(?:ит|ят)",
    "отход(?:ит|ят)",
    "отступа(?:ет|ют)",
    "вста(?:[её]т|ют)",
    "сад(?:ится|ятся)",
    "отпира(?:ет|ют)",
    "запира(?:ет|ют)",
    "закрыва(?:ет|ют)",
    "доста[её]т",
    "переда[её]т",
    "поднима(?:ет|ют)",
    "опуска(?:ет|ют)",
];

const PERMITTED_REACTION_PHRASES: &[&str] = &[
    r"встревожен[а-яё]*",
    r"принима(?:ет|ют)\s+довод[а-яё]*",
    r"оста[её]тся\s+при\s+сво[её]м",
    r"молча\s+наблюда(?:ет|ют)",
    r"держится\s+(?:приветлив[а-яё]*|насторож[а-яё]*|холодн[а-яё]*)",
    r"наблюда(?:ет|ют)",
    r"след(?:ит|ят)",
];

static NPC_REACTION_MARKERS: LazyLock<String> =
    LazyLock::new(|| format!(r"(?<![\p{{L}}\p{{N}}_])(?:{}|{})(?![\p{{L}}\p{{N}}_])", CURRENT_REACTION_VERBS.join("|"), PERMITTED_REACTION_PHRASES.join("|")));

fn reaction_matcher(reaction: &str) -> Option<&'static Regex> {
    Some(match reaction {
        "alarmed" => re!(r"(?:встревож|тревож|вздрог|испуг)", "iu"),
        "persuaded" => re!(r"(?:принима[а-яё]*\s+довод|соглаша|убежд)", "iu"),
        "unconvinced" => re!(r"(?:оста[её]тся\s+при\s+сво[её]м|не\s+соглаша|не\s+убежд|отверга)", "iu"),
        "welcoming" => re!(r"(?:держится\s+приветлив|приветлив|радуш|доброжел)", "iu"),
        "attentive" => re!(r"(?:молча[^.!?]{0,24}(?:наблюда|смотр)|вниматель[^.!?]{0,24}(?:наблюда|смотр|слуша)|наблюда\w*\s+за\s+разговор|след(?:ит|ят)|смотр(?:ит|ят)|гляд(?:ит|ят)|наблюда(?:ет|ют))", "iu"),
        "watchful" => re!(r"(?:держится\s+насторож|настороже|насторожен|следит)", "iu"),
        "cold" => re!(r"(?:держится\s+холодн|холодно|отстран|сухо)", "iu"),
        "reacts_to_act" => re!(r"(?:кива|смотр|гляд|переглядыва|улыба|вздыха|отворачива|поворачива|отход|отступа|наблюда|след(?:ит|ят)|молча|вздрог|встревож|поднима|опуска)", "iu"),
        _ => return None,
    })
}

const DEAD_NPC_CURRENT_ACTION_VERBS: &[&str] = &[
    "ид[её]т",
    "ход[иы]т",
    "стоит",
    "сидит",
    "жд[её]т",
    "жив[её]т",
    "возвраща(?:ется|ются)",
    "появля(?:ется|ются)",
    "наход(?:ится|ятся)",
    "держит",
    "нес[её]т",
    "читает",
    "пишет",
    "смотрит",
    "глядит",
    "открыва(?:ет|ют)",
    "закрыва(?:ет|ют)",
    "вход(?:ит|ят)",
    "выход(?:ит|ят)",
    "подход(?:ит|ят)",
    "уход(?:ит|ят)",
    "покида(?:ет|ют)",
    "говорит",
    "отвеча(?:ет|ют)",
    "произнос(?:ит|ят)",
    "шепчет",
    "кричит",
    "спрашива(?:ет|ют)",
    "рассказыва(?:ет|ют)",
    "сообща(?:ет|ют)",
    "улыба(?:ется|ются)",
    "кива(?:ет|ют)",
    "помога(?:ет|ют)",
    "атак(?:ует|уют)",
    "сража(?:ется|ются)",
    "переда[её]т",
    "бер[её]т",
    "клад[её]т",
    "поднима(?:ет|ют)",
    "опуска(?:ет|ют)",
];

fn dead_npc_current_action_assertion(value: &str, npc: &Value) -> String {
    let name = st(prop(Some(npc), "name"), 120);
    if name.is_empty() {
        return String::new();
    }
    let Some(pattern) = dynamic_regex(&format!(r"^(?:(?:и|но|а|теперь|сейчас)\s+)?{}\s+([^.!?]{{0,96}}?)({})(?![а-яё])", escape_pattern(&name), DEAD_NPC_CURRENT_ACTION_VERBS.join("|")), "iu") else {
        return String::new();
    };
    for sentence in split_re(re!(r"(?<=[.!?])\s+", "u"), value) {
        let candidate = text::trim(sentence);
        if candidate.is_empty() || text::test(re!(r#"^[«"„“—–-]"#, "u"), candidate) {
            continue;
        }
        let Ok(Some(found)) = pattern.captures(candidate) else { continue };
        let middle = found.get(1).map_or("", |group| group.as_str());
        if text::test(re!(r"(?:^|\s)(?:не|никогда|уже\s+не|больше\s+не)\s*$", "iu"), middle) || text::test(re!(r"(?:в\s+памят|в\s+запис|из\s+прошл|прежде|когда[-\s]?то|по\s+слов|вспомин|стар(?:ой|ую)\s+запис)", "iu"), middle) {
            continue;
        }
        return found.get(0).map_or_else(String::new, |whole| whole.as_str().to_string());
    }
    String::new()
}

const HERO_AGENCY_VERBS: &[&str] = &[
    r"попытал(?:ся|ась|ись)\s+разглядеть",
    r"(?:не\s+)?смог(?:ла|ли)?\s+удержать\s+равновесие",
    "подход(?:ит|ят)",
    "приседа(?:ет|ют)",
    "склоня(?:ется|ются)",
    "наклоня(?:ется|ются)",
    "проверя(?:ет|ют)",
    "сравнива(?:ет|ют)",
    "складыва(?:ет|ют)",
    "дума(?:ет|ют)",
    "реша(?:ет|ют)",
    "осматрива(?:ет|ют)",
    "каса(?:ется|ются)",
    "трога(?:ет|ют)",
    "перебира(?:ет|ют)",
    "ловит",
    "вспомина(?:ет|ют)",
    "отпира(?:ет|ют)",
    "запира(?:ет|ют)",
    "открыва(?:ет|ют)",
    "закрыва(?:ет|ют)",
    "уход(?:ит|ят)",
    "покида(?:ет|ют)",
    "вход(?:ит|ят)",
    "выход(?:ит|ят)",
    "поворачива(?:ется|ются)",
    "отворачива(?:ется|ются)",
    "вста(?:[её]т|ют)",
    "сад(?:ится|ятся)",
    "бер[её]т",
    "клад[её]т",
    "доста[её]т",
    "переда[её]т",
    "поднима(?:ет|ют)",
    "опуска(?:ет|ют)",
];

static HERO_AGENCY_SOURCE: LazyLock<String> = LazyLock::new(|| HERO_AGENCY_VERBS.join("|"));
static HERO_AGENCY_ONLY: LazyLock<Option<Arc<Regex>>> = LazyLock::new(|| dynamic_regex(&format!("(?:{})", *HERO_AGENCY_SOURCE), "iu"));

fn check_only_outcome() -> &'static Regex {
    re!(r"(?<![а-яё])(?:ловушк[а-яё]*[^.!?]{0,24}(?:удал[а-яё]*|уда[её]тся)|(?:взгляд|взор)[^.!?]{0,24}наш[её]л\s+то,?\s+что\s+искал)(?![а-яё])", "iu")
}

fn item_hiding() -> &'static Regex {
    re!(r"(?<![а-яё])(?:спрятан[а-яё]*|спрятал[а-яё]*)(?![а-яё])", "iu")
}

const MECHANICAL_TERM: &str = r"(?:брос\w*|выпал\w*|итог\w*|СЛ|HP|ОЗ|КД|урон\w*|лечен\w*|цен\w*|монет\w*|фт\.?|фут\w*|метр\w*|минут\w*|час\w*|ресурс\w*|заряд\w*|ячейк\w*)";
static MECHANICAL_NUMBER_PATTERN: LazyLock<Option<Arc<Regex>>> = LazyLock::new(|| dynamic_regex(&format!(r"(?:{MECHANICAL_TERM})[^.!?\d]{{0,24}}\d|\d[^.!?]{{0,24}}(?:{MECHANICAL_TERM})"), "iu"));

fn open_promise_resolution() -> &'static Regex {
    re!(r"обещан[а-яё]*[^.!?]{0,50}(?<![а-яё])(?<!не\s+)(?<!не\s+был[аои]?\s+)(?:на\s+месте|найден[а-яё]*|нашл[а-яё]*|получен[а-яё]*|передан[а-яё]*|забра[а-яё]*|доста[её]т)(?![а-яё])", "iu")
}

fn promised_object_state() -> &'static Regex {
    re!(r"(?<![а-яё])(?:леж(?:ит|ат|ал[аои]?|али)|наход(?:ит(?:ся)?|ятся|ился|илась|илось|ились)|видне(?:ется|ются|лся|лась|лись)|вид(?:ен|на|но|ны)|торч(?:ит|ат|ал[аои]?|али)|спрятан[а-яё]*|оставлен[а-яё]*|готов[а-яё]*|жд[её]т|найден[а-яё]*|замечен[а-яё]*|обнаружен[а-яё]*|выявлен[а-яё]*|оказал(?:ся|ась|ось|ись)|замеча(?:ет|ют|л[аои]?|ли)|нащуп(?:ал[аои]?|али|ывает|ывают)|обнаруж(?:ил[аои]?|или|ивает|ивают)|наш[её]л|нашл[аои]|на\s+месте)(?![а-яё])", "giu")
}

const PROMISE_GENERIC_ROOT_PREFIXES: [&str; 13] = ["обещ", "остав", "принес", "покаж", "показ", "переда", "получ", "исполн", "выполн", "сдерж", "слов", "открыт", "прежн"];

fn deed_gesture() -> &'static Regex {
    re!(r"(?<![а-яё])(?:(?:за|при)крыва(?:ет|ют)\s+глаза|наклоня(?:ется|ются)|склоня(?:ется|ются)|приседа(?:ет|ют)|ловит|ловят|каса(?:ется|ются)|трога(?:ет|ют)|поворачива(?:ется|ются)|отворачива(?:ется|ются)|вста(?:[её]т|ют)|сад(?:ится|ятся)|поднима(?:ет|ют)|опуска(?:ет|ют))(?![а-яё])", "iu")
}

fn deed_forbidden() -> &'static Regex {
    re!(r"(?<![а-яё])(?:бер[её]т|клад[её]т|доста[её]т|переда[её]т|открыва|закрыва(?!\S*\s+глаза)|отпира|запира|уход|покида|вход|выход|реша|дума|вспомина|провер|сравнива|осматрива|складыва)", "iu")
}

/// `stems(value)`: основы слов от четырёх букв (первые пять, «ё» как «е»).
fn outcome_stems(value: &str) -> IndexSet<String> {
    text::find_all(re!(r"\p{L}{4,}", "gu"), &folded(value)).iter().map(|word| text::head(word, 5)).collect()
}

/// `confirmedOutcomeDetailSentence(sentence, brief)`: предложение
/// пересказывает деталь исхода, которую сервер положил в бриф
/// (`player_intent.outcome_detail`).
pub fn confirmed_outcome_detail_sentence(sentence: &str, brief: &Value) -> bool {
    let detail = js::s(prop(player_intent(brief), "outcome_detail"));
    if detail.is_empty() {
        return false;
    }
    let said = outcome_stems(sentence);
    if said.is_empty() {
        return false;
    }
    let known = outcome_stems(&detail);
    let shared = said.iter().filter(|stem| known.contains(*stem)).count();
    shared >= 3 || shared as f64 / said.len() as f64 >= 0.6
}

fn confirmed_hero_deed_gesture(sentence: &str, brief: &Value) -> bool {
    let events = events_of(brief);
    let succeeded = events.iter().any(|event| free_action_ruling_outcome(event) == Some("success"));
    if succeeded && text::test(deed_gesture(), sentence) && !text::test(deed_forbidden(), sentence) {
        return true;
    }
    let checked = events.iter().any(|event| event_type(event) == Some("AbilityCheckResolved")) || succeeded;
    let action = js::s(prop(player_intent(brief), "action"));
    if !checked || action.is_empty() {
        return false;
    }
    let lowered = folded(&action);
    let words: Vec<&str> = split_re(re!(r"[^\p{L}]+", "u"), &lowered).into_iter().filter(|word| text::len(word) >= 5).collect();
    let declared: IndexSet<String> = words.iter().map(|word| text::head(word, 5)).collect();
    let declared_roots: IndexSet<String> = words.iter().map(|word| verb_root(word)).collect();
    let agency = HERO_AGENCY_ONLY.as_ref().and_then(|regex| first_match(regex, sentence)).unwrap_or_default();
    let agency_lowered = folded(&agency);
    let spoken = split_re(re!(r"\s+", "u"), &agency_lowered).last().map(|word| word.to_string()).unwrap_or_default();
    if text::test(re!(r"^подход", "u"), &spoken)
        && text::test(re!(r"(?<![\p{L}\p{M}])(?:ид[уеё]т?|ид[её]м|направля\p{L}*|шага\p{L}*|подход\p{L}*|подойд\p{L}*|пробира\p{L}*|возвраща\p{L}*)(?![\p{L}\p{M}])", "iu"), &action)
    {
        return true;
    }
    let stem = text::head(&spoken, 5);
    text::len(&stem) == 5 && (declared.contains(&stem) || declared_roots.contains(&verb_root(&spoken))) && !text::test(re!(r"(?:бер[её]т|клад[её]т|доста[её]т|переда[её]т)", "iu"), &agency)
}

/// Корень глагола без приставки, первые четыре буквы.
fn verb_root(word: &str) -> String {
    let prefix = first_match(re!(r"^(?:пере|разо|раз|рас|под|подо|над|при|про|от|ото|об|обо|вы|за|на|до|по|из|ис|вз|вс|со|во|с|у|в)(?=\p{L}{4,})", "u"), word).unwrap_or_default();
    let skip = text::len(&prefix);
    word.chars().skip(skip).take(4).collect()
}

fn first_name_of(value: V<'_>) -> String {
    let name = st(value, 120);
    split_re(re!(r"\s+", "u"), &name).first().map(|word| word.to_string()).unwrap_or_default()
}

fn normalized_actor_name(value: V<'_>) -> String {
    text::trim(&text::replace_all(re!(r#"[«»"'’.,:;!?()\[\]{}]"#, "gu"), &text::lower(&st(value, 120)), "")).to_string()
}

fn normalized_name_str(value: &str) -> String {
    normalized_actor_name(Some(&string_value(value)))
}

/// `uniqueFirstNameAliases(names, values)`: первое слово имени, если оно
/// однозначно в сцене: `[псевдоним, индекс значения, первое слово]`.
fn unique_first_name_aliases(names: &[V<'_>]) -> Vec<(String, usize, String)> {
    let mut counts: IndexMap<String, usize> = IndexMap::new();
    for name in names {
        let alias = normalized_name_str(&first_name_of(*name));
        if !alias.is_empty() {
            *counts.entry(alias).or_insert(0) += 1;
        }
    }
    names
        .iter()
        .enumerate()
        .filter_map(|(index, name)| {
            let first = first_name_of(*name);
            let alias = normalized_name_str(&first);
            (!alias.is_empty() && counts.get(&alias) == Some(&1) && alias != normalized_actor_name(*name)).then_some((alias, index, first))
        })
        .collect()
}

fn dead_npc_name_is_ambiguous(dead: &Value, present: &[Value]) -> bool {
    let dead_name = normalized_actor_name(prop(Some(dead), "name"));
    if dead_name.is_empty() {
        return true;
    }
    let dead_id = st(prop(Some(dead), "id"), 120);
    present.iter().any(|npc| {
        let id = st(prop(Some(npc), "id"), 120);
        normalized_actor_name(prop(Some(npc), "name")) == dead_name && (dead_id.is_empty() || id.is_empty() || id != dead_id)
    })
}

fn actor_reaction_clauses(value: &str, actor: &str) -> Vec<String> {
    let name = st_str(actor, 120);
    if name.is_empty() {
        return Vec::new();
    }
    let Some(pattern) = dynamic_regex(&format!(r"(?<![\p{{L}}\p{{N}}_]){}(?![\p{{L}}\p{{N}}_])[^.!?]{{0,56}}(?:{})", escape_pattern(&name), *NPC_REACTION_MARKERS), "giu") else {
        return Vec::new();
    };
    text::find_all(&pattern, value)
}

fn reaction_matches_permit(clause: &str, permit: &Value) -> bool {
    let reaction = text::trim(&js::s(prop(Some(permit), "reaction"))).to_string();
    let refusal = text::test(re!(r"не\s+(?:соглаша[а-яё]*|убежд[её]н[а-яё]*|принима[а-яё]*\s+довод)|отверга[а-яё]*", "iu"), clause);
    if reaction == "persuaded" && refusal {
        return false;
    }
    if reaction == "unconvinced" && !refusal && reaction_matcher("persuaded").is_some_and(|matcher| text::test(matcher, clause)) {
        return false;
    }
    if reaction_matcher(&reaction).is_some_and(|matcher| text::test(matcher, clause)) {
        return true;
    }
    shared_roots(clause, &joined(&spread_list(prop(Some(permit), "description")))) >= 2
}

fn npc_access_is_permitted(clause: &str, permit: Option<&Value>) -> bool {
    let speech = st(or(or(or(prop(permit, "text"), prop(permit, "dialogue")), prop(permit, "speech")), prop(permit, "description")), 1_000);
    let condition_pattern = re!(r"(?<![а-яё])без\s+([^.!?,;]+?)(?=\s+(?:доступ|проход)\s|[.!?,;]|$)", "iu");
    let condition = text::capture(condition_pattern, &speech, 1).map(|value| text::lower(text::trim(&value)));
    let stated = text::capture(condition_pattern, clause, 1).map(|value| text::lower(text::trim(&value)));
    let denial = dynamic_regex(&format!(r"^{}\s+не\s+пропус(?:ка(?:ет|ют|л[аио]?)|тил[аио]?)(?![а-яё])", escape_pattern(&js::s(prop(permit, "name")))), "iu");
    regex_test(denial.as_deref(), clause) && text::test(re!(r"(?:доступ|проход)\s+закрыт(?![а-яё])", "iu"), &speech) && condition.as_ref().is_some_and(|value| !value.is_empty()) && condition == stated
}

fn promise_has_resolution_event(brief: &Value, promise: &Value) -> bool {
    let events: Vec<&Value> = events_of(brief).iter().filter(|event| event_type(event) == Some("NpcPromiseResolved")).collect();
    if events.is_empty() {
        return false;
    }
    let promise_id = text::trim(&js::s(prop(Some(promise), "id"))).to_string();
    if promise_id.is_empty() {
        return false;
    }
    events.iter().any(|event| js::s(payload_field(event, "promise_id")) == promise_id)
}

fn promise_anchor_matches(sentence: &str, promise: &Value) -> bool {
    let actor_roots = suggestion_roots(&js::s(prop(Some(promise), "npc")));
    let anchors: Vec<String> = suggestion_roots(&js::s(prop(Some(promise), "text")))
        .into_iter()
        .filter(|root| !actor_roots.contains(root) && !PROMISE_GENERIC_ROOT_PREFIXES.iter().any(|prefix| root.starts_with(prefix)))
        .collect();
    let sentence_roots = suggestion_roots(sentence);
    if !anchors.is_empty() {
        return anchors.iter().any(|root| sentence_roots.contains(root));
    }
    shared_roots(sentence, &joined(&[prop(Some(promise), "npc"), prop(Some(promise), "text")])) >= 2
}

fn promised_object_assertion(sentence: &str) -> bool {
    promised_object_state().find_iter(sentence).filter_map(Result::ok).any(|found| {
        let before = chars_before(sentence, found.start(), 32);
        !text::test(re!(r"(?:не\s+(?:был[аои]?\s+)?|никогда\s+не\s*)$", "iu"), before)
    })
}

struct BoundaryCategory {
    id: &'static str,
    declared: fn() -> &'static Regex,
    forbidden: fn() -> &'static Regex,
}

const CONTENT_BOUNDARY_CATEGORIES: [BoundaryCategory; 4] = [
    BoundaryCategory {
        id: "sexual-violence",
        declared: || re!(r"сексуальн\w*\s+насили|изнасил|sexual\s+violence|rape", "iu"),
        forbidden: || re!(r"сексуальн\w*\s+насили|изнасил|rape", "iu"),
    },
    BoundaryCategory { id: "torture", declared: || re!(r"пыт|истязан|torture", "iu"), forbidden: || re!(r"пыт|истязан|tortur", "iu") },
    BoundaryCategory {
        id: "graphic-gore",
        declared: || re!(r"натуралистич\w*\s+(?:насили|кров)|подробност\w*\s+(?:насили|ран)|расчлен|gore|graphic\s+violence", "iu"),
        forbidden: || re!(r"расчлен|выпущенн\w*\s+киш|оторванн\w*\s+(?:рук|ног|голов)|gore", "iu"),
    },
    BoundaryCategory {
        id: "harm-to-children",
        declared: || re!(r"насили\w*\s+над\s+деть|вред\w*\s+дет|harm\s+to\s+children", "iu"),
        forbidden: || re!(r"(?:убива|пыта|калеч)\w*[^.!?]{0,24}(?:реб[её]н|дет)|(?:реб[её]н|дет)[^.!?]{0,24}(?:убит|замуч|искалеч)", "iu"),
    },
];

fn boundary_match_is_negated(value: &str, index: usize) -> bool {
    text::test(re!(r"(?:без|никак(?:их|ого)?|не\s+показыва\w*|не\s+описыва\w*|избега\w*)\s*$", "iu"), chars_before(value, index, 32))
}

fn content_boundary_violations(narration: &str, boundaries: &str) -> Vec<Value> {
    let mut result = Vec::new();
    for category in CONTENT_BOUNDARY_CATEGORIES.iter().filter(|category| text::test((category.declared)(), boundaries)) {
        let Ok(Some(found)) = (category.forbidden)().find(narration) else { continue };
        if boundary_match_is_negated(narration, found.start()) {
            continue;
        }
        result.push(json!({
            "code": "CONTENT_BOUNDARY_VIOLATION",
            "category": category.id,
            "message": format!("Повествование нарушает явную границу контента: {}", category.id),
            "match": st_str(found.as_str(), 120),
        }));
    }
    result
}

fn arc_recap_is_present(narration: &str, recap: Option<&Value>) -> bool {
    let Some(recap) = recap else { return true };
    recap_said(narration) && shared_roots(narration, &joined(&[prop(Some(recap), "title"), prop(Some(recap), "epilogue")])) >= 2
}

/// `currentNarrationSegment`: после пересказа прошлой арки проверяется только
/// текст после «Теперь:».
fn current_narration_segment(narration: &str, brief: &Value, arc_override: Option<&Option<Value>>, recent: &[Value]) -> String {
    if arc_recap_with(brief, arc_override, &ArcRecapOptions { recent_narrations: recent, ..ArcRecapOptions::default() }).is_none() {
        return narration.to_string();
    }
    text::capture(re!(r"^\s*В\s+прошл(?:ый|ую)\s+раз:\s*[\s\S]*?\bТеперь:\s*([\s\S]*)$", "iu"), narration, 1).unwrap_or_else(|| narration.to_string())
}

fn add_violation(violations: &mut Vec<Value>, code: &str, message: impl Into<String>, matched: &str) {
    if !violations.iter().any(|entry| is_str(prop(Some(entry), "code"), code)) {
        violations.push(json!({ "code": code, "message": message.into(), "match": st_str(matched, 120) }));
    }
}

/// `verifyNarratorCraft(narration, brief, verification, recentNarrations)`:
/// синхронная граница — факты, полномочия героя и NPC, явные стоп-темы,
/// отсутствующие на карте ориентиры и пересказ прошлой арки. Возвращает
/// `{ ...verification, valid, violations }`.
pub fn verify_narrator_craft(narration: &str, brief: &Value, verification: &Value, recent: &[Value]) -> Value {
    verify_craft(narration, brief, None, verification, recent)
}

fn verify_craft(narration: &str, brief: &Value, arc_override: Option<&Option<Value>>, verification: &Value, recent: &[Value]) -> Value {
    let current = current_narration_segment(narration, brief, arc_override, recent);
    let current = current.as_str();
    let story = prop(environment(brief), "story_context");
    let events = events_of(brief);
    let mut violations: Vec<Value> = arr(prop(Some(verification), "violations")).to_vec();
    if MECHANICAL_NUMBER_PATTERN.as_ref().is_some_and(|pattern| text::test(pattern, narration)) {
        add_violation(&mut violations, "VISIBLE_MECHANICAL_NUMBER", "Повествование повторяет механическое число, уже показанное интерфейсом", "");
    }
    let only_check = events.iter().any(|event| event_type(event) == Some("AbilityCheckResolved"))
        && events.iter().all(|event| is_declaration_type(event) || matches!(event_type(event), Some("AbilityCheckResolved" | "DieRolled" | "RollResolved")));
    if only_check && text::test(check_only_outcome(), current) {
        add_violation(&mut violations, "CHECK_OUTCOME_NOT_IN_BRIEF", "Результат проверки подменён неподтверждённым действием или находкой", &first_match(check_only_outcome(), current).unwrap_or_default());
    }
    let item_event = |event: &&Value| text::test(re!(r"Item|Loot|Inventory", "u"), &js::string(prop(Some(event), "event_type")));
    if text::test(item_hiding(), current) && events.iter().any(|event| item_event(&event)) {
        let items: Vec<&Value> = events
            .iter()
            .filter(item_event)
            .flat_map(|event| match payload_field(event, "items") {
                Some(Value::Array(items)) => items.iter().map(Some).collect::<Vec<_>>(),
                _ => vec![payload_field(event, "item")],
            })
            .flatten()
            .filter(|item| js::truthy(Some(item)))
            .collect();
        let mut facts: Vec<V<'_>> = arr(prop(prop(environment(brief), "world_memory"), "facts")).iter().map(Some).collect();
        facts.extend(events.iter().filter(|event| event_type(event) == Some("WorldFactRecorded")).map(|event| payload_field(event, "fact")));
        let has_history = split_re(re!(r"[.!?]", "u"), current).into_iter().filter(|sentence| text::test(item_hiding(), sentence)).all(|sentence| {
            let named: Vec<&Value> = items.iter().copied().filter(|item| shared_roots(&js::s(prop(Some(item), "name")), sentence) >= 2).collect();
            let referenced: Vec<&Value> = if !named.is_empty() {
                named
            } else if items.len() == 1 {
                items.clone()
            } else {
                Vec::new()
            };
            !referenced.is_empty()
                && referenced.iter().all(|item| {
                    facts.iter().any(|fact| {
                        text::test(item_hiding(), &st(or(prop(*fact, "summary"), prop(*fact, "object")), 1_000))
                            && js::truthy(prop(Some(item), "id"))
                            && strict_eq(or(prop(*fact, "subject_id"), prop(*fact, "subject")), prop(Some(item), "id"))
                    })
                })
        });
        if !has_history {
            add_violation(&mut violations, "ITEM_HISTORY_NOT_IN_BRIEF", "Получение вещи не подтверждает, что её кто-то прятал", &first_match(item_hiding(), current).unwrap_or_default());
        }
    }

    let heroes = arr(prop(story, "heroes"));
    let hero_names: Vec<&Value> = heroes.iter().filter_map(|hero| prop(Some(hero), "name")).filter(|name| js::truthy(Some(name))).collect();
    if !hero_names.is_empty() {
        let alternatives: Vec<String> = hero_names.iter().map(|name| escape_pattern(&js::s(Some(name)))).collect();
        let hero_agency = dynamic_regex(&format!(r"(?:{})[^.!?]{{0,48}}(?:{})", alternatives.join("|"), *HERO_AGENCY_SOURCE), "iu");
        if let Some(hero_agency) = hero_agency.as_ref() {
            for sentence in split_re(re!(r"[.!?]", "u"), current) {
                if text::test(hero_agency, sentence)
                    && !confirmed_hero_door_action(sentence, brief, heroes)
                    && !confirmed_hero_damage_action(sentence, brief, story)
                    && !confirmed_hero_deed_gesture(sentence, brief)
                    && !confirmed_outcome_detail_sentence(sentence, brief)
                {
                    add_violation(&mut violations, "HERO_AGENCY_NOT_IN_BRIEF", "Рассказчик приписал герою новое действие, мысль или решение", &first_match(hero_agency, sentence).unwrap_or_default());
                }
            }
        }
    }

    let present_npcs = arr(prop(story, "present_npcs"));
    for dead in arr(prop(story, "known_dead_npcs")) {
        if dead_npc_name_is_ambiguous(dead, present_npcs) {
            continue;
        }
        let assertion = dead_npc_current_action_assertion(current, dead);
        if !assertion.is_empty() {
            add_violation(&mut violations, "DEAD_NPC_CURRENT_ACTION_NOT_IN_BRIEF", "Повествование приписало подтверждённо погибшему NPC текущее действие или реплику", &assertion);
        }
    }

    let permits = arr(prop(Some(brief), "permitted_npc_reactions"));
    let mut permits_by_name: IndexMap<String, &Value> = IndexMap::new();
    for entry in permits {
        let name = normalized_actor_name(prop(Some(entry), "name"));
        if !name.is_empty() {
            permits_by_name.insert(name, entry);
        }
    }
    let permit_names: Vec<V<'_>> = permits.iter().map(|entry| prop(Some(entry), "name")).collect();
    for (alias, index, _) in unique_first_name_aliases(&permit_names) {
        if let Some(entry) = permits.get(index) {
            permits_by_name.entry(alias).or_insert(entry);
        }
    }
    let npc_names: Vec<V<'_>> = present_npcs.iter().map(|npc| prop(Some(npc), "name")).filter(|name| js::truthy(*name)).collect();
    let mut current_actors: IndexSet<String> = IndexSet::new();
    for name in npc_names.iter().chain(permit_names.iter()) {
        if js::truthy(*name) {
            current_actors.insert(js::s(*name));
        }
    }
    for (_, _, first) in unique_first_name_aliases(&npc_names) {
        if !first.is_empty() {
            current_actors.insert(first);
        }
    }
    for generic in ["стража", "стражи", "посетители", "толпа", "люди"] {
        current_actors.insert(generic.to_string());
    }
    for actor in &current_actors {
        let actor_key = normalized_name_str(actor);
        let permit = permits_by_name.get(&actor_key).copied();
        let escaped = escape_pattern(actor);
        if js::truthy(prop(permit, "reaction")) {
            if let (Some(stance), Some(permit)) = (dynamic_regex(&format!(r"(?<![\p{{L}}\p{{N}}_]){escaped}\s+(?:не\s+)?(?:соглаша(?:ется|ются)|убежд[её]н[аыо]?)(?![а-яё])"), "giu"), permit) {
                for found in text::find_all(&stance, current) {
                    if !reaction_matches_permit(&found, permit) {
                        add_violation(&mut violations, "NPC_REACTION_MISMATCH", "Согласие NPC не соответствует разрешённой реакции", &found);
                    }
                }
            }
        }
        if let Some(access) = dynamic_regex(&format!(r"(?<![\p{{L}}\p{{N}}_]){escaped}\s+(?:не\s+)?пропус(?:ка(?:ет|ют|л[аио]?)|тил[аио]?)(?![а-яё])[^.!?,;]{{0,180}}"), "giu") {
            for found in text::find_all(&access, current) {
                if !npc_access_is_permitted(&found, permit) {
                    add_violation(&mut violations, "NPC_REACTION_MISMATCH", "Допуск или отказ NPC не соответствует записанной реплике", &found);
                }
            }
        }
        let clauses = actor_reaction_clauses(current, actor);
        if clauses.is_empty() {
            continue;
        }
        let Some(permit) = permit else {
            add_violation(&mut violations, "NPC_REACTION_NOT_PERMITTED", "Повествование добавило текущую реакцию NPC вне allowlist", &clauses[0]);
            continue;
        };
        if let Some(mismatch) = clauses.iter().find(|clause| !reaction_matches_permit(clause, permit)) {
            add_violation(&mut violations, "NPC_REACTION_MISMATCH", "Текущая реакция NPC не соответствует подтверждённому описанию allowlist", mismatch);
        }
    }

    let mut known_actors: IndexSet<String> = current_actors.iter().map(|actor| normalized_name_str(actor)).collect();
    for name in &hero_names {
        known_actors.insert(normalized_actor_name(Some(name)));
    }
    for name in &hero_names {
        known_actors.insert(normalized_name_str(&first_name_of(Some(name))));
    }
    if let Some(unconfirmed) = dynamic_regex(&format!(r"(?<![\p{{L}}\p{{N}}_])([А-ЯЁ][а-яё'’\-]{{1,50}}(?:\s+[А-ЯЁ][а-яё'’\-]{{1,50}}){{0,2}})\s+(?:{})", *NPC_REACTION_MARKERS), "gu") {
        for found in unconfirmed.captures_iter(current).filter_map(Result::ok) {
            let named = found.get(1).map_or("", |group| group.as_str());
            let words = split_re(re!(r"\s+", "u"), named);
            let known = (0..words.len()).any(|index| known_actors.contains(&normalized_name_str(&words[index..].join(" "))));
            if !known {
                add_violation(&mut violations, "NPC_REACTION_NOT_PERMITTED", "Повествование добавило реакцию неподтверждённого персонажа", found.get(0).map_or("", |whole| whole.as_str()));
                break;
            }
        }
    }

    let open_promises: Vec<&Value> = arr(prop(story, "open_promises")).iter().filter(|promise| !promise_has_resolution_event(brief, promise)).collect();
    let promise_state_assertion = split_re(re!(r"[.!?]|[,;—]\s*(?:но|зато|однако)\s+", "iu"), current)
        .into_iter()
        .find(|sentence| text::test(open_promise_resolution(), sentence) || (promised_object_assertion(sentence) && open_promises.iter().any(|promise| promise_anchor_matches(sentence, promise))));
    if !open_promises.is_empty() && promise_state_assertion.is_some_and(|sentence| !sentence.is_empty()) {
        add_violation(&mut violations, "PROMISE_RESOLUTION_NOT_IN_BRIEF", "Рассказчик объявил обещанное полученным или находящимся на месте без события", "");
    }

    let directives = narrator_content_directives(brief);
    for violation in content_boundary_violations(narration, &js::s(prop(Some(&directives), "boundaries"))) {
        add_violation(&mut violations, &js::s(prop(Some(&violation), "code")), js::s(prop(Some(&violation), "message")), &js::s(prop(Some(&violation), "match")));
    }
    for landmark in arr(prop(scene_of(brief), "landmarks_absent")) {
        let mention = sk_scene_base::scene_requirements::requirement_mention(Some(&string_value(current)), &js::s(prop(Some(landmark), "kind")));
        if !mention.is_empty() {
            add_violation(&mut violations, "ABSENT_LANDMARK_MENTIONED", format!("Повествование описывает то, чего нет на карте: {}", st(prop(Some(landmark), "label"), 60)), &mention);
        }
    }
    let arc_recap = arc_recap_with(brief, arc_override, &ArcRecapOptions { recent_narrations: recent, ..ArcRecapOptions::default() });
    if !arc_recap_is_present(narration, arc_recap.as_ref()) {
        let title = prop(arc_recap.as_ref(), "title");
        let label = if js::truthy(title) { js::s(title) } else { format!("арка {}", js::s(prop(arc_recap.as_ref(), "arc_number"))) };
        add_violation(&mut violations, "ARC_RECAP_OMITTED", "Первое повествование новой арки не содержит recap из эпилога предыдущей арки", &label);
    }

    let mut result = object_or_empty(Some(verification));
    result.insert("valid".into(), Value::Bool(violations.is_empty()));
    result.insert("violations".into(), Value::Array(violations));
    object(result)
}

fn confirmed_hero_door_action(sentence: &str, brief: &Value, heroes: &[Value]) -> bool {
    let events = events_of(brief);
    for hero in heroes {
        let id = prop(Some(hero), "id");
        let name = prop(Some(hero), "name");
        if !js::truthy(id) || !js::truthy(name) {
            continue;
        }
        let escaped = escape_pattern(&js::s(name));
        let moved = events.iter().any(|event| strict_eq(prop(Some(event), "actor_id"), id) && event_type(event) == Some("ActorMoved"));
        let opened = events.iter().any(|event| strict_eq(prop(Some(event), "actor_id"), id) && event_type(event) == Some("DoorStateChanged") && is_str(payload_field(event, "state"), "open"));
        if moved
            && opened
            && regex_test(dynamic_regex(&format!(r"{escaped}[^.!?]{{0,48}}(?:вход(?:ит|ят)|заход(?:ит|ят)|проход(?:ит|ят)|переступа(?:ет|ют)|открыва(?:ет|ют)|распахива(?:ет|ют)|толка(?:ет|ют))"), "iu").as_deref(), sentence)
        {
            return true;
        }
        let Some(pattern) = dynamic_regex(&format!(r"^\s*{escaped}\s+(открывает|закрывает)\s+дверь\s*$"), "iu") else { continue };
        let Some(verb) = text::capture(&pattern, sentence, 1) else { continue };
        let state = if text::lower(&verb) == "открывает" { "open" } else { "closed" };
        return events.iter().any(|event| strict_eq(prop(Some(event), "actor_id"), id) && event_type(event) == Some("DoorStateChanged") && is_str(payload_field(event, "state"), state));
    }
    false
}

fn confirmed_hero_damage_action(sentence: &str, brief: &Value, story: V<'_>) -> bool {
    let heroes = arr(prop(story, "heroes"));
    let participants: Vec<&Value> = heroes.iter().chain(arr(prop(story, "present_npcs")).iter()).collect();
    for event in events_of(brief) {
        if event_type(event) != Some("DamageApplied") {
            continue;
        }
        let applied = payload_field(event, "applied_amount");
        if js::present(applied) && js::number(applied) <= 0.0 {
            continue;
        }
        let hero = heroes.iter().find(|hero| strict_eq(prop(Some(hero), "id"), prop(Some(event), "actor_id")));
        let target_id = index0(prop(Some(event), "target_ids"));
        let target_id = if js::truthy(target_id.as_ref()) { target_id } else { payload_field(event, "target_id").cloned() };
        let target = participants.iter().find(|actor| strict_eq(prop(Some(actor), "id"), target_id.as_ref()));
        let hero_name = hero.and_then(|hero| prop(Some(hero), "name"));
        let target_name = target.and_then(|target| prop(Some(target), "name"));
        if !js::truthy(hero_name) || !js::truthy(target_name) {
            continue;
        }
        let adjective = match payload_field(event, "damage_type").and_then(Value::as_str) {
            Some("slashing") => "рубящим",
            Some("piercing") => "колющим",
            Some("bludgeoning") => "дробящим",
            _ => continue,
        };
        let Some(pattern) = dynamic_regex(
            &format!(
                r"^\s*{}\s+доста[её]т\s+{}[а-яё]{{0,2}}\s+{adjective}\s+ударом(?:\s+[—–-]\s+(тот получает урон(?:, но оста[её]тся жив)?))?\s*$",
                escape_pattern(&js::s(hero_name)),
                escape_pattern(&js::s(target_name))
            ),
            "iu",
        ) else {
            continue;
        };
        let Ok(Some(found)) = pattern.captures(sentence) else { continue };
        let tail = found.get(1).map_or("", |group| group.as_str());
        if !text::test(re!(r"жив", "iu"), tail) || js::number(payload_field(event, "hp_after")) > 0.0 {
            return true;
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Художественные замечания (следующему ходу)
// ---------------------------------------------------------------------------

struct ToneProfile {
    cues: &'static [&'static str],
    opposites: &'static [&'static str],
}

const TONE_ALIGNMENT_PROFILES: [ToneProfile; 6] = [
    ToneProfile {
        cues: &["тёпл", "уют", "дружелюб", "добр", "забот", "нежн", "сочувств", "warm", "cozy", "friendly", "kind", "gentle", "compassion"],
        opposites: &["холодн", "враждеб", "жесток", "безжалост", "ледян", "cold", "hostile", "cruel", "merciless"],
    },
    ToneProfile { cues: &["надежд", "ободр", "героич", "спасен", "hope", "hopeful", "encourag", "heroic"], opposites: &["безнадёж", "безысход", "обреч", "тщет", "hopeless", "despair", "doomed", "futile"] },
    ToneProfile {
        cues: &["мрачн", "печал", "траур", "скорб", "суров", "grim", "somber", "tragic", "bleak", "mourning"],
        opposites: &["беззабот", "празднич", "весел", "радост", "carefree", "festive", "cheerful", "jolly"],
    },
    ToneProfile {
        cues: &["напряж", "опас", "тревог", "угроз", "страх", "насторож", "tense", "danger", "alarm", "threat", "fear", "wary"],
        opposites: &["безопасн", "спокойн", "безмятеж", "расслаб", "safe", "calm", "serene", "relaxed"],
    },
    ToneProfile {
        cues: &["тайн", "загад", "мист", "неизвест", "скрыт", "mystery", "mysterious", "secret", "unknown", "hidden"],
        opposites: &["очевидн", "разгадан", "полностью-ясн", "obvious", "solved", "fully-clear"],
    },
    ToneProfile { cues: &["триумф", "побед", "торжеств", "triumph", "victor"], opposites: &["поражен", "разгром", "унижен", "defeat", "rout", "humiliat"] },
];

const THEME_GENERIC_ROOTS: &[&str] = &[
    "тем", "кампан", "истор", "сюжет", "сцен", "геро", "персонаж", "приключен", "отношен", "эмоц", "чувств", "выбор", "последств", "theme", "campaign", "story", "plot", "scene", "hero",
    "character", "adventur", "emotion", "choice", "consequenc", "межд", "через", "посл", "перед", "вокруг", "против", "котор", "этот", "потом", "когда", "пока", "about", "between",
    "through", "after", "before", "around", "against", "which", "this", "that", "then", "when", "while", "their",
];

struct ThemeProfile {
    cues: &'static [&'static str],
    dismissals: fn() -> [&'static Regex; 2],
}

const THEME_CONCEPT_PROFILES: [ThemeProfile; 7] = [
    ThemeProfile {
        cues: &["памят", "помн", "воспомин", "прошл", "memory", "remember", "recollect", "past$"],
        dismissals: || {
            [
                re!(r"(?:забыть|забуд\w*|отринуть)\s+(?:всё\s+)?(?:прошл\w*|память|воспоминан\w*)", "iu"),
                re!(r"(?:memory|the\s+past)\s+(?:means|matters)\s+nothing|forget\s+(?:all\s+)?(?:memory|the\s+past)", "iu"),
            ]
        },
    },
    ThemeProfile {
        cues: &["долг$", "обязан", "клятв", "служен", "duty", "obligat", "oath", "responsib"],
        dismissals: || {
            [
                re!(r"(?:долг|обязательств\w*)[^.!?]{0,24}(?:ничего\s+не\s+значит|не\s+важ\w*|бессмыслен\w*)|нет\s+никак\w*\s+(?:долга|обязательств)", "iu"),
                re!(r"(?:duty|obligations?)\s+(?:means?|matters?)\s+nothing|no\s+(?:duty|obligations?)", "iu"),
            ]
        },
    },
    ThemeProfile {
        cues: &["довер", "верност", "предан", "союз", "trust", "loyal", "faith"],
        dismissals: || {
            [
                re!(r"никому\s+нельзя\s+доверять|доверие[^.!?]{0,24}(?:ничего\s+не\s+значит|не\s+важ\w*|бессмыслен\w*)", "iu"),
                re!(r"never\s+trust\s+anyone|trust\s+(?:means?|matters?)\s+nothing|trust\s+is\s+meaningless", "iu"),
            ]
        },
    },
    ThemeProfile { cues: &["надежд", "hope"], dismissals: || [re!(r"(?:надежд\w*)\s+(?:нет|не\s+остал\w*|бессмыслен\w*)", "iu"), re!(r"(?:there\s+is\s+)?no\s+hope|hope\s+is\s+meaningless", "iu")] },
    ThemeProfile {
        cues: &["справедлив", "правосуд", "justice"],
        dismissals: || {
            [
                re!(r"(?:справедливост\w*|правосудие)[^.!?]{0,24}(?:ничего\s+не\s+значит|не\s+важ\w*|бессмыслен\w*)", "iu"),
                re!(r"justice\s+(?:means?|matters?)\s+nothing|justice\s+is\s+meaningless", "iu"),
            ]
        },
    },
    ThemeProfile {
        cues: &["свобод", "воля$", "freedom", "liberty"],
        dismissals: || {
            [
                re!(r"свобод\w*[^.!?]{0,24}(?:ничего\s+не\s+значит|не\s+важ\w*|бессмыслен\w*)", "iu"),
                re!(r"(?:freedom|liberty)\s+(?:means?|matters?)\s+nothing|(?:freedom|liberty)\s+is\s+meaningless", "iu"),
            ]
        },
    },
    ThemeProfile {
        cues: &["истин", "правд", "truth"],
        dismissals: || {
            [
                re!(r"(?:истин\w*|правда)[^.!?]{0,24}(?:ничего\s+не\s+значит|не\s+важ\w*|бессмыслен\w*)", "iu"),
                re!(r"truth\s+(?:means?|matters?)\s+nothing|truth\s+is\s+meaningless", "iu"),
            ]
        },
    },
];

fn alignment_cue_is_negated(value: &str, index: usize) -> bool {
    text::test(re!(r"(?:^|[^\p{L}])(?:без|не|никак\w*|избега\w*|without|not|never|no)\s+(?:[\p{L}'’\-]+\s+){0,2}$", "iu"), chars_before(value, index, 56))
}

fn cue_matches_token(token: &str, cue: &str) -> bool {
    match cue.strip_suffix('$') {
        Some(exact) => token == exact,
        None => token.starts_with(cue),
    }
}

/// `alignmentCueEvidence`: `[(cue, match)]` в порядке текста.
fn alignment_cue_evidence(value: &str, cues: &[&'static str], maximum: usize) -> Vec<(&'static str, String)> {
    let normalized = text::lower(&text::nfkc(&st_str(value, maximum)));
    let mut result = Vec::new();
    let mut seen: IndexSet<&str> = IndexSet::new();
    for found in re!(r"[a-zа-яё][a-zа-яё'’\-]*", "giu").find_iter(&normalized).filter_map(Result::ok) {
        let Some(cue) = cues.iter().copied().find(|cue| cue_matches_token(found.as_str(), cue)) else { continue };
        if seen.contains(cue) || alignment_cue_is_negated(&normalized, found.start()) {
            continue;
        }
        seen.insert(cue);
        result.push((cue, found.as_str().to_string()));
    }
    result
}

fn meaningful_theme_roots(value: &str) -> Vec<String> {
    suggestion_roots(&st_str(value, 800))
        .into_iter()
        .filter(|root| text::len(root) >= 4 && !THEME_GENERIC_ROOTS.iter().any(|generic| root == generic || root.starts_with(generic)))
        .take(24)
        .collect()
}

fn theme_root_overlap(theme_roots: &[String], narration: &str) -> String {
    let narration_roots = meaningful_theme_roots(&st_str(narration, 4_000));
    theme_roots.iter().find(|root| narration_roots.contains(root)).cloned().unwrap_or_default()
}

fn static_pattern_evidence(value: &str, patterns: [&'static Regex; 2]) -> String {
    let cleaned = st_str(value, 4_000);
    for pattern in patterns {
        if let Some(found) = first_match(pattern, &cleaned) {
            return st_str(&found, 120);
        }
    }
    String::new()
}

struct Verdict {
    status: &'static str,
    matched: String,
}

impl Verdict {
    fn bare(status: &'static str) -> Self {
        Verdict { status, matched: String::new() }
    }
}

fn tone_alignment_verdict(narration: &str, tone_directive: &str) -> Verdict {
    let tone = st_str(tone_directive, 500);
    if tone.is_empty() {
        return Verdict::bare("not-configured");
    }
    let expected: Vec<&ToneProfile> = TONE_ALIGNMENT_PROFILES.iter().filter(|profile| !alignment_cue_evidence(&tone, profile.cues, 500).is_empty()).collect();
    if expected.is_empty() {
        return Verdict::bare("insufficient-evidence");
    }
    if expected.iter().any(|profile| !alignment_cue_evidence(narration, profile.cues, 4_000).is_empty()) {
        return Verdict::bare("passed");
    }
    let mut opposite = Vec::new();
    let mut seen: IndexSet<&str> = IndexSet::new();
    for profile in &expected {
        for (cue, matched) in alignment_cue_evidence(narration, profile.opposites, 4_000) {
            if seen.contains(cue) {
                continue;
            }
            seen.insert(cue);
            opposite.push(matched);
        }
    }
    if opposite.len() >= 2 {
        Verdict { status: "violation", matched: opposite.into_iter().take(4).collect::<Vec<_>>().join(", ") }
    } else {
        Verdict::bare("insufficient-evidence")
    }
}

fn theme_alignment_verdict(narration: &str, theme_directive: &str) -> Verdict {
    let themes = st_str(theme_directive, 800);
    if themes.is_empty() {
        return Verdict::bare("not-configured");
    }
    let expected: Vec<&ThemeProfile> = THEME_CONCEPT_PROFILES.iter().filter(|profile| !alignment_cue_evidence(&themes, profile.cues, 800).is_empty()).collect();
    let theme_roots = meaningful_theme_roots(&themes);
    if expected.is_empty() && theme_roots.is_empty() {
        return Verdict::bare("insufficient-evidence");
    }
    let dismissals: Vec<String> = expected.iter().map(|profile| static_pattern_evidence(narration, (profile.dismissals)())).filter(|evidence| !evidence.is_empty()).collect();
    if !dismissals.is_empty() {
        return Verdict { status: "violation", matched: dismissals.into_iter().take(2).collect::<Vec<_>>().join(" · ") };
    }
    if expected.iter().any(|profile| !alignment_cue_evidence(narration, profile.cues, 4_000).is_empty()) {
        return Verdict::bare("passed");
    }
    let shared = theme_root_overlap(&theme_roots, narration);
    if shared.is_empty() {
        Verdict::bare("insufficient-evidence")
    } else {
        Verdict { status: "passed", matched: shared }
    }
}

/// `verifyNarratorFeedback(narration, brief, options)`: художественный
/// вердикт, который хранится в памяти и уходит модели следующим ходом.
/// `options` — `{ recentNarrations, sensoryAnchors, contentDirectives }`;
/// без `sensoryAnchors` якоря считаются, как в JS (это заполняет их кэш).
pub fn verify_narrator_feedback(narration: &str, brief: &Value, options: &Value) -> Value {
    let recent = arr(prop(Some(options), "recentNarrations"));
    if prop(Some(options), "sensoryAnchors").is_none() {
        sensory_anchors_for(brief, None);
    }
    let directives_default;
    let directives_source = match prop(Some(options), "contentDirectives") {
        Some(value) => Some(value),
        None => {
            directives_default = narrator_content_directives(brief);
            Some(&directives_default)
        }
    };
    let cleaned = st_str(narration, 4_000);
    let tone = st(prop(directives_source, "tone"), 500);
    let themes = st(prop(directives_source, "themes"), 800);
    let boundaries = st(prop(directives_source, "boundaries"), 1_000);
    let mut violations: Vec<Value> = Vec::new();
    let craft_notes: Vec<Value> = find_narrator_cliches_in(&cleaned)
        .into_iter()
        .map(|cliche| {
            json!({
                "code": "NARRATOR_CLICHE",
                "message": format!("Повествование использует клише из production-каталога: «{}»", cliche.entry.label),
                "match": st_str(&cliche.matched, 120),
            })
        })
        .collect();
    let plan = narrator_response_plan(brief);
    let focus = if plan_flag(&plan, "include_memory") { narrator_memory_focus(brief) } else { None };
    if js::number(prop(Some(&plan), "max_questions")) == 0.0 && text::test(re!(r"\?\s*$", "u"), &cleaned) {
        add_violation(&mut violations, "UNNECESSARY_FOLLOWUP_QUESTION", "После сообщения исхода добавлен вопрос, которого не требовал план ответа", "");
    }
    if !memory_focus_is_recalled(narration, focus.as_ref()) {
        add_violation(&mut violations, "LINKED_MEMORY_OMITTED", "Рассказчик пропустил наиболее тесно связанную видимую деталь прошлого", &js::s(prop(focus.as_ref(), "label")));
    }
    let repetition = closest_recent_narration(narration, recent);
    if repetition.score > NARRATOR_RECENT_3GRAM_OVERLAP_MAX {
        add_violation(
            &mut violations,
            "RECENT_NARRATION_REPETITION",
            format!("Пересечение 3-грамм с недавним текстом превышает {}%", number_text(js::round(NARRATOR_RECENT_3GRAM_OVERLAP_MAX * 100.0))),
            &repetition.shared,
        );
    }
    let tone_alignment = tone_alignment_verdict(&cleaned, &tone);
    if tone_alignment.status == "violation" {
        add_violation(&mut violations, "NARRATOR_TONE_MISMATCH", format!("Абзац использует явные маркеры тона, противоположного настройке кампании «{}»", st_str(&tone, 120)), &tone_alignment.matched);
    }
    let theme_alignment = theme_alignment_verdict(&cleaned, &themes);
    if theme_alignment.status == "violation" {
        add_violation(
            &mut violations,
            "NARRATOR_THEME_UNALIGNED",
            format!("Абзац явно отбрасывает заявленные темы кампании «{}»; в следующем ходе верни их в повествование", st_str(&themes, 160)),
            &theme_alignment.matched,
        );
    }
    for violation in content_boundary_violations(&cleaned, &boundaries) {
        add_violation(&mut violations, &js::s(prop(Some(&violation), "code")), js::s(prop(Some(&violation), "message")), &js::s(prop(Some(&violation), "match")));
    }
    let boundaries_status = if boundaries.is_empty() {
        "not-configured"
    } else if violations.iter().any(|entry| is_str(prop(Some(entry), "code"), "CONTENT_BOUNDARY_VIOLATION")) {
        "violation"
    } else {
        "passed"
    };
    let mut result = Map::new();
    result.insert("valid".into(), Value::Bool(violations.is_empty()));
    result.insert("violations".into(), Value::Array(violations));
    if !craft_notes.is_empty() {
        result.insert("craft_notes".into(), Value::Array(craft_notes));
    }
    result.insert("content_alignment".into(), json!({ "tone": tone_alignment.status, "themes": theme_alignment.status, "boundaries": boundaries_status }));
    object(result)
}

// ---------------------------------------------------------------------------
// Детерминированный рассказ
// ---------------------------------------------------------------------------

fn deterministic_narration_variant(brief: &Value) -> usize {
    let events = events_of(brief);
    let source = events.iter().find(|event| js::truthy(payload_field(event, "ability")) || js::truthy(payload_field(event, "skill")));
    let ability = source.and_then(|event| payload_field(event, "ability"));
    let value = if js::present(ability) { ability } else { source.and_then(|event| payload_field(event, "skill")) };
    let ability = text::lower(&js::s(value));
    match ability.as_str() {
        "str" | "strength" | "wis" | "wisdom" => 0,
        "dex" | "dexterity" | "cha" | "charisma" => 1,
        "con" | "constitution" => 2,
        "int" | "intelligence" => 3,
        _ => 0,
    }
}

fn narration_sentence(value: &str) -> String {
    let trimmed = text::trim(value);
    if trimmed.is_empty() {
        return String::new();
    }
    if text::test(re!(r#"[.!?…][»"')\]]*$"#, "u"), trimmed) {
        trimmed.to_string()
    } else {
        format!("{trimmed}.")
    }
}

fn whole_clause(value: &str, maximum: usize) -> String {
    let trimmed = text::trim(value);
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= maximum {
        return trimmed.to_string();
    }
    let head: Vec<char> = chars[..maximum].to_vec();
    let last = |needle: char| head.iter().rposition(|ch| *ch == needle).map_or(-1, |at| at as i64);
    let cut = last(',').max(last(';')).max(last('.'));
    let clause: String = if cut as f64 > maximum as f64 / 3.0 {
        head[..cut as usize].iter().collect()
    } else {
        let space = last(' ').max(0) as usize;
        head[..space].iter().collect()
    };
    let clause = text::replace_first(re!(r"\s+(?:и|а|но|или|да)$", "iu"), &clause, "");
    let clause = text::replace_first(re!(r"[\s,;:—-]+$", "u"), &clause, "");
    text::trim(&clause).to_string()
}

struct Framing {
    opening: String,
    quest: String,
}

fn deterministic_framing(brief: &Value, variant: usize) -> Framing {
    let scene = scene_of(brief);
    let story = prop(environment(brief), "story_context");
    let anchors = sensory_anchors_for(brief, None);
    let location = st(or(prop(scene, "location"), prop(scene, "title")), 120);
    let mood = whole_clause(&st(prop(scene, "mood"), 400), 90);
    let names: Vec<String> = arr(prop(story, "present_npcs")).iter().map(|npc| st(prop(Some(npc), "name"), 60)).filter(|name| !name.is_empty()).take(2).collect();
    let mut opening = Vec::new();
    if !location.is_empty() {
        let mood_is_sentence = text::test(re!(r"^[А-ЯЁ]", "u"), &mood) || text::test(re!(r"[.!?…]$", "u"), &mood);
        let description = if mood_is_sentence { format!("{} {}", narration_sentence(&location), narration_sentence(&mood)) } else { narration_sentence(&format!("{location}, {mood}")) };
        let variants: [String; 4] = if !mood.is_empty() {
            [
                description.clone(),
                narration_sentence(&location),
                if mood_is_sentence { description.clone() } else { narration_sentence(&format!("{location}; обстановка — {mood}")) },
                narration_sentence(&location),
            ]
        } else {
            std::array::from_fn(|_| narration_sentence(&location))
        };
        opening.push(variants[variant % 4].clone());
    }
    let slot = ["sound", "light", "smell", "touch"][variant % 4];
    let sensory = js::s(prop(Some(&anchors), slot));
    if !sensory.is_empty() {
        let mut chars = sensory.chars();
        let first: String = chars.next().map(|ch| ch.to_uppercase().collect()).unwrap_or_default();
        opening.push(narration_sentence(&format!("{first}{}", chars.as_str())));
    }
    if !names.is_empty() {
        let reversed: Vec<String> = names.iter().rev().cloned().collect();
        opening.push(
            [
                format!("Рядом {}.", names.join(" и ")),
                format!("В сцене присутствуют {}.", reversed.join(", ")),
                format!("Присутствующие: {}.", names.join("; ")),
                format!("Здесь есть {}.", reversed.join(" и ")),
            ][variant % 4]
                .clone(),
        );
    }
    let quest = st(arr(prop(story, "active_quests")).first().and_then(|quest| prop(Some(quest), "title")), 120);
    Framing { opening: opening.join(" "), quest }
}

/// Резолвер имён: `None` — `undefined`.
pub type NameResolver<'a> = &'a dyn Fn(Option<&Value>) -> Option<Value>;

/// `briefNameResolver(brief)`: имена участников из самого брифа.
fn brief_name_resolver(brief: &Value) -> impl Fn(Option<&Value>) -> Option<Value> {
    let environment = environment(brief);
    let story = prop(environment, "story_context");
    let participants = prop(environment, "participants");
    let mut names: IndexMap<String, String> = IndexMap::new();
    for list in [prop(story, "heroes"), prop(story, "present_npcs"), prop(participants, "heroes"), prop(participants, "enemies")] {
        for entry in arr(list) {
            let id = st(prop(Some(entry), "id"), 120);
            let name = st(prop(Some(entry), "name"), 120);
            if !id.is_empty() && !name.is_empty() {
                names.insert(id, name);
            }
        }
    }
    move |id: Option<&Value>| names.get(&st(id, 120)).map(|name| string_value(name.clone())).or_else(|| id.cloned())
}

fn confirmed_outcome(payload: V<'_>, field: &str) -> Option<&'static str> {
    match prop(payload, field) {
        Some(Value::Bool(true)) => return Some("успехом"),
        Some(Value::Bool(false)) => return Some("неудачей"),
        _ => {}
    }
    let total = prop(payload, "total");
    let difficulty = prop(payload, "difficulty");
    if js::present(total) && js::present(difficulty) && js::is_finite_number(total) && js::is_finite_number(difficulty) {
        return Some(if js::number(total) >= js::number(difficulty) { "успехом" } else { "неудачей" });
    }
    None
}

fn reaction_action_label_fallback(action_id: &str) -> &'static str {
    match action_id {
        "opportunity-attack" => "Атака по возможности",
        "readied-attack" => "Подготовленная атака",
        "readied-spell" => "Подготовленное заклинание",
        "cast:shield" => "Щит",
        "uncanny-dodge" => "Невероятное уклонение",
        _ => "",
    }
}

fn has_cyrillic(value: &str) -> bool {
    text::test(re!(r"[А-ЯЁа-яё]", "u"), value)
}

fn public_spell_label(payload: V<'_>) -> String {
    let explicit = st(nullish(prop(payload, "spell_name"), prop(payload, "name")), 120);
    if !explicit.is_empty() && has_cyrillic(&explicit) {
        return format!("«{explicit}»");
    }
    let catalog = sk_combat_content::combat_spells::canonical_combat_spell_for(prop(payload, "spell_id"), None);
    let name = catalog.as_ref().and_then(|spell| prop(Some(spell), "name"));
    if js::truthy(name) {
        format!("«{}»", st(name, 120))
    } else {
        "заклинания".to_string()
    }
}

fn spell_source_label(payload: V<'_>) -> String {
    let label = public_spell_label(payload);
    if label.starts_with('«') {
        format!("заклинания {label}")
    } else {
        label
    }
}

fn reaction_action_label(payload: V<'_>) -> String {
    let mut candidates = vec![prop(payload, "name")];
    if let Some(Value::Array(options)) = prop(payload, "action_options") {
        candidates.extend(options.iter().map(|option| prop(Some(option), "name")));
    }
    let explicit = candidates.into_iter().map(|value| st(value, 120)).find(|value| !value.is_empty() && has_cyrillic(value));
    explicit.unwrap_or_else(|| reaction_action_label_fallback(&js::s(prop(payload, "action_id"))).to_string())
}

fn reaction_action_text(payload: V<'_>) -> String {
    let label = reaction_action_label(payload);
    if label.is_empty() {
        "реакцию".to_string()
    } else {
        format!("реакцию «{label}»")
    }
}

/// `eventSummary` с резолвером, который отдаёт `''` вместо неразрешённого id.
fn engine_summary(event: &Value, resolve: NameResolver<'_>) -> String {
    let wrapped = |id: Option<&Value>| {
        let resolved = resolve(id);
        if strict_eq(resolved.as_ref(), Some(&string_value(js::string(id)))) {
            Some(string_value(""))
        } else {
            resolved
        }
    };
    player_facing_summary(&sk_rules::summary::event_summary(event, &wrapped), prop(Some(event), "event_type"))
}

fn trim_final_punctuation(value: &str) -> String {
    text::replace_first(re!(r"[.!?]+$", "u"), value, "")
}

/// Качественная сводка события без механических чисел.
fn qualitative_event_summary(event: &Value, resolve: NameResolver<'_>) -> String {
    let empty = json!({});
    let payload = nullish(prop(Some(event), "payload"), Some(&empty));
    let p = |key: &str| prop(payload, key);
    let named = |id: V<'_>, fallback: &str| -> String {
        let resolved = if js::truthy(id) { resolve(id) } else { Some(string_value("")) };
        let usable = js::truthy(resolved.as_ref()) && !strict_eq(resolved.as_ref(), Some(&string_value(js::string(id))));
        if usable {
            st(resolved.as_ref(), 120)
        } else {
            st_str(fallback, 120)
        }
    };
    let target_ids = prop(Some(event), "target_ids");
    let first_target = index0(nullish(target_ids, None));
    let actor = named(prop(Some(event), "actor_id"), "Участник");
    let target = named(first_target.as_ref(), "Цель");
    let kind = prop(Some(event), "event_type").and_then(Value::as_str).unwrap_or("\u{0}");
    let subject = |key: &str| {
        let own = p(key);
        if js::truthy(own) {
            own.cloned()
        } else {
            first_target.clone()
        }
    };
    match kind {
        "DieRolled" => "Бросок завершён".into(),
        "AbilityCheckResolved" => {
            let skill = js::s(p("skill")).replace('_', "-");
            let label = skill_label_ru(&skill).or_else(|| ability_label_ru(&js::string(p("ability"))));
            let outcome = confirmed_outcome(payload, "success");
            format!(
                "Проверка{}{}",
                label.map(|label| format!(" «{label}»")).unwrap_or_default(),
                outcome.map_or_else(|| " завершена; её исход пока неизвестен".to_string(), |outcome| format!(" завершилась {outcome}"))
            )
        }
        "SavingThrowResolved" => {
            let field = if js::present(p("saved")) { "saved" } else { "success" };
            let outcome = confirmed_outcome(payload, field);
            format!("{actor}: спасбросок {}", outcome.map_or_else(|| "завершён; его исход пока неизвестен".to_string(), |outcome| format!("завершился {outcome}")))
        }
        "NpcSavingThrowResolved" | "SpellSavingThrowResolved" => {
            let outcome = confirmed_outcome(payload, "saved");
            format!("{target}: спасбросок от {} {}", spell_source_label(payload), outcome.map_or_else(|| "завершён; его исход пока неизвестен".to_string(), |outcome| format!("завершился {outcome}")))
        }
        "SpellCast" => format!("{actor} применяет {}", if js::truthy(p("name")) { format!("«{}»", st(p("name"), 120)) } else { "заклинание".to_string() }),
        "ConcentrationSavingThrowResolved" => {
            if js::is_true(p("saved")) {
                format!("{actor} сохраняет концентрацию")
            } else {
                format!("{actor} теряет концентрацию")
            }
        }
        "AttackResolved" => {
            if js::is_true(p("hit")) {
                format!("{actor} поражает {}", accusative_name(&target))
            } else {
                format!("{actor} не достигает цели атакой")
            }
        }
        "AreaAttackResolved" => format!("{} поражает указанную область", st_str(&or_str(p("item_name"), "Атака"), 64)),
        "DamageApplied" => {
            if p("applied_amount").and_then(Value::as_f64) == Some(0.0) {
                format!("{target} не получает урона")
            } else if js::truthy(p("death_ward_triggered")) {
                format!("Защита от смерти удерживает {target} в бою")
            } else {
                format!("{target} получает урон")
            }
        }
        "HealingApplied" => format!("{target} получает лечение"),
        "TimeAdvanced" => String::new(),
        "HitPointsReducedToZero" => {
            if js::present(p("successes")) || js::present(p("failures")) {
                format!("{target} падает без сознания")
            } else {
                format!("{target} выбывает из боя")
            }
        }
        "ConditionAdded" => {
            if is_str(p("trigger"), "unconscious") {
                String::new()
            } else {
                engine_summary(event, resolve)
            }
        }
        "LootContainerCreated" | "EncounterRewardsDistributed" => String::new(),
        "HitPointMaximumReduced" => format!("Запас сил {target} ограничен"),
        "ActorMoved" => format!("{actor} меняет позицию"),
        "TravelResolved" => format!("Отряд завершает путь из {} в {}", st_str(&or_str(p("from"), "прежнего места"), 72), st_str(&or_str(p("to"), "новое место"), 72)),
        "DowntimeResolved" => "Передышка завершена".into(),
        "MerchantItemAppraised" => format!("Торговец оценивает предмет «{}»", st_str(&or_str(or(p("item_name"), p("item_id")), "предмет"), 64)),
        "MerchantPurchaseCompleted" => format!("Покупка «{}» завершена", st_str(&or_str(or(prop(p("item"), "name"), p("catalog_id")), "предмета"), 64)),
        "MerchantServicePurchased" => format!("Услуга «{}» оплачена", st_str(&or_str(or(p("service_name"), p("service_id")), "торговца"), 64)),
        "MerchantSaleCompleted" => format!("Продажа «{}» завершена", st_str(&or_str(or(prop(p("item"), "name"), p("catalog_id")), "предмета"), 64)),
        "ResourceSpent" => {
            if text::test(re!(r"^spell_slots_\d+$", "u"), &js::string(p("resource"))) {
                format!("{actor} расходует ячейку заклинания")
            } else {
                format!("{actor} расходует {}", st_str(&or_str(p("resource"), "ресурс"), 64))
            }
        }
        "DeathSavingThrowRolled" => {
            let outcome = confirmed_outcome(payload, "success");
            format!("{target}: спасбросок от смерти {}", outcome.map_or_else(|| "завершён; его исход пока неизвестен".to_string(), |outcome| format!("завершился {outcome}")))
        }
        "DeathSaveFailureRecorded" => format!("{target} получает провал спасброска от смерти"),
        "KnockoutRecoveryProgressed" | "StableRecoveryProgressed" => format!("Восстановление {target} продолжается"),
        "StableRecoveryScheduled" => format!("{target} стабилизирован и начинает восстанавливаться"),
        "CombatStarted" => "Бой начинается; порядок действий определён".into(),
        "CampaignArcCompleted" => "Завершённая история уступает место новой арке".into(),
        "CampaignStoryCompleted" => {
            if p("schema_version").and_then(Value::as_f64) == Some(1.0) {
                "История завершена, кампания продолжается".into()
            } else {
                String::new()
            }
        }
        "QuestAccepted" | "QuestResolved" | "QuestInvalidated" | "QuestAssignmentChanged" => st(p("summary"), 1_000),
        "OfficeVacated" => format!("Должность «{}» освободилась", st(p("title"), 180)),
        "OfficeHolderInstalled" => format!("Должность «{}» получила нового держателя", st(p("title"), 180)),
        "OfficeSuccessionSkipped" | "DirectorIntentRecorded" | "DirectorIntentOutcomeRecorded" | "CampaignPacingAdvanced" => String::new(),
        "PartyDecisionOpened" => format!("Отряд обсуждает: {}", st_str(&or_str(prop(p("interaction"), "title"), "следующий шаг"), 180)),
        "PartyVoteCast" => "Участник отряда проголосовал".into(),
        "PartyDecisionAbstained" => "Участник отряда воздержался".into(),
        "PartyDecisionResolved" => "Отряд принял общее решение".into(),
        "PartyDecisionExpired" => "Время обсуждения истекло; решение определено по правилам отряда".into(),
        "PartyDecisionConsumed" => "Подтверждённое решение отряда исполнено".into(),
        "ReactionWindowOpened" => {
            let reactor_id = index0(nullish(target_ids, None));
            let reactor_id = if js::present(reactor_id.as_ref()) { reactor_id } else { p("target_id").cloned() };
            let source_id = nullish(p("source_actor_id"), prop(Some(event), "actor_id"));
            format!("{} получает возможность использовать {} против {}", named(reactor_id.as_ref(), "Герой"), reaction_action_text(payload), named(source_id, "противник"))
        }
        "ReactionWindowClosed" => match p("accepted") {
            Some(Value::Bool(true)) => format!("{actor} подтверждает {}", reaction_action_text(payload)),
            Some(Value::Bool(false)) => format!("{actor} не использует реакцию"),
            _ => format!("{actor} завершает окно реакции"),
        },
        "CombatActionUsed" => {
            if is_str(p("action_type"), "reaction") || js::truthy(p("reaction_window_id")) {
                format!("{actor} использует {}", reaction_action_text(payload))
            } else {
                let label = st(p("name"), 120);
                if !label.is_empty() && has_cyrillic(&label) {
                    format!("{actor} использует «{label}»")
                } else {
                    format!("{actor} использует боевое действие")
                }
            }
        }
        "TurnStarted" => format!("Начинается ход {target}"),
        "NpcRelationshipAdjusted" => format!("Отношение NPC меняется с {} на {}", st_str(&or_str(p("tier_before"), "нейтрального"), 32), st_str(&or_str(p("tier_after"), "новое"), 32)),
        "QuestClockAdvanced" => String::new(),
        "ActionDeclared" => "Герой заявляет действие".into(),
        "DoorStateChanged" => match p("state").and_then(Value::as_str) {
            Some("open") => "Дверь открыта".into(),
            Some("closed") => "Дверь закрыта".into(),
            _ => "Положение двери изменено".into(),
        },
        "DoorLockpicked" => {
            if js::is_true(p("success")) {
                "Замок вскрыт, дверь открыта".into()
            } else {
                "Вскрыть замок не удалось, дверь остаётся запертой".into()
            }
        }
        "DoorForced" => {
            if js::is_true(p("success")) {
                "Дверь выломана".into()
            } else {
                "Выломать дверь не удалось".into()
            }
        }
        "DoorBarricadeCleared" => {
            if is_str(p("restored_state"), "open") {
                "Баррикада снята, проход открыт".into()
            } else {
                "Баррикада снята".into()
            }
        }
        "WorldFactRecorded" => st_str(&or_str(or(prop(p("fact"), "summary"), prop(p("fact"), "object")), "Отряду открыт новый факт"), 600),
        "NpcConversationRecorded" => {
            let conversation = p("conversation");
            format!("{}: «{}»", named(prop(conversation, "npc_id"), "Собеседник"), st_str(&or_str(prop(conversation, "npc_reply"), "Ответ сохранён"), 500))
        }
        "RulingRecorded" => {
            let Some(outcome) = free_action_ruling_outcome(event) else { return "Действие ещё не выполнено".into() };
            let ruling = p("ruling");
            let deed = text::replace_first(re!(r"[.!?…]+$", "u"), &st(prop(ruling, "question"), 160), "");
            let social = ["deception", "persuasion", "intimidation", "performance"].contains(&js::s(prop(prop(ruling, "interpretation"), "skill")).replace('-', "_").as_str());
            let tail = if deed.is_empty() { String::new() } else { format!(": «{deed}»") };
            if outcome == "success" {
                format!("{actor} делает задуманное{tail}")
            } else if social {
                format!("{actor} делает это, но на окружающих это не действует так, как задумано{tail}")
            } else {
                format!("У {actor} не выходит задуманное{tail}")
            }
        }
        "WorldFactRevealed" => "Отряду становится известно кое-что новое".into(),
        "TimeOfDayChanged" | "WeatherChanged" => trim_final_punctuation(&sk_world_time::weather::world_clock_narration(event)),
        "SocialSceneOpened" => format!("{} неподалёку — можно заговорить", named(subject("npc_id").as_ref(), "Собеседник")),
        "NpcPlaced" => {
            let fallback = st(p("npc_name"), 120);
            let fallback = if fallback.is_empty() { "Местный житель".to_string() } else { fallback };
            format!("{} появляется неподалёку", named(subject("npc_id").as_ref(), &fallback))
        }
        "ScenarioPurseGranted" => format!("{} получает от казначея тяжёлый кошель короля, полный золота", named(subject("hero_id").as_ref(), "Герой")),
        "ScenarioInformantResolved" | "ScenarioInformantTurnFailed" => trim_final_punctuation(&st(p("text"), 1_000)),
        "ScenarioArmoryItemChosen" => {
            let item = st(p("item_name"), 120);
            format!("{} получает из королевской оружейной «{}» прямо со стойки оружейника", named(subject("hero_id").as_ref(), "Герой"), if item.is_empty() { "вещь".to_string() } else { item })
        }
        "ScenarioTreatyConcluded" | "ScenarioTreatyRefused" | "ScenarioKnightHeadReturned" | "ScenarioKnightReleased" | "ScenarioKnightReleaseFailed" | "ScenarioKnightPresenceChanged" => {
            trim_final_punctuation(&st(p("text"), 600))
        }
        _ => engine_summary(event, resolve),
    }
}

/// `playerFacingSummary`: служебная сводка движка (имя события, английский
/// журнал) — молчание.
fn player_facing_summary(summary: &str, event_type: V<'_>) -> String {
    let trimmed = text::trim(summary);
    if trimmed.is_empty() || trimmed == js::s(event_type) {
        return String::new();
    }
    if !text::test(re!(r"[А-Яа-яЁё]", "u"), trimmed) {
        return String::new();
    }
    let head = trimmed.split(':').next().unwrap_or("");
    if !text::test(re!(r"[А-Яа-яЁё]", "u"), head) && text::test(re!(r"[A-Za-z]+\s+[A-Za-z]+", "u"), head) {
        return String::new();
    }
    trimmed.to_string()
}

fn without_visible_numbers(value: &str) -> String {
    let value = text::replace_all(re!(r"[+−-]?\d+(?:[.,]\d+)?", "gu"), value, "");
    let value = text::replace_all(re!(r"\b(?:HP|ОЗ|КД|СЛ)\b", "giu"), &value, "");
    let value = text::replace_all(re!(r"\s*(?:→|->)\s*", "gu"), &value, " ");
    let value = text::replace_all(re!(r"\(\s*\)", "gu"), &value, "");
    let value = text::replace_all(re!(r":\s*(?=[,.;]|$)", "gu"), &value, "");
    let value = text::replace_all(re!(r"\s+([,.;:])", "gu"), &value, "${1}");
    let value = text::replace_all(re!(r"\s{2,}", "gu"), &value, " ");
    text::trim(&value).to_string()
}

const ROUTINE_NARRATION_EVENTS: [&str; 5] = ["TurnStarted", "TurnEnded", "DieRolled", "CombatRoundTimeMarked", "ResourceSpent"];
const COMBAT_TURN_EVENTS: [&str; 7] = ["TurnStarted", "TurnEnded", "AttackResolved", "AreaAttackResolved", "HitPointsReducedToZero", "DeathSavingThrowRolled", "CombatRoundTimeMarked"];

fn deterministic_narration_candidate(brief: &Value, resolve: NameResolver<'_>, variant: usize, arc_recap: Option<&Value>) -> String {
    let plan = narrator_response_plan(brief);
    let events = events_of(brief);
    let all_outcome: Vec<&Value> = events.iter().filter(|event| !is_declaration_event(event)).collect();
    let discovery = all_outcome.iter().any(|event| event_type(event) == Some("WorldFactRecorded"));
    let outcome_events: Vec<&Value> = if discovery {
        all_outcome.iter().copied().filter(|event| !matches!(event_type(event), Some("AbilityCheckResolved" | "DieRolled" | "RollResolved"))).collect()
    } else {
        all_outcome.clone()
    };
    let mut sorted: Vec<&Value> = if outcome_events.is_empty() { events.iter().collect() } else { outcome_events.clone() };
    sorted.sort_by_key(|event| if event_type(event) == Some("NpcDied") { 0 } else { 1 });
    let subject_npc = |event: &Value| {
        let own = payload_field(event, "npc_id");
        if js::truthy(own) {
            return js::s(own);
        }
        let first = index0(nullish(prop(Some(event), "target_ids"), None));
        if js::truthy(first.as_ref()) {
            js::s(first.as_ref())
        } else {
            String::new()
        }
    };
    let invited: IndexSet<String> = sorted.iter().filter(|event| event_type(event) == Some("SocialSceneOpened")).map(|event| subject_npc(event)).collect();
    let ordered: Vec<&Value> = sorted.iter().copied().filter(|event| !(event_type(event) == Some("NpcPlaced") && invited.contains(&subject_npc(event)))).collect();
    let essential: Vec<&Value> = ordered.iter().copied().filter(|event| !ROUTINE_NARRATION_EVENTS.contains(&event_type_text(event).as_str())).collect();
    let empty = json!({});
    let intent = nullish(player_intent(brief), Some(&empty));
    let outcome_detail = st(prop(intent, "outcome_detail"), 400);
    let check_only = !discovery
        && !all_outcome.is_empty()
        && all_outcome.iter().all(|event| ["AbilityCheckResolved", "DieRolled", "RollResolved", "RulingRecorded", "WorldTimeAdvanced"].contains(&event_type_text(event).as_str()));
    let summaries: Vec<String> = if !outcome_detail.is_empty() && check_only {
        vec![without_visible_numbers(&outcome_detail)]
    } else {
        let source = if ordered.len() > 4 && !essential.is_empty() { &essential } else { &ordered };
        source.iter().map(|event| without_visible_numbers(&qualitative_event_summary(event, resolve))).filter(|summary| !summary.is_empty()).collect()
    };
    let combat_turn = events.iter().any(|event| COMBAT_TURN_EVENTS.contains(&event_type_text(event).as_str()));
    let framing = plan_flag(&plan, "include_scene_detail").then(|| deterministic_framing(brief, variant));
    let memory = if plan_flag(&plan, "include_memory") { without_visible_numbers(&memory_focus_reminder(narrator_memory_focus(brief).as_ref(), variant)) } else { String::new() };
    let recap_text = without_visible_numbers(&st(prop(arc_recap, "epilogue"), 480));
    let recap = if recap_text.is_empty() { String::new() } else { format!("В прошлый раз: {}. Теперь:", trim_final_punctuation(&recap_text)) };
    let quest = framing.as_ref().map(|framing| framing.quest.clone()).unwrap_or_default();
    let body = if is_str(prop(Some(&plan), "speech_act"), "acknowledge_intent") {
        "Действие ещё не выполнено.".to_string()
    } else if !summaries.is_empty() {
        summaries.iter().take(4).map(|summary| narration_sentence(summary)).collect::<Vec<_>>().join(" ")
    } else if !quest.is_empty() {
        [
            format!("Пока ничего не меняется: «{quest}» ждёт решения отряда."),
            format!("Решение по линии «{quest}» пока остаётся за отрядом."),
            format!("Пока нет новых сведений о задаче «{quest}»."),
            format!("Как поступить с задачей «{quest}», решает отряд."),
        ][variant % 4]
            .clone()
    } else {
        ["Пока ничего не меняется: следующий шаг за отрядом.", "Пока нет ничего нового.", "Здесь всё по-прежнему.", "Здесь всё по-прежнему."][variant % 4].to_string()
    };
    let memory_sentence = narration_sentence(&memory);
    let dialogue_only = !outcome_events.is_empty() && outcome_events.iter().all(|event| event_type(event) == Some("NpcConversationRecorded"));
    let quiet = dialogue_only || discovery || combat_turn || (!outcome_detail.is_empty() && check_only);
    let opening = framing.map(|framing| framing.opening).unwrap_or_default();
    [recap, body, if quiet { String::new() } else { opening }, if quiet { String::new() } else { memory_sentence }].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ")
}

/// `deterministicNarration(brief, resolveName, { recentNarrations })`:
/// серверный текст без модели — `{ narration }`. Без резолвера имена берутся
/// из самого брифа; из четырёх вариантов выбирается наименее похожий на
/// недавние ответы.
pub fn deterministic_narration(brief: &Value, resolve_name: Option<NameResolver<'_>>, recent: &[Value]) -> Result<Value, SecurityValidationError> {
    deterministic_narration_with(brief, None, resolve_name, recent)
}

fn deterministic_narration_with(brief: &Value, arc_override: Option<&Option<Value>>, resolve_name: Option<NameResolver<'_>>, recent: &[Value]) -> Result<Value, SecurityValidationError> {
    assert_narration_brief(Some(brief))?;
    let own_resolver = brief_name_resolver(brief);
    let resolve: NameResolver<'_> = match resolve_name {
        Some(resolve) => resolve,
        None => &own_resolver,
    };
    let base = deterministic_narration_variant(brief);
    let variants: Vec<usize> = std::iter::once(base).chain((0..4).filter(|variant| *variant != base)).collect();
    let arc_recap = arc_recap_with(brief, arc_override, &ArcRecapOptions { recent_narrations: recent, ..ArcRecapOptions::default() });
    let mut narration = deterministic_narration_candidate(brief, resolve, variants[0], arc_recap.as_ref());
    let mut overlap = closest_recent_narration(&narration, recent).score;
    for variant in variants.into_iter().skip(1) {
        let candidate = deterministic_narration_candidate(brief, resolve, variant, arc_recap.as_ref());
        let candidate_overlap = closest_recent_narration(&candidate, recent).score;
        if candidate_overlap >= overlap {
            continue;
        }
        narration = candidate;
        overlap = candidate_overlap;
    }
    Ok(json!({ "narration": narration }))
}

fn complete_sentence_prefix(value: &str) -> String {
    let mut end = 0;
    for found in re!(r#"[.!?…](?:["»')\]]+)?(?=\s|$)"#, "gu").find_iter(value).filter_map(Result::ok) {
        end = found.end();
    }
    if end == 0 {
        String::new()
    } else {
        text::trim(&value[..end]).to_string()
    }
}

/// `narrationRepairNote(violations)`: записка к правке отклонённого черновика.
pub fn narration_repair_note(violations: &[Value]) -> String {
    let mut lines = vec!["Этот вариант сервер отклонил:".to_string()];
    for violation in violations.iter().take(4) {
        let violation = Some(violation);
        let matched = st(nullish(prop(violation, "match"), None), 160);
        let message = or(or(prop(violation, "message"), prop(violation, "code")), None);
        let message = if js::truthy(message) { st(message, 200) } else { st_str("нарушение", 200) };
        lines.push(format!("- {message}{}", if matched.is_empty() { String::new() } else { format!(" (фрагмент: «{matched}»)") }));
    }
    lines.push("Перепиши ответ целиком: исправь только это, остальное держи по тем же данным. Не утверждай того, чего нет в подтверждённых событиях; заявку игрока, которой не случилось, не описывай свершившейся. Только текст ответа, без пояснений.".to_string());
    lines.join("\n")
}

/// Ключи `Object.prototype`: `key in sum` в JS находит их у любого объекта.
const OBJECT_PROTOTYPE_KEYS: [&str; 12] =
    ["constructor", "__proto__", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString", "toString", "valueOf", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"];

fn usage_fields(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map.clone(),
        Value::Array(items) => items.iter().enumerate().map(|(index, item)| (index.to_string(), item.clone())).collect(),
        _ => Map::new(),
    }
}

/// `addedUsage(left, right)`: поля-числа складываются.
fn added_usage(left: Option<Value>, right: Option<Value>) -> Option<Value> {
    let right_usable = right.as_ref().is_some_and(|value| js::truthy(Some(value)) && (value.is_object() || value.is_array()));
    if !right_usable {
        return left;
    }
    let left_usable = left.as_ref().is_some_and(|value| js::truthy(Some(value)) && (value.is_object() || value.is_array()));
    if !left_usable {
        return right;
    }
    let (Some(left), Some(right)) = (left, right) else { return None };
    let mut sum = usage_fields(&left);
    for (key, value) in usage_fields(&right) {
        match (value.as_f64(), sum.get(&key).and_then(Value::as_f64)) {
            (Some(add), Some(base)) if value.is_number() => {
                sum.insert(key, js::num(base + add));
            }
            _ => {
                if !sum.contains_key(&key) && !OBJECT_PROTOTYPE_KEYS.contains(&key.as_str()) {
                    sum.insert(key, value);
                }
            }
        }
    }
    Some(object(sum))
}

// ---------------------------------------------------------------------------
// Срок и поток
// ---------------------------------------------------------------------------

/// Задержка `setTimeout`: вне `[1, 2^31-1]` — 1 мс.
fn node_timer_delay(milliseconds: f64) -> std::time::Duration {
    let milliseconds = if (1.0..=2_147_483_647.0).contains(&milliseconds) { milliseconds.floor() } else { 1.0 };
    std::time::Duration::from_millis(milliseconds as u64)
}

fn deadline_error() -> LlmError {
    LlmError::other_with_code("Error", "Истекло время на необязательное повествование", "NARRATION_DEADLINE")
}

/// Срок необязательного повествования (`deadlineController` + `setTimeout`):
/// таймер — отдельный поток, который отменяет контроллер, если его не
/// сняли раньше (`clearTimeout` — при выходе из области).
struct Deadline {
    controller: AbortController,
    cancel: Arc<(Mutex<bool>, Condvar)>,
}

impl Deadline {
    fn start(timeout_ms: f64) -> Self {
        let controller = AbortController::new();
        let cancel = Arc::new((Mutex::new(false), Condvar::new()));
        let delay = node_timer_delay(timeout_ms);
        let timer_controller = controller.clone();
        let timer_cancel = Arc::clone(&cancel);
        let spawned = std::thread::Builder::new().name("narrator-deadline".into()).spawn(move || {
            let (flag, condvar) = &*timer_cancel;
            let guard = lock(flag);
            let cancelled = match condvar.wait_timeout_while(guard, delay, |cancelled| !*cancelled) {
                Ok((guard, _)) => *guard,
                Err(poisoned) => *poisoned.into_inner().0,
            };
            if !cancelled {
                timer_controller.abort(deadline_error());
            }
        });
        if spawned.is_err() {
            // Без потока таймера срок не наступит: ответ модели ждётся до её собственного таймаута.
            *lock(&cancel.0) = true;
        }
        Deadline { controller, cancel }
    }

    fn signal(&self) -> AbortSignal {
        self.controller.signal()
    }
}

impl Drop for Deadline {
    fn drop(&mut self) {
        *lock(&self.cancel.0) = true;
        self.cancel.1.notify_all();
    }
}

/// `awaitNarrationDeadline(operation, signal)`: итог операции или причина
/// отмены срока — что раньше.
async fn await_deadline<T>(operation: impl Future<Output = Result<T, LlmError>>, signal: Option<&AbortSignal>) -> Result<T, LlmError> {
    let Some(signal) = signal else { return operation.await };
    if let Some(reason) = signal.reason() {
        return Err(reason);
    }
    let mut operation = std::pin::pin!(operation);
    let mut wait = std::pin::pin!(signal.wait());
    std::future::poll_fn(move |context: &mut Context<'_>| {
        if let Poll::Ready(reason) = wait.as_mut().poll(context) {
            return Poll::Ready(Err(reason));
        }
        operation.as_mut().poll(context)
    })
    .await
}

fn security_to_llm(error: SecurityValidationError) -> LlmError {
    LlmError { name: error.name.to_string(), code: error.code, message: error.message, details: error.details, provider_usage: None }
}

/// Получатель обновлений потока: проверенный префикс (полный снимок текста).
pub type ProgressCallback = Arc<dyn Fn(&str) + Send + Sync>;

struct ProgressContext {
    brief: Value,
    arc: Option<Value>,
    verifier: DeterministicNarrationVerifier,
    known_rule_ids: Value,
    recent: Vec<Value>,
    on_progress: Option<ProgressCallback>,
}

#[derive(Default)]
struct ProgressState {
    raw: String,
    emitted: String,
    blocked: bool,
}

fn verifier_options(known_rule_ids: &Value) -> Value {
    json!({ "knownRuleIds": known_rule_ids })
}

fn provisional_narration_is_safe(prefix: &str, context: &ProgressContext) -> Result<bool, SecurityValidationError> {
    let arc = Some(&context.arc);
    let segment = current_narration_segment(prefix, &context.brief, arc, &context.recent);
    let verification = context.verifier.verify(Some(&string_value(segment)), Some(&context.brief), Some(&verifier_options(&context.known_rule_ids)))?;
    let checked = verify_craft(prefix, &context.brief, arc, &verification, &context.recent);
    Ok(arr(prop(Some(&checked), "violations")).iter().all(|violation| is_str(prop(Some(violation), "code"), "ARC_RECAP_OMITTED")))
}

/// `narrationProgressBuffer`: копит поток, обрывает его за пределом
/// [`NARRATOR_STREAM_MAX_BYTES`] и синхронно отдаёт получателю только
/// проверенные законченные предложения.
fn narration_progress_buffer(context: ProgressContext) -> DeltaHandler {
    let state = Mutex::new(ProgressState::default());
    DeltaHandler::sync(move |delta: &str| {
        let mut buffer = lock(&state);
        let next = format!("{}{delta}", buffer.raw);
        if next.len() > NARRATOR_STREAM_MAX_BYTES {
            return Err(LlmError::other_with_code("Error", format!("Narration stream exceeds {NARRATOR_STREAM_MAX_BYTES} bytes"), "NARRATION_STREAM_TOO_LARGE"));
        }
        buffer.raw = next;
        let Some(on_progress) = context.on_progress.as_ref() else { return Ok(()) };
        if buffer.blocked {
            return Ok(());
        }
        let prefix = complete_sentence_prefix(&buffer.raw);
        if prefix.is_empty() || prefix == buffer.emitted {
            return Ok(());
        }
        if !provisional_narration_is_safe(&prefix, &context).map_err(security_to_llm)? {
            buffer.blocked = true;
            return Ok(());
        }
        buffer.emitted = prefix.clone();
        drop(buffer);
        on_progress(&prefix);
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// Рассказчик
// ---------------------------------------------------------------------------

/// Проверка качества следующего хода (`feedbackVerifier(text, brief,
/// options)`); `Err` — код или имя ошибки (`verifier_error`).
pub type FeedbackVerifier = Arc<dyn Fn(&str, &Value, &Value) -> Result<Value, String> + Send + Sync>;

/// [`verify_narrator_feedback`] как [`FeedbackVerifier`] (значение по умолчанию).
pub fn default_feedback_verifier() -> FeedbackVerifier {
    Arc::new(|narration: &str, brief: &Value, options: &Value| Ok(verify_narrator_feedback(narration, brief, options)))
}

/// `new Narrator({ llmClient, verifier, feedbackVerifier, asyncFeedback })`.
#[derive(Clone)]
pub struct NarratorConfig {
    /// Клиент модели; `None` — только детерминированный текст.
    pub llm_client: Option<Arc<dyn LlmClient>>,
    /// Имя класса клиента (`llmClient.constructor?.name`) — поле `provider`
    /// итога; `None` — `llm`.
    pub client_name: Option<String>,
    /// У клиента нет `complete` (узкий тестовый клиент старого контракта):
    /// один вызов `completeJson` без потока и без правки.
    pub json_only_client: bool,
    pub verifier: DeterministicNarrationVerifier,
    /// `None` — `feedbackVerifier` не функция: замечания не копятся.
    pub feedback_verifier: Option<FeedbackVerifier>,
    pub async_feedback: bool,
}

impl Default for NarratorConfig {
    fn default() -> Self {
        NarratorConfig {
            llm_client: None,
            client_name: None,
            json_only_client: false,
            verifier: DeterministicNarrationVerifier::default(),
            feedback_verifier: Some(default_feedback_verifier()),
            async_feedback: true,
        }
    }
}

impl NarratorConfig {
    /// Клиент модели с именем его класса.
    pub fn with_client(llm_client: Arc<dyn LlmClient>, client_name: impl Into<String>) -> Self {
        NarratorConfig { llm_client: Some(llm_client), client_name: Some(client_name.into()), ..NarratorConfig::default() }
    }
}

/// Параметры `render(brief, options)`.
#[derive(Clone, Default)]
pub struct RenderOptions {
    /// `knownRuleIds`; `None` — `[]`.
    pub known_rule_ids: Option<Value>,
    /// `style`; `None` — «Кратко и конкретно».
    pub style: Option<Value>,
    /// `timeoutMs`; `None`/`null` — [`NARRATOR_DEFAULT_TIMEOUT_MS`].
    pub timeout_ms: Option<Value>,
    /// `recentNarrations`; не массив — пусто.
    pub recent_narrations: Value,
    /// `onProgress`.
    pub on_progress: Option<ProgressCallback>,
}

impl RenderOptions {
    /// Параметры из объекта JS (`{ knownRuleIds, style, timeoutMs,
    /// recentNarrations }`); `onProgress` в JSON не помещается.
    pub fn from_json(options: &Value) -> Self {
        let field = |key: &str| prop(Some(options), key).cloned();
        RenderOptions { known_rule_ids: field("knownRuleIds"), style: field("style"), timeout_ms: field("timeoutMs"), recent_narrations: field("recentNarrations").unwrap_or(Value::Null), on_progress: None }
    }
}

/// Исключение `render` в JS: бриф не той формы или с закрытыми полями.
#[derive(Debug, Clone)]
pub enum NarratorError {
    Security(SecurityValidationError),
}

impl std::fmt::Display for NarratorError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NarratorError::Security(error) => write!(formatter, "{}: {}", error.name, error.message),
        }
    }
}

impl std::error::Error for NarratorError {}

impl From<SecurityValidationError> for NarratorError {
    fn from(error: SecurityValidationError) -> Self {
        NarratorError::Security(error)
    }
}

impl From<NarratorError> for LlmError {
    fn from(error: NarratorError) -> Self {
        match error {
            NarratorError::Security(error) => security_to_llm(error),
        }
    }
}

struct FeedbackEntry {
    task: Value,
    consumed: bool,
}

/// `Narrator`.
pub struct Narrator {
    llm_client: Option<Arc<dyn LlmClient>>,
    client_name: String,
    json_only_client: bool,
    verifier: DeterministicNarrationVerifier,
    feedback_verifier: Option<FeedbackVerifier>,
    async_feedback: bool,
    feedback_memory: Mutex<IndexMap<String, FeedbackEntry>>,
    arc_recap_memory: Mutex<IndexSet<String>>,
}

/// Что собрал `render` для итога (`_result`).
struct ResultInput<'a> {
    narration: String,
    brief: &'a Value,
    arc: Option<&'a Option<Value>>,
    recent: &'a [Value],
    sensory_anchors: &'a Value,
    content_directives: &'a Value,
    verification: Value,
    prior_feedback: &'a [Value],
    examples: &'a [Value],
    provider: String,
    started_at: f64,
    token_usage: Option<Value>,
}

impl Narrator {
    pub fn new(config: NarratorConfig) -> Self {
        Narrator {
            llm_client: config.llm_client,
            client_name: config.client_name.unwrap_or_else(|| "llm".to_string()),
            json_only_client: config.json_only_client,
            verifier: config.verifier,
            feedback_verifier: config.feedback_verifier,
            async_feedback: config.async_feedback,
            feedback_memory: Mutex::new(IndexMap::new()),
            arc_recap_memory: Mutex::new(IndexSet::new()),
        }
    }

    fn schedule_feedback(&self, narration: &str, brief: &Value, options: Value) {
        if !self.async_feedback {
            return;
        }
        let Some(verifier) = self.feedback_verifier.as_ref() else { return };
        let narration = st_str(narration, 4_000);
        if narration.is_empty() {
            return;
        }
        let task = match verifier(&narration, brief, &options) {
            Ok(feedback) => {
                let feedback = Some(&feedback);
                let mut result = Map::new();
                result.insert("valid".into(), Value::Bool(js::is_true(prop(feedback, "valid"))));
                result.insert("violations".into(), Value::Array(arr(prop(feedback, "violations")).to_vec()));
                if let Some(Value::Array(notes)) = prop(feedback, "craft_notes") {
                    if !notes.is_empty() {
                        result.insert("craft_notes".into(), Value::Array(notes.clone()));
                    }
                }
                if let Some(alignment) = prop(feedback, "content_alignment").filter(|value| js::truthy(Some(value))) {
                    result.insert("content_alignment".into(), alignment.clone());
                }
                object(result)
            }
            Err(code) => json!({
                "valid": false,
                "violations": [{ "code": "NARRATOR_ASYNC_VERIFIER_ERROR", "message": "Асинхронная проверка качества не завершилась", "match": "" }],
                "verifier_error": text::head(&code, 80),
            }),
        };
        let mut memory = lock(&self.feedback_memory);
        memory.shift_remove(&narration);
        memory.insert(narration, FeedbackEntry { task, consumed: false });
        while memory.len() > NARRATOR_FEEDBACK_MEMORY_LIMIT {
            memory.shift_remove_index(0);
        }
    }

    /// `awaitFeedback(narration)`: замечания к этому тексту или `None`.
    pub fn await_feedback(&self, narration: &str) -> Option<Value> {
        lock(&self.feedback_memory).get(&st_str(narration, 4_000)).map(|entry| entry.task.clone())
    }

    /// `drainFeedback()`: `[{ narration, feedback, consumed }]`.
    pub fn drain_feedback(&self) -> Vec<Value> {
        lock(&self.feedback_memory).iter().map(|(narration, entry)| json!({ "narration": narration, "feedback": entry.task, "consumed": entry.consumed })).collect()
    }

    fn consume_recent_feedback(&self, recent: &[String]) -> Vec<Value> {
        let mut memory = lock(&self.feedback_memory);
        let mut feedback = Vec::new();
        for narration in recent.iter().rev() {
            let Some(entry) = memory.get_mut(narration) else { continue };
            if entry.consumed {
                continue;
            }
            entry.consumed = true;
            feedback.push(entry.task.clone());
        }
        feedback
    }

    fn result(&self, input: ResultInput<'_>) -> Value {
        let arc_recap = arc_recap_with(input.brief, input.arc, &ArcRecapOptions { recent_narrations: input.recent, ..ArcRecapOptions::default() });
        if let Some(recap) = arc_recap.as_ref() {
            let mut memory = lock(&self.arc_recap_memory);
            memory.insert(arc_recap_identity(input.brief, recap));
            while memory.len() > NARRATOR_ARC_RECAP_MEMORY_LIMIT {
                memory.shift_remove_index(0);
            }
        }
        self.schedule_feedback(
            &input.narration,
            input.brief,
            json!({ "recentNarrations": input.recent, "sensoryAnchors": input.sensory_anchors, "contentDirectives": input.content_directives }),
        );
        let verification = Some(&input.verification);
        let provider = input.provider.as_str();
        let reason = if provider == "deterministic" {
            "no_provider"
        } else if js::truthy(prop(verification, "provider_error")) {
            "provider_error"
        } else if provider == "deterministic-fallback" {
            if length_truthy(prop(verification, "repaired_from")) {
                "verification_rejected"
            } else {
                "empty_response"
            }
        } else {
            "generated"
        };
        let mut checked = object_or_empty(verification);
        checked.insert("response_plan".into(), narrator_response_plan(input.brief));
        checked.insert(
            "origin".into(),
            json!({
                "source": if provider.starts_with("deterministic") { "template" } else { "llm" },
                "reason": reason,
                "elapsed_ms": js::num((sk_core::clock::now_ms() as f64 - input.started_at).max(0.0)),
            }),
        );
        checked.insert("feedback_mode".into(), string_value(if self.async_feedback { "async-next-turn" } else { "disabled" }));
        checked.insert("feedback_pending".into(), Value::Bool(self.async_feedback));
        if !input.prior_feedback.is_empty() {
            checked.insert("feedback_applied".into(), Value::Array(input.prior_feedback.to_vec()));
        }
        checked.insert("style_example_ids".into(), Value::Array(input.examples.iter().map(|example| prop(Some(example), "id").cloned().unwrap_or(Value::Null)).collect()));
        if let Some(recap) = arc_recap.as_ref() {
            checked.insert("arc_recap".into(), json!({ "source": "campaign_premise.arc_history", "arc_number": prop(Some(recap), "arc_number").cloned().unwrap_or(Value::Null) }));
        }
        let mut result = Map::new();
        result.insert("narration".into(), string_value(input.narration));
        if let Some(usage) = input.token_usage.filter(|usage| js::truthy(Some(usage)) && (usage.is_object() || usage.is_array())) {
            result.insert("token_usage".into(), usage);
        }
        result.insert("verification".into(), object(checked));
        result.insert("prompt_version".into(), string_value(NARRATOR_PROMPT_VERSION));
        result.insert("few_shot_version".into(), string_value(NARRATOR_FEW_SHOT_VERSION));
        result.insert("provider".into(), string_value(input.provider));
        object(result)
    }

    fn verify_text(&self, narration: &str, brief: &Value, arc: Option<&Option<Value>>, recent: &[Value], known_rule_ids: &Value) -> Result<Value, SecurityValidationError> {
        let segment = current_narration_segment(narration, brief, arc, recent);
        let verification = self.verifier.verify(Some(&string_value(segment)), Some(brief), Some(&verifier_options(known_rule_ids)))?;
        Ok(verify_craft(narration, brief, arc, &verification, recent))
    }

    /// `render(brief, options)`: текст после commit — `{ narration,
    /// token_usage?, verification, prompt_version, few_shot_version, provider }`.
    pub async fn render(&self, brief: &Value, options: RenderOptions) -> Result<Value, NarratorError> {
        let started_at = sk_core::clock::now_ms() as f64;
        assert_narration_brief(Some(brief))?;
        let campaign_style = current_narrator_style_instruction();
        let mut style = options.style.clone().unwrap_or_else(|| string_value("Кратко и конкретно"));
        if !campaign_style.is_empty() {
            style = string_value(format!("{campaign_style}\n{}", js::string(Some(&style))));
        }
        let known_rule_ids = options.known_rule_ids.clone().unwrap_or_else(|| json!([]));
        let recent_texts = bounded_recent_narrations(arr(Some(&options.recent_narrations)));
        let recent: Vec<Value> = recent_texts.iter().cloned().map(Value::String).collect();
        let prior_feedback = self.consume_recent_feedback(&recent_texts);
        let arc_recap = {
            let memory = lock(&self.arc_recap_memory);
            arc_recap_with(brief, None, &ArcRecapOptions { include_opening_arc: true, recent_narrations: &recent, recapped_arc_keys: Some(&*memory) })
        };
        let arc = Some(&arc_recap);
        let base_plan = narrator_response_plan(brief);
        let new_element = if js::is_true(prop(player_intent(brief), "roleplay_speech")) { fresh_scene_element(brief, &recent) } else { String::new() };
        let mut response_plan = base_plan.clone();
        if !new_element.is_empty() {
            response_plan["new_element"] = string_value(new_element);
        }
        let sensory_anchors = if plan_flag(&response_plan, "include_scene_detail") { sensory_anchors_for(brief, Some(&Value::from(recent.len()))) } else { json!({}) };
        let scene_canon = scene_canon_of(brief);
        let content_directives = narrator_content_directives(brief);
        let npc_dossiers = if plan_flag(&response_plan, "include_memory") { sk_social::npc_social::npc_dossiers_for_narrator(brief) } else { Vec::new() };
        let examples = select_narrator_few_shot_examples(brief, None, None);
        let after_validation = is_str(prop(Some(&response_plan), "delivery"), "after_validation");
        let on_progress = options.on_progress.clone();
        let finish = |narration: String, verification: Value, provider: &str, token_usage: Option<Value>| {
            let result = self.result(ResultInput {
                narration,
                brief,
                arc,
                recent: &recent,
                sensory_anchors: &sensory_anchors,
                content_directives: &content_directives,
                verification,
                prior_feedback: &prior_feedback,
                examples: &examples,
                provider: provider.to_string(),
                started_at,
                token_usage,
            });
            if after_validation && js::truthy(prop(prop(Some(&result), "verification"), "valid")) {
                if let Some(on_progress) = on_progress.as_ref() {
                    on_progress(&js::s(prop(Some(&result), "narration")));
                }
            }
            result
        };
        let fallback_text = || -> Result<String, NarratorError> { Ok(js::s(prop(Some(&deterministic_narration_with(brief, arc, None, &recent)?), "narration"))) };

        let Some(client) = self.llm_client.as_ref() else {
            let narration = fallback_text()?;
            let verification = self.verify_text(&narration, brief, arc, &recent, &known_rule_ids)?;
            return Ok(finish(narration, verification, "deterministic", None));
        };

        let requested_timeout = match options.timeout_ms.as_ref() {
            None | Some(Value::Null) => NARRATOR_DEFAULT_TIMEOUT_MS as f64,
            Some(value) => js::number(Some(value)),
        };
        let deadline = (requested_timeout.is_finite() && requested_timeout > 0.0).then(|| Deadline::start(requested_timeout));
        let signal = deadline.as_ref().map(Deadline::signal);
        let hooks = || CallHooks { signal: signal.clone(), ..CallHooks::default() };

        let avoid_cliches = recent_cliche_reminders(&recent);
        let generation = serde_json::to_value(current_narrator_generation_parameters()).unwrap_or_else(|_| json!({}));
        let mut sections = Map::new();
        sections.insert("narration_brief".into(), brief_for_narrator_prompt(brief));
        sections.insert("response_plan".into(), response_plan.clone());
        if let Some(canon) = scene_canon.as_ref() {
            sections.insert("scene_canon".into(), scene_canon_for_prompt(canon));
        }
        let resolver = brief_name_resolver(brief);
        let summaries: Vec<Value> = narratable_events(brief)
            .into_iter()
            .map(|event| {
                let mut entry = Map::new();
                if let Some(kind) = prop(Some(event), "event_type") {
                    entry.insert("event_type".into(), kind.clone());
                }
                entry.insert("text".into(), string_value(without_visible_numbers(&qualitative_event_summary(event, &resolver))));
                object(entry)
            })
            .collect();
        sections.insert("confirmed_event_summaries".into(), Value::Array(summaries));
        sections.insert("style".into(), style.clone());
        sections.insert("content_preferences".into(), content_directives.clone());
        sections.insert("sensory_anchors".into(), sensory_anchors.clone());
        if !npc_dossiers.is_empty() {
            sections.insert("npc_dossiers".into(), Value::Array(npc_dossiers));
        }
        if let Some(recap) = arc_recap.as_ref() {
            sections.insert("previous_arc_recap".into(), recap.clone());
        }
        if !avoid_cliches.is_empty() {
            sections.insert("avoid_repeated_phrases".into(), json!(avoid_cliches));
        }
        if !recent.is_empty() {
            let skip = recent.len().saturating_sub(3);
            sections.insert("recent_narrations".into(), Value::Array(recent.iter().skip(skip).map(|entry| string_value(st(Some(entry), 500))).collect()));
        }
        if weather_recently_mentioned(&recent) {
            sections.insert("skip_weather".into(), Value::Bool(true));
        }
        if !prior_feedback.is_empty() {
            sections.insert("previous_narration_feedback".into(), Value::Array(prior_feedback.clone()));
        }
        if let Some(card) = now_card_for(brief, scene_canon.as_ref()) {
            sections.insert("now".into(), card);
        }
        let model = client.model();
        let mut request = Map::new();
        request.insert(
            "messages".into(),
            json!([
                { "role": "system", "content": prompt_for_model_role(&narrator_prompt_with_examples(&examples), model.as_deref(), "narrator") },
                { "role": "user", "content": build_data_only_context(Some(&object(sections))) },
            ]),
        );
        for (key, value) in object_or_empty(Some(&generation)) {
            request.insert(key, value);
        }
        if deadline.is_some() {
            request.insert("timeoutMs".into(), js::num(requested_timeout));
        }
        request.insert("role".into(), string_value("narrator"));
        let request_value = object(request.clone());
        let no_options = json!({});

        let mut token_usage: Option<Value> = None;
        let call = if !self.json_only_client {
            let handler = narration_progress_buffer(ProgressContext {
                brief: brief.clone(),
                arc: arc_recap.clone(),
                verifier: self.verifier.clone(),
                known_rule_ids: known_rule_ids.clone(),
                recent: recent.clone(),
                on_progress: if after_validation { None } else { on_progress.clone() },
            });
            let hooks = CallHooks { on_delta: Some(handler), ..hooks() };
            await_deadline(client.complete_with(&request_value, &no_options, hooks), signal.as_ref()).await.map(|completion| {
                token_usage = prop(Some(&completion), "usage").filter(|usage| !usage.is_null()).cloned();
                text::trim(&js::s(prop(Some(&completion), "content"))).to_string()
            })
        } else {
            let mut json_request = request.clone();
            json_request.insert("jsonExpected".into(), string_value("object"));
            let json_request = object(json_request);
            await_deadline(client.complete_json_with(&json_request, &no_options, hooks()), signal.as_ref()).await.map(|output| text::trim(&js::s(prop(Some(&output), "narration"))).to_string())
        };
        let narration = match call {
            Ok(narration) => narration,
            Err(error) => {
                let narration = fallback_text()?;
                let mut verification = object_or_empty(Some(&self.verify_text(&narration, brief, arc, &recent, &known_rule_ids)?));
                verification.insert("provider_error".into(), string_value(text::head(&error.code_or_name(), 80)));
                return Ok(finish(narration, object(verification), "deterministic-provider-fallback", None));
            }
        };
        let narration = without_echo_of_player(&narration, brief);
        let safety = self.verify_text(&narration, brief, arc, &recent, &known_rule_ids)?;
        if js::truthy(prop(Some(&safety), "valid")) && !narration.is_empty() {
            return Ok(finish(narration, safety, &self.client_name, token_usage));
        }
        let safety_violations = prop(Some(&safety), "violations").cloned().unwrap_or(Value::Null);
        if !narration.is_empty() && !signal.as_ref().is_some_and(AbortSignal::aborted) && !self.json_only_client {
            let mut repair_request = request.clone();
            let mut messages = arr(request.get("messages")).to_vec();
            messages.push(json!({ "role": "assistant", "content": narration }));
            messages.push(json!({ "role": "user", "content": narration_repair_note(arr(Some(&safety_violations))) }));
            repair_request.insert("messages".into(), Value::Array(messages));
            let repair_request = object(repair_request);
            if let Ok(repair) = await_deadline(client.complete_with(&repair_request, &no_options, hooks()), signal.as_ref()).await {
                token_usage = added_usage(token_usage, prop(Some(&repair), "usage").filter(|usage| !usage.is_null()).cloned());
                let repaired = without_echo_of_player(text::trim(&js::s(prop(Some(&repair), "content"))), brief);
                // Сбой проверки внутри правки в JS глотается вместе с её ошибкой.
                if let Ok(repaired_verification) = self.verify_text(&repaired, brief, arc, &recent, &known_rule_ids) {
                    if !repaired.is_empty() && js::truthy(prop(Some(&repaired_verification), "valid")) {
                        let mut verification = object_or_empty(Some(&repaired_verification));
                        verification.insert("repaired_after".into(), safety_violations.clone());
                        return Ok(finish(repaired, object(verification), &self.client_name, token_usage));
                    }
                }
            }
        }
        let fallback = fallback_text()?;
        let mut verification = object_or_empty(Some(&self.verify_text(&fallback, brief, arc, &recent, &known_rule_ids)?));
        verification.insert("repaired_from".into(), safety_violations);
        let result = finish(fallback, object(verification), "deterministic-fallback", token_usage);
        drop(deadline);
        Ok(result)
    }
}

impl CriticalNarrator for Narrator {
    fn render<'a>(&'a self, brief: &'a Value, options: &'a Value) -> LlmFuture<'a, Result<Value, LlmError>> {
        Box::pin(async move { Narrator::render(self, brief, RenderOptions::from_json(options)).await.map_err(LlmError::from) })
    }
}

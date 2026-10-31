//! Перенос `server/scene-summary.mjs`: текст сводки завершённой сцены для
//! `scene_args.scene_summary` (событие `NarrativeSummaryRecorded` пишет сам
//! обработчик `AdvanceScene`).
//!
//! Сборка **детерминированная, без модели**: сводка — провенанс, источник
//! рекапа «в прошлой серии», и придуманная деталь стала бы ложным
//! воспоминанием кампании. Текст отвечает на три вопроса: где были, что
//! заметного случилось, куда и почему ушли.
//!
//! Параметры функций — объект JS `{ state, events, decision, destinationHint,
//! destination }` как значение JSON: значения по умолчанию подставляются только
//! вместо отсутствующих полей, как при деструктуризации в JS. Объект `null`
//! (и `state: null` при непустой сцене) — `TypeError` исходника, здесь
//! [`JsTypeError`].

use serde_json::{Map, Value};
use sk_core::{js, text};

use crate::combat_narration::encounter_end_text;
use crate::jsv::{coalesce, get, is_str, path, slice_utf16, JsResult, JsTypeError};

const SCENE_SUMMARY_NOTABLE_LIMIT: usize = 5;
const NOTABLE_TEXT_LIMIT: usize = 200;

/// `clean(value, maximum)`: `String(value ?? '')`, NFKC, пробелы схлопнуты,
/// не длиннее `maximum` единиц UTF-16.
fn clean(value: Option<&Value>, maximum: usize) -> String {
    clean_str(&js::s(value), maximum)
}

fn clean_str(value: &str, maximum: usize) -> String {
    slice_utf16(&text::squash_spaces(&text::nfkc(value)), maximum)
}

/// `trimTail(value)`: точка с запятой в конце фразы мешает склеивать перечисление
/// (`replace(/[;,.\s]+$/u, '')`).
fn trim_tail(value: &str) -> String {
    let cleaned = clean_str(value, NOTABLE_TEXT_LIMIT);
    cleaned.trim_end_matches(|ch: char| ch == ';' || ch == ',' || ch == '.' || text::is_js_space(ch)).to_string()
}

/// `a || b` над значениями JSON.
fn or_value<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    if js::truthy(first) {
        first
    } else {
        second
    }
}

fn event_type(event: &Value) -> Option<&str> {
    get(Some(event), "event_type").and_then(Value::as_str)
}

/// `eventsSinceSceneStart(events)`: всё, что произошло после последнего
/// перехода; у первой сцены кампании — весь поток.
pub fn events_since_scene_start(events: &[Value]) -> &[Value] {
    match events.iter().rposition(|event| event_type(event) == Some("SceneAdvanced")) {
        Some(last) => &events[last + 1..],
        None => events,
    }
}

/// `notableSceneMoments(events)`: заметные моменты сцены — закрытый узкий
/// список того, что меняет мир или отношения, не больше пяти.
pub fn notable_scene_moments(events: &[Value]) -> Vec<String> {
    let mut moments: Vec<String> = Vec::new();
    let mut add = |source: String| {
        let value = trim_tail(&source);
        if !value.is_empty() && !moments.contains(&value) {
            moments.push(value);
        }
    };
    let empty = Value::Object(Map::new());
    for event in events {
        let payload = match get(Some(event), "payload") {
            None | Some(Value::Null) => &empty,
            Some(payload) => payload,
        };
        let field = |key: &str| get(Some(payload), key);
        match event_type(event) {
            Some("WorldFactRecorded") => {
                if is_str(path(Some(payload), &["fact", "predicate"]), "scene_change") {
                    add(js::s(or_value(path(Some(payload), &["fact", "summary"]), path(Some(payload), &["fact", "object"]))));
                }
            }
            Some("EncounterOutcomeRecorded") => {
                if js::truthy(field("outcome")) {
                    add(format!("столкновение завершилось: {}", encounter_end_text(field("outcome"))));
                }
            }
            Some("EncounterEnded") => add(format!("бой окончен ({})", encounter_end_text(or_value(field("reason"), field("outcome"))))),
            Some("RulingRecorded") => {
                let ruling = coalesce(field("ruling"), None);
                if !js::truthy(get(ruling, "stakes")) || !js::truthy(get(ruling, "question")) {
                    continue;
                }
                let verdict = if is_str(get(ruling, "outcome"), "success") { "удалось" } else { "не вышло" };
                add(format!("{} — {verdict}", js::s(get(ruling, "question"))));
            }
            Some("NpcPromiseRecorded") => {
                let promise = path(Some(payload), &["promise", "text"]);
                if js::truthy(promise) {
                    add(format!("дано обещание: {}", js::s(promise)));
                }
            }
            // `${summary || outcome}`: без обоих JS печатает «undefined».
            // Без итога и исхода — просто факт (прежде «квест завершён: undefined»).
            Some("QuestResolved") => {
                let result = or_value(field("summary"), field("outcome"));
                add(if js::truthy(result) { format!("квест завершён: {}", js::string(result)) } else { "квест завершён".to_string() })
            }
            Some("MerchantPurchaseCompleted") => {
                let name = or_value(path(Some(payload), &["item", "name"]), field("catalog_id"));
                if js::truthy(name) {
                    let quantity = field("quantity");
                    let suffix = if js::number(quantity) > 1.0 { format!(" ×{}", js::string(quantity)) } else { String::new() };
                    add(format!("куплено: {}{suffix}", js::s(name)));
                }
            }
            _ => {}
        }
    }
    moments.truncate(SCENE_SUMMARY_NOTABLE_LIMIT);
    moments
}

/// Сводка сцены: заголовок и текст.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SceneSummary {
    pub title: String,
    pub summary: String,
}

impl SceneSummary {
    /// Форма JS: `{ title, summary }`.
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("title".into(), Value::String(self.title.clone()));
        object.insert("summary".into(), Value::String(self.summary.clone()));
        Value::Object(object)
    }
}

/// Поля параметров: `None` — объект параметров отсутствует (`= {}`), `null` —
/// `TypeError` деструктуризации.
fn options_of(options: Option<&Value>) -> JsResult<Option<&Value>> {
    match options {
        Some(Value::Null) => Err(JsTypeError("Cannot destructure null")),
        other => Ok(other),
    }
}

/// `Array.isArray(events) ? events : []`.
fn events_field(options: Option<&Value>) -> &[Value] {
    match get(options, "events") {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

fn summary_text(state: Option<&Value>, events: &[Value], options: Option<&Value>) -> JsResult<SceneSummary> {
    let empty = Value::Object(Map::new());
    // Значение по умолчанию `state = {}` — только для отсутствующего поля.
    let state = state.unwrap_or(&empty);
    if state.is_null() {
        return Err(JsTypeError("state.scene of null"));
    }
    let scene = coalesce(get(Some(state), "scene"), None);
    let location = clean(get(scene, "location"), 160);
    let mut title = clean(get(scene, "title"), 160);
    if title.is_empty() {
        title = if location.is_empty() { "Сцена без названия".to_string() } else { location.clone() };
    }
    let moments = notable_scene_moments(events);
    let place = if location.is_empty() {
        format!("Сцена «{title}».")
    } else {
        format!("Отряд был в локации «{location}»{}.", if title != location { format!(" ({title})") } else { String::new() })
    };
    let what = if moments.is_empty() { "Ничего, что изменило бы мир, здесь не произошло.".to_string() } else { format!("Заметное: {}.", moments.join("; ")) };
    let mut target = clean(get(options, "destination"), 160);
    if target.is_empty() {
        target = clean(get(options, "destinationHint"), 160);
    }
    let reason = clean(get(options, "decision"), 300);
    let why = match (target.is_empty(), reason.is_empty()) {
        (false, false) => format!("Отряд ушёл в «{target}»: {reason}."),
        (false, true) => format!("Отряд ушёл в «{target}»."),
        (true, false) => format!("Отряд двинулся дальше: {reason}."),
        (true, true) => "Отряд двинулся дальше.".to_string(),
    };
    Ok(SceneSummary { title, summary: format!("{place} {what} {why}") })
}

/// `buildSceneSummaryText({ state, events, decision, destinationHint, destination })`:
/// все части необязательны — сцена без заметных событий честно описывается как
/// проходная.
pub fn build_scene_summary_text(options: Option<&Value>) -> JsResult<SceneSummary> {
    let options = options_of(options)?;
    summary_text(get(options, "state"), events_field(options), options)
}

/// `sceneSummaryFor({ state, events, decision, destinationHint, destination })`:
/// значение для `scene_args.scene_summary` либо пустая строка, если сцена не дала
/// ни одного события (движок тогда оставляет прежнее поведение).
pub fn scene_summary_for(options: Option<&Value>) -> JsResult<String> {
    let options = options_of(options)?;
    let scene_events = events_since_scene_start(events_field(options));
    if scene_events.is_empty() {
        return Ok(String::new());
    }
    Ok(summary_text(get(options, "state"), scene_events, options)?.summary)
}

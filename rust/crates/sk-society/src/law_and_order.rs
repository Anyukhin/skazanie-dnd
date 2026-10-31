//! Перенос `server/law-and-order.mjs`: закон и розыск — у преступлений на
//! людях есть цена.
//!
//! Модуль детерминированный и без обращений к модели; в JS он «лист» и ничего
//! из `server/` не импортирует. Устроен так:
//!
//! 1. Ступень розыска — чистая функция летописи, а не отдельный счётчик:
//!    реестр преступлений (`state.law.crimes`) выводится редьюсером
//!    ([`apply_law_event`]) из уже подтверждённых событий, а ступень
//!    считается по сумме весов в момент вопроса; сутки без новых преступлений
//!    снимают очко.
//! 2. Юрисдикция — край карты мира, а не клетка.
//! 3. Без свидетелей преступления нет: тайный поступок ступень не двигает.
//! 4. Снятие — только событием `WantedCleared` со списком прощённых записей.

use serde_json::{json, Map, Value};
use sk_core::{js, text as sk_text};

use crate::common::{array, coalesce, digest, get, integer, is_str, js_order, js_string, object_entries, pick, prop, s, spread_any, strict_eq, text_squash};

pub const LAW_SCHEMA_VERSION: i64 = 1;
pub const LAW_POLICY_ID: &str = "skazanie:law-and-order-v1";

/// Что закон считает преступлением и сколько это стоит в очках розыска.
/// Таблица закрытая и серверная. `defiance` — сопротивление аресту: его вес
/// приходит в payload события, а не из таблицы.
pub const WANTED_CRIME_POINTS: [(&str, i64); 9] = [
    ("murder", 4),
    ("cruelty", 4),
    ("treachery", 3),
    ("arson", 3),
    ("theft", 2),
    ("destruction", 2),
    ("violence", 1),
    ("vandalism", 1),
    ("defiance", 0),
];

/// Вес преступления по виду; `None` — вида нет в таблице.
pub fn wanted_crime_points(kind: &str) -> Option<i64> {
    WANTED_CRIME_POINTS.iter().find(|(name, _)| *name == kind).map(|(_, points)| *points)
}

/// Пороги ступеней: ступень — наибольшая, чей порог набран.
pub const WANTED_LEVEL_THRESHOLDS: [i64; 4] = [0, 2, 4, 7];
pub const MAX_WANTED_LEVEL: i64 = WANTED_LEVEL_THRESHOLDS.len() as i64 - 1;

/// Как ступень называется у ведущего. Игроку цифра не показывается вовсе.
pub const WANTED_LEVEL_LABELS: [&str; 4] = ["закон спокоен", "приметили", "ищут", "розыск по краю"];

/// Сутки игрового времени без новых преступлений снимают одно очко.
pub const WANTED_DECAY_MINUTES: i64 = 1_440;

/// Штраф по ступени в медных монетах: 5, 20 и 60 золотых.
pub const WANTED_FINE_CP: [(i64, i64); 3] = [(1, 500), (2, 2_000), (3, 6_000)];

/// Пассивное Восприятие стражи по ступени.
pub const GUARD_PASSIVE_PERCEPTION: [(i64, i64); 3] = [(1, 11), (2, 13), (3, 15)];

/// Сколько кампанийного времени отнимает сдача под стражу: сутки в холодной.
pub const GUARD_CUSTODY_MINUTES: i64 = 1_440;

/// Цена неудачного побега в очках розыска.
pub const WANTED_ESCAPE_FAILURE_POINTS: i64 = 2;

/// Тема боя со стражей (ростер из уже существующих стат-блоков).
pub const GUARD_ENCOUNTER_THEME: &str = "law";

/// Сложность боя со стражей по ступени.
pub const GUARD_ENCOUNTER_DIFFICULTY: [(i64, &str); 3] = [(1, "easy"), (2, "medium"), (3, "hard")];

/// Виды узлов карты мира, где есть кому исполнять закон. Дословно совпадает с
/// `SETTLEMENT_LOCATION_KINDS` из `server/captives.mjs`.
pub const SETTLEMENT_LOCATION_KINDS: [&str; 6] = ["town", "village", "city", "capital", "port", "fortress"];

/// Чем кончается встреча со стражей. Список закрытый и серверный.
pub const GUARD_RESOLUTIONS: [&str; 4] = ["fine", "surrender", "fight", "flee"];

/// Чем давят на побеге: тихо уйти или прорваться.
pub const GUARD_ESCAPE_SKILLS: [&str; 2] = ["stealth", "athletics"];

pub const LAW_COMMAND_TYPES: [&str; 2] = ["ResolveGuardEncounter", "ClearWantedLevel"];

/// Причины, по которым розыск снимается.
pub const WANTED_CLEAR_REASONS: [&str; 3] = ["fine", "surrender", "amnesty"];

/// Со ступени, на которой торговец отказывается иметь дело.
pub const WANTED_TRADE_REFUSAL_LEVEL: i64 = 3;

/// Наценка за розыск в базисных пунктах.
pub const WANTED_PRICE_BPS: [(i64, i64); 4] = [(0, 0), (1, 250), (2, 500), (3, 1_000)];

pub const WANTED_TRADE_REFUSAL_REASON: &str = "Торговец не станет иметь дела с теми, кого ищет стража";

const MAX_CRIMES: usize = 120;
const MAX_CLEARED_REGIONS: usize = 40;

fn table(entries: &[(i64, i64)], key: i64) -> Option<i64> {
    entries.iter().find(|(level, _)| *level == key).map(|(_, value)| *value)
}

fn clamp(value: i64, minimum: i64, maximum: i64) -> i64 {
    minimum.max(maximum.min(value))
}

fn text(value: Option<&Value>, maximum: usize) -> String {
    text_squash(value, maximum)
}

fn text_str(value: &str, maximum: usize) -> String {
    text(Some(&Value::String(value.to_string())), maximum)
}

fn clear_reason(value: Option<&Value>) -> Option<String> {
    let reason = text(value, 30);
    WANTED_CLEAR_REASONS.contains(&reason.as_str()).then_some(reason)
}

// ---------------------------------------------------------------------------
// География: где отряд стоит и какому краю он должен
// ---------------------------------------------------------------------------

/// Где отряд числится на карте мира (`currentWorldNode`): узел
/// `worldMap.currentLocationId`.
pub fn current_world_node(state: &Value) -> Option<&Value> {
    let map = get(Some(state), "worldMap");
    let expected = text(get(map, "currentLocationId"), 180);
    if expected.is_empty() {
        return None;
    }
    array(get(map, "locations")).iter().find(|node| text(get(Some(node), "id"), 180) == expected)
}

fn region_name_for(state: &Value, region_id: Option<&Value>) -> String {
    let expected = text(region_id, 180);
    if expected.is_empty() {
        return String::new();
    }
    let region = array(get(get(Some(state), "worldMap"), "regions")).iter().find(|entry| text(get(Some(entry), "id"), 180) == expected);
    text(get(region, "name"), 180)
}

fn region_name_str(state: &Value, region_id: &str) -> String {
    region_name_for(state, Some(&Value::String(region_id.to_string())))
}

/// Край, которому отряд отвечает прямо сейчас, либо пустая строка (`currentRegionId`).
pub fn current_region_id(state: &Value) -> String {
    text(get(current_world_node(state), "regionId"), 180)
}

/// Стоит ли отряд в поселении, где есть кому исполнять закон (`currentSettlement`).
pub fn current_settlement(state: &Value) -> Option<Value> {
    let node = current_world_node(state)?;
    if !SETTLEMENT_LOCATION_KINDS.contains(&text(get(Some(node), "kind"), 40).as_str()) {
        return None;
    }
    // Крепость без гарнизона — не поселение со стражей.
    if js::is_false(get(Some(node), "garrison")) {
        return None;
    }
    Some(json!({
        "node_id": text(get(Some(node), "id"), 180),
        "name": text(get(Some(node), "name"), 180),
        "kind": text(get(Some(node), "kind"), 40),
        "region_id": text(get(Some(node), "regionId"), 180),
        "region_name": region_name_for(state, get(Some(node), "regionId")),
    }))
}

// ---------------------------------------------------------------------------
// Состояние закона
// ---------------------------------------------------------------------------

fn safe_crime(value: Option<&Value>) -> Option<Value> {
    let id = text(get(value, "id"), 140);
    if !sk_text::test(sk_core::re!(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,139}$", "u"), &id) {
        return None;
    }
    let kind = text(get(value, "kind"), 40);
    let default_points = wanted_crime_points(&kind)?;
    let region_id = text(get(value, "region_id"), 180);
    if region_id.is_empty() {
        return None;
    }
    let cleared_at = match get(value, "cleared_at_minutes") {
        None | Some(Value::Null) => Value::Null,
        some => json!(integer(some, 0).max(0)),
    };
    Some(json!({
        "id": id,
        "kind": kind,
        "points": clamp(integer(get(value, "points"), default_points), 0, 12),
        "region_id": region_id,
        "region_name": text(get(value, "region_name"), 180),
        "node_id": text(get(value, "node_id"), 180),
        "place_name": text(get(value, "place_name"), 180),
        "at_minutes": integer(get(value, "at_minutes"), 0).max(0),
        "witnesses": integer(get(value, "witnesses"), 0).max(0),
        "summary": text(get(value, "summary"), 400),
        "cleared_at_minutes": cleared_at,
        "cleared_reason": clear_reason(get(value, "cleared_reason")),
    }))
}

fn safe_encounter(value: Option<&Value>) -> Option<Value> {
    if !matches!(value, Some(Value::Object(_))) {
        return None;
    }
    let id = text(get(value, "id"), 140);
    let region_id = text(get(value, "region_id"), 180);
    if id.is_empty() || region_id.is_empty() {
        return None;
    }
    Some(json!({
        "id": id,
        "region_id": region_id,
        "region_name": text(get(value, "region_name"), 180),
        "node_id": text(get(value, "node_id"), 180),
        "place_name": text(get(value, "place_name"), 180),
        "level": clamp(integer(get(value, "level"), 1), 1, MAX_WANTED_LEVEL),
        "fine_cp": integer(get(value, "fine_cp"), 0).max(0),
        "officer_name": text(get(value, "officer_name"), 160),
        "officer_rank": text(get(value, "officer_rank"), 120),
        "demand": text(get(value, "demand"), 400),
        "escape_dc": clamp(integer(get(value, "escape_dc"), 11), 5, 30),
        "escape_attempts": integer(get(value, "escape_attempts"), 0).max(0),
        "started_at_minutes": integer(get(value, "started_at_minutes"), 0).max(0),
        "policy_id": LAW_POLICY_ID,
    }))
}

/// Нормализованный реестр закона (`normalizeLawState`). `None` — `undefined`.
pub fn normalize_law_state(input: Option<&Value>) -> Value {
    let source = match input {
        Some(value @ Value::Object(_)) => Some(value),
        _ => None,
    };
    let mut crimes: Vec<Value> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for raw in array(get(source, "crimes")) {
        let Some(crime) = safe_crime(Some(raw)) else {
            continue;
        };
        let id = s(crime.get("id"));
        if seen.contains(&id) {
            continue;
        }
        seen.push(id);
        crimes.push(crime);
    }
    let cleared_source = match get(source, "cleared") {
        Some(value @ Value::Object(_)) => Some(value),
        _ => None,
    };
    let entries = object_entries(cleared_source);
    let skip = entries.len().saturating_sub(MAX_CLEARED_REGIONS);
    let mut cleared = Map::new();
    // Режется хвост, а не голова: при переполнении теряются самые старые амнистии.
    for (region_id, entry) in entries.into_iter().skip(skip) {
        let key = text_str(&region_id, 180);
        if key.is_empty() {
            continue;
        }
        let reason = clear_reason(get(Some(&entry), "reason")).unwrap_or_else(|| "amnesty".into());
        cleared.insert(key, json!({ "at_minutes": integer(get(Some(&entry), "at_minutes"), 0).max(0), "reason": reason }));
    }
    let skip = crimes.len().saturating_sub(MAX_CRIMES);
    json!({
        "schema_version": LAW_SCHEMA_VERSION,
        "crimes": crimes.into_iter().skip(skip).collect::<Vec<_>>(),
        "cleared": Value::Object(js_order(cleared)),
        "encounter": safe_encounter(get(source, "encounter")),
    })
}

// ---------------------------------------------------------------------------
// Ступень розыска
// ---------------------------------------------------------------------------

fn level_for_points(points: i64) -> i64 {
    let mut level = 0;
    for (index, threshold) in WANTED_LEVEL_THRESHOLDS.iter().enumerate().skip(1) {
        if points >= *threshold {
            level = index as i64;
        }
    }
    level
}

/// Ступень по очкам (`wantedLevelForPoints`).
pub fn wanted_level_for_points(points: &Value) -> i64 {
    level_for_points(integer(Some(points), 0).max(0))
}

fn elapsed_minutes(state: &Value) -> i64 {
    integer(get(get(get(Some(state), "mechanics"), "world_time"), "elapsed_minutes"), 0).max(0)
}

fn crime_int(crime: &Value, key: &str) -> i64 {
    crime.get(key).and_then(Value::as_i64).unwrap_or(0)
}

fn wanted_for_region(state: &Value, region: &str) -> Value {
    let law = normalize_law_state(get(Some(state), "law"));
    let minute = elapsed_minutes(state);
    let crimes: Vec<&Value> = array(law.get("crimes"))
        .iter()
        .filter(|crime| is_str(crime.get("region_id"), region) && !js::present(crime.get("cleared_at_minutes")))
        .collect();
    let raw: i64 = crimes.iter().map(|crime| crime_int(crime, "points")).sum();
    let last_crime_at = crimes.iter().fold(0, |latest, crime| latest.max(crime_int(crime, "at_minutes")));
    // Затухание считается от последнего преступления, а не от каждого по отдельности.
    let quiet = if crimes.is_empty() { 0 } else { (minute - last_crime_at).max(0) };
    let decay = if crimes.is_empty() { 0 } else { quiet.div_euclid(WANTED_DECAY_MINUTES) };
    let points = (raw - decay).max(0);
    let level = level_for_points(points);
    let mut region_name = region_name_str(state, region);
    if region_name.is_empty() {
        region_name = crimes.last().map(|crime| s(crime.get("region_name"))).unwrap_or_default();
    }
    json!({
        "region_id": region,
        "region_name": region_name,
        "points": points,
        "raw_points": raw,
        "decayed_points": raw.min(decay),
        "level": level,
        "label": WANTED_LEVEL_LABELS.get(level as usize).copied().unwrap_or(WANTED_LEVEL_LABELS[0]),
        "crime_count": crimes.len(),
        "last_crime_at_minutes": if crimes.is_empty() { Value::Null } else { json!(last_crime_at) },
        "quiet_minutes": quiet,
        // Сколько игрового времени осталось до следующего снятого очка.
        "next_decay_in_minutes": if points > 0 { json!(WANTED_DECAY_MINUTES - quiet % WANTED_DECAY_MINUTES) } else { Value::Null },
        "policy_id": LAW_POLICY_ID,
    })
}

/// Что закон края помнит про отряд прямо сейчас (`wantedFor`). Чистая функция:
/// одинаковое состояние и одинаковая минута дают одинаковую ступень.
pub fn wanted_for(state: &Value, region_id: &Value) -> Value {
    wanted_for_region(state, &text(Some(region_id), 180))
}

fn level_of(wanted: &Value) -> i64 {
    wanted.get("level").and_then(Value::as_i64).unwrap_or(0)
}

/// Ступень розыска в крае, где отряд стоит прямо сейчас (`wantedLevelHere`).
pub fn wanted_level_here(state: &Value) -> i64 {
    let region = current_region_id(state);
    if region.is_empty() {
        0
    } else {
        level_of(&wanted_for_region(state, &region))
    }
}

/// Что известно про розыск в текущем крае — одной записью (`wantedHere`).
pub fn wanted_here(state: &Value) -> Value {
    wanted_for_region(state, &current_region_id(state))
}

/// Какие преступления снимет прощение прямо сейчас (`pendingCrimeIdsFor`).
pub fn pending_crime_ids_for(state: &Value, region_id: &Value) -> Vec<Value> {
    let law = normalize_law_state(get(Some(state), "law"));
    let region = text(Some(region_id), 180);
    array(law.get("crimes"))
        .iter()
        .filter(|crime| is_str(crime.get("region_id"), &region) && !js::present(crime.get("cleared_at_minutes")))
        .map(|crime| crime.get("id").cloned().unwrap_or(Value::Null))
        .collect()
}

/// Лента ведущего: по краю на строку, опасные и свежие сверху (`wantedFeed`).
pub fn wanted_feed(state: &Value) -> Vec<Value> {
    let law = normalize_law_state(get(Some(state), "law"));
    let crimes = array(law.get("crimes"));
    let mut regions: Vec<String> = Vec::new();
    for crime in crimes {
        let region = s(crime.get("region_id"));
        if !regions.contains(&region) {
            regions.push(region);
        }
    }
    let here = current_region_id(state);
    let mut feed: Vec<Value> = regions
        .iter()
        .map(|region| {
            let mut entry = wanted_for_region(state, region);
            let in_region: Vec<&Value> = crimes.iter().filter(|crime| is_str(crime.get("region_id"), region)).collect();
            let skip = in_region.len().saturating_sub(12);
            let recent: Vec<Value> = in_region.into_iter().skip(skip).rev().cloned().collect();
            // Последнее снятие едет в ленте рядом со ступенью.
            let cleared = prop(law.get("cleared"), region).cloned().unwrap_or(Value::Null);
            js::assign(&mut entry, json!({ "here": *region == here, "cleared": cleared, "crimes": recent }));
            entry
        })
        .collect();
    let last = |entry: &Value| entry.get("last_crime_at_minutes").and_then(Value::as_i64).unwrap_or(0);
    feed.sort_by(|left, right| {
        level_of(right)
            .cmp(&level_of(left))
            .then_with(|| last(right).cmp(&last(left)))
            .then_with(|| sk_text::locale_compare(&s(left.get("region_id")), &s(right.get("region_id"))))
    });
    feed
}

// ---------------------------------------------------------------------------
// Преступление из уже подтверждённого поступка
// ---------------------------------------------------------------------------

/// Преступление из последней записи летописи поступков (`crimeFromDeedLedger`).
/// Вызывается редьюсером после редьюсера летописи.
pub fn crime_from_deed_ledger(state: &Value, event: &Value) -> Option<Value> {
    let deed = array(get(get(Some(state), "world_deeds"), "deeds")).last()?;
    if !js::truthy(Some(deed)) {
        return None;
    }
    let event_id = text(get(Some(event), "event_id"), 120);
    // Поступок родился именно от этого события, а не лежал в летописи раньше.
    if event_id.is_empty() || !array(get(Some(deed), "source_event_ids")).iter().any(|id| js_string(id) == event_id) {
        return None;
    }
    // Без свидетелей преступления для закона нет.
    if js::is_true(get(Some(deed), "secret")) {
        return None;
    }
    let points = wanted_crime_points(&text(get(Some(deed), "kind"), 40)).unwrap_or(0);
    if points <= 0 {
        return None;
    }
    let node = current_world_node(state);
    let region_id = text(get(node, "regionId"), 180);
    // Край неизвестен — значит, некому и помнить.
    if region_id.is_empty() {
        return None;
    }
    let mut place_name = text(get(Some(deed), "location_name"), 180);
    if place_name.is_empty() {
        place_name = text(get(node, "name"), 180);
    }
    let id = digest(&[s(get(Some(deed), "id"))]);
    let mut crime = Map::new();
    crime.insert("id".into(), Value::String(format!("crime:{}", &id[..24])));
    if let Some(kind) = get(Some(deed), "kind") {
        crime.insert("kind".into(), kind.clone());
    }
    crime.insert("points".into(), json!(points));
    crime.insert("region_name".into(), Value::String(region_name_str(state, &region_id)));
    crime.insert("region_id".into(), Value::String(region_id));
    crime.insert("node_id".into(), Value::String(text(get(node, "id"), 180)));
    crime.insert("place_name".into(), Value::String(place_name));
    crime.insert("at_minutes".into(), json!(integer(get(Some(deed), "at_minutes"), 0).max(0)));
    crime.insert("witnesses".into(), json!(array(get(Some(deed), "witness_ids")).len()));
    crime.insert("summary".into(), Value::String(text(get(Some(deed), "summary"), 400)));
    safe_crime(Some(&Value::Object(crime)))
}

// ---------------------------------------------------------------------------
// Встреча со стражей
// ---------------------------------------------------------------------------

const OFFICER_RANKS: [&str; 3] = ["десятник стражи", "начальник караула", "сотник городской стражи"];

/// Имена офицеров. В «Бориcлав» буква «c» латинская — так в исходном JS, и
/// перенос держит её байт в байт: от имени зависят сиды и тексты.
const OFFICER_NAMES: [&str; 12] = [
    "Радим", "Твердислав", "Гостята", "Бори\u{63}лав", "Ратмир", "Вышата", "Добрыня", "Мстислав", "Улеб", "Первуша", "Лютобор", "Заслав",
];

/// Кто вышел навстречу (`guardOfficerFor`): имя и чин детерминированы сидом
/// кампании, края и ступени. `options` — `{ regionId, level }`, как в JS.
pub fn guard_officer_for(state: &Value, options: &Value) -> Value {
    let level = get(Some(options), "level");
    let level_text = match level {
        None => "1".to_string(),
        Some(level) => js_string(level),
    };
    let level_number = match level {
        None => 1,
        some => integer(some, 1),
    };
    let seed = digest(&[text(get(Some(state), "sessionCode"), 60), text(get(Some(options), "regionId"), 180), level_text]);
    json!({
        "name": pick(&OFFICER_NAMES, &seed, "name").unwrap_or(OFFICER_NAMES[0]),
        "rank": OFFICER_RANKS.get((clamp(level_number, 1, MAX_WANTED_LEVEL) - 1) as usize).copied().unwrap_or(OFFICER_RANKS[0]),
    })
}

/// Штраф по ступени (`guardFineCpFor`).
pub fn guard_fine_cp_for(level: &Value) -> i64 {
    table(&WANTED_FINE_CP, clamp(integer(Some(level), 1), 1, MAX_WANTED_LEVEL)).unwrap_or(500)
}

/// СЛ побега — пассивное Восприятие стражи по ступени (`guardEscapeDcFor`).
pub fn guard_escape_dc_for(level: &Value) -> i64 {
    table(&GUARD_PASSIVE_PERCEPTION, clamp(integer(Some(level), 1), 1, MAX_WANTED_LEVEL)).unwrap_or(11)
}

/// Что офицер требует вслух (`guardDemandFor`). `options` — `{ placeName, fineCp }`.
pub fn guard_demand_for(level: &Value, options: &Value) -> String {
    let mut place = text(get(Some(options), "placeName"), 180);
    if place.is_empty() {
        place = "этом месте".into();
    }
    let fine = integer(get(Some(options), "fineCp"), 0).max(0) as f64;
    let gold = js::max_of([1.0, js::round(fine / 100.0)]);
    let gold = js::f64_string(gold);
    let level = integer(Some(level), 1);
    if level >= 3 {
        return format!("«Стоять. За вами тянется такое, что в «{place}» вас ищут по всему краю. Виру — {gold} золотых, или пойдёте под замок.»");
    }
    if level == 2 {
        return format!("«Придержите коней. О вас тут спрашивали. Виру — {gold} золотых, и разойдёмся миром.»");
    }
    format!("«Погодите-ка. За вами есть должок перед «{place}». Виру — {gold} золотых, и ступайте.»")
}

/// Стоит ли отряд там, где его остановили (`guardEncounterIsHere`). `None` —
/// встреча из состояния; `Some` — переданная (в том числе `null`).
pub fn guard_encounter_is_here(state: &Value, encounter: Option<&Value>) -> bool {
    let normalized;
    let source = match encounter {
        None => {
            normalized = normalize_law_state(get(Some(state), "law"));
            normalized.get("encounter")
        }
        some => some,
    };
    let Some(safe) = safe_encounter(source) else {
        return false;
    };
    let node_id = s(safe.get("node_id"));
    if node_id.is_empty() {
        return current_region_id(state) == s(safe.get("region_id"));
    }
    text(get(current_world_node(state), "id"), 180) == node_id
}

/// Встреча, которую закон обязан начать прямо сейчас (`guardEncounterTriggerFor`).
/// `options` — `{ commandId }`, как в JS.
pub fn guard_encounter_trigger_for(state: &Value, options: &Value) -> Option<Value> {
    if guard_encounter_is_here(state, None) {
        return None;
    }
    if js::is_true(get(get(get(Some(state), "mechanics"), "combat"), "active")) {
        return None;
    }
    let settlement = current_settlement(state)?;
    let region_id = s(settlement.get("region_id"));
    let wanted = wanted_for_region(state, &region_id);
    let level = level_of(&wanted);
    if level <= 0 {
        return None;
    }
    let officer = guard_officer_for(state, &json!({ "regionId": region_id, "level": level }));
    let fine_cp = guard_fine_cp_for(&json!(level));
    let hash = digest(&[text(get(Some(options), "commandId"), 120), region_id.clone(), level.to_string()]);
    let place = s(settlement.get("name"));
    safe_encounter(Some(&json!({
        "id": format!("guard-encounter:{}", &hash[..24]),
        "region_id": region_id,
        "region_name": settlement.get("region_name"),
        "node_id": settlement.get("node_id"),
        "place_name": place,
        "level": level,
        "fine_cp": fine_cp,
        "officer_name": officer.get("name"),
        "officer_rank": officer.get("rank"),
        "demand": guard_demand_for(&json!(level), &json!({ "placeName": place, "fineCp": fine_cp })),
        "escape_dc": guard_escape_dc_for(&json!(level)),
        "escape_attempts": 0,
        "started_at_minutes": elapsed_minutes(state),
    })))
}

/// Открытая встреча со стражей либо `null` (`guardEncounterFor`).
pub fn guard_encounter_for(state: &Value) -> Value {
    normalize_law_state(get(Some(state), "law")).get("encounter").cloned().unwrap_or(Value::Null)
}

/// Карточка исходов, которую видит стол (`guardOptionsFor`).
pub fn guard_options_for(encounter: Option<&Value>) -> Vec<Value> {
    let Some(safe) = safe_encounter(encounter) else {
        return Vec::new();
    };
    let fine_cp = safe.get("fine_cp").and_then(Value::as_i64).unwrap_or(0);
    let escape_dc = safe.get("escape_dc").and_then(Value::as_i64).unwrap_or(11);
    let gold = js::f64_string(js::max_of([1.0, js::round(fine_cp as f64 / 100.0)]));
    vec![
        json!({
            "id": "fine",
            "label": format!("Заплатить виру · {gold} зм"),
            "summary": "Стража берёт виру и расходится. Розыск в этом краю снимается.",
            "fine_cp": fine_cp,
        }),
        json!({
            "id": "surrender",
            "label": "Сдаться",
            "summary": "Кошель отбирают, отряд проводит сутки под замком. Розыск снимается вместе с ними.",
        }),
        json!({
            "id": "flee",
            "label": "Бежать",
            "summary": format!("Проверка группы против пассивного Восприятия стражи (СЛ {escape_dc}). Ушли — розыск остаётся; не ушли — станет хуже."),
            "difficulty": escape_dc,
        }),
        json!({
            "id": "fight",
            "label": "Драться",
            "summary": "Стража принимает бой. Розыск поднимется до предела, и это уже не забудут.",
        }),
    ]
}

/// Успех группового побега: считается половина отряда (`escapeSucceeded`).
pub fn escape_succeeded(results: &Value) -> bool {
    let rolls = array(Some(results));
    if rolls.is_empty() {
        return false;
    }
    let successes = rolls.iter().filter(|entry| js::is_true(get(Some(entry), "success"))).count();
    successes * 2 >= rolls.len()
}

// ---------------------------------------------------------------------------
// Мир, который косится
// ---------------------------------------------------------------------------

const WANTED_SIGNS: [&[&str]; 4] = [
    &[],
    &["Разговоры у колодца смолкают, когда отряд проходит мимо."],
    &["Стражник у ворот провожает отряд взглядом дольше, чем нужно.", "На доске у управы висит свежий лист с описанием чужаков."],
    &[
        "На каждом столбе — «разыскиваются», и приметы читаются знакомо.",
        "Двое стражников идут следом уже вторую улицу и не скрывают этого.",
        "Хозяин лавки прячет глаза и торопится закрыть ставни.",
    ],
];

/// Что отряд видит вокруг себя вместо цифры розыска (`wantedSignsFor`).
pub fn wanted_signs_for(state: &Value) -> Vec<&'static str> {
    let level = wanted_level_here(state);
    WANTED_SIGNS.get(clamp(level, 0, MAX_WANTED_LEVEL) as usize).map(|signs| signs.to_vec()).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Торговля под розыском
// ---------------------------------------------------------------------------

/// Наценка за розыск в базисных пунктах для текущего края (`wantedPriceBps`).
pub fn wanted_price_bps(state: &Value) -> i64 {
    table(&WANTED_PRICE_BPS, clamp(wanted_level_here(state), 0, MAX_WANTED_LEVEL)).unwrap_or(0)
}

/// Станет ли торговец вообще иметь дело с отрядом (`wantedTradeAvailable`).
pub fn wanted_trade_available(state: &Value) -> bool {
    wanted_level_here(state) < WANTED_TRADE_REFUSAL_LEVEL
}

// ---------------------------------------------------------------------------
// Проекция
// ---------------------------------------------------------------------------

/// Публичная карточка встречи: то, что игрок видит своими глазами у ворот
/// (`publicGuardEncounterFor`). Одна функция на проекцию состояния и событий.
pub fn public_guard_encounter_for(encounter: Option<&Value>) -> Option<Value> {
    let safe = safe_encounter(encounter)?;
    Some(json!({
        "id": safe["id"],
        "place_name": safe["place_name"],
        "officer_name": safe["officer_name"],
        "officer_rank": safe["officer_rank"],
        "demand": safe["demand"],
        "fine_cp": safe["fine_cp"],
        "escape_dc": safe["escape_dc"],
        "escape_attempts": safe["escape_attempts"],
        "options": guard_options_for(Some(&safe)),
    }))
}

/// Что игрок имеет право знать о законе (`lawForViewer`): ведущему — лента по
/// краям, игроку — приметы мира и карточка встречи.
pub fn law_for_viewer(state: &Value, viewer: &Value) -> Value {
    let law = normalize_law_state(get(Some(state), "law"));
    if js::is_true(get(Some(viewer), "isAdmin")) {
        return json!({ "schema_version": LAW_SCHEMA_VERSION, "encounter": law["encounter"], "regions": wanted_feed(state) });
    }
    json!({
        "schema_version": LAW_SCHEMA_VERSION,
        "signs": wanted_signs_for(state),
        "encounter": public_guard_encounter_for(law.get("encounter")),
    })
}

// ---------------------------------------------------------------------------
// Редьюсер
// ---------------------------------------------------------------------------

/// `value + 1` по правилам JS: строка склеивается, `null` — ноль, `undefined` — `NaN`.
fn plus_one(value: Option<&Value>) -> Value {
    match value {
        None => Value::Null,
        Some(Value::Null) => json!(1),
        Some(Value::Bool(flag)) => json!(i64::from(*flag) + 1),
        Some(Value::Number(number)) => js::num(number.as_f64().unwrap_or(f64::NAN) + 1.0),
        Some(other) => Value::String(format!("{}1", js_string(other))),
    }
}

fn with_field(base: &Value, key: &str, value: Value) -> Value {
    let mut map = spread_any(Some(base));
    map.insert(key.into(), value);
    Value::Object(map)
}

fn add_crime(normalized: Value, crime: Option<Value>) -> Value {
    let Some(crime) = crime else {
        return normalized;
    };
    let crimes = array(normalized.get("crimes"));
    if crimes.iter().any(|entry| strict_eq(get(Some(entry), "id"), crime.get("id"))) {
        return normalized;
    }
    let mut next = crimes.to_vec();
    next.push(crime);
    normalize_law_state(Some(&with_field(&normalized, "crimes", Value::Array(next))))
}

/// Что событие меняет в реестре закона (`applyLawEvent`). Реестр выводится
/// из журнала целиком, поэтому replay воспроизводит розыск по построению.
/// `input` — прежний `state.law` (`None` — поля нет), `state` — состояние с
/// уже применённой летописью поступков.
pub fn apply_law_event(input: Option<&Value>, event: &Value, state: &Value) -> Value {
    let kind = s(get(Some(event), "event_type"));
    // Нормализуется всегда: сохранение с верной версией и массивом `crimes`
    // всё равно может нести мусор (`escape_attempts: "2"`). Нормализация
    // идемпотентна и чистое состояние не меняет.
    let normalized = normalize_law_state(input);
    let payload = coalesce(get(Some(event), "payload"), None);
    match kind.as_str() {
        "GuardEncounterStarted" => match safe_encounter(get(payload, "encounter")) {
            Some(encounter) => with_field(&normalized, "encounter", encounter),
            None => normalized,
        },
        "GuardEncounterResolved" => {
            let escaped = text(get(payload, "resolution"), 30) == "flee" && !js::is_true(get(payload, "success"));
            // Провал побега встречу не закрывает: стража на месте.
            if escaped {
                let encounter = normalized.get("encounter");
                if js::truthy(encounter) {
                    let attempts = plus_one(get(encounter, "escape_attempts"));
                    let next = with_field(encounter.unwrap_or(&Value::Null), "escape_attempts", attempts);
                    return with_field(&normalized, "encounter", next);
                }
                return normalized;
            }
            with_field(&normalized, "encounter", Value::Null)
        }
        "WantedLevelRaised" => {
            let crime = safe_crime(get(payload, "crime"));
            add_crime(normalized, crime)
        }
        "WantedCleared" => {
            let region_id = text(get(payload, "region_id"), 180);
            if region_id.is_empty() {
                return normalized;
            }
            let forgiven: Vec<String> = array(get(payload, "crime_ids")).iter().map(|entry| text(Some(entry), 140)).collect();
            let minute = integer(get(payload, "at_minutes"), 0).max(0);
            let reason = clear_reason(get(payload, "reason")).unwrap_or_else(|| "amnesty".into());
            // Снятый розыск распускает и стражу этого края.
            let current = normalized.get("encounter");
            let encounter = if js::truthy(current) && strict_eq(get(current, "region_id"), Some(&Value::String(region_id.clone()))) {
                Some(Value::Null)
            } else {
                current.cloned()
            };
            let crimes: Vec<Value> = array(normalized.get("crimes"))
                .iter()
                .map(|crime| {
                    let id = get(Some(crime), "id");
                    let is_forgiven = id.is_some_and(|id| forgiven.iter().any(|entry| strict_eq(Some(id), Some(&Value::String(entry.clone())))));
                    if is_forgiven && !js::present(get(Some(crime), "cleared_at_minutes")) {
                        let mut next = spread_any(Some(crime));
                        next.insert("cleared_at_minutes".into(), json!(minute));
                        next.insert("cleared_reason".into(), json!(reason));
                        Value::Object(next)
                    } else {
                        crime.clone()
                    }
                })
                .collect();
            let mut cleared = spread_any(normalized.get("cleared"));
            cleared.insert(region_id, json!({ "at_minutes": minute, "reason": reason }));
            let mut next = spread_any(Some(&normalized));
            match encounter {
                Some(encounter) => {
                    next.insert("encounter".into(), encounter);
                }
                None => {
                    next.shift_remove("encounter");
                }
            }
            next.insert("crimes".into(), Value::Array(crimes));
            next.insert("cleared".into(), Value::Object(cleared));
            normalize_law_state(Some(&Value::Object(next)))
        }
        // Преступление выводится из уже применённой летописи поступков.
        _ => {
            let crime = crime_from_deed_ledger(state, event);
            add_crime(normalized, crime)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NORTH: &str = "north";

    fn world_map(current: &str) -> Value {
        json!({
            "seed": "law-seed",
            "regions": [
                { "id": NORTH, "name": "Северный край" },
                { "id": "south", "name": "Южный край" },
                { "id": "east", "name": "Восточный край" },
            ],
            "locations": [
                { "id": "village", "name": "Тихий Брод", "kind": "village", "regionId": NORTH },
                { "id": "road", "name": "Старый тракт", "kind": "landmark", "regionId": NORTH },
                { "id": "capital", "name": "Стольный Град", "kind": "capital", "regionId": NORTH },
                { "id": "farcity", "name": "Дальний Град", "kind": "city", "regionId": "east" },
            ],
            "currentLocationId": current,
        })
    }

    fn crime(id: &str, kind: &str, region: &str, at: i64) -> Value {
        json!({ "id": id, "kind": kind, "region_id": region, "at_minutes": at })
    }

    fn state_with(crimes: Vec<Value>, minutes: i64, current: &str) -> Value {
        json!({
            "sessionCode": "LAW",
            "worldMap": world_map(current),
            "law": { "crimes": crimes },
            "mechanics": { "world_time": { "elapsed_minutes": minutes } },
        })
    }

    #[test]
    fn level_grows_with_severity_not_count() {
        let theft = state_with(vec![crime("c1", "theft", NORTH, 0)], 0, "village");
        assert_eq!(wanted_for(&theft, &json!(NORTH))["points"], 2);
        assert_eq!(wanted_for(&theft, &json!(NORTH))["level"], 1);
        let both = state_with(vec![crime("c1", "murder", NORTH, 0), crime("c2", "arson", NORTH, 0)], 0, "village");
        assert_eq!(wanted_for(&both, &json!(NORTH))["points"], 7);
        assert_eq!(wanted_for(&both, &json!(NORTH))["label"], "розыск по краю");
        assert_eq!(wanted_for(&both, &json!("east"))["level"], 0, "в другом крае отряд чист");
    }

    #[test]
    fn a_day_of_quiet_removes_a_point() {
        let tick = |minutes| wanted_for(&state_with(vec![crime("c1", "murder", NORTH, 0)], minutes, "village"), &json!(NORTH));
        assert_eq!(tick(WANTED_DECAY_MINUTES - 1)["points"], 4);
        assert_eq!(tick(WANTED_DECAY_MINUTES)["points"], 3);
        assert_eq!(tick(WANTED_DECAY_MINUTES * 2)["level"], 1);
        assert_eq!(tick(WANTED_DECAY_MINUTES * 4)["points"], 0);
        assert_eq!(tick(WANTED_DECAY_MINUTES * 4)["level"], 0);
    }

    #[test]
    fn overfull_amnesty_registry_loses_the_oldest() {
        let mut cleared = Map::new();
        for index in 0..45 {
            cleared.insert(format!("region-{index:02}"), json!({ "at_minutes": index, "reason": "amnesty" }));
        }
        let law = normalize_law_state(Some(&json!({ "cleared": cleared })));
        let keys: Vec<&String> = law["cleared"].as_object().map(|map| map.keys().collect()).unwrap_or_default();
        assert_eq!(keys.len(), 40);
        assert!(keys.iter().any(|key| *key == "region-44"));
        assert!(!keys.iter().any(|key| *key == "region-00"));
    }

    #[test]
    fn signs_and_trade_follow_the_level() {
        assert!(wanted_signs_for(&state_with(vec![], 0, "village")).is_empty());
        assert_eq!(wanted_signs_for(&state_with(vec![crime("c1", "theft", NORTH, 0)], 0, "village")).len(), 1);
        let hunted = state_with(vec![crime("c1", "murder", NORTH, 0), crime("c2", "arson", NORTH, 0)], 0, "village");
        assert!(wanted_signs_for(&hunted).iter().any(|line| line.contains("разыскиваются")));
        assert!(!wanted_trade_available(&hunted));
        assert_eq!(wanted_price_bps(&hunted), 1_000);
    }

    #[test]
    fn feed_puts_the_dangerous_region_first() {
        let state = state_with(vec![crime("c1", "theft", NORTH, 0), crime("c2", "murder", "east", 5)], 10, "farcity");
        let feed = wanted_feed(&state);
        let regions: Vec<String> = feed.iter().map(|entry| s(entry.get("region_id"))).collect();
        assert_eq!(regions, ["east", NORTH]);
        assert_eq!(feed[0]["here"], true);
        assert_eq!(feed[1]["level"], 1);
    }

    #[test]
    fn guard_options_and_escape_follow_js() {
        let encounter = json!({ "id": "g1", "region_id": NORTH, "fine_cp": 2_000, "escape_dc": 13 });
        let ids: Vec<String> = guard_options_for(Some(&encounter)).iter().map(|option| s(option.get("id"))).collect();
        assert_eq!(ids, ["fine", "surrender", "flee", "fight"]);
        assert!(escape_succeeded(&json!([{ "success": true }, { "success": false }])));
        assert!(!escape_succeeded(&json!([{ "success": false }, { "success": "true" }])));
        assert!(!escape_succeeded(&json!([])));
    }

    #[test]
    fn officer_name_keeps_the_latin_letter() {
        assert!(OFFICER_NAMES[3].contains('c'));
        assert_eq!(OFFICER_NAMES[3].chars().filter(char::is_ascii).count(), 1);
    }

    #[test]
    fn reducer_records_and_forgives_crimes() {
        let state = state_with(vec![], 0, "village");
        let raised = apply_law_event(None, &json!({ "event_type": "WantedLevelRaised", "payload": { "crime": crime("c1", "theft", NORTH, 0) } }), &state);
        assert_eq!(raised["crimes"].as_array().map(Vec::len), Some(1));
        let again = apply_law_event(Some(&raised), &json!({ "event_type": "WantedLevelRaised", "payload": { "crime": crime("c1", "theft", NORTH, 0) } }), &state);
        assert_eq!(again, raised, "повтор того же преступления второго не заводит");
        let cleared = apply_law_event(Some(&raised), &json!({ "event_type": "WantedCleared", "payload": { "region_id": NORTH, "crime_ids": ["c1"], "reason": "fine", "at_minutes": 7 } }), &state);
        assert_eq!(cleared["crimes"][0]["cleared_reason"], "fine");
        assert_eq!(cleared["cleared"][NORTH], json!({ "at_minutes": 7, "reason": "fine" }));
    }
}

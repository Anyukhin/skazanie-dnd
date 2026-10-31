//! Перенос `server/courier-letters.mjs`: письма и курьеры — слово отряда
//! доходит туда, где отряда нет.
//!
//! Своих часов у почты нет: доставка, возврат и ответ считаются на мировых
//! минутах внутри `appendWorldTimeConsequences` Rules Engine
//! ([`plan_courier_letter_ticks`]). Дальность — по разведанным дорогам карты
//! мира (Дейкстра), без дороги — по прямой. Ответ детерминирован по тону
//! отношения; модель может только переписать его слова при отправке
//! ([`with_courier_reply_draft`], перенос одноимённой функции
//! `server/index.mjs`), и черновик звучит, лишь пока тон не сменился.
//!
//! Данные на границе — `serde_json::Value` той же формы, что в JS.

use std::cell::OnceCell;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::future::Future;
use std::sync::LazyLock;

use icu_collator::options::CollatorOptions;
use icu_collator::{Collator, CollatorBorrowed, CollatorPreferences};
use serde_json::{json, Map, Value};
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::{js, re, text as jstext, v8math};
use sk_geometry::world_map::world_location_by_id;
use sk_npc_world::npc_positioning::{normalize_npc_world_state, present_scene_npcs};
use sk_social::npc_social::{campaign_elapsed_minutes, ensure_npc_social_state, npc_profile_at_world_time, npc_relationship_event_drafts, promise_due_offset_minutes};

use crate::common::{array, coalesce, comparable, digest, digest_u32, f64_value, get, is_safe_id, is_str, js_max, spread, string, text, text_str};

pub const COURIER_LETTERS_SCHEMA_VERSION: i64 = 1;
pub const COURIER_LETTERS_POLICY_ID: &str = "skazanie:courier-letters-v1";

/// Команда одна, и она игрока: письмо пишет герой, а не сервер.
pub const COURIER_LETTER_COMMAND_TYPES: [&str; 1] = ["SendLetter"];

/// События почты (`COURIER_LETTER_EVENT_TYPES`). Список закрытый.
pub struct CourierLetterEventTypes {
    pub sent: &'static str,
    pub delivered: &'static str,
    pub returned: &'static str,
    pub answered: &'static str,
    pub unanswered: &'static str,
}

pub const COURIER_LETTER_EVENT_TYPES: CourierLetterEventTypes = CourierLetterEventTypes {
    sent: "CourierLetterSent",
    delivered: "CourierLetterDelivered",
    returned: "CourierLetterReturned",
    answered: "CourierLetterAnswered",
    unanswered: "CourierLetterUnanswered",
};

/// Кому пишут: известному NPC или фракции из памяти мира.
pub const COURIER_LETTER_ADDRESSEE_KINDS: [&str; 2] = ["npc", "faction"];
pub const COURIER_LETTER_BODY_LIMIT: usize = 1_200;
pub const COURIER_LETTER_OPEN_LIMIT: i64 = 3;
pub const COURIER_LETTER_BASE_FEE_CP: i64 = 50;
pub const COURIER_LETTER_FEE_PER_LEAGUE_CP: i64 = 10;
pub const COURIER_LETTER_MINUTES_PER_LEAGUE: i64 = 240;
pub const COURIER_LETTER_MINIMUM_MINUTES: i64 = 480;
pub const COURIER_LETTER_WRITING_MINUTES: i64 = 30;
pub const COURIER_LETTER_REPLY_DELAY_MINUTES: i64 = 720;
pub const COURIER_LETTER_FACTION_LEAGUES: i64 = 6;
pub const COURIER_LETTER_UNKNOWN_LEAGUES: i64 = 6;
pub const COURIER_LETTER_MAX_LEAGUES: i64 = 30;
pub const COURIER_LETTER_RELATIONSHIP_DELTA: i64 = 2;
pub const COURIER_LETTER_PROMISE_BONUS: i64 = 1;
pub const COURIER_LETTER_GOODWILL_COOLDOWN_MINUTES: i64 = 10_080;

/// Русские подписи состояний.
pub const COURIER_LETTER_STATUS_LABELS: [(&str, &str); 5] = [
    ("in_transit", "В пути"),
    ("delivered", "Доставлено"),
    ("answered", "Получен ответ"),
    ("returned", "Не доставлено"),
    ("unanswered", "Ответа не будет"),
];

/// Заголовок карточки летописи.
pub const COURIER_LETTER_CARD_TITLE: &str = "Почта отряда";

const MAX_LETTERS: usize = 40;
const STATUSES: [&str; 5] = ["in_transit", "delivered", "answered", "returned", "unanswered"];
const RETURN_REASONS: [&str; 2] = ["dead", "gone"];
const TONES: [&str; 5] = ["warm", "friendly", "plain", "cold", "silent"];

/// `a.localeCompare(b, 'ru')`: явная русская локаль (кириллица раньше латиницы).
static RU_COLLATOR: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| {
    let locale: icu_locale_core::Locale = icu_locale_core::locale!("ru");
    Collator::try_new(CollatorPreferences::from(&locale), CollatorOptions::default()).expect("сопоставитель строк ICU для ru")
});

fn locale_compare_ru(a: &str, b: &str) -> Ordering {
    RU_COLLATOR.compare(a, b)
}

/// Копия `integer` этого модуля: пустое место (`null`, `undefined`, `''`,
/// логическое) — запас **до** `Number`, иначе `Number(null) === 0` съедал бы
/// запас.
fn integer(value: Option<&Value>, fallback: i64) -> i64 {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(_)) => fallback,
        Some(Value::String(text)) if text.is_empty() => fallback,
        other => js::safe_int(other, fallback),
    }
}

/// [`integer`] для числа JS.
fn integer_f64(value: f64, fallback: i64) -> i64 {
    integer(Some(&f64_value(value)), fallback)
}

fn visible_to_party(value: Option<&Value>) -> bool {
    let visibility = text(value, 30);
    matches!(if visibility.is_empty() { "gm_only" } else { visibility.as_str() }, "party" | "public")
}

fn in_set(set: &[&str], value: &str) -> bool {
    set.contains(&value)
}

// ---------------------------------------------------------------------------
// Состояние
// ---------------------------------------------------------------------------

fn optional_minutes(value: Option<&Value>) -> Value {
    if js::present(value) {
        json!(integer(value, 0).max(0))
    } else {
        Value::Null
    }
}

/// `safeLetter`: запись письма или `None`.
fn safe_letter(value: Option<&Value>) -> Option<Map<String, Value>> {
    let id = text(get(value, "id"), 140);
    if !is_safe_id(&id, 139) {
        return None;
    }
    let hero_id = text(get(value, "hero_id"), 120);
    let addressee_id = text(get(value, "addressee_id"), 120);
    if hero_id.is_empty() || addressee_id.is_empty() {
        return None;
    }
    let sent_at = integer(get(value, "sent_at_minutes"), 0).max(0);
    let delivery_due = sent_at.max(integer(get(value, "delivery_due_minutes"), sent_at));
    let kind = text(get(value, "addressee_kind"), 20);
    let status = text(get(value, "status"), 20);
    let reason = text(get(value, "return_reason"), 20);
    let tone = text(get(value, "tone"), 20);
    let draft_tone = text(get(value, "reply_draft_tone"), 20);
    let mut map = Map::new();
    map.insert("id".into(), string(id));
    map.insert("hero_id".into(), string(hero_id));
    map.insert("hero_name".into(), string(text(get(value, "hero_name"), 120)));
    map.insert("addressee_kind".into(), string(if in_set(&COURIER_LETTER_ADDRESSEE_KINDS, &kind) { kind } else { "npc".into() }));
    map.insert("addressee_id".into(), string(addressee_id));
    map.insert("addressee_name".into(), string(text(get(value, "addressee_name"), 180)));
    map.insert("place_name".into(), string(text(get(value, "place_name"), 180)));
    map.insert("leagues".into(), json!(integer(get(value, "leagues"), 1).min(COURIER_LETTER_MAX_LEAGUES).max(0)));
    map.insert("fee_cp".into(), json!(integer(get(value, "fee_cp"), 0).max(0)));
    map.insert("body".into(), string(text(get(value, "body"), COURIER_LETTER_BODY_LIMIT)));
    map.insert("promise_text".into(), string(text(get(value, "promise_text"), 500)));
    map.insert("promise_due_hint".into(), string(text(get(value, "promise_due_hint"), 240)));
    map.insert("status".into(), string(if in_set(&STATUSES, &status) { status } else { "in_transit".into() }));
    map.insert("sent_at_minutes".into(), json!(sent_at));
    map.insert("delivery_due_minutes".into(), json!(delivery_due));
    map.insert("reply_due_minutes".into(), json!(delivery_due.max(integer(get(value, "reply_due_minutes"), delivery_due))));
    map.insert("delivered_at_minutes".into(), optional_minutes(get(value, "delivered_at_minutes")));
    map.insert("answered_at_minutes".into(), optional_minutes(get(value, "answered_at_minutes")));
    map.insert("returned_at_minutes".into(), optional_minutes(get(value, "returned_at_minutes")));
    map.insert("return_reason".into(), string(if in_set(&RETURN_REASONS, &reason) { reason } else { String::new() }));
    map.insert("tone".into(), string(if in_set(&TONES, &tone) { tone } else { "plain".into() }));
    map.insert("reply_draft".into(), string(text(get(value, "reply_draft"), 1_000)));
    map.insert("reply_draft_tone".into(), string(if in_set(&TONES, &draft_tone) { draft_tone } else { String::new() }));
    map.insert("reply_text".into(), string(text(get(value, "reply_text"), 1_000)));
    map.insert("reply_provider".into(), string(text(get(value, "reply_provider"), 80)));
    Some(map)
}

/// Почта кампании (`normalizeCourierLetterState`): без повторов id, сорок последних.
pub fn normalize_courier_letter_state(input: Option<&Value>) -> Value {
    let mut letters: Vec<Value> = Vec::new();
    let mut seen: IndexSet<String> = IndexSet::new();
    for raw in array(get(input, "letters")) {
        // `safeLetter(null)` в JS бросает `TypeError`; здесь запись не проходит.
        let Some(letter) = safe_letter(Some(raw)) else { continue };
        if !seen.insert(js::s(letter.get("id"))) {
            continue;
        }
        letters.push(Value::Object(letter));
    }
    let start = letters.len().saturating_sub(MAX_LETTERS);
    json!({ "schema_version": COURIER_LETTERS_SCHEMA_VERSION, "letters": letters.split_off(start) })
}

fn letters_of(registry: Value) -> Vec<Value> {
    match registry {
        Value::Object(mut map) => match map.shift_remove("letters") {
            Some(Value::Array(items)) => items,
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

fn letters_in(state: &Value) -> Vec<Value> {
    letters_of(normalize_courier_letter_state(get(Some(state), "courier_letters")))
}

/// Редьюсер почты (`applyCourierLetterEvent`).
pub fn apply_courier_letter_event(input: Option<&Value>, event: &Value) -> Value {
    let already = get(input, "schema_version").and_then(Value::as_f64) == Some(COURIER_LETTERS_SCHEMA_VERSION as f64) && matches!(get(input, "letters"), Some(Value::Array(_)));
    let normalized = if already { input.cloned().unwrap_or(Value::Null) } else { normalize_courier_letter_state(input) };
    let event_type = js::s(get(Some(event), "event_type"));
    let empty = json!({});
    let payload = coalesce(get(Some(event), "payload"), None).unwrap_or(&empty);
    let payload = Some(payload);
    let entries = array(normalized.get("letters"));
    if event_type == COURIER_LETTER_EVENT_TYPES.sent {
        let Some(letter) = safe_letter(get(payload, "letter")) else { return normalized };
        let id = js::s(letter.get("id"));
        if entries.iter().any(|entry| is_str(get(Some(entry), "id"), &id)) {
            return normalized;
        }
        let mut next = entries.to_vec();
        next.push(Value::Object(letter));
        return normalize_courier_letter_state(Some(&json!({ "letters": next })));
    }
    let letter_id = text(get(payload, "letter_id"), 140);
    if letter_id.is_empty() || !entries.iter().any(|entry| is_str(get(Some(entry), "id"), &letter_id)) {
        return normalized;
    }
    let raw = |key: &str| get(payload, key).cloned().unwrap_or(Value::Null);
    let at = json!(integer(get(payload, "at_minutes"), 0));
    let patch: Vec<(&str, Value)> = match event_type.as_str() {
        "CourierLetterDelivered" => vec![("status", string("delivered")), ("delivered_at_minutes", at), ("tone", raw("tone"))],
        "CourierLetterReturned" => vec![("status", string("returned")), ("returned_at_minutes", at), ("return_reason", raw("reason"))],
        "CourierLetterUnanswered" => vec![("status", string("unanswered")), ("answered_at_minutes", at), ("return_reason", raw("reason"))],
        "CourierLetterAnswered" => vec![("status", string("answered")), ("answered_at_minutes", at), ("reply_text", raw("reply")), ("reply_provider", raw("provider"))],
        _ => return normalized,
    };
    let next: Vec<Value> = entries
        .iter()
        .map(|entry| {
            if !is_str(get(Some(entry), "id"), &letter_id) {
                return entry.clone();
            }
            let mut map = spread(Some(entry));
            for (key, value) in &patch {
                map.insert((*key).to_string(), value.clone());
            }
            Value::Object(map)
        })
        .collect();
    normalize_courier_letter_state(Some(&json!({ "letters": next })))
}

// ---------------------------------------------------------------------------
// Дальность, цена и срок
// ---------------------------------------------------------------------------

/// Стоимость дороги от одного узла до всех остальных (`worldLeagueTable`):
/// Дейкстра по разведанным маршрутам, при равной стоимости — меньший id.
fn world_league_table(map: Option<&Value>, from_id: Option<&Value>) -> IndexMap<String, f64> {
    let from = text(from_id, 120);
    let locations = array(get(map, "locations"));
    let mut table: IndexMap<String, f64> = IndexMap::new();
    if from.is_empty() || !locations.iter().any(|location| is_str(get(Some(location), "id"), &from)) {
        return table;
    }
    let mut neighbours: IndexMap<String, Vec<(String, f64)>> = IndexMap::new();
    for route in array(get(map, "routes")) {
        let route = Some(route);
        if js::is_false(get(route, "discovered")) {
            continue;
        }
        let distance = integer(get(route, "distance"), 1).max(1) as f64;
        for (left, right) in [(get(route, "from"), get(route, "to")), (get(route, "to"), get(route, "from"))] {
            let start = text(left, 120);
            let end = text(right, 120);
            if start.is_empty() || end.is_empty() {
                continue;
            }
            neighbours.entry(start).or_default().push((end, distance));
        }
    }
    table.insert(from, 0.0);
    let mut visited: IndexSet<String> = IndexSet::new();
    let steps = locations.len() + neighbours.len() + 1;
    for _ in 0..steps {
        let mut current = String::new();
        let mut current_cost = f64::INFINITY;
        for (id, cost) in &table {
            if visited.contains(id) {
                continue;
            }
            if *cost < current_cost || (*cost == current_cost && jstext::locale_compare(id, &current) == Ordering::Less) {
                current = id.clone();
                current_cost = *cost;
            }
        }
        if current.is_empty() {
            break;
        }
        visited.insert(current.clone());
        for (id, distance) in neighbours.get(&current).cloned().unwrap_or_default() {
            let candidate = current_cost + distance;
            if candidate < table.get(&id).copied().unwrap_or(f64::INFINITY) {
                table.insert(id, candidate);
            }
        }
    }
    table
}

/// Кратчайший путь по уже посчитанной таблице (`leaguesFromTable`); без
/// дороги — прямая. `None` — `null` в JS; `Some(NaN)` — `NaN` от мусорных координат.
fn leagues_from_table(map: Option<&Value>, table: &IndexMap<String, f64>, from_id: Option<&Value>, to_id: Option<&Value>) -> Option<f64> {
    let from = text(from_id, 120);
    let to = text(to_id, 120);
    if from.is_empty() || to.is_empty() {
        return None;
    }
    if from == to {
        return Some(0.0);
    }
    let locations = array(get(map, "locations"));
    let start = locations.iter().find(|location| is_str(get(Some(location), "id"), &from))?;
    let end = locations.iter().find(|location| is_str(get(Some(location), "id"), &to))?;
    if let Some(cost) = table.get(&to) {
        return Some(*cost);
    }
    let dx = js::number(get(Some(start), "x")) - js::number(get(Some(end), "x"));
    let dy = js::number(get(Some(start), "y")) - js::number(get(Some(end), "y"));
    Some(js_max(1.0, js::round(v8math::hypot(dx, dy) / 48.0)))
}

/// Кратчайший путь по дорогам карты мира в переходах (`worldLeaguesBetween`).
pub fn world_leagues_between(map: Option<&Value>, from_id: Option<&Value>, to_id: Option<&Value>) -> Option<f64> {
    leagues_from_table(map, &world_league_table(map, from_id), from_id, to_id)
}

fn party_location_id(state: &Value) -> String {
    let scene = get(Some(state), "scene");
    text(coalesce(coalesce(get(scene, "location_id"), get(scene, "locationId")), get(get(Some(state), "worldMap"), "currentLocationId")), 120)
}

/// Общий счёт одного прохода по почте (`courierLetterContext`): ленивые
/// соц. состояние, живучесть NPC, присутствующие и таблица дорог.
pub struct CourierLetterContext<'a> {
    state: &'a Value,
    social: OnceCell<Value>,
    vitals: OnceCell<Value>,
    present: OnceCell<IndexSet<String>>,
    origin: OnceCell<String>,
    table: OnceCell<IndexMap<String, f64>>,
    profile_state: OnceCell<Value>,
    leagues: std::cell::RefCell<HashMap<String, Option<f64>>>,
}

impl<'a> CourierLetterContext<'a> {
    pub fn new(state: &'a Value) -> Self {
        Self {
            state,
            social: OnceCell::new(),
            vitals: OnceCell::new(),
            present: OnceCell::new(),
            origin: OnceCell::new(),
            table: OnceCell::new(),
            profile_state: OnceCell::new(),
            leagues: std::cell::RefCell::new(HashMap::new()),
        }
    }

    fn social(&self) -> &Value {
        self.social.get_or_init(|| ensure_npc_social_state(get(Some(self.state), "social").unwrap_or(&Value::Null), self.state, &Value::Null))
    }

    fn npcs(&self) -> &[Value] {
        array(self.social().get("npcs"))
    }

    fn vitals(&self) -> &Value {
        self.vitals.get_or_init(|| normalize_npc_world_state(get(Some(self.state), "npc_world"), &Value::Null).get("vitals").cloned().unwrap_or_else(|| json!({})))
    }

    fn vital_alive_false(&self, npc_id: &str) -> bool {
        js::is_false(get(get(Some(self.vitals()), npc_id), "alive"))
    }

    fn profile_state_at(&self, at_minutes: Option<i64>) -> Value {
        let state = Some(self.state);
        let mut out = Map::new();
        match at_minutes {
            None => {
                if let Some(mechanics) = get(state, "mechanics") {
                    out.insert("mechanics".into(), mechanics.clone());
                }
            }
            Some(minute) => {
                let mut mechanics = spread(coalesce(get(state, "mechanics"), None));
                let mut world_time = spread(coalesce(get(get(state, "mechanics"), "world_time"), None));
                world_time.insert("elapsed_minutes".into(), json!(minute));
                mechanics.insert("world_time".into(), Value::Object(world_time));
                out.insert("mechanics".into(), Value::Object(mechanics));
            }
        }
        for key in ["enemies", "actors"] {
            if let Some(value) = get(state, key) {
                out.insert(key.into(), value.clone());
            }
        }
        out.insert("npc_world".into(), json!({ "vitals": self.vitals() }));
        Value::Object(out)
    }

    fn profile_at_time(&self, profile: &Value, at_minutes: Option<f64>) -> Value {
        match at_minutes {
            None => npc_profile_at_world_time(profile, self.profile_state.get_or_init(|| self.profile_state_at(None))),
            Some(minute) => npc_profile_at_world_time(profile, &self.profile_state_at(Some(integer_f64(minute, 0).max(0)))),
        }
    }

    fn present(&self) -> &IndexSet<String> {
        self.present.get_or_init(|| present_scene_npcs(self.state).iter().map(|npc| js::string(npc.get("id"))).collect())
    }

    fn leagues_to(&self, target_id: Option<&Value>) -> Option<f64> {
        let target = text(target_id, 120);
        if let Some(value) = self.leagues.borrow().get(&target) {
            return *value;
        }
        let from = self.origin.get_or_init(|| party_location_id(self.state)).clone();
        let map = get(Some(self.state), "worldMap");
        let value = if target.is_empty() || from.is_empty() {
            None
        } else {
            let table = self.table.get_or_init(|| world_league_table(map, Some(&string(from.clone()))));
            leagues_from_table(map, table, Some(&string(from)), Some(&string(target.clone())))
        };
        self.leagues.borrow_mut().insert(target, value);
        value
    }
}

/// Узел карты по названию места из профиля NPC (`locationIdByName`): сырое `id`.
fn location_id_by_name(map: Option<&Value>, name: Option<&Value>) -> Value {
    let expected = comparable(name);
    if expected.is_empty() {
        return string("");
    }
    array(get(map, "locations"))
        .iter()
        .find(|location| comparable(get(Some(location), "name")) == expected)
        .and_then(|location| coalesce(get(Some(location), "id"), None).cloned())
        .unwrap_or_else(|| string(""))
}

/// Цена курьера (`courierFeeFor`).
pub fn courier_fee_for(leagues: Option<&Value>) -> i64 {
    COURIER_LETTER_BASE_FEE_CP + COURIER_LETTER_FEE_PER_LEAGUE_CP * integer(leagues, 0).min(COURIER_LETTER_MAX_LEAGUES).max(0)
}

/// Время в пути (`courierTravelMinutes`).
pub fn courier_travel_minutes(leagues: Option<&Value>) -> i64 {
    COURIER_LETTER_MINIMUM_MINUTES.max(COURIER_LETTER_MINUTES_PER_LEAGUE * integer(leagues, 1).min(COURIER_LETTER_MAX_LEAGUES).max(1))
}

// ---------------------------------------------------------------------------
// Кому вообще можно писать
// ---------------------------------------------------------------------------

/// Тон ответа по числу отношения (`courierToneFor`).
pub fn courier_tone_for(score: Option<&Value>) -> &'static str {
    let value = integer(score, 0).clamp(-100, 100);
    if value <= -50 {
        "silent"
    } else if value <= -20 {
        "cold"
    } else if value >= 50 {
        "warm"
    } else if value >= 20 {
        "friendly"
    } else {
        "plain"
    }
}

/// `object[key]` для словаря или массива (индекс); унаследованное — нет.
fn lookup<'v>(value: Option<&'v Value>, key: &str) -> Option<&'v Value> {
    match value {
        Some(Value::Object(map)) => map.get(key),
        Some(Value::Array(items)) if js::is_array_index_key(key) => key.parse::<usize>().ok().and_then(|index| items.get(index)),
        _ => None,
    }
}

fn addressee_score(state: &Value, kind: Option<&Value>, id: Option<&Value>, hero_id: Option<&Value>, context: &CourierLetterContext) -> i64 {
    if is_str(kind, "faction") {
        let reputations = get(get(Some(state), "autonomy"), "reputations").filter(|value| value.is_object() || value.is_array());
        return integer(lookup(reputations, &text(id, 120)), 0);
    }
    let relationships = context.social().get("relationships");
    integer(lookup(lookup(relationships, &text(id, 120)), &text(hero_id, 120)), 0)
}

/// Один адресат с дорогой, ценой и сроком (`courierAddresseeFor`), либо
/// `None`, если писать ему нельзя. `context` — общий счёт прохода; `None` —
/// одиночный вопрос заводит его сам.
pub fn courier_addressee_for(state: &Value, kind: Option<&Value>, id: Option<&Value>, context: Option<&CourierLetterContext>) -> Option<Value> {
    let own;
    let context = match context {
        Some(context) => context,
        None => {
            own = CourierLetterContext::new(state);
            &own
        }
    };
    let wanted_kind = text(kind, 20);
    let wanted_id = text(id, 120);
    if !in_set(&COURIER_LETTER_ADDRESSEE_KINDS, &wanted_kind) || wanted_id.is_empty() {
        return None;
    }
    let map = get(Some(state), "worldMap");
    if wanted_kind == "faction" {
        let faction = array(get(get(Some(state), "worldMemory"), "entities")).iter().find(|entity| {
            let entity = Some(*entity);
            is_str(get(entity, "id"), &wanted_id) && is_str(get(entity, "kind"), "faction") && visible_to_party(get(entity, "visibility"))
        })?;
        let leagues = COURIER_LETTER_FACTION_LEAGUES;
        return Some(json!({
            "kind": "faction",
            "id": wanted_id,
            "name": text(get(Some(faction), "name"), 180),
            "role": "фракция",
            "place_name": "",
            "leagues": leagues,
            "fee_cp": courier_fee_for(Some(&json!(leagues))),
            "travel_minutes": courier_travel_minutes(Some(&json!(leagues))),
            "unreachable": false,
        }));
    }
    let persisted = context.npcs().iter().find(|npc| is_str(get(Some(npc), "id"), &wanted_id))?;
    if !visible_to_party(get(Some(persisted), "visibility")) {
        return None;
    }
    let profile = context.profile_at_time(persisted, None);
    if context.vital_alive_false(&wanted_id) {
        return None;
    }
    let target_id = location_id_by_name(map, get(Some(&profile), "location"));
    let leagues_value = if js::truthy(Some(&target_id)) { context.leagues_to(Some(&target_id)).map(f64_value) } else { None };
    let leagues = integer(leagues_value.as_ref(), COURIER_LETTER_UNKNOWN_LEAGUES).min(COURIER_LETTER_MAX_LEAGUES).max(0);
    let node = world_location_by_id(map, &js::s(Some(&target_id)));
    let place = coalesce(node.and_then(|node| get(Some(node), "name")), get(Some(&profile), "location"));
    Some(json!({
        "kind": "npc",
        "id": wanted_id,
        "name": text(get(Some(&profile), "name"), 180),
        "role": text(get(Some(&profile), "role"), 160),
        "place_name": text(place, 180),
        "leagues": leagues,
        "fee_cp": courier_fee_for(Some(&json!(leagues))),
        "travel_minutes": courier_travel_minutes(Some(&json!(leagues))),
        "unreachable": context.present().contains(&wanted_id),
    }))
}

/// Все, кому отряд может написать (`courierLetterAddressees`): ближние вперёд,
/// дальше по имени (русская сортировка) и id.
pub fn courier_letter_addressees(state: &Value) -> Vec<Value> {
    let context = CourierLetterContext::new(state);
    let mut rows = Vec::new();
    for npc in context.npcs() {
        if let Some(row) = courier_addressee_for(state, Some(&string("npc")), get(Some(npc), "id"), Some(&context)) {
            rows.push(row);
        }
    }
    for entity in array(get(get(Some(state), "worldMemory"), "entities")) {
        if !is_str(get(Some(entity), "kind"), "faction") {
            continue;
        }
        if let Some(row) = courier_addressee_for(state, Some(&string("faction")), get(Some(entity), "id"), Some(&context)) {
            rows.push(row);
        }
    }
    rows.sort_by(|left, right| {
        let by_leagues = js::number(left.get("leagues")) - js::number(right.get("leagues"));
        if by_leagues != 0.0 {
            return if by_leagues < 0.0 { Ordering::Less } else { Ordering::Greater };
        }
        locale_compare_ru(&js::s(left.get("name")), &js::s(right.get("name"))).then_with(|| jstext::locale_compare(&js::s(left.get("id")), &js::s(right.get("id"))))
    });
    rows
}

/// Письма одного героя, свежие в конце (`courierLettersFor`).
pub fn courier_letters_for(state: &Value, hero_id: Option<&Value>) -> Vec<Value> {
    let hero = text(hero_id, 120);
    letters_in(state).into_iter().filter(|letter| is_str(letter.get("hero_id"), &hero)).collect()
}

/// Письма героя, которые ещё едут (`openCourierLettersFor`).
pub fn open_courier_letters_for(state: &Value, hero_id: Option<&Value>) -> Vec<Value> {
    courier_letters_for(state, hero_id).into_iter().filter(|letter| is_str(letter.get("status"), "in_transit")).collect()
}

// ---------------------------------------------------------------------------
// Обещание в письме
// ---------------------------------------------------------------------------

fn promise_marker(text: &str) -> bool {
    jstext::test(
        re!(r"(?<![а-яё])(обеща(?:ю|ем)|кляну(?:сь|тся)|клянёмся|да(?:ю|ём) слово|руча(?:юсь|емся)|заплач(?:у|ем)|верн(?:у|ём)|привез(?:у|ём)|прид(?:у|ём)|помог(?:у|ем))(?![а-яё])", "iu"),
        text,
    )
}

/// `flat.split(/(?<=[.!?…])\s+/u)`.
fn split_sentences(flat: &str) -> Vec<String> {
    let regex = re!(r"(?<=[.!?…])\s+", "u");
    let mut parts = Vec::new();
    let mut last = 0;
    for found in regex.find_iter(flat).flatten() {
        parts.push(flat[last..found.start()].to_string());
        last = found.end();
    }
    parts.push(flat[last..].to_string());
    parts
}

/// Обещание из письма (`courierLetterPromiseFrom`): предложение со словом и,
/// если в нём есть срок, подсказка срока.
pub fn courier_letter_promise_from(body: Option<&Value>) -> Option<Value> {
    let flat = text(body, COURIER_LETTER_BODY_LIMIT);
    if flat.is_empty() {
        return None;
    }
    let sentences: Vec<String> = split_sentences(&flat).iter().map(|sentence| jstext::trim(sentence).to_string()).filter(|sentence| !sentence.is_empty()).collect();
    let candidates = if sentences.is_empty() { vec![flat.clone()] } else { sentences };
    let sentence = candidates.into_iter().find(|candidate| promise_marker(candidate))?;
    let due = promise_due_offset_minutes(&string(sentence.clone())).is_some();
    Some(json!({
        "text": text_str(&sentence, 500),
        "due_hint": if due { text_str(&sentence, 240) } else { String::new() },
    }))
}

// ---------------------------------------------------------------------------
// Ответ
// ---------------------------------------------------------------------------

fn reply_variants(tone: &str) -> usize {
    match tone {
        "warm" | "friendly" | "plain" => 3,
        "cold" => 2,
        _ => 0,
    }
}

fn reply_template(tone: &str, index: usize, addressee: &str, hero: &str) -> String {
    match (tone, index) {
        ("warm", 0) => format!("{addressee} отвечает тепло: письмо {hero} прочли не один раз, и в конце приписано — «зови, приду»."),
        ("warm", 1) => format!("Ответ от {addressee} написан своей рукой: {hero} здесь ждут, и помощь обещана без условий."),
        ("warm", _) => format!("{addressee} пишет коротко и ясно: за {hero} тут стоят, что бы ни случилось."),
        ("friendly", 0) => format!("{addressee} отвечает доброжелательно: письмо {hero} получено, и просьбу обещают не забыть."),
        ("friendly", 1) => format!("Ответ от {addressee} сдержанный, но тёплый: {hero} благодарят за весть и зовут заходить."),
        ("friendly", _) => format!("{addressee} отвечает: рады слышать, помочь постараются — насколько хватит сил."),
        ("plain", 0) => format!("{addressee} отвечает сухо и по делу: письмо {hero} прочитано, ответ уместился в три строки."),
        ("plain", 1) => format!("{addressee} отвечает вежливо и ни к чему себя не обязывает."),
        ("plain", _) => format!("Ответ от {addressee} деловой: {hero} обещано ровно то, что не стоит хлопот."),
        ("cold", 0) => format!("{addressee} отвечает холодно: письмо {hero} прочли, и просьба осталась просьбой."),
        _ => format!("Ответ от {addressee} короток и недобр: помощи в нём нет, есть только «более не пишите»."),
    }
}

/// Тон-ключ таблицы ответов: `REPLY_TEMPLATES[tone]` (`undefined` — `plain`).
fn tone_key(tone: Option<&Value>) -> String {
    match tone {
        None => "plain".into(),
        other => js::string(other),
    }
}

/// Детерминированная основа ответа (`courierLetterReplyBase`). `tone` —
/// `None` для значения по умолчанию `'plain'`.
pub fn courier_letter_reply_base(letter: &Value, tone: Option<&Value>) -> String {
    let key = tone_key(tone);
    let variants = reply_variants(&key);
    if variants == 0 {
        return String::new();
    }
    let letter = Some(letter);
    let addressee = text(get(letter, "addressee_name"), 180);
    let addressee = if addressee.is_empty() { "адресат".to_string() } else { addressee };
    let hero = text(get(letter, "hero_name"), 120);
    let hero = if hero.is_empty() { "отряд".to_string() } else { hero };
    let start = (digest_u32(&[js::s(get(letter, "id")), js::s(get(letter, "addressee_id")), key.clone()]) % variants as u64) as usize;
    let base = reply_template(&key, start, &addressee, &hero);
    let tone_is_cold = tone.map_or(false, |tone| is_str(Some(tone), "cold"));
    if !js::truthy(get(letter, "promise_text")) || tone_is_cold {
        return base;
    }
    format!("{base} Данное в письме слово помнят: «{}».", text(get(letter, "promise_text"), 240))
}

/// Итоговый текст ответа (`courierLetterReplyFor`): черновик модели — только
/// под тот же тон.
pub fn courier_letter_reply_for(letter: &Value, tone: Option<&Value>) -> Option<Value> {
    let tone_value = tone.cloned().unwrap_or_else(|| string("plain"));
    if is_str(Some(&tone_value), "silent") {
        return None;
    }
    let base = courier_letter_reply_base(letter, tone);
    if base.is_empty() {
        return None;
    }
    let letter = Some(letter);
    let draft = text(get(letter, "reply_draft"), 1_000);
    if !draft.is_empty() && is_str(Some(&tone_value), &text(get(letter, "reply_draft_tone"), 20)) {
        let provider = text(get(letter, "reply_provider"), 80);
        return Some(json!({ "reply": draft, "provider": if provider.is_empty() { "llm".to_string() } else { provider } }));
    }
    Some(json!({ "reply": base, "provider": "deterministic-courier-reply" }))
}

// ---------------------------------------------------------------------------
// Отправка
// ---------------------------------------------------------------------------

/// Запись письма в том виде, в каком её несёт `CourierLetterSent`
/// (`planCourierLetter`). `options` — `{ heroId, heroName, addressee, body,
/// commandId, atMinutes, replyDraft, replyDraftTone, replyProvider }`.
pub fn plan_courier_letter(state: &Value, options: &Value) -> Option<Value> {
    let options = Some(options);
    let empty = string("");
    // Значения по умолчанию деструктуризации JS — только для `undefined`.
    let option = |key: &str| get(options, key).unwrap_or(&empty);
    let hero_id = option("heroId");
    let addressee = get(options, "addressee").filter(|value| js::truthy(Some(value)))?;
    let body = option("body");
    let command_id = option("commandId");
    let at_minutes = get(options, "atMinutes");
    let sent_at = if js::present(at_minutes) { integer(at_minutes, 0).max(0) as f64 } else { campaign_elapsed_minutes(state) };
    let addressee_ref = Some(addressee);
    let travel = courier_travel_minutes(get(addressee_ref, "leagues")) as f64;
    let promise = courier_letter_promise_from(Some(body));
    let context = CourierLetterContext::new(state);
    let tone = courier_tone_for(Some(&json!(addressee_score(state, get(addressee_ref, "kind"), get(addressee_ref, "id"), Some(hero_id), &context))));
    let seed = if js::truthy(Some(command_id)) { js::s(Some(command_id)) } else { format!("{}:{}", js::string(Some(hero_id)), js::f64_string(sent_at)) };
    let id = format!("letter:{}", &digest(&[seed, js::s(get(addressee_ref, "id")), text(Some(body), 200)])[..24]);
    let draft_tone = text(get(options, "replyDraftTone"), 20);
    let mut letter = Map::new();
    letter.insert("id".into(), string(id));
    letter.insert("hero_id".into(), hero_id.clone());
    letter.insert("hero_name".into(), option("heroName").clone());
    let raw = |key: &str| get(addressee_ref, key).cloned().unwrap_or(Value::Null);
    letter.insert("addressee_kind".into(), raw("kind"));
    letter.insert("addressee_id".into(), raw("id"));
    letter.insert("addressee_name".into(), raw("name"));
    letter.insert("place_name".into(), raw("place_name"));
    letter.insert("leagues".into(), raw("leagues"));
    letter.insert("fee_cp".into(), json!(courier_fee_for(get(addressee_ref, "leagues"))));
    letter.insert("body".into(), body.clone());
    letter.insert("promise_text".into(), promise.as_ref().map_or_else(|| string(""), |promise| promise["text"].clone()));
    letter.insert("promise_due_hint".into(), promise.as_ref().map_or_else(|| string(""), |promise| promise["due_hint"].clone()));
    letter.insert("status".into(), string("in_transit"));
    letter.insert("sent_at_minutes".into(), f64_value(sent_at));
    letter.insert("delivery_due_minutes".into(), f64_value(sent_at + travel));
    letter.insert("reply_due_minutes".into(), f64_value(sent_at + travel + COURIER_LETTER_REPLY_DELAY_MINUTES as f64 + travel));
    letter.insert("tone".into(), string(tone));
    letter.insert("reply_draft".into(), option("replyDraft").clone());
    letter.insert("reply_draft_tone".into(), string(if in_set(&TONES, &draft_tone) { draft_tone } else { String::new() }));
    letter.insert("reply_provider".into(), option("replyProvider").clone());
    // `undefined`-поля адресата в JS не пишутся; `null` от них здесь даёт тот же исход.
    safe_letter(Some(&Value::Object(letter))).map(Value::Object)
}

// ---------------------------------------------------------------------------
// Ход почты на мировых минутах
// ---------------------------------------------------------------------------

fn delivery_failure_for(letter: &Value, context: &CourierLetterContext, at_minutes: Option<f64>) -> &'static str {
    if is_str(letter.get("addressee_kind"), "faction") {
        return "";
    }
    let addressee_id = js::s(letter.get("addressee_id"));
    if context.vital_alive_false(&addressee_id) {
        return "dead";
    }
    let Some(profile) = context.npcs().iter().find(|npc| is_str(get(Some(npc), "id"), &addressee_id)) else { return "gone" };
    if js::is_false(context.profile_at_time(profile, at_minutes).get("available")) {
        "gone"
    } else {
        ""
    }
}

fn field(letter: &Value, key: &str) -> String {
    js::s(letter.get(key))
}

fn return_summary(reason: &str, letter: &Value) -> String {
    let name = field(letter, "addressee_name");
    if reason == "dead" {
        format!("Курьер вернул письмо к {name}: адресата больше нет в живых.")
    } else {
        format!("Курьер вернул письмо к {name}: адресата не нашли — к людям он больше не выходит.")
    }
}

fn silence_summary(reason: &str, letter: &Value) -> String {
    let name = field(letter, "addressee_name");
    if reason == "dead" {
        format!("Ответа от {name} не будет: письмо дошло, а адресата больше нет в живых.")
    } else {
        format!("Ответа от {name} не будет: письмо дошло, а самого адресата больше не найти.")
    }
}

fn goodwill_delta_for(letters: &[Value], letter: &Value, tone: &str, at_minutes: f64) -> i64 {
    if tone == "silent" {
        return 0;
    }
    let recent = letters.iter().any(|entry| {
        entry.get("id") != letter.get("id")
            && entry.get("hero_id") == letter.get("hero_id")
            && entry.get("addressee_id") == letter.get("addressee_id")
            && js::present(entry.get("delivered_at_minutes"))
            && at_minutes - js::number(entry.get("delivered_at_minutes")) < COURIER_LETTER_GOODWILL_COOLDOWN_MINUTES as f64
    });
    if recent {
        return 0;
    }
    COURIER_LETTER_RELATIONSHIP_DELTA + if js::truthy(letter.get("promise_text")) { COURIER_LETTER_PROMISE_BONUS } else { 0 }
}

fn letter_fact_draft(id: String, subject_id: &Value, predicate: &str, object: &Value, summary: &str, at_minutes: f64) -> Value {
    json!({
        "event_type": "WorldFactRecorded",
        "visibility": "party",
        "payload": {
            "fact": {
                "id": id,
                "subject_id": subject_id,
                "predicate": predicate,
                "object": jstext::head(&js::stringify(object), 1_000),
                "summary": summary,
                "visibility": "party",
                "source_event_ids": [],
                "source_command_id": "",
                "supersedes_fact_id": "",
                "status": "active",
                "recorded_at_minutes": js::num(at_minutes),
            },
        },
        "target_ids": [],
    })
}

fn addressee_entity_draft(state: &Value, letter: &Value, written: &mut IndexSet<String>) -> Vec<Value> {
    if !is_str(letter.get("addressee_kind"), "npc") {
        return Vec::new();
    }
    let addressee_id = field(letter, "addressee_id");
    let known = array(get(get(Some(state), "worldMemory"), "entities")).iter().any(|entity| text(get(Some(entity), "id"), 120) == addressee_id);
    if known || written.contains(&addressee_id) {
        return Vec::new();
    }
    written.insert(addressee_id.clone());
    let place = field(letter, "place_name");
    let summary = if place.is_empty() { "Адресат писем отряда.".to_string() } else { format!("Адресат писем отряда. Место: «{place}».") };
    vec![json!({
        "event_type": "WorldEntityUpserted",
        "visibility": "party",
        "payload": {
            "entity": {
                "id": addressee_id,
                "kind": "npc",
                "name": letter["addressee_name"],
                "summary": summary,
                "aliases": [],
                "visibility": "party",
                "tags": ["courier-letters"],
            },
        },
        "target_ids": [],
    })]
}

fn envelope(letter: &Value) -> Map<String, Value> {
    let mut map = Map::new();
    for key in ["hero_id", "hero_name", "addressee_kind", "addressee_id", "addressee_name"] {
        map.insert(key.into(), letter[key].clone());
    }
    map
}

/// Ход почты за один скачок времени (`planCourierLetterTicks`): черновики
/// событий в порядке записи. `elapsed_minutes` — длина скачка.
pub fn plan_courier_letter_ticks(state: &Value, elapsed_minutes: Option<&Value>) -> Vec<Value> {
    let jump = integer(elapsed_minutes, 0).max(0);
    if jump <= 0 {
        return Vec::new();
    }
    let start = campaign_elapsed_minutes(state);
    let end = start + jump as f64;
    let mut drafts = Vec::new();
    let mut goodwill: IndexSet<String> = IndexSet::new();
    let context = CourierLetterContext::new(state);
    let mut upserted: IndexSet<String> = IndexSet::new();
    let letters = letters_in(state);
    for letter in &letters {
        let status = field(letter, "status");
        if matches!(status.as_str(), "returned" | "answered" | "unanswered") {
            continue;
        }
        let mut delivered_at = if js::present(letter.get("delivered_at_minutes")) { js::number(letter.get("delivered_at_minutes")) } else { start };
        let mut tone = field(letter, "tone");
        let letter_id = letter["id"].clone();
        if status == "in_transit" {
            let delivery_due = js::number(letter.get("delivery_due_minutes"));
            if delivery_due > end {
                continue;
            }
            delivered_at = js_max(start, delivery_due);
            let failure = delivery_failure_for(letter, &context, Some(delivered_at));
            if !failure.is_empty() {
                let mut payload = Map::new();
                payload.insert("letter_id".into(), letter_id.clone());
                payload.extend(envelope(letter));
                payload.insert("reason".into(), string(failure));
                payload.insert("summary".into(), string(return_summary(failure, letter)));
                payload.insert("at_minutes".into(), js::num(delivered_at));
                payload.insert("policy_id".into(), string(COURIER_LETTERS_POLICY_ID));
                drafts.push(json!({ "event_type": COURIER_LETTER_EVENT_TYPES.returned, "visibility": "party", "payload": payload, "target_ids": [letter["hero_id"]] }));
                continue;
            }
            tone = courier_tone_for(Some(&json!(addressee_score(state, letter.get("addressee_kind"), letter.get("addressee_id"), letter.get("hero_id"), &context)))).to_string();
            let hero_name = field(letter, "hero_name");
            let summary = format!("Письмо {} дошло: {} держит его в руках.", if hero_name.is_empty() { "отряда" } else { &hero_name }, field(letter, "addressee_name"));
            let mut payload = Map::new();
            payload.insert("letter_id".into(), letter_id.clone());
            payload.extend(envelope(letter));
            payload.insert("tone".into(), string(tone.clone()));
            payload.insert("answer_expected".into(), Value::Bool(tone != "silent"));
            payload.insert("summary".into(), string(summary.clone()));
            payload.insert("at_minutes".into(), js::num(delivered_at));
            payload.insert("policy_id".into(), string(COURIER_LETTERS_POLICY_ID));
            drafts.push(json!({ "event_type": COURIER_LETTER_EVENT_TYPES.delivered, "visibility": "party", "payload": payload, "target_ids": [letter["hero_id"], letter["addressee_id"]] }));
            let goodwill_key = format!("{} {}", field(letter, "hero_id"), field(letter, "addressee_id"));
            let delta = if goodwill.contains(&goodwill_key) { 0 } else { goodwill_delta_for(&letters, letter, &tone, delivered_at) };
            if delta > 0 {
                goodwill.insert(goodwill_key);
                if is_str(letter.get("addressee_kind"), "faction") {
                    drafts.push(json!({
                        "event_type": "FactionReputationAdjusted",
                        "visibility": "party",
                        "payload": {
                            "faction_id": letter["addressee_id"],
                            "delta": delta,
                            "letter_id": letter_id,
                            "provenance": { "source": "server-courier-policy", "policy": COURIER_LETTERS_POLICY_ID },
                        },
                        "target_ids": [],
                    }));
                } else {
                    drafts.extend(npc_relationship_event_drafts(
                        state,
                        &json!({ "npcId": letter["addressee_id"], "heroId": letter["hero_id"], "delta": delta, "reason": "courier-letter" }),
                    ));
                }
            }
            if js::truthy(letter.get("promise_text")) && is_str(letter.get("addressee_kind"), "npc") {
                let due_offset = promise_due_offset_minutes(&letter["promise_due_hint"]);
                let mut promise = Map::new();
                promise.insert("id".into(), string(format!("promise:{}", &digest(&[field(letter, "id"), "letter-promise".into()])[..24])));
                promise.insert("npc_id".into(), letter["addressee_id"].clone());
                promise.insert("hero_id".into(), letter["hero_id"].clone());
                promise.insert("direction".into(), string("party_to_npc"));
                promise.insert("text".into(), letter["promise_text"].clone());
                promise.insert("due_hint".into(), letter["promise_due_hint"].clone());
                promise.insert("status".into(), string("open"));
                promise.insert("visibility".into(), string("party"));
                promise.insert("source_conversation_id".into(), string(""));
                promise.insert("created_at_minutes".into(), js::num(delivered_at));
                if let Some(offset) = due_offset {
                    promise.insert("deadline_minutes".into(), js::num(delivered_at + offset as f64));
                }
                drafts.push(json!({ "event_type": "NpcPromiseRecorded", "visibility": "party", "payload": { "promise": promise }, "target_ids": [letter["hero_id"]] }));
            }
            drafts.extend(addressee_entity_draft(state, letter, &mut upserted));
            drafts.push(letter_fact_draft(
                format!("fact:courier-letter-delivered:{}", &digest(&[field(letter, "id"), js::f64_string(delivered_at)])[..20]),
                &letter["addressee_id"],
                "courier_letter_delivered",
                &json!({ "letter_id": letter_id, "hero_id": letter["hero_id"], "at_minutes": js::num(delivered_at) }),
                &summary,
                delivered_at,
            ));
        }
        let reply_due = js::number(letter.get("reply_due_minutes"));
        if reply_due > end {
            continue;
        }
        let answered_at = js_max(delivered_at, reply_due);
        let silence = delivery_failure_for(letter, &context, Some(answered_at));
        if !silence.is_empty() {
            let summary = silence_summary(silence, letter);
            let mut payload = Map::new();
            payload.insert("letter_id".into(), letter_id.clone());
            payload.extend(envelope(letter));
            payload.insert("reason".into(), string(silence));
            payload.insert("summary".into(), string(summary.clone()));
            payload.insert("at_minutes".into(), js::num(answered_at));
            payload.insert("policy_id".into(), string(COURIER_LETTERS_POLICY_ID));
            drafts.push(json!({ "event_type": COURIER_LETTER_EVENT_TYPES.unanswered, "visibility": "party", "payload": payload, "target_ids": [letter["hero_id"]] }));
            drafts.extend(addressee_entity_draft(state, letter, &mut upserted));
            drafts.push(letter_fact_draft(
                format!("fact:courier-letter-unanswered:{}", &digest(&[field(letter, "id"), js::f64_string(answered_at)])[..20]),
                &letter["addressee_id"],
                "courier_letter_unanswered",
                &json!({ "letter_id": letter_id, "hero_id": letter["hero_id"], "reason": silence, "at_minutes": js::num(answered_at) }),
                &summary,
                answered_at,
            ));
            continue;
        }
        let Some(reply) = courier_letter_reply_for(letter, Some(&string(tone.clone()))) else { continue };
        let mut payload = Map::new();
        payload.insert("letter_id".into(), letter_id.clone());
        payload.extend(envelope(letter));
        payload.insert("tone".into(), string(tone.clone()));
        payload.insert("reply".into(), reply["reply"].clone());
        payload.insert("provider".into(), reply["provider"].clone());
        payload.insert("at_minutes".into(), js::num(answered_at));
        payload.insert("policy_id".into(), string(COURIER_LETTERS_POLICY_ID));
        drafts.push(json!({ "event_type": COURIER_LETTER_EVENT_TYPES.answered, "visibility": "party", "payload": payload, "target_ids": [letter["hero_id"]] }));
        drafts.extend(addressee_entity_draft(state, letter, &mut upserted));
        drafts.push(letter_fact_draft(
            format!("fact:courier-letter-answered:{}", &digest(&[field(letter, "id"), js::f64_string(answered_at)])[..20]),
            &letter["addressee_id"],
            "courier_letter_answered",
            &json!({ "letter_id": letter_id, "hero_id": letter["hero_id"], "tone": tone, "at_minutes": js::num(answered_at) }),
            &js::s(reply.get("reply")),
            answered_at,
        ));
    }
    drafts
}

// ---------------------------------------------------------------------------
// Проекция и летопись
// ---------------------------------------------------------------------------

fn status_label(status: &str) -> &str {
    COURIER_LETTER_STATUS_LABELS.iter().find(|(key, _)| *key == status).map_or(status, |(_, label)| label)
}

/// Публичная форма письма (`courierLetterForViewer`): запечатанный ответ и
/// тон адресата — только после ответа (тон — ещё и ведущему).
pub fn courier_letter_for_viewer(letter: Option<&Value>, is_admin: bool) -> Option<Value> {
    let safe = Value::Object(safe_letter(letter)?);
    let status = field(&safe, "status");
    let answered = status == "answered";
    let mut map = Map::new();
    for key in [
        "id", "hero_id", "hero_name", "addressee_kind", "addressee_id", "addressee_name", "place_name", "leagues", "fee_cp", "body", "promise_text", "status",
    ] {
        map.insert(key.into(), safe[key].clone());
    }
    map.insert("status_label".into(), string(status_label(&status)));
    for key in ["sent_at_minutes", "delivery_due_minutes", "reply_due_minutes", "delivered_at_minutes", "answered_at_minutes", "returned_at_minutes", "return_reason"] {
        map.insert(key.into(), safe[key].clone());
    }
    if answered || is_admin {
        map.insert("tone".into(), safe["tone"].clone());
    }
    if answered {
        map.insert("reply".into(), safe["reply_text"].clone());
    }
    Some(Value::Object(map))
}

/// Почта для зрителя (`courierLettersForViewer`). `options` — `{ isAdmin, limit }`.
pub fn courier_letters_for_viewer(state: &Value, options: &Value) -> Value {
    let options = Some(options);
    let is_admin = js::truthy(get(options, "isAdmin"));
    let limit = match get(options, "limit") {
        None => 20,
        some => integer(some, 20),
    };
    let mut letters = letters_in(state);
    letters.sort_by(|left, right| {
        let by_time = js::number(right.get("sent_at_minutes")) - js::number(left.get("sent_at_minutes"));
        if by_time != 0.0 {
            return if by_time < 0.0 { Ordering::Less } else { Ordering::Greater };
        }
        jstext::locale_compare(&field(left, "id"), &field(right, "id"))
    });
    letters.truncate(limit.min(MAX_LETTERS as i64).max(1) as usize);
    let visible: Vec<Value> = letters.iter().filter_map(|letter| courier_letter_for_viewer(Some(letter), is_admin)).collect();
    json!({
        "schema_version": COURIER_LETTERS_SCHEMA_VERSION,
        "letters": visible,
        "addressees": courier_letter_addressees(state),
        "base_fee_cp": COURIER_LETTER_BASE_FEE_CP,
        "fee_per_league_cp": COURIER_LETTER_FEE_PER_LEAGUE_CP,
        "body_limit": COURIER_LETTER_BODY_LIMIT,
        "open_limit": COURIER_LETTER_OPEN_LIMIT,
    })
}

/// Карточка летописи из подтверждённого события (`courierLetterChronicleEntry`).
pub fn courier_letter_chronicle_entry(event: &Value) -> Option<Value> {
    let event_type = js::s(get(Some(event), "event_type"));
    let empty = json!({});
    let payload = coalesce(get(Some(event), "payload"), None).unwrap_or(&empty);
    let payload = Some(payload);
    let sent = event_type == COURIER_LETTER_EVENT_TYPES.sent;
    let letter = if sent { safe_letter(get(payload, "letter")).map(Value::Object) } else { None };
    let from_letter = |key: &str, fallback: &str| coalesce(letter.as_ref().and_then(|letter| letter.get(key)), get(payload, fallback)).cloned();
    let addressee = text(from_letter("addressee_name", "addressee_name").as_ref(), 180);
    let addressee = if addressee.is_empty() { "адресат".to_string() } else { addressee };
    let hero = text(from_letter("hero_name", "hero_name").as_ref(), 120);
    let letter_id = text(from_letter("id", "letter_id").as_ref(), 140);
    if letter_id.is_empty() {
        return None;
    }
    let (kind, title, card_text) = if sent {
        // В JS у неразобранного письма `letter.place_name` бросает `TypeError`.
        let letter = letter.as_ref()?;
        let place = field(letter, "place_name");
        let place = if place.is_empty() { String::new() } else { format!(" в «{place}»") };
        ("sent", "Письмо отправлено", format!("Курьер увёз письмо к {addressee}{place}. Дорога — {} перех. и {} мм из кошелька.", field(letter, "leagues"), field(letter, "fee_cp")))
    } else {
        match event_type.as_str() {
            "CourierLetterDelivered" => ("delivered", "Письмо доставлено", text(get(payload, "summary"), 400)),
            "CourierLetterReturned" => ("returned", "Письмо вернулось", text(get(payload, "summary"), 400)),
            "CourierLetterUnanswered" => ("unanswered", "Ответа не будет", text(get(payload, "summary"), 400)),
            "CourierLetterAnswered" => ("answered", "Пришёл ответ", text(get(payload, "reply"), 800)),
            _ => return None,
        }
    };
    if card_text.is_empty() {
        return None;
    }
    let hero_or_party = if hero.is_empty() { "отряд".to_string() } else { hero };
    let (from, to) = if kind == "answered" { (addressee.clone(), hero_or_party) } else { (hero_or_party, addressee.clone()) };
    Some(json!({
        "id": format!("chronicle:{letter_id}:{kind}"),
        "speaker": "system",
        "author": COURIER_LETTER_CARD_TITLE,
        "text": card_text,
        "letter": { "kind": kind, "title": title, "from": from, "to": to, "text": card_text },
    }))
}

// ---------------------------------------------------------------------------
// Полировка ответа моделью (`withCourierReplyDraft`, `server/index.mjs`)
// ---------------------------------------------------------------------------

/// Запрос к социальному движку: письмо приходит в него репликой —
/// `npcSocialController.respond({ state, playerId, npcId, message, turnId })`.
pub struct CourierReplyRequest<'a> {
    pub state: &'a Value,
    pub player_id: String,
    pub npc_id: String,
    pub message: String,
    pub turn_id: String,
}

/// Социальный движок с моделью. Ответ — `{ reply, provider }`, как у JS;
/// ошибка провайдера — `Err`.
pub trait CourierReplyResponder {
    fn respond(&self, request: CourierReplyRequest<'_>) -> impl Future<Output = Result<Value, String>>;
}

/// Черновик ответа модели при отправке (`withCourierReplyDraft`). Модели нет
/// (`responder` — `None`), адресат — фракция или враг, модель молчит или
/// ошиблась — команда возвращается как есть, и в письмо ляжет основа.
pub async fn with_courier_reply_draft<R: CourierReplyResponder>(state: &Value, command: &Value, responder: Option<&R>) -> Value {
    let command_ref = Some(command);
    let Some(addressee) = courier_addressee_for(state, get(command_ref, "addressee_kind"), get(command_ref, "addressee_id"), None) else { return command.clone() };
    let Some(responder) = responder else { return command.clone() };
    if !is_str(addressee.get("kind"), "npc") {
        return command.clone();
    }
    let addressee_id = js::s(addressee.get("id"));
    let actor_id = js::string(get(command_ref, "actor_id"));
    let score = coalesce(lookup(lookup(get(get(Some(state), "social"), "relationships"), &addressee_id), &actor_id), Some(&json!(0))).cloned();
    let tone = courier_tone_for(score.as_ref());
    if tone == "silent" {
        return command.clone();
    }
    let body = js::string(get(command_ref, "body"));
    let promise = courier_letter_promise_from(get(command_ref, "body"));
    let message = match &promise {
        Some(promise) => format!("[письмо, доставлено курьером] {body} [в письме дано слово: {}]", js::s(promise.get("text"))),
        None => format!("[письмо, доставлено курьером] {body}"),
    };
    let request = CourierReplyRequest { state, player_id: actor_id, npc_id: addressee_id, message, turn_id: format!("letter:{}", js::s(get(command_ref, "command_id"))) };
    let Ok(result) = responder.respond(request).await else { return command.clone() };
    let provider = jstext::head(&js::s(get(Some(&result), "provider")), 80);
    let reply = jstext::head(&jstext::squash_spaces(&js::s(get(Some(&result), "reply"))), 1_000);
    if reply.is_empty() || provider == "deterministic-social-fallback" {
        return command.clone();
    }
    let mut next = spread(command_ref);
    next.insert("reply_draft".into(), string(reply));
    next.insert("reply_draft_tone".into(), string(tone));
    next.insert("reply_provider".into(), string(if provider.is_empty() { "llm".to_string() } else { provider }));
    Value::Object(next)
}

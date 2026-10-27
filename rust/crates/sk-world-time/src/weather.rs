//! Перенос `server/weather.mjs` — время суток и погода: мир идёт своим ходом.
//!
//! Ни времени суток, ни погоды в состоянии нет — они выводятся: час — из
//! `mechanics.world_time.elapsed_minutes`, погода — из сида кампании
//! (`worldMap.seed`), номера погодных суток (от рассвета к рассвету) и климата
//! края (`biome` региона карты мира). Кости здесь не бросаются: погода —
//! sha256 подписи и остаток от деления, как в JS. Под крышей (тема сцены по
//! `matchTheme`, а на смешанной карте — зона клетки героя) погода не действует.
//! Каждый эффект — помеха или преимущество, своей арифметики у погоды нет.
//!
//! Входы — рыхлый JSON состояния, как в JS. Аргументы, которые JS приводит
//! `Number(...)`, принимают всё, что реализует [`JsNum`] (`f64`, `i64`,
//! `&Value`, `Option<&Value>`); аргументы героя и навыка — `Option<&Value>`
//! (`None` — `undefined`), потому что `worldClockFor` различает их по `typeof`.

use serde_json::{json, Map, Value};
use sk_core::{hash, js, text};

pub const WEATHER_SCHEMA_VERSION: i64 = 1;
pub const WEATHER_POLICY_ID: &str = "skazanie:weather-and-time-v1";

/// Минут в сутках. Рассвет перезарядки предметов (`dawnCrossings`) — кратные
/// 1440 от начала кампании, то есть 08:00 по этим часам; погодные сутки
/// начинаются в 05:00 (`DAY_START_MINUTE`).
pub const MINUTES_PER_DAY: i64 = 1_440;

/// Который час на нулевой минуте кампании: восемь утра.
pub const CAMPAIGN_START_MINUTE_OF_DAY: i64 = 480;

/// Время суток и минута, с которой оно начинается.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DayPhase {
    pub id: &'static str,
    pub label: &'static str,
    pub start_minute: i64,
}

/// `DAY_PHASES`: ночь замыкает круг — от 22:00 до 05:00 следующих суток.
pub const DAY_PHASES: [DayPhase; 4] = [
    DayPhase { id: "morning", label: "Утро", start_minute: 300 },
    DayPhase { id: "day", label: "День", start_minute: 660 },
    DayPhase { id: "evening", label: "Вечер", start_minute: 1_020 },
    DayPhase { id: "night", label: "Ночь", start_minute: 1_320 },
];

/// Минута, с которой начинаются и утро, и новые погодные сутки.
pub const DAY_START_MINUTE: i64 = DAY_PHASES[0].start_minute;

pub const DAY_PHASE_IDS: [&str; 4] = ["morning", "day", "evening", "night"];

/// Погода: закрытый серверный список.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WeatherCondition {
    pub id: &'static str,
    pub label: &'static str,
    pub summary: &'static str,
}

pub const WEATHER_CONDITIONS: [WeatherCondition; 5] = [
    WeatherCondition { id: "clear", label: "Ясно", summary: "Небо чистое." },
    WeatherCondition { id: "overcast", label: "Пасмурно", summary: "Небо затянуто, но сухо." },
    WeatherCondition { id: "rain", label: "Дождь", summary: "Дождь заливает глаза и смывает следы." },
    WeatherCondition { id: "fog", label: "Туман", summary: "Туман скрадывает всё дальше десятка шагов." },
    WeatherCondition { id: "storm", label: "Гроза", summary: "Гроза глушит шаги и голоса." },
];

pub const WEATHER_CONDITION_IDS: [&str; 5] = ["clear", "overcast", "rain", "fog", "storm"];

/// Сумма весов каждой строки климата.
pub const WEATHER_TABLE_WEIGHT: i64 = 20;

/// `BIOME_WEATHER_WEIGHTS`: веса погоды по климату края, в порядке
/// [`WEATHER_CONDITION_IDS`]. Ключи — биомы карты мира
/// (`sk_geometry::world_map::BIOMES`).
pub const BIOME_WEATHER_WEIGHTS: [(&str, [i64; 5]); 8] = [
    ("plains", [8, 6, 4, 1, 1]),
    ("forest", [6, 6, 5, 2, 1]),
    ("mountains", [6, 5, 3, 4, 2]),
    ("marsh", [3, 5, 5, 6, 1]),
    ("desert", [14, 4, 1, 0, 1]),
    ("tundra", [6, 8, 3, 3, 0]),
    ("coast", [5, 5, 4, 4, 2]),
    ("wastes", [7, 7, 2, 2, 2]),
];

/// Край без известного климата — та же строка, что у равнины.
pub const DEFAULT_BIOME: &str = "plains";

/// Темы сцены под крышей (идентификаторы каталога тем).
pub const INDOOR_SCENE_THEMES: [&str; 5] = ["building", "temple", "crypt", "cave", "dungeon"];
/// Темы под открытым небом.
pub const OUTDOOR_SCENE_THEMES: [&str; 4] = ["forest", "road", "settlement", "graveyard"];
/// Виды сцены под крышей, когда тема карты не известна.
pub const INDOOR_SCENE_KINDS: [&str; 1] = ["dungeon"];
/// Темы под землёй: шапка говорит «под землёй», а не называет небо.
pub const UNDERGROUND_SCENE_THEMES: [&str; 3] = ["crypt", "cave", "dungeon"];

pub const TIME_OF_DAY_CHANGED_EVENT: &str = "TimeOfDayChanged";
pub const WEATHER_CHANGED_EVENT: &str = "WeatherChanged";
pub const WORLD_CLOCK_EVENT_TYPES: [&str; 2] = [TIME_OF_DAY_CHANGED_EVENT, WEATHER_CHANGED_EVENT];

const MAX_WORLD_MINUTE: i64 = 5_000_000;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

// ---------------------------------------------------------------------------
// Приведения JS
// ---------------------------------------------------------------------------

/// Значение, которое JS приводит `Number(value)`.
pub trait JsNum {
    fn js_number(&self) -> f64;
}

impl JsNum for f64 {
    fn js_number(&self) -> f64 {
        *self
    }
}

impl JsNum for i64 {
    fn js_number(&self) -> f64 {
        *self as f64
    }
}

impl JsNum for i32 {
    fn js_number(&self) -> f64 {
        f64::from(*self)
    }
}

impl JsNum for Value {
    fn js_number(&self) -> f64 {
        js::number(Some(self))
    }
}

impl JsNum for &Value {
    fn js_number(&self) -> f64 {
        js::number(Some(self))
    }
}

impl JsNum for Option<&Value> {
    fn js_number(&self) -> f64 {
        js::number(*self)
    }
}

fn is_safe_integer(number: f64) -> bool {
    number.is_finite() && number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER
}

/// `minutes(value)`: целое число минут в пределах `0…MAX_WORLD_MINUTE`, иначе 0.
fn minutes(value: impl JsNum) -> i64 {
    let number = value.js_number();
    if !is_safe_integer(number) {
        return 0;
    }
    (number as i64).clamp(0, MAX_WORLD_MINUTE)
}

/// Поле объекта (`value?.[key]` для объекта JSON; у прочих значений полей нет).
fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(Value::as_object).and_then(|object| object.get(key))
}

fn path<'a>(value: Option<&'a Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().try_fold(value?, |current, key| get(Some(current), key))
}

/// `text.slice(0, max)` по единицам UTF-16, как в JS. Половину суррогатной
/// пары строка Rust удержать не может — такой символ отбрасывается целиком.
pub(crate) fn slice_utf16(source: &str, max: usize) -> String {
    let mut units = 0;
    let mut result = String::new();
    for ch in source.chars() {
        units += ch.len_utf16();
        if units > max {
            break;
        }
        result.push(ch);
    }
    result
}

/// `text(value, max)`: `String(value ?? '')`, NFKC, пробелы схлопнуты, обрезка.
fn text_of(value: Option<&Value>, max: usize) -> String {
    slice_utf16(&text::squash_spaces(&text::nfkc(&js::s(value))), max)
}

/// `digest(...parts)`: sha256 от `String(part ?? '')`, склеенных `\0`.
fn digest(parts: &[String]) -> String {
    hash::sha256_hex(parts.join("\0"))
}

/// Ключи `Object.prototype`, которые `obj[key]` находит у любого объекта, и их
/// `String(...)`: функции печатаются исходником `[native code]`.
pub(crate) fn object_prototype_text(key: &str) -> Option<&'static str> {
    Some(match key {
        "constructor" => "function Object() { [native code] }",
        "__defineGetter__" => "function __defineGetter__() { [native code] }",
        "__defineSetter__" => "function __defineSetter__() { [native code] }",
        "hasOwnProperty" => "function hasOwnProperty() { [native code] }",
        "__lookupGetter__" => "function __lookupGetter__() { [native code] }",
        "__lookupSetter__" => "function __lookupSetter__() { [native code] }",
        "isPrototypeOf" => "function isPrototypeOf() { [native code] }",
        "propertyIsEnumerable" => "function propertyIsEnumerable() { [native code] }",
        "toString" => "function toString() { [native code] }",
        "valueOf" => "function valueOf() { [native code] }",
        "toLocaleString" => "function toLocaleString() { [native code] }",
        "__proto__" => "[object Object]",
        _ => return None,
    })
}

// ---------------------------------------------------------------------------
// Часы: минута кампании → сутки и время суток
// ---------------------------------------------------------------------------

/// `elapsedMinutesOf(state)`: минуты кампании из состояния.
pub fn elapsed_minutes_of(state: &Value) -> i64 {
    minutes(path(Some(state), &["mechanics", "world_time", "elapsed_minutes"]))
}

fn absolute_minute(elapsed: impl JsNum) -> i64 {
    CAMPAIGN_START_MINUTE_OF_DAY + minutes(elapsed)
}

/// `clockMinuteOf(elapsedMinutes)`: минута внутри суток, 0…1439.
pub fn clock_minute_of(elapsed: impl JsNum) -> i64 {
    absolute_minute(elapsed) % MINUTES_PER_DAY
}

/// `minutesUntilClock(elapsedMinutes, target)`: сколько минут ждать до
/// ближайшего наступления минуты суток `target`; 0 — наступила сейчас.
pub fn minutes_until_clock(elapsed: impl JsNum, target: impl JsNum) -> i64 {
    let raw = target.js_number();
    let number = if raw.is_nan() || raw == 0.0 { 0.0 } else { raw };
    let day = MINUTES_PER_DAY as f64;
    let target = ((number.trunc() % day) + day) % day;
    let wait = (target - clock_minute_of(elapsed) as f64 + day) % day;
    wait as i64
}

/// `clockLabelOf(elapsedMinutes)`: «18:20».
pub fn clock_label_of(elapsed: impl JsNum) -> String {
    let minute = clock_minute_of(elapsed);
    format!("{:02}:{:02}", minute / 60, minute % 60)
}

/// `campaignDayOf(elapsedMinutes)`: номер погодных суток с нуля.
pub fn campaign_day_of(elapsed: impl JsNum) -> i64 {
    (absolute_minute(elapsed) - DAY_START_MINUTE).div_euclid(MINUTES_PER_DAY)
}

/// `timeOfDayOf(elapsedMinutes)`: время суток на эту минуту.
pub fn time_of_day_of(elapsed: impl JsNum) -> &'static str {
    let minute = clock_minute_of(elapsed);
    if minute < DAY_START_MINUTE {
        return "night";
    }
    DAY_PHASES.iter().rev().find(|phase| minute >= phase.start_minute).map_or("night", |phase| phase.id)
}

/// `dayPhaseLabel(phaseId)`; `phase_id` — уже `String(phaseId)`.
pub fn day_phase_label(phase_id: &str) -> &'static str {
    DAY_PHASES.iter().find(|phase| phase.id == phase_id).map_or("", |phase| phase.label)
}

/// `weatherConditionLabel(conditionId)`; `condition_id` — уже `String(…)`.
pub fn weather_condition_label(condition_id: &str) -> &'static str {
    WEATHER_CONDITIONS.iter().find(|condition| condition.id == condition_id).map_or("", |condition| condition.label)
}

/// `weatherConditionSummary(conditionId)`; `condition_id` — уже `String(…)`.
pub fn weather_condition_summary(condition_id: &str) -> &'static str {
    WEATHER_CONDITIONS.iter().find(|condition| condition.id == condition_id).map_or("", |condition| condition.summary)
}

// ---------------------------------------------------------------------------
// Погода: сид кампании + день + климат края
// ---------------------------------------------------------------------------

/// `currentRegionOf(state)`: край, в котором лежит текущее место отряда.
pub fn current_region_of(state: &Value) -> Option<&Value> {
    let map = get(Some(state), "worldMap");
    let node = sk_geometry::world_map::world_location_by_id(map, &text_of(get(map, "currentLocationId"), 120));
    let region_id = text_of(get(node, "regionId"), 120);
    if region_id.is_empty() {
        return None;
    }
    get(map, "regions")
        .and_then(Value::as_array)?
        .iter()
        .find(|region| text_of(get(Some(region), "id"), 120) == region_id)
}

fn biome_row(biome: &str) -> Option<&'static [i64; 5]> {
    BIOME_WEATHER_WEIGHTS.iter().find(|(id, _)| *id == biome).map(|(_, row)| row)
}

/// `currentBiomeOf(state)`: климат края; неизвестный — равнина.
pub fn current_biome_of(state: &Value) -> &'static str {
    let biome = text_of(get(current_region_of(state), "biome"), 40);
    BIOME_WEATHER_WEIGHTS.iter().find(|(id, _)| *id == biome).map_or(DEFAULT_BIOME, |(id, _)| id)
}

/// `weatherOnDay({ seed, day, biome })`: погода одного дня, чистая функция.
///
/// `day` приводится `Math.trunc(Number(day) || 0)`. Ключ прототипа вместо
/// климата (`constructor`, `__proto__`) в JS находит не строку таблицы, а
/// функцию или прототип — таблица выходит пустой, и день всегда ясный.
pub fn weather_on_day(seed: &str, day: impl JsNum, biome: &str) -> &'static str {
    let weights = match biome_row(biome) {
        Some(row) => row,
        None if object_prototype_text(biome).is_some() => return "clear",
        None => biome_row(DEFAULT_BIOME).unwrap_or(&[0; 5]),
    };
    let total: i64 = weights.iter().map(|weight| (*weight).max(0)).sum();
    if total <= 0 {
        return "clear";
    }
    let raw = day.js_number();
    let day = if raw.is_nan() || raw == 0.0 { 0.0 } else { raw.trunc() };
    let hex = digest(&[seed.to_string(), "weather".into(), js::f64_string(day), biome.to_string()]);
    let roll = u64::from_str_radix(&hex[..8], 16).unwrap_or(0);
    let mut index = (roll % total as u64) as i64;
    for (id, weight) in WEATHER_CONDITION_IDS.iter().zip(weights) {
        let weight = (*weight).max(0);
        if index < weight {
            return id;
        }
        index -= weight;
    }
    "clear"
}

/// `campaignSeedOf(state)`: сид карты мира, иначе код сессии.
pub fn campaign_seed_of(state: &Value) -> String {
    let seed = text_of(path(Some(state), &["worldMap", "seed"]), 120);
    if seed.is_empty() {
        text_of(get(Some(state), "sessionCode"), 120)
    } else {
        seed
    }
}

/// `pinnedWeatherOn(state, day)`: небо, закреплённое за погодными сутками
/// (`mechanics.weather_pins`), или пустая строка.
pub fn pinned_weather_on(state: &Value, day: impl JsNum) -> &'static str {
    let Some(pins) = path(Some(state), &["mechanics", "weather_pins"]).and_then(Value::as_array) else {
        return "";
    };
    let day = day.js_number().trunc();
    for entry in pins {
        // `Number.isSafeInteger(entry?.day)` — без приведения: только число.
        let Some(entry_day) = get(Some(entry), "day").and_then(Value::as_f64) else {
            continue;
        };
        if !is_safe_integer(entry_day) || entry_day != day {
            continue;
        }
        let weather = js::string(get(Some(entry), "weather"));
        if let Some(id) = WEATHER_CONDITION_IDS.iter().find(|id| **id == weather) {
            return id;
        }
    }
    ""
}

/// `weatherOf(state)`: погода на текущую минуту кампании.
pub fn weather_of(state: &Value) -> &'static str {
    weather_at(state, elapsed_minutes_of(state))
}

/// `weatherOf(state, elapsedMinutes)`: погода на заданную минуту.
pub fn weather_at(state: &Value, elapsed: impl JsNum) -> &'static str {
    let day = campaign_day_of(elapsed);
    let pinned = pinned_weather_on(state, day);
    if !pinned.is_empty() {
        return pinned;
    }
    weather_on_day(&campaign_seed_of(state), day, current_biome_of(state))
}

// ---------------------------------------------------------------------------
// Под небом или под крышей
// ---------------------------------------------------------------------------

fn scene_theme_id_of(scene: Option<&Value>) -> String {
    let stored = text_of(path(scene, &["map", "theme"]), 60);
    if INDOOR_SCENE_THEMES.contains(&stored.as_str()) || OUTDOOR_SCENE_THEMES.contains(&stored.as_str()) {
        return stored;
    }
    let input = json!({
        "location": text_of(get(scene, "location"), 120),
        "theme": text_of(get(scene, "theme"), 120),
        "sceneKind": text_of(get(scene, "scene_kind"), 40),
    });
    sk_themes::scene_themes::match_theme(&input).map_or_else(String::new, |theme| theme.id.to_string())
}

/// `isIndoorScene(scene)`: стоит ли сцена под крышей — по опознанной теме, а
/// без темы — по виду сцены.
pub fn is_indoor_scene(scene: &Value) -> bool {
    let theme = scene_theme_id_of(Some(scene));
    if INDOOR_SCENE_THEMES.contains(&theme.as_str()) {
        return true;
    }
    if OUTDOOR_SCENE_THEMES.contains(&theme.as_str()) {
        return false;
    }
    INDOOR_SCENE_KINDS.contains(&text_of(get(Some(scene), "scene_kind"), 40).as_str())
}

/// `obj[key]` для объекта или массива (индекс массива — строкой).
fn prop<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match value? {
        Value::Object(object) => object.get(key),
        Value::Array(items) if js::is_array_index_key(key) => key.parse::<usize>().ok().and_then(|index| items.get(index)),
        _ => None,
    }
}

/// `x ?? y` для полей: отсутствующее и `null` уступают.
fn nullish_or<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    match first {
        None | Some(Value::Null) => second,
        some => some,
    }
}

fn actor_id_text(value: Option<&Value>) -> String {
    text::trim(&js::s(value)).to_string()
}

fn actor_position_for_weather(state: &Value, actor_id: Option<&Value>) -> Option<(i64, i64)> {
    let id = actor_id_text(actor_id);
    if id.is_empty() {
        return None;
    }
    let stored = prop(path(Some(state), &["mechanics", "positions"]), &id);
    let actor = ["players", "actors", "enemies"]
        .iter()
        .filter_map(|key| get(Some(state), key).and_then(Value::as_array))
        .flatten()
        .find(|candidate| js::s(nullish_or(get(Some(candidate), "id"), get(Some(candidate), "actor_id"))) == id);
    let x = js::number(nullish_or(get(stored, "x"), get(actor, "x")));
    let y = js::number(nullish_or(get(stored, "y"), get(actor, "y")));
    (is_safe_integer(x) && is_safe_integer(y)).then_some((x as i64, y as i64))
}

fn default_weather_actor_id(state: &Value) -> Option<String> {
    let active = actor_id_text(get(Some(state), "activePlayerId"));
    if !active.is_empty() {
        return Some(active);
    }
    let first_player = get(Some(state), "players").and_then(Value::as_array).and_then(|players| players.first());
    let first = actor_id_text(nullish_or(get(first_player, "id"), get(first_player, "actor_id")));
    (!first.is_empty()).then_some(first)
}

/// `resolvedWeatherActorId`: явный герой, иначе активный, иначе первый игрок.
fn resolved_weather_actor_id(state: &Value, actor_id: Option<&Value>) -> Option<Value> {
    let explicit = actor_id_text(actor_id);
    if !explicit.is_empty() {
        return Some(Value::String(explicit));
    }
    default_weather_actor_id(state).map(Value::String)
}

/// `richMapIndoorFor`: крыша по зоне клетки героя на богатой карте сцены;
/// `None` — карта старая, повреждённая или зона не говорит ничего.
fn rich_map_indoor_for(state: &Value, actor_id: Option<&Value>) -> Option<bool> {
    let (x, y) = actor_position_for_weather(state, actor_id)?;
    let raw = path(Some(state), &["scene", "map"])?;
    if !(raw.is_object() || raw.is_array()) {
        return None;
    }
    if !get(Some(raw), "zones").is_some_and(Value::is_array) || !js::truthy(get(Some(raw), "layers")) {
        return None;
    }
    let map = sk_tactical::tactical_map::deserialize_tactical_map(raw).ok()?;
    let cell = sk_tactical::tactical_map::cell_at(&map, x, y)?;
    let zone = map.zones.iter().find(|candidate| candidate.id == cell.zone)?;
    match zone.kind.as_str() {
        "interior" => Some(true),
        "exterior" => Some(false),
        _ => None,
    }
}

/// `isIndoors(state, actorId)`: крыша над героем — зона его клетки на богатой
/// карте, иначе сцена целиком. Героя по умолчанию здесь не подставляют.
pub fn is_indoors(state: &Value, actor_id: Option<&Value>) -> bool {
    if let Some(indoor) = rich_map_indoor_for(state, actor_id) {
        return indoor;
    }
    // `state?.scene ?? {}`: у `null` и у пустого объекта полей одинаково нет.
    is_indoor_scene(get(Some(state), "scene").unwrap_or(&Value::Null))
}

// ---------------------------------------------------------------------------
// Влияние на игру
// ---------------------------------------------------------------------------

/// Строка таблицы влияния неба: одна помеха или одно преимущество.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WeatherEffect {
    pub id: &'static str,
    /// Время суток; `None` — любое.
    pub phase: Option<&'static str>,
    /// Погода; `None` — любая.
    pub weather: Option<&'static str>,
    /// Навыки, чью проверку трогает строка (пусто — `skills` в JS нет).
    pub skills: &'static [&'static str],
    /// Дальние атаки оружием.
    pub ranged: bool,
    pub swing: &'static str,
    pub reason: &'static str,
    pub label: &'static str,
}

pub const WEATHER_EFFECTS: [WeatherEffect; 4] = [
    WeatherEffect {
        id: "rain-perception",
        phase: None,
        weather: Some("rain"),
        skills: &["perception", "survival"],
        ranged: false,
        swing: "disadvantage",
        reason: "дождь",
        label: "Дождь: помеха Восприятию и Выживанию",
    },
    WeatherEffect {
        id: "fog-ranged",
        phase: None,
        weather: Some("fog"),
        skills: &[],
        ranged: true,
        swing: "disadvantage",
        reason: "туман",
        label: "Туман: помеха дальним атакам",
    },
    WeatherEffect {
        id: "storm-stealth",
        phase: None,
        weather: Some("storm"),
        skills: &["stealth"],
        ranged: false,
        swing: "advantage",
        reason: "гроза",
        label: "Гроза: преимущество на Скрытность",
    },
    WeatherEffect {
        id: "night-perception",
        phase: Some("night"),
        weather: None,
        skills: &["perception"],
        ranged: false,
        swing: "disadvantage",
        reason: "ночь",
        label: "Ночь: помеха Восприятию",
    },
];

pub const WEATHER_EFFECT_IDS: [&str; 4] = ["rain-perception", "fog-ranged", "storm-stealth", "night-perception"];

/// Навыки, которым небо что-то меняет (выводится из таблицы, порядок вставки).
pub const WEATHER_AFFECTED_SKILLS: [&str; 3] = ["perception", "survival", "stealth"];

/// `weatherEffectsUnder({ indoors, phase, weather })`: что действует при
/// таком небе. Под крышей — ничего.
pub fn weather_effects_under(indoors: bool, phase: &str, weather: &str) -> Vec<&'static WeatherEffect> {
    if indoors {
        return Vec::new();
    }
    WEATHER_EFFECTS
        .iter()
        .filter(|effect| effect.phase.is_none_or(|value| value == phase) && effect.weather.is_none_or(|value| value == weather))
        .collect()
}

fn active_effects(state: &Value, actor_id: Option<&Value>) -> Vec<&'static WeatherEffect> {
    let elapsed = elapsed_minutes_of(state);
    weather_effects_under(is_indoors(state, actor_id), time_of_day_of(elapsed), weather_at(state, elapsed))
}

/// `weatherEffectLabels(state, actorId)`: подписи действующих эффектов для
/// героя (по умолчанию — активного или первого).
pub fn weather_effect_labels(state: &Value, actor_id: Option<&Value>) -> Vec<&'static str> {
    let resolved = resolved_weather_actor_id(state, actor_id);
    active_effects(state, resolved.as_ref()).into_iter().map(|effect| effect.label).collect()
}

/// `weatherCheckSwing(state, skill, actorId)`: `{ swing, reason, effect_id }`
/// либо `None`, когда небо в проверке не участвует. Без героя — активный
/// (`resolvedWeatherActorId`), как у шапки `worldClockFor`.
pub fn weather_check_swing(state: &Value, skill: Option<&Value>, actor_id: Option<&Value>) -> Option<Value> {
    let id = text::lower(text::trim(&js::s(skill))).replace('_', "-");
    if !WEATHER_AFFECTED_SKILLS.contains(&id.as_str()) {
        return None;
    }
    let resolved = resolved_weather_actor_id(state, actor_id);
    let effect = active_effects(state, resolved.as_ref()).into_iter().find(|candidate| candidate.skills.contains(&id.as_str()))?;
    Some(json!({ "swing": effect.swing, "reason": effect.reason, "effect_id": effect.id }))
}

/// `weatherRangedPenalty(state, actorId)`: `{ reason, effect_id }` либо `None`;
/// без героя — активный, как у шапки.
pub fn weather_ranged_penalty(state: &Value, actor_id: Option<&Value>) -> Option<Value> {
    let resolved = resolved_weather_actor_id(state, actor_id);
    let effect = active_effects(state, resolved.as_ref()).into_iter().find(|candidate| candidate.ranged)?;
    Some(json!({ "reason": effect.reason, "effect_id": effect.id }))
}

// ---------------------------------------------------------------------------
// Сводка
// ---------------------------------------------------------------------------

/// `worldClockFor(state, elapsedMinutesOrActorId, actorId)`: полный вывод
/// мировых часов. Второй аргумент — число (минуты) или строка (герой), как
/// `typeof` в JS; иначе минуты берутся из состояния, а герой — третьим.
pub fn world_clock_for(state: &Value, elapsed_or_actor: Option<&Value>, actor_id: Option<&Value>) -> Value {
    let elapsed = match elapsed_or_actor {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        _ => elapsed_minutes_of(state) as f64,
    };
    let actor = match elapsed_or_actor {
        Some(Value::String(_)) => elapsed_or_actor,
        _ => actor_id,
    };
    let phase = time_of_day_of(elapsed);
    let weather = weather_at(state, elapsed);
    let resolved = resolved_weather_actor_id(state, actor);
    let indoors = is_indoors(state, resolved.as_ref());
    let underground = indoors && UNDERGROUND_SCENE_THEMES.contains(&scene_theme_id_of(get(Some(state), "scene").filter(|scene| !scene.is_null())).as_str());
    let phase_label = day_phase_label(phase);
    let weather_label = weather_condition_label(weather);
    let effects: Vec<&str> = weather_effects_under(indoors, phase, weather).into_iter().map(|effect| effect.label).collect();
    json!({
        "schema_version": WEATHER_SCHEMA_VERSION,
        "policy_id": WEATHER_POLICY_ID,
        "day": campaign_day_of(elapsed) + 1,
        "clock": clock_label_of(elapsed),
        "phase": phase,
        "phase_label": phase_label,
        "weather": weather,
        "weather_label": weather_label,
        "weather_summary": if underground { "Под землёй неба не видно." } else { weather_condition_summary(weather) },
        "biome": current_biome_of(state),
        "region_name": text_of(get(current_region_of(state), "name"), 120),
        "indoors": indoors,
        "underground": underground,
        "indicator": if underground { format!("{phase_label} · под землёй") } else { format!("{phase_label} · {weather_label}") },
        "effects": effects,
    })
}

/// `weatherForViewer(state, actorId)`: то же для проекции игроку. Число вместо
/// героя JS читает как минуты (см. «Замечено в JS» отчёта).
pub fn weather_for_viewer(state: &Value, actor_id: Option<&Value>) -> Value {
    world_clock_for(state, actor_id, None)
}

/// `worldClockForAgents(state, actorId)`: данные для Рассказчика и Режиссёра.
pub fn world_clock_for_agents(state: &Value, actor_id: Option<&Value>) -> Value {
    let clock = world_clock_for(state, actor_id, None);
    let field = |key: &str| clock.get(key).cloned().unwrap_or(Value::Null);
    json!({
        "day": field("day"),
        "clock": field("clock"),
        "time_of_day": field("phase"),
        "time_of_day_label": field("phase_label"),
        "weather": field("weather"),
        "weather_label": field("weather_label"),
        "weather_summary": field("weather_summary"),
        "indoors": field("indoors"),
        "underground": field("underground"),
        "effects": field("effects"),
    })
}

// ---------------------------------------------------------------------------
// События смены
// ---------------------------------------------------------------------------

/// `worldClockEventDrafts(state, advancedMinutes)`: черновики `TimeOfDayChanged`
/// и `WeatherChanged`, когда шаг времени пересёк границу.
pub fn world_clock_event_drafts(state: &Value, advanced: impl JsNum) -> Vec<Value> {
    let advanced = minutes(advanced);
    if advanced <= 0 {
        return Vec::new();
    }
    let before = elapsed_minutes_of(state);
    let after = before + advanced;
    let mut drafts = Vec::new();

    let phase_before = time_of_day_of(before);
    let phase_after = time_of_day_of(after);
    if phase_before != phase_after {
        drafts.push(json!({
            "event_type": TIME_OF_DAY_CHANGED_EVENT,
            "visibility": "party",
            "payload": {
                "schema_version": WEATHER_SCHEMA_VERSION,
                "policy_id": WEATHER_POLICY_ID,
                "phase_before": phase_before,
                "phase_after": phase_after,
                "phase_label": day_phase_label(phase_after),
                "clock": clock_label_of(after),
                "day": campaign_day_of(after) + 1,
                "at_minutes": after,
            },
        }));
    }

    let day_before = campaign_day_of(before);
    let day_after = campaign_day_of(after);
    let weather_before = weather_at(state, before);
    let weather_after = weather_at(state, after);
    if day_before != day_after && weather_before != weather_after {
        drafts.push(json!({
            "event_type": WEATHER_CHANGED_EVENT,
            "visibility": "party",
            "payload": {
                "schema_version": WEATHER_SCHEMA_VERSION,
                "policy_id": WEATHER_POLICY_ID,
                "weather_before": weather_before,
                "weather_after": weather_after,
                "weather_label": weather_condition_label(weather_after),
                "biome": current_biome_of(state),
                "region_name": text_of(get(current_region_of(state), "name"), 120),
                "reason": "day",
                "day": day_after + 1,
                "at_minutes": after,
            },
        }));
    }
    drafts
}

/// `regionWeatherEventDraft(before, after)`: смена неба от перехода в другой
/// край; `None`, когда небо то же.
pub fn region_weather_event_draft(before: &Value, after: &Value) -> Option<Value> {
    let weather_before = weather_of(before);
    let weather_after = weather_of(after);
    if weather_before == weather_after {
        return None;
    }
    let elapsed_after = elapsed_minutes_of(after);
    Some(json!({
        "event_type": WEATHER_CHANGED_EVENT,
        "visibility": "party",
        "payload": {
            "schema_version": WEATHER_SCHEMA_VERSION,
            "policy_id": WEATHER_POLICY_ID,
            "weather_before": weather_before,
            "weather_after": weather_after,
            "weather_label": weather_condition_label(weather_after),
            "biome": current_biome_of(after),
            "region_name": text_of(get(current_region_of(after), "name"), 120),
            "region_before": text_of(get(current_region_of(before), "name"), 120),
            "reason": "region",
            "day": campaign_day_of(elapsed_after) + 1,
            "at_minutes": elapsed_after,
        },
    }))
}

const PHASE_ARRIVAL_LINES: [(&str, &str); 4] = [
    ("morning", "Светает: над отрядом занимается утро."),
    ("day", "Солнце поднимается — наступил день."),
    ("evening", "Свет уходит, ложатся длинные тени: наступил вечер."),
    ("night", "Темнеет окончательно — наступила ночь."),
];

const WEATHER_ARRIVAL_LINES: [(&str, &str); 5] = [
    ("clear", "Небо расчистилось."),
    ("overcast", "Небо затянуло сплошной пеленой."),
    ("rain", "Зарядил дождь."),
    ("fog", "С низин поднялся туман."),
    ("storm", "Собралась гроза."),
];

/// `TABLE[key] ?? ''` над замороженным объектом JS: ключ прототипа находит
/// функцию (её текст — `[native code]`).
fn line_of(table: &[(&str, &'static str)], key: &str) -> &'static str {
    table.iter().find(|(id, _)| *id == key).map(|(_, line)| *line).or_else(|| object_prototype_text(key)).unwrap_or("")
}

/// `worldClockNarration(event)`: строка летописи про смену времени суток или
/// неба; чужое событие — пустая строка.
pub fn world_clock_narration(event: &Value) -> String {
    let kind = js::s(get(Some(event), "event_type"));
    let empty = Value::Object(Map::new());
    let payload = match get(Some(event), "payload") {
        None | Some(Value::Null) => &empty,
        Some(payload) => payload,
    };
    if kind == TIME_OF_DAY_CHANGED_EVENT {
        return line_of(&PHASE_ARRIVAL_LINES, &js::string(get(Some(payload), "phase_after"))).to_string();
    }
    if kind == WEATHER_CHANGED_EVENT {
        let after = js::string(get(Some(payload), "weather_after"));
        let line = line_of(&WEATHER_ARRIVAL_LINES, &after);
        let summary = weather_condition_summary(&after);
        let prefix = if js::string(get(Some(payload), "reason")) == "region" { "За краем — другое небо." } else { "" };
        return [prefix, line, summary].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ");
    }
    String::new()
}

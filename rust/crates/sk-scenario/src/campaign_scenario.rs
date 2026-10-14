//! Перенос `server/campaign-scenario.mjs`: сценарий авторской кампании —
//! сюжет, который движок исполняет без модели.
//!
//! Данные — `data/campaign-scenarios-v1.json`, сюжет для людей —
//! `docs/astohan-scenario.md`. Сценарий состоит из двух частей:
//!
//! - **карточки мест** — заголовок, настроение, цель, приход и тайны сцены.
//!   Переход сцены (`AdvanceScene`) накладывает карточку на аргументы перехода,
//!   какой бы путь его ни породил. Тайны получают стабильные id, поэтому
//!   находку можно узнать по факту;
//! - **узлы сюжета** — пролог, глава, линии и финал. Их состояние не хранится
//!   отдельно, а выводится из состояния кампании: посещённых мест, находок,
//!   павших NPC и исхода боя с главным противником. Поэтому replay сходится
//!   без новых типов событий, а сохранённые кампании без сценария не меняются.
//!
//! Модуль — лист графа: он читает состояние, но не зависит ни от движка
//! правил, ни от политики Режиссёра. Поля каталога, которые JS копирует как
//! есть (`id`, `title`, `kind`), в каталоге — строки и читаются как строки.

use std::collections::HashSet;
use std::sync::LazyLock;

use serde::Serialize;
use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexSet;
use sk_core::{js, re, text};

use crate::util::{array, head, is_str, js_len, spread_copy, squash, strict_eq, string_of, utf16_cmp};

pub const SCENARIO_ARC_VERSION: &str = "skazanie:scenario-arc-v1";
pub const SCENARIO_ARC_PRESET: &str = "scenario";
const SCENARIO_SCHEMA_VERSION: f64 = 1.0;
const SCENARIO_CATALOG: &str = include_str!("../../../../data/campaign-scenarios-v1.json");

const BEAT_KINDS: [&str; 4] = ["prologue", "chapter", "line", "finale"];
const SECRET_SKILLS: [&str; 9] = ["investigation", "perception", "survival", "insight", "history", "arcana", "religion", "nature", "medicine"];
const ENCOUNTER_THEMES: [&str; 13] = [
    "goblinoids", "undead", "beasts", "raiders", "warband", "law", "vermin", "ambush", "crypt", "cave", "wilderness", "cult", "generic",
];
const ENCOUNTER_DIFFICULTIES: [&str; 4] = ["easy", "medium", "hard", "deadly"];
const SAVE_ABILITIES: [&str; 6] = ["str", "dex", "con", "int", "wis", "cha"];
const SOCIAL_SKILLS: [&str; 4] = ["persuasion", "intimidation", "deception", "insight"];
const DAMAGE_TYPES: [&str; 10] = ["fire", "cold", "acid", "lightning", "poison", "thunder", "necrotic", "radiant", "force", "psychic"];
const RELEASE_SKILLS: [&str; 6] = ["persuasion", "religion", "insight", "intimidation", "deception", "history"];

fn id_pattern(text: &str) -> bool {
    text::test(re!(r"^[a-z0-9][a-z0-9-]{1,79}$", "u"), text)
}

/// Id предмета каталога сценария (`SCENARIO_ITEM_CATALOG`, `server/item-catalog.mjs`).
fn scenario_item_id(text: &str) -> bool {
    text::test(re!(r"^scenario_[a-z0-9_]+:[a-z0-9]+(?:-[a-z0-9]+)*$", "u"), text)
}

/// `String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maximum)`.
fn clean(value: Option<&Value>, maximum: usize) -> String {
    head(&squash(&js::s(value)), maximum)
}

/// Длина очищенной строки в единицах UTF-16, как `.length` в JS.
fn clean_len(value: Option<&Value>, maximum: usize) -> usize {
    js_len(&clean(value, maximum))
}

fn invalid<T>(message: impl AsRef<str>) -> Result<T, String> {
    Err(format!("Сценарий кампании: {}", message.as_ref()))
}

/// `Set.has(value)` для набора строк: строгое равенство, только строки.
fn in_list(value: Option<&Value>, list: &[&str]) -> bool {
    value.and_then(Value::as_str).is_some_and(|text| list.contains(&text))
}

fn in_set(value: Option<&Value>, set: &HashSet<String>) -> bool {
    value.and_then(Value::as_str).is_some_and(|text| set.contains(text))
}

/// `Number.isSafeInteger(value)` без приведения.
fn safe_int(value: Option<&Value>) -> bool {
    js::is_safe_integer(value)
}

fn num(value: Option<&Value>) -> f64 {
    js::number(value)
}

/// `Number.isSafeInteger(v) && lo <= v && v <= hi`.
fn safe_int_in(value: Option<&Value>, low: f64, high: f64) -> bool {
    safe_int(value) && num(value) >= low && num(value) <= high
}

/// Поле `x?.key` для любого значения JSON.
fn field<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|value| value.get(key))
}

/// `a ?? b`.
fn nullish<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    match first {
        None | Some(Value::Null) => second,
        some => some,
    }
}

/// Строка-значение строчная: `stem === stem.toLocaleLowerCase('ru')`.
fn lowercase_stem(stem: &Value, minimum: usize) -> bool {
    match stem {
        Value::String(text) => js_len(text) >= minimum && *text == text::lower(text),
        _ => false,
    }
}

/// Условие завершения узла. Листья: `clue` — найдена тайна сценария, `left` —
/// отряд побывал в месте и ушёл из него, `visited` — побывал, `npc_defeated` —
/// NPC выбыл. Составные: `any`, `all`, `count` + `of`.
fn validate_condition(condition: Option<&Value>, location: &str, clue_ids: &HashSet<String>) -> Result<(), String> {
    let Some(Value::Object(map)) = condition else {
        return invalid(format!("{location}: условие должно быть объектом"));
    };
    let keys = js::keys(map);
    let has = |key: &str| keys.iter().any(|entry| entry.as_str() == key);
    if has("any") || has("all") {
        let list = nullish(map.get("any"), map.get("all"));
        let entries = match list {
            Some(Value::Array(items)) if !items.is_empty() => items,
            _ => return invalid(format!("{location}: пустой список условий")),
        };
        for (index, entry) in entries.iter().enumerate() {
            validate_condition(Some(entry), &format!("{location}[{index}]"), clue_ids)?;
        }
        return Ok(());
    }
    if has("count") {
        let count = map.get("count");
        let of = map.get("of").and_then(Value::as_array);
        if !safe_int(count) || num(count) < 1.0 || of.is_none_or(|of| (of.len() as f64) < num(count)) {
            return invalid(format!("{location}: count должен быть не больше длины of"));
        }
        for (index, entry) in of.into_iter().flatten().enumerate() {
            validate_condition(Some(entry), &format!("{location}.of[{index}]"), clue_ids)?;
        }
        return Ok(());
    }
    if keys.len() != 1 {
        return invalid(format!("{location}: лист условия — ровно одно поле"));
    }
    let key = keys[0].as_str();
    if key == "clue" {
        if !in_set(map.get("clue"), clue_ids) {
            return invalid(format!("{location}: неизвестная тайна {}", string_of(map.get("clue"))));
        }
        return Ok(());
    }
    if ["left", "visited", "npc_defeated"].contains(&key) {
        if !id_pattern(&js::s(map.get(key))) {
            return invalid(format!("{location}: {key} — идентификатор"));
        }
        return Ok(());
    }
    invalid(format!("{location}: неизвестное условие {key}"))
}

/// Проклятый рыцарь (`server/scenario-knight.mjs`): кто, где и окно ночи, в
/// которое он появляется, — минуты суток по часам мира, окно может переходить
/// через полночь.
fn validate_knight(knight: &Value, scenario_id: &str, location_ids: &HashSet<String>) -> Result<(), String> {
    let place = format!("{scenario_id}/knight");
    let knight = Some(knight);
    if !id_pattern(&js::s(field(knight, "npc_id"))) || !in_set(field(knight, "location_id"), location_ids) {
        return invalid(format!("{place}: рыцарю нужны id и место-карточка"));
    }
    let night = nullish(field(knight, "night"), None);
    let (from, to) = (field(night, "from_minute"), field(night, "to_minute"));
    if ![from, to].iter().all(|value| safe_int(*value) && num(*value) >= 0.0 && num(*value) < 1_440.0) || strict_eq(from, to) {
        return invalid(format!("{place}: окно ночи — две разные минуты суток 0–1439"));
    }
    for name in ["arrival_text", "departure_text", "ward_laugh_text", "head_text"] {
        if clean_len(field(knight, name), 1_000) < 40 {
            return invalid(format!("{place}: текст {name}"));
        }
    }
    if !id_pattern(&js::s(field(knight, "riddle_clue"))) {
        return invalid(format!("{place}: загадке нужна тайна-разгадка"));
    }
    if !safe_int_in(field(knight, "head_reach_feet"), 5.0, 60.0) {
        return invalid(format!("{place}: досягаемость головы 5–60 футов"));
    }
    match field(knight, "ward_resist_except") {
        Some(Value::Array(types)) if types.iter().all(|kind| in_list(Some(kind), &DAMAGE_TYPES)) => {}
        _ => return invalid(format!("{place}: исключения сопротивления — виды урона")),
    }
    let dread = field(knight, "dread");
    if !in_list(field(dread, "ability"), &SAVE_ABILITIES)
        || !safe_int_in(field(dread, "dc"), 5.0, 30.0)
        || !safe_int_in(field(dread, "radius_feet"), 5.0, 120.0)
    {
        return invalid(format!("{place}: аура страха — спасбросок, СЛ 5–30 и радиус 5–120 футов"));
    }
    let release = field(knight, "release");
    let skills_ok = match field(release, "skills") {
        Some(Value::Array(skills)) => !skills.is_empty() && skills.iter().all(|skill| in_list(Some(skill), &RELEASE_SKILLS)),
        _ => false,
    };
    if !safe_int_in(field(release, "dc"), 5.0, 30.0)
        || !skills_ok
        || !scenario_item_id(&js::s(field(field(release, "reward"), "catalog_id")))
        || clean_len(field(release, "success_text"), 1_000) < 40
        || clean_len(field(release, "failure_text"), 1_000) < 20
    {
        return invalid(format!("{place}: мирному пути нужны СЛ, навыки, награда и тексты"));
    }
    Ok(())
}

/// Счётчик внимания главного противника (`server/scenario-attention.mjs`):
/// пороги, места, где за отрядом следят, основы слов темы и незнакомец, который
/// приходит на пороге `stranger_at`.
fn validate_attention(attention: &Value, scenario_id: &str, location_ids: &HashSet<String>) -> Result<(), String> {
    let place = format!("{scenario_id}/attention");
    let attention = Some(attention);
    let (maximum, stranger_at, ready_at) = (field(attention, "maximum"), field(attention, "stranger_at"), field(attention, "ready_at"));
    if ![maximum, stranger_at, ready_at].iter().all(|value| safe_int(*value) && num(*value) > 0.0)
        || num(stranger_at) >= num(ready_at)
        || num(ready_at) > num(maximum)
    {
        return invalid(format!("{place}: пороги 0 < stranger_at < ready_at ≤ maximum"));
    }
    let watched = array(field(attention, "watched_location_ids"));
    if watched.is_empty() || watched.iter().any(|id| !in_set(Some(id), location_ids)) {
        return invalid(format!("{place}: места наблюдения должны быть карточками"));
    }
    let stems = array(field(attention, "topic_stems"));
    if stems.is_empty() || stems.iter().any(|stem| !lowercase_stem(stem, 4)) {
        return invalid(format!("{place}: основы темы — строчные, не короче четырёх букв"));
    }
    let finale = field(attention, "finale");
    let unaware = field(finale, "unaware_below");
    if !js::truthy(finale) || !safe_int(unaware) || num(unaware) < 1.0 || num(unaware) > num(ready_at) {
        return invalid(format!("{place}: финалу нужен порог неведения не выше ready_at"));
    }
    match field(finale, "hidden_route") {
        Some(Value::Array(route)) if route.len() == 2 && route.iter().all(|id| in_set(Some(id), location_ids)) => {}
        _ => return invalid(format!("{place}: тайная дорога финала — пара мест сценария")),
    }
    let ambush = field(finale, "ready_ambush");
    if !in_list(field(ambush, "theme"), &ENCOUNTER_THEMES) || !in_list(field(ambush, "difficulty"), &ENCOUNTER_DIFFICULTIES) {
        return invalid(format!("{place}: засада готового дракона — тема и сложность сборщика"));
    }
    let stranger = field(attention, "stranger");
    if !js::truthy(stranger)
        || !id_pattern(&js::s(field(stranger, "npc_id")))
        || clean(field(stranger, "name"), 120).is_empty()
        || clean(field(stranger, "role"), 80).is_empty()
        || clean(field(stranger, "summary"), 400).is_empty()
        || clean(field(stranger, "voice"), 240).is_empty()
    {
        return invalid(format!("{place}: незнакомцу нужны id, имя, роль, облик и голос"));
    }
    let places = array(field(stranger, "location_ids"));
    if places.is_empty() || places.iter().any(|id| !in_set(Some(id), location_ids)) {
        return invalid(format!("{place}: места незнакомца должны быть карточками"));
    }
    if array(field(stranger, "goals")).is_empty() {
        return invalid(format!("{place}: цели незнакомца"));
    }
    for name in ["arrival_text", "reveal_text", "departure_text"] {
        if clean_len(field(stranger, name), 1_000) < 40 {
            return invalid(format!("{place}: текст незнакомца {name}"));
        }
    }
    // `for (const informant of attention.informants ?? [])`: строка перебирается
    // по символам, иное не-перечислимое — TypeError в JS.
    let informants: Vec<Value> = match field(attention, "informants") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items.clone(),
        Some(Value::String(text)) => text.chars().map(|ch| Value::String(ch.to_string())).collect(),
        Some(_) => return Err("TypeError: attention.informants is not iterable".into()),
    };
    for informant in &informants {
        let informant = Some(informant);
        let id = format!("{place}/informants/{}", string_of(field(informant, "id")));
        if !id_pattern(&js::s(field(informant, "id")))
            || clean(field(informant, "name"), 120).is_empty()
            || !id_pattern(&js::s(field(informant, "clue")))
            || !in_set(field(informant, "location_id"), location_ids)
        {
            return invalid(format!("{id}: id, имя, тайна и место"));
        }
        match field(informant, "name_stems") {
            Some(Value::Array(stems)) if !stems.is_empty() && stems.iter().all(|stem| lowercase_stem(stem, 3)) => {}
            _ => return invalid(format!("{id}: основы имени — строчные, от трёх букв")),
        }
        let turn = field(informant, "turn");
        if !safe_int_in(field(informant, "expose_delta"), 0.0, 6.0)
            || !safe_int_in(field(turn, "delta"), -6.0, 0.0)
            || !in_list(field(turn, "skill"), &SOCIAL_SKILLS)
            || !safe_int_in(field(turn, "dc"), 5.0, 30.0)
        {
            return invalid(format!("{id}: шаги внимания и проверка перевербовки"));
        }
        for name in ["expose_text", "release_text", "turn_text", "turn_failure_text"] {
            if clean_len(field(informant, name), 1_000) < 40 {
                return invalid(format!("{id}: текст {name}"));
            }
        }
    }
    let breath = field(stranger, "breath");
    if !text::test(re!(r"^\d{1,2}d(4|6|8|10|12)$", "u"), &js::s(field(breath, "expression")))
        || !in_list(field(breath, "ability"), &SAVE_ABILITIES)
        || !safe_int_in(field(breath, "dc"), 5.0, 30.0)
        || !in_list(field(breath, "damage_type"), &DAMAGE_TYPES)
    {
        return invalid(format!("{place}: выдох — кости, спасбросок, СЛ 5–30 и вид урона"));
    }
    Ok(())
}

/// Структура сценария. Ссылки на места и NPC мира проверяет тест каталога —
/// здесь только форма, чтобы модуль не зависел от каталога миров.
fn validate_scenario(scenario: &Value) -> Result<(), String> {
    if !matches!(scenario, Value::Object(_) | Value::Array(_)) {
        return invalid("запись должна быть объектом");
    }
    let entry = Some(scenario);
    if !id_pattern(&js::s(field(entry, "id"))) {
        return invalid("id сценария");
    }
    let sid = string_of(field(entry, "id"));
    let version = field(entry, "version");
    if !safe_int(version) || num(version) < 1.0 {
        return invalid(format!("{sid}: версия"));
    }
    if !id_pattern(&js::s(field(entry, "world_template_id"))) {
        return invalid(format!("{sid}: world_template_id"));
    }
    let Some(Value::Array(locations)) = field(entry, "locations") else {
        return invalid(format!("{sid}: locations"));
    };
    let mut location_ids = HashSet::new();
    let mut clue_ids = HashSet::new();
    for location in locations {
        let location = Some(location);
        let id = js::s(field(location, "location_id"));
        if !id_pattern(&id) || location_ids.contains(&id) {
            return invalid(format!("{sid}: место {id}"));
        }
        location_ids.insert(id.clone());
        for name in ["title", "mood", "arrival", "objective"] {
            if clean(field(location, name), 600).is_empty() {
                return invalid(format!("{sid}/{id}: пустое поле {name}"));
            }
        }
        let encounter = field(location, "encounter");
        if js::truthy(encounter)
            && (!in_list(field(encounter, "theme"), &ENCOUNTER_THEMES) || !in_list(field(encounter, "difficulty"), &ENCOUNTER_DIFFICULTIES))
        {
            return invalid(format!("{sid}/{id}: встреча вне словаря сборщика"));
        }
        for npc in array(field(location, "npcs")) {
            let npc = Some(npc);
            if !id_pattern(&js::s(field(npc, "id")))
                || clean(field(npc, "name"), 120).is_empty()
                || clean(field(npc, "role"), 120).is_empty()
                || clean_len(field(npc, "summary"), 600) < 40
                || clean(field(npc, "voice"), 300).is_empty()
                || array(field(npc, "goals")).is_empty()
            {
                return invalid(format!("{sid}/{id}: NPC сценария {} — id, имя, роль, облик, голос и цели", string_of(field(npc, "id"))));
            }
        }
        for secret in array(field(location, "secrets")) {
            let secret = Some(secret);
            let secret_id = js::s(field(secret, "id"));
            if !id_pattern(&secret_id) || clue_ids.contains(&secret_id) {
                return invalid(format!("{sid}/{id}: тайна {secret_id}"));
            }
            clue_ids.insert(secret_id.clone());
            if clean_len(field(secret, "clue"), 600) < 12 || clean(field(secret, "topic"), 160).is_empty() {
                return invalid(format!("{sid}/{secret_id}: текст тайны"));
            }
            match field(secret, "skills") {
                Some(Value::Array(skills)) if !skills.is_empty() && skills.iter().all(|skill| in_list(Some(skill), &SECRET_SKILLS)) => {}
                _ => return invalid(format!("{sid}/{secret_id}: навыки тайны")),
            }
            let holders = field(secret, "holders");
            if js::present(holders) {
                let ok = matches!(holders, Some(Value::Array(ids)) if ids.iter().all(|id| id_pattern(&js::s(Some(id)))));
                if !ok {
                    return invalid(format!("{sid}/{secret_id}: хранители тайны — id NPC мира"));
                }
            }
            let grants = field(secret, "grants_catalog_id");
            if js::present(grants) && !scenario_item_id(&js::s(grants)) {
                return invalid(format!("{sid}/{secret_id}: находка выдаёт предмет каталога сценария"));
            }
        }
    }
    let Some(Value::Array(beats)) = field(entry, "beats") else {
        return invalid(format!("{sid}: beats"));
    };
    let mut beat_ids = HashSet::new();
    for beat in beats {
        let beat = Some(beat);
        let id = js::s(field(beat, "id"));
        if !id_pattern(&id) || beat_ids.contains(&id) {
            return invalid(format!("{sid}: узел {id}"));
        }
        beat_ids.insert(id.clone());
        if !in_list(field(beat, "kind"), &BEAT_KINDS) {
            return invalid(format!("{sid}/{id}: вид узла"));
        }
        if clean(field(beat, "title"), 160).is_empty() {
            return invalid(format!("{sid}/{id}: название"));
        }
        match field(beat, "location_ids") {
            Some(Value::Array(ids)) if !ids.is_empty() && ids.iter().all(|place| in_set(Some(place), &location_ids)) => {}
            _ => return invalid(format!("{sid}/{id}: места узла должны быть карточками сценария")),
        }
        if is_str(field(beat, "kind"), "finale") {
            let boss = field(beat, "boss");
            if !id_pattern(&js::s(field(boss, "npc_id")))
                || !in_set(field(boss, "location_id"), &location_ids)
                || !in_list(field(boss, "difficulty"), &ENCOUNTER_DIFFICULTIES)
            {
                return invalid(format!("{sid}/{id}: финалу нужен главный противник с местом и сложностью"));
            }
            let morale = field(boss, "morale");
            let threshold = field(morale, "threshold");
            let threshold_ok = matches!(threshold, Some(Value::Number(n)) if n.as_f64().is_some_and(|t| t > 0.0 && t < 1.0));
            if js::present(morale) && !threshold_ok {
                return invalid(format!("{sid}/{id}: порог морали главного противника — доля хитов 0–1"));
            }
            let treaty = field(beat, "treaty");
            if js::present(treaty) {
                validate_condition(field(treaty, "truth"), &format!("{sid}/{id}.treaty.truth"), &clue_ids)?;
                let ratio_ok = matches!(field(treaty, "wounded_ratio"), Some(Value::Number(n)) if n.as_f64().is_some_and(|r| r > 0.0 && r <= 1.0));
                if !in_list(field(treaty, "skill"), &SOCIAL_SKILLS)
                    || !safe_int_in(field(treaty, "dc"), 5.0, 30.0)
                    || !ratio_ok
                    || clean_len(field(treaty, "success_text"), 1_000) < 40
                    || clean_len(field(treaty, "failure_text"), 1_000) < 20
                {
                    return invalid(format!("{sid}/{id}: договору нужны правда, навык, СЛ, порог ранения и тексты"));
                }
            }
        } else {
            validate_condition(field(beat, "complete_when"), &format!("{sid}/{id}"), &clue_ids)?;
        }
    }
    for reveal in array(field(entry, "map_reveals")) {
        let reveal = Some(reveal);
        let reveal_id = string_of(field(reveal, "id"));
        if !id_pattern(&js::s(field(reveal, "id"))) {
            return invalid(format!("{sid}: открытие карты {reveal_id}"));
        }
        validate_condition(field(reveal, "when"), &format!("{sid}/{reveal_id}"), &clue_ids)?;
        let places = array(field(reveal, "locations"));
        let routes = array(field(reveal, "routes"));
        if places.is_empty() && routes.is_empty() {
            return invalid(format!("{sid}/{reveal_id}: открывать нечего"));
        }
        // `[...places, ...routes.flat()]`: массивы раскрываются на один уровень.
        let flat = places.iter().chain(routes.iter().flat_map(|route| match route {
            Value::Array(pair) => pair.iter().collect::<Vec<_>>(),
            other => vec![other],
        }));
        for place in flat {
            if !in_set(Some(place), &location_ids) {
                return invalid(format!("{sid}/{reveal_id}: место {} без карточки", string_of(Some(place))));
            }
        }
        if routes.iter().any(|route| !matches!(route, Value::Array(pair) if pair.len() == 2)) {
            return invalid(format!("{sid}/{reveal_id}: дорога — пара мест"));
        }
    }
    if let Some(attention) = field(entry, "attention").filter(|value| !value.is_null()) {
        validate_attention(attention, &sid, &location_ids)?;
    }
    if let Some(knight) = field(entry, "knight").filter(|value| !value.is_null()) {
        validate_knight(knight, &sid, &location_ids)?;
    }
    if let Some(progression) = field(entry, "progression").filter(|value| !value.is_null()) {
        let progression = Some(progression);
        let (start, per_line, max) = (field(progression, "start_level"), field(progression, "levels_per_line"), field(progression, "max_level"));
        if ![start, per_line, max].iter().all(|value| safe_int_in(*value, 1.0, 20.0)) || num(start) > num(max) {
            return invalid(format!("{sid}/progression: уровни — целые 1–20, старт не выше потолка"));
        }
        let purse = field(progression, "purse");
        if js::present(purse)
            && (!in_set(field(purse, "location_id"), &location_ids)
                || !text::test(re!(r"^\d{1,2}d(4|6|8|10|12|20)$", "u"), &js::s(field(purse, "dice")))
                || !safe_int_in(field(purse, "gold_per_point"), 1.0, 1_000.0))
        {
            return invalid(format!("{sid}/progression.purse: место, кости и золото за очко"));
        }
        let armory = field(progression, "armory");
        if js::present(armory) {
            let ids_ok = match field(armory, "catalog_ids") {
                Some(Value::Array(ids)) => {
                    (2..=12).contains(&ids.len())
                        && ids.iter().all(|id| id_pattern(&text::replace_first(re!(r"^[a-z0-9_]+:", "u"), &js::s(Some(id)), "")))
                }
                _ => false,
            };
            if !in_set(field(armory, "location_id"), &location_ids) || !ids_ok {
                return invalid(format!("{sid}/progression.armory: место и от 2 до 12 вещей каталога"));
            }
        }
    }
    if beats.iter().filter(|beat| is_str(beat.get("kind"), "finale")).count() != 1 {
        return invalid(format!("{sid}: финал должен быть ровно один"));
    }
    if !is_str(beats.first().and_then(|beat| beat.get("kind")), "prologue") {
        return invalid(format!("{sid}: первый узел — пролог"));
    }
    let Some(Value::Array(endings)) = field(entry, "endings") else {
        return invalid(format!("{sid}: endings"));
    };
    let mut outcomes: Vec<&Value> = Vec::new();
    for ending in endings {
        let ending = Some(ending);
        if !id_pattern(&js::s(field(ending, "id")))
            || clean(field(ending, "title"), 160).is_empty()
            || clean_len(field(ending, "epilogue"), 4_000) < 40
        {
            return invalid(format!("{sid}: развязка {}", string_of(field(ending, "id"))));
        }
        let Some(Value::Array(list)) = field(ending, "outcomes") else {
            return invalid(format!("{sid}/{}: outcomes", string_of(field(ending, "id"))));
        };
        for outcome in list {
            if outcomes.iter().any(|seen| strict_eq(Some(seen), Some(outcome))) {
                return invalid(format!("{sid}: исход {} у двух развязок", string_of(Some(outcome))));
            }
            outcomes.push(outcome);
        }
    }
    Ok(())
}

/// Разбор каталога сценариев: версия схемы, проверка каждой записи, по одному
/// сценарию на мир.
fn load_scenarios(raw: &Value) -> Result<Vec<Value>, String> {
    let version_ok = matches!(raw.get("schema_version"), Some(Value::Number(n)) if n.as_f64() == Some(SCENARIO_SCHEMA_VERSION));
    let Some(Value::Array(entries)) = raw.get("scenarios").filter(|_| version_ok) else {
        return invalid("неизвестная версия каталога");
    };
    let mut ids: Vec<&Value> = Vec::new();
    let mut worlds: Vec<&Value> = Vec::new();
    for entry in entries {
        validate_scenario(entry)?;
        let id = entry.get("id");
        if ids.iter().any(|seen| strict_eq(Some(seen), id)) {
            return invalid(format!("повтор id {}", string_of(id)));
        }
        let world = entry.get("world_template_id");
        if worlds.iter().any(|seen| strict_eq(Some(seen), world)) {
            return invalid(format!("второй сценарий мира {}", string_of(world)));
        }
        if let Some(id) = id {
            ids.push(id);
        }
        if let Some(world) = world {
            worlds.push(world);
        }
    }
    Ok(entries.clone())
}

static SCENARIOS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    // Каталог встроен в сборку: неверный каталог — ошибка сборки данных, а не
    // данных игрока. JS в этом случае не загружал модуль вовсе.
    let raw: Value = serde_json::from_str(SCENARIO_CATALOG).expect("каталог сценариев — JSON");
    load_scenarios(&raw).unwrap_or_else(|error| panic!("{error}"))
});

/// Все сценарии каталога — для тестов и аудита.
pub fn list_campaign_scenarios() -> &'static [Value] {
    SCENARIOS.as_slice()
}

/// Сценарий мира по id шаблона мира.
pub fn scenario_for_world_template(world_template_id: &str) -> Option<&'static Value> {
    let wanted = head(&squash(world_template_id), 80);
    SCENARIOS.iter().find(|scenario| is_str(scenario.get("world_template_id"), &wanted))
}

/// План арки по сценарию. Числа темпа те же, что у вечерней арки: Режиссёр
/// получает те же ограничения шагов, а длину истории задают узлы, а не хеш.
pub fn build_scenario_arc_plan(scenario: &Value) -> Value {
    let mut plan = Map::new();
    plan.insert("version".into(), json!(SCENARIO_ARC_VERSION));
    plan.insert("preset".into(), json!(SCENARIO_ARC_PRESET));
    insert_raw(&mut plan, "scenario_id", scenario.get("id"));
    insert_raw(&mut plan, "scenario_version", scenario.get("version"));
    insert_raw(&mut plan, "seed", scenario.get("id"));
    plan.insert("arc_number".into(), json!(1));
    match scenario.get("beats") {
        Some(Value::Array(beats)) => {
            plan.insert("target_scenes".into(), json!(beats.len()));
        }
        Some(Value::String(text)) => {
            plan.insert("target_scenes".into(), json!(js_len(text)));
        }
        _ => {}
    }
    plan.insert("chapter_clock_max".into(), json!(2));
    plan.insert("force_after_beats".into(), json!(2));
    plan.insert("max_director_beats".into(), json!(5));
    plan.insert("climax".into(), json!("resolution"));
    Value::Object(plan)
}

/// Поле, которое JS копирует как есть: `undefined` в JSON не попадает.
fn insert_raw(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value.clone());
    }
}

/// Сценарий кампании или `None`. Версия сценария записана в арке при создании
/// кампании; другая версия каталога не подменяет историю, начатую по старой.
pub fn campaign_scenario(state: &Value) -> Option<&'static Value> {
    let concept = state.get("campaignConcept");
    let arc = field(concept, "arc");
    if !js::truthy(arc) || !is_str(field(arc, "version"), SCENARIO_ARC_VERSION) {
        return None;
    }
    if is_str(field(concept, "campaign_mode"), "persistent") {
        return None;
    }
    let scenario = SCENARIOS.iter().find(|entry| strict_eq(entry.get("id"), field(arc, "scenario_id")))?;
    strict_eq(scenario.get("version"), field(arc, "scenario_version")).then_some(scenario)
}

/// Id факта тайны сценария: `fact:secret:scenario:<сценарий>:<тайна>`.
pub fn scenario_clue_fact_id(scenario: &Value, clue_id: &str) -> String {
    format!("fact:secret:scenario:{}:{clue_id}", string_of(scenario.get("id")))
}

fn clue_fact_id_of(scenario: &Value, clue: Option<&Value>) -> String {
    scenario_clue_fact_id(scenario, &string_of(clue))
}

fn location_card<'a>(scenario: &'a Value, location_id: &str) -> Option<&'a Value> {
    array(scenario.get("locations")).iter().find(|entry| is_str(entry.get("location_id"), location_id))
}

fn world_locations(state: &Value) -> &[Value] {
    array(field(state.get("worldMap"), "locations"))
}

fn name_key(value: Option<&Value>) -> String {
    text::lower(&clean(value, 180)).replace('ё', "е")
}

/// Точка карты мира по id или имени — так же, как переход находит место.
fn world_location_for<'a>(state: &'a Value, location_id: Option<&Value>, name: Option<&Value>) -> Option<&'a Value> {
    let id = clean(location_id, 120);
    let locations = world_locations(state);
    let by_id = (!id.is_empty()).then(|| locations.iter().find(|entry| clean(entry.get("id"), 120) == id)).flatten();
    by_id.or_else(|| {
        let key = name_key(name);
        (!key.is_empty()).then(|| locations.iter().find(|entry| name_key(entry.get("name")) == key)).flatten()
    })
}

/// Карточка места для аргументов перехода. Место определяется так же, как в
/// переходе: по id, а без него — по имени точки карты мира.
pub fn scenario_scene_args(state: &Value, scene_args: &Value) -> Value {
    let args = if scene_args.is_object() { scene_args.clone() } else { json!({}) };
    let Some(scenario) = campaign_scenario(state) else {
        return args;
    };
    let location = world_location_for(
        state,
        nullish(args.get("location_id"), args.get("locationId")),
        args.get("location"),
    );
    let Some(location) = location else {
        return args;
    };
    let Some(card) = location_card(scenario, &clean(location.get("id"), 120)) else {
        return args;
    };
    let mut result = spread_copy(Some(&args));
    let name = clean(location.get("name"), 120);
    if !name.is_empty() {
        result.insert("location".into(), Value::String(name));
    }
    insert_raw(&mut result, "location_id", card.get("location_id"));
    insert_raw(&mut result, "title", card.get("title"));
    insert_raw(&mut result, "mood", card.get("mood"));
    insert_raw(&mut result, "arrival", card.get("arrival"));
    insert_raw(&mut result, "objective", card.get("objective"));
    insert_raw(&mut result, "hook", card.get("objective"));
    Value::Object(result)
}

/// NPC сценария в карточке места — собеседники, которых нет в каталоге мира
/// (комендант Гедрик, осведомители): переход сцены ставит их в сцену, а свои
/// тайны они знают по `holders`.
pub fn scenario_location_npcs(state: &Value, location_id: &str) -> Vec<Value> {
    let Some(scenario) = campaign_scenario(state) else {
        return Vec::new();
    };
    let Some(card) = location_card(scenario, &head(&squash(location_id), 120)) else {
        return Vec::new();
    };
    let cleaned = |list: Option<&Value>, maximum: usize| -> Value {
        Value::Array(array(list).iter().map(|entry| Value::String(clean(Some(entry), maximum))).collect())
    };
    array(card.get("npcs"))
        .iter()
        .map(|npc| {
            let id = string_of(npc.get("id"));
            let mut profile = Map::new();
            profile.insert("id".into(), Value::String(id.clone()));
            profile.insert("name".into(), Value::String(clean(npc.get("name"), 120)));
            profile.insert("role".into(), Value::String(clean(npc.get("role"), 120)));
            insert_raw(&mut profile, "location_id", card.get("location_id"));
            profile.insert("public_summary".into(), Value::String(clean(npc.get("summary"), 600)));
            profile.insert("voice".into(), Value::String(clean(npc.get("voice"), 300)));
            for key in ["speech_profile", "social_dcs"] {
                if js::truthy(npc.get(key)) {
                    profile.insert(key.into(), Value::Object(spread_copy(npc.get(key))));
                }
            }
            profile.insert("goals".into(), cleaned(npc.get("goals"), 200));
            profile.insert("beliefs".into(), cleaned(npc.get("beliefs"), 200));
            profile.insert("known_fact_ids".into(), js::strings_value(scenario_clue_fact_ids_known_by(Some(scenario), &id)));
            profile.insert("visibility".into(), json!("party"));
            profile.insert("available".into(), json!(true));
            profile.insert("tags".into(), cleaned(npc.get("tags"), 40));
            profile.insert("schedule".into(), json!([]));
            profile.insert("inventory".into(), json!([]));
            Value::Object(profile)
        })
        .collect()
}

/// Тайны карточки места со стабильными id. Их пишет переход сцены (`gm_only`);
/// находка заменяет тайну фактом `discovery`, и по нему узел узнаёт улику.
pub fn scenario_secrets_for(state: &Value, location_id: &str) -> Vec<Value> {
    let Some(scenario) = campaign_scenario(state) else {
        return Vec::new();
    };
    let Some(card) = location_card(scenario, &head(&squash(location_id), 120)) else {
        return Vec::new();
    };
    array(card.get("secrets"))
        .iter()
        .map(|secret| {
            let mut entry = Map::new();
            entry.insert("fact_id".into(), Value::String(clue_fact_id_of(scenario, secret.get("id"))));
            insert_raw(&mut entry, "clue_id", secret.get("id"));
            insert_raw(&mut entry, "clue", secret.get("clue"));
            insert_raw(&mut entry, "topic", secret.get("topic"));
            entry.insert("skills".into(), Value::Array(array(secret.get("skills")).to_vec()));
            Value::Object(entry)
        })
        .collect()
}

/// Найденные тайны сценария по их id в данных (`ash-gate`, `camp-gedrik`):
/// условие варианта диалога ссылается на тайну, а не на факт памяти.
pub fn scenario_found_clue_ids(state: &Value) -> IndexSet<String> {
    let Some(scenario) = campaign_scenario(state) else {
        return IndexSet::new();
    };
    let prefix = scenario_clue_fact_id(scenario, "");
    found_clue_fact_ids(state)
        .into_iter()
        .filter_map(|fact_id| fact_id.strip_prefix(&prefix).map(str::to_string))
        .collect()
}

/// Найденные тайны: удачный поиск (`discovery`) или рассказ хранителя тайны в
/// разговоре (`KnowledgeRevealed` → `worldMemory.knowledge_revealed`).
fn found_clue_fact_ids(state: &Value) -> IndexSet<String> {
    let memory = state.get("worldMemory");
    let mut ids = IndexSet::new();
    for fact in array(field(memory, "facts")) {
        if !is_str(fact.get("predicate"), "discovery") {
            continue;
        }
        let superseded = clean(fact.get("supersedes_fact_id"), 200);
        if !superseded.is_empty() {
            ids.insert(superseded);
        }
    }
    for entry in array(field(memory, "knowledge_revealed")) {
        let fact_id = clean(entry.get("fact_id"), 200);
        if !fact_id.is_empty() {
            ids.insert(fact_id);
        }
    }
    ids
}

/// Предмет, который отряд получает вместе с находкой тайны (`grants_catalog_id`):
/// оберег Ломара лежит на его столе. `None` — находка предмета не даёт.
pub fn scenario_clue_reward_catalog_id(state: &Value, clue_fact_id: &str) -> Option<String> {
    let scenario = campaign_scenario(state)?;
    for location in array(scenario.get("locations")) {
        for secret in array(location.get("secrets")) {
            if js::truthy(secret.get("grants_catalog_id")) && clue_fact_id_of(scenario, secret.get("id")) == clue_fact_id {
                return Some(string_of(secret.get("grants_catalog_id")));
            }
        }
    }
    None
}

/// Тайны сценария, которые знает NPC (`holders` в карточке места): их id
/// уходят в `known_fact_ids` профиля при создании кампании, и хранитель может
/// рассказать о них в разговоре — тем же защищённым путём, что и любой
/// закрытый факт. Сам факт появится, когда отряд придёт в его место.
pub fn scenario_clue_fact_ids_known_by(scenario: Option<&Value>, npc_id: &str) -> Vec<String> {
    let Some(scenario) = scenario else {
        return Vec::new();
    };
    array(scenario.get("locations"))
        .iter()
        .flat_map(|location| array(location.get("secrets")))
        .filter(|secret| array(secret.get("holders")).iter().any(|holder| holder.as_str() == Some(npc_id)))
        .map(|secret| clue_fact_id_of(scenario, secret.get("id")))
        .collect()
}

fn visited_location_ids(state: &Value) -> HashSet<String> {
    let mut ids: HashSet<String> =
        array(field(state.get("adventure"), "visitedLocationIds")).iter().map(|id| clean(Some(id), 120)).collect();
    for location in world_locations(state) {
        if js::is_true(location.get("visited")) {
            ids.insert(clean(location.get("id"), 120));
        }
    }
    let current = current_location_id(state);
    if !current.is_empty() {
        ids.insert(current);
    }
    ids.remove("");
    ids
}

fn left_location_ids(state: &Value) -> HashSet<String> {
    let mut ids = HashSet::new();
    for entry in array(field(state.get("adventure"), "history")) {
        let by_id = clean(entry.get("location_id"), 120);
        if !by_id.is_empty() {
            ids.insert(by_id);
        } else if let Some(by_name) = world_location_for(state, None, entry.get("location")) {
            ids.insert(clean(by_name.get("id"), 120));
        }
    }
    ids
}

/// Место текущей сцены — id узла карты мира, даже если сцена знает его только
/// по имени.
pub fn scenario_location_id(state: &Value) -> String {
    current_location_id(state)
}

fn current_location_id(state: &Value) -> String {
    let scene = nullish(state.get("scene"), None);
    let direct = clean(nullish(field(scene, "location_id"), field(scene, "locationId")), 120);
    if !direct.is_empty() {
        return direct;
    }
    clean(world_location_for(state, None, field(scene, "location")).and_then(|location| location.get("id")), 120)
}

/// `array.map(String).includes(value)`: значение — строка из списка.
fn ids_include(list: Option<&Value>, value: Option<&Value>) -> bool {
    let Some(Value::String(wanted)) = value else {
        return false;
    };
    array(list).iter().any(|entry| string_of(Some(entry)) == *wanted)
}

fn npc_defeated(state: &Value, npc_id: Option<&Value>) -> bool {
    let vitals = field(state.get("npc_world"), "vitals");
    if js::is_false(field(field(vitals, &string_of(npc_id)), "alive")) {
        return true;
    }
    let encounter = field(state.get("mechanics"), "encounter");
    is_str(field(encounter, "status"), "ended")
        && is_str(field(encounter, "outcome"), "enemies_defeated")
        && matches!(field(encounter, "enemy_ids"), Some(Value::Array(_)))
        && ids_include(field(encounter, "enemy_ids"), npc_id)
}

/// Что известно о кампании для проверки условий узлов.
struct ConditionFacts<'a> {
    scenario: &'a Value,
    state: &'a Value,
    found: IndexSet<String>,
    visited: HashSet<String>,
    left: HashSet<String>,
}

fn condition_facts<'a>(state: &'a Value, scenario: &'a Value) -> ConditionFacts<'a> {
    ConditionFacts {
        scenario,
        state,
        found: found_clue_fact_ids(state),
        visited: visited_location_ids(state),
        left: left_location_ids(state),
    }
}

fn condition_met(condition: Option<&Value>, facts: &ConditionFacts) -> bool {
    if let Some(Value::Array(any)) = field(condition, "any") {
        return any.iter().any(|entry| condition_met(Some(entry), facts));
    }
    if let Some(Value::Array(all)) = field(condition, "all") {
        return all.iter().all(|entry| condition_met(Some(entry), facts));
    }
    let count = field(condition, "count");
    if safe_int(count) {
        let met = array(field(condition, "of")).iter().filter(|entry| condition_met(Some(entry), facts)).count();
        return met as f64 >= num(count);
    }
    let clue = field(condition, "clue");
    if js::truthy(clue) {
        return facts.found.contains(&clue_fact_id_of(facts.scenario, clue));
    }
    let left = field(condition, "left");
    if js::truthy(left) {
        return in_set(left, &facts.left);
    }
    let visited = field(condition, "visited");
    if js::truthy(visited) {
        return in_set(visited, &facts.visited);
    }
    let defeated = field(condition, "npc_defeated");
    if js::truthy(defeated) {
        return npc_defeated(facts.state, defeated);
    }
    false
}

/// Уровень героев по сюжету: старт плюс по уровню за каждую пройденную линию,
/// не выше потолка (Асстохан: 7 → 10). `None` — у сценария нет вех уровня.
pub fn scenario_milestone_level(state: &Value) -> Option<i64> {
    let progression = campaign_scenario(state).and_then(|scenario| scenario.get("progression"));
    let progress = scenario_progress(state);
    if !js::truthy(progression) {
        return None;
    }
    let progress = progress?;
    let level = num(field(progression, "max_level"))
        .min(num(field(progression, "start_level")) + num(field(progression, "levels_per_line")) * progress.lines_completed as f64);
    Some(level as i64)
}

fn progression_part(state: &Value, key: &str) -> Option<&'static Value> {
    let part = campaign_scenario(state).and_then(|scenario| scenario.get("progression")).and_then(|progression| progression.get(key));
    js::truthy(part).then_some(part).flatten()
}

/// Кошель короля сценария: где выдают и сколько.
pub fn scenario_purse_rules(state: &Value) -> Option<Value> {
    let purse = progression_part(state, "purse")?;
    Some(json!({
        "location_id": string_of(purse.get("location_id")),
        "dice": string_of(purse.get("dice")),
        "gold_per_point": js::num(num(purse.get("gold_per_point"))),
    }))
}

/// Осведомители пепельной сети: кто, где и раскрыт ли он уже находкой своей
/// тайны. Решение по каждому принимается один раз (`ResolveScenarioInformant`).
pub fn scenario_informant_rules(state: &Value) -> Vec<Value> {
    let Some(scenario) = campaign_scenario(state) else {
        return Vec::new();
    };
    let informants = array(field(scenario.get("attention"), "informants"));
    if informants.is_empty() {
        return Vec::new();
    }
    let found = found_clue_fact_ids(state);
    let strings = |list: Option<&Value>| Value::Array(array(list).iter().map(|entry| Value::String(string_of(Some(entry)))).collect());
    informants
        .iter()
        .map(|informant| {
            let turn = informant.get("turn");
            json!({
                "id": string_of(informant.get("id")),
                "name": clean(informant.get("name"), 120),
                "location_id": string_of(informant.get("location_id")),
                "name_stems": strings(informant.get("name_stems")),
                "npc_id": clean(informant.get("npc_id"), 120),
                "departs_on": strings(informant.get("departs_on")),
                "revealed": found.contains(&clue_fact_id_of(scenario, informant.get("clue"))),
                "expose_delta": js::num(num(informant.get("expose_delta"))),
                "turn": {
                    "skill": string_of(field(turn, "skill")),
                    "dc": js::num(num(field(turn, "dc"))),
                    "delta": js::num(num(field(turn, "delta"))),
                },
                "expose_text": clean(informant.get("expose_text"), 1_000),
                "release_text": clean(informant.get("release_text"), 1_000),
                "turn_text": clean(informant.get("turn_text"), 1_000),
                "turn_failure_text": clean(informant.get("turn_failure_text"), 1_000),
            })
        })
        .collect()
}

/// Королевская оружейная сценария: где выбирают и из чего.
pub fn scenario_armory_rules(state: &Value) -> Option<Value> {
    let armory = progression_part(state, "armory")?;
    let ids: Vec<Value> = array(armory.get("catalog_ids")).iter().map(|id| Value::String(string_of(Some(id)))).collect();
    Some(json!({ "location_id": string_of(armory.get("location_id")), "catalog_ids": ids }))
}

/// Узел финала сценария.
fn finale_beat(scenario: Option<&Value>) -> Option<&Value> {
    array(field(scenario, "beats")).iter().find(|beat| is_str(beat.get("kind"), "finale"))
}

/// Договор с главным противником уже заключён (реестр сценария).
fn treaty_concluded(state: &Value) -> bool {
    js::is_true(field(field(state.get("scenario_attention"), "treaty"), "concluded"))
}

/// Мораль главного противника сценария: порог доли хитов, на котором он
/// проверяет мораль, и то, что сломленный он улетает, а не сдаётся. `None` —
/// это не главный противник или у него нет особой морали.
pub fn scenario_boss_morale(state: &Value, actor_id: &str) -> Option<Value> {
    let boss = field(finale_beat(campaign_scenario(state)), "boss");
    let morale = field(boss, "morale");
    if !js::truthy(morale) || !is_str(field(boss, "npc_id"), actor_id) {
        return None;
    }
    Some(json!({ "threshold": js::num(num(field(morale, "threshold"))), "flies": true }))
}

/// Договор с главным противником: правда раскрыта (условие `truth`), навык и
/// СЛ, порог ранения для переговоров посреди боя, тексты. `None` — у сценария
/// договора нет.
pub fn scenario_treaty_rules(state: &Value) -> Option<Value> {
    let scenario = campaign_scenario(state)?;
    let finale = finale_beat(Some(scenario));
    let treaty = field(finale, "treaty");
    if !js::truthy(treaty) {
        return None;
    }
    let boss = field(finale, "boss");
    Some(json!({
        "boss_npc_id": string_of(field(boss, "npc_id")),
        "boss_location_id": string_of(field(boss, "location_id")),
        "truth_revealed": condition_met(field(treaty, "truth"), &condition_facts(state, scenario)),
        "skill": string_of(field(treaty, "skill")),
        "dc": js::num(num(field(treaty, "dc"))),
        "wounded_ratio": js::num(num(field(treaty, "wounded_ratio"))),
        "concluded": treaty_concluded(state),
        "success_text": clean(field(treaty, "success_text"), 1_000),
        "failure_text": clean(field(treaty, "failure_text"), 1_000),
    }))
}

/// Чем закончился бой с главным противником, если не победой: договор —
/// `parley`, улетевший сломленным — `fled`. `None` — обычная причина.
pub fn scenario_encounter_end_reason(state: &Value) -> Option<&'static str> {
    let boss = field(finale_beat(campaign_scenario(state)), "boss");
    let encounter = field(state.get("mechanics"), "encounter");
    if !js::truthy(boss)
        || !matches!(field(encounter, "enemy_ids"), Some(Value::Array(_)))
        || !ids_include(field(encounter, "enemy_ids"), field(boss, "npc_id"))
    {
        return None;
    }
    if treaty_concluded(state) {
        return Some("parley");
    }
    let conditions = field(field(state.get("mechanics"), "conditions"), &string_of(field(boss, "npc_id")));
    let fled = array(conditions).iter().any(|entry| {
        let id = nullish(entry.get("id"), Some(entry));
        string_of(id) == "fled"
    });
    fled.then_some("fled")
}

/// Встреча с главным противником финала — последняя записанная. Исход берётся
/// только у завершённой встречи в месте финала с записанным
/// `EncounterOutcomeRecorded`.
fn boss_encounter_outcome(state: &Value, scenario: &Value) -> String {
    // Договор, заключённый до боя, — тоже исход финала: боя не было вовсе.
    if treaty_concluded(state) {
        return "parley".into();
    }
    let finale = finale_beat(Some(scenario));
    let encounter = field(state.get("mechanics"), "encounter");
    if finale.is_none() || !js::truthy(field(encounter, "id")) || !is_str(field(encounter, "status"), "ended") {
        return String::new();
    }
    let boss = field(finale, "boss");
    if !matches!(field(encounter, "enemy_ids"), Some(Value::Array(_))) || !ids_include(field(encounter, "enemy_ids"), field(boss, "npc_id")) {
        return String::new();
    }
    // Развязку решает только бой в логове: стычка с ним в другом месте —
    // эпизод, а не финал кампании.
    let mut location_id = clean(world_location_for(state, None, field(encounter, "location")).and_then(|place| place.get("id")), 120);
    if location_id.is_empty() {
        location_id = current_location_id(state);
    }
    if !is_str(field(boss, "location_id"), &location_id) {
        return String::new();
    }
    let encounter_id = string_of(field(encounter, "id"));
    let recorded = array(field(state.get("autonomy"), "encounter_outcomes"))
        .iter()
        .any(|entry| string_of(entry.get("encounter_id")) == encounter_id);
    if recorded {
        clean(field(encounter, "outcome"), 60)
    } else {
        String::new()
    }
}

fn road_key(from: Option<&Value>, to: Option<&Value>) -> String {
    let mut pair = [js::s(from), js::s(to)];
    pair.sort_by(|left, right| utf16_cmp(left, right));
    pair.join("\u{0000}")
}

/// Карта мира с открытыми сюжетом местами и дорогами. Скрытое логово, тропа к
/// Древу и пещера контрабандистов становятся известны, когда отряд дошёл до
/// перевала, вошёл в лес или вышел на осведомителей. Открытие выводится из
/// состояния при нормализации, поэтому replay его повторяет. Закрыть открытое
/// условие не может: оно считается только в сторону «известно». Единственное
/// исключение — завал тайного хода, когда дракон готов к отряду.
pub fn apply_scenario_map_reveals(state: &Value, world_map: &Value) -> Value {
    let Some(scenario) = campaign_scenario(state) else {
        return world_map.clone();
    };
    let Some(Value::Array(reveals)) = scenario.get("map_reveals") else {
        return world_map.clone();
    };
    if !matches!(world_map, Value::Object(_) | Value::Array(_)) {
        return world_map.clone();
    }
    let composite = js::spread(state, json!({ "worldMap": world_map.clone() }));
    let facts = condition_facts(&composite, scenario);
    let mut places: Vec<&Value> = Vec::new();
    let mut roads: IndexSet<String> = IndexSet::new();
    for reveal in reveals {
        if !condition_met(reveal.get("when"), &facts) {
            continue;
        }
        places.extend(array(reveal.get("locations")));
        for route in array(reveal.get("routes")) {
            roads.insert(road_key(route.get(0), route.get(1)));
        }
    }
    // Готовый к отряду дракон заваливает тайный ход в логово: дорога закрыта,
    // даже если отряд её уже нашёл. Это тоже вывод из состояния — счёт внимания
    // назад не идёт, поэтому завал не исчезает.
    let hidden = field(field(scenario.get("attention"), "finale"), "hidden_route");
    let collapsed = match hidden {
        Some(Value::Array(route)) if scenario_attention_ready_for(state, Some(scenario)) => road_key(route.first(), route.get(1)),
        _ => String::new(),
    };
    if !collapsed.is_empty() {
        roads.shift_remove(&collapsed);
    }
    if places.is_empty() && roads.is_empty() && collapsed.is_empty() {
        return world_map.clone();
    }
    let is_place = |location: &Value| places.iter().any(|place| strict_eq(Some(place), location.get("id")));
    let locations = array(world_map.get("locations"));
    let routes = array(world_map.get("routes"));
    let key_of = |route: &Value| road_key(route.get("from"), route.get("to"));
    let needs_change = locations.iter().any(|location| is_place(location) && js::is_false(location.get("known")))
        || routes.iter().any(|route| roads.contains(&key_of(route)) && js::is_false(route.get("discovered")))
        || routes.iter().any(|route| !collapsed.is_empty() && key_of(route) == collapsed && !js::is_false(route.get("discovered")));
    if !needs_change {
        return world_map.clone();
    }
    let new_locations: Vec<Value> = locations
        .iter()
        .map(|location| {
            if is_place(location) && js::is_false(location.get("known")) {
                js::spread(location, json!({ "known": true }))
            } else {
                location.clone()
            }
        })
        .collect();
    let new_routes: Vec<Value> = routes
        .iter()
        .map(|route| {
            let key = key_of(route);
            if !collapsed.is_empty() && key == collapsed {
                return if js::is_false(route.get("discovered")) { route.clone() } else { js::spread(route, json!({ "discovered": false })) };
            }
            if roads.contains(&key) && js::is_false(route.get("discovered")) {
                js::spread(route, json!({ "discovered": true }))
            } else {
                route.clone()
            }
        })
        .collect();
    let mut result = spread_copy(Some(world_map));
    result.insert("locations".into(), Value::Array(new_locations));
    result.insert("routes".into(), Value::Array(new_routes));
    Value::Object(result)
}

/// Готов ли главный противник к отряду: счёт внимания дошёл до `ready_at`.
/// Сценарий — сценарий кампании (`scenarioAttentionReady(state)`).
pub fn scenario_attention_ready(state: &Value) -> bool {
    scenario_attention_ready_for(state, campaign_scenario(state))
}

/// `scenarioAttentionReady(state, scenario)` с явным сценарием.
pub fn scenario_attention_ready_for(state: &Value, scenario: Option<&Value>) -> bool {
    let attention = field(scenario, "attention");
    js::truthy(attention) && num(field(state.get("scenario_attention"), "value")) >= num(field(attention, "ready_at"))
}

/// Откуда отряд пришёл в текущее место: последнее покинутое место летописи.
pub fn scenario_previous_location_id(state: &Value) -> String {
    let last = array(field(state.get("adventure"), "history")).last();
    let direct = clean(field(last, "location_id"), 120);
    if !direct.is_empty() {
        return direct;
    }
    clean(world_location_for(state, None, field(last, "location")).and_then(|place| place.get("id")), 120)
}

/// Узел сюжета и его завершённость.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScenarioBeatProgress {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub summary: String,
    pub location_ids: Vec<String>,
    pub completed: bool,
}

/// Тайна сценария и её находка.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScenarioClueProgress {
    pub id: String,
    pub location_id: String,
    pub found: bool,
}

/// Главный противник финала.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScenarioBoss {
    pub npc_id: String,
    pub location_id: String,
    pub difficulty: String,
}

/// Развязка, которую выбрал исход боя.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScenarioEndingRef {
    pub id: String,
    pub title: String,
    pub outcome: String,
}

/// Где отряд в сюжете (`scenarioProgress`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScenarioProgress {
    pub scenario_id: String,
    pub scenario_version: i64,
    pub current_location_id: String,
    pub at_finale_approach: bool,
    pub at_boss_location: bool,
    pub boss: ScenarioBoss,
    pub boss_outcome: String,
    pub ending: Option<ScenarioEndingRef>,
    pub beats: Vec<ScenarioBeatProgress>,
    pub clues: Vec<ScenarioClueProgress>,
    pub lines_completed: usize,
    pub lines_total: usize,
}

fn strings(list: Option<&Value>) -> Vec<String> {
    array(list).iter().map(|entry| js::s(Some(entry))).collect()
}

/// Где отряд в сюжете. Всё выводится из состояния — отдельного счётчика нет.
pub fn scenario_progress(state: &Value) -> Option<ScenarioProgress> {
    let scenario = campaign_scenario(state)?;
    let facts = condition_facts(state, scenario);
    let finale = finale_beat(Some(scenario));
    let boss_outcome = boss_encounter_outcome(state, scenario);
    let ending = if boss_outcome.is_empty() {
        None
    } else {
        array(scenario.get("endings"))
            .iter()
            .find(|entry| array(entry.get("outcomes")).iter().any(|outcome| outcome.as_str() == Some(boss_outcome.as_str())))
    };
    let beats: Vec<ScenarioBeatProgress> = array(scenario.get("beats"))
        .iter()
        .map(|beat| ScenarioBeatProgress {
            id: js::s(beat.get("id")),
            kind: js::s(beat.get("kind")),
            title: js::s(beat.get("title")),
            summary: js::s(beat.get("summary")),
            location_ids: strings(beat.get("location_ids")),
            completed: if is_str(beat.get("kind"), "finale") { ending.is_some() } else { condition_met(beat.get("complete_when"), &facts) },
        })
        .collect();
    let clues: Vec<ScenarioClueProgress> = array(scenario.get("locations"))
        .iter()
        .flat_map(|location| {
            array(location.get("secrets")).iter().map(|secret| ScenarioClueProgress {
                id: js::s(secret.get("id")),
                location_id: js::s(location.get("location_id")),
                found: facts.found.contains(&clue_fact_id_of(scenario, secret.get("id"))),
            })
        })
        .collect();
    let here = current_location_id(state);
    let boss = field(finale, "boss");
    let boss_location = js::s(field(boss, "location_id"));
    Some(ScenarioProgress {
        scenario_id: js::s(scenario.get("id")),
        scenario_version: num(scenario.get("version")) as i64,
        at_finale_approach: strings(field(finale, "location_ids")).contains(&here) && here != boss_location,
        at_boss_location: here == boss_location,
        current_location_id: here,
        boss: ScenarioBoss {
            npc_id: js::s(field(boss, "npc_id")),
            location_id: boss_location,
            difficulty: js::s(field(boss, "difficulty")),
        },
        ending: ending.map(|ending| ScenarioEndingRef {
            id: js::s(ending.get("id")),
            title: js::s(ending.get("title")),
            outcome: boss_outcome.clone(),
        }),
        boss_outcome,
        lines_completed: beats.iter().filter(|beat| beat.kind == "line" && beat.completed).count(),
        lines_total: beats.iter().filter(|beat| beat.kind == "line").count(),
        beats,
        clues,
    })
}

/// Фаза темпа по сюжету: пролог и первая глава — передышка, линии — развитие,
/// подход к логову — нарастание, логово — кульминация.
pub fn scenario_phase(state: &Value) -> Option<&'static str> {
    let progress = scenario_progress(state)?;
    if progress.at_boss_location {
        return Some("climax");
    }
    if progress.at_finale_approach {
        return Some("escalation");
    }
    let opening_done = progress.beats.iter().filter(|beat| beat.kind == "prologue" || beat.kind == "chapter").all(|beat| beat.completed);
    Some(if opening_done { "development" } else { "breather" })
}

/// `[...new Set(list)]`.
fn unique(list: impl IntoIterator<Item = String>) -> Vec<String> {
    list.into_iter().collect::<IndexSet<String>>().into_iter().collect()
}

/// Места, куда сюжет зовёт дальше, в порядке предпочтения. Сначала — места
/// незавершённых узлов, где отряд ещё не был; затем — места, где остались
/// ненайденные улики незавершённых узлов; финал — когда закрыто не меньше двух
/// линий или открытых линий не осталось. Выбор ближайшего по дорогам — за
/// политикой Режиссёра, у которой есть граф карты мира.
pub fn scenario_destination_ids(state: &Value) -> Vec<String> {
    let Some(scenario) = campaign_scenario(state) else {
        return Vec::new();
    };
    let Some(progress) = scenario_progress(state) else {
        return Vec::new();
    };
    if progress.ending.is_some() {
        return Vec::new();
    }
    let here = progress.current_location_id.clone();
    let visited = visited_location_ids(state);
    let pending: Vec<&ScenarioBeatProgress> = progress.beats.iter().filter(|beat| !beat.completed && beat.kind != "finale").collect();
    let finale = finale_beat(Some(scenario));
    let mut unvisited: Vec<String> = Vec::new();
    let mut revisit: Vec<String> = Vec::new();
    for beat in &pending {
        for location_id in &beat.location_ids {
            if *location_id == here {
                continue;
            }
            let has_open_clue = progress.clues.iter().any(|clue| clue.location_id == *location_id && !clue.found);
            if !visited.contains(location_id) {
                unvisited.push(location_id.clone());
            } else if has_open_clue {
                revisit.push(location_id.clone());
            }
        }
    }
    let opening: Vec<String> = pending.iter().filter(|beat| beat.kind != "line").flat_map(|beat| beat.location_ids.clone()).collect();
    // Финал зовёт, когда закрыты две линии или когда в открытых линиях не
    // осталось мест, где отряд ещё не был: возвращаться за пропущенной уликой —
    // выбор стола, а не Режиссёра.
    let line_unvisited = pending
        .iter()
        .filter(|beat| beat.kind == "line")
        .flat_map(|beat| beat.location_ids.iter())
        .any(|id| *id != here && !visited.contains(id));
    let finale_ready = progress.lines_completed >= progress.lines_total.min(2) || !line_unvisited;
    // Финал зовёт в логово и на подступ к нему: дорогу в логово открывает сам
    // подступ (перевал, `map_reveals`). В логове звать некуда.
    let boss_location = js::s(field(field(finale, "boss"), "location_id"));
    let finale_ids: Vec<String> = if here != boss_location {
        unique(std::iter::once(boss_location).chain(strings(field(finale, "location_ids"))))
            .into_iter()
            .filter(|id| *id != here)
            .collect()
    } else {
        Vec::new()
    };
    // Пролог и первая глава не открыты — сначала они: финал до заставы — это
    // не свобода, а пропущенная завязка.
    if opening.iter().any(|id| *id != here) {
        let first = unvisited.iter().filter(|id| opening.contains(id)).cloned();
        return unique(first.chain(unvisited.iter().cloned()));
    }
    if finale_ready {
        return unique(finale_ids.into_iter().chain(unvisited));
    }
    if !unvisited.is_empty() {
        unique(unvisited)
    } else {
        unique(revisit.into_iter().chain(finale_ids))
    }
}

/// Встреча, которую Режиссёр собирает в текущем месте: главный противник в
/// логове, пока он жив и бой с ним не завершён, иначе — встреча карточки места.
/// `None` — у места нет своей встречи.
pub fn scenario_encounter_for(state: &Value) -> Option<Value> {
    let scenario = campaign_scenario(state)?;
    let progress = scenario_progress(state)?;
    let vitals = field(state.get("npc_world"), "vitals");
    if progress.at_boss_location && progress.boss_outcome.is_empty() && !js::is_false(field(field(vitals, &progress.boss.npc_id), "alive")) {
        return Some(json!({ "npc_id": progress.boss.npc_id, "difficulty": progress.boss.difficulty }));
    }
    let encounter = location_card(scenario, &progress.current_location_id).and_then(|card| card.get("encounter"));
    if !js::truthy(encounter) {
        return None;
    }
    let mut result = Map::new();
    insert_raw(&mut result, "theme", field(encounter, "theme"));
    insert_raw(&mut result, "difficulty", field(encounter, "difficulty"));
    Some(Value::Object(result))
}

/// Развязка кампании по сценарию: исход боя с главным противником. Текст
/// эпилога — авторский; модель может его переписать, но не выбрать другой исход.
pub fn scenario_ending(state: &Value) -> Option<Value> {
    let scenario = campaign_scenario(state)?;
    let progress = scenario_progress(state)?;
    let wanted = progress.ending.as_ref()?;
    let ending = array(scenario.get("endings")).iter().find(|entry| is_str(entry.get("id"), &wanted.id))?;
    let mut result = Map::new();
    insert_raw(&mut result, "id", ending.get("id"));
    insert_raw(&mut result, "title", ending.get("title"));
    result.insert("outcome".into(), Value::String(progress.boss_outcome.clone()));
    insert_raw(&mut result, "epilogue", ending.get("epilogue"));
    Some(Value::Object(result))
}

/// Имена точек карты мира по id: при повторе id побеждает последнее имя.
fn location_names(state: &Value) -> std::collections::HashMap<String, String> {
    world_locations(state).iter().map(|entry| (clean(entry.get("id"), 120), clean(entry.get("name"), 120))).collect()
}

fn named(names: &std::collections::HashMap<String, String>, id: String) -> String {
    match names.get(&id) {
        Some(name) if !name.is_empty() => name.clone(),
        _ => id,
    }
}

/// Сюжет для Рассказчика: о чём кампания, где отряд в истории и что уже
/// найдено — чтобы голос ведущего знал историю, а не только сцену. Состояние
/// приходит уже спроецированным для отряда; тексты ненайденных тайн сюда не
/// входят по построению — только названия узлов и найденные улики.
pub fn scenario_narrator_brief(state: &Value) -> Option<Value> {
    let scenario = campaign_scenario(state)?;
    let progress = scenario_progress(state)?;
    let card = location_card(scenario, &progress.current_location_id);
    let current = progress
        .beats
        .iter()
        .find(|beat| !beat.completed && beat.location_ids.contains(&progress.current_location_id))
        .or_else(|| progress.beats.iter().find(|beat| !beat.completed));
    let clue_fact_ids: HashSet<String> = array(scenario.get("locations"))
        .iter()
        .flat_map(|location| array(location.get("secrets")))
        .map(|secret| clue_fact_id_of(scenario, secret.get("id")))
        .collect();
    let found: Vec<String> = array(field(state.get("worldMemory"), "facts"))
        .iter()
        .filter(|fact| {
            let visibility = match fact.get("visibility") {
                None | Some(Value::Null) => "party".to_string(),
                other => js::s(other),
            };
            is_str(fact.get("predicate"), "discovery")
                && clue_fact_ids.contains(&clean(fact.get("supersedes_fact_id"), 200))
                && (visibility == "party" || visibility == "public")
        })
        .map(|fact| clean(fact.get("summary"), 240))
        .filter(|summary| !summary.is_empty())
        .collect();
    let names = location_names(state);
    let mut brief = Map::new();
    brief.insert("campaign".into(), Value::String(clean(scenario.get("title"), 120)));
    brief.insert("premise".into(), Value::String(clean(scenario.get("summary"), 600)));
    brief.insert("phase".into(), scenario_phase(state).map_or(Value::Null, |phase| Value::String(phase.into())));
    if let Some(card) = card {
        brief.insert(
            "place".into(),
            json!({
                "title": clean(card.get("title"), 120),
                "mood": clean(card.get("mood"), 240),
                "objective": clean(card.get("objective"), 240),
            }),
        );
    }
    if let Some(current) = current {
        brief.insert(
            "current_beat".into(),
            json!({
                "title": head(&squash(&current.title), 160),
                "summary": head(&squash(&current.summary), 240),
            }),
        );
    }
    let completed: Vec<String> = progress.beats.iter().filter(|beat| beat.completed).map(|beat| head(&squash(&beat.title), 160)).collect();
    brief.insert("completed_beats".into(), js::strings_value(completed));
    let tail = found.len().saturating_sub(5);
    brief.insert("found_clues".into(), js::strings_value(found[tail..].iter().cloned()));
    let ahead: Vec<String> = scenario_destination_ids(state).into_iter().map(|id| named(&names, id)).take(2).collect();
    brief.insert("ahead".into(), js::strings_value(ahead));
    Some(Value::Object(brief))
}

/// Что Режиссёр-модель знает о сюжете: узлы, найденные улики и куда звать.
/// Тексты тайн сюда не входят — их видит только хранитель находки.
pub fn scenario_director_brief(state: &Value) -> Option<Value> {
    let scenario = campaign_scenario(state)?;
    let progress = scenario_progress(state)?;
    let names = location_names(state);
    let mut brief = Map::new();
    insert_raw(&mut brief, "scenario", scenario.get("title"));
    let beats: Vec<Value> = progress
        .beats
        .iter()
        .map(|beat| json!({ "title": beat.title, "kind": beat.kind, "completed": beat.completed }))
        .collect();
    brief.insert("beats".into(), Value::Array(beats));
    brief.insert("clues_found".into(), json!(progress.clues.iter().filter(|clue| clue.found).count()));
    brief.insert("clues_total".into(), json!(progress.clues.len()));
    let next: Vec<String> = scenario_destination_ids(state).into_iter().map(|id| named(&names, id)).take(4).collect();
    brief.insert("next_destinations".into(), js::strings_value(next));
    brief.insert("at_boss_location".into(), Value::Bool(progress.at_boss_location));
    Some(Value::Object(brief))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_loads_and_has_one_astohan_scenario() {
        let scenarios = list_campaign_scenarios();
        assert_eq!(scenarios.len(), 1);
        assert_eq!(scenarios[0]["id"], "astohan-dragon-hunt");
        assert_eq!(scenario_for_world_template(" astohan-plains ").map(|s| &s["id"]), Some(&json!("astohan-dragon-hunt")));
        assert!(scenario_for_world_template("league-nine-tides").is_none());
        let mut ending_ids: Vec<&str> = array(scenarios[0].get("endings")).iter().filter_map(|e| e["id"].as_str()).collect();
        ending_ids.sort_unstable();
        assert_eq!(ending_ids, ["banished", "defeat", "slain", "treaty"]);
    }

    #[test]
    fn validation_rejects_broken_catalog() {
        let scenario = list_campaign_scenarios()[0].clone();
        assert_eq!(validate_scenario(&scenario), Ok(()));
        let mut no_finale = scenario.clone();
        if let Some(beats) = no_finale.get_mut("beats").and_then(Value::as_array_mut) {
            beats.retain(|beat| beat["kind"] != "finale");
        }
        assert_eq!(validate_scenario(&no_finale), Err("Сценарий кампании: astohan-dragon-hunt: финал должен быть ровно один".into()));
        assert_eq!(load_scenarios(&json!({ "schema_version": 2, "scenarios": [] })), Err("Сценарий кампании: неизвестная версия каталога".into()));
        let twice = json!({ "schema_version": 1, "scenarios": [scenario.clone(), scenario] });
        assert_eq!(load_scenarios(&twice), Err("Сценарий кампании: повтор id astohan-dragon-hunt".into()));
    }

    /// Правка сценария по пути из эталона: замена значения или удаление.
    fn mutate(original: &Value, path: &[Value], replacement: &Value) -> Value {
        if path.is_empty() {
            return replacement.clone();
        }
        let mut copy = original.clone();
        let mut target = &mut copy;
        for key in &path[..path.len() - 1] {
            target = match key {
                Value::Number(index) => &mut target[index.as_u64().unwrap_or(0) as usize],
                other => &mut target[other.as_str().unwrap_or("")],
            };
        }
        let last = &path[path.len() - 1];
        let delete = replacement.as_str() == Some("__delete__");
        match (target, last) {
            (Value::Array(items), Value::Number(index)) => {
                let index = index.as_u64().unwrap_or(0) as usize;
                if delete {
                    items.remove(index);
                } else {
                    items[index] = replacement.clone();
                }
            }
            (Value::Object(map), key) => {
                let key = key.as_str().unwrap_or("");
                if delete {
                    map.shift_remove(key);
                } else {
                    map.insert(key.into(), replacement.clone());
                }
            }
            _ => panic!("путь эталона не ведёт к полю"),
        }
        copy
    }

    #[test]
    fn validation_matches_js() {
        let data: Value = serde_json::from_str(include_str!("../fixtures/campaign-scenario.json")).expect("эталон");
        let original = &list_campaign_scenarios()[0];
        let mut failures = Vec::new();
        let mut checked = 0;
        for entry in data["validation"].as_array().expect("проверки формы") {
            let path = entry["path"].as_array().expect("путь");
            let scenario = mutate(original, path, &entry["replacement"]);
            let actual = validate_scenario(&scenario).err().unwrap_or_else(|| "ok".into());
            let expected = entry["message"].as_str().unwrap_or("");
            // TypeError JS (не-перечислимое значение) — отказ и в Rust, текст свой.
            if expected.starts_with("TypeError") {
                assert_ne!(actual, "ok", "{entry}");
                continue;
            }
            checked += 1;
            if actual != expected {
                failures.push(format!("{entry}\n    rust: {actual}"));
            }
        }
        for entry in data["loads"].as_array().expect("каталоги") {
            let mut raw = entry["raw"].clone();
            if let Some(list) = raw.get_mut("scenarios").and_then(Value::as_array_mut) {
                for item in list.iter_mut() {
                    *item = js::spread(original, item["$scenario"].clone());
                }
            }
            let actual = match load_scenarios(&raw) {
                Ok(list) => format!("ok:{}", list.len()),
                Err(error) => error,
            };
            checked += 1;
            if actual != entry["message"].as_str().unwrap_or("") {
                failures.push(format!("{entry}\n    rust: {actual}"));
            }
        }
        let shown: Vec<&String> = failures.iter().take(30).collect();
        assert!(failures.is_empty(), "расхождений {} из {checked}:\n{}", failures.len(), shown.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("\n"));
    }

    #[test]
    fn free_world_has_no_scenario() {
        assert!(campaign_scenario(&json!({})).is_none());
        assert!(campaign_scenario(&Value::Null).is_none());
        let persistent = json!({ "campaignConcept": { "campaign_mode": "persistent", "arc": {
            "version": SCENARIO_ARC_VERSION, "scenario_id": "astohan-dragon-hunt", "scenario_version": 1 } } });
        assert!(campaign_scenario(&persistent).is_none());
        let mut arc = persistent.clone();
        arc["campaignConcept"]["campaign_mode"] = json!("arc");
        assert!(campaign_scenario(&arc).is_some());
        arc["campaignConcept"]["arc"]["scenario_version"] = json!(2);
        assert!(campaign_scenario(&arc).is_none(), "другая версия каталога не подменяет историю");
    }

    #[test]
    fn arc_plan_follows_scenario() {
        let plan = build_scenario_arc_plan(&list_campaign_scenarios()[0]);
        assert_eq!(plan["version"], SCENARIO_ARC_VERSION);
        assert_eq!(plan["seed"], "astohan-dragon-hunt");
        assert_eq!(plan["target_scenes"], json!(array(list_campaign_scenarios()[0].get("beats")).len()));
    }
}

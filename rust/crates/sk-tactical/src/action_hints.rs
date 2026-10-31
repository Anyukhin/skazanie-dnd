//! Перенос `server/action-hints.mjs` — подсказки «что можно сделать»
//! (задача 4.2 `docs/experience-upgrade-plan.md`).
//!
//! Ни модели, ни новой команды: функция читает **уже спроецированную** игроку
//! комнату и собирает из неё короткие строки, поэтому раскрыть скрытое она не
//! способна по построению — чего нет в проекции, того нет и на входе. В бою
//! подсказок нет: там хотбар перечисляет действия точнее любой строки.
//!
//! Строки: добыча, двор короля, раунд костей и досуг таверны, собеседники,
//! цель отряда, выход, находки на карте, замок, молитва, зверь, почта и
//! изнанка (карман, монета, краденое). Порядок детерминирован (вид строки,
//! затем идентификатор), реквизиту достаётся не больше `MAX_PROP_HINTS`
//! строк и только остаток после собеседников, цели и выхода.

use std::collections::HashSet;
use std::fmt;
use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_core::indexmap::IndexMap;
use sk_core::{js, re, text};
use sk_economy::merchant_economy::currency_to_copper;
use sk_scenario::party_exit_intent::pending_onward_target;
use sk_society::underworld::MIN_BRIBE_CP;

use crate::scene_interactions::{scene_interaction_catalog_entry, scene_interaction_reward_kinds, scene_object_distance, scene_object_label_for};

/// Больше четырёх строк — это уже не подсказка, а инструкция.
pub const MAX_ACTION_HINTS: usize = 4;

/// Сколько строк отдаётся реквизиту и приглашению за стол: без потолка
/// подсказки превращались в опись мебели.
pub const MAX_PROP_HINTS: usize = 2;

/// Сколько строк достаётся добыче: после боя на полу столько тел, сколько
/// было противников.
pub const MAX_LOOT_HINTS: usize = 2;

/// На каком расстоянии подсказка называет чужой карман. Это **отбор**, а не
/// правило: движок требует только присутствия человека в сцене.
pub const THEFT_HINT_REACH_FEET: i64 = 5;

/// Подсказка панели: `{ id, text }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActionHint {
    pub id: String,
    pub text: String,
}

impl ActionHint {
    /// Форма JS: `{ id, text }`.
    pub fn to_json(&self) -> Value {
        json!({ "id": self.id, "text": self.text })
    }
}

/// Исключение JS, которое `suggestedActionsFor` пропускает наружу:
/// `TypeError` при `courier_letters.addressees[0] === null` (чтение `name` у
/// `null`; см. «Замечено в JS» отчёта переноса).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActionHintsError {
    pub message: String,
}

impl ActionHintsError {
    /// `error.name` в JS.
    pub const NAME: &'static str = "TypeError";
}

impl fmt::Display for ActionHintsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ActionHintsError {}

/// Строка панели до финальной сортировки.
#[derive(Clone, Debug)]
struct Hint {
    id: String,
    priority: i64,
    text: String,
}

/// Порядок строк в панели: значит только порядок чисел, он же решает, кто
/// кого вытеснит. Досуг таверны — между приметной находкой и рядовой
/// обстановкой; изнанка — в одной очереди с рядовым реквизитом.
mod priority {
    pub const TAVERN_ROUND: i64 = 0;
    pub const COURT: i64 = 0;
    pub const POI_PROP: i64 = 1;
    pub const LEISURE: i64 = 2;
    pub const LETTER: i64 = 2;
    pub const PROP: i64 = 3;
    pub const UNDERWORLD: i64 = 3;
    pub const NPC: i64 = 4;
    pub const OBJECTIVE: i64 = 5;
    pub const EXIT: i64 = 6;
}

/// Глаголы взаимодействия в порядке предпочтения (осмотр безопаснее поджога) и
/// то, как они звучат за столом. `pray` здесь нет намеренно: у молитвы своя
/// строка (`blessing_hints`).
const VERB_PHRASES: [(&str, &str); 6] =
    [("inspect", "осмотреть"), ("open", "открыть"), ("take", "забрать"), ("use", "использовать"), ("topple", "опрокинуть"), ("ignite", "поджечь")];

/// Виды реквизита, за которыми сервер держит находку, тайник или знание.
static REWARD_BEARING_KINDS: LazyLock<HashSet<String>> = LazyLock::new(|| scene_interaction_reward_kinds().into_iter().collect());

/// Как зовётся обыск каждого вида контейнера.
const LOOT_HINT_PHRASES: [(&str, &str); 5] = [
    ("corpse", "обыскать тело"),
    ("captive", "забрать оружие пленного"),
    ("abandoned", "разобрать брошенное"),
    ("cache", "вскрыть схрон"),
    ("dropped", "подобрать брошенное оружие"),
];

/// `LOOT_HINT_PHRASES[kind] ?? 'обыскать добычу'` по собственному ключу.
fn loot_phrase(kind: &str) -> String {
    if let Some((_, phrase)) = LOOT_HINT_PHRASES.iter().find(|(key, _)| *key == kind) {
        return (*phrase).to_string();
    }
    "обыскать добычу".to_string()
}

// --- приведения JS -------------------------------------------------------------

/// `value?.[key]` для объекта; у не-объекта полей нет.
fn field<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(Value::as_object).and_then(|map| map.get(key))
}

fn path<'a>(value: Option<&'a Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().try_fold(value?, |current, key| field(Some(current), key))
}

/// `Array.isArray(value) ? value : []`.
fn array(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// `text.length` в единицах UTF-16.
fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(0, max)` в единицах UTF-16. Символ вне BMP, который JS разрезал
/// бы пополам, отбрасывается целиком: половину суррогатной пары строка Rust не
/// держит.
fn head_utf16(text: &str, max: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for ch in text.chars() {
        let width = ch.len_utf16();
        if units + width > max {
            break;
        }
        units += width;
        out.push(ch);
    }
    out
}

/// `String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maximum)`.
fn clean(value: Option<&Value>, maximum: usize) -> String {
    clean_str(&js::s(value), maximum)
}

fn clean_str(value: &str, maximum: usize) -> String {
    head_utf16(&text::squash_spaces(value), maximum)
}

/// `Number(value) || fallback`.
fn number_or(value: Option<&Value>, fallback: f64) -> f64 {
    let number = js::number(value);
    if number.is_nan() || number == 0.0 {
        fallback
    } else {
        number
    }
}

/// «сундук» → «Сундук»: заглавной становится первая единица UTF-16, то есть
/// символ BMP; символ вне BMP (суррогатная пара) остаётся как есть.
fn capitalized(value: &str) -> String {
    let mut chars = value.chars();
    let Some(first) = chars.next() else { return String::new() };
    if first.len_utf16() > 1 {
        return value.to_string();
    }
    let mut out: String = first.to_uppercase().collect();
    out.push_str(chars.as_str());
    out
}

/// Сортировка строк панели: вид, затем идентификатор (`localeCompare`).
fn sort_hints(hints: &mut [Hint]) {
    hints.sort_by(|left, right| left.priority.cmp(&right.priority).then_with(|| text::locale_compare(&left.id, &right.id)));
}

// --- герой-читатель ------------------------------------------------------------

/// Герой-читатель в уже спроецированной комнате.
fn reader_hero<'a>(room: &'a Value, actor_id: &str) -> Option<&'a Value> {
    if actor_id.is_empty() {
        return None;
    }
    array(field(Some(room), "players")).iter().find(|player| js::s(field(Some(player), "id")) == actor_id)
}

/// Клетка героя-читателя. Позиция механики главнее листа: по ней ходит доска.
fn hero_cell(room: &Value, actor_id: &str) -> Option<(f64, f64)> {
    if actor_id.is_empty() {
        return None;
    }
    let position = path(Some(room), &["mechanics", "positions", actor_id]);
    let hero = reader_hero(room, actor_id);
    // `Number(position?.x ?? hero?.x)`.
    let coordinate = |key: &str| js::number(field(position, key).filter(|value| !value.is_null()).or_else(|| field(hero, key)));
    let (x, y) = (coordinate("x"), coordinate("y"));
    (x.is_finite() && y.is_finite()).then_some((x, y))
}

/// Футы между клетками — шахматная мерка доски; `None` — не измерить.
fn feet_between(from: Option<(f64, f64)>, to: &Value) -> Option<f64> {
    let x = js::number(field(Some(to), "x"));
    let y = js::number(field(Some(to), "y"));
    let from = from?;
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    Some((from.0 - x).abs().max((from.1 - y).abs()) * 5.0)
}

/// Живые мирные люди сцены — один список на все строки, которые их называют.
fn peaceful_scene_npcs(room: &Value) -> Vec<&Value> {
    array(field(Some(room), "scene_npcs"))
        .iter()
        .filter(|npc| !js::is_false(field(Some(npc), "alive")) && field(Some(npc), "stance").and_then(Value::as_str) != Some("hostile"))
        .collect()
}

// --- строки ------------------------------------------------------------------

struct PropHint {
    id: String,
    priority: i64,
    phrase: String,
    distance: Option<f64>,
}

/// `propHintOrder(left, right)`: приметная, затем ближняя, затем по
/// идентификатору (`∞ − ∞` — `NaN`, и решает идентификатор).
fn prop_hint_order(left: &PropHint, right: &PropHint) -> f64 {
    let priority = (left.priority - right.priority) as f64;
    if priority != 0.0 {
        return priority;
    }
    let distance = left.distance.unwrap_or(f64::INFINITY) - right.distance.unwrap_or(f64::INFINITY);
    if distance != 0.0 && !distance.is_nan() {
        return distance;
    }
    match text::locale_compare(&left.id, &right.id) {
        std::cmp::Ordering::Less => -1.0,
        std::cmp::Ordering::Equal => 0.0,
        std::cmp::Ordering::Greater => 1.0,
    }
}

/// Подсказки по реквизиту: только виды с наградой по каталогу, только под
/// русской подписью; герою-читателю дальше соседней клетки строка говорит,
/// что надо подойти. Одноимённые предметы дают одну строку — по ближайшему.
fn prop_hints(room: &Value, actor_id: &str) -> Vec<Hint> {
    let props = array(path(Some(room), &["scene", "map", "props"]));
    let cell = reader_hero(room, actor_id).and_then(|_| hero_cell(room, actor_id));
    let cell_json = cell.map(|(x, y)| json!({ "x": x, "y": y }));
    let mut nearest: IndexMap<String, PropHint> = IndexMap::new();
    for prop in props {
        if !js::is_true(field(Some(prop), "interactive")) {
            continue;
        }
        let asset_id = field(Some(prop), "assetId");
        let Some(catalog) = scene_interaction_catalog_entry(asset_id) else { continue };
        if !REWARD_BEARING_KINDS.contains(catalog.kind) {
            continue;
        }
        let label = clean_str(&capitalized(&scene_object_label_for(asset_id)), 60);
        if label.is_empty() {
            continue;
        }
        let verbs: Vec<String> = match path(Some(prop), &["interaction", "verbs"]) {
            Some(Value::Array(verbs)) => verbs.iter().map(|verb| js::string(Some(verb))).collect(),
            _ => catalog.verbs.iter().map(|verb| (*verb).to_string()).collect(),
        };
        let Some((verb, phrase)) = VERB_PHRASES.iter().find(|(verb, _)| verbs.iter().any(|candidate| candidate == verb)) else { continue };
        let distance = cell_json.as_ref().map_or(f64::INFINITY, |cell| scene_object_distance(Some(prop), Some(cell)));
        let point_of_interest = js::is_true(path(Some(prop), &["interaction", "pointOfInterest"]));
        let hint = PropHint {
            id: format!("prop:{}:{verb}", clean(field(Some(prop), "id"), 80)),
            // Приметное — вперёд: точка интереса заметнее рядового ящика.
            priority: if point_of_interest { priority::POI_PROP } else { priority::PROP },
            phrase: format!("Можно {phrase}: {label}"),
            distance: distance.is_finite().then_some(distance),
        };
        let replace = nearest.get(&hint.phrase).is_none_or(|current| prop_hint_order(&hint, current) < 0.0);
        if replace {
            nearest.insert(hint.phrase.clone(), hint);
        }
    }
    nearest
        .into_values()
        .map(|hint| Hint {
            text: if hint.distance.is_some_and(|distance| distance > 1.0) { format!("{} — надо подойти вплотную", hint.phrase) } else { hint.phrase },
            id: hint.id,
            priority: hint.priority,
        })
        .collect()
}

/// Добыча в сцене. Пока герой не дотянулся, сервер не отдал содержимое, и
/// строка зовёт подойти.
fn loot_hints(room: &Value) -> Vec<Hint> {
    array(path(Some(room), &["loot_containers", "containers"]))
        .iter()
        .filter(|container| field(Some(container), "status").and_then(Value::as_str) != Some("emptied") && js::number(field(Some(container), "item_count")) > 0.0)
        .take(MAX_LOOT_HINTS)
        .filter_map(|container| {
            let name = clean(field(Some(container), "name"), 60);
            if name.is_empty() {
                return None;
            }
            let phrase = loot_phrase(&js::s(field(Some(container), "kind")));
            // Имя контейнера уже начинается с вида («Тело: Разбойник»): в
            // строку идёт только то, что после двоеточия.
            let subject = name.find(": ").map_or("", |index| &name[index + 2..]);
            let target = if subject.is_empty() { phrase } else { format!("{phrase}: {subject}") };
            let text = if js::is_true(field(Some(container), "can_inspect")) { format!("Можно {target}") } else { format!("Можно {target} — надо подойти вплотную") };
            Some(Hint { id: format!("loot:{}", clean(field(Some(container), "id"), 80)), priority: 0, text })
        })
        .collect()
}

/// Чужой карман под рукой — одна строка ближайшему; читателю без героя
/// отвечать нечем.
fn theft_hints(room: &Value, actor_id: &str) -> Vec<Hint> {
    if reader_hero(room, actor_id).is_none() {
        return Vec::new();
    }
    let cell = hero_cell(room, actor_id);
    let mut entries: Vec<(&Value, Option<f64>)> = peaceful_scene_npcs(room)
        .into_iter()
        .map(|npc| (npc, feet_between(cell, npc)))
        .filter(|(_, feet)| feet.is_none_or(|feet| feet <= THEFT_HINT_REACH_FEET as f64))
        .collect();
    entries.sort_by(|left, right| {
        let difference = left.1.unwrap_or(f64::INFINITY) - right.1.unwrap_or(f64::INFINITY);
        if difference != 0.0 && !difference.is_nan() {
            return difference.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal);
        }
        text::locale_compare(&js::s(field(Some(left.0), "id")), &js::s(field(Some(right.0), "id")))
    });
    let Some((npc, _)) = entries.first() else { return Vec::new() };
    let name = clean(field(Some(npc), "name"), 60);
    if name.is_empty() {
        return Vec::new();
    }
    vec![Hint {
        id: format!("theft:{}", clean(field(Some(npc), "id"), 80)),
        priority: priority::UNDERWORLD,
        text: format!("Можно незаметно обчистить карманы: {name} (Ловкость рук)"),
    }]
}

/// Монета поверх слов: там, где реплика уже прозвучала, и по кошельку героя.
fn bribe_hints(room: &Value, actor_id: &str) -> Vec<Hint> {
    let Some(hero) = reader_hero(room, actor_id) else { return Vec::new() };
    if currency_to_copper(field(Some(hero), "currency")) < MIN_BRIBE_CP {
        return Vec::new();
    }
    let mut present: IndexMap<String, &Value> = IndexMap::new();
    for npc in peaceful_scene_npcs(room) {
        present.insert(js::s(field(Some(npc), "id")), npc);
    }
    let conversations = array(path(Some(room), &["social", "conversations"]));
    let spoken = conversations.iter().rev().find(|entry| present.contains_key(&js::s(field(Some(entry), "npc_id"))));
    // `present.get(String(spoken.npc_id))` — без `?? ''`.
    let npc = spoken.and_then(|entry| present.get(&js::string(field(Some(entry), "npc_id")))).copied();
    let name = clean(field(npc, "name"), 60);
    if name.is_empty() {
        return Vec::new();
    }
    vec![Hint { id: format!("bribe:{}", clean(field(npc, "id"), 80)), priority: priority::UNDERWORLD, text: format!("Можно подкрепить убеждение монетой: {name}") }]
}

/// Краденое и торговец. Строка никого не называет: скупщик выводится из сида.
fn fence_hints(room: &Value, actor_id: &str) -> Vec<Hint> {
    if array(field(Some(room), "merchants")).is_empty() {
        return Vec::new();
    }
    let hero = reader_hero(room, actor_id);
    let stolen = array(field(hero, "inventory")).iter().any(|item| js::s(field(Some(item), "origin")) == "stolen");
    if !stolen {
        return Vec::new();
    }
    vec![Hint { id: "fence:offer".into(), priority: priority::UNDERWORLD, text: "Можно попробовать сбыть краденое торговцу".into() }]
}

fn npc_hints(room: &Value) -> Vec<Hint> {
    peaceful_scene_npcs(room)
        .into_iter()
        .filter_map(|npc| {
            let name = clean(field(Some(npc), "name"), 60);
            if name.is_empty() {
                return None;
            }
            // Роль режется по слову: прежде подсказка обрывалась «…карты и служа)».
            let full_role = clean(field(Some(npc), "role"), 200);
            let role = if utf16_len(&full_role) <= 40 {
                full_role
            } else {
                let cut = text::replace_first(re!(r"\s+\S*$", "u"), &head_utf16(&full_role, 40), "");
                format!("{}…", text::replace_first(re!(r"[\s,;:—-]+(?:и|а|но)?$", "u"), &cut, ""))
            };
            Some(Hint {
                id: format!("npc:{}", clean(field(Some(npc), "id"), 80)),
                priority: priority::NPC,
                text: if role.is_empty() { format!("Можно заговорить: {name}") } else { format!("Можно заговорить с кем-то из местных: {name} ({role})") },
            })
        })
        .collect()
}

/// Досуг таверны: строка одна. Открытый раунд занимает место безусловно,
/// приглашение за стол — наравне с реквизитом.
fn tavern_hints(room: &Value) -> (Vec<Hint>, Vec<Hint>) {
    let tavern = field(Some(room), "tavern");
    if !js::truthy(tavern) {
        return (Vec::new(), Vec::new());
    }
    let ejected = js::is_true(field(tavern, "ejected"));
    // Открытый раунд разбирается до запрета входа: выставленному остаётся
    // встать из-за стола, и цену подсказка называет числом.
    let round = field(tavern, "round");
    if js::truthy(round) {
        let rival = clean(field(round, "npc_name"), 60);
        let rival = if rival.is_empty() { "соперник".to_string() } else { rival };
        let text = if ejected {
            let stake = number_or(field(round, "stake_cp"), 0.0);
            format!("Отсюда героя выставили: раунд остаётся закрыть — встать из-за стола, и ставка в {} мм со стола достанется сопернику", js::f64_string(stake))
        } else {
            format!("Можно ответить на бросок: {rival} выбросил {}", js::f64_string(number_or(field(round, "npc_total"), 0.0)))
        };
        return (vec![Hint { id: "tavern:answer".into(), priority: priority::TAVERN_ROUND, text }], Vec::new());
    }
    if ejected {
        return (Vec::new(), Vec::new());
    }
    let price = js::f64_string(number_or(field(tavern, "drink_price_cp"), 0.0));
    let opponent = match field(tavern, "opponents") {
        Some(Value::Array(opponents)) => clean(field(opponents.first(), "name"), 60),
        _ => String::new(),
    };
    let text = if opponent.is_empty() { format!("Можно заказать выпивку: {price} мм за кружку") } else { format!("Можно сыграть в кости с местными или заказать выпивку ({price} мм)") };
    (Vec::new(), vec![Hint { id: "tavern:leisure".into(), priority: priority::LEISURE, text }])
}

/// Молитвы и благословения — только когда обращение доступно; святыня
/// перевешивает служителя: молитва бесплатна.
fn blessing_hints(room: &Value) -> Vec<Hint> {
    let blessings = field(Some(room), "blessings");
    if !js::truthy(blessings) || js::is_false(field(blessings, "available")) || js::is_true(field(blessings, "blessed")) {
        return Vec::new();
    }
    let priest = match field(blessings, "priests") {
        Some(Value::Array(priests)) => clean(field(priests.first(), "name"), 60),
        _ => String::new(),
    };
    let shrine = array(path(Some(room), &["scene", "map", "props"])).iter().any(|prop| {
        js::is_true(field(Some(prop), "interactive")) && array(path(Some(prop), &["interaction", "verbs"])).iter().any(|verb| js::string(Some(verb)) == "pray")
    });
    if !shrine && priest.is_empty() {
        return Vec::new();
    }
    let text = if shrine {
        format!("Можно помолиться у святыни: проверка Религии, СЛ {}, раз в сутки", js::f64_string(number_or(field(blessings, "prayer_dc"), 12.0)))
    } else {
        format!("Можно попросить благословение: {priest} (пожертвование {} мм)", js::f64_string(number_or(field(blessings, "donation_cp"), 0.0)))
    };
    vec![Hint { id: "blessing:offer".into(), priority: priority::LEISURE, text }]
}

/// Почта отряда: пока курьер в пути — кому и куда поехало; иначе приглашение
/// написать, если адресаты известны.
fn letter_hints(room: &Value) -> Result<Vec<Hint>, ActionHintsError> {
    let post = field(Some(room), "courier_letters");
    if !js::truthy(post) {
        return Ok(Vec::new());
    }
    let letters = array(field(post, "letters"));
    if let Some(travelling) = letters.iter().find(|letter| field(Some(letter), "status").and_then(Value::as_str) == Some("in_transit")) {
        let addressee = clean(field(Some(travelling), "addressee_name"), 60);
        let addressee = if addressee.is_empty() { "адресат".to_string() } else { addressee };
        let place = field(Some(travelling), "place_name");
        let place = if js::truthy(place) { format!(", {}", clean(place, 40)) } else { String::new() };
        return Ok(vec![Hint {
            id: "letter:in-transit".into(),
            priority: priority::LETTER,
            text: format!("Курьер везёт письмо: {addressee}{place} — ответа ждать не раньше, чем пройдёт ночь"),
        }]);
    }
    let addressees: Vec<&Value> = array(field(post, "addressees")).iter().filter(|entry| !js::is_true(field(Some(entry), "unreachable"))).collect();
    let Some(nearest) = addressees.first().copied() else { return Ok(Vec::new()) };
    // `nearest.name` у `null` в JS — TypeError: отсев `entry?.unreachable`
    // пропускает `null`, и первым адресатом он и становится.
    if nearest.is_null() {
        return Err(ActionHintsError { message: "Cannot read properties of null (reading 'name')".into() });
    }
    Ok(vec![Hint {
        id: "letter:write".into(),
        priority: priority::LETTER,
        text: format!(
            "Можно написать письмо: {} — курьер возьмёт {} мм",
            clean(field(Some(nearest), "name"), 60),
            js::f64_string(number_or(field(Some(nearest), "fee_cp"), 0.0))
        ),
    }])
}

/// `beastReachRow(entry, actorId).out_of_reach === true`: строка досягаемости
/// героя-читателя; отсутствующей строке подсказка не верит — «далеко».
///
/// Строка — только собственная (`Object.hasOwn`): ключ прототипа — «далеко».
/// У массива строк — индекс.
fn beast_out_of_reach(entry: &Value, actor_id: &str) -> bool {
    let row = match field(Some(entry), "reach_by_hero") {
        Some(Value::Object(rows)) => match rows.get(actor_id) {
            Some(row) => Some(row),
            None => None,
        },
        Some(Value::Array(rows)) => {
            if js::is_array_index_key(actor_id) {
                actor_id.parse::<usize>().ok().and_then(|index| rows.get(index))
            } else {
                None
            }
        }
        _ => None,
    };
    match row {
        Some(Value::Object(row)) => js::is_true(row.get("out_of_reach")),
        Some(Value::Array(_)) => false,
        _ => true,
    }
}

/// Зверь рядом: строка только у того, к кому можно подойти сейчас; дальнему
/// — «сначала подойти». Досягаемость меряется по герою-читателю.
fn beast_hints(room: &Value, actor_id: &str) -> Vec<Hint> {
    let candidates = array(path(Some(room), &["beasts", "candidates"]));
    let available: Vec<&Value> = candidates.iter().filter(|entry| js::truthy(Some(entry)) && !js::truthy(field(Some(entry), "blocked_reason"))).collect();
    let name_of = |entry: &Value| {
        let name = clean(field(Some(entry), "name"), 60);
        if name.is_empty() {
            "зверь".to_string()
        } else {
            name
        }
    };
    let Some(reachable) = available.iter().copied().find(|entry| !beast_out_of_reach(entry, actor_id)) else {
        let Some(distant) = available.first().copied() else { return Vec::new() };
        return vec![Hint {
            id: format!("beast:{}", clean(field(Some(distant), "id"), 80)),
            priority: priority::LEISURE,
            text: format!("Можно подойти вплотную к зверю: {} — с расстояния руку не протянуть", name_of(distant)),
        }];
    };
    let name = name_of(reachable);
    let text = if field(Some(reachable), "stage").and_then(Value::as_str) == Some("calmed") {
        format!("Можно покормить: {name} успокоен и ждёт еды с руки")
    } else {
        format!("Можно попробовать успокоить: {name} (Уход за животными, СЛ {})", js::f64_string(number_or(field(Some(reachable), "difficulty"), 0.0)))
    };
    vec![Hint { id: format!("beast:{}", clean(field(Some(reachable), "id"), 80)), priority: priority::LEISURE, text }]
}

/// Двор короля сценария: кошель и вещь из оружейной, пока герой их не взял.
fn court_hints(room: &Value) -> Vec<Hint> {
    let court = field(Some(room), "scenario_court");
    if !js::truthy(court) {
        return Vec::new();
    }
    let mut hints = Vec::new();
    if js::is_true(field(court, "purse_available")) {
        hints.push(Hint { id: "court:purse".into(), priority: priority::COURT, text: "Можно получить кошель короля — напишите «беру кошель короля»".into() });
    }
    let items: Vec<String> = array(field(court, "armory_items")).iter().map(|name| clean(Some(name), 60)).filter(|name| !name.is_empty()).collect();
    if js::is_true(field(court, "armory_available")) && !items.is_empty() {
        hints.push(Hint {
            id: "court:armory".into(),
            priority: priority::COURT,
            text: format!("Можно взять одну вещь из королевской оружейной: {} — напишите «беру {} из оружейной»", items.join(", "), text::lower(&items[0])),
        });
    }
    hints
}

/// Цель отряда; на промежуточной точке маршрута — оба способа идти дальше.
fn objective_hint(room: &Value) -> Vec<Hint> {
    let scene = field(Some(room), "scene");
    let onward = clean_str(&pending_onward_target(scene), 60);
    if !onward.is_empty() {
        return vec![Hint {
            id: "objective".into(),
            priority: priority::OBJECTIVE,
            text: format!("Цель отряда: продолжить путь к «{onward}» — нажмите «Решение группы» или напишите «продолжаем путь»"),
        }];
    }
    let objective = clean(field(scene, "objective"), 90);
    if objective.is_empty() {
        return Vec::new();
    }
    vec![Hint { id: "objective".into(), priority: priority::OBJECTIVE, text: format!("Цель отряда: {objective}") }]
}

/// Запертая дверь под рукой у того, кто владеет инструментом (признак
/// приезжает готовым в `room.lockpicking.proficient`).
fn lockpick_hints(room: &Value) -> Vec<Hint> {
    if !js::is_true(path(Some(room), &["lockpicking", "proficient"])) {
        return Vec::new();
    }
    let doors = array(path(Some(room), &["scene", "map", "doors"]));
    if !doors.iter().any(|door| js::string(field(Some(door), "state")) == "locked") {
        return Vec::new();
    }
    vec![Hint { id: "lockpick:door".into(), priority: priority::PROP, text: "Можно вскрыть замок отмычкой: запертая дверь".into() }]
}

/// Выход из сцены: дверь на публичной карте уже отфильтрована по раскрытым клеткам.
fn exit_hints(room: &Value) -> Vec<Hint> {
    if array(path(Some(room), &["scene", "map", "doors"])).is_empty() {
        return Vec::new();
    }
    vec![Hint { id: "exit".into(), priority: priority::EXIT, text: "Можно уйти из этого места через дверь".into() }]
}

/// `suggestedActionsFor(room, actorId)`: подсказки для **уже
/// спроецированной** комнаты.
///
/// Порядок детерминирован: вид строки, затем идентификатор. Сначала места
/// занимают те, кого вытеснять нельзя (добыча, двор, раунд костей,
/// собеседники, цель, выход); реквизит, замок, досуг, молитва, зверь, почта и
/// изнанка забирают только остаток и не больше `MAX_PROP_HINTS`. `actor_id`
/// — герой, которому показывается панель (`String(actorId ?? '')`).
pub fn suggested_actions_for(room: Option<&Value>, actor_id: Option<&Value>) -> Result<Vec<ActionHint>, ActionHintsError> {
    let Some(room) = room.filter(|room| room.is_object() || room.is_array()) else { return Ok(Vec::new()) };
    if js::is_true(path(Some(room), &["mechanics", "combat", "active"])) {
        return Ok(Vec::new());
    }
    let actor_id = js::s(actor_id);
    let mut seen: HashSet<String> = HashSet::new();
    let mut ordered = |mut hints: Vec<Hint>| -> Vec<Hint> {
        sort_hints(&mut hints);
        hints.into_iter().filter(|hint| !hint.text.is_empty() && seen.insert(hint.text.clone())).collect()
    };
    let (urgent, leisure) = tavern_hints(room);
    let mut reserved_input = loot_hints(room);
    reserved_input.extend(court_hints(room));
    reserved_input.extend(urgent);
    reserved_input.extend(npc_hints(room));
    reserved_input.extend(objective_hint(room));
    reserved_input.extend(exit_hints(room));
    let reserved = ordered(reserved_input);
    let budget = MAX_PROP_HINTS.min(MAX_ACTION_HINTS.saturating_sub(reserved.len()));
    let mut props_input = prop_hints(room, &actor_id);
    props_input.extend(lockpick_hints(room));
    props_input.extend(leisure);
    props_input.extend(blessing_hints(room));
    props_input.extend(beast_hints(room, &actor_id));
    props_input.extend(letter_hints(room)?);
    // Изнанка: карман меряется от героя-читателя, кошелёк и краденое — его.
    props_input.extend(theft_hints(room, &actor_id));
    props_input.extend(bribe_hints(room, &actor_id));
    props_input.extend(fence_hints(room, &actor_id));
    let mut hints: Vec<Hint> = ordered(props_input).into_iter().take(budget).collect();
    hints.extend(reserved);
    sort_hints(&mut hints);
    Ok(hints.into_iter().take(MAX_ACTION_HINTS).map(|hint| ActionHint { id: hint.id, text: hint.text }).collect())
}

/// Подсказки в форме JS: массив `{ id, text }`.
pub fn suggested_actions_json(room: Option<&Value>, actor_id: Option<&Value>) -> Result<Value, ActionHintsError> {
    suggested_actions_for(room, actor_id).map(|hints| Value::Array(hints.iter().map(ActionHint::to_json).collect()))
}

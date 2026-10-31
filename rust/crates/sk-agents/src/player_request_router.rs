//! Перенос `server/player-request-router.mjs`: кому из ролей отдать реплику
//! игрока и ответы, которые даёт сам сервер без модели.
//!
//! [`PLAYER_REQUEST_ROLES`] — роли и, только у исполняемых моделью, версия
//! контракта (`prompt_id` — метаданные, а не привязка промпта). Хранитель знаний
//! (`worldkeeper`) — детерминированный [`answer_known_lore`], `game_master` —
//! Rules Engine. Здесь же вопросы ведущему за столом ([`answer_table_question`],
//! [`answer_visible_scene`]), карточки голосования об уходе
//! ([`propose_agent_interaction`], [`propose_routed_travel`]), честный ответ на
//! неизвестное место ([`unknown_destination_reply`]) и исход решения группы
//! ([`resolve_party_decision`]).

use std::collections::HashMap;
use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexSet;
use sk_core::{js, re, text};
use sk_scenario::party_exit_intent::{
    abandonable_quest, detect_party_exit_request, exit_context_from_state, objective_calls_to, onward_route_exit_request, party_destination_label, travel_destination_is_place,
    unrecognized_destination, ExitOptions, PartyExitRequest,
};

use crate::scene_architect::{interpret_resolved_party_decision, known_destinations_from};

/// Сверка «цель называет место» живёт в `party-exit-intent` (её читает и
/// архитектор сцен).
pub use sk_scenario::party_exit_intent::objective_names_destination;

/// `PLAYER_REQUEST_ROLES`.
pub static PLAYER_REQUEST_ROLES: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "worldkeeper": { "id": "worldkeeper", "purpose": "Лор, память мира и знания героя" },
        "director": { "id": "director", "prompt_id": ["director/v4_story", "director/v4_chaos"], "purpose": "Темп, развилки, групповые решения и переходы сцен" },
        "game_master": { "id": "game_master", "purpose": "Правила, проверки, кубики и игровые инструменты" },
        "narrator": { "id": "narrator", "prompt_id": "narrator/v14", "purpose": "Финальное повествование из подтверждённых результатов" },
        "map_architect": { "id": "map_architect", "prompt_id": "map_architect/v8", "purpose": "Динамическая архитектура новой локации и игровой карты" },
        "action_adjudicator": { "id": "action_adjudicator", "prompt_id": "action_adjudicator/v10", "purpose": "Разбор свободного действия: маршрут заявки, цель, средство, применимый навык и цена провала" },
    })
});

/// `PARTY_OPTION_LIMIT`: подпись варианта голосования обрезается сервером до 100 знаков.
pub const PARTY_OPTION_LIMIT: usize = 100;
const PARTY_ROUTE_LIMIT: usize = 64;
const VISIBLE_SCENE_LIMIT: usize = 8;

// ---------------------------------------------------------------------------
// Приведения JS
// ---------------------------------------------------------------------------

type Regex = sk_core::fancy_regex::Regex;

fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value?.as_object()?.get(key)
}

fn path<'a>(value: Option<&'a Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().try_fold(value?, |current, key| get(Some(current), key))
}

fn array(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

fn coalesce<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    match first {
        Some(value) if !value.is_null() => Some(value),
        _ => second,
    }
}

fn or<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    if js::truthy(first) {
        first
    } else {
        second
    }
}

fn is_str(value: Option<&Value>, expected: &str) -> bool {
    matches!(value, Some(Value::String(text)) if text == expected)
}

fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (None, None) | (Some(Value::Null), Some(Value::Null)) => true,
        _ => false,
    }
}

fn units(source: &str) -> Vec<u16> {
    source.encode_utf16().collect()
}

fn from_units(source: &[u16]) -> String {
    String::from_utf16_lossy(source)
}

fn len16(source: &str) -> usize {
    source.encode_utf16().count()
}

fn head_utf16(source: &str, max: usize) -> String {
    let all = units(source);
    from_units(&all[..max.min(all.len())])
}

fn slice16(source: &str, start: usize) -> String {
    let all = units(source);
    from_units(&all[start.min(all.len())..])
}

/// `text.lastIndexOf(char)` в единицах UTF-16.
fn last_index16(source: &[u16], ch: char) -> Option<usize> {
    let mut buffer = [0u16; 2];
    let needle = ch.encode_utf16(&mut buffer);
    if needle.len() != 1 {
        return None;
    }
    source.iter().rposition(|unit| *unit == needle[0])
}

/// `String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)`.
fn visible_text(value: Option<&Value>, maximum: usize) -> String {
    visible_str(&js::s(value), maximum)
}

fn visible_str(value: &str, maximum: usize) -> String {
    head_utf16(&text::squash_spaces(&text::nfkc(value)), maximum)
}

fn sv(value: &str) -> Value {
    Value::String(value.to_string())
}

/// `text.charAt(0).toLocaleUpperCase('ru') + text.slice(1)`.
fn upper_first(value: &str) -> String {
    text::capitalize(value)
}

/// `text.charAt(0).toLocaleLowerCase('ru') + text.slice(1)`.
fn lower_first(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_lowercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// `toLocaleLowerCase('ru').replace(/ё/gu, 'е')`.
fn fold(value: &str) -> String {
    text::lower(value).replace('ё', "е")
}

/// Законченное предложение без двойной точки.
fn as_sentence(value: Option<&Value>, maximum: usize) -> String {
    let text_value = text::replace_first(re!(r"[\s.!?…;,:]+$", "u"), &visible_text(value, maximum), "");
    if text_value.is_empty() {
        String::new()
    } else {
        format!("{}.", upper_first(&text_value))
    }
}

fn test(regex: &Regex, value: &str) -> bool {
    text::test(regex, value)
}

/// `split(re)` по регулярному выражению.
fn split(regex: &Regex, value: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut last = 0;
    let mut start = 0;
    while start <= value.len() {
        match regex.find_from_pos(value, start) {
            Ok(Some(found)) => {
                if found.end() == found.start() {
                    // Пустое совпадение: шаг на символ, как в JS.
                    match value[found.start()..].chars().next() {
                        Some(ch) => {
                            start = found.start() + ch.len_utf8();
                            continue;
                        }
                        None => break,
                    }
                }
                parts.push(value[last..found.start()].to_string());
                last = found.end();
                start = found.end();
            }
            _ => break,
        }
    }
    parts.push(value[last..].to_string());
    parts
}

fn empty_effects() -> Value {
    json!({ "roll": null, "reveal": [], "spawn": [], "objective": null, "grantItems": [], "scene": null, "interaction": null })
}

fn reply(narration: String, model: &str) -> Value {
    json!({ "narration": narration, "effects": empty_effects(), "provider": "AgentWorldkeeper", "model": model, "turn_consumed": false, "action_kind": "free" })
}

// ---------------------------------------------------------------------------
// Видимое в сцене
// ---------------------------------------------------------------------------

/// NPC, которых герой видит в текущей сцене.
fn present_scene_npcs(state: &Value) -> Vec<Value> {
    let location = text::lower(&visible_text(path(Some(state), &["scene", "location"]), 160));
    let profiles: Vec<&Value> = array(path(Some(state), &["social", "npcs"]))
        .iter()
        .filter(|npc| {
            let visibility = js::string(Some(coalesce(get(Some(npc), "visibility"), None).unwrap_or(&sv("party"))));
            ["party", "public"].contains(&visibility.as_str()) && !js::is_false(get(Some(npc), "available"))
        })
        .collect();
    let present: Vec<&Value> = array(get(Some(state), "scene_npcs")).iter().filter(|npc| !js::is_false(get(Some(npc), "alive"))).collect();
    let mut by_id: HashMap<String, &Value> = HashMap::new();
    for npc in &profiles {
        by_id.insert(js::string(get(Some(npc), "id")), npc);
    }
    let from_scene: Vec<Value> = present
        .iter()
        .map(|npc| {
            let profile = by_id.get(&js::string(get(Some(npc), "id"))).copied();
            let mut merged = profile.and_then(Value::as_object).cloned().unwrap_or_default();
            if let Value::Object(own) = npc {
                for (key, value) in own {
                    merged.insert(key.clone(), value.clone());
                }
            }
            merged.insert("public_summary".into(), coalesce(get(profile, "public_summary"), None).cloned().unwrap_or_else(|| sv("")));
            Value::Object(merged)
        })
        .collect();
    let scene_ids: IndexSet<String> = from_scene.iter().map(|npc| js::string(npc.get("id"))).collect();
    let from_profiles = profiles.into_iter().filter(|npc| {
        !scene_ids.contains(&js::string(get(Some(npc), "id"))) && !location.is_empty() && text::lower(&visible_text(get(Some(npc), "location"), 160)) == location
    });
    from_scene.into_iter().chain(from_profiles.cloned()).filter(|npc| !visible_text(npc.get("name"), 80).is_empty()).collect()
}

fn ru_word_stem(word: &str) -> String {
    let length = len16(word) as i64;
    let take = 3.max(5.min(length - 1)) as usize;
    head_utf16(&fold(word), take)
}

fn words_of(value: &str) -> Vec<String> {
    split(re!(r"[^\p{L}-]+", "u"), &fold(value)).into_iter().filter(|word| len16(word) >= 3).collect()
}

fn mentioned_npc<'a>(text_value: &str, npcs: &'a [Value]) -> Option<&'a Value> {
    let words = words_of(text_value);
    let mut scored: Vec<(&Value, usize)> = npcs
        .iter()
        .map(|npc| {
            let parts: Vec<String> = split(re!(r"\s+", "u"), &visible_text(npc.get("name"), 80)).into_iter().filter(|part| len16(part) >= 3).collect();
            let hits = parts.iter().filter(|part| words.iter().any(|word| word.starts_with(&ru_word_stem(part)))).count();
            (npc, hits)
        })
        .filter(|(_, hits)| *hits > 0)
        .collect();
    scored.sort_by(|left, right| right.1.cmp(&left.1));
    scored.first().map(|(npc, _)| *npc)
}

fn npc_who_question(value: &str) -> bool {
    test(re!(r"^(?:а\s+|и\s+|ну\s+)?кто\s+(?:так(?:ой|ая|ие)|это|она|он)(?![\p{L}\p{M}])", "iu"), value)
}

fn weather_question(value: &str) -> bool {
    test(re!(r"(?<![\p{L}\p{M}])(?:погод\p{L}*|дожд\p{L}*\s+(?:ли|ещ[её])|небо|ветер|холодно|тепло|жарко)(?![\p{L}\p{M}])", "iu"), value)
}

fn time_question(value: &str) -> bool {
    test(
        re!(r"(?<![\p{L}\p{M}])(?:который\s+час|сколько\s+(?:сейчас\s+)?времени|какое\s+(?:сейчас\s+)?время|время\s+суток|сейчас\s+(?:утро|день|вечер|ночь)|какой\s+(?:сейчас\s+)?день)(?![\p{L}\p{M}])", "iu"),
        value,
    )
}

fn hypothetical_question(value: &str) -> bool {
    test(re!(r"^(?:а\s+)?(?:что\s+(?:будет|если|случится)|а\s+если|можно\s+ли|могу\s+ли|сможет\s+ли|если\s+я|если\s+мы|получится\s+ли|выйдет\s+ли|как\s+(?:мне|нам)\s+)", "iu"), value)
}

/// `answerTableQuestion(action, state, { actorId, worldClock })`: вопрос
/// ведущему за столом, который не является заявкой. `None` — не такой вопрос.
pub fn answer_table_question(action: &str, state: &Value, world_clock: Option<&Value>) -> Option<Value> {
    let text_value = visible_str(action, 400);
    if text_value.is_empty() || hypothetical_question(&text_value) {
        return None;
    }
    let npcs = present_scene_npcs(state);
    if npc_who_question(&text_value) {
        if let Some(npc) = mentioned_npc(&text_value, &npcs) {
            let role = visible_text(npc.get("role"), 120);
            let summary = as_sentence(npc.get("public_summary"), 300);
            let head = format!("{}{}.", visible_text(npc.get("name"), 80), if role.is_empty() { String::new() } else { format!(" — {}", lower_first(&role)) });
            let narration = [head, summary].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ");
            return Some(reply(narration, "npc-public-profile"));
        }
    }
    if let Some(clock) = world_clock.filter(|clock| js::truthy(Some(clock))) {
        let asks_time = time_question(&text_value);
        let asks_weather = weather_question(&text_value);
        if asks_time || asks_weather {
            let clock = Some(clock);
            let mut parts = Vec::new();
            if asks_time {
                let label = text::lower(&visible_text(get(clock, "time_of_day_label"), 40));
                parts.push(format!("Сейчас {}, около {}.", if label.is_empty() { "день".to_string() } else { label }, visible_text(get(clock, "clock"), 10)));
            }
            if asks_weather {
                parts.push(if js::truthy(get(clock, "indoors")) {
                    format!("Вы под крышей; снаружи — {}.", text::lower(&visible_text(get(clock, "weather_label"), 60)))
                } else {
                    as_sentence(or(get(clock, "weather_summary"), get(clock, "weather_label")), 200)
                });
            }
            return Some(reply(parts.into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" "), "world-clock"));
        }
    }
    let presence = re!(r"^(?:а\s+|и\s+|ну\s+)?(?:есть\s+ли\s+(?:тут|здесь|рядом)?|тут\s+есть|здесь\s+есть|где\s+(?:тут|здесь)\s+(?:можно|есть))\s*(.*)$", "iu").captures(&text_value).ok().flatten();
    let subject = presence.as_ref().map(|captures| captures.get(1).map(|group| group.as_str().to_string()).unwrap_or_default()).unwrap_or_default();
    let subject = text::replace_first(re!(r"[?!.]+$", "u"), &visible_str(&subject, 120), "");
    let informed: Vec<&Value> = npcs.iter().filter(|npc| !visible_text(npc.get("role"), 120).is_empty()).collect();
    let ask_who = if informed.is_empty() {
        " Можно посмотреть самим или поискать того, кто видел.".to_string()
    } else {
        let names: Vec<String> = informed.iter().take(2).map(|npc| format!("{} — {}", visible_text(npc.get("name"), 80), text::lower(&visible_text(npc.get("role"), 80)))).collect();
        format!(" Можно посмотреть самим или спросить: {}.", names.join("; "))
    };
    if presence.is_some() && !subject.is_empty() {
        let stem = ru_word_stem(&subject);
        let mentioned = npcs.iter().find(|npc| {
            !stem.is_empty() && fold(&visible_str(&format!("{} {}", js::string(npc.get("role")), js::string(npc.get("name"))), 200)).contains(&stem)
        });
        if let Some(npc) = mentioned {
            return Some(reply(format!("Да: {} — {}.", visible_text(npc.get("name"), 80), text::lower(&visible_text(npc.get("role"), 120))), "visible-scene"));
        }
        return Some(reply(format!("Пока на глаза не попадается.{ask_who}"), "visible-scene"));
    }
    if test(re!(r"\?\s*$", "u"), &text_value) || test(re!(r"^(?:а\s+)?(?:сколько|где|когда|куда|откуда|какой|какая|какое|какие|кто|что|почему|зачем)(?![\p{L}\p{M}])", "iu"), &text_value) {
        return Some(reply(format!("Этого пока никто не сказал и вы сами не видели.{ask_who}"), "unknown-to-party"));
    }
    None
}

fn visible_scene_actor_labels(state: &Value) -> Vec<String> {
    let mut labels: Vec<String> = Vec::new();
    for actor in array(get(Some(state), "scene_npcs")).iter().chain(array(get(Some(state), "enemies"))) {
        if js::is_false(get(Some(actor), "alive")) {
            continue;
        }
        let name = visible_text(coalesce(get(Some(actor), "name"), get(Some(actor), "character")), 80);
        if name.is_empty() {
            continue;
        }
        let role = visible_text(get(Some(actor), "role"), 60);
        let label = if role.is_empty() { name } else { format!("{name} — {}", lower_first(&role)) };
        if !labels.contains(&label) {
            labels.push(label);
        }
        if labels.len() >= VISIBLE_SCENE_LIMIT {
            break;
        }
    }
    labels
}

fn prop_broken(prop: &Value) -> bool {
    let state = js::s(get(Some(prop), "state"));
    state == "broken" || state == "destroyed"
}

fn visible_scene_prop_labels(state: &Value) -> Vec<String> {
    let mut ranked: Vec<(String, bool, usize)> = array(path(Some(state), &["scene", "map", "props"]))
        .iter()
        .enumerate()
        .filter(|(_, prop)| !prop_broken(prop))
        .filter_map(|(index, prop)| {
            let label = visible_str(&sk_tactical::scene_interactions::scene_object_label_for(get(Some(prop), "assetId")), 60);
            (!label.is_empty()).then(|| (label, js::is_true(path(Some(prop), &["interaction", "pointOfInterest"])), index))
        })
        .collect();
    ranked.sort_by(|left, right| right.1.cmp(&left.1).then(left.2.cmp(&right.2)));
    let mut labels: Vec<String> = Vec::new();
    for (label, _, _) in ranked {
        if labels.contains(&label) {
            continue;
        }
        labels.push(label);
        if labels.len() >= VISIBLE_SCENE_LIMIT {
            break;
        }
    }
    labels
}

/// `answerVisibleScene(action, state)`: ответ о видимой части текущей сцены.
/// `state` — уже проекция игрока.
pub fn answer_visible_scene(action: &str, state: &Value) -> Option<Value> {
    if !sk_story::intent_parser::is_scene_observation_request(Some(&sv(action))) {
        return None;
    }
    let location_only = test(re!(r"^где\s", "iu"), &visible_str(action, 160));
    let scene = get(Some(state), "scene");
    let location = visible_text(or(get(scene, "location"), get(scene, "title")), 160);
    let title = visible_text(get(scene, "title"), 160);
    let mood = visible_text(get(scene, "mood"), 160);
    let actors = visible_scene_actor_labels(state);
    let props = visible_scene_prop_labels(state);
    let mut sentences: Vec<String> = Vec::new();
    if location_only {
        if !location.is_empty() {
            sentences.push(format!("Сейчас вы здесь: {location}."));
        } else if !title.is_empty() {
            sentences.push(format!("Сейчас вы здесь: {title}."));
        }
    } else {
        if !location.is_empty() || !title.is_empty() {
            sentences.push(as_sentence(Some(&sv(if location.is_empty() { &title } else { &location })), 400));
        }
        if !mood.is_empty() {
            sentences.push(as_sentence(Some(&sv(&mood)), 200));
        }
        if !actors.is_empty() {
            sentences.push(format!("Рядом {}: {}.", if actors.len() == 1 { "тот, кого видно сразу" } else { "те, кого видно сразу" }, actors.join("; ")));
        }
        if !props.is_empty() {
            sentences.push(format!("Вокруг: {}.", props.join(", ")));
        }
        if actors.is_empty() && props.is_empty() {
            sentences.push("Ничего примечательного на виду нет.".into());
        }
    }
    if sentences.is_empty() {
        sentences.push("Текущее место пока не названо.".into());
    }
    Some(reply(sentences.join(" "), "visible-scene"))
}

// ---------------------------------------------------------------------------
// Роли
// ---------------------------------------------------------------------------

fn director_request(value: &str) -> bool {
    test(re!(r"(?:покида|уходим|маршрут|куда\s+дальше|голосован|вместе\s+реш|цель\s+достиг|следующ\w*\s+локац|\[РЕШЕНИЕ ГРУППЫ\]|\[ГЛОБАЛЬНАЯ КАРТА\])", "iu"), value)
}

fn fate_request(value: &str) -> bool {
    test(re!(r"(?:пусть|пускай|давайте|может)\s+(?:решит|определит|бросим)\s+(?:кубик|кость)|кубик\s+судьбы", "iu"), value)
}

fn lore_request(value: &str) -> bool {
    test(re!(r"(?:лор|легенд|предани|истори[яию]|что\s+(?:я|мы)\s+(?:уже\s+|вообще\s+)?зна|кто\s+так|что\s+так|расскажи\s+(?:мне\s+)?(?:о|об|про)|помню\s+ли)", "iu"), value)
}

fn rules_request(value: &str) -> bool {
    test(re!(r"(?:правил|можно\s+ли|провер|брос|куб|атак|урон|заклин|спасброс|инициатив|класс\s+брони)", "iu"), value)
}

fn direction_request(value: &str) -> bool {
    test(
        re!(r"(?:куда\s+(?:нам\s+)?(?:идти|пойти|уходить|направляться|двигаться)(?:\s+дальше|\s+отсюда|\s+по\s+заданию)?|куда\s+по\s+заданию|что\s+делать\s+дальше|^(?:(?:а|и|ну)\s+)*что\s+(?:теперь|дальше)\s*\??$)", "iu"),
        value,
    )
}

fn npc_speech_request(value: &str) -> bool {
    test(
        re!(r"(?<![\p{L}\p{M}])(?:спрашиваю|спросим|расспрашиваю|расспросим|говорю|говорим|обращаюсь|обращаемся|прошу|просим|рассказываю|рассказываем|разговариваю|беседую|узнаю\s+у|интересуюсь\s+у)(?![\p{L}\p{M}])", "iu"),
        value,
    )
}

/// `selectAgentRole(action)`: `director`, `worldkeeper` или `game_master`.
pub fn select_agent_role(action: &str) -> &'static str {
    let text_value = text::nfkc(action);
    if director_request(&text_value) || fate_request(&text_value) {
        return "director";
    }
    if lore_request(&text_value) {
        return "worldkeeper";
    }
    if rules_request(&text_value) {
        return "game_master";
    }
    "director"
}

/// `roleAllowsWorldTools(role)`.
pub fn role_allows_world_tools(role: &str) -> bool {
    role != "worldkeeper"
}

// ---------------------------------------------------------------------------
// Подписи голосования
// ---------------------------------------------------------------------------

/// `partyOptionLabel(value, limit)`: подпись варианта в пределах лимита без
/// оборванной кавычки.
pub fn party_option_label(value: Option<&Value>, limit: usize) -> String {
    let text_value = text::squash_spaces(&js::s(value));
    let all = units(&text_value);
    if all.len() <= limit {
        return text_value;
    }
    let mut cut: Vec<u16> = all[..limit].to_vec();
    if all.get(limit) != Some(&u16::from(b' ')) {
        if let Some(space) = last_index16(&cut, ' ').filter(|space| *space > 0) {
            cut.truncate(space);
        }
    }
    let open = last_index16(&cut, '«');
    let close = last_index16(&cut, '»');
    if let Some(open) = open {
        if close.is_none_or(|close| open > close) {
            cut.truncate(open);
        }
    }
    let trimmed = text::trim(&from_units(&cut)).to_string();
    text::trim(&text::replace_first(re!(r"\s+(?:в|во|на|к|ко|до|из|от)$", "iu"), &trimmed, "")).to_string()
}

fn short_label_part(value: &str, room: i64, keep_quotes: bool) -> String {
    let whole = text::squash_spaces(value);
    if keep_quotes && len16(&whole) as i64 <= room {
        return whole;
    }
    let plain = text::trim(&text::replace_all(re!(r"[«»]", "gu"), &whole, "")).to_string();
    if len16(&plain) as i64 <= room {
        return plain;
    }
    let cut = head_utf16(&plain, 1.max(room - 1) as usize);
    let space = last_index16(&units(&cut), ' ').map_or(-1, |space| space as i64);
    let kept = if space as f64 > room as f64 / 2.0 { head_utf16(&cut, space as usize) } else { cut };
    format!("{}…", text::trim_end(&kept))
}

fn fit_route_phrase(phrase: &str, limit: usize) -> String {
    let text_value = text::squash_spaces(phrase);
    if len16(&text_value) <= limit {
        return text_value;
    }
    let quoted = re!(r"^(\S+ )«([^»]*)»$", "u").captures(&text_value).ok().flatten().map(|captures| {
        (captures.get(1).map(|group| group.as_str().to_string()).unwrap_or_default(), captures.get(2).map(|group| group.as_str().to_string()).unwrap_or_default())
    });
    let lead = match &quoted {
        Some((lead, _)) => lead.clone(),
        None => text::capture(re!(r"^\S+ ", "u"), &text_value, 0).unwrap_or_default(),
    };
    let body = match &quoted {
        Some((_, body)) => body.clone(),
        None => slice16(&text_value, len16(&lead)),
    };
    let room = 1.max(limit as i64 - len16(&lead) as i64 - if quoted.is_some() { 2 } else { 0 }) as usize;
    let mut kept = String::new();
    for word in body.split(' ') {
        let next = if kept.is_empty() { word.to_string() } else { format!("{kept} {word}") };
        if len16(&next) > room {
            break;
        }
        kept = next;
    }
    let kept = {
        let stripped = text::replace_first(re!(r"\s+(?:в|во|на|к|ко|до|из|от|у|по|с|со|за|и)$", "iu"), &kept, "");
        if stripped.is_empty() {
            head_utf16(&body, room)
        } else {
            stripped
        }
    };
    if quoted.is_some() {
        format!("{lead}«{kept}»")
    } else {
        format!("{lead}{kept}")
    }
}

fn leave_label(from: &str, phrase: &str) -> String {
    if phrase.is_empty() {
        return if from.is_empty() {
            "Покинуть подземелье".into()
        } else {
            format!("Покинуть «{}»", short_label_part(from, PARTY_OPTION_LIMIT as i64 - len16("Покинуть «»") as i64, true))
        };
    }
    let route = fit_route_phrase(phrase, PARTY_ROUTE_LIMIT);
    if from.is_empty() {
        return format!("Уходим из подземелья и идём {route}");
    }
    let room = PARTY_OPTION_LIMIT as i64 - len16("Уходим из «» и идём ") as i64 - len16(&route) as i64;
    format!("Уходим из «{}» и идём {route}", short_label_part(from, room, true))
}

fn abandon_label(quest_title: &str, destination: &str) -> String {
    let phrase = fit_route_phrase(destination, PARTY_ROUTE_LIMIT);
    let lead = if phrase.is_empty() { "Уходим отсюда и бросаем задание".to_string() } else { format!("Уходим {phrase} и бросаем задание") };
    let room = PARTY_OPTION_LIMIT as i64 - len16(&lead) as i64 - len16(" «»") as i64;
    format!("{lead} «{}»", short_label_part(quest_title, room, false))
}

// ---------------------------------------------------------------------------
// Уход и неизвестные места
// ---------------------------------------------------------------------------

/// Называет ли фраза того, кто стоит в сцене.
fn names_scene_actor(phrase: &str, state: &Value) -> bool {
    let location = text::lower(&visible_text(path(Some(state), &["scene", "location"]), 160));
    let merchants: Vec<Value> = array(get(Some(state), "merchants"))
        .iter()
        .filter(|merchant| {
            !js::is_false(get(Some(merchant), "available"))
                && (location.is_empty() || !js::truthy(get(Some(merchant), "location")) || text::lower(&visible_text(get(Some(merchant), "location"), 160)) == location)
        })
        .cloned()
        .collect();
    let mut visible_state = Map::new();
    if let Some(scene) = get(Some(state), "scene") {
        visible_state.insert("scene".into(), scene.clone());
    }
    visible_state.insert("social".into(), json!({ "npcs": present_scene_npcs(state) }));
    visible_state.insert("merchants".into(), Value::Array(merchants));
    if !sk_story::intent_parser::resolve_present_social_actors(Some(&sv(phrase)), Some(&Value::Object(visible_state))).is_empty() {
        return true;
    }
    let others: Vec<Value> = array(get(Some(state), "players"))
        .iter()
        .chain(array(get(Some(state), "enemies")).iter().filter(|enemy| !js::is_false(get(Some(enemy), "alive"))))
        .map(|actor| json!({ "name": visible_text(or(get(Some(actor), "character"), get(Some(actor), "name")), 80) }))
        .filter(|actor| js::truthy(actor.get("name")))
        .collect();
    mentioned_npc(phrase, &others).is_some()
}

fn names_scene_object(phrase: &str, labels: &[String]) -> bool {
    let words = words_of(&visible_str(phrase, 160));
    labels.iter().any(|label| {
        split(re!(r"[^\p{L}-]+", "u"), &fold(&visible_str(label, 60)))
            .into_iter()
            .filter(|part| len16(part) >= 3)
            .any(|part| words.iter().any(|word| word.starts_with(&ru_word_stem(&part))))
    })
}

fn current_city_plan_names(state: &Value) -> Vec<String> {
    let map = get(Some(state), "worldMap");
    let locations = array(get(map, "locations"));
    let scene_location = text::lower(&visible_text(path(Some(state), &["scene", "location"]), 160));
    let current_id = get(map, "currentLocationId");
    let current = locations
        .iter()
        .find(|entry| js::truthy(current_id) && js::s(get(Some(entry), "id")) == js::string(current_id))
        .or_else(|| locations.iter().find(|entry| !scene_location.is_empty() && text::lower(&visible_text(get(Some(entry), "name"), 160)) == scene_location));
    let overview = coalesce(get(current, "cityOverview"), get(current, "city_overview"));
    array(get(overview, "districts"))
        .iter()
        .chain(array(get(overview, "places")))
        .map(|entry| visible_text(get(Some(entry), "name"), 120))
        .filter(|name| !name.is_empty())
        .collect()
}

fn scene_objective(state: &Value) -> String {
    js::s(path(Some(state), &["scene", "objective"]))
}

fn scene_location(state: &Value) -> String {
    js::s(path(Some(state), &["scene", "location"]))
}

fn objective_travel_request(text_value: &str, state: &Value, context: &ExitOptions) -> Option<PartyExitRequest> {
    let destination = unrecognized_destination(text_value, context);
    if destination.is_empty() || !objective_calls_to(&destination, &scene_objective(state)) {
        return None;
    }
    if objective_names_destination(&destination, &scene_location(state)) {
        return None;
    }
    if names_scene_actor(&destination, state) {
        return None;
    }
    Some(PartyExitRequest { destination, source: "text", destination_location_id: None })
}

/// `unknownDestinationReply(action, state, { isRevealed })`: честный ответ на
/// движение к месту, которого нет ни на карте мира, ни в сцене; пустая строка —
/// фраза не о таком месте. `is_revealed` — раскрыт ли предмет на авторитетной
/// карте; без него `state` считается уже проекцией игрока.
pub fn unknown_destination_reply(action: &str, state: &Value, is_revealed: Option<&dyn Fn(&Value) -> bool>) -> String {
    if js::truthy(path(Some(state), &["mechanics", "combat", "active"])) {
        return String::new();
    }
    let text_value = visible_str(action, 2_000);
    let context = exit_context_from_state(state);
    let destination = unrecognized_destination(&text_value, &context);
    if destination.is_empty() {
        return String::new();
    }
    if objective_names_destination(&destination, &scene_objective(state)) || objective_names_destination(&destination, &scene_location(state)) {
        return String::new();
    }
    if names_scene_actor(&destination, state) {
        return String::new();
    }
    let mut labels: Vec<String> = array(path(Some(state), &["scene", "map", "props"]))
        .iter()
        .filter(|prop| !prop_broken(prop) && is_revealed.is_none_or(|revealed| revealed(prop)))
        .map(|prop| sk_tactical::scene_interactions::scene_object_label_for(get(Some(prop), "assetId")))
        .collect();
    labels.extend(current_city_plan_names(state));
    let labels: Vec<String> = labels.into_iter().filter(|label| !label.is_empty()).collect();
    if names_scene_object(&destination, &labels) {
        return String::new();
    }
    let phrase = party_destination_label(&text_value, &destination, &context).phrase;
    let asked = upper_first(&phrase);
    let neighbours: Vec<String> = known_destinations_from(state).iter().map(|entry| visible_text(entry.get("name"), 80)).filter(|name| !name.is_empty()).take(4).collect();
    [
        format!("{asked}? Такого места пока нет ни на карте мира, ни среди отмеченного в этой сцене."),
        "Путь к нему можно искать отсюда: осмотритесь или идите по следам — это проверка навыка.".to_string(),
        if neighbours.is_empty() { "Знакомых направлений отсюда на карте мира пока нет.".to_string() } else { format!("Или выберите на карте мира знакомое направление: {}.", neighbours.join(", ")) },
        "Попытка ничего не расходует.".to_string(),
    ]
    .join(" ")
}

/// `proposeAgentInteraction(action, state, { sourceText, actorName })`:
/// карточка общего броска судьбы или голосования об уходе.
pub fn propose_agent_interaction(action: &str, state: &Value, source_text: &str, actor_name: &str) -> Option<Value> {
    let text_value = text::nfkc(action);
    if text_value.is_empty() || test(re!(r"^\s*\[РЕШЕНИЕ ГРУППЫ\]", "iu"), &text_value) || js::truthy(get(Some(state), "agentInteraction")) {
        return None;
    }
    if fate_request(&text_value) {
        return Some(json!({
            "type": "roll",
            "title": "Кубик решает путь отряда",
            "description": "Пусть решает кубик: один d20 на весь отряд, 11 и выше — идёте дальше. Ход героя это не тратит.",
            "options": ["Отряд идёт дальше", "Отряд остаётся и ищет другой путь"],
            "difficulty": 11,
            "resolutionPrompt": "Продолжи историю по результату общего броска и при уходе открой следующую сцену.",
        }));
    }
    let accompanied = test(re!(r"^(?:иду|следую|отправляюсь)\s+(?:рядом\s+с|вместе\s+с|за)\s+", "iu"), &text_value) && !test(re!(r"не\s+(?:покида|уход|выход)", "iu"), &text_value);
    let destination = if accompanied { text::capture(re!(r"(?:\sк|\sв|\sна)\s+([^,.;!?]+?)(?=\s+(?:и|чтобы|затем)\s|[,.!?;]|$)", "iu"), &text_value, 1).unwrap_or_default() } else { String::new() };
    let context = exit_context_from_state(state);
    let exit = detect_party_exit_request(&text_value, &context)
        .or_else(|| if destination.is_empty() { None } else { detect_party_exit_request(&format!("Отправиться к {destination}"), &context) })
        .or_else(|| onward_route_exit_request(&text_value, state))
        .or_else(|| objective_travel_request(&text_value, state, &context))?;
    let destination = exit.destination.clone();
    let known_from = head_utf16(&text::squash_spaces(&js::s(or(or(path(Some(state), &["scene", "location"]), path(Some(state), &["scene", "title"])), Some(&sv(""))))), 120);
    let from = if known_from.is_empty() { "подземелья".to_string() } else { known_from.clone() };
    let label_source = if source_text.is_empty() { text_value.as_str() } else { source_text };
    let phrase = party_destination_label(label_source, &destination, &context).phrase;
    let leave_option = leave_label(&known_from, &phrase);
    let quest = if objective_names_destination(&destination, &scene_objective(state)) { None } else { abandonable_quest(state) };
    let abandon_option = quest.map(|quest| abandon_label(&quest.title, &phrase)).unwrap_or_default();
    let mut options = vec![Value::String(leave_option)];
    if !abandon_option.is_empty() {
        options.push(Value::String(abandon_option));
    }
    options.push(sv("Остаться и исследовать дальше"));
    let description = if !phrase.is_empty() {
        if actor_name.is_empty() {
            format!("Отряд собирается {phrase}.")
        } else {
            format!("{actor_name} зовёт отряд {phrase}.")
        }
    } else if actor_name.is_empty() {
        "Отряд собирается уходить.".to_string()
    } else {
        format!("{actor_name} зовёт уходить.")
    };
    let mut card = json!({
        "type": "vote",
        "title": if known_from.is_empty() { "Покинуть подземелье?".to_string() } else { format!("Покинуть «{from}»?") },
        "description": description,
        "options": options,
        "resolutionPrompt": "Исполни решение большинства. Если отряд уходит, бесшовно открой следующую локацию.",
    });
    if let Some(id) = exit.destination_location_id.filter(|id| !id.is_empty()) {
        card["destinationLocationId"] = Value::String(id);
    }
    Some(card)
}

/// `proposeRoutedTravel(hint, state, action, actorName)`: карточка ухода по
/// маршруту, который назвал судья свободных действий (`route: travel`).
pub fn propose_routed_travel(hint: Option<&Value>, state: &Value, action: &str, actor_name: &str) -> Option<Value> {
    if !is_str(get(hint, "route"), "travel") || js::truthy(get(Some(state), "agentInteraction")) {
        return None;
    }
    let raw = text::replace_all(re!(r"[«»]", "gu"), &js::s(get(hint, "destination")), "");
    let destination = head_utf16(&text::squash_spaces(&raw), 80);
    let context = exit_context_from_state(state);
    if !travel_destination_is_place(&destination, &context)
        && !(objective_names_destination(&destination, &scene_objective(state)) && !objective_names_destination(&destination, &scene_location(state)))
    {
        return None;
    }
    let request = if destination.is_empty() { "Уходим отсюда".to_string() } else { format!("Отправляемся в «{destination}»") };
    let mut card = propose_agent_interaction(&request, state, action, actor_name)?;
    if !is_str(card.get("type"), "vote") {
        return None;
    }
    card["description"] = Value::String(if destination.is_empty() { "Похоже, пора уходить.".to_string() } else { format!("Похоже, пора в путь — в «{destination}».") });
    Some(card)
}

// ---------------------------------------------------------------------------
// Хранитель знаний
// ---------------------------------------------------------------------------

fn hero_backstory_answer(action: &str, state: &Value, actor_id: &str) -> Option<Value> {
    let topic_text = text::capture(re!(r"(?:что\s+я\s+зна\p{L}*|что\s+я\s+помню|помню\s+ли\s+я)\s+(?:о|об|про)\s+(.+)$", "iu"), &visible_str(action, 400), 1)?;
    let hero = array(get(Some(state), "players")).iter().find(|entry| js::string(get(Some(entry), "id")) == actor_id)?;
    let backstory = visible_text(hero.get("backstory"), 600);
    if backstory.is_empty() {
        return None;
    }
    let topic: Vec<String> = split(re!(r"[^\p{L}]+", "u"), &fold(&topic_text)).into_iter().filter(|word| len16(word) >= 4).collect();
    let lowered = fold(&backstory);
    if !topic.iter().any(|word| lowered.contains(&ru_word_stem(word))) {
        return None;
    }
    let name = visible_text(or(hero.get("character"), hero.get("name")), 80);
    let rest = text::replace_first(re!(r"[.!?…]+$", "u"), &lower_first(&backstory), "");
    Some(reply(format!("{name} знает это по себе: {rest}. Больше ничего наверняка — остальное придётся выяснять здесь."), "hero-backstory"))
}

fn question_stems(value: &str) -> IndexSet<String> {
    const STOP: [&str; 19] = ["что", "чего", "кто", "как", "где", "мы", "уже", "знаем", "знает", "знаю", "об", "обо", "про", "этом", "этот", "наш", "нашим", "было", "есть"];
    text::find_all(re!(r"[\p{L}-]{4,}", "gu"), &fold(&text::nfkc(value))).into_iter().filter(|word| !STOP.contains(&word.as_str())).map(|word| head_utf16(&word, 5)).collect()
}

/// Параметры [`answer_known_lore`] (`{ viewer, actorId }`).
#[derive(Clone, Debug, Default)]
pub struct KnownLoreOptions {
    /// `viewer` (`{ playerId, isPartyMember, … }`); `None` — ответ ведущему.
    pub viewer: Option<Value>,
    /// `actorId`; `None` — `undefined`.
    pub actor_id: Option<Value>,
}

/// `answerKnownLore(action, state, options)`: детерминированный Хранитель
/// знаний — видимая сцена, направление, предыстория героя, находки, слова
/// собеседников и память мира. `None` — вопрос не к Хранителю.
pub fn answer_known_lore(action: &str, state: &Value, options: &KnownLoreOptions) -> Option<Value> {
    if let Some(visible_scene) = answer_visible_scene(action, state) {
        return Some(visible_scene);
    }
    let normalized = text::nfkc(action);
    if npc_speech_request(&normalized) {
        return None;
    }
    let asks_direction = direction_request(&normalized);
    if !asks_direction && select_agent_role(action) != "worldkeeper" {
        return None;
    }
    if npc_who_question(&visible_str(action, 400)) {
        if let Some(who) = answer_table_question(action, state, None) {
            if is_str(who.get("model"), "npc-public-profile") {
                return Some(who);
            }
        }
    }
    let viewer = options.viewer.as_ref().filter(|viewer| js::truthy(Some(viewer)));
    let actor = coalesce(get(viewer, "playerId"), options.actor_id.as_ref()).cloned();
    let actor_text = actor.as_ref().map(|value| js::string(Some(value))).unwrap_or_default();
    if let Some(backstory) = hero_backstory_answer(action, state, &actor_text) {
        return Some(backstory);
    }
    let adventure = get(Some(state), "adventure");
    let campaign_premise = sk_encounters::agent_context::campaign_concept_for_agent(state, None);
    let scene = get(Some(state), "scene");
    let world_memory = get(Some(state), "worldMemory").unwrap_or(&Value::Null);
    let visible_memory = match viewer {
        Some(viewer) => sk_memory::world_memory::world_memory_for_viewer(world_memory, viewer),
        None => world_memory.clone(),
    };
    let world_facts = match viewer {
        Some(viewer) => {
            let mut retrieve = Map::new();
            retrieve.insert("viewer".into(), viewer.clone());
            retrieve.insert("query".into(), sv(action));
            if let Some(minutes) = path(Some(state), &["mechanics", "world_time", "elapsed_minutes"]) {
                retrieve.insert("atMinutes".into(), minutes.clone());
            }
            sk_memory::world_memory::retrieve_known_world_memory(world_memory, &Value::Object(retrieve))
        }
        None => sk_memory::world_memory::known_world_lore(&visible_memory, Some(&sv(action)), None),
    };
    let memory = Some(&visible_memory);
    let active_quest = array(get(memory, "quests")).iter().find(|quest| is_str(get(Some(quest), "status"), "active"));
    let first_objective = get(active_quest, "objectives").and_then(|objectives| match objectives {
        Value::Array(items) => items.first(),
        Value::Object(map) => map.get("0"),
        _ => None,
    });
    let quest_objective = or(first_objective, get(active_quest, "summary"));
    if asks_direction {
        let location = js::s(or(or(get(scene, "location"), get(scene, "title")), Some(&sv("текущая локация"))));
        let objective = text::trim(&js::s(or(or(or(get(scene, "objective"), get(adventure, "currentHook")), quest_objective), Some(&sv(""))))).to_string();
        let has_named = test(re!(r"(?:отправиться|путь|дорога|маршрут|следовать|идти)\s+(?:в|на|к)\s+[^,.!?;:]+", "iu"), &objective);
        let narration = if has_named {
            format!("По текущей задаче вам нужно: {objective}. Сейчас отряд находится здесь: {location}.")
        } else {
            format!(
                "Пункт назначения пока не открыт. Текущая задача — {}. Сейчас вы здесь: {location}. Чтобы понять маршрут, осмотритесь, расспросите свидетелей или найдите нужную запись.",
                if objective.is_empty() { "исследовать обстановку и найти новую зацепку" } else { &objective }
            )
        };
        return Some(json!({
            "narration": narration, "effects": empty_effects(), "provider": "AgentWorldkeeper", "agent_context": { "campaign_premise": campaign_premise },
            "model": "campaign-memory", "turn_consumed": false, "action_kind": "free",
        }));
    }
    let asked = question_stems(action);
    let relevance = |value: &str| if asked.is_empty() { 0 } else { question_stems(value).iter().filter(|stem| asked.contains(*stem)).count() };
    let party_visible = |fact: &Value| ["party", "public"].contains(&js::string(get(Some(fact), "visibility")).as_str());
    let discoveries: Vec<String> = array(get(memory, "facts"))
        .iter()
        .filter(|fact| !is_str(get(Some(fact), "status"), "superseded") && party_visible(fact))
        .filter(|fact| is_str(get(Some(fact), "predicate"), "discovery"))
        .map(|fact| as_sentence(or(get(Some(fact), "summary"), get(Some(fact), "object")), 400))
        .filter(|line| !line.is_empty())
        .collect();
    let known_facts: Vec<String> = world_facts
        .iter()
        .filter(|fact| {
            let predicate = js::string(coalesce(path(Some(fact), &["fact", "predicate"]), get(Some(fact), "predicate")));
            !["discovery", "opening_narration"].contains(&predicate.as_str())
        })
        .map(|fact| as_sentence(or(or(path(Some(fact), &["fact", "summary"]), get(Some(fact), "summary")), get(Some(fact), "object")), 400))
        .filter(|line| !line.is_empty())
        .collect();
    let mut npc_names: HashMap<String, String> = HashMap::new();
    for npc in array(path(Some(state), &["social", "npcs"])) {
        npc_names.insert(js::string(get(Some(npc), "id")), visible_text(get(Some(npc), "name"), 80));
    }
    let heard_sentence = |reply_text: Option<&Value>| -> String {
        let sentences: Vec<String> =
            text::find_all(re!(r"[^.!?…]+[.!?…]*", "gu"), &visible_text(reply_text, 1_200)).into_iter().map(|sentence| text::trim(&sentence).to_string()).filter(|sentence| !sentence.is_empty()).collect();
        if sentences.is_empty() {
            return String::new();
        }
        let mut scored: Vec<(usize, usize)> = sentences.iter().enumerate().map(|(index, sentence)| (index, relevance(sentence))).collect();
        scored.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(&right.0)));
        let best = scored[0].0;
        let sentence = &sentences[best];
        match sentences.get(best + 1) {
            Some(next) if len16(sentence) + len16(next) <= 220 => visible_str(&format!("{sentence} {next}"), 240),
            _ => visible_str(sentence, 240),
        }
    };
    let conversations = array(path(Some(state), &["social", "conversations"]));
    let heard: Vec<(String, String)> = conversations
        .iter()
        .filter(|entry| is_str(get(Some(entry), "visibility"), "party") || strict_eq(get(Some(entry), "hero_id"), actor.as_ref()))
        .map(|entry| (npc_names.get(&js::string(get(Some(entry), "npc_id"))).cloned().unwrap_or_default(), heard_sentence(get(Some(entry), "npc_reply"))))
        .filter(|(who, line)| !who.is_empty() && !line.is_empty())
        .collect();
    fn ranked<T: Clone>(items: &[T], score: impl Fn(&T) -> usize) -> Vec<(T, usize, usize)> {
        let mut result: Vec<(T, usize, usize)> = items.iter().enumerate().map(|(index, item)| (item.clone(), index, score(item))).collect();
        result.sort_by(|left, right| right.2.cmp(&left.2).then(right.1.cmp(&left.1)));
        result
    }
    let unique = |items: Vec<String>| -> Vec<String> { items.into_iter().collect::<IndexSet<String>>().into_iter().collect() };
    let found_ranked = ranked(&unique(discoveries), |line| relevance(line));
    let heard_ranked = ranked(&heard, |entry| relevance(&entry.1));
    let known_ranked = ranked(&unique(known_facts), |line| relevance(line));
    let topical = !asked.is_empty();
    let found_has_score = found_ranked.iter().any(|entry| entry.2 > 0);
    let found_lines: Vec<String> =
        found_ranked.iter().filter(|entry| !(topical && found_has_score) || entry.2 > 0).take(3).map(|entry| entry.0.clone()).collect();
    let heard_picked: Vec<(String, String)> = heard_ranked.iter().filter(|entry| !topical || entry.2 > 0).take(2).map(|entry| entry.0.clone()).collect();
    let heard_lines: Vec<String> = heard_picked
        .iter()
        .map(|(who, line)| {
            let quoted = text::replace_all(re!(r"[«»]", "gu"), line, "\"");
            format!("{who}: «{}».", text::replace_first(re!(r"[.!?…]+$", "u"), &quoted, ""))
        })
        .collect();
    let quoted: IndexSet<String> = heard_picked.iter().map(|(who, _)| who.clone()).collect();
    let said: Vec<IndexSet<String>> = found_lines.iter().chain(heard_picked.iter().map(|(_, line)| line)).map(|line| question_stems(line)).collect();
    let repeats = |line: &str| {
        let stems = question_stems(line);
        !stems.is_empty() && said.iter().any(|other| stems.iter().filter(|stem| other.contains(*stem)).count() as f64 / stems.len() as f64 >= 0.5)
    };
    let known_lines: Vec<String> = known_ranked.iter().filter(|entry| !topical || entry.2 > 0).map(|entry| entry.0.clone()).filter(|line| !repeats(line)).take(2).collect();
    let history: Vec<String> = match get(adventure, "history") {
        Some(Value::Array(chapters)) => chapters.iter().rev().take(1).map(|chapter| as_sentence(get(Some(chapter), "outcome"), 240)).filter(|line| !line.is_empty()).collect(),
        _ => Vec::new(),
    };
    let talked_to: IndexSet<String> = conversations.iter().map(|entry| js::s(get(Some(entry), "npc_id"))).collect();
    let told_of = text::lower(
        &array(get(memory, "facts")).iter().filter(|fact| party_visible(fact)).map(|fact| js::string(Some(coalesce(get(Some(fact), "summary"), None).unwrap_or(&sv(""))))).collect::<Vec<_>>().join(" "),
    );
    let introduced = |npc: &Value| {
        if talked_to.contains(&js::s(npc.get("id"))) {
            return true;
        }
        let name = visible_text(npc.get("name"), 80);
        let first = split(re!(r"\s+", "u"), &name).into_iter().next().unwrap_or_default();
        len16(&first) >= 3 && told_of.contains(&text::lower(&first))
    };
    let informed: Vec<Value> = present_scene_npcs(state)
        .into_iter()
        .filter(|npc| !visible_text(npc.get("role"), 120).is_empty())
        .filter(|npc| !quoted.contains(&visible_text(npc.get("name"), 80)) && introduced(npc))
        .take(2)
        .collect();
    let answered = !found_lines.is_empty() || !heard_lines.is_empty() || !known_lines.is_empty();
    let lead_head = if heard_lines.is_empty() { "Прямого ответа пока нет" } else { "Своими глазами вы этого не видели" };
    let lead = if informed.is_empty() {
        format!("{lead_head} — стоит осмотреться или поискать того, кто видел.")
    } else {
        let names: Vec<String> = informed.iter().map(|npc| format!("{} ({})", visible_text(npc.get("name"), 80), text::lower(&visible_text(npc.get("role"), 80)))).collect();
        format!("{lead_head} — знать {} {}.", if informed.len() > 1 { "могут" } else { "может" }, names.join(" или "))
    };
    let hook = as_sentence(get(adventure, "currentHook"), 400);
    let mut parts: Vec<String> = Vec::new();
    if !found_lines.is_empty() {
        parts.push(format!("Из того, что вы нашли: {}", found_lines.join(" ")));
    }
    if !heard_lines.is_empty() {
        parts.push(format!("Вам говорили — {}", heard_lines.join(" ")));
    }
    if !known_lines.is_empty() {
        parts.push(known_lines.join(" "));
    }
    if !answered && !hook.is_empty() {
        parts.push(format!("Известно немногое: {hook}"));
    }
    if !answered && !history.is_empty() {
        parts.push(format!("Прежде: {}", history.join(" ")));
    }
    if topical && !found_has_score {
        parts.push(if answered || !hook.is_empty() { lead.clone() } else { format!("Пока ничего подтверждённого об этом не известно. {lead}") });
    }
    let narration = if !parts.is_empty() {
        parts.join(" ")
    } else if !hook.is_empty() {
        format!("Известно немногое: {hook} {lead}")
    } else {
        format!("Пока ничего подтверждённого об этом не известно. {lead}")
    };
    Some(json!({
        "narration": narration,
        "effects": empty_effects(),
        "provider": "AgentWorldkeeper",
        "agent_context": { "campaign_premise": campaign_premise },
        "model": "campaign-memory",
        "turn_consumed": false,
        "action_kind": "free",
        "lore_material": {
            "found": found_lines,
            "heard": heard_picked.iter().map(|(who, line)| json!({ "who": who, "line": line })).collect::<Vec<_>>(),
            "known": known_lines,
            "lead": informed.iter().map(|npc| json!({ "name": visible_text(npc.get("name"), 80), "role": visible_text(npc.get("role"), 80) })).collect::<Vec<_>>(),
            "hook": if answered { String::new() } else { hook.clone() },
            "unknown": topical && !found_has_score && heard_lines.is_empty(),
        },
    }))
}

/// `resolvePartyDecision(action, state)`: исход подтверждённого решения
/// группы — запрос новой сцены или повествование; `None` — не решение группы.
pub fn resolve_party_decision(action: Option<&Value>, state: &Value) -> Option<Value> {
    let interpretation = interpret_resolved_party_decision(action, state)?;
    let kind = js::s(interpretation.get("kind"));
    if kind == "move" {
        let mut result = json!({
            "type": "scene_request",
            "decision": interpretation.get("decision").cloned().unwrap_or(Value::Null),
            "destinationHint": interpretation.get("destinationHint").cloned().unwrap_or(Value::Null),
            "abandonsQuest": js::is_true(interpretation.get("abandonsQuest")),
        });
        if let Some(id) = interpretation.get("destinationLocationId").filter(|id| js::truthy(Some(id))) {
            result["destinationLocationId"] = id.clone();
        }
        return Some(result);
    }
    if kind == "stay" {
        let raw = js::s(or(or(path(Some(state), &["adventure", "currentHook"]), path(Some(state), &["scene", "objective"])), Some(&sv("неисследованный проход"))));
        let direction = head_utf16(&text::squash_spaces(&raw), 160);
        return Some(json!({ "type": "narration", "narration": format!("Остаться в текущей локации — решение группы. Конкретное направление исследования: {direction}.") }));
    }
    Some(json!({ "type": "narration", "narration": format!("Группа приняла решение: {}.", js::s(interpretation.get("decision"))) }))
}

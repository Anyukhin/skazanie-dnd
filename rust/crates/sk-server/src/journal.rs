//! Летопись комнаты — перенос `server/index.mjs:2075–2253` и 3365–3380:
//! идентификаторы сообщений, слова игрока к команде, последние реплики
//! рассказчика, `journalEntry` (запись с границами длины и карточками броска,
//! ставки, хода мира, письма и зверя), `appendRoomJournal` (три попытки,
//! предел 400) и `journalCandidatesFor` (карточки, выведенные из событий).
//!
//! Летопись — часть комнаты, а не поток событий: Рассказчик событий не
//! создаёт. Запись идёт через [`crate::room::save_room`], то есть каждая
//! дописанная строка двигает `room.version`.

use std::rc::Rc;

use serde_json::{json, Map, Value};
use sk_core::{js, text};

use crate::core::GameCore;
use crate::error::Failure;
use crate::room::Room;

/// `JOURNAL_HISTORY_LIMIT` (2235).
pub const ROOM_JOURNAL_LIMIT: usize = 400;

fn message_id(prefix: &str, idempotency_key: &str) -> String {
    let digest = sk_core::hash::sha256_hex(idempotency_key);
    format!("{prefix}-{}", &digest[..20])
}

/// `combatMessageId(key)`: `combat-` и 20 знаков sha256.
pub fn combat_message_id(idempotency_key: &str) -> String {
    message_id("combat", idempotency_key)
}

/// `merchantMessageId(key)`.
pub fn merchant_message_id(idempotency_key: &str) -> String {
    message_id("merchant", idempotency_key)
}

/// `narrationMessageId(key)`.
pub fn narration_message_id(idempotency_key: &str) -> String {
    message_id("narration", idempotency_key)
}

/// `playerMessageId(key)`.
pub fn player_message_id(idempotency_key: &str) -> String {
    message_id("player", idempotency_key)
}

/// `playerNoteFrom(body)` (2097–2100): слова игрока к структурной команде —
/// управляющие символы в пробел, обрезка, предел 2000; служебная команда
/// (`/why`) — не реплика.
pub fn player_note_from(body: &Value) -> String {
    let raw = js::s(body.get("player_note"));
    let mut cleaned = String::with_capacity(raw.len());
    let mut in_run = false;
    for ch in raw.chars() {
        if ch <= '\u{1f}' || ch == '\u{7f}' {
            if !in_run {
                cleaned.push(' ');
            }
            in_run = true;
        } else {
            cleaned.push(ch);
            in_run = false;
        }
    }
    let note = text::head(text::trim(&cleaned), 2_000);
    if !note.is_empty() && !note.starts_with('/') {
        note
    } else {
        String::new()
    }
}

/// Первое не `null`/`undefined` значение (`a ?? b ?? …`).
fn nullish<'a>(values: &[Option<&'a Value>]) -> Option<&'a Value> {
    values.iter().copied().find(|value| js::present(*value)).flatten()
}

/// `playerNoteAuthor(state, commandActor, actorId)` (2103–2109): герой
/// игрока, а за призванное существо — хозяин.
pub fn player_note_author(state: &Value, command_actor: Option<&Value>, actor_id: Option<&Value>) -> String {
    let heroes = state.get("players").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let field = |key: &str| command_actor.and_then(|actor| actor.get(key));
    let controller_id = js::s(nullish(&[field("controllerId"), field("controller_id"), field("ownerId"), field("owner_id")]));
    let wanted = js::s(actor_id);
    let hero = heroes.iter().find(|candidate| js::s(candidate.get("id")) == wanted).or_else(|| if controller_id.is_empty() { None } else { heroes.iter().find(|candidate| js::s(candidate.get("id")) == controller_id) });
    let name = nullish(&[hero.and_then(|hero| hero.get("character")), hero.and_then(|hero| hero.get("name")), field("name")]);
    text::head(&name.map_or_else(|| "Герой".to_string(), |value| js::s(Some(value))), 80)
}

/// `recentNarratorTexts(state, limit = 6)` (2112–2117): последние реплики
/// рассказчика — для проверки повторов.
pub fn recent_narrator_texts(state: Option<&Value>, limit: usize) -> Vec<String> {
    let messages = state.and_then(|state| state.get("messages")).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let narrated: Vec<&Value> = messages.iter().filter(|message| message.get("speaker").and_then(Value::as_str) == Some("narrator") && !text::trim(&js::s(message.get("text"))).is_empty()).collect();
    // `slice(-0)` — весь список, как в JS.
    let start = if limit == 0 { 0 } else { narrated.len().saturating_sub(limit) };
    narrated[start..].iter().map(|message| js::s(message.get("text"))).collect()
}

/// `String(x || fallback)`.
fn or_text(value: Option<&Value>, fallback: &str) -> String {
    if js::truthy(value) {
        js::s(value)
    } else {
        fallback.to_string()
    }
}

/// `Number(x) || fallback`.
fn number_or(value: Option<&Value>, fallback: f64) -> f64 {
    let number = js::number(value);
    if number.is_nan() || number == 0.0 {
        fallback
    } else {
        number
    }
}

fn object(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.filter(|value| js::truthy(Some(value))).and_then(Value::as_object)
}

/// `journalRoll(roll)` (2119–2135): бросок рядом с репликой — только
/// разрешённая проверка (число итога и булев исход).
pub fn journal_roll(roll: Option<&Value>) -> Option<Value> {
    let roll = object(roll)?;
    let total = js::number(roll.get("total"));
    if !total.is_finite() || !roll.get("success").is_some_and(Value::is_boolean) {
        return None;
    }
    Some(json!({
        "value": js::num(number_or(roll.get("value"), 0.0)),
        "modifier": js::num(number_or(roll.get("modifier"), 0.0)),
        "total": js::num(total),
        "label": text::head(&or_text(roll.get("label"), "Проверка"), 80),
        "success": roll.get("success"),
    }))
}

/// `journalStakes(stakes)` (2137–2148).
pub fn journal_stakes(stakes: Option<&Value>) -> Option<Value> {
    let stakes = object(stakes)?;
    let difficulty = js::number(stakes.get("difficulty"));
    if !difficulty.is_finite() {
        return None;
    }
    let mut stored = Map::new();
    let limited = |key: &str, limit: usize| js::truthy(stakes.get(key)).then(|| Value::String(text::head(&js::s(stakes.get(key)), limit)));
    if let Some(skill) = limited("skill", 60) {
        stored.insert("skill".into(), skill);
    }
    if let Some(ability) = limited("ability", 20) {
        stored.insert("ability".into(), ability);
    }
    stored.insert("difficulty".into(), js::num(difficulty));
    if let Some(category) = limited("difficulty_category", 40) {
        stored.insert("difficulty_category".into(), category);
    }
    if let Some(on_failure) = limited("on_failure", 300) {
        stored.insert("on_failure".into(), on_failure);
    }
    Some(Value::Object(stored))
}

/// `journalOffscreen(offscreen)` (2155–2169): карточка «Пока вас не было…».
pub fn journal_offscreen(offscreen: Option<&Value>) -> Option<Value> {
    let offscreen = object(offscreen)?;
    let lines: Vec<Value> = offscreen
        .get("lines")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .map(|line| text::head(&js::s(Some(line)), 400))
        .filter(|line| !line.is_empty())
        .take(3)
        .map(Value::String)
        .collect();
    if lines.is_empty() {
        return None;
    }
    Some(json!({
        "title": text::head(&or_text(offscreen.get("title"), "Пока вас не было…"), 80),
        "day": js::num(number_or(offscreen.get("day"), 1.0).max(1.0)),
        "elapsed_minutes": js::num(number_or(offscreen.get("elapsed_minutes"), 0.0).max(0.0)),
        "lines": lines,
    }))
}

/// `journalLetter(letter)` (2176–2190): карточка-конверт.
pub fn journal_letter(letter: Option<&Value>) -> Option<Value> {
    let letter = object(letter)?;
    let kind = js::s(letter.get("kind"));
    let body = text::head(&js::s(letter.get("text")), 800);
    if !["sent", "delivered", "returned", "answered", "unanswered"].contains(&kind.as_str()) || text::trim(&body).is_empty() {
        return None;
    }
    Some(json!({
        "kind": kind,
        "title": text::head(&or_text(letter.get("title"), "Почта отряда"), 80),
        "from": text::head(&or_text(letter.get("from"), ""), 120),
        "to": text::head(&or_text(letter.get("to"), ""), 120),
        "text": body,
    }))
}

/// `journalBeast(beast)` (2197–2211): карточка ступени приручения.
pub fn journal_beast(beast: Option<&Value>) -> Option<Value> {
    let beast = object(beast)?;
    let kind = js::s(beast.get("kind"));
    let body = text::head(&js::s(beast.get("text")), 600);
    if !["calmed", "fed", "tamed"].contains(&kind.as_str()) || text::trim(&body).is_empty() {
        return None;
    }
    Some(json!({
        "kind": kind,
        "title": text::head(&or_text(beast.get("title"), "Зверь и отряд"), 80),
        "name": text::head(&or_text(beast.get("name"), ""), 120),
        "diet_label": text::head(&or_text(beast.get("diet_label"), ""), 40),
        "text": body,
    }))
}

/// `new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' })
/// .format(new Date())` в часовом поясе боевого сервера (Docker — UTC), как
/// `campaign_bootstrap::clock_label`.
fn clock_label(now_ms: i64) -> String {
    let minutes = now_ms.div_euclid(60_000).rem_euclid(24 * 60);
    format!("{:02}:{:02}", minutes / 60, minutes % 60)
}

/// `journalEntry({...})` (2213–2233): запись летописи с автором, временем и
/// границами длины.
pub fn journal_entry(entry: &Value) -> Value {
    journal_entry_at(entry, sk_core::clock::now_ms())
}

/// [`journal_entry`] с явным временем (эталоны и тесты).
pub fn journal_entry_at(entry: &Value, now_ms: i64) -> Value {
    let field = |key: &str| entry.get(key);
    let speaker = match field("speaker").and_then(Value::as_str) {
        Some("system") => "system",
        Some("player") => "player",
        _ => "narrator",
    };
    let default_author = if field("speaker").and_then(Value::as_str) == Some("system") { "Система боя" } else { "Рассказчик" };
    let mut stored = Map::new();
    stored.insert("id".into(), Value::String(js::string(field("id"))));
    stored.insert("speaker".into(), Value::String(speaker.into()));
    stored.insert("author".into(), Value::String(text::head(&or_text(field("author"), default_author), 80)));
    stored.insert("timestamp".into(), Value::String(clock_label(now_ms)));
    stored.insert("text".into(), Value::String(text::head(&js::string(field("text")), 2000)));
    stored.insert("turnConsumed".into(), Value::Bool(js::truthy(field("turnConsumed"))));
    if js::truthy(field("knowledge_gate")) {
        stored.insert("knowledge_gate".into(), field("knowledge_gate").cloned().unwrap_or(Value::Null));
    }
    let cards = [
        ("roll", journal_roll(field("roll"))),
        ("stakes", journal_stakes(field("stakes"))),
        ("offscreen", journal_offscreen(field("offscreen"))),
        ("letter", journal_letter(field("letter"))),
        ("beast", journal_beast(field("beast"))),
    ];
    for (key, card) in cards {
        if let Some(card) = card {
            stored.insert(key.into(), card);
        }
    }
    Value::Object(stored)
}

/// Кандидат летописи: `candidate?.id && String(candidate.text ?? '').trim()`.
pub(crate) fn is_journal_candidate(candidate: &Value) -> bool {
    js::truthy(candidate.get("id")) && !text::trim(&js::s(candidate.get("text"))).is_empty()
}

/// `room.state.messages ?? []` для `map`/спреда: не массив — `TypeError`, как в JS.
pub(crate) fn room_messages(state: &Value) -> Result<Vec<Value>, Failure> {
    match state.get("messages") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(messages)) => Ok(messages.clone()),
        Some(_) => Err(Failure::new("room.state.messages.map is not a function", Some("TYPE_ERROR"))),
    }
}

/// `appendRoomJournal(campaignId, entries)` (2237–2253): дописать новые по
/// `id` записи (через [`journal_entry`]), оставить последние 400; до трёх
/// попыток на конфликт версии комнаты. `None` — писать нечего, комнаты нет
/// или три конфликта подряд.
pub fn append_room_journal(core: &Rc<GameCore>, campaign_id: &str, entries: &[Value]) -> Result<Option<Room>, Failure> {
    append_room_journal_at(core, campaign_id, entries, sk_core::clock::now_ms())
}

/// [`append_room_journal`] с явным временем записей.
pub fn append_room_journal_at(core: &Rc<GameCore>, campaign_id: &str, entries: &[Value], now_ms: i64) -> Result<Option<Room>, Failure> {
    let wanted: Vec<&Value> = entries.iter().filter(|entry| is_journal_candidate(entry)).collect();
    if wanted.is_empty() {
        return Ok(None);
    }
    for _attempt in 0..3 {
        let room = crate::room::get_room(core, campaign_id)?;
        let Some(state) = room.state.as_ref() else { return Ok(None) };
        let mut messages = room_messages(state)?;
        let existing: Vec<String> = messages.iter().map(|message| js::string(message.get("id"))).collect();
        let fresh: Vec<Value> = wanted.iter().filter(|entry| !existing.contains(&js::string(entry.get("id")))).map(|entry| journal_entry_at(entry, now_ms)).collect();
        if fresh.is_empty() {
            return Ok(Some(room));
        }
        messages.extend(fresh);
        let messages = messages.split_off(messages.len().saturating_sub(ROOM_JOURNAL_LIMIT));
        let next = js::spread(state, json!({ "messages": messages }));
        let saved = crate::room::save_room(core, campaign_id, &next, room.version)?;
        if !saved.conflict {
            return Ok(Some(saved.room));
        }
    }
    Ok(None)
}

/// `journalCandidatesFor(events, journalMessage)` (3372–3381): карточки из
/// событий (ход мира, почта, зверь, решение отряда, сюжет, контора) и
/// переданная маршрутом реплика (одна запись или список — `.flat()`).
pub fn journal_candidates_for(events: &[Value], journal_message: Option<&Value>) -> Vec<Value> {
    let empty = json!({});
    let mut candidates: Vec<Value> = Vec::new();
    candidates.extend(events.iter().filter_map(|event| sk_world_story::offscreen_world::offscreen_chronicle_entry(Some(event))));
    candidates.extend(events.iter().filter_map(sk_world_life::courier_letters::courier_letter_chronicle_entry));
    candidates.extend(events.iter().filter_map(sk_npc_world::beast_taming::beast_chronicle_entry));
    candidates.extend(events.iter().filter_map(sk_character::quest_decisions::quest_decision_chronicle_entry));
    candidates.extend(events.iter().filter_map(sk_society::campaign_stories::campaign_story_chronicle_entry));
    candidates.extend(events.iter().filter_map(|event| sk_world_life::world_offices::office_chronicle_entry(event, &empty)));
    match journal_message {
        Some(Value::Array(items)) => candidates.extend(items.iter().cloned()),
        Some(message) => candidates.push(message.clone()),
        None => {}
    }
    candidates.retain(is_journal_candidate);
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_ids_are_sha256_prefixes() {
        let digest = sk_core::hash::sha256_hex("key-1");
        assert_eq!(combat_message_id("key-1"), format!("combat-{}", &digest[..20]));
        assert_eq!(player_message_id("key-1").len(), "player-".len() + 20);
    }

    #[test]
    fn player_note_is_trimmed_and_skips_service_commands() {
        assert_eq!(player_note_from(&json!({ "player_note": "  За\u{0}\u{1}стражу!\u{7f} " })), "За стражу!");
        assert_eq!(player_note_from(&json!({ "player_note": "/why" })), "");
        assert_eq!(player_note_from(&json!({})), "");
        assert_eq!(player_note_from(&json!({ "player_note": 12 })), "12");
    }

    #[test]
    fn note_author_prefers_hero_then_controller() {
        let state = json!({ "players": [{ "id": "a", "character": "Борин" }, { "id": "b", "name": "Мира" }] });
        assert_eq!(player_note_author(&state, None, Some(&json!("a"))), "Борин");
        assert_eq!(player_note_author(&state, Some(&json!({ "controller_id": "b" })), Some(&json!("wolf"))), "Мира");
        assert_eq!(player_note_author(&state, Some(&json!({ "name": "Волк" })), Some(&json!("wolf"))), "Волк");
        assert_eq!(player_note_author(&json!({}), None, None), "Герой");
    }

    #[test]
    fn entry_keeps_only_resolved_cards() {
        let entry = journal_entry_at(
            &json!({ "id": 7, "speaker": "system", "text": "x", "roll": { "value": "3", "total": 5, "success": true }, "stakes": { "difficulty": "12", "skill": "Атлетика" }, "offscreen": { "lines": ["", "a"], "day": 0 }, "letter": { "kind": "lost", "text": "t" } }),
            90 * 60_000,
        );
        assert_eq!(
            entry,
            json!({
                "id": "7", "speaker": "system", "author": "Система боя", "timestamp": "01:30", "text": "x", "turnConsumed": false,
                "roll": { "value": 3, "modifier": 0, "total": 5, "label": "Проверка", "success": true },
                "stakes": { "skill": "Атлетика", "difficulty": 12 },
                "offscreen": { "title": "Пока вас не было…", "day": 1, "elapsed_minutes": 0, "lines": ["a"] },
            })
        );
        assert_eq!(journal_roll(Some(&json!({ "total": 3, "success": "yes" }))), None);
    }

    #[test]
    fn recent_narration_takes_tail() {
        let state = json!({ "messages": [{ "speaker": "narrator", "text": "a" }, { "speaker": "player", "text": "b" }, { "speaker": "narrator", "text": " " }, { "speaker": "narrator", "text": "c" }] });
        assert_eq!(recent_narrator_texts(Some(&state), 6), vec!["a".to_string(), "c".to_string()]);
        assert_eq!(recent_narrator_texts(Some(&state), 1), vec!["c".to_string()]);
    }
}

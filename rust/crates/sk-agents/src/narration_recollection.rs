//! Ответ Хранителя по общей записи разговора или обещания.

use std::collections::{HashMap, HashSet};

use serde_json::Value;
use sk_core::{re, text};
use sk_memory::world_memory::memory_search_terms;

fn field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn shared(value: &Value) -> bool {
    matches!(field(value, "visibility"), "party" | "public")
}

fn status_text(status: &str) -> Option<&'static str> {
    match status {
        "open" => Some("Пока у вас есть только слово."),
        "fulfilled" => Some("Обещание исполнено."),
        "broken" => Some("Обещание нарушено."),
        "cancelled" => Some("Уговор отменён."),
        _ => None,
    }
}

pub(super) fn party_recollection(state: &Value, action: &str) -> Option<String> {
    let promise = text::test(re!(r"обеща|уговор|договарив|договорил", "iu"), action);
    if !promise && !text::test(re!(r"видел|слышал|сказал|говорил|рассказал|свидетел|показани", "iu"), action) {
        return None;
    }

    let social = state.get("social")?;
    let records = social.get(if promise { "promises" } else { "conversations" })?.as_array()?;
    let about = re!(r"(?:^|\s)(?:о|об|про|насч[её]т|по поводу)\s+", "iu").find(action).ok().flatten();
    let source_words = memory_search_terms(about.map_or(action, |found| &action[..found.start()]));
    let mut topics = memory_search_terms(action);
    topics.retain(|term| !text::test(re!(r"^(?:обещ|уговор|договор|договар|сказ|рассказ|говор|видел|слыша|свидетел|показан|напомн|спрашив|помн|знаем|знаю)", "u"), term));

    // В вопросе «Кто видел Миру?» Мира — предмет показания.
    let asks_who = text::test(re!(r"(?:^|[\s,])кто\s", "iu"), action);
    let mut people = HashMap::new();
    let mut named = HashSet::new();
    for npc in social.get("npcs")?.as_array()? {
        let id = field(npc, "id");
        let name = field(npc, "name");
        // У спроецированной карточки NPC поле visibility может отсутствовать.
        if id.is_empty() || name.is_empty() || (!npc["visibility"].is_null() && !shared(npc)) {
            continue;
        }
        people.insert(id, name);
        if !asks_who {
            for term in memory_search_terms(name).intersection(&source_words) {
                named.insert(id);
                topics.remove(term);
            }
        }
    }

    let from_party = text::test(re!(r"(?:мы|отряд)\s+(?:\p{L}+\s+){0,2}обещал|(?:кому|что)\s+мы\s+обеща", "iu"), action);
    let to_party = text::test(re!(r"нам\s+обеща|обещал[аи]?\s+(?:нам|отряду)", "iu"), action);
    let asks_for_witness = !promise && text::test(re!(r"кто\s+(?:сам[аи]?\s+)?видел", "iu"), action);
    let text_key = if promise { "text" } else { "npc_reply" };
    let mut best = None;
    let mut best_score = 0;
    for record in records {
        let npc_id = field(record, "npc_id");
        if !shared(record) || field(record, "id").is_empty() || !people.contains_key(npc_id) || (!named.is_empty() && !named.contains(npc_id)) {
            continue;
        }
        let direction = field(record, "direction");
        if promise && (status_text(field(record, "status")).is_none()
            || !matches!(direction, "npc_to_party" | "party_to_npc")
            || (from_party && direction != "party_to_npc") || (to_party && direction != "npc_to_party"))
        {
            continue;
        }
        let line = field(record, text_key);
        if line.trim().is_empty() {
            continue;
        }
        let score = memory_search_terms(line).intersection(&topics).count();
        if score == 0 && (!topics.is_empty() || named.is_empty()) {
            continue;
        }
        // При равной теме предпочитаем слова очевидца.
        let firsthand = asks_for_witness && text::test(re!(r"(?:^|[.!?«:,]\s*)я\s+(?:(?:сам[аи]?|лично)\s+)?видел[аи]?(?!\p{L})", "iu"), line);
        let score = 2 * score + usize::from(firsthand);
        if score >= best_score {
            best_score = score;
            best = Some(record);
        }
    }

    let best = best?;
    let npc = *people.get(field(best, "npc_id"))?;
    let line = field(best, text_key);
    if !promise {
        return Some(format!("Вы слышали это в разговоре. {npc}: «{line}»"));
    }
    let party_gave_word = field(best, "direction") == "party_to_npc";
    let obligation = line.trim().trim_end_matches(['.', '!', '?', '…']);
    let terms = if text::test(re!(r"^[а-яё-]+(?:ть|ти|чь)(?:ся)?(?:\s|$)", "iu"), obligation) {
        let subject = if party_gave_word { "отряд" } else { npc };
        let mut chars = obligation.chars();
        let first = chars.next()?.to_lowercase();
        format!("Тогда {npc} и отряд договорились, что {subject} берётся {first}{}.", chars.as_str())
    } else {
        let owner = if party_gave_word { format!("Слово отряда, собеседник — {npc}") } else { format!("Слово отряду даёт {npc}") };
        format!("Вот тот уговор. {owner}. {obligation}.")
    };
    let status = status_text(field(best, "status"))?;
    Some(format!("{terms} {status}"))
}

//! Журналы, которые редьюсер ведёт в состоянии: боевой (`battleLog`, 50
//! записей), отметки на карте (`mapFeedback`, 6) и экономический
//! (`economyLog`, 50). Запись идемпотентна по id события.

use serde_json::{Map, Value};
use sk_core::game::state_version;
use sk_core::js::s;
use sk_core::Event;

/// `eventJournalId(state, event)`.
pub fn event_journal_id(state: &Value, event: &Event) -> String {
    if let Some(id) = event.extra.get("event_id").filter(|value| !value.is_null()) {
        return s(Some(id));
    }
    let command = event.command_id.clone().unwrap_or_else(|| "command".into());
    format!("{command}:{}:{}", event.event_type, state_version(state) + 1)
}

fn append(state: &mut Value, key: &str, limit: usize, event: &Event, entry: Map<String, Value>) {
    let id = event_journal_id(state, event);
    let list = sk_core::js::array_mut(state, key);
    if list.iter().any(|item| s(item.get("id")) == id) {
        return;
    }
    let mut record = Map::new();
    record.insert("id".into(), Value::String(id));
    for (field, value) in entry {
        record.insert(field, value);
    }
    list.push(Value::Object(record));
    if list.len() > limit {
        let excess = list.len() - limit;
        list.drain(..excess);
    }
}

/// `appendBattleLog(state, event, entry)`.
pub fn append_battle_log(state: &mut Value, event: &Event, entry: Map<String, Value>) {
    append(state, "battleLog", 50, event, entry);
}

/// `appendMapFeedback(state, event, entry)`.
pub fn append_map_feedback(state: &mut Value, event: &Event, entry: Map<String, Value>) {
    append(state, "mapFeedback", 6, event, entry);
}

/// `appendEconomyLog(state, event, entry)`.
pub fn append_economy_log(state: &mut Value, event: &Event, entry: Map<String, Value>) {
    append(state, "economyLog", 50, event, entry);
}

/// `recentBattleSpellName(state, spellId)`.
pub fn recent_battle_spell_name(state: &Value, spell_id: Option<&Value>) -> Option<String> {
    let spell = s(spell_id);
    if spell.is_empty() {
        return None;
    }
    state.get("battleLog").and_then(Value::as_array)?.iter().rev().find_map(|entry| {
        let name = entry.get("spellName").filter(|value| sk_core::js::truthy(Some(value)))?;
        (s(entry.get("spellId")) == spell).then(|| s(Some(name)))
    })
}

/// Сборщик записи журнала: поле кладётся, только если значение есть —
/// как `undefined` в JS, который `JSON.stringify` выбрасывает.
#[derive(Default)]
pub struct Entry(pub Map<String, Value>);

impl Entry {
    pub fn new() -> Self {
        Self(Map::new())
    }

    pub fn set(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.0.insert(key.into(), value.into());
        self
    }

    pub fn opt(mut self, key: &str, value: Option<impl Into<Value>>) -> Self {
        if let Some(value) = value {
            self.0.insert(key.into(), value.into());
        }
        self
    }

    /// `x ? String(x) : undefined` — пустая строка и ложь не кладутся.
    pub fn text_if(self, key: &str, value: Option<&Value>) -> Self {
        let present = sk_core::js::truthy(value);
        self.opt(key, present.then(|| s(value)))
    }

    pub fn flag_if(self, key: &str, condition: bool) -> Self {
        self.opt(key, condition.then_some(true))
    }

    pub fn build(self) -> Map<String, Value> {
        self.0
    }
}

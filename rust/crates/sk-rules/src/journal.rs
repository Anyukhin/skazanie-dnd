//! Журналы, которые редьюсер ведёт в состоянии: боевой (`battleLog`, 50
//! записей), отметки на карте (`mapFeedback`, 6) и экономический
//! (`economyLog`, 50); запись идемпотентна по id события. Перенос
//! `rules-engine.mjs`, 24024–24094: `eventJournalId`, `attackEndpointsFor`,
//! `battleLogAreaFromPayload`, `appendBattleLog`, `recentBattleSpellName`,
//! `appendMapFeedback`, `appendEconomyLog`. Задача Р0.

use serde_json::{json, Map, Value};
use sk_core::game::combat_actor_kind;
use sk_core::js::{self, s};
use sk_core::Event;

/// `x + 1` по правилам JS для поля состояния (строка склеивается, `null` — 0,
/// отсутствие — `NaN`).
fn js_plus_one(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => format!("{text}1"),
        Some(Value::Array(_) | Value::Object(_)) => format!("{}1", js::string(value)),
        other => js::f64_string(js::number(other) + 1.0),
    }
}

/// `eventJournalId(state, event)`:
/// `String(event.event_id ?? \`${event.command_id ?? 'command'}:${event.event_type}:${state.state_version + 1}\`)`.
pub fn event_journal_id(state: &Value, event: &Event) -> String {
    if let Some(id) = event.extra.get("event_id").filter(|value| !value.is_null()) {
        return js::string(Some(id));
    }
    let command = event.command_id.clone().unwrap_or_else(|| "command".into());
    format!("{command}:{}:{}", event.event_type, js_plus_one(state.get("state_version")))
}

fn append(state: &mut Value, key: &str, limit: usize, event: &Event, entry: Map<String, Value>) {
    let id = event_journal_id(state, event);
    let list = js::array_mut(state, key);
    if list.iter().any(|item| js::string(item.get("id")) == id) {
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

/// `recentBattleSpellName(state, spellId)`: имя заклинания из последней
/// записи журнала с тем же `spellId` (строгое сравнение строк).
pub fn recent_battle_spell_name(state: &Value, spell_id: Option<&Value>) -> Option<Value> {
    if !js::truthy(spell_id) {
        return None;
    }
    let spell = js::string(spell_id);
    state.get("battleLog").and_then(Value::as_array)?.iter().rev().find_map(|entry| {
        let name = entry.get("spellName").filter(|value| js::truthy(Some(value)))?;
        (entry.get("spellId").and_then(Value::as_str) == Some(spell.as_str())).then(|| name.clone())
    })
}

/// Безопасное целое `Number(value)` или `None`.
fn safe_number(value: Option<&Value>) -> Option<i64> {
    js::is_safe_integer_number(value).then(|| js::number(value) as i64)
}

/// `attackEndpointsFor(value)`: `{ from, to }` первой и последней точки пути.
pub fn attack_endpoints_for(value: Option<&Value>) -> Option<Value> {
    let list = value?.as_array()?;
    if list.len() < 2 {
        return None;
    }
    let first = list.first()?.as_object()?;
    let last = list.last()?.as_object()?;
    let (from_x, from_y) = (safe_number(first.get("x"))?, safe_number(first.get("y"))?);
    let (to_x, to_y) = (safe_number(last.get("x"))?, safe_number(last.get("y"))?);
    Some(json!({ "from": { "x": from_x, "y": from_y }, "to": { "x": to_x, "y": to_y } }))
}

/// Точка области: `value && Number.isSafeInteger(Number(value.x)) && … ? {x, y} : null`.
fn area_point(value: Option<&Value>) -> Option<(i64, i64)> {
    let value = value.filter(|value| js::truthy(Some(value)))?;
    let field = |key: &str| value.as_object().and_then(|map| map.get(key));
    Some((safe_number(field("x"))?, safe_number(field("y"))?))
}

/// `battleLogAreaFromPayload(state, event, payload)`: строка хроники
/// «областная атака» существа из поля `area` события.
pub fn battle_log_area_from_payload(state: &Value, event: &Event, payload: &Value) -> Option<Map<String, Value>> {
    let area = payload.get("area");
    let from = area_point(area.and_then(|area| area.get("from")))?;
    let to = area_point(area.and_then(|area| area.get("to")))?;
    let area = area?;
    let shape = js::string(area.get("shape"));
    let shape = if matches!(shape.as_str(), "sphere" | "cone" | "line") { shape } else { "sphere".into() };
    let round = sk_core::game::combat(state).get("round").cloned();
    let scene_turn = crate::core::safe_integer_or(state.get("scene").and_then(|scene| scene.get("turn")), round.as_ref());
    let actor_id = event.actor_id.clone().unwrap_or_default();
    let item_name = match crate::core::coalesce(&[payload.get("name"), payload.get("action_id")]) {
        Some(value) => js::string(Some(value)),
        None => String::new(),
    };
    let targets = Value::Array(area.get("target_ids").and_then(Value::as_array).map(|list| list.iter().map(|id| Value::String(js::string(Some(id)))).collect()).unwrap_or_default());
    let mut entry = Map::new();
    entry.insert("sceneTurn".into(), scene_turn);
    if let Some(round) = round {
        entry.insert("round".into(), round);
    }
    entry.insert("type".into(), Value::String("area-attack".into()));
    if let Some(actor) = event.actor_id.clone() {
        entry.insert("actorId".into(), Value::String(actor));
    }
    entry.insert("actorKind".into(), Value::String(combat_actor_kind(state, &actor_id).into()));
    entry.insert("itemName".into(), Value::String(item_name));
    entry.insert("from".into(), json!({ "x": from.0, "y": from.1 }));
    entry.insert("area".into(), json!({ "x": to.0, "y": to.1, "radiusFeet": js::safe_int(area.get("size_feet"), 5).max(5), "shape": shape }));
    entry.insert("targetIds".into(), targets);
    if js::truthy(area.get("damage_type")) {
        entry.insert("damageType".into(), Value::String(js::string(area.get("damage_type"))));
    }
    if js::truthy(area.get("save_ability")) {
        entry.insert("ability".into(), Value::String(js::string(area.get("save_ability"))));
    }
    Some(entry)
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
        let present = js::truthy(value);
        self.opt(key, present.then(|| s(value)))
    }

    pub fn flag_if(self, key: &str, condition: bool) -> Self {
        self.opt(key, condition.then_some(true))
    }

    pub fn build(self) -> Map<String, Value> {
        self.0
    }
}

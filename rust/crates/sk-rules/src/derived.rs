//! Производные поля героя (урок 2 волны «уроки JS-стека», план §1 п.2, §4,
//! §7): `combatSpells`, `combatActions`, `characterSheet`, `inventoryLoad`.
//!
//! JS держит их в самом герое (`DERIVED_PLAYER_FIELDS`): нормализация
//! стирает их и выводит заново из каталога, редьюсер пересчитывает после
//! событий героя. У волшебника 7-го уровня одни карточки заклинаний — 355 КБ,
//! а состояние копируется десятки раз за ход. Здесь они **не хранятся**: в
//! каноническом состоянии (в памяти, в снимках SQLite, в накладке комнаты) на
//! месте поля — пустой слот `null`. Ключ остаётся, потому что его место в
//! герое — настоящее состояние: порядок ключей виден в ответах HTTP, а
//! новое поле героя встаёт после слотов, как в JS.
//!
//! Значение поля — чистая функция от непроизводных полей героя и того, что
//! ещё читает вычисление: редакции (`ruleset_id`), таблицы запасов 2024
//! (`enabled_house_rules`, [`class_resource_options_for`]) и продолжения
//! «Обессиливания» (концентрация и состояния цели в `mechanics`). Итог
//! общий (`Arc`) и запоминается по отпечатку этих входов, а не всего
//! состояния: память — чистая функция входов, как мемо нормализации
//! (`rust/AGENTS.md`, §2 «Быстродействие»).
//!
//! Читатель видит поле так, как его прочёл бы JS ([`read`]): записанное
//! значение — как есть (герой из события или старого снимка, ещё не
//! прошедший нормализацию), пустой слот — вычисленное, нет ключа — `None`.
//! Проекция зрителя, ответы с состоянием целиком и событие отката берут героя
//! с заполненными слотами ([`materialize_player`], [`materialized_state`]).
//!
//! [`class_resource_options_for`]: sk_combat_content::combat_actions::class_resource_options_for

use std::collections::VecDeque;
use std::hash::{Hash, Hasher};
use std::ops::Deref;
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{json, Map, Value};

/// `DERIVED_PLAYER_FIELDS`.
pub const DERIVED_PLAYER_FIELDS: [&str; 4] = ["combatSpells", "combatActions", "characterSheet", "inventoryLoad"];

/// `combatSpells`.
pub const COMBAT_SPELLS: &str = "combatSpells";
/// `combatActions`.
pub const COMBAT_ACTIONS: &str = "combatActions";
/// `characterSheet`.
pub const CHARACTER_SHEET: &str = "characterSheet";
/// `inventoryLoad`.
pub const INVENTORY_LOAD: &str = "inventoryLoad";

/// Производное ли поле героя.
pub fn is_derived_field(key: &str) -> bool {
    DERIVED_PLAYER_FIELDS.contains(&key)
}

// --- каноническая форма --------------------------------------------------------

/// Пустые слоты на месте производных полей героя: значение — `null`, ключ
/// остаётся на своём месте. Так нормализация приводит героя к канонической
/// форме; отдельная функция — для загрузки и миграций старых снимков, где
/// поля лежат целиком (урок 4 может вызвать её из миграции схемы).
pub fn strip_player(player: &mut Value) {
    if let Value::Object(fields) = player {
        for field in DERIVED_PLAYER_FIELDS {
            if let Some(slot) = fields.get_mut(field) {
                *slot = Value::Null;
            }
        }
    }
}

/// [`strip_player`] для всех героев состояния (`state.players`).
pub fn strip_derived_fields(state: &mut Value) {
    if let Some(Value::Array(players)) = state.get_mut("players") {
        for player in players {
            strip_player(player);
        }
    }
}

// --- входы и память ------------------------------------------------------------

/// Входы вычисления помимо самого героя.
#[derive(Debug, Clone, PartialEq)]
struct Inputs {
    /// `ruleset_id` опций `combatSpellsFor` (`{ rulesetId: state.ruleset_id }`).
    ruleset_id: String,
    /// `classResourceOptionsFor(state).classResources2024` — опция листа.
    class_resources_2024: bool,
    /// `enervationContinuationActionFor(state, actor.id)` — хвост боевых действий.
    continuation: Option<Value>,
}

impl Inputs {
    fn of(state: Option<&Value>, actor: &Value) -> Self {
        let options = state.and_then(|state| state.get("ruleset_id")).map(|ruleset| json!({ "rulesetId": ruleset }));
        Inputs {
            ruleset_id: sk_combat_content::combat_spells::ruleset_id_of(options.as_ref()),
            class_resources_2024: sk_combat_content::combat_actions::class_resource_options_for(state).class_resources_2024,
            continuation: state.and_then(|state| crate::enervation_link::enervation_continuation_action_for(state, actor.get("id"), None)),
        }
    }

    fn hash_into(&self, hasher: &mut impl Hasher) {
        self.ruleset_id.hash(hasher);
        self.class_resources_2024.hash(hasher);
        match &self.continuation {
            Some(action) => {
                1u8.hash(hasher);
                hash_value(action, hasher);
            }
            None => 0u8.hash(hasher),
        }
    }
}

/// Запись памяти: вход (герой со слотами `null` и прочие входы) и лениво
/// вычисленные поля.
struct Entry {
    fingerprint: u64,
    actor: Value,
    inputs: Inputs,
    spells: OnceLock<Arc<Value>>,
    actions: OnceLock<Arc<Value>>,
    sheet: OnceLock<Arc<Value>>,
    load: OnceLock<Result<Arc<Value>, String>>,
}

impl Entry {
    fn spells(&self) -> Arc<Value> {
        self.spells
            .get_or_init(|| {
                let options = Value::String(self.inputs.ruleset_id.clone());
                Arc::new(Value::Array(sk_combat_content::combat_spells::combat_spells_for(Some(&self.actor), Some(&options))))
            })
            .clone()
    }

    fn actions(&self) -> Arc<Value> {
        self.actions
            .get_or_init(|| {
                let mut actions = sk_combat_content::combat_actions::combat_actions_for(Some(&self.actor));
                if let Some(continuation) = &self.inputs.continuation {
                    actions.push(continuation.clone());
                }
                Arc::new(Value::Array(actions))
            })
            .clone()
    }

    fn sheet(&self) -> Arc<Value> {
        self.sheet
            .get_or_init(|| {
                let options = sk_combat_content::combat_actions::ClassResourceOptions { class_resources_2024: self.inputs.class_resources_2024 }.to_value();
                Arc::new(sk_character::character_lifecycle::derive_character_sheet(Some(&self.actor), Some(&options)).unwrap_or(Value::Null))
            })
            .clone()
    }

    fn load(&self) -> Result<Arc<Value>, String> {
        self.load.get_or_init(|| sk_items_life::item_lifecycle::inventory_load_for(Some(&self.actor)).map(Arc::new).map_err(|failure| failure.message().to_string())).clone()
    }
}

/// Сколько героев помнить (на весь процесс: проекция зрителя идёт и в
/// потоках `spawn_blocking`).
const LIMIT: usize = 32;

fn memory() -> &'static Mutex<VecDeque<Arc<Entry>>> {
    static MEMORY: OnceLock<Mutex<VecDeque<Arc<Entry>>>> = OnceLock::new();
    MEMORY.get_or_init(|| Mutex::new(VecDeque::with_capacity(LIMIT)))
}

/// Отпечаток значения: порядок ключей и вид чисел учитываются (их различает
/// и сравнение записи памяти).
fn hash_value(value: &Value, hasher: &mut impl Hasher) {
    match value {
        Value::Null => 0u8.hash(hasher),
        Value::Bool(flag) => {
            1u8.hash(hasher);
            flag.hash(hasher);
        }
        Value::Number(number) => {
            2u8.hash(hasher);
            if let Some(integer) = number.as_i64() {
                0u8.hash(hasher);
                integer.hash(hasher);
            } else if let Some(integer) = number.as_u64() {
                1u8.hash(hasher);
                integer.hash(hasher);
            } else {
                2u8.hash(hasher);
                number.as_f64().unwrap_or(f64::NAN).to_bits().hash(hasher);
            }
        }
        Value::String(text) => {
            3u8.hash(hasher);
            text.hash(hasher);
        }
        Value::Array(items) => {
            4u8.hash(hasher);
            items.len().hash(hasher);
            for item in items {
                hash_value(item, hasher);
            }
        }
        Value::Object(map) => {
            5u8.hash(hasher);
            map.len().hash(hasher);
            for (key, item) in map {
                key.hash(hasher);
                hash_value(item, hasher);
            }
        }
    }
}

/// Поля героя, которые читает вычисление: все, кроме производных.
fn input_fields(actor: &Value) -> impl Iterator<Item = (&String, &Value)> {
    actor.as_object().into_iter().flatten().filter(|(key, _)| !is_derived_field(key))
}

fn fingerprint(actor: &Value, inputs: &Inputs) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    match actor {
        Value::Object(_) => {
            for (key, value) in input_fields(actor) {
                key.hash(&mut hasher);
                hash_value(value, &mut hasher);
            }
        }
        other => hash_value(other, &mut hasher),
    }
    inputs.hash_into(&mut hasher);
    hasher.finish()
}

/// Равенство с порядком ключей объектов (`Map::eq` порядок не учитывает).
fn same(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Object(left), Value::Object(right)) => left.len() == right.len() && left.iter().zip(right.iter()).all(|((left_key, left), (right_key, right))| left_key == right_key && same(left, right)),
        (Value::Array(left), Value::Array(right)) => left.len() == right.len() && left.iter().zip(right.iter()).all(|(left, right)| same(left, right)),
        _ => left == right,
    }
}

/// Тот же ли вход: непроизводные поля совпадают по порядку и значению.
fn same_input(stored: &Value, actor: &Value) -> bool {
    match (stored, actor) {
        (Value::Object(_), Value::Object(_)) => {
            let mut left = input_fields(stored);
            let mut right = input_fields(actor);
            loop {
                match (left.next(), right.next()) {
                    (None, None) => return true,
                    (Some((left_key, left)), Some((right_key, right))) if left_key == right_key && same(left, right) => {}
                    _ => return false,
                }
            }
        }
        _ => same(stored, actor),
    }
}

/// Герой без значений производных полей — вход записи памяти.
fn input_copy(actor: &Value) -> Value {
    match actor {
        Value::Object(fields) => Value::Object(fields.iter().map(|(key, value)| (key.clone(), if is_derived_field(key) { Value::Null } else { value.clone() })).collect()),
        other => other.clone(),
    }
}

fn entry_for(state: Option<&Value>, actor: &Value) -> Arc<Entry> {
    let inputs = Inputs::of(state, actor);
    let fingerprint = fingerprint(actor, &inputs);
    {
        let mut known = memory().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(position) = known.iter().position(|entry| entry.fingerprint == fingerprint && entry.inputs == inputs && same_input(&entry.actor, actor)) {
            let entry = known.remove(position).expect("позиция найдена");
            known.push_front(entry.clone());
            return entry;
        }
    }
    let entry = Arc::new(Entry {
        fingerprint,
        actor: input_copy(actor),
        inputs,
        spells: OnceLock::new(),
        actions: OnceLock::new(),
        sheet: OnceLock::new(),
        load: OnceLock::new(),
    });
    let mut known = memory().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    known.push_front(entry.clone());
    known.truncate(LIMIT);
    entry
}

/// Запись вне памяти: вход, который больше не встретится (герой на полпути
/// нормализации).
fn transient(state: Option<&Value>, actor: &Value) -> Entry {
    Entry {
        fingerprint: 0,
        actor: input_copy(actor),
        inputs: Inputs::of(state, actor),
        spells: OnceLock::new(),
        actions: OnceLock::new(),
        sheet: OnceLock::new(),
        load: OnceLock::new(),
    }
}

/// Нормализация JS (`normalizePlayer`) выводит поля из героя на полпути:
/// заклинания и действия — до уровня в пределах, опыта, хитов, монет и
/// инвентаря, лист и груз — до полей клеток. У героя, уже прошедшего
/// нормализацию, это тот же герой, и слот остаётся пустым. Если же
/// нормализация героя что-то поменяла (сырой вход: уровень 20, свежий
/// предмет) и вывод из итогового героя дал бы другое значение, в слот
/// записывается значение JS — до следующей нормализации, где герой уже
/// итоговый. `spells_input` и `sheet_input` — герой в те два момента.
pub(crate) fn settle_normalized(state: &Value, player: &mut Value, spells_input: &Value, sheet_input: &Value) {
    let spells_moved = !same_input(spells_input, player);
    let sheet_moved = !same_input(sheet_input, player);
    if !spells_moved && !sheet_moved {
        return;
    }
    let lazy = entry_for(Some(state), player);
    let mut stored: Vec<(&str, Value)> = Vec::new();
    if spells_moved {
        let js = transient(Some(state), spells_input);
        if !same(&js.spells(), &lazy.spells()) {
            stored.push((COMBAT_SPELLS, (*js.spells()).clone()));
        }
        if !same(&js.actions(), &lazy.actions()) {
            stored.push((COMBAT_ACTIONS, (*js.actions()).clone()));
        }
    }
    if sheet_moved {
        let js = transient(Some(state), sheet_input);
        if !same(&js.sheet(), &lazy.sheet()) {
            stored.push((CHARACTER_SHEET, (*js.sheet()).clone()));
        }
        if let Ok(load) = js.load() {
            if !lazy.load().is_ok_and(|lazy| same(&load, &lazy)) {
                stored.push((INVENTORY_LOAD, (*load).clone()));
            }
        }
    }
    if let Value::Object(fields) = player {
        for (field, value) in stored {
            if let Some(slot) = fields.get_mut(field) {
                *slot = value;
            }
        }
    }
}

// --- вычисление ----------------------------------------------------------------

/// `combatSpellsFor(actor, { rulesetId: state.ruleset_id })`: карточки
/// заклинаний героя из каталога.
pub fn combat_spells(state: Option<&Value>, actor: &Value) -> Arc<Value> {
    entry_for(state, actor).spells()
}

/// `combatActionsFor(actor)` и продолжение «Обессиливания»
/// (`enervationContinuationActionFor`): боевые действия героя.
pub fn combat_actions(state: Option<&Value>, actor: &Value) -> Arc<Value> {
    entry_for(state, actor).actions()
}

/// `deriveCharacterSheet(actor, classResourceOptionsFor(state))`; отказ
/// вывода — `null` (как в нормализации JS).
pub fn character_sheet(state: Option<&Value>, actor: &Value) -> Arc<Value> {
    entry_for(state, actor).sheet()
}

/// `inventoryLoadFor(actor)`: груз героя. Ошибка — текст `TypeError` JS на
/// мусорном инвентаре.
pub fn inventory_load(state: Option<&Value>, actor: &Value) -> Result<Arc<Value>, String> {
    entry_for(state, actor).load()
}

/// Вычисленное значение поля (`None` — не производное поле или отказ груза).
fn computed(state: Option<&Value>, actor: &Value, field: &str) -> Option<Arc<Value>> {
    let entry = entry_for(state, actor);
    match field {
        COMBAT_SPELLS => Some(entry.spells()),
        COMBAT_ACTIONS => Some(entry.actions()),
        CHARACTER_SHEET => Some(entry.sheet()),
        INVENTORY_LOAD => entry.load().ok(),
        _ => None,
    }
}

// --- чтение --------------------------------------------------------------------

/// Значение производного поля для читателя: записанное или вычисленное.
#[derive(Debug, Clone)]
pub enum Derived<'a> {
    Stored(&'a Value),
    Computed(Arc<Value>),
}

impl Deref for Derived<'_> {
    type Target = Value;

    fn deref(&self) -> &Value {
        match self {
            Derived::Stored(value) => value,
            Derived::Computed(value) => value,
        }
    }
}

/// Поле `field` героя так, как его прочёл бы JS: записанное значение (не
/// `null`) — как есть; пустой слот — вычисленное из героя; ключа нет —
/// `None`. Герой — объект из `state.players` (или его копия); `state` —
/// состояние, из которого он взят (редакция, правила дома, продолжение).
/// Слот выводится только у героя отряда: `null` в поле противника или
/// призванного существа с тем же именем — просто `null` (JS выводит поля
/// только у `state.players`). Без состояния герой считается героем отряда.
pub fn read<'a>(state: Option<&Value>, actor: &'a Value, field: &str) -> Option<Derived<'a>> {
    match actor.get(field)? {
        Value::Null if is_party_hero(state, actor) => match computed(state, actor, field) {
            Some(value) => Some(Derived::Computed(value)),
            None => Some(Derived::Stored(&NULL)),
        },
        stored => Some(Derived::Stored(stored)),
    }
}

/// Герой из `state.players` (по `id`); без состояния — да.
fn is_party_hero(state: Option<&Value>, actor: &Value) -> bool {
    let Some(state) = state else { return true };
    let id = actor.get("id");
    state.get("players").and_then(Value::as_array).is_some_and(|players| players.iter().any(|player| player.get("id") == id))
}

static NULL: Value = Value::Null;

/// [`read`] для `Option<&Value>` героя.
pub fn read_opt<'a>(state: Option<&Value>, actor: Option<&'a Value>, field: &str) -> Option<Derived<'a>> {
    read(state, actor?, field)
}

/// Герой с заполненными слотами — таким его держит состояние JS. Отказ
/// груза (не бывает у нормализованного героя) оставляет слот `null`.
pub fn materialize_player(state: Option<&Value>, player: &Value) -> Value {
    let Value::Object(fields) = player else { return player.clone() };
    if !DERIVED_PLAYER_FIELDS.iter().any(|field| matches!(fields.get(*field), Some(Value::Null))) {
        return player.clone();
    }
    let entry = entry_for(state, player);
    let mut out = Map::with_capacity(fields.len());
    for (key, value) in fields {
        let value = match (key.as_str(), value) {
            (COMBAT_SPELLS, Value::Null) => (*entry.spells()).clone(),
            (COMBAT_ACTIONS, Value::Null) => (*entry.actions()).clone(),
            (CHARACTER_SHEET, Value::Null) => (*entry.sheet()).clone(),
            (INVENTORY_LOAD, Value::Null) => entry.load().map(|load| (*load).clone()).unwrap_or(Value::Null),
            _ => value.clone(),
        };
        out.insert(key.clone(), value);
    }
    Value::Object(out)
}

/// Герои состояния с заполненными слотами (`state.players` не массив — как есть).
pub fn materialized_players(state: &Value) -> Option<Value> {
    match state.get("players")? {
        Value::Array(players) => Some(Value::Array(players.iter().map(|player| materialize_player(Some(state), player)).collect())),
        other => Some(other.clone()),
    }
}

/// Копия состояния с заполненными слотами героев — форма состояния JS (для
/// ответа целиком и события, которое несёт состояние).
pub fn materialized_state(state: &Value) -> Value {
    let Value::Object(fields) = state else { return state.clone() };
    let players = materialized_players(state);
    let mut out = Map::with_capacity(fields.len());
    for (key, value) in fields {
        if key == "players" {
            out.insert(key.clone(), players.clone().unwrap_or(Value::Null));
        } else {
            out.insert(key.clone(), value.clone());
        }
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wizard() -> Value {
        json!({
            "id": "mage", "character": "Маг", "characterClass": "wizard", "level": 3, "experience": 900,
            "abilities": { "str": 8, "dex": 14, "con": 13, "int": 16, "wis": 12, "cha": 10 },
            "knownSpellIds": ["fire-bolt", "magic-missile", "shield"], "preparedSpellIds": ["magic-missile", "shield"],
            "inventory": [], "combatSpells": null, "combatActions": null, "inventoryLoad": null, "characterSheet": null,
        })
    }

    #[test]
    fn slots_keep_their_place_and_values_come_from_the_catalog() {
        let state = json!({ "ruleset_id": "dnd_5e_2014", "players": [wizard()] });
        let player = &state["players"][0];
        let materialized = materialize_player(Some(&state), player);
        let keys: Vec<&String> = materialized.as_object().unwrap().keys().collect();
        let original: Vec<&String> = player.as_object().unwrap().keys().collect();
        assert_eq!(keys, original, "порядок ключей героя не меняется");
        let options = json!("dnd_5e_2014");
        assert_eq!(materialized["combatSpells"], Value::Array(sk_combat_content::combat_spells::combat_spells_for(Some(player), Some(&options))));
        assert_eq!(materialized["combatActions"], Value::Array(sk_combat_content::combat_actions::combat_actions_for(Some(player))));
        assert!(materialized["characterSheet"].is_object());
        assert!(materialized["inventoryLoad"].is_object());
    }

    #[test]
    fn stored_values_are_read_as_is_and_missing_keys_stay_missing() {
        let mut hero = wizard();
        hero["characterSheet"] = json!({ "armor_class": { "value": 99 } });
        hero.as_object_mut().unwrap().shift_remove("combatSpells");
        let state = json!({ "players": [hero.clone()] });
        assert_eq!(read(Some(&state), &hero, CHARACTER_SHEET).map(|sheet| sheet["armor_class"]["value"].clone()), Some(json!(99)));
        assert!(read(Some(&state), &hero, COMBAT_SPELLS).is_none());
        assert!(read(Some(&state), &hero, COMBAT_ACTIONS).is_some_and(|actions| actions.is_array()));
    }

    #[test]
    fn memory_follows_inputs_not_identity() {
        let state = json!({ "ruleset_id": "dnd_5e_2014", "players": [wizard()] });
        let first = combat_spells(Some(&state), &state["players"][0]);
        let again = combat_spells(Some(&state), &wizard());
        assert!(Arc::ptr_eq(&first, &again), "тот же вход — тот же итог из памяти");
        let mut leveled = wizard();
        leveled["level"] = json!(5);
        let other = combat_spells(Some(&state), &leveled);
        assert!(!Arc::ptr_eq(&first, &other), "другой вход — другой итог");
        let mut filled = wizard();
        filled["combatSpells"] = json!([{ "id": "stale" }]);
        assert!(Arc::ptr_eq(&first, &combat_spells(Some(&state), &filled)), "значение слота во вход не входит");
        let srd = json!({ "ruleset_id": "srd_5_2_1", "players": [wizard()] });
        assert!(!Arc::ptr_eq(&first, &combat_spells(Some(&srd), &wizard())), "редакция — вход");
    }

    #[test]
    fn strip_keeps_keys_and_drops_values() {
        let mut state = json!({ "players": [{ "id": "a", "combatSpells": [1], "name": "А", "inventoryLoad": { "weight": 1 } }, { "id": "b" }] });
        strip_derived_fields(&mut state);
        assert_eq!(state, json!({ "players": [{ "id": "a", "combatSpells": null, "name": "А", "inventoryLoad": null }, { "id": "b" }] }));
    }
}

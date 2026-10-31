//! Прогон боя боевого стенда: перенос `runCombatScenario`
//! (`eval/combat-lab.mjs:358–495`) поверх перенесённых `sk-rules`,
//! `sk-turns` (планировщик NPC), `sk-projection` (проекция игрока) и
//! `sk-tactics` (реакция героя, автотактика своего боя).
//!
//! Один прогон — одна кампания в своём хранилище в памяти (`FileEventStore`
//! во временном каталоге в JS): снимок каждые 7 событий, часы стоят на
//! `NOW`, коммиты нумеруются `commit-N`, кости — LCG
//! `lcg32-1664525-1013904223/v1` от `seed` с журналом бросков. Каждый шаг:
//! команда героя через исполнителя (с повтором по тому же ключу — без новых
//! бросков и коммита), запрет второй атаки, ходы NPC планировщиком, сверка
//! replay без снимков; кадр наблюдателя — после каждого коммита
//! (`observedEventStore`). Проверки арены (`combatEventChecker`,
//! `assertState`, итог боя) повторены вместе с текстами; их провал — отказ
//! `ERR_ASSERTION`, как `AssertionError`.
//!
//! Отличия от JS (см. отчёт С5):
//! - хранилище в памяти: проверка «состояние не изменилось при повторном
//!   открытии хранилища» (`new FileEventStore(options).load`) не делается;
//! - `report.error` — `{ message, code }`, без `stack`;
//! - в отчёт не входят `events`, `event_counts`, `outcome` и события шагов:
//!   реестр (`CombatLabRuns.execute`) берёт из отчёта только `passed`,
//!   `error`, `initial_state`, `final_state`, `rolls` и пять полей шагов;
//! - свой бой планирует `plan_hero_combat_command` (сервер JS передаёт
//!   стенду именно `planHeroCombatCommand`), а признак — наличие
//!   `choose_command` у запроса.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::task::{Context as TaskContext, Poll, Wake, Waker};

use serde_json::{json, Map, Value};
use sk_core::js;
use sk_core::state::Point;
use sk_dice::{DiceError, DiceService, Rng};
use sk_rules::dice_record::ServiceDice;
use sk_rules::pause::Halt;
use sk_rules::resolve::api::RulesEngine;
use sk_store::executor::{ExecutorError, Journal};
use sk_store::{CommitRequest, CommitResult, EventStore, InitializeRequest, LoadOptions, Loaded, StoreError, StoreOptions, StoreResult};
use sk_tactics::combat_lab::{AbortSignal, CombatLabError, RunFailure, ScenarioRun, ScenarioRunner, COMBAT_SCENARIOS};
use sk_turns::npc_turn_scheduler::{execute_plan, run_npc_turn_scheduler, NpcRulesEngine, NpcTurnJournal, SchedulerError, SchedulerOptions};

const NOW: &str = "2026-09-06T12:00:00.000Z";

/// `ScenarioRunner` сервера: `runCombatScenario` из `eval/combat-lab.mjs`.
pub struct LabRunner;

impl ScenarioRunner for LabRunner {
    fn run(&self, request: ScenarioRun, on_frame: &mut dyn FnMut(Value) -> Result<(), CombatLabError>, signal: &AbortSignal) -> Result<Value, RunFailure> {
        run_combat_scenario(request, on_frame, signal)
    }
}

// --- исключения ---------------------------------------------------------------

/// Брошенное исключение JS: `{ message, code }`.
#[derive(Debug, Clone)]
struct Thrown {
    message: String,
    code: Option<String>,
}

type Try<T = ()> = Result<T, Thrown>;

impl Thrown {
    fn new(message: impl Into<String>, code: Option<&str>) -> Self {
        Self { message: message.into(), code: code.map(str::to_string) }
    }

    /// `AssertionError` (`code: 'ERR_ASSERTION'`).
    fn assertion(message: impl Into<String>) -> Self {
        Self::new(message, Some("ERR_ASSERTION"))
    }

    /// `TypeError` рантайма JS (кода нет).
    fn type_error(message: impl Into<String>) -> Self {
        Self::new(message, None)
    }

    fn abort() -> Self {
        Self::new("Бой отменён", Some("ABORT_ERR"))
    }

    fn halt(halt: &Halt) -> Self {
        match halt {
            Halt::Rule(error) => Self::new(error.message.clone(), Some(&error.code)),
            Halt::Fault(fault) => Self { message: fault.message.clone(), code: fault.code.clone() },
        }
    }

    fn store(error: &StoreError) -> Self {
        Self::new(error.message.clone(), Some(error.code))
    }

    fn executor(error: &ExecutorError) -> Self {
        match error {
            ExecutorError::Executor { code, message } => Self::new(message.clone(), Some(code)),
            ExecutorError::Store(error) => Self::store(error),
            ExecutorError::Rule(error) => Self::new(error.message.clone(), Some(&error.code)),
        }
    }

    fn scheduler(error: &SchedulerError) -> Self {
        match error {
            SchedulerError::Rule(error) => Self::new(error.message.clone(), Some(&error.code)),
            SchedulerError::Halt(halt) => Self::halt(halt),
            SchedulerError::Executor(error) => Self::executor(error),
            SchedulerError::Range(message) => Self::new(message.clone(), None),
        }
    }

    fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("message".into(), Value::String(self.message.clone()));
        if let Some(code) = &self.code {
            map.insert("code".into(), Value::String(code.clone()));
        }
        Value::Object(map)
    }
}

impl From<Thrown> for RunFailure {
    fn from(thrown: Thrown) -> Self {
        RunFailure::new(thrown.message, thrown.code)
    }
}

/// `assert.ok(condition, message)`.
fn ensure(condition: bool, message: impl FnOnce() -> String) -> Try {
    if condition {
        Ok(())
    } else {
        Err(Thrown::assertion(message()))
    }
}

// --- приведения JS ------------------------------------------------------------

fn get<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|value| value.get(key))
}

fn path<'a>(value: Option<&'a Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().fold(value, |value, key| get(value, key))
}

fn list(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn num(value: Option<&Value>) -> f64 {
    js::number(value)
}

/// `a == b` JS для значений JSON (`undefined` — `None`).
fn loose_eq(left: Option<&Value>, right: Option<&Value>) -> bool {
    let left = left.filter(|value| !value.is_null());
    let right = right.filter(|value| !value.is_null());
    match (left, right) {
        (None, None) => true,
        (None, Some(_)) | (Some(_), None) => false,
        (Some(Value::String(a)), Some(Value::String(b))) => a == b,
        (Some(a @ (Value::Object(_) | Value::Array(_))), Some(b @ (Value::Object(_) | Value::Array(_)))) => std::ptr::eq(a, b),
        (Some(Value::Object(_) | Value::Array(_)), Some(_)) | (Some(_), Some(Value::Object(_) | Value::Array(_))) => false,
        (Some(a), Some(b)) => num(Some(a)) == num(Some(b)),
    }
}

/// `assert.deepEqual` (нестрогое): ключи без порядка, примитивы через `==`.
fn deep_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Object(a), Value::Object(b)) => a.len() == b.len() && a.iter().all(|(key, value)| b.get(key).is_some_and(|other| deep_equal(value, other))),
        (Value::Array(a), Value::Array(b)) => a.len() == b.len() && a.iter().zip(b).all(|(x, y)| deep_equal(x, y)),
        (Value::Object(_) | Value::Array(_), _) | (_, Value::Object(_) | Value::Array(_)) => false,
        (Value::Null, Value::Null) => true,
        (Value::Null, _) | (_, Value::Null) => false,
        (a, b) => loose_eq(Some(a), Some(b)),
    }
}

/// `Math.max(|a.x - b.x|, |a.y - b.y|) * 5`.
fn distance(from: (f64, f64), to: (f64, f64)) -> f64 {
    (from.0 - to.0).abs().max((from.1 - to.1).abs()) * 5.0
}

fn coords(point: Option<&Value>) -> Try<(f64, f64)> {
    match point.filter(|point| !point.is_null()) {
        Some(point) => Ok((num(point.get("x")), num(point.get("y")))),
        None => Err(Thrown::type_error("Cannot read properties of undefined (reading 'x')")),
    }
}

fn point_coords(point: Option<Point>) -> Try<(f64, f64)> {
    point.map(|point| (point.x as f64, point.y as f64)).ok_or_else(|| Thrown::type_error("Cannot read properties of null (reading 'x')"))
}

fn actors_of(state: &Value) -> Vec<&Value> {
    list(state.get("players")).iter().chain(list(state.get("enemies"))).collect()
}

fn actor_position(state: &Value, id: &str) -> Option<Point> {
    sk_core::game::actor_position(state, id)
}

// --- кости ----------------------------------------------------------------------

/// `rng.randint` стенда: LCG с журналом бросков.
struct LabRng {
    state: u32,
    rolls: Rc<RefCell<Vec<Value>>>,
}

impl Rng for LabRng {
    fn randint(&mut self, minimum: i64, maximum: i64) -> Result<i64, DiceError> {
        self.state = self.state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let value = minimum + (f64::from(self.state) / 4_294_967_296.0 * (maximum - minimum + 1) as f64).floor() as i64;
        self.rolls.borrow_mut().push(json!({ "min": minimum, "max": maximum, "value": value }));
        Ok(value)
    }
}

/// `sequence(prefix)`.
fn sequence(prefix: &'static str) -> impl FnMut() -> String {
    let mut id = 0u64;
    move || {
        id += 1;
        format!("{prefix}-{id}")
    }
}

fn engine(seed: u32, rolls: Rc<RefCell<Vec<Value>>>) -> RefCell<RulesEngine> {
    let dice = DiceService::new(LabRng { state: seed, rolls }, Box::new(sequence("roll")), Box::new(|| NOW.to_string()));
    RefCell::new(RulesEngine::new(Box::new(ServiceDice::new(dice))))
}

fn store() -> StoreResult<EventStore> {
    let now = sk_core::clock::parse_iso(NOW).unwrap_or(0);
    let serial = Arc::new(AtomicU64::new(0));
    let options = StoreOptions {
        snapshot_every: 7,
        clock: Arc::new(move || now),
        id_factory: Arc::new(move || format!("commit-{}", serial.fetch_add(1, Ordering::SeqCst) + 1)),
        ..StoreOptions::default()
    };
    EventStore::in_memory(Arc::new(sk_tactics::cutover_audit::GameReducer::new()), options)
}

// --- арены ----------------------------------------------------------------------

fn hero(id: &str, x: i64, y: i64) -> Value {
    json!({
        "id": id, "character": id, "characterClass": "fighter", "level": 1,
        "hp": 35, "maxHp": 35, "armor": 16, "speed": 30, "proficiency": 2,
        "abilities": { "str": 16, "dex": 14, "con": 14, "int": 10, "wis": 12, "cha": 10 },
        "attackBonus": 5, "damageDice": 8, "damageBonus": 3, "damageType": "slashing", "attackRange": 5,
        "inventory": [], "x": x, "y": y,
    })
}

fn enemy(id: &str, x: i64, y: i64) -> Value {
    js::spread(&hero(id, x, y), json!({ "name": id, "hp": 16, "maxHp": 16, "armor": 12, "attackBonus": 4, "damageDice": 6, "damageBonus": 2, "alive": true }))
}

fn set(actor: &mut Value, key: &str, value: Value) {
    if let Some(map) = actor.as_object_mut() {
        map.insert(key.into(), value);
    }
}

fn push_item(actor: &mut Value, item: Value) {
    if let Some(Value::Array(items)) = actor.get_mut("inventory") {
        items.push(item);
    }
}

/// `fixture(scenario)`.
fn fixture(scenario: &str) -> Try<Value> {
    let mut players = vec![hero("hero", 1, 2)];
    let near = ["duel", "opportunity-attack", "concentration"].contains(&scenario);
    let mut enemies = vec![enemy("enemy", if near { 2 } else { 7 }, 2)];
    if scenario == "approach" {
        set(&mut enemies[0], "speed", json!(10));
    }
    if scenario == "two-heroes" || scenario == "healing" {
        players.push(hero("ally", 1, 3));
        enemies.push(enemy("enemy-2", 7, 3));
    }
    if scenario == "ranged" {
        let options = sk_chargen::starter_kit::StarterKitOptions { ruleset_id: "dnd_5e_2014".into(), ..Default::default() };
        let kit = sk_chargen::starter_kit::with_starter_kit(Some(&json!({ "id": "hero", "characterClass": "ranger" })), &options).map_err(|error| Thrown::new(error.to_string(), None))?;
        let mut inventory = list(kit.get("inventory")).to_vec();
        for item in inventory.iter_mut() {
            if js::s(item.get("type")) == "weapon" {
                let ranged = path(Some(item), &["combat", "kind"]).and_then(Value::as_str) == Some("ranged");
                set(item, "equipped", Value::Bool(ranged));
            }
        }
        let weapon = inventory.iter().find(|item| js::s(item.get("type")) == "weapon" && js::truthy(item.get("equipped"))).ok_or_else(|| Thrown::type_error("Cannot read properties of undefined (reading 'combat')"))?;
        let range = path(Some(weapon), &["combat", "normalRange"]).cloned();
        set(&mut players[0], "inventory", Value::Array(inventory));
        match range {
            Some(range) => set(&mut players[0], "attackRange", range),
            None => {
                if let Some(map) = players[0].as_object_mut() {
                    map.shift_remove("attackRange");
                }
            }
        }
        set(&mut players[0], "damageType", json!("piercing"));
        set(&mut enemies[0], "speed", json!(10));
    }
    if scenario == "healing" {
        set(&mut players[1], "hp", json!(1));
        push_item(&mut players[0], json!({ "id": "potion", "catalog_id": "srd_5_2_1:potion-of-healing", "name": "Зелье лечения", "type": "consumable", "quantity": 1 }));
    }
    if scenario == "concentration" {
        let abilities = js::spread(players[0].get("abilities").unwrap_or(&Value::Null), json!({ "wis": 16 }));
        players[0] = js::spread(&players[0], json!({ "characterClass": "cleric", "level": 3, "preparedSpellIds": ["bless", "sacred-flame"], "abilities": abilities }));
        push_item(&mut players[0], sk_items::item_catalog::materialize_catalog_item("srd_5_2_1:holy-symbol-amulet", Some(&json!({ "id": "cleric-focus", "quantity": 1, "equipped": true }))));
        set(&mut enemies[0], "hp", json!(30));
        set(&mut enemies[0], "maxHp", json!(30));
    }
    let cells: Vec<Value> = (0..50).map(|i| json!({ "x": i % 10, "y": i / 10, "type": "floor", "revealed": true })).collect();
    let options = sk_tactical::tactical_map::LegacyMapOptions { location_id: "combat-lab", seed: "", generator: None, tileset_id: "" };
    let map_error = |error: sk_tactical::tactical_map::TacticalMapError| Thrown { message: error.message, code: Some(error.code) };
    let mut map = sk_tactical::tactical_map::tactical_map_from_legacy_cells(&cells, &options).map_err(map_error)?;
    if scenario == "difficult-terrain" {
        for x in 2..=6 {
            for y in 0..5 {
                sk_tactical::tactical_map::set_cell_json(&mut map, x, y, &json!({ "moveCost": 2 })).map_err(map_error)?;
            }
        }
    }
    let serialized = sk_tactical::tactical_map::serialize_tactical_map(&map).map_err(map_error)?;
    let party_ids: Vec<Value> = players.iter().map(|actor| actor.get("id").cloned().unwrap_or(Value::Null)).collect();
    let state = json!({
        "sessionCode": "COMBAT-LAB", "campaign": "Боевой стенд",
        "ruleset_id": "dnd_5e_2014", "ruleset_version": "2014.1.0", "enabled_rule_packs": ["dnd_5e_2014"],
        "enabled_house_rules": ["skazanie:2014-preview-legacy-catalogs-v1"],
        "partyMemberIds": party_ids, "activePlayerId": "hero", "players": players, "enemies": enemies,
        "scene": { "title": "Арена стенда", "location": "combat-lab", "turn": 1, "cells": cells, "map": serialized },
    });
    sk_rules::normalize::normalize_campaign_state(&state).map_err(|halt| Thrown::halt(&halt))
}

// --- бот арены --------------------------------------------------------------------

fn end_turn(actor_id: &str) -> Value {
    json!({ "command_type": "EndTurn", "actor_id": actor_id })
}

/// `chooseLabCommand(view, actorId, report)`: лечение рядом, сближение, атака.
fn choose_lab_command(view: &Value, actor_id: &str, steps: &[Map<String, Value>], scenario: &str) -> Try<Value> {
    let combat = path(Some(view), &["mechanics", "combat"]);
    let window = get(combat, "reaction_window");
    if js::truthy(window) {
        let plan = sk_tactics::party_tactics::plan_hero_reaction(view, window);
        return Ok(plan.commands.into_iter().next().unwrap_or(Value::Null));
    }
    let hero = list(view.get("players")).iter().find(|actor| js::string(actor.get("id")) == actor_id);
    let end = end_turn(actor_id);
    let Some(hero) = hero else { return Ok(end) };
    // `hero.hp <= 0`: `undefined` — `NaN` (ложь), `null` — 0.
    if num(hero.get("hp")) <= 0.0 {
        return Ok(end);
    }
    let economy = get(get(combat, "action_economy"), actor_id);
    let from = actor_position(view, actor_id);
    if js::is_false(get(economy, "action")) {
        return Ok(end);
    }
    let used = |kind: &str| steps.iter().any(|entry| js::string(path(entry.get("command"), &["actor_id"])) == actor_id && js::string(path(entry.get("command"), &["command_type"])) == kind);
    if scenario == "opportunity-attack" && !used("MoveActor") {
        return Ok(json!({ "command_type": "MoveActor", "actor_id": actor_id, "to": { "x": 4, "y": 2 } }));
    }
    if scenario == "concentration" && !used("CastSpell") {
        return Ok(json!({ "command_type": "CastSpell", "actor_id": actor_id, "spell_id": "bless", "target_id": actor_id, "target_ids": [actor_id] }));
    }
    let potion = list(hero.get("inventory")).iter().find(|item| js::string(item.get("id")) == "potion" && num(item.get("quantity")) > 0.0);
    let mut wounded = None;
    for actor in list(view.get("players")) {
        if num(actor.get("hp")) < num(actor.get("maxHp")) / 3.0 {
            let id = js::string(actor.get("id"));
            if distance(point_coords(from)?, point_coords(actor_position(view, &id))?) <= 5.0 {
                wounded = Some(actor);
                break;
            }
        }
    }
    if let (Some(potion), Some(wounded)) = (potion, wounded) {
        return Ok(json!({ "command_type": "UseItem", "actor_id": actor_id, "item_id": potion.get("id"), "target_id": wounded.get("id") }));
    }
    let mut targets: Vec<(&Value, f64, String)> = Vec::new();
    for actor in list(view.get("enemies")).iter().filter(|actor| !js::is_false(actor.get("alive"))) {
        let id = js::string(actor.get("id"));
        let gap = distance(point_coords(from)?, point_coords(actor_position(view, &id))?);
        targets.push((actor, gap, id));
    }
    targets.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal).then_with(|| sk_core::text::locale_compare(&a.2, &b.2)));
    let Some((target, _, target_id)) = targets.into_iter().next() else { return Ok(end) };
    if scenario == "concentration" {
        return Ok(json!({ "command_type": "CastSpell", "actor_id": actor_id, "spell_id": "sacred-flame", "target_id": target.get("id") }));
    }
    let to = actor_position(view, &target_id);
    let range = hero.get("attackRange").filter(|range| !range.is_null()).map_or(5.0, |range| num(Some(range)));
    if distance(point_coords(from)?, point_coords(to)?) <= range {
        let weapon = list(hero.get("inventory")).iter().find(|item| js::s(item.get("type")) == "weapon" && js::truthy(item.get("equipped")));
        let mut command = json!({ "command_type": "MakeAttack", "actor_id": actor_id, "target_id": target.get("id") });
        if let Some(weapon) = weapon {
            set(&mut command, "item_id", weapon.get("id").cloned().unwrap_or(Value::Null));
        }
        return Ok(command);
    }
    let Some(to) = to else { return Err(Thrown::type_error("Cannot read properties of null (reading 'x')")) };
    // Серверный поиск ожидает точные ОЗ; в проекции врагов их нет — бот
    // останавливается перед видимой фишкой.
    let mut occupied = HashSet::new();
    for actor in actors_of(view) {
        let id = js::string(actor.get("id"));
        let hp = actor.get("hp").filter(|hp| !hp.is_null());
        if id != actor_id && !js::is_false(actor.get("alive")) && hp.is_none_or(|hp| num(Some(hp)) > 0.0) {
            let at = point_coords(actor_position(view, &id))?;
            occupied.insert((at.0 as i64, at.1 as i64));
        }
    }
    let options = sk_rules::tactical_geometry::PathOptions { allow_occupied_destination: true, step_cost: None, tactical_map: None };
    let to = sk_geometry::Point::new(to.x as f64, to.y as f64);
    let mut route = sk_rules::tactical_geometry::shortest_tactical_path(view, actor_id, to, options).unwrap_or_default();
    route.pop();
    if let Some(blocked) = route.iter().position(|at| occupied.contains(&(at.x as i64, at.y as i64))) {
        route.truncate(blocked);
    }
    let budget = num(hero.get("speed")) + get(economy, "movement_bonus").filter(|v| !v.is_null()).map_or(0.0, |v| num(Some(v))) - get(economy, "movement_spent").filter(|v| !v.is_null()).map_or(0.0, |v| num(Some(v)));
    while !route.is_empty() && sk_rules::geometry::terrain::movement_cost_of_path(view, actor_id, &route, None) > budget {
        route.pop();
    }
    Ok(match route.last() {
        Some(last) => json!({ "command_type": "MoveActor", "actor_id": actor_id, "to": { "x": js::num(last.x), "y": js::num(last.y) } }),
        None => end,
    })
}

// --- проверки ---------------------------------------------------------------------

/// `assertState(state)`.
fn assert_state(state: &Value) -> Try {
    let concentration = path(Some(state), &["mechanics", "concentration"]);
    for actor in actors_of(state) {
        let id = js::string(actor.get("id"));
        let hp = actor.get("hp");
        let finite = matches!(hp, Some(Value::Number(_))) && num(hp).is_finite();
        ensure(finite && num(hp) >= 0.0 && num(hp) <= num(actor.get("maxHp")), || format!("ОЗ вне диапазона: {id}"))?;
        if num(hp) == 0.0 {
            ensure(get(concentration, &id).is_none_or(Value::is_null), || format!("Концентрация сохранилась при 0 ОЗ: {id}"))?;
        }
    }
    let combat = path(Some(state), &["mechanics", "combat"]);
    if let Some(Value::Object(economies)) = get(combat, "action_economy") {
        for (id, economy) in economies {
            let spent = economy.get("movement_spent");
            ensure(matches!(spent, Some(Value::Number(_))) && num(spent).is_finite() && num(spent) >= 0.0, || format!("Некорректное движение: {id}"))?;
        }
    }
    if let Some(Value::Object(resources)) = path(Some(state), &["mechanics", "resources"]) {
        for (id, actor_resources) in resources {
            if let Value::Object(actor_resources) = actor_resources {
                for (name, resource) in actor_resources {
                    let current = resource.get("current");
                    let valid = matches!(current, Some(Value::Number(_))) && num(current).is_finite() && num(current) >= 0.0 && num(current) <= num(resource.get("max"));
                    ensure(valid, || format!("Ресурс вне диапазона: {id}/{name}"))?;
                }
            }
        }
    }
    let initiative: Vec<String> = list(get(combat, "initiative")).iter().map(|entry| js::string(entry.get("actor_id"))).collect();
    let unique: HashSet<&String> = initiative.iter().collect();
    ensure(unique.len() == initiative.len(), || "Участник продублирован в инициативе".into())
}

/// Бюджет хода героя в `combatEventChecker`.
#[derive(Clone)]
struct Budget(HashMap<String, f64>);

impl Budget {
    fn fresh() -> Self {
        Self(["action", "bonus_action", "reaction", "movement", "dashes"].iter().map(|key| ((*key).to_string(), 0.0)).collect())
    }

    /// `budget[kind]`: нет поля — `undefined`, `++` даёт `NaN`.
    fn get(&self, kind: &str) -> f64 {
        self.0.get(kind).copied().unwrap_or(f64::NAN)
    }

    fn bump(&mut self, kind: &str, amount: f64) {
        let value = self.get(kind) + amount;
        self.0.insert(kind.to_string(), value);
    }
}

/// `combatEventChecker(initial)`: независимые проверки малых арен (одно
/// оружейное действие за ход, без Extra Attack и Action Surge).
struct EventChecker {
    speeds: HashMap<String, f64>,
    map: sk_tactical::tactical_map::TacticalMap,
    economies: HashMap<String, Budget>,
    positions: HashMap<String, Value>,
    concentration: HashSet<String>,
    failed_concentration: HashSet<String>,
    opportunity_attacks: HashMap<String, Value>,
    damage: HashMap<String, Value>,
    initiative: Vec<String>,
    active: Option<String>,
}

impl EventChecker {
    fn new(initial: &Value) -> Try<Self> {
        let actors = actors_of(initial);
        let speeds = actors.iter().map(|actor| (js::string(actor.get("id")), num(actor.get("speed")))).collect();
        let positions = actors.iter().map(|actor| (js::string(actor.get("id")), json!({ "x": actor.get("x"), "y": actor.get("y") }))).collect();
        let map = sk_tactical::tactical_map::deserialize_tactical_map(path(Some(initial), &["scene", "map"]).unwrap_or(&Value::Null)).map_err(|error| Thrown { message: error.message, code: Some(error.code) })?;
        Ok(Self {
            speeds,
            map,
            economies: HashMap::new(),
            positions,
            concentration: HashSet::new(),
            failed_concentration: HashSet::new(),
            opportunity_attacks: HashMap::new(),
            damage: HashMap::new(),
            initiative: Vec::new(),
            active: None,
        })
    }

    fn spend(&mut self, id: &str, kind: &str) -> Try {
        let mut budget = self.economies.get(id).cloned().unwrap_or_else(Budget::fresh);
        budget.bump(kind, 1.0);
        ensure(budget.get(kind) <= 1.0, || format!("{id}: повторно потрачено {kind} до следующего хода"))?;
        if kind != "reaction" {
            ensure(self.active.as_deref() == Some(id), || format!("{id}: действие вне своего хода"))?;
        }
        self.economies.insert(id.to_string(), budget);
        Ok(())
    }

    fn check(&mut self, events: &[Value]) -> Try {
        for event in events {
            let p = event.get("payload");
            let field = |key: &str| get(p, key);
            let id = js::string(event.get("actor_id"));
            let kind = js::s(event.get("event_type"));
            match kind.as_str() {
                "CombatStarted" => self.initiative = list(field("initiative")).iter().map(|entry| js::string(entry.get("actor_id"))).collect(),
                "TurnStarted" => {
                    let index = num(field("active_index"));
                    let active = (index >= 0.0 && index.fract() == 0.0).then(|| self.initiative.get(index as usize).cloned()).flatten().unwrap_or_else(|| "undefined".into());
                    self.economies.insert(active.clone(), Budget::fresh());
                    self.active = Some(active);
                }
                "AttackResolved" => {
                    if !js::truthy(field("reaction_attack")) {
                        self.spend(&id, "action")?;
                    } else {
                        ensure(loose_eq(self.opportunity_attacks.get(&id), field("target_id")), || "Атака реакцией не соответствует владельцу или цели реакции".into())?;
                        self.opportunity_attacks.remove(&id);
                    }
                    ensure(num(field("total")) == num(field("kept")) + num(field("modifier")), || "Неверная сумма броска атаки".into())?;
                    let kept = num(field("kept"));
                    let hit = kept == 20.0 || (kept != 1.0 && num(field("total")) >= num(field("armor_class")));
                    ensure(loose_eq(field("hit"), Some(&Value::Bool(hit))), || "Неверный результат атаки".into())?;
                }
                "SpellCast" => self.spend(&id, &js::string(field("action_type")))?,
                "ItemUsed" => self.spend(&id, &js::string(field("combat_action")))?,
                "CombatActionUsed" => {
                    let action_type = js::string(field("action_type"));
                    if ["action", "bonus_action", "reaction"].contains(&action_type.as_str()) {
                        self.spend(&id, &action_type)?;
                    }
                    let action_id = js::string(field("action_id"));
                    if action_id == "opportunity-attack" {
                        self.opportunity_attacks.insert(id.clone(), field("target_id").cloned().unwrap_or(Value::Null));
                    }
                    if action_id == "dash" {
                        let budget = self.economies.get_mut(&id).ok_or_else(|| Thrown::type_error("Cannot read properties of undefined (reading 'dashes')"))?;
                        budget.bump("dashes", 1.0);
                    }
                }
                "ActorMoved" => self.moved(&id, p)?,
                "ConcentrationStarted" => {
                    ensure(!self.concentration.contains(&id), || "Две концентрации одновременно".into())?;
                    self.concentration.insert(id);
                }
                "ConcentrationEnded" => {
                    self.concentration.remove(&id);
                    self.failed_concentration.remove(&id);
                }
                "DamageApplied" => {
                    let target = js::string(list(event.get("target_ids")).first());
                    self.damage.insert(target, field("applied_amount").cloned().unwrap_or(Value::Null));
                    let expected = 0f64.max(num(field("hp_before")) - num(field("applied_amount")));
                    ensure(num(field("hp_after")) == expected, || "ОЗ после урона не соответствуют событию".into())?;
                }
                "HealingApplied" => ensure(num(field("hp_after")) == num(field("hp_before")) + num(field("applied_amount")), || "ОЗ после лечения не соответствуют событию".into())?,
                "ConcentrationSavingThrowResolved" => {
                    ensure(self.concentration.contains(&id), || "Спасбросок без концентрации".into())?;
                    let damage = self.damage.get(&id).map_or(f64::NAN, |value| num(Some(value)));
                    let difficulty = if damage.is_nan() { f64::NAN } else { 10f64.max((damage / 2.0).floor()) };
                    ensure(num(field("difficulty")) == difficulty, || "Неверная СЛ концентрации".into())?;
                    let saved = num(field("total")) >= num(field("difficulty"));
                    ensure(loose_eq(field("saved"), Some(&Value::Bool(saved))), || "Неверный исход спасброска концентрации".into())?;
                    if !js::truthy(field("saved")) {
                        self.failed_concentration.insert(id);
                    }
                }
                "ResourceSpent" => ensure(num(field("after")) == num(field("before")) - num(field("amount")), || "Неверное списание ресурса".into())?,
                _ => {}
            }
        }
        ensure(self.failed_concentration.is_empty(), || "Провал спасброска не завершил концентрацию".into())?;
        ensure(self.opportunity_attacks.is_empty(), || "Потраченная реакция не разрешила атаку".into())
    }

    fn moved(&mut self, id: &str, p: Option<&Value>) -> Try {
        let from = get(p, "from").cloned().unwrap_or(Value::Null);
        ensure(self.positions.get(id).is_some_and(|position| deep_equal(&from, position)), || "Перемещение начинается не из текущей клетки".into())?;
        let route = list(get(p, "path"));
        let to = get(p, "to").cloned().unwrap_or(Value::Null);
        ensure(route.last().is_some_and(|last| deep_equal(last, &to)), || "Конец пути расходится с целью".into())?;
        let mut previous = coords(Some(&from))?;
        let mut cost = 0.0;
        for at in route {
            let here = coords(Some(at))?;
            ensure(distance(previous, here) == 5.0, || "Путь перескакивает клетку".into())?;
            let cell = (here.0.fract() == 0.0 && here.1.fract() == 0.0).then(|| sk_tactical::tactical_map::cell_at(&self.map, here.0 as i64, here.1 as i64)).flatten();
            ensure(cell.as_ref().is_some_and(|cell| cell.passable), || "Путь проходит сквозь стену".into())?;
            cost += if cell.is_some_and(|cell| cell.move_cost > 1) { 10.0 } else { 5.0 };
            previous = here;
        }
        ensure(num(get(p, "movement_cost")) == cost, || "Неверная стоимость пути по правилам 2014".into())?;
        if js::truthy(get(p, "spend_movement")) {
            let speed = self.speeds.get(id).copied().ok_or_else(|| Thrown::type_error("Cannot read properties of undefined (reading 'speed')"))?;
            let budget = self.economies.get_mut(id).ok_or_else(|| Thrown::type_error("Cannot read properties of undefined (reading 'movement')"))?;
            budget.bump("movement", cost);
            let (movement, dashes) = (budget.get("movement"), budget.get("dashes"));
            ensure(movement <= speed * (1.0 + dashes), || format!("{id}: превышена скорость"))?;
        }
        self.positions.insert(id.to_string(), to);
        Ok(())
    }
}

// --- кадры наблюдателя -------------------------------------------------------------

/// `frameCells(state)`.
fn frame_cells(state: &Value) -> Vec<Value> {
    let scene_cells = list(path(Some(state), &["scene", "cells"]));
    let map = path(Some(state), &["scene", "map"]).filter(|map| js::truthy(Some(map))).and_then(|map| sk_tactical::tactical_map::deserialize_tactical_map(map).ok());
    let legacy;
    let cells: &[Value] = if !scene_cells.is_empty() {
        scene_cells
    } else {
        legacy = map.as_ref().map(sk_tactical::tactical_map::legacy_cells_from_tactical_map).unwrap_or_default();
        &legacy
    };
    cells
        .iter()
        .map(|raw| {
            let (x, y) = (num(raw.get("x")), num(raw.get("y")));
            let cell = map.as_ref().filter(|_| x.fract() == 0.0 && y.fract() == 0.0).and_then(|map| sk_tactical::tactical_map::cell_at(map, x as i64, y as i64));
            let kind = match raw.get("type").filter(|kind| js::truthy(Some(kind))) {
                Some(kind) => js::s(Some(kind)),
                None if cell.as_ref().is_some_and(|cell| !cell.passable) => "wall".into(),
                None => "floor".into(),
            };
            let mut result = json!({ "x": js::num(x), "y": js::num(y), "type": kind });
            let move_cost = match raw.get("moveCost").filter(|cost| !cost.is_null()) {
                Some(cost) => num(Some(cost)),
                None => cell.as_ref().map_or(f64::NAN, |cell| f64::from(cell.move_cost)),
            };
            if js::truthy(raw.get("difficult")) || move_cost > 1.0 {
                set(&mut result, "difficult", Value::Bool(true));
            }
            result
        })
        .collect()
}

fn frame_actor_name(id: &str) -> Option<&'static str> {
    match id {
        "hero" => Some("Воин"),
        "ally" => Some("Союзник"),
        "enemy" => Some("Противник"),
        "enemy-2" => Some("Второй противник"),
        _ => None,
    }
}

/// `actorDisplayName(actor)`.
fn actor_display_name(actor: &Value) -> String {
    let id = js::s(actor.get("id"));
    let raw = [actor.get("name"), actor.get("character")].into_iter().find(|value| js::truthy(*value)).flatten();
    let name = sk_core::text::trim(&js::s(raw)).to_string();
    if !name.is_empty() && name != id {
        name
    } else {
        frame_actor_name(&id).map_or(id, str::to_string)
    }
}

fn spell_card(id: Option<&Value>) -> Option<Value> {
    sk_combat_content::combat_spells::canonical_combat_spell_for(id, None)
}

/// `a || b || …`: первое истинное, иначе последнее.
fn first_truthy<'a>(values: &[Option<&'a Value>]) -> Option<&'a Value> {
    values.iter().copied().find(|value| js::truthy(*value)).unwrap_or_else(|| values.last().copied().flatten())
}

/// `frameEventText(event, names)`.
fn frame_event_text(event: &Value, names: &HashMap<String, String>) -> String {
    let resolve = |id: Option<&Value>| -> Option<Value> { names.get(&js::string(id)).map(|name| Value::String(name.clone())).or_else(|| id.cloned()) };
    let summary = sk_rules::summary::event_summary(event, &resolve);
    let payload = event.get("payload").filter(|payload| !payload.is_null());
    let field = |key: &str| get(payload, key);
    let actor = || {
        let name = resolve(event.get("actor_id"));
        if js::truthy(name.as_ref()) {
            js::s(name.as_ref())
        } else {
            "Герой".to_string()
        }
    };
    match js::s(event.get("event_type")).as_str() {
        "SpellCast" => {
            let name = first_truthy(&[field("spell_name"), field("name"), field("spell_id")]).filter(|name| js::truthy(Some(name)));
            return format!("{} накладывает заклинание «{}»", actor(), name.map_or_else(|| "заклинание".to_string(), |name| js::s(Some(name))));
        }
        "ConcentrationStarted" => return format!("{} начинает концентрацию", actor()),
        "ConcentrationEnded" => return "Концентрация прекращена".into(),
        "ConcentrationCheckRequired" => return "Получен урон: требуется проверка концентрации".into(),
        "ReactionWindowOpened" => return "Открыта возможность реакции".into(),
        "ReactionWindowClosed" => return "Реакция разрешена; бой продолжается".into(),
        "ReactionDamageReduced" => return "Реакция уменьшила полученный урон".into(),
        "ConditionAdded" if js::s(field("condition")) == "shielded" => return "Действует заклинание «Щит»".into(),
        "ConditionAdded" if js::s(field("condition")) == "bless-d4" => return "Действует «Благословение»".into(),
        "ResourceSpent" if js::s(first_truthy(&[field("resource")])).starts_with("spell_slots_") => return format!("{} расходует ячейку заклинания", actor()),
        _ => {}
    }
    match field("spell_id").filter(|id| js::truthy(Some(id))) {
        Some(spell_id) => {
            let raw = js::string(Some(spell_id));
            let name = spell_card(Some(spell_id)).and_then(|card| card.get("name").filter(|name| !name.is_null()).map(|name| js::s(Some(name)))).unwrap_or_else(|| raw.clone());
            summary.replacen(&raw, &name, 1)
        }
        None => summary,
    }
}

/// `{ name, status }` строки арсенала (`name: undefined` в JSON не попадает).
fn arsenal_entry(name: Option<Value>, status: Value) -> Value {
    let mut map = Map::new();
    if let Some(name) = name {
        map.insert("name".into(), name);
    }
    map.insert("status".into(), status);
    Value::Object(map)
}

fn support_or_partial(value: Option<&Value>) -> Value {
    value.filter(|value| !value.is_null()).cloned().unwrap_or_else(|| json!("partial"))
}

/// `combatFrame(state, events, index)`.
fn combat_frame(state: &Value, events: &[Value], index: i64) -> Value {
    let players = list(state.get("players"));
    let enemies = list(state.get("enemies"));
    let all: Vec<(&Value, &str)> = players.iter().map(|actor| (actor, "party")).chain(enemies.iter().map(|actor| (actor, "enemy"))).collect();
    let names: HashMap<String, String> = all.iter().map(|(actor, _)| (js::string(actor.get("id")), actor_display_name(actor))).collect();
    let combat = path(Some(state), &["mechanics", "combat"]);
    let initiative = list(get(combat, "initiative"));
    let active_index = get(combat, "active_index").filter(|index| js::is_safe_integer(Some(index))).map_or(-1.0, |index| num(Some(index)));
    let active_actor = (active_index >= 0.0).then(|| initiative.get(active_index as usize)).flatten().and_then(|entry| entry.get("actor_id")).filter(|id| !id.is_null()).cloned().unwrap_or(Value::Null);
    let round = [get(combat, "round"), path(Some(state), &["scene", "turn"])].into_iter().flatten().find(|value| !value.is_null()).map_or(0.0, |value| num(Some(value)));
    let mechanics = state.get("mechanics");
    let actors: Vec<Value> = all
        .iter()
        .map(|(actor, side)| {
            let id = js::string(actor.get("id"));
            let (x, y) = match actor_position(state, &id) {
                Some(point) => (point.x as f64, point.y as f64),
                None => {
                    let pick = |key: &str| actor.get(key).filter(|value| !value.is_null()).map_or(0.0, |value| num(Some(value)));
                    (pick("x"), pick("y"))
                }
            };
            let hp = actor.get("hp").filter(|hp| !hp.is_null());
            let max_hp = actor.get("maxHp").filter(|hp| !hp.is_null()).or(hp);
            let mut entry = Map::new();
            entry.insert("id".into(), Value::String(id.clone()));
            entry.insert("name".into(), Value::String(actor_display_name(actor)));
            entry.insert("side".into(), json!(side));
            entry.insert("hp".into(), js::num(hp.map_or(0.0, |hp| num(Some(hp)))));
            entry.insert("maxHp".into(), js::num(max_hp.map_or(0.0, |hp| num(Some(hp)))));
            entry.insert("x".into(), js::num(x));
            entry.insert("y".into(), js::num(y));
            // `actor.image || actor.portrait`: `undefined` в JSON не попадает.
            let image = if js::truthy(actor.get("image")) { actor.get("image") } else { actor.get("portrait") };
            if let Some(image) = image {
                entry.insert("image".into(), image.clone());
            }
            let conditions: Vec<Value> = list(get(get(mechanics, "conditions"), &id)).iter().map(|condition| Value::String(js::string(Some(condition.get("id").filter(|v| !v.is_null()).unwrap_or(condition))))).collect();
            entry.insert("conditions".into(), Value::Array(conditions));
            entry.insert("resources".into(), get(get(mechanics, "resources"), &id).filter(|value| !value.is_null()).cloned().unwrap_or_else(js::obj));
            let mut arsenal = Vec::new();
            for spell in list(actor.get("combatSpells")).iter().filter(|spell| !js::is_false(spell.get("prepared"))) {
                arsenal.push(arsenal_entry(spell.get("name").cloned(), support_or_partial(spell.get("mechanicsSupport"))));
            }
            for action in list(actor.get("combatActions")).iter().filter(|action| action.get("category").and_then(Value::as_str) != Some("common")) {
                arsenal.push(arsenal_entry(action.get("name").cloned(), support_or_partial(action.get("mechanicsSupport"))));
            }
            for action in list(actor.get("action_profiles")) {
                arsenal.push(arsenal_entry(action.get("name").cloned(), json!("verified")));
            }
            for spell in list(path(Some(actor), &["spellcasting", "spells"])) {
                let spell_id = spell.get("spell_id").filter(|id| !id.is_null()).or_else(|| spell.get("id"));
                let card = spell_card(spell_id);
                let name = card.as_ref().and_then(|card| card.get("name")).filter(|name| !name.is_null()).or(spell_id).cloned();
                arsenal.push(arsenal_entry(name, support_or_partial(card.as_ref().and_then(|card| card.get("mechanicsSupport")))));
            }
            entry.insert("arsenal".into(), Value::Array(arsenal));
            Value::Object(entry)
        })
        .collect();
    let texts: Vec<Value> = events
        .iter()
        .enumerate()
        .map(|(event_index, event)| {
            let id = match event.get("event_id").filter(|id| js::truthy(Some(id))) {
                Some(id) => js::s(Some(id)),
                None => format!("{index}-{event_index}-{}", js::string(event.get("event_type"))),
            };
            let actor = event.get("actor_id").filter(|id| !id.is_null()).map_or(Value::Null, |id| Value::String(js::s(Some(id))));
            json!({ "id": id, "text": frame_event_text(event, &names), "actorId": actor })
        })
        .collect();
    let mut frame = Map::new();
    frame.insert("index".into(), json!(index));
    frame.insert("round".into(), js::num(round));
    frame.insert("activeActorId".into(), active_actor);
    frame.insert("actors".into(), Value::Array(actors));
    frame.insert("cells".into(), Value::Array(frame_cells(state)));
    if let Some(map) = path(Some(state), &["scene", "map"]) {
        frame.insert("map".into(), map.clone());
    }
    frame.insert("gameEvents".into(), Value::Array(events.to_vec()));
    frame.insert("events".into(), Value::Array(texts));
    Value::Object(frame)
}

// --- наблюдаемое хранилище ------------------------------------------------------------

/// `observedEventStore(eventStore, { onFrame, signal, takeTactic })`: после
/// каждого коммита — кадр наблюдателя; до и после — проверка отмены.
/// Отказ отмены или кадра уходит из коммита ошибкой хранилища, а исходное
/// исключение запоминается в `fault` и становится ошибкой прогона.
struct Observed<'a> {
    store: &'a EventStore,
    on_frame: RefCell<&'a mut dyn FnMut(Value) -> Result<(), CombatLabError>>,
    signal: &'a AbortSignal,
    frame_index: Cell<i64>,
    pending_tactic: RefCell<Option<(String, Option<Value>)>>,
    fault: RefCell<Option<Thrown>>,
}

impl Observed<'_> {
    fn fail(&self, thrown: Thrown) -> StoreError {
        let error = StoreError::new("COMBAT_LAB_OBSERVER", thrown.message.clone());
        *self.fault.borrow_mut() = Some(thrown);
        error
    }

    fn abort_if_requested(&self) -> StoreResult<()> {
        if self.signal.aborted() {
            return Err(self.fail(Thrown::abort()));
        }
        Ok(())
    }

    fn emit(&self, frame: Value) -> Result<(), Thrown> {
        let mut on_frame = self.on_frame.borrow_mut();
        (*on_frame)(frame).map_err(|error| Thrown { message: error.message, code: Some(error.code) })
    }

    fn notify(&self, state: &Value, events: &[Value]) -> StoreResult<()> {
        let index = self.frame_index.get() + 1;
        self.frame_index.set(index);
        let mut frame = combat_frame(state, events, index);
        if let Some((text, actor_id)) = self.pending_tactic.borrow_mut().take() {
            let mut entry = Map::new();
            entry.insert("id".into(), Value::String(format!("tactic-{index}")));
            if let Some(actor_id) = actor_id {
                entry.insert("actorId".into(), actor_id);
            }
            entry.insert("text".into(), Value::String(format!("Тактика: {text}")));
            if let Some(Value::Array(list)) = frame.get_mut("events") {
                list.insert(0, Value::Object(entry));
            }
        }
        self.emit(frame).map_err(|thrown| self.fail(thrown))
    }

    /// Исключение прогона: запомненное наблюдателем или своё.
    fn thrown(&self, fallback: Thrown) -> Thrown {
        self.fault.borrow_mut().take().unwrap_or(fallback)
    }
}

impl Journal for Observed<'_> {
    fn load(&self, campaign_id: &str) -> StoreResult<Loaded> {
        self.store.load(campaign_id, &LoadOptions::default())
    }

    fn commit(&self, request: CommitRequest) -> StoreResult<CommitResult> {
        self.abort_if_requested()?;
        let committed = self.store.commit(request)?;
        self.notify(&committed.state, &committed.events)?;
        self.abort_if_requested()?;
        Ok(committed)
    }

    fn get_by_idempotency_key(&self, campaign_id: &str, key: &str) -> StoreResult<Option<CommitResult>> {
        self.store.get_by_idempotency_key(campaign_id, key)
    }
}

impl NpcTurnJournal for Observed<'_> {
    fn events_between(&self, campaign_id: &str, after_version: i64, up_to_version: i64) -> Option<StoreResult<Vec<Value>>> {
        Some(self.store.get_events(campaign_id, after_version, Some(up_to_version)))
    }
}

// --- исполнение -------------------------------------------------------------------

struct ThreadWaker(std::thread::Thread);

impl Wake for ThreadWaker {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
}

/// Дождаться будущего на текущем потоке (планировщик без контроллера морали
/// не ждёт ничего внешнего).
pub(super) fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    let waker = Waker::from(Arc::new(ThreadWaker(std::thread::current())));
    let mut context = TaskContext::from_waker(&waker);
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
            return value;
        }
        std::thread::park();
    }
}

struct Run<'a> {
    request: &'a ScenarioRun,
    custom: bool,
    max_steps: i64,
    campaign_id: String,
    initial_state: &'a Value,
    store: &'a EventStore,
    observed: &'a Observed<'a>,
    engine: &'a RefCell<RulesEngine>,
    rolls: Rc<RefCell<Vec<Value>>>,
    checker: Option<RefCell<EventChecker>>,
    steps: Vec<Map<String, Value>>,
    passed: bool,
    final_state: Option<Value>,
}

impl Run<'_> {
    fn abort_if_requested(&self) -> Try {
        if self.observed.signal.aborted() {
            return Err(Thrown::abort());
        }
        Ok(())
    }

    fn load(&self) -> Try<Value> {
        self.store.load(&self.campaign_id, &LoadOptions::default()).map(|loaded| std::sync::Arc::unwrap_or_clone(loaded.state)).map_err(|error| Thrown::store(&error))
    }

    fn rolls_len(&self) -> usize {
        self.rolls.borrow().len()
    }

    fn check_events(&self, events: &[Value]) -> Try {
        match &self.checker {
            Some(checker) => checker.borrow_mut().check(events),
            None => Ok(()),
        }
    }

    fn execute(&self, key: &str, command: &Value, context: &Value) -> Result<sk_store::executor::Executed, Thrown> {
        execute_plan(self.observed, self.engine as &dyn NpcRulesEngine, &self.campaign_id, key, std::slice::from_ref(command), context, 3).map_err(|error| self.observed.thrown(Thrown::scheduler(&error)))
    }

    fn body(&mut self) -> Try {
        self.abort_if_requested()?;
        self.store.initialize_campaign(InitializeRequest::new(self.campaign_id.clone(), self.initial_state.clone())).map_err(|error| Thrown::store(&error))?;
        self.observed.emit(combat_frame(self.initial_state, &[], 0))?;
        self.abort_if_requested()?;
        let first = list(self.initial_state.get("players")).first().ok_or_else(|| Thrown::type_error("Cannot read properties of undefined (reading 'id')"))?;
        let mut command = json!({ "command_type": "StartCombat", "actor_id": first.get("id") });
        let mut tactic: Option<String> = None;
        for step in 0..self.max_steps {
            self.abort_if_requested()?;
            let before = self.load()?;
            let key = format!("lab-{step}");
            let mut entry = Map::new();
            entry.insert("step".into(), json!(step));
            entry.insert("command".into(), command.clone());
            entry.insert("before_version".into(), before.get("state_version").cloned().unwrap_or(Value::Null));
            if let Some(tactic) = tactic.as_ref().filter(|tactic| !tactic.is_empty()) {
                entry.insert("tactic".into(), Value::String(tactic.clone()));
            }
            self.steps.push(entry);
            let actor = command.get("actor_id").cloned();
            *self.observed.pending_tactic.borrow_mut() = tactic.clone().filter(|tactic| !tactic.is_empty()).map(|tactic| (tactic, actor.clone()));
            let planned = js::spread(&command, json!({ "command_id": format!("lab-command-{step}"), "server_authoritative": true }));
            let actor_list = json!([actor.clone().unwrap_or(Value::Null)]);
            let context = json!({ "serverAuthoritativeCombat": true, "allowedActorIds": actor_list, "actor_ids": actor_list });
            let committed = self.execute(&key, &planned, &context)?;
            self.check_events(&committed.commit.events)?;
            let roll_count = self.rolls_len();
            let duplicate = self.execute(&key, &planned, &context)?;
            ensure(duplicate.replayed, || "Повтор команды создал новый коммит".into())?;
            ensure(self.rolls_len() == roll_count, || "Повтор команды сделал новые броски".into())?;
            ensure(deep_equal(&Value::Array(duplicate.commit.events.clone()), &Value::Array(committed.commit.events.clone())), || "Expected values to be loosely deep-equal".into())?;
            // Повтор уже перечитал журнал, включая его текущую версию.
            ensure(duplicate.commit.current_state_version == committed.commit.state_version, || format!("{} == {}", duplicate.commit.current_state_version, committed.commit.state_version))?;
            ensure(deep_equal(&duplicate.commit.state, &committed.commit.state), || "Повтор команды изменил подтверждённое состояние".into())?;
            let after_player = duplicate.commit.state;
            assert_state(&after_player)?;
            let command_type = js::s(command.get("command_type"));
            if !self.custom && command_type == "MakeAttack" && !js::truthy(path(Some(&after_player), &["mechanics", "combat", "reaction_window"])) {
                let target = command.get("target_id");
                let alive = list(after_player.get("enemies")).iter().any(|actor| loose_eq(actor.get("id"), target) && actor.get("id").is_some() && num(actor.get("hp")) > 0.0 && !js::is_false(actor.get("alive")));
                if alive {
                    // Новый ключ не превращает вторую атаку в разрешённую: у
                    // героев арен нет Extra Attack и Action Surge.
                    let probe_key = format!("{key}-extra-attack");
                    let probe = js::spread(&planned, json!({ "command_id": probe_key }));
                    match execute_plan(self.observed, self.engine as &dyn NpcRulesEngine, &self.campaign_id, &probe_key, std::slice::from_ref(&probe), &context, 3) {
                        Ok(_) => return Err(Thrown::assertion("Missing expected rejection.")),
                        Err(error) if error.code() == Some("ACTION_SPENT") => {}
                        Err(error) => {
                            let thrown = self.observed.thrown(Thrown::scheduler(&error));
                            return Err(Thrown::assertion(format!("The \"validate\" validation function is expected to return \"true\". Received false\n\nCaught error:\n\n{}", thrown.message)));
                        }
                    }
                    ensure(deep_equal(&self.load()?, &after_player), || "Отказ второй атаке изменил состояние".into())?;
                    ensure(self.rolls_len() == roll_count, || "Отказ второй атаке сделал новый бросок".into())?;
                }
            }
            let advance_npc = command_type == "StartCombat" || command_type == "EndTurn" || js::truthy(path(Some(&before), &["mechanics", "combat", "reaction_window"]));
            let options = SchedulerOptions { campaign_id: &self.campaign_id, journal: self.observed, rules_engine: self.engine, npc_controller: None, advance_npc, max_turns: 160 };
            let settled = block_on(run_npc_turn_scheduler(options)).map_err(|error| self.observed.thrown(Thrown::scheduler(&error)))?;
            self.check_events(&settled.events)?;
            let state = settled.state;
            assert_state(&state)?;
            if let Some(entry) = self.steps.last_mut() {
                entry.insert("after_version".into(), state.get("state_version").cloned().unwrap_or(Value::Null));
            }
            // Сверка воспроизведения — после каждого шага, включая ходы NPC.
            let replayed = self.store.load(&self.campaign_id, &LoadOptions { use_snapshots: Some(false), ..LoadOptions::default() }).map_err(|error| Thrown::store(&error))?;
            ensure(deep_equal(&replayed.state, &state), || "Replay расходится с текущим состоянием".into())?;
            let combat = path(Some(&state), &["mechanics", "combat"]);
            if !js::truthy(get(combat, "active")) {
                let mut events = committed.commit.events.clone();
                events.extend(settled.events.iter().cloned());
                self.finish(&state, &events)?;
                self.passed = true;
                self.final_state = Some(std::sync::Arc::unwrap_or_clone(state));
                break;
            }
            let actor_id = get(get(combat, "reaction_window"), "actor_id").filter(|id| !id.is_null()).cloned().or_else(|| {
                let index = num(get(combat, "active_index"));
                (index >= 0.0 && index.fract() == 0.0).then(|| list(get(combat, "initiative")).get(index as usize)).flatten().and_then(|entry| entry.get("actor_id")).cloned()
            });
            let actor_id_text = js::string(actor_id.as_ref());
            ensure(list(state.get("players")).iter().any(|actor| actor_id.is_some() && loose_eq(actor.get("id"), actor_id.as_ref())), || "Планировщик не вернул управление игроку".into())?;
            let user = json!({ "id": format!("user-{actor_id_text}"), "role": "player", "heroIds": [actor_id] });
            let view = sk_projection::viewer_projection::campaign_state_for_viewer(Some(&state), Some(&user), actor_id.as_ref())
                .map_err(|error| Thrown { message: error.message, code: error.code })?
                .unwrap_or(Value::Null);
            for enemy in list(view.get("enemies")) {
                ensure(enemy.get("hp").is_none_or(Value::is_null), || "Проекция раскрывает точные ОЗ противника".into())?;
            }
            if self.request.choose_command.is_some() {
                let plan = sk_tactics::party_tactics::plan_hero_combat_command(&view, &actor_id_text).map_err(|halt| Thrown::halt(&halt))?;
                command = plan.command;
                tactic = Some(plan.reason);
            } else {
                command = choose_lab_command(&view, &actor_id_text, &self.steps, &self.request.scenario)?;
            }
        }
        ensure(self.passed, || format!("Бой не завершён за {} шагов", self.max_steps))
    }

    /// Проверки завершённого боя.
    fn finish(&self, state: &Value, events: &[Value]) -> Try {
        let mechanics = state.get("mechanics");
        let incapacitated = |actor: &Value| {
            let id = js::string(actor.get("id"));
            num(actor.get("hp")) <= 0.0
                || js::is_false(actor.get("alive"))
                || path(mechanics, &["resting", &id, "reason"]).and_then(Value::as_str) == Some("knockout")
                || list(get(get(mechanics, "conditions"), &id)).iter().any(|condition| js::string(Some(condition.get("id").filter(|v| !v.is_null()).unwrap_or(condition))) == "unconscious")
        };
        ensure(path(mechanics, &["combat", "reaction_window"]).is_none_or(Value::is_null), || "Бой завершился с открытой реакцией".into())?;
        for hero in list(state.get("players")) {
            let id = js::string(hero.get("id"));
            let dead = path(mechanics, &["death", "heroes", &id, "status"]).and_then(Value::as_str) == Some("dead");
            if num(hero.get("hp")) == 0.0 && matches!(hero.get("hp"), Some(Value::Number(_))) && !dead {
                ensure(loose_eq(path(mechanics, &["death", "saving_throws", &id, "stable"]), Some(&Value::Bool(true))), || "Бой завершился до спасбросков от смерти".into())?;
            }
        }
        let enemies_down = list(state.get("enemies")).iter().all(incapacitated);
        let party_down = list(state.get("players")).iter().all(incapacitated);
        ensure(enemies_down || party_down, || "Бой завершился при двух боеспособных сторонах".into())?;
        let ended = events.iter().rev().find(|event| event.get("event_type").and_then(Value::as_str) == Some("CombatEnded"));
        let Some(ended) = ended else { return Err(Thrown::assertion("Нет события завершения боя")) };
        let reason = path(Some(ended), &["payload", "reason"]).and_then(Value::as_str).unwrap_or("");
        if reason == "enemies_defeated" {
            ensure(enemies_down, || "Объявлена победа над боеспособным противником".into())
        } else {
            ensure(["party_defeated", "party_incapacitated"].contains(&reason), || "Неожиданная причина завершения арены".into())?;
            ensure(party_down, || "Объявлено поражение боеспособного отряда".into())
        }
    }
}

/// `runCombatScenario({ scenario, seed, maxSteps, onFrame, signal, initialState, chooseCommand })`.
fn run_combat_scenario(request: ScenarioRun, on_frame: &mut dyn FnMut(Value) -> Result<(), CombatLabError>, signal: &AbortSignal) -> Result<Value, RunFailure> {
    let scenario = request.scenario.clone();
    let custom = request.initial_state.is_some();
    let known = COMBAT_SCENARIOS.contains(&scenario.as_str()) || (scenario == "custom" && custom && request.choose_command.is_some());
    if !known {
        return Err(Thrown::assertion(format!("Неизвестный сценарий: {scenario}")).into());
    }
    let seed = request.seed.as_f64().filter(|seed| js::is_safe_integer(Some(&request.seed)) && (0.0..=4_294_967_295.0).contains(seed));
    let Some(seed) = seed else { return Err(Thrown::assertion("seed: целое число 0..4294967295").into()) };
    let max_steps = request.max_steps.unwrap_or(160);
    if !(1..=1000).contains(&max_steps) {
        return Err(Thrown::assertion("maxSteps: целое число 1..1000").into());
    }
    let store = store().map_err(|error| RunFailure::from(Thrown::store(&error)))?;
    let rolls = Rc::new(RefCell::new(Vec::new()));
    let engine = engine(seed as u32, Rc::clone(&rolls));
    let initial_state = match &request.initial_state {
        Some(state) => sk_rules::normalize::normalize_campaign_state(state).map_err(|halt| RunFailure::from(Thrown::halt(&halt)))?,
        None => fixture(&scenario).map_err(RunFailure::from)?,
    };
    // Счётчик малых арен не годится для Extra Attack, легендарных действий и
    // произвольных эффектов; общие проверки состояния и replay остаются.
    let checker = if custom { None } else { Some(RefCell::new(EventChecker::new(&initial_state).map_err(RunFailure::from)?)) };
    let campaign_id = js::s(initial_state.get("sessionCode"));
    let observed = Observed { store: &store, on_frame: RefCell::new(on_frame), signal, frame_index: Cell::new(0), pending_tactic: RefCell::new(None), fault: RefCell::new(None) };
    let mut run = Run {
        request: &request,
        custom,
        max_steps,
        campaign_id,
        initial_state: &initial_state,
        store: &store,
        observed: &observed,
        engine: &engine,
        rolls: Rc::clone(&rolls),
        checker,
        steps: Vec::new(),
        passed: false,
        final_state: None,
    };
    let outcome = run.body();
    let mut report = Map::new();
    report.insert("schema".into(), json!("combat-lab/v1"));
    report.insert("rng".into(), json!("lcg32-1664525-1013904223/v1"));
    report.insert("scenario".into(), Value::String(scenario));
    report.insert("seed".into(), request.seed.clone());
    report.insert("initial_state".into(), initial_state.clone());
    report.insert("steps".into(), Value::Array(run.steps.iter().cloned().map(Value::Object).collect()));
    report.insert("rolls".into(), Value::Array(rolls.borrow().clone()));
    report.insert("passed".into(), Value::Bool(run.passed));
    if let Err(thrown) = outcome {
        report.insert("error".into(), thrown.to_json());
    }
    let final_state = run.final_state.take().or_else(|| store.load(&run.campaign_id, &LoadOptions::default()).ok().map(|loaded| std::sync::Arc::unwrap_or_clone(loaded.state)));
    if let Some(final_state) = final_state {
        report.insert("final_state".into(), final_state);
    }
    Ok(Value::Object(report))
}

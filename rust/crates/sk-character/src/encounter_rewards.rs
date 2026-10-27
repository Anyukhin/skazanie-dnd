//! Перенос `server/encounter-rewards.mjs`: награда за выигранную встречу.
//!
//! Цепочка стадий: замороженный план исхода (`freeze_encounter_outcome_plan`
//! — опыт только из серверного стат-блока), монеты (по 1к6 на врага через
//! внедрённый [`Dice`]), добыча (таблицы `loot-tables`), дележ между живыми
//! участниками отряда (опыт поровну, монеты поровну, вещи по кругу с учётом
//! грузоподъёмности) и чистое применение записанного дележа к героям.
//!
//! Входы и выходы — `serde_json::Value` той же формы, что в JS.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_combat_base::dndsu_2014_content::default_dndsu_2014_content;
use sk_core::{hash, js, text};
use sk_dice::{Dice, DiceError, Visibility};
use sk_economy::merchant_economy::{copper_to_currency, currency_to_copper, MAX_CURRENCY_CP};
use sk_encounters::encounter_assembler::{ENCOUNTER_ASSEMBLER_LIMITS, SRD_5_2_1_MONSTER_ALLOWLIST};
use sk_items::item_catalog::{catalog_item, materialize_catalog_item};
use sk_items::loot_tables::{server_encounter_loot, server_encounter_magic_loot};
use sk_items_life::item_lifecycle::{carrying_capacity, inventory_weight, ItemLifecycleError};
use sk_npc_world::npc_positioning::npc_mechanics_for;

pub use sk_items::loot_tables::ENCOUNTER_LOOT_POLICY_ID;

pub const ENCOUNTER_OUTCOME_PLAN_VERSION: &str = "skazanie:encounter-outcome-plan:v1";
pub const ENCOUNTER_REWARD_POLICY_ID: &str = "skazanie:encounter-rewards:v2";
pub const ENCOUNTER_COINS_POLICY_ID: &str = "skazanie:encounter-coins:v1";
pub const ENCOUNTER_DISTRIBUTION_POLICY_ID: &str = "skazanie:encounter-distribution:v1";
pub const ENCOUNTER_REWARDS_DISTRIBUTED_EVENT_SCHEMA_VERSION: i64 = 1;
pub const SERVER_LOOT_GENERATED_EVENT_SCHEMA_VERSION: i64 = 2;
pub const MAX_ENCOUNTER_COINS_CP: i64 = 288_000;
pub const MAX_HERO_REWARD_INVENTORY_ITEMS: usize = 200;

const DIFFICULTIES: [&str; 4] = ["easy", "medium", "hard", "deadly"];
const THEMES: [&str; 11] = ["goblinoids", "undead", "beasts", "raiders", "warband", "vermin", "ambush", "crypt", "cave", "wilderness", "generic"];
const STAGES: [&str; 6] = ["outcome", "xp", "coins", "loot", "distribution", "transition"];
/// Редакции с каталогом наград, в порядке объекта JS.
const KNOWN_REWARD_RULESETS: [&str; 2] = ["srd_5_2_1", "dnd_5e_2014"];
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// Опыт монстров 2014 из справочника dnd.su: `{ xp: Number(monster.xp) }`.
static DND_2014_XP: LazyLock<HashMap<String, f64>> = LazyLock::new(|| {
    let mut catalog = HashMap::new();
    if let Ok(content) = default_dndsu_2014_content() {
        for monster in content.get("monsters").and_then(Value::as_array).into_iter().flatten() {
            catalog.insert(js::string(monster.get("id")), js::number(monster.get("xp")));
        }
    }
    catalog
});

// ---------------------------------------------------------------------------
// Ошибки
// ---------------------------------------------------------------------------

/// Исключение модуля: `EncounterRewardValidationError` (код и текст),
/// `TypeError` JS или отказ сервиса костей.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncounterRewardError {
    pub name: &'static str,
    pub code: Option<String>,
    pub message: String,
}

pub const VALIDATION_ERROR: &str = "EncounterRewardValidationError";

impl EncounterRewardError {
    fn reject(message: impl Into<String>, code: &str) -> Self {
        Self { name: VALIDATION_ERROR, code: Some(code.into()), message: message.into() }
    }

    fn type_error(message: impl Into<String>) -> Self {
        Self { name: "TypeError", code: None, message: message.into() }
    }

    pub fn code(&self) -> Option<&str> {
        self.code.as_deref()
    }

    pub fn is_validation(&self) -> bool {
        self.name == VALIDATION_ERROR
    }
}

impl std::fmt::Display for EncounterRewardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for EncounterRewardError {}

impl From<ItemLifecycleError> for EncounterRewardError {
    fn from(error: ItemLifecycleError) -> Self {
        match error {
            ItemLifecycleError::Validation { message, code } => Self { name: "ItemLifecycleValidationError", code: Some(code), message },
            ItemLifecycleError::Type(message) => Self::type_error(message),
        }
    }
}

impl From<DiceError> for EncounterRewardError {
    fn from(error: DiceError) -> Self {
        let name = match error {
            DiceError::Expression(_) => "DiceExpressionError",
            DiceError::Range(_) => "RangeError",
            DiceError::Transcript(_) => "DiceTranscriptError",
        };
        Self { name, code: None, message: error.to_string() }
    }
}

pub type RewardResult<T> = Result<T, EncounterRewardError>;

fn reject<T>(message: impl Into<String>, code: &str) -> RewardResult<T> {
    Err(EncounterRewardError::reject(message, code))
}

// ---------------------------------------------------------------------------
// Приведения JS
// ---------------------------------------------------------------------------

fn prop<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match value {
        Some(Value::Object(map)) => map.get(key),
        _ => None,
    }
}

fn nullish<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    if js::present(a) {
        a
    } else {
        b
    }
}

fn is_str(value: Option<&Value>, expected: &str) -> bool {
    value.and_then(Value::as_str) == Some(expected)
}

/// `text.slice(0, limit)` по кодовым единицам UTF-16.
fn utf16_head(text: &str, limit: usize) -> String {
    let mut units = 0;
    let mut result = String::new();
    for ch in text.chars() {
        units += ch.len_utf16();
        if units > limit {
            break;
        }
        result.push(ch);
    }
    result
}

/// `cleanId(value)`: `String(value ?? '').trim().slice(0, 160)`.
fn clean_id(value: Option<&Value>) -> String {
    utf16_head(text::trim(&js::s(value)), 160)
}

/// `actorId(actor)`: `String(actor?.id ?? actor?.actor_id ?? '')`.
fn actor_id(actor: Option<&Value>) -> String {
    js::s(nullish(prop(actor, "id"), prop(actor, "actor_id")))
}

fn actor_is_defeated(actor: Option<&Value>) -> bool {
    if js::is_false(prop(actor, "alive")) {
        return true;
    }
    let raw = nullish(prop(actor, "hp"), prop(actor, "hit_points"));
    if !js::present(raw) {
        return false;
    }
    let hp = js::number(raw);
    hp.is_finite() && hp <= 0.0
}

/// `digest(value)`: SHA-256 строки `String(value)`.
fn digest(text: &str) -> String {
    hash::sha256_hex(text.as_bytes())
}

/// `(list ?? []).map(...)`: массив или `TypeError` (у строки и объекта нет `.map`).
fn list<'a>(value: Option<&'a Value>, what: &str) -> RewardResult<&'a [Value]> {
    match value {
        None | Some(Value::Null) => Ok(&[]),
        Some(Value::Array(items)) => Ok(items),
        Some(_) => Err(EncounterRewardError::type_error(format!("{what}.map is not a function"))),
    }
}

fn array_of(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

fn is_safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= MAX_SAFE
}

/// `Number(x) || 0`.
fn number_or_zero(value: Option<&Value>) -> f64 {
    let number = js::number(value);
    if number.is_nan() {
        0.0
    } else {
        number
    }
}

/// `Math.max(a, b)` с `NaN`.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// `Math.max(1, Number(quantity) || 1)`.
fn units_of(item: Option<&Value>) -> f64 {
    let quantity = js::number(prop(item, "quantity"));
    js_max(1.0, if quantity.is_nan() || quantity == 0.0 { 1.0 } else { quantity })
}

/// Вес стопки: `Math.max(0, Number(weight) || 0) * Math.max(1, Number(quantity) || 1)`.
fn stack_weight(item: Option<&Value>) -> f64 {
    js_max(0.0, number_or_zero(prop(item, "weight"))) * units_of(item)
}

fn players_of(state: &Value) -> RewardResult<&[Value]> {
    list(state.get("players"), "state.players")
}

fn non_null_state(state: &Value) -> RewardResult<&Value> {
    if state.is_null() {
        return Err(EncounterRewardError::type_error("Cannot read properties of null"));
    }
    Ok(state)
}

// ---------------------------------------------------------------------------
// Стадии и получатели
// ---------------------------------------------------------------------------

/// `encounterCompletionStageKey(encounterId, stage)`.
pub fn encounter_completion_stage_key(encounter_id: Option<&Value>, stage: Option<&Value>) -> RewardResult<String> {
    let id = clean_id(encounter_id);
    if id.is_empty() {
        return reject("У награды нет encounter_id", "ENCOUNTER_ID_REQUIRED");
    }
    let Some(stage) = stage.and_then(Value::as_str).filter(|stage| STAGES.contains(stage)) else {
        return reject("Неизвестная стадия награды", "ENCOUNTER_REWARD_STAGE_INVALID");
    };
    Ok(format!("encounter-completion:{id}:{stage}"))
}

/// `livingEncounterRewardRecipients(state)`: участники отряда в порядке
/// `partyMemberIds`, у которых есть герой и которые не мертвы.
pub fn living_encounter_reward_recipients(state: &Value) -> RewardResult<Vec<String>> {
    let state = non_null_state(state)?;
    let players: HashSet<String> = players_of(state)?.iter().map(|player| actor_id(Some(player))).filter(|id| !id.is_empty()).collect();
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for member in list(state.get("partyMemberIds"), "state.partyMemberIds")? {
        let id = js::string(Some(member));
        if id.is_empty() || seen.contains(&id) || !players.contains(&id) {
            continue;
        }
        seen.insert(id.clone());
        let status = state.get("mechanics").and_then(|mechanics| prop(Some(mechanics), "death")).and_then(|death| prop(Some(death), "heroes")).and_then(|heroes| prop(Some(heroes), &id)).and_then(|hero| prop(Some(hero), "status"));
        if !is_str(status, "dead") {
            result.push(id);
        }
    }
    Ok(result)
}

fn encounter_descriptor_map(encounter: &Value) -> RewardResult<HashMap<String, &Value>> {
    let mut result = HashMap::new();
    for descriptor in array_of(encounter.get("enemies")) {
        let id = actor_id(Some(descriptor));
        if id.is_empty() || result.contains_key(&id) {
            return reject("Encounter содержит повторяющееся описание врага", "ENCOUNTER_ENEMY_DUPLICATE");
        }
        result.insert(id, descriptor);
    }
    Ok(result)
}

/// Запись каталога наград: `Some(xp)` — найдена.
fn reward_catalog_entry_for(state: &Value, stat_block_id: &str) -> RewardResult<Option<f64>> {
    let mut ruleset_id = clean_id(nullish(state.get("ruleset_id"), state.get("rulesetId")));
    if ruleset_id.is_empty() {
        ruleset_id = "srd_5_2_1".into();
    }
    let prefix = stat_block_id.split(':').next().unwrap_or("");
    if KNOWN_REWARD_RULESETS.contains(&prefix) && prefix != ruleset_id {
        return reject(format!("Stat block {stat_block_id} относится к другой редакции"), "ENCOUNTER_RULESET_MISMATCH");
    }
    match ruleset_id.as_str() {
        // `Number(block?.xp ?? authored?.xp)`: у найденного блока `authored`
        // нет, и пустой `xp` даёт `Number(undefined)`.
        "srd_5_2_1" => Ok(SRD_5_2_1_MONSTER_ALLOWLIST.get(stat_block_id).map(|block| if js::present(block.get("xp")) { js::number(block.get("xp")) } else { f64::NAN })),
        "dnd_5e_2014" => Ok(DND_2014_XP.get(stat_block_id).copied()),
        _ => Ok(None),
    }
}

fn plan_head(encounter: &Value, encounter_id: &str, outcome: &str, eligible: bool) -> Map<String, Value> {
    let difficulty = encounter.get("difficulty").and_then(Value::as_str).filter(|value| DIFFICULTIES.contains(value)).unwrap_or("medium");
    let theme = encounter.get("theme").and_then(Value::as_str).filter(|value| THEMES.contains(value)).unwrap_or("generic");
    let mut plan = Map::new();
    plan.insert("version".into(), json!(ENCOUNTER_OUTCOME_PLAN_VERSION));
    plan.insert("policy".into(), json!(ENCOUNTER_REWARD_POLICY_ID));
    plan.insert("encounter_id".into(), json!(encounter_id));
    plan.insert("outcome".into(), json!(outcome));
    plan.insert("rewards_eligible".into(), json!(eligible));
    plan.insert("difficulty".into(), json!(difficulty));
    plan.insert("theme".into(), json!(theme));
    plan
}

/// `freezeEncounterOutcomePlan(state, requestedOutcome)`: проверенный и
/// замороженный исход встречи до первого броска монет. Опыт — только из
/// серверного стат-блока.
pub fn freeze_encounter_outcome_plan(state: &Value, requested_outcome: Option<&Value>) -> RewardResult<Value> {
    let state = non_null_state(state)?;
    let encounter = state.get("mechanics").and_then(|mechanics| prop(Some(mechanics), "encounter"));
    let encounter = match encounter {
        Some(value @ (Value::Object(_) | Value::Array(_))) => value,
        _ => return reject("В состоянии нет встречи", "ENCOUNTER_NOT_FOUND"),
    };
    let field = |key: &str| prop(Some(encounter), key);
    let encounter_id = clean_id(nullish(field("id"), field("encounter_id")));
    if encounter_id.is_empty() {
        return reject("Встреча не имеет идентификатора", "ENCOUNTER_ID_REQUIRED");
    }
    if js::s(field("status")) != "ended" {
        return reject("Встреча ещё не завершена", "ENCOUNTER_NOT_ENDED");
    }
    let stored_outcome = text::trim(&js::s(field("outcome"))).to_string();
    let stored_value = Value::String(stored_outcome.clone());
    let outcome = text::trim(&js::s(nullish(requested_outcome, Some(&stored_value)))).to_string();
    if outcome.is_empty() || stored_outcome != outcome {
        return reject("Исход не совпадает с завершённой встречей", "ENCOUNTER_OUTCOME_MISMATCH");
    }
    if outcome != "enemies_defeated" && outcome != "fled" {
        let mut plan = plan_head(encounter, &encounter_id, &outcome, false);
        plan.insert("enemies".into(), json!([]));
        plan.insert("total_xp".into(), json!(0));
        plan.insert("recipients".into(), json!(living_encounter_reward_recipients(state)?));
        return Ok(Value::Object(plan));
    }
    let enemy_ids = match field("enemy_ids") {
        Some(Value::Array(items)) if !items.is_empty() && items.len() <= ENCOUNTER_ASSEMBLER_LIMITS.maximum_creatures => items,
        _ => return reject("Список врагов встречи вне разрешённых границ", "ENCOUNTER_ENEMY_COUNT_INVALID"),
    };
    let normalized: Vec<String> = enemy_ids.iter().map(|id| clean_id(Some(id))).collect();
    if normalized.iter().any(String::is_empty) || normalized.iter().collect::<HashSet<_>>().len() != normalized.len() {
        return reject("Список врагов встречи должен содержать уникальные ID", "ENCOUNTER_ENEMY_DUPLICATE");
    }
    let descriptors = encounter_descriptor_map(encounter)?;
    if descriptors.len() != normalized.len() || normalized.iter().any(|id| !descriptors.contains_key(id)) {
        return reject("Список врагов не совпадает с замороженным составом встречи", "ENCOUNTER_ENEMY_FOREIGN");
    }
    let mut actors: HashMap<String, &Value> = HashMap::new();
    for enemy in list(state.get("enemies"), "state.enemies")? {
        actors.insert(actor_id(Some(enemy)), enemy);
    }
    let mut enemies = Vec::new();
    let mut total_xp = 0.0;
    for enemy_id in &normalized {
        let (Some(enemy), Some(descriptor)) = (actors.get(enemy_id).copied(), descriptors.get(enemy_id).copied()) else {
            return reject(format!("Враг {enemy_id} не найден"), "ENCOUNTER_ENEMY_UNKNOWN");
        };
        if !actor_is_defeated(Some(enemy)) {
            return reject(format!("Враг {enemy_id} ещё жив"), "ENCOUNTER_ENEMY_LIVING");
        }
        let stat_block_id = clean_id(prop(Some(enemy), "stat_block_id"));
        if stat_block_id.is_empty() || stat_block_id != clean_id(prop(Some(descriptor), "stat_block_id")) {
            return reject(format!("Враг {enemy_id} не принадлежит замороженному stat block"), "ENCOUNTER_ENEMY_FOREIGN");
        }
        let block = reward_catalog_entry_for(state, &stat_block_id)?;
        let known_catalog_id = KNOWN_REWARD_RULESETS.iter().any(|ruleset| stat_block_id.starts_with(&format!("{ruleset}:")));
        let authored = if block.is_some() || known_catalog_id {
            None
        } else {
            let npc_id = prop(prop(Some(enemy), "origin"), "npc_id").cloned().unwrap_or(Value::Null);
            npc_mechanics_for(state, &npc_id).filter(|value| !value.is_null())
        };
        if block.is_none() && !authored.as_ref().is_some_and(|authored| is_str(authored.get("profile_id"), &stat_block_id)) {
            return reject(format!("Stat block {stat_block_id} не входит в allowlist"), "ENCOUNTER_STAT_BLOCK_UNKNOWN");
        }
        let xp = match block {
            Some(xp) => xp,
            None => js::number(authored.as_ref().and_then(|authored| authored.get("xp"))),
        };
        if !is_safe_integer(xp) || !(0.0..=100_000.0).contains(&xp) {
            return reject(format!("Stat block {stat_block_id} содержит некорректный XP"), "ENCOUNTER_STAT_BLOCK_XP_INVALID");
        }
        let provenance = prop(Some(enemy), "provenance");
        if js::truthy(provenance) && prop(provenance, "xp").is_some() && js::number(prop(provenance, "xp")) != xp {
            return reject(format!("Сохранённый XP врага {enemy_id} расходится с stat block"), "ENCOUNTER_ENEMY_XP_MISMATCH");
        }
        total_xp += xp;
        enemies.push(json!({ "enemy_id": enemy_id, "stat_block_id": stat_block_id, "xp": js::num(xp) }));
    }
    let mut plan = plan_head(encounter, &encounter_id, &outcome, true);
    plan.insert("enemies".into(), Value::Array(enemies));
    plan.insert("total_xp".into(), js::num(total_xp));
    plan.insert("recipients".into(), json!(living_encounter_reward_recipients(state)?));
    Ok(Value::Object(plan))
}

/// `frozenEncounterOutcomePlanFromEvent(event)`.
pub fn frozen_encounter_outcome_plan_from_event(event: Option<&Value>) -> RewardResult<Value> {
    let plan = prop(prop(event, "payload"), "plan");
    match plan {
        Some(plan) if js::truthy(Some(plan)) && is_str(prop(Some(plan), "version"), ENCOUNTER_OUTCOME_PLAN_VERSION) => Ok(plan.clone()),
        _ => reject("Outcome event не содержит поддерживаемый frozen plan", "ENCOUNTER_OUTCOME_PLAN_UNSUPPORTED"),
    }
}

/// `encounterCoinUnitsForXp(value)`: единицы монет за опыт врага (по 25 XP).
pub fn encounter_coin_units_for_xp(value: Option<&Value>) -> i64 {
    let numeric = js::number(value);
    let bounded = if numeric.is_finite() {
        numeric.trunc().clamp(0.0, 100_000.0)
    } else if numeric > 0.0 {
        100_000.0
    } else {
        0.0
    };
    (bounded / 25.0).ceil() as i64
}

/// Сортировка врагов плана по `enemy_id.localeCompare`. В JS сравнитель
/// падает `TypeError`, если элемент `null` или у вставляемого элемента
/// (не первого) `enemy_id` не строка.
fn sorted_plan_enemies(enemies: &[Value]) -> RewardResult<Vec<Value>> {
    if enemies.len() >= 2 {
        for (index, enemy) in enemies.iter().enumerate() {
            let bad_left = index > 0 && !enemy.get("enemy_id").is_some_and(Value::is_string);
            if enemy.is_null() || bad_left {
                return Err(EncounterRewardError::type_error("left.enemy_id.localeCompare is not a function"));
            }
        }
    }
    let mut sorted = enemies.to_vec();
    sorted.sort_by(|left, right| text::locale_compare(&js::string(left.get("enemy_id")), &js::string(right.get("enemy_id"))));
    Ok(sorted)
}

/// `rollEncounterCoins(plan, diceService)`: по 1к6 на врага × единицы опыта.
/// `dice = None` — сервис не передан (`TypeError` для плана с наградой).
pub fn roll_encounter_coins(plan: Option<&Value>, dice: Option<&mut dyn Dice>) -> RewardResult<Value> {
    if !js::truthy(prop(plan, "rewards_eligible")) {
        return Ok(json!({ "policy": ENCOUNTER_COINS_POLICY_ID, "encounter_id": clean_id(prop(plan, "encounter_id")), "rolls": [], "total_cp": 0 }));
    }
    let Some(dice) = dice else {
        return Err(EncounterRewardError::type_error("Encounter coin policy requires DiceService"));
    };
    let enemies = match prop(plan, "enemies") {
        Some(Value::Array(items)) => sorted_plan_enemies(items)?,
        Some(Value::String(text)) => sorted_plan_enemies(&text.chars().map(|ch| Value::String(ch.to_string())).collect::<Vec<_>>())?,
        _ => return Err(EncounterRewardError::type_error("plan.enemies is not iterable")),
    };
    if enemies.is_empty() || enemies.len() > ENCOUNTER_ASSEMBLER_LIMITS.maximum_creatures {
        return reject("Frozen plan содержит недопустимое число врагов", "ENCOUNTER_ENEMY_COUNT_INVALID");
    }
    let mut rolls = Vec::new();
    let mut total = 0.0;
    for enemy in &enemies {
        let enemy_id = js::string(enemy.get("enemy_id"));
        let roll = dice.roll("1d6", &format!("encounter-coins:{enemy_id}"), None, Visibility::Party)?;
        let units = encounter_coin_units_for_xp(enemy.get("xp"));
        let amount = roll.total * units;
        total += amount as f64;
        let mut entry = Map::new();
        entry.insert("roll_id".into(), json!(roll.roll_id));
        entry.insert("expression".into(), json!(roll.expression));
        entry.insert("dice".into(), json!(roll.dice));
        entry.insert("total".into(), json!(roll.total));
        if let Some(id) = enemy.get("enemy_id") {
            entry.insert("enemy_id".into(), id.clone());
        }
        if let Some(id) = enemy.get("stat_block_id") {
            entry.insert("stat_block_id".into(), id.clone());
        }
        if let Some(xp) = enemy.get("xp") {
            entry.insert("xp".into(), xp.clone());
        }
        entry.insert("xp_units".into(), json!(units));
        entry.insert("amount_cp".into(), json!(amount));
        rolls.push(Value::Object(entry));
    }
    if !is_safe_integer(total) || total < 0.0 || total > MAX_ENCOUNTER_COINS_CP as f64 {
        return reject("Монеты встречи вышли за разрешённую границу", "ENCOUNTER_COINS_OUT_OF_RANGE");
    }
    let mut result = Map::new();
    result.insert("policy".into(), json!(ENCOUNTER_COINS_POLICY_ID));
    if let Some(id) = prop(plan, "encounter_id") {
        result.insert("encounter_id".into(), id.clone());
    }
    result.insert("rolls".into(), Value::Array(rolls));
    result.insert("total_cp".into(), js::num(total));
    Ok(Value::Object(result))
}

/// `lootForEncounterOutcome(plan)`: обычная добыча и магическая находка.
pub fn loot_for_encounter_outcome(plan: Option<&Value>) -> RewardResult<Vec<Value>> {
    if !js::truthy(prop(plan, "rewards_eligible")) {
        return Ok(Vec::new());
    }
    let mut options = Map::new();
    for (to, from) in [("theme", "theme"), ("difficulty", "difficulty"), ("encounterId", "encounter_id")] {
        if let Some(value) = prop(plan, from) {
            options.insert(to.into(), value.clone());
        }
    }
    let mut loot = server_encounter_loot(Some(&Value::Object(options))).map_err(EncounterRewardError::type_error)?;
    let mut options = Map::new();
    for (to, from) in [("encounterId", "encounter_id"), ("totalXp", "total_xp")] {
        if let Some(value) = prop(plan, from) {
            options.insert(to.into(), value.clone());
        }
    }
    loot.extend(server_encounter_magic_loot(Some(&Value::Object(options))).map_err(EncounterRewardError::type_error)?);
    Ok(loot)
}

/// `serverRewardForEncounter(state, outcome)`: сводка награды по плану.
pub fn server_reward_for_encounter(state: &Value, outcome: Option<&Value>) -> RewardResult<Value> {
    let plan = freeze_encounter_outcome_plan(state, outcome)?;
    let eligible = js::truthy(plan.get("rewards_eligible"));
    Ok(json!({
        "encounter_id": plan["encounter_id"],
        "outcome": plan["outcome"],
        "xp": plan["total_xp"],
        "recipients": plan["recipients"],
        "progression": if eligible { json!("xp") } else { Value::Null },
        "milestone": null,
        "loot": loot_for_encounter_outcome(Some(&plan))?,
    }))
}

// ---------------------------------------------------------------------------
// Дележ
// ---------------------------------------------------------------------------

/// `experienceAwards(totalXp, recipients)`: доли опыта по строковому id
/// (`Map` JS: повтор id — значение последнего). Получатель не строкой до
/// выдачи не доходит: героя с таким ключом нет.
fn experience_awards(total_xp: f64, recipients: &[Value]) -> HashMap<String, f64> {
    let mut awards = HashMap::new();
    if recipients.is_empty() || total_xp <= 0.0 {
        return awards;
    }
    let count = recipients.len() as f64;
    let share = (total_xp / count).floor();
    let remainder = total_xp % count;
    for (index, id) in recipients.iter().enumerate() {
        if let Value::String(id) = id {
            awards.insert(id.clone(), share + if (index as f64) < remainder { 1.0 } else { 0.0 });
        }
    }
    awards
}

fn distribution_order(encounter_id: Option<&Value>, recipients: &[Value]) -> Vec<Value> {
    if recipients.is_empty() {
        return Vec::new();
    }
    let hex = digest(&format!("distribution:{}", js::string(encounter_id)));
    let offset = (u64::from_str_radix(&hex[..8], 16).unwrap_or(0) % recipients.len() as u64) as usize;
    recipients[offset..].iter().chain(recipients[..offset].iter()).cloned().collect()
}

fn materialized_loot_instances(encounter_id: Option<&Value>, loot: &[Value]) -> Vec<Value> {
    let encounter_digest = digest(&js::string(encounter_id))[..16].to_string();
    let mut items = Vec::new();
    for (stack_index, stack) in loot.iter().enumerate() {
        let count = units_of(Some(stack));
        let count = if count.is_finite() { count.trunc() as usize } else { 0 };
        let catalog_id = js::s(stack.get("catalog_id"));
        for unit_index in 0..count {
            let instance = json!({
                "id": format!("loot-{encounter_digest}-{}-{}", stack_index + 1, unit_index + 1),
                "quantity": 1,
                "equipped": false,
                "origin": "reward",
            });
            items.push(materialize_catalog_item(&catalog_id, Some(&instance)));
        }
    }
    items
}

fn is_magic(item: &Value) -> bool {
    catalog_item(&js::s(item.get("catalog_id"))).is_some_and(|entry| js::truthy(entry.get("magic_item")))
}

fn assert_loot_bounds(items: &[Value]) -> RewardResult<()> {
    let mut physical_units = 0.0;
    let mut weight = 0.0;
    for item in items {
        if item.is_null() {
            return Err(EncounterRewardError::type_error("Cannot read properties of null (reading 'quantity')"));
        }
        physical_units += units_of(Some(item));
    }
    for item in items {
        weight += stack_weight(Some(item));
    }
    let magic = items.iter().filter(|item| is_magic(item)).count();
    let mundane = items.len() - magic;
    if magic > 1 {
        return reject("За встречу выдаётся не больше одной магической находки", "ENCOUNTER_LOOT_OUT_OF_RANGE");
    }
    if mundane > 3 || physical_units > 10.0 || weight > 60.0 {
        return reject("Добыча встречи вышла за физические границы", "ENCOUNTER_LOOT_OUT_OF_RANGE");
    }
    Ok(())
}

fn can_receive_reward_items(player: Option<&Value>, items: &[Value]) -> RewardResult<bool> {
    let inventory = array_of(prop(player, "inventory"));
    if inventory.len() + items.len() > MAX_HERO_REWARD_INVENTORY_ITEMS {
        return Ok(false);
    }
    let added: f64 = items.iter().map(|item| stack_weight(Some(item))).sum();
    let current = js::number(Some(&inventory_weight(player)?));
    let capacity = js::number(Some(&carrying_capacity(player)));
    Ok(current + added <= capacity)
}

/// `assertEncounterRewardRecipients(state, recipients)`.
pub fn assert_encounter_reward_recipients(state: &Value, recipients: Option<&Value>) -> RewardResult<bool> {
    let ids: Vec<String> = list(recipients, "recipients")?.iter().map(|id| clean_id(Some(id))).collect();
    let players: HashSet<String> = players_of(non_null_state(state)?)?.iter().map(|player| actor_id(Some(player))).filter(|id| !id.is_empty()).collect();
    if ids.iter().any(String::is_empty) || ids.iter().collect::<HashSet<_>>().len() != ids.len() || ids.iter().any(|id| !players.contains(id)) {
        return reject("Состав получателей награды изменился после frozen plan", "ENCOUNTER_REWARD_RECIPIENT_CHANGED");
    }
    Ok(true)
}

fn players_by_id(state: &Value) -> RewardResult<HashMap<String, &Value>> {
    let mut by_id = HashMap::new();
    for player in players_of(state)? {
        by_id.insert(actor_id(Some(player)), player);
    }
    Ok(by_id)
}

/// `new Set(players.flatMap((player) => (player.inventory ?? []).map((item) => String(item?.id ?? '')).filter(Boolean)))`.
fn existing_item_ids(state: &Value) -> RewardResult<HashSet<String>> {
    let mut ids = HashSet::new();
    for player in players_of(state)? {
        if player.is_null() {
            return Err(EncounterRewardError::type_error("Cannot read properties of null (reading 'inventory')"));
        }
        for item in list(prop(Some(player), "inventory"), "player.inventory")? {
            let id = js::s(prop(Some(item), "id"));
            if !id.is_empty() {
                ids.insert(id);
            }
        }
    }
    Ok(ids)
}

/// `[...(plan?.recipients ?? [])]`.
fn spread_recipients(value: Option<&Value>) -> RewardResult<Vec<Value>> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => Ok(items.clone()),
        Some(Value::String(text)) => Ok(text.chars().map(|ch| Value::String(ch.to_string())).collect()),
        Some(_) => Err(EncounterRewardError::type_error("plan.recipients is not iterable")),
    }
}

/// `distributeEncounterRewards(state, { plan, coins, loot })`: дележ опыта,
/// монет и вещей между получателями плана.
pub fn distribute_encounter_rewards(state: &Value, plan: Option<&Value>, coins: Option<&Value>, loot: Option<&Value>) -> RewardResult<Value> {
    let recipients = spread_recipients(prop(plan, "recipients"))?;
    let encounter_id = prop(plan, "encounter_id");
    let order = distribution_order(encounter_id, &recipients);
    let loot_items = list(loot, "loot")?;
    assert_loot_bounds(loot_items)?;
    let items = materialized_loot_instances(encounter_id, loot_items);
    let total_xp = number_or_zero(prop(plan, "total_xp"));
    let xp_awards = experience_awards(total_xp, &recipients);
    let total_cp = js::number(Some(nullish(prop(coins, "total_cp"), Some(&json!(0))).unwrap_or(&json!(0))));
    if !is_safe_integer(total_cp) || total_cp < 0.0 || total_cp > MAX_ENCOUNTER_COINS_CP as f64 {
        return reject("Монеты встречи вышли за разрешённую границу", "ENCOUNTER_COINS_OUT_OF_RANGE");
    }
    let total_cp = total_cp as i64;
    let head = |allocations: Value, unassigned: Value| {
        let mut result = Map::new();
        result.insert("schema_version".into(), json!(ENCOUNTER_REWARDS_DISTRIBUTED_EVENT_SCHEMA_VERSION));
        result.insert("policy".into(), json!(ENCOUNTER_DISTRIBUTION_POLICY_ID));
        if let Some(id) = encounter_id {
            result.insert("encounter_id".into(), id.clone());
        }
        result.insert("allocations".into(), allocations);
        result.insert("unassigned".into(), unassigned);
        Value::Object(result)
    };
    if order.is_empty() {
        return Ok(head(json!([]), json!({ "xp": js::num(js_max(0.0, total_xp)), "coins_cp": total_cp, "items": items })));
    }
    let state = non_null_state(state)?;
    let by_id = players_by_id(state)?;
    struct Allocation {
        recipient_id: String,
        xp: f64,
        coins_cp: i64,
        items: Vec<Value>,
    }
    let mut allocations = Vec::new();
    for recipient in &order {
        let Some(recipient_id) = recipient.as_str().filter(|id| by_id.contains_key(*id)) else {
            return reject(format!("Получатель {} не найден", js::string(Some(recipient))), "ENCOUNTER_REWARD_RECIPIENT_UNKNOWN");
        };
        allocations.push(Allocation { recipient_id: recipient_id.to_string(), xp: xp_awards.get(recipient_id).copied().unwrap_or(0.0), coins_cp: 0, items: Vec::new() });
    }
    let count = allocations.len() as i64;
    let equal_share = total_cp.div_euclid(count);
    let remainder = total_cp.rem_euclid(count);
    for (index, allocation) in allocations.iter_mut().enumerate() {
        allocation.coins_cp = equal_share + if (index as i64) < remainder { 1 } else { 0 };
    }
    let mut unassigned_items = Vec::new();
    let mut next_recipient_index = 0;
    for item in items {
        let mut assigned = false;
        for attempt in 0..allocations.len() {
            let index = (next_recipient_index + attempt) % allocations.len();
            let player = by_id.get(&allocations[index].recipient_id).copied();
            let mut proposed = allocations[index].items.clone();
            proposed.push(item.clone());
            if !can_receive_reward_items(player, &proposed)? {
                continue;
            }
            allocations[index].items.push(item.clone());
            next_recipient_index = (index + 1) % allocations.len();
            assigned = true;
            break;
        }
        if !assigned {
            unassigned_items.push(item);
        }
    }
    let mut existing = existing_item_ids(state)?;
    for allocation in &allocations {
        let player = by_id.get(&allocation.recipient_id).copied();
        let after = currency_to_copper(prop(player, "currency")) as f64 + allocation.coins_cp as f64;
        if !is_safe_integer(after) || after > MAX_CURRENCY_CP as f64 {
            return reject("Кошелёк героя не может вместить награду встречи", "CURRENCY_LIMIT_EXCEEDED");
        }
        if !can_receive_reward_items(player, &allocation.items)? {
            return reject("Герой не может нести назначенную добычу", "ENCOUNTER_REWARD_CAPACITY_EXCEEDED");
        }
        for item in &allocation.items {
            let id = js::s(item.get("id"));
            if !js::truthy(item.get("id")) || existing.contains(&id) {
                return reject("ID предмета награды уже существует", "ENCOUNTER_LOOT_ID_COLLISION");
            }
            existing.insert(id);
        }
    }
    let allocations: Vec<Value> = allocations
        .into_iter()
        .map(|allocation| json!({ "recipient_id": allocation.recipient_id, "xp": js::num(allocation.xp), "coins_cp": allocation.coins_cp, "items": allocation.items }))
        .collect();
    Ok(head(Value::Array(allocations), json!({ "xp": 0, "coins_cp": 0, "items": unassigned_items })))
}

/// `assertEncounterDistributionPreconditions(state, distribution)`: дележ ещё
/// применим к текущему состоянию.
pub fn assert_encounter_distribution_preconditions(state: &Value, distribution: Option<&Value>) -> RewardResult<bool> {
    let state = non_null_state(state)?;
    let by_id = players_by_id(state)?;
    let mut existing = existing_item_ids(state)?;
    let allocations: Vec<Value> = match prop(distribution, "allocations") {
        // `for (const allocation of 'ab')` перебирает символы: героя нет.
        Some(Value::String(text)) if !text.is_empty() => return reject("Кошелёк героя не может вместить награду встречи", "CURRENCY_LIMIT_EXCEEDED"),
        Some(Value::String(_)) => Vec::new(),
        other => list(other, "distribution.allocations")?.to_vec(),
    };
    for allocation in &allocations {
        if allocation.is_null() {
            return Err(EncounterRewardError::type_error("Cannot read properties of null (reading 'recipient_id')"));
        }
        let player = by_id.get(&clean_id(prop(Some(allocation), "recipient_id"))).copied();
        let delta = js::number(prop(Some(allocation), "coins_cp"));
        let after = match player {
            Some(player) => currency_to_copper(prop(Some(player), "currency")) as f64 + delta,
            None => f64::NAN,
        };
        if player.is_none() || !is_safe_integer(delta) || delta < 0.0 || !is_safe_integer(after) || after < 0.0 || after > MAX_CURRENCY_CP as f64 {
            return reject("Кошелёк героя не может вместить награду встречи", "CURRENCY_LIMIT_EXCEEDED");
        }
        let items = array_of(prop(Some(allocation), "items"));
        if !can_receive_reward_items(player, items)? {
            return reject("Состояние инвентаря изменилось после frozen plan", "ENCOUNTER_REWARD_STATE_CHANGED");
        }
        for item in items {
            let id = js::s(prop(Some(item), "id"));
            if !js::truthy(prop(Some(item), "id")) || existing.contains(&id) {
                return reject("Состояние инвентаря изменилось после frozen plan", "ENCOUNTER_REWARD_STATE_CHANGED");
            }
            existing.insert(id);
        }
    }
    Ok(true)
}

/// `applyEncounterRewardsDistribution(state, event)`: применяет только точный
/// версионированный дележ, каталог не читается. Возвращает id героев, чьи
/// производные поля инвентаря надо обновить; на неподходящем событии — пусто
/// и состояние не меняется.
pub fn apply_encounter_rewards_distribution(state: &mut Value, event: &Value) -> RewardResult<Vec<String>> {
    let payload = event.get("payload");
    if !is_str(event.get("event_type"), "EncounterRewardsDistributed")
        || js::number(event.get("event_schema_version")) != ENCOUNTER_REWARDS_DISTRIBUTED_EVENT_SCHEMA_VERSION as f64
        || js::number(prop(payload, "schema_version")) != ENCOUNTER_REWARDS_DISTRIBUTED_EVENT_SCHEMA_VERSION as f64
    {
        return Ok(Vec::new());
    }
    let Some(Value::Array(allocations)) = prop(payload, "allocations") else {
        return Ok(Vec::new());
    };
    let allocation_ids: Vec<String> = allocations.iter().map(|allocation| clean_id(prop(Some(allocation), "recipient_id"))).collect();
    if allocation_ids.iter().any(String::is_empty) || allocation_ids.iter().collect::<HashSet<_>>().len() != allocation_ids.len() {
        return Ok(Vec::new());
    }
    let snapshot = non_null_state(state)?.clone();
    let by_id = players_by_id(&snapshot)?;
    if allocation_ids.iter().any(|id| !by_id.contains_key(id)) {
        return Ok(Vec::new());
    }
    let mut seen = existing_item_ids(&snapshot)?;
    let mut next_by_id: HashMap<String, Value> = HashMap::new();
    for allocation in allocations {
        let id = clean_id(prop(Some(allocation), "recipient_id"));
        let items: Vec<Value> = array_of(prop(Some(allocation), "items")).to_vec();
        if items.iter().any(|item| !js::truthy(prop(Some(item), "id")) || seen.contains(&js::s(prop(Some(item), "id")))) {
            return Ok(Vec::new());
        }
        let player = by_id.get(&id).copied();
        let delta = js::number(prop(Some(allocation), "coins_cp"));
        let after = currency_to_copper(prop(player, "currency")) as f64 + delta;
        if !is_safe_integer(delta) || delta < 0.0 || !is_safe_integer(after) || after < 0.0 || after > MAX_CURRENCY_CP as f64 || !can_receive_reward_items(player, &items)? {
            return Ok(Vec::new());
        }
        for item in &items {
            seen.insert(js::s(prop(Some(item), "id")));
        }
        let mut next = match player {
            Some(Value::Object(map)) => map.clone(),
            _ => Map::new(),
        };
        next.insert("currency".into(), copper_to_currency(Some(&js::num(after))));
        let mut inventory = array_of(prop(player, "inventory")).to_vec();
        inventory.extend(items);
        next.insert("inventory".into(), Value::Array(inventory));
        next_by_id.insert(id, Value::Object(next));
    }
    let players = match state.get("players") {
        Some(Value::Array(players)) => players.clone(),
        _ => return Err(EncounterRewardError::type_error("state.players.map is not a function")),
    };
    let replaced: Vec<Value> = players.into_iter().map(|player| next_by_id.get(&actor_id(Some(&player))).cloned().unwrap_or(player)).collect();
    if let Some(map) = state.as_object_mut() {
        map.insert("players".into(), Value::Array(replaced));
    }
    Ok(allocation_ids)
}

/// `encounterRewardResponse({ plan, coins, loot, distribution })`: ответ клиенту.
pub fn encounter_reward_response(plan: Option<&Value>, coins: Option<&Value>, loot: Option<&Value>, distribution: Option<&Value>) -> RewardResult<Value> {
    let or = |value: Option<&Value>, fallback: Value| match value {
        None | Some(Value::Null) => fallback,
        Some(value) => value.clone(),
    };
    let recipients = spread_recipients(prop(plan, "recipients"))?;
    Ok(json!({
        "encounter_id": or(prop(plan, "encounter_id"), json!("")),
        "outcome": or(prop(plan, "outcome"), json!("")),
        "xp": js::num(js_max(0.0, number_or_zero(prop(plan, "total_xp")))),
        "xp_recipients": recipients,
        "coins": js::num(js_max(0.0, number_or_zero(prop(coins, "total_cp")))),
        "coin_rolls": or(prop(coins, "rolls"), json!([])),
        "loot": or(loot, json!([])),
        "allocations": or(prop(distribution, "allocations"), json!([])),
        "unassigned": or(prop(distribution, "unassigned"), json!({ "xp": 0, "coins_cp": 0, "items": [] })),
    }))
}

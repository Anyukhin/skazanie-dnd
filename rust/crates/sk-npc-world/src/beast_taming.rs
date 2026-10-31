//! Перенос `server/beast-taming.mjs` — приручение зверя.
//!
//! Лестница `wary` → `calmed` → `fed` → `tamed`: уговор (Уход за животными,
//! ручной d20), кормление настоящим пайком из инвентаря и второй уговор.
//! Каждая ступень требует встать вплотную (`BEAST_APPROACH_REACH_FEET`). СЛ
//! выводится из зверя (CR, повадка, рана, сломленная мораль, кормление,
//! неудачные попытки) и объявляется слагаемыми. Провал с хищником — укус.
//! Приручённый — спутник, а не боевой актор: идёт за отрядом, держит стражу
//! лагеря (преимущество на Восприятие) и отгоняет мелкую тварь строкой
//! летописи. Список приручаемых закрыт (`BEAST_TAMING_DIETS`, собственные ключи).

use std::collections::HashSet;

use serde_json::{json, Map, Value};
use sk_core::{js, re, text as jstext};
use sk_geometry::actor_footprint::footprint_distance_feet;
use sk_social::npc_social::campaign_elapsed_minutes;

use crate::common::{array, coalesce, comparable, digest, get, integer, is_safe_f64, js_max, member, object_entries, spread, string, text, Member};
use crate::npc_positioning::scene_location_id;

pub const BEAST_TAMING_SCHEMA_VERSION: i64 = 1;
pub const BEAST_TAMING_POLICY_ID: &str = "skazanie:beast-taming-v1";
pub const BEAST_TAMING_SKILL: &str = "animal-handling";
pub const BEAST_TAMING_ABILITY: &str = "wis";
/// `BEAST_STAGES` — ступени приручения; порядок и есть правило.
pub const BEAST_STAGES: [&str; 4] = ["wary", "calmed", "fed", "tamed"];
pub const BEAST_STATUSES: [&str; 2] = ["wild", "companion"];
/// `BEAST_PLAYER_COMMAND_TYPES` (он же `BEAST_COMMAND_TYPES`).
pub const BEAST_PLAYER_COMMAND_TYPES: [&str; 3] = ["CalmBeast", "FeedBeast", "ScareWithBeast"];
pub const BEAST_COMMAND_TYPES: [&str; 3] = BEAST_PLAYER_COMMAND_TYPES;
/// `BEAST_TAMING_DIETS` — закрытый список приручаемых и их повадка.
pub const BEAST_TAMING_DIETS: [(&str, &str); 9] = [
    ("srd_5_2_1:wolf", "predator"),
    ("srd_5_2_1:dire-wolf", "predator"),
    ("srd_5_2_1:lion", "predator"),
    ("srd_5_2_1:tiger", "predator"),
    ("srd_5_2_1:brown-bear", "predator"),
    ("srd_5_2_1:giant-rat", "predator"),
    ("srd_5_2_1:giant-boar", "herbivore"),
    ("srd_5_2_1:ankylosaurus", "herbivore"),
    ("srd_5_2_1:hippopotamus", "herbivore"),
];
pub const BEAST_DIETS: [&str; 2] = ["predator", "herbivore"];
pub const BEAST_BASE_DC: i64 = 10;
pub const BEAST_PREDATOR_DC_SHIFT: i64 = 3;
pub const BEAST_WOUNDED_DC_SHIFT: i64 = 2;
pub const BEAST_BROKEN_MORALE_DC_SHIFT: i64 = -2;
pub const BEAST_FED_DC_SHIFT: i64 = -4;
pub const BEAST_ATTEMPT_DC_STEP: i64 = 1;
pub const BEAST_ATTEMPT_DC_CAP: i64 = 3;
pub const BEAST_SCARE_COOLDOWN_MINUTES: i64 = 60;
pub const BEAST_APPROACH_REACH_FEET: i64 = 5;
pub const BEAST_APPROACH_MINUTES: i64 = 10;
/// `BEAST_CARD_TITLE` — подпись карточки летописи.
pub const BEAST_CARD_TITLE: &str = "Зверь и отряд";

const MAX_BEASTS: usize = 40;

const CR_DC_SHIFTS: [(f64, i64); 6] = [(0.125, -2), (0.25, 0), (0.5, 1), (1.0, 3), (2.0, 5), (3.0, 7)];

const SCARE_LINES: [&str; 4] = [
    "{beast} поднимает голову, скалится в темноту — и то мелкое, что подбиралось к лагерю, уходит прочь.",
    "{beast} коротко рычит в сторону кустов. Шорох там обрывается и больше не повторяется.",
    "{beast} встаёт между отрядом и темнотой. Кто бы там ни был, связываться он не стал.",
    "{beast} вскидывается на шум и делает шаг вперёд. Этого хватило: дальше тихо.",
];

// ---------------------------------------------------------------------------
// Стат-блок зверя
// ---------------------------------------------------------------------------

fn creature_type_of(enemy: Option<&Value>) -> String {
    comparable(coalesce(coalesce(coalesce(get(enemy, "creature_type"), get(enemy, "creatureType")), get(enemy, "monster_type")), get(enemy, "kind")))
}

fn stat_block_id_of(enemy: Option<&Value>) -> String {
    text(coalesce(get(enemy, "stat_block_id"), get(enemy, "statBlockId")), 120)
}

/// Повадка зверя: строка таблицы или то, что находит в таблице ключ прототипа.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BeastDiet {
    Predator,
    Herbivore,
}

impl BeastDiet {
    fn parse(text: &str) -> Option<Self> {
        match text {
            "predator" => Some(Self::Predator),
            "herbivore" => Some(Self::Herbivore),
            _ => None,
        }
    }

    /// Значение JSON.
    pub fn to_json(self) -> Option<Value> {
        match self {
            Self::Predator => Some(json!("predator")),
            Self::Herbivore => Some(json!("herbivore")),
        }
    }
}

/// `beastDietFor(enemy)`: повадка приручаемого зверя; `None` — не из списка.
pub fn beast_diet_for(enemy: Option<&Value>) -> Option<BeastDiet> {
    if creature_type_of(enemy) != "beast" {
        return None;
    }
    let id = stat_block_id_of(enemy);
    if let Some((_, diet)) = BEAST_TAMING_DIETS.iter().find(|(key, _)| *key == id) {
        return BeastDiet::parse(diet);
    }
    None
}

/// `isTameableBeast(enemy)`.
pub fn is_tameable_beast(enemy: Option<&Value>) -> bool {
    beast_diet_for(enemy).is_some()
}

/// `beastChallengeRating(enemy)`: CR стат-блока числом («1/4» → 0.25).
pub fn beast_challenge_rating(enemy: Option<&Value>) -> f64 {
    let raw = text(coalesce(get(get(enemy, "provenance"), "challenge_rating"), get(enemy, "challenge_rating")), 12);
    let fraction = re!(r"^(\d+)\s*\/\s*(\d+)$", "u");
    if let (Some(numerator), Some(denominator)) = (jstext::capture(fraction, &raw, 1), jstext::capture(fraction, &raw, 2)) {
        let denominator = js::parse_number(&denominator);
        return if denominator > 0.0 { js::parse_number(&numerator) / denominator } else { 0.0 };
    }
    let plain = js::parse_number(&raw);
    if plain.is_finite() && plain >= 0.0 {
        plain
    } else {
        0.0
    }
}

fn finite_or_zero(value: Option<&Value>) -> f64 {
    let number = js::number(value);
    if number.is_finite() {
        number
    } else {
        0.0
    }
}

fn dc_shift(value: f64) -> i64 {
    CR_DC_SHIFTS.iter().find(|(up_to, _)| value <= *up_to).map_or(9, |(_, shift)| *shift)
}

/// `beastChallengeDcShift(challengeRating)`: прибавка к СЛ за силу зверя.
pub fn beast_challenge_dc_shift(challenge_rating: Option<&Value>) -> i64 {
    dc_shift(finite_or_zero(challenge_rating))
}

fn bite_damage(value: f64) -> &'static str {
    if value <= 0.5 {
        "1d4"
    } else if value <= 2.0 {
        "1d6"
    } else {
        "1d8"
    }
}

/// `beastBiteDamage(challengeRating)`: укус при провале, выведенный из CR.
pub fn beast_bite_damage(challenge_rating: Option<&Value>) -> &'static str {
    bite_damage(finite_or_zero(challenge_rating))
}

fn actor_hit_points(enemy: Option<&Value>) -> i64 {
    0.max(integer(coalesce(get(enemy, "hp"), get(enemy, "hitPoints")), 0))
}

fn actor_max_hit_points(enemy: Option<&Value>) -> i64 {
    1.max(integer(coalesce(coalesce(get(enemy, "maxHp"), get(enemy, "max_hp")), get(enemy, "hp")), 1))
}

/// `beastIsWounded(enemy)`: меньше половины хитов.
pub fn beast_is_wounded(enemy: Option<&Value>) -> bool {
    actor_hit_points(enemy) * 2 < actor_max_hit_points(enemy)
}

fn condition_ids(state: &Value, actor_id: &str) -> HashSet<String> {
    match member(get(get(Some(state), "mechanics"), "conditions"), actor_id) {
        // Не массив в JS — `TypeError` на `.map`; здесь — пусто.
        Member::Own(Value::Array(items)) => items.iter().map(|condition| js::string(coalesce(get(Some(condition), "id"), Some(condition)))).collect(),
        _ => HashSet::new(),
    }
}

/// `beastMoraleBroken(state, enemyId)`: зверь бежит или сдался.
pub fn beast_morale_broken(state: &Value, enemy_id: Option<&Value>) -> bool {
    // `enemyId = ''`: значение по умолчанию действует и для `enemy?.id === undefined`.
    let conditions = condition_ids(state, &enemy_id.map_or_else(String::new, |id| js::string(Some(id))));
    conditions.contains("fled") || conditions.contains("surrendered")
}

// ---------------------------------------------------------------------------
// Реестр
// ---------------------------------------------------------------------------

fn optional_minutes(value: Option<&Value>) -> Value {
    if js::present(value) {
        json!(0.max(integer(value, 0)))
    } else {
        Value::Null
    }
}

fn one_of(value: Option<&Value>, list: &[&str]) -> Option<String> {
    value.and_then(Value::as_str).filter(|text| list.contains(text)).map(str::to_string)
}

fn safe_beast(value: Option<&Value>) -> Option<Value> {
    let id = text(get(value, "id"), 120);
    let actor_id = text(get(value, "actor_id"), 120);
    if !jstext::test(re!(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$", "u"), &id) || actor_id.is_empty() {
        return None;
    }
    let stage = one_of(get(value, "stage"), &BEAST_STAGES).unwrap_or_else(|| "wary".to_string());
    let status = if stage == "tamed" { "companion".to_string() } else { one_of(get(value, "status"), &BEAST_STATUSES).unwrap_or_else(|| "wild".to_string()) };
    let mut beast = Map::new();
    beast.insert("id".into(), string(id));
    beast.insert("actor_id".into(), string(actor_id));
    beast.insert("name".into(), string(text(get(value, "name"), 160)));
    beast.insert("diet".into(), string(one_of(get(value, "diet"), &BEAST_DIETS).unwrap_or_else(|| "predator".to_string())));
    beast.insert("stat_block_id".into(), string(text(get(value, "stat_block_id"), 120)));
    beast.insert("challenge_rating".into(), string(text(get(value, "challenge_rating"), 12)));
    beast.insert("stage".into(), string(stage));
    beast.insert("status".into(), string(status));
    beast.insert("attempts".into(), json!(0.max(integer(get(value, "attempts"), 0))));
    beast.insert("bites".into(), json!(0.max(integer(get(value, "bites"), 0))));
    beast.insert("location_id".into(), string(text(get(value, "location_id"), 180)));
    beast.insert("location_name".into(), string(text(get(value, "location_name"), 180)));
    beast.insert("met_at_minutes".into(), json!(0.max(integer(get(value, "met_at_minutes"), 0))));
    for key in ["calmed_at_minutes", "fed_at_minutes", "tamed_at_minutes", "scared_at_minutes"] {
        beast.insert(key.into(), optional_minutes(get(value, key)));
    }
    beast.insert("policy_id".into(), string(BEAST_TAMING_POLICY_ID));
    Some(Value::Object(beast))
}

fn is_companion(beast: &Value) -> bool {
    beast.get("status").and_then(Value::as_str) == Some("companion")
}

/// Вытеснение старых записей: спутники из него исключены — иначе отряд,
/// встретивший за кампанию сорок волков, молча терял бы питомца.
fn evicted_beasts(beasts: Vec<Value>) -> Vec<Value> {
    if beasts.len() <= MAX_BEASTS {
        return beasts;
    }
    let companions: Vec<&Value> = beasts.iter().filter(|beast| is_companion(beast)).collect();
    if companions.len() >= MAX_BEASTS {
        return companions[companions.len() - MAX_BEASTS..].iter().map(|beast| (*beast).clone()).collect();
    }
    let wild: Vec<&Value> = beasts.iter().filter(|beast| !is_companion(beast)).collect();
    let skip = companions.len() + wild.len() - MAX_BEASTS;
    let kept: HashSet<String> = wild.iter().skip(skip).map(|beast| js::s(beast.get("id"))).collect();
    beasts.into_iter().filter(|beast| is_companion(beast) || kept.contains(&js::s(beast.get("id")))).collect()
}

fn normalize_beasts(input: Option<&Value>) -> Vec<Value> {
    let source = input.filter(|value| value.is_object());
    let mut beasts = Vec::new();
    let mut seen = HashSet::new();
    for raw in array(get(source, "beasts")) {
        let Some(beast) = safe_beast(Some(raw)) else { continue };
        if !seen.insert(js::s(beast.get("id"))) {
            continue;
        }
        beasts.push(beast);
    }
    evicted_beasts(beasts)
}

/// `normalizeBeastState(input)`: реестр не больше чем на 40 зверей.
pub fn normalize_beast_state(input: Option<&Value>) -> Value {
    json!({ "schema_version": BEAST_TAMING_SCHEMA_VERSION, "beasts": normalize_beasts(input) })
}

/// `beastList(state)`.
pub fn beast_list(state: &Value) -> Vec<Value> {
    normalize_beasts(get(Some(state), "beasts"))
}

/// `beastFor(state, beastId)`.
pub fn beast_for(state: &Value, beast_id: Option<&Value>) -> Option<Value> {
    let expected = text(beast_id, 120);
    beast_list(state).into_iter().find(|beast| beast.get("id").and_then(Value::as_str) == Some(expected.as_str()))
}

/// `beastCompanions(state)`.
pub fn beast_companions(state: &Value) -> Vec<Value> {
    beast_list(state).into_iter().filter(is_companion).collect()
}

/// `beastIdFor(state, actorId)`: идентификатор записи от сида кампании и актора.
pub fn beast_id_for(state: &Value, actor_id: Option<&Value>) -> String {
    format!("beast:{}", &digest(&[text(get(Some(state), "sessionCode"), 60), text(actor_id, 120)])[..24])
}

// ---------------------------------------------------------------------------
// Досягаемость
// ---------------------------------------------------------------------------

fn actor_cell(state: &Value, id: &str) -> Option<Value> {
    if id.is_empty() {
        return None;
    }
    let mut actors: Vec<&Value> = array(get(Some(state), "players")).iter().collect();
    actors.extend(array(get(Some(state), "enemies")).iter());
    let actor = actors.into_iter().find(|candidate| js::s(get(Some(candidate), "id")) == id);
    let stored = match member(get(get(Some(state), "mechanics"), "positions"), id) {
        // Только собственная позиция: ключ прототипа — к листу актора.
        Member::Own(found) if !found.is_null() => Some(found),
        _ => actor,
    };
    let x = js::number(get(stored, "x"));
    let y = js::number(get(stored, "y"));
    (is_safe_f64(x) && is_safe_f64(y)).then(|| json!({ "x": x as i64, "y": y as i64 }))
}

/// `beastDistanceFeet(state, heroId, enemyId)`: футы между героем и зверем;
/// `None` — у кого-то из двоих нет клетки.
pub fn beast_distance_feet(state: &Value, hero_id: Option<&Value>, enemy_id: Option<&Value>) -> Option<f64> {
    let hero_key = js::s(hero_id);
    let enemy_key = js::s(enemy_id);
    let from = actor_cell(state, &hero_key)?;
    let to = actor_cell(state, &enemy_key)?;
    let hero = array(get(Some(state), "players")).iter().find(|actor| js::s(get(Some(actor), "id")) == hero_key);
    let enemy = array(get(Some(state), "enemies")).iter().find(|actor| js::s(get(Some(actor), "id")) == enemy_key);
    footprint_distance_feet(hero, enemy, Some(&from), Some(&to))
}

/// Досягаемость одной меркой (`beastReachFor`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BeastReach {
    pub distance_feet: Option<f64>,
    pub out_of_reach: bool,
}

impl BeastReach {
    pub fn to_json(&self) -> Value {
        json!({ "distance_feet": self.distance_feet.map_or(Value::Null, js::num), "out_of_reach": self.out_of_reach })
    }
}

/// `beastReachFor(state, heroId, enemyId)`.
pub fn beast_reach_for(state: &Value, hero_id: Option<&Value>, enemy_id: Option<&Value>) -> BeastReach {
    let distance = beast_distance_feet(state, hero_id, enemy_id);
    BeastReach { distance_feet: distance, out_of_reach: distance.is_some_and(|distance| distance > BEAST_APPROACH_REACH_FEET as f64) }
}

/// `beastOutOfReach(state, heroId, enemyId)`.
pub fn beast_out_of_reach(state: &Value, hero_id: Option<&Value>, enemy_id: Option<&Value>) -> bool {
    beast_reach_for(state, hero_id, enemy_id).out_of_reach
}

/// `beastReachByHero(state, enemyId)`: досягаемость по каждому герою отряда.
/// Герой с id `__proto__` в JS уходит в прототип объекта строк и в JSON не
/// попадает — так же и здесь.
pub fn beast_reach_by_hero(state: &Value, enemy_id: Option<&Value>) -> Map<String, Value> {
    let mut rows = Map::new();
    for hero in array(get(Some(state), "players")) {
        let hero_id = js::s(get(Some(hero), "id"));
        if hero_id.is_empty() || hero_id == "__proto__" || rows.contains_key(&hero_id) {
            continue;
        }
        let reach = beast_reach_for(state, Some(&json!(hero_id)), enemy_id).to_json();
        rows.insert(hero_id, reach);
    }
    rows
}

fn is_party_hero(state: &Value, hero_id: &str) -> bool {
    !hero_id.is_empty() && array(get(Some(state), "players")).iter().any(|hero| js::s(get(Some(hero), "id")) == hero_id)
}

/// `beastApproachBlockedReason(state, enemy)`: `beast_down`, `combat_active` или `None`.
pub fn beast_approach_blocked_reason(state: &Value, enemy: Option<&Value>) -> Option<&'static str> {
    if actor_hit_points(enemy) <= 0 || js::is_false(get(enemy, "alive")) {
        return Some("beast_down");
    }
    let combat = js::is_true(get(get(get(Some(state), "mechanics"), "combat"), "active"));
    if combat && !beast_morale_broken(state, get(enemy, "id")) {
        return Some("combat_active");
    }
    None
}

/// Кандидат на уговор: зверь сцены, его запись реестра и повод отказа.
#[derive(Debug, Clone, PartialEq)]
pub struct TameableBeast {
    pub enemy: Value,
    pub beast: Option<Value>,
    pub blocked_reason: Option<&'static str>,
}

impl TameableBeast {
    pub fn to_json(&self) -> Value {
        json!({ "enemy": self.enemy, "beast": self.beast.clone().unwrap_or(Value::Null), "blocked_reason": self.blocked_reason })
    }
}

/// `tameableBeasts(state)`: живые приручаемые звери сцены по id актора.
pub fn tameable_beasts(state: &Value) -> Vec<TameableBeast> {
    let mut registry: Map<String, Value> = Map::new();
    for beast in beast_list(state) {
        registry.insert(js::s(beast.get("actor_id")), beast);
    }
    let mut list: Vec<TameableBeast> = array(get(Some(state), "enemies"))
        .iter()
        .filter(|enemy| js::truthy(get(Some(enemy), "id")) && is_tameable_beast(Some(enemy)))
        .map(|enemy| TameableBeast {
            enemy: enemy.clone(),
            beast: registry.get(&js::s(enemy.get("id"))).cloned(),
            blocked_reason: beast_approach_blocked_reason(state, Some(enemy)),
        })
        .filter(|entry| !entry.beast.as_ref().is_some_and(is_companion))
        .collect();
    list.sort_by(|left, right| jstext::locale_compare(&js::s(left.enemy.get("id")), &js::s(right.enemy.get("id"))));
    list
}

/// Минуты кампании, прошедшие через `integer(value, 0)`: дробное и
/// бесконечное число становится нулём.
fn safe_minutes(value: f64) -> i64 {
    if is_safe_f64(value) {
        value as i64
    } else {
        0
    }
}

/// `beastDraftFor(state, enemy)`: черновик записи для ещё не заведённого зверя.
pub fn beast_draft_for(state: &Value, enemy: Option<&Value>) -> Option<Value> {
    let minutes = campaign_elapsed_minutes(state);
    let scene = get(Some(state), "scene");
    let diet = match beast_diet_for(enemy) {
        Some(BeastDiet::Herbivore) => "herbivore",
        // Повадка-функция в `safeBeast` не проходит список и становится хищником.
        _ => "predator",
    };
    safe_beast(Some(&json!({
        "id": beast_id_for(state, get(enemy, "id")),
        "actor_id": js::s(get(enemy, "id")),
        "name": text(get(enemy, "name"), 160),
        "diet": diet,
        "stat_block_id": stat_block_id_of(enemy),
        "challenge_rating": text(get(get(enemy, "provenance"), "challenge_rating"), 12),
        "stage": "wary",
        "status": "wild",
        "location_id": scene_location_id(state),
        "location_name": text(coalesce(get(scene, "location"), get(scene, "title")), 180),
        "met_at_minutes": safe_minutes(minutes),
    })))
}

// ---------------------------------------------------------------------------
// Политика проверки
// ---------------------------------------------------------------------------

/// Слагаемое СЛ уговора.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DcPart {
    pub id: &'static str,
    pub label: String,
    pub shift: i64,
}

impl DcPart {
    pub fn to_json(&self) -> Value {
        json!({ "id": self.id, "label": self.label, "shift": self.shift })
    }
}

/// СЛ уговора и её слагаемые (`beastTamingPolicy`).
#[derive(Debug, Clone, PartialEq)]
pub struct BeastTamingPolicy {
    pub difficulty: i64,
    /// Повадка: строка, `{}` (`Object.prototype`) или `None` — функция из
    /// прототипа таблицы, которую JSON не пишет.
    pub diet: Option<Value>,
    pub wounded: bool,
    pub broken_morale: bool,
    pub stage: String,
    pub attempts: i64,
    pub challenge_rating: String,
    pub bites_on_failure: bool,
    pub bite_damage: &'static str,
    pub parts: Vec<DcPart>,
}

impl BeastTamingPolicy {
    pub fn stage_after(&self) -> &'static str {
        if self.stage == "fed" {
            "tamed"
        } else {
            "calmed"
        }
    }

    pub fn to_json(&self) -> Value {
        let mut policy = Map::new();
        policy.insert("skill".into(), json!(BEAST_TAMING_SKILL));
        policy.insert("ability".into(), json!(BEAST_TAMING_ABILITY));
        policy.insert("difficulty".into(), json!(self.difficulty));
        if let Some(diet) = &self.diet {
            policy.insert("diet".into(), diet.clone());
        }
        policy.insert("wounded".into(), json!(self.wounded));
        policy.insert("broken_morale".into(), json!(self.broken_morale));
        policy.insert("stage".into(), json!(self.stage));
        policy.insert("stage_after".into(), json!(self.stage_after()));
        policy.insert("attempts".into(), json!(self.attempts));
        policy.insert("challenge_rating".into(), json!(self.challenge_rating));
        policy.insert("bites_on_failure".into(), json!(self.bites_on_failure));
        policy.insert("bite_damage".into(), json!(self.bite_damage));
        policy.insert("parts".into(), Value::Array(self.parts.iter().map(DcPart::to_json).collect()));
        policy.insert("policy_id".into(), json!(BEAST_TAMING_POLICY_ID));
        Value::Object(policy)
    }
}

/// `beastTamingPolicy(state, enemy, beast)`: СЛ из зверя, а не из таблицы
/// «сложность приручения»; слагаемые объявлены на карточке броска.
pub fn beast_taming_policy(state: &Value, enemy: Option<&Value>, beast: Option<&Value>) -> BeastTamingPolicy {
    let diet: Option<Value> = match beast_diet_for(enemy) {
        Some(diet) => diet.to_json(),
        None => Some(coalesce(get(beast, "diet"), None).cloned().unwrap_or_else(|| json!("predator"))),
    };
    let predator = diet.as_ref().and_then(Value::as_str) == Some("predator");
    let challenge_rating = beast_challenge_rating(enemy);
    let wounded = beast_is_wounded(enemy);
    let broken_morale = beast_morale_broken(state, get(enemy, "id"));
    let stage = one_of(get(beast, "stage"), &BEAST_STAGES).unwrap_or_else(|| "wary".to_string());
    let attempts = 0.max(integer(get(beast, "attempts"), 0));
    let mut parts = vec![
        DcPart { id: "base", label: "основа".into(), shift: BEAST_BASE_DC },
        // Метка бесчисловая: CR раскрывает только знание отряда о враге.
        DcPart { id: "challenge", label: "сила зверя".into(), shift: dc_shift(challenge_rating) },
    ];
    if predator {
        parts.push(DcPart { id: "predator", label: "хищник".into(), shift: BEAST_PREDATOR_DC_SHIFT });
    }
    if wounded {
        parts.push(DcPart { id: "wounded", label: "ранен и загнан".into(), shift: BEAST_WOUNDED_DC_SHIFT });
    }
    if broken_morale {
        parts.push(DcPart { id: "morale", label: "мораль уже сломана".into(), shift: BEAST_BROKEN_MORALE_DC_SHIFT });
    }
    if stage == "fed" {
        parts.push(DcPart { id: "fed", label: "поел с руки".into(), shift: BEAST_FED_DC_SHIFT });
    }
    let attempt_shift = BEAST_ATTEMPT_DC_CAP.min(attempts.saturating_mul(BEAST_ATTEMPT_DC_STEP));
    if attempt_shift > 0 {
        parts.push(DcPart { id: "attempts", label: format!("неудачные попытки ({attempts})"), shift: attempt_shift });
    }
    let difficulty = 5.max(25.min(parts.iter().map(|part| part.shift).sum::<i64>()));
    BeastTamingPolicy {
        difficulty,
        bites_on_failure: predator && stage == "wary",
        diet,
        wounded,
        broken_morale,
        stage,
        attempts,
        challenge_rating: text(get(get(enemy, "provenance"), "challenge_rating"), 12),
        bite_damage: bite_damage(challenge_rating),
        parts,
    }
}

// ---------------------------------------------------------------------------
// Кормление
// ---------------------------------------------------------------------------

/// Что зверю не отдают, даже если оно называется мясом: снаряжённое,
/// сюжетное, непродаваемое, необычной редкости и с настройкой.
fn food_disqualified(item: &Value, entry: Option<&Value>) -> bool {
    let item = Some(item);
    if js::is_true(get(item, "equipped")) || js::is_true(get(item, "quest_item")) || js::is_false(get(item, "sellable")) {
        return true;
    }
    if jstext::lower(&js::s(get(item, "type"))) == "quest" {
        return true;
    }
    if !["", "обычный", "common"].contains(&comparable(coalesce(get(item, "rarity"), get(entry, "rarity"))).as_str()) {
        return true;
    }
    js::is_true(get(item, "requires_attunement")) || js::is_true(get(entry, "requires_attunement")) || js::is_true(get(get(entry, "attunement"), "required"))
}

/// `beastFoodItemFor(actor, resolveCatalogItem)`: чем кормить — каталожный
/// паёк, затем каталожный id пайка, затем свободное имя еды. Каталог
/// передаётся снаружи (`resolve_catalog_item`), как в JS.
pub fn beast_food_item_for(actor: Option<&Value>, resolve_catalog_item: Option<&dyn Fn(&str) -> Option<Value>>) -> Option<Value> {
    let edible: Vec<(&Value, String, Option<Value>)> = array(get(actor, "inventory"))
        .iter()
        .filter(|item| js::truthy(Some(item)) && 0.max(integer(get(Some(item), "quantity"), 1)) > 0)
        .map(|item| {
            let catalog_id = text(coalesce(get(Some(item), "catalog_id"), get(Some(item), "catalogId")), 120);
            let entry = match resolve_catalog_item {
                Some(resolve) if !catalog_id.is_empty() => resolve(&catalog_id),
                _ => None,
            };
            (item, catalog_id, entry)
        })
        .filter(|(item, _, entry)| !food_disqualified(item, entry.as_ref()))
        .collect();
    edible
        .iter()
        .find(|(_, _, entry)| get(get(entry.as_ref(), "use"), "kind").and_then(Value::as_str) == Some("ration"))
        .or_else(|| edible.iter().find(|(_, catalog_id, _)| jstext::test(re!(r"rations?-one-day$", "u"), catalog_id)))
        .or_else(|| edible.iter().find(|(item, _, _)| jstext::test(re!(r"(па[её]к|провиз|снедь|сухар|вялен|мяс)", "iu"), &text(get(Some(item), "name"), 120))))
        .map(|(item, _, _)| (*item).clone())
}

// ---------------------------------------------------------------------------
// Спутник
// ---------------------------------------------------------------------------

/// `partyIsResting(state)`: у кого-то из героев идёт отдых (не нокаут).
pub fn party_is_resting(state: &Value) -> bool {
    let resting = coalesce(get(get(Some(state), "mechanics"), "resting"), None);
    object_entries(resting).iter().any(|(_, entry)| js::truthy(Some(entry)) && get(Some(entry), "reason").and_then(Value::as_str) != Some("knockout"))
}

/// `beastWatchCompanion(state)`: спутник, который держит стражу лагеря.
pub fn beast_watch_companion(state: &Value) -> Option<Value> {
    if !party_is_resting(state) {
        return None;
    }
    beast_companions(state).into_iter().next()
}

/// `beastWatchSwing(state, skill, heroId)`: преимущество на Восприятие героя
/// отряда, пока идёт привал и рядом спутник.
pub fn beast_watch_swing(state: &Value, skill: Option<&Value>, hero_id: Option<&Value>) -> Option<Value> {
    if jstext::lower(jstext::trim(&js::s(skill))).replace('_', "-") != "perception" {
        return None;
    }
    if !is_party_hero(state, &js::s(hero_id)) {
        return None;
    }
    let companion = beast_watch_companion(state)?;
    let name = js::s(companion.get("name"));
    let name = if name.is_empty() { "Зверь".to_string() } else { name };
    Some(json!({ "swing": "advantage", "reason": format!("{name} на страже лагеря") }))
}

fn minutes_of(value: Option<&Value>) -> i64 {
    0.max(integer(value, 0))
}

/// `beastScareLine(beast, minutes)`: строка отпугивания от записи и часа мира.
pub fn beast_scare_line(beast: Option<&Value>, minutes: Option<&Value>) -> String {
    let hour = (minutes_of(minutes) as f64 / 60.0).floor();
    let hex = digest(&[js::s(get(beast, "id")), js::f64_string(hour)]);
    let index = i64::from_str_radix(&hex[..8], 16).unwrap_or(0) as usize % SCARE_LINES.len();
    let name = text(get(beast, "name"), 60);
    SCARE_LINES[index].replace("{beast}", if name.is_empty() { "Зверь" } else { &name })
}

/// `beastScareCooldownLeft(beast, minutes)`: минут до следующего отпугивания.
pub fn beast_scare_cooldown_left(beast: Option<&Value>, minutes: Option<&Value>) -> i64 {
    let last = get(beast, "scared_at_minutes");
    if !js::present(last) {
        return 0;
    }
    0.max(BEAST_SCARE_COOLDOWN_MINUTES - (minutes_of(minutes) - minutes_of(last)))
}

/// `planBeastFollowDrafts(state)`: спутники идут за отрядом в новую сцену.
pub fn plan_beast_follow_drafts(state: &Value) -> Vec<Value> {
    let location_id = scene_location_id(state);
    let scene = get(Some(state), "scene");
    let location_name = text(coalesce(get(scene, "location"), get(scene, "title")), 180);
    beast_companions(state)
        .into_iter()
        .filter(|beast| !(beast.get("location_id").and_then(Value::as_str) == Some(location_id.as_str()) && comparable(beast.get("location_name")) == jstext::lower(&location_name)))
        .map(|beast| {
            json!({
                "event_type": "BeastMoved",
                "payload": {
                    "beast_id": beast["id"],
                    "actor_id": beast["actor_id"],
                    "beast_name": beast["name"],
                    "location_id": location_id,
                    "location_name": location_name,
                    "policy_id": BEAST_TAMING_POLICY_ID,
                },
                "target_ids": [],
                "visibility": "party",
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Проекция
// ---------------------------------------------------------------------------

/// Подпись из таблицы JS по ключу `String(value ?? '')`: строка, функция
/// прототипа (`None`) или `Object.prototype` (`{}`).
fn label_lookup(table: &[(&str, &'static str)], value: Option<&Value>) -> Option<Value> {
    let key = js::s(value);
    if let Some((_, label)) = table.iter().find(|(name, _)| *name == key) {
        return Some(json!(label));
    }
    Some(json!(""))
}

const DIET_LABELS: [(&str, &str); 2] = [("predator", "хищник"), ("herbivore", "травоядный")];
const STAGE_LABELS: [(&str, &str); 4] = [("wary", "сторожится"), ("calmed", "успокоен"), ("fed", "накормлен с руки"), ("tamed", "идёт с отрядом")];

/// `String(diet)` для повадки-функции и `Object.prototype` — ключа в таблице нет.
fn diet_key(diet: Option<&Value>) -> Value {
    match diet {
        None => json!("function"),
        Some(Value::Object(_)) => json!("[object Object]"),
        Some(other) => other.clone(),
    }
}

/// `beastDietLabel(diet)` как в JS: `Some(строка)`, `Some({})` для
/// `__proto__` или `None` — унаследованная функция для `constructor` и пр.
pub fn beast_diet_label_value(diet: Option<&Value>) -> Option<Value> {
    label_lookup(&DIET_LABELS, diet)
}

/// `beastDietLabel(diet)`: подпись повадки; для ключей прототипа — пусто
/// (JS там возвращает унаследованное значение, см. [`beast_diet_label_value`]).
pub fn beast_diet_label(diet: Option<&Value>) -> String {
    beast_diet_label_value(diet).and_then(|label| label.as_str().map(str::to_string)).unwrap_or_default()
}

/// `beastStageLabel(stage)` как в JS (см. [`beast_diet_label_value`]).
pub fn beast_stage_label_value(stage: Option<&Value>) -> Option<Value> {
    label_lookup(&STAGE_LABELS, stage)
}

/// `beastStageLabel(stage)`: подпись ступени.
pub fn beast_stage_label(stage: Option<&Value>) -> String {
    beast_stage_label_value(stage).and_then(|label| label.as_str().map(str::to_string)).unwrap_or_default()
}

/// `beastForViewer(beast)`: запись глазами отряда — без стат-блока и CR.
pub fn beast_for_viewer(beast: Option<&Value>) -> Option<Value> {
    let normalized = safe_beast(beast)?;
    let mut visible = match normalized {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    visible.shift_remove("stat_block_id");
    visible.shift_remove("challenge_rating");
    let diet = visible.get("diet").cloned();
    let stage = visible.get("stage").cloned();
    visible.insert("diet_label".into(), json!(beast_diet_label(diet.as_ref())));
    visible.insert("stage_label".into(), json!(beast_stage_label(stage.as_ref())));
    Some(Value::Object(visible))
}

/// `beastsForViewer(state, viewer)`: реестр глазами отряда, кандидаты с
/// объявленной СЛ и досягаемостью по героям, спутники с поводом отказа.
pub fn beasts_for_viewer(state: &Value, viewer: &Value) -> Value {
    let beasts = beast_list(state);
    let minutes = json!(safe_minutes(campaign_elapsed_minutes(state)));
    let candidates: Vec<Value> = tameable_beasts(state)
        .into_iter()
        .map(|entry| {
            let enemy = Some(&entry.enemy);
            let policy = beast_taming_policy(state, enemy, entry.beast.as_ref());
            let reach = beast_reach_by_hero(state, get(enemy, "id"));
            let mut candidate = Map::new();
            let id = entry.beast.as_ref().and_then(|beast| beast.get("id").cloned()).filter(|id| !id.is_null()).unwrap_or_else(|| json!(beast_id_for(state, get(enemy, "id"))));
            candidate.insert("id".into(), id);
            candidate.insert("actor_id".into(), json!(js::s(get(enemy, "id"))));
            candidate.insert("name".into(), json!(text(get(enemy, "name"), 160)));
            if let Some(diet) = &policy.diet {
                candidate.insert("diet".into(), diet.clone());
            }
            candidate.insert("diet_label".into(), json!(beast_diet_label(Some(&diet_key(policy.diet.as_ref())))));
            candidate.insert("stage".into(), json!(policy.stage));
            candidate.insert("stage_label".into(), json!(beast_stage_label(Some(&json!(policy.stage)))));
            candidate.insert("wounded".into(), json!(policy.wounded));
            candidate.insert("broken_morale".into(), json!(policy.broken_morale));
            candidate.insert("difficulty".into(), json!(policy.difficulty));
            candidate.insert("skill".into(), json!(BEAST_TAMING_SKILL));
            candidate.insert("ability".into(), json!(BEAST_TAMING_ABILITY));
            candidate.insert("attempts".into(), json!(policy.attempts));
            candidate.insert("bites_on_failure".into(), json!(policy.bites_on_failure));
            candidate.insert("parts".into(), Value::Array(policy.parts.iter().map(DcPart::to_json).collect()));
            candidate.insert("reach_by_hero".into(), Value::Object(reach));
            candidate.insert("reach_feet".into(), json!(BEAST_APPROACH_REACH_FEET));
            if let Some(reason) = entry.blocked_reason {
                candidate.insert("blocked_reason".into(), json!(reason));
            }
            Value::Object(candidate)
        })
        .collect();
    let combat = js::is_true(get(get(get(Some(state), "mechanics"), "combat"), "active"));
    let companions: Vec<Value> = beast_companions(state)
        .iter()
        .map(|beast| {
            let cooldown = beast_scare_cooldown_left(Some(beast), Some(&minutes));
            let reason = if combat {
                Some("combat_active")
            } else if cooldown > 0 {
                Some("scare_cooldown")
            } else {
                None
            };
            let mut companion = Map::new();
            companion.insert("id".into(), beast["id"].clone());
            companion.insert("name".into(), beast["name"].clone());
            companion.insert("scare_cooldown_minutes".into(), json!(cooldown));
            if let Some(reason) = reason {
                companion.insert("blocked_reason".into(), json!(reason));
            }
            Value::Object(companion)
        })
        .collect();
    let watch_advantage = beast_watch_companion(state).is_some();
    let visible: Vec<Value> = if js::is_true(get(Some(viewer), "isAdmin")) { beasts } else { beasts.iter().filter_map(|beast| beast_for_viewer(Some(beast))).collect() };
    json!({
        "schema_version": BEAST_TAMING_SCHEMA_VERSION,
        "beasts": visible,
        "candidates": candidates,
        "companions": companions,
        "watch_advantage": watch_advantage,
    })
}

/// `beastChronicleEntry(event)`: карточка летописи для трёх ступеней лестницы.
pub fn beast_chronicle_entry(event: &Value) -> Option<Value> {
    let kind = js::s(event.get("event_type"));
    let empty = json!({});
    let payload = coalesce(event.get("payload"), Some(&empty));
    let beast_id = text(get(payload, "beast_id"), 140);
    let name = text(get(payload, "beast_name"), 120);
    let name = if name.is_empty() { "Зверь".to_string() } else { name };
    if beast_id.is_empty() {
        return None;
    }
    let (card, title, body) = if kind == "BeastSoothingResolved" && js::is_true(get(payload, "success")) && get(payload, "stage_after").and_then(Value::as_str) == Some("calmed") {
        ("calmed", "Зверь подпустил", format!("{name} перестал видеть в отряде добычу. Теперь ему нужна еда с руки — без неё дальше не будет."))
    } else if kind == "BeastFed" {
        let food = text(get(payload, "item_name"), 120);
        ("fed", "Зверь ест с руки", format!("{name} берёт {} с ладони. Осталось последнее: позвать его с собой.", if food.is_empty() { "еду" } else { &food }))
    } else if kind == "BeastTamed" {
        ("tamed", "Зверь идёт с отрядом", format!("{name} остаётся рядом. Он держит стражу у костра и отгоняет мелкое зверьё, но в строй не встаёт: боевого спутника у отряда нет."))
    } else {
        return None;
    };
    let mut beast = Map::new();
    beast.insert("kind".into(), json!(card));
    beast.insert("title".into(), json!(title));
    beast.insert("name".into(), json!(name));
    if let Some(label) = beast_diet_label_value(get(payload, "diet")) {
        beast.insert("diet_label".into(), label);
    }
    beast.insert("text".into(), json!(body));
    Some(json!({
        "id": format!("chronicle:{beast_id}:{card}"),
        "speaker": "system",
        "author": BEAST_CARD_TITLE,
        "text": body,
        "beast": Value::Object(beast),
    }))
}

// ---------------------------------------------------------------------------
// Редьюсер
// ---------------------------------------------------------------------------

/// `value + 1` по правилам JS для счётчика сырой записи (быстрый путь
/// редьюсера берёт срез как есть): строка склеивается, `undefined` даёт `NaN`.
fn js_plus_one(value: Option<&Value>) -> Value {
    match value {
        None => Value::Null,
        Some(Value::Null) => json!(1),
        Some(Value::Bool(flag)) => json!(i64::from(*flag) + 1),
        Some(Value::Number(number)) => js::num(number.as_f64().unwrap_or(f64::NAN) + 1.0),
        Some(Value::String(text)) => json!(format!("{text}1")),
        Some(other) => json!(format!("{}1", js::s(Some(other)))),
    }
}

/// `Math.max(0, integer(payload.at_minutes, campaignElapsedMinutes(state)))`,
/// уже прошедшее через `safeBeast` — дробное и бесконечное становится нулём.
fn event_minutes(payload: Option<&Value>, state: &Value) -> Value {
    let at = get(payload, "at_minutes");
    let minutes = if js::is_safe_integer_number(at) { js::number(at) } else { campaign_elapsed_minutes(state) };
    json!(0.max(safe_minutes(js_max(0.0, minutes))))
}

/// `applyBeastEvent(input, event, state)`: редьюсер реестра; `state` — уже
/// применённое состояние, из него берётся время кампании.
pub fn apply_beast_event(input: Option<&Value>, event: &Value, state: &Value) -> Value {
    let kind = js::s(event.get("event_type"));
    let empty = json!({});
    let payload = coalesce(event.get("payload"), Some(&empty));
    let fast = input.filter(|raw| raw.get("schema_version").and_then(Value::as_f64) == Some(BEAST_TAMING_SCHEMA_VERSION as f64) && matches!(raw.get("beasts"), Some(Value::Array(_))));
    let normalized: Value = fast.cloned().unwrap_or_else(|| normalize_beast_state(input));
    let beasts: Vec<Value> = array(normalized.get("beasts")).to_vec();
    let rebuild = |beasts: Vec<Value>| {
        let mut source = spread(Some(&normalized));
        source.insert("beasts".into(), Value::Array(beasts));
        normalize_beast_state(Some(&Value::Object(source)))
    };
    let patch = |beast_id: Option<&Value>, update: &dyn Fn(&Value) -> Value| -> Value {
        let expected = text(beast_id, 120);
        if expected.is_empty() {
            return normalized.clone();
        }
        rebuild(beasts.iter().map(|beast| if beast.get("id").and_then(Value::as_str) == Some(expected.as_str()) { update(beast) } else { beast.clone() }).collect())
    };
    let with = |beast: &Value, fields: Value| js::spread(beast, fields);
    match kind.as_str() {
        "BeastEncountered" => {
            let Some(beast) = safe_beast(get(payload, "beast")) else { return normalized };
            if beasts.iter().any(|entry| entry.get("id") == beast.get("id")) {
                return normalized;
            }
            let mut next = beasts.clone();
            next.push(beast);
            rebuild(next)
        }
        "BeastSoothingResolved" => patch(get(payload, "beast_id"), &|beast| {
            if js::is_true(get(payload, "success")) {
                let stage = one_of(get(payload, "stage_after"), &BEAST_STAGES).map_or_else(|| beast.get("stage").cloned().unwrap_or(Value::Null), Value::String);
                let calmed = if get(payload, "stage_after").and_then(Value::as_str) == Some("calmed") { event_minutes(payload, state) } else { beast.get("calmed_at_minutes").cloned().unwrap_or(Value::Null) };
                let mut fields = Map::new();
                fields.insert("stage".into(), stage);
                // Успех обнуляет счётчик настороженности.
                fields.insert("attempts".into(), json!(0));
                fields.insert("calmed_at_minutes".into(), calmed);
                with(beast, Value::Object(fields))
            } else {
                with(beast, json!({ "attempts": js_plus_one(beast.get("attempts")) }))
            }
        }),
        "BeastBit" => patch(get(payload, "beast_id"), &|beast| with(beast, json!({ "bites": js_plus_one(beast.get("bites")) }))),
        "BeastFed" => patch(get(payload, "beast_id"), &|beast| with(beast, json!({ "stage": "fed", "fed_at_minutes": event_minutes(payload, state) }))),
        "BeastTamed" => patch(get(payload, "beast_id"), &|beast| with(beast, json!({ "stage": "tamed", "status": "companion", "tamed_at_minutes": event_minutes(payload, state) }))),
        "BeastMoved" => patch(get(payload, "beast_id"), &|beast| with(beast, json!({ "location_id": text(get(payload, "location_id"), 180), "location_name": text(get(payload, "location_name"), 180) }))),
        "BeastScaredThreat" => patch(get(payload, "beast_id"), &|beast| with(beast, json!({ "scared_at_minutes": event_minutes(payload, state) }))),
        _ => normalized,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenge_rating_reads_fractions_and_plain_numbers() {
        assert_eq!(beast_challenge_rating(Some(&json!({ "provenance": { "challenge_rating": "1/4" } }))), 0.25);
        assert_eq!(beast_challenge_rating(Some(&json!({ "challenge_rating": "2" }))), 2.0);
        assert_eq!(beast_challenge_rating(Some(&json!({ "challenge_rating": "1/0" }))), 0.0);
        assert_eq!(beast_challenge_rating(Some(&json!({ "challenge_rating": "-3" }))), 0.0);
        assert_eq!(beast_challenge_dc_shift(Some(&json!(0.25))), 0);
        assert_eq!(beast_challenge_dc_shift(Some(&json!(4))), 9);
        assert_eq!(beast_bite_damage(Some(&json!("x"))), "1d4");
    }

    #[test]
    fn prototype_stat_block_is_not_tameable() {
        assert_eq!(beast_diet_for(Some(&json!({ "creature_type": "Beast", "stat_block_id": "srd_5_2_1:wolf" }))), Some(BeastDiet::Predator));
        assert_eq!(beast_diet_for(Some(&json!({ "creature_type": "beast", "stat_block_id": "constructor" }))), None);
        assert_eq!(beast_diet_for(Some(&json!({ "creature_type": "beast", "stat_block_id": "srd_5_2_1:giant-spider" }))), None);
        assert_eq!(beast_diet_label_value(Some(&json!("toString"))), Some(json!("")));
        assert_eq!(beast_diet_label(Some(&json!("herbivore"))), "травоядный");
    }
}

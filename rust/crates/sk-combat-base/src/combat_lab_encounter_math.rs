//! Перенос `server/combat-lab-encounter-math.mjs`: сложность боевой сцены по
//! Basic Rules 2014 — пороги опыта группы, множитель числа противников с
//! поправкой на размер отряда и детерминированный подбор состава по seed.
//!
//! Модуль не знает о состоянии кампании. Записи существ — JSON статблоков
//! (`id`, `xp`, `challenge_rating`), уровни группы — значения JSON, как их
//! передаёт JS (`level` может прийти строкой). Отказ — `TypeError` JS, здесь
//! [`EncounterMathError`] с тем же текстом. Верхняя граница интервала
//! «смертельной» сложности — `f64::INFINITY`, как `Number.POSITIVE_INFINITY`;
//! в JSON она, как у `JSON.stringify`, становится `null`.

use std::fmt;

use serde_json::{json, Value};
use sk_core::indexmap::IndexMap;
use sk_core::{js, text};

use crate::jsv::string_of;

/// `COMBAT_LAB_ENCOUNTER_DIFFICULTIES`.
pub const COMBAT_LAB_ENCOUNTER_DIFFICULTIES: [&str; 4] = ["easy", "medium", "hard", "deadly"];

/// Пороги опыта одного героя или суммы группы.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Thresholds {
    pub easy: i64,
    pub medium: i64,
    pub hard: i64,
    pub deadly: i64,
}

impl Thresholds {
    const fn new(easy: i64, medium: i64, hard: i64, deadly: i64) -> Self {
        Self { easy, medium, hard, deadly }
    }

    /// Порог по названию сложности.
    pub fn get(&self, difficulty: &str) -> Option<i64> {
        match difficulty {
            "easy" => Some(self.easy),
            "medium" => Some(self.medium),
            "hard" => Some(self.hard),
            "deadly" => Some(self.deadly),
            _ => None,
        }
    }

    pub fn to_json(&self) -> Value {
        json!({ "easy": self.easy, "medium": self.medium, "hard": self.hard, "deadly": self.deadly })
    }
}

/// `COMBAT_LAB_XP_THRESHOLDS_2014`: строка `[уровень − 1]`.
pub const COMBAT_LAB_XP_THRESHOLDS_2014: [Thresholds; 20] = [
    Thresholds::new(25, 50, 75, 100),
    Thresholds::new(50, 100, 150, 200),
    Thresholds::new(75, 150, 225, 400),
    Thresholds::new(125, 250, 375, 500),
    Thresholds::new(250, 500, 750, 1_100),
    Thresholds::new(300, 600, 900, 1_400),
    Thresholds::new(350, 750, 1_100, 1_700),
    Thresholds::new(450, 900, 1_400, 2_100),
    Thresholds::new(550, 1_100, 1_600, 2_400),
    Thresholds::new(600, 1_200, 1_900, 2_800),
    Thresholds::new(800, 1_600, 2_400, 3_600),
    Thresholds::new(1_000, 2_000, 3_000, 4_500),
    Thresholds::new(1_100, 2_200, 3_400, 5_100),
    Thresholds::new(1_250, 2_500, 3_800, 5_700),
    Thresholds::new(1_400, 2_800, 4_300, 6_400),
    Thresholds::new(1_600, 3_200, 4_800, 7_200),
    Thresholds::new(2_000, 3_900, 5_900, 8_800),
    Thresholds::new(2_100, 4_200, 6_300, 9_500),
    Thresholds::new(2_400, 4_900, 7_300, 10_900),
    Thresholds::new(2_800, 5_700, 8_500, 12_700),
];

/// `COMBAT_LAB_XP_THRESHOLDS_2014` в форме JS: `{ "1": { easy, … }, … }`.
pub fn xp_thresholds_2014_json() -> Value {
    let mut table = serde_json::Map::new();
    for (index, row) in COMBAT_LAB_XP_THRESHOLDS_2014.iter().enumerate() {
        table.insert((index + 1).to_string(), row.to_json());
    }
    Value::Object(table)
}

// (максимум противников, множитель)
const MULTIPLIER_RANGES: [(f64, f64); 6] = [(1.0, 1.0), (2.0, 1.5), (6.0, 2.0), (10.0, 2.5), (14.0, 3.0), (f64::INFINITY, 4.0)];

/// Источник правил (`COMBAT_LAB_RULES_SOURCE_2014`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RulesSource {
    pub title: &'static str,
    pub url: &'static str,
    pub dndsu_url: &'static str,
    pub edition: &'static str,
}

/// `COMBAT_LAB_RULES_SOURCE_2014`.
pub const COMBAT_LAB_RULES_SOURCE_2014: RulesSource = RulesSource {
    title: "D&D Basic Rules 2014 — Building Combat Encounters",
    url: "https://www.dndbeyond.com/sources/dnd/basic-rules-2014/building-combat-encounters",
    dndsu_url: "https://dnd.su/articles/mechanics/119-combat-encounter-difficulty/",
    edition: "2014",
};

/// Отказ расчёта (`TypeError` в JS).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncounterMathError(pub String);

impl fmt::Display for EncounterMathError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for EncounterMathError {}

type Result<T> = std::result::Result<T, EncounterMathError>;

fn fail<T>(message: &str) -> Result<T> {
    Err(EncounterMathError(message.to_string()))
}

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn is_safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER
}

fn clamp_integer(value: f64, minimum: f64, maximum: f64) -> Option<f64> {
    is_safe_integer(value).then(|| minimum.max(maximum.min(value)))
}

/// `Number(value) || 0`.
fn number_or_zero(value: Option<&Value>) -> f64 {
    let number = js::number(value);
    if number.is_nan() {
        0.0
    } else {
        number
    }
}

/// `challengeRatingValue(value)`: числовая ПО (`1/4` → 0.25) или `None`.
pub fn challenge_rating_value(value: Option<&Value>) -> Option<f64> {
    let source = js::s(value);
    let text = text::trim(&source);
    if text.is_empty() {
        return None;
    }
    if text.contains('/') {
        let mut parts = text.split('/').map(js::parse_number);
        let numerator = parts.next().unwrap_or(f64::NAN);
        let denominator = parts.next().unwrap_or(f64::NAN);
        if numerator.is_finite() && denominator.is_finite() && denominator > 0.0 {
            return Some(numerator / denominator);
        }
    }
    let number = js::parse_number(text);
    number.is_finite().then_some(number)
}

fn base_multiplier_index(monster_count: f64) -> Option<usize> {
    let count = if monster_count == 0.0 || monster_count.is_nan() { 1.0 } else { monster_count }.max(1.0);
    MULTIPLIER_RANGES.iter().position(|(maximum, _)| count <= *maximum)
}

/// `encounterMultiplier(monsterCount, partySize)`: множитель 2014, на строку
/// выше для 1–2 героев и на строку ниже для шести и более.
pub fn encounter_multiplier(monster_count: f64, party_size: f64) -> f64 {
    let count = clamp_integer(monster_count, 1.0, MAX_SAFE_INTEGER).unwrap_or(1.0);
    let size = clamp_integer(party_size, 1.0, MAX_SAFE_INTEGER).unwrap_or(1.0);
    let index = base_multiplier_index(count).map_or(-1, |index| index as i64);
    let offset = if size < 3.0 {
        1
    } else if size >= 6.0 {
        -1
    } else {
        0
    };
    let adjusted = index + offset;
    if adjusted < 0 {
        return 0.5;
    }
    if adjusted as usize >= MULTIPLIER_RANGES.len() {
        return if size < 3.0 {
            5.0
        } else if size >= 6.0 {
            3.0
        } else {
            4.0
        };
    }
    MULTIPLIER_RANGES[adjusted as usize].1
}

/// `partyThresholds2014(levels)`: сумма порогов группы с разными уровнями.
pub fn party_thresholds_2014(levels: &[Value]) -> Result<Thresholds> {
    if levels.is_empty() {
        return fail("levels must be a non-empty array");
    }
    let mut result = Thresholds::new(0, 0, 0, 0);
    for raw_level in levels {
        let number = js::number(Some(raw_level));
        let level = clamp_integer(number, 1.0, 20.0);
        let Some(level) = level.filter(|level| *level == number) else {
            return fail("character level must be an integer from 1 to 20");
        };
        let row = COMBAT_LAB_XP_THRESHOLDS_2014[level as usize - 1];
        result.easy += row.easy;
        result.medium += row.medium;
        result.hard += row.hard;
        result.deadly += row.deadly;
    }
    Ok(result)
}

fn difficulty_for_adjusted_xp(adjusted_xp: f64, thresholds: &Thresholds) -> &'static str {
    if adjusted_xp < thresholds.easy as f64 {
        "trivial"
    } else if adjusted_xp < thresholds.medium as f64 {
        "easy"
    } else if adjusted_xp < thresholds.hard as f64 {
        "medium"
    } else if adjusted_xp < thresholds.deadly as f64 {
        "hard"
    } else {
        "deadly"
    }
}

/// Интервал скорректированного опыта для сложности.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EncounterInterval {
    pub lower: f64,
    /// `f64::INFINITY` для «смертельной».
    pub upper: f64,
}

impl EncounterInterval {
    /// Форма `JSON.stringify`: бесконечность — `null`.
    pub fn to_json(&self) -> Value {
        json!({ "lower": js::num(self.lower), "upper": js::num(self.upper) })
    }
}

/// `encounterInterval(difficulty, thresholds)`.
pub fn encounter_interval(difficulty: &str, thresholds: &Thresholds) -> Result<EncounterInterval> {
    let Some(index) = COMBAT_LAB_ENCOUNTER_DIFFICULTIES.iter().position(|known| *known == difficulty) else {
        return fail("unknown encounter difficulty");
    };
    let lower = thresholds.get(difficulty).unwrap_or(0) as f64;
    let upper = match COMBAT_LAB_ENCOUNTER_DIFFICULTIES.get(index + 1) {
        Some(next) => thresholds.get(next).unwrap_or(0) as f64 - 1.0,
        None => f64::INFINITY,
    };
    Ok(EncounterInterval { lower, upper })
}

/// FNV-1a по кодовым точкам (`for (const character of String(value))`).
fn hash32(value: &str) -> u32 {
    let mut hash: i32 = 2_166_136_261_u32 as i32;
    for character in value.chars() {
        hash ^= character as i32;
        hash = hash.wrapping_mul(16_777_619);
    }
    hash as u32
}

/// Идентификатор записи в составе: строка шаблона (`${id}`) и признак
/// `undefined`, который `Array.prototype.sort` ставит в конец, а `join` пишет
/// пустой строкой.
#[derive(Debug, Clone)]
struct RosterId {
    /// `String(id)` для сортировки и `${id}`.
    text: String,
    /// `undefined` или `null` — в `join` пусто.
    nullish: bool,
    undefined: bool,
    /// Ключ `new Set(path)`: примитив по значению, объект — по записи.
    identity: String,
}

fn roster_id(record: &Value, index: usize) -> RosterId {
    let id = record.get("id");
    let identity = match id {
        None => "u".to_string(),
        Some(Value::Null) => "n".to_string(),
        Some(Value::Bool(flag)) => format!("b:{flag}"),
        Some(Value::Number(number)) => format!("#:{}", js::f64_string(number.as_f64().unwrap_or(f64::NAN))),
        Some(Value::String(text)) => format!("s:{text}"),
        Some(_) => format!("o:{index}"),
    };
    RosterId { text: string_of(id), nullish: !js::present(id), undefined: id.is_none(), identity }
}

fn roster_key(ids: &[&RosterId]) -> String {
    let mut sorted: Vec<&RosterId> = ids.to_vec();
    sorted.sort_by(|left, right| match (left.undefined, right.undefined) {
        (true, true) => std::cmp::Ordering::Equal,
        (true, false) => std::cmp::Ordering::Greater,
        (false, true) => std::cmp::Ordering::Less,
        (false, false) => compare_utf16(&left.text, &right.text),
    });
    sorted.iter().map(|id| if id.nullish { "" } else { id.text.as_str() }).collect::<Vec<_>>().join("|")
}

/// Сравнение строк по единицам UTF-16, как `sort()` без сравнителя.
fn compare_utf16(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn candidate_order(records: &[(usize, &Value)], seed: &str) -> Vec<(usize, Value)> {
    let mut keyed: Vec<(u32, String, usize, &Value)> = records
        .iter()
        .map(|(index, record)| {
            let id = string_of(record.get("id"));
            (hash32(&format!("{seed}:candidate:{id}")), id, *index, *record)
        })
        .collect();
    keyed.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| text::locale_compare(&left.1, &right.1)));
    keyed.into_iter().map(|(_, _, index, record)| (index, record.clone())).collect()
}

fn is_better_path(next: &[&RosterId], previous: Option<&Vec<usize>>, candidates: &[RosterId], seed: &str) -> bool {
    let Some(previous) = previous else {
        return true;
    };
    let previous: Vec<&RosterId> = previous.iter().map(|index| &candidates[*index]).collect();
    let next_key = roster_key(next);
    let previous_key = roster_key(&previous);
    hash32(&format!("{seed}:roster:{next_key}")) < hash32(&format!("{seed}:roster:{previous_key}")) || (next_key == previous_key && next.len() < previous.len())
}

fn score_less(left: &[f64], right: &[f64]) -> bool {
    for (a, b) in left.iter().zip(right) {
        if a < b {
            return true;
        }
        if a > b {
            return false;
        }
    }
    false
}

fn greatest_common_divisor(left: f64, right: f64) -> f64 {
    let mut a = if left.is_nan() { 0.0 } else { left.abs() };
    let mut b = if right.is_nan() { 0.0 } else { right.abs() };
    while b != 0.0 && !b.is_nan() {
        (a, b) = (b, a % b);
    }
    if a == 0.0 || a.is_nan() {
        1.0
    } else {
        a
    }
}

struct RosterStates {
    /// `states[quantity]`: потраченные единицы опыта → путь (индексы кандидатов).
    states: Vec<IndexMap<i64, Vec<usize>>>,
    xp_unit: f64,
}

fn build_roster_states(candidates: &[Value], ids: &[RosterId], maximum_count: f64, maximum_raw: f64, seed: &str) -> RosterStates {
    let gcd = candidates.iter().fold(0.0, |unit, record| greatest_common_divisor(unit, js::number(record.get("xp"))));
    let xp_unit = if gcd == 0.0 || gcd.is_nan() { 1.0 } else { gcd };
    let maximum_raw_units = (maximum_raw / xp_unit).floor();
    // `Array.from({ length: maximumCount + 1 })`: длина — ToLength.
    let length = (maximum_count + 1.0).max(0.0).floor() as usize;
    let mut states: Vec<IndexMap<i64, Vec<usize>>> = (0..length).map(|_| IndexMap::new()).collect();
    if let Some(first) = states.first_mut() {
        first.insert(0, Vec::new());
    }
    let indexed: Vec<(usize, &Value)> = candidates.iter().enumerate().collect();
    let ordered = candidate_order(&indexed, seed);
    let mut quantity = 0usize;
    while (quantity as f64) < maximum_count && quantity + 1 < states.len() {
        let current: Vec<(i64, Vec<usize>)> = states[quantity].iter().map(|(spent, path)| (*spent, path.clone())).collect();
        for (spent, path) in current {
            for (index, record) in &ordered {
                let xp = js::number(record.get("xp"));
                let xp_units = xp / xp_unit;
                let next_spent = spent as f64 + xp_units;
                if !is_safe_integer(xp) || xp <= 0.0 || !is_safe_integer(xp_units) || next_spent > maximum_raw_units {
                    continue;
                }
                let mut next_path = path.clone();
                next_path.push(*index);
                let next_ids: Vec<&RosterId> = next_path.iter().map(|index| &ids[*index]).collect();
                let key = next_spent as i64;
                if is_better_path(&next_ids, states[quantity + 1].get(&key), ids, seed) {
                    states[quantity + 1].insert(key, next_path);
                }
            }
        }
        quantity += 1;
    }
    RosterStates { states, xp_unit }
}

#[derive(Debug, Clone)]
struct Candidate {
    path: Vec<usize>,
    spent: f64,
    adjusted: f64,
    score: [f64; 4],
    tie: u32,
}

fn best_roster_for_count(states: &RosterStates, ids: &[RosterId], count: usize, multiplier: f64, interval: &EncounterInterval, seed: &str, target_adjusted: f64) -> Option<Candidate> {
    let mut best: Option<Candidate> = None;
    for (spent, path) in states.states.get(count)? {
        let raw_spent = *spent as f64 * states.xp_unit;
        let adjusted = raw_spent * multiplier;
        let distance = if adjusted < interval.lower {
            interval.lower - adjusted
        } else if adjusted > interval.upper {
            adjusted - interval.upper
        } else {
            (adjusted - target_adjusted).abs()
        };
        let in_interval = adjusted >= interval.lower && adjusted <= interval.upper;
        let path_ids: Vec<&RosterId> = path.iter().map(|index| &ids[*index]).collect();
        let distinct: std::collections::HashSet<&str> = path_ids.iter().map(|id| id.identity.as_str()).collect();
        let score = [if in_interval { 0.0 } else { 1.0 }, distance, (adjusted - target_adjusted).abs(), -(distinct.len() as f64)];
        let tie = hash32(&format!("{seed}:selection:{}", roster_key(&path_ids)));
        let better = match &best {
            None => true,
            Some(best) => score_less(&score, &best.score) || (score == best.score && tie < best.tie),
        };
        if better {
            best = Some(Candidate { path: path.clone(), spent: raw_spent, adjusted, score, tie });
        }
    }
    best
}

/// Запрос `selectEncounterRoster({ records, partyLevels, difficulty, seed, maximumCreatures })`.
#[derive(Debug, Clone, Copy)]
pub struct RosterRequest<'a> {
    pub records: &'a [Value],
    pub party_levels: &'a [Value],
    pub difficulty: &'a str,
    /// `None` — `'combat-lab'`; иначе `String(seed)`.
    pub seed: Option<&'a Value>,
    /// `None` — 12.
    pub maximum_creatures: Option<&'a Value>,
}

/// Подобранный состав.
#[derive(Debug, Clone, PartialEq)]
pub struct EncounterRoster {
    pub records: Vec<Value>,
    pub target_adjusted_xp: f64,
    pub raw_xp: f64,
    pub adjusted_xp: f64,
    pub multiplier: f64,
    pub thresholds: Thresholds,
    pub interval: EncounterInterval,
}

impl EncounterRoster {
    /// Форма JS (после `JSON.stringify`: бесконечность — `null`).
    pub fn to_json(&self) -> Value {
        json!({
            "records": self.records,
            "target_adjusted_xp": js::num(self.target_adjusted_xp),
            "raw_xp": js::num(self.raw_xp),
            "adjusted_xp": js::num(self.adjusted_xp),
            "multiplier": js::num(self.multiplier),
            "thresholds": self.thresholds.to_json(),
            "interval": self.interval.to_json(),
        })
    }
}

fn seed_text(seed: Option<&Value>) -> String {
    match seed {
        None => "combat-lab".to_string(),
        seed => string_of(seed),
    }
}

/// `selectEncounterRoster(...)`: ограниченный состав из записей существ по
/// сложности и seed. Перенос полей статблока в бой — забота модуля настройки.
pub fn select_encounter_roster(request: RosterRequest<'_>) -> Result<EncounterRoster> {
    if request.records.is_empty() {
        return fail("records must be a non-empty array");
    }
    if request.party_levels.is_empty() {
        return fail("partyLevels must be a non-empty array");
    }
    if !COMBAT_LAB_ENCOUNTER_DIFFICULTIES.contains(&request.difficulty) {
        return fail("unknown encounter difficulty");
    }
    let seed = seed_text(request.seed);
    let party_size = request.party_levels.len() as f64;
    let thresholds = party_thresholds_2014(request.party_levels)?;
    let interval = encounter_interval(request.difficulty, &thresholds)?;
    let max_party_level = js::max_of(request.party_levels.iter().map(|level| js::number(Some(level))));
    let max_challenge_rating = max_party_level.ceil().max(1.0);
    let suitable: Vec<(usize, &Value)> = request
        .records
        .iter()
        .enumerate()
        .filter(|(_, record)| js::number(record.get("xp")) > 0.0 && challenge_rating_value(record.get("challenge_rating")).unwrap_or(f64::INFINITY) <= max_challenge_rating)
        .collect();
    if suitable.is_empty() {
        return fail("no suitable monster records");
    }
    // Записи с одинаковым опытом взаимозаменяемы: представитель каждого
    // значения выбирается по seed.
    let mut candidates: Vec<Value> = Vec::new();
    for (_, record) in candidate_order(&suitable, &seed) {
        let xp = js::number(record.get("xp"));
        if !candidates.iter().any(|candidate| js::number(candidate.get("xp")) == xp) {
            candidates.push(record);
        }
    }
    let ids: Vec<RosterId> = candidates.iter().enumerate().map(|(index, record)| roster_id(record, index)).collect();
    let maximum = js::number(request.maximum_creatures.or(Some(&Value::from(12))));
    let maximum = if maximum == 0.0 || maximum.is_nan() { 12.0 } else { maximum };
    let cap = maximum.min(party_size * 2.0).max(1.0);
    let target_span = if interval.upper == f64::INFINITY { interval.lower.max(100.0) } else { interval.upper - interval.lower + 1.0 };
    let target_adjusted = interval.lower + f64::from(hash32(&format!("{seed}:target:{}", request.difficulty))) % target_span;

    let multiplier_count = cap.max(0.0).floor() as usize;
    let minimum_multiplier = js::min_of((0..multiplier_count).map(|index| encounter_multiplier(index as f64 + 1.0, party_size)));
    let maximum_xp = candidates.iter().fold(0.0_f64, |maximum, record| maximum.max(number_or_zero(record.get("xp"))));
    let maximum_raw = if interval.upper == f64::INFINITY {
        (target_adjusted / minimum_multiplier + maximum_xp).ceil()
    } else {
        (interval.upper / minimum_multiplier).floor().max((interval.lower / minimum_multiplier + maximum_xp).ceil())
    };
    let states = build_roster_states(&candidates, &ids, cap, maximum_raw, &seed);

    let mut best: Option<(Candidate, f64)> = None;
    let mut count = 1usize;
    while count as f64 <= cap {
        let multiplier = encounter_multiplier(count as f64, party_size);
        if let Some(mut candidate) = best_roster_for_count(&states, &ids, count, multiplier, &interval, &seed, target_adjusted) {
            let path_ids: Vec<&RosterId> = candidate.path.iter().map(|index| &ids[*index]).collect();
            candidate.score = [candidate.score[0], candidate.score[1], (candidate.adjusted - target_adjusted).abs(), (count as f64 - party_size.min(4.0)).abs()];
            candidate.tie = hash32(&format!("{seed}:count:{}", roster_key(&path_ids)));
            let better = match &best {
                None => true,
                Some((best, _)) => score_less(&candidate.score, &best.score) || (candidate.score == best.score && candidate.tie < best.tie),
            };
            if better {
                best = Some((candidate, multiplier));
            }
        }
        count += 1;
    }
    let Some((best, multiplier)) = best else {
        return fail("no roster fits the encounter bounds");
    };
    // `byId` по `String(id)`: при повторе id побеждает последняя запись.
    let mut by_id: IndexMap<&str, &Value> = IndexMap::new();
    for (index, record) in candidates.iter().enumerate() {
        by_id.insert(ids[index].text.as_str(), record);
    }
    Ok(EncounterRoster {
        records: best.path.iter().map(|index| by_id.get(ids[*index].text.as_str()).map_or(Value::Null, |record| (*record).clone())).collect(),
        target_adjusted_xp: target_adjusted,
        raw_xp: best.spent,
        adjusted_xp: best.adjusted,
        multiplier,
        thresholds,
        interval,
    })
}

/// Запрос `assessEncounterRoster({ records, partyLevels, difficulty, seed })`.
#[derive(Debug, Clone, Copy)]
pub struct AssessmentRequest<'a> {
    pub records: &'a [Value],
    pub party_levels: &'a [Value],
    pub difficulty: &'a str,
    /// `None` — `'combat-lab'`.
    pub seed: Option<&'a Value>,
}

/// `assessEncounterRoster(...)`: сложность фактического состава. Ответ — JSON
/// той же формы, что в JS (`difficulty`, `rawXp`, `adjustedXp`, …).
pub fn assess_encounter_roster(request: AssessmentRequest<'_>) -> Result<Value> {
    if !COMBAT_LAB_ENCOUNTER_DIFFICULTIES.contains(&request.difficulty) {
        return fail("unknown encounter difficulty");
    }
    let thresholds = party_thresholds_2014(request.party_levels)?;
    let raw_xp = request.records.iter().fold(0.0, |sum, record| sum + number_or_zero(record.get("xp")));
    let multiplier = if request.records.is_empty() { 1.0 } else { encounter_multiplier(request.records.len() as f64, request.party_levels.len() as f64) };
    let adjusted_xp = raw_xp * multiplier;
    let interval = encounter_interval(request.difficulty, &thresholds)?;
    Ok(json!({
        "difficulty": difficulty_for_adjusted_xp(adjusted_xp, &thresholds),
        "requestedDifficulty": request.difficulty,
        "rawXp": js::num(raw_xp),
        "adjustedXp": js::num(adjusted_xp),
        "multiplier": js::num(multiplier),
        "thresholds": thresholds.to_json(),
        "partyLevels": request.party_levels,
        "monsterCount": request.records.len(),
        "matched": !request.records.is_empty() && adjusted_xp >= interval.lower && adjusted_xp <= interval.upper,
        "seed": seed_text(request.seed),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thresholds_and_party_size_multiplier_follow_the_published_rules() {
        let levels = [json!(3), json!(3), json!(3), json!(2)];
        assert_eq!(party_thresholds_2014(&levels).expect("пороги"), Thresholds::new(275, 550, 825, 1_400));
        assert_eq!(encounter_multiplier(1.0, 2.0), 1.5);
        assert_eq!(encounter_multiplier(2.0, 2.0), 2.0);
        assert_eq!(encounter_multiplier(4.0, 4.0), 2.0);
        assert_eq!(encounter_multiplier(1.0, 6.0), 0.5);
        assert_eq!(encounter_multiplier(4.0, 6.0), 1.5);
        assert_eq!(encounter_multiplier(15.0, 1.0), 5.0);
        assert_eq!(COMBAT_LAB_RULES_SOURCE_2014.edition, "2014");
    }

    #[test]
    fn challenge_rating_parses_fractions() {
        assert_eq!(challenge_rating_value(Some(&json!("1/4"))), Some(0.25));
        assert_eq!(challenge_rating_value(Some(&json!(" 3 "))), Some(3.0));
        assert_eq!(challenge_rating_value(Some(&json!("1/0"))), None);
        assert_eq!(challenge_rating_value(Some(&json!(""))), None);
        assert_eq!(challenge_rating_value(None), None);
        assert_eq!(challenge_rating_value(Some(&json!("/4"))), Some(0.0));
    }

    #[test]
    fn errors_follow_js() {
        assert_eq!(party_thresholds_2014(&[]), Err(EncounterMathError("levels must be a non-empty array".into())));
        assert_eq!(party_thresholds_2014(&[json!(2.5)]), Err(EncounterMathError("character level must be an integer from 1 to 20".into())));
        assert_eq!(party_thresholds_2014(&[json!("3")]).expect("строка").easy, 75);
        assert_eq!(encounter_interval("trivial", &Thresholds::new(1, 2, 3, 4)), Err(EncounterMathError("unknown encounter difficulty".into())));
        let deadly = encounter_interval("deadly", &Thresholds::new(1, 2, 3, 4)).expect("интервал");
        assert_eq!(deadly.to_json(), json!({ "lower": 4, "upper": null }));
    }
}

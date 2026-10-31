//! Все броски «Сказания» — перенос `server/dice-service.mjs`.
//!
//! Правила, которые держит крейт:
//! - вся случайность идёт через [`Dice`]; правила игры не создают генератор сами,
//!   поэтому тесты и сверка с корпусом внедряют детерминированный источник;
//! - форма результата ([`Roll`]) совпадает с JSON прежнего движка: события
//!   `DieRolled` и стенограммы бросков читаются без перевода;
//! - [`TranscriptDice`] повторяет записанные броски по порядку и отказывает,
//!   если правило просит другой бросок, — так ловится расхождение порядка бросков.

use serde::{Deserialize, Serialize};

/// Ошибка броска. Код совпадает с кодом отказа прежнего движка там, где он был.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DiceError {
    /// Неверное выражение или модификатор (`DiceExpressionError`).
    #[error("{0}")]
    Expression(String),
    /// Значение генератора вне диапазона или кончилась тестовая последовательность.
    #[error("{0}")]
    Range(String),
    /// Повтор по стенограмме разошёлся с тем, что просит правило.
    #[error("Сохранённая последовательность бросков повреждена: {0}")]
    Transcript(String),
}

impl DiceError {
    /// Код отказа, как его видит клиент.
    pub fn code(&self) -> &'static str {
        match self {
            DiceError::Expression(_) => "DICE_EXPRESSION_INVALID",
            DiceError::Range(_) => "DICE_RANGE_INVALID",
            DiceError::Transcript(_) => "INVALID_DICE_TRANSCRIPT",
        }
    }
}

/// Источник целых чисел в замкнутом диапазоне.
pub trait Rng {
    fn randint(&mut self, minimum: i64, maximum: i64) -> Result<i64, DiceError>;
}

/// Системный криптостойкий источник — для настоящей игры.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemRng;

impl Rng for SystemRng {
    fn randint(&mut self, minimum: i64, maximum: i64) -> Result<i64, DiceError> {
        if maximum < minimum {
            return Err(DiceError::Range("Некорректный диапазон генератора случайных чисел".into()));
        }
        use rand::Rng as _;
        Ok(rand::rng().random_range(minimum..=maximum))
    }
}

/// Заранее заданная последовательность — для тестов.
#[derive(Debug, Clone)]
pub struct SequenceRng {
    values: Vec<i64>,
    index: usize,
}

impl SequenceRng {
    pub fn new(values: impl Into<Vec<i64>>) -> Self {
        Self { values: values.into(), index: 0 }
    }

    /// Сколько значений ещё не взято.
    pub fn remaining(&self) -> usize {
        self.values.len().saturating_sub(self.index)
    }
}

impl Rng for SequenceRng {
    fn randint(&mut self, minimum: i64, maximum: i64) -> Result<i64, DiceError> {
        let Some(&value) = self.values.get(self.index) else {
            return Err(DiceError::Range("Тестовая последовательность бросков закончилась".into()));
        };
        self.index += 1;
        if value < minimum || value > maximum {
            return Err(DiceError::Range(format!("Тестовое значение {value} не входит в диапазон {minimum}..{maximum}")));
        }
        Ok(value)
    }
}

/// Одно и то же значение на каждой кости, прижатое к грани: `FixedRng(15)` даёт
/// 15 на d20 и 6 на d6 (как `fixedDice` в `test/kit/dice.mjs`).
#[derive(Debug, Clone, Copy)]
pub struct FixedRng(pub i64);

impl Rng for FixedRng {
    fn randint(&mut self, minimum: i64, maximum: i64) -> Result<i64, DiceError> {
        Ok(self.0.clamp(minimum, maximum))
    }
}

/// Кто видит бросок.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Visibility {
    #[default]
    Public,
    Party,
    SpecificPlayer,
    GmOnly,
    NpcPrivate,
}

impl Visibility {
    /// Как прежний движок: неизвестное значение становится публичным.
    pub fn parse_lenient(value: &str) -> Self {
        match value {
            "party" => Visibility::Party,
            "specific_player" => Visibility::SpecificPlayer,
            "gm_only" => Visibility::GmOnly,
            "npc_private" => Visibility::NpcPrivate,
            _ => Visibility::Public,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Visibility::Public => "public",
            Visibility::Party => "party",
            Visibility::SpecificPlayer => "specific_player",
            Visibility::GmOnly => "gm_only",
            Visibility::NpcPrivate => "npc_private",
        }
    }
}

/// Режим d20.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RollMode {
    Normal,
    Advantage,
    Disadvantage,
}

impl RollMode {
    pub fn from_flags(advantage: bool, disadvantage: bool) -> Self {
        match (advantage, disadvantage) {
            (true, false) => RollMode::Advantage,
            (false, true) => RollMode::Disadvantage,
            _ => RollMode::Normal,
        }
    }
}

/// Результат броска в форме события `DieRolled` прежнего движка.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Roll {
    pub roll_id: String,
    pub expression: String,
    pub dice: Vec<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kept: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<RollMode>,
    pub modifier: i64,
    pub total: i64,
    pub purpose: String,
    pub actor_id: Option<String>,
    pub visibility: Visibility,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub difficulty: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub success: Option<bool>,
}

/// Разобранное выражение `NdS±M`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiceExpression {
    pub count: u32,
    pub sides: u32,
    pub modifier: i64,
    pub canonical: String,
}

/// Разбор `NdS±M`, как `parseDiceExpression`: пробелы и регистр не важны,
/// костей 1–100, граней 2–1000, модификатор до 10 000 по модулю.
pub fn parse_dice_expression(expression: &str) -> Result<DiceExpression, DiceError> {
    let compact: String = expression.to_lowercase().chars().filter(|c| !c.is_whitespace()).collect();
    let format_error = || DiceError::Expression("Поддерживается формат NdS, например 1d20+5".into());
    let (count_part, rest) = compact.split_once('d').ok_or_else(format_error)?;
    if count_part.len() > 3 || !count_part.chars().all(|c| c.is_ascii_digit()) {
        return Err(format_error());
    }
    let sign_index = rest.find(['+', '-']);
    let (sides_part, modifier_part) = match sign_index {
        Some(index) => (&rest[..index], Some(&rest[index..])),
        None => (rest, None),
    };
    if sides_part.is_empty() || sides_part.len() > 4 || !sides_part.chars().all(|c| c.is_ascii_digit()) {
        return Err(format_error());
    }
    if let Some(part) = modifier_part {
        let digits = &part[1..];
        if digits.is_empty() || digits.len() > 5 || !digits.chars().all(|c| c.is_ascii_digit()) {
            return Err(format_error());
        }
    }
    let count: u32 = if count_part.is_empty() { 1 } else { count_part.parse().map_err(|_| format_error())? };
    let sides: u32 = sides_part.parse().map_err(|_| format_error())?;
    let modifier: i64 = match modifier_part {
        Some(part) => part.parse().map_err(|_| format_error())?,
        None => 0,
    };
    if !(1..=100).contains(&count) {
        return Err(DiceError::Expression("Количество костей должно быть от 1 до 100".into()));
    }
    if !(2..=1000).contains(&sides) {
        return Err(DiceError::Expression("Количество граней должно быть от 2 до 1000".into()));
    }
    if modifier.abs() > 10_000 {
        return Err(DiceError::Expression("Модификатор слишком велик".into()));
    }
    let canonical = format!("{count}d{sides}{}", signed_suffix(modifier));
    Ok(DiceExpression { count, sides, modifier, canonical })
}

fn signed_suffix(modifier: i64) -> String {
    match modifier.signum() {
        1 => format!("+{modifier}"),
        -1 => modifier.to_string(),
        _ => String::new(),
    }
}

fn truncate(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

/// Запрос d20: модификатор, назначение, чей бросок, видимость, преимущество.
#[derive(Debug, Clone)]
pub struct D20Request {
    pub modifier: i64,
    pub purpose: String,
    pub actor_id: Option<String>,
    pub visibility: Visibility,
    pub advantage: bool,
    pub disadvantage: bool,
}

impl Default for D20Request {
    fn default() -> Self {
        Self { modifier: 0, purpose: "check".into(), actor_id: None, visibility: Visibility::Public, advantage: false, disadvantage: false }
    }
}

impl D20Request {
    pub fn new(purpose: impl Into<String>, modifier: i64) -> Self {
        Self { modifier, purpose: purpose.into(), ..Self::default() }
    }

    pub fn actor(mut self, actor_id: impl Into<String>) -> Self {
        self.actor_id = Some(actor_id.into());
        self
    }

    pub fn advantage(mut self, advantage: bool) -> Self {
        self.advantage = advantage;
        self
    }

    pub fn disadvantage(mut self, disadvantage: bool) -> Self {
        self.disadvantage = disadvantage;
        self
    }

    pub fn visibility(mut self, visibility: Visibility) -> Self {
        self.visibility = visibility;
        self
    }

    pub fn mode(&self) -> RollMode {
        RollMode::from_flags(self.advantage, self.disadvantage)
    }
}

/// Вся случайность игры.
pub trait Dice {
    /// Бросок выражения `NdS±M`.
    fn roll(&mut self, expression: &str, purpose: &str, actor_id: Option<&str>, visibility: Visibility) -> Result<Roll, DiceError>;
    /// d20 с преимуществом или помехой.
    fn roll_d20(&mut self, request: &D20Request) -> Result<Roll, DiceError>;
    /// d20 против сложности: результат с `difficulty` и `success`.
    fn roll_check(&mut self, request: &D20Request, difficulty: i64) -> Result<Roll, DiceError>;
}

/// Генератор идентификаторов и времени — внедряемые, чтобы тесты были детерминированы.
pub type IdFactory = Box<dyn FnMut() -> String + Send>;
pub type Clock = Box<dyn FnMut() -> String + Send>;

/// Сервис костей поверх источника чисел.
pub struct DiceService<R: Rng> {
    rng: R,
    ids: IdFactory,
    now: Clock,
}

impl DiceService<SystemRng> {
    /// Настоящая игра: системный генератор, UUID, текущее время.
    pub fn system() -> Self {
        Self::new(SystemRng, Box::new(|| uuid::Uuid::new_v4().to_string()), Box::new(system_now))
    }
}

impl<R: Rng> DiceService<R> {
    pub fn new(rng: R, ids: IdFactory, now: Clock) -> Self {
        Self { rng, ids, now }
    }

    /// Тестовый сервис: последовательные id `prefix-1`, `prefix-2`…, неподвижное время.
    pub fn deterministic(rng: R, prefix: &str) -> Self {
        let prefix = prefix.to_string();
        let mut counter = 0u64;
        Self::new(
            rng,
            Box::new(move || {
                counter += 1;
                format!("{prefix}-{counter}")
            }),
            Box::new(|| "2026-01-01T00:00:00.000Z".to_string()),
        )
    }

    pub fn rng(&self) -> &R {
        &self.rng
    }
}

impl<R: Rng> Dice for DiceService<R> {
    fn roll(&mut self, expression: &str, purpose: &str, actor_id: Option<&str>, visibility: Visibility) -> Result<Roll, DiceError> {
        let parsed = parse_dice_expression(expression)?;
        let mut dice = Vec::with_capacity(parsed.count as usize);
        for _ in 0..parsed.count {
            dice.push(self.rng.randint(1, i64::from(parsed.sides))?);
        }
        let total = dice.iter().sum::<i64>() + parsed.modifier;
        Ok(Roll {
            roll_id: (self.ids)(),
            expression: parsed.canonical,
            dice,
            kept: None,
            mode: None,
            modifier: parsed.modifier,
            total,
            purpose: truncate(if purpose.is_empty() { "unspecified" } else { purpose }, 80),
            actor_id: actor_id.map(|id| truncate(id, 120)),
            visibility,
            created_at: (self.now)(),
            difficulty: None,
            success: None,
        })
    }

    fn roll_d20(&mut self, request: &D20Request) -> Result<Roll, DiceError> {
        if request.modifier.abs() > 100 {
            return Err(DiceError::Expression("Некорректный модификатор d20".into()));
        }
        let mode = request.mode();
        let dice = match mode {
            RollMode::Normal => vec![self.rng.randint(1, 20)?],
            _ => vec![self.rng.randint(1, 20)?, self.rng.randint(1, 20)?],
        };
        let kept = match mode {
            RollMode::Advantage => *dice.iter().max().expect("две кости"),
            RollMode::Disadvantage => *dice.iter().min().expect("две кости"),
            RollMode::Normal => dice[0],
        };
        Ok(Roll {
            roll_id: (self.ids)(),
            expression: format!("{}d20{}", if mode == RollMode::Normal { 1 } else { 2 }, signed_suffix(request.modifier)),
            dice,
            kept: Some(kept),
            mode: Some(mode),
            modifier: request.modifier,
            total: kept + request.modifier,
            purpose: truncate(if request.purpose.is_empty() { "check" } else { &request.purpose }, 80),
            actor_id: request.actor_id.as_deref().map(|id| truncate(id, 120)),
            visibility: request.visibility,
            created_at: (self.now)(),
            difficulty: None,
            success: None,
        })
    }

    fn roll_check(&mut self, request: &D20Request, difficulty: i64) -> Result<Roll, DiceError> {
        if !(0..=100).contains(&difficulty) {
            return Err(DiceError::Expression("Некорректная сложность проверки".into()));
        }
        let mut roll = self.roll_d20(request)?;
        roll.success = Some(roll.total >= difficulty);
        roll.difficulty = Some(difficulty);
        Ok(roll)
    }
}

fn system_now() -> String {
    // RFC 3339 в UTC без внешних зависимостей: секунды эпохи → календарь.
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let seconds = now.as_secs() as i64;
    let millis = now.subsec_millis();
    let days = seconds.div_euclid(86_400);
    let rest = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z", rest / 3600, rest % 3600 / 60, rest % 60)
}

/// Дни от 1970-01-01 → (год, месяц, день); алгоритм Говарда Хиннанта.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Запись стенограммы: метод, аргументы, результат.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TranscriptEntry {
    pub method: String,
    #[serde(default)]
    pub args: serde_json::Value,
    pub result: Roll,
}

/// Повтор записанных бросков по порядку. Метод и выражение каждого броска
/// обязаны совпасть с записанными: иначе правило бросает не то, что прежний
/// движок, и сверка дальше бессмысленна.
#[derive(Debug, Clone)]
pub struct TranscriptDice {
    entries: Vec<TranscriptEntry>,
    index: usize,
}

impl TranscriptDice {
    pub fn new(entries: Vec<TranscriptEntry>) -> Self {
        Self { entries, index: 0 }
    }

    /// Сколько записанных бросков правило так и не попросило.
    pub fn unused(&self) -> usize {
        self.entries.len().saturating_sub(self.index)
    }

    fn next(&mut self, method: &str) -> Result<Roll, DiceError> {
        let Some(entry) = self.entries.get(self.index) else {
            return Err(DiceError::Transcript(format!("бросков больше, чем записано ({}), просили {method}", self.entries.len())));
        };
        if entry.method != method {
            return Err(DiceError::Transcript(format!("бросок {}: записан {}, просят {method}", self.index + 1, entry.method)));
        }
        self.index += 1;
        Ok(entry.result.clone())
    }
}

impl Dice for TranscriptDice {
    fn roll(&mut self, expression: &str, _purpose: &str, _actor_id: Option<&str>, _visibility: Visibility) -> Result<Roll, DiceError> {
        let index = self.index;
        let roll = self.next("roll")?;
        let asked = parse_dice_expression(expression)?.canonical;
        if roll.expression != asked {
            return Err(DiceError::Transcript(format!("бросок {}: записан {}, просят {asked}", index + 1, roll.expression)));
        }
        Ok(roll)
    }

    fn roll_d20(&mut self, request: &D20Request) -> Result<Roll, DiceError> {
        let index = self.index;
        let roll = self.next("rollD20")?;
        check_d20_shape(index, &roll, request)?;
        Ok(roll)
    }

    fn roll_check(&mut self, request: &D20Request, _difficulty: i64) -> Result<Roll, DiceError> {
        let index = self.index;
        let roll = self.next("rollCheck")?;
        check_d20_shape(index, &roll, request)?;
        Ok(roll)
    }
}

fn check_d20_shape(index: usize, roll: &Roll, request: &D20Request) -> Result<(), DiceError> {
    let asked = request.mode();
    if roll.mode.unwrap_or(RollMode::Normal) != asked {
        return Err(DiceError::Transcript(format!("бросок {}: записан d20 {:?}, просят {asked:?}", index + 1, roll.mode)));
    }
    if roll.modifier != request.modifier {
        return Err(DiceError::Transcript(format!("бросок {}: модификатор записан {}, просят {}", index + 1, roll.modifier, request.modifier)));
    }
    Ok(())
}

/// Обёртка, которая пишет стенограмму всех бросков.
pub struct RecordingDice<D: Dice> {
    inner: D,
    pub transcript: Vec<TranscriptEntry>,
}

impl<D: Dice> RecordingDice<D> {
    pub fn new(inner: D) -> Self {
        Self { inner, transcript: Vec::new() }
    }

    pub fn into_parts(self) -> (D, Vec<TranscriptEntry>) {
        (self.inner, self.transcript)
    }
}

impl<D: Dice> Dice for RecordingDice<D> {
    fn roll(&mut self, expression: &str, purpose: &str, actor_id: Option<&str>, visibility: Visibility) -> Result<Roll, DiceError> {
        let roll = self.inner.roll(expression, purpose, actor_id, visibility)?;
        self.transcript.push(TranscriptEntry {
            method: "roll".into(),
            args: serde_json::json!([expression, purpose, actor_id, visibility.as_str()]),
            result: roll.clone(),
        });
        Ok(roll)
    }

    fn roll_d20(&mut self, request: &D20Request) -> Result<Roll, DiceError> {
        let roll = self.inner.roll_d20(request)?;
        self.transcript.push(TranscriptEntry { method: "rollD20".into(), args: serde_json::Value::Null, result: roll.clone() });
        Ok(roll)
    }

    fn roll_check(&mut self, request: &D20Request, difficulty: i64) -> Result<Roll, DiceError> {
        let roll = self.inner.roll_check(request, difficulty)?;
        self.transcript.push(TranscriptEntry { method: "rollCheck".into(), args: serde_json::Value::Null, result: roll.clone() });
        Ok(roll)
    }
}

impl<D: Dice + ?Sized> Dice for &mut D {
    fn roll(&mut self, expression: &str, purpose: &str, actor_id: Option<&str>, visibility: Visibility) -> Result<Roll, DiceError> {
        (**self).roll(expression, purpose, actor_id, visibility)
    }

    fn roll_d20(&mut self, request: &D20Request) -> Result<Roll, DiceError> {
        (**self).roll_d20(request)
    }

    fn roll_check(&mut self, request: &D20Request, difficulty: i64) -> Result<Roll, DiceError> {
        (**self).roll_check(request, difficulty)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seq(values: &[i64]) -> DiceService<SequenceRng> {
        DiceService::deterministic(SequenceRng::new(values.to_vec()), "t")
    }

    #[test]
    fn parses_like_the_previous_engine() {
        assert_eq!(parse_dice_expression("1d20+5").unwrap().canonical, "1d20+5");
        assert_eq!(parse_dice_expression(" D8 ").unwrap().canonical, "1d8");
        assert_eq!(parse_dice_expression("2d6-1").unwrap().modifier, -1);
        assert_eq!(parse_dice_expression("10d10+0").unwrap().canonical, "10d10");
        for bad in ["", "d", "1d1", "101d6", "1d1001", "1d6+100000", "1x6", "1d6+", "abcd6", "1d6*2"] {
            assert!(parse_dice_expression(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn roll_sums_dice_and_modifier() {
        let roll = seq(&[3, 5]).roll("2d6+1", "damage", Some("hero"), Visibility::Public).unwrap();
        assert_eq!(roll.dice, vec![3, 5]);
        assert_eq!(roll.total, 9);
        assert_eq!(roll.roll_id, "t-1");
    }

    #[test]
    fn d20_keeps_by_mode_and_check_compares_with_dc() {
        let mut dice = seq(&[4, 17, 4, 17, 12]);
        let advantage = dice.roll_d20(&D20Request::new("attack", 3).advantage(true)).unwrap();
        assert_eq!((advantage.kept, advantage.total, advantage.expression.as_str()), (Some(17), 20, "2d20+3"));
        let disadvantage = dice.roll_d20(&D20Request::new("attack", 3).disadvantage(true)).unwrap();
        assert_eq!(disadvantage.kept, Some(4));
        let check = dice.roll_check(&D20Request::new("check", -2), 10).unwrap();
        assert_eq!((check.total, check.success), (10, Some(true)));
        assert!(dice.roll_check(&D20Request::new("check", 0), 101).is_err());
    }

    #[test]
    fn sequence_out_of_range_is_an_error() {
        assert!(seq(&[7]).roll("1d6", "x", None, Visibility::Public).is_err());
        assert!(seq(&[]).roll("1d6", "x", None, Visibility::Public).is_err());
    }

    #[test]
    fn transcript_replays_and_refuses_a_different_roll() {
        let mut recording = RecordingDice::new(seq(&[11, 4]));
        recording.roll_d20(&D20Request::new("attack", 5)).unwrap();
        recording.roll("1d8+3", "damage", Some("hero"), Visibility::Public).unwrap();
        let (_, transcript) = recording.into_parts();
        let mut replay = TranscriptDice::new(transcript.clone());
        assert_eq!(replay.roll_d20(&D20Request::new("attack", 5)).unwrap().total, 16);
        assert_eq!(replay.roll("1d8+3", "damage", None, Visibility::Public).unwrap().total, 7);
        assert_eq!(replay.unused(), 0);
        let mut wrong = TranscriptDice::new(transcript);
        assert_eq!(wrong.roll("1d8", "damage", None, Visibility::Public).unwrap_err().code(), "INVALID_DICE_TRANSCRIPT");
    }

    #[test]
    fn roll_serializes_in_the_previous_shape() {
        let roll = seq(&[15]).roll_d20(&D20Request::new("attack", 2)).unwrap();
        let json = serde_json::to_value(&roll).unwrap();
        assert_eq!(json["kept"], 15);
        assert_eq!(json["mode"], "normal");
        assert!(json.get("difficulty").is_none());
        let back: Roll = serde_json::from_value(json).unwrap();
        assert_eq!(back, roll);
    }

    #[test]
    fn calendar_conversion_is_right() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_739), (2026, 10, 13));
    }
}

//! Кости разбора команды — перенос `recordingDiceService`,
//! `replayDiceService`, `rollIndomitableReplacement` и
//! `failedSavingThrowEvent` (`rules-engine.mjs`, 12285–12342). Задача Р0.
//!
//! Стенограмма бросков лежит в `ReactionWindowOpened.pending_dice_transcript`
//! (журнал и хеш проекции), поэтому её JSON обязан совпадать с JS побайтно:
//! запись `{ method, args, result }`, где `args` у `roll` — позиционные
//! аргументы места вызова, а у `rollD20`/`rollCheck` — `[options]`, объект с
//! **порядком ключей места вызова**. Поэтому кости правил принимают аргументы
//! JSON-значениями, а не типизированным `sk_dice::D20Request`, и возвращают
//! бросок JSON-объектом той же формы, что `DiceService` JS.
//!
//! Повтор по стенограмме — мягкий, как в JS: сверяется только метод (а не
//! выражение и модификатор, как в `sk_dice::TranscriptDice`), есть
//! `allowAdditionalRolls` и подмена бросков Несгибаемого по `roll_id`.

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexMap;
use sk_core::js;

use crate::core::{dice_fault, spread_value};
use crate::pause::{rule, Fault, Halt};

/// Кости правил: три метода `DiceService` JS.
pub trait RulesDice {
    /// `diceService.roll(...args)`: `[expression, purpose, actorId, visibility]`
    /// ровно в той длине, в какой их передало место вызова.
    fn roll(&mut self, args: &[Value]) -> Result<Value, Halt>;
    /// `diceService.rollD20(options)`.
    fn roll_d20(&mut self, options: &Value) -> Result<Value, Halt>;
    /// `diceService.rollCheck(options)`.
    fn roll_check(&mut self, options: &Value) -> Result<Value, Halt>;
}

impl<T: RulesDice + ?Sized> RulesDice for &mut T {
    fn roll(&mut self, args: &[Value]) -> Result<Value, Halt> {
        (**self).roll(args)
    }

    fn roll_d20(&mut self, options: &Value) -> Result<Value, Halt> {
        (**self).roll_d20(options)
    }

    fn roll_check(&mut self, options: &Value) -> Result<Value, Halt> {
        (**self).roll_check(options)
    }
}

/// Метод по имени стенограммы (`diceService[entry.method](options)`).
pub fn call(dice: &mut dyn RulesDice, method: &str, options: &Value) -> Result<Value, Halt> {
    match method {
        "rollD20" => dice.roll_d20(options),
        "rollCheck" => dice.roll_check(options),
        _ => Err(Fault::type_error(format!("diceService[{method}] is not a function")).into()),
    }
}

/// `DiceService` JS поверх `sk_dice::Dice`: приведения аргументов как в JS.
pub struct ServiceDice<D: sk_dice::Dice> {
    pub inner: D,
}

impl<D: sk_dice::Dice> ServiceDice<D> {
    pub fn new(inner: D) -> Self {
        Self { inner }
    }
}

fn option<'a>(options: &'a Value, key: &str) -> Option<&'a Value> {
    options.as_object().and_then(|map| map.get(key))
}

/// `visibility = 'public'`: неизвестное значение — публичное.
fn visibility_of(value: Option<&Value>) -> sk_dice::Visibility {
    value.and_then(Value::as_str).map(sk_dice::Visibility::parse_lenient).unwrap_or_default()
}

/// `actorId == null ? null : String(actorId)`.
fn actor_of(value: Option<&Value>) -> Option<String> {
    value.filter(|value| !value.is_null()).map(|value| js::string(Some(value)))
}

/// `String(purpose || fallback)`.
fn purpose_of(value: Option<&Value>, fallback: &str) -> String {
    if js::truthy(value) { js::string(value) } else { fallback.to_string() }
}

/// Запрос d20 из `options` с приведениями `rollD20` JS.
fn d20_request(options: &Value) -> Result<sk_dice::D20Request, Halt> {
    let modifier = match option(options, "modifier") {
        None => 0.0,
        Some(value) => js::number(Some(value)),
    };
    if !crate::core::is_safe_integer_f64(modifier) || modifier.abs() > 100.0 {
        return Err(Fault::new("DiceExpressionError", "Некорректный модификатор d20").into());
    }
    Ok(sk_dice::D20Request {
        modifier: modifier as i64,
        purpose: purpose_of(option(options, "purpose"), "check"),
        actor_id: actor_of(option(options, "actorId")),
        visibility: visibility_of(option(options, "visibility")),
        advantage: js::truthy(option(options, "advantage")),
        disadvantage: js::truthy(option(options, "disadvantage")),
    })
}

fn roll_json(roll: &sk_dice::Roll) -> Value {
    serde_json::to_value(roll).unwrap_or(Value::Null)
}

impl<D: sk_dice::Dice> RulesDice for ServiceDice<D> {
    fn roll(&mut self, args: &[Value]) -> Result<Value, Halt> {
        let expression = js::s(args.first());
        let purpose = purpose_of(args.get(1), "unspecified");
        let actor = actor_of(args.get(2));
        let visibility = visibility_of(args.get(3));
        let roll = self.inner.roll(&expression, &purpose, actor.as_deref(), visibility).map_err(dice_fault)?;
        Ok(roll_json(&roll))
    }

    fn roll_d20(&mut self, options: &Value) -> Result<Value, Halt> {
        let request = d20_request(options)?;
        let roll = self.inner.roll_d20(&request).map_err(dice_fault)?;
        Ok(roll_json(&roll))
    }

    fn roll_check(&mut self, options: &Value) -> Result<Value, Halt> {
        let difficulty = match option(options, "difficulty") {
            None => 10.0,
            Some(value) => js::number(Some(value)),
        };
        if !crate::core::is_safe_integer_f64(difficulty) || !(0.0..=100.0).contains(&difficulty) {
            return Err(Fault::new("DiceExpressionError", "Некорректная сложность проверки").into());
        }
        let request = d20_request(options)?;
        let roll = self.inner.roll_check(&request, difficulty as i64).map_err(dice_fault)?;
        Ok(roll_json(&roll))
    }
}

/// Кости сухого прогона удара-открытия: всегда минимум, id
/// `opening-strike-dry-run` (`new DiceService({ rng: { randint: (min) => min } })`).
pub fn dry_run_dice() -> ServiceDice<sk_dice::DiceService<sk_dice::FixedRng>> {
    ServiceDice::new(sk_dice::DiceService::new(sk_dice::FixedRng(i64::MIN), Box::new(|| "opening-strike-dry-run".to_string()), Box::new(sk_core::clock::now_iso)))
}

/// `recordingDiceService(base, transcript)`: каждый бросок пишется в
/// стенограмму после того, как его сделали нижние кости.
pub struct Recording<'a> {
    inner: &'a mut dyn RulesDice,
    /// `diceTranscript`: `{ method, args, result }` в порядке бросков.
    pub transcript: Vec<Value>,
}

impl<'a> Recording<'a> {
    pub fn new(inner: &'a mut dyn RulesDice) -> Self {
        Self { inner, transcript: Vec::new() }
    }

    fn record(&mut self, method: &str, args: Value, result: &Value) {
        let mut entry = Map::new();
        entry.insert("method".into(), Value::String(method.into()));
        entry.insert("args".into(), args);
        entry.insert("result".into(), result.clone());
        self.transcript.push(Value::Object(entry));
    }
}

impl RulesDice for Recording<'_> {
    fn roll(&mut self, args: &[Value]) -> Result<Value, Halt> {
        let result = self.inner.roll(args)?;
        self.record("roll", Value::Array(args.to_vec()), &result);
        Ok(result)
    }

    fn roll_d20(&mut self, options: &Value) -> Result<Value, Halt> {
        let result = self.inner.roll_d20(options)?;
        self.record("rollD20", json!([options]), &result);
        Ok(result)
    }

    fn roll_check(&mut self, options: &Value) -> Result<Value, Halt> {
        let result = self.inner.roll_check(options)?;
        self.record("rollCheck", json!([options]), &result);
        Ok(result)
    }
}

fn corrupted() -> Halt {
    rule("Сохранённая последовательность бросков повреждена", "INVALID_DICE_TRANSCRIPT")
}

/// Поля подмены Несгибаемого поверх переброшенного d20.
fn with_indomitable(rerolled: &Value, bonus: i64, original: &Value) -> Value {
    let mut map = spread_value(Some(rerolled));
    map.insert("indomitable_applied".into(), Value::Bool(true));
    map.insert("indomitable_bonus".into(), Value::from(bonus));
    if let Some(roll_id) = original.get("roll_id") {
        map.insert("indomitable_original_roll_id".into(), roll_id.clone());
    }
    map.insert("indomitable_original_total".into(), Value::from(js::safe_int(original.get("total"), 0)));
    Value::Object(map)
}

/// `{ ...(options ?? {}), modifier: safeInteger(options?.modifier, 0) + bonus }`.
fn options_with_bonus(options: Option<&Value>, bonus: i64) -> Value {
    let options = options.filter(|value| !value.is_null());
    let mut map = spread_value(options);
    map.insert("modifier".into(), Value::from(js::safe_int(options.and_then(|value| value.get("modifier")), 0) + bonus));
    Value::Object(map)
}

/// `replayDiceService(base, transcript, replacements, { allowAdditionalRolls })`.
pub struct Replay<'a> {
    base: &'a mut dyn RulesDice,
    transcript: Vec<Value>,
    index: usize,
    replacements: IndexMap<String, Value>,
    allow_additional_rolls: bool,
}

enum Asked<'b> {
    Roll(&'b [Value]),
    D20(&'b str, &'b Value),
}

impl<'a> Replay<'a> {
    /// `replacements` — подмена Несгибаемого: объект или массив объектов с
    /// `roll_id`, `bonus` и, может быть, готовым `result`.
    pub fn new(base: &'a mut dyn RulesDice, transcript: Vec<Value>, replacements: Option<&Value>, allow_additional_rolls: bool) -> Self {
        let list: Vec<Value> = match replacements {
            Some(Value::Array(items)) => items.clone(),
            Some(value) if js::truthy(Some(value)) => vec![value.clone()],
            _ => Vec::new(),
        };
        let mut map = IndexMap::new();
        for replacement in list {
            let key = js::s(replacement.get("roll_id"));
            map.insert(key, replacement);
        }
        Self { base, transcript, index: 0, replacements: map, allow_additional_rolls }
    }

    /// Сколько записанных бросков ещё не взято.
    pub fn remaining(&self) -> usize {
        self.transcript.len().saturating_sub(self.index)
    }

    fn invoke(&mut self, asked: &Asked<'_>, options: Option<&Value>) -> Result<Value, Halt> {
        match asked {
            Asked::Roll(args) => self.base.roll(args),
            Asked::D20(method, original) => call(self.base, method, options.unwrap_or(original)),
        }
    }

    fn next(&mut self, method: &str, asked: Asked<'_>) -> Result<Value, Halt> {
        let entry = self.transcript.get(self.index).cloned();
        self.index += 1;
        let Some(entry) = entry.filter(|entry| js::truthy(Some(entry))) else {
            if self.allow_additional_rolls {
                return self.invoke(&asked, None);
            }
            return Err(corrupted());
        };
        if entry.get("method").and_then(Value::as_str) != Some(method) {
            return Err(corrupted());
        }
        let original = match entry.get("result") {
            None | Some(Value::Null) => return Err(Fault::type_error("Cannot read properties of undefined (reading 'roll_id')").into()),
            Some(result) => result.clone(),
        };
        let Some(replacement) = self.replacements.get(&js::s(original.get("roll_id"))).cloned() else { return Ok(original) };
        let Asked::D20(_, options) = asked else {
            return Err(rule("Indomitable может заменить только d20 спасброска", "INVALID_INDOMITABLE_ROLL"));
        };
        let bonus = js::safe_int(replacement.get("bonus"), 0).max(0);
        let rerolled = match replacement.get("result").filter(|value| js::truthy(Some(value))) {
            Some(result) => result.clone(),
            None => {
                let next_options = options_with_bonus(Some(options), bonus);
                self.invoke(&asked, Some(&next_options))?
            }
        };
        Ok(with_indomitable(&rerolled, bonus, &original))
    }
}

impl RulesDice for Replay<'_> {
    fn roll(&mut self, args: &[Value]) -> Result<Value, Halt> {
        self.next("roll", Asked::Roll(args))
    }

    fn roll_d20(&mut self, options: &Value) -> Result<Value, Halt> {
        self.next("rollD20", Asked::D20("rollD20", options))
    }

    fn roll_check(&mut self, options: &Value) -> Result<Value, Halt> {
        self.next("rollCheck", Asked::D20("rollCheck", options))
    }
}

/// `rollIndomitableReplacement(diceService, transcript, rollId, bonus)`:
/// переброс d20 спасброска с бонусом уровня воина.
pub fn roll_indomitable_replacement(dice: &mut dyn RulesDice, transcript: &[Value], roll_id: Option<&Value>, bonus: Option<&Value>) -> Result<Value, Halt> {
    let wanted = js::s(roll_id);
    let entry = transcript.iter().find(|candidate| js::s(candidate.get("result").and_then(|result| result.get("roll_id"))) == wanted);
    let method = entry.and_then(|entry| entry.get("method")).and_then(Value::as_str).unwrap_or("");
    let Some(entry) = entry.filter(|_| matches!(method, "rollD20" | "rollCheck")) else {
        return Err(rule("Не найден исходный d20 спасброска", "INVALID_INDOMITABLE_ROLL"));
    };
    let first = entry.get("args").and_then(|args| args.get(0)).filter(|value| matches!(value, Value::Object(_) | Value::Array(_)));
    let normalized_bonus = js::safe_int(bonus, 0).max(0);
    let next_options = options_with_bonus(Some(first.unwrap_or(&Value::Object(Map::new()))), normalized_bonus);
    let rerolled = call(dice, method, &next_options)?;
    let original = entry.get("result").cloned().unwrap_or(Value::Null);
    Ok(with_indomitable(&rerolled, normalized_bonus, &original))
}

/// `failedSavingThrowEvent(event)`: проваленный спасбросок, который можно перебросить.
pub fn failed_saving_throw_event(event: &Value) -> bool {
    let payload = event.get("payload");
    let field = |key: &str| payload.and_then(|payload| payload.get(key));
    if !js::truthy(field("roll_id")) {
        return false;
    }
    if js::is_true(field("willing_target")) || js::is_true(field("no_initial_save")) {
        return false;
    }
    match event.get("event_type").and_then(Value::as_str) {
        Some("SpellSavingThrowResolved" | "ConcentrationSavingThrowResolved") => js::is_false(field("saved")),
        Some("SavingThrowResolved") => js::is_false(field("success")) || js::is_false(field("saved")),
        Some("DeathSavingThrowRolled") => js::is_false(field("success")),
        _ => false,
    }
}

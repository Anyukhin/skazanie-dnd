//! Часы мира — перенос `durationInMinutes`, `normalizedClockSeconds`,
//! `worldTimeSeconds` (`rules-engine.mjs`): минуты кампании и секундный
//! остаток раундов боя.

use serde_json::Value;
use sk_core::js::{number, round};

/// `normalizedClockSeconds(value)`: неотрицательные секунды с точностью до
/// тысячной; не число — 0.
pub fn normalized_clock_seconds(value: f64) -> f64 {
    if value.is_finite() {
        (round(value * 1_000.0) / 1_000.0).max(0.0)
    } else {
        0.0
    }
}

/// То же для поля JSON (`Number(value)`).
pub fn normalized_clock_seconds_of(value: Option<&Value>) -> f64 {
    normalized_clock_seconds(number(value))
}

/// `durationInMinutes(amount, unit)`: часы, дни и раунды — в минутах.
pub fn duration_in_minutes(amount: Option<&Value>, unit: Option<&Value>) -> i64 {
    let value = number(amount);
    let value = if value.is_nan() { 0.0 } else { value.max(0.0) };
    let unit = if sk_core::js::truthy(unit) { sk_core::js::s(unit) } else { "minute".into() };
    let normalized = sk_core::text::lower(sk_core::text::trim(&unit));
    let multiplier = match normalized.as_str() {
        "hour" | "hours" | "hour(s)" | "час" | "часа" | "часов" => 60.0,
        "day" | "days" | "day(s)" | "день" | "дня" | "дней" => 1_440.0,
        "round" | "rounds" | "round(s)" | "раунд" | "раунда" | "раундов" => 0.1,
        _ => 1.0,
    };
    (value * multiplier).floor().max(0.0) as i64
}

/// `worldTimeSeconds(state)`.
pub fn world_time_seconds(state: &Value) -> f64 {
    let time = sk_core::game::mechanics(state).get("world_time").cloned().unwrap_or(Value::Null);
    let elapsed = time.get("elapsed_minutes");
    let minutes = if sk_core::js::present(elapsed) && sk_core::js::is_safe_integer_number(elapsed) {
        number(elapsed).max(0.0)
    } else {
        duration_in_minutes(time.get("amount"), time.get("unit")) as f64
    };
    normalized_clock_seconds(minutes * 60.0 + normalized_clock_seconds_of(time.get("second_remainder")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn durations_follow_js() {
        assert_eq!(duration_in_minutes(Some(&json!(2)), Some(&json!("часа"))), 120);
        assert_eq!(duration_in_minutes(Some(&json!(7)), Some(&json!("rounds"))), 0);
        assert_eq!(duration_in_minutes(Some(&json!(15)), Some(&json!("раундов"))), 1);
        assert_eq!(duration_in_minutes(Some(&json!("x")), None), 0);
        assert_eq!(normalized_clock_seconds(6.0004), 6.0);
        assert_eq!(normalized_clock_seconds(-3.0), 0.0);
    }

    #[test]
    fn world_time_reads_minutes_and_remainder() {
        let state = json!({ "mechanics": { "world_time": { "elapsed_minutes": 10, "second_remainder": 12 } } });
        assert_eq!(world_time_seconds(&state), 612.0);
        let legacy = json!({ "mechanics": { "world_time": { "amount": 2, "unit": "hour" } } });
        assert_eq!(world_time_seconds(&legacy), 7_200.0);
    }
}

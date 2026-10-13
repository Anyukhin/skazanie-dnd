//! Время по правилам JS: `Date.now()`, `toISOString()`, `Date.parse()`.

use std::time::{SystemTime, UNIX_EPOCH};

/// `Date.now()` в миллисекундах.
pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_millis() as i64).unwrap_or(0)
}

/// `new Date().toISOString()`.
pub fn now_iso() -> String {
    iso(now_ms())
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `new Date(ms).toISOString()`: `2026-10-13T12:34:56.789Z`.
pub fn iso(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rest = ms.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    let (hours, minutes, seconds, millis) = (rest / 3_600_000, rest / 60_000 % 60, rest / 1000 % 60, rest % 1000);
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}.{millis:03}Z")
}

fn digits(part: &str) -> Option<i64> {
    if part.is_empty() || !part.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    part.parse().ok()
}

/// `Date.parse(text)` для ISO-строк (`YYYY-MM-DD`, `…THH:MM[:SS[.sss]]`, `Z`
/// или смещение `±HH:MM`). Иное — `None` (в JS — `NaN`).
pub fn parse_iso(text: &str) -> Option<i64> {
    let text = text.trim();
    let (date, time) = match text.split_once(['T', ' ']) {
        Some((date, time)) => (date, Some(time)),
        None => (text, None),
    };
    let mut date_parts = date.splitn(3, '-');
    let year = digits(date_parts.next()?)?;
    let month = match date_parts.next() {
        Some(part) => digits(part)?,
        None => 1,
    };
    let day = match date_parts.next() {
        Some(part) => digits(part)?,
        None => 1,
    };
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut ms = days_from_civil(year, month, day) * 86_400_000;
    let Some(time) = time else { return Some(ms) };
    let (clock, offset_ms) = if let Some(clock) = time.strip_suffix('Z') {
        (clock, 0)
    } else if let Some(index) = time.rfind(['+', '-']) {
        let (clock, offset) = time.split_at(index);
        let sign = if offset.starts_with('-') { -1 } else { 1 };
        let (hours, minutes) = offset[1..].split_once(':').unwrap_or((&offset[1..], "0"));
        (clock, sign * (digits(hours)? * 60 + digits(minutes)?) * 60_000)
    } else {
        // Без зоны JS считает время местным; сервер живёт в UTC.
        (time, 0)
    };
    let mut parts = clock.splitn(3, ':');
    let hours = digits(parts.next()?)?;
    let minutes = digits(parts.next()?)?;
    let (seconds, millis) = match parts.next() {
        Some(seconds) => match seconds.split_once('.') {
            Some((whole, fraction)) => {
                let fraction: String = fraction.chars().take(3).collect();
                (digits(whole)?, digits(&format!("{fraction:0<3}"))?)
            }
            None => (digits(seconds)?, 0),
        },
        None => (0, 0),
    };
    ms += ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis - offset_ms;
    Some(ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_round_trip() {
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
        let ms = parse_iso("2026-10-13T11:34:56.789Z").expect("дата");
        assert_eq!(iso(ms), "2026-10-13T11:34:56.789Z");
        assert_eq!(parse_iso("2026-10-13T14:34:56.789+03:00"), Some(ms));
        assert_eq!(parse_iso("1970-01-02"), Some(86_400_000));
        assert_eq!(parse_iso("вчера"), None);
    }
}

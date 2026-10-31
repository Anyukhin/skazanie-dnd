//! Перенос `server/narrator-craft-quality.mjs`: каталог клише Рассказчика и
//! поиск их в тексте.
//!
//! Каталог составлен по сохранённому прогону `eval/live-narrator-report.json`
//! (2026-07-28) и живому baseline Wave 1: у каждой записи, кроме двух
//! обязательных примеров из брифа, есть дословно наблюдавшийся фрагмент.
//! Каталог принадлежит production craft-guard; offline eval берёт тот же список.

use std::sync::LazyLock;

use serde::Serialize;
use serde_json::Value;
use sk_core::fancy_regex::Regex;
use sk_core::text;

use crate::jsx;

/// Запись каталога клише.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ClicheEntry {
    pub id: &'static str,
    pub label: &'static str,
    pub source: &'static str,
    /// Источник регулярного выражения JS; флаги — `iu`.
    pub pattern: &'static str,
}

const fn entry(id: &'static str, label: &'static str, source: &'static str, pattern: &'static str) -> ClicheEntry {
    ClicheEntry { id, label, source, pattern }
}

/// `NARRATOR_CLICHE_CATALOG`.
pub const NARRATOR_CLICHE_CATALOG: &[ClicheEntry] = &[
    entry("air-thickens", "воздух густеет", "обязательный пример из брифа S", r"воздух\s+густе"),
    entry("silence-hangs", "повисает тишина", "обязательный пример из брифа S", r"повиса(?:ет|ла)\s+тишин"),
    entry("moment-freeze", "на мгновение замирает", "на мгновение замирает", r"на\s+(?:одно\s+)?мгновени[ея]\s+(?:замира|засты)"),
    entry("eyes-flash", "в глазах мелькает", "в глазах мелькает узнавание", r"в\s+глазах\s+(?:мелька|вспых)"),
    entry("pulls-together", "берёт себя в руки", "быстро берёт себя в руки", r"бер[её]т\s+себя\s+в\s+руки"),
    entry("legs-buckle", "ноги подкашиваются", "ноги подкашиваются", r"ноги\s+подкашива"),
    entry("world-swims", "мир плывёт", "мир плывёт", r"мир\s+плыв[её]т"),
    entry("air-smells", "в воздухе пахнет", "в воздухе пахнет пылью и дымом", r"в\s+воздухе\s+пахн"),
    entry("sun-declines", "солнце клонится к закату", "солнце клонится к закату", r"солнце\s+клонится\s+к\s+закату"),
    entry("crimson-sky", "багровые тона", "окрашивая небо в багровые тона", r"небо.{0,24}багров|багров.{0,24}небо"),
    entry("cuts-through-din", "перекрывает гул", "голос перекрывает гул трактира", r"перекрыва[ею]т\s+гул"),
    entry("last-lunge", "в последнем рывке", "извернувшись в последнем рывке", r"в\s+последн(?:ем|ий)\s+рывк"),
    entry("wariness-melts", "настороженность тает", "Мирина настороженность тает", r"настороженн[а-яё]*\s+та[её]т"),
    entry("casts-a-glance", "бросает взгляд", "бросает взгляд на Северные ворота", r"броса[а-яё]*\s+взгляд"),
    entry("thought-spins", "в голове крутится", "в голове крутится та же синяя нить", r"в\s+голове\s+крут"),
    entry("silence-stands", "тишина стоит такая", "тишина стоит такая, будто телега растворилась", r"тишина\s+стоит\s+так"),
    entry("threads-one-knot", "нити одного узла", "две нити одного узла", r"нит[ьи]\s+одного\s+узла"),
];

static CLICHE_MATCHERS: LazyLock<Vec<(ClicheEntry, Option<Regex>)>> =
    LazyLock::new(|| NARRATOR_CLICHE_CATALOG.iter().map(|entry| (*entry, text::js_regex(entry.pattern, "iu"))).collect());

/// Найденное клише: запись каталога и совпавший фрагмент (`{ ...entry, match }`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ClicheMatch {
    #[serde(flatten)]
    pub entry: ClicheEntry,
    #[serde(rename = "match")]
    pub matched: String,
}

/// `findNarratorCliches(value)`: текст — `String(value ?? '').normalize('NFKC')`;
/// по одному совпадению на запись, в порядке каталога.
pub fn find_narrator_cliches(value: Option<&Value>) -> Vec<ClicheMatch> {
    find_narrator_cliches_in(&jsx::string(value))
}

/// То же для строки.
pub fn find_narrator_cliches_in(value: &str) -> Vec<ClicheMatch> {
    let normalized = text::nfkc(value);
    CLICHE_MATCHERS
        .iter()
        .filter_map(|(entry, matcher)| {
            let found = matcher.as_ref()?.find(&normalized).ok().flatten()?;
            Some(ClicheMatch { entry: *entry, matched: found.as_str().to_string() })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn catalog_is_complete_and_compiles() {
        assert!(NARRATOR_CLICHE_CATALOG.len() >= 16, "каталог принадлежит production craft-проверке");
        assert!(CLICHE_MATCHERS.iter().all(|(_, matcher)| matcher.is_some()));
        let mut ids: Vec<&str> = NARRATOR_CLICHE_CATALOG.iter().map(|entry| entry.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), NARRATOR_CLICHE_CATALOG.len());
    }

    #[test]
    fn finds_cliches_case_insensitively() {
        let found = find_narrator_cliches(Some(&json!("Воздух  густеет. Мира БРОСАЕТ взгляд на дверь.")));
        let ids: Vec<&str> = found.iter().map(|item| item.entry.id).collect();
        assert_eq!(ids, ["air-thickens", "casts-a-glance"]);
        assert_eq!(found[0].matched, "Воздух  густе");
        assert_eq!(found[1].matched, "БРОСАЕТ взгляд");
        let value = serde_json::to_value(&found[0]).expect("json");
        assert_eq!(value["match"], json!("Воздух  густе"));
        assert_eq!(value["pattern"], json!(r"воздух\s+густе"));
        assert!(find_narrator_cliches(None).is_empty());
    }
}

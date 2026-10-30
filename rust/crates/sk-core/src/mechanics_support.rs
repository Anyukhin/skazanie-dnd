//! Статус механики карточки — тип, а не строка (урок 8 плана переноса).
//!
//! Каталоги действий и заклинаний сняты с dnd.su и содержат ошибки; статус
//! говорит, что из карточки сервер вправе исполнить:
//!
//! - `verified` — серверный обработчик, события, тесты replay;
//! - `partial` — исполняется формализованная часть, ограничение в `supportNote`;
//! - `heuristic` — механика не проверена, исполнение блокируется;
//! - `ruling-only` — нужно решение ведущего, исполнение блокируется.
//!
//! Поле называется по-разному: `mechanicsSupport` у заклинаний и действий,
//! `mechanics_status` у предметов, `status` у боевого листа NPC. Словарь один.
//! `verified-dndsu` встречается только в соседнем поле `mechanicsAccuracy`
//! (точность переноса текста), статусом исполнимости оно не является.
//!
//! Встроенный каталог разбирается при загрузке ([`MechanicsSupport::require`]):
//! неизвестное значение — ошибка с именем карточки. Карточка из состояния
//! кампании или команды разбирается мягко ([`MechanicsSupport::of`]): чужое
//! значение там — не исполнимое, как и в JS.

use std::fmt;
use std::str::FromStr;

use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum MechanicsSupport {
    Verified,
    Partial,
    Heuristic,
    RulingOnly,
}

impl MechanicsSupport {
    /// Все статусы в порядке сводок каталога.
    pub const ALL: [Self; 4] = [Self::Verified, Self::Partial, Self::Heuristic, Self::RulingOnly];

    /// Строка статуса в карточке.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Verified => "verified",
            Self::Partial => "partial",
            Self::Heuristic => "heuristic",
            Self::RulingOnly => "ruling-only",
        }
    }

    /// Точный разбор строки; другое написание — `None`.
    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|status| status.as_str() == text)
    }

    /// Мягкий разбор поля карточки: не строка или незнакомая строка — `None`.
    pub fn of(value: Option<&Value>) -> Option<Self> {
        value.and_then(Value::as_str).and_then(Self::parse)
    }

    /// Строгий разбор поля карточки встроенного каталога.
    pub fn require(value: Option<&Value>, card: &str) -> Result<Self, UnknownMechanicsSupport> {
        Self::of(value).ok_or_else(|| UnknownMechanicsSupport { card: card.to_string(), value: value.map_or_else(|| "отсутствует".to_string(), Value::to_string) })
    }

    /// Сервер вправе исполнить карточку: `verified` или `partial`.
    pub const fn is_executable(self) -> bool {
        matches!(self, Self::Verified | Self::Partial)
    }

    /// Мягкий разбор с вопросом «исполнимо ли».
    pub fn executable(value: Option<&Value>) -> bool {
        Self::of(value).is_some_and(Self::is_executable)
    }

    /// Мягкий разбор с вопросом «это именно этот статус».
    pub fn is(value: Option<&Value>, status: Self) -> bool {
        Self::of(value) == Some(status)
    }

    fn index(self) -> usize {
        self as usize
    }
}

impl fmt::Display for MechanicsSupport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for MechanicsSupport {
    type Err = UnknownMechanicsSupport;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        Self::parse(text).ok_or_else(|| UnknownMechanicsSupport { card: String::new(), value: Value::from(text).to_string() })
    }
}

impl From<MechanicsSupport> for Value {
    fn from(status: MechanicsSupport) -> Self {
        Value::from(status.as_str())
    }
}

/// Карточка каталога с незнакомым статусом: каталог не загружается.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownMechanicsSupport {
    /// Карточка: id заклинания, действия или `catalog_id` предмета.
    pub card: String,
    /// Значение поля как JSON (`"verifed"`, `null`) или «отсутствует».
    pub value: String,
}

impl fmt::Display for UnknownMechanicsSupport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let known: Vec<&str> = MechanicsSupport::ALL.iter().map(|status| status.as_str()).collect();
        write!(f, "Карточка «{}»: неизвестный статус механики {} (допустимы: {})", self.card, self.value, known.join(", "))
    }
}

impl std::error::Error for UnknownMechanicsSupport {}

/// Сводка каталога по статусам: счётчики и неисполнимые карточки по порядку.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MechanicsCensus {
    counts: [usize; 4],
    blocked: Vec<String>,
}

impl MechanicsCensus {
    /// Строгий подсчёт: первая карточка с незнакомым статусом — ошибка.
    pub fn of_cards<'a>(cards: impl IntoIterator<Item = (&'a str, Option<&'a Value>)>) -> Result<Self, UnknownMechanicsSupport> {
        let mut census = Self::default();
        for (card, value) in cards {
            census.add(card, MechanicsSupport::require(value, card)?);
        }
        Ok(census)
    }

    pub fn add(&mut self, card: &str, status: MechanicsSupport) {
        self.counts[status.index()] += 1;
        if !status.is_executable() {
            self.blocked.push(card.to_string());
        }
    }

    pub fn count(&self, status: MechanicsSupport) -> usize {
        self.counts[status.index()]
    }

    pub fn total(&self) -> usize {
        self.counts.iter().sum()
    }

    /// Карточки `heuristic` и `ruling-only` в порядке каталога.
    pub fn blocked(&self) -> &[String] {
        &self.blocked
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn statuses_round_trip() {
        for status in MechanicsSupport::ALL {
            assert_eq!(MechanicsSupport::parse(status.as_str()), Some(status));
            assert_eq!(status.as_str().parse::<MechanicsSupport>(), Ok(status));
        }
        assert_eq!(MechanicsSupport::parse("Verified"), None);
        assert_eq!(MechanicsSupport::parse("verified-dndsu"), None);
        assert_eq!(MechanicsSupport::of(Some(&json!(1))), None);
    }

    #[test]
    fn unknown_status_names_the_card() {
        let error = MechanicsSupport::require(Some(&json!("verifed")), "fire-bolt").unwrap_err();
        assert_eq!(error.card, "fire-bolt");
        assert!(error.to_string().contains("«fire-bolt»") && error.to_string().contains("\"verifed\""), "{error}");
        let missing = MechanicsSupport::require(None, "dash").unwrap_err();
        assert!(missing.to_string().contains("отсутствует"), "{missing}");
    }

    #[test]
    fn census_counts_and_lists_blocked() {
        let cards = [json!("verified"), json!("heuristic"), json!("partial"), json!("ruling-only")];
        let census = MechanicsCensus::of_cards(["a", "b", "c", "d"].into_iter().zip(cards.iter().map(Some))).unwrap();
        assert_eq!(census.total(), 4);
        assert_eq!(census.count(MechanicsSupport::Heuristic), 1);
        assert_eq!(census.blocked(), ["b", "d"]);
        let typo = [json!("verified"), json!("partal")];
        let error = MechanicsCensus::of_cards(["a", "b"].into_iter().zip(typo.iter().map(Some))).unwrap_err();
        assert_eq!(error.card, "b");
    }
}

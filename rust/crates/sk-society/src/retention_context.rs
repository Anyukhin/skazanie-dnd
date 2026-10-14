//! Перенос `server/retention-context.mjs`: синхронный контекст совместимости
//! для replay.
//!
//! Редьюсеры вызываются только синхронно. Контекст живёт один вызов и всегда
//! восстанавливается (в JS — `finally`, здесь — `Drop` охранника, в том числе
//! при панике), поэтому соседние пути не наследуют legacy-политику. В JS
//! контекст — глобальная переменная однопоточного процесса; здесь он свой у
//! каждого потока (`thread_local!`), что для синхронного редьюсера то же самое.

use std::cell::Cell;

pub const RETENTION_REDUCER_VERSION: i64 = 15;

/// Режим удержания: прежняя политика (`legacy`) или текущая (`current`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetentionMode {
    Legacy,
    Current,
}

impl RetentionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Legacy => "legacy",
            Self::Current => "current",
        }
    }

    /// Разбор имени режима; неизвестное имя — ошибка с текстом JS.
    pub fn parse(mode: &str) -> Result<Self, String> {
        match mode {
            "legacy" => Ok(Self::Legacy),
            "current" => Ok(Self::Current),
            other => Err(format!("Неизвестный режим retention: {other}")),
        }
    }
}

thread_local! {
    static ACTIVE_MODE: Cell<RetentionMode> = const { Cell::new(RetentionMode::Current) };
    static ACTIVE_DEPTH: Cell<usize> = const { Cell::new(0) };
}

/// Текущий режим (`retentionMode()`): `"legacy"` или `"current"`.
pub fn retention_mode() -> &'static str {
    ACTIVE_MODE.with(Cell::get).as_str()
}

/// Идёт ли сейчас вызов внутри `with_retention_mode` (`retentionContextActive()`).
pub fn retention_context_active() -> bool {
    ACTIVE_DEPTH.with(Cell::get) > 0
}

struct Restore {
    mode: RetentionMode,
    depth: usize,
}

impl Drop for Restore {
    fn drop(&mut self) {
        ACTIVE_MODE.with(|cell| cell.set(self.mode));
        ACTIVE_DEPTH.with(|cell| cell.set(self.depth));
    }
}

/// Выполнить операцию в режиме `mode` (`withRetentionMode`). Неизвестный режим
/// — ошибка `Неизвестный режим retention: …`, операция при этом не вызывается.
pub fn with_retention_mode<T>(mode: &str, operation: impl FnOnce() -> T) -> Result<T, String> {
    let parsed = RetentionMode::parse(mode)?;
    let _restore = Restore { mode: ACTIVE_MODE.with(Cell::get), depth: ACTIVE_DEPTH.with(Cell::get) };
    ACTIVE_MODE.with(|cell| cell.set(parsed));
    ACTIVE_DEPTH.with(|cell| cell.set(cell.get() + 1));
    Ok(operation())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_lives_one_call_and_nests() {
        assert_eq!(retention_mode(), "current");
        assert!(!retention_context_active());
        let seen = with_retention_mode("legacy", || {
            let inner = with_retention_mode("current", || (retention_mode(), retention_context_active())).expect("режим");
            (retention_mode(), retention_context_active(), inner)
        })
        .expect("режим");
        assert_eq!(seen, ("legacy", true, ("current", true)));
        assert_eq!(retention_mode(), "current");
        assert!(!retention_context_active());
    }

    #[test]
    fn unknown_mode_is_refused_with_the_js_message() {
        let mut called = false;
        let error = with_retention_mode("future", || called = true).expect_err("неизвестный режим");
        assert_eq!(error, "Неизвестный режим retention: future");
        assert!(!called);
    }

    #[test]
    fn mode_is_restored_after_a_panic() {
        let result = std::panic::catch_unwind(|| {
            let _ = with_retention_mode("legacy", || panic!("падение внутри редьюсера"));
        });
        assert!(result.is_err());
        assert_eq!(retention_mode(), "current");
        assert!(!retention_context_active());
    }
}

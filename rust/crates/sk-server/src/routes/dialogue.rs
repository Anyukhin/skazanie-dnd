//! С15: диалог и объяснение хода: `dialogue` GET/DELETE (4870), `turns/:id/explanation` (5198).
//!
//! Пусто до С15. Маршруты объявляются здесь с номером строки
//! `server/index.mjs`, где JS их проверяет: порядок общей таблицы
//! (`routes::table`) выводится из этих номеров, общие файлы править не нужно.

use crate::dispatch::Route;

pub fn routes() -> Vec<Route> {
    Vec::new()
}

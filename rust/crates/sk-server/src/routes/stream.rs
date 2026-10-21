//! С9: живой поток и присутствие: `presence/typing` PUT (4172), `stream` GET (4193).
//!
//! Пусто до С9. Маршруты объявляются здесь с номером строки
//! `server/index.mjs`, где JS их проверяет: порядок общей таблицы
//! (`routes::table`) выводится из этих номеров, общие файлы править не нужно.

use crate::dispatch::Route;

pub fn routes() -> Vec<Route> {
    Vec::new()
}

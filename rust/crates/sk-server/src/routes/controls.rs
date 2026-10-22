//! С8: откат и жизненный цикл: `controls` (4901), `lifecycle` GET/POST (4967–5037).
//!
//! Пусто до С8. Маршруты объявляются здесь с номером строки
//! `server/index.mjs`, где JS их проверяет: порядок общей таблицы
//! (`routes::table`) выводится из этих номеров, общие файлы править не нужно.

use crate::dispatch::Route;

pub fn routes() -> Vec<Route> {
    Vec::new()
}

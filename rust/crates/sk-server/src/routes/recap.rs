//! С6: рекап «в прошлой серии»: `GET /api/campaigns/:id/recap` (4598–4620).
//!
//! Пусто до С6. Маршруты объявляются здесь с номером строки
//! `server/index.mjs`, где JS их проверяет: порядок общей таблицы
//! (`routes::table`) выводится из этих номеров, общие файлы править не нужно.

use crate::dispatch::Route;

pub fn routes() -> Vec<Route> {
    Vec::new()
}

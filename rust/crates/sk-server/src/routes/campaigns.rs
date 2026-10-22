//! С6: кампании и членство: `GET`/`POST /api/campaigns` (4444, 4484), `/api/heroes` (4472), `invites` (4805), `join` (4846).
//!
//! Пусто до С6. Маршруты объявляются здесь с номером строки
//! `server/index.mjs`, где JS их проверяет: порядок общей таблицы
//! (`routes::table`) выводится из этих номеров, общие файлы править не нужно.

use crate::dispatch::Route;

pub fn routes() -> Vec<Route> {
    Vec::new()
}

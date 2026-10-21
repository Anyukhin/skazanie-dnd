//! С14: торговцы — управление и сборка: `merchants/commands` (5222), `merchants/assemble` (5252), `GET merchants/:id` (5455); общий разбор id торговца (5449–5454) уже стоит в таблице `routes::mod` (`merchant_route_id`).
//!
//! Пусто до С14. Маршруты объявляются здесь с номером строки
//! `server/index.mjs`, где JS их проверяет: порядок общей таблицы
//! (`routes::table`) выводится из этих номеров, общие файлы править не нужно.

use crate::dispatch::Route;

pub fn routes() -> Vec<Route> {
    Vec::new()
}

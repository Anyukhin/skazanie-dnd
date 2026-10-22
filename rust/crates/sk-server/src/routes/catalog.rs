//! С4: справочники: `rulesets/:id/character-creation` (3931), `rules/search` (4425), `world-templates` (4439), `engine-mode` → 410 (5216).
//!
//! Пусто до С4. Маршруты объявляются здесь с номером строки
//! `server/index.mjs`, где JS их проверяет: порядок общей таблицы
//! (`routes::table`) выводится из этих номеров, общие файлы править не нужно.

use crate::dispatch::Route;

pub fn routes() -> Vec<Route> {
    Vec::new()
}

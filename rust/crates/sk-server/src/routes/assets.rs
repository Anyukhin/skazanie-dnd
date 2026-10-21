//! С12: ассеты и картинки: портрет NPC (4028), иллюстрация (4067), `asset-preparation` (4102), `/generated/items/` (сырой префикс, 6114), `/api/items/generate-image` (сырой, 6118).
//!
//! Пусто до С12. Маршруты объявляются здесь с номером строки
//! `server/index.mjs`, где JS их проверяет: порядок общей таблицы
//! (`routes::table`) выводится из этих номеров, общие файлы править не нужно.

use crate::dispatch::Route;

pub fn routes() -> Vec<Route> {
    Vec::new()
}

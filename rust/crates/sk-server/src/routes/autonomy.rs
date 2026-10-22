//! С18.4: автономия: `autonomy/intents` (5039), `autonomy/advance` (5069).
//!
//! Пусто до С18.4. Маршруты объявляются здесь с номером строки
//! `server/index.mjs`, где JS их проверяет: порядок общей таблицы
//! (`routes::table`) выводится из этих номеров, общие файлы править не нужно.

use crate::dispatch::Route;

pub fn routes() -> Vec<Route> {
    Vec::new()
}

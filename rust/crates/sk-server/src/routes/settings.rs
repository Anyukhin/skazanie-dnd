//! С7: настройки ИИ, редакция, домашние правила: `/api/campaigns/:id/settings` GET/PATCH (4622–4803).
//!
//! Пусто до С7. Маршруты объявляются здесь с номером строки
//! `server/index.mjs`, где JS их проверяет: порядок общей таблицы
//! (`routes::table`) выводится из этих номеров, общие файлы править не нужно.

use crate::dispatch::Route;

pub fn routes() -> Vec<Route> {
    Vec::new()
}

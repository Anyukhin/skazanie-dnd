//! С5: боевой стенд администратора (`server/routes/combat-lab-routes.mjs`, подключение — `index.mjs:3958`); нераспознанный путь под `/api/admin/combat-lab/` проваливается дальше — маршрут объявляется через `Route::pass`, 405 — только у `report`.
//!
//! Пусто до С5. Маршруты объявляются здесь с номером строки
//! `server/index.mjs`, где JS их проверяет: порядок общей таблицы
//! (`routes::table`) выводится из этих номеров, общие файлы править не нужно.

use crate::dispatch::Route;

pub fn routes() -> Vec<Route> {
    Vec::new()
}

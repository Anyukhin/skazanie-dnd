//! С11: решения отряда и задания: `quests/{abandon|accept}` (4283), `party-decisions/:id/votes` (4312), `party-decisions/:id/roll` (4374).
//!
//! Пусто до С11. Маршруты объявляются здесь с номером строки
//! `server/index.mjs`, где JS их проверяет: порядок общей таблицы
//! (`routes::table`) выводится из этих номеров, общие файлы править не нужно.

use crate::dispatch::Route;

pub fn routes() -> Vec<Route> {
    Vec::new()
}

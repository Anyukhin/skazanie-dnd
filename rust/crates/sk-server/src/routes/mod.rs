//! Таблица маршрутов в порядке `server/index.mjs`.
//!
//! Каждый модуль задачи (С4–С18) отдаёт свои маршруты функцией `routes()`,
//! у каждого маршрута — номер строки `index.mjs`, где JS его проверяет.
//! [`table`] собирает всё и устойчиво сортирует по этому номеру: порядок
//! проверок JS повторяется сам, и исполнителям не нужно править этот файл.
//! Модули, вынесенные в JS отдельно (`combat-lab-routes.mjs`,
//! `map-import-routes.mjs`), берут номер строки своего подключения
//! (3958, 3959).
//!
//! Владелец файла — ведущий.

use axum::http::StatusCode;

use crate::dispatch::{Matcher, Methods, PassFuture, Route, RouteCtx};
use crate::error::ApiError;

pub mod assets;
pub mod auth;
pub mod autonomy;
pub mod campaigns;
pub mod catalog;
pub mod combat_lab;
pub mod commands;
pub mod controls;
pub mod dialogue;
pub mod encounters;
pub mod map_import;
pub mod merchant_trade;
pub mod merchants_admin;
pub mod narrate;
pub mod party;
pub mod recap;
pub mod rooms;
pub mod service;
pub mod settings;
pub mod stream;
pub mod system_tick;

/// Все маршруты процесса плюс `extra` (тесты), по возрастанию строки JS.
pub fn table(extra: Vec<Route>) -> Vec<Route> {
    let mut routes: Vec<Route> = [
        catalog::routes(),
        service::routes(),
        combat_lab::routes(),
        map_import::routes(),
        auth::routes(),
        assets::routes(),
        stream::routes(),
        party::routes(),
        campaigns::routes(),
        recap::routes(),
        settings::routes(),
        dialogue::routes(),
        controls::routes(),
        autonomy::routes(),
        merchants_admin::routes(),
        encounters::routes(),
        vec![Route::pass(5449, Methods::Any, Matcher::path_template(MERCHANT_PATH), merchant_id_guard)],
        merchant_trade::routes(),
        commands::routes(),
        system_tick::routes(),
        rooms::routes(),
        narrate::routes(),
        extra,
    ]
    .into_iter()
    .flatten()
    .collect();
    routes.sort_by_key(|route| route.line);
    routes
}

/// `/^\/api\/campaigns\/([A-Za-z0-9-]+)\/merchants\/([^/]+)(?:\/commands)?$/` (5449).
pub const MERCHANT_PATH: &str = "/api/campaigns/{id}/merchants/{seg}[/commands]";

/// `decodeURIComponent(merchantMatch[2]).slice(0, 120)` (5452); `None` — `URIError`.
pub fn merchant_route_id(raw: &str) -> Option<String> {
    crate::url::decode_uri_component(raw).map(|id| sk_core::text::slice(&id, 0, Some(120)))
}

/// Разбор id торговца **до проверки метода** (5449–5454): битый процентный
/// код — 400 `INVALID_MERCHANT_ID` на любом методе (`DELETE …/merchants/%E0`
/// — тоже 400, а не 404). Иначе запрос идёт дальше по таблице, к
/// обработчикам С14 и С18.2.
fn merchant_id_guard(ctx: &mut RouteCtx) -> PassFuture<'_> {
    Box::pin(async move {
        if merchant_route_id(ctx.param(1)).is_none() {
            return Err(ApiError::coded(StatusCode::BAD_REQUEST, "Некорректный id торговца", "INVALID_MERCHANT_ID"));
        }
        Ok(None)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Эталон Г для порядка проверок: номер строки каждого маршрута сверяется
    /// с самим `server/index.mjs` — на этой строке или соседней (JS разбирает
    /// регулярку строкой раньше проверки) стоят путь маршрута и, у маршрута
    /// с одним методом, проверка `req.method === '…'`. Опечатка в номере
    /// или сдвиг JS роняют тест: порядок таблицы держится на этих номерах.
    #[test]
    fn route_lines_point_at_js_checks() {
        use crate::dispatch::Pattern;
        let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../server/index.mjs");
        let text = std::fs::read_to_string(&source).unwrap_or_else(|error| panic!("{}: {error}", source.display()));
        let lines: Vec<&str> = text.lines().collect();
        let routes = table(Vec::new());
        assert!(routes.windows(2).all(|pair| pair[0].line <= pair[1].line), "таблица по возрастанию строки");
        for route in &routes {
            let at = |line: u32| lines.get(line as usize - 1).copied().unwrap_or("");
            let window = [at(route.line - 1), at(route.line), at(route.line + 1)];
            let here = window[1];
            // Модули, вынесенные из `index.mjs` (combat-lab 3958, map-import
            // 3959): на строке — подключение, регулярка — в своём файле (С13).
            if matches!(route.line, 3958 | 3959) {
                assert!(here.contains("Route(req, res, requestPath)"), "строка {}: нет подключения модуля\n{here}", route.line);
                continue;
            }
            let marker = match route.matcher.pattern {
                Pattern::Exact(path) | Pattern::Prefix(path) => format!("'{path}"),
                Pattern::Template(template) => template[..template.find(['{', '[', '(']).unwrap_or(template.len())].replace('/', r"\/"),
            };
            assert!(window.iter().any(|line| line.contains(&marker)), "строка {}: нет {marker:?}\n{here}", route.line);
            if let Methods::One(method) = &route.methods {
                let check = format!("req.method === '{method}'");
                assert!(window.iter().any(|line| line.contains(&check)), "строка {}: нет проверки метода {method}\n{here}", route.line);
            }
        }
    }

    #[test]
    fn merchant_id_decoding() {
        assert_eq!(merchant_route_id("%E0"), None);
        assert_eq!(merchant_route_id("m%201").as_deref(), Some("m 1"));
        assert_eq!(merchant_route_id(&"м".repeat(130)).map(|id| id.chars().count()), Some(120));
    }
}

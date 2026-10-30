//! Диспетчер маршрутов в порядке `server/index.mjs` — решение §0.1 плана.
//!
//! Axum — только транспорт: один обработчик на всё. Внутри — упорядоченная
//! таблица [`Route`] (метод, [`Matcher`], обработчик), отсортированная по
//! номеру строки `index.mjs`, где JS проверяет маршрут. Так повторяются:
//!
//! - проваливание вниз по списку: обработчик [`Route::pass`] может вернуть
//!   `None` (боевой стенд, `combat-lab-routes.mjs:84`), а маршрут с
//!   неподходящим методом просто пропускается;
//! - наборы символов регулярок JS ([`Matcher`], шаблоны с `{id}`, `{seg}`…);
//! - сырой `req.url` против `pathname`: [`Target::Raw`] сравнивает адрес как
//!   есть, поэтому `/api/health?x` на сыром маршруте не совпадает (404);
//! - ответ на неверный метод: не 405, а 404 JSON «API endpoint не найден»
//!   (6477), не-API путь любым методом отдаёт клиента (6478); исключение —
//!   маршрут, который сам проверяет метод (`map-import` отвечает 405 на всё,
//!   кроме POST: такой маршрут объявляется с [`Methods::Any`]);
//! - порядок проверок: OPTIONS, источник, затем таблица (3929–3930).
//!
//! Обработка запроса ([`handle`]) повторяет `handleHttpRequest` (3919–3930,
//! 6477–6480): разбор `pathname` (ошибка разбора — 500 до всего остального),
//! настройки ИИ кампании из пути на всё время запроса, граница ошибок
//! ([`crate::boundary`]) и заголовки безопасности.
//!
//! Что делает разборщик HTTP до сервера, и где Rust расходится с Node:
//!
//! - **метод**: llhttp пропускает только свой список методов в верхнем
//!   регистре, на прочие (`FOO`, `post`, `patch`) отвечает голым `400 Bad
//!   Request` без вызова обработчика; hyper принимает любой токен, поэтому
//!   [`handle`] первым делом отвечает так же ([`llhttp_method`]). `CONNECT`
//!   Node без слушателя `connect` закрывает без ответа — здесь 400;
//! - **фрагмент** `#…` в цели запроса Node оставляет в `req.url`
//!   (`GET /api/health#x` — 404 API, `/assets/a.js#x` — `index.html`), а
//!   крейт `http` отрезает его ещё при разборе (`uri/path.rs`), и вернуть
//!   его нельзя. **Отклонение:** здесь фрагмента нет — `/api/health#x`
//!   отвечает как `/api/health`, а статика отдаёт сам файл. Браузеры
//!   фрагмент не шлют, так что расходится только ручной запрос; закреплено
//!   тестом `fragment_is_dropped_by_http_parser`.

use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;

use axum::body::Body;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, Method, Response, StatusCode};
use serde_json::Value;

use crate::error::{ApiError, ApiResult};
use crate::http::{apply_security_headers, origin_allowed, preflight, RequestBody};
use crate::state::Shared;

/// Будущее обработчика.
pub type RouteFuture<'a> = Pin<Box<dyn Future<Output = ApiResult> + Send + 'a>>;
/// Будущее обработчика, который может пропустить запрос дальше (`None`).
pub type PassFuture<'a> = Pin<Box<dyn Future<Output = ApiResult<Option<Response<Body>>>> + Send + 'a>>;

/// Обработчик: функция над контекстом запроса.
#[derive(Clone, Copy)]
pub enum Handler {
    /// Отвечает всегда.
    Final(for<'a> fn(&'a mut RouteCtx) -> RouteFuture<'a>),
    /// Может вернуть `None` — тогда диспетчер идёт к следующему маршруту.
    Pass(for<'a> fn(&'a mut RouteCtx) -> PassFuture<'a>),
}

/// Какие методы принимает маршрут.
#[derive(Clone, Debug)]
pub enum Methods {
    /// Любой: метод проверяет сам обработчик (или не проверяет вовсе, как
    /// `/api/health`, 3940).
    Any,
    One(Method),
    Set(&'static [Method]),
}

impl Methods {
    fn allows(&self, method: &Method) -> bool {
        match self {
            Methods::Any => true,
            Methods::One(expected) => expected == method,
            Methods::Set(methods) => methods.contains(method),
        }
    }
}

/// С чем сравнивается адрес.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    /// `req.url` как пришёл, вместе со строкой запроса.
    Raw,
    /// `new URL(req.url, base).pathname`.
    Path,
}

/// Образец адреса.
#[derive(Clone, Copy, Debug)]
pub enum Pattern {
    /// `=== '/api/…'`.
    Exact(&'static str),
    /// `startsWith('/…')`; хвост — первый параметр.
    Prefix(&'static str),
    /// Регулярка JS как шаблон (см. [`template_match`]).
    Template(&'static str),
}

/// Совпадение адреса.
#[derive(Clone, Copy, Debug)]
pub struct Matcher {
    pub target: Target,
    pub pattern: Pattern,
    /// Флаг `i` регулярки.
    pub ignore_case: bool,
}

impl Matcher {
    pub const fn raw(exact: &'static str) -> Self {
        Self { target: Target::Raw, pattern: Pattern::Exact(exact), ignore_case: false }
    }

    pub const fn raw_prefix(prefix: &'static str) -> Self {
        Self { target: Target::Raw, pattern: Pattern::Prefix(prefix), ignore_case: false }
    }

    pub const fn raw_template(template: &'static str) -> Self {
        Self { target: Target::Raw, pattern: Pattern::Template(template), ignore_case: false }
    }

    pub const fn path(exact: &'static str) -> Self {
        Self { target: Target::Path, pattern: Pattern::Exact(exact), ignore_case: false }
    }

    pub const fn path_prefix(prefix: &'static str) -> Self {
        Self { target: Target::Path, pattern: Pattern::Prefix(prefix), ignore_case: false }
    }

    pub const fn path_template(template: &'static str) -> Self {
        Self { target: Target::Path, pattern: Pattern::Template(template), ignore_case: false }
    }

    pub const fn ignore_case(mut self) -> Self {
        self.ignore_case = true;
        self
    }

    /// Параметры совпадения или `None`.
    pub fn captures(&self, raw_url: &str, pathname: &str) -> Option<Vec<String>> {
        let subject = match self.target {
            Target::Raw => raw_url,
            Target::Path => pathname,
        };
        match self.pattern {
            Pattern::Exact(exact) => (if self.ignore_case { subject.eq_ignore_ascii_case(exact) } else { subject == exact }).then(Vec::new),
            Pattern::Prefix(prefix) => {
                let head = subject.get(..prefix.len())?;
                let same = if self.ignore_case { head.eq_ignore_ascii_case(prefix) } else { head == prefix };
                same.then(|| vec![subject[prefix.len()..].to_string()])
            }
            Pattern::Template(template) => template_match(template, subject, self.ignore_case),
        }
    }
}

/// Классы символов регулярок `index.mjs` (все без `/`).
fn class_allows(class: &str, ch: char, ignore_case: bool) -> Option<bool> {
    let ch = if ignore_case { ch.to_ascii_lowercase() } else { ch };
    Some(match class {
        // `[A-Za-z0-9-]+` — id кампании и комнаты.
        "id" => ch.is_ascii_alphanumeric() || ch == '-',
        // `[^/]+`.
        "seg" => ch != '/',
        // `[A-Za-z0-9._:-]+` — id решения отряда.
        "decision" => ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-'),
        // `[A-Za-z0-9._-]+` — id хода.
        "turn" => ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'),
        // `[a-f0-9-]+` (у админа — с флагом `i`).
        "hex" => matches!(ch, 'a'..='f' | '0'..='9' | '-'),
        // `[a-z0-9_]+` — id редакции.
        "ruleset" => matches!(ch, 'a'..='z' | '0'..='9' | '_'),
        _ => return None,
    })
}

#[derive(Debug)]
enum Token<'t> {
    Literal(&'t str),
    Class(&'t str),
    Alternatives(Vec<&'t str>),
    /// `(?:литерал)?` — в параметры не попадает.
    Optional(&'t str),
    /// `(литерал)?` — захватывающая группа: в параметры кладётся литерал
    /// или пустая строка (`match[n]` — `undefined`).
    OptionalCapture(&'t str),
}

fn tokens(template: &str) -> Vec<Token<'_>> {
    let mut out = Vec::new();
    let mut rest = template;
    while !rest.is_empty() {
        if let Some(inner) = rest.strip_prefix('{') {
            let end = inner.find('}').unwrap_or(inner.len());
            let body = &inner[..end];
            out.push(if body.contains('|') { Token::Alternatives(body.split('|').collect()) } else { Token::Class(body) });
            rest = inner.get(end + 1..).unwrap_or("");
        } else if let Some(inner) = rest.strip_prefix('[') {
            let end = inner.find(']').unwrap_or(inner.len());
            out.push(Token::Optional(&inner[..end]));
            rest = inner.get(end + 1..).unwrap_or("");
        } else if let Some(inner) = rest.strip_prefix('(') {
            let end = inner.find(')').unwrap_or(inner.len());
            out.push(Token::OptionalCapture(&inner[..end]));
            rest = inner.get(end + 1..).unwrap_or("");
        } else {
            let end = rest.find(['{', '[', '(']).unwrap_or(rest.len());
            out.push(Token::Literal(&rest[..end]));
            rest = &rest[end..];
        }
    }
    out
}

fn literal_prefix<'s>(subject: &'s str, literal: &str, ignore_case: bool) -> Option<&'s str> {
    let head = subject.get(..literal.len())?;
    let same = if ignore_case { head.eq_ignore_ascii_case(literal) } else { head == literal };
    same.then(|| &subject[literal.len()..])
}

fn match_tokens(tokens: &[Token<'_>], subject: &str, ignore_case: bool, captures: &mut Vec<String>) -> bool {
    let Some((first, rest)) = tokens.split_first() else { return subject.is_empty() };
    match first {
        Token::Literal(literal) => literal_prefix(subject, literal, ignore_case).is_some_and(|tail| match_tokens(rest, tail, ignore_case, captures)),
        Token::Optional(literal) => {
            if let Some(tail) = literal_prefix(subject, literal, ignore_case) {
                let mark = captures.len();
                if match_tokens(rest, tail, ignore_case, captures) {
                    return true;
                }
                captures.truncate(mark);
            }
            match_tokens(rest, subject, ignore_case, captures)
        }
        Token::OptionalCapture(literal) => {
            let mark = captures.len();
            if let Some(tail) = literal_prefix(subject, literal, ignore_case) {
                captures.push(subject[..literal.len()].to_string());
                if match_tokens(rest, tail, ignore_case, captures) {
                    return true;
                }
                captures.truncate(mark);
            }
            captures.push(String::new());
            if match_tokens(rest, subject, ignore_case, captures) {
                return true;
            }
            captures.truncate(mark);
            false
        }
        Token::Alternatives(options) => options.iter().any(|option| {
            let mark = captures.len();
            if let Some(tail) = literal_prefix(subject, option, ignore_case) {
                captures.push(subject[..option.len()].to_string());
                if match_tokens(rest, tail, ignore_case, captures) {
                    return true;
                }
            }
            captures.truncate(mark);
            false
        }),
        Token::Class(class) => {
            // Жадно и с откатом, как `+` регулярки.
            let mut ends: Vec<usize> = Vec::new();
            for (index, ch) in subject.char_indices() {
                if class_allows(class, ch, ignore_case) != Some(true) {
                    break;
                }
                ends.push(index + ch.len_utf8());
            }
            for end in ends.into_iter().rev() {
                let mark = captures.len();
                captures.push(subject[..end].to_string());
                if match_tokens(rest, &subject[end..], ignore_case, captures) {
                    return true;
                }
                captures.truncate(mark);
            }
            false
        }
    }
}

/// Совпадение шаблона целиком (`^…$`). Синтаксис: литералы; `{id}`, `{seg}`,
/// `{decision}`, `{turn}`, `{hex}`, `{ruleset}` — классы регулярок JS с `+`;
/// `{a|b}` — выбор `(a|b)`; `[/commands]` — необязательный литерал
/// `(?:\/commands)?`; `(/report)` — необязательная **захватывающая** группа
/// `(\/report)?` (параметр — литерал или пустая строка). Классы, выбор и
/// захватывающие группы попадают в параметры по порядку.
pub fn template_match(template: &str, subject: &str, ignore_case: bool) -> Option<Vec<String>> {
    let tokens = tokens(template);
    let mut captures = Vec::new();
    match_tokens(&tokens, subject, ignore_case, &mut captures).then_some(captures)
}

/// Строка таблицы маршрутов.
#[derive(Clone)]
pub struct Route {
    /// Строка `server/index.mjs`, где JS проверяет маршрут: по ней таблица
    /// сортируется (устойчиво — маршруты одной строки идут в порядке
    /// объявления).
    pub line: u32,
    pub methods: Methods,
    pub matcher: Matcher,
    pub handler: Handler,
}

impl Route {
    pub fn new(line: u32, methods: Methods, matcher: Matcher, handler: for<'a> fn(&'a mut RouteCtx) -> RouteFuture<'a>) -> Self {
        Self { line, methods, matcher, handler: Handler::Final(handler) }
    }

    pub fn get(line: u32, matcher: Matcher, handler: for<'a> fn(&'a mut RouteCtx) -> RouteFuture<'a>) -> Self {
        Self::new(line, Methods::One(Method::GET), matcher, handler)
    }

    pub fn post(line: u32, matcher: Matcher, handler: for<'a> fn(&'a mut RouteCtx) -> RouteFuture<'a>) -> Self {
        Self::new(line, Methods::One(Method::POST), matcher, handler)
    }

    pub fn pass(line: u32, methods: Methods, matcher: Matcher, handler: for<'a> fn(&'a mut RouteCtx) -> PassFuture<'a>) -> Self {
        Self { line, methods, matcher, handler: Handler::Pass(handler) }
    }
}

/// Контекст запроса для обработчика.
pub struct RouteCtx {
    pub state: Shared,
    pub method: Method,
    /// `req.url`.
    pub raw_url: String,
    /// `parsedUrl.pathname`.
    pub pathname: String,
    pub headers: HeaderMap,
    /// `req.socket.remoteAddress` (с портом).
    pub peer: Option<SocketAddr>,
    /// Параметры совпавшего шаблона.
    pub params: Vec<String>,
    /// Тело — читается лениво, один раз.
    pub body: RequestBody,
}

impl RouteCtx {
    /// Параметр шаблона по номеру; нет — пустая строка.
    pub fn param(&self, index: usize) -> &str {
        self.params.get(index).map_or("", String::as_str)
    }

    /// `parsedUrl.searchParams.get(name)`.
    pub fn search_param(&self, name: &str) -> Option<String> {
        crate::url::search_param(&self.raw_url, name)
    }

    /// `readBody(req)`; ошибка через `?` — 400 с кодом на границе.
    pub async fn json_body(&mut self) -> Result<Value, crate::http::BodyError> {
        self.body.json().await
    }

    /// `cookies(req).skazanie_session`.
    pub fn session_token(&self) -> Option<String> {
        crate::http::session_token(&self.headers)
    }

    /// `req.headers[name]` (latin1, повторы через `, `).
    pub fn header(&self, name: &str) -> String {
        crate::http::header_text(&self.headers, name)
    }
}

/// Сырая цель запроса (`req.url`): путь со строкой запроса, а для
/// абсолютной формы — весь адрес, как его видит Node.
pub fn raw_target(uri: &axum::http::Uri) -> String {
    if uri.scheme().is_some() {
        return uri.to_string();
    }
    uri.path_and_query().map_or_else(|| "/".to_string(), |value| value.as_str().to_string())
}

/// Обработчик axum для всех запросов.
pub async fn entry(State(state): State<Shared>, request: Request) -> Response<Body> {
    handle(state, request).await
}

/// Методы, которые пропускает llhttp (Node 24, `http.METHODS` без `CONNECT`
/// и `PRI`): только верхний регистр.
const LLHTTP_METHODS: [&str; 34] = [
    "DELETE", "GET", "HEAD", "POST", "PUT", "OPTIONS", "TRACE", "COPY", "LOCK", "MKCOL", "MOVE", "PROPFIND", "PROPPATCH", "SEARCH", "UNLOCK", "BIND", "REBIND", "UNBIND",
    "ACL", "REPORT", "MKACTIVITY", "CHECKOUT", "MERGE", "M-SEARCH", "NOTIFY", "SUBSCRIBE", "UNSUBSCRIBE", "PATCH", "PURGE", "MKCALENDAR", "LINK", "UNLINK", "SOURCE",
    "QUERY",
];

/// Пропустил бы метод разборщик Node.
pub fn llhttp_method(method: &Method) -> bool {
    LLHTTP_METHODS.contains(&method.as_str())
}

/// Ответ llhttp на неизвестный метод (`HPE_INVALID_METHOD`): голый 400 и
/// закрытие соединения — без JSON и заголовков безопасности.
fn bad_request() -> Response<Body> {
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::BAD_REQUEST;
    response.headers_mut().insert(axum::http::header::CONNECTION, axum::http::HeaderValue::from_static("close"));
    response
}

/// `handleHttpRequest(req, res)` с границей `failUnhandledRequest`.
pub async fn handle(state: Shared, request: Request) -> Response<Body> {
    if !llhttp_method(request.method()) {
        return bad_request();
    }
    let peer = request.extensions().get::<ConnectInfo<SocketAddr>>().map(|info| info.0);
    let (parts, body) = request.into_parts();
    // Тело, которое маршрут не прочитал (или до маршрута дело не дошло),
    // дочитывается после ответа, как в Node (С19.1).
    let body = RequestBody::new(body);
    let leftover = body.leftover();
    let raw_url = raw_target(&parts.uri);
    // `new URL(...)` — первая строка обработчика: исключение уходит в
    // `failUnhandledRequest` ещё до заголовков безопасности (3920).
    let Some(pathname) = crate::url::pathname(&raw_url) else {
        eprintln!("[Сказание] Необработанная ошибка {} ?: Invalid URL", parts.method);
        leftover.drain();
        return ApiError::internal("Invalid URL").into_response();
    };
    // Настройки ИИ кампании из пути (3921–3928); сбой чтения — тоже до
    // заголовков безопасности.
    let settings = match crate::ai_context::campaign_id_from_path(&pathname) {
        Some(campaign_id) => {
            let accounts = state.accounts.clone();
            let model = state.config.model.clone();
            match crate::core::blocking(move || accounts.get_campaign_ai_settings(&campaign_id).map(|stored| crate::ai_context::request_settings(&stored, &model))).await {
                Ok(Ok(settings)) => Some(settings),
                Ok(Err(error)) => {
                    eprintln!("[Сказание] Необработанная ошибка {} {pathname}: {}", parts.method, error.message);
                    leftover.drain();
                    return ApiError::internal(error.message).into_response();
                }
                Err(error) => {
                    eprintln!("[Сказание] Необработанная ошибка {} {pathname}: {error}", parts.method);
                    leftover.drain();
                    return ApiError::internal(error.to_string()).into_response();
                }
            }
        }
        None => None,
    };
    let method = parts.method.clone();
    let log_path = pathname.clone();
    let ctx = RouteCtx { state, method: parts.method, raw_url, pathname, headers: parts.headers, peer, params: Vec::new(), body };
    let perf_started = sk_store::perf::request_trace().then(std::time::Instant::now);
    let perf_label = perf_started.map(|_| format!("{method} {log_path}"));
    let allocations_before = sk_store::perf::allocation_counters();
    let mut response = crate::ai_context::with_campaign_ai(settings, crate::boundary::guard(method, log_path, dispatch(ctx))).await;
    leftover.drain();
    apply_security_headers(response.headers_mut());
    if let (Some(started), Some(label)) = (perf_started, perf_label) {
        // Отрезок: [число, мс, МБ выделено за его время]; МБ — только в сборке
        // с фичей `alloc-count`, иначе 0.
        let round = |value: f64| (value * 100.0).round() / 100.0;
        let spans: serde_json::Map<String, Value> = sk_store::perf::take_with_allocations().into_iter().map(|(name, count, ms, mb)| (name.to_string(), serde_json::json!([count, round(ms), round(mb)]))).collect();
        let (bytes, count, big) = sk_store::perf::allocation_counters();
        let alloc = serde_json::json!({ "mb": round((bytes - allocations_before.0) as f64 / 1e6), "count": count - allocations_before.1, "big": big - allocations_before.2 });
        eprintln!("[perf] {}", serde_json::json!({ "request": label, "status": response.status().as_u16(), "total_ms": (started.elapsed().as_secs_f64() * 1e5).round() / 100.0, "alloc": alloc, "spans": spans }));
    }
    response
}

/// Тело `handleHttpRequest` после `applySecurityHeaders` (3930–6479).
async fn dispatch(mut ctx: RouteCtx) -> ApiResult {
    if ctx.method == Method::OPTIONS {
        return Ok(preflight());
    }
    let mutating = matches!(ctx.method, Method::POST | Method::PUT | Method::PATCH | Method::DELETE);
    if mutating && !origin_allowed(&ctx.headers) {
        return Ok(crate::http::error(StatusCode::FORBIDDEN, "Запрос с другого источника отклонён"));
    }
    let state = ctx.state.clone();
    for route in state.routes.iter() {
        let Some(params) = route.matcher.captures(&ctx.raw_url, &ctx.pathname) else { continue };
        if !route.methods.allows(&ctx.method) {
            continue;
        }
        ctx.params = params;
        match route.handler {
            Handler::Final(handler) => return handler(&mut ctx).await,
            Handler::Pass(handler) => {
                if let Some(response) = handler(&mut ctx).await? {
                    return Ok(response);
                }
            }
        }
    }
    if ctx.pathname.starts_with("/api/") {
        return Err(ApiError::api_not_found());
    }
    Ok(crate::static_files::serve(&ctx.state.config.dist_dir, &ctx.raw_url, &ctx.headers))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps(template: &str, subject: &str) -> Option<Vec<String>> {
        template_match(template, subject, false)
    }

    #[test]
    fn templates_follow_js_regex_classes() {
        assert_eq!(caps("/api/campaigns/{id}/commands", "/api/campaigns/AB-1/commands"), Some(vec!["AB-1".into()]));
        assert_eq!(caps("/api/campaigns/{id}/commands", "/api/campaigns/A_B/commands"), None, "подчёркивания нет в [A-Za-z0-9-]");
        assert_eq!(caps("/api/campaigns/{id}/npcs/{seg}/portrait", "/api/campaigns/X/npcs/н%20пц/portrait"), Some(vec!["X".into(), "н%20пц".into()]));
        assert_eq!(caps("/api/campaigns/{id}/party-decisions/{decision}/votes", "/api/campaigns/X/party-decisions/q:1.a_b-c/votes"), Some(vec!["X".into(), "q:1.a_b-c".into()]));
        assert_eq!(caps("/api/campaigns/{id}/quests/{abandon|accept}", "/api/campaigns/X/quests/accept"), Some(vec!["X".into(), "accept".into()]));
        assert_eq!(caps("/api/campaigns/{id}/quests/{abandon|accept}", "/api/campaigns/X/quests/acceptx"), None);
        assert_eq!(caps("/api/campaigns/{id}/merchants/{seg}[/commands]", "/api/campaigns/X/merchants/m1/commands"), Some(vec!["X".into(), "m1".into()]));
        assert_eq!(caps("/api/campaigns/{id}/merchants/{seg}[/commands]", "/api/campaigns/X/merchants/commands"), Some(vec!["X".into(), "commands".into()]));
        assert_eq!(caps("/api/admin/combat-lab/runs/{seg}[/report]", "/api/admin/combat-lab/runs/r1/report"), Some(vec!["r1".into()]));
        // `(\/report)?` стенда (`combat-lab-routes.mjs:59`): `match[2]` отличает
        // отчёт прогона `r1` от прогона с id `report`.
        let lab = "/api/admin/combat-lab/runs/{seg}(/report)";
        assert_eq!(caps(lab, "/api/admin/combat-lab/runs/r1/report"), Some(vec!["r1".into(), "/report".into()]));
        assert_eq!(caps(lab, "/api/admin/combat-lab/runs/report"), Some(vec!["report".into(), String::new()]));
        assert_eq!(caps(lab, "/api/admin/combat-lab/runs/r1"), Some(vec!["r1".into(), String::new()]));
        assert_eq!(caps(lab, "/api/admin/combat-lab/runs/r1/reports"), None);
        assert_eq!(template_match("/api/admin/users/{hex}", "/api/admin/users/ABCDEF-12", true), Some(vec!["ABCDEF-12".into()]), "флаг i");
        assert_eq!(template_match("/api/admin/users/{hex}", "/api/admin/users/ABCDEF-12", false), None);
        assert_eq!(caps("/api/rulesets/{ruleset}/character-creation", "/api/rulesets/srd_5_2_1/character-creation"), Some(vec!["srd_5_2_1".into()]));
    }

    #[test]
    fn methods_like_llhttp() {
        for method in ["GET", "POST", "PATCH", "M-SEARCH", "QUERY", "PURGE"] {
            assert!(llhttp_method(&Method::from_bytes(method.as_bytes()).unwrap_or(Method::GET)), "{method}");
        }
        for method in ["post", "patch", "FOO", "CONNECT", "PRI"] {
            assert!(!llhttp_method(&Method::from_bytes(method.as_bytes()).unwrap_or(Method::CONNECT)), "{method}");
        }
    }

    #[test]
    fn raw_and_path_targets() {
        let raw = Matcher::raw("/api/health");
        assert!(raw.captures("/api/health", "/api/health").is_some());
        assert!(raw.captures("/api/health?x", "/api/health").is_none(), "сырой маршрут со строкой запроса не совпадает");
        let path = Matcher::path("/api/heroes");
        assert!(path.captures("/api/heroes?x=1", "/api/heroes").is_some());
        assert_eq!(Matcher::raw_prefix("/generated/items/").captures("/generated/items/a.png?v=1", "/generated/items/a.png"), Some(vec!["a.png?v=1".into()]));
    }
}

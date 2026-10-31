//! Отказы маршрутов.
//!
//! [`ApiError`] — готовый JSON-ответ `{ error, code?, … }` (`json(res, status,
//! body)` в `server/index.mjs:470–481`). [`Failure`] — ошибка нижнего слоя с
//! текстом и кодом, как `error.message`/`error.code` в JS: маршрут сам
//! выбирает статус по коду ([`Failure::respond`]), а необработанная — через
//! `?` — становится 500 `INTERNAL_ERROR` последней границы (`index.mjs:3886–3918`).

use axum::body::Body;
use axum::http::{Response, StatusCode};
use serde_json::{Map, Value};

use crate::http::{json, BodyError};

/// Коды гонки журнала, на которые маршруты команд отвечают 409: общая часть
/// списков JS (`index.mjs:4370, 4421, 4801`). Маршрут дописывает свои
/// (`PARTY_DECISION_CONFLICT`, `CAMPAIGN_RULESET_LOCKED`…) к этому набору
/// или берёт его как есть — но не набирает заново.
pub const STATE_CONFLICT_CODES: [&str; 2] = ["STATE_VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT"];

/// Готовый отказ маршрута.
#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: StatusCode,
    pub body: Map<String, Value>,
    /// Подробность для лога сервера (необработанная ошибка); клиенту не уходит.
    pub internal: Option<String>,
}

pub type ApiResult<T = Response<Body>> = Result<T, ApiError>;

/// `{ error: 'Внутренняя ошибка сервера', code: 'INTERNAL_ERROR' }` (`index.mjs:3913`).
pub const INTERNAL_ERROR_MESSAGE: &str = "Внутренняя ошибка сервера";

impl ApiError {
    /// `json(res, status, { error })`.
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        let mut body = Map::new();
        body.insert("error".into(), Value::String(message.into()));
        Self { status, body, internal: None }
    }

    /// `json(res, status, { error, code })`.
    pub fn coded(status: StatusCode, message: impl Into<String>, code: impl Into<String>) -> Self {
        Self::new(status, message).with_code(code)
    }

    /// Добавить `code`.
    pub fn with_code(mut self, code: impl Into<String>) -> Self {
        self.body.insert("code".into(), Value::String(code.into()));
        self
    }

    /// Добавить поле тела (порядок вставки сохраняется, как в литерале JS).
    pub fn with_field(mut self, key: &str, value: Value) -> Self {
        self.body.insert(key.to_string(), value);
        self
    }

    /// Необработанная ошибка: 500 `INTERNAL_ERROR`, подробность — только в лог.
    pub fn internal(detail: impl Into<String>) -> Self {
        let mut error = Self::coded(StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_MESSAGE, "INTERNAL_ERROR");
        error.internal = Some(detail.into());
        error
    }

    /// `json(res, 404, { error: 'API endpoint не найден' })` (`index.mjs:6478`).
    pub fn api_not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "API endpoint не найден")
    }

    pub fn into_response(self) -> Response<Body> {
        json(self.status, &Value::Object(self.body))
    }
}

impl axum::response::IntoResponse for ApiError {
    fn into_response(self) -> Response<Body> {
        ApiError::into_response(self)
    }
}

/// Ошибки разбора тела — вина запроса: 400 с кодом (`REQUEST_BODY_ERROR_CODES`,
/// `index.mjs:3888`, `failUnhandledRequest` 3909–3911).
impl From<BodyError> for ApiError {
    fn from(error: BodyError) -> Self {
        if crate::http::REQUEST_BODY_ERROR_CODES.contains(&error.code) {
            Self::coded(StatusCode::BAD_REQUEST, error.message, error.code)
        } else {
            // Обрыв соединения при чтении — не вина формы запроса.
            ApiError::internal(format!("{}: {}", error.code, error.message))
        }
    }
}

/// Ошибка нижнего слоя: `error.message` и `error.code` JS.
#[derive(Debug, Clone, PartialEq)]
pub struct Failure {
    pub message: String,
    pub code: Option<String>,
    /// Дополнительные поля ошибки (`details` хранилища и т. п.).
    pub details: Option<Value>,
}

impl Failure {
    pub fn new(message: impl Into<String>, code: Option<&str>) -> Self {
        Self { message: message.into(), code: code.map(str::to_string), details: None }
    }

    /// `json(res, status, { error: error.message, code: error?.code })`:
    /// `code: undefined` в JSON не попадает.
    pub fn respond(&self, status: StatusCode) -> ApiError {
        let error = ApiError::new(status, self.message.clone());
        match &self.code {
            Some(code) => error.with_code(code.clone()),
            None => error,
        }
    }

    /// Статус по коду, как цепочки `CONFLICT_CODES.has(code) ? 409 : …` в
    /// маршрутах: первая подходящая группа, иначе `fallback`.
    pub fn respond_by(&self, groups: &[(&[&str], StatusCode)], fallback: StatusCode) -> ApiError {
        let code = self.code.as_deref().unwrap_or("");
        let status = groups.iter().find(|(codes, _)| codes.contains(&code)).map_or(fallback, |(_, status)| *status);
        self.respond(status)
    }
}

impl std::fmt::Display for Failure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.code {
            Some(code) => write!(formatter, "{code}: {}", self.message),
            None => formatter.write_str(&self.message),
        }
    }
}

/// Необработанный `Failure` — 500, как исключение мимо `catch` маршрута.
impl From<Failure> for ApiError {
    fn from(failure: Failure) -> Self {
        ApiError::internal(failure.to_string())
    }
}

impl From<sk_store::StoreError> for Failure {
    fn from(error: sk_store::StoreError) -> Self {
        let details = if error.details.as_object().is_some_and(|map| !map.is_empty()) { Some(error.details.clone()) } else { None };
        // Пустой код — ошибка без `code` в JS (`new Error`): поля нет.
        let code = (!error.code.is_empty()).then(|| error.code.to_string());
        Self { message: error.message, code, details }
    }
}

impl From<sk_store::accounts::AccountError> for Failure {
    fn from(error: sk_store::accounts::AccountError) -> Self {
        Self { message: error.message, code: error.code.map(str::to_string), details: None }
    }
}

impl From<sk_infra::roll_registry::RollRegistryError> for Failure {
    fn from(error: sk_infra::roll_registry::RollRegistryError) -> Self {
        Self { code: error.code().map(str::to_string), message: error.to_string(), details: None }
    }
}

impl From<sk_infra::usage_ledger::UsageLedgerError> for Failure {
    fn from(error: sk_infra::usage_ledger::UsageLedgerError) -> Self {
        Self { code: error.code().map(str::to_string), message: error.to_string(), details: None }
    }
}

impl From<sk_core::RuleError> for Failure {
    fn from(error: sk_core::RuleError) -> Self {
        Self { message: error.message, code: Some(error.code), details: None }
    }
}

impl From<sk_rules::pause::Halt> for Failure {
    fn from(halt: sk_rules::pause::Halt) -> Self {
        Self { code: halt.code().map(str::to_string), message: halt.to_string(), details: None }
    }
}

impl From<sk_projection::viewer_projection::ProjectionError> for Failure {
    fn from(error: sk_projection::viewer_projection::ProjectionError) -> Self {
        Self { message: error.message, code: error.code, details: None }
    }
}

impl From<crate::core::CoreError> for Failure {
    fn from(error: crate::core::CoreError) -> Self {
        Self { message: error.to_string(), code: None, details: None }
    }
}

macro_rules! unhandled {
    ($($source:ty),* $(,)?) => {
        $(impl From<$source> for ApiError {
            fn from(error: $source) -> Self {
                ApiError::from(Failure::from(error))
            }
        })*
    };
}

unhandled!(
    sk_store::StoreError,
    sk_store::accounts::AccountError,
    sk_infra::roll_registry::RollRegistryError,
    sk_infra::usage_ledger::UsageLedgerError,
    sk_core::RuleError,
    sk_rules::pause::Halt,
    sk_projection::viewer_projection::ProjectionError,
    crate::core::CoreError,
);

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn failure_status_by_code() {
        let conflict = Failure::new("гонка", Some("STATE_VERSION_CONFLICT"));
        let error = conflict.respond_by(&[(&STATE_CONFLICT_CODES, StatusCode::CONFLICT), (&["ROLL_FORBIDDEN"], StatusCode::FORBIDDEN)], StatusCode::BAD_REQUEST);
        assert_eq!(error.status, StatusCode::CONFLICT);
        assert_eq!(Value::Object(error.body), json!({ "error": "гонка", "code": "STATE_VERSION_CONFLICT" }));
        let plain = Failure::new("нет", None).respond(StatusCode::BAD_REQUEST);
        assert_eq!(Value::Object(plain.body), json!({ "error": "нет" }), "code: undefined не печатается");
        let unhandled = ApiError::from(Failure::new("сбой диска", Some("EIO")));
        assert_eq!(unhandled.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(Value::Object(unhandled.body), json!({ "error": "Внутренняя ошибка сервера", "code": "INTERNAL_ERROR" }));
        assert_eq!(unhandled.internal.as_deref(), Some("EIO: сбой диска"));
    }
}

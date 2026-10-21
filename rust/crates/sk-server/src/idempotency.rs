//! Ключ идемпотентности запроса и правило повтора.
//!
//! Маршруты JS берут ключ по-разному, и разница видна снаружи:
//!
//! | JS | помощник |
//! | --- | --- |
//! | `String(body.idempotency_key \|\| req.headers['x-idempotency-key'] \|\| randomUUID())` (4324) | [`key_or_uuid`] |
//! | `String(body.idempotencyKey \|\| body.idempotency_key \|\| … \|\| randomUUID())` (6197) | [`narrate_key_or_uuid`] |
//! | `body.idempotency_key ?? req.headers['x-idempotency-key']` без приведения (4297) | [`key_nullish_raw`] |
//! | `String(body.idempotency_key ?? req.headers[…] ?? '').trim()` (4705, 5235, 5320) | [`key_nullish`] |
//! | то же + пусто или длиннее 200 — 400 `IDEMPOTENCY_KEY_REQUIRED` (5235–5237, 5320–5323) | [`required_key`] |
//! | то же `.slice(0, 200)` + пусто — 400 `Нужен idempotency_key` (4914–4915) | [`required_key_sliced`] |
//!
//! Правило повтора одно на все маршруты: сначала права на найденный
//! коммит (чужой повтор — тот же отказ, что и чужой запрос), потом сравнение
//! отпечатка намерения; другое намерение под тем же ключом —
//! `409 IDEMPOTENCY_CONFLICT` ([`replay_or_conflict`]).

use axum::http::{HeaderMap, StatusCode};
use serde_json::Value;
use sk_core::js;

use crate::error::ApiError;
use crate::http::{has_header, header_text};

const HEADER: &str = "x-idempotency-key";

/// `req.headers['x-idempotency-key']` (`undefined` — `None`).
fn header_value(headers: &HeaderMap) -> Option<Value> {
    has_header(headers, HEADER).then(|| Value::String(header_text(headers, HEADER)))
}

/// `a || b`: первое истинное значение.
fn or_value(values: &[Option<Value>]) -> Option<Value> {
    values.iter().flatten().find(|value| js::truthy(Some(value))).cloned()
}

/// `a ?? b`: первое не `null`/`undefined`.
fn nullish(values: &[Option<Value>]) -> Option<Value> {
    values.iter().flatten().find(|value| !value.is_null()).cloned()
}

/// `String(body.idempotency_key || header || randomUUID())`.
pub fn key_or_uuid(body: &Value, headers: &HeaderMap) -> String {
    or_value(&[body.get("idempotency_key").cloned(), header_value(headers)]).map_or_else(sk_core::hash::uuid_v4, |value| js::string(Some(&value)))
}

/// `String(body.idempotencyKey || body.idempotency_key || header || randomUUID())`.
pub fn narrate_key_or_uuid(body: &Value, headers: &HeaderMap) -> String {
    or_value(&[body.get("idempotencyKey").cloned(), body.get("idempotency_key").cloned(), header_value(headers)]).map_or_else(sk_core::hash::uuid_v4, |value| js::string(Some(&value)))
}

/// `body.idempotency_key ?? header` как есть (`undefined` — `None`).
pub fn key_nullish_raw(body: &Value, headers: &HeaderMap) -> Option<Value> {
    nullish(&[body.get("idempotency_key").cloned(), header_value(headers)])
}

/// `String(body.idempotency_key ?? header ?? '').trim()`.
pub fn key_nullish(body: &Value, headers: &HeaderMap) -> String {
    sk_core::text::trim(&js::s(key_nullish_raw(body, headers).as_ref())).to_string()
}

/// Ключ обязателен, до 200 единиц UTF-16 (`merchants/commands`, `encounters/assemble`).
pub fn required_key(body: &Value, headers: &HeaderMap) -> Result<String, ApiError> {
    let key = key_nullish(body, headers);
    if key.is_empty() || sk_core::text::len(&key) > 200 {
        return Err(ApiError::coded(StatusCode::BAD_REQUEST, "Нужен X-Idempotency-Key или idempotency_key длиной до 200 символов", "IDEMPOTENCY_KEY_REQUIRED"));
    }
    Ok(key)
}

/// Ключ обязателен и обрезается до 200 (`controls`, 4914–4915).
pub fn required_key_sliced(body: &Value, headers: &HeaderMap) -> Result<String, ApiError> {
    let key = sk_core::text::slice(&key_nullish(body, headers), 0, Some(200));
    if key.is_empty() {
        return Err(ApiError::coded(StatusCode::BAD_REQUEST, "Нужен idempotency_key", "IDEMPOTENCY_KEY_REQUIRED"));
    }
    Ok(key)
}

/// Повтор по ключу: найденный коммит отдаётся, только если вызывающему он
/// позволен (`authorize`) и намерение то же (`same_intent`); иначе —
/// отказ прав или `409 IDEMPOTENCY_CONFLICT` с текстом маршрута.
pub fn replay_or_conflict<T>(
    duplicate: Option<T>,
    authorize: impl FnOnce(&T) -> Result<(), ApiError>,
    same_intent: impl FnOnce(&T) -> bool,
    conflict_message: &str,
) -> Result<Option<T>, ApiError> {
    let Some(committed) = duplicate else { return Ok(None) };
    authorize(&committed)?;
    if !same_intent(&committed) {
        return Err(ApiError::coded(StatusCode::CONFLICT, conflict_message, "IDEMPOTENCY_CONFLICT"));
    }
    Ok(Some(committed))
}

/// Отпечаток намерения: маршрут, тип команды, актор и цель — сравнивается
/// по тексту `JSON.stringify`, как отпечатки команд в JS.
pub fn intent_fingerprint(endpoint: &str, command_type: &str, actor_id: &str, target: &Value) -> String {
    js::stringify(&serde_json::json!({ "endpoint": endpoint, "command_type": command_type, "actor_id": actor_id, "target": target }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use serde_json::json;

    fn headers(key: Option<&'static str>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        if let Some(key) = key {
            headers.insert(HEADER, HeaderValue::from_static(key));
        }
        headers
    }

    #[test]
    fn key_sources_follow_each_js_expression() {
        assert_eq!(key_or_uuid(&json!({ "idempotency_key": "b" }), &headers(Some("h"))), "b");
        assert_eq!(key_or_uuid(&json!({ "idempotency_key": "" }), &headers(Some("h"))), "h", "`||` пропускает пустую строку");
        assert_eq!(key_or_uuid(&json!({ "idempotency_key": 7 }), &headers(None)), "7");
        assert_eq!(key_or_uuid(&json!({}), &headers(None)).len(), 36, "иначе — uuid v4");
        assert_eq!(narrate_key_or_uuid(&json!({ "idempotencyKey": "c", "idempotency_key": "b" }), &headers(None)), "c");
        assert_eq!(key_nullish(&json!({ "idempotency_key": "" }), &headers(Some("h"))), "", "`??` пустую строку не пропускает");
        assert_eq!(key_nullish(&json!({ "idempotency_key": null }), &headers(Some(" h "))), "h");
        assert_eq!(key_nullish(&json!({ "idempotency_key": false }), &headers(None)), "false");
        assert_eq!(key_nullish_raw(&json!({}), &headers(None)), None);
    }

    #[test]
    fn required_keys() {
        let long = "к".repeat(201);
        let error = required_key(&json!({ "idempotency_key": long }), &headers(None)).err().map(|error| (error.status, Value::Object(error.body)));
        assert_eq!(error, Some((StatusCode::BAD_REQUEST, json!({ "error": "Нужен X-Idempotency-Key или idempotency_key длиной до 200 символов", "code": "IDEMPOTENCY_KEY_REQUIRED" }))));
        assert_eq!(required_key(&json!({}), &headers(Some("k"))).ok().as_deref(), Some("k"));
        assert_eq!(required_key_sliced(&json!({ "idempotency_key": "к".repeat(250) }), &headers(None)).map(|key| sk_core::text::len(&key)).ok(), Some(200));
        assert_eq!(required_key_sliced(&json!({ "idempotency_key": "  " }), &headers(None)).err().map(|error| error.body["error"].clone()), Some(json!("Нужен idempotency_key")));
    }

    /// Один ключ на разных маршрутах — разные намерения: повтор не отдаёт
    /// чужой коммит, а отвечает 409 (`/commands`, `merchants/:id/commands`,
    /// `encounters/assemble`, `rooms/:id/dice`).
    #[test]
    fn same_key_on_another_endpoint_conflicts() {
        let endpoints = [
            intent_fingerprint("commands", "MoveActor", "hero-1", &json!({ "x": 1 })),
            intent_fingerprint("merchant_commands", "BuyItem", "hero-1", &json!({ "merchant_id": "m" })),
            intent_fingerprint("encounters_assemble", "CreateEncounter", "", &json!({ "difficulty": "medium" })),
            intent_fingerprint("public_die", "RollPublicDie", "hero-1", &json!({ "sides": 20 })),
        ];
        for (stored_index, stored) in endpoints.iter().enumerate() {
            for (requested_index, requested) in endpoints.iter().enumerate() {
                let outcome = replay_or_conflict(Some(stored.clone()), |_| Ok(()), |committed| committed == requested, "Этот idempotency_key уже использован для другого запроса");
                if stored_index == requested_index {
                    assert_eq!(outcome.ok().flatten().as_ref(), Some(stored), "тот же маршрут — прежний коммит");
                } else {
                    let error = outcome.err().map(|error| (error.status, error.body["code"].clone()));
                    assert_eq!(error, Some((StatusCode::CONFLICT, json!("IDEMPOTENCY_CONFLICT"))));
                }
            }
        }
        let forbidden = replay_or_conflict(Some(endpoints[0].clone()), |_| Err(ApiError::new(StatusCode::FORBIDDEN, "чужой")), |_| false, "x");
        assert_eq!(forbidden.err().map(|error| error.status), Some(StatusCode::FORBIDDEN), "права проверяются раньше отпечатка");
        assert_eq!(replay_or_conflict::<String>(None, |_| Ok(()), |_| true, "x").ok(), Some(None));
    }
}

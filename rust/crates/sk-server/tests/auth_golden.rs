//! Эталон «Г» входа и сессий: `fixtures/auth.json` снят с JS-сервера
//! генератором `fixtures/gen-auth.mjs`; здесь те же запросы идут в Rust.

mod kit;

#[tokio::test]
async fn auth_matches_js_golden() {
    let server = kit::TestServer::start().await;
    kit::golden::assert_golden(&server, "auth").await;
}

#[test]
fn normalizer_masks_volatile_values_only() {
    use serde_json::json;
    let raw = json!({
        "id": "0f8fad5b-d9cb-469f-a165-70867728950e",
        "token": "abc", "inviteToken": "x", "cookie": "s=1",
        "createdAt": "2026-10-23T10:00:00.000Z", "expires_at": 1_760_000_000_000_i64, "updatedAt": null,
        "link": "/join?invite=QWE123&x=1", "note": "в 2026-10-23T10:00:00Z", "flat": 5.0,
        "event_id": "a3f1c2d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9",
    });
    assert_eq!(
        kit::golden::normalize(&raw),
        json!({
            "id": "<uuid>", "token": "<token>", "inviteToken": "<token>", "cookie": "<cookie>",
            "createdAt": "<time>", "expires_at": "<time>", "updatedAt": null,
            "link": "/join?invite=<invite>&x=1", "note": "в <date>", "flat": 5,
            "event_id": "a3f1c2d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9",
        })
    );
}

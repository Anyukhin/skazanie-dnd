//! Эталон «Г» ассетов и картинок (С12): `fixtures/c12.json` (поставщик —
//! заглушка, ключ есть, генерация в игре включена) и `fixtures/c12-off.json`
//! (без ключа, генерация в игре выключена) сняты с JS-сервера генератором
//! `fixtures/gen-c12.mjs`; здесь те же запросы идут в Rust.
//!
//! Прогон свой ради правил генератора: псевдообмен `ASSIGN` (назначить
//! игроку героев через `PATCH /api/admin/users`, id случаен), тело создания
//! кампании `"<skip>"` (его сверяет эталон С6), путь `<url:N>` — адрес
//! картинки предмета из ответа обмена N. Заглушка поставщика отвечает тем же
//! webp, а на промпт со словом `BROKEN` — HTML. Сверяются статус,
//! нормализованное тело и записанные заголовки ответа (302 заглушки портрета
//! — без перехода: клиент набора по редиректам не ходит).

mod kit;

use std::collections::BTreeMap;

use serde_json::{json, Value};

use kit::fake_provider::{FakeProvider, ProviderReply};
use kit::golden::{load, normalize, Exchange};
use kit::{Client, Options, Req, TestServer};

const WEBP_HEX: &str = "524946460400000057454250";
const IMAGE_MODEL: &str = "test/golden-image-v1";

fn webp() -> Vec<u8> {
    (0..WEBP_HEX.len()).step_by(2).map(|index| u8::from_str_radix(&WEBP_HEX[index..index + 2], 16).unwrap_or(0)).collect()
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let triple = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        for position in 0..4 {
            if position <= chunk.len() {
                out.push(TABLE[((triple >> (18 - 6 * position)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Заглушка поставщика генератора (`gen-c12.mjs`).
fn provider() -> FakeProvider {
    FakeProvider::start(|request| {
        if request.path != "/images" || request.method != "POST" {
            return Some(ProviderReply { status: 503, body: r#"{"error":"text model disabled in c12 golden"}"#.into(), headers: Vec::new() });
        }
        let broken = request.body["prompt"].as_str().unwrap_or_default().contains("BROKEN");
        let bytes = if broken { b"<!doctype html><title>no</title>".to_vec() } else { webp() };
        Some(ProviderReply::json(json!({
            "data": [{ "b64_json": base64(&bytes) }],
            "usage": { "input_tokens": 4, "output_tokens": 8, "total_tokens": 12 },
            "cost": 0.025,
        })))
    })
}

/// `<url:N>…` — адрес картинки предмета из ответа N.
fn target(path: &str, urls: &BTreeMap<usize, String>) -> String {
    let Some(rest) = path.strip_prefix("<url:") else { return path.to_string() };
    let Some((index, tail)) = rest.split_once('>') else { return path.to_string() };
    let index: usize = index.parse().unwrap_or(usize::MAX);
    format!("{}{tail}", urls.get(&index).unwrap_or_else(|| panic!("нет адреса картинки обмена {index}")))
}

async fn replay(server: &TestServer, exchanges: &[Exchange]) -> Vec<String> {
    let mut clients: BTreeMap<String, Client> = BTreeMap::new();
    let mut urls: BTreeMap<usize, String> = BTreeMap::new();
    let mut mismatches = Vec::new();
    for (index, exchange) in exchanges.iter().enumerate() {
        let label = format!("#{index} {} {} {}", exchange.role, exchange.method, exchange.path);
        if exchange.method == "ASSIGN" {
            let admin = clients.entry("admin".into()).or_insert_with(|| server.client());
            let users = admin.send(Req::new("GET", "/api/admin/users")).await;
            let users: Value = serde_json::from_slice(&users.body).unwrap_or(Value::Null);
            let id = users["users"].as_array().and_then(|list| list.iter().find(|user| user["email"] == json!(exchange.path))).and_then(|user| user["id"].as_str()).unwrap_or_default().to_string();
            let patched = admin.send(Req::new("PATCH", &format!("/api/admin/users/{id}")).json(&json!({ "heroIds": exchange.body.clone().unwrap_or(Value::Null) }))).await;
            if patched.status != exchange.status {
                mismatches.push(format!("{label}: статус {} вместо {}", patched.status, exchange.status));
            }
            continue;
        }
        let client = clients.entry(exchange.role.clone()).or_insert_with(|| server.client());
        let path = target(&exchange.path, &urls);
        let mut request = Req::new(&exchange.method, &path);
        if let Some(body) = &exchange.body {
            request = request.json(body);
        }
        for (name, value) in &exchange.headers {
            request = request.header(name.as_str(), value.clone());
        }
        let response = client.send(request).await;
        if response.status != exchange.status {
            mismatches.push(format!("{label}: статус {} вместо {}: {}", response.status, exchange.status, response.text().chars().take(300).collect::<String>()));
        }
        let body: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
        if let Some(url) = body["url"].as_str() {
            urls.insert(index, url.to_string());
        }
        if exchange.body_norm != json!("<skip>") {
            let actual = normalize(&body);
            if actual != exchange.body_norm {
                mismatches.push(format!("{label}: тело\n  Rust: {actual}\n  JS:   {}", exchange.body_norm));
            }
        }
        for (name, expected) in exchange.headers_norm.iter().flatten() {
            let actual = response.header(name).map(|text| normalize(&Value::String(text.to_string()))).unwrap_or(Value::Null);
            if &actual != expected {
                mismatches.push(format!("{label}: заголовок {name}: {actual} вместо {expected}"));
            }
        }
    }
    mismatches
}

fn assert_clean(name: &str, mismatches: &[String]) {
    assert!(mismatches.is_empty(), "эталон {name}: {} расхождений\n{}", mismatches.len(), mismatches.join("\n"));
}

#[tokio::test]
async fn asset_routes_match_js_golden_with_provider() {
    let provider = provider();
    let mut options = Options::provider(&provider, "test/text-model");
    options.configure = Some(Box::new(|config| {
        config.image_model = IMAGE_MODEL.into();
        config.runtime_image_generation = true;
    }));
    let server = TestServer::start_with(options).await;
    let exchanges = load("c12");
    assert!(!exchanges.is_empty(), "эталон c12 пуст");
    assert_clean("c12", &replay(&server, &exchanges).await);
    // Учёт расхода: каждая генерация прошла резерв; брак закрыт неудачей.
    let usage: Value = serde_json::from_str(&std::fs::read_to_string(server.storage().join("engine").join("llm-usage.json")).unwrap_or_default()).unwrap_or(Value::Null);
    let statuses = |scope: &str| -> Vec<String> {
        let mut entries: Vec<&Value> = usage["requests"].as_object().map(|map| map.values().filter(|entry| entry["scope"] == json!(scope)).collect()).unwrap_or_default();
        entries.sort_by_key(|entry| entry["created_at_ms"].as_i64().unwrap_or(0));
        entries.iter().map(|entry| entry["status"].as_str().unwrap_or_default().to_string()).collect()
    };
    assert_eq!(statuses("item-image"), ["completed", "failed", "completed"]);
    assert_eq!(statuses("npc-portrait").iter().filter(|status| *status == "failed").count(), 2, "сломанный портрет — в игре и в подготовке");
    assert!(statuses("location-illustration").iter().all(|status| status == "completed"));
    let images = provider.requests().into_iter().filter(|request| request.path == "/images").count();
    let reserved = ["item-image", "npc-portrait", "location-illustration"].iter().map(|scope| statuses(scope).len()).sum::<usize>();
    assert_eq!(images, reserved, "ни одного запроса к поставщику мимо учёта расхода");
}

#[tokio::test]
async fn asset_routes_match_js_golden_without_key() {
    let server = TestServer::start().await;
    let exchanges = load("c12-off");
    assert!(!exchanges.is_empty(), "эталон c12-off пуст");
    assert_clean("c12-off", &replay(&server, &exchanges).await);
}

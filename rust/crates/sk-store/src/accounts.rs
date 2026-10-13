//! Учётные записи, сессии, членство в кампаниях, приглашения и настройки ИИ
//! кампании — перенос `server/store.mjs` в ту же базу SQLite.
//!
//! Записи хранятся тем же JSON, что в `storage/auth.json`, а пароли — тем же
//! scrypt (N=16384, r=8, p=1, 64 байта, соль — hex-строка), поэтому прежние
//! аккаунты переносятся (`import_auth_file`) и входят со старыми паролями.
//! Тексты отказов — как в JS: их видит игрок.

use std::path::Path;
use std::sync::{Arc, Mutex};

use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use crate::error::{StoreError, StoreResult};

const SESSION_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Отказ операции с аккаунтом: текст для игрока и необязательный код.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct AccountError {
    pub message: String,
    pub code: Option<&'static str>,
}

impl AccountError {
    fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), code: None }
    }
}

impl From<StoreError> for AccountError {
    fn from(error: StoreError) -> Self {
        Self { message: error.message, code: Some(error.code) }
    }
}

impl From<rusqlite::Error> for AccountError {
    fn from(error: rusqlite::Error) -> Self {
        StoreError::from(error).into()
    }
}

impl From<serde_json::Error> for AccountError {
    fn from(error: serde_json::Error) -> Self {
        StoreError::from(error).into()
    }
}

pub type AccountResult<T> = Result<T, AccountError>;

/// Настройки ИИ кампании (`getCampaignAiSettings`).
#[derive(Debug, Clone, PartialEq)]
pub struct CampaignAiSettings {
    pub model: String,
    pub narrator_style: String,
    pub improv_mode: String,
    pub reasoning_level: String,
}

impl CampaignAiSettings {
    pub fn to_json(&self) -> Value {
        json!({ "model": self.model, "narratorStyle": self.narrator_style, "improvMode": self.improv_mode, "reasoningLevel": self.reasoning_level })
    }
}

/// Изменение доступа пользователя (`updateUserAccess`).
#[derive(Debug, Clone, Default)]
pub struct AccessPatch {
    pub hero_ids: Option<Vec<String>>,
    pub name: Option<String>,
    pub role: Option<String>,
    /// `Some(None)` — сбросить режим движка, `Some(Some("enforce"))` — включить.
    pub engine_mode: Option<Option<String>>,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
    campaign_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (campaign_id, user_id)
);
CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    seq INTEGER NOT NULL,
    body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS campaign_settings (
    campaign_id TEXT PRIMARY KEY,
    body TEXT NOT NULL
);
";

/// Аккаунты поверх базы хранилища.
pub struct Accounts {
    conn: Mutex<Connection>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}

fn token_hash(token: &str) -> String {
    sk_core::hash::sha256_hex(token)
}

fn random_token() -> String {
    let bytes: [u8; 32] = rand::random();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random_salt() -> String {
    let bytes: [u8; 16] = rand::random();
    hex_encode(&bytes)
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `scrypt(password, salt, 64)` с параметрами Node по умолчанию.
fn scrypt_hash(password: &str, salt: &str) -> Vec<u8> {
    let params = scrypt::Params::new(14, 8, 1).expect("параметры scrypt Node");
    let mut output = vec![0u8; 64];
    scrypt::scrypt(password.as_bytes(), salt.as_bytes(), &params, &mut output).expect("scrypt");
    output
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len() && left.iter().zip(right).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

fn hero_id_ok(id: &str) -> bool {
    (1..=40).contains(&id.chars().count()) && id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
}

/// `normalizeHeroIds(heroIds)`.
fn normalize_hero_ids(hero_ids: &[String]) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    for id in hero_ids {
        if hero_id_ok(id) && !result.contains(id) {
            result.push(id.clone());
        }
    }
    result
}

/// `normalizeCampaignId(campaignId)`.
pub fn normalize_campaign_id(campaign_id: &str) -> AccountResult<String> {
    let normalized = campaign_id.to_uppercase();
    let valid = (3..=24).contains(&normalized.chars().count()) && normalized.chars().all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '-');
    if !valid {
        return Err(AccountError::new("Некорректный код кампании"));
    }
    Ok(normalized)
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value.and_then(Value::as_array).map(|list| list.iter().map(|item| sk_core::js::s(Some(item))).collect()).unwrap_or_default()
}

impl Accounts {
    pub fn open(path: impl AsRef<Path>) -> StoreResult<Self> {
        if let Some(parent) = path.as_ref().parent() {
            std::fs::create_dir_all(parent).map_err(|error| StoreError::new("EVENT_STORE_ERROR", format!("Каталог хранилища: {error}")))?;
        }
        Self::with_connection(Connection::open(path)?)
    }

    pub fn in_memory() -> StoreResult<Self> {
        Self::with_connection(Connection::open_in_memory()?)
    }

    fn with_connection(conn: Connection) -> StoreResult<Self> {
        conn.busy_timeout(std::time::Duration::from_secs(30))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn: Mutex::new(conn), clock: Arc::new(sk_core::clock::now_ms) })
    }

    /// Часы для тестов сроков.
    pub fn with_clock(mut self, clock: Arc<dyn Fn() -> i64 + Send + Sync>) -> Self {
        self.clock = clock;
        self
    }

    fn now(&self) -> i64 {
        (self.clock)()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn users(conn: &Connection) -> AccountResult<Vec<Value>> {
        let mut statement = conn.prepare_cached("SELECT body FROM users ORDER BY rowid")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }

    fn user_by(conn: &Connection, column: &str, value: &str) -> AccountResult<Option<Value>> {
        let sql = format!("SELECT body FROM users WHERE {column} = ?1");
        let body: Option<String> = conn.query_row(&sql, params![value], |row| row.get(0)).optional()?;
        Ok(match body {
            Some(text) => Some(serde_json::from_str(&text)?),
            None => None,
        })
    }

    fn memberships(conn: &Connection) -> AccountResult<Vec<Value>> {
        let mut statement = conn.prepare_cached("SELECT body FROM memberships ORDER BY seq")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }

    fn save_membership(conn: &Connection, membership: &Value) -> AccountResult<()> {
        let campaign = sk_core::js::s(membership.get("campaignId"));
        let user = sk_core::js::s(membership.get("userId"));
        let seq: i64 = conn.query_row("SELECT COALESCE(MAX(seq), 0) + 1 FROM memberships", [], |row| row.get(0))?;
        conn.execute(
            "INSERT INTO memberships (campaign_id, user_id, seq, body) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(campaign_id, user_id) DO UPDATE SET body = excluded.body",
            params![campaign, user, seq, serde_json::to_string(membership)?],
        )?;
        Ok(())
    }

    fn save_user(conn: &Connection, user: &Value) -> AccountResult<()> {
        conn.execute(
            "INSERT INTO users (id, email, body) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET email = excluded.email, body = excluded.body",
            params![sk_core::js::s(user.get("id")), sk_core::js::s(user.get("email")), serde_json::to_string(user)?],
        )?;
        Ok(())
    }

    /// `publicUser(user, db)`.
    fn public_user(user: &Value, memberships: &[Value]) -> Value {
        let user_id = sk_core::js::s(user.get("id"));
        let campaign_memberships: Vec<Value> = memberships
            .iter()
            .filter(|membership| sk_core::js::s(membership.get("userId")) == user_id && membership.get("status").and_then(Value::as_str) != Some("revoked"))
            .map(|membership| {
                let mut entry = Map::new();
                for key in ["campaignId", "role"] {
                    if let Some(value) = membership.get(key) {
                        entry.insert(key.into(), value.clone());
                    }
                }
                entry.insert("heroIds".into(), membership.get("heroIds").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| json!([])));
                if let Some(value) = membership.get("joinedAt") {
                    entry.insert("joinedAt".into(), value.clone());
                }
                Value::Object(entry)
            })
            .collect();
        let mut result = Map::new();
        for key in ["id", "email", "name"] {
            if let Some(value) = user.get(key) {
                result.insert(key.into(), value.clone());
            }
        }
        result.insert("heroIds".into(), user.get("heroIds").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| json!([])));
        result.insert("campaignMemberships".into(), Value::Array(campaign_memberships));
        result.insert("role".into(), user.get("role").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| json!("player")));
        result.insert("engineMode".into(), if user.get("engineMode").and_then(Value::as_str) == Some("enforce") { json!("enforce") } else { Value::Null });
        if let Some(value) = user.get("createdAt") {
            result.insert("createdAt".into(), value.clone());
        }
        Value::Object(result)
    }

    fn public(&self, conn: &Connection, user: &Value) -> AccountResult<Value> {
        Ok(Self::public_user(user, &Self::memberships(conn)?))
    }

    fn build_user(&self, email: &str, password: &str, name: &str, role: &str) -> AccountResult<Value> {
        let normalized = sk_core::text::lower(sk_core::text::trim(email));
        let shaped = normalized
            .split_once('@')
            .is_some_and(|(local, domain)| !local.is_empty() && !local.contains(char::is_whitespace) && domain.split_once('.').is_some_and(|(left, right)| !left.is_empty() && !right.is_empty()) && !domain.contains(char::is_whitespace));
        if !shaped {
            return Err(AccountError::new("Укажите корректную почту"));
        }
        if password.chars().count() < 10 {
            return Err(AccountError::new("Пароль должен содержать не менее 10 символов"));
        }
        let salt = random_salt();
        let hash = hex_encode(&scrypt_hash(password, &salt));
        let conn = self.lock();
        let existing = Self::users(&conn)?;
        if existing.iter().any(|user| user.get("email").and_then(Value::as_str) == Some(normalized.as_str())) {
            return Err(AccountError::new("Аккаунт с такой почтой уже существует"));
        }
        if role == "admin" && existing.iter().any(|user| user.get("role").and_then(Value::as_str) == Some("admin")) {
            return Err(AccountError::new("Учётная запись администратора уже создана"));
        }
        let trimmed_name: String = sk_core::text::head(sk_core::text::trim(name), 60);
        let display = if trimmed_name.is_empty() { normalized.split('@').next().unwrap_or_default().to_string() } else { trimmed_name };
        let user = json!({
            "id": sk_core::hash::uuid_v4(),
            "email": normalized,
            "name": display,
            "passwordSalt": salt,
            "passwordHash": hash,
            "heroIds": [],
            "role": role,
            "createdAt": self.now(),
        });
        Self::save_user(&conn, &user)?;
        self.public(&conn, &user)
    }

    /// `registerUser(input)`.
    pub fn register_user(&self, email: &str, password: &str, name: &str) -> AccountResult<Value> {
        self.build_user(email, password, name, "player")
    }

    /// `hasAdmin()`.
    pub fn has_admin(&self) -> AccountResult<bool> {
        let conn = self.lock();
        Ok(Self::users(&conn)?.iter().any(|user| user.get("role").and_then(Value::as_str) == Some("admin")))
    }

    /// `createAdmin(input, setupToken)`; `expected` — `ADMIN_SETUP_TOKEN`.
    pub fn create_admin(&self, email: &str, password: &str, name: &str, setup_token: &str, expected: &str) -> AccountResult<Value> {
        if expected.is_empty() || setup_token != expected {
            return Err(AccountError::new("Неверный код первоначальной настройки"));
        }
        if self.has_admin()? {
            return Err(AccountError::new("Учётная запись администратора уже создана"));
        }
        self.build_user(email, password, name, "admin")
    }

    /// `verifyUser(email, password)`.
    pub fn verify_user(&self, email: &str, password: &str) -> AccountResult<Option<Value>> {
        let normalized = sk_core::text::lower(sk_core::text::trim(email));
        let conn = self.lock();
        let Some(user) = Self::user_by(&conn, "email", &normalized)? else { return Ok(None) };
        let salt = sk_core::js::s(user.get("passwordSalt"));
        let expected = decode_hex(&sk_core::js::s(user.get("passwordHash")));
        let actual = scrypt_hash(password, &salt);
        if constant_time_eq(&actual, &expected) {
            Ok(Some(self.public(&conn, &user)?))
        } else {
            Ok(None)
        }
    }

    /// `createSession(userId)` — токен для cookie; в базе только его хеш.
    pub fn create_session(&self, user_id: &str) -> AccountResult<String> {
        let token = random_token();
        let conn = self.lock();
        conn.execute("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?1, ?2, ?3)", params![token_hash(&token), user_id, self.now() + SESSION_TTL_MS])?;
        Ok(token)
    }

    /// `userForToken(token)`.
    pub fn user_for_token(&self, token: &str) -> AccountResult<Option<Value>> {
        if token.is_empty() {
            return Ok(None);
        }
        let conn = self.lock();
        let user_id: Option<String> = conn
            .query_row("SELECT user_id FROM sessions WHERE token_hash = ?1 AND expires_at > ?2", params![token_hash(token), self.now()], |row| row.get(0))
            .optional()?;
        let Some(user_id) = user_id else { return Ok(None) };
        let Some(user) = Self::user_by(&conn, "id", &user_id)? else { return Ok(None) };
        Ok(Some(self.public(&conn, &user)?))
    }

    /// `deleteSession(token)`.
    pub fn delete_session(&self, token: &str) -> AccountResult<()> {
        if token.is_empty() {
            return Ok(());
        }
        self.lock().execute("DELETE FROM sessions WHERE token_hash = ?1", params![token_hash(token)])?;
        Ok(())
    }

    /// `sessionKeyForToken(token)`: непрозрачный ключ сессии живого потока.
    pub fn session_key_for_token(token: &str) -> String {
        if token.is_empty() { String::new() } else { token_hash(token) }
    }

    /// `usersForSessionKeys(keys)`: живые пользователи по ключам сессий.
    pub fn users_for_session_keys(&self, keys: &[String]) -> AccountResult<Vec<(String, Value)>> {
        let conn = self.lock();
        let memberships = Self::memberships(&conn)?;
        let mut result: Vec<(String, Value)> = Vec::new();
        for key in keys.iter().filter(|key| !key.is_empty()) {
            if result.iter().any(|(known, _)| known == key) {
                continue;
            }
            let user_id: Option<String> = conn
                .query_row("SELECT user_id FROM sessions WHERE token_hash = ?1 AND expires_at > ?2", params![key, self.now()], |row| row.get(0))
                .optional()?;
            if let Some(user) = match user_id {
                Some(id) => Self::user_by(&conn, "id", &id)?,
                None => None,
            } {
                result.push((key.clone(), Self::public_user(&user, &memberships)));
            }
        }
        Ok(result)
    }

    /// `listUsers()`.
    pub fn list_users(&self) -> AccountResult<Vec<Value>> {
        let conn = self.lock();
        let memberships = Self::memberships(&conn)?;
        Ok(Self::users(&conn)?.iter().map(|user| Self::public_user(user, &memberships)).collect())
    }

    /// `updateUserAccess(userId, patch)`.
    pub fn update_user_access(&self, user_id: &str, patch: AccessPatch) -> AccountResult<Value> {
        let conn = self.lock();
        let Some(mut user) = Self::user_by(&conn, "id", user_id)? else {
            return Err(AccountError::new("Пользователь не найден"));
        };
        if let Some(hero_ids) = patch.hero_ids {
            user["heroIds"] = sk_core::js::strings_value(normalize_hero_ids(&hero_ids));
        }
        if let Some(name) = patch.name.filter(|name| !sk_core::text::trim(name).is_empty()) {
            user["name"] = Value::from(sk_core::text::head(sk_core::text::trim(&name), 60));
        }
        if let Some(role) = patch.role.filter(|role| role == "admin" || role == "player") {
            user["role"] = Value::from(role);
        }
        match patch.engine_mode {
            Some(None) => user["engineMode"] = Value::Null,
            Some(Some(mode)) if mode == "enforce" => user["engineMode"] = Value::from(mode),
            _ => {}
        }
        Self::save_user(&conn, &user)?;
        self.public(&conn, &user)
    }

    /// `campaignMembershipFor(userId, campaignId)`.
    pub fn campaign_membership_for(&self, user_id: &str, campaign_id: &str) -> AccountResult<Option<Value>> {
        let normalized = normalize_campaign_id(campaign_id)?;
        let conn = self.lock();
        Ok(Self::memberships(&conn)?.into_iter().find(|membership| {
            sk_core::js::s(membership.get("userId")) == user_id && sk_core::js::s(membership.get("campaignId")) == normalized && membership.get("status").and_then(Value::as_str) != Some("revoked")
        }))
    }

    /// `campaignHasMemberships(campaignId)`.
    pub fn campaign_has_memberships(&self, campaign_id: &str) -> AccountResult<bool> {
        Ok(!self.list_campaign_memberships(campaign_id)?.is_empty())
    }

    /// `listCampaignMemberships(campaignId)`.
    pub fn list_campaign_memberships(&self, campaign_id: &str) -> AccountResult<Vec<Value>> {
        let normalized = normalize_campaign_id(campaign_id)?;
        let conn = self.lock();
        Ok(Self::memberships(&conn)?
            .into_iter()
            .filter(|membership| sk_core::js::s(membership.get("campaignId")) == normalized && membership.get("status").and_then(Value::as_str) != Some("revoked"))
            .collect())
    }

    /// `upsertCampaignMembership({ campaignId, userId, role, heroIds })`.
    pub fn upsert_campaign_membership(&self, campaign_id: &str, user_id: &str, role: &str, hero_ids: &[String]) -> AccountResult<Value> {
        let normalized = normalize_campaign_id(campaign_id)?;
        let conn = self.lock();
        if Self::user_by(&conn, "id", user_id)?.is_none() {
            return Err(AccountError::new("Пользователь не найден"));
        }
        let clean = normalize_hero_ids(hero_ids);
        let role = if role == "owner" { "owner" } else { "player" };
        let existing = Self::memberships(&conn)?.into_iter().find(|membership| sk_core::js::s(membership.get("campaignId")) == normalized && sk_core::js::s(membership.get("userId")) == user_id);
        let membership = match existing {
            Some(mut membership) => {
                membership["role"] = Value::from(role);
                membership["heroIds"] = sk_core::js::strings_value(clean);
                membership["status"] = Value::from("active");
                membership
            }
            None => json!({ "campaignId": normalized, "userId": user_id, "role": role, "heroIds": clean, "status": "active", "joinedAt": self.now() }),
        };
        Self::save_membership(&conn, &membership)?;
        Ok(membership)
    }

    /// `createCampaignInvite(...)` — токен приглашения и его запись.
    pub fn create_campaign_invite(&self, campaign_id: &str, created_by: &str, hero_ids: &[String], expires_in_ms: Option<i64>, multi_use: bool) -> AccountResult<(String, Value)> {
        let normalized = normalize_campaign_id(campaign_id)?;
        let conn = self.lock();
        let creator = Self::memberships(&conn)?.into_iter().find(|membership| {
            sk_core::js::s(membership.get("campaignId")) == normalized && sk_core::js::s(membership.get("userId")) == created_by && membership.get("status").and_then(Value::as_str) != Some("revoked")
        });
        let account = Self::user_by(&conn, "id", created_by)?;
        let admin = account.as_ref().and_then(|user| user.get("role")).and_then(Value::as_str) == Some("admin");
        let owner = creator.as_ref().and_then(|membership| membership.get("role")).and_then(Value::as_str) == Some("owner");
        if !admin && !owner {
            return Err(AccountError::new("Создавать приглашения может только владелец кампании"));
        }
        let token = random_token();
        let now = self.now();
        let lifetime = expires_in_ms.unwrap_or(7 * 24 * 60 * 60 * 1000).clamp(60_000, 30 * 24 * 60 * 60 * 1000);
        let invite = json!({
            "id": sk_core::hash::uuid_v4(),
            "campaignId": normalized,
            "tokenHash": token_hash(&token),
            "role": "player",
            "heroIds": normalize_hero_ids(hero_ids),
            "multiUse": multi_use,
            "redemptions": [],
            "createdBy": created_by,
            "createdAt": now,
            "expiresAt": now + lifetime,
            "usedAt": null,
            "usedBy": null,
            "revokedAt": null,
        });
        Self::save_invite(&conn, &invite)?;
        Ok((token, invite))
    }

    fn save_invite(conn: &Connection, invite: &Value) -> AccountResult<()> {
        let seq: i64 = conn.query_row("SELECT COALESCE(MAX(seq), 0) + 1 FROM invites", [], |row| row.get(0))?;
        conn.execute(
            "INSERT INTO invites (id, campaign_id, token_hash, seq, body) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(id) DO UPDATE SET body = excluded.body",
            params![sk_core::js::s(invite.get("id")), sk_core::js::s(invite.get("campaignId")), sk_core::js::s(invite.get("tokenHash")), seq, serde_json::to_string(invite)?],
        )?;
        Ok(())
    }

    /// `redeemCampaignInvite(...)`: членство и признак повтора.
    pub fn redeem_campaign_invite(&self, campaign_id: &str, token: &str, user_id: &str, unavailable_hero_ids: &[String]) -> AccountResult<(Value, bool)> {
        let normalized = normalize_campaign_id(campaign_id)?;
        let conn = self.lock();
        let body: Option<String> = conn
            .query_row("SELECT body FROM invites WHERE campaign_id = ?1 AND token_hash = ?2 ORDER BY seq LIMIT 1", params![normalized, token_hash(token)], |row| row.get(0))
            .optional()?;
        let Some(mut invite) = body.map(|text| serde_json::from_str::<Value>(&text)).transpose()? else {
            return Err(AccountError::new("Приглашение недействительно"));
        };
        if sk_core::js::truthy(invite.get("revokedAt")) {
            return Err(AccountError::new("Приглашение недействительно"));
        }
        let now = self.now();
        if sk_core::js::number(invite.get("expiresAt")) <= now as f64 {
            return Err(AccountError::new("Срок действия приглашения истёк"));
        }
        let memberships = Self::memberships(&conn)?;
        let in_campaign = |membership: &&Value| sk_core::js::s(membership.get("campaignId")) == normalized;
        let active = |membership: &&Value| membership.get("status").and_then(Value::as_str) != Some("revoked");
        let assigned: Vec<String> = memberships.iter().filter(in_campaign).filter(active).flat_map(|membership| strings(membership.get("heroIds"))).collect();
        let invite_heroes = strings(invite.get("heroIds"));
        if sk_core::js::truthy(invite.get("multiUse")) {
            let existing = memberships.iter().filter(in_campaign).filter(active).find(|membership| sk_core::js::s(membership.get("userId")) == user_id).cloned();
            let previous = invite.get("redemptions").and_then(Value::as_array).is_some_and(|list| list.iter().any(|entry| sk_core::js::s(entry.get("userId")) == user_id));
            if previous {
                if let Some(existing) = existing {
                    return Ok((existing, true));
                }
                return Err(AccountError::new("Это приглашение уже использовано вашим аккаунтом"));
            }
            if existing.is_some() {
                return Err(AccountError::new("Вы уже состоите в этой кампании"));
            }
            let taken = if invite_heroes.len() > 1 { normalize_hero_ids(unavailable_hero_ids) } else { Vec::new() };
            let Some(hero_id) = invite_heroes.iter().find(|candidate| !assigned.contains(candidate) && !taken.contains(candidate)).cloned() else {
                return Err(AccountError { message: "В кампании не осталось свободных героев".into(), code: Some("CAMPAIGN_FULL") });
            };
            let membership = json!({ "campaignId": normalized, "userId": user_id, "role": invite.get("role").cloned().unwrap_or(Value::Null), "heroIds": [hero_id], "status": "active", "joinedAt": now });
            Self::save_membership(&conn, &membership)?;
            let mut redemptions = invite.get("redemptions").and_then(Value::as_array).cloned().unwrap_or_default();
            redemptions.push(json!({ "userId": user_id, "heroId": hero_id, "redeemedAt": now }));
            invite["redemptions"] = Value::Array(redemptions);
            Self::save_invite(&conn, &invite)?;
            return Ok((membership, false));
        }
        let used = sk_core::js::truthy(invite.get("usedAt"));
        let used_by_me = sk_core::js::s(invite.get("usedBy")) == user_id;
        if used && !used_by_me {
            return Err(AccountError::new("Приглашение уже использовано"));
        }
        let existing = memberships.iter().filter(in_campaign).find(|membership| sk_core::js::s(membership.get("userId")) == user_id).cloned();
        if used && used_by_me {
            if let Some(existing) = existing {
                return Ok((existing, true));
            }
        }
        if existing.is_some() {
            return Err(AccountError::new("Вы уже состоите в этой кампании"));
        }
        if invite_heroes.iter().any(|hero| assigned.contains(hero)) {
            return Err(AccountError::new("Герой из приглашения уже назначен другому игроку"));
        }
        let membership = json!({ "campaignId": normalized, "userId": user_id, "role": invite.get("role").cloned().unwrap_or(Value::Null), "heroIds": normalize_hero_ids(&invite_heroes), "status": "active", "joinedAt": now });
        Self::save_membership(&conn, &membership)?;
        invite["usedAt"] = Value::from(now);
        invite["usedBy"] = Value::from(user_id);
        Self::save_invite(&conn, &invite)?;
        Ok((membership, false))
    }

    fn settings_key(code: &str) -> AccountResult<String> {
        let safe: String = code.to_uppercase().chars().filter(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || *ch == '-').take(24).collect();
        if safe.is_empty() {
            return Err(AccountError::new("Некорректный код кампании"));
        }
        Ok(safe)
    }

    /// `getCampaignAiSettings(code)`.
    pub fn get_campaign_ai_settings(&self, code: &str) -> AccountResult<CampaignAiSettings> {
        let key = Self::settings_key(code)?;
        let body: Option<String> = self.lock().query_row("SELECT body FROM campaign_settings WHERE campaign_id = ?1", params![key], |row| row.get(0)).optional()?;
        let value: Value = match body {
            Some(text) => serde_json::from_str(&text)?,
            None => json!({}),
        };
        if !value.is_object() {
            return Err(AccountError::new(format!("Хранилище повреждено и не будет перезаписано автоматически: campaign-settings/{key}.json")));
        }
        let text = |field: &str, fallback: &str| sk_core::text::trim(&value.get(field).filter(|v| !v.is_null()).map_or_else(|| fallback.to_string(), |v| sk_core::js::s(Some(v)))).to_string();
        Ok(CampaignAiSettings { model: text("model", ""), narrator_style: text("narratorStyle", "neutral"), improv_mode: text("improvMode", "story"), reasoning_level: text("reasoningLevel", "auto") })
    }

    /// `saveCampaignAiSettings(code, settings)`.
    pub fn save_campaign_ai_settings(&self, code: &str, settings: &CampaignAiSettings) -> AccountResult<Value> {
        let key = Self::settings_key(code)?;
        let value = json!({
            "model": sk_core::text::trim(&settings.model),
            "narratorStyle": sk_core::text::trim(&settings.narrator_style),
            "improvMode": sk_core::text::trim(&settings.improv_mode),
            "reasoningLevel": sk_core::text::trim(&settings.reasoning_level),
            "updatedAt": sk_core::clock::iso(self.now()),
        });
        self.lock().execute(
            "INSERT INTO campaign_settings (campaign_id, body) VALUES (?1, ?2) ON CONFLICT(campaign_id) DO UPDATE SET body = excluded.body",
            params![key, serde_json::to_string(&value)?],
        )?;
        Ok(value)
    }

    /// Перенести `storage/auth.json` и `storage/campaign-settings/*.json`
    /// прежнего сервера. Уже перенесённые записи не дублируются.
    pub fn import_legacy(&self, storage_dir: impl AsRef<Path>) -> AccountResult<(usize, usize)> {
        let storage_dir = storage_dir.as_ref();
        let auth_path = storage_dir.join("auth.json");
        let mut users = 0;
        let conn = self.lock();
        if auth_path.exists() {
            let auth: Value = serde_json::from_str(&std::fs::read_to_string(&auth_path).map_err(|error| AccountError::new(format!("auth.json: {error}")))?)?;
            for user in auth.get("users").and_then(Value::as_array).into_iter().flatten() {
                if Self::user_by(&conn, "id", &sk_core::js::s(user.get("id")))?.is_none() {
                    Self::save_user(&conn, user)?;
                    users += 1;
                }
            }
            for session in auth.get("sessions").and_then(Value::as_array).into_iter().flatten() {
                conn.execute(
                    "INSERT OR IGNORE INTO sessions (token_hash, user_id, expires_at) VALUES (?1, ?2, ?3)",
                    params![sk_core::js::s(session.get("tokenHash")), sk_core::js::s(session.get("userId")), sk_core::js::safe_int(session.get("expiresAt"), 0)],
                )?;
            }
            for membership in auth.get("memberships").and_then(Value::as_array).into_iter().flatten() {
                let exists: Option<i64> = conn
                    .query_row(
                        "SELECT 1 FROM memberships WHERE campaign_id = ?1 AND user_id = ?2",
                        params![sk_core::js::s(membership.get("campaignId")), sk_core::js::s(membership.get("userId"))],
                        |row| row.get(0),
                    )
                    .optional()?;
                if exists.is_none() {
                    Self::save_membership(&conn, membership)?;
                }
            }
            for invite in auth.get("invites").and_then(Value::as_array).into_iter().flatten() {
                let exists: Option<i64> = conn.query_row("SELECT 1 FROM invites WHERE id = ?1", params![sk_core::js::s(invite.get("id"))], |row| row.get(0)).optional()?;
                if exists.is_none() {
                    Self::save_invite(&conn, invite)?;
                }
            }
        }
        let mut settings = 0;
        for entry in std::fs::read_dir(storage_dir.join("campaign-settings")).into_iter().flatten().filter_map(Result::ok) {
            let path = entry.path();
            let Some(stem) = path.file_stem().map(|stem| stem.to_string_lossy().to_string()) else { continue };
            if path.extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
            settings += conn.execute("INSERT OR IGNORE INTO campaign_settings (campaign_id, body) VALUES (?1, ?2)", params![stem, serde_json::to_string(&value)?])?;
        }
        Ok((users, settings))
    }
}

fn decode_hex(text: &str) -> Vec<u8> {
    if text.len() % 2 != 0 {
        return Vec::new();
    }
    (0..text.len()).step_by(2).filter_map(|index| u8::from_str_radix(&text[index..index + 2], 16).ok()).collect()
}

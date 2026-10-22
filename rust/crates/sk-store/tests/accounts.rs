//! Аккаунты: совместимость паролей с Node, сессии, членство, приглашения,
//! перенос `storage/auth.json`.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use sk_store::accounts::{AccessPatch, Accounts, CampaignAiSettings};

fn accounts_at(now: Arc<AtomicI64>) -> Accounts {
    Accounts::in_memory().expect("аккаунты").with_clock(Arc::new(move || now.load(Ordering::SeqCst)))
}

#[test]
fn legacy_user_logs_in_with_the_node_scrypt_password() {
    let dir = tempfile::tempdir().expect("каталог");
    // Хеш снят `crypto.scryptSync('пароль-героя-42', salt, 64)` в Node.
    let auth = json!({
        "users": [{
            "id": "u-1", "email": "hero@example.com", "name": "Герой",
            "passwordSalt": "0123456789abcdef0123456789abcdef",
            "passwordHash": "599362de7461db5abf1408957a5ca6e57a56ba073dffd9ea20d21f68bb79df64b429495b8429bbedefedd7e1a20fc1163cbfd22c9d1208acb31325cbcf2d538c",
            "heroIds": ["hero-a"], "role": "player", "createdAt": 1
        }],
        "sessions": [],
        "memberships": [{ "campaignId": "ASTOHAN", "userId": "u-1", "role": "owner", "heroIds": ["hero-a"], "status": "active", "joinedAt": 2 }],
        "invites": []
    });
    std::fs::write(dir.path().join("auth.json"), auth.to_string()).expect("запись");
    std::fs::create_dir_all(dir.path().join("campaign-settings")).expect("каталог");
    std::fs::write(dir.path().join("campaign-settings").join("ASTOHAN.json"), r#"{"model":"luna","narratorStyle":"noir"}"#).expect("запись");

    let accounts = Accounts::in_memory().expect("аккаунты");
    assert_eq!(accounts.import_legacy(dir.path()).expect("перенос"), (1, 1));
    assert_eq!(accounts.import_legacy(dir.path()).expect("повтор").0, 0, "повторный перенос не дублирует");
    let user = accounts.verify_user(" Hero@Example.com ", "пароль-героя-42").expect("проверка").expect("пароль подходит");
    assert_eq!(user["id"], "u-1");
    assert_eq!(user["campaignMemberships"], json!([{ "campaignId": "ASTOHAN", "role": "owner", "heroIds": ["hero-a"], "joinedAt": 2 }]));
    assert_eq!(user["engineMode"], Value::Null);
    assert!(accounts.verify_user("hero@example.com", "неверный-пароль").expect("проверка").is_none());
    let settings = accounts.get_campaign_ai_settings("astohan").expect("настройки");
    assert_eq!(settings, CampaignAiSettings { model: "luna".into(), narrator_style: "noir".into(), improv_mode: "story".into(), reasoning_level: "auto".into() });
}

/// Эталон — `buildUser` JS (`store.mjs:110–112`): почта —
/// `/^\S+@\S+\.\S+$/`, длина пароля — в единицах UTF-16.
#[test]
fn email_and_password_checks_like_js() {
    let accounts = Accounts::in_memory().expect("аккаунты");
    let five_emoji = "😀".repeat(5);
    assert!(accounts.register_user("emoji@mail.ru", &five_emoji, "").is_ok(), "пять эмодзи — десять единиц UTF-16");
    assert_eq!(accounts.register_user("emoji2@mail.ru", &"😀".repeat(4), "").expect_err("коротко").message, "Пароль должен содержать не менее 10 символов");
    assert!(accounts.register_user("a@.b.c", "длинный-пароль", "").is_ok(), "`\\S+` после @ — это «.b»");
    for email in ["a@b\u{feff}.ru", "@a.ru", "a@b.", "a@.ru", "a@b", "a b@c.ru"] {
        assert_eq!(accounts.register_user(email, "длинный-пароль", "").expect_err(email).message, "Укажите корректную почту", "{email:?}");
    }
    assert!(accounts.register_user("@x@y.ru", "длинный-пароль", "").is_ok(), "`\\S+` до @ может содержать @");
}

#[test]
fn registration_sessions_and_access() {
    let now = Arc::new(AtomicI64::new(1_000));
    let accounts = accounts_at(now.clone());
    assert_eq!(accounts.register_user("bad", "длинный-пароль", "").expect_err("почта").message, "Укажите корректную почту");
    assert_eq!(accounts.register_user("a@b.ru", "short", "").expect_err("пароль").message, "Пароль должен содержать не менее 10 символов");
    let user = accounts.register_user("Player@Mail.ru", "длинный-пароль", "").expect("регистрация");
    assert_eq!(user["email"], "player@mail.ru");
    assert_eq!(user["name"], "player");
    assert_eq!(accounts.register_user("player@mail.ru", "длинный-пароль", "").expect_err("повтор").message, "Аккаунт с такой почтой уже существует");
    assert!(!accounts.has_admin().expect("админ"));
    assert_eq!(accounts.create_admin("gm@mail.ru", "длинный-пароль", "ГМ", "x", "").expect_err("без кода").message, "Неверный код первоначальной настройки");
    let admin = accounts.create_admin("gm@mail.ru", "длинный-пароль", "ГМ", "secret-code", "secret-code").expect("админ");
    assert_eq!(admin["role"], "admin");

    let user_id = user["id"].as_str().expect("id").to_string();
    let token = accounts.create_session(&user_id).expect("сессия");
    assert_eq!(accounts.user_for_token(&token).expect("пользователь").expect("есть")["id"], user_id.as_str());
    let key = Accounts::session_key_for_token(&token);
    assert_eq!(accounts.users_for_session_keys(&[key.clone(), key.clone()]).expect("ключи").len(), 1);
    now.store(1_000 + 31 * 24 * 60 * 60 * 1000, Ordering::SeqCst);
    assert!(accounts.user_for_token(&token).expect("пользователь").is_none(), "сессия истекла");
    now.store(2_000, Ordering::SeqCst);
    accounts.delete_session(&token).expect("выход");
    assert!(accounts.user_for_token(&token).expect("пользователь").is_none());

    let updated = accounts
        .update_user_access(&user_id, AccessPatch { hero_ids: Some(vec!["hero-a".into(), "hero-a".into(), "bad id".into()]), engine_mode: Some(Some("enforce".into())), ..Default::default() })
        .expect("доступ");
    assert_eq!(updated["heroIds"], json!(["hero-a"]));
    assert_eq!(updated["engineMode"], "enforce");
}

#[test]
fn invites_hand_out_free_heroes_and_reject_reuse() {
    let now = Arc::new(AtomicI64::new(10_000));
    let accounts = accounts_at(now.clone());
    let owner = accounts.register_user("owner@mail.ru", "длинный-пароль", "").expect("владелец")["id"].as_str().expect("id").to_string();
    let guest = accounts.register_user("guest@mail.ru", "длинный-пароль", "").expect("гость")["id"].as_str().expect("id").to_string();
    let third = accounts.register_user("third@mail.ru", "длинный-пароль", "").expect("третий")["id"].as_str().expect("id").to_string();
    assert_eq!(accounts.create_campaign_invite("RUN-1", &guest, &[], None, false).expect_err("не владелец").message, "Создавать приглашения может только владелец кампании");
    accounts.upsert_campaign_membership("run-1", &owner, "owner", &["hero-a".into()]).expect("владелец");
    let (token, invite) = accounts.create_campaign_invite("RUN-1", &owner, &["hero-a".into(), "hero-b".into(), "hero-c".into()], None, true).expect("приглашение");
    assert_eq!(invite["expiresAt"], 10_000 + 7 * 24 * 60 * 60 * 1000);

    let (membership, duplicate) = accounts.redeem_campaign_invite("RUN-1", &token, &guest, &["hero-b".into()]).expect("гость вошёл");
    assert!(!duplicate);
    assert_eq!(membership["heroIds"], json!(["hero-c"]), "многоместная ссылка пропускает занятых и уже созданных героев");
    let (_, again) = accounts.redeem_campaign_invite("RUN-1", &token, &guest, &[]).expect("повтор");
    assert!(again);
    let full = accounts.redeem_campaign_invite("RUN-1", &token, &third, &["hero-b".into()]).expect_err("мест нет");
    assert_eq!(full.code, Some("CAMPAIGN_FULL"));

    let (single, _) = accounts.create_campaign_invite("RUN-1", &owner, &["hero-b".into()], Some(1), false).expect("одноразовое");
    now.store(10_000 + 60_001, Ordering::SeqCst);
    assert_eq!(accounts.redeem_campaign_invite("RUN-1", &single, &third, &[]).expect_err("истекло").message, "Срок действия приглашения истёк");
    assert_eq!(accounts.redeem_campaign_invite("RUN-1", "чужой", &third, &[]).expect_err("нет").message, "Приглашение недействительно");
    assert_eq!(accounts.list_campaign_memberships("run-1").expect("члены").len(), 2);
    assert!(accounts.campaign_membership_for(&guest, "RUN-1").expect("членство").is_some());
}

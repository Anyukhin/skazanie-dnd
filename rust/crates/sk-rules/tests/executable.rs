//! Доказательство исполнимости (урок 8 плана переноса): единственный путь от
//! карточки к обработчику исполнения. Коды и тексты отказов — прежние
//! (`assertMechanicsSupported`, эталон — `fixtures/core.json`, тест `core`);
//! здесь — то, чего нет в эталоне: карточка из состояния или команды с чужим
//! статусом и доступ к карточке через доказательство.

use serde_json::json;
use sk_core::MechanicsSupport;
use sk_rules::executable::Executable;

#[test]
fn only_verified_and_partial_cards_are_admitted() {
    for (status, support) in [("verified", MechanicsSupport::Verified), ("partial", MechanicsSupport::Partial)] {
        let card = json!({ "id": "dash", "mechanicsSupport": status, "effect": { "kind": "dash" } });
        let proof = Executable::admit(Some(card.clone()), "действия").expect("исполнимо");
        assert_eq!(proof.support(), support);
        assert_eq!(proof.card(), &card);
        assert_eq!(proof.get("effect"), card.get("effect"), "доказательство читается как карточка");
        assert_eq!(proof.into_card(), card);
    }
}

#[test]
fn blocked_cards_keep_their_refusals() {
    let heuristic = Executable::admit(Some(json!({ "mechanicsSupport": "heuristic", "supportNote": "не важно" })), "заклинания").unwrap_err();
    assert_eq!((heuristic.code.as_str(), heuristic.message.as_str()), ("MECHANICS_NOT_VERIFIED", "Механика заклинания ещё не проверена для авторитетного боя"));

    let ruling = Executable::admit(Some(json!({ "mechanicsSupport": "ruling-only", "supportNote": "  Нужен ведущий. " })), "действия").unwrap_err();
    assert_eq!((ruling.code.as_str(), ruling.message.as_str()), ("RULING_REQUIRED", "Для действия требуется серверное решение правил: Нужен ведущий."));

    // Карточка из состояния кампании или команды не проходила строгий разбор
    // каталога: незнакомый статус там — не исполнимое, как и в JS.
    for card in [Some(json!({ "mechanicsSupport": "verifed" })), Some(json!({ "mechanicsSupport": ["verified"] })), Some(json!({})), Some(json!(null)), None] {
        let error = Executable::admit(card.clone(), "заклинания предмета").unwrap_err();
        assert_eq!((error.code.as_str(), error.message.as_str()), ("RULING_REQUIRED", "Для заклинания предмета требуется серверное решение правил"), "{card:?}");
    }
}

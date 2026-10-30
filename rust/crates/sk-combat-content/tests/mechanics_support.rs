//! Статус механики — тип (урок 8 плана переноса): каталог заклинаний с
//! опечаткой в статусе не загружается, а каждая карточка встроенных каталогов
//! заклинаний и действий разбирается в [`MechanicsSupport`].

use serde_json::json;
use sk_combat_content::{combat_actions, combat_spells};
use sk_core::MechanicsSupport;

fn payload() -> serde_json::Value {
    json!({ "spells": [
        { "id": "fire-bolt", "name": "Огненный снаряд", "level": 0, "kind": "attack" },
        { "id": "bless", "name": "Благословение", "level": 1, "kind": "buff" },
        { "id": "wish", "name": "Исполнение желаний", "level": 6, "kind": "utility" },
    ] })
}

#[test]
fn statuses_load_from_overrides_and_defaults() {
    let overrides = json!({ "spells": { "fire-bolt": { "mechanicsSupport": "verified" }, "bless": {} } });
    let cards = combat_spells::load_spell_cards(&payload(), &overrides).expect("каталог загружается");
    let statuses: Vec<_> = cards.iter().map(|card| MechanicsSupport::of(card.get("mechanicsSupport"))).collect();
    assert_eq!(statuses, [Some(MechanicsSupport::Verified), Some(MechanicsSupport::Partial), Some(MechanicsSupport::Heuristic)]);
}

#[test]
fn typo_in_status_fails_the_load_and_names_the_card() {
    let overrides = json!({ "spells": { "fire-bolt": { "mechanicsSupport": "verified" }, "bless": { "mechanicsSupport": "verifed" } } });
    let error = combat_spells::load_spell_cards(&payload(), &overrides).expect_err("опечатка не загружается");
    assert_eq!(error.card, "bless");
    let message = error.to_string();
    assert!(message.contains("«bless»") && message.contains("\"verifed\""), "{message}");

    let not_a_string = json!({ "spells": { "wish": { "mechanicsSupport": 1 } } });
    assert_eq!(combat_spells::load_spell_cards(&payload(), &not_a_string).expect_err("число — не статус").card, "wish");
}

#[test]
fn typo_in_2014_status_fails_the_load() {
    let overrides = json!({ "spells": { "bless": { "mechanicsSupport": "partial", "mechanics2014": { "mechanicsSupport": "rulling-only" } } } });
    let error = combat_spells::load_spell_cards(&payload(), &overrides).expect_err("опечатка редакции 2014");
    assert_eq!(error.card, "bless (dnd_5e_2014)");
}

#[test]
fn every_builtin_spell_card_parses_in_both_rulesets() {
    for options in [None, Some(json!({ "rulesetId": "dnd_5e_2014" }))] {
        let census = combat_spells::spell_catalog_census(options.as_ref());
        let info = combat_spells::spell_catalog_info(options.as_ref());
        assert_eq!(json!(census.total()), info["count"]);
        assert_eq!(json!(census.count(MechanicsSupport::Verified)), info["verifiedMechanics"]);
        assert_eq!(json!(census.count(MechanicsSupport::Partial)), info["partialMechanics"]);
        assert_eq!(json!(census.count(MechanicsSupport::Heuristic)), info["heuristicMechanics"]);
        assert_eq!(json!(census.count(MechanicsSupport::RulingOnly)), info["rulingOnlyMechanics"]);
        assert_eq!(census.blocked().len(), census.count(MechanicsSupport::Heuristic) + census.count(MechanicsSupport::RulingOnly));
        assert!(census.count(MechanicsSupport::Heuristic) > 0 && census.count(MechanicsSupport::Partial) > 0, "{census:?}");
        for id in census.blocked() {
            let card = combat_spells::canonical_combat_spell_for(Some(&json!(id)), options.as_ref()).expect("карточка из каталога");
            assert!(!MechanicsSupport::executable(card.get("mechanicsSupport")), "{id}");
        }
    }
}

#[test]
fn every_builtin_action_card_parses() {
    let census = combat_actions::combat_action_catalog_census();
    assert!(census.total() > 100, "{census:?}");
    assert!(census.count(MechanicsSupport::Verified) > 0 && census.count(MechanicsSupport::Partial) > 0);
    // Памятка «Коварной атаки» — `ruling-only` ручной карточки, каталог dnd.su
    // целиком — `heuristic` или `ruling-only`.
    assert!(census.blocked().iter().any(|id| id == "sneak-attack"), "{:?}", census.blocked());
    assert!(census.count(MechanicsSupport::Heuristic) > 0);
}

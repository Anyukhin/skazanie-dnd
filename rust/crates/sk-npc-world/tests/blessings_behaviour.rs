//! Проверки `test/blessings.test.mjs` в части самого модуля — над
//! состояниями часовни, которые генератор эталона собрал настоящим Rules
//! Engine (метки `fixtures/blessings.json`).

mod common;

use common::Fixture;
use serde_json::{json, Value};
use sk_npc_world::blessings::*;

const PRIEST: &str = "father";
const SMITH: &str = "smith";

fn fixture() -> Fixture {
    Fixture::load(include_str!("../fixtures/blessings.json"))
}

#[test]
fn priest_is_recognised_by_profile_role_not_by_tag_or_name() {
    let priest = |role: &str| is_priest_profile(Some(&json!({ "role": role })));
    for role in [
        "жрец Утренней зари", "настоятельница обители", "монах", "жрица", "иеромонах", "монашка", "монахиня", "священник", "священница", "священнослужитель",
        "хранитель святилища", "хранительница святилища", "служитель храма", "служительница богов", "послушник", "клирик", "проповедник", "priest", "acolyte", "monk",
    ] {
        assert!(priest(role), "{role}: служитель обязан опознаваться");
    }
    for role in ["кузнец", "мономах", "освященный страж", "посвященный", "священный воин", "служитель закона", "поединок", "монтажник"] {
        assert!(!priest(role), "{role}: служителем быть не должен");
    }
    assert!(!is_priest_profile(Some(&json!({ "role": "кузнец", "tags": ["faction:priesthood-of-dawn"] }))));
    assert!(!is_priest_profile(Some(&json!({ "role": "нищий", "tags": ["свяще"] }))));
    let fixture = fixture();
    let priests: Vec<String> = blessing_priests_for(fixture.labelled("chapel")).into_iter().map(|npc| npc.id).collect();
    assert_eq!(priests, vec![PRIEST.to_string()]);
    assert!(is_blessing_priest(fixture.labelled("chapel"), &json!(PRIEST)));
    assert!(!is_blessing_priest(fixture.labelled("chapel"), &json!(SMITH)));
}

#[test]
fn donation_goes_to_the_priest_factions_and_none_without_a_tag() {
    let fixture = fixture();
    assert_eq!(blessing_faction_ids_for(fixture.labelled("chapel"), &json!(PRIEST)), vec!["temple-dawn".to_string()]);
    assert!(blessing_faction_ids_for(fixture.labelled("chapel-no-factions"), &json!(PRIEST)).is_empty());
    assert!(blessing_faction_ids_for(fixture.labelled("chapel"), &json!("ghost")).is_empty());
}

#[test]
fn successful_prayer_blesses_and_closes_the_day() {
    let fixture = fixture();
    let blessed = fixture.labelled("prayed-blessed");
    assert!(hero_is_blessed(blessed, &json!("hero")));
    let record = blessing_record_for(blessed, &json!("hero")).expect("запись");
    assert_eq!(record["source"], "shrine");
    assert_eq!(record["granted"], true);
    assert!(!blessing_availability_for(blessed, &json!("hero"), Some(&json!(0))).available);
    // Провал и знамение сутки закрывают, но благословением не являются.
    for label in ["prayed-silence", "prayed-omen"] {
        let state = fixture.labelled(label);
        assert!(!hero_is_blessed(state, &json!("hero")), "{label}");
        assert_eq!(blessing_record_for(state, &json!("hero")).map(|record| record["granted"].clone()), Some(json!(false)), "{label}");
    }
}

#[test]
fn a_day_later_prayer_is_open_again() {
    let fixture = fixture();
    let closed = fixture.labelled("day-closed");
    let now = blessing_availability_for(closed, &json!("hero"), Some(&json!(10)));
    assert_eq!(now, BlessingAvailability { available: false, next_at_minutes: 1_440.0, waits_minutes: 1_430.0 });
    assert!(blessing_availability_for(closed, &json!("hero"), Some(&json!(BLESSING_COOLDOWN_MINUTES))).available);
    // Сутки прошли, а благословение ещё висит: слот и срок — два разных числа.
    let still = fixture.labelled("still-blessed");
    assert!(hero_is_blessed(still, &json!("hero")));
    assert!(blessing_availability_for(still, &json!("hero"), Some(&json!(1_441))).available);
}

#[test]
fn registry_is_normalised_and_junk_does_not_survive() {
    let normalized = normalize_blessing_state(Some(&json!({
        "heroes": {
            "hero": { "at_minutes": 120, "source": "priest", "granted": true, "place_name": "Придорожная часовня", "npc_id": PRIEST, "npc_name": "Отец Никодим" },
            "": { "at_minutes": 10 },
            "broken": "нет",
            "weird": { "at_minutes": -5, "source": "дракон", "granted": "да" },
        },
    })));
    assert_eq!(normalized["heroes"]["hero"]["at_minutes"], 120);
    assert!(normalized["heroes"].get("").is_none());
    assert!(normalized["heroes"].get("broken").is_none());
    assert_eq!(normalized["heroes"]["weird"], json!({ "at_minutes": 0, "source": "shrine", "granted": false, "place_name": "", "npc_id": "", "npc_name": "" }));
}

#[test]
fn viewer_card_is_assembled_by_the_server_without_the_raw_registry() {
    let fixture = fixture();
    let card = blessings_for_viewer(fixture.labelled("asked-priest"), &json!({ "playerId": "hero" }));
    assert_eq!(card["blessed"], true);
    assert_eq!(card["available"], false);
    assert_eq!(card["donation_cp"], BLESSING_DONATION_CP);
    assert_eq!(card["prayer_dc"], PRAYER_DC);
    assert_eq!(card["priests"], json!([{ "id": PRIEST, "name": "Отец Никодим", "role": "жрец Утренней зари" }]));
    assert_eq!(card["last"]["source"], "priest");
    assert!(card.get("heroes").is_none());
    let empty = blessings_for_viewer(fixture.labelled("chapel"), &json!({ "playerId": "hero" }));
    assert_eq!((empty["blessed"].clone(), empty["available"].clone(), empty["last"].clone()), (json!(false), json!(true), Value::Null));
}

#[test]
fn reducer_closes_the_day_by_attempt() {
    let prayed = apply_blessing_event(None, &json!({ "event_type": "ShrinePrayerResolved", "payload": { "hero_id": "hero", "at_minutes": 30, "outcome": "silence", "place_name": "Часовня" } }), &json!({}));
    assert_eq!(prayed["heroes"]["hero"], json!({ "at_minutes": 30, "source": "shrine", "granted": false, "place_name": "Часовня", "npc_id": "", "npc_name": "" }));
    let granted = apply_blessing_event(Some(&prayed), &json!({ "event_type": "NpcBlessingGranted", "actor_id": "hero", "payload": { "at_minutes": 2_000, "npc_id": PRIEST } }), &json!({}));
    assert_eq!(granted["heroes"]["hero"]["source"], "priest");
    assert_eq!(granted["heroes"]["hero"]["granted"], true);
    // Своей версии срез на прочих событиях возвращается как есть.
    let raw = json!({ "schema_version": 1, "heroes": { "x": "junk" } });
    assert_eq!(apply_blessing_event(Some(&raw), &json!({ "event_type": "Other" }), &json!({})), raw);
}

#[test]
fn omen_is_deterministic_and_proto_keys_read_like_js() {
    assert_eq!(blessing_omen_for(Some(&json!("hero:1"))), blessing_omen_for(Some(&json!("hero:1"))));
    let mut heroes = serde_json::Map::new();
    heroes.insert("__proto__".into(), json!({ "at_minutes": 30, "source": "shrine", "granted": false }));
    let state = json!({ "blessings": { "heroes": heroes } });
    assert_eq!(normalize_blessing_state(state.get("blessings")), json!({ "schema_version": 1, "heroes": {} }));
    assert_eq!(blessing_record_for(&state, &json!("__proto__")).map(|record| record["at_minutes"].clone()), Some(json!(30)));
    // Поле записи-прототипа находится по своему имени.
    assert_eq!(blessing_record_for(&state, &json!("source")), Some(json!("shrine")));
    assert_eq!(blessing_record_for(&state, &json!("constructor")), Some(json!({})));
    let availability = blessing_availability_for(&state, &json!("constructor"), Some(&json!(10)));
    assert!(!availability.available && availability.next_at_minutes.is_nan());
    assert_eq!(blessings_for_viewer(&state, &json!({ "playerId": "constructor" }))["last"], json!({}));
}

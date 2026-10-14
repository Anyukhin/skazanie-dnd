//! Сверка `character_creation_feats` с эталоном JS.

mod common;

use common::{check, ok, ok_or_null, Outcome};
use serde_json::{json, Map, Value};
use sk_ruleset::character_creation_feats as m;

fn table(lists: &[m::ClassSpellList]) -> Value {
    Value::Object(lists.iter().map(|(class_key, ids)| (class_key.to_string(), json!(ids))).collect::<Map<_, _>>())
}

#[test]
fn feats_match_js() {
    let count = check(include_str!("../fixtures/character-creation-feats.json"), |name, args| -> Outcome {
        match name {
            "const:PHB_2014_FEATS_SOURCE" => ok(m::PHB_2014_FEATS_SOURCE.clone()),
            "const:ABILITY_IDS" => ok(json!(m::ABILITY_IDS)),
            "const:PHB_CANTRIPS" => ok(table(&m::PHB_CANTRIPS)),
            "const:PHB_FIRST_LEVEL_SPELLS" => ok(table(&m::PHB_FIRST_LEVEL_SPELLS)),
            "const:PHB_RITUALS" => ok(table(&m::PHB_RITUALS)),
            "const:PHB_MARTIAL_ADEPT_MANEUVER_IDS" => ok(json!(m::PHB_MARTIAL_ADEPT_MANEUVER_IDS)),
            "const:PHB_2014_FEATS" => ok(Value::Array(m::PHB_2014_FEATS.clone())),
            "characterCreationFeatFor" => ok_or_null(m::character_creation_feat_for(args.get(0))),
            "listCharacterCreationFeats" => ok(m::list_character_creation_feats(args.get(0))),
            "resolveCharacterCreationFeat" => ok(m::resolve_character_creation_feat(args.get(0), args.get(1), args.get(2))),
            "isClassSpellAvailable" => ok(json!(m::is_class_spell_available(args.get(0), &args.s(1), args.get(2)))),
            other => panic!("нет сверки для {other}"),
        }
    });
    assert!(count > 3000);
}

/// Перенос `test/character-creation-feats.test.mjs` (часть, не покрытая
/// эталоном напрямую).
#[test]
fn feat_descriptions_are_full_rules_text() {
    let joined = |id: &str| -> String {
        m::character_creation_feat_for(Some(&json!(id)))
            .and_then(|feat| feat["description"].as_array().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" ")
    };
    for feat in m::PHB_2014_FEATS.iter() {
        let paragraphs = feat["description"].as_array().cloned().unwrap_or_default();
        assert!(!paragraphs.is_empty(), "{}", feat["id"]);
        assert!(paragraphs.iter().all(|paragraph| paragraph.as_str().is_some_and(|text| !text.trim().is_empty())));
        assert!(!paragraphs.iter().any(|paragraph| paragraph.as_str().is_some_and(|text| text.contains("Механика применяется частично"))));
    }
    assert!(joined("lucky").contains("3 очка удачи"));
    assert!(joined("polearm-master").contains("пик"));
    assert!(sk_core::text::test(sk_core::re!(r"2 часа за каждый уровень.*50 зм за каждый уровень", "u"), &joined("ritual-caster")));
    assert!(joined("athlete").contains("5 футов вместо обычных 10"));
    assert!(!joined("grappler").contains("Увеличьте Силу"));
    assert!(!joined("inspiring-leader").contains("Увеличьте Харизму"));
    assert!(!joined("defensive-duelist").contains("Увеличьте Ловкость"));
    assert!(joined("mounted-combatant").contains("верхом и не недееспособны"));
    assert!(!joined("mounted-combatant").contains("реакц"));
    assert!(joined("spell-sniper").contains("Интеллект для волшебника"));
    assert!(joined("shield-master").contains("при успешном спасброске"));
    assert!(!joined("shield-master").contains("половину урона при провале"));
    assert!(joined("sentinel").contains("не имеющей этой черты"));
}

#[test]
fn skilled_weapon_master_and_martial_adept_need_exact_choices() {
    let resolve = |id: &str, choices: Value| m::resolve_character_creation_feat(Some(&json!(id)), Some(&choices), None);
    let skilled = resolve("skilled", json!({ "skills": ["arcana", "history"], "tools": ["thieves-tools"] }));
    assert_eq!(skilled["benefits"]["skill_proficiencies"], json!(["arcana", "history"]));
    assert_eq!(skilled["benefits"]["tool_proficiencies"], json!(["thieves_tools"]));
    let master = resolve("weapon-master", json!({ "weapons": ["longsword", "shortbow", "rapier", "hand-crossbow"] }));
    assert_eq!(master["benefits"]["weapon_proficiencies"], json!(["longsword", "shortbow", "rapier", "hand_crossbow"]));
    assert_eq!(resolve("weapon-master", json!({ "weapons": ["longsword", "shortbow"] }))["code"], json!("CHOICE_COUNT_INVALID"));
    assert_eq!(resolve("skilled", json!({ "skills": ["arcana", "arcana", "history"] }))["code"], json!("CHOICE_DUPLICATE"));
    let adept = resolve("martial-adept", json!({ "maneuvers": ["precision-attack", "riposte"] }));
    assert_eq!(adept["benefits"]["static"]["maneuvers"], json!(["precision-attack", "riposte"]));
    let alert = m::resolve_character_creation_feat(Some(&json!("alert")), None, None);
    assert_eq!(alert["benefits"]["initiative_bonus"], json!(5));
    assert_eq!(alert["benefits"]["ability_increases"], json!({}));
}

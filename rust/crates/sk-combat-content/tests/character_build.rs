//! Сверка `character_build` с эталоном JS (`fixtures/character-build.json`,
//! генератор `fixtures/gen-character-build.mjs`) и перенос
//! `test/character-build-combat-projection.test.mjs` в части модуля: после
//! черты «Посвящённый в магию» боевые заклинания героя пересчитываются из
//! выданных полей.

mod common;

use std::sync::LazyLock;

use common::{arg, array, assert_same, parse, stringify};
use serde_json::{json, Value};
use sk_combat_content::character_build::{self as m, CharacterBuildValidationError};
use sk_combat_content::combat_spells::combat_spells_for;

static FIXTURE: LazyLock<Value> = LazyLock::new(|| parse(include_str!("../fixtures/character-build.json")));

#[test]
fn command_types_match_js() {
    assert_eq!(json!(m::CHARACTER_BUILD_COMMAND_TYPES), FIXTURE["commandTypes"]);
}

#[test]
fn commands_and_events_match_js() {
    let states = array(&FIXTURE["states"]);
    let cases = array(&FIXTURE["cases"]);
    assert!(cases.len() > 1_500, "случаев: {}", cases.len());
    let mut accepted = 0;
    for (index, case) in cases.iter().enumerate() {
        let command = arg(&case["command"]).cloned().unwrap_or(Value::Null);
        let state = &states[case["state"].as_u64().expect("индекс") as usize];
        let context = format!("команда #{index}: {}", stringify(&command));
        match m::validate_character_build_command(&command, state, Some(&case["context"])) {
            Ok(result) => {
                let expected = case.get("result").unwrap_or_else(|| panic!("JS отказал ({}), Rust принял: {context}", case["error"]));
                assert_same(&result, expected, &format!("validateCharacterBuildCommand, {context}"));
                let event = m::character_build_event(&result).unwrap_or(Value::Null);
                assert_same(&event, &case["event"], &format!("characterBuildEvent, {context}"));
                accepted += 1;
            }
            Err(error) => {
                let expected = case.get("error").unwrap_or_else(|| panic!("JS принял, Rust отказал ({error:?}): {context}"));
                assert_eq!(expected["name"], CharacterBuildValidationError::NAME, "{context}");
                assert_eq!(expected["code"], error.code.as_str(), "код отказа, {context}");
                assert_eq!(expected["message"], error.message.as_str(), "текст отказа, {context}");
            }
        }
    }
    assert!(accepted > 500, "принято: {accepted}");
}

/// Черта «Посвящённый в магию» вместо улучшения характеристик 4-го уровня:
/// заговоры и заклинание первого круга становятся подготовленными картами.
#[test]
fn magic_initiate_feat_updates_combat_spells() {
    let hero = json!({
        "id": "hero", "character": "Мира", "role": "Воин · ур. 4", "characterClass": "fighter",
        "level": 4, "experience": 2_700, "hp": 10, "maxHp": 10,
        "abilities": { "str": 16, "dex": 12, "con": 12, "int": 10, "wis": 10, "cha": 10 },
        "classSkillProficiencies": [], "selectedFeatureIds": [], "inventory": [],
        "creationBenefits": { "armor_proficiencies": [], "weapon_proficiencies": [] },
    });
    let state = json!({ "ruleset_id": "dnd_5e_2014", "players": [hero.clone()] });
    assert!(!combat_spells_for(Some(&hero), Some(&json!({ "rulesetId": "dnd_5e_2014" }))).iter().any(|spell| spell["id"] == "magic-missile"));
    let command = json!({
        "command_type": "SetCharacterChoices", "actor_id": "hero", "subclass": "",
        "class_skill_proficiencies": [], "selected_feature_ids": [], "ability_score_level": 4,
        "ability_score_feat": { "id": "magic-initiate", "choices": { "class": "wizard", "cantrips": ["mage-hand", "light"], "spell": "magic-missile" } },
    });
    let validated = m::validate_character_build_command(&command, &state, Some(&json!({ "allowedActorIds": ["hero"] }))).expect("черта принята");
    let mut updated = hero;
    updated["creationSpellGrants"] = validated["creation_spell_grants"].clone();
    updated["creationBenefits"] = validated["creation_benefits"].clone();
    let spells = combat_spells_for(Some(&updated), Some(&json!({ "rulesetId": "dnd_5e_2014" })));
    for id in ["mage-hand", "light", "magic-missile"] {
        let spell = spells.iter().find(|spell| spell["id"] == id).unwrap_or_else(|| panic!("нет {id}"));
        assert_eq!(spell["prepared"], true, "{id}");
    }
    let event = m::character_build_event(&validated).expect("событие");
    assert_eq!(event["event_type"], "CharacterChoicesUpdated");
    assert_eq!(event["payload"]["schema_version"], 2);
}

#[test]
fn refusals_carry_codes() {
    let state = json!({ "ruleset_id": "srd_5_2_1", "players": [{ "id": "hero", "characterClass": "fighter", "level": 4 }], "mechanics": { "combat": { "active": true } } });
    let command = json!({ "command_type": "SetSpellSelections", "actor_id": "hero" });
    let forbidden = m::validate_character_build_command(&command, &state, None).expect_err("чужой герой");
    assert_eq!(forbidden.code, "ACTOR_FORBIDDEN");
    let combat = m::validate_character_build_command(&command, &state, Some(&json!({ "isAdmin": true }))).expect_err("бой");
    assert_eq!(combat.code, "CHARACTER_BUILD_DURING_COMBAT");
    let other = json!({ "command_type": "MakeAttack" });
    assert_eq!(m::validate_character_build_command(&other, &state, None), Ok(other.clone()));
    assert_eq!(m::character_build_event(&other), None);
}

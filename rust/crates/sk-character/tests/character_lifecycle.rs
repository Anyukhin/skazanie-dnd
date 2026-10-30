//! Эталон `server/character-lifecycle.mjs` (`fixtures/gen-character-lifecycle.mjs`):
//! перехват вызовов тестов модуля и его потребителей, корпус паритета и
//! случайные герои и документы импорта. Плюс перенесённые проверки
//! `test/character-lifecycle.test.mjs`.

use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_character::character_lifecycle::*;
use sk_core::{hash, js};

static FIXTURE: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("../fixtures/character-lifecycle.json")).expect("эталон character-lifecycle"));

fn resolve(fixture: &Value, arg: &Value) -> Option<Value> {
    if arg.get("$undefined").is_some() {
        return None;
    }
    let Some(index) = arg.get("$v").and_then(Value::as_u64) else { return Some(arg.clone()) };
    let mut value = &fixture["values"][index as usize];
    for step in arg.get("path").and_then(Value::as_array).into_iter().flatten() {
        value = match step {
            Value::Number(position) => &value[position.as_u64().expect("индекс") as usize],
            Value::String(key) => &value[key.as_str()],
            other => panic!("шаг пути {other}"),
        };
    }
    Some(value.clone())
}

fn wrap(result: LifecycleResult<Value>) -> Result<Option<Value>, CharacterLifecycleError> {
    result.map(Some)
}

fn abilities_of(value: Option<&Value>) -> Option<Abilities> {
    let value = value.filter(|value| !value.is_null())?;
    let normalized = normalized_ability_scores(Some(value)).ok()?;
    let mut scores = [10; 6];
    for (index, ability) in ABILITY_IDS.iter().enumerate() {
        scores[index] = normalized[ability].as_i64().unwrap_or(10);
    }
    Some(Abilities(scores))
}

fn run(name: &str, args: &[Option<Value>]) -> Result<Option<Value>, CharacterLifecycleError> {
    let arg = |index: usize| args.get(index).and_then(Option::as_ref);
    let option = |index: usize, key: &str| arg(index).and_then(|value| value.get(key));
    match name {
        "abilityModifier" => wrap(ability_modifier(arg(0)).map(Value::from)),
        "proficiencyBonusForLevel" => wrap(proficiency_bonus_for_level(arg(0)).map(Value::from)),
        "experienceForLevel" => wrap(experience_for_level(arg(0)).map(Value::from)),
        "levelForExperience" => wrap(level_for_experience(arg(0)).map(Value::from)),
        "hitDieFor" => Ok(Some(Value::from(hit_die_for(arg(0))))),
        "savingThrowProficienciesFor" => Ok(Some(json!(saving_throw_proficiencies_for(arg(0))))),
        "normalizedAbilityScores" => wrap(normalized_ability_scores(arg(0))),
        "characterCreationCatalog" => wrap(character_creation_catalog(arg(0).and_then(Value::as_str).unwrap_or("srd_5_2_1"))),
        "partyPresentationFor" => Ok(Some(party_presentation_for(arg(0)))),
        "createCharacterSlot" => wrap(create_character_slot(option(0, "id"), option(0, "index"))),
        "normalizedHitPointIncreases" => {
            let increases = normalized_hit_point_increases(arg(0), option(1, "level").and_then(Value::as_i64), option(1, "hitDie").and_then(Value::as_i64));
            wrap(increases.map(|items| json!(items)))
        }
        "deriveMaximumHitPoints" => wrap(derive_maximum_hit_points(arg(0), option(1, "level").and_then(Value::as_i64), abilities_of(option(1, "abilities")).as_ref())),
        "deriveArmorClass" => wrap(derive_armor_class(arg(0), abilities_of(option(1, "abilities")).as_ref(), option(1, "armorProfiles"))),
        "deriveSpeed" => wrap(derive_speed(arg(0), option(1, "armorProfiles"))),
        "deriveCharacterSheet" => wrap(derive_character_sheet(arg(0), arg(1))),
        "normalizeCharacterSheet" => wrap(normalize_character_sheet(arg(0), arg(1))),
        "classResourcePlan" => Ok(Some(class_resource_plan(arg(0), js::truthy(option(1, "classResources2024"))))),
        "resourcesAfterRest" => wrap(resources_after_rest(arg(0), arg(1), arg(2), js::truthy(option(3, "classResources2024")))),
        "characterCreationTargetLevel" => wrap(character_creation_target_level(arg(0)).map(Value::from)),
        "characterCreationChoicesComplete" => wrap(character_creation_choices_complete(arg(0), arg(1)).map(Value::Bool)),
        "missingCharacterCreationChoice" => wrap(missing_character_creation_choice(arg(0), arg(1)).map(|missing| missing.map_or(Value::Null, Value::String))),
        "validateLevelUpCommand" => wrap(validate_level_up_command(arg(0), arg(1), arg(2))),
        "levelUpEvent" => wrap(level_up_event(arg(0))),
        "validateCharacterImportCommand" => wrap(validate_character_import_command(arg(0), arg(1), arg(2))),
        "validateCharacterAbilityRollCommand" => wrap(validate_character_ability_roll_command(arg(0), arg(1), arg(2))),
        "characterImportEvent" => wrap(character_import_event(arg(0))),
        "resolveLevelUp" => wrap(resolve_level_up(arg(0), arg(1), arg(2))),
        "isCharacterLifecycleEvent" => Ok(Some(Value::Bool(is_character_lifecycle_event(arg(0))))),
        "applyCharacterLifecycleEvent" => {
            let state = arg(0).cloned().unwrap_or(Value::Null);
            let event = arg(1).cloned().unwrap_or(Value::Null);
            let undefined_state = arg(0).is_none();
            apply_character_lifecycle_event(&state, &event).map(|value| if undefined_state && value.is_null() { None } else { Some(value) })
        }
        "migrateCharacterImport" => wrap(migrate_character_import(arg(0))),
        "parseCharacterImport" => {
            let ruleset = option(1, "rulesetId").and_then(Value::as_str).map(String::from);
            let options = ImportOptions {
                ruleset_id: ruleset.as_deref(),
                allow_legacy_ability_policy: js::truthy(option(1, "allowLegacyAbilityPolicy")),
                validate_creation_languages: js::truthy(option(1, "validateCreationLanguages")),
                trusted_ability_roll: option(1, "trustedAbilityRoll"),
                trusted_wealth_roll: option(1, "trustedWealthRoll"),
                recorded_creation: option(1, "recordedCreation"),
            };
            parse_character_import(arg(0), &options).map(|parsed| Some(parsed.to_value()))
        }
        other => panic!("неизвестная функция {other}"),
    }
}

fn error_matches(expected: &Value, actual: &CharacterLifecycleError) -> bool {
    if expected["name"] == "TypeError" {
        return actual.name == "TypeError";
    }
    if expected["name"] != actual.name || expected["code"].as_str() != actual.code() {
        return false;
    }
    actual.runtime_message || expected["message"].as_str() == Some(actual.message.as_str())
}

#[test]
fn fixture_matches_js() {
    let fixture = &*FIXTURE;
    let cases = fixture["cases"].as_array().expect("случаи");
    assert!(cases.len() > 5_000, "мало случаев: {}", cases.len());
    let mut failures = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let name = case["fn"].as_str().expect("имя");
        let args: Vec<Option<Value>> = case["args"].as_array().expect("аргументы").iter().map(|arg| resolve(fixture, arg)).collect();
        let outcome = run(name, &args);
        let ok = match (&outcome, case.get("error")) {
            (Err(actual), Some(expected)) => error_matches(expected, actual),
            (Ok(_), Some(_)) | (Err(_), None) => false,
            (Ok(None), None) => case.get("undefined").is_some(),
            (Ok(Some(value)), None) => {
                if let Some(expected) = case.get("result") {
                    expected == value
                } else if let Some(expected) = case.get("sha256") {
                    expected.as_str() == Some(hash::sha256_hex(js::stringify(value).as_bytes()).as_str())
                } else {
                    false
                }
            }
        };
        if !ok {
            failures.push(format!(
                "#{index} {name}: ожидалось {}, получено {}",
                case.get("error").or(case.get("result")).or(case.get("sha256")).map_or_else(|| "undefined".into(), |value| head(&value.to_string())),
                match &outcome {
                    Ok(Some(value)) => head(&js::stringify(value)),
                    Ok(None) => "undefined".into(),
                    Err(error) => format!("{} {:?} {}", error.name, error.code, error.message),
                }
            ));
        }
    }
    let mut by_fn = std::collections::BTreeMap::<String, usize>::new();
    for failure in &failures {
        let name = failure.split_whitespace().nth(1).unwrap_or("").trim_end_matches(':').to_string();
        *by_fn.entry(name).or_default() += 1;
    }
    assert!(failures.is_empty(), "расхождений {} из {}: {:?}\n{}", failures.len(), cases.len(), by_fn, failures.iter().take(25).cloned().collect::<Vec<_>>().join("\n"));
}

fn head(text: &str) -> String {
    text.chars().take(700).collect()
}

// --- перенесённые проверки test/character-lifecycle.test.mjs -------------------

fn fighter(overrides: Value) -> Value {
    let mut hero = json!({
        "id": "fighter", "character": "Бранн", "characterClass": "fighter", "level": 4, "experience": 6_500,
        "abilities": { "str": 16, "dex": 14, "con": 14, "int": 10, "wis": 12, "cha": 8 },
        "baseSpeed": 30, "hp": 22, "maxHp": 32,
        "hitPointIncreases": [6, 6, 6],
        "classSkillProficiencies": ["athletics", "perception"],
        "selectedFeatureIds": ["fighting-style-defense"], "inventory": [],
    });
    js::assign(&mut hero, overrides);
    hero
}

fn sheet(hero: &Value) -> Value {
    derive_character_sheet(Some(hero), None).expect("лист")
}

#[test]
fn derived_sheet_ignores_flat_client_fields() {
    let hero = fighter(json!({
        "armor": 99, "speed": 99, "proficiency": 99,
        "inventory": [
            { "id": "leather", "catalog_id": "srd_5_2_1:leather-armor", "type": "armor", "equipped": true },
            { "id": "shield", "catalog_id": "srd_5_2_1:shield", "type": "armor", "equipped": true },
        ],
    }));
    let sheet = sheet(&hero);
    assert_eq!(ability_modifier(Some(&json!(16))).unwrap(), 3);
    assert_eq!(sheet["proficiency_bonus"], 2);
    assert_eq!(sheet["saving_throw_proficiencies"], json!(["str", "con"]));
    assert_eq!(sheet["saving_throws"]["str"]["total"], 5);
    assert_eq!(sheet["skills"]["athletics"]["total"], 5);
    assert_eq!(sheet["skills"]["stealth"]["total"], 2);
    assert_eq!(sheet["armor_class"]["value"], 16);
    assert_eq!(sheet["speed"]["value"], 30);
    assert_eq!(sheet["hit_points"]["value"], 36);
}

#[test]
fn defense_style_needs_worn_armor() {
    let armor = json!({ "id": "chain", "catalog_id": "srd_5_2_1:chain-mail", "equipped": true });
    let shield = json!({ "id": "shield", "catalog_id": "srd_5_2_1:shield", "equipped": true });
    let ac = |overrides: Value| sheet(&fighter(overrides))["armor_class"]["value"].clone();
    assert_eq!(ac(json!({ "inventory": [armor, shield] })), 19);
    assert_eq!(ac(json!({ "inventory": [shield] })), 14);
    assert_eq!(ac(json!({ "inventory": [{ "id": "chain", "catalog_id": "srd_5_2_1:chain-mail", "equipped": false }] })), 12);
    assert_eq!(ac(json!({ "inventory": [armor], "selectedFeatureIds": [] })), 16);
    assert_eq!(ac(json!({ "characterClass": "wizard", "inventory": [armor] })), 16);
}

#[test]
fn barbarian_and_monk_unarmored_defense() {
    let barbarian = sheet(&fighter(json!({ "characterClass": "barbarian", "abilities": { "str": 16, "dex": 14, "con": 16, "int": 8, "wis": 10, "cha": 8 } })));
    let monk = sheet(&fighter(json!({ "characterClass": "monk", "abilities": { "str": 10, "dex": 16, "con": 12, "int": 10, "wis": 16, "cha": 8 } })));
    assert_eq!(barbarian["armor_class"]["value"], 15);
    assert_eq!(monk["armor_class"]["value"], 16);
}

#[test]
fn experience_and_proficiency_progression() {
    let n = |value: i64| Some(json!(value));
    assert_eq!(experience_for_level(n(1).as_ref()).unwrap(), 0);
    assert_eq!(experience_for_level(n(5).as_ref()).unwrap(), 6_500);
    assert_eq!(experience_for_level(n(12).as_ref()).unwrap(), 100_000);
    assert_eq!(level_for_experience(n(84_999).as_ref()).unwrap(), 10);
    assert_eq!(level_for_experience(n(85_000).as_ref()).unwrap(), 11);
    assert_eq!(level_for_experience(n(999_999).as_ref()).unwrap(), 12);
    assert_eq!(proficiency_bonus_for_level(n(1).as_ref()).unwrap(), 2);
    assert_eq!(proficiency_bonus_for_level(n(5).as_ref()).unwrap(), 3);
    assert_eq!(proficiency_bonus_for_level(n(12).as_ref()).unwrap(), 4);
}

#[test]
fn level_up_is_one_server_level() {
    let state = json!({ "players": [fighter(json!({}))], "mechanics": { "combat": { "active": false } } });
    let owner = json!({ "allowedActorIds": ["fighter"] });
    let command = validate_level_up_command(Some(&json!({ "command_type": "LevelUp", "actor_id": "fighter", "hit_point_roll": 9 })), Some(&state), Some(&owner)).unwrap();
    assert_eq!(command["level_before"], 4);
    assert_eq!(command["level_after"], 5);
    assert_eq!(command["max_hp_before"], 36);
    assert_eq!(command["max_hp_after"], 47);
    let event = level_up_event(Some(&command)).unwrap();
    let after = apply_character_lifecycle_event(&state, &event).unwrap();
    assert_eq!(after["players"][0]["level"], 5);
    assert_eq!(after["players"][0]["maxHp"], 47);
    assert_eq!(after["players"][0]["hitPointIncreases"], json!([6, 6, 6, 9]));
    assert_eq!(apply_character_lifecycle_event(&state, &event).unwrap(), after);
    let forbidden = validate_level_up_command(Some(&json!({ "command_type": "LevelUp", "actor_id": "fighter" })), Some(&state), Some(&json!({ "allowedActorIds": [] }))).unwrap_err();
    assert!(forbidden.is_validation());
    assert_eq!(forbidden.code(), Some("ACTOR_FORBIDDEN"));
    let roll = validate_level_up_command(Some(&json!({ "command_type": "LevelUp", "actor_id": "fighter", "hit_point_roll": 11 })), Some(&state), Some(&owner)).unwrap_err();
    assert_eq!(roll.code(), Some("INVALID_CHARACTER_VALUE"));
}

#[test]
fn level_up_refusals() {
    let owner = json!({ "allowedActorIds": ["fighter"] });
    let no_xp = json!({ "players": [fighter(json!({ "experience": 6_499 }))], "mechanics": { "combat": { "active": false } } });
    let code = |command: Value, state: &Value| validate_level_up_command(Some(&command), Some(state), Some(&owner)).unwrap_err().code.unwrap_or_default();
    assert_eq!(code(json!({ "command_type": "LevelUp", "actor_id": "fighter" }), &no_xp), "LEVEL_UP_PROGRESSION_REQUIRED");
    let combat = json!({ "players": [fighter(json!({}))], "mechanics": { "combat": { "active": true } } });
    assert_eq!(code(json!({ "command_type": "LevelUp", "actor_id": "fighter" }), &combat), "LEVEL_UP_DURING_COMBAT");
    assert_eq!(code(json!({ "command_type": "LevelUp", "actor_id": "fighter", "next_level": 6 }), &no_xp), "LEVEL_UP_STEP_INVALID");
}

#[test]
fn resource_plan_delegates_to_catalogs() {
    let wizard = json!({ "id": "wizard", "characterClass": "wizard", "level": 5, "abilities": { "int": 16, "dex": 14, "con": 12, "str": 8, "wis": 10, "cha": 10 } });
    let warlock = json!({ "id": "warlock", "characterClass": "warlock", "level": 5, "abilities": { "cha": 16, "dex": 14, "con": 12, "str": 8, "int": 10, "wis": 10 } });
    let plan = class_resource_plan(Some(&wizard), false);
    assert_eq!(plan["maximums"]["spell_slots_1"], 4);
    assert_eq!(plan["maximums"]["spell_slots_2"], 3);
    assert_eq!(plan["maximums"]["spell_slots_3"], 2);
    assert_eq!(plan["maximums"]["arcane_recovery"], 1);
    assert!(plan["maximums"].get("feature_wizard-magicheskoe-vosstanovlenie").is_none());
    assert_eq!(plan["recovery"]["spell_slots_1"], "long");
    assert_eq!(plan["recovery"]["arcane_recovery"], "long");
    let plan = class_resource_plan(Some(&warlock), false);
    assert_eq!(plan["maximums"]["pact_slots"], 2);
    assert!(plan["maximums"].as_object().unwrap().keys().any(|key| key.starts_with("feature_warlock-")));
    assert_eq!(plan["recovery"]["pact_slots"], "short_or_long");
    let rested = resources_after_rest(Some(&warlock), Some(&json!({ "pact_slots": { "current": 0 } })), Some(&json!("short")), false).unwrap();
    assert_eq!(rested["pact_slots"]["current"], 2);
}

fn import_document(character: Value) -> Value {
    let base_scores = json!({ "str": 8, "dex": 14, "con": 13, "int": 15, "wis": 12, "cha": 10 });
    let mut document = json!({
        "character": "Мира", "characterClass": "wizard", "level": 1, "experience": 0,
        "species": "Человек",
        "abilities": base_scores,
        "abilityGeneration": {
            "policyId": "skazanie.character-abilities.standard-array",
            "policyVersion": 1,
            "method": "standard_array",
            "baseScores": base_scores,
            "originBonusProfileId": "none",
            "originBonuses": { "str": 0, "dex": 0, "con": 0, "int": 0, "wis": 0, "cha": 0 },
            "speciesOptionId": "human",
        },
        "baseSpeed": 30, "classSkillProficiencies": ["arcana", "history"], "selectedFeatureIds": [],
        "knownSpellIds": ["fire-bolt", "mage-hand", "light"], "preparedSpellIds": [],
    });
    js::assign(&mut document, character);
    json!({ "schema": CHARACTER_IMPORT_SCHEMA, "schema_version": CHARACTER_IMPORT_SCHEMA_VERSION, "character": document })
}

fn parse(document: &Value) -> LifecycleResult<ParsedImport> {
    parse_character_import(Some(document), &ImportOptions::default())
}

#[test]
fn strict_v1_importer_returns_safe_fields() {
    let parsed = parse(&import_document(json!({ "name": "Игрок" }))).unwrap();
    assert_eq!(parsed.patch["characterClass"], "wizard");
    assert_eq!(parsed.patch["baseSpeed"], 30);
    for field in ["hp", "maxHp", "inventory"] {
        assert!(!parsed.patch.contains_key(field));
    }
    assert_eq!(parsed.sheet["proficiency_bonus"], 2);
    let code = |overrides: Value| parse(&import_document(overrides)).unwrap_err().code.unwrap_or_default();
    assert_eq!(code(json!({ "hp": 999 })), "IMPORT_UNKNOWN_FIELD");
    assert_eq!(code(json!({ "level": 2, "experience": 0 })), "IMPORT_LEVEL_EXPERIENCE_MISMATCH");
    assert_eq!(code(json!({ "knownSpellIds": ["fireball"] })), "IMPORT_CHARACTER_CHOICE_INVALID");
    assert_eq!(code(json!({ "hitPointIncreases": "not-an-array" })), "IMPORT_INVALID_FIELD");
    assert_eq!(code(json!({ "abilities": { "str": 30, "dex": 30, "con": 30, "int": 30, "wis": 30, "cha": 30 } })), "IMPORT_ABILITY_BUDGET_INVALID");
}

#[test]
fn import_fills_role_of_empty_slot_only() {
    let parsed = parse(&import_document(json!({}))).unwrap();
    let event = character_import_event(Some(&json!({ "command_type": "ImportCharacter", "actor_id": "slot", "patch": parsed.patch }))).unwrap();
    let slot = create_character_slot(Some(&json!("slot")), None).unwrap();
    let empty = json!({ "players": [slot.clone()], "mechanics": { "combat": { "active": false } } });
    let mut named_slot = slot;
    named_slot["role"] = json!("Хранитель маяка");
    let named = json!({ "players": [named_slot], "mechanics": { "combat": { "active": false } } });
    assert_eq!(apply_character_lifecycle_event(&empty, &event).unwrap()["players"][0]["role"], "Волшебник · ур. 1");
    assert_eq!(apply_character_lifecycle_event(&named, &event).unwrap()["players"][0]["role"], "Хранитель маяка");
}

#[test]
fn v0_migration_accepts_only_documented_aliases() {
    let migrated = migrate_character_import(Some(&json!({
        "schema": CHARACTER_IMPORT_SCHEMA,
        "schema_version": 0,
        "character": {
            "character": "Мира", "character_class": "wizard", "level": 1, "experience": 0,
            "abilities": { "str": 8, "dex": 14, "con": 12, "int": 16, "wis": 10, "cha": 10 },
            "base_speed": 30, "class_skill_proficiencies": ["arcana", "history"],
            "selected_feature_ids": [], "known_spell_ids": ["fire-bolt", "mage-hand", "light"], "prepared_spell_ids": [],
        },
    })))
    .unwrap();
    assert_eq!(migrated["schema_version"], 1);
    assert_eq!(migrated["character"]["characterClass"], "wizard");
    assert_eq!(migrated["character"]["baseSpeed"], 30);
    let mut conflict = migrated["character"].clone();
    conflict["character_class"] = json!("fighter");
    let error = migrate_character_import(Some(&json!({ "schema": CHARACTER_IMPORT_SCHEMA, "schema_version": 0, "character": conflict }))).unwrap_err();
    assert_eq!(error.code(), Some("IMPORT_MIGRATION_CONFLICT"));
    let mut unknown = migrated["character"].clone();
    unknown["gold"] = json!(999);
    let error = migrate_character_import(Some(&json!({ "schema": CHARACTER_IMPORT_SCHEMA, "schema_version": 0, "character": unknown }))).unwrap_err();
    assert_eq!(error.code(), Some("IMPORT_UNKNOWN_FIELD"));
}

#[test]
fn legacy_import_events_replay() {
    let state = json!({ "players": [fighter(json!({ "level": 1, "experience": 0, "hitPointIncreases": [] }))], "mechanics": { "combat": { "active": false } } });
    let event = json!({
        "event_type": "CharacterImported", "actor_id": "fighter", "target_ids": ["fighter"],
        "payload": {
            "schema": CHARACTER_IMPORT_SCHEMA, "schema_version": CHARACTER_IMPORT_SCHEMA_VERSION,
            "patch": {
                "character": "Старый герой", "characterClass": "fighter", "level": 1, "experience": 0,
                "abilities": { "str": 18, "dex": 11, "con": 15, "int": 9, "wis": 13, "cha": 7 },
                "baseSpeed": 30, "classSkillProficiencies": ["athletics", "perception"],
                "selectedFeatureIds": ["fighting-style-defense"], "knownSpellIds": [], "preparedSpellIds": [],
            },
        },
    });
    let replayed = apply_character_lifecycle_event(&state, &event).unwrap();
    assert_eq!(replayed["players"][0]["character"], "Старый герой");
    assert_eq!(replayed["players"][0]["abilities"]["str"], 18);
}

#[test]
fn resolve_level_up_combines_steps() {
    let state = json!({ "players": [fighter(json!({}))], "mechanics": { "combat": { "active": false } } });
    let result = resolve_level_up(Some(&json!({ "command_type": "LevelUp", "actor_id": "fighter" })), Some(&state), Some(&json!({ "allowedActorIds": ["fighter"] }))).unwrap();
    assert_eq!(result["event"]["event_type"], "CharacterLeveledUp");
    assert_eq!(result["state"]["players"][0]["level"], 5);
    assert_eq!(result["sheet"]["proficiency_bonus"], 3);
}

#[test]
fn species_label_is_derived_from_option() {
    let mut without_label = import_document(json!({}));
    without_label["character"].as_object_mut().unwrap().shift_remove("species");
    assert_eq!(parse(&without_label).unwrap().patch["species"], "Человек");
    assert_eq!(parse(&import_document(json!({ "species": "Человек" }))).unwrap().patch["species"], "Человек");
    assert_eq!(parse(&import_document(json!({ "species": "Эльф" }))).unwrap_err().code(), Some("IMPORT_SPECIES_UNSUPPORTED"));
}

#[test]
fn custom_species_requires_name() {
    let custom = |species: Option<&str>| {
        let mut document = import_document(match species {
            Some(species) => json!({ "species": species }),
            None => json!({}),
        });
        document["character"]["abilityGeneration"]["speciesOptionId"] = json!("custom");
        if species.is_none() {
            document["character"].as_object_mut().unwrap().shift_remove("species");
        }
        document
    };
    assert_eq!(parse(&custom(None)).unwrap_err().code(), Some("IMPORT_SPECIES_UNSUPPORTED"));
    assert_eq!(parse(&custom(Some("Полудракон"))).unwrap().patch["species"], "Полудракон");
}

/// Класс-ключ прототипа (`constructor`) — не класс PHB: таблица читается по
/// собственному ключу.
#[test]
fn wealth_roll_rejects_prototype_class_key() {
    let state = json!({ "ruleset_id": "dnd_5e_2014", "players": [{ "id": "slot", "characterSetupRequired": true }] });
    let command = json!({ "command_type": "RollCharacterWealth", "actor_id": "slot", "character_class": "constructor" });
    let error = validate_character_ability_roll_command(Some(&command), Some(&state), Some(&json!({ "isAdmin": true }))).unwrap_err();
    assert_eq!(error.code(), Some("CHARACTER_CLASS_UNSUPPORTED"));
}

/// Замечено в JS: повторный импорт героя с 0 хитов поднимает его до
/// максимума (`Number(actor.hp) || max`).
#[test]
fn reimport_of_downed_hero_restores_full_hp_like_js() {
    let state = json!({ "players": [fighter(json!({ "level": 1, "experience": 0, "hitPointIncreases": [], "hp": 0 }))] });
    let parsed = parse(&import_document(json!({}))).unwrap();
    let event = character_import_event(Some(&json!({ "command_type": "ImportCharacter", "actor_id": "fighter", "patch": parsed.patch }))).unwrap();
    let after = apply_character_lifecycle_event(&state, &event).unwrap();
    assert_eq!(after["players"][0]["hp"], after["players"][0]["maxHp"]);
}

// ---------------------------------------------------------------------------
// #190: серверный авторитет импорта (`test/character-lifecycle-engine.test.mjs`,
// `test/character-creation-2014.test.mjs`) — на уровне модуля.
// ---------------------------------------------------------------------------

#[test]
fn catalog_gives_wizard_hit_die_and_saving_throws_from_sheet_tables() {
    let expected = [
        ("barbarian", 12, "str/con"), ("bard", 8, "dex/cha"), ("cleric", 8, "wis/cha"), ("druid", 8, "int/wis"),
        ("fighter", 10, "str/con"), ("monk", 8, "str/dex"), ("paladin", 10, "wis/cha"), ("ranger", 10, "str/dex"),
        ("rogue", 8, "dex/int"), ("sorcerer", 6, "con/cha"), ("warlock", 8, "wis/cha"), ("wizard", 6, "int/wis"),
    ];
    for ruleset_id in ["dnd_5e_2014", "srd_5_2_1"] {
        let catalog = character_creation_catalog(ruleset_id).expect("каталог");
        let classes = catalog["classes"].as_array().expect("классы");
        assert_eq!(classes.len(), 12);
        for entry in classes {
            let id = entry["id"].as_str().unwrap_or_default();
            let saves: Vec<&str> = entry["saving_throws"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
            let (_, die, joined) = expected.iter().find(|(class, _, _)| *class == id).expect("класс в таблице");
            assert_eq!((entry["hit_die"].as_i64(), saves.join("/")), (Some(*die), joined.to_string()), "{ruleset_id}:{id}");
        }
    }
}

fn fighter_document(overrides: Value) -> Value {
    let base_scores = json!({ "str": 15, "dex": 14, "con": 13, "int": 12, "wis": 10, "cha": 8 });
    let mut character = json!({
        "character": "Бранн", "characterClass": "fighter", "species": "Человек", "level": 1, "experience": 0,
        "abilities": base_scores,
        "abilityGeneration": {
            "policyId": "skazanie.character-abilities.standard-array", "policyVersion": 1, "method": "standard_array", "baseScores": base_scores,
            "originBonusProfileId": "none", "originBonuses": { "str": 0, "dex": 0, "con": 0, "int": 0, "wis": 0, "cha": 0 }, "speciesOptionId": "human",
        },
        "baseSpeed": 30, "hitPointIncreases": [],
        "classSkillProficiencies": ["athletics", "perception"], "selectedFeatureIds": ["fighting-style-defense"],
        "knownSpellIds": [], "preparedSpellIds": [],
    });
    js::assign(&mut character, overrides);
    json!({ "schema": CHARACTER_IMPORT_SCHEMA, "schema_version": CHARACTER_IMPORT_SCHEMA_VERSION, "character": character })
}

fn slot_state(extra: Value) -> Value {
    let slot = create_character_slot(Some(&json!("hero-slot-1")), None).expect("слот");
    let mut state = json!({ "ruleset_id": "srd_5_2_1", "players": [slot], "mechanics": { "combat": { "active": false } } });
    js::assign(&mut state, extra);
    state
}

fn import_into(state: &Value, document: Value, context: Value) -> LifecycleResult<Value> {
    let command = json!({ "command_type": "ImportCharacter", "actor_id": "hero-slot-1", "document": document });
    validate_character_import_command(Some(&command), Some(state), Some(&context))
}

fn player() -> Value {
    json!({ "allowedActorIds": ["hero-slot-1"] })
}

#[test]
fn player_cannot_overwrite_created_hero_by_import() {
    let created = json!({ "ruleset_id": "srd_5_2_1", "players": [fighter(json!({ "id": "hero-slot-1", "level": 1, "experience": 0, "hitPointIncreases": [] }))] });
    let document = fighter_document(json!({ "level": 12, "experience": 100_000, "hitPointIncreases": [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10] }));
    let refused = import_into(&created, document.clone(), player()).unwrap_err();
    assert_eq!(refused.code(), Some("CHARACTER_ALREADY_CREATED"));
    assert_eq!(refused.message, "Герой уже создан: развивайте его повышением уровня, а заменить лист целиком может ведущий");
    // Чужой герой отказывает раньше, и текст говорит об импорте, а не об уровне.
    let foreign = import_into(&created, document, json!({ "allowedActorIds": ["someone-else"] })).unwrap_err();
    assert_eq!((foreign.code(), foreign.message.as_str()), (Some("ACTOR_FORBIDDEN"), "Импортировать лист может только владелец героя"));
    // Ведущий лист готового героя заменяет.
    assert!(import_into(&created, fighter_document(json!({})), json!({ "isAdmin": true })).is_ok());
}

#[test]
fn new_hero_without_required_first_level_choices_is_not_created() {
    let validated = import_into(&slot_state(json!({})), fighter_document(json!({})), player()).expect("полный герой");
    let after = apply_character_lifecycle_event(&slot_state(json!({})), &character_import_event(Some(&validated)).unwrap()).unwrap();
    assert_eq!(after["players"][0]["characterSetupRequired"], false);
    for (label, overrides, message) in [
        ("без навыков", json!({ "classSkillProficiencies": [] }), "Герой не завершён: Выберите классовые навыки: 2"),
        ("без боевого стиля", json!({ "selectedFeatureIds": [] }), "Герой не завершён: Боевой стиль: выберите 1"),
        ("волшебник без заклинаний", json!({ "characterClass": "wizard", "classSkillProficiencies": ["arcana", "history"], "selectedFeatureIds": [] }), "Герой не завершён: Выберите заговоры: 3"),
    ] {
        let error = import_into(&slot_state(json!({})), fighter_document(overrides), player()).unwrap_err();
        assert_eq!((error.code(), error.message.as_str()), (Some("IMPORT_CHOICES_INCOMPLETE"), message), "{label}");
    }
    // При стартовом уровне выше первого выборы досдаются командами подготовки.
    assert!(import_into(&slot_state(json!({ "character_start_level": 3 })), fighter_document(json!({ "classSkillProficiencies": [] })), player()).is_ok());
}

#[test]
fn background_bonuses_2024_require_a_background() {
    let base_scores = json!({ "str": 15, "dex": 14, "con": 13, "int": 12, "wis": 10, "cha": 8 });
    let forged = fighter_document(json!({
        "abilities": { "str": 17, "dex": 14, "con": 14, "int": 12, "wis": 10, "cha": 8 },
        "abilityGeneration": {
            "policyId": "skazanie.character-abilities.standard-array", "policyVersion": 1, "method": "standard_array", "baseScores": base_scores,
            "originBonusProfileId": "two_one", "originBonuses": { "str": 2, "dex": 0, "con": 1, "int": 0, "wis": 0, "cha": 0 }, "speciesOptionId": "human",
        },
    }));
    let error = import_into(&slot_state(json!({})), forged, player()).unwrap_err();
    assert_eq!((error.code(), error.message.as_str()), (Some("IMPORT_BACKGROUND_REQUIRED"), "Прибавки характеристик даёт предыстория: выберите её"));
}

// IMPORT_PHB_CREATION_REQUIRED сверяется эталоном (документы 2014 без phbCreation).

#[test]
fn missing_event_actor_names_the_event_type() {
    let error = apply_character_lifecycle_event(&json!({ "players": [] }), &json!({ "event_type": "CharacterImported", "target_ids": ["nobody"] })).unwrap_err();
    assert_eq!((error.code(), error.message.as_str()), (Some("ACTOR_NOT_FOUND"), "Событие CharacterImported ссылается на отсутствующего героя"));
}

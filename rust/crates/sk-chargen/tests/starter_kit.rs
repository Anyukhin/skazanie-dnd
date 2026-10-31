//! Сверка `starter_kit` с эталоном JS (`fixtures/starter-kit.json`, генератор —
//! `fixtures/gen-starter-kit.mjs`) и перенесённые проверки модуля из
//! `test/starter-kit-2024.test.mjs`, `test/character-creation-equipment-complete.test.mjs`,
//! `test/starter-background-items-2014.test.mjs`, `test/character-creation-2014.test.mjs`,
//! `test/hero-ammunition.test.mjs`, `test/regression-2026-07-26.test.mjs`,
//! `test/spell-component-items.test.mjs`, `test/free-text-attack-weapon.test.mjs`.
//! Проверки КД (`deriveCharacterSheet`) остаются за `character-lifecycle`, который
//! здесь не перенесён.

mod common;

use std::collections::HashSet;

use common::{check, ok, ok_or_null, thrown_type_error, type_error, Args, Outcome};
use serde_json::{json, Value};
use sk_chargen::starter_kit::{self as m, StarterKitError, StarterKitOptions, STARTER_KIT_2024_POLICY};
use sk_core::js;
use sk_items::item_catalog::{ammunition_shots_left, catalog_item};
use sk_ruleset::backgrounds::{background_catalog_for, default_background_choices};

const RULESET_2014: &str = "dnd_5e_2014";
const RULESET_2024: &str = "srd_5_2_1";

/// `rulesetId` аргумента: `undefined` — значение по умолчанию JS.
fn ruleset_arg(args: &Args, index: usize) -> String {
    args.get(index).map_or_else(|| "srd_5_2_1".to_string(), |value| js::string(Some(value)))
}

fn outcome(result: Result<Value, StarterKitError>) -> Outcome {
    match result {
        Ok(value) => ok(value),
        Err(StarterKitError::Type(message)) => Err(thrown_type_error(message)),
        Err(StarterKitError::Runtime(message)) => Err(type_error(message)),
    }
}

fn kit_options(options: Option<&Value>) -> StarterKitOptions {
    let field = |key: &str| options.and_then(|options| options.get(key));
    StarterKitOptions {
        ruleset_id: field("rulesetId").map_or_else(|| "srd_5_2_1".to_string(), |value| js::string(Some(value))),
        starter_policy_version: field("starterPolicyVersion").cloned(),
        starter_policy_id: field("starterPolicyId").and_then(Value::as_str).map(str::to_string),
        complete: js::is_true(field("complete")),
    }
}

fn run(name: &str, args: &Args) -> Outcome {
    match name {
        "const:STARTER_KIT_2024_POLICY" => ok(STARTER_KIT_2024_POLICY.to_json()),
        "starterKit2024Preview" => ok_or_null(m::starter_kit_2024_preview(&js::string(args.get(0)))),
        "starterEquipmentCatalogFor" => ok_or_null(m::starter_equipment_catalog_for(&ruleset_arg(args, 0), js::truthy(args.option(1, "complete")))),
        "defaultStarterEquipmentChoices" => ok_or_null(m::default_starter_equipment_choices(args.get(0), &ruleset_arg(args, 1), js::truthy(args.option(2, "complete")))),
        "resolveStarterEquipmentChoices" => ok(m::resolve_starter_equipment_choices(args.get(0), args.get(1), &ruleset_arg(args, 2), js::truthy(args.option(3, "complete")))),
        "validateCompleteBackgroundChoices" => ok(m::validate_complete_background_choices(args.get(0), args.get(1))),
        "completeBackgroundChoicesForHero" => ok_or_null(m::complete_background_choices_for_hero(args.get(0), args.get(1))),
        "withStarterKit" => outcome(m::with_starter_kit(args.get(0), &kit_options(args.get(1)))),
        other => panic!("неизвестный случай {other}"),
    }
}

#[test]
fn matches_js_fixture() {
    let cases = check(include_str!("../fixtures/starter-kit.json"), run);
    assert!(cases > 3_000, "{cases}");
}

fn kit_2024(character_class: &str, abilities: Option<Value>) -> Value {
    let mut hero = json!({ "id": "hero", "characterClass": character_class, "level": 1, "inventory": [], "currency": {} });
    if let Some(abilities) = abilities {
        hero["abilities"] = abilities;
    }
    let options = StarterKitOptions { ruleset_id: RULESET_2024.into(), starter_policy_id: Some(STARTER_KIT_2024_POLICY.policy_id.into()), ..StarterKitOptions::default() };
    m::with_starter_kit(Some(&hero), &options).expect("набор")
}

fn options_2014() -> StarterKitOptions {
    StarterKitOptions { ruleset_id: RULESET_2014.into(), ..StarterKitOptions::default() }
}

fn ids(hero: &Value) -> Vec<String> {
    hero["inventory"].as_array().expect("инвентарь").iter().filter_map(|item| item["catalog_id"].as_str().map(str::to_string)).collect()
}

fn find<'a>(hero: &'a Value, predicate: impl Fn(&Value) -> bool) -> Option<&'a Value> {
    hero["inventory"].as_array().expect("инвентарь").iter().find(|item| predicate(item))
}

// --- test/starter-kit-2024.test.mjs ---

#[test]
fn cleric_fighter_paladin_get_their_2024_class_kit() {
    let cleric = kit_2024("cleric", None);
    assert_eq!(ids(&cleric)[..3], ["srd_5_2_1:chain-shirt", "srd_5_2_1:shield", "srd_5_2_1:mace"]);
    let fighter = kit_2024("fighter", None);
    assert!(ids(&fighter).contains(&"srd_5_2_1:greatsword".to_string()));
    assert_eq!(find(&fighter, |item| item["catalog_id"] == "srd_5_2_1:javelin").expect("копья")["quantity"], 8);
    assert!(ids(&kit_2024("paladin", None)).contains(&"srd_5_2_1:chain-mail".to_string()));
}

#[test]
fn dexterous_fighter_gets_option_b() {
    let archer = kit_2024("fighter", Some(json!({ "str": 10, "dex": 16, "con": 14, "int": 10, "wis": 12, "cha": 8 })));
    let ids = ids(&archer);
    for wanted in ["srd_5_2_1:studded-leather-armor", "srd_5_2_1:longbow", "srd_5_2_1:arrows-20"] {
        assert!(ids.contains(&wanted.to_string()), "{wanted}");
    }
    assert!(!ids.contains(&"srd_5_2_1:chain-mail".to_string()));
}

#[test]
fn every_2024_caster_gets_a_focus_of_its_class() {
    for class in ["bard", "cleric", "druid", "paladin", "sorcerer", "warlock", "wizard"] {
        let hero = kit_2024(class, None);
        let focus = find(&hero, |item| {
            catalog_item(item["catalog_id"].as_str().unwrap_or_default()).and_then(|entry| entry["spellcasting_focus"].as_array()).is_some_and(|classes| classes.iter().any(|entry| entry == class))
        });
        assert!(focus.is_some(), "{class}: нет фокусировки");
    }
    assert!(ids(&kit_2024("ranger", None)).contains(&"srd_5_2_1:druidic-focus-mistletoe".to_string()));
}

#[test]
fn every_2024_class_has_a_weapon_in_hand_and_archers_have_ammunition() {
    for class in ["barbarian", "bard", "cleric", "druid", "fighter", "monk", "paladin", "ranger", "rogue", "sorcerer", "warlock", "wizard"] {
        let hero = kit_2024(class, None);
        let weapons: Vec<&Value> = hero["inventory"].as_array().expect("инвентарь").iter().filter(|item| item["type"] == "weapon").collect();
        assert!(!weapons.is_empty(), "{class}: без оружия");
        if class == "druid" {
            continue; // фокусировка-посох в руке, серп в сумке — по варианту A
        }
        assert!(weapons.iter().any(|item| item["equipped"] == true), "{class}: оружие не в руках");
    }
    assert!(ids(&kit_2024("ranger", None)).contains(&"srd_5_2_1:arrows-20".to_string()));
    assert!(ids(&kit_2024("rogue", None)).contains(&"srd_5_2_1:arrows-20".to_string()));
}

#[test]
fn legacy_event_keeps_the_previous_kit() {
    let hero = json!({ "id": "hero", "characterClass": "cleric", "level": 1, "inventory": [], "currency": {} });
    let legacy = m::with_starter_kit(Some(&hero), &StarterKitOptions { ruleset_id: RULESET_2024.into(), ..StarterKitOptions::default() }).expect("набор");
    assert_eq!(ids(&legacy), ["srd_5_2_1:dagger", "srd_5_2_1:leather-armor", "srd_5_2_1:shield"]);
    let classic = m::with_starter_kit(Some(&hero), &StarterKitOptions { starter_policy_id: Some(STARTER_KIT_2024_POLICY.policy_id.into()), ..options_2014() }).expect("набор");
    assert_eq!(classic["starterEquipmentPolicyId"], "skazanie.starter-equipment.dnd-5e-2014", "в 2014 действует свой набор PHB, метка 2024 его не трогает");
}

// --- test/character-creation-equipment-complete.test.mjs ---

fn catalog(complete: bool) -> Value {
    m::starter_equipment_catalog_for(RULESET_2014, complete).expect("каталог 2014")
}

fn class_entry<'a>(catalog: &'a Value, class: &str) -> &'a Value {
    catalog["classes"].as_array().expect("классы").iter().find(|entry| entry["class_id"] == class).expect("класс")
}

fn group<'a>(entry: &'a Value, id: &str) -> &'a Value {
    entry["choice_groups"].as_array().expect("группы").iter().find(|group| group["id"] == id).expect("группа")
}

fn options(group: &Value) -> &Vec<Value> {
    group["options"].as_array().expect("варианты")
}

#[test]
fn complete_catalog_has_12_classes_and_13_backgrounds() {
    let legacy = catalog(false);
    let complete = catalog(true);
    assert_eq!(legacy["classes"].as_array().expect("классы").len(), 12);
    assert_eq!(complete["classes"].as_array().expect("классы").len(), 12);
    assert_eq!(complete["backgrounds"].as_array().expect("предыстории").len(), 13);
    assert_eq!(complete["complete_schema_version"], 1);
    let ids: HashSet<&str> = complete["classes"].as_array().expect("классы").iter().filter_map(|entry| entry["class_id"].as_str()).collect();
    assert_eq!(ids.len(), 12);
    assert!(options(group(class_entry(&complete, "bard"), "instrument")).len() >= 10);
    assert!(options(group(class_entry(&complete, "barbarian"), "primary-weapon"))
        .iter()
        .any(|option| option["items"].as_array().is_some_and(|items| items.iter().any(|item| item["catalog_id"] == "srd_5_2_1:whip"))));
    assert!(options(group(class_entry(&complete, "fighter"), "melee-loadout")).len() > 100);
    assert!(options(group(class_entry(&complete, "ranger"), "melee")).len() > 50);
}

#[test]
fn legacy_catalog_and_policy_v2_stay_compatible() {
    assert_eq!(options(group(class_entry(&catalog(false), "barbarian"), "primary-weapon")).len(), 2);
    assert!(options(group(class_entry(&catalog(true), "barbarian"), "primary-weapon")).len() > 2);
    let defaults = json!({ "armor": ["chain-mail"], "melee-loadout": ["longsword-shield"], "secondary": ["light-crossbow"], "pack": ["dungeoneers-pack"] });
    assert_eq!(m::default_starter_equipment_choices(Some(&json!("fighter")), RULESET_2014, false), Some(defaults.clone()));
    assert_eq!(m::default_starter_equipment_choices(Some(&json!("fighter")), RULESET_2014, true), Some(defaults));
    let choices = json!({ "armor": ["chain-mail"], "melee-loadout": ["greatsword"], "secondary": ["light-crossbow"], "pack": ["dungeoneers-pack"] });
    assert_eq!(m::resolve_starter_equipment_choices(Some(&json!("fighter")), Some(&choices), RULESET_2014, true)["ok"], false);
}

/// Сигнатура варианта из теста JS: одинаковые вещи складываются.
fn effective_option_signature(option: &Value) -> String {
    let stack = |items: &Value| {
        let mut by_identity: Vec<(String, Value)> = Vec::new();
        for item in items.as_array().cloned().unwrap_or_default() {
            let mut identity = item.as_object().cloned().unwrap_or_default();
            let quantity = identity.shift_remove("quantity").map_or(1.0, |quantity| js::number(Some(&quantity)));
            let key = serde_json::to_string(&identity).expect("json");
            match by_identity.iter_mut().find(|(existing, _)| *existing == key) {
                Some((_, total)) => *total = json!(total.as_f64().unwrap_or(0.0) + quantity),
                None => by_identity.push((key, json!(quantity))),
            }
        }
        let mut entries: Vec<String> = by_identity.into_iter().map(|(key, quantity)| format!("{key}×{quantity}")).collect();
        entries.sort();
        entries.join("|")
    };
    format!("{}#{}#{}", stack(&option["items"]), stack(&option["narrative_items"]), stack(&option["owned_assets"]))
}

#[test]
fn public_complete_catalog_does_not_repeat_effective_kits_but_hidden_ids_stay_valid() {
    let complete = catalog(true);
    for entry in complete["classes"].as_array().expect("классы") {
        for group in entry["choice_groups"].as_array().expect("группы") {
            let signatures: Vec<String> = options(group).iter().map(effective_option_signature).collect();
            let unique: HashSet<&String> = signatures.iter().collect();
            assert_eq!(unique.len(), signatures.len(), "{}/{}", entry["class_id"], group["id"]);
        }
    }
    let fighter_melee = options(group(class_entry(&complete, "fighter"), "melee-loadout"));
    assert!(!fighter_melee.iter().any(|option| option["id"] == "martial-and-shield-longsword"));
    assert!(!fighter_melee.iter().any(|option| option["id"] == "two-martial-weapons-shortsword-shortsword"));
    for melee in ["martial-and-shield-longsword", "two-martial-weapons-shortsword-shortsword"] {
        let choices = json!({ "armor": ["chain-mail"], "melee-loadout": [melee], "secondary": ["light-crossbow"], "pack": ["dungeoneers-pack"] });
        assert_eq!(m::resolve_starter_equipment_choices(Some(&json!("fighter")), Some(&choices), RULESET_2014, true)["ok"], true, "{melee}");
    }
}

#[test]
fn complete_mode_accepts_dynamic_weapons_and_materializes_even_a_net() {
    let complete = catalog(true);
    let melee = options(group(class_entry(&complete, "fighter"), "melee-loadout"));
    let net_option = melee.iter().find(|option| option["id"] == "martial-and-shield-net").expect("сеть и щит");
    assert!(net_option["narrative_items"].as_array().expect("описательные").iter().any(|item| item["name"] == "Сеть" && item["weight"] == 3 && item["type"] == "weapon"));
    let choices = json!({ "armor": ["chain-mail"], "melee-loadout": ["martial-and-shield-net"], "secondary": ["light-crossbow"], "pack": ["dungeoneers-pack"] });
    let resolved = m::resolve_starter_equipment_choices(Some(&json!("fighter")), Some(&choices), RULESET_2014, true);
    assert_eq!(resolved["ok"], true);
    assert!(resolved["selected_options"][1]["narrative_items"].as_array().expect("описательные").iter().any(|item| item["name"] == "Сеть"));
    let hero = json!({
        "id": "net-fighter", "characterClass": "fighter", "backgroundId": "criminal", "inventory": [], "currency": {},
        "starterEquipmentChoices": choices, "phbCreation": { "schema_version": 1 },
    });
    let hero = m::with_starter_kit(Some(&hero), &options_2014()).expect("набор");
    let net = find(&hero, |item| item["name"] == "Сеть").expect("сеть");
    assert_eq!((net["type"].clone(), net["quantity"].clone(), net["weight"].clone(), net["equipped"].clone()), (json!("weapon"), json!(1), json!(3), json!(true)));
}

#[test]
fn complete_mode_materializes_every_class_with_weights_and_quantities() {
    for entry in catalog(true)["classes"].as_array().expect("классы") {
        let class = entry["class_id"].as_str().expect("класс");
        let hero = json!({ "id": format!("complete-{class}"), "characterClass": class, "backgroundId": "acolyte", "inventory": [], "currency": {}, "phbCreation": { "schema_version": 1 } });
        let hero = m::with_starter_kit(Some(&hero), &options_2014()).expect("набор");
        let inventory = hero["inventory"].as_array().expect("инвентарь");
        assert!(!inventory.is_empty(), "{class}");
        for item in inventory {
            assert!(item["weight"].as_f64().is_some_and(f64::is_finite), "{class}: {} weight", item["name"]);
            assert!(item["quantity"].as_i64().is_some_and(|quantity| quantity >= 1), "{class}: {} quantity", item["name"]);
        }
    }
    let explorer = json!({
        "id": "pack-wizard", "characterClass": "wizard", "backgroundId": "sage", "inventory": [], "currency": {}, "phbCreation": { "schema_version": 1 },
        "starterEquipmentChoices": { "weapon": ["quarterstaff"], "focus": ["component-pouch"], "pack": ["explorers-pack"] },
    });
    let explorer = m::with_starter_kit(Some(&explorer), &options_2014()).expect("набор");
    let pack = find(&explorer, |item| item["catalog_id"] == "srd_5_2_1:explorers-pack").expect("набор путешественника");
    assert!(pack["contents"].as_array().expect("содержимое").iter().any(|item| item["name"] == "Сухой паёк, 1 день" && item["quantity"] == 10 && item["weight"] == 20));
}

#[test]
fn narrative_starter_items_get_existing_pictures() {
    let hero = |id: &str, class: &str, background: &str, complete: bool| {
        let mut hero = json!({ "id": id, "characterClass": class, "backgroundId": background, "inventory": [], "currency": {} });
        if complete {
            hero["phbCreation"] = json!({ "schema_version": 1 });
        }
        m::with_starter_kit(Some(&hero), &options_2014()).expect("набор")
    };
    let expected = [
        ("Книга заклинаний", "/assets/items/starter-2014/spellbook.png"),
        ("Мешочек с компонентами", "/assets/items/type-other.png"),
        ("Набор учёного", "/assets/items/item-srd-5-2-1-backpack.png"),
        ("Письмо от умершего коллеги", "/assets/items/type-document.png"),
    ];
    let complete = hero("art-complete", "wizard", "sage", true);
    for (name, image) in expected {
        assert_eq!(find(&complete, |item| item["name"] == name).map(|item| item["image"].clone()), Some(json!(image)), "{name}");
    }
    let cleric = hero("art-cleric", "cleric", "criminal", true);
    assert_eq!(find(&cleric, |item| item["name"] == "Священный символ").map(|item| item["image"].clone()), Some(json!("/assets/items/item-srd-5-2-1-holy-symbol-amulet.png")));
    let legacy = hero("art-legacy", "wizard", "sage", false);
    for (name, image) in &expected[..3] {
        assert_eq!(find(&legacy, |item| item["name"] == *name).map(|item| item["image"].clone()), Some(json!(image)), "legacy: {name}");
    }
}

#[test]
fn complete_catalog_has_physical_kit_of_every_background() {
    let complete = catalog(true);
    let backgrounds = complete["backgrounds"].as_array().expect("предыстории");
    for background in backgrounds {
        let mut entries: Vec<&Value> = Vec::new();
        for key in ["fixed_items", "fixed_narrative_items"] {
            entries.extend(background[key].as_array().into_iter().flatten());
        }
        for group in background["choice_groups"].as_array().into_iter().flatten() {
            for option in options(group) {
                entries.extend(option["items"].as_array().into_iter().flatten());
                entries.extend(option["narrative_items"].as_array().into_iter().flatten());
            }
        }
        assert!(!entries.is_empty(), "{}", background["background_id"]);
        for item in entries.into_iter().filter(|item| item.get("catalog_id").is_none()) {
            assert!(item["weight"].as_f64().is_some_and(f64::is_finite), "{}: {} weight", background["background_id"], item["name"]);
            assert!(item["quantity"].as_i64().is_some_and(|quantity| quantity >= 1), "{}: {} quantity", background["background_id"], item["name"]);
        }
    }
    let by_id = |id: &str| backgrounds.iter().find(|entry| entry["background_id"] == id).expect("предыстория");
    let guild = by_id("guild-artisan");
    assert_eq!(options(&guild["choice_groups"][0]).len(), 18);
    assert_eq!(options(&guild["choice_groups"][0]).iter().find(|option| option["id"] == "guild-merchant-mule-cart").expect("мул")["owned_assets"].as_array().map(Vec::len), Some(2));
    let entertainer = by_id("entertainer");
    assert_eq!(options(&entertainer["choice_groups"][0]).len(), 12);
    assert!(options(&entertainer["choice_groups"][0]).iter().any(|option| option["id"] == "gladiator-net"));
    assert_eq!(options(group(by_id("soldier"), "gaming-set")).len(), 4);
}

#[test]
fn complete_background_choices_are_normalized_and_validated() {
    let hero = json!({ "backgroundId": "guild-artisan", "phbCreation": { "schema_version": 1, "backgroundEquipmentChoices": { "artisan-tool": ["smiths_tools"] } } });
    let selected = m::complete_background_choices_for_hero(Some(&hero), None).expect("выбор");
    assert_eq!(selected["artisan-tool"], json!(["smiths_tools"]));
    assert_eq!(m::validate_complete_background_choices(Some(&json!("guild-artisan")), Some(&selected))["ok"], true);
    assert_eq!(m::validate_complete_background_choices(Some(&json!("guild-artisan")), Some(&json!({ "artisan-tool": ["not-a-tool"] })))["ok"], false);
}

// --- test/starter-background-items-2014.test.mjs ---

#[test]
fn starter_kit_keeps_background_items_for_every_class_and_background() {
    let backgrounds = background_catalog_for(RULESET_2014).expect("каталог предысторий");
    for background in backgrounds["options"].as_array().expect("предыстории") {
        let background_id = background["id"].as_str().expect("id");
        for profile in catalog(false)["classes"].as_array().expect("классы") {
            let choices = default_background_choices(background_id, RULESET_2014).expect("выбор").unwrap_or(Value::Null);
            let hero = json!({ "id": "hero-regression", "characterClass": profile["class_id"], "backgroundId": background_id, "backgroundChoices": choices });
            let hero = m::with_starter_kit(Some(&hero), &options_2014()).expect("набор");
            let pattern = sk_core::re!(r"^hero-regression-starter-background-\d+$");
            let items: Vec<Value> = hero["inventory"]
                .as_array()
                .expect("инвентарь")
                .iter()
                .filter(|item| sk_core::text::test(pattern, item["id"].as_str().unwrap_or_default()))
                .map(|item| json!({ "catalogId": item["catalog_id"], "quantity": item["quantity"] }))
                .collect();
            let expected: Vec<Value> = background["equipment"]["catalogItems"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|item| json!({ "catalogId": item["catalogId"], "quantity": item.get("quantity").cloned().unwrap_or(json!(1)) }))
                .collect();
            assert_eq!(items, expected, "{} / {background_id}", profile["class_id"]);
            let ids: HashSet<&str> = hero["inventory"].as_array().expect("инвентарь").iter().filter_map(|item| item["id"].as_str()).collect();
            assert_eq!(ids.len(), hero["inventory"].as_array().expect("инвентарь").len());
        }
    }
}

// --- test/character-creation-2014.test.mjs ---

#[test]
fn every_2014_class_gets_a_deterministic_kit_and_background_gold() {
    for class in ["barbarian", "bard", "cleric", "druid", "fighter", "monk", "paladin", "ranger", "rogue", "sorcerer", "warlock", "wizard"] {
        let hero = json!({
            "id": format!("starter-{class}"), "characterClass": class, "backgroundId": "soldier",
            "backgroundChoices": { "tools": ["dice_set"], "languages": [] }, "inventory": [], "currency": { "copper": 0, "silver": 0, "gold": 0, "platinum": 0 },
        });
        let hero = m::with_starter_kit(Some(&hero), &options_2014()).expect("набор");
        assert!(hero["inventory"].as_array().expect("инвентарь").len() >= 2, "{class}");
        assert_eq!(hero["currency"]["gold"], 10, "{class}");
        assert_eq!(hero["starterEquipmentPolicyId"], "skazanie.starter-equipment.dnd-5e-2014");
    }
}

#[test]
fn chosen_alternatives_materialize_and_foreign_option_is_refused() {
    let hero = json!({
        "id": "chosen-fighter", "characterClass": "fighter", "backgroundId": "soldier",
        "backgroundChoices": { "tools": ["dice_set"], "languages": [] },
        "starterEquipmentChoices": { "armor": ["leather-and-longbow"], "melee-loadout": ["greatsword"], "secondary": ["two-handaxes"], "pack": ["dungeoneers-pack"] },
        "inventory": [], "currency": { "copper": 0, "silver": 0, "gold": 0, "platinum": 0 },
    });
    let kit = m::with_starter_kit(Some(&hero), &options_2014()).expect("набор");
    assert!(ids(&kit).contains(&"srd_5_2_1:greatsword".to_string()));
    assert!(ids(&kit).contains(&"srd_5_2_1:longbow".to_string()));
    assert!(find(&kit, |item| item["name"] == "Набор исследователя подземелий").is_some());
    let mut forged = kit.clone();
    forged["inventory"] = json!([]);
    forged["starterEquipmentChoices"]["armor"] = json!(["plate-armor"]);
    match m::with_starter_kit(Some(&forged), &options_2014()) {
        Err(StarterKitError::Type(message)) => assert!(message.contains("неизвестный вариант"), "{message}"),
        other => panic!("ожидался отказ, получено {other:?}"),
    }
}

#[test]
fn legacy_event_before_policy_v2_gets_previous_kit() {
    let hero = json!({
        "id": "legacy-cleric", "characterClass": "cleric", "backgroundId": "soldier",
        "backgroundChoices": { "tools": ["dice_set"], "languages": [] }, "inventory": [], "currency": { "copper": 0, "silver": 0, "gold": 0, "platinum": 0 },
    });
    let legacy = m::with_starter_kit(Some(&hero), &StarterKitOptions { starter_policy_version: Some(json!(1)), ..options_2014() }).expect("набор");
    assert!(ids(&legacy).contains(&"srd_5_2_1:explorers-pack".to_string()));
    assert!(find(&legacy, |item| item["name"] == "Набор священника").is_none());
}

// --- test/hero-ammunition.test.mjs ---

#[test]
fn archer_kit_carries_a_quiver_and_sword_does_not() {
    let ranger = m::with_starter_kit(Some(&json!({ "id": "lira", "role": "Следопыт" })), &StarterKitOptions::default()).expect("набор");
    assert!(ids(&ranger).contains(&"srd_5_2_1:shortbow".to_string()), "лук на месте");
    let quiver = find(&ranger, |item| item["catalog_id"] == "srd_5_2_1:arrows-20").expect("лук без стрел на старте недопустим");
    assert_eq!(ammunition_shots_left(Some(quiver)), 20);
    let fighter = m::with_starter_kit(Some(&json!({ "id": "brann", "role": "Воин" })), &StarterKitOptions::default()).expect("набор");
    assert!(!ids(&fighter).contains(&"srd_5_2_1:arrows-20".to_string()));
    let imported = json!({ "id": "own", "role": "Следопыт", "inventory": [{ "id": "own-bow", "name": "Свой лук", "type": "weapon", "quantity": 1 }] });
    let imported = m::with_starter_kit(Some(&imported), &StarterKitOptions::default()).expect("набор");
    assert_eq!(imported["inventory"].as_array().expect("инвентарь").iter().map(|item| item["id"].clone()).collect::<Vec<_>>(), [json!("own-bow")]);
}

// --- test/regression-2026-07-26.test.mjs ---

#[test]
fn starter_kit_gives_armour_to_classes_that_wear_it() {
    let cleric = m::with_starter_kit(Some(&json!({ "id": "hero-slot-4", "characterClass": "cleric", "role": "Жрец · ур. 1" })), &StarterKitOptions::default()).expect("набор");
    assert!(ids(&cleric).contains(&"srd_5_2_1:leather-armor".to_string()), "жрец выходил в бой без доспеха");
    assert!(ids(&cleric).contains(&"srd_5_2_1:shield".to_string()));
    let wizard = m::with_starter_kit(Some(&json!({ "id": "hero-slot-1", "characterClass": "wizard", "role": "Волшебник · ур. 1" })), &StarterKitOptions::default()).expect("набор");
    assert_eq!(ids(&wizard), ["srd_5_2_1:dagger"], "волшебник доспехом не владеет");
    let imported = json!({ "id": "hero-slot-2", "characterClass": "fighter", "inventory": [{ "catalog_id": "srd_5_2_1:longsword", "name": "Длинный меч" }] });
    assert_eq!(m::with_starter_kit(Some(&imported), &StarterKitOptions::default()).expect("набор")["inventory"].as_array().map(Vec::len), Some(1), "готовый лист не дополняется снаряжением");
}

// --- test/spell-component-items.test.mjs ---

#[test]
fn bard_instruments_are_focuses_in_complete_catalog_and_kit() {
    let complete = catalog(true);
    let instruments = options(group(class_entry(&complete, "bard"), "instrument"));
    for option in instruments {
        let items = option["items"].as_array().expect("предметы");
        let catalog_id = items[0]["catalog_id"].as_str().expect("каталог");
        assert_eq!(items[0], json!({ "catalog_id": catalog_id, "quantity": 1, "name": catalog_item(catalog_id).expect("запись")["name"] }));
    }
    let bard = json!({
        "id": "component-bard", "characterClass": "bard", "inventory": [], "currency": {}, "phbCreation": { "schema_version": 1 },
        "starterEquipmentChoices": { "weapon": ["rapier"], "pack": ["entertainers-pack"], "instrument": ["lute"] },
    });
    let bard = m::with_starter_kit(Some(&bard), &options_2014()).expect("набор");
    let lute = find(&bard, |item| item["catalog_id"] == "srd_5_2_1:lute").expect("лютня");
    assert_eq!(lute["spellcasting_focus"], json!(["bard"]));
    assert_eq!(lute["focus_mode"], "held");
    assert_eq!(lute["image"], "/assets/items/item-srd-5-2-1-lute.png");
}

#[test]
fn starter_kit_creates_real_component_instances() {
    let complete = catalog(true);
    let focus = group(class_entry(&complete, "wizard"), "focus");
    let short = |id: &str| -> Vec<Value> {
        options(focus).iter().find(|option| option["id"] == id).expect("вариант")["items"].as_array().expect("предметы").iter().map(|item| json!({ "catalog_id": item["catalog_id"], "quantity": item["quantity"] })).collect()
    };
    assert_eq!(short("component-pouch"), [json!({ "catalog_id": "srd_5_2_1:component-pouch", "quantity": 1 })]);
    assert_eq!(short("arcane-focus"), [json!({ "catalog_id": "srd_5_2_1:arcane-focus-crystal", "quantity": 1 })]);
    let wizard = json!({
        "id": "component-wizard", "characterClass": "wizard", "inventory": [], "currency": {}, "phbCreation": { "schema_version": 1 },
        "starterEquipmentChoices": { "weapon": ["quarterstaff"], "focus": ["component-pouch"], "pack": ["explorers-pack"] },
    });
    let wizard = m::with_starter_kit(Some(&wizard), &options_2014()).expect("набор");
    assert_eq!(find(&wizard, |item| item["catalog_id"] == "srd_5_2_1:component-pouch").map(|item| item["component_pouch"].clone()), Some(json!(true)));
    let druid = m::with_starter_kit(Some(&json!({ "id": "component-druid", "characterClass": "druid", "inventory": [], "currency": {}, "phbCreation": { "schema_version": 1 } })), &options_2014()).expect("набор");
    assert!(find(&druid, |item| item["catalog_id"] == "srd_5_2_1:druidic-focus-mistletoe").is_some_and(|item| item["spellcasting_focus"].as_array().is_some_and(|classes| classes.contains(&json!("druid")))));
    let cleric = m::with_starter_kit(Some(&json!({ "id": "component-cleric", "characterClass": "cleric", "inventory": [], "currency": {}, "phbCreation": { "schema_version": 1 } })), &options_2014()).expect("набор");
    let symbol = find(&cleric, |item| item["catalog_id"] == "srd_5_2_1:holy-symbol-amulet").expect("символ");
    assert!(symbol["spellcasting_focus"].as_array().is_some_and(|classes| classes.contains(&json!("cleric"))));
    assert_eq!(symbol["equipped"], true);
    assert_eq!(symbol["focus_mode"], "worn");
}

// --- test/free-text-attack-weapon.test.mjs ---

#[test]
fn rogue_2024_kit_holds_a_shortsword_and_a_shortbow() {
    let rogue = json!({ "id": "rogue", "character": "Плут", "characterClass": "rogue", "level": 3, "abilities": { "str": 8, "dex": 16, "con": 14, "int": 13, "wis": 10, "cha": 12 }, "inventory": [], "currency": {} });
    let options = StarterKitOptions { ruleset_id: RULESET_2024.into(), starter_policy_id: Some(STARTER_KIT_2024_POLICY.policy_id.into()), ..StarterKitOptions::default() };
    let rogue = m::with_starter_kit(Some(&rogue), &options).expect("набор");
    let sword = find(&rogue, |item| item["catalog_id"] == "srd_5_2_1:shortsword").expect("короткий меч");
    assert_eq!(sword["equipped"], true);
    assert!(find(&rogue, |item| item["catalog_id"] == "srd_5_2_1:shortbow").is_some());
    assert_eq!(rogue["abilities"]["str"], 8, "готовые характеристики не переписываются");
}

// --- переносные проверки ---

#[test]
fn every_kit_item_and_weapon_list_is_in_the_catalog() {
    // В JS неизвестное оружие или предмет набора бросали бы `TypeError` при
    // загрузке модуля; в Rust такие строки молча выпали бы — держим списки здесь.
    for class in ["barbarian", "bard", "cleric", "druid", "fighter", "monk", "paladin", "ranger", "rogue", "sorcerer", "warlock", "wizard", "fighter-dex"] {
        let preview = m::starter_kit_2024_preview(class).expect("набор 2024");
        for item in preview["fixed_items"].as_array().expect("предметы") {
            assert!(catalog_item(item["catalog_id"].as_str().expect("id")).is_some(), "{class}: {}", item["catalog_id"]);
        }
    }
    let complete = catalog(true);
    let melee = options(group(class_entry(&complete, "fighter"), "melee-loadout"));
    // Щит с каждым из 23 воинских оружий; «длинный меч и щит» и «боевой топор
    // и щит» уже есть среди вариантов policy v2, и публичный каталог их не повторяет.
    assert_eq!(melee.iter().filter(|option| option["id"].as_str().is_some_and(|id| id.starts_with("martial-and-shield-"))).count(), 21);
    assert!(m::starter_kit_2024_preview("constructor").is_none(), "ключ прототипа — не класс");
}

#[test]
fn prototype_class_key_is_unknown_class() {
    // Класс-ключ прототипа — без набора 2024: запасной кинжал, а не `TypeError`.
    let options = StarterKitOptions { ruleset_id: RULESET_2024.into(), starter_policy_id: Some(STARTER_KIT_2024_POLICY.policy_id.into()), ..StarterKitOptions::default() };
    let hero = m::with_starter_kit(Some(&json!({ "id": "x", "characterClass": "toString" })), &options).expect("герой");
    let ids: Vec<&str> = hero["inventory"].as_array().expect("вещи").iter().filter_map(|item| item["catalog_id"].as_str()).collect();
    assert_eq!(ids, ["srd_5_2_1:dagger"]);
    let imported = json!({ "id": "x", "characterClass": "toString", "inventory": [{ "id": "own" }] });
    assert!(m::with_starter_kit(Some(&imported), &options).is_ok(), "готовый инвентарь набор не трогает");
}

// --- test/character-creation-equipment-complete.test.mjs ---

/// Класс, узнанный по роли, выбирает набор 2014 (прежде — «Для класса нет
/// стартового набора 2014»; такой импорт не проходил, старых событий с ним нет).
#[test]
fn role_recognised_class_picks_2014_class_kit() {
    for (role, class) in [("Воин", "fighter"), ("Волшебник", "wizard")] {
        let hero = json!({ "id": "by-role", "role": role, "inventory": [], "currency": {} });
        let kit = m::with_starter_kit(Some(&hero), &options_2014()).expect("набор по роли");
        assert_eq!(kit["characterClass"], json!(class));
        assert!(kit["inventory"].as_array().expect("инвентарь").len() > 1, "{role}: набор класса, а не одно оружие");
        assert!(kit["starterEquipmentChoices"].as_object().is_some_and(|choices| !choices.is_empty()), "{role}");
    }
}

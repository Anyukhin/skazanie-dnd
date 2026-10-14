//! Сверка `equipment_visuals` и `actor_appearance` с JS: эталон
//! `fixtures/equipment-appearance.json` (`fixtures/gen-equipment-appearance.mjs`)
//! и перенесённые проверки `test/equipment-visuals.test.mjs`,
//! `test/attack-visual-event.test.mjs`, `test/actor-appearance-projection.test.mjs`,
//! `test/dragon-model.test.mjs`, `test/creature-models.test.mjs`,
//! `test/model-scale.test.mjs` (в части модуля).

mod common;

use std::sync::LazyLock;

use common::{opt, Mismatches};
use serde_json::{json, Value};
use sk_scene_base::actor_appearance::*;
use sk_scene_base::equipment_visuals::*;

static FIXTURE: LazyLock<Value> =
    LazyLock::new(|| serde_json::from_str(include_str!("../fixtures/equipment-appearance.json")).expect("эталон equipment-appearance"));

fn loadout(items: Value) -> Value {
    Value::Object(public_loadout_for_items(&items, None))
}

#[test]
fn constants_match_js() {
    let constants = &FIXTURE["constants"];
    assert_eq!(constants["EQUIPMENT_VISUAL_SCHEMA_VERSION"], json!(EQUIPMENT_VISUAL_SCHEMA_VERSION));
    assert_eq!(constants["EQUIPMENT_VISUAL_SLOTS"], json!(EQUIPMENT_VISUAL_SLOTS));
    assert_eq!(constants["EQUIPMENT_VISUAL_VARIANTS"], json!(EQUIPMENT_VISUAL_VARIANTS));
    assert_eq!(constants["EQUIPMENT_VISUAL_MODEL_KEYS"], json!(*EQUIPMENT_VISUAL_MODEL_KEYS));
    assert_eq!(constants["ACTOR_APPEARANCE_PROFILES"], json!(ACTOR_APPEARANCE_PROFILES));
    assert_eq!(constants["ACTOR_APPEARANCE_EQUIPMENT"], json!(ACTOR_APPEARANCE_EQUIPMENT));
    assert_eq!(constants["ACTOR_APPEARANCE_STATURES"], json!(ACTOR_APPEARANCE_STATURES));
    let visuals: Vec<Value> =
        EQUIPMENT_ITEM_VISUALS.iter().map(|(id, visual)| json!([id, visual.slot, visual.model_key, visual.variant])).collect();
    assert_eq!(constants["itemVisuals"], Value::Array(visuals));
}

#[test]
fn catalog_lookup_and_normalizers_match_js() {
    let mut check = Mismatches::new();
    for case in FIXTURE["itemVisuals"].as_array().expect("itemVisuals") {
        let actual = item_visual_for_catalog_id(opt(&case["id"])).map(|visual| visual.to_value()).unwrap_or(Value::Null);
        check.check(&actual, &case["output"], || format!("каталог {}", case["id"]));
    }
    for case in FIXTURE["normalizers"].as_array().expect("normalizers") {
        let value = opt(&case["value"]);
        check.check(&json!(normalize_equipment_visual_slot(value)), &case["slot"], || format!("слот {}", case["value"]));
        check.check(&json!(normalize_equipment_visual_variant(value)), &case["variant"], || format!("вариант {}", case["value"]));
        check.check(&json!(normalize_equipment_visual_variant_or(value, None)), &case["variantNull"], || format!("вариант/null {}", case["value"]));
        check.check(&json!(normalize_equipment_model_key(value)), &case["modelKey"], || format!("модель {}", case["value"]));
        check.check(&json!(model_keys_for_equipment_slot(value)), &case["slotKeys"], || format!("ключи слота {}", case["value"]));
    }
    check.finish("каталог и нормализаторы");
}

#[test]
fn loadouts_match_js() {
    let mut check = Mismatches::new();
    for case in FIXTURE["loadouts"].as_array().expect("loadouts") {
        let additional = opt(&case["additional"]);
        check.check(&Value::Object(public_loadout_for_items(&case["items"], additional)), &case["loadout"], || format!("loadout {} + {}", case["items"], case["additional"]));
        check.check(&loadout(case["items"].clone()), &case["plain"], || format!("loadout {}", case["items"]));
        check.check(&json!(equipment_for_public_items(Some(&case["items"]))), &case["equipment"], || format!("оружие {}", case["items"]));
    }
    for case in FIXTURE["publicLoadouts"].as_array().expect("publicLoadouts") {
        check.check(&Value::Object(normalize_public_loadout(Some(&case["value"]))), &case["output"], || format!("нормализация {}", case["value"]));
    }
    check.finish("loadout");
}

#[test]
fn appearances_match_js() {
    let mut check = Mismatches::new();
    for case in FIXTURE["appearances"].as_array().expect("appearances") {
        let kind = opt(&case["kind"]);
        let actor = opt(&case["actor"]);
        check.check(&actor_appearance_for(kind, actor), &case["appearance"], || format!("облик {} {}", case["kind"], case["actor"]));
        let profile_input = actor.filter(|actor| actor.is_object()).map(|actor| sk_core::js::spread(actor, json!({ "kind": case["kind"] })));
        check.check(&json!(actor_profile_for(profile_input.as_ref())), &case["profile"], || format!("профиль {} {}", case["kind"], case["actor"]));
        check.check(&json!(actor_stature_for(kind, actor)), &case["stature"], || format!("рост {} {}", case["kind"], case["actor"]));
        check.check(&json!(public_appearance_record(&case["actor"])), &case["record"], || format!("публичность {}", case["actor"]));
    }
    for case in FIXTURE["dragons"].as_array().expect("dragons") {
        check.check(&json!(names_dragon(opt(&case["value"]))), &case["output"], || format!("дракон {}", case["value"]));
    }
    check.finish("облик");
}

#[test]
fn attack_visuals_match_js() {
    let mut check = Mismatches::new();
    for case in FIXTURE["attackVisuals"].as_array().expect("attackVisuals") {
        check.check(&normalize_attack_visual(opt(&case["value"])).unwrap_or(Value::Null), &case["output"], || format!("снимок {}", case["value"]));
    }
    for case in FIXTURE["attacks"].as_array().expect("attacks") {
        check.check(&attack_visual_for(opt(&case["input"])), &case["output"], || format!("атака {}", case["input"]));
    }
    check.finish("снимок атаки");
}

// --- Перенесённые проверки test/equipment-visuals.test.mjs ---------------------

#[test]
fn catalog_entries_have_stable_models() {
    assert_eq!(EQUIPMENT_ITEM_VISUALS.len(), 83);
    let visual = |id: &str| item_visual_for_catalog_id(Some(&json!(id))).expect(id);
    assert_eq!(visual("srd_5_2_1:longsword-plus-1").model_key.as_deref(), Some("longsword"));
    assert_eq!(visual("srd_5_2_1:adamantine-chain-mail").model_key.as_deref(), Some("armor-chainmail"));
    assert_eq!(visual("srd_5_2_1:flame-tongue-longsword").variant.as_deref(), Some("flaming"));
    assert_eq!(visual("srd_5_2_1:holy-symbol-amulet").to_value(), json!({ "slot": "focus", "model_key": "holy-amulet" }));
    assert_eq!(visual("srd_5_2_1:holy-symbol-emblem").to_value(), json!({ "slot": "off_hand", "model_key": "holy-emblem" }));
    assert_eq!(visual("srd_5_2_1:lute").to_value(), json!({ "slot": "main_hand", "model_key": "lute" }));
    assert_eq!(EQUIPMENT_VISUAL_SCHEMA_VERSION, 2);
}

#[test]
fn authored_net_passes_main_hand_without_catalog_card() {
    assert!(item_visual_for_catalog_id(Some(&json!("srd_5_2_1:net"))).is_none());
    assert_eq!(Value::Object(normalize_public_loadout(Some(&json!({ "main_hand": { "model_key": "net" } })))), json!({ "main_hand": { "model_key": "net" } }));
    assert_eq!(loadout(json!([{ "id": "net", "type": "weapon", "name": "Сеть", "equipped": true }])), json!({ "main_hand": { "model_key": "net" } }));
}

#[test]
fn loadout_from_worn_items_and_magic_variants() {
    let actual = loadout(json!([
        { "id": "plate", "catalog_id": "srd_5_2_1:plate-armor", "equipped": true },
        { "id": "flame", "catalog_id": "srd_5_2_1:flame-tongue-longsword", "equipped": true, "activated": true },
        { "id": "shield", "catalog_id": "srd_5_2_1:shield", "equipped": true },
        { "id": "cloak", "catalog_id": "srd_5_2_1:cloak-of-protection", "equipped": true },
        { "id": "ring", "catalog_id": "srd_5_2_1:ring-of-protection", "equipped": true },
        { "id": "brooch", "catalog_id": "srd_5_2_1:brooch-of-shielding", "equipped": false },
    ]));
    assert_eq!(
        actual,
        json!({
            "body": { "model_key": "armor-plate" },
            "main_hand": { "model_key": "longsword", "variant": "flaming" },
            "off_hand": { "model_key": "shield" },
            "cloak": { "model_key": "cloak", "variant": "enchanted" },
            "ring-protection": { "model_key": "ring", "variant": "enchanted" },
        })
    );
}

#[test]
fn unidentified_magic_hides_variant_and_flaming_needs_activation() {
    assert_eq!(
        loadout(json!([
            { "id": "unknown-flame", "catalog_id": "srd_5_2_1:flame-tongue-longsword", "equipped": true, "identified": false, "activated": true },
            { "id": "unknown-mail", "catalog_id": "srd_5_2_1:adamantine-chain-mail", "equipped": true, "identified": false },
        ])),
        json!({ "main_hand": { "model_key": "longsword" }, "body": { "model_key": "armor-chainmail" } })
    );
    assert_eq!(
        loadout(json!([{ "id": "known-flame-off", "catalog_id": "srd_5_2_1:flame-tongue-longsword", "equipped": true, "identified": true, "activated": false }])),
        json!({ "main_hand": { "model_key": "longsword", "variant": "enchanted" } })
    );
    assert_eq!(
        loadout(json!([{ "id": "known-flame-on", "catalog_id": "srd_5_2_1:flame-tongue-longsword", "equipped": true, "identified": true, "activated": true }])),
        json!({ "main_hand": { "model_key": "longsword", "variant": "flaming" } })
    );
}

#[test]
fn hidden_items_skipped_and_unknown_worn_item_gives_null() {
    assert_eq!(
        loadout(json!([
            { "id": "hidden", "catalog_id": "srd_5_2_1:plate-armor", "equipped": true, "visibility": "gm_only" },
            { "id": "custom", "type": "weapon", "name": "Древний клинок", "combat": { "kind": "melee" }, "equipped": true },
            { "id": "legacy", "type": "weapon", "name": "Длинный меч", "equipped": true },
        ])),
        json!({ "main_hand": null })
    );
}

#[test]
fn legacy_name_matches_only_exactly() {
    assert_eq!(loadout(json!([{ "id": "exact", "type": "weapon", "name": "Длинный меч", "equipped": true }])), json!({ "main_hand": { "model_key": "longsword" } }));
    assert_eq!(
        loadout(json!([{ "id": "ambiguous", "type": "weapon", "name": "Меч с красной руной", "combat": { "kind": "melee" }, "equipped": true }])),
        json!({ "main_hand": null })
    );
    assert_eq!(loadout(json!([{ "id": "bow", "type": "weapon", "name": "Длинный лук", "equipped": true }])), json!({ "main_hand": { "model_key": "longbow" } }));
}

#[test]
fn duplicate_slot_closes_with_null_and_normalizer_drops_extra_fields() {
    assert_eq!(
        loadout(json!([{ "id": "one", "catalog_id": "srd_5_2_1:longsword", "equipped": true }, { "id": "two", "catalog_id": "srd_5_2_1:dagger", "equipped": true }])),
        json!({ "main_hand": null })
    );
    let normalized = normalize_public_loadout(Some(&json!({
        "main_hand": { "model_key": "longsword", "variant": "flaming", "item_id": "secret" },
        "body": { "model_key": "armor-plate", "variant": "adamantine" },
        "off_hand": { "model_key": "../secret.glb" },
        "cloak": { "model_key": "ring" },
        "url": "https://private.invalid/model.glb",
    })));
    assert_eq!(
        Value::Object(normalized),
        json!({
            "main_hand": { "model_key": "longsword", "variant": "flaming" },
            "body": { "model_key": "armor-plate", "variant": "adamantine" },
            "off_hand": null,
            "cloak": null,
        })
    );
    assert!(model_keys_for_equipment_slot(Some(&json!("main_hand"))).contains(&"longsword"));
    assert!(model_keys_for_equipment_slot(Some(&json!("unknown"))).is_empty());
}

#[test]
fn legacy_attack_visual_v1_stays_next_to_v2() {
    assert_eq!(normalize_attack_visual(Some(&json!({ "version": 1, "equipment": "bow", "private": "drop" }))), Some(json!({ "version": 1, "equipment": "bow" })));
    let v2 = json!({ "version": 2, "equipment": "sword-shield", "loadout": { "main_hand": { "model_key": "longsword" }, "off_hand": { "model_key": "shield" } } });
    assert_eq!(normalize_attack_visual(Some(&v2)), Some(v2.clone()));
}

// --- test/attack-visual-event.test.mjs: снимок атаки ---------------------------

fn sword() -> Value {
    json!({ "id": "sword", "catalog_id": "srd_5_2_1:longsword", "name": "Длинный меч", "type": "weapon", "quantity": 1, "equipped": true })
}

fn shield() -> Value {
    json!({ "id": "shield", "catalog_id": "srd_5_2_1:shield", "name": "Щит", "type": "armor", "quantity": 1, "equipped": true })
}

#[test]
fn selected_weapon_replaces_hand_and_keeps_shield_and_armor() {
    let dagger = json!({ "id": "dagger", "catalog_id": "srd_5_2_1:dagger", "type": "weapon", "quantity": 1, "equipped": false });
    let plate = json!({ "id": "plate", "catalog_id": "srd_5_2_1:plate-armor", "type": "armor", "quantity": 1, "equipped": true });
    let items = json!([sword(), shield(), dagger, plate]);
    let visual = attack_visual_for(Some(&json!({ "item": dagger, "items": items, "attackKind": "melee" })));
    assert_eq!(visual["loadout"], json!({ "main_hand": { "model_key": "dagger" }, "off_hand": { "model_key": "shield" }, "body": { "model_key": "armor-plate" } }));
    assert_eq!(items[2]["equipped"], json!(false), "снимок не мутирует инвентарь");
    assert_eq!(items[0]["equipped"], json!(true));
}

#[test]
fn hidden_shield_does_not_show_in_attack() {
    let expected = json!({ "version": 2, "equipment": "sword", "loadout": { "main_hand": { "model_key": "longsword" } } });
    let hidden = sk_core::js::spread(&shield(), json!({ "visibility": "gm_only" }));
    assert_eq!(attack_visual_for(Some(&json!({ "item": sword(), "items": [sword(), hidden] }))), expected);
    for key in ["visibility_level", "visibilityLevel"] {
        for value in ["gm_only", "specific_player"] {
            let marked = sk_core::js::spread(&shield(), json!({ key: value }));
            assert_eq!(attack_visual_for(Some(&json!({ "item": sword(), "items": [sword(), marked] }))), expected);
        }
    }
    let party = sk_core::js::spread(&shield(), json!({ "visibility": "party" }));
    assert_eq!(
        attack_visual_for(Some(&json!({ "item": sword(), "items": [sword(), party] }))),
        json!({ "version": 2, "equipment": "sword-shield", "loadout": { "main_hand": { "model_key": "longsword" }, "off_hand": { "model_key": "shield" } } })
    );
}

#[test]
fn magic_attack_snapshot_hides_unidentified_or_dormant_variant() {
    let flame = json!({ "id": "flame", "catalog_id": "srd_5_2_1:flame-tongue-longsword", "type": "weapon", "name": "Огненный длинный меч", "equipped": true });
    let with = |patch: Value| sk_core::js::spread(&flame, patch);
    let unknown = with(json!({ "identified": false, "activated": true }));
    assert_eq!(
        attack_visual_for(Some(&json!({ "item": unknown, "items": [unknown] }))),
        json!({ "version": 2, "equipment": "sword", "loadout": { "main_hand": { "model_key": "longsword" } } })
    );
    let dormant = with(json!({ "identified": true, "activated": false }));
    assert_eq!(
        attack_visual_for(Some(&json!({ "item": dormant, "items": [dormant] }))),
        json!({ "version": 2, "equipment": "sword", "loadout": { "main_hand": { "model_key": "longsword", "variant": "enchanted" } } })
    );
    let lit = with(json!({ "identified": true, "activated": true }));
    assert_eq!(
        attack_visual_for(Some(&json!({ "item": lit, "items": [lit] }))),
        json!({ "version": 2, "equipment": "sword", "loadout": { "main_hand": { "model_key": "longsword", "variant": "flaming" } } })
    );
}

#[test]
fn npc_visual_comes_from_public_action_not_hidden_binding() {
    assert_eq!(
        attack_visual_for(Some(&json!({ "actionName": "Дальний удар", "attackKind": "ranged", "npcBinding": { "catalog_id": "srd_5_2_1:longbow", "item_instance_id": "secret-bow" } }))),
        json!({ "version": 2, "equipment": "unknown", "loadout": {} })
    );
    assert_eq!(
        attack_visual_for(Some(&json!({ "actionName": "Короткий лук", "attackKind": "ranged" }))),
        json!({ "version": 2, "equipment": "bow", "loadout": { "main_hand": { "model_key": "shortbow" } } })
    );
    assert_eq!(attack_visual_for(Some(&json!({ "actionName": "crossbow", "attackKind": "ranged" }))), json!({ "version": 2, "equipment": "unknown", "loadout": {} }));
    assert_eq!(attack_visual_for(Some(&json!({ "actionName": "Арбалет", "attackKind": "ranged" }))), json!({ "version": 2, "equipment": "unknown", "loadout": {} }));
}

// --- test/actor-appearance-projection.test.mjs: облик через actorAppearanceFor ---

#[test]
fn hero_and_enemy_appearance_without_inventory_copy() {
    let long_sword = json!({ "id": "sword", "type": "weapon", "name": "Длинный меч", "equipped": true });
    let plain_shield = json!({ "id": "shield", "type": "armor", "name": "Щит", "equipped": true });
    let hero_a = json!({ "id": "hero-a", "character": "Гоблинус", "characterClass": "fighter", "inventory": [long_sword, plain_shield] });
    assert_eq!(
        actor_appearance_for(Some(&json!("hero")), Some(&hero_a)),
        json!({ "version": 2, "profile": "warrior", "equipment": "sword-shield", "loadout": { "main_hand": { "model_key": "longsword" }, "off_hand": { "model_key": "shield" } } })
    );
    let hero_b = json!({ "id": "hero-b", "character": "Лира", "characterClass": "wizard", "inventory": [] });
    assert_eq!(actor_appearance_for(Some(&json!("hero")), Some(&hero_b)), json!({ "version": 2, "profile": "mage", "equipment": "unarmed", "loadout": {} }));
    let seen = json!({ "id": "seen", "name": "Скелет", "creature_type": "undead", "inventory": [{ "name": "Тайный посох", "equipped": true, "type": "weapon" }] });
    assert_eq!(actor_appearance_for(Some(&json!("enemy")), Some(&seen)), json!({ "version": 2, "profile": "skeleton", "equipment": "unknown", "loadout": {} }));
    assert!(!public_appearance_record(&json!({ "id": "hidden", "name": "Гоблин", "visibility": "gm_only" })));
    let hidden_item = json!({ "id": "hero-a", "characterClass": "fighter", "inventory": [sk_core::js::spread(&long_sword, json!({ "name": "Тайный меч", "visibility": "gm_only" }))] });
    assert_eq!(actor_appearance_for(Some(&json!("hero")), Some(&hidden_item))["equipment"], "unarmed");
}

#[test]
fn bow_staff_and_ambiguous_set_give_safe_variants() {
    let item = |name: &str| json!({ "id": "sword", "type": "weapon", "name": name, "equipped": true });
    let equipment = |inventory: Value| actor_appearance_for(Some(&json!("hero")), Some(&json!({ "characterClass": "ranger", "inventory": inventory })))["equipment"].clone();
    assert_eq!(equipment(json!([item("Длинный лук")])), "bow");
    assert_eq!(equipment(json!([item("Посох")])), "staff");
    assert_eq!(equipment(json!([item("Кинжал")])), "dagger");
    assert_eq!(equipment(json!([item("Арбалет")])), "unknown");
    assert_eq!(equipment(json!([item("Длинный меч"), { "id": "bow", "type": "weapon", "name": "Длинный лук", "equipped": true }])), "unknown");
    assert_eq!(equipment(json!([{ "id": "sword", "type": "weapon", "name": "Длинный меч", "equipped": false }])), "unarmed");
}

#[test]
fn masked_identity_is_not_restored_by_creature_type() {
    let masked = json!({
        "id": "masked", "name": "Неизвестное существо", "creature_type": "goblin",
        "inventory": [{ "id": "secret-bow", "name": "Лук", "type": "weapon", "equipped": true, "visibility": "gm_only" }],
    });
    assert_eq!(actor_appearance_for(Some(&json!("enemy")), Some(&masked)), json!({ "version": 2, "profile": "warrior", "equipment": "unknown", "loadout": {} }));
}

// --- test/dragon-model.test.mjs, test/creature-models.test.mjs ------------------

fn profile(actor: Value) -> &'static str {
    actor_profile_for(Some(&actor))
}

#[test]
fn dragon_gets_dragon_profile_and_masked_one_does_not() {
    assert_eq!(profile(json!({ "kind": "enemy", "name": "Саргат", "role": "молодой красный дракон и наследник Вулканиса" })), "dragon");
    assert_eq!(profile(json!({ "kind": "enemy", "name": "Red Wyrmling" })), "dragon");
    assert_eq!(actor_appearance_for(Some(&json!("enemy")), Some(&json!({ "id": "astohan-sargat", "name": "Саргат", "creature_type": "dragon" })))["profile"], "dragon");
    assert_eq!(profile(json!({ "kind": "enemy", "name": "Волк" })), "beast");
    assert_eq!(profile(json!({ "kind": "enemy", "name": "Неизвестная тень", "role": "дракон", "masked": true })), "warrior");
}

#[test]
fn dragon_slayer_and_dragonborn_are_not_dragons() {
    for role in ["король Валедора и прославленный драконоборец", "охотник на драконов", "dragon slayer", "драконорождённый паладин"] {
        assert_ne!(profile(json!({ "kind": "npc", "name": "Арес", "role": role })), "dragon", "{role}");
    }
    assert_eq!(profile(json!({ "kind": "enemy", "name": "Тварь", "role": "виверна" })), "dragon");
}

#[test]
fn beast_by_whole_word_and_creature_type() {
    for name in ["Гигантская крыса 1", "Рой крыс", "Гигантский паук", "Гигантская оса 2", "Гигантская жаба", "Ядовитая змея", "Giant Spider"] {
        assert_eq!(profile(json!({ "kind": "enemy", "name": name })), "beast", "{name}");
    }
    for name in ["Крысолов", "Осада", "Паукообразный жрец", "Сотник Жуков"] {
        assert_ne!(profile(json!({ "kind": "enemy", "name": name })), "beast", "{name}");
    }
    assert_eq!(profile(json!({ "kind": "enemy", "name": "Тень в кустах", "creature_type": "beast" })), "beast");
    assert_eq!(profile(json!({ "kind": "enemy", "name": "Неизвестный", "creature_type": "beast", "masked": true })), "warrior");
    assert_eq!(actor_appearance_for(Some(&json!("enemy")), Some(&json!({ "name": "Гигантская крыса", "size": "small" })))["stature"], "small");
}

// --- test/model-scale.test.mjs: категория размера ------------------------------

#[test]
fn stature_from_stat_block_and_hero_species() {
    let stature = |kind: &str, actor: Value| actor_stature_for(Some(&json!(kind)), Some(&actor));
    assert_eq!(stature("hero", json!({ "species": "Легконогий полурослик" })), Some("small"));
    assert_eq!(stature("hero", json!({ "species": "Лесной гном" })), Some("small"));
    assert_eq!(stature("hero", json!({ "species": "Холмовой дварф" })), None, "дварф — средний");
    assert_eq!(stature("enemy", json!({ "size": "tiny" })), Some("tiny"));
    assert_eq!(stature("enemy", json!({ "size": "Huge" })), Some("huge"));
    assert_eq!(stature("enemy", json!({ "species": "полурослик" })), None, "у врага раса не читается");
    assert_eq!(actor_appearance_for(Some(&json!("hero")), Some(&json!({ "species": "Коренастый полурослик", "characterClass": "Плут" })))["stature"], "small");
    assert!(actor_appearance_for(Some(&json!("hero")), Some(&json!({ "species": "Человек", "characterClass": "Воин" }))).get("stature").is_none());
    assert!(actor_appearance_for(Some(&json!("enemy")), Some(&json!({ "name": "Разбойник", "size": "medium" }))).get("stature").is_none());
    let masked = actor_appearance_for(Some(&json!("enemy")), Some(&json!({ "name": "Неизвестный", "size": "large", "masked": true })));
    assert_eq!(masked["profile"], "warrior");
    assert_eq!(masked["stature"], "large");
}

//! Сверка `dndsu_2014_content` с эталоном JS (`fixtures/dndsu-2014-content.json`,
//! генератор `fixtures/gen-dndsu-2014-content.mjs`) и перенос
//! `test/dndsu-2014-content.test.mjs`.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use serde_json::{json, Value};
use sk_combat_base::dndsu_2014_content::{
    assert_2014_campaign, default_dndsu_2014_content, dice_average, get_content_record, load_dndsu_2014_content, load_reference_rule_pack, mechanical_tokens, search_content,
    to_retrieval_chunks, validate_dndsu_2014_content, ContentError, DEFAULT_CONTENT_DIRECTORY,
};
use sk_core::hash::sha256_hex;

static FIXTURE: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("../fixtures/dndsu-2014-content.json")).expect("эталон справочника"));

fn content() -> &'static Value {
    default_dndsu_2014_content().expect("встроенный справочник")
}

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}

/// Отказ в форме эталона: у `TypeError` сверяется только вид — тексты V8 и
/// переноса о чтении поля у `undefined` расходятся.
fn outcome(result: Result<Value, ContentError>, expected: &Value) -> Value {
    match result {
        Ok(value) => json!({ "ok": value }),
        Err(ContentError::Validation(message)) => json!({ "name": "ContentValidationError", "error": message }),
        Err(ContentError::Type(_)) => json!({ "name": "TypeError", "error": expected["error"] }),
        Err(ContentError::Io(message)) => json!({ "name": "Error", "error": message }),
    }
}

fn apply_patch(base: &Value, patch: &[Value]) -> Value {
    let mut root = base.clone();
    for step in patch {
        let path = array(&step["path"]);
        let Some((last, parents)) = path.split_last() else {
            root = step["value"].clone();
            continue;
        };
        let mut target = &mut root;
        for key in parents {
            target = match key {
                Value::String(key) => target.get_mut(key.as_str()).expect("поле"),
                Value::Number(index) => target.get_mut(index.as_u64().expect("индекс") as usize).expect("элемент"),
                other => panic!("ключ {other}"),
            };
        }
        let delete = step["op"] == "delete";
        match (last, target) {
            (Value::String(key), Value::Object(map)) if delete => {
                map.shift_remove(key.as_str());
            }
            (Value::String(key), Value::Object(map)) => {
                map.insert(key.clone(), step["value"].clone());
            }
            (Value::Number(index), Value::Array(items)) if !delete => items[index.as_u64().expect("индекс") as usize] = step["value"].clone(),
            (key, target) => panic!("правка {key} в {target}"),
        }
    }
    root
}

fn without_directory(content: &Value) -> Value {
    let mut copy = content.clone();
    copy.as_object_mut().expect("справочник").shift_remove("directory");
    copy
}

#[test]
fn embedded_content_matches_js_summary() {
    assert_eq!(content()["summary"], FIXTURE["summary"]);
    assert_eq!(content()["directory"], DEFAULT_CONTENT_DIRECTORY);
}

#[test]
fn tokens_and_dice_match_js() {
    for case in array(&FIXTURE["tokens"]) {
        let text = case["text"].as_str().expect("текст");
        assert_eq!(json!(mechanical_tokens(text)), case["tokens"], "{text:?}");
    }
    for case in array(&FIXTURE["dice"]) {
        let result = dice_average(Some(&case["expression"])).map(Value::from);
        assert_eq!(outcome(result, &case["result"]), case["result"], "{}", case["expression"]);
    }
}

#[test]
fn searches_match_js() {
    let cases = array(&FIXTURE["searches"]);
    assert!(cases.len() > 200);
    for case in cases {
        let options = &case["options"];
        let kind = options.get("kind");
        let limit = options.get("limit");
        let result = search_content(content(), Some(&case["query"]), kind, limit).map(|hits| Value::Array(hits.iter().map(|hit| json!([hit["record"]["id"], hit["score"]])).collect()));
        assert_eq!(outcome(result, &case["result"]), case["result"], "{} {options}", case["query"]);
    }
}

#[test]
fn retrieval_chunks_match_js_byte_for_byte() {
    let summary = |chunks: Vec<Value>| {
        Value::Array(
            chunks
                .into_iter()
                .map(|mut chunk| {
                    let text = chunk.as_object_mut().expect("фрагмент").shift_remove("text").expect("текст");
                    chunk["text_sha256"] = Value::String(sha256_hex(text.as_str().expect("строка")));
                    chunk
                })
                .collect(),
        )
    };
    let chunks = &FIXTURE["chunks"];
    assert_eq!(summary(to_retrieval_chunks(content(), None).expect("все")), chunks["all"]);
    assert_eq!(summary(to_retrieval_chunks(content(), Some(&json!("monster"))).expect("существа")), chunks["monster"]);
    assert_eq!(summary(to_retrieval_chunks(content(), Some(&json!("rule"))).expect("правила")), chunks["rule"]);
    assert_eq!(outcome(to_retrieval_chunks(content(), Some(&json!("spell"))).map(Value::Array), &chunks["invalid"]), chunks["invalid"]);
}

#[test]
fn record_lookups_match_js() {
    for case in array(&FIXTURE["records"]) {
        let campaign = case["hasCampaign"].as_bool().expect("флаг").then_some(&case["campaign"]);
        let result = get_content_record(content(), Some(&case["id"]), campaign).map(|record| record.map_or(Value::Null, |record| record["id"].clone()));
        assert_eq!(outcome(result, &case["result"]), case["result"], "{case}");
    }
}

#[test]
fn validation_of_mutated_content_matches_js() {
    let base = without_directory(content());
    let cases = array(&FIXTURE["validation"]);
    assert!(cases.len() > 600);
    for case in cases {
        let patched = apply_patch(&base, array(&case["patch"]));
        assert_eq!(outcome(validate_dndsu_2014_content(&patched), &case["result"]), case["result"], "{}", case["patch"]);
    }
}

// --- перенос test/dndsu-2014-content.test.mjs ------------------------------

fn record(kind: &str, key: &str) -> &'static Value {
    get_content_record(content(), Some(&json!(format!("dnd_5e_2014:{kind}:{key}"))), None).expect("поиск").unwrap_or_else(|| panic!("{kind}:{key}"))
}

fn action<'a>(monster: &'a Value, key: &str) -> &'a Value {
    array(&monster["actions"]).iter().find(|action| action["id"] == key).expect("действие")
}

#[test]
fn reference_extension_loads_through_the_real_loader_without_replacing_the_base_pack() {
    let root = project_root();
    let base = sk_rulepack::rule_pack::load_rule_pack("dnd_5e_2014", &root.join("data/rule_packs")).expect("базовый пакет");
    let directory = root.join(DEFAULT_CONTENT_DIRECTORY);
    let reference = load_reference_rule_pack(sk_rulepack::rule_pack::load_rule_pack, Some(&directory)).expect("справочный пакет");
    assert_eq!(reference["summary"]["rule_count"], 91);
    assert_ne!(base["summary"]["pack_id"], reference["summary"]["pack_id"]);
    let base_ids: Vec<&Value> = array(&base["rules"]).iter().map(|rule| &rule["id"]).collect();
    assert!(array(&reference["rules"]).iter().all(|rule| !base_ids.contains(&&rule["id"])));
}

#[test]
fn rule_pack_adapter_passes_the_isolated_root_to_the_supplied_loader() {
    let mut called = None;
    let value = load_reference_rule_pack(
        |ruleset_id: &str, root: &Path| {
            called = Some((ruleset_id.to_string(), root.to_path_buf()));
            json!({ "ok": true })
        },
        None,
    );
    assert_eq!(value["ok"], true);
    let (ruleset_id, root) = called.expect("вызов");
    assert_eq!(ruleset_id, "dnd_5e_2014");
    assert_eq!(root, std::path::absolute(DEFAULT_CONTENT_DIRECTORY).expect("путь").join("rule_packs"));
}

#[test]
fn catalog_counts_and_unactivated_state() {
    let content = content();
    assert_eq!(array(&content["monsters"]).len(), 84);
    assert_eq!(array(&content["magicItems"]).len(), 32);
    assert_eq!(array(&content["rules"]).len(), 91);
    assert_eq!(array(&content["sources"]["sources"]).len(), 116);
    for cr in 0..=6 {
        assert_eq!(array(&content["monsters"]).iter().filter(|monster| monster["challenge_rating"] == cr.to_string()).count(), 10);
    }
    assert_eq!(content["manifest"]["runtime_activation_allowed"], false);
    assert_eq!(content["summary"]["mechanics_execution"], "not_integrated");
    let files = content["manifest"]["files"].as_object().expect("файлы");
    assert_eq!(files.len(), 13);
    assert!(files.values().all(|file| file["sha256"].as_str().is_some_and(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))));
}

#[test]
fn recorded_2014_baselines_hold() {
    let goblin = record("monster", "goblin");
    assert_eq!((goblin["hit_points"]["average"].as_i64(), goblin["armor_class"]["value"].as_i64()), (Some(7), Some(15)));
    assert_eq!(goblin["bonus_actions"][0]["mechanics"]["action_cost"], "bonus_action");
    let wolf = record("monster", "dire-wolf");
    assert_eq!((wolf["hit_points"]["average"].as_i64(), wolf["hit_points"]["formula"].as_str()), (Some(37), Some("5d10+10")));
    assert_eq!(action(wolf, "bite")["damage"][0]["expression"], "2d6+3");
    let skeleton = record("monster", "skeleton");
    assert_eq!((skeleton["armor_class"]["value"].as_i64(), skeleton["abilities"]["dex"].as_i64()), (Some(13), Some(14)));
    assert_eq!(skeleton["damage_vulnerabilities"], json!(["bludgeoning"]));
    let javelin = action(record("monster", "bugbear"), "javelin");
    assert_eq!((javelin["damage"][0]["expression"].as_str(), javelin["ranged_damage"].as_str()), (Some("2d6+2"), Some("1d6+2")));
    assert_eq!(action(record("monster", "ghoul"), "bite")["attack_modifier"], 2);
    let captain = record("monster", "bandit-captain");
    assert_eq!(captain["skills"], json!({ "athletics": 4, "deception": 4 }));
    assert_eq!(array(&action(captain, "multiattack")["sequences"]).len(), 2);
    assert_eq!(captain["field_notes"][0]["source_ref"], "srd51:stat-block-corroboration");
    let mage = record("monster", "mage");
    assert_eq!(mage["saving_throws"], json!({ "int": 6, "wis": 4 }));
    let slots: Vec<&Value> = array(&mage["spellcasting"]["spell_slots"]).iter().filter(|slot| slot["level"].as_i64() > Some(0)).map(|slot| &slot["slots"]).collect();
    assert_eq!(json!(slots), json!([4, 3, 3, 3, 1]));
    assert_eq!(mage["spellcasting"]["spell_resolution"], "external_spell_key_requires_2014_catalog");
    let acolyte = &record("monster", "acolyte")["spellcasting"];
    assert_eq!(acolyte["caster_level"], 1);
    assert_eq!(array(&acolyte["spell_slots"]).iter().find(|slot| slot["level"] == 1).expect("1 круг")["slots"], 3);
    let cube = record("monster", "gelatinous-cube");
    assert_eq!(cube["hit_points"]["average"], 84);
    assert!(!array(&cube["damage_immunities"]).contains(&json!("acid")));
    let pull = &array(&cube["traits"]).iter().find(|item| item["id"] == "ooze-cube").expect("куб")["mechanics"]["pull_out"];
    assert_eq!(pull["damage_applies"], "regardless_of_check_result");
    assert_eq!(pull["targets"], json!(["creature", "object"]));
    let regeneration = array(&record("monster", "troll")["traits"]).iter().find(|item| item["id"] == "regeneration").expect("регенерация");
    assert_eq!(regeneration["mechanics"]["heal_hp"], 10);
    assert_eq!(regeneration["mechanics"]["suppressing_damage_types"], json!(["acid", "fire"]));
    assert_eq!(regeneration["mechanics_status"], "requires_handler");
    let dragon = record("monster", "young-red-dragon");
    assert_eq!(dragon["hit_points"]["average"], 178);
    assert!(array(&dragon["legendary_actions"]).is_empty() && array(&dragon["lair_actions"]).is_empty());
    assert_eq!(array(&action(dragon, "bite")["damage"]).len(), 2);
    assert_eq!(action(dragon, "fire-breath")["damage"][0]["expression"], "16d6");
}

#[test]
fn all_monster_hp_and_weapon_averages_are_consistent() {
    for monster in array(&content()["monsters"]) {
        assert_eq!(dice_average(Some(&monster["hit_points"]["formula"])).map(Value::from), Ok(monster["hit_points"]["average"].clone()));
        for action in array(&monster["actions"]) {
            for damage in array(&action["damage"]) {
                let average = if damage["expression"].is_null() { damage["amount"].clone() } else { Value::from(dice_average(Some(&damage["expression"])).expect("кость")) };
                assert_eq!(average, damage["average"]);
            }
        }
        assert!(["short_summary_only", "no_source_history_bundled"].contains(&monster["lore"]["history_status"].as_str().unwrap_or("")));
        assert_eq!(monster["lore"]["full_text_included"], false);
    }
}

#[test]
fn items_keep_2014_profiles() {
    let potion = record("item", "potion-of-healing");
    assert_eq!(potion["effects"][0]["expression"], "2d4+2");
    assert_eq!((potion["activation"][0]["action_cost"].as_str(), potion["attunement"]["required"].as_bool()), (Some("action"), Some(false)));
    let healing: Vec<&Value> = array(&content()["magicItems"]).iter().filter(|item| array(&item["effects"]).iter().any(|effect| effect["kind"] == "heal")).map(|item| &item["effects"][0]["expression"]).collect();
    assert_eq!(json!(healing), json!(["2d4+2", "4d4+4", "8d4+8", "10d4+20"]));
    assert_eq!(record("item", "potion-of-water-breathing")["duration_minutes"], 60);
    for base in ["weapon", "armor", "shield"] {
        for n in 1..=3 {
            let item = record("item", &format!("{base}-plus-{n}"));
            assert_eq!((item["requires_base_item"].as_bool(), item["variant"]["enhancement_bonus"].as_i64(), item["attunement"]["required"].as_bool()), (Some(true), Some(n), Some(false)));
        }
    }
    assert_eq!(record("item", "armor-plus-3")["rarity"], "legendary");
    assert_eq!(record("item", "weapon-plus-3")["rarity"], "very_rare");
    let ring = record("item", "ring-of-resistance");
    assert_eq!((ring["attunement"]["required"].as_bool(), ring["variant"]["kind"].as_str(), array(&ring["variant"]["options"]).len()), (Some(true), Some("damage_type_required"), 10));
    assert_eq!(ring["effects"][0]["damage_type_from"], "variant.damage_type");
    let wand = record("item", "wand-of-web");
    assert_eq!((wand["attunement"]["required"].as_bool(), wand["charges"]["maximum"].as_i64(), wand["charges"]["regain"]["expression"].as_str()), (Some(true), Some(7), Some("1d6+1")));
    assert_eq!((wand["effects"][0]["concentration_required"].as_bool(), wand["effects"][0]["save_dc"].as_i64()), (Some(true), Some(15)));
    assert_eq!(record("item", "wand-of-magic-missiles")["attunement"]["required"], false);
    assert!(array(&content()["magicItems"]).iter().all(|item| item["price_gp"].is_null()));
}

#[test]
fn rules_keep_2014_mechanics() {
    let grapple = &record("compendium", "combat:grapple")["mechanics"];
    assert_eq!(grapple["action_cost"], "one_attack_of_attack_action");
    assert_eq!(grapple["attacker_check"], "str:athletics");
    assert_eq!(grapple["defender_choices"], json!(["str:athletics", "dex:acrobatics"]));
    let bonus = &record("compendium", "spells:bonus-action")["mechanics"];
    assert_eq!(bonus["other_spells_this_turn"], "only_cantrips_with_casting_time_one_action");
    assert_eq!(bonus["not_universal_one_leveled_spell_per_turn"], true);
    let exhaustion = &record("compendium", "condition:exhaustion")["mechanics"]["effects"];
    assert_eq!((array(&exhaustion["levels"]).len(), exhaustion["levels"][5]["effect"].as_str(), exhaustion["cumulative"].as_bool()), (6, Some("death"), Some(true)));
    let rest = &record("compendium", "rest:long")["mechanics"];
    assert_eq!((rest["hit_dice_recovery"].as_str(), rest["benefit_at_most_once_per_hours"].as_i64()), (Some("max(1, floor(total_hit_dice / 2))"), Some(24)));
    let thresholds = &record("compendium", "encounters:thresholds")["mechanics"]["levels"];
    assert_eq!((array(thresholds).len(), thresholds[0]["deadly"].as_i64(), thresholds[19]["deadly"].as_i64()), (20, Some(100), Some(12700)));
    assert_eq!(record("compendium", "encounters:multipliers")["mechanics"]["reward_xp"], "unadjusted_sum_monster_xp");
    assert_eq!(record("compendium", "encounters:party-size")["mechanics"]["multiplier_scale"], json!([0.5, 1, 1.5, 2, 2.5, 3, 4, 5]));
}

#[test]
fn retrieval_includes_complete_mechanics() {
    let chunks = to_retrieval_chunks(content(), None).expect("фрагменты");
    assert_eq!(chunks.len(), 207);
    let grapple = record("compendium", "combat:grapple");
    assert!(grapple["text_ru"].as_str().expect("текст").contains("str:athletics"));
    assert_eq!(mechanical_tokens(grapple["text_ru"].as_str().expect("ru")), mechanical_tokens(grapple["text_en"].as_str().expect("en")));
    assert!(chunks.iter().find(|chunk| chunk["id"] == grapple["id"]).expect("фрагмент")["text"].as_str().expect("текст").contains("free_hands_required"));
}

#[test]
fn local_search_supports_russian_names_and_kind_filtering() {
    let found = search_content(content(), Some(&json!("лютый волк")), Some(&json!("monster")), None).expect("поиск");
    assert_eq!(found[0]["record"]["id"], record("monster", "dire-wolf")["id"]);
    assert!(!search_content(content(), Some(&json!("концентрация")), Some(&json!("rule")), None).expect("правила").is_empty());
    assert!(search_content(content(), Some(&json!(" ")), None, None).expect_err("пустой").is_validation());
    assert!(search_content(content(), Some(&json!("волк")), None, Some(&json!(1000))).expect_err("предел").is_validation());
}

#[test]
fn cross_edition_records_and_campaigns_are_rejected() {
    assert!(get_content_record(content(), Some(&json!("srd_5_2_1:goblin")), None).expect_err("редакция").is_validation());
    let goblin = record("monster", "goblin");
    assert!(get_content_record(content(), Some(&goblin["id"]), Some(&json!({ "ruleset_id": "srd_5_2_1" }))).expect_err("кампания").is_validation());
    assert!(assert_2014_campaign(Some(&json!({ "ruleset_id": "dnd_5e_2014" }))).is_ok());
    assert_eq!(get_content_record(content(), Some(&json!("dnd_5e_2014:monster:missing")), None), Ok(None));
}

#[test]
fn duplicate_ids_false_activation_and_unknown_sources_are_rejected() {
    let base = without_directory(content());
    let first = base["monsters"][0]["id"].clone();
    for (path, value) in [(vec!["monsters", "1", "id"], first), (vec!["monsters", "0", "runtime_activation_allowed"], json!(true)), (vec!["monsters", "0", "source_ref"], json!("unknown"))] {
        let mut copy = base.clone();
        let pointer = format!("/{}", path.join("/"));
        *copy.pointer_mut(&pointer).expect("поле") = value;
        assert!(validate_dndsu_2014_content(&copy).expect_err("отказ").is_validation(), "{pointer}");
    }
    let mut hp = base.clone();
    let average = hp["monsters"][0]["hit_points"]["average"].as_i64().expect("хиты");
    hp["monsters"][0]["hit_points"]["average"] = json!(average + 1);
    assert!(validate_dndsu_2014_content(&hp).expect_err("хиты").message().contains("HP average mismatch"));
    let mut drift = base.clone();
    let text = format!("{} 9999", drift["rules"][0]["text_ru"].as_str().expect("текст"));
    drift["rules"][0]["text_ru"] = json!(text);
    assert!(validate_dndsu_2014_content(&drift).expect_err("числа").message().contains("numeric mismatch"));
    let mut next = base;
    next["sources"]["sources"][0]["url"] = json!("https://next.dnd.su/bestiary/4-goblin/");
    assert!(validate_dndsu_2014_content(&next).expect_err("2024").message().contains("2024"));
}

#[test]
fn dice_parser_does_not_execute_expressions() {
    assert_eq!(dice_average(Some(&json!("2d6-2"))), Ok(5));
    for bad in ["process.exit()", "1d6;rm", "0d6", "2d1", "Math.random()"] {
        assert!(dice_average(Some(&json!(bad))).expect_err(bad).is_validation());
    }
}

/// Временная копия каталога справочника; удаляется при выходе из теста.
struct TempCopy(PathBuf);

impl TempCopy {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!("skazanie-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        copy_dir(&project_root().join(DEFAULT_CONTENT_DIRECTORY), &root);
        Self(root)
    }
}

impl Drop for TempCopy {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).expect("каталог");
    for entry in std::fs::read_dir(from).expect("чтение") {
        let entry = entry.expect("файл");
        let target = to.join(entry.file_name());
        if entry.file_type().expect("тип").is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).expect("копия");
        }
    }
}

#[test]
fn directory_copy_loads_the_same_content_as_the_embedded_build() {
    let copy = TempCopy::new("2014-same");
    let loaded = load_dndsu_2014_content(Some(&copy.0), true).expect("копия");
    assert_eq!(without_directory(&loaded), without_directory(content()));
    assert_eq!(loaded["directory"], copy.0.display().to_string());
}

#[test]
fn changed_data_bytes_fail_checksum_verification() {
    let copy = TempCopy::new("2014-hash");
    let path = copy.0.join("monsters.json");
    let mut bytes = std::fs::read(&path).expect("файл");
    bytes.push(b'\n');
    std::fs::write(&path, bytes).expect("запись");
    let error = load_dndsu_2014_content(Some(&copy.0), true).expect_err("хеш");
    assert_eq!(error, ContentError::Validation("Checksum mismatch: monsters.json".into()));
    assert!(load_dndsu_2014_content(Some(&copy.0), false).is_ok(), "без сверки хешей лишний перевод строки не мешает");
}

#[test]
fn manifest_path_traversal_is_rejected_before_accessing_outside_files() {
    let root = std::env::temp_dir().join(format!("skazanie-path-{}", std::process::id()));
    std::fs::create_dir_all(&root).expect("каталог");
    let guard = TempCopy(root.clone());
    let mut manifest = content()["manifest"].clone();
    let mut files = serde_json::Map::new();
    files.insert("../outside.txt".into(), json!({ "sha256": "0".repeat(64) }));
    files.extend(manifest["files"].as_object().expect("файлы").clone());
    manifest["files"] = Value::Object(files);
    std::fs::write(root.join("manifest.json"), serde_json::to_string(&manifest).expect("json")).expect("манифест");
    let error = load_dndsu_2014_content(Some(&guard.0), true).expect_err("обход");
    assert_eq!(error, ContentError::Validation("Unsafe file path: ../outside.txt".into()));
}

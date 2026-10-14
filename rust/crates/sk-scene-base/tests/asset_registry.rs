//! Сверка `detail_props` и `asset_registry` с JS: эталон
//! `fixtures/asset-registry.json` (`fixtures/gen-asset-registry.mjs`) и
//! перенесённые проверки `test/asset-registry.test.mjs`,
//! `test/detail-props.test.mjs` (серверная часть) и `test/prop-atlas.test.mjs`.

mod common;

use std::collections::HashSet;
use std::sync::LazyLock;

use common::{assert_json, Mismatches};
use serde_json::{json, Value};
use sk_scene_base::asset_registry::*;
use sk_scene_base::detail_props::DETAIL_PROPS;

static FIXTURE: LazyLock<Value> =
    LazyLock::new(|| serde_json::from_str(include_str!("../fixtures/asset-registry.json")).expect("эталон asset-registry"));

fn entries(value: &Value) -> Vec<AssetEntry> {
    serde_json::from_value(value.clone()).expect("записи реестра")
}

fn atlas(value: &Value) -> PropAtlas {
    PropAtlas {
        image: value["image"].as_str().expect("image").into(),
        cell_pixels: value["cellPixels"].as_f64().expect("cellPixels"),
        frames: value["frames"].clone(),
    }
}

fn sha256_hex(text: &str) -> String {
    sk_core::hash::sha256_hex(text)
}

#[test]
fn constants_match_js() {
    let constants = &FIXTURE["constants"];
    assert_eq!(constants["ASSET_KINDS"], json!(ASSET_KINDS));
    assert_eq!(constants["ASSET_ANCHORS"], json!(ASSET_ANCHORS));
    assert_eq!(constants["ASSET_COVER_LEVELS"], json!(ASSET_COVER_LEVELS));
    assert_eq!(constants["OPENINGS_THEME"], json!(OPENINGS_THEME));
}

#[test]
fn detail_props_match_js() {
    let actual: Vec<Value> = DETAIL_PROPS.iter().map(|prop| prop.to_value()).collect();
    let expected = FIXTURE["detailProps"].as_array().expect("detailProps");
    assert_eq!(actual.len(), expected.len());
    for (actual, expected) in actual.iter().zip(expected) {
        assert_json(actual, expected, &expected["id"]);
    }
}

#[test]
fn registry_matches_js() {
    let expected = FIXTURE["assets"].as_array().expect("assets");
    assert_eq!(list_assets().len(), expected.len());
    for (actual, expected) in list_assets().iter().zip(expected) {
        assert_json(&actual.to_value(), expected, &expected["id"]);
    }
    for (theme, ids) in FIXTURE["themes"].as_object().expect("themes") {
        let actual: Vec<&str> = assets_for_theme(theme).iter().map(|record| record.id.as_str()).collect();
        assert_eq!(json!(actual), *ids, "тема {theme}");
    }
    for (id, expected) in FIXTURE["byId"].as_object().expect("byId") {
        assert_eq!(json!(asset_by_id(id).map(|record| record.id.as_str())), *expected, "запись {id}");
    }
}

#[test]
fn embedded_atlases_and_rights_match_js() {
    for (name, actual) in [("propAtlas", read_prop_atlas(None)), ("detailAtlas", read_detail_atlas(None))] {
        let expected = &FIXTURE[name];
        assert_eq!(json!(actual.image), expected["image"], "{name}");
        assert_eq!(sk_core::js::num(actual.cell_pixels), expected["cellPixels"], "{name}");
        let keys: Vec<&String> = actual.frames.as_object().expect("кадры").keys().collect();
        assert_eq!(json!(keys), expected["frames"], "{name}");
    }
    let mut rights: Vec<String> = registered_rights_ids(None).into_iter().collect();
    rights.sort();
    assert_eq!(json!(rights.len()), FIXTURE["rights"]["count"]);
    assert_eq!(json!(sha256_hex(&rights.join("\n"))), FIXTURE["rights"]["sha256"]);
}

#[test]
fn atlas_and_rights_files_match_js() {
    let dir = std::env::temp_dir().join(format!("sk-scene-base-atlas-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("каталог");
    let mut check = Mismatches::new();
    for (index, case) in FIXTURE["atlasCases"].as_array().expect("atlasCases").iter().enumerate() {
        let text = case["text"].as_str().expect("text");
        let file = dir.join(format!("atlas-{index}.json"));
        std::fs::write(&file, text).expect("запись");
        check.check(&parse_prop_atlas(text).to_value(), &case["prop"], || format!("разбор {text}"));
        check.check(&read_prop_atlas(Some(&file)).to_value(), &case["prop"], || format!("файл {text}"));
        check.check(&read_detail_atlas(Some(&file)).to_value(), &case["detail"], || format!("набор {text}"));
    }
    for (index, case) in FIXTURE["rightsCases"].as_array().expect("rightsCases").iter().enumerate() {
        let file = dir.join(format!("rights-{index}.json"));
        std::fs::write(&file, case["text"].as_str().expect("text")).expect("запись");
        let mut ids: Vec<String> = registered_rights_ids(Some(&file)).into_iter().collect();
        ids.sort();
        check.check(&json!(ids), &case["output"], || format!("права {}", case["text"]));
    }
    let missing = dir.join("нет такого файла.json");
    check.check(&read_prop_atlas(Some(&missing)).to_value(), &FIXTURE["missing"]["prop"], || "нет атласа".into());
    check.check(&json!(registered_rights_ids(Some(&missing)).into_iter().collect::<Vec<_>>()), &FIXTURE["missing"]["rights"], || "нет прав".into());
    std::fs::remove_dir_all(&dir).ok();
    check.finish("атласы и права");
}

#[test]
fn atlas_art_and_validation_match_js() {
    let sample: Vec<AssetEntry> = {
        let mut sample: Vec<AssetEntry> = list_assets()[..12].to_vec();
        for id in ["constructor", "0", "1", "map"] {
            let mut extra = sample[0].clone();
            extra.id = id.into();
            sample.push(extra);
        }
        sample
    };
    let mut check = Mismatches::new();
    for case in FIXTURE["withArt"].as_array().expect("withArt") {
        let actual: Vec<Value> = with_atlas_art(&sample, &atlas(&case["atlas"])).iter().map(AssetEntry::to_value).collect();
        check.check(&Value::Array(actual), &case["output"], || format!("атлас {}", case["atlas"]));
    }
    let rights = registered_rights_ids(None);
    for case in FIXTURE["validate"].as_array().expect("validate") {
        let list = if case["entries"] == json!("registry") { list_assets().to_vec() } else { entries(&case["entries"]) };
        check.check(&serde_json::to_value(validate_asset_registry(&list, &rights)).expect("json"), &case["output"], || format!("проверка {}", case["entries"]));
    }
    check.check(&serde_json::to_value(validate_default_asset_registry()).expect("json"), &FIXTURE["defaultReport"], || "весь реестр".into());
    check.finish("растр и проверка");
}

// --- Перенесённые проверки test/asset-registry.test.mjs -----------------------

#[test]
fn registry_passes_its_own_validation() {
    let report = validate_default_asset_registry();
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert!(report.ok);
}

#[test]
fn building_theme_covers_reference_scene() {
    let building: HashSet<&str> = assets_for_theme("interior").into_iter().chain(assets_for_theme("yard")).map(|record| record.id.as_str()).collect();
    assert!((60..=80).contains(&building.len()), "в теме «здание» {} записей", building.len());
    for id in ["table_round", "chair", "barrel", "fireplace", "bar_counter", "bed", "tree_oak", "bush", "path_stone", "cart", "well", "stairs_up"] {
        assert!(asset_by_id(id).is_some(), "в реестре нет обязательной записи {id}");
    }
}

#[test]
fn ids_unique_and_kinds_anchors_from_enums() {
    let ids: Vec<&str> = list_assets().iter().map(|record| record.id.as_str()).collect();
    assert_eq!(ids.iter().collect::<HashSet<_>>().len(), ids.len());
    for record in list_assets() {
        assert!(ASSET_KINDS.contains(&record.kind.as_str()), "{}: вид {}", record.id, record.kind);
        assert!(ASSET_ANCHORS.contains(&record.anchor.as_str()), "{}: якорь {}", record.id, record.anchor);
    }
}

#[test]
fn trees_and_bushes_live_only_outside() {
    let interior: Vec<&str> = assets_for_theme("interior").iter().map(|record| record.id.as_str()).collect();
    for id in ["tree_oak", "tree_pine", "bush", "well", "cart"] {
        assert!(!interior.contains(&id), "{id} не должен попадать в интерьер");
    }
    let yard: Vec<&str> = assets_for_theme("yard").iter().map(|record| record.id.as_str()).collect();
    assert!(yard.contains(&"tree_oak"));
    assert!(!yard.contains(&"bar_counter"), "стойка не стоит во дворе");
}

fn base_entry(id: &str) -> Value {
    json!({
        "id": id, "kind": "prop", "themes": ["tavern"], "baseFootprint": { "w": 1, "h": 1 },
        "anchor": "center", "vector": "chest", "raster": null, "rightsId": null,
        "blocksMove": false, "blocksSight": false, "cover": "none", "destructible": false, "hp": 0,
        "interactive": false, "scaleRange": { "min": 1, "max": 1 },
    })
}

fn with(base: Value, patch: Value) -> Vec<AssetEntry> {
    entries(&json!([sk_core::js::spread(&base, patch)]))
}

#[test]
fn raster_without_rights_is_rejected() {
    let report = validate_asset_registry(&with(base_entry("table_raster"), json!({ "raster": "maps/props/table.webp" })), &HashSet::new());
    assert!(!report.ok);
    assert!(report.errors.iter().any(|issue| issue.code == "ASSET_RASTER_WITHOUT_RIGHTS"));
}

#[test]
fn unregistered_rights_rejected_and_registered_accepted() {
    let rights = registered_rights_ids(None);
    let unknown = validate_asset_registry(&with(base_entry("chest_raster"), json!({ "raster": "maps/props/nope.webp", "rightsId": "maps/props/nope.webp" })), &rights);
    assert!(unknown.errors.iter().any(|issue| issue.code == "ASSET_RIGHTS_NOT_REGISTERED"));
    assert!(rights.contains("maps/props/ruins-chest-v1.webp"), "ожидалась уже зарегистрированная запись прав");
    let known = validate_asset_registry(
        &with(base_entry("chest_raster"), json!({ "raster": "maps/props/ruins-chest-v1.webp", "rightsId": "maps/props/ruins-chest-v1.webp" })),
        &rights,
    );
    assert!(known.errors.is_empty());
}

#[test]
fn entry_without_drawing_rejected_without_raster_accepted() {
    assert!(validate_asset_registry(&with(base_entry("ghost"), json!({ "vector": "" })), &HashSet::new())
        .errors
        .iter()
        .any(|issue| issue.code == "ASSET_HAS_NO_DRAWING"));
    assert!(validate_asset_registry(&with(base_entry("ghost"), json!({ "vector": "ghost" })), &HashSet::new()).errors.is_empty());
}

#[test]
fn blocking_entry_must_occupy_cells() {
    let report = validate_asset_registry(&with(base_entry("floating_wall"), json!({ "baseFootprint": { "w": 0, "h": 0 }, "blocksMove": true })), &HashSet::new());
    assert!(report.errors.iter().any(|issue| issue.code == "ASSET_BLOCKS_WITHOUT_FOOTPRINT"));
}

#[test]
fn small_tableware_takes_no_cells() {
    for id in ["mug", "plate", "bottle", "candle", "rug"] {
        let record = asset_by_id(id).expect(id);
        assert_eq!((record.base_footprint.w, record.base_footprint.h), (0.0, 0.0), "{id} не должен занимать клетку");
        assert!(!record.blocks_move);
    }
}

#[test]
fn large_furniture_takes_cells_and_gives_cover() {
    for (id, cells) in [("table_round", 4.0), ("bar_counter", 4.0), ("bed", 2.0), ("tree_oak", 4.0)] {
        let record = asset_by_id(id).expect(id);
        assert_eq!(record.base_footprint.w * record.base_footprint.h, cells, "{id}: размер по умолчанию");
        assert_ne!(record.cover, "none", "{id} обязан давать укрытие");
    }
}

#[test]
fn raster_comes_from_atlas_with_registered_rights() {
    let atlas = read_prop_atlas(None);
    let rights = registered_rights_ids(None);
    assert!(!atlas.image.is_empty(), "манифест атласа не прочитался");
    assert!(rights.contains(&atlas.image), "атлас {} не зарегистрирован", atlas.image);
    let frames = atlas.frames.as_object().expect("кадры");
    for record in list_assets() {
        if !frames.get(&record.id).is_some_and(|frame| sk_core::js::truthy(Some(frame))) {
            continue;
        }
        assert_eq!(record.raster.as_deref(), Some(format!("{}#{}", atlas.image, record.id).as_str()), "{}: растр не из атласа", record.id);
        assert_eq!(record.rights_id.as_deref(), Some(atlas.image.as_str()), "{}: растр без прав", record.id);
    }
    for id in frames.keys() {
        assert!(asset_by_id(id).is_some(), "в атласе есть кадр {id}, а записи реестра под него нет");
    }
}

#[test]
fn registry_stays_vector_without_atlas() {
    let empty = read_prop_atlas(Some(std::path::Path::new("нет такого файла.json")));
    assert_eq!(empty.to_value(), json!({ "image": "", "cellPixels": 0, "frames": {} }));
    let vector_only = with_atlas_art(list_assets(), &empty);
    assert!(vector_only.iter().all(|record| record.raster.is_none()));
    assert!(validate_asset_registry(&vector_only, &registered_rights_ids(None)).errors.is_empty());
}

#[test]
fn every_m6_theme_has_its_own_set() {
    for theme in ["temple", "crypt", "cave", "forest", "road", "settlement"] {
        let assets = assets_for_theme(theme);
        assert!(assets.len() >= 5, "у темы {theme} всего {} предметов", assets.len());
        assert!(assets.iter().any(|record| record.cover != "none"), "у темы {theme} нет укрытия");
    }
}

#[test]
fn theme_items_do_not_leak() {
    let tavern: HashSet<&str> = assets_for_theme("interior").iter().map(|record| record.id.as_str()).collect();
    for id in ["sarcophagus", "stalagmite", "pillar", "market_stall"] {
        assert!(!tavern.contains(id), "{id} не место в наборе таверны");
    }
    let cave: HashSet<&str> = assets_for_theme("cave").iter().map(|record| record.id.as_str()).collect();
    for id in ["bar_counter", "bed", "sarcophagus"] {
        assert!(!cave.contains(id), "{id} не место в пещере");
    }
}

#[test]
fn shared_vegetation_between_yard_forest_road() {
    for theme in ["yard", "forest", "road"] {
        assert!(assets_for_theme(theme).iter().any(|record| record.id == "path_stone"), "у темы {theme} нет плитняка тропы");
    }
}

// --- test/detail-props.test.mjs: серверная часть ------------------------------

static DETAIL_MANIFEST: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../../public/assets/maps/detail-v1/manifest.json")).expect("манифест detail-v1")
});

const NATIVE_STYLE_IDS: [&str; 21] = [
    "arch_shelf", "cutlery_set", "tool_peg_rack", "chain_coil", "book_piles", "shield_display",
    "alchemy_bottles", "desk_candlestick", "single_book", "vial_display_shelf", "ceremonial_chalice",
    "book_row", "scroll_pile", "rope_coils", "clover_patch", "forest_plant", "wall_ivy", "wall_ivy_corner",
    "wall_ivy_wide", "key_bundle", "coin_pouch",
];

fn strings(value: &Value) -> Vec<String> {
    value.as_array().map(|items| items.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default()
}

#[test]
fn every_detail_prop_is_registered_with_stamp_and_legacy_alias() {
    assert!(validate_default_asset_registry().ok);
    let atlas = read_detail_atlas(None);
    assert_eq!(atlas.image, "maps/detail-v1/prop-atlas.png");
    let frames = atlas.frames.as_object().expect("кадры");
    let declared: HashSet<&str> = DETAIL_PROPS.iter().map(|record| record.id).collect();
    for record in DETAIL_PROPS.iter() {
        let entry = asset_by_id(record.id).unwrap_or_else(|| panic!("{} нет в реестре", record.id));
        if frames.get(record.id).is_some_and(|frame| sk_core::js::truthy(Some(frame))) {
            assert_eq!(entry.raster.as_deref(), Some(format!("{}#{}", atlas.image, record.id).as_str()), "{}: нет штампа", record.id);
        } else {
            assert!(NATIVE_STYLE_IDS.contains(&record.id), "{}: нет ни detail-, ни native-style описания", record.id);
            assert!(!entry.vector.is_empty(), "{}: native-модель без fallback-вектора", record.id);
            assert!(entry.raster.is_none() || entry.rights_id.is_some(), "{}: raster без прав", record.id);
        }
        assert!(!entry.interactive, "{}: интерактивность требует записи в каталоге взаимодействий", record.id);
        let alias = asset_by_id(record.alias);
        assert!(alias.is_some() && !declared.contains(record.alias), "{}: двойник {} — не прежний предмет", record.id, record.alias);
        let alias = alias.expect("двойник");
        if record.kind == "decal" {
            assert!(alias.kind == "decal" || alias.base_footprint.w == 0.0, "{}: объёмный двойник", record.id);
        }
    }
    let pending = &DETAIL_MANIFEST["pendingIntegration"];
    let pending_stamps: HashSet<String> = strings(&pending["stamps"]).into_iter().collect();
    let unregistered: HashSet<String> =
        frames.keys().filter(|id| !declared.contains(id.as_str()) && !id.starts_with("wall_joint_")).cloned().collect();
    assert_eq!(unregistered, pending_stamps);
    let models: Vec<String> = DETAIL_MANIFEST["models"].as_array().expect("models").iter().filter_map(|model| model["id"].as_str()).map(String::from).collect();
    let without_props: HashSet<String> = models.iter().filter(|id| !declared.contains(id.as_str())).cloned().collect();
    let prepared: HashSet<String> = strings(&pending["models"]).into_iter().chain(strings(&DETAIL_MANIFEST["structuralIntegration"]["models"])).collect();
    assert_eq!(without_props, prepared, "модель без предмета должна быть явно подготовлена");
    assert_eq!(declared.len(), 206);
    assert_eq!(strings(&pending["stamps"]).len(), 22);
    assert_eq!(strings(&pending["models"]).len(), 0);
    assert_eq!(strings(&pending["textures"]).len(), 6);
    let style_stamps = strings(&DETAIL_MANIFEST["styleIntegration"]["stamps"]);
    assert_eq!(style_stamps.iter().collect::<HashSet<_>>().len(), 38);
    for id in &style_stamps {
        assert!(declared.contains(id.as_str()), "{id}: стилевой штамп не объявлен в DETAIL_PROPS");
        assert!(!models.contains(id), "{id}: у стилевого штампа не должно быть GLB набора");
    }
    let native: HashSet<&str> = DETAIL_PROPS.iter().map(|record| record.id).filter(|id| NATIVE_STYLE_IDS.contains(id)).collect();
    assert_eq!(native.len(), NATIVE_STYLE_IDS.len());
}

#[test]
fn purpose_props_do_not_leak_into_house_and_yard_themes() {
    let housing = ["building", "tavern", "house", "interior", "yard"];
    let leaked: Vec<&str> = DETAIL_PROPS.iter().filter(|record| record.themes.iter().any(|theme| housing.contains(theme))).map(|record| record.id).collect();
    assert!(leaked.is_empty(), "дыба не должна встать в трактир случайным добором: {leaked:?}");
    assert!(list_assets().iter().any(|record| record.id == "torture_rack" && record.themes.iter().any(|theme| theme == "prison")));
}

// --- test/prop-atlas.test.mjs: плоские предметы атласа ------------------------

#[test]
fn rug_stays_flat() {
    assert_eq!(asset_by_id("rug").expect("ковёр").base_footprint.w, 0.0);
}

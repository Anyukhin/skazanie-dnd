//! `world_template_catalog`: проверки `test/world-template-catalog.test.mjs`,
//! касающиеся самого модуля, и проверка картинок через внедрённую функцию.

use serde_json::{json, Value};
use sk_world_time::world_template_catalog::*;

fn data() -> Value {
    serde_json::from_str(include_str!("../../../../data/campaign-worlds-v1.json")).unwrap_or_default()
}

#[test]
fn catalog_has_four_bounded_previews() {
    let previews = list_world_templates().unwrap_or_default();
    assert_eq!(previews.len(), WORLD_TEMPLATE_COUNT);
    for preview in &previews {
        assert!(preview["version"].as_str().is_some_and(|version| version.split('.').count() >= 3));
        assert!(preview["cities"].as_array().is_some_and(|cities| cities.len() >= 5));
        assert_eq!(preview["cities"].as_array().map(Vec::len), preview["cityCount"].as_u64().map(|count| count as usize));
        assert!(preview["locationCount"].as_u64() >= Some(12));
        assert!(preview["historyTeaser"].as_str().is_some_and(|teaser| teaser.chars().count() > 40));
        assert_eq!(preview["cityOverviewCount"], 1);
        assert!(preview.get("worldMap").is_none() && preview.get("cityOverview").is_none());
    }
}

#[test]
fn unknown_template_is_rejected_with_code() {
    let error = get_world_template(Some(&json!("missing-template"))).err().unwrap_or_else(|| WorldTemplateCatalogError::new(""));
    assert_eq!(error.code, "WORLD_TEMPLATE_INVALID");
    assert_eq!(error.message, "Неизвестный шаблон мира «missing-template»");
    let empty = world_template_concept(None).err().map(|error| error.message);
    assert_eq!(empty.as_deref(), Some("Неизвестный шаблон мира «(пусто)»"));
}

#[test]
fn opening_respects_overrides_and_placeholders() {
    for preview in list_world_templates().unwrap_or_default() {
        let id = preview["id"].clone();
        let template = get_world_template(Some(&id)).unwrap_or_default();
        let opening = world_template_opening(Some(&template), &json!({ "campaignName": "Моя кампания", "partyName": "Мой отряд" })).unwrap_or_default();
        assert_eq!(opening["campaignName"], "Моя кампания");
        assert_eq!(opening["partyName"], "Мой отряд");
        assert_eq!(opening["scene"]["locationId"], template["opening"]["scene"]["locationId"]);
        assert_eq!(opening["worldHistory"], template["opening"]["worldHistory"]);
        let defaults = world_template_opening(Some(&id), &json!({ "campaignName": "Новая кампания" })).unwrap_or_default();
        assert_eq!(defaults["campaignName"], template["name"]);
        let concept = world_template_concept(Some(&id)).unwrap_or_default();
        assert_eq!(concept["world_template_id"], id);
        assert_eq!(concept["timeline"], template["timeline"]);
    }
    let too_long = world_template_opening(Some(&json!("astohan-plains")), &json!({ "partyName": "Я".repeat(161) })).err().map(|error| error.message);
    assert_eq!(too_long.as_deref(), Some("partyName длиннее 160 символов"));
}

#[test]
fn astohan_keeps_authored_start() {
    let template = get_world_template(Some(&json!("astohan-plains"))).unwrap_or_default();
    assert_eq!(template["world"]["startingLocation"], "Штормберг");
    assert_eq!(template["world_map"]["backgroundImage"], "/assets/maps/world/skazanie/dragon-scar-v1.webp");
    assert!(template["opening"]["world_rules"]["offices"].as_array().is_some_and(|offices| !offices.is_empty()));
}

#[test]
fn missing_image_is_reported_through_injected_check() {
    let payload = data();
    assert!(validate_world_template_catalog(&payload, &|_| true).is_ok());
    let error = validate_world_template_catalog(&payload, &|_| false).err().map(|error| error.message).unwrap_or_default();
    assert!(error.starts_with("templates[0].image указывает на отсутствующий файл /assets/maps/world/skazanie/"), "{error}");
}

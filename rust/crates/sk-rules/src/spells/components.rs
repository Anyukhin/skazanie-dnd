//! Компоненты заклинаний: свободная рука, фокус, материалы. Задача Р5.
//!
//! JS: `server/rules-engine.mjs`, 9175–9334 (кроме `assertRevivableHero`,
//! 9218 — Р2, `death.rs`): `spellInventoryFor`, `PHB_MATERIAL_BOOKS`,
//! `spellMaterialPaymentFor`, `spellMaterialItemFor`, `spellComponentCostEvents`,
//! `spellComponentAvailabilityFor`, `assertSpellComponentsAllowed`.

use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexMap;
use sk_core::js;

use crate::command::rules::rule_ids;
use crate::context::Context;
use crate::core::{command_with_rules, condition_ids_for, event_from, resource_pool, spread_value};
use crate::pause::{rule, Halt};
use crate::tables::catalog_item;

fn at<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|value| value.as_object()).and_then(|map| map.get(key))
}

/// `Number(item.quantity ?? 1)`.
fn quantity_of(item: &Value) -> f64 {
    match item.get("quantity").filter(|value| !value.is_null()) {
        Some(value) => js::number(Some(value)),
        None => 1.0,
    }
}

/// `spellInventoryFor(state, actor)`: инвентарь заклинателя; у противника —
/// предметы снаряжения (`loadout.items`) в форме предмета инвентаря.
pub fn spell_inventory_for(state: &Value, actor: Option<&Value>) -> Vec<Value> {
    let id = actor.map(sk_core::game::actor_id).unwrap_or_default();
    if sk_core::game::is_enemy_actor(state, &id) {
        if let Some(Value::Array(items)) = at(at(actor, "loadout"), "items") {
            return items
                .iter()
                .map(|item| {
                    let mut map = spread_value(at(Some(item), "snapshot"));
                    // `{ ...snapshot, id: item.item_instance_id, … }`: поле со
                    // значением `undefined` в JSON не попадает.
                    for (key, value) in [("id", item.get("item_instance_id")), ("catalog_id", item.get("catalog_id")), ("quantity", item.get("quantity"))] {
                        match value {
                            Some(value) => {
                                map.insert(key.into(), value.clone());
                            }
                            None => {
                                map.shift_remove(key);
                            }
                        }
                    }
                    map.insert("equipped".into(), Value::Bool(js::is_true(item.get("equipped"))));
                    Value::Object(map)
                })
                .collect();
        }
    }
    match at(actor, "inventory") {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    }
}

/// `PHB_MATERIAL_BOOKS`: книги стартового каталога покупок (`catalog_id → цена в медяках`).
static PHB_MATERIAL_BOOKS: LazyLock<IndexMap<String, f64>> = LazyLock::new(|| {
    let catalog = sk_chargen::character_creation_wealth::starting_purchase_catalog();
    let mut books = IndexMap::new();
    for entry in catalog.as_array().map(Vec::as_slice).unwrap_or(&[]) {
        if entry.get("type").and_then(Value::as_str) == Some("book") && js::truthy(entry.get("catalog_id")) {
            books.insert(js::string(entry.get("catalog_id")), js::number(entry.get("price_cp")));
        }
    }
    books
});

/// `SUMMED_DIAMOND_SPELLS`: заклинания, которым годятся алмазы в сумме.
const SUMMED_DIAMOND_SPELLS: [&str; 1] = ["revivify"];

/// `Number(spell?.components?.material?.costGp ?? 0) * 100`.
fn minimum_material_value(spell: Option<&Value>) -> f64 {
    match at(at(at(spell, "components"), "material"), "costGp").filter(|value| !value.is_null()) {
        Some(value) => js::number(Some(value)) * 100.0,
        None => 0.0,
    }
}

/// `catalogItem(String(item.catalog_id ?? ''))`.
fn catalog_of(item: &Value) -> Option<&'static Value> {
    catalog_item(&js::s(item.get("catalog_id")))
}

/// `spellMaterialItemFor(state, actor, spell)`.
fn spell_material_item_for(state: &Value, actor: Option<&Value>, spell: Option<&Value>) -> Option<Value> {
    let minimum = minimum_material_value(spell);
    let spell_id = at(spell, "id");
    spell_inventory_for(state, actor).into_iter().find(|item| {
        if quantity_of(item) <= 0.0 {
            return false;
        }
        let material = catalog_of(item).and_then(|entry| entry.get("material_component"));
        if spell_id.and_then(Value::as_str) == Some("borrowed-knowledge") {
            return PHB_MATERIAL_BOOKS.get(&js::s(item.get("catalog_id"))).is_some_and(|price| *price >= minimum);
        }
        let Some(material) = material.filter(|value| js::truthy(Some(value))) else { return false };
        js::number(material.get("value_cp")) >= minimum
            && (crate::validate::common::js_includes(material.get("spell_ids"), spell_id, "spell_ids").unwrap_or(false)
                || (spell_id.and_then(Value::as_str) == Some("chromatic-orb") && material.get("kind").and_then(Value::as_str) == Some("diamond")))
    })
}

/// `spellMaterialPaymentFor(state, actor, spell)`: вещь и сколько штук.
pub fn spell_material_payment_for(state: &Value, actor: Option<&Value>, spell: Option<&Value>) -> Option<(Value, f64)> {
    if let Some(single) = spell_material_item_for(state, actor, spell) {
        return Some((single, 1.0));
    }
    if !SUMMED_DIAMOND_SPELLS.contains(&js::s(at(spell, "id")).as_str()) {
        return None;
    }
    let minimum = minimum_material_value(spell);
    for item in spell_inventory_for(state, actor) {
        let material = catalog_of(&item).and_then(|entry| entry.get("material_component"));
        let each = match at(material, "value_cp").filter(|value| !value.is_null()) {
            Some(value) => js::number(Some(value)),
            None => 0.0,
        };
        if at(material, "kind").and_then(Value::as_str) != Some("diamond") || each <= 0.0 {
            continue;
        }
        let needed = (minimum / each).ceil();
        if (js::safe_int(item.get("quantity"), 1) as f64) >= needed {
            return Some((item, needed));
        }
    }
    None
}

/// `spellComponentCostEvents(state, command, spell, context)`: расход
/// материального компонента (2014).
pub fn spell_component_cost_events(state: &Value, command: &Value, spell: Option<&Value>, context: &Context) -> Result<Vec<Value>, Halt> {
    if !sk_core::game::uses_2014(state) || context.truthy("additionalBeam") || context.truthy("readiedRelease") || !js::truthy(at(at(at(spell, "components"), "material"), "consumed")) {
        return Ok(Vec::new());
    }
    let actor_id = js::s(command.get("actor_id"));
    let actor = sk_core::game::find_actor(state, &actor_id);
    let Some((item, quantity)) = spell_material_payment_for(state, actor, spell) else {
        return Err(rule("Не найден расходуемый материальный компонент", "SPELL_MATERIAL_COMPONENT_REQUIRED"));
    };
    let spell_id = at(spell, "id").cloned();
    if sk_core::game::is_enemy_actor(state, &js::string(command.get("actor_id"))) {
        let mut payload = Map::new();
        if let Some(id) = item.get("id") {
            payload.insert("item_instance_id".into(), id.clone());
        }
        if let Some(catalog) = item.get("catalog_id") {
            payload.insert("catalog_id".into(), catalog.clone());
        }
        if let Some(before) = item.get("quantity") {
            payload.insert("quantity_before".into(), before.clone());
        }
        payload.insert("quantity_after".into(), js::num(js::number(item.get("quantity")) - quantity));
        payload.insert("reason".into(), Value::String("spell-component".into()));
        if let Some(spell_id) = spell_id {
            payload.insert("spell_id".into(), spell_id);
        }
        return Ok(vec![crate::combat::npc_items::npc_equipment_spent_event(command, &Value::Object(payload))]);
    }
    let mut payload = Map::new();
    if let Some(id) = item.get("id") {
        payload.insert("item_id".into(), id.clone());
    }
    if let Some(name) = item.get("name") {
        payload.insert("item_name".into(), name.clone());
    }
    payload.insert("quantity".into(), js::num(quantity));
    payload.insert("reason".into(), Value::String("spell-component".into()));
    if let Some(spell_id) = spell_id {
        payload.insert("spell_id".into(), spell_id);
    }
    let targets = json!([command.get("actor_id").cloned().unwrap_or(Value::Null)]);
    Ok(vec![event_from(&command_with_rules(command, &[rule_ids::RESOURCE]), "ItemConsumed", Some(Value::Object(payload)), Some(&targets))])
}

/// Итог `spellComponentAvailabilityFor`: `{ available }` или отказ с кодом и причиной.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComponentAvailability {
    pub available: bool,
    pub code: Option<String>,
    pub reason: Option<String>,
}

impl ComponentAvailability {
    fn ok() -> Self {
        Self { available: true, code: None, reason: None }
    }

    fn refuse(code: &str, reason: impl Into<String>) -> Self {
        Self { available: false, code: Some(code.into()), reason: Some(reason.into()) }
    }

    pub fn to_value(&self) -> Value {
        if self.available {
            return json!({ "available": true });
        }
        json!({ "available": false, "code": self.code, "reason": self.reason })
    }
}

/// `spellComponentAvailabilityFor(state, actor, spell)`: можно ли произнести
/// заклинание с его компонентами (2014). Один ответ для исполнения и карточки героя.
pub fn spell_component_availability_for(state: &Value, actor: Option<&Value>, spell: Option<&Value>) -> ComponentAvailability {
    if !sk_core::game::uses_2014(state) {
        return ComponentAvailability::ok();
    }
    let Some(components) = at(spell, "components").filter(|value| js::truthy(Some(value))) else {
        return ComponentAvailability::refuse("SPELL_COMPONENTS_UNKNOWN", "Требования к компонентам этого заклинания ещё не проверены.");
    };
    if special_length(components.get("special")) {
        return ComponentAvailability::refuse("SPELL_SPECIAL_COMPONENT_UNSUPPORTED", "Особый компонент этого заклинания ещё не поддержан.");
    }
    let actor_id = actor.map(sk_core::game::actor_id).unwrap_or_default();
    let conditions = condition_ids_for(state, &actor_id);
    let subtle = conditions.contains("metamagic-subtle");
    let verbal = js::truthy(components.get("verbal")) && !subtle;
    let somatic = js::truthy(components.get("somatic")) && !subtle;
    let material = components.get("material").filter(|value| js::truthy(Some(value)));
    let position = crate::tactical_geometry::actor_point(state, &actor_id);
    let silence = sk_core::game::mechanics(state)
        .get("active_effects")
        .and_then(Value::as_array)
        .is_some_and(|effects| effects.iter().any(|effect| effect.get("spell_id").and_then(Value::as_str) == Some("silence") && crate::areas::shape::position_in_effect(state, position, effect, actor)));
    if verbal && (silence || conditions.contains("silenced") || conditions.contains("gagged")) {
        return ComponentAvailability::refuse("SPELL_VERBAL_COMPONENT_BLOCKED", "Для заклинания нужно произнести слова; сейчас это невозможно.");
    }
    let inventory: Vec<(Value, Option<&'static Value>)> = spell_inventory_for(state, actor).into_iter().filter(|item| quantity_of(item) > 0.0).map(|item| {
        let catalog = catalog_of(&item);
        (item, catalog)
    }).collect();
    let held = inventory
        .iter()
        .filter(|(item, catalog)| {
            js::truthy(item.get("equipped"))
                && (matches!(at(at(*catalog, "lifecycle"), "equip_slot").and_then(Value::as_str), Some("main_hand" | "off_hand"))
                    || (catalog.is_none() && (item.get("type").and_then(Value::as_str) == Some("weapon") || at(item.get("armor_profile"), "kind").and_then(Value::as_str) == Some("shield"))))
        })
        .count();
    let house_rules = state.get("enabled_house_rules").and_then(Value::as_array);
    let free_hand = held < 2 || house_rules.is_some_and(|rules| rules.iter().any(|rule| rule.as_str() == Some(sk_ruleset::ruleset_config::BG3_SPELL_HANDS_HOUSE_RULE_ID)));
    let creation = at(actor, "creationBenefits");
    let benefits = crate::core::coalesce(&[at(creation, "static"), creation]);
    let war_caster = js::is_true(at(benefits, "somatic_components_with_hands_full"))
        || crate::validate::common::js_includes(crate::core::coalesce(&[at(actor, "selectedFeatureIds")]), Some(&Value::String("war-caster".into())), "selectedFeatureIds").unwrap_or(false);
    let spell_value = spell.unwrap_or(&Value::Null);
    let class_key = if js::truthy(spell_value.get("innateSpell")) && js::truthy(spell_value.get("fallbackSlotResource")) && resource_pool(state, &actor_id, &js::string(spell_value.get("slotResource")), 0).current == 0 {
        spell_value.get("fallbackSpellcastingClass")
    } else {
        spell_value.get("spellcastingClass")
    };
    let focuses: Vec<&(Value, Option<&'static Value>)> = if material.is_some_and(|material| js::is_true(material.get("focusSubstitutable"))) {
        inventory
            .iter()
            .filter(|(item, catalog)| crate::validate::common::js_includes(at(*catalog, "spellcasting_focus"), class_key, "spellcasting_focus").unwrap_or(false) && (free_hand || js::truthy(item.get("equipped"))))
            .collect()
    } else {
        Vec::new()
    };
    let worn = |catalog: &Option<&'static Value>| at(*catalog, "focus_mode").and_then(Value::as_str) == Some("worn");
    let focus = focuses.iter().find(|(_, catalog)| !worn(catalog)).or_else(|| focuses.first()).copied();
    let mut material_in_hand = focus.is_some_and(|(_, catalog)| !worn(catalog));
    if let Some(material) = material {
        if js::truthy(material.get("unresolved")) {
            let note = material.get("requirementNote").filter(|value| js::truthy(Some(value))).map(|value| js::string(Some(value))).unwrap_or_else(|| "Особое требование к компоненту пока не поддержано.".into());
            return ComponentAvailability::refuse("SPELL_MATERIAL_COMPONENT_UNSUPPORTED", note);
        }
        let spell_id = js::s(spell_value.get("id"));
        if spell_id == "chromatic-orb" {
            let required = js::number(material.get("costGp")) * 100.0;
            let diamond = inventory.iter().any(|(_, catalog)| {
                let component = at(*catalog, "material_component");
                at(component, "kind").and_then(Value::as_str) == Some("diamond") && js::number(at(component, "value_cp")) >= required
            });
            if !diamond {
                return ComponentAvailability::refuse("SPELL_MATERIAL_COMPONENT_REQUIRED", "Нужен алмаз стоимостью не менее 50 зм; он не расходуется.");
            }
            if !free_hand {
                return ComponentAvailability::refuse("SPELL_MATERIAL_HAND_REQUIRED", "Нужна свободная рука, чтобы использовать алмаз.");
            }
        } else if matches!(spell_id.as_str(), "booming-blade" | "green-flame-blade" | "steel-wind-strike") {
            let required = minimum_material_value(spell);
            let weapon = inventory.iter().any(|(item, catalog)| {
                js::truthy(item.get("equipped"))
                    && at(*catalog, "type").and_then(Value::as_str) == Some("weapon")
                    && at(at(*catalog, "combat"), "kind").and_then(Value::as_str) == Some("melee")
                    && js::number(at(*catalog, "base_price_cp")) >= required
            });
            if !weapon {
                return ComponentAvailability::refuse("SPELL_MATERIAL_WEAPON_REQUIRED", "Нужно подходящее оружие ближнего боя как материальный компонент.");
            }
            material_in_hand = true;
        } else if js::is_true(material.get("focusSubstitutable")) {
            let pouch = inventory.iter().any(|(_, catalog)| js::is_true(at(*catalog, "component_pouch")));
            if focus.is_none() && !pouch {
                return ComponentAvailability::refuse("SPELL_MATERIAL_COMPONENT_REQUIRED", "Нужна сумка с компонентами или подходящая заклинанию фокусировка.");
            }
            if !free_hand && focus.is_none() {
                return ComponentAvailability::refuse("SPELL_MATERIAL_HAND_REQUIRED", "Нужна свободная рука для материального компонента.");
            }
        } else {
            if spell_material_payment_for(state, actor, spell).is_none() {
                return ComponentAvailability::refuse("SPELL_MATERIAL_COMPONENT_REQUIRED", format!("Нужен материальный компонент: {}.", js::string(material.get("description"))));
            }
            if !free_hand {
                return ComponentAvailability::refuse("SPELL_MATERIAL_HAND_REQUIRED", "Нужна свободная рука для материального компонента.");
            }
        }
    }
    if somatic && !free_hand && !war_caster && !material_in_hand {
        return ComponentAvailability::refuse(
            "SPELL_SOMATIC_COMPONENT_BLOCKED",
            "Для жестов заклинания нужна свободная рука: уберите оружие в инвентаре — в бою первое взаимодействие с предметом за ход бесплатно.",
        );
    }
    ComponentAvailability::ok()
}

/// `components.special?.length` истинно.
fn special_length(special: Option<&Value>) -> bool {
    match special {
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::String(text)) => !text.is_empty(),
        _ => false,
    }
}

/// `assertSpellComponentsAllowed(state, actor, spell, context)`.
pub fn assert_spell_components_allowed(state: &Value, actor: Option<&Value>, spell: Option<&Value>, context: &Context) -> Result<(), Halt> {
    if context.truthy("additionalBeam") || context.truthy("readiedRelease") {
        return Ok(());
    }
    let availability = spell_component_availability_for(state, actor, spell);
    if !availability.available {
        return Err(rule(availability.reason.unwrap_or_default(), &availability.code.unwrap_or_default()));
    }
    Ok(())
}

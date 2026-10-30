//! Перенос `server/enemy-loadouts.mjs`: инвентарь противника — чем существо
//! вооружено на самом деле, до боя и как конкретные экземпляры вещей.
//!
//! Три правила модуля:
//!
//! 1. Боевые формулы стат-блока не меняются: инвентарь лежит в
//!    `enemy.loadout`, а не в `actor.inventory`, и доспеха в нём нет вовсе —
//!    граница [`assert_enemy_loadout_item`] не пропускает записи без
//!    `enemy_loadout_eligible` (у доспехов его нет).
//! 2. Гарантированное оружие выводится из `action_profiles` стат-блока через
//!    таблицу [`WEAPON_CATALOG_BY_ACTION`].
//! 3. `ruling-only` не материализуется; необязательный расходник — только
//!    `verified`, и вместо падения он просто пропускается
//!    ([`optional_enemy_loadout_item`]).
//!
//! Звери, слизни, растения, конструкты и безмозглая нежить получают пустой
//! инвентарь; гуманоиды — по шаблону. Культист, гоблин и ветеран редакции 2014
//! носят то же, что разбойник, гоблин-воин и ветеран SRD.
//!
//! **Ключи прототипа.** `WEAPON_CATALOG_BY_ACTION['constructor']` в JS находит
//! функцию, и сборка падает отказом `Предмета function Object() { [native
//! code] } нет в каталоге` — это повторено. Шаблон с кодом-ключом прототипа в
//! JS роняет сборку `TypeError` (распаковка `undefined`); здесь такой
//! стат-блок считается неизвестным.

use std::collections::HashSet;

use serde_json::{json, Value};
use sk_core::js;
use sk_items::item_catalog::catalog_item;

use crate::item_instances::{create_item_instance, normalize_item_instance, seeded_integer, ItemInstanceError};
use crate::support::{array, coalesce, get, nfkc_text, plain, safe_int, sha256_hex};

pub const ENEMY_LOADOUT_SCHEMA_VERSION: i64 = 1;
pub const ENEMY_LOADOUT_POLICY_ID: &str = "enemy-loadout-v1";
pub const MAX_ENEMY_LOADOUT_ITEMS: usize = 12;
pub const MAX_ENEMY_PURSE_CP: i64 = 100_000;

/// `action_profiles[].id` стат-блока → запись каталога. Оружие в двух режимах
/// ведёт к одной записи: это одно копьё, а не два.
pub const WEAPON_CATALOG_BY_ACTION: [(&str, &str); 20] = [
    ("dagger", "srd_5_2_1:dagger"),
    ("greataxe", "srd_5_2_1:greataxe"),
    ("greatsword", "srd_5_2_1:greatsword"),
    ("hand-crossbow", "srd_5_2_1:hand-crossbow"),
    ("javelin", "srd_5_2_1:javelin"),
    ("javelin-melee", "srd_5_2_1:javelin"),
    ("javelin-ranged", "srd_5_2_1:javelin"),
    ("heavy-crossbow", "srd_5_2_1:heavy-crossbow"),
    ("light-crossbow", "srd_5_2_1:light-crossbow"),
    ("longbow", "srd_5_2_1:longbow"),
    ("longsword", "srd_5_2_1:longsword"),
    ("morningstar", "srd_5_2_1:morningstar"),
    ("pistol", "srd_5_2_1:pistol"),
    ("scimitar", "srd_5_2_1:scimitar"),
    ("shortbow", "srd_5_2_1:shortbow"),
    ("shortsword", "srd_5_2_1:shortsword"),
    ("sling", "srd_5_2_1:sling"),
    ("spear-melee", "srd_5_2_1:spear"),
    ("spear-ranged", "srd_5_2_1:spear"),
    ("warhammer", "srd_5_2_1:warhammer"),
];

/// Чем стреляет оружие со свойством `ammunition`.
pub const AMMUNITION_BY_WEAPON: [(&str, &str); 9] = [
    ("srd_5_2_1:blowgun", "srd_5_2_1:needles-50"),
    ("srd_5_2_1:hand-crossbow", "srd_5_2_1:bolts-20"),
    ("srd_5_2_1:heavy-crossbow", "srd_5_2_1:bolts-20"),
    ("srd_5_2_1:light-crossbow", "srd_5_2_1:bolts-20"),
    ("srd_5_2_1:longbow", "srd_5_2_1:arrows-20"),
    ("srd_5_2_1:musket", "srd_5_2_1:firearm-bullets-10"),
    ("srd_5_2_1:pistol", "srd_5_2_1:firearm-bullets-10"),
    ("srd_5_2_1:shortbow", "srd_5_2_1:arrows-20"),
    ("srd_5_2_1:sling", "srd_5_2_1:sling-bullets-20"),
];

fn pairs_json(pairs: &[(&str, &str)]) -> Value {
    Value::Object(pairs.iter().map(|(key, value)| ((*key).to_string(), json!(value))).collect())
}

/// `WEAPON_CATALOG_BY_ACTION` как объект JSON.
pub fn weapon_catalog_by_action_json() -> Value {
    pairs_json(&WEAPON_CATALOG_BY_ACTION)
}

/// `AMMUNITION_BY_WEAPON` как объект JSON.
pub fn ammunition_by_weapon_json() -> Value {
    pairs_json(&AMMUNITION_BY_WEAPON)
}

/// `WEAPON_CATALOG_BY_ACTION[actionId]`.
pub fn weapon_catalog_for_action(action_id: &str) -> Option<&'static str> {
    WEAPON_CATALOG_BY_ACTION.iter().find(|(action, _)| *action == action_id).map(|(_, catalog_id)| *catalog_id)
}

/// `AMMUNITION_BY_WEAPON[weaponCatalogId]`.
pub fn ammunition_for_weapon(weapon_catalog_id: &str) -> Option<&'static str> {
    AMMUNITION_BY_WEAPON.iter().find(|(weapon, _)| *weapon == weapon_catalog_id).map(|(_, ammunition)| *ammunition)
}

/// Шаблон существа: диапазон комплектов боеприпасов, карман в медяках,
/// необязательные находки с шансом в процентах.
struct Template {
    id: &'static str,
    ammunition: (i64, i64),
    purse_cp: (i64, i64),
    consumables: &'static [(&'static str, i64)],
}

const TEMPLATES: [Template; 16] = [
    Template { id: "srd_5_2_1:goblin-minion", ammunition: (1, 1), purse_cp: (0, 8), consumables: &[] },
    Template { id: "srd_5_2_1:goblin-warrior", ammunition: (1, 2), purse_cp: (0, 15), consumables: &[("srd_5_2_1:oil-flask", 20)] },
    Template { id: "srd_5_2_1:kobold", ammunition: (1, 1), purse_cp: (0, 6), consumables: &[] },
    Template { id: "srd_5_2_1:bandit", ammunition: (1, 2), purse_cp: (2, 25), consumables: &[] },
    Template { id: "srd_5_2_1:orc", ammunition: (1, 1), purse_cp: (2, 20), consumables: &[] },
    Template { id: "srd_5_2_1:hobgoblin", ammunition: (1, 2), purse_cp: (5, 30), consumables: &[("srd_5_2_1:potion-of-healing", 15)] },
    Template { id: "srd_5_2_1:bugbear", ammunition: (1, 1), purse_cp: (5, 40), consumables: &[("srd_5_2_1:oil-flask", 15)] },
    Template { id: "srd_5_2_1:scout", ammunition: (1, 2), purse_cp: (5, 30), consumables: &[("srd_5_2_1:healers-kit", 25)] },
    Template { id: "srd_5_2_1:spy", ammunition: (1, 2), purse_cp: (20, 80), consumables: &[("srd_5_2_1:poison-basic", 35), ("srd_5_2_1:acid", 25)] },
    Template { id: "srd_5_2_1:berserker", ammunition: (1, 1), purse_cp: (5, 40), consumables: &[("srd_5_2_1:potion-of-healing", 20)] },
    Template { id: "srd_5_2_1:bandit-captain", ammunition: (1, 2), purse_cp: (50, 250), consumables: &[("srd_5_2_1:potion-of-healing", 40), ("srd_5_2_1:alchemists-fire", 25)] },
    Template { id: "srd_5_2_1:warrior-veteran", ammunition: (1, 2), purse_cp: (30, 150), consumables: &[("srd_5_2_1:potion-of-healing", 30)] },
    Template { id: "srd_5_2_1:guard-captain", ammunition: (1, 1), purse_cp: (40, 200), consumables: &[("srd_5_2_1:potion-of-healing", 35), ("srd_5_2_1:healers-kit", 30)] },
    Template { id: "srd_5_2_1:knight", ammunition: (1, 2), purse_cp: (60, 300), consumables: &[("srd_5_2_1:potion-of-healing", 35)] },
    Template { id: "srd_5_2_1:gladiator", ammunition: (1, 1), purse_cp: (40, 200), consumables: &[("srd_5_2_1:potion-of-healing", 30)] },
    Template {
        id: "srd_5_2_1:tough-boss",
        ammunition: (1, 2),
        purse_cp: (40, 200),
        consumables: &[("srd_5_2_1:potion-of-healing", 30), ("srd_5_2_1:oil-flask", 25), ("srd_5_2_1:alchemists-fire", 20)],
    },
];

/// Шаблон заклинателя редакции 2014 без своего шаблона: только мешочек компонентов.
const SPELLCASTER_TEMPLATE: Template = Template { id: "", ammunition: (1, 1), purse_cp: (0, 0), consumables: &[] };

/// `ENEMY_LOADOUT_TEMPLATE_IDS`.
pub const ENEMY_LOADOUT_TEMPLATE_IDS: [&str; 16] = [
    "srd_5_2_1:goblin-minion",
    "srd_5_2_1:goblin-warrior",
    "srd_5_2_1:kobold",
    "srd_5_2_1:bandit",
    "srd_5_2_1:orc",
    "srd_5_2_1:hobgoblin",
    "srd_5_2_1:bugbear",
    "srd_5_2_1:scout",
    "srd_5_2_1:spy",
    "srd_5_2_1:berserker",
    "srd_5_2_1:bandit-captain",
    "srd_5_2_1:warrior-veteran",
    "srd_5_2_1:guard-captain",
    "srd_5_2_1:knight",
    "srd_5_2_1:gladiator",
    "srd_5_2_1:tough-boss",
];

const CLASSIC_ALIASES: [(&str, &str); 3] = [("goblin", "goblin-warrior"), ("veteran", "warrior-veteran"), ("cultist", "bandit")];

fn template(id: &str) -> Option<&'static Template> {
    TEMPLATES.iter().find(|template| template.id == id)
}

/// Отказ границы инвентаря (`EnemyLoadoutError`): код и текст — как в JS.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct EnemyLoadoutError {
    pub code: String,
    pub message: String,
}

/// Отказ сборки инвентаря: граница шаблона или создание экземпляра.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EnemyLoadoutFailure {
    #[error(transparent)]
    Loadout(#[from] EnemyLoadoutError),
    #[error(transparent)]
    Instance(#[from] ItemInstanceError),
}

fn loadout_error(code: &str, message: String) -> EnemyLoadoutError {
    EnemyLoadoutError { code: code.into(), message }
}

/// `assertEnemyLoadoutItem(catalogId, { verifiedOnly, allowSpellcastingComponent })`:
/// граница шаблона, проверяется на каждом предмете при сборке.
pub fn assert_enemy_loadout_item(catalog_id: &str, verified_only: bool, allow_spellcasting_component: bool) -> Result<&'static Value, EnemyLoadoutError> {
    let Some(entry) = catalog_item(catalog_id) else {
        return Err(loadout_error("ENEMY_LOADOUT_CATALOG_UNKNOWN", format!("Предмета {catalog_id} нет в каталоге")));
    };
    let spellcasting_component = allow_spellcasting_component && js::is_true(entry.get("component_pouch"));
    if !js::truthy(entry.get("enemy_loadout_eligible")) && !spellcasting_component {
        return Err(loadout_error("ENEMY_LOADOUT_ITEM_NOT_ELIGIBLE", format!("Предмет {catalog_id} не разрешён в инвентарях противников")));
    }
    if verified_only && entry.get("mechanics_status").and_then(Value::as_str) != Some("verified") {
        return Err(loadout_error("ENEMY_LOADOUT_CONSUMABLE_NOT_VERIFIED", format!("Расходник {catalog_id} не имеет статуса verified")));
    }
    Ok(entry)
}

/// `optionalEnemyLoadoutItem(catalogId)`: необязательный расходник — запись
/// каталога или `None`, если сегодня выдать его нельзя.
pub fn optional_enemy_loadout_item(catalog_id: &str) -> Option<&'static Value> {
    assert_enemy_loadout_item(catalog_id, true, false).ok()
}

fn includes_material(value: Option<&Value>) -> bool {
    array(value).iter().any(|entry| entry.as_str() == Some("material"))
}

fn spellcaster_needs_component_pouch(block: Option<&Value>) -> bool {
    let Some(spellcasting) = plain(get(block, "spellcasting")) else {
        return false;
    };
    if js::is_false(spellcasting.get("component_pouch")) || js::is_false(spellcasting.get("requires_component_pouch")) {
        return false;
    }
    if spellcasting.get("components_not_required").is_some_and(Value::is_array) && includes_material(spellcasting.get("components_not_required")) {
        return false;
    }
    let spells = array(spellcasting.get("spells"));
    if !spells.is_empty() && spells.iter().all(|spell| get(Some(spell), "components_not_required").is_some_and(Value::is_array) && includes_material(get(Some(spell), "components_not_required"))) {
        return false;
    }
    true
}

/// `WEAPON_CATALOG_BY_ACTION[id]` по собственному ключу.
fn weapon_lookup(action_id: &str) -> Option<String> {
    weapon_catalog_for_action(action_id).map(str::to_string)
}

fn thrown_bundle(catalog_id: &str, primary: Option<&str>) -> bool {
    if Some(catalog_id) == primary {
        return false;
    }
    match catalog_item(catalog_id).and_then(|entry| entry.get("weapon")).and_then(|weapon| weapon.get("properties")) {
        Some(Value::Array(properties)) => properties.iter().any(|property| property.as_str() == Some("thrown")),
        Some(Value::String(properties)) => properties.contains("thrown"),
        _ => false,
    }
}

fn empty_loadout() -> Value {
    json!({ "schema_version": ENEMY_LOADOUT_SCHEMA_VERSION, "policy_id": ENEMY_LOADOUT_POLICY_ID, "template_id": null, "items": [], "purse_cp": 0 })
}

/// `enemyLoadoutFor({ statBlockId, block, ownerId, seed, sourceId })`:
/// инвентарь одного противника, выведенный из стат-блока и сида.
pub fn enemy_loadout_for(input: Option<&Value>) -> Result<Value, EnemyLoadoutFailure> {
    let field = |key: &str| get(input, key);
    let template_id = nfkc_text(field("statBlockId"), 120);
    let classic_slug = template_id.strip_prefix("dnd_5e_2014:monster:").map(|_| template_id.rsplit(':').next().unwrap_or("").to_string());
    let classic_slug = classic_slug.filter(|slug| !slug.is_empty());
    let resolved = template(&template_id).or_else(|| {
        let slug = classic_slug.as_deref()?;
        let alias = CLASSIC_ALIASES.iter().find(|(name, _)| *name == slug).map_or(slug, |(_, alias)| *alias);
        template(&format!("srd_5_2_1:{alias}"))
    });
    let owner = nfkc_text(field("ownerId"), 120);
    let block = field("block");
    let fallback = (classic_slug.is_some() && spellcaster_needs_component_pouch(block)).then_some(&SPELLCASTER_TEMPLATE);
    let Some(resolved) = resolved.or(fallback) else {
        return Ok(empty_loadout());
    };
    if owner.is_empty() {
        return Ok(empty_loadout());
    }
    let loadout_seed = sha256_hex(&format!("{ENEMY_LOADOUT_POLICY_ID} {} {owner}", js::s(field("seed"))));
    let profiles = array(get(block, "action_profiles"));
    let primary = profiles.first().and_then(|profile| weapon_lookup(&js::s(get(Some(profile), "id"))));
    let mut ordered: Vec<String> = Vec::new();
    for profile in profiles {
        if let Some(catalog_id) = weapon_lookup(&js::s(get(Some(profile), "id"))) {
            if !ordered.contains(&catalog_id) {
                ordered.push(catalog_id);
            }
        }
    }
    let source_id = nfkc_text(field("sourceId"), 160);
    let reserve_component_slot = spellcaster_needs_component_pouch(block);
    let mut items: Vec<Value> = Vec::new();
    let push = |items: &mut Vec<Value>, catalog_id: &str, quantity: i64, equipped: bool, optional: bool, spellcasting_component: bool| -> Result<bool, EnemyLoadoutFailure> {
        let item_limit = if reserve_component_slot && !spellcasting_component { MAX_ENEMY_LOADOUT_ITEMS - 1 } else { MAX_ENEMY_LOADOUT_ITEMS };
        if items.len() >= item_limit {
            return Ok(false);
        }
        if optional {
            if optional_enemy_loadout_item(catalog_id).is_none() {
                return Ok(false);
            }
        } else {
            assert_enemy_loadout_item(catalog_id, false, spellcasting_component)?;
        }
        let instance = create_item_instance(Some(&json!({
            "catalogId": catalog_id,
            "instanceId": sk_core::text::head(&format!("{owner}-item-{}", items.len() + 1), 160),
            "quantity": quantity,
            "equipped": equipped,
            "owner": { "kind": "enemy", "actor_id": owner },
            "origin": { "kind": "enemy_loadout", "template_id": template_id, "source_id": source_id },
        })))?;
        items.push(instance);
        Ok(true)
    };

    for catalog_id in &ordered {
        let quantity = if thrown_bundle(catalog_id, primary.as_deref()) { seeded_integer(&loadout_seed, &format!("thrown:{catalog_id}"), 2, 4) } else { 1 };
        push(&mut items, catalog_id, quantity, Some(catalog_id.as_str()) == primary.as_deref(), false, false)?;
    }

    let (ammunition_minimum, ammunition_maximum) = resolved.ammunition;
    let mut ammunition_seen: HashSet<&str> = HashSet::new();
    for catalog_id in &ordered {
        let Some(ammunition_id) = ammunition_for_weapon(catalog_id) else {
            continue;
        };
        if !ammunition_seen.insert(ammunition_id) {
            continue;
        }
        let quantity = seeded_integer(&loadout_seed, &format!("ammunition:{ammunition_id}"), ammunition_minimum, ammunition_maximum);
        push(&mut items, ammunition_id, quantity, false, false, false)?;
    }

    if reserve_component_slot {
        push(&mut items, "srd_5_2_1:component-pouch", 1, false, false, true)?;
    }

    // Бросок делается до проверки границы и от её исхода не зависит.
    for (catalog_id, chance) in resolved.consumables {
        let roll = seeded_integer(&loadout_seed, &format!("consumable:{catalog_id}"), 0, 99);
        if roll < *chance {
            push(&mut items, catalog_id, 1, false, true, false)?;
        }
    }

    let (purse_minimum, purse_maximum) = resolved.purse_cp;
    Ok(json!({
        "schema_version": ENEMY_LOADOUT_SCHEMA_VERSION,
        "policy_id": ENEMY_LOADOUT_POLICY_ID,
        "template_id": template_id,
        "items": items,
        "purse_cp": MAX_ENEMY_PURSE_CP.min(seeded_integer(&loadout_seed, "purse", purse_minimum, purse_maximum)),
    }))
}

/// `normalizeEnemyLoadout(input)`: инвентарь из сохранения; у старых кампаний
/// он пустой, а не отсутствующий.
pub fn normalize_enemy_loadout(input: Option<&Value>) -> Value {
    let source = plain(input);
    let field = |key: &str| source.and_then(|map| map.get(key));
    let template_id = nfkc_text(coalesce(field("template_id"), field("templateId")), 120);
    let items: Vec<Value> = array(field("items")).iter().take(MAX_ENEMY_LOADOUT_ITEMS).filter_map(|item| normalize_item_instance(Some(item))).collect();
    json!({
        "schema_version": ENEMY_LOADOUT_SCHEMA_VERSION,
        "policy_id": ENEMY_LOADOUT_POLICY_ID,
        "template_id": if template_id.is_empty() { Value::Null } else { json!(template_id) },
        "items": items,
        "purse_cp": MAX_ENEMY_PURSE_CP.min(safe_int(coalesce(field("purse_cp"), field("purseCp")), 0)).max(0),
    })
}

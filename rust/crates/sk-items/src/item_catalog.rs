//! Перенос `server/item-catalog.mjs`: каталог предметов SRD 5.2.1 и
//! материалов заклинаний — оружие, доспехи, боеприпасы, инструменты, полевое
//! снаряжение, фокусы, магические вещи — и отдельный каталог предметов
//! авторских сценариев. Здесь же словарь происхождения вещи, каналы выдачи
//! (лавка, добыча, магическая находка, изготовление), профиль использования и
//! перезарядки, материализация экземпляра из каталога и подсказки проекции
//! для клиента.
//!
//! Каталог собирается один раз при первом обращении теми же сборщиками, что и
//! в JS (`weaponEntry`, `armorEntry`, …); таблицы-литералы — в
//! [`tables`]. Порядок записей и ключей совпадает с JS: от него зависят
//! списки каналов, выдача добычи и хеши проекций.
//!
//! **Ключи прототипа.** Каталог читается только по собственному ключу
//! (`Object.hasOwn` в JS): `constructor`, `toString` и прочие свойства
//! `Object.prototype` — некаталожный код, как любой неизвестный.

use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::{js, text};
use sk_ruleset::ruleset_config::DND_2014_RULESET_ID;

use crate::support::{coalesce, field, is_safe_integer, js_max, js_min, json_num, or_value, or_zero};

mod tables;

pub const ITEM_CATALOG_SCHEMA_VERSION: &str = "skazanie:item-catalog:v1";

/// `ITEM_CATALOG_SOURCE`: источник и атрибуция SRD 5.2.1.
pub static ITEM_CATALOG_SOURCE: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "source_url": "https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf",
        "source_version": "SRD 5.2.1",
        "source_sha256": "8974902d109d6e63672d7c490bde9ccf052410503d9cfa768237154fbc5e3d87",
        "license": "CC-BY-4.0",
        "attribution": "This work includes material from the System Reference Document 5.2.1 (“SRD 5.2.1”) by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.",
    })
});

// Компоненты этой волны сверены по профилю D&D 5e 2014. Не приписываем их
// механические факты SRD 5.2.1: собственные русские формулировки остаются
// парафразом, а ссылки ведут на dnd.su и официальный Basic Rules 2014.
static SPELLCASTING_COMPONENT_SOURCE: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "source_url": "https://5e14.dnd.su/articles/inventory/98-equipment/",
        "source_version": "D&D 5e 2014 Basic Rules",
        "secondary_source_url": "https://www.dndbeyond.com/sources/dnd/basic-rules-2014/equipment",
        "license": "ORIGINAL-PARAPHRASE",
        "attribution": "Краткие формулировки предметов и их ценностей — самостоятельный парафраз правил D&D 5e 2014; источники: 5e14.dnd.su и Basic Rules 2014.",
    })
});

pub const ITEM_MECHANICS_STATUSES: [&str; 3] = ["verified", "partial", "ruling-only"];

/// Откуда вещь взялась. Словарь один на оба мира: на экземпляры противников и
/// контейнеров (`origin.kind`, `item-instances`) и на инвентарь героя
/// (`item.origin`, `merchant-economy`). Живёт он здесь, в каталоге, потому что
/// каталог не импортирует ничего, а те два модуля импортируют его: объявить
/// список в любом из них значило бы либо цикл, либо второй словарь — а
/// происхождение переезжает вместе с вещью.
///
/// `unknown` — не «движок не знает», а честная запись про вещь из сохранения,
/// сделанного до этой волны: происхождения у героев тогда не было вовсе, и
/// выдумывать его задним числом значило бы соврать в летописи.
pub const ITEM_ORIGIN_KINDS: [&str; 8] = ["enemy_loadout", "purchased", "found", "looted", "stolen", "gifted", "reward", "unknown"];

pub const DEFAULT_ITEM_ORIGIN_KIND: &str = "unknown";

/// Происхождение, которое принадлежит только своему герою и ведущему.
///
/// Краденое — единственный вид, который сам по себе улика: он называет, что
/// герой взял чужое. Соседу по столу это знание не принадлежит. Список закрыт
/// и читается обеими поверхностями сразу: проекцией и карточкой вещи.
pub const PRIVATE_ITEM_ORIGIN_KINDS: [&str; 1] = ["stolen"];

/// Как происхождение называется за столом (`ITEM_ORIGIN_LABELS`), в порядке ключей JS.
pub const ITEM_ORIGIN_LABELS: [(&str, &str); 8] = [
    ("enemy_loadout", "снаряжение врага"),
    ("purchased", "куплено"),
    ("found", "найдено"),
    ("looted", "снято с трупа"),
    ("stolen", "украдено"),
    ("gifted", "подарено"),
    ("reward", "награда"),
    ("unknown", "неизвестно"),
];

/// `ITEM_ORIGIN_LABELS[kind]` для известного вида.
pub fn item_origin_label(kind: &str) -> Option<&'static str> {
    ITEM_ORIGIN_LABELS.iter().find(|(key, _)| *key == kind).map(|(_, label)| *label)
}

/// `ITEM_ORIGIN_LABELS` как объект JSON.
pub fn item_origin_labels_json() -> Value {
    Value::Object(ITEM_ORIGIN_LABELS.iter().map(|(kind, label)| ((*kind).to_string(), Value::String((*label).to_string()))).collect())
}

/// `normalizeItemOriginKind(value, fallback)`: приведение недоверенного
/// происхождения к словарю (`String(value ?? '').trim()`); по умолчанию
/// запасом служит [`DEFAULT_ITEM_ORIGIN_KIND`].
pub fn normalize_item_origin_kind(value: Option<&Value>, fallback: &str) -> String {
    let kind = js::s(value);
    let kind = text::trim(&kind);
    if ITEM_ORIGIN_KINDS.contains(&kind) {
        kind.to_string()
    } else {
        fallback.to_string()
    }
}

pub const ITEM_AVAILABILITY_CHANNELS: [&str; 4] = ["shop", "loot", "magic_loot", "crafting"];
pub const ITEM_RECHARGE_SCHEMA_VERSION: i64 = 1;

/// Чем стреляет оружие со свойством `ammunition` (`AMMUNITION_CATALOG_BY_WEAPON`).
///
/// Второй такой таблицей владеет `enemy-loadouts` (`AMMUNITION_BY_WEAPON`) —
/// она выдаёт колчан противнику **до** боя. Список повторён нарочно: каталог не
/// импортирует ничего, а `enemy-loadouts` импортирует каталог. Расхождение
/// ловит сторож: таблицы обязаны совпадать поимённо.
pub const AMMUNITION_CATALOG_BY_WEAPON: [(&str, &str); 9] = [
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

/// `AMMUNITION_CATALOG_BY_WEAPON` как объект JSON.
pub fn ammunition_catalog_by_weapon_json() -> Value {
    Value::Object(AMMUNITION_CATALOG_BY_WEAPON.iter().map(|(weapon, ammo)| ((*weapon).to_string(), Value::String((*ammo).to_string()))).collect())
}

/// Каталожный боеприпас этого оружия (`ammunitionCatalogIdForWeapon`);
/// `None` — оружие не требует снарядов. Аргумент — уже приведённое
/// `String(weaponCatalogId ?? '')`.
pub fn ammunition_catalog_id_for_weapon(weapon_catalog_id: &str) -> Option<&'static str> {
    AMMUNITION_CATALOG_BY_WEAPON.iter().find(|(weapon, _)| *weapon == weapon_catalog_id).map(|(_, ammo)| *ammo)
}

/// Сколько выстрелов в одном комплекте (`ammunitionBundleAmount`). В каталоге
/// снаряды лежат пачками (`ammunition.amount`), и в инвентаре считаются
/// пачками же: у героя с двумя колчанами сорок выстрелов, а не два.
pub fn ammunition_bundle_amount(catalog_id: &str) -> i64 {
    let amount = js::number(catalog_item(catalog_id).and_then(|entry| entry.get("ammunition")).and_then(|ammo| ammo.get("amount")));
    if is_safe_integer(amount) && amount > 0.0 {
        amount as i64
    } else {
        1
    }
}

fn ammunition_capacity_f64(item: Option<&Value>) -> f64 {
    let quantity = js::number(field(item, "quantity"));
    let quantity = js_max(0.0, if is_safe_integer(quantity) { quantity } else { 1.0 });
    let catalog_id = js::s(coalesce(field(item, "catalog_id"), field(item, "catalogId")));
    quantity * ammunition_bundle_amount(&catalog_id) as f64
}

/// Ёмкость пачек (`ammunitionCapacity`): сколько выстрелов было бы в этом
/// стеке, будь он нестрелянным. Она же уезжает в событие расхода как
/// `charges.max`.
pub fn ammunition_capacity(item: Option<&Value>) -> i64 {
    ammunition_capacity_f64(item) as i64
}

/// Остаток выстрелов в экземпляре боеприпасов (`ammunitionShotsLeft`).
///
/// Считается по `charges`. Пока не стреляли ни разу, поля нет, и остаток
/// выводится из числа пачек по живому каталогу. К остатку прибавляется
/// прирост ёмкости: `charges.max` помнит, на сколько пачек этот остаток был
/// посчитан, а всё, что появилось в стеке сверх того (докупленная пачка), ещё
/// не стреляно.
pub fn ammunition_shots_left(item: Option<&Value>) -> i64 {
    if !js::truthy(item) {
        return 0;
    }
    let capacity = ammunition_capacity_f64(item);
    if capacity <= 0.0 {
        return 0;
    }
    // `item.charges && typeof item.charges === 'object'`
    let charges_slot = field(item, "charges").filter(|charges| matches!(charges, Value::Object(_) | Value::Array(_)));
    let charges = charges_slot.map_or(f64::NAN, |charges| js::number(charges.get("current")));
    if !is_safe_integer(charges) {
        return capacity as i64;
    }
    let maximum = js::number(charges_slot.and_then(|charges| charges.get("max")));
    let counted_capacity = js_max(0.0, if is_safe_integer(maximum) { maximum } else { capacity });
    (js_max(0.0, charges) + js_max(0.0, capacity - counted_capacity)) as i64
}

const SHOP_IDS: &[&str] = &[
    "srd_5_2_1:dagger",
    "srd_5_2_1:longsword",
    "srd_5_2_1:longbow",
    "srd_5_2_1:shortbow",
    "srd_5_2_1:leather-armor",
    "srd_5_2_1:shield",
    "srd_5_2_1:explorers-pack",
    "srd_5_2_1:potion-of-healing",
    "srd_5_2_1:rations-one-day",
    "srd_5_2_1:rope-hempen-50-feet",
    "srd_5_2_1:torch",
    "srd_5_2_1:arrows-20",
    // Компоненты заклинаний продаются обычным торговцем как снаряжение.
    // Наличие записи в каталоге само по себе не выдаёт её старым героям:
    // покупка или новый стартовый выбор всё равно создают экземпляр явно.
    "srd_5_2_1:component-pouch",
    "srd_5_2_1:arcane-focus-crystal",
    "srd_5_2_1:arcane-focus-orb",
    "srd_5_2_1:arcane-focus-rod",
    "srd_5_2_1:arcane-focus-staff",
    "srd_5_2_1:arcane-focus-wand",
    "srd_5_2_1:druidic-focus-mistletoe",
    "srd_5_2_1:druidic-focus-totem",
    "srd_5_2_1:druidic-focus-wooden-staff",
    "srd_5_2_1:druidic-focus-yew-wand",
    "srd_5_2_1:holy-symbol-amulet",
    "srd_5_2_1:holy-symbol-emblem",
    "srd_5_2_1:holy-symbol-reliquary",
    "srd_5_2_1:diamond-50gp",
    "srd_5_2_1:bagpipes",
    "srd_5_2_1:drum",
    "srd_5_2_1:dulcimer",
    "srd_5_2_1:flute",
    "srd_5_2_1:lute",
    "srd_5_2_1:lyre",
    "srd_5_2_1:horn",
    "srd_5_2_1:pan-flute",
    "srd_5_2_1:shawm",
    "srd_5_2_1:viol",
    "srd_5_2_1:material-summon-beast-200gp",
    "srd_5_2_1:material-summon-undead-300gp",
    "srd_5_2_1:material-summon-shadowspawn-300gp",
    "srd_5_2_1:material-summon-fey-300gp",
    "srd_5_2_1:material-shadow-of-moil-150gp",
    "srd_5_2_1:material-summon-aberration-400gp",
    "srd_5_2_1:material-summon-construct-400gp",
    "srd_5_2_1:material-summon-elemental-400gp",
    "srd_5_2_1:material-summon-draconic-spirit-500gp",
    "srd_5_2_1:material-summon-celestial-500gp",
    "srd_5_2_1:material-dawn-100gp",
    "srd_5_2_1:material-circle-of-death-500gp",
    "srd_5_2_1:material-summon-fiend-600gp",
    "srd_5_2_1:material-diamond-dust-100gp",
];

/// Магическая добыча открыта **отдельным** списком, а не редкостью и не фактом
/// наличия записи в каталоге: сюда попадают только вещи с исполненной
/// серверной механикой, которые не ломают бой одним появлением.
///
/// Жезл и Огненный язык сюда намеренно не входят: у первого расходуемые заряды
/// и уничтожение на натуральной единице, у второго — активация бонусным
/// действием. Оба требуют объяснения игроку и остаются наградой за сюжет.
const MAGIC_LOOT_IDS: &[&str] = &[
    "srd_5_2_1:longsword-plus-1",
    "srd_5_2_1:cloak-of-protection",
    "srd_5_2_1:brooch-of-shielding",
    "srd_5_2_1:adamantine-chain-mail",
    "srd_5_2_1:weapon-of-warning-longsword",
    "srd_5_2_1:ring-of-protection",
    "srd_5_2_1:ring-of-fire-resistance",
    "srd_5_2_1:vicious-longsword",
];

const LOOT_IDS: &[&str] = &[
    "srd_5_2_1:arrows-20",
    "srd_5_2_1:battleaxe",
    "srd_5_2_1:bolts-20",
    "srd_5_2_1:chain-shirt",
    "srd_5_2_1:club",
    "srd_5_2_1:dagger",
    "srd_5_2_1:dart",
    "srd_5_2_1:greataxe",
    "srd_5_2_1:greatclub",
    "srd_5_2_1:handaxe",
    "srd_5_2_1:healers-kit",
    "srd_5_2_1:hide-armor",
    "srd_5_2_1:javelin",
    "srd_5_2_1:leather-armor",
    "srd_5_2_1:light-crossbow",
    "srd_5_2_1:longsword",
    "srd_5_2_1:mace",
    "srd_5_2_1:quarterstaff",
    "srd_5_2_1:rations-one-day",
    "srd_5_2_1:ring-mail",
    "srd_5_2_1:rope-hempen-50-feet",
    "srd_5_2_1:shield",
    "srd_5_2_1:shortbow",
    "srd_5_2_1:shortsword",
    "srd_5_2_1:sickle",
    "srd_5_2_1:sling",
    "srd_5_2_1:sling-bullets-20",
    "srd_5_2_1:spear",
    "srd_5_2_1:torch",
    "srd_5_2_1:war-pick",
];

/// `normalizeItemRechargeProfile(input)`: единственный исполнимый профиль —
/// рассвет и «1к6+1»; любой другой вход — `None`.
pub fn normalize_item_recharge_profile(input: Option<&Value>) -> Option<Value> {
    let input = input.filter(|input| input.is_object())?;
    if js::number(input.get("schema_version")) != ITEM_RECHARGE_SCHEMA_VERSION as f64 {
        return None;
    }
    if text::lower(text::trim(&js::s(input.get("trigger")))) != "dawn" {
        return None;
    }
    let formula: String = text::lower(text::trim(&js::s(input.get("formula")))).chars().filter(|ch| !text::is_js_space(*ch)).collect();
    if formula != "1d6+1" {
        return None;
    }
    Some(recharge_profile())
}

fn recharge_profile() -> Value {
    json!({ "schema_version": ITEM_RECHARGE_SCHEMA_VERSION, "trigger": "dawn", "formula": "1d6+1" })
}

fn availability(catalog_id: &str) -> Value {
    json!({
        "shop": SHOP_IDS.contains(&catalog_id),
        "loot": LOOT_IDS.contains(&catalog_id),
        "magic_loot": MAGIC_LOOT_IDS.contains(&catalog_id),
        "crafting": false,
    })
}

/// `provenance(sourcePage, { sourcePages, mechanicsSourcePage, sourceBase })`.
fn provenance(source_page: i64, source_pages: Option<Value>, mechanics_source_page: Option<i64>, source_base: &Value) -> Value {
    let mut result = object_of(source_base);
    result.insert("source_page".into(), json!(source_page));
    if let Some(pages) = source_pages {
        result.insert("source_pages".into(), pages);
    }
    if let Some(page) = mechanics_source_page {
        result.insert("mechanics_source_page".into(), json!(page));
    }
    Value::Object(result)
}

/// Объект `{ ...before, ...source, ...after }` — так записи JS разворачивают
/// источник сразу после `catalog_id`.
fn spliced(before: Value, source: &Value, after: Value) -> Value {
    let mut result = object_of(&before);
    for (key, value) in object_of(source).into_iter().chain(object_of(&after)) {
        result.insert(key, value);
    }
    Value::Object(result)
}

/// Поле входной строки таблицы с параметром по умолчанию деструктуризации JS: запас только для `undefined`.
fn row_or(input: &Value, key: &str, fallback: Value) -> Value {
    input.get(key).cloned().unwrap_or(fallback)
}

fn row_str(input: &Value, key: &str) -> String {
    js::s(input.get(key))
}

fn property_list(input: &Value) -> Vec<String> {
    input.get("properties").and_then(Value::as_array).map(|items| items.iter().map(|item| js::s(Some(item))).collect()).unwrap_or_default()
}

/// `weaponCombat(...)`: боевой профиль оружия — основной режим и все хваты.
fn weapon_combat(input: &Value) -> Value {
    let group = row_str(input, "group");
    let damage = row_or(input, "damage", Value::Null);
    let damage_type = row_or(input, "damageType", Value::Null);
    let properties = property_list(input);
    let normal_range = row_or(input, "normalRange", json!(5));
    let long_range = row_or(input, "longRange", Value::Null);
    let attack_bonus = row_or(input, "attackBonus", json!(0));
    let damage_bonus = row_or(input, "damageBonus", json!(0));
    let has = |name: &str| properties.iter().any(|property| property == name);

    let ranged = group.ends_with("ranged");
    let abilities: Vec<&str> = if has("finesse") {
        vec!["str", "dex"]
    } else if ranged {
        vec!["dex"]
    } else {
        vec!["str"]
    };
    let ability = json!(abilities[abilities.len() - 1]);
    let melee_range = json!(if has("reach") { 10 } else { 5 });
    let two_handed = has("two-handed") || has("two-handed-unless-mounted");
    let versatile = properties.iter().find(|property| property.starts_with("versatile-")).map(|property| property["versatile-".len()..].to_string());

    let mut common = Map::new();
    common.insert("abilities".into(), js::strings_value(abilities.iter().copied()));
    common.insert("properties".into(), js::strings_value(properties.iter().cloned()));
    if js::truthy(Some(&attack_bonus)) {
        common.insert("attackBonus".into(), attack_bonus);
    }
    if js::truthy(Some(&damage_bonus)) {
        common.insert("damageBonus".into(), damage_bonus);
    }

    let mut modes: Vec<Map<String, Value>> = Vec::new();
    let base = |id: &str, kind: &str, damage: Value, range: Value| -> Map<String, Value> {
        let mut mode = Map::new();
        mode.insert("id".into(), json!(id));
        mode.insert("kind".into(), json!(kind));
        mode.insert("ability".into(), ability.clone());
        mode.insert("damage".into(), damage);
        mode.insert("damageType".into(), damage_type.clone());
        mode.insert("normalRange".into(), range);
        mode
    };
    if ranged {
        let mut mode = base("ranged", "ranged", damage.clone(), normal_range.clone());
        if js::present(Some(&long_range)) {
            mode.insert("longRange".into(), long_range.clone());
        }
        if two_handed {
            mode.insert("twoHanded".into(), Value::Bool(true));
        }
        if has("ammunition") {
            mode.insert("ammunition".into(), Value::Bool(true));
        }
        modes.push(mode);
    } else {
        let mut melee = base("melee", "melee", damage.clone(), melee_range.clone());
        if two_handed {
            melee.insert("twoHanded".into(), Value::Bool(true));
        }
        modes.push(melee);
        if let Some(versatile) = versatile.filter(|versatile| !versatile.is_empty()) {
            let mut mode = base("two-handed", "melee", json!(versatile), melee_range.clone());
            mode.insert("twoHanded".into(), Value::Bool(true));
            modes.push(mode);
        }
        if has("thrown") {
            let mut mode = base("thrown", "ranged", damage.clone(), normal_range.clone());
            if js::present(Some(&long_range)) {
                mode.insert("longRange".into(), long_range.clone());
            }
            mode.insert("thrown".into(), Value::Bool(true));
            modes.push(mode);
        }
    }

    let primary = modes[0].clone();
    let mut result = common;
    for key in ["kind", "ability", "damage", "damageType", "normalRange"] {
        result.insert(key.into(), primary.get(key).cloned().unwrap_or(Value::Null));
    }
    if js::present(primary.get("longRange")) {
        result.insert("longRange".into(), primary["longRange"].clone());
    }
    if js::truthy(primary.get("twoHanded")) {
        result.insert("twoHanded".into(), Value::Bool(true));
    }
    if js::truthy(primary.get("ammunition")) {
        result.insert("ammunition".into(), Value::Bool(true));
    }
    result.insert("modes".into(), Value::Array(modes.into_iter().map(Value::Object).collect()));
    Value::Object(result)
}

/// Начало каждой записи SRD: `catalog_id`, затем поля источника.
fn entry_head(catalog_id: &str, source: &Value) -> Map<String, Value> {
    let mut entry = Map::new();
    entry.insert("catalog_id".into(), json!(catalog_id));
    for (key, value) in object_of(source) {
        entry.insert(key, value);
    }
    entry
}

fn put(entry: &mut Map<String, Value>, key: &str, value: Value) {
    entry.insert(key.into(), value);
}

fn no_crafting() -> Value {
    json!({ "implemented": false, "hooks": [] })
}

/// `weaponEntry(...)`.
fn weapon_entry(input: &Value) -> Value {
    let catalog_id = format!("srd_5_2_1:{}", row_str(input, "id"));
    let name = row_or(input, "name", Value::Null);
    let normal_range = row_or(input, "normalRange", json!(5));
    let long_range = row_or(input, "longRange", Value::Null);
    let price = row_or(input, "price", Value::Null);
    let mut entry = entry_head(&catalog_id, &ITEM_CATALOG_SOURCE);
    put(&mut entry, "display_name", name.clone());
    put(&mut entry, "name", name);
    put(&mut entry, "manifest_section", json!("weapon"));
    put(&mut entry, "description", row_or(input, "description", Value::Null));
    put(&mut entry, "category", json!("weapon"));
    put(&mut entry, "type", json!("weapon"));
    put(&mut entry, "price_cp", price.clone());
    put(&mut entry, "base_price_cp", price);
    put(&mut entry, "weight", row_or(input, "weight", Value::Null));
    put(&mut entry, "lifecycle", json!({ "equippable": true, "equip_slot": "main_hand", "transferable": true, "stackable": false }));
    put(&mut entry, "equip", json!({ "slot": "main_hand" }));
    put(&mut entry, "combat", weapon_combat(input));
    put(&mut entry, "use", Value::Null);
    put(&mut entry, "attunement", json!({ "required": false }));
    put(&mut entry, "charges", Value::Null);
    put(&mut entry, "recharge", Value::Null);
    put(&mut entry, "crafting", no_crafting());
    put(
        &mut entry,
        "weapon",
        json!({
            "group": row_or(input, "group", Value::Null),
            "damage": row_or(input, "damage", Value::Null),
            "damage_type": row_or(input, "damageType", Value::Null),
            "properties": row_or(input, "properties", json!([])),
            "mastery": row_or(input, "mastery", Value::Null),
            "normal_range_feet": normal_range,
            "long_range_feet": long_range,
        }),
    );
    put(&mut entry, "mechanics_status", json!("partial"));
    put(&mut entry, "limitation", json!("Базовая атака, выбор хвата, finesse, reach, метание и расход ammunition исполняются сервером; mastery, возврат брошенного оружия и подбор выпущенных снарядов пока не автоматизированы."));
    put(&mut entry, "availability", availability(&catalog_id));
    put(&mut entry, "source_page", json!(91));
    put(&mut entry, "provenance", provenance(91, None, None, &ITEM_CATALOG_SOURCE));
    Value::Object(entry)
}

/// `armorEntry(...)`.
fn armor_entry(input: &Value) -> Value {
    let catalog_id = format!("srd_5_2_1:{}", row_str(input, "id"));
    let category = row_str(input, "category");
    let armor_class_base = row_or(input, "armorClassBase", Value::Null);
    let dexterity_cap = row_or(input, "dexterityCap", Value::Null);
    let armor_class_bonus = row_or(input, "armorClassBonus", Value::Null);
    let strength = row_or(input, "strength", Value::Null);
    let stealth_disadvantage = row_or(input, "stealthDisadvantage", Value::Bool(false));
    let price = row_or(input, "price", Value::Null);
    let name = row_or(input, "name", Value::Null);
    let shield = category == "shield";
    let armor_profile = if shield {
        json!({ "kind": "shield", "armorClassBonus": armor_class_bonus, "speedPenalty": 0 })
    } else {
        json!({
            "kind": "armor",
            "armorClassBase": armor_class_base,
            "dexterityCap": dexterity_cap,
            "speedPenalty": 0,
            "strengthRequirement": strength,
            "stealthDisadvantage": stealth_disadvantage,
        })
    };
    let summary = if shield {
        format!("Даёт +{} к КД.", js::s(Some(&armor_class_bonus)))
    } else {
        let dexterity = if dexterity_cap.as_f64() == Some(0.0) {
            String::new()
        } else if dexterity_cap.is_null() {
            " + модификатор Ловкости".to_string()
        } else {
            format!(" + модификатор Ловкости (не более {})", js::s(Some(&dexterity_cap)))
        };
        format!("КД {}{dexterity}.", js::s(Some(&armor_class_base)))
    };
    let slot = if shield { "off_hand" } else { "body" };
    let mut entry = entry_head(&catalog_id, &ITEM_CATALOG_SOURCE);
    put(&mut entry, "display_name", name.clone());
    put(&mut entry, "name", name);
    put(&mut entry, "manifest_section", json!("armor"));
    put(&mut entry, "description", json!(format!("{} {summary}", row_str(input, "description"))));
    put(&mut entry, "category", json!("armor"));
    put(&mut entry, "type", json!("armor"));
    put(&mut entry, "price_cp", price.clone());
    put(&mut entry, "base_price_cp", price);
    put(&mut entry, "weight", row_or(input, "weight", Value::Null));
    put(&mut entry, "lifecycle", json!({ "equippable": true, "equip_slot": slot, "transferable": true, "stackable": false }));
    put(&mut entry, "equip", json!({ "slot": slot, "armor": armor_profile }));
    put(&mut entry, "combat", Value::Null);
    put(&mut entry, "use", Value::Null);
    put(&mut entry, "attunement", json!({ "required": false }));
    put(&mut entry, "charges", Value::Null);
    put(&mut entry, "recharge", Value::Null);
    put(&mut entry, "crafting", no_crafting());
    put(
        &mut entry,
        "armor",
        json!({
            "category": category,
            "armor_class_base": armor_class_base,
            "dexterity_cap": dexterity_cap,
            "armor_class_bonus": armor_class_bonus,
            "strength": strength,
            "stealth_disadvantage": stealth_disadvantage,
        }),
    );
    put(&mut entry, "mechanics_status", json!("partial"));
    put(&mut entry, "limitation", json!("КД, требование Силы и помеха Скрытности считаются сервером; training и время don/doff пока не автоматизированы."));
    put(&mut entry, "availability", availability(&catalog_id));
    put(&mut entry, "source_page", json!(92));
    put(&mut entry, "provenance", provenance(92, None, None, &ITEM_CATALOG_SOURCE));
    Value::Object(entry)
}

/// `ammunitionEntry(...)`.
fn ammunition_entry(input: &Value) -> Value {
    let catalog_id = format!("srd_5_2_1:{}", row_str(input, "id"));
    let name = row_or(input, "name", Value::Null);
    let amount = row_or(input, "amount", Value::Null);
    let price = row_or(input, "price", Value::Null);
    let description = format!(
        "{}: комплект из {} шт. {} Выстрел расходует один снаряд даже при промахе.",
        js::s(Some(&name)),
        js::s(Some(&amount)),
        row_str(input, "description"),
    );
    let mut entry = entry_head(&catalog_id, &ITEM_CATALOG_SOURCE);
    put(&mut entry, "display_name", name.clone());
    put(&mut entry, "name", name);
    put(&mut entry, "manifest_section", json!("ammunition"));
    put(&mut entry, "description", json!(description));
    put(&mut entry, "category", json!("ammunition"));
    put(&mut entry, "type", json!("other"));
    put(&mut entry, "price_cp", price.clone());
    put(&mut entry, "base_price_cp", price);
    put(&mut entry, "weight", row_or(input, "weight", Value::Null));
    put(&mut entry, "lifecycle", json!({ "equippable": false, "equip_slot": null, "transferable": true, "stackable": true }));
    put(&mut entry, "equip", Value::Null);
    put(&mut entry, "combat", Value::Null);
    put(&mut entry, "use", Value::Null);
    put(&mut entry, "attunement", json!({ "required": false }));
    put(&mut entry, "charges", Value::Null);
    put(&mut entry, "recharge", Value::Null);
    put(&mut entry, "crafting", no_crafting());
    put(
        &mut entry,
        "ammunition",
        json!({ "amount": amount, "storage": row_or(input, "storage", Value::Null), "unit": row_or(input, "unit", Value::Null) }),
    );
    put(&mut entry, "mechanics_status", json!("partial"));
    put(&mut entry, "limitation", json!("Покупка, хранение, передача и расход исполнимы: выстрел оружием со свойством ammunition снимает один снаряд и у героя, и у противника, промах тратит его наравне с попаданием, а пустой колчан закрывает дальнюю атаку до броска. Не исполнен подбор снарядов после боя — выпущенная стрела не возвращается."));
    put(&mut entry, "availability", availability(&catalog_id));
    put(&mut entry, "source_page", json!(96));
    put(&mut entry, "provenance", provenance(96, None, None, &ITEM_CATALOG_SOURCE));
    Value::Object(entry)
}

/// `toolEntry(...)`.
fn tool_entry(input: &Value) -> Value {
    let catalog_id = format!("srd_5_2_1:{}", row_str(input, "id"));
    let name = row_or(input, "name", Value::Null);
    let price = row_or(input, "price", Value::Null);
    let source_page = row_or(input, "sourcePage", json!(93));
    let source_pages = row_or(input, "sourcePages", Value::Null);
    let pages = js::truthy(Some(&source_pages)).then(|| source_pages.clone());
    let mut entry = entry_head(&catalog_id, &ITEM_CATALOG_SOURCE);
    put(&mut entry, "display_name", name.clone());
    put(&mut entry, "name", name);
    put(&mut entry, "manifest_section", row_or(input, "manifestSection", json!("artisan-tool")));
    put(&mut entry, "description", row_or(input, "description", Value::Null));
    put(&mut entry, "category", json!("tool"));
    put(&mut entry, "type", json!("tool"));
    put(&mut entry, "price_cp", price.clone());
    put(&mut entry, "base_price_cp", price);
    put(&mut entry, "weight", row_or(input, "weight", Value::Null));
    put(&mut entry, "lifecycle", json!({ "equippable": false, "equip_slot": null, "transferable": true, "stackable": false }));
    put(&mut entry, "equip", Value::Null);
    put(&mut entry, "combat", Value::Null);
    put(&mut entry, "use", Value::Null);
    put(&mut entry, "attunement", json!({ "required": false }));
    put(&mut entry, "charges", Value::Null);
    put(&mut entry, "recharge", Value::Null);
    put(&mut entry, "crafting", json!({ "implemented": false, "hooks": row_or(input, "hooks", json!([])) }));
    put(&mut entry, "crafting_families", row_or(input, "craftingFamilies", json!([])));
    put(&mut entry, "tool", json!({ "ability": row_or(input, "ability", Value::Null) }));
    put(&mut entry, "mechanics_status", json!("ruling-only"));
    put(&mut entry, "limitation", json!("Каталог хранит точные цену, вес и crafting hooks, но Utilize/Craft не исполняются движком."));
    put(&mut entry, "availability", availability(&catalog_id));
    put(&mut entry, "source_page", source_page.clone());
    if let Some(pages) = &pages {
        put(&mut entry, "source_pages", pages.clone());
    }
    put(&mut entry, "provenance", provenance(source_page.as_i64().unwrap_or(0), pages, None, &ITEM_CATALOG_SOURCE));
    Value::Object(entry)
}

/// `gearEntry(...)`.
fn gear_entry(input: &Value) -> Value {
    let catalog_id = format!("srd_5_2_1:{}", row_str(input, "id"));
    let name = row_or(input, "name", Value::Null);
    let price = row_or(input, "price", Value::Null);
    let item_type = row_or(input, "type", json!("tool"));
    let item_use = row_or(input, "use", Value::Null);
    let mechanics_status = row_or(input, "mechanicsStatus", Value::Null);
    let mechanics_source_page = row_or(input, "mechanicsSourcePage", Value::Null);
    let dndsu_reference_url = row_or(input, "dndsuReferenceUrl", Value::Null);
    let partial = SHOP_IDS.contains(&catalog_id.as_str()) || js::present(Some(&item_use));
    let mechanics_page = js::truthy(Some(&mechanics_source_page)).then(|| mechanics_source_page.as_i64().unwrap_or(0));
    let source_pages = mechanics_page.map(|page| json!([95, page]));
    let category = match item_type.as_str() {
        Some("consumable") => "consumable",
        Some("other") => "gear",
        _ => "tool",
    };
    let mut entry = entry_head(&catalog_id, &ITEM_CATALOG_SOURCE);
    put(&mut entry, "display_name", name.clone());
    put(&mut entry, "name", name);
    put(&mut entry, "manifest_section", json!("practical-gear"));
    put(&mut entry, "description", row_or(input, "description", Value::Null));
    put(&mut entry, "category", json!(category));
    put(&mut entry, "type", item_type);
    put(&mut entry, "price_cp", price.clone());
    put(&mut entry, "base_price_cp", price);
    put(&mut entry, "weight", row_or(input, "weight", Value::Null));
    put(
        &mut entry,
        "lifecycle",
        json!({ "equippable": false, "equip_slot": null, "transferable": true, "stackable": row_or(input, "stackable", Value::Bool(true)) }),
    );
    put(&mut entry, "equip", Value::Null);
    put(&mut entry, "combat", Value::Null);
    put(&mut entry, "use", item_use);
    put(&mut entry, "attunement", json!({ "required": false }));
    put(&mut entry, "charges", row_or(input, "charges", Value::Null));
    put(&mut entry, "recharge", Value::Null);
    put(&mut entry, "crafting", no_crafting());
    let status = if js::present(Some(&mechanics_status)) {
        mechanics_status
    } else {
        json!(if partial { "partial" } else { "ruling-only" })
    };
    put(&mut entry, "mechanics_status", status);
    put(&mut entry, "limitation", row_or(input, "limitation", Value::Null));
    put(&mut entry, "availability", availability(&catalog_id));
    put(&mut entry, "source_page", json!(95));
    if let Some(pages) = &source_pages {
        put(&mut entry, "source_pages", pages.clone());
    }
    if let Some(page) = mechanics_page {
        put(&mut entry, "mechanics_source_page", json!(page));
    }
    if js::truthy(Some(&dndsu_reference_url)) {
        put(&mut entry, "dndsu_reference_url", dndsu_reference_url);
    }
    put(&mut entry, "provenance", provenance(95, source_pages, mechanics_page, &ITEM_CATALOG_SOURCE));
    Value::Object(entry)
}

/// `spellcastingComponentEntry(...)`. Материальные предметы заклинателя живут
/// в том же каталоге, что и обычное снаряжение. Их механические поля
/// намеренно плоские и каталожные: валидатор заклинания читает их по
/// `catalog_id`, а имя или описание экземпляра не доказывают наличие фокуса
/// или дорогого компонента.
fn spellcasting_component_entry(input: &Value) -> Value {
    let catalog_id = format!("srd_5_2_1:{}", row_str(input, "id"));
    let name = row_or(input, "name", Value::Null);
    let price = row_or(input, "price", Value::Null);
    let spellcasting_focus = row_or(input, "spellcastingFocus", Value::Null);
    let component_pouch = row_or(input, "componentPouch", Value::Bool(false));
    let material_component = row_or(input, "materialComponent", Value::Null);
    let equip_slot = row_or(input, "equipSlot", Value::Null);
    let focus_mode = row_or(input, "focusMode", Value::Null);
    let equippable = js::present(Some(&equip_slot));
    let mut entry = entry_head(&catalog_id, &SPELLCASTING_COMPONENT_SOURCE);
    put(&mut entry, "display_name", name.clone());
    put(&mut entry, "name", name);
    put(&mut entry, "manifest_section", json!("spellcasting-component"));
    put(&mut entry, "description", row_or(input, "description", Value::Null));
    put(&mut entry, "category", json!("focus"));
    put(&mut entry, "type", row_or(input, "itemType", json!("other")));
    put(&mut entry, "price_cp", price.clone());
    put(&mut entry, "base_price_cp", price);
    put(&mut entry, "weight", row_or(input, "weight", Value::Null));
    put(&mut entry, "lifecycle", json!({ "equippable": equippable, "equip_slot": equip_slot, "transferable": true, "stackable": false }));
    let equip = if equippable {
        let mut equip = Map::new();
        equip.insert("slot".into(), equip_slot.clone());
        if js::truthy(Some(&focus_mode)) {
            equip.insert("focus_mode".into(), focus_mode.clone());
        }
        Value::Object(equip)
    } else {
        Value::Null
    };
    put(&mut entry, "equip", equip);
    put(&mut entry, "combat", Value::Null);
    put(&mut entry, "use", Value::Null);
    put(&mut entry, "attunement", json!({ "required": false }));
    put(&mut entry, "charges", Value::Null);
    put(&mut entry, "recharge", Value::Null);
    put(&mut entry, "crafting", no_crafting());
    if js::truthy(Some(&spellcasting_focus)) {
        put(&mut entry, "spellcasting_focus", spellcasting_focus);
    }
    if js::truthy(Some(&component_pouch)) {
        put(&mut entry, "component_pouch", Value::Bool(true));
    }
    if js::truthy(Some(&material_component)) {
        put(&mut entry, "material_component", material_component);
    }
    if js::truthy(Some(&focus_mode)) {
        put(&mut entry, "focus_mode", focus_mode);
    }
    put(&mut entry, "mechanics_status", json!("partial"));
    put(&mut entry, "limitation", json!("Наличие и пригодность компонента проверяются по каталогу экземпляра; название вещи и монеты сами по себе не заменяют фокус или дорогой материал."));
    put(&mut entry, "availability", availability(&catalog_id));
    put(&mut entry, "source_page", json!(95));
    put(&mut entry, "provenance", provenance(95, None, None, &SPELLCASTING_COMPONENT_SOURCE));
    Value::Object(entry)
}

/// `spellMaterialEntry(...)`. Материалы с указанной стоимостью берутся с
/// карточек dnd.su; они не экипируются и не заменяются деньгами, а
/// `spell_ids` связывает вещь с заклинаниями, которым её может предъявить
/// общий сопоставитель компонентов.
fn spell_material_entry(input: &Value) -> Value {
    let catalog_id = format!("srd_5_2_1:material-{}", row_str(input, "id"));
    let name = row_or(input, "name", Value::Null);
    let cost = row_or(input, "costCp", Value::Null);
    let source_url = row_or(input, "sourceUrl", Value::Null);
    let source_urls = row_or(input, "sourceUrls", Value::Array(vec![source_url.clone()]));
    let spell_ids: Vec<String> = input.get("spellIds").and_then(Value::as_array).map(|ids| ids.iter().map(|id| js::s(Some(id))).collect()).unwrap_or_default();
    let mut unique_urls: Vec<Value> = Vec::new();
    for url in source_urls.as_array().into_iter().flatten() {
        if !unique_urls.contains(url) {
            unique_urls.push(url.clone());
        }
    }
    let source = json!({
        "source_url": source_url,
        "source_urls": unique_urls,
        "source_version": "D&D 5e 2014 spell card · dnd.su",
        "secondary_source_url": "https://www.dndbeyond.com/sources/dnd/basic-rules-2014/spellcasting",
        "license": "ORIGINAL-PARAPHRASE",
        "attribution": "Краткая формулировка материального компонента — самостоятельный парафраз карточки заклинания D&D 5e 2014; источник: dnd.su.",
    });
    let mut entry = entry_head(&catalog_id, &source);
    put(&mut entry, "display_name", name.clone());
    put(&mut entry, "name", name);
    put(&mut entry, "manifest_section", json!("spell-material"));
    put(&mut entry, "description", row_or(input, "description", Value::Null));
    put(&mut entry, "category", json!("material-component"));
    put(&mut entry, "type", json!("other"));
    put(&mut entry, "price_cp", cost.clone());
    put(&mut entry, "base_price_cp", cost.clone());
    put(&mut entry, "weight", json!(0));
    put(
        &mut entry,
        "lifecycle",
        json!({ "equippable": false, "equip_slot": null, "transferable": true, "stackable": row_or(input, "stackable", Value::Bool(false)) }),
    );
    put(&mut entry, "equip", Value::Null);
    put(&mut entry, "combat", Value::Null);
    put(&mut entry, "use", Value::Null);
    put(&mut entry, "attunement", json!({ "required": false }));
    put(&mut entry, "charges", Value::Null);
    put(&mut entry, "recharge", Value::Null);
    put(&mut entry, "crafting", no_crafting());
    put(
        &mut entry,
        "material_component",
        json!({ "kind": row_or(input, "kind", Value::Null), "value_cp": cost, "spell_ids": spell_ids }),
    );
    put(&mut entry, "mechanics_status", json!("partial"));
    put(&mut entry, "limitation", json!("Наличие настоящего компонента проверяется по каталогу экземпляра; расходование порции выполняет обработчик заклинания после успешной проверки."));
    put(&mut entry, "availability", availability(&catalog_id));
    put(&mut entry, "source_page", json!(1));
    let base = js::spread(&source, json!({ "source_ref": format!("dndsu:spell:{}", spell_ids.join(",")) }));
    put(&mut entry, "provenance", provenance(1, None, None, &base));
    Value::Object(entry)
}

/// Что сервер вправе положить противнику в карман **сам**, без решения
/// автора. Категории оружия и боеприпасов входят целиком; прочее снаряжение —
/// поимённо. **Доспехов здесь нет, и это сторож:** стат-блок SRD объявляет КД
/// числом и доспех не называет, поэтому кольчуга в инвентаре противника была
/// бы выдумкой. Снять доспех с тела это не запрещает: `corpse_loot_eligible`
/// шире и категорию не смотрит.
const ENEMY_LOADOUT_CATEGORIES: [&str; 2] = ["weapon", "ammunition"];
const ENEMY_LOADOUT_GEAR_IDS: [&str; 12] = [
    "srd_5_2_1:acid",
    "srd_5_2_1:alchemists-fire",
    "srd_5_2_1:antitoxin",
    "srd_5_2_1:caltrops",
    "srd_5_2_1:healers-kit",
    "srd_5_2_1:holy-water",
    "srd_5_2_1:oil-flask",
    "srd_5_2_1:poison-basic",
    "srd_5_2_1:potion-of-healing",
    "srd_5_2_1:rations-one-day",
    "srd_5_2_1:rope-hempen-50-feet",
    "srd_5_2_1:torch",
];

/// `lootMetadata(entry)`: два поля отвечают на два разных вопроса.
///
/// - `enemy_loadout_eligible` — сервер вправе выдать вещь противнику при
///   сборке встречи: обычное оружие, боеприпасы и поимённое полевое
///   снаряжение; магия (у неё свой канал `magic_loot`) и доспех — нет.
/// - `corpse_loot_eligible` — вещь можно снять с тела и она что-то значит в
///   руках отряда; сюда попадают и магия, и доспех.
///
/// Общая граница одна: `ruling-only` не материализуется нигде.
fn loot_metadata(entry: &Value) -> (bool, bool) {
    let executable = entry.get("mechanics_status").and_then(Value::as_str) != Some("ruling-only");
    let transferable = !js::is_false(entry.get("lifecycle").and_then(|lifecycle| lifecycle.get("transferable")));
    let magic = js::truthy(entry.get("magic_item"));
    let category = entry.get("category").and_then(Value::as_str).unwrap_or_default();
    let catalog_id = entry.get("catalog_id").and_then(Value::as_str).unwrap_or_default();
    let enemy = executable && transferable && !magic && (ENEMY_LOADOUT_CATEGORIES.contains(&category) || ENEMY_LOADOUT_GEAR_IDS.contains(&catalog_id));
    (enemy, executable && transferable)
}

fn build_catalog() -> Value {
    let entries: Vec<Value> = tables::weapons()
        .iter()
        .map(weapon_entry)
        .chain(tables::armor().iter().map(armor_entry))
        .chain(tables::ammunition().iter().map(ammunition_entry))
        .chain(tables::tools().iter().map(tool_entry))
        .chain(tables::other_tools().iter().map(tool_entry))
        .chain(tables::gear().iter().map(gear_entry))
        .chain(tables::spellcasting_components().iter().map(spellcasting_component_entry))
        .chain(tables::spell_material_components().iter().map(spell_material_entry))
        .chain(tables::magic_items())
        .collect();
    let mut catalog = Map::new();
    for mut entry in entries {
        let (enemy, corpse) = loot_metadata(&entry);
        let catalog_id = js::s(entry.get("catalog_id"));
        if let Some(map) = entry.as_object_mut() {
            map.insert("enemy_loadout_eligible".into(), Value::Bool(enemy));
            map.insert("corpse_loot_eligible".into(), Value::Bool(corpse));
        }
        catalog.insert(catalog_id, entry);
    }
    Value::Object(catalog)
}

/// `ITEM_CATALOG`: 145 записей SRD по `catalog_id` в порядке манифеста.
/// Проверки манифеста (число записей, уникальность id, известные id списка
/// снаряжения противника), которые JS делает при импорте, держат тесты крейта:
/// таблицы статичны и во время работы не меняются.
pub static ITEM_CATALOG: LazyLock<Value> = LazyLock::new(build_catalog);

/// Записи [`ITEM_CATALOG`] как словарь.
pub fn item_catalog() -> &'static Map<String, Value> {
    static EMPTY: LazyLock<Map<String, Value>> = LazyLock::new(Map::new);
    ITEM_CATALOG.as_object().unwrap_or(&EMPTY)
}

/// Предметы авторских сценариев — не SRD, поэтому отдельный каталог: у них нет
/// страницы источника и CC-BY-атрибуции, их не продают и не роняют в добыче.
/// Награду выдаёт сам сценарий. Общий поиск [`catalog_item`] видит обе записи.
static SCENARIO_ITEM_SOURCE: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "source_url": "docs/astohan-scenario.md",
        "source_version": "Асстоханские равнины, сценарий владельца",
        "license": "project-own",
        "attribution": "Авторский предмет сценария «Асстоханские равнины».",
    })
});
static SCENARIO_ITEM_AVAILABILITY: LazyLock<Value> = LazyLock::new(|| json!({ "shop": false, "loot": false, "magic_loot": false, "crafting": false }));

/// `SCENARIO_ITEM_CATALOG`.
pub static SCENARIO_ITEM_CATALOG: LazyLock<Value> = LazyLock::new(|| {
    Value::Object(tables::scenario_items().into_iter().map(|entry| (js::s(entry.get("catalog_id")), entry)).collect())
});

fn ids_where(include: impl Fn(&Value) -> bool) -> Vec<&'static str> {
    item_catalog().iter().filter(|(_, entry)| include(entry)).map(|(id, _)| id.as_str()).collect()
}

fn channel_open(entry: &Value, channel: &str) -> bool {
    js::truthy(entry.get("availability").and_then(|availability| availability.get(channel)))
}

fn status_of(entry: &Value) -> Option<&str> {
    entry.get("mechanics_status").and_then(Value::as_str)
}

/// `ITEM_SHOP_CATALOG_IDS`: открытое лавке и исполнимое.
pub static ITEM_SHOP_CATALOG_IDS: LazyLock<Vec<&'static str>> = LazyLock::new(|| ids_where(|entry| channel_open(entry, "shop") && status_of(entry) != Some("ruling-only")));

/// `ITEM_MAGIC_LOOT_CATALOG_IDS`.
pub static ITEM_MAGIC_LOOT_CATALOG_IDS: LazyLock<Vec<&'static str>> = LazyLock::new(|| ids_where(|entry| channel_open(entry, "magic_loot") && status_of(entry) != Some("ruling-only")));

/// `ITEM_LOOT_CATALOG_IDS`.
pub static ITEM_LOOT_CATALOG_IDS: LazyLock<Vec<&'static str>> = LazyLock::new(|| ids_where(|entry| channel_open(entry, "loot") && status_of(entry) != Some("ruling-only")));

/// `ITEM_CRAFTING_CATALOG_IDS`: изготовление открыто только проверенной механике.
pub static ITEM_CRAFTING_CATALOG_IDS: LazyLock<Vec<&'static str>> = LazyLock::new(|| ids_where(|entry| channel_open(entry, "crafting") && status_of(entry) == Some("verified")));

/// `SRD_EQUIPMENT_CATALOG`: записи лавки по `catalog_id`.
pub static SRD_EQUIPMENT_CATALOG: LazyLock<Value> = LazyLock::new(|| {
    Value::Object(ITEM_SHOP_CATALOG_IDS.iter().filter_map(|id| item_catalog().get(*id).map(|entry| ((*id).to_string(), entry.clone()))).collect())
});

/// Что находит `catalogItem(id)` в JS (только собственный ключ таблицы).
enum Lookup {
    Entry(&'static Value),
    Missing,
}

fn lookup(catalog_id: &str) -> Lookup {
    match catalog_item(catalog_id) {
        Some(entry) => Lookup::Entry(entry),
        None => Lookup::Missing,
    }
}

/// `catalogItem(catalogId)`: запись SRD или сценария; аргумент — уже
/// приведённое `String(catalogId ?? '')`. Ключи прототипа — `None`.
pub fn catalog_item(catalog_id: &str) -> Option<&'static Value> {
    item_catalog().get(catalog_id).or_else(|| SCENARIO_ITEM_CATALOG.get(catalog_id))
}

/// `Boolean(catalogItem(catalogId))`.
pub fn catalog_item_truthy(catalog_id: &str) -> bool {
    !matches!(lookup(catalog_id), Lookup::Missing)
}

/// `catalogIdsFor(channel)`: копия списка канала; неизвестный канал — пусто.
pub fn catalog_ids_for(channel: &str) -> Vec<&'static str> {
    match channel {
        "shop" => ITEM_SHOP_CATALOG_IDS.clone(),
        "loot" => ITEM_LOOT_CATALOG_IDS.clone(),
        "crafting" => ITEM_CRAFTING_CATALOG_IDS.clone(),
        _ => Vec::new(),
    }
}

const DND_2014_ACTION_ITEM_IDS: [&str; 2] = ["srd_5_2_1:antitoxin", "srd_5_2_1:potion-of-healing"];

fn is_2014_action_item(entry: &Value, ruleset_id: &str) -> bool {
    ruleset_id == DND_2014_RULESET_ID && entry.get("catalog_id").and_then(Value::as_str).is_some_and(|id| DND_2014_ACTION_ITEM_IDS.contains(&id))
}

/// `itemUseProfileForRuleset(entry, rulesetId)`: в редакции 2014 зелье лечения
/// и противоядие пьются основным действием.
fn item_use_profile_for_ruleset(entry: &Value, ruleset_id: &str) -> Option<Value> {
    let item_use = entry.get("use").filter(|item_use| js::truthy(Some(item_use)))?;
    let mut item_use = item_use.clone();
    if is_2014_action_item(entry, ruleset_id) {
        if let Some(map) = item_use.as_object_mut() {
            map.insert("combat_action".into(), json!("action"));
        }
    }
    Some(item_use)
}

/// `itemLifecycleProfile(catalogId, { rulesetId })`: что движку жизни вещи
/// известно о записи каталога — экипировка, стопка, броня, применение, заряды.
pub fn item_lifecycle_profile(catalog_id: &str, ruleset_id: &str) -> Option<Value> {
    let entry = match lookup(catalog_id) {
        Lookup::Entry(entry) => entry,
        Lookup::Missing => return None,
    };
    let lifecycle = entry.get("lifecycle");
    let equip = entry.get("equip");
    let armor = equip.and_then(|equip| equip.get("armor"));
    let armor_kind = armor.and_then(|armor| armor.get("kind")).and_then(Value::as_str);
    let mut profile = Map::new();
    profile.insert("equippable".into(), Value::Bool(js::is_true(lifecycle.and_then(|lifecycle| lifecycle.get("equippable")))));
    profile.insert("stackable".into(), Value::Bool(!js::is_false(lifecycle.and_then(|lifecycle| lifecycle.get("stackable")))));
    if let Some(slot) = equip.and_then(|equip| equip.get("slot")).filter(|slot| js::truthy(Some(slot))) {
        profile.insert("equip_slot".into(), slot.clone());
    }
    if armor_kind == Some("armor") {
        let armor = armor.expect("доспех");
        let mut summary = Map::new();
        if let Some(base) = armor.get("armorClassBase") {
            summary.insert("base".into(), base.clone());
        }
        let cap = armor.get("dexterityCap");
        summary.insert("dexterity".into(), Value::Bool(cap.and_then(Value::as_f64) != Some(0.0)));
        if let Some(cap) = cap {
            summary.insert("dexterity_cap".into(), cap.clone());
        }
        profile.insert("armor".into(), Value::Object(summary));
    }
    if armor_kind == Some("shield") {
        if let Some(bonus) = armor.and_then(|armor| armor.get("armorClassBonus")) {
            profile.insert("armor_bonus".into(), bonus.clone());
        }
    }
    if let Some(item_use) = item_use_profile_for_ruleset(entry, ruleset_id) {
        profile.insert("use".into(), item_use);
    }
    if let Some(activation) = entry.get("activation").filter(|activation| js::truthy(Some(activation))) {
        profile.insert("activation".into(), activation.clone());
    }
    if let Some(charges) = entry.get("charges").filter(|charges| js::truthy(Some(charges))) {
        profile.insert("charges".into(), charges.clone());
    }
    if let Some(recharge) = normalize_item_recharge_profile(entry.get("recharge")) {
        profile.insert("recharge".into(), recharge);
    }
    profile.insert("requires_attunement".into(), Value::Bool(js::is_true(entry.get("attunement").and_then(|attunement| attunement.get("required")))));
    Some(Value::Object(profile))
}

/// `itemRechargeProfile(catalogId)`: рассветная перезарядка записи, если у
/// неё есть и профиль, и заряды.
pub fn item_recharge_profile(catalog_id: &str) -> Option<Value> {
    let entry = catalog_item(catalog_id);
    let recharge = normalize_item_recharge_profile(entry.and_then(|entry| entry.get("recharge")));
    let maximum = js_max(0.0, or_zero(js::number(entry.and_then(|entry| entry.get("charges")).and_then(|charges| charges.get("max")))));
    recharge.filter(|_| maximum > 0.0)
}

/// `ITEM_ARMOR_PROFILES`: профиль брони (`equip.armor`) каждой записи, у
/// которой он есть.
pub static ITEM_ARMOR_PROFILES: LazyLock<Value> = LazyLock::new(|| {
    Value::Object(
        item_catalog()
            .values()
            .filter_map(|entry| {
                let armor = entry.get("equip").and_then(|equip| equip.get("armor")).filter(|armor| js::truthy(Some(armor)))?;
                Some((js::s(entry.get("catalog_id")), armor.clone()))
            })
            .collect(),
    )
});

/// Поля экземпляра, которые переживают материализацию (`INSTANCE_FIELDS`).
/// Происхождение — свойство **этой** вещи, а не каталожной записи, и потому
/// обязано пережить материализацию наравне с количеством и надетостью.
const INSTANCE_FIELDS: [&str; 20] = [
    "id",
    "item_id",
    "stock_id",
    "origin",
    "quantity",
    "equipped",
    "attuned_to",
    "image",
    "imagePosition",
    "imagePrompt",
    "imageStatus",
    "rarity",
    "sellable",
    "quest_item",
    "appraisal",
    "appraisal_policy_id",
    "price_provenance",
    "price_source_version",
    "charges",
    "activated",
];

fn is_instance_field(key: &str) -> bool {
    INSTANCE_FIELDS.contains(&key)
}

/// `catalogChargeState(entry, source)`: заряды экземпляра в пределах записи.
fn catalog_charge_state(entry: &Value, source: Option<&Value>) -> Value {
    let Some(charges) = entry.get("charges").filter(|charges| js::truthy(Some(charges))) else {
        return Value::Null;
    };
    let maximum = js_max(0.0, or_zero(js::number(charges.get("max"))));
    let requested = coalesce(field(field(source, "charges"), "current"), charges.get("current"));
    let requested = js::number(requested);
    let current = js_max(0.0, js_min(maximum, if is_safe_integer(requested) { requested } else { maximum }));
    json!({ "current": json_num(current), "max": json_num(maximum) })
}

/// `materializeCatalogItem(catalogId, instance)`: механика известной записи
/// становится авторитетной, от экземпляра остаются только его собственные
/// поля (`INSTANCE_FIELDS`), имя и описание. Неизвестный id — копия
/// экземпляра (не объект — пустой объект).
pub fn materialize_catalog_item(catalog_id: &str, instance: Option<&Value>) -> Value {
    let source = match instance {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    let Some(entry) = catalog_item(catalog_id) else {
        return Value::Object(source);
    };
    let mut item = Map::new();
    for (key, value) in js::entries(&source) {
        if is_instance_field(key) {
            item.insert(key.clone(), value.clone());
        }
    }
    let source_value = Value::Object(source.clone());
    let own_text = |key: &str, fallback: Option<&Value>| -> Value {
        let text = js::s(source.get(key));
        let text = text::trim(&text);
        if text.is_empty() {
            fallback.cloned().unwrap_or(Value::Null)
        } else {
            Value::String(text.to_string())
        }
    };
    item.insert("catalog_id".into(), entry.get("catalog_id").cloned().unwrap_or(Value::Null));
    item.insert("catalog_schema_version".into(), json!(ITEM_CATALOG_SCHEMA_VERSION));
    item.insert("name".into(), own_text("name", entry.get("name")));
    item.insert("type".into(), entry.get("type").cloned().unwrap_or(Value::Null));
    item.insert("weight".into(), entry.get("weight").cloned().unwrap_or(Value::Null));
    item.insert("description".into(), own_text("description", entry.get("description")));
    item.insert("properties".into(), own_text("properties", entry.get("description")));
    item.insert("base_price_cp".into(), entry.get("base_price_cp").cloned().unwrap_or(Value::Null));
    item.insert("mechanics_status".into(), entry.get("mechanics_status").cloned().unwrap_or(Value::Null));
    for key in ["rarity", "combat", "passive_effects"] {
        if let Some(value) = entry.get(key).filter(|value| js::truthy(Some(value))) {
            item.insert(key.into(), value.clone());
        }
    }
    if let Some(focus) = entry.get("spellcasting_focus").filter(|focus| focus.is_array()) {
        item.insert("spellcasting_focus".into(), focus.clone());
    }
    if js::is_true(entry.get("component_pouch")) {
        item.insert("component_pouch".into(), Value::Bool(true));
    }
    for key in ["material_component", "focus_mode"] {
        if let Some(value) = entry.get(key).filter(|value| js::truthy(Some(value))) {
            item.insert(key.into(), value.clone());
        }
    }
    if js::truthy(entry.get("charges")) {
        item.insert("charges".into(), catalog_charge_state(entry, Some(&source_value)));
    }
    if js::truthy(entry.get("activation")) {
        item.insert("activated".into(), Value::Bool(js::is_true(source.get("activated"))));
    }
    if let Some(recharge) = normalize_item_recharge_profile(entry.get("recharge")) {
        item.insert("recharge".into(), recharge);
    }
    if js::truthy(entry.get("attunement").and_then(|attunement| attunement.get("required"))) {
        item.insert("requires_attunement".into(), Value::Bool(true));
    }
    Value::Object(item)
}

/// `hydrateCatalogItem(input)`: вещь с известным `catalog_id` (или
/// `catalogId`) материализуется из каталога, прочая — копируется как есть.
pub fn hydrate_catalog_item(input: Option<&Value>) -> Value {
    let source = match input {
        Some(Value::Object(map)) => Value::Object(map.clone()),
        _ => Value::Object(Map::new()),
    };
    let catalog_id = js::s(coalesce(source.get("catalog_id"), source.get("catalogId")));
    let catalog_id = text::trim(&catalog_id);
    if catalog_item(catalog_id).is_some() {
        materialize_catalog_item(catalog_id, Some(&source))
    } else {
        source
    }
}

/// Элементы `[...value]` для списка свойств: массив — его элементы, строка —
/// её символы. Прочее в JS бросает `TypeError`; здесь — пусто.
fn spread_items(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(items)) => items.clone(),
        Some(Value::String(text)) => text.chars().map(|ch| Value::String(ch.to_string())).collect(),
        _ => Vec::new(),
    }
}

/// `offHandWeaponAllowed(entryOrItem)`: лёгкое оружие ближнего боя — его
/// держат во второй руке (бой двумя оружиями): кинжал, короткий меч, ручной
/// топор, скимитар, лёгкий молот… Принимает запись каталога (у неё есть
/// `lifecycle`) или предмет инвентаря.
pub fn off_hand_weapon_allowed(entry_or_item: Option<&Value>) -> bool {
    let entry = if js::truthy(field(entry_or_item, "lifecycle")) {
        entry_or_item
    } else {
        catalog_item(&js::s(coalesce(field(entry_or_item, "catalog_id"), field(entry_or_item, "catalogId"))))
    };
    let Some(entry) = entry else {
        return false;
    };
    let combat = entry.get("combat");
    if entry.get("type").and_then(Value::as_str) != Some("weapon")
        || field(combat, "kind").and_then(Value::as_str) != Some("melee")
        || js::is_true(field(combat, "twoHanded"))
    {
        return false;
    }
    let weapon_properties = field(entry.get("weapon"), "properties").filter(|value| !value.is_null());
    let combat_properties = field(combat, "properties").filter(|value| !value.is_null());
    spread_items(weapon_properties).iter().chain(spread_items(combat_properties).iter()).any(|property| js::string(Some(property)) == "light")
}

/// `itemViewerCapabilities(item, { rulesetId })`: что клиент может сделать с
/// вещью — экипировать, применить, активировать, сколько зарядов и снарядов.
/// Для некаталожной вещи без экипировки, настройки и перезарядки — `None`.
pub fn item_viewer_capabilities(item: Option<&Value>, ruleset_id: &str) -> Option<Value> {
    let catalog_id = js::s(coalesce(field(item, "catalog_id"), field(item, "catalogId")));
    let entry = match lookup(&catalog_id) {
        Lookup::Entry(entry) => entry,
        Lookup::Missing => return custom_item_capabilities(item),
    };
    let rule_use = item_use_profile_for_ruleset(entry, ruleset_id);
    let item_use = rule_use.as_ref().map(|rule_use| {
        let mut view = Map::new();
        view.insert("kind".into(), rule_use.get("kind").cloned().unwrap_or(Value::Null));
        if let Some(action) = rule_use.get("combat_action") {
            view.insert("action_type".into(), action.clone());
        }
        view.insert("target".into(), coalesce(rule_use.get("target"), None).cloned().unwrap_or_else(|| json!("self")));
        view.insert("range_feet".into(), coalesce(rule_use.get("range_feet"), None).cloned().unwrap_or_else(|| json!(0)));
        for key in ["charges_per_use", "spell_id", "min_charges_to_spend", "max_charges_to_spend", "default_charges_to_spend"] {
            if let Some(value) = rule_use.get(key).filter(|value| js::truthy(Some(value))) {
                view.insert(key.into(), value.clone());
            }
        }
        if js::is_true(rule_use.get("requires_equipped")) {
            view.insert("requires_equipped".into(), Value::Bool(true));
        }
        if js::is_true(rule_use.get("combat_only")) {
            view.insert("combat_only".into(), Value::Bool(true));
        }
        let kind = rule_use.get("kind").and_then(Value::as_str);
        if kind == Some("spill_zone") {
            view.insert("point_target".into(), Value::Bool(true));
        }
        if js::truthy(rule_use.get("spill_mode")) {
            view.insert("use_modes".into(), json!(["target", "spill"]));
            view.insert("point_target".into(), Value::Bool(true));
        }
        if kind == Some("coat_weapon") {
            view.insert("requires_weapon".into(), Value::Bool(true));
        }
        Value::Object(view)
    });
    let activation = entry.get("activation").filter(|activation| js::truthy(Some(activation))).map(|activation| {
        let mut view = Map::new();
        if let Some(version) = activation.get("schema_version") {
            view.insert("schema_version".into(), version.clone());
        }
        if let Some(action) = activation.get("combat_action") {
            view.insert("action_type".into(), action.clone());
        }
        view.insert("requires_equipped".into(), Value::Bool(js::is_true(activation.get("requires_equipped"))));
        view.insert("requires_attunement".into(), Value::Bool(js::is_true(activation.get("requires_attunement"))));
        Value::Object(view)
    });
    // Боеприпасы описываются проекцией, а не выводятся клиентом: какой снаряд
    // просит лук и сколько их в пачке знает каталог. Пачка отдаёт остаток,
    // оружие — чем стреляет; сложить одно с другим клиент умеет сам.
    let entry_catalog_id = js::s(entry.get("catalog_id"));
    let ammunition_profile = entry.get("ammunition").filter(|ammunition| js::truthy(Some(ammunition)));
    let weapon_ammunition = ammunition_catalog_id_for_weapon(&entry_catalog_id);
    let ammunition = if entry.get("category").and_then(Value::as_str) == Some("ammunition") && ammunition_profile.is_some() {
        let profile = ammunition_profile.expect("боеприпас");
        let per_bundle = js_max(1.0, or_value(js::number(profile.get("amount")), 1.0));
        Some(json!({
            "role": "ammunition",
            "shots": ammunition_shots_left(item),
            "per_bundle": json_num(per_bundle),
            "unit": js::string(coalesce(profile.get("unit"), entry.get("name"))),
        }))
    } else if let Some(ammo_id) = weapon_ammunition.filter(|_| js::is_true(field(entry.get("combat"), "ammunition"))) {
        let unit = coalesce(field(field(catalog_item(ammo_id), "ammunition"), "unit"), None).map_or_else(|| "снаряд".to_string(), |unit| js::s(Some(unit)));
        Some(json!({ "role": "weapon", "catalog_id": ammo_id, "unit": unit }))
    } else {
        None
    };
    let lifecycle = entry.get("lifecycle");
    let equip_slot = coalesce(field(lifecycle, "equip_slot"), None);
    let slot_text = js::s(equip_slot);
    let focus_held = entry.get("focus_mode").and_then(Value::as_str) == Some("held")
        && entry.get("spellcasting_focus").and_then(Value::as_array).is_some_and(|focus| !focus.is_empty());
    // Единственная клиентская подсказка для боевого инвентаря строится из того
    // же каталожного профиля, что и серверный `combatHeldItem`: броня, щит,
    // носимый фокус и магические предметы в этот список не попадают.
    let combat_equip = ["main_hand", "off_hand"].contains(&slot_text.as_str())
        && ((entry.get("type").and_then(Value::as_str) == Some("weapon") && js::truthy(entry.get("combat"))) || focus_held);
    let mut view = Map::new();
    view.insert("equippable".into(), Value::Bool(js::is_true(field(lifecycle, "equippable"))));
    view.insert("equip_slot".into(), equip_slot.cloned().unwrap_or(Value::Null));
    view.insert("combat_equip".into(), Value::Bool(combat_equip));
    view.insert("usable".into(), Value::Bool(item_use.is_some()));
    if off_hand_weapon_allowed(Some(entry)) {
        view.insert("off_hand".into(), Value::Bool(true));
    }
    if let Some(description) = entry.get("description") {
        view.insert("catalog_description".into(), description.clone());
    }
    view.insert("use".into(), item_use.unwrap_or(Value::Null));
    if let Some(activation) = activation {
        view.insert("activatable".into(), Value::Bool(true));
        view.insert("activation".into(), activation);
        view.insert("activated".into(), Value::Bool(js::is_true(field(item, "activated"))));
    }
    if let Some(ammunition) = ammunition {
        view.insert("ammunition".into(), ammunition);
    }
    view.insert("charges".into(), catalog_charge_state(entry, item));
    view.insert("recharge".into(), normalize_item_recharge_profile(entry.get("recharge")).unwrap_or(Value::Null));
    view.insert("requires_attunement".into(), Value::Bool(js::is_true(field(entry.get("attunement"), "required"))));
    if let Some(status) = entry.get("mechanics_status") {
        view.insert("mechanics_status".into(), status.clone());
    }
    if is_2014_action_item(entry, ruleset_id) {
        let limitation = entry.get("limitation").filter(|limitation| js::truthy(Some(limitation)));
        let prefix = limitation.map_or_else(String::new, |limitation| format!("{} ", js::s(Some(limitation))));
        view.insert("limitation".into(), json!(format!("{prefix}В профиле D&D 5e 2014 предмет требует основное действие.")));
    } else if let Some(limitation) = entry.get("limitation") {
        view.insert("limitation".into(), limitation.clone());
    }
    Some(Value::Object(view))
}

/// Ветка `itemViewerCapabilities` для вещи вне каталога.
fn custom_item_capabilities(item: Option<&Value>) -> Option<Value> {
    let item_type = field(item, "type").and_then(Value::as_str);
    let has_combat = js::truthy(field(item, "combat"));
    let equip_slot = if item_type == Some("weapon") && has_combat {
        Some("main_hand")
    } else if item_type == Some("armor") {
        Some("body")
    } else {
        None
    };
    let requires_attunement = js::is_true(field(item, "requires_attunement"));
    let recharge = normalize_item_recharge_profile(field(item, "recharge"));
    let charges = field(item, "charges");
    let maximum = js_max(0.0, or_zero(js::number(field(charges, "max"))));
    let requested = js::number(field(charges, "current"));
    let current = js_max(0.0, js_min(maximum, if is_safe_integer(requested) { requested } else { maximum }));
    let rechargeable = recharge.is_some() && maximum > 0.0;
    if equip_slot.is_none() && !requires_attunement && !rechargeable {
        return None;
    }
    Some(json!({
        "equippable": equip_slot.is_some(),
        "equip_slot": equip_slot,
        "combat_equip": equip_slot.is_some() && item_type == Some("weapon") && has_combat,
        "usable": false,
        "use": null,
        "charges": if rechargeable { json!({ "current": json_num(current), "max": json_num(maximum) }) } else { Value::Null },
        "recharge": if rechargeable { recharge.unwrap_or(Value::Null) } else { Value::Null },
        "requires_attunement": requires_attunement,
    }))
}

fn object_of(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    }
}

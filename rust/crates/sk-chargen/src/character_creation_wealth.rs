//! Стартовое богатство PHB 2014 — перенос `server/character-creation-wealth.mjs`.
//!
//! Альтернатива классовому стартовому снаряжению из PHB 2014: игрок получает
//! подтверждённый бросок денег и покупает обычные предметы за него. Модуль не
//! бросает кости, не выдаёт магические предметы и не заменяет item catalog:
//! бросок (`RollCharacterWealth`) делает Rules Engine через внедрённый
//! `sk_dice::Dice` по формуле [`PHB_STARTING_WEALTH`], здесь он только
//! проверяется и тратится.
//!
//! Этап паритета (`rust/PORTING.md`): на границе — `serde_json::Value` той же
//! формы и с тем же порядком ключей, что у JS; коды и тексты отказов — байт в байт.

use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexMap;
use sk_core::{js, re, text};
use sk_items::item_catalog::{catalog_item, item_catalog, materialize_catalog_item};
use sk_ruleset::character_creation_class_options::PHB_2014_TOOL_CATALOG;

use crate::support::{array, field, string, template, utf16_head};

/// Формула стартового богатства класса: `expression` кубов × `multiplier` зм.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StartingWealth {
    pub class_id: &'static str,
    pub expression: &'static str,
    pub multiplier: i64,
}

/// `PHB_STARTING_WEALTH`: формулы PHB 2014 для 12 классов, в порядке JS.
pub const PHB_STARTING_WEALTH: [StartingWealth; 12] = [
    StartingWealth { class_id: "barbarian", expression: "2d4", multiplier: 10 },
    StartingWealth { class_id: "bard", expression: "5d4", multiplier: 10 },
    StartingWealth { class_id: "cleric", expression: "5d4", multiplier: 10 },
    StartingWealth { class_id: "druid", expression: "2d4", multiplier: 10 },
    StartingWealth { class_id: "fighter", expression: "5d4", multiplier: 10 },
    StartingWealth { class_id: "monk", expression: "5d4", multiplier: 1 },
    StartingWealth { class_id: "paladin", expression: "5d4", multiplier: 10 },
    StartingWealth { class_id: "ranger", expression: "5d4", multiplier: 10 },
    StartingWealth { class_id: "rogue", expression: "4d4", multiplier: 10 },
    StartingWealth { class_id: "sorcerer", expression: "3d4", multiplier: 10 },
    StartingWealth { class_id: "warlock", expression: "4d4", multiplier: 10 },
    StartingWealth { class_id: "wizard", expression: "4d4", multiplier: 10 },
];

/// `PHB_STARTING_WEALTH[classId]`.
pub fn phb_starting_wealth(class_id: &str) -> Option<&'static StartingWealth> {
    PHB_STARTING_WEALTH.iter().find(|entry| entry.class_id == class_id)
}

/// `PHB_STARTING_WEALTH` как объект JS: `{ barbarian: { expression, multiplier }, … }`.
pub fn phb_starting_wealth_json() -> Value {
    Value::Object(PHB_STARTING_WEALTH.iter().map(|entry| (entry.class_id.to_string(), json!({ "expression": entry.expression, "multiplier": entry.multiplier }))).collect())
}

/// `PHB_STARTING_WEALTH_PROVENANCE`.
pub static PHB_STARTING_WEALTH_PROVENANCE: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "ruleset_id": "dnd_5e_2014",
        "source_book": "Player's Handbook (2014)",
        "source_url": "https://www.dndbeyond.com/sources/dnd/basic-rules-2014/equipment",
        "secondary_source_url": "https://www.dnd.su/articles/inventory/98-equipment/",
    })
});

/// Стоимость игровых и музыкальных инструментов в медных монетах. Транспорт
/// намеренно отсутствует: PHB отмечает его цену как зависящую от конкретного
/// средства, поэтому без цены его нельзя безопасно продавать через этот API.
const PHB_TOOL_PRICES_CP: [(&str, i64); 37] = [
    ("alchemists_supplies", 5_000), ("brewers_supplies", 2_000), ("calligraphers_supplies", 1_000),
    ("carpenters_tools", 800), ("cartographers_tools", 1_500), ("cobblers_tools", 500),
    ("cooks_utensils", 100), ("glassblowers_tools", 3_000), ("jewelers_tools", 2_500),
    ("leatherworkers_tools", 500), ("masons_tools", 1_000), ("painters_supplies", 1_000),
    ("potters_tools", 1_000), ("smiths_tools", 2_000), ("tinkers_tools", 5_000),
    ("weavers_tools", 100), ("woodcarvers_tools", 100),
    ("bagpipes", 3_000), ("drum", 600), ("dulcimer", 2_500), ("flute", 200), ("lute", 3_500),
    ("lyre", 3_000), ("horn", 300), ("pan_flute", 1_200), ("shawm", 200), ("viol", 3_000),
    ("dice_set", 10), ("dragonchess", 100), ("playing_cards", 50), ("three_dragon_ante", 100),
    ("disguise_kit", 2_500), ("forgery_kit", 1_500), ("herbalism_kit", 500),
    ("navigators_tools", 2_500), ("poisoners_kit", 5_000), ("thieves_tools", 2_500),
];

/// В текущем сценовом каталоге пеньковая верёвка имеет вес из другого
/// профильного набора. Для покупки по PHB 2014 сохраняем её цену, но
/// исправляем вес 50-футовой верёвки до 10 фунтов: `(price_cp, weight)`.
fn phb_catalog_override(catalog_id: &str) -> Option<(i64, f64)> {
    (catalog_id == "srd_5_2_1:rope-hempen-50-feet").then_some((100, 10.0))
}

/// Позиции таблиц Arcane/Druidic Focus, Holy Symbol, Adventuring Gear и
/// Equipment Packs из Basic Rules 2014, которых нет в небольшом сценовом
/// item-catalog: `(id, name, type, price_cp, weight)`. Цена — в cp, вес — в
/// фунтах; тире в исходной таблице означает нулевой вес, а не неизвестное
/// значение. Транспорт и животные с переменной ценой сюда не включены: они
/// принадлежат отдельному owned_assets.
const PHB_MISSING_EQUIPMENT: [(&str, &str, &str, i64, f64); 79] = [
    // Arcane Focus
    ("crystal", "Кристалл", "focus", 1_000, 1.0),
    ("orb", "Сфера", "focus", 2_000, 3.0),
    ("rod", "Жезл", "focus", 1_000, 2.0),
    ("staff", "Посох", "focus", 500, 4.0),
    ("wand", "Волшебная палочка", "focus", 1_000, 1.0),
    // Druidic Focus
    ("sprig-of-mistletoe", "Веточка омелы", "focus", 100, 0.0),
    ("totem", "Тотем", "focus", 100, 0.0),
    ("wooden-staff", "Деревянный посох", "focus", 500, 4.0),
    ("yew-wand", "Тисовая палочка", "focus", 1_000, 1.0),
    // Holy Symbol
    ("amulet", "Амулет", "focus", 500, 1.0),
    ("emblem", "Эмблема", "focus", 500, 0.0),
    ("reliquary", "Реликварий", "focus", 500, 2.0),
    // Other Adventuring Gear
    ("abacus", "Абак", "other", 200, 2.0),
    ("barrel", "Бочка", "other", 200, 70.0),
    ("basket", "Корзина", "other", 40, 2.0),
    ("bell", "Колокольчик", "other", 100, 0.0),
    ("blanket", "Одеяло", "other", 50, 3.0),
    ("block-and-tackle", "Блок и лебёдка", "other", 100, 5.0),
    ("book", "Книга", "book", 2_500, 5.0),
    ("bottle-glass", "Бутылка, стеклянная", "other", 200, 2.0),
    ("bucket", "Ведро", "other", 5, 2.0),
    ("candle", "Свеча", "other", 1, 0.0),
    ("case-crossbow-bolt", "Футляр для арбалетных болтов", "container", 100, 1.0),
    ("case-map-or-scroll", "Футляр для карты или свитка", "container", 100, 1.0),
    ("chain-10-feet", "Цепь, 10 футов", "other", 500, 10.0),
    ("chalk", "Мел", "other", 1, 0.0),
    ("chest", "Сундук", "container", 500, 25.0),
    ("clothes-common", "Обычная одежда", "clothing", 50, 3.0),
    ("clothes-costume", "Костюм", "clothing", 500, 4.0),
    ("clothes-fine", "Парадная одежда", "clothing", 1_500, 6.0),
    ("clothes-travelers", "Дорожная одежда", "clothing", 200, 4.0),
    ("component-pouch", "Мешочек с компонентами", "focus", 2_500, 2.0),
    ("fishing-tackle", "Рыболовные снасти", "other", 100, 4.0),
    ("flask-or-tankard", "Фляга или кружка", "other", 2, 1.0),
    ("hammer", "Молоток", "tool", 100, 3.0),
    ("hammer-sledge", "Кувалда", "tool", 200, 10.0),
    ("hourglass", "Песочные часы", "other", 2_500, 1.0),
    ("ink", "Чернила, флакон", "other", 1_000, 0.0),
    ("ink-pen", "Перо", "other", 2, 0.0),
    ("jug-or-pitcher", "Кувшин или кружка", "other", 2, 4.0),
    ("ladder-10-feet", "Лестница, 10 футов", "other", 10, 25.0),
    ("lamp", "Лампа", "other", 50, 1.0),
    ("lantern-bullseye", "Фонарь, направленный", "other", 1_000, 2.0),
    ("lock", "Замок", "other", 1_000, 1.0),
    ("magnifying-glass", "Увеличительное стекло", "other", 10_000, 0.0),
    ("mess-kit", "Кухонная утварь", "other", 20, 1.0),
    ("mirror-steel", "Зеркало, стальное", "other", 500, 0.5),
    ("paper", "Бумага, лист", "other", 20, 0.0),
    ("parchment", "Пергамент, лист", "other", 10, 0.0),
    ("perfume", "Духи, флакон", "other", 500, 0.0),
    ("miners-pick", "Кирка шахтёра", "tool", 200, 10.0),
    ("piton", "Питон", "other", 5, 0.25),
    ("pole-10-feet", "Шест, 10 футов", "other", 5, 7.0),
    ("pot-iron", "Горшок, железный", "other", 200, 10.0),
    ("pouch", "Поясной кошель", "container", 50, 1.0),
    ("quiver", "Колчан", "container", 100, 1.0),
    ("ram-portable", "Таран, переносной", "other", 400, 35.0),
    ("robes", "Одеяния", "clothing", 100, 4.0),
    ("rope-silk-50-feet", "Верёвка, шёлковая, 50 футов", "other", 1_000, 5.0),
    ("sack", "Мешок", "container", 1, 0.5),
    ("scale-merchants", "Весы, торговые", "other", 500, 3.0),
    ("sealing-wax", "Воск", "other", 50, 0.0),
    ("shovel", "Лопата", "tool", 200, 5.0),
    ("signet-ring", "Перстень с печаткой", "jewelry", 500, 0.0),
    ("soap", "Мыло", "other", 2, 0.0),
    ("spellbook", "Книга заклинаний", "book", 5_000, 3.0),
    ("spikes-iron-10", "Железные скобы, 10 штук", "other", 100, 5.0),
    ("spyglass", "Подзорная труба", "other", 100_000, 1.0),
    ("tent-two-person", "Палатка, двухместная", "other", 200, 20.0),
    ("tinderbox", "Огниво", "other", 50, 1.0),
    ("vial", "Флакон", "other", 100, 0.0),
    ("whetstone", "Точильный камень", "other", 1, 1.0),
    // Equipment Packs. Вес рассчитан по содержимому PHB; это один покупаемый
    // комплект и не превращает покупку в несколько несвязанных инстансов.
    ("burglars-pack", "Набор взломщика", "pack", 1_600, 57.5),
    ("diplomats-pack", "Набор дипломата", "pack", 3_900, 35.0),
    ("dungeoneers-pack", "Набор исследователя подземелий", "pack", 1_200, 56.5),
    ("entertainers-pack", "Набор артиста", "pack", 4_000, 38.0),
    ("priests-pack", "Набор священника", "pack", 1_900, 24.0),
    ("scholars-pack", "Набор учёного", "pack", 4_000, 12.0),
    // В таблице оружия PHB 2014 есть сеть; в сценовом catalog её пока нет.
    ("net", "Сеть", "weapon", 100, 3.0),
];

/// Старые формы PHB 2014 присылали короткие ids для фокусов. Они остаются
/// допустимыми входными алиасами, но материализация всегда направляет их в
/// авторитетный catalog_id, чтобы компонентные метаданные не терялись.
const PHB_COMPONENT_ALIASES: [(&str, &str); 15] = [
    ("component-pouch", "srd_5_2_1:component-pouch"),
    ("crystal", "srd_5_2_1:arcane-focus-crystal"),
    ("orb", "srd_5_2_1:arcane-focus-orb"),
    ("rod", "srd_5_2_1:arcane-focus-rod"),
    ("staff", "srd_5_2_1:arcane-focus-staff"),
    ("wand", "srd_5_2_1:arcane-focus-wand"),
    ("sprig-of-mistletoe", "srd_5_2_1:druidic-focus-mistletoe"),
    ("totem", "srd_5_2_1:druidic-focus-totem"),
    ("wooden-staff", "srd_5_2_1:druidic-focus-wooden-staff"),
    ("yew-wand", "srd_5_2_1:druidic-focus-yew-wand"),
    ("amulet", "srd_5_2_1:holy-symbol-amulet"),
    ("emblem", "srd_5_2_1:holy-symbol-emblem"),
    ("reliquary", "srd_5_2_1:holy-symbol-reliquary"),
    ("diamond", "srd_5_2_1:diamond-50gp"),
    ("diamond-50gp", "srd_5_2_1:diamond-50gp"),
];

fn component_alias(id: &str) -> Option<&'static str> {
    PHB_COMPONENT_ALIASES.iter().find(|(alias, _)| *alias == id).map(|(_, catalog_id)| *catalog_id)
}

fn is_magic_item(entry: &Value) -> bool {
    if entry.get("catalog_id").and_then(Value::as_str) == Some("srd_5_2_1:potion-of-healing") {
        return false;
    }
    js::truthy(entry.get("magic_item")) || js::present(entry.get("rarity"))
}

fn is_safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
}

fn price_cp(entry: &Value) -> Option<f64> {
    let value = js::number(crate::support::nullish(entry.get("price_cp"), entry.get("base_price_cp")));
    (is_safe_integer(value) && value > 0.0).then_some(value)
}

fn item_weight(entry: &Value) -> Option<f64> {
    let value = js::number(entry.get("weight"));
    (value.is_finite() && value >= 0.0).then_some(value)
}

fn catalog_purchase_entry(catalog_id: &str, entry: &Value) -> Option<Value> {
    let item_override = phb_catalog_override(catalog_id);
    let price = item_override.map(|(price, _)| price as f64).or_else(|| price_cp(entry));
    let weight = item_override.map(|(_, weight)| weight).or_else(|| item_weight(entry));
    if catalog_id.is_empty() || is_magic_item(entry) {
        return None;
    }
    let (price, weight) = (price?, weight?);
    let name = crate::support::coalesce(&[entry.get("name"), entry.get("display_name")]).map_or_else(|| catalog_id.to_string(), |name| string(Some(name)));
    let kind = crate::support::coalesce(&[entry.get("type"), entry.get("category")]).map_or_else(|| "other".to_string(), |kind| string(Some(kind)));
    let status = crate::support::coalesce(&[entry.get("mechanics_status")]).map_or_else(|| "partial".to_string(), |status| string(Some(status)));
    Some(json!({
        "id": catalog_id,
        "catalog_id": catalog_id,
        "name": name,
        "type": kind,
        "price_cp": js::num(price),
        "weight": js::num(weight),
        "source": "item_catalog",
        "mechanics_status": status,
    }))
}

fn tool_catalog_id(tool_id: &str) -> String {
    format!("srd_5_2_1:{}", tool_id.replace('_', "-"))
}

fn supplemental_tool_entry(tool: &Value) -> Option<Value> {
    let tool_id = template(tool.get("id"));
    let price = PHB_TOOL_PRICES_CP.iter().find(|(id, _)| *id == tool_id).map(|(_, price)| *price)?;
    if price <= 0 || !js::is_finite_number(tool.get("weight")) {
        return None;
    }
    let known_catalog_id = tool_catalog_id(&tool_id);
    if let Some(known) = catalog_item(&known_catalog_id).filter(|known| !is_magic_item(known)) {
        return catalog_purchase_entry(&known_catalog_id, known);
    }
    Some(json!({
        "id": tool.get("id").cloned().unwrap_or(Value::Null),
        "catalog_id": format!("phb_2014:tool:{tool_id}"),
        "name": template(tool.get("label")),
        "type": "tool",
        "price_cp": price,
        "weight": js::num(js::number(tool.get("weight"))),
        "source": "phb_2014_tool_catalog",
        "mechanics_status": "partial",
    }))
}

fn same_id(entry: &Value, id: &str) -> bool {
    entry.get("id").and_then(Value::as_str) == Some(id)
}

fn build_purchase_catalog() -> Vec<Value> {
    let mut entries: Vec<Value> = Vec::new();
    for (catalog_id, entry) in js::entries(item_catalog()) {
        if let Some(purchase) = catalog_purchase_entry(catalog_id, entry) {
            entries.push(purchase);
        }
    }
    let existing_ids: std::collections::HashSet<String> = entries.iter().map(|entry| string(entry.get("catalog_id"))).collect();
    for tool in array(Some(&PHB_2014_TOOL_CATALOG)) {
        let Some(purchase) = supplemental_tool_entry(tool) else { continue };
        let duplicate_id = entries.iter().any(|entry| entry.get("id") == purchase.get("id"));
        if !existing_ids.contains(&string(purchase.get("catalog_id"))) && !duplicate_id {
            entries.push(purchase);
        }
    }
    for (id, name, kind, price, weight) in PHB_MISSING_EQUIPMENT.iter() {
        if component_alias(id).is_some_and(|catalog_id| catalog_item(catalog_id).is_some()) {
            continue;
        }
        let catalog_id = format!("phb_2014:equipment:{id}");
        if existing_ids.contains(&catalog_id) || entries.iter().any(|entry| same_id(entry, id)) {
            continue;
        }
        entries.push(json!({
            "id": id, "name": name, "type": kind, "price_cp": price, "weight": js::num(*weight),
            "catalog_id": catalog_id, "source": "phb_2014_equipment_table", "mechanics_status": "partial",
        }));
    }
    // Животные и транспорт принадлежат герою, но не лежат в его рюкзаке.
    for (id, name, price, speed, capacity) in [
        ("camel", "Верблюд", 50, 50, 480), ("mule", "Мул или осёл", 8, 40, 420), ("elephant", "Слон", 200, 40, 1320),
        ("draft-horse", "Тягловая лошадь", 50, 40, 540), ("riding-horse", "Верховая лошадь", 75, 60, 480),
        ("mastiff", "Мастифф", 25, 40, 195), ("pony", "Пони", 30, 40, 225), ("warhorse", "Боевой конь", 400, 60, 540),
    ] {
        entries.push(json!({
            "id": format!("mount:{id}"), "name": name, "type": "mount", "price_cp": price * 100, "weight": null,
            "speed_feet": speed, "carrying_capacity_lb": capacity, "owned_asset": true, "mechanics_status": "partial",
        }));
    }
    for (id, name, price, weight) in [
        ("carriage", "Карета", 100, Some(600)), ("cart", "Повозка", 15, Some(200)), ("chariot", "Колесница", 250, Some(100)), ("sled", "Сани", 20, Some(300)), ("wagon", "Фургон", 35, Some(400)),
        ("galley", "Галера", 30000, None), ("keelboat", "Килевая лодка", 3000, None), ("longship", "Драккар", 10000, None), ("rowboat", "Вёсельная лодка", 50, Some(100)),
        ("sailing-ship", "Парусник", 10000, None), ("warship", "Военный корабль", 25000, None),
    ] {
        entries.push(json!({ "id": format!("vehicle:{id}"), "name": name, "type": "vehicle", "price_cp": price * 100, "weight": weight, "owned_asset": true, "mechanics_status": "partial" }));
    }
    for (id, name, price, weight) in [
        ("bit-bridle", "Удила и уздечка", 200, 1), ("animal-feed", "Корм на один день", 5, 10), ("saddlebags", "Седельные сумки", 400, 8),
        ("saddle-pack", "Вьючное седло", 500, 15), ("saddle-riding", "Ездовое седло", 1000, 25), ("saddle-military", "Военное седло", 2000, 30), ("saddle-exotic", "Экзотическое седло", 6000, 40),
    ] {
        if !entries.iter().any(|entry| same_id(entry, id) || entry.get("name").and_then(Value::as_str) == Some(name)) {
            entries.push(json!({ "id": id, "catalog_id": format!("phb_2014:equipment:{id}"), "name": name, "type": "other", "price_cp": price, "weight": weight, "mechanics_status": "partial" }));
        }
    }
    let snapshot = entries.clone();
    for entry in &snapshot {
        let Some(known) = catalog_item(&string(entry.get("catalog_id"))) else { continue };
        let armor = known.get("armor");
        if js::truthy(armor) && armor.and_then(|armor| armor.get("category")).and_then(Value::as_str) != Some("shield") {
            let id = template(entry.get("id"));
            entries.push(json!({
                "id": format!("barding:{id}"),
                "catalog_id": format!("phb_2014:barding:{id}"),
                "name": format!("Доспех животного: {}", template(entry.get("name"))),
                "type": "other",
                "price_cp": js::num(js::number(entry.get("price_cp")) * 4.0),
                "weight": js::num(js::number(entry.get("weight")) * 2.0),
                "mechanics_status": "partial",
            }));
        }
    }
    entries.sort_by(|left, right| text::locale_compare(&string(left.get("id")), &string(right.get("id"))));
    entries
}

static PURCHASE_CATALOG: LazyLock<Vec<Value>> = LazyLock::new(build_purchase_catalog);

/// `PURCHASE_BY_ID`: покупка по id, по catalog_id и по алиасам инструментов и
/// фокусов. Повтор ключа — последняя запись, как `new Map(...)`.
static PURCHASE_BY_ID: LazyLock<IndexMap<String, &'static Value>> = LazyLock::new(|| {
    let mut by_id: IndexMap<String, &'static Value> = IndexMap::new();
    for entry in PURCHASE_CATALOG.iter() {
        for key in ["id", "catalog_id"] {
            // Ключ `undefined` (у животных и транспорта нет catalog_id) строкой не найти.
            if let Some(value) = entry.get(key) {
                by_id.insert(template(Some(value)), entry);
            }
        }
    }
    for tool in array(Some(&PHB_2014_TOOL_CATALOG)) {
        let tool_id = template(tool.get("id"));
        if let Some(entry) = by_id.get(&tool_catalog_id(&tool_id)).copied() {
            by_id.entry(tool_id).or_insert(entry);
        }
    }
    for (alias, catalog_id) in PHB_COMPONENT_ALIASES {
        if let Some(entry) = by_id.get(catalog_id).copied() {
            by_id.entry(alias.to_string()).or_insert(entry);
        }
    }
    by_id
});

/// `startingPurchaseCatalog()`: копия каталога покупки за стартовое богатство —
/// обычные предметы с ценой и весом, животные и транспорт, без магии.
pub fn starting_purchase_catalog() -> Value {
    Value::Array(PURCHASE_CATALOG.clone())
}

fn class_id_for(value: Option<&Value>) -> Option<&'static str> {
    let id = text::lower(text::trim(&string(value)));
    phb_starting_wealth(&id).map(|entry| entry.class_id)
}

fn error(code: &str, reason: String) -> Value {
    json!({ "ok": false, "code": code, "reason": reason, "errors": [reason] })
}

struct ConfirmedWealth {
    id: String,
    total_gp: f64,
    total_cp: f64,
}

fn confirmed_wealth(class_id: &str, wealth_roll: Option<&Value>) -> Result<ConfirmedWealth, Value> {
    if !js::is_plain(wealth_roll) {
        return Err(error("WEALTH_ROLL_INVALID", "Подтверждённое богатство должно быть объектом".into()));
    }
    if text::lower(text::trim(&string(field(wealth_roll, "class_id")))) != class_id {
        return Err(error("WEALTH_CLASS_MISMATCH", "Бросок богатства принадлежит другому классу".into()));
    }
    let total_gp = js::number(field(wealth_roll, "total_gp"));
    if !is_safe_integer(total_gp) || total_gp < 0.0 {
        return Err(error("WEALTH_TOTAL_INVALID", "total_gp должен быть неотрицательным целым числом".into()));
    }
    let id = text::trim(&string(field(wealth_roll, "id"))).to_string();
    if id.is_empty() {
        return Err(error("WEALTH_ROLL_ID_REQUIRED", "У подтверждённого броска богатства должен быть id".into()));
    }
    Ok(ConfirmedWealth { id, total_gp, total_cp: total_gp * 100.0 })
}

fn remaining_currency(total_cp: f64) -> Value {
    let gold = (total_cp / 100.0).floor();
    let after_gold = total_cp % 100.0;
    let silver = (after_gold / 10.0).floor();
    let copper = after_gold % 10.0;
    json!({
        "total_cp": js::num(total_cp),
        "total_gp": js::num(total_cp / 100.0),
        "gold": js::num(gold),
        "silver": js::num(silver),
        "copper": js::num(copper),
    })
}

fn instance_id(wealth_roll_id: &str, index: usize) -> String {
    let safe = text::replace_all(re!(r"[^a-z0-9_-]+", "giu"), wealth_roll_id, "-");
    let safe = utf16_head(&text::replace_all(re!(r"^-+|-+$", "gu"), &safe, ""), 80);
    let safe = if safe.is_empty() { "roll".to_string() } else { safe };
    utf16_head(&format!("starting-wealth-{safe}-{}", index + 1), 120)
}

fn materialize_purchase(entry: &Value, quantity: f64, wealth_roll_id: &str, index: usize) -> Value {
    let id = instance_id(wealth_roll_id, index);
    let catalog_id = entry.get("catalog_id").and_then(Value::as_str);
    let known = catalog_id.filter(|catalog_id| catalog_id.starts_with("srd_5_2_1:")).and_then(catalog_item);
    if let (Some(catalog_id), Some(_)) = (catalog_id, known.filter(|known| !is_magic_item(known))) {
        let materialized = materialize_catalog_item(catalog_id, Some(&json!({ "id": id, "quantity": js::num(quantity), "equipped": false })));
        let mut result = match materialized {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        result.insert("price_cp".into(), entry.get("price_cp").cloned().unwrap_or(Value::Null));
        if let Some((price, weight)) = phb_catalog_override(catalog_id) {
            result.insert("weight".into(), js::num(weight));
            result.insert("base_price_cp".into(), json!(price));
        }
        return Value::Object(result);
    }
    let mut result = Map::new();
    result.insert("id".into(), json!(id));
    for (key, value) in [("catalog_id", entry.get("catalog_id")), ("name", entry.get("name")), ("type", entry.get("type"))] {
        if let Some(value) = value {
            result.insert(key.into(), value.clone());
        }
    }
    result.insert("quantity".into(), js::num(quantity));
    for key in ["weight", "price_cp"] {
        if let Some(value) = entry.get(key) {
            result.insert(key.into(), value.clone());
        }
    }
    result.insert("description".into(), json!("Обычный предмет PHB 2014, добавленный покупкой за стартовое богатство."));
    result.insert("properties".into(), json!("Механическое применение определяется базовыми правилами предмета."));
    for key in ["mechanics_status", "source"] {
        if let Some(value) = entry.get(key) {
            result.insert(key.into(), value.clone());
        }
    }
    result.insert("sellable".into(), json!(true));
    result.insert("equipped".into(), json!(false));
    Value::Object(result)
}

/// `resolveStartingPurchases(classId, wealthRoll, purchases)`: проверяет уже
/// подтверждённый сервером бросок денег и атомарно считает покупки. При
/// недостатке денег частичный инвентарь не возвращается. `purchases = None` —
/// аргумент не передан (`[]`).
pub fn resolve_starting_purchases(class_id: Option<&Value>, wealth_roll: Option<&Value>, purchases: Option<&Value>) -> Value {
    let Some(key) = class_id_for(class_id) else {
        return error("CLASS_UNSUPPORTED", "Неизвестный класс PHB 2014".into());
    };
    let wealth = match confirmed_wealth(key, wealth_roll) {
        Ok(wealth) => wealth,
        Err(refusal) => return refusal,
    };
    let empty = Vec::new();
    let purchases = match purchases {
        None => &empty,
        Some(Value::Array(items)) => items,
        Some(_) => return error("PURCHASES_INVALID", "purchases должен быть массивом".into()),
    };
    let mut spent_cp = 0.0;
    let mut selected: Vec<(&'static Value, f64)> = Vec::new();
    for (index, purchase) in purchases.iter().enumerate() {
        if !purchase.is_object() {
            return error("PURCHASE_INVALID", format!("Покупка {} должна быть объектом", index + 1));
        }
        let Some(entry) = PURCHASE_BY_ID.get(text::trim(&string(purchase.get("id")))).copied() else {
            return error("PURCHASE_UNKNOWN_ITEM", format!("Предмет покупки {} отсутствует в каталоге PHB 2014", string(purchase.get("id"))));
        };
        let quantity = js::number(purchase.get("quantity"));
        if !is_safe_integer(quantity) || quantity < 1.0 || quantity > 100_000.0 {
            return error("PURCHASE_QUANTITY_INVALID", format!("Количество предмета {} должно быть целым числом от 1 до 100000", template(entry.get("name"))));
        }
        let cost = js::number(entry.get("price_cp")) * quantity;
        if !is_safe_integer(cost) || !is_safe_integer(spent_cp + cost) {
            return error("PURCHASE_TOTAL_INVALID", "Стоимость покупок выходит за безопасный диапазон чисел".into());
        }
        spent_cp += cost;
        selected.push((entry, quantity));
    }
    if spent_cp > wealth.total_cp {
        return error("PURCHASES_OVER_BUDGET", "Покупки превышают подтверждённое стартовое богатство".into());
    }
    let owned = |entry: &Value| js::truthy(entry.get("owned_asset"));
    let inventory: Vec<Value> =
        selected.iter().filter(|(entry, _)| !owned(entry)).enumerate().map(|(index, (entry, quantity))| materialize_purchase(entry, *quantity, &wealth.id, index)).collect();
    let owned_assets: Vec<Value> = selected
        .iter()
        .filter(|(entry, _)| owned(entry))
        .enumerate()
        .map(|(index, (entry, quantity))| {
            let mut asset = match entry {
                Value::Object(map) => map.clone(),
                _ => Map::new(),
            };
            asset.insert("id".into(), json!(format!("{}-asset", instance_id(&wealth.id, index))));
            asset.insert("catalog_id".into(), entry.get("id").cloned().unwrap_or(Value::Null));
            asset.insert("quantity".into(), js::num(*quantity));
            Value::Object(asset)
        })
        .collect();
    json!({
        "ok": true,
        "class_id": key,
        "wealth_roll": { "id": wealth.id, "class_id": key, "total_gp": js::num(wealth.total_gp), "total_cp": js::num(wealth.total_cp) },
        "spent_cp": js::num(spent_cp),
        "inventory": inventory,
        "owned_assets": owned_assets,
        "remaining_currency": remaining_currency(wealth.total_cp - spent_cp),
    })
}

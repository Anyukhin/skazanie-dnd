//! Перенос `server/equipment-visuals.mjs`: чистый каталог видимых моделей
//! экипировки.
//!
//! Только стабильные ключи моделей, проверенные сборщиками, и адресное
//! сопоставление каталожных id; экономические и боевые свойства предмета сюда
//! не попадают. Публичная `loadout` строится только из открытых записей:
//! отсутствующий слот — «ничего не надето», `null` — «слот занят, однозначной
//! модели нет».

use std::sync::LazyLock;

use indexmap::{IndexMap, IndexSet};
use serde::Serialize;
use serde_json::{Map, Value};
use sk_core::{indexmap, js, re, text};

use crate::util::{is_prototype_key, nullish, str_of, utf16_head};

pub const EQUIPMENT_VISUAL_SCHEMA_VERSION: i64 = 2;

pub const EQUIPMENT_VISUAL_SLOTS: [&str; 8] =
    ["body", "main_hand", "off_hand", "focus", "cloak", "brooch", "ring-protection", "ring-fire-resistance"];

pub const EQUIPMENT_VISUAL_VARIANTS: [&str; 4] = ["default", "enchanted", "adamantine", "flaming"];

const CATALOG_PREFIX: &str = "srd_5_2_1:";

const WEAPON_MODEL_KEYS: [&str; 38] = [
    "club", "dagger", "greatclub", "handaxe", "javelin", "light-hammer", "mace",
    "quarterstaff", "sickle", "spear", "dart", "light-crossbow", "shortbow",
    "sling", "battleaxe", "flail", "glaive", "greataxe", "greatsword", "halberd",
    "lance", "longsword", "maul", "morningstar", "pike", "rapier", "scimitar",
    "shortsword", "trident", "warhammer", "war-pick", "whip", "blowgun",
    "hand-crossbow", "heavy-crossbow", "longbow", "musket", "pistol",
];

const ARMOR_MODEL_KEYS: [&str; 12] = [
    "armor-padded", "armor-leather", "armor-studded", "armor-hide",
    "armor-chainshirt", "armor-scalemail", "armor-breastplate",
    "armor-halfplate", "armor-ringmail", "armor-chainmail", "armor-splint",
    "armor-plate",
];

const MISC_MODEL_KEYS: [&str; 5] = ["cloak", "ring", "brooch", "wand", "shield"];

const FOCUS_MODEL_KEYS: [&str; 8] = [
    "arcane-crystal", "arcane-orb", "arcane-rod", "druidic-mistletoe",
    "druidic-totem", "holy-amulet", "holy-emblem", "holy-reliquary",
];

const INSTRUMENT_MODEL_KEYS: [&str; 10] =
    ["bagpipes", "drum", "dulcimer", "flute", "lute", "lyre", "horn", "pan-flute", "shawm", "viol"];

static MODEL_KEYS: LazyLock<IndexSet<&'static str>> = LazyLock::new(|| {
    let mut keys = IndexSet::new();
    keys.extend(WEAPON_MODEL_KEYS);
    // Сеть — авторская модель без каталожной карточки; открытая main_hand её пропускает.
    keys.insert("net");
    keys.extend(ARMOR_MODEL_KEYS);
    keys.extend(MISC_MODEL_KEYS);
    keys.extend(FOCUS_MODEL_KEYS);
    keys.extend(INSTRUMENT_MODEL_KEYS);
    keys
});

static SLOT_MODEL_KEYS: LazyLock<IndexMap<&'static str, IndexSet<&'static str>>> = LazyLock::new(|| {
    let mut main_hand: IndexSet<&str> = IndexSet::new();
    main_hand.extend(WEAPON_MODEL_KEYS);
    main_hand.insert("wand");
    main_hand.insert("net");
    main_hand.extend(FOCUS_MODEL_KEYS.iter().filter(|key| !["holy-amulet", "holy-emblem"].contains(key)));
    main_hand.extend(INSTRUMENT_MODEL_KEYS);
    let mut slots = IndexMap::new();
    slots.insert("body", ARMOR_MODEL_KEYS.into_iter().collect());
    slots.insert("main_hand", main_hand);
    slots.insert("off_hand", ["shield", "holy-emblem"].into_iter().collect());
    slots.insert("focus", ["holy-amulet"].into_iter().collect());
    slots.insert("cloak", ["cloak"].into_iter().collect());
    slots.insert("brooch", ["brooch"].into_iter().collect());
    slots.insert("ring-protection", ["ring"].into_iter().collect());
    slots.insert("ring-fire-resistance", ["ring"].into_iter().collect());
    slots
});

/// Модель каталожного предмета: слот, ключ модели, вариант материала.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VisualDescriptor {
    pub slot: &'static str,
    pub model_key: &'static str,
    pub variant: &'static str,
}

const fn descriptor(slot: &'static str, model_key: &'static str, variant: &'static str) -> VisualDescriptor {
    VisualDescriptor { slot, model_key, variant }
}

const NAMED_ITEMS: [(&str, VisualDescriptor); 35] = [
    ("srd_5_2_1:padded-armor", descriptor("body", "armor-padded", "default")),
    ("srd_5_2_1:leather-armor", descriptor("body", "armor-leather", "default")),
    ("srd_5_2_1:studded-leather-armor", descriptor("body", "armor-studded", "default")),
    ("srd_5_2_1:hide-armor", descriptor("body", "armor-hide", "default")),
    ("srd_5_2_1:chain-shirt", descriptor("body", "armor-chainshirt", "default")),
    ("srd_5_2_1:scale-mail", descriptor("body", "armor-scalemail", "default")),
    ("srd_5_2_1:breastplate", descriptor("body", "armor-breastplate", "default")),
    ("srd_5_2_1:half-plate-armor", descriptor("body", "armor-halfplate", "default")),
    ("srd_5_2_1:ring-mail", descriptor("body", "armor-ringmail", "default")),
    ("srd_5_2_1:chain-mail", descriptor("body", "armor-chainmail", "default")),
    ("srd_5_2_1:splint-armor", descriptor("body", "armor-splint", "default")),
    ("srd_5_2_1:plate-armor", descriptor("body", "armor-plate", "default")),
    ("srd_5_2_1:shield", descriptor("off_hand", "shield", "default")),
    ("srd_5_2_1:arcane-focus-crystal", descriptor("main_hand", "arcane-crystal", "default")),
    ("srd_5_2_1:arcane-focus-orb", descriptor("main_hand", "arcane-orb", "default")),
    ("srd_5_2_1:arcane-focus-rod", descriptor("main_hand", "arcane-rod", "default")),
    ("srd_5_2_1:arcane-focus-staff", descriptor("main_hand", "quarterstaff", "default")),
    ("srd_5_2_1:arcane-focus-wand", descriptor("main_hand", "wand", "default")),
    ("srd_5_2_1:druidic-focus-mistletoe", descriptor("main_hand", "druidic-mistletoe", "default")),
    ("srd_5_2_1:druidic-focus-totem", descriptor("main_hand", "druidic-totem", "default")),
    ("srd_5_2_1:druidic-focus-wooden-staff", descriptor("main_hand", "quarterstaff", "default")),
    ("srd_5_2_1:druidic-focus-yew-wand", descriptor("main_hand", "wand", "default")),
    ("srd_5_2_1:holy-symbol-amulet", descriptor("focus", "holy-amulet", "default")),
    ("srd_5_2_1:holy-symbol-emblem", descriptor("off_hand", "holy-emblem", "default")),
    ("srd_5_2_1:holy-symbol-reliquary", descriptor("main_hand", "holy-reliquary", "default")),
    // Инструменты вставляются здесь (см. `ITEM_VISUALS`).
    ("srd_5_2_1:cloak-of-protection", descriptor("cloak", "cloak", "enchanted")),
    ("srd_5_2_1:ring-of-protection", descriptor("ring-protection", "ring", "enchanted")),
    ("srd_5_2_1:ring-of-fire-resistance", descriptor("ring-fire-resistance", "ring", "enchanted")),
    ("srd_5_2_1:brooch-of-shielding", descriptor("brooch", "brooch", "enchanted")),
    ("srd_5_2_1:wand-of-magic-missiles", descriptor("main_hand", "wand", "enchanted")),
    // Магические варианты используют ту же геометрию, но сохраняют семантику
    // варианта для материала и эффекта в клиентском композиторе.
    ("srd_5_2_1:longsword-plus-1", descriptor("main_hand", "longsword", "enchanted")),
    ("srd_5_2_1:weapon-of-warning-longsword", descriptor("main_hand", "longsword", "enchanted")),
    ("srd_5_2_1:vicious-longsword", descriptor("main_hand", "longsword", "enchanted")),
    ("srd_5_2_1:flame-tongue-longsword", descriptor("main_hand", "longsword", "flaming")),
    ("srd_5_2_1:adamantine-chain-mail", descriptor("body", "armor-chainmail", "adamantine")),
];

/// Каталог визуальной экипировки (`EQUIPMENT_ITEM_VISUALS`): 83 записи в
/// порядке объявления JS.
pub static EQUIPMENT_ITEM_VISUALS: LazyLock<IndexMap<String, VisualDescriptor>> = LazyLock::new(|| {
    let mut visuals = IndexMap::new();
    for key in WEAPON_MODEL_KEYS {
        visuals.insert(format!("{CATALOG_PREFIX}{key}"), descriptor("main_hand", key, "default"));
    }
    for (index, (catalog_id, visual)) in NAMED_ITEMS.iter().enumerate() {
        // Инструменты в JS стоят после священных символов.
        if index == 25 {
            for key in INSTRUMENT_MODEL_KEYS {
                visuals.insert(format!("{CATALOG_PREFIX}{key}"), descriptor("main_hand", key, "default"));
            }
        }
        visuals.insert(catalog_id.to_string(), *visual);
    }
    visuals
});

/// Закрытый словарь ключей моделей по алфавиту (`EQUIPMENT_VISUAL_MODEL_KEYS`).
pub static EQUIPMENT_VISUAL_MODEL_KEYS: LazyLock<Vec<&'static str>> = LazyLock::new(|| {
    let mut keys: Vec<&str> = MODEL_KEYS.iter().copied().collect();
    keys.sort_unstable();
    keys
});

/// Только точные имена, которые были однозначны в старых сохранениях. Общие
/// «меч», «лук» и «арбалет» сюда не входят.
const LEGACY_NAME_MODELS: [(&str, &str, &str); 57] = [
    ("длинный меч", "main_hand", "longsword"),
    ("longsword", "main_hand", "longsword"),
    ("короткий меч", "main_hand", "shortsword"),
    ("shortsword", "main_hand", "shortsword"),
    ("скимитар", "main_hand", "scimitar"),
    ("scimitar", "main_hand", "scimitar"),
    ("рапира", "main_hand", "rapier"),
    ("rapier", "main_hand", "rapier"),
    ("кинжал", "main_hand", "dagger"),
    ("dagger", "main_hand", "dagger"),
    ("сеть", "main_hand", "net"),
    ("net", "main_hand", "net"),
    ("длинный лук", "main_hand", "longbow"),
    ("longbow", "main_hand", "longbow"),
    ("короткий лук", "main_hand", "shortbow"),
    ("shortbow", "main_hand", "shortbow"),
    ("боевой посох", "main_hand", "quarterstaff"),
    ("quarterstaff", "main_hand", "quarterstaff"),
    ("посох", "main_hand", "quarterstaff"),
    ("дубинка", "main_hand", "club"),
    ("club", "main_hand", "club"),
    ("большая дубинка", "main_hand", "greatclub"),
    ("greatclub", "main_hand", "greatclub"),
    ("ручной топор", "main_hand", "handaxe"),
    ("handaxe", "main_hand", "handaxe"),
    ("копье", "main_hand", "spear"),
    ("копьё", "main_hand", "spear"),
    ("spear", "main_hand", "spear"),
    ("булава", "main_hand", "mace"),
    ("mace", "main_hand", "mace"),
    ("лёгкий молот", "main_hand", "light-hammer"),
    ("легкий молот", "main_hand", "light-hammer"),
    ("light hammer", "main_hand", "light-hammer"),
    ("боевой молот", "main_hand", "warhammer"),
    ("warhammer", "main_hand", "warhammer"),
    ("молот", "main_hand", "maul"),
    ("maul", "main_hand", "maul"),
    ("щит", "off_hand", "shield"),
    ("shield", "off_hand", "shield"),
    ("кожаный доспех", "body", "armor-leather"),
    ("стёганый доспех", "body", "armor-padded"),
    ("стеганый доспех", "body", "armor-padded"),
    ("клёпаный кожаный доспех", "body", "armor-studded"),
    ("клепаный кожаный доспех", "body", "armor-studded"),
    ("шкурный доспех", "body", "armor-hide"),
    ("кольчужная рубаха", "body", "armor-chainshirt"),
    ("чешуйчатый доспех", "body", "armor-scalemail"),
    ("кираса", "body", "armor-breastplate"),
    ("breastplate", "body", "armor-breastplate"),
    ("полулаты", "body", "armor-halfplate"),
    ("half plate", "body", "armor-halfplate"),
    ("кольчатый доспех", "body", "armor-ringmail"),
    ("кольчуга", "body", "armor-chainmail"),
    ("chain mail", "body", "armor-chainmail"),
    ("ламеллярный доспех", "body", "armor-splint"),
    ("латы", "body", "armor-plate"),
    ("plate", "body", "armor-plate"),
];

const PRIVATE_KEYS: [&str; 8] = ["hidden", "private", "gm_only", "npc_private", "secret", "unrevealed", "private_notes", "gm_notes"];
const VISIBILITY_KEYS: [&str; 3] = ["visibility", "visibility_level", "visibilityLevel"];

/// `String(value ?? '').normalize('NFKC').trim().slice(0, maximum)`.
fn clean(value: Option<&Value>, maximum: usize) -> String {
    utf16_head(text::trim(&text::nfkc(&str_of(value))), maximum).to_string()
}

fn normalized_legacy_name(value: Option<&Value>) -> String {
    text::replace_all(re!(r"\s+", "gu"), &text::lower(&clean(value, 160)), " ")
}

fn public_visual_record(value: &Value) -> bool {
    let Value::Object(record) = value else { return false };
    let declared = VISIBILITY_KEYS
        .iter()
        .filter(|key| js::present(record.get(**key)))
        .map(|key| text::lower(&clean(record.get(*key), 40)));
    if declared.into_iter().any(|visibility| visibility != "public" && visibility != "party") {
        return false;
    }
    !PRIVATE_KEYS.iter().any(|key| js::truthy(record.get(*key)))
}

/// `descriptorForSlot(slot, value)`: `{ model_key }` или `{ model_key, variant }`,
/// `None` — `null`.
fn descriptor_for_slot(slot: &str, value: &Value) -> Option<Value> {
    let Value::Object(record) = value else { return None };
    let model_key = normalize_equipment_model_key(nullish(record.get("model_key"), record.get("modelKey")))?;
    let variant = normalize_equipment_visual_variant(record.get("variant"))?;
    if !SLOT_MODEL_KEYS.get(slot).is_some_and(|keys| keys.contains(model_key.as_str())) {
        return None;
    }
    let mut result = Map::new();
    result.insert("model_key".into(), Value::String(model_key));
    if variant != "default" {
        result.insert("variant".into(), Value::String(variant));
    }
    Some(Value::Object(result))
}

/// Приводит слот к закрытому публичному словарю.
pub fn normalize_equipment_visual_slot(value: Option<&Value>) -> Option<&'static str> {
    let slot = clean(value, 40);
    EQUIPMENT_VISUAL_SLOTS.iter().copied().find(|known| *known == slot)
}

/// Приводит вариант материала к закрытому словарю; пустой — `default`.
pub fn normalize_equipment_visual_variant(value: Option<&Value>) -> Option<String> {
    normalize_equipment_visual_variant_or(value, Some("default"))
}

/// `normalizeEquipmentVisualVariant(value, fallback)` с явным запасом для
/// пустого значения (`None` — `null`).
pub fn normalize_equipment_visual_variant_or(value: Option<&Value>, fallback: Option<&str>) -> Option<String> {
    let variant = clean(value, 40);
    if variant.is_empty() {
        return fallback.map(String::from);
    }
    EQUIPMENT_VISUAL_VARIANTS.contains(&variant.as_str()).then_some(variant)
}

/// Приводит ключ модели к закрытому локальному словарю.
pub fn normalize_equipment_model_key(value: Option<&Value>) -> Option<String> {
    let model_key = clean(value, 80);
    MODEL_KEYS.contains(model_key.as_str()).then_some(model_key)
}

/// Видимая модель предмета: слот, ключ модели, вариант (кроме `default`).
///
/// Все поля пусты только у «модели» по унаследованному свойству объекта JS
/// (`ITEM_VISUALS.constructor`): в JS это объект с `undefined` вместо полей.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct ItemVisual {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slot: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
}

impl ItemVisual {
    /// Форма JSON, которую пишет JS.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

/// Модель каталожного предмета; `None` — предмет не известен этому выпуску
/// визуального каталога.
pub fn item_visual_for_catalog_id(catalog_id: Option<&Value>) -> Option<ItemVisual> {
    let key = clean(catalog_id, 120);
    match EQUIPMENT_ITEM_VISUALS.get(&key) {
        Some(visual) => Some(ItemVisual {
            slot: Some(visual.slot.into()),
            model_key: Some(visual.model_key.into()),
            variant: (visual.variant != "default").then(|| visual.variant.into()),
        }),
        // Обычный объект JS находит по такому ключу функцию из прототипа.
        None if is_prototype_key(&key) => Some(ItemVisual::default()),
        None => None,
    }
}

/// Псевдоним с более явным именем (`equipmentVisualForCatalogId`).
pub fn equipment_visual_for_catalog_id(catalog_id: Option<&Value>) -> Option<ItemVisual> {
    item_visual_for_catalog_id(catalog_id)
}

/// Видимая модель надетой вещи до приведения к публичному описанию; у
/// самодельной вещи модели нет (`model_key: null`).
struct WornVisual {
    slot: Option<String>,
    model_key: Option<String>,
    variant: Option<String>,
}

fn legacy_visual_for_item(item: &Value) -> Option<WornVisual> {
    let name = normalized_legacy_name(item.get("name"));
    if let Some((_, slot, model_key)) = LEGACY_NAME_MODELS.iter().find(|(known, _, _)| *known == name) {
        return Some(WornVisual { slot: Some(slot.to_string()), model_key: Some(model_key.to_string()), variant: Some("default".into()) });
    }
    if is_prototype_key(&name) {
        // `LEGACY_NAME_MODELS.constructor` — функция без слота.
        return Some(WornVisual { slot: None, model_key: None, variant: None });
    }
    // Запасной слот: открытая самодельная вещь честно показывает `null`.
    let kind = item.get("type").and_then(Value::as_str);
    if kind == Some("weapon") && js::is_plain(item.get("combat")) {
        return Some(WornVisual { slot: Some("main_hand".into()), model_key: None, variant: None });
    }
    if kind == Some("armor") {
        return Some(WornVisual { slot: Some("body".into()), model_key: None, variant: None });
    }
    None
}

fn visual_for_item(item: &Value) -> Option<WornVisual> {
    if let Some(catalog) = item_visual_for_catalog_id(nullish(item.get("catalog_id"), item.get("catalogId"))) {
        let variant = catalog.variant.clone().unwrap_or_else(|| "default".into());
        let mut visual = WornVisual { slot: catalog.slot, model_key: catalog.model_key, variant: catalog.variant };
        if js::is_false(item.get("identified")) && variant != "default" {
            visual.variant = Some("default".into());
        } else if variant == "flaming" && !js::is_true(item.get("activated")) {
            visual.variant = Some("enchanted".into());
        }
        return Some(visual);
    }
    legacy_visual_for_item(item)
}

/// Публичная `loadout` экипированных слотов. Вход — уже разрешённый
/// инвентарь; публичность каждой записи проверяется ещё раз.
/// `additional_equipped` — вещи, которые считаются надетыми.
pub fn public_loadout_for_items(items: &Value, additional_equipped: Option<&Value>) -> Map<String, Value> {
    let mut by_id: IndexMap<String, Value> = IndexMap::new();
    if let Value::Array(list) = items {
        for item in list.iter().filter(|item| item.is_object()) {
            by_id.insert(clean(nullish(item.get("id"), item.get("item_id")), 120), item.clone());
        }
    }
    if let Some(Value::Array(list)) = additional_equipped {
        for item in list.iter().filter(|item| item.is_object()) {
            let id = clean(nullish(item.get("id"), item.get("item_id")), 120);
            if !id.is_empty() {
                by_id.insert(id, js::spread(item, serde_json::json!({ "equipped": true })));
            }
        }
    }
    let mut loadout = Map::new();
    for item in by_id.values() {
        if !js::is_true(item.get("equipped")) || !public_visual_record(item) {
            continue;
        }
        let Some(visual) = visual_for_item(item) else { continue };
        let Some(slot) = visual.slot.clone().filter(|slot| !slot.is_empty()) else { continue };
        if loadout.contains_key(&slot) {
            // Два предмета одного слота: зритель не выбирает произвольно.
            loadout.insert(slot, Value::Null);
            continue;
        }
        let described = match visual.model_key.as_deref().filter(|key| !key.is_empty()) {
            Some(model_key) => {
                let mut record = Map::new();
                record.insert("slot".into(), Value::String(slot.clone()));
                record.insert("model_key".into(), Value::String(model_key.into()));
                if let Some(variant) = &visual.variant {
                    record.insert("variant".into(), Value::String(variant.clone()));
                }
                descriptor_for_slot(&slot, &Value::Object(record)).unwrap_or(Value::Null)
            }
            None => Value::Null,
        };
        loadout.insert(slot, described);
    }
    loadout
}

/// Нормализует публичную `loadout` из состояния: без неизвестных слотов, URL,
/// id предметов и лишних полей.
pub fn normalize_public_loadout(value: Option<&Value>) -> Map<String, Value> {
    let mut result = Map::new();
    let Some(Value::Object(source)) = value else { return result };
    for slot in EQUIPMENT_VISUAL_SLOTS {
        let Some(raw) = source.get(slot) else { continue };
        let normalized = if raw.is_null() { Value::Null } else { descriptor_for_slot(slot, raw).unwrap_or(Value::Null) };
        result.insert(slot.to_string(), normalized);
    }
    result
}

/// Закрытый набор ключей моделей слота по алфавиту; неизвестный слот — пусто.
pub fn model_keys_for_equipment_slot(slot: Option<&Value>) -> Vec<&'static str> {
    let Some(slot) = normalize_equipment_visual_slot(slot) else { return Vec::new() };
    let mut keys: Vec<&str> = SLOT_MODEL_KEYS.get(slot).map(|keys| keys.iter().copied().collect()).unwrap_or_default();
    keys.sort_unstable();
    keys
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_has_83_entries() {
        assert_eq!(EQUIPMENT_ITEM_VISUALS.len(), 83);
        assert_eq!(EQUIPMENT_VISUAL_MODEL_KEYS.len(), MODEL_KEYS.len());
    }
}

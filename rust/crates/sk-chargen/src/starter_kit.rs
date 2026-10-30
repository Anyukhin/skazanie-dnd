//! Стартовое снаряжение героя — перенос `server/starter-kit.mjs`.
//!
//! Новый герой без инвентаря получает набор своего класса и предыстории:
//!
//! - **2014** — набор PHB из `data/starter-equipment-dnd-5e-2014.json`:
//!   policy v1 — прежний детерминированный набор, policy v2 — фиксированные
//!   вещи и выбор групп снаряжения, проверенный сервером; полный режим
//!   (`complete`, или `phbCreation.schema_version === 1`) раскрывает «любое
//!   простое/воинское оружие» до таблиц PHB и даёт физический набор предыстории;
//! - **2024** — вариант A класса из SRD 5.2.1, если событие создания несёт
//!   метку [`STARTER_KIT_2024_POLICY`]; прежние события в replay получают
//!   прежний набор «оружие, кожаный доспех, щит».
//!
//! Импортированные листы с инвентарём, деньгами и характеристиками остаются как
//! есть: дополняется только недостающее.
//!
//! Этап паритета (`rust/PORTING.md`): на границе — `serde_json::Value` той же
//! формы и с тем же порядком ключей, что у JS; исключения JS — [`StarterKitError`].

use std::collections::HashSet;
use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::indexmap::IndexMap;
use sk_core::{js, re, text};
use sk_items::item_catalog::{ammunition_catalog_id_for_weapon, catalog_item, materialize_catalog_item};
use sk_ruleset::backgrounds::background_by_id;
use sk_ruleset::character_creation_class_options::{PHB_2014_ARTISAN_TOOLS, PHB_2014_GAMING_SETS, PHB_2014_MUSICAL_INSTRUMENTS};
use sk_ruleset::ruleset_config::{DND_2014_RULESET_ID, LEGACY_DEFAULT_RULESET_ID};

use crate::support::{array, coalesce, field, js_ordered, nullish, own_entries, path, slice_end, spread, string, template, utf16_head};

/// Исключение JS-модуля.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StarterKitError {
    /// `TypeError`, который бросает сам модуль (неизвестный предмет набора,
    /// неверный выбор снаряжения); текст — как в JS.
    #[error("{0}")]
    Type(String),
    /// `TypeError` рантайма JS на мусоре во входе (поле `null`, распаковка
    /// неитерируемого); текст — как у V8.
    #[error("{0}")]
    Runtime(String),
}

type KitResult<T> = Result<T, StarterKitError>;

const STARTING_GOLD: i64 = 20;

static CLASSIC_EQUIPMENT: LazyLock<Value> =
    LazyLock::new(|| serde_json::from_str(include_str!("../../../../data/starter-equipment-dnd-5e-2014.json")).expect("data/starter-equipment-dnd-5e-2014.json — JSON"));

static STARTER_PRESENTATION: LazyLock<Value> =
    LazyLock::new(|| serde_json::from_str(include_str!("../../../../data/starter-item-presentation.json")).expect("data/starter-item-presentation.json — JSON"));

static EMPTY: LazyLock<Value> = LazyLock::new(js::obj);

fn classic() -> &'static Value {
    &CLASSIC_EQUIPMENT
}

fn classic_policy_version() -> Value {
    classic().get("policy_version").cloned().unwrap_or(Value::Null)
}

/// `classicClassProfiles.get(key)`: `Map` по `class_id`, ключ сравнивается
/// без приведения (число `5` не находит профиль `"5"`), повтор id — последний.
fn classic_class_profile(key: Option<&Value>) -> Option<&'static Value> {
    let Some(Value::String(key)) = key else {
        return None;
    };
    array(classic().get("classes")).iter().rev().find(|entry| matches!(entry.get("class_id"), Some(Value::String(id)) if id == key))
}

/// `classicClassProfiles.get(String(classId ?? ''))`.
fn classic_class_profile_by_string(class_id: Option<&Value>) -> Option<&'static Value> {
    classic_class_profile(Some(&Value::String(string(class_id))))
}

// PHB 2014 разрешает несколько вариантов «любого оружия». Старый policy v2
// оставляет короткий allowlist для совместимости, а complete-режим расширяет
// ровно эти группы до базовых таблиц оружия PHB. Мушкеты, пистолеты и прочие
// не относящиеся к PHB записи намеренно сюда не попадают.
const PHB_SIMPLE_MELEE_WEAPONS: [&str; 10] = ["club", "dagger", "greatclub", "handaxe", "javelin", "light-hammer", "mace", "quarterstaff", "sickle", "spear"];
const PHB_SIMPLE_RANGED_WEAPONS: [&str; 4] = ["light-crossbow", "dart", "shortbow", "sling"];
const PHB_MARTIAL_MELEE_WEAPONS: [&str; 18] = [
    "battleaxe", "flail", "glaive", "greataxe", "greatsword", "halberd", "lance", "longsword", "maul", "morningstar", "pike", "rapier", "scimitar", "shortsword", "trident",
    "warhammer", "war-pick", "whip",
];
const PHB_MARTIAL_RANGED_WEAPONS: [&str; 5] = ["blowgun", "hand-crossbow", "heavy-crossbow", "longbow", "net"];

fn phb_simple_weapons() -> Vec<&'static str> {
    PHB_SIMPLE_MELEE_WEAPONS.iter().chain(PHB_SIMPLE_RANGED_WEAPONS.iter()).copied().collect()
}

fn phb_martial_weapons() -> Vec<&'static str> {
    PHB_MARTIAL_MELEE_WEAPONS.iter().chain(PHB_MARTIAL_RANGED_WEAPONS.iter()).copied().collect()
}

/// `PHB_MISSING_ITEMS`: сети нет в небольшом серверном item-catalog. Она всё
/// равно является обычным оружием PHB, поэтому complete-режим материализует её
/// как безопасную описательную вещь с правильным типом, количеством и весом.
fn phb_missing_item(catalog_id: &str) -> Option<Value> {
    (catalog_id == "srd_5_2_1:net").then(|| {
        json!({ "name": "Сеть", "type": "weapon", "weight": 3, "mechanics_status": "partial", "description": "Специальное метательное оружие PHB 2014." })
    })
}

/// `COMPLETE_CLASS_DYNAMIC_GROUPS[classId]` — запасная таблица, если в данных
/// нет `complete_classes[].dynamic_groups`.
fn complete_class_dynamic_groups(class_id: &str) -> Option<Value> {
    let groups = match class_id {
        "barbarian" => json!({ "primary-weapon": "martial-melee", "secondary-weapon": "simple" }),
        "bard" => json!({ "weapon": "simple", "instrument": "musical" }),
        "cleric" => json!({ "ranged-or-simple": "simple" }),
        "druid" => json!({ "defense": "simple", "weapon": "simple-melee" }),
        "fighter" => json!({ "melee-loadout": "fighter-melee" }),
        "monk" => json!({ "weapon": "simple" }),
        "paladin" => json!({ "melee-loadout": "paladin-melee", "secondary": "simple-melee" }),
        "ranger" => json!({ "melee": "two-simple-melee" }),
        "sorcerer" => json!({ "weapon": "simple" }),
        "warlock" => json!({ "ranged": "simple", "melee": "simple" }),
        "wizard" => json!({ "weapon": "simple" }),
        _ => return None,
    };
    Some(groups)
}

/// `NARRATIVE_ITEM_DEFAULTS`: вес, тип и содержимое описательных вещей полного набора.
static NARRATIVE_ITEM_DEFAULTS: LazyLock<Map<String, Value>> = LazyLock::new(|| {
    let value = json!({
        "Набор дипломата": { "type": "pack", "weight": 35, "contents": [{ "name": "Сундук", "quantity": 1, "weight": 25 }, { "name": "Футляр для карт или свитков", "quantity": 2, "weight": 2 }, { "name": "Парадная одежда", "quantity": 1, "weight": 6 }, { "name": "Чернила", "quantity": 1, "weight": 0 }, { "name": "Перо", "quantity": 1, "weight": 0 }, { "name": "Масло", "quantity": 2, "weight": 2 }, { "name": "Бумага", "quantity": 5, "weight": 0 }, { "name": "Духи", "quantity": 1, "weight": 0 }, { "name": "Воск", "quantity": 1, "weight": 0 }, { "name": "Мыло", "quantity": 1, "weight": 0 }] },
        "Набор артиста": { "type": "pack", "weight": 38, "contents": [{ "name": "Рюкзак", "quantity": 1, "weight": 5 }, { "name": "Спальный мешок", "quantity": 1, "weight": 7 }, { "name": "Костюм", "quantity": 2, "weight": 8 }, { "name": "Свеча", "quantity": 5, "weight": 0 }, { "name": "Сухой паёк, 1 день", "quantity": 5, "weight": 10 }, { "name": "Бурдюк", "quantity": 1, "weight": 5 }, { "name": "Набор для грима", "quantity": 1, "weight": 3 }] },
        "Набор священника": { "type": "pack", "weight": 24, "contents": [{ "name": "Рюкзак", "quantity": 1, "weight": 5 }, { "name": "Одеяло", "quantity": 1, "weight": 3 }, { "name": "Свеча", "quantity": 10, "weight": 0 }, { "name": "Огниво", "quantity": 1, "weight": 1 }, { "name": "Ящик для пожертвований", "quantity": 1, "weight": 1 }, { "name": "Благовония", "quantity": 2, "weight": 0 }, { "name": "Кадило", "quantity": 1, "weight": 0 }, { "name": "Облачение", "quantity": 1, "weight": 4 }, { "name": "Сухой паёк, 1 день", "quantity": 2, "weight": 4 }, { "name": "Бурдюк", "quantity": 1, "weight": 5 }] },
        "Набор исследователя подземелий": { "type": "pack", "weight": 56.5, "contents": [{ "name": "Рюкзак", "quantity": 1, "weight": 5 }, { "name": "Лом", "quantity": 1, "weight": 5 }, { "name": "Молоток", "quantity": 1, "weight": 3 }, { "name": "Питон", "quantity": 10, "weight": 2.5 }, { "name": "Факел", "quantity": 10, "weight": 10 }, { "name": "Огниво", "quantity": 1, "weight": 1 }, { "name": "Сухой паёк, 1 день", "quantity": 10, "weight": 20 }, { "name": "Бурдюк", "quantity": 1, "weight": 5 }, { "name": "Пеньковая верёвка, 50 футов", "quantity": 1, "weight": 5 }] },
        "Набор учёного": { "type": "pack", "weight": 12, "contents": [{ "name": "Рюкзак", "quantity": 1, "weight": 5 }, { "name": "Книга знаний", "quantity": 1, "weight": 5 }, { "name": "Чернила", "quantity": 1, "weight": 0 }, { "name": "Перо", "quantity": 1, "weight": 0 }, { "name": "Пергамент", "quantity": 10, "weight": 0 }, { "name": "Маленький мешок песка", "quantity": 1, "weight": 1 }, { "name": "Маленький нож", "quantity": 1, "weight": 1 }] },
        "Мешочек с компонентами": { "type": "focus", "weight": 2, "mechanics_status": "partial" },
        "Магическая фокусировка": { "type": "focus", "weight": 1, "mechanics_status": "partial" },
        "Книга заклинаний": { "type": "book", "weight": 3, "mechanics_status": "partial" },
        "Священный символ": { "type": "focus", "weight": 1, "mechanics_status": "partial" },
        "Друидический фокус": { "type": "focus", "weight": 1, "mechanics_status": "partial" },
        "Воровские инструменты": { "type": "tool", "weight": 1, "mechanics_status": "partial" },
    });
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
});

/// `narrativeItemPresentation(name)`: рисунок и описание описательной вещи из
/// `data/starter-item-presentation.json`; `name` — уже `String(name ?? '')`.
fn narrative_item_presentation(name: &str) -> &'static Value {
    match STARTER_PRESENTATION.get("items").and_then(|items| items.get(name)) {
        Some(entry @ Value::Object(_)) => entry,
        _ => &EMPTY,
    }
}

/// `PHB_PACK_CONTENTS[catalogId]`.
fn phb_pack_contents(catalog_id: &str) -> Option<Value> {
    (catalog_id == "srd_5_2_1:explorers-pack").then(|| {
        json!([
            { "name": "Рюкзак", "quantity": 1, "weight": 5 }, { "name": "Спальный мешок", "quantity": 1, "weight": 7 }, { "name": "Кухонная утварь", "quantity": 1, "weight": 1 },
            { "name": "Огниво", "quantity": 1, "weight": 1 }, { "name": "Факел", "quantity": 10, "weight": 10 }, { "name": "Сухой паёк, 1 день", "quantity": 10, "weight": 20 },
            { "name": "Бурдюк", "quantity": 1, "weight": 5 }, { "name": "Пеньковая верёвка, 50 футов", "quantity": 1, "weight": 5 },
        ])
    })
}

const PHB_TOOL_WEIGHTS: [(&str, f64); 22] = [
    ("bagpipes", 6.0), ("drum", 3.0), ("dulcimer", 10.0), ("flute", 1.0), ("lute", 2.0), ("lyre", 2.0), ("horn", 2.0), ("pan_flute", 2.0), ("shawm", 1.0), ("viol", 1.0),
    ("dice_set", 0.0), ("dragonchess", 0.5), ("playing_cards", 0.0), ("three_dragon_ante", 0.0),
    ("disguise_kit", 3.0), ("forgery_kit", 5.0), ("herbalism_kit", 3.0), ("navigators_tools", 2.0), ("poisoners_kit", 2.0), ("thieves_tools", 1.0),
    ("vehicles_land", 0.0), ("vehicles_water", 0.0),
];

const PHB_TOOL_NAMES: [(&str, &str); 22] = [
    ("bagpipes", "Волынка"), ("drum", "Барабан"), ("dulcimer", "Цимбалы"), ("flute", "Флейта"), ("lute", "Лютня"), ("lyre", "Лира"), ("horn", "Рожок"), ("pan_flute", "Свирель"), ("shawm", "Шалмей"), ("viol", "Виола"),
    ("dice_set", "Набор костей"), ("dragonchess", "Набор драконьих шахмат"), ("playing_cards", "Набор игральных карт"), ("three_dragon_ante", "Набор «Ставка трёх драконов»"),
    ("disguise_kit", "Набор для грима"), ("forgery_kit", "Набор для подделок"), ("herbalism_kit", "Набор травника"), ("navigators_tools", "Инструменты навигатора"), ("poisoners_kit", "Инструменты отравителя"), ("thieves_tools", "Воровские инструменты"),
    ("vehicles_land", "Наземный транспорт"), ("vehicles_water", "Водный транспорт"),
];

fn phb_tool_catalog_id(tool_id: &str) -> Option<String> {
    let catalog_id = format!("srd_5_2_1:{}", tool_id.replace('_', "-"));
    catalog_item(&catalog_id).is_some().then_some(catalog_id)
}

fn phb_tool_option(tool_id: &str, kind: &str) -> Value {
    let catalog_id = phb_tool_catalog_id(tool_id);
    let name = catalog_id
        .as_deref()
        .and_then(catalog_item)
        .and_then(|entry| entry.get("name"))
        .filter(|name| js::present(Some(name)))
        .cloned()
        .or_else(|| PHB_TOOL_NAMES.iter().find(|(id, _)| *id == tool_id).map(|(_, name)| json!(name)))
        .unwrap_or_else(|| json!(tool_id));
    let weight = PHB_TOOL_WEIGHTS.iter().find(|(id, _)| *id == tool_id).map_or(0.0, |(_, weight)| *weight);
    let summary = format!("{} · {} фнт", template(Some(&name)), js::f64_string(weight));
    match catalog_id {
        Some(catalog_id) => json!({ "id": tool_id, "label": name, "summary": summary, "items": [{ "catalog_id": catalog_id, "quantity": 1 }] }),
        None => json!({ "id": tool_id, "label": name.clone(), "summary": summary, "narrative_items": [{ "name": name, "type": "tool", "weight": js::num(weight), "quantity": 1, "proficiency": kind }] }),
    }
}

fn complete_background_choice_options(source: Option<&str>) -> Vec<Value> {
    match source {
        Some("musical") => PHB_2014_MUSICAL_INSTRUMENTS.iter().map(|id| phb_tool_option(id, "musical_instrument")).collect(),
        Some("artisan") => PHB_2014_ARTISAN_TOOLS.iter().map(|id| phb_tool_option(id, "artisan_tool")).collect(),
        Some("gaming") => PHB_2014_GAMING_SETS.iter().map(|id| phb_tool_option(id, "gaming_set")).collect(),
        _ => Vec::new(),
    }
}

fn complete_background_profile(profile: Option<&Value>) -> Option<Value> {
    if !js::truthy(profile) {
        return None;
    }
    let background_id = field(profile, "background_id");
    let groups: Vec<Value> = array(field(profile, "choice_groups"))
        .iter()
        .map(|group| {
            let dynamic_source = group.get("dynamic_source");
            let mut options = if js::truthy(dynamic_source) {
                complete_background_choice_options(dynamic_source.and_then(Value::as_str))
            } else {
                array(group.get("options")).to_vec()
            };
            let musical = dynamic_source.and_then(Value::as_str) == Some("musical");
            let artisan = dynamic_source.and_then(Value::as_str) == Some("artisan");
            if background_id.and_then(Value::as_str) == Some("entertainer") && musical {
                for weapon in ["trident", "net"] {
                    if let Some(option) = phb_weapon_option(weapon, 1, false, &format!("gladiator-{weapon}")) {
                        let label = format!("Гладиатор: {}", template(option.get("label")));
                        options.push(spread(Some(&option), json!({ "label": label })));
                    }
                }
            }
            if background_id.and_then(Value::as_str) == Some("guild-artisan") && artisan {
                options.push(json!({
                    "id": "guild-merchant-mule-cart", "label": "Гильдейский торговец: мул и повозка",
                    "owned_assets": [{ "id": "mule", "name": "Мул", "type": "mount", "quantity": 1 }, { "id": "cart", "name": "Повозка", "type": "vehicle", "quantity": 1 }],
                }));
            }
            spread(Some(group), json!({ "options": options }))
        })
        .collect();
    Some(spread(profile, json!({ "choice_groups": groups })))
}

/// Шаблон стартового оружия прежнего набора (`WEAPONS`).
struct WeaponTemplate {
    catalog_id: &'static str,
    description: &'static str,
    properties: &'static str,
}

fn weapon_template(key: &str) -> &'static WeaponTemplate {
    const DAGGER: WeaponTemplate = WeaponTemplate {
        catalog_id: "srd_5_2_1:dagger",
        description: "Надёжный дорожный клинок из стартового снаряжения героя.",
        properties: "1к4 колющего урона · фехтовальное · лёгкое.",
    };
    const LONGSWORD: WeaponTemplate = WeaponTemplate {
        catalog_id: "srd_5_2_1:longsword",
        description: "Сбалансированный строевой клинок из стартового снаряжения героя.",
        properties: "1к8 рубящего урона · универсальное (1к10).",
    };
    const SHORTBOW: WeaponTemplate = WeaponTemplate {
        catalog_id: "srd_5_2_1:shortbow",
        description: "Компактный охотничий лук из стартового снаряжения героя.",
        properties: "1к6 колющего урона · дальность 80/320 фт · боеприпас · двуручное.",
    };
    match key {
        "longsword" => &LONGSWORD,
        "shortbow" => &SHORTBOW,
        _ => &DAGGER,
    }
}

/// Доспех и щит — из тех профилей, которые сервер действительно считает
/// (DEFAULT_ARMOR_PROFILES в character-lifecycle.mjs). Без них жрец и воин
/// выходили в первый бой с одним кинжалом и КД 12, как волшебник.
fn armour_template(key: &str) -> Option<WeaponTemplate> {
    match key {
        "leather" => Some(WeaponTemplate {
            catalog_id: "srd_5_2_1:leather-armor",
            description: "Лёгкий дорожный доспех из стартового снаряжения героя.",
            properties: "КД 11 + модификатор Ловкости · лёгкий доспех.",
        }),
        "shield" => Some(WeaponTemplate { catalog_id: "srd_5_2_1:shield", description: "Окованный щит из стартового снаряжения героя.", properties: "+2 к КД · занимает одну руку." }),
        _ => None,
    }
}

/// Профиль класса прежнего набора (`CLASS_PROFILES`): узнаётся по `characterClass`
/// или по слову в роли.
struct ClassProfile {
    key: &'static str,
    weapon: &'static str,
    gear: &'static [&'static str],
    abilities: [i64; 6],
}

const ABILITY_KEYS: [&str; 6] = ["str", "dex", "con", "int", "wis", "cha"];

const CLASS_PROFILES: [ClassProfile; 12] = [
    ClassProfile { key: "barbarian", weapon: "longsword", gear: &[], abilities: [16, 12, 15, 8, 10, 13] },
    ClassProfile { key: "fighter", weapon: "longsword", gear: &["leather", "shield"], abilities: [16, 12, 15, 10, 13, 8] },
    ClassProfile { key: "paladin", weapon: "longsword", gear: &["leather", "shield"], abilities: [16, 10, 14, 8, 12, 15] },
    ClassProfile { key: "ranger", weapon: "shortbow", gear: &["leather"], abilities: [10, 16, 14, 12, 15, 8] },
    ClassProfile { key: "rogue", weapon: "dagger", gear: &["leather"], abilities: [8, 16, 14, 13, 10, 15] },
    ClassProfile { key: "monk", weapon: "dagger", gear: &[], abilities: [10, 16, 14, 8, 15, 12] },
    ClassProfile { key: "cleric", weapon: "dagger", gear: &["leather", "shield"], abilities: [13, 10, 14, 8, 16, 15] },
    ClassProfile { key: "druid", weapon: "dagger", gear: &["leather"], abilities: [10, 13, 14, 12, 16, 8] },
    ClassProfile { key: "bard", weapon: "dagger", gear: &["leather"], abilities: [8, 14, 13, 12, 10, 16] },
    ClassProfile { key: "sorcerer", weapon: "dagger", gear: &[], abilities: [8, 14, 15, 10, 12, 16] },
    ClassProfile { key: "warlock", weapon: "dagger", gear: &["leather"], abilities: [8, 14, 15, 12, 10, 16] },
    ClassProfile { key: "wizard", weapon: "dagger", gear: &[], abilities: [8, 14, 13, 16, 15, 10] },
];

/// Слово роли, по которому узнаётся класс прежнего набора. Образцы — из JS
/// без правок (`маг\b` — граница ASCII-слова, см. «Замечено в JS» в отчёте).
fn class_pattern(key: &str) -> &'static sk_core::fancy_regex::Regex {
    match key {
        "barbarian" => re!(r"варвар|barbarian", "u"),
        "fighter" => re!(r"воин|fighter", "u"),
        "paladin" => re!(r"паладин|paladin", "u"),
        "ranger" => re!(r"следопыт|ranger", "u"),
        "rogue" => re!(r"плут|разбойник|rogue", "u"),
        "monk" => re!(r"монах|monk", "u"),
        "cleric" => re!(r"жрец|cleric", "u"),
        "druid" => re!(r"друид|druid", "u"),
        "bard" => re!(r"бард|bard", "u"),
        "sorcerer" => re!(r"чарод|sorcer", "u"),
        "warlock" => re!(r"колдун|warlock", "u"),
        _ => re!(r"волшеб|wizard|маг\b", "u"),
    }
}

fn profile_abilities(profile: &ClassProfile) -> Value {
    Value::Object(ABILITY_KEYS.iter().zip(profile.abilities).map(|(key, score)| ((*key).to_string(), Value::from(score))).collect())
}

/// Метка политики стартового набора 2024.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StarterKitPolicy {
    pub policy_id: &'static str,
    pub policy_version: i64,
}

impl StarterKitPolicy {
    /// Как объект JS.
    pub fn to_json(&self) -> Value {
        json!({ "policy_id": self.policy_id, "policy_version": self.policy_version })
    }
}

/// Стартовое снаряжение редакции 2024 — вариант A класса из SRD 5.2.1. Прежний
/// набор 2024 был упрощён до «оружие, кожаный доспех, щит»: жрец выходил с
/// кинжалом и КД 14, воин с КД 15, у заклинателей не было фокусировки (боевой
/// плейтест 2026-10-03). Компоненты заклинаний движок пока проверяет только в
/// редакции 2014, так что фокусировка здесь — снаряжение по правилам, а не
/// пропуск к заклинаниям.
///
/// Набор выдаётся событием создания героя, поэтому новая политика узнаётся по
/// метке в событии: прежние события в replay дают прежний набор. Золото остаётся
/// общим `STARTING_GOLD` — экономика стартовых кошельков здесь не меняется.
/// Строка набора: (идентификатор каталога, количество, надето). Предметы вне
/// каталога (наборы, колчан, воровские инструменты) — описательные.
pub const STARTER_KIT_2024_POLICY: StarterKitPolicy = StarterKitPolicy { policy_id: "srd_5_2_1:starter-equipment-option-a", policy_version: 1 };

struct Kit2024 {
    items: &'static [(&'static str, i64, bool)],
    gear: &'static [&'static str],
}

const KITS_2024: [(&str, Kit2024); 13] = [
    ("barbarian", Kit2024 { items: &[("greataxe", 1, true), ("handaxe", 4, false), ("explorers-pack", 1, false)], gear: &[] }),
    ("bard", Kit2024 { items: &[("leather-armor", 1, true), ("dagger", 2, true), ("lute", 1, false)], gear: &["Набор артиста"] }),
    ("cleric", Kit2024 { items: &[("chain-shirt", 1, true), ("shield", 1, true), ("mace", 1, true), ("holy-symbol-amulet", 1, true)], gear: &["Набор священника"] }),
    (
        "druid",
        Kit2024 {
            items: &[("leather-armor", 1, true), ("shield", 1, true), ("druidic-focus-wooden-staff", 1, true), ("sickle", 1, false), ("explorers-pack", 1, false), ("herbalism-kit", 1, false)],
            gear: &[],
        },
    ),
    ("fighter", Kit2024 { items: &[("chain-mail", 1, true), ("greatsword", 1, true), ("flail", 1, false), ("javelin", 8, false)], gear: &["Набор исследователя подземелий"] }),
    // Вариант B воина — для ловкого бойца: кольчуга без Силы 13 замедлила бы его.
    (
        "fighter-dex",
        Kit2024 {
            items: &[("studded-leather-armor", 1, true), ("longbow", 1, true), ("arrows-20", 1, false), ("scimitar", 1, false), ("shortsword", 1, false)],
            gear: &["Колчан", "Набор исследователя подземелий"],
        },
    ),
    ("monk", Kit2024 { items: &[("spear", 1, true), ("dagger", 5, false), ("explorers-pack", 1, false)], gear: &["Инструменты ремесленника"] }),
    ("paladin", Kit2024 { items: &[("chain-mail", 1, true), ("shield", 1, true), ("longsword", 1, true), ("javelin", 6, false), ("holy-symbol-amulet", 1, true)], gear: &["Набор священника"] }),
    (
        "ranger",
        Kit2024 {
            items: &[("studded-leather-armor", 1, true), ("longbow", 1, true), ("arrows-20", 1, false), ("scimitar", 1, false), ("shortsword", 1, false), ("druidic-focus-mistletoe", 1, false), ("explorers-pack", 1, false)],
            gear: &["Колчан"],
        },
    ),
    ("rogue", Kit2024 { items: &[("leather-armor", 1, true), ("shortsword", 1, true), ("dagger", 2, false), ("shortbow", 1, false), ("arrows-20", 1, false)], gear: &["Воровские инструменты", "Колчан", "Набор взломщика"] }),
    ("sorcerer", Kit2024 { items: &[("spear", 1, true), ("dagger", 2, false), ("arcane-focus-crystal", 1, true)], gear: &["Набор исследователя подземелий"] }),
    ("warlock", Kit2024 { items: &[("leather-armor", 1, true), ("sickle", 1, true), ("dagger", 2, false), ("arcane-focus-orb", 1, true)], gear: &["Книга оккультных знаний", "Набор учёного"] }),
    ("wizard", Kit2024 { items: &[("dagger", 2, true), ("arcane-focus-staff", 1, true)], gear: &["Мантия", "Книга заклинаний", "Набор учёного"] }),
];

/// Свойства `Object.prototype`, которые `KITS_2024[key]` в JS находит у любого объекта.
const OBJECT_PROTOTYPE_KEYS: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

/// Что находит `KITS_2024[key]` в JS.
enum KitLookup {
    Kit(&'static Kit2024),
    /// Свойство прототипа: истинное значение без `items` — JS падает на `kit.items.map`.
    Prototype,
    Missing,
}

fn kit_2024(key: &str) -> KitLookup {
    if let Some((_, kit)) = KITS_2024.iter().find(|(id, _)| *id == key) {
        KitLookup::Kit(kit)
    } else if OBJECT_PROTOTYPE_KEYS.contains(&key) {
        KitLookup::Prototype
    } else {
        KitLookup::Missing
    }
}

fn kit_2024_for(class_key: Option<&Value>, abilities: &Value) -> KitLookup {
    let score = |key: &str| js::number(nullish(field(Some(abilities), key), Some(&json!(10))));
    if class_key.and_then(Value::as_str) == Some("fighter") && score("dex") > score("str") {
        return kit_2024("fighter-dex");
    }
    kit_2024(&template(class_key))
}

/// `starterKit2024Preview(classKey)`: состав набора 2024 для мастера создания —
/// только показ: выдаёт набор событие создания, а выбора внутри варианта A нет.
/// Ловкий воин получит вариант B, о чём говорит подпись.
pub fn starter_kit_2024_preview(class_key: &str) -> Option<Value> {
    // Ключ прототипа в JS падает `TypeError` на `kit.items`; здесь — как неизвестный класс.
    let KitLookup::Kit(kit) = kit_2024(class_key) else {
        return None;
    };
    let summary = if class_key == "fighter" {
        "Вариант A из SRD 5.2.1. Если Ловкость выше Силы — вариант B: клёпаный кожаный доспех, длинный лук, стрелы, скимитар и короткий меч."
    } else {
        "Вариант A из SRD 5.2.1."
    };
    let fixed_items: Vec<Value> = kit
        .items
        .iter()
        .map(|(id, quantity, _)| {
            let catalog_id = format!("srd_5_2_1:{id}");
            let name = catalog_item(&catalog_id).and_then(|entry| entry.get("name")).filter(|name| js::present(Some(name))).cloned().unwrap_or_else(|| json!(id));
            json!({ "catalog_id": catalog_id, "name": name, "quantity": quantity })
        })
        .collect();
    let fixed_narrative_items: Vec<Value> = kit.gear.iter().map(|name| json!({ "name": name })).collect();
    Some(json!({
        "class_id": class_key,
        "policy_id": STARTER_KIT_2024_POLICY.policy_id,
        "summary": summary,
        "fixed_items": fixed_items,
        "fixed_narrative_items": fixed_narrative_items,
        "choice_groups": [],
    }))
}

fn kit_2024_inventory(hero_id: &str, kit: &Kit2024) -> KitResult<Vec<Value>> {
    let mut inventory = Vec::new();
    for (index, (id, quantity, equipped)) in kit.items.iter().enumerate() {
        let item = json!({ "catalog_id": format!("srd_5_2_1:{id}"), "quantity": quantity, "equipped": *equipped });
        inventory.push(classic_starter_item(hero_id, &item, index, "kit2024", false)?);
    }
    for (index, name) in kit.gear.iter().enumerate() {
        inventory.push(narrative_starter_item(hero_id, &json!({ "name": name }), index, "kit2024-gear", false));
    }
    Ok(inventory)
}

/// `Cannot read properties of null (reading 'key')` — `TypeError` рантайма JS.
fn null_read(key: &str) -> StarterKitError {
    StarterKitError::Runtime(format!("Cannot read properties of null (reading '{key}')"))
}

fn total_currency(currency: Option<&Value>) -> KitResult<f64> {
    if matches!(currency, Some(Value::Null)) {
        return Err(null_read("copper"));
    }
    let part = |key: &str| {
        let value = field(currency, key);
        if js::truthy(value) {
            js::number(value)
        } else {
            0.0
        }
    };
    Ok(part("copper") + part("silver") * 10.0 + part("gold") * 100.0 + part("platinum") * 1_000.0)
}

fn ability_scores_are_blank(abilities: Option<&Value>) -> KitResult<bool> {
    if matches!(abilities, Some(Value::Null)) {
        return Err(null_read("str"));
    }
    Ok(ABILITY_KEYS.iter().all(|key| js::number(nullish(field(abilities, key), Some(&json!(10)))) == 10.0))
}

/// Общий экземпляр прежнего набора: поля в том же порядке, что у JS, — от него
/// зависит порядок сохранённых полей экземпляра в `materializeCatalogItem`.
fn template_instance(id: String, template: &WeaponTemplate, equipped: bool) -> Value {
    json!({
        "id": id,
        "catalog_id": template.catalog_id,
        "description": template.description,
        "properties": template.properties,
        "quantity": 1,
        "equipped": equipped,
        "rarity": "обычный",
        "image": "",
        "imageStatus": "ready",
    })
}

fn starter_weapon(hero_id: &str, weapon_key: &str) -> Value {
    let template = weapon_template(weapon_key);
    let instance = template_instance(utf16_head(&format!("{hero_id}-starter-{weapon_key}"), 120), template, true);
    materialize_catalog_item(template.catalog_id, Some(&instance))
}

/// Колчан к стартовому оружию. Выводится из самого оружия, а не приписан классу:
/// с 2026-08-18 выстрел снимает снаряд у героя так же, как у противника
/// (`server/npc-equipment.mjs`), и лук без стрел означал бы следопыта, которому
/// сервер честно отказывает в первой же дальней атаке. Оружие без свойства
/// `ammunition` (кинжал, длинный меч) колчана не получает — `None`.
fn starter_ammunition(hero_id: &str, weapon_key: &str) -> Option<Value> {
    let template = weapon_template(weapon_key);
    let catalog_id = ammunition_catalog_id_for_weapon(template.catalog_id)?;
    let entry = catalog_item(catalog_id)?;
    let amount = js::number(path(Some(entry), &["ammunition", "amount"]));
    let amount = if amount.is_nan() || amount == 0.0 { 1.0 } else { amount }.max(1.0);
    let instance = json!({
        "id": utf16_head(&format!("{hero_id}-starter-ammunition"), 120),
        "description": "Полный комплект снарядов из стартового снаряжения героя.",
        "properties": format!("Комплект из {} шт. Каждый выстрел снимает один снаряд.", js::f64_string(amount)),
        "quantity": 1,
        "equipped": false,
        "rarity": "обычный",
        "image": "",
        "imageStatus": "ready",
    });
    Some(materialize_catalog_item(catalog_id, Some(&instance)))
}

fn starter_gear(hero_id: &str, gear_key: &str) -> Option<Value> {
    let template = armour_template(gear_key)?;
    let instance = template_instance(utf16_head(&format!("{hero_id}-starter-{gear_key}"), 120), &template, true);
    Some(materialize_catalog_item(template.catalog_id, Some(&instance)))
}

/// `Math.max(1, Math.trunc(Number(value) || 1))`.
fn starter_quantity(value: Option<&Value>) -> Value {
    let number = js::number(value);
    let number = if number.is_nan() || number == 0.0 { 1.0 } else { number };
    js::num(number.trunc().max(1.0))
}

fn classic_starter_item(hero_id: &str, item: &Value, index: usize, prefix: &str, complete: bool) -> KitResult<Value> {
    let catalog_id = string(item.get("catalog_id"));
    let Some(entry) = catalog_item(&catalog_id) else {
        return Err(StarterKitError::Type(format!("Стартовый набор 2014 ссылается на неизвестный предмет {}", template(item.get("catalog_id")))));
    };
    let presentation = starter_presentation_for_catalog_entry(entry);
    let mut instance = Map::new();
    instance.insert("id".into(), json!(utf16_head(&format!("{hero_id}-starter-{prefix}-{}", index + 1), 120)));
    instance.insert("quantity".into(), starter_quantity(item.get("quantity")));
    instance.insert("equipped".into(), json!(js::is_true(item.get("equipped"))));
    instance.insert("rarity".into(), json!("обычный"));
    instance.insert("image".into(), json!(string(presentation.get("image"))));
    if js::truthy(presentation.get("imagePosition")) {
        instance.insert("imagePosition".into(), json!(string(presentation.get("imagePosition"))));
    }
    instance.insert("imageStatus".into(), json!("ready"));
    let materialized = materialize_catalog_item(&catalog_id, Some(&Value::Object(instance)));
    Ok(match phb_pack_contents(&catalog_id).filter(|_| complete) {
        Some(contents) => spread(Some(&materialized), json!({ "contents": contents })),
        None => materialized,
    })
}

fn complete_starter_item(hero_id: &str, item: &Value, index: usize, prefix: &str) -> KitResult<Value> {
    let catalog_id = item.get("catalog_id");
    if js::truthy(catalog_id) && catalog_item(&string(catalog_id)).is_some() {
        return classic_starter_item(hero_id, item, index, prefix, true);
    }
    Ok(narrative_starter_item(hero_id, item, index, prefix, true))
}

fn narrative_starter_item(hero_id: &str, entry: &Value, index: usize, prefix: &str, complete: bool) -> Value {
    let get = |key: &str| field(Some(entry), key);
    let presentation = narrative_item_presentation(&string(get("name")));
    let presentation_description = text::trim(&string(presentation.get("description"))).to_string();
    let source_description = text::trim(&string(get("description"))).to_string();
    let first = if presentation_description.is_empty() { source_description.clone() } else { presentation_description.clone() };
    let second = if !presentation_description.is_empty() && !source_description.is_empty() && presentation_description != source_description { source_description } else { String::new() };
    let description = utf16_head(&[first, second].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" "), 2_000);
    let image = text::trim(&string(nullish(presentation.get("image"), get("image")))).to_string();
    let image_position = text::trim(&string(nullish(presentation.get("imagePosition"), get("imagePosition")))).to_string();
    let id = utf16_head(&format!("{hero_id}-starter-{prefix}-{}", index + 1), 120);
    let name = utf16_head(&string(nullish(get("name"), Some(&json!("Личные вещи")))), 160);
    let mut item = Map::new();
    item.insert("id".into(), json!(id));
    item.insert("name".into(), json!(name));
    if !complete {
        item.insert("type".into(), json!("other"));
        item.insert("quantity".into(), json!(1));
        item.insert("weight".into(), json!(0));
        item.insert("description".into(), json!(description));
        item.insert("properties".into(), json!("Нарративный предмет; механическое применение требует подтверждённого правила."));
        item.insert("mechanics_status".into(), json!("ruling-only"));
        if !image.is_empty() {
            item.insert("image".into(), json!(image));
        }
        if !image_position.is_empty() {
            item.insert("imagePosition".into(), json!(image_position));
        }
        item.insert("sellable".into(), json!(false));
        item.insert("equipped".into(), json!(false));
        return Value::Object(item);
    }
    let defaults = NARRATIVE_ITEM_DEFAULTS.get(&string(get("name")));
    let default = |key: &str| defaults.and_then(|defaults| defaults.get(key));
    let quantity = starter_quantity(get("quantity"));
    let weight = if js::is_finite_number(get("weight")) {
        js::number(get("weight")).max(0.0)
    } else {
        let fallback = js::number(default("weight"));
        if fallback.is_nan() { 0.0 } else { fallback }.max(0.0)
    };
    let kind = text::trim(&string(nullish(nullish(get("type"), default("type")), Some(&json!("other"))))).to_string();
    let kind = if kind.is_empty() { "other".to_string() } else { kind };
    let status_fallback = json!(if kind == "tool" || kind == "focus" { "partial" } else { "ruling-only" });
    let status = string(nullish(nullish(get("mechanics_status"), default("mechanics_status")), Some(&status_fallback)));
    let properties = utf16_head(&string(nullish(nullish(get("properties"), default("properties")), Some(&json!("Обычный предмет стартового снаряжения PHB 2014.")))), 1_000);
    item.insert("type".into(), json!(kind));
    item.insert("quantity".into(), quantity);
    item.insert("weight".into(), js::num(weight));
    item.insert("description".into(), json!(description));
    item.insert("properties".into(), json!(properties));
    item.insert("mechanics_status".into(), json!(status));
    if !image.is_empty() {
        item.insert("image".into(), json!(image));
    }
    if !image_position.is_empty() {
        item.insert("imagePosition".into(), json!(image_position));
    }
    if let Some(contents @ Value::Array(_)) = nullish(get("contents"), default("contents")) {
        item.insert("contents".into(), contents.clone());
    }
    if js::truthy(get("proficiency")) {
        item.insert("proficiency".into(), json!(string(get("proficiency"))));
    }
    item.insert("sellable".into(), json!(false));
    item.insert("equipped".into(), json!(js::is_true(get("equipped"))));
    Value::Object(item)
}

/// `phbWeaponOption(weaponId, { quantity, equipped, optionId })`. Оружие вне
/// каталога и вне `PHB_MISSING_ITEMS` JS отвергает `TypeError`; все списки
/// модуля известны (держит тест), поэтому здесь это `None`.
fn phb_weapon_option(weapon_id: &str, quantity: i64, equipped: bool, option_id: &str) -> Option<Value> {
    let catalog_id = format!("srd_5_2_1:{weapon_id}");
    let mut stack = Map::new();
    if let Some(entry) = catalog_item(&catalog_id) {
        stack.insert("catalog_id".into(), json!(catalog_id));
        stack.insert("quantity".into(), json!(quantity));
        if equipped {
            stack.insert("equipped".into(), json!(true));
        }
        return Some(json!({
            "id": option_id,
            "label": entry.get("name").cloned().unwrap_or(Value::Null),
            "summary": format!("Обычное оружие PHB 2014 · {} фнт за единицу", template(entry.get("weight"))),
            "items": [stack],
        }));
    }
    let missing = phb_missing_item(&catalog_id)?;
    let mut narrative = own_entries(Some(&missing));
    narrative.insert("quantity".into(), json!(quantity));
    if equipped {
        narrative.insert("equipped".into(), json!(true));
    }
    Some(json!({
        "id": option_id,
        "label": missing.get("name").cloned().unwrap_or(Value::Null),
        "summary": format!("Обычное оружие PHB 2014 · {} фнт", template(missing.get("weight"))),
        "narrative_items": [narrative],
    }))
}

fn phb_weapon_options(source: &[&str], option_prefix: &str) -> Vec<Value> {
    source.iter().filter_map(|weapon_id| phb_weapon_option(weapon_id, 1, true, &format!("{option_prefix}-{weapon_id}"))).collect()
}

fn starter_presentation_for_catalog_entry(entry: &Value) -> &'static Value {
    if js::is_true(entry.get("component_pouch")) {
        return narrative_item_presentation("Мешочек с компонентами");
    }
    let classes: Vec<&str> = array(entry.get("spellcasting_focus")).iter().filter_map(Value::as_str).collect();
    let has = |class: &str| classes.contains(&class);
    if has("cleric") || has("paladin") {
        return narrative_item_presentation("Священный символ");
    }
    if has("druid") {
        return narrative_item_presentation("Друидический фокус");
    }
    if has("sorcerer") || has("warlock") || has("wizard") {
        return narrative_item_presentation("Магическая фокусировка");
    }
    if has("bard") {
        return narrative_item_presentation(&string(entry.get("name")));
    }
    &EMPTY
}

/// `[...(a.items ?? []), ...(b.items ?? [])]` для готовых вариантов.
fn concat_field(first: Option<&Value>, second: Option<&Value>, key: &str) -> Value {
    Value::Array(array(field(first, key)).iter().chain(array(field(second, key)).iter()).cloned().collect())
}

fn combine_weapon_option(first: &str, second: &str, option_id: &str, label: String) -> Value {
    let first_option = phb_weapon_option(first, 1, true, &format!("{option_id}-{first}"));
    let second_option = if second == "shield" {
        Some(json!({ "items": [{ "catalog_id": "srd_5_2_1:shield", "quantity": 1, "equipped": true }] }))
    } else {
        phb_weapon_option(second, 1, true, &format!("{option_id}-{second}"))
    };
    json!({
        "id": option_id,
        "label": label,
        "summary": "Полный выбор оружия PHB 2014",
        "items": concat_field(first_option.as_ref(), second_option.as_ref(), "items"),
        "narrative_items": concat_field(first_option.as_ref(), second_option.as_ref(), "narrative_items"),
    })
}

fn weapon_name(weapon_id: &str) -> String {
    let catalog_id = format!("srd_5_2_1:{weapon_id}");
    let name = catalog_item(&catalog_id).and_then(|entry| entry.get("name")).filter(|name| js::present(Some(name))).cloned().or_else(|| phb_missing_item(&catalog_id).and_then(|missing| missing.get("name").cloned()));
    template(name.as_ref())
}

fn pair_options(weapons: &[&str], id_prefix: &str, summary: &str, label: impl Fn(&str, &str, &Value, &Value) -> String) -> Vec<Value> {
    let mut options = Vec::new();
    for left in 0..weapons.len() {
        for right in left..weapons.len() {
            let (first, second) = (weapons[left], weapons[right]);
            let id = format!("{id_prefix}-{first}-{second}");
            let first_option = phb_weapon_option(first, 1, true, &format!("{id}-first"));
            let second_option = phb_weapon_option(second, 1, true, &format!("{id}-second"));
            let first_label = first_option.as_ref().and_then(|option| option.get("label")).cloned().unwrap_or(Value::Null);
            let second_label = second_option.as_ref().and_then(|option| option.get("label")).cloned().unwrap_or(Value::Null);
            options.push(json!({
                "id": id,
                "label": label(first, second, &first_label, &second_label),
                "summary": summary,
                "items": concat_field(first_option.as_ref(), second_option.as_ref(), "items"),
                "narrative_items": concat_field(first_option.as_ref(), second_option.as_ref(), "narrative_items"),
            }));
        }
    }
    options
}

fn complete_dynamic_options(kind: &str) -> Vec<Value> {
    match kind {
        "simple" => phb_weapon_options(&phb_simple_weapons(), "simple-weapon"),
        "simple-melee" => phb_weapon_options(&PHB_SIMPLE_MELEE_WEAPONS, "simple-melee"),
        "martial-melee" => phb_weapon_options(&PHB_MARTIAL_MELEE_WEAPONS, "martial-melee"),
        "musical" => PHB_2014_MUSICAL_INSTRUMENTS.iter().map(|id| phb_tool_option(id, "musical_instrument")).collect(),
        "two-simple-melee" => pair_options(&PHB_SIMPLE_MELEE_WEAPONS, "two-simple-melee", "Два простых рукопашных оружия PHB 2014", |first, second, first_label, second_label| {
            let same = first == second;
            format!("{} ×{}{}", template(Some(first_label)), if same { 2 } else { 1 }, if same { String::new() } else { format!(" и {}", template(Some(second_label))) })
        }),
        "fighter-melee" | "paladin-melee" => {
            let martial = phb_martial_weapons();
            let mut options: Vec<Value> =
                martial.iter().map(|weapon_id| combine_weapon_option(weapon_id, "shield", &format!("martial-and-shield-{weapon_id}"), format!("{} и щит", weapon_name(weapon_id)))).collect();
            options.extend(pair_options(&martial, "two-martial-weapons", "Два воинских оружия PHB 2014", |first, second, first_label, second_label| {
                format!("{}{}", template(Some(first_label)), if first == second { " ×2".to_string() } else { format!(" и {}", template(Some(second_label))) })
            }));
            options
        }
        _ => Vec::new(),
    }
}

/// `COMPLETE_DYNAMIC_OPTIONS`: варианты динамических групп, собранные один раз.
static COMPLETE_DYNAMIC_OPTIONS: LazyLock<Vec<(&'static str, Vec<Value>)>> = LazyLock::new(|| {
    ["simple", "simple-melee", "martial-melee", "musical", "two-simple-melee", "fighter-melee", "paladin-melee"].into_iter().map(|kind| (kind, complete_dynamic_options(kind))).collect()
});

fn dynamic_options(kind: &str) -> &'static [Value] {
    COMPLETE_DYNAMIC_OPTIONS.iter().find(|(id, _)| *id == kind).map_or(&[], |(_, options)| options.as_slice())
}

/// `sortedValue(value)`: ключи объектов по возрастанию (как `sort()` строк — по
/// единицам UTF-16), вглубь.
fn sorted_value(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(sorted_value).collect()),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|left, right| sk_narration_base::jsx::utf16_cmp(left, right));
            Value::Object(js_ordered(keys.into_iter().map(|key| (key.clone(), sorted_value(&map[key]))).collect()))
        }
        other => other.clone(),
    }
}

fn stringify(value: &Value) -> String {
    sk_narration_base::jsx::stringify(value)
}

fn effective_starter_option_signature(option: &Value) -> String {
    let stack = |items: Option<&Value>| -> Value {
        let mut by_identity: IndexMap<String, Value> = IndexMap::new();
        for raw in array(items) {
            let Value::Object(raw) = raw else { continue };
            let quantity = raw.get("quantity").cloned().unwrap_or_else(|| json!(1));
            let mut identity = raw.clone();
            identity.shift_remove("quantity");
            let sorted = sorted_value(&Value::Object(identity));
            let key = stringify(&sorted);
            let previous = by_identity.get(&key).and_then(|entry| entry.get("quantity")).map_or(0.0, |value| js::number(Some(value)));
            let own = js::number(Some(&quantity));
            let own = if own.is_nan() || own == 0.0 { 1.0 } else { own }.max(1.0);
            let entry = spread(Some(&sorted), json!({ "quantity": js::num(previous + own) }));
            by_identity.insert(key, entry);
        }
        let mut values: Vec<Value> = by_identity.into_values().collect();
        values.sort_by(|left, right| text::locale_compare(&stringify(left), &stringify(right)));
        Value::Array(values)
    };
    stringify(&json!({
        "items": stack(option.get("items")),
        "narrative_items": stack(option.get("narrative_items")),
        "owned_assets": stack(option.get("owned_assets")),
    }))
}

fn merge_complete_class_profile(profile: Option<&Value>, public_catalog: bool) -> Option<Value> {
    let class_id = field(profile, "class_id");
    let wanted = string(class_id);
    let stored = array(classic().get("complete_classes")).iter().find(|entry| template(entry.get("class_id")) == wanted);
    let rules = coalesce(&[stored.and_then(|entry| entry.get("dynamic_groups"))]).cloned().or_else(|| complete_class_dynamic_groups(&template(class_id)));
    let rules = match rules {
        Some(rules) if js::truthy(Some(&rules)) && js::truthy(profile) => rules,
        _ => return profile.filter(|profile| js::truthy(Some(profile))).cloned(),
    };
    let groups: Vec<Value> = array(field(profile, "choice_groups"))
        .iter()
        .map(|group| {
            let source = field(Some(&rules), &template(group.get("id")));
            if !js::truthy(source) {
                return group.clone();
            }
            let additions = dynamic_options(&string(source));
            let own = array(group.get("options"));
            let existing: HashSet<String> = own.iter().map(|option| template(option.get("id"))).collect();
            let options: Vec<Value> = own
                .iter()
                .filter(|option| !js::is_true(option.get("legacy_only")))
                .chain(additions.iter().filter(|option| !existing.contains(&template(option.get("id")))))
                .cloned()
                .collect();
            let visible: Vec<Value> = if public_catalog {
                let mut signatures = HashSet::new();
                options.into_iter().filter(|option| signatures.insert(effective_starter_option_signature(option))).collect()
            } else {
                options
            };
            spread(Some(group), json!({ "complete": true, "options": visible }))
        })
        .collect();
    Some(spread(profile, json!({ "complete": true, "choice_groups": groups })))
}

fn label_item(item: &Value) -> Value {
    let catalog_id = item.get("catalog_id");
    if !js::truthy(catalog_id) {
        return spread(Some(item), json!({}));
    }
    let name = catalog_item(&string(catalog_id)).and_then(|entry| entry.get("name")).filter(|name| js::present(Some(name))).or(catalog_id).cloned().unwrap_or(Value::Null);
    spread(Some(item), json!({ "name": name }))
}

/// `starterEquipmentCatalogFor(rulesetId, { complete })`: каталог стартового
/// снаряжения PHB 2014 для мастера создания (у 2024 его нет — `None`). Полный
/// режим раскрывает динамические группы и добавляет физические наборы
/// предысторий; в публичном каталоге варианты с одинаковым эффективным
/// комплектом не повторяются.
pub fn starter_equipment_catalog_for(ruleset_id: &str, complete: bool) -> Option<Value> {
    if ruleset_id != DND_2014_RULESET_ID {
        return None;
    }
    let classes: Vec<Option<Value>> = array(classic().get("classes")).iter().map(|profile| if complete { merge_complete_class_profile(Some(profile), true) } else { Some(profile.clone()) }).collect();
    let mut result = own_entries(Some(classic()));
    if complete {
        result.insert("complete".into(), json!(true));
        result.insert("complete_schema_version".into(), json!(1));
        let backgrounds: Vec<Value> = array(classic().get("complete_backgrounds")).iter().map(|profile| complete_background_profile(Some(profile)).unwrap_or(Value::Null)).collect();
        result.insert("backgrounds".into(), Value::Array(backgrounds));
    }
    let classes: Vec<Value> = classes
        .iter()
        .map(|profile| {
            let profile = profile.as_ref();
            let groups: Vec<Value> = array(field(profile, "choice_groups"))
                .iter()
                .map(|group| {
                    let options: Vec<Value> = array(group.get("options"))
                        .iter()
                        .map(|option| {
                            let items: Vec<Value> = array(option.get("items")).iter().map(label_item).collect();
                            let narrative: Vec<Value> = array(option.get("narrative_items")).iter().map(label_item).collect();
                            spread(Some(option), json!({ "items": items, "narrative_items": narrative }))
                        })
                        .collect();
                    spread(Some(group), json!({ "options": options }))
                })
                .collect();
            let fixed: Vec<Value> = array(field(profile, "fixed_items")).iter().map(label_item).collect();
            let fixed_narrative: Vec<Value> = array(field(profile, "fixed_narrative_items")).iter().map(label_item).collect();
            spread(profile, json!({ "fixed_items": fixed, "fixed_narrative_items": fixed_narrative, "choice_groups": groups }))
        })
        .collect();
    result.insert("classes".into(), Value::Array(classes));
    Some(Value::Object(result))
}

/// `Object.fromEntries(groups.map((group) => [group.id, first count option ids]))`.
fn first_options_by_group(groups: &[Value]) -> Value {
    let mut result = Map::new();
    for group in groups {
        let options = array(group.get("options"));
        let end = slice_end(options.len(), js::number(nullish(group.get("count"), Some(&json!(0)))));
        let ids: Vec<Value> = options[..end].iter().map(|option| option.get("id").cloned().unwrap_or(Value::Null)).collect();
        result.insert(template(group.get("id")), Value::Array(ids));
    }
    Value::Object(js_ordered(result))
}

/// `defaultStarterEquipmentChoices(classId, rulesetId, { complete })`: первые
/// допустимые варианты каждой группы. Не 2014 — пустой объект; класса без
/// набора — `None` (`null` в JS).
pub fn default_starter_equipment_choices(class_id: Option<&Value>, ruleset_id: &str, complete: bool) -> Option<Value> {
    if ruleset_id != DND_2014_RULESET_ID {
        return Some(js::obj());
    }
    let raw = classic_class_profile_by_string(class_id);
    let profile = if complete { merge_complete_class_profile(raw, false) } else { raw.cloned() }?;
    Some(first_options_by_group(array(profile.get("choice_groups"))))
}

fn refusal(reason: String) -> Value {
    json!({ "ok": false, "reason": reason })
}

/// Общая проверка выбора групп (класса и предыстории): каждая группа
/// принадлежит профилю, выбрано ровно `count` разных известных вариантов.
fn resolve_group_choices(profile: &Value, choices: Option<&Value>, not_object: &str, foreign_group: impl Fn(&str) -> String) -> Value {
    let default_choices = js::obj();
    let choices = choices.unwrap_or(&default_choices);
    let Value::Object(choice_map) = choices else {
        return refusal(not_object.into());
    };
    let groups = array(profile.get("choice_groups"));
    let allowed: HashSet<String> = groups.iter().map(|group| template(group.get("id"))).collect();
    for key in js::keys(choice_map) {
        if !allowed.contains(key) {
            return refusal(foreign_group(key));
        }
    }
    let mut resolved = Map::new();
    let mut selected_options = Vec::new();
    for group in groups {
        let group_key = template(group.get("id"));
        let selected: Vec<String> = match choice_map.get(&group_key) {
            Some(Value::Array(ids)) => ids.iter().map(|id| template(Some(id))).collect(),
            _ => Vec::new(),
        };
        // `Math.max(0, Number(group.count ?? 0))`: `NaN` заразен, в отличие от `f64::max`.
        let count = js::number(nullish(group.get("count"), Some(&json!(0))));
        let expected = if count.is_nan() { f64::NAN } else { count.max(0.0) };
        let unique: HashSet<&String> = selected.iter().collect();
        if selected.len() as f64 != expected || unique.len() != selected.len() {
            return refusal(format!("{}: нужно выбрать {}", template(group.get("label")), js::f64_string(expected)));
        }
        let options = array(group.get("options"));
        let by_id = |id: &str| options.iter().rev().find(|option| template(option.get("id")) == id);
        if selected.iter().any(|id| by_id(id).is_none()) {
            return refusal(format!("{}: неизвестный вариант", template(group.get("label"))));
        }
        for id in &selected {
            let mut entry = Map::new();
            if let Some(group_id) = group.get("id") {
                entry.insert("group_id".into(), group_id.clone());
            }
            if let Some(Value::Object(option)) = by_id(id) {
                for (key, value) in js::entries(option) {
                    entry.insert(key.clone(), value.clone());
                }
            }
            selected_options.push(Value::Object(entry));
        }
        resolved.insert(group_key, json!(selected));
    }
    json!({ "ok": true, "choices": Value::Object(js_ordered(resolved)), "selected_options": selected_options, "profile": profile })
}

/// `resolveStarterEquipmentChoices(classId, choices, rulesetId, { complete })`:
/// проверенный сервером выбор групп снаряжения класса 2014 — `{ ok, choices,
/// selected_options, profile }` или `{ ok: false, reason }`. `choices = None` —
/// аргумент не передан (`{}`).
pub fn resolve_starter_equipment_choices(class_id: Option<&Value>, choices: Option<&Value>, ruleset_id: &str, complete: bool) -> Value {
    if ruleset_id != DND_2014_RULESET_ID {
        return json!({ "ok": true, "choices": {}, "selected_options": [], "profile": null });
    }
    let raw = classic_class_profile_by_string(class_id);
    let Some(profile) = (if complete { merge_complete_class_profile(raw, false) } else { raw.cloned() }) else {
        return refusal("Для класса нет стартового набора 2014".into());
    };
    resolve_group_choices(&profile, choices, "starterEquipmentChoices должен быть объектом", |key| format!("Группа снаряжения {key} не принадлежит классу"))
}

fn complete_mode_requested(hero: Option<&Value>, complete: bool) -> bool {
    complete || js::number(path(hero, &["phbCreation", "schema_version"])) == 1.0
}

fn complete_background_profile_for(background_id: Option<&Value>) -> Option<Value> {
    let wanted = string(background_id);
    let profile = array(classic().get("complete_backgrounds")).iter().find(|entry| template(entry.get("background_id")) == wanted);
    complete_background_profile(profile)
}

fn resolve_complete_background_choices(background: Option<&Value>, choices: Option<&Value>) -> Value {
    let Some(background) = background.filter(|background| js::truthy(Some(background))) else {
        return refusal("Для предыстории нет полного набора 2014".into());
    };
    resolve_group_choices(background, choices, "backgroundChoices должен быть объектом", |key| format!("Группа предыстории {key} не принадлежит этому фону"))
}

fn background_choices_for_hero(hero: Option<&Value>, background: &Value) -> Value {
    let defaults = first_options_by_group(array(background.get("choice_groups")));
    let explicit = nullish(path(hero, &["phbCreation", "backgroundEquipmentChoices"]), field(hero, "backgroundEquipmentChoices"));
    if let Some(explicit @ Value::Object(_)) = explicit {
        return spread(Some(&defaults), explicit.clone());
    }
    let old_tools: Vec<String> = match path(hero, &["backgroundChoices", "tools"]) {
        Some(Value::Array(tools)) => tools.iter().map(|tool| template(Some(tool))).collect(),
        _ => Vec::new(),
    };
    if old_tools.is_empty() {
        return defaults;
    }
    let mut translated = own_entries(Some(&defaults));
    // `new Map(groups.map((group) => [group.id, group]))`: позиция первого
    // вхождения id, значение — последнего. Перевод касается только групп с
    // известными строковыми id.
    let mut group_by_id: IndexMap<&str, &Value> = IndexMap::new();
    for group in array(background.get("choice_groups")) {
        if let Some(id) = group.get("id").and_then(Value::as_str) {
            group_by_id.insert(id, group);
        }
    }
    for (group_id, group) in group_by_id {
        if !["musical-instrument", "artisan-tool", "gaming-set"].contains(&group_id) {
            continue;
        }
        let available: HashSet<String> = array(group.get("options")).iter().map(|option| template(option.get("id"))).collect();
        let matching: Vec<&String> = old_tools.iter().filter(|id| available.contains(*id)).collect();
        let count = js::number(nullish(group.get("count"), Some(&json!(0))));
        let selected = &matching[..slice_end(matching.len(), count)];
        if selected.len() as f64 == count {
            translated.insert(group_id.to_string(), json!(selected));
        }
    }
    Value::Object(js_ordered(translated))
}

/// `completeBackgroundChoicesForHero(hero, background)`: выбор полного набора
/// предыстории PHB 2014 для героя — явный выбор поверх первых допустимых
/// вариантов, прежний выбор инструментов переводится в группы. `background` —
/// id строкой, готовый профиль или `None`/`null` (тогда по `hero.backgroundId`).
pub fn complete_background_choices_for_hero(hero: Option<&Value>, background: Option<&Value>) -> Option<Value> {
    let profile = match background {
        Some(Value::String(id)) => complete_background_profile_for(Some(&Value::String(id.clone()))),
        Some(value) if js::present(Some(value)) => Some(value.clone()),
        _ => complete_background_profile_for(field(hero, "backgroundId")),
    };
    profile.filter(|profile| js::truthy(Some(profile))).map(|profile| background_choices_for_hero(hero, &profile))
}

/// `validateCompleteBackgroundChoices(backgroundOrId, choices)`: проверка
/// выбора полного набора одной предыстории PHB 2014. `choices = None` —
/// аргумент не передан (`{}`).
pub fn validate_complete_background_choices(background_or_id: Option<&Value>, choices: Option<&Value>) -> Value {
    let profile = match background_or_id {
        Some(Value::String(id)) => complete_background_profile_for(Some(&Value::String(id.clone()))),
        other => other.cloned(),
    };
    resolve_complete_background_choices(profile.as_ref(), choices)
}

/// `[...a.flatMap((option) => option[key] ?? [])]`: массив раскрывается,
/// прочее значение входит само.
fn flat_option_items(options: &[Value], key: &str) -> Vec<Value> {
    let mut items = Vec::new();
    for option in options {
        match option.get(key) {
            None | Some(Value::Null) => {}
            Some(Value::Array(list)) => items.extend(list.iter().cloned()),
            Some(other) => items.push(other.clone()),
        }
    }
    items
}

fn complete_background_inventory(hero_id: &str, background: &Value, choices: &Value) -> KitResult<Vec<Value>> {
    let resolved = resolve_complete_background_choices(Some(background), Some(choices));
    if !js::truthy(resolved.get("ok")) {
        return Err(StarterKitError::Type(string(resolved.get("reason"))));
    }
    let selected = array(resolved.get("selected_options"));
    let mut inventory = Vec::new();
    for (index, item) in array(background.get("fixed_items")).iter().enumerate() {
        inventory.push(complete_starter_item(hero_id, item, index, "background")?);
    }
    for (index, item) in array(background.get("fixed_narrative_items")).iter().enumerate() {
        inventory.push(complete_starter_item(hero_id, item, index, "background-keepsake")?);
    }
    for (index, item) in flat_option_items(selected, "items").iter().enumerate() {
        inventory.push(complete_starter_item(hero_id, item, index, "background-choice")?);
    }
    for (index, item) in flat_option_items(selected, "narrative_items").iter().enumerate() {
        inventory.push(complete_starter_item(hero_id, item, index, "background-choice")?);
    }
    Ok(inventory)
}

/// `new Set(value ?? [])` для выбранных инструментов: строки, по которым потом
/// ищется `entry.id`. Неитерируемое JS отвергает `TypeError`.
fn iterable_strings(value: Option<&Value>) -> KitResult<Vec<String>> {
    let not_iterable = |described: String| StarterKitError::Runtime(format!("{described} is not iterable (cannot read property Symbol(Symbol.iterator))"));
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => Ok(items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect()),
        Some(Value::String(text)) => Ok(text.chars().map(|ch| ch.to_string()).collect()),
        Some(Value::Number(number)) => Err(not_iterable(format!("number {}", sk_narration_base::jsx::number_string(number)))),
        Some(Value::Bool(flag)) => Err(not_iterable(format!("boolean {flag}"))),
        Some(Value::Object(_)) => Err(not_iterable("object".into())),
    }
}

fn hero_id_of(hero: Option<&Value>) -> String {
    let id = field(hero, "id");
    if js::truthy(id) {
        string(id)
    } else {
        "hero".into()
    }
}

fn classic_starter_inventory(hero: Option<&Value>, profile: &Value, policy_version: &Value, complete: bool) -> KitResult<Vec<Value>> {
    let hero_id = hero_id_of(hero);
    let mut class_items = Vec::new();
    if js::number(Some(policy_version)) < 2.0 {
        for (index, item) in array(profile.get("legacy_default_items")).iter().enumerate() {
            class_items.push(classic_starter_item(&hero_id, item, index, "class", false)?);
        }
    } else {
        let character_class = field(hero, "characterClass");
        let requested = coalesce(&[path(hero, &["phbCreation", "classEquipmentChoices"]), field(hero, "starterEquipmentChoices")])
            .cloned()
            .or_else(|| default_starter_equipment_choices(character_class, DND_2014_RULESET_ID, complete))
            .unwrap_or_else(js::obj);
        let resolved = resolve_starter_equipment_choices(character_class, Some(&requested), DND_2014_RULESET_ID, complete);
        if !js::truthy(resolved.get("ok")) {
            return Err(StarterKitError::Type(string(resolved.get("reason"))));
        }
        let selected = array(resolved.get("selected_options"));
        let items: Vec<Value> = array(profile.get("fixed_items")).iter().cloned().chain(flat_option_items(selected, "items")).collect();
        for (index, item) in items.iter().enumerate() {
            class_items.push(if complete { complete_starter_item(&hero_id, item, index, "class")? } else { classic_starter_item(&hero_id, item, index, "class", false)? });
        }
        let narrative: Vec<Value> = array(profile.get("fixed_narrative_items")).iter().cloned().chain(flat_option_items(selected, "narrative_items")).collect();
        for (index, item) in narrative.iter().enumerate() {
            class_items.push(if complete { complete_starter_item(&hero_id, item, index, "class-keepsake")? } else { narrative_starter_item(&hero_id, item, index, "class-keepsake", false) });
        }
    }
    let background_id = field(hero, "backgroundId");
    let background = if complete { complete_background_profile_for(background_id) } else { classic_background(background_id)? };
    if let Some(background) = background.as_ref().filter(|_| complete) {
        let choices = background_choices_for_hero(hero, background);
        class_items.extend(complete_background_inventory(&hero_id, background, &choices)?);
        return Ok(class_items);
    }
    let background = background.as_ref();
    let mut background_items = Vec::new();
    for (index, item) in array(path(background, &["equipment", "catalogItems"])).iter().enumerate() {
        let item = spread(Some(item), json!({ "catalog_id": item.get("catalogId").cloned().unwrap_or(Value::Null) }));
        let item = if field(Some(&item), "catalogId").is_none() { without_key(item, "catalog_id") } else { item };
        background_items.push(classic_starter_item(&hero_id, &item, index, "background", false)?);
    }
    if js::truthy(path(background, &["equipment", "includeChosenTool"])) {
        let selected = iterable_strings(path(hero, &["backgroundChoices", "tools"]))?;
        let tool = array(path(background, &["toolChoice", "options"]))
            .iter()
            .find(|entry| entry.get("id").and_then(Value::as_str).is_some_and(|id| selected.iter().any(|tool| tool == id)) && js::truthy(entry.get("catalogId")));
        if let Some(tool) = tool {
            let item = json!({ "catalog_id": tool.get("catalogId").cloned().unwrap_or(Value::Null), "quantity": 1 });
            let index = background_items.len();
            background_items.push(classic_starter_item(&hero_id, &item, index, "background-tool", false)?);
        }
    }
    if js::truthy(path(background, &["equipment", "summary"])) {
        let entry = json!({
            "name": format!("{}: личные вещи", template(field(background, "name"))),
            "description": string(path(background, &["equipment", "summary"])),
        });
        background_items.push(narrative_starter_item(&hero_id, &entry, 0, "background-keepsakes", false));
    }
    class_items.extend(background_items);
    Ok(class_items)
}

/// `{ ...item, catalog_id: undefined }` в JSON — без поля.
fn without_key(value: Value, key: &str) -> Value {
    match value {
        Value::Object(mut map) => {
            map.shift_remove(key);
            Value::Object(map)
        }
        other => other,
    }
}

/// `backgroundById(hero?.backgroundId, DND_2014_RULESET_ID)`.
fn classic_background(background_id: Option<&Value>) -> KitResult<Option<Value>> {
    background_by_id(&string(background_id), DND_2014_RULESET_ID, None).map_err(|error| StarterKitError::Runtime(error.message().to_string()))
}

/// Настройки `withStarterKit(hero, { rulesetId, starterPolicyVersion, starterPolicyId, complete })`.
#[derive(Debug, Clone, PartialEq)]
pub struct StarterKitOptions {
    /// Редакция кампании; по умолчанию — `LEGACY_DEFAULT_RULESET_ID`.
    pub ruleset_id: String,
    /// Версия политики набора 2014 из события; `None` — текущая из данных.
    pub starter_policy_version: Option<Value>,
    /// Метка политики набора 2024 из события.
    pub starter_policy_id: Option<String>,
    /// Полный режим PHB 2014 (`complete === true`).
    pub complete: bool,
}

impl Default for StarterKitOptions {
    fn default() -> Self {
        Self { ruleset_id: LEGACY_DEFAULT_RULESET_ID.into(), starter_policy_version: None, starter_policy_id: None, complete: false }
    }
}

/// `withStarterKit(hero, options)`: дополняет только недостающее к первой
/// сессии — импортированные, уже собранные листы сохраняют деньги,
/// характеристики и снаряжение. `hero` — не объект: как пустой объект.
pub fn with_starter_kit(hero: Option<&Value>, options: &StarterKitOptions) -> KitResult<Value> {
    let ruleset_2014 = options.ruleset_id == DND_2014_RULESET_ID;
    let character_class = field(hero, "characterClass");
    let role = text::lower(&format!("{} {}", string(field(hero, "role")), string(character_class)));
    let profile = CLASS_PROFILES.iter().find(|entry| character_class.and_then(Value::as_str) == Some(entry.key) || sk_core::text::test(class_pattern(entry.key), &role));
    let profile_key = profile.map(|profile| json!(profile.key));
    let class_or_profile = nullish(character_class, profile_key.as_ref());
    let hero_id = hero_id_of(hero);
    let use_complete = complete_mode_requested(hero, options.complete);
    let raw_classic_profile = classic_class_profile(class_or_profile);
    let classic_profile = if use_complete { merge_complete_class_profile(raw_classic_profile, false) } else { raw_classic_profile.cloned() };
    let selected_starter_choices = coalesce(&[path(hero, &["phbCreation", "classEquipmentChoices"]), field(hero, "starterEquipmentChoices")])
        .cloned()
        .or_else(|| default_starter_equipment_choices(class_or_profile, DND_2014_RULESET_ID, use_complete));
    let hero_abilities = field(hero, "abilities");
    let blank = ability_scores_are_blank(hero_abilities)?;
    let abilities = match profile {
        Some(profile) if blank => profile_abilities(profile),
        _ => coalesce(&[hero_abilities]).cloned().unwrap_or_else(|| json!({ "str": 10, "dex": 10, "con": 10, "int": 10, "wis": 10, "cha": 10 })),
    };
    let kit = if !ruleset_2014 && options.starter_policy_id.as_deref() == Some(STARTER_KIT_2024_POLICY.policy_id) {
        kit_2024_for(class_or_profile, &abilities)
    } else {
        KitLookup::Missing
    };
    let weapon_key = profile.map_or("dagger", |profile| profile.weapon);
    let inventory = match field(hero, "inventory") {
        Some(Value::Array(items)) if !items.is_empty() => Value::Array(items.clone()),
        _ => Value::Array(match kit {
            KitLookup::Kit(kit) => kit_2024_inventory(&hero_id, kit)?,
            KitLookup::Prototype => return Err(StarterKitError::Runtime("Cannot read properties of undefined (reading 'map')".into())),
            KitLookup::Missing if ruleset_2014 => match classic_profile.as_ref() {
                Some(classic_profile) => {
                    let version = options.starter_policy_version.clone().unwrap_or_else(classic_policy_version);
                    // `{ ...hero, characterClass: hero?.characterClass ?? profile?.key }`:
                    // класс, узнанный по роли, — и для выбора набора 2014.
                    let mut with_class = hero.and_then(Value::as_object).cloned().unwrap_or_default();
                    if !js::present(with_class.get("characterClass")) {
                        match profile {
                            Some(profile) => {
                                with_class.insert("characterClass".into(), json!(profile.key));
                            }
                            None => {
                                with_class.shift_remove("characterClass");
                            }
                        }
                    }
                    classic_starter_inventory(Some(&Value::Object(with_class)), classic_profile, &version, use_complete)?
                }
                None => vec![starter_weapon(&hero_id, weapon_key)],
            },
            KitLookup::Missing => {
                let mut items = vec![starter_weapon(&hero_id, weapon_key)];
                items.extend(starter_ammunition(&hero_id, weapon_key));
                items.extend(profile.map_or(&[][..], |profile| profile.gear).iter().filter_map(|key| starter_gear(&hero_id, key)));
                items
            }
        }),
    };
    let hero_currency = field(hero, "currency");
    let currency = if total_currency(hero_currency)? > 0.0 {
        hero_currency.cloned().unwrap_or(Value::Null)
    } else if ruleset_2014 {
        let background = classic_background(field(hero, "backgroundId"))?;
        let gold = js::number(path(background.as_ref(), &["equipment", "gold"]));
        let gold = if gold.is_nan() { 0.0 } else { gold }.max(0.0);
        json!({ "copper": 0, "silver": 0, "gold": js::num(gold), "platinum": 0 })
    } else {
        json!({ "copper": 0, "silver": 0, "gold": STARTING_GOLD, "platinum": 0 })
    };
    let mut result = own_entries(hero);
    if let Some(profile) = profile.filter(|_| !js::truthy(character_class)) {
        result.insert("characterClass".into(), json!(profile.key));
    }
    result.insert("inventory".into(), inventory);
    result.insert("currency".into(), currency);
    result.insert("abilities".into(), abilities);
    if ruleset_2014 && classic_profile.is_some() {
        result.insert("starterEquipmentPolicyId".into(), classic().get("policy_id").cloned().unwrap_or(Value::Null));
        result.insert("starterEquipmentPolicyVersion".into(), classic_policy_version());
        result.insert("starterEquipmentChoices".into(), selected_starter_choices.unwrap_or_else(js::obj));
    }
    Ok(Value::Object(js_ordered(result)))
}

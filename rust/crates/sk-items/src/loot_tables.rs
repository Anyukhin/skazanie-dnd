//! Перенос `server/loot-tables.mjs`: добыча встречи и магическая находка.
//!
//! Случайности здесь нет: выдача выводится **детерминированно** из
//! идентификатора встречи (SHA-256 строки), поэтому тот же бой после replay
//! или падения даёт ту же вещь, а payload события всё равно несёт
//! материализованный предмет целиком — будущая версия каталога не меняет
//! старую награду.

use serde_json::{json, Value};
use sk_core::{hash, js};

use crate::item_catalog::{catalog_item, materialize_catalog_item, ITEM_LOOT_CATALOG_IDS, ITEM_MAGIC_LOOT_CATALOG_IDS};
use crate::support::{field, js_max, or_zero};

pub const ENCOUNTER_LOOT_POLICY_ID: &str = "encounter-loot-v2";
pub const ENCOUNTER_MAGIC_LOOT_POLICY_ID: &str = "encounter-magic-loot-v1";

/// **Порядок выдачи**, а не классификация вещи (`LOOT_BY_THEME`). Массивы
/// упорядочены осознанно: выбор берёт первый подходящий по цене, а пул
/// вращается от идентификатора встречи, поэтому перестановка элементов меняет
/// награду. Порядок тем — как ключи объекта JS.
pub const LOOT_BY_THEME: [(&str, &[&str]); 11] = [
    ("goblinoids", &["srd_5_2_1:dagger", "srd_5_2_1:shortbow", "srd_5_2_1:arrows-20", "srd_5_2_1:javelin", "srd_5_2_1:shield", "srd_5_2_1:leather-armor", "srd_5_2_1:spear", "srd_5_2_1:torch", "srd_5_2_1:rations-one-day", "srd_5_2_1:chain-shirt"]),
    ("undead", &["srd_5_2_1:mace", "srd_5_2_1:ring-mail", "srd_5_2_1:dagger", "srd_5_2_1:shortbow", "srd_5_2_1:arrows-20", "srd_5_2_1:shield", "srd_5_2_1:shortsword", "srd_5_2_1:torch", "srd_5_2_1:rope-hempen-50-feet"]),
    ("beasts", &["srd_5_2_1:spear", "srd_5_2_1:javelin", "srd_5_2_1:shortbow", "srd_5_2_1:arrows-20", "srd_5_2_1:hide-armor", "srd_5_2_1:rope-hempen-50-feet", "srd_5_2_1:rations-one-day", "srd_5_2_1:healers-kit", "srd_5_2_1:torch", "srd_5_2_1:quarterstaff"]),
    ("raiders", &["srd_5_2_1:dagger", "srd_5_2_1:handaxe", "srd_5_2_1:javelin", "srd_5_2_1:shortsword", "srd_5_2_1:light-crossbow", "srd_5_2_1:bolts-20", "srd_5_2_1:leather-armor", "srd_5_2_1:shield", "srd_5_2_1:rations-one-day", "srd_5_2_1:rope-hempen-50-feet", "srd_5_2_1:healers-kit", "srd_5_2_1:sickle", "srd_5_2_1:greataxe", "srd_5_2_1:chain-shirt"]),
    ("warband", &["srd_5_2_1:battleaxe", "srd_5_2_1:chain-shirt", "srd_5_2_1:greataxe", "srd_5_2_1:shield", "srd_5_2_1:longsword", "srd_5_2_1:mace", "srd_5_2_1:ring-mail", "srd_5_2_1:spear", "srd_5_2_1:light-crossbow", "srd_5_2_1:bolts-20", "srd_5_2_1:healers-kit"]),
    ("vermin", &["srd_5_2_1:club", "srd_5_2_1:dagger", "srd_5_2_1:sling", "srd_5_2_1:sling-bullets-20", "srd_5_2_1:torch", "srd_5_2_1:rations-one-day", "srd_5_2_1:rope-hempen-50-feet"]),
    ("ambush", &["srd_5_2_1:dagger", "srd_5_2_1:dart", "srd_5_2_1:shortbow", "srd_5_2_1:arrows-20", "srd_5_2_1:light-crossbow", "srd_5_2_1:bolts-20", "srd_5_2_1:shortsword", "srd_5_2_1:leather-armor", "srd_5_2_1:rope-hempen-50-feet", "srd_5_2_1:healers-kit"]),
    ("crypt", &["srd_5_2_1:mace", "srd_5_2_1:ring-mail", "srd_5_2_1:dagger", "srd_5_2_1:rope-hempen-50-feet", "srd_5_2_1:torch", "srd_5_2_1:shortbow", "srd_5_2_1:arrows-20", "srd_5_2_1:shield", "srd_5_2_1:shortsword"]),
    ("cave", &["srd_5_2_1:club", "srd_5_2_1:greatclub", "srd_5_2_1:spear", "srd_5_2_1:javelin", "srd_5_2_1:war-pick", "srd_5_2_1:sling", "srd_5_2_1:sling-bullets-20", "srd_5_2_1:torch", "srd_5_2_1:rope-hempen-50-feet", "srd_5_2_1:rations-one-day", "srd_5_2_1:hide-armor", "srd_5_2_1:chain-shirt"]),
    ("wilderness", &["srd_5_2_1:rations-one-day", "srd_5_2_1:rope-hempen-50-feet", "srd_5_2_1:torch", "srd_5_2_1:shortbow", "srd_5_2_1:arrows-20", "srd_5_2_1:spear", "srd_5_2_1:javelin", "srd_5_2_1:handaxe", "srd_5_2_1:dagger", "srd_5_2_1:healers-kit", "srd_5_2_1:hide-armor", "srd_5_2_1:quarterstaff", "srd_5_2_1:sickle"]),
    ("generic", &["srd_5_2_1:rations-one-day", "srd_5_2_1:rope-hempen-50-feet", "srd_5_2_1:torch", "srd_5_2_1:dart", "srd_5_2_1:ring-mail", "srd_5_2_1:sling", "srd_5_2_1:dagger", "srd_5_2_1:arrows-20", "srd_5_2_1:club", "srd_5_2_1:chain-shirt", "srd_5_2_1:bolts-20", "srd_5_2_1:battleaxe", "srd_5_2_1:handaxe", "srd_5_2_1:healers-kit", "srd_5_2_1:hide-armor", "srd_5_2_1:javelin", "srd_5_2_1:leather-armor", "srd_5_2_1:light-crossbow", "srd_5_2_1:longsword", "srd_5_2_1:mace", "srd_5_2_1:quarterstaff", "srd_5_2_1:shield", "srd_5_2_1:shortbow", "srd_5_2_1:shortsword", "srd_5_2_1:sickle", "srd_5_2_1:sling-bullets-20", "srd_5_2_1:spear", "srd_5_2_1:war-pick", "srd_5_2_1:greataxe", "srd_5_2_1:greatclub"]),
];

/// `LOOT_BY_THEME` как объект JSON.
pub fn loot_by_theme_json() -> Value {
    Value::Object(LOOT_BY_THEME.iter().map(|(theme, pool)| ((*theme).to_string(), js::strings_value(pool.iter().copied()))).collect())
}

/// Пул темы, если она есть (`Object.hasOwn(LOOT_BY_THEME, theme)`).
pub fn loot_pool(theme: &str) -> Option<&'static [&'static str]> {
    LOOT_BY_THEME.iter().find(|(key, _)| *key == theme).map(|(_, pool)| *pool)
}

/// Сложность: сколько стопок, сколько припасов и сколько пачек снарядов.
const DIFFICULTIES: [(&str, usize, i64, i64); 3] = [("easy", 1, 1, 1), ("medium", 2, 2, 1), ("hard", 3, 3, 2)];

/// Ценовые ступени в медных монетах, включительно.
const PRICE_TIERS: [(i64, i64); 3] = [(0, 500), (501, 2_500), (2_501, 7_500)];

const AMMUNITION_PACKAGES: [&str; 3] = ["srd_5_2_1:arrows-20", "srd_5_2_1:bolts-20", "srd_5_2_1:sling-bullets-20"];

/// `parseInt(hex.slice(a, b), 16)`.
fn hex_number(digest: &str, from: usize, to: usize) -> u64 {
    digest.get(from..to).and_then(|part| u64::from_str_radix(part, 16).ok()).unwrap_or(0)
}

fn offset_for(theme: &str, encounter_id: &str, length: usize) -> usize {
    let digest = hash::sha256_hex(format!("loot:{theme}:{encounter_id}"));
    (hex_number(&digest, 0, 8) % length as u64) as usize
}

fn rotated(values: &[&'static str], offset: usize) -> Vec<&'static str> {
    values[offset..].iter().chain(values[..offset].iter()).copied().collect()
}

fn quantity_for(catalog_id: &str, supply: i64, ammunition: i64) -> i64 {
    if catalog_id == "srd_5_2_1:torch" || catalog_id == "srd_5_2_1:rations-one-day" {
        return supply;
    }
    if AMMUNITION_PACKAGES.contains(&catalog_id) {
        return ammunition;
    }
    1
}

fn price_in_tier(catalog_id: &str, (minimum, maximum): (i64, i64)) -> bool {
    // `Number.isSafeInteger(price)` без приведения: цена — число каталога.
    let price = catalog_item(catalog_id).and_then(|entry| entry.get("base_price_cp")).filter(|price| js::is_safe_integer(Some(price))).and_then(Value::as_f64);
    price.is_some_and(|price| price >= minimum as f64 && price <= maximum as f64)
}

fn choose_for_tier(pool: &[&'static str], tier_index: usize, used: &[&str]) -> Option<&'static str> {
    (0..=tier_index).rev().find_map(|fallback| pool.iter().copied().find(|catalog_id| !used.contains(catalog_id) && price_in_tier(catalog_id, PRICE_TIERS[fallback])))
}

fn eligible(catalog_id: &str, purpose: &str) -> Result<(), String> {
    let status = sk_core::MechanicsSupport::of(catalog_item(catalog_id).and_then(|entry| entry.get("mechanics_status")));
    if status.is_some_and(sk_core::MechanicsSupport::is_executable) {
        Ok(())
    } else {
        Err(format!("Catalog item {catalog_id} is not mechanically eligible for {purpose}"))
    }
}

/// `serverEncounterLoot({ theme, difficulty, encounterId })` над объектом
/// параметров JS: отсутствующее поле — значение по умолчанию (`generic`,
/// `medium`, пустой id), `null` — как в JS (`encounterId: null` даёт строку
/// `"null"`). `None` — вызов без аргумента; `null` вместо объекта в JS —
/// `TypeError` деструктуризации.
pub fn server_encounter_loot(options: Option<&Value>) -> Result<Vec<Value>, String> {
    if matches!(options, Some(Value::Null)) {
        return Err("Cannot read properties of null (reading 'theme')".into());
    }
    let theme = field(options, "theme").map_or_else(|| "generic".to_string(), |theme| js::string(Some(theme)));
    let difficulty = field(options, "difficulty").map_or_else(|| "medium".to_string(), |difficulty| js::string(Some(difficulty)));
    let encounter_id = field(options, "encounterId").map_or_else(String::new, |id| js::string(Some(id)));
    encounter_loot(&theme, &difficulty, &encounter_id)
}

/// Добыча встречи по уже приведённым строкам: тема и сложность вне таблиц
/// становятся `generic` и `medium`. Стопок — 1/2/3 по сложности, каждая
/// следующая из более дорогой ступени (с откатом вниз), без повторов.
pub fn encounter_loot(theme: &str, difficulty: &str, encounter_id: &str) -> Result<Vec<Value>, String> {
    let (selected_theme, source_pool) = LOOT_BY_THEME.iter().find(|(key, _)| *key == theme).copied().unwrap_or(LOOT_BY_THEME[10]);
    let (_, stacks, supply, ammunition) = DIFFICULTIES.iter().find(|(key, ..)| *key == difficulty).copied().unwrap_or(DIFFICULTIES[1]);
    let pool = rotated(source_pool, offset_for(selected_theme, encounter_id, source_pool.len()));
    let mut used: Vec<&str> = Vec::new();
    let mut result = Vec::new();
    for tier_index in 0..stacks {
        let Some(catalog_id) = choose_for_tier(&pool, tier_index, &used) else {
            break;
        };
        if !ITEM_LOOT_CATALOG_IDS.contains(&catalog_id) {
            return Err(format!("Catalog item {catalog_id} is not loot-eligible"));
        }
        eligible(catalog_id, "encounter loot")?;
        used.push(catalog_id);
        result.push(materialize_catalog_item(catalog_id, Some(&json!({ "quantity": quantity_for(catalog_id, supply, ammunition), "equipped": false }))));
    }
    Ok(result)
}

/// Порог редкости и шанс находки — политика сервера, а не таблица SRD:
///
/// - до 200 XP за встречу магии нет вовсе — иначе первая же стычка с крысами
///   выдаёт кольцо, и прогресс перестаёт что-либо значить;
/// - `uncommon` открывается с 200 XP и выпадает примерно в четверти встреч;
/// - `rare` открывается с 700 XP и выпадает примерно в восьмой части.
///
/// Больше одного магического предмета за встречу не выдаётся никогда.
const MAGIC_LOOT_TIERS: [(&str, f64, u64); 2] = [("rare", 700.0, 12), ("uncommon", 200.0, 25)];

fn magic_rarity_of(catalog_id: &str) -> String {
    js::s(catalog_item(catalog_id).and_then(|entry| entry.get("magic_item")).and_then(|magic| magic.get("rarity")))
}

/// `serverEncounterMagicLoot({ encounterId, totalXp })` над объектом
/// параметров JS (отсутствующее поле — пустой id и 0 XP); ноль или один
/// предмет.
pub fn server_encounter_magic_loot(options: Option<&Value>) -> Result<Vec<Value>, String> {
    if matches!(options, Some(Value::Null)) {
        return Err("Cannot read properties of null (reading 'encounterId')".into());
    }
    let encounter_id = field(options, "encounterId").map_or_else(String::new, |id| js::string(Some(id)));
    let total_xp = field(options, "totalXp").map_or(0.0, |xp| js::number(Some(xp)));
    encounter_magic_loot(&encounter_id, total_xp)
}

/// Магическая находка по уже приведённым значениям (`totalXp` — `Number(…)`).
pub fn encounter_magic_loot(encounter_id: &str, total_xp: f64) -> Result<Vec<Value>, String> {
    let xp = js_max(0.0, or_zero(total_xp));
    let digest = hash::sha256_hex(format!("magic-loot:{encounter_id}"));
    let roll = hex_number(&digest, 0, 8) % 100;
    let Some((rarity, _, _)) = MAGIC_LOOT_TIERS.iter().find(|(_, minimum, chance)| xp >= *minimum && roll < *chance) else {
        return Ok(Vec::new());
    };
    let mut pool: Vec<&str> = ITEM_MAGIC_LOOT_CATALOG_IDS.iter().copied().filter(|catalog_id| magic_rarity_of(catalog_id) == *rarity).collect();
    // `[...set].sort()`: id каталога — ASCII, порядок байтов совпадает с UTF-16.
    pool.sort_unstable();
    if pool.is_empty() {
        return Ok(Vec::new());
    }
    let pick = (hex_number(&digest, 8, 16) % pool.len() as u64) as usize;
    let catalog_id = pool[pick];
    eligible(catalog_id, "magic loot")?;
    Ok(vec![materialize_catalog_item(catalog_id, Some(&json!({ "quantity": 1, "equipped": false })))])
}

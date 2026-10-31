//! Перенос `server/shop-assembler.mjs`: детерминированная сборка лавки по
//! типу поселения, теме, бюджету и сиду — ассортимент из серверного каталога,
//! количества в пределах поселения, распределение бюджета, персона торговца,
//! политика цены и услуга доставки. Один вход — один и тот же торговец.
//!
//! Режиссёр может предложить ассортимент (`director_intent`), но только из
//! разрешённого каталога темы, в пределах количеств и с ограниченной ценовой
//! поправкой; цен, секретов и лишних полей контракт не принимает.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::{js, re, text};
use sk_items::item_catalog::{catalog_item, materialize_catalog_item, ITEM_CATALOG_SOURCE, ITEM_SHOP_CATALOG_IDS};

use crate::merchant_economy::{normalize_merchant, ECONOMY_CATALOG_VERSION};
use crate::support::{hex8, plain, sha256_hex, stringify, utf16_len};

pub const SHOP_PROPOSAL_VERSION: &str = "skazanie:shop-proposal-v2";

/// `SHOP_ASSEMBLER_LIMITS`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShopAssemblerLimits {
    pub minimum_budget_cp: i64,
    pub maximum_budget_cp: i64,
    pub maximum_location_length: usize,
    pub maximum_location_id_length: usize,
    pub maximum_seed_length: usize,
    pub minimum_agent_adjustment_bps: i64,
    pub maximum_agent_adjustment_bps: i64,
}

pub const SHOP_ASSEMBLER_LIMITS: ShopAssemblerLimits = ShopAssemblerLimits {
    minimum_budget_cp: 100,
    maximum_budget_cp: 1_000_000,
    maximum_location_length: 180,
    maximum_location_id_length: 120,
    maximum_seed_length: 120,
    minimum_agent_adjustment_bps: -2_000,
    maximum_agent_adjustment_bps: 2_000,
};

impl ShopAssemblerLimits {
    /// Форма JS.
    pub fn to_json(&self) -> Value {
        json!({
            "minimum_budget_cp": self.minimum_budget_cp,
            "maximum_budget_cp": self.maximum_budget_cp,
            "maximum_location_length": self.maximum_location_length,
            "maximum_location_id_length": self.maximum_location_id_length,
            "maximum_seed_length": self.maximum_seed_length,
            "minimum_agent_adjustment_bps": self.minimum_agent_adjustment_bps,
            "maximum_agent_adjustment_bps": self.maximum_agent_adjustment_bps,
        })
    }
}

/// Профиль поселения: сколько видов товара, сколько единиц, наценка, СЛ торга.
#[derive(Debug, Clone, Copy)]
struct Settlement {
    name: &'static str,
    max_skus: usize,
    max_quantity_per_sku: i64,
    buy_markup_bps: i64,
    bargain_dc: i64,
}

const SETTLEMENTS: [Settlement; 5] = [
    Settlement { name: "village", max_skus: 6, max_quantity_per_sku: 20, buy_markup_bps: 11_000, bargain_dc: 14 },
    Settlement { name: "town", max_skus: 8, max_quantity_per_sku: 30, buy_markup_bps: 10_750, bargain_dc: 15 },
    Settlement { name: "city", max_skus: 12, max_quantity_per_sku: 60, buy_markup_bps: 10_500, bargain_dc: 16 },
    Settlement { name: "outpost", max_skus: 6, max_quantity_per_sku: 24, buy_markup_bps: 11_500, bargain_dc: 15 },
    Settlement { name: "traveling", max_skus: 5, max_quantity_per_sku: 12, buy_markup_bps: 11_250, bargain_dc: 14 },
];

pub const SHOP_SETTLEMENT_TYPES: [&str; 5] = ["village", "town", "city", "outpost", "traveling"];
pub const SHOP_THEMES: [&str; 4] = ["general", "provisions", "arms", "healing"];

const PROVISIONS: [&str; 6] = ["srd_5_2_1:explorers-pack", "srd_5_2_1:potion-of-healing", "srd_5_2_1:rations-one-day", "srd_5_2_1:rope-hempen-50-feet", "srd_5_2_1:torch", "srd_5_2_1:arrows-20"];
const ARMS: [&str; 7] = ["srd_5_2_1:dagger", "srd_5_2_1:longsword", "srd_5_2_1:longbow", "srd_5_2_1:shortbow", "srd_5_2_1:leather-armor", "srd_5_2_1:shield", "srd_5_2_1:arrows-20"];
const HEALING: [&str; 5] = ["srd_5_2_1:potion-of-healing", "srd_5_2_1:rations-one-day", "srd_5_2_1:explorers-pack", "srd_5_2_1:rope-hempen-50-feet", "srd_5_2_1:torch"];

/// Разрешённый каталог темы.
fn theme_catalog(theme: &str) -> &'static [&'static str] {
    match theme {
        "general" => ITEM_SHOP_CATALOG_IDS.as_slice(),
        "provisions" => &PROVISIONS,
        "arms" => &ARMS,
        "healing" => &HEALING,
        _ => &[],
    }
}

struct Persona {
    template_id: &'static str,
    name: &'static str,
    title: &'static str,
    description: &'static str,
    greeting: &'static str,
    voice: &'static str,
    initials: &'static str,
}

const PERSONAS: [Persona; 4] = [
    Persona {
        template_id: "careful-quartermaster",
        name: "Элва Камнеключ",
        title: "Снабженец с безупречным учётом",
        description: "Проверяет каждую поставку и держит товары в образцовом порядке.",
        greeting: "Смотрите спокойно. Всё, что лежит на прилавке, уже пересчитано.",
        voice: "Говорит коротко, уверенно и называет точные условия сделки.",
        initials: "ЭК",
    },
    Persona {
        template_id: "road-provisioner",
        name: "Мартен Рыжий",
        title: "Торговец дорожными припасами",
        description: "Знает нужды путешественников и не обещает того, чего нет на складе.",
        greeting: "Подходите. Сначала выберем товар, потом обсудим условия.",
        voice: "Говорит живо и дружелюбно, но внимательно считает монеты.",
        initials: "МР",
    },
    Persona {
        template_id: "guild-factor",
        name: "Илара Медный Перст",
        title: "Представитель торговой гильдии",
        description: "Ценит надёжные сделки, происхождение товара и ясные договорённости.",
        greeting: "Каталог перед вами. Если хотите торговаться — приводите доводы.",
        voice: "Вежлива, наблюдательна и не меняет цену без причины.",
        initials: "ИМ",
    },
    Persona {
        template_id: "frontier-trader",
        name: "Торрен Вяз",
        title: "Пограничный торговец",
        description: "Собирает практичное снаряжение для опасных дорог и далёких застав.",
        greeting: "Берите то, что поможет вернуться живыми. Остальное подождёт.",
        voice: "Говорит негромко, прямо и без лишних обещаний.",
        initials: "ТВ",
    },
];

const TOP_LEVEL_KEYS: [&str; 7] = ["location", "location_id", "settlement_type", "theme", "seed", "budget_cp", "director_intent"];
const DIRECTOR_KEYS: [&str; 2] = ["stock", "agent_adjustment_bps"];
const DIRECTOR_STOCK_KEYS: [&str; 2] = ["catalog_id", "quantity"];

/// Отказ сборщика (`ShopAssemblyError`): код и текст — как в JS.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct ShopAssemblyError {
    pub code: String,
    pub message: String,
}

fn reject<T>(message: impl Into<String>, code: &str) -> Result<T, ShopAssemblyError> {
    Err(ShopAssemblyError { code: code.into(), message: message.into() })
}

fn reject_unexpected_keys(value: &Map<String, Value>, allowed: &[&str], code: &str) -> Result<(), ShopAssemblyError> {
    if value.keys().any(|key| !allowed.contains(&key.as_str())) {
        return reject("Вход содержит поле, не разрешённое контрактом сборщика магазина", code);
    }
    Ok(())
}

fn bounded_text(value: Option<&Value>, maximum: usize, code: &str, label: &str) -> Result<String, ShopAssemblyError> {
    let Some(Value::String(raw)) = value else {
        return reject(format!("{label} должно быть строкой"), code);
    };
    let result = text::trim(raw).to_string();
    if result.is_empty() || utf16_len(&result) > maximum || text::test(re!(r"[\u0000-\u001f\u007f]", "u"), &result) {
        return reject(format!("{label} не прошло проверку границ"), code);
    }
    Ok(result)
}

fn deterministic_integer(seed: &str, label: &str, maximum_exclusive: u64) -> u64 {
    hex8(&sha256_hex(&format!("{seed}\u{0}{label}"))) % maximum_exclusive
}

fn deterministic_order(values: &[String], seed: &str, label: &str) -> Vec<String> {
    let hashes: HashMap<&String, String> = values.iter().map(|value| (value, sha256_hex(&format!("{seed}\u{0}{label}\u{0}{value}")))).collect();
    let mut ordered: Vec<String> = values.to_vec();
    ordered.sort_by(|left, right| match text::locale_compare(&hashes[left], &hashes[right]) {
        Ordering::Equal => text::locale_compare(left, right),
        other => other,
    });
    ordered
}

fn is_safe_number(value: Option<&Value>) -> Option<i64> {
    js::is_safe_integer(value).then(|| js::number(value) as i64)
}

struct Validated {
    location: String,
    location_id: String,
    seed: String,
    settlement: Settlement,
    theme: &'static str,
    budget_cp: i64,
    /// `{ stock: [{ catalog_id, quantity }], agent_adjustment_bps }`.
    director_intent: Option<(Vec<(String, i64)>, i64)>,
}

fn validate_director_intent(input: Option<&Value>, theme: &str, settlement: &Settlement) -> Result<Option<(Vec<(String, i64)>, i64)>, ShopAssemblyError> {
    if !js::present(input) {
        return Ok(None);
    }
    let Some(intent) = plain(input) else {
        return reject("director_intent должен быть объектом", "INVALID_DIRECTOR_INTENT");
    };
    reject_unexpected_keys(intent, &DIRECTOR_KEYS, "UNEXPECTED_DIRECTOR_FIELD")?;
    let entries = match intent.get("stock") {
        Some(Value::Array(entries)) if !entries.is_empty() => entries,
        _ => return reject("director_intent.stock должен быть непустым массивом", "INVALID_DIRECTOR_STOCK"),
    };
    if entries.len() > settlement.max_skus {
        return reject("Режиссёр запросил слишком много видов товара", "DIRECTOR_SKU_LIMIT_EXCEEDED");
    }
    let allowed: HashSet<&str> = theme_catalog(theme).iter().copied().collect();
    let mut seen = HashSet::new();
    let mut stock = Vec::with_capacity(entries.len());
    for entry in entries {
        let Some(entry) = plain(Some(entry)) else {
            return reject("Запись stock должна быть объектом", "INVALID_DIRECTOR_STOCK_ENTRY");
        };
        reject_unexpected_keys(entry, &DIRECTOR_STOCK_KEYS, "UNEXPECTED_DIRECTOR_STOCK_FIELD")?;
        let catalog_id = match entry.get("catalog_id") {
            Some(Value::String(id)) if allowed.contains(id.as_str()) => id.clone(),
            _ => return reject("catalog_id не входит в разрешённый каталог выбранной темы", "CATALOG_ID_NOT_ALLOWED"),
        };
        if !seen.insert(catalog_id.clone()) {
            return reject("catalog_id повторяется", "DUPLICATE_CATALOG_ID");
        }
        let quantity = match is_safe_number(entry.get("quantity")) {
            Some(quantity) if (1..=settlement.max_quantity_per_sku).contains(&quantity) => quantity,
            _ => return reject("Количество товара выходит за разрешённые границы", "DIRECTOR_QUANTITY_OUT_OF_RANGE"),
        };
        stock.push((catalog_id, quantity));
    }
    stock.sort_by(|left, right| text::locale_compare(&left.0, &right.0));
    let zero = json!(0);
    let adjustment_value = intent.get("agent_adjustment_bps").filter(|value| !value.is_null()).unwrap_or(&zero);
    let adjustment = match is_safe_number(Some(adjustment_value)) {
        Some(adjustment) if (SHOP_ASSEMBLER_LIMITS.minimum_agent_adjustment_bps..=SHOP_ASSEMBLER_LIMITS.maximum_agent_adjustment_bps).contains(&adjustment) => adjustment,
        _ => return reject("Ценовое отклонение режиссёра выходит за разрешённые границы", "DIRECTOR_ADJUSTMENT_OUT_OF_RANGE"),
    };
    Ok(Some((stock, adjustment)))
}

fn validate_input(input: Option<&Value>) -> Result<Validated, ShopAssemblyError> {
    let Some(source) = plain(input) else {
        return reject("Вход сборщика должен быть объектом", "INVALID_SHOP_INPUT");
    };
    reject_unexpected_keys(source, &TOP_LEVEL_KEYS, "UNEXPECTED_SHOP_FIELD")?;
    let limits = SHOP_ASSEMBLER_LIMITS;
    let location = bounded_text(source.get("location"), limits.maximum_location_length, "INVALID_LOCATION", "location")?;
    let location_id = match source.get("location_id") {
        None => String::new(),
        value => bounded_text(value, limits.maximum_location_id_length, "INVALID_LOCATION_ID", "location_id")?,
    };
    let seed = bounded_text(source.get("seed"), limits.maximum_seed_length, "INVALID_SEED", "seed")?;
    let settlement = match source.get("settlement_type") {
        Some(Value::String(kind)) => SETTLEMENTS.iter().find(|settlement| settlement.name == kind).copied(),
        _ => None,
    };
    let Some(settlement) = settlement else {
        return reject("Неизвестный тип поселения", "SETTLEMENT_TYPE_NOT_ALLOWED");
    };
    let theme = match source.get("theme") {
        Some(Value::String(theme)) => SHOP_THEMES.iter().find(|known| **known == theme).copied(),
        _ => None,
    };
    let Some(theme) = theme else {
        return reject("Неизвестная тема магазина", "SHOP_THEME_NOT_ALLOWED");
    };
    let budget_cp = match is_safe_number(source.get("budget_cp")) {
        Some(budget) if (limits.minimum_budget_cp..=limits.maximum_budget_cp).contains(&budget) => budget,
        _ => return reject("Бюджет магазина выходит за разрешённые границы", "SHOP_BUDGET_OUT_OF_RANGE"),
    };
    let director_intent = validate_director_intent(source.get("director_intent"), theme, &settlement)?;
    Ok(Validated { location, location_id, seed, settlement, theme, budget_cp, director_intent })
}

fn base_price(catalog_id: &str) -> i64 {
    catalog_item(catalog_id).and_then(|entry| entry.get("base_price_cp")).and_then(Value::as_i64).unwrap_or(0)
}

fn desired_stock(validated: &Validated, assembly_seed: &str) -> Vec<(String, i64)> {
    if let Some((stock, _)) = &validated.director_intent {
        return stock.clone();
    }
    let affordable: Vec<String> = theme_catalog(validated.theme).iter().filter(|catalog_id| base_price(catalog_id) <= validated.budget_cp).map(|catalog_id| (*catalog_id).to_string()).collect();
    deterministic_order(&affordable, assembly_seed, "default-catalog")
        .into_iter()
        .take(validated.settlement.max_skus)
        .map(|catalog_id| {
            let quantity = 1 + deterministic_integer(assembly_seed, &format!("quantity:{catalog_id}"), validated.settlement.max_quantity_per_sku as u64) as i64;
            (catalog_id, quantity)
        })
        .collect()
}

/// Распределение бюджета: сначала по единице каждого доступного товара,
/// затем по кругу до запрошенного количества.
fn allocate_stock(desired: &[(String, i64)], budget_cp: i64, assembly_seed: &str) -> (Vec<(String, i64)>, i64) {
    let mut targets: Vec<(String, i64)> = Vec::new();
    for (catalog_id, quantity) in desired {
        match targets.iter_mut().find(|(known, _)| known == catalog_id) {
            Some(entry) => entry.1 = *quantity,
            None => targets.push((catalog_id.clone(), *quantity)),
        }
    }
    let keys: Vec<String> = targets.iter().map(|(catalog_id, _)| catalog_id.clone()).collect();
    let order = deterministic_order(&keys, assembly_seed, "allocation");
    let target_of = |catalog_id: &str| targets.iter().find(|(known, _)| known == catalog_id).map_or(0, |(_, quantity)| *quantity);
    let mut allocated: Vec<(String, i64)> = order.iter().map(|catalog_id| (catalog_id.clone(), 0)).collect();
    let mut remaining = budget_cp;
    for entry in allocated.iter_mut() {
        let unit = base_price(&entry.0);
        if unit <= remaining {
            entry.1 = 1;
            remaining -= unit;
        }
    }
    let mut changed = true;
    while changed {
        changed = false;
        for entry in allocated.iter_mut() {
            let target = target_of(&entry.0);
            let unit = base_price(&entry.0);
            if entry.1 < target && unit <= remaining {
                entry.1 += 1;
                remaining -= unit;
                changed = true;
            }
        }
    }
    (allocated.into_iter().filter(|(_, quantity)| *quantity > 0).collect(), budget_cp - remaining)
}

fn stock_entry(catalog_id: &str, quantity: i64, merchant_id: &str) -> Value {
    let source_version = catalog_item(catalog_id).and_then(|entry| entry.get("source_version")).cloned();
    let tail = catalog_id.rsplit(':').next().unwrap_or("");
    let short_id = text::head(&text::replace_all(re!(r"[^a-z0-9-]", "giu"), tail, "-"), 70);
    let mut instance = Map::new();
    instance.insert("stock_id".into(), json!(text::head(&format!("{merchant_id}-{short_id}"), 120)));
    instance.insert("quantity".into(), json!(quantity));
    instance.insert("rarity".into(), json!("обычный"));
    instance.insert("price_provenance".into(), json!("catalog"));
    if let Some(version) = source_version {
        instance.insert("price_source_version".into(), version);
    }
    materialize_catalog_item(catalog_id, Some(&Value::Object(instance)))
}

/// `ShopAssembler`: сборщик лавки без состояния.
#[derive(Debug, Default, Clone, Copy)]
pub struct ShopAssembler;

impl ShopAssembler {
    /// `assemble(input)`: предложение торговца или отказ контракта.
    pub fn assemble(&self, input: Option<&Value>) -> Result<Value, ShopAssemblyError> {
        let validated = validate_input(input)?;
        let director_value = validated.director_intent.as_ref().map_or(Value::Null, |(stock, adjustment)| {
            json!({
                "stock": stock.iter().map(|(catalog_id, quantity)| json!({ "catalog_id": catalog_id, "quantity": quantity })).collect::<Vec<_>>(),
                "agent_adjustment_bps": adjustment,
            })
        });
        let canonical = stringify(&json!({
            "location": validated.location,
            "location_id": validated.location_id,
            "settlement_type": validated.settlement.name,
            "theme": validated.theme,
            "seed": validated.seed,
            "budget_cp": validated.budget_cp,
            "director_intent": director_value,
        }));
        let assembly_seed = sha256_hex(&format!("{SHOP_PROPOSAL_VERSION}\u{0}{canonical}"));
        let desired = desired_stock(&validated, &assembly_seed);
        let (entries, spent_cp) = allocate_stock(&desired, validated.budget_cp, &assembly_seed);
        if entries.is_empty() {
            return reject("Бюджет не позволяет выставить ни один выбранный товар", "BUDGET_CANNOT_FUND_STOCK");
        }
        let proposal_id = format!("shop-proposal-{}", &assembly_seed[..24]);
        let merchant_id = format!("shop-{}", &assembly_seed[..16]);
        let persona = &PERSONAS[deterministic_integer(&assembly_seed, "persona", PERSONAS.len() as u64) as usize];
        let adjustment = validated.director_intent.as_ref().map_or(0, |(_, adjustment)| *adjustment);
        let stock: Vec<Value> = entries.iter().map(|(catalog_id, quantity)| stock_entry(catalog_id, *quantity, &merchant_id)).collect();
        let targets: Vec<Value> = stock.iter().map(|entry| json!({ "stock_id": entry["stock_id"], "target_quantity": entry["quantity"] })).collect();
        let budget = validated.budget_cp;
        let settlement = validated.settlement;
        let merchant = normalize_merchant(
            Some(&json!({
                "id": merchant_id,
                "name": persona.name,
                "title": persona.title,
                "description": persona.description,
                "greeting": persona.greeting,
                "voice": persona.voice,
                "initials": persona.initials,
                "location": validated.location,
                "location_id": validated.location_id,
                "available": true,
                "purse_cp": (budget / 4).clamp(100, 100_000),
                "pricing": {
                    "mode": "catalog_with_agent_adjustment",
                    "catalog_id": ECONOMY_CATALOG_VERSION,
                    "buy_markup_bps": settlement.buy_markup_bps,
                    "sell_rate_bps": 5_000,
                    "bargain_dc": settlement.bargain_dc,
                    "success_discount_bps": 1_000,
                    "failure_markup_bps": 500,
                    "min_multiplier_bps": 1_000,
                    "max_multiplier_bps": 30_000,
                    "agent_adjustment_bps": adjustment,
                    "agent_adjustment_limit_percent": 20,
                    "description": "Каталожная SRD-цена с ограниченной политикой конкретного торговца.",
                },
                "stock": stock,
                "services": [{
                    "service_id": format!("{merchant_id}-delivery"),
                    "name": "Доставка покупки",
                    "description": "Лавка подготовит и передаст обычный товар в пределах текущего поселения.",
                    "kind": "transport",
                    "base_price_cp": (budget / 1_000).clamp(10, 500),
                    "duration_minutes": 30,
                }],
                "restock_policy": { "enabled": true, "interval_minutes": 1_440, "targets": targets },
            })),
            0,
        );
        Ok(json!({
            "proposal_type": "merchant",
            "proposal_version": SHOP_PROPOSAL_VERSION,
            "proposal_id": proposal_id,
            "source": "deterministic-shop-assembler",
            "seed_fingerprint": &assembly_seed[..16],
            "catalog": {
                "id": ECONOMY_CATALOG_VERSION,
                "source_version": ITEM_CATALOG_SOURCE["source_version"],
                "source_sha256": ITEM_CATALOG_SOURCE["source_sha256"],
            },
            "constraints": {
                "settlement_type": settlement.name,
                "theme": validated.theme,
                "budget_cp": budget,
                "allocated_base_value_cp": spent_cp,
                "max_skus": settlement.max_skus,
                "max_quantity_per_sku": settlement.max_quantity_per_sku,
                "agent_adjustment_min_bps": SHOP_ASSEMBLER_LIMITS.minimum_agent_adjustment_bps,
                "agent_adjustment_max_bps": SHOP_ASSEMBLER_LIMITS.maximum_agent_adjustment_bps,
            },
            "persona_template_id": persona.template_id,
            "merchant": merchant,
        }))
    }
}

/// `defaultShopAssembler`.
pub static DEFAULT_SHOP_ASSEMBLER: LazyLock<ShopAssembler> = LazyLock::new(ShopAssembler::default);

/// `assembleShop(input)`.
pub fn assemble_shop(input: Option<&Value>) -> Result<Value, ShopAssemblyError> {
    DEFAULT_SHOP_ASSEMBLER.assemble(input)
}

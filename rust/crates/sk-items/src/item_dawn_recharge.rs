//! Перенос `server/item-dawn-recharge.mjs`: рассветная перезарядка предметов
//! героев (жезл волшебных стрел, Слеза рыцаря, самодельные вещи с профилем
//! «рассвет, 1к6+1»).
//!
//! Все случайные числа появляются в [`resolve_item_dawn_recharge`] до commit,
//! через внедрённый [`Dice`]; payload события самодостаточен, и редьюсер
//! [`apply_item_dawn_recharge_to_players`] не знает ни о костях, ни о текущем
//! каталоге — старое событие воспроизводит ровно зафиксированный результат.

use serde_json::{json, Map, Value};
use sk_core::{indexmap::IndexMap, js, text, RuleError};
use sk_dice::{Dice, Visibility};

use crate::item_catalog::{catalog_item, catalog_item_truthy, item_recharge_profile, normalize_item_recharge_profile};
use crate::support::{coalesce, field, js_max, or_zero};

pub const DAWN_PERIOD_MINUTES: i64 = 1_440;
pub const MAX_DAWN_RECHARGE_ITEMS_PER_EVENT: usize = 64;
pub const MAX_DAWN_RECHARGE_ROLLS_PER_ITEM: i64 = 4;
pub const ITEM_DAWN_RECHARGE_EVENT_SCHEMA_VERSION: i64 = 1;

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// `clean(value, maximum)`: `String(value ?? '').trim().slice(0, maximum)`.
fn clean(value: Option<&Value>, maximum: usize) -> String {
    text::head(text::trim(&js::s(value)), maximum)
}

fn owner_id(owner: Option<&Value>) -> String {
    clean(coalesce(field(owner, "id"), field(owner, "actor_id")), 120)
}

fn item_id(item: Option<&Value>) -> String {
    clean(coalesce(field(item, "id"), field(item, "item_id")), 120)
}

/// `boundedWorldMinute(value)` для уже приведённого целого: небезопасное
/// целое в JS не проходит `safeInteger` и становится нулём.
fn bounded(minute: i64) -> i64 {
    if minute.abs() > MAX_SAFE_INTEGER {
        0
    } else {
        minute.clamp(0, MAX_SAFE_INTEGER)
    }
}

/// `boundedWorldMinute(value)` над JSON.
fn bounded_world_minute(value: Option<&Value>) -> i64 {
    bounded(js::safe_int(value, 0))
}

fn add_world_minutes(before: i64, elapsed: i64) -> i64 {
    let before = bounded(before);
    let elapsed = bounded(elapsed);
    before + elapsed.min(MAX_SAFE_INTEGER - before)
}

/// `dawnCrossings(elapsedMinutesBefore, elapsedMinutes)`: сколько рассветов
/// пересекают часы. Нулевая отметка campaign clock считается рассветом
/// первого дня, поэтому пересечение 1440, 2880, … минут — новый рассвет, а
/// старт на нуле сам по себе ничего не перезаряжает. Деление — в дробях, как
/// в JS: у самой границы безопасного целого округление `after / 1440` может
/// перешагнуть день.
pub fn dawn_crossings(elapsed_minutes_before: i64, elapsed_minutes: i64) -> i64 {
    let before = bounded(elapsed_minutes_before);
    let after = add_world_minutes(before, elapsed_minutes);
    let period = DAWN_PERIOD_MINUTES as f64;
    let crossed = (after as f64 / period).floor() - (before as f64 / period).floor();
    js_max(0.0, crossed) as i64
}

/// Кто вправе перезаряжать вещь и до скольких зарядов.
struct Authority {
    profile: Value,
    maximum: i64,
}

/// `effectiveRecharge(item)`: известный каталогу id берёт профиль только из
/// каталога (поддельный `recharge` экземпляра игнорируется), самодельная вещь
/// — свой профиль, если он исполним, и до миллиона зарядов.
fn effective_recharge(item: Option<&Value>) -> Option<Authority> {
    let catalog_id = clean(coalesce(field(item, "catalog_id"), field(item, "catalogId")), 120);
    if !catalog_id.is_empty() && catalog_item_truthy(&catalog_id) {
        let profile = item_recharge_profile(&catalog_id);
        let maximum = js_max(0.0, or_zero(js::number(field(field(catalog_item(&catalog_id), "charges"), "max"))));
        return profile.filter(|_| maximum > 0.0).map(|profile| Authority { profile, maximum: maximum as i64 });
    }
    let profile = normalize_item_recharge_profile(field(item, "recharge"));
    let maximum = js::safe_int(field(field(item, "charges"), "max"), 0).clamp(0, 1_000_000);
    profile.filter(|_| maximum > 0).map(|profile| Authority { profile, maximum })
}

struct Candidate {
    owner_id: String,
    item_id: String,
    /// `catalog_id` экземпляра, если он истинен (после `clean` может стать пустым).
    catalog_id: Option<String>,
    profile: Value,
    current: i64,
    maximum: i64,
}

/// `[...list].sort((a, b) => key(a).localeCompare(key(b), 'en'))`: у `en`
/// нет своей настройки сортировки, это корневая ICU — как `text::locale_compare`.
fn sorted_by_key<'a>(list: Option<&'a Value>, key: impl Fn(&Value) -> String) -> Vec<&'a Value> {
    let mut keyed: Vec<(String, &Value)> = list.and_then(Value::as_array).into_iter().flatten().map(|value| (key(value), value)).collect();
    keyed.sort_by(|(left, _), (right, _)| text::locale_compare(left, right));
    keyed.into_iter().map(|(_, value)| value).collect()
}

fn recharge_candidates(state: &Value) -> Vec<Candidate> {
    let mut candidates = Vec::new();
    for owner in sorted_by_key(state.get("players"), |owner| owner_id(Some(owner))) {
        let id = owner_id(Some(owner));
        if id.is_empty() {
            continue;
        }
        for item in sorted_by_key(owner.get("inventory"), |item| item_id(Some(item))) {
            if js::safe_int(item.get("quantity"), 1) <= 0 {
                continue;
            }
            let item_id = item_id(Some(item));
            let authority = effective_recharge(Some(item));
            let Some(authority) = authority.filter(|_| !item_id.is_empty()) else {
                continue;
            };
            let current = js::safe_int(field(item.get("charges"), "current"), authority.maximum).min(authority.maximum).max(0);
            if current >= authority.maximum {
                continue;
            }
            candidates.push(Candidate {
                owner_id: id.clone(),
                item_id,
                catalog_id: js::truthy(item.get("catalog_id")).then(|| clean(item.get("catalog_id"), 120)),
                profile: authority.profile,
                current,
                maximum: authority.maximum,
            });
        }
    }
    candidates
}

/// Итог [`resolve_item_dawn_recharge`]: payload события (`None` — события
/// нет) и броски для журнала.
#[derive(Debug, Clone, PartialEq)]
pub struct ItemDawnRecharge {
    pub payload: Option<Value>,
    pub rolls: Vec<Value>,
}

impl ItemDawnRecharge {
    /// Форма JS: `{ payload, rolls }`.
    pub fn to_json(&self) -> Value {
        json!({ "payload": self.payload.clone().unwrap_or(Value::Null), "rolls": self.rolls })
    }
}

/// `resolveItemDawnRecharge(state, elapsedMinutes, diceService)`: перезарядка
/// за прошедшее время. Герои и их вещи идут в порядке `localeCompare` по id;
/// каждый предмет бросает «1к6+1» на каждый пересечённый рассвет, но не чаще
/// [`MAX_DAWN_RECHARGE_ROLLS_PER_ITEM`] раз и не дальше полного заряда.
/// Больше [`MAX_DAWN_RECHARGE_ITEMS_PER_EVENT`] предметов — отказ
/// `ITEM_DAWN_RECHARGE_LIMIT_EXCEEDED` до первого броска.
pub fn resolve_item_dawn_recharge(state: &Value, elapsed_minutes: Option<&Value>, dice: &mut dyn Dice) -> Result<ItemDawnRecharge, RuleError> {
    let world_time = field(field(state.get("mechanics"), "world_time"), "elapsed_minutes");
    let before_minute = bounded_world_minute(world_time);
    let elapsed = bounded_world_minute(elapsed_minutes);
    let after_minute = add_world_minutes(before_minute, elapsed);
    let crossings = dawn_crossings(before_minute, elapsed);
    if crossings <= 0 {
        return Ok(ItemDawnRecharge { payload: None, rolls: Vec::new() });
    }

    let candidates = recharge_candidates(state);
    if candidates.len() > MAX_DAWN_RECHARGE_ITEMS_PER_EVENT {
        return Err(RuleError::new(
            "ITEM_DAWN_RECHARGE_LIMIT_EXCEEDED",
            format!("Одна команда может перезарядить не более {MAX_DAWN_RECHARGE_ITEMS_PER_EVENT} предметов"),
        ));
    }

    let mut rolls = Vec::new();
    let mut items = Vec::new();
    for candidate in candidates {
        let maximum_useful_rolls = ((candidate.maximum - candidate.current) as f64 / 2.0).ceil() as i64;
        let roll_count = crossings.min(maximum_useful_rolls).min(MAX_DAWN_RECHARGE_ROLLS_PER_ITEM);
        let formula = js::s(candidate.profile.get("formula"));
        let purpose = format!("item-dawn-recharge:{}", candidate.item_id);
        let mut current = candidate.current;
        let mut item_rolls = Vec::new();
        let mut index = 0;
        while index < roll_count && current < candidate.maximum {
            let roll = serde_json::to_value(dice.roll(&formula, &purpose, Some(&candidate.owner_id), Visibility::GmOnly)?).unwrap_or(Value::Null);
            let restored = js::safe_int(roll.get("total"), 0).max(0);
            let before = current;
            current = candidate.maximum.min(current + restored);
            let mut recorded = match &roll {
                Value::Object(map) => map.clone(),
                _ => Map::new(),
            };
            recorded.insert("dawn_index".into(), json!(index + 1));
            recorded.insert("charges_before".into(), json!(before));
            recorded.insert("charges_after".into(), json!(current));
            recorded.insert("restored_charges".into(), json!(current - before));
            rolls.push(roll);
            item_rolls.push(Value::Object(recorded));
            index += 1;
        }
        if current <= candidate.current {
            continue;
        }
        let mut item = Map::new();
        item.insert("owner_id".into(), json!(candidate.owner_id));
        item.insert("item_id".into(), json!(candidate.item_id));
        if let Some(catalog_id) = candidate.catalog_id.filter(|catalog_id| !catalog_id.is_empty()) {
            item.insert("catalog_id".into(), json!(catalog_id));
        }
        item.insert("recharge".into(), candidate.profile);
        item.insert("before".into(), json!(candidate.current));
        item.insert("after".into(), json!(current));
        item.insert("max".into(), json!(candidate.maximum));
        item.insert("rolls".into(), Value::Array(item_rolls));
        items.push(Value::Object(item));
    }

    let payload = (!items.is_empty()).then(|| {
        json!({
            "schema_version": ITEM_DAWN_RECHARGE_EVENT_SCHEMA_VERSION,
            "trigger": "dawn",
            "elapsed_minutes_before": before_minute,
            "elapsed_minutes_after": after_minute,
            "dawns_crossed": crossings,
            "items": items,
        })
    });
    Ok(ItemDawnRecharge { payload, rolls })
}

/// `applyItemDawnRechargeToPlayers(players, event)`: редьюсер только по
/// payload. Неверсионированное событие или неизвестная версия payload не
/// меняют ничего (fail-closed); записей не больше
/// [`MAX_DAWN_RECHARGE_ITEMS_PER_EVENT`]. Не массив героев — пустой массив.
pub fn apply_item_dawn_recharge_to_players(players: &Value, event: &Value) -> Value {
    let unchanged = || match players {
        Value::Array(_) => players.clone(),
        _ => Value::Array(Vec::new()),
    };
    let version = ITEM_DAWN_RECHARGE_EVENT_SCHEMA_VERSION as f64;
    let payload = event.get("payload");
    if js::number(event.get("event_schema_version")) != version || js::number(field(payload, "schema_version")) != version {
        return unchanged();
    }
    let entries: Vec<&Value> = field(payload, "items").and_then(Value::as_array).map(|items| items.iter().take(MAX_DAWN_RECHARGE_ITEMS_PER_EVENT).collect()).unwrap_or_default();
    if entries.is_empty() {
        return unchanged();
    }
    let mut by_owner: IndexMap<String, IndexMap<String, Value>> = IndexMap::new();
    for entry in entries {
        let owner = clean(entry.get("owner_id"), 120);
        let item = clean(entry.get("item_id"), 120);
        let maximum = js::safe_int(entry.get("max"), 0).clamp(0, 1_000_000);
        let after = js::safe_int(entry.get("after"), 0).min(maximum).max(0);
        if owner.is_empty() || item.is_empty() || maximum <= 0 {
            continue;
        }
        by_owner.entry(owner).or_default().insert(item, json!({ "current": after, "max": maximum }));
    }
    let Value::Array(list) = players else {
        return Value::Array(Vec::new());
    };
    Value::Array(
        list.iter()
            .map(|owner| {
                let Some(owner_entries) = by_owner.get(&owner_id(Some(owner))) else {
                    return owner.clone();
                };
                let inventory: Vec<Value> = owner
                    .get("inventory")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .map(|item| match owner_entries.get(&item_id(Some(item))) {
                        Some(charges) => js::spread(item, json!({ "charges": charges })),
                        None => item.clone(),
                    })
                    .collect();
                js::spread(owner, json!({ "inventory": inventory }))
            })
            .collect(),
    )
}


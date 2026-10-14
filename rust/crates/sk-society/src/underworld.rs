//! Перенос `server/underworld.mjs`: изнанка торговли — скупщик краденого и подкуп.
//!
//! Оба свойства человека — «берёт краденое» и «не берёт денег» — выводятся из
//! сида, а не хранятся: в состоянии их нет, есть только следствия. Явный тег
//! автора (`скупщик`, `неподкупный`) уважается, но снять выведенное свойство
//! тегом нельзя. Подкуп меряется ступенями щедрости от опорной суммы, донос
//! честного торговца — детерминированная доля, а не бросок.

use serde_json::{json, Value};
use sk_core::js;

use crate::common::{digest, get, hex8, integer, object, s, text_trim};

pub const UNDERWORLD_POLICY_ID: &str = "skazanie:underworld-v1";

/// Тег скупщика краденого. Живёт в `tags` профиля, если автор поставил руками.
pub const FENCE_TAG: &str = "скупщик";
/// Тег неподкупного. Тот же порядок: сид или рука ведущего.
pub const INCORRUPTIBLE_TAG: &str = "неподкупный";

/// Теги, которые столу не принадлежат: игрок узнаёт их следствием, а не описью.
pub const UNDERWORLD_PRIVATE_TAGS: [&str; 2] = [FENCE_TAG, INCORRUPTIBLE_TAG];

/// Скупщик редок: примерно один торговец из семи.
pub const FENCE_SHARE: u64 = 14;

/// Неподкупных примерно один из пяти: подкуп обязан иногда взрываться в руках.
pub const INCORRUPTIBLE_SHARE: u64 = 20;

/// Скидка скупщика: он берёт краденое за ~60 % обычной цены. Слагаемое
/// отдельное и в `reputationBps` не сливается.
pub const STOLEN_DISCOUNT_BPS: i64 = 4_000;

/// Ступень щедрости подкупа: доля от опорной суммы и сдвиг СЛ.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BribeTier {
    pub id: &'static str,
    pub label: &'static str,
    pub share_bps: i64,
    pub dc_shift: i64,
}

impl BribeTier {
    /// Запись ступени в форме JS.
    pub fn to_json(&self) -> Value {
        json!({ "id": self.id, "label": self.label, "share_bps": self.share_bps, "dc_shift": self.dc_shift })
    }
}

/// Ступени щедрости подкупа. Доля от цены, а не круглые монеты.
pub const BRIBE_TIERS: [BribeTier; 3] = [
    BribeTier { id: "coin", label: "монета", share_bps: 500, dc_shift: -1 },
    BribeTier { id: "purse", label: "кошель", share_bps: 1_500, dc_shift: -2 },
    BribeTier { id: "generous", label: "щедро", share_bps: 4_000, dc_shift: -3 },
];

/// Меньше этого подкуп не бывает: медяк оскорбителен, а не убедителен.
pub const MIN_BRIBE_CP: i64 = 10;

/// Насколько подкуп бьёт по неподкупному: сдвиг в плюс.
pub const INCORRUPTIBLE_DC_PENALTY: i64 = 4;

/// Порог розыска, с которого честный торговец начинает доносить.
pub const DENUNCIATION_WANTED_LEVEL: i64 = 2;

/// Доля доносов на этом пороге. Детерминированная, а не бросок кости.
pub const DENUNCIATION_SHARE: u64 = 50;

fn text(value: Option<&Value>, maximum: usize) -> String {
    text_trim(value, maximum)
}

fn spread(seed: &str, salt: &str, size: u64) -> u64 {
    hex8(&digest(&[seed.to_string(), salt.to_string()])) % size.max(1)
}

fn tags_of(npc: &Value) -> Vec<String> {
    match get(Some(npc), "tags") {
        Some(Value::Array(tags)) => tags.iter().map(|tag| text(Some(tag), 60)).collect(),
        _ => Vec::new(),
    }
}

/// Сид свойства: в него входит поселение, а не только человек.
fn trait_seed(state: &Value, npc_id: &str, salt: &str) -> String {
    let world_map = get(Some(state), "worldMap");
    let location = match get(world_map, "currentLocationId") {
        None | Some(Value::Null) => get(get(Some(state), "scene"), "location"),
        some => some,
    };
    let settlement = text(location, 180);
    digest(&[
        text(get(Some(state), "sessionCode"), 60),
        settlement,
        text(Some(&Value::String(npc_id.to_string())), 120),
        UNDERWORLD_POLICY_ID.to_string(),
        salt.to_string(),
    ])
}

/// Берёт ли этот торговец краденое (`npcIsFence`).
pub fn npc_is_fence(state: &Value, npc: &Value) -> bool {
    let id = text(get(Some(npc), "id"), 120);
    if id.is_empty() {
        return false;
    }
    if tags_of(npc).iter().any(|tag| tag == FENCE_TAG) {
        return true;
    }
    spread(&trait_seed(state, &id, "fence"), "roll", 100) < FENCE_SHARE
}

/// Оскорбится ли этот человек предложенной монетой (`npcIsIncorruptible`).
pub fn npc_is_incorruptible(state: &Value, npc: &Value) -> bool {
    let id = text(get(Some(npc), "id"), 120);
    if id.is_empty() {
        return false;
    }
    if tags_of(npc).iter().any(|tag| tag == INCORRUPTIBLE_TAG) {
        return true;
    }
    spread(&trait_seed(state, &id, "incorruptible"), "roll", 100) < INCORRUPTIBLE_SHARE
}

/// Побежит ли честный торговец доносить (`fenceDenunciationFor`).
/// `options` — `{ wantedLevel, itemId }`, как в JS.
pub fn fence_denunciation_for(state: &Value, npc: &Value, options: &Value) -> Option<Value> {
    let wanted_level = get(Some(options), "wantedLevel");
    let wanted = integer(wanted_level, 0);
    if wanted < DENUNCIATION_WANTED_LEVEL {
        return None;
    }
    let item_id = text(get(Some(options), "itemId"), 160);
    let seed = trait_seed(state, &text(get(Some(npc), "id"), 120), &format!("denounce:{item_id}"));
    if spread(&seed, "roll", 100) >= DENUNCIATION_SHARE {
        return None;
    }
    Some(object([("npc_id", Value::String(text(get(Some(npc), "id"), 120))), ("wanted_level", Value::from(wanted))]))
}

/// Во сколько обходится каждая ступень щедрости (`bribeTierAmounts`).
pub fn bribe_tier_amounts(reference_cp: &Value) -> Vec<Value> {
    let reference = integer(Some(reference_cp), 0).max(0) as f64;
    BRIBE_TIERS
        .iter()
        .map(|tier| {
            let amount = js::max_of([MIN_BRIBE_CP as f64, js::round(reference * tier.share_bps as f64 / 10_000.0)]);
            let mut entry = tier.to_json();
            js::assign(&mut entry, json!({ "amount_cp": js::num(amount) }));
            entry
        })
        .collect()
}

/// Ступень по идентификатору (`bribeTierById`).
pub fn bribe_tier_by_id(tier_id: &Value, reference_cp: &Value) -> Option<Value> {
    let id = text(Some(tier_id), 40);
    bribe_tier_amounts(reference_cp).into_iter().find(|tier| s(tier.get("id")) == id)
}

/// Что подкуп делает со сложностью разговора (`bribeOutcomeFor`).
/// `options` — `{ incorruptible, tier }`, как в JS.
pub fn bribe_outcome_for(options: &Value) -> Value {
    let tier = get(Some(options), "tier");
    if !js::truthy(tier) {
        return json!({ "dc_shift": 0, "insulted": false });
    }
    if js::truthy(get(Some(options), "incorruptible")) {
        return json!({ "dc_shift": INCORRUPTIBLE_DC_PENALTY, "insulted": true });
    }
    let mut outcome = serde_json::Map::new();
    if let Some(shift) = get(tier, "dc_shift") {
        outcome.insert("dc_shift".into(), shift.clone());
    }
    outcome.insert("insulted".into(), Value::Bool(false));
    Value::Object(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn honest_session() -> String {
        for attempt in 0..200 {
            let code = format!("UNDER-{attempt}");
            if !npc_is_fence(&json!({ "sessionCode": code, "worldMap": { "currentLocationId": "market" } }), &json!({ "id": "merchant-1" })) {
                return code;
            }
        }
        panic!("не нашлось кампании, где этот торговец честен");
    }

    #[test]
    fn fence_is_rare_seeded_and_respects_the_gm() {
        let state = json!({ "sessionCode": honest_session(), "worldMap": { "currentLocationId": "market" } });
        let npcs: Vec<Value> = (0..400).map(|index| json!({ "id": format!("npc-{index}") })).collect();
        let fences = npcs.iter().filter(|npc| npc_is_fence(&state, npc)).count();
        assert!(fences > 0 && fences < npcs.len() / 3, "скупщиков {fences} из {}", npcs.len());
        assert_eq!(npc_is_fence(&state, &npcs[7]), npc_is_fence(&state, &npcs[7]));
        assert!(npc_is_fence(&state, &json!({ "id": "x", "tags": [FENCE_TAG] })), "явный тег автора сильнее сида");
        assert!(npc_is_incorruptible(&state, &json!({ "id": "x", "tags": [INCORRUPTIBLE_TAG] })));
        assert!(!npc_is_fence(&state, &json!({})));
    }

    #[test]
    fn bribe_tiers_scale_with_prices_and_stay_ordered() {
        let tiers = bribe_tier_amounts(&json!(10_000));
        assert_eq!(tiers.len(), BRIBE_TIERS.len());
        let ids: Vec<String> = tiers.iter().map(|tier| s(tier.get("id"))).collect();
        assert_eq!(ids, ["coin", "purse", "generous"]);
        let amounts: Vec<i64> = tiers.iter().map(|tier| tier["amount_cp"].as_i64().unwrap_or(0)).collect();
        assert!(amounts[0] < amounts[1] && amounts[1] < amounts[2]);
        let shifts: Vec<i64> = tiers.iter().map(|tier| tier["dc_shift"].as_i64().unwrap_or(0)).collect();
        assert_eq!(shifts, [-1, -2, -3]);
        for tier in bribe_tier_amounts(&json!(0)) {
            assert!(tier["amount_cp"].as_i64().unwrap_or(0) > 0);
        }
    }

    #[test]
    fn bribe_outcome_punishes_the_incorruptible() {
        let tier = BRIBE_TIERS[1].to_json();
        assert_eq!(bribe_outcome_for(&json!({ "tier": tier })), json!({ "dc_shift": -2, "insulted": false }));
        assert_eq!(bribe_outcome_for(&json!({ "tier": tier, "incorruptible": true })), json!({ "dc_shift": INCORRUPTIBLE_DC_PENALTY, "insulted": true }));
        assert_eq!(bribe_outcome_for(&json!({})), json!({ "dc_shift": 0, "insulted": false }));
        assert_eq!(bribe_outcome_for(&json!({ "tier": {} })), json!({ "insulted": false }));
    }

    #[test]
    fn denunciation_needs_the_second_wanted_level() {
        let state = json!({ "sessionCode": "S" });
        assert_eq!(fence_denunciation_for(&state, &json!({ "id": "m" }), &json!({ "wantedLevel": 1, "itemId": "x" })), None);
        let hits = (0..100).filter(|index| fence_denunciation_for(&state, &json!({ "id": "m" }), &json!({ "wantedLevel": 2, "itemId": format!("i{index}") })).is_some()).count();
        assert!(hits > 20 && hits < 80, "доносов {hits} из 100");
    }
}

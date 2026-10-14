//! Перенос `server/reputation-policy.mjs`: что репутация делает с миром.
//!
//! Репутация фракций (`autonomy.reputations`) двигает цену у торговца (±10 %),
//! СЛ социальной проверки (±3) и доступность необязательных услуг. Отношение
//! к отряду у NPC — худшее среди его фракций. Сюда же приходит розыск
//! (`law_and_order`): ступень добавляет наценку в те же базисные пункты и
//! умеет закрыть лавку.

use serde_json::{json, Map, Value};

use crate::common::{array, coalesce, get, integer, js_string, prop, s, utf16_cmp};
use crate::law_and_order::{wanted_level_here, wanted_price_bps, wanted_trade_available, WANTED_TRADE_REFUSAL_REASON};

const FACTION_TAG_PREFIX: &str = "faction:";

/// Ступень отношения к отряду.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReputationTier {
    Reviled,
    Distrusted,
    Unknown,
    Respected,
    Honoured,
}

impl ReputationTier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Reviled => "reviled",
            Self::Distrusted => "distrusted",
            Self::Unknown => "unknown",
            Self::Respected => "respected",
            Self::Honoured => "honoured",
        }
    }

    /// Поправка к цене в базисных пунктах (`REPUTATION_PRICE_BPS`).
    pub fn price_bps(self) -> i64 {
        match self {
            Self::Reviled => 1_000,
            Self::Distrusted => 500,
            Self::Unknown => 0,
            Self::Respected => -500,
            Self::Honoured => -1_000,
        }
    }

    /// Поправка к СЛ социальной проверки (`REPUTATION_SOCIAL_DC_SHIFT`).
    pub fn social_dc_shift(self) -> i64 {
        match self {
            Self::Reviled => 3,
            Self::Distrusted => 2,
            Self::Unknown => 0,
            Self::Respected => -1,
            Self::Honoured => -2,
        }
    }
}

/// Поправка к цене по ступени (`REPUTATION_PRICE_BPS`), в порядке объявления JS.
pub const REPUTATION_PRICE_BPS: [(&str, i64); 5] = [("reviled", 1_000), ("distrusted", 500), ("unknown", 0), ("respected", -500), ("honoured", -1_000)];

/// Поправка к СЛ по ступени (`REPUTATION_SOCIAL_DC_SHIFT`), в порядке объявления JS.
pub const REPUTATION_SOCIAL_DC_SHIFT: [(&str, i64); 5] = [("reviled", 3), ("distrusted", 2), ("unknown", 0), ("respected", -1), ("honoured", -2)];

fn clamp_score(value: Option<&Value>) -> i64 {
    (-100_i64).max(100_i64.min(integer(value, 0)))
}

/// Фракции NPC из тегов `faction:<id>` (`factionIdsForNpc`).
pub fn faction_ids_for_npc(npc: Option<&Value>) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for tag in array(coalesce(get(npc, "tags"), None)) {
        let tag = js_string(tag);
        if let Some(id) = tag.strip_prefix(FACTION_TAG_PREFIX) {
            if !id.is_empty() && !ids.iter().any(|known| known == id) {
                ids.push(id.to_string());
            }
        }
    }
    ids.sort_by(|a, b| utf16_cmp(a, b));
    ids
}

/// Репутация отряда в глазах NPC — худшая среди его фракций (`reputationScoreFor`).
pub fn reputation_score_for(state: &Value, npc: Option<&Value>) -> i64 {
    let reputations = coalesce(get(get(Some(state), "autonomy"), "reputations"), None);
    let factions = faction_ids_for_npc(npc);
    if factions.is_empty() {
        return 0;
    }
    factions.iter().fold(100, |worst, id| worst.min(clamp_score(prop(reputations, id))))
}

/// Ступень по очкам.
pub fn tier_for_score(score: i64) -> ReputationTier {
    let value = (-100_i64).max(100_i64.min(score));
    if value <= -50 {
        ReputationTier::Reviled
    } else if value <= -20 {
        ReputationTier::Distrusted
    } else if value >= 50 {
        ReputationTier::Honoured
    } else if value >= 20 {
        ReputationTier::Respected
    } else {
        ReputationTier::Unknown
    }
}

/// Именованная ступень (`reputationTier`): значение приводится как в JS.
pub fn reputation_tier(score: &Value) -> &'static str {
    tier_for_score(clamp_score(Some(score))).as_str()
}

fn npc_profile_for<'a>(state: &'a Value, npc_id: &str) -> Option<&'a Value> {
    array(coalesce(get(get(Some(state), "social"), "npcs"), None)).iter().find(|npc| s(get(Some(npc), "id")) == npc_id)
}

/// Всё, что политика говорит про отношение мира к отряду у этого NPC
/// (`reputationStandingFor`). `npc_id` — как в JS, `String(npcId ?? '')`.
pub fn reputation_standing_for(state: &Value, npc_id: &Value) -> Value {
    let npc_id = s(Some(npc_id));
    let npc = npc_profile_for(state, &npc_id);
    let factions = faction_ids_for_npc(npc);
    let score = reputation_score_for(state, npc);
    let tier = tier_for_score(score);
    // Розыск считается по краю, где отряд стоит сейчас.
    let wanted_level = wanted_level_here(state);
    let trade_available = wanted_trade_available(state);
    let mut standing = Map::new();
    standing.insert("npc_id".into(), json!(npc_id));
    standing.insert("faction_ids".into(), json!(factions));
    standing.insert("score".into(), json!(score));
    standing.insert("tier".into(), json!(tier.as_str()));
    standing.insert("wanted_level".into(), json!(wanted_level));
    standing.insert("price_adjustment_bps".into(), json!(tier.price_bps() + wanted_price_bps(state)));
    standing.insert("social_dc_shift".into(), json!(tier.social_dc_shift()));
    // Услуги — одолжение, и в нём отказывают; товар продают всем, пока отряд не в розыске.
    standing.insert("services_available".into(), json!(tier != ReputationTier::Reviled && trade_available));
    standing.insert("trade_available".into(), json!(trade_available));
    if !trade_available {
        standing.insert("trade_refusal_reason".into(), json!(WANTED_TRADE_REFUSAL_REASON));
    }
    Value::Object(standing)
}

/// Готовая поправка к цене для торговца (`reputationPriceBps`).
pub fn reputation_price_bps(state: &Value, merchant_id: &Value) -> i64 {
    reputation_standing_for(state, merchant_id).get("price_adjustment_bps").and_then(Value::as_i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn world(reputations: Value, tags: Value) -> Value {
        json!({
            "autonomy": { "reputations": reputations },
            "social": { "npcs": [{ "id": "merchant-1", "name": "Марта", "tags": tags }] },
        })
    }

    #[test]
    fn worst_faction_wins() {
        let state = world(json!({ "guild": 60, "watch": -70 }), json!(["faction:guild", "faction:watch"]));
        let npc = &state["social"]["npcs"][0];
        assert_eq!(faction_ids_for_npc(Some(npc)), ["guild", "watch"]);
        assert_eq!(reputation_score_for(&state, Some(npc)), -70);
        assert_eq!(reputation_tier(&json!(-70)), "reviled");
    }

    #[test]
    fn npc_without_factions_is_untouched() {
        let standing = reputation_standing_for(&world(json!({ "guild": -100 }), json!([])), &json!("merchant-1"));
        assert_eq!(standing["faction_ids"], json!([]));
        assert_eq!(standing["score"], 0);
        assert_eq!(standing["tier"], "unknown");
        assert_eq!(standing["price_adjustment_bps"], 0);
        assert_eq!(standing["social_dc_shift"], 0);
        assert_eq!(standing["services_available"], true);
    }

    #[test]
    fn prices_and_services_follow_the_tier() {
        let price = |score: i64| reputation_price_bps(&world(json!({ "guild": score }), json!(["faction:guild"])), &json!("merchant-1"));
        assert_eq!(price(-80), 1_000);
        assert_eq!(price(80), -1_000);
        let services = |score: i64| reputation_standing_for(&world(json!({ "guild": score }), json!(["faction:guild"])), &json!("merchant-1"))["services_available"].clone();
        assert_eq!(services(-80), false);
        assert_eq!(services(-30), true);
        assert_eq!(services(0), true);
    }
}

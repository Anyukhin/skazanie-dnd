//! Перенос `server/scene-commerce.mjs`: нужна ли новой сцене лавка и какого
//! профиля. По умолчанию решение выводится из текста сцены (поселение — лавка,
//! дикая местность — нет); замысел Режиссёра может её отключить или вызвать
//! странствующего торговца, но цен, склада, персоны и секретов не задаёт.
//!
//! В JS `sceneArgs = null` роняет вызов `TypeError`; здесь — пустая сцена.

use serde_json::{json, Value};
use sk_core::{js, re, text};

use crate::shop_assembler::{SHOP_ASSEMBLER_LIMITS, SHOP_SETTLEMENT_TYPES, SHOP_THEMES};
use crate::support::{get, plain};

pub const SCENE_COMMERCE_PLAN_VERSION: &str = "skazanie:scene-commerce-plan-v1";

const WILDERNESS_SHOPS: [&str; 2] = ["outpost", "traveling"];
const SHOP_INTENT_FIELDS: [&str; 5] = ["action", "settlement_type", "theme", "budget_cp", "reason"];
const NO_SETTLEMENT_REASON: &str = "В сцене не обнаружено поселение или постоянная торговая точка.";
const SETTLEMENT_REASON: &str = "Новая сцена является поселением, поэтому Директор запросил базовую торговую точку.";

fn budget_for(settlement: &str) -> i64 {
    match settlement {
        "village" => 8_000,
        "town" => 20_000,
        "city" => 50_000,
        "outpost" => 12_000,
        _ => 10_000,
    }
}

/// `String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maximum)`.
fn squashed(value: Option<&Value>, maximum: usize) -> String {
    let collapsed = text::replace_all(re!(r"\s+", "gu"), &js::s(value), " ");
    text::head(text::trim(&collapsed), maximum)
}

fn scene_text(scene_args: Option<&Value>) -> String {
    let parts = [get(scene_args, "location"), get(scene_args, "title"), get(scene_args, "theme"), get(get(scene_args, "map"), "layout")];
    text::lower(&parts.iter().map(|value| squashed(*value, 240)).collect::<Vec<_>>().join(" "))
}

fn is_settlement(value: &str) -> bool {
    text::test(
        re!(r"(?:^|\W)(?:город(?:ок|а|е|у|ом)?|деревн(?:я|и|ю|е)|пос[её]лок|поселени(?:е|я)|рынок|площадь|улиц(?:а|ы|е|у)|порт(?:а|у|ом)?|таверн(?:а|ы|е|у)|city|town|village|settlement|market|street|harbou?r)(?:$|\W)", "iu"),
        value,
    )
}

fn settlement_type(value: &str) -> &'static str {
    if text::test(re!(r"(?:деревн|село|village)", "iu"), value) {
        "village"
    } else if text::test(re!(r"(?:застав|форпост|гарнизон|outpost|garrison)", "iu"), value) {
        "outpost"
    } else if text::test(re!(r"(?:столиц|мегапол|больш(?:ой|ого)\s+город|capital|metropolis|large\s+city)", "iu"), value) || text::test(re!(r"(?:город|city)", "iu"), value) {
        "city"
    } else {
        "town"
    }
}

fn shop_theme(value: &str) -> &'static str {
    if text::test(re!(r"(?:оруж|доспех|кузн|арсенал|гарнизон|weapon|armou?r|smith|forge|arsenal)", "iu"), value) {
        "arms"
    } else if text::test(re!(r"(?:леч|целител|аптек|алхим|храм|лекар|healing|healer|apothecar|temple|hospital)", "iu"), value) {
        "healing"
    } else if text::test(re!(r"(?:припас|провиант|снабжен|караван|тракт|дорог|порт|provision|supply|caravan|road|harbou?r)", "iu"), value) {
        "provisions"
    } else {
        "general"
    }
}

fn intent(action: &str, settlement: &str, theme: &str, budget_cp: i64, reason: &str) -> Value {
    json!({ "version": SCENE_COMMERCE_PLAN_VERSION, "action": action, "settlement_type": settlement, "theme": theme, "budget_cp": budget_cp, "reason": reason })
}

/// `defaultSceneShopIntent(sceneArgs)`: лавка поселению, ничего — дикой местности.
pub fn default_scene_shop_intent(scene_args: Option<&Value>) -> Value {
    let value = scene_text(scene_args);
    if !is_settlement(&value) {
        return intent("none", "traveling", "provisions", budget_for("traveling"), NO_SETTLEMENT_REASON);
    }
    let settlement = settlement_type(&value);
    intent("create", settlement, shop_theme(&value), budget_for(settlement), SETTLEMENT_REASON)
}

fn allowed_string<'a>(value: Option<&'a Value>, allowed: &[&str]) -> Option<&'a str> {
    value.and_then(Value::as_str).filter(|text| allowed.contains(text))
}

/// `normalizeSceneShopIntent(input, sceneArgs)`: недоверенный замысел
/// Режиссёра в пределах словаря; лишнее поле — запасной вариант сцены.
pub fn normalize_scene_shop_intent(input: Option<&Value>, scene_args: Option<&Value>) -> Value {
    let fallback = default_scene_shop_intent(scene_args);
    if !js::present(input) {
        return fallback;
    }
    let Some(source) = plain(input).filter(|map| map.keys().all(|key| SHOP_INTENT_FIELDS.contains(&key.as_str()))) else {
        return fallback;
    };
    let fallback_text = |key: &str| fallback[key].as_str().unwrap_or_default().to_string();
    let action = allowed_string(source.get("action"), &["create", "none"]).map_or_else(|| fallback_text("action"), str::to_string);
    let settlement = allowed_string(source.get("settlement_type"), &SHOP_SETTLEMENT_TYPES).map_or_else(|| fallback_text("settlement_type"), str::to_string);
    let theme = allowed_string(source.get("theme"), &SHOP_THEMES).map_or_else(|| fallback_text("theme"), str::to_string);
    let requested = js::number(source.get("budget_cp"));
    let budget = if crate::support::is_safe(requested) {
        (requested as i64).clamp(SHOP_ASSEMBLER_LIMITS.minimum_budget_cp, SHOP_ASSEMBLER_LIMITS.maximum_budget_cp)
    } else {
        fallback["budget_cp"].as_i64().unwrap_or(0)
    };
    let wilderness = fallback["action"] == "none";
    let safe_action = if action == "create" && wilderness && !WILDERNESS_SHOPS.contains(&settlement.as_str()) { "none".to_string() } else { action };
    let reason = squashed(source.get("reason"), 240);
    let reason = if reason.is_empty() { fallback_text("reason") } else { reason };
    intent(&safe_action, &settlement, &theme, budget, &reason)
}

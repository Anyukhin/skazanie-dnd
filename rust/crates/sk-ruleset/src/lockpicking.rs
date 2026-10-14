//! Перенос `server/lockpicking.mjs`: взлом отмычками — кто вправе его
//! пробовать, чем он шумит и когда сорванный замок замечают.
//!
//! Модуль детерминированный и листовой: читает переданного героя и состояние
//! кампании, механику не зовёт. Броски остаются за Rules Engine, здесь —
//! только политика:
//!
//! 1. Гейт — владение, а не предмет: вскрывать замок вправе тот, кому
//!    владение воровскими инструментами дала предыстория.
//! 2. СЛ замка игроку не объявляется.
//! 3. Шум — не бросок: ступень решает натуральная единица, а заметят ли
//!    сорванный замок — детерминированная доля от сида.

use serde_json::{json, Value};
use sk_core::{js, text};

use crate::backgrounds::background_benefits;
use crate::ruleset_config::LEGACY_DEFAULT_RULESET_ID;
use crate::support::{array, defined, path, prop};

pub const LOCKPICKING_POLICY_ID: &str = "skazanie:lockpicking-v1";
pub const LOCKPICKING_SCHEMA_VERSION: i64 = 1;

/// Идентификатор владения из каталога предысторий. Второго написания нет.
pub const THIEVES_TOOLS_ID: &str = "thieves_tools";

/// Как инструменты зовут за столом. Латиницу игрок не увидит никогда.
pub const THIEVES_TOOLS_NAME: &str = "воровские инструменты";

/// Отказ без владения. Один текст на движок, проекцию и кнопку.
pub const THIEVES_TOOLS_REQUIRED_MESSAGE: &str = "Нужно владение воровскими инструментами";

/// Код отказа без владения.
pub const THIEVES_TOOLS_REQUIRED_CODE: &str = "THIEVES_TOOLS_REQUIRED";

/// Ступени поступка за шум (`LOCKPICK_NOISE_SEVERITY`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NoiseSeverity {
    /// Провал — мелочь: звякнул металл, кто-то обернулся.
    pub failure: &'static str,
    /// Натуральная единица — средняя ступень: грохот слышали все.
    pub fumble: &'static str,
}

/// Ступень поступка за шум. Тяжкой ступени у шума нет: это возня у замка, а
/// не пролитая кровь.
pub const LOCKPICK_NOISE_SEVERITY: NoiseSeverity = NoiseSeverity { failure: "minor", fumble: "major" };

/// Доля сорванных замков, которые замечают при живых людях в сцене. Не
/// бросок: один и тот же взлом на одном и том же состоянии кончается
/// одинаково и после replay.
pub const LOCKPICK_TRACE_SHARE: u64 = 25;

/// `text(value, maximum)`: `String(value ?? '').normalize('NFKC').trim().slice(0, maximum)`.
fn clean(value: Option<&Value>, maximum: usize) -> String {
    text::clean(value, maximum)
}

/// `list(value)`: непустые строки массива, каждая не длиннее 120 символов.
fn list(value: Option<&Value>) -> Vec<String> {
    array(value).iter().map(|entry| clean(Some(entry), 120)).filter(|entry| !entry.is_empty()).collect()
}

fn digest(parts: &[&str]) -> String {
    sk_core::hash::sha256_hex(parts.join("\0"))
}

/// `spread(seed, salt, size)`: первые 8 hex-цифр хеша по модулю `size`.
fn spread(seed: &str, salt: &str, size: u64) -> u64 {
    let hash = digest(&[seed, salt]);
    u64::from_str_radix(&hash[..8], 16).unwrap_or(0) % size.max(1)
}

/// Все места, где на листе может лежать владение инструментом.
fn declared_tool_ids(actor: Option<&Value>) -> Vec<String> {
    let mut ids = list(prop(actor, "toolProficiencies"));
    ids.extend(list(prop(actor, "toolProficiencyIds")));
    ids.extend(list(path(actor, &["characterSheet", "tool_proficiencies"])));
    ids.extend(list(path(actor, &["characterSheet", "tools"])));
    let from_background = clean(path(actor, &["backgroundBenefits", "tool_proficiency"]), 120);
    if !from_background.is_empty() {
        ids.push(from_background);
    }
    ids
}

/// `hasThievesTools(actor)`: владеет ли герой воровскими инструментами.
/// Источник истины — предыстория: она перечитывается по `backgroundId`, а уже
/// достроенный разбор принимается как готовый ответ.
pub fn has_thieves_tools(actor: Option<&Value>) -> bool {
    if !matches!(actor, Some(Value::Object(_)) | Some(Value::Array(_))) {
        return false;
    }
    if declared_tool_ids(actor).iter().any(|id| id == THIEVES_TOOLS_ID) {
        return true;
    }
    let background_id = clean(prop(actor, "backgroundId"), 120);
    if background_id.is_empty() {
        return false;
    }
    // Каталог 2024 по умолчанию без авторской настройки отказать не может.
    let benefits = background_benefits(&background_id, None, None, LEGACY_DEFAULT_RULESET_ID).ok().flatten();
    clean(prop(benefits.as_ref(), "tool_proficiency"), 120) == THIEVES_TOOLS_ID
}

/// `lockpickingForViewer(state, { playerId })`: карточка взлома для стола —
/// умеет ли герой вскрывать замки, и готовая строка отказа. Ни СЛ, ни
/// запертости в карточке нет.
pub fn lockpicking_for_viewer(state: Option<&Value>, player_id: Option<&Value>) -> Value {
    let hero_id = clean(player_id, 120);
    let hero = array(prop(state, "players")).iter().find(|player| clean(prop(Some(player), "id"), 120) == hero_id);
    let proficient = has_thieves_tools(hero);
    json!({
        "schema_version": LOCKPICKING_SCHEMA_VERSION,
        "policy_id": LOCKPICKING_POLICY_ID,
        "tool_id": THIEVES_TOOLS_ID,
        "tool_name": THIEVES_TOOLS_NAME,
        "proficient": proficient,
        "blocked_reason": if proficient { "" } else { THIEVES_TOOLS_REQUIRED_MESSAGE },
    })
}

/// `lockpickNoiseFor(check)`: шум неудачной попытки; `None` — тишина
/// (удачный взлом не слышали).
pub fn lockpick_noise_for(check: Option<&Value>) -> Option<Value> {
    if js::is_true(prop(check, "success")) {
        return None;
    }
    let loud = js::number(prop(check, "natural")) == 1.0;
    let severity = if loud { LOCKPICK_NOISE_SEVERITY.fumble } else { LOCKPICK_NOISE_SEVERITY.failure };
    Some(json!({ "reason": "noise", "severity": severity, "loud": loud }))
}

/// `lockpickTraceNoticedFor(state, { targetId, witnessIds })`: заметил ли
/// кто-нибудь сорванный замок после удачного взлома — детерминированная доля,
/// а не кость. Свидетелей считает сцена.
pub fn lockpick_trace_noticed_for(state: Option<&Value>, target_id: Option<&Value>, witness_ids: Option<&Value>) -> Option<Value> {
    let witnesses = list(witness_ids);
    if witnesses.is_empty() {
        return None;
    }
    let location = defined(path(state, &["worldMap", "currentLocationId"])).or_else(|| path(state, &["scene", "location"]));
    let seed = digest(&[
        &clean(prop(state, "sessionCode"), 60),
        &clean(location, 180),
        &clean(target_id, 160),
        &witnesses.join(","),
        LOCKPICKING_POLICY_ID,
    ]);
    if spread(&seed, "trace", 100) >= LOCKPICK_TRACE_SHARE {
        return None;
    }
    Some(json!({ "reason": "trace", "severity": "minor", "loud": false }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proficiency_comes_from_background_not_backpack() {
        let has = |actor: Value| has_thieves_tools(Some(&actor));
        assert!(has(json!({ "backgroundId": "criminal" })));
        assert!(has(json!({ "backgroundId": "wayfarer" })));
        assert!(!has(json!({ "backgroundId": "sage" })));
        assert!(!has(json!({ "backgroundId": "нет-такой" })));
        assert!(!has(json!({})));
        assert!(!has_thieves_tools(Some(&Value::Null)));
        assert!(has(json!({ "backgroundBenefits": { "tool_proficiency": THIEVES_TOOLS_ID } })));
        assert!(has(json!({ "toolProficiencies": ["herbalism_kit", THIEVES_TOOLS_ID] })));
        assert!(!has(json!({ "toolProficiencies": ["herbalism_kit"] })));
        assert!(!has(json!({ "classSkillProficiencies": ["sleight_of_hand"] })));
    }

    #[test]
    fn noise_is_policy_not_a_roll() {
        assert_eq!(lockpick_noise_for(Some(&json!({ "success": true, "natural": 1 }))), None);
        assert_eq!(lockpick_noise_for(Some(&json!({ "success": false, "natural": 7 }))).map(|noise| noise["severity"].clone()), Some(json!("minor")));
        let fumble = lockpick_noise_for(Some(&json!({ "success": false, "natural": 1 }))).unwrap_or(Value::Null);
        assert_eq!(fumble["severity"], json!("major"));
        assert_eq!(fumble["loud"], json!(true));
    }

    #[test]
    fn trace_is_a_deterministic_share() {
        let state = json!({ "sessionCode": "LOCKPICK-1", "worldMap": { "currentLocationId": "vault" } });
        assert_eq!(lockpick_trace_noticed_for(Some(&state), Some(&json!("door-vault")), Some(&json!([]))), None);
        let outcomes: Vec<bool> = (0..40)
            .map(|index| lockpick_trace_noticed_for(Some(&state), Some(&json!(format!("lock-{index}"))), Some(&json!(["npc-1"]))).is_some())
            .collect();
        assert!(outcomes.iter().any(|noticed| *noticed));
        assert!(outcomes.iter().any(|noticed| !*noticed));
    }

    #[test]
    fn viewer_card_carries_the_refusal_text() {
        let state = json!({ "players": [{ "id": "hero", "backgroundId": "criminal" }, { "id": "mage", "backgroundId": "sage" }] });
        assert_eq!(lockpicking_for_viewer(Some(&state), Some(&json!("hero")))["blocked_reason"], json!(""));
        let unable = lockpicking_for_viewer(Some(&state), Some(&json!("mage")));
        assert_eq!(unable["proficient"], json!(false));
        assert_eq!(unable["blocked_reason"], json!(THIEVES_TOOLS_REQUIRED_MESSAGE));
        assert!(!unable.to_string().contains("dc"));
    }
}

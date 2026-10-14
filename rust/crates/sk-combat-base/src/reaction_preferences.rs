//! Перенос `server/reaction-preferences.mjs`: режимы реакций героя —
//! «спрашивать», «сразу», «никогда», как в Baldur's Gate 3.
//!
//! Модуль — лист: он только говорит, какие реакции настраиваются и что
//! сделать с открытым окном реакции по заранее выбранному режиму. Само окно,
//! его варианты и цену собирает движок правил; политика выбирает только из
//! `action_ids`, которые движок положил в окно.

use serde_json::{json, Map, Value};
use sk_core::js;

use crate::jsv::{self, string_of};

/// `REACTION_MODE_SCHEMA_VERSION`.
pub const REACTION_MODE_SCHEMA_VERSION: i64 = 1;

/// `REACTION_MODES`.
pub const REACTION_MODES: [&str; 3] = ["ask", "auto", "never"];

/// Реакции, которым можно задать режим, в порядке выбора «сразу»: сначала
/// отменяющие случившееся, затем уменьшающие урон, потом ответные удары.
pub const REACTION_PREFERENCE_IDS: [&str; 12] = [
    "cast:counterspell",
    "fighter-zaschita",
    "paladin-zaschita",
    "bard-kollegiya-znaniy-ostroe-slovtso",
    "cast:shield",
    "cast:absorb-elements",
    "uncanny-dodge",
    "parry",
    "cast:hellish-rebuke",
    "riposte",
    "cast:silvery-barbs",
    "opportunity-attack",
];

// Окна выбора, которые не расходуют реакцию: здесь режимов нет.
const FREE_CHOICE_TRIGGERS: [&str; 2] = ["failed-saving-throw", "saving-throw-bonus-choice"];

/// `isReactionMode(value)`.
pub fn is_reaction_mode(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::String(mode)) if REACTION_MODES.contains(&mode.as_str()))
}

/// `isConfigurableReaction(reactionId)`.
pub fn is_configurable_reaction(reaction_id: Option<&Value>) -> bool {
    matches!(reaction_id, Some(Value::String(id)) if REACTION_PREFERENCE_IDS.contains(&id.as_str()))
}

/// `normalizeReactionPreferences(raw)`: только известные реакции и режимы;
/// «спрашивать» — значение по умолчанию и не хранится.
pub fn normalize_reaction_preferences(raw: Option<&Value>) -> Value {
    let mut result = Map::new();
    let Some(Value::Object(raw)) = raw else {
        return Value::Object(result);
    };
    for (actor_id, entries) in js::entries(raw) {
        let Value::Object(entries) = entries else {
            continue;
        };
        if actor_id.is_empty() {
            continue;
        }
        let mut modes = Map::new();
        for (reaction_id, mode) in js::entries(entries) {
            if REACTION_PREFERENCE_IDS.contains(&reaction_id.as_str()) && is_reaction_mode(Some(mode)) && mode != "ask" {
                modes.insert(reaction_id.clone(), mode.clone());
            }
        }
        if !modes.is_empty() {
            result.insert(actor_id.clone(), Value::Object(modes));
        }
    }
    Value::Object(result)
}

/// `reactionModeFor(preferences, actorId, reactionId)`.
pub fn reaction_mode_for(preferences: Option<&Value>, actor_id: &str, reaction_id: &str) -> &'static str {
    let entries = jsv::member(preferences, actor_id);
    let mode = jsv::member(entries, reaction_id);
    match mode {
        Some(Value::String(mode)) => REACTION_MODES.iter().copied().find(|known| known == mode).unwrap_or("ask"),
        _ => "ask",
    }
}

/// Ответ сервера на окно реакции вместо вопроса.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReactionPlan {
    /// «Сразу»: выбрать этот вариант.
    Auto { action_id: String },
    /// «Никогда» для всех вариантов: отказ (`decline-reaction`).
    Never,
}

impl ReactionPlan {
    /// Форма JS: `{ mode, action_id }`.
    pub fn to_json(&self) -> Value {
        match self {
            Self::Auto { action_id } => json!({ "mode": "auto", "action_id": action_id }),
            Self::Never => json!({ "mode": "never", "action_id": "decline-reaction" }),
        }
    }
}

/// `planReactionByPreference(preferences, window)`: `None` — спрашивать.
///
/// Есть вариант «сразу» — он (первый по [`REACTION_PREFERENCE_IDS`]); все
/// варианты «никогда» — отказ; иначе вопрос. Окно с вариантом без режима
/// (заготовка, «Несгибаемый», бонус спасброска) не трогается.
pub fn plan_reaction_by_preference(preferences: Option<&Value>, window: Option<&Value>) -> Option<ReactionPlan> {
    let window = window.filter(|window| window.is_object() || window.is_array())?;
    let field = |key: &str| jsv::member(Some(window), key);
    let actor_id = js::s(field("actor_id"));
    if actor_id.is_empty() || js::is_true(field("free_choice")) || FREE_CHOICE_TRIGGERS.contains(&js::s(field("trigger")).as_str()) {
        return None;
    }
    let offered: Vec<String> = field("action_ids").and_then(Value::as_array).map(|ids| ids.iter().map(|id| string_of(Some(id))).collect()).unwrap_or_default();
    if offered.is_empty() || offered.iter().any(|id| !REACTION_PREFERENCE_IDS.contains(&id.as_str())) {
        return None;
    }
    let automatic = REACTION_PREFERENCE_IDS.iter().find(|id| offered.iter().any(|offered| offered == *id) && reaction_mode_for(preferences, &actor_id, id) == "auto");
    if let Some(automatic) = automatic {
        return Some(ReactionPlan::Auto { action_id: (*automatic).to_string() });
    }
    if offered.iter().all(|id| reaction_mode_for(preferences, &actor_id, id) == "never") {
        return Some(ReactionPlan::Never);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(preferences: Value, window: Value) -> Option<Value> {
        plan_reaction_by_preference(Some(&preferences), Some(&window)).map(|plan| plan.to_json())
    }

    #[test]
    fn modes_choose_decline_or_ask() {
        let window = json!({ "actor_id": "hero", "action_ids": ["cast:shield", "uncanny-dodge"] });
        assert_eq!(plan(json!({}), window.clone()), None, "по умолчанию — спрашивать");
        assert_eq!(plan(json!({ "hero": { "uncanny-dodge": "auto" } }), window.clone()), Some(json!({ "mode": "auto", "action_id": "uncanny-dodge" })));
        assert_eq!(
            plan(json!({ "hero": { "cast:shield": "auto", "uncanny-dodge": "auto" } }), window.clone()),
            Some(json!({ "mode": "auto", "action_id": "cast:shield" })),
            "из двух «сразу» — то, что отменяет попадание"
        );
        assert_eq!(plan(json!({ "hero": { "cast:shield": "never" } }), window.clone()), None, "второй вариант всё ещё спрашивает");
        assert_eq!(plan(json!({ "hero": { "cast:shield": "never", "uncanny-dodge": "never" } }), window), Some(json!({ "mode": "never", "action_id": "decline-reaction" })));
        assert_eq!(plan(json!({ "hero": { "opportunity-attack": "never" } }), json!({ "actor_id": "hero", "action_ids": ["opportunity-attack", "readied-attack"] })), None);
        assert_eq!(plan(json!({ "hero": { "opportunity-attack": "auto" } }), json!({ "actor_id": "hero", "trigger": "failed-saving-throw", "action_ids": ["opportunity-attack"] })), None);
        assert_eq!(plan(json!({ "hero": { "opportunity-attack": "auto" } }), json!({ "actor_id": "hero", "free_choice": true, "action_ids": ["opportunity-attack"] })), None);
        assert_eq!(
            normalize_reaction_preferences(Some(&json!({ "hero": { "cast:shield": "ask", "parry": "auto", "cast:fireball": "auto", "riposte": "sometimes" }, "ghost": {} }))),
            json!({ "hero": { "parry": "auto" } })
        );
    }

    #[test]
    fn helpers_follow_js_types() {
        assert!(is_reaction_mode(Some(&json!("never"))));
        assert!(!is_reaction_mode(Some(&json!(["auto"]))));
        assert!(is_configurable_reaction(Some(&json!("parry"))));
        assert!(!is_configurable_reaction(Some(&json!("cast:fireball"))));
        assert_eq!(reaction_mode_for(Some(&json!([{ "parry": "auto" }])), "0", "parry"), "auto");
        assert_eq!(reaction_mode_for(Some(&json!("hero")), "hero", "parry"), "ask");
        assert_eq!(normalize_reaction_preferences(Some(&json!([1]))), json!({}));
    }
}

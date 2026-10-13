//! Перенос `server/campaign-ai-context.mjs`: настройки ИИ кампании (модель,
//! стиль рассказчика, режим импровизации, профиль рассуждений) на время
//! обработки одного запроса.
//!
//! В JS контекст живёт в `AsyncLocalStorage`: `runWithCampaignAiSettings`
//! кладёт настройки, а `current*` читают их в любой глубине вызова. Здесь —
//! стек на поток: [`run_with_campaign_ai_settings`] кладёт значение на время
//! замыкания и снимает его и при панике. Как и в JS, вложенный запуск с `None`
//! скрывает внешние настройки. Асинхронному серверу понадобится тот же стек в
//! локальном хранилище задачи — его форма здесь, а не в вызывающих.

use std::cell::RefCell;

use serde::Serialize;
use serde_json::Value;
use sk_core::text;

use crate::jsx;
use crate::model_style_profiles::campaign_role_reasoning;

/// Стиль рассказчика.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct NarratorStyle {
    pub id: &'static str,
    pub label: &'static str,
    pub instruction: &'static str,
}

/// `NARRATOR_STYLES` в порядке объявления.
pub const NARRATOR_STYLES: &[NarratorStyle] = &[
    NarratorStyle {
        id: "neutral",
        label: "Нейтральный",
        instruction: "Нейтральный литературный русский: ясно, образно и без нарочитой канцелярской или шутливой интонации.",
    },
    NarratorStyle {
        id: "formal",
        label: "Официальный",
        instruction: "Сдержанный официальный русский: точные формулировки, серьёзный тон и минимум разговорных оборотов.",
    },
    NarratorStyle {
        id: "ironic",
        label: "Ироничный",
        instruction: "Лёгкая доброжелательная ирония без пародии, унижения героев и нарушения подтверждённых фактов.",
    },
];

/// Режим импровизации или профиль рассуждений: id, подпись, описание
/// (описание — со строчной буквы: интерфейс печатает его через тире).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct LabeledOption {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
}

/// `IMPROV_MODES`: насколько свободно Режиссёр перестраивает историю.
pub const IMPROV_MODES: &[LabeledOption] = &[
    LabeledOption { id: "story", label: "Сюжет", description: "свобода в сценах, но главная линия в приоритете" },
    LabeledOption { id: "chaos", label: "Хаос", description: "можно всё, мир подстраивается под выбор отряда" },
];

pub const DEFAULT_IMPROV_MODE: &str = "story";

/// `REASONING_LEVELS`: профиль рассуждений, который выбирает лидер кампании.
/// `auto` — профиль сервера; раскладка по ролям — `REASONING_PROFILES`.
pub const REASONING_LEVELS: &[LabeledOption] = &[
    LabeledOption { id: "auto", label: "Авто", description: "без размышлений: быстрее всего и, по замеру, без выдуманных фактов" },
    LabeledOption {
        id: "thoughtful",
        label: "Вдумчивее",
        description: "Режиссёр и NPC коротко размышляют; ответ на секунду-две дольше, точнее по замеру не стало",
    },
    LabeledOption { id: "deep", label: "Глубже", description: "рассказчик и Режиссёр думают дольше всех; реплика NPC — до 8 секунд" },
];

pub const DEFAULT_REASONING_LEVEL: &str = "auto";

/// Творческие параметры Рассказчика (`NARRATOR_GENERATION_PARAMETERS`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct NarratorGenerationParameters {
    #[serde(serialize_with = "jsx::serialize_js_number")]
    pub temperature: f64,
    #[serde(rename = "frequencyPenalty", serialize_with = "jsx::serialize_js_number")]
    pub frequency_penalty: f64,
    #[serde(rename = "presencePenalty", serialize_with = "jsx::serialize_js_number")]
    pub presence_penalty: f64,
}

pub const NARRATOR_GENERATION_PARAMETERS: NarratorGenerationParameters =
    NarratorGenerationParameters { temperature: 0.4, frequency_penalty: 0.35, presence_penalty: 0.2 };

/// Настройки ИИ кампании в контексте запроса.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CampaignAiSettings {
    pub model: String,
    #[serde(rename = "narratorStyle")]
    pub narrator_style: String,
    #[serde(rename = "improvMode")]
    pub improv_mode: String,
    #[serde(rename = "reasoningLevel")]
    pub reasoning_level: String,
}

thread_local! {
    static CONTEXT: RefCell<Vec<Option<CampaignAiSettings>>> = const { RefCell::new(Vec::new()) };
}

/// `String(value ?? '').trim().toLowerCase()`.
fn normalized_key(value: Option<&Value>) -> String {
    text::lower(text::trim(&jsx::string(value)))
}

fn known_or(ids: impl IntoIterator<Item = &'static str>, key: &str, fallback: &'static str) -> &'static str {
    ids.into_iter().find(|id| *id == key).unwrap_or(fallback)
}

/// `normalizeNarratorStyle(value)`.
pub fn normalize_narrator_style(value: Option<&Value>) -> &'static str {
    known_or(NARRATOR_STYLES.iter().map(|style| style.id), &normalized_key(value), "neutral")
}

/// `normalizeImprovMode(value)`.
pub fn normalize_improv_mode(value: Option<&Value>) -> &'static str {
    known_or(IMPROV_MODES.iter().map(|mode| mode.id), &normalized_key(value), DEFAULT_IMPROV_MODE)
}

/// `normalizeReasoningLevel(value)`.
pub fn normalize_reasoning_level(value: Option<&Value>) -> &'static str {
    known_or(REASONING_LEVELS.iter().map(|level| level.id), &normalized_key(value), DEFAULT_REASONING_LEVEL)
}

/// Настройки из значения JSON, как в `runWithCampaignAiSettings`: объект (и,
/// как `typeof` в JS, массив) — нормализованные поля, иное — `None`.
pub fn campaign_ai_settings_from(settings: Option<&Value>) -> Option<CampaignAiSettings> {
    let settings = settings.filter(|value| value.is_object() || value.is_array())?;
    Some(CampaignAiSettings {
        model: text::trim(&jsx::string(settings.get("model"))).to_string(),
        narrator_style: normalize_narrator_style(settings.get("narratorStyle")).to_string(),
        improv_mode: normalize_improv_mode(settings.get("improvMode")).to_string(),
        reasoning_level: normalize_reasoning_level(settings.get("reasoningLevel")).to_string(),
    })
}

struct ContextGuard;

impl Drop for ContextGuard {
    fn drop(&mut self) {
        CONTEXT.with(|stack| {
            stack.borrow_mut().pop();
        });
    }
}

/// `runWithCampaignAiSettings(settings, operation)`.
pub fn run_with_campaign_ai_settings<R>(settings: Option<&Value>, operation: impl FnOnce() -> R) -> R {
    let value = campaign_ai_settings_from(settings);
    CONTEXT.with(|stack| stack.borrow_mut().push(value));
    let _guard = ContextGuard;
    operation()
}

/// `currentCampaignAiSettings()`.
pub fn current_campaign_ai_settings() -> Option<CampaignAiSettings> {
    CONTEXT.with(|stack| stack.borrow().last().cloned().flatten())
}

/// `campaignReasoningFor(modelId, role)`: рассуждения, которые кампания
/// заказала для этой модели и роли, или `None` — тогда действует профиль
/// сервера. Касается только выбранной лидером модели и только ролей, которые
/// себя назвали (`role` не пуст).
pub fn campaign_reasoning_for(model_id: Option<&str>, role: &str) -> Option<Value> {
    let settings = current_campaign_ai_settings()?;
    if settings.model.is_empty() || settings.model != model_id.unwrap_or("") {
        return None;
    }
    let level = normalize_reasoning_level(Some(&Value::String(settings.reasoning_level.clone())));
    campaign_role_reasoning(&settings.model, level, role)
}

/// `currentCampaignModel()`.
pub fn current_campaign_model() -> String {
    current_campaign_ai_settings().map(|settings| settings.model).unwrap_or_default()
}

/// `currentNarratorStyle()`.
pub fn current_narrator_style() -> String {
    current_campaign_ai_settings().map_or_else(|| "neutral".to_string(), |settings| settings.narrator_style)
}

/// `currentImprovMode()`.
pub fn current_improv_mode() -> String {
    current_campaign_ai_settings().map_or_else(|| DEFAULT_IMPROV_MODE.to_string(), |settings| settings.improv_mode)
}

/// `currentNarratorStyleInstruction()`: пусто вне контекста кампании.
pub fn current_narrator_style_instruction() -> &'static str {
    if current_campaign_ai_settings().is_none() {
        return "";
    }
    let style = current_narrator_style();
    NARRATOR_STYLES.iter().find(|candidate| candidate.id == style).map_or("", |candidate| candidate.instruction)
}

/// `currentNarratorGenerationParameters()`.
pub fn current_narrator_generation_parameters() -> NarratorGenerationParameters {
    NARRATOR_GENERATION_PARAMETERS
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reasoning_level_normalizes_to_auto() {
        let ids: Vec<&str> = REASONING_LEVELS.iter().map(|level| level.id).collect();
        assert_eq!(ids, ["auto", "thoughtful", "deep"]);
        assert_eq!(normalize_reasoning_level(Some(&json!("DEEP"))), "deep");
        assert_eq!(normalize_reasoning_level(Some(&json!("ultra"))), "auto");
        assert_eq!(normalize_reasoning_level(None), "auto");
        for level in REASONING_LEVELS {
            assert!(!level.label.is_empty() && !level.description.is_empty(), "{}", level.id);
        }
        assert_eq!(campaign_reasoning_for(Some("openai/gpt-6-luna"), ""), None, "вне запроса кампании выбора нет");
    }

    #[test]
    fn improv_mode_normalizes_to_story_and_reaches_context() {
        let mut ids: Vec<&str> = IMPROV_MODES.iter().map(|mode| mode.id).collect();
        ids.sort_unstable();
        assert_eq!(ids, ["chaos", "story"]);
        assert_eq!(DEFAULT_IMPROV_MODE, "story");
        assert_eq!(normalize_improv_mode(Some(&json!("chaos"))), "chaos");
        assert_eq!(normalize_improv_mode(Some(&json!("CHAOS"))), "chaos");
        assert_eq!(normalize_improv_mode(Some(&json!("sandbox"))), "story");
        assert_eq!(normalize_improv_mode(None), "story");
        assert_eq!(current_improv_mode(), "story");
        run_with_campaign_ai_settings(Some(&json!({ "model": "primary", "narratorStyle": "neutral", "improvMode": "chaos" })), || {
            assert_eq!(current_improv_mode(), "chaos");
        });
        assert_eq!(current_improv_mode(), "story");
    }

    #[test]
    fn campaign_reasoning_only_for_selected_model_and_named_roles() {
        let deep = json!({ "model": "openai/gpt-6-luna", "reasoningLevel": "deep" });
        run_with_campaign_ai_settings(Some(&deep), || {
            assert_eq!(campaign_reasoning_for(Some("openai/gpt-6-luna"), "narrator"), Some(json!({ "effort": "high" })));
            assert_eq!(campaign_reasoning_for(Some("openai/gpt-6-luna"), "director"), Some(json!({ "effort": "high" })));
            assert_eq!(campaign_reasoning_for(Some("openai/gpt-6-luna"), "npc"), Some(json!({ "effort": "medium" })));
            assert_eq!(campaign_reasoning_for(Some("openai/gpt-6-luna"), ""), None, "непомеченная роль — профиль сервера");
            assert_eq!(campaign_reasoning_for(Some("z-ai/glm-5.3-flash"), "narrator"), None, "резервная модель — свой профиль");
            // Вложенный запуск без настроек скрывает внешние, как AsyncLocalStorage.run(null).
            run_with_campaign_ai_settings(None, || assert_eq!(current_campaign_ai_settings(), None));
            assert_eq!(current_campaign_model(), "openai/gpt-6-luna");
        });
        let thoughtful = json!({ "model": "openai/gpt-6-luna", "reasoningLevel": "thoughtful" });
        run_with_campaign_ai_settings(Some(&thoughtful), || {
            assert_eq!(campaign_reasoning_for(Some("openai/gpt-6-luna"), "narrator"), None);
            assert_eq!(campaign_reasoning_for(Some("openai/gpt-6-luna"), "director"), Some(json!({ "effort": "low" })));
        });
        run_with_campaign_ai_settings(Some(&json!({ "model": "openai/gpt-6-luna", "reasoningLevel": "auto" })), || {
            assert_eq!(campaign_reasoning_for(Some("openai/gpt-6-luna"), "narrator"), None);
        });
    }

    /// Как в `test/security.test.mjs`: два одновременных запроса разных кампаний
    /// видят каждый свою модель, а вне запроса модели нет.
    #[test]
    fn concurrent_campaigns_do_not_share_settings() {
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let workers: Vec<_> = [("secondary", "ironic"), ("primary", "neutral")]
            .into_iter()
            .map(|(model, style)| {
                let barrier = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || {
                    run_with_campaign_ai_settings(Some(&json!({ "model": model, "narratorStyle": style })), || {
                        barrier.wait();
                        (current_campaign_model(), current_narrator_style())
                    })
                })
            })
            .collect();
        let seen: Vec<(String, String)> = workers.into_iter().map(|worker| worker.join().expect("поток")).collect();
        assert_eq!(seen, [("secondary".to_string(), "ironic".to_string()), ("primary".to_string(), "neutral".to_string())]);
        assert_eq!(current_campaign_model(), "");
    }

    #[test]
    fn style_instruction_only_inside_campaign() {
        assert_eq!(current_narrator_style_instruction(), "");
        assert_eq!(current_narrator_style(), "neutral");
        run_with_campaign_ai_settings(Some(&json!({ "narratorStyle": " IRONIC " })), || {
            assert_eq!(current_narrator_style(), "ironic");
            assert!(current_narrator_style_instruction().starts_with("Лёгкая доброжелательная ирония"));
            assert_eq!(current_campaign_model(), "");
        });
        let caught = std::panic::catch_unwind(|| run_with_campaign_ai_settings(Some(&json!({ "model": "m" })), || panic!("сбой")));
        assert!(caught.is_err());
        assert_eq!(current_campaign_ai_settings(), None, "стек снят и при панике");
        assert_eq!(serde_json::to_value(current_narrator_generation_parameters()).expect("json"), json!({ "temperature": 0.4, "frequencyPenalty": 0.35, "presencePenalty": 0.2 }));
    }
}

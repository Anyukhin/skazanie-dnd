//! Перенос `server/model-style-profiles.mjs`: поправки системного промпта под
//! конкретную модель, профили рассуждений и карточки моделей для настроек.
//!
//! Замер 2026-07-31 (`docs/model-benchmark-2026-07-31.md`): у Luna реплики NPC
//! сжимались до одного факта, а факты прошлых сцен терялись; здесь лежат
//! измеренные компенсации промптом. Luna получает общую добавку формы,
//! GLM-5.3-Flash — отдельный контракт только для Рассказчика. Для незнакомых
//! моделей добавка пуста.
//!
//! В JS функции принимают клиента модели и читают `llmClient?.model`; здесь —
//! сам идентификатор модели (`None` = клиента или поля нет).

use std::sync::LazyLock;

use serde::Serialize;
use serde_json::{json, Value};

const LUNA_ADDENDUM: &str = "
ДОПОЛНИТЕЛЬНЫЕ ТРЕБОВАНИЯ К ФОРМЕ ОТВЕТА (обязательные):
- Реплики и описания пиши развёрнуто: 2–4 полных предложения, не меньше 220
  символов. Однострочный ответ — ошибка, даже если факт передан верно.
- Говорящий обязан звучать как живой человек со своим словарём: используй его
  speech_profile целиком — темп, лексикон и манеру, а не только вводное слово.
  Добавь деталь от себя в его характере: присказку, отступление, оценку.
- Не сводись к голому факту. Факт оберни в наблюдение, воспоминание или
  отношение персонажа к происходящему.
- Прежде чем отвечать, найди в переданных данных факты прошлых сцен (обещания,
  прошлые разговоры, памятные детали) и вплети хотя бы один в текст дословно
  узнаваемым образом.";

const GLM_NARRATOR_ADDENDUM: &str = "
РЕЖИМ ТОЧНОСТИ GLM ДЛЯ РАССКАЗЧИКА:
- Обычный исход — ровно 1–2 предложения о видимом результате и его пределах.
  Не описывай процесс, которым герой получил результат. Для обычной проверки
  вообще не упоминай героя по имени: подлежащим пусть будет известная деталь.
- AbilityCheckResolved и success=true подтверждают проверку, а не социальный
  исход. Принятие довода, новые ответы NPC и изменение отношения требуют
  отдельного события или соответствующего permitted_npc_reactions.
- open_promises остаются обещаниями. До подтверждённого исполнения сообщай
  только, кто и что обещал; ни наличие вещи в сцене, ни её получение не следуют
  из цели героя. recent_interactions явно называй прошлыми разговорами.
- Используй не более одного memory_focus и только при прямой связи с текущим
  результатом. Совпадение двух деталей не доказывает причину или виновника.
- Пустой permitted_npc_reactions означает отсутствие новых действий NPC.
  mood и sensory_anchors дают статическую атмосферу, не события.
- Примеры стиля описывают другие сцены: сохраняй только их ритм, не их события.
  В каждом предложении оставь лишь слова, для которых есть основание во входе.
- После неудачи назови предел результата, сохранив неизвестное неизвестным.
  При бедном brief одна короткая точная фраза лучше выдуманного продолжения.";

const MODEL_ADDENDA: &[(&str, &str)] = &[("openai/gpt-5.6-luna", LUNA_ADDENDUM), ("openai/gpt-5.6-luna-pro", LUNA_ADDENDUM)];

/// GPT-6 Luna без добавки отвечает NPC одной фразой; Рассказчику та же добавка
/// не нужна, поэтому она подключается только к репликам NPC.
const NPC_ROLE_ADDENDA: &[(&str, &str)] = &[("openai/gpt-6-luna", LUNA_ADDENDUM), ("openai/gpt-6-luna-pro", LUNA_ADDENDUM)];

fn lookup(table: &[(&str, &'static str)], key: &str) -> Option<&'static str> {
    table.iter().find(|(candidate, _)| *candidate == key).map(|(_, value)| *value)
}

/// `styleAddendumFor(modelId)`: добавка к системному промпту или пустая строка.
pub fn style_addendum_for(model_id: Option<&str>) -> &'static str {
    lookup(MODEL_ADDENDA, model_id.unwrap_or("")).unwrap_or("")
}

/// `promptForModel(basePrompt, llmClient)`.
pub fn prompt_for_model(base_prompt: &str, model: Option<&str>) -> String {
    let addendum = style_addendum_for(model);
    if addendum.is_empty() {
        base_prompt.to_string()
    } else {
        format!("{base_prompt}\n{addendum}")
    }
}

/// `promptForModelRole(basePrompt, llmClient, role)`: ролевой слой не протекает
/// между агентами. Роль в JS по умолчанию — `shared`.
pub fn prompt_for_model_role(base_prompt: &str, model: Option<&str>, role: &str) -> String {
    let shared = prompt_for_model(base_prompt, model);
    let model = model.unwrap_or("");
    if role == "narrator" && model == "z-ai/glm-5.3-flash" {
        return format!("{shared}\n{GLM_NARRATOR_ADDENDUM}");
    }
    match (role, lookup(NPC_ROLE_ADDENDA, model)) {
        ("npc", Some(addendum)) => format!("{shared}\n{addendum}"),
        _ => shared,
    }
}

/// `reasoningProfileFor(modelId)`: `{ effort: 'low' }`, `{ enabled: false }`
/// или `None` — незнакомая модель остаётся на умолчании провайдера.
pub fn reasoning_profile_for(model_id: Option<&str>) -> Option<Value> {
    let model = model_id.unwrap_or("");
    if ["z-ai/glm-5.3-flash", "meta/muse-spark-1.3"].contains(&model) {
        return Some(json!({ "effort": "low" }));
    }
    let known = ["z-ai/glm-5.2", "deepseek/deepseek-v4-flash", "openai/gpt-5.6-luna", "openai/gpt-5.6-luna-pro", "openai/gpt-6-luna", "openai/gpt-6-luna-pro"];
    known.contains(&model).then(|| json!({ "enabled": false }))
}

/// `REASONING_PROFILES`: модель → профиль → роль → рассуждения. Профиль трогает
/// только творческие роли (рассказчик, Режиссёр, NPC); профили есть только у Luna.
pub static REASONING_PROFILES: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "openai/gpt-6-luna": {
            "thoughtful": { "director": { "effort": "low" }, "npc": { "effort": "minimal" } },
            "deep": {
                "narrator": { "effort": "high" },
                "director": { "effort": "high" },
                "npc": { "effort": "medium" },
            },
        },
    })
});

/// `campaignRoleReasoning(modelId, level, role)`: рассуждения для роли при
/// профиле кампании или `None` — тогда действует [`reasoning_profile_for`].
/// Непомеченная роль (пустая строка) всегда `None`.
pub fn campaign_role_reasoning(model_id: &str, level: &str, role: &str) -> Option<Value> {
    let reasoning = REASONING_PROFILES.get(model_id)?.get(level)?.get(role)?;
    sk_core::js::truthy(Some(reasoning)).then(|| reasoning.clone())
}

/// Подпись и описание модели для игрока.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ModelOptionInfo {
    pub label: &'static str,
    pub description: &'static str,
}

const fn info(label: &'static str, description: &'static str) -> ModelOptionInfo {
    ModelOptionInfo { label, description }
}

/// `MODEL_OPTIONS`: модели, которые лидер кампании может выбрать в настройках.
pub const MODEL_OPTIONS: &[(&str, ModelOptionInfo)] = &[
    ("openai/gpt-6-luna", info("GPT-6 Luna", "точнее всех с фактами, быстро решает в бою и дешевле всех; текст суше")),
    ("openai/gpt-6-luna-pro", info("GPT-6 Luna Pro", "чуть богаче новый мир, но каждый ход на секунду медленнее и в 3–5 раз дороже")),
    ("z-ai/glm-5.3-flash", info("GLM-5.3 Flash", "живой текст, но часто досочиняет детали и не успевает создать мир")),
    ("google/gemini-2.5-flash-lite", info("Gemini 2.5 Flash Lite", "быстро создаёт мир и аккуратна в тексте, но хуже держит решения Режиссёра")),
    ("deepseek/deepseek-v4-flash", info("DeepSeek V4 Flash", "дёшево, но досочиняет и изредка выдаёт служебный текст вместо ответа")),
    ("z-ai/glm-5.2", info("GLM-5.2", "прежняя основная модель; дороже и медленнее новых")),
    ("openai/gpt-4.1-nano", info("GPT-4.1 Nano", "последний резерв: очень быстро, но бедный текст")),
    ("meta/muse-spark-1.3", info("Muse Spark 1.3", "экспериментальная модель для ручного выбора")),
];

/// Модель, которую настройки помечают «рекомендуется».
pub const RECOMMENDED_MODEL: &str = "openai/gpt-6-luna";

/// Модели, которые можно выбрать вручную, даже если их нет в цепочке `.env`.
pub const SELECTABLE_EXTRA_MODELS: &[&str] = &["openai/gpt-6-luna", "openai/gpt-6-luna-pro", "meta/muse-spark-1.3"];

/// Карточка модели для настроек (`modelOptionFor`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ModelOption {
    pub id: String,
    pub label: String,
    pub description: String,
    #[serde(rename = "reasoningLevels")]
    pub reasoning_levels: Vec<String>,
    pub recommended: bool,
}

/// `modelOptionFor(modelId, { recommended })`: незнакомая модель показывается
/// по своему ID и только с `auto`. `recommended` по умолчанию пуст.
pub fn model_option_for(model_id: &str, recommended: &str) -> ModelOption {
    let known = MODEL_OPTIONS.iter().find(|(id, _)| *id == model_id).map(|(_, info)| *info);
    let mut reasoning_levels = vec!["auto".to_string()];
    if let Some(Value::Object(levels)) = REASONING_PROFILES.get(model_id) {
        reasoning_levels.extend(sk_core::js::keys(levels).into_iter().cloned());
    }
    ModelOption {
        id: model_id.to_string(),
        label: known.map_or_else(|| model_id.to_string(), |info| info.label.to_string()),
        description: known.map_or_else(String::new, |info| info.description.to_string()),
        reasoning_levels,
        recommended: !recommended.is_empty() && model_id == recommended,
    }
}

/// `reasoningLevelAllowedFor(modelId, level)`: `auto` допустим всегда.
pub fn reasoning_level_allowed_for(model_id: &str, level: Option<&str>) -> bool {
    let level = level.unwrap_or("");
    level == "auto" || model_option_for(model_id, "").reasoning_levels.iter().any(|known| known == level)
}

/// `STRUCTURED_OUTPUT_MODELS`: модели, которым отправляется strict
/// `json_schema`, если роль приложила схему ответа.
pub const STRUCTURED_OUTPUT_MODELS: &[&str] = &["openai/gpt-6-luna", "openai/gpt-6-luna-pro", "openai/gpt-5.6-luna", "openai/gpt-4.1-nano", "google/gemini-2.5-flash-lite"];

/// `supportsJsonSchema(modelId)`.
pub fn supports_json_schema(model_id: Option<&str>) -> bool {
    STRUCTURED_OUTPUT_MODELS.contains(&model_id.unwrap_or(""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addendum_exists_only_for_measured_models() {
        assert!(style_addendum_for(Some("openai/gpt-5.6-luna")).contains("2–4 полных предложения"));
        assert!(!style_addendum_for(Some("openai/gpt-5.6-luna-pro")).is_empty());
        assert_eq!(style_addendum_for(Some("z-ai/glm-5.2")), "", "поведение GLM меняться не должно");
        assert_eq!(style_addendum_for(None), "");
    }

    #[test]
    fn unknown_model_prompt_is_unchanged() {
        assert_eq!(prompt_for_model("база", Some("z-ai/glm-5.2")), "база");
        assert_eq!(prompt_for_model("база", None), "база");
        assert!(prompt_for_model("база", Some("openai/gpt-5.6-luna")).starts_with("база\n"));
    }

    #[test]
    fn addendum_requires_length_manner_and_memory() {
        let addendum = style_addendum_for(Some("openai/gpt-5.6-luna"));
        assert!(addendum.contains("speech_profile"));
        assert!(sk_core::text::test(sk_core::re!(r"обещания,\s+прошлые разговоры", "u"), addendum));
        assert!(addendum.contains("Однострочный ответ — ошибка"));
    }

    #[test]
    fn hot_path_reasoning_is_the_fastest_supported_mode() {
        assert_eq!(reasoning_profile_for(Some("z-ai/glm-5.3-flash")), Some(json!({ "effort": "low" })));
        assert_eq!(reasoning_profile_for(Some("meta/muse-spark-1.3")), Some(json!({ "effort": "low" })));
        assert_eq!(reasoning_profile_for(Some("openai/gpt-5.6-luna")), Some(json!({ "enabled": false })));
        assert_eq!(reasoning_profile_for(Some("openai/gpt-6-luna")), Some(json!({ "enabled": false })));
        assert_eq!(reasoning_profile_for(Some("openai/gpt-6-luna-pro")), Some(json!({ "enabled": false })));
        assert_eq!(reasoning_profile_for(Some("unknown/model")), None);
        assert_eq!(reasoning_profile_for(None), None);
    }

    #[test]
    fn gpt6_luna_addendum_goes_only_to_npc() {
        let model = Some("openai/gpt-6-luna");
        assert!(prompt_for_model_role("база", model, "npc").contains("Однострочный ответ — ошибка"));
        assert_eq!(prompt_for_model_role("база", model, "narrator"), "база");
        assert_eq!(prompt_for_model_role("база", model, "shared"), "база");
        assert!(prompt_for_model_role("база", Some("openai/gpt-5.6-luna"), "npc").contains("Однострочный ответ — ошибка"));
        assert_eq!(prompt_for_model_role("база", Some("z-ai/glm-5.3-flash"), "npc"), "база");
    }

    #[test]
    fn strict_glm_contract_applies_only_to_narrator() {
        let model = Some("z-ai/glm-5.3-flash");
        let narrator = prompt_for_model_role("база", model, "narrator");
        for needle in ["Не описывай процесс", "ровно 1–2 предложения", "open_promises", "memory_focus", "вообще не упоминай героя по имени"] {
            assert!(narrator.contains(needle), "{needle}");
        }
        assert_eq!(prompt_for_model_role("база", model, "shared"), "база");
        assert_eq!(prompt_for_model("база", model), "база");
    }

    #[test]
    fn model_cards_describe_levels() {
        for (id, _) in MODEL_OPTIONS {
            let option = model_option_for(id, "");
            assert!(!option.label.is_empty() && !option.description.is_empty(), "{id}");
            assert!(option.reasoning_levels.iter().any(|level| level == "auto"), "{id}: «авто» доступен всегда");
            for level in &option.reasoning_levels {
                assert!(["auto", "thoughtful", "deep"].contains(&level.as_str()), "{id}: {level}");
            }
        }
        assert!(model_option_for("openai/gpt-6-luna", "openai/gpt-6-luna").recommended);
        assert_eq!(model_option_for("openai/gpt-6-luna", "").reasoning_levels, ["auto", "thoughtful", "deep"]);
        for id in ["z-ai/glm-5.3-flash", "deepseek/deepseek-v4-flash", "google/gemini-2.5-flash-lite", "openai/gpt-6-luna-pro"] {
            assert_eq!(model_option_for(id, "").reasoning_levels, ["auto"], "{id}");
        }
        for profiles in REASONING_PROFILES.as_object().expect("объект").values() {
            for roles in profiles.as_object().expect("объект").values() {
                for role in roles.as_object().expect("объект").keys() {
                    assert!(["narrator", "director", "npc"].contains(&role.as_str()), "{role}");
                }
            }
        }
        assert_eq!(
            serde_json::to_value(model_option_for("vendor/unknown-model", "")).expect("json"),
            json!({ "id": "vendor/unknown-model", "label": "vendor/unknown-model", "description": "", "reasoningLevels": ["auto"], "recommended": false })
        );
        assert!(reasoning_level_allowed_for("vendor/unknown-model", Some("auto")));
        assert!(!reasoning_level_allowed_for("vendor/unknown-model", Some("high")));
        assert!(reasoning_level_allowed_for("openai/gpt-6-luna", Some("deep")));
    }

    #[test]
    fn campaign_role_reasoning_reads_the_table() {
        assert_eq!(campaign_role_reasoning("openai/gpt-6-luna", "deep", "narrator"), Some(json!({ "effort": "high" })));
        assert_eq!(campaign_role_reasoning("openai/gpt-6-luna", "thoughtful", "narrator"), None);
        assert_eq!(campaign_role_reasoning("openai/gpt-6-luna", "deep", ""), None);
        assert_eq!(campaign_role_reasoning("z-ai/glm-5.2", "deep", "npc"), None);
        assert!(supports_json_schema(Some("openai/gpt-4.1-nano")));
        assert!(!supports_json_schema(Some("z-ai/glm-5.3-flash")));
        assert!(!supports_json_schema(None));
    }
}

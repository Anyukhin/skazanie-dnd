//! Сверка небольших модулей с эталонами JS (`fixtures/gen-*.mjs`):
//! нормализация текста рассказчиков, подписи концентрации, каталог клише,
//! профили моделей, контекст кампании, зерно вдохновения, реестр промптов и
//! проверка записи WAV.

use serde_json::{json, Value};
use sk_narration_base::campaign_ai_context::*;
use sk_narration_base::campaign_inspiration::*;
use sk_narration_base::concentration_end_reasons::*;
use sk_narration_base::deterministic_narration::*;
use sk_narration_base::model_style_profiles::*;
use sk_narration_base::narrator_craft_quality::*;
use sk_narration_base::prompt_descriptors::*;
use sk_narration_base::speech_input::validate_speech_wav;
use sk_narration_base::jsx;

fn load(text: &str) -> Value {
    serde_json::from_str(text).expect("эталон")
}

fn list(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).expect("массив")
}

fn to_value(value: impl serde::Serialize) -> Value {
    serde_json::to_value(value).expect("json")
}

#[test]
fn narration_text_normalization_matches_js() {
    let fixture = load(include_str!("../fixtures/deterministic-narration.json"));
    assert_eq!(fixture["priority"], to_value(NARRATOR_PRIORITY));
    let maximum = |case: &Value, fallback: usize| case["maximum"].as_u64().map_or(fallback, |value| value as usize);
    for case in list(&fixture["clean"]) {
        let text = clean_narration_text(Some(&case["value"]), maximum(case, CLEAN_NARRATION_DEFAULT_MAXIMUM));
        assert_eq!(text, case["text"].as_str().expect("строка"), "{case}");
    }
    for case in list(&fixture["or"]) {
        let text = narration_text_or(Some(&case["value"]), case["fallback"].as_str().expect("запас"), maximum(case, NARRATION_TEXT_OR_DEFAULT_MAXIMUM));
        assert_eq!(text, case["text"].as_str().expect("строка"), "{case}");
    }
}

#[test]
fn concentration_labels_match_js() {
    let fixture = load(include_str!("../fixtures/concentration-end-reasons.json"));
    let table: Vec<Value> = CONCENTRATION_END_REASON_LABELS.iter().map(|(key, label)| json!([key, label])).collect();
    assert_eq!(Value::Array(table), fixture["table"]);
    for case in list(&fixture["labels"]) {
        assert_eq!(concentration_end_reason_label(Some(&case["reason"])), case["label"].as_str().expect("подпись"), "{case}");
    }
}

#[test]
fn cliche_findings_match_js() {
    let fixture = load(include_str!("../fixtures/narrator-craft-quality.json"));
    assert_eq!(to_value(NARRATOR_CLICHE_CATALOG), fixture["catalog"]);
    let cases = list(&fixture["cases"]);
    assert!(cases.len() > 200);
    for case in cases {
        assert_eq!(to_value(find_narrator_cliches(Some(&case["text"]))), case["found"], "{}", case["text"]);
    }
}

#[test]
fn model_profiles_match_js() {
    let fixture = load(include_str!("../fixtures/model-style-profiles.json"));
    let options: serde_json::Map<String, Value> = MODEL_OPTIONS.iter().map(|(id, info)| (id.to_string(), to_value(info))).collect();
    assert_eq!(jsx::stringify(&Value::Object(options)), jsx::stringify(&fixture["modelOptions"]));
    assert_eq!(jsx::stringify(&REASONING_PROFILES), jsx::stringify(&fixture["reasoningProfiles"]));
    assert_eq!(fixture["recommendedModel"], RECOMMENDED_MODEL);
    assert_eq!(fixture["selectableExtraModels"], to_value(SELECTABLE_EXTRA_MODELS));
    assert_eq!(fixture["structuredOutputModels"], to_value(STRUCTURED_OUTPUT_MODELS));
    for case in list(&fixture["cases"]) {
        let model = case["model"].as_str();
        assert_eq!(style_addendum_for(model), case["addendum"].as_str().expect("добавка"), "{}", case["model"]);
        assert_eq!(prompt_for_model("база", model), case["prompt"].as_str().expect("промпт"), "{}", case["model"]);
        for role in list(&case["roles"]) {
            // Роль `undefined` в JS — `shared` по умолчанию.
            let name = role["role"].as_str().unwrap_or("shared");
            assert_eq!(prompt_for_model_role("база", model, name), role["prompt"].as_str().expect("промпт"), "{} / {name}", case["model"]);
        }
        assert_eq!(reasoning_profile_for(model).unwrap_or(Value::Null), case["reasoning"], "{}", case["model"]);
        assert_eq!(Value::Bool(supports_json_schema(model)), case["supportsJsonSchema"]);
        let Some(model) = model else { continue };
        assert_eq!(jsx::stringify(&to_value(model_option_for(model, ""))), jsx::stringify(&case["option"]), "{model}");
        assert_eq!(jsx::stringify(&to_value(model_option_for(model, RECOMMENDED_MODEL))), jsx::stringify(&case["optionRecommended"]), "{model}");
        for level in list(&case["levels"]) {
            assert_eq!(Value::Bool(reasoning_level_allowed_for(model, level["level"].as_str())), level["allowed"], "{model} / {}", level["level"]);
        }
        for entry in list(&case["campaign"]) {
            let reasoning = campaign_role_reasoning(model, &jsx::string(Some(&entry["level"])), entry["role"].as_str().expect("роль"));
            assert_eq!(reasoning.unwrap_or(Value::Null), entry["reasoning"], "{model} / {entry}");
        }
    }
}

fn snapshot() -> Value {
    let mut reasoning = Vec::new();
    for model in [Some("openai/gpt-6-luna"), Some("z-ai/glm-5.3-flash"), Some(""), None, Some(" openai/gpt-6-luna")] {
        for role in [Some("narrator"), Some("director"), Some("npc"), Some(""), None] {
            // `campaignReasoningFor(model)` без роли — роль по умолчанию пуста.
            let value = campaign_reasoning_for(model, role.unwrap_or(""));
            reasoning.push(json!({ "model": model, "role": role, "value": value }));
        }
    }
    json!({
        "settings": current_campaign_ai_settings(),
        "model": current_campaign_model(),
        "style": current_narrator_style(),
        "improv": current_improv_mode(),
        "instruction": current_narrator_style_instruction(),
        "parameters": current_narrator_generation_parameters(),
        "reasoning": reasoning,
    })
}

#[test]
fn campaign_context_matches_js() {
    let fixture = load(include_str!("../fixtures/campaign-ai-context.json"));
    assert_eq!(to_value(NARRATOR_STYLES), fixture["narratorStyles"].as_object().map(|map| Value::Array(map.values().cloned().collect())).expect("стили"));
    assert_eq!(to_value(IMPROV_MODES), fixture["improvModes"].as_object().map(|map| Value::Array(map.values().cloned().collect())).expect("режимы"));
    assert_eq!(to_value(REASONING_LEVELS), fixture["reasoningLevels"].as_object().map(|map| Value::Array(map.values().cloned().collect())).expect("уровни"));
    let style_keys: Vec<&String> = fixture["narratorStyles"].as_object().expect("стили").keys().collect();
    assert_eq!(style_keys, NARRATOR_STYLES.iter().map(|style| style.id).collect::<Vec<_>>());
    assert_eq!(fixture["defaults"], json!({ "improv": DEFAULT_IMPROV_MODE, "reasoning": DEFAULT_REASONING_LEVEL }));
    assert_eq!(fixture["generation"], to_value(NARRATOR_GENERATION_PARAMETERS));
    for case in list(&fixture["normalize"]) {
        let value = Some(&case["value"]);
        assert_eq!(normalize_narrator_style(value), case["style"].as_str().expect("стиль"), "{case}");
        assert_eq!(normalize_improv_mode(value), case["improv"].as_str().expect("режим"), "{case}");
        assert_eq!(normalize_reasoning_level(value), case["reasoning"].as_str().expect("уровень"), "{case}");
    }
    assert_eq!(snapshot(), fixture["outside"]);
    for case in list(&fixture["contexts"]) {
        let inside = run_with_campaign_ai_settings(Some(&case["value"]), snapshot);
        assert_eq!(jsx::stringify(&inside), jsx::stringify(&case["inside"]), "{}", case["value"]);
    }
}

#[test]
fn inspiration_matches_js() {
    use sk_dice::{DiceService, SequenceRng};
    let fixture = load(include_str!("../fixtures/campaign-inspiration.json"));
    assert_eq!(fixture["policy"], CAMPAIGN_INSPIRATION_POLICY_ID);
    assert_eq!(fixture["pools"], json!({ "genre": INSPIRATION_GENRE_LEANS, "regions": INSPIRATION_REGIONS, "hooks": INSPIRATION_HOOKS, "details": INSPIRATION_DETAILS }));
    for case in list(&fixture["cases"]) {
        let values: Option<Vec<i64>> = case["dice"].as_array().map(|values| values.iter().filter_map(Value::as_i64).collect());
        let mut service = values.map(|values| DiceService::deterministic(SequenceRng::new(values), "inspiration-roll"));
        let dice = service.as_mut().map(|service| service as &mut dyn sk_dice::Dice);
        let drawn = draw_campaign_inspiration(Some(&case["world"]), dice);
        if case.get("error").is_some() {
            assert!(drawn.is_err(), "{case}: ожидался отказ костей");
            continue;
        }
        let drawn = drawn.expect("зерно");
        assert_eq!(jsx::stringify(&to_value(drawn)), jsx::stringify(&case["inspiration"]), "{}", case["world"]);
        assert_eq!(inspiration_prompt_seed(Some(&drawn)).unwrap_or(Value::Null), case["seed"], "{}", case["world"]);
    }
}

#[test]
fn prompt_registry_matches_js() {
    let fixture = load(include_str!("../fixtures/prompt-descriptors.json"));
    assert_eq!(to_value(PROMPT_DESCRIPTORS), fixture["descriptors"]);
    for case in list(&fixture["lookups"]) {
        let found = descriptor_for_prompt_id(case["promptId"].as_str().expect("id"));
        assert_eq!(found.map(to_value).unwrap_or(Value::Null), case["descriptor"], "{case}");
    }
}

#[test]
fn wav_validation_matches_js() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("../fixtures/speech-input.json")).expect("эталон");
    let hex = |text: &str| -> Vec<u8> { (0..text.len()).step_by(2).map(|index| u8::from_str_radix(&text[index..index + 2], 16).expect("hex")).collect() };
    for case in &cases {
        let header = hex(case["header"].as_str().expect("заголовок"));
        let length = case["length"].as_u64().expect("длина") as usize;
        let mut audio = vec![case["fill"].as_u64().unwrap_or(0) as u8; length];
        audio[..header.len().min(length)].copy_from_slice(&header[..header.len().min(length)]);
        let result = validate_speech_wav(&audio);
        assert_eq!(result.is_ok(), case["valid"].as_bool().expect("итог"), "{}", case["label"]);
        if let (Err(error), Some(message)) = (result, case["message"].as_str()) {
            assert_eq!(error.message, message);
        }
    }
    assert!(cases.len() >= 200);
}

//! Голос хранителя знаний. Модель возвращает только ссылки на серверный
//! материал, а содержательный текст собирает этот модуль. Так источник,
//! субъект действия и порядок известных сведений не могут быть подменены.

use std::sync::Arc;

use serde_json::{json, Map, Value};
use sk_agents_base::llm_client::LlmClient;
use sk_core::{js, text};
use sk_tactics::security::build_data_only_context;

pub const LORE_KEEPER_PROMPT_VERSION: &str = "lore_keeper/v2";
pub const LORE_KEEPER_PROMPT: &str = include_str!("../../../../prompts/lore_keeper/v2.txt");
pub const LORE_VOICE_DEFAULT_TIMEOUT_MS: i64 = 9_000;

fn array<'a>(material: &'a Value, kind: &str) -> Vec<&'a Value> {
    match material.get(kind) {
        Some(Value::Array(items)) => items.iter().collect(),
        _ => Vec::new(),
    }
}

fn kind_allowed(kind: &str) -> bool {
    matches!(kind, "found" | "heard" | "known" | "lead")
}

fn plan_key(kind: &str, index: usize) -> String {
    format!("{kind}:{index}")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoreVerdict {
    pub valid: bool,
    pub reasons: Vec<String>,
    pub plan: Vec<Value>,
}

impl LoreVerdict {
    pub fn to_json(&self) -> Value {
        json!({ "valid": self.valid, "reasons": self.reasons, "plan": self.plan })
    }
}

/// Проверяет строгий ответ-план. Произвольное поле `answer` намеренно не
/// принимается: сервер строит текст из исходных записей сам.
pub fn validate_lore_plan(result: Option<&Value>, material: Option<&Value>) -> LoreVerdict {
    let empty = Value::Object(Map::new());
    let material = material.unwrap_or(&empty);
    let mut reasons = Vec::new();
    let Some(object) = result.and_then(Value::as_object) else {
        return LoreVerdict { valid: false, reasons: vec!["plan_required".into()], plan: Vec::new() };
    };
    if object.keys().any(|key| key != "plan") {
        reasons.push("extra_fields".into());
    }
    let Some(raw_plan) = object.get("plan").and_then(Value::as_array) else {
        return LoreVerdict { valid: false, reasons: { reasons.push("plan_required".into()); reasons }, plan: Vec::new() };
    };
    let total = array(material, "found").len() + array(material, "heard").len() + array(material, "known").len() + 1;
    if raw_plan.len() > total {
        reasons.push("plan_too_long".into());
    }
    let mut seen = std::collections::HashSet::new();
    let mut leads = 0usize;
    for entry in raw_plan {
        let Some(entry_object) = entry.as_object() else {
            reasons.push("invalid_reference".into());
            continue;
        };
        if entry_object.keys().any(|key| key != "kind" && key != "index") {
            reasons.push("invalid_reference".into());
            continue;
        }
        let kind = js::s(entry_object.get("kind"));
        let Some(index) = entry_object.get("index").and_then(Value::as_u64).map(|value| value as usize) else {
            reasons.push("invalid_reference".into());
            continue;
        };
        if !kind_allowed(&kind) || index >= array(material, &kind).len() {
            reasons.push("invalid_reference".into());
            continue;
        }
        if !seen.insert(plan_key(&kind, index)) {
            reasons.push("duplicate_reference".into());
        }
        if kind == "lead" { leads += 1; }
    }
    if leads > 1 { reasons.push("too_many_leads".into()); }
    for kind in ["found", "heard", "known"] {
        for index in 0..array(material, kind).len() {
            if !seen.contains(&plan_key(kind, index)) {
                reasons.push(format!("missing_{kind}:{index}"));
            }
        }
    }
    LoreVerdict { valid: reasons.is_empty(), reasons, plan: raw_plan.clone() }
}

fn lead_text(entry: &Value) -> String {
    let name = js::s(entry.get("name")).trim().to_string();
    let role = text::lower(&js::s(entry.get("role"))).trim().to_string();
    if name.is_empty() { return String::new(); }
    if role.is_empty() { name } else { format!("{name} ({role})") }
}

/// Рендерит только подтверждённые серверные строки.
pub fn render_lore_plan(plan: &[Value], material: &Value) -> String {
    let found = array(material, "found");
    let heard = array(material, "heard");
    let known = array(material, "known");
    let leads = array(material, "lead");
    let mut parts = Vec::new();
    let mut found_header = false;
    let mut heard_header = false;
    for entry in plan {
        let Some(object) = entry.as_object() else { continue };
        let kind = js::s(object.get("kind"));
        let Some(index) = object.get("index").and_then(Value::as_u64).map(|value| value as usize) else { continue };
        match kind.as_str() {
            "found" => if let Some(value) = found.get(index) {
                let value = text::trim(&js::s(Some(value))).to_string();
                if !value.is_empty() { parts.push(format!("{}{}", if found_header { "" } else { "Из того, что вы нашли: " }, value)); found_header = true; }
            },
            "heard" => if let Some(value) = heard.get(index) {
                let who = js::s(value.get("who")).trim().to_string();
                let line = text::replace_all(sk_core::re!(r"[«»]", "gu"), &text::trim(&js::s(value.get("line"))), "\"");
                if !who.is_empty() && !line.is_empty() { parts.push(format!("{}{}: «{line}»", if heard_header { "" } else { "Вам говорили — " }, who)); heard_header = true; }
            },
            "known" => if let Some(value) = known.get(index) {
                let value = text::trim(&js::s(Some(value))).to_string();
                if !value.is_empty() { parts.push(value); }
            },
            "lead" => if let Some(value) = leads.get(index) {
                let lead = lead_text(value);
                if !lead.is_empty() { parts.push(format!("Знать больше может {lead}.")); }
            },
            _ => {}
        }
    }
    let hook = text::trim(&js::s(material.get("hook"))).to_string();
    if !hook.is_empty() { parts.insert(0, format!("Известно немногое: {hook}")); }
    if js::is_true(material.get("unknown")) { parts.insert(0, "Прямого ответа на этот вопрос пока нет.".into()); }
    text::squash_spaces(&parts.join(" "))
}

/// Совместимое имя для генератора эталонов и старых входов проверки.
pub fn verify_lore_answer(answer: Option<&Value>, material: Option<&Value>, _context: Option<&Value>) -> Result<LoreVerdict, String> {
    Ok(validate_lore_plan(answer, material))
}

#[derive(Clone)]
pub struct LoreVoice {
    llm_client: Option<Arc<dyn LlmClient>>,
    timeout_ms: Value,
}

impl LoreVoice {
    pub fn new(llm_client: Option<Arc<dyn LlmClient>>, timeout_ms: Option<Value>) -> Self {
        Self { llm_client, timeout_ms: timeout_ms.unwrap_or_else(|| Value::from(LORE_VOICE_DEFAULT_TIMEOUT_MS)) }
    }

    pub async fn retell(&self, input: &Value) -> Option<Value> {
        let client = self.llm_client.as_ref()?;
        let material = input.get("material").filter(|value| js::truthy(Some(value)))?;
        let count = array(material, "found").len() + array(material, "heard").len() + array(material, "known").len();
        if count == 0 && !js::truthy(material.get("hook")) { return None; }
        let mut brief = Map::new();
        brief.insert("question".into(), Value::String(text::head(&js::s(input.get("question")), 400)));
        if let Some(fields) = material.as_object() { for (key, value) in fields { brief.insert(key.clone(), value.clone()); } }
        brief.insert("location".into(), input.get("location").cloned().unwrap_or_else(|| Value::String(String::new())));
        brief.insert("hero".into(), input.get("hero").cloned().unwrap_or_else(|| Value::String(String::new())));
        let request = json!({
            "messages": [
                { "role": "system", "content": LORE_KEEPER_PROMPT },
                { "role": "user", "content": build_data_only_context(Some(&json!({ "lore_brief": brief }))) },
            ],
            "temperature": 0.2,
            "maxTokens": 300,
            "role": "lore_keeper",
        });
        let result = (**client).complete_json(&request, &json!({ "timeoutMs": self.timeout_ms })).await.ok()?;
        let verdict = validate_lore_plan(Some(&result), Some(material));
        if !verdict.valid { return None; }
        let narration = render_lore_plan(&verdict.plan, material);
        (!narration.is_empty()).then(|| json!({ "narration": narration, "prompt_version": LORE_KEEPER_PROMPT_VERSION }))
    }
}

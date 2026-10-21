//! Перенос `server/lore-voice.mjs`: голос хранителя знаний. Ответ «что мы
//! знаем о…» звучит как реплика ведущего, а не как служебная сводка.
//!
//! Что отвечать, решает сервер: материал отбирает `answerKnownLore`
//! (`player_request_router`). Модель только пересказывает его, и ответ
//! проверяется ([`verify_lore_answer`]): без чисел и служебных слов, без имён
//! вне материала, каждая находка остаётся в ответе по смыслу. Не прошёл —
//! звучит прежний серверный ответ (`None`).
//!
//! Клиент модели внедряется ([`LlmClient`]); промпт —
//! `prompts/lore_keeper/v1.txt`, встроен при сборке.

use std::sync::Arc;

use serde_json::{json, Map, Value};
use sk_agents_base::llm_client::LlmClient;
use sk_core::indexmap::IndexSet;
use sk_core::{js, re, text};
use sk_tactics::security::build_data_only_context;

/// Версия контракта хранителя знаний.
pub const LORE_KEEPER_PROMPT_VERSION: &str = "lore_keeper/v1";

/// `prompts/lore_keeper/v1.txt`.
pub const LORE_KEEPER_PROMPT: &str = include_str!("../../../../prompts/lore_keeper/v1.txt");

/// Срок ответа по умолчанию (`timeoutMs = 9000`).
pub const LORE_VOICE_DEFAULT_TIMEOUT_MS: i64 = 9_000;

fn service_words() -> &'static sk_core::fancy_regex::Regex {
    re!(r"(?<![\p{L}])(?:бриф|сервер\p{L}*|материал\p{L}*|факт\p{L}*|lore_brief|json)(?![\p{L}])", "iu")
}

/// `toLocaleLowerCase('ru').replace(/ё/gu, 'е')`.
fn folded(word: &str) -> String {
    text::lower(word).replace('ё', "е")
}

/// `stem(word)`: первые пять букв в нижнем регистре, «ё» как «е».
fn stem(word: &str) -> String {
    text::head(&folded(word), 5)
}

/// `stemsOf(text)`: основы слов от пяти букв.
fn stems_of(value: &str) -> IndexSet<String> {
    text::find_all(re!(r"\p{L}{5,}", "gu"), value).iter().map(|word| stem(word)).collect()
}

/// `inventedNames(answer, allowedText)`: слова с заглавной не в начале
/// предложения, которых нет в разрешённом тексте даже по основе.
fn invented_names(answer: &str, allowed_text: &str) -> Vec<String> {
    let allowed: Vec<String> = text::find_all(re!(r"\p{L}{3,}", "gu"), allowed_text).iter().map(|word| folded(word)).collect();
    let known = |word: &str| {
        let value: Vec<char> = folded(word).chars().collect();
        allowed.iter().any(|other| {
            let other: Vec<char> = other.chars().collect();
            let shorter = other.len().min(value.len()) as i64;
            let need = 2.max(3.min(shorter - 1)) as usize;
            other.iter().take(need).eq(value.iter().take(need))
        })
    };
    let pattern = re!(r#"(?<![.!?…«"\n]\s{0,3})(?<=\p{L}[,;:—–-]?\s+)(\p{Lu}\p{Ll}{2,})"#, "gu");
    let mut names = Vec::new();
    for captures in pattern.captures_iter(answer).filter_map(Result::ok) {
        if let Some(name) = captures.get(1) {
            if !known(name.as_str()) {
                names.push(name.as_str().to_string());
            }
        }
    }
    names
}

/// `keepsSubstance(answer, item)`: хотя бы две основы находки (или одна у
/// короткой) остались в ответе.
fn keeps_substance(answer: &str, item: &str) -> bool {
    let said = stems_of(answer);
    let own = stems_of(item);
    if own.is_empty() {
        return true;
    }
    let shared = own.iter().filter(|value| said.contains(*value)).count();
    shared >= 2.min(own.len())
}

/// Итог [`verify_lore_answer`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoreVerdict {
    pub valid: bool,
    pub reasons: Vec<String>,
}

impl LoreVerdict {
    /// Форма JS: `{ valid, reasons }`.
    pub fn to_json(&self) -> Value {
        json!({ "valid": self.valid, "reasons": self.reasons })
    }
}

/// Поле объекта (у не-объекта — нет поля).
fn prop<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(Value::as_object).and_then(|map| map.get(key))
}

/// `[...(value ?? [])]`: массив — элементы, строка — символы; иное —
/// `TypeError` V8 («… is not iterable»).
fn spread_items(value: Option<&Value>, label: &str) -> Result<Vec<Value>, String> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => Ok(items.clone()),
        Some(Value::String(chars)) => Ok(chars.chars().map(|ch| Value::String(ch.to_string())).collect()),
        Some(_) => Err(format!("TypeError: {label} is not iterable")),
    }
}

/// `for (const entry of value ?? [])`: то же, но текст V8 у `for…of` другой.
fn iterate_items(value: Option<&Value>) -> Result<Vec<Value>, String> {
    spread_items(value, "").map_err(|_| {
        let shown = match value {
            Some(Value::Number(number)) => format!("number {}", js::js_number_string(number)),
            Some(Value::Bool(flag)) => format!("boolean {flag}"),
            _ => "object".to_string(),
        };
        format!("TypeError: {shown} is not iterable (cannot read property Symbol(Symbol.iterator))")
    })
}

/// `String(value)` в шаблонной строке: `undefined` и `null` — словами.
fn template(value: Option<&Value>) -> String {
    js::string(value)
}

/// Первый кусок `text.split(/\s+/u)`.
fn first_split_piece(value: &str) -> String {
    match re!(r"\s+", "u").find(value) {
        Ok(Some(found)) => value[..found.start()].to_string(),
        _ => value.to_string(),
    }
}

/// `verifyLoreAnswer(answer, material = {}, context = {})`. `None` —
/// аргумент не передан; `Some(null)` у `material`/`context` — `TypeError`,
/// как в JS. `Err` — текст исключения JS.
pub fn verify_lore_answer(answer: Option<&Value>, material: Option<&Value>, context: Option<&Value>) -> Result<LoreVerdict, String> {
    let empty = Value::Object(Map::new());
    let material = material.unwrap_or(&empty);
    let context = context.unwrap_or(&empty);
    let answer_text = text::trim(&js::s(answer)).to_string();
    let mut reasons = Vec::new();
    let length = text::len(&answer_text);
    if !(30..=900).contains(&length) {
        reasons.push("length".to_string());
    }
    if text::test(re!(r"\d", "u"), &answer_text) {
        reasons.push("digits".to_string());
    }
    if text::test(service_words(), &answer_text) {
        reasons.push("service_words".to_string());
    }
    if context.is_null() {
        return Err("TypeError: Cannot read properties of null (reading 'location')".into());
    }
    let nullish_text = |value: Option<&Value>| match value {
        None | Some(Value::Null) => String::new(),
        some => template(some),
    };
    let allowed_text = format!(
        "{} {} {}",
        js::stringify(material),
        nullish_text(prop(Some(context), "location")),
        nullish_text(prop(Some(context), "hero"))
    );
    let names = invented_names(&answer_text, &allowed_text);
    if !names.is_empty() {
        reasons.push(format!("invented_names:{}", names.iter().take(3).cloned().collect::<Vec<_>>().join(",")));
    }
    if material.is_null() {
        return Err("TypeError: Cannot read properties of null (reading 'found')".into());
    }
    let mut items = spread_items(prop(Some(material), "found"), "(material.found ?? [])")?;
    items.extend(spread_items(prop(Some(material), "known"), "(material.known ?? [])")?);
    for item in &items {
        if !keeps_substance(&answer_text, &js::s(Some(item))) {
            reasons.push("lost_finding".to_string());
            break;
        }
    }
    for entry in iterate_items(prop(Some(material), "heard"))? {
        if entry.is_null() {
            return Err("TypeError: Cannot read properties of null (reading 'who')".into());
        }
        let who = js::s(prop(Some(&entry), "who"));
        let first = first_split_piece(&who);
        if !answer_text.contains(&first) && !keeps_substance(&answer_text, &js::s(prop(Some(&entry), "line"))) {
            reasons.push("lost_testimony".to_string());
            break;
        }
    }
    Ok(LoreVerdict { valid: reasons.is_empty(), reasons })
}

/// `.length` значения в JS: массив и строка — свои длины, иное — `undefined`.
fn js_length(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Array(items)) => items.len() as f64,
        Some(Value::String(chars)) => chars.encode_utf16().count() as f64,
        _ => 0.0,
    }
}

/// `LoreVoice`.
#[derive(Clone)]
pub struct LoreVoice {
    llm_client: Option<Arc<dyn LlmClient>>,
    /// `timeoutMs` как передан (JS отдаёт его клиенту без приведения).
    timeout_ms: Value,
}

impl LoreVoice {
    /// `new LoreVoice({ llmClient, timeoutMs = 9000 })`; `None` у срока —
    /// значение по умолчанию.
    pub fn new(llm_client: Option<Arc<dyn LlmClient>>, timeout_ms: Option<Value>) -> Self {
        Self { llm_client, timeout_ms: timeout_ms.unwrap_or_else(|| Value::from(LORE_VOICE_DEFAULT_TIMEOUT_MS)) }
    }

    /// `retell({ question, material, location = '', hero = '' })`: пересказ
    /// материала голосом ведущего или `None`, если модели нет, она ошиблась
    /// или ответ не прошёл проверку. `input` — объект JS; не объект — как
    /// объект без полей.
    pub async fn retell(&self, input: &Value) -> Option<Value> {
        let input = Some(input);
        let client = self.llm_client.as_ref()?;
        let material = prop(input, "material").filter(|material| js::truthy(Some(material)))?;
        let location = prop(input, "location").cloned().unwrap_or_else(|| Value::String(String::new()));
        let hero = prop(input, "hero").cloned().unwrap_or_else(|| Value::String(String::new()));
        let material_ref = Some(material);
        let count = js_length(prop(material_ref, "found")) + js_length(prop(material_ref, "heard")) + js_length(prop(material_ref, "known"));
        if !(count > 0.0 || js::truthy(prop(material_ref, "hook"))) {
            return None;
        }
        let mut brief = Map::new();
        brief.insert("question".into(), Value::String(text::head(&js::s(prop(input, "question")), 400)));
        if let Value::Object(fields) = material {
            for (key, value) in js::entries(fields) {
                brief.insert(key.clone(), value.clone());
            }
        }
        brief.insert("location".into(), location.clone());
        brief.insert("hero".into(), hero.clone());
        let mut sections = Map::new();
        sections.insert("lore_brief".into(), Value::Object(brief));
        let request = json!({
            "messages": [
                { "role": "system", "content": LORE_KEEPER_PROMPT },
                { "role": "user", "content": build_data_only_context(Some(&Value::Object(sections))) },
            ],
            "temperature": 0.5,
            "maxTokens": 600,
            "role": "lore_keeper",
        });
        let options = json!({ "timeoutMs": self.timeout_ms });
        let result = (**client).complete_json(&request, &options).await.ok()?;
        let answer = text::squash_spaces(&js::s(prop(Some(&result), "answer")));
        let context = json!({ "location": location, "hero": hero });
        let verdict = verify_lore_answer(Some(&Value::String(answer.clone())), Some(material), Some(&context)).ok()?;
        if !verdict.valid {
            return None;
        }
        Some(json!({ "narration": answer, "prompt_version": LORE_KEEPER_PROMPT_VERSION }))
    }
}

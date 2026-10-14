//! Перенос `server/rule-pack.mjs`: загрузка и строгая проверка пакета правил.
//!
//! Пакет — каталог `<root>/<ruleset_id>/` с метаданными `manifest.yaml` и
//! `coverage.yaml` (плоский YAML), глоссарием `glossary.csv`, правилами
//! `rules.jsonl`, рёбрами онтологии `ontology_edges.jsonl` и необязательным
//! реестром источников (`manifest.source_registry`). Разбор YAML и CSV —
//! свой и намеренно узкий, как в JS: неподдерживаемая форма — отказ, а не
//! догадка. Перевод правила проверяется на «механические» числа: кости,
//! модификаторы, дроби, проценты и СЛ в русском тексте должны совпасть с
//! английским.
//!
//! Отличия от JS: загрузка синхронная, корень каталога — параметр (в JS —
//! `data/rule_packs` рядом с сервером); опция `freeze` не нужна — значение
//! в Rust и так не меняется без `mut`.

use std::fmt;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::{js, re, text};

use crate::jsv::{self, dot, is_integer, is_number, is_object_like, is_str, non_empty_string, or_text, string_of, ws};

/// Корень пакетов правил относительно корня проекта (`DEFAULT_RULE_PACKS_ROOT`).
pub const DEFAULT_RULE_PACKS_ROOT: &str = "data/rule_packs";

/// Источник `RULESET_ID_PATTERN` (`/^[a-z0-9][a-z0-9._-]{0,79}$/i`).
pub const RULESET_ID_PATTERN: &str = r"^[a-z0-9][a-z0-9._-]{0,79}$";

/// `FORMALIZATION_LEVELS`.
pub const FORMALIZATION_LEVELS: [&str; 3] = ["deterministic", "structured", "retrieval_only"];

const REQUIRED_RULE_FIELDS: [&str; 18] = [
    "id",
    "ruleset_id",
    "version",
    "kind",
    "section_path",
    "title_en",
    "title_ru",
    "text_en",
    "text_ru",
    "tags",
    "entity_refs",
    "aliases_en",
    "aliases_ru",
    "formalization_level",
    "source_page_start",
    "source_page_end",
    "source_hash",
    "license_id",
];

const GLOSSARY_HEADERS: [&str; 5] = ["canonical_id", "term_en", "term_ru", "aliases_ru", "notes"];

/// `RulePackValidationError`: сообщение и подробности (`details`).
#[derive(Debug, Clone, PartialEq)]
pub struct RulePackValidationError {
    pub message: String,
    pub details: Value,
}

impl RulePackValidationError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), details: json!({}) }
    }

    pub fn with_details(message: impl Into<String>, details: Value) -> Self {
        Self { message: message.into(), details }
    }
}

impl fmt::Display for RulePackValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for RulePackValidationError {}

type Result<T> = std::result::Result<T, RulePackValidationError>;

fn fail<T>(message: impl Into<String>) -> Result<T> {
    Err(RulePackValidationError::new(message))
}

/// `RULESET_ID_PATTERN.test(value)`. Флаг `i` без `u` в JS сравнивает только
/// ASCII, поэтому класс выписан обоими регистрами, а не через `(?i)`.
pub fn is_valid_ruleset_id(value: &str) -> bool {
    text::test(re!(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$"), value)
}

fn is_source_registry_file(value: &str) -> bool {
    text::test(re!(r"^[A-Za-z0-9][A-Za-z0-9._-]*\.[Jj][Ss][Oo][Nn]$"), value)
}

fn strip_bom(source: &str) -> &str {
    source.strip_prefix('\u{FEFF}').unwrap_or(source)
}

fn parse_yaml_scalar(raw: &str) -> Result<Value> {
    let value = text::trim(raw);
    if value.is_empty() {
        return Ok(Value::String(String::new()));
    }
    match value {
        "true" => return Ok(Value::Bool(true)),
        "false" => return Ok(Value::Bool(false)),
        "null" | "~" => return Ok(Value::Null),
        _ => {}
    }
    if text::test(re!(r"^-?(?:0|[1-9]\d*)(?:\.\d+)?$"), value) {
        return Ok(js::num(js::parse_number(value)));
    }
    if value.starts_with('"') && value.ends_with('"') {
        return serde_json::from_str::<Value>(value).map_err(|_| RulePackValidationError::new(format!("Invalid quoted YAML scalar: {value}")));
    }
    if value.starts_with('\'') && value.ends_with('\'') {
        return Ok(Value::String(text::slice(value, 1, Some(-1)).replace("''", "'")));
    }
    Ok(Value::String(value.to_string()))
}

/// `parseMetadataYaml(source, label)`: ключи верхнего уровня со скалярами и
/// списками скаляров; вложенность — отказ.
pub fn parse_metadata_yaml(source: &str, label: &str) -> Result<Value> {
    let mut result = Map::new();
    let mut list_key: Option<String> = None;
    let list_item = re!(concat!("^", ws!(), "{2}-", ws!(), "+(", dot!(), "+)$"));
    let leading_space = re!(concat!("^", ws!()));
    let entry = re!(concat!("^([A-Za-z_][A-Za-z0-9_-]*):(?:", ws!(), "*(", dot!(), "*))?$"));
    for (index, raw_line) in jsv::split_lines(strip_bom(source)).into_iter().enumerate() {
        if text::trim(raw_line).is_empty() || text::trim_start(raw_line).starts_with('#') {
            continue;
        }
        if let Some(item) = text::capture(list_item, raw_line, 1) {
            let target = list_key.as_ref().and_then(|key| result.get_mut(key)).and_then(Value::as_array_mut);
            let Some(target) = target else {
                return fail(format!("{label}:{}: list item has no top-level list key", index + 1));
            };
            target.push(parse_yaml_scalar(&item)?);
            continue;
        }
        if text::test(leading_space, raw_line) {
            return fail(format!("{label}:{}: nested YAML is not supported in rule-pack metadata", index + 1));
        }
        let captures = entry.captures(raw_line).ok().flatten();
        let Some(captures) = captures else {
            return fail(format!("{label}:{}: invalid metadata entry", index + 1));
        };
        let key = captures.get(1).map(|m| m.as_str().to_string()).unwrap_or_default();
        let raw_value = captures.get(2).map(|m| m.as_str()).unwrap_or("");
        if result.contains_key(&key) {
            return fail(format!("{label}:{}: duplicate key {key}", index + 1));
        }
        if text::trim(raw_value).is_empty() {
            result.insert(key.clone(), Value::Array(Vec::new()));
            list_key = Some(key);
        } else {
            result.insert(key, parse_yaml_scalar(raw_value)?);
            list_key = None;
        }
    }
    Ok(Value::Object(result))
}

fn strip_cr_end(field: &str) -> String {
    field.strip_suffix('\r').unwrap_or(field).to_string()
}

fn parse_csv_rows(source: &str, label: &str) -> Result<Vec<Vec<String>>> {
    let mut rows = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let chars: Vec<char> = strip_bom(source).chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let character = chars[index];
        if quoted {
            if character == '"' && chars.get(index + 1) == Some(&'"') {
                field.push('"');
                index += 1;
            } else if character == '"' {
                quoted = false;
            } else {
                field.push(character);
            }
            index += 1;
            continue;
        }
        match character {
            '"' => {
                if !field.is_empty() {
                    return fail(format!("{label}: quote inside an unquoted CSV field"));
                }
                quoted = true;
            }
            ',' => row.push(std::mem::take(&mut field)),
            '\n' => {
                row.push(strip_cr_end(&field));
                if row.iter().any(|value| !value.is_empty()) {
                    rows.push(std::mem::take(&mut row));
                }
                row.clear();
                field.clear();
            }
            _ => field.push(character),
        }
        index += 1;
    }
    if quoted {
        return fail(format!("{label}: unterminated quoted CSV field"));
    }
    row.push(strip_cr_end(&field));
    if row.iter().any(|value| !value.is_empty()) {
        rows.push(row);
    }
    Ok(rows)
}

/// `parseGlossaryCsv(source, label)`: строки глоссария с разобранными
/// `aliases_ru` (через `|`).
pub fn parse_glossary_csv(source: &str, label: &str) -> Result<Value> {
    let rows = parse_csv_rows(source, label)?;
    let Some(header) = rows.first() else {
        return fail(format!("{label}: glossary is empty"));
    };
    if header.len() != GLOSSARY_HEADERS.len() || header.iter().zip(GLOSSARY_HEADERS).any(|(value, expected)| text::trim(value) != expected) {
        return fail(format!("{label}: expected header {}", GLOSSARY_HEADERS.join(",")));
    }
    let mut entries = Vec::new();
    for (index, values) in rows[1..].iter().enumerate() {
        if values.len() != GLOSSARY_HEADERS.len() {
            return fail(format!("{label}:{}: expected {} columns, got {}", index + 2, GLOSSARY_HEADERS.len(), values.len()));
        }
        let mut entry = Map::new();
        for (header, value) in GLOSSARY_HEADERS.iter().zip(values) {
            entry.insert((*header).to_string(), Value::String(text::trim(value).to_string()));
        }
        let aliases: Vec<Value> = text::trim(&values[3])
            .split('|')
            .map(text::trim)
            .filter(|alias| !alias.is_empty())
            .map(|alias| Value::String(alias.to_string()))
            .collect();
        entry.insert("aliases_ru".into(), Value::Array(aliases));
        entries.push(Value::Object(entry));
    }
    Ok(Value::Array(entries))
}

/// `parseJsonLines(source, label)`: объект на строку, пустые строки пропускаются.
///
/// Текст ошибки разбора в скобках — от `serde_json`, а не от `JSON.parse`.
pub fn parse_json_lines(source: &str, label: &str) -> Result<Vec<Value>> {
    let mut entries = Vec::new();
    for (index, raw) in jsv::split_lines(strip_bom(source)).into_iter().enumerate() {
        let line = text::trim(raw);
        if line.is_empty() {
            continue;
        }
        let parsed = serde_json::from_str::<Value>(line).map_err(|error| error.to_string()).and_then(|entry| {
            if entry.is_object() {
                Ok(entry)
            } else {
                Err("entry must be an object".to_string())
            }
        });
        match parsed {
            Ok(entry) => entries.push(entry),
            Err(message) => return fail(format!("{label}:{}: invalid JSONL entry ({message})", index + 1)),
        }
    }
    Ok(entries)
}

/// `extractMechanicalTokens(source)`: кости, модификаторы, дроби, проценты и
/// множители в тексте, отсортированные `localeCompare` (ICU).
pub fn extract_mechanical_tokens(source: &str) -> Vec<String> {
    let normalized = text::lower(&text::nfkc(source));
    let normalized = text::replace_all(re!(r"[−–—]", "g"), &normalized, "-");
    let normalized = text::replace_all(re!(r"(\d),(\d)", "g"), &normalized, "${1}.${2}");
    let pattern = re!(
        concat!(
            r"(?<![\p{L}\p{N}_])(?:\d+",
            ws!(),
            r"*d",
            ws!(),
            r"*\d+(?:",
            ws!(),
            r"*[+-]",
            ws!(),
            r"*\d+)?|d",
            ws!(),
            r"*\d+(?:",
            ws!(),
            r"*[+-]",
            ws!(),
            r"*\d+)?|\d+",
            ws!(),
            r"*\/",
            ws!(),
            r"*\d+|\d+(?:\.\d+)?",
            ws!(),
            r"*%|\d+(?:\.\d+)?",
            ws!(),
            r"*[x×]|[+-]?\d+(?:\.\d+)?)(?![\p{L}\p{N}_])"
        ),
        "giu"
    );
    let space = re!(concat!(ws!(), "+"), "g");
    let mut tokens: Vec<String> = text::find_all(pattern, &normalized)
        .into_iter()
        .map(|token| text::replace_all(space, &token, "").replacen('×', "x", 1))
        .collect();
    tokens.sort_by(|left, right| text::locale_compare(left, right));
    tokens
}

fn multiset_difference(left: &[String], right: &[String]) -> Vec<String> {
    let mut remaining: IndexMap<&str, usize> = IndexMap::new();
    for token in right {
        *remaining.entry(token.as_str()).or_insert(0) += 1;
    }
    let mut difference = Vec::new();
    for token in left {
        match remaining.get_mut(token.as_str()) {
            Some(count) if *count > 0 => *count -= 1,
            _ => difference.push(token.clone()),
        }
    }
    difference
}

/// Итог `checkTranslationNumericIntegrity`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NumericIntegrityCheck {
    pub ok: bool,
    pub source_tokens: Vec<String>,
    pub translated_tokens: Vec<String>,
    pub missing: Vec<String>,
    pub extra: Vec<String>,
}

impl NumericIntegrityCheck {
    /// Форма JS: `{ ok, sourceTokens, translatedTokens, missing, extra }`.
    pub fn to_json(&self) -> Value {
        json!({
            "ok": self.ok,
            "sourceTokens": self.source_tokens,
            "translatedTokens": self.translated_tokens,
            "missing": self.missing,
            "extra": self.extra,
        })
    }
}

/// `checkTranslationNumericIntegrity(sourceText, translatedText)`.
pub fn check_translation_numeric_integrity(source_text: &str, translated_text: &str) -> NumericIntegrityCheck {
    let source_tokens = extract_mechanical_tokens(source_text);
    let translated_tokens = extract_mechanical_tokens(translated_text);
    let missing = multiset_difference(&source_tokens, &translated_tokens);
    let extra = multiset_difference(&translated_tokens, &source_tokens);
    NumericIntegrityCheck { ok: missing.is_empty() && extra.is_empty(), source_tokens, translated_tokens, missing, extra }
}

/// `assertTranslationNumericIntegrity(rule)`.
pub fn assert_translation_numeric_integrity(rule: &Value) -> Result<NumericIntegrityCheck> {
    let check = check_translation_numeric_integrity(
        &format!("{}\n{}", or_text(rule.get("title_en"), ""), or_text(rule.get("text_en"), "")),
        &format!("{}\n{}", or_text(rule.get("title_ru"), ""), or_text(rule.get("text_ru"), "")),
    );
    if !check.ok {
        let mut details = Map::new();
        if let Some(id) = rule.get("id") {
            details.insert("rule_id".into(), id.clone());
        }
        if let Value::Object(fields) = check.to_json() {
            details.extend(fields);
        }
        return Err(RulePackValidationError::with_details(
            format!("Rule {} changes mechanical numbers in translation", or_text(rule.get("id"), "<unknown>")),
            Value::Object(details),
        ));
    }
    Ok(check)
}

fn assert_string(value: Option<&Value>, label: &str) -> Result<()> {
    if non_empty_string(value).is_none() {
        return fail(format!("{label} must be a non-empty string"));
    }
    Ok(())
}

fn assert_string_array(value: Option<&Value>, label: &str) -> Result<()> {
    match value {
        Some(Value::Array(items)) if items.iter().all(|item| non_empty_string(Some(item)).is_some()) => Ok(()),
        _ => fail(format!("{label} must be an array of non-empty strings")),
    }
}

fn validate_source_registry<'a>(registry: Option<&'a Value>, ruleset_id: &str) -> Result<IndexMap<String, &'a Value>> {
    let Some(registry @ Value::Object(_)) = registry else {
        return fail("Rule-pack source registry must be an object");
    };
    if !is_number(registry.get("schema_version"), 1.0) {
        return fail("Rule-pack source registry must use schema_version 1");
    }
    if !is_str(registry.get("ruleset_id"), ruleset_id) {
        return fail(format!("Source registry belongs to {}, expected {ruleset_id}", or_text(registry.get("ruleset_id"), "<unknown>")));
    }
    let sources = match registry.get("sources") {
        Some(Value::Array(sources)) if !sources.is_empty() => sources,
        _ => return fail("Rule-pack source registry must contain sources"),
    };
    let mut sources_by_id = IndexMap::new();
    for source in sources {
        for field in ["id", "title", "url", "edition_family", "revision_id", "accessed_at", "rights_status"] {
            assert_string(jsv::member(Some(source), field), &format!("source.{field}"))?;
        }
        let id = string_of(source.get("id"));
        if !string_of(source.get("url")).starts_with("https://") {
            return fail(format!("Source {id} must use an https URL"));
        }
        if !js::is_false(source.get("bundled")) {
            return fail(format!("Source {id} must explicitly remain unbundled"));
        }
        if sources_by_id.contains_key(&id) {
            return fail(format!("Duplicate source id {id}"));
        }
        sources_by_id.insert(id, source);
    }
    Ok(sources_by_id)
}

fn validate_rule(rule: &Value, ruleset_id: &str, seen_ids: &mut IndexSet<String>, sources_by_id: Option<&IndexMap<String, &Value>>) -> Result<()> {
    for field in REQUIRED_RULE_FIELDS {
        let has = matches!(rule, Value::Object(map) if map.contains_key(field));
        if !has {
            return fail(format!("Rule {} misses required field {field}", or_text(rule.get("id"), "<unknown>")));
        }
    }
    assert_string(rule.get("id"), "rule.id")?;
    let id = string_of(rule.get("id"));
    if seen_ids.contains(&id) {
        return fail(format!("Duplicate rule id {id}"));
    }
    seen_ids.insert(id.clone());
    if !is_str(rule.get("ruleset_id"), ruleset_id) {
        return fail(format!("Rule {id} belongs to {}, expected {ruleset_id}", string_of(rule.get("ruleset_id"))));
    }
    if !id.starts_with(&format!("{ruleset_id}:")) {
        return fail(format!("Rule id {id} is not namespaced by {ruleset_id}"));
    }
    for field in ["version", "kind", "title_en", "title_ru", "text_en", "text_ru", "source_hash", "license_id"] {
        assert_string(rule.get(field), &format!("{id}.{field}"))?;
    }
    for field in ["section_path", "tags", "entity_refs", "aliases_en", "aliases_ru"] {
        assert_string_array(rule.get(field), &format!("{id}.{field}"))?;
    }
    let level = rule.get("formalization_level");
    if !FORMALIZATION_LEVELS.iter().any(|expected| is_str(level, expected)) {
        return fail(format!("Rule {id} has unsupported formalization level {}", string_of(level)));
    }
    let start = rule.get("source_page_start");
    let end = rule.get("source_page_end");
    if !is_integer(start) || !is_integer(end) || js::number(start) < 0.0 || js::number(end) < js::number(start) {
        return fail(format!("Rule {id} has invalid source page range"));
    }
    if let Some(sources_by_id) = sources_by_id {
        assert_string(rule.get("source_ref"), &format!("{id}.source_ref"))?;
        let source_ref = string_of(rule.get("source_ref"));
        let Some(source) = sources_by_id.get(&source_ref) else {
            return fail(format!("Rule {id} references unknown source {source_ref}"));
        };
        let revision = source.get("revision_id");
        let same = matches!((rule.get("source_hash"), revision), (Some(Value::String(a)), Some(Value::String(b))) if a == b);
        if !same {
            return fail(format!("Rule {id} source revision does not match {source_ref}"));
        }
    }
    assert_translation_numeric_integrity(rule)?;
    Ok(())
}

/// `validateRulePack(pack, { expectedRulesetId })`: сводка пакета или отказ.
pub fn validate_rule_pack(pack: &Value, expected_ruleset_id: Option<&str>) -> Result<Value> {
    if !is_object_like(Some(pack)) {
        return fail("Rule pack must be an object");
    }
    let manifest = jsv::member(Some(pack), "manifest");
    let rules = jsv::member(Some(pack), "rules");
    let glossary = jsv::member(Some(pack), "glossary");
    let ontology_edges = jsv::member(Some(pack), "ontologyEdges");
    let coverage = jsv::member(Some(pack), "coverage");
    let source_registry = jsv::member(Some(pack), "sourceRegistry").unwrap_or(&Value::Null);
    if !(js::truthy(manifest) && is_object_like(manifest)) {
        return fail("Rule pack has no manifest");
    }
    let field = |key: &str| jsv::member(manifest, key);
    assert_string(field("ruleset_id"), "manifest.ruleset_id")?;
    let ruleset_id = string_of(field("ruleset_id"));
    if !is_valid_ruleset_id(&ruleset_id) {
        return fail(format!("Invalid ruleset_id {ruleset_id}"));
    }
    if let Some(expected) = expected_ruleset_id.filter(|expected| !expected.is_empty()) {
        if ruleset_id != expected {
            return fail(format!("Loaded ruleset {ruleset_id} does not match requested {expected}"));
        }
    }
    for key in ["pack_id", "edition_family", "version", "canonical_language", "license_id", "created_at", "verified_at"] {
        assert_string(field(key), &format!("manifest.{key}"))?;
    }
    if !["en", "ru"].iter().any(|language| is_str(field("canonical_language"), language)) {
        return fail("manifest.canonical_language must be en or ru");
    }
    assert_string_array(field("display_languages"), "manifest.display_languages")?;
    let languages = field("display_languages").and_then(Value::as_array).cloned().unwrap_or_default();
    if !languages.iter().any(|language| language == "ru") || !languages.iter().any(|language| language == "en") {
        return fail("manifest.display_languages must include ru and en");
    }
    let mut sources_by_id = None;
    if js::truthy(field("source_registry")) {
        assert_string(field("source_registry"), "manifest.source_registry")?;
        let file = string_of(field("source_registry"));
        if !is_source_registry_file(&file) {
            return fail(format!("Invalid source registry filename {file}"));
        }
        sources_by_id = Some(validate_source_registry(Some(source_registry), &ruleset_id)?);
    } else if js::truthy(Some(source_registry)) {
        return fail("Rule pack has a source registry that is not declared by its manifest");
    }
    let rules = match rules {
        Some(Value::Array(rules)) if !rules.is_empty() => rules,
        _ => return fail("Rule pack must contain at least one rule"),
    };
    let mut seen_ids = IndexSet::new();
    for rule in rules {
        validate_rule(rule, &ruleset_id, &mut seen_ids, sources_by_id.as_ref())?;
    }

    let Some(Value::Array(glossary)) = glossary else {
        return fail("Rule pack glossary must be an array");
    };
    let mut glossary_ids = IndexSet::new();
    for entry in glossary {
        assert_string(jsv::member(Some(entry), "canonical_id"), "glossary.canonical_id")?;
        let canonical_id = string_of(entry.get("canonical_id"));
        assert_string(entry.get("term_en"), &format!("{canonical_id}.term_en"))?;
        assert_string(entry.get("term_ru"), &format!("{canonical_id}.term_ru"))?;
        assert_string_array(entry.get("aliases_ru"), &format!("{canonical_id}.aliases_ru"))?;
        if !glossary_ids.insert(canonical_id.clone()) {
            return fail(format!("Duplicate glossary id {canonical_id}"));
        }
    }

    let Some(Value::Array(ontology_edges)) = ontology_edges else {
        return fail("Rule pack ontologyEdges must be an array");
    };
    for edge in ontology_edges {
        let edge_field = |key: &str| jsv::member(Some(edge), key);
        if !is_str(edge_field("ruleset_id"), &ruleset_id) {
            return fail(format!("Ontology edge mixes {} into {ruleset_id}", string_of(edge_field("ruleset_id"))));
        }
        let known = |value: Option<&Value>| matches!(value, Some(Value::String(id)) if seen_ids.contains(id));
        let from = string_of(edge_field("from_id"));
        let to = string_of(edge_field("to_id"));
        if !known(edge_field("from_id")) || !known(edge_field("to_id")) {
            return fail(format!("Ontology edge {from} -> {to} references an unknown rule"));
        }
        assert_string(edge_field("relation"), "ontology edge relation")?;
        let weight = match edge_field("weight") {
            Some(Value::Number(weight)) => weight.as_f64().unwrap_or(f64::NAN),
            _ => f64::NAN,
        };
        if weight.is_nan() || weight <= 0.0 || weight > 1.0 {
            return fail(format!("Ontology edge {from} -> {to} has invalid weight"));
        }
    }

    if !(js::truthy(coverage) && is_object_like(coverage)) {
        return fail("Rule pack has no coverage metadata");
    }
    let coverage_field = |key: &str| jsv::member(coverage, key);
    if !is_str(coverage_field("ruleset_id"), &ruleset_id) {
        return fail(format!("Coverage belongs to {}, expected {ruleset_id}", string_of(coverage_field("ruleset_id"))));
    }
    for (key, actual) in [("rule_count", rules.len()), ("glossary_term_count", glossary.len()), ("ontology_edge_count", ontology_edges.len())] {
        if !is_number(coverage_field(key), actual as f64) {
            return fail(format!("Coverage {key}={}, actual={actual}", string_of(coverage_field(key))));
        }
    }

    let mut summary = Map::new();
    summary.insert("ruleset_id".into(), Value::String(ruleset_id));
    summary.insert("pack_id".into(), field("pack_id").cloned().unwrap_or(Value::Null));
    summary.insert("rule_count".into(), Value::from(rules.len()));
    summary.insert("glossary_term_count".into(), Value::from(glossary.len()));
    summary.insert("ontology_edge_count".into(), Value::from(ontology_edges.len()));
    if let Some(sources_by_id) = sources_by_id {
        summary.insert("source_count".into(), Value::from(sources_by_id.len()));
    }
    Ok(Value::Object(summary))
}

fn resolve_pack_directory(root_dir: &Path, ruleset_id: &str) -> Result<PathBuf> {
    if !is_valid_ruleset_id(ruleset_id) {
        let shown = if ruleset_id.is_empty() { "<empty>" } else { ruleset_id };
        return fail(format!("Invalid ruleset_id {shown}"));
    }
    // Шаблон идентификатора не пропускает разделителей пути, `.` и `..`,
    // поэтому каталог пакета всегда лежит прямо в корне.
    let root = std::path::absolute(root_dir).unwrap_or_else(|_| root_dir.to_path_buf());
    Ok(root.join(ruleset_id))
}

fn read_text(path: &Path) -> std::result::Result<String, String> {
    std::fs::read(path).map(|bytes| String::from_utf8_lossy(&bytes).into_owned()).map_err(|error| jsv::io_message(&error, path))
}

/// `loadRulePack(rulesetId, { rootDir })`: пакет `<root_dir>/<ruleset_id>`
/// в форме JS-объекта с `summary`.
pub fn load_rule_pack(ruleset_id: &str, root_dir: &Path) -> Result<Value> {
    let directory = resolve_pack_directory(root_dir, ruleset_id)?;
    let unreadable = |message: String| {
        RulePackValidationError::with_details(
            format!("Unable to read rule pack {ruleset_id}: {message}"),
            json!({ "ruleset_id": ruleset_id, "directory": directory.display().to_string() }),
        )
    };
    let manifest_source = read_text(&directory.join("manifest.yaml")).map_err(unreadable)?;
    let manifest = parse_metadata_yaml(&manifest_source, &format!("{ruleset_id}/manifest.yaml"))?;
    let mut contents = Vec::new();
    for file in ["glossary.csv", "rules.jsonl", "ontology_edges.jsonl", "coverage.yaml"] {
        contents.push(read_text(&directory.join(file)).map_err(unreadable)?);
    }
    let mut source_registry = Value::Null;
    if js::truthy(manifest.get("source_registry")) {
        let file = string_of(manifest.get("source_registry"));
        if !is_source_registry_file(&file) {
            return fail(format!("Invalid source registry filename {file}"));
        }
        let parsed = read_text(&directory.join(&file)).and_then(|source| serde_json::from_str::<Value>(&source).map_err(|error| error.to_string()));
        source_registry = parsed.map_err(|message| RulePackValidationError::new(format!("Unable to read source registry for {ruleset_id}: {message}")))?;
    }
    let mut pack = Map::new();
    pack.insert("directory".into(), Value::String(directory.display().to_string()));
    pack.insert("manifest".into(), manifest);
    pack.insert("glossary".into(), parse_glossary_csv(&contents[0], &format!("{ruleset_id}/glossary.csv"))?);
    pack.insert("rules".into(), Value::Array(parse_json_lines(&contents[1], &format!("{ruleset_id}/rules.jsonl"))?));
    pack.insert("ontologyEdges".into(), Value::Array(parse_json_lines(&contents[2], &format!("{ruleset_id}/ontology_edges.jsonl"))?));
    pack.insert("coverage".into(), parse_metadata_yaml(&contents[3], &format!("{ruleset_id}/coverage.yaml"))?);
    pack.insert("sourceRegistry".into(), source_registry);
    let mut pack = Value::Object(pack);
    let summary = validate_rule_pack(&pack, Some(ruleset_id))?;
    js::assign(&mut pack, json!({ "summary": summary }));
    Ok(pack)
}

/// `loadRulePacks(rulesetIds, options)`.
pub fn load_rule_packs(ruleset_ids: &[&str], root_dir: &Path) -> Result<Vec<Value>> {
    if ruleset_ids.is_empty() {
        return fail("rulesetIds must be a non-empty array");
    }
    let unique: IndexSet<&str> = ruleset_ids.iter().copied().collect();
    if unique.len() != ruleset_ids.len() {
        return fail("rulesetIds contains duplicates");
    }
    ruleset_ids.iter().map(|ruleset_id| load_rule_pack(ruleset_id, root_dir)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn yaml_scalars_follow_js() {
        let parsed = parse_metadata_yaml("a: 2\nb: -0.5\nc: \"x\\ty\"\nd: 'it''s'\ne: ~\nf: 5.2.1\ng: true\n", "t").expect("yaml");
        assert_eq!(parsed, json!({ "a": 2, "b": -0.5, "c": "x\ty", "d": "it's", "e": null, "f": "5.2.1", "g": true }));
        let error = parse_metadata_yaml("a: \"broken\\q\"\n", "t").expect_err("кавычки");
        assert_eq!(error.message, "Invalid quoted YAML scalar: \"broken\\q\"");
        assert_eq!(parse_metadata_yaml("  - x\n", "m.yaml").expect_err("список").message, "m.yaml:1: list item has no top-level list key");
        assert_eq!(parse_metadata_yaml("a: 1\na: 2\n", "m").expect_err("повтор").message, "m:2: duplicate key a");
        assert_eq!(parse_metadata_yaml("1a: 1\n", "m").expect_err("ключ").message, "m:1: invalid metadata entry");
        assert_eq!(parse_metadata_yaml("\u{FEFF}# c\nlist:\n  -  \n", "m").expect("пустой элемент"), json!({ "list": [""] }));
    }

    #[test]
    fn csv_and_jsonl_errors_follow_js() {
        assert_eq!(parse_glossary_csv("", "g.csv").expect_err("пусто").message, "g.csv: glossary is empty");
        assert_eq!(
            parse_glossary_csv("canonical_id,term_en\n", "g.csv").expect_err("заголовок").message,
            "g.csv: expected header canonical_id,term_en,term_ru,aliases_ru,notes"
        );
        assert_eq!(
            parse_glossary_csv("canonical_id,term_en,term_ru,aliases_ru,notes\na,b\n", "g.csv").expect_err("колонки").message,
            "g.csv:2: expected 5 columns, got 2"
        );
        assert_eq!(parse_glossary_csv("a\"b\"", "g").expect_err("кавычка").message, "g: quote inside an unquoted CSV field");
        assert_eq!(parse_glossary_csv("\"a", "g").expect_err("незакрытая").message, "g: unterminated quoted CSV field");
        assert_eq!(parse_json_lines("{}\n\n[1]\n", "d").expect_err("массив").message, "d:3: invalid JSONL entry (entry must be an object)");
        assert!(parse_json_lines("{oops", "d").expect_err("разбор").message.starts_with("d:1: invalid JSONL entry ("));
    }

    #[test]
    fn ruleset_id_pattern_is_ascii_only() {
        assert!(is_valid_ruleset_id("SRD_5.2-1"));
        assert!(!is_valid_ruleset_id("../srd"));
        assert!(!is_valid_ruleset_id("ſrd"));
        assert!(!is_valid_ruleset_id(&"a".repeat(81)));
        assert!(is_source_registry_file("Sources.JSON"));
        assert!(!is_source_registry_file("../sources.json"));
    }
}

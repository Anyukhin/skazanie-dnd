//! Перенос `server/rule-retriever.mjs`: локальный поиск по пакетам правил.
//!
//! Оценка документа складывается из лексической части (стемы с весами по
//! полям правила, IDF, нечёткое совпадение по Левенштейну), локального
//! вектора (хеширование признаков в 384 измерения, косинус) и совпадения
//! фраз (названия, синонимы, глоссарий); два лучших прямых попадания
//! поднимают соседей по онтологии. Всё детерминировано: те же запросы дают те
//! же числа и тот же порядок, что JS.
//!
//! Точность до бита: длины, срезы и хеши считаются в единицах UTF-16, как
//! `length`, `slice` и `charCodeAt` в JS; логарифм IDF — перенос `fdlibm`
//! (`Math.log` в V8), а не системный `ln`, чтобы последний бит не зависел от
//! платформы. Поиск синхронный (в JS — `async`).

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::indexmap::{IndexMap, IndexSet};
use sk_core::{js, re, text};

use crate::jsv::{self, nullish, utf16_len};
use crate::rule_pack::{validate_rule_pack, RulePackValidationError};

/// Размерность локального вектора (`DEFAULT_VECTOR_DIMENSIONS`).
pub const DEFAULT_VECTOR_DIMENSIONS: usize = 384;
const MAX_LIMIT: f64 = 50.0;

static STOP_WORDS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        "а", "без", "бы", "в", "во", "вы", "для", "до", "его", "ее", "её", "если", "и", "или", "из", "как", "ко", "ли", "мне", "можно", "мой", "мы", "на", "над", "не", "нужно", "о", "об", "от", "по", "под", "после", "при", "про", "с", "со", "у", "что", "я",
        "a", "an", "and", "are", "at", "be", "can", "do", "does", "for", "from", "how", "i", "if", "in", "is", "it", "may", "my", "of", "on", "or", "the", "to", "when", "with", "work", "works",
    ]
    .into_iter()
    .collect()
});

static RUSSIAN_SUFFIXES: LazyLock<Vec<&'static str>> = LazyLock::new(|| {
    let mut suffixes = vec![
        "иями", "ями", "ами", "иями", "его", "ого", "ему", "ому", "ее", "ие", "ые", "ое", "ей", "ий", "ый", "ой", "ем", "им", "ым", "ом", "их", "ых", "ую", "юю", "ая", "яя", "ою", "ею",
        "ение", "ения", "ению", "ением", "ениях", "ация", "ации", "ацию", "ацией", "ость", "ости", "остью",
        "ировать", "ировать", "овать", "евать", "ившись", "ывшись", "ивши", "ывши", "ив", "ыв", "иться", "аться", "яться",
        "ешь", "ете", "ить", "ыть", "ать", "ять", "еть", "уть", "ют", "уют", "ят", "ают", "ен", "ила", "ыла", "ена", "ейте", "уйте", "ите", "или", "ыли", "ей", "уй", "ил", "ыл", "им", "ым", "ен", "ило", "ыло", "ено", "ят", "ует", "уют", "ит", "ыт", "ены", "ить", "ыть", "ишь", "ую", "ю",
        "ов", "ев", "ей", "ам", "ям", "ах", "ях", "ом", "ем", "ами", "ями", "ия", "ью", "ию", "ии", "иям", "ием", "иях", "а", "я", "ы", "и", "ь", "й", "у", "ю", "о", "е",
    ];
    // Устойчивая сортировка по убыванию длины, как `Array.prototype.sort`.
    suffixes.sort_by_key(|suffix| std::cmp::Reverse(utf16_len(suffix)));
    suffixes
});

/// Отказ поиска: `TypeError`, `RangeError` или отказ проверки пакета.
#[derive(Debug, Clone, PartialEq)]
pub enum RetrieverError {
    Type(String),
    Range(String),
    Validation(RulePackValidationError),
}

impl RetrieverError {
    pub fn message(&self) -> &str {
        match self {
            Self::Type(message) | Self::Range(message) => message,
            Self::Validation(error) => &error.message,
        }
    }
}

impl fmt::Display for RetrieverError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for RetrieverError {}

impl From<RulePackValidationError> for RetrieverError {
    fn from(error: RulePackValidationError) -> Self {
        Self::Validation(error)
    }
}

type Result<T> = std::result::Result<T, RetrieverError>;

/// `normalizeForSearch(value)`: NFKC, нижний регистр, `ё` → `е`, без
/// апострофов, всё, кроме букв, цифр, `+` и `-`, — пробел.
pub fn normalize_for_search(value: &str) -> String {
    let lowered = text::lower(&text::nfkc(value)).replace('ё', "е");
    let without_quotes = text::replace_all(re!(r"[’'`]", "g"), &lowered, "");
    let spaced = text::replace_all(re!(r"[^\p{L}\p{N}+-]+", "gu"), &without_quotes, " ");
    text::replace_all(re!(r"\s+", "g"), text::trim(&spaced), " ")
}

/// `text.slice(0, -count)` в единицах UTF-16 для суффикса из BMP.
fn drop_suffix(token: &str, suffix: &str) -> String {
    token[..token.len() - suffix.len()].to_string()
}

fn stem_russian(token: &str) -> String {
    if !text::test(re!(r"[а-я]", "u"), token) || utf16_len(token) < 4 {
        return token.to_string();
    }
    for suffix in RUSSIAN_SUFFIXES.iter() {
        if token.ends_with(suffix) && utf16_len(token) - utf16_len(suffix) >= 3 {
            return drop_suffix(token, suffix);
        }
    }
    token.to_string()
}

fn stem_english(token: &str) -> String {
    if !text::test(re!(r"^[a-z]+$"), token) || token.len() < 4 {
        return token.to_string();
    }
    if token.ends_with("ies") && token.len() > 5 {
        return format!("{}y", drop_suffix(token, "ies"));
    }
    for suffix in ["ingly", "edly", "ing", "ed", "es", "s"] {
        if token.ends_with(suffix) && token.len() - suffix.len() >= 3 {
            return drop_suffix(token, suffix);
        }
    }
    token.to_string()
}

/// `stemSearchToken(token)`.
pub fn stem_search_token(token: &str) -> String {
    let normalized = normalize_for_search(token);
    if normalized.is_empty() || normalized.contains(' ') {
        return normalized;
    }
    stem_english(&stem_russian(&normalized))
}

/// Слово запроса и его стем.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchToken {
    pub raw: String,
    pub stem: String,
}

impl SearchToken {
    pub fn to_json(&self) -> Value {
        json!({ "raw": self.raw, "stem": self.stem })
    }
}

/// `tokenizeForSearch(value, { keepStopWords })`.
pub fn tokenize_for_search(value: &str, keep_stop_words: bool) -> Vec<SearchToken> {
    let normalized = normalize_for_search(value);
    if normalized.is_empty() {
        return Vec::new();
    }
    let mut result = Vec::new();
    for raw in normalized.split(' ') {
        if raw.is_empty() || (!keep_stop_words && STOP_WORDS.contains(raw)) {
            continue;
        }
        let stem = stem_search_token(raw);
        if stem.is_empty() || (!keep_stop_words && STOP_WORDS.contains(stem.as_str())) {
            continue;
        }
        result.push(SearchToken { raw: raw.to_string(), stem });
    }
    result
}

/// `levenshteinDistance(left, right, maximum)` по единицам UTF-16; при
/// превышении `maximum` — `maximum + 1`. `None` — без предела.
pub fn levenshtein_distance(left: &str, right: &str, maximum: Option<usize>) -> usize {
    if left == right {
        return 0;
    }
    let left: Vec<u16> = left.encode_utf16().collect();
    let right: Vec<u16> = right.encode_utf16().collect();
    if let Some(maximum) = maximum {
        if left.len().abs_diff(right.len()) > maximum {
            return maximum + 1;
        }
    }
    if left.is_empty() {
        return right.len();
    }
    if right.is_empty() {
        return left.len();
    }
    let mut previous: Vec<usize> = (0..=right.len()).collect();
    for row in 1..=left.len() {
        let mut current = Vec::with_capacity(right.len() + 1);
        current.push(row);
        let mut row_minimum = row;
        for column in 1..=right.len() {
            let cost = usize::from(left[row - 1] != right[column - 1]);
            let value = (current[column - 1] + 1).min(previous[column] + 1).min(previous[column - 1] + cost);
            current.push(value);
            row_minimum = row_minimum.min(value);
        }
        if let Some(maximum) = maximum {
            if row_minimum > maximum {
                return maximum + 1;
            }
        }
        previous = current;
    }
    previous[right.len()]
}

fn hash_feature(feature: &[u16]) -> u32 {
    let mut hash: i32 = 0x811c_9dc5_u32 as i32;
    for unit in feature {
        hash ^= i32::from(*unit);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash as u32
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn vector_features(value: &str) -> Vec<(Vec<u16>, f64)> {
    let normalized = normalize_for_search(value);
    let tokens = tokenize_for_search(&normalized, false);
    let mut features = Vec::new();
    for token in &tokens {
        features.push((units(&format!("w:{}", token.stem)), 2.5));
        let padded = units(&format!("^{}$", token.stem));
        for size in 3..=4usize {
            if padded.len() < size {
                continue;
            }
            for index in 0..=padded.len() - size {
                let mut feature = units(&format!("c{size}:"));
                feature.extend_from_slice(&padded[index..index + size]);
                features.push((feature, 0.55));
            }
        }
    }
    for pair in tokens.windows(2) {
        features.push((units(&format!("b:{}_{}", pair[0].stem, pair[1].stem)), 1.4));
    }
    features
}

/// `deterministicLocalVector(value, dimensions)`: нормированный вектор
/// хешированных признаков (слова, 3- и 4-граммы, пары слов).
pub fn deterministic_local_vector(value: &str, dimensions: Option<usize>) -> Result<Vec<f64>> {
    let dimensions = dimensions.unwrap_or(DEFAULT_VECTOR_DIMENSIONS);
    if dimensions < 32 {
        return Err(RetrieverError::Type("dimensions must be an integer >= 32".into()));
    }
    Ok(local_vector(value, dimensions))
}

fn local_vector(value: &str, dimensions: usize) -> Vec<f64> {
    let mut vector = vec![0.0_f64; dimensions];
    for (feature, weight) in vector_features(value) {
        let hash = hash_feature(&feature);
        let position = hash as usize % dimensions;
        let sign = if hash & 0x8000_0000 == 0 { 1.0 } else { -1.0 };
        vector[position] += sign * weight;
    }
    let mut magnitude = 0.0;
    for component in &vector {
        magnitude += component * component;
    }
    magnitude = magnitude.sqrt();
    if magnitude > 0.0 {
        for component in &mut vector {
            *component /= magnitude;
        }
    }
    vector
}

fn cosine_similarity(left: &[f64], right: &[f64]) -> f64 {
    let mut result = 0.0;
    for (a, b) in left.iter().zip(right) {
        result += a * b;
    }
    result.min(1.0).max(0.0)
}

fn add_weighted_tokens(weights: &mut IndexMap<String, f64>, value: &str, weight: f64) {
    for token in tokenize_for_search(value, false) {
        let current = weights.get(&token.stem).copied().unwrap_or(0.0);
        weights.insert(token.stem, current.max(weight));
    }
}

/// `uniqueStrings(values)`: непустые строки без повторов, обрезанные.
fn unique_strings<'a>(values: impl IntoIterator<Item = &'a Value>) -> Vec<String> {
    let mut seen = IndexSet::new();
    for value in values {
        if let Some(text) = jsv::non_empty_string(Some(value)) {
            seen.insert(text::trim(text).to_string());
        }
    }
    seen.into_iter().collect()
}

fn unique_texts(values: &[String]) -> Vec<String> {
    let values: Vec<Value> = values.iter().map(|value| Value::String(value.clone())).collect();
    unique_strings(&values)
}

fn strings_in(value: Option<&Value>) -> Vec<&Value> {
    value.and_then(Value::as_array).map(|items| items.iter().collect()).unwrap_or_default()
}

fn joined(value: Option<&Value>) -> String {
    strings_in(value).into_iter().map(|item| jsv::string_of(Some(item))).collect::<Vec<_>>().join(" ")
}

#[derive(Debug, Clone)]
struct Phrase {
    original: String,
    normalized: String,
    stems: Vec<String>,
    source_weight: f64,
}

#[derive(Debug, Clone)]
struct Document {
    id: String,
    ruleset_id: String,
    pack_id: String,
    rule: Value,
    weights: IndexMap<String, f64>,
    phrases: Vec<Phrase>,
    vector: Vec<f64>,
}

fn build_document(pack: &Value, rule: &Value) -> Document {
    let entity_refs = strings_in(rule.get("entity_refs"));
    let glossary_entries: Vec<&Value> = strings_in(pack.get("glossary"))
        .into_iter()
        .filter(|entry| entity_refs.iter().any(|reference| matches!((reference, entry.get("canonical_id")), (Value::String(a), Some(Value::String(b))) if a == b)))
        .collect();
    let glossary_phrases: Vec<&Value> = glossary_entries
        .iter()
        .flat_map(|entry| {
            let mut phrases: Vec<&Value> = Vec::new();
            phrases.extend(entry.get("term_en"));
            phrases.extend(entry.get("term_ru"));
            phrases.extend(strings_in(entry.get("aliases_ru")));
            phrases
        })
        .collect();
    let direct_aliases = unique_strings(strings_in(rule.get("aliases_en")).into_iter().chain(strings_in(rule.get("aliases_ru"))));
    let mut alias_sources: Vec<Value> = direct_aliases.iter().map(|alias| Value::String(alias.clone())).collect();
    alias_sources.extend(glossary_phrases.iter().map(|phrase| (*phrase).clone()));
    let aliases = unique_strings(&alias_sources);
    let titles = unique_strings(rule.get("title_en").into_iter().chain(rule.get("title_ru")));
    let mut weights = IndexMap::new();
    for title in &titles {
        add_weighted_tokens(&mut weights, title, 5.0);
    }
    for alias in &direct_aliases {
        add_weighted_tokens(&mut weights, alias, 6.0);
    }
    for phrase in &glossary_phrases {
        add_weighted_tokens(&mut weights, &js::s(Some(phrase)), 4.5);
    }
    add_weighted_tokens(&mut weights, &joined(rule.get("tags")), 3.5);
    add_weighted_tokens(&mut weights, &joined(rule.get("section_path")), 2.5);
    add_weighted_tokens(&mut weights, &format!("{} {}", jsv::string_of(rule.get("text_en")), jsv::string_of(rule.get("text_ru"))), 1.5);
    let direct_phrase_set: HashSet<String> = titles.iter().chain(&direct_aliases).map(|phrase| normalize_for_search(phrase)).collect();
    let phrase_sources: Vec<String> = titles.iter().chain(&aliases).cloned().collect();
    let phrases = unique_texts(&phrase_sources)
        .into_iter()
        .map(|phrase| {
            let normalized = normalize_for_search(&phrase);
            let source_weight = if direct_phrase_set.contains(&normalized) { 1.0 } else { 0.72 };
            Phrase {
                stems: tokenize_for_search(&phrase, false).into_iter().map(|token| token.stem).collect(),
                original: phrase,
                normalized,
                source_weight,
            }
        })
        .filter(|phrase| !phrase.normalized.is_empty())
        .collect();
    let mut vector_parts: Vec<String> = Vec::new();
    vector_parts.extend(titles.iter().cloned());
    vector_parts.extend(titles.iter().cloned());
    for _ in 0..3 {
        vector_parts.extend(aliases.iter().cloned());
    }
    vector_parts.push(joined(rule.get("tags")));
    vector_parts.push(jsv::string_of(rule.get("text_en")));
    vector_parts.push(jsv::string_of(rule.get("text_ru")));
    Document {
        id: jsv::string_of(rule.get("id")),
        ruleset_id: jsv::string_of(rule.get("ruleset_id")),
        pack_id: jsv::string_of(pack.get("manifest").and_then(|manifest| manifest.get("pack_id"))),
        rule: rule.clone(),
        weights,
        phrases,
        vector: local_vector(&vector_parts.join(" "), DEFAULT_VECTOR_DIMENSIONS),
    }
}

fn build_inverse_document_frequency(documents: &[Document]) -> HashMap<String, f64> {
    let mut frequencies: IndexMap<&str, usize> = IndexMap::new();
    for document in documents {
        for stem in document.weights.keys() {
            *frequencies.entry(stem.as_str()).or_insert(0) += 1;
        }
    }
    frequencies
        .into_iter()
        .map(|(stem, frequency)| (stem.to_string(), fdlibm_log((documents.len() as f64 + 1.0) / (frequency as f64 + 1.0)) + 1.0))
        .collect()
}

fn fuzzy_threshold(token: &str) -> usize {
    let length = utf16_len(token);
    if length >= 9 {
        2
    } else if length >= 5 {
        1
    } else {
        0
    }
}

struct LexicalScore {
    score: f64,
    matched: Vec<String>,
}

fn lexical_score(document: &Document, query_tokens: &[SearchToken], idf: &HashMap<String, f64>) -> LexicalScore {
    if query_tokens.is_empty() {
        return LexicalScore { score: 0.0, matched: Vec::new() };
    }
    let idf_of = |stem: &str| idf.get(stem).copied().filter(|value| *value != 0.0 && !value.is_nan()).unwrap_or(1.0);
    let mut total = 0.0;
    let mut matched = Vec::new();
    let unique_query_tokens: IndexSet<&str> = query_tokens.iter().map(|token| token.stem.as_str()).collect();
    for query_stem in &unique_query_tokens {
        if let Some(exact_weight) = document.weights.get(*query_stem).copied().filter(|weight| *weight != 0.0) {
            total += exact_weight * idf_of(query_stem);
            matched.push((*query_stem).to_string());
            continue;
        }
        let threshold = fuzzy_threshold(query_stem);
        if threshold == 0 {
            continue;
        }
        let query_length = utf16_len(query_stem);
        let mut best: Option<(&str, usize, f64)> = None;
        for (document_stem, weight) in &document.weights {
            if utf16_len(document_stem).abs_diff(query_length) > threshold {
                continue;
            }
            let distance = levenshtein_distance(query_stem, document_stem, Some(threshold));
            let better = match best {
                None => true,
                Some((_, best_distance, best_weight)) => distance < best_distance || (distance == best_distance && *weight > best_weight),
            };
            if distance <= threshold && better {
                best = Some((document_stem, distance, *weight));
            }
        }
        if let Some((document_stem, distance, weight)) = best {
            let fuzzy_factor = if distance == 1 { 0.68 } else { 0.42 };
            total += weight * idf_of(document_stem) * fuzzy_factor;
            matched.push(format!("{query_stem}~{document_stem}"));
        }
    }
    let maximum = (unique_query_tokens.len() as f64 * 7.0).max(1.0);
    LexicalScore { score: (total / maximum).min(1.0), matched }
}

struct PhraseScore {
    score: f64,
    matched_aliases: Vec<String>,
}

fn phrase_score(document: &Document, normalized_queries: &[String], query_stem_set: &IndexSet<String>) -> PhraseScore {
    let mut best: f64 = 0.0;
    let mut matched_aliases = Vec::new();
    for phrase in &document.phrases {
        if utf16_len(&phrase.normalized) < 2 {
            continue;
        }
        if normalized_queries.iter().any(|query| query.contains(&phrase.normalized)) {
            best = best.max(if phrase.stems.len() > 1 { 1.0 } else { 0.9 } * phrase.source_weight);
            matched_aliases.push(phrase.original.clone());
            continue;
        }
        if !phrase.stems.is_empty() && phrase.stems.iter().all(|stem| query_stem_set.contains(stem)) {
            best = best.max(if phrase.stems.len() > 1 { 0.8 } else { 0.9 } * phrase.source_weight);
            matched_aliases.push(phrase.original.clone());
            continue;
        }
        if phrase.stems.len() == 1 {
            let phrase_stem = &phrase.stems[0];
            let threshold = fuzzy_threshold(phrase_stem);
            if threshold > 0 && query_stem_set.iter().any(|query_stem| levenshtein_distance(query_stem, phrase_stem, Some(threshold)) <= threshold) {
                best = best.max(0.9 * phrase.source_weight);
                matched_aliases.push(format!("{} (fuzzy)", phrase.original));
            }
        }
    }
    PhraseScore { score: best, matched_aliases: unique_texts(&matched_aliases) }
}

/// `roundScore(value)`: `Number(Math.max(0, value).toFixed(6))`.
fn round_score(value: f64) -> f64 {
    js::parse_number(&js::to_fixed(value.max(0.0), 6))
}

#[derive(Debug, Clone)]
struct Neighbor {
    id: String,
    relation: Value,
    weight: f64,
}

type Graph = HashMap<String, HashMap<String, Vec<Neighbor>>>;

fn build_graph(packs: &[Value]) -> Graph {
    let mut graph: Graph = HashMap::new();
    let mut add = |ruleset_id: String, from: String, to: String, edge: &Value| {
        graph.entry(ruleset_id).or_default().entry(from).or_default().push(Neighbor {
            id: to,
            relation: edge.get("relation").cloned().unwrap_or(Value::Null),
            weight: js::number(edge.get("weight")),
        });
    };
    for pack in packs {
        for edge in strings_in(pack.get("ontologyEdges")) {
            let ruleset_id = jsv::string_of(edge.get("ruleset_id"));
            let from = jsv::string_of(edge.get("from_id"));
            let to = jsv::string_of(edge.get("to_id"));
            add(ruleset_id.clone(), from.clone(), to.clone(), edge);
            if js::truthy(edge.get("bidirectional")) {
                add(ruleset_id, to, from, edge);
            }
        }
    }
    graph
}

/// `RuleRetriever`: индекс по пакетам правил, разведённый по `ruleset_id`.
#[derive(Debug, Clone)]
pub struct RuleRetriever {
    packs: Vec<Value>,
    pack_rulesets: IndexMap<String, String>,
    documents_by_ruleset: IndexMap<String, Vec<Document>>,
    idf_by_ruleset: HashMap<String, HashMap<String, f64>>,
    graph_by_ruleset: Graph,
}

struct Scored {
    document: usize,
    direct_score: f64,
    lexical: f64,
    vector: f64,
    alias: f64,
    ontology: f64,
    matched_terms: Vec<String>,
    matched_aliases: Vec<String>,
    ontology_reasons: Vec<Value>,
}

impl RuleRetriever {
    /// `new RuleRetriever(rulePacks)`.
    pub fn new(packs: &[Value]) -> Result<Self> {
        Self::with_vector_dimensions(packs, DEFAULT_VECTOR_DIMENSIONS)
    }

    /// `new RuleRetriever(rulePacks, { vectorDimensions })`: индекс держит
    /// только 384 измерения, иное — отказ.
    pub fn with_vector_dimensions(packs: &[Value], vector_dimensions: usize) -> Result<Self> {
        if vector_dimensions != DEFAULT_VECTOR_DIMENSIONS {
            return Err(RetrieverError::Type(format!("This retriever index uses fixed {DEFAULT_VECTOR_DIMENSIONS}-dimension local vectors")));
        }
        if packs.is_empty() || packs.iter().any(|pack| !js::truthy(Some(pack))) {
            return Err(RetrieverError::Type("RuleRetriever needs at least one rule pack".into()));
        }
        let mut pack_rulesets = IndexMap::new();
        let mut documents_by_ruleset: IndexMap<String, Vec<Document>> = IndexMap::new();
        for pack in packs {
            let expected = pack.get("manifest").and_then(|manifest| manifest.get("ruleset_id")).and_then(Value::as_str);
            validate_rule_pack(pack, expected)?;
            let manifest = &pack["manifest"];
            let pack_id = jsv::string_of(manifest.get("pack_id"));
            let ruleset_id = jsv::string_of(manifest.get("ruleset_id"));
            if pack_rulesets.contains_key(&pack_id) {
                return Err(RetrieverError::Type(format!("Duplicate pack_id {pack_id}")));
            }
            pack_rulesets.insert(pack_id, ruleset_id.clone());
            let documents = documents_by_ruleset.entry(ruleset_id).or_default();
            documents.extend(strings_in(pack.get("rules")).into_iter().map(|rule| build_document(pack, rule)));
        }
        let idf_by_ruleset = documents_by_ruleset.iter().map(|(ruleset_id, documents)| (ruleset_id.clone(), build_inverse_document_frequency(documents))).collect();
        Ok(Self { packs: packs.to_vec(), pack_rulesets, documents_by_ruleset, idf_by_ruleset, graph_by_ruleset: build_graph(packs) })
    }

    /// Пакеты, по которым построен индекс (`retriever.packs`).
    pub fn packs(&self) -> &[Value] {
        &self.packs
    }

    /// `retriever.search(input)`: вход — объект JS (`queries`/`query`,
    /// `ruleset_id`/`rulesetId`, `enabled_packs`/`enabledPacks`,
    /// `entity_types`/`entityTypes`, `limit`), выход — та же форма ответа.
    pub fn search(&self, input: &Value) -> Result<Value> {
        let field = |key: &str| jsv::member(Some(input), key);
        let queries_input = nullish(field("queries"), field("query"));
        let raw_queries: Vec<&Value> = match queries_input {
            Some(Value::Array(items)) => items.iter().collect(),
            Some(other) => vec![other],
            None => vec![],
        };
        let queries: Vec<String> = raw_queries.into_iter().filter_map(|query| jsv::non_empty_string(Some(query))).map(|query| text::trim(query).to_string()).collect();
        if queries.is_empty() {
            return Err(RetrieverError::Type("queries must contain at least one non-empty string".into()));
        }

        let ruleset_id = match nullish(field("rulesetId"), field("ruleset_id")) {
            Some(Value::String(id)) if !id.is_empty() => id.clone(),
            _ => return Err(RetrieverError::Type("ruleset_id is required".into())),
        };
        let Some(all_documents) = self.documents_by_ruleset.get(&ruleset_id) else {
            return Err(RetrieverError::Range(format!("Unknown ruleset_id {ruleset_id}")));
        };

        let requested_packs = nullish(field("enabledPacks"), field("enabled_packs"));
        let enabled_packs: Vec<String> = match requested_packs {
            None => self.pack_rulesets.iter().filter(|(_, pack_ruleset)| **pack_ruleset == ruleset_id).map(|(pack_id, _)| pack_id.clone()).collect(),
            Some(Value::Array(items)) if !items.is_empty() && items.iter().all(Value::is_string) => items.iter().map(|item| jsv::string_of(Some(item))).collect(),
            Some(_) => return Err(RetrieverError::Type("enabled_packs must be a non-empty array of pack ids".into())),
        };
        if enabled_packs.is_empty() {
            return Err(RetrieverError::Type("enabled_packs must be a non-empty array of pack ids".into()));
        }
        for pack_id in &enabled_packs {
            let Some(pack_ruleset) = self.pack_rulesets.get(pack_id) else {
                return Err(RetrieverError::Range(format!("Unknown enabled pack {pack_id}")));
            };
            if *pack_ruleset != ruleset_id {
                return Err(RetrieverError::Range(format!("Enabled pack {pack_id} belongs to {pack_ruleset}, not requested {ruleset_id}")));
            }
        }

        let enabled_set: IndexSet<String> = enabled_packs.into_iter().collect();
        let entity_types: Option<&Vec<Value>> = match nullish(field("entityTypes"), field("entity_types")) {
            None | Some(Value::Null) => None,
            Some(Value::Array(items)) => Some(items),
            Some(_) => return Err(RetrieverError::Type("entity_types must be an array when provided".into())),
        };
        let has_type = |value: Option<&Value>| match (entity_types, value) {
            (Some(types), Some(Value::String(name))) => types.iter().any(|item| item.as_str() == Some(name)),
            _ => false,
        };
        let documents: Vec<usize> = all_documents
            .iter()
            .enumerate()
            .filter(|(_, document)| {
                if document.ruleset_id != ruleset_id || !enabled_set.contains(&document.pack_id) {
                    return false;
                }
                if entity_types.is_none() {
                    return true;
                }
                has_type(document.rule.get("kind")) || strings_in(document.rule.get("tags")).into_iter().any(|tag| has_type(Some(tag)))
            })
            .map(|(index, _)| index)
            .collect();
        let enabled_json: Vec<Value> = enabled_set.iter().map(|pack_id| Value::String(pack_id.clone())).collect();
        if documents.is_empty() {
            return Ok(json!({ "ruleset_id": ruleset_id, "queries": queries, "enabled_packs": enabled_json, "count": 0, "confidence": 0, "results": [] }));
        }

        let normalized_queries: Vec<String> = queries.iter().map(|query| normalize_for_search(query)).collect();
        let query_text = normalized_queries.join(" ");
        let query_tokens = tokenize_for_search(&query_text, false);
        let query_stem_set: IndexSet<String> = query_tokens.iter().map(|token| token.stem.clone()).collect();
        let query_vector = local_vector(&query_text, DEFAULT_VECTOR_DIMENSIONS);
        let empty_idf = HashMap::new();
        let idf = self.idf_by_ruleset.get(&ruleset_id).unwrap_or(&empty_idf);
        let mut scored: IndexMap<String, Scored> = IndexMap::new();
        for index in documents {
            let document = &all_documents[index];
            let lexical = lexical_score(document, &query_tokens, idf);
            let phrase = phrase_score(document, &normalized_queries, &query_stem_set);
            let vector = cosine_similarity(&query_vector, &document.vector);
            let direct_score = 0.57 * lexical.score + 0.25 * vector + 0.18 * phrase.score;
            scored.insert(
                document.id.clone(),
                Scored {
                    document: index,
                    direct_score,
                    lexical: lexical.score,
                    vector,
                    alias: phrase.score,
                    ontology: 0.0,
                    matched_terms: lexical.matched,
                    matched_aliases: phrase.matched_aliases,
                    ontology_reasons: Vec::new(),
                },
            );
        }

        let document_id = |entry: &Scored| all_documents[entry.document].id.as_str();
        let mut seeds: Vec<(String, f64)> = scored.values().filter(|entry| entry.direct_score >= 0.04).map(|entry| (document_id(entry).to_string(), entry.direct_score)).collect();
        seeds.sort_by(|left, right| right.1.partial_cmp(&left.1).unwrap_or(std::cmp::Ordering::Equal).then_with(|| text::locale_compare(&left.0, &right.0)));
        seeds.truncate(2);
        let empty_graph = HashMap::new();
        let graph = self.graph_by_ruleset.get(&ruleset_id).unwrap_or(&empty_graph);
        for (seed_id, seed_score) in &seeds {
            for neighbor in graph.get(seed_id).map(Vec::as_slice).unwrap_or(&[]) {
                let Some(target) = scored.get_mut(&neighbor.id) else {
                    continue;
                };
                if all_documents[target.document].ruleset_id != ruleset_id {
                    continue;
                }
                let contribution = seed_score * neighbor.weight * 0.12;
                target.ontology = (target.ontology + contribution).min(0.18);
                target.ontology_reasons.push(json!({ "from_rule_id": seed_id, "relation": neighbor.relation, "contribution": js::num(round_score(contribution)) }));
            }
        }

        let limit_value = field("limit");
        let limit = if jsv::is_integer(limit_value) { js::number(limit_value) } else { 10.0 };
        let limit = MAX_LIMIT.min(limit.max(1.0)) as usize;
        let mut ranked: Vec<(&Scored, f64)> = scored.values().map(|entry| (entry, entry.direct_score + entry.ontology)).filter(|(_, score)| *score >= 0.035).collect();
        ranked.sort_by(|left, right| {
            right
                .1
                .partial_cmp(&left.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| right.0.direct_score.partial_cmp(&left.0.direct_score).unwrap_or(std::cmp::Ordering::Equal))
                .then_with(|| text::locale_compare(document_id(left.0), document_id(right.0)))
        });
        ranked.truncate(limit);
        let results: Vec<(f64, Value)> = ranked
            .into_iter()
            .map(|(entry, score)| {
                let document = &all_documents[entry.document];
                let rule = &document.rule;
                let rounded = round_score(score);
                let mut matched_by = Vec::new();
                for (value, label) in [(entry.lexical, "lexical"), (entry.vector, "vector"), (entry.alias, "aliases"), (entry.ontology, "ontology")] {
                    if value > 0.0 {
                        matched_by.push(label);
                    }
                }
                // Поле правила, которого нет, в JS — `undefined` и в JSON не попадает.
                let mut result = Map::new();
                for (key, source) in [("rule_id", "id"), ("ruleset_id", "ruleset_id"), ("pack_id", ""), ("title_en", "title_en"), ("title_ru", "title_ru"), ("text_en", "text_en"), ("text_ru", "text_ru"), ("formalization_level", "formalization_level"), ("source_page", "source_page_start")] {
                    if source.is_empty() {
                        result.insert(key.into(), Value::String(document.pack_id.clone()));
                    } else if let Some(value) = rule.get(source) {
                        result.insert(key.into(), value.clone());
                    }
                }
                result.insert("score".into(), js::num(rounded));
                result.insert("matched_by".into(), json!(matched_by));
                result.insert(
                    "score_breakdown".into(),
                    json!({
                        "lexical": js::num(round_score(entry.lexical)),
                        "local_vector": js::num(round_score(entry.vector)),
                        "aliases": js::num(round_score(entry.alias)),
                        "ontology": js::num(round_score(entry.ontology)),
                    }),
                );
                result.insert("matched_terms".into(), json!(unique_texts(&entry.matched_terms)));
                result.insert("matched_aliases".into(), json!(entry.matched_aliases));
                result.insert("ontology_reasons".into(), Value::Array(entry.ontology_reasons.clone()));
                result.insert("rule".into(), rule.clone());
                (rounded, Value::Object(result))
            })
            .collect();
        let confidence = results.first().map_or(0.0, |(score, _)| round_score(score.min(1.0)));
        Ok(json!({
            "ruleset_id": ruleset_id,
            "queries": queries,
            "enabled_packs": enabled_json,
            "count": results.len(),
            "confidence": js::num(confidence),
            "results": results.into_iter().map(|(_, result)| result).collect::<Vec<_>>(),
        }))
    }
}

/// `createRuleRetriever(rulePacks, options)`.
pub fn create_rule_retriever(packs: &[Value]) -> Result<RuleRetriever> {
    RuleRetriever::new(packs)
}

/// Натуральный логарифм по `fdlibm` (`__ieee754_log`), как `Math.log` в V8.
fn fdlibm_log(x: f64) -> f64 {
    const LN2_HI: f64 = 6.931_471_803_691_238_164_90e-01;
    const LN2_LO: f64 = 1.908_214_929_270_587_700_02e-10;
    const TWO54: f64 = 1.801_439_850_948_198_400_00e+16;
    const LG1: f64 = 6.666_666_666_666_735_130e-01;
    const LG2: f64 = 3.999_999_999_940_941_908e-01;
    const LG3: f64 = 2.857_142_874_366_239_149e-01;
    const LG4: f64 = 2.222_219_843_214_978_396e-01;
    const LG5: f64 = 1.818_357_216_161_805_012e-01;
    const LG6: f64 = 1.531_383_769_920_937_332e-01;
    const LG7: f64 = 1.479_819_860_511_658_591e-01;

    let bits = x.to_bits();
    let mut hx = (bits >> 32) as i32;
    let lx = bits as u32;
    let mut x = x;
    let mut k: i32 = 0;
    if hx < 0x0010_0000 {
        if ((hx & 0x7fff_ffff) as u32 | lx) == 0 {
            return f64::NEG_INFINITY;
        }
        if hx < 0 {
            return f64::NAN;
        }
        k -= 54;
        x *= TWO54;
        hx = (x.to_bits() >> 32) as i32;
    }
    if hx >= 0x7ff0_0000 {
        return x + x;
    }
    k += (hx >> 20) - 1023;
    hx &= 0x000f_ffff;
    let i = (hx + 0x95f64) & 0x10_0000;
    let high = (hx | (i ^ 0x3ff0_0000)) as u32;
    x = f64::from_bits((u64::from(high) << 32) | (x.to_bits() & 0xffff_ffff));
    k += i >> 20;
    let f = x - 1.0;
    if (0x000f_ffff & (2 + hx)) < 3 {
        if f == 0.0 {
            if k == 0 {
                return 0.0;
            }
            let dk = f64::from(k);
            return dk * LN2_HI + dk * LN2_LO;
        }
        let r = f * f * (0.5 - 0.333_333_333_333_333_33 * f);
        if k == 0 {
            return f - r;
        }
        let dk = f64::from(k);
        return dk * LN2_HI - ((r - dk * LN2_LO) - f);
    }
    let s = f / (2.0 + f);
    let dk = f64::from(k);
    let z = s * s;
    let mut i = hx - 0x6147a;
    let w = z * z;
    let j = 0x6b851 - hx;
    let t1 = w * (LG2 + w * (LG4 + w * LG6));
    let t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
    i |= j;
    let r = t2 + t1;
    if i > 0 {
        let hfsq = 0.5 * f * f;
        if k == 0 {
            return f - (hfsq - s * (hfsq + r));
        }
        dk * LN2_HI - ((hfsq - (s * (hfsq + r) + dk * LN2_LO)) - f)
    } else {
        if k == 0 {
            return f - s * (f - r);
        }
        dk * LN2_HI - ((s * (f - r) - dk * LN2_LO) - f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_and_stems_follow_js() {
        assert_eq!(normalize_for_search("  ПОМЕХОЙ, Reaction!  "), "помехой reaction");
        let stems: Vec<String> = tokenize_for_search("с помехой и помеха reaction reactions", false).into_iter().map(|token| token.stem).collect();
        assert_eq!(stems, ["помех", "помех", "reaction", "reaction"]);
        assert_eq!(stem_search_token("abilities"), "ability");
        assert_eq!(stem_search_token("два слова"), "два слова");
    }

    #[test]
    fn levenshtein_respects_maximum() {
        assert_eq!(levenshtein_distance("kitten", "sitting", None), 3);
        assert_eq!(levenshtein_distance("kitten", "sitting", Some(1)), 2);
        assert_eq!(levenshtein_distance("", "abc", None), 3);
        assert_eq!(levenshtein_distance("помеха", "помехха", Some(1)), 1);
        assert_eq!(levenshtein_distance("ab", "abcdef", Some(2)), 3);
    }

    #[test]
    fn local_vectors_are_unit_and_deterministic() {
        let first = deterministic_local_vector("проверка concentration", None).expect("вектор");
        let second = deterministic_local_vector("проверка concentration", None).expect("вектор");
        let different = deterministic_local_vector("урон damage", None).expect("вектор");
        assert_eq!(first, second);
        assert_ne!(first, different);
        let magnitude: f64 = first.iter().map(|value| value * value).sum::<f64>().sqrt();
        assert!((magnitude - 1.0).abs() < 1e-12);
        assert_eq!(deterministic_local_vector("x", Some(31)), Err(RetrieverError::Type("dimensions must be an integer >= 32".into())));
    }

    #[test]
    fn fdlibm_log_matches_known_values() {
        assert_eq!(fdlibm_log(1.0), 0.0);
        assert_eq!(fdlibm_log(std::f64::consts::E), 1.0);
        assert_eq!(fdlibm_log(2.0), std::f64::consts::LN_2);
        assert_eq!(fdlibm_log(0.0), f64::NEG_INFINITY);
        assert!(fdlibm_log(-1.0).is_nan());
        assert_eq!(fdlibm_log(5e-324), -744.4400719213812);
    }
}

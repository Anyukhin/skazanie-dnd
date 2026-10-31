//! Перенос `server/dndsu-2014-content.mjs`: локальный справочник D&D 2014
//! (бестиарий, магические предметы, правила dnd.su) — только чтение и
//! проверка, без сети, команд и исполнения механики.
//!
//! Каталог `data/compendia/dnd_5e_2014/` встроен в сборку (`include_bytes!`):
//! [`load_dndsu_2014_content`] без каталога читает встроенные байты и так же
//! сверяет их SHA-256 с манифестом. С каталогом — читает файлы с диска, как
//! JS (`loadDndsu2014Content({ directory })`). Справочник — JSON той же формы,
//! что объект JS (`manifest`, `monsters`, `magicItems`, `sources`, `coverage`,
//! `rules`, `ontologyEdges`, `summary`); заморозка (`Object.freeze`) в Rust не
//! нужна.
//!
//! Ошибки: [`ContentError::Validation`] — `ContentValidationError` JS;
//! [`ContentError::Type`] — `TypeError`, которым JS падает на чтении поля у
//! `undefined`/`null`; [`ContentError::Io`] — ошибка чтения, которую JS
//! пропускает без обёртки. Тексты разбора JSON — от `serde_json`.

use std::fmt;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use sk_core::{hash, js, re, text};

use crate::jsv::{self, is_js_whitespace, strict_eq, string_of, stringify, stringify_pretty, ws};

/// `CONTENT_RULESET_ID`.
pub const CONTENT_RULESET_ID: &str = "dnd_5e_2014";
/// `DEFAULT_CONTENT_DIRECTORY` относительно корня проекта.
pub const DEFAULT_CONTENT_DIRECTORY: &str = "data/compendia/dnd_5e_2014";

const ABILITIES: [&str; 6] = ["str", "dex", "con", "int", "wis", "cha"];
const DAMAGE_TYPES: [&str; 13] = ["acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic", "piercing", "poison", "psychic", "radiant", "slashing", "thunder"];
const BOOKS: [&str; 4] = ["PHB14", "DMG14", "MM14", "SRD51"];
const RECORD_KINDS: [&str; 3] = ["monster", "magic_item", "rule"];
const APPROVED_HOSTS: [&str; 5] = ["dnd.su", "www.dnd.su", "5e14.dnd.su", "www.5e14.dnd.su", "media.dndbeyond.com"];

macro_rules! embedded {
    ($($name:literal),* $(,)?) => {
        &[$(($name, include_bytes!(concat!("../../../../data/compendia/dnd_5e_2014/", $name)) as &[u8])),*]
    };
}

/// Встроенный каталог: имя файла относительно каталога справочника → байты.
static EMBEDDED_FILES: &[(&str, &[u8])] = embedded!(
    "manifest.json",
    "coverage.json",
    "magic-items.json",
    "monsters.json",
    "sources.json",
    "rule_packs/dnd_5e_2014/coverage.yaml",
    "rule_packs/dnd_5e_2014/glossary.csv",
    "rule_packs/dnd_5e_2014/manifest.yaml",
    "rule_packs/dnd_5e_2014/ontology_edges.jsonl",
    "rule_packs/dnd_5e_2014/rules.jsonl",
    "rule_packs/dnd_5e_2014/sources.json",
    "schemas/magic-item.schema.json",
    "schemas/monster.schema.json",
    "schemas/rule.schema.json",
);

/// Отказ справочника.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContentError {
    /// `ContentValidationError`.
    Validation(String),
    /// `TypeError` JS (чтение поля у `undefined`/`null`, обход не-массива).
    Type(String),
    /// Ошибка чтения файла, которую JS не оборачивает.
    Io(String),
}

impl ContentError {
    pub fn message(&self) -> &str {
        match self {
            Self::Validation(message) | Self::Type(message) | Self::Io(message) => message,
        }
    }

    /// Это `ContentValidationError`.
    pub fn is_validation(&self) -> bool {
        matches!(self, Self::Validation(_))
    }
}

impl fmt::Display for ContentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for ContentError {}

type R<T> = Result<T, ContentError>;

fn require_that(condition: bool, message: impl Into<String>) -> R<()> {
    if condition {
        Ok(())
    } else {
        Err(ContentError::Validation(message.into()))
    }
}

/// `value.key`: у `undefined` и `null` JS падает `TypeError`.
fn prop<'a>(value: Option<&'a Value>, key: &str) -> R<Option<&'a Value>> {
    match value {
        None => Err(ContentError::Type(format!("Cannot read properties of undefined (reading '{key}')"))),
        Some(Value::Null) => Err(ContentError::Type(format!("Cannot read properties of null (reading '{key}')"))),
        other => Ok(jsv::member(other, key)),
    }
}

/// `value?.key`.
fn opt<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    jsv::member(value, key)
}

/// Элементы для `for…of`: массив или символы строки; прочее — `TypeError`.
fn iterate(value: Option<&Value>, label: &str) -> R<Vec<Value>> {
    match value {
        Some(Value::Array(items)) => Ok(items.clone()),
        Some(Value::String(text)) => Ok(text.chars().map(|ch| Value::String(ch.to_string())).collect()),
        _ => Err(ContentError::Type(format!("{label} is not iterable"))),
    }
}

fn object(value: Option<&Value>, label: &str) -> R<()> {
    require_that(matches!(value, Some(Value::Object(_))), format!("{label}: expected object"))
}

fn string(value: Option<&Value>, label: &str) -> R<()> {
    require_that(jsv::non_empty_string(value).is_some(), format!("{label}: expected nonempty string"))
}

fn integer(value: Option<&Value>, min: f64, max: f64, label: &str) -> R<()> {
    let ok = jsv::is_integer(value) && js::number(value) >= min && js::number(value) <= max;
    require_that(ok, format!("{label}: integer outside {}..{}", js::f64_string(min), js::f64_string(max)))
}

fn array(value: Option<&Value>, label: &str) -> R<()> {
    require_that(matches!(value, Some(Value::Array(_))), format!("{label}: expected array"))
}

fn strings(value: Option<&Value>, label: &str) -> R<()> {
    array(value, label)?;
    for item in value.and_then(Value::as_array).into_iter().flatten() {
        string(Some(item), label)?;
    }
    Ok(())
}

fn items(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// Ключ `Set` JS для значения JSON: примитив по значению, объект — по адресу.
fn set_key(value: Option<&Value>) -> String {
    match value {
        None => "u".into(),
        Some(Value::Null) => "n".into(),
        Some(Value::Bool(flag)) => format!("b:{flag}"),
        Some(Value::Number(number)) => format!("#:{}", js::f64_string(number.as_f64().unwrap_or(f64::NAN))),
        Some(Value::String(text)) => format!("s:{text}"),
        Some(other) => format!("o:{:p}", other as *const Value),
    }
}

fn json_lines(source: &str, filename: &str) -> R<Vec<Value>> {
    jsv::split_lines(source)
        .into_iter()
        .filter(|line| !text::trim(line).is_empty())
        .enumerate()
        .map(|(index, line)| serde_json::from_str::<Value>(line).map_err(|error| ContentError::Validation(format!("{filename}:{}: {error}", index + 1))))
        .collect()
}

/// `mechanicalTokens(text)`: кости, модификаторы, дроби, проценты и
/// множители, отсортированные как `sort()` без сравнителя.
pub fn mechanical_tokens(source: &str) -> Vec<String> {
    let normalized = text::lower(&text::nfkc(source));
    let normalized = text::replace_all(re!(r"[−–]", "gu"), &normalized, "-");
    let normalized = text::replace_all(re!(r"(\d),(\d)", "gu"), &normalized, "${1}.${2}");
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
    let space = re!(concat!(ws!(), "+"), "gu");
    let mut tokens: Vec<String> = text::find_all(pattern, &normalized).into_iter().map(|token| text::replace_all(space, &token, "").replace('×', "x")).collect();
    tokens.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    tokens
}

/// `diceAverage(expression)`: проверка `NdS±M` без `eval` и среднее с
/// округлением вниз.
pub fn dice_average(expression: Option<&Value>) -> R<i64> {
    string(expression, "dice expression")?;
    let source = string_of(expression);
    let captures = re!(r"^(\d+)d(\d+)([+-]\d+)?$", "u").captures(&source).ok().flatten();
    let Some(captures) = captures else {
        return Err(ContentError::Validation(format!("Invalid dice expression: {source}")));
    };
    let part = |index: usize| captures.get(index).map(|m| m.as_str().to_string());
    let count = js::parse_number(&part(1).unwrap_or_default());
    let sides = js::parse_number(&part(2).unwrap_or_default());
    let modifier = part(3).map_or(0.0, |modifier| js::parse_number(&modifier));
    integer(Some(&js::num(count)), 1.0, 1000.0, "dice count")?;
    integer(Some(&js::num(sides)), 2.0, 1000.0, "dice sides")?;
    integer(Some(&js::num(modifier)), -10000.0, 10000.0, "dice modifier")?;
    Ok((count * (sides + 1.0) / 2.0 + modifier).floor() as i64)
}

/// Части адреса, которые проверяет `sourceUrl`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedUrl {
    protocol: String,
    username: String,
    password: String,
    hostname: String,
    pathname: String,
}

const SPECIAL_SCHEMES: [&str; 6] = ["ftp", "file", "http", "https", "ws", "wss"];

/// Узкий разбор WHATWG URL (`new URL(url)`) для проверки источника: схема,
/// учётные данные, хост (ASCII в нижнем регистре, NFKC для прочего, IPv4 в
/// десятичной записи) и путь без точечных сегментов. `None` — `new URL`
/// бросил бы `TypeError`.
fn parse_url(input: &str) -> Option<ParsedUrl> {
    let trimmed = input.trim_matches(|ch: char| ch <= ' ');
    let cleaned: String = trimmed.chars().filter(|ch| !matches!(ch, '\t' | '\n' | '\r')).collect();
    let colon = cleaned.find(':')?;
    let scheme = &cleaned[..colon];
    let mut scheme_chars = scheme.chars();
    if !scheme_chars.next().is_some_and(|ch| ch.is_ascii_alphabetic()) || !scheme_chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '-' | '.')) {
        return None;
    }
    let scheme = scheme.to_ascii_lowercase();
    let rest = &cleaned[colon + 1..];
    if !SPECIAL_SCHEMES.contains(&scheme.as_str()) {
        // Не особая схема: адрес разбирается, а проверка протокола его отвергнет.
        return Some(ParsedUrl { protocol: format!("{scheme}:"), username: String::new(), password: String::new(), hostname: String::new(), pathname: rest.to_string() });
    }
    if scheme == "file" {
        return Some(ParsedUrl { protocol: "file:".into(), username: String::new(), password: String::new(), hostname: String::new(), pathname: rest.to_string() });
    }
    let after_slashes = rest.trim_start_matches(['/', '\\']);
    let authority_end = after_slashes.find(['/', '\\', '?', '#']).unwrap_or(after_slashes.len());
    let authority = &after_slashes[..authority_end];
    let tail = &after_slashes[authority_end..];
    let (userinfo, host_port) = match authority.rfind('@') {
        Some(at) => (Some(&authority[..at]), &authority[at + 1..]),
        None => (None, authority),
    };
    let (username, password) = match userinfo {
        Some(info) => match info.split_once(':') {
            Some((user, pass)) => (user.to_string(), pass.to_string()),
            None => (info.to_string(), String::new()),
        },
        None => (String::new(), String::new()),
    };
    let (host, port) = if host_port.starts_with('[') {
        let close = host_port.find(']')?;
        (&host_port[..=close], host_port[close + 1..].strip_prefix(':'))
    } else {
        match host_port.find(':') {
            Some(index) => (&host_port[..index], Some(&host_port[index + 1..])),
            None => (host_port, None),
        }
    };
    if let Some(port) = port {
        if !port.chars().all(|ch| ch.is_ascii_digit()) || (!port.is_empty() && port.parse::<u64>().map_or(true, |value| value > 65535)) {
            return None;
        }
    }
    let hostname = parse_host(host)?;
    let path_end = tail.find(['?', '#']).unwrap_or(tail.len());
    let path = tail[..path_end].replace('\\', "/");
    Some(ParsedUrl { protocol: format!("{scheme}:"), username, password, hostname, pathname: normalize_path(&path) })
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok();
            if let Some(value) = hex.and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                out.push(value);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(out).ok()
}

fn parse_host(host: &str) -> Option<String> {
    if host.is_empty() {
        return None;
    }
    if host.starts_with('[') {
        return Some(host.to_ascii_lowercase());
    }
    let decoded = percent_decode(host)?;
    // Приближение UTS 46 из `domainToASCII`: игнорируемые символы выпадают,
    // совместимые формы и регистр сводятся, идеографическая точка — точка.
    let ignorable = |ch: char| matches!(ch, '\u{AD}' | '\u{34F}' | '\u{180B}'..='\u{180F}' | '\u{200B}'..='\u{200D}' | '\u{2060}' | '\u{FE00}'..='\u{FE0F}' | '\u{FEFF}');
    let kept: String = decoded.chars().filter(|ch| !ignorable(*ch)).collect();
    let mapped = text::lower(&text::nfkc(&kept)).replace(['\u{3002}', '\u{FF0E}', '\u{FF61}'], ".");
    let forbidden = |ch: char| ch <= ' ' || matches!(ch, '#' | '%' | '/' | ':' | '<' | '>' | '?' | '@' | '[' | '\\' | ']' | '^' | '|' | '\u{7F}');
    if mapped.is_empty() || mapped.chars().any(forbidden) {
        return None;
    }
    let mut labels: Vec<&str> = mapped.split('.').collect();
    if labels.len() > 1 && labels.last() == Some(&"") {
        labels.pop();
    }
    let last = labels.last().copied().unwrap_or("");
    let numeric = !last.is_empty() && (last.chars().all(|ch| ch.is_ascii_digit()) || ((last.starts_with("0x") || last.starts_with("0X")) && last[2..].chars().all(|ch| ch.is_ascii_hexdigit())));
    if numeric {
        return parse_ipv4(&labels);
    }
    Some(mapped)
}

fn parse_ipv4(labels: &[&str]) -> Option<String> {
    if labels.len() > 4 {
        return None;
    }
    let mut numbers = Vec::new();
    for label in labels {
        let (digits, radix) = if let Some(hex) = label.strip_prefix("0x").or_else(|| label.strip_prefix("0X")) {
            (hex, 16)
        } else if label.len() > 1 && label.starts_with('0') {
            (&label[1..], 8)
        } else {
            (*label, 10)
        };
        if label.is_empty() {
            return None;
        }
        let value = if digits.is_empty() { 0 } else { u64::from_str_radix(digits, radix).ok()? };
        numbers.push(value);
    }
    let (last, head) = numbers.split_last()?;
    if head.iter().any(|value| *value > 255) || *last >= 256_u64.pow(5 - numbers.len() as u32) {
        return None;
    }
    let mut address = *last;
    for (index, value) in head.iter().enumerate() {
        address += value * 256_u64.pow(3 - index as u32);
    }
    Some(format!("{}.{}.{}.{}", address >> 24 & 255, address >> 16 & 255, address >> 8 & 255, address & 255))
}

fn normalize_path(path: &str) -> String {
    let body = path.strip_prefix('/').unwrap_or(path);
    if path.is_empty() {
        return "/".into();
    }
    let parts: Vec<&str> = body.split('/').collect();
    let mut out: Vec<&str> = Vec::new();
    let single = |part: &str| part == "." || part.eq_ignore_ascii_case("%2e");
    let double = |part: &str| matches!(part.to_ascii_lowercase().as_str(), ".." | ".%2e" | "%2e." | "%2e%2e");
    for (index, part) in parts.iter().enumerate() {
        let last = index + 1 == parts.len();
        if double(part) {
            out.pop();
            if last {
                out.push("");
            }
        } else if single(part) {
            if last {
                out.push("");
            }
        } else {
            out.push(part);
        }
    }
    format!("/{}", out.join("/"))
}

fn source_url(url: Option<&Value>) -> R<()> {
    string(url, "source URL")?;
    let source = string_of(url);
    let Some(parsed) = parse_url(&source) else {
        return Err(ContentError::Validation(format!("Invalid source URL: {source}")));
    };
    require_that(parsed.protocol == "https:" && parsed.username.is_empty() && parsed.password.is_empty(), "Source URL must use HTTPS without credentials")?;
    require_that(!parsed.hostname.starts_with("next.") && !parsed.pathname.contains("/homebrew/"), "2024 or homebrew source is not allowed")?;
    require_that(APPROVED_HOSTS.contains(&parsed.hostname.as_str()), "Unapproved source host")
}

fn common(record: &Value, source_ids: &[String], seen: &mut Vec<String>) -> R<()> {
    object(Some(record), "record")?;
    let id = string_of(record.get("id"));
    for key in ["id", "ruleset_id", "version", "kind", "source_ref", "book_code"] {
        string(record.get(key), &format!("{id}.{key}"))?;
    }
    require_that(jsv::is_str(record.get("ruleset_id"), CONTENT_RULESET_ID) && id.starts_with(&format!("{CONTENT_RULESET_ID}:")), format!("Mixed edition: {id}"))?;
    require_that(!seen.contains(&id), format!("Duplicate record: {id}"))?;
    seen.push(id);
    let kind = string_of(record.get("kind"));
    require_that(RECORD_KINDS.contains(&kind.as_str()), format!("Unknown record kind: {kind}"))?;
    let book = string_of(record.get("book_code"));
    require_that(BOOKS.contains(&book.as_str()), format!("Disallowed book: {book}"))?;
    let source_ref = string_of(record.get("source_ref"));
    require_that(source_ids.contains(&source_ref), format!("Unknown source: {source_ref}"))?;
    require_that(jsv::is_str(record.get("mechanics_status"), "data_only") && js::is_false(record.get("runtime_activation_allowed")), "This pack may not claim runtime support")
}

fn validate_damage(damage: Option<&Value>, label: &str) -> R<()> {
    array(damage, label)?;
    for entry in items(damage) {
        let kind = prop(Some(entry), "type")?;
        require_that(DAMAGE_TYPES.iter().any(|known| jsv::is_str(kind, known)), format!("{label}: unknown damage type"))?;
        let expression = prop(Some(entry), "expression")?;
        if js::present(expression) {
            require_that(!js::present(entry.get("amount")), format!("{label}: damage cannot be both fixed and rolled"))?;
            let average = dice_average(expression)?;
            require_that(jsv::is_number(entry.get("average"), average as f64), format!("{label}: incorrect average for {}", string_of(expression)))?;
        } else {
            integer(entry.get("amount"), 0.0, 10000.0, &format!("{label}: fixed damage"))?;
            require_that(strict_eq(entry.get("amount"), entry.get("average")), format!("{label}: incorrect fixed damage average"))?;
        }
    }
    Ok(())
}

fn validate_monster(monster: &Value) -> R<()> {
    let field = |key: &str| monster.get(key);
    let id = string_of(field("id"));
    for key in ["name_ru", "name_en", "size", "creature_type", "alignment", "challenge_rating"] {
        string(field(key), &format!("{id}.{key}"))?;
    }
    require_that(jsv::is_str(field("book_code"), "MM14"), "Monster must be MM14")?;
    source_url(field("source_url"))?;
    integer(opt(field("armor_class"), "value"), 1.0, 40.0, "armor class")?;
    integer(opt(field("hit_points"), "average"), 1.0, 10000.0, "hit points")?;
    let hit_points = field("hit_points");
    require_that(jsv::is_number(prop(hit_points, "average")?, dice_average(prop(hit_points, "formula")?)? as f64), format!("{id}: HP average mismatch"))?;
    object(field("abilities"), "abilities")?;
    object(field("ability_modifiers"), "ability modifiers")?;
    for ability in ABILITIES {
        let score = opt(field("abilities"), ability);
        integer(score, 1.0, 30.0, &format!("{id}.{ability}"))?;
        let expected = ((js::number(score) - 10.0) / 2.0).floor();
        require_that(jsv::is_number(opt(field("ability_modifiers"), ability), expected), format!("{id}: modifier {ability}"))?;
    }
    require_that(field("abilities").and_then(Value::as_object).is_some_and(|map| map.len() == 6), "Expected exactly six abilities")?;
    integer(field("initiative_bonus"), -10.0, 30.0, "initiative")?;
    object(field("saving_throws"), "saving throws")?;
    object(field("skills"), "skills")?;
    object(field("speed_ft"), "speed")?;
    for (ability, value) in js::entries(field("saving_throws").and_then(Value::as_object).expect("объект проверен")) {
        require_that(ABILITIES.contains(&ability.as_str()), "Unknown save ability")?;
        integer(Some(value), -10.0, 30.0, "save")?;
    }
    for (_, value) in js::entries(field("skills").and_then(Value::as_object).expect("объект проверен")) {
        integer(Some(value), -10.0, 40.0, "skill bonus")?;
    }
    for (_, value) in js::entries(field("speed_ft").and_then(Value::as_object).expect("объект проверен")) {
        integer(Some(value), 0.0, 1000.0, "speed")?;
    }
    integer(opt(field("senses"), "passive_perception"), 0.0, 50.0, "passive perception")?;
    require_that(text::test(re!(r"^(?:0|1\/8|1\/4|1\/2|[1-9]|[12]\d|30)$", "u"), &string_of(field("challenge_rating"))), "Invalid CR")?;
    integer(field("xp"), 0.0, 200000.0, "XP")?;
    integer(field("proficiency_bonus"), 2.0, 9.0, "proficiency")?;
    for key in [
        "traits",
        "actions",
        "bonus_actions",
        "reactions",
        "legendary_actions",
        "lair_actions",
        "damage_resistances",
        "damage_immunities",
        "damage_vulnerabilities",
        "condition_immunities",
        "habitats",
        "field_notes",
    ] {
        array(field(key), key)?;
    }
    for key in ["damage_resistances", "damage_immunities", "damage_vulnerabilities"] {
        for entry in items(field(key)) {
            if let Value::String(kind) = entry {
                require_that(DAMAGE_TYPES.contains(&kind.as_str()), "Unknown damage type")?;
            } else {
                object(Some(entry), &format!("{id}.{key}"))?;
                strings(entry.get("types"), "conditional damage types")?;
                string(entry.get("condition"), "damage condition")?;
                let types = items(entry.get("types"));
                require_that(!types.is_empty() && types.iter().all(|kind| DAMAGE_TYPES.iter().any(|known| kind == known)), "Unknown conditional damage type")?;
            }
        }
    }
    let actions = items(field("actions"));
    let mut action_ids = Vec::new();
    for action in actions {
        let key = set_key(prop(Some(action), "id")?);
        if !action_ids.contains(&key) {
            action_ids.push(key);
        }
    }
    require_that(action_ids.len() == actions.len(), "Duplicate local action ID")?;
    for action in actions {
        let get = |key: &str| action.get(key);
        string(get("id"), "action.id")?;
        string(get("name_ru"), "action name")?;
        string(get("kind"), "action kind")?;
        require_that(jsv::is_str(get("mechanics_status"), "requires_handler"), "Action cannot claim executable support")?;
        let kind = string_of(get("kind"));
        if kind == "weapon_attack" {
            integer(get("attack_modifier"), -10.0, 30.0, "attack modifier")?;
            strings(get("modes"), "attack modes")?;
            validate_damage(get("damage"), &format!("{id}.{}", string_of(get("id"))))?;
            if js::truthy(get("range_ft")) {
                let range = get("range_ft");
                integer(opt(range, "normal"), 1.0, 10000.0, "normal range")?;
                integer(opt(range, "long"), js::number(opt(range, "normal")), 10000.0, "long range")?;
            }
            if !matches!(get("reach_ft"), Some(Value::Null)) {
                integer(get("reach_ft"), 1.0, 100.0, "reach")?;
            }
            for key in ["ranged_damage", "versatile_damage"] {
                if js::truthy(get(key)) {
                    dice_average(get(key))?;
                }
            }
        }
        if kind == "multiattack" {
            array(get("sequences"), "multiattack sequences")?;
            for sequence in items(get("sequences")) {
                for step in iterate(Some(sequence), "sequence")? {
                    let action_id = prop(Some(&step), "action_id")?;
                    require_that(action_ids.contains(&set_key(action_id)) && !strict_eq(action_id, get("id")), "Unresolved or recursive multiattack")?;
                    integer(prop(Some(&step), "count")?, 1.0, 20.0, "multiattack count")?;
                    let mode = prop(Some(&step), "mode")?;
                    if js::truthy(mode) {
                        let target = actions.iter().find(|candidate| strict_eq(candidate.get("id"), action_id));
                        let modes = prop(target, "modes")?;
                        let includes = match modes {
                            Some(Value::Array(modes)) => modes.iter().any(|candidate| strict_eq(Some(candidate), mode)),
                            Some(Value::String(modes)) => modes.contains(&string_of(mode)),
                            None | Some(Value::Null) => false,
                            Some(_) => return Err(ContentError::Type("modes.includes is not a function".into())),
                        };
                        require_that(includes, "Invalid multiattack mode")?;
                    }
                }
            }
        }
        if kind == "save_area" {
            validate_damage(get("damage"), "area damage")?;
        }
    }
    if js::truthy(field("spellcasting")) {
        let spellcasting = field("spellcasting");
        let get = |key: &str| opt(spellcasting, key);
        require_that(ABILITIES.iter().any(|ability| jsv::is_str(get("ability"), ability)), "Spellcasting ability missing")?;
        integer(get("save_dc"), 1.0, 40.0, "spell save DC")?;
        let innate = jsv::is_str(get("casting_mode"), "innate");
        if !innate || js::present(get("caster_level")) {
            integer(get("caster_level"), 1.0, 20.0, "caster level")?;
        }
        if !innate || js::present(get("attack_modifier")) {
            integer(get("attack_modifier"), -10.0, 30.0, "spell attack")?;
        }
        array(get("spell_slots"), "spell slots")?;
        if js::present(get("innate_spells")) {
            array(get("innate_spells"), "innate spell groups")?;
            for group in items(get("innate_spells")) {
                let uses = prop(Some(group), "uses")?;
                if !jsv::is_str(uses, "at-will") {
                    integer(uses, 1.0, 100.0, "innate spell uses")?;
                }
                array(group.get("spells"), "innate spells")?;
                for spell in items(group.get("spells")) {
                    string(prop(Some(spell), "key")?, "innate spell key")?;
                    string(spell.get("name_ru"), "innate spell name")?;
                }
            }
        }
        let mut levels = Vec::new();
        for level in items(get("spell_slots")) {
            let value = prop(Some(level), "level")?;
            integer(value, 0.0, 9.0, "spell level")?;
            let number = js::number(value);
            require_that(!levels.contains(&(number as i64)), "Duplicate slot level")?;
            levels.push(number as i64);
            if number == 0.0 {
                require_that(matches!(level.get("slots"), Some(Value::Null)), "Cantrips are at will, not slots")?;
            } else {
                integer(level.get("slots"), 0.0, 20.0, "slot count")?;
            }
            array(level.get("spells"), "spell list")?;
            for spell in items(level.get("spells")) {
                string(prop(Some(spell), "key")?, "spell key")?;
                string(spell.get("name_ru"), "spell name")?;
            }
        }
    }
    object(field("lore"), "lore")?;
    string(opt(field("lore"), "summary_ru"), "lore summary")?;
    require_that(js::is_false(opt(field("lore"), "full_text_included")), "Full page prose must not be bundled")
}

fn validate_item(item: &Value) -> R<()> {
    let field = |key: &str| item.get(key);
    let id = string_of(field("id"));
    for key in ["name_ru", "name_en", "item_type", "rarity", "summary_ru"] {
        string(field(key), &format!("{id}.{key}"))?;
    }
    require_that(jsv::is_str(field("book_code"), "DMG14"), "Item must be DMG14")?;
    source_url(field("source_url"))?;
    require_that(["common", "uncommon", "rare", "very_rare", "legendary"].iter().any(|rarity| jsv::is_str(field("rarity"), rarity)), "Invalid rarity")?;
    object(field("attunement"), "attunement")?;
    require_that(matches!(opt(field("attunement"), "required"), Some(Value::Bool(_))), "Attunement flag missing")?;
    strings(opt(field("attunement"), "requirements"), "attunement requirements")?;
    array(field("activation"), "activation")?;
    array(field("effects"), "effects")?;
    for activation in items(field("activation")) {
        let cost = prop(Some(activation), "action_cost")?;
        let known = matches!(cost, Some(Value::Null)) || ["action", "bonus_action", "reaction"].iter().any(|known| jsv::is_str(cost, known));
        require_that(known, "Unknown action cost")?;
    }
    require_that(matches!(field("price_gp"), Some(Value::Null)), "This reviewed release does not provide market prices")?;
    if !matches!(field("weight_lb"), Some(Value::Null)) {
        let weight = field("weight_lb");
        let finite = matches!(weight, Some(Value::Number(number)) if number.as_f64().is_some_and(f64::is_finite));
        require_that(finite && js::number(weight) >= 0.0, "Invalid weight")?;
    }
    if js::truthy(field("charges")) {
        let charges = field("charges");
        integer(opt(charges, "maximum"), 1.0, 100.0, "maximum charges")?;
        let regain = opt(charges, "regain");
        dice_average(prop(regain, "expression")?)?;
        require_that(js::is_true(prop(regain, "cap_at_maximum")?), "Charge recovery must be capped")?;
    }
    if js::truthy(field("requires_base_item")) {
        require_that(jsv::is_str(opt(field("variant"), "kind"), "base_item_required"), "Base item selection required")?;
    }
    for effect in items(field("effects")) {
        let kind = prop(Some(effect), "kind")?;
        string(kind, "effect kind")?;
        let kind = string_of(kind);
        if kind == "heal" {
            dice_average(effect.get("expression"))?;
        }
        if kind == "cast_spell" {
            require_that(jsv::is_str(effect.get("ruleset_id"), CONTENT_RULESET_ID), "Mixed spell edition")?;
            string(effect.get("spell_key"), "spell key")?;
        }
        if kind == "damage_resistance" && js::truthy(effect.get("damage_type_from")) {
            require_that(jsv::is_str(opt(field("variant"), "kind"), "damage_type_required"), "Unresolved damage type variant")?;
        }
    }
    require_that(js::is_false(field("full_source_text_included")), "Full item prose must not be bundled")
}

/// `validateDndsu2014Content(content)`: идентичность, инварианты, источники и
/// контракт строк правил. Точность книги не доказывает.
pub fn validate_dndsu_2014_content(content: &Value) -> R<Value> {
    object(Some(content), "content")?;
    let field = |key: &str| content.get(key);
    object(field("sources"), "sources")?;
    require_that(jsv::is_str(opt(field("sources"), "ruleset_id"), CONTENT_RULESET_ID), "Mixed source registry")?;
    array(opt(field("sources"), "sources"), "source records")?;
    let mut source_ids: Vec<String> = Vec::new();
    let mut revisions: Vec<Option<Value>> = Vec::new();
    for source in items(opt(field("sources"), "sources")) {
        for key in ["id", "title", "url", "revision_id", "accessed_at", "rights_status"] {
            string(prop(Some(source), key)?, &format!("source.{key}"))?;
        }
        let id = string_of(source.get("id"));
        require_that(!source_ids.contains(&id), "Duplicate source ID")?;
        source_ids.push(id);
        revisions.push(source.get("revision_id").cloned());
        require_that(jsv::is_str(source.get("edition_family"), "5e_2014") && js::is_false(source.get("bundled")), "Invalid source edition/bundling")?;
        source_url(source.get("url"))?;
    }
    let mut seen = Vec::new();
    for (collection, kind) in [("monsters", "monster"), ("magicItems", "magic_item"), ("rules", "rule")] {
        array(field(collection), collection)?;
        for record in items(field(collection)) {
            common(record, &source_ids, &mut seen)?;
            require_that(jsv::is_str(record.get("kind"), kind), "Record in wrong catalog")?;
        }
    }
    for monster in items(field("monsters")) {
        validate_monster(monster)?;
    }
    for item in items(field("magicItems")) {
        validate_item(item)?;
    }
    let rules = items(field("rules"));
    for rule in rules {
        let id = string_of(rule.get("id"));
        for key in ["title_ru", "title_en", "text_ru", "text_en", "source_hash", "license_id"] {
            string(rule.get(key), &format!("{id}.{key}"))?;
        }
        for key in ["section_path", "tags", "entity_refs", "aliases_en", "aliases_ru"] {
            strings(rule.get(key), &format!("{id}.{key}"))?;
        }
        require_that(["structured", "deterministic", "retrieval_only"].iter().any(|level| jsv::is_str(rule.get("formalization_level"), level)), "Invalid formalization level")?;
        let source_index = source_ids.iter().position(|source| *source == string_of(rule.get("source_ref")));
        let revision = source_index.and_then(|index| revisions[index].as_ref());
        require_that(strict_eq(rule.get("source_hash"), revision), "Source observation ID mismatch")?;
        integer(rule.get("source_page_start"), 0.0, 10000.0, "page start")?;
        integer(rule.get("source_page_end"), js::number(rule.get("source_page_start")), 10000.0, "page end")?;
        object(rule.get("mechanics"), "rule mechanics")?;
        let english = mechanical_tokens(&format!("{}\n{}", string_of(rule.get("title_en")), string_of(rule.get("text_en"))));
        let russian = mechanical_tokens(&format!("{}\n{}", string_of(rule.get("title_ru")), string_of(rule.get("text_ru"))));
        require_that(english == russian, format!("{id}: translation numeric mismatch"))?;
    }
    array(field("ontologyEdges"), "ontology edges")?;
    let rule_ids: Vec<String> = rules.iter().map(|rule| string_of(rule.get("id"))).collect();
    let known = |value: Option<&Value>| matches!(value, Some(Value::String(id)) if rule_ids.contains(id));
    for edge in items(field("ontologyEdges")) {
        prop(Some(edge), "ruleset_id")?;
        let weight = js::number(edge.get("weight"));
        let valid = jsv::is_str(edge.get("ruleset_id"), CONTENT_RULESET_ID) && known(edge.get("from_id")) && known(edge.get("to_id")) && weight > 0.0 && weight <= 1.0;
        require_that(valid, "Invalid ontology edge")?;
    }
    object(field("coverage"), "coverage")?;
    require_that(jsv::is_str(opt(field("coverage"), "ruleset_id"), CONTENT_RULESET_ID), "Mixed coverage edition")?;
    let counts = [
        ("rules", rules.len()),
        ("monsters", items(field("monsters")).len()),
        ("magic_items", items(field("magicItems")).len()),
        ("ontology_edges", items(field("ontologyEdges")).len()),
        ("sources", source_ids.len()),
    ];
    let coverage_counts = prop(field("coverage"), "counts")?;
    for (key, count) in counts {
        require_that(jsv::is_number(prop(coverage_counts, key)?, count as f64), format!("Coverage count mismatch: {key}"))?;
    }
    let mut summary = Map::new();
    summary.insert("ruleset_id".into(), Value::String(CONTENT_RULESET_ID.into()));
    for (key, count) in counts {
        summary.insert(key.into(), Value::from(count));
    }
    summary.insert("mechanics_execution".into(), Value::String("not_integrated".into()));
    Ok(Value::Object(summary))
}

/// Откуда читаются файлы справочника.
enum Files {
    Embedded,
    Directory { anchor: PathBuf, parts: Vec<String> },
}

fn path_parts(path: &Path) -> (PathBuf, Vec<String>) {
    let mut anchor = PathBuf::new();
    let mut parts: Vec<String> = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => anchor.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop();
            }
            Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
        }
    }
    (anchor, parts)
}

fn same_part(left: &str, right: &str) -> bool {
    if cfg!(windows) {
        left.to_lowercase() == right.to_lowercase()
    } else {
        left == right
    }
}

impl Files {
    fn directory(directory: &Path) -> Self {
        let absolute = std::path::absolute(directory).unwrap_or_else(|_| directory.to_path_buf());
        let (anchor, parts) = path_parts(&absolute);
        Self::Directory { anchor, parts }
    }

    fn root_parts(&self) -> Vec<String> {
        match self {
            Self::Embedded => DEFAULT_CONTENT_DIRECTORY.split('/').map(String::from).collect(),
            Self::Directory { parts, .. } => parts.clone(),
        }
    }

    fn root_display(&self) -> String {
        match self {
            Self::Embedded => DEFAULT_CONTENT_DIRECTORY.to_string(),
            Self::Directory { anchor, parts } => parts.iter().fold(anchor.clone(), |path, part| path.join(part)).display().to_string(),
        }
    }

    /// `safePath(root, name)`: путь внутри корня (относительные части) или отказ.
    fn safe_path(&self, name: &str) -> R<Vec<String>> {
        string(Some(&Value::String(name.to_string())), "file path")?;
        require_that(!name.contains('\\'), "Use POSIX paths in the manifest")?;
        let unsafe_path = || ContentError::Validation(format!("Unsafe file path: {name}"));
        let drive = name.split('/').next().is_some_and(|first| cfg!(windows) && first.len() == 2 && first.ends_with(':'));
        if drive {
            return Err(unsafe_path());
        }
        let root = self.root_parts();
        let mut stack: Vec<String> = if name.starts_with('/') { Vec::new() } else { root.clone() };
        for part in name.split('/') {
            match part {
                "" | "." => {}
                ".." => {
                    stack.pop();
                }
                other => stack.push(other.to_string()),
            }
        }
        let inside = stack.len() > root.len() && stack.iter().zip(&root).all(|(left, right)| same_part(left, right));
        if !inside {
            return Err(unsafe_path());
        }
        Ok(stack[root.len()..].to_vec())
    }

    fn read(&self, parts: &[String]) -> Result<Vec<u8>, String> {
        let name = parts.join("/");
        match self {
            Self::Embedded => EMBEDDED_FILES.iter().find(|(file, _)| *file == name).map(|(_, bytes)| bytes.to_vec()).ok_or_else(|| format!("ENOENT: no such file or directory, open '{DEFAULT_CONTENT_DIRECTORY}/{name}'")),
            Self::Directory { anchor, parts: root } => {
                let path = root.iter().chain(parts).fold(anchor.clone(), |path, part| path.join(part));
                std::fs::read(&path).map_err(|error| jsv::io_message(&error, &path))
            }
        }
    }

    fn json(&self, name: &str) -> R<Value> {
        let parsed = self.safe_path(name).map_err(|error| error.message().to_string()).and_then(|parts| self.read(&parts)).and_then(|bytes| {
            serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes)).map_err(|error| error.to_string())
        });
        parsed.map_err(|message| ContentError::Validation(format!("{name}: {message}")))
    }
}

/// `loadDndsu2014Content({ directory, verifyHashes })`: `None` — встроенный
/// каталог из сборки. Хеши файлов манифеста сверяются при `verify_hashes`.
pub fn load_dndsu_2014_content(directory: Option<&Path>, verify_hashes: bool) -> R<Value> {
    let files = match directory {
        Some(directory) => Files::directory(directory),
        None => Files::Embedded,
    };
    let manifest = files.json("manifest.json")?;
    require_that(jsv::is_str(manifest.get("ruleset_id"), CONTENT_RULESET_ID) && jsv::is_number(manifest.get("schema_version"), 1.0), "Invalid manifest")?;
    require_that(js::is_false(manifest.get("runtime_activation_allowed")), "Manifest may not activate runtime")?;
    object(manifest.get("files"), "manifest files")?;
    let manifest_files = manifest.get("files").and_then(Value::as_object).expect("объект проверен");
    let rule_root = format!("rule_packs/{CONTENT_RULESET_ID}");
    for file in ["monsters.json".to_string(), "magic-items.json".into(), "sources.json".into(), "coverage.json".into(), format!("{rule_root}/rules.jsonl"), format!("{rule_root}/ontology_edges.jsonl")] {
        require_that(manifest_files.contains_key(&file), format!("Manifest misses {file}"))?;
    }
    if verify_hashes {
        for (name, record) in js::entries(manifest_files) {
            let sha256 = jsv::string_of(prop(Some(record), "sha256")?);
            require_that(text::test(re!(r"^[a-f0-9]{64}$", "u"), &sha256), "Invalid SHA256")?;
            let parts = files.safe_path(name)?;
            let bytes = files.read(&parts).map_err(ContentError::Io)?;
            require_that(hash::sha256_hex(&bytes) == sha256, format!("Checksum mismatch: {name}"))?;
        }
    }
    let monsters = files.json("monsters.json")?;
    let items = files.json("magic-items.json")?;
    let sources = files.json("sources.json")?;
    let coverage = files.json("coverage.json")?;
    for catalog in [&monsters, &items] {
        require_that(jsv::is_str(catalog.get("ruleset_id"), CONTENT_RULESET_ID) && jsv::is_number(catalog.get("schema_version"), 1.0), "Invalid catalog wrapper")?;
    }
    let read_lines = |file: &str| -> R<String> {
        let parts: Vec<String> = ["rule_packs", CONTENT_RULESET_ID, file].iter().map(|part| part.to_string()).collect();
        files.read(&parts).map(|bytes| String::from_utf8_lossy(&bytes).into_owned()).map_err(ContentError::Io)
    };
    let rules = json_lines(&read_lines("rules.jsonl")?, "rules.jsonl")?;
    let ontology_edges = json_lines(&read_lines("ontology_edges.jsonl")?, "ontology_edges.jsonl")?;
    let mut content = Map::new();
    content.insert("directory".into(), Value::String(files.root_display()));
    content.insert("manifest".into(), manifest);
    if let Some(list) = monsters.get("monsters") {
        content.insert("monsters".into(), list.clone());
    }
    if let Some(list) = items.get("magic_items") {
        content.insert("magicItems".into(), list.clone());
    }
    content.insert("sources".into(), sources);
    content.insert("coverage".into(), coverage);
    content.insert("rules".into(), Value::Array(rules));
    content.insert("ontologyEdges".into(), Value::Array(ontology_edges));
    let mut content = Value::Object(content);
    let summary = validate_dndsu_2014_content(&content)?;
    js::assign(&mut content, json!({ "summary": summary }));
    Ok(content)
}

static DEFAULT_CONTENT: LazyLock<R<Value>> = LazyLock::new(|| load_dndsu_2014_content(None, true));

/// Встроенный справочник, загруженный и проверенный один раз.
pub fn default_dndsu_2014_content() -> R<&'static Value> {
    DEFAULT_CONTENT.as_ref().map_err(Clone::clone)
}

/// Проверка встроенного справочника (урок 7; сервер зовёт её до приёма
/// запросов): та же загрузка с хешами манифеста, отказ — с каталогом файла.
pub fn check_dndsu_2014_content() -> sk_core::content::ContentResult<()> {
    default_dndsu_2014_content().map(|_| ()).map_err(|error| sk_core::content::ContentError::new(DEFAULT_CONTENT_DIRECTORY, error.to_string()))
}

/// `assert2014Campaign(campaign)`.
pub fn assert_2014_campaign(campaign: Option<&Value>) -> R<()> {
    require_that(jsv::is_str(opt(campaign, "ruleset_id"), CONTENT_RULESET_ID), "Select an explicitly 2014 campaign; never reinterpret an existing 2024 campaign")
}

fn all_records<'a>(content: &'a Value, order: [&'static str; 3]) -> impl Iterator<Item = &'a Value> {
    order.into_iter().flat_map(move |key| items(content.get(key)).iter())
}

/// `getContentRecord(content, id, { campaign })`: запись по полному id своей
/// редакции. `campaign` — `None`, если не передан (`undefined`).
pub fn get_content_record<'a>(content: &'a Value, id: Option<&Value>, campaign: Option<&Value>) -> R<Option<&'a Value>> {
    if let Some(campaign) = campaign {
        assert_2014_campaign(Some(campaign))?;
    }
    string(id, "record id")?;
    let id = string_of(id);
    require_that(id.starts_with(&format!("{CONTENT_RULESET_ID}:")), "Cross-edition lookup is forbidden")?;
    Ok(all_records(content, ["monsters", "magicItems", "rules"]).find(|record| jsv::is_str(record.get("id"), &id)))
}

fn normalize(value: &str) -> String {
    text::lower(&text::nfkc(value)).replace('ё', "е")
}

fn check_kind(kind: Option<&Value>, message: &str) -> R<()> {
    if let Some(kind) = kind {
        require_that(RECORD_KINDS.iter().any(|known| kind == *known), message)?;
    }
    Ok(())
}

/// `searchContent(content, query, { kind, limit })`: дословный локальный
/// поиск (не семантический). `kind` — `None`, если не передан; `limit` —
/// `None` для 10.
pub fn search_content(content: &Value, query: Option<&Value>, kind: Option<&Value>, limit: Option<&Value>) -> R<Vec<Value>> {
    string(query, "query")?;
    let ten = Value::from(10);
    let limit = limit.unwrap_or(&ten);
    integer(Some(limit), 1.0, 100.0, "limit")?;
    check_kind(kind, "Invalid search kind")?;
    let normalized_query = normalize(&string_of(query));
    let tokens: Vec<&str> = normalized_query.split(is_js_whitespace).filter(|token| !token.is_empty()).collect();
    let mut hits: Vec<(&Value, i64)> = all_records(content, ["monsters", "magicItems", "rules"])
        .filter(|record| !js::truthy(kind) || strict_eq(record.get("kind"), kind))
        .filter_map(|record| {
            let title_parts: Vec<String> = ["name_ru", "name_en", "title_ru", "title_en", "id"].iter().filter(|key| js::truthy(record.get(**key))).map(|key| string_of(record.get(*key))).collect();
            let title = normalize(&title_parts.join(" "));
            let body = normalize(&stringify(record));
            let score = tokens.iter().map(|token| if title.contains(token) { 5 } else if body.contains(token) { 1 } else { 0 }).sum();
            tokens.iter().all(|token| body.contains(token)).then_some((record, score))
        })
        .collect();
    hits.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| text::locale_compare(&string_of(left.0.get("id")), &string_of(right.0.get("id")))));
    let limit = js::number(Some(limit)) as usize;
    Ok(hits.into_iter().take(limit).map(|(record, score)| json!({ "record": record, "score": score })).collect())
}

/// `toRetrievalChunks(content, { kind })`: полный текст записи для индекса.
/// Найденная запись — справка, а не исполняемая инструкция.
pub fn to_retrieval_chunks(content: &Value, kind: Option<&Value>) -> R<Vec<Value>> {
    check_kind(kind, "Invalid chunk kind")?;
    let sources = items(opt(content.get("sources"), "sources"));
    Ok(all_records(content, ["rules", "monsters", "magicItems"])
        .filter(|record| !js::truthy(kind) || strict_eq(record.get("kind"), kind))
        .map(|record| {
            let mut chunk = Map::new();
            let mut put = |key: &str, value: Option<&Value>| {
                if let Some(value) = value {
                    chunk.insert(key.to_string(), value.clone());
                }
            };
            put("id", record.get("id"));
            put("ruleset_id", Some(&Value::String(CONTENT_RULESET_ID.into())));
            put("kind", record.get("kind"));
            put("source_ref", record.get("source_ref"));
            let source = sources.iter().find(|source| strict_eq(source.get("id"), record.get("source_ref")));
            put("source_url", jsv::nullish(record.get("source_url"), source.and_then(|source| source.get("url"))));
            put("title", jsv::nullish(record.get("title_ru"), record.get("name_ru")));
            put("text", Some(&Value::String(stringify_pretty(record, 2))));
            put("runtime_activation_allowed", Some(&Value::Bool(false)));
            Value::Object(chunk)
        })
        .collect())
}

/// `loadReferenceRulePack(loadRulePack, { directory })`: справочный пакет
/// правил 2014 настоящим загрузчиком вызывающего (`sk_rulepack`), из
/// `<directory>/rule_packs`. `None` — [`DEFAULT_CONTENT_DIRECTORY`].
pub fn load_reference_rule_pack<T>(load_rule_pack: impl FnOnce(&str, &Path) -> T, directory: Option<&Path>) -> T {
    let directory = directory.unwrap_or(Path::new(DEFAULT_CONTENT_DIRECTORY));
    let root = std::path::absolute(directory).unwrap_or_else(|_| directory.to_path_buf());
    load_rule_pack(CONTENT_RULESET_ID, &root.join("rule_packs"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Урок 7: справочник проходит проверку, а копия с опечаткой в ключевом
    /// поле записи — отказ, который называет запись.
    #[test]
    fn broken_copy_names_record() {
        assert_eq!(check_dndsu_2014_content(), Ok(()));
        let mut content = default_dndsu_2014_content().expect("справочник").clone();
        let monster = content["monsters"][5].as_object_mut().expect("запись");
        let id = jsv::string_of(monster.get("id"));
        let kind = monster.shift_remove("kind").expect("kind");
        monster.insert("knd".into(), kind);
        let error = validate_dndsu_2014_content(&content).err().map(|error| error.to_string());
        assert_eq!(error, Some(format!("{id}.kind: expected nonempty string")));
    }

    #[test]
    fn dice_parser_does_not_execute_expressions() {
        assert_eq!(dice_average(Some(&json!("2d6-2"))), Ok(5));
        for bad in ["process.exit()", "1d6;rm", "0d6", "2d1", "Math.random()", " 2d6"] {
            assert!(dice_average(Some(&json!(bad))).expect_err(bad).is_validation(), "{bad}");
        }
        assert_eq!(dice_average(Some(&json!("0d6"))), Err(ContentError::Validation("dice count: integer outside 1..1000".into())));
    }

    #[test]
    fn urls_are_parsed_like_whatwg_for_source_checks() {
        let parsed = parse_url("HTTPS://DnD.Su/a/../homebrew/x?q#f").expect("адрес");
        assert_eq!((parsed.protocol.as_str(), parsed.hostname.as_str(), parsed.pathname.as_str()), ("https:", "dnd.su", "/homebrew/x"));
        assert_eq!(parse_url("https:dnd.su").expect("без слэшей").hostname, "dnd.su");
        assert_eq!(parse_url("https://u:p@dnd.su/").expect("учётка").password, "p");
        assert_eq!(parse_url("https://0x7f.1/").expect("ipv4").hostname, "127.0.0.1");
        assert_eq!(parse_url("https://1.2.3.999/"), None);
        assert_eq!(parse_url("https://dnd.su:99999/"), None);
        assert_eq!(parse_url("foo"), None);
        assert_eq!(parse_url("http://"), None);
        assert_eq!(parse_url("mailto:x").expect("не особая").protocol, "mailto:");
        assert_eq!(normalize_path("/a/./b/%2E%2e/"), "/a/");
    }
}
